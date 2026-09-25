#!/usr/bin/env node
// Package already-captured VTR Reach evidence for the read-only acceptance
// validator. This adapter never starts a runtime, repairs an archive, or
// manufactures absent input files.

import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const SHA40_RE = /^[0-9a-f]{40}$/i
const RUN_ID_RE = /^run-[a-z0-9]+-[a-z0-9]+$/i
const EXPECTED_REPOSITORY = 'souta-lab/minecraft-jev-agent'
const COLLECTOR_INPUT_PATHS = Object.freeze({
  'host-log': 'runner/buddy.log',
  'run-journal': 'runner/jev-run.jsonl',
  'jev-calls': 'runner/jev-calls.jsonl',
  'jev-decisions': 'runner/jev-decisions.jsonl',
  'system2-journal': 'runner/system2.jsonl',
})
const PROVIDER_JOURNALS = Object.freeze(['jev-calls', 'jev-decisions', 'system2-journal'])
const REQUIRED_ARCHIVE_PATHS = Object.freeze([
  'runner/acceptance.json',
  'runner/buddy.log',
  'runner/generation-bundle.mjs',
  'runner/initial-snapshot.json',
  'runner/final-snapshot.json',
  'runner/jev-run.jsonl',
  'runner/jev-calls.jsonl',
  'runner/jev-decisions.jsonl',
  'runner/system2.jsonl',
  'runner/milestone-predicates.json',
  'runner/run-metadata.json',
  'runner/provider-activity-capture.json',
  'server/fixture-commands.jsonl',
  'server/leaf-latest.log',
  'server/server-start.json',
  'server/server.properties.launch',
  'server/server.properties.effective-after-boot',
  'server/world/level.dat',
  'server/world/playerdata.dat',
  'server/world/r.-1.0.mca',
])

const HELP = `Usage: bun tools/package-vtr-reach-live-archive.mjs \
  --collector-report <capture.json> --manifest <inputs.json> --archive <new-directory>

Manifest schema: vtr-reach-live-archive-input/v1
  { "files": { "runner/run-metadata.json": "./run-metadata.json", ... } }

The supplied run-metadata.json must record source {repository, branch, commit},
the complete validator run identity/timestamps, mission inventories/positions,
and fixture facts. Map the actual server-start/config, initial/final snapshots,
fixture command journal, world files, acceptance record, and milestone snapshot
to their canonical paths in files. Collector logs/journals are copied from
the paths and hashes in the collector report; do not duplicate those mappings.

To claim observed zero provider activity, also supply
runner/provider-activity-capture.json with schema vtr-provider-activity-capture/v1,
status OBSERVED, the exact collector source/run/generation/world identity,
window { startedAt, endedAt, coverageComplete: true }, exactly zero
activity.networkModelCalls/jevDecisionCalls/system2DecisionCalls, and a
journals entry for each of jev-calls, jev-decisions, and system2-journal.
Each journal entry records its actual bytes, sha256, initializedAt, and
closedAt. The source must already exist and match the collector's captured
hash; an absent journal is never created here.

The collector's raw inputs are copied only when the collector report records
them as captured and their current byte count/hash still match. Missing files
remain absent and are reported INCOMPLETE. The archive is only prepared for
the read-only validator; this tool cannot declare live acceptance.
`

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function parseArgs(argv) {
  const out = { collectorReport: null, manifest: null, archive: null, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') {
      out.help = true
      continue
    }
    if (!['--collector-report', '--manifest', '--archive'].includes(argument)) throw new Error(`unknown argument: ${argument}`)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a path`)
    out[argument.slice(2).replace(/-([a-z])/g, (_all, letter) => letter.toUpperCase())] = value
    index += 1
  }
  if (!out.help && (!out.collectorReport || !out.manifest || !out.archive)) throw new Error('--collector-report, --manifest, and --archive are required')
  return out
}

function readJson(path, label) {
  let value
  try { value = JSON.parse(readFileSync(path, 'utf8')) } catch (error) { throw new Error(`${label}: ${error.message}`) }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a JSON object`)
  return value
}

function safeArchivePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\') || value.startsWith('/')) return false
  const parts = value.split('/')
  return parts.every((part) => part.length > 0 && part !== '.' && part !== '..')
}

function sourcePath(value, baseDir) {
  if (typeof value !== 'string' || value.trim() === '') return null
  return resolve(baseDir, value)
}

function regularFileBytes(path) {
  try {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() || !stat.isFile()) return null
    return readFileSync(path)
  } catch {
    return null
  }
}

