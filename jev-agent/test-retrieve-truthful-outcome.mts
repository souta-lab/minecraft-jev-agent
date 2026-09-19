// test-retrieve-truthful-outcome.mts - the primary M2 runtime boundary: an
// unreached RETRIEVE must not be reported as success and must not reset the
// coordinate failure memory.
//
// Live evidence (frozen R, RC 42cb46e, target 36,56,41):
//
//   RETRIEVE:known:raw_iron:b36_56_41 arrival targetDistance=11.26m->11.25m
//     y=59.5->58 vertical=reuse
//   CAUSAL ... verified=true status=done progressDelta=0
//   MOVE_FAILMEM_RESET key=overworld:36,56,41 reason=reached
//
// while PATH_CALLBACK stayed `outcome=stuck`, the inventory never gained
// raw_iron, and HOP_PLAN / JUMP_ATTEMPT looped. The remaining distance to the
// target did NOT shrink; only the vertical gap moved.
//
// Run: npm run retrieve-truthful-outcome-test
import { classifyRetrieveOutcome } from './src/executor.ts'
import type { RetrieveOutcomeInput, RetrieveOutcome } from './src/executor.ts'
import { decideRetrieveMemory } from './src/controller.ts'
import { MoveFailMemory, moveFailureKey } from './src/moveFailMemory.ts'
import { describeActionPostcondition, hasObservableProgress, truthfulActionOutcome } from './src/actionPostcondition.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

const OVERWORLD = 'overworld'
const LIVE_TARGET = { x: 36, y: 56, z: 41 }

/** The frozen-R shape: 11.26m -> 11.25m, y 59.5 -> 58, vertical=reuse. */
const LIVE_NUDGE: RetrieveOutcomeInput = {
  before: 11.26,
  after: 11.25,
  verticalStep: true,
  verticalProgress: true,
}

/** The pre-fix executor formula, reproduced verbatim for the regression record. */
function legacyVerified(input: RetrieveOutcomeInput): boolean {
  const closed = input.after < input.before - 0.01
  return closed || input.verticalProgress || input.verticalStep
}

function executorResult(outcome: RetrieveOutcome) {
  return {
    status: 'done' as const,
    verified: outcome.verified,
    itemsGained: 0,
    blockRemoved: false,
    progressed: outcome.progressed,
  }
}

addCase('the live non-closing nudge is NOT a completed retrieve', () => {
  const outcome = classifyRetrieveOutcome(LIVE_NUDGE)
  const pass =
    outcome.closed === false &&
    outcome.verified === false &&
    outcome.progressed === true &&
    legacyVerified(LIVE_NUDGE) === true
  return {
    pass,
    detail: `closed=${outcome.closed} verified=${outcome.verified} progressed=${outcome.progressed} legacyVerified=${legacyVerified(LIVE_NUDGE)}`,
  }
})

addCase('the live non-closing nudge does NOT reset the move-failure memory', () => {
  const result = executorResult(classifyRetrieveOutcome(LIVE_NUDGE))
  const memory = decideRetrieveMemory(result)
  const pass = memory.reset === false && memory.charge === false && hasObservableProgress(result) === true
  return {
    pass,
    detail: `reset=${memory.reset} charge=${memory.charge} observableProgress=${hasObservableProgress(result)}`,
  }
})

addCase('the positive control: a retrieve that closes the distance IS success and resets', () => {
  const input: RetrieveOutcomeInput = { before: 11.26, after: 10.3, verticalStep: true, verticalProgress: true }
  const outcome = classifyRetrieveOutcome(input)
  const memory = decideRetrieveMemory(executorResult(outcome))
  const pass = outcome.closed === true && outcome.verified === true && outcome.progressed === true && memory.reset === true
  return {
    pass,
    detail: `closed=${outcome.closed} verified=${outcome.verified} progressed=${outcome.progressed} reset=${memory.reset}`,
  }
})

addCase('a vertical chunk without a distance decrease is progress, never completion', () => {
  const outcome = classifyRetrieveOutcome({ before: 12.4, after: 12.4, verticalStep: true, verticalProgress: true })
  const memory = decideRetrieveMemory(executorResult(outcome))
  const pass = outcome.verified === false && outcome.progressed === true && memory.reset === false
  return { pass, detail: `verified=${outcome.verified} progressed=${outcome.progressed} reset=${memory.reset}` }
})

addCase('a retrieve that moves AWAY from the target is never verified', () => {
  const outcome = classifyRetrieveOutcome({ before: 11.26, after: 11.6, verticalStep: false, verticalProgress: false })
  const pass = outcome.closed === false && outcome.verified === false && outcome.progressed === false
  return { pass, detail: `closed=${outcome.closed} verified=${outcome.verified} progressed=${outcome.progressed}` }
})

