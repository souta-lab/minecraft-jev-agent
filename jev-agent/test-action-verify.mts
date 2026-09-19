// test-action-verify.mts - Issue #79: an unverified zero-progress action is a
// FAILURE, never `done`; the same strategy is abandoned after N attempts and the
// ladder never advances on an unverified action. Pure: no bot, no network, no
// model. It also prints the exact ACTION_UNVERIFIED / ABANDON_REASON lines.
import {
  decideActionOutcome,
  describeActionPostcondition,
  evaluateUnverifiedBudget,
  formatActionUnverified,
  hasObservableProgress,
  isPlacePostconditionMet,
  isSmeltPostconditionMet,
  isUnverifiedOutcome,
  isZeroProgressOutcome,
  UNVERIFIED_ACTION_LIMIT,
} from './src/actionPostcondition.ts'
import { executeFurnaceSmelt, formatSmeltLog } from './src/executor.ts'
import type { SmeltFurnaceWindow } from './src/executor.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string } | Promise<{ pass: boolean; detail: string }>
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

const PLAN_ID = 'g41:smelt:iron_ingot'
const STRATEGY = 'llm:smelt'

interface SmeltFixtureOptions {
  /** the fake furnace produces an output item when true */
  produce: boolean
  /** the fake furnace input/fuel slots report an empty (consumed) stack when true */
  consumeSlots: boolean
  timeoutMs: number
}

async function runSmeltFixture(options: SmeltFixtureOptions): Promise<{
  outcome: Awaited<ReturnType<typeof executeFurnaceSmelt>>
  stash: Record<string, number>
  lines: string[]
}> {
  const stash: Record<string, number> = { raw_iron: 3, coal: 1, iron_ingot: 0 }
  const placed = { input: 0, fuel: 0 }
  let pending = 0
  const window: SmeltFurnaceWindow = {
    putInput: async (_type, _meta, count) => {
      pending = options.produce ? count : 0
      placed.input = count
      stash.raw_iron = (stash.raw_iron ?? 0) - count
    },
    putFuel: async (_type, _meta, count) => {
      placed.fuel = count
      stash.coal = (stash.coal ?? 0) - count
    },
    outputItem: () => (pending > 0 ? { count: 1 } : null),
    takeOutput: async () => {
      pending -= 1
      stash.iron_ingot = (stash.iron_ingot ?? 0) + 1
    },
    inputItem: () => (options.consumeSlots ? null : { count: placed.input }),
    fuelItem: () => (options.consumeSlots ? null : { count: placed.fuel }),
    close: () => undefined,
  }
  const lines: string[] = []
  const outcome = await executeFurnaceSmelt(
    {
      openFurnace: async () => window,
      inventoryItems: () => Object.entries(stash).map(([name, count], index) => ({ name, type: index, count })),
      countItem: (name) => stash[name] ?? 0,
      wait: async () => undefined,
      ensureOwned: () => undefined,
      timeoutMs: options.timeoutMs,
      log: (event, detail) => lines.push(formatSmeltLog(event, detail)),
    },
    { inputItem: 'raw_iron', fuelItem: 'coal', outputItem: 'iron_ingot', inputCount: 3, fuelCount: 1 },
  )
  return { outcome, stash, lines }
}

addCase('(#79a) smelt done+verified=false+progressDelta=0 is FAILURE with ACTION_UNVERIFIED, not done', () => {
  const decision = decideActionOutcome({
    kind: 'SMELT',
    status: 'done',
    verified: false,
    itemsGained: 0,
    blockRemoved: false,
    planId: PLAN_ID,
    actionId: 'ESCALATE',
    strategy: STRATEGY,
  })
  const line = decision.unverifiedLine ?? ''
  const pass =
    isUnverifiedOutcome({ kind: 'SMELT', status: 'done', verified: false, itemsGained: 0, blockRemoved: false }) &&
    decision.verdict === 'unverified' &&
    decision.advances === false &&
    line.startsWith('ACTION_UNVERIFIED ') &&
    line.includes(`planId=${PLAN_ID}`) &&
    line.includes('actionId=ESCALATE') &&
    line.includes(`strategy=${STRATEGY}`) &&
    line.includes('postcondition=target item count increased') &&
    describeActionPostcondition('SMELT').includes('input+fuel consumed')
  return { pass, detail: line }
})

addCase('(#79b) a genuine smelt (item count increases) is verified=true and advances the ladder', () => {
  const decision = decideActionOutcome({
    kind: 'SMELT',
    status: 'done',
    verified: true,
    itemsGained: 3,
    blockRemoved: false,
    planId: PLAN_ID,
    actionId: 'SMELT:b29_61_35',
    strategy: STRATEGY,
  })
  const pass = decision.verdict === 'verified' && decision.advances === true && decision.unverifiedLine === null
  return {
    pass,
    detail: `verdict=${decision.verdict} advances=${decision.advances} line=${decision.unverifiedLine === null ? 'none' : decision.unverifiedLine}`,
  }
})

