#!/usr/bin/env bun
// Read-only acceptance validator for a run-scoped VTR Reach capability archive.
// It never repairs, normalizes in place, or writes to the archive/repository.

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { gunzipSync, inflateSync } from 'node:zlib'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { parse as parseNbt } from 'prismarine-nbt'
import { classifyProviderActivity } from './capture-vtr-provider-activity.mjs'
import { eventMessage, persistentActionIdentity } from './vtr-reach-evidence-events.mjs'
import { inspectFreshWorldAttestation } from './vtr-fresh-world-attestation.mjs'
import { normalizeLegacyCollectMissionCommand, positionVector, relativeBlockOffset, samePosition } from './vtr-reach-legacy-baseline.mjs'

const EXIT = Object.freeze({ PASS: 0, FAIL: 1, INCOMPLETE: 2, USAGE: 64 })
const CHECK_STATUS = Object.freeze({ PASS: 'PASS', FAIL: 'FAIL', INCOMPLETE: 'INCOMPLETE' })
const SHA_RE = /^[0-9a-f]{40}$/i
const RUN_ID_RE = /^run-[a-z0-9]+-[a-z0-9]+$/i

class EvidenceAssessmentError extends Error {
  constructor(status, message) {
    super(message)
    this.name = 'EvidenceAssessmentError'
    this.status = status
  }
}

function incompleteEvidence(message, details = {}) {
  const error = new EvidenceAssessmentError(CHECK_STATUS.INCOMPLETE, message)
  error.details = details
  return error
}

function finiteCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

function explicitProviderAttempts(row) {
  for (const value of [row?.providerAttempts, row?.providerEvaluateAttempts, row?.detail?.providerAttempts, row?.detail?.providerEvaluateAttempts]) {
    if (value !== undefined) return finiteCount(value)
  }
  return null
}

function jevRowShowsProviderActivity(row) {
  const responseModel = row.response?.model
  return (row.error == null && row.response !== null && row.response !== undefined &&
      typeof responseModel === 'string' && responseModel.length > 0) ||
    (typeof row.error === 'string' &&
      /gateway|provider|rate.?limit|http\s*[45]\d\d|\b(?:429|500|502|503|504)\b/i.test(row.error))
}

function legacyJevProviderAttempts(rows) {
  const calls = new Map()
  const retries = new Map()
  const outcomes = new Map()
  for (const row of rows) {
    if (row.record === 'jev-call') {
      if (typeof row.callId !== 'string' || row.callId.length === 0) throw new Error('legacy Jev call record has no callId')
      if (!calls.has(row.callId)) calls.set(row.callId, [])
      calls.get(row.callId).push(row)
      continue
    }
    if (row.record === 'jev-retry') {
      if (typeof row.callId !== 'string' || row.callId.length === 0 || !Number.isSafeInteger(row.attempt) || row.attempt < 1) {
        throw new Error('legacy Jev retry record lacks a callId or positive attempt number')
      }
      if (!retries.has(row.callId)) retries.set(row.callId, [])
      retries.get(row.callId).push(row)
      continue
    }
    if (row.record === 'jev-outcome') {
      if (typeof row.callId !== 'string' || row.callId.length === 0) throw new Error('legacy Jev outcome record has no callId')
      outcomes.set(row.callId, (outcomes.get(row.callId) ?? 0) + 1)
      continue
    }
    throw new Error(`legacy Jev provider journal contains an unrecognized record: ${String(row.record ?? 'missing-record')}`)
  }

  let totalAttempts = 0
  const classifiedCalls = new Set()
  for (const [callId, callRows] of calls) {
    const retryRows = retries.get(callId) ?? []
    const row = callRows.at(-1)
    if (callRows.length !== 1) {
      // The pinned old-path logger writes one terminal call row per callId.
      // Newer multi-row schemas need an explicit cumulative provider counter.
      const explicit = callRows.map(explicitProviderAttempts)
      if (explicit.some((value) => value === null)) throw new Error(`legacy Jev call ${callId} has multiple rows without explicit provider-attempt counters`)
      for (let index = 1; index < explicit.length; index += 1) {
        if (explicit[index] < explicit[index - 1]) throw new Error(`legacy Jev call ${callId} provider-attempt counter regressed between journal rows`)
      }
      const attempts = explicit.at(-1)
      if (attempts === 0 && callRows.some(jevRowShowsProviderActivity)) {
        throw new Error(`legacy Jev call ${callId} reports zero provider attempts despite a raw provider response/error`)
      }
      totalAttempts += attempts
      classifiedCalls.add(callId)
      continue
    }

    const explicit = explicitProviderAttempts(row)
    if (explicit !== null) {
      if (explicit === 0 && (retryRows.length > 0 || jevRowShowsProviderActivity(row))) {
        throw new Error(`legacy Jev call ${callId} reports zero provider attempts despite raw provider activity`)
      }
      totalAttempts += explicit
      classifiedCalls.add(callId)
      continue
    }
    if ([row.providerAttempts, row.providerEvaluateAttempts, row.detail?.providerAttempts, row.detail?.providerEvaluateAttempts]
      .some((value) => value !== undefined)) {
      throw new Error(`legacy Jev call ${callId} has a malformed provider-attempt counter`)
    }

    const policy = String(row.policy ?? '').toLowerCase()
    const model = String(row.model ?? '')
    if (policy === 'fallback' || policy === 'reflex' || /^deterministic(?:-|$)/i.test(model)) {
      if (retryRows.length > 0) throw new Error(`deterministic Jev call ${callId} unexpectedly has provider retries`)
      if (finiteCount(row.response?.usage?.totalTokens) > 0) throw new Error(`deterministic Jev call ${callId} reports nonzero token usage`)
      classifiedCalls.add(callId)
      continue
    }

    const retryCount = retryRows.length
    for (const counterName of ['rateLimitRetries', 'transientRetries']) {
      if (row[counterName] !== undefined && finiteCount(row[counterName]) === null) {
        throw new Error(`legacy Jev call ${callId} has a malformed ${counterName} counter`)
      }
    }
    const usageAttempts = finiteCount(row.rateLimitRetries) ?? 0
    const transientAttempts = finiteCount(row.transientRetries) ?? 0
    const counterRetries = Math.max(usageAttempts + transientAttempts, retryCount)
    const responseModel = row.response?.model
    const successfulProviderResponse = row.error == null && row.response !== null && row.response !== undefined &&
      typeof responseModel === 'string' && responseModel.length > 0
    const providerFailure = typeof row.error === 'string' &&
      /gateway|provider|rate.?limit|http\s*[45]\d\d|\b(?:429|500|502|503|504)\b/i.test(row.error)
    const explicitAbortBeforeCall = typeof row.error === 'string' && /aborted before (?:model call|attempt)/i.test(row.error)

    if (successfulProviderResponse || providerFailure || retryCount > 0) {
      totalAttempts += counterRetries + 1
      classifiedCalls.add(callId)
      continue
    }
    if (explicitAbortBeforeCall && retryCount === 0) {
      classifiedCalls.add(callId)
      continue
    }
    throw new Error(`legacy Jev call ${callId} does not establish whether a provider request occurred`)
  }
  for (const callId of retries.keys()) {
    if (!calls.has(callId)) throw new Error(`legacy Jev retry ${callId} is not bound to a terminal Jev call row`)
  }
  for (const [callId, count] of outcomes) {
    if (!calls.has(callId) || count !== 1) throw new Error(`legacy Jev outcome ${callId} is duplicate or unbound to a call row`)
  }
  if (classifiedCalls.size !== calls.size) throw new Error('legacy Jev provider activity contains an unclassified call')
  return totalAttempts
}

function legacySystem2ModelCalls(files, summary, runRows) {
  const path = 'runner/runtime/logs/jev/system2.jsonl'
  const entry = files.get(path)
  const startup = runRows.filter((row) => row.source === 'agent' && row.message.startsWith('jev-agent started '))
  if (startup.length !== 1) throw new Error('legacy run journal does not uniquely bind effective System2 configuration at startup')
  const configuredProvider = startup[0].detail?.system2Provider
  const configuredModel = startup[0].detail?.system2Model
  if (!entry) {
    if (configuredProvider === 'deterministic' && configuredModel === 'unavailable' && summary.sliceMetrics?.system2LlmCalls === 0) return 0
    throw new Error('legacy System2 model activity is unknown: raw system2.jsonl is absent and startup does not prove an unavailable deterministic provider')
  }

  const rows = parsedJsonLines(entry.text, path)
  let modelCalls = 0
  for (const row of rows) {
    if (row.record !== 'system2-plan') throw new Error(`legacy System2 journal contains an unrecognized record: ${String(row.record ?? 'missing-record')}`)
    const provider = String(row.provider ?? '').toLowerCase()
    const model = String(row.model ?? '').toLowerCase()
    const deterministicProvider = ['stub', 'deterministic', 'local'].includes(provider)
    const providerNamedAsModel = /(?:gpt|claude|gemini|llama|jev|mercury)/i.test(model)
    const attempts = explicitProviderAttempts(row)
    if ([row.providerAttempts, row.providerEvaluateAttempts, row.detail?.providerAttempts, row.detail?.providerEvaluateAttempts]
      .some((value) => value !== undefined) && attempts === null) throw new Error('legacy System2 plan has a malformed provider-attempt counter')
    if (attempts !== null) {
      if (attempts === 0 && (providerNamedAsModel || (typeof row.provider === 'string' && row.provider && !deterministicProvider) ||
          (Array.isArray(row.returnedGoals) && Number.isFinite(Date.parse(row.ts ?? ''))))) {
        throw new Error('legacy System2 plan reports zero provider attempts despite raw provider/model response evidence')
      }
      if (attempts > 0 && (configuredProvider !== row.provider || configuredModel !== row.model)) {
        throw new Error('legacy System2 provider/model activity differs from its run-bound startup configuration')
      }
      modelCalls += attempts
      continue
    }
    if (row.stub === true || deterministicProvider) {
      if (providerNamedAsModel || (row.stub === true && provider && !deterministicProvider)) {
        throw new Error('legacy System2 plan is marked stub/deterministic but names a model provider response')
      }
      continue
    }
    if (typeof row.provider !== 'string' || !row.provider || typeof row.model !== 'string' || !row.model) {
      throw new Error('legacy System2 plan does not establish provider/model identity')
    }
    if (configuredProvider !== row.provider || configuredModel !== row.model) {
      throw new Error('legacy System2 provider/model activity differs from its run-bound startup configuration')
    }
    if (Array.isArray(row.returnedGoals) && Number.isFinite(Date.parse(row.ts ?? ''))) modelCalls += 1
    else throw new Error('legacy System2 non-stub plan lacks raw successful-provider evidence')
  }
  return modelCalls
}

function failEvidence(message, details = {}) {
  const error = new EvidenceAssessmentError(CHECK_STATUS.FAIL, message)
  error.details = details
  return error
}

const HELP = `Usage: bun tools/validate-vtr-reach-evidence.mjs --archive <directory> [--repo <exact-source-checkout>]

Read-only validation of a run-scoped VTR Reach live-probe archive.
Prints a JSON report and never changes the archive or repository.

Results:
  PASS        every Reach-probe evidence check is bound and complete
  INCOMPLETE  evidence is coherent but one or more required proofs/artifacts are absent
  FAIL        a present artifact contradicts the run or fails an integrity check

Exit codes: 0 PASS, 1 FAIL, 2 INCOMPLETE, 64 invalid arguments.

The Reach probe is distinct from the full P0 migration acceptance. The latter
also requires archived passing no-double-authority fixture results and a
run-scoped legacy-vs-VTR comparison. Expected supplemental paths:
  proofs/no-double-authority.json
  comparison/legacy-baseline.json

Raw no-LLM evidence must include a v2 continuous provider-activity capture
and all four source journals. Non-empty decision journals are permitted only
when their separately classified provider-attempt counters establish zero:
  runner/jev-calls.jsonl
  runner/jev-decisions.jsonl
  runner/system2.jsonl
  runner/mercury-calls.jsonl
  runner/provider-activity-capture.json
The v2 comparator output reports structured alignment only and remains
INCOMPLETE as migration evidence. The v3 comparator can qualify only when its
run-scoped raw files and identities validate independently. The archive must
also include runner/no-llm-egress-audit.json from the preload guard; it proves
USERSPACE_ONLY libc-interposition coverage and makes no kernel isolation claim.

The Reach slice additionally requires the exact-source legacy-claim refusal
fixture report at proofs/no-double-authority-fixture.json and the hashed test
source bytes at runner/fixtures/test-vtr-reach-executor-dispatch-authority.mts.
The fixture's conflict count is separate from the live run's zero-conflict
metric.

Fresh-world identity is established by server/fresh-world-attestation.json:
an exact-source/run/PID/port/level-bound spawn observation for the actual child
argv/CWD, with unique --universe/--level-name/--config/-jar args and hashes; a
pre-start absence observation for that world root (including absent level.dat
and level.dat_old); same-child stdout receipt rows with PID/UTC timestamps for
Preparing/Done; and per-file post-stop read receipts after process exit and
listener refusal. Receipts bind every world-file path, realPath and no-symlink
pathChain, with source origins preserved in packaging-report.json. A
freshWorld boolean or startup phrase is not evidence.
`

