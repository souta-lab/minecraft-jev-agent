import assert from 'node:assert/strict'
import {
  acceptedSystem2PlanGoals,
  createSystem2SemanticOutcome,
  finalizeSystem2SemanticOutcomes,
  recordSystem2SemanticAction,
  system2SemanticBlocker,
  system2SemanticFingerprint,
} from './src/system2/causal-history.ts'
import { compilePlannedGoal, makeOptionSnapshot } from './src/optionSpec.ts'
import type { QueuedGoal, PlanOp } from './src/goalQueue.ts'
import type { OptionWorldSnapshot } from './src/optionSpec.ts'
import type { System2BlockerFacts } from './src/system2/service.ts'

const goal = (id: string, targetItem = 'diamond'): QueuedGoal => {
  const planned = { kind: 'collect' as const, description: `collect ${targetItem}`, targetItem, requiredCount: 1 }
  return {
    id,
    kind: 'collect',
    description: planned.description,
    targetItem,
    requiredCount: 1,
    semanticOptionTemplateId: `collect:${targetItem}`,
    semanticOptionInstanceId: `collect:${targetItem}#1`,
    semanticOptionIntent: planned.description,
    optionSpec: compilePlannedGoal(planned),
    startCount: 0,
    haveCount: 0,
    status: 'pending',
    origin: 'llm',
    createdAt: 1,
    updatedAt: 1,
    detail: null,
  }
}

const snapshot = (inventory: Readonly<Record<string, number>> = {}, health = 20): OptionWorldSnapshot =>
  makeOptionSnapshot({
    inventory,
    dimension: 'minecraft:overworld',
    position: { x: 4, y: 70, z: 3 },
    health,
    toolRank: 0,
    knownStations: [],
    knownOres: [],
  })

const blockerFacts = (overrides: Partial<System2BlockerFacts> = {}): System2BlockerFacts => ({
  blockedBy: 'no_productive_action',
  missing: ['headroom@4,70,3'],
  withheld: [{
    candidate: 'MOVE:4,70,3',
    kind: 'MOVE',
    reason: 'no_standable_approach',
    missing: ['headroom@4,70,3'],
    suppressed: false,
  }],
  tools: { held: [], unmet: [] },
  alternatives: { presented: [] },
  ...overrides,
})

const worldBefore = system2SemanticFingerprint(
  'fp2|epoch=1|pos=4,70,3|inv=diamond=0|stations=|furnaces=|goal=queue-a',
  'minecraft:overworld',
  { health: 20, food: 20, targetItem: 'diamond', requiredCount: 1, haveCount: 0, complete: false },
)
const worldAfter = system2SemanticFingerprint(
  'fp2|epoch=1|pos=4,70,3|inv=diamond=0|stations=|furnaces=|goal=queue-b',
  'minecraft:overworld',
  { health: 20, food: 20, targetItem: 'diamond', requiredCount: 1, haveCount: 0, complete: false },
)
assert.equal(worldBefore, worldAfter, 'queue/Option installation does not count as relevant world change')
assert.notEqual(
  worldBefore,
  system2SemanticFingerprint(
    'fp2|epoch=1|pos=4,70,3|inv=diamond=0|stations=|furnaces=|goal=queue-b',
    'minecraft:overworld',
    { health: 7, food: 20, targetItem: 'diamond', requiredCount: 1, haveCount: 0, complete: false },
  ),
  'a relevant survival state change must alter the semantic state identity',
)

const create = (input: {
  proposalId: string
  operation?: PlanOp
  acceptedGoals?: readonly QueuedGoal[]
  stateFingerprintBefore?: string
  successSnapshot?: OptionWorldSnapshot
}) => createSystem2SemanticOutcome({
  proposalId: input.proposalId,
  operation: input.operation ?? 'replace',
  intentSource: 'intent',
  intent: 'Collect the requested resource.',
  requestedGoalsTotal: input.acceptedGoals?.length ?? 1,
  acceptedGoals: input.acceptedGoals ?? [goal('queue-goal-1')],
  optionInstanceBefore: null,
  queueDoneBefore: 0,
  stateFingerprintBefore: input.stateFingerprintBefore ?? worldBefore,
  blockerBefore: null,
  successSnapshot: input.successSnapshot ?? snapshot(),
})

