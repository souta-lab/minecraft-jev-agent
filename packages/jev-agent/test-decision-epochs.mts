// test-decision-epochs.mts - JEV-BEST-PRACTICES §18 Gate C: semantic decision
// epochs and controller commitment.
//
// The p24 defect evidence: `emitSkillOutcomePacket` closed the decision epoch
// on every settled Skill, so the next tick classified `active === null` as
// `first_decision` and re-queried the model - 1,215 calls in a healthy hour
// whose semantic situation never changed. The replay branch was unreachable.
//
// Gate C contract under test (drives the real `decide`/`emitSkillOutcomePacket`
// against a counting stub policy - never the model):
//   1. the FIRST unanswered situation spends one provider call;
//   2. a settled `done` + unchanged semantic situation REPLAYS: no provider
//      call, and the replay is attributed to a NEW epoch (cacheHit + reusedFrom);
//   3. outcome-memory churn (previousDecision/recentOutcomes/meaningfulDelta)
//      never reopens WHICH on its own;
//   4. a genuine candidate-identity change re-queries (`candidate_set_changed`);
//   5. a mandatory outcome (target_lost) re-queries (`skill_outcome_boundary`);
//   6. banded progress changes re-query (`progress_boundary`), same-band churn
//      does not;
//   7. a stale-dropped result never becomes the replay anchor: the boundary
//      stays anchored to the last ACCEPTED answer.
import assert from 'node:assert/strict'
import {
  decide,
  emitSkillOutcomePacket,
  onGuardReject,
  repointReplay,
  type DecisionEpochsHost,
} from './src/decision-epochs.ts'
import type { DecisionRecord } from './src/decisionlog.ts'
import { noteRepeatedOutcome } from './src/outcome-ledgers.ts'
import type { OutcomeLedgersHost, RepeatedOutcomeResult } from './src/outcome-ledgers.ts'
import type { GuardResult } from './src/policy.ts'
import { filterRetiredRepeats, RepeatedOutcomeEscalation, REPEATED_OUTCOME_LIMIT_DEFAULT } from './src/repeatedOutcomeEscalation.ts'
import { buildJevSemanticProjection, JevDecisionEpochs } from './src/jev/semantic-projection.ts'
import type { DecisionEpoch, SemanticProjectionInput } from './src/jev/semantic-projection.ts'
import type { Candidate } from './src/candidates.ts'
import type { JevRequest, JevResult } from './src/jev/client.ts'
import type { WorldState } from './src/state.ts'

const OVERWORLD = 'minecraft:overworld'

function candidate(input: Partial<Candidate> & { id: string; kind: Candidate['kind'] }): Candidate {
  return {
    targetName: null,
    target: null,
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: false,
    hasStandableAdjacent: true,
    label: input.id,
    meta: {},
    ...input,
  } as Candidate
}

const MINE = candidate({ id: 'MINE:b10_20_30', kind: 'MINE', label: 'mine obsidian', targetName: 'obsidian', target: { x: 10, y: 20, z: 30 } })
const WAIT = candidate({ id: 'WAIT', kind: 'WAIT' })

function projectionInput(overrides: Partial<SemanticProjectionInput> = {}): SemanticProjectionInput {
  return {
    goal: { key: 'collect:obsidian:10', targetItem: 'obsidian', have: 0, required: 10, complete: false, progress: 0 },
    option: {
      instanceId: 'option:collect_obsidian#1',
      templateId: 'collect:obsidian',
      semanticInstanceId: 'option:collect_obsidian#1',
      semanticTemplateId: 'collect:obsidian',
      intent: 'collect 10 obsidian',
      skillKind: 'MINE',
      targetKey: 'obsidian',
      preconditions: ['pickaxe rank >= 4'],
      success: ['obsidian >= 10'],
      allowedSkills: ['MINE', 'MOVE', 'WAIT'],
      verifiedProgress: 0,
      failures: 0,
    },
    world: { dimension: OVERWORLD, worldEpoch: 7, generationId: 'gen-test', leaseHeld: true, alive: true },
    safety: {
      healthBand: 'healthy', foodBand: 'full', airBand: 'full', dayPhase: 'day', submerged: false,
      threatKey: null, criticalDamageKey: null, lastDamageKey: null, wornArmor: null, offhand: null,
    },
    progress: {
      consecutiveFailures: 0,
      lastFailureCode: null,
      escalationRecommended: false,
      oscillationsDetected: 0,
      stall: null,
    },
    queue: { depth: 1, empty: false, hasImpossible: false, current: null },
    inventory: { cobblestone: 3 },
    events: [],
    candidates: [MINE, WAIT],
    identityContext: { optionInstanceId: 'option:collect_obsidian#1', dimension: OVERWORLD, worldEpoch: 7 },
    ...overrides,
  }
}

