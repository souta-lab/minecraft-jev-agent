// test-mercury-count-budget.mts - RED-FIRST contract for the Mercury typed-plan
// normalization + budget observability fixes.
//
// Ground truth (tools/model-io.mjs, 2026-09-19T18:22:16Z): Mercury (model
// typesafe-ai/jev) PROPOSED the semantically-correct plan
//   goto_resource diamond | collect oak_log | place crafting_table | craft diamond_pickaxe
// and it was REJECTED with `goal[1] collect needs a count in [1,64]` because the
// model omitted the optional `count`. The model was right; the schema/normalization
// dropped it. These cases lock the fix:
//   (a) a count-less collect/craft/smelt goal is ACCEPTED and mechanically
//       normalized to a valid count instead of discarding the plan;
//   (b) an out-of-range count is still rejected with a clear error;
//   (c) budget exhaustion is a DISTINCT observable status (never a silent
//       'fallback' and never a deterministic plan).
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isBudgetExhaustedError,
  MERCURY_DEFAULT_COUNT,
  MercurySystem2,
  normalizeMercuryPlan,
  plannedGoalsFromMercury,
  validateMercuryPlan,
} from './mercury-system2.ts'
import type { MercuryStateSummary } from './mercury-system2.ts'
import { FatalModelError } from '../jev-agent/src/modelFailure.ts'

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
    stations: { craftingTables: 0, furnaces: 0 },
    knownOres: [],
    recentFailures: ['obsidian blocked'],
    consecutiveWait: 0,
    queue: { depth: 1, done: 0, current: null, hasImpossible: true },
    objective: { targetItem: 'diamond_pickaxe', requiredCount: 1, haveCount: 0, complete: false },
    deathHistory: [],
    allowedGoals: { collect: ['oak_log', 'diamond'], craft: ['crafting_table', 'diamond_pickaxe'], smelt: [] },
  }
}

// The exact goal list Mercury emitted at 2026-09-19T18:22:16Z (count omitted on
// the collect and the craft).
const REAL_MERCURY_GOALS = [
  { kind: 'goto_resource' as const, item: 'diamond' },
  { kind: 'collect' as const, item: 'oak_log' },
  { kind: 'place' as const, item: 'crafting_table' },
  { kind: 'craft' as const, item: 'diamond_pickaxe' },
]

addCase('(a) count-less typed collect is ACCEPTED and normalized to the default', () => {
  const checked = validateMercuryPlan({
    op: 'replace',
    goals: [{ kind: 'collect', item: 'oak_log' }],
    reason: 'need wood for the pickaxe',
  })
  if (!checked.ok) return { pass: false, detail: `REJECTED (regression): ${checked.error}` }
  const normalizedCount = checked.plan.goals[0]?.count
  const planned = plannedGoalsFromMercury(checked.plan)[0]
  return {
    pass: normalizedCount === MERCURY_DEFAULT_COUNT && planned?.requiredCount === MERCURY_DEFAULT_COUNT,
    detail: `count=${String(normalizedCount)} requiredCount=${String(planned?.requiredCount)}`,
  }
})

addCase('(a) the real Mercury plan validates and flows to the compiled option path', () => {
  const checked = validateMercuryPlan({
    op: 'replace',
    goals: REAL_MERCURY_GOALS,
    reason: 'blocked obsidian; take the diamond route',
  })
  if (!checked.ok) return { pass: false, detail: `REJECTED (the exact 18:22 rejection): ${checked.error}` }
  const goals = plannedGoalsFromMercury(checked.plan)
  const collectGoal = checked.plan.goals[1]
  const craftGoal = checked.plan.goals[3]
  const pass =
    collectGoal?.count === MERCURY_DEFAULT_COUNT &&
    craftGoal?.count === MERCURY_DEFAULT_COUNT &&
    goals.length === 4 &&
    goals[0]?.kind === 'collect' &&
    goals[0]?.targetItem === 'diamond' &&
    goals[1]?.kind === 'collect' &&
    goals[1]?.targetItem === 'oak_log' &&
    goals[1]?.requiredCount === MERCURY_DEFAULT_COUNT &&
    goals[2]?.kind === 'place' &&
    goals[2]?.targetItem === 'crafting_table' &&
    goals[3]?.kind === 'craft' &&
    goals[3]?.targetItem === 'diamond_pickaxe'
  return {
    pass,
    detail: goals.map((goal) => `${goal.kind}:${goal.targetItem}x${goal.requiredCount}`).join(' -> '),
  }
})

