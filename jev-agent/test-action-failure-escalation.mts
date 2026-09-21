// test-action-failure-escalation.mts - issue #78 follow-up: bound the loop where
// the SAME plan is re-offered and its action keeps failing with the SAME typed
// reason.
//
// The live defect (run-muaxgdyk-15kc9): `SMELT:iron_ingot reason=stuck
// attempts=81` kept being re-offered after a typed `path_stuck` callback. The
// #44/#78 replan throttle never advanced because the loop is NOT a throttled
// replan (`grep -c LOCAL_RECOVERY_NO_PROGRESS` over the whole run was 0): local
// route failures are deliberately held `local_recovery` and excluded from
// `same_failure_3x`, so no counter owned the repetition.
//
// These cases are pure-policy (no bot, injected clock):
//   (a) the same action failing identically N times escalates at exactly N;
//   (b) a different plan / action / reason resets the counter;
//   (c) observed progress resets the counter;
//   (d) ordinary single failures are unchanged (still local, no escalation);
//   (e) the #78 replan-throttle counter stays separate and its release path is
//       the one that carries the action-failure exhaustion to System2.
import {
  ACTION_FAILURE_ESCALATE_CYCLES_DEFAULT,
  ACTION_FAILURE_EXHAUSTED_MARKER,
  ACTION_FAILURE_REPEAT_MARKER,
  actionFailureKey,
  ActionFailureEscalation,
  formatActionFailureExhausted,
  formatActionFailureRepeat,
  formatLocalRecoveryNoProgress,
  hashReplanInputs,
  LOCAL_RECOVERY_NO_PROGRESS_MARKER,
  ReplanThrottle,
  REPLAN_NO_INFO_ESCALATE_CYCLES_DEFAULT,
  replanInputsChanged,
  resolveActionFailureEscalateCycles,
} from './src/replanThrottle.ts'
import type { ReplanInputs } from './src/replanThrottle.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

/** The live stall shape: the same smelt action keeps path_stuck-ing. */
const PLAN = 'g2:smelt:iron_ingot'
const ACTION = 'SMELT:iron_ingot'
const REASON = 'path_stuck'

const stallInputs = (over: Partial<ReplanInputs> = {}): ReplanInputs => ({
  inventory: { oak_log: 2, cobblestone: 27 },
  position: { x: 29, y: 60, z: 34 },
  knownResources: 128,
  failureSignature: 'SMELT:iron_ingot:failed:path_stuck',
  capabilityGap: null,
  goalKey: 'smelt:iron_ingot:1',
  ...over,
})

addCase('(a) the same action failing identically escalates on exactly the Nth failure', () => {
  const counter = new ActionFailureEscalation(3)
  const first = counter.noteFailure(PLAN, ACTION, REASON)
  const second = counter.noteFailure(PLAN, ACTION, REASON)
  const third = counter.noteFailure(PLAN, ACTION, REASON)
  return {
    pass:
      !first.escalate &&
      first.count === 1 &&
      !second.escalate &&
      second.count === 2 &&
      third.escalate &&
      third.count === 3 &&
      third.limit === 3,
    detail: `${JSON.stringify(first)} ${JSON.stringify(second)} ${JSON.stringify(third)}`,
  }
})

addCase('(a) the default bound N=6 stays local for five failures and escalates on the sixth', () => {
  const counter = new ActionFailureEscalation()
  const counts: number[] = []
  let escalatedAt: number | null = null
  for (let cycle = 1; cycle <= ACTION_FAILURE_ESCALATE_CYCLES_DEFAULT; cycle += 1) {
    const decision = counter.noteFailure(PLAN, ACTION, REASON)
    counts.push(decision.count)
    if (decision.escalate) escalatedAt = decision.count
  }
  return {
    pass:
      ACTION_FAILURE_ESCALATE_CYCLES_DEFAULT === 6 &&
      counts.join(',') === '1,2,3,4,5,6' &&
      escalatedAt === 6,
    detail: `N=${ACTION_FAILURE_ESCALATE_CYCLES_DEFAULT} counts=${counts.join(',')} escalatedAt=${escalatedAt}`,
  }
})

addCase('(a) the Nth failure publishes a pending escalation fingerprint, earlier ones do not', () => {
  const counter = new ActionFailureEscalation(2)
  const first = counter.noteFailure(PLAN, ACTION, REASON)
  const pendingBefore = counter.pendingEscalation()
  const countAfterFirst = counter.count()
  const second = counter.noteFailure(PLAN, ACTION, REASON)
  const pendingAfter = counter.pendingEscalation()
  return {
    pass:
      pendingBefore === null &&
      countAfterFirst === 1 &&
      second.escalate &&
      pendingAfter !== null &&
      pendingAfter.count === 2 &&
      counter.pendingKey() === actionFailureKey(PLAN, ACTION, REASON),
    detail: `first=${JSON.stringify(first)} pendingBefore=${JSON.stringify(pendingBefore)} pendingAfter=${JSON.stringify(pendingAfter)} key=${counter.pendingKey()}`,
  }
})

