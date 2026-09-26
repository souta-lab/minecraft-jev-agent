// system2-harness/wakeReasons.ts - typed wake taxonomy + wake gating
// (#439 sections 9/29).
//
// The wake reason is part of the contract, not prompt flavor text. System2 is
// summoned only for explicit semantic reasons; local mechanical noise must not
// summon it.
//
// Explicitly NOT a wake reason (#439 section 9):
//   one local path failed
//   one PLACE was refused
//   Jev confidence was low once
//   WAIT happened twice
// Those are local policy/mechanical events unless they aggregate into a typed
// semantic boundary. `evaluateWakePolicy` below is the executable form of that
// sentence and is covered by fixtures 23/24.

import { canonicalJson, sha256Hex } from './canonical.ts'

export const SYSTEM2_WAKE_REASONS = [
  'MISSION_START',
  'OPTION_TERMINATED',
  'OPTION_HARD_INVALID',
  'DEPENDENCY_UNSATISFIED',
  'NO_SEMANTIC_FRONTIER',
  'SEMANTIC_STALL',
  'WORLD_TRANSITION',
  'MAJOR_RESOURCE_REGRESSION',
  'HUMAN_INTENT_CHANGE',
  'PLAN_REPAIR_REQUIRED',
] as const

export type System2WakeReason = (typeof SYSTEM2_WAKE_REASONS)[number]

const WAKE_REASON_SET: ReadonlySet<string> = new Set(SYSTEM2_WAKE_REASONS)

export function isSystem2WakeReason(value: unknown): value is System2WakeReason {
  return typeof value === 'string' && WAKE_REASON_SET.has(value)
}

export type OptionTerminalReason =
  | 'done'
  | 'blocked'
  | 'target_lost'
  | 'safety_interrupted'
  | 'capability_lost'
  | 'budget_exhausted'
  | 'world_changed'
  | 'lease_revoked'

/** Typed evidence attached to one wake reason. Always includes a cause list. */
export interface TypedWakeDetail {
  readonly reason: System2WakeReason
  /** Exact causal evidence; the projection must be able to justify the wake. */
  readonly evidence: readonly string[]
  readonly optionInstanceId: string | null
  readonly detail: Readonly<Record<string, string | number | boolean | readonly string[]>>
}

export interface WakeMissionStartInput {
  readonly kind: 'mission_start'
  readonly missionId: string
  readonly missionText: string
}
export interface WakeOptionTerminatedInput {
  readonly kind: 'option_terminated'
  readonly optionInstanceId: string
  readonly terminalReason: OptionTerminalReason
  readonly verified: 'verified' | 'not_verified' | 'unknown'
  readonly evidence: readonly string[]
}
export interface WakeOptionHardInvalidInput {
  readonly kind: 'option_hard_invalid'
  readonly optionInstanceId: string
  readonly invalidity: string
  readonly evidence: readonly string[]
}
export interface WakeDependencyUnsatisfiedInput {
  readonly kind: 'dependency_unsatisfied'
  readonly optionInstanceId: string
  readonly missing: readonly string[]
  readonly evidence: readonly string[]
}
export interface WakeNoSemanticFrontierInput {
  readonly kind: 'no_semantic_frontier'
  readonly frontierSummary: string
  readonly evidence: readonly string[]
}
export interface WakeSemanticStallInput {
  readonly kind: 'semantic_stall'
  readonly optionInstanceId: string
  readonly exhaustedAlternatives: number
  readonly failureClasses: readonly string[]
  readonly evidence: readonly string[]
}
export interface WakeWorldTransitionInput {
  readonly kind: 'world_transition'
  readonly fromDimension: string
  readonly toDimension: string
  readonly fromWorldEpoch: number
  readonly toWorldEpoch: number
  readonly evidence: readonly string[]
}
export interface WakeMajorResourceRegressionInput {
  readonly kind: 'major_resource_regression'
  readonly regression: 'death' | 'item_loss'
  readonly losses: readonly { readonly item: string; readonly before: number; readonly after: number }[]
  readonly evidence: readonly string[]
}
export interface WakeHumanIntentChangeInput {
  readonly kind: 'human_intent_change'
  readonly intentRevision: number
  readonly intentText: string
  readonly evidence: readonly string[]
}
export interface WakePlanRepairRequiredInput {
  readonly kind: 'plan_repair_required'
  readonly optionInstanceId: string | null
  readonly repairCause: string
  readonly evidence: readonly string[]
}