function worldKeyString(value) {
  if (typeof value === 'string') {
    const parts = value.split('|')
    if (parts.length !== 3 || !parts[0] || !parts[1] || !Number.isSafeInteger(Number(parts[2]))) return null
    return `${parts[0]}|${parts[1]}|${Number(parts[2])}`
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const serverId = value.serverId
  const dimension = value.dimension
  const epoch = value.worldEpoch
  if (typeof serverId !== 'string' || !serverId || typeof dimension !== 'string' || !dimension || !Number.isSafeInteger(epoch)) return null
  return `${serverId}|${dimension}|${epoch}`
}

function sameWorldKey(left, right) {
  const a = worldKeyString(left)
  const b = worldKeyString(right)
  if (a === null || b === null) return false
  const parse = (key) => {
    const [serverId, dimension, epoch] = key.split('|')
    return { serverId, dimension: dimension.replace(/^minecraft:/u, ''), epoch: Number(epoch) }
  }
  const aa = parse(a)
  const bb = parse(b)
  return aa.serverId === bb.serverId && aa.dimension === bb.dimension && aa.epoch === bb.epoch
}

function collectorRows(report) {
  const rows = report?.observed?.transition?.sourceEventRows
  return Array.isArray(rows) ? rows.filter((row) => row && typeof row === 'object') : []
}

function eventName(row) {
  if (typeof row?.message !== 'string') return null
  return /^\s*(?:\[[^\]]+\]\s*)?([A-Z][A-Z0-9_]*)\b/u.exec(row.message)?.[1] ?? null
}

function check(statuses, status, id, detail = {}) {
  statuses.push({ id, status, ...detail })
}

function identityFromCollector(report) {
  const observed = report?.observed ?? {}
  return {
    sourceSha: typeof observed.sourceSha === 'string' ? observed.sourceSha.toLowerCase() : null,
    runId: typeof observed.runId === 'string' ? observed.runId : null,
    generationId: typeof observed.generationId === 'string' ? observed.generationId : null,
    worldKey: observed.worldKey ?? null,
    worldIdentity: observed.worldIdentity ?? null,
  }
}

function findCollectorInput(report, name) {
  return Array.isArray(report?.inputs) ? report.inputs.find((input) => input?.name === name) ?? null : null
}

function recordsInJournal(bytes, label) {
  const rows = []
  const lines = bytes.toString('utf8').split(/\r?\n/u)
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line)
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('row must be an object')
      rows.push(row)
    } catch (error) {
      throw new Error(`${label}:${index + 1}: ${error.message}`)
    }
  }
  return rows
}

