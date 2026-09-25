#!/usr/bin/env node
// HOST-side lifecycle coordinator for one isolated no-LLM VTR Reach probe.
// It does not own VTR decisions or issue gameplay commands. Runtime lifecycle,
// capture, collection, archive sealing and validation are explicit adapters.

import { createHash } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { parseHostLog, parseJsonl } from './collect-vtr-reach-live.mjs'

export const VTR_REACH_PROBE_SUPERVISOR_SCHEMA = 'vtr-reach-probe-supervisor/v1'
export const HOST_LIFECYCLE_TRANSCRIPT_SCHEMA = 'vtr-reach-probe-lifecycle/v1'
// 25576 is reserved by the local diagnostic Leaf service in this workspace.
// Keep the generic isolated-probe default on the separate 25577 port and fail
// closed if a caller tries to target the reserved diagnostic listener.
export const ISOLATED_PROBE_SERVER_PORT = 25577
export const PROTECTED_SERVER_PORTS = Object.freeze([25565, 25570, 25572, 25576])
export const REQUIRED_ATTEMPT_SINKS = Object.freeze([
  'host-log',
  'run-journal',
  'jev-calls',
  'jev-decisions',
  'system2-journal',
  'mercury-calls',
])
export const REQUIRED_PROVIDER_JOURNALS = Object.freeze([
  'jev-calls',
  'jev-decisions',
  'system2-journal',
  'mercury-calls',
])

const SHA40_RE = /^[0-9a-f]{40}$/iu
const SHA256_RE = /^[0-9a-f]{64}$/iu
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
const NOFOLLOW = constants.O_NOFOLLOW ?? 0
const SAFE_FIXTURE_FAILURE_CODES = new Set([
  'LEAF_FIXTURE_CONSOLE_SMOKE_RESPONSE_TIMEOUT',
  'LEAF_FIXTURE_FILL_RESPONSE_TIMEOUT',
  'LEAF_FIXTURE_SETBLOCK_RESPONSE_TIMEOUT',
  'LEAF_FIXTURE_STDIN_WRITE_FAILED',
])
const SAFE_FIXTURE_FAILURE_PHASES = new Set([
  'fixture.console-smoke',
  'fixture.fill',
  'fixture.setblock',
])

class ProbeSupervisorError extends Error {
  constructor(message, code = 'PROBE_SUPERVISOR_ERROR') {
    super(message)
    this.name = 'ProbeSupervisorError'
    this.code = code
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function fail(message) {
  throw new ProbeSupervisorError(message)
}

function safeErrorDescription(error) {
  if (error instanceof ProbeSupervisorError) return error.message
  const name = error instanceof Error ? error.name : 'Error'
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/u.test(error.code) ? error.code : null
  const phase = SAFE_FIXTURE_FAILURE_PHASES.has(error?.phase) ? error.phase : null
  if (code !== null && SAFE_FIXTURE_FAILURE_CODES.has(code) && phase !== null) {
    return `adapter failure (${name}, ${code}, ${phase})`
  }
  return code === null ? `adapter/system failure (${name})` : `adapter/system failure (${name}, ${code})`
}

function safeErrorDetails(error) {
  const name = error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(error.name) ? error.name : 'Error'
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/u.test(error.code) ? error.code : null
  const phase = SAFE_FIXTURE_FAILURE_PHASES.has(error?.phase) ? error.phase : null
  return { name, code, phase }
}

function whitelist(source, fields) {
  if (!isPlainObject(source)) return null
  return Object.fromEntries(fields.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]))
}

function safeResidentStop(value) {
  return {
    ...whitelist(value, ['pid', 'serverId', 'status', 'controlSocketReleased', 'hostLockReleased', 'exitCode', 'signal', 'stoppedAt']),
    ...(value?.processExitObservation === undefined ? {} : { processExitObservation: safeProcessExitObservation(value.processExitObservation) }),
  }
}

function safeLeafStop(value) {
  return {
    ...whitelist(value, ['status', 'port', 'serverId', 'pid', 'exitCode', 'signal', 'stoppedAt']),
    ...(value?.processExitObservation === undefined ? {} : { processExitObservation: safeProcessExitObservation(value.processExitObservation) }),
    ...(value?.listenerClosureObservation === undefined ? {} : { listenerClosureObservation: safeListenerClosureObservation(value.listenerClosureObservation) }),
  }
}

function safeProcessExitObservation(value) {
  return whitelist(value, ['schema', 'source', 'state', 'pid', 'exitCode', 'observedAt'])
}

function safeListenerClosureObservation(value) {
  return whitelist(value, ['schema', 'source', 'state', 'host', 'port', 'result', 'observedAt'])
}

function safeArtifactDescriptor(value) {
  return whitelist(value, ['status', 'path', 'reportPath', 'sha256', 'archivePath', 'packageStatus', 'acceptanceEligible'])
}

function safeObserverUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return null
  let url
  try { url = new URL(value) } catch { return null }
  if (!['http:', 'https:'].includes(url.protocol)
    || !LOOPBACK_HOSTS.has(url.hostname.toLowerCase())
    || url.pathname !== '/api/ai-summary'
    || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return null
  return `${url.origin}${url.pathname}`
}

function observerSummaryForIdentity(summary, identity, maxFreshnessMs) {
  if (!isPlainObject(summary) || !isPlainObject(summary.status) || !isPlainObject(summary.run)) {
    return { status: 'WAIT', reason: 'observer summary has no status/run objects' }
  }
  const sourceSha = String(summary.run.sourceCommit ?? summary.run.sourceSha ?? '').toLowerCase()
  const runId = summary.run.id
  const generationId = summary.run.generationId
  const worldKey = jsonWorldKey(summary.run.worldKey)
  const freshnessMs = summary.freshnessMs ?? summary.status.freshnessMs
  if (summary.status.available !== true || summary.status.connected !== true) {
    return { status: 'WAIT', reason: 'observer is not available and connected' }
  }
  if (sourceSha !== identity.sourceSha || runId !== identity.runId
    || generationId !== identity.generationId || worldKey !== identity.worldKey) {
    return { status: 'WAIT', reason: 'observer summary has not reached the exact source/run/generation/world identity' }
  }
  if (!Number.isFinite(freshnessMs) || freshnessMs < 0 || freshnessMs > maxFreshnessMs) {
    return { status: 'WAIT', reason: 'observer summary is stale or lacks freshnessMs' }
  }
  return {
    status: 'READY',
    summary: {
      available: true,
      connected: true,
      sourceSha,
      runId,
      generationId,
      worldKey,
      freshnessMs,
    },
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function jsonWorldKey(value) {
  if (typeof value === 'string') {
    const parts = value.split('|')
    if (parts.length !== 3 || !parts[0] || !parts[1] || !/^\d+$/u.test(parts[2])) return null
    return `${parts[0]}|${parts[1].replace(/^minecraft:/u, '')}|${Number(parts[2])}`
  }
  if (!isPlainObject(value)
    || typeof value.serverId !== 'string' || value.serverId.length === 0
    || typeof value.dimension !== 'string' || value.dimension.length === 0
    || !Number.isSafeInteger(value.worldEpoch)) return null
  return `${value.serverId}|${value.dimension.replace(/^minecraft:/u, '')}|${value.worldEpoch}`
}

function inside(root, candidate) {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function assertRealDirectory(path, label) {
  let stat
  try { stat = lstatSync(path) } catch (error) { fail(`${label} is unavailable (${error?.code ?? 'read-error'})`) }
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`${label} must be a real directory`)
  return stat
}

function ensureDirectoryChain(root, directory) {
  if (!inside(root, directory)) fail(`attempt sink parent escapes attempt root: ${directory}`)
  const relativeDirectory = relative(root, directory)
  let current = root
  for (const part of relativeDirectory.split(sep).filter(Boolean)) {
    current = resolve(current, part)
    try {
      const stat = lstatSync(current)
      if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`attempt sink parent is not a real directory: ${current}`)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      mkdirSync(current, { mode: 0o700 })
      const stat = lstatSync(current)
      if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`could not create a real attempt sink directory: ${current}`)
    }
  }
}

/**
 * Create fresh, real, zero-byte HOST attempt sinks. Existing paths are always
 * rejected; a previous run is never truncated or reinterpreted as zero calls.
 */
export function prepareZeroByteAttemptSinks({ attemptRoot, paths }) {
  if (typeof attemptRoot !== 'string' || attemptRoot.length === 0) fail('attemptRoot is required')
  if (!isPlainObject(paths)) fail('attempt sink path map is required')
  const root = resolve(attemptRoot)
  assertRealDirectory(root, 'attemptRoot')
  for (const name of REQUIRED_ATTEMPT_SINKS) {
    if (typeof paths[name] !== 'string' || paths[name].length === 0) fail(`attempt sink path is required: ${name}`)
  }
  const resolvedPaths = Object.fromEntries(REQUIRED_ATTEMPT_SINKS.map((name) => [name, resolve(paths[name])]))
  const uniquePaths = new Set(Object.values(resolvedPaths))
  if (uniquePaths.size !== REQUIRED_ATTEMPT_SINKS.length) fail('attempt sink paths must be unique')
  for (const [name, sink] of Object.entries(resolvedPaths)) {
    if (!inside(root, sink) || sink === root) fail(`attempt sink must remain inside attemptRoot: ${name}`)
    ensureDirectoryChain(root, dirname(sink))
    let fd
    try {
      fd = openSync(sink, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NOFOLLOW, 0o600)
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.size !== 0 || stat.nlink !== 1) fail(`attempt sink is not a fresh regular empty file: ${name}`)
    } catch (error) {
      if (error?.code === 'EEXIST') fail(`attempt sink already exists; refusing to overwrite stale evidence: ${name}`)
      throw error
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
    const stat = lstatSync(sink)
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== 0) fail(`attempt sink failed post-create verification: ${name}`)
  }
  return Object.fromEntries(REQUIRED_ATTEMPT_SINKS.map((name) => [name, {
    path: resolvedPaths[name],
    bytes: 0,
    sha256: sha256(Buffer.alloc(0)),
  }]))
}