export type SemanticWakeEvent =
  | WakeMissionStartInput
  | WakeOptionTerminatedInput
  | WakeOptionHardInvalidInput
  | WakeDependencyUnsatisfiedInput
  | WakeNoSemanticFrontierInput
  | WakeSemanticStallInput
  | WakeWorldTransitionInput
  | WakeMajorResourceRegressionInput
  | WakeHumanIntentChangeInput
  | WakePlanRepairRequiredInput

export interface System2Wake {
  readonly reason: System2WakeReason
  readonly detail: TypedWakeDetail
}

export function wakeFromEvent(event: SemanticWakeEvent): System2Wake {
  switch (event.kind) {
    case 'mission_start':
      return {
        reason: 'MISSION_START',
        detail: {
          reason: 'MISSION_START',
          evidence: [`mission:${event.missionId}`],
          optionInstanceId: null,
          detail: { missionId: event.missionId, missionText: event.missionText },
        },
      }
    case 'option_terminated':
      return {
        reason: 'OPTION_TERMINATED',
        detail: {
          reason: 'OPTION_TERMINATED',
          evidence: event.evidence,
          optionInstanceId: event.optionInstanceId,
          detail: { terminalReason: event.terminalReason, verified: event.verified },
        },
      }
    case 'option_hard_invalid':
      return {
        reason: 'OPTION_HARD_INVALID',
        detail: {
          reason: 'OPTION_HARD_INVALID',
          evidence: event.evidence,
          optionInstanceId: event.optionInstanceId,
          detail: { invalidity: event.invalidity },
        },
      }
    case 'dependency_unsatisfied':
      return {
        reason: 'DEPENDENCY_UNSATISFIED',
        detail: {
          reason: 'DEPENDENCY_UNSATISFIED',
          evidence: event.evidence,
          optionInstanceId: event.optionInstanceId,
          detail: { missing: event.missing },
        },
      }
    case 'no_semantic_frontier':
      return {
        reason: 'NO_SEMANTIC_FRONTIER',
        detail: {
          reason: 'NO_SEMANTIC_FRONTIER',
          evidence: event.evidence,
          optionInstanceId: null,
          detail: { frontierSummary: event.frontierSummary },
        },
      }
    case 'semantic_stall':
      return {
        reason: 'SEMANTIC_STALL',
        detail: {
          reason: 'SEMANTIC_STALL',
          evidence: event.evidence,
          optionInstanceId: event.optionInstanceId,
          detail: { exhaustedAlternatives: event.exhaustedAlternatives, failureClasses: event.failureClasses },
        },
      }
    case 'world_transition':
      return {
        reason: 'WORLD_TRANSITION',
        detail: {
          reason: 'WORLD_TRANSITION',
          evidence: event.evidence,
          optionInstanceId: null,
          detail: {
            fromDimension: event.fromDimension,
            toDimension: event.toDimension,
            fromWorldEpoch: event.fromWorldEpoch,
            toWorldEpoch: event.toWorldEpoch,
          },
        },
      }
    case 'major_resource_regression':
      return {
        reason: 'MAJOR_RESOURCE_REGRESSION',
        detail: {
          reason: 'MAJOR_RESOURCE_REGRESSION',
          evidence: event.evidence,
          optionInstanceId: null,
          detail: {
            regression: event.regression,
            losses: event.losses.map((loss) => `${loss.item}:${loss.before}->${loss.after}`),
          },
        },
      }
    case 'human_intent_change':
      return {
        reason: 'HUMAN_INTENT_CHANGE',
        detail: {
          reason: 'HUMAN_INTENT_CHANGE',
          evidence: event.evidence,
          optionInstanceId: null,
          detail: { intentRevision: event.intentRevision, intentText: event.intentText },
        },
      }
    case 'plan_repair_required':
      return {
        reason: 'PLAN_REPAIR_REQUIRED',
        detail: {
          reason: 'PLAN_REPAIR_REQUIRED',
          evidence: event.evidence,
          optionInstanceId: event.optionInstanceId,
          detail: { repairCause: event.repairCause },
        },
      }
  }
}

/** Stable hash of a wake: two wakes with different causal evidence are different. */
export function wakeHash(wake: System2Wake): string {
  return wakeHashFromPayload(wake.reason, wake.detail)
}

/** Same hash from a projection/serialized wake payload (#439 section 17). */
export function wakeHashFromPayload(reason: string, detail: unknown): string {
  return sha256Hex(canonicalJson({ reason, detail } as Record<string, unknown>))
}

