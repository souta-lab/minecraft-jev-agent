import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Bot } from 'mineflayer'
import { GoalQueue } from '../jev-agent/src/goalQueue.ts'
import type { PlannedGoal, QueuedGoal } from '../jev-agent/src/goalQueue.ts'
import type { System2Outcome, System2PlanRequest } from '../jev-agent/src/system2.ts'
import { emptyWorldMemory } from './resident-types.ts'
import {
  PLANNER_CACHE_SCHEMA_VERSION,
  PlannerBrain,
  normalizePlanTail,
  plannerCapabilityHash,
  plannerStateHash,
  plannerModelView,
  type PlannerModelView,
  plannerWorldKeyString,
} from './planner-legacy.ts'
import type { PlannerWorldKey } from './planner.ts'
import {
  MERCURY_CACHE_FILE_VERSION,
  MERCURY_CACHE_SCHEMA_VERSION,
  MercurySystem2,
  hashMercuryState,
  mercuryCacheIdentity,
} from './mercury-system2.ts'
import type { MercuryStateSummary, MercuryWorldKey } from './mercury-system2.ts'

interface Case {
  name: string
  run: () => Promise<{ pass: boolean; detail: string }> | { pass: boolean; detail: string }
}

const cases: Case[] = []
function addCase(name: string, run: Case['run']): void {
  cases.push({ name, run })
}

function hostLog(sink: string[]): (event: string, detail?: Record<string, unknown>) => void {
  return (event, detail) => {
    const parts = Object.entries(detail ?? {}).map(([key, value]) => {
      const text = value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value)
      return `${key}=${text}`
    })
    sink.push(`${event}${parts.length > 0 ? ` ${parts.join(' ')}` : ''}`)
  }
}

function makeBot(): Bot {
  return {
    inventory: { items: () => [] },
    entity: { position: { x: 0, y: 64, z: 0 } },
    game: { dimension: 'minecraft:overworld' },
    health: 20,
    food: 20,
    registry: { blocksByName: {} },
    findBlocks: () => [],
  } as unknown as Bot
}

function botHolding(entries: Array<{ name: string; count: number }>): Bot {
  return {
    ...(makeBot() as object),
    inventory: { items: () => entries.map((entry, slot) => ({ ...entry, slot })) },
  } as unknown as Bot
}

function activeGoal(): PlannedGoal {
  return { kind: 'collect', description: 'collect 3 x raw_iron', targetItem: 'raw_iron', requiredCount: 3 }
}

function queued(goal: PlannedGoal): QueuedGoal {
  return {
    id: 'g1',
    kind: goal.kind,
    description: goal.description,
    targetItem: goal.targetItem ?? null,
    requiredCount: goal.requiredCount ?? 1,
    targetY: null,
    dimension: null,
    startCount: 0,
    haveCount: 0,
    status: 'active',
    origin: 'llm',
    createdAt: 0,
    updatedAt: 0,
    detail: null,
  }
}

function waits(n: number): System2Outcome[] {
  return Array.from({ length: n }, () => ({ actionId: 'WAIT', status: 'ok', failure: null, verified: false, detail: '' }))
}

function mercuryRequest(current: PlannedGoal | null): System2PlanRequest {
  return {
    reason: 'action_impossible',
    detail: 'test',
    tick: 1,
    goalQueueState: {
      depth: current === null ? 0 : 1,
      current: current === null ? null : queued(current),
      empty: current === null,
      hasImpossible: false,
      done: 0,
      goals: [],
    },
    objective: { targetItem: 'iron_pickaxe', requiredCount: 1, haveCount: 0, complete: false },
    recentEvents: [],
    recentOutcomes: waits(3),
  }
}

function llmRequest(): System2PlanRequest {
  return {
    reason: 'queue_empty',
    detail: 'test',
    tick: 1,
    goalQueueState: { depth: 0, current: null, empty: true, hasImpossible: false, done: 0, goals: [] },
    objective: { targetItem: 'iron_pickaxe', requiredCount: 1, haveCount: 0, complete: false },
    recentEvents: [],
    recentOutcomes: [],
  }
}