function timestamp(value) {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function inspectProviderCapture({ capture, identity, copiedSources, collectorReport, transitionRows, run }) {
  const result = { status: 'INCOMPLETE', reason: 'provider capture evidence is absent or does not cover the complete run window', identity: null, window: null, journals: {} }
  if (!capture || typeof capture !== 'object' || Array.isArray(capture)) return result

  const boundIdentity = capture.identity ?? {}
  result.identity = boundIdentity
  const window = capture.window ?? {}
  result.window = window
  const runIdentityMatches = typeof boundIdentity.sourceSha === 'string' && boundIdentity.sourceSha.toLowerCase() === identity.sourceSha
    && boundIdentity.runId === identity.runId
    && boundIdentity.generationId === identity.generationId
    && sameWorldKey(boundIdentity.worldKey, identity.worldKey)
  const readyAt = timestamp(run?.generationReadyAt)
  const terminalRows = transitionRows.filter((row) => eventName(row) === 'VTR_TRANSITION_OUTCOME')
  const terminalAt = timestamp(terminalRows[0]?.ts ?? terminalRows[0]?.timestamp)
  const windowStart = timestamp(window.startedAt)
  const windowEnd = timestamp(window.endedAt)
  const collectorWindowStart = timestamp(collectorReport?.captureWindow?.startedAt)
  const collectorWindowEnd = timestamp(collectorReport?.captureWindow?.endedAt)
  const windowCoversRun = readyAt !== null && terminalAt !== null && windowStart !== null && windowEnd !== null
    && windowStart <= Math.min(readyAt, collectorWindowStart ?? readyAt)
    && windowEnd >= Math.max(terminalAt, collectorWindowEnd ?? terminalAt)
    && window.coverageComplete === true
  const counters = capture.activity ?? {}
  const counterNames = ['networkModelCalls', 'jevDecisionCalls', 'system2DecisionCalls']
  const zeroCounters = counterNames.every((key) => counters[key] === 0)
  const nonzeroCounters = counterNames.some((key) => Number.isFinite(counters[key]) && counters[key] > 0)
  const captureJournals = capture.journals ?? {}
  const reportJournals = Object.fromEntries(PROVIDER_JOURNALS.map((name) => [name, findCollectorInput(collectorReport, name)]))
  const checks = []
  for (const name of PROVIDER_JOURNALS) {
    const captureEntry = captureJournals[name]
    const reportEntry = reportJournals[name]
    const archivePath = COLLECTOR_INPUT_PATHS[name]
    const copied = copiedSources.get(archivePath)
    const ready = timestamp(run?.generationReadyAt)
    const end = timestamp(terminalRows[0]?.ts ?? terminalRows[0]?.timestamp)
    const armed = timestamp(captureEntry?.initializedAt)
    const closed = timestamp(captureEntry?.closedAt)
    const digest = copied ? sha256(copied.bytes) : null
    const collectorEnd = timestamp(collectorReport?.captureWindow?.endedAt)
    const collectionStart = timestamp(collectorReport?.captureWindow?.startedAt)
    const matches = reportEntry?.status === 'captured'
      && Number.isSafeInteger(reportEntry.bytes)
      && reportEntry.bytes === 0
      && typeof reportEntry.sha256 === 'string'
      && digest === reportEntry.sha256.toLowerCase()
      && captureEntry?.bytes === 0
      && typeof captureEntry?.sha256 === 'string'
      && captureEntry.sha256.toLowerCase() === digest
      && armed !== null && ready !== null && armed <= Math.min(ready, collectionStart ?? ready)
      && closed !== null && end !== null && closed >= Math.max(end, collectorEnd ?? end)
      && copied?.bytes.length === 0
    result.journals[name] = {
      status: reportEntry?.status ?? 'missing',
      archivePath,
      bytes: copied?.bytes.length ?? null,
      sha256: digest,
      initializedAt: captureEntry?.initializedAt ?? null,
      closedAt: captureEntry?.closedAt ?? null,
    }
    const activityObserved = (Number.isFinite(reportEntry?.bytes) && reportEntry.bytes > 0)
      || (Number.isFinite(captureEntry?.bytes) && captureEntry.bytes > 0)
    checks.push({ matches, activityObserved })
  }
  const collectorPolicyPass = Array.isArray(collectorReport?.checks)
    && collectorReport.checks.some((entry) => entry.id === 'policy:no-model-activity-during-probe' && entry.status === 'PASS')
    && collectorReport.checks.some((entry) => entry.id === 'policy:provider-journals' && entry.status === 'PASS')
  const collectorMetrics = collectorReport?.observed?.transition?.metrics ?? {}
  const collectorCountersZero = Number(collectorMetrics.jevCallsPerTransition) === 0
    && Number(collectorMetrics.system2CallsPerTransition) === 0
    && Number(collectorMetrics.modelCallsPerMechanicalStep) === 0
  if (capture.schema === 'vtr-provider-activity-capture/v1' && capture.status === 'OBSERVED'
    && runIdentityMatches && windowCoversRun && zeroCounters && checks.every((entry) => entry.matches) && collectorPolicyPass && collectorCountersZero) {
    result.status = 'OBSERVED_ZERO'
    result.reason = null
    result.activity = counters
  } else {
    const activityDetected = nonzeroCounters || checks.some((entry) => entry.activityObserved)
    result.status = !runIdentityMatches || activityDetected ? 'FAIL' : 'INCOMPLETE'
    result.reason = !runIdentityMatches
      ? 'provider capture identity contradicts the collector run identity'
      : activityDetected
        ? 'provider capture counters or raw journals show model/provider activity during the no-LLM probe'
      : !windowCoversRun
        ? 'provider capture did not attest continuous coverage from before GENERATION_READY through the collector capture window and terminal outcome'
        : !zeroCounters
          ? 'provider capture activity counters are missing or not exactly zero'
          : !checks.every((entry) => entry.matches)
            ? 'one or more provider journals were absent, nonempty, changed, or not observed from startup through terminal'
          : !collectorCountersZero
            ? 'collector terminal counters do not independently record zero model calls'
            : 'collector did not observe empty, run-scoped provider journals and zero activity'
  }
  return result
}

function projectTransition(report) {
  const rows = collectorRows(report)
  const transitionInfo = report?.observed?.transition ?? {}
  const commits = rows.filter((row) => eventName(row) === 'VTR_TRANSITION_COMMIT')
  const terminals = rows.filter((row) => eventName(row) === 'VTR_TRANSITION_OUTCOME')
  const verifies = rows.filter((row) => ['VTR_TRANSITION_VERIFY', 'VTR_VERIFY', 'TRANSITION_VERIFY'].includes(eventName(row)))
  if (commits.length !== 1 || terminals.length !== 1) return null
  const commit = commits[0]
  const terminal = terminals[0]
  const commitDetail = commit.detail
  const terminalDetail = terminal.detail
  if (!commitDetail || typeof commitDetail !== 'object' || !terminalDetail || typeof terminalDetail !== 'object') return null
  const projected = structuredClone(commitDetail)
  projected.transitionId = transitionInfo.transitionId
  projected.contractHash = transitionInfo.contractHash
  projected.metrics = structuredClone(transitionInfo.metrics ?? {})
  if (terminalDetail.metrics && typeof terminalDetail.metrics === 'object') Object.assign(projected.metrics, structuredClone(terminalDetail.metrics))
  const rawOutcome = terminalDetail.outcome
  projected.outcome = rawOutcome && typeof rawOutcome === 'object' ? structuredClone(rawOutcome) : null
  if (projected.outcome && verifies.length === 1) {
    const verifyDetail = verifies[0].detail?.verification ?? verifies[0].detail ?? {}
    const verifiedAtMs = Number(projected.outcome.verifiedAtMs ?? verifyDetail.verifiedAtMs)
    if (Number.isFinite(verifiedAtMs) && projected.outcome.verifiedAt === undefined) {
      // This is an exact ISO projection of the recorded deterministic VERIFY timestamp.
      projected.outcome.verifiedAt = new Date(verifiedAtMs).toISOString()
    }
  }
  projected.verification = verifies.length === 1 ? structuredClone(verifies[0].detail?.verification ?? verifies[0].detail ?? {}) : null
  return projected
}

function missionMatches(left, right) {
  return left && right && left.kind === right.kind && left.item === right.item && Number(left.count) === Number(right.count)
}

function probeReadiness({ identity, metadata, transition, bundle }) {
  const missing = []
  const source = metadata?.source ?? {}
  const run = metadata?.run ?? {}
  const mission = metadata?.mission ?? {}
  if (!SHA40_RE.test(identity.sourceSha ?? '')) missing.push('collector source SHA')
  if (!RUN_ID_RE.test(identity.runId ?? '')) missing.push('collector run ID')
  if (typeof identity.generationId !== 'string' || identity.generationId.length === 0) missing.push('collector generation ID')
  if (!identity.worldKey || !identity.worldIdentity) missing.push('collector world identity')
  if (source.repository !== EXPECTED_REPOSITORY) missing.push('run metadata source.repository')
  if (typeof source.branch !== 'string' || source.branch.length === 0) missing.push('run metadata source.branch')
  if (bundle === null) missing.push('generation bundle bytes')
  const runFields = ['runId', 'generationId', 'serverId', 'worldEpoch', 'worldKey', 'dimension', 'levelName', 'seed', 'minecraftVersion', 'dataVersion', 'difficulty', 'gameMode', 'botUsername', 'botUuid', 'startedAt', 'generationReadyAt', 'shutdownAt']
  for (const field of runFields) if (run[field] === undefined || run[field] === null || run[field] === '') missing.push(`run.${field}`)
  for (const field of ['initialInventory', 'finalInventory', 'initialPosition', 'finalPosition']) {
    if (mission[field] === undefined || mission[field] === null) missing.push(`mission.${field}`)
  }
  if (!missionMatches(mission, identity.mission)) missing.push('run metadata mission matching collector mission')
  if (transition === null) missing.push('one bound commit and terminal event in collector report')
  return [...new Set(missing)]
}

function collectIdentityConflicts(value, identity, path = '$', out = []) {
  if (!value || typeof value !== 'object') return out
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectIdentityConflicts(item, identity, `${path}[${index}]`, out))
    return out
  }
  for (const [key, child] of Object.entries(value)) {
    if (['sourceSha', 'bootSourceSha', 'sourceCommit'].includes(key) && typeof child === 'string' && child.toLowerCase() !== identity.sourceSha) out.push({ path: `${path}.${key}`, expected: identity.sourceSha, observed: child })
    if (key === 'runId' && typeof child === 'string' && identity.runId && child !== identity.runId) out.push({ path: `${path}.${key}`, expected: identity.runId, observed: child })
    if (key === 'generationId' && typeof child === 'string' && identity.generationId && child !== identity.generationId) out.push({ path: `${path}.${key}`, expected: identity.generationId, observed: child })
    if (key === 'worldEpoch' && Number.isSafeInteger(child) && Number.isSafeInteger(identity.worldIdentity?.worldEpoch) && child !== identity.worldIdentity.worldEpoch) out.push({ path: `${path}.${key}`, expected: identity.worldIdentity.worldEpoch, observed: child })
    if (key === 'worldKey' && child !== null && child !== undefined && !sameWorldKey(child, identity.worldKey)) out.push({ path: `${path}.${key}`, expected: identity.worldKey, observed: child })
    collectIdentityConflicts(child, identity, `${path}.${key}`, out)
  }
  return out
}