function parseArgs(argv) {
  const out = { archive: null, repo: null, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') out.help = true
    else if (arg === '--archive' || arg === '--repo') {
      const value = argv[i + 1]
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a path`)
      out[arg === '--archive' ? 'archive' : 'repo'] = value
      i += 1
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  return out
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function walkFiles(root) {
  const files = []
  const symlinks = []
  function visit(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name)
      const stat = lstatSync(full)
      if (stat.isSymbolicLink()) {
        symlinks.push(relative(root, full).split(sep).join('/'))
      } else if (stat.isDirectory()) visit(full)
      else if (stat.isFile()) files.push(relative(root, full).split(sep).join('/'))
    }
  }
  visit(root)
  return { files: files.sort(), symlinks: symlinks.sort() }
}

function readText(root, path) {
  return readFileSync(join(root, path), 'utf8')
}

function readJson(root, path) {
  return JSON.parse(readText(root, path))
}

function parseJsonl(root, path) {
  const rows = []
  const lines = readText(root, path).split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() === '') continue
    try {
      rows.push(JSON.parse(lines[index]))
    } catch (error) {
      throw new Error(`${path}:${index + 1}: invalid JSONL (${error.message})`)
    }
  }
  return rows
}

function dimCanonical(value) {
  if (typeof value !== 'string') return null
  return value.startsWith('minecraft:') ? value.slice('minecraft:'.length) : value
}

function parseWorldKey(value) {
  if (typeof value !== 'string') return null
  const parts = value.split('|')
  if (parts.length !== 3) return null
  const epoch = Number(parts[2])
  if (!parts[0] || !parts[1] || !Number.isInteger(epoch)) return null
  return { serverId: parts[0], rawDimension: parts[1], dimension: dimCanonical(parts[1]), worldEpoch: epoch }
}

function nbtValue(value) {
  if (value && typeof value === 'object' && Object.hasOwn(value, 'value')) return value.value
  return value
}

function nbtLongToBigInt(value) {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value)
  if (Array.isArray(value) && value.length === 2) {
    const hi = BigInt(value[0])
    const lo = BigInt(value[1]) & 0xffffffffn
    return (hi << 32n) | lo
  }
  return null
}

function nbtIntArrayToUuid(value) {
  if (!Array.isArray(value) || value.length !== 4) return null
  const hex = value.map((part) => (Number(part) >>> 0).toString(16).padStart(8, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function readProperties(text) {
  const props = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith('!')) continue
    const index = line.search(/[:=]/)
    if (index < 0) continue
    const key = line.slice(0, index).trim()
    const value = line.slice(index + 1).trim().replaceAll('\\:', ':')
    props[key] = value
  }
  return props
}

function eventTimestamp(row) {
  const value = Date.parse(row?.ts)
  return Number.isFinite(value) ? value : null
}

function canonicalMission(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      typeof value.kind !== 'string' || value.kind.trim() === '' ||
      typeof value.item !== 'string' || value.item.trim() === '' ||
      !Number.isSafeInteger(value.count) || value.count < 1) return null
  return { kind: value.kind, item: value.item, count: value.count }
}

function sameCanonicalMission(left, right) {
  const a = canonicalMission(left)
  const b = canonicalMission(right)
  return a !== null && b !== null && a.kind === b.kind && a.item === b.item && a.count === b.count
}

function parsedJsonLines(text, label) {
  const rows = []
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (line.trim() === '') continue
    try { rows.push(JSON.parse(line)) } catch (error) { throw new Error(`${label}:${index + 1}: invalid JSONL (${error.message})`) }
  }
  return rows
}

function fileText(files, path) {
  const entry = files.get(path)
  return entry === undefined ? null : entry.text
}

function rawFileMap(side, label) {
  if (!side || !Array.isArray(side.files)) throw new Error(`${label} raw file list is missing`)
  const files = new Map()
  for (const entry of side.files) {
    if (!entry || typeof entry.path !== 'string' || entry.path.length === 0 ||
        entry.path.startsWith('/') || entry.path.includes('\\') ||
        entry.path.split('/').some((part) => part === '' || part === '.' || part === '..')) {
      throw new Error(`${label} raw file path is unsafe or malformed`)
    }
    if (files.has(entry.path)) throw new Error(`${label} raw file path is duplicated: ${entry.path}`)
    if (!Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0 || entry.sizeBytes > 5 * 1024 * 1024 ||
        typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(entry.sha256) ||
        typeof entry.contentBase64 !== 'string') throw new Error(`${label} raw file integrity metadata is malformed: ${entry.path}`)
    const bytes = Buffer.from(entry.contentBase64, 'base64')
    if (bytes.toString('base64') !== entry.contentBase64 || bytes.length !== entry.sizeBytes || sha256(bytes) !== entry.sha256.toLowerCase()) {
      throw new Error(`${label} raw file bytes/hash do not match: ${entry.path}`)
    }
    files.set(entry.path, { ...entry, text: bytes.toString('utf8') })
  }
  return files
}

function exactRawFile(files, path, label) {
  const entry = files.get(path)
  if (!entry) throw new Error(`${label} raw archive is missing ${path}`)
  return entry
}

function oneRawJournal(files, candidates, label) {
  const matches = candidates.filter((path) => files.has(path))
  if (matches.length !== 1) throw new Error(`${label} must contain exactly one source event journal (${candidates.join(', ')})`)
  return matches[0]
}

function agentEvents(files, path, label) {
  return parsedJsonLines(exactRawFile(files, path, label).text, path)
    .filter((row) => row && typeof row === 'object' && !Array.isArray(row) && row.record === 'agent-event' && typeof row.message === 'string')
}

function eventNamed(rows, name, identity = null) {
  return rows.filter((row) => row.message.startsWith(`${name} `) && (identity === null || identity(row)))
}

function eventActionId(row) {
  return row?.detail?.actionId ?? null
}

export function inspectLifecycleCapture(files, capture, expectedIdentity, probe, events) {
  const lifecyclePath = 'runner/host-lifecycle.jsonl'
  const raw = files.get(lifecyclePath)
  if (!raw) throw incompleteEvidence('VTR HOST lifecycle transcript is missing', { path: lifecyclePath })
  const bytes = Buffer.from(raw.contentBase64, 'base64')
  let rows
  try { rows = parsedJsonLines(raw.text, lifecyclePath) }
  catch (error) { throw incompleteEvidence(`VTR HOST lifecycle transcript is malformed: ${error.message}`) }
  const observed = capture?.lifecycle
  if (!observed || !Number.isSafeInteger(observed.bytes) || typeof observed.sha256 !== 'string' ||
      !Number.isSafeInteger(observed.rows) || !Number.isSafeInteger(observed.malformedRows)) {
    throw incompleteEvidence('VTR capture omits the lifecycle transcript byte/hash snapshot')
  }
  if (observed.bytes !== bytes.length || observed.sha256.toLowerCase() !== sha256(bytes)) {
    throw failEvidence('VTR lifecycle transcript bytes/hash differ from the continuously captured snapshot')
  }
  if (observed.rows !== rows.length || observed.malformedRows !== 0 || observed.status !== 'OBSERVED' ||
      !Array.isArray(observed.problems) || observed.problems.length !== 0) {
    throw incompleteEvidence('VTR lifecycle transcript is malformed, unknown, or not classified as observed')
  }
  const byEvent = Object.fromEntries(['terminal-consumed', 'resident-stopped', 'server-stopped'].map((name) => [
    name, rows.filter((row) => row?.event === name),
  ]))
  if (Object.values(byEvent).some((entries) => entries.length !== 1) || rows.some((row) => row?.schema !== 'vtr-reach-probe-lifecycle/v1')) {
    throw incompleteEvidence('VTR lifecycle transcript lacks exactly one recognized row for each lifecycle boundary')
  }
  const terminalConsumed = byEvent['terminal-consumed'][0]
  const residentStopped = byEvent['resident-stopped'][0]
  const serverStopped = byEvent['server-stopped'][0]
  const worldKey = probe?.record === 'vtr-reach-live-probe' ? probe.transition?.commit?.identity?.worldKey : probe?.run?.worldKey
  const lifeRows = [terminalConsumed, residentStopped, serverStopped]
  for (const row of lifeRows) {
    if (row.actor !== 'probe-harness' || row.sourceSha?.toLowerCase?.() !== expectedIdentity.sourceSha ||
        row.runId !== expectedIdentity.runId || row.generationId !== expectedIdentity.generationId || row.worldKey !== worldKey) {
      throw failEvidence('VTR lifecycle transcript contradicts the exact source/run/generation/world identity')
    }
    if (!Number.isFinite(Date.parse(row.ts ?? ''))) throw incompleteEvidence('VTR lifecycle event timestamp is unavailable')
  }
  const transition = probe?.transition ?? {}
  const terminalOutcome = transition.terminalOutcome?.outcome ?? transition.terminal?.outcome ?? transition.terminalOutcome ?? transition.terminal ?? {}
  const transitionId = expectedIdentity.transitionId
  const contractHash = expectedIdentity.contractHash
  if (terminalConsumed.transitionId !== transitionId || terminalConsumed.contractHash !== contractHash ||
      terminalConsumed.outcomeKind !== 'SUCCESS' || !Array.isArray(terminalConsumed.evidenceIds) ||
      !isDeepStrictEqual(terminalConsumed.evidenceIds, terminalOutcome.evidenceIds)) {
    throw failEvidence('HOST terminal-consumed event does not bind the verified Reach SUCCESS and contract')
  }
  for (const row of [residentStopped, serverStopped]) {
    if (!Number.isSafeInteger(row.pid) || row.pid <= 0 || !['stopped', 'exited'].includes(row.status) || !Number.isSafeInteger(row.exitCode)) {
      throw incompleteEvidence(`HOST ${row.event} record lacks process stop evidence`)
    }
    if (Date.parse(row.stoppedAt ?? '') !== Date.parse(row.ts)) throw failEvidence(`HOST ${row.event} stoppedAt disagrees with its event timestamp`)
    const observation = row.processExitObservation
    const observedAt = Date.parse(observation?.observedAt ?? '')
    if (observation?.schema !== 'vtr-process-exit-observation/v1' || observation.source !== 'child-close-event' ||
        observation.state !== 'exited' || observation.pid !== row.pid || observation.exitCode !== row.exitCode ||
        !Number.isFinite(observedAt) || observedAt > Date.parse(row.stoppedAt)) {
      throw incompleteEvidence(`HOST ${row.event} lacks a matching observed child-close process-exit record`)
    }
  }
  const worldIdentity = parseWorldKey(worldKey)
  const expectedServerPort = /^127\.0\.0\.1:(\d{1,5})$/u.exec(worldIdentity?.serverId ?? '')
  const serverPort = expectedServerPort ? Number(expectedServerPort[1]) : null
  const serverExitAt = Date.parse(serverStopped.processExitObservation?.observedAt ?? '')
  const listener = serverStopped.listenerClosureObservation
  const listenerAt = Date.parse(listener?.observedAt ?? '')
  if (!Number.isInteger(serverPort) || serverPort < 1 || serverPort > 65535 ||
      listener?.schema !== 'vtr-listener-closure-observation/v1' || listener.source !== 'tcp-connect-probe' ||
      listener.state !== 'closed' || listener.host !== '127.0.0.1' || listener.port !== serverPort ||
      listener.result !== 'connection-refused' || !Number.isFinite(serverExitAt) ||
      !Number.isFinite(listenerAt) || listenerAt < serverExitAt || listenerAt !== Date.parse(serverStopped.stoppedAt)) {
    throw incompleteEvidence('HOST server stop lacks exact loopback TCP connection-refused listener-closure evidence after process exit')
  }
  const terminalRows = eventNamed(events, 'VTR_TRANSITION_OUTCOME', (row) => (row.detail?.transitionId ?? token(row.message, 'id')) === transitionId)
  if (terminalRows.length !== 1) throw incompleteEvidence('raw run journal does not uniquely bind the terminal before lifecycle consume')
  const terminalAt = Date.parse(terminalRows[0].ts ?? terminalRows[0].timestamp ?? '')
  const consumeAt = Date.parse(terminalConsumed.ts)
  const residentAt = Date.parse(residentStopped.stoppedAt)
  const serverAt = Date.parse(serverStopped.stoppedAt)
  const shutdownAt = Date.parse(capture?.window?.shutdownAt ?? '')
  const captureEnd = Date.parse(capture?.window?.endedAt ?? '')
  if (![terminalAt, consumeAt, residentAt, serverAt, shutdownAt, captureEnd].every(Number.isFinite)) {
    throw incompleteEvidence('VTR lifecycle capture lacks terminal, HOST shutdown, process stop, or capture-close time')
  }
  if (!(terminalAt <= consumeAt && consumeAt <= shutdownAt && shutdownAt <= residentAt && residentAt <= serverAt && serverAt <= captureEnd)) {
    throw failEvidence('VTR terminal consume, HOST shutdown, resident/server stop, and capture close are not causally ordered')
  }
  const hostLines = fileText(files, 'runner/buddy.log').split(/\r?\n/u)
  const shutdownLines = hostLines.filter((line) => hostEventToken(line) === 'SHUTDOWN')
  if (shutdownLines.length !== 1 || logTimestamp(shutdownLines[0]) !== shutdownAt) {
    throw incompleteEvidence('HOST lifecycle transcript is not corroborated by exactly one raw resident SHUTDOWN line')
  }
  if (capture?.window?.lifecycleComplete !== true || capture?.window?.serverStoppedAt !== serverStopped.stoppedAt || captureEnd < serverAt) {
    throw incompleteEvidence('provider capture did not remain open through HOST terminal consume and server stop')
  }
  const observedEvents = observed.events
  if (!observedEvents || !isDeepStrictEqual(observedEvents.terminalConsumed, terminalConsumed) ||
      !isDeepStrictEqual(observedEvents.residentStopped, residentStopped) ||
      !isDeepStrictEqual(observedEvents.serverStopped, serverStopped)) {
    throw failEvidence('provider capture lifecycle projection disagrees with the preserved lifecycle transcript')
  }
  const startAt = Date.parse(capture?.window?.startedAt ?? '')
  const readyAt = Date.parse(capture?.window?.generationReadyAt ?? '')
  const firstObservedAt = Date.parse(observed.firstObservedAt ?? '')
  const closedAt = Date.parse(observed.closedAt ?? '')
  if (![startAt, readyAt, firstObservedAt, closedAt].every(Number.isFinite) ||
      firstObservedAt > Date.parse(capture?.window?.bootAt ?? '') || closedAt < serverAt || closedAt > captureEnd) {
    throw incompleteEvidence('HOST lifecycle transcript was not continuously captured before BOOT through server stop')
  }
}

function inspectNoLlmEgressAudit(files, capture, expectedIdentity, probe) {
  const raw = files.get('runner/no-llm-egress-audit.json')
  if (!raw) throw incompleteEvidence('LD_PRELOAD no-LLM egress audit is missing')
  const binding = probe?.egressAudit
  if (!binding || binding.schema !== 'vtr-no-llm-egress-binding/v1') {
    throw incompleteEvidence('VTR probe omits the source/run/window binding for the LD_PRELOAD audit')
  }
  let rows
  try { rows = parsedJsonLines(raw.text, 'runner/no-llm-egress-audit.json') }
  catch (error) { throw incompleteEvidence(`LD_PRELOAD egress audit is malformed JSONL: ${error.message}`) }
  const bytes = Buffer.from(raw.contentBase64, 'base64')
  const rawHash = sha256(bytes)
  const worldKey = probe?.record === 'vtr-reach-live-probe'
    ? probe.transition?.commit?.identity?.worldKey
    : probe?.run?.worldKey
  if (binding.status !== 'OBSERVED_ZERO' || binding.sourceSha !== expectedIdentity.sourceSha ||
      binding.runId !== expectedIdentity.runId || binding.generationId !== expectedIdentity.generationId ||
      binding.worldKey !== worldKey || binding.rawArtifact?.path !== 'runner/no-llm-egress-audit.json' ||
      binding.rawArtifact?.bytes !== bytes.length || binding.rawArtifact?.sha256?.toLowerCase?.() !== rawHash) {
    throw failEvidence('LD_PRELOAD egress binding contradicts the exact raw audit/source/run identity')
  }
  if (binding.coverageClass !== 'user-space-libc-interposition' || binding.coverageStatus !== 'USERSPACE_ONLY_CLOSED' ||
      !Array.isArray(binding.limitations) || !binding.limitations.some((value) => String(value).includes('USERSPACE_ONLY')) ||
      !binding.limitations.some((value) => String(value).includes('no kernel isolation claim'))) {
    throw incompleteEvidence('LD_PRELOAD audit does not preserve the USERSPACE_ONLY coverage limitation')
  }
  if (rows.length === 0 || rows.some((row) => row?.schema !== 'vtr-no-llm-egress-audit/v1' ||
      !['guard_loaded', 'blocked_egress', 'guard_wrapper_closed'].includes(row.event))) {
    throw incompleteEvidence('LD_PRELOAD egress audit has no records or contains unknown schema/events')
  }
  const loaded = rows.filter((row) => row.event === 'guard_loaded')
  const blocked = rows.filter((row) => row.event === 'blocked_egress')
  const closed = rows.filter((row) => row.event === 'guard_wrapper_closed')
  if (closed.length !== 1 || loaded.length === 0) throw incompleteEvidence('LD_PRELOAD audit requires guard_loaded and exactly one guard_wrapper_closed row')
  const close = closed[0]
  const lifecycleBytes = exactRawFile(files, 'runner/host-lifecycle.jsonl', 'VTR lifecycle').text
  const lifecycleRows = parsedJsonLines(lifecycleBytes, 'runner/host-lifecycle.jsonl')
  const residentRows = lifecycleRows.filter((row) => row.event === 'resident-stopped')
  if (residentRows.length !== 1) throw incompleteEvidence('LD_PRELOAD audit cannot bind to exactly one HOST resident-stopped row')
  const resident = residentRows[0]
  const hashes = ['toolSha256', 'sourceSha256', 'librarySha256', 'policySha256']
  const rootLoaded = loaded.filter((row) => row.pid === close.childPid)
  if (hashes.some((key) => typeof close[key] !== 'string' || !/^[0-9a-f]{64}$/i.test(close[key])) ||
      rootLoaded.length !== 1 || new Set(loaded.map((row) => `${row.pid}:${row.processStartTicks}`)).size !== loaded.length ||
      loaded.some((row) => !Number.isSafeInteger(row.pid) || row.pid < 1 ||
        !Number.isSafeInteger(row.processStartTicks) || row.processStartTicks < 1 ||
        !Number.isSafeInteger(row.processGroupId) || row.processGroupId !== close.childPid ||
        row.reason !== 'preload-active' || hashes.some((key) => row[key] !== close[key])) ||
      blocked.some((row) => !Number.isSafeInteger(row.processStartTicks) ||
        !Number.isSafeInteger(row.processGroupId) || row.processGroupId !== close.childPid ||
        loaded.filter((entry) => entry.pid === row.pid && entry.processStartTicks === row.processStartTicks).length !== 1 ||
        hashes.some((key) => row[key] !== close[key]))) {
    throw failEvidence('LD_PRELOAD audit does not prove root and descendant guard activation with consistent artifact hashes')
  }
  if (close.childPid !== resident.pid || close.childExitCode !== resident.exitCode ||
      close.preloadVerified !== true || close.processGroupGone !== true ||
      close.coverageClass !== 'user-space-libc-interposition' || close.coverageStatus !== 'USERSPACE_ONLY_CLOSED' ||
      close.externalDeniedAttempts !== blocked.length || close.guardLoadedRows !== loaded.length ||
      close.auditPathIdentityVerified !== true || !/^\d+$/u.test(String(close.auditDevice ?? '')) || !/^\d+$/u.test(String(close.auditInode ?? '')) ||
      !String(close.coverage ?? '').includes('syscall-bypass-not-covered')) {
    throw incompleteEvidence('LD_PRELOAD wrapper did not close the resident process group with USERSPACE_ONLY_CLOSED evidence')
  }
  const startAt = Date.parse(capture?.window?.startedAt ?? '')
  const readyAt = Date.parse(capture?.window?.generationReadyAt ?? '')
  const shutdownAt = Date.parse(capture?.window?.shutdownAt ?? '')
  const residentStoppedAt = Date.parse(capture?.window?.residentStoppedAt ?? '')
  const serverStoppedAt = Date.parse(capture?.window?.serverStoppedAt ?? '')
  const endAt = Date.parse(capture?.window?.endedAt ?? '')
  const eventTimes = rows.map((row) => Date.parse(row.utc ?? ''))
  const cRows = rows.filter((row) => row.event !== 'guard_wrapper_closed')
  const monotonicValues = cRows.map((row) => /^\d+$/u.test(String(row.monotonicNs ?? '')) ? BigInt(row.monotonicNs) : null)
  const closedAt = Date.parse(close.utc ?? '')
  if (rows.at(-1) !== close || cRows.some((row) => row.monotonicClock !== 'CLOCK_MONOTONIC') || close.monotonicClock !== 'process.hrtime.relative' ||
      monotonicValues.some((value, index) => value === null || index > 0 && value < monotonicValues[index - 1]) ||
      ![startAt, readyAt, shutdownAt, residentStoppedAt, serverStoppedAt, endAt, closedAt, ...eventTimes].every(Number.isFinite) ||
      eventTimes.some((at) => at < startAt || at > closedAt) || shutdownAt > closedAt ||
      closedAt < Date.parse(resident.processExitObservation?.observedAt ?? '') ||
      closedAt > Date.parse(lifecycleRows.find((row) => row.event === 'server-stopped')?.listenerClosureObservation?.observedAt ?? '') ||
      closedAt > serverStoppedAt || serverStoppedAt > endAt || closedAt > endAt ||
      Date.parse(binding.window?.startedAt ?? '') !== startAt ||
      Date.parse(binding.window?.generationReadyAt ?? '') !== readyAt ||
      Date.parse(binding.window?.shutdownAt ?? '') !== shutdownAt ||
      Date.parse(binding.window?.residentStoppedAt ?? '') !== residentStoppedAt ||
      Date.parse(binding.window?.serverStoppedAt ?? '') !== serverStoppedAt ||
      Date.parse(binding.window?.endedAt ?? '') !== endAt) {
    throw incompleteEvidence('LD_PRELOAD audit timestamps are not bound to the continuous provider capture window')
  }
  if (blocked.length > 0) throw failEvidence('LD_PRELOAD audit recorded a denied external network attempt during the no-LLM probe', { blockedAttempts: blocked.length })
  if (binding.externalDeniedAttempts !== 0 || binding.guardLoadedRows !== loaded.length) {
    throw failEvidence('LD_PRELOAD egress binding counters disagree with the raw audit rows')
  }
  return {
    status: 'PASS',
    coverageStatus: close.coverageStatus,
    externalDeniedAttempts: blocked.length,
    rawArtifact: { path: 'runner/no-llm-egress-audit.json', bytes: bytes.length, sha256: rawHash },
    limitations: binding.limitations,
  }
}

function providerCapture(files, expectedIdentity, probe, events = []) {
  const journalPaths = {
    'jev-calls': 'runner/jev-calls.jsonl',
    'jev-decisions': 'runner/jev-decisions.jsonl',
    'system2-journal': 'runner/system2.jsonl',
    'mercury-calls': 'runner/mercury-calls.jsonl',
  }
  const recordsByJournal = {}
  const rawByName = {}
  for (const [name, path] of Object.entries(journalPaths)) {
    const raw = files.get(path)
    rawByName[name] = raw ?? null
    if (!raw) {
      recordsByJournal[name] = null
      continue
    }
    try { recordsByJournal[name] = parsedJsonLines(raw.text, path) }
    catch { recordsByJournal[name] = null }
  }
  const classified = classifyProviderActivity(recordsByJournal)
  if (classified.positiveProviderActivityObserved === true ||
      classified.providers.jevEvaluateAttempts > 0 || classified.providers.system2EvaluateAttempts > 0 ||
      classified.providers.networkModelCalls > 0) {
    throw failEvidence('preserved Jev/Mercury provider journals show one or more provider evaluation attempts')
  }
  const captureFile = files.get('runner/provider-activity-capture.json')
  if (!captureFile) throw incompleteEvidence('VTR provider activity capture is missing')
  let capture
  try { capture = JSON.parse(captureFile.text) } catch (error) {
    throw incompleteEvidence(`VTR provider activity capture is malformed JSON: ${error.message}`)
  }
  if (capture.schema !== 'vtr-provider-activity-capture/v2') {
    throw incompleteEvidence(`VTR provider activity capture schema is unsupported: ${String(capture.schema ?? 'missing')}`)
  }
  if (!Array.isArray(capture.capture?.problems)) throw incompleteEvidence('VTR provider activity capture does not report its coverage problems')
  if (capture.status === 'FAIL') throw failEvidence('VTR provider activity capture reports a failed observation')
  const worldKey = probe?.record === 'vtr-reach-live-probe'
    ? probe.transition?.commit?.identity?.worldKey
    : probe?.run?.worldKey
  for (const [key, expected] of Object.entries({
    sourceSha: expectedIdentity.sourceSha,
    runId: expectedIdentity.runId,
    generationId: expectedIdentity.generationId,
    worldKey,
  })) {
    if (typeof expected !== 'string' || capture.identity?.[key] !== expected) throw failEvidence(`VTR provider capture ${key} does not match the raw run`)
  }
  inspectLifecycleCapture(files, capture, expectedIdentity, probe, events)
  const egressAudit = inspectNoLlmEgressAudit(files, capture, expectedIdentity, probe)
  const readyAt = Date.parse(capture.window?.generationReadyAt ?? '')
  const terminalAt = Date.parse(capture.window?.terminalAt ?? '')
  const serverStoppedAt = Date.parse(capture.window?.serverStoppedAt ?? '')
  const startAt = Date.parse(capture.window?.startedAt ?? '')
  const endAt = Date.parse(capture.window?.endedAt ?? '')
  if (![startAt, readyAt, terminalAt, serverStoppedAt, endAt].every(Number.isFinite)) {
    throw incompleteEvidence('VTR provider capture is missing one or more run/server-stop coverage boundaries')
  }
  if (!(startAt <= readyAt && readyAt <= terminalAt && terminalAt <= endAt)) {
    throw failEvidence('VTR provider capture has contradictory boot/readiness/terminal boundary ordering')
  }
  if (!Number.isFinite(capture.window?.maxPollGapMs) || !Number.isFinite(capture.window?.maxObservedPollGapMs)) {
    throw incompleteEvidence('VTR provider capture is missing polling-gap evidence')
  }
  if (capture.window.maxObservedPollGapMs > capture.window.maxPollGapMs) {
    throw incompleteEvidence('VTR provider capture polling coverage exceeds its declared bound')
  }
  for (const [name, path] of Object.entries(journalPaths)) {
    const raw = rawByName[name]
    if (!raw) continue
    const bytes = Buffer.from(raw.contentBase64, 'base64')
    const snapshot = capture.journals?.[name]
    if (!snapshot || !Number.isSafeInteger(snapshot.bytes) || typeof snapshot.sha256 !== 'string' ||
        !/^[0-9a-f]{64}$/i.test(snapshot.sha256)) {
      throw incompleteEvidence(`VTR provider journal ${name} has no complete capture snapshot`)
    }
    if (snapshot.bytes !== bytes.length || snapshot.sha256.toLowerCase() !== sha256(bytes)) {
      throw failEvidence(`VTR provider journal ${name} bytes/hash differ from the continuously captured snapshot`)
    }
    const firstObservedAt = Date.parse(snapshot.firstObservedAt ?? snapshot.initializedAt ?? '')
    const closedAt = Date.parse(snapshot.closedAt ?? '')
    if (!Number.isFinite(firstObservedAt) || !Number.isFinite(closedAt) ||
        !Number.isSafeInteger(snapshot.rows) || !Number.isSafeInteger(snapshot.malformedRows)) {
      throw incompleteEvidence(`VTR provider journal ${name} is missing row-count or observation-window evidence`)
    }
    if (firstObservedAt > readyAt || closedAt < terminalAt || closedAt < serverStoppedAt || closedAt > endAt) {
      throw incompleteEvidence(`VTR provider journal ${name} was not continuously observed from before GENERATION_READY through HOST server stop`)
    }
    const rows = recordsByJournal[name]
    if (rows === null) throw incompleteEvidence(`VTR provider journal ${name} is malformed: ${path}`)
    if (rows.length !== snapshot.rows || snapshot.malformedRows !== 0) {
      throw incompleteEvidence(`VTR provider journal ${name} has malformed or unaccounted rows`)
    }
  }
  if (capture.status !== 'OBSERVED' || capture.window?.coverageComplete !== true || capture.capture.problems.length !== 0) {
    throw incompleteEvidence('VTR provider activity capture does not establish continuous boot-to-terminal coverage')
  }
  if (classified.providers.jevEvaluateAttempts > 0 || classified.providers.system2EvaluateAttempts > 0 ||
      classified.providers.networkModelCalls > 0 || capture.activityClassification?.providers?.jevEvaluateAttempts > 0 ||
      capture.activityClassification?.providers?.system2EvaluateAttempts > 0 || capture.activity?.jevEvaluateAttempts > 0 ||
      capture.activity?.system2EvaluateAttempts > 0 || capture.activity?.networkModelCalls > 0) {
    throw failEvidence('VTR provider journals or counters show one or more provider evaluation attempts')
  }
  if (classified.unknown.length > 0) {
    throw incompleteEvidence('VTR provider activity is unclassified', { unknown: classified.unknown })
  }
  const flattened = { ...classified.decisions, ...classified.providers }
  if (!capture.activity || !capture.activityClassification ||
      Object.values(flattened).some((value) => !Number.isSafeInteger(value))) {
    throw incompleteEvidence('VTR provider capture omits one or more independently countable activity fields')
  }
  if (!isDeepStrictEqual(capture.activityClassification, classified) || !isDeepStrictEqual(capture.activity, flattened)) {
    throw failEvidence('VTR provider activity counters/classification disagree with the preserved raw journals')
  }
  const acceptance = JSON.parse(exactRawFile(files, 'runner/acceptance.json', 'VTR').text)
  if (acceptance.record !== 'acceptance' || acceptance.runId !== expectedIdentity.runId ||
      acceptance.gitCommit !== expectedIdentity.sourceSha || acceptance.checkoutHead !== expectedIdentity.sourceSha ||
      acceptance.generationHash !== expectedIdentity.buildHash) {
    throw failEvidence('VTR acceptance record does not bind the raw source/run/build identity')
  }
  const [serverId, dimension, epoch] = worldKey.split('|')
  if (acceptance.serverId !== serverId || acceptance.worldEpoch !== Number(epoch) ||
      String(acceptance.dimension).replace(/^minecraft:/, '') !== String(dimension).replace(/^minecraft:/, '')) {
    throw failEvidence('VTR acceptance record does not bind the committed world/dimension/epoch')
  }
  const reportedNetworkCalls = probe?.configuredNoLlmProbe?.networkModelCalls ?? probe?.configuration?.networkModelCalls
  if (reportedNetworkCalls !== flattened.networkModelCalls) {
    throw failEvidence('VTR probe networkModelCalls does not match captured Jev/System2 provider attempts')
  }
  const policy = probe?.configuredNoLlmProbe
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    throw incompleteEvidence('VTR probe does not project captured decision and provider counters separately')
  }
  const projected = {
    jevDecisionCalls: policy.effectiveJev?.decisionCalls,
    system2DecisionCalls: policy.effectiveSystem2?.decisionCalls,
    jevProviderEvaluateAttempts: policy.effectiveJev?.providerEvaluateAttempts,
    system2ProviderEvaluateAttempts: policy.effectiveSystem2?.providerEvaluateAttempts,
  }
  if (Object.values(projected).some((value) => !Number.isSafeInteger(value))) {
    throw incompleteEvidence('VTR probe omits projected Jev/System2 decision or provider-attempt counts')
  }
  if (projected.jevDecisionCalls !== flattened.jevDecisionFrames ||
      projected.system2DecisionCalls !== flattened.system2DecisionInvocations ||
      projected.jevProviderEvaluateAttempts !== flattened.jevEvaluateAttempts ||
      projected.system2ProviderEvaluateAttempts !== flattened.system2EvaluateAttempts) {
    throw failEvidence('VTR probe decision/provider projections disagree with the preserved raw journals')
  }
  const mechanicalSteps = Number(probe.transition?.metrics?.mechanicalStepsPerTransition)
  const expectedAttemptsPerStep = Number.isSafeInteger(mechanicalSteps) && mechanicalSteps > 0
    ? flattened.networkModelCalls / mechanicalSteps : null
  if (policy.providerEvaluateAttemptsPerMechanicalStep !== expectedAttemptsPerStep) {
    throw failEvidence('VTR probe provider-attempts-per-mechanical-step metric disagrees with the captured provider journals')
  }
  return { capture, acceptance, activity: flattened, egressAudit }
}

function providerCaptureFromArchive(archive, expectedIdentity, probe) {
  const paths = [
    'runner/provider-activity-capture.json',
    'runner/jev-calls.jsonl',
    'runner/jev-decisions.jsonl',
    'runner/system2.jsonl',
    'runner/mercury-calls.jsonl',
    'runner/provider-activity-capture.json',
    'runner/host-lifecycle.jsonl',
    'runner/no-llm-egress-audit.json',
    'runner/mercury-calls.jsonl',
    'runner/host-lifecycle.jsonl',
    'runner/no-llm-egress-audit.json',
    'runner/jev-run.jsonl',
    'runner/run.jsonl',
    'runner/buddy.log',
    'runner/acceptance.json',
  ]
  const files = new Map()
  for (const path of paths) {
    const absolute = join(archive, path)
    if (!existsSync(absolute)) continue
    const stat = lstatSync(absolute)
    if (stat.isSymbolicLink() || !stat.isFile()) throw failEvidence(`provider archive entry is not a regular file: ${path}`)
    const bytes = readFileSync(absolute)
    files.set(path, { contentBase64: bytes.toString('base64'), text: bytes.toString('utf8') })
  }
  const runPath = ['runner/jev-run.jsonl', 'runner/run.jsonl'].find((path) => files.has(path))
  const events = runPath ? parsedJsonLines(files.get(runPath).text, runPath)
    .filter((row) => row && typeof row === 'object' && row.record === 'agent-event' && typeof row.message === 'string') : []
  return providerCapture(files, expectedIdentity, probe, events)
}

function inspectRawLegacySide(side, expectedIdentity) {
  const files = rawFileMap(side, 'legacy')
  exactRawFile(files, 'runner/runtime/buddy.log', 'legacy')
  const runPath = 'runner/runtime/logs/jev/run.jsonl'
  const runRows = agentEvents(files, runPath, 'legacy')
  const summary = JSON.parse(exactRawFile(files, 'runner/reach-slice-evidence.json', 'legacy').text)
  for (const [key, value] of Object.entries(expectedIdentity)) {
    if (summary[key] !== value) throw new Error(`legacy raw summary ${key} does not match comparison lineage`)
  }
  const reportedMission = canonicalMission(summary.missionInput)
  if (!reportedMission) throw new Error('legacy raw summary does not serialize its original task intent')
  const actualMissionInput = exactRawFile(files, 'runner/human-task-input.jsonl', 'legacy').text
  const missionRows = parsedJsonLines(actualMissionInput, 'runner/human-task-input.jsonl')
  const missionEvents = missionRows.filter((row) => row.event === 'chat_sent_after_intent_listener_ready' && typeof row.command === 'string')
  if (missionEvents.length !== 1) throw new Error('legacy raw human-task journal must contain exactly one submitted Mission command')
  const command = missionEvents[0].command.trim()
  const commandMatch = /^agent\s+\S+\s+collect\s+(.+?)\s+(\d+)$/i.exec(command)
  if (!commandMatch || Number(commandMatch[2]) !== reportedMission.count) throw new Error('legacy raw Mission command does not agree with its reported task count')
  const decisionsPath = 'runner/runtime/logs/jev/decisions.jsonl'
  const decisions = parsedJsonLines(exactRawFile(files, decisionsPath, 'legacy').text, decisionsPath)
  const first = summary.events?.firstDecision
  const next = summary.events?.nextDecisionInRange
  const moveEnd = summary.events?.moveActionEnd
  if (!first?.decisionId || !next?.decisionId || !moveEnd?.actionId) throw new Error('legacy raw summary lacks the MOVE-to-inReach decision chain')
  const firstRows = decisions.filter((row) => row.decisionId === first.decisionId)
  const nextRows = decisions.filter((row) => row.decisionId === next.decisionId)
  if (firstRows.length !== 1 || nextRows.length !== 1) throw new Error('legacy decision journal does not uniquely bind first and next decisions')
  for (const row of [firstRows[0], nextRows[0]]) {
    if (row.runId !== expectedIdentity.runId || row.generationId !== expectedIdentity.generationId || row.sourceSha !== expectedIdentity.sourceSha) {
      throw new Error('legacy raw decision event has a different run/source/generation identity')
    }
  }
  const firstSelected = firstRows[0].chosenAction ?? firstRows[0].jev?.answers?.action?.value ?? null
  if (firstSelected !== moveEnd.actionId || !String(firstSelected).startsWith('MOVE:')) throw new Error('legacy first decision did not choose its recorded MOVE action')
  const target = summary.fixture?.position
  const targetBlock = summary.fixture?.block
  if (!target || !['x', 'y', 'z'].every((key) => Number.isSafeInteger(target[key])) || typeof targetBlock !== 'string') {
    throw new Error('legacy summary does not bind an integer resource witness')
  }
  const normalizedTask = normalizeLegacyCollectMissionCommand(command, targetBlock)
  if (!normalizedTask) throw new Error('legacy Mission command does not name the exact raw resource witness; species/generic aliases are not normalized')
  const mission = normalizedTask.mission
  if (reportedMission.kind === 'inventory_at_least') {
    if (reportedMission.item.toLowerCase().replace(/^minecraft:/, '') !== mission.item || reportedMission.count !== mission.count) {
      throw new Error('legacy canonical Mission summary differs from the raw command-derived Mission')
    }
  } else if (reportedMission.kind === 'human_intent_collect') {
    const summaryItem = reportedMission.item.toLowerCase().replace(/^minecraft:/, '')
    const genericLogAlias = summaryItem === 'log' && targetBlock.toLowerCase().replace(/^minecraft:/, '').endsWith('_log')
    if ((!genericLogAlias && summaryItem !== mission.item) || reportedMission.count !== mission.count) {
      throw new Error('legacy compatibility intent cannot be reconciled with the raw command-derived Mission')
    }
  } else {
    throw new Error(`unsupported legacy mission summary kind for raw normalization: ${reportedMission.kind}`)
  }
  const blockSuffix = `b${target.x}_${target.y}_${target.z}`
  const firstCandidate = firstRows[0].candidates?.find((candidate) => candidate.id === firstSelected)
  if (!firstCandidate || firstCandidate.kind !== 'MOVE' || firstCandidate.targetName !== targetBlock || firstSelected !== `MOVE:${blockSuffix}`) {
    throw new Error('legacy MOVE candidate is not bound to the run-scoped resource witness')
  }
  const nextSelected = nextRows[0].chosenAction ?? nextRows[0].jev?.answers?.action?.value ?? null
  const nextCandidate = nextRows[0].candidates?.find((candidate) => candidate.id === nextSelected)
  if (!nextCandidate || nextCandidate.inReach !== true || nextCandidate.id !== next.selected || nextCandidate.kind !== 'MINE' ||
      nextCandidate.targetName !== targetBlock || nextSelected !== `MINE:${blockSuffix}`) {
    throw new Error('legacy next decision does not establish inReach for the same run-scoped resource witness')
  }
  const callPath = 'runner/runtime/logs/jev/jev-calls.jsonl'
  const calls = parsedJsonLines(exactRawFile(files, callPath, 'legacy').text, callPath)
  const callIds = [firstRows[0].jev?.callId, nextRows[0].jev?.callId]
  if (callIds.some((callId) => typeof callId !== 'string' || !callId)) throw new Error('legacy raw decisions do not bind Jev call ids')
  const boundCalls = callIds.map((callId) => calls.filter((row) => row.record === 'jev-call' && row.callId === callId))
  if (boundCalls.some((rows) => rows.length !== 1)) throw new Error('legacy raw provider journal does not uniquely bind both decision frames')
  const callRows = boundCalls.map((rows) => rows[0])
  if (callRows.some((row) => !Number.isFinite(row.latencyMs) || row.latencyMs < 0)) {
    throw new Error('legacy first/next Jev call rows have invalid latency measurements')
  }
  const jevProviderAttempts = legacyJevProviderAttempts(calls)
  const startEvents = runRows.filter((row) => row.source === 'agent' && row.message.startsWith('jev-agent started '))
  if (startEvents.length !== 1 || typeof startEvents[0].detail?.policy !== 'string') {
    throw new Error('legacy raw run journal does not bind effective Jev policy at startup')
  }
  const system2Events = runRows.filter((row) => row.source === 'system2')
  const system2ModelCalls = legacySystem2ModelCalls(files, summary, runRows)
  if (system2Events.some((row) => {
    const provider = row.detail?.provider ?? row.detail?.system2Provider
    const model = row.detail?.model ?? row.detail?.system2Model
    return (provider !== undefined && !['stub', 'deterministic', 'local'].includes(String(provider).toLowerCase())) ||
      (model !== undefined && model !== 'unavailable' && /(?:gpt|claude|gemini|llama|jev|mercury)/i.test(String(model)))
  })) {
    throw new Error('legacy run journal has System2 provider/model activity inconsistent with its archived model-call records')
  }
  const questionCalls = [firstRows[0], nextRows[0]].reduce((sum, row) => sum + Object.keys(row.jev?.answers ?? {}).length, 0)
  const moveStartRows = eventNamed(runRows, 'SKILL_START', (row) => eventActionId(row) === moveEnd.actionId)
  const moveStepStartRows = runRows.filter((row) => row.source === 'executor' && eventActionId(row) === moveEnd.actionId &&
    /\bSKILL_STEP\b/.test(row.message) && /\bstep=move\b/.test(row.message) && /\bworldDelta=pos=/.test(row.message))
  const moveArrivalRows = runRows.filter((row) => row.source === 'executor' && eventActionId(row) === moveEnd.actionId &&
    row.message.startsWith(`MOVE ${moveEnd.actionId} arrival `))
  const moveStepRows = eventNamed(runRows, 'SKILL_STEP', (row) => eventActionId(row) === moveEnd.actionId && Number.isSafeInteger(row.detail?.leg))
  const moveEndRows = eventNamed(runRows, 'SKILL_END', (row) => eventActionId(row) === moveEnd.actionId)
  if (moveStartRows.length !== 1 || moveEndRows.length !== 1) throw new Error('legacy run journal must contain exactly one matching MOVE start/end')
  if (moveStepStartRows.length === 0 || moveArrivalRows.length !== 1) throw new Error('legacy run journal lacks raw MOVE start-position evidence')
  const firstMoveStep = [...moveStepStartRows].sort((left, right) => Date.parse(left.ts ?? '') - Date.parse(right.ts ?? ''))[0]
  const stepStartMatch = /\bworldDelta=pos=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(firstMoveStep.message)
  const rawStart = positionVector(moveArrivalRows[0].detail?.start)
  const arrivalEnd = positionVector(moveArrivalRows[0].detail?.end)
  const stepStart = stepStartMatch === null ? null : { x: Number(stepStartMatch[1]), y: Number(stepStartMatch[2]), z: Number(stepStartMatch[3]) }
  if (!rawStart || !arrivalEnd || !samePosition(rawStart, stepStart)) {
    throw new Error('legacy MOVE start position is not corroborated by the raw first movement-step observation')
  }
  if (!samePosition(summary.fixture?.initialPlayerPosition, rawStart)) {
    throw new Error('legacy summary fixture start differs from the raw MOVE start position')
  }
  const derivedOffset = relativeBlockOffset(target, rawStart)
  if (!derivedOffset || !isDeepStrictEqual(summary.fixture?.sourceOffsetFromInitialPlayer, derivedOffset)) {
    throw new Error('legacy summary relative fixture offset differs from the raw target and MOVE start position')
  }
  if (!/\bexecution=success\b/.test(moveEndRows[0].message) || !/\bverification=verified\b/.test(moveEndRows[0].message) ||
      !/\boutcome=SUCCESS\b/.test(moveEndRows[0].message) || !/\bfailureCode=none\b/.test(moveEndRows[0].message)) {
    throw new Error('legacy MOVE SKILL_END is not a verified SUCCESS')
  }
  if (!Number.isSafeInteger(moveEnd.movementStepCount) || moveEnd.movementStepCount < 1 ||
      !Number.isSafeInteger(moveEnd.pathLegs) || moveEnd.pathLegs < 1 || moveStepRows.length !== moveEnd.pathLegs ||
      moveEnd.movementStepCount !== moveEnd.pathLegs) {
    throw new Error('legacy raw movement legs do not match the summarized movement-step counts')
  }
  const witnessRows = parsedJsonLines(exactRawFile(files, 'runner/block-read-run2.jsonl', 'legacy').text, 'runner/block-read-run2.jsonl')
  const witness = witnessRows.filter((row) => row.tag === 'target' && row.name === summary.fixture?.block &&
    ['x', 'y', 'z'].every((key) => row.position?.[key] === summary.fixture?.position?.[key]))
  if (witness.length === 0) throw new Error('legacy raw witness journal lacks the summarized target observation')
  const networkModelCalls = jevProviderAttempts + system2ModelCalls
  const reportedMetrics = summary.sliceMetrics ?? {}
  for (const [key, observed] of [
    ['jevProviderModelCalls', jevProviderAttempts],
    ['system2LlmCalls', system2ModelCalls],
    ['networkModelCalls', networkModelCalls],
  ]) {
    if (reportedMetrics[key] !== undefined && reportedMetrics[key] !== observed) {
      throw new Error(`legacy raw provider journals derive ${key}=${observed}, contradicting the run summary ${reportedMetrics[key]}`)
    }
  }
  const modelCallsPerMechanicalStep = moveStepRows.length > 0 ? networkModelCalls / moveStepRows.length : null
  if (reportedMetrics.modelCallsPerMechanicalStep !== undefined && reportedMetrics.modelCallsPerMechanicalStep !== modelCallsPerMechanicalStep) {
    throw new Error('legacy raw provider journals and movement records disagree with modelCallsPerMechanicalStep')
  }
  const host = fileText(files, 'runner/runtime/buddy.log')
  const hostRows = (marker) => host.split(/\r?\n/).filter((line) => line.includes(marker) && line.includes(`actionId=${moveEnd.actionId}`) &&
    line.includes(`runId=${expectedIdentity.runId}`) && line.includes(`generationId=${expectedIdentity.generationId}`) &&
    line.includes(`sourceSha=${expectedIdentity.sourceSha}`) && line.includes(`buildHash=${expectedIdentity.buildHash}`))
  if (hostRows('SKILL_START').length !== 1 || hostRows('SKILL_END').length !== 1) throw new Error('legacy HOST log does not uniquely bind the MOVE start/end to the raw run identity')
  if (hostRows('SKILL_END').some((line) => !/\boutcome=SUCCESS\b/.test(line) || !/\bfailure=null\b/.test(line))) {
    throw new Error('legacy HOST SKILL_END does not corroborate the verified successful MOVE')
  }
  const completedPath = host.split(/\r?\n/).filter((line) => line.includes('PATH_CALLBACK phase=completed') &&
    line.includes(`actionId=${moveEnd.actionId}`) && line.includes(`runId=${expectedIdentity.runId}`) &&
    line.includes(`generationId=${expectedIdentity.generationId}`) && line.includes(`sourceSha=${expectedIdentity.sourceSha}`) &&
    line.includes(`buildHash=${expectedIdentity.buildHash}`))
  if (completedPath.length !== 1 || summary.events?.moveActionEnd?.pathCallback !== 'completed' ||
      summary.events?.moveActionEnd?.skillEnd !== 'SUCCESS' || summary.events?.moveActionEnd?.verification !== 'verified') {
    throw new Error('legacy raw path callback and verified Skill outcome do not corroborate the movement summary')
  }
  const witnessAt = Date.parse(witness[0].at ?? '')
  const firstAt = Date.parse(firstRows[0].ts ?? firstRows[0].timestamp ?? '')
  const moveStartAt = Date.parse((/^\[([^\]]+)\]/.exec(hostRows('SKILL_START')[0]) ?? [])[1] ?? '')
  const moveEndAt = Date.parse((/^\[([^\]]+)\]/.exec(hostRows('SKILL_END')[0]) ?? [])[1] ?? '')
  const summaryMoveEndAt = Date.parse(summary.events?.moveActionEnd?.timestamp ?? summary.events?.moveActionEnd?.at ?? '')
  const nextAt = Date.parse(nextRows[0].ts ?? nextRows[0].timestamp ?? '')
  if (![witnessAt, firstAt, moveStartAt, moveEndAt, summaryMoveEndAt, nextAt].every(Number.isFinite)) {
    throw new Error('legacy witness/MOVE/decision chronology is missing timestamps')
  }
  if (!(witnessAt <= firstAt && firstAt <= moveStartAt && moveStartAt <= moveEndAt &&
      moveEndAt <= summaryMoveEndAt && summaryMoveEndAt <= nextAt)) {
    throw new Error('legacy witness, MOVE execution, and next inReach decision are not in causal order')
  }
  return {
    files,
    summary,
    mission,
    measured: {
      movementOperationsToInRange: moveStepRows.length,
      moveActionsToInRange: moveStartRows.length,
      decisionFramesToInRange: new Set([first.decisionId, next.decisionId]).size,
      questionCallsToInRange: questionCalls,
      jevProviderModelCalls: jevProviderAttempts,
      system2ModelCalls,
      networkModelCalls,
      modelCallsPerMovementStep: modelCallsPerMechanicalStep,
      jevProviderEvaluateAttempts: jevProviderAttempts,
      initialPlayerPosition: rawStart,
    },
    missionProvenance: normalizedTask.provenance,
  }
}

/** Read-only raw Reach baseline inspection used by the source-pinned collector. */
export function inspectLegacyReachArchive(archiveRoot) {
  const required = [
    'runner/reach-slice-evidence.json',
    'runner/runtime/buddy.log',
    'runner/runtime/logs/jev/run.jsonl',
    'runner/runtime/logs/jev/decisions.jsonl',
    'runner/runtime/logs/jev/jev-calls.jsonl',
    'runner/human-task-input.jsonl',
    'runner/block-read-run2.jsonl',
  ]
  const optional = ['runner/runtime/logs/jev/system2.jsonl']
  const files = []
  for (const path of [...required, ...optional.filter((path) => existsSync(join(archiveRoot, path)))]) {
    const absolute = join(archiveRoot, path)
    if (!existsSync(absolute)) throw new Error(`legacy baseline archive is missing ${path}`)
    const stat = lstatSync(absolute)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`legacy baseline source is not a regular file: ${path}`)
    if (stat.size > 5 * 1024 * 1024) throw new Error(`legacy baseline source exceeds 5 MiB: ${path}`)
    const bytes = readFileSync(absolute)
    files.push({ path, sizeBytes: bytes.length, sha256: sha256(bytes), contentBase64: bytes.toString('base64') })
  }
  const summary = JSON.parse(files.find((entry) => entry.path === 'runner/reach-slice-evidence.json').contentBase64
    ? Buffer.from(files.find((entry) => entry.path === 'runner/reach-slice-evidence.json').contentBase64, 'base64').toString('utf8')
    : '{}')
  const expectedIdentity = {
    sourceSha: summary.sourceSha,
    buildHash: summary.buildHash,
    runId: summary.runId,
    generationId: summary.generationId,
  }
  if (!SHA_RE.test(String(expectedIdentity.sourceSha ?? '')) || Object.values(expectedIdentity).some((value) => typeof value !== 'string' || value.length === 0)) {
    throw new Error('legacy raw summary does not bind complete source/build/run/generation identity')
  }
  return inspectRawLegacySide({ files }, expectedIdentity)
}

function readVtrProbe(files) {
  const probes = [...files.values()].filter((entry) => entry.label === 'probe input')
  if (probes.length !== 1) throw new Error('VTR raw archive must contain exactly one labeled probe input')
  return JSON.parse(probes[0].text)
}

function vtrRawIdentity(probe) {
  if (probe?.schema === 'vtr-reach-live-probe/v1') {
    return {
      sourceSha: probe.source?.commit,
      buildHash: probe.source?.buildHash,
      runId: probe.run?.runId,
      generationId: probe.run?.generationId,
      transitionId: probe.transition?.transitionId,
      contractHash: probe.transition?.contractHash,
      mission: canonicalMission(probe.mission),
    }
  }
  if (probe?.record === 'vtr-reach-live-probe') {
    return {
      sourceSha: probe.sourceSha,
      buildHash: probe.generationHash,
      runId: probe.runId,
      generationId: probe.generationId,
      transitionId: probe.transition?.commit?.transitionId,
      contractHash: probe.transition?.terminalOutcome?.contractHash,
      mission: canonicalMission(probe.mission),
    }
  }
  throw new Error('VTR raw probe input has an unsupported schema')
}

function inspectRawVtrSide(side, expectedIdentity) {
  const files = rawFileMap(side, 'VTR')
  const probe = readVtrProbe(files)
  const identity = vtrRawIdentity(probe)
  for (const key of ['sourceSha', 'buildHash', 'runId', 'generationId', 'transitionId', 'contractHash']) {
    if (identity[key] !== expectedIdentity[key]) throw new Error(`VTR raw probe ${key} does not match comparison lineage`)
  }
  if (!identity.mission) throw new Error('VTR raw probe does not serialize a canonical Mission')
  exactRawFile(files, 'runner/buddy.log', 'VTR')
  const eventPath = oneRawJournal(files, ['runner/run.jsonl', 'runner/jev-run.jsonl', 'runner/jev-run-source.jsonl'], 'VTR')
  const rows = agentEvents(files, eventPath, 'VTR')
  for (const path of ['runner/acceptance.json', 'runner/provider-activity-capture.json', 'runner/host-lifecycle.jsonl', 'server/fixture-commands.jsonl']) {
    exactRawFile(files, path, 'VTR')
  }
  const probeCommit = probe?.record === 'vtr-reach-live-probe'
    ? probe.transition?.commit
    : probe.transition?.commit ?? null
  const probeVerify = probe?.record === 'vtr-reach-live-probe'
    ? probe.transition?.verify
    : probe.transition?.verify ?? probe.transition?.terminal?.verify ?? null
  const probeTerminal = probe?.record === 'vtr-reach-live-probe'
    ? probe.transition?.terminalOutcome
    : probe.transition?.terminalOutcome ?? probe.transition?.terminal ?? null
  if (!probeCommit || !probeVerify || !probeTerminal) throw new Error('VTR probe does not serialize the committed contract, deterministic VERIFY, and terminal outcome')
  if (canonicalMission(probeCommit.mission) === null || !sameCanonicalMission(probeCommit.mission, probe.mission)) {
    throw new Error('VTR committed Mission differs from its run-scoped probe Mission')
  }
  const contractFields = ['mission', 'desiredPredicate', 'requires', 'ensures', 'invariants', 'admissibleEffects', 'budget', 'identity', 'witness']
  const transitionId = expectedIdentity.transitionId
  const commits = eventNamed(rows, 'VTR_TRANSITION_COMMIT', (row) => (row.detail?.transitionId ?? token(row.message, 'id')) === transitionId)
  const verifies = eventNamed(rows, 'VTR_TRANSITION_VERIFY', (row) => (row.detail?.transitionId ?? token(row.message, 'id')) === transitionId)
  const outcomes = eventNamed(rows, 'VTR_TRANSITION_OUTCOME', (row) => (row.detail?.transitionId ?? token(row.message, 'id')) === transitionId)
  if (commits.length !== 1 || verifies.length !== 1 || outcomes.length !== 1) throw new Error('VTR source journal does not uniquely bind commit, VERIFY, and terminal outcome')
  const commitRow = commits[0]
  const commitDetail = commitRow.detail ?? {}
  if (token(commitRow.message, 'contractHash') !== expectedIdentity.contractHash) throw new Error('VTR commit event contractHash differs from the run-scoped probe')
  for (const field of contractFields) {
    if (!isDeepStrictEqual(commitDetail[field], probeCommit[field])) throw new Error(`VTR raw commit ${field} differs from the committed probe contract`)
  }
  const contractIdentity = probeCommit.identity ?? {}
  const expectedWorldKey = probe?.record === 'vtr-reach-live-probe' ? contractIdentity.worldKey : probe.run?.worldKey
  if (contractIdentity.generationId !== expectedIdentity.generationId || contractIdentity.leaseId !== expectedIdentity.generationId ||
      typeof expectedWorldKey !== 'string' || !expectedWorldKey ||
      (probe?.record === 'vtr-reach-live-probe' && probe.server?.worldEpoch !== contractIdentity.worldEpoch)) {
    throw new Error('VTR committed contract identity is not bound to generation/world epoch')
  }
  const verifyDetail = verifies[0].detail ?? {}
  const expectedVerify = probeVerify.detail ?? probeVerify
  const terminalDetail = outcomes[0].detail ?? {}
  const terminalOutcome = terminalDetail.outcome ?? probeTerminal.outcome
  const terminalMetrics = terminalDetail.metrics ?? probeTerminal.metrics ?? {}
  if (verifyDetail.truth !== 'TRUE' || verifyDetail.identityMatches !== true || verifyDetail.predicatesVerified !== true ||
      verifyDetail.transitionId !== transitionId || verifyDetail.contractHash !== expectedIdentity.contractHash ||
      verifyDetail.runId !== expectedIdentity.runId || verifyDetail.generationId !== expectedIdentity.generationId ||
      verifyDetail.sourceSha !== expectedIdentity.sourceSha || verifyDetail.worldKey !== expectedWorldKey ||
      !Number.isSafeInteger(verifyDetail.verifiedAtMs) || verifyDetail.verifiedAtMs !== verifyDetail.observedAtMs ||
      !Array.isArray(verifyDetail.evidenceIds) || !verifyDetail.evidenceIds.length ||
      !isDeepStrictEqual(verifyDetail.evidenceIds, expectedVerify.evidenceIds ?? probeTerminal.outcome?.evidenceIds) ||
      verifyDetail.desiredPredicateIdentity !== (expectedVerify.desiredPredicateIdentity ?? probeTerminal.outcome?.desiredPredicateIdentity)) {
    throw new Error('VTR raw VERIFY does not deterministically match the probe identity, predicate evidence, and timestamps')
  }
  if (!terminalOutcome || terminalOutcome.kind !== 'SUCCESS' || terminalOutcome.contractHash !== expectedIdentity.contractHash ||
      terminalOutcome.desiredPredicateIdentity !== verifyDetail.desiredPredicateIdentity || terminalOutcome.verifiedAtMs !== verifyDetail.verifiedAtMs ||
      !isDeepStrictEqual(terminalOutcome.evidenceIds, verifyDetail.evidenceIds) ||
      terminalDetail.boundary !== (probeTerminal.boundary ?? terminalDetail.boundary) ||
      !['verified-terminal', 'mechanical-step-outcome'].includes(terminalDetail.boundary)) {
    throw new Error('VTR terminal outcome does not exactly close the matching deterministic VERIFY')
  }
  const reservations = eventNamed(rows, 'VTR_MECHANICAL_STEP_RESERVED', (row) => row.detail?.transitionId === transitionId)
  const stepOutcomes = eventNamed(rows, 'VTR_MECHANICAL_STEP_OUTCOME', (row) => row.detail?.transitionId === transitionId)
  if (reservations.length < 3 || reservations.length !== stepOutcomes.length) {
    throw new Error('VTR live evidence must prove at least three reserved and settled mechanical legs under one Transition')
  }
  const reservationIds = reservations.map((row) => row.detail?.stepId)
  const outcomeIds = stepOutcomes.map((row) => row.detail?.stepId)
  if (reservationIds.some((id) => typeof id !== 'string') || new Set(reservationIds).size !== reservations.length ||
      !isDeepStrictEqual([...reservationIds].sort(), [...outcomeIds].sort()) ||
      reservations.some((row) => row.detail?.effectKind !== 'locomotion' || row.detail?.intentId === undefined)) {
    throw new Error('VTR mechanical outcomes do not settle each unique locomotion reservation')
  }
  const finalStep = stepOutcomes.find((row) => row.detail?.stepId === reservationIds.at(-1))
  const selectedActionId = vtrMoveActionId(rows, transitionId)
  for (const reservation of reservations) {
    const settled = stepOutcomes.filter((row) => row.detail?.stepId === reservation.detail.stepId)
    if (settled.length !== 1 || settled[0].detail?.transitionId !== transitionId ||
        reservation.detail?.contractHash !== expectedIdentity.contractHash ||
        settled[0].detail?.contractHash !== expectedIdentity.contractHash ||
        settled[0].detail?.intentId !== reservation.detail.intentId ||
        typeof reservation.detail.actionId !== 'string' || reservation.detail.actionId !== selectedActionId ||
        settled[0].detail?.actionId !== reservation.detail.actionId) {
      throw new Error('VTR mechanical settlement changed transition/intent/action ownership')
    }
  }
  if (!finalStep || finalStep.detail?.status !== 'terminal' || finalStep.detail?.outcome !== 'SUCCESS' || finalStep.detail?.verified !== true) {
    throw new Error('last VTR mechanical leg did not carry the verified terminal SUCCESS outcome')
  }
  const selectedSkillStart = eventNamed(rows, 'SKILL_START', (row) => eventActionId(row) === selectedActionId)[0]
  const commitmentId = selectedSkillStart?.detail?.commitmentId ?? token(selectedSkillStart?.message ?? '', 'commitmentId')
  const commitAtForLegs = Date.parse(commitRow.ts ?? '')
  const terminalAtForLegs = Date.parse(outcomes[0].ts ?? '')
  const walkLegRows = eventNamed(rows, 'SKILL_STEP', (row) => token(row.message, 'step') === 'walk_leg').filter((row) => {
    const at = Date.parse(row.ts ?? '')
    return Number.isFinite(at) && at >= commitAtForLegs && at <= terminalAtForLegs
  })
  const walkLegProof = inspectLiveWalkLegOwnership({
    walkLegRows,
    actionId: selectedActionId,
    commitmentId,
    transitionId,
    contractHash: expectedIdentity.contractHash,
    reservations,
    stepOutcomes,
    events: rows,
  })
  if (walkLegProof.status !== 'PASS') throw new Error(`VTR live proof has fewer than three successful settled correlated walk_leg rows or violates ownership: ${walkLegProof.reason}`)
  if (Number(terminalDetail.usage?.mechanicalSteps) !== reservations.length ||
      Number(terminalMetrics.mechanicalStepsPerTransition) !== reservations.length ||
      terminalMetrics.verifiedTransitionCompletion !== 1 || terminalMetrics.typedTerminalOutcome !== 'SUCCESS' ||
      terminalMetrics.duplicateAuthority !== false || terminalMetrics.duplicateAuthorityConflicts !== 0) {
    throw new Error('VTR raw terminal metrics disagree with reserved/settled mechanical legs or SUCCESS/authority evidence')
  }
  const selectedSkillStarts = eventNamed(rows, 'SKILL_START').filter((row) => /\bselectedBy=vtr-transition(?:\s|$)/.test(row.message))
  const allMoveStarts = eventNamed(rows, 'SKILL_START').filter((row) => String(eventActionId(row) ?? '').startsWith('MOVE:'))
  const vtrMoveStarts = selectedSkillStarts.filter((row) => String(eventActionId(row) ?? '').startsWith('MOVE:'))
  const legacyMoveStarts = allMoveStarts.filter((row) => !/\bselectedBy=vtr-transition(?:\s|$)/.test(row.message))
  const vtrMoveEnds = vtrMoveStarts.length === 1
    ? eventNamed(rows, 'SKILL_END', (row) => eventActionId(row) === eventActionId(vtrMoveStarts[0]))
    : []
  if (vtrMoveStarts.length !== 1 || legacyMoveStarts.length !== 0 || selectedSkillStarts.length !== 1 ||
      vtrMoveEnds.length !== 1 || !/\bexecution=success\b/.test(vtrMoveEnds[0]?.message ?? '') ||
      !/\bverification=verified\b/.test(vtrMoveEnds[0]?.message ?? '') || !/\boutcome=SUCCESS\b/.test(vtrMoveEnds[0]?.message ?? '')) {
    throw new Error('VTR and legacy movement actuation are not uniquely separated by the production run journal')
  }
  const noDouble = JSON.parse(exactRawFile(files, 'proofs/no-double-authority.json', 'VTR').text)
  if (noDouble.result !== 'PASS' || noDouble.sourceSha !== expectedIdentity.sourceSha || noDouble.runId !== expectedIdentity.runId ||
      noDouble.generationId !== expectedIdentity.generationId || noDouble.legacyActuationCount !== legacyMoveStarts.length ||
      noDouble.vtrActuationCount !== vtrMoveStarts.length || noDouble.duplicateAuthority !== false || noDouble.duplicateAuthorityConflicts !== 0) {
    throw new Error('VTR no-double-authority artifact does not match independently recomputed production events')
  }
  const provider = providerCapture(files, expectedIdentity, probe, rows)
  if (terminalMetrics.jevCallsPerTransition !== provider.activity.jevDecisionFrames ||
      terminalMetrics.system2CallsPerTransition !== provider.activity.system2DecisionInvocations) {
    throw failEvidence('VTR terminal decision-call metrics disagree with the captured Jev/System2 decision journals')
  }
  if (terminalMetrics.decisionFrameInvocations !== undefined &&
      terminalMetrics.decisionFrameInvocations !== provider.activity.jevDecisionFrames) {
    throw failEvidence('VTR terminal Jev decision-frame metric disagrees with the captured Jev call journal')
  }
  if (terminalMetrics.providerEvaluateAttempts !== undefined &&
      terminalMetrics.providerEvaluateAttempts !== provider.activity.networkModelCalls) {
    throw failEvidence('VTR terminal provider-attempt metric disagrees with captured Jev/Mercury journals')
  }
  const rawConfiguration = probe.configuration ?? {
    BUDDY_POLICY: probe.configuredNoLlmProbe?.effectiveJev?.configuredPolicy,
    BUDDY_SYSTEM2: probe.configuredNoLlmProbe?.effectiveSystem2?.configuredMode,
    effectiveJevProvider: probe.configuredNoLlmProbe?.effectiveJev?.provider,
    effectiveJevModel: probe.configuredNoLlmProbe?.effectiveJev?.model,
    effectiveSystem2Provider: probe.configuredNoLlmProbe?.effectiveSystem2?.provider,
    effectiveSystem2Model: probe.configuredNoLlmProbe?.effectiveSystem2?.model,
    networkModelCalls: probe.configuredNoLlmProbe?.networkModelCalls,
  }
  if (!rawConfiguration || typeof rawConfiguration.BUDDY_POLICY !== 'string' || typeof rawConfiguration.BUDDY_SYSTEM2 !== 'string' ||
      typeof rawConfiguration.effectiveJevProvider !== 'string' || typeof rawConfiguration.effectiveJevModel !== 'string' ||
      typeof rawConfiguration.effectiveSystem2Provider !== 'string' || typeof rawConfiguration.effectiveSystem2Model !== 'string' ||
      rawConfiguration.networkModelCalls !== 0) {
    throw new Error('VTR raw probe does not record the effective Jev/System2 policy and zero network model calls')
  }
  const commitAt = Date.parse(commitRow.ts ?? '')
  const verifyAt = Date.parse(verifies[0].ts ?? '')
  const terminalAt = Date.parse(outcomes[0].ts ?? '')
  const reservationTimes = reservations.map((row) => Date.parse(row.ts ?? ''))
  const outcomeTimes = stepOutcomes.map((row) => Date.parse(row.ts ?? ''))
  const rowIndex = (row) => rows.indexOf(row)
  const commitIndex = rowIndex(commitRow)
  const verifyIndex = rowIndex(verifies[0])
  const terminalIndex = rowIndex(outcomes[0])
  if (![commitAt, verifyAt, terminalAt, ...reservationTimes, ...outcomeTimes].every(Number.isFinite) ||
      reservations.some((row) => rowIndex(row) <= commitIndex || rowIndex(row) >= verifyIndex) ||
      stepOutcomes.some((row) => rowIndex(row) <= commitIndex || rowIndex(row) >= verifyIndex) ||
      reservationTimes.some((value) => value < commitAt || value > verifyAt) ||
      outcomeTimes.some((value) => value < commitAt || value > verifyAt) ||
      verifyAt > terminalAt || verifyIndex > terminalIndex) {
    throw new Error('VTR commit/mechanical/VERIFY/terminal records are not time-ordered')
  }
  const skillStartAt = Date.parse(eventNamed(rows, 'SKILL_START', (row) => row.detail?.actionId === selectedActionId)[0]?.ts ?? '')
  const reservationsById = new Map(reservations.map((row) => [row.detail.stepId, row]))
  if (!Number.isFinite(skillStartAt) || skillStartAt < commitAt || reservationTimes.some((value) => value < skillStartAt) ||
      stepOutcomes.some((row) => {
        const reservedAt = Date.parse(reservationsById.get(row.detail.stepId)?.ts ?? '')
        const settledAt = Date.parse(row.ts ?? '')
        return !Number.isFinite(reservedAt) || !Number.isFinite(settledAt) || settledAt < reservedAt
      })) {
    throw new Error('VTR Skill ownership or mechanical reserve/settlement timestamps are not causally ordered')
  }
  const transitionWindowSkillStarts = eventNamed(rows, 'SKILL_START').filter((row) => {
    const at = Date.parse(row.ts ?? '')
    return Number.isFinite(at) && at >= commitAt && at <= terminalAt
  })
  if (transitionWindowSkillStarts.length !== 1 || eventActionId(transitionWindowSkillStarts[0]) !== selectedActionId ||
      !/\bselectedBy=vtr-transition(?:\s|$)/.test(transitionWindowSkillStarts[0]?.message ?? '')) {
    throw new Error('active Reach Transition has another or unowned Skill start inside its commit-to-terminal window')
  }
  for (const key of ['jevCallsPerTransition', 'system2CallsPerTransition', 'modelCallsPerMechanicalStep']) {
    if (!Number.isFinite(terminalMetrics[key]) || terminalMetrics[key] < 0) {
      throw new Error(`VTR raw terminal metrics omit a finite nonnegative ${key}`)
    }
  }
  const host = fileText(files, 'runner/buddy.log')
  const hostLines = host.split(/\r?\n/)
  const hostMatch = (marker, predicate) => hostLines.filter((line) => line.includes(marker) && predicate(line))
  const bootRows = hostMatch('BOOT ', (line) => token(line, 'runId') === expectedIdentity.runId &&
    (token(line, 'sourceSha') ?? token(line, 'source')) === expectedIdentity.sourceSha)
  const readyRows = hostMatch('GENERATION_READY ', (line) => token(line, 'runId') === expectedIdentity.runId &&
    (token(line, 'generationId') ?? token(line, 'id')) === expectedIdentity.generationId &&
    token(line, 'sourceSha') === expectedIdentity.sourceSha && token(line, 'buildHash') === expectedIdentity.buildHash)
  const commitHostRows = hostMatch('VTR_TRANSITION_COMMIT ', (line) => token(line, 'transitionId') === transitionId &&
    token(line, 'runId') === expectedIdentity.runId && token(line, 'generationId') === expectedIdentity.generationId &&
    token(line, 'sourceSha') === expectedIdentity.sourceSha && token(line, 'contractHash') === expectedIdentity.contractHash)
  const verifyHostRows = hostMatch('VTR_TRANSITION_VERIFY ', (line) => token(line, 'transitionId') === transitionId &&
    token(line, 'runId') === expectedIdentity.runId && token(line, 'generationId') === expectedIdentity.generationId &&
    token(line, 'sourceSha') === expectedIdentity.sourceSha && token(line, 'contractHash') === expectedIdentity.contractHash &&
    token(line, 'truth') === 'TRUE')
  const terminalHostRows = hostMatch('VTR_TRANSITION_OUTCOME ', (line) => token(line, 'transitionId') === transitionId &&
    token(line, 'runId') === expectedIdentity.runId && token(line, 'generationId') === expectedIdentity.generationId &&
    token(line, 'sourceSha') === expectedIdentity.sourceSha && token(line, 'contractHash') === expectedIdentity.contractHash &&
    /\boutcome=\{"kind":"SUCCESS"/.test(line))
  if (bootRows.length !== 1 || readyRows.length !== 1 || commitHostRows.length !== 1 || verifyHostRows.length !== 1 || terminalHostRows.length !== 1) {
    throw new Error('VTR HOST log does not uniquely bind BOOT, GENERATION_READY, commit, VERIFY, and SUCCESS to the raw run')
  }
  const hostTimes = [bootRows[0], readyRows[0], commitHostRows[0], verifyHostRows[0], terminalHostRows[0]].map(logTimestamp)
  if (!hostTimes.every(Number.isFinite) || hostTimes.some((value, index) => index > 0 && hostTimes[index - 1] > value)) {
    throw new Error('VTR HOST run/generation/Transition identity markers are not time ordered')
  }
  return {
    files,
    probe,
    identity,
    mission: identity.mission,
    configuration: rawConfiguration,
    measured: {
      verifiedTransitionCompletionCount: terminalMetrics.verifiedTransitionCompletion,
      mechanicalStepsPerTransition: reservations.length,
      successfulWalkLegRows: walkLegProof.successfulWalkLegs,
      excludedFailedWalkLegRows: walkLegProof.excludedFailedWalkLegs,
      typedTerminalOutcome: terminalOutcome.kind,
      legacyJevCallsPerTransition: terminalMetrics.jevCallsPerTransition,
      system2CallsPerTransition: terminalMetrics.system2CallsPerTransition,
      modelCallsPerMechanicalStep: terminalMetrics.modelCallsPerMechanicalStep,
      decisionFrameInvocationsPerTransition: provider.activity.jevDecisionFrames,
      jevProviderEvaluateAttemptsIncludingRetriesPerTransition: provider.activity.jevEvaluateAttempts,
      jevProviderEvaluateAttemptsPerMechanicalStep: reservations.length > 0
        ? provider.activity.jevEvaluateAttempts / reservations.length : null,
      system2ProviderEvaluateAttemptsPerTransition: provider.activity.system2EvaluateAttempts,
      providerEvaluateAttemptsPerTransition: provider.activity.networkModelCalls,
      providerEvaluateAttemptsPerMechanicalStep: reservations.length > 0
        ? provider.activity.networkModelCalls / reservations.length : null,
      duplicateAuthority: legacyMoveStarts.length === 0 && vtrMoveStarts.length === 1,
      duplicateAuthorityConflicts: terminalMetrics.duplicateAuthorityConflicts,
      concurrentLegacyActuations: legacyMoveStarts.length,
      providerActivity: provider.activity,
    },
  }
}

function vtrMoveActionId(rows, transitionId) {
  const selectedStarts = eventNamed(rows, 'SKILL_START').filter((row) =>
    /\bselectedBy=vtr-transition(?:\s|$)/.test(row.message) && String(eventActionId(row) ?? '').startsWith('MOVE:'))
  if (selectedStarts.length !== 1) throw new Error(`VTR transition ${transitionId} must have exactly one VTR-selected MOVE owner`)
  return eventActionId(selectedStarts[0])
}

function coordinateVector(target, player, blockRelative = false) {
  if (!target || !player || !['x', 'y', 'z'].every((key) => Number.isFinite(target[key]) && Number.isFinite(player[key]))) return null
  return Object.fromEntries(['x', 'y', 'z'].map((key) => [key, target[key] - (blockRelative ? Math.floor(player[key]) : player[key])]))
}

function vectorsMatch(left, right) {
  return left !== null && right !== null && ['x', 'y', 'z'].every((key) => closeNumber(left[key], right[key]))
}

function normalizedDimension(value) {
  return typeof value === 'string' ? value.replace(/^minecraft:/, '') : null
}

function assertReportedMatch(actual, reported, label) {
  if (actual !== reported) throw new Error(`reported ${label}=${String(reported)} does not match raw evidence (${String(actual)})`)
}

function inspectReportedAlignment(legacyRaw, vtrRaw, proof, claimsAcceptance) {
  const legacy = legacyRaw.summary
  const vtrIdentity = vtrRaw.identity
  const legacyRun = legacy.run ?? {}
  const legacyFixture = legacy.fixture ?? {}
  const probe = vtrRaw.probe
  const server = probe.server ?? {}
  const run = probe.run ?? {}
  const rawVtrFixture = probe.fixture ?? {}
  const witness = rawVtrFixture.relativeResourceSource ?? rawVtrFixture.witness ?? probe.transition?.commit?.witness ?? {}
  const legacyPosition = legacyFixture.position
  const legacyStart = legacyFixture.initialPlayerPosition
  const vtrPosition = witness.position ?? witness.target ?? witness.blockPosition
  const vtrStart = rawVtrFixture.transitionStartPosition ?? rawVtrFixture.initialPlayerPosition ?? run.initialPosition ?? probe.mission?.initialPosition
  const legacyExact = coordinateVector(legacyPosition, legacyStart)
  const vtrExact = coordinateVector(vtrPosition, vtrStart)
  const legacyRelative = coordinateVector(legacyPosition, legacyStart, true)
  const vtrRelative = coordinateVector(vtrPosition, vtrStart, true)
  const legacyDeclared = legacyFixture.sourceOffsetFromInitialPlayer ?? legacyFixture.offset ?? null
  const vtrDeclared = rawVtrFixture.sourceOffsetFromInitialPlayer ?? rawVtrFixture.offset ?? null
  const declaredOffsetsMatch = [
    [legacyDeclared, legacyFixture.sourceOffsetFromInitialPlayer !== undefined ? legacyRelative : legacyExact],
    [vtrDeclared, rawVtrFixture.sourceOffsetFromInitialPlayer !== undefined ? vtrRelative : vtrExact],
  ].every(([declared, derived]) => declared === null || vectorsMatch(declared, derived))
  const sameResource = typeof legacyFixture.block === 'string' && typeof witness.block === 'string' &&
    legacyFixture.block.replace(/^minecraft:/, '') === witness.block.replace(/^minecraft:/, '')
  const sameExact = vectorsMatch(legacyExact, vtrExact)
  const sameRelative = vectorsMatch(legacyRelative, vtrRelative)
  const legacyFlat = legacyFixture.flatSolidGround
  const vtrFlat = rawVtrFixture.flatSolidGround
  const sameFlat = typeof legacyFlat === 'boolean' && typeof vtrFlat === 'boolean' && legacyFlat === true && vtrFlat === true
  const sensorBound = rawVtrFixture.witnessChosenByProductionSensor === true
  const alignment = proof.alignment ?? {}
  const reported = proof.fixtureAlignment ?? {}
  if (alignment.fixture === 'PASS' || claimsAcceptance) {
    assertReportedMatch(sameResource, reported.sameTargetResourceKind, 'sameTargetResourceKind')
    assertReportedMatch(sameExact, reported.sameExactCartesianDelta, 'sameExactCartesianDelta')
    assertReportedMatch(sameRelative, reported.sameRelativeBlockOffset, 'sameRelativeBlockOffset')
    assertReportedMatch(sameResource && sameExact && sameRelative && declaredOffsetsMatch, reported.sameRelativeFixture, 'sameRelativeFixture')
    assertReportedMatch(sameFlat, reported.sameFlatGround, 'sameFlatGround')
    assertReportedMatch(sensorBound, reported.vtrWitnessSensorBound, 'vtrWitnessSensorBound')
    const legacyReported = reported.legacyFixtureStructured
    const vtrReported = reported.vtrFixture
    if (!legacyReported || !vtrReported ||
        legacyReported.block !== legacyFixture.block || vtrReported.block !== witness.block ||
        !isDeepStrictEqual(legacyReported.position, legacyPosition) || !isDeepStrictEqual(legacyReported.initialPlayerPosition, legacyStart) ||
        !isDeepStrictEqual(vtrReported.sourcePosition, vtrPosition) || !isDeepStrictEqual(vtrReported.initialPlayerPosition, vtrStart) ||
        !vectorsMatch(legacyReported.exactCartesianDelta, legacyExact) || !vectorsMatch(legacyReported.relativeBlockOffset, legacyRelative) ||
        !vectorsMatch(vtrReported.exactCartesianDelta, vtrExact) || !vectorsMatch(vtrReported.relativeBlockOffset, vtrRelative) ||
        legacyReported.flatSolidGround !== legacyFlat || vtrReported.flatSolidGround !== vtrFlat ||
        vtrReported.witnessChosenByProductionSensor !== rawVtrFixture.witnessChosenByProductionSensor) {
      throw new Error('reported fixture geometry/source differs from run-bound raw target and player positions')
    }
    if (!(sameResource && sameExact && sameRelative && declaredOffsetsMatch && sameFlat && sensorBound)) {
      throw new Error('comparison claims aligned fixture but run-bound target, geometry, ground, or sensor evidence does not align')
    }
  }

  const legacyWorldKey = legacyRun.worldKey
  const legacyWorld = typeof legacyWorldKey === 'string' ? parseWorldKey(legacyWorldKey) : null
  const vtrWorldKey = run.worldKey ?? `${server.serverId ?? ''}|${server.dimension ?? run.dimension ?? ''}|${server.worldEpoch ?? run.worldEpoch ?? ''}`
  const vtrWorld = typeof vtrWorldKey === 'string' ? parseWorldKey(vtrWorldKey) : null
  const rawEnvironment = {
    minecraftVersion: legacyRun.minecraftVersion === undefined || legacyRun.minecraftVersion === null || legacyRun.minecraftVersion === 'not recorded'
      ? 'unknown' : legacyRun.minecraftVersion === (run.minecraftVersion ?? server.minecraftVersion) ? true : false,
    gameMode: legacyRun.gameMode === undefined || legacyRun.gameMode === null || legacyRun.gameMode === 'not recorded'
      ? 'unknown' : legacyRun.gameMode === (run.gameMode ?? server.gameMode ?? server.gamemode) ? true : false,
    difficulty: legacyRun.difficulty === undefined || legacyRun.difficulty === null || legacyRun.difficulty === 'not recorded'
      ? 'unknown' : legacyRun.difficulty === (run.difficulty ?? server.difficulty) ? true : false,
    dimension: legacyWorld === null || vtrWorld === null ? 'unknown' : legacyWorld.dimension === vtrWorld.dimension,
  }
  const legacySeed = legacyRun.seed
  const vtrSeed = run.seed ?? server.worldSeedFromLevelDat ?? server.seed
  rawEnvironment.seed = legacySeed === undefined || legacySeed === null || legacySeed === 'not recorded' || vtrSeed === undefined || vtrSeed === null || vtrSeed === 'not recorded'
    ? 'unknown' : String(legacySeed) === String(vtrSeed)
  const seedAssessment = run.seedAssessment ?? server.seedAssessment ?? probe.identity?.seedAssessment
  if (typeof seedAssessment === 'string') rawEnvironment.seedProvenance = /disagree|mismatch|conflict/i.test(seedAssessment) ? false : true
  const allEnvironmentMatched = Object.values(rawEnvironment).every((value) => value === true)
  if (alignment.environment === 'PASS' || claimsAcceptance) {
    if (!isDeepStrictEqual(reported.environmentMatch, rawEnvironment)) throw new Error('reported environmentMatch does not match run-bound legacy/VTR world and configuration fields')
    if (!allEnvironmentMatched) throw new Error('comparison claims aligned environment but run-bound world/version/mode/difficulty/seed evidence does not align')
  }

  const lineage = proof.lineage ?? {}
  const legacyLineage = lineage.legacy ?? {}
  const vtrLineage = lineage.vtr ?? {}
  const rawDimension = legacyWorld?.dimension ?? null
  for (const [field, expected] of Object.entries({
    sourceSha: legacy.sourceSha,
    buildHash: legacy.buildHash,
    runId: legacy.runId,
    generationId: legacy.generationId,
    worldKey: legacyRun.worldKey ?? null,
    worldEpoch: legacyRun.worldEpoch ?? null,
    dimension: rawDimension,
    minecraftVersion: legacyRun.minecraftVersion ?? null,
    gameMode: legacyRun.gameMode ?? null,
    difficulty: legacyRun.difficulty ?? null,
    seed: legacyRun.seed === undefined ? null : String(legacyRun.seed),
  })) assertReportedMatch(expected, legacyLineage[field] ?? null, `legacy lineage ${field}`)
  const vtrDimension = run.dimension ?? server.dimension ?? null
  for (const [field, expected] of Object.entries({
    sourceSha: vtrIdentity.sourceSha ?? probe.sourceSha ?? probe.source?.commit,
    buildHash: vtrIdentity.buildHash ?? probe.generationHash ?? probe.source?.buildHash,
    runId: vtrIdentity.runId ?? probe.runId ?? run.runId,
    generationId: vtrIdentity.generationId ?? probe.generationId ?? run.generationId,
    worldKey: run.worldKey ?? vtrWorldKey,
    worldEpoch: run.worldEpoch ?? server.worldEpoch,
    dimension: vtrDimension,
    minecraftVersion: run.minecraftVersion ?? server.minecraftVersion ?? null,
    gameMode: run.gameMode ?? server.gameMode ?? server.gamemode ?? null,
    difficulty: run.difficulty ?? server.difficulty ?? null,
    seed: (run.seed ?? server.worldSeedFromLevelDat ?? server.seed) === undefined ? null : String(run.seed ?? server.worldSeedFromLevelDat ?? server.seed),
    seedAssessment: run.seedAssessment ?? server.seedAssessment ?? probe.identity?.seedAssessment ?? null,
  })) assertReportedMatch(expected, vtrLineage[field] ?? null, `VTR lineage ${field}`)
}

/** Independently checks a comparator artifact and its embedded raw run evidence. */
export function inspectReachComparisonProof(proof, expectedLiveSourceSha, expectedLegacyOriginMainSha = null) {
  const incomplete = (reason, details = {}) => ({ status: 'INCOMPLETE', reason, ...details })
  const fail = (reason, details = {}) => ({ status: 'FAIL', reason, ...details })
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)) return fail('comparison artifact is not an object')
  if (proof.schema === 'vtr-reach-fixture-comparison/v2') {
    if (proof.evidenceClass !== 'summary-only' || proof.acceptanceEligible !== false || proof.acceptanceStatus !== 'NOT_ASSESSED_SUMMARY_ONLY') {
      return fail('v2 comparison misrepresents summary-only input as raw or acceptance evidence')
    }
    return incomplete('v2 comparison is summary-only and cannot qualify as migration acceptance')
  }
  if (proof.schema !== 'vtr-reach-fixture-comparison/v3') return incomplete('comparison artifact schema is not supported', { schema: proof.schema ?? null })

  const legacy = proof.lineage?.legacy
  const vtr = proof.lineage?.vtr
  if (typeof legacy?.sourceSha !== 'string' || !SHA_RE.test(legacy.sourceSha) || typeof legacy.runId !== 'string' ||
      typeof legacy.generationId !== 'string' || typeof legacy.buildHash !== 'string') return incomplete('legacy comparison lineage is not fully source/run/generation/build bound')
  if (typeof vtr?.sourceSha !== 'string' || !SHA_RE.test(vtr.sourceSha) || typeof vtr.runId !== 'string' ||
      typeof vtr.generationId !== 'string' || typeof vtr.buildHash !== 'string') {
    return incomplete('VTR comparison lineage is not fully source/run/generation/build/Transition bound')
  }
  if (typeof expectedLiveSourceSha !== 'string' || !SHA_RE.test(expectedLiveSourceSha)) return incomplete('live Transition source SHA is unavailable for comparison binding')
  if (vtr.sourceSha.toLowerCase() !== expectedLiveSourceSha.toLowerCase()) return fail('comparison VTR source SHA differs from the live Transition source', { expectedSourceSha: expectedLiveSourceSha, observedSourceSha: vtr.sourceSha })
  if (typeof expectedLegacyOriginMainSha !== 'string' || !SHA_RE.test(expectedLegacyOriginMainSha)) return incomplete('current origin/main SHA is unavailable for legacy baseline binding')
  if (legacy.runId === vtr.runId || legacy.generationId === vtr.generationId) return fail('legacy and VTR comparison sides reuse one run or generation identity')
  const aligned = proof.alignment?.missionInput === 'PASS' && proof.alignment?.fixture === 'PASS' && proof.alignment?.environment === 'PASS'
  if (proof.comparisonStatus === 'PASS' && !aligned) return fail('comparison reports PASS while one or more alignment dimensions are not PASS', { alignment: proof.alignment ?? null })
  const raw = proof.rawComparisonEvidence
  const claimsAcceptance = proof.comparisonStatus === 'PASS' || proof.acceptanceEligible === true
  const claimsRaw = proof.evidenceClass === 'run-scoped-raw-events' || raw?.status === 'PASS' || raw?.evidenceClass === 'run-scoped-raw-events'
  if (!claimsRaw) {
    if (claimsAcceptance) return fail('comparison claims acceptance without run-scoped raw evidence')
    return incomplete('comparison has no run-scoped raw evidence')
  }
  if (proof.evidenceClass !== 'run-scoped-raw-events' || proof.acceptanceStatus !== 'ASSESSED_RAW_RUN_COMPARISON') {
    if (claimsAcceptance) return fail('comparison claims acceptance with inconsistent evidence classification')
  }
  if (raw?.schema !== 'vtr-reach-run-comparison-evidence/v1' || raw.status !== 'PASS' || raw.evidenceClass !== 'run-scoped-raw-events') {
    if (claimsAcceptance) return fail('acceptance-eligible comparison lacks a PASS run-scoped raw-evidence bundle')
    return incomplete('raw comparison capture is incomplete', { rawStatus: raw?.status ?? null })
  }
  if (proof.evidenceClass !== 'run-scoped-raw-events') return fail('raw comparison bundle is PASS but top-level evidenceClass denies or mislabels it')
  try {
    if (typeof legacy.recordedOriginMainSha !== 'string' || !SHA_RE.test(legacy.recordedOriginMainSha)) {
      throw new Error('legacy baseline does not record a full origin/main source SHA')
    }
    if (legacy.recordedOriginMainSha.toLowerCase() !== legacy.sourceSha.toLowerCase() ||
        legacy.recordedOriginMainSha.toLowerCase() !== expectedLegacyOriginMainSha.toLowerCase()) {
      throw new Error('legacy source SHA differs from the current origin/main baseline SHA')
    }
    const legacyExpected = { sourceSha: legacy.sourceSha, buildHash: legacy.buildHash, runId: legacy.runId, generationId: legacy.generationId }
    const vtrExpected = { sourceSha: vtr.sourceSha, buildHash: vtr.buildHash, runId: vtr.runId, generationId: vtr.generationId,
      transitionId: proof.metrics?.reachBoundary?.vtr?.transitionId, contractHash: proof.metrics?.reachBoundary?.vtr?.contractHash }
    for (const [key, expected] of Object.entries(legacyExpected)) if (raw.legacy?.identity?.[key] !== expected) throw new Error(`legacy raw identity ${key} does not match lineage`)
    for (const [key, expected] of Object.entries(vtrExpected)) if (typeof expected !== 'string' || raw.vtr?.identity?.[key] !== expected) throw new Error(`VTR raw identity ${key} does not match lineage`)
    if (raw.legacy.status !== 'PASS' || raw.vtr.status !== 'PASS' || raw.legacy.events?.status !== 'PASS' || raw.vtr.events?.status !== 'PASS') {
      throw new Error('raw evidence side or event binding is not PASS')
    }
    const legacyRaw = inspectRawLegacySide(raw.legacy, legacyExpected)
    const vtrRaw = inspectRawVtrSide(raw.vtr, vtrExpected)
    inspectReportedAlignment(legacyRaw, vtrRaw, proof, claimsAcceptance)
    if (!sameCanonicalMission(raw.legacy.mission, legacyRaw.mission) || !sameCanonicalMission(raw.vtr.mission, vtrRaw.mission)) {
      throw new Error('serialized comparison Mission differs from the actual run artifacts')
    }
    const rawMissionsEqual = sameCanonicalMission(legacyRaw.mission, vtrRaw.mission)
    const reportedMissionsEqual = sameCanonicalMission(proof.fixtureAlignment?.legacyMissionInput, proof.fixtureAlignment?.vtrMission) &&
      sameCanonicalMission(legacyRaw.mission, proof.fixtureAlignment?.legacyMissionInput)
    if (!rawMissionsEqual || !reportedMissionsEqual || proof.fixtureAlignment?.sameMissionInput !== true) {
      if (proof.alignment?.missionInput === 'PASS' || claimsAcceptance) throw new Error('comparison claims same Mission although the raw canonical kind/item/count artifacts differ')
      return incomplete('the raw legacy and VTR Mission artifacts differ; this comparison is not same-Mission evidence')
    }
    if (raw.legacy.events?.eventIds?.firstDecision !== legacyRaw.summary.events?.firstDecision?.decisionId ||
        raw.legacy.events?.eventIds?.nextDecision !== legacyRaw.summary.events?.nextDecisionInRange?.decisionId ||
        raw.vtr.events?.transitionId !== vtrExpected.transitionId || raw.vtr.events?.outcome !== 'SUCCESS') {
      throw new Error('raw event summary disagrees with independently parsed run artifacts')
    }
    const metricPairs = [
      [proof.metrics?.reachBoundary?.legacy?.movementOperationsToInRangeEvidence, legacyRaw.measured.movementOperationsToInRange, 'legacy movement operations'],
      [proof.metrics?.reachBoundary?.legacy?.moveActionsToInRangeEvidence, legacyRaw.measured.moveActionsToInRange, 'legacy MOVE actions'],
      [proof.metrics?.reachBoundary?.legacy?.policyDecisionFramesToInRangeEvidence, legacyRaw.measured.decisionFramesToInRange, 'legacy Jev decision frames'],
      [proof.metrics?.reachBoundary?.legacy?.policyQuestionCallsToInRangeEvidence, legacyRaw.measured.questionCallsToInRange, 'legacy typed question calls'],
      [proof.metrics?.policyAndModels?.legacy?.jevProviderModelCalls, legacyRaw.measured.jevProviderModelCalls, 'legacy Jev provider calls'],
      [proof.metrics?.policyAndModels?.legacy?.system2LlmCalls, legacyRaw.measured.system2ModelCalls, 'legacy System2 calls'],
      [proof.metrics?.policyAndModels?.legacy?.networkModelCalls, legacyRaw.measured.networkModelCalls, 'legacy network model calls'],
      [proof.metrics?.reachBoundary?.vtr?.verifiedTransitionCompletionCount, vtrRaw.measured.verifiedTransitionCompletionCount, 'VTR verified Transition completion'],
      [proof.metrics?.reachBoundary?.vtr?.mechanicalStepsPerTransition, vtrRaw.measured.mechanicalStepsPerTransition, 'VTR mechanical steps per Transition'],
      [proof.metrics?.reachBoundary?.vtr?.typedTerminalOutcome, vtrRaw.measured.typedTerminalOutcome, 'VTR typed terminal outcome'],
      [proof.metrics?.policyAndModels?.vtr?.legacyJevCallsPerTransition, vtrRaw.measured.legacyJevCallsPerTransition, 'VTR Jev policy calls'],
      [proof.metrics?.policyAndModels?.vtr?.system2CallsPerTransition, vtrRaw.measured.system2CallsPerTransition, 'VTR System2 calls'],
      [proof.metrics?.policyAndModels?.vtr?.deprecatedModelCallsPerMechanicalStep, vtrRaw.measured.modelCallsPerMechanicalStep, 'VTR model calls per mechanical step'],
      [proof.metrics?.policyAndModels?.vtr?.actualNetworkCalls, vtrRaw.configuration.networkModelCalls, 'VTR configured network model calls'],
      [proof.metrics?.policyAndModels?.vtr?.decisionFrameInvocationsPerTransition, vtrRaw.measured.decisionFrameInvocationsPerTransition, 'VTR Jev decision frames per Transition'],
      [proof.metrics?.policyAndModels?.vtr?.jevProviderEvaluateAttemptsIncludingRetriesPerTransition, vtrRaw.measured.jevProviderEvaluateAttemptsIncludingRetriesPerTransition, 'VTR Jev provider attempts per Transition'],
      [proof.metrics?.policyAndModels?.vtr?.jevProviderEvaluateAttemptsPerMechanicalStep, vtrRaw.measured.jevProviderEvaluateAttemptsPerMechanicalStep, 'VTR Jev provider attempts per mechanical step'],
      [proof.metrics?.policyAndModels?.vtr?.jevProvider, vtrRaw.configuration.effectiveJevProvider, 'VTR effective Jev provider'],
      [proof.metrics?.policyAndModels?.vtr?.jevModel, vtrRaw.configuration.effectiveJevModel, 'VTR effective Jev model'],
      [proof.metrics?.policyAndModels?.vtr?.jevPolicy, vtrRaw.configuration.BUDDY_POLICY, 'VTR configured Jev policy'],
      [proof.metrics?.policyAndModels?.vtr?.system2Provider, vtrRaw.configuration.effectiveSystem2Provider, 'VTR effective System2 provider'],
      [proof.metrics?.policyAndModels?.vtr?.system2Model, vtrRaw.configuration.effectiveSystem2Model, 'VTR effective System2 model'],
      [proof.metrics?.policyAndModels?.vtr?.system2Mode, vtrRaw.configuration.BUDDY_SYSTEM2, 'VTR configured System2 mode'],
      [proof.metrics?.authority?.vtr?.duplicateAuthority, vtrRaw.measured.duplicateAuthority, 'VTR duplicate-authority metric'],
      [proof.metrics?.authority?.vtr?.duplicateAuthorityConflicts, vtrRaw.measured.duplicateAuthorityConflicts, 'VTR authority conflict count'],
      [proof.metrics?.authority?.vtr?.concurrentLegacyActuations, vtrRaw.measured.concurrentLegacyActuations, 'VTR legacy actuation count'],
    ]
    for (const [reported, measured, label] of metricPairs) {
      if (reported !== measured) throw new Error(`${label} report differs from recomputed raw event evidence`)
    }
    const policy = proof.metrics?.policyAndModels?.vtr ?? {}
    if (policy.decisionFrameInvocationsPerTransition !== vtrRaw.measured.decisionFrameInvocationsPerTransition) {
      throw new Error('VTR decision-frame count does not match the provider capture decision journal')
    }
    for (const key of ['jevProviderEvaluateAttemptsIncludingRetriesPerTransition', 'jevProviderEvaluateAttemptsPerMechanicalStep']) {
      if (policy[key] !== vtrRaw.measured[key]) throw new Error(`VTR provider-attempt metric does not match captured raw evidence: ${key}`)
      if (policy[key] !== 0) throw new Error(`no-LLM VTR raw journals show provider activity: ${key}`)
    }
    if (policy.modelMetricsStatus === 'PASS' &&
        (policy.jevProviderEvaluateAttemptsIncludingRetriesPerTransition !== 0 || policy.actualNetworkCalls !== 0)) {
      throw new Error('VTR model metric PASS is not supported by the zero-provider-attempt capture')
    }
  } catch (error) {
    if (error instanceof EvidenceAssessmentError && error.status === CHECK_STATUS.INCOMPLETE) {
      return incomplete(error.message, error.details ?? {})
    }
    return fail(error.message)
  }
  if (proof.acceptanceEligible !== true || proof.acceptanceStatus !== 'ASSESSED_RAW_RUN_COMPARISON' || proof.evidenceClass !== 'run-scoped-raw-events') {
    return incomplete('comparison raw capture is valid but it is not marked acceptance-eligible')
  }
  if (proof.comparisonStatus !== 'PASS' || !aligned) return incomplete('comparison Mission, fixture, or environment is not fully aligned', { comparisonStatus: proof.comparisonStatus ?? null, alignment: proof.alignment ?? null })
  if (proof.noNetworkProfile?.status !== 'PASS') return fail('acceptance-eligible comparison lacks a PASS no-network profile', { status: proof.noNetworkProfile?.status ?? null })
  return { status: 'PASS', reason: 'source-bound raw comparison evidence independently validates both aligned run artifacts' }
}

/** Evidence gate for source-emitted mechanical SUCCESS boundaries. */
export function inspectOutcomeBoundaryEvidence({
  boundary, outcome, verifyRows, transitionId, contractHash, expectedIdentity, terminalRow, events, lastMechanicalRow,
}) {
  if (boundary === 'verified-terminal') return { status: 'PASS', reason: 'verified-terminal boundary; detailed VERIFY checks still apply' }
  if (boundary !== 'mechanical-step-outcome') return { status: 'FAIL', reason: `unsupported SUCCESS boundary ${String(boundary)}` }
  if (!Array.isArray(verifyRows) || verifyRows.length === 0) return { status: 'INCOMPLETE', reason: 'mechanical-step SUCCESS has no independent structured VERIFY evidence' }
  if (verifyRows.length !== 1) return { status: 'FAIL', reason: 'mechanical-step SUCCESS has ambiguous duplicate structured VERIFY evidence', count: verifyRows.length }
  const verify = verifyRows[0]
  const detail = verify?.detail?.verification ?? verify?.detail ?? {}
  const identity = detail.worldIdentity ?? detail.identity ?? detail
  const evidenceIds = Array.isArray(detail.evidenceIds) ? detail.evidenceIds : [detail.evidenceId].filter((value) => typeof value === 'string')
  const truth = detail.truth ?? detail.result
  const problems = []
  const missing = []
  const expected = {
    transitionId,
    contractHash,
    desiredPredicateIdentity: outcome?.desiredPredicateIdentity,
    runId: expectedIdentity?.runId,
    generationId: expectedIdentity?.generationId,
    sourceSha: expectedIdentity?.sourceSha,
  }
  for (const [key, wanted] of Object.entries(expected)) {
    const observed = detail[key] ?? identity[key]
    if (typeof wanted !== 'string' || wanted.length === 0 || observed === undefined || observed === null || observed === '') missing.push(key)
    else if (observed !== wanted) problems.push({ key, expected: wanted, observed })
  }
  const observedWorldKey = detail.worldKey ?? identity.worldKey ?? identity.worldIdentity?.worldKey
  const expectedWorldKey = expectedIdentity?.worldKey
  if (observedWorldKey === undefined || observedWorldKey === null) missing.push('worldKey')
  else if (observedWorldKey !== expectedWorldKey) problems.push({ key: 'worldKey', expected: expectedWorldKey, observed: observedWorldKey })
  const observedWorldEpoch = detail.worldEpoch ?? identity.worldEpoch ?? identity.worldIdentity?.worldEpoch
  if (observedWorldEpoch === undefined || observedWorldEpoch === null) missing.push('worldEpoch')
  else if (observedWorldEpoch !== expectedIdentity?.worldEpoch) problems.push({ key: 'worldEpoch', expected: expectedIdentity?.worldEpoch, observed: observedWorldEpoch })
  const observedDimension = dimCanonical(detail.dimension ?? identity.dimension ?? identity.worldIdentity?.dimension)
  const expectedDimension = dimCanonical(expectedIdentity?.dimension)
  if (observedDimension === null) missing.push('dimension')
  else if (observedDimension !== expectedDimension) problems.push({ key: 'dimension', expected: expectedDimension, observed: observedDimension })
  if (truth === undefined || truth === null) missing.push('truth')
  else if (truth !== true && truth !== 'TRUE') problems.push({ key: 'truth', expected: 'TRUE', observed: truth })
  if (detail.identityMatches !== true) {
    if (detail.identityMatches === undefined) missing.push('identityMatches')
    else problems.push({ key: 'identityMatches', expected: true, observed: detail.identityMatches })
  }
  if (detail.predicatesVerified !== true) {
    if (detail.predicatesVerified === undefined) missing.push('predicatesVerified')
    else problems.push({ key: 'predicatesVerified', expected: true, observed: detail.predicatesVerified })
  }
  if (!Array.isArray(outcome?.evidenceIds) || outcome.evidenceIds.length === 0) missing.push('terminal evidenceIds')
  else if (!evidenceIds.length) missing.push('VERIFY evidenceIds')
  else if (!outcome.evidenceIds.some((id) => evidenceIds.includes(id))) problems.push({ key: 'evidenceIds', expected: outcome.evidenceIds, observed: evidenceIds })
  const verifyAt = eventTimestamp(verify)
  const terminalAt = eventTimestamp(terminalRow)
  const observedAtMs = Number(detail.observedAtMs ?? detail.verifiedAtMs)
  const verifiedAtMs = Number(detail.verifiedAtMs)
  if (!Number.isFinite(outcome?.verifiedAtMs)) missing.push('terminal verifiedAtMs')
  if (!Number.isFinite(observedAtMs) || !Number.isFinite(verifiedAtMs)) missing.push('VERIFY timestamp')
  else if (observedAtMs !== verifiedAtMs || verifiedAtMs !== outcome.verifiedAtMs) problems.push({ key: 'verification timestamp', expected: outcome.verifiedAtMs, observedAtMs, verifiedAtMs })
  if (verifyAt === null || terminalAt === null) missing.push('VERIFY/terminal event timestamp')
  else if (verifyAt > terminalAt) problems.push({ key: 'event timestamp order', expected: 'VERIFY <= terminal', verifyAt, terminalAt })
  if (Array.isArray(events) && events.indexOf(verify) >= events.indexOf(terminalRow)) problems.push({ key: 'event journal order', expected: 'VERIFY before terminal outcome' })
  if (lastMechanicalRow && Array.isArray(events) && events.indexOf(verify) <= events.indexOf(lastMechanicalRow)) problems.push({ key: 'mechanical event order', expected: 'last mechanical outcome < VERIFY' })
  if (problems.length) return { status: 'FAIL', reason: 'mechanical-step SUCCESS is not backed by a matching deterministic VERIFY', problems, missing }
  if (missing.length) return { status: 'INCOMPLETE', reason: 'mechanical-step SUCCESS has incomplete VERIFY binding', missing }
  return { status: 'PASS', reason: 'mechanical-step SUCCESS is backed by an identity-bound TRUE VERIFY before the terminal' }
}

/** Checks same-owner live provenance without inventing a minimum traversal length. */
export function inspectLiveSkillOwnership({
  skillStartRows, selectedSkillCount, actionId, reservations, stepOutcomes, actuations,
  mechanicalSteps, commitIndex, skillStartIndex, firstReservationIndex, outcomeIndex, events,
}) {
  const fail = (reason, details = {}) => ({ status: 'FAIL', reason, ...details })
  const incomplete = (reason, details = {}) => ({ status: 'INCOMPLETE', reason, ...details })
  if (!Array.isArray(skillStartRows) || skillStartRows.length === 0) return incomplete('no raw executor SKILL_START event was archived')
  if (skillStartRows.length !== 1 || selectedSkillCount !== 1) return fail('one VTR-owned Transition must have exactly one VTR-selected SKILL_START', { starts: skillStartRows.length, selected: selectedSkillCount })
  const start = skillStartRows[0]
  if (!/\bselectedBy=vtr-transition(?:\s|$)/.test(String(start.message ?? ''))) return fail('SKILL_START was not selected by the VTR Transition controller')
  const startActionId = start.detail?.actionId
  if (typeof startActionId !== 'string' || startActionId.length === 0 || typeof actionId !== 'string' || actionId.length === 0) {
    return incomplete('SKILL_START and mechanical rows do not expose one Executor actionId', { startActionId: startActionId ?? null, actionId: actionId ?? null })
  }
  if (startActionId !== actionId) return fail('SKILL_START actionId differs from the Transition mechanical owner', { expectedActionId: actionId, observedActionId: startActionId })
  if (!Number.isSafeInteger(mechanicalSteps) || mechanicalSteps < 3) return incomplete('live Reach proof needs at least three mechanical legs under one Transition', { mechanicalSteps })
  if (!Array.isArray(reservations) || !Array.isArray(stepOutcomes) || !Array.isArray(actuations)) return incomplete('raw reservation, step outcome, or actuation rows are unavailable')
  if (reservations.length !== mechanicalSteps || stepOutcomes.length !== mechanicalSteps || actuations.length !== 1) {
    return fail('live mechanical legs do not all have one reservation, outcome, and unique Transition actuation', {
      mechanicalSteps, reservations: reservations.length, stepOutcomes: stepOutcomes.length, actuations: actuations.length,
    })
  }
  const owners = [...reservations, ...stepOutcomes, ...actuations].map((row) => row?.detail?.actionId)
  if (owners.some((owner) => owner !== actionId)) return fail('a live reservation, outcome, or actuation has a different action owner', { expectedActionId: actionId, observedActionIds: [...new Set(owners)] })
  if (![commitIndex, skillStartIndex, firstReservationIndex, outcomeIndex].every(Number.isInteger)) return incomplete('live event indices are unavailable for Transition/Skill/leg ordering')
  if (!(commitIndex < skillStartIndex && skillStartIndex < firstReservationIndex && skillStartIndex < outcomeIndex)) {
    return fail('SKILL_START must follow the Transition commit and precede mechanical legs and terminal outcome', { commitIndex, skillStartIndex, firstReservationIndex, outcomeIndex })
  }
  if (Array.isArray(events) && (events.indexOf(start) !== skillStartIndex || events.indexOf(start) >= outcomeIndex)) return fail('SKILL_START event does not occupy the expected unique journal position')
  return { status: 'PASS', actionId, mechanicalSteps, proof: 'all observed live legs share one VTR-selected Skill/action owner' }
}

/**
 * Proves that >=3 actual walkSkill walk_leg emissions correspond one-to-one to
 * successful, settled locomotion reservations under the same VTR action and
 * commitment. A failed/refused leg remains evidence but never contributes to the
 * minimum. The terminal leg is independently required to close with VERIFY/SUCCESS.
 */
export function inspectLiveWalkLegOwnership({
  walkLegRows, actionId, commitmentId, transitionId, contractHash,
  reservations, stepOutcomes, events,
}) {
  const fail = (reason, details = {}) => ({ status: 'FAIL', reason, ...details })
  const incomplete = (reason, details = {}) => ({ status: 'INCOMPLETE', reason, ...details })
  if (!Array.isArray(walkLegRows) || !Array.isArray(reservations) || !Array.isArray(stepOutcomes) || !Array.isArray(events)) {
    return incomplete('raw walk-leg/reservation/settlement evidence is unavailable')
  }
  if (walkLegRows.length === 0) return incomplete('no raw SKILL_STEP step=walk_leg rows were archived')
  if (typeof actionId !== 'string' || !actionId || typeof commitmentId !== 'string' || !commitmentId ||
      typeof transitionId !== 'string' || !transitionId || typeof contractHash !== 'string' || !contractHash) {
    return incomplete('walk-leg evidence lacks its action, commitment, Transition, or contract identity')
  }
  const reservationByLeg = new Map()
  const outcomeByStepId = new Map()
  for (const row of reservations) {
    const stepId = row?.detail?.stepId
    const match = typeof stepId === 'string' ? /:walk-leg-(\d+)$/u.exec(stepId) : null
    if (!match) continue
    const leg = Number(match[1])
    if (reservationByLeg.has(leg)) return fail('multiple mechanical reservations claim one walk-leg ordinal', { leg })
    reservationByLeg.set(leg, row)
  }
  for (const row of stepOutcomes) {
    const stepId = row?.detail?.stepId
    if (typeof stepId !== 'string') continue
    if (outcomeByStepId.has(stepId)) return fail('multiple mechanical settlements claim one stepId', { stepId })
    outcomeByStepId.set(stepId, row)
  }
  const seenLegs = new Set()
  const seenStepIds = new Set()
  const successful = []
  const excludedFailures = []
  for (const row of walkLegRows) {
    const message = String(row?.message ?? '')
    const detail = row?.detail ?? {}
    const messageLeg = Number(token(message, 'count'))
    const leg = detail.leg
    const action = eventActionId(row)
    const commitment = detail.commitmentId ?? token(message, 'commitmentId')
    if (!Number.isSafeInteger(messageLeg) || messageLeg < 1 || leg !== messageLeg) {
      return fail('raw walk_leg message count and structured leg ordinal disagree', { message: messageLeg, detail: leg })
    }
    if (seenLegs.has(leg)) return fail('duplicate raw walk_leg ordinal under one movement', { leg })
    seenLegs.add(leg)
    if (action !== actionId || commitment !== commitmentId || token(message, 'commitmentId') !== commitmentId ||
        token(message, 'authority') !== 'MECHANICAL_CONTINUATION') {
      return fail('raw walk_leg changed VTR action/commitment or is not a mechanical continuation', { leg, actionId: action, commitmentId: commitment, authority: token(message, 'authority') })
    }
    const reservation = reservationByLeg.get(leg)
    if (!reservation) return fail('raw walk_leg has no matching reserved VTR mechanical step', { leg })
    const stepId = reservation.detail.stepId
    if (seenStepIds.has(stepId)) return fail('multiple raw walk_leg rows claim one VTR stepId', { leg, stepId })
    seenStepIds.add(stepId)
    const outcomes = stepOutcomes.filter((candidate) => candidate?.detail?.stepId === stepId)
    if (outcomes.length !== 1) return fail('raw walk_leg does not have exactly one settled VTR step outcome', { leg, stepId, settlements: outcomes.length })
    const settled = outcomes[0]
    if (reservation.detail.transitionId !== transitionId || settled.detail.transitionId !== transitionId ||
        reservation.detail.contractHash !== contractHash || settled.detail.contractHash !== contractHash ||
        reservation.detail.actionId !== actionId || settled.detail.actionId !== actionId ||
        reservation.detail.effectKind !== 'locomotion' || reservation.detail.intentId !== settled.detail.intentId) {
      return fail('walk_leg settlement changed Transition, contract, effect, intent, or action ownership', { leg, stepId })
    }
    // Production formatWalkLeg currently carries actionId + commitmentId + count
    // (ordinal) but not the host-owned Transition/contract/step ids. When those
    // optional fields are present in a richer raw logger, require them to agree;
    // otherwise bind them through the unique VTR reservation and settlement rows.
    const explicitStepId = detail.stepId ?? token(message, 'stepId')
    const explicitTransitionId = detail.transitionId ?? token(message, 'transitionId')
    const explicitContractHash = detail.contractHash ?? token(message, 'contractHash')
    const explicitLeg = detail.ordinal ?? token(message, 'ordinal')
    if ((explicitStepId !== undefined && explicitStepId !== null && explicitStepId !== stepId) ||
        (explicitTransitionId !== undefined && explicitTransitionId !== null && explicitTransitionId !== transitionId) ||
        (explicitContractHash !== undefined && explicitContractHash !== null && explicitContractHash !== contractHash) ||
        (explicitLeg !== undefined && explicitLeg !== null && Number(explicitLeg) !== leg) ||
        (reservation.detail.commitmentId !== undefined && reservation.detail.commitmentId !== commitmentId) ||
        (settled.detail.commitmentId !== undefined && settled.detail.commitmentId !== commitmentId) ||
        (reservation.detail.leg !== undefined && reservation.detail.leg !== leg) ||
        (settled.detail.leg !== undefined && settled.detail.leg !== leg)) {
      return fail('raw walk_leg identity fields disagree with its unique VTR step reservation/settlement join', {
        leg, stepId, explicitStepId: explicitStepId ?? null,
        explicitTransitionId: explicitTransitionId ?? null,
        explicitContractHash: explicitContractHash ?? null,
      })
    }
    const start = events.indexOf(reservation)
    const end = events.indexOf(settled)
    const walk = events.indexOf(row)
    const nextReservation = reservationByLeg.get(leg + 1)
    const next = nextReservation ? events.indexOf(nextReservation) : Number.POSITIVE_INFINITY
    if (start < 0 || end < 0 || walk < 0 || !(start < end && end < walk && walk < next)) {
      return fail('walk_leg is not emitted after its mechanical settlement and before the next leg', { leg, stepId, indices: { reserve: start, outcome: end, walk, next } })
    }
    const failed = (detail.failure !== undefined && detail.failure !== null && detail.failure !== '') ||
      token(message, 'retry') !== null || /\bcontinuedAfter=/u.test(message)
    const goodOutcome = (settled.detail.status === 'active' && settled.detail.outcome === 'CONTINUING' && settled.detail.verified === false) ||
      (settled.detail.status === 'terminal' && settled.detail.outcome === 'SUCCESS' && settled.detail.verified === true)
    if (failed || !goodOutcome) {
      excludedFailures.push({ leg, stepId, failure: detail.failure ?? null, status: settled.detail.status, outcome: settled.detail.outcome })
      continue
    }
    successful.push({
      leg,
      ordinal: leg,
      stepId,
      actionId,
      commitmentId,
      transitionId,
      contractHash,
      status: settled.detail.status,
      correlation: 'raw SKILL_STEP actionId+commitmentId+ordinal joined to unique VTR reservation/outcome stepId+transitionId+contractHash',
    })
  }
  const ordinals = [...seenLegs].sort((left, right) => left - right)
  if (!isDeepStrictEqual(ordinals, Array.from({ length: ordinals.length }, (_unused, index) => index + 1))) {
    return fail('raw walk_leg rows are not distinct sequential mechanical ordinals', { observedLegs: ordinals })
  }
  if (successful.length < 3) return fail('fewer than three successful settled raw walk_leg rows remain after excluding failed/refused legs', { successfulWalkLegs: successful.length, excludedFailedWalkLegs: excludedFailures.length })
  return {
    status: 'PASS',
    successfulWalkLegs: successful.length,
    excludedFailedWalkLegs: excludedFailures.length,
    commitmentId,
    actionId,
    transitionId,
    contractHash,
    evidence: successful,
    excluded: excludedFailures,
  }
}

function logTimestamp(line) {
  const match = /^\[([^\]]+)\]/.exec(line)
  if (!match) return null
  const value = Date.parse(match[1])
  return Number.isFinite(value) ? value : null
}

function token(line, name) {
  return new RegExp(`(?:^|\\s)${name}=([^\\s]+)`).exec(line)?.[1] ?? null
}

function hostEventToken(line) {
  return /^\[[^\]]+\]\s+([A-Z][A-Z0-9_]*)\b/.exec(line)?.[1] ?? null
}

function firstMessageToken(message) {
  return typeof message === 'string' ? message.trim().split(/\s+/, 1)[0] ?? '' : ''
}

function transitionRowId(row) {
  return row?.detail?.transitionId ?? token(` ${String(row?.message ?? '')}`, 'transitionId') ?? token(` ${String(row?.message ?? '')}`, 'id') ?? null
}

function transitionRowContractHash(row) {
  return row?.detail?.contractHash ?? row?.detail?.outcome?.contractHash ?? token(` ${String(row?.message ?? '')}`, 'contractHash') ?? null
}

function transitionRowStepId(row, allowSingleStepFallback = false) {
  const detail = row?.detail ?? {}
  const direct = detail.stepId
  if (typeof direct === 'string' && direct.length > 0) return direct
  const intent = detail.intentId
  if (typeof intent === 'string' && intent.length > 0) return `intent:${intent}`
  const action = detail.actionId
  if (typeof action === 'string' && action.length > 0) return `action:${action}`
  if (!allowSingleStepFallback) return null
  const fallback = detail.candidate ?? token(` ${String(row?.message ?? '')}`, 'action') ?? token(` ${String(row?.message ?? '')}`, 'candidate')
  return typeof fallback === 'string' && fallback.length > 0 ? `action:${fallback}` : null
}

function assertUsageWithinBudget({ budget, usage }) {
  const problems = []
  const missing = []
  if (!budget || typeof budget !== 'object' || !usage || typeof usage !== 'object') {
    return { problems: [], missing: ['budget or usage object'] }
  }
  for (const [field, limitField] of [['mechanicalSteps', 'maxMechanicalSteps'], ['elapsedMs', 'maxElapsedMs']]) {
    if (!Number.isFinite(Number(usage[field])) || !Number.isFinite(Number(budget[limitField]))) {
      missing.push(`usage.${field}/budget.${limitField}`)
    } else if (Number(usage[field]) > Number(budget[limitField])) {
      problems.push({ field, used: Number(usage[field]), limit: Number(budget[limitField]) })
    }
  }
  for (const field of ['resources', 'risk', 'effects']) {
    if (!usage[field] || typeof usage[field] !== 'object' || Array.isArray(usage[field])) {
      missing.push(`usage.${field}`)
      continue
    }
  }
  for (const field of ['resources', 'risk']) {
    if (!budget[field] || typeof budget[field] !== 'object' || Array.isArray(budget[field])) {
      missing.push(`budget.${field}`)
      continue
    }
    for (const [name, amount] of Object.entries(usage[field] ?? {})) {
      const limit = budget[field][name]
      if (!Number.isFinite(Number(amount))) missing.push(`usage.${field}.${name}`)
      else if (!Number.isFinite(Number(limit))) problems.push({ field: `${field}.${name}`, used: Number(amount), limit: limit ?? null, reason: 'used value has no finite declared limit' })
      else if (Number(amount) > Number(limit)) problems.push({ field: `${field}.${name}`, used: Number(amount), limit: Number(limit) })
    }
  }
  const effects = Array.isArray(budget.admissibleEffects) ? budget.admissibleEffects : null
  if (!effects) missing.push('budget.admissibleEffects')
  else {
    const effectLimits = new Map(effects.map((entry) => [entry?.kind, entry?.maxUses]))
    for (const [name, amount] of Object.entries(usage.effects ?? {})) {
      const limit = effectLimits.get(name)
      if (!Number.isFinite(Number(amount))) missing.push(`usage.effects.${name}`)
      else if (!effectLimits.has(name)) problems.push({ field: `effects.${name}`, used: Number(amount), reason: 'effect is not admissible' })
      else if (limit !== null && (!Number.isFinite(Number(limit)) || Number(amount) > Number(limit))) {
        problems.push({ field: `effects.${name}`, used: Number(amount), limit: limit ?? null })
      }
    }
  }
  return { problems, missing }
}

function closeNumber(a, b, tolerance = 0.02) {
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance
}

async function parseLevelDat(path) {
  const compressed = readFileSync(path)
  const { parsed } = await parseNbt(gunzipSync(compressed), 'big')
  const data = parsed?.value?.Data?.value ?? parsed?.value?.Data ?? null
  if (!data) throw new Error('level.dat has no Data compound')
  const settings = nbtValue(data.WorldGenSettings)
  const seed = nbtLongToBigInt(nbtValue(settings?.seed)) ?? nbtLongToBigInt(nbtValue(data.RandomSeed))
  const rules = nbtValue(data.game_rules) ?? {}
  const readRule = (key) => nbtValue(rules[`minecraft:${key}`])
  return {
    levelName: nbtValue(data.LevelName) ?? null,
    dataVersion: nbtValue(data.DataVersion) ?? null,
    seed: seed === null ? null : seed.toString(),
    difficulty: nbtValue(data.Difficulty) ?? null,
    gameType: nbtValue(data.GameType) ?? null,
    hardcore: nbtValue(data.hardcore) ?? null,
    gameRules: {
      keepInventory: readRule('keep_inventory') ?? null,
      spawnMobs: readRule('spawn_mobs') ?? null,
      advanceTime: readRule('advance_time') ?? null,
    },
  }
}

async function parsePlayerDat(path) {
  const { parsed } = await parseNbt(gunzipSync(readFileSync(path)), 'big')
  const value = parsed?.value
  if (!value || typeof value !== 'object') throw new Error('playerdata has no compound root')
  const pos = nbtValue(nbtValue(value.Pos))
  const rawInventory = nbtValue(value.Inventory)
  const stacks = Array.isArray(rawInventory) ? rawInventory : rawInventory?.value
  const inventory = {}
  let inventoryDecodable = Array.isArray(stacks)
  if (Array.isArray(stacks)) {
    for (const rawStack of stacks) {
      const stack = rawStack?.value ?? rawStack
      const rawId = nbtValue(stack?.id)
      const rawCount = nbtValue(stack?.count ?? stack?.Count)
      if (typeof rawId !== 'string' || !Number.isFinite(Number(rawCount))) {
        inventoryDecodable = false
        continue
      }
      const id = rawId.startsWith('minecraft:') ? rawId.slice('minecraft:'.length) : rawId
      inventory[id] = (inventory[id] ?? 0) + Number(rawCount)
    }
  }
  return {
    uuid: typeof nbtValue(value.UUID) === 'string' ? nbtValue(value.UUID) : nbtIntArrayToUuid(nbtValue(value.UUID)),
    dimension: nbtValue(value.Dimension) ?? null,
    position: Array.isArray(pos) ? pos.map(Number) : null,
    health: nbtValue(value.Health) ?? null,
    air: nbtValue(value.Air) ?? null,
    inventory,
    inventoryDecodable,
  }
}

function normalizedBlockName(value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  return value.trim().toLowerCase().replace(/^minecraft:/u, '')
}

/** Resolve the MCA region that contains an integer world block coordinate. */
export function witnessRegionRelativePath(target) {
  if (!target || !Number.isSafeInteger(target.x) || !Number.isSafeInteger(target.y) || !Number.isSafeInteger(target.z)) return null
  const chunkX = Math.floor(target.x / 16)
  const chunkZ = Math.floor(target.z / 16)
  const regionX = Math.floor(chunkX / 32)
  const regionZ = Math.floor(chunkZ / 32)
  return `server/world/region/r.${regionX}.${regionZ}.mca`
}

async function readBlockName(regionPath, x, y, z) {
  const chunkX = Math.floor(x / 16)
  const chunkZ = Math.floor(z / 16)
  const regionX = Math.floor(chunkX / 32)
  const regionZ = Math.floor(chunkZ / 32)
  const expectedRegionName = `r.${regionX}.${regionZ}.mca`
  if (basename(regionPath) !== expectedRegionName) {
    throw new Error(`region file ${basename(regionPath)} does not contain x/z ${x},${z}; expected ${expectedRegionName}`)
  }
  const bytes = readFileSync(regionPath)
  const chunkIndex = (chunkX & 31) + (chunkZ & 31) * 32
  const location = bytes.readUIntBE(chunkIndex * 4, 3)
  const sectors = bytes.readUInt8(chunkIndex * 4 + 3)
  if (location === 0 || sectors === 0) return null
  const start = location * 4096
  const length = bytes.readUInt32BE(start)
  const compression = bytes.readUInt8(start + 4)
  const payload = bytes.subarray(start + 5, start + 4 + length)
  const raw = compression === 1 ? gunzipSync(payload) : compression === 2 ? inflateSync(payload) : compression === 3 ? payload : null
  if (raw === null) throw new Error(`unsupported MCA chunk compression id ${compression}`)
  const { parsed } = await parseNbt(raw, 'big')
  const level = parsed?.value?.Level?.value ?? parsed?.value
  const sections = level?.sections?.value?.value ?? level?.sections?.value ?? []
  const sectionY = Math.floor(y / 16)
  const section = sections.find((candidate) => Number(nbtValue(candidate?.Y)) === sectionY)
  if (!section) return null
  const blockStates = nbtValue(section.block_states)
  const paletteContainer = nbtValue(blockStates?.palette)
  const palette = paletteContainer?.value ?? paletteContainer
  if (!Array.isArray(palette) || palette.length === 0) return null
  const names = palette.map((entry) => {
    const name = nbtValue(entry?.Name)
    return typeof name === 'string' ? name.replace(/^minecraft:/, '') : '?'
  })
  if (names.length === 1) return names[0]
  const packed = nbtValue(blockStates?.data)
  if (!Array.isArray(packed) && !ArrayBuffer.isView(packed)) return null
  const bits = Math.max(4, Math.ceil(Math.log2(Math.max(2, names.length))))
  const perLong = Math.floor(64 / bits)
  const localX = ((x % 16) + 16) % 16
  const localY = ((y % 16) + 16) % 16
  const localZ = ((z % 16) + 16) % 16
  const index = (localY * 16 + localZ) * 16 + localX
  const longIndex = Math.floor(index / perLong)
  const shift = BigInt((index % perLong) * bits)
  if (packed[longIndex] === undefined) return null
  const word = BigInt.asUintN(64, BigInt(packed[longIndex]))
  const mask = (1n << BigInt(bits)) - 1n
  return names[Number((word >> shift) & mask)] ?? null
}

/** Independently read the committed witness and its support from its MCA region. */
export async function inspectWitnessPlane(archive, archivedFiles, target) {
  const relativePath = witnessRegionRelativePath(target)
  if (relativePath === null) return { status: 'INCOMPLETE', relativePath: null, reason: 'committed witness does not contain integer block coordinates' }
  if (!archivedFiles.includes(relativePath)) return { status: 'INCOMPLETE', relativePath, reason: 'coordinate-derived region file is absent' }
  try {
    const path = join(archive, relativePath)
    return {
      status: 'READ',
      relativePath,
      witnessBlock: await readBlockName(path, target.x, target.y, target.z),
      supportBlock: await readBlockName(path, target.x, target.y - 1, target.z),
    }
  } catch (error) {
    return { status: 'INCOMPLETE', relativePath, reason: `cannot inspect MCA witness/support facts: ${error.message}` }
  }
}

function blockFromSetblockCommand(command) {
  if (typeof command !== 'string') return null
  const match = /(?:^|\s)setblock\s+\S+\s+\S+\s+\S+\s+([a-z0-9_.:-]+)/iu.exec(command)
  return match ? normalizedBlockName(match[1]) : null
}

/**
 * Read the captured server response from a fixture-command JSONL row.
 * Current collectors write `serverOutput`; older archives used `result`.
 * Keep the original string byte-for-byte because this is source evidence.
 */
function fixtureCommandOutput(row) {
  if (typeof row?.serverOutput === 'string') return row.serverOutput
  if (typeof row?.result === 'string') return row.result
  return ''
}

/**
 * The pinned spawn-relative fixture contract, independently restated here so the
 * validator never trusts the runner's own constants. The committed journal must
 * contain exactly one absolute `fill` and one absolute `setblock` v2 row issued
 * while the resident is frozen before GENERATION_READY; relative (`~`),
 * selector (`@`), `execute`, or `replace` command forms are rejected outright.
 */
const REACH_FIXTURE_CONTRACT = Object.freeze({
  commandSchema: 'vtr-reach-fixture-command/v2',
  anchorSchema: 'vtr-reach-fixture-anchor/v1',
  anchorSnapshotSchema: 'vtr-reach-initial-snapshot/v1',
  anchorSnapshotPath: 'runner/fixture-anchor-snapshot.json',
  anchorPositionSource: 'runner/fixture-anchor-snapshot.json.initialPosition',
  phase: 'resident-frozen-before-generation-ready',
  coordinateRule: 'floor(position + integer offset)',
  offsets: {
    fillFrom: { x: 1, y: -1, z: -3 },
    fillTo: { x: 24, y: -1, z: 3 },
    witness: { x: 16, y: 0, z: 2 },
  },
  fillBlock: 'minecraft:stone',
})

const FIXTURE_LEGACY_OR_RELATIVE_RE = /[~@]|\bexecute\b|\breplace\b/iu

function fixtureDerivedBlock(position, offset) {
  const value = {
    x: Math.floor(position.x + offset.x),
    y: Math.floor(position.y + offset.y),
    z: Math.floor(position.z + offset.z),
  }
  return Object.values(value).every(Number.isSafeInteger) ? value : null
}

function fixtureCommandBindingProblems(row, { sourceSha, run, serverStart }) {
  const problems = []
  const requireField = (field, expected, { nullExpected = false } = {}) => {
    const observed = row?.[field]
    if (nullExpected ? observed !== null : observed !== expected) problems.push({ field, expected, observed: observed ?? null })
  }
  requireField('schema', REACH_FIXTURE_CONTRACT.commandSchema)
  requireField('sourceSha', sourceSha)
  requireField('runId', run?.runId)
  requireField('worldKey', run?.worldKey)
  requireField('generationId', null, { nullExpected: true })
  requireField('leaseId', null, { nullExpected: true })
  requireField('phase', REACH_FIXTURE_CONTRACT.phase)
  requireField('serverId', serverStart?.serverId)
  requireField('serverPid', serverStart?.pid)
  requireField('responsePid', serverStart?.pid)
  if (typeof row?.command !== 'string' || row.command === '') problems.push({ field: 'command', expected: 'absolute non-empty command', observed: row?.command ?? null })
  else if (sha256(Buffer.from(row.command, 'utf8')) !== row.commandSha256) problems.push({ field: 'commandSha256', expected: 'sha256(command)', observed: row.commandSha256 ?? null })
  if (!Number.isSafeInteger(row?.responseSequence) || row.responseSequence < 1) problems.push({ field: 'responseSequence', expected: 'positive integer', observed: row?.responseSequence ?? null })
  const times = ['issuedAt', 'stdinAcknowledgedAt', 'observedAt'].map((key) => Date.parse(row?.[key] ?? ''))
  const startedAt = Date.parse(run?.startedAt ?? '')
  const readyAt = Date.parse(run?.generationReadyAt ?? '')
  if (![...times, startedAt, readyAt].every(Number.isFinite) ||
      !(startedAt <= times[0] && times[0] <= times[1] && times[1] <= times[2] && times[2] <= readyAt)) {
    problems.push({ field: 'commandWindow', expected: `${run?.startedAt ?? '?'} <= issuedAt <= stdinAcknowledgedAt <= observedAt <= ${run?.generationReadyAt ?? '?'}`, observed: { issuedAt: row?.issuedAt ?? null, stdinAcknowledgedAt: row?.stdinAcknowledgedAt ?? null, observedAt: row?.observedAt ?? null } })
  }
  return problems
}

function fixtureAnchorProblems(anchor, { sourceSha, run, anchorSha256, snapshotPosition }) {
  if (!anchor || typeof anchor !== 'object' || Array.isArray(anchor)) return [{ field: 'fixtureAnchor', expected: 'bound anchor object', observed: null }]
  const problems = []
  const requireField = (field, expected, { nullExpected = false } = {}) => {
    const observed = anchor[field]
    if (nullExpected ? observed !== null : observed !== expected) problems.push({ field: `fixtureAnchor.${field}`, expected, observed: observed ?? null })
  }
  requireField('schema', REACH_FIXTURE_CONTRACT.anchorSchema)
  requireField('sourceSha', sourceSha)
  requireField('runId', run?.runId)
  requireField('generationId', null, { nullExpected: true })
  requireField('leaseId', null, { nullExpected: true })
  requireField('worldKey', run?.worldKey)
  requireField('worldEpoch', run?.worldEpoch)
  requireField('snapshotPath', REACH_FIXTURE_CONTRACT.anchorSnapshotPath)
  requireField('snapshotSha256', anchorSha256)
  requireField('positionSource', REACH_FIXTURE_CONTRACT.anchorPositionSource)
  requireField('coordinateRule', REACH_FIXTURE_CONTRACT.coordinateRule)
  if (!isDeepStrictEqual(anchor.offsets, REACH_FIXTURE_CONTRACT.offsets)) problems.push({ field: 'fixtureAnchor.offsets', expected: REACH_FIXTURE_CONTRACT.offsets, observed: anchor.offsets ?? null })
  if (!samePosition(anchor.initialPosition, snapshotPosition)) problems.push({ field: 'fixtureAnchor.initialPosition', expected: snapshotPosition, observed: anchor.initialPosition ?? null })
  return problems
}

function fixtureAnchorDocumentProblems(anchor, { sourceSha, run, readyAt }) {
  if (!anchor || typeof anchor !== 'object' || Array.isArray(anchor)) return [{ field: 'anchorSnapshot', expected: 'parsed anchor snapshot', observed: null }]
  const problems = []
  const requireField = (field, expected, { nullExpected = false } = {}) => {
    const observed = anchor[field]
    if (nullExpected ? observed !== null : observed !== expected) problems.push({ field: `anchorSnapshot.${field}`, expected, observed: observed ?? null })
  }
  requireField('schema', REACH_FIXTURE_CONTRACT.anchorSnapshotSchema)
  requireField('sourceSha', sourceSha)
  requireField('bootSourceSha', sourceSha)
  requireField('runId', run?.runId)
  requireField('generationId', null, { nullExpected: true })
  requireField('worldKey', run?.worldKey)
  requireField('worldEpoch', run?.worldEpoch)
  if (positionVector(anchor.initialPosition) === null) problems.push({ field: 'anchorSnapshot.initialPosition', expected: 'finite x/y/z', observed: anchor.initialPosition ?? null })
  const capturedAt = Date.parse(anchor.capturedAt ?? '')
  if (!Number.isFinite(capturedAt) || (Number.isFinite(readyAt) && capturedAt > readyAt)) {
    problems.push({ field: 'anchorSnapshot.capturedAt', expected: `finite and <= ${run?.generationReadyAt ?? '?'}`, observed: anchor.capturedAt ?? null })
  }
  return problems
}

function fixtureReceiptProblems(row, receipt, { sourceSha, run, serverStart }) {
  const problems = []
  const requireField = (field, expected, { nullExpected = false } = {}) => {
    const observed = receipt?.[field]
    if (nullExpected ? observed !== null : observed !== expected) problems.push({ field: `stdout.${field}`, expected, observed: observed ?? null })
  }
  requireField('schema', 'vtr-server-stdout-observation/v1')
  requireField('sourceSha', sourceSha)
  requireField('runId', run?.runId)
  requireField('generationId', null, { nullExpected: true })
  requireField('worldKey', run?.worldKey)
  requireField('serverId', serverStart?.serverId)
  requireField('serverPid', serverStart?.pid)
  requireField('port', serverStart?.port)
  requireField('levelName', serverStart?.levelName)
  requireField('streamSource', 'spawned-server-stdout')
  requireField('sequence', row?.responseSequence)
  requireField('line', row?.serverOutput)
  requireField('receivedAt', row?.observedAt)
  if (typeof row?.serverOutput === 'string' && sha256(Buffer.from(row.serverOutput, 'utf8')) !== receipt?.lineSha256) {
    problems.push({ field: 'stdout.lineSha256', expected: 'sha256(serverOutput)', observed: receipt?.lineSha256 ?? null })
  }
  return problems
}

/**
 * Verify the run-scoped fixture evidence: exactly one absolute v2 fill and one
 * absolute v2 setblock anchored to the preserved frozen spawn snapshot, with
 * run/world/generation-window identity and unique spawned-stdout receipts.
 */
export function inspectFixtureWitnessSetup({
  fixtureCommands, missionItem, desiredPredicate, witness,
  sourceSha, run, serverStart, anchor, anchorBytes, initialSnapshot, stdoutEvents,
}) {
  const missionBlock = normalizedBlockName(missionItem)
  const predicateItem = normalizedBlockName(desiredPredicate?.proposition?.item)
  const rawSources = desiredPredicate?.proposition?.sourceNames
  const sourceNames = Array.isArray(rawSources) ? [...new Set(rawSources.map(normalizedBlockName).filter(Boolean))] : []
  const committedSources = sourceNames.length > 0 ? sourceNames : [predicateItem].filter(Boolean)
  const detail = { missionBlock, predicateItem, committedSources }
  const incomplete = (reason, extra = {}) => ({ status: 'INCOMPLETE', reason, ...detail, ...extra })
  const fail = (reason, extra = {}) => ({ status: 'FAIL', reason, ...detail, ...extra })

  if (missionBlock === null || predicateItem === null || committedSources.length === 0) {
    return incomplete('Mission item or committed Reach source names are absent')
  }
  if (missionBlock !== predicateItem) return fail('Mission item and committed Reach predicate item disagree')
  if (!witness || !Number.isSafeInteger(witness.x) || !Number.isSafeInteger(witness.y) || !Number.isSafeInteger(witness.z)) {
    return incomplete('committed witness has no integer block coordinates')
  }

  const commands = Array.isArray(fixtureCommands) ? fixtureCommands : []
  const nonV2 = commands.filter((row) => row?.schema !== REACH_FIXTURE_CONTRACT.commandSchema)
  const legacyOrRelative = commands.filter((row) => FIXTURE_LEGACY_OR_RELATIVE_RE.test(String(row?.command ?? '')))
  const fills = commands.filter((row) => row?.schema === REACH_FIXTURE_CONTRACT.commandSchema && row?.kind === 'fill')
  const setblocks = commands.filter((row) => row?.schema === REACH_FIXTURE_CONTRACT.commandSchema && row?.kind === 'setblock')
  const foreignKinds = commands.filter((row) => row?.schema === REACH_FIXTURE_CONTRACT.commandSchema && !['fill', 'setblock'].includes(row?.kind))
  if (commands.length === 0) return incomplete('fixture command journal is empty')
  if (nonV2.length > 0 || foreignKinds.length > 0 || legacyOrRelative.length > 0) {
    return fail('fixture journal contains legacy, relative, selector, or foreign-schema commands', {
      nonV2Rows: nonV2.length, foreignKindRows: foreignKinds.length, legacyOrRelativeRows: legacyOrRelative.length,
      offending: [...nonV2, ...foreignKinds, ...legacyOrRelative].map((row) => ({ schema: row?.schema ?? null, kind: row?.kind ?? null, commandSha256: row?.commandSha256 ?? null })),
    })
  }
  if (fills.length !== 1 || setblocks.length !== 1 || commands.length !== 2) {
    return fail('fixture journal must contain exactly one v2 fill and one v2 setblock', { fillRows: fills.length, setblockRows: setblocks.length, totalRows: commands.length })
  }

  const anchorSha256 = Buffer.isBuffer(anchorBytes) ? sha256(anchorBytes) : null
  const readyAt = Date.parse(run?.generationReadyAt ?? '')
  const contextProblems = []
  if (typeof sourceSha !== 'string' || !SHA_RE.test(sourceSha)) contextProblems.push('probe source commit is absent or malformed')
  if (typeof run?.runId !== 'string' || !RUN_ID_RE.test(run.runId)) contextProblems.push('probe runId is absent or malformed')
  if (typeof run?.worldKey !== 'string' || parseWorldKey(run.worldKey) === null) contextProblems.push('probe run worldKey is absent or malformed')
  if (typeof run?.generationId !== 'string' || run.generationId.length === 0) contextProblems.push('probe generationId is absent')
  if (!Number.isFinite(Date.parse(run?.startedAt ?? '')) || !Number.isFinite(readyAt)) contextProblems.push('probe run startedAt/generationReadyAt window is absent or malformed')
  if (typeof serverStart?.pid !== 'number' || !Number.isSafeInteger(serverStart.pid) || typeof serverStart?.serverId !== 'string' ||
      !Number.isSafeInteger(serverStart?.port) || typeof serverStart?.levelName !== 'string' || !Number.isFinite(Date.parse(serverStart?.spawnedAt ?? ''))) {
    contextProblems.push('server-start identity fields are absent or malformed')
  }
  if (anchor === null || anchor === undefined || !Buffer.isBuffer(anchorBytes)) contextProblems.push('frozen fixture anchor snapshot is absent')
  if (initialSnapshot === null || initialSnapshot === undefined) contextProblems.push('runner initial snapshot is absent')
  if (!Array.isArray(stdoutEvents)) contextProblems.push('spawned-stdout event journal is absent')
  if (contextProblems.length > 0) return incomplete('run-scoped fixture binding inputs are unavailable', { problems: contextProblems })

  const anchorDocProblems = fixtureAnchorDocumentProblems(anchor, { sourceSha, run, readyAt })
  if (anchorDocProblems.length > 0) return fail('preserved frozen anchor snapshot contradicts run identity', { problems: anchorDocProblems })
  const spawnPosition = positionVector(anchor.initialPosition)
  if (!samePosition(initialSnapshot?.initialPosition, spawnPosition)) {
    return fail('final initial snapshot does not retain the exact fixture anchor position', { anchorPosition: spawnPosition, initialSnapshotPosition: initialSnapshot?.initialPosition ?? null })
  }
  if (parseWorldKey(run.worldKey).serverId !== serverStart.serverId) {
    return fail('server identity disagrees with the run world key', { runServerId: parseWorldKey(run.worldKey).serverId, serverStartServerId: serverStart.serverId })
  }

  const expected = {
    fillFrom: fixtureDerivedBlock(spawnPosition, REACH_FIXTURE_CONTRACT.offsets.fillFrom),
    fillTo: fixtureDerivedBlock(spawnPosition, REACH_FIXTURE_CONTRACT.offsets.fillTo),
    witness: fixtureDerivedBlock(spawnPosition, REACH_FIXTURE_CONTRACT.offsets.witness),
  }
  if (expected.fillFrom === null || expected.fillTo === null || expected.witness === null) {
    return fail('pinned fixture offsets produce unsafe block coordinates from the anchor position', { spawnPosition })
  }
  const expectedFillCount = (Math.abs(expected.fillTo.x - expected.fillFrom.x) + 1)
    * (Math.abs(expected.fillTo.y - expected.fillFrom.y) + 1)
    * (Math.abs(expected.fillTo.z - expected.fillFrom.z) + 1)
  const expectedFillCommand = `fill ${expected.fillFrom.x} ${expected.fillFrom.y} ${expected.fillFrom.z} ${expected.fillTo.x} ${expected.fillTo.y} ${expected.fillTo.z} ${REACH_FIXTURE_CONTRACT.fillBlock}`
  const expectedSetblockRe = /^setblock\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(\S+)$/iu
  if (!samePosition(expected.witness, witness)) {
    return fail('committed witness differs from the pinned fixture witness derived from the frozen anchor', { committedWitness: witness, expectedWitness: expected.witness, spawnPosition })
  }

  const fillRow = fills[0]
  const setblockRow = setblocks[0]
  const context = { sourceSha, run, serverStart }
  const problems = []
  for (const [label, row] of [['fill', fillRow], ['setblock', setblockRow]]) {
    for (const problem of fixtureCommandBindingProblems(row, context)) problems.push({ row: label, ...problem })
    for (const problem of fixtureAnchorProblems(row?.fixtureAnchor, { ...context, anchorSha256, snapshotPosition: spawnPosition })) problems.push({ row: label, ...problem })
    const receipts = stdoutEvents.filter((entry) => entry?.sequence === row?.responseSequence)
    if (receipts.length !== 1) {
      problems.push({ row: label, field: 'stdout.sequence', expected: 'exactly one matching spawned-stdout receipt', observed: receipts.length })
    } else {
      for (const problem of fixtureReceiptProblems(row, receipts[0], context)) problems.push({ row: label, ...problem })
    }
  }
  if (!isDeepStrictEqual(fillRow.fixtureAnchor, setblockRow.fixtureAnchor)) {
    problems.push({ field: 'fixtureAnchor', expected: 'fill and setblock rows share one identical anchor binding', observed: 'rows differ' })
  }
  if (fillRow.command !== expectedFillCommand) {
    problems.push({ row: 'fill', field: 'command', expected: expectedFillCommand, observed: fillRow.command ?? null })
  }
  const fillResponse = /\bSuccessfully filled\s+(\d+)\s+block(?:s|\(s\))?\b/iu.exec(String(fillRow.serverOutput ?? ''))
  if (fillResponse === null || Number(fillResponse[1]) !== expectedFillCount) {
    problems.push({ row: 'fill', field: 'serverOutput', expected: `Successfully filled ${expectedFillCount} blocks`, observed: fillRow.serverOutput ?? null })
  }
  const setblockMatch = expectedSetblockRe.exec(String(setblockRow.command ?? ''))
  const setblockPosition = setblockMatch === null ? null : { x: Number(setblockMatch[1]), y: Number(setblockMatch[2]), z: Number(setblockMatch[3]) }
  const setblockBlock = setblockMatch === null ? null : normalizedBlockName(setblockMatch[4])
  if (setblockPosition === null || !samePosition(setblockPosition, expected.witness)) {
    problems.push({ row: 'setblock', field: 'command', expected: `setblock ${expected.witness.x} ${expected.witness.y} ${expected.witness.z} <committed-source>`, observed: setblockRow.command ?? null })
  } else if (setblockBlock === null || !committedSources.includes(setblockBlock)) {
    problems.push({ row: 'setblock', field: 'command', expected: `block in committed sources ${JSON.stringify(committedSources)}`, observed: setblockMatch?.[4] ?? null })
  }
  const setblockResponse = /\bChanged(?: the)? block at\s+(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\b/iu.exec(String(setblockRow.serverOutput ?? ''))
  const responsePosition = setblockResponse === null ? null : { x: Number(setblockResponse[1]), y: Number(setblockResponse[2]), z: Number(setblockResponse[3]) }
  if (responsePosition === null || !samePosition(responsePosition, expected.witness)) {
    problems.push({ row: 'setblock', field: 'serverOutput', expected: `Changed the block at ${expected.witness.x}, ${expected.witness.y}, ${expected.witness.z}`, observed: setblockRow.serverOutput ?? null })
  }
  if (problems.length > 0) return fail('v2 fixture command rows contradict run identity, anchor, window, command, or receipt evidence', { problems })

  return {
    status: 'PASS',
    ...detail,
    observedBlock: setblockBlock,
    command: setblockRow.command,
    result: setblockRow.serverOutput,
    fillCommand: fillRow.command,
    fillResult: fillRow.serverOutput,
    fillBlocks: expectedFillCount,
    witness,
    anchor: { path: REACH_FIXTURE_CONTRACT.anchorSnapshotPath, sha256: anchorSha256, position: spawnPosition },
    receipts: { fill: fillRow.responseSequence, setblock: setblockRow.responseSequence },
  }
}

function inventoriesEqual(left, right) {
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  const all = new Set([...Object.keys(left), ...Object.keys(right)])
  return [...all].every((key) => Number(left[key] ?? 0) === Number(right[key] ?? 0))
}

function parseManifest(text) {
  const entries = new Map()
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue
    const match = line.match(/^([0-9a-f]{64})\s+\*?(.+)$/i)
    if (!match) throw new Error(`SHA256SUMS:${index + 1}: expected '<sha256>  <relative-path>'`)
    const path = match[2].replaceAll('\\', '/').replace(/^\.\//, '')
    if (entries.has(path)) throw new Error(`SHA256SUMS:${index + 1}: duplicate path entry ${path}`)
    entries.set(path, match[1].toLowerCase())
  }
  return entries
}

function gitOutput(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function gitCommitExists(repo, commit) {
  try {
    execFileSync('git', ['-C', repo, 'cat-file', '-e', `${commit}^{commit}`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export function summarizeValidationStatuses(checks) {
  const all = Array.isArray(checks) ? checks : []
  const probeChecks = all.filter((check) => !String(check?.id ?? '').startsWith('milestone:'))
  const statusFor = (entries) => entries.some((check) => check.status === CHECK_STATUS.FAIL)
    ? 'FAIL'
    : entries.some((check) => check.status === CHECK_STATUS.INCOMPLETE) ? 'INCOMPLETE' : 'PASS'
  const counts = Object.fromEntries(Object.values(CHECK_STATUS).map((value) => [
    value.toLowerCase(), all.filter((check) => check.status === value).length,
  ]))
  const overallStatus = statusFor(all)
  const probeStatus = statusFor(probeChecks)
  return {
    status: probeStatus,
    probeStatus,
    migrationMilestoneStatus: overallStatus,
    overallStatus,
    counts,
  }
}

export function validationExitCode(report) {
  return EXIT[report?.status] ?? EXIT.FAIL
}

export function inspectNoDoubleAuthorityFixtureProof({ report, reportBytes, testSourceBytes, expectedSourceSha, binding }) {
  const incomplete = (reason) => ({ status: 'INCOMPLETE', reason })
  const fail = (reason) => ({ status: 'FAIL', reason })
  if (!report || typeof report !== 'object' || Array.isArray(report) || !Buffer.isBuffer(reportBytes) || !Buffer.isBuffer(testSourceBytes)) {
    return incomplete('fixture proof report or exact test source bytes are missing')
  }
  const reportDigest = sha256(reportBytes)
  const sourceDigest = sha256(testSourceBytes)
  if (!binding || binding.schema !== 'vtr-reach-no-double-authority-fixture/v1' || binding.status !== 'PASS' ||
      binding.sourceSha !== expectedSourceSha || binding.rawReport?.path !== 'proofs/no-double-authority-fixture.json' ||
      binding.rawReport?.bytes !== reportBytes.length || binding.rawReport?.sha256?.toLowerCase?.() !== reportDigest ||
      binding.testSource?.path !== 'runner/fixtures/test-vtr-reach-executor-dispatch-authority.mts' ||
      binding.testSource?.bytes !== testSourceBytes.length || binding.testSource?.sha256?.toLowerCase?.() !== sourceDigest) {
    return fail('probe fixture-proof binding does not re-hash to the preserved report/source bytes and exact run identity')
  }
  if (report.schema !== 'vtr-reach-no-double-authority-fixture/v1' || report.result !== 'PASS' ||
      report.sourceSha?.toLowerCase?.() !== expectedSourceSha ||
      report.test?.path !== 'packages/jev-agent/test-vtr-reach-executor-dispatch-authority.mts' ||
      report.test?.name !== 'production Reach dispatch and legacy Executor claim cannot overlap body authority' ||
      report.test?.sourceSha256?.toLowerCase?.() !== sourceDigest) {
    return fail('fixture report does not bind the required exact-source legacy claim refusal test')
  }
  const fixture = report.fixture
  const required = ['legacyClaimRejected', 'legacyClaimError', 'vtrOwnerRetained', 'transitionId', 'contractHash',
    'pathfinderStartsBeforeLegacyClaim', 'pathfinderStartsAfterLegacyClaim', 'pathfinderStartDelta', 'authorityConflictCount', 'maxConcurrentActions']
  const missing = required.filter((key) => fixture?.[key] === undefined || fixture?.[key] === null)
  if (missing.length) return incomplete(`fixture report omits observed fields: ${missing.join(', ')}`)
  const before = fixture.pathfinderStartsBeforeLegacyClaim
  const after = fixture.pathfinderStartsAfterLegacyClaim
  if (fixture.legacyClaimRejected !== true || fixture.legacyClaimError !== 'ExecutionAuthorityConflict' ||
      fixture.vtrOwnerRetained !== true || typeof fixture.transitionId !== 'string' || fixture.transitionId.length === 0 ||
      typeof fixture.contractHash !== 'string' || !/^[0-9a-f]{64}$/iu.test(fixture.contractHash) ||
      !Number.isSafeInteger(before) || !Number.isSafeInteger(after) || fixture.pathfinderStartDelta !== after - before ||
      fixture.pathfinderStartDelta !== 0 || fixture.authorityConflictCount !== 1 || fixture.maxConcurrentActions !== 1) {
    return fail('fixture did not retain the VTR owner/contract while refusing legacy claim without another Pathfinder start')
  }
  return { status: 'PASS', reason: 'exact-source legacy claim refusal and no-second-Pathfinder-start fixture independently rehashed' }
}

export async function validateEvidenceArchive(archive, repo = null) {
  const checks = []
  const add = (id, status, detail = {}) => checks.push({ id, status, ...detail })
  const incomplete = (id, reason, detail = {}) => add(id, CHECK_STATUS.INCOMPLETE, { reason, ...detail })
  const fail = (id, reason, detail = {}) => add(id, CHECK_STATUS.FAIL, { reason, ...detail })
  const pass = (id, detail = {}) => add(id, CHECK_STATUS.PASS, detail)
  const required = [
    'probe.json',
    'packaging-report.json',
    'runner/acceptance.json',
    'runner/buddy.log',
    'runner/generation-bundle.mjs',
    'runner/initial-snapshot.json',
    'runner/fixture-anchor-snapshot.json',
    'runner/jev-run.jsonl',
    'runner/jev-calls.jsonl',
    'runner/jev-decisions.jsonl',
    'runner/system2.jsonl',
    'runner/milestone-predicates.json',
    'server/fixture-commands.jsonl',
    'server/leaf-latest.log',
    'server/leaf-stdout-events.jsonl',
    'server/server-start.json',
    'server/fresh-world-attestation.json',
    'server/world/level.dat',
    'runner/provider-activity-capture.json',
    'runner/host-lifecycle.jsonl',
    'runner/no-llm-egress-audit.json',
  ]
  const present = new Set()
  for (const path of required) {
    if (existsSync(join(archive, path))) present.add(path)
    else incomplete(`required:${path}`, 'required artifact is absent')
  }

  let listing
  try {
    listing = walkFiles(archive)
    if (listing.symlinks.length > 0) fail('archive-symlinks', 'archive contains symlinks', { paths: listing.symlinks })
    else pass('archive-symlinks', { count: 0 })
  } catch (error) {
    fail('archive-walk', error.message)
    listing = { files: [], symlinks: [] }
  }

  let validJsonCount = 0
  for (const path of listing.files.filter((name) => name.endsWith('.json') && name !== 'runner/no-llm-egress-audit.json')) {
    try { readJson(archive, path); validJsonCount += 1 } catch (error) {
      if (path === 'runner/provider-activity-capture.json') incomplete(`json:${path}`, error.message)
      else fail(`json:${path}`, error.message)
    }
  }
  let validJsonlCount = 0
  for (const path of listing.files.filter((name) => name.endsWith('.jsonl') || name === 'runner/no-llm-egress-audit.json')) {
    try { parseJsonl(archive, path); validJsonlCount += 1 } catch (error) {
      if (['runner/jev-calls.jsonl', 'runner/jev-decisions.jsonl', 'runner/system2.jsonl', 'runner/mercury-calls.jsonl', 'runner/no-llm-egress-audit.json'].includes(path)) {
        incomplete(`jsonl:${path}`, error.message)
      } else fail(`jsonl:${path}`, error.message)
    }
  }
  if (validJsonCount > 0) pass('archive:json-valid', { files: validJsonCount })
  if (validJsonlCount > 0) pass('archive:jsonl-valid', { files: validJsonlCount })

  if (!listing.files.includes('SHA256SUMS')) {
    incomplete('sha256-manifest', 'SHA256SUMS is absent')
  } else {
    try {
      const manifest = parseManifest(readText(archive, 'SHA256SUMS'))
      const actual = new Set(listing.files.filter((path) => path !== 'SHA256SUMS'))
      for (const path of actual) {
        if (!manifest.has(path)) fail(`sha256:${path}`, 'file is not covered by SHA256SUMS')
        else {
          const digest = sha256(readFileSync(join(archive, path)))
          if (digest !== manifest.get(path)) fail(`sha256:${path}`, 'SHA256 mismatch', { expected: manifest.get(path), observed: digest })
          else pass(`sha256:${path}`, { sha256: digest })
        }
      }
      for (const path of manifest.keys()) if (!actual.has(path)) fail(`sha256:${path}`, 'manifest entry has no archived file')
      pass('sha256-manifest-coverage', { files: actual.size })
    } catch (error) {
      fail('sha256-manifest', error.message)
    }
  }

  const docs = {}
  for (const path of ['probe.json', 'packaging-report.json', 'runner/acceptance.json', 'runner/initial-snapshot.json', 'runner/fixture-anchor-snapshot.json', 'runner/milestone-predicates.json', 'server/server-start.json']) {
    if (!present.has(path)) continue
    try { docs[path] = readJson(archive, path) } catch { /* parse error is already reported above */ }
  }
  let events = []
  let fixtureCommands = []
  let stdoutEvents = []
  try { if (present.has('runner/jev-run.jsonl')) events = parseJsonl(archive, 'runner/jev-run.jsonl') } catch { /* reported above */ }
  try { if (present.has('server/fixture-commands.jsonl')) fixtureCommands = parseJsonl(archive, 'server/fixture-commands.jsonl') } catch { /* reported above */ }
  try { if (present.has('server/leaf-stdout-events.jsonl')) stdoutEvents = parseJsonl(archive, 'server/leaf-stdout-events.jsonl') } catch { /* reported above */ }
  const probe = docs['probe.json']
  const acceptance = docs['runner/acceptance.json']
  const snapshot = docs['runner/initial-snapshot.json']
  const anchorSnapshot = docs['runner/fixture-anchor-snapshot.json']
  const predicates = docs['runner/milestone-predicates.json']
  const serverStart = docs['server/server-start.json']

  if (!probe) {
    incomplete('probe-manifest', 'probe.json is unavailable; remaining semantic checks are skipped')
  } else {
    const source = probe.source ?? {}
    const run = probe.run ?? {}
    const transition = probe.transition ?? {}
    const runId = run.runId
    const generationId = run.generationId
    const sourceSha = source.commit

    const botUuid = String(run.botUuid ?? '').toLowerCase()
    const playerDataPath = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(botUuid)
      ? `server/world/playerdata/${botUuid}.dat`
      : null
    if (!playerDataPath) incomplete('required:world-playerdata', 'run metadata has no canonical bot UUID for exact playerdata path')
    else if (listing.files.includes(playerDataPath)) {
      present.add(playerDataPath)
      pass('required:world-playerdata', { path: playerDataPath })
    } else incomplete('required:world-playerdata', 'UUID-bound Minecraft playerdata file is absent', { path: playerDataPath })

    let lifecycleRowsForFreshWorld = []
    try {
      if (listing.files.includes('runner/host-lifecycle.jsonl')) lifecycleRowsForFreshWorld = parseJsonl(archive, 'runner/host-lifecycle.jsonl')
    } catch { /* lifecycle parser reports malformed bytes in the provider-capture check */ }
    const stoppedServerRow = lifecycleRowsForFreshWorld.find((row) => row.event === 'server-stopped') ?? null
    const worldIdentity = parseWorldKey(run.worldKey)
    const packagingReport = docs['packaging-report.json']
    const sourceOrigins = packagingReport?.sourceOrigins
    const worldSourcePaths = new Map()
    const worldSourceReceipts = new Map()
    let launchPropertiesSourcePath = null
    if (!sourceOrigins || sourceOrigins.schema !== 'vtr-reach-source-origin-manifest/v1' ||
        sourceOrigins.sourceSha?.toLowerCase?.() !== String(sourceSha ?? '').toLowerCase() ||
        sourceOrigins.runId !== runId || sourceOrigins.generationId !== generationId ||
        sourceOrigins.worldKey !== run.worldKey || !Array.isArray(sourceOrigins.entries)) {
      fail('server:world-source-manifest', 'packaging report lacks an exact-source/run/world-bound world-source origin map')
    } else {
      let originInvalid = false
      for (const entry of sourceOrigins.entries) {
        if (!entry || typeof entry.archivePath !== 'string' || !entry.archivePath.startsWith('server/world/') ||
            entry.archivePath.split('/').some((part) => part === '' || part === '.' || part === '..') ||
            typeof entry.sourcePath !== 'string' || !isAbsolute(entry.sourcePath) ||
            typeof entry.realPath !== 'string' || resolve(entry.realPath) !== resolve(entry.sourcePath) ||
            !Number.isFinite(Date.parse(entry.capturedAt ?? '')) ||
            entry.sourceSha?.toLowerCase?.() !== String(sourceSha ?? '').toLowerCase() || entry.runId !== runId ||
            entry.generationId !== generationId || entry.worldKey !== run.worldKey ||
            entry.serverId !== run.serverId || entry.serverPid !== serverStart?.pid || entry.port !== worldIdentity?.serverId?.match(/^127\.0\.0\.1:(\d+)$/u)?.[1] * 1 ||
            entry.levelName !== run.levelName || !Array.isArray(entry.pathChain) ||
            !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !/^[0-9a-f]{64}$/iu.test(String(entry.sha256 ?? '')) ||
            worldSourcePaths.has(entry.archivePath)) {
          originInvalid = true
          break
        }
        const archivedPath = join(archive, entry.archivePath)
        const bytes = existsSync(archivedPath) ? readFileSync(archivedPath) : null
        if (bytes === null || bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256.toLowerCase()) {
          originInvalid = true
          break
        }
        worldSourcePaths.set(entry.archivePath, entry.sourcePath)
        worldSourceReceipts.set(entry.archivePath, entry)
      }
      const launchOrigin = sourceOrigins.launchConfig
      const launchPath = 'server/server.properties.launch'
      const launchBytes = listing.files.includes(launchPath) ? readFileSync(join(archive, launchPath)) : null
      if (!launchOrigin || launchOrigin.archivePath !== launchPath || typeof launchOrigin.sourcePath !== 'string' ||
          !isAbsolute(launchOrigin.sourcePath) || launchBytes === null || launchOrigin.bytes !== launchBytes.length ||
          launchOrigin.sha256?.toLowerCase?.() !== sha256(launchBytes) || serverStart?.serverPropertiesPath !== launchOrigin.sourcePath ||
          serverStart?.serverPropertiesSha256?.toLowerCase?.() !== sha256(launchBytes) ||
          serverStart?.spawnObservation?.configPath !== launchOrigin.sourcePath ||
          serverStart?.spawnObservation?.configSha256?.toLowerCase?.() !== sha256(launchBytes)) {
        originInvalid = true
      } else launchPropertiesSourcePath = launchOrigin.sourcePath
      const archivedWorldPaths = listing.files.filter((path) => path.startsWith('server/world/')).sort()
      const originPaths = [...worldSourcePaths.keys()].sort()
      if (!isDeepStrictEqual(archivedWorldPaths, originPaths)) originInvalid = true
      if (originInvalid) fail('server:world-source-manifest', 'world-source origin map is duplicate, incomplete, unsafe, or disagrees with archived world bytes')
      else pass('server:world-source-manifest', { entries: worldSourcePaths.size })
    }
    const jarSource = packagingReport?.serverJarSource
    const jarPath = serverStart?.serverJar
    const jarSha = serverStart?.serverJarSha256?.toLowerCase?.()
    const spawn = serverStart?.spawnObservation
    if (!jarSource || typeof jarPath !== 'string' || !isAbsolute(jarPath) || !/^[0-9a-f]{64}$/iu.test(String(jarSha ?? '')) ||
        jarSource.sourcePath !== jarPath || !Number.isSafeInteger(jarSource.bytes) || jarSource.bytes < 1 ||
        jarSource.sha256?.toLowerCase?.() !== jarSha || spawn?.jarPath !== jarPath || spawn?.jarSha256?.toLowerCase?.() !== jarSha) {
      fail('server:spawned-artifacts', 'packaging report does not rebind actual JAR path/hash to the spawned child observation')
    } else pass('server:spawned-artifacts', { jarPath, bytes: jarSource.bytes, sha256: jarSha })
    const freshWorldFiles = new Map()
    for (const path of listing.files) {
      if (path === 'server/fresh-world-attestation.json' || path === 'server/server-start.json' ||
          path === 'server/server.properties.launch' || path === 'server/server.properties.clean' ||
          path === 'server/server.properties.effective-after-boot' || path === 'server/leaf-latest.log' ||
          path === 'server/leaf-stdout-events.jsonl' ||
          path.startsWith('server/world/')) {
        try {
          freshWorldFiles.set(path, {
            bytes: readFileSync(join(archive, path)),
            ...(path === 'server/server.properties.launch' && launchPropertiesSourcePath ? { path: launchPropertiesSourcePath } : {}),
            ...(worldSourcePaths.has(path) ? {
              path: worldSourcePaths.get(path),
              readReceipt: worldSourceReceipts.get(path),
            } : {}),
          })
        } catch { /* reported as missing below */ }
      }
    }
    const freshWorld = inspectFreshWorldAttestation({
      copiedSources: freshWorldFiles,
      identity: { sourceSha, runId, generationId, worldKey: run.worldKey, worldIdentity },
      run,
      serverStart,
      expectedWitnessRegionPath: witnessRegionRelativePath(transition.witness?.target),
      lifecycle: { events: { serverStopped: stoppedServerRow } },
    })
    if (freshWorld.status === 'PASS') pass('server:fresh-world-attestation', { identity: freshWorld.identity, artifacts: freshWorld.artifacts })
    else if (freshWorld.status === 'FAIL') fail('server:fresh-world-attestation', freshWorld.reason ?? 'fresh-world attestation contradicts raw archive bytes')
    else incomplete('server:fresh-world-attestation', freshWorld.reason ?? 'fresh-world attestation is incomplete')

    if (source.repository === 'souta-lab/minecraft-jev-agent' && SHA_RE.test(sourceSha ?? '')) pass('probe-source-identity', { sourceSha, branch: source.branch })
    else fail('probe-source-identity', 'repository or exact source SHA is invalid', { repository: source.repository ?? null, sourceSha: sourceSha ?? null })
    if (typeof source.buildHash === 'string' && /^[0-9a-f]{12}$/i.test(source.buildHash) && Number.isInteger(source.bundleBytes)) pass('probe-build-identity', { buildHash: source.buildHash, bundleBytes: source.bundleBytes })
    else fail('probe-build-identity', 'build hash or bundle byte count is invalid')
    if (typeof runId === 'string' && RUN_ID_RE.test(runId)) pass('probe-run-id', { runId })
    else fail('probe-run-id', 'runId has invalid form', { runId: runId ?? null })
    if (typeof generationId === 'string' && generationId.length > 0) pass('probe-generation-id', { generationId })
    else fail('probe-generation-id', 'generationId is missing')

    const checkBound = (id, label, observed, expected, { nullable = false } = {}) => {
      if (observed === null || observed === undefined) {
        if (nullable) incomplete(id, `${label} is null in this raw record; another run-scoped artifact must bind it`, { expected })
        else fail(id, `${label} is missing`, { expected })
      } else if (observed !== expected) fail(id, `${label} mismatch`, { expected, observed })
      else pass(id, { value: observed })
    }

    if (acceptance) {
      checkBound('source:acceptance-commit', 'acceptance.gitCommit', acceptance.gitCommit, sourceSha)
      checkBound('source:acceptance-head', 'acceptance.checkoutHead', acceptance.checkoutHead, sourceSha)
      checkBound('run:acceptance-run', 'acceptance.runId', acceptance.runId, runId)
      checkBound('run:acceptance-generation', 'acceptance.generationId', acceptance.generationId, generationId, { nullable: true })
      checkBound('world:acceptance-epoch', 'acceptance.worldEpoch', acceptance.worldEpoch, run.worldEpoch)
      checkBound('world:acceptance-level', 'acceptance.levelName', acceptance.levelName, run.levelName, { nullable: true })
      checkBound('world:acceptance-seed', 'acceptance.seed', acceptance.seed, run.seed, { nullable: true })
    }
    if (snapshot) {
      checkBound('run:snapshot-run', 'snapshot.runId', snapshot.runId, runId)
      checkBound('run:snapshot-generation', 'snapshot.generationId', snapshot.generationId, generationId)
      checkBound('source:snapshot-sha', 'snapshot.bootSourceSha', snapshot.bootSourceSha, sourceSha)
      checkBound('source:snapshot-build', 'snapshot.buildHash', snapshot.buildHash, source.buildHash)
      checkBound('world:snapshot-epoch', 'snapshot.worldEpoch', snapshot.worldEpoch, run.worldEpoch)
    }
    if (predicates) {
      checkBound('run:predicates-run', 'milestone.runId', predicates.runId, runId)
      checkBound('run:predicates-generation', 'milestone.generationId', predicates.generationId, generationId)
      checkBound('source:predicates-sha', 'milestone.sourceSha', predicates.sourceSha, sourceSha)
    }

    let bundlePath = probe.artifacts?.generationBundle ?? 'runner/generation-bundle.mjs'
    if (!listing.files.includes(bundlePath)) incomplete('build:bundle-present', 'generation bundle artifact is absent', { path: bundlePath })
    else {
      const bundle = readFileSync(join(archive, bundlePath))
      const bundleSha = sha256(bundle)
      if (bundle.length !== source.bundleBytes) fail('build:bundle-bytes', 'bundle byte length differs from probe manifest', { expected: source.bundleBytes, observed: bundle.length })
      else pass('build:bundle-bytes', { bytes: bundle.length })
      if (!bundleSha.startsWith(String(source.buildHash ?? '').toLowerCase())) fail('build:bundle-sha', 'bundle SHA prefix does not match buildHash', { expectedPrefix: source.buildHash, observedSha256: bundleSha })
      else pass('build:bundle-sha', { sha256: bundleSha })
    }

    if (repo) {
      try {
        const head = gitOutput(repo, ['rev-parse', 'HEAD'])
        if (head !== sourceSha) fail('source:repo-head', 'source checkout HEAD does not match exact run SHA', { expected: sourceSha, observed: head })
        else pass('source:repo-head', { commit: head })
        const hasCommit = gitCommitExists(repo, sourceSha)
        if (!hasCommit) fail('source:commit-object', 'source commit object is absent')
        else pass('source:commit-object', { commit: sourceSha })
        const status = gitOutput(repo, ['status', '--porcelain', '--untracked-files=all'])
        if (status.length > 0) fail('source:repo-clean', 'exact-source checkout has non-ignored changes', { status: status.split('\n') })
        else pass('source:repo-clean')
        const branch = gitOutput(repo, ['branch', '--show-current'])
        if (source.branch && branch && branch !== source.branch) fail('source:repo-branch', 'checkout branch differs from recorded run branch', { expected: source.branch, observed: branch })
        else if (!branch && source.branch === 'detached-exact-source') pass('source:repo-branch', { branch: 'detached-exact-source', note: 'detached exact-source checkout is the required pristine configuration; commit identity is checked separately' })
        else if (!branch) incomplete('source:repo-branch', 'checkout is detached; commit identity is still checked')
        else pass('source:repo-branch', { branch })
      } catch (error) {
        fail('source:repo-access', `cannot verify source checkout: ${error.message}`)
      }
    } else {
      incomplete('source:repo-checkout', 'pass --repo to prove the exact source commit and clean checkout')
    }

    const timeFields = ['startedAt', 'generationReadyAt', 'shutdownAt']
    const times = Object.fromEntries(timeFields.map((field) => [field, Date.parse(run[field])]))
    if (timeFields.every((field) => Number.isFinite(times[field])) && times.startedAt <= times.generationReadyAt && times.generationReadyAt < times.shutdownAt) {
      pass('run:timestamps', { startedAt: run.startedAt, generationReadyAt: run.generationReadyAt, shutdownAt: run.shutdownAt })
    } else fail('run:timestamps', 'probe timestamps are invalid or out of order', { values: run })

    const contractIdentity = transition.worldIdentity ?? transition.identity
    const probeKey = parseWorldKey(run.worldKey)
    const contractKey = parseWorldKey(contractIdentity?.worldKey)
    if (!probeKey || !contractKey) fail('world:world-keys', 'run or contract worldKey is malformed', { runWorldKey: run.worldKey ?? null, contractWorldKey: contractIdentity?.worldKey ?? null })
    else if (probeKey.serverId !== contractKey.serverId || probeKey.worldEpoch !== contractKey.worldEpoch || probeKey.dimension !== contractKey.dimension) {
      fail('world:world-keys', 'run and contract world identities disagree after minecraft: namespace normalization', { run: probeKey, contract: contractKey })
    } else {
      pass('world:world-keys', { serverId: probeKey.serverId, canonicalDimension: probeKey.dimension, runDimensionSpelling: probeKey.rawDimension, contractDimensionSpelling: contractKey.rawDimension, worldEpoch: probeKey.worldEpoch })
      if (probeKey.rawDimension !== contractKey.rawDimension && !probe.worldIdentityNormalization) incomplete('world:normalization-documentation', 'world identity matches only after minecraft: namespace normalization; archive does not record this rule')
    }
    checkBound('world:run-epoch', 'contract worldEpoch', contractIdentity?.worldEpoch, run.worldEpoch)
    checkBound('world:contract-dimension', 'contract dimension', dimCanonical(contractIdentity?.dimension), dimCanonical(run.dimension))
    checkBound('world:contract-generation', 'contract generationId', contractIdentity?.generationId, generationId)
    checkBound('world:contract-lease', 'contract leaseId', contractIdentity?.leaseId, generationId)

    if (serverStart) {
      checkBound('server:level-name', 'server-start.levelName', serverStart.levelName, run.levelName)
      checkBound('server:minecraft-version', 'server-start.minecraftVersion', serverStart.minecraftVersion, run.minecraftVersion)
      checkBound('server:data-version', 'server-start.dataVersion', serverStart.dataVersion, run.dataVersion)
      checkBound('server:difficulty', 'server-start.difficulty', serverStart.difficulty, run.difficulty)
      checkBound('server:world-epoch', 'server-start.worldEpoch', serverStart.worldEpoch, run.worldEpoch)

      const launchCandidates = ['server/server.properties.launch', 'server/server.properties.clean']
      const launchPath = launchCandidates.find((path) => listing.files.includes(path) && sha256(readFileSync(join(archive, path))) === serverStart.serverPropertiesSha256)
      if (launchPath) pass('server:launch-config-sha', { path: launchPath, sha256: serverStart.serverPropertiesSha256 })
      else incomplete('server:launch-config-sha', 'recorded launch config hash is not present in an archived launch-config file', { expectedSha256: serverStart.serverPropertiesSha256, candidates: launchCandidates.filter((path) => listing.files.includes(path)).map((path) => ({ path, sha256: sha256(readFileSync(join(archive, path))) })) })
      if (typeof serverStart.serverPropertiesEffectiveSha256 === 'string') {
        const effectiveCandidates = ['server/server.properties.effective-after-boot', 'server/server.properties.clean']
        const effectivePath = effectiveCandidates.find((path) => listing.files.includes(path) && sha256(readFileSync(join(archive, path))) === serverStart.serverPropertiesEffectiveSha256)
        if (effectivePath) pass('server:effective-config-sha', { path: effectivePath, sha256: serverStart.serverPropertiesEffectiveSha256 })
        else fail('server:effective-config-sha', 'effective server config hash does not match an archived file')
      } else incomplete('server:effective-config-sha', 'post-boot effective config hash is not recorded separately')

      if (serverStart.serverJarSha256 && serverStart.serverJar) {
        if (existsSync(serverStart.serverJar)) {
          const jarSha = sha256(readFileSync(serverStart.serverJar))
          if (jarSha !== serverStart.serverJarSha256) fail('server:jar-sha', 'server JAR hash mismatch', { expected: serverStart.serverJarSha256, observed: jarSha })
          else pass('server:jar-sha', { sha256: jarSha })
        } else incomplete('server:jar-presence', 'server JAR is outside the archive and is not present at its recorded path', { path: serverStart.serverJar, recordedSha256: serverStart.serverJarSha256 })
      } else incomplete('server:jar-sha', 'server JAR path/hash is not recorded')
    }

    let launchProperties = null
    for (const path of ['server/server.properties.launch', 'server/server.properties.clean']) {
      if (!listing.files.includes(path)) continue
      try {
        const props = readProperties(readText(archive, path))
        if (!launchProperties || path.endsWith('.launch')) launchProperties = { path, props }
      } catch (error) { fail('server:properties-parse', error.message) }
    }
    if (launchProperties) {
      const p = launchProperties.props
      const expectedProps = { 'server-ip': '127.0.0.1', 'server-port': String(run.serverId?.split(':').at(-1) ?? ''), 'level-name': run.levelName, gamemode: 'survival', difficulty: run.difficulty, 'level-seed': '' }
      const mismatches = Object.entries(expectedProps).filter(([key, expected]) => p[key] !== expected).map(([key, expected]) => ({ key, expected, observed: p[key] ?? null }))
      if (mismatches.length) fail('server:launch-config-values', 'launch properties conflict with the run manifest', { path: launchProperties.path, mismatches })
      else pass('server:launch-config-values', { path: launchProperties.path, bind: `${p['server-ip']}:${p['server-port']}`, levelName: p['level-name'], gameMode: p.gamemode, difficulty: p.difficulty, seedConfigured: p['level-seed'] })
    } else incomplete('server:launch-config-values', 'no parseable server properties file is archived')

    const leafPath = 'server/leaf-latest.log'
    if (present.has(leafPath)) {
      const leaf = readText(archive, leafPath)
      const checks = [
        ['version', new RegExp(`Starting minecraft server version ${String(run.minecraftVersion).replaceAll('.', '\\.')}`)],
        ['level', new RegExp(`Preparing level ["']${String(run.levelName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`)],
        ['username', new RegExp(`UUID of player ${String(run.botUsername).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is ${String(run.botUuid).replaceAll('-', '\\-')}`)],
      ]
      const absent = checks.filter(([, regex]) => !regex.test(leaf)).map(([name]) => name)
      if (absent.length) incomplete('server:leaf-log-binding', 'server log is missing one or more binding lines', { absent })
      else pass('server:leaf-log-binding', { version: run.minecraftVersion, levelName: run.levelName, botUsername: run.botUsername, botUuid: run.botUuid })
    }

    if (present.has('server/world/level.dat')) {
      try {
        const level = await parseLevelDat(join(archive, 'server/world/level.dat'))
        const mismatch = []
        if (level.levelName !== run.levelName) mismatch.push({ field: 'levelName', expected: run.levelName, observed: level.levelName })
        if (level.dataVersion !== run.dataVersion) mismatch.push({ field: 'dataVersion', expected: run.dataVersion, observed: level.dataVersion })
        if (level.seed !== String(run.seed)) mismatch.push({ field: 'seed', expected: String(run.seed), observed: level.seed })
        if (level.difficulty !== 0) mismatch.push({ field: 'difficultyCode', expected: 0, observed: level.difficulty })
        if (level.gameType !== 0) mismatch.push({ field: 'gameType', expected: 0, observed: level.gameType })
        if (level.hardcore !== 0) mismatch.push({ field: 'hardcore', expected: 0, observed: level.hardcore })
        if (mismatch.length) fail('world:level-dat', 'level.dat contradicts the probe manifest', { parsed: level, mismatch })
        else pass('world:level-dat', level)
      } catch (error) { incomplete('world:level-dat', `cannot parse level.dat: ${error.message}`) }
    }

    if (playerDataPath && present.has(playerDataPath)) {
      try {
        const player = await parsePlayerDat(join(archive, playerDataPath))
        const expectedPos = run.finalPosition ?? probe.mission?.finalPosition
        const posMatches = Array.isArray(player.position) && expectedPos && closeNumber(player.position[0], expectedPos.x) && closeNumber(player.position[1], expectedPos.y) && closeNumber(player.position[2], expectedPos.z)
        const dimMatches = dimCanonical(player.dimension) === dimCanonical(run.dimension)
        const issues = []
        if (player.uuid !== run.botUuid) issues.push({ field: 'uuid', expected: run.botUuid, observed: player.uuid })
        if (!dimMatches) issues.push({ field: 'dimension', expected: run.dimension, observed: player.dimension })
        if (!posMatches) issues.push({ field: 'position', expected: expectedPos, observed: player.position })
        if (player.health !== 20) issues.push({ field: 'health', expected: 20, observed: player.health })
        if (!player.inventoryDecodable) issues.push({ field: 'inventory', reason: 'one or more item stacks could not be decoded' })
        if (!player.inventoryDecodable) incomplete('world:playerdata-inventory', 'player inventory encoding is not fully decoded')
        if (issues.some((issue) => issue.field !== 'inventory')) fail('world:playerdata', 'playerdata contradicts run-bound identity or state', { issues, inventory: player.inventory })
        else pass('world:playerdata', { uuid: player.uuid, dimension: player.dimension, position: player.position, health: player.health, air: player.air, inventory: player.inventory })
        if (player.inventoryDecodable && !inventoriesEqual(player.inventory, probe.mission?.finalInventory ?? {})) fail('world:final-inventory', 'playerdata inventory differs from probe final inventory', { expected: probe.mission?.finalInventory ?? {}, observed: player.inventory })
        else if (player.inventoryDecodable) pass('world:final-inventory', { inventory: player.inventory })
        if (typeof run.botUsername === 'string' && typeof player.uuid === 'string') pass('world:bot-uuid', { botUsername: run.botUsername, botUuid: player.uuid })
      } catch (error) { incomplete('world:playerdata', `cannot parse playerdata: ${error.message}`) }
    }

    const initialInventory = probe.mission?.initialInventory
    if (initialInventory && snapshot && inventoriesEqual(initialInventory, snapshot.initialInventory ?? {})) pass('world:initial-inventory', { inventory: initialInventory })
    else if (initialInventory && snapshot) fail('world:initial-inventory', 'mission and initial snapshot inventories differ', { mission: initialInventory, snapshot: snapshot.initialInventory ?? {} })

    const botLog = present.has('runner/buddy.log') ? readText(archive, 'runner/buddy.log') : ''
    const rawHostLines = botLog.split(/\r?\n/)
    const probeConfiguredLines = rawHostLines.filter((line) => hostEventToken(line) === 'VTR_REACH_PROBE_CONFIGURED')
    const probeQueueEmptyLines = rawHostLines.filter((line) => hostEventToken(line) === 'VTR_REACH_PROBE_QUEUE_EMPTY')
    const vtrAuthorityReadyLines = rawHostLines.filter((line) => hostEventToken(line) === 'GENERATION_READY' && line.includes('productionPlanAuthority=vtr-reach-probe'))
    if (botLog) {
      const boot = botLog.split(/\r?\n/).find((line) => line.includes(' BOOT ') && line.includes(`runId=${runId}`))
      if (!boot) fail('run:boot-line', 'resident log has no BOOT line for the probe runId')
      else {
        if (!boot.includes(`source=${sourceSha}`)) fail('run:boot-source', 'resident BOOT source SHA differs from manifest')
        else pass('run:boot-source', { sourceSha })
        if (!boot.includes(`connection={"host":"127.0.0.1","port":${Number(run.serverId?.split(':').at(-1))},"serverId":"${run.serverId}"}`)) incomplete('run:boot-server', 'resident BOOT connection does not exactly match parsed server identity')
        else pass('run:boot-server', { serverId: run.serverId })
      }
    }

    const commits = eventMessage(events, 'VTR_TRANSITION_COMMIT')
    const outcomes = eventMessage(events, 'VTR_TRANSITION_OUTCOME')
    const reservations = eventMessage(events, 'VTR_MECHANICAL_STEP_RESERVED')
    const actuations = eventMessage(events, 'VTR_TRANSITION_ACTUATION')
    const mechanicalOutcomes = eventMessage(events, 'VTR_MECHANICAL_OUTCOME')
    const mechanicalStepOutcomes = eventMessage(events, 'VTR_MECHANICAL_STEP_OUTCOME')
    const verifyRows = events.filter((row) => /(?:^|\s)(?:VTR_TRANSITION_VERIFY|VTR_VERIFY|TRANSITION_VERIFY)(?:\s|$)/.test(String(row?.message ?? '')))
    if (commits.length !== 1) fail('transition:commit-count', 'expected exactly one Transition commit', { count: commits.length })
    else pass('transition:commit-count', { count: commits.length })
    if (outcomes.length !== 1) fail('transition:outcome-count', 'expected exactly one terminal Transition outcome', { count: outcomes.length })
    else pass('transition:outcome-count', { count: outcomes.length })
    const commit = commits[0]?.detail
    const outcomeEvent = outcomes[0]?.detail
    const outcome = outcomeEvent?.outcome
    const contractHash = transition.contractHash
    if (commit && outcomeEvent && transition.transitionId === commit.transitionId && transition.transitionId === outcomeEvent.transitionId) pass('transition:id-chain', { transitionId: transition.transitionId })
    else fail('transition:id-chain', 'probe, commit and terminal outcome Transition ids differ', { probeId: transition.transitionId ?? null, commitId: commit?.transitionId ?? null, outcomeId: outcomeEvent?.transitionId ?? null })

    const contractBoundRows = [...commits, ...reservations, ...actuations, ...mechanicalOutcomes, ...mechanicalStepOutcomes, ...outcomes]
    const rowContractHashes = contractBoundRows.map((row) => transitionRowContractHash(row))
    const missingContractHashRows = contractBoundRows.map((row, index) => ({ row, index, hash: rowContractHashes[index] })).filter(({ hash }) => typeof hash !== 'string' || hash.length === 0)
    const conflictingContractHashRows = contractBoundRows.map((row, index) => ({ row, index, hash: rowContractHashes[index] })).filter(({ hash }) => typeof hash === 'string' && hash.length > 0 && hash !== contractHash)
    if (typeof contractHash !== 'string' || contractHash.length === 0) incomplete('transition:contract-hash-chain', 'probe contract hash is missing')
    else if (outcome?.contractHash !== contractHash || conflictingContractHashRows.length) fail('transition:contract-hash-chain', 'contract hash differs across committed, mechanical, and terminal event rows', { expected: contractHash, outcomeHash: outcome?.contractHash ?? null, conflicts: conflictingContractHashRows.map(({ row, hash }) => ({ event: firstMessageToken(row?.message), observed: hash })) })
    else if (missingContractHashRows.length) incomplete('transition:contract-hash-chain', 'one or more Transition event rows do not explicitly carry the committed contract hash', { contractHash, missingRows: missingContractHashRows.map(({ row }) => firstMessageToken(row?.message)) })
    else pass('transition:contract-hash-chain', { contractHash, rows: contractBoundRows.length })

    const committedIdentity = commit?.identity ?? commit?.worldIdentity
    if (!committedIdentity) incomplete('transition:commit-world-binding', 'commit event does not serialize its world/generation/lease identity')
    else {
      const committedKey = parseWorldKey(committedIdentity.worldKey)
      const runKey = parseWorldKey(run.worldKey)
      if (!committedKey || !runKey) fail('transition:commit-world-binding', 'commit or run worldKey is malformed')
      else if (committedKey.serverId !== runKey.serverId || committedKey.dimension !== runKey.dimension || committedKey.worldEpoch !== runKey.worldEpoch || committedIdentity.worldEpoch !== run.worldEpoch || committedIdentity.generationId !== generationId || committedIdentity.leaseId !== generationId || dimCanonical(committedIdentity.dimension) !== dimCanonical(run.dimension)) {
        fail('transition:commit-world-binding', 'commit world identity differs from the run-bound identity', { committedIdentity, runWorldKey: run.worldKey, runGenerationId: generationId })
      } else pass('transition:commit-world-binding', { worldKey: committedIdentity.worldKey, generationId: committedIdentity.generationId, leaseId: committedIdentity.leaseId })
    }

    const transitionExpectedMechanicalSteps = Number(outcomeEvent?.usage?.mechanicalSteps)
    let transitionOrderedRows = []
    const repeatedStepCounts = { reservations: reservations.length, mechanicalStepOutcomes: mechanicalStepOutcomes.length }
    if (!Number.isInteger(transitionExpectedMechanicalSteps) || transitionExpectedMechanicalSteps < 1) {
      fail('transition:event-order', 'terminal does not declare a positive integer mechanical step count', { mechanicalSteps: outcomeEvent?.usage?.mechanicalSteps ?? null })
    } else if (Object.values(repeatedStepCounts).some((count) => count > transitionExpectedMechanicalSteps)) {
      fail('transition:event-order', 'event chain contains more mechanical rows than the terminal usage count', { expectedMechanicalSteps: transitionExpectedMechanicalSteps, observed: repeatedStepCounts })
    } else if (Object.values(repeatedStepCounts).some((count) => count < transitionExpectedMechanicalSteps)) {
      incomplete('transition:event-order', 'one or more reserved/mechanical-step-outcome rows are missing for the terminal mechanical step count', { expectedMechanicalSteps: transitionExpectedMechanicalSteps, observed: repeatedStepCounts, intentActuations: actuations.length })
    } else if (commits.length !== 1 || outcomes.length !== 1 || verifyRows.length !== 1) {
      if (commits.length > 1 || outcomes.length > 1 || verifyRows.length > 1) fail('transition:event-order', 'commit, terminal, or VERIFY event is duplicated', { commits: commits.length, outcomes: outcomes.length, verifyRows: verifyRows.length })
      else incomplete('transition:event-order', 'commit, exactly one terminal outcome, or exactly one VERIFY row is absent', { commits: commits.length, outcomes: outcomes.length, verifyRows: verifyRows.length })
    } else {
      const stepOutcomeById = new Map(mechanicalStepOutcomes.map((row) => [row?.detail?.stepId, row]))
      const stepPairs = reservations.map((reserve) => ({ reserve, outcome: stepOutcomeById.get(reserve?.detail?.stepId) }))
      const commitIndex = events.indexOf(commits[0])
      const verifyIndex = events.indexOf(verifyRows[0])
      const terminalIndex = events.indexOf(outcomes[0])
      const invalidPairs = stepPairs.filter(({ reserve, outcome }) => !outcome || events.indexOf(reserve) >= events.indexOf(outcome))
      const stepIntentIds = new Set([...reservations, ...mechanicalStepOutcomes].map((row) => row?.detail?.intentId).filter((value) => typeof value === 'string'))
      const actuationIntentIds = actuations.map((row) => row?.detail?.intentId).filter((value) => typeof value === 'string')
      const duplicateActuationIntentIds = actuationIntentIds.filter((value, index, all) => all.indexOf(value) !== index)
      const unactuatedIntentIds = [...stepIntentIds].filter((intentId) => !actuationIntentIds.includes(intentId))
      const allExecutionRows = [...commits, ...actuations, ...reservations, ...mechanicalStepOutcomes, ...verifyRows, ...outcomes]
      const sortedExecutionRows = [...allExecutionRows].sort((left, right) => events.indexOf(left) - events.indexOf(right))
      transitionOrderedRows = sortedExecutionRows
      const timestamps = sortedExecutionRows.map(eventTimestamp)
      const stepOutcomesBeforeVerify = mechanicalStepOutcomes.every((row) => events.indexOf(row) < verifyIndex)
      const reasons = []
      if (actuations.length === 0) reasons.push('no VTR intent actuation was recorded')
      if (duplicateActuationIntentIds.length) reasons.push('an intent was actuated more than once')
      if (unactuatedIntentIds.length) reasons.push('mechanical steps refer to an intent with no actuation event')
      if (invalidPairs.length) reasons.push('each mechanical step must have one later typed outcome with the same stepId')
      if (commitIndex < 0 || sortedExecutionRows[0] !== commits[0]) reasons.push('commit must precede every execution row')
      if (!stepOutcomesBeforeVerify || verifyIndex <= Math.max(...mechanicalStepOutcomes.map((row) => events.indexOf(row)))) reasons.push('all per-step outcomes must precede VERIFY')
      if (terminalIndex <= verifyIndex) reasons.push('terminal outcome must follow VERIFY')
      if (timestamps.some((value) => value === null) || timestamps.some((value, index) => index > 0 && value < timestamps[index - 1])) reasons.push('execution timestamps must be present and monotonic')
      if (reasons.length) fail('transition:event-order', 'VTR intent, per-step reservation/outcome, VERIFY, and terminal ordering is inconsistent', { reasons, expectedMechanicalSteps: transitionExpectedMechanicalSteps, observed: { reservations: reservations.length, mechanicalStepOutcomes: mechanicalStepOutcomes.length, intentActuations: actuations.length, intentIds: [...stepIntentIds] } })
      else pass('transition:event-order', { markers: ['commit', 'intent-actuation', 'mechanical-step-reserved', 'mechanical-step-outcome', 'verify', 'terminal-outcome'], timestamps: sortedExecutionRows.map((row) => row.ts), mechanicalSteps: transitionExpectedMechanicalSteps, intentActuations: actuations.length })
    }

    const transitionLogMarkerGroups = [
      ['commit', 'VTR_TRANSITION_COMMIT', commits],
      ['reservation', 'VTR_MECHANICAL_STEP_RESERVED', reservations],
      ['actuation', 'VTR_TRANSITION_ACTUATION', actuations],
      ['mechanical-action-outcome', 'VTR_MECHANICAL_OUTCOME', mechanicalOutcomes],
      ['mechanical-step-outcome', 'VTR_MECHANICAL_STEP_OUTCOME', mechanicalStepOutcomes],
      ['terminal-outcome', 'VTR_TRANSITION_OUTCOME', outcomes],
    ]
    const logLines = rawHostLines
    const eventLogBindings = []
    const mirroredRows = []
    let missingEventLogBinding = false
    let mismatchedEventLogBinding = false
    for (const [name, marker, rows] of transitionLogMarkerGroups) {
      const keys = rows.map((row) => transitionRowStepId(row, rows.length === 1))
      const duplicateKeys = keys.filter((key, index) => key !== null && keys.indexOf(key) !== index)
      for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
        const row = rows[rowIndex]
        const id = transitionRowId(row)
        if (typeof id !== 'string' || id.length === 0) {
          missingEventLogBinding = true
          eventLogBindings.push({ name, rowIndex, status: 'missing event id' })
          continue
        }
        if (rows.length > 1 && (keys[rowIndex] === null || duplicateKeys.includes(keys[rowIndex]))) {
          missingEventLogBinding = true
          eventLogBindings.push({ name, rowIndex, status: 'repeated event lacks a unique stepId discriminator', stepId: keys[rowIndex] })
          continue
        }
        let matching = logLines.filter((line) => hostEventToken(line) === marker && (line.includes(`transitionId=${id}`) || line.includes(`id=${id}`)))
        const directStepId = typeof row?.detail?.stepId === 'string' && row.detail.stepId.length > 0 ? row.detail.stepId : null
        const directIntentId = typeof row?.detail?.intentId === 'string' && row.detail.intentId.length > 0 ? row.detail.intentId : null
        const directActionId = typeof row?.detail?.actionId === 'string' && row.detail.actionId.length > 0 ? row.detail.actionId : null
        if (directStepId !== null) matching = matching.filter((line) => line.includes(`stepId=${directStepId}`) || line.includes(`stepId=${JSON.stringify(directStepId)}`))
        else if (directIntentId !== null) matching = matching.filter((line) => line.includes(`intentId=${directIntentId}`) || line.includes(`intentId=${JSON.stringify(directIntentId)}`))
        else if (directActionId !== null) matching = matching.filter((line) => line.includes(`actionId=${directActionId}`) || line.includes(`actionId=${JSON.stringify(directActionId)}`))
        else if (rows.length > 1) matching = []
        if (matching.length !== 1) {
          if (matching.length > 1) mismatchedEventLogBinding = true
          else missingEventLogBinding = true
          eventLogBindings.push({ name, rowIndex, status: matching.length > 1 ? 'ambiguous duplicate raw log lines' : 'raw log line missing', count: matching.length, stepId: keys[rowIndex] })
          continue
        }
        const line = matching[0]
        const rawIdentity = {
          runId: token(line, 'runId'),
          generationId: token(line, 'generationId'),
          sourceSha: token(line, 'sourceSha'),
          buildHash: token(line, 'buildHash'),
        }
        const expectedIdentity = { runId, generationId, sourceSha, buildHash: source.buildHash }
        const differences = Object.keys(expectedIdentity).filter((key) => rawIdentity[key] !== expectedIdentity[key]).map((key) => ({ key, expected: expectedIdentity[key], observed: rawIdentity[key] }))
        // MirroringEventLogger tees the marker token plus JSONL detail to HOST;
        // fields carried only in the JSONL message text are not in that sink.
        const expectedRowContractHash = row?.detail?.contractHash ?? row?.detail?.outcome?.contractHash ?? null
        if (expectedRowContractHash && token(line, 'contractHash') !== expectedRowContractHash) differences.push({ key: 'contractHash', expected: expectedRowContractHash, observed: token(line, 'contractHash') })
        const rawTime = logTimestamp(line)
        const eventTime = eventTimestamp(row)
        const timestampDeltaMs = rawTime === null || eventTime === null ? null : rawTime - eventTime
        const lineIndex = logLines.indexOf(line)
        if (differences.length || timestampDeltaMs === null || timestampDeltaMs < 0) {
          mismatchedEventLogBinding = true
          eventLogBindings.push({ name, rowIndex, status: 'mismatch', differences, rawTimestamp: rawTime, eventTimestamp: eventTime, timestampDeltaMs, stepId: keys[rowIndex] })
        } else {
          const binding = { name, rowIndex, status: 'PASS', transitionId: id, stepId: keys[rowIndex], runId, generationId, sourceSha, journalTimestamp: row.ts, hostTimestamp: line.slice(1, line.indexOf(']')), timestampDeltaMs }
          eventLogBindings.push(binding)
          mirroredRows.push({ row, lineIndex, rawTime, binding })
        }
      }
    }
    const duplicateMirroredLineIndexes = mirroredRows.map((item) => item.lineIndex).filter((value, index, all) => all.indexOf(value) !== index)
    const orderedMirroredRows = [...mirroredRows].sort((left, right) => events.indexOf(left.row) - events.indexOf(right.row))
    const hostLineOrderInvalid = orderedMirroredRows.some((item, index) => index > 0 && item.lineIndex <= orderedMirroredRows[index - 1].lineIndex)
    if (duplicateMirroredLineIndexes.length || hostLineOrderInvalid) {
      mismatchedEventLogBinding = true
      eventLogBindings.push({ status: 'mismatch', reason: duplicateMirroredLineIndexes.length ? 'one host line was reused for multiple JSONL events' : 'host mirror order differs from JSONL event order', duplicateLineIndexes: duplicateMirroredLineIndexes })
    }
    if (mismatchedEventLogBinding) fail('transition:event-run-binding', 'raw Transition log lines mismatch provenance, reuse one host line, or precede/out-of-order journal emission', { bindings: eventLogBindings })
    else if (missingEventLogBinding) incomplete('transition:event-run-binding', 'raw Transition event lines are missing, duplicated, or lack unique per-step correlation', { bindings: eventLogBindings })
    else pass('transition:event-run-binding', { bindings: eventLogBindings })

    const requiredContract = ['requires', 'ensures', 'invariants', 'admissibleEffects', 'budget']
    const missingContract = requiredContract.filter((field) => !Array.isArray(transition[field]) && !(transition[field] && typeof transition[field] === 'object'))
    if (transition.desiredPredicate && missingContract.length === 0 && (transition.worldIdentity || transition.identity)) pass('transition:contract-fields', { fields: ['desiredPredicate', ...requiredContract, 'worldIdentity'] })
    else incomplete('transition:contract-fields', 'serialized contract is missing one or more first-class fields', { missing: [...missingContract, ...(!transition.desiredPredicate ? ['desiredPredicate'] : []), ...(!(transition.worldIdentity || transition.identity) ? ['worldIdentity'] : [])] })
    if (transition.controller && Array.isArray(transition.controller.allowedTactics)) pass('transition:controller-policy', { controller: transition.controller })
    else incomplete('transition:controller-policy', 'contract controller policy is not serialized with allowed tactics and substitution permissions')
    if (transition.progressDefinition || transition.progressContract || transition.progressPolicy) pass('transition:progress-contract', { value: transition.progressDefinition ?? transition.progressContract ?? transition.progressPolicy })
    else incomplete('transition:progress-contract', 'contract does not serialize the Transition-specific progress definition')

    const budgetCheck = assertUsageWithinBudget({
      budget: { ...(transition.budget ?? {}), admissibleEffects: transition.admissibleEffects },
      usage: outcomeEvent?.usage,
    })
    if (budgetCheck.problems.length) fail('transition:budget', 'terminal usage exceeds or violates the committed Transition budget/effect envelope', { problems: budgetCheck.problems })
    else if (budgetCheck.missing.length) incomplete('transition:budget', 'budget or terminal usage is too incomplete to check against the committed contract', { missing: budgetCheck.missing })
    else pass('transition:budget', { mechanicalSteps: outcomeEvent.usage.mechanicalSteps, elapsedMs: outcomeEvent.usage.elapsedMs, resources: outcomeEvent.usage.resources, risk: outcomeEvent.usage.risk, effects: outcomeEvent.usage.effects })

    const mechanicalCounts = { reservations: reservations.length, perStepOutcomes: mechanicalStepOutcomes.length, intentActuations: actuations.length }
    if (!Number.isInteger(transitionExpectedMechanicalSteps) || transitionExpectedMechanicalSteps < 1) {
      fail('transition:mechanical-counts', 'terminal mechanicalSteps is not a positive integer', { mechanicalSteps: outcomeEvent?.usage?.mechanicalSteps ?? null, observed: mechanicalCounts })
    } else if ([reservations.length, mechanicalStepOutcomes.length].some((count) => count > transitionExpectedMechanicalSteps)) {
      fail('transition:mechanical-counts', 'per-leg reservation/outcome count exceeds terminal mechanicalSteps', { expected: transitionExpectedMechanicalSteps, observed: mechanicalCounts })
    } else if (reservations.length < transitionExpectedMechanicalSteps || mechanicalStepOutcomes.length < transitionExpectedMechanicalSteps) {
      incomplete('transition:mechanical-counts', 'per-leg reservation/outcome count is below terminal mechanicalSteps', { expected: transitionExpectedMechanicalSteps, observed: mechanicalCounts })
    } else if (actuations.length === 0) {
      incomplete('transition:mechanical-counts', 'no VTR intent actuation was archived', { expected: transitionExpectedMechanicalSteps, observed: mechanicalCounts })
    } else {
      pass('transition:mechanical-counts', { expected: transitionExpectedMechanicalSteps, observed: mechanicalCounts })
      const mechanicalMissing = []
      const mechanicalProblems = []
      const seenStepIds = new Set()
      const stepEvidence = []
      const persistentIdentity = persistentActionIdentity({ reservations, outcomes: mechanicalStepOutcomes, actuations, actionOutcomes: mechanicalOutcomes })
      mechanicalProblems.push(...persistentIdentity.problems.map((problem) => ({ field: 'persistent Transition action identity', ...problem })))
      const actuationByIntentId = new Map()
      for (const row of actuations) {
        const intentId = row?.detail?.intentId
        if (typeof intentId !== 'string' || intentId.length === 0) {
          mechanicalMissing.push('actuation.intentId')
          continue
        }
        if (actuationByIntentId.has(intentId)) mechanicalProblems.push({ field: 'unique actuation intentId', observed: intentId })
        else actuationByIntentId.set(intentId, row)
      }
      const outcomeStepIds = mechanicalStepOutcomes.map((row) => row?.detail?.stepId)
      const duplicateOutcomeStepIds = outcomeStepIds.filter((stepId, index, all) => typeof stepId === 'string' && all.indexOf(stepId) !== index)
      if (duplicateOutcomeStepIds.length) mechanicalProblems.push({ field: 'unique outcome stepId', observed: [...new Set(duplicateOutcomeStepIds)] })
      for (let index = 0; index < transitionExpectedMechanicalSteps; index += 1) {
        const reserveRow = reservations[index]
        const reserve = reserveRow?.detail ?? {}
        const reserveStepId = typeof reserve.stepId === 'string' && reserve.stepId.length > 0 ? reserve.stepId : null
        const matchingOutcomes = mechanicalStepOutcomes.filter((row) => row?.detail?.stepId === reserveStepId)
        const mechRow = matchingOutcomes[0] ?? null
        const mech = mechRow?.detail ?? {}
        const actionRow = typeof reserve.intentId === 'string' ? actuationByIntentId.get(reserve.intentId) : null
        const action = actionRow?.detail ?? {}
        const rowIds = [transitionRowId(reserveRow), transitionRowId(actionRow), transitionRowId(mechRow)]
        if (rowIds.some((id) => id === null)) mechanicalMissing.push(`step ${index + 1} transitionId`)
        else if (rowIds.some((id) => id !== transition.transitionId)) mechanicalProblems.push({ step: index + 1, field: 'transitionId', expected: transition.transitionId, observed: rowIds })

        if (action.authority !== 'vtr-transition-controller') mechanicalProblems.push({ step: index + 1, field: 'authority', expected: 'vtr-transition-controller', observed: action.authority ?? null })
        const actionContractHash = transitionRowContractHash(actionRow)
        if (actionContractHash !== contractHash) mechanicalProblems.push({ step: index + 1, field: 'actuation.contractHash', expected: contractHash, observed: actionContractHash ?? null })
        const reserveUsage = Number(reserve.usage?.mechanicalSteps)
        const mechUsage = Number(mech.usage?.mechanicalSteps)
        const expectedOrdinal = index + 1
        if (!Number.isFinite(reserveUsage)) mechanicalMissing.push(`step ${expectedOrdinal} reservation usage.mechanicalSteps`)
        else if (reserveUsage !== expectedOrdinal) mechanicalProblems.push({ step: expectedOrdinal, field: 'reservation mechanicalSteps', expected: expectedOrdinal, observed: reserveUsage })
        if (!Number.isFinite(mechUsage)) mechanicalMissing.push(`step ${expectedOrdinal} mechanical outcome usage.mechanicalSteps`)
        else if (mechUsage !== expectedOrdinal) mechanicalProblems.push({ step: expectedOrdinal, field: 'mechanical outcome mechanicalSteps', expected: expectedOrdinal, observed: mechUsage })

        const mechStepId = typeof mech.stepId === 'string' && mech.stepId.length > 0 ? mech.stepId : null
        const actionId = typeof action.actionId === 'string' ? action.actionId : null
        const reserveActionId = typeof reserve.actionId === 'string' ? reserve.actionId : null
        const mechActionId = typeof mech.actionId === 'string' ? mech.actionId : null
        const reserveIntentId = typeof reserve.intentId === 'string' ? reserve.intentId : null
        const mechIntentId = typeof mech.intentId === 'string' ? mech.intentId : null
        let canonicalStepId = reserveStepId
        if (!reserveStepId) {
          mechanicalMissing.push(`step ${expectedOrdinal} reservation.stepId`)
        } else if (matchingOutcomes.length === 0) {
          mechanicalMissing.push(`step ${expectedOrdinal} VTR_MECHANICAL_STEP_OUTCOME`)
        } else if (matchingOutcomes.length > 1) {
          mechanicalProblems.push({ step: expectedOrdinal, field: 'unique per-step outcome', count: matchingOutcomes.length })
        }
        if (reserveStepId && mechStepId !== null && reserveStepId !== mechStepId) mechanicalProblems.push({ step: expectedOrdinal, field: 'stepId', expected: reserveStepId, mechanicalOutcome: mechStepId })
        if (!reserveIntentId || !mechIntentId || !action.intentId) mechanicalMissing.push(`step ${expectedOrdinal} intentId correlation`)
        else if (reserveIntentId !== mechIntentId || reserveIntentId !== action.intentId) mechanicalProblems.push({ step: expectedOrdinal, field: 'intentId', reservation: reserveIntentId, outcome: mechIntentId, actuation: action.intentId })
        if (!reserveActionId || !mechActionId || !actionId) mechanicalMissing.push(`step ${expectedOrdinal} actionId correlation`)
        else if (reserveActionId !== mechActionId || reserveActionId !== actionId) mechanicalProblems.push({ step: expectedOrdinal, field: 'actionId', reservation: reserveActionId, outcome: mechActionId, actuation: actionId })
        if (transitionRowContractHash(reserveRow) !== contractHash || transitionRowContractHash(mechRow) !== contractHash) mechanicalProblems.push({ step: expectedOrdinal, field: 'step contractHash', expected: contractHash, reservation: transitionRowContractHash(reserveRow), outcome: transitionRowContractHash(mechRow) })
        if (mech.status !== 'active' && mech.status !== 'terminal' && mech.status !== 'refused') mechanicalProblems.push({ step: expectedOrdinal, field: 'typed step status', observed: mech.status ?? null })
        if (actionRow && reserveRow && events.indexOf(actionRow) >= events.indexOf(reserveRow)) mechanicalProblems.push({ step: expectedOrdinal, field: 'intent actuation order', intentId: reserveIntentId })
        if (reserveRow && mechRow && events.indexOf(reserveRow) >= events.indexOf(mechRow)) mechanicalProblems.push({ step: expectedOrdinal, field: 'reservation/outcome order', stepId: reserveStepId })

        if (canonicalStepId !== null) {
          if (seenStepIds.has(canonicalStepId)) mechanicalProblems.push({ step: expectedOrdinal, field: 'unique stepId', observed: canonicalStepId })
          seenStepIds.add(canonicalStepId)
        }
        stepEvidence.push({ ordinal: expectedOrdinal, stepId: canonicalStepId, intentId: reserveIntentId, actionId: actionId ?? mechActionId, leg: reserve.leg ?? null, status: mech.status ?? null, usage: mechUsage })
      }
      if (mechanicalProblems.length) fail('transition:mechanical-chain', 'one or more per-leg rows conflict with the active Transition, intent owner, step identity, or cumulative usage', { problems: mechanicalProblems, missing: mechanicalMissing })
      else if (mechanicalMissing.length) incomplete('transition:mechanical-chain', 'per-leg reservation/outcome rows do not fully bind unique ordered steps to the active Transition', { missing: mechanicalMissing, steps: stepEvidence })
      else pass('transition:mechanical-chain', { transitionId: transition.transitionId, contractHash, authority: 'vtr_transition', mechanicalSteps: transitionExpectedMechanicalSteps, steps: stepEvidence, actionOutcomes: mechanicalOutcomes.length })
    }

    let verifyHostCheck = null
    const boundaryEvidence = outcome?.kind === 'SUCCESS'
      ? inspectOutcomeBoundaryEvidence({
          boundary: outcomeEvent?.boundary,
          outcome,
          verifyRows,
          transitionId: transition.transitionId,
          contractHash,
          expectedIdentity: {
            runId,
            generationId,
            sourceSha,
            worldKey: run.worldKey,
            worldEpoch: run.worldEpoch,
            dimension: run.dimension,
          },
          terminalRow: outcomes[0],
          events,
          lastMechanicalRow: mechanicalStepOutcomes.at(-1),
        })
      : { status: 'FAIL', reason: 'terminal outcome is not SUCCESS' }
    if (outcome?.kind === 'SUCCESS' && outcomeEvent?.boundary === 'mechanical-step-outcome' && boundaryEvidence.status !== 'PASS') {
      if (boundaryEvidence.status === 'INCOMPLETE') incomplete('transition:verified-success', boundaryEvidence.reason, boundaryEvidence)
      else fail('transition:verified-success', boundaryEvidence.reason, boundaryEvidence)
    } else if (outcome?.kind === 'SUCCESS' && ['verified-terminal', 'mechanical-step-outcome'].includes(outcomeEvent?.boundary) && Array.isArray(outcome.evidenceIds) && outcome.evidenceIds.some((id) => /^verify:/.test(id)) && outcome.desiredPredicateIdentity) {
      const reportedVerifyMs = Date.parse(transition.outcome?.verifiedAt ?? '')
      if (!Number.isFinite(outcome.verifiedAtMs) || reportedVerifyMs !== outcome.verifiedAtMs) {
        fail('transition:verified-success', 'probe and terminal disagree on the deterministic VERIFY timestamp', { eventVerifiedAtMs: outcome.verifiedAtMs ?? null, probeVerifiedAt: transition.outcome?.verifiedAt ?? null, probeVerifiedAtMs: reportedVerifyMs })
      } else if (verifyRows.length > 1) {
        fail('transition:verified-success', 'multiple structured VERIFY observations make the terminal evidence ambiguous', { count: verifyRows.length, evidenceIds: outcome.evidenceIds })
      } else if (verifyRows.length === 0) {
        incomplete('transition:verified-success', 'outcome contains a verify ID but the archive has no independent structured VERIFY observation bound to it', { outcome: outcome.kind, evidenceIds: outcome.evidenceIds, verifiedAtMs: outcome.verifiedAtMs })
      } else {
        const verify = verifyRows.find((row) => {
          const detail = row?.detail?.verification ?? row?.detail ?? {}
          const ids = Array.isArray(detail.evidenceIds) ? detail.evidenceIds : [detail.evidenceId].filter((value) => typeof value === 'string')
          return detail.transitionId === transition.transitionId && ids.some((id) => outcome.evidenceIds.includes(id))
        })
        if (!verify) {
          fail('transition:verified-success', 'VERIFY observations are present but none binds the committed Transition and terminal evidence id', { transitionId: transition.transitionId, verifyRows: verifyRows.length, evidenceIds: outcome.evidenceIds })
        } else {
          const detail = verify.detail?.verification ?? verify.detail ?? {}
          const verifyIdentity = detail.worldIdentity ?? detail.identity ?? detail
          const rawVerifyTruth = detail.truth ?? detail.result
          const verifyTruth = rawVerifyTruth === true || rawVerifyTruth === 'TRUE'
          const verifyEvidenceIds = Array.isArray(detail.evidenceIds) ? detail.evidenceIds : [detail.evidenceId].filter((value) => typeof value === 'string')
          const observedAtMs = Number(detail.observedAtMs ?? detail.verifiedAtMs)
          const reportedVerifiedAtMs = Number(detail.verifiedAtMs)
          const verifyEventAt = eventTimestamp(verify)
          const lastMechanicalOutcome = mechanicalStepOutcomes.at(-1)
          const mechAt = eventTimestamp(lastMechanicalOutcome)
          const terminalAt = eventTimestamp(outcomes[0])
          const verifyProblems = []
          const verifyMissing = []
          const expectedBindings = {
            transitionId: transition.transitionId,
            contractHash,
            desiredPredicateIdentity: outcome.desiredPredicateIdentity,
            runId,
            serverId: run.serverId,
            generationId,
            leaseId: generationId,
            sourceSha,
            buildHash: source.buildHash,
            worldKey: run.worldKey,
            worldEpoch: run.worldEpoch,
            dimension: dimCanonical(run.dimension),
          }
          for (const [key, expected] of Object.entries(expectedBindings)) {
            const observed = key === 'worldKey' ? (detail.worldKey ?? verifyIdentity.worldKey ?? verifyIdentity.worldIdentity?.worldKey)
              : key === 'worldEpoch' ? (detail.worldEpoch ?? verifyIdentity.worldEpoch ?? verifyIdentity.worldIdentity?.worldEpoch)
                : key === 'dimension' ? dimCanonical(detail.dimension ?? verifyIdentity.dimension ?? verifyIdentity.worldIdentity?.dimension)
                  : detail[key] ?? verifyIdentity[key] ?? verifyIdentity.worldIdentity?.[key]
            if (observed === undefined || observed === null || observed === '') verifyMissing.push(key)
            else if (key === 'worldKey') {
              const observedKey = parseWorldKey(observed)
              const expectedKey = parseWorldKey(expected)
              if (!observedKey || !expectedKey || observedKey.serverId !== expectedKey.serverId || observedKey.dimension !== expectedKey.dimension || observedKey.worldEpoch !== expectedKey.worldEpoch) verifyProblems.push({ key, expected, observed })
            } else if (observed !== expected) verifyProblems.push({ key, expected, observed })
          }
          if (rawVerifyTruth === undefined || rawVerifyTruth === null) verifyMissing.push('truth')
          else if (!verifyTruth) verifyProblems.push({ key: 'truth', expected: 'true/TRUE', observed: rawVerifyTruth })
          if (!verifyEvidenceIds.length) verifyMissing.push('evidenceIds')
          else if (!verifyEvidenceIds.every((id) => outcome.evidenceIds.includes(id))) verifyProblems.push({ key: 'evidenceIds', expected: outcome.evidenceIds, observed: verifyEvidenceIds })
          if (!Number.isFinite(observedAtMs)) verifyMissing.push('canonical observedAtMs/verifiedAtMs')
          else if (observedAtMs !== outcome.verifiedAtMs) verifyProblems.push({ key: 'canonical observedAtMs', expected: outcome.verifiedAtMs, observed: observedAtMs })
          if (Number.isFinite(reportedVerifiedAtMs) && reportedVerifiedAtMs !== outcome.verifiedAtMs) verifyProblems.push({ key: 'verifiedAtMs', expected: outcome.verifiedAtMs, observed: reportedVerifiedAtMs })
          else if (!Number.isFinite(reportedVerifiedAtMs) && detail.verifiedAtMs !== undefined) verifyMissing.push('valid verifiedAtMs')
          if (verifyEventAt === null) verifyMissing.push('event emission timestamp')
          if (mechAt === null || terminalAt === null || verifyEventAt === null) verifyMissing.push('VERIFY event ordering timestamps')
          else if (verifyEventAt < mechAt || verifyEventAt > terminalAt || events.indexOf(verify) <= events.indexOf(lastMechanicalOutcome) || events.indexOf(verify) >= events.indexOf(outcomes[0])) {
            verifyProblems.push({ key: 'event order', expected: 'mechanical outcome < VERIFY observation < terminal outcome', observed: { mechanicalAt: mechAt, verifyAt: verifyEventAt, terminalAt } })
          }

          const verifyMarker = firstMessageToken(verify.message)
          const hostVerifyLines = logLines.filter((line) => hostEventToken(line) === verifyMarker
            && (line.includes(`transitionId=${transition.transitionId}`) || line.includes(`id=${transition.transitionId}`))
            && verifyEvidenceIds.every((id) => line.includes(`evidenceId=${id}`) || line.includes(JSON.stringify(id))))
          if (hostVerifyLines.length === 0) verifyMissing.push('mirrored HOST VERIFY line bound to transition/evidence')
          else if (hostVerifyLines.length > 1) verifyProblems.push({ key: 'host VERIFY line count', expected: 1, observed: hostVerifyLines.length })
          else {
            const hostLine = hostVerifyLines[0]
            const hostProblems = []
            const hostMissing = []
            const hostIdentity = {
              runId: token(hostLine, 'runId'),
              generationId: token(hostLine, 'generationId'),
              sourceSha: token(hostLine, 'sourceSha'),
              buildHash: token(hostLine, 'buildHash'),
            }
            const expectedHostIdentity = { runId, generationId, sourceSha, buildHash: source.buildHash }
            for (const [key, expected] of Object.entries(expectedHostIdentity)) {
              if (hostIdentity[key] === null) hostMissing.push(key)
              else if (hostIdentity[key] !== expected) hostProblems.push({ key, expected, observed: hostIdentity[key] })
            }
            const hostAt = logTimestamp(hostLine)
            const hostLineIndex = logLines.indexOf(hostLine)
            if (hostAt === null || verifyEventAt === null) hostMissing.push('timestamp')
            else if (hostAt < verifyEventAt) hostProblems.push({ key: 'host timestamp precedes JSONL emission', expectedAtLeast: verifyEventAt, observed: hostAt, deltaMs: hostAt - verifyEventAt })
            const lastMechanicalHostRow = mirroredRows.find((item) => item.row === mechanicalStepOutcomes.at(-1))
            const terminalHostRow = mirroredRows.find((item) => item.row === outcomes[0])
            if (!lastMechanicalHostRow || !terminalHostRow) hostMissing.push('matching mechanical-outcome/terminal HOST mirror lines for order check')
            else if (hostLineIndex <= lastMechanicalHostRow.lineIndex || hostLineIndex >= terminalHostRow.lineIndex) hostProblems.push({ key: 'host mirror order', expected: 'mechanical outcome < VERIFY < terminal outcome', observed: { mechanicalLineIndex: lastMechanicalHostRow.lineIndex, verifyLineIndex: hostLineIndex, terminalLineIndex: terminalHostRow.lineIndex } })
            const hostDetail = { eventToken: verifyMarker, transitionId: transition.transitionId, evidenceIds: verifyEvidenceIds, hostTimestamp: hostLine.slice(1, hostLine.indexOf(']')), journalTimestamp: verify.ts, timestampDeltaMs: hostAt === null || verifyEventAt === null ? null : hostAt - verifyEventAt, hostLineIndex, identity: hostIdentity }
            if (hostProblems.length) {
              verifyProblems.push(...hostProblems.map((problem) => ({ ...problem, key: `host.${problem.key}` })))
              verifyHostCheck = { status: CHECK_STATUS.FAIL, reason: 'mirrored HOST VERIFY event conflicts with the JSONL event/run binding', detail: { ...hostDetail, problems: hostProblems } }
            } else if (hostMissing.length) {
              verifyMissing.push(...hostMissing.map((key) => `host.${key}`))
              verifyHostCheck = { status: CHECK_STATUS.INCOMPLETE, reason: 'mirrored HOST VERIFY event lacks complete provenance/timestamp data', detail: { ...hostDetail, missing: hostMissing } }
            } else verifyHostCheck = { status: CHECK_STATUS.PASS, detail: hostDetail }
          }
          if (verifyProblems.length) fail('transition:verified-success', 'structured VERIFY evidence is stale or conflicts with the Transition/run binding', { problems: verifyProblems, missing: verifyMissing })
          else if (verifyMissing.length) incomplete('transition:verified-success', 'structured VERIFY evidence is not fully bound to the exact run, source, world identity, and mirrored host event', { missing: verifyMissing, evidenceIds: verifyEvidenceIds })
          else pass('transition:verified-success', { outcome: outcome.kind, evidenceIds: verifyEvidenceIds, observedAtMs, verifiedAtMs: reportedVerifiedAtMs, predicateIdentity: outcome.desiredPredicateIdentity })
        }
      }
    } else fail('transition:verified-success', 'terminal does not prove deterministic SUCCESS with a VERIFY evidence id and predicate identity', { outcome: outcome?.kind ?? null, boundary: outcomeEvent?.boundary ?? null, evidenceIds: outcome?.evidenceIds ?? [] })
    if (verifyHostCheck?.status === CHECK_STATUS.PASS) pass('transition:verify-host-binding', verifyHostCheck.detail)
    else if (verifyHostCheck?.status === CHECK_STATUS.FAIL) fail('transition:verify-host-binding', verifyHostCheck.reason, verifyHostCheck.detail)
    else if (verifyHostCheck?.status === CHECK_STATUS.INCOMPLETE) incomplete('transition:verify-host-binding', verifyHostCheck.reason, verifyHostCheck.detail)
    else if (verifyRows.length === 0) incomplete('transition:verify-host-binding', 'no structured VERIFY row is available to corroborate against the mirrored HOST log')
    else fail('transition:verify-host-binding', 'the VERIFY row could not be uniquely matched to a mirrored HOST event with the same transition and evidence')
    if (outcome && transition.metrics?.typedTerminalOutcome === outcome.kind) pass('transition:typed-outcome-metric', { kind: outcome.kind })
    else fail('transition:typed-outcome-metric', 'typed terminal metric does not match the recorded outcome')
    if (Number(outcomeEvent?.usage?.mechanicalSteps) === transition.metrics?.mechanicalStepsPerTransition) pass('metrics:mechanical-steps', { count: outcomeEvent.usage.mechanicalSteps })
    else fail('metrics:mechanical-steps', 'metrics disagree with terminal Transition usage')
    if (transition.metrics?.duplicateAuthority === false && transition.metrics?.duplicateAuthorityConflicts === 0 && transition.metrics?.concurrentLegacyActuations === 0) pass('metrics:no-double-authority', { duplicateAuthority: false, conflicts: 0, concurrentLegacyActuations: 0, concurrentLegacyActuationsEvidence: 'probe-reported metric; raw marker scan and exact-source fixture are checked separately, no interval-level concurrency trace is present in this metric' })
    else incomplete('metrics:no-double-authority', 'probe summary does not assert zero duplicate/concurrent legacy authority')

    const skillStartRows = events.filter((row) => row?.source === 'executor' && String(row.message).startsWith('SKILL_START '))
    const skillStarts = skillStartRows.length
    const vtrSelectedSkills = skillStartRows.filter((row) => /selectedBy=vtr-transition/.test(String(row.message))).length
    const skillStartIndices = skillStartRows.map((row) => events.indexOf(row))
    const commitIndex = events.indexOf(commits[0])
    const outcomeIndex = events.indexOf(outcomes[0])
    const firstReservationIndex = reservations.length === 0 ? -1 : Math.min(...reservations.map((row) => events.indexOf(row)))
    const legAndActuationActionIds = [...new Set(
      [...reservations, ...mechanicalStepOutcomes, ...actuations]
        .map((row) => row?.detail?.actionId)
        .filter((value) => typeof value === 'string' && value.length > 0),
    )]
    const expectedActionId = legAndActuationActionIds.length === 1 ? legAndActuationActionIds[0] : null
    const skillStartProof = inspectLiveSkillOwnership({
      skillStartRows,
      selectedSkillCount: vtrSelectedSkills,
      actionId: expectedActionId,
      reservations,
      stepOutcomes: mechanicalStepOutcomes,
      actuations,
      mechanicalSteps: transitionExpectedMechanicalSteps,
      commitIndex,
      skillStartIndex: skillStartIndices[0],
      firstReservationIndex,
      outcomeIndex,
      events,
    })
    if (skillStartProof.status === 'PASS') pass('authority:single-skill-owner', { skillStarts, vtrSelectedSkills, mechanicalSteps: transitionExpectedMechanicalSteps, selectedBy: 'vtr-transition', actionId: expectedActionId, proof: skillStartProof.proof })
    else if (skillStartProof.status === 'INCOMPLETE') incomplete('authority:single-skill-owner', 'SKILL_START identity/order is not fully bound to the persistent per-leg action', { skillStarts, vtrSelectedSkills, mechanicalSteps: transitionExpectedMechanicalSteps, skillStartIndices, firstReservationIndex, commitIndex, outcomeIndex, actionIds: legAndActuationActionIds, proof: skillStartProof })
    else fail('authority:single-skill-owner', skillStartProof.reason ?? 'persistent Reach proof does not establish one VTR-selected action across multiple mechanical legs', { skillStarts, vtrSelectedSkills, mechanicalSteps: transitionExpectedMechanicalSteps, skillStartIndices, firstReservationIndex, commitIndex, outcomeIndex, actionIds: legAndActuationActionIds, proof: skillStartProof })
    const legacyActuationSource = '(?:selectedBy=(?:jev|legacy|option|goalqueue)|LEGACY_ACTUATION|legacyActuation=true|authority=(?:legacy|option|goalqueue)|(?:GOAL_QUEUE|OPTION)_ACTUATION)'
    const legacyActuationMatches = (botLog.match(new RegExp(legacyActuationSource, 'gi')) ?? []).length + events.filter((row) => new RegExp(legacyActuationSource, 'i').test(String(row?.message ?? ''))).length
    if (legacyActuationMatches === 0 && transition.metrics?.duplicateAuthority === false) pass('authority:no-legacy-actuation-observed', { matches: legacyActuationMatches })
    else fail('authority:no-legacy-actuation-observed', 'legacy actuation marker or conflict was observed', { matches: legacyActuationMatches })

    const policy = probe.configuredNoLlmProbe ?? {}
    const jev = policy.effectiveJev ?? {}
    const system2 = policy.effectiveSystem2 ?? {}
    const terminalJevCalls = outcomeEvent?.jevCalls ?? Number(/jevCalls=(\d+)/.exec(outcomes[0]?.message ?? '')?.[1])
    const terminalSystem2Calls = outcomeEvent?.system2Calls ?? Number(/system2Calls=(\d+)/.exec(outcomes[0]?.message ?? '')?.[1])
    let capturedProviders = null
    let providerCaptureError = null
    try {
      capturedProviders = providerCaptureFromArchive(archive, {
        sourceSha, runId, generationId, buildHash: source.buildHash,
        transitionId: transition.transitionId, contractHash,
      }, probe)
    } catch (error) {
      providerCaptureError = error
    }
    if (capturedProviders?.egressAudit?.status === 'PASS') {
      pass('policy:no-llm-egress-audit', {
        coverageStatus: capturedProviders.egressAudit.coverageStatus,
        externalDeniedAttempts: capturedProviders.egressAudit.externalDeniedAttempts,
        rawArtifact: capturedProviders.egressAudit.rawArtifact,
        limitations: capturedProviders.egressAudit.limitations,
      })
    } else if (providerCaptureError instanceof EvidenceAssessmentError && providerCaptureError.status === CHECK_STATUS.FAIL &&
      /egress|LD_PRELOAD/iu.test(providerCaptureError.message)) {
      fail('policy:no-llm-egress-audit', providerCaptureError.message, providerCaptureError.details ?? {})
    } else if (providerCaptureError && /egress|LD_PRELOAD/iu.test(providerCaptureError.message ?? '')) {
      incomplete('policy:no-llm-egress-audit', providerCaptureError.message)
    } else {
      incomplete('policy:no-llm-egress-audit', 'LD_PRELOAD egress audit was not independently classified')
    }
    const capturedActivity = capturedProviders?.activity ?? null
    const decisionValues = {
      jevDecisionCalls: jev.decisionCalls,
      system2DecisionCalls: system2.decisionCalls,
      terminalJevCalls,
      terminalSystem2Calls,
    }
    const providerValues = {
      networkModelCalls: policy.networkModelCalls,
      jevProviderEvaluateAttempts: jev.providerEvaluateAttempts,
      system2ProviderEvaluateAttempts: system2.providerEvaluateAttempts,
      providerEvaluateAttemptsPerMechanicalStep: policy.providerEvaluateAttemptsPerMechanicalStep,
    }
    const modelActivityPattern = /(?:JEV|SYSTEM2)_MODEL_(?:CALL|REQUEST|RETRY|FAILURE)|(?:MODEL|PROVIDER)_(?:CALL|REQUEST|RETRY|FAILURE|UNAVAILABLE|FALLBACK)|MERCURY_(?:ATTEMPT|RETRY|FAILURE_STATE)|FALLBACK_AFTER_PROVIDER_FAILURE|GatewayInternalServerError|Service temporarily unavailable|MODEL_UNAVAILABLE|HTTP 5\d\d/iu
    const modelActivityRows = events.filter((row) => modelActivityPattern.test(String(row?.message ?? '')))
    const modelActivityLogLines = botLog.split(/\r?\n/).filter((line) => modelActivityPattern.test(line))
    const anyProviderActivityLog = modelActivityRows.length > 0 || modelActivityLogLines.length > 0
    const modelJournals = ['runner/jev-calls.jsonl', 'runner/jev-decisions.jsonl', 'runner/system2.jsonl', 'runner/mercury-calls.jsonl'].map((path) => {
      if (!existsSync(join(archive, path))) return { path, status: 'missing', records: null }
      try { return { path, status: 'valid', records: parseJsonl(archive, path).length } }
      catch (error) { return { path, status: 'malformed', error: error.message, records: null } }
    })
    const missingModelJournals = modelJournals.filter((entry) => entry.status === 'missing' || entry.status === 'malformed')
    const fallbackFlags = policy.fallback ?? {}
    const offlineBindings = {
      BUDDY_POLICY: policy.BUDDY_POLICY,
      BUDDY_SYSTEM2: policy.BUDDY_SYSTEM2,
      fallbackPolicyWasExplicitlyConfigured: fallbackFlags.fallbackPolicyWasExplicitlyConfigured,
      silentFallbackOnProviderFailure: fallbackFlags.silentFallbackOnProviderFailure,
      JevDecisionInvoked: fallbackFlags.JevDecisionInvoked,
      effectiveJevProvider: jev.provider,
      effectiveSystem2Provider: system2.provider,
    }
    const missingOfflineBindings = Object.entries(offlineBindings).filter(([, value]) => value === undefined || value === null).map(([key]) => key)
    const explicitlyOffline = policy.BUDDY_POLICY === 'fallback' && policy.BUDDY_SYSTEM2 === 'off' && fallbackFlags.fallbackPolicyWasExplicitlyConfigured === true && fallbackFlags.silentFallbackOnProviderFailure === false && fallbackFlags.JevDecisionInvoked === false && jev.provider === 'deterministic' && system2.provider === 'none'
    const configuredLine = probeConfiguredLines.length === 1 ? probeConfiguredLines[0] : null
    const queueEmptyLine = probeQueueEmptyLines.length === 1 ? probeQueueEmptyLines[0] : null
    const readyLine = vtrAuthorityReadyLines.length === 1 ? vtrAuthorityReadyLines[0] : null
    const explicitRuntimeFlags = {
      configuredMarkerCount: probeConfiguredLines.length,
      BUDDY_POLICY: token(configuredLine ?? '', 'jevPolicyMode'),
      BUDDY_SYSTEM2: token(configuredLine ?? '', 'system2Mode'),
      compatibilityLadder: token(configuredLine ?? '', 'compatibilityLadder'),
      ledgerRestore: token(configuredLine ?? '', 'ledgerRestore'),
      plannerBootstrap: token(configuredLine ?? '', 'plannerBootstrap'),
      queueEmptyMarkerCount: probeQueueEmptyLines.length,
      queueAuthority: token(queueEmptyLine ?? '', 'authority'),
      restoredLegacyRows: token(queueEmptyLine ?? '', 'restoredLegacyRows'),
      productionPlanAuthority: token(readyLine ?? '', 'productionPlanAuthority'),
      readyPolicy: token(readyLine ?? '', 'policy'),
      readyPolicyProvider: token(readyLine ?? '', 'policyProvider'),
      readySystem2Provider: token(readyLine ?? '', 'system2Provider'),
    }
    const missingRuntimeFlags = Object.entries(explicitRuntimeFlags).filter(([key, value]) => key.endsWith('MarkerCount') ? value === 0 : value === null).map(([key]) => key)
    const runtimeFlagsMatch = configuredLine !== null && queueEmptyLine !== null && readyLine !== null
      && explicitRuntimeFlags.BUDDY_POLICY === policy.BUDDY_POLICY
      && explicitRuntimeFlags.BUDDY_SYSTEM2 === policy.BUDDY_SYSTEM2
      && explicitRuntimeFlags.compatibilityLadder === 'observer-only'
      && explicitRuntimeFlags.ledgerRestore === 'disabled'
      && explicitRuntimeFlags.plannerBootstrap === 'disabled'
      && explicitRuntimeFlags.queueAuthority === 'vtr-transition-scheduler'
      && explicitRuntimeFlags.restoredLegacyRows === '0'
      && explicitRuntimeFlags.productionPlanAuthority === 'vtr-reach-probe'
      && explicitRuntimeFlags.readyPolicy === 'fallback'
      && explicitRuntimeFlags.readyPolicyProvider === 'deterministic'
      && explicitRuntimeFlags.readySystem2Provider === 'none'
    const missingDecisionCounters = Object.entries(decisionValues).filter(([, value]) => typeof value !== 'number' || !Number.isFinite(value) || value < 0).map(([key]) => key)
    const missingProviderCounters = Object.entries(providerValues).filter(([, value]) => typeof value !== 'number' || !Number.isFinite(value) || value < 0).map(([key]) => key)
    const nonzeroProviderCounters = Object.entries(providerValues).filter(([, value]) => Number(value) !== 0).map(([key, value]) => ({ key, value }))
    if (missingOfflineBindings.length) incomplete('policy:offline-profile', 'required offline-policy/fallback evidence fields are absent', { missing: missingOfflineBindings, observed: offlineBindings })
    else if (!explicitlyOffline) fail('policy:offline-profile', 'no-LLM configuration conflicts with the required explicit offline policy and no-silent-fallback boundary', { observed: offlineBindings })
    else if (!runtimeFlagsMatch && missingRuntimeFlags.length) incomplete('policy:offline-profile', 'runtime VTR probe/configuration markers do not provide explicit no-LLM and empty-queue provenance', { missing: missingRuntimeFlags, observed: explicitRuntimeFlags })
    else if (!runtimeFlagsMatch) fail('policy:offline-profile', 'runtime VTR probe/configuration markers conflict with the manifest no-LLM policy', { expected: { BUDDY_POLICY: policy.BUDDY_POLICY, BUDDY_SYSTEM2: policy.BUDDY_SYSTEM2 }, observed: explicitRuntimeFlags })
    else pass('policy:offline-profile', { configuredPolicy: policy.BUDDY_POLICY, effectiveJev: jev, effectiveSystem2: system2, runtime: explicitRuntimeFlags })
    if (providerCaptureError instanceof EvidenceAssessmentError && providerCaptureError.status === CHECK_STATUS.FAIL) {
      fail('policy:provider-journals', providerCaptureError.message, providerCaptureError.details ?? {})
    } else if (providerCaptureError || missingModelJournals.length) {
      incomplete('policy:provider-journals', providerCaptureError?.message ?? 'provider activity capture or a raw provider journal is missing/malformed', { journals: modelJournals, ...(providerCaptureError?.details ?? {}) })
    } else pass('policy:provider-journals', { journals: modelJournals, activity: capturedActivity })

    if (missingDecisionCounters.length || missingProviderCounters.length || missingModelJournals.length || providerCaptureError) {
      const status = providerCaptureError instanceof EvidenceAssessmentError && providerCaptureError.status === CHECK_STATUS.FAIL ? 'FAIL' : 'INCOMPLETE'
      const detail = { missingDecisionCounters, missingProviderCounters, journals: modelJournals, captureError: providerCaptureError?.message ?? null, ...(providerCaptureError?.details ?? {}) }
      if (status === 'FAIL') fail('policy:zero-call-counters', 'provider capture contradicts the no-network claim', detail)
      else incomplete('policy:zero-call-counters', 'provider/decision counters or continuous raw evidence are incomplete', detail)
    } else if (capturedActivity && (
      decisionValues.jevDecisionCalls !== capturedActivity.jevDecisionFrames ||
      decisionValues.system2DecisionCalls !== capturedActivity.system2DecisionInvocations ||
      terminalJevCalls !== capturedActivity.jevDecisionFrames ||
      terminalSystem2Calls !== capturedActivity.system2DecisionInvocations
    )) {
      fail('policy:zero-call-counters', 'reported Jev/System2 decision invocations disagree with independently captured journals', {
        reported: decisionValues,
        captured: capturedActivity,
      })
    } else if (capturedActivity && (
      policy.networkModelCalls !== capturedActivity.networkModelCalls ||
      jev.providerEvaluateAttempts !== capturedActivity.jevEvaluateAttempts ||
      system2.providerEvaluateAttempts !== capturedActivity.system2EvaluateAttempts ||
      policy.providerEvaluateAttemptsPerMechanicalStep !== (transition.metrics?.mechanicalStepsPerTransition > 0
        ? capturedActivity.networkModelCalls / transition.metrics.mechanicalStepsPerTransition : null)
    )) {
      fail('policy:zero-call-counters', 'reported provider-attempt counters disagree with independent raw capture', {
        reported: providerValues,
        captured: capturedActivity,
      })
    } else if (nonzeroProviderCounters.length || capturedActivity?.networkModelCalls !== 0 || anyProviderActivityLog) {
      fail('policy:zero-call-counters', 'actual provider/network activity occurred during no-LLM probe', {
        nonzero: nonzeroProviderCounters,
        captured: capturedActivity,
        modelActivityRows: modelActivityRows.map((row) => row.message),
        modelActivityLogLines,
      })
    } else pass('policy:zero-call-counters', {
      decisionInvocations: decisionValues,
      providerAttempts: providerValues,
      capturedActivity,
      scannedEventRows: events.length,
      scannedRunnerLogLines: botLog.split(/\r?\n/).length,
    })

    const allRunMessages = `${events.map((row) => String(row?.message ?? '')).join('\n')}\n${botLog}`
    const ladderAuthorityPattern = /SYSTEM2_PLAN_APPLIED|ROOT_GOAL_PROJECTED|LADDER_[A-Z0-9_]*(?:APPLIED|SELECTED|PROJECTED)|RUNGS?_[A-Z0-9_]*(?:APPLIED|SELECTED|PROJECTED)|productionPlanAuthority=(?:legacy|ladder|system2)/i
    const ladderAuthorityMarkers = allRunMessages.split(/\r?\n/).filter((line) => ladderAuthorityPattern.test(line))
    const passiveLadderRows = eventMessage(events, 'LADDER_PREREQ').length + (botLog.match(/\bLADDER_PREREQ\b/g) ?? []).length
    const probeConfiguredLine = probeConfiguredLines[0] ?? null
    const vtrAuthorityReadyLine = vtrAuthorityReadyLines[0] ?? null
    const ladderModeIsObserver = Boolean(probeConfiguredLine?.includes('compatibilityLadder=observer-only') && probeConfiguredLine.includes('plannerBootstrap=disabled') && vtrAuthorityReadyLine)
    if (ladderAuthorityMarkers.length) fail('authority:ladder-not-applied', 'raw runner evidence contains a marker that assigns WHAT selection to a ladder/System2 authority', { markers: ladderAuthorityMarkers })
    else if (!ladderModeIsObserver) incomplete('authority:ladder-not-applied', 'raw configuration/GENERATION_READY logs do not bind production authority to VTR with ladder observer-only mode', { hasProbeConfig: Boolean(probeConfiguredLine), hasVtrAuthorityReady: Boolean(vtrAuthorityReadyLine) })
    else pass('authority:ladder-not-applied', { productionAuthority: 'vtr-reach-probe', passiveLadderPrereqEvents: passiveLadderRows, ladderMode: 'observer-only', compatibilityRungMetadataPresent: /\brung(?:Index|Id)=/.test(vtrAuthorityReadyLine) })

    // --- V4.1.2 production-authority cutover -------------------------------
    // The probe must run with the real kernel gate ON (not shadow-only) and
    // legacy Reach authority OFF, and the kernel journal must show the gated
    // command path causally preceding actuation for this exact Transition.
    const kernelAuthorityModeLines = rawHostLines.filter((line) => hostEventToken(line) === 'KERNEL_AUTHORITY_MODE')
    const kernelShadowReadyLines = rawHostLines.filter((line) => hostEventToken(line) === 'KERNEL_SHADOW_READY')
    const kernelShadowSummaryLines = rawHostLines.filter((line) => hostEventToken(line) === 'KERNEL_SHADOW_SUMMARY')
    const kernelModeOn = kernelAuthorityModeLines.some((line) => /\bmode=authority\b/.test(line)) &&
      kernelShadowReadyLines.some((line) => /\bkernelAuthority=on\b/.test(line) && /\blegacyReachAuthority=off\b/.test(line))
    const kernelModeOff = kernelAuthorityModeLines.some((line) => /\bmode=shadow\b/.test(line)) ||
      kernelShadowReadyLines.some((line) => /\bkernelAuthority=off\b/.test(line))
    if (kernelModeOff) fail('authority:kernel-mode-on', 'kernel authority session ran in shadow-only mode; production authority was OFF', { kernelAuthorityModeLines, kernelShadowReadyLines })
    else if (!kernelModeOn) incomplete('authority:kernel-mode-on', 'KERNEL_AUTHORITY_MODE/KERNEL_SHADOW_READY rows do not bind kernelAuthority=on and legacyReachAuthority=off', { kernelAuthorityModeLines: kernelAuthorityModeLines.length, kernelShadowReadyLines: kernelShadowReadyLines.length })
    else pass('authority:kernel-mode-on', { mode: 'authority', legacyReachAuthority: 'off' })

    const shadowSummaryOk = kernelShadowSummaryLines.length > 0 && kernelShadowSummaryLines.every((line) =>
      /\bauthorityMode=authority\b/.test(line) && /\bgateDenials=0\b/.test(line))
    const shadowSummaryLine = kernelShadowSummaryLines[0] ?? null
    const summaryMutationsDenied = shadowSummaryLine === null ? null : /mutationsDeniedByLease=0/.test(shadowSummaryLine)
    const summaryKernelDenied = shadowSummaryLine === null ? null : /kernelDenied=0/.test(shadowSummaryLine)
    const summaryCoverage = shadowSummaryLine === null ? null : /coverageComplete=true/.test(shadowSummaryLine)
    if (!kernelShadowSummaryLines.length) incomplete('authority:kernel-summary', 'no KERNEL_SHADOW_SUMMARY row was archived', {})
    else if (!shadowSummaryOk || summaryMutationsDenied !== true || summaryKernelDenied !== true || summaryCoverage !== true) fail('authority:kernel-summary', 'kernel summary does not assert authority mode, zero gate denials, zero lease/kernel denials, and complete mutation coverage', { authorityModeOk: shadowSummaryOk, mutationsDeniedByLeaseZero: summaryMutationsDenied, kernelDeniedZero: summaryKernelDenied, coverageComplete: summaryCoverage, line: shadowSummaryLine })
    else pass('authority:kernel-summary', { mode: 'authority', gateDenials: 0, kernelDenied: 0, mutationsDeniedByLease: 0, coverageComplete: true })

    const kernelJournalText = listing.files.includes('runner/kernel-shadow.jsonl') ? readText(archive, 'runner/kernel-shadow.jsonl') : null
    if (kernelJournalText === null) {
      incomplete('authority:kernel-gates-live', 'runner/kernel-shadow.jsonl is absent; the gated kernel command path cannot be bound to this Transition')
    } else {
      const kernelRows = parsedJsonLines(kernelJournalText, 'runner/kernel-shadow.jsonl')
      const gateDeniedRows = kernelRows.filter((row) => row?.type === 'gate-denied')
      const blockerRows = kernelRows.filter((row) => row?.type === 'blocker')
      const transitionRows = kernelRows.filter((row) => row?.transitionId === transition.transitionId)
      const commands = (via) => transitionRows.filter((row) => row?.type === 'kernel-command' && row?.via === via && row?.ok === true).map((row) => row.command)
      const admitted = commands('gate-admit').includes('ADMIT_TRANSITION')
      const activated = commands('gate-activate').includes('ACQUIRE_DECLARED_RESOURCES')
      const issueCount = commands('mechanical-step-issued').filter((command) => command === 'ISSUE_EFFECT').length
      const dispatchCount = commands('mechanical-step-issued').filter((command) => command === 'BEGIN_EFFECT_DISPATCH').length
      const settleCount = commands('mechanical-step-settled').filter((command) => command === 'RECONCILE_EFFECT').length
      const verified = transitionRows.some((row) => row?.type === 'kernel-command' && row?.via === 'transition-terminal' && row?.command === 'VERIFY_SUCCESS' && row?.ok === true)
      const dispatches = transitionRows.filter((row) => row?.type === 'effect-dispatch' && row?.authority === true)
      const verifyAttempts = transitionRows.filter((row) => row?.type === 'verify-attempt')
      const verifyProvenance = transitionRows.filter((row) => row?.type === 'verify-provenance')
      const missingObservedProof = verifyAttempts.every((row) => Array.isArray(row.missingObservedProof) && row.missingObservedProof.length === 0)
      const problems = []
      if (!admitted) problems.push('gate-admit:ADMIT_TRANSITION')
      if (!activated) problems.push('gate-activate:ACQUIRE_DECLARED_RESOURCES')
      if (issueCount !== reservations.length) problems.push(`issue count ${issueCount} != reservations ${reservations.length}`)
      if (dispatchCount !== reservations.length) problems.push(`dispatch count ${dispatchCount} != reservations ${reservations.length}`)
      if (dispatches.length !== dispatchCount) problems.push('effect-dispatch authority rows do not cover every dispatch')
      if (settleCount !== reservations.length) problems.push(`settle count ${settleCount} != reservations ${reservations.length}`)
      if (!verified) problems.push('transition-terminal:VERIFY_SUCCESS')
      if (!missingObservedProof) problems.push('verify-attempt missingObservedProof is not empty')
      if (!verifyProvenance.some((row) => Array.isArray(row.factIds) && row.factIds.length > 0)) problems.push('verify-provenance factIds empty')
      if (gateDeniedRows.length > 0) problems.push(`gate-denied rows: ${gateDeniedRows.length}`)
      if (blockerRows.length > 0) problems.push(`blocker rows: ${blockerRows.length}`)
      const mechanicalStepCount = typeof transition.metrics?.mechanicalStepsPerTransition === 'number' ? transition.metrics.mechanicalStepsPerTransition : reservations.length
      if (issueCount !== mechanicalStepCount || dispatchCount !== mechanicalStepCount) problems.push(`gated effect count ${dispatchCount} != terminal mechanicalSteps ${mechanicalStepCount}`)
      if (problems.length) fail('authority:kernel-gates-live', 'kernel journal does not show the gated command path causally preceding every actuation for this Transition', { problems, transitionId: transition.transitionId })
      else pass('authority:kernel-gates-live', {
        transitionId: transition.transitionId,
        gatedSequence: 'admit -> activate -> issue+dispatch x' + dispatchCount + ' -> settle x' + settleCount + ' -> VERIFY_SUCCESS -> terminalize',
        dispatchAuthorityRows: dispatches.length,
        verifyFactIds: verifyProvenance.at(-1)?.factIds ?? [],
        gateDenials: 0,
      })
    }

    const terminalAt = Date.parse(outcomes[0]?.ts)
    if (Number.isFinite(terminalAt) && terminalAt <= times.shutdownAt) pass('run:terminal-before-shutdown', { terminalAt: outcomes[0].ts, shutdownAt: run.shutdownAt })
    else fail('run:terminal-before-shutdown', 'terminal outcome is absent, invalidly timed, or after shutdown')

    const worldTarget = transition.witness?.target
    const witnessRegionPath = witnessRegionRelativePath(worldTarget)
    if (witnessRegionPath === null) {
      incomplete('world:witness-plane', 'committed witness is absent or does not contain integer block coordinates')
      incomplete('required:world-witness-region', 'cannot derive the coordinate-specific MCA region without committed integer witness coordinates')
    } else {
      if (listing.files.includes(witnessRegionPath)) pass('required:world-witness-region', { path: witnessRegionPath })
      else incomplete(`required:${witnessRegionPath}`, 'MCA region containing the committed witness/support coordinates is absent', { witness: worldTarget })

      const plane = await inspectWitnessPlane(archive, listing.files, worldTarget)
      if (plane.status === 'INCOMPLETE') incomplete('world:witness-plane', plane.reason, { expectedRegion: plane.relativePath, witness: worldTarget })
      else {
        const rawSourceNames = transition.desiredPredicate?.proposition?.sourceNames
        const sourceNames = Array.isArray(rawSourceNames) ? [...new Set(rawSourceNames.map(normalizedBlockName).filter(Boolean))] : []
        const predicateItem = normalizedBlockName(transition.desiredPredicate?.proposition?.item)
        const missionItem = normalizedBlockName(probe.mission?.item)
        const expectedBlocks = sourceNames.length > 0 ? sourceNames : [predicateItem].filter(Boolean)
        if (missionItem === null || predicateItem === null) incomplete('world:witness-resource-binding', 'Mission or committed Reach predicate item is absent', { missionItem, predicateItem, sourceNames: expectedBlocks })
        else if (missionItem !== predicateItem) fail('world:witness-resource-binding', 'Mission item differs from the committed Reach predicate item', { missionItem, predicateItem, sourceNames: expectedBlocks })
        else pass('world:witness-resource-binding', { missionItem, predicateItem, sourceNames: expectedBlocks })

        const witnessBlock = normalizedBlockName(plane.witnessBlock)
        if (!expectedBlocks.includes(witnessBlock)) fail('world:witness-block', 'saved world does not contain a committed source name at the witness coordinates', { expected: expectedBlocks, observed: plane.witnessBlock, target: worldTarget, region: plane.relativePath })
        else pass('world:witness-block', { block: plane.witnessBlock, target: worldTarget, region: plane.relativePath })
        if (!plane.supportBlock || ['air', 'cave_air', 'void_air'].includes(normalizedBlockName(plane.supportBlock))) fail('world:witness-support', 'saved world lacks a solid support block beneath the witness', { observed: plane.supportBlock, position: { x: worldTarget.x, y: worldTarget.y - 1, z: worldTarget.z }, region: plane.relativePath })
        else pass('world:witness-support', { block: plane.supportBlock, position: { x: worldTarget.x, y: worldTarget.y - 1, z: worldTarget.z }, region: plane.relativePath })
      }
    }

    if (!RUN_ID_RE.test(String(runId)) || !fixtureCommands.length) incomplete('fixture:run-scoped', 'fixture command log is empty or runId is invalid')
    else {
      const witness = transition.witness?.target
      const anchorPath = 'runner/fixture-anchor-snapshot.json'
      const fixtureSetup = inspectFixtureWitnessSetup({
        fixtureCommands,
        missionItem: probe.mission?.item,
        desiredPredicate: transition.desiredPredicate,
        witness,
        sourceSha,
        run,
        serverStart,
        anchor: anchorSnapshot ?? null,
        anchorBytes: listing.files.includes(anchorPath) ? readFileSync(join(archive, anchorPath)) : null,
        initialSnapshot: snapshot ?? null,
        stdoutEvents,
      })
      if (fixtureSetup.status === 'PASS') pass('fixture:anchored-witness-setup', { witness: transition.witness.witnessId, ...fixtureSetup })
      else if (fixtureSetup.status === 'FAIL') fail('fixture:anchored-witness-setup', fixtureSetup.reason, fixtureSetup)
      else incomplete('fixture:anchored-witness-setup', fixtureSetup.reason, fixtureSetup)
      const rejectedCommands = fixtureCommands.filter((row) => /Rejected:/i.test(fixtureCommandOutput(row))).length
      pass('fixture:operator-command-journal', { recordedCommands: fixtureCommands.length, rejectedNoMutationAttempts: rejectedCommands })
    }
  }

  const fixtureProofPath = 'proofs/no-double-authority-fixture.json'
  const fixtureSourcePath = 'runner/fixtures/test-vtr-reach-executor-dispatch-authority.mts'
  if (!listing.files.includes(fixtureProofPath) || !listing.files.includes(fixtureSourcePath)) {
    incomplete('proof:no-double-authority-fixture', 'exact-source legacy claim refusal report or its test source bytes are absent', {
      reportPresent: listing.files.includes(fixtureProofPath), testSourcePresent: listing.files.includes(fixtureSourcePath),
    })
  } else {
    try {
      const fixtureReportBytes = readFileSync(join(archive, fixtureProofPath))
      const fixtureReport = JSON.parse(fixtureReportBytes.toString('utf8'))
      const fixtureSourceBytes = readFileSync(join(archive, fixtureSourcePath))
      const fixtureAssessment = inspectNoDoubleAuthorityFixtureProof({
        report: fixtureReport,
        reportBytes: fixtureReportBytes,
        testSourceBytes: fixtureSourceBytes,
        expectedSourceSha: probe?.source?.commit?.toLowerCase?.() ?? null,
        binding: probe?.noDoubleAuthorityFixture,
      })
      if (fixtureAssessment.status === 'PASS') pass('proof:no-double-authority-fixture', {
        sourceSha: fixtureReport.sourceSha, testSourceSha256: sha256(fixtureSourceBytes),
        transitionId: fixtureReport.fixture.transitionId, contractHash: fixtureReport.fixture.contractHash,
        pathfinderStartDelta: fixtureReport.fixture.pathfinderStartDelta,
        reason: fixtureAssessment.reason,
      })
      else if (fixtureAssessment.status === 'FAIL') fail('proof:no-double-authority-fixture', fixtureAssessment.reason)
      else incomplete('proof:no-double-authority-fixture', fixtureAssessment.reason)
    } catch (error) { fail('proof:no-double-authority-fixture', error.message) }
  }

  // Capability evidence is not the entire migration milestone. These two
  // run-scoped proofs are intentionally separate from a no-LLM mechanics probe.
  const fullMilestoneFiles = ['proofs/no-double-authority.json', 'comparison/legacy-baseline.json']
  const expectedLiveSourceSha = probe?.source?.commit
  for (const path of fullMilestoneFiles) {
    if (!listing.files.includes(path)) incomplete(`milestone:${path}`, 'full P0 acceptance requires this separate proof artifact')
    else {
      try {
        const proof = readJson(archive, path)
        if (path.endsWith('no-double-authority.json')) {
          if (typeof proof.sourceSha !== 'string' || !SHA_RE.test(proof.sourceSha)) incomplete(`milestone:${path}`, 'no-double-authority proof does not bind a full source SHA')
          else if (typeof expectedLiveSourceSha !== 'string' || !SHA_RE.test(expectedLiveSourceSha)) incomplete(`milestone:${path}`, 'live Transition source SHA is unavailable for binding the no-double-authority test')
          else if (proof.sourceSha.toLowerCase() !== expectedLiveSourceSha.toLowerCase()) fail(`milestone:${path}`, 'no-double-authority proof source SHA differs from the live Transition source', { expectedSourceSha: expectedLiveSourceSha, observedSourceSha: proof.sourceSha })
          else if (proof.result === 'PASS' && proof.legacyActuationCount === 0 && proof.vtrActuationCount > 0) pass(`milestone:${path}`, { sourceSha: proof.sourceSha, vtrActuationCount: proof.vtrActuationCount })
          else fail(`milestone:${path}`, 'no-double-authority proof is malformed or failed', { result: proof.result ?? null })
        } else {
          let expectedLegacyOriginMainSha = null
          if (repo !== null) {
            try {
              const observed = gitOutput(repo, ['rev-parse', '--verify', 'origin/main'])
              if (SHA_RE.test(observed)) expectedLegacyOriginMainSha = observed
            } catch {}
          }
          const comparisonCheck = inspectReachComparisonProof(proof, expectedLiveSourceSha, expectedLegacyOriginMainSha)
          if (comparisonCheck.status === 'PASS') pass(`milestone:${path}`, { reason: comparisonCheck.reason })
          else if (comparisonCheck.status === 'FAIL') fail(`milestone:${path}`, comparisonCheck.reason, comparisonCheck)
          else incomplete(`milestone:${path}`, comparisonCheck.reason, comparisonCheck)
        }
      } catch (error) { fail(`milestone:${path}`, error.message) }
    }
  }

  const summary = summarizeValidationStatuses(checks)
  return {
    schema: 'vtr-reach-evidence-validation/v1',
    ...summary,
    archive,
    exactSourceCheckout: repo,
    checks,
  }
}

async function main() {
  let args
  try { args = parseArgs(process.argv.slice(2)) } catch (error) {
    console.error(error.message)
    console.error(HELP)
    process.exit(EXIT.USAGE)
  }
  if (args.help) {
    console.log(HELP)
    process.exit(EXIT.PASS)
  }
  if (!args.archive) {
    console.error('--archive is required')
    console.error(HELP)
    process.exit(EXIT.USAGE)
  }
  const archive = resolve(args.archive)
  const repo = args.repo ? resolve(args.repo) : null
  if (!existsSync(archive) || !lstatSync(archive).isDirectory()) {
    console.error(`archive directory does not exist: ${archive}`)
    process.exit(EXIT.USAGE)
  }
  if (repo && (!existsSync(repo) || !lstatSync(repo).isDirectory())) {
    console.error(`repo directory does not exist: ${repo}`)
    process.exit(EXIT.USAGE)
  }
  const report = await validateEvidenceArchive(archive, repo)
  console.log(JSON.stringify(report, null, 2))
  process.exit(validationExitCode(report))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
