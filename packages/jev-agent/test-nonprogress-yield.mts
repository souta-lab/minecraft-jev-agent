// test-nonprogress-yield.mts - #nonprogress-yield regression.
//
// Live blocker (m3-live `run-mublvgjx-yldu`, source cc658cb, body 9.7,68,5.3
// health=20): the head row `g37:collect:food 0/3` came from the OPTIONAL `food`
// rung, yet it carried `core=true` and held the queue for 27 minutes at zero
// semantic progress:
//
//   CANDIDATE_STARVATION presented=1..2 productive=0 goal=collect:food:3
//     blockedBy=no_productive_action missing=["explore_route_blocked:no_frontier"]
//   LOCAL_PROGRESS_STALL stalledMs=40773 goal=collect:food:3 boundary=local_recovery
//   JEV_HEADS action=MOVE/WAIT abandon=0.20-0.24 decision=continue
//
// while the frontier's own entry goal waited behind it. Its 33 `body` MOVE
// decisions spanned ~15 distinct cells and gained zero items, so #360's
// one-pocket recurrence (distinct<=3) never fired (0 STRATEGIC_NON_PROGRESS*
// markers in the run). This fixture pins the fix end to end:
//
//   (a) an optional zero-semantic-progress head yields to the waiting frontier
//       goal within a bounded number of decisions (typed marker);
//   (b) a starving low-health body keeps food priority (critical fact);
//   (c) a mandatory/frontier head is never yielded;
//   (d) an optional row that IS making semantic progress is never yielded;
//   (d2) a wide body-only journey is NOT semantic progress and still yields;
//   plus the planner marker propagation, the bounded yield budget, durable
//   persistence of the marker/bound, and the ledger re-attribution.
//
// Run: bun test ./test-nonprogress-yield.mts
import {
  formatNonProgressEscalated,
  formatNonProgressYield,
  GoalQueue,
  NON_PROGRESS_ESCALATED,
  NON_PROGRESS_YIELD,
  NON_PROGRESS_YIELD_LIMIT_DEFAULT,
  resolveNonProgressMaxYields,
  resolveNonProgressYieldLimit,
} from './src/goalQueue.ts'
import type { QueuedGoal } from './src/goalQueue.ts'
import { bodyStarving } from './src/state.ts'
import { buildPlanOptions, RUNGS, rungGoalsWithPrereq } from '../buddy-driver/planner.ts'
import { reconcileLedgerGoals } from '../buddy-driver/generation-entry.ts'
import { emptyWorldMemory } from '../buddy-driver/resident-types.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

let counter = 0
function goal(
  id: string,
  kind: QueuedGoal['kind'],
  targetItem: string | null,
  requiredCount: number,
  extra: Partial<QueuedGoal> = {},
): QueuedGoal {
  counter += 1
  return {
    id,
    kind,
    description: `${kind} ${requiredCount} x ${targetItem ?? id}`,
    targetItem,
    requiredCount,
    startCount: 0,
    haveCount: 0,
    status: 'pending',
    origin: 'llm',
    createdAt: counter,
    updatedAt: counter,
    detail: null,
    ...extra,
  }
}

/** The measured head: optional food row first, frontier entry goal second. */
function foodAheadOfFrontier(extraFood: Partial<QueuedGoal> = {}): GoalQueue {
  const queue = new GoalQueue()
  queue.restore({
    counter: 39,
    revision: 1,
    goals: [
      goal('g37:collect:food', 'collect', 'food', 3, { optional: true, ...extraFood }),
      goal('g39:place:nether_portal', 'place', 'nether_portal', 1, { core: true }),
    ],
  })
  return queue
}

const LIMIT = NON_PROGRESS_YIELD_LIMIT_DEFAULT

