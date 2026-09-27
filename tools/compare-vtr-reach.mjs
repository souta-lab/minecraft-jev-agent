#!/usr/bin/env bun
// Read-only comparison of an old-path Reach observation with a VTR Reach probe.
//
// Usage:
//   bun tools/compare-vtr-reach.mjs <legacy-artifact.json> <vtr-probe.json>
//
// Supported legacy inputs:
//   - reach-old-vtr-comparison/v1 (uses its `baseline` and `comparison` sections)
//   - legacy-reach-comparator/v1 (uses its `sliceMetrics`, `fixture`, and `events`)
// Supported VTR input:
//   - vtr-reach-live-probe/v1
//
// This tool only reads its inputs/archive evidence and writes a JSON report to
// stdout. Summary-only reports remain INCOMPLETE; PASS requires aligned runs
// and an integrity-bound archive of the relevant raw events from both paths.
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { execFileSync } from 'node:child_process'
import { inspectReachComparisonProof } from './validate-vtr-reach-evidence.mjs'
import { normalizeLegacyCollectMissionCommand } from './vtr-reach-legacy-baseline.mjs'

const SHA_RE = /^[0-9a-f]{40}$/i

function resolveOriginMainSha() {
  try {
    const sha = execFileSync('git', ['rev-parse', '--verify', 'origin/main'], { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return SHA_RE.test(sha) ? sha.toLowerCase() : null
  } catch {
    return null
  }
}

const CURRENT_ORIGIN_MAIN_SHA = resolveOriginMainSha()

function usage() {
  console.error('usage: bun tools/compare-vtr-reach.mjs <legacy-artifact.json> <vtr-probe.json>')
  process.exit(2)
}

const inputPaths = process.argv.slice(2)
if (inputPaths.length !== 2 || inputPaths.some((value) => value.startsWith('--'))) usage()
const [legacyPath, vtrPath] = inputPaths.map((path) => resolve(path))

function readJson(path, label) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(`${label}: cannot read ${path}: ${error.message}`)
  }
  try {
    return { value: JSON.parse(text), sourceText: text, sourceBytes: Buffer.from(text, 'utf8') }
  } catch (error) {
    throw new Error(`${label}: invalid JSON in ${path}: ${error.message}`)
  }
}

function record(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must be a JSON object`)
  }
  return value
}

function text(value, path) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${path} must be a non-empty string`)
  return value
}

function count(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${path} must be a non-negative integer`)
  return value
}

function ratio(value, path) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${path} must be a finite non-negative number`)
  return value
}

const VTR_TRANSITION_MODEL_METRICS = 'VTR_TRANSITION_MODEL_METRICS'

