// test-truth-causal.mts - truthful success/failure for ANY action.
//
// LIVE DEFECT (main 42cb46e, run-mu8l9a1j-uugz):
//
//   16:15:27.292 RETRIEVE:known:raw_iron:b36_56_41 timeout
//   16:15:31.379 PATH_CALLBACK outcome=stuck
//   ... HOP_PLAN / JUMP_ATTEMPT recovery loop ...
//   CAUSAL verified=true status=done progressDelta=0
//
// The executor's RETRIEVE sets `verified=true` from a LENIENT signal (any
// distance decrease > 0.01 m - `closed`), so a stuck hop toward an unreachable
// remembered resource was recorded as a verified SUCCESS with zero observable
// progress. The same zero-progress outcome also resets the failure counters, so
// the loop never settles.
//
// Invariants proven here, all pure (no bot, no network, no model):
//   A. no causal outcome may report `verified=true status=done` without
//      observable progress (an item, a removed block, a deterministic body
//      change, an arrival, or a kind whose strict post-condition is itself the
//      world evidence);
//   B. a zero-progress outcome may not reset failure memory;
//   C. `moveFailureReason` never records a timeout / unrelated action error as
//      the durable `unreachable` claim.
//
// bun run truth-causal-test
import {
  hasObservableProgress,
  truthfulActionOutcome,
} from './src/actionPostcondition.ts'
import type { TruthfulOutcomeInput } from './src/actionPostcondition.ts'
import { completeCausalChain, formatCausalLine } from './src/causal.ts'
import { moveFailureReason } from './src/controller.ts'
import { MoveFailMemory, moveFailureKey } from './src/moveFailMemory.ts'
import { OptionAttemptTracker } from './src/abandonPolicy.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

const OVERWORLD = 'overworld'

/** The live stuck-retrieve shape: done, verified, but nothing changed at all. */
const LIVE_NUDGE: TruthfulOutcomeInput = {
  kind: 'RETRIEVE',
  status: 'done',
  verified: true,
  itemsGained: 0,
  blockRemoved: false,
  progressed: false,
  arrived: false,
}

addCase('A. the live stuck RETRIEVE nudge is not verified success (zero observable progress)', () => {
  const truth = truthfulActionOutcome(LIVE_NUDGE)
  const pass =
    truth.verified === false &&
    truth.status === 'zero_progress' &&
    truth.observableProgress === false &&
    truth.downgraded === true
  return { pass, detail: `verified=${truth.verified} status=${truth.status} observable=${truth.observableProgress} downgraded=${truth.downgraded}` }
})

addCase('A. a truthful causal line can never show verified=true status=done for that nudge', () => {
  const truth = truthfulActionOutcome(LIVE_NUDGE)
  const chain = completeCausalChain(
    { chainId: 'c-live', optionId: 'collect:raw_iron', planId: 'g3:collect:raw_iron', strategy: 'llm:collect' },
    {
      candidateId: 'RETRIEVE:known:raw_iron:b36_56_41',
      actionId: 'RETRIEVE:known:raw_iron:b36_56_41',
      verified: truth.verified,
      status: truth.status,
      resource: 'raw_iron',
      progressDelta: 0,
    },
  )
  const line = formatCausalLine(chain)
  const liar = line.includes('verified=true') && line.includes('status=done')
  const pass = !liar && line.includes('verified=false') && line.includes('status=zero_progress')
  return { pass, detail: line }
})

addCase('A. a genuine MOVE arrival (body displaced) stays a verified success', () => {
  const truth = truthfulActionOutcome({
    kind: 'MOVE',
    status: 'done',
    verified: true,
    itemsGained: 0,
    blockRemoved: false,
    progressed: false,
    arrived: true,
  })
  const pass = truth.verified === true && truth.status === 'done' && truth.observableProgress === true && truth.downgraded === false
  return { pass, detail: `verified=${truth.verified} status=${truth.status} observable=${truth.observableProgress}` }
})

addCase('A. a verified climb chunk (progressed=true, no closure) is UNREACHED, never verified', () => {
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
    truth.status === 'unreached' &&
    truth.observableProgress === false &&
    truth.resetsFailureMemory === false &&
    truth.replanProgress === true &&
    truth.downgraded === true
  return {
    pass,
    detail: `verified=${truth.verified} status=${truth.status} observable=${truth.observableProgress} reset=${truth.resetsFailureMemory} replan=${truth.replanProgress}`,
  }
})