function fakeMercury(op: 'patch' | 'replace' | 'abort', goals: PlannedGoal[]): MercurySystem2 {
  return {
    model: 'fake/mercury',
    tryRepair: async () => ({
      plan: { op, goals, note: `fake ${op}` },
      strategy: `mercury_${op}_test`,
      op,
      goals,
      costUsd: 0,
      ms: 1,
      cached: false,
    }),
  } as unknown as MercurySystem2
}

function seedPlannerCache(
  cachePath: string,
  key: string,
  worldKey: PlannerWorldKey,
  fileVersion: number,
  capabilityHash: string,
): void {
  writeFileSync(
    cachePath,
    `${JSON.stringify({
      version: fileVersion,
      worldKey: plannerWorldKeyString(worldKey),
      worldEpoch: worldKey.worldEpoch,
      schemaVersion: PLANNER_CACHE_SCHEMA_VERSION,
      capabilityHash,
      lastCallAt: 0,
      entries: {
        [key]: {
          optionId: 'front_wood',
          worldKey: plannerWorldKeyString(worldKey),
          schemaVersion: PLANNER_CACHE_SCHEMA_VERSION,
          capabilityHash,
          costUsd: 0,
          ts: Date.now(),
        },
      },
    })}\n`,
  )
}

function mercurySummary(): MercuryStateSummary {
  return {
    humanMission: 'Defeat the Ender Dragon',
    trigger: 'no_candidate',
    wakeReason: 'action_impossible',
    wakeDetail: 'test',
    position: { x: 10, y: 62, z: 10 },
    dimension: 'minecraft:overworld',
    health: 20,
    toolRank: 2,
    inventory: {},
    stations: { craftingTables: 1, furnaces: 1 },
    knownOres: ['coal_ore', 'iron_ore'],
    recentFailures: [],
    consecutiveWait: 0,
    queue: { depth: 1, done: 3, current: 'collect 3 x raw_iron', hasImpossible: false },
    objective: { targetItem: 'raw_iron', requiredCount: 3, haveCount: 0, complete: false },
    deathHistory: [],
    allowedGoals: { collect: ['stone'], craft: [], smelt: ['charcoal'] },
  }
}

addCase('#30: a 4-goal Mercury patch keeps the 3 new tail goals', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'plan-tail-'))
  const logs: string[] = []
  const active = activeGoal()
  const goals: PlannedGoal[] = [
    active,
    { kind: 'collect', description: 'collect 2 x coal', targetItem: 'coal', requiredCount: 2 },
    { kind: 'smelt', description: 'smelt 3 x iron_ingot', targetItem: 'iron_ingot', requiredCount: 3 },
    { kind: 'craft', description: 'craft 1 x iron_pickaxe', targetItem: 'iron_pickaxe', requiredCount: 1 },
  ]
  const brain = new PlannerBrain({
    // The tail's smelt/craft chains are satisfiable from these inputs (the craft
    // ingredient contract now orders producers for missing sticks/ingots), so the
    // patch normalization is what this case exercises.
    bot: botHolding([
      { name: 'coal', count: 2 },
      { name: 'stick', count: 2 },
      { name: 'stone_pickaxe', count: 1 },
      { name: 'furnace', count: 1 },
    ]),
    world: emptyWorldMemory(),
    log: hostLog(logs),
    cachePath: join(dir, 'planner-cache.json'),
    mode: 'llm',
    mercury: fakeMercury('patch', goals),
  })
  const plan = await brain.plan(mercuryRequest(active))
  const queue = new GoalQueue()
  queue.applyPlan([active], 'llm', 'replace')
  queue.applyPlan(plan.goals, 'llm', plan.op ?? 'replace')
  const state = queue.state
  const pending = state.goals.filter((goal) => goal.status === 'pending').map((goal) => goal.targetItem)
  const tailSurvived = ['coal', 'iron_ingot', 'iron_pickaxe'].every((item) => pending.includes(item))
  const skip = logs.find((line) => line.includes('PLAN_TAIL') && line.includes('action=skipped') && line.includes('reason=duplicate_active'))
  const kept = logs.filter((line) => line.includes('PLAN_TAIL') && line.includes('action=kept')).length
  return {
    pass:
      plan.op === 'patch' &&
      plan.goals.length === 3 &&
      state.depth === 4 &&
      state.current?.targetItem === 'raw_iron' &&
      tailSurvived &&
      skip !== undefined &&
      kept === 3,
    detail: `op=${plan.op} goals=[${plan.goals.map((g) => g.description).join(' | ')}] depth=${state.depth} pending=[${pending.join(',')}] kept=${kept} skip=${skip ?? 'none'}`,
  }
})