// ---------------------------------------------------------------------------
// local-event gating (#439 sections 9/29)
// ---------------------------------------------------------------------------

/**
 * Aggregate local counters. These are the events that MUST NOT wake System2 on
 * their own. `evaluateWakePolicy` returns a typed wake only when they have
 * aggregated into a semantic boundary.
 */
export interface LocalEventState {
  /** Consecutive failures of local pathing inside the current Option. */
  readonly pathFailures: number
  /** PLACE refusals observed (each is Skill HOW, never semantic). */
  readonly placeRefusals: number
  /** Low-confidence Jev pi answers observed. */
  readonly lowConfidenceJev: number
  /** Consecutive WAIT decisions. */
  readonly consecutiveWaits: number
  /** Grounded alternatives Jev has already tried for the current Option. */
  readonly exhaustedAlternatives: number
  /** True only when deterministic code verified the Option's terminal condition. */
  readonly optionTerminalVerified: boolean
  /** True when the current Option is hard-invalid against live truth. */
  readonly optionHardInvalid: boolean
  /** True when no grounded candidate/frontier exists at all. */
  readonly noFrontier: boolean
  /** Failure classes recorded for the current Option (typed, deduplicated). */
  readonly failureClasses: readonly string[]
}

export interface WakeSuppression {
  readonly event: string
  readonly reason: string
}

export type WakeDecision =
  | { readonly wake: true; readonly wakeReason: System2WakeReason; readonly cause: string }
  | { readonly wake: false; readonly suppressed: readonly WakeSuppression[] }

/**
 * Thresholds are deliberately explicit and corroboration-based. Nothing here
 * reads strategy or benchmark order; every input is a local mechanical fact.
 */
export const WAKE_POLICY = Object.freeze({
  /** One path failure is local recovery; two corroborate a semantic boundary. */
  pathFailuresForStall: 2,
  /** WAIT twice is explicitly NOT a wake reason; three plus no frontier is. */
  waitsForNoFrontier: 3,
  /** A single low-confidence Jev call never wakes System2. */
  lowConfidenceJevForStall: 3,
  /** Grounded alternatives that must be exhausted before stall escalation. */
  exhaustedAlternativesForStall: 2,
})

export function evaluateWakePolicy(state: LocalEventState): WakeDecision {
  const suppressed: WakeSuppression[] = []
  const suppress = (event: string, reason: string): void => {
    suppressed.push({ event, reason })
  }

  if (state.optionHardInvalid) {
    return { wake: true, wakeReason: 'OPTION_HARD_INVALID', cause: 'hard_invalidity' }
  }
  if (state.optionTerminalVerified) {
    // DONE is a deterministic fact, but it IS a semantic boundary: WHAT next
    // must be re-authored. It is a wake reason, not a stall.
    return { wake: true, wakeReason: 'OPTION_TERMINATED', cause: 'verified_terminal' }
  }
  if (state.placeRefusals > 0) {
    suppress('place_refused', 'skill_how_not_semantics')
  }
  if (state.lowConfidenceJev < WAKE_POLICY.lowConfidenceJevForStall) {
    suppress('jev_low_confidence', `count=${state.lowConfidenceJev}<${WAKE_POLICY.lowConfidenceJevForStall}`)
  }
  if (state.pathFailures < WAKE_POLICY.pathFailuresForStall) {
    suppress('path_failed', `count=${state.pathFailures}<${WAKE_POLICY.pathFailuresForStall}`)
  }
  if (state.consecutiveWaits < WAKE_POLICY.waitsForNoFrontier) {
    suppress('wait', `count=${state.consecutiveWaits}<${WAKE_POLICY.waitsForNoFrontier}`)
  }

  const stallCorroborated =
    state.exhaustedAlternatives >= WAKE_POLICY.exhaustedAlternativesForStall &&
    (state.pathFailures >= WAKE_POLICY.pathFailuresForStall || state.lowConfidenceJev >= WAKE_POLICY.lowConfidenceJevForStall)
  if (stallCorroborated) {
    return { wake: true, wakeReason: 'SEMANTIC_STALL', cause: 'option_exhausted_with_corroboration' }
  }

  if (state.noFrontier && state.consecutiveWaits >= WAKE_POLICY.waitsForNoFrontier) {
    return { wake: true, wakeReason: 'NO_SEMANTIC_FRONTIER', cause: 'no_frontier_after_waits' }
  }

  return { wake: false, suppressed }
}