addCase('A. a RETRIEVE that actually arrives is a verified success and may reset the memory', () => {
  const truth = truthfulActionOutcome({
    kind: 'RETRIEVE',
    status: 'done',
    verified: true,
    itemsGained: 0,
    blockRemoved: false,
    progressed: false,
    arrived: true,
  })
  const pass =
    truth.verified === true &&
    truth.status === 'done' &&
    truth.observableProgress === true &&
    truth.resetsFailureMemory === true &&
    truth.downgraded === false
  return { pass, detail: `verified=${truth.verified} status=${truth.status} reset=${truth.resetsFailureMemory}` }
})

addCase('A. a RETRIEVE with a measured distance closure is a verified success', () => {
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
  const pass =
    truth.verified === true &&
    truth.status === 'done' &&
    truth.resetsFailureMemory === true &&
    truth.replanProgress === false &&
    truth.downgraded === false
  return { pass, detail: `verified=${truth.verified} status=${truth.status} reset=${truth.resetsFailureMemory}` }
})

addCase('A. strict-post-condition kinds (PLACE/SMELT) are not over-downgraded', () => {
  const place = truthfulActionOutcome({
    kind: 'PLACE',
    status: 'done',
    verified: true,
    itemsGained: 0,
    blockRemoved: false,
    progressed: false,
    arrived: false,
  })
  const smelt = truthfulActionOutcome({
    kind: 'SMELT',
    status: 'done',
    verified: true,
    itemsGained: 0,
    blockRemoved: false,
    progressed: false,
    arrived: false,
  })
  const pass = place.verified === true && place.status === 'done' && smelt.verified === true && smelt.status === 'done'
  return { pass, detail: `place=${place.verified}/${place.status} smelt=${smelt.verified}/${smelt.status}` }
})

addCase('A. INVARIANT: any verified=true status=done outcome has observable progress', () => {
  const fixtures: TruthfulOutcomeInput[] = [
    LIVE_NUDGE,
    { kind: 'MOVE', status: 'done', verified: true, itemsGained: 0, blockRemoved: false, progressed: false, arrived: true },
    { kind: 'MOVE', status: 'done', verified: true, itemsGained: 0, blockRemoved: false, progressed: false, arrived: false },
    { kind: 'PLACE', status: 'done', verified: true, itemsGained: 0, blockRemoved: false, progressed: false, arrived: false },
    { kind: 'SMELT', status: 'done', verified: true, itemsGained: 0, blockRemoved: false, progressed: false, arrived: false },
    { kind: 'MINE', status: 'done', verified: true, itemsGained: 1, blockRemoved: true, progressed: false, arrived: false },
    { kind: 'RETRIEVE', status: 'done', verified: true, itemsGained: 0, blockRemoved: true, progressed: false, arrived: false },
    { kind: 'RETRIEVE', status: 'done', verified: false, itemsGained: 0, blockRemoved: false, progressed: false, arrived: false },
    { kind: 'DESCEND', status: 'failed', verified: false, itemsGained: 0, blockRemoved: false, progressed: false, arrived: false },
  ]
  const violations = fixtures.filter((f) => truthfulActionOutcome(f).verified === true && truthfulActionOutcome(f).status === 'done' && truthfulActionOutcome(f).observableProgress === false)
  const pass = violations.length === 0
  return { pass, detail: `fixtures=${fixtures.length} violations=${violations.length}` }
})

addCase('B. a zero-progress outcome keeps the move-failure memory charged (no reset)', () => {
  let clock = 1_000
  const memory = new MoveFailMemory({ failureLimit: 3, cooldownMs: 30_000, maxEntries: 16, now: () => clock })
  const target = { x: 36, y: 56, z: 41 }
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const truth = truthfulActionOutcome(LIVE_NUDGE)
    if (truth.observableProgress) memory.reset(OVERWORLD, target)
    else memory.record(OVERWORLD, target, 'no_progress')
    clock += 1
  }
  const check = memory.check(OVERWORLD, target)
  const pass = check.blacklisted && check.attempts === 3 && check.lastReason === 'no_progress'
  return { pass, detail: `key=${moveFailureKey(OVERWORLD, target)} attempts=${check.attempts} blacklisted=${check.blacklisted} reason=${check.lastReason}` }
})