function eventToken(line, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|\\s)${escaped}=([^\\s]+)`).exec(line)?.[1] ?? null
}

function eventCount(line, name, pathLabel) {
  const value = eventToken(line, name)
  if (value === null || !/^\d+$/.test(value)) throw new Error(`${pathLabel}.${name} must be a non-negative integer`)
  return count(Number(value), `${pathLabel}.${name}`)
}

function parseTransitionModelMetricsEventLines(lines, transitionId, contractHash, pathLabel) {
  const matching = []
  for (const line of lines) {
    const markerAt = line.indexOf(VTR_TRANSITION_MODEL_METRICS)
    if (markerAt < 0) continue
    const event = line.slice(markerAt)
    if (eventToken(event, 'transitionId') !== transitionId) continue
    const observedContractHash = eventToken(event, 'contractHash')
    if (observedContractHash !== contractHash) {
      throw new Error(`${pathLabel} ${VTR_TRANSITION_MODEL_METRICS} contractHash does not match the committed Transition`)
    }
    matching.push({
      transitionId,
      contractHash,
      outcome: text(eventToken(event, 'outcome'), `${pathLabel}.outcome`),
      mechanicalSteps: eventCount(event, 'mechanicalSteps', pathLabel),
      decisionFrameInvocations: eventCount(event, 'decisionFrameInvocations', pathLabel),
      providerEvaluateAttempts: eventCount(event, 'providerEvaluateAttempts', pathLabel),
      source: pathLabel,
    })
  }
  if (matching.length > 1) {
    throw new Error(`${pathLabel} contains ${matching.length} ${VTR_TRANSITION_MODEL_METRICS} rows for Transition ${transitionId}`)
  }
  return matching[0] ?? null
}

function transitionModelMetricsFromSequence(transition, transitionId, contractHash) {
  const lines = Array.isArray(transition.eventSequence)
    ? transition.eventSequence.filter((line) => typeof line === 'string')
    : []
  return parseTransitionModelMetricsEventLines(
    lines,
    transitionId,
    contractHash,
    'transition.eventSequence',
  )
}

function transitionModelMetricsFromRunJsonl(path, transitionId, contractHash) {
  if (!existsSync(path)) return null
  const messages = []
  for (const [index, line] of readFileSync(path, 'utf8').split(/\r?\n/).entries()) {
    if (line.trim() === '') continue
    let row
    try { row = JSON.parse(line) } catch (error) {
      throw new Error(`${path}:${index + 1}: invalid JSONL (${error.message})`)
    }
    if (typeof row?.message === 'string' && row.message.includes(VTR_TRANSITION_MODEL_METRICS)) messages.push(row.message)
  }
  return parseTransitionModelMetricsEventLines(messages, transitionId, contractHash, 'runner/run.jsonl')
}

function sameTransitionModelMetrics(left, right) {
  return left.transitionId === right.transitionId
    && left.contractHash === right.contractHash
    && left.outcome === right.outcome
    && left.mechanicalSteps === right.mechanicalSteps
    && left.decisionFrameInvocations === right.decisionFrameInvocations
    && left.providerEvaluateAttempts === right.providerEvaluateAttempts
}

function closeEnough(a, b) {
  return Math.abs(a - b) <= 0.011
}

function normalizeDimension(value) {
  return String(value).replace(/^minecraft:/, '')
}

function structuredMission(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const predicate = raw.desiredPredicate?.proposition ?? raw.predicate?.proposition ?? raw.predicate ?? raw
  const item = raw.item ?? predicate?.item
  const countValue = raw.count ?? predicate?.count
  const kind = raw.kind ?? raw.missionKind ?? raw.desiredPredicate?.proposition?.kind ?? raw.predicate?.kind
  if (typeof item !== 'string' || !Number.isSafeInteger(countValue) || countValue < 0 || typeof kind !== 'string') return null
  return { kind, item, count: countValue }
}

function vectorDifference(position, origin, floorOrigin = false) {
  if (!position || !origin || !['x', 'y', 'z'].every((key) => Number.isFinite(position[key]) && Number.isFinite(origin[key]))) return null
  return Object.fromEntries(['x', 'y', 'z'].map((key) => [
    key,
    position[key] - (floorOrigin ? Math.floor(origin[key]) : origin[key]),
  ]))
}

function structuredFixture(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const source = raw.relativeResourceSource ?? raw.witness ?? raw
  const position = source.position ?? raw.position ?? raw.sourcePosition ?? raw.targetPosition ?? null
  // A Reach slice may teleport the bot from its boot/spawn position to the
  // controlled fixture before committing the Transition. Use the recorded
  // transition start when available; `mission.initialPosition` can predate
  // that harness setup and describe a different geometry.
  const transitionStartPosition = raw.transitionStartPosition ?? source.transitionStartPosition ?? null
  const player = transitionStartPosition ?? raw.initialPlayerPosition ?? raw.playerPosition ?? raw.mission?.initialPosition ?? null
  const initialPlayerPositionSource = transitionStartPosition !== null
    ? (raw.transitionStartPosition !== undefined ? 'transitionStartPosition' : 'relativeResourceSource.transitionStartPosition')
    : raw.initialPlayerPosition !== undefined
      ? 'initialPlayerPosition'
      : raw.playerPosition !== undefined
        ? 'playerPosition'
        : raw.mission?.initialPosition !== undefined
          ? 'mission.initialPosition'
          : null
  const exactCartesianDelta = vectorDifference(position, player)
  const relativeBlockOffset = vectorDifference(position, player, true)
  const declaredOffset = raw.sourceOffsetFromInitialPlayer ?? raw.relativeOffset ?? raw.offset ?? null
  const declaredOffsetConvention = raw.sourceOffsetFromInitialPlayer !== undefined
    ? 'block-origin-relative'
    : raw.offset !== undefined || raw.relativeOffset !== undefined
      ? 'exact-cartesian-delta'
      : null
  const comparedOffset = declaredOffsetConvention === 'block-origin-relative' ? relativeBlockOffset : exactCartesianDelta
  const declaredOffsetMatchesDerived = declaredOffset === null || comparedOffset === null
    ? null
    : ['x', 'y', 'z'].every((key) => closeEnough(declaredOffset[key], comparedOffset[key]))
  const block = source.block ?? raw.block ?? raw.resourceKind ?? raw.targetBlock ?? null
  const flat = raw.flatSolidGround
  if (typeof block !== 'string' || !position || relativeBlockOffset === null) return null
  return {
    block: block.replace(/^minecraft:/, ''),
    position,
    initialPlayerPosition: player,
    initialPlayerPositionSource,
    initialPlayerPositionEvidence: raw.transitionStartEvidence ?? raw.initialPlayerPositionEvidence ?? null,
    exactCartesianDelta,
    relativeBlockOffset,
    declaredOffset,
    declaredOffsetConvention,
    declaredOffsetMatchesDerived,
    flatSolidGround: typeof flat === 'boolean' ? flat : null,
    witnessChosenByProductionSensor: typeof raw.witnessChosenByProductionSensor === 'boolean' ? raw.witnessChosenByProductionSensor : null,
  }
}

function readOptionalJson(path, label) {
  if (!existsSync(path)) return null
  return readJson(path, label).value
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function archiveAncestors(inputPath) {
  const roots = []
  let current = dirname(resolve(inputPath))
  while (true) {
    roots.push(current)
    const parent = dirname(current)
    if (parent === current) return roots
    current = parent
  }
}

function legacyEvidenceMatches(evidence, expected) {
  return evidence !== null && Object.entries(expected).every(([key, wanted]) => evidence[key] === wanted)
}

function normalizedMissionFromLegacyArchive(root, evidence) {
  if (!root || !evidence?.fixture?.block) return null
  const path = join(root, 'runner/human-task-input.jsonl')
  if (!existsSync(path)) return null
  const rows = readFileSync(path, 'utf8').split(/\r?\n/).filter((line) => line.trim() !== '').map((line, index) => {
    try { return JSON.parse(line) } catch (error) { throw new Error(`${path}:${index + 1}: invalid JSONL (${error.message})`) }
  })
  const submitted = rows.filter((row) => row.event === 'chat_sent_after_intent_listener_ready' && typeof row.command === 'string')
  if (submitted.length !== 1) return null
  return normalizeLegacyCollectMissionCommand(submitted[0].command, evidence.fixture.block)?.mission ?? null
}

function findLegacyArchive(inputPath, expected) {
  const mismatches = []
  for (const root of archiveAncestors(inputPath)) {
    const evidencePath = join(root, 'runner', 'reach-slice-evidence.json')
    if (!existsSync(evidencePath)) continue
    const evidence = readOptionalJson(evidencePath, 'legacy Reach slice evidence')
    if (legacyEvidenceMatches(evidence, expected)) return { root, evidence }
    mismatches.push({ root, observed: Object.fromEntries(Object.keys(expected).map((key) => [key, evidence?.[key] ?? null])) })
  }
  if (mismatches.length) {
    throw new Error(`no legacy archive ancestor has run-bound reach-slice-evidence.json matching ${JSON.stringify(expected)}; candidates=${JSON.stringify(mismatches)}`)
  }
  return null
}

function findVtrArchive(inputPath, raw) {
  const expected = raw?.record === 'vtr-reach-live-probe'
    ? { runId: raw.runId, generationId: raw.generationId, sourceSha: raw.sourceSha }
    : raw?.schema === 'vtr-reach-live-probe/v1'
      ? { runId: raw.run?.runId, generationId: raw.run?.generationId, sourceSha: raw.source?.commit }
      : null
  if (expected === null || Object.values(expected).some((value) => typeof value !== 'string' || value.length === 0)) return null
  for (const root of archiveAncestors(inputPath)) {
    const probeRelativePath = relative(root, resolve(inputPath))
    if (probeRelativePath === '..' || probeRelativePath.startsWith(`..${sep}`)) continue
    const probePath = join(root, probeRelativePath)
    if (!existsSync(join(root, 'runner', 'buddy.log')) || !existsSync(probePath)) continue
    const probe = readOptionalJson(probePath, 'VTR run-scoped probe')
    const observed = probe?.record === 'vtr-reach-live-probe'
      ? { runId: probe.runId, generationId: probe.generationId, sourceSha: probe.sourceSha }
      : probe?.schema === 'vtr-reach-live-probe/v1'
        ? { runId: probe.run?.runId, generationId: probe.run?.generationId, sourceSha: probe.source?.commit }
        : null
    if (observed && Object.keys(expected).every((key) => observed[key] === expected[key])) {
      return { root, probePath: probeRelativePath.split(sep).join('/') }
    }
  }
  return null
}

function legacyFixtureFromArchive(archiveRoot, expected, evidence) {
  if (evidence === null) return { evidence: null, path: null, fixture: null }
  if (!legacyEvidenceMatches(evidence, expected)) throw new Error('legacy archive evidence identity does not match its baseline run')
  const fixtureCommandsPath = [
    join(archiveRoot, 'server', 'fixture-commands.jsonl'),
    join(archiveRoot, 'runner', 'fixture-commands.jsonl'),
    join(archiveRoot, 'server', 'console-commands.jsonl'),
  ].find(existsSync) ?? null
  let flatSolidGround = null
  if (fixtureCommandsPath !== null) {
    const rows = readFileSync(fixtureCommandsPath, 'utf8').split(/\r?\n/).filter((line) => line.trim() !== '').map((line, index) => {
      try { return JSON.parse(line) } catch (error) { throw new Error(`${fixtureCommandsPath}:${index + 1}: invalid JSONL (${error.message})`) }
    })
    const rawFixture = evidence.fixture
    const candidateLabel = evidence.events?.firstDecision?.candidate?.label ?? ''
    const standMatch = /stand at \((-?\d+),(-?\d+),(-?\d+)\)/.exec(candidateLabel)
    const target = rawFixture?.position
    const stand = standMatch === null ? null : { x: Number(standMatch[1]), y: Number(standMatch[2]), z: Number(standMatch[3]) }
    const fills = rows.map((row) => {
      const command = String(row.command ?? '')
      const match = /^fill\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(\S+)/i.exec(command)
      if (match === null || /Rejected:/i.test(String(row.result ?? ''))) return null
      const values = match.slice(1, 7).map(Number)
      return {
        min: { x: Math.min(values[0], values[3]), y: Math.min(values[1], values[4]), z: Math.min(values[2], values[5]) },
        max: { x: Math.max(values[0], values[3]), y: Math.max(values[1], values[4]), z: Math.max(values[2], values[5]) },
        block: match[7].toLowerCase().replace(/^minecraft:/, ''),
      }
    }).filter(Boolean)
    const covers = (fill, position) => position !== null && ['x', 'y', 'z'].every((key) => position[key] >= fill.min[key] && position[key] <= fill.max[key])
    const solidAt = (position) => fills.some((fill) => !['air', 'cave_air', 'void_air'].includes(fill.block) && covers(fill, position))
    const clearAt = (position) => fills.some((fill) => fill.block === 'air' && [position, { ...position, y: position.y + 1 }].every((cell) => covers(fill, cell)))
    if (target && stand) {
      flatSolidGround = [target, stand].every((cell) => solidAt({ x: cell.x, y: cell.y - 1, z: cell.z })) && clearAt(stand)
    }
  }

  return {
    evidence,
    path: 'runner/reach-slice-evidence.json',
    fixture: evidence.fixture && flatSolidGround !== null
      ? { ...evidence.fixture, flatSolidGround }
      : evidence.fixture ?? null,
  }
}

const RAW_FILE_LIMIT_BYTES = 5 * 1024 * 1024

function captureRawFile(root, relativePath) {
  const path = join(root, relativePath)
  if (!existsSync(path)) return { missing: relativePath }
  let stat
  try { stat = lstatSync(path) } catch (error) { return { invalid: { path: relativePath, reason: error.message } } }
  if (!stat.isFile() || stat.isSymbolicLink()) return { invalid: { path: relativePath, reason: 'source is not a regular non-symlink file' } }
  if (stat.size > RAW_FILE_LIMIT_BYTES) return { invalid: { path: relativePath, reason: `source exceeds ${RAW_FILE_LIMIT_BYTES} byte limit`, sizeBytes: stat.size } }
  const bytes = readFileSync(path)
  return { file: { path: relativePath, sizeBytes: bytes.length, sha256: sha256(bytes), contentBase64: bytes.toString('base64') } }
}

function captureRawSide(root, identity, requirements) {
  const files = []
  const missing = []
  const invalid = []
  for (const requirement of requirements) {
    const alternatives = Array.isArray(requirement) ? requirement : [requirement]
    const present = []
    for (const relativePath of alternatives) {
      const result = captureRawFile(root, relativePath)
      if (result.file) present.push(result.file)
      if (result.invalid) invalid.push(result.invalid)
    }
    if (present.length === 1) files.push(present[0])
    else if (present.length > 1) {
      // More than one alternative exists: embed them all so downstream
      // validators see the true file set and refuse the ambiguity, rather than
      // letting capture order silently select one journal.
      files.push(...present)
      invalid.push({ path: alternatives.join('|'), reason: 'ambiguous alternatives present in archive' })
    } else if (alternatives.every((path) => !existsSync(join(root, path)))) missing.push(alternatives)
  }
  return { identity, files, missing, invalid, status: missing.length === 0 && invalid.length === 0 ? 'PASS' : 'INCOMPLETE' }
}

function capturedText(side, path) {
  const file = side.files.find((entry) => entry.path === path)
  return file === undefined ? null : Buffer.from(file.contentBase64, 'base64').toString('utf8')
}

function rawJsonl(textValue, pathLabel) {
  return textValue.split(/\r?\n/).filter((line) => line.trim() !== '').map((line, index) => {
    try { return JSON.parse(line) } catch (error) { throw new Error(`${pathLabel}:${index + 1}: invalid raw JSONL (${error.message})`) }
  })
}

function bindLegacyRawEvents(side, evidence, expected) {
  const summaryText = capturedText(side, 'runner/reach-slice-evidence.json')
  const decisionPath = side.files.find((file) => file.path.endsWith('/decisions.jsonl'))?.path
  const runPath = side.files.find((file) => file.path.endsWith('/run.jsonl'))?.path
  const hostPath = side.files.find((file) => file.path.endsWith('/buddy.log'))?.path
  const missionPath = 'runner/human-task-input.jsonl'
  const witnessPath = 'runner/block-read-run2.jsonl'
  if (!summaryText || !decisionPath || !runPath || !hostPath || !capturedText(side, missionPath) || !capturedText(side, witnessPath)) {
    return { status: 'INCOMPLETE', reason: 'legacy source archive is missing a run, decision, movement, Mission-input, or witness-observation file' }
  }
  let rawSummary
  try { rawSummary = JSON.parse(summaryText) } catch (error) { return { status: 'FAIL', reason: `legacy run evidence JSON is invalid: ${error.message}` } }
  if (!legacyEvidenceMatches(rawSummary, expected)) return { status: 'FAIL', reason: 'legacy run evidence identity differs from the compared source/run/generation/build' }
  const first = rawSummary.events?.firstDecision
  const next = rawSummary.events?.nextDecisionInRange
  const moveEnd = rawSummary.events?.moveActionEnd
  if (![first?.decisionId, next?.decisionId, moveEnd?.actionId].every((value) => typeof value === 'string' && value.length > 0)) {
    return { status: 'INCOMPLETE', reason: 'legacy run evidence lacks first/next decisions or MOVE action identity' }
  }
  let decisions
  let humanTask
  let witnessRows
  try {
    decisions = rawJsonl(capturedText(side, decisionPath), decisionPath)
    humanTask = rawJsonl(capturedText(side, missionPath), missionPath)
    witnessRows = rawJsonl(capturedText(side, witnessPath), witnessPath)
  } catch (error) { return { status: 'FAIL', reason: error.message } }
  const firstMatches = decisions.filter((row) => row.decisionId === first.decisionId)
  const nextMatches = decisions.filter((row) => row.decisionId === next.decisionId)
  if (firstMatches.length !== 1 || nextMatches.length !== 1) return { status: 'INCOMPLETE', reason: 'raw decision journal does not contain exactly one first and next decision' }
  const identityMatches = [firstMatches[0], nextMatches[0]].every((row) => row.runId === expected.runId && row.generationId === expected.generationId && row.sourceSha === expected.sourceSha)
  if (!identityMatches) return { status: 'FAIL', reason: 'raw decision journal contains a decision from another run/source/generation' }
  const firstRow = firstMatches[0]
  const nextRow = nextMatches[0]
  const selected = firstRow.chosenAction ?? firstRow.jev?.answers?.action?.value ?? null
  const moveActionId = moveEnd.actionId
  if (selected !== moveActionId || !String(selected).startsWith('MOVE:')) return { status: 'FAIL', reason: 'raw first decision does not select the summarized legacy MOVE action' }
  const target = rawSummary.fixture?.position
  const block = rawSummary.fixture?.block
  if (!target || !['x', 'y', 'z'].every((key) => Number.isSafeInteger(target[key])) || typeof block !== 'string') {
    return { status: 'INCOMPLETE', reason: 'legacy run summary does not bind an integer target witness' }
  }
  const blockSuffix = `b${target.x}_${target.y}_${target.z}`
  const firstCandidate = firstRow.candidates?.find((candidate) => candidate.id === selected)
  if (!firstCandidate || firstCandidate.kind !== 'MOVE' || firstCandidate.targetName !== block || selected !== `MOVE:${blockSuffix}`) {
    return { status: 'FAIL', reason: 'legacy first MOVE does not target the block in the run-scoped witness observation' }
  }
  const nextSelected = nextRow.chosenAction ?? nextRow.jev?.answers?.action?.value ?? null
  const nextCandidate = nextRow.candidates?.find((candidate) => candidate.id === nextSelected)
  if (nextCandidate?.inReach !== true || nextCandidate.id !== next.selected || nextCandidate.kind !== 'MINE' ||
      nextCandidate.targetName !== block || nextSelected !== `MINE:${blockSuffix}`) {
    return { status: 'FAIL', reason: 'raw next decision does not establish inReach for the same observed block witness' }
  }
  const hostText = capturedText(side, hostPath)
  const matchingHostRows = (marker) => hostText.split(/\r?\n/).filter((line) => line.includes(marker) &&
    line.includes(`actionId=${moveActionId}`) && line.includes(`runId=${expected.runId}`) &&
    line.includes(`generationId=${expected.generationId}`) && line.includes(`sourceSha=${expected.sourceSha}`) &&
    line.includes(`buildHash=${expected.buildHash}`))
  const startLines = matchingHostRows('SKILL_START')
  const endLines = matchingHostRows('SKILL_END')
  if (startLines.length !== 1 || endLines.length !== 1) return { status: 'INCOMPLETE', reason: 'raw HOST log does not uniquely bind legacy MOVE start/end to the source run' }
  const missionEvent = humanTask.find((row) => typeof row.command === 'string' && /^agent\s+/i.test(row.command))
  const sourcePosition = target
  const witnessRow = witnessRows.find((row) => row.tag === 'target' && row.name === rawSummary.fixture?.block &&
    ['x', 'y', 'z'].every((key) => row.position?.[key] === sourcePosition?.[key]))
  if (!missionEvent || !witnessRow) return { status: 'INCOMPLETE', reason: 'raw operator Mission or pre-action witness observation is missing' }
  const firstAt = Date.parse(firstRow.ts ?? firstRow.timestamp ?? '')
  const moveEndAt = Date.parse(moveEnd.timestamp ?? moveEnd.at ?? '')
  const nextAt = Date.parse(nextRow.ts ?? nextRow.timestamp ?? '')
  const hostEndAt = Date.parse(/^\[([^\]]+)\]/.exec(endLines[0])?.[1] ?? '')
  const witnessAt = Date.parse(witnessRow.at ?? '')
  if (![firstAt, moveEndAt, nextAt, hostEndAt, witnessAt].every(Number.isFinite)) {
    return { status: 'INCOMPLETE', reason: 'legacy witness/decision/MOVE timestamps are incomplete' }
  }
  if (!(witnessAt <= firstAt && firstAt <= hostEndAt && hostEndAt <= moveEndAt && moveEndAt <= nextAt)) {
    return { status: 'FAIL', reason: 'legacy witness, selected MOVE, completed Skill, and next inReach decision are out of causal order' }
  }
  return {
    status: 'PASS',
    sourcePaths: { summary: 'runner/reach-slice-evidence.json', decisions: decisionPath, host: hostPath, missionInput: missionPath, witnessObservation: witnessPath, runJournal: runPath },
    eventIds: { firstDecision: first.decisionId, nextDecision: next.decisionId, moveActionId },
    missionCommand: missionEvent.command,
    witnessObservation: { at: witnessRow.at, position: witnessRow.position, block: witnessRow.name },
    movementSteps: moveEnd.movementStepCount,
  }
}

function bindVtrRawEvents(side, expected) {
  const hostText = capturedText(side, 'runner/buddy.log')
  const noDoubleText = capturedText(side, 'proofs/no-double-authority.json')
  if (hostText === null || noDoubleText === null) return { status: 'INCOMPLETE', reason: 'VTR raw host log or no-double-authority proof is missing' }
  let noDouble
  try { noDouble = JSON.parse(noDoubleText) } catch (error) { return { status: 'FAIL', reason: `VTR no-double-authority JSON is invalid: ${error.message}` } }
  if (noDouble.result !== 'PASS' || noDouble.runId !== expected.runId || noDouble.sourceSha !== expected.sourceSha ||
      noDouble.generationId !== expected.generationId || noDouble.legacyActuationCount !== 0 || !(noDouble.vtrActuationCount > 0)) {
    return { status: 'FAIL', reason: 'VTR no-double-authority proof is not PASS and bound to the exact source/run/generation' }
  }
  const markers = ['VTR_TRANSITION_COMMIT', 'VTR_TRANSITION_VERIFY', 'VTR_TRANSITION_OUTCOME']
  const eventLines = Object.fromEntries(markers.map((marker) => [marker, hostText.split(/\r?\n/).filter((line) =>
    line.includes(marker) && line.includes(`transitionId=${expected.transitionId}`) && line.includes(`runId=${expected.runId}`) &&
    line.includes(`generationId=${expected.generationId}`) && line.includes(`sourceSha=${expected.sourceSha}`) &&
    line.includes(`buildHash=${expected.buildHash}`) && line.includes(`contractHash=${expected.contractHash}`))]))
  if (Object.values(eventLines).some((matches) => matches.length !== 1)) return { status: 'INCOMPLETE', reason: 'VTR raw HOST log does not uniquely bind commit/VERIFY/outcome to this Transition' }
  const verifyLine = eventLines.VTR_TRANSITION_VERIFY[0]
  const outcomeLine = eventLines.VTR_TRANSITION_OUTCOME[0]
  if (!verifyLine.includes('truth=TRUE') || !outcomeLine.includes('outcome={"kind":"SUCCESS"') ||
      !(outcomeLine.includes('boundary=mechanical-step-outcome') || outcomeLine.includes('boundary=verified-terminal'))) {
    return { status: 'FAIL', reason: 'VTR raw event sequence does not show deterministic TRUE VERIFY before typed SUCCESS' }
  }
  const timeOf = (line) => Date.parse(/^\[([^\]]+)\]/.exec(line)?.[1] ?? '')
  const times = markers.map((marker) => timeOf(eventLines[marker][0]))
  if (!times.every(Number.isFinite) || !(times[0] <= times[1] && times[1] <= times[2])) return { status: 'FAIL', reason: 'VTR raw commit/VERIFY/outcome timestamps are missing or out of order' }
  return {
    status: 'PASS',
    sourcePaths: { host: 'runner/buddy.log', noDoubleAuthority: 'proofs/no-double-authority.json' },
    transitionId: expected.transitionId,
    outcome: 'SUCCESS',
    eventOrder: { commitAt: new Date(times[0]).toISOString(), verifyAt: new Date(times[1]).toISOString(), outcomeAt: new Date(times[2]).toISOString() },
    noDoubleAuthority: { legacyActuationCount: noDouble.legacyActuationCount, vtrActuationCount: noDouble.vtrActuationCount },
  }
}

const LEGACY_RAW_REQUIREMENTS = [
  'runner/reach-slice-evidence.json',
  'runner/runtime/buddy.log',
  'runner/runtime/logs/jev/decisions.jsonl',
  'runner/runtime/logs/jev/jev-calls.jsonl',
  'runner/runtime/logs/jev/run.jsonl',
  'runner/human-task-input.jsonl',
  'runner/block-read-run2.jsonl',
]
const LEGACY_RAW_OPTIONAL_REQUIREMENTS = ['runner/runtime/logs/jev/system2.jsonl']

const VTR_RAW_REQUIREMENTS = [
  'runner/buddy.log',
  ['runner/run.jsonl', 'runner/jev-run.jsonl', 'runner/jev-run-source.jsonl'],
  'runner/jev-calls.jsonl',
  'runner/jev-decisions.jsonl',
  'runner/system2.jsonl',
  'runner/mercury-calls.jsonl',
  'runner/host-lifecycle.jsonl',
  'runner/no-llm-egress-audit.json',
  'runner/provider-activity-capture.json',
  'runner/acceptance.json',
  'server/fixture-commands.jsonl',
  'proofs/no-double-authority.json',
]

function captureRawComparisonEvidence({ legacy, vtr, vtrArchive, vtrInputPath }) {
  const legacyIdentity = {
    sourceSha: legacy.sourceSha,
    buildHash: legacy.buildHash,
    runId: legacy.runId,
    generationId: legacy.generationId,
  }
  const vtrIdentity = {
    sourceSha: vtr.sourceSha,
    buildHash: vtr.buildHash,
    runId: vtr.runId,
    generationId: vtr.generationId,
    transitionId: vtr.transition.transitionId,
    contractHash: vtr.transition.contractHash,
  }
  const legacyArchive = legacy.archiveRoot === null
    ? null
    : { root: legacy.archiveRoot, evidence: legacy.archiveEvidence }
  const legacyRequirements = legacyArchive === null ? LEGACY_RAW_REQUIREMENTS : [
    ...LEGACY_RAW_REQUIREMENTS,
    ...LEGACY_RAW_OPTIONAL_REQUIREMENTS.filter((path) => existsSync(join(legacyArchive.root, path))),
  ]
  const legacySide = legacyArchive === null
    ? { identity: legacyIdentity, files: [], missing: LEGACY_RAW_REQUIREMENTS, invalid: [], status: 'INCOMPLETE' }
    : captureRawSide(legacyArchive.root, legacyIdentity, legacyRequirements)
  const probePath = vtrArchive?.probePath ?? relative(dirname(resolve(vtrInputPath)), resolve(vtrInputPath)).split(sep).join('/')
  let vtrSide
  if (vtrArchive === null) {
    vtrSide = { identity: vtrIdentity, files: [], missing: [probePath, ...VTR_RAW_REQUIREMENTS], invalid: [], status: 'INCOMPLETE' }
  } else {
    vtrSide = captureRawSide(vtrArchive.root, vtrIdentity, [probePath, ...VTR_RAW_REQUIREMENTS])
    const probeFile = vtrSide.files.find((file) => file.path === probePath)
    if (probeFile) probeFile.label = 'probe input'
  }
  const legacyEvents = legacyArchive?.evidence === null || legacyArchive === null
    ? { status: 'INCOMPLETE', reason: 'no run-matched legacy Reach source archive was found' }
    : bindLegacyRawEvents(legacySide, legacyArchive.evidence, {
        runId: legacy.runId,
        generationId: legacy.generationId,
        sourceSha: legacy.sourceSha,
        buildHash: legacy.buildHash,
      })
  const vtrEvents = vtrArchive === null
    ? { status: 'INCOMPLETE', reason: 'no run-matched VTR source archive was found' }
    : bindVtrRawEvents(vtrSide, vtrIdentity)
  const status = legacySide.status === 'PASS' && vtrSide.status === 'PASS' && legacyEvents.status === 'PASS' && vtrEvents.status === 'PASS'
    ? 'PASS'
    : 'INCOMPLETE'
  return {
    schema: 'vtr-reach-run-comparison-evidence/v1',
    status,
    evidenceClass: status === 'PASS' ? 'run-scoped-raw-events' : 'summary-only-or-incomplete-raw',
    legacy: { ...legacySide, mission: legacy.missionInput, events: legacyEvents },
    vtr: { ...vtrSide, mission: { kind: vtr.mission.kind, item: vtr.mission.item, count: vtr.mission.count }, events: vtrEvents },
    note: 'Raw source bytes are included base64-encoded and SHA-256 bound. This attestation proves what each separate run recorded; it does not turn different Missions/worlds into a controlled same-world experiment.',
  }
}

function parseWorldKey(value, path) {
  const parts = text(value, path).split('|')
  if (parts.length !== 3 || !parts[0] || !parts[1] || !/^\d+$/.test(parts[2])) {
    throw new Error(`${path} must have <server>|<dimension>|<epoch> form`)
  }
  return { server: parts[0], dimension: normalizeDimension(parts[1]), epoch: Number(parts[2]) }
}

function parseLegacy(raw, sourceText, legacyPath) {
  const input = record(raw, 'legacy input')
  if (input.schema === 'reach-old-vtr-comparison/v1') {
    const baseline = record(input.baseline, 'legacy.baseline')
    const metrics = record(baseline.metrics, 'legacy.baseline.metrics')
    const effectiveJev = record(baseline.effectiveJev, 'legacy.baseline.effectiveJev')
    const effectiveSystem2 = record(baseline.effectiveSystem2, 'legacy.baseline.effectiveSystem2')
    const comparison = record(input.comparison, 'legacy.comparison')
    const expectedIdentity = {
      runId: baseline.runId,
      generationId: baseline.generationId,
      sourceSha: baseline.commit,
      buildHash: baseline.buildHash,
    }
    const legacyArchive = findLegacyArchive(legacyPath, expectedIdentity)
    const archiveFixture = legacyFixtureFromArchive(legacyArchive?.root ?? dirname(legacyPath), expectedIdentity, legacyArchive?.evidence ?? null)
    const rawCommandMission = normalizedMissionFromLegacyArchive(legacyArchive?.root, legacyArchive?.evidence)
    const fixtureRaw = comparison.fixture ?? archiveFixture.fixture ?? baseline.fixture ?? input.fixture
    return {
      schema: input.schema,
      sourceSha: text(baseline.commit, 'legacy.baseline.commit'),
      expectedSourceSha: typeof baseline.originMainAtCheckout === 'string'
        ? baseline.originMainAtCheckout
        : baseline.commit === CURRENT_ORIGIN_MAIN_SHA ? CURRENT_ORIGIN_MAIN_SHA : null,
      buildHash: text(baseline.buildHash, 'legacy.baseline.buildHash'),
      runId: text(baseline.runId, 'legacy.baseline.runId'),
      generationId: text(baseline.generationId, 'legacy.baseline.generationId'),
      worldKey: text(baseline.worldKey, 'legacy.baseline.worldKey'),
      worldEpoch: count(baseline.worldEpoch, 'legacy.baseline.worldEpoch'),
      levelName: text(baseline.levelName, 'legacy.baseline.levelName'),
      seed: exactNumericField(sourceText, /"baseline"\s*:\s*\{[\s\S]*?"seed"\s*:\s*(-?\d+)/, baseline.seed, 'legacy.baseline.seed'),
      minecraftVersion: text(baseline.minecraftVersion, 'legacy.baseline.minecraftVersion'),
      gameMode: text(baseline.gameMode, 'legacy.baseline.gameMode'),
      difficulty: text(baseline.difficulty, 'legacy.baseline.difficulty'),
      effectiveJev,
      effectiveSystem2,
      missionInputComparable: comparison.sameMissionInput === true,
      fixtureClassComparable: comparison.sameGeometryFixtureClass === true,
      fixtureDescription: typeof comparison.target === 'string' ? comparison.target : 'not recorded',
      fixture: structuredFixture(fixtureRaw),
      fixtureEvidencePath: archiveFixture.path,
      // The top-level `missionInput` in this historical wrapper describes the
      // requested comparison target. Prefer the legacy run's own evidence and
      // never let a target-side duplicate overwrite the observed legacy Mission.
      missionInput: structuredMission(
        rawCommandMission ?? archiveFixture.evidence?.missionInput ?? baseline.missionInput ?? baseline.actualMissionInput ??
        input.legacyMissionInput ?? input.actualMissionInput ?? input.mission ?? input.missionInput ?? comparison.missionInput,
      ),
      sameMissionClaim: rawCommandMission !== null ? true : comparison.sameMissionInput === true ? true : comparison.sameMissionInput === false ? false : null,
      metrics: {
        movementOperationsToInRange: count(metrics.mechanicalMovementSteps, 'legacy.baseline.metrics.mechanicalMovementSteps'),
        moveActionsToInRange: count(metrics.legacyMoveActionsToInRangeEvidence, 'legacy.baseline.metrics.legacyMoveActionsToInRangeEvidence'),
        decisionFramesToInRange: count(metrics.jevDecisionFramesThroughInRangeDecision, 'legacy.baseline.metrics.jevDecisionFramesThroughInRangeDecision'),
        questionCallsToInRange: count(metrics.jevQuestionCallsThroughInRangeDecision, 'legacy.baseline.metrics.jevQuestionCallsThroughInRangeDecision'),
        system2ModelCalls: count(metrics.system2LlmCalls, 'legacy.baseline.metrics.system2LlmCalls'),
        jevModelCalls: count(metrics.jevProviderModelCalls, 'legacy.baseline.metrics.jevProviderModelCalls'),
        networkModelCalls: count(metrics.networkModelCalls, 'legacy.baseline.metrics.networkModelCalls'),
        modelCallsPerMechanicalStep: ratio(metrics.modelCallsPerMechanicalStep, 'legacy.baseline.metrics.modelCallsPerMechanicalStep'),
        vtrTransitions: count(metrics.verifiedVtrTransitions, 'legacy.baseline.metrics.verifiedVtrTransitions'),
        reachSpecificTerminals: count(metrics.legacyReachSpecificTerminal, 'legacy.baseline.metrics.legacyReachSpecificTerminal'),
        actionOutcome: text(metrics.oldSkillOutcome, 'legacy.baseline.metrics.oldSkillOutcome'),
        typedOutcome: text(metrics.typedVtrTerminalOutcome, 'legacy.baseline.metrics.typedVtrTerminalOutcome'),
      },
      actualSystem2Calls: count(effectiveSystem2.actualSystem2LlmCalls, 'legacy.baseline.effectiveSystem2.actualSystem2LlmCalls'),
      effectiveJevNetworkCalls: count(effectiveJev.networkCalls, 'legacy.baseline.effectiveJev.networkCalls'),
      missionDescription: typeof comparison.reason === 'string' ? comparison.reason : 'mission equivalence not specified',
      archiveRoot: legacyArchive?.root ?? null,
      archiveEvidence: archiveFixture.evidence,
      raw: { baseline, comparison },
    }
  }

  if (input.schema === 'legacy-reach-comparator/v1') {
    const metrics = record(input.sliceMetrics, 'legacy.sliceMetrics')
    const fixture = record(input.fixture, 'legacy.fixture')
    const runId = text(input.runId, 'legacy.runId')
    const sourceSha = text(input.sourceSha, 'legacy.sourceSha')
    const events = record(input.events, 'legacy.events')
    const moveEnd = record(events.moveActionEnd, 'legacy.events.moveActionEnd')
    const first = record(events.firstDecision, 'legacy.events.firstDecision')
    const next = record(events.nextDecisionInRange, 'legacy.events.nextDecisionInRange')
    const oldPlan = record(input.legacyPlan, 'legacy.legacyPlan')
    const system2Calls = count(metrics.system2LlmCalls, 'legacy.sliceMetrics.system2LlmCalls')
    const jevCalls = count(metrics.jevProviderModelCalls, 'legacy.sliceMetrics.jevProviderModelCalls')
    const run = input.run === undefined || input.run === null ? {} : record(input.run, 'legacy.run')
    const expectedIdentity = { sourceSha, buildHash: text(input.buildHash, 'legacy.buildHash'), runId,
      generationId: text(input.generationId, 'legacy.generationId') }
    const legacyArchive = findLegacyArchive(legacyPath, expectedIdentity)
    const rawCommandMission = normalizedMissionFromLegacyArchive(legacyArchive?.root, legacyArchive?.evidence)
    const archiveFixture = legacyArchive === null
      ? { evidence: null, path: null, fixture: null }
      : legacyFixtureFromArchive(legacyArchive.root, expectedIdentity, legacyArchive.evidence)
    return {
      schema: input.schema,
      sourceSha,
      // The raw comparator result is bound to the origin/main pin the collector
      // recorded at collection time under a clean-checkout check. Older
      // artifacts without that binding qualify only while their captured source
      // is still the exact tip visible to this comparison run.
      expectedSourceSha: typeof input.sourceBinding?.originMainAtCollection === 'string' && SHA_RE.test(input.sourceBinding.originMainAtCollection)
        ? input.sourceBinding.originMainAtCollection.toLowerCase()
        : sourceSha === CURRENT_ORIGIN_MAIN_SHA ? CURRENT_ORIGIN_MAIN_SHA : null,
      buildHash: text(input.buildHash, 'legacy.buildHash'),
      runId,
      generationId: text(input.generationId, 'legacy.generationId'),
      worldKey: typeof run.worldKey === 'string' ? run.worldKey : null,
      worldEpoch: typeof run.worldEpoch === 'number' ? count(run.worldEpoch, 'legacy.run.worldEpoch') : null,
      levelName: typeof run.levelName === 'string' ? run.levelName : 'not recorded',
      seed: run.seed === undefined ? 'not recorded' : typeof run.seed === 'number'
        ? exactNumericField(sourceText, /"run"\s*:\s*\{[\s\S]*?"seed"\s*:\s*(-?\d+)/, run.seed, 'legacy.run.seed')
        : String(run.seed),
      minecraftVersion: typeof run.minecraftVersion === 'string' ? run.minecraftVersion : 'not recorded',
      gameMode: typeof run.gameMode === 'string' ? run.gameMode : 'not recorded',
      difficulty: typeof run.difficulty === 'string' ? run.difficulty : 'not recorded',
      effectiveJev: null,
      effectiveSystem2: null,
      missionInputComparable: false,
      fixtureClassComparable: fixture.block === 'oak_log',
      fixtureDescription: `${fixture.block} at ${fixture.position?.x},${fixture.position?.y},${fixture.position?.z}; offset=${JSON.stringify(fixture.offset)}`,
      fixture: structuredFixture(archiveFixture.fixture ?? legacyArchive?.evidence?.fixture ?? fixture),
      fixtureEvidencePath: archiveFixture.path ?? (legacyArchive === null ? null : 'runner/reach-slice-evidence.json'),
      missionInput: structuredMission(rawCommandMission ?? legacyArchive?.evidence?.missionInput ?? input.missionInput ?? input.legacyMissionInput ?? input.mission ?? oldPlan.missionInput ?? oldPlan.mission),
      sameMissionClaim: rawCommandMission !== null ? true : typeof input.sameMissionInput === 'boolean' ? input.sameMissionInput : null,
      metrics: {
        movementOperationsToInRange: count(metrics.mechanicalMovementSteps, 'legacy.sliceMetrics.mechanicalMovementSteps'),
        moveActionsToInRange: count(metrics.legacyMoveActionsToInRangeEvidence, 'legacy.sliceMetrics.legacyMoveActionsToInRangeEvidence'),
        decisionFramesToInRange: count(metrics.jevDecisionFramesThroughInRangeDecision, 'legacy.sliceMetrics.jevDecisionFramesThroughInRangeDecision'),
        questionCallsToInRange: count(metrics.jevQuestionCallsThroughInRangeDecision, 'legacy.sliceMetrics.jevQuestionCallsThroughInRangeDecision'),
        system2ModelCalls: system2Calls,
        jevModelCalls: jevCalls,
        networkModelCalls: count(metrics.networkModelCalls, 'legacy.sliceMetrics.networkModelCalls'),
        modelCallsPerMechanicalStep: ratio(metrics.modelCallsPerMechanicalStep, 'legacy.sliceMetrics.modelCallsPerMechanicalStep'),
        vtrTransitions: count(metrics.verifiedVtrTransitions, 'legacy.sliceMetrics.verifiedVtrTransitions'),
        reachSpecificTerminals: count(metrics.legacyReachSpecificTerminal, 'legacy.sliceMetrics.legacyReachSpecificTerminal'),
        actionOutcome: text(metrics.oldSkillOutcome, 'legacy.sliceMetrics.oldSkillOutcome'),
        typedOutcome: text(metrics.typedVtrTerminalOutcome, 'legacy.sliceMetrics.typedVtrTerminalOutcome'),
      },
      actualSystem2Calls: system2Calls,
      effectiveJevNetworkCalls: jevCalls,
      missionDescription: text(oldPlan.goal, 'legacy.legacyPlan.goal'),
      archiveRoot: legacyArchive?.root ?? null,
      archiveEvidence: legacyArchive?.evidence ?? null,
      raw: { fixture, first, next, moveEnd },
    }
  }

  throw new Error(`legacy input schema must be reach-old-vtr-comparison/v1 or legacy-reach-comparator/v1; got ${String(input.schema)}`)
}

function exactNumericField(sourceText, expression, parsedValue, path) {
  if (typeof parsedValue !== 'number') return String(parsedValue)
  const match = expression.exec(sourceText)
  if (match === null) {
    if (Number.isSafeInteger(parsedValue)) return String(parsedValue)
    throw new Error(`${path} is outside JavaScript's safe integer range and its exact JSON literal was not found`)
  }
  const exact = match[1]
  if (Number(exact) !== parsedValue) throw new Error(`${path} raw JSON literal does not match parsed value`)
  return exact
}

