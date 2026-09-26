// test-mercury-trigger-backoff.mts - owning-package fixture for the pure
// `wait_limit` trigger backoff in `src/system2Escalation.ts`.
//
// Live defect (source `44a65ca`, m3-live): the counter-shaped `wait_limit`
// trigger re-fired for ONE unchanged stall until 18 of the 20 hourly Mercury
// calls were gone, then `FATAL ... budget_exhausted` stopped the resident:
//
//   MERCURY_ATTEMPT trigger histogram: wait_limit=18, action_impossible=2, no_progress=1
//
// The gate is pure and clock-injected; the durable orchestration lives in
// `buddy-driver/mercury-system2.ts`. These cases pin the policy itself:
//   (a) repeats on the same stall back off instead of costing one call each;
//   (b) progress (new authority epoch), a changed stall key, or a restarted WAIT
//       run re-arm immediately, so a genuinely new stall still wakes Mercury.
import {
  evaluateMercuryWaitLimitBackoff,
  mercuryWaitLimitBackoffDelayMs,
  MERCURY_WAIT_LIMIT_BACKOFF_BASE_MS_DEFAULT,
  MERCURY_WAIT_LIMIT_BACKOFF_MAX_MS_DEFAULT,
  resolveMercuryWaitLimitBackoffBaseMs,
  resolveMercuryWaitLimitBackoffMaxMs,
} from './src/system2/escalation.ts'
import type { MercuryWaitLimitBackoffState } from './src/system2/escalation.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}
const cases: Case[] = []
function addCase(name: string, run: Case['run']): void {
  cases.push({ name, run })
}

const BASE = MERCURY_WAIT_LIMIT_BACKOFF_BASE_MS_DEFAULT
const MAX = MERCURY_WAIT_LIMIT_BACKOFF_MAX_MS_DEFAULT
const KEY = 'goto:raw_iron|objective:raw_iron:1'

addCase('(a) repeats on one unchanged stall cost one ask, not N', () => {
  let state: MercuryWaitLimitBackoffState | null = null
  const now = 1_700_000_000_000
  let allowed = 0
  for (let i = 0; i < 6; i += 1) {
    const decision = evaluateMercuryWaitLimitBackoff(state, {
      stallKey: KEY,
      waitStreak: 8,
      authorityEpoch: 0,
      now,
      baseMs: BASE,
      maxMs: MAX,
    })
    state = decision.state
    if (decision.allow) allowed += 1
  }
  return { pass: allowed === 1, detail: `allowed=${allowed}/6 (was 6 before the gate)` }
})

addCase('(a) the wait grows exponentially and is capped', () => {
  const delays = [1, 2, 3, 4].map((n) => mercuryWaitLimitBackoffDelayMs(n, BASE, MAX))
  return {
    pass: delays[0] === BASE && delays[1] === 2 * BASE && delays[2] === 4 * BASE && delays[3] === MAX && mercuryWaitLimitBackoffDelayMs(99, BASE, MAX) === MAX,
    detail: delays.join(',') + ` cap=${mercuryWaitLimitBackoffDelayMs(99, BASE, MAX)}`,
  }
})

addCase('(a) a suppressed repeat reports the remaining wait', () => {
  const now = 1_700_000_000_000
  const first = evaluateMercuryWaitLimitBackoff(null, { stallKey: KEY, waitStreak: 3, authorityEpoch: 0, now, baseMs: BASE, maxMs: MAX })
  const parked = evaluateMercuryWaitLimitBackoff(first.state, { stallKey: KEY, waitStreak: 4, authorityEpoch: 0, now: now + 1000, baseMs: BASE, maxMs: MAX })
  return {
    pass: !parked.allow && parked.reason === 'unchanged_stall' && parked.waitMs === BASE - 1000 && parked.consecutiveNoPlan === 1,
    detail: `allow=${parked.allow} reason=${parked.reason} waitMs=${parked.waitMs} consecutiveNoPlan=${parked.consecutiveNoPlan}`,
  }
})

addCase('(b) progress re-arms immediately', () => {
  const now = 1_700_000_000_000
  const first = evaluateMercuryWaitLimitBackoff(null, { stallKey: KEY, waitStreak: 3, authorityEpoch: 4, now, baseMs: BASE, maxMs: MAX })
  const decision = evaluateMercuryWaitLimitBackoff(first.state, { stallKey: KEY, waitStreak: 3, authorityEpoch: 5, now: now + 1, baseMs: BASE, maxMs: MAX })
  return { pass: decision.allow && decision.reason === 'progress', detail: `allow=${decision.allow} reason=${decision.reason}` }
})

addCase('(b) a changed stall key re-arms immediately', () => {
  const now = 1_700_000_000_000
  const first = evaluateMercuryWaitLimitBackoff(null, { stallKey: KEY, waitStreak: 3, authorityEpoch: 0, now, baseMs: BASE, maxMs: MAX })
  const decision = evaluateMercuryWaitLimitBackoff(first.state, { stallKey: 'explore:cave|objective:raw_iron:1', waitStreak: 3, authorityEpoch: 0, now: now + 1, baseMs: BASE, maxMs: MAX })
  return { pass: decision.allow && decision.reason === 'fresh_stall', detail: `allow=${decision.allow} reason=${decision.reason}` }
})

addCase('(b) a restarted WAIT run re-arms immediately', () => {
  const now = 1_700_000_000_000
  const first = evaluateMercuryWaitLimitBackoff(null, { stallKey: KEY, waitStreak: 8, authorityEpoch: 0, now, baseMs: BASE, maxMs: MAX })
  const decision = evaluateMercuryWaitLimitBackoff(first.state, { stallKey: KEY, waitStreak: 3, authorityEpoch: 0, now: now + 1, baseMs: BASE, maxMs: MAX })
  return { pass: decision.allow, detail: `allow=${decision.allow} reason=${decision.reason} waitMs=${decision.waitMs}` }
})

addCase('baseMs=0 disables the time gate (explicit, test-only escape)', () => {
  let state: MercuryWaitLimitBackoffState | null = null
  let allowed = 0
  for (let i = 0; i < 4; i += 1) {
    const decision = evaluateMercuryWaitLimitBackoff(state, { stallKey: KEY, waitStreak: 3, authorityEpoch: 0, now: 1000, baseMs: 0, maxMs: 0 })
    state = decision.state
    if (decision.allow) allowed += 1
  }
  return { pass: allowed === 4, detail: `allowed=${allowed}/4` }
})

addCase('env overrides resolve with safe fallbacks', () => {
  const override = resolveMercuryWaitLimitBackoffBaseMs({ BUDDY_MERCURY_WAIT_LIMIT_BACKOFF_BASE_MS: '1234' })
  const bad = resolveMercuryWaitLimitBackoffBaseMs({ BUDDY_MERCURY_WAIT_LIMIT_BACKOFF_BASE_MS: 'nope' })
  const badMax = resolveMercuryWaitLimitBackoffMaxMs({ BUDDY_MERCURY_WAIT_LIMIT_BACKOFF_MAX_MS: '-5' })
  const maxOverride = resolveMercuryWaitLimitBackoffMaxMs({ BUDDY_MERCURY_WAIT_LIMIT_BACKOFF_MAX_MS: '5000' })
  return {
    pass: override === 1234 && bad === BASE && badMax === MAX && maxOverride === 5000,
    detail: `override=${override} bad=${bad} badMax=${badMax} maxOverride=${maxOverride}`,
  }
})

let failures = 0
process.stdout.write('Mercury wait_limit trigger backoff (pure policy)\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} trigger-backoff cases passed\n`)
if (failures > 0) process.exit(1)
