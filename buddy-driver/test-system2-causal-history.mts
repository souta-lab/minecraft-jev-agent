import assert from 'node:assert/strict'
import type { Bot } from 'mineflayer'
import type { System2PlanRequest, System2SemanticOutcome } from '../jev-agent/src/system2/service.ts'
import { SYSTEM2_SEMANTIC_HISTORY_LIMIT } from '../jev-agent/src/system2/causal-history.ts'
import { buildMercurySummary } from './generation-entry.ts'
import { hashMercuryState } from './mercury-system2.ts'
import { emptyWorldMemory } from './resident-types.ts'

const bot = {
  inventory: { items: () => [] },
  entity: { position: { x: 4, y: 70, z: 3 } },
  game: { dimension: 'minecraft:overworld' },
  health: 20,
} as unknown as Bot

const record = (proposalId: string, after: string): System2SemanticOutcome => ({
  proposalId,
  semanticIntentKey: 'explore-surface-key',
  operation: 'replace',
  intentSource: 'intent',
  intent: 'Explore the surface for a route.',
  acceptedGoals: [{
    goalId: `goal-${proposalId}`,
    optionId: 'explore_surface',
    optionInstanceId: `explore_surface#${proposalId}`,
    description: 'explore the surface',
  }],
  acceptedGoalsTotal: 1,
  requestedGoalsTotal: 1,
  optionInstanceBefore: null,
  queueDoneBefore: 0,
  stateFingerprintBefore: 'world-same',
  blockerBefore: null,
  progress: { body: false, search: false, goal: false, option: false },
  stateFingerprintAfter: after,
  blockerAfter: {
    blockedBy: 'no_productive_action',
    missing: ['headroom@4,70,3'],
    withheld: [{
      candidate: 'MOVE:4,70,3',
      kind: 'MOVE',
      reason: 'no_standable_approach',
      missing: ['headroom@4,70,3'],
    }],
    offered: [],
    toolsUnmet: [],
    truncated: false,
  },
  outcome: 'blocked',
})

const records = Array.from({ length: SYSTEM2_SEMANTIC_HISTORY_LIMIT + 2 }, (_, index) =>
  record(`proposal-${index}`, 'world-same'),
)
const request: System2PlanRequest = {
  reason: 'no_progress',
  detail: 'candidate starvation',
  tick: 50,
  goalQueueState: { depth: 0, current: null, empty: true, hasImpossible: false, done: 0, goals: [] },
  objective: { targetItem: 'flint_and_steel', requiredCount: 1, haveCount: 0, complete: false },
  recentEvents: [],
  recentOutcomes: [{
    actionId: 'ESCALATE',
    status: 'done',
    failure: null,
    verified: true,
    detail: 'system2 requested',
  }],
  recentSemanticOutcomes: records,
}

const summary = buildMercurySummary(bot, emptyWorldMemory(), request, 'no_candidate')
assert.equal(summary.recentSemanticOutcomes?.length, SYSTEM2_SEMANTIC_HISTORY_LIMIT)
assert.equal(summary.recentSemanticOutcomes?.at(-1)?.proposalId, 'proposal-5')
assert.equal(summary.recentSemanticOutcomes?.at(-1)?.outcome, 'blocked')

const withoutHistory = { ...summary, recentSemanticOutcomes: undefined }
assert.notEqual(
  hashMercuryState(summary),
  hashMercuryState(withoutHistory),
  'WHAT outcome history participates in the cache key so a new result is not hidden by replay',
)
const changedOutcome = {
  ...summary,
  recentSemanticOutcomes: summary.recentSemanticOutcomes?.map((entry, index) =>
    index === 3 ? { ...entry, outcome: 'unknown' as const, stateFingerprintAfter: 'world-changed' } : entry,
  ),
}
assert.notEqual(hashMercuryState(summary), hashMercuryState(changedOutcome))

console.log('system2 causal history projection/cache identity: PASS')