function readArchivedTransitionStart(raw, archiveRoot) {
  const fixture = record(raw.fixture, 'archive.fixture')
  const transition = record(raw.transition, 'archive.transition')
  const commit = record(transition.commit, 'archive.transition.commit')
  const transitionId = text(commit.transitionId, 'archive.transition.commit.transitionId')
  const start = record(fixture.transitionStartPosition, 'archive.fixture.transitionStartPosition')
  const command = text(fixture.harnessTeleportCommand, 'archive.fixture.harnessTeleportCommand')
  const target = /^tp\s+(\S+)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)$/i.exec(command)
  if (target === null) throw new Error('archive harness teleport must record an absolute tp command')
  const tpPlayer = target[1]
  const tpPosition = { x: Number(target[2]), y: Number(target[3]), z: Number(target[4]) }
  if (!['x', 'y', 'z'].every((key) => Number.isFinite(start[key]))) {
    throw new Error('archive transitionStartPosition must contain finite x/y/z')
  }
  const verticalOffset = tpPosition.y - start.y
  if (Math.abs(start.x - tpPosition.x) > 0.011 || Math.abs(start.z - tpPosition.z) > 0.011 ||
      (Math.abs(verticalOffset) > 0.011 && Math.abs(verticalOffset - 1) > 0.011)) {
    throw new Error('archive transitionStartPosition does not match the recorded grounded harness teleport')
  }

  const commandsPath = join(archiveRoot, 'server', 'fixture-commands.jsonl')
  const runnerLogPath = join(archiveRoot, 'runner', 'buddy.log')
  if (!existsSync(commandsPath) || !existsSync(runnerLogPath)) {
    throw new Error('archive transition-start proof requires server/fixture-commands.jsonl and runner/buddy.log')
  }
  const commandRows = readFileSync(commandsPath, 'utf8').split(/\r?\n/).filter((line) => line.trim() !== '').map((line, index) => {
    try { return JSON.parse(line) } catch (error) { throw new Error(`${commandsPath}:${index + 1}: invalid JSONL (${error.message})`) }
  })
  const teleport = commandRows.find((row) => row.command === command && (row.username === undefined || row.username === tpPlayer))
  if (teleport === undefined || typeof teleport.recordedAt !== 'string') {
    throw new Error('archive has no timestamped console record for the harness teleport')
  }
  const teleportAt = Date.parse(teleport.recordedAt)
  if (!Number.isFinite(teleportAt)) throw new Error('archive harness teleport timestamp is invalid')
  const log = readFileSync(runnerLogPath, 'utf8')
  const commitLine = log.split(/\r?\n/).find((line) => line.includes(`VTR_TRANSITION_COMMIT transitionId=${transitionId} `))
  const commitTime = commitLine?.match(/^\[([^\]]+)\]/)?.[1]
  const commitAt = commitTime === undefined ? NaN : Date.parse(commitTime)
  if (!Number.isFinite(commitAt) || teleportAt >= commitAt) {
    throw new Error('archive does not prove the harness teleport occurred before Transition commit')
  }
  return { position: start, source: 'fixture.transitionStartPosition (console tp precedes commit)' }
}