addCase('#30: a replace with a different tail is applied, not downgraded', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'plan-replace-'))
  const active = activeGoal()
  const goals: PlannedGoal[] = [
    active,
    { kind: 'collect', description: 'collect 1 x diamond', targetItem: 'diamond', requiredCount: 1 },
    { kind: 'craft', description: 'craft 1 x diamond_pickaxe', targetItem: 'diamond_pickaxe', requiredCount: 1 },
  ]
  const brain = new PlannerBrain({
    bot: botHolding([{ name: 'stick', count: 2 }, { name: 'stone_pickaxe', count: 1 }, { name: 'furnace', count: 1 }]),
    world: emptyWorldMemory(),
    log: hostLog([]),
    cachePath: join(dir, 'planner-cache.json'),
    mode: 'llm',
    mercury: fakeMercury('replace', goals),
  })
  const plan = await brain.plan(mercuryRequest(active))
  const items = plan.goals.map((goal) => goal.targetItem)
  return {
    pass: plan.op === 'replace' && plan.goals.length === 3 && items.includes('diamond') && items.includes('diamond_pickaxe'),
    detail: `op=${plan.op} goals=[${items.join(',')}]`,
  }
})

addCase('#30: same target but different requiredCount is not considered identical', () => {
  const normalized = normalizePlanTail(
    [{ kind: 'collect', description: 'collect 2 x raw_iron', targetItem: 'raw_iron', requiredCount: 2 }],
    { kind: 'collect', targetItem: 'raw_iron', requiredCount: 3 },
    'patch',
  )
  const duplicate = normalizePlanTail(
    [activeGoal(), activeGoal()],
    null,
    'replace',
  )
  return {
    pass:
      normalized.goals.length === 1 &&
      normalized.decisions[0]?.action === 'kept' &&
      duplicate.goals.length === 1 &&
      duplicate.decisions[1]?.reason === 'duplicate_in_plan',
    detail: `countDiff=${normalized.decisions[0]?.action} dedupe=${duplicate.decisions[1]?.reason}`,
  }
})

addCase('#30: abort remains abort', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'plan-abort-'))
  const brain = new PlannerBrain({
    bot: makeBot(),
    world: emptyWorldMemory(),
    log: hostLog([]),
    cachePath: join(dir, 'planner-cache.json'),
    mode: 'llm',
    mercury: fakeMercury('abort', []),
  })
  const plan = await brain.plan(mercuryRequest(activeGoal()))
  return { pass: plan.op === 'abort' && plan.goals.length === 0, detail: `op=${plan.op} goals=${plan.goals.length}` }
})

addCase('#33: same-world same-state planner repeat hits the cache', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'planner-cache-hit-'))
  const cachePath = join(dir, 'planner-cache.json')
  const world = emptyWorldMemory()
  const worldKey: PlannerWorldKey = { serverId: 'srv', dimension: 'minecraft:overworld', worldEpoch: 1 }
  const capabilityHash = plannerCapabilityHash()
  const identity = {
    worldKey: plannerWorldKeyString(worldKey),
    worldEpoch: worldKey.worldEpoch,
    schemaVersion: PLANNER_CACHE_SCHEMA_VERSION,
    capabilityHash,
  }
  // Seed with the SAME key the production path computes (#412/#414): the view the model is
  // shown is part of the state hash, so a fixture that omits it would test a different contract.
  const view = plannerModelView({
    counts: {},
    world,
    request: llmRequest(),
    position: { x: 0, y: 64, z: 0 },
    health: 20,
    food: 20,
  })
  const key = plannerStateHash({}, world, { targetItem: 'iron_pickaxe', haveCount: 0 }, identity, 0, null, view)
  seedPlannerCache(cachePath, key, worldKey, 2, capabilityHash)
  const logs: string[] = []
  const brain = new PlannerBrain({ bot: makeBot(), world, log: hostLog(logs), cachePath, worldKey, mode: 'llm' })
  const plan = await brain.plan(llmRequest())
  const cacheLine = logs.find((line) => line.includes('PLANNER_CACHE') && line.includes('hit=true'))
  const planLine = logs.find((line) => line.includes('cached=true'))
  return {
    pass: plan.goals.length === 1 && cacheLine !== undefined && planLine !== undefined,
    detail: `goals=${plan.goals.length} cache=${cacheLine ?? 'none'} plan=${planLine ?? 'none'}`,
  }
})

