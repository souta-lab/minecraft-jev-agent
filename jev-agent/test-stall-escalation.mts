// test-stall-escalation.mts - issue #78: bound the local-recovery WAIT loop.
//
// The live defect: a stall classified `boundary=local_recovery` was held open
// for ~5 minutes of WAIT actions. System2 was correctly not woken (a local
// actuator failure is not a new WHAT), but the ONLY local recovery was a
// replan, and `REPLAN_THROTTLED ... because=no_new_info` suppressed it for as
// long as the fingerprint stayed unchanged - which, with only WAIT actions, is
// forever. Nothing owned "the local recovery itself is making no progress".
//
// These cases are pure-policy (no bot, injected clock):
//   (a) a stall whose fingerprint never changes escalates after N cycles;
//   (b) a stall whose fingerprint changes before N does NOT escalate, and the
//       counter restarts so the same scenario must re-accumulate N;
//   (c) an ordinary throttled churn case is unchanged (still refused, still the
//       same REPLAN_THROTTLED line, no escalation).
import {
  formatLocalRecoveryExhausted,
  formatLocalRecoveryNoProgress,
  formatReplanThrottled,
  hashReplanInputs,
  LOCAL_RECOVERY_EXHAUSTED_MARKER,
  LOCAL_RECOVERY_NO_PROGRESS_MARKER,
  ReplanThrottle,
  REPLAN_NO_INFO_ESCALATE_CYCLES_DEFAULT,
  resolveReplanNoInfoEscalateCycles,
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

/** The live stall shape: smelting iron, standing still, only WAIT outcomes. */
const STALL_GOAL = 'smelt:iron_ingot:1'

const inputs = (over: Partial<ReplanInputs> = {}): ReplanInputs => ({
  inventory: { oak_log: 2, cobblestone: 27 },
  position: { x: 29, y: 60, z: 34 },
  knownResources: 128,
  failureSignature: 'WAIT:no_progress',
  capabilityGap: null,
  goalKey: STALL_GOAL,
  ...over,
})

addCase('(a) an unchanged fingerprint escalates on exactly the Nth zero-progress cycle', () => {
  const throttle = new ReplanThrottle(10_000, 2, 3)
  throttle.tryReplan('no_progress', inputs(), 1_000)
  const c1 = throttle.tryReplan('no_progress', inputs(), 2_000)
  const c2 = throttle.tryReplan('no_progress', inputs(), 3_000)
  const c3 = throttle.tryReplan('no_progress', inputs(), 4_000)
  return {
    pass:
      !c1.allow &&
      c1.kind === 'no_new_info' &&
      c1.noInfoStreak === 1 &&
      !c2.allow &&
      c2.noInfoStreak === 2 &&
      c3.allow &&
      c3.kind === 'exhausted' &&
      c3.noInfoStreak === 3 &&
      c3.noInfoLimit === 3,
    detail: `c1=${JSON.stringify(c1)} c2=${JSON.stringify(c2)} c3=${JSON.stringify(c3)}`,
  }
})

addCase('(a) the default bound N=6 refuses five times and escalates on the sixth', () => {
  const throttle = new ReplanThrottle(10_000, 2)
  throttle.tryReplan('no_progress', inputs(), 1_000)
  const refusals: number[] = []
  let escalatedKind: string | null = null
  for (let cycle = 1; cycle <= REPLAN_NO_INFO_ESCALATE_CYCLES_DEFAULT; cycle += 1) {
    const decision = throttle.tryReplan('no_progress', inputs(), 1_000 + cycle)
    if (decision.allow) escalatedKind = decision.kind
    else refusals.push(decision.noInfoStreak)
  }
  return {
    pass:
      REPLAN_NO_INFO_ESCALATE_CYCLES_DEFAULT === 6 &&
      refusals.join(',') === '1,2,3,4,5' &&
      escalatedKind === 'exhausted',
    detail: `N=${REPLAN_NO_INFO_ESCALATE_CYCLES_DEFAULT} refusals=${refusals.join(',')} escalated=${escalatedKind}`,
  }
})

addCase('(b) a fingerprint change before N does not escalate and restarts the counter', () => {
  const throttle = new ReplanThrottle(0, 2, 3)
  throttle.tryReplan('no_progress', inputs(), 1_000)
  const c1 = throttle.tryReplan('no_progress', inputs(), 2_000)
  const c2 = throttle.tryReplan('no_progress', inputs(), 3_000)
  // Position moved beyond the 2-block threshold: real body progress / new info.
  const changed = throttle.tryReplan('no_progress', inputs({ position: { x: 40, y: 60, z: 34 } }), 4_000)
  const restart = throttle.tryReplan('no_progress', inputs({ position: { x: 40, y: 60, z: 34 } }), 5_000)
  return {
    pass:
      !c1.allow &&
      !c2.allow &&
      c2.noInfoStreak === 2 &&
      changed.allow &&
      changed.kind === 'new_info' &&
      !restart.allow &&
      restart.noInfoStreak === 1,
    detail: `c2=${JSON.stringify(c2)} changed=${JSON.stringify(changed)} restart=${JSON.stringify(restart)}`,
  }
})

addCase('(b) a changed goal is new information and never escalates the old streak', () => {
  const throttle = new ReplanThrottle(0, 2, 3)
  throttle.tryReplan('no_progress', inputs(), 1_000)
  throttle.tryReplan('no_progress', inputs(), 2_000)
  throttle.tryReplan('no_progress', inputs(), 3_000)
  const otherGoal = throttle.tryReplan('no_progress', inputs({ goalKey: 'collect:diamond:3' }), 4_000)
  return {
    pass: otherGoal.allow && otherGoal.kind === 'new_info',
    detail: JSON.stringify(otherGoal),
  }
})

addCase('(b) new information inside the window resets the streak without escalating', () => {
  const throttle = new ReplanThrottle(10_000, 2, 3)
  throttle.tryReplan('no_progress', inputs(), 1_000)
  throttle.tryReplan('no_progress', inputs(), 2_000)
  throttle.tryReplan('no_progress', inputs(), 3_000)
  // Inventory gained inside the window: new info, refused by the window bound,
  // but it is NOT a zero-progress cycle and must reset the counter.
  const windowRefusal = throttle.tryReplan('no_progress', inputs({ inventory: { oak_log: 3 } }), 4_000)
  const after = throttle.tryReplan('no_progress', inputs(), 5_000)
  return {
    pass:
      !windowRefusal.allow &&
      windowRefusal.kind === 'window' &&
      windowRefusal.noInfoStreak === 0 &&
      !after.allow &&
      after.kind === 'no_new_info' &&
      after.noInfoStreak === 1,
    detail: `window=${JSON.stringify(windowRefusal)} after=${JSON.stringify(after)}`,
  }
})

addCase('(c) ordinary throttled churn is unchanged: refused, same REPLAN_THROTTLED line, no escalation', () => {
  const throttle = new ReplanThrottle(10_000, 2, 6)
  throttle.tryReplan('no_progress', inputs(), 1_000)
  const refused = throttle.tryReplan('no_progress', inputs(), 4_000)
  return {
    pass:
      !refused.allow &&
      refused.kind === 'no_new_info' &&
      refused.noInfoStreak === 1 &&
      formatReplanThrottled('no_progress', refused) === 'REPLAN_THROTTLED reason=no_progress ageMs=3000 -> reuse plan',
    detail: `${JSON.stringify(refused)} line=${formatReplanThrottled('no_progress', refused)}`,
  }
})

addCase('the counter and escalation markers are greppable and exact', () => {
  const throttle = new ReplanThrottle(10_000, 2, 3)
  throttle.tryReplan('no_progress', inputs(), 1_000)
  const refused = throttle.tryReplan('no_progress', inputs(), 2_000)
  const hash = hashReplanInputs(inputs())
  const counterLine = formatLocalRecoveryNoProgress(STALL_GOAL, 'no_progress', refused)
  throttle.tryReplan('no_progress', inputs(), 3_000)
  const exhausted = throttle.tryReplan('no_progress', inputs(), 4_000)
  const escalationLine = formatLocalRecoveryExhausted(STALL_GOAL, 'no_progress', exhausted)
  return {
    pass:
      counterLine ===
        `${LOCAL_RECOVERY_NO_PROGRESS_MARKER} count=1/3 goal=${STALL_GOAL} reason=no_progress stateHash=${hash}` &&
      escalationLine ===
        `${LOCAL_RECOVERY_EXHAUSTED_MARKER} count=3/3 goal=${STALL_GOAL} reason=no_progress stateHash=${hash} -> wake System2`,
    detail: `counter=${counterLine} escalation=${escalationLine}`,
  }
})

addCase('the pure check() never advances the counter', () => {
  const throttle = new ReplanThrottle(10_000, 2, 3)
  throttle.tryReplan('no_progress', inputs(), 1_000)
  const first = throttle.check('no_progress', inputs(), 2_000)
  const second = throttle.check('no_progress', inputs(), 3_000)
  const counted = throttle.tryReplan('no_progress', inputs(), 4_000)
  return {
    pass: first.noInfoStreak === 0 && second.noInfoStreak === 0 && counted.noInfoStreak === 1,
    detail: `check=${first.noInfoStreak}/${second.noInfoStreak} tryReplan=${counted.noInfoStreak}`,
  }
})

addCase('different summon reasons own separate streaks', () => {
  const throttle = new ReplanThrottle(10_000, 2, 3)
  throttle.tryReplan('no_progress', inputs(), 1_000)
  throttle.tryReplan('action_impossible', inputs(), 2_000)
  const a = throttle.tryReplan('no_progress', inputs(), 3_000)
  const b = throttle.tryReplan('action_impossible', inputs(), 4_000)
  return {
    pass: a.noInfoStreak === 1 && b.noInfoStreak === 1 && !a.allow && !b.allow,
    detail: `no_progress=${JSON.stringify(a)} action_impossible=${JSON.stringify(b)}`,
  }
})

addCase('escalation is bounded, not a hot loop: the counter restarts after it fires', () => {
  const throttle = new ReplanThrottle(10_000, 2, 2)
  throttle.tryReplan('no_progress', inputs(), 1_000)
  const c1 = throttle.tryReplan('no_progress', inputs(), 2_000)
  const escalated = throttle.tryReplan('no_progress', inputs(), 3_000)
  const after = throttle.tryReplan('no_progress', inputs(), 4_000)
  return {
    pass:
      !c1.allow &&
      escalated.allow &&
      escalated.kind === 'exhausted' &&
      !after.allow &&
      after.noInfoStreak === 1,
    detail: `c1=${JSON.stringify(c1)} escalated=${JSON.stringify(escalated)} after=${JSON.stringify(after)}`,
  }
})

addCase('a capability gap still defeats no_new_info and never reaches escalation', () => {
  const throttle = new ReplanThrottle(0, 2, 2)
  throttle.record('no_progress', inputs(), 1_000)
  const gap = inputs({ capabilityGap: 'ascend_blocked:67' })
  const first = throttle.tryReplan('no_progress', gap, 2_000)
  const second = throttle.tryReplan('no_progress', gap, 3_000)
  return {
    pass: first.allow && first.kind === 'new_info' && second.allow && second.kind === 'new_info',
    detail: `first=${JSON.stringify(first)} second=${JSON.stringify(second)}`,
  }
})

addCase('the escalation bound resolves from env with safe defaults', () => {
  const defaults = resolveReplanNoInfoEscalateCycles({}) === REPLAN_NO_INFO_ESCALATE_CYCLES_DEFAULT
  const override = resolveReplanNoInfoEscalateCycles({ BUDDY_REPLAN_NO_INFO_ESCALATE_CYCLES: '3' }) === 3
  const invalid = resolveReplanNoInfoEscalateCycles({ BUDDY_REPLAN_NO_INFO_ESCALATE_CYCLES: 'nope' }) === REPLAN_NO_INFO_ESCALATE_CYCLES_DEFAULT
  const zero = resolveReplanNoInfoEscalateCycles({ BUDDY_REPLAN_NO_INFO_ESCALATE_CYCLES: '0' }) === REPLAN_NO_INFO_ESCALATE_CYCLES_DEFAULT
  const fractional =
    resolveReplanNoInfoEscalateCycles({ BUDDY_REPLAN_NO_INFO_ESCALATE_CYCLES: '2.5' }) === REPLAN_NO_INFO_ESCALATE_CYCLES_DEFAULT
  const hashed = hashReplanInputs(inputs()) === hashReplanInputs(inputs())
  return {
    pass: defaults && override && invalid && zero && fractional && hashed,
    detail: `defaults=${defaults} override=${override} invalid=${invalid} zero=${zero} fractional=${fractional}`,
  }
})

let failures = 0
process.stdout.write('stall escalation: bounded local-recovery transition (#78)\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} stall-escalation cases passed\n`)
if (failures > 0) process.exit(1)
