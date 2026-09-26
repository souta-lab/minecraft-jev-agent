import type { DecisionTrigger } from '../scheduler.ts'

/** Fresh, code-grounded viability facts for an active Reach contract. */
export interface ReachViabilityFacts {
  readonly criticalHealth: boolean
  readonly needsBreathEscape: boolean
  readonly environmentalHazard: boolean
  readonly activeThreat: boolean
}

export interface ReachSafetyAssessment {
  /** A current unsafe fact, rather than an event edge, owns the interruption. */
  readonly shouldInterrupt: boolean
  readonly unsafeFacts: readonly string[]
  /** Event edges are useful wakeups but may be stale by the time the scheduler runs. */
  readonly safetyTrigger: boolean
}

const SAFETY_EVENT_TRIGGERS: ReadonlySet<DecisionTrigger> = new Set([
  'damage_taken',
  'hp_changed',
  'low_air',
  'air_unknown_head_submerged',
])

/**
 * Decide whether Reach must yield from the current observation. Scheduler
 * events wake the controller; they do not establish current danger. Requiring
 * the paired present-tense fact avoids cancelling a healthy Reach contract on
 * a queued/stale damage or breath edge.
 */
export function assessReachViability(
  trigger: DecisionTrigger,
  facts: ReachViabilityFacts,
): ReachSafetyAssessment {
  const unsafeFacts = [
    ...(facts.criticalHealth ? ['critical_health'] : []),
    ...(facts.needsBreathEscape ? ['breath_escape_required'] : []),
    ...(facts.environmentalHazard ? ['environmental_hazard'] : []),
    ...(facts.activeThreat ? ['active_threat'] : []),
  ]
  return {
    shouldInterrupt: unsafeFacts.length > 0,
    unsafeFacts,
    safetyTrigger: SAFETY_EVENT_TRIGGERS.has(trigger),
  }
}