addCase('#412/#414: the state hash keys on the body/queue/failure inputs the model actually sees', () => {
  // The throttle/cache must not read `no_new_info` while the situation the LLM is shown has changed. Observed live:
  // PLAN_THROTTLED reason=action_impossible because=no_new_info for minutes while the run's typed route exhaustion,
  // its pinned position and its repeated failures were all new information.
  const world = emptyWorldMemory()
  const identity = {
    worldKey: plannerWorldKeyString({ serverId: 'srv', dimension: 'minecraft:overworld', worldEpoch: 1 }),
    worldEpoch: 1,
    schemaVersion: PLANNER_CACHE_SCHEMA_VERSION,
    capabilityHash: plannerCapabilityHash(),
  }
  const objective = { targetItem: 'iron_pickaxe', haveCount: 0 }
  const base: PlannerModelView = {
    position: { x: 10, y: 64, z: 20 },
    health: 20,
    food: 20,
    toolRank: 2,
    queue: { depth: 2, done: 1, current: 'enter_portal', hasImpossible: false },
    wakeReason: 'action_impossible',
    wakeDetail: 'all_routes_spent',
    recentEvents: ['PATH_CALLBACK phase=failed actionId=ENTER:26,67,9'],
    recentOutcomes: ['ENTER:26,67,9:failed:path_stuck'],
    horizon: ['enter_nether', 'blaze_rods'],
  }
  const h = (view: PlannerModelView | null) => plannerStateHash({}, world, objective, identity, 0, null, view)
  const stable = h(base)
  const moved = h({ ...base, position: { x: 11, y: 64, z: 20 } })
  const hurt = h({ ...base, health: 3 })
  const failed = h({ ...base, recentOutcomes: ['ENTER:26,67,9:failed:path_stuck', 'ENTER:26,67,9:failed:path_stuck'] })
  const queue = h({ ...base, queue: { ...base.queue, hasImpossible: true } })
  const horizon = h({ ...base, horizon: ['enter_nether'] })
  const events = h({ ...base, recentEvents: ['ROUTE_SPENT kind=ENTER_PORTAL target=26,67,9'] })
  const noView = plannerStateHash({}, world, objective, identity)
  return {
    pass:
      stable === h(base) &&
      moved !== stable &&
      hurt !== stable &&
      failed !== stable &&
      queue !== stable &&
      horizon !== stable &&
      events !== stable &&
      noView !== stable,
    detail:
      `stable=${stable} moved=${moved !== stable} hurt=${hurt !== stable} failed=${failed !== stable} ` +
      `queue=${queue !== stable} horizon=${horizon !== stable} events=${events !== stable} noViewDiffers=${noView !== stable}`,
  }
})

addCase('#33: a worldEpoch change invalidates the planner cache (reason=world)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'planner-cache-world-'))
  const cachePath = join(dir, 'planner-cache.json')
  const world = emptyWorldMemory()
  const worldA: PlannerWorldKey = { serverId: 'srv', dimension: 'minecraft:overworld', worldEpoch: 1 }
  const capabilityHash = plannerCapabilityHash()
  const identity = {
    worldKey: plannerWorldKeyString(worldA),
    worldEpoch: worldA.worldEpoch,
    schemaVersion: PLANNER_CACHE_SCHEMA_VERSION,
    capabilityHash,
  }
  const key = plannerStateHash({}, world, { targetItem: 'iron_pickaxe', haveCount: 0 }, identity)
  seedPlannerCache(cachePath, key, worldA, 2, capabilityHash)
  const logs: string[] = []
  new PlannerBrain({
    bot: makeBot(),
    world,
    log: hostLog(logs),
    cachePath,
    worldKey: { serverId: 'srv', dimension: 'minecraft:overworld', worldEpoch: 2 },
    mode: 'llm',
  })
  const invalidated = logs.find((line) => line.includes('PLANNER_CACHE_INVALIDATED') && line.includes('reason=world'))
  return { pass: invalidated !== undefined, detail: invalidated ?? 'no invalidation logged' }
})

