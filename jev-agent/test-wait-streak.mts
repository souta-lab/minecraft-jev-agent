// test-wait-streak.mts - issue #327 follow-up: bound the chosen no-op WAIT while
// real actionable candidates exist.
//
// Live defect (source 449cedd / m3-live, planId=g3:collect:flint):
//
//   ACTION n=640..645 id=WAIT kind=WAIT phase=waiting      (six+ consecutive WAIT)
//   JEV_HEADS action=WAIT abandon=0.37 decision=continue
//   LOCAL_RECOVERY_NO_PROGRESS=0   LOCAL_RECOVERY_EXHAUSTED=0
//   ACTION_FAILURE_REPEAT=0        ACTION_FAILURE_EXHAUSTED=0
//   CANDIDATE_SET_DEGENERATE=0     (actionable >= 2: real candidates WERE offered)
//
// The policy model itself chose WAIT on every decision. No existing counter can
// see that loop: #44/#78 only advance on a suppressed replan, #337 only on a
// typed ACTION failure, and the #43 WAIT wedge requires an UNCHANGED fingerprint
// (the live junk inventory changes it every tick). These cases are pure.
//
// Authority invariant: this bounds the NO-OP only. It never says which real
// candidate should win.
import { readFileSync } from 'node:fs'
import {
  formatWaitExhausted,
  formatWaitStreak,
  hashReplanInputs,
  ReplanThrottle,
  replanInputsChanged,
  resolveWaitStreakEscalateCycles,
  WAIT_EXHAUSTED_MARKER,
  WAIT_STREAK_ESCALATE_CYCLES_DEFAULT,
  WAIT_STREAK_MARKER,
  WaitStreakEscalation,
} from './src/replanThrottle.ts'
import type { ReplanInputs } from './src/replanThrottle.ts'
import { MIRRORED_MARKERS } from './src/controller.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

const source = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8')
const GOAL = 'collect:flint:1'

const inputs = (over: Partial<ReplanInputs> = {}): ReplanInputs => ({
  inventory: { dirt: 191, leaf_litter: 128, cobblestone: 197 },
  position: { x: 127, y: 66, z: -10 },
  knownResources: 12,
  failureSignature: 'WAIT:waiting',
  capabilityGap: null,
  goalKey: GOAL,
  ...over,
})

// --- (a) N consecutive actionable WAITs escalate at exactly N ----------------

addCase('(a) N consecutive actionable WAITs escalate at exactly N, then restart', () => {
  const counter = new WaitStreakEscalation(3)
  const first = counter.noteChoice('WAIT', 2, GOAL)
  const second = counter.noteChoice('WAIT', 3, GOAL)
  const third = counter.noteChoice('WAIT', 2, GOAL)
  const clearedCount = counter.count()
  const after = counter.noteChoice('WAIT', 2, GOAL)
  return {
    pass:
      !first.escalate &&
      first.count === 1 &&
      !second.escalate &&
      second.count === 2 &&
      third.escalate &&
      third.count === 3 &&
      third.limit === 3 &&
      clearedCount === 0 &&
      !after.escalate &&
      after.count === 1,
    detail: `counts=${first.count},${second.count},${third.count} escalate@${third.count}/${third.limit} after=${after.count}`,
  }
})

addCase('(a) the pending exhaustion fingerprint is exposed for the replan gate', () => {
  const counter = new WaitStreakEscalation(2)
  counter.noteChoice('WAIT', 2, GOAL)
  const pendingBefore = counter.pendingKey()
  const third = counter.noteChoice('WAIT', 2, GOAL)
  return {
    pass:
      pendingBefore === null &&
      third.escalate &&
      counter.pendingKey() === `wait|${GOAL}|2` &&
      counter.pendingExhaustion()?.actionable === 2,
    detail: `before=${pendingBefore} after=${counter.pendingKey()}`,
  }
})

// --- (b) WAIT as the only option is NOT a degenerate streak ------------------

addCase('(b) WAIT with actionable=0 is never a streak and never escalates', () => {
  const counter = new WaitStreakEscalation(2)
  const decisions = Array.from({ length: 10 }, () => counter.noteChoice('WAIT', 0, GOAL))
  return {
    pass:
      decisions.every((decision) => !decision.escalate && decision.count === 0) &&
      counter.count() === 0 &&
      counter.pendingKey() === null,
    detail: `last=${JSON.stringify(decisions.at(-1))} pending=${counter.pendingKey()}`,
  }
})

addCase('(b) actionable=0 clears an existing streak instead of continuing it', () => {
  const counter = new WaitStreakEscalation(3)
  counter.noteChoice('WAIT', 4, GOAL)
  counter.noteChoice('WAIT', 4, GOAL)
  const starvation = counter.noteChoice('WAIT', 0, GOAL)
  const resumed = counter.noteChoice('WAIT', 4, GOAL)
  return {
    pass: !starvation.escalate && starvation.count === 0 && !resumed.escalate && resumed.count === 1,
    detail: `starvation=${starvation.count} resumed=${resumed.count}`,
  }
})

// --- (c) a real action / a new goal resets the counter ------------------------