function adaptArchivedVtrProbe(raw, archiveRoot) {
  if (raw?.record !== 'vtr-reach-live-probe') return raw
  const input = record(raw, 'VTR archive probe')
  const server = record(input.server, 'archive.server')
  const mission = record(input.mission, 'archive.mission')
  const fixture = record(input.fixture, 'archive.fixture')
  const transition = record(input.transition, 'archive.transition')
  const commit = record(transition.commit, 'archive.transition.commit')
  const verify = record(transition.verify, 'archive.transition.verify')
  const terminal = record(transition.terminalOutcome, 'archive.transition.terminalOutcome')
  const terminalOutcome = record(terminal.outcome, 'archive.transition.terminalOutcome.outcome')
  const identity = record(commit.identity, 'archive.transition.commit.identity')
  const desiredPredicate = record(commit.desiredPredicate, 'archive.transition.commit.desiredPredicate')
  if (commit.identity?.generationId !== input.generationId || commit.identity?.leaseId !== input.generationId ||
      verify.transitionId !== commit.transitionId || terminal.transitionId !== commit.transitionId ||
      verify.runId !== input.runId || verify.generationId !== input.generationId || verify.sourceSha !== input.sourceSha ||
      verify.worldKey !== identity.worldKey || verify.worldEpoch !== identity.worldEpoch ||
      verify.contractHash !== terminal.contractHash) {
    throw new Error('archive Transition commit/verification/outcome identity binding is inconsistent')
  }
  const metrics = record(input.metrics, 'archive.metrics')
  const configuration = record(input.configuration, 'archive.configuration')
  const archiveStart = readArchivedTransitionStart(input, archiveRoot)
  const noDoubleProof = readOptionalJson(join(archiveRoot, 'proofs', 'no-double-authority.json'), 'VTR no-double-authority proof')
  if (noDoubleProof === null || noDoubleProof.result !== 'PASS' || noDoubleProof.runId !== input.runId ||
      noDoubleProof.sourceSha !== input.sourceSha || noDoubleProof.generationId !== input.generationId ||
      noDoubleProof.duplicateAuthority !== false || noDoubleProof.duplicateAuthorityConflicts !== 0 ||
      noDoubleProof.legacyActuationCount !== 0 || noDoubleProof.vtrActuationCount !== 1) {
    throw new Error('archive lacks a run/source/generation-bound PASS no-double-authority proof')
  }
  const eventSequence = Array.isArray(transition.eventSequence) ? transition.eventSequence : []
  const runnerLogPath = join(archiveRoot, 'runner', 'buddy.log')
  const runnerLogLines = readFileSync(runnerLogPath, 'utf8').split(/\r?\n/)
  const structuredModelMetricsEvidence = transitionModelMetricsFromRunJsonl(
    join(archiveRoot, 'runner', 'run.jsonl'),
    commit.transitionId,
    terminal.contractHash,
  )
  const buddyLogModelMetricsEvidence = parseTransitionModelMetricsEventLines(
    runnerLogLines,
    commit.transitionId,
    terminal.contractHash,
    'runner/buddy.log',
  )
  const sequenceModelMetricsEvidence = transitionModelMetricsFromSequence(transition, commit.transitionId, terminal.contractHash)
  const observedMetricEvents = [structuredModelMetricsEvidence, buddyLogModelMetricsEvidence, sequenceModelMetricsEvidence]
    .filter((event) => event !== null)
  for (const observed of observedMetricEvents.slice(1)) {
    if (!sameTransitionModelMetrics(observedMetricEvents[0], observed)) {
      throw new Error('VTR_TRANSITION_MODEL_METRICS copies disagree across archived event sources')
    }
  }
  const modelMetricsEvidence = structuredModelMetricsEvidence ?? buddyLogModelMetricsEvidence ?? sequenceModelMetricsEvidence
  const verifyEventIndex = eventSequence.findIndex((event) => String(event).includes('VTR_TRANSITION_VERIFY'))
  const outcomeEventIndex = eventSequence.findIndex((event) => String(event).includes('VTR_TRANSITION_OUTCOME'))
  const verificationEvidenceMatches = verify.truth === 'TRUE' && verify.identityMatches === true && verify.predicatesVerified === true &&
    Array.isArray(verify.evidenceIds) && isDeepStrictEqual(verify.evidenceIds, terminalOutcome.evidenceIds) &&
    verify.desiredPredicateIdentity === terminalOutcome.desiredPredicateIdentity && verifyEventIndex >= 0 &&
    outcomeEventIndex > verifyEventIndex
  const typedTerminalProof = verificationEvidenceMatches && terminalOutcome.kind === 'SUCCESS'
  const commitEventIndex = eventSequence.findIndex((event) => String(event).includes('VTR_TRANSITION_COMMIT'))
  const precommitUnknownSourceHolds = eventSequence.slice(0, Math.max(0, commitEventIndex))
    .filter((event) => String(event).includes('VTR_REACH_PROBE_HOLD') && /unknown|unavailable/i.test(String(event))).length
  const witness = commit.witness
  const witnessChosenByProductionSensor = typeof witness?.evidenceId === 'string' && witness.evidenceId.startsWith('sensor:block:') &&
    witness.observedIdentity?.generationId === input.generationId
  const finalInventory = record(mission.finalInventory, 'archive.mission.finalInventory')
  const missionCompleted = (finalInventory[mission.item] ?? 0) >= mission.count
  const contractWorldKey = text(identity.worldKey, 'archive.transition.commit.identity.worldKey')

  return {
    schema: 'vtr-reach-live-probe/v1',
    archivedProbeAdapter: 'vtr-reach-live-probe-record/v1',
    source: { commit: input.sourceSha, buildHash: input.generationHash },
    run: {
      runId: input.runId,
      generationId: input.generationId,
      worldKey: contractWorldKey,
      serverId: server.serverId,
      worldEpoch: server.worldEpoch,
      dimension: server.dimension,
      levelName: server.worldName,
      seed: String(server.worldSeedFromLevelDat),
      minecraftVersion: server.minecraftVersion,
      gameMode: server.gamemode,
      difficulty: server.difficulty,
      seedAssessment: input.identity?.seedAssessment ?? null,
    },
    mission: {
      id: commit.mission?.id,
      kind: mission.kind,
      item: mission.item,
      count: mission.count,
      initialInventory: record(mission.initialInventory, 'archive.mission.initialInventory'),
      finalInventory,
      initialPosition: fixture.runnerBootPosition,
      missionCompletion: missionCompleted,
    },
    fixture: {
      relativeResourceSource: { block: fixture.witness?.block, position: fixture.witness?.position },
      transitionStartPosition: archiveStart.position,
      transitionStartEvidence: archiveStart.source,
      flatSolidGround: typeof fixture.flatSolidGround === 'boolean' ? fixture.flatSolidGround : null,
      witnessChosenByProductionSensor,
    },
    transition: {
      transitionId: commit.transitionId,
      contractHash: terminal.contractHash,
      desiredPredicate,
      ensures: commit.ensures,
      worldIdentity: identity,
      modelMetricsEvidence,
      metrics: { concurrentLegacyActuations: 0, ...metrics },
      outcome: { kind: terminalOutcome.kind, boundary: terminal.boundary, evidenceIds: terminalOutcome.evidenceIds },
      precommitUnknownSourceHolds,
      actionSkillReportedSuccessWasNotUsedAsTransitionTerminal: typedTerminalProof,
      archivedVerificationBeforeOutcome: typedTerminalProof,
      witness,
    },
    configuredNoLlmProbe: {
      networkModelCalls: configuration.networkModelCalls,
      effectiveJev: {
        provider: configuration.effectiveJevProvider,
        model: configuration.effectiveJevModel,
        configuredPolicy: configuration.BUDDY_POLICY,
        decisionCalls: metrics.jevCallsPerTransition,
      },
      effectiveSystem2: {
        provider: configuration.effectiveSystem2Provider,
        model: configuration.effectiveSystem2Model,
        configuredMode: configuration.BUDDY_SYSTEM2,
        decisionCalls: metrics.system2CallsPerTransition,
      },
    },
  }
}

