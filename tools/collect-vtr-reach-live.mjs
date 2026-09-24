#!/usr/bin/env node
// Read-only collector for one already-running VTR Reach probe.
//
// The resident must already have been configured with BUDDY_VTR_REACH_PROBE=1
// and the explicit offline profile. This tool does not start/reload a resident,
// issue Minecraft commands, or call anything except GET /api/ai-summary. It
// binds the captured Transition to the exact BOOT source/run and active
// GENERATION_READY generation, and reports verified success only when a
// deterministic VTR_VERIFY row precedes the matching typed SUCCESS outcome.
//
// Example:
//   node tools/collect-vtr-reach-live.mjs \
//     --host-log /path/to/buddy.log \
//     --run-journal /path/to/run.jsonl \
//     --jev-calls /path/to/jev-calls.jsonl \
//     --jev-decisions /path/to/decisions.jsonl \
//     --system2-journal /path/to/system2.jsonl \
//     --mission-file /path/to/mission.json \
//     --source-sha <40-char-BOOT-sha> \
//     --output /tmp/reach-capture.json

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const SHA_RE = /^[0-9a-f]{40}$/i
const MODEL_ACTIVITY_RE = /JEV_DECISION(?:_EPOCH_START|_FRAME)?|SYSTEM2_(?:PLAN|DECISION|PROVIDER|LLM)|(?:JEV|SYSTEM2)_MODEL_(?:CALL|REQUEST|RETRY|FAILURE)|(?:MODEL|PROVIDER)_(?:CALL|REQUEST|RETRY|FAILURE|UNAVAILABLE|FALLBACK)|FALLBACK_AFTER_PROVIDER_FAILURE|GatewayInternalServerError|Service temporarily unavailable|MODEL_UNAVAILABLE|HTTP 5\d\d/iu
const LEGACY_ACTUATION_RE = /(?:selectedBy=(?:jev|legacy|option|goalqueue)|LEGACY_ACTUATION|legacyActuation=true|authority=(?:legacy|option|goalqueue)|(?:GOAL_QUEUE|OPTION)_ACTUATION)/iu

const HELP = `Usage: node tools/collect-vtr-reach-live.mjs --host-log <buddy.log> --run-journal <run.jsonl>
  --jev-calls <jev-calls.jsonl> --jev-decisions <decisions.jsonl>
  --system2-journal <system2.jsonl> --mission-file <mission.json>
  --source-sha <40-char-BOOT-sha> --output <capture.json>
  [--observer-url http://127.0.0.1:4173/api/ai-summary]
  [--run-id <run-id> --generation-id <generation-id>]
  [--timeout-ms 150000] [--poll-ms 1000]

Observe an already-running resident. The tool only reads local files and sends
GET requests to a loopback observer. It never starts/reloads the bot or mutates
the Minecraft world. Exit codes: 0 captured proof, 1 contradictory evidence,
2 incomplete capture, 64 invalid arguments.

The output is a run-scoped collector report, not full P0 acceptance. Preserve
the referenced source logs and run the evidence validator separately.
`