function worldState(tick: number): WorldState {
  return {
    tick,
    self: { position: { x: 0.5, y: 64, z: 0.5 }, health: 20, food: 20, dimension: OVERWORLD },
    signals: { failedCandidates: {}, consecutiveFailures: 0, lastFailureCode: null, escalationRecommended: false, oscillationsDetected: 0 },
    goalQueue: { current: null },
    inventory: { counts: { cobblestone: 3 } },
  } as unknown as WorldState
}

interface Harness {
  host: DecisionEpochsHost
  calls: JevRequest[]
  boundaryReasons: string[]
  epochs: JevDecisionEpochs
  /** make the in-flight epoch stale during the next provider call */
  dropNextResult: boolean
}

function harness(): Harness {
  const calls: JevRequest[] = []
  const boundaryReasons: string[] = []
  const epochs = new JevDecisionEpochs()
  const box = { dropNextResult: false } as { dropNextResult: boolean }
  const host = {
    actionEpochByLease: new Map(),
    actionCommitmentState: null,
    activeRetrieval: null,
    commitmentProgressEpoch: 0,
    commitmentState: null,
    compressedSkillSteps: 0,
    conflictDeferrals: 0,
    currentGoalKey: () => 'collect:obsidian:10',
    currentOptionContext: () => null,
    decisionEpochs: epochs,
    decisionWriter: { write: () => {} },
    deferredTrigger: null,
    escalate: () => {},
    goal: { complete: false, progress: 0 },
    guardRejections: 0,
    lastSemanticProjection: null,
    lastAnsweredProjection: null,
    lastAnsweredEpoch: null,
    lastSkillOutcome: null,
    lastStateFingerprint: '',
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    optionAttempts: null,
    options: { worldEpoch: 7, lowConfidenceThreshold: 0 },
    pendingTrigger: null,
    progressEpoch: 0,
    queue: null,
    recentEvents: [],
    recentSkillOutcomes: [],
    retrievalTrack: null,
    skillOutcomeBoundary: false,
    tickCounter: 1,
    waitSuppressed: false,
    withheldCandidateIds: new Set<string>(),
    jevCalls: 0,
    lastJevAt: 0,
    lastDecision: null,
    lastDecisionId: null,
    lastProjectionHash: null,
    staleDecisionDropped: false,
    lastAbandonAdopted: false,
    policyEpoch: 0,
    issuedPolicyEpoch: 0,
    issuedCandidateHash: '',
    signals: { lastPolicyConfidence: null },
    jev: {
      kind: 'typesafe',
      model: 'stub-model',
      async decide(request: JevRequest): Promise<JevResult> {
        calls.push(request)
        if (box.dropNextResult) {
          box.dropNextResult = false
          epochs.invalidate('world_changed')
        }
        const choice = request.candidates[0]?.id ?? 'WAIT'
        return {
          callId: `stub-${calls.length}`,
          policy: 'typesafe',
          source: 'jev',
          model: 'stub-model',
          latencyMs: 1,
          usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
          answers: {
            action: { name: 'action', type: 'choice', value: choice, probability: 0.9, confidence: 0.9, probabilities: { [choice]: 0.9 }, legend: null, note: null },
          },
        } as JevResult
      },
    },
    abandonVerdict: () => null,
    applyAbandon: () => false,
    logHeads: () => {},
    logShadowMetrics: () => {},
    logBoundary: (_e: unknown, reason: string) => {
      boundaryReasons.push(reason)
    },
    logEpochSuperseded: () => {},
    buildSemanticProjection: (_s: unknown, cands: readonly Candidate[], merged: number) =>
      buildJevSemanticProjection(projectionInput({ candidates: cands.length === 0 ? [WAIT] : [...cands] })),
    repointReplay: (result: JevResult, views: never) => repointReplay(host as unknown as DecisionEpochsHost, result, views),
  } as unknown as DecisionEpochsHost
  // The mock's buildSemanticProjection must be overridable per scenario.
  const h: Harness = { host, calls, boundaryReasons, epochs, dropNextResult: false }
  Object.defineProperty(h, 'dropNextResult', {
    get: () => box.dropNextResult,
    set: (v: boolean) => {
      box.dropNextResult = v
    },
  })
  return h
}

/** Swap the projection fixture the host's compiler returns (semantic change). */
function withProjection(host: DecisionEpochsHost, overrides: Partial<SemanticProjectionInput>): void {
  ;(host as unknown as { buildSemanticProjection: (s: unknown, c: readonly Candidate[], m: number) => unknown }).buildSemanticProjection =
    (_s, cands) => buildJevSemanticProjection(projectionInput({ candidates: [...cands], ...overrides }))
}

