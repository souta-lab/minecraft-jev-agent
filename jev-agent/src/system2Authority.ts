// system2Authority.ts - causal validity contract for asynchronous System2 plans.
//
// A System2 request is a read of semantic state, not a lease to mutate that
// state later.  The response may be applied only while the identity it read is
// still current.  This module is deliberately pure so the request/apply race is
// regression-tested without a Mineflayer connection or a model call.

export interface System2RequestContext {
  requestId: string
  queueRevision: number
  optionInstanceId: string | null
  optionTemplateId: string | null
  worldEpoch: number
  stateFingerprint: string
  authorityEpoch: number
}

export interface System2ApplyState {
  queueRevision: number
  optionInstanceId: string | null
  optionTemplateId: string | null
  worldEpoch: number
  stateFingerprint: string
  authorityEpoch: number
  /** An in-flight physical action owns the body; a plan must not replace it. */
  actionInFlight: boolean
}

export type System2DiscardReason =
  | 'queue_revision_changed'
  | 'option_instance_changed'
  | 'option_template_changed'
  | 'world_epoch_changed'
  | 'state_fingerprint_changed'
  | 'authority_epoch_changed'
  | 'action_in_flight'

export interface System2ApplyDecision {
  apply: boolean
  reasons: System2DiscardReason[]
}

/**
 * Prove that a response still describes the state it was requested against.
 * Every mismatch is retained in the result: a discard is evidence, and the
 * reason must not be hidden behind a generic "stale" label.
 */
export function evaluateSystem2Apply(
  request: System2RequestContext,
  current: System2ApplyState,
): System2ApplyDecision {
  const reasons: System2DiscardReason[] = []
  if (current.queueRevision !== request.queueRevision) reasons.push('queue_revision_changed')
  if (current.optionInstanceId !== request.optionInstanceId) reasons.push('option_instance_changed')
  if (current.optionTemplateId !== request.optionTemplateId) reasons.push('option_template_changed')
  if (current.worldEpoch !== request.worldEpoch) reasons.push('world_epoch_changed')
  if (current.stateFingerprint !== request.stateFingerprint) reasons.push('state_fingerprint_changed')
  if (current.authorityEpoch !== request.authorityEpoch) reasons.push('authority_epoch_changed')
  if (current.actionInFlight) reasons.push('action_in_flight')
  return { apply: reasons.length === 0, reasons }
}

export function formatSystem2Discard(request: System2RequestContext, reasons: readonly System2DiscardReason[]): string {
  return `SYSTEM2_PLAN_DISCARDED request=${request.requestId} reasons=${reasons.join(',') || 'unknown'}`
}
