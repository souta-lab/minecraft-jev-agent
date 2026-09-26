// Escalation contract extracted from controller-legacy.ts: the typed reasons a
// Jev decision epoch escalates to System2, and the Jev -> LLM summon bridge.
// Pure contract data; no authority ownership.

import type { LlmSummonReason } from '../system2.ts'

export type EscalationReason =
  | 'low_confidence'
  | 'same_failure_3x'
  | 'pathfinder_no_path'
  | 'pathfinder_stuck'
  | 'progress_stall'
  | 'unexpected_world_state'
  | 'all_candidates_invalid'
  /**
   * Every grounded route for the active goal's target is spent (`ROUTE_ESCALATE
   * ... reason=all_routes_spent`) and no approach leg changes the stand cell.
   * This is a STRUCTURAL capability boundary, not a local path/stall signal:
   * code proved it can ground no route at all, so WHAT comes next belongs to
   * System2. It is deliberately NOT in the facade's `LOCAL_POLICY_ESCALATIONS`.
   */
  | 'route_exhausted'
  | 'goal_complete'
  | 'unknown_event'
  | 'policy_error'

/**
 * Which exception reason wakes System 2. This is the Jev -> LLM bridge: every
 * escalation the mechanical layer detects becomes one of the five documented
 * `LlmSummonReason`s (see system2.ts).
 */
export const ESCALATION_TO_SUMMON: Record<EscalationReason, LlmSummonReason> = {
  low_confidence: 'need_llm',
  same_failure_3x: 'action_impossible',
  pathfinder_no_path: 'action_impossible',
  pathfinder_stuck: 'action_impossible',
  progress_stall: 'no_progress',
  unexpected_world_state: 'unknown_situation',
  all_candidates_invalid: 'action_impossible',
  route_exhausted: 'action_impossible',
  goal_complete: 'queue_empty',
  unknown_event: 'unknown_situation',
  policy_error: 'unknown_situation',
}
