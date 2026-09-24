#!/usr/bin/env node
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
// This tool only reads the two JSON inputs and writes a JSON report to stdout.
// PASS means structured Mission + fixture + environment alignment only; it is
// not migration acceptance because these inputs are summaries, not raw evidence.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

const SHA_RE = /^[0-9a-f]{40}$/i

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
    return { value: JSON.parse(text), sourceText: text }
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

function findArchiveRoot(inputPath, requiredRelativePath) {
  let current = dirname(resolve(inputPath))
  while (true) {
    if (existsSync(join(current, requiredRelativePath))) return current
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

function legacyFixtureFromArchive(archiveRoot, expected) {
  const path = join(archiveRoot, 'runner', 'reach-slice-evidence.json')
  const evidence = readOptionalJson(path, 'legacy Reach slice evidence')
  if (evidence === null) return { evidence: null, path: null, fixture: null }
  for (const [key, wanted] of Object.entries(expected)) {
    if (evidence[key] !== wanted) {
      throw new Error(`legacy Reach slice evidence ${key}=${String(evidence[key])} does not match summary ${String(wanted)}`)
    }
  }

  const fixtureCommandsPath = join(archiveRoot, 'server', 'fixture-commands.jsonl')
  let flatSolidGround = null
  if (existsSync(fixtureCommandsPath)) {
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
    path: existsSync(path) ? 'runner/reach-slice-evidence.json' : null,
    fixture: evidence.fixture && flatSolidGround !== null
      ? { ...evidence.fixture, flatSolidGround }
      : evidence.fixture ?? null,
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
    const archiveRoot = findArchiveRoot(legacyPath, join('runner', 'reach-slice-evidence.json')) ?? dirname(legacyPath)
    const archiveFixture = legacyFixtureFromArchive(archiveRoot, {
      runId: baseline.runId,
      generationId: baseline.generationId,
      sourceSha: baseline.commit,
      buildHash: baseline.buildHash,
    })
    const fixtureRaw = comparison.fixture ?? archiveFixture.fixture ?? baseline.fixture ?? input.fixture
    return {
      schema: input.schema,
      sourceSha: text(baseline.commit, 'legacy.baseline.commit'),
      expectedSourceSha: typeof baseline.originMainAtCheckout === 'string' ? baseline.originMainAtCheckout : null,
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
      missionInput: structuredMission(input.missionInput ?? input.legacyMissionInput ?? baseline.missionInput ?? baseline.mission ?? comparison.missionInput),
      sameMissionClaim: comparison.sameMissionInput === true ? true : comparison.sameMissionInput === false ? false : null,
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
      missionDescription: typeof input.comparison.reason === 'string' ? input.comparison.reason : 'mission equivalence not specified',
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
    return {
      schema: input.schema,
      sourceSha,
      expectedSourceSha: null,
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
      fixture: structuredFixture(fixture),
      fixtureEvidencePath: null,
      missionInput: structuredMission(input.missionInput ?? input.legacyMissionInput ?? input.mission ?? oldPlan.missionInput ?? oldPlan.mission),
      sameMissionClaim: typeof input.sameMissionInput === 'boolean' ? input.sameMissionInput : null,
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
      metrics: { ...metrics, concurrentLegacyActuations: 0 },
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
  const vtrMetrics = {
    verifiedTransitions: count(metrics.verifiedTransitionCompletion, 'vtr.transition.metrics.verifiedTransitionCompletion'),
    mechanicalStepsPerTransition: count(metrics.mechanicalStepsPerTransition, 'vtr.transition.metrics.mechanicalStepsPerTransition'),
    jevCallsPerTransition: count(metrics.jevCallsPerTransition, 'vtr.transition.metrics.jevCallsPerTransition'),
    system2CallsPerTransition: count(metrics.system2CallsPerTransition, 'vtr.transition.metrics.system2CallsPerTransition'),
    modelCallsPerMechanicalStep: ratio(metrics.modelCallsPerMechanicalStep, 'vtr.transition.metrics.modelCallsPerMechanicalStep'),
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
  if (providerCalls !== 0 || jevCalls !== vtrMetrics.jevCallsPerTransition || system2Calls !== vtrMetrics.system2CallsPerTransition) {
    throw new Error('VTR top-level effective policy call counts disagree with per-Transition metrics')
  }
  const totalVtrModelCalls = vtrMetrics.jevCallsPerTransition + vtrMetrics.system2CallsPerTransition
  const expectedVtrRatio = vtrMetrics.mechanicalStepsPerTransition === 0 ? null : totalVtrModelCalls / vtrMetrics.mechanicalStepsPerTransition
  if (expectedVtrRatio === null || !closeEnough(vtrMetrics.modelCallsPerMechanicalStep, expectedVtrRatio)) {
    throw new Error('VTR modelCallsPerMechanicalStep disagrees with Jev + System2 calls and mechanical steps')
  }

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
const vtr = parseVtr(adaptArchivedVtrProbe(vtrInput.value, dirname(vtrPath)))

if (legacy.runId === vtr.runId || legacy.generationId === vtr.generationId) {
  throw new Error('legacy and VTR inputs must be distinct runs and generations')
}
const legacyWorld = legacy.worldKey === null ? null : parseWorldKey(legacy.worldKey, 'legacy.worldKey')
const vtrWorld = parseWorldKey(vtr.worldKey, 'vtr.run.worldKey')
if ((legacyWorld !== null && legacyWorld.epoch !== legacy.worldEpoch) || vtrWorld.epoch !== vtr.worldEpoch) {
  throw new Error('worldKey epoch does not match the recorded worldEpoch')
}
if (legacy.metrics.networkModelCalls !== 0 || vtr.configuredNoLlm.actualNetworkCalls !== 0) {
  throw new Error('these artifacts are only comparable under the archived no-network-model-call setup')
}

const missionInputMatch = legacy.missionInput !== null
  ? legacy.missionInput.kind === vtr.mission.kind && legacy.missionInput.item === vtr.mission.item && legacy.missionInput.count === vtr.mission.count
  : legacy.sameMissionClaim === false
    ? false
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
const comparisonStatus = alignmentStates.includes('NOT_COMPARABLE')
  ? 'NOT_COMPARABLE'
  : alignmentStates.includes('INCOMPLETE')
    ? 'INCOMPLETE'
    : 'PASS'
const output = {
  schema: 'vtr-reach-fixture-comparison/v2',
  comparisonStatus,
  classification: comparisonStatus === 'PASS'
    ? 'structured Mission/fixture/environment alignment; summary comparison only'
    : comparisonStatus === 'NOT_COMPARABLE'
      ? 'inputs contain a known Mission/fixture/environment mismatch'
      : 'alignment cannot be established from the available structured summary fields',
  evidenceClass: 'summary-only',
  acceptanceEligible: false,
  acceptanceStatus: 'NOT_ASSESSED_SUMMARY_ONLY',
  alignment,
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
      },
      vtr: {
        ...vtr.configuredNoLlm,
        jevCallsPerTransition: vtr.metrics.jevCallsPerTransition,
        system2CallsPerTransition: vtr.metrics.system2CallsPerTransition,
        networkModelCallsPerMechanicalStep: vtr.metrics.modelCallsPerMechanicalStep,
        precommitUnknownSourceHolds: vtr.metrics.precommitUnknownSourceHolds,
      },
      interpretation: 'Both archived runs explicitly used no network model calls. This does not measure provider behavior, latency, or production Jev efficiency. Decision frames/question calls are reported separately from provider model calls.',
    },
    authority: {
      legacy: { status: 'not-applicable: baseline source has no VTR authority to compare against', duplicateAuthority: null },
      vtr: {
        duplicateAuthority: vtr.metrics.duplicateAuthority,
        duplicateAuthorityConflicts: vtr.metrics.duplicateAuthorityConflicts,
        concurrentLegacyActuations: vtr.metrics.concurrentLegacyActuations,
      },
      interpretation: 'The VTR probe reports no concurrent legacy actuation in that run. The legacy run cannot prove mutual exclusion; a dedicated mixed-path integration fixture is required.',
    },
  },
  limitations: [
    'These artifacts have distinct run identities; the comparator does not replay or align an identical world state, so this is not a same-world A/B experiment.',
    'Fixture coordinates are reported as both exact body-position deltas and block offsets from floor(initial body position); fixture equivalence does not make different top-level Mission inputs comparable.',
    'A PASS means only that structured Mission/fixture/environment fields align. A summary-only PASS is not a VTR migration acceptance result.',
    'Both runs explicitly used offline/deterministic policy and recorded zero network model calls; no provider performance or production model-behavior gain is established.',
    'Legacy MOVE action SUCCESS/verified and the next-frame inReach candidate are not a Reach-specific deterministic terminal. Only the VTR artifact records a Reach Contract SUCCESS with verifier evidence.',
    'The VTR probe establishes the Reach predicate only; its oak_log inventory Mission remains incomplete. Neither artifact proves autonomous long-horizon composition or M2/M3.',
  ],
}

console.log(JSON.stringify(output, null, 2))
process.exitCode = comparisonStatus === 'PASS' ? 0 : 2