addCase('B. a real MOVE arrival DOES reset the memory so the coordinate stays selectable', () => {
  const memory = new MoveFailMemory({ failureLimit: 3, cooldownMs: 30_000, maxEntries: 16, now: () => 1_000 })
  const target = { x: 36, y: 56, z: 41 }
  memory.record(OVERWORLD, target, 'no_progress')
  memory.record(OVERWORLD, target, 'no_progress')
  const truth = truthfulActionOutcome({
    kind: 'MOVE',
    status: 'done',
    verified: true,
    itemsGained: 0,
    blockRemoved: false,
    progressed: false,
    arrived: true,
  })
  if (truth.observableProgress) memory.reset(OVERWORLD, target)
  const check = memory.check(OVERWORLD, target)
  const pass = truth.observableProgress === true && !check.known
  return { pass, detail: `observable=${truth.observableProgress} known=${check.known}` }
})

addCase('B. a downgraded zero-progress outcome charges the per-option unproductive counter', () => {
  const tracker = new OptionAttemptTracker()
  tracker.noteOutcome({ optionId: 'collect:raw_iron', planId: 'g3:collect:raw_iron', verified: true, progressDelta: 0 }, 1_000)
  const truth = truthfulActionOutcome(LIVE_NUDGE)
  const state = tracker.noteOutcome(
    { optionId: 'collect:raw_iron', planId: 'g3:collect:raw_iron', verified: truth.verified, progressDelta: 0 },
    2_000,
  )
  const pass = truth.verified === false && state.attempts === 1
  return { pass, detail: `attempts=${state.attempts} verified=${state.verified} progressDelta=${state.progressDelta}` }
})

addCase('C. moveFailureReason maps timeouts to stuck, never the durable unreachable claim', () => {
  const dig = moveFailureReason('dig_timeout')
  const smelt = moveFailureReason('smelt_timeout')
  const pathTimeout = moveFailureReason('path_timeout')
  const pathStuck = moveFailureReason('path_stuck')
  const noPath = moveFailureReason('path_no_path')
  const pass =
    dig === 'stuck' &&
    smelt === 'stuck' &&
    pathTimeout === 'stuck' &&
    pathStuck === 'stuck' &&
    noPath === 'no_path'
  return { pass, detail: `dig_timeout=${dig} smelt_timeout=${smelt} path_timeout=${pathTimeout} path_stuck=${pathStuck} path_no_path=${noPath}` }
})

addCase('C. unknown / unrelated failures do not default to unreachable', () => {
  const absent = moveFailureReason(null)
  const verify = moveFailureReason('verify_failed')
  const unknown = moveFailureReason('unknown_event')
  const targetGone = moveFailureReason('target_gone')
  const pass =
    absent !== 'unreachable' &&
    verify !== 'unreachable' &&
    unknown !== 'unreachable' &&
    targetGone !== 'unreachable'
  return { pass, detail: `null=${absent} verify_failed=${verify} unknown_event=${unknown} target_gone=${targetGone}` }
})

addCase('C. an explicit no-path still records the durable unreachable claim', () => {
  const pass = moveFailureReason('path_no_path') === 'no_path' && moveFailureReason('tunnel_entry_refused') === 'unreachable'
  return { pass, detail: `path_no_path=${moveFailureReason('path_no_path')} tunnel_entry_refused=${moveFailureReason('tunnel_entry_refused')}` }
})

addCase('C. hasObservableProgress stays the single evidence boundary', () => {
  const nudge = { itemsGained: 0, blockRemoved: false, progressed: false }
  const item = { itemsGained: 1, blockRemoved: false, progressed: false }
  const block = { itemsGained: 0, blockRemoved: true, progressed: false }
  const chunk = { itemsGained: 0, blockRemoved: false, progressed: true }
  const pass =
    hasObservableProgress(nudge) === false &&
    hasObservableProgress(item) === true &&
    hasObservableProgress(block) === true &&
    hasObservableProgress(chunk) === true
  return { pass, detail: `nudge=${hasObservableProgress(nudge)} item=${hasObservableProgress(item)} block=${hasObservableProgress(block)} chunk=${hasObservableProgress(chunk)}` }
})

let failures = 0
process.stdout.write('truthful success/failure for ANY action (causal + move-failure reason)\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} truth-causal cases passed\n`)
if (failures > 0) process.exit(1)