addCase('(b) a different action resets the counter', () => {
  const counter = new ActionFailureEscalation(3)
  counter.noteFailure(PLAN, ACTION, REASON)
  const second = counter.noteFailure(PLAN, ACTION, REASON)
  const otherAction = counter.noteFailure(PLAN, 'CRAFT:iron_pickaxe', REASON)
  return {
    pass: second.count === 2 && otherAction.count === 1 && !otherAction.escalate,
    detail: `second=${second.count} other=${JSON.stringify(otherAction)}`,
  }
})

addCase('(b) a different failure reason resets the counter', () => {
  const counter = new ActionFailureEscalation(3)
  counter.noteFailure(PLAN, ACTION, REASON)
  const second = counter.noteFailure(PLAN, ACTION, REASON)
  const otherReason = counter.noteFailure(PLAN, ACTION, 'verify_failed')
  return {
    pass: second.count === 2 && otherReason.count === 1 && !otherReason.escalate,
    detail: `second=${second.count} other=${JSON.stringify(otherReason)}`,
  }
})

addCase('(b) a different plan/goal resets the counter', () => {
  const counter = new ActionFailureEscalation(3)
  counter.noteFailure(PLAN, ACTION, REASON)
  const second = counter.noteFailure(PLAN, ACTION, REASON)
  const otherPlan = counter.noteFailure('g2:craft:iron_pickaxe', ACTION, REASON)
  return {
    pass: second.count === 2 && otherPlan.count === 1 && !otherPlan.escalate,
    detail: `second=${second.count} other=${JSON.stringify(otherPlan)}`,
  }
})

addCase('(c) observed progress resets the counter and clears a pending escalation', () => {
  const counter = new ActionFailureEscalation(2)
  counter.noteFailure(PLAN, ACTION, REASON)
  const escalated = counter.noteFailure(PLAN, ACTION, REASON)
  counter.reset()
  const afterProgress = counter.noteFailure(PLAN, ACTION, REASON)
  return {
    pass:
      escalated.escalate &&
      counter.pendingEscalation() === null &&
      counter.pendingKey() === null &&
      counter.count() === 1 &&
      afterProgress.count === 1 &&
      !afterProgress.escalate,
    detail: `escalated=${escalated.count} afterProgress=${JSON.stringify(afterProgress)}`,
  }
})

addCase('(d) ordinary single failures stay local: count=1, no escalation, marker is exact', () => {
  const counter = new ActionFailureEscalation(6)
  const decision = counter.noteFailure(PLAN, ACTION, REASON)
  const line = formatActionFailureRepeat(decision)
  return {
    pass:
      !decision.escalate &&
      decision.count === 1 &&
      decision.limit === 6 &&
      counter.pendingEscalation() === null &&
      line === `${ACTION_FAILURE_REPEAT_MARKER} count=1/6 plan=${PLAN} action=${ACTION} reason=${REASON}`,
    detail: `${line} pending=${JSON.stringify(counter.pendingEscalation())}`,
  }
})

addCase('(d) escalation is bounded, not a hot loop: the streak restarts after it fires', () => {
  const counter = new ActionFailureEscalation(2)
  const c1 = counter.noteFailure(PLAN, ACTION, REASON)
  const escalated = counter.noteFailure(PLAN, ACTION, REASON)
  const after = counter.noteFailure(PLAN, ACTION, REASON)
  return {
    pass:
      c1.count === 1 &&
      escalated.escalate &&
      after.count === 1 &&
      !after.escalate &&
      counter.pendingEscalation() === null,
    detail: `c1=${c1.count} escalated=${escalated.escalate} after=${JSON.stringify(after)}`,
  }
})

addCase('the counter and escalation markers are greppable and exact', () => {
  const counter = new ActionFailureEscalation(2)
  const refused = counter.noteFailure(PLAN, ACTION, REASON)
  const exhausted = counter.noteFailure(PLAN, ACTION, REASON)
  const counterLine = formatActionFailureRepeat(refused)
  const escalationLine = formatActionFailureExhausted(exhausted)
  return {
    pass:
      counterLine === `${ACTION_FAILURE_REPEAT_MARKER} count=1/2 plan=${PLAN} action=${ACTION} reason=${REASON}` &&
      escalationLine ===
        `${ACTION_FAILURE_EXHAUSTED_MARKER} count=2/2 plan=${PLAN} action=${ACTION} reason=${REASON} -> wake System2`,
    detail: `counter=${counterLine} escalation=${escalationLine}`,
  }
})

