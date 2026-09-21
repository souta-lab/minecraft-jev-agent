// test-hop-policy.mts - M2 heuristic audit: the vertical-hop timings and the
// hold-forward choice are a localized skill policy (`HopPolicy`) that logs
// `{ chosen, score, alternatives, reason }` once per hop.
//
// Pins behaviour equivalence with the audited executor constants
// (VERTICAL_HOP_RISE_MS=180, VERTICAL_HOP_PUSH_MS=260) and the truth rule
// hopHoldsForward (still re-exported from the executor).
//
//   bun run hop-policy-test
import { DEFAULT_HOP_POLICY, formatHopPlan, hopHoldsForward, planVerticalHop } from './src/hopPolicy.ts'
import { hopHoldsForward as executorHopHoldsForward } from './src/executor.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

addCase('the policy defaults are the audited harness recipe (rise 180ms, push 260ms)', () => {
  const pass = DEFAULT_HOP_POLICY.riseMs === 180 && DEFAULT_HOP_POLICY.pushMs === 260
  return { pass, detail: `riseMs=${DEFAULT_HOP_POLICY.riseMs} pushMs=${DEFAULT_HOP_POLICY.pushMs}` }
})

addCase('a free body holds forward through the jump and reports the rejected release', () => {
  const plan = planVerticalHop(false)
  const pass =
    plan.chosen === 'hold-forward' &&
    plan.holdForward === true &&
    plan.score === 1 &&
    plan.riseMs === 180 &&
    plan.pushMs === 260 &&
    plan.reason === 'free_body_holds_forward_through_jump' &&
    plan.alternatives[0]?.option === 'release-forward' &&
    (plan.alternatives[0]?.reason.includes('296/296') ?? false)
  return { pass, detail: formatHopPlan(plan) }
})

addCase('a pinned body releases forward for the pure jump and reports the packet rule', () => {
  const plan = planVerticalHop(true)
  const pass =
    plan.chosen === 'release-forward' &&
    plan.holdForward === false &&
    plan.reason === 'pinned_body_pure_vertical_jump' &&
    plan.alternatives[0]?.option === 'hold-forward' &&
    (plan.alternatives[0]?.reason.includes('server rejects') ?? false)
  return { pass, detail: formatHopPlan(plan) }
})

addCase('the truth rule hopHoldsForward is unchanged and still exported from the executor', () => {
  const pass =
    hopHoldsForward(false) === true &&
    hopHoldsForward(true) === false &&
    executorHopHoldsForward(false) === hopHoldsForward(false) &&
    executorHopHoldsForward(true) === hopHoldsForward(true)
  return { pass, detail: `free=${hopHoldsForward(false)} pinned=${hopHoldsForward(true)}` }
})

addCase('the policy object is injectable, so the timings can be tuned without touching the executor', () => {
  const plan = planVerticalHop(false, { riseMs: 111, pushMs: 222 })
  const pass = plan.riseMs === 111 && plan.pushMs === 222 && plan.holdForward === true
  return { pass, detail: formatHopPlan(plan) }
})

addCase('the HOP_PLAN line is one marker line with chosen, score, timings, alternatives and reason', () => {
  const line = formatHopPlan(planVerticalHop(true))
  const pass =
    line.startsWith('HOP_PLAN ') &&
    line.includes('chosen=release-forward') &&
    line.includes('score=1') &&
    line.includes('rise_ms=180') &&
    line.includes('push_ms=260') &&
    line.includes('alternatives=[hold-forward@1:') &&
    line.includes('reason=pinned_body_pure_vertical_jump')
  return { pass, detail: line }
})

let failures = 0
process.stdout.write('M2 heuristic audit - localized hop skill policy decisions\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} hop-policy cases passed\n`)

if (failures > 0) {
  process.exit(1)
}