/** Paths used by the resident's current append-only run/provider writers. */
export function runtimeAttemptSinkPaths(runtimeDir) {
  if (typeof runtimeDir !== 'string' || runtimeDir.length === 0) fail('runtimeDir is required')
  const root = resolve(runtimeDir)
  const logDir = resolve(root, 'logs', 'jev')
  return {
    'host-log': resolve(root, 'buddy.log'),
    'run-journal': resolve(logDir, 'run.jsonl'),
    'jev-calls': resolve(logDir, 'jev-calls.jsonl'),
    'jev-decisions': resolve(logDir, 'decisions.jsonl'),
    'system2-journal': resolve(logDir, 'system2.jsonl'),
    'mercury-calls': resolve(logDir, 'mercury-calls.jsonl'),
  }
}

function parseHostEvents(hostLogPath) {
  let text
  try { text = readFileSync(hostLogPath, 'utf8') } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  return parseHostLog(text)
}

function identityFromHostRows(rows, expectedSourceSha) {
  const boots = rows.filter((row) => row.event === 'BOOT')
  if (boots.length === 0) return { status: 'WAIT', reason: 'waiting for BOOT' }
  if (boots.length !== 1) fail(`attempt host log must contain exactly one BOOT row; observed=${boots.length}`)
  const boot = boots[0]
  const sourceSha = String(boot.fields.sourceSha ?? boot.fields.source ?? '').toLowerCase()
  if (!SHA40_RE.test(sourceSha)) fail('BOOT does not include a valid exact source SHA')
  if (sourceSha !== expectedSourceSha.toLowerCase()) fail(`BOOT source SHA mismatch: expected ${expectedSourceSha}, observed ${sourceSha}`)
  const runId = boot.fields.runId
  if (typeof runId !== 'string' || runId.length === 0) fail('BOOT runId is missing')
  if (!Number.isFinite(boot.ts)) fail('BOOT timestamp is missing or malformed')
  const worldKey = jsonWorldKey(boot.fields.worldKey)
  if (worldKey === null) fail('BOOT worldKey is missing or malformed')
  return { status: 'BOOTED', sourceSha, runId, worldKey, bootAt: boot.ts }
}

function readyIdentity(rows, bootIdentity) {
  const matches = rows.filter((row) => row.event === 'GENERATION_READY'
    && row.fields.runId === bootIdentity.runId
    && String(row.fields.sourceSha ?? '').toLowerCase() === bootIdentity.sourceSha)
  if (matches.length === 0) return null
  if (matches.length !== 1) fail(`attempt must produce exactly one GENERATION_READY for the probe generation; observed=${matches.length}`)
  const ready = matches[0]
  if (ready.fields.productionPlanAuthority !== 'vtr-reach-probe'
    || ready.fields.policy !== 'fallback'
    || ready.fields.policyProvider !== 'deterministic'
    || ready.fields.system2Provider !== 'none') {
    fail('GENERATION_READY does not attest the configured VTR no-LLM probe authority')
  }
  const generationId = ready.fields.generationId ?? ready.fields.id
  if (typeof generationId !== 'string' || generationId.length === 0) fail('GENERATION_READY id is missing')
  if (bootIdentity.bootAt !== null && ready.ts !== null && ready.ts < bootIdentity.bootAt) fail('GENERATION_READY predates BOOT')
  return { ...bootIdentity, generationId, generationReadyAt: ready.ts === null ? null : new Date(ready.ts).toISOString() }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]))
  }
  return value
}

function validateProbeProfile(rows, identity, generationReadyAt) {
  const startAt = Date.parse(new Date(identity.bootAt).toISOString())
  const readyAt = Date.parse(generationReadyAt ?? '')
  const inRunWindow = (row) => row.ts !== null && row.ts >= startAt && row.ts <= readyAt
  const configs = rows.filter((row) => row.event === 'VTR_REACH_PROBE_CONFIGURED' && inRunWindow(row))
  const queues = rows.filter((row) => row.event === 'VTR_REACH_PROBE_QUEUE_EMPTY' && inRunWindow(row))
  if (configs.length !== 1) fail(`no-LLM Reach probe must emit exactly one VTR_REACH_PROBE_CONFIGURED; observed=${configs.length}`)
  if (queues.length !== 1) fail(`no-LLM Reach probe must emit exactly one VTR_REACH_PROBE_QUEUE_EMPTY; observed=${queues.length}`)
  const config = configs[0].fields
  const mission = canonicalJson(config.mission)
  const bootMission = canonicalJson(rows.find((row) => row.event === 'BOOT' && row.fields.runId === identity.runId)?.fields.mission)
  if (JSON.stringify(mission) !== JSON.stringify(bootMission)
    || config.compatibilityLadder !== 'observer-only'
    || config.ledgerRestore !== 'disabled'
    || config.plannerBootstrap !== 'disabled'
    || config.system2Mode !== 'off'
    || config.jevPolicyMode !== 'fallback') {
    fail('VTR Reach probe configuration does not attest the configured no-LLM mission/profile')
  }
  if (queues[0].fields.authority !== 'vtr-transition-scheduler' || String(queues[0].fields.restoredLegacyRows) !== '0') {
    fail('VTR Reach probe legacy queue was not explicitly empty before the generation started')
  }
}

function eventName(row) {
  if (typeof row?.message !== 'string') return null
  return row.message.trim().split(/\s+/u, 1)[0]
}

function transitionId(row) {
  const detail = row?.detail ?? {}
  if (typeof detail.transitionId === 'string' && detail.transitionId) return detail.transitionId
  if (typeof detail.id === 'string' && detail.id) return detail.id
  return /(?:^|\s)id=([^\s]+)/u.exec(String(row?.message ?? ''))?.[1] ?? null
}

function contractHash(row) {
  const detail = row?.detail ?? {}
  const value = detail.contractHash ?? detail.outcome?.contractHash ?? detail.contract?.hash
    ?? /(?:^|\s)contractHash=([^\s]+)/u.exec(String(row?.message ?? ''))?.[1]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function isReachCommit(row) {
  const detail = row?.detail ?? {}
  const candidates = [detail.desiredPredicate, ...(Array.isArray(detail.ensures) ? detail.ensures : [])]
  return candidates.some((candidate) => {
    const kind = candidate?.proposition?.kind ?? candidate?.kind
    const id = candidate?.id
    return (typeof kind === 'string' && /reach/u.test(kind))
      || (typeof id === 'string' && /^reach(?:\.|:|-)/u.test(id))
  })
}

function terminalForRunJournal(runJournalPath, identity) {
  let text
  try { text = readFileSync(runJournalPath, 'utf8') } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'WAIT', reason: 'run journal not materialized' }
    throw error
  }
  const parsed = parseJsonl(text, runJournalPath)
  if (parsed.errors.length > 0) fail(`${runJournalPath} contains malformed JSONL: ${parsed.errors[0].reason}`)
  const rows = parsed.rows.filter((row) => row.record === 'agent-event' && row.source === 'vtr')
  const commits = rows.filter((row) => eventName(row) === 'VTR_TRANSITION_COMMIT'
    && typeof row.ts === 'string'
    && Date.parse(row.ts) >= Date.parse(identity.generationReadyAt ?? '')
    && isReachCommit(row))
  if (commits.length === 0) return { status: 'WAIT', reason: 'waiting for a typed Reach VTR_TRANSITION_COMMIT' }
  if (commits.length > 1) fail(`one probe attempt produced multiple Reach Transition commits; observed=${commits.length}`)
  const commit = commits[0]
  const id = transitionId(commit)
  const hash = contractHash(commit)
  if (id === null || hash === null) fail('Reach commit is missing transition id or contract hash')
  const commitWorldKey = jsonWorldKey(commit.detail?.identity?.worldKey)
  if (commitWorldKey === null || commitWorldKey !== identity.worldKey) fail('Reach commit worldKey differs from BOOT world identity')
  if (commit.detail?.identity?.generationId !== identity.generationId) fail('Reach commit generation differs from GENERATION_READY')
  const commitAt = Date.parse(commit.ts)
  const matchingOutcomes = rows.filter((row) => eventName(row) === 'VTR_TRANSITION_OUTCOME'
    && transitionId(row) === id
    && contractHash(row) === hash
    && Number.isFinite(Date.parse(row.ts))
    && Date.parse(row.ts) > commitAt)
  if (matchingOutcomes.length === 0) return { status: 'WAIT', reason: 'waiting for matching typed Transition outcome' }
  if (matchingOutcomes.length > 1) fail(`Reach Transition has duplicate terminal outcomes; observed=${matchingOutcomes.length}`)
  const outcome = matchingOutcomes[0]
  const typedOutcome = outcome.detail?.outcome
  if (!isPlainObject(typedOutcome) || typeof typedOutcome.kind !== 'string' || typedOutcome.kind.length === 0) {
    fail('VTR_TRANSITION_OUTCOME lacks a typed detail.outcome.kind')
  }
  if (typedOutcome.contractHash !== undefined && typedOutcome.contractHash !== hash) fail('typed outcome contractHash differs from commit')
  const outcomeIdentity = outcome.detail?.identity
  if (!isPlainObject(outcomeIdentity)
    || jsonWorldKey(outcomeIdentity.worldKey) !== identity.worldKey
    || outcomeIdentity.generationId !== identity.generationId
    || outcome.detail?.runId !== identity.runId
    || String(outcome.detail?.sourceSha ?? '').toLowerCase() !== identity.sourceSha) {
    fail('VTR Transition outcome is not bound to this source/run/generation/world identity')
  }
  return {
    status: 'TERMINAL',
    terminal: {
      transitionId: id,
      contractHash: hash,
      outcomeKind: typedOutcome.kind,
      evidenceIds: Array.isArray(typedOutcome.evidenceIds) ? typedOutcome.evidenceIds.filter((value) => typeof value === 'string' && value.length > 0) : [],
      at: outcome.ts,
      row: outcome,
      commit,
    },
  }
}