addCase('(a) an optional zero-progress head yields to the waiting frontier within the bound', () => {
  const queue = foodAheadOfFrontier()
  let yieldedAt = -1
  let lastLine = ''
  for (let index = 1; index <= LIMIT + 1; index += 1) {
    const result = queue.reconcileNonProgressingHead({ limit: LIMIT })
    if (result.action === 'yield') {
      yieldedAt = index
      lastLine = formatNonProgressYield(result)
      break
    }
  }
  const head = queue.current
  return {
    pass:
      yieldedAt > 0 &&
      yieldedAt <= LIMIT &&
      head?.id === 'g39:place:nether_portal' &&
      lastLine.startsWith(NON_PROGRESS_YIELD) &&
      lastLine.includes('next=g39:place:nether_portal') &&
      // #55 untouched: the yielded row is still pending, never dropped
      queue.state.goals.some((entry) => entry.id === 'g37:collect:food' && entry.status === 'pending'),
    detail: `yieldedAt=${yieldedAt}/${LIMIT} head=${head?.id ?? 'none'} line="${lastLine}"`,
  }
})

addCase('(a2) the yield does not fire before the bound (bounded, not immediate)', () => {
  const queue = foodAheadOfFrontier()
  let early = 0
  for (let index = 1; index < LIMIT; index += 1) {
    if (queue.reconcileNonProgressingHead({ limit: LIMIT }).action !== 'hold') early += 1
  }
  return {
    pass: early === 0 && queue.current?.id === 'g37:collect:food',
    detail: `premature=${early} head=${queue.current?.id ?? 'none'}`,
  }
})

addCase('(b) a starving low-health body keeps food priority (critical need escalates, never yields)', () => {
  const queue = foodAheadOfFrontier()
  let escalated: ReturnType<GoalQueue['reconcileNonProgressingHead']> | null = null
  for (let index = 0; index < LIMIT + 2; index += 1) {
    const result = queue.reconcileNonProgressingHead({ limit: LIMIT, critical: true })
    if (result.action !== 'hold') {
      escalated = result
      break
    }
  }
  const starving = bodyStarving({ food: 0, health: 6 })
  const healthy = bodyStarving({ food: 18, health: 20 })
  return {
    pass:
      starving === true &&
      healthy === false &&
      escalated !== null &&
      escalated.action === 'escalate' &&
      escalated.reason === 'critical_need' &&
      queue.current?.id === 'g37:collect:food' &&
      formatNonProgressEscalated(escalated).startsWith(NON_PROGRESS_ESCALATED),
    detail: `action=${escalated?.action ?? 'none'} reason=${escalated?.reason ?? 'none'} head=${queue.current?.id ?? 'none'} starving=${starving} healthy=${healthy}`,
  }
})

addCase('(c) a mandatory/frontier head is unchanged (not eligible, not counted)', () => {
  const queue = new GoalQueue()
  queue.restore({
    counter: 2,
    revision: 1,
    goals: [
      goal('g39:place:nether_portal', 'place', 'nether_portal', 1, { core: true }),
      goal('g40:collect:obsidian', 'collect', 'obsidian', 10, { core: true, protected: true }),
    ],
  })
  let sawNonHold = 0
  let last = queue.reconcileNonProgressingHead({ limit: LIMIT })
  for (let index = 0; index < LIMIT + 3; index += 1) {
    last = queue.reconcileNonProgressingHead({ limit: LIMIT })
    if (last.action !== 'hold') sawNonHold += 1
  }
  return {
    pass:
      sawNonHold === 0 &&
      last.reason === 'not_optional' &&
      last.decisions === 0 &&
      queue.current?.id === 'g39:place:nether_portal',
    detail: `nonHold=${sawNonHold} reason=${last.reason} decisions=${last.decisions} head=${queue.current?.id ?? 'none'}`,
  }
})

addCase('(d) an optional head that IS making semantic progress is unchanged', () => {
  const queue = foodAheadOfFrontier()
  let sawNonHold = 0
  for (let index = 1; index <= LIMIT * 3; index += 1) {
    if (index % 3 === 0) queue.noteSemanticProgress(['goal'])
    if (queue.reconcileNonProgressingHead({ limit: LIMIT }).action !== 'hold') sawNonHold += 1
  }
  return {
    pass: sawNonHold === 0 && queue.current?.id === 'g37:collect:food',
    detail: `nonHold=${sawNonHold} head=${queue.current?.id ?? 'none'}`,
  }
})