// --- 1. first_decision spends exactly one provider call. ---
const h = harness()
const state = worldState(1)
const offer = [MINE, WAIT]
const first = await decide(h.host, state, offer, 'start', 'chain-1')
assert.equal(h.calls.length, 1)
assert.equal(h.calls[0]!.decisionReason, 'first_decision')
assert.equal(h.boundaryReasons[0], 'first_decision')
assert.equal(first.answers.action!.value, 'MINE:b10_20_30')
assert.ok(h.host.lastAnsweredProjection !== null)
const epoch1: DecisionEpoch | null = h.epochs.active
assert.ok(epoch1 !== null && epoch1.cacheHit === false)
assert.equal(epoch1!.reusedFrom, null)

// --- 2. a settled `done` + unchanged semantics REPLAYS inside a new epoch. ---
const packet = emitSkillOutcomePacket(h.host, {
  actionId: 'MINE:b10_20_30',
  kind: 'MINE',
  leaseEpoch: null,
  status: 'done',
  failure: null,
  verified: true,
  progressed: true,
  itemsGained: 1,
  blockRemoved: true,
  entityDefeated: false,
  targetName: 'obsidian',
  candidate: MINE,
  verification: 'obsidian_removed',
})
assert.equal(packet.terminalReason, 'done')
assert.equal(h.host.skillOutcomeBoundary, false, 'done is NOT a mandatory boundary')
assert.equal(h.epochs.active, null, 'settle closed the epoch')

const replay = await decide(h.host, worldState(2), offer, 'heartbeat', 'chain-2')
assert.equal(h.calls.length, 1, 'a settled mechanical step must NOT buy a provider call')
assert.equal(h.boundaryReasons[1], 'same_semantic_state')
assert.equal(replay.answers.action!.value, 'MINE:b10_20_30', 'replay preserves the semantic choice')
const epoch2 = h.epochs.active as DecisionEpoch | null
if (epoch2 === null) throw new Error('replay did not open a fresh epoch')
assert.equal(epoch2.cacheHit, true)
assert.equal(epoch2.reusedFrom, epoch1?.epoch ?? -1, 'replay is attributed to the ANSWERED epoch')

// --- 3. outcome-memory churn cannot reopen WHICH. ---
withProjection(h.host, {
  previous: {
    selectedCandidateId: 'MINE:b10_20_30',
    selectedIdentity: 'opt=option:collect_obsidian#1|skill=MINE|target=block:obsidian@10,20,30|item=obsidian',
    skillKind: 'MINE',
    targetKey: 'obsidian',
    commitmentId: 'a1:MINE:b10_20_30',
    terminalReason: 'done',
    failureCode: null,
    progressKind: 'mechanical',
  },
  meaningfulDelta: [{ fact: 'block.removed', from: null, to: 'obsidian' }],
})
const churned = await decide(h.host, worldState(3), offer, 'heartbeat', 'chain-3')
assert.equal(h.calls.length, 1, 'outcome-memory churn is not a boundary')
assert.equal(h.boundaryReasons[2], 'same_semantic_state')
assert.equal(churned.answers.action!.value, 'MINE:b10_20_30')

// --- 4. a genuine candidate-identity change re-queries. ---
const PILLAR = candidate({
  id: 'MOVE:p10_21_30',
  kind: 'MOVE',
  label: 'pillar up to reach the ledge',
  target: { x: 10, y: 21, z: 30 },
  meta: { approachLeg: 'pillar_recovery', approachTarget: '10,21,30' },
})
const changedOffer = [MINE, PILLAR, WAIT]
const requery = await decide(h.host, worldState(4), changedOffer, 'heartbeat', 'chain-4')
assert.equal(h.calls.length, 2, 'a new semantic alternative must re-query')
assert.equal(h.boundaryReasons[3], 'candidate_set_changed')
assert.equal(h.calls[1]!.decisionReason, 'candidate_set_changed')

// --- 5. a mandatory outcome re-queries even when the projection looks similar. ---
emitSkillOutcomePacket(h.host, {
  actionId: 'MINE:b10_20_30',
  kind: 'MINE',
  leaseEpoch: null,
  status: 'failed',
  failure: 'target_gone',
  verified: false,
  progressed: false,
  itemsGained: 0,
  blockRemoved: false,
  entityDefeated: false,
  targetName: 'obsidian',
  candidate: MINE,
  verification: 'block_absent',
})
assert.equal(h.host.skillOutcomeBoundary, true, 'target_lost is a mandatory boundary')
await decide(h.host, worldState(5), changedOffer, 'path_no_path', 'chain-5')
assert.equal(h.calls.length, 3, 'a mandatory outcome must re-query')
assert.equal(h.boundaryReasons[4], 'skill_outcome_boundary')
assert.equal(h.calls[2]!.decisionReason, 'skill_outcome_boundary')

