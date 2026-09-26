// abandonPolicy.ts - issue #79: distinguish SPECULATIVE from DEMONSTRABLY
// UNPRODUCTIVE abandon requests so beta shadow mode stops blocking legitimate
// abandons.
//
// Measured 2026-09-18 10:23 JST (host pid=441190, contract v3, main 10698f9):
//
//   JEV_HEADS action=ESCALATE abandon=1 decision=continue abandonRequested=true
//             betaAuthority=false betaShadowed=true   (repeats)
//   CAUSAL ... optionId=smelt:iron_ingot planId=g41:smelt:iron_ingot
//          candidateId=ESCALATE actionId=ESCALATE verified=false status=done
//          resource=null progressDelta=0
//
// The policy already requested abandonment (abandonRequested=true) but
// `betaAuthority=false` forced `decision=continue`, so the same zero-progress
// option was retried forever. The #22 rule ("shadow mode may not abandon") was
// written for the SPECULATIVE case (abandon `smelt:iron_ingot` before its
// prerequisite path has run). It must not suppress an abandon when the option
// has actually been attempted N times with verified=false && progressDelta=0.
//
// This module is the deterministic, pure rule set:
//
//   1. ATTEMPTS  - a per-option (per optionId, keyed by planId) counter of
//                  unproductive settled outcomes (verified=false && progress=0).
//                  Any verified/progress outcome resets it.
//   2. CLASSIFY  - `speculative` (attempts < limit) is suppressible in shadow
//                  mode; `unproductive` (attempts >= limit) is enforced even
//                  with `betaAuthority=false`; `authority` keeps the existing
//                  #22 opt-in path (still subject to the prerequisite guard).
//   3. LADDER    - after enforcement the next feasible rung (place_held ->
//                  use_known_station -> craft_and_place -> escalate) is chosen
//                  and the abandoned one is only retryable after a cooldown or a
//                  plan/state change.
//
// No imports from the controller, no bot, no clock: `now` is injected, so the
// whole policy is unit-testable.

/** Issue #79: how many unverified zero-progress attempts before enforcing. */
export const UNPRODUCTIVE_ATTEMPT_LIMIT_DEFAULT = 3

/** `BUDDY_UNPRODUCTIVE_ATTEMPT_LIMIT` overrides N; invalid values fall back. */
export function resolveUnproductiveAttemptLimit(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = Number(env.BUDDY_UNPRODUCTIVE_ATTEMPT_LIMIT ?? UNPRODUCTIVE_ATTEMPT_LIMIT_DEFAULT)
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : UNPRODUCTIVE_ATTEMPT_LIMIT_DEFAULT
}

/** How long an enforced option stays retired before it may be retried. */
export const ABANDON_COOLDOWN_MS_DEFAULT = 60_000

/** `BUDDY_ABANDON_COOLDOWN_MS` overrides the cooldown; invalid values fall back. */
export function resolveAbandonCooldownMs(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = Number(env.BUDDY_ABANDON_COOLDOWN_MS ?? ABANDON_COOLDOWN_MS_DEFAULT)
  return Number.isFinite(raw) && raw >= 0 ? raw : ABANDON_COOLDOWN_MS_DEFAULT
}

/**
 * The unproductive streak for one option. Keyed by plan revision when known
 * (a new plan is a state change and resets the counter), else by option id.
 */
export function optionAttemptKey(optionId: string, planId: string | null): string {
  return planId !== null && planId !== '' ? planId : optionId
}

export interface OptionOutcome {
  optionId: string
  planId: string | null
  verified: boolean
  progressDelta: number
}

export interface OptionAttemptState {
  optionId: string
  planId: string | null
  /** consecutive unproductive settled outcomes since the last verified progress. */
  attempts: number
  /** every settled outcome for this option (diagnostic). */
  totalAttempts: number
  /** the last settled outcome, for the enforcement log line. */
  verified: boolean
  progressDelta: number
  /** set when enforcement retired this option; null while still actionable. */
  abandonedAtMs: number | null
}

function emptyState(optionId: string, planId: string | null): OptionAttemptState {
  return { optionId, planId, attempts: 0, totalAttempts: 0, verified: false, progressDelta: 0, abandonedAtMs: null }
}

/**
 * Per-option unproductive-attempt counter. `noteOutcome` is called once per
 * settled executor action; a verified result or any positive `progressDelta`
 * resets the unproductive streak (#79 requirement 4).
 */
export class OptionAttemptTracker {
  private readonly states = new Map<string, OptionAttemptState>()

  noteOutcome(outcome: OptionOutcome, nowMs: number): OptionAttemptState {
    const key = optionAttemptKey(outcome.optionId, outcome.planId)
    const previous = this.states.get(key) ?? emptyState(outcome.optionId, outcome.planId)
    const productive = outcome.verified || outcome.progressDelta > 0
    const next: OptionAttemptState = {
      optionId: outcome.optionId,
      planId: outcome.planId,
      attempts: productive ? 0 : previous.attempts + 1,
      totalAttempts: previous.totalAttempts + 1,
      verified: outcome.verified,
      progressDelta: outcome.progressDelta,
      // Verified progress is a state change, so a retired option becomes
      // retryable again.
      abandonedAtMs: productive ? null : previous.abandonedAtMs,
    }
    this.states.set(key, next)
    return next
  }

