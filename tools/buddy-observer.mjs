#!/usr/bin/env bun
// Read-only live dashboard for AI_Buddy.
//
// Inputs:
//   - resident control socket `report` (read-only)
//   - append-only buddy.log
//
// The dashboard deliberately renders a structured Decision Trace instead of
// inventing or exposing hidden model reasoning. Every displayed decision field
// comes from resident state or an emitted audit event.

import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs'
import net from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const DEFAULT_RUNTIME_DIR = join(REPO, 'buddy-driver')
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 4173
const DEFAULT_INTERVAL_MS = 2500
const DEFAULT_LOG_TAIL_BYTES = 128 * 1024
const MAX_RUN_BOUNDARY_SCAN_BYTES = 1024 * 1024
const MAX_RUN_ARTIFACT_BYTES = 64 * 1024
const DEFAULT_RECENT_CHOICE_LOG_BYTES = 8 * 1024 * 1024
const MAX_RECENT_CHOICE_LOG_BYTES = 8 * 1024 * 1024
const DEFAULT_VTR_RUN_LOG_BYTES = 1024 * 1024
const DEFAULT_CONTROL_TIMEOUT_MS = 5000

const VTR_TRACE_EVENTS = new Set([
  'VTR_REACH_PROBE_HOLD',
  'VTR_DUAL_AUTHORITY_FENCE',
  'VTR_MISSION_SNAPSHOT_REFUSED',
  'VTR_TERMINAL_HANDOFF_REFUSED',
  'VTR_RISK_OBSERVED',
  'VTR_REACH_GUARD_REFUSED',
  'VTR_RUNTIME_INTENT_REFUSED',
  'VTR_EXECUTOR_CLAIM_REFUSED',
  'VTR_INTENT_RELEASE_REFUSED',
  'VTR_CONTROLLER_TICK_REFUSED',
  'VTR_RISK_OBSERVATION_REFUSED',
  'VTR_COMPLETION_REFUSED',
  'VTR_MECHANICAL_OUTCOME_REFUSED',
  'VTR_VERIFY_JOURNAL_REFUSED',
  'VTR_ROUTE_SELECTION_REQUIRED',
  'VTR_TRANSITION_COMMIT',
  'VTR_TRANSITION_PROGRESS',
  'VTR_TRANSITION_ACTUATION',
  'VTR_ACTION_COMPLETION_HANDLER_FAILED',
  'VTR_SCHEDULER_HOLDS_NO_ADMISSIBLE_ROUTE',
  'VTR_SCHEDULER_HOLDS_TERMINAL',
  'VTR_MECHANICAL_STEP_REFUSED',
  'VTR_MECHANICAL_STEP_RESERVED',
  'VTR_MECHANICAL_STEP_OUTCOME',
  'VTR_MECHANICAL_OUTCOME_REJECTED',
  'VTR_MECHANICAL_OUTCOME',
  'VTR_TERMINAL_ACTION_CORRELATED',
  'VTR_TERMINAL_ACTION_SETTLEMENT_MISMATCH',
  'VTR_REACH_ROUTE_DECISION',
  'VTR_TRANSITION_VERIFY',
  'VTR_TRANSITION_OUTCOME',
  'VTR_TRANSITION_MODEL_METRICS',
  'VTR_ORPHAN_ACTION_OUTCOME',
  'VTR_LEGACY_REACH_MOVE_WITHHELD',
  'VTR_LEGACY_REACH_HANDOFF',
  'VTR_ORPHAN_ACTUATION_REVOKED',
  'VTR_SAFETY_TRIGGER_STALE',
])

const TRACE_EVENTS = new Set([
  'JEV_HEADS',
  'JEV_STATE_PROJECTION',
  'JEV_CANDIDATE_SET',
  'SKILL_END',
  'SKILL_OUTCOME_PACKET',
  'PICKUP_ACQUIRED',
  'PICKUP_NOT_ACQUIRED',
  'CAUSAL',
  'MODEL_UNAVAILABLE',
  'MODEL_AVAILABILITY',
  'MODEL_RETRY_STARTED',
  'MODEL_RECOVERED',
  'TOOL_CHOICE',
  'SYSTEM2_AUTHORITY_INPUT',
  'SYSTEM2_AUTHORITY_DECISION',
  'SYSTEM2_AUTHORITY_RETRY',
  'SYSTEM2_STALE_DISCARD',
  'MERCURY_ATTEMPT',
  'MERCURY_RETRY',
  'MERCURY_TRIGGER_BACKOFF',
  'MERCURY_TRIGGER_SUPPRESSED',
  'MERCURY_BUDGET_EXHAUSTED',
  'MERCURY_STALE_DISCARD',
  'MERCURY_FAILURE_STATE',
  'PLAN_REJECTED',
  'ACTION',
  'ACTION_COMMIT',
  'ACTION_PREEMPT',
  'ACTION_UNVERIFIED',
  'HEARTBEAT',
  'MILESTONE',
  'DEATH',
  'GENERATION_READY',
  'RELOAD',
  'DISCONNECT',
  'RECONNECT_SUCCESS',
  'BOOT',
  'BUILD',
  'FATAL',
  'ERROR',
  ...VTR_TRACE_EVENTS,
])

const SECRET_KEY = /(api.?key|authorization|cookie|password|secret|token)/i
const PROBE_HOSTILES = new Set([
  'blaze', 'cave_spider', 'creeper', 'drowned', 'elder_guardian', 'ender_dragon', 'endermite', 'evoker',
  'ghast', 'guardian', 'hoglin', 'husk', 'magma_cube', 'phantom', 'piglin_brute', 'pillager', 'ravager',
  'shulker', 'silverfish', 'skeleton', 'slime', 'spider', 'stray', 'vex', 'vindicator', 'warden', 'witch',
  'wither', 'wither_skeleton', 'zoglin', 'zombie', 'zombie_villager',
])

function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets)
  if (typeof value === 'string') {
    return value
      .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
      .replace(/((?:api.?key|authorization|cookie|password|secret|token)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]')
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !SECRET_KEY.test(key))
      .map(([key, nested]) => [key, redactSecrets(nested)]))
  }
  return value
}

function coerceValue(raw) {
  if (raw === 'null') return null
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) return Number(raw)
  if (/^[\[{\"]/.test(raw)) {
    try {
      return JSON.parse(raw)
    } catch {
      return raw
    }
  }
  return raw
}

/** Parse the resident logger's `key=value` tail without splitting JSON values. */
export function parseDetail(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return {}
  const matches = [...raw.matchAll(/(?:^|\s)([A-Za-z0-9_.-]+)=/g)]
  const detail = {}
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]
    const key = match[1]
    if (key === undefined || SECRET_KEY.test(key)) continue
    const start = (match.index ?? 0) + match[0].length
    const end = index + 1 < matches.length ? (matches[index + 1].index ?? raw.length) : raw.length
    detail[key] = redactSecrets(coerceValue(raw.slice(start, end).trim()))
  }
  return detail
}

export function parseBuddyLogLine(line) {
  const match = /^\[([^\]]+)]\s+(\S+)(?:\s+(.*))?$/.exec(line.trim())
  if (match === null) return null
  const [, ts, event, raw = ''] = match
  return {
    ts,
    event,
    detail: parseDetail(raw),
    raw: line.trim(),
  }
}

export function readTextTail(logPath, maxBytes = DEFAULT_LOG_TAIL_BYTES) {
  if (!existsSync(logPath)) return []
  const fd = openSync(logPath, 'r')
  try {
    const size = fstatSync(fd).size
    const length = Math.min(size, maxBytes)
    const buffer = Buffer.alloc(length)
    readSync(fd, buffer, 0, length, Math.max(0, size - length))
    const text = buffer.toString('utf8')
    const clean = size > length ? text.slice(text.indexOf('\n') + 1) : text
    return clean.split('\n').filter((line) => line.trim() !== '')
  } finally {
    closeSync(fd)
  }
}

export function readLogTail(logPath, maxBytes = DEFAULT_LOG_TAIL_BYTES) {
  return readTextTail(logPath, maxBytes)
    .map(parseBuddyLogLine)
    .filter((entry) => entry !== null)
}

/** Parse structured fatal lines from runner.out and attribute them to one BOOT window. */
export function parseRunnerOutEvents(lines, { runId = null, bootTs = null } = {}) {
  const output = []
  let currentRunId = null
  const bootTime = Date.parse(bootTs ?? '')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const parsed = parseBuddyLogLine(line)
    if (parsed?.event === 'BOOT') {
      currentRunId = parsed.detail.runId ?? null
      continue
    }
    const match = /^\[([^\]]+)]\s+FATAL\s+(\{.*\})$/.exec(line.trim())
    if (match === null) continue
    let detail
    try {
      const value = JSON.parse(match[2] ?? '')
      if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
      const allowedKeys = ['trigger', 'code', 'context', 'attempts', 'error', 'reason', 'provider', 'model', 'retryable', 'generationId']
      detail = Object.fromEntries(allowedKeys
        .filter((key) => Object.hasOwn(value, key))
        .map((key) => [key, redactSecrets(value[key])]))
    } catch {
      continue
    }
    let errorEvent = null
    for (let lookahead = index + 1; lookahead < Math.min(lines.length, index + 5); lookahead += 1) {
      const candidate = parseBuddyLogLine(lines[lookahead] ?? '')
      if (candidate?.event === 'ERROR') {
        errorEvent = candidate
        break
      }
    }
    const observedAt = errorEvent?.ts ?? null
    const observedTime = Date.parse(observedAt ?? '')
    if (Number.isFinite(bootTime) && Number.isFinite(observedTime) && observedTime < bootTime) continue
    const belongsToCurrentRun = runId === null
      || currentRunId === runId
      || (runId !== null && Number.isFinite(bootTime) && Number.isFinite(observedTime) && observedTime >= bootTime)
    if (runId !== null && !belongsToCurrentRun) continue
    output.push({
      ts: observedAt,
      event: 'FATAL',
      detail: {
        ...detail,
        emitter: match[1] ?? null,
        source: 'runner.out',
        ...(belongsToCurrentRun && runId !== null ? { runId } : currentRunId !== null ? { runId: currentRunId } : {}),
      },
    })
  }
  return output
}

export function readRunnerOutEvents(logPath, options = {}, maxBytes = DEFAULT_LOG_TAIL_BYTES) {
  return parseRunnerOutEvents(readTextTail(logPath, maxBytes), options)
}

/** Find a recent event without scanning an unbounded append-only log. */
function readLogEvent(logPath, eventName, runId = null, detailMatches = null) {
  if (!existsSync(logPath)) return null
  const fd = openSync(logPath, 'r')
  try {
    const size = fstatSync(fd).size
    const scanStart = Math.max(0, size - MAX_RUN_BOUNDARY_SCAN_BYTES)
    let cursor = size
    let carry = ''
    const chunkSize = 64 * 1024
    while (cursor > scanStart) {
      const length = Math.min(cursor - scanStart, chunkSize)
      const start = cursor - length
      const buffer = Buffer.alloc(length)
      readSync(fd, buffer, 0, length, start)
      const lines = (buffer.toString('utf8') + carry).split('\n')
      carry = lines.shift() ?? ''
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const entry = parseBuddyLogLine(lines[index] ?? '')
        if (entry?.event === eventName
          && (runId === null || entry.detail.runId === runId)
          && (detailMatches === null || detailMatches(entry.detail))) return entry
      }
      cursor = start
    }
    // At a bounded scan boundary `carry` may be only the end of a line. Do not
    // attribute a partial record to this run; only parse it when the file start
    // was reached.
    if (scanStart > 0) return null
    const first = parseBuddyLogLine(carry)
    return first?.event === eventName
      && (runId === null || first.detail.runId === runId)
      && (detailMatches === null || detailMatches(first.detail)) ? first : null
  } finally {
    closeSync(fd)
  }
}

function readRunEvent(logPath, eventName, runId) {
  if (runId === null || runId === undefined) return null
  // Historical run metadata beyond MAX_RUN_BOUNDARY_SCAN_BYTES stays unknown;
  // never recover it by scanning an unbounded log on a live request.
  return readLogEvent(logPath, eventName, runId)
}