export function validateIsolatedLeafAttestation(attestation, { attemptRoot, sourceSha, isolatedPort = ISOLATED_PROBE_SERVER_PORT }) {
  if (!isPlainObject(attestation)) fail('isolated Leaf server attestation is required before resident start')
  if (attestation.schema !== 'vtr-reach-isolated-leaf/v1') fail('isolated Leaf server attestation schema is not recognized')
  if (String(attestation.sourceSha ?? '').toLowerCase() !== sourceSha.toLowerCase()) fail('isolated Leaf server source SHA differs from exact probe source')
  if (!LOOPBACK_HOSTS.has(String(attestation.host ?? '').toLowerCase())) fail('isolated Leaf server must bind to loopback')
  if (!Number.isSafeInteger(isolatedPort) || isolatedPort < 1 || isolatedPort > 65535) fail('isolatedPort must be a valid TCP port')
  if (PROTECTED_SERVER_PORTS.includes(isolatedPort)) fail(`refusing protected server port ${isolatedPort}`)
  const port = Number(attestation.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail('isolated Leaf server port is invalid')
  if (PROTECTED_SERVER_PORTS.includes(port)) fail(`refusing protected server port ${port}`)
  if (port !== isolatedPort) fail(`isolated Leaf port must match requested isolated port ${isolatedPort}`)
  if (!Number.isSafeInteger(attestation.pid) || attestation.pid < 1) fail('isolated Leaf PID attestation is missing')
  if (typeof attestation.startedAt !== 'string' || !Number.isFinite(Date.parse(attestation.startedAt))) fail('isolated Leaf process start time is missing')
  if (typeof attestation.worldRoot !== 'string' || attestation.worldRoot.length === 0) fail('isolated Leaf world root is missing')
  const root = realpathSync(resolve(attemptRoot))
  const worldRoot = realpathSync(resolve(attestation.worldRoot))
  if (!inside(root, worldRoot) || worldRoot === root) fail('isolated Leaf world root must be inside this run-scoped attempt root')
  const worldKey = jsonWorldKey(attestation.worldKey)
  if (worldKey === null) fail('isolated Leaf worldKey is missing or malformed')
  const serverId = worldKey.split('|', 1)[0]
  if (!new RegExp(`^(?:127\\.0\\.0\\.1|localhost|\\[::1\\]):${port}$`, 'iu').test(serverId)) {
    fail('isolated Leaf worldKey serverId must identify its attested loopback port')
  }
  for (const key of ['serverPropertiesSha256', 'serverPropertiesEffectiveSha256']) {
    if (typeof attestation[key] !== 'string' || !SHA256_RE.test(attestation[key])) fail(`isolated Leaf ${key} is missing or malformed`)
  }
  for (const key of ['levelName', 'minecraftVersion']) {
    if (typeof attestation[key] !== 'string' || attestation[key].length === 0) fail(`isolated Leaf ${key} is missing`)
  }
  return {
    schema: attestation.schema,
    sourceSha: attestation.sourceSha.toLowerCase(),
    host: attestation.host,
    port,
    pid: attestation.pid,
    startedAt: attestation.startedAt,
    worldRoot,
    worldKey,
    configuration: {
      levelName: attestation.levelName,
      minecraftVersion: attestation.minecraftVersion,
      serverPropertiesSha256: attestation.serverPropertiesSha256.toLowerCase(),
      serverPropertiesEffectiveSha256: attestation.serverPropertiesEffectiveSha256.toLowerCase(),
    },
    attestationPath: typeof attestation.attestationPath === 'string' ? resolve(attestation.attestationPath) : null,
  }
}

function evaluateCaptureEnvelope(capture, {
  expectedSchema,
  expectedStatus,
  identity,
  terminalAtExpected,
  captureArmedAt,
  residentStartedAt,
  serverStoppedAtExpected,
  journalPaths,
  captureJournalNames = Object.fromEntries(REQUIRED_PROVIDER_JOURNALS.map((name) => [name, name])),
}) {
  const checks = []
  const add = (id, status, reason = null) => checks.push({ id, status, ...(reason === null ? {} : { reason }) })
  if (!isPlainObject(capture)) {
    return { status: 'INCOMPLETE', checks: [{ id: 'capture:object', status: 'INCOMPLETE', reason: 'capture adapter returned no object' }] }
  }
  add('capture:schema', capture.schema === expectedSchema ? 'PASS' : 'FAIL', capture.schema === expectedSchema ? null : `expected ${expectedSchema}; observed ${String(capture.schema ?? null)}`)
  add('capture:status', capture.status === expectedStatus ? 'PASS' : capture.status === 'INCOMPLETE' ? 'INCOMPLETE' : 'FAIL', capture.status === expectedStatus ? null : `expected ${expectedStatus}; observed ${String(capture.status ?? null)}`)
  const captureIdentity = capture.identity ?? {}
  const expectedKeys = ['sourceSha', 'runId', 'generationId', 'worldKey']
  for (const key of expectedKeys) {
    const expected = key === 'worldKey' ? identity.worldKey : key === 'sourceSha' ? identity.sourceSha : identity[key]
    const observed = key === 'worldKey' ? jsonWorldKey(captureIdentity.worldKey) : captureIdentity[key]
    const identityStatus = expected === null || expected === undefined ? 'INCOMPLETE' : observed === expected ? 'PASS' : 'FAIL'
    add(`capture:identity:${key}`, identityStatus, identityStatus === 'PASS' ? null : `expected ${String(expected ?? null)}; observed ${String(observed ?? null)}`)
  }
  const window = capture.window ?? {}
  const times = ['startedAt', 'generationReadyAt', 'terminalAt', 'endedAt'].map((key) => Date.parse(window[key] ?? ''))
  const expectedReadyAt = Date.parse(identity.generationReadyAt ?? '')
  const expectedTerminalAt = Date.parse(terminalAtExpected ?? '')
  const armAt = Date.parse(captureArmedAt ?? '')
  const residentAt = Date.parse(residentStartedAt ?? '')
  const hasOrderedWindow = times.every(Number.isFinite)
    && Number.isFinite(expectedReadyAt) && Number.isFinite(expectedTerminalAt)
    && Number.isFinite(armAt) && Number.isFinite(residentAt)
    && times[0] <= residentAt && times[0] <= times[1]
    && times[0] <= times[2] && times[1] === expectedReadyAt
    && Math.abs(times[2] - expectedTerminalAt) <= 5000 && times[1] <= times[2]
    && times[2] <= times[3] && times[3] >= residentAt
    && times[3] >= Date.parse(serverStoppedAtExpected ?? '')
    && times[0] <= armAt && armAt <= residentAt
    && window.coverageComplete === true
  add('capture:full-window', hasOrderedWindow ? 'PASS' : 'INCOMPLETE', hasOrderedWindow ? null : 'capture must explicitly cover arm through generation-ready and typed terminal')
  const activity = capture.activity ?? {}
  for (const counter of ['jevDecisionFrames', 'jevDecisionRecords', 'system2DecisionInvocations']) {
    const value = activity[counter]
    const valid = Number.isSafeInteger(value) && value >= 0
    add(`capture:classified-${counter}`, valid ? 'PASS' : 'INCOMPLETE', valid ? null : `expected a non-negative classified decision count; observed ${String(value ?? null)}`)
  }
  for (const counter of ['networkModelCalls', 'jevEvaluateAttempts', 'system2EvaluateAttempts']) {
    add(`capture:zero-${counter}`, activity[counter] === 0 ? 'PASS' : activity[counter] === undefined ? 'INCOMPLETE' : 'FAIL', activity[counter] === 0 ? null : `expected explicit zero; observed ${String(activity[counter] ?? null)}`)
  }
  const classification = capture.activityClassification ?? {}
  const unknown = classification.unknown
  const unknownIsClear = Array.isArray(unknown) && unknown.length === 0
  add('capture:classified-activity', unknownIsClear ? 'PASS' : Array.isArray(unknown) ? 'FAIL' : 'INCOMPLETE', unknownIsClear ? null : 'provider/decision activity classification must have no unknown rows')
  const classificationAgrees = isPlainObject(classification.decisions) && isPlainObject(classification.providers)
    && ['jevDecisionFrames', 'jevDecisionRecords', 'system2DecisionInvocations'].every((key) => classification.decisions[key] === activity[key])
    && ['jevEvaluateAttempts', 'system2EvaluateAttempts', 'networkModelCalls'].every((key) => classification.providers[key] === activity[key])
  add('capture:classification-counters-agree', classificationAgrees ? 'PASS' : 'FAIL', classificationAgrees ? null : 'summary counters differ from journal-derived activity classification')
  const noProviderActivity = classification.positiveProviderActivityObserved === false
    && activity.jevEvaluateAttempts === 0 && activity.system2EvaluateAttempts === 0
  add('capture:no-provider-activity', noProviderActivity ? 'PASS' : classification.positiveProviderActivityObserved === undefined ? 'INCOMPLETE' : 'FAIL', noProviderActivity ? null : 'provider activity was observed or the explicit zero-attempt classification is missing')
  const captureDetails = capture.capture ?? {}
  const problemsClear = Array.isArray(captureDetails.problems) && captureDetails.problems.length === 0
  add('capture:monitor-problems', problemsClear ? 'PASS' : Array.isArray(captureDetails.problems) ? 'FAIL' : 'INCOMPLETE', problemsClear ? null : 'capture must explicitly report zero monitor problems')
  add('capture:no-provider-activity-flag', captureDetails.observedProviderActivity === false ? 'PASS' : captureDetails.observedProviderActivity === true ? 'FAIL' : 'INCOMPLETE', captureDetails.observedProviderActivity === false ? null : 'capture must explicitly report no provider activity')
  const finishedAt = Date.parse(captureDetails.finishedAt ?? '')
  const serverStoppedAt = Date.parse(serverStoppedAtExpected ?? '')
  const closedAfterServer = Number.isFinite(finishedAt) && Number.isFinite(serverStoppedAt) && finishedAt >= serverStoppedAt
  add('capture:closed-after-server-stop', closedAfterServer ? 'PASS' : 'INCOMPLETE', closedAfterServer ? null : 'capture finishedAt must follow the isolated server-stopped lifecycle row')
  const lifecycleSnapshot = capture.lifecycle ?? {}
  let lifecycleBytes = null
  let lifecycleDigest = null
  let lifecycleRows = null
  try {
    const raw = readFileSync(lifecycleSnapshot.path)
    lifecycleBytes = raw.length
    lifecycleDigest = sha256(raw)
    const parsed = parseJsonl(raw.toString('utf8'), lifecycleSnapshot.path)
    if (parsed.errors.length === 0) lifecycleRows = parsed.rows
  } catch {
    // Missing lifecycle evidence is incomplete; this gate never creates it.
  }
  const captureLifecycleObserved = lifecycleSnapshot.status === 'OBSERVED'
    && Array.isArray(lifecycleSnapshot.problems) && lifecycleSnapshot.problems.length === 0
    && Number.isSafeInteger(lifecycleSnapshot.bytes) && lifecycleSnapshot.bytes === lifecycleBytes
    && lifecycleSnapshot.sha256 === lifecycleDigest
    && Number.isSafeInteger(lifecycleSnapshot.rows) && lifecycleSnapshot.rows === lifecycleRows?.length
    && lifecycleSnapshot.malformedRows === 0
    && Number.isFinite(Date.parse(lifecycleSnapshot.initializedAt ?? ''))
    && Number.isFinite(Date.parse(lifecycleSnapshot.firstObservedAt ?? ''))
    && Number.isFinite(Date.parse(lifecycleSnapshot.closedAt ?? ''))
    && Date.parse(lifecycleSnapshot.initializedAt) <= Date.parse(window.generationReadyAt ?? '')
    && Date.parse(lifecycleSnapshot.firstObservedAt) <= Date.parse(window.generationReadyAt ?? '')
    && Date.parse(lifecycleSnapshot.closedAt) >= finishedAt
    && lifecycleRows?.length === 3
    && lifecycleRows[0]?.event === 'terminal-consumed'
    && lifecycleRows[1]?.event === 'resident-stopped'
    && lifecycleRows[2]?.event === 'server-stopped'
    && JSON.stringify(lifecycleSnapshot.events?.terminalConsumed) === JSON.stringify(lifecycleRows[0])
    && JSON.stringify(lifecycleSnapshot.events?.residentStopped) === JSON.stringify(lifecycleRows[1])
    && JSON.stringify(lifecycleSnapshot.events?.serverStopped) === JSON.stringify(lifecycleRows[2])
    && capture.window?.terminalConsumedAt === lifecycleRows[0]?.ts
    && capture.window?.residentStoppedAt === lifecycleRows[1]?.stoppedAt
    && capture.window?.serverStoppedAt === lifecycleRows[2]?.stoppedAt
    && capture.window?.lifecycleComplete === true
    && Date.parse(capture.window?.shutdownAt ?? '') >= Date.parse(lifecycleRows[0]?.ts ?? '')
    && Date.parse(capture.window?.shutdownAt ?? '') <= Date.parse(lifecycleRows[1]?.stoppedAt ?? '')
    && Date.parse(lifecycleRows[1]?.stoppedAt ?? '') <= Date.parse(lifecycleRows[2]?.stoppedAt ?? '')
  const lifecycleGateStatus = captureLifecycleObserved ? 'PASS'
    : lifecycleBytes === null || lifecycleSnapshot.status === undefined || lifecycleSnapshot.status === 'INCOMPLETE' ? 'INCOMPLETE' : 'FAIL'
  add('capture:lifecycle-journal', lifecycleGateStatus, captureLifecycleObserved ? null : 'capture must bind the continuously observed, hashed lifecycle transcript and all ordered shutdown boundaries')
  const journals = capture.journals ?? {}
  let actualNonEmptyJournal = false
  let allJournalsReadable = true
  for (const logicalName of REQUIRED_PROVIDER_JOURNALS) {
    const captureName = captureJournalNames[logicalName]
    const snapshot = typeof captureName === 'string' ? journals[captureName] : null
    const path = journalPaths[logicalName]
    let bytes = null
    let digest = null
    let firstObservedAt = null
    let initializedAt = null
    try {
      const stat = lstatSync(path)
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('not-a-regular-file')
      bytes = readFileSync(path)
      digest = sha256(bytes)
      if (bytes.length > 0) actualNonEmptyJournal = true
      firstObservedAt = snapshot?.firstObservedAt ?? snapshot?.initializedAt ?? null
      initializedAt = snapshot?.initializedAt ?? null
    } catch {
      // Missing/unreadable evidence remains INCOMPLETE. Never materialize it here.
      allJournalsReadable = false
    }
    const closedAt = Date.parse(snapshot?.closedAt ?? '')
    const observedAt = Date.parse(firstObservedAt ?? '')
    const initializedAtMs = Date.parse(initializedAt ?? '')
    const startedAt = Date.parse(window.startedAt ?? '')
    const endedAt = Date.parse(window.endedAt ?? '')
    const matches = snapshot && bytes !== null && Number.isSafeInteger(snapshot.bytes)
      && snapshot.bytes === bytes.length && snapshot.sha256 === digest
      && Number.isSafeInteger(snapshot.rows) && snapshot.rows >= 0 && snapshot.malformedRows === 0
      && Number.isFinite(observedAt) && Number.isFinite(closedAt)
      && Number.isFinite(initializedAtMs) && initializedAtMs <= expectedReadyAt
      && Number.isFinite(startedAt) && Number.isFinite(endedAt) && Number.isFinite(expectedReadyAt)
      && observedAt <= expectedReadyAt && closedAt >= endedAt
    add(`capture:journal:${logicalName}`, matches ? 'PASS' : bytes === null || snapshot === undefined ? 'INCOMPLETE' : 'FAIL', matches ? null : `journal must be a verified run-scoped regular file whose capture hash/coverage matches actual bytes: ${logicalName}`)
  }
  const byteObservationMatches = typeof captureDetails.observedNonEmptyJournal === 'boolean'
    && allJournalsReadable && captureDetails.observedNonEmptyJournal === actualNonEmptyJournal
  add('capture:journal-byte-observation', byteObservationMatches ? 'PASS' : allJournalsReadable && typeof captureDetails.observedNonEmptyJournal === 'boolean' ? 'FAIL' : 'INCOMPLETE', byteObservationMatches ? null : 'capture nonempty-journal flag must match the actual run-scoped journal bytes')
  const failures = checks.filter((entry) => entry.status === 'FAIL')
  const incomplete = checks.some((entry) => entry.status === 'INCOMPLETE')
  return { status: failures.length > 0 ? 'FAIL' : incomplete ? 'INCOMPLETE' : 'PASS', checks }
}

function evaluateHostLifecycleTranscript(path, { sourceSha, identity, terminal, isolatedLeaf, resident, residentStop, leafStop }) {
  let text
  try { text = readFileSync(path, 'utf8') } catch {
    return { status: 'INCOMPLETE', rows: null, serverStoppedAt: null, checks: [{ id: 'host-lifecycle:read', status: 'INCOMPLETE' }] }
  }
  const parsed = parseJsonl(text, path)
  if (parsed.errors.length > 0) {
    return { status: 'FAIL', rows: parsed.rows.length, serverStoppedAt: null, checks: [{ id: 'host-lifecycle:jsonl', status: 'FAIL', reason: parsed.errors[0] }] }
  }
  const rows = parsed.rows
  const expectedEvents = ['terminal-consumed', 'resident-stopped', 'server-stopped']
  const checks = []
  const exactCount = rows.length === expectedEvents.length
  const recognizedRows = rows.every((row) => expectedEvents.includes(row.event)
    && row.schema === HOST_LIFECYCLE_TRANSCRIPT_SCHEMA && row.actor === 'probe-harness')
  const eventKinds = rows.map((row) => row.event)
  const uniqueRows = new Set(eventKinds).size === eventKinds.length
  const ordered = eventKinds.every((event, index) => expectedEvents.indexOf(event) > (index === 0 ? -1 : expectedEvents.indexOf(eventKinds[index - 1])))
  checks.push({ id: 'host-lifecycle:exactly-three-rows', status: exactCount ? 'PASS' : rows.length > expectedEvents.length || !uniqueRows ? 'FAIL' : 'INCOMPLETE', observed: rows.length })
  checks.push({ id: 'host-lifecycle:ordered-events', status: recognizedRows && uniqueRows && ordered ? exactCount ? 'PASS' : 'INCOMPLETE' : 'FAIL' })
  const expectedIdentity = hostLifecycleIdentity(sourceSha, identity)
  const identityMatches = rows.length > 0 && rows.every((row) => ['sourceSha', 'runId', 'generationId', 'worldKey'].every((key) => row[key] === expectedIdentity[key]))
  checks.push({ id: 'host-lifecycle:identity', status: identityMatches ? exactCount ? 'PASS' : 'INCOMPLETE' : identity === null ? 'INCOMPLETE' : 'FAIL' })
  const times = rows.map((row) => Date.parse(row.ts ?? ''))
  const orderedTimes = times.length === rows.length && times.every(Number.isFinite) && times.every((time, index) => index === 0 || times[index - 1] <= time)
  checks.push({ id: 'host-lifecycle:monotonic-time', status: orderedTimes ? exactCount ? 'PASS' : 'INCOMPLETE' : rows.length < 3 ? 'INCOMPLETE' : 'FAIL' })
  const terminalRow = rows.find((row) => row.event === 'terminal-consumed')
  const terminalMatches = terminalRow?.transitionId === terminal?.transitionId
    && terminalRow?.contractHash === terminal?.contractHash
    && terminalRow?.outcomeKind === terminal?.outcomeKind
    && Array.isArray(terminalRow?.evidenceIds)
    && JSON.stringify(terminalRow.evidenceIds) === JSON.stringify(terminal?.evidenceIds ?? [])
    && (terminal?.outcomeKind !== 'SUCCESS' || terminalRow.evidenceIds.length > 0)
  checks.push({ id: 'host-lifecycle:terminal-binding', status: terminalMatches ? 'PASS' : terminal === null || terminalRow === undefined ? 'INCOMPLETE' : 'FAIL' })
  const residentRow = rows.find((row) => row.event === 'resident-stopped')
  const terminalConsumedAt = Date.parse(terminalRow?.ts ?? '')
  const terminalAt = Date.parse(terminal?.at ?? '')
  const terminalTimeValid = Number.isFinite(terminalConsumedAt) && Number.isFinite(terminalAt) && terminalConsumedAt >= terminalAt
  checks.push({ id: 'host-lifecycle:terminal-consumed-after-outcome', status: terminalTimeValid ? 'PASS' : terminal === null || terminalRow === undefined ? 'INCOMPLETE' : 'FAIL' })
  const residentMatches = residentRow?.pid === resident?.pid
    && residentRow?.pid === residentStop?.pid
    && residentRow?.status === 'stopped'
    && residentRow?.exitCode === residentStop?.exitCode
    && Date.parse(residentRow?.stoppedAt ?? '') >= 0
    && Number.isFinite(Date.parse(residentRow?.ts ?? ''))
    && Date.parse(residentRow.stoppedAt) === Date.parse(residentRow.ts)
    && Date.parse(residentRow.ts) >= terminalConsumedAt
    && residentRow?.serverId === expectedIdentity.serverId
    && validProcessExitObservation(residentRow?.processExitObservation, {
      pid: resident?.pid,
      exitCode: residentStop?.exitCode,
      notBefore: resident?.startedAt,
    })
    && JSON.stringify(residentRow?.processExitObservation) === JSON.stringify(safeProcessExitObservation(residentStop?.processExitObservation))
  checks.push({ id: 'host-lifecycle:resident-stop', status: residentMatches ? 'PASS' : terminal === null || terminalRow === undefined || residentStop === null || residentRow === undefined ? 'INCOMPLETE' : 'FAIL' })
  const serverRow = rows.find((row) => row.event === 'server-stopped')
  const expectedServerId = isolatedLeaf?.worldKey?.split('|', 1)[0] ?? null
  const serverMatches = serverRow?.pid === isolatedLeaf?.pid
    && serverRow?.pid === leafStop?.pid
    && serverRow?.status === 'stopped'
    && serverRow?.exitCode === leafStop?.exitCode
    && serverRow?.serverId === expectedServerId
    && expectedServerId === expectedIdentity.serverId
    && Date.parse(serverRow?.stoppedAt ?? '') >= 0
    && Number.isFinite(Date.parse(serverRow?.ts ?? '')) && Date.parse(serverRow.stoppedAt) === Date.parse(serverRow.ts)
    && Date.parse(serverRow.ts) >= Date.parse(residentRow?.ts ?? '')
    && validProcessExitObservation(serverRow?.processExitObservation, {
      pid: isolatedLeaf?.pid,
      exitCode: leafStop?.exitCode,
      notBefore: isolatedLeaf?.startedAt,
    })
    && JSON.stringify(serverRow?.processExitObservation) === JSON.stringify(safeProcessExitObservation(leafStop?.processExitObservation))
    && validListenerClosureObservation(serverRow?.listenerClosureObservation, {
      host: isolatedLeaf?.host,
      port: isolatedLeaf?.port,
      notBefore: leafStop?.processExitObservation?.observedAt,
    })
    && JSON.stringify(serverRow?.listenerClosureObservation) === JSON.stringify(safeListenerClosureObservation(leafStop?.listenerClosureObservation))
    && Date.parse(serverRow?.stoppedAt ?? '') === Date.parse(leafStop?.listenerClosureObservation?.observedAt ?? '')
  checks.push({ id: 'host-lifecycle:server-stop', status: serverMatches ? 'PASS' : leafStop === null || serverRow === undefined ? 'INCOMPLETE' : 'FAIL' })
  const failures = checks.some((entry) => entry.status === 'FAIL')
  const incomplete = checks.some((entry) => entry.status === 'INCOMPLETE')
  const serverStoppedTime = Date.parse(serverRow?.ts ?? '')
  return {
    status: failures ? 'FAIL' : incomplete ? 'INCOMPLETE' : 'PASS',
    rows: rows.length,
    terminalConsumedAt: Number.isFinite(terminalConsumedAt) ? new Date(terminalConsumedAt).toISOString() : null,
    residentStoppedAt: Date.parse(residentRow?.stoppedAt ?? '') >= 0 ? new Date(Date.parse(residentRow.stoppedAt)).toISOString() : null,
    serverStoppedAt: Number.isFinite(serverStoppedTime) ? new Date(serverStoppedTime).toISOString() : null,
    checks,
  }
}

function writeExclusiveJson(path, value, attemptRoot) {
  const resolved = resolve(path)
  const root = resolve(attemptRoot)
  if (!inside(root, resolved) || resolved === root) fail('output artifact escapes attemptRoot')
  ensureDirectoryChain(root, dirname(resolved))
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
  let fd
  try {
    fd = openSync(resolved, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NOFOLLOW, 0o600)
    const written = writeFileSync(fd, bytes)
    void written
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
  return { path: resolved, sha256: sha256(readFileSync(resolved)) }
}

/** Create the real HOST lifecycle transcript before capture/resident start. */
export function prepareHostLifecycleTranscript({ attemptRoot }) {
  if (typeof attemptRoot !== 'string' || attemptRoot.length === 0) fail('attemptRoot is required')
  const root = resolve(attemptRoot)
  assertRealDirectory(root, 'attemptRoot')
  const transcriptPath = resolve(root, 'runner', 'host-lifecycle.jsonl')
  ensureDirectoryChain(root, dirname(transcriptPath))
  let fd
  try {
    fd = openSync(transcriptPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NOFOLLOW, 0o600)
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size !== 0 || stat.nlink !== 1) fail('host lifecycle transcript must begin as a fresh empty regular file')
  } catch (error) {
    if (error?.code === 'EEXIST') fail('host lifecycle transcript already exists; refusing stale run evidence')
    throw error
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
  return transcriptPath
}

function appendHostLifecycleRow(transcriptPath, row) {
  let fd
  try {
    fd = openSync(transcriptPath, constants.O_WRONLY | constants.O_APPEND | NOFOLLOW)
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1) fail('host lifecycle transcript was replaced or is not a regular file')
    const bytes = Buffer.from(`${JSON.stringify(row)}\n`, 'utf8')
    let offset = 0
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset)
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function hostLifecycleIdentity(sourceSha, identity) {
  return {
    sourceSha: sourceSha.toLowerCase(),
    runId: identity?.runId ?? null,
    generationId: identity?.generationId ?? null,
    worldKey: identity?.worldKey ?? null,
    serverId: identity?.worldKey?.split('|', 1)[0] ?? null,
  }
}

function validProcessExitObservation(value, { pid, exitCode, notBefore }) {
  const observedAt = Date.parse(value?.observedAt ?? '')
  return isPlainObject(value)
    && value.schema === 'vtr-process-exit-observation/v1'
    && value.source === 'child-close-event'
    && value.state === 'exited'
    && value.pid === pid
    && value.exitCode === exitCode
    && Number.isSafeInteger(exitCode)
    && Number.isFinite(observedAt)
    && Number.isFinite(Date.parse(notBefore ?? ''))
    && observedAt >= Date.parse(notBefore)
}

function validListenerClosureObservation(value, { host, port, notBefore }) {
  const observedAt = Date.parse(value?.observedAt ?? '')
  return isPlainObject(value)
    && value.schema === 'vtr-listener-closure-observation/v1'
    && value.source === 'tcp-connect-probe'
    && value.state === 'closed'
    && value.host === host
    && value.port === port
    && value.result === 'connection-refused'
    && Number.isFinite(observedAt)
    && Number.isFinite(Date.parse(notBefore ?? ''))
    && observedAt >= Date.parse(notBefore)
}

function verifyFixtureTranscriptDescriptor(value, attemptRoot) {
  if (!isPlainObject(value) || value.status !== 'READY'
    || typeof value.path !== 'string' || typeof value.sha256 !== 'string' || !SHA256_RE.test(value.sha256)) {
    fail('fixture adapter must return {status:READY,path,sha256}')
  }
  const root = realpathSync(resolve(attemptRoot))
  const fixturePath = resolve(value.path)
  if (!inside(root, fixturePath) || fixturePath === root) fail('fixture transcript path must remain inside the run-scoped attempt root')
  let stat
  try { stat = lstatSync(fixturePath) } catch (error) { fail(`fixture transcript is unavailable (${error?.code ?? 'read-error'})`) }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size === 0) fail('fixture transcript must be a nonempty regular file')
  if (realpathSync(fixturePath) !== fixturePath) fail('fixture transcript must not traverse a symlink')
  const bytes = readFileSync(fixturePath)
  const digest = sha256(bytes)
  if (digest !== value.sha256.toLowerCase()) fail('fixture transcript SHA-256 differs from the adapter attestation')
  return { status: 'READY', path: fixturePath, sha256: digest, bytes: bytes.length }
}

/**
 * Run the HOST lifecycle around one existing isolated Leaf world.
 *
 * `watchFactory.arm()` must return a watcher with synchronous `poll()` and
 * `finish(reason)` methods. Capture schema/status are explicit arguments and
 * checked after finish. No missing journal is inferred as a zero-call journal.
 * The observer adapter binds the configured observer to this exact runtime
 * directory, verifies summary identity, and restores its prior binding after
 * archive validation by default.
 *
 * `adapters` owns runtime process details:
 * - startResidentFrozen({sourceSha, attemptRoot, paths}) -> {frozen:true, pid, handle}
 * - prepareFixture({handle, identity, serverAttestation, attemptRoot, paths}) -> {status:'READY', path, sha256}
 * - resumeResident({handle, identity}) -> {started:true}
 * - stopResident({handle, identity, pid}) -> {status:'STOPPED', pid, serverId, exitCode, stoppedAt, processExitObservation}
 * - stopIsolatedLeaf({attestation, identity}) -> {status:'STOPPED', port, pid, serverId, exitCode, stoppedAt, processExitObservation, listenerClosureObservation}
 * - collect({identity, terminal, fixtureTranscript, observerUrl, paths, poll}) -> collector report descriptor
 * - sealArchive({identity, terminal, capture, collector, lifecycle, hostLifecycleTranscript, fixtureTranscript}) -> archive descriptor
 * - validateArchive({identity, archive, hostLifecycleTranscript, fixtureTranscript}) -> validator descriptor
 *
 * The isolated server attestation may contain runtime-specific details, but
 * this supervisor retains only loopback, port, PID, start time, world root and
 * worldKey. It never reads process argv/environment or contacts protected ports.
 * The HOST adapter must wait for the actual child close event and return a
 * `vtr-process-exit-observation/v1` record. The Leaf adapter must additionally
 * make a post-exit TCP connect probe and report `connection-refused` in a
 * `vtr-listener-closure-observation/v1` record. The supervisor validates and
 * journals those observations; it does not use process APIs or probe ports.
 */
export async function runVtrReachProbeSupervisor({
  attemptRoot,
  runtimeDir,
  sourceSha,
  paths,
  expectedCaptureSchema,
  expectedCaptureStatus,
  captureJournalNames,
  serverAttestation,
  isolatedPort = ISOLATED_PROBE_SERVER_PORT,
  watchFactory,
  observerAdapter,
  observerPolicy = 'restore',
  maxObserverFreshnessMs = 5000,
  adapters,
  outputPaths,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)),
  pollMs = 250,
  timeoutMs = 150_000,
}) {
  if (!SHA40_RE.test(String(sourceSha ?? ''))) fail('sourceSha must be a full 40-character exact source SHA')
  if (!Number.isSafeInteger(isolatedPort) || isolatedPort < 1 || isolatedPort > 65535) fail('isolatedPort must be a valid TCP port')
  if (PROTECTED_SERVER_PORTS.includes(isolatedPort)) fail(`refusing protected server port ${isolatedPort}`)
  if (typeof expectedCaptureSchema !== 'string' || expectedCaptureSchema.length === 0) fail('expectedCaptureSchema is required')
  if (typeof expectedCaptureStatus !== 'string' || expectedCaptureStatus.length === 0) fail('expectedCaptureStatus is required')
  if (expectedCaptureSchema !== 'vtr-provider-activity-capture/v2' || expectedCaptureStatus !== 'OBSERVED') {
    fail('Reach no-LLM proof requires vtr-provider-activity-capture/v2 with status OBSERVED')
  }
  if (!Number.isInteger(pollMs) || pollMs < 25 || pollMs > 5000) fail('pollMs must be 25..5000')
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600_000) fail('timeoutMs must be 1000..600000')
  if (!Number.isInteger(maxObserverFreshnessMs) || maxObserverFreshnessMs < 1000 || maxObserverFreshnessMs > 60_000) fail('maxObserverFreshnessMs must be 1000..60000')
  if (!['restore', 'leave-bound'].includes(observerPolicy)) fail('observerPolicy must be restore or leave-bound')
  for (const name of ['startResidentFrozen', 'prepareFixture', 'resumeResident', 'stopResident', 'stopIsolatedLeaf', 'collect', 'sealArchive', 'validateArchive']) {
    if (typeof adapters?.[name] !== 'function') fail(`lifecycle adapter is required: ${name}`)
  }
  if (typeof watchFactory?.arm !== 'function') fail('watchFactory.arm is required')
  for (const name of ['bind', 'readSummary', 'restore']) {
    if (typeof observerAdapter?.[name] !== 'function') fail(`observer adapter is required: ${name}`)
  }
  const root = resolve(attemptRoot)
  assertRealDirectory(root, 'attemptRoot')
  const rootReal = realpathSync(root)
  const isolatedLeaf = validateIsolatedLeafAttestation(serverAttestation, { attemptRoot: root, sourceSha, isolatedPort })
  const prepared = await (async () => {
    try {
      if (!isPlainObject(outputPaths)) fail('outputPaths must contain capture and lifecycle artifact paths')
      for (const name of ['capture', 'lifecycle', 'result']) if (typeof outputPaths[name] !== 'string') fail(`output path is required: ${name}`)
      if (typeof runtimeDir !== 'string' || runtimeDir.length === 0) fail('runtimeDir is required for observer identity binding')
      const runtimeCandidate = resolve(runtimeDir)
      ensureDirectoryChain(rootReal, runtimeCandidate)
      const runtimeDirectory = realpathSync(runtimeCandidate)
      if (!inside(rootReal, runtimeDirectory) || runtimeDirectory === rootReal) fail('runtimeDir must be inside this run-scoped attempt root')
      for (const name of ['capture', 'lifecycle', 'result']) {
        if (!inside(root, resolve(outputPaths[name]))) fail(`output artifact path must remain inside attemptRoot: ${name}`)
      }
      const outputFiles = ['capture', 'lifecycle', 'result'].map((name) => resolve(outputPaths[name]))
      if (new Set(outputFiles).size !== outputFiles.length) fail('capture, lifecycle and result artifacts must use distinct paths')
      const sinkPaths = Object.fromEntries(REQUIRED_ATTEMPT_SINKS.map((name) => {
        if (typeof paths?.[name] !== 'string') fail(`attempt sink path is required: ${name}`)
        return [name, resolve(paths[name])]
      }))
      const expectedSinkPaths = runtimeAttemptSinkPaths(runtimeDirectory)
      for (const name of REQUIRED_ATTEMPT_SINKS) {
        if (sinkPaths[name] !== expectedSinkPaths[name]) fail(`attempt sink does not match the actual runtime writer path: ${name}`)
      }
      const preparedSinks = prepareZeroByteAttemptSinks({ attemptRoot: root, paths: sinkPaths })
      const hostLifecyclePath = prepareHostLifecycleTranscript({ attemptRoot: root })
      const allPaths = { ...sinkPaths, 'host-lifecycle': hostLifecyclePath }
      const providerPaths = Object.fromEntries(REQUIRED_PROVIDER_JOURNALS.map((name) => [name, sinkPaths[name]]))
      return { runtimeDirectory, sinkPaths, preparedSinks, hostLifecyclePath, allPaths, providerPaths }
    } catch (error) {
      try {
        const stopped = await adapters.stopIsolatedLeaf({ attestation: isolatedLeaf, identity: null, reason: 'preflight-failed' })
        if (!isPlainObject(stopped) || stopped.status !== 'STOPPED' || stopped.port !== isolatedLeaf.port || stopped.pid !== isolatedLeaf.pid) {
          throw new Error('stop adapter did not attest the exact isolated server process')
        }
      } catch (stopError) {
        throw new ProbeSupervisorError(`probe preflight failed (${safeErrorDescription(error)}); isolated Leaf cleanup also failed (${safeErrorDescription(stopError)})`)
      }
      throw error
    }
  })()
  const { runtimeDirectory, sinkPaths, preparedSinks, hostLifecyclePath, allPaths, providerPaths } = prepared
  const startedAt = new Date(now()).toISOString()
  const events = [{ event: 'attempt-sinks-prepared', at: startedAt, sinks: preparedSinks }]
  let watcher = null
  let resident = null
  let bootIdentity = null
  let fixtureTranscript = null
  let identity = null
  let terminal = null
  let collector = null
  let capture = null
  let captureGate = { status: 'INCOMPLETE', checks: [] }
  let hostLifecycleGate = { status: 'INCOMPLETE', rows: 0, serverStoppedAt: null, checks: [] }
  let archive = null
  let validation = null
  let failure = null
  let failureDetails = null
  let failureStatus = null
  let residentStop = null
  let leafStop = null
  let observerBinding = null
  let rawObserverBinding = null
  let observerRestore = null
  const observerSnapshots = []
  let captureArmedAt = null
  let residentStartedAt = null
  let backgroundPollError = null
  let hostLifecycleDigestBeforeCaptureFinish = null

  const pollWatch = () => {
    if (watcher === null) return
    const result = watcher.poll()
    if (result && typeof result.then === 'function') fail('watcher.poll() must be synchronous so capture coverage is explicit')
  }
  const waitUntil = async (label, read) => {
    const deadline = now() + timeoutMs
    let last = null
    while (now() < deadline) {
      pollWatch()
      const result = await read()
      if (result?.status === 'READY' || result?.status === 'TERMINAL') return result
      last = result
      await sleep(pollMs)
    }
    throw new ProbeSupervisorError(`timeout waiting for ${label}${last === null ? '' : `; last=${JSON.stringify(last)}`}`, 'PROBE_WAIT_TIMEOUT')
  }
  const withWatchPolling = async (operation, { strict = true } = {}) => {
    let pollingError = null
    const timer = setInterval(() => {
      try { pollWatch() } catch (error) { pollingError ??= error }
    }, Math.min(pollMs, 1000))
    try {
      const value = await operation()
      if (pollingError !== null) {
        backgroundPollError ??= pollingError
        if (strict) throw pollingError
      }
      return value
    } finally {
      clearInterval(timer)
    }
  }

  try {
    const binding = await observerAdapter.bind({
      runtimeDir: runtimeDirectory,
      attemptRoot: rootReal,
      sourceSha: sourceSha.toLowerCase(),
      policy: observerPolicy,
    })
    if (isPlainObject(binding) && binding.status === 'BOUND') rawObserverBinding = binding
    if (!isPlainObject(binding) || binding.status !== 'BOUND'
      || typeof binding.runtimeDir !== 'string'
      || realpathSync(resolve(binding.runtimeDir)) !== runtimeDirectory
      || String(binding.sourceSha ?? '').toLowerCase() !== sourceSha.toLowerCase()
      || safeObserverUrl(binding.observerUrl) === null) {
      fail('observer adapter did not attest a loopback binding to this exact runtime/source')
    }
    if (observerPolicy === 'restore' && binding.previousBindingAvailable !== true) {
      fail('observer adapter cannot restore its previous binding; select leave-bound explicitly')
    }
    observerBinding = {
      status: 'BOUND',
      runtimeDir: runtimeDirectory,
      sourceSha: sourceSha.toLowerCase(),
      observerUrl: safeObserverUrl(binding.observerUrl),
      previousBindingAvailable: binding.previousBindingAvailable === true,
    }
    events.push({ event: 'observer-bound-to-runtime', at: new Date(now()).toISOString(), binding: observerBinding })

    const journalPathsForWatcher = Object.fromEntries(REQUIRED_PROVIDER_JOURNALS.map((name) => [name, providerPaths[name]]))
    watcher = await watchFactory.arm({
      hostLog: sinkPaths['host-log'],
      journals: journalPathsForWatcher,
      lifecycleLog: hostLifecyclePath,
      lifecycleTranscript: hostLifecyclePath,
      expectedSchema: expectedCaptureSchema,
      expectedStatus: expectedCaptureStatus,
      sourceSha: sourceSha.toLowerCase(),
      attemptRoot: root,
    })
    if (!isPlainObject(watcher) || typeof watcher.poll !== 'function' || typeof watcher.finish !== 'function') {
      fail('watchFactory.arm() must return {poll(), finish(reason)}')
    }
    captureArmedAt = new Date(now()).toISOString()
    events.push({ event: 'provider-capture-armed', at: captureArmedAt, expectedSchema: expectedCaptureSchema, expectedStatus: expectedCaptureStatus })
    pollWatch()

    const startResult = await withWatchPolling(() => adapters.startResidentFrozen({ sourceSha: sourceSha.toLowerCase(), attemptRoot: root, runtimeDir: runtimeDirectory, paths: allPaths }))
    if (!isPlainObject(startResult) || startResult.frozen !== true || !Object.hasOwn(startResult, 'handle')) {
      fail('resident adapter must attest frozen:true before process handoff')
    }
    if (!Number.isSafeInteger(startResult.pid) || startResult.pid < 1) fail('resident adapter must attest its started process PID')
    residentStartedAt = new Date(now()).toISOString()
    resident = { handle: startResult.handle, pid: startResult.pid, startedAt: residentStartedAt }
    events.push({ event: 'resident-started-frozen', at: residentStartedAt })
    const boot = await waitUntil('run-scoped BOOT', () => {
      const rows = parseHostEvents(sinkPaths['host-log'])
      const candidate = identityFromHostRows(rows, sourceSha)
      return candidate.status === 'BOOTED' ? { ...candidate, status: 'READY' } : candidate
    })
    bootIdentity = { sourceSha: boot.sourceSha, runId: boot.runId, worldKey: boot.worldKey, bootAt: boot.bootAt }
    if (isolatedLeaf.worldKey !== bootIdentity.worldKey) fail('isolated Leaf worldKey differs from exact run BOOT')
    events.push({ event: 'boot-bound', at: new Date(now()).toISOString(), identity: bootIdentity })

    const fixtureResult = await withWatchPolling(() => adapters.prepareFixture({
      handle: resident.handle,
      identity: bootIdentity,
      serverAttestation: isolatedLeaf,
      attemptRoot: root,
      paths: allPaths,
    }))
    fixtureTranscript = verifyFixtureTranscriptDescriptor(fixtureResult, root)
    events.push({ event: 'fixture-prepared-while-resident-frozen', at: new Date(now()).toISOString(), fixtureTranscript })

    const resumeResult = await withWatchPolling(() => adapters.resumeResident({ handle: resident.handle, identity: bootIdentity }))
    if (!isPlainObject(resumeResult) || resumeResult.started !== true) fail('resident resume was not explicitly acknowledged')
    events.push({ event: 'resident-resumed', at: new Date(now()).toISOString() })

    const ready = await waitUntil('GENERATION_READY', () => {
      const rows = parseHostEvents(sinkPaths['host-log'])
      const currentBoot = identityFromHostRows(rows, sourceSha)
      if (currentBoot.status !== 'BOOTED') return currentBoot
      const value = readyIdentity(rows, currentBoot)
      return value === null ? { status: 'WAIT', reason: 'waiting for GENERATION_READY' } : { ...value, status: 'READY' }
    })
    identity = {
      sourceSha: ready.sourceSha,
      runId: ready.runId,
      generationId: ready.generationId,
      worldKey: ready.worldKey,
      generationReadyAt: ready.generationReadyAt,
    }
    validateProbeProfile(parseHostEvents(sinkPaths['host-log']), { ...bootIdentity, bootAt: boot.bootAt }, ready.generationReadyAt)
    events.push({ event: 'generation-ready-bound', at: new Date(now()).toISOString(), identity })

    const readyObserver = await waitUntil('observer exact GENERATION_READY identity', async () => observerSummaryForIdentity(
      await observerAdapter.readSummary({ binding: rawObserverBinding, identity, phase: 'generation-ready' }),
      identity,
      maxObserverFreshnessMs,
    ))
    observerSnapshots.push({ phase: 'generation-ready', at: new Date(now()).toISOString(), ...readyObserver.summary })
    events.push({ event: 'observer-generation-ready-identity-verified', at: new Date(now()).toISOString(), summary: readyObserver.summary })

    const terminalResult = await waitUntil('typed Reach Transition terminal outcome', () => terminalForRunJournal(sinkPaths['run-journal'], identity))
    terminal = terminalResult.terminal
    const outcomeAt = Date.parse(terminal.at)
    const readyAt = Date.parse(identity.generationReadyAt ?? '')
    if (!Number.isFinite(outcomeAt) || !Number.isFinite(readyAt) || outcomeAt <= readyAt) fail('typed terminal outcome must follow this generation READY marker')
    events.push({ event: 'typed-transition-terminal', at: new Date(now()).toISOString(), terminal: { transitionId: terminal.transitionId, contractHash: terminal.contractHash, outcomeKind: terminal.outcomeKind, at: terminal.at } })
    appendHostLifecycleRow(hostLifecyclePath, {
      schema: HOST_LIFECYCLE_TRANSCRIPT_SCHEMA,
      event: 'terminal-consumed',
      ts: new Date(now()).toISOString(),
      actor: 'probe-harness',
      ...hostLifecycleIdentity(sourceSha, identity),
      transitionId: terminal.transitionId,
      contractHash: terminal.contractHash,
      outcomeKind: terminal.outcomeKind,
      evidenceIds: terminal.evidenceIds,
    })

    const terminalObserver = await waitUntil('observer exact terminal identity', async () => observerSummaryForIdentity(
      await observerAdapter.readSummary({ binding: rawObserverBinding, identity, terminal, phase: 'terminal' }),
      identity,
      maxObserverFreshnessMs,
    ))
    observerSnapshots.push({ phase: 'terminal', at: new Date(now()).toISOString(), ...terminalObserver.summary })
    events.push({ event: 'observer-terminal-identity-verified', at: new Date(now()).toISOString(), summary: terminalObserver.summary })

    pollWatch()
    collector = await withWatchPolling(() => adapters.collect({ identity, terminal, fixtureTranscript, observerUrl: observerBinding.observerUrl, runtimeDir: runtimeDirectory, paths: allPaths, poll: pollWatch }))
    if (!isPlainObject(collector)) fail('collector adapter must return an explicit report descriptor')
    events.push({ event: 'collector-complete', at: new Date(now()).toISOString(), status: collector.status ?? null, reportPath: collector.path ?? null, sha256: collector.sha256 ?? null })
  } catch (error) {
    failure = safeErrorDescription(error)
    failureDetails = safeErrorDetails(error)
    failureStatus = error?.code === 'PROBE_WAIT_TIMEOUT' ? 'INCOMPLETE' : 'FAIL'
    events.push({ event: 'supervisor-error', at: new Date(now()).toISOString(), reason: failure, ...failureDetails })
  } finally {
    if (resident !== null) {
      try {
        residentStop = await withWatchPolling(
          () => adapters.stopResident({ handle: resident.handle, identity: identity ?? bootIdentity, pid: resident.pid }),
        { strict: false },
      )
      if (!isPlainObject(residentStop) || residentStop.status !== 'STOPPED') fail('resident stop adapter did not attest STOPPED')
      if (!Number.isSafeInteger(residentStop.pid) || residentStop.pid !== resident.pid
        || !Number.isSafeInteger(residentStop.exitCode)
        || residentStop.serverId !== hostLifecycleIdentity(sourceSha, identity ?? bootIdentity).serverId
        || typeof residentStop.stoppedAt !== 'string' || !Number.isFinite(Date.parse(residentStop.stoppedAt))
        || !validProcessExitObservation(residentStop.processExitObservation, {
          pid: resident.pid,
          exitCode: residentStop.exitCode,
          notBefore: resident.startedAt,
        })
        || Date.parse(residentStop.processExitObservation.observedAt) !== Date.parse(residentStop.stoppedAt)) {
        fail('resident stop evidence must include the observed child close event for the started PID')
      }
      appendHostLifecycleRow(hostLifecyclePath, {
        schema: HOST_LIFECYCLE_TRANSCRIPT_SCHEMA,
        event: 'resident-stopped',
        ts: residentStop.stoppedAt,
        actor: 'probe-harness',
        ...hostLifecycleIdentity(sourceSha, identity ?? bootIdentity),
        pid: residentStop.pid,
        status: 'stopped',
        exitCode: residentStop.exitCode,
        stoppedAt: residentStop.stoppedAt,
        processExitObservation: safeProcessExitObservation(residentStop.processExitObservation),
      })
      events.push({ event: 'resident-stopped', at: new Date(now()).toISOString(), evidence: safeResidentStop(residentStop) })
      } catch (error) {
        failure ??= `resident stop failed: ${safeErrorDescription(error)}`
        failureStatus = 'FAIL'
        events.push({ event: 'resident-stop-error', at: new Date(now()).toISOString(), reason: failure })
      }
    }
    try {
      leafStop = await withWatchPolling(
        () => adapters.stopIsolatedLeaf({ attestation: isolatedLeaf, identity: identity ?? bootIdentity }),
        { strict: false },
      )
      if (!isPlainObject(leafStop) || leafStop.status !== 'STOPPED' || leafStop.port !== isolatedLeaf.port || leafStop.pid !== isolatedLeaf.pid) {
        fail('isolated Leaf stop adapter did not attest the exact isolated PID/port stopped')
      }
      if (!Number.isSafeInteger(leafStop.exitCode)
        || leafStop.serverId !== isolatedLeaf.worldKey.split('|', 1)[0]
        || typeof leafStop.stoppedAt !== 'string' || !Number.isFinite(Date.parse(leafStop.stoppedAt))
        || !validProcessExitObservation(leafStop.processExitObservation, {
          pid: isolatedLeaf.pid,
          exitCode: leafStop.exitCode,
          notBefore: isolatedLeaf.startedAt,
        })
        || !validListenerClosureObservation(leafStop.listenerClosureObservation, {
          host: isolatedLeaf.host,
          port: isolatedLeaf.port,
          notBefore: leafStop.processExitObservation?.observedAt,
        })
        || Date.parse(leafStop.stoppedAt) !== Date.parse(leafStop.listenerClosureObservation.observedAt)) {
        fail('isolated Leaf stop evidence must include the child close and observed TCP listener closure')
      }
      appendHostLifecycleRow(hostLifecyclePath, {
        schema: HOST_LIFECYCLE_TRANSCRIPT_SCHEMA,
        event: 'server-stopped',
        ts: leafStop.stoppedAt,
        actor: 'probe-harness',
        ...hostLifecycleIdentity(sourceSha, identity ?? bootIdentity),
        pid: leafStop.pid,
        serverId: isolatedLeaf.worldKey.split('|', 1)[0],
        status: 'stopped',
        exitCode: leafStop.exitCode,
        stoppedAt: leafStop.stoppedAt,
        processExitObservation: safeProcessExitObservation(leafStop.processExitObservation),
        listenerClosureObservation: safeListenerClosureObservation(leafStop.listenerClosureObservation),
      })
      events.push({ event: 'isolated-leaf-stopped', at: new Date(now()).toISOString(), evidence: safeLeafStop(leafStop) })
    } catch (error) {
      failure ??= `isolated Leaf stop failed: ${safeErrorDescription(error)}`
      failureStatus = 'FAIL'
      events.push({ event: 'isolated-leaf-stop-error', at: new Date(now()).toISOString(), reason: failure })
    }
    hostLifecycleGate = evaluateHostLifecycleTranscript(hostLifecyclePath, {
      sourceSha,
      identity,
      terminal,
      isolatedLeaf,
      resident,
      residentStop,
      leafStop,
    })
    hostLifecycleDigestBeforeCaptureFinish = sha256(readFileSync(hostLifecyclePath))
    events.push({ event: 'host-lifecycle-transcript-checked', at: new Date(now()).toISOString(), gate: hostLifecycleGate.status, rows: hostLifecycleGate.rows })
    if (backgroundPollError !== null) {
      failure ??= `provider capture polling failed during lifecycle: ${safeErrorDescription(backgroundPollError)}`
      failureStatus = 'FAIL'
      events.push({ event: 'provider-capture-poll-error', at: new Date(now()).toISOString(), reason: failure })
    }
    if (watcher !== null) {
      try {
        pollWatch()
        capture = await watcher.finish(failure === null ? 'typed-terminal-and-orderly-teardown' : `incomplete:${failure}`)
        const afterCaptureFinish = evaluateHostLifecycleTranscript(hostLifecyclePath, {
          sourceSha,
          identity,
          terminal,
          isolatedLeaf,
          resident,
          residentStop,
          leafStop,
        })
        const transcriptStable = hostLifecycleDigestBeforeCaptureFinish !== null
          && hostLifecycleDigestBeforeCaptureFinish === sha256(readFileSync(hostLifecyclePath))
          && afterCaptureFinish.status === hostLifecycleGate.status
        if (!transcriptStable) {
          hostLifecycleGate = { ...afterCaptureFinish, status: 'FAIL', checks: [...afterCaptureFinish.checks, { id: 'host-lifecycle:stable-through-capture-close', status: 'FAIL' }] }
        } else {
          hostLifecycleGate.checks.push({ id: 'host-lifecycle:stable-through-capture-close', status: 'PASS' })
        }
        captureGate = evaluateCaptureEnvelope(capture, {
          expectedSchema: expectedCaptureSchema,
          expectedStatus: expectedCaptureStatus,
          identity: identity ?? { sourceSha: sourceSha.toLowerCase(), runId: null, generationId: null, worldKey: null },
          terminalAtExpected: terminal?.at ?? null,
          captureArmedAt,
          residentStartedAt,
          serverStoppedAtExpected: hostLifecycleGate.serverStoppedAt,
          journalPaths: providerPaths,
          captureJournalNames,
        })
        captureGate.checks.push(...hostLifecycleGate.checks)
        const hostLifecycleFailed = hostLifecycleGate.status === 'FAIL'
        const captureFailed = captureGate.status === 'FAIL'
        const incomplete = captureGate.status === 'INCOMPLETE' || hostLifecycleGate.status === 'INCOMPLETE'
        captureGate.status = hostLifecycleFailed || captureFailed ? 'FAIL' : incomplete ? 'INCOMPLETE' : 'PASS'
        events.push({ event: 'provider-capture-finished', at: new Date(now()).toISOString(), schema: capture?.schema ?? null, status: capture?.status ?? null, gate: captureGate.status })
      } catch (error) {
        failure ??= `provider capture finish failed: ${safeErrorDescription(error)}`
        failureStatus = 'FAIL'
        captureGate = { status: 'INCOMPLETE', checks: [{ id: 'capture:finish', status: 'INCOMPLETE', reason: failure }] }
        events.push({ event: 'provider-capture-error', at: new Date(now()).toISOString(), reason: failure })
      }
    }
  }

  const lifecycle = {
    schema: VTR_REACH_PROBE_SUPERVISOR_SCHEMA,
    record: 'vtr-reach-probe-lifecycle',
    createdAt: new Date(now()).toISOString(),
    sourceSha: sourceSha.toLowerCase(),
    runtimeDir: runtimeDirectory,
    observerBinding,
    observerSnapshots,
    identity,
    fixtureTranscript,
    isolatedLeaf,
    terminal: terminal === null ? null : {
      transitionId: terminal.transitionId,
      contractHash: terminal.contractHash,
      outcomeKind: terminal.outcomeKind,
      at: terminal.at,
    },
    residentStop: safeResidentStop(residentStop),
    leafStop: safeLeafStop(leafStop),
    captureGate,
    hostLifecycleTranscript: {
      path: hostLifecyclePath,
      sha256: sha256(readFileSync(hostLifecyclePath)),
      gate: hostLifecycleGate,
    },
    events,
    failure,
    failureDetails,
  }
  if (capture !== null) {
    try { lifecycle.captureArtifact = writeExclusiveJson(outputPaths.capture, capture, root) } catch (error) {
      failure ??= `capture artifact write failed: ${safeErrorDescription(error)}`
      failureStatus = 'FAIL'
      lifecycle.failure = failure
    }
  } else {
    lifecycle.captureArtifact = null
  }
  let lifecycleArtifact
  try { lifecycleArtifact = writeExclusiveJson(outputPaths.lifecycle, lifecycle, root) } catch (error) {
    failure ??= `lifecycle artifact write failed: ${safeErrorDescription(error)}`
    failureStatus = 'FAIL'
    lifecycleArtifact = null
  }

  const teardownComplete = resident === null || residentStop?.status === 'STOPPED'
    ? leafStop?.status === 'STOPPED'
    : false
  if (failure === null && identity !== null && terminal !== null && collector !== null
    && captureGate.status === 'PASS' && hostLifecycleGate.status === 'PASS' && teardownComplete && lifecycleArtifact !== null) {
    try {
      archive = await adapters.sealArchive({ identity, terminal, capture, collector, lifecycle: lifecycleArtifact, hostLifecycleTranscript: hostLifecyclePath, fixtureTranscript, observerBinding, observerSnapshots, paths: allPaths })
      if (!isPlainObject(archive)) fail('archive adapter must return an explicit archive descriptor')
      events.push({ event: 'archive-sealed', at: new Date(now()).toISOString(), status: archive.status ?? null, path: archive.path ?? null })
      validation = await adapters.validateArchive({ identity, archive, hostLifecycleTranscript: hostLifecyclePath, fixtureTranscript })
      if (!isPlainObject(validation)) fail('validator adapter must return an explicit result')
      events.push({ event: 'archive-validated', at: new Date(now()).toISOString(), status: validation.status ?? null, reportPath: validation.path ?? null })
    } catch (error) {
      failure ??= `archive pipeline failed: ${safeErrorDescription(error)}`
      failureStatus = 'FAIL'
      events.push({ event: 'archive-pipeline-error', at: new Date(now()).toISOString(), reason: failure })
    }
  }
  if (rawObserverBinding !== null) {
    try {
      const restored = await observerAdapter.restore({ binding: rawObserverBinding, policy: observerPolicy, archive, validation })
      const expectedStatus = observerPolicy === 'restore' ? 'RESTORED' : 'LEFT_BOUND'
      if (!isPlainObject(restored) || restored.status !== expectedStatus) fail(`observer adapter did not attest ${expectedStatus}`)
      if (observerPolicy === 'leave-bound'
        && (typeof restored.runtimeDir !== 'string' || realpathSync(resolve(restored.runtimeDir)) !== runtimeDirectory)) {
        fail('observer adapter did not leave the observer bound to the exact runtime directory')
      }
      observerRestore = whitelist(restored, ['status', 'runtimeDir', 'restoredRuntimeDir', 'restoredAt'])
      events.push({ event: 'observer-binding-finalized', at: new Date(now()).toISOString(), policy: observerPolicy, result: observerRestore })
    } catch (error) {
      failure ??= `observer binding finalization failed: ${safeErrorDescription(error)}`
      failureStatus = 'FAIL'
      events.push({ event: 'observer-binding-finalization-error', at: new Date(now()).toISOString(), reason: failure })
    }
  }
  const status = failureStatus === 'FAIL' || captureGate.status === 'FAIL' || hostLifecycleGate.status === 'FAIL' || validation?.status === 'FAIL'
    ? 'FAIL'
    : failureStatus === null && terminal?.outcomeKind === 'SUCCESS' && collector?.status === 'PASS'
      && validation?.status === 'PASS' && captureGate.status === 'PASS' && hostLifecycleGate.status === 'PASS' ? 'PASS' : 'INCOMPLETE'
  const result = {
    schema: VTR_REACH_PROBE_SUPERVISOR_SCHEMA,
    record: 'vtr-reach-probe-supervisor-result',
    status,
    sourceSha: sourceSha.toLowerCase(),
    runtimeDir: runtimeDirectory,
    observerBinding,
    observerSnapshots,
    observerRestore,
    identity,
    fixtureTranscript,
    terminal: terminal === null ? null : { transitionId: terminal.transitionId, contractHash: terminal.contractHash, outcomeKind: terminal.outcomeKind, at: terminal.at },
    captureGate,
    hostLifecycleTranscript: {
      path: hostLifecyclePath,
      sha256: sha256(readFileSync(hostLifecyclePath)),
      gate: hostLifecycleGate,
    },
    collector: safeArtifactDescriptor(collector),
    archive: safeArtifactDescriptor(archive),
    validation: safeArtifactDescriptor(validation),
    lifecycleArtifact,
    events,
    failure,
    failureDetails,
  }
  let resultArtifact = null
  try { resultArtifact = writeExclusiveJson(outputPaths.result, result, root) } catch (error) {
    return { ...result, status: 'FAIL', failureStatus: 'FAIL', failure: `result artifact write failed: ${safeErrorDescription(error)}`, resultArtifact: null }
  }
  return { ...result, failureStatus, resultArtifact }
}