const initialHistory = [create({ proposalId: 'proposal-1' })]
let history = recordSystem2SemanticAction(initialHistory, 'other-goal', ['body'])
assert.equal(history[0]?.progress.body, false, 'an unrelated Option cannot inherit another goal outcome')
history = recordSystem2SemanticAction(history, 'queue-goal-1', ['body', 'goal', 'search'])
assert.deepEqual(
  history[0]?.progress,
  { body: true, search: false, goal: false, option: false },
  'taxonomy goal/search flags are observations, not proof that WHAT succeeded',
)
history = finalizeSystem2SemanticOutcomes(history, {
  stateFingerprint: worldAfter,
  blocker: system2SemanticBlocker(blockerFacts()),
  snapshot: snapshot(),
})
assert.equal(history[0]?.stateFingerprintAfter, worldBefore)
assert.equal(history[0]?.outcome, 'body_only', 'body movement is not semantic progress')
assert.equal(history[0]?.blockerAfter?.blockedBy, 'no_productive_action')

const noMotion = create({ proposalId: 'proposal-2' })
const blocked = finalizeSystem2SemanticOutcomes([noMotion], {
  stateFingerprint: worldAfter,
  blocker: system2SemanticBlocker(blockerFacts()),
  snapshot: snapshot(),
})[0]
assert.equal(blocked?.outcome, 'blocked', 'complete refusals with missing facts and no alternatives prove blockage')
assert.deepEqual(blocked?.progress, { body: false, search: false, goal: false, option: false })

const alternatives = system2SemanticBlocker(blockerFacts({
  alternatives: { presented: [{ candidate: 'MINE:diamond_ore', kind: 'MINE' }] },
}))
assert.equal(finalizeSystem2SemanticOutcomes([noMotion], {
  stateFingerprint: worldAfter,
  blocker: alternatives,
  snapshot: snapshot(),
})[0]?.outcome, 'unknown', 'offered alternatives prevent a total-blockage claim')
const partial = system2SemanticBlocker(blockerFacts({
  withheld: [{ candidate: 'MOVE:4,70,3', kind: 'MOVE', reason: 'unknown', missing: [], suppressed: false }],
}))
assert.equal(finalizeSystem2SemanticOutcomes([noMotion], {
  stateFingerprint: worldAfter,
  blocker: partial,
  snapshot: snapshot(),
})[0]?.outcome, 'unknown', 'a partial refusal without typed missing facts is not proven blockage')
const truncated = system2SemanticBlocker(blockerFacts({ missing: Array.from({ length: 7 }, (_, i) => `missing-${i}`) }))
assert.equal(finalizeSystem2SemanticOutcomes([noMotion], {
  stateFingerprint: worldAfter,
  blocker: truncated,
  snapshot: snapshot(),
})[0]?.outcome, 'unknown', 'truncated blocker evidence stays conservative')

const changedWorld = system2SemanticFingerprint(
  'fp2|epoch=1|pos=9,70,3|inv=diamond=0|stations=|furnaces=|goal=queue-b',
  'minecraft:overworld',
  { health: 20, food: 20, targetItem: 'diamond', requiredCount: 1, haveCount: 0, complete: false },
)
assert.equal(finalizeSystem2SemanticOutcomes([noMotion], {
  stateFingerprint: changedWorld,
  blocker: system2SemanticBlocker(blockerFacts()),
  snapshot: snapshot(),
})[0]?.outcome, 'unknown', 'a changed world stays distinct from failure/no-progress')
const objectiveOnlyChanged = system2SemanticFingerprint(
  'fp2|epoch=1|pos=4,70,3|inv=diamond=0|stations=|furnaces=|goal=queue-b',
  'minecraft:overworld',
  { health: 20, food: 20, targetItem: 'gold_ingot', requiredCount: 2, haveCount: 0, complete: false },
)
assert.equal(finalizeSystem2SemanticOutcomes([noMotion], {
  stateFingerprint: objectiveOnlyChanged,
  blocker: null,
  snapshot: snapshot(),
})[0]?.outcome, 'unknown', 'an objective-only fingerprint change does not infer no progress')