addCase('(#79c) the same strategy is not retried past N unverified attempts; ABANDON_REASON=action_unverified appears', () => {
  const first = evaluateUnverifiedBudget({ attempts: 1, limit: UNVERIFIED_ACTION_LIMIT, planId: PLAN_ID, strategy: STRATEGY })
  const second = evaluateUnverifiedBudget({ attempts: 2, limit: UNVERIFIED_ACTION_LIMIT, planId: PLAN_ID, strategy: STRATEGY })
  const third = evaluateUnverifiedBudget({ attempts: 3, limit: UNVERIFIED_ACTION_LIMIT, planId: PLAN_ID, strategy: STRATEGY })
  const expected = `ABANDON_REASON=action_unverified planId=${PLAN_ID} attempts=2 strategy=${STRATEGY}`
  const pass =
    UNVERIFIED_ACTION_LIMIT === 2 &&
    first.abandon === false &&
    first.line === null &&
    second.abandon === true &&
    second.line === expected &&
    third.abandon === true
  return { pass, detail: `limit=${UNVERIFIED_ACTION_LIMIT} first=${first.abandon} second=${second.line ?? 'none'}` }
})

addCase('(#79d) an unverified action cannot advance the rung', () => {
  const smeltUnverified = decideActionOutcome({
    kind: 'SMELT',
    status: 'done',
    verified: false,
    itemsGained: 0,
    blockRemoved: false,
    planId: PLAN_ID,
    actionId: 'ESCALATE',
    strategy: STRATEGY,
  })
  const retrieveUnverified = decideActionOutcome({
    kind: 'RETRIEVE',
    status: 'done',
    verified: false,
    itemsGained: 0,
    blockRemoved: false,
    planId: PLAN_ID,
    actionId: 'RETRIEVE:known:station:furnace:b29_61_35',
    strategy: STRATEGY,
  })
  const failed = decideActionOutcome({ kind: 'SMELT', status: 'failed', verified: false, itemsGained: 0, blockRemoved: false })
  const verifiedDig = decideActionOutcome({ kind: 'MINE', status: 'done', verified: true, itemsGained: 1, blockRemoved: true })
  const pass =
    smeltUnverified.advances === false &&
    retrieveUnverified.advances === false &&
    failed.advances === false &&
    verifiedDig.advances === true
  return {
    pass,
    detail: `smelt=${smeltUnverified.advances} retrieve=${retrieveUnverified.advances} failed=${failed.advances} verifiedDig=${verifiedDig.advances}`,
  }
})

addCase('(#79) the observed live causal line is exactly reproducible and classified as unverified', () => {
  const line = formatActionUnverified({
    planId: PLAN_ID,
    actionId: 'ESCALATE',
    strategy: STRATEGY,
    postcondition: describeActionPostcondition('SMELT'),
  })
  const decision = decideActionOutcome({
    kind: 'SMELT',
    status: 'done',
    verified: false,
    itemsGained: 0,
    blockRemoved: false,
    planId: PLAN_ID,
    actionId: 'ESCALATE',
    strategy: STRATEGY,
  })
  const pass = decision.unverifiedLine === line && line.includes('postcondition=')
  return { pass, detail: line }
})

addCase('(#79e) smelt with no output increase and no consumption is unverified, never done', async () => {
  const { outcome, lines } = await runSmeltFixture({ produce: false, consumeSlots: false, timeoutMs: 0 })
  const verified = isSmeltPostconditionMet(outcome)
  const decision = decideActionOutcome({
    kind: 'SMELT',
    status: 'done',
    verified,
    itemsGained: outcome.gained,
    blockRemoved: false,
    planId: PLAN_ID,
    actionId: 'SMELT:b29_61_35',
    strategy: STRATEGY,
    attempts: 1,
  })
  const line = decision.unverifiedLine ?? ''
  const unproduced = lines.find((entry) => entry.startsWith('SMELT_UNPRODUCED')) ?? ''
  const pass =
    outcome.gained === 0 &&
    outcome.consumedInput === false &&
    outcome.consumedFuel === false &&
    verified === false &&
    decision.verdict === 'unverified' &&
    decision.advances === false &&
    line.startsWith('ACTION_UNVERIFIED ') &&
    line.includes('attempts=1') &&
    line.includes('postcondition=target item count increased') &&
    unproduced.includes('gained=0')
  return { pass, detail: `${unproduced} | ${line}` }
})

