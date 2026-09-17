// test-advisor-cache.mts - deterministic, no-network tests for the advisor/Mercury
// cache replay + invalidation guard (issues #15, #29). No bot, no gateway key.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Advisor, MAX_CACHE_REPLAYS, groundStrategy, hashAdvisorState } from './advisor.ts'
import type { AdvisorState, AdvisorStrategy } from './advisor.ts'
import {
  MAX_CACHE_REPLAYS as MERCURY_MAX_REPLAYS,
  MercurySystem2,
  groundMercuryPlan,
  hashMercuryState,
  plannedGoalsFromMercury,
  validateMercuryPlan,
} from './mercury-system2.ts'
import type { MercuryStateSummary } from './mercury-system2.ts'
import type { System2Outcome, System2PlanRequest } from '../jev-agent/src/system2.ts'
import type { PlannedGoal } from '../jev-agent/src/goalQueue.ts'

interface Case {
  name: string
  run: () => Promise<{ pass: boolean; detail: string }> | { pass: boolean; detail: string }
}

const cases: Case[] = []
function addCase(name: string, run: Case['run']): void {
  cases.push({ name, run })
}

function advisorState(overrides: Partial<AdvisorState> = {}): AdvisorState {
  return {
    rung: 'raw_iron',
    rungIndex: 7,
    position: { x: 10, y: 62, z: 10 },
    dimension: 'minecraft:overworld',
    inventory: {},
    toolRank: 2,
    stations: { craftingTables: 1, furnaces: 1 },
    discoveredOres: ['coal_ore', 'copper_ore', 'iron_ore'],
    queueCurrent: 'collect 3 x raw_iron',
    queueDepth: 1,
    queueDone: 3,
    waitStreak: 8,
    failedCandidates: { WAIT: 3 },
    recentFailures: [],
    ...overrides,
  }
}

function outcome(actionId: string): System2Outcome {
  return { actionId, status: 'ok', failure: null, verified: false, detail: '' }
}

// Mirrors the host logger's `event key=value ...` line format so assertions read
// the same strings the resident writes to buddy.log.
function hostLog(sink: string[]): (event: string, detail?: Record<string, unknown>) => void {
  return (event, detail) => {
    const parts = Object.entries(detail ?? {}).map(([key, value]) => {
      const text = value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value)
      return `${key}=${text}`
    })
    sink.push(`${event}${parts.length > 0 ? ` ${parts.join(' ')}` : ''}`)
  }
}

function planRequest(): System2PlanRequest {
  return {
    reason: 'no_progress',
    detail: 'test',
    tick: 1,
    goalQueueState: { depth: 1, current: null, empty: false, hasImpossible: false, done: 0, goals: [] },
    objective: { targetItem: 'iron_pickaxe', requiredCount: 1, haveCount: 0, complete: false },
    recentEvents: [],
    recentOutcomes: [outcome('WAIT'), outcome('WAIT'), outcome('WAIT')],
  }
}

function mercuryState(overrides: Partial<MercuryStateSummary> = {}): MercuryStateSummary {
  return {
    trigger: 'no_candidate',
    wakeReason: 'action_impossible',
    wakeDetail: 'test',
    rung: 'raw_iron',
    rungIndex: 7,
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
    ...overrides,
  }
}

function seedAdvisorCache(
  cachePath: string,
  entries: Record<string, { strategy: AdvisorStrategy; goals: PlannedGoal[]; replays: number }>,
): void {
  const payload = {
    version: 2,
    lastCallAt: 0,
    entries: Object.fromEntries(
      Object.entries(entries).map(([hash, entry]) => [
        hash,
        { strategy: entry.strategy, costUsd: 0, ts: Date.now(), goals: entry.goals, replays: entry.replays },
      ]),
    ),
    consecutiveStrategy: null,
    consecutiveCount: 0,
  }
  writeFileSync(cachePath, `${JSON.stringify(payload)}\n`)
}

function makeAdvisor(
  cachePath: string,
  compile: (strategy: AdvisorStrategy, state: AdvisorState) => PlannedGoal[],
): Advisor {
  return new Advisor({ log: () => undefined, cachePath, mode: 'llm', compile })
}

const branchGoals: PlannedGoal[] = [
  { kind: 'collect', description: 'collect 3 x raw_iron', targetItem: 'raw_iron', requiredCount: 3 },
]

