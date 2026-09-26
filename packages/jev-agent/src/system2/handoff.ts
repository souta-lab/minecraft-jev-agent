import type { DecisionLlmResummonLog } from '../decisionlog.ts'
import type { LlmSummonReason } from './service.ts'

export type System2HandoffResult =
  | {
      status: 'submitted'
      reason: LlmSummonReason
      detail: string
      requestId: string | null
    }
  | {
      status: 'unavailable'
      reason: LlmSummonReason
      detail: string
      blocker: string
    }

/**
 * Dispatch one explicit control-plane request to System2 and preserve the
 * controller's refusal as a typed outcome. This helper selects no replacement
 * Option; it only reports whether the WHAT authority was actually invoked.
 */
export function submitSystem2Handoff(
  input: { reason: LlmSummonReason; detail: string },
  summon: (reason: LlmSummonReason, detail: string) => DecisionLlmResummonLog | null,
): System2HandoffResult {
  const result = summon(input.reason, input.detail)
  if (result?.triggered === true) {
    return {
      status: 'submitted',
      reason: input.reason,
      detail: result.detail ?? input.detail,
      requestId: result.requestId ?? null,
    }
  }
  return {
    status: 'unavailable',
    reason: input.reason,
    detail: input.detail,
    blocker: result?.detail ?? 'controller_not_running',
  }
}