function parseArgs(argv) {
  const out = {
    hostLog: null,
    runJournal: null,
    jevCalls: null,
    jevDecisions: null,
    system2Journal: null,
    missionFile: null,
    sourceSha: null,
    runId: null,
    generationId: null,
    output: null,
    observerUrl: 'http://127.0.0.1:4173/api/ai-summary',
    timeoutMs: 150_000,
    pollMs: 1_000,
    help: false,
  }
  const options = new Map([
    ['--host-log', 'hostLog'],
    ['--run-journal', 'runJournal'],
    ['--jev-calls', 'jevCalls'],
    ['--jev-decisions', 'jevDecisions'],
    ['--system2-journal', 'system2Journal'],
    ['--mission-file', 'missionFile'],
    ['--source-sha', 'sourceSha'],
    ['--run-id', 'runId'],
    ['--generation-id', 'generationId'],
    ['--output', 'output'],
    ['--observer-url', 'observerUrl'],
    ['--timeout-ms', 'timeoutMs'],
    ['--poll-ms', 'pollMs'],
  ])
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      out.help = true
      continue
    }
    const key = options.get(arg)
    if (key === undefined) throw new Error(`unknown argument: ${arg}`)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`)
    out[key] = key === 'timeoutMs' || key === 'pollMs' ? Number(value) : value
    index += 1
  }
  if (out.help) return out
  for (const key of ['hostLog', 'runJournal', 'jevCalls', 'jevDecisions', 'system2Journal', 'missionFile', 'sourceSha', 'output']) {
    if (typeof out[key] !== 'string' || out[key].trim() === '') throw new Error(`--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`)
  }
  if (!SHA_RE.test(out.sourceSha)) throw new Error('--source-sha must be a full 40-character SHA')
  if ((out.runId === null) !== (out.generationId === null)) throw new Error('--run-id and --generation-id must be supplied together')
  if (!Number.isSafeInteger(out.timeoutMs) || out.timeoutMs < 1_000 || out.timeoutMs > 900_000) throw new Error('--timeout-ms must be an integer in [1000, 900000]')
  if (!Number.isSafeInteger(out.pollMs) || out.pollMs < 100 || out.pollMs > 10_000) throw new Error('--poll-ms must be an integer in [100, 10000]')
  const observer = new URL(out.observerUrl)
  if (observer.protocol !== 'http:' && observer.protocol !== 'https:') throw new Error('--observer-url must use HTTP(S)')
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(observer.hostname)) throw new Error('--observer-url must point to a loopback host')
  if (observer.pathname !== '/api/ai-summary') throw new Error('--observer-url must target /api/ai-summary')
  return out
}

function parseJsonValue(raw) {
  try { return JSON.parse(raw) } catch { return raw }
}

/** Parse whitespace-delimited key=value fields while preserving compact JSON values. */
function parseKeyValues(input) {
  const fields = {}
  let cursor = 0
  while (cursor < input.length) {
    while (/\s/u.test(input[cursor] ?? '')) cursor += 1
    if (cursor >= input.length) break
    const keyStart = cursor
    while (cursor < input.length && !/[=\s]/u.test(input[cursor])) cursor += 1
    const key = input.slice(keyStart, cursor)
    if (input[cursor] !== '=') {
      while (cursor < input.length && !/\s/u.test(input[cursor])) cursor += 1
      continue
    }
    cursor += 1
    const valueStart = cursor
    const first = input[cursor]
    if (first === '{' || first === '[') {
      const stack = [first === '{' ? '}' : ']']
      let inString = false
      let escaped = false
      cursor += 1
      for (; cursor < input.length && stack.length > 0; cursor += 1) {
        const character = input[cursor]
        if (inString) {
          if (escaped) escaped = false
          else if (character === '\\') escaped = true
          else if (character === '"') inString = false
          continue
        }
        if (character === '"') inString = true
        else if (character === '{') stack.push('}')
        else if (character === '[') stack.push(']')
        else if (character === '}' || character === ']') {
          if (stack.at(-1) !== character) throw new Error(`malformed nested value for ${key}`)
          stack.pop()
        }
      }
      if (stack.length > 0) throw new Error(`unterminated JSON value for ${key}`)
    } else if (first === '"') {
      cursor += 1
      let escaped = false
      while (cursor < input.length) {
        const character = input[cursor++]
        if (escaped) escaped = false
        else if (character === '\\') escaped = true
        else if (character === '"') break
      }
    } else {
      while (cursor < input.length && !/\s/u.test(input[cursor])) cursor += 1
    }
    fields[key] = parseJsonValue(input.slice(valueStart, cursor))
  }
  return fields
}

export function parseHostLog(text) {
  const rows = []
  const linePattern = /^\[([^\]]+)\]\s+([A-Z][A-Z0-9_]*)\b(?:\s+(.*))?$/u
  for (const [index, raw] of text.split(/\r?\n/u).entries()) {
    const match = linePattern.exec(raw)
    if (!match) continue
    const timestamp = Date.parse(match[1])
    rows.push({
      line: index + 1,
      ts: Number.isFinite(timestamp) ? timestamp : null,
      event: match[2],
      fields: parseKeyValues(match[3] ?? ''),
      raw,
    })
  }
  return rows
}

export function parseJsonl(text, label = 'journal') {
  const rows = []
  const errors = []
  const lines = text.split(/\r?\n/u)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line.trim()) continue
    try {
      const value = JSON.parse(line)
      if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('row must be an object')
      rows.push(value)
    } catch (error) {
      const isUnterminatedFinalLine = index === lines.length - 1 && !text.endsWith('\n') && !text.endsWith('\r')
      if (!isUnterminatedFinalLine) errors.push(`${label}:${index + 1}: ${error.message}`)
    }
  }
  return { rows, errors }
}

function canonicalMission(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const kind = value.kind ?? value.missionKind
  const item = value.item ?? value.desiredPredicate?.proposition?.item ?? value.predicate?.item
  const count = value.count ?? value.desiredPredicate?.proposition?.count ?? value.predicate?.count
  if (typeof kind !== 'string' || typeof item !== 'string' || !Number.isSafeInteger(count) || count < 0) return null
  return { kind, item, count }
}

function sameJson(a, b) {
  const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical)
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
    }
    return value
  }
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
}

function token(message, name) {
  const pattern = new RegExp(`(?:^|\\s)${name}=([^\\s]+)`, 'u')
  return pattern.exec(message)?.[1] ?? null
}

function rowEvent(row) {
  if (typeof row?.message !== 'string') return null
  return /^\s*(?:\[[^\]]+\]\s*)?([A-Z][A-Z0-9_]*)\b/u.exec(row.message)?.[1] ?? null
}

function transitionId(row) {
  return row?.detail?.transitionId
    ?? row?.detail?.id
    ?? token(row?.message ?? '', 'transitionId')
    ?? token(row?.message ?? '', 'id')
    ?? null
}

function contractHash(row) {
  return row?.detail?.contractHash
    ?? row?.detail?.outcome?.contractHash
    ?? token(row?.message ?? '', 'contractHash')
    ?? null
}

function eventTime(row) {
  const value = Date.parse(row?.ts ?? row?.timestamp ?? row?.createdAt)
  return Number.isFinite(value) ? value : null
}

function worldKeyObject(value) {
  if (typeof value === 'string') {
    const parts = value.split('|')
    if (parts.length !== 3 || !parts[0] || !parts[1]) return null
    const epoch = Number(parts[2])
    if (!Number.isSafeInteger(epoch)) return null
    return { serverId: parts[0], dimension: parts[1].replace(/^minecraft:/u, ''), worldEpoch: epoch }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const serverId = value.serverId
  const dimension = value.dimension
  const worldEpoch = value.worldEpoch
  if (typeof serverId !== 'string' || !serverId || typeof dimension !== 'string' || !dimension || !Number.isSafeInteger(worldEpoch)) return null
  return { serverId, dimension: dimension.replace(/^minecraft:/u, ''), worldEpoch }
}

function identityFromSummary(summary) {
  const run = summary?.run
  const status = summary?.status
  const worldKey = worldKeyObject(run?.worldKey)
  if (typeof run?.id !== 'string' || typeof run?.sourceCommit !== 'string' || typeof run?.generationId !== 'string' || !worldKey) return null
  return {
    runId: run.id,
    sourceSha: run.sourceCommit.toLowerCase(),
    generationId: run.generationId,
    worldKey,
    live: status?.available === true && status?.connected === true && status?.frozen !== true,
  }
}

function identityFromPinnedLogs(hostRows, { sourceSha, runId, generationId }) {
  if (typeof runId !== 'string' || typeof generationId !== 'string') return null
  const boot = [...hostRows].reverse().find((row) => row.event === 'BOOT' && row.fields.runId === runId)
  const ready = [...hostRows].reverse().find((row) => row.event === 'GENERATION_READY'
    && row.fields.runId === runId
    && (row.fields.generationId ?? row.fields.id) === generationId)
  const bootSource = typeof boot?.fields.source === 'string' ? boot.fields.source.toLowerCase() : null
  const readySource = typeof ready?.fields.sourceSha === 'string' ? ready.fields.sourceSha.toLowerCase() : null
  const worldKey = worldKeyObject(boot?.fields.worldKey)
  if (boot === undefined || ready === undefined || bootSource !== sourceSha.toLowerCase() || readySource !== sourceSha.toLowerCase() || worldKey === null) return null
  return { runId, sourceSha: sourceSha.toLowerCase(), generationId, worldKey, live: false }
}

function identityEqual(a, b) {
  return a?.runId === b?.runId && a?.sourceSha === b?.sourceSha && a?.generationId === b?.generationId && sameJson(a?.worldKey, b?.worldKey)
}

function worldKeyString(identity) {
  if (!identity?.worldKey) return null
  const { serverId, dimension, worldEpoch } = identity.worldKey
  return `${serverId}|${dimension}|${worldEpoch}`
}

function parsePosition(value) {
  if (typeof value !== 'string') return null
  const match = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/u.exec(value)
  return match === null ? null : { x: Number(match[1]), y: Number(match[2]), z: Number(match[3]) }
}

function positionFromMovementMessage(message) {
  const match = /\bMOVE\s+\S+\s+arrival\s+start=\(([^)]+)\)\s+end=\(([^)]+)\)/u.exec(message ?? '')
  if (match === null) return null
  const parseTuple = (raw) => {
    const values = raw.split(',').map(Number)
    return values.length === 3 && values.every(Number.isFinite) ? { x: values[0], y: values[1], z: values[2] } : null
  }
  return { start: parseTuple(match[1]), end: parseTuple(match[2]) }
}

function check(id, status, observed, reason = null) {
  return { id, status, observed, ...(reason === null ? {} : { reason }) }
}

function parseJournalField(text, label) {
  const parsed = parseJsonl(text, label)
  return { ...parsed, records: parsed.rows.length }
}

function scopedJournalRows(journal, fromMs, toMs) {
  const scoped = []
  let unscoped = 0
  for (const row of journal.rows) {
    const timestamp = eventTime(row)
    if (timestamp === null) {
      unscoped += 1
      continue
    }
    if (timestamp < fromMs || timestamp > toMs) continue
    scoped.push(row)
  }
  return { rows: scoped, unscoped }
}

function hasModelActivity(message) {
  return MODEL_ACTIVITY_RE.test(String(message ?? ''))
}

function hasLegacyActuation(message) {
  return LEGACY_ACTUATION_RE.test(String(message ?? ''))
}

/** Evaluate a bounded capture from already-running runtime logs and observer snapshots. */
export function evaluateCapture(input) {
  const expectedMission = canonicalMission(input.mission)
  if (expectedMission === null) throw new Error('mission must contain kind, item, and non-negative integer count')
  const expectedSourceSha = String(input.expectedSourceSha ?? '').toLowerCase()
  if (!SHA_RE.test(expectedSourceSha)) throw new Error('expectedSourceSha must be a full 40-character SHA')

  const hostRows = parseHostLog(input.hostLogText ?? '')
  const runJournal = parseJournalField(input.runJournalText ?? '', 'run-journal')
  const journals = {
    jevCalls: parseJournalField(input.jevCallsText ?? '', 'jev-calls'),
    jevDecisions: parseJournalField(input.jevDecisionsText ?? '', 'jev-decisions'),
    system2: parseJournalField(input.system2Text ?? '', 'system2-journal'),
  }
  const observerSamples = Array.isArray(input.observerSamples) ? input.observerSamples : []
  const liveSamples = observerSamples
    .map((sample) => ({ sample, identity: identityFromSummary(sample?.summary) }))
    .filter((entry) => entry.identity !== null && entry.identity.live)
  const selected = liveSamples.find((entry) => entry.identity.sourceSha === expectedSourceSha
    && (input.expectedRunId === undefined || input.expectedRunId === null || entry.identity.runId === input.expectedRunId)
    && (input.expectedGenerationId === undefined || input.expectedGenerationId === null || entry.identity.generationId === input.expectedGenerationId)) ?? null
  const checks = []
  const pinnedIdentity = identityFromPinnedLogs(hostRows, {
    sourceSha: expectedSourceSha,
    runId: input.expectedRunId,
    generationId: input.expectedGenerationId,
  })
  if (selected !== null && pinnedIdentity !== null && !identityEqual(selected.identity, pinnedIdentity)) {
    checks.push(check('binding:run-generation-pins', 'FAIL', { observer: selected.identity, pinned: pinnedIdentity }, 'observer identity differs from the explicitly pinned BOOT/GENERATION_READY identity'))
    return {
      schema: 'vtr-reach-live-collector/v1',
      capturedAt: input.capturedAt ?? new Date().toISOString(),
      status: 'FAIL',
      acceptanceEligible: false,
      readOnly: true,
      expected: { sourceSha: expectedSourceSha, mission: expectedMission },
      observed: { observerSamples: observerSamples.length, observerIdentity: selected.identity, pinnedIdentity },
      checks,
      limitations: ['Observer and explicit log pins refer to different runs; evidence was not combined.'],
    }
  }
  const identity = selected?.identity ?? pinnedIdentity
  if (identity === null) {
    const latestIdentity = liveSamples.at(-1)?.identity ?? null
    const hasPins = typeof input.expectedRunId === 'string' && typeof input.expectedGenerationId === 'string'
    const sourceMismatch = !hasPins && latestIdentity !== null && latestIdentity.sourceSha !== expectedSourceSha
    checks.push(check('observer:exact-live-identity', sourceMismatch ? 'FAIL' : 'INCOMPLETE', latestIdentity, sourceMismatch ? 'observer source SHA differs from --source-sha' : 'no live observer sample bound to expected source/run/generation'))
    checks.push(check('binding:run-generation-pins', sourceMismatch ? 'FAIL' : 'INCOMPLETE', { expectedRunId: input.expectedRunId ?? null, expectedGenerationId: input.expectedGenerationId ?? null }, hasPins ? 'pinned ids could not be joined to exact BOOT and GENERATION_READY rows' : 'no live observer identity or explicit run/generation pins'))
    checks.push(check('capture:transition', 'INCOMPLETE', null, 'no stable BOOT-bound run/generation identity available'))
    return {
      schema: 'vtr-reach-live-collector/v1',
      capturedAt: input.capturedAt ?? new Date().toISOString(),
      status: sourceMismatch ? 'FAIL' : 'INCOMPLETE',
      acceptanceEligible: false,
      readOnly: true,
      expected: { sourceSha: expectedSourceSha, mission: expectedMission },
      observed: { observerSamples: observerSamples.length, latestIdentity },
      checks,
      limitations: ['No evidence was inferred from action return; a run/generation identity and deterministic VTR verification are required.'],
    }
  }

  const inputFiles = Array.isArray(input.inputFiles) ? input.inputFiles : []
  const missingInputs = inputFiles.filter((entry) => entry.status === 'missing').map((entry) => entry.name)
  const missingJournalNames = ['jev-calls', 'jev-decisions', 'system2-journal'].filter((name) => missingInputs.includes(name))
  const matchingLiveSamples = liveSamples.filter((entry) => identityEqual(entry.identity, identity))
  const differentSamples = selected === null ? [] : liveSamples.filter((entry) => !identityEqual(entry.identity, identity))
  const worldKey = worldKeyString(identity)
  const bootRows = hostRows.filter((row) => row.event === 'BOOT' && row.fields.runId === identity.runId)
  const boot = bootRows.at(-1) ?? null
  const bootSourceSha = typeof boot?.fields.source === 'string' ? boot.fields.source.toLowerCase() : null
  const bootMission = canonicalMission(boot?.fields.mission)
  const bootWorldKey = worldKeyObject(boot?.fields.worldKey)
  const bootIdentityMatches = boot !== null && bootSourceSha === expectedSourceSha && bootMission !== null && sameJson(bootMission, expectedMission)
    && bootWorldKey !== null && sameJson(bootWorldKey, identity.worldKey)
  checks.push(check('boot:source-run-mission', boot === null ? 'INCOMPLETE' : bootIdentityMatches ? 'PASS' : 'FAIL', {
    line: boot?.line ?? null,
    runId: boot?.fields.runId ?? null,
    sourceSha: bootSourceSha,
    mission: bootMission,
    worldKey: bootWorldKey,
  }, boot === null ? 'no BOOT line for observer runId' : bootIdentityMatches ? null : 'BOOT does not match expected source, mission, or observer world identity'))
  checks.push(check('observer:stable-identity', selected === null ? 'NOT_CAPTURED' : differentSamples.length === 0 ? 'PASS' : 'FAIL', {
    runId: identity.runId,
    generationId: identity.generationId,
    sourceSha: identity.sourceSha,
    worldKey: identity.worldKey,
    changedSamples: differentSamples.length,
  }, selected === null ? 'post-run capture used explicit log pins without a live observer bracket' : differentSamples.length === 0 ? null : 'observer run/generation/world identity changed during collection'))
  if (pinnedIdentity !== null) checks.push(check('binding:run-generation-pins', 'PASS', {
    runId: identity.runId,
    generationId: identity.generationId,
    sourceSha: identity.sourceSha,
    boundBy: 'BOOT+GENERATION_READY+explicit run/generation pins',
  }))
  checks.push(check('observer:exact-live-identity', selected !== null ? (matchingLiveSamples.length === liveSamples.length ? 'PASS' : 'FAIL') : 'NOT_CAPTURED', {
    matchingSamples: matchingLiveSamples.length,
    liveSamples: liveSamples.length,
    mode: selected === null ? 'persisted-run-capture' : 'live-observer-capture',
  }, selected === null ? 'post-run log pins supplied; no current live observer bracket is claimed' : matchingLiveSamples.length === liveSamples.length ? null : 'observer samples refer to a different run/generation'))
  checks.push(check('capture:source-files', missingInputs.length === 0 ? 'PASS' : 'INCOMPLETE', {
    missing: missingInputs,
    present: inputFiles.filter((entry) => entry.status === 'captured').map((entry) => entry.name),
  }, missingInputs.length === 0 ? null : 'one or more source files were unavailable during capture'))

  const readyRows = hostRows.filter((row) => row.event === 'GENERATION_READY'
    && (row.fields.runId === identity.runId)
    && (row.fields.generationId ?? row.fields.id) === identity.generationId)
  const ready = readyRows.at(-1) ?? null
  const spawn = hostRows.find((row) => row.event === 'SPAWN' && row.ts !== null
    && row.ts >= (boot?.ts ?? Number.NEGATIVE_INFINITY)
    && row.ts <= (ready?.ts ?? Number.POSITIVE_INFINITY)) ?? null
  const readySourceSha = typeof ready?.fields.sourceSha === 'string' ? ready.fields.sourceSha.toLowerCase() : null
  const readyMatches = ready !== null && readySourceSha === expectedSourceSha
    && ready.fields.productionPlanAuthority === 'vtr-reach-probe'
    && ready.fields.policy === 'fallback'
    && ready.fields.policyProvider === 'deterministic'
    && ready.fields.system2Provider === 'none'
  checks.push(check('generation:vtr-authority-source', ready === null ? 'INCOMPLETE' : readyMatches ? 'PASS' : 'FAIL', {
    line: ready?.line ?? null,
    runId: ready?.fields.runId ?? null,
    generationId: ready?.fields.generationId ?? ready?.fields.id ?? null,
    sourceSha: readySourceSha,
    productionPlanAuthority: ready?.fields.productionPlanAuthority ?? null,
    policy: ready?.fields.policy ?? null,
    policyProvider: ready?.fields.policyProvider ?? null,
    system2Provider: ready?.fields.system2Provider ?? null,
  }, ready === null ? 'no GENERATION_READY line for live observer generation' : readyMatches ? null : 'generation source or VTR/no-System2 authority marker conflicts'))

  const startTime = boot?.ts ?? Number.NEGATIVE_INFINITY
  const endTime = ready?.ts ?? Number.POSITIVE_INFINITY
  const between = (row) => row.ts !== null && row.ts >= startTime && row.ts <= endTime
  const configRows = hostRows.filter((row) => row.event === 'VTR_REACH_PROBE_CONFIGURED' && between(row))
  const config = configRows.at(-1) ?? null
  const configuredMission = canonicalMission(config?.fields.mission)
  const configuredOffline = config !== null
    && configuredMission !== null
    && sameJson(configuredMission, expectedMission)
    && config.fields.compatibilityLadder === 'observer-only'
    && config.fields.ledgerRestore === 'disabled'
    && config.fields.plannerBootstrap === 'disabled'
    && config.fields.system2Mode === 'off'
    && config.fields.jevPolicyMode === 'fallback'
  checks.push(check('probe:mission-offline-configuration', config === null ? 'INCOMPLETE' : configuredOffline ? 'PASS' : 'FAIL', {
    line: config?.line ?? null,
    mission: configuredMission,
    compatibilityLadder: config?.fields.compatibilityLadder ?? null,
    ledgerRestore: config?.fields.ledgerRestore ?? null,
    plannerBootstrap: config?.fields.plannerBootstrap ?? null,
    jevPolicyMode: config?.fields.jevPolicyMode ?? null,
    system2Mode: config?.fields.system2Mode ?? null,
  }, config === null ? 'VTR_REACH_PROBE_CONFIGURED missing between BOOT and GENERATION_READY' : configuredOffline ? null : 'configured Mission/offline profile differs from required VTR probe profile'))
  const queueRows = hostRows.filter((row) => row.event === 'VTR_REACH_PROBE_QUEUE_EMPTY' && between(row))
  const queue = queueRows.at(-1) ?? null
  const queueEmpty = queue !== null && queue.fields.authority === 'vtr-transition-scheduler' && String(queue.fields.restoredLegacyRows) === '0'
  checks.push(check('probe:empty-legacy-queue', queue === null ? 'INCOMPLETE' : queueEmpty ? 'PASS' : 'FAIL', {
    line: queue?.line ?? null,
    authority: queue?.fields.authority ?? null,
    restoredLegacyRows: queue?.fields.restoredLegacyRows ?? null,
  }, queue === null ? 'VTR_REACH_PROBE_QUEUE_EMPTY missing between BOOT and GENERATION_READY' : queueEmpty ? null : 'legacy queue restore was not explicitly empty'))

  const readyTime = ready?.ts ?? Number.POSITIVE_INFINITY
  const allRunRows = runJournal.rows.map((row, index) => ({ row, index, event: rowEvent(row), ts: eventTime(row) }))
  const commits = allRunRows.filter(({ row, event, ts }) => event === 'VTR_TRANSITION_COMMIT'
    && ts !== null && ts >= readyTime
    && row.detail?.identity?.generationId === identity.generationId
    && worldKeyObject(row.detail?.identity?.worldKey) !== null
    && sameJson(worldKeyObject(row.detail?.identity?.worldKey), identity.worldKey)
    && sameJson(canonicalMission(row.detail?.mission), expectedMission))
  const firstCommit = commits[0] ?? null
  let transitionRows = []
  let transition = null
  let transitionStatus = 'INCOMPLETE'
  if (firstCommit !== null) {
    const id = transitionId(firstCommit.row)
    const hash = contractHash(firstCommit.row)
    const afterCommit = allRunRows.filter(({ index }) => index >= firstCommit.index)
    const terminal = afterCommit.find(({ row, event }) => event === 'VTR_TRANSITION_OUTCOME'
      && transitionId(row) === id
      && contractHash(row) === hash) ?? null
    const captureRows = afterCommit.filter(({ row, event, index }) => {
      if (terminal !== null && index > terminal.index) return false
      return ['VTR_TRANSITION_COMMIT', 'VTR_TRANSITION_ACTUATION', 'VTR_MECHANICAL_STEP_RESERVED', 'VTR_MECHANICAL_OUTCOME', 'VTR_TRANSITION_VERIFY', 'VTR_TRANSITION_OUTCOME'].includes(event)
        && transitionId(row) === id
        && (contractHash(row) === null || hash === null || contractHash(row) === hash)
    })
    transitionRows = captureRows
    const verifyRows = captureRows.filter(({ event }) => event === 'VTR_TRANSITION_VERIFY')
    const outcomeRow = captureRows.find(({ event }) => event === 'VTR_TRANSITION_OUTCOME') ?? null
    const commitRow = firstCommit.row
    const commitTime = eventTime(commitRow)
    const terminalTime = outcomeRow === null ? null : eventTime(outcomeRow.row)
    const verifyRow = verifyRows.at(-1)?.row ?? null
    const verifyDetail = verifyRow?.detail ?? {}
    const outcomeDetail = outcomeRow?.row.detail ?? {}
    const typedOutcome = outcomeDetail.outcome ?? {}
    const metrics = outcomeDetail.metrics ?? {}
    const usage = outcomeDetail.usage ?? {}
    const ensure = commitRow.detail?.desiredPredicate
    const verifyPredicates = Array.isArray(verifyDetail.predicates) ? verifyDetail.predicates : []
    const verifiedPredicate = ensure === null || ensure === undefined ? null : verifyPredicates.find((entry) => entry.id === ensure.id)
    const evidenceIds = Array.isArray(typedOutcome.evidenceIds) ? typedOutcome.evidenceIds : []
    const verifyEvidenceIds = Array.isArray(verifyDetail.evidenceIds) ? verifyDetail.evidenceIds : []
    const verificationOk = verifyRow !== null
      && verifyDetail.truth === 'TRUE'
      && verifyDetail.identityMatches === true
      && verifyDetail.predicatesVerified === true
      && verifyDetail.contractHash === hash
      && verifyDetail.generationId === identity.generationId
      && String(verifyDetail.runId ?? '') === identity.runId
      && String(verifyDetail.sourceSha ?? '').toLowerCase() === expectedSourceSha
      && sameJson(worldKeyObject(verifyDetail.worldKey), identity.worldKey)
      && verifyDetail.observedAtMs === verifyDetail.verifiedAtMs
      && verifiedPredicate?.expected === true
      && verifiedPredicate?.truth === 'true'
      && typeof verifiedPredicate?.evidenceId === 'string'
      && evidenceIds.includes(verifiedPredicate.evidenceId)
      && verifyEvidenceIds.includes(verifiedPredicate.evidenceId)
      && captureRows.findIndex(({ event }) => event === 'VTR_TRANSITION_VERIFY') < (outcomeRow?.index ?? Number.POSITIVE_INFINITY)
    const actuationRows = captureRows.filter(({ event }) => event === 'VTR_TRANSITION_ACTUATION')
    const reservationRows = captureRows.filter(({ event }) => event === 'VTR_MECHANICAL_STEP_RESERVED')
    const mechanicalRows = captureRows.filter(({ event }) => event === 'VTR_MECHANICAL_OUTCOME')
    const actionIds = new Set(actuationRows.map(({ row }) => row.detail?.candidate ?? row.detail?.actionId).filter((value) => typeof value === 'string'))
    const skillStepRows = allRunRows.filter(({ row, event, ts }) => event === 'SKILL_STEP'
      && ts !== null && commitTime !== null && commitTime <= ts && ts <= (terminalTime ?? Number.POSITIVE_INFINITY)
      && actionIds.has(row.detail?.actionId))
    const executionEventRows = allRunRows.filter(({ row, event, ts }) => ts !== null
      && commitTime !== null && commitTime <= ts && ts <= (terminalTime ?? Number.POSITIVE_INFINITY)
      && actionIds.has(row.detail?.actionId)
      && (event === 'SKILL_STEP' || /\bMOVE\s+\S+\s+arrival\b/u.test(row.message ?? '')))
    const skillStepKindCounts = Object.fromEntries([...new Set(skillStepRows.map(({ row }) => row.detail?.stepKind).filter((value) => typeof value === 'string'))]
      .sort()
      .map((kind) => [kind, skillStepRows.filter(({ row }) => row.detail?.stepKind === kind).length]))
    const movementCompletion = executionEventRows.map(({ row }) => positionFromMovementMessage(row.message)).find((value) => value !== null) ?? null
    const metricsSteps = Number(metrics.mechanicalStepsPerTransition)
    const usageSteps = Number(usage.mechanicalSteps)
    const actuationIntentIds = new Set(actuationRows.map(({ row }) => row.detail?.intentId).filter((value) => typeof value === 'string'))
    const reservationsMatchActuation = reservationRows.length === metricsSteps
      && reservationRows.every(({ row }) => row.detail?.transitionId === id
        && typeof row.detail?.intentId === 'string'
        && actuationIntentIds.has(row.detail.intentId))
    const outcomeOk = outcomeRow !== null && typedOutcome.kind === 'SUCCESS'
      && ['verified-terminal', 'mechanical-step-outcome'].includes(outcomeDetail.boundary)
      && metrics.verifiedTransitionCompletion === 1
      && metrics.typedTerminalOutcome === 'SUCCESS'
      && metrics.duplicateAuthority === false
      && Number(metrics.duplicateAuthorityConflicts) === 0
      && metricsSteps > 0
      && usageSteps === metricsSteps
      && actuationRows.length > 0
      && reservationsMatchActuation
      && verificationOk
      && commitTime !== null && terminalTime !== null && commitTime <= terminalTime
    const identityOk = id !== null && hash !== null
      && worldKeyObject(commitRow.detail?.identity?.worldKey) !== null
      && sameJson(worldKeyObject(commitRow.detail.identity.worldKey), identity.worldKey)
      && commitRow.detail.identity.generationId === identity.generationId
      && commitRow.detail.identity.leaseId === identity.generationId
      && commitRow.detail.mission !== undefined
      && sameJson(canonicalMission(commitRow.detail.mission), expectedMission)
      && typeof commitRow.detail.desiredPredicate?.id === 'string'
      && Array.isArray(commitRow.detail.ensures)
      && commitRow.detail.ensures.some((entry) => entry.id === commitRow.detail.desiredPredicate.id && entry.expected === true && sameJson(entry.proposition, commitRow.detail.desiredPredicate.proposition))
    transitionStatus = outcomeRow === null ? 'INCOMPLETE' : identityOk && outcomeOk ? 'PASS' : 'FAIL'
    transition = {
      transitionId: id,
      contractHash: hash,
      mission: commitRow.detail?.mission ?? null,
      desiredPredicate: ensure ?? null,
      identity: commitRow.detail?.identity ?? null,
      sourceEventRows: captureRows.map(({ row }) => row),
      actionSkillReportedSuccessWasNotUsedAsTransitionTerminal: true,
      metrics: {
        verifiedTransitionCompletion: metrics.verifiedTransitionCompletion ?? null,
        mechanicalStepsPerTransition: metricsSteps,
        mechanicalStepReservations: reservationRows.length,
        observedMechanicalOutcomeRows: mechanicalRows.length,
        skillStepEventRows: skillStepRows.length,
        skillStepKindEventRows: skillStepKindCounts,
        observedCommitToTerminalMs: commitTime === null || terminalTime === null ? null : terminalTime - commitTime,
        jevCallsPerTransition: metrics.jevCallsPerTransition ?? null,
        system2CallsPerTransition: metrics.system2CallsPerTransition ?? null,
        modelCallsPerMechanicalStep: metrics.modelCallsPerMechanicalStep ?? null,
        typedTerminalOutcome: metrics.typedTerminalOutcome ?? typedOutcome.kind ?? null,
        duplicateAuthority: metrics.duplicateAuthority ?? null,
        duplicateAuthorityConflicts: metrics.duplicateAuthorityConflicts ?? null,
        usage,
      },
      verification: verifyRow,
      outcome: outcomeRow?.row ?? null,
      executionTrace: {
        actionIds: [...actionIds],
        skillStepEvents: executionEventRows.map(({ row }) => ({ message: row.message, detail: row.detail })),
        movementCompletion,
      },
      verificationOk,
      typedOutcomeOk: outcomeOk,
      mechanicalReservationsMatchActuation: reservationsMatchActuation,
      identityOk,
      validatorBoundaryCompatible: outcomeDetail.boundary === 'verified-terminal',
    }
    checks.push(check('transition:contract-and-world-binding', identityOk ? 'PASS' : 'FAIL', {
      transitionId: id,
      contractHash: hash,
      generationId: commitRow.detail?.identity?.generationId ?? null,
      leaseId: commitRow.detail?.identity?.leaseId ?? null,
      worldKey: commitRow.detail?.identity?.worldKey ?? null,
      ensures: ensure ?? null,
    }, identityOk ? null : 'commit contract/mission/ensures/identity is missing or differs from the bound run'))
    checks.push(check('transition:deterministic-verify-and-success', outcomeRow === null ? 'INCOMPLETE' : outcomeOk ? 'PASS' : 'FAIL', {
      verificationTruth: verifyDetail.truth ?? null,
      verificationEvidenceIds: verifyEvidenceIds,
      outcome: typedOutcome.kind ?? null,
      boundary: outcomeDetail.boundary ?? null,
      transitionId: id,
      contractHash: hash,
    }, outcomeRow === null ? 'committed Transition has not reached a typed terminal outcome' : outcomeOk ? null : 'SUCCESS lacks a matching deterministic TRUE verification or typed metrics'))
    if (outcomeRow !== null && outcomeDetail.boundary !== 'verified-terminal') {
      checks.push(check('schema:validator-boundary-compatibility', 'INCOMPLETE', {
        observedBoundary: outcomeDetail.boundary,
        deterministicVerifyBeforeSuccess: verificationOk,
        sourceCodeBoundaryAtMechanicalSuccess: 'mechanical-step-outcome',
        evidenceValidatorExpectedBoundary: 'verified-terminal',
      }, 'current source emits mechanical-step-outcome for SUCCESS from mechanical completion, while the archival validator requires verified-terminal'))
    } else if (outcomeRow !== null) {
      checks.push(check('schema:validator-boundary-compatibility', 'PASS', { observedBoundary: outcomeDetail.boundary }))
    }
  } else {
    checks.push(check('transition:contract-and-world-binding', 'INCOMPLETE', null, 'no Reach Transition commit for the live BOOT/run/generation/mission'))
    checks.push(check('transition:deterministic-verify-and-success', 'INCOMPLETE', null, 'no Reach Transition commit for the live BOOT/run/generation/mission'))
  }

  const terminalTime = transition?.outcome === null || transition?.outcome === undefined ? null : eventTime(transition.outcome)
  const modelStart = ready?.ts ?? Number.NEGATIVE_INFINITY
  const modelEnd = terminalTime ?? Number.POSITIVE_INFINITY
  const scopedJournals = Object.fromEntries(Object.entries(journals).map(([name, journal]) => [name, scopedJournalRows(journal, modelStart, modelEnd)]))
  const malformedJournal = Object.values(journals).some((journal) => journal.errors.length > 0)
  const unscopedJournalRows = Object.values(scopedJournals).reduce((sum, entry) => sum + entry.unscoped, 0)
  const nonEmptyDuringProbe = Object.values(scopedJournals).flatMap((entry) => entry.rows)
  const callCountersZero = transition !== null
    && Number(transition.metrics.jevCallsPerTransition) === 0
    && Number(transition.metrics.system2CallsPerTransition) === 0
    && Number(transition.metrics.modelCallsPerMechanicalStep) === 0
  const modelMarkers = allRunRows.filter(({ ts, row }) => ts !== null && ts >= modelStart && ts <= modelEnd && hasModelActivity(row.message))
  const modelHostMarkers = hostRows.filter((row) => row.ts !== null && row.ts >= modelStart && row.ts <= modelEnd && MODEL_ACTIVITY_RE.test(row.raw))
  const noModelObserved = callCountersZero && nonEmptyDuringProbe.length === 0 && modelMarkers.length === 0 && modelHostMarkers.length === 0
    && unscopedJournalRows === 0 && !malformedJournal
    && missingJournalNames.length === 0 && readyMatches && configuredOffline
  const modelEvidenceContradiction = callCountersZero === false || nonEmptyDuringProbe.length > 0 || modelMarkers.length > 0 || modelHostMarkers.length > 0 || malformedJournal
  const modelEvidenceUnknown = unscopedJournalRows > 0 || missingJournalNames.length > 0
  const modelCheckStatus = !readyMatches || !configuredOffline || modelEvidenceContradiction ? 'FAIL'
    : transition === null || terminalTime === null || modelEvidenceUnknown ? 'INCOMPLETE'
      : noModelObserved ? 'PASS' : 'INCOMPLETE'
  checks.push(check('policy:no-model-activity-during-probe', modelCheckStatus, {
    profile: { jevPolicyMode: config?.fields.jevPolicyMode ?? null, system2Mode: config?.fields.system2Mode ?? null, effectiveJev: ready?.fields.policyProvider ?? null, effectiveSystem2: ready?.fields.system2Provider ?? null },
    counters: { jev: transition?.metrics.jevCallsPerTransition ?? null, system2: transition?.metrics.system2CallsPerTransition ?? null, perStep: transition?.metrics.modelCallsPerMechanicalStep ?? null },
    providerJournalRowsDuringProbe: Object.fromEntries(Object.entries(scopedJournals).map(([name, value]) => [name, value.rows.length])),
    unscopedProviderJournalRows: unscopedJournalRows,
    missingProviderJournals: missingJournalNames,
    malformedProviderJournals: Object.entries(journals).filter(([, journal]) => journal.errors.length > 0).map(([name]) => name),
    modelActivityRunRows: modelMarkers.length,
    modelActivityHostLines: modelHostMarkers.length,
  }, !readyMatches || !configuredOffline ? 'VTR offline profile did not bind' : modelEvidenceContradiction ? 'model counters, journals, or activity markers indicate model/provider activity' : transition === null || terminalTime === null || modelEvidenceUnknown ? 'cannot prove model silence: terminal outcome, provider journals, or journal scope is missing' : null))

  const commitTime = transition === null ? null : eventTime(transition.sourceEventRows[0])
  const duplicateRows = commitTime === null || terminalTime === null ? [] : [
    ...allRunRows.filter(({ ts, row }) => ts !== null && ts >= commitTime && ts <= terminalTime && hasLegacyActuation(row.message)).map(({ row }) => row.message),
    ...hostRows.filter((row) => row.ts !== null && row.ts >= commitTime && row.ts <= terminalTime && hasLegacyActuation(row.raw)).map((row) => row.raw),
  ]
  const noDuplicate = transition !== null && transition.metrics.duplicateAuthority === false
    && Number(transition.metrics.duplicateAuthorityConflicts) === 0 && duplicateRows.length === 0
  checks.push(check('authority:no-double-actuation-observed', transition === null || terminalTime === null ? 'INCOMPLETE' : noDuplicate ? 'PASS' : 'FAIL', {
    runtimeDuplicateAuthority: transition?.metrics.duplicateAuthority ?? null,
    conflictCount: transition?.metrics.duplicateAuthorityConflicts ?? null,
    legacyActuationMarkers: duplicateRows,
  }, transition === null || terminalTime === null ? 'no completed Transition to inspect' : noDuplicate ? null : 'runtime conflict metric or legacy authority marker observed'))

  const requiredStatus = checks.some((entry) => entry.status === 'FAIL') ? 'FAIL'
    : checks.some((entry) => entry.status === 'INCOMPLETE') ? 'INCOMPLETE' : 'PASS'
  const sampleProjection = (sample) => {
    const summary = sample?.summary
    const id = identityFromSummary(summary)
    return {
      capturedAt: sample?.capturedAt ?? null,
      requestOk: sample?.requestOk === true,
      error: sample?.error ?? null,
      freshnessMs: summary?.freshnessMs ?? null,
      status: summary?.status ?? null,
      identity: id,
      mission: summary?.mission?.predicate ?? null,
      worldObservation: summary?.worldObservation ?? null,
      vtrStatus: summary?.vtr?.status ?? summary?.choices?.vtr?.status ?? null,
    }
  }
  return {
    schema: 'vtr-reach-live-collector/v1',
    capturedAt: input.capturedAt ?? new Date().toISOString(),
    status: requiredStatus,
    acceptanceEligible: false,
    readOnly: true,
    expected: { sourceSha: expectedSourceSha, mission: expectedMission },
    observed: {
      sourceSha: identity.sourceSha,
      runId: identity.runId,
      generationId: identity.generationId,
      worldKey,
      worldIdentity: identity.worldKey,
      boot: boot === null ? null : { timestamp: boot.raw.slice(1, boot.raw.indexOf(']')), line: boot.line, mission: bootMission },
      generationReady: ready === null ? null : { timestamp: ready.raw.slice(1, ready.raw.indexOf(']')), line: ready.line, buildHash: ready.fields.buildHash ?? null },
      spawn: spawn === null ? null : {
        timestamp: spawn.raw.slice(1, spawn.raw.indexOf(']')),
        line: spawn.line,
        position: parsePosition(spawn.fields.pos),
        dimension: spawn.fields.dimension ?? null,
        worldEpoch: spawn.fields.worldEpoch ?? null,
      },
      configuredNoLlmProbe: config === null ? null : {
        mission: configuredMission,
        BUDDY_POLICY: config.fields.jevPolicyMode ?? null,
        BUDDY_SYSTEM2: config.fields.system2Mode ?? null,
        compatibilityLadder: config.fields.compatibilityLadder ?? null,
        ledgerRestore: config.fields.ledgerRestore ?? null,
        plannerBootstrap: config.fields.plannerBootstrap ?? null,
        queueAuthority: queue?.fields.authority ?? null,
        restoredLegacyRows: queue?.fields.restoredLegacyRows ?? null,
        productionPlanAuthority: ready?.fields.productionPlanAuthority ?? null,
        effectiveJevProvider: ready?.fields.policyProvider ?? null,
        effectiveSystem2Provider: ready?.fields.system2Provider ?? null,
        networkModelCallsObserved: noModelObserved ? 0 : null,
        silentFallbackOnProviderFailure: 'not_exercised; see limitation',
      },
      transition,
      observer: {
        url: input.observerUrl ?? 'http://127.0.0.1:4173/api/ai-summary',
        method: 'GET',
        boundSamples: matchingLiveSamples.length,
        samples: observerSamples.map(sampleProjection),
      },
      inputs: input.inputFiles ?? [],
    },
    checks,
    limitations: [
      'This collector observes an already-running resident; it does not create or reconfigure a Mission or generation.',
      'acceptanceEligible=false: preserve the referenced raw artifacts and run tools/validate-vtr-reach-evidence.mjs for full run-scoped acceptance.',
      'No provider fallback was exercised; absence of a fallback event during this probe does not prove outage-recovery behavior.',
      'The current VTR slice exposes inventory_at_least Missions and derives a resource-source Reach predicate; other Mission/controller families are not covered.',
    ],
  }
}

function readOptional(path, label) {
  const absolute = resolve(path)
  if (!existsSync(absolute)) return { name: label, path: absolute, status: 'missing', text: '' }
  const text = readFileSync(absolute, 'utf8')
  const stat = statSync(absolute)
  return { name: label, path: absolute, status: 'captured', text, bytes: stat.size, sha256: createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex') }
}

function readMission(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  const mission = canonicalMission(raw)
  if (mission === null || mission.kind !== 'inventory_at_least') throw new Error('mission file must define an inventory_at_least Mission with kind, item, and count')
  return mission
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

async function fetchObserverSample(fetchImpl, observerUrl) {
  const capturedAt = new Date().toISOString()
  try {
    const response = await fetchImpl(observerUrl, { method: 'GET', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5_000) })
    if (response?.ok === false) return { capturedAt, requestOk: false, error: `HTTP ${response.status}` }
    const payload = typeof response?.json === 'function' ? await response.json() : response
    const summary = payload?.summary ?? payload
    if (summary === null || typeof summary !== 'object' || Array.isArray(summary)) {
      return { capturedAt, requestOk: false, error: 'observer response was not a JSON object' }
    }
    return { capturedAt, requestOk: true, summary }
  } catch (error) {
    return { capturedAt, requestOk: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function captureHasTerminal(hostText, runText, identity, mission) {
  if (identity === null) return false
  const hostRows = parseHostLog(hostText)
  const ready = hostRows.find((row) => row.event === 'GENERATION_READY'
    && row.fields.runId === identity.runId
    && (row.fields.generationId ?? row.fields.id) === identity.generationId)
  if (ready === undefined) return false
  const parsed = parseJsonl(runText, 'run-journal')
  const rows = parsed.rows.map((row) => ({ row, event: rowEvent(row), ts: eventTime(row) }))
  for (const entry of rows) {
    if (entry.event !== 'VTR_TRANSITION_COMMIT' || entry.ts === null || entry.ts < ready.ts) continue
    if (entry.row.detail?.identity?.generationId !== identity.generationId) continue
    if (!sameJson(worldKeyObject(entry.row.detail?.identity?.worldKey), identity.worldKey)) continue
    if (!sameJson(canonicalMission(entry.row.detail?.mission), mission)) continue
    const id = transitionId(entry.row)
    const hash = contractHash(entry.row)
    if (rows.some((candidate) => candidate.event === 'VTR_TRANSITION_OUTCOME' && transitionId(candidate.row) === id && contractHash(candidate.row) === hash)) return true
  }
  return false
}

export async function collectLive(argv = process.argv.slice(2), { fetchImpl = fetch } = {}) {
  const options = parseArgs(argv)
  if (options.help) return { exitCode: 0, report: null, stdout: HELP }
  const mission = readMission(options.missionFile)
  const inputPaths = [
    ['host-log', options.hostLog],
    ['run-journal', options.runJournal],
    ['jev-calls', options.jevCalls],
    ['jev-decisions', options.jevDecisions],
    ['system2-journal', options.system2Journal],
  ]
  const inputFiles = []
  const samples = []
  const deadline = Date.now() + options.timeoutMs
  let stableIdentity = null
  while (Date.now() <= deadline) {
    const sample = await fetchObserverSample(fetchImpl, options.observerUrl)
    samples.push(sample)
    const liveIdentity = identityFromSummary(sample?.summary)
    if (liveIdentity !== null && liveIdentity.live) {
      const pinsMatch = (options.runId === null || liveIdentity.runId === options.runId)
        && (options.generationId === null || liveIdentity.generationId === options.generationId)
      if (!pinsMatch) break
      if (liveIdentity.sourceSha !== options.sourceSha.toLowerCase()) {
        stableIdentity = liveIdentity
        break
      }
      if (stableIdentity === null) stableIdentity = liveIdentity
      else if (!identityEqual(stableIdentity, liveIdentity)) {
        break
      }
      if (existsSync(options.hostLog) && existsSync(options.runJournal)) {
        const hostCapture = readFileSync(options.hostLog, 'utf8')
        const journalCapture = readFileSync(options.runJournal, 'utf8')
        if (captureHasTerminal(hostCapture, journalCapture, stableIdentity, mission)) {
          samples.push(await fetchObserverSample(fetchImpl, options.observerUrl))
          break
        }
      }
    } else if (options.runId !== null) {
      // Post-run capture: explicit pins are joined directly to persisted BOOT
      // and GENERATION_READY records, so no live observer bracket is required.
      break
    }
    if (Date.now() >= deadline) break
    await sleep(options.pollMs)
  }
  const capturedFiles = inputPaths.map(([name, path]) => readOptional(path, name))
  for (const content of capturedFiles) {
    const { text, ...metadata } = content
    inputFiles.push(metadata)
  }
  const texts = Object.fromEntries(capturedFiles.map(({ name, text }) => [name, text]))
  const report = evaluateCapture({
    hostLogText: texts['host-log'],
    runJournalText: texts['run-journal'],
    jevCallsText: texts['jev-calls'],
    jevDecisionsText: texts['jev-decisions'],
    system2Text: texts['system2-journal'],
    mission,
    expectedSourceSha: options.sourceSha,
    observerSamples: samples,
    observerUrl: options.observerUrl,
    expectedRunId: options.runId,
    expectedGenerationId: options.generationId,
    inputFiles,
  })
  report.captureWindow = { startedAt: samples[0]?.capturedAt ?? null, endedAt: samples.at(-1)?.capturedAt ?? null, sampleCount: samples.length, timeoutMs: options.timeoutMs }
  const outputPath = resolve(options.output)
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'w', mode: 0o600 })
  return {
    exitCode: report.status === 'PASS' ? 0 : report.status === 'FAIL' ? 1 : 2,
    report,
    stdout: JSON.stringify({ status: report.status, output: outputPath, runId: report.observed?.runId ?? null, generationId: report.observed?.generationId ?? null, transitionId: report.observed?.transition?.transitionId ?? null }),
  }
}

async function main(argv) {
  try {
    const result = await collectLive(argv)
    if (result.stdout === HELP) process.stdout.write(result.stdout)
    else process.stdout.write(`${result.stdout}\n`)
    return result.exitCode
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.stderr.write(HELP)
    return 64
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2))
}