function makeProbe({ report, identity, metadata, transition, bundle, providerCaptureResult }) {
  const sourceMeta = metadata.source
  const run = structuredClone(metadata.run)
  const mission = structuredClone(metadata.mission)
  // These primary pins are copied from the already-pinned collector identity;
  // the corresponding run-metadata values have been checked for disagreement.
  run.runId = identity.runId
  run.generationId = identity.generationId
  run.worldKey = worldKeyString(identity.worldKey)
  run.serverId = identity.worldIdentity.serverId
  run.worldEpoch = identity.worldIdentity.worldEpoch
  const noLlmMeta = metadata.configuredNoLlmProbe && typeof metadata.configuredNoLlmProbe === 'object'
    ? structuredClone(metadata.configuredNoLlmProbe)
    : {}
  const collectorNoLlm = report.observed?.configuredNoLlmProbe ?? {}
  const noLlmJev = noLlmMeta.effectiveJev && typeof noLlmMeta.effectiveJev === 'object' && !Array.isArray(noLlmMeta.effectiveJev) ? noLlmMeta.effectiveJev : null
  const noLlmSystem2 = noLlmMeta.effectiveSystem2 && typeof noLlmMeta.effectiveSystem2 === 'object' && !Array.isArray(noLlmMeta.effectiveSystem2) ? noLlmMeta.effectiveSystem2 : null
  const noLlmFallback = noLlmMeta.fallback && typeof noLlmMeta.fallback === 'object' && !Array.isArray(noLlmMeta.fallback) ? noLlmMeta.fallback : null
  const config = {
    ...noLlmMeta,
    BUDDY_POLICY: noLlmMeta.BUDDY_POLICY ?? collectorNoLlm.BUDDY_POLICY ?? null,
    BUDDY_SYSTEM2: noLlmMeta.BUDDY_SYSTEM2 ?? collectorNoLlm.BUDDY_SYSTEM2 ?? null,
    effectiveJev: noLlmJev ?? { provider: collectorNoLlm.effectiveJevProvider ?? null },
    effectiveSystem2: noLlmSystem2 ?? { provider: collectorNoLlm.effectiveSystem2Provider ?? null },
  }
  if (providerCaptureResult.status === 'OBSERVED_ZERO') {
    config.networkModelCalls = 0
    config.effectiveJev.decisionCalls = 0
    config.effectiveSystem2.decisionCalls = 0
    config.fallback = {
      ...noLlmFallback,
      fallbackPolicyWasExplicitlyConfigured: noLlmFallback?.fallbackPolicyWasExplicitlyConfigured,
      silentFallbackOnProviderFailure: noLlmFallback?.silentFallbackOnProviderFailure,
      JevDecisionInvoked: noLlmFallback?.JevDecisionInvoked,
    }
  } else {
    config.networkModelCalls = null
  }
  const missionProjection = {
    kind: mission.kind,
    item: mission.item,
    count: mission.count,
    initialInventory: mission.initialInventory,
    finalInventory: mission.finalInventory,
    initialPosition: mission.initialPosition,
    finalPosition: mission.finalPosition,
  }
  if (mission.missionCompletion !== undefined) missionProjection.missionCompletion = mission.missionCompletion
  return {
    source: {
      repository: sourceMeta.repository,
      commit: identity.sourceSha,
      branch: sourceMeta.branch,
      buildHash: report.observed?.generationReady?.buildHash ?? null,
      bundleBytes: bundle?.length ?? null,
      bundleSha256: bundle === null ? null : sha256(bundle),
    },
    run,
    mission: missionProjection,
    transition,
    fixture: metadata.fixture ?? null,
    configuredNoLlmProbe: config,
    artifacts: { generationBundle: 'runner/generation-bundle.mjs' },
    collector: {
      schema: report.schema,
      status: report.status,
      capturedAt: report.capturedAt,
      captureWindow: report.captureWindow ?? null,
    },
  }
}