addCase('INVARIANT: verified implies the remaining distance actually decreased', () => {
  const fixtures: RetrieveOutcomeInput[] = [
    { before: 11.26, after: 11.25, verticalStep: true, verticalProgress: true },
    { before: 11.26, after: 11.26, verticalStep: true, verticalProgress: true },
    { before: 11.26, after: 11.27, verticalStep: false, verticalProgress: true },
    { before: 11.26, after: 9.9, verticalStep: false, verticalProgress: true },
    { before: 11.26, after: 12.4, verticalStep: false, verticalProgress: false },
  ]
  const violations = fixtures.filter((input) => {
    const outcome = classifyRetrieveOutcome(input)
    return outcome.verified && !outcome.closed
  })
  return { pass: violations.length === 0, detail: `fixtures=${fixtures.length} violations=${violations.length}` }
})

addCase('three non-closing retrieves never reset the live coordinate and it is blacklisted', () => {
  let clock = 1_000
  const memory = new MoveFailMemory({ failureLimit: 3, cooldownMs: 30_000, maxEntries: 16, now: () => clock })
  const result = executorResult(classifyRetrieveOutcome(LIVE_NUDGE))
  let resets = 0
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const decision = decideRetrieveMemory(result)
    if (decision.reset) {
      resets += 1
      memory.reset(OVERWORLD, LIVE_TARGET)
    } else {
      memory.record(OVERWORLD, LIVE_TARGET, 'no_progress')
    }
    clock += 1
  }
  const check = memory.check(OVERWORLD, LIVE_TARGET)
  const pass = resets === 0 && check.attempts === 3 && check.blacklisted
  return {
    pass,
    detail: `key=${moveFailureKey(OVERWORLD, LIVE_TARGET)} resets=${resets} attempts=${check.attempts} blacklisted=${check.blacklisted}`,
  }
})

addCase('a completed retrieve resets the coordinate so it stays selectable', () => {
  const memory = new MoveFailMemory({ failureLimit: 3, cooldownMs: 30_000, maxEntries: 16, now: () => 1_000 })
  memory.record(OVERWORLD, LIVE_TARGET, 'no_progress')
  memory.record(OVERWORLD, LIVE_TARGET, 'no_progress')
  const input: RetrieveOutcomeInput = { before: 11.26, after: 10.3, verticalStep: true, verticalProgress: true }
  const decision = decideRetrieveMemory(executorResult(classifyRetrieveOutcome(input)))
  if (decision.reset) memory.reset(OVERWORLD, LIVE_TARGET)
  const check = memory.check(OVERWORLD, LIVE_TARGET)
  const pass = decision.reset === true && check.known === false
  return { pass, detail: `reset=${decision.reset} known=${check.known}` }
})

addCase('a done zero-progress retrieve still charges the coordinate (#78 loop)', () => {
  const decision = decideRetrieveMemory({ status: 'done', verified: false, itemsGained: 0, blockRemoved: false, progressed: false })
  const pass = decision.reset === false && decision.charge === true
  return { pass, detail: `reset=${decision.reset} charge=${decision.charge}` }
})

addCase('the declared RETRIEVE post-condition names the distance decrease, not a staircase step', () => {
  const postcondition = describeActionPostcondition('RETRIEVE')
  const pass = postcondition.includes('remaining distance to the target decreased') && !postcondition.includes('staircase step')
  return { pass, detail: postcondition }
})

addCase('the truth layer rejects a progressed-only RETRIEVE (no closure, no arrival)', () => {
  const truth = truthfulActionOutcome({
    kind: 'RETRIEVE',
    status: 'done',
    verified: true,
    itemsGained: 0,
    blockRemoved: false,
    progressed: true,
    arrived: false,
  })
  const pass =
    truth.verified === false &&
    truth.observableProgress === false &&
    truth.status === 'unreached' &&
    truth.resetsFailureMemory === false &&
    truth.replanProgress === true
  return {
    pass,
    detail: `verified=${truth.verified} observable=${truth.observableProgress} status=${truth.status} reset=${truth.resetsFailureMemory} replan=${truth.replanProgress}`,
  }
})

addCase('the truth layer accepts a RETRIEVE with a measured distance closure', () => {
  const truth = truthfulActionOutcome({
    kind: 'RETRIEVE',
    status: 'done',
    verified: true,
    itemsGained: 0,
    blockRemoved: false,
    progressed: true,
    arrived: false,
    distanceClosed: true,
  })
  const pass = truth.verified === true && truth.status === 'done' && truth.resetsFailureMemory === true
  return { pass, detail: `verified=${truth.verified} status=${truth.status} reset=${truth.resetsFailureMemory}` }
})

let failures = 0
process.stdout.write('truthful retrieve outcome: unreached retrieve is not success and does not reset failure memory\n')
process.stdout.write('-'.repeat(96) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(96) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} retrieve-truthful-outcome cases passed\n`)

if (failures > 0) {
  process.exit(1)
}