addCase('(#79f) smelt that increased iron_ingot is verified and advances the ladder', async () => {
  const { outcome, stash } = await runSmeltFixture({ produce: true, consumeSlots: false, timeoutMs: 5000 })
  const verified = isSmeltPostconditionMet(outcome)
  const decision = decideActionOutcome({
    kind: 'SMELT',
    status: 'done',
    verified,
    itemsGained: outcome.gained,
    blockRemoved: false,
    planId: PLAN_ID,
    actionId: 'SMELT:b29_61_35',
    strategy: STRATEGY,
    attempts: 1,
  })
  // The fixture places inputCount=3, so the action must harvest all three outputs,
  // not just the first (#199's `harvested === 0` stop). Live run-mu8c89s6-rnv6
  // logged `SMELT_DONE gained=1` from a `raw_iron x3` placement and stranded the
  // other two in the furnace.
  const pass =
    outcome.gained === 3 &&
    outcome.placedInput === 3 &&
    stash.iron_ingot === 3 &&
    verified === true &&
    decision.verdict === 'verified' &&
    decision.advances === true &&
    decision.unverifiedLine === null
  return { pass, detail: `gained=${outcome.gained} placed=${outcome.placedInput} inv=${stash.iron_ingot} verdict=${decision.verdict} advances=${decision.advances}` }
})

addCase('(#79g) smelt whose furnace consumed input+fuel is verified even with no count increase (OR clause)', async () => {
  const { outcome } = await runSmeltFixture({ produce: false, consumeSlots: true, timeoutMs: 0 })
  const pass =
    outcome.gained === 0 &&
    outcome.consumedInput === true &&
    outcome.consumedFuel === true &&
    isSmeltPostconditionMet(outcome) === true
  return {
    pass,
    detail: `gained=${outcome.gained} consumedInput=${outcome.consumedInput} consumedFuel=${outcome.consumedFuel}`,
  }
})

addCase('(#79h) place that did not create the block is unverified; the block at the target is verified', () => {
  const missing = isPlacePostconditionMet(null, 'furnace')
  const wrong = isPlacePostconditionMet('cobblestone', 'furnace')
  const atTarget = isPlacePostconditionMet('furnace', 'furnace')
  const bogus = decideActionOutcome({
    kind: 'PLACE',
    status: 'done',
    verified: missing,
    itemsGained: 0,
    blockRemoved: false,
    planId: 'g41:place:furnace',
    actionId: 'PLACE:furnace:p31_61_35',
    strategy: 'llm:place',
    attempts: 2,
  })
  const line = bogus.unverifiedLine ?? ''
  const real = decideActionOutcome({
    kind: 'PLACE',
    status: 'done',
    verified: atTarget,
    itemsGained: 0,
    blockRemoved: false,
    planId: 'g41:place:furnace',
    actionId: 'PLACE:furnace:p31_61_35',
    strategy: 'llm:place',
    attempts: 1,
  })
  const pass =
    missing === false &&
    wrong === false &&
    atTarget === true &&
    bogus.verdict === 'unverified' &&
    bogus.advances === false &&
    line.includes('attempts=2') &&
    line.includes('postcondition=block exists at the target') &&
    real.verdict === 'verified' &&
    real.advances === true
  return { pass, detail: `missing=${missing} wrong=${wrong} atTarget=${atTarget} | ${line}` }
})

addCase('(V2) a climb chunk that gained altitude is durable progress even with blockRemoved=false', () => {
  const chunk = { itemsGained: 0, blockRemoved: false, progressed: true }
  const durable = hasObservableProgress(chunk)
  const zero = isZeroProgressOutcome(chunk)
  const downgraded = isUnverifiedOutcome({
    kind: 'RETRIEVE',
    status: 'done',
    verified: true,
    ...chunk,
  })
  const pass = durable === true && zero === false && downgraded === false
  return { pass, detail: `hasObservableProgress=${durable} zero=${zero} unverified=${downgraded}` }
})

addCase('(V2) an unverified zero-delta MOVE is not progress, so it is never success', () => {
  const noChange = { itemsGained: 0, blockRemoved: false, progressed: false }
  const durable = hasObservableProgress(noChange)
  const zero = isZeroProgressOutcome(noChange)
  const downgraded = isUnverifiedOutcome({
    kind: 'MOVE',
    status: 'done',
    verified: false,
    ...noChange,
  })
  const pass = durable === false && zero === true && downgraded === true
  return { pass, detail: `hasObservableProgress=${durable} zero=${zero} unverified=${downgraded}` }
})

let failures = 0
process.stdout.write('action post-conditions (#79): unverified zero-progress actions are failures\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = await testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} action-verify cases passed\n`)
if (failures > 0) process.exit(1)
