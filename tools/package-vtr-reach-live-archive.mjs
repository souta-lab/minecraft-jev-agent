#!/usr/bin/env node
// Package already-captured VTR Reach evidence for the read-only acceptance
// validator. This adapter never starts a runtime, repairs an archive, or
// manufactures absent input files.

import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { classifyProviderActivity } from './capture-vtr-provider-activity.mjs'
import { inspectFreshWorldAttestation } from './vtr-fresh-world-attestation.mjs'
import { inspectReachComparisonProof } from './validate-vtr-reach-evidence.mjs'

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
const PROVIDER_ARCHIVE_PATHS = Object.freeze({
  'jev-calls': 'runner/jev-calls.jsonl',
  'jev-decisions': 'runner/jev-decisions.jsonl',
  'system2-journal': 'runner/system2.jsonl',
  'mercury-calls': 'runner/mercury-calls.jsonl',
})
const PROVIDER_JOURNALS = Object.freeze(Object.keys(PROVIDER_ARCHIVE_PATHS))
const AUTHORITY_FIXTURE_REPORT_PATH = 'proofs/no-double-authority-fixture.json'
const AUTHORITY_FIXTURE_SOURCE_PATH = 'runner/fixtures/test-vtr-reach-executor-dispatch-authority.mts'
const AUTHORITY_FIXTURE_TEST_PATH = 'jev-agent/test-vtr-reach-executor-dispatch-authority.mts'
const AUTHORITY_FIXTURE_TEST_NAME = 'production Reach dispatch and legacy Executor claim cannot overlap body authority'
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
  'runner/mercury-calls.jsonl',
  'runner/milestone-predicates.json',
  'runner/run-metadata.json',
  'runner/provider-activity-capture.json',
  'runner/host-lifecycle.jsonl',
  'runner/no-llm-egress-audit.json',
  AUTHORITY_FIXTURE_REPORT_PATH,
  AUTHORITY_FIXTURE_SOURCE_PATH,
  'server/fixture-commands.jsonl',
  'server/leaf-latest.log',
  'server/leaf-stdout-events.jsonl',
  'server/server-start.json',
  'server/fresh-world-attestation.json',
  'server/server.properties.launch',
  'server/server.properties.effective-after-boot',
  'server/world/level.dat',
])

const HELP = `Usage: bun tools/package-vtr-reach-live-archive.mjs \
  --collector-report <capture.json> --manifest <inputs.json> --archive <new-directory> [--repo <git-checkout>]

Manifest schema: vtr-reach-live-archive-input/v1
  { "files": { "runner/run-metadata.json": "./run-metadata.json", ... } }

The supplied run-metadata.json must record source {repository, branch, commit},
the complete validator run identity/timestamps, mission inventories/positions,
and fixture facts. Map the actual server-start/config and exact
server/fresh-world-attestation.json and PID-bound server/leaf-stdout-events.jsonl,
initial/final snapshots,
fixture command journal, world files (including the bot UUID-bound playerdata
file and the MCA region containing the committed witness coordinates), acceptance record, and milestone snapshot to
their canonical paths in files. Collector logs/journals are copied from
the paths and hashes in the collector report; do not duplicate those mappings.
server-start.json must contain the run-bound spawnObservation captured from its
own child PID (/proc argv and cwd), with exactly one --universe, --level-name,
--config, and -jar argument plus matching config/JAR paths and hashes. Each
post-run world file receipt must be captured after child exit and loopback
connection refusal, bind the exact run/PID, and include a realPath/pathChain
showing no symlinked worldRoot or parent directory. packaging-report.json
preserves those source origins for offline revalidation.

If the manifest supplies comparison/legacy-baseline.json, also pass --repo.
Only that path may contain a distinct legacy run identity; it must validate as
a raw v3 comparison, bind the legacy source to origin/main, and bind the VTR
side to this package's exact run and Transition.

To claim observed zero provider activity, also supply
runner/provider-activity-capture.json with schema vtr-provider-activity-capture/v2,
status OBSERVED, the exact collector source/run/generation/world identity,
window { startedAt, endedAt, coverageComplete: true }, exactly zero
activity.networkModelCalls/jevEvaluateAttempts/system2EvaluateAttempts, and a
journals entry for each of jev-calls, jev-decisions, system2-journal, and
mercury-calls. Decision records may be nonempty when their provider attempt
counters are explicitly zero. Every raw journal is preserved and checked
against its captured bytes/hash and the run window. An absent or unclassified
journal is never treated as zero and is never created here. Also supply the raw
runner/host-lifecycle.jsonl transcript with identity-bound terminal-consumed,
resident-stopped, and server-stopped rows; capture must remain open until after
server stop. Also supply the raw runner/no-llm-egress-audit.json emitted by
with-no-llm-egress-guard.mjs and its exact-source binding; this is USERSPACE_ONLY
libc-interposition evidence and makes no kernel isolation claim.

The legacy-claim exclusion fixture is a separate source-bound proof, not a live
counter. Supply proofs/no-double-authority-fixture.json emitted by
jev-agent/test-vtr-reach-executor-dispatch-authority.mts and its exact source at
runner/fixtures/test-vtr-reach-executor-dispatch-authority.mts. The adapter
checks the test source hash and recorded refusal/owner/pathfinder observations;
fixture conflict counts do not alter the live run's duplicate-authority zero.

The collector's raw inputs are copied only when the collector report records
them as captured and their current byte count/hash still match. Missing files
remain absent and are reported INCOMPLETE. The archive is only prepared for
the read-only validator; this tool cannot declare live acceptance.
`

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function parseArgs(argv) {
  const out = { collectorReport: null, manifest: null, archive: null, repo: null, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') {
      out.help = true
      continue
    }
    if (!['--collector-report', '--manifest', '--archive', '--repo'].includes(argument)) throw new Error(`unknown argument: ${argument}`)
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

function inspectActualNonSymlinkPath(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) return { status: 'INCOMPLETE', reason: 'source path is not absolute' }
  const absolute = resolve(path)
  const parts = absolute.split('/').filter(Boolean)
  let current = '/'
  try {
    for (const [index, part] of parts.entries()) {
      current = join(current, part)
      const stat = lstatSync(current)
      if (stat.isSymbolicLink()) return { status: 'FAIL', reason: `source component is a symlink: ${current}` }
      const final = index === parts.length - 1
      if (final ? !stat.isFile() : !stat.isDirectory()) {
        return { status: 'FAIL', reason: `source path component has unexpected kind: ${current}` }
      }
      if (resolve(realpathSync(current)) !== current) return { status: 'FAIL', reason: `source component resolves through an alias: ${current}` }
    }
  } catch (error) {
    return { status: 'INCOMPLETE', reason: `source path component cannot be observed: ${error.message}` }
  }
  return { status: 'PASS', realPath: absolute }
}

function inspectActualWorldSources(copiedSources) {
  const attestationSource = copiedSources.get('server/fresh-world-attestation.json')
  if (!attestationSource) return { status: 'INCOMPLETE', reason: 'fresh-world attestation is absent' }
  let attestation
  try { attestation = JSON.parse(attestationSource.bytes.toString('utf8')) }
  catch (error) { return { status: 'FAIL', reason: `fresh-world attestation is malformed: ${error.message}` } }
  const worldRoot = attestation?.worldRoot?.absolute
  const rows = attestation?.postRunObservation?.files
  if (typeof worldRoot !== 'string' || !isAbsolute(worldRoot) || !Array.isArray(rows)) {
    return { status: 'INCOMPLETE', reason: 'attestation omits absolute worldRoot or per-file post-stop rows' }
  }
  const attestedPaths = rows.map((row) => row?.archivePath).sort()
  const actualWorldPaths = [...copiedSources.keys()].filter((path) => path.startsWith('server/world/')).sort()
  if (new Set(attestedPaths).size !== attestedPaths.length || actualWorldPaths.some((path) => !attestedPaths.includes(path))) {
    return { status: 'FAIL', reason: 'post-stop per-file observations must uniquely cover every archived world artifact' }
  }
  if (attestedPaths.some((path) => !actualWorldPaths.includes(path))) {
    return { status: 'INCOMPLETE', reason: 'one or more post-stop observed world artifacts were not supplied to the package' }
  }
  for (const row of rows) {
    const archivePath = row?.archivePath
    if (typeof archivePath !== 'string' || !archivePath.startsWith('server/world/')) {
      return { status: 'FAIL', reason: 'attestation contains an unsafe world artifact archive path' }
    }
    const actual = copiedSources.get(archivePath)
    const expectedPath = join(worldRoot, archivePath.slice('server/world/'.length).split('/').join('/'))
    if (!actual || typeof actual.path !== 'string' || !isAbsolute(actual.path)) {
      return { status: 'INCOMPLETE', reason: `actual world source path is absent: ${archivePath}` }
    }
    if (resolve(actual.path) !== resolve(expectedPath) || resolve(row.sourcePath ?? '') !== resolve(expectedPath)) {
      return { status: 'FAIL', reason: `actual package source, attested sourcePath, and exact worldRoot differ: ${archivePath}` }
    }
    const pathCheck = inspectActualNonSymlinkPath(actual.path)
    if (pathCheck.status !== 'PASS') return { status: pathCheck.status, reason: `${archivePath}: ${pathCheck.reason}` }
    if (resolve(row.realPath ?? '') !== pathCheck.realPath) {
      return { status: 'FAIL', reason: `attested realPath does not match the actual non-symlink path: ${archivePath}` }
    }
    actual.readReceipt = row
  }
  return { status: 'PASS', count: rows.length }
}