  stateFor(optionId: string, planId: string | null): OptionAttemptState {
    return this.states.get(optionAttemptKey(optionId, planId)) ?? emptyState(optionId, planId)
  }

  attemptsFor(optionId: string, planId: string | null): number {
    return this.stateFor(optionId, planId).attempts
  }

  markAbandoned(optionId: string, planId: string | null, nowMs: number): OptionAttemptState {
    const key = optionAttemptKey(optionId, planId)
    const previous = this.states.get(key) ?? emptyState(optionId, planId)
    const next: OptionAttemptState = { ...previous, abandonedAtMs: nowMs }
    this.states.set(key, next)
    return next
  }

  isAbandoned(optionId: string, planId: string | null, nowMs: number, cooldownMs: number): boolean {
    const state = this.states.get(optionAttemptKey(optionId, planId))
    if (state === undefined || state.abandonedAtMs === null) return false
    return nowMs - state.abandonedAtMs < cooldownMs
  }

  clearOption(optionId: string, planId: string | null): void {
    this.states.delete(optionAttemptKey(optionId, planId))
  }

  clear(): void {
    this.states.clear()
  }
}

export type AbandonReason79 = 'unproductive' | 'speculative' | 'authority' | 'cooldown' | 'not_requested'

export interface AbandonClassification {
  action: 'abandon' | 'continue'
  /** honored despite shadow mode because the option is demonstrably unproductive. */
  enforced: boolean
  /** shadow mode suppressed the request (speculative / cooling down). */
  suppressed: boolean
  reason: AbandonReason79
  attempts: number
  verified: boolean
  progressDelta: number
}

export interface AbandonClassifyInput {
  abandonRequested: boolean
  betaAuthority: boolean
  attempts: number
  lastVerified: boolean
  lastProgressDelta: number
  attemptLimit?: number
  /** the option was already enforced and is inside its cooldown window. */
  alreadyAbandoned?: boolean
}

/**
 * The #79 decision: a request is SPECULATIVE while `attempts < limit` (shadow
 * mode may suppress it), DEMONSTRABLY UNPRODUCTIVE once `attempts >= limit`
 * with verified=false && progress=0 (enforced even with `betaAuthority=false`),
 * or an `authority` opt-in (existing #22 behavior).
 */
export function classifyAbandonRequest(input: AbandonClassifyInput): AbandonClassification {
  const limit = input.attemptLimit ?? UNPRODUCTIVE_ATTEMPT_LIMIT_DEFAULT
  const base = {
    attempts: input.attempts,
    verified: input.lastVerified,
    progressDelta: input.lastProgressDelta,
  }
  if (!input.abandonRequested) {
    return { action: 'continue', enforced: false, suppressed: false, reason: 'not_requested', ...base }
  }
  if (input.alreadyAbandoned === true) {
    return { action: 'continue', enforced: false, suppressed: false, reason: 'cooldown', ...base }
  }
  const unproductive = !input.lastVerified && input.lastProgressDelta <= 0
  if (input.attempts >= limit && unproductive) {
    return { action: 'abandon', enforced: true, suppressed: false, reason: 'unproductive', ...base }
  }
  if (input.betaAuthority) {
    return { action: 'abandon', enforced: false, suppressed: false, reason: 'authority', ...base }
  }
  return { action: 'continue', enforced: false, suppressed: true, reason: 'speculative', ...base }
}

export interface AbandonEnforcedLog {
  optionId: string
  attempts: number
  verified: boolean
  progressDelta: number
  betaAuthority: boolean
  betaShadowed: boolean
  abandonRequested: boolean
}

/** The auditable enforcement line required by issue #79. */
export function formatAbandonEnforced(input: AbandonEnforcedLog): string {
  return (
    `ABANDON_ENFORCED optionId=${input.optionId} reason=unproductive attempts=${input.attempts} ` +
    `verified=${input.verified} progress=${input.progressDelta} betaAuthority=${input.betaAuthority} ` +
    `betaShadowed=${input.betaShadowed} abandonRequested=${input.abandonRequested} action=abandon`
  )
}

export interface AbandonSuppressedLog {
  optionId: string
  reason: 'speculative' | 'cooldown'
  attempts: number
}

/** The explicit suppression line, so a suppressed request is never invisible. */
export function formatAbandonSuppressed(input: AbandonSuppressedLog): string {
  return (
    `ABANDON_SUPPRESSED optionId=${input.optionId} reason=${input.reason} ` +
    `attempts=${input.attempts} mode=shadow action=continue`
  )
}

/**
 * Issue #79 requirement 3: after enforcement the ladder must select the next
 * feasible rung and never re-select the abandoned one in the same cycle. The
 * `options` order is the caller's (cost-optimal first); abandoned rungs are
 * skipped and an all-abandoned ladder returns null (the caller escalates).
 */
export function selectLadderOption<T extends string>(
  options: readonly { path: T; feasible: boolean }[],
  abandoned: ReadonlySet<string>,
): T | null {
  for (const option of options) {
    if (option.feasible && !abandoned.has(option.path)) return option.path
  }
  return null
}