function parseVtr(raw) {
  const input = record(raw, 'VTR input')
  if (input.schema !== 'vtr-reach-live-probe/v1') {
    throw new Error(`VTR input schema must be vtr-reach-live-probe/v1; got ${String(input.schema)}`)
  }
  const source = record(input.source, 'vtr.source')
  const run = record(input.run, 'vtr.run')
  const mission = record(input.mission, 'vtr.mission')
  const fixture = record(input.fixture, 'vtr.fixture')
  const transition = record(input.transition, 'vtr.transition')
  const metrics = record(transition.metrics, 'vtr.transition.metrics')
  const outcome = record(transition.outcome, 'vtr.transition.outcome')
  const worldIdentity = record(transition.worldIdentity, 'vtr.transition.worldIdentity')
  const desiredPredicate = record(transition.desiredPredicate, 'vtr.transition.desiredPredicate')
  const desiredProposition = record(desiredPredicate.proposition, 'vtr.transition.desiredPredicate.proposition')
  const ensures = transition.ensures
  const probe = record(input.configuredNoLlmProbe, 'vtr.configuredNoLlmProbe')
  const probeJev = record(probe.effectiveJev, 'vtr.configuredNoLlmProbe.effectiveJev')
  const probeSystem2 = record(probe.effectiveSystem2, 'vtr.configuredNoLlmProbe.effectiveSystem2')
  const runWorld = parseWorldKey(run.worldKey, 'vtr.run.worldKey')
  const contractWorld = parseWorldKey(worldIdentity.worldKey, 'vtr.transition.worldIdentity.worldKey')
  const rawModelMetricsEvidence = transition.modelMetricsEvidence ?? transitionModelMetricsFromSequence(
    transition,
    text(transition.transitionId, 'vtr.transition.transitionId'),
    text(transition.contractHash, 'vtr.transition.contractHash'),
  )
  const modelMetricsEvidence = rawModelMetricsEvidence === null
    ? null
    : {
        transitionId: text(rawModelMetricsEvidence.transitionId, 'vtr.transition.modelMetricsEvidence.transitionId'),
        contractHash: text(rawModelMetricsEvidence.contractHash, 'vtr.transition.modelMetricsEvidence.contractHash'),
        outcome: text(rawModelMetricsEvidence.outcome, 'vtr.transition.modelMetricsEvidence.outcome'),
        mechanicalSteps: count(rawModelMetricsEvidence.mechanicalSteps, 'vtr.transition.modelMetricsEvidence.mechanicalSteps'),
        decisionFrameInvocations: count(rawModelMetricsEvidence.decisionFrameInvocations, 'vtr.transition.modelMetricsEvidence.decisionFrameInvocations'),
        providerEvaluateAttempts: count(rawModelMetricsEvidence.providerEvaluateAttempts, 'vtr.transition.modelMetricsEvidence.providerEvaluateAttempts'),
        source: text(rawModelMetricsEvidence.source, 'vtr.transition.modelMetricsEvidence.source'),
      }
  const legacyJevCallsPerTransition = count(metrics.jevCallsPerTransition, 'vtr.transition.metrics.jevCallsPerTransition')
  const system2CallsPerTransition = count(metrics.system2CallsPerTransition, 'vtr.transition.metrics.system2CallsPerTransition')
  const mechanicalStepsPerTransition = count(metrics.mechanicalStepsPerTransition, 'vtr.transition.metrics.mechanicalStepsPerTransition')
  const modelMetricsConsistencyIssues = []
  if (modelMetricsEvidence !== null) {
    if (modelMetricsEvidence.mechanicalSteps !== mechanicalStepsPerTransition) {
      modelMetricsConsistencyIssues.push({
        field: 'mechanicalSteps',
        transitionOutcome: mechanicalStepsPerTransition,
        modelMetricsEvent: modelMetricsEvidence.mechanicalSteps,
      })
    }
    if (modelMetricsEvidence.outcome !== metrics.typedTerminalOutcome) {
      modelMetricsConsistencyIssues.push({
        field: 'typedTerminalOutcome',
        transitionOutcome: metrics.typedTerminalOutcome,
        modelMetricsEvent: modelMetricsEvidence.outcome,
      })
    }
    if (modelMetricsEvidence.decisionFrameInvocations !== legacyJevCallsPerTransition) {
      modelMetricsConsistencyIssues.push({
        field: 'decisionFrameInvocations',
        legacyJevCallsPerTransition,
        modelMetricsEvent: modelMetricsEvidence.decisionFrameInvocations,
      })
    }
    const configuredDecisionFrames = probeJev.decisionCalls
    if (Number.isSafeInteger(configuredDecisionFrames) && configuredDecisionFrames !== modelMetricsEvidence.decisionFrameInvocations) {
      modelMetricsConsistencyIssues.push({
        field: 'effectiveJev.decisionCalls',
        configuredDecisionFrames,
        modelMetricsEvent: modelMetricsEvidence.decisionFrameInvocations,
      })
    }
  }
  const providerEvaluateAttempts = modelMetricsEvidence?.providerEvaluateAttempts ?? null
  const providerEvaluateAttemptsPerMechanicalStep = modelMetricsEvidence === null || mechanicalStepsPerTransition === 0
    ? null
    : providerEvaluateAttempts / mechanicalStepsPerTransition
  const vtrMetrics = {
    verifiedTransitions: count(metrics.verifiedTransitionCompletion, 'vtr.transition.metrics.verifiedTransitionCompletion'),
    mechanicalStepsPerTransition,
    /** Compatibility counter only; never use this as a provider/model call count. */
    legacyJevCallsPerTransition,
    /** Exact only when backed by VTR_TRANSITION_MODEL_METRICS. */
    decisionFrameInvocations: modelMetricsEvidence?.decisionFrameInvocations ?? null,
    /** Actual Jev evaluate() invocations, including retry attempts. */
    providerEvaluateAttempts,
    providerEvaluateAttemptsPerMechanicalStep,
    providerAttemptMeaning: modelMetricsEvidence === null ? 'UNKNOWN' : 'evaluate() attempts including retries',
    modelMetricsSource: modelMetricsEvidence?.source ?? null,
    modelMetricsStatus: modelMetricsEvidence === null
      ? 'UNKNOWN'
      : modelMetricsConsistencyIssues.length > 0 ? 'CONFLICT' : 'OBSERVED',
    modelMetricsConsistencyIssues,
    system2CallsPerTransition,
    /** Deprecated source field was based on policy calls; do not report it as model calls. */
    deprecatedModelCallsPerMechanicalStep: typeof metrics.modelCallsPerMechanicalStep === 'number'
      ? metrics.modelCallsPerMechanicalStep
      : null,
    typedTerminalOutcome: text(metrics.typedTerminalOutcome, 'vtr.transition.metrics.typedTerminalOutcome'),
    duplicateAuthority: metrics.duplicateAuthority,
    duplicateAuthorityConflicts: count(metrics.duplicateAuthorityConflicts, 'vtr.transition.metrics.duplicateAuthorityConflicts'),
    concurrentLegacyActuations: count(metrics.concurrentLegacyActuations, 'vtr.transition.metrics.concurrentLegacyActuations'),
    precommitUnknownSourceHolds: count(transition.precommitUnknownSourceHolds, 'vtr.transition.precommitUnknownSourceHolds'),
  }

  text(source.commit, 'vtr.source.commit')
  if (!SHA_RE.test(source.commit)) throw new Error('vtr.source.commit must be a full 40-character commit SHA')
  text(source.buildHash, 'vtr.source.buildHash')
  text(run.runId, 'vtr.run.runId')
  text(run.generationId, 'vtr.run.generationId')
  text(run.serverId, 'vtr.run.serverId')
  count(run.worldEpoch, 'vtr.run.worldEpoch')
  text(run.dimension, 'vtr.run.dimension')
  text(run.levelName, 'vtr.run.levelName')
  text(run.seed, 'vtr.run.seed')
  text(mission.id, 'vtr.mission.id')
  text(mission.item, 'vtr.mission.item')
  count(mission.count, 'vtr.mission.count')
  text(transition.transitionId, 'vtr.transition.transitionId')
  text(transition.contractHash, 'vtr.transition.contractHash')
  text(desiredPredicate.id, 'vtr.transition.desiredPredicate.id')

  if (runWorld.epoch !== run.worldEpoch || contractWorld.epoch !== run.worldEpoch || worldIdentity.worldEpoch !== run.worldEpoch) {
    throw new Error('VTR world epoch mismatch between run, worldKey, and Transition contract')
  }
  if (runWorld.dimension !== contractWorld.dimension || runWorld.dimension !== normalizeDimension(run.dimension)) {
    throw new Error('VTR dimension mismatch between run and Transition contract')
  }
  if (run.generationId !== worldIdentity.generationId || run.generationId !== worldIdentity.leaseId) {
    throw new Error('VTR generation/lease identity does not match the Transition world identity')
  }
  if (runWorld.server !== contractWorld.server) throw new Error('VTR server identity mismatch between run and Transition contract')
  if (mission.item !== desiredProposition.item || fixture.relativeResourceSource?.block !== mission.item) {
    throw new Error('VTR Mission item, fixture resource, and Reach predicate item must match')
  }
  if (desiredPredicate.expected !== true || !Array.isArray(ensures) || !ensures.some((entry) =>
    entry && entry.id === desiredPredicate.id && entry.expected === true &&
    isDeepStrictEqual(entry.proposition, desiredProposition))) {
    throw new Error('VTR ensures must contain the declared Reach predicate with expected=true')
  }
  if (mission.missionCompletion !== false) throw new Error('VTR artifact must state missionCompletion=false for a Reach-only probe')
  if (desiredProposition.kind !== 'within-interaction-reach-of-resource-source') {
    throw new Error('VTR desired predicate is not the declared resource-source Reach predicate')
  }
  const archiveVerifiedTerminal = input.archivedProbeAdapter === 'vtr-reach-live-probe-record/v1' &&
    transition.archivedVerificationBeforeOutcome === true && outcome.boundary === 'mechanical-step-outcome'
  if (outcome.kind !== vtrMetrics.typedTerminalOutcome || (outcome.boundary !== 'verified-terminal' && !archiveVerifiedTerminal)) {
    throw new Error('VTR outcome must match typedTerminalOutcome and include a verified terminal boundary proof')
  }
  if (vtrMetrics.verifiedTransitions !== 1 || outcome.kind !== 'SUCCESS') {
    throw new Error('VTR artifact must contain exactly one verified Reach SUCCESS for this comparator')
  }
  if (!Array.isArray(outcome.evidenceIds) || outcome.evidenceIds.length === 0 || outcome.evidenceIds.some((id) => typeof id !== 'string' || id.length === 0)) {
    throw new Error('VTR SUCCESS must have at least one deterministic verification evidence id')
  }
  if (transition.actionSkillReportedSuccessWasNotUsedAsTransitionTerminal !== true) {
    throw new Error('VTR artifact does not establish that action success was excluded as the terminal')
  }
  if (typeof vtrMetrics.duplicateAuthority !== 'boolean') throw new Error('vtr.transition.metrics.duplicateAuthority must be boolean')
  if (vtrMetrics.duplicateAuthority !== (vtrMetrics.duplicateAuthorityConflicts > 0 || vtrMetrics.concurrentLegacyActuations > 0)) {
    throw new Error('VTR duplicateAuthority flag conflicts with conflict/concurrent-actuation counters')
  }
  if (vtrMetrics.duplicateAuthority !== false) throw new Error('VTR probe reports duplicate authority; refusing a clean-comparison report')

  const providerCalls = count(probe.networkModelCalls, 'vtr.configuredNoLlmProbe.networkModelCalls')
  const jevCalls = count(probeJev.decisionCalls, 'vtr.configuredNoLlmProbe.effectiveJev.decisionCalls')
  const system2Calls = count(probeSystem2.decisionCalls, 'vtr.configuredNoLlmProbe.effectiveSystem2.decisionCalls')
  if (jevCalls !== vtrMetrics.legacyJevCallsPerTransition || system2Calls !== vtrMetrics.system2CallsPerTransition) {
    throw new Error('VTR top-level effective policy call counts disagree with per-Transition metrics')
  }
  const noNetworkProfileIssues = []
  if (providerCalls !== 0) noNetworkProfileIssues.push(`configuredNoLlmProbe.networkModelCalls=${providerCalls}`)
  if (vtrMetrics.providerEvaluateAttempts !== null && vtrMetrics.providerEvaluateAttempts !== 0) {
    noNetworkProfileIssues.push(`VTR_TRANSITION_MODEL_METRICS.providerEvaluateAttempts=${vtrMetrics.providerEvaluateAttempts}`)
  }
  if (vtrMetrics.modelMetricsConsistencyIssues.length > 0) {
    noNetworkProfileIssues.push('VTR_TRANSITION_MODEL_METRICS conflicts with another Transition metric')
  }
  const noNetworkProfileStatus = noNetworkProfileIssues.length > 0
    ? 'FAIL'
    : vtrMetrics.modelMetricsStatus === 'UNKNOWN' ? 'UNKNOWN' : 'PASS'

  return {
    schema: input.schema,
    sourceSha: text(source.commit, 'vtr.source.commit'),
    buildHash: source.buildHash,
    runId: run.runId,
    generationId: run.generationId,
    worldKey: run.worldKey,
    worldEpoch: run.worldEpoch,
    dimension: run.dimension,
    levelName: run.levelName,
    seed: run.seed,
    seedAssessment: typeof run.seedAssessment === 'string' ? run.seedAssessment : null,
    minecraftVersion: run.minecraftVersion,
    gameMode: run.gameMode,
    difficulty: run.difficulty,
    mission: {
      kind: text(mission.kind, 'vtr.mission.kind'),
      id: mission.id,
      item: mission.item,
      count: mission.count,
      completed: mission.missionCompletion,
      initialInventory: record(mission.initialInventory, 'vtr.mission.initialInventory'),
      finalInventory: record(mission.finalInventory, 'vtr.mission.finalInventory'),
    },
    fixture: structuredFixture({
      block: fixture.relativeResourceSource?.block,
      position: fixture.relativeResourceSource?.position,
      // Preserve the distinction between where the process booted and where
      // the Reach contract began. The archive's transition start is the
      // controlled comparator input when the harness teleported before commit.
      transitionStartPosition: fixture.transitionStartPosition,
      transitionStartEvidence: fixture.transitionStartEvidence,
      mission,
      sourceOffsetFromInitialPlayer: fixture.sourceOffsetFromInitialPlayer,
      flatSolidGround: typeof fixture.flatSolidGround === 'boolean' ? fixture.flatSolidGround : null,
      witnessChosenByProductionSensor: typeof fixture.witnessChosenByProductionSensor === 'boolean'
        ? fixture.witnessChosenByProductionSensor
        : null,
    }),
    transition: {
      transitionId: transition.transitionId,
      contractHash: transition.contractHash,
      desiredPredicateId: desiredPredicate.id,
      desiredPredicate,
      witness: transition.witness,
      terminal: { kind: outcome.kind, boundary: outcome.boundary, evidenceIds: outcome.evidenceIds },
    },
    metrics: vtrMetrics,
    configuredNoLlm: {
      jevProvider: probeJev.provider,
      jevModel: probeJev.model,
      jevPolicy: probeJev.configuredPolicy,
      system2Provider: probeSystem2.provider,
      system2Model: probeSystem2.model,
      system2Mode: probeSystem2.configuredMode,
      actualNetworkCalls: providerCalls,
    },
    noNetworkProfile: {
      status: noNetworkProfileStatus,
      issues: noNetworkProfileIssues,
    },
  }
}

