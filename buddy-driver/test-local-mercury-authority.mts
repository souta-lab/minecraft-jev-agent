import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Bot } from 'mineflayer'
import type { System2PlanRequest } from '../jev-agent/src/system2.ts'
import { MercurySystem2 } from './mercury-system2.ts'
import { PlannerBrain } from './planner.ts'
import { emptyWorldMemory } from './resident-types.ts'

const dir = mkdtempSync(join(tmpdir(), 'local-mercury-authority-'))
const logs: Array<{ event: string; detail: Record<string, unknown> }> = []
const bot = {
  inventory: { items: () => [] },
  entity: { position: { x: 0, y: 61, z: 0 } },
  game: { dimension: 'minecraft:overworld' },
  health: 20,
  food: 20,
  registry: { blocksByName: {} },
  findBlocks: () => [],
} as unknown as Bot

const summarize = (request: System2PlanRequest, trigger: 'wait_limit' | 'no_candidate' | 'no_progress' | 'action_impossible' | 'post_death') => ({
  trigger,
  wakeReason: request.reason,
  wakeDetail: request.detail,
  rung: 'iron_gear',
  rungIndex: 10,
  position: { x: 0, y: 61, z: 0 },
  dimension: 'minecraft:overworld',
  health: 20,
  toolRank: 3,
  inventory: { iron_pickaxe: 1 },
  stations: { craftingTables: 1, furnaces: 1 },
  knownOres: ['raw_iron'],
  recentFailures: [],
  consecutiveWait: trigger === 'wait_limit' ? 3 : 0,
  queue: { depth: request.goalQueueState.depth, done: request.goalQueueState.done, current: null, hasImpossible: false },
  objective: request.objective,
  deathHistory: [],
  allowedGoals: {
    collect: ['raw_iron'],
    craft: ['iron_pickaxe'],
    smelt: ['iron_ingot'],
    place: ['furnace'],
    goto_resources: ['raw_iron'],
    explore_modes: ['cave', 'surface'],
  },
})

let mercuryCalls = 0
const mercury = new MercurySystem2({
  model: 'qwen3.5-9b-local',
  summarize,
  log: (event, detail) => logs.push({ event, detail: detail ?? {} }),
  callsPath: join(dir, 'mercury-calls.jsonl'),
  cachePath: join(dir, 'mercury-cache.json'),
  resolveKey: () => ({ key: 'fixture-only', origin: 'fixture' }),
  transport: async () => {
    mercuryCalls += 1
    return {
      toolCalls: [{ input: { op: 'patch', goals: [{ kind: 'collect', item: 'raw_iron', count: 1 }], reason: 'unstick locally' } }],
      usage: { inputTokens: 1, outputTokens: 1 },
    }
  },
})

let externalPlannerKeyLookups = 0
const planner = new PlannerBrain({
  bot,
  world: emptyWorldMemory(),
  log: (event, detail) => logs.push({ event, detail: detail ?? {} }),
  cachePath: join(dir, 'planner-cache.json'),
  mode: 'local-mercury',
  mercury,
  maxAttempts: 1,
  resolveKey: () => {
    externalPlannerKeyLookups += 1
    return null
  },
})

assert.equal(planner.model, 'qwen3.5-9b-local')
assert.deepEqual(planner.authorityStack, {
  provider: 'local-mercury',
  model: 'deterministic|mercury:qwen3.5-9b-local',
})

const queueEmpty: System2PlanRequest = {
  reason: 'queue_empty',
  detail: 'normal deterministic floor',
  tick: 1,
  goalQueueState: { depth: 0, current: null, empty: true, hasImpossible: false, done: 1, goals: [] },
  objective: { targetItem: 'iron_pickaxe', requiredCount: 1, haveCount: 0, complete: false },
  recentEvents: [],
  recentOutcomes: [],
}
await planner.plan(queueEmpty)
assert.equal(planner.provider, 'deterministic')
assert.equal(planner.authorityModel, 'deterministic-ladder')
assert.equal(mercuryCalls, 0, 'ordinary queue_empty must stay on the deterministic floor')
assert.equal(externalPlannerKeyLookups, 0, 'local-mercury must not touch the TypeSafe planner key')

const stalled: System2PlanRequest = {
  ...queueEmpty,
  reason: 'no_progress',
  detail: 'candidate starvation',
  tick: 2,
  goalQueueState: { depth: 1, current: null, empty: false, hasImpossible: false, done: 1, goals: [] },
}
const repaired = await planner.plan(stalled)
assert.equal(planner.provider, 'mercury')
assert.equal(planner.authorityModel, 'qwen3.5-9b-local')
assert.equal(mercuryCalls, 1, 'no_progress must call local Mercury exactly once')
assert.equal(externalPlannerKeyLookups, 0, 'local-mercury must never require the TypeSafe gateway key')
assert.equal(repaired.goals[0]?.targetItem, 'raw_iron')
assert.equal(logs.some((entry) => entry.event === 'MERCURY_ATTEMPT'), true)
assert.equal(logs.some((entry) => entry.event === 'SYSTEM2_AUTHORITY_DECISION' && entry.detail.model === 'qwen3.5-9b-local'), true)

assert.throws(
  () => new PlannerBrain({
    bot,
    world: emptyWorldMemory(),
    log: () => undefined,
    cachePath: join(dir, 'missing-mercury-cache.json'),
    mode: 'local-mercury',
  }),
  /requires Mercury/,
)

console.log('local-mercury-authority: PASS (deterministic floor + local Qwen exception repair; no TypeSafe key)')