// --- 6. progress BANDS are boundaries; same-band churn is not. ---
emitSkillOutcomePacket(h.host, {
  actionId: 'MINE:b10_20_30',
  kind: 'MINE',
  leaseEpoch: null,
  status: 'done',
  failure: null,
  verified: true,
  progressed: true,
  itemsGained: 1,
  blockRemoved: true,
  entityDefeated: false,
  targetName: 'obsidian',
  candidate: MINE,
  verification: 'obsidian_removed',
})
withProjection(h.host, {
  progress: {
    consecutiveFailures: 1,
    lastFailureCode: 'path_timeout',
    escalationRecommended: false,
    oscillationsDetected: 0,
    stall: null,
  },
})
await decide(h.host, worldState(6), changedOffer, 'action_completed', 'chain-6')
assert.equal(h.calls.length, 4, 'none -> some is a real progress boundary')
assert.equal(h.boundaryReasons[5], 'progress_boundary')

withProjection(h.host, {
  progress: {
    consecutiveFailures: 2,
    lastFailureCode: 'path_timeout',
    escalationRecommended: false,
    oscillationsDetected: 0,
    stall: null,
  },
})
await decide(h.host, worldState(7), changedOffer, 'action_completed', 'chain-7')
assert.equal(h.calls.length, 4, 'same-band retry churn is not a boundary')
assert.equal(h.boundaryReasons[6], 'same_semantic_state')

// --- 7. a stale-dropped result never becomes the replay anchor. ---
const anchorBefore = h.host.lastAnsweredProjection
const acceptedBefore = h.host.lastDecision
const NEW_MINE = candidate({ id: 'MINE:b40_20_30', kind: 'MINE', label: 'mine obsidian', targetName: 'obsidian', target: { x: 40, y: 20, z: 30 } })
h.dropNextResult = true
await decide(h.host, worldState(8), [MINE, NEW_MINE, PILLAR, WAIT], 'heartbeat', 'chain-8')
assert.equal(h.calls.length, 5, 'the changed set did spend a provider call')
assert.equal(h.host.staleDecisionDropped, true, 'the invalidated-epoch result is dropped')
assert.equal(h.host.lastDecision, acceptedBefore, 'the dropped result is NOT the replay source')
assert.equal(h.host.lastAnsweredProjection, anchorBefore, 'the dropped projection is NOT the boundary anchor')

// The unchanged anchor-shaped situation still replays the ACCEPTED answer.
withProjection(h.host, {
  progress: {
    consecutiveFailures: 2,
    lastFailureCode: 'path_timeout',
    escalationRecommended: false,
    oscillationsDetected: 0,
    stall: null,
  },
})
const stillReplay = await decide(h.host, worldState(9), changedOffer, 'heartbeat', 'chain-9')
assert.equal(h.calls.length, 5, 'after the drop the signature-vs-anchor decides replay eligibility')
assert.equal(h.boundaryReasons[7], 'candidate_set_changed', 'the dropped call itself classified a real boundary')
assert.equal(h.boundaryReasons[8], 'same_semantic_state')
assert.equal(stillReplay.callId, acceptedBefore?.callId, 'only the accepted answer replays')

// --- 8. world/lease invalidation drops the stale replay source. ---
h.host.options.worldEpoch = 8
withProjection(h.host, {
  world: { dimension: OVERWORLD, worldEpoch: 8, generationId: 'gen-test', leaseHeld: true, alive: true },
  progress: {
    consecutiveFailures: 2,
    lastFailureCode: 'path_timeout',
    escalationRecommended: false,
    oscillationsDetected: 0,
    stall: null,
  },
})
await decide(h.host, worldState(10), changedOffer, 'heartbeat', 'chain-10')
assert.equal(h.calls.length, 6, 'a world-epoch change re-queries')
assert.equal(h.boundaryReasons[9], 'world_or_lease_changed')