function checkLegacy(legacy) {
  if (!SHA_RE.test(legacy.sourceSha)) throw new Error(`legacy source SHA must be a full 40-character commit: ${legacy.sourceSha}`)
  if (legacy.expectedSourceSha !== null && !SHA_RE.test(legacy.expectedSourceSha)) throw new Error('legacy recorded origin/main SHA must be a full 40-character commit')
  if (legacy.expectedSourceSha !== null && legacy.sourceSha !== legacy.expectedSourceSha) {
    throw new Error(`legacy source SHA ${legacy.sourceSha} does not match recorded origin/main ${legacy.expectedSourceSha}`)
  }
  if (legacy.worldKey !== null) parseWorldKey(legacy.worldKey, 'legacy.worldKey')
  const metrics = legacy.metrics
  if (metrics.networkModelCalls !== metrics.jevModelCalls + metrics.system2ModelCalls) {
    throw new Error('legacy networkModelCalls must equal Jev provider + System2 LLM calls')
  }
  const expectedRatio = metrics.movementOperationsToInRange === 0 ? null : metrics.networkModelCalls / metrics.movementOperationsToInRange
  if (expectedRatio === null || !closeEnough(metrics.modelCallsPerMechanicalStep, expectedRatio)) {
    throw new Error('legacy modelCallsPerMechanicalStep disagrees with network calls and movement operations')
  }
  if (metrics.vtrTransitions !== 0 || metrics.reachSpecificTerminals !== 0) {
    throw new Error('legacy artifact unexpectedly reports VTR completion/Reach terminals')
  }
  if (metrics.typedOutcome !== 'not-applicable/no VTR contract') {
    throw new Error('legacy artifact must preserve no-contract typed outcome as not applicable')
  }
  if (legacy.actualSystem2Calls !== metrics.system2ModelCalls || legacy.effectiveJevNetworkCalls !== metrics.jevModelCalls) {
    throw new Error('legacy effective provider call counts disagree with slice metrics')
  }
  return legacy
}

