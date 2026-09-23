import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Bot } from 'mineflayer'
import type { GoalQueueSnapshot } from '../jev-agent/src/goalQueue.ts'
import type { System2BlockerFacts, System2PlanRequest } from '../jev-agent/src/system2.ts'
import { emptyWorldMemory } from './resident-types.ts'
import {
  buildMercurySummary,
  dominatedGoalReasonForPlannerMode,
  evaluateSystem2LedgerRestoreBasis,
  selectSystem2LedgerSnapshot,
  SYSTEM2_MISSION_PLAN_IDENTITY,
} from './generation-entry.ts'
import { MercurySystem2, MUSE_SPARK_MODEL, SYSTEM2_HUMAN_MISSION, SYSTEM_PROMPT } from './mercury-system2.ts'
import { PlannerBrain } from './planner.ts'

const bot = {
  inventory: { items: () => [] },
  entity: { position: { x: 26, y: 64, z: 9 } },
  game: { dimension: 'minecraft:overworld' },
  health: 20,
  food: 20,
  registry: { blocksByName: {} },
  findBlocks: () => [],
} as unknown as Bot
const world = emptyWorldMemory()
world.portalVerified = true
world.knownPortalSites.push({
  x: 26,
  y: 67,
  z: 9,
  widthAxis: 'x',
  dimension: 'minecraft:overworld',
  worldEpoch: 1,
  lastVerifiedAt: Date.now(),
})

const blockers: System2BlockerFacts = {
  blockedBy: 'no_productive_action',
  missing: ['open_path'],
  withheld: [],
  tools: { held: [], unmet: [] },
  alternatives: {
    presented: [
      { candidate: 'ENTER:26,67,9', kind: 'ENTER_PORTAL' },
      { candidate: 'WAIT', kind: 'WAIT' },
    ],
  },
}
const request: System2PlanRequest = {
  reason: 'queue_empty',
  detail: 'The live observer found an open route to a verified portal.',
  tick: 7,
  goalQueueState: { depth: 0, current: null, empty: true, hasImpossible: false, done: 0, goals: [] },
  objective: { targetItem: 'iron_ingot', requiredCount: 3, haveCount: 0, complete: false },
  recentEvents: [],
  recentOutcomes: [],
  blockers,
}

let systemInput = ''
let userInput = ''
const dir = mkdtempSync(join(tmpdir(), 'system2-benchmark-independent-'))
const logs: Array<{ event: string; detail: Record<string, unknown> }> = []
const mercury = new MercurySystem2({
  model: MUSE_SPARK_MODEL,
  summarize: (liveRequest, trigger) => buildMercurySummary(bot, world, liveRequest, trigger),
  log: (event, detail) => logs.push({ event, detail: detail ?? {} }),
  callsPath: join(dir, 'mercury-calls.jsonl'),
  cachePath: join(dir, 'mercury-cache.json'),
  resolveKey: () => ({ key: 'fixture-only', origin: 'fixture' }),
  transport: async ({ system, prompt }) => {
    systemInput = system
    userInput = prompt
    return {
      toolCalls: [{ input: { op: 'patch', goals: [{ kind: 'enter_portal' }], reason: 'The live verified portal is reachable and advances the mission.' } }],
      usage: { inputTokens: 1, outputTokens: 1 },
    }
  },
})
const planner = new PlannerBrain({
  bot,
  world,
  log: (event, detail) => logs.push({ event, detail: detail ?? {} }),
  cachePath: join(dir, 'planner-cache.json'),
  mode: 'llm',
  mercury,
  maxAttempts: 1,
  resolveKey: () => null,
})

const plan = await planner.plan(request)
const projected = JSON.parse(userInput) as Record<string, unknown>
const projectedAlternatives = projected.alternatives as { presented: Array<{ candidate: string; kind: string }> }
const projectedPortal = projected.portal as { verified: boolean; knownSites: number }
const projectedAllowed = projected.allowedGoals as Record<string, string[] | undefined>