function writeFile(outputRoot, relativePath, bytes) {
  const target = join(outputRoot, relativePath)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 })
}

export function packageVtrReachArchive({ collectorReportPath, manifestPath, archivePath }) {
  const collectorReportFile = resolve(collectorReportPath)
  const manifestFile = resolve(manifestPath)
  const outputRoot = resolve(archivePath)
  if (existsSync(outputRoot)) throw new Error(`archive destination already exists: ${outputRoot}`)
  const report = readJson(collectorReportFile, 'collector report')
  const manifest = readJson(manifestFile, 'input manifest')
  if (manifest.schema !== 'vtr-reach-live-archive-input/v1') throw new Error('manifest schema must be vtr-reach-live-archive-input/v1')
  if (!manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) throw new Error('manifest.files must map archive-relative paths to captured source files')

  mkdirSync(outputRoot, { recursive: false, mode: 0o700 })
  const statuses = []
  const archiveFiles = new Set()
  const copiedSources = new Map()
  const manifestDir = dirname(manifestFile)
  const collectorDir = dirname(collectorReportFile)
  const identity = identityFromCollector(report)
  identity.mission = report.expected?.mission ?? null
  if (report.schema !== 'vtr-reach-live-collector/v1') check(statuses, 'FAIL', 'collector-schema', { expected: 'vtr-reach-live-collector/v1', observed: report.schema ?? null })
  if (!['PASS', 'INCOMPLETE', 'FAIL'].includes(report.status)) check(statuses, 'FAIL', 'collector-status', { reason: 'collector report status is missing or invalid', observed: report.status ?? null })
  else if (report.status === 'INCOMPLETE') check(statuses, 'INCOMPLETE', 'collector-status', { status: report.status })
  else if (report.status === 'FAIL') check(statuses, 'FAIL', 'collector-status', { status: report.status })
  for (const entry of report.checks ?? []) {
    if (entry.status === 'FAIL') check(statuses, 'FAIL', `collector-check:${entry.id ?? 'unknown'}`, { detail: entry })
    else if (entry.status === 'INCOMPLETE') check(statuses, 'INCOMPLETE', `collector-check:${entry.id ?? 'unknown'}`, { detail: entry })
  }
  if (report.expected?.sourceSha && identity.sourceSha && report.expected.sourceSha.toLowerCase() !== identity.sourceSha) {
    check(statuses, 'FAIL', 'collector-source-pin', { expected: report.expected.sourceSha, observed: identity.sourceSha })
  }
  const sourceInputs = report.inputs ?? []
  const knownInputs = new Map(sourceInputs.map((input) => [input?.name, input]))

  const collectorBytes = readFileSync(collectorReportFile)
  writeFile(outputRoot, 'collector-report.json', collectorBytes)
  archiveFiles.add('collector-report.json')

  // Preserve raw collector inputs only if they existed during collection and
  // remain byte-for-byte identical. A missing source is never replaced by a
  // zero-byte placeholder.
  for (const [name, archiveRelative] of Object.entries(COLLECTOR_INPUT_PATHS)) {
    const recorded = knownInputs.get(name)
    if (!recorded || recorded.status !== 'captured') {
      check(statuses, 'INCOMPLETE', `collector-input:${name}`, { reason: 'collector did not record this source as captured', recordedStatus: recorded?.status ?? 'absent', archivePath: archiveRelative })
      continue
    }
    const path = sourcePath(recorded.path, collectorDir)
    const bytes = path ? regularFileBytes(path) : null
    if (bytes === null) {
      check(statuses, 'INCOMPLETE', `collector-input:${name}`, { reason: 'captured source path is now absent, non-regular, or a symlink', archivePath: archiveRelative })
      continue
    }
    const digest = sha256(bytes)
    if (bytes.length !== recorded.bytes || digest !== String(recorded.sha256 ?? '').toLowerCase()) {
      check(statuses, 'FAIL', `collector-input:${name}`, { reason: 'source no longer matches the bytes/hash captured in the collector report', expectedBytes: recorded.bytes ?? null, observedBytes: bytes.length, expectedSha256: recorded.sha256 ?? null, observedSha256: digest })
    } else check(statuses, 'PASS', `collector-input:${name}`, { archivePath: archiveRelative, bytes: bytes.length, sha256: digest })
    writeFile(outputRoot, archiveRelative, bytes)
    archiveFiles.add(archiveRelative)
    copiedSources.set(archiveRelative, { bytes, path })
  }

  for (const [archiveRelative, sourceValue] of Object.entries(manifest.files)) {
    if (!safeArchivePath(archiveRelative)) {
      check(statuses, 'FAIL', 'manifest-path', { archivePath: archiveRelative, reason: 'archive path is not a safe relative path' })
      continue
    }
    if (archiveRelative === 'probe.json' || archiveRelative === 'SHA256SUMS' || archiveRelative === 'packaging-report.json' || archiveRelative === 'collector-report.json') {
      check(statuses, 'FAIL', 'manifest-path', { archivePath: archiveRelative, reason: 'path is reserved for adapter output' })
      continue
    }
    if (archiveFiles.has(archiveRelative)) {
      check(statuses, 'FAIL', `duplicate-archive-path:${archiveRelative}`, { reason: 'manifest would replace a raw collector input' })
      continue
    }
    const source = sourcePath(sourceValue, manifestDir)
    const bytes = source ? regularFileBytes(source) : null
    if (bytes === null) {
      check(statuses, 'INCOMPLETE', `manifest-file:${archiveRelative}`, { reason: 'source is absent, non-regular, or a symlink' })
      continue
    }
    writeFile(outputRoot, archiveRelative, bytes)
    archiveFiles.add(archiveRelative)
    copiedSources.set(archiveRelative, { bytes, path: source })
    check(statuses, 'PASS', `manifest-file:${archiveRelative}`, { bytes: bytes.length, sha256: sha256(bytes) })

    if (archiveRelative.endsWith('.json')) {
      try {
        const document = JSON.parse(bytes.toString('utf8'))
        const conflicts = collectIdentityConflicts(document, identity)
        if (conflicts.length) check(statuses, 'FAIL', `identity:${archiveRelative}`, { reason: 'structured artifact contains source/run/world identity conflicting with collector', conflicts })
      } catch (error) {
        check(statuses, 'FAIL', `json:${archiveRelative}`, { reason: error.message })
      }
    } else if (archiveRelative.endsWith('.jsonl')) {
      try {
        const rows = recordsInJournal(bytes, archiveRelative)
        const conflicts = collectIdentityConflicts(rows, identity)
        if (conflicts.length) check(statuses, 'FAIL', `identity:${archiveRelative}`, { reason: 'journal rows contain source/run/world identity conflicting with collector', conflicts })
      } catch (error) {
        check(statuses, 'FAIL', `jsonl:${archiveRelative}`, { reason: error.message })
      }
    }
  }

  for (const requiredPath of REQUIRED_ARCHIVE_PATHS) {
    if (!archiveFiles.has(requiredPath)) check(statuses, 'INCOMPLETE', `required:${requiredPath}`, { reason: 'no run-scoped source artifact was supplied for this validator input' })
  }

  const metadataBytes = copiedSources.get('runner/run-metadata.json')?.bytes ?? null
  let metadata = null
  if (metadataBytes !== null) {
    try { metadata = JSON.parse(metadataBytes.toString('utf8')) } catch { metadata = null }
  }
  const captureBytes = copiedSources.get('runner/provider-activity-capture.json')?.bytes ?? null
  let providerCapture = null
  if (captureBytes !== null) {
    try { providerCapture = JSON.parse(captureBytes.toString('utf8')) } catch { providerCapture = null }
  }
  const transitionRows = collectorRows(report)
  const providerCaptureResult = inspectProviderCapture({
    capture: providerCapture,
    identity,
    copiedSources,
    collectorReport: report,
    transitionRows,
    run: metadata?.run,
  })
  if (providerCaptureResult.status === 'OBSERVED_ZERO') check(statuses, 'PASS', 'provider-activity-zero', { status: providerCaptureResult.status, window: providerCaptureResult.window, activity: providerCaptureResult.activity })
  else check(statuses, providerCaptureResult.status === 'FAIL' ? 'FAIL' : 'INCOMPLETE', 'provider-activity-zero', { status: providerCaptureResult.status, reason: providerCaptureResult.reason })

  const bundle = copiedSources.get('runner/generation-bundle.mjs')?.bytes ?? null
  const transition = projectTransition(report)
  const readinessMissing = probeReadiness({ identity, metadata, transition, bundle })
  const run = metadata?.run ?? {}
  const runIdentityConflicts = []
  for (const [field, expected] of Object.entries({
    runId: identity.runId,
    generationId: identity.generationId,
    worldKey: identity.worldKey,
    serverId: identity.worldIdentity?.serverId,
    worldEpoch: identity.worldIdentity?.worldEpoch,
  })) {
    const observed = run[field]
    if (observed === undefined || observed === null) readinessMissing.push(`run metadata.${field}`)
    else if (field === 'worldKey' ? !sameWorldKey(observed, expected)
      : field === 'dimension' ? String(observed).replace(/^minecraft:/u, '') !== String(identity.worldIdentity?.dimension ?? '').replace(/^minecraft:/u, '')
        : observed !== expected) runIdentityConflicts.push({ field, expected, observed })
  }
  if (run.dimension === undefined || run.dimension === null) readinessMissing.push('run metadata.dimension')
  else if (String(run.dimension).replace(/^minecraft:/u, '') !== String(identity.worldIdentity?.dimension ?? '').replace(/^minecraft:/u, '')) runIdentityConflicts.push({ field: 'dimension', expected: identity.worldIdentity?.dimension, observed: run.dimension })
  if (runIdentityConflicts.length) check(statuses, 'FAIL', 'run-metadata-identity', { conflicts: runIdentityConflicts })
  else if (!readinessMissing.length) check(statuses, 'PASS', 'run-metadata-identity', { sourceSha: identity.sourceSha, runId: identity.runId, generationId: identity.generationId, worldKey: identity.worldKey })
  else check(statuses, 'INCOMPLETE', 'probe-projection-readiness', { missing: [...new Set(readinessMissing)] })

  const sourceMeta = metadata?.source ?? {}
  if (sourceMeta.commit !== undefined && (typeof sourceMeta.commit !== 'string' || sourceMeta.commit.toLowerCase() !== identity.sourceSha)) check(statuses, 'FAIL', 'source-metadata-identity', { expected: identity.sourceSha, observed: sourceMeta.commit })
  if (sourceMeta.buildHash !== undefined && sourceMeta.buildHash !== report.observed?.generationReady?.buildHash) check(statuses, 'FAIL', 'source-build-identity', { expected: report.observed?.generationReady?.buildHash ?? null, observed: sourceMeta.buildHash })
  if (bundle !== null && typeof report.observed?.generationReady?.buildHash === 'string' && !sha256(bundle).startsWith(report.observed.generationReady.buildHash.toLowerCase())) {
    check(statuses, 'FAIL', 'generation-bundle-build-hash', { expectedPrefix: report.observed.generationReady.buildHash, observedSha256: sha256(bundle) })
  }
  const serverStartBytes = copiedSources.get('server/server-start.json')?.bytes ?? null
  if (serverStartBytes !== null) {
    try {
      const serverStart = JSON.parse(serverStartBytes.toString('utf8'))
      const launch = copiedSources.get('server/server.properties.launch')?.bytes ?? copiedSources.get('server/server.properties.clean')?.bytes ?? null
      const effective = copiedSources.get('server/server.properties.effective-after-boot')?.bytes ?? copiedSources.get('server/server.properties.clean')?.bytes ?? null
      if (typeof serverStart.serverPropertiesSha256 === 'string' && launch !== null && sha256(launch) !== serverStart.serverPropertiesSha256.toLowerCase()) {
        check(statuses, 'FAIL', 'server-launch-config-hash', { expected: serverStart.serverPropertiesSha256, observed: sha256(launch) })
      } else if (launch === null || typeof serverStart.serverPropertiesSha256 !== 'string') check(statuses, 'INCOMPLETE', 'server-launch-config-hash', { reason: 'launch config or its server-start hash is absent' })
      if (typeof serverStart.serverPropertiesEffectiveSha256 === 'string' && effective !== null && sha256(effective) !== serverStart.serverPropertiesEffectiveSha256.toLowerCase()) {
        check(statuses, 'FAIL', 'server-effective-config-hash', { expected: serverStart.serverPropertiesEffectiveSha256, observed: sha256(effective) })
      } else if (effective === null || typeof serverStart.serverPropertiesEffectiveSha256 !== 'string') check(statuses, 'INCOMPLETE', 'server-effective-config-hash', { reason: 'post-boot effective config or its server-start hash is absent' })
    } catch (error) {
      check(statuses, 'FAIL', 'server-start-json', { reason: error.message })
    }
  }
  if (metadata && runIdentityConflicts.length === 0 && readinessMissing.length === 0 && archiveFiles.has('runner/run-metadata.json')) {
    const probe = makeProbe({ report, identity, metadata, transition, bundle, providerCaptureResult })
    const mismatch = []
    if (probe.source.commit !== identity.sourceSha) mismatch.push('source.commit')
    if (probe.run.runId !== identity.runId || probe.run.generationId !== identity.generationId) mismatch.push('run identity')
    if (!missionMatches(probe.mission, identity.mission)) mismatch.push('mission')
    if (mismatch.length) check(statuses, 'FAIL', 'probe-projection-binding', { mismatch })
    else {
      const probeBytes = Buffer.from(`${JSON.stringify(probe, null, 2)}\n`)
      writeFile(outputRoot, 'probe.json', probeBytes)
      archiveFiles.add('probe.json')
      check(statuses, 'PASS', 'probe-projection', { archivePath: 'probe.json', transitionId: transition.transitionId, sourceSha: identity.sourceSha, runId: identity.runId, generationId: identity.generationId, worldKey: identity.worldKey })
    }
  } else if (!archiveFiles.has('probe.json')) {
    check(statuses, 'INCOMPLETE', 'probe-projection', { reason: 'raw run metadata does not contain all fields needed for an honest validator manifest', missing: [...new Set(readinessMissing)] })
  }

  // Make the absence of full migration comparison proofs visible without
  // treating a capability probe as full P0 acceptance.
  const fullMilestoneMissing = ['proofs/no-double-authority.json', 'comparison/legacy-baseline.json'].filter((path) => !archiveFiles.has(path))
  const failed = statuses.some((entry) => entry.status === 'FAIL')
  const incomplete = statuses.some((entry) => entry.status === 'INCOMPLETE') || report.status === 'INCOMPLETE'
  const packageStatus = failed || report.status === 'FAIL' ? 'FAIL' : incomplete ? 'INCOMPLETE' : 'READY_FOR_VALIDATION'
  const packageReport = {
    schema: 'vtr-reach-live-archive-package/v1',
    packageStatus,
    acceptanceEligible: false,
    readOnly: true,
    collectorReport: { schema: report.schema ?? null, status: report.status ?? null, capturedAt: report.capturedAt ?? null },
    identity: { sourceSha: identity.sourceSha, runId: identity.runId, generationId: identity.generationId, worldKey: identity.worldKey },
    providerActivity: providerCaptureResult,
    requiredValidatorPaths: REQUIRED_ARCHIVE_PATHS,
    fullMigrationArtifactsMissing: fullMilestoneMissing,
    checks: statuses,
    files: [...archiveFiles].sort(),
  }
  writeFile(outputRoot, 'packaging-report.json', Buffer.from(`${JSON.stringify(packageReport, null, 2)}\n`))
  archiveFiles.add('packaging-report.json')
  const manifestText = [...archiveFiles].sort().map((path) => `${sha256(readFileSync(join(outputRoot, path)))}  ${path}`).join('\n') + '\n'
  writeFile(outputRoot, 'SHA256SUMS', Buffer.from(manifestText))
  return { report: packageReport, outputRoot }
}

async function main(argv) {
  let options
  try { options = parseArgs(argv) } catch (error) {
    process.stderr.write(`${error.message}\n${HELP}`)
    return 64
  }
  if (options.help) {
    process.stdout.write(HELP)
    return 0
  }
  try {
    const result = packageVtrReachArchive(options)
    process.stdout.write(`${JSON.stringify({ packageStatus: result.report.packageStatus, archive: result.outputRoot, sourceSha: result.report.identity.sourceSha, runId: result.report.identity.runId, generationId: result.report.identity.generationId })}\n`)
    return result.report.packageStatus === 'FAIL' ? 1 : result.report.packageStatus === 'INCOMPLETE' ? 2 : 0
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 64
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main(process.argv.slice(2))
