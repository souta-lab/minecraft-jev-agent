// test-action-verify.mts - Issue #79: an unverified zero-progress action is a
// FAILURE, never `done`; the same strategy is abandoned after N attempts and the
// ladder never advances on an unverified action. Pure: no bot, no network, no
// model. It also prints the exact ACTION_UNVERIFIED / ABANDON_REASON lines.
import {
  decideActionOutcome,
  describeActionPostcondition,
  evaluateUnverifiedBudget,
  formatActionUnverified,
  isUnverifiedOutcome,
  UNVERIFIED_ACTION_LIMIT,
} from './src/actionPostcondition.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

const PLAN_ID = 'g41:smelt:iron_ingot'
const STRATEGY = 'llm:smelt'

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

let failures = 0
process.stdout.write('action post-conditions (#79): unverified zero-progress actions are failures\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} action-verify cases passed\n`)
if (failures > 0) process.exit(1)
