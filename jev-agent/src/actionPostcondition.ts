// actionPostcondition.ts - Issue #79: an action is only DONE when its
// post-condition holds.
//
// Measured 2026-09-18 10:20 JST: `status=done verified=false resource=null
// progressDelta=0` for a smelt plan was treated as success, so the same plan was
// re-queued forever and every downstream gate (rung supply, SMELT_DONE) saw a
// false positive. An action that finishes `done` with an unmet post-condition and
// ZERO observable change (no item gained, no block removed) is a FAILURE.
//
// This module is pure and bot-free so the post-condition catalog, the
// classification and the abandon budget are unit-testable with no Mineflayer
// connection. The executor uses `isUnverifiedOutcome` to downgrade the result to
// `failed`; the controller uses `decideActionOutcome` / `evaluateUnverifiedBudget`
// to log ACTION_UNVERIFIED and to stop retrying one strategy forever.

/**
 * How many unverified attempts the same planId + strategy gets before the
 * controller abandons it (`ABANDON_REASON=action_unverified`) and selects the
 * next option. Small on purpose: the plan has already produced zero progress.
 */
export const UNVERIFIED_ACTION_LIMIT = 2

/** The executor outcome fields a post-condition check needs. */
export interface ActionOutcomeInput {
  /** `CandidateKind` (`MINE`, `SMELT`, `PLACE`, `CRAFT`, `RETRIEVE`, ...) */
  kind: string
  /** `ExecutionResult['status']` */
  status: string
  verified: boolean
  itemsGained: number
  blockRemoved?: boolean
  /** local plan revision (GoalQueue row id), when the caller knows it */
  planId?: string | null
  /** executor action id, when the caller knows it */
  actionId?: string | null
  /** high-level strategy label (`llm:smelt`, ...), when known */
  strategy?: string | null
}

/**
 * The per-action post-condition the executor is checking, in words, so the
 * ACTION_UNVERIFIED line names what was expected (issue #79 acceptance).
 */
export function describeActionPostcondition(kind: string): string {
  switch (kind) {
    case 'SMELT':
      return 'target item count increased OR (furnace block at target AND input+fuel consumed)'
    case 'PLACE':
      return 'block exists at the target'
    case 'CRAFT':
      return 'output item count increased'
    case 'MINE':
      return 'target block removed AND (drop collected OR observed)'
    case 'RETRIEVE':
      return 'remembered resource reached (distance closed / staircase step) or item count increased'
    case 'DESCEND':
      return 'target block removed and the descend step is reachable'
    case 'STEP':
      return 'the face block was removed'
    case 'ESCALATE':
      return 'System 2 accepted the hand-off (no world effect expected)'
    case 'WAIT':
      return 'a bounded wait elapsed'
    default:
      return 'action produced a verified change'
  }
}

/** Zero observable change: nothing was gained and no block was removed. */
export function isZeroProgressOutcome(input: Pick<ActionOutcomeInput, 'itemsGained' | 'blockRemoved'>): boolean {
  return input.itemsGained <= 0 && input.blockRemoved !== true
}

/**
 * True when a `done` action must be reclassified as FAILURE: its post-condition
 * was unmet (`verified=false`) and it produced no observable change.
 */
export function isUnverifiedOutcome(input: ActionOutcomeInput): boolean {
  return input.status === 'done' && !input.verified && isZeroProgressOutcome(input)
}

export interface ActionUnverifiedFields {
  planId: string | null
  actionId: string | null
  strategy: string | null
  postcondition: string
}

/** Exact log line: `ACTION_UNVERIFIED planId=... actionId=... strategy=... postcondition=...`. */
export function formatActionUnverified(fields: ActionUnverifiedFields): string {
  return (
    `ACTION_UNVERIFIED planId=${fields.planId ?? 'null'} actionId=${fields.actionId ?? 'null'} ` +
    `strategy=${fields.strategy ?? 'null'} postcondition=${fields.postcondition}`
  )
}

export type ActionOutcomeVerdict = 'verified' | 'unverified' | 'failed' | 'cancelled' | 'inconclusive'

export interface ActionOutcomeDecision {
  verdict: ActionOutcomeVerdict
  /** true only when this result may advance the ladder/rung */
  advances: boolean
  postcondition: string
  /** the ACTION_UNVERIFIED line, or null when this is not an unverified outcome */
  unverifiedLine: string | null
}

/**
 * The one place that decides whether an executor result counts as progress.
 * `advances` is false for everything except a `done` + `verified` action, so the
 * ladder can never advance on an unverified action (#79).
 */
export function decideActionOutcome(input: ActionOutcomeInput): ActionOutcomeDecision {
  const postcondition = describeActionPostcondition(input.kind)
  if (input.status === 'cancelled') {
    return { verdict: 'cancelled', advances: false, postcondition, unverifiedLine: null }
  }
  if (input.status === 'failed') {
    return { verdict: 'failed', advances: false, postcondition, unverifiedLine: null }
  }
  if (input.status === 'done' && input.verified) {
    return { verdict: 'verified', advances: true, postcondition, unverifiedLine: null }
  }
  if (isUnverifiedOutcome(input)) {
    return {
      verdict: 'unverified',
      advances: false,
      postcondition,
      unverifiedLine: formatActionUnverified({
        planId: input.planId ?? null,
        actionId: input.actionId ?? null,
        strategy: input.strategy ?? null,
        postcondition,
      }),
    }
  }
  return { verdict: 'inconclusive', advances: false, postcondition, unverifiedLine: null }
}

export interface UnverifiedBudgetInput {
  /** attempts recorded so far for this planId, INCLUDING the current one */
  attempts: number
  limit: number
  planId: string
  strategy: string | null
}

export interface UnverifiedBudgetDecision {
  attempts: number
  /** true once the same planId+strategy must not be retried again */
  abandon: boolean
  /** the ABANDON_REASON line when abandoning, else null */
  line: string | null
}

/** Deterministic abandon budget: the same strategy is not retried forever. */
export function evaluateUnverifiedBudget(input: UnverifiedBudgetInput): UnverifiedBudgetDecision {
  const limit = Math.max(1, Math.floor(input.limit))
  const attempts = Math.max(1, Math.floor(input.attempts))
  const abandon = attempts >= limit
  return {
    attempts,
    abandon,
    line: abandon
      ? `ABANDON_REASON=action_unverified planId=${input.planId} attempts=${attempts} strategy=${input.strategy ?? 'null'}`
      : null,
  }
}