addCase('(d2) a wide body-only journey is NOT semantic progress and still yields', () => {
  const queue = foodAheadOfFrontier()
  let yields = 0
  for (let index = 1; index <= LIMIT; index += 1) {
    // `body` progress across a different cell every decision: the measured
    // ~15-distinct-cell wander must not protect the row.
    queue.noteSemanticProgress(['body'])
    if (queue.reconcileNonProgressingHead({ limit: LIMIT }).action === 'yield') yields += 1
  }
  return {
    pass: yields === 1 && queue.current?.id === 'g39:place:nether_portal',
    detail: `yields=${yields} head=${queue.current?.id ?? 'none'}`,
  }
})

addCase('(e) the optional marker survives the compile; mandatory rungs keep core', () => {
  const counts = { diamond: 3, diamond_pickaxe: 1, flint_and_steel: 1 }
  const food = RUNGS.find((rung) => rung.id === 'food')
  const portal = RUNGS.find((rung) => rung.id === 'nether_portal')
  const foodGoals = food === undefined ? [] : rungGoalsWithPrereq(food, counts, emptyWorldMemory())
  const portalGoals = portal === undefined ? [] : rungGoalsWithPrereq(portal, counts, emptyWorldMemory())
  const option = buildPlanOptions(counts, emptyWorldMemory(), { foodLevel: 10, eatBelowFood: 18 }).find(
    (entry) => entry.id === 'food',
  )
  const optionGoals = option?.goals ?? []
  return {
    pass:
      foodGoals.length > 0 &&
      foodGoals.every((entry) => entry.optional === true && entry.core !== true) &&
      optionGoals.length > 0 &&
      optionGoals.every((entry) => entry.optional === true && entry.core !== true) &&
      portalGoals.length > 0 &&
      portalGoals.every((entry) => entry.core === true && entry.optional !== true),
    detail:
      `food=[${foodGoals.map((g) => `${g.kind}:${String(g.optional)}/${String(g.core)}`).join(',')}] ` +
      `option=[${optionGoals.map((g) => `${g.kind}:${String(g.optional)}/${String(g.core)}`).join(',')}] ` +
      `portal=[${portalGoals.map((g) => `${g.kind}:${String(g.core)}`).join(',')}]`,
  }
})

addCase('(f) a row that already spent its yield budget escalates instead of yielding again', () => {
  const queue = foodAheadOfFrontier({ yieldCount: 2 })
  let escalated: ReturnType<GoalQueue['reconcileNonProgressingHead']> | null = null
  for (let index = 0; index < LIMIT + 1; index += 1) {
    const result = queue.reconcileNonProgressingHead({ limit: LIMIT, maxYields: 2 })
    if (result.action !== 'hold') {
      escalated = result
      break
    }
  }
  return {
    pass:
      escalated !== null &&
      escalated.action === 'escalate' &&
      escalated.reason === 'yield_budget_exhausted' &&
      escalated.yields === 2 &&
      queue.current?.id === 'g37:collect:food',
    detail: `action=${escalated?.action ?? 'none'} reason=${escalated?.reason ?? 'none'} yields=${String(escalated?.yields)} head=${queue.current?.id ?? 'none'}`,
  }
})

addCase('(g) an optional head with no alternative row escalates (never yields into nothing)', () => {
  const queue = new GoalQueue()
  queue.restore({ counter: 1, revision: 1, goals: [goal('g1:collect:food', 'collect', 'food', 3, { optional: true })] })
  let escalated: ReturnType<GoalQueue['reconcileNonProgressingHead']> | null = null
  for (let index = 0; index < LIMIT + 1; index += 1) {
    const result = queue.reconcileNonProgressingHead({ limit: LIMIT })
    if (result.action !== 'hold') {
      escalated = result
      break
    }
  }
  return {
    pass:
      escalated !== null &&
      escalated.action === 'escalate' &&
      escalated.reason === 'no_alternative' &&
      queue.current?.id === 'g1:collect:food',
    detail: `action=${escalated?.action ?? 'none'} reason=${escalated?.reason ?? 'none'} head=${queue.current?.id ?? 'none'}`,
  }
})