assert.equal(planner.provider, 'muse-spark')
assert.equal(plan.goals[0]?.targetItem, 'nether_portal', 'the executable factual choice survives validation and compilation')
assert.equal(projected.humanMission, SYSTEM2_HUMAN_MISSION)
assert.equal(projected.objective, null, 'an empty queue must not leak the legacy iron_ingot root objective into WHAT')
assert.equal(projected.dimension, 'minecraft:overworld')
assert.equal(projected.food, 20)
assert.equal(projected.starvation, null)
assert.deepEqual(projectedPortal, { verified: true, knownSites: 1 })
assert.deepEqual(projectedAlternatives.presented, blockers.alternatives.presented)
assert.ok(projectedAllowed.collect?.includes('obsidian'), 'the model receives grounded executable capability facts')
assert.ok(!Object.hasOwn(projected, 'rung'))
assert.ok(!Object.hasOwn(projected, 'rungIndex'))
assert.equal(systemInput, SYSTEM_PROMPT)
assert.match(systemInput, /Human mission: Defeat the Ender Dragon/)
assert.match(systemInput, /does not prescribe a fixed subgoal order/)
assert.match(systemInput, /objective is the active item-counted queue goal, or null when there is none/)
assert.doesNotMatch(systemInput, /enter_nether|rungIndex|RUNGS|M2|M3/i)
assert.doesNotMatch(systemInput, /blaze_rod[\s\S]*ender_pearl[\s\S]*ender_eye/i)
assert.doesNotMatch(userInput, /"rung(Index)?"\s*:/i)
assert.equal(logs.some(({ event }) => event === 'SYSTEM2_AUTHORITY_DECISION'), true)

const activeNonMissionRequest: System2PlanRequest = {
  ...request,
  reason: 'need_llm',
  goalQueueState: {
    ...request.goalQueueState,
    depth: 1,
    empty: false,
    current: {
      id: 'g1:collect:oak_log',
      kind: 'collect',
      description: 'collect 4 x oak_log',
      targetItem: 'oak_log',
      requiredCount: 4,
      startCount: 0,
      haveCount: 2,
      status: 'active',
      origin: 'llm',
      createdAt: 1,
      updatedAt: 2,
      detail: null,
    },
  },
  // A configured compatibility objective is not the active local WHAT.
  objective: { targetItem: 'iron_ingot', requiredCount: 3, haveCount: 0, complete: false },
}
assert.deepEqual(
  buildMercurySummary(bot, world, activeNonMissionRequest, 'no_progress').objective,
  { targetItem: 'oak_log', requiredCount: 4, haveCount: 2, complete: false },
  'a non-M3 active queue objective must be projected from the queue, not the compatibility root goal',
)

const modelLedger: GoalQueueSnapshot = {
  counter: 1,
  goals: [],
  basis: { worldKey: 'server|minecraft:overworld|1', frontierRungId: 'blaze_rods', frontierRungIndex: 15 },
  planIdentity: { ...SYSTEM2_MISSION_PLAN_IDENTITY },
}
const changedFrontier = {
  worldKey: 'server|minecraft:overworld|1',
  frontierRungId: 'wood',
  frontierRungIndex: 0,
}
assert.deepEqual(evaluateSystem2LedgerRestoreBasis(modelLedger, changedFrontier), { accept: true, reasons: [] })
assert.equal(
  selectSystem2LedgerSnapshot(modelLedger, null, {}, world)?.source,
  'host-snapshot',
  'same-world model intent restores independently of benchmark frontier changes',
)
const legacyRungLedger: GoalQueueSnapshot = {
  ...modelLedger,
  planIdentity: { rungId: 'enter_nether', rungIndex: 14, objectiveItem: 'obsidian', objectiveCount: 10 },
}
assert.deepEqual(evaluateSystem2LedgerRestoreBasis(legacyRungLedger, changedFrontier), {
  accept: false,
  reasons: ['mission_identity_mismatch'],
})
assert.equal(
  selectSystem2LedgerSnapshot(legacyRungLedger, null, {}, world),
  null,
  'a legacy rung-authored queue cannot acquire System2 mission identity during restore',
)
const diamondInventory = {
  diamond: 3,
  diamond_pickaxe: 1,
  flint_and_steel: 1,
  iron_ingot: 2,
  cobblestone: 22,
  charcoal: 1,
  furnace: 1,
  crafting_table: 1,
  stick: 4,
}
const ironSmeltGoal = { kind: 'smelt' as const, targetItem: 'iron_ingot', requiredCount: 3 }
assert.equal(
  dominatedGoalReasonForPlannerMode('llm', ironSmeltGoal, diamondInventory, emptyWorldMemory()),
  null,
  'model-authored WHAT is never retired using RUNGS consumer/producers',
)
assert.equal(
  dominatedGoalReasonForPlannerMode('deterministic', ironSmeltGoal, diamondInventory, emptyWorldMemory())?.reason,
  'producer_rung_satisfied',
  'the explicit deterministic baseline retains its legacy rung reconciliation',
)
assert.deepEqual(
  evaluateSystem2LedgerRestoreBasis(modelLedger, { ...changedFrontier, worldKey: 'another-world' }),
  { accept: false, reasons: ['world_key_changed'] },
)

console.log('system2-benchmark-independent: PASS (mission plus live alternatives; no rung menu or ordering prescription)')