addCase('(c) choosing a real action resets the actionable-WAIT streak', () => {
  const counter = new WaitStreakEscalation(3)
  counter.noteChoice('WAIT', 3, GOAL)
  counter.noteChoice('WAIT', 3, GOAL)
  const action = counter.noteChoice('DESCEND:level:W:b125_66_-10', 3, GOAL)
  const thenWait = counter.noteChoice('WAIT', 3, GOAL)
  return {
    pass:
      !action.escalate &&
      action.count === 0 &&
      !thenWait.escalate &&
      thenWait.count === 1 &&
      counter.pendingKey() === null,
    detail: `afterAction=${action.count} thenWait=${thenWait.count}`,
  }
})

addCase('(c) a different goal/plan resets the streak', () => {
  const counter = new WaitStreakEscalation(3)
  counter.noteChoice('WAIT', 3, GOAL)
  counter.noteChoice('WAIT', 3, GOAL)
  const otherGoal = counter.noteChoice('WAIT', 3, 'collect:obsidian:1')
  const back = counter.noteChoice('WAIT', 3, GOAL)
  return {
    pass: !otherGoal.escalate && otherGoal.count === 1 && !back.escalate && back.count === 1,
    detail: `other=${otherGoal.count} back=${back.count}`,
  }
})

// --- markers + env + replan integration ---------------------------------------

addCase('the WAIT markers carry the documented fields', () => {
  const decision = { escalate: true, count: 6, limit: 6, goalKey: GOAL, actionable: 2 }
  const streak = formatWaitStreak(decision)
  const exhausted = formatWaitExhausted(decision)
  return {
    pass:
      WAIT_STREAK_MARKER === 'WAIT_STREAK' &&
      WAIT_EXHAUSTED_MARKER === 'WAIT_EXHAUSTED' &&
      streak === `WAIT_STREAK count=6/6 goal=${GOAL} actionable=2` &&
      exhausted === `WAIT_EXHAUSTED count=6/6 goal=${GOAL} -> wake System2`,
    detail: `${streak} | ${exhausted}`,
  }
})

addCase('the WAIT bound resolves from env with safe defaults', () => {
  const defaults = resolveWaitStreakEscalateCycles({}) === WAIT_STREAK_ESCALATE_CYCLES_DEFAULT
  const override = resolveWaitStreakEscalateCycles({ BUDDY_WAIT_STREAK_ESCALATE_CYCLES: '3' }) === 3
  const invalid = resolveWaitStreakEscalateCycles({ BUDDY_WAIT_STREAK_ESCALATE_CYCLES: 'nope' }) === WAIT_STREAK_ESCALATE_CYCLES_DEFAULT
  const zero = resolveWaitStreakEscalateCycles({ BUDDY_WAIT_STREAK_ESCALATE_CYCLES: '0' }) === WAIT_STREAK_ESCALATE_CYCLES_DEFAULT
  return { pass: defaults && override && invalid && zero, detail: `defaults=${defaults} override=${override} invalid=${invalid} zero=${zero}` }
})

addCase('the exhausted WAIT streak is new information for the #44 replan throttle', () => {
  const throttle = new ReplanThrottle(0, 2)
  const base = inputs()
  throttle.record('no_progress', base, 1_000)
  const suppressed = throttle.tryReplan('no_progress', base, 2_000)
  const released = throttle.tryReplan('no_progress', inputs({ waitStreakExhausted: `wait|${GOAL}|6` }), 3_000)
  return {
    pass:
      !suppressed.allow &&
      suppressed.kind === 'no_new_info' &&
      released.allow &&
      released.kind === 'new_info',
    detail: `suppressed=${suppressed.kind} released=${released.kind}`,
  }
})

addCase('the exhausted WAIT fingerprint changes the replan hash and changed-inputs predicate', () => {
  const base = inputs()
  const flagged = inputs({ waitStreakExhausted: `wait|${GOAL}|6` })
  return {
    pass:
      hashReplanInputs(base) !== hashReplanInputs(flagged) &&
      replanInputsChanged(base, flagged) &&
      !replanInputsChanged(flagged, inputs({ waitStreakExhausted: `wait|${GOAL}|6` })),
    detail: `base=${hashReplanInputs(base)} flagged=${hashReplanInputs(flagged)}`,
  }
})

addCase('wiring: the controller bounds the actionable WAIT streak and mirrors the markers', () => {
  const text = source('./src/controller-legacy.ts')
  const queuePlaneText = source('./src/legacy/goal-queue-plane.ts')
  const missing = [
    'new WaitStreakEscalation(',
    'noteWaitStreak(',
    'this.waitSuppressed = true',
    'formatWaitExhausted(decision)',
    'waitStreakExhausted: this.waitStreakEscalation.pendingKey()',
  ].filter((needle) => !text.includes(needle) && !queuePlaneText.includes(needle.replace('this.', 'host.')))
  const mirrored = MIRRORED_MARKERS.has(WAIT_STREAK_MARKER) && MIRRORED_MARKERS.has(WAIT_EXHAUSTED_MARKER)
  return {
    pass: missing.length === 0 && mirrored,
    detail: missing.length === 0 ? `mirrored=${mirrored}` : `missing ${missing.join(', ')}`,
  }
})

let failures = 0
process.stdout.write('actionable-WAIT streak bound (#327 follow-up)\n')
process.stdout.write('-'.repeat(78) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(78) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} wait-streak cases passed\n`)

if (failures > 0) process.exit(1)