function readRunArtifact(runtimeDir, prefix, recordName, runId) {
  if (typeof runId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) return null
  const path = join(runtimeDir, 'data', 'resident', `${prefix}${runId}.json`)
  if (!existsSync(path)) return null
  let fd = null
  try {
    fd = openSync(path, 'r')
    const size = fstatSync(fd).size
    if (size < 2 || size > MAX_RUN_ARTIFACT_BYTES) return null
    const buffer = Buffer.alloc(size)
    readSync(fd, buffer, 0, size, 0)
    const parsed = JSON.parse(buffer.toString('utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    if (parsed.record !== recordName || parsed.runId !== runId) return null
    return parsed
  } catch {
    return null
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

/** Join only files whose embedded run identity matches the live report. */
function readRunMetadata(runtimeDir, runId) {
  // Writers use `<record>-<runId>.json`; runId already contains the `run-` prefix.
  const acceptance = readRunArtifact(runtimeDir, 'acceptance-', 'acceptance', runId)
  const predicates = readRunArtifact(runtimeDir, 'milestone-predicates-', 'milestone-predicates', runId)
  const acceptanceSha = acceptance?.gitCommit ?? null
  const predicateSha = predicates?.sourceSha ?? null
  const hasAcceptanceSha = typeof acceptanceSha === 'string' && acceptanceSha.length > 0
  const hasPredicateSha = typeof predicateSha === 'string' && predicateSha.length > 0
  const validSha = (value) => typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value)
  const sourceShaConflict = hasAcceptanceSha && hasPredicateSha
    && (!validSha(acceptanceSha) || !validSha(predicateSha) || acceptanceSha !== predicateSha)
  const sourceSha = acceptance !== null && predicates !== null
    && hasAcceptanceSha && hasPredicateSha
    && validSha(acceptanceSha) && acceptanceSha === predicateSha
    ? acceptanceSha
    : null
  return {
    acceptance,
    predicates,
    sourceSha,
    sourceShaConflict,
    runArtifactsMatched: acceptance !== null && predicates !== null,
  }
}

function runGenerationAnchorMatches(metadata, runId, generationId, readyEvent, runBoot = null) {
  const validSha = (value) => typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value)
  const bootSourceSha = runBoot?.detail?.source ?? runBoot?.detail?.sourceSha ?? null
  const readySourceSha = readyEvent?.detail?.source ?? readyEvent?.detail?.sourceSha ?? null
  const artifactSourceCandidates = [metadata?.acceptance?.gitCommit, metadata?.predicates?.sourceSha]
    .filter((value) => typeof value === 'string' && value.length > 0)
  const artifactConflict = metadata?.sourceShaConflict === true
    || artifactSourceCandidates.some((value) => !validSha(value))
    || new Set(artifactSourceCandidates).size > 1
  const eventSourceBound = validSha(bootSourceSha)
    && validSha(readySourceSha)
    && bootSourceSha === readySourceSha
  const artifactMatchesEvents = artifactSourceCandidates.every((value) => value === bootSourceSha)
  return typeof runId === 'string'
    && generationId !== null
    && typeof generationId === 'string'
    && !artifactConflict
    && eventSourceBound
    && artifactMatchesEvents
    && (metadata?.acceptance?.runId === undefined || metadata.acceptance.runId === runId)
    && (metadata?.predicates?.runId === undefined || metadata.predicates.runId === runId)
    && (runBoot === null || (runBoot.event === 'BOOT' && runBoot.detail?.runId === runId))
    && runBoot?.detail?.runId === runId
    && readyEvent?.event === 'GENERATION_READY'
    && readyEvent.detail?.id === generationId
    && readyEvent.detail?.runId === runId
    && parseTimestamp(readyEvent.ts) !== null
}

function generationArtifactStatus(artifact, liveGenerationId) {
  const artifactGenerationId = typeof artifact?.generationId === 'string' && artifact.generationId.length > 0
    ? artifact.generationId
    : null
  return {
    generationId: artifactGenerationId,
    status: artifactGenerationId === null
      ? 'unrecorded'
      : artifactGenerationId === liveGenerationId ? 'matches_live_generation' : 'different_from_live_generation',
  }
}

function eventBelongsToRunGeneration(entry, { runId, generationId, generationStartedAt, generationBound }) {
  const eventRunId = entry.detail?.runId
  if (eventRunId !== undefined && eventRunId !== null && eventRunId !== runId) return false
  if (generationBound !== true || typeof generationId !== 'string') return false
  const eventGenerationId = entry.detail?.generationId
    ?? entry.detail?.identity?.generationId
    ?? (entry.event === 'GENERATION_READY' ? entry.detail?.id : null)
  if (eventGenerationId !== null && eventGenerationId !== undefined) return eventGenerationId === generationId
  const eventAt = parseTimestamp(entry.ts)
  return Number.isFinite(generationStartedAt) && eventAt !== null && eventAt >= generationStartedAt
}

/** Read only a bounded JSONL tail; Jev call logs are append-only and can be large. */
export function readJsonlTail(logPath, maxBytes = 1024 * 1024) {
  return readTextTail(logPath, maxBytes).flatMap((line) => {
    try {
      const value = JSON.parse(line)
      return value !== null && typeof value === 'object' && !Array.isArray(value) ? [value] : []
    } catch {
      return []
    }
  })
}

/** Parse only structured VTR lifecycle events from the resident run journal. */
export function parseVtrRunJsonlEvents(records) {
  return records.flatMap((record) => {
    if (record?.record !== 'agent-event' || record?.source !== 'vtr'
      || typeof record.message !== 'string' || parseTimestamp(record.ts) === null) return []
    const event = /^(VTR_[A-Z0-9_]+)(?:\s|$)/.exec(record.message)?.[1] ?? null
    if (event === null || !VTR_TRACE_EVENTS.has(event)) return []
    const detail = record.detail !== null && typeof record.detail === 'object' && !Array.isArray(record.detail)
      ? record.detail
      : {}
    return [{ ts: record.ts, event, source: record.source, detail: redactSecrets(detail), raw: redactSecrets(record.message) }]
  })
}

export function readVtrRunJsonlEvents(logPath, maxBytes = DEFAULT_VTR_RUN_LOG_BYTES) {
  return parseVtrRunJsonlEvents(readJsonlTail(logPath, maxBytes))
}

export function latestEvent(events, names) {
  const accepted = names instanceof Set ? names : new Set(names)
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const entry = events[index]
    if (entry !== undefined && accepted.has(entry.event)) return entry
  }
  return null
}

export async function callControlSocket(socketPath, cmd = 'report', timeoutMs = DEFAULT_CONTROL_TIMEOUT_MS, args = {}) {
  return await new Promise((resolvePromise) => {
    if (!existsSync(socketPath)) return resolvePromise(null)
    const socket = net.createConnection(socketPath)
    let buffer = ''
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      try { socket.destroy() } catch {}
      resolvePromise(value)
    }
    socket.setTimeout(timeoutMs, () => finish(null))
    socket.on('error', () => finish(null))
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      try {
        finish(JSON.parse(buffer.slice(0, newline)))
      } catch {
        finish(null)
      }
    })
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ id: Date.now() % 1_000_000, cmd, args })}\n`)
    })
  })
}

function normalizeWorldKey(key) {
  if (typeof key === 'string') {
    const parts = key.split('|')
    if (parts.length !== 3 || parts[0] === '' || parts[1] === '') return null
    const worldEpoch = Number(parts[2])
    return Number.isSafeInteger(worldEpoch)
      ? { serverId: parts[0], dimension: normalizeDimension(parts[1]), worldEpoch }
      : null
  }
  if (key === null || typeof key !== 'object' || Array.isArray(key)) return null
  return {
    serverId: key.serverId ?? null,
    dimension: normalizeDimension(key.dimension),
    worldEpoch: key.worldEpoch ?? null,
  }
}

function completeWorldIdentity(key) {
  if (key === null
    || typeof key.serverId !== 'string' || key.serverId.length === 0
    || typeof key.dimension !== 'string' || key.dimension.length === 0
    || !Number.isSafeInteger(key.worldEpoch)) return null
  return JSON.stringify([key.serverId, key.dimension, key.worldEpoch])
}

function sameBoundIdentity(values) {
  const known = values.filter((value) => value !== null && value !== undefined)
  if (new Set(known).size > 1) return false
  return values.every((value) => typeof value === 'string' && value.length > 0) ? true : null
}

function probeHostility(entity) {
  const name = typeof entity?.name === 'string' ? entity.name.toLowerCase() : ''
  const kind = typeof entity?.kind === 'string' ? entity.kind : ''
  if (PROBE_HOSTILES.has(name) || /hostile/i.test(kind)) return true
  if (entity?.type === 'player' || entity?.type === 'other' || /passive|animal|item/i.test(kind)) return false
  return null
}

/** Join the explicit on-demand resident state probe with reports that bracket it. */
export function buildWorldProbe({ report, reportAfter = null, state, radius = 6, verticalRadius = 3, observedAt = new Date().toISOString() }) {
  const reportData = report?.ok === true ? report.data : null
  const reportAfterData = reportAfter?.ok === true ? reportAfter.data : null
  const stateData = state?.ok === true ? state.data : null
  if (stateData === null) {
    return redactSecrets({
      schemaVersion: 1,
      kind: 'ai-buddy-world-probe',
      observedAt,
      readOnly: true,
      status: 'unavailable',
      error: state?.error ?? state?.data?.error ?? 'resident-state-probe-unavailable',
      unknown: ['live_world_probe_unavailable'],
    })
  }

  const reportWorld = normalizeWorldKey(reportData?.worldKey)
  const probeWorld = normalizeWorldKey(stateData.worldKey)
  const afterWorld = normalizeWorldKey(reportAfterData?.worldKey)
  const reportRunId = reportData?.runId ?? null
  const probeRunId = stateData.runId ?? null
  const reportAfterRunId = reportAfterData?.runId ?? null
  const reportWorldId = completeWorldIdentity(reportWorld)
  const probeWorldId = completeWorldIdentity(probeWorld)
  const reportAfterWorldId = completeWorldIdentity(afterWorld)
  const sameRun = sameBoundIdentity([reportRunId, probeRunId, reportAfterRunId])
  const sameWorld = sameBoundIdentity([reportWorldId, probeWorldId, reportAfterWorldId])
  const reportGeneration = reportData?.generationId ?? null
  const probeGeneration = stateData.generationId ?? null
  const reportAfterGeneration = reportAfterData?.generationId ?? null
  const observedGenerations = [reportGeneration, probeGeneration, reportAfterGeneration]
    .filter((value) => typeof value === 'string' && value.length > 0)
  const generationMismatch = new Set(observedGenerations).size > 1
  const allGenerationsDirect = observedGenerations.length === 3
  // A direct state generation is only current across the whole sample when both
  // surrounding reports name that same generation. If the state reply omits its
  // generation, infer it only from a stable, fully bound report bracket.
  const stableReportBracket = typeof reportGeneration === 'string' && reportGeneration.length > 0
    && reportGeneration === reportAfterGeneration
    && sameRun === true
    && sameWorld === true
  const sameGeneration = generationMismatch ? false
    : allGenerationsDirect ? true
      : probeGeneration === null && stableReportBracket ? true
        : null
  const generationJoin = reportGeneration !== null && probeGeneration !== null
    && reportAfterGeneration !== null
    ? sameGeneration === true ? 'direct' : sameGeneration === false ? 'mismatch' : 'unknown'
    : sameGeneration === false ? 'mismatch'
      : sameGeneration === true ? 'stable-report-bracket' : 'unknown'
  const area = stateData.area ?? null
  const blocks = area?.blocks ?? null
  const entityCache = area?.entityCache ?? null
  const support = blocks?.support ?? null
  const supportEvidence = blocks?.supportEvidence ?? null
  const supportPoint = support?.position ?? null
  const supportBounds = supportEvidence?.sampleBounds ?? null
  const supportPlayerPosition = supportEvidence?.playerPosition ?? null
  const statePlayerPosition = stateData.truth?.position ?? null
  const supportInsideBounds = supportPoint !== null && supportBounds?.min !== undefined && supportBounds?.max !== undefined
    && supportPoint.x >= supportBounds.min.x && supportPoint.x <= supportBounds.max.x
    && supportPoint.y >= supportBounds.min.y && supportPoint.y <= supportBounds.max.y
    && supportPoint.z >= supportBounds.min.z && supportPoint.z <= supportBounds.max.z
  const supportMatchesSampledFooting = supportPlayerPosition !== null && supportPoint !== null
    && supportPoint.x === Math.floor(supportPlayerPosition.x)
    && supportPoint.y === Math.floor(supportPlayerPosition.y) - 1
    && supportPoint.z === Math.floor(supportPlayerPosition.z)
  const supportPlayerPositionMatchesState = supportPlayerPosition !== null && statePlayerPosition !== null
    && supportPlayerPosition.x === statePlayerPosition.x
    && supportPlayerPosition.y === statePlayerPosition.y
    && supportPlayerPosition.z === statePlayerPosition.z
  const supportCaptureMatchesState = supportEvidence?.capturedAt !== null
    && supportEvidence?.capturedAt === stateData.capturedAt
  const supportScopeStatus = supportEvidence === null ? 'unverified'
    : supportInsideBounds && supportMatchesSampledFooting && supportCaptureMatchesState
      && supportPlayerPositionMatchesState && supportEvidence.coordinateIsCurrentPlayerFooting === true
      ? 'verified-current-player-footing'
      : !supportInsideBounds ? 'outside-requested-sample'
        : !supportCaptureMatchesState ? 'capture-time-mismatch'
          : !supportPlayerPositionMatchesState ? 'player-position-mismatch'
            : 'not-current-player-footing'
  const worldCache = stateData.worldCache ?? null
  const worldCacheReadability = worldCache?.readability !== null && typeof worldCache?.readability === 'object'
    ? worldCache.readability
    : null
  const worldCacheBindingData = worldCache?.binding !== null && typeof worldCache?.binding === 'object'
    ? worldCache.binding
    : null
  const cacheWorld = normalizeWorldKey(worldCacheBindingData?.worldKey)
  const cacheWorldMatchesState = cacheWorld !== null && probeWorld !== null
    && cacheWorld.serverId === probeWorld.serverId
    && cacheWorld.dimension === probeWorld.dimension
    && cacheWorld.worldEpoch === probeWorld.worldEpoch
  const cacheRunStatus = typeof stateData.runId === 'string' && stateData.runId.length > 0
    ? worldCacheBindingData?.runId === stateData.runId ? 'aligned' : 'mismatch'
    : 'unknown'
  const cacheWorldStatus = cacheWorldMatchesState ? 'aligned'
    : cacheWorld === null || probeWorld === null ? 'unknown' : 'mismatch'
  const cacheGenerationStatus = worldCacheBindingData !== null
    && worldCacheBindingData.generationId === probeGeneration
    ? probeGeneration !== null ? 'aligned' : sameGeneration === true ? 'inferred' : 'unknown'
    : worldCacheBindingData === null || probeGeneration === null ? 'unknown' : 'mismatch'
  const cacheTimestampStatus = typeof stateData.capturedAt === 'string' && stateData.capturedAt.length > 0
    ? worldCache?.capturedAt === stateData.capturedAt ? 'aligned' : 'mismatch'
    : 'unknown'
  const cacheBindingStatuses = [cacheRunStatus, cacheWorldStatus, cacheGenerationStatus, cacheTimestampStatus]
  const worldCacheBinding = {
    status: cacheBindingStatuses.includes('mismatch') ? 'mismatch'
      : cacheBindingStatuses.includes('unknown') ? 'unknown'
        : cacheBindingStatuses.includes('inferred') ? 'inferred' : 'aligned',
    runId: cacheRunStatus,
    worldKey: cacheWorldStatus,
    generationId: cacheGenerationStatus,
    capturedAt: cacheTimestampStatus,
  }
  const entityCacheWorld = normalizeWorldKey(entityCache?.worldKey)
  const entityCacheWorldMatchesState = entityCacheWorld !== null && probeWorld !== null
    && entityCacheWorld.serverId === probeWorld.serverId
    && entityCacheWorld.dimension === probeWorld.dimension
    && entityCacheWorld.worldEpoch === probeWorld.worldEpoch
  const entityCacheBindingStatuses = [
    typeof stateData.runId === 'string' && stateData.runId.length > 0
      ? entityCache?.runId === stateData.runId ? 'aligned' : 'mismatch'
      : 'unknown',
    entityCacheWorldMatchesState ? 'aligned'
      : entityCacheWorld === null || probeWorld === null ? 'unknown' : 'mismatch',
    entityCache !== null && entityCache?.generationId === probeGeneration
      ? probeGeneration !== null ? 'aligned' : sameGeneration === true ? 'inferred' : 'unknown'
      : entityCache === null || entityCache?.generationId === null || probeGeneration === null ? 'unknown' : 'mismatch',
    typeof stateData.capturedAt === 'string' && stateData.capturedAt.length > 0
      ? entityCache?.capturedAt === stateData.capturedAt ? 'aligned' : 'mismatch'
      : 'unknown',
  ]
  const entityCacheBinding = {
    status: entityCache === null ? 'unavailable'
      : entityCacheBindingStatuses.includes('mismatch') ? 'mismatch'
        : entityCacheBindingStatuses.includes('unknown') ? 'unknown'
          : entityCacheBindingStatuses.includes('inferred') ? 'inferred' : 'aligned',
    runId: entityCacheBindingStatuses[0],
    worldKey: entityCacheBindingStatuses[1],
    generationId: entityCacheBindingStatuses[2],
    capturedAt: entityCacheBindingStatuses[3],
  }
  const entities = Array.isArray(area?.entities) ? area.entities : []
  const scannedBlocks = (2 * radius + 1) ** 2 * (2 * verticalRadius + 1)
  const unknownBlocks = typeof blocks?.unknown === 'number' ? blocks.unknown : null
  const unknown = []
  if (sameRun !== true) unknown.push('report_state_run_mismatch_or_unknown')
  if (sameWorld !== true) unknown.push('report_state_world_mismatch_or_unknown')
  if (reportAfterData === null) unknown.push('after_report_identity_unavailable')
  if (reportAfterData !== null && reportAfterRunId === null) unknown.push('report_after_run_identity_unknown')
  else if (reportAfterRunId !== null && reportRunId !== null && reportAfterRunId !== reportRunId) unknown.push('report_after_run_mismatch')
  if (reportAfterData !== null && reportAfterWorldId === null) unknown.push('report_after_world_identity_unknown')
  else if (reportAfterWorldId !== null && reportWorldId !== null && reportAfterWorldId !== reportWorldId) unknown.push('report_after_world_mismatch')
  if (sameGeneration === false) unknown.push('report_state_generation_mismatch')
  else if (sameGeneration === null) unknown.push('report_state_generation_alignment_unknown')
  if (reportAfterData !== null && (typeof reportAfterGeneration !== 'string' || reportAfterGeneration.length === 0)) unknown.push('report_after_generation_identity_unknown')
  else if (reportAfterGeneration !== null && reportGeneration !== null && reportAfterGeneration !== reportGeneration) unknown.push('report_after_generation_mismatch')
  if (unknownBlocks === null) unknown.push('scanned_block_coverage_unknown')
  else if (unknownBlocks > 0) unknown.push('some_scanned_blocks_unloaded_or_unknown')
  if (worldCache === null || typeof worldCache !== 'object') unknown.push('world_cache_diagnostic_unavailable')
  else if (worldCacheBinding.status === 'mismatch') unknown.push('world_cache_identity_or_timestamp_mismatch')
  else if (worldCacheBinding.status === 'unknown') unknown.push('world_cache_identity_or_timestamp_unknown')
  if (worldCacheReadability?.status === 'unbound') {
    unknown.push(`world_reads_unbound:${worldCacheReadability.unboundReason ?? 'unknown'}`)
  } else if (typeof worldCacheReadability?.refusedColumnCount === 'number' && worldCacheReadability.refusedColumnCount > 0) {
    unknown.push('some_requested_world_columns_refused_or_unavailable')
  }
  if (entityCacheBinding.status === 'unavailable') unknown.push('entity_cache_diagnostic_unavailable')
  else if (entityCacheBinding.status === 'mismatch') unknown.push('entity_cache_identity_or_timestamp_mismatch')
  else if (entityCacheBinding.status === 'unknown') unknown.push('entity_cache_identity_or_timestamp_unknown')
  if (supportScopeStatus === 'unverified') unknown.push('support_current_footing_scope_unverified')
  else if (supportScopeStatus !== 'verified-current-player-footing') unknown.push(`support_${supportScopeStatus.replaceAll('-', '_')}`)

  const projectedEntities = entities.slice(0, 64).map((entity) => ({
    id: entity.id ?? null,
    name: entity.name ?? null,
    type: entity.type ?? null,
    kind: entity.kind ?? null,
    position: entity.position ?? null,
    distance: entity.distance ?? null,
    health: entity.health ?? null,
    hostile: probeHostility(entity),
  }))
  const hostiles = projectedEntities.filter((entity) => entity.hostile === true)
  const unclassifiedEntities = projectedEntities.filter((entity) => entity.hostile === null).length
  if (unclassifiedEntities > 0) unknown.push('some_nearby_entities_unclassified')

  const reportStatus = reportData?.status ?? null
  const blockCounts = blocks?.counts !== null && typeof blocks?.counts === 'object'
    ? Object.fromEntries(Object.entries(blocks.counts).slice(0, 80))
    : null
  const milestonePredicates = sameRun && sameWorld && sameGeneration === true
    ? milestonePredicateProjection(reportStatus?.milestonePredicates)
    : { status: 'not_joined', entries: [] }
  if (milestonePredicates.status !== 'observed') unknown.push('milestone_predicates_not_joined_to_probe')
  const identityAligned = sameWorld === true && sameRun === true && sameGeneration === true
  const dataComplete = unknownBlocks === 0 && unclassifiedEntities === 0 && sameGeneration === true
    && (worldCacheBinding.status === 'aligned' || worldCacheBinding.status === 'inferred')
    && (entityCacheBinding.status === 'aligned' || entityCacheBinding.status === 'inferred')
    && supportScopeStatus === 'verified-current-player-footing'
  return redactSecrets({
    schemaVersion: 1,
    kind: 'ai-buddy-world-probe',
    observedAt,
    capturedAt: stateData.capturedAt ?? null,
    readOnly: true,
    status: identityAligned && dataComplete ? 'known' : 'partial',
    identityAligned,
    dataComplete,
    binding: {
      reportRunId: reportData?.runId ?? null,
      probeRunId: stateData.runId ?? null,
      reportAfterRunId,
      sameRun,
      sameWorld,
      sameGeneration,
      reportWorld,
      probeWorld,
      reportAfterWorld: afterWorld,
      reportGenerationId: reportGeneration,
      probeGenerationId: probeGeneration,
      reportAfterGenerationId: reportAfterGeneration,
      generationJoin,
      generationJoinConfidence: generationJoin === 'direct' ? 'direct' : generationJoin === 'stable-report-bracket' ? 'inferred' : 'unknown',
      worldCache: worldCacheBinding,
      entityCache: entityCacheBinding,
      support: supportScopeStatus,
    },
    world: {
      ...pickFields(stateData.world, ['dimension', 'version', 'serverBrand', 'levelType', 'timeOfDay', 'day', 'raining', 'thunderState']),
      worldKey: probeWorld,
    },
    player: {
      ...pickFields(stateData.truth, ['position', 'health', 'food', 'dimension', 'onGround', 'inventory']),
      stateSource: 'resident-live-state-probe',
    },
    worldCache,
    worldCacheCapturedAt: worldCache?.capturedAt ?? null,
    worldCacheBinding,
    worldCacheReadability,
    entityCache,
    entityCacheCapturedAt: entityCache?.capturedAt ?? null,
    entityCacheBinding,
    area: {
      radius,
      verticalRadius,
      scannedBlocks,
      knownBlocks: unknownBlocks === null ? null : Math.max(0, scannedBlocks - unknownBlocks),
      unknownBlocks,
      coverage: unknownBlocks === null ? null : Math.max(0, scannedBlocks - unknownBlocks) / scannedBlocks,
      blockCounts,
      hazards: Array.isArray(blocks?.hazards) ? blocks.hazards.slice(0, 32) : null,
      portals: Array.isArray(blocks?.portals) ? blocks.portals.slice(0, 32) : null,
      support,
      supportEvidence,
      supportScopeStatus,
      entities: projectedEntities,
      hostiles,
      hostileStatus: Array.isArray(area?.entities) ? 'observed-in-local-client-entity-cache' : 'not_recorded',
      unclassifiedEntityCount: unclassifiedEntities,
    },
    structures: {
      status: 'not_identifiable_from_local_block_entity_probe',
      evidence: 'nearby block counts and entities only; no structure locator or POI scan was performed',
    },
    milestones: milestonePredicates,
    unknown,
  })
}

function projectMission(mission, { runId, generationId, generationBound, sourceCommit }) {
  const provenance = mission?.provenance ?? null
  const source = typeof provenance?.source === 'string' && provenance.source.trim() !== ''
    ? provenance.source
    : null
  const provenanceRunId = provenance?.runId ?? null
  const provenanceGenerationId = provenance?.generationId ?? null
  const structuredPredicate = typeof mission?.kind === 'string'
    && ((mission.kind === 'inventory_at_least'
      && typeof mission.item === 'string' && mission.item.length > 0
      && Number.isFinite(mission.count) && mission.count >= 0)
      || (mission.kind !== 'inventory_at_least' && mission.predicate !== undefined))
  const title = typeof mission?.title === 'string' && mission.title.trim() !== ''
    ? mission.title
    : mission?.kind === 'inventory_at_least' && typeof mission.item === 'string'
      ? Number.isFinite(mission.count) ? `Acquire ${mission.count} ${mission.item}` : null
      : null
  let reason = null

  if (runId === null) reason = 'mission_live_run_identity_unavailable'
  else if (generationId === null) reason = 'mission_current_generation_identity_unavailable'
  else if (generationBound !== true) reason = 'mission_current_generation_boundary_unavailable'
  else if (source === null) reason = 'mission_source_unavailable'
  else if (!structuredPredicate && (typeof mission?.id !== 'string' || mission.id.trim() === ''
    || title === null)) reason = 'mission_identity_unavailable'
  else if (provenanceRunId !== runId) reason = 'mission_source_run_mismatch'
  else if (provenanceGenerationId !== generationId) reason = 'mission_source_generation_mismatch'

  if (reason !== null) {
    return {
      status: 'unknown',
      id: null,
      title: null,
      provenance: {
        status: 'unbound',
        source,
        runId,
        generationId,
        reason,
      },
    }
  }

  return {
    status: 'observed',
    id: typeof mission.id === 'string' ? mission.id : null,
    title,
    ...(structuredPredicate ? {
      predicate: pickFields(mission, ['kind', 'item', 'count', 'predicate']),
    } : {}),
    provenance: {
      status: 'run_generation_bound',
      source,
      runId,
      generationId,
      sourceCommit,
    },
  }
}

function queueProjection(status) {
  const queue = status?.queue ?? null
  const current = queue?.current ?? null
  return {
    depth: queue?.depth ?? null,
    done: queue?.done ?? null,
    revision: queue?.revision ?? null,
    current: current === null ? null : {
      id: current.id ?? null,
      kind: current.kind ?? null,
      description: current.description ?? null,
      status: current.status ?? null,
      targetItem: current.targetItem ?? null,
      haveCount: current.haveCount ?? null,
      requiredCount: current.requiredCount ?? null,
      semanticOptionIntent: current.semanticOptionIntent ?? null,
      semanticOptionTemplateId: current.semanticOptionTemplateId ?? current.optionTemplateId ?? null,
      semanticOptionInstanceId: current.semanticOptionInstanceId ?? current.optionInstanceId ?? null,
      detail: current.detail ?? null,
    },
  }
}

function milestonePredicateProjection(predicates) {
  if (!Array.isArray(predicates)) return { status: 'not_recorded', entries: [] }
  return {
    status: 'observed',
    entries: predicates.slice(0, 16).map((predicate) => ({
      id: predicate?.id ?? null,
      milestone: predicate?.milestone ?? null,
      satisfied: predicate?.satisfied ?? null,
      observedAt: predicate?.observedAt ?? null,
      source: predicate?.source ?? null,
      evidence: pickFields(predicate?.evidence, ['rungId', 'rungPredicate', 'dimension', 'portalVerified', 'items']),
    })),
    truncated: predicates.length > 16,
  }
}

function traceProjection(entry) {
  if (entry === null) return null
  return { ts: entry.ts, event: entry.event, detail: entry.detail }
}

function transitionModelMetricsProjection(entry) {
  if (entry === null) return null
  const detail = entry.detail ?? {}
  return {
    transitionId: detail.transitionId ?? null,
    contractHash: detail.contractHash ?? null,
    typedTerminalOutcome: detail.typedTerminalOutcome ?? null,
    mechanicalSteps: detail.mechanicalSteps ?? null,
    jevDecisionFrameInvocations: detail.jevDecisionFrameInvocations ?? null,
    jevDecisionFramesPerMechanicalStep: detail.jevDecisionFramesPerMechanicalStep ?? null,
    jevModelProviderEvaluateAttempts: detail.jevModelProviderEvaluateAttempts ?? null,
    jevModelProviderEvaluateAttemptsPerMechanicalStep: detail.jevModelProviderEvaluateAttemptsPerMechanicalStep ?? null,
    policy: detail.policy ?? null,
    model: detail.model ?? null,
    provider: detail.provider ?? null,
    identity: detail.identity ?? null,
    observedAt: entry.ts,
    event: traceProjection(entry),
  }
}

function mechanicalStepId(entry) {
  const detail = entry?.detail ?? {}
  const value = detail.stepId ?? detail.mechanicalStepId ?? detail.step?.stepId
  return typeof value === 'string' && value.length > 0 ? value : null
}

function mechanicalIntentId(entry) {
  const detail = entry?.detail ?? {}
  const value = detail.intentId ?? detail.intent?.intentId
  return typeof value === 'string' && value.length > 0 ? value : null
}

function mechanicalStepProjection(linked) {
  const reservations = linked.filter((entry) => entry.event === 'VTR_MECHANICAL_STEP_RESERVED')
  const actuations = linked.filter((entry) => entry.event === 'VTR_TRANSITION_ACTUATION')
  const stepOutcomes = linked.filter((entry) => entry.event === 'VTR_MECHANICAL_STEP_OUTCOME')
  const actionOutcomes = linked.filter((entry) => entry.event === 'VTR_MECHANICAL_OUTCOME')
  const controlNames = new Set([
    'VTR_DUAL_AUTHORITY_FENCE',
    'VTR_REACH_GUARD_REFUSED',
    'VTR_RUNTIME_INTENT_REFUSED',
    'VTR_EXECUTOR_CLAIM_REFUSED',
    'VTR_INTENT_RELEASE_REFUSED',
    'VTR_MECHANICAL_STEP_REFUSED',
    'VTR_MECHANICAL_OUTCOME_REFUSED',
    'VTR_MECHANICAL_OUTCOME_REJECTED',
    'VTR_ORPHAN_ACTUATION_REVOKED',
  ])
  const controls = linked.filter((entry) => controlNames.has(entry.event))
  const steps = reservations.map((reservation) => {
    const stepId = mechanicalStepId(reservation)
    const intentId = mechanicalIntentId(reservation)
    const stepActuations = actuations.filter((entry) => {
      const actuationStepId = mechanicalStepId(entry)
      if (actuationStepId !== null) return stepId !== null && actuationStepId === stepId
      return intentId !== null && mechanicalIntentId(entry) === intentId
    })
    const stepOutcomeEvents = stepOutcomes.filter((entry) => stepId !== null && mechanicalStepId(entry) === stepId)
    const intentOutcomeEvents = actionOutcomes.filter((entry) => intentId !== null && mechanicalIntentId(entry) === intentId)
    const stepControls = controls.filter((entry) => {
      const controlStepId = mechanicalStepId(entry)
      const controlIntentId = mechanicalIntentId(entry)
      if (controlStepId !== null) return stepId !== null && controlStepId === stepId
      return intentId !== null && controlIntentId === intentId
    })
    const actuationBinding = stepActuations.map((entry) => ({
      scope: mechanicalStepId(entry) === stepId && stepId !== null ? 'step' : 'intent',
      event: traceProjection(entry),
    }))
    const outcome = stepOutcomeEvents.at(-1) ?? null
    const intentOutcome = intentOutcomeEvents.at(-1) ?? null
    const outcomeDetail = outcome?.detail ?? null
    const reservedDetail = reservation.detail ?? {}
    return {
      stepId,
      leg: reservedDetail.leg ?? null,
      intentId,
      effectKind: reservedDetail.effectKind ?? null,
      status: outcome !== null ? 'mechanical_outcome_observed'
        : intentOutcome !== null ? 'intent_outcome_only'
          : stepControls.length > 0 ? 'control_event_observed'
            : stepActuations.length > 0 ? 'actuated_outcome_unobserved'
              : 'reserved_without_actuation',
      reserved: traceProjection(reservation),
      actuations: actuationBinding,
      outcome: traceProjection(outcome),
      stepOutcome: outcomeDetail === null ? null : {
        event: outcome.event,
        stepId: mechanicalStepId(outcome),
        leg: outcomeDetail.leg ?? null,
        status: outcomeDetail.status ?? null,
        outcome: outcomeDetail.outcome ?? null,
        verified: typeof outcomeDetail.verified === 'boolean' ? outcomeDetail.verified : null,
        reason: outcomeDetail.reason ?? null,
        contractHash: outcomeDetail.contractHash ?? null,
        identity: outcomeDetail.identity ?? null,
        observedAtMs: outcomeDetail.observedAtMs ?? null,
        usage: outcomeDetail.usage ?? null,
        observedAt: outcome.ts,
      },
      intentOutcome: traceProjection(intentOutcome),
      controlEvents: stepControls.map(traceProjection),
      correlation: {
        reservation: stepId === null ? 'missing-step-id' : 'step-id',
        actuation: stepActuations.length === 0 ? 'unmatched'
          : stepActuations.every((entry) => mechanicalStepId(entry) === stepId && stepId !== null)
            ? 'step-id' : 'shared-intent-id',
        outcome: outcome !== null ? 'step-id' : intentOutcome !== null ? 'intent-id-only' : 'not-observed',
      },
      trace: [reservation, ...stepActuations, ...(outcome === null ? [] : [outcome]), ...(intentOutcome === null ? [] : [intentOutcome]), ...stepControls]
        .sort((left, right) => (parseTimestamp(left.ts) ?? 0) - (parseTimestamp(right.ts) ?? 0))
        .map(traceProjection),
    }
  })
  return {
    steps: steps.slice(0, 256),
    truncated: steps.length > 256,
    reservationCount: reservations.length,
    actuationEventCount: actuations.length,
    stepOutcomeEventCount: stepOutcomes.length,
    actionOutcomeEventCount: actionOutcomes.length,
    mechanicalOutcomeEventCount: stepOutcomes.length + actionOutcomes.length,
    controlEventCount: controls.length,
    stepOutcomeEvents: stepOutcomes.slice(-256).map(traceProjection),
    actionOutcomes: actionOutcomes.slice(-64).map(traceProjection),
    controlEvents: controls.slice(-64).map(traceProjection),
  }
}

function projectPostTerminalOrphans(linked, outcomeEvent, terminalKind, verification) {
  const orphanEvents = linked.filter((entry) => entry.event === 'VTR_ORPHAN_ACTION_OUTCOME')
  const terminalIndex = linked.indexOf(outcomeEvent)
  const terminalAt = parseTimestamp(outcomeEvent?.ts)
  const postTerminal = terminalKind === 'SUCCESS'
    ? orphanEvents.filter((entry) => {
      const eventAt = parseTimestamp(entry.ts)
      return eventAt !== null && terminalAt !== null
        && (eventAt > terminalAt || (eventAt === terminalAt && linked.indexOf(entry) > terminalIndex))
    })
    : []
  const contradictions = postTerminal.map((entry) => {
    const result = entry.detail?.result ?? {}
    return {
      kind: 'orphan_action_after_success',
      severity: 'contradiction',
      transitionId: entry.detail?.transitionId ?? null,
      intentId: entry.detail?.intentId ?? null,
      actionId: result.actionId ?? entry.detail?.actionId ?? null,
      actionStatus: result.status ?? entry.detail?.status ?? null,
      actionVerified: result.verified ?? entry.detail?.verified ?? null,
      skillOutcome: result.skillOutcome ?? entry.detail?.skillOutcome ?? null,
      verifiedTransition: verification?.verified === true,
      observedAt: entry.ts,
      event: traceProjection(entry),
    }
  })
  return {
    status: contradictions.length > 0 ? 'contradiction'
      : orphanEvents.length > 0 ? 'orphan_observed'
        : outcomeEvent === null ? 'pending' : 'no_post_terminal_orphan_observed',
    orphanActionOutcomes: orphanEvents.slice(-64).map(traceProjection),
    contradictions,
  }
}

function projectVtrReachRouteDecision(entry) {
  if (entry === null) return null
  const detail = entry.detail ?? {}
  const routeIds = Array.isArray(detail.routeIds)
    ? detail.routeIds.filter((routeId) => typeof routeId === 'string' && routeId.length > 0).slice(0, 64)
    : []
  const selectedRouteId = typeof detail.selectedRouteId === 'string' && detail.selectedRouteId.length > 0
    ? detail.selectedRouteId
    : null
  const selectedIsGrounded = selectedRouteId !== null && routeIds.includes(selectedRouteId)
  const rawProbabilities = detail.probabilities
  const probabilityEntries = rawProbabilities !== null && typeof rawProbabilities === 'object' && !Array.isArray(rawProbabilities)
    ? Object.entries(rawProbabilities).filter(([, value]) => typeof value === 'number' && Number.isFinite(value))
    : null
  const source = typeof detail.source === 'string' ? detail.source : null
  const actor = source === 'jev' ? 'jev'
    : source === 'fallback' ? 'fallback'
      : source === 'reflex' ? 'reflex'
        : 'unknown'
  return redactSecrets({
    observedAt: entry.ts,
    event: entry.event,
    actor,
    source,
    policy: typeof detail.policy === 'string' ? detail.policy : null,
    model: typeof detail.model === 'string' ? detail.model : null,
    callId: typeof detail.callId === 'string' ? detail.callId : null,
    transitionId: detail.transitionId ?? null,
    contractHash: detail.contractHash ?? null,
    status: selectedIsGrounded ? 'selected_grounded_route'
      : detail.reason !== undefined ? 'unavailable'
        : selectedRouteId !== null ? 'selected_route_not_in_grounded_set' : 'selection_unavailable',
    selectedRouteId,
    selectedRoute: selectedIsGrounded ? {
      routeId: selectedRouteId,
      grounded: true,
      groundingSource: 'VTR_REACH_ROUTE_DECISION.detail.routeIds',
    } : null,
    routeIds,
    routeIdsTruncated: Array.isArray(detail.routeIds) && detail.routeIds.length > routeIds.length,
    actionProbability: typeof detail.actionProbability === 'number' && Number.isFinite(detail.actionProbability)
      ? detail.actionProbability
      : null,
    probabilities: probabilityEntries === null ? null : Object.fromEntries(probabilityEntries.slice(0, 64)),
    probabilitiesTruncated: probabilityEntries !== null && probabilityEntries.length > 64,
    latencyMs: typeof detail.latencyMs === 'number' && Number.isFinite(detail.latencyMs) ? detail.latencyMs : null,
    reason: detail.reason ?? null,
    binding: {
      runId: detail.runId ?? detail.identity?.runId ?? null,
      generationId: detail.generationId ?? detail.identity?.generationId ?? null,
      sourceSha: detail.sourceSha ?? detail.sourceCommit ?? detail.identity?.sourceSha ?? null,
      worldKey: worldKeyFromVtrDetail(detail),
    },
  })
}

function worldKeyFromVtrDetail(detail) {
  return normalizeWorldKey(detail?.worldKey ?? detail?.identity?.worldKey
    ?? (typeof detail?.serverId === 'string' && typeof detail?.dimension === 'string'
      ? { serverId: detail.serverId, dimension: detail.dimension, worldEpoch: detail.worldEpoch }
      : null))
}

function vtrEventMatchesLiveFence(entry, { runId, generationId, sourceCommit, worldKey, generationStartedAt }) {
  const detail = entry?.detail ?? {}
  const identity = detail.identity ?? {}
  const directRunId = detail.runId ?? identity.runId ?? null
  const directGenerationId = detail.generationId ?? identity.generationId ?? null
  const directSourceSha = detail.sourceSha ?? detail.sourceCommit ?? identity.sourceSha ?? null
  const eventAt = parseTimestamp(entry?.ts)
  const eventWorld = worldKeyFromVtrDetail(detail)
  const expectedWorld = normalizeWorldKey(worldKey)
  if (directRunId !== null && directRunId !== runId) return false
  if (directGenerationId !== null && directGenerationId !== generationId) return false
  if (directSourceSha !== null && directSourceSha !== sourceCommit) return false
  if (eventAt === null || generationStartedAt === null || eventAt < generationStartedAt) return false
  if (eventWorld !== null && completeWorldIdentity(eventWorld) !== completeWorldIdentity(expectedWorld)) return false
  const declaredEpoch = detail.worldEpoch ?? identity.worldEpoch
  if (eventWorld !== null && declaredEpoch !== undefined && Number(declaredEpoch) !== eventWorld.worldEpoch) return false
  const declaredDimension = detail.dimension ?? identity.dimension
  if (eventWorld !== null && declaredDimension !== undefined
    && normalizeDimension(declaredDimension) !== eventWorld.dimension) return false
  if (entry.event === 'VTR_TRANSITION_COMMIT') {
    return directGenerationId === generationId
      && eventWorld !== null
      && completeWorldIdentity(eventWorld) === completeWorldIdentity(expectedWorld)
  }
  if (entry.event === 'VTR_TRANSITION_VERIFY') {
    return detail.runId === runId
      && detail.generationId === generationId
      && detail.sourceSha === sourceCommit
      && eventWorld !== null
      && completeWorldIdentity(eventWorld) === completeWorldIdentity(expectedWorld)
  }
  if (entry.event === 'VTR_REACH_ROUTE_DECISION') {
    return directRunId === runId
      && directGenerationId === generationId
      && directSourceSha === sourceCommit
      && typeof detail.transitionId === 'string'
      && typeof detail.contractHash === 'string'
      && eventWorld !== null
      && completeWorldIdentity(eventWorld) === completeWorldIdentity(expectedWorld)
  }
  return true
}

/** Build an exact-generation VTR journal view without presenting it as a Jev choice. */
export function projectVtrTransitions({ events = [], runId = null, generationId = null, sourceCommit = null, worldKey = null, generationStartedAt = null }) {
  if (typeof runId !== 'string' || typeof generationId !== 'string'
    || typeof sourceCommit !== 'string' || completeWorldIdentity(normalizeWorldKey(worldKey)) === null
    || generationStartedAt === null) {
    return { status: 'unknown', binding: null, latest: null, transitions: [], events: [], unknown: ['vtr_run_generation_source_world_boundary_unavailable'] }
  }

  const scopedEvents = events
    .filter((entry) => entry?.source === 'vtr' && VTR_TRACE_EVENTS.has(entry.event))
    .filter((entry) => vtrEventMatchesLiveFence(entry, { runId, generationId, sourceCommit, worldKey, generationStartedAt }))
  const commits = scopedEvents.filter((entry) => entry.event === 'VTR_TRANSITION_COMMIT'
    && typeof entry.detail?.transitionId === 'string'
    && typeof entry.detail?.contractHash === 'string')
  const transitions = commits.map((commit) => {
    const detail = commit.detail
    const transitionId = detail.transitionId
    const contractHash = detail.contractHash
    const linked = scopedEvents.filter((entry) => entry.detail?.transitionId === transitionId
      && (entry.detail?.contractHash === undefined || entry.detail.contractHash === contractHash))
    const progressEvent = latestEvent(linked, ['VTR_TRANSITION_PROGRESS'])
    const actuationEvent = latestEvent(linked, ['VTR_TRANSITION_ACTUATION'])
    const routeDecisionEvent = latestEvent(linked, ['VTR_REACH_ROUTE_DECISION'])
    const verifyEvent = latestEvent(linked, ['VTR_TRANSITION_VERIFY'])
    const outcomeEvent = latestEvent(linked, ['VTR_TRANSITION_OUTCOME'])
    const modelMetricsEvents = linked.filter((entry) => entry.event === 'VTR_TRANSITION_MODEL_METRICS')
    const modelMetricsEvent = modelMetricsEvents.at(-1) ?? null
    const verifyDetail = verifyEvent?.detail ?? null
    const verification = verifyDetail === null ? null : {
      truth: verifyDetail.truth ?? null,
      predicates: verifyDetail.predicates ?? [],
      evidenceIds: verifyDetail.evidenceIds ?? [],
      verifiedAtMs: verifyDetail.verifiedAtMs ?? null,
      identityMatches: verifyDetail.identityMatches === true,
      predicatesVerified: verifyDetail.predicatesVerified === true,
      verified: verifyDetail.identityMatches === true
        && verifyDetail.predicatesVerified === true
        && verifyDetail.truth === 'TRUE',
      binding: {
        runId: verifyDetail.runId ?? null,
        generationId: verifyDetail.generationId ?? null,
        sourceSha: verifyDetail.sourceSha ?? null,
        worldKey: verifyDetail.worldKey ?? null,
      },
    }
    const outcomeDetail = outcomeEvent?.detail ?? null
    const terminalKind = outcomeDetail?.outcome?.kind ?? null
    const verifiedSuccess = terminalKind === 'SUCCESS' && verification?.verified === true
    const mechanical = mechanicalStepProjection(linked)
    const outcomeConsistency = projectPostTerminalOrphans(linked, outcomeEvent, terminalKind, verification)
    const lifecycleEvents = linked.filter((entry) => /(?:REFUSED|FENCE|ORPHAN|HANDOFF|STALE|FAILED|REQUIRED|REVOKED|WITHHELD|REJECTED|HOLDS|TERMINAL_ACTION_CORRELATED|TERMINAL_ACTION_SETTLEMENT_MISMATCH)/.test(entry.event))
    const status = verifiedSuccess
      ? 'verified_success'
      : terminalKind === 'SUCCESS' ? 'success_without_verified_predicate'
        : terminalKind !== null ? 'terminal'
          : 'active_or_pending'
    return {
      transitionId,
      contractHash,
      status,
      committedAt: commit.ts,
      mission: detail.mission ?? null,
      desiredPredicate: detail.desiredPredicate ?? null,
      contract: {
        requires: detail.requires ?? [],
        ensures: detail.ensures ?? [],
        invariants: detail.invariants ?? [],
        admissibleEffects: detail.admissibleEffects ?? [],
        budget: detail.budget ?? null,
        identity: detail.identity ?? null,
        witness: detail.witness ?? null,
        initialRouteIds: detail.initialRouteIds ?? [],
        routePolicy: detail.routePolicy ?? null,
      },
      progress: progressEvent?.detail?.progress ?? null,
      progressEvent: traceProjection(progressEvent),
      mechanical,
      modelMetrics: transitionModelMetricsProjection(modelMetricsEvent),
      modelMetricsEventCount: modelMetricsEvents.length,
      lifecycleEvents: lifecycleEvents.slice(-64).map(traceProjection),
      routeDecision: projectVtrReachRouteDecision(routeDecisionEvent),
      actuation: actuationEvent === null ? null : {
        candidate: actuationEvent.detail?.candidate ?? null,
        target: actuationEvent.detail?.target ?? null,
        selectedBy: actuationEvent.detail?.selectedBy ?? null,
        authority: actuationEvent.detail?.authority ?? null,
        leaseEpoch: actuationEvent.detail?.leaseEpoch ?? null,
        event: traceProjection(actuationEvent),
      },
      verification,
      outcomeConsistency,
      outcome: outcomeDetail === null ? null : {
        kind: terminalKind,
        boundary: outcomeDetail.boundary ?? null,
        reason: outcomeDetail.outcome?.reason ?? null,
        typed: outcomeDetail.outcome ?? null,
        usage: outcomeDetail.usage ?? null,
        metrics: outcomeDetail.metrics ?? null,
        event: traceProjection(outcomeEvent),
      },
      binding: {
        runId,
        generationId,
        sourceSha: sourceCommit,
        worldKey: normalizeWorldKey(worldKey),
        method: 'live-report+BOOT+GENERATION_READY+VTR-contract-identity',
        confidence: 'direct',
      },
    }
  })
  const latest = transitions.at(-1) ?? null
  const latestCommit = commits.at(-1) ?? null
  const latestRouteDecision = transitions
    .map((transition) => transition.routeDecision)
    .filter((decision) => decision !== null)
    .sort((left, right) => (parseTimestamp(right.observedAt) ?? 0) - (parseTimestamp(left.observedAt) ?? 0))[0] ?? null
  const latestRouteTransition = latestRouteDecision === null ? null : transitions.find((transition) =>
    transition.transitionId === latestRouteDecision.transitionId && transition.contractHash === latestRouteDecision.contractHash) ?? null
  const latestAdmission = latestCommit === null ? null : {
    observedAt: latestCommit.ts,
    actor: 'vtr',
    event: latestCommit.event,
    selected: {
      transitionId: latestCommit.detail.transitionId,
      contractHash: latestCommit.detail.contractHash,
      ensures: latestCommit.detail.desiredPredicate?.id ?? latestCommit.detail.ensures?.[0]?.id ?? null,
      mission: latestCommit.detail.mission ?? null,
    },
    reason: latestCommit.detail.routePolicy ?? 'grounded VTR transition admitted',
    generationId,
  }
  const routeDecisionSummary = latestRouteDecision === null ? null : {
    observedAt: latestRouteDecision.observedAt,
    actor: latestRouteDecision.actor,
    event: latestRouteDecision.event,
    selected: {
      transitionId: latestRouteDecision.transitionId,
      contractHash: latestRouteDecision.contractHash,
      ensures: latestRouteTransition?.desiredPredicate?.id ?? null,
      routeId: latestRouteDecision.selectedRoute?.routeId ?? null,
      grounded: latestRouteDecision.selectedRoute?.grounded ?? false,
      source: latestRouteDecision.source,
      policy: latestRouteDecision.policy,
      model: latestRouteDecision.model,
      callId: latestRouteDecision.callId,
      probabilities: latestRouteDecision.probabilities,
    },
    reason: latestRouteDecision.reason ?? (latestRouteDecision.source === 'jev'
      ? 'Jev selected among grounded VTR Reach routes'
      : latestRouteDecision.source === 'fallback'
        ? 'Explicit fallback policy selected among grounded VTR Reach routes'
        : latestRouteDecision.source === 'reflex'
          ? 'Code reflex selected a grounded VTR Reach route'
          : null),
    generationId,
    routeDecision: latestRouteDecision,
  }
  const latestDecision = latestAdmission === null ? routeDecisionSummary
    : routeDecisionSummary === null || (parseTimestamp(latestAdmission.observedAt) ?? 0) > (parseTimestamp(routeDecisionSummary.observedAt) ?? 0)
      ? latestAdmission
      : routeDecisionSummary
  return {
    status: latest === null ? 'not_recorded' : 'observed',
    binding: {
      runId,
      generationId,
      sourceSha: sourceCommit,
      worldKey: normalizeWorldKey(worldKey),
      method: 'live-report+BOOT+GENERATION_READY+VTR-contract-identity',
      confidence: 'direct',
    },
    latest,
    latestDecision,
    latestAdmission,
    latestRouteDecision,
    transitions: transitions.slice(-12),
    events: scopedEvents.slice(-24).reverse().map(traceProjection),
    unknown: latest === null ? ['no_vtr_transition_commit_in_bounded_run_tail'] : [],
  }
}

export function buildObserverSnapshot({ report, events, mission = null, runBoot = null, runBuild = null, runMetadata = null, runGenerationReady = null, jevCalls = [], now = Date.now() }) {
  const data = report?.ok === true ? report.data : null
  const status = data?.status ?? null
  const bootFromTail = latestEvent(events, ['BOOT'])
  const runId = typeof data?.runId === 'string' && data.runId.length > 0 ? data.runId : null
  const generationId = typeof data?.generationId === 'string' && data.generationId.length > 0 ? data.generationId : null
  const candidateBoot = runId === null
    ? null
    : bootFromTail?.detail?.runId === runId
      ? bootFromTail
      : runBoot?.detail?.runId === runId
        ? runBoot
        : null
  const candidateGenerationReady = runGenerationReady ?? [...events].reverse().find((entry) => entry.event === 'GENERATION_READY'
    && entry.detail?.id === generationId
    && entry.detail?.runId === runId) ?? null
  const runStartedAt = candidateBoot?.detail?.runId === runId ? Date.parse(candidateBoot.ts) : NaN
  const generationBound = runGenerationAnchorMatches(runMetadata, runId, generationId, candidateGenerationReady, candidateBoot)
  const generationStartedAt = generationBound ? parseTimestamp(candidateGenerationReady.ts) ?? NaN : NaN
  const runEvents = runId === null ? [] : events.filter((entry) => eventBelongsToRunGeneration(entry, {
    runId,
    generationId,
    generationStartedAt,
    generationBound,
  }))
  const relevantEvents = runEvents.filter((entry) => TRACE_EVENTS.has(entry.event)).slice(-60)
  const relevantVtrEvents = runEvents
    .filter((entry) => VTR_TRACE_EVENTS.has(entry.event)
      && (entry.source === 'vtr' || (entry.event === 'VTR_REACH_ROUTE_DECISION'
        && entry.source === undefined
        && entry.detail?.runId === runId
        && entry.detail?.generationId === generationId
        && typeof entry.detail?.sourceSha === 'string')))
    .map((entry) => entry.source === 'vtr' ? entry : { ...entry, source: 'vtr', projectionStream: 'buddy.log' })
  const boot = latestEvent(relevantEvents, ['BOOT'])
    ?? (runId !== null && runBoot?.detail?.runId === runId ? runBoot : null)
  const build = latestEvent(relevantEvents, ['BUILD'])
    ?? (runId !== null && runBuild?.detail?.runId === runId ? runBuild : null)
  const jev = latestEvent(relevantEvents, ['JEV_HEADS', 'TOOL_CHOICE'])
  const system2Input = latestEvent(relevantEvents, ['SYSTEM2_AUTHORITY_INPUT'])
  const system2Decision = latestEvent(relevantEvents, ['SYSTEM2_AUTHORITY_DECISION', 'SYSTEM2_STALE_DISCARD'])
  const mercury = latestEvent(relevantEvents, new Set([
    'MERCURY_ATTEMPT',
    'MERCURY_RETRY',
    'MERCURY_TRIGGER_BACKOFF',
    'MERCURY_TRIGGER_SUPPRESSED',
    'MERCURY_BUDGET_EXHAUSTED',
    'MERCURY_STALE_DISCARD',
    'MERCURY_FAILURE_STATE',
    'PLAN_REJECTED',
  ]))
  const latestActionEvent = latestEvent(relevantEvents, ['ACTION', 'ACTION_COMMIT', 'ACTION_PREEMPT', 'ACTION_UNVERIFIED'])
  const latestDeath = latestEvent(relevantEvents, ['DEATH'])
  const runtimeFailure = latestEvent(relevantEvents, ['FATAL', 'ERROR'])
  const queue = queueProjection(status)
  const current = queue.current
  const worldKey = data?.worldKey ?? status?.worldKey ?? boot?.detail?.worldKey ?? null
  const eventSourceSha = boot?.detail?.source ?? null
  const readySourceSha = candidateGenerationReady?.detail?.sourceSha ?? candidateGenerationReady?.detail?.source ?? null
  const artifactSourceSha = runMetadata?.sourceSha ?? null
  const sourceCandidates = [eventSourceSha, readySourceSha, artifactSourceSha]
    .filter((value) => value !== null && value !== undefined && value !== '')
  const sourceCandidatesValid = sourceCandidates.every((value) => typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value))
  const distinctSourceCandidates = [...new Set(sourceCandidates)]
  const sourceCommitConflict = runMetadata?.sourceShaConflict === true
    || !sourceCandidatesValid
    || distinctSourceCandidates.length > 1
  const sourceCommit = sourceCommitConflict || distinctSourceCandidates.length !== 1
    ? null
    : distinctSourceCandidates[0]
  const sourceCommitBinding = sourceCommit === null
    ? sourceCommitConflict ? 'conflict' : 'unknown'
    : eventSourceSha !== null && readySourceSha !== null && artifactSourceSha !== null ? 'run-BOOT+GENERATION_READY+acceptance+predicate-artifacts'
      : eventSourceSha !== null && readySourceSha !== null ? 'run-BOOT+GENERATION_READY'
        : eventSourceSha !== null && artifactSourceSha !== null ? 'run-BOOT+acceptance+predicate-artifacts'
          : artifactSourceSha !== null ? 'run-acceptance+predicate-artifacts'
            : 'run-BOOT-event'
  const vtr = projectVtrTransitions({
    events: relevantVtrEvents,
    runId,
    generationId,
    sourceCommit,
    worldKey,
    generationStartedAt: Number.isFinite(generationStartedAt) ? generationStartedAt : null,
  })
  let runtimeMission = null
  if (mission === null && vtr.latest?.mission !== null && vtr.latest?.mission !== undefined) {
    runtimeMission = {
      ...vtr.latest.mission,
      provenance: { source: 'VTR_TRANSITION_COMMIT.detail.mission', runId, generationId },
    }
  } else if (mission === null && candidateBoot?.detail?.mission !== undefined) {
    runtimeMission = {
      ...candidateBoot.detail.mission,
      provenance: { source: 'BOOT.detail.mission', runId, generationId },
    }
  }
  const missionProjection = projectMission(mission ?? runtimeMission, {
    runId,
    generationId,
    generationBound,
    sourceCommit,
  })
  const decisionEvidence = projectJevDecisionEvidence({
    jevCalls,
    choiceEvent: jev,
    events: relevantEvents,
    runId,
    runStartedAt: Number.isFinite(generationStartedAt) ? generationStartedAt : runStartedAt,
    worldKey,
    generationId,
  })
  const jevRecentFailures = projectJevProviderFailures({
    jevCalls,
    runId,
    runStartedAt: Number.isFinite(generationStartedAt) ? generationStartedAt : runStartedAt,
    worldKey,
    generationId,
    generationBound,
    boot,
    sourceCommit,
    sourceCommitConflict,
    modelAvailability: data?.modelAvailability ?? status?.modelAvailability ?? null,
    observedAt: now,
  })

  return {
    schemaVersion: 1,
    observedAt: new Date(now).toISOString(),
    resident: {
      available: data !== null,
      connected: data?.connected ?? false,
      frozen: data?.frozen ?? null,
      modelAvailability: data?.modelAvailability ?? status?.modelAvailability ?? null,
      runId,
      generationId,
      generationHash: data?.generationHash ?? build?.detail?.hash ?? null,
      worldKey,
      sourceCommit,
      sourceCommitBinding,
      sourceCommitConflict,
      generationBoundary: generationBound ? {
        event: 'GENERATION_READY',
        generationId,
        observedAt: candidateGenerationReady.ts,
        method: 'live-report+BOOT-runId/sourceSha+GENERATION_READY-runId/generationId/sourceSha',
        artifactGenerations: {
          acceptance: generationArtifactStatus(runMetadata?.acceptance, generationId),
          predicates: generationArtifactStatus(runMetadata?.predicates, generationId),
        },
        confidence: 'direct',
      } : null,
    },
    mission: missionProjection,
    goal: {
      frontier: status?.rungId ?? data?.milestone ?? null,
      frontierIndex: status?.rungIndex ?? null,
      queue,
    },
    milestones: milestonePredicateProjection(status?.milestonePredicates),
    worldMemory: pickFields(data?.worldMemory, [
      'craftingTables', 'furnaces', 'discoveredOres', 'traversalFailures', 'knownTraversals', 'hazards', 'hardHazards',
    ]),
    option: current === null ? null : {
      intent: current.semanticOptionIntent ?? current.description,
      templateId: current.semanticOptionTemplateId,
      instanceId: current.semanticOptionInstanceId,
    },
    action: status?.currentAction ?? null,
    truth: status?.truth ?? null,
    authority: {
      policy: status === null ? null : {
        kind: status.policyKind ?? null,
        provider: status.policyProvider ?? null,
        model: status.policyModel ?? null,
      },
      system2: status === null ? null : {
        configured: status.system2AuthorityStack ?? null,
        last: status.system2LastAuthority ?? {
          provider: status.system2Provider ?? null,
          model: status.system2Model ?? null,
        },
      },
      jevRecentFailures,
      deterministicFallbackEnabled: status?.deterministicFallbackEnabled ?? null,
    },
    decisionTrace: {
      jev: traceProjection(jev),
      jevEvidence: decisionEvidence,
      system2Input: traceProjection(system2Input),
      system2Decision: traceProjection(system2Decision),
      mercury: traceProjection(mercury),
      action: traceProjection(latestActionEvent),
      death: traceProjection(latestDeath),
      vtr: vtr.latest === null ? null : {
        transitionId: vtr.latest.transitionId,
        contractHash: vtr.latest.contractHash,
        status: vtr.latest.status,
        verification: vtr.latest.verification,
        outcome: vtr.latest.outcome,
        modelMetrics: vtr.latest.modelMetrics,
      },
    },
    vtr,
    runtimeFailure: traceProjection(runtimeFailure),
    events: relevantEvents.slice(-30).reverse().map(traceProjection),
  }
}

function parseTimestamp(value) {
  const timestamp = Date.parse(value ?? '')
  return Number.isFinite(timestamp) ? timestamp : null
}

function parsePosition(value) {
  if (value !== null && typeof value === 'object') return pickFields(value, ['x', 'y', 'z'])
  if (typeof value !== 'string') return null
  const match = /^\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\s*$/.exec(value)
  if (match === null) return null
  return { x: Number(match[1]), y: Number(match[2]), z: Number(match[3]) }
}

function normalizeDimension(value) {
  if (typeof value !== 'string' || value.length === 0) return null
  return value.includes(':') ? value : `minecraft:${value}`
}

function pickFields(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return Object.fromEntries(keys
    .filter((key) => value[key] !== undefined)
    .map((key) => [key, redactSecrets(value[key])]))
}

function boundedEntries(value, limit, project) {
  if (!Array.isArray(value)) return []
  return value.slice(0, limit).map(project)
}

function projectAnswer(answer) {
  if (answer === null || typeof answer !== 'object') return null
  const probabilities = answer.probabilities !== null && typeof answer.probabilities === 'object'
    ? Object.entries(answer.probabilities)
      .filter(([, probability]) => typeof probability === 'number' && Number.isFinite(probability))
      .sort((left, right) => right[1] - left[1])
      .slice(0, 12)
      .map(([id, probability]) => ({ id, probability }))
    : []
  return {
    value: answer.value ?? null,
    probability: answer.probability ?? null,
    confidence: answer.confidence ?? null,
    probabilities,
    note: answer.note ?? null,
  }
}

const CANDIDATE_META_FIELDS = [
  'distance', 'weapon', 'weaponKind', 'weaponDamage', 'targetHostile', 'hostile', 'attackable',
  'targetLineOfSight', 'targetKind', 'reachability', 'separation', 'separationGain', 'outsideReach',
  'threatName', 'threatDistance', 'threatStandoff', 'threatOccluded', 'targetEntityId', 'threatEntityId',
  'safe', 'diggable', 'toolReason', 'missingCapability', 'capabilityAcquisition', 'digRouteReason',
  'digRouteKind', 'digRouteTarget', 'digRouteFrom', 'digRouteTo', 'hasAdjacentStandable',
]

function projectCandidate(candidate) {
  if (candidate === null || typeof candidate !== 'object') return null
  const meta = pickFields(candidate.meta, CANDIDATE_META_FIELDS)
  return {
    id: candidate.id ?? null,
    kind: candidate.kind ?? null,
    label: candidate.label ?? null,
    target: candidate.target ?? null,
    targetName: candidate.targetName ?? null,
    meta: meta !== null && Object.keys(meta).length > 0 ? meta : null,
  }
}

function projectInventory(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const entries = Object.entries(value).slice(0, 48)
  return {
    counts: Object.fromEntries(entries.map(([name, count]) => [name, count])),
    truncated: Object.keys(value).length > entries.length,
  }
}

function projectKnownResource(resource) {
  return pickFields(resource, ['name', 'kind', 'position', 'dimension', 'worldEpoch'])
}

function projectNearbyBlock(block) {
  return pickFields(block, [
    'kind', 'name', 'position', 'distance', 'diggable', 'inReach', 'hasAdjacentStandable',
    'adjacentStandable', 'yield', 'harvestTool', 'harvestTier',
  ])
}

function projectNearbyEntity(entity) {
  return pickFields(entity, [
    'id', 'name', 'kind', 'position', 'distance', 'hostile', 'lineOfSight', 'heldItem', 'health', 'attackedSelf',
  ])
}

function projectDecisionState(state) {
  const world = state?.semantic?.world ?? state?.world ?? null
  const signals = state?.signals ?? {}
  const goal = state?.goal ?? null
  const currentOption = state?.currentOption ?? null
  const candidates = Array.isArray(state?.candidates) ? state.candidates : []
  const knownStructures = signals.knownStructures ?? signals.structures ?? state?.knownStructures ?? null
  const structuresObserved = knownStructures !== null
  const structures = Array.isArray(knownStructures)
    ? knownStructures.slice(0, 12).map((structure) => typeof structure === 'string' ? structure : pickFields(structure, [
      'id', 'name', 'kind', 'type', 'position', 'dimension', 'worldEpoch', 'distance', 'verified', 'source', 'lastSeenAt',
    ]))
    : knownStructures !== null && typeof knownStructures === 'object'
      ? Object.entries(knownStructures).slice(0, 12).map(([name, value]) => ({
        name,
        value: value !== null && typeof value === 'object'
          ? pickFields(value, ['id', 'kind', 'type', 'position', 'dimension', 'worldEpoch', 'distance', 'verified', 'source', 'lastSeenAt'])
          : value,
      }))
      : knownStructures === null ? null : [knownStructures]
  return {
    world: pickFields(world, ['dimension', 'worldEpoch', 'generationId', 'alive', 'leaseHeld']),
    self: pickFields(state?.self, [
      'position', 'dimension', 'health', 'food', 'air', 'feetInWater', 'eyesInWater', 'envHazard',
      'lastDamage', 'heldItem', 'equipment', 'armor', 'offhand',
    ]),
    // Air and drowning are also available as raw self facts above. Keep the
    // actual Jev semantic bands beside them so the observer shows exactly what
    // the model was given, including airBand=unknown.
    safety: pickFields(state?.semantic?.safety, ['airBand', 'submerged']),
    inventory: projectInventory(state?.inventory),
    goal: pickFields(goal, ['id', 'description', 'targetItem', 'requiredCount', 'startCount', 'haveCount', 'progress', 'complete']),
    goalQueue: pickFields(state?.goalQueue, ['depth', 'empty']),
    currentOption: pickFields(currentOption, ['instanceId', 'templateId', 'semanticInstanceId', 'semanticTemplateId', 'semanticIntent', 'kind', 'target', 'preconditions', 'success', 'allowedSkills', 'abortThreshold', 'runtime']),
    progress: {
      have: goal?.haveCount ?? null,
      required: goal?.requiredCount ?? null,
      fraction: typeof goal?.haveCount === 'number' && typeof goal?.requiredCount === 'number' && goal.requiredCount > 0
        ? Math.min(1, goal.haveCount / goal.requiredCount)
        : null,
      complete: goal?.complete ?? null,
      strategicNonProgress: pickFields(signals.strategicNonProgress, [
        'optionInstanceId', 'windowSize', 'distinctStates', 'bodyProgressDecisions', 'semanticProgressDecisions',
        'horizon', 'maxDistinctStates', 'exhausted', 'exhaustedRepeats',
      ]),
      oscillationsDetected: signals.oscillationsDetected ?? null,
      consecutiveFailures: signals.consecutiveFailures ?? null,
      lastFailureCode: signals.lastFailureCode ?? null,
      lastPathStatus: signals.lastPathStatus ?? null,
      escalationRecommended: signals.escalationRecommended ?? null,
    },
    threat: {
      status: signals.threat !== null && typeof signals.threat === 'object' ? 'observed' : 'not_recorded',
      active: signals.threat?.active ?? null,
      inDanger: signals.threat?.inDanger ?? null,
      inContact: signals.threat?.inContact ?? null,
      hostileCount: signals.threat?.hostileCount ?? null,
      primary: pickFields(signals.threat, [
        'threatId', 'threatName', 'threatDistance', 'threatHeldItem', 'threatEngaged', 'threatLineOfSight',
        'entryReason', 'exitReason', 'activeMs', 'clearForMs',
      ]),
      nearbyHostilesStatus: Array.isArray(state?.nearestEntities) ? 'observed' : 'not_recorded',
      nearbyEntityCount: Array.isArray(state?.nearestEntities) ? state.nearestEntities.length : null,
      nearbyHostiles: boundedEntries(
        Array.isArray(state?.nearestEntities) ? state.nearestEntities.filter((entity) => entity?.hostile === true) : [],
        12,
        projectNearbyEntity,
      ),
    },
    resources: {
      knownStatus: Array.isArray(signals.knownResources) ? 'observed' : 'not_recorded',
      knownCount: Array.isArray(signals.knownResources) ? signals.knownResources.length : null,
      known: boundedEntries(signals.knownResources, 16, projectKnownResource),
      nearbyBlocksStatus: Array.isArray(state?.nearestBlocks) ? 'observed' : 'not_recorded',
      nearbyBlocks: boundedEntries(state?.nearestBlocks, 12, projectNearbyBlock),
    },
    structures: {
      status: structuresObserved ? 'observed' : 'not_recorded',
      count: Array.isArray(knownStructures) || (knownStructures !== null && typeof knownStructures === 'object')
        ? Object.keys(knownStructures).length
        : structuresObserved ? 1 : null,
      known: structures,
      truncated: structuresObserved && typeof knownStructures === 'object' && Object.keys(knownStructures).length > 12,
      source: structuresObserved ? 'jev-state' : null,
    },
    recentOutcomes: boundedEntries(state?.recentOutcomes?.slice?.(-6), 6, (outcome) => pickFields(outcome, [
      'actionId', 'candidateId', 'verified', 'status', 'progressDelta', 'failureCode', 'generationId', 'chainId',
    ])),
    candidates,
  }
}

function outcomeEvidenceForChoice(choiceEvent, events) {
  if (choiceEvent === null) return null
  const detail = choiceEvent.detail ?? {}
  const choiceTime = parseTimestamp(choiceEvent.ts)
  const actionId = detail.action ?? detail.actionId ?? null
  const directChainId = typeof detail.chainId === 'string' ? detail.chainId : null
  const generationMatches = (entry) => (entry.detail?.generationId ?? null) === (detail.generationId ?? null)
  const later = (entry) => {
    const timestamp = parseTimestamp(entry.ts)
    return choiceTime !== null && timestamp !== null && timestamp >= choiceTime && timestamp - choiceTime <= 60_000
  }
  const matchesAction = (entry) => entry.detail?.actionId === actionId
    && generationMatches(entry)
    && later(entry)
  const causalCandidates = events.filter((entry) => entry.event === 'CAUSAL'
    && (directChainId !== null
      ? entry.detail?.chainId === directChainId
      : entry.detail?.actionId === actionId && entry.detail?.candidateId === actionId)
    && generationMatches(entry)
    && later(entry))
    .sort((left, right) => (parseTimestamp(left.ts) ?? 0) - (parseTimestamp(right.ts) ?? 0))
  const causal = causalCandidates[0] ?? null
  const causalTime = parseTimestamp(causal?.ts)
  const nearestLifecycle = (name) => [...events].reverse().find((entry) => entry.event === name
    && matchesAction(entry)
    && (causalTime === null || Math.abs((parseTimestamp(entry.ts) ?? 0) - causalTime) <= 5_000))
  const skillEnd = nearestLifecycle('SKILL_END')
  const outcomePacket = nearestLifecycle('SKILL_OUTCOME_PACKET')
  const skillEndAt = parseTimestamp(skillEnd?.ts)
  const outcomeAt = parseTimestamp(outcomePacket?.ts)
  const leaseRevoked = skillEnd?.detail?.outcome === 'LEASE_REVOKED'
    || outcomePacket?.detail?.terminalReason === 'lease_revoked'
  const terminalAt = Math.max(skillEndAt ?? 0, outcomeAt ?? 0) || null
  // A model outage and a lease-revoked skill are separate emitted facts. Link
  // them only when both refer to the same generation and the outage event falls
  // between this choice and its observed lease-revoked terminal event. This is
  // a useful causal lead for operators, but remains explicitly inferred because
  // MODEL_UNAVAILABLE does not carry the selected action's chainId.
  const alreadyCompleted = causal?.detail?.verified === true && causal?.detail?.status === 'done'
  const interruptionEvent = leaseRevoked && !alreadyCompleted && terminalAt !== null
    && typeof detail.generationId === 'string'
    ? events.filter((entry) => entry.event === 'MODEL_UNAVAILABLE'
      && entry.detail?.action === 'stop-generation-for-recovery'
      && generationMatches(entry)
      && later(entry)
      && (parseTimestamp(entry.ts) ?? Number.POSITIVE_INFINITY) <= terminalAt)
      .sort((left, right) => (parseTimestamp(left.ts) ?? 0) - (parseTimestamp(right.ts) ?? 0))
      .at(-1) ?? null
    : null
  const interruptionAt = parseTimestamp(interruptionEvent?.ts)
  const interruption = interruptionEvent === null ? null : {
    event: traceProjection(interruptionEvent),
    relationship: 'same_generation_provider_stop_preceded_lease_revoked_skill',
    binding: {
      method: 'generationId+event-order',
      confidence: 'inferred',
      millisecondsBeforeSkillEnd: skillEndAt === null || interruptionAt === null ? null : Math.max(0, skillEndAt - interruptionAt),
    },
  }
  const pickupEvidenceCandidates = typeof actionId === 'string' && actionId.startsWith('PICKUP:')
    ? events.filter((entry) => ['PICKUP_ACQUIRED', 'PICKUP_NOT_ACQUIRED'].includes(entry.event) && matchesAction(entry))
    : []
  const pickupEvidence = pickupEvidenceCandidates.at(-1) ?? null
  return {
    chainId: directChainId,
    actionId,
    generationId: detail.generationId ?? null,
    joinMethod: directChainId === null ? 'action+generation+nearest-timestamp' : 'chainId',
    joinConfidence: causal !== null && directChainId !== null ? 'exact' : causal !== null || skillEnd != null || outcomePacket != null ? 'inferred' : 'unknown',
    causal: traceProjection(causal ?? null),
    skillEnd: traceProjection(skillEnd ?? null),
    skillOutcome: traceProjection(outcomePacket ?? null),
    interruption,
    pickupEvidence: traceProjection(pickupEvidence),
    pickupEvidenceMatchCount: pickupEvidenceCandidates.length,
    pickupEvidenceBinding: pickupEvidence !== null
      ? { method: 'actionId+generationId+post-choice timestamp', confidence: 'inferred' }
      : null,
    status: causal !== null ? 'causal_observed' : interruption !== null ? 'provider_interrupted' : skillEnd != null || outcomePacket != null ? 'skill_observed' : pickupEvidence !== null ? 'pickup_observed' : 'pending_or_not_observed',
  }
}

/** A compact, evidence-only comparison of Jev's combat choices and context. */
function projectCombatDecision(jevEvidence) {
  if (jevEvidence?.available !== true || jevEvidence.state === null || typeof jevEvidence.state !== 'object') {
    return { status: 'unknown', reason: 'jev_decision_context_unavailable' }
  }
  const state = jevEvidence.state
  const threat = state.threat ?? {}
  const selectedId = jevEvidence.answer?.action?.value ?? null
  const rankedAlternatives = (jevEvidence.alternatives ?? []).map((entry) => ({
    id: entry.id,
    kind: entry.candidate?.kind ?? null,
    probability: entry.probability,
    selected: entry.selected === true,
    label: entry.candidate?.label ?? null,
  }))
  const probabilityById = new Map((jevEvidence.answer?.action?.probabilities ?? [])
    .filter((entry) => typeof entry.id === 'string')
    .map((entry) => [entry.id, entry.probability]))
  const candidateById = new Map()
  for (const candidate of state.candidates ?? []) {
    if (candidate?.id !== undefined) candidateById.set(candidate.id, candidate)
  }
  for (const entry of jevEvidence.alternatives ?? []) {
    if (entry.id !== undefined && entry.candidate !== null) candidateById.set(entry.id, entry.candidate)
  }
  const alternatives = [...candidateById.values()]
    .filter((candidate) => candidate?.kind === 'ATTACK' || candidate?.kind === 'RETREAT')
    .map((candidate) => ({
      id: candidate.id,
      kind: candidate.kind,
      probability: probabilityById.get(candidate.id) ?? null,
      selected: candidate.id === selectedId,
      label: candidate.label ?? null,
      target: candidate.target ?? null,
      meta: candidate.meta ?? null,
    }))
  const selectedAlternative = alternatives.find((entry) => entry.id === selectedId) ?? null
  const selectedCandidate = selectedAlternative
    ?? (state.candidates ?? []).find((candidate) => candidate?.id === selectedId)
    ?? (jevEvidence.selectedCandidate?.id === selectedId ? jevEvidence.selectedCandidate : null)
  const offeredCandidates = state.candidates ?? []
  const kindCounts = Object.fromEntries([...new Set(offeredCandidates.map((candidate) => candidate.kind).filter(Boolean))]
    .map((kind) => [kind, offeredCandidates.filter((candidate) => candidate.kind === kind).length]))
  const context = {
    observedAt: jevEvidence.observedAt ?? null,
    world: pickFields(state.world, ['dimension', 'worldEpoch', 'generationId']),
      // Keep the exact bounded defensive equipment facts beside the choice so
      // reviewers can see whether Jev knew about worn armor/offhand shielding.
      // This is observation only; it does not alter candidate eligibility or
      // preference probabilities.
      self: pickFields(state.self, [
        'position', 'dimension', 'health', 'food', 'air', 'feetInWater', 'eyesInWater', 'envHazard',
        'heldItem', 'equipment', 'armor', 'offhand',
      ]),
    safety: state.safety ?? null,
    objective: {
      goal: state.goal ?? null,
      progress: state.progress ?? null,
    },
    threat: {
      status: threat.status ?? 'not_recorded',
      active: threat.active ?? null,
      inDanger: threat.inDanger ?? null,
      inContact: threat.inContact ?? null,
      hostileCount: threat.hostileCount ?? null,
      primary: threat.primary ?? null,
      nearbyHostiles: boundedEntries(threat.nearbyHostiles, 6, projectNearbyEntity),
      nearbyHostilesTruncated: (threat.nearbyHostiles?.length ?? 0) > 6,
    },
    safetyEstimate: {
      danger: pickFields(jevEvidence.answer?.otherHeads?.danger, ['value', 'probability', 'confidence', 'probabilities']),
      shouldRetreat: pickFields(jevEvidence.answer?.otherHeads?.should_retreat, ['value', 'probability', 'confidence', 'probabilities']),
    },
    selection: {
      actionId: selectedId,
      kind: selectedCandidate?.kind ?? null,
      probability: selectedAlternative?.probability ?? probabilityById.get(selectedId) ?? null,
      confidence: jevEvidence.answer?.action?.confidence ?? null,
      modelRationale: { status: jevEvidence.rationale?.status ?? 'not_emitted', text: jevEvidence.rationale?.text ?? null },
    },
    candidateSet: {
      offeredCount: state.candidateCount ?? offeredCandidates.length,
      projectedCount: offeredCandidates.length,
      kindCounts,
      truncated: state.candidatesTruncated === true,
    },
  }
  if (alternatives.length === 0) {
    return {
      status: state.candidatesTruncated === true
        ? 'partial'
        : threat.status === 'observed' ? 'no_combat_action_offered' : 'unknown',
      ...context,
      reason: state.candidatesTruncated === true
        ? 'bounded_candidate_projection_may_omit_combat_actions'
        : 'no_attack_or_retreat_candidate_in_recorded_choice_set',
      otherRankedAlternatives: rankedAlternatives.filter((entry) => entry.kind !== 'ATTACK' && entry.kind !== 'RETREAT'),
      probabilityMeaning: 'model preference among offered candidates; not a probability of combat success',
    }
  }
  return {
    status: threat.status === 'observed' ? 'observed' : 'partial',
    ...context,
    alternatives,
    otherRankedAlternatives: rankedAlternatives.filter((entry) => entry.kind !== 'ATTACK' && entry.kind !== 'RETREAT'),
    candidateSetTruncated: state.candidatesTruncated === true,
    probabilityMeaning: 'model preference among offered candidates; not a probability of combat success',
  }
}

/** Join one successful Jev evaluation to a resident choice without inventing rationale. */
export function projectJevDecisionEvidence({ jevCalls = [], choiceEvent = null, events = [], runId = null, runStartedAt = NaN, worldKey = null, generationId = null }) {
  if (choiceEvent === null || !['JEV_HEADS', 'TOOL_CHOICE'].includes(choiceEvent?.event)) return null
  const choiceAt = parseTimestamp(choiceEvent.ts)
  const startedAt = Number.isFinite(runStartedAt) ? runStartedAt : null
  const choiceGenerationId = choiceEvent.detail?.generationId ?? null
  if (generationId !== null && choiceGenerationId !== null && choiceGenerationId !== generationId) return null
  if (choiceAt === null || startedAt === null || choiceAt < startedAt) return null
  const expectedDimension = normalizeDimension(worldKey?.dimension)
  const expectedEpoch = worldKey?.worldEpoch ?? null
  const candidates = jevCalls.filter((call) => {
    if (call?.record !== 'jev-call' || call.error !== null && call.error !== undefined) return false
    if (call.response?.answers?.action?.value === undefined) return false
    const at = parseTimestamp(call.ts)
    if (at === null || startedAt === null || at < startedAt) return false
    const state = call.state ?? {}
    const callWorld = state.semantic?.world ?? state.world ?? {}
    if (expectedEpoch !== null && callWorld.worldEpoch !== expectedEpoch) return false
    if (expectedDimension !== null && normalizeDimension(callWorld.dimension ?? state.self?.dimension) !== expectedDimension) return false
    const callGenerationId = call.generationId ?? callWorld.generationId ?? null
    if (generationId !== null && callGenerationId !== null && callGenerationId !== generationId) return false
    return true
  })
  const selectedAction = choiceEvent.event === 'TOOL_CHOICE'
    ? choiceEvent.detail?.actionId ?? null
    : choiceEvent.detail?.action ?? null
  const matching = candidates
    .filter((call) => call.response?.answers?.action?.value === selectedAction)
    .map((call) => ({ call, at: parseTimestamp(call.ts) }))
    .filter(({ at }) => choiceAt !== null && at !== null && Math.abs(at - choiceAt) <= 15_000)
    .sort((left, right) => Math.abs((left.at ?? 0) - (choiceAt ?? 0)) - Math.abs((right.at ?? 0) - (choiceAt ?? 0)))
  const match = matching[0] ?? null
  const fallback = candidates
    .map((call) => ({ call, at: parseTimestamp(call.ts) }))
    .sort((left, right) => (right.at ?? 0) - (left.at ?? 0))[0] ?? null
  const selected = match ?? fallback
  if (selected === null) return {
    available: false,
    binding: { runId, directRunId: false, confidence: 'unknown', reason: 'no_successful_same-run Jev call matched the active world epoch and dimension in the bounded log tail' },
    outcome: outcomeEvidenceForChoice(choiceEvent, events),
  }

  const call = selected.call
  const state = projectDecisionState(call.state ?? {})
  const answer = projectAnswer(call.response?.answers?.action)
  const selectedCandidate = state.candidates.find((candidate) => candidate?.id === answer?.value) ?? null
  const candidateById = new Map(state.candidates.filter((candidate) => typeof candidate?.id === 'string').map((candidate) => [candidate.id, candidate]))
  const alternatives = answer?.probabilities.map(({ id, probability }) => ({
    id,
    probability,
    selected: id === answer.value,
    candidate: projectCandidate(candidateById.get(id) ?? null),
  })) ?? []
  const callAt = parseTimestamp(call.ts)
  const deltaMs = choiceAt === null || callAt === null ? null : Math.abs(choiceAt - callAt)
  const actionMatches = match !== null
  const callWorld = call.state?.semantic?.world ?? call.state?.world ?? {}
  const callGenerationId = call.generationId ?? callWorld.generationId ?? null
  const confidence = actionMatches && deltaMs !== null && deltaMs <= 2_000
    ? callGenerationId === generationId && generationId !== null ? 'strong' : 'inferred'
    : 'partial'
  return redactSecrets({
    available: true,
    observedAt: call.ts,
    callId: call.callId ?? null,
    policy: call.policy ?? null,
    model: call.model ?? null,
    stage: call.stage ?? null,
    latencyMs: call.latencyMs ?? null,
    error: call.error ?? null,
    binding: {
      runId,
      directRunId: false,
      choiceEvent: choiceEvent.event,
      choiceGenerationId,
      callGenerationId,
      method: 'GENERATION_READY-window+world-epoch+dimension+selected-action+timestamp',
      confidence,
      choiceAction: selectedAction,
      callAction: answer?.value ?? null,
      sameAction: actionMatches,
      timestampDeltaMs: deltaMs,
      generationJoin: callGenerationId !== null && callGenerationId === generationId ? 'direct' : 'ready-window-inferred',
      worldEpoch: state.world?.worldEpoch ?? null,
      dimension: state.world?.dimension ?? null,
      generationIdObservedInCall: state.world?.generationId ?? null,
    },
    answer: {
      action: answer,
      abandonOption: projectAnswer(call.response?.answers?.abandon_option),
      otherHeads: Object.fromEntries(Object.entries(call.response?.answers ?? {})
        .filter(([name]) => !['action', 'abandon_option'].includes(name))
        .map(([name, value]) => [name, projectAnswer(value)])),
    },
    selectedCandidate: projectCandidate(selectedCandidate),
    alternatives,
    state: {
      ...state,
      candidateCount: state.candidates.length,
      candidates: boundedEntries(state.candidates, 20, projectCandidate),
      candidatesTruncated: state.candidates.length > 20,
    },
    outcome: outcomeEvidenceForChoice(choiceEvent, events),
    rationale: { status: 'not_emitted', text: null },
  })
}

const SAFE_PROVIDER_DIAGNOSTIC_HEADERS = new Set([
  'x-vercel-id', 'x-vercel-request-id', 'x-request-id', 'request-id', 'x-typesafe-request-id', 'requestid',
])

function safeProviderDiagnosticToken(value, maxLength = 80) {
  if (typeof value !== 'string') return null
  const token = value.trim()
  if (token.length === 0 || token.length > maxLength || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(token)) return null
  if (/(?:bearer|token|secret|password|authorization|api.?key)/i.test(token)) return null
  if (/^(?:sk|pk|rk|sess|gh[pousr])[-_]/i.test(token) || /^[A-Fa-f0-9]{32,}$/.test(token)) return null
  return token
}

function projectProviderDiagnostics(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const result = {}
  const status = value.httpStatus
  if (Number.isInteger(status) && status >= 100 && status <= 599) result.httpStatus = status
  for (const key of ['providerErrorCode', 'providerErrorType', 'errorName']) {
    const token = safeProviderDiagnosticToken(value[key])
    if (token !== null) result[key] = token
  }
  const header = typeof value.requestIdHeader === 'string' ? value.requestIdHeader.toLowerCase() : null
  const requestId = safeProviderDiagnosticToken(value.requestId, 160)
  if (header !== null && SAFE_PROVIDER_DIAGNOSTIC_HEADERS.has(header) && requestId !== null) {
    result.requestId = requestId
    result.requestIdHeader = header
  }
  return Object.keys(result).length === 0 ? null : result
}

/**
 * Surface bounded transport failures to the observer without reading prompts,
 * request bodies, or arbitrary provider headers. Jev JSONL has no direct runId.
 * Prefer the active generation boundary; while the host is in model-recovery
 * backoff and has no active generation, permit only a run-window join bound by
 * the current BOOT runId/source plus the host's Jev lastFailure record.
 */
export function projectJevProviderFailures({
  jevCalls = [], runId = null, runStartedAt = NaN, worldKey = null, generationId = null,
  generationBound = false, boot = null, sourceCommit = null, sourceCommitConflict = false,
  modelAvailability = null, observedAt = Date.now(),
} = {}) {
  const startAt = Number.isFinite(runStartedAt) ? runStartedAt : null
  if (startAt === null) return []
  const activeGenerationBound = generationBound === true && typeof generationId === 'string' && generationId.length > 0
  const failed = modelAvailability?.lastFailure ?? null
  const bootSourceSha = boot?.detail?.source ?? boot?.detail?.sourceSha ?? null
  const runWindowBound = !activeGenerationBound
    && modelAvailability?.state === 'degraded'
    && typeof runId === 'string'
    && boot?.event === 'BOOT'
    && boot.detail?.runId === runId
    && typeof sourceCommit === 'string'
    && /^[0-9a-f]{40}$/i.test(sourceCommit)
    && sourceCommitConflict !== true
    && bootSourceSha === sourceCommit
    && failed !== null
    && (failed.authorityKind === 'jev' || failed.context === 'jev-authority')
    && (failed.sourceSha === null || failed.sourceSha === undefined || failed.sourceSha === sourceCommit)
  if (!activeGenerationBound && !runWindowBound) return []

  const expectedDimension = normalizeDimension(worldKey?.dimension)
  const expectedEpoch = worldKey?.worldEpoch ?? null
  const failedGenerationId = typeof failed?.generationId === 'string' && failed.generationId.length > 0
    ? failed.generationId
    : null
  const failureAt = parseTimestamp(failed?.ts)
  if (runWindowBound && failed.authority?.provider !== undefined && failed.authority.provider !== 'typesafe-ai') return []
  if (runWindowBound && failedGenerationId === null && failureAt === null) return []
  return jevCalls
    .filter((call) => {
      if (call?.record !== 'jev-call' || typeof call.error !== 'string' || call.error.length === 0) return false
      const at = parseTimestamp(call.ts)
      if (at === null || at < startAt || at > observedAt) return false
      const callWorld = call.state?.semantic?.world ?? call.state?.world ?? {}
      const callGenerationId = call.generationId ?? callWorld.generationId ?? null
      if (activeGenerationBound) {
        if (expectedEpoch !== null && callWorld.worldEpoch !== expectedEpoch) return false
        if (expectedDimension !== null && normalizeDimension(callWorld.dimension ?? call.state?.self?.dimension) !== expectedDimension) return false
        if (callGenerationId !== null && callGenerationId !== generationId) return false
      } else {
        // Old Jev records can lack generationId. If one is present it must name
        // the generation HOST recorded as failed; the host timestamp bounds the
        // call to the outage window when older records lack generationId.
        if (callGenerationId !== null && failedGenerationId !== null && callGenerationId !== failedGenerationId) return false
        if (failureAt !== null && (at > failureAt + 5_000 || failureAt - at > 120_000)) return false
        if (typeof failed.authority?.model === 'string' && call.model !== failed.authority.model) return false
        if (expectedEpoch !== null && callWorld.worldEpoch !== undefined && callWorld.worldEpoch !== expectedEpoch) return false
        const callDimension = normalizeDimension(callWorld.dimension ?? call.state?.self?.dimension)
        if (expectedDimension !== null && callDimension !== null && callDimension !== expectedDimension) return false
      }
      return true
    })
    .sort((left, right) => (parseTimestamp(left.ts) ?? 0) - (parseTimestamp(right.ts) ?? 0))
    .slice(-5)
    .map((call) => {
      const callWorld = call.state?.semantic?.world ?? call.state?.world ?? {}
      const callGenerationId = call.generationId ?? callWorld.generationId ?? null
      const providerDiagnostics = projectProviderDiagnostics(call.providerDiagnostics)
      return redactSecrets({
        observedAt: call.ts,
        callId: call.callId ?? null,
        provider: 'typesafe-ai',
        model: call.model ?? null,
        stage: call.stage ?? null,
        latencyMs: Number.isFinite(call.latencyMs) ? call.latencyMs : null,
        retryable: call.retryable === true,
        error: call.error.slice(0, 320),
        providerDiagnostics,
        binding: {
          runId,
          generationId,
          failedGenerationId: activeGenerationBound ? null : failedGenerationId,
          callGenerationId,
          worldEpoch: callWorld.worldEpoch ?? null,
          dimension: normalizeDimension(callWorld.dimension ?? call.state?.self?.dimension),
          confidence: callGenerationId !== null && callGenerationId === (activeGenerationBound ? generationId : failedGenerationId)
            ? 'direct'
            : activeGenerationBound ? 'generation-window-inferred' : 'run-window-inferred',
          method: activeGenerationBound
            ? 'GENERATION_READY-window+world-epoch+dimension'
            : 'BOOT-runId+sourceSha+lastFailure+run-window+world-epoch+dimension-when-observed',
        },
      })
    })
}

function latestProjectedEvent(snapshot, names) {
  const accepted = new Set(names)
  const entries = (snapshot.events ?? []).filter((entry) => accepted.has(entry.event))
  entries.sort((left, right) => (parseTimestamp(right.ts) ?? 0) - (parseTimestamp(left.ts) ?? 0))
  return entries[0] ?? null
}

function projectChoice(entry, actor, reasonEvent = null) {
  if (entry === null) return null
  const detail = entry.detail ?? {}
  let selected = null
  let controller = null
  if (entry.event === 'JEV_HEADS') {
    selected = { kind: 'action', id: detail.action ?? null }
    controller = {
      abandonProbability: detail.abandon ?? null,
      decision: detail.decision ?? null,
      abandonRequested: detail.abandonRequested ?? null,
      abandonEnforced: detail.abandonEnforced ?? null,
      betaAuthority: detail.betaAuthority ?? null,
      betaShadowed: detail.betaShadowed ?? null,
    }
  } else if (entry.event === 'TOOL_CHOICE') {
    selected = {
      kind: 'tool',
      actionId: detail.actionId ?? null,
      toolName: detail.toolName ?? null,
      tier: detail.tier ?? null,
    }
  } else {
    selected = {
      operation: detail.op ?? null,
      strategy: detail.strategy ?? null,
      chosen: detail.chosen ?? null,
      goals: Array.isArray(detail.goals) ? detail.goals : null,
    }
  }
  const reasonDetail = reasonEvent?.detail ?? null
  return {
    observedAt: entry.ts,
    actor,
    event: entry.event,
    selected,
    trigger: detail.trigger ?? reasonDetail?.trigger ?? null,
    reason: detail.reason ?? reasonDetail?.reason ?? null,
    reasonEvidenceEvent: detail.reason !== undefined || reasonDetail?.reason !== undefined ? reasonEvent?.event ?? entry.event : null,
    generationId: detail.generationId ?? null,
    chainId: detail.chainId ?? null,
  }
}

/** Compact, machine-oriented view of recorded choices and their observed context. */
export function buildAiSummary(snapshot, { now = Date.now() } = {}) {
  const jevEvent = latestProjectedEvent(snapshot, ['JEV_HEADS', 'TOOL_CHOICE'])
  const system2Event = latestProjectedEvent(snapshot, ['SYSTEM2_AUTHORITY_DECISION'])
  const system2Input = latestProjectedEvent(snapshot, ['SYSTEM2_AUTHORITY_INPUT'])
  const inputAt = parseTimestamp(system2Input?.ts)
  const decisionAt = parseTimestamp(system2Event?.ts)
  const system2Reason = system2Input !== null
    && system2Event !== null
    && inputAt !== null
    && decisionAt !== null
    && inputAt <= decisionAt
    && decisionAt - inputAt <= 5 * 60 * 1000
    && system2Input.detail?.trigger === system2Event.detail?.trigger
    && system2Input.detail?.provider === system2Event.detail?.provider
    && system2Input.detail?.model === system2Event.detail?.model
    ? system2Input
    : null
  const jev = projectChoice(jevEvent, 'jev')
  const system2 = projectChoice(system2Event, 'system2', system2Reason)
  const vtrDecision = snapshot.vtr?.latestDecision ?? null
  const jevReachRouteDecision = snapshot.vtr?.latestRouteDecision?.source === 'jev'
    ? snapshot.vtr.latestRouteDecision
    : null
  const latestIsVtrReachRouteDecision = vtrDecision?.event === 'VTR_REACH_ROUTE_DECISION'
  const latest = [jev, system2, vtrDecision]
    .filter((choice) => choice !== null)
    .sort((left, right) => (parseTimestamp(right.observedAt) ?? 0) - (parseTimestamp(left.observedAt) ?? 0))[0] ?? null
  const actionEvent = latestProjectedEvent(snapshot, ['ACTION', 'ACTION_COMMIT', 'ACTION_PREEMPT', 'ACTION_UNVERIFIED'])
  const actionOutcomeEvent = latestProjectedEvent(snapshot, ['ACTION_COMMIT', 'ACTION_PREEMPT', 'ACTION_UNVERIFIED', 'PLAN_REJECTED'])
  const heartbeat = latestProjectedEvent(snapshot, ['HEARTBEAT'])
  const latestRuntimeFailure = latestProjectedEvent(snapshot, ['FATAL', 'ERROR'])
  const jevEvidence = snapshot.decisionTrace?.jevEvidence ?? null
  const jevCombatDecision = projectCombatDecision(jevEvidence)
  const modelRecovered = latestProjectedEvent(snapshot, ['MODEL_RECOVERED'])
  const failureResolved = modelRecovered !== null
    && latestRuntimeFailure !== null
    && (parseTimestamp(modelRecovered.ts) ?? 0) > (parseTimestamp(latestRuntimeFailure.ts) ?? 0)
  const runtimeFailure = failureResolved ? null : latestRuntimeFailure
  const modelAvailability = snapshot.resident.modelAvailability
  const modelUnavailable = modelAvailability?.state === 'degraded'
  const observedAtMs = parseTimestamp(snapshot.observedAt)
  const freshnessMs = observedAtMs === null ? null : Math.max(0, now - observedAtMs)
  const heartbeatAt = parseTimestamp(heartbeat?.ts)
  const heartbeatAgeMs = heartbeatAt === null ? null : Math.max(0, now - heartbeatAt)
  const heartbeatLive = snapshot.resident.available && snapshot.resident.connected
    && heartbeatAgeMs !== null && heartbeatAgeMs <= 15_000
  const unknown = []
  if (!snapshot.resident.available) unknown.push('resident_report_unavailable')
  if (snapshot.resident.runId === null) unknown.push('live_run_identity_unavailable')
  if (snapshot.mission?.status !== 'observed') unknown.push(snapshot.mission?.provenance?.reason ?? 'mission_authority_unavailable')
  if (snapshot.resident.sourceCommit === null) unknown.push(snapshot.resident.sourceCommitConflict === true
    ? 'run_source_sha_conflict'
    : 'run_source_sha_unavailable')
  if (snapshot.resident.generationBoundary === null) unknown.push('current_generation_boundary_unavailable')
  if (modelUnavailable) unknown.push('model_authority_unavailable')
  if (snapshot.authority?.policy?.provider == null || snapshot.authority?.policy?.model == null) {
    unknown.push('effective_jev_provider_model_unavailable')
  }
  if (snapshot.authority?.system2?.configured?.provider == null || snapshot.authority?.system2?.configured?.model == null) {
    unknown.push('configured_system2_provider_model_unavailable')
  }
  if (snapshot.authority?.deterministicFallbackEnabled === null || snapshot.authority?.deterministicFallbackEnabled === undefined) {
    unknown.push('deterministic_fallback_configuration_unavailable')
  } else if (snapshot.authority.deterministicFallbackEnabled === true) {
    unknown.push('deterministic_fallback_enabled')
  }
  if (latest === null) unknown.push('no_choice_event_observed')
  if (latest !== null && latest.reason === null) unknown.push('latest_choice_has_no_explicit_reason')
  if (snapshot.truth === null) unknown.push('authoritative_world_truth_unavailable')
  if (heartbeatLive !== true) unknown.push('world_heartbeat_stale_or_missing')
  const latestHasVtrJevRouteEvidence = latestIsVtrReachRouteDecision && jevReachRouteDecision !== null
  if (latest?.actor === 'jev' && jevEvidence?.available !== true && !latestHasVtrJevRouteEvidence) unknown.push('jev_call_context_unavailable')
  if (!latestIsVtrReachRouteDecision && jevEvidence?.available === true && jevEvidence.binding?.confidence !== 'strong') unknown.push('jev_call_binding_is_partial')
  if (!latestIsVtrReachRouteDecision && jevEvidence?.available === true && jevEvidence.state?.structures?.status !== 'observed') unknown.push('structures_not_recorded_in_decision_snapshot')
  if (!latestIsVtrReachRouteDecision && jevEvidence?.outcome?.status === 'pending_or_not_observed') unknown.push('selected_action_outcome_not_yet_observed')
  const selection = latest?.selected?.strategy
    ?? latest?.selected?.chosen
    ?? latest?.selected?.id
    ?? latest?.selected?.actionId
    ?? latest?.selected?.toolName
    ?? latest?.selected?.routeId
    ?? (latest?.actor === 'vtr'
      ? `Transition ${latest.selected?.transitionId ?? 'UNKNOWN'} ensures ${latest.selected?.ensures ?? 'UNKNOWN'}`
      : null)
    ?? null
  const headline = latest === null
    ? 'No choice event has been observed.'
    : `${latest.actor} selected ${selection ?? 'UNKNOWN'}; explicit reason: ${latest.reason ?? 'not emitted'}.`
  const vtrTerminalHeadline = snapshot.vtr?.latest?.outcome?.kind !== null
    && snapshot.vtr?.latest?.outcome?.kind !== undefined
    ? ` VTR outcome=${snapshot.vtr.latest.outcome.kind}; predicate verification=${snapshot.vtr.latest.verification?.verified === true ? 'TRUE' : snapshot.vtr.latest.verification?.truth ?? 'not recorded'}.`
    : ''
  const postSuccessContradiction = snapshot.vtr?.latest?.outcomeConsistency?.contradictions?.[0] ?? null
  const vtrConsistencyHeadline = postSuccessContradiction === null
    ? ''
    : ` Lifecycle contradiction: orphan action ${postSuccessContradiction.actionId ?? 'UNKNOWN'} reported ${postSuccessContradiction.actionStatus ?? 'unknown status'} after Transition SUCCESS (predicate verification=${postSuccessContradiction.verifiedTransition ? 'TRUE' : 'not confirmed'}).`
  const failureHeadline = runtimeFailure?.detail?.code
    ? ` Runtime failure: ${runtimeFailure.detail.code}${runtimeFailure.detail.context ? ` (${runtimeFailure.detail.context})` : ''}.`
    : ''
  const interruption = jevEvidence?.outcome?.interruption ?? null
  const interruptionHeadline = interruption === null
    ? ''
    : ` The selected skill was lease-revoked after a same-generation MODEL_UNAVAILABLE event; link is inferred.`

  return redactSecrets({
    schemaVersion: 1,
    kind: 'ai-buddy-decision-summary',
    headline: `${headline}${vtrTerminalHeadline}${vtrConsistencyHeadline}${modelUnavailable ? ` Model authority unavailable; retryAt=${modelAvailability.retryAt ?? 'retry starting'}.` : ''}${failureHeadline}${interruptionHeadline}`,
    observedAt: snapshot.observedAt,
    freshnessMs,
    run: {
      id: snapshot.resident.runId,
      sourceCommit: snapshot.resident.sourceCommit ?? null,
      sourceCommitBinding: snapshot.resident.sourceCommitBinding ?? 'unknown',
      generationId: snapshot.resident.generationId,
      generationBoundary: snapshot.resident.generationBoundary ?? null,
      generationHash: snapshot.resident.generationHash,
      worldKey: snapshot.resident.worldKey,
    },
    status: {
      available: snapshot.resident.available && !modelUnavailable,
      hostAvailable: snapshot.resident.available,
      connected: snapshot.resident.connected,
      frozen: snapshot.resident.frozen,
      availabilityReason: modelUnavailable ? 'MODEL_UNAVAILABLE' : snapshot.resident.available ? null : runtimeFailure?.detail?.code ?? null,
    },
    authority: {
      jev: snapshot.authority?.policy ?? null,
      jevRecentFailures: snapshot.authority?.jevRecentFailures ?? [],
      system2: snapshot.authority?.system2 ?? null,
      deterministicFallbackEnabled: snapshot.authority?.deterministicFallbackEnabled ?? null,
    },
    mission: snapshot.mission,
    goal: snapshot.goal,
    option: snapshot.option,
    choices: {
      latest,
      jev,
      jevStatus: jev === null && jevReachRouteDecision === null ? 'not_recorded' : 'observed',
      jevReachRouteDecision,
      vtr: snapshot.vtr ?? null,
      jevEvidence,
      jevCombatDecision,
      system2: {
        input: system2Input,
        decision: system2,
        reasonMatchedBy: system2Reason === null ? null : ['trigger', 'provider', 'model'],
      },
    },
    execution: {
      activeAction: snapshot.action,
      latestActionEvent: actionEvent,
      latestOutcomeEvent: actionOutcomeEvent,
      selectedChoiceOutcome: jevEvidence?.outcome ?? null,
      selectedChoiceInterruption: jevEvidence?.outcome?.interruption ?? null,
      latestDeath: snapshot.decisionTrace?.death ?? null,
    },
    transition: snapshot.vtr?.latest ?? null,
    vtr: snapshot.vtr ?? null,
    worldProbe: {
      href: '/api/world-probe?radius=6&verticalRadius=3',
      method: 'GET',
      readOnly: true,
      purpose: 'on-demand Mineflayer state, nearby block and entity observation',
    },
    progress: {
      liveGoal: snapshot.goal.queue.current === null ? null : {
        id: snapshot.goal.queue.current.id,
        description: snapshot.goal.queue.current.description,
        have: snapshot.goal.queue.current.haveCount,
        required: snapshot.goal.queue.current.requiredCount,
        fraction: typeof snapshot.goal.queue.current.haveCount === 'number'
          && typeof snapshot.goal.queue.current.requiredCount === 'number'
          && snapshot.goal.queue.current.requiredCount > 0
          ? Math.min(1, snapshot.goal.queue.current.haveCount / snapshot.goal.queue.current.requiredCount)
          : null,
        status: snapshot.goal.queue.current.status,
      },
      atLatestJevDecision: jevEvidence?.state?.progress ?? null,
      stall: jevEvidence?.state?.progress?.strategicNonProgress ?? null,
      stallStatus: jevEvidence?.state?.progress?.strategicNonProgress?.exhausted === true
        ? 'exhausted'
        : jevEvidence?.state?.progress?.strategicNonProgress === null || jevEvidence?.state?.progress?.strategicNonProgress === undefined
          ? 'not_recorded'
          : 'tracked_not_exhausted',
    },
    runtimeFailure,
    modelAvailability,
    world: snapshot.truth,
    worldObservation: heartbeat === null ? null : {
      observedAt: heartbeat.ts,
      ageMs: heartbeatAgeMs,
      sourceEvent: heartbeat.event,
      live: heartbeatLive,
      worldKey: snapshot.resident.worldKey,
      dimension: snapshot.truth?.dimension ?? snapshot.resident.worldKey?.dimension ?? null,
      position: snapshot.truth?.position ?? parsePosition(heartbeat.detail?.pos),
      health: snapshot.truth?.health ?? heartbeat.detail?.health ?? null,
      food: snapshot.truth?.food ?? heartbeat.detail?.food ?? null,
      inventory: snapshot.truth?.inventory ?? heartbeat.detail?.inv ?? null,
      currentAction: heartbeat.detail?.action ?? null,
      frontier: heartbeat.detail?.rung ?? null,
      queueDepth: heartbeat.detail?.depth ?? null,
      queueDone: heartbeat.detail?.done ?? null,
    },
    combatDecision: jevCombatDecision,
    recentEvents: (snapshot.events ?? []).slice(0, 12),
    unknown,
    interpretation: 'Only emitted audit fields are summarized. Null and unknown entries mean the observer found no matching evidence.',
  })
}

export function createObserver({ runtimeDir = DEFAULT_RUNTIME_DIR, intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  const socketPath = join(runtimeDir, 'data', 'resident', 'control.sock')
  const logPath = join(runtimeDir, 'buddy.log')
  const jevCallsPath = join(runtimeDir, 'logs', 'jev', 'jev-calls.jsonl')
  const vtrRunLogPath = join(runtimeDir, 'logs', 'jev', 'run.jsonl')
  const runnerOutPath = join(runtimeDir, 'runner.out')

  // Summary requests also expose the on-demand live probe. Multiple readers
  // asking for the same radius at once must share its report -> state -> report
  // bracket; otherwise a burst of read-only HTTP clients queues redundant
  // sensor scans on the resident control socket and can make each response
  // miss its caller's deadline.
  const worldProbeInFlight = new Map()
  const worldProbe = async ({ radius = 6, verticalRadius = 3 } = {}) => {
    const horizontal = Number.isFinite(radius) ? Math.max(1, Math.min(8, Math.floor(radius))) : 6
    const vertical = Number.isFinite(verticalRadius) ? Math.max(1, Math.min(4, Math.floor(verticalRadius))) : 3
    const key = `${horizontal}:${vertical}`
    const existing = worldProbeInFlight.get(key)
    if (existing !== undefined) return await existing

    const pending = (async () => {
      const report = await callControlSocket(socketPath, 'report')
      const state = await callControlSocket(socketPath, 'state', DEFAULT_CONTROL_TIMEOUT_MS, { radius: horizontal, verticalRadius: vertical })
      const reportAfter = await callControlSocket(socketPath, 'report')
      return buildWorldProbe({ report, reportAfter, state, radius: horizontal, verticalRadius: vertical })
    })().finally(() => {
      if (worldProbeInFlight.get(key) === pending) worldProbeInFlight.delete(key)
    })
    worldProbeInFlight.set(key, pending)
    return await pending
  }

  let snapshotInFlight = null
  let cachedRunId = null
  let cachedRunBoot = null
  let cachedRunBuild = null
  let cachedRunMetadata = null
  let cachedGenerationId = null
  let cachedGenerationReady = null
  const snapshot = async () => {
    if (snapshotInFlight !== null) return await snapshotInFlight
    snapshotInFlight = Promise.all([
      callControlSocket(socketPath, 'report'),
      Promise.resolve(readLogTail(logPath)),
      Promise.resolve(readJsonlTail(jevCallsPath)),
      Promise.resolve(readVtrRunJsonlEvents(vtrRunLogPath)),
    ]).then(([report, events, jevCalls, vtrEvents]) => {
      const bootFromTail = latestEvent(events, ['BOOT'])
      const reportedRunId = report?.ok === true ? report.data?.runId : null
      const currentRunId = typeof reportedRunId === 'string' && reportedRunId.length > 0 ? reportedRunId : null
      const reportedGenerationId = report?.ok === true ? report.data?.generationId : null
      const currentGenerationId = typeof reportedGenerationId === 'string' && reportedGenerationId.length > 0 ? reportedGenerationId : null
      if (currentRunId === null) {
        cachedRunId = null
        cachedRunBoot = null
        cachedRunBuild = null
      } else if (currentRunId !== cachedRunId) {
        cachedRunId = currentRunId
        cachedRunBoot = bootFromTail?.detail?.runId === currentRunId
          ? bootFromTail
          : readRunEvent(logPath, 'BOOT', currentRunId)
        cachedRunBuild = readRunEvent(logPath, 'BUILD', currentRunId)
      }
      const runMetadata = currentRunId === null ? null : readRunMetadata(runtimeDir, currentRunId)
      let candidateGenerationReady = [...events].reverse().find((entry) => entry.event === 'GENERATION_READY'
        && entry.detail?.runId === currentRunId
        && entry.detail?.id === currentGenerationId) ?? null
      if (candidateGenerationReady === null) {
        candidateGenerationReady = readLogEvent(logPath, 'GENERATION_READY', currentRunId,
          (detail) => detail.id === currentGenerationId)
      }
      const runGenerationReady = runGenerationAnchorMatches(
        runMetadata,
        currentRunId,
        currentGenerationId,
        candidateGenerationReady,
        cachedRunBoot,
      ) ? candidateGenerationReady : null
      cachedRunMetadata = runMetadata
      cachedGenerationId = currentGenerationId
      cachedGenerationReady = runGenerationReady
      const runnerEvents = readRunnerOutEvents(runnerOutPath, { runId: currentRunId, bootTs: cachedRunBoot?.ts ?? null })
      const combinedEvents = [...events, ...runnerEvents, ...vtrEvents].sort((left, right) => {
        const leftTs = Date.parse(left.ts ?? '')
        const rightTs = Date.parse(right.ts ?? '')
        return (Number.isFinite(leftTs) ? leftTs : 0) - (Number.isFinite(rightTs) ? rightTs : 0)
      })
      return buildObserverSnapshot({
        report,
        events: combinedEvents,
        // Mission is derived below only from run-bound structured runtime evidence.
        mission: null,
        runBoot: cachedRunBoot,
        runBuild: cachedRunBuild,
        runMetadata,
        runGenerationReady,
        jevCalls,
      })
    })
      .finally(() => { snapshotInFlight = null })
    return await snapshotInFlight
  }

  const recentChoiceOutcomes = async ({ limit = 12, maxBytes = DEFAULT_RECENT_CHOICE_LOG_BYTES } = {}) => {
    const runId = cachedRunId
    const generationId = cachedGenerationId
    const generationReady = cachedGenerationReady
    const generationStartedAt = parseTimestamp(generationReady?.ts)
    const generationBound = runGenerationAnchorMatches(cachedRunMetadata, runId, generationId, generationReady, cachedRunBoot)
    const boundedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(20, Math.floor(limit))) : 12
    const boundedMaxBytes = Number.isFinite(maxBytes)
      ? Math.max(1, Math.min(MAX_RECENT_CHOICE_LOG_BYTES, Math.floor(maxBytes)))
      : DEFAULT_RECENT_CHOICE_LOG_BYTES
    if (runId === null || generationId === null || generationBound !== true || generationStartedAt === null) {
      return {
        status: 'unknown',
        binding: { runId, directRunId: runId !== null, generationId, method: 'runId+generationId+GENERATION_READY', confidence: 'unknown' },
        entries: [],
        unknown: ['current_run_generation_boundary_unavailable'],
      }
    }
    const events = readLogTail(logPath, boundedMaxBytes)
      .filter((entry) => TRACE_EVENTS.has(entry.event) && eventBelongsToRunGeneration(entry, {
        runId,
        generationId,
        generationStartedAt,
        generationBound,
      }))
    const choices = events.filter((entry) => ['JEV_HEADS', 'TOOL_CHOICE'].includes(entry.event))
    const entries = choices.slice(-boundedLimit).map((entry) => {
      const choice = projectChoice(entry, 'jev')
      return {
        observedAt: choice.observedAt,
        event: choice.event,
        selected: choice.selected,
        trigger: choice.trigger,
        reason: choice.reason,
        generationId: entry.detail?.generationId ?? null,
        generationBinding: entry.detail?.generationId === generationId ? 'direct' : 'ready-window-inferred',
        chainId: entry.detail?.chainId ?? null,
        outcome: outcomeEvidenceForChoice(entry, events),
      }
    })
    return redactSecrets({
      status: entries.length > 0 ? 'observed' : 'not_recorded',
      binding: {
        runId,
        directRunId: true,
        generationId,
        method: 'runId+generationId+GENERATION_READY',
        confidence: 'direct',
        generationReadyObservedAt: generationReady.ts,
      },
      bounded: { maxBytes: boundedMaxBytes, limit: boundedLimit },
      entries,
      unknown: entries.length > 0 ? [] : ['no_choice_outcome_in_bounded_run_tail'],
    })
  }

  return { runtimeDir, socketPath, logPath, jevCallsPath, vtrRunLogPath, runnerOutPath, mission: null, intervalMs, snapshot, worldProbe, recentChoiceOutcomes }
}

function bindProbeToSummary(summary, probe) {
  const probeBinding = probe?.binding ?? null
  const summaryWorld = normalizeWorldKey(summary?.run?.worldKey)
  const probeWorld = normalizeWorldKey(probeBinding?.probeWorld)
  const sameRun = typeof summary?.run?.id === 'string' && typeof probeBinding?.probeRunId === 'string'
    ? summary.run.id === probeBinding.probeRunId
    : null
  const sameWorld = summaryWorld !== null && probeWorld !== null
    ? summaryWorld.serverId === probeWorld.serverId
      && summaryWorld.dimension === probeWorld.dimension
      && summaryWorld.worldEpoch === probeWorld.worldEpoch
    : null
  const sameGeneration = typeof summary?.run?.generationId === 'string' && typeof probeBinding?.probeGenerationId === 'string'
    ? summary.run.generationId === probeBinding.probeGenerationId
    : null
  const status = sameRun === true && sameWorld === true && sameGeneration === true
    ? 'aligned'
    : [sameRun, sameWorld, sameGeneration].includes(false) ? 'mismatch' : 'unknown'
  return {
    ...probe,
    summaryBinding: {
      status,
      sameRun,
      sameWorld,
      sameGeneration,
      summary: {
        runId: summary?.run?.id ?? null,
        generationId: summary?.run?.generationId ?? null,
        worldKey: summaryWorld,
      },
      probe: {
        runId: probeBinding?.probeRunId ?? null,
        generationId: probeBinding?.probeGenerationId ?? null,
        worldKey: probeWorld,
      },
    },
  }
}

function htmlPage() {
  return String.raw`<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AI Buddy Observer</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #0b0e13; color: #e7edf5; }
    header { position: sticky; top: 0; z-index: 2; display:flex; gap:16px; align-items:center; justify-content:space-between; padding:16px 22px; background:#10151dcc; backdrop-filter: blur(12px); border-bottom:1px solid #263041; }
    h1 { font-size:18px; margin:0; letter-spacing:.02em; }
    .status { display:flex; gap:10px; align-items:center; color:#9fafc2; font-size:13px; }
    .dot { width:9px; height:9px; border-radius:999px; background:#687587; box-shadow:0 0 0 4px #68758722; }
    .dot.online { background:#50d890; box-shadow:0 0 0 4px #50d89022; }
    main { max-width:1400px; margin:0 auto; padding:22px; }
    .flow { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:10px; margin-bottom:14px; }
    .flow-card,.card { background:#121821; border:1px solid #263041; border-radius:14px; padding:14px; min-width:0; }
    .flow-card .eyebrow,.eyebrow { font-size:11px; text-transform:uppercase; letter-spacing:.12em; color:#73839a; margin-bottom:8px; }
    .flow-card .primary { font-size:16px; font-weight:650; overflow-wrap:anywhere; }
    .flow-card .secondary { margin-top:7px; color:#9fafc2; font-size:12px; overflow-wrap:anywhere; }
    .grid { display:grid; grid-template-columns:repeat(12,minmax(0,1fr)); gap:14px; }
    .card { grid-column:span 4; }
    .card.wide { grid-column:span 8; }
    .card.full { grid-column:1/-1; }
    h2 { margin:0 0 12px; font-size:15px; }
    dl { display:grid; grid-template-columns:minmax(110px,.8fr) 2fr; gap:7px 12px; margin:0; font-size:13px; }
    dt { color:#73839a; }
    dd { margin:0; overflow-wrap:anywhere; }
    code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
    .trace { display:grid; gap:9px; }
    .trace-row { border-left:2px solid #39485d; padding:8px 10px; background:#0e131a; border-radius:0 8px 8px 0; }
    .trace-head { display:flex; justify-content:space-between; gap:12px; margin-bottom:6px; }
    .trace-event { font-weight:650; font-size:12px; }
    .trace-time { color:#65748a; font-size:11px; white-space:nowrap; }
    .trace-detail { color:#afbdcf; font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; white-space:pre-wrap; overflow-wrap:anywhere; }
    .empty { color:#65748a; font-size:13px; }
    .note { color:#7f8da1; font-size:12px; margin:0 0 14px; }
    @media (max-width: 900px) { .flow { grid-template-columns:1fr 1fr; } .card,.card.wide { grid-column:1/-1; } }
    @media (max-width: 560px) { main { padding:12px; } header { padding:13px 14px; } .flow { grid-template-columns:1fr; } }
  </style>
</head>
<body>
  <header>
    <h1>AI Buddy Observer</h1>
    <div class="status"><span id="dot" class="dot"></span><span id="resident">resident unavailable</span><span id="updated">--:--:--</span></div>
  </header>
  <main>
    <p class="note">Decision Trace は resident が実際に記録した Goal / Option / Jev / System2 / Action の監査情報です。</p>
    <section class="flow">
      <div class="flow-card"><div class="eyebrow">Goal</div><div id="flow-goal" class="primary">—</div><div id="flow-goal-sub" class="secondary"></div></div>
      <div class="flow-card"><div class="eyebrow">Option</div><div id="flow-option" class="primary">—</div><div id="flow-option-sub" class="secondary"></div></div>
      <div class="flow-card"><div class="eyebrow">Decision</div><div id="flow-decision" class="primary">—</div><div id="flow-decision-sub" class="secondary"></div></div>
      <div class="flow-card"><div class="eyebrow">Action</div><div id="flow-action" class="primary">—</div><div id="flow-action-sub" class="secondary"></div></div>
    </section>
    <section class="grid">
      <article class="card"><h2>Mission / Goal</h2><dl id="goal"></dl></article>
      <article class="card"><h2>Jev authority</h2><dl id="jev"></dl></article>
      <article class="card"><h2>System2 / Mercury</h2><dl id="system2"></dl></article>
      <article class="card wide"><h2>Decision Trace</h2><div id="trace" class="trace"></div></article>
      <article class="card"><h2>World truth</h2><dl id="truth"></dl></article>
      <article class="card full"><h2>Recent audit events</h2><div id="events" class="trace"></div></article>
    </section>
  </main>
  <script>
    const $ = (id) => document.getElementById(id)
    const text = (value, fallback='—') => value === null || value === undefined || value === '' ? fallback : String(value)
    const compact = (value) => value === null || value === undefined ? '—' : typeof value === 'string' ? value : JSON.stringify(value)
    const rows = (target, entries) => { target.innerHTML = entries.map(([k,v]) => '<dt>'+escapeHtml(k)+'</dt><dd>'+escapeHtml(compact(v))+'</dd>').join('') }
    const escapeHtml = (v) => String(v).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
    const eventRow = (entry) => {
      if (!entry) return '<div class="empty">No observed decision yet.</div>'
      const time = entry.ts ? new Date(entry.ts).toLocaleTimeString() : ''
      return '<div class="trace-row"><div class="trace-head"><span class="trace-event">'+escapeHtml(entry.event)+'</span><span class="trace-time">'+escapeHtml(time)+'</span></div><div class="trace-detail">'+escapeHtml(JSON.stringify(entry.detail, null, 2))+'</div></div>'
    }
    function render(s) {
      $('dot').className = 'dot' + (s.resident.available && s.resident.connected ? ' online' : '')
      $('resident').textContent = s.resident.available ? (s.resident.connected ? 'connected' : 'resident online / bot disconnected') : 'resident unavailable'
      $('updated').textContent = new Date(s.observedAt).toLocaleTimeString()
      const current = s.goal.queue.current
      const j = s.decisionTrace.jev
      $('flow-goal').textContent = text(current?.description, text(s.goal.frontier))
      $('flow-goal-sub').textContent = 'frontier=' + text(s.goal.frontier) + ' · depth=' + text(s.goal.queue.depth)
      $('flow-option').textContent = text(s.option?.intent)
      $('flow-option-sub').textContent = text(s.option?.templateId)
      $('flow-decision').textContent = text(j?.detail?.action, text(s.decisionTrace.system2Decision?.detail?.chosen, text(s.decisionTrace.system2Decision?.detail?.strategy)))
      $('flow-decision-sub').textContent = j ? 'Jev · ' + text(j.detail.decision) : s.decisionTrace.system2Decision ? 'System2 · ' + text(s.decisionTrace.system2Decision.detail.provider) : '—'
      $('flow-action').textContent = text(s.action?.kind, text(s.decisionTrace.action?.detail?.kind))
      $('flow-action-sub').textContent = s.action ? text(s.action.phase) + ' · ' + text(s.action.id) : text(s.decisionTrace.action?.detail?.id)
      rows($('goal'), [
        ['mission', s.mission.status === 'observed' ? s.mission.id + ': ' + s.mission.title : 'unknown'], ['mission provenance', s.mission.provenance?.source ?? s.mission.provenance?.reason], ['frontier', s.goal.frontier], ['current', current?.description], ['progress', current ? text(current.haveCount) + '/' + text(current.requiredCount) : null], ['queue depth', s.goal.queue.depth], ['queue revision', s.goal.queue.revision], ['option', s.option?.intent], ['option id', s.option?.templateId]
      ])
      rows($('jev'), [
        ['provider', s.authority.policy?.provider], ['model', s.authority.policy?.model], ['policy', s.authority.policy?.kind], ['selected action', j?.detail?.action], ['abandon p', j?.detail?.abandon], ['beta decision', j?.detail?.decision], ['beta authority', j?.detail?.betaAuthority]
      ])
      rows($('system2'), [
        ['configured', s.authority.system2?.configured], ['last authority', s.authority.system2?.last], ['trigger', s.decisionTrace.system2Input?.detail?.trigger ?? s.decisionTrace.system2Input?.detail?.reason], ['candidate options', s.decisionTrace.system2Input?.detail?.optionIds], ['selected', s.decisionTrace.system2Decision?.detail?.chosen ?? s.decisionTrace.system2Decision?.detail?.strategy], ['goals', s.decisionTrace.system2Decision?.detail?.goals], ['Mercury state', s.decisionTrace.mercury?.event]
      ])
      rows($('truth'), [
        ['position', s.truth?.position], ['dimension', s.truth?.dimension], ['health', s.truth?.health], ['food', s.truth?.food], ['on ground', s.truth?.onGround], ['inventory', s.truth?.inventory], ['generation', s.resident.generationId], ['run', s.resident.runId]
      ])
      $('trace').innerHTML = [s.decisionTrace.jev, s.decisionTrace.system2Input, s.decisionTrace.system2Decision, s.decisionTrace.mercury, s.decisionTrace.action].filter(Boolean).map(eventRow).join('') || '<div class="empty">No observed decision yet.</div>'
      $('events').innerHTML = s.events.map(eventRow).join('') || '<div class="empty">No audit events in the current log tail.</div>'
    }
    async function fallback() { try { render(await fetch('/api/snapshot', {cache:'no-store'}).then(r => r.json())) } catch {} }
    const stream = new EventSource('/events')
    stream.onmessage = (event) => { try { render(JSON.parse(event.data)) } catch {} }
    stream.onerror = fallback
    fallback()
  </script>
</body>
</html>`
}

export function startObserverServer(options = {}) {
  const observer = createObserver(options)
  const hostname = options.hostname ?? DEFAULT_HOST
  const port = options.port ?? DEFAULT_PORT

  const server = Bun.serve({
    hostname,
    port,
    async fetch(request) {
      const url = new URL(request.url)
      if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405 })
      if (url.pathname === '/') {
        return new Response(htmlPage(), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
      }
      if (url.pathname === '/api/snapshot') {
        return Response.json(await observer.snapshot(), { headers: { 'cache-control': 'no-store' } })
      }
      if (url.pathname === '/api/ai-summary') {
        const [snapshot, probe] = await Promise.all([
          observer.snapshot(),
          observer.worldProbe({ radius: 6, verticalRadius: 3 }),
        ])
        const summary = buildAiSummary(snapshot)
        return Response.json({
          ...summary,
          currentWorldProbe: bindProbeToSummary(summary, probe),
          recentChoiceOutcomes: await observer.recentChoiceOutcomes(),
        }, { headers: { 'cache-control': 'no-store' } })
      }
      if (url.pathname === '/api/world-probe') {
        const radiusValue = Number(url.searchParams.get('radius') ?? 6)
        const verticalValue = Number(url.searchParams.get('verticalRadius') ?? 3)
        const radius = Number.isFinite(radiusValue) ? Math.max(1, Math.min(8, Math.floor(radiusValue))) : 6
        const verticalRadius = Number.isFinite(verticalValue) ? Math.max(1, Math.min(4, Math.floor(verticalValue))) : 3
        return Response.json(await observer.worldProbe({ radius, verticalRadius }), { headers: { 'cache-control': 'no-store' } })
      }
      if (url.pathname === '/events') {
        let timer = null
        const stream = new ReadableStream({
          start(controller) {
            const emit = async () => {
              try {
                const current = await observer.snapshot()
                controller.enqueue(`data: ${JSON.stringify(current)}\n\n`)
              } catch (error) {
                controller.enqueue(`event: observer-error\ndata: ${JSON.stringify({ message: error instanceof Error ? error.message : String(error) })}\n\n`)
              }
            }
            void emit()
            timer = setInterval(() => void emit(), observer.intervalMs)
          },
          cancel() {
            if (timer !== null) clearInterval(timer)
          },
        })
        return new Response(stream, {
          headers: {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache, no-store',
            connection: 'keep-alive',
          },
        })
      }
      return new Response('Not Found', { status: 404 })
    },
  })

  return { server, observer, url: `http://${hostname}:${server.port}` }
}

if (import.meta.main) {
  const runtimeDir = resolve(process.env.BUDDY_OBSERVER_RUNTIME_DIR ?? DEFAULT_RUNTIME_DIR)
  const hostname = process.env.BUDDY_OBSERVER_HOST?.trim() || DEFAULT_HOST
  const rawPort = Number(process.env.BUDDY_OBSERVER_PORT ?? DEFAULT_PORT)
  const port = Number.isInteger(rawPort) && rawPort > 0 && rawPort <= 65535 ? rawPort : DEFAULT_PORT
  const rawInterval = Number(process.env.BUDDY_OBSERVER_INTERVAL_MS ?? DEFAULT_INTERVAL_MS)
  const intervalMs = Number.isFinite(rawInterval) && rawInterval >= 250 ? rawInterval : DEFAULT_INTERVAL_MS
  const { url, observer } = startObserverServer({ runtimeDir, hostname, port, intervalMs })
  process.stdout.write(`AI_BUDDY_OBSERVER url=${url} runtime=${observer.runtimeDir} mode=read-only\n`)
}