addCase('(h) the marker, the spent yield budget and the no-progress bound survive a durable snapshot', () => {
  const queue = foodAheadOfFrontier({ yieldCount: 1, nonProgressDecisions: 5 })
  const snapshot = queue.snapshot()
  const restored = new GoalQueue()
  restored.restore(snapshot)
  const head = restored.current
  return {
    pass:
      head?.optional === true &&
      head?.yieldCount === 1 &&
      head?.nonProgressDecisions === 5 &&
      head?.id === 'g37:collect:food',
    detail: `optional=${String(head?.optional)} yieldCount=${String(head?.yieldCount)} nonProgressDecisions=${String(head?.nonProgressDecisions)} head=${head?.id ?? 'none'}`,
  }
})

addCase('(i) the env overrides are bounded and a semantic decision resets the counter', () => {
  const queue = foodAheadOfFrontier()
  queue.reconcileNonProgressingHead({ limit: 9 })
  queue.reconcileNonProgressingHead({ limit: 9 })
  const two = queue.current?.nonProgressDecisions ?? 0
  queue.noteSemanticProgress(['search'])
  const reset = queue.current?.nonProgressDecisions ?? 0
  queue.reconcileNonProgressingHead({ limit: 9 })
  queue.noteSemanticProgress(['none'])
  const afterNone = queue.current?.nonProgressDecisions ?? 0
  const env = { BUDDY_NON_PROGRESS_YIELD_LIMIT: '3', BUDDY_NON_PROGRESS_MAX_YIELDS: '0' }
  return {
    pass:
      two === 2 &&
      reset === 0 &&
      afterNone === 1 &&
      resolveNonProgressYieldLimit(env) === 3 &&
      resolveNonProgressMaxYields(env) === 0 &&
      resolveNonProgressYieldLimit({ BUDDY_NON_PROGRESS_YIELD_LIMIT: 'x' }) === LIMIT,
    detail: `two=${two} reset=${reset} afterNone=${afterNone} envLimit=${resolveNonProgressYieldLimit(env)} envMaxYields=${resolveNonProgressMaxYields(env)}`,
  }
})

addCase('(j) a restored pre-fix core=true food row is re-attributed to the optional rung', () => {
  const preFix = goal('g37:collect:food', 'collect', 'food', 3, { core: true, protected: false })
  const result = reconcileLedgerGoals({ counter: 37, revision: 1, goals: [preFix] }, {}, emptyWorldMemory())
  const row = result.snapshot.goals[0]
  return {
    pass: row?.optional === true && row?.core === true && row?.status === 'pending',
    detail: `optional=${String(row?.optional)} core=${String(row?.core)} status=${String(row?.status)}`,
  }
})

addCase('(j2) a mandatory prerequisite row is not re-attributed as optional', () => {
  const counts = { diamond: 3, diamond_pickaxe: 1, flint_and_steel: 1 }
  const obsidian = goal('g41:collect:obsidian', 'collect', 'obsidian', 10, { core: true, protected: true })
  const result = reconcileLedgerGoals({ counter: 41, revision: 1, goals: [obsidian] }, counts, emptyWorldMemory())
  const row = result.snapshot.goals[0]
  return {
    pass: row?.optional !== true && row?.status === 'pending',
    detail: `optional=${String(row?.optional)} status=${String(row?.status)}`,
  }
})

// ---------------------------------------------------------------------------

let failures = 0
process.stdout.write('optional zero-progress head: bounded yield regression\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} nonprogress-yield cases passed\n`)

if (failures > 0) {
  process.exit(1)
}
