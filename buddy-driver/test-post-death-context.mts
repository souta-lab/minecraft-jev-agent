import assert from 'node:assert/strict'
import type { Bot } from 'mineflayer'
import { generateCandidates, defaultCandidateOptions } from '../jev-agent/src/candidates.ts'
import { GoalQueue } from '../jev-agent/src/goalQueue.ts'
import { makeGoal } from '../jev-agent/src/state.ts'
import type { AgentSignals, WorldState } from '../jev-agent/src/state.ts'
import type { System2PlanRequest } from '../jev-agent/src/system2.ts'
import { buildMercurySummary } from './generation-entry.ts'
import {
  hashMercuryState,
  plannedGoalsFromMercury,
  validateMercuryPlan,
  validateMercuryPlanAgainstState,
} from './mercury-system2.ts'
import { emptyWorldMemory } from './resident-types.ts'
import type { DeathRecoveryContext } from './resident-types.ts'

const bot = {
  inventory: { items: () => [] },
  entity: { position: { x: 4.2, y: 72, z: -1.8 } },
  game: { dimension: 'minecraft:overworld' },
  health: 20,
} as unknown as Bot

const world = emptyWorldMemory()
world.hazards.push({
  x: 12,
  y: 68,
  z: -2,
  reason: 'damage',
  count: 3,
  firstSeenAt: 1,
  lastSeenAt: 3,
  source: 'production',
})

const request: System2PlanRequest = {
  reason: 'queue_empty',
  detail: 'first plan after respawn',
  tick: 1,
  goalQueueState: { depth: 0, current: null, empty: true, hasImpossible: false, done: 0, goals: [] },
  objective: { targetItem: 'log', requiredCount: 1, haveCount: 0, complete: false },
  recentEvents: [],
  recentOutcomes: [],
}

const deathRecovery: DeathRecoveryContext = {
  occurredAt: 10_000,
  position: { x: 12.4, y: 68, z: -2.4 },
  dimension: 'minecraft:overworld',
  cause: 'damage',
  lostInventory: { iron_pickaxe: 1, diamond: 2, oak_log: 16 },
  itemsLost: 19,
  nearbyHostiles: [
    { name: 'zombie', distance: 2.4 },
    { name: 'skeleton', distance: 6.1 },
  ],
  recentDeathCount: 4,
  recentDeathWindowMs: 120_000,
}

const portalWorld = emptyWorldMemory()
portalWorld.portalVerified = true
portalWorld.knownPortalSites.push({
  x: 25,
  y: 66,
  z: 9,
  widthAxis: 'x',
  dimension: 'minecraft:overworld',
  worldEpoch: 1,
  lastVerifiedAt: 9_000,
})
const portalSummary = buildMercurySummary(bot, portalWorld, request, 'no_candidate')
assert.deepEqual(portalSummary.portal, { verified: true, knownSites: 1 })
assert.notEqual(
  hashMercuryState(portalSummary),
  hashMercuryState({ ...portalSummary, portal: { verified: false, knownSites: 1 } }),
  'live portal truth must participate in the System2 cache key',
)

const postDeath = buildMercurySummary(bot, world, request, 'post_death', deathRecovery)
assert.deepEqual(postDeath.postDeath, {
  latestDeathPoint: { x: 12, y: 68, z: -2 },
  dimension: 'minecraft:overworld',
  cause: 'damage',
  lostInventory: { iron_pickaxe: 1, diamond: 2, oak_log: 16 },
  itemsLost: 19,
  nearbyHostiles: [
    { name: 'zombie', distance: 2.4 },
    { name: 'skeleton', distance: 6.1 },
  ],
  recentDeathCount: 4,
  recentDeathWindowSec: 120,
  recoveryChoices: ['recover_death_site', 'rebuild_equipment', 'leave_danger_area'],
})
assert.equal(postDeath.deathHistory[0], 'damage@12,68,-2x3')

const ordinary = buildMercurySummary(bot, world, request, 'no_progress', deathRecovery)
assert.equal(ordinary.postDeath, null, 'death-only context must not inflate ordinary Mercury calls')

const saferDeath = buildMercurySummary(bot, world, request, 'post_death', {
  ...deathRecovery,
  nearbyHostiles: [],
  recentDeathCount: 1,
})
assert.notEqual(
  hashMercuryState(postDeath),
  hashMercuryState(saferDeath),
  'post-death risk facts must participate in the Mercury cache key',
)

const recoveryPlan = validateMercuryPlan({
  op: 'replace',
  goals: [{ kind: 'recover_death_site' }],
  reason: 'valuable loss and low enough recovery risk',
})
if (!recoveryPlan.ok) throw new Error(recoveryPlan.error)
assert.ok(recoveryPlan.ok)
assert.equal(validateMercuryPlanAgainstState(recoveryPlan.plan, postDeath), null)
const recoveryGoal = plannedGoalsFromMercury(recoveryPlan.plan, postDeath)[0]
assert.equal(recoveryGoal?.kind, 'goto')
assert.deepEqual(recoveryGoal?.targetPosition, { x: 12, y: 68, z: -2 })
assert.equal(recoveryGoal?.dimension, 'minecraft:overworld')
assert.equal(recoveryGoal?.optionSpec?.kind, 'goto')

const wrongDimension = {
  ...postDeath,
  postDeath: postDeath.postDeath === null || postDeath.postDeath === undefined
    ? postDeath.postDeath
    : { ...postDeath.postDeath, dimension: 'minecraft:the_nether' },
}
assert.match(
  validateMercuryPlanAgainstState(recoveryPlan.plan, wrongDimension) ?? '',
  /death dimension .* != live/,
  'death-site recovery must fail closed across dimensions',
)

const queue = new GoalQueue()
queue.applyPlan([recoveryGoal!], 'llm')
const signals: AgentSignals = {
  consecutiveFailures: 0,
  lastFailureCode: null,
  lastPathStatus: 'idle',
  stalledMs: 0,
  lastPolicyConfidence: null,
  maxConcurrentActions: 1,
  escalationRecommended: false,
  failedCandidates: {},
}
const recoveryState: WorldState = {
  schemaVersion: 1,
  tick: 1,
  timestampMs: Date.now(),
  self: {
    username: 'AI_Buddy',
    position: { x: 0, y: 68, z: 0 },
    eyePosition: { x: 0, y: 69.62, z: 0 },
    yaw: 0,
    pitch: 0,
    onGround: true,
    health: 20,
    food: 20,
    gameMode: 'survival',
    dimension: 'minecraft:overworld',
    isDay: true,
    heldItem: null,
  },
  inventory: { slots: [], counts: {}, totalItems: 0 },
  entities: [],
  blocks: [],
  terrain: { standable: [] },
  craftingTables: [],
  furnaces: [],
  placementSpots: [],
  descent: [],
  stepCuts: [],
  headroomCuts: [],
  goal: makeGoal('log', 1),
  goalQueue: queue.state,
  recentEvents: [],
  signals,
}
const goto = generateCandidates(recoveryState, defaultCandidateOptions).find((candidate) => candidate.id.startsWith('GOTO:'))
assert.deepEqual(goto?.target, { x: 12, y: 68, z: -2 })
assert.equal(goto?.meta.groundedGoto, true)

console.log('post-death-context: PASS (risk facts + host-grounded death-site recovery reach Mercury and MOVE)')