addCase('#33: a schema/version change invalidates the planner cache (reason=schema)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'planner-cache-schema-'))
  const cachePath = join(dir, 'planner-cache.json')
  const world = emptyWorldMemory()
  const worldA: PlannerWorldKey = { serverId: 'srv', dimension: 'minecraft:overworld', worldEpoch: 1 }
  const capabilityHash = plannerCapabilityHash()
  const identity = {
    worldKey: plannerWorldKeyString(worldA),
    worldEpoch: worldA.worldEpoch,
    schemaVersion: PLANNER_CACHE_SCHEMA_VERSION,
    capabilityHash,
  }
  const key = plannerStateHash({}, world, { targetItem: 'iron_pickaxe', haveCount: 0 }, identity)
  seedPlannerCache(cachePath, key, worldA, 1, capabilityHash)
  const logs: string[] = []
  new PlannerBrain({ bot: makeBot(), world, log: hostLog(logs), cachePath, worldKey: worldA, mode: 'llm' })
  const invalidated = logs.find((line) => line.includes('PLANNER_CACHE_INVALIDATED') && line.includes('reason=schema'))
  return { pass: invalidated !== undefined, detail: invalidated ?? 'no invalidation logged' }
})

addCase('#33: Mercury cache is world-namespaced (hit same world, miss on epoch bump)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mercury-ns-'))
  const cachePath = join(dir, 'mercury-cache.json')
  const summary = mercurySummary()
  const worldKey: MercuryWorldKey = { serverId: 'srv', dimension: 'minecraft:overworld', worldEpoch: 1 }
  const identity = mercuryCacheIdentity(worldKey)
  writeFileSync(
    cachePath,
    `${JSON.stringify({
      version: MERCURY_CACHE_FILE_VERSION,
      worldKey: identity.worldKey,
      worldEpoch: identity.worldEpoch,
      schemaVersion: MERCURY_CACHE_SCHEMA_VERSION,
      entries: {
        [hashMercuryState(summary, identity)]: {
          op: 'patch',
          goals: [{ item: 'stone', count: 12 }],
          reason: 'need stone',
          strategy: 'mercury_patch_collect_stone',
          costUsd: 0,
          ts: Date.now(),
          worldKey: identity.worldKey,
          schemaVersion: MERCURY_CACHE_SCHEMA_VERSION,
          replays: 0,
        },
      },
      callTimes: [],
      consecutiveStrategy: null,
      consecutiveCount: 0,
    })}\n`,
  )
  const logs: string[] = []
  const mercury = new MercurySystem2({
    summarize: () => summary,
    log: hostLog(logs),
    callsPath: join(dir, 'mercury-calls.jsonl'),
    cachePath,
    worldKey,
    maxPerHour: 0,
  })
  const hit = await mercury.tryRepair(mercuryRequest(activeGoal()), 'no_candidate')
  const logsB: string[] = []
  new MercurySystem2({
    summarize: () => summary,
    log: hostLog(logsB),
    callsPath: join(dir, 'mercury-calls.jsonl'),
    cachePath,
    worldKey: { serverId: 'srv', dimension: 'minecraft:overworld', worldEpoch: 2 },
    maxPerHour: 0,
  })
  const invalidated = logsB.find((line) => line.includes('PLANNER_CACHE_INVALIDATED') && line.includes('reason=world'))
  const hitLine = logs.find((line) => line.includes('PLANNER_CACHE') && line.includes('hit=true'))
  return {
    pass: hit !== null && hit.cached && hit.op === 'patch' && invalidated !== undefined && hitLine !== undefined,
    detail: `cached=${hit?.cached ?? false} op=${hit?.op ?? 'none'} hit=${hitLine ?? 'none'} invalidated=${invalidated ?? 'none'}`,
  }
})

let failures = 0
process.stdout.write('Planner plan-tail (#30) + cache namespacing (#33) tests\n')
process.stdout.write(`${'-'.repeat(72)}\n`)
for (const testCase of cases) {
  const observed = await testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write(`${'-'.repeat(72)}\n`)
process.stdout.write(`${cases.length - failures}/${cases.length} plan-tail/cache cases passed\n`)
if (failures > 0) process.exit(1)