const legacyInput = readJson(legacyPath, 'legacy')
const vtrInput = readJson(vtrPath, 'VTR')
const legacy = checkLegacy(parseLegacy(legacyInput.value, legacyInput.sourceText, legacyPath))
const vtrArchive = findVtrArchive(vtrPath, vtrInput.value)
const vtr = parseVtr(adaptArchivedVtrProbe(vtrInput.value, vtrArchive?.root ?? dirname(vtrPath)))

if (legacy.runId === vtr.runId || legacy.generationId === vtr.generationId) {
  throw new Error('legacy and VTR inputs must be distinct runs and generations')
}
const legacyWorld = legacy.worldKey === null ? null : parseWorldKey(legacy.worldKey, 'legacy.worldKey')
const vtrWorld = parseWorldKey(vtr.worldKey, 'vtr.run.worldKey')
if ((legacyWorld !== null && legacyWorld.epoch !== legacy.worldEpoch) || vtrWorld.epoch !== vtr.worldEpoch) {
  throw new Error('worldKey epoch does not match the recorded worldEpoch')
}

const missionInputMatch = legacy.sameMissionClaim === false
  ? false
  : legacy.missionInput !== null
  ? legacy.missionInput.kind === vtr.mission.kind && legacy.missionInput.item === vtr.mission.item && legacy.missionInput.count === vtr.mission.count
  : null
const sameTargetResourceKind = legacy.fixture === null ? null : legacy.fixture.block === vtr.fixture.block
const sameExactCartesianDelta = legacy.fixture === null || legacy.fixture.exactCartesianDelta === null || vtr.fixture.exactCartesianDelta === null
  ? null
  : ['x', 'y', 'z'].every((key) => closeEnough(legacy.fixture.exactCartesianDelta[key], vtr.fixture.exactCartesianDelta[key]))
const sameRelativeBlockOffset = legacy.fixture === null || legacy.fixture.relativeBlockOffset === null || vtr.fixture.relativeBlockOffset === null
  ? null
  : ['x', 'y', 'z'].every((key) => closeEnough(legacy.fixture.relativeBlockOffset[key], vtr.fixture.relativeBlockOffset[key]))
const declaredOffsetsConsistent = [legacy.fixture, vtr.fixture].every((fixture) => fixture === null || fixture.declaredOffsetMatchesDerived !== false)
const sameRelativeFixture = legacy.fixture === null
  ? null
  : sameTargetResourceKind === false || sameExactCartesianDelta === false || sameRelativeBlockOffset === false || !declaredOffsetsConsistent
    ? false
    : sameExactCartesianDelta === true && sameRelativeBlockOffset === true
      ? true
      : null
const fixtureFlatnessMatch = legacy.fixture === null || typeof legacy.fixture.flatSolidGround !== 'boolean' || typeof vtr.fixture.flatSolidGround !== 'boolean'
  ? null
  : legacy.fixture.flatSolidGround === vtr.fixture.flatSolidGround && vtr.fixture.flatSolidGround === true
const fixtureSensorBinding = vtr.fixture.witnessChosenByProductionSensor === true
  ? true
  : vtr.fixture.witnessChosenByProductionSensor === false
    ? false
    : null
const fixtureAlignmentMatch = [sameTargetResourceKind, sameRelativeFixture, fixtureFlatnessMatch, fixtureSensorBinding].includes(false)
  ? false
  : [sameTargetResourceKind, sameRelativeFixture, fixtureFlatnessMatch, fixtureSensorBinding].every((value) => value === true)
    ? true
    : null
const environmentMatch = Object.fromEntries(['minecraftVersion', 'gameMode', 'difficulty', 'dimension'].map((field) => [
  field,
  field === 'dimension'
    ? legacyWorld === null
      ? 'unknown'
      : legacyWorld.dimension === normalizeDimension(vtr.dimension)
    : legacy[field] === undefined || legacy[field] === null || legacy[field] === 'not recorded'
    ? 'unknown'
    : legacy[field] === vtr[field],
]))
environmentMatch.seed = legacy.seed === 'not recorded' || legacy.seed === undefined || legacy.seed === null || vtr.seed === 'not recorded'
  ? 'unknown'
  : String(legacy.seed) === String(vtr.seed)
if (vtr.seedAssessment !== null) {
  environmentMatch.seedProvenance = /disagree|mismatch|conflict/i.test(vtr.seedAssessment) ? false : true
}
const environmentAlignment = Object.values(environmentMatch).includes(false)
  ? false
  : Object.values(environmentMatch).every((value) => value === true)
    ? true
    : null
const alignment = {
  missionInput: missionInputMatch === true ? 'PASS' : missionInputMatch === false ? 'NOT_COMPARABLE' : 'INCOMPLETE',
  fixture: fixtureAlignmentMatch === true ? 'PASS' : fixtureAlignmentMatch === false ? 'NOT_COMPARABLE' : 'INCOMPLETE',
  environment: environmentAlignment === true ? 'PASS' : environmentAlignment === false ? 'NOT_COMPARABLE' : 'INCOMPLETE',
}
const alignmentStates = Object.values(alignment)
const alignedStatus = alignmentStates.includes('NOT_COMPARABLE')
  ? 'NOT_COMPARABLE'
  : alignmentStates.includes('INCOMPLETE')
    ? 'INCOMPLETE'
    : 'PASS'
const noNetworkProfileIssues = [...vtr.noNetworkProfile.issues]
const noNetworkProfileStatus = noNetworkProfileIssues.length > 0
  ? 'FAIL'
  : vtr.metrics.modelMetricsStatus === 'UNKNOWN' ? 'UNKNOWN' : 'PASS'
const rawComparisonEvidence = captureRawComparisonEvidence({ legacy, vtr, vtrArchive, vtrInputPath: vtrPath })
const comparisonStatus = noNetworkProfileStatus === 'FAIL'
  ? 'INVALID_NO_LLM_PROFILE'
  : alignedStatus === 'PASS' && (noNetworkProfileStatus !== 'PASS' || rawComparisonEvidence.status !== 'PASS')
    ? 'INCOMPLETE'
    : alignedStatus
