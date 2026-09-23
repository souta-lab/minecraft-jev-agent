import { existsSync, createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

const RUN_ID_RE = /^run-[A-Za-z0-9-]+$/
const SOURCE_SHA_RE = /^[a-f0-9]{40}$/i
const BOOT_RE = /\bBOOT\b(?!_)/
const RELOAD_RE = /\bRELOAD\b(?!_)/
const RESUME_RE = /\bRESUME\b(?!_)/

function runIdOf(line) {
  return /\brunId=(run-[A-Za-z0-9-]+)/.exec(line)?.[1] ?? null
}

function field(line, name) {
  const match = new RegExp(`(?:^|\\s)${name}=("(?:[^"\\\\]|\\\\.)*"|\\S+)`).exec(line)
  if (match === null) return null
  const value = match[1]
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value)
    } catch {
      return value.slice(1, -1)
    }
  }
  return value
}

function markerBoolean(line, name) {
  const value = field(line, name)
  return value === 'true' ? true : value === 'false' ? false : null
}

function failed(path, reason, extra = {}) {
  return {
    status: 'unknown',
    exact: false,
    runId: extra.runId ?? null,
    sourceSha: extra.sourceSha ?? null,
    path: path ?? null,
    reloadCount: extra.reloadCount ?? 0,
    sourceChangeCount: extra.sourceChangeCount ?? 0,
    reason,
  }
}

/**
 * Prove that the source SHA recorded at BOOT remained the executing source for
 * the requested run. A generation bundle hash cannot stand in for a Git commit:
 * after any committed source reload, this returns UNKNOWN until the host emits a
 * commit SHA for that exact generation.
 *
 * Check every available stream because a supervisor restart truncates runner.out
 * while the append-only log may retain reloads that runner.out no longer shows.
 * A missing BOOT in one stream is not negative evidence when another stream
 * contains the run; contradictory valid windows are UNKNOWN.
 */
export async function scanRunSourceExactness(runId, paths = []) {
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) {
    return failed(null, 'exact_run_scope_required', { runId })
  }
  const candidates = [...new Set((Array.isArray(paths) ? paths : [paths]).filter((path) => typeof path === 'string' && path !== ''))]
  if (candidates.length === 0) return failed(null, 'source_evidence_paths_unavailable', { runId })

  const attempts = []
  const observations = []
  for (const path of candidates) {
    if (!existsSync(path)) {
      attempts.push({ path, status: 'unavailable', reason: 'file_missing' })
      continue
    }
    let activeRunId = null
    let boundaryFound = false
    let bootSourceShas = []
    let reloadCount = 0
    let sourceChangeCount = 0
    let changedMarkers = []
    let ambiguousMarkers = []
    let pendingDeferred = false
    let lineIndex = -1
    let streamError = null
    let reader
    try {
      reader = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity })
      for await (const line of reader) {
        lineIndex += 1
        if (BOOT_RE.test(line)) {
          const bootRunId = runIdOf(line)
          if (bootRunId !== null) {
            if (boundaryFound && bootRunId !== runId) break
            activeRunId = bootRunId
            if (bootRunId === runId) {
              boundaryFound = true
              const sourceSha = field(line, 'source')
              bootSourceShas.push(typeof sourceSha === 'string' ? sourceSha.toLowerCase() : sourceSha)
            }
          }
        }
        if (!boundaryFound || activeRunId !== runId) continue
        const explicitLineRunId = runIdOf(line)
        if (explicitLineRunId !== null && explicitLineRunId !== runId) continue

        if (RESUME_RE.test(line) && markerBoolean(line, 'ok') === true && pendingDeferred) {
          sourceChangeCount += 1
          changedMarkers.push({ lineIndex, kind: 'deferred-resume', hash: null })
          pendingDeferred = false
        }

        if (!RELOAD_RE.test(line)) continue
        reloadCount += 1
        const ok = markerBoolean(line, 'ok')
        const skipped = field(line, 'skipped')
        const deferred = field(line, 'deferred')
        const hash = field(line, 'hash')
        if (ok === false || skipped === 'unchanged') continue
        if (deferred === 'frozen') {
          pendingDeferred = true
          continue
        }
        if (ok === true) {
          sourceChangeCount += 1
          changedMarkers.push({ lineIndex, kind: hash === null ? 'unhashed-reload' : 'source-change', hash })
          continue
        }
        ambiguousMarkers.push({ lineIndex, reason: 'reload_outcome_unattested' })
      }
    } catch (error) {
      streamError = error instanceof Error ? error.message : String(error)
    } finally {
      try { reader?.close() } catch { /* best effort */ }
    }
    if (streamError !== null) {
      attempts.push({ path, status: 'unreadable', reason: streamError })
      continue
    }
    if (!boundaryFound) {
      attempts.push({ path, status: 'boundary_missing', reason: `run_boundary_missing runId=${runId}` })
      continue
    }
    const sourceSha = bootSourceShas[0] ?? null
    const uniqueSources = [...new Set(bootSourceShas.filter((value) => typeof value === 'string'))]
    const result = (status, reason) => ({
      status,
      exact: status === 'exact',
      runId,
      sourceSha,
      path,
      bootSourceShas,
      reloadCount,
      sourceChangeCount,
      changedMarkers,
      ambiguousMarkers,
      pendingDeferred,
      attempts,
      reason,
    })
    const everyBootHasExactSha = bootSourceShas.length > 0 && bootSourceShas.every((value) => typeof value === 'string' && SOURCE_SHA_RE.test(value))
    if (!everyBootHasExactSha || uniqueSources.length !== 1 || typeof sourceSha !== 'string' || !SOURCE_SHA_RE.test(sourceSha)) {
      observations.push(result('unknown', uniqueSources.length > 1 ? 'run_boot_source_sha_changed' : 'run_boot_source_sha_invalid'))
      continue
    }
    if (ambiguousMarkers.length > 0) {
      observations.push(result('unknown', 'run_reload_source_effect_unattested'))
      continue
    }
    if (changedMarkers.some((marker) => marker.kind === 'unhashed-reload')) {
      observations.push(result('unknown', 'reload_source_effect_unattested'))
      continue
    }
    if (sourceChangeCount > 0) {
      observations.push(result('unknown', 'source_changing_reload_has_no_exact_git_sha'))
      continue
    }
    observations.push(result('exact', null))
  }
  const exactObservation = observations.find((observation) => observation.status === 'exact')
  const blockedObservation = observations.find((observation) => observation.status !== 'exact')
  if (blockedObservation !== undefined) {
    return { ...blockedObservation, exact: false, attempts, observations: observations.map(({ attempts: _attempts, ...observation }) => observation) }
  }
  if (exactObservation !== undefined) {
    const sourceShas = [...new Set(observations.map((observation) => observation.sourceSha))]
    if (sourceShas.length !== 1) {
      return {
        ...exactObservation,
        status: 'unknown',
        exact: false,
        reason: 'source_stream_boot_sha_disagreement',
        attempts,
        observations: observations.map(({ attempts: _attempts, ...observation }) => observation),
      }
    }
    return { ...exactObservation, attempts, observations: observations.map(({ attempts: _attempts, ...observation }) => observation) }
  }
  return {
    ...failed(candidates[0] ?? null, attempts.length === 0 ? 'source_window_unavailable' : 'run_boundary_unavailable', { runId }),
    attempts,
  }
}