const manyGoals = Array.from({ length: 8 }, (_, index) => goal(`goal-${index + 1}`, `item_${index + 1}`))
const bounded = create({ proposalId: 'proposal-bounded', operation: 'patch', acceptedGoals: manyGoals })
assert.equal(bounded.acceptedGoals.length, 8)
assert.equal(bounded.acceptedGoals.at(-1)?.goalId, 'goal-8', 'the full supported plan bound remains attributable')
assert.equal(bounded.acceptedGoalsTotal, 8)
assert.equal(bounded.requestedGoalsTotal, 8)
for (const rowIndex of [6, 7]) {
  const acceptedRow = bounded.acceptedGoals[rowIndex]
  assert.equal(acceptedRow?.goalId, `goal-${rowIndex + 1}`)
  const result = finalizeSystem2SemanticOutcomes([bounded], {
    stateFingerprint: worldAfter,
    blocker: null,
    snapshot: snapshot({ [`item_${rowIndex + 1}`]: 1 }),
  })[0]
  assert.equal(result?.outcome, 'semantic_progress', `row ${rowIndex + 1} completion uses its typed success predicate`)
  assert.equal(result?.progress.goal, true)
}

const unrelatedGain = create({ proposalId: 'proposal-unrelated-action' })
const unrelatedResult = finalizeSystem2SemanticOutcomes(
  recordSystem2SemanticAction([unrelatedGain], 'queue-goal-1', ['goal', 'search']),
  {
    stateFingerprint: system2SemanticFingerprint(
      'fp2|epoch=1|pos=4,70,3|inv=oak_log=4,diamond=0|stations=|furnaces=|goal=queue-a',
      'minecraft:overworld',
      { health: 20, food: 20, targetItem: 'diamond', requiredCount: 1, haveCount: 0, complete: false },
    ),
    blocker: null,
    snapshot: snapshot({ oak_log: 4 }),
  },
)[0]
assert.equal(unrelatedResult?.progress.goal, false, 'MINE/ATTACK taxonomy cannot complete a different WHAT')
assert.equal(unrelatedResult?.progress.option, false)
assert.equal(unrelatedResult?.outcome, 'unknown', 'unrelated resource gains leave semantic attribution unknown')

const objectiveChange = create({ proposalId: 'proposal-objective-change' })
const objectiveChangeResult = finalizeSystem2SemanticOutcomes([objectiveChange], {
  stateFingerprint: objectiveOnlyChanged,
  blocker: null,
  snapshot: snapshot(),
})[0]
assert.equal(objectiveChangeResult?.outcome, 'unknown')

const customGoal = goal('custom-goal')
const customSpec = customGoal.optionSpec
assert.notEqual(customSpec, undefined)
customGoal.optionSpec = { ...customSpec!, success: [{ kind: 'custom', id: 'done:custom' }] }
const customOutcome = create({ proposalId: 'proposal-custom', acceptedGoals: [customGoal] })
assert.equal(customOutcome.acceptedGoals[0]?.successTruthBefore, 'unknown')
assert.equal(finalizeSystem2SemanticOutcomes([customOutcome], {
  stateFingerprint: changedWorld,
  blocker: null,
  snapshot: snapshot({ diamond: 1 }),
})[0]?.outcome, 'unknown', 'unregistered custom postconditions never become inferred semantic proof')

const active = goal('active-head')
const newTail = goal('new-tail', 'iron_ingot')
const retained = acceptedSystem2PlanGoals({
  operation: 'patch',
  added: [newTail],
  currentBefore: active,
  currentAfter: { ...active, status: 'active' },
  applied: true,
})
assert.deepEqual(retained.map((entry) => entry.id), ['active-head', 'new-tail'])
assert.deepEqual(acceptedSystem2PlanGoals({
  operation: 'continue',
  added: [],
  currentBefore: active,
  currentAfter: active,
  applied: true,
}).map((entry) => entry.id), ['active-head'])
assert.deepEqual(acceptedSystem2PlanGoals({
  operation: 'patch',
  added: [],
  currentBefore: active,
  currentAfter: active,
  applied: false,
}), [], 'a rejected operation cannot claim the unchanged current head')
assert.deepEqual(acceptedSystem2PlanGoals({
  operation: 'replace',
  added: [newTail],
  currentBefore: active,
  currentAfter: newTail,
  applied: true,
}).map((entry) => entry.id), ['new-tail'], 'replace does not retain the old semantic head')

assert.equal(initialHistory.length, 1, 'history remains bounded by semantic events')
console.log('system2 semantic history causal contract: PASS')
