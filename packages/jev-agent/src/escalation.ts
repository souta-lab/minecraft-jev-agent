// Escalation contract extracted from controller.ts: the typed reasons a
// Jev decision epoch escalates to System2, and the Jev -> LLM summon bridge.
// Pure contract data; no authority ownership.

import type { LlmSummonReason } from './system2/service.ts'

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

import type { EventLogger } from './jev.ts'
import type { DecisionLlmResummonLog } from './decisionlog.ts'
import type { GoalQueue } from './goalQueue.ts'
import type { GoalState, AgentSignals } from './state.ts'
import type { JevAgentOptions } from './controller-shared.ts'

/**
 * Escalation bookkeeping plane: the cooldown-gated typed escalation emit and
 * the objective-complete terminal escalation. No authority moves — the System2
 * wake still crosses host.summonLlm and goal completion still crosses
 * host.finish.
 */
export interface EscalationHost {
  readonly lastEscalationAt: Map<EscalationReason, number>
  lastEscalationMs: number
  readonly escalations: EscalationReason[]
  signals: AgentSignals
  readonly queue: Pick<GoalQueue, 'markProgress' | 'state'>
  readonly goal: GoalState
  logger: EventLogger
  options: Pick<JevAgentOptions, 'escalationCooldownMs' | 'finishOnObjectiveComplete'>
  readonly tickCounter: number
  finish(reason: string, success: boolean): void
  summonLlm(reason: LlmSummonReason, detail: string): DecisionLlmResummonLog | null
}

export function onObjectiveComplete(host: EscalationHost): void {
  host.queue.markProgress(host.goal.haveCount)
  host.escalations.push('goal_complete')
  host.signals.escalationRecommended = true
  const queueState = host.queue.state
  host.logger.warn(
    'system2',
    `objective complete: ${host.goal.description}; goal queue depth=${queueState.depth} current=${queueState.current?.description ?? 'none'}`,
    { queueDepth: queueState.depth, currentGoal: queueState.current?.description ?? null },
    host.tickCounter,
  )
  if (host.options.finishOnObjectiveComplete) {
    host.finish('goal-complete', true)
    return
  }
  host.summonLlm('queue_empty', 'objective complete; the queue needs its next horizon')
}

export function escalate(host: EscalationHost, reason: EscalationReason, detail: string): void {
  const now = Date.now()
  const last = host.lastEscalationAt.get(reason) ?? 0
  if (now - last < host.options.escalationCooldownMs) return
  host.lastEscalationAt.set(reason, now)
  host.lastEscalationMs = now
  host.escalations.push(reason)
  host.signals.escalationRecommended = true
  const summonReason = ESCALATION_TO_SUMMON[reason]
  host.logger.warn(
    'escalate',
    `-> System 2: reason=${reason} summon=${summonReason} detail=${detail}`,
    { reason, summonReason, detail },
    host.tickCounter,
  )
  host.summonLlm(summonReason, `${reason}: ${detail}`)
}
