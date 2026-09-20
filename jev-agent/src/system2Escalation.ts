// system2Escalation.ts - the semantic boundary between local recovery and System2.
//
// A path actuator failure is evidence for grounded Skills/Jev, not a new WHAT.
// System2 is woken only when the active semantic Option has crossed a lifecycle
// boundary: exhausted, invalid, or explicitly abandoned.

export interface System2WakeBoundaryInput {
  failureCode: string | null
  activeOption: boolean
  semanticExhausted: boolean
  semanticInvalid: boolean
  semanticAbandoned: boolean
}
export interface System2WakeBoundaryDecision {
  wake: boolean
  reason: 'semantic_boundary' | 'local_recovery' | 'no_active_option'
}

/** Compact typed evidence used at the Jev beta -> System2 boundary. */
export interface BetaOutcomeEvidence {
  actionId?: string | null
  failure?: string | null
  execution?: 'success' | 'failure' | 'cancelled' | 'control'
  verification?: 'verified' | 'unverified' | 'not_applicable'
  progress?: 'goal' | 'body' | 'search' | 'none'
  progressKinds?: readonly string[]
  control?: 'none' | 'wait' | 'escalate'
}

export interface BetaTerminationBoundaryInput {
  optionId: string | null
  requested: boolean
  /** The grounded pi choice made in the same decision as beta. */
  decisionActionId: string | null
  /** The most recent settled outcome, if any. */
  latestOutcome: BetaOutcomeEvidence | null
  /** Code-owned lifecycle facts; they never choose the replacement Option. */
  semanticExhausted: boolean
  semanticInvalid: boolean
}

export type BetaTerminationBoundaryReason =
  | 'no_current_option'
  | 'not_requested'
  | 'semantic_boundary'
  | 'control_action'
  | 'control_outcome'
  | 'body_or_search_progress'
  | 'local_recovery'
  | 'semantic_abandon'

export interface BetaTerminationBoundaryDecision {
  adopt: boolean
  wake: boolean
  reason: BetaTerminationBoundaryReason
}

const LOCAL_ROUTE_FAILURES = new Set(['path_no_path', 'path_stuck', 'no_path', 'no_standable_approach', 'open_path'])

export function shouldWakeSystem2AfterLocalFailure(input: System2WakeBoundaryInput): System2WakeBoundaryDecision {
  if (!input.activeOption) return { wake: false, reason: 'no_active_option' }
  if (input.semanticExhausted || input.semanticInvalid || input.semanticAbandoned) {
    return { wake: true, reason: 'semantic_boundary' }
  }
  if (input.failureCode !== null && LOCAL_ROUTE_FAILURES.has(input.failureCode)) {
    return { wake: false, reason: 'local_recovery' }
  }
  return { wake: false, reason: 'local_recovery' }
}

/**
 * Keep beta semantic, while refusing to reinterpret a control tick or a local
 * route/progress observation as semantic abandonment. This only proves whether
 * a beta vote may cross the lifecycle boundary; it never selects WHAT comes
 * next.
 */
export function evaluateBetaTerminationBoundary(
  input: BetaTerminationBoundaryInput,
): BetaTerminationBoundaryDecision {
  if (input.optionId === null || input.optionId.length === 0) {
    return { adopt: false, wake: false, reason: 'no_current_option' }
  }
  if (!input.requested) return { adopt: false, wake: false, reason: 'not_requested' }
  if (input.semanticExhausted || input.semanticInvalid) {
    return { adopt: true, wake: true, reason: 'semantic_boundary' }
  }
  if (input.decisionActionId === 'WAIT' || input.decisionActionId === 'ESCALATE') {
    return { adopt: false, wake: false, reason: 'control_action' }
  }

  const outcome = input.latestOutcome
  if (outcome?.control === 'wait' || outcome?.control === 'escalate' || outcome?.execution === 'control') {
    return { adopt: false, wake: false, reason: 'control_outcome' }
  }
  const progressKinds = new Set(outcome?.progressKinds ?? [])
  if (
    progressKinds.has('goal') ||
    progressKinds.has('body') ||
    progressKinds.has('search') ||
    outcome?.progress === 'goal' ||
    outcome?.progress === 'body' ||
    outcome?.progress === 'search'
  ) {
    return { adopt: false, wake: false, reason: 'body_or_search_progress' }
  }
  if (outcome?.failure !== null && outcome?.failure !== undefined && LOCAL_ROUTE_FAILURES.has(outcome.failure)) {
    return { adopt: false, wake: false, reason: 'local_recovery' }
  }
  return { adopt: true, wake: true, reason: 'semantic_abandon' }
}
