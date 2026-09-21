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
  detail: 'merged contract: a drained queue is a semantic moment',
  tick: 1,
  goalQueueState: { depth: 0, current: null, empty: true, hasImpossible: false, done: 1, goals: [] },
  objective: { targetItem: 'iron_pickaxe', requiredCount: 1, haveCount: 0, complete: false },
  recentEvents: [],
  recentOutcomes: [],
}
// MERGED CONTRACT (2613ff6 / d020950): a drained queue must consult the semantic
// layer instead of silently floor-ing to the deterministic ladder. In
// local-mercury mode that means the local model answers the drained queue; the
// fork's original "ordinary queue_empty stays on the deterministic floor"
// expectation is superseded by that newer landed decision.
const drained = await planner.plan(queueEmpty)
assert.equal(planner.provider, 'mercury')
assert.equal(planner.authorityModel, 'qwen3.5-9b-local')
assert.equal(mercuryCalls, 1, 'a drained queue is a semantic moment: local Mercury is consulted')
assert.equal(externalPlannerKeyLookups, 0, 'local-mercury must not touch the TypeSafe planner key')
assert.equal(drained.goals[0]?.targetItem, 'raw_iron')

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
assert.equal(mercuryCalls, 2, 'no_progress must call local Mercury exactly once (one per summon)')
assert.equal(externalPlannerKeyLookups, 0, 'local-mercury must never require the TypeSafe gateway key')
assert.equal(repaired.goals[0]?.targetItem, 'raw_iron')
assert.equal(logs.some((entry) => entry.event === 'MERCURY_ATTEMPT'), true)
assert.equal(logs.some((entry) => entry.event === 'SYSTEM2_AUTHORITY_DECISION' && entry.detail.model === 'qwen3.5-9b-local'), true)

let postDeathCalls = 0
const postDeathMercury = new MercurySystem2({
  model: 'qwen3.5-9b-local',
  summarize,
  log: (event, detail) => logs.push({ event, detail: detail ?? {} }),
  callsPath: join(dir, 'post-death-mercury-calls.jsonl'),
  cachePath: join(dir, 'post-death-mercury-cache.json'),
  postDeathRecovery: true,
  resolveKey: () => ({ key: 'fixture-only', origin: 'fixture' }),
  transport: async () => {
    postDeathCalls += 1
    return {
      toolCalls: [{ input: { op: 'patch', goals: [{ kind: 'collect', item: 'raw_iron', count: 1 }], reason: 'recover after death' } }],
      usage: { inputTokens: 1, outputTokens: 1 },
    }
  },
})
const postDeathPlanner = new PlannerBrain({
  bot,
  world: emptyWorldMemory(),
  log: (event, detail) => logs.push({ event, detail: detail ?? {} }),
  cachePath: join(dir, 'post-death-planner-cache.json'),
  mode: 'local-mercury',
  mercury: postDeathMercury,
  maxAttempts: 1,
  resolveKey: () => {
    externalPlannerKeyLookups += 1
    return null
  },
})

const postDeathLogStart = logs.length
await postDeathPlanner.plan({ ...queueEmpty, tick: 3, detail: 'first plan after respawn' })
assert.equal(postDeathPlanner.provider, 'mercury')
assert.equal(postDeathCalls, 1, 'post-death queue_empty must call local Mercury exactly once')
assert.equal(
  logs.slice(postDeathLogStart).some((entry) => entry.event === 'SYSTEM2_AUTHORITY_INPUT' && entry.detail.trigger === 'post_death'),
  true,
  'post-death recovery must be attributable as trigger=post_death',
)

const afterPostDeathLogStart = logs.length
await postDeathPlanner.plan({ ...queueEmpty, tick: 4, detail: 'ordinary queue after post-death repair' })
assert.equal(postDeathPlanner.provider, 'mercury')
assert.equal(postDeathCalls, 2, 'post-death is consumed once; the later drained queue is a fresh no_candidate consult')
assert.equal(
  logs.slice(afterPostDeathLogStart).some((entry) => entry.event === 'SYSTEM2_AUTHORITY_INPUT' && entry.detail.trigger === 'no_candidate'),
  true,
  'the post-death-repair follow-up drained queue must be attributable as trigger=no_candidate',
)
assert.equal(externalPlannerKeyLookups, 0, 'post-death local Mercury must not touch the TypeSafe planner key')

let staleCurrent = true
let releaseTransport!: () => void
let markTransportStarted!: () => void
const transportStarted = new Promise<void>((resolve) => {
  markTransportStarted = () => resolve()
})
const transportRelease = new Promise<void>((resolve) => {
  releaseTransport = () => resolve()
})
const staleMercury = new MercurySystem2({
  model: 'qwen3.5-9b-local',
  summarize,
  log: (event, detail) => logs.push({ event, detail: detail ?? {} }),
  callsPath: join(dir, 'stale-mercury-calls.jsonl'),
  cachePath: join(dir, 'stale-mercury-cache.json'),
  localEndpoint: null,
  retries: 0,
  generationId: 'gen-old',
  isCurrent: () => staleCurrent,
  resolveKey: () => ({ key: 'fixture-only', origin: 'fixture' }),
  transport: async () => {
    markTransportStarted()
    await transportRelease
    return {
      toolCalls: [{ input: { op: 'replace', goals: [{ kind: 'collect', item: 'raw_iron', count: 1 }], reason: 'late old-generation answer' } }],
      usage: { inputTokens: 1, outputTokens: 1 },
    }
  },
})
const stalePlanner = new PlannerBrain({
  bot,
  world: emptyWorldMemory(),
  log: (event, detail) => logs.push({ event, detail: detail ?? {} }),
  cachePath: join(dir, 'stale-planner-cache.json'),
  mode: 'local-mercury',
  mercury: staleMercury,
  maxAttempts: 1,
})
const staleLogStart = logs.length
const stalePlanPromise = stalePlanner.plan({ ...stalled, tick: 5, detail: 'old generation in flight' })
await transportStarted
staleCurrent = false
releaseTransport()
const stalePlan = await stalePlanPromise
const staleLogs = logs.slice(staleLogStart)
assert.equal(stalePlan.op, 'continue')
assert.equal(stalePlan.goals.length, 0, 'stale Mercury result must not carry goals into the old queue')
assert.equal(staleLogs.some((entry) => entry.event === 'MERCURY_STALE_DISCARD' && entry.detail.generationId === 'gen-old'), true)
assert.equal(staleLogs.some((entry) => entry.event === 'SYSTEM2_STALE_DISCARD'), true)
assert.equal(
  staleLogs.some((entry) => entry.event === 'SYSTEM2_AUTHORITY_DECISION'),
  false,
  'stale answer must not be published as an authority decision',
)

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