// --- 9. a deterministic guard rejection feeds the cross-action repeat bound. ---
//
// The measured wedge (p24 live): `MOVE:p40_-61_-2`, a `verticalRecovery`
// open_shaft_step whose landing sits below the world floor, was the ONLY
// grounded offer and the guard refused it `NO_SUPPORT` 757x in ~7min. The
// outcome packet crossed the boundary every time, but the repeat ledger only
// ever saw EXECUTOR settles, so the (MOVE:p*, cell) streak stayed blind:
// `blacklisted=0`, zero ACTION_REPEAT, the identical candidate re-offered
// forever. `onGuardReject` now charges the mechanical-invalidity codes
// (`guardRejectionChargesOption`: NO_PATH/NO_SUPPORT/LAVA_RISK) into the same
// ledger an executed failure feeds, so the identical (shape, cell) retires at
// the bound and leaves the offer.

function rejectionHarness(): { host: DecisionEpochsHost; ledger: RepeatedOutcomeEscalation } {
  const ledger = new RepeatedOutcomeEscalation({ limit: REPEATED_OUTCOME_LIMIT_DEFAULT })
  const ledgersHost = {
    currentDimension: () => OVERWORLD,
    bot: { entity: { position: { x: 40, y: -60, z: -2 } } },
    groundingFingerprints: new Map<string, string>(),
    queue: { current: { id: 'g1:collect:log' } },
    options: { worldEpoch: 1 },
    repeatedOutcomes: ledger,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    tickCounter: 1,
    notifyRepeatedOutcomes: () => {},
  } as unknown as OutcomeLedgersHost
  const g = harness()
  Object.assign(g.host, {
    noteCandidateFailure: () => {},
    recordMoveFailure: () => {},
    logSmeltStationRetry: () => {},
    chargeGuardRejection: () => {},
    recordFailure: () => {},
    // The same one-line delegate the production controller implements.
    noteRejectedOutcome: (result: RepeatedOutcomeResult, candidate: Candidate) =>
      noteRepeatedOutcome(ledgersHost, result, candidate, false, []),
    emitSkillOutcomePacket: () => ({}) as never,
  })
  return { host: g.host, ledger }
}

const VOID_STEP = candidate({
  id: 'MOVE:p40_-61_-2',
  kind: 'MOVE',
  label: 'step down into the opening the world already has',
  target: { x: 40, y: -61, z: -2 },
  meta: { verticalRecovery: 'open_shaft_step', shaftSource: 'sensed_open_floor' },
})
const rejectionRecord = {
  chainId: 'chain-g9',
  optionId: 'collect:log',
  goalQueueState: { current: { id: 'g1:collect:log' } },
  jev: { answers: {} },
  calibration: [],
} as unknown as DecisionRecord
const rejectionResult = { policy: 'typesafe', callId: 'c-g9' } as unknown as JevResult

const g9 = rejectionHarness()
const voidGuarded: Extract<GuardResult, { ok: false }> = {
  ok: false,
  candidateId: VOID_STEP.id,
  code: 'NO_SUPPORT',
  reason: '(40,-61,-2) is below the world floor (void)',
}
for (let attempt = 0; attempt < REPEATED_OUTCOME_LIMIT_DEFAULT; attempt += 1) {
  onGuardReject(g9.host, voidGuarded, rejectionResult, rejectionRecord, VOID_STEP)
}
assert.equal(
  g9.ledger.isRetired('MOVE:p*', 'minecraft:overworld:40,-61,-2'),
  true,
  'identical mechanical-invalidity refusals retire the (shape, cell) at the bound',
)
const filtered9 = filterRetiredRepeats([VOID_STEP, WAIT], g9.ledger, OVERWORLD, { x: 40, y: -60, z: -2 })
assert.equal(filtered9.kept.length, 1)
assert.equal(
  filtered9.kept[0]!.id,
  'WAIT',
  'the void step leaves the offer; the emptied envelope is the starvation evidence local_recovery owns',
)

// A code the codebase classifies as environmental/transient (TARGET_GONE)
// never reaches the bound.
const g9b = rejectionHarness()
const goneGuarded: Extract<GuardResult, { ok: false }> = {
  ok: false,
  candidateId: VOID_STEP.id,
  code: 'TARGET_GONE',
  reason: 'the target is gone',
}
for (let attempt = 0; attempt < REPEATED_OUTCOME_LIMIT_DEFAULT * 2; attempt += 1) {
  onGuardReject(g9b.host, goneGuarded, rejectionResult, rejectionRecord, VOID_STEP)
}
assert.equal(
  g9b.ledger.isRetired('MOVE:p*', 'minecraft:overworld:40,-61,-2'),
  false,
  'environmental/transient refusals keep their own machinery, never the repeat bound',
)
assert.equal(g9b.ledger.countFor('MOVE:p*', 'minecraft:overworld:40,-61,-2'), 0)

process.stdout.write('decision-epochs (§18 Gate C): PASS\n')