addCase('(e) the exhausted streak is new information for the #44 replan throttle', () => {
  const throttle = new ReplanThrottle(0, 2)
  const base = stallInputs()
  throttle.record('action_impossible', base, 1_000)
  // Same cheap world inputs: the throttle would re-suppress this as no_new_info.
  const suppressed = throttle.tryReplan('action_impossible', base, 2_000)
  const key = actionFailureKey(PLAN, ACTION, REASON)
  const released = throttle.tryReplan('action_impossible', stallInputs({ actionFailureExhausted: key }), 3_000)
  return {
    pass:
      !suppressed.allow &&
      suppressed.kind === 'no_new_info' &&
      released.allow &&
      released.kind === 'new_info',
    detail: `suppressed=${JSON.stringify(suppressed)} released=${JSON.stringify(released)}`,
  }
})

addCase('the exhausted fingerprint changes the replan state hash and the changed-inputs predicate', () => {
  const base = stallInputs()
  const key = actionFailureKey(PLAN, ACTION, REASON)
  const flagged = stallInputs({ actionFailureExhausted: key })
  return {
    pass:
      hashReplanInputs(base) !== hashReplanInputs(flagged) &&
      replanInputsChanged(base, flagged) &&
      !replanInputsChanged(flagged, stallInputs({ actionFailureExhausted: key })),
    detail: `base=${hashReplanInputs(base)} flagged=${hashReplanInputs(flagged)}`,
  }
})

addCase('(e) the #78 replan counter stays separate from the action-failure counter', () => {
  const throttle = new ReplanThrottle(10_000, 2, 3)
  const counter = new ActionFailureEscalation(3)
  throttle.tryReplan('no_progress', stallInputs(), 1_000)
  const noInfo1 = throttle.tryReplan('no_progress', stallInputs(), 2_000)
  const action1 = counter.noteFailure(PLAN, ACTION, REASON)
  const action2 = counter.noteFailure(PLAN, ACTION, REASON)
  const noInfo2 = throttle.tryReplan('no_progress', stallInputs(), 3_000)
  const noInfoLine = formatLocalRecoveryNoProgress('smelt:iron_ingot:1', 'no_progress', noInfo1)
  return {
    pass:
      noInfo1.noInfoStreak === 1 &&
      noInfo1.kind === 'no_new_info' &&
      noInfo2.noInfoStreak === 2 &&
      action1.count === 1 &&
      action2.count === 2 &&
      !action2.escalate &&
      noInfoLine.startsWith(`${LOCAL_RECOVERY_NO_PROGRESS_MARKER} count=1/3 goal=smelt:iron_ingot:1`) &&
      REPLAN_NO_INFO_ESCALATE_CYCLES_DEFAULT === 6,
    detail: `noInfo1=${noInfo1.noInfoStreak} noInfo2=${noInfo2.noInfoStreak} actions=${action1.count},${action2.count} line=${noInfoLine}`,
  }
})

addCase('the action-failure bound resolves from env with safe defaults', () => {
  const defaults = resolveActionFailureEscalateCycles({}) === ACTION_FAILURE_ESCALATE_CYCLES_DEFAULT
  const override = resolveActionFailureEscalateCycles({ BUDDY_ACTION_FAILURE_ESCALATE_CYCLES: '3' }) === 3
  const invalid =
    resolveActionFailureEscalateCycles({ BUDDY_ACTION_FAILURE_ESCALATE_CYCLES: 'nope' }) ===
    ACTION_FAILURE_ESCALATE_CYCLES_DEFAULT
  const zero =
    resolveActionFailureEscalateCycles({ BUDDY_ACTION_FAILURE_ESCALATE_CYCLES: '0' }) ===
    ACTION_FAILURE_ESCALATE_CYCLES_DEFAULT
  const fractional =
    resolveActionFailureEscalateCycles({ BUDDY_ACTION_FAILURE_ESCALATE_CYCLES: '2.5' }) ===
    ACTION_FAILURE_ESCALATE_CYCLES_DEFAULT
  const constructorGuard = new ActionFailureEscalation(0).noteFailure(PLAN, ACTION, REASON).limit ===
    ACTION_FAILURE_ESCALATE_CYCLES_DEFAULT
  return {
    pass: defaults && override && invalid && zero && fractional && constructorGuard,
    detail: `defaults=${defaults} override=${override} invalid=${invalid} zero=${zero} fractional=${fractional} constructorGuard=${constructorGuard}`,
  }
})

let failures = 0
process.stdout.write('action failure escalation: bounded typed-action-failure transition (#78 follow-up)\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} action-failure-escalation cases passed\n`)
if (failures > 0) process.exit(1)