const output = {
  schema: 'vtr-reach-fixture-comparison/v3',
  comparisonStatus,
  classification: comparisonStatus === 'PASS'
    ? 'exact Mission/fixture/environment alignment backed by run-scoped raw events from both executions'
    : comparisonStatus === 'INVALID_NO_LLM_PROFILE'
      ? 'invalid VTR no-LLM probe profile; provider activity is present or its metrics conflict'
    : comparisonStatus === 'NOT_COMPARABLE'
      ? 'inputs contain a known Mission/fixture/environment mismatch'
      : 'alignment or exact run-scoped raw comparison evidence is incomplete',
  evidenceClass: rawComparisonEvidence.status === 'PASS' ? 'run-scoped-raw-events' : 'summary-only',
  acceptanceEligible: comparisonStatus === 'PASS' && rawComparisonEvidence.status === 'PASS',
  acceptanceStatus: comparisonStatus === 'PASS' && rawComparisonEvidence.status === 'PASS'
    ? 'ASSESSED_RAW_RUN_COMPARISON'
    : rawComparisonEvidence.status === 'PASS' ? 'RAW_CAPTURED_ALIGNMENT_INCOMPLETE' : 'RAW_EVIDENCE_INCOMPLETE',
  rawComparisonEvidence,
  alignment,
  noNetworkProfile: {
    status: noNetworkProfileStatus,
    appliesTo: 'VTR no-LLM capability probe only; legacy provider calls are measured as a comparison metric',
    issues: noNetworkProfileIssues,
    modelMetrics: {
      status: vtr.metrics.modelMetricsStatus,
      source: vtr.metrics.modelMetricsSource,
      decisionFrameInvocations: vtr.metrics.decisionFrameInvocations,
      providerEvaluateAttemptsIncludingRetries: vtr.metrics.providerEvaluateAttempts,
    },
  },
  inputs: { legacy: legacyPath, vtr: vtrPath },
  lineage: {
    legacy: {
      artifactSchema: legacy.schema,
      sourceSha: legacy.sourceSha,
      recordedOriginMainSha: legacy.expectedSourceSha,
      buildHash: legacy.buildHash,
      runId: legacy.runId,
      generationId: legacy.generationId,
      worldKey: legacy.worldKey,
      worldEpoch: legacy.worldEpoch,
      dimension: legacyWorld?.dimension ?? null,
      levelName: legacy.levelName,
      seed: legacy.seed,
      minecraftVersion: legacy.minecraftVersion,
      gameMode: legacy.gameMode,
      difficulty: legacy.difficulty,
    },
    vtr: {
      artifactSchema: vtr.schema,
      sourceSha: vtr.sourceSha,
      buildHash: vtr.buildHash,
      runId: vtr.runId,
      generationId: vtr.generationId,
      worldKey: vtr.worldKey,
      worldEpoch: vtr.worldEpoch,
      dimension: vtr.dimension,
      levelName: vtr.levelName,
      seed: vtr.seed,
      seedAssessment: vtr.seedAssessment,
      minecraftVersion: vtr.minecraftVersion,
      gameMode: vtr.gameMode,
      difficulty: vtr.difficulty,
    },
  },
  fixtureAlignment: {
    sameTargetResourceKind,
    sameExactCartesianDelta,
    sameRelativeBlockOffset,
    sameRelativeFixture,
    sameFlatGround: fixtureFlatnessMatch,
    vtrWitnessSensorBound: fixtureSensorBinding,
    environmentMatch,
    legacyFixture: legacy.fixtureDescription,
    legacyFixtureEvidencePath: legacy.fixtureEvidencePath,
    legacyFixtureStructured: legacy.fixture,
    vtrFixture: {
      block: vtr.fixture.block,
      sourcePosition: vtr.fixture.position,
      initialPlayerPosition: vtr.fixture.initialPlayerPosition,
      initialPlayerPositionSource: vtr.fixture.initialPlayerPositionSource,
      initialPlayerPositionEvidence: vtr.fixture.initialPlayerPositionEvidence,
      exactCartesianDelta: vtr.fixture.exactCartesianDelta,
      relativeBlockOffset: vtr.fixture.relativeBlockOffset,
      declaredOffset: vtr.fixture.declaredOffset,
      declaredOffsetConvention: vtr.fixture.declaredOffsetConvention,
      declaredOffsetMatchesDerived: vtr.fixture.declaredOffsetMatchesDerived,
      witnessChosenByProductionSensor: vtr.fixture.witnessChosenByProductionSensor,
      flatSolidGround: vtr.fixture.flatSolidGround,
    },
    sameMissionInput: missionInputMatch,
    legacyMissionInput: legacy.missionInput,
    legacyMissionDescription: legacy.missionDescription,
    vtrMission: vtr.mission,
  },
  metrics: {
    reachBoundary: {
      legacy: {
        movementOperationsToInRangeEvidence: legacy.metrics.movementOperationsToInRange,
        moveActionsToInRangeEvidence: legacy.metrics.moveActionsToInRange,
        policyDecisionFramesToInRangeEvidence: legacy.metrics.decisionFramesToInRange,
        policyQuestionCallsToInRangeEvidence: legacy.metrics.questionCallsToInRange,
        transitionCommitCount: legacy.metrics.vtrTransitions,
        reachSpecificVerifiedTerminalCount: legacy.metrics.reachSpecificTerminals,
        moveActionOutcome: legacy.metrics.actionOutcome,
        reachTypedOutcome: legacy.metrics.typedOutcome,
      },
      vtr: {
        verifiedTransitionCompletionCount: vtr.metrics.verifiedTransitions,
        transitionId: vtr.transition.transitionId,
        contractHash: vtr.transition.contractHash,
        desiredPredicateId: vtr.transition.desiredPredicateId,
        mechanicalStepsPerTransition: vtr.metrics.mechanicalStepsPerTransition,
        typedTerminalOutcome: vtr.metrics.typedTerminalOutcome,
        verificationEvidenceIds: vtr.transition.terminal.evidenceIds,
        deterministicVerifyBoundary: vtr.transition.terminal.boundary,
      },
      movementCountComparability: 'Counts are shown with their distinct boundaries: legacy steps through inReach evidence versus VTR steps owned by one verified Transition. Do not interpret the equal value as a controlled efficiency result.',
    },
    policyAndModels: {
      legacy: {
        effectiveJevProvider: legacy.effectiveJev?.provider ?? 'not recorded in this artifact schema',
        effectiveJevModel: legacy.effectiveJev?.model ?? 'not recorded in this artifact schema',
        effectiveJevPolicy: legacy.effectiveJev?.policy ?? 'not recorded in this artifact schema',
        jevProviderModelCalls: legacy.metrics.jevModelCalls,
        system2LlmCalls: legacy.metrics.system2ModelCalls,
        networkModelCalls: legacy.metrics.networkModelCalls,
        networkModelCallsPerMovementStep: legacy.metrics.modelCallsPerMechanicalStep,
        providerActivity: legacy.metrics.networkModelCalls === 0 ? 'raw journals show zero provider attempts' : 'raw journals show provider attempts; permitted for the legacy baseline',
      },
      vtr: {
        ...vtr.configuredNoLlm,
        legacyJevCallsPerTransition: vtr.metrics.legacyJevCallsPerTransition,
        decisionFrameInvocationsPerTransition: vtr.metrics.decisionFrameInvocations,
        jevProviderEvaluateAttemptsIncludingRetriesPerTransition: vtr.metrics.providerEvaluateAttempts,
        jevProviderEvaluateAttemptsPerMechanicalStep: vtr.metrics.providerEvaluateAttemptsPerMechanicalStep,
        providerAttemptMeaning: vtr.metrics.providerAttemptMeaning,
        modelMetricsStatus: vtr.metrics.modelMetricsStatus,
        modelMetricsSource: vtr.metrics.modelMetricsSource,
        modelMetricsConsistencyIssues: vtr.metrics.modelMetricsConsistencyIssues,
        system2CallsPerTransition: vtr.metrics.system2CallsPerTransition,
        deprecatedModelCallsPerMechanicalStep: vtr.metrics.deprecatedModelCallsPerMechanicalStep,
        precommitUnknownSourceHolds: vtr.metrics.precommitUnknownSourceHolds,
      },
      interpretation: 'Legacy Jev/System2 provider activity is independently measured from its raw journals and may be nonzero. The zero-network requirement applies only to the VTR no-LLM probe. VTR Decision Frame invocations and provider evaluate attempts are separate; provider attempts include retries.',
    },
    authority: {
      legacy: { status: 'not-applicable: baseline source has no VTR authority to compare against', duplicateAuthority: null },
      vtr: {
        // Exclusivity proof (positive form): true means the probe recorded
        // exactly one authority and no legacy concurrent actuation. The raw
        // probe flag `duplicateAuthority` is the negative violation flag
        // (false = no duplicate); both polarities are preserved below.
        duplicateAuthority: vtr.metrics.duplicateAuthority === false &&
          vtr.metrics.duplicateAuthorityConflicts === 0 && vtr.metrics.concurrentLegacyActuations === 0,
        duplicateAuthorityReported: vtr.metrics.duplicateAuthority,
        duplicateAuthorityConflicts: vtr.metrics.duplicateAuthorityConflicts,
        concurrentLegacyActuations: vtr.metrics.concurrentLegacyActuations,
      },
      interpretation: 'The VTR probe reports no concurrent legacy actuation in that run. The legacy run cannot prove mutual exclusion; a dedicated mixed-path integration fixture is required.',
    },
  },
  limitations: [
    'These artifacts have distinct run identities; the comparator does not replay or align an identical world state, so this is not a same-world A/B experiment.',
    'Fixture coordinates are reported as both exact body-position deltas and block offsets from floor(initial body position); fixture equivalence does not make different top-level Mission inputs comparable.',
    'Mission equivalence is read from the legacy run-scoped artifact before comparison-request fields; an explicit sameMissionInput=false claim always vetoes equality.',
    'Raw comparison evidence binds the selected logger/journal bytes by SHA-256. Different runs remain different worlds; this is not a same-world A/B replay.',
    'Summary-only evidence, missing model metrics, missing raw artifacts, or any Mission/fixture/environment mismatch remains INCOMPLETE or NOT_COMPARABLE.',
    'The VTR no-network probe profile is checked independently from legacy provider activity. Legacy model calls may be nonzero and are reported as measured; a missing VTR_TRANSITION_MODEL_METRICS event leaves Decision Frame and provider-attempt counts UNKNOWN.',
    'Legacy MOVE action SUCCESS/verified and the next-frame inReach candidate are not a Reach-specific deterministic terminal. Only the VTR artifact records a Reach Contract SUCCESS with verifier evidence.',
    'The VTR probe establishes the Reach predicate only; its oak_log inventory Mission remains incomplete. Neither artifact proves autonomous long-horizon composition or M2/M3.',
  ],
}

// The event binder produces a convenient first-pass comparison bundle. Before
// exposing any acceptance PASS, independently reparse every raw byte through
// the archive acceptance validator. A self-reported summary/counter is never
// sufficient to upgrade this report.
const rawAcceptanceCheck = inspectReachComparisonProof(output, vtr.sourceSha, CURRENT_ORIGIN_MAIN_SHA)
output.rawAcceptanceValidation = rawAcceptanceCheck
if (rawAcceptanceCheck.status !== 'PASS') {
  output.rawComparisonEvidence.status = rawAcceptanceCheck.status
  output.rawComparisonEvidence.evidenceClass = 'summary-only-or-incomplete-raw'
  output.rawComparisonEvidence.validation = rawAcceptanceCheck
  output.evidenceClass = 'summary-only'
}
if (output.acceptanceEligible && rawAcceptanceCheck.status !== 'PASS') {
  output.comparisonStatus = rawAcceptanceCheck.status === 'FAIL' ? 'FAIL' : 'INCOMPLETE'
  output.classification = rawAcceptanceCheck.status === 'FAIL'
    ? 'raw event evidence contradicts itself under the independent acceptance parser'
    : 'raw event evidence failed the independent acceptance parser'
  output.acceptanceEligible = false
  output.acceptanceStatus = 'RAW_EVIDENCE_INCOMPLETE'
}

console.log(JSON.stringify(output, null, 2))
process.exitCode = noNetworkProfileStatus === 'FAIL' || output.comparisonStatus === 'FAIL' ? 1 : output.comparisonStatus === 'PASS' ? 0 : 2