addCase('(a) normalization is mechanical: explicit counts win, non-item goals untouched', () => {
  const explicit = normalizeMercuryPlan({
    op: 'patch',
    goals: [{ kind: 'collect', item: 'oak_log', count: 7 }],
    reason: 'x',
  })
  const typed = normalizeMercuryPlan({ op: 'patch', goals: [{ kind: 'collect', item: 'oak_log' }], reason: 'x' })
  const legacy = normalizeMercuryPlan({ op: 'patch', goals: [{ item: 'stone' }], reason: 'x' })
  const goto = normalizeMercuryPlan({ op: 'patch', goals: [{ kind: 'goto_resource', item: 'diamond' }], reason: 'x' })
  const pass =
    explicit.goals[0]?.count === 7 &&
    typed.goals[0]?.count === MERCURY_DEFAULT_COUNT &&
    legacy.goals[0]?.count === MERCURY_DEFAULT_COUNT &&
    goto.goals[0]?.count === undefined
  return {
    pass,
    detail: `explicit=${String(explicit.goals[0]?.count)} typed=${String(typed.goals[0]?.count)} legacy=${String(legacy.goals[0]?.count)} goto=${String(goto.goals[0]?.count)}`,
  }
})

addCase('(b) an out-of-range count is still rejected with a clear error', () => {
  const zero = validateMercuryPlan({ op: 'patch', goals: [{ kind: 'collect', item: 'oak_log', count: 0 }], reason: 'x' })
  const tooBig = validateMercuryPlan({ op: 'patch', goals: [{ kind: 'collect', item: 'oak_log', count: 65 }], reason: 'x' })
  const fractional = validateMercuryPlan({ op: 'patch', goals: [{ kind: 'collect', item: 'oak_log', count: 1.5 }], reason: 'x' })
  const reasons = [zero, tooBig, fractional].map((result) => (result.ok ? 'ACCEPTED' : result.error))
  const pass =
    !zero.ok &&
    !tooBig.ok &&
    !fractional.ok &&
    reasons.every((reason) => reason.toLowerCase().includes('count'))
  return { pass, detail: reasons.join(' | ') }
})

addCase('(b) budget-exhausted is classified distinctly from transport/model errors', () => {
  const budget = isBudgetExhaustedError(new Error('hourly budget exhausted (20/h)'))
  const transport = isBudgetExhaustedError(new Error('fetch failed'))
  const schema = isBudgetExhaustedError(Object.assign(new Error('invalid plan'), { name: 'ZodError' }))
  return { pass: budget && !transport && !schema, detail: `budget=${budget} transport=${transport} schema=${schema}` }
})

addCase('(c) budget exhaustion is a distinct observable status, never a silent fallback', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mercury-budget-'))
  const callsPath = join(dir, 'mercury-calls.jsonl')
  const logs: string[] = []
  let transportCalls = 0
  const mercury = new MercurySystem2({
    summarize: () => mercurySummary(),
    log: hostLog(logs),
    callsPath,
    cachePath: join(dir, 'mercury-cache.json'),
    maxPerHour: 0,
    resolveKey: () => ({ key: 'test-key', origin: 'test' }),
    transport: () => {
      transportCalls += 1
      return Promise.resolve({ toolCalls: [], usage: null })
    },
  })
  let thrown: unknown = null
  try {
    await mercury.tryRepair(
      {
        reason: 'no_progress',
        detail: 'test',
        tick: 1,
        goalQueueState: { depth: 1, current: null, empty: false, hasImpossible: false, done: 0, goals: [] },
        objective: { targetItem: 'diamond_pickaxe', requiredCount: 1, haveCount: 0, complete: false },
        recentEvents: [],
        recentOutcomes: [],
      },
      'no_candidate',
    )
  } catch (error) {
    thrown = error
  }
  const records = existsSync(callsPath)
    ? readFileSync(callsPath, 'utf8')
        .trim()
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    : []
  const status = records.find((record) => record.outcome === 'budget_exhausted')
  const silentFallback = records.some((record) => record.outcome === 'fallback')
  const budgetLog = logs.find((line) => line.startsWith('MERCURY_BUDGET_EXHAUSTED'))
  const retryLogs = logs.filter((line) => line.startsWith('MERCURY_RETRY')).length
  const deterministic = logs.some((line) => line.includes('deterministic'))
  const errorText = typeof status?.error === 'string' ? status.error : ''
  const pass =
    thrown instanceof FatalModelError &&
    thrown.context === 'mercury:no_candidate' &&
    thrown.reason.includes('hourly budget exhausted') &&
    transportCalls === 0 &&
    status !== undefined &&
    errorText.includes('hourly budget exhausted') &&
    budgetLog !== undefined &&
    budgetLog.includes('maxPerHour=0') &&
    retryLogs === 0 &&
    !silentFallback &&
    !deterministic
  return {
    pass,
    detail: `thrown=${thrown instanceof FatalModelError ? thrown.reason : String(thrown)} transportCalls=${transportCalls} outcomes=${records.map((record) => String(record.outcome)).join(',')} budgetLog=${budgetLog ?? 'none'} retries=${retryLogs} silentFallback=${silentFallback} deterministic=${deterministic}`,
  }
})

let failures = 0
process.stdout.write('Mercury count normalization + budget observability\n')
process.stdout.write(`${'-'.repeat(72)}\n`)
for (const testCase of cases) {
  const observed = await testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write(`${'-'.repeat(72)}\n`)
process.stdout.write(`${cases.length - failures}/${cases.length} count/budget cases passed\n`)
if (failures > 0) process.exit(1)
