// shadowMetrics.ts - issue #360 §9: the demoted score heads are telemetry only,
// but they must not contradict reality.
//
// Measured live (m3-live, `run.jsonl`, 2026-09-21T12:46:21.695Z ->
// 2026-09-21T13:34:50.960Z): all 2148 `SHADOW_METRICS` records were EXACTLY
//
//   goal_progress=4 plan_still_valid=4 situation_understood=4 goal_blocked=0
//   strategy_change_needed=0
//
// over 48.5 minutes with 0 `goal`/0 `search` progress and 401
// `OSCILLATION_DETECTED`. The values were not merely stable: they were
// behaviourally impossible.
//
// Traced cause (two independent sources, both in controller.ts):
//
//   1. `goal_progress` came from the legacy scalar `state.goal.progress`
//      (`Math.round(state.goal.progress * 4)`). `GoalState.progress` is only the
//      ITEM-COUNT fraction (`state.ts` `refreshGoalProgress`:
//      `progress = min(1, haveCount / requiredCount)`). The live active plan was
//      `{id: g2:surface:log, requiredCount: 1, haveCount: 4, progress: 1,
//      complete: false, targetY: 86}` while the body sat at y=67, so the item
//      fraction was already 1 (-> 4) even though the plan's real success
//      predicate (`levelAtLeast y>=86` AND the log) was unmet. The metric was
//      measuring an unrelated completed sub-count, not the active plan.
//   2. `plan_still_valid` / `goal_blocked` / `strategy_change_needed` were pure
//      functions of `signals.escalationRecommended`, which the WAIT/failure/
//      suppressed-replan triggers never set in this loop (successful body MOVEs
//      reset `lastProgressAt` and the action-failure streak). With that flag
//      false, three of the five fields were constants by construction, and
//      `situation_understood` only varied on an EMPTY queue.
//
// The fix keeps them shadow-only (they still steer nothing) but sources them
// from the active plan's own completion plus the code-owned state-recurrence
// evidence (`strategicStall.ts`), so they change when the evidence changes.
import type { StrategicStallEvidence } from './strategicStall.ts'

/** Only the fields the shadow heads may read; structurally typed so it stays pure. */
export interface ShadowMetricInput {
  goal: { progress: number; complete: boolean }
  goalQueue: { empty: boolean }
  signals: {
    escalationRecommended: boolean
    strategicNonProgress?: StrategicStallEvidence | null
  }
}

function scaled(progress: number): number {
  if (!Number.isFinite(progress)) return 0
  return Math.max(0, Math.min(4, Math.round(progress * 4)))
}

/**
 * The demoted semantic questions, computed by code and logged (never steering).
 *
 * `goal_progress` now reports the ACTIVE plan's progress: 4 only when the plan's
 * own success predicate is complete; 0 when the code-owned recurrence evidence
 * proves the recent window was body-only non-progress; otherwise the item-count
 * fraction as before. `plan_still_valid` / `goal_blocked` /
 * `strategy_change_needed` also read that evidence, so an unproductive Option
 * can no longer log an identical "all good" row forever.
 */
export function computeShadowMetrics(input: ShadowMetricInput): Record<string, number> {
  const escalating = input.signals.escalationRecommended === true
  const recurring = input.signals.strategicNonProgress?.exhausted === true
  const stalled = escalating || recurring
  return {
    goal_progress: input.goal.complete ? 4 : recurring ? 0 : scaled(input.goal.progress),
    plan_still_valid: stalled ? 1 : 4,
    situation_understood: input.goalQueue.empty && !input.goal.complete ? 2 : 4,
    goal_blocked: stalled ? 1 : 0,
    strategy_change_needed: stalled ? 1 : 0,
  }
}
