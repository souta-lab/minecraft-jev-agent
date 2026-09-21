// Regression: a configured Mercury/Muse repair must be used for exception-driven
// WHAT NEXT in live planner mode; the Jev action policy remains a later layer.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Bot } from 'mineflayer'
import type { System2PlanRequest } from '../jev-agent/src/system2.ts'
import { emptyWorldMemory } from './resident-types.ts'
import { MUSE_SPARK_MODEL, MercurySystem2 } from './mercury-system2.ts'
import { PlannerBrain } from './planner.ts'

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

const dir = mkdtempSync(join(tmpdir(), 'mercury-authority-wiring-'))
const summary = {
  trigger: 'wait_limit' as const,
  wakeReason: 'no_progress',
  wakeDetail: 'candidate starvation',
  rung: 'iron_gear',
  rungIndex: 10,
  position: { x: 0, y: 61, z: 0 },
  dimension: 'minecraft:overworld',
  health: 20,
  toolRank: 3,
  inventory: { iron_pickaxe: 1, iron_ingot: 3, flint_and_steel: 1 },
  stations: { craftingTables: 1, furnaces: 1 },
  knownOres: ['raw_iron'],
  recentFailures: ['ESCALATE:failed:no_productive_action'],
  consecutiveWait: 3,
  queue: { depth: 1, done: 4, current: 'collect 1 x raw_iron', hasImpossible: false },
  objective: { targetItem: 'raw_iron', requiredCount: 1, haveCount: 0, complete: false },
  deathHistory: [],
  allowedGoals: {
    collect: ['raw_iron'],
    craft: ['iron_pickaxe'],
    smelt: ['iron_ingot'],
    place: ['furnace'],
    goto_resources: ['raw_iron'],
    explore_modes: ['cave', 'surface'],
  },
}

const mercury = new MercurySystem2({
  model: MUSE_SPARK_MODEL,
  summarize: () => summary,
  log: (event, detail) => logs.push({ event, detail: detail ?? {} }),
  callsPath: join(dir, 'mercury-calls.jsonl'),
  cachePath: join(dir, 'mercury-cache.json'),
  resolveKey: () => ({ key: 'fixture-key', origin: 'fixture' }),
  transport: async () => ({
    toolCalls: [{ input: { op: 'patch', goals: [{ kind: 'collect', item: 'raw_iron', count: 1 }], reason: 'recover access' } }],
    usage: { inputTokens: 1, outputTokens: 1 },
  }),
})

const request: System2PlanRequest = {
  reason: 'no_progress',
  detail: 'candidate starvation',
  tick: 10,
  goalQueueState: { depth: 1, current: null, empty: false, hasImpossible: false, done: 4, goals: [] },
  objective: { targetItem: 'raw_iron', requiredCount: 1, haveCount: 0, complete: false },
  recentEvents: [],
  recentOutcomes: [
    { actionId: 'WAIT', status: 'done', failure: null, verified: true, detail: '' },
    { actionId: 'WAIT', status: 'done', failure: null, verified: true, detail: '' },
    { actionId: 'WAIT', status: 'done', failure: null, verified: true, detail: '' },
  ],
}

const planner = new PlannerBrain({
  bot,
  world: emptyWorldMemory(),
  log: (event, detail) => logs.push({ event, detail: detail ?? {} }),
  cachePath: join(dir, 'planner-cache.json'),
  mode: 'llm',
  mercury,
  maxAttempts: 1,
  // If the Mercury branch is bypassed this would fail loudly, proving the test
  // cannot accidentally pass through the Jev horizon selector.
  resolveKey: () => null,
})

// Before a request no provider has actually owned a semantic choice yet. The
// configured stack is still hybrid, but reporting it as the last authority
// would falsely claim Mercury owned a queue_empty/Typesafe decision.
assert.equal(planner.provider, 'none')
assert.equal(planner.authorityModel, 'none')
assert.deepEqual(planner.authorityStack, {
  provider: 'hybrid',
  model: `typesafe-ai:${planner.model}|muse-spark:${MUSE_SPARK_MODEL}`,
})

const plan = await planner.plan(request)
assert.equal(mercury.model, MUSE_SPARK_MODEL)
assert.equal(planner.provider, 'muse-spark')
assert.equal(planner.authorityModel, MUSE_SPARK_MODEL)
assert.equal(plan.goals[0]?.targetItem, 'raw_iron')
assert.match(plan.note, /mercury/i)
assert.equal(logs.some((entry) => entry.event === 'MERCURY_ATTEMPT'), true)
assert.equal(
  logs.some((entry) => entry.event === 'SYSTEM2_AUTHORITY_INPUT' && entry.detail.source === 'muse-spark'),
  true,
)
assert.equal(
  logs.some((entry) => entry.event === 'SYSTEM2_AUTHORITY_DECISION' && entry.detail.model === MUSE_SPARK_MODEL),
  true,
)
console.log('mercury-authority-wiring: PASS (exception WHAT NEXT uses Muse; Jev fallback is not reached)')