addCase('grounds smelt_and_craft without raw_iron/furnace and replaces it', () => {
  const refused = groundStrategy('smelt_and_craft', advisorState({ stations: { craftingTables: 1, furnaces: 0 } }))
  const applicable = groundStrategy('smelt_and_craft', advisorState({ inventory: { raw_iron: 2 } }))
  const noOre = groundStrategy(
    'smelt_and_craft',
    advisorState({ stations: { craftingTables: 1, furnaces: 1 }, inventory: {}, discoveredOres: [] }),
  )
  return {
    pass:
      refused.refused &&
      refused.strategy === 'return_to_known_ore' &&
      refused.requested === 'smelt_and_craft' &&
      !applicable.refused &&
      applicable.strategy === 'smelt_and_craft' &&
      noOre.refused &&
      noOre.strategy === 'branch_mine',
    detail: `refused=${refused.strategy}(${refused.reason}) applicable=${applicable.strategy} noOre=${noOre.strategy}`,
  }
})

addCase('cache hit replays the cached PLAN (goals), not a recompile', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'advisor-cache-'))
  const cachePath = join(dir, 'advisor-cache.json')
  const state = advisorState()
  const cachedGoals: PlannedGoal[] = [{ kind: 'collect', description: 'cached plan marker', targetItem: 'cobblestone', requiredCount: 99 }]
  const differentGoals: PlannedGoal[] = [{ kind: 'collect', description: 'recompiled marker', targetItem: 'diamond', requiredCount: 1 }]
  seedAdvisorCache(cachePath, { [hashAdvisorState(state)]: { strategy: 'branch_mine', goals: cachedGoals, replays: 0 } })
  const advisor = makeAdvisor(cachePath, () => differentGoals)
  const first = await advisor.decide(state, 'wait_limit')
  const second = await advisor.decide(state, 'wait_limit')
  return {
    pass:
      first.cached &&
      second.cached &&
      first.source === 'llm' &&
      first.strategy === 'branch_mine' &&
      JSON.stringify(first.goals) === JSON.stringify(cachedGoals) &&
      JSON.stringify(first.goals) !== JSON.stringify(differentGoals),
    detail: `first=${JSON.stringify(first.goals)} cached=${first.cached},${second.cached}`,
  }
})

addCase('cache bypasses repeat_no_progress after MAX_CACHE_REPLAYS identical hits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'advisor-loop-'))
  const cachePath = join(dir, 'advisor-cache.json')
  const state = advisorState()
  const logs: string[] = []
  seedAdvisorCache(cachePath, { [hashAdvisorState(state)]: { strategy: 'branch_mine', goals: branchGoals, replays: 0 } })
  const advisor = new Advisor({
    log: hostLog(logs),
    cachePath,
    mode: 'llm',
    compile: (strategy, s) => (strategy === 'branch_mine' ? branchGoals : [{ kind: 'collect', description: `fallback ${strategy}`, targetItem: 'cobblestone', requiredCount: s.toolRank }]),
  })
  const decisions = []
  for (let i = 0; i <= MAX_CACHE_REPLAYS; i += 1) decisions.push(await advisor.decide(state, 'wait_limit'))
  const bypass = logs.find((line) => line.includes('ADVISOR_CACHE bypass'))
  const cachedRun = decisions.filter((d) => d.cached).length
  const last = decisions[decisions.length - 1]
  return {
    pass:
      cachedRun === MAX_CACHE_REPLAYS &&
      last !== undefined &&
      !last.cached &&
      last.strategy === 'return_to_known_ore' &&
      bypass !== undefined &&
      bypass.includes('reason=repeat_no_progress') &&
      bypass.includes('strategy=branch_mine'),
    detail: `cachedRun=${cachedRun} bypass=${bypass ?? 'none'} last=${last?.strategy}/${last?.cached}`,
  }
})

addCase('consecutive same-strategy cached hits across states are capped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'advisor-consec-'))
  const cachePath = join(dir, 'advisor-cache.json')
  const stateA = advisorState({ queueCurrent: 'collect 3 x raw_iron' })
  const stateB = advisorState({ queueCurrent: 'collect 8 x coal', inventory: { cobblestone: 12 } })
  const logs: string[] = []
  seedAdvisorCache(cachePath, {
    [hashAdvisorState(stateA)]: { strategy: 'branch_mine', goals: branchGoals, replays: 0 },
    [hashAdvisorState(stateB)]: { strategy: 'branch_mine', goals: branchGoals, replays: 0 },
  })
  const advisor = new Advisor({
    log: hostLog(logs),
    cachePath,
    mode: 'llm',
    compile: () => branchGoals,
  })
  const a = await advisor.decide(stateA, 'wait_limit')
  const b1 = await advisor.decide(stateB, 'wait_limit')
  const b2 = await advisor.decide(stateB, 'wait_limit')
  const bypass = logs.find((line) => line.includes('ADVISOR_CACHE bypass'))
  return {
    pass:
      a.cached &&
      b1.cached &&
      !b2.cached &&
      bypass !== undefined &&
      bypass.includes('reason=consecutive_same_strategy'),
    detail: `a=${a.cached} b1=${b1.cached} b2=${b2.cached} bypass=${bypass ?? 'none'}`,
  }
})

