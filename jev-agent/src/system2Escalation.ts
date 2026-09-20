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
