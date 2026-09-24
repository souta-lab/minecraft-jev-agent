import assert from 'node:assert/strict'
import { createSystem2SemanticOutcome, finalizeSystem2SemanticOutcomes, recordSystem2SemanticAction, system2SemanticBlocker, system2SemanticFingerprint } from './src/system2CausalHistory.ts'
import type { QueuedGoal } from './src/goalQueue.ts'
import type { System2BlockerFacts } from './src/system2.ts'

const goal = (id: string): QueuedGoal => ({
  id,
  kind: 'explore',
  description: 'explore the surface for a route',
  targetItem: null,
  requiredCount: 1,
  semanticOptionTemplateId: 'explore_surface',
  semanticOptionInstanceId: 'explore_surface#1',
  semanticOptionIntent: 'explore the surface',
  startCount: 0,
  haveCount: 0,
  status: 'pending',
  origin: 'llm',
  createdAt: 1,
  updatedAt: 1,
  detail: null,
})

const blocker: System2BlockerFacts = {
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
}

const worldBefore = system2SemanticFingerprint(
  'fp2|epoch=1|pos=4,70,3|inv=oak_log=2|stations=|furnaces=|goal=queue-a',
  'minecraft:overworld',
  { health: 20, food: 20, targetItem: 'stone', requiredCount: 4, haveCount: 0, complete: false },
)
const worldAfter = system2SemanticFingerprint(
  'fp2|epoch=1|pos=4,70,3|inv=oak_log=2|stations=|furnaces=|goal=queue-b',
  'minecraft:overworld',
  { health: 20, food: 20, targetItem: 'stone', requiredCount: 4, haveCount: 0, complete: false },
)
assert.equal(worldBefore, worldAfter, 'queue/Option installation does not count as relevant world change')
assert.notEqual(
  worldBefore,
  system2SemanticFingerprint(
    'fp2|epoch=1|pos=4,70,3|inv=oak_log=2|stations=|furnaces=|goal=queue-b',
    'minecraft:overworld',
    { health: 7, food: 20, targetItem: 'stone', requiredCount: 4, haveCount: 0, complete: false },
  ),
  'a relevant survival state change must alter the semantic state identity',
)

let history = [createSystem2SemanticOutcome({
  proposalId: 'proposal-1',
  operation: 'replace',
  intentSource: 'intent',
  intent: 'Explore the surface to find a safe route.',
  requestedGoalsTotal: 1,
  acceptedGoals: [goal('queue-goal-1')],
  optionInstanceBefore: null,
  queueDoneBefore: 0,
  stateFingerprintBefore: worldBefore,
  blockerBefore: null,
})]

history = recordSystem2SemanticAction(history, 'other-goal', ['body'], 0)
assert.equal(history[0]?.progress.body, false, 'an unrelated Option cannot inherit another goal outcome')
history = recordSystem2SemanticAction(history, 'queue-goal-1', ['body'], 0)
history = finalizeSystem2SemanticOutcomes(history, {
  stateFingerprint: worldAfter,
  blocker: system2SemanticBlocker(blocker),
})
assert.equal(history[0]?.stateFingerprintAfter, worldBefore)
assert.equal(history[0]?.outcome, 'body_only', 'body movement is not semantic progress')
assert.equal(history[0]?.blockerAfter?.blockedBy, 'no_productive_action')

const noMotionHistory = [createSystem2SemanticOutcome({
  proposalId: 'proposal-2',
  operation: 'replace',
  intentSource: 'intent',
  intent: 'Explore the surface.',
  requestedGoalsTotal: 1,
  acceptedGoals: [goal('queue-goal-2')],
  optionInstanceBefore: null,
  queueDoneBefore: 0,
  stateFingerprintBefore: worldBefore,
  blockerBefore: null,
})]
const blocked = finalizeSystem2SemanticOutcomes(noMotionHistory, {
  stateFingerprint: worldAfter,
  blocker: system2SemanticBlocker(blocker),
})[0]
assert.equal(blocked?.outcome, 'blocked')
assert.deepEqual(blocked?.progress, { body: false, search: false, goal: false, option: false })

const changedWorld = system2SemanticFingerprint(
  'fp2|epoch=1|pos=9,70,3|inv=oak_log=2|stations=|furnaces=|goal=queue-b',
  'minecraft:overworld',
  { health: 20, food: 20, targetItem: 'stone', requiredCount: 4, haveCount: 0, complete: false },
)
const unknown = finalizeSystem2SemanticOutcomes(noMotionHistory, {
  stateFingerprint: changedWorld,
  blocker: system2SemanticBlocker(blocker),
})[0]
assert.equal(unknown?.outcome, 'unknown', 'a changed relevant state stays distinct from failure/no-progress')

const manyGoals = Array.from({ length: 8 }, (_, index) => goal(`goal-${index}`))
const bounded = createSystem2SemanticOutcome({
  proposalId: 'proposal-bounded',
  operation: 'patch',
  intentSource: 'intent',
  intent: 'collect resources',
  requestedGoalsTotal: manyGoals.length,
  acceptedGoals: manyGoals,
  optionInstanceBefore: null,
  queueDoneBefore: 0,
  stateFingerprintBefore: worldBefore,
  blockerBefore: null,
})
assert.equal(bounded.acceptedGoals.length, 6)
assert.equal(bounded.acceptedGoalsTotal, 8)
assert.equal(bounded.requestedGoalsTotal, 8)
assert.equal(history.length, 1, 'history remains bounded by semantic events')

console.log('system2 semantic history causal contract: PASS')
