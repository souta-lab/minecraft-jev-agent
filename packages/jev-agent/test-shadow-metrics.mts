// test-shadow-metrics.mts - issue #360 §9: SHADOW_METRICS were invariant.
//
// Measured live (m3-live `run.jsonl`, 2026-09-21T12:46:21.695Z ->
// 2026-09-21T13:34:50.960Z): all 2148 `SHADOW_METRICS` records were EXACTLY
//
//   goal_progress=4 plan_still_valid=4 situation_understood=4 goal_blocked=0
//   strategy_change_needed=0
//
// over 48.5 min with 0 `goal`/`0` search progress and 401
// `OSCILLATION_DETECTED`.
//
// Traced cause: `goal_progress` read the legacy item-count fraction
// (`state.goal.progress` was 1 because the live `g2:surface:log` plan already
// held its 1 log while the body sat at y=67 and `complete` stayed false), and
// the other three read `signals.escalationRecommended`, which this body-only
// loop never set. See `src/shadowMetrics.ts` for the full trace.
import assert from 'node:assert/strict'
import { computeShadowMetrics } from './src/shadowMetrics.ts'
import type { StrategicStallEvidence } from './src/strategicStall.ts'

const exhausted: StrategicStallEvidence = {
  optionInstanceId: 'g2:surface:log',
  windowSize: 24,
  distinctStates: 3,
  bodyProgressDecisions: 24,
  semanticProgressDecisions: 0,
  horizon: 24,
  maxDistinctStates: 3,
  exhausted: true,
  exhaustedRepeats: 0,
}

/** The exact live state: active surface plan at y=67, item part already held. */
const livePlan = {
  goal: { progress: 1, complete: false },
  goalQueue: { empty: false },
}

// 1. The live freeze can no longer log the all-good row.
const stalled = computeShadowMetrics({
  ...livePlan,
  signals: { escalationRecommended: false, strategicNonProgress: exhausted },
})
assert.notDeepEqual(stalled, {
  goal_progress: 4,
  plan_still_valid: 4,
  situation_understood: 4,
  goal_blocked: 0,
  strategy_change_needed: 0,
})
assert.equal(stalled.goal_progress, 0)
assert.equal(stalled.plan_still_valid, 1)
assert.equal(stalled.goal_blocked, 1)
assert.equal(stalled.strategy_change_needed, 1)

// 2. An actually-complete plan still reports complete.
const complete = computeShadowMetrics({
  goal: { progress: 1, complete: true },
  goalQueue: { empty: false },
  signals: { escalationRecommended: false, strategicNonProgress: null },
})
assert.equal(complete.goal_progress, 4)
assert.equal(complete.plan_still_valid, 4)
assert.equal(complete.goal_blocked, 0)

// 3. A productive in-flight plan reports its real fraction, not a constant.
const productive = computeShadowMetrics({
  goal: { progress: 0.5, complete: false },
  goalQueue: { empty: false },
  signals: { escalationRecommended: false, strategicNonProgress: { ...exhausted, exhausted: false, windowSize: 4 } },
})
assert.equal(productive.goal_progress, 2)
assert.equal(productive.plan_still_valid, 4)
assert.equal(productive.goal_blocked, 0)

// 4. Evidence changes move the rows: the exact invariance regression.
const rows = [
  { evidence: null, escalating: false },
  { evidence: { ...exhausted, exhausted: false }, escalating: false },
  { evidence: exhausted, escalating: false },
  { evidence: null, escalating: true },
].map((input) =>
  JSON.stringify(
    computeShadowMetrics({
      ...livePlan,
      signals: { escalationRecommended: input.escalating, strategicNonProgress: input.evidence },
    }),
  ),
)
assert.equal(new Set(rows).size, 3)
assert.ok(rows[0] !== rows[3])

// 5. An empty queue is still the one situation-comprehension gap.
const emptyQueue = computeShadowMetrics({
  goal: { progress: 0, complete: false },
  goalQueue: { empty: true },
  signals: { escalationRecommended: false, strategicNonProgress: null },
})
assert.equal(emptyQueue.situation_understood, 2)

process.stdout.write('shadow metrics evidence-sensitivity (#360 §9): PASS\n')