function inspectActualServerArtifacts(copiedSources, serverStart) {
  const launch = copiedSources.get('server/server.properties.launch')
  if (!serverStart || !launch || typeof launch.path !== 'string') {
    return { status: 'INCOMPLETE', reason: 'server-start or actual launch-properties source is absent', artifacts: null }
  }
  if (typeof serverStart.serverPropertiesPath !== 'string' || !isAbsolute(serverStart.serverPropertiesPath) ||
      resolve(serverStart.serverPropertiesPath) !== resolve(launch.path)) {
    return { status: 'FAIL', reason: 'actual --config path differs from the mapped launch-properties source', artifacts: null }
  }
  const configPathCheck = inspectActualNonSymlinkPath(launch.path)
  if (configPathCheck.status !== 'PASS') return { status: configPathCheck.status, reason: `launch properties: ${configPathCheck.reason}`, artifacts: null }
  const launchSha = sha256(launch.bytes)
  if (typeof serverStart.serverPropertiesSha256 !== 'string' || serverStart.serverPropertiesSha256.toLowerCase() !== launchSha) {
    return { status: 'FAIL', reason: 'actual --config properties hash differs from the archived launch-properties bytes', artifacts: null }
  }
  if (typeof serverStart.serverJar !== 'string' || !isAbsolute(serverStart.serverJar) ||
      typeof serverStart.serverJarSha256 !== 'string' || !/^[0-9a-f]{64}$/iu.test(serverStart.serverJarSha256)) {
    return { status: 'INCOMPLETE', reason: 'server-start omits an absolute JAR path or SHA-256', artifacts: null }
  }
  const jarPathCheck = inspectActualNonSymlinkPath(serverStart.serverJar)
  if (jarPathCheck.status !== 'PASS') return { status: jarPathCheck.status, reason: `server JAR: ${jarPathCheck.reason}`, artifacts: null }
  const jarBytes = regularFileBytes(serverStart.serverJar)
  if (jarBytes === null) return { status: 'INCOMPLETE', reason: 'actual server JAR bytes are not readable at the captured path', artifacts: null }
  const jarSha = sha256(jarBytes)
  if (jarSha !== serverStart.serverJarSha256.toLowerCase()) return { status: 'FAIL', reason: 'actual server JAR bytes differ from the spawned JAR SHA-256', artifacts: null }
  return {
    status: 'PASS',
    artifacts: {
      launchConfig: { archivePath: 'server/server.properties.launch', sourcePath: launch.path, bytes: launch.bytes.length, sha256: launchSha },
      serverJar: { sourcePath: serverStart.serverJar, bytes: jarBytes.length, sha256: jarSha },
    },
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

/** Resolve the required archived MCA region from the committed integer witness. */
function witnessRegionArchivePath(target) {
  if (!target || !Number.isSafeInteger(target.x) || !Number.isSafeInteger(target.y) || !Number.isSafeInteger(target.z)) return null
  const chunkX = Math.floor(target.x / 16)
  const chunkZ = Math.floor(target.z / 16)
  const regionX = Math.floor(chunkX / 32)
  const regionZ = Math.floor(chunkZ / 32)
  return `server/world/region/r.${regionX}.${regionZ}.mca`
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
    buildHash: typeof observed.generationReady?.buildHash === 'string' ? observed.generationReady.buildHash : null,
    worldKey: observed.worldKey ?? null,
    worldIdentity: observed.worldIdentity ?? null,
  }
}

function inspectLegacyBaselineArtifact(bytes, { identity, transition, repoPath }) {
  if (repoPath === null) return { status: 'INCOMPLETE', reason: 'comparison validation requires --repo to resolve the current origin/main source pin' }
  let originMainSha
  try {
    originMainSha = execFileSync('git', ['-C', repoPath, 'rev-parse', '--verify', 'origin/main'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().toLowerCase()
  } catch {
    return { status: 'INCOMPLETE', reason: 'comparison validation cannot resolve origin/main from --repo' }
  }
  if (!SHA40_RE.test(originMainSha)) return { status: 'INCOMPLETE', reason: 'comparison validation resolved no full origin/main SHA' }
  let proof
  try { proof = JSON.parse(bytes.toString('utf8')) }
  catch (error) { return { status: 'FAIL', reason: `comparison artifact is invalid JSON: ${error.message}` } }
  const assessment = inspectReachComparisonProof(proof, identity.sourceSha, originMainSha)
  if (assessment.status !== 'PASS') return assessment

  const vtr = proof.lineage?.vtr ?? {}
  const expectedWorldKey = worldKeyString(identity.worldKey)
  const expectedTransitionId = transition?.transitionId
  const expectedContractHash = transition?.contractHash
  const observedTransition = proof.metrics?.reachBoundary?.vtr ?? {}
  for (const [field, expected] of Object.entries({
    sourceSha: identity.sourceSha,
    runId: identity.runId,
    generationId: identity.generationId,
    buildHash: identity.buildHash,
    worldKey: expectedWorldKey,
  })) {
    if (typeof expected !== 'string' || vtr[field] !== expected) {
      return { status: 'FAIL', reason: `comparison VTR ${field} does not match the packaged live probe` }
    }
  }
  if (typeof expectedTransitionId !== 'string' || observedTransition.transitionId !== expectedTransitionId ||
      typeof expectedContractHash !== 'string' || observedTransition.contractHash !== expectedContractHash) {
    return { status: 'FAIL', reason: 'comparison Transition id/contract hash does not match the packaged live probe' }
  }
  return { status: 'PASS', reason: assessment.reason, originMainSha }
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

function loopbackPortFromWorldKey(value) {
  const worldKey = worldKeyString(value)
  const serverId = worldKey?.split('|', 1)[0]
  const match = /^127\.0\.0\.1:(\d{1,5})$/u.exec(String(serverId ?? ''))
  if (!match) return null
  const port = Number(match[1])
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null
}

function validProcessExitObservation(row, observation) {
  return observation?.schema === 'vtr-process-exit-observation/v1' &&
    observation.source === 'child-close-event' && observation.state === 'exited' &&
    observation.pid === row?.pid && observation.exitCode === row?.exitCode &&
    Number.isSafeInteger(observation.pid) && Number.isSafeInteger(observation.exitCode) &&
    timestamp(observation.observedAt) !== null
}

function validListenerClosureObservation(row, observation, expectedPort) {
  const processExitAt = timestamp(row?.processExitObservation?.observedAt)
  const observedAt = timestamp(observation?.observedAt)
  return observation?.schema === 'vtr-listener-closure-observation/v1' &&
    observation.source === 'tcp-connect-probe' && observation.state === 'closed' &&
    observation.host === '127.0.0.1' && observation.port === expectedPort &&
    observation.result === 'connection-refused' && observedAt !== null &&
    processExitAt !== null && observedAt >= processExitAt
}

function transitionIdFromMessage(message) {
  return /(?:^|\s)(?:id|transitionId)=([^\s]+)/u.exec(String(message ?? ''))?.[1] ?? null
}

function inspectLifecycleTranscript({ capture, identity, copiedSources, transitionRows, run }) {
  const raw = copiedSources.get('runner/host-lifecycle.jsonl')
  if (!raw) return { status: 'INCOMPLETE', reason: 'HOST lifecycle transcript runner/host-lifecycle.jsonl is absent' }
  let rows
  try { rows = recordsInJournal(raw.bytes, 'runner/host-lifecycle.jsonl') }
  catch (error) { return { status: 'INCOMPLETE', reason: `HOST lifecycle transcript is malformed: ${error.message}` } }
  const observed = capture?.lifecycle
  const digest = sha256(raw.bytes)
  if (!observed || !Number.isSafeInteger(observed.bytes) || typeof observed.sha256 !== 'string' ||
      !Number.isSafeInteger(observed.rows) || !Number.isSafeInteger(observed.malformedRows)) {
    return { status: 'INCOMPLETE', reason: 'provider capture omits lifecycle transcript byte/hash evidence' }
  }
  if (observed.bytes !== raw.bytes.length || observed.sha256.toLowerCase() !== digest) {
    return { status: 'FAIL', reason: 'HOST lifecycle transcript bytes/hash contradict the captured snapshot' }
  }
  if (observed.status !== 'OBSERVED' || observed.rows !== rows.length || observed.malformedRows !== 0 ||
      !Array.isArray(observed.problems) || observed.problems.length !== 0 ||
      rows.some((row) => row.schema !== 'vtr-reach-probe-lifecycle/v1')) {
    return { status: 'INCOMPLETE', reason: 'HOST lifecycle rows are malformed or unclassified' }
  }
  const byEvent = Object.fromEntries(['terminal-consumed', 'resident-stopped', 'server-stopped'].map((name) => [
    name, rows.filter((row) => row.event === name),
  ]))
  if (Object.values(byEvent).some((matches) => matches.length !== 1)) {
    return { status: 'INCOMPLETE', reason: 'HOST lifecycle must contain exactly one terminal-consumed, resident-stopped, and server-stopped row' }
  }
  const [terminalConsumed] = byEvent['terminal-consumed']
  const [residentStopped] = byEvent['resident-stopped']
  const [serverStopped] = byEvent['server-stopped']
  const identityWorld = worldKeyString(identity.worldKey)
  for (const row of [terminalConsumed, residentStopped, serverStopped]) {
    if (row.actor !== 'probe-harness' || row.sourceSha?.toLowerCase?.() !== identity.sourceSha ||
        row.runId !== identity.runId || row.generationId !== identity.generationId ||
        worldKeyString(row.worldKey) !== identityWorld) {
      return { status: 'FAIL', reason: `HOST ${row.event} identity contradicts the collector run` }
    }
    if (!Number.isFinite(timestamp(row.ts))) return { status: 'INCOMPLETE', reason: `HOST ${row.event} timestamp is missing or malformed` }
  }
  const terminalRows = transitionRows.filter((row) => eventName(row) === 'VTR_TRANSITION_OUTCOME')
  if (terminalRows.length !== 1) return { status: 'INCOMPLETE', reason: 'collector does not bind exactly one VTR terminal event' }
  const terminal = terminalRows[0]
  const detail = terminal.detail ?? {}
  const transitionId = detail.transitionId ?? transitionIdFromMessage(terminal.message)
  const contractHash = detail.contractHash
  const outcome = detail.outcome && typeof detail.outcome === 'object' ? detail.outcome : {}
  if (terminalConsumed.transitionId !== transitionId || terminalConsumed.contractHash !== contractHash ||
      terminalConsumed.outcomeKind !== outcome.kind || outcome.kind !== 'SUCCESS' ||
      !Array.isArray(terminalConsumed.evidenceIds) ||
      JSON.stringify(terminalConsumed.evidenceIds) !== JSON.stringify(outcome.evidenceIds)) {
    return { status: 'FAIL', reason: 'HOST terminal-consumed row does not bind the collector verified SUCCESS and evidence' }
  }
  for (const row of [residentStopped, serverStopped]) {
    if (!Number.isSafeInteger(row.pid) || row.pid <= 0 || !['stopped', 'exited'].includes(row.status) ||
        !Number.isSafeInteger(row.exitCode)) return { status: 'INCOMPLETE', reason: `HOST ${row.event} lacks process stop evidence` }
    if (timestamp(row.stoppedAt) !== timestamp(row.ts)) return { status: 'FAIL', reason: `HOST ${row.event} stoppedAt does not match event timestamp` }
    if (!validProcessExitObservation(row, row.processExitObservation) ||
        timestamp(row.processExitObservation?.observedAt) > timestamp(row.stoppedAt)) {
      return { status: 'INCOMPLETE', reason: `HOST ${row.event} lacks identity-consistent child-close process-exit observation` }
    }
  }
  const expectedServerPort = loopbackPortFromWorldKey(identity.worldKey)
  const residentExitAt = timestamp(residentStopped.processExitObservation?.observedAt)
  const serverExitAt = timestamp(serverStopped.processExitObservation?.observedAt)
  const listener = serverStopped.listenerClosureObservation
  if (expectedServerPort === null || !validListenerClosureObservation(serverStopped, listener, expectedServerPort) ||
      timestamp(listener?.observedAt) !== timestamp(serverStopped.stoppedAt) ||
      residentExitAt === null || serverExitAt === null || serverExitAt > timestamp(serverStopped.stoppedAt)) {
    return { status: 'INCOMPLETE', reason: 'HOST server stop lacks exact loopback TCP listener-closure observation after child exit' }
  }
  const host = copiedSources.get('runner/buddy.log')
  const shutdownAt = timestamp(capture?.window?.shutdownAt)
  const runShutdownAt = timestamp(run?.shutdownAt)
  const captureStart = timestamp(capture?.window?.startedAt)
  const captureEnd = timestamp(capture?.window?.endedAt)
  const bootAt = timestamp(capture?.window?.bootAt)
  const terminalAt = timestamp(terminal.ts ?? terminal.timestamp)
  const consumeAt = timestamp(terminalConsumed.ts)
  const residentAt = timestamp(residentStopped.stoppedAt)
  const serverAt = timestamp(serverStopped.stoppedAt)
  const lifecycleStart = timestamp(observed.firstObservedAt)
  const lifecycleClose = timestamp(observed.closedAt)
  if (!host || !Number.isFinite(shutdownAt) || !Number.isFinite(runShutdownAt) || !Number.isFinite(captureStart) ||
      !Number.isFinite(captureEnd) || !Number.isFinite(bootAt) || !Number.isFinite(terminalAt) ||
      !Number.isFinite(consumeAt) || !Number.isFinite(residentAt) || !Number.isFinite(serverAt) ||
      !Number.isFinite(lifecycleStart) || !Number.isFinite(lifecycleClose)) {
    return { status: 'INCOMPLETE', reason: 'HOST shutdown/continuous lifecycle capture timestamps or raw host log are missing' }
  }
  const hostLines = host.bytes.toString('utf8').split(/\r?\n/u)
  const shutdownLines = hostLines.filter((line) => /^\[[^\]]+\]\s+SHUTDOWN\b/u.test(line))
  if (shutdownLines.length !== 1 || timestamp(/^\[([^\]]+)\]/u.exec(shutdownLines[0])?.[1]) !== shutdownAt || shutdownAt !== runShutdownAt) {
    return { status: 'INCOMPLETE', reason: 'raw HOST SHUTDOWN line does not uniquely corroborate the lifecycle transcript' }
  }
  if (!(captureStart <= lifecycleStart && lifecycleStart <= bootAt && serverAt <= lifecycleClose && lifecycleClose <= captureEnd) ||
      capture.window?.lifecycleComplete !== true || capture.window?.serverStoppedAt !== serverStopped.stoppedAt) {
    return { status: 'INCOMPLETE', reason: 'HOST lifecycle transcript was not continuously observed from before BOOT through server stop' }
  }
  if (!(bootAt <= terminalAt && terminalAt <= consumeAt && consumeAt <= shutdownAt &&
      shutdownAt <= residentAt && residentAt <= serverAt)) {
    return { status: 'FAIL', reason: 'HOST lifecycle consume, shutdown, process stops, and continuous capture close are not causally ordered' }
  }
  if (!observed.events || JSON.stringify(observed.events.terminalConsumed) !== JSON.stringify(terminalConsumed) ||
      JSON.stringify(observed.events.residentStopped) !== JSON.stringify(residentStopped) ||
      JSON.stringify(observed.events.serverStopped) !== JSON.stringify(serverStopped)) {
    return { status: 'FAIL', reason: 'captured lifecycle event projection differs from raw HOST lifecycle transcript' }
  }
  return { status: 'OBSERVED', reason: null, bytes: raw.bytes.length, sha256: digest, events: observed.events }
}

function messageField(message, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return new RegExp(`(?:^|\\s)${escaped}=([^\\s]+)`, 'u').exec(String(message ?? ''))?.[1] ?? null
}

function deriveNoDoubleAuthorityProof({ identity, transitionRows, transition, copiedSources }) {
  const runJournal = copiedSources.get('runner/jev-run.jsonl')
  const proof = {
    schema: 'vtr-reach-no-double-authority/v1',
    result: 'INCOMPLETE',
    sourceSha: identity.sourceSha,
    runId: identity.runId,
    generationId: identity.generationId,
    worldKey: worldKeyString(identity.worldKey),
    transitionId: transition?.transitionId ?? null,
    contractHash: transition?.contractHash ?? null,
    legacyActuationCount: null,
    vtrActuationCount: null,
    controllerActuationEventCount: null,
    duplicateAuthority: null,
    duplicateAuthorityConflicts: null,
    evidence: { runJournal: { path: 'runner/jev-run.jsonl', bytes: runJournal?.bytes.length ?? null, sha256: runJournal ? sha256(runJournal.bytes) : null } },
    reasons: [],
    coverage: 'raw run journal skill ownership and VTR actuation markers; no metric-only inference',
  }
  if (!runJournal) {
    proof.reasons.push('raw VTR run journal is absent')
    return proof
  }
  let rows
  try { rows = recordsInJournal(runJournal.bytes, 'runner/jev-run.jsonl') }
  catch (error) {
    proof.reasons.push(`raw VTR run journal is malformed: ${error.message}`)
    return proof
  }
  const commitMatches = rows.map((row, index) => ({ row, index })).filter(({ row }) => eventName(row) === 'VTR_TRANSITION_COMMIT' &&
    (row.detail?.transitionId ?? messageField(row.message, 'id') ?? messageField(row.message, 'transitionId')) === proof.transitionId &&
    (row.detail?.contractHash ?? messageField(row.message, 'contractHash')) === proof.contractHash)
  const terminalMatches = rows.map((row, index) => ({ row, index })).filter(({ row }) => eventName(row) === 'VTR_TRANSITION_OUTCOME' &&
    (row.detail?.transitionId ?? messageField(row.message, 'id') ?? messageField(row.message, 'transitionId')) === proof.transitionId)
  if (commitMatches.length !== 1 || terminalMatches.length !== 1) {
    proof.reasons.push('raw journal does not contain exactly one matching Transition commit and terminal')
    return proof
  }
  const [commit] = commitMatches
  const [terminal] = terminalMatches
  if (commit.index >= terminal.index) {
    proof.reasons.push('Transition commit/terminal order is invalid')
    return proof
  }
  const inInterval = rows.map((row, index) => ({ row, index })).filter(({ index }) => index >= commit.index && index <= terminal.index)
  const movementStarts = inInterval.filter(({ row }) => eventName(row) === 'SKILL_START' &&
    String(row.detail?.actionId ?? messageField(row.message, 'actionId') ?? messageField(row.message, 'action') ?? '').startsWith('MOVE:'))
  const vtrSelector = (row) => row.detail?.selectedBy === 'vtr-transition' || String(row.message ?? '').includes('selectedBy=vtr-transition')
  const vtrStarts = movementStarts.filter(({ row }) => vtrSelector(row))
  const legacyMovementStarts = movementStarts.filter(({ row }) => !vtrSelector(row))
  const actionIdOf = (row) => row.detail?.actionId ?? messageField(row.message, 'actionId') ?? messageField(row.message, 'action')
  const vtrAction = vtrStarts.length === 1 ? actionIdOf(vtrStarts[0].row) : null
  const vtrEnds = vtrAction === null ? [] : inInterval.filter(({ row }) => eventName(row) === 'SKILL_END' && actionIdOf(row) === vtrAction)
  const actuationRows = inInterval.filter(({ row }) => eventName(row) === 'VTR_TRANSITION_ACTUATION' &&
    (row.detail?.transitionId ?? messageField(row.message, 'id') ?? messageField(row.message, 'transitionId')) === proof.transitionId &&
    (row.detail?.contractHash ?? messageField(row.message, 'contractHash') ?? proof.contractHash) === proof.contractHash &&
    (vtrAction === null || actionIdOf(row) === vtrAction))
  const verifyRows = inInterval.filter(({ row }) => ['VTR_TRANSITION_VERIFY', 'VTR_VERIFY', 'TRANSITION_VERIFY'].includes(eventName(row)) &&
    (row.detail?.transitionId ?? messageField(row.message, 'id') ?? messageField(row.message, 'transitionId')) === proof.transitionId &&
    (row.detail?.truth ?? row.detail?.verification?.truth ?? messageField(row.message, 'truth')) === 'TRUE')
  const terminalOutcome = terminal.row.detail?.outcome ?? {}
  const metrics = terminal.row.detail?.metrics ?? {}
  const reportedConflicts = Number(metrics.duplicateAuthorityConflicts)
  const reportedDuplicate = metrics.duplicateAuthority
  proof.legacyActuationCount = legacyMovementStarts.length
  proof.vtrActuationCount = vtrStarts.length
  proof.controllerActuationEventCount = actuationRows.length
  proof.duplicateAuthorityConflicts = Number.isSafeInteger(reportedConflicts) && reportedConflicts >= 0 ? reportedConflicts : null
  proof.duplicateAuthority = legacyMovementStarts.length > 0 || vtrStarts.length > 1 || actuationRows.length > 1 || reportedDuplicate === true || (proof.duplicateAuthorityConflicts ?? 0) > 0
  proof.evidence = {
    ...proof.evidence,
    commitRows: commitMatches.map(({ index }) => index),
    terminalRows: terminalMatches.map(({ index }) => index),
    vtrSkillStartRows: vtrStarts.map(({ index }) => index),
    legacySkillStartRows: legacyMovementStarts.map(({ index }) => index),
    controllerActuationRows: actuationRows.map(({ index }) => index),
    successfulSkillEndRows: vtrEnds.map(({ index }) => index),
    verifiedRows: verifyRows.map(({ index }) => index),
  }
  if (proof.duplicateAuthority) proof.reasons.push('raw journal or terminal metrics show duplicate or concurrent legacy movement authority')
  if (reportedDuplicate !== false || proof.duplicateAuthorityConflicts !== 0) proof.reasons.push('terminal metrics do not independently record duplicateAuthority=false and zero conflicts')
  if (vtrStarts.length !== 1 || legacyMovementStarts.length !== 0 || actuationRows.length !== 1 ||
      vtrEnds.length !== 1 || !String(vtrEnds[0]?.row.message ?? '').includes('execution=success') ||
      !String(vtrEnds[0]?.row.message ?? '').includes('verification=verified') || !String(vtrEnds[0]?.row.message ?? '').includes('outcome=SUCCESS') ||
      verifyRows.length !== 1 || terminalOutcome.kind !== 'SUCCESS') {
    proof.reasons.push('raw movement/actuation/VERIFY/SUCCESS evidence is missing, failed, or non-unique')
  }
  if (proof.reasons.length === 0) proof.result = 'PASS'
  else if (proof.duplicateAuthority || reportedDuplicate === true || (proof.duplicateAuthorityConflicts ?? 0) > 0 ||
      legacyMovementStarts.length > 0 || vtrStarts.length > 1 || actuationRows.length > 1 || vtrEnds.some(({ row }) => String(row.message ?? '').includes('execution=failed'))) {
    proof.result = 'FAIL'
  }
  return proof
}

function inspectNoLlmEgressAudit({ copiedSources, identity, run, capture, lifecycle }) {
  const raw = copiedSources.get('runner/no-llm-egress-audit.json')
  const result = {
    schema: 'vtr-no-llm-egress-binding/v1',
    status: 'INCOMPLETE',
    sourceSha: identity.sourceSha,
    runId: identity.runId,
    generationId: identity.generationId,
    worldKey: worldKeyString(identity.worldKey),
    coverageClass: 'user-space-libc-interposition',
    coverageStatus: null,
    rawArtifact: { path: 'runner/no-llm-egress-audit.json', bytes: raw?.bytes.length ?? null, sha256: raw ? sha256(raw.bytes) : null },
    window: {
      startedAt: capture?.window?.startedAt ?? null,
      generationReadyAt: capture?.window?.generationReadyAt ?? null,
      shutdownAt: capture?.window?.shutdownAt ?? null,
      residentStoppedAt: lifecycle?.events?.residentStopped?.stoppedAt ?? null,
      serverStoppedAt: lifecycle?.events?.serverStopped?.stoppedAt ?? null,
      endedAt: capture?.window?.endedAt ?? null,
    },
    externalDeniedAttempts: null,
    guardLoadedRows: 0,
    reasons: [],
    limitations: ['USERSPACE_ONLY: LD_PRELOAD libc interception only; raw syscalls, io_uring, static binaries, escaped/new-session descendants, and AF_UNIX proxy behavior are not covered; no kernel isolation claim.'],
  }
  if (!raw) {
    result.reasons.push('raw LD_PRELOAD audit artifact is absent')
    return result
  }
  let rows
  try { rows = recordsInJournal(raw.bytes, 'runner/no-llm-egress-audit.json') }
  catch (error) {
    result.reasons.push(`raw LD_PRELOAD audit is malformed: ${error.message}`)
    return result
  }
  if (rows.length === 0 || rows.some((row) => row.schema !== 'vtr-no-llm-egress-audit/v1' ||
      !['guard_loaded', 'blocked_egress', 'guard_wrapper_closed'].includes(row.event))) {
    result.reasons.push('raw LD_PRELOAD audit contains no rows or an unknown schema/event')
    return result
  }
  const loadedRows = rows.filter((row) => row.event === 'guard_loaded')
  const blockedRows = rows.filter((row) => row.event === 'blocked_egress')
  const closeRows = rows.filter((row) => row.event === 'guard_wrapper_closed')
  result.guardLoadedRows = loadedRows.length
  result.externalDeniedAttempts = blockedRows.length
  if (closeRows.length !== 1 || loadedRows.length === 0) {
    result.reasons.push('audit requires at least one guard_loaded row and exactly one guard_wrapper_closed row')
    return result
  }
  const close = closeRows[0]
  const resident = lifecycle?.events?.residentStopped
  if (!resident) {
    result.reasons.push('identity-bound HOST resident-stopped row is unavailable for PID binding')
    return result
  }
  const hashes = ['toolSha256', 'sourceSha256', 'librarySha256', 'policySha256']
  const closeHashValues = Object.fromEntries(hashes.map((key) => [key, close[key]]))
  if (hashes.some((key) => typeof close[key] !== 'string' || !/^[0-9a-f]{64}$/iu.test(close[key]))) {
    result.reasons.push('guard wrapper close lacks complete SHA-256 provenance')
    return result
  }
  const rootLoadedRows = loadedRows.filter((row) => row.pid === close.childPid)
  const processKeys = loadedRows.map((row) => `${row.pid}:${row.processStartTicks}`)
  const loadedProcessKeys = new Set(processKeys)
  const loadedFor = (row) => loadedRows.filter((entry) => entry.pid === row.pid && entry.processStartTicks === row.processStartTicks)
  if (rootLoadedRows.length !== 1 || loadedProcessKeys.size !== loadedRows.length || loadedRows.some((row) => !Number.isSafeInteger(row.pid) || row.pid < 1 ||
      !Number.isSafeInteger(row.processStartTicks) || row.processStartTicks < 1 ||
      !Number.isSafeInteger(row.processGroupId) || row.processGroupId !== close.childPid ||
      row.reason !== 'preload-active' || hashes.some((key) => row[key] !== close[key])) ||
      blockedRows.some((row) => !Number.isSafeInteger(row.processStartTicks) ||
        !Number.isSafeInteger(row.processGroupId) || row.processGroupId !== close.childPid ||
        loadedFor(row).length !== 1 || hashes.some((key) => row[key] !== close[key]))) {
    result.reasons.push('guard_loaded evidence does not prove root and observed descendants with matching guard artifact hashes')
    result.status = 'FAIL'
    result.coverageStatus = close.coverageStatus ?? null
    return result
  }
  if (close.childPid !== resident.pid || close.childExitCode !== resident.exitCode ||
      close.preloadVerified !== true || close.processGroupGone !== true ||
      close.coverageClass !== 'user-space-libc-interposition' || close.coverageStatus !== 'USERSPACE_ONLY_CLOSED' ||
      close.externalDeniedAttempts !== blockedRows.length || close.guardLoadedRows !== loadedRows.length ||
      close.auditPathIdentityVerified !== true || !/^\d+$/u.test(String(close.auditDevice ?? '')) || !/^\d+$/u.test(String(close.auditInode ?? '')) ||
      !String(close.coverage ?? '').includes('syscall-bypass-not-covered')) {
    result.reasons.push('guard closure does not bind the stopped resident or does not attest USERSPACE_ONLY_CLOSED coverage')
    result.coverageStatus = close.coverageStatus ?? null
    return result
  }
  result.coverageStatus = close.coverageStatus
  const windowStart = timestamp(result.window.startedAt)
  const readyAt = timestamp(result.window.generationReadyAt)
  const shutdownAt = timestamp(result.window.shutdownAt)
  const residentStoppedAt = timestamp(result.window.residentStoppedAt)
  const endAt = timestamp(result.window.endedAt)
  const serverStopAt = timestamp(result.window.serverStoppedAt)
  const eventTimes = rows.map((row) => timestamp(row.utc))
  const cRows = rows.filter((row) => row.event !== 'guard_wrapper_closed')
  const monotonicValues = cRows.map((row) => /^\d+$/u.test(String(row.monotonicNs ?? '')) ? BigInt(row.monotonicNs) : null)
  const closedAt = timestamp(close.utc)
  if (rows.at(-1) !== close || cRows.some((row) => row.monotonicClock !== 'CLOCK_MONOTONIC') || close.monotonicClock !== 'process.hrtime.relative' ||
      monotonicValues.some((value, index) => value === null || index > 0 && value < monotonicValues[index - 1]) ||
      ![windowStart, readyAt, shutdownAt, residentStoppedAt, endAt, serverStopAt, closedAt, ...eventTimes].every(Number.isFinite) ||
      eventTimes.some((at) => at < windowStart || at > closedAt) || shutdownAt > closedAt ||
      closedAt < timestamp(resident.processExitObservation?.observedAt) || closedAt > serverStopAt || serverStopAt > endAt || closedAt > endAt) {
    result.reasons.push('guard audit timestamps are outside the continuous identity-bound run window')
    return result
  }
  if (blockedRows.length > 0) {
    result.status = 'FAIL'
    result.reasons.push('LD_PRELOAD audit recorded one or more denied external egress attempts')
    return result
  }
  result.status = 'OBSERVED_ZERO'
  return result
}

function inspectNoDoubleAuthorityFixture({ copiedSources, identity }) {
  const reportSource = copiedSources.get(AUTHORITY_FIXTURE_REPORT_PATH)
  const testSource = copiedSources.get(AUTHORITY_FIXTURE_SOURCE_PATH)
  const result = {
    schema: 'vtr-reach-no-double-authority-fixture/v1',
    status: 'INCOMPLETE',
    sourceSha: identity.sourceSha,
    rawReport: { path: AUTHORITY_FIXTURE_REPORT_PATH, bytes: reportSource?.bytes.length ?? null, sha256: reportSource ? sha256(reportSource.bytes) : null },
    testSource: { path: AUTHORITY_FIXTURE_SOURCE_PATH, bytes: testSource?.bytes.length ?? null, sha256: testSource ? sha256(testSource.bytes) : null },
    test: { path: AUTHORITY_FIXTURE_TEST_PATH, name: AUTHORITY_FIXTURE_TEST_NAME },
    fixture: null,
    reasons: [],
  }
  if (!reportSource || !testSource) {
    result.reasons.push(`exact-source authority refusal proof requires both ${AUTHORITY_FIXTURE_REPORT_PATH} and ${AUTHORITY_FIXTURE_SOURCE_PATH}`)
    return result
  }
  let report
  try { report = JSON.parse(reportSource.bytes.toString('utf8')) }
  catch (error) {
    result.reasons.push(`fixture proof report is malformed JSON: ${error.message}`)
    return result
  }
  result.fixture = report.fixture ?? null
  if (report.schema !== 'vtr-reach-no-double-authority-fixture/v1' || report.result !== 'PASS' ||
      report.test?.path !== AUTHORITY_FIXTURE_TEST_PATH || report.test?.name !== AUTHORITY_FIXTURE_TEST_NAME) {
    result.status = 'FAIL'
    result.reasons.push('authority refusal fixture report schema, result, or exact test identity contradicts the required fixture')
    return result
  }
  if (typeof report.sourceSha !== 'string' || report.sourceSha.toLowerCase() !== identity.sourceSha ||
      typeof report.test.sourceSha256 !== 'string' || report.test.sourceSha256.toLowerCase() !== sha256(testSource.bytes)) {
    result.status = 'FAIL'
    result.reasons.push('authority refusal fixture report source SHA or archived test source hash does not match the exact run')
    return result
  }
  const fixture = report.fixture
  const required = ['legacyClaimRejected', 'legacyClaimError', 'vtrOwnerRetained', 'transitionId', 'contractHash',
    'pathfinderStartsBeforeLegacyClaim', 'pathfinderStartsAfterLegacyClaim', 'pathfinderStartDelta', 'authorityConflictCount', 'maxConcurrentActions']
  const missing = required.filter((key) => fixture?.[key] === undefined || fixture?.[key] === null)
  if (missing.length) {
    result.reasons.push(`authority refusal fixture omits observed fields: ${missing.join(', ')}`)
    return result
  }
  const before = fixture.pathfinderStartsBeforeLegacyClaim
  const after = fixture.pathfinderStartsAfterLegacyClaim
  if (fixture.legacyClaimRejected !== true || fixture.legacyClaimError !== 'ExecutionAuthorityConflict' ||
      fixture.vtrOwnerRetained !== true || typeof fixture.transitionId !== 'string' || fixture.transitionId.length === 0 ||
      typeof fixture.contractHash !== 'string' || !/^[0-9a-f]{64}$/iu.test(fixture.contractHash) ||
      !Number.isSafeInteger(before) || !Number.isSafeInteger(after) || fixture.pathfinderStartDelta !== after - before ||
      fixture.pathfinderStartDelta !== 0 || fixture.authorityConflictCount !== 1 || fixture.maxConcurrentActions !== 1) {
    result.status = 'FAIL'
    result.reasons.push('fixture did not preserve the VTR owner/contract while rejecting legacy claim without another Pathfinder start')
    return result
  }
  result.status = 'PASS'
  return result
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
  const serverStoppedAt = timestamp(window.serverStoppedAt)
  const lifecycle = inspectLifecycleTranscript({ capture, identity, copiedSources, transitionRows, run })
  result.lifecycle = lifecycle
  const windowCoversRun = readyAt !== null && terminalAt !== null && windowStart !== null && windowEnd !== null
    && windowStart <= Math.min(readyAt, collectorWindowStart ?? readyAt)
    && windowEnd >= Math.max(terminalAt, collectorWindowEnd ?? terminalAt, serverStoppedAt ?? Number.POSITIVE_INFINITY)
    && window.coverageComplete === true
  const counters = capture.activity ?? {}
  const providerCounterNames = ['networkModelCalls', 'jevEvaluateAttempts', 'system2EvaluateAttempts']
  const zeroCounters = providerCounterNames.every((key) => counters[key] === 0)
  const nonzeroCounters = providerCounterNames.some((key) => Number.isSafeInteger(counters[key]) && counters[key] > 0)
  const captureJournals = capture.journals ?? {}
  const reportJournals = Object.fromEntries(PROVIDER_JOURNALS.map((name) => [name, findCollectorInput(collectorReport, name)]))
  const checks = []
  const recordsByJournal = {}
  let rawJournalParseFailed = false
  let integrityConflict = false
  for (const name of PROVIDER_JOURNALS) {
    const captureEntry = captureJournals[name]
    const reportEntry = reportJournals[name]
    const archivePath = PROVIDER_ARCHIVE_PATHS[name]
    const copied = copiedSources.get(archivePath)
    const ready = timestamp(run?.generationReadyAt)
    const end = timestamp(terminalRows[0]?.ts ?? terminalRows[0]?.timestamp)
    const armed = timestamp(captureEntry?.initializedAt)
    const closed = timestamp(captureEntry?.closedAt)
    const digest = copied ? sha256(copied.bytes) : null
    const collectorEnd = timestamp(collectorReport?.captureWindow?.endedAt)
    const collectionStart = timestamp(collectorReport?.captureWindow?.startedAt)
    const collectorAttested = name === 'mercury-calls'
      ? captureEntry !== undefined && captureEntry !== null
      : reportEntry?.status === 'captured'
        && Number.isSafeInteger(reportEntry.bytes)
        && reportEntry.bytes === copied?.bytes.length
        && typeof reportEntry.sha256 === 'string'
        && digest === reportEntry.sha256.toLowerCase()
    const matches = collectorAttested
      && Number.isSafeInteger(captureEntry?.bytes)
      && captureEntry.bytes === copied?.bytes.length
      && typeof captureEntry?.sha256 === 'string'
      && captureEntry.sha256.toLowerCase() === digest
      && armed !== null && ready !== null && armed <= Math.min(ready, collectionStart ?? ready)
      && closed !== null && end !== null && serverStoppedAt !== null && closed >= Math.max(end, collectorEnd ?? end, serverStoppedAt)
      && copied !== undefined
    result.journals[name] = {
      status: reportEntry?.status ?? (name === 'mercury-calls' && copied ? 'captured-by-provider-watch' : 'missing'),
      archivePath,
      bytes: copied?.bytes.length ?? null,
      sha256: digest,
      initializedAt: captureEntry?.initializedAt ?? null,
      closedAt: captureEntry?.closedAt ?? null,
    }
    if (copied === undefined) {
      recordsByJournal[name] = null
      checks.push({ matches: false, activityObserved: false, integrityConflict: false, parseFailed: false })
      continue
    }
    try {
      const rows = recordsInJournal(copied.bytes, archivePath)
      recordsByJournal[name] = rows
    } catch {
      rawJournalParseFailed = true
      recordsByJournal[name] = null
    }
    const reportBytesMismatch = name !== 'mercury-calls'
      && reportEntry?.status === 'captured'
      && (reportEntry.bytes !== copied.bytes.length || String(reportEntry.sha256 ?? '').toLowerCase() !== digest)
    const captureBytesMismatch = captureEntry !== undefined && captureEntry !== null
      && (captureEntry.bytes !== copied.bytes.length || String(captureEntry.sha256 ?? '').toLowerCase() !== digest)
    integrityConflict ||= reportBytesMismatch || captureBytesMismatch
    const journalAttempts = name === 'jev-calls' || name === 'mercury-calls'
      ? recordsByJournal[name]?.some((row) => Number(row.providerAttempts ?? row.attempts) > 0) === true
      : false
    checks.push({ matches, activityObserved: journalAttempts, integrityConflict: reportBytesMismatch || captureBytesMismatch, parseFailed: recordsByJournal[name] === null })
  }
  const rawClassification = classifyProviderActivity(recordsByJournal)
  const classificationMatches = JSON.stringify(rawClassification) === JSON.stringify(capture.activityClassification)
  const actualProviderPositive = [rawClassification.providers.jevEvaluateAttempts, rawClassification.providers.system2EvaluateAttempts]
    .some((value) => Number.isSafeInteger(value) && value > 0) || rawClassification.positiveProviderActivityObserved === true
  const classificationUnknown = rawClassification.unknown.length > 0 || !classificationMatches
  const actualActivity = {
    ...rawClassification.decisions,
    ...rawClassification.providers,
  }
  const captureActivityMatches = JSON.stringify(actualActivity) === JSON.stringify(counters)
  const collectorPolicyPass = Array.isArray(collectorReport?.checks)
    && collectorReport.checks.some((entry) => entry.id === 'policy:no-model-activity-during-probe' && entry.status === 'PASS')
    && collectorReport.checks.some((entry) => entry.id === 'policy:provider-journals' && entry.status === 'PASS')
  const collectorMetrics = collectorReport?.observed?.transition?.metrics ?? {}
  const collectorCountersZero = Number(collectorMetrics.providerEvaluateAttemptsIncludingRetries) === 0
    && Number(collectorMetrics.system2CallsPerTransition) === 0
  if (capture.schema === 'vtr-provider-activity-capture/v2' && capture.status === 'OBSERVED'
    && runIdentityMatches && windowCoversRun && zeroCounters && checks.every((entry) => entry.matches)
    && lifecycle.status === 'OBSERVED'
    && classificationMatches && captureActivityMatches && rawClassification.unknown.length === 0
    && !rawJournalParseFailed && !integrityConflict && !actualProviderPositive
    && collectorPolicyPass && collectorCountersZero) {
    result.status = 'OBSERVED_ZERO'
    result.reason = null
    result.activity = counters
  } else {
    const activityDetected = nonzeroCounters || actualProviderPositive || checks.some((entry) => entry.activityObserved)
    result.status = !runIdentityMatches || activityDetected || integrityConflict || lifecycle.status === 'FAIL' ? 'FAIL' : 'INCOMPLETE'
    result.reason = !runIdentityMatches
      ? 'provider capture identity contradicts the collector run identity'
      : activityDetected
        ? 'provider attempt counters or raw journals show model/provider activity during the no-LLM probe'
      : integrityConflict
          ? 'provider capture hashes contradict the raw archived journal bytes'
      : lifecycle.status !== 'OBSERVED'
        ? lifecycle.reason
      : !windowCoversRun
        ? 'provider capture did not attest continuous coverage from before GENERATION_READY through HOST terminal consume and server stop'
      : !zeroCounters
          ? 'provider attempt activity counters are missing or not exactly zero'
          : !checks.every((entry) => entry.matches)
            ? 'one or more decision/provider journals were absent, changed, or not observed from startup through terminal'
          : classificationUnknown || rawJournalParseFailed
            ? 'one or more raw decision/provider journals have malformed or unclassified records'
          : !captureActivityMatches
            ? 'provider capture decision/activity counters disagree with raw journal contents'
          : !collectorCountersZero
            ? 'collector terminal provider-attempt counters do not independently record zero model calls'
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

function makeProbe({ report, identity, metadata, transition, bundle, providerCaptureResult, egressAuditResult, authorityFixtureResult }) {
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
  if (providerCaptureResult.activity) {
    const activity = providerCaptureResult.activity
    config.networkModelCalls = activity.networkModelCalls
    config.effectiveJev.decisionCalls = activity.jevDecisionFrames
    config.effectiveJev.providerEvaluateAttempts = activity.jevEvaluateAttempts
    config.effectiveSystem2.decisionCalls = activity.system2DecisionInvocations
    config.effectiveSystem2.providerEvaluateAttempts = activity.system2EvaluateAttempts
    config.policyActivity = structuredClone(activity)
    const mechanicalSteps = Number(transition?.metrics?.mechanicalStepsPerTransition)
    config.providerEvaluateAttemptsPerMechanicalStep = Number.isFinite(mechanicalSteps) && mechanicalSteps > 0
      && Number.isSafeInteger(activity.networkModelCalls)
      ? activity.networkModelCalls / mechanicalSteps
      : null
    config.deprecatedModelCallsPerMechanicalStep = transition?.metrics?.modelCallsPerMechanicalStep ?? null
  } else {
    config.networkModelCalls = null
    config.providerEvaluateAttemptsPerMechanicalStep = null
    config.deprecatedModelCallsPerMechanicalStep = transition?.metrics?.modelCallsPerMechanicalStep ?? null
  }
  if (providerCaptureResult.status === 'OBSERVED_ZERO') {
    config.fallback = {
      ...noLlmFallback,
      fallbackPolicyWasExplicitlyConfigured: noLlmFallback?.fallbackPolicyWasExplicitlyConfigured,
      silentFallbackOnProviderFailure: noLlmFallback?.silentFallbackOnProviderFailure,
      JevDecisionInvoked: noLlmFallback?.JevDecisionInvoked,
    }
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
    egressAudit: egressAuditResult,
    noDoubleAuthorityFixture: authorityFixtureResult,
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

export function packageVtrReachArchive({ collectorReportPath, manifestPath, archivePath, repoPath = null }) {
  const collectorReportFile = resolve(collectorReportPath)
  const manifestFile = resolve(manifestPath)
  const outputRoot = resolve(archivePath)
  const comparisonRepo = typeof repoPath === 'string' && repoPath.trim() !== '' ? resolve(repoPath) : null
  if (existsSync(outputRoot)) throw new Error(`archive destination already exists: ${outputRoot}`)
  const report = readJson(collectorReportFile, 'collector report')
  const manifest = readJson(manifestFile, 'input manifest')
  if (manifest.schema !== 'vtr-reach-live-archive-input/v1') throw new Error('manifest schema must be vtr-reach-live-archive-input/v1')
  if (!manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) throw new Error('manifest.files must map archive-relative paths to captured source files')

  mkdirSync(outputRoot, { recursive: false, mode: 0o700 })
  const statuses = []
  const archiveFiles = new Set()
  const copiedSources = new Map()
  let legacyBaselineComparison = { status: 'INCOMPLETE', reason: 'comparison artifact is absent' }
  const manifestDir = dirname(manifestFile)
  const collectorDir = dirname(collectorReportFile)
  const identity = identityFromCollector(report)
  identity.mission = report.expected?.mission ?? null
  const transitionRows = collectorRows(report)
  const transition = projectTransition(report)
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
    if (archiveRelative === 'probe.json' || archiveRelative === 'SHA256SUMS' || archiveRelative === 'packaging-report.json' ||
        archiveRelative === 'collector-report.json' || archiveRelative === 'proofs/no-double-authority.json') {
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
    check(statuses, 'PASS', `manifest-file:${archiveRelative}`, {
      bytes: bytes.length,
      sha256: sha256(bytes),
      ...(archiveRelative.startsWith('server/world/') ? { sourcePath: source } : {}),
    })

    if (archiveRelative === 'comparison/legacy-baseline.json') {
      legacyBaselineComparison = inspectLegacyBaselineArtifact(bytes, { identity, transition, repoPath: comparisonRepo })
      if (legacyBaselineComparison.status === 'PASS') check(statuses, 'PASS', 'comparison:legacy-baseline', { originMainSha: legacyBaselineComparison.originMainSha })
      else if (legacyBaselineComparison.status === 'FAIL') check(statuses, 'FAIL', 'comparison:legacy-baseline', { reason: legacyBaselineComparison.reason })
      else check(statuses, 'INCOMPLETE', 'comparison:legacy-baseline', { reason: legacyBaselineComparison.reason })
    } else if (archiveRelative.endsWith('.json') && archiveRelative !== 'runner/no-llm-egress-audit.json') {
      try {
        const document = JSON.parse(bytes.toString('utf8'))
        const conflicts = collectIdentityConflicts(document, identity)
        if (conflicts.length) check(statuses, 'FAIL', `identity:${archiveRelative}`, { reason: 'structured artifact contains source/run/world identity conflicting with collector', conflicts })
      } catch (error) {
        check(statuses, 'FAIL', `json:${archiveRelative}`, { reason: error.message })
      }
    } else if (archiveRelative.endsWith('.jsonl') || archiveRelative === 'runner/no-llm-egress-audit.json') {
      try {
        const rows = recordsInJournal(bytes, archiveRelative)
        const conflicts = collectIdentityConflicts(rows, identity)
        if (conflicts.length) check(statuses, 'FAIL', `identity:${archiveRelative}`, { reason: 'journal rows contain source/run/world identity conflicting with collector', conflicts })
      } catch (error) {
        const providerEvidence = Object.values(PROVIDER_ARCHIVE_PATHS).includes(archiveRelative)
        check(statuses, providerEvidence ? 'INCOMPLETE' : 'FAIL', `jsonl:${archiveRelative}`, { reason: error.message })
      }
    }
  }

  for (const requiredPath of REQUIRED_ARCHIVE_PATHS) {
    if (!archiveFiles.has(requiredPath)) check(statuses, 'INCOMPLETE', `required:${requiredPath}`, { reason: 'no run-scoped source artifact was supplied for this validator input' })
  }
  const requiredWitnessRegionPath = witnessRegionArchivePath(transition?.witness?.target)
  const metadataBytes = copiedSources.get('runner/run-metadata.json')?.bytes ?? null
  let metadata = null
  if (metadataBytes !== null) {
    try { metadata = JSON.parse(metadataBytes.toString('utf8')) } catch { metadata = null }
  }
  const botUuid = String(metadata?.run?.botUuid ?? '').toLowerCase()
  const requiredPlayerDataPath = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(botUuid)
    ? `server/world/playerdata/${botUuid}.dat`
    : null
  if (requiredPlayerDataPath === null) {
    check(statuses, 'INCOMPLETE', 'required:world-playerdata', { reason: 'run metadata has no canonical bot UUID for exact playerdata path' })
  } else if (!archiveFiles.has(requiredPlayerDataPath)) {
    check(statuses, 'INCOMPLETE', 'required:world-playerdata', { reason: 'UUID-bound Minecraft playerdata file was not supplied', path: requiredPlayerDataPath })
  } else {
    check(statuses, 'PASS', 'required:world-playerdata', { path: requiredPlayerDataPath })
  }
  if (requiredWitnessRegionPath === null) {
    check(statuses, 'INCOMPLETE', 'required:world-witness-region', { reason: 'committed Transition has no integer witness coordinates' })
  } else if (!archiveFiles.has(requiredWitnessRegionPath)) {
    check(statuses, 'INCOMPLETE', 'required:world-witness-region', { reason: 'coordinate-derived MCA region for the committed witness was not supplied', expectedPath: requiredWitnessRegionPath, witness: transition.witness.target })
  } else {
    check(statuses, 'PASS', 'required:world-witness-region', { path: requiredWitnessRegionPath, witness: transition.witness.target })
  }

  const captureBytes = copiedSources.get('runner/provider-activity-capture.json')?.bytes ?? null
  let providerCapture = null
  if (captureBytes !== null) {
    try { providerCapture = JSON.parse(captureBytes.toString('utf8')) } catch { providerCapture = null }
  }
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

  const egressAuditResult = inspectNoLlmEgressAudit({
    copiedSources,
    identity,
    run: metadata?.run,
    capture: providerCapture,
    lifecycle: providerCaptureResult.lifecycle,
  })
  if (egressAuditResult.status === 'OBSERVED_ZERO') check(statuses, 'PASS', 'policy:no-llm-egress-audit', { status: egressAuditResult.status, coverageStatus: egressAuditResult.coverageStatus, rawArtifact: egressAuditResult.rawArtifact, window: egressAuditResult.window, limitations: egressAuditResult.limitations })
  else check(statuses, egressAuditResult.status === 'FAIL' ? 'FAIL' : 'INCOMPLETE', 'policy:no-llm-egress-audit', { status: egressAuditResult.status, reason: egressAuditResult.reasons.join('; '), coverageStatus: egressAuditResult.coverageStatus, rawArtifact: egressAuditResult.rawArtifact, limitations: egressAuditResult.limitations })

  const authorityFixtureResult = inspectNoDoubleAuthorityFixture({ copiedSources, identity })
  if (authorityFixtureResult.status === 'PASS') check(statuses, 'PASS', 'proof:no-double-authority-fixture', {
    sourceSha: identity.sourceSha, testSourceSha256: authorityFixtureResult.testSource.sha256,
    transitionId: authorityFixtureResult.fixture.transitionId, contractHash: authorityFixtureResult.fixture.contractHash,
    pathfinderStartDelta: authorityFixtureResult.fixture.pathfinderStartDelta,
  })
  else check(statuses, authorityFixtureResult.status === 'FAIL' ? 'FAIL' : 'INCOMPLETE', 'proof:no-double-authority-fixture', {
    reason: authorityFixtureResult.reasons.join('; '), testSource: authorityFixtureResult.testSource,
  })

  const noDoubleAuthorityProof = deriveNoDoubleAuthorityProof({ identity, transitionRows, transition, copiedSources })
  writeFile(outputRoot, 'proofs/no-double-authority.json', Buffer.from(`${JSON.stringify(noDoubleAuthorityProof, null, 2)}\n`))
  archiveFiles.add('proofs/no-double-authority.json')
  copiedSources.set('proofs/no-double-authority.json', { bytes: Buffer.from(`${JSON.stringify(noDoubleAuthorityProof, null, 2)}\n`), path: null })
  if (noDoubleAuthorityProof.result === 'PASS') check(statuses, 'PASS', 'proof:no-double-authority', { sourceSha: identity.sourceSha, runId: identity.runId, transitionId: noDoubleAuthorityProof.transitionId, evidence: noDoubleAuthorityProof.evidence })
  else check(statuses, noDoubleAuthorityProof.result === 'FAIL' ? 'FAIL' : 'INCOMPLETE', 'proof:no-double-authority', { reason: noDoubleAuthorityProof.reasons.join('; '), evidence: noDoubleAuthorityProof.evidence })

  const bundle = copiedSources.get('runner/generation-bundle.mjs')?.bytes ?? null
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
  let serverStart = null
  let actualServerArtifacts = null
  if (serverStartBytes !== null) {
    try {
      serverStart = JSON.parse(serverStartBytes.toString('utf8'))
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
  actualServerArtifacts = inspectActualServerArtifacts(copiedSources, serverStart)
  if (actualServerArtifacts.status === 'PASS') check(statuses, 'PASS', 'server:spawned-artifacts', actualServerArtifacts.artifacts)
  else check(statuses, actualServerArtifacts.status, 'server:spawned-artifacts', { reason: actualServerArtifacts.reason })
  const worldSourcePathResult = inspectActualWorldSources(copiedSources)
  if (worldSourcePathResult.status === 'PASS') check(statuses, 'PASS', 'server:world-source-filesystem', { artifacts: worldSourcePathResult.count })
  else check(statuses, worldSourcePathResult.status, 'server:world-source-filesystem', { reason: worldSourcePathResult.reason })
  const freshWorldResult = inspectFreshWorldAttestation({
    copiedSources,
    identity,
    run,
    serverStart,
    expectedWitnessRegionPath: requiredWitnessRegionPath,
    lifecycle: providerCaptureResult.lifecycle,
  })
  if (freshWorldResult.status === 'PASS') check(statuses, 'PASS', 'server:fresh-world-attestation', {
    identity: freshWorldResult.identity, artifacts: freshWorldResult.artifacts,
  })
  else check(statuses, freshWorldResult.status, 'server:fresh-world-attestation', { reason: freshWorldResult.reason })
  if (metadata && runIdentityConflicts.length === 0 && readinessMissing.length === 0 && archiveFiles.has('runner/run-metadata.json')) {
    const probe = makeProbe({ report, identity, metadata, transition, bundle, providerCaptureResult, egressAuditResult, authorityFixtureResult })
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
  const fullMilestoneMissing = ['comparison/legacy-baseline.json'].filter((path) => !archiveFiles.has(path))
  const failed = statuses.some((entry) => entry.status === 'FAIL')
  const incomplete = statuses.some((entry) => entry.status === 'INCOMPLETE') || report.status === 'INCOMPLETE'
  const packageStatus = failed || report.status === 'FAIL' ? 'FAIL' : incomplete ? 'INCOMPLETE' : 'READY_FOR_VALIDATION'
  const packageReport = {
    schema: 'vtr-reach-live-archive-package/v1',
    packageStatus,
    acceptanceEligible: false,
    readOnly: true,
    collectorReport: { schema: report.schema ?? null, status: report.status ?? null, capturedAt: report.capturedAt ?? null },
    identity: { sourceSha: identity.sourceSha, runId: identity.runId, generationId: identity.generationId, buildHash: identity.buildHash, worldKey: identity.worldKey },
    providerActivity: providerCaptureResult,
    egressAudit: egressAuditResult,
    noDoubleAuthorityFixture: authorityFixtureResult,
    legacyBaselineComparison,
    freshWorld: freshWorldResult,
    requiredValidatorPaths: [...REQUIRED_ARCHIVE_PATHS,
      ...(requiredWitnessRegionPath === null ? [] : [requiredWitnessRegionPath]),
      ...(requiredPlayerDataPath === null ? [] : [requiredPlayerDataPath])],
    requiredWitnessRegionPath,
    sourceOrigins: {
      schema: 'vtr-reach-source-origin-manifest/v1',
      sourceSha: identity.sourceSha,
      runId: identity.runId,
      generationId: identity.generationId,
      worldKey: worldKeyString(identity.worldKey),
      launchConfig: actualServerArtifacts.artifacts?.launchConfig ?? null,
      entries: [...copiedSources.entries()]
        .filter(([archivePath, source]) => archivePath.startsWith('server/world/') && source.path !== null)
        .map(([archivePath, source]) => ({
          ...(source.readReceipt ?? {}),
          archivePath,
          sourcePath: source.path,
          bytes: source.bytes.length,
          sha256: sha256(source.bytes),
        }))
        .sort((left, right) => left.archivePath.localeCompare(right.archivePath)),
    },
    serverJarSource: actualServerArtifacts.artifacts?.serverJar ?? null,
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