addCase('mercury cache hit replays the cached plan instead of continue + empty goals', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mercury-cache-'))
  const cachePath = join(dir, 'mercury-cache.json')
  const summary = mercuryState()
  const seededPlan = { op: 'patch' as const, goals: [{ item: 'stone', count: 12 }], reason: 'need stone for the furnace' }
  writeFileSync(
    cachePath,
    `${JSON.stringify({
      version: 3,
      worldKey: 'local|unknown|0',
      worldEpoch: 0,
      schemaVersion: 3,
      entries: {
        [hashMercuryState(summary)]: {
          op: seededPlan.op,
          goals: seededPlan.goals,
          reason: seededPlan.reason,
          strategy: 'mercury_patch_collect_stone',
          costUsd: 0,
          ts: Date.now(),
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
    maxPerHour: 0,
  })
  const first = await mercury.tryRepair(planRequest(), 'no_candidate')
  const expected = plannedGoalsFromMercury(seededPlan)
  const callLog = await import('node:fs').then((fs) => (fs.existsSync(join(dir, 'mercury-calls.jsonl')) ? 'written' : 'absent'))
  return {
    pass:
      first !== null &&
      first.cached &&
      first.op === 'patch' &&
      JSON.stringify(first.goals) === JSON.stringify(expected) &&
      first.goals.some((goal) => goal.targetItem === 'stone' && goal.requiredCount === 12) &&
      callLog === 'absent',
    detail: `op=${first?.op} goals=${JSON.stringify(first?.goals)} calls=${callLog}`,
  }
})

addCase('mercury cache bypasses after MAX_CACHE_REPLAYS identical hits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mercury-loop-'))
  const cachePath = join(dir, 'mercury-cache.json')
  const summary = mercuryState()
  writeFileSync(
    cachePath,
    `${JSON.stringify({
      version: 3,
      worldKey: 'local|unknown|0',
      worldEpoch: 0,
      schemaVersion: 3,
      entries: {
        [hashMercuryState(summary)]: {
          op: 'patch',
          goals: [{ item: 'stone', count: 12 }],
          reason: 'x',
          strategy: 'mercury_patch_collect_stone',
          costUsd: 0,
          ts: Date.now(),
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
    maxPerHour: 0,
  })
  const results = []
  for (let i = 0; i <= MERCURY_MAX_REPLAYS; i += 1) results.push(await mercury.tryRepair(planRequest(), 'no_candidate'))
  const replayCount = results.filter((r) => r !== null && r.cached).length
  const bypass = logs.find((line) => line.includes('ADVISOR_CACHE bypass'))
  return {
    pass:
      replayCount === MERCURY_MAX_REPLAYS &&
      results[results.length - 1] === null &&
      bypass !== undefined &&
      bypass.includes('reason=repeat_no_progress'),
    detail: `replays=${replayCount} last=${results[results.length - 1]} bypass=${bypass ?? 'none'}`,
  }
})

addCase('mercury grounding refuses a smelt-first plan with no held input', () => {
  const plan = { op: 'replace' as const, goals: [{ item: 'iron_ingot', count: 3 }], reason: 'smelt it' }
  const refused = groundMercuryPlan(plan, { inventory: {} })
  const applicable = groundMercuryPlan(plan, { inventory: { raw_iron: 3 } })
  const validated = validateMercuryPlan(refused.plan)
  return {
    pass:
      refused.refused !== null &&
      refused.plan.goals[0]?.item === 'raw_iron' &&
      validated.ok &&
      applicable.refused === null,
    detail: `refused=${JSON.stringify(refused.refused)} goals=${JSON.stringify(refused.plan.goals)}`,
  }
})

let failures = 0
process.stdout.write('Advisor / Mercury cache replay + invalidation tests\n')
process.stdout.write(`${'-'.repeat(72)}\n`)
for (const testCase of cases) {
  const observed = await testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write(`${'-'.repeat(72)}\n`)
process.stdout.write(`${cases.length - failures}/${cases.length} cache-guard cases passed\n`)
if (failures > 0) process.exit(1)
