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

/**
 * Candidate starvation is an affordance/recovery observation, not a semantic
 * lifecycle transition.  Keeping this boundary explicit prevents the
 * controller's repeat counter from becoming a second System2 policy: a set
 * containing only WAIT/ESCALATE may be useful evidence, but it does not prove
 * that the current Option is exhausted, invalid, or abandoned.
 */
export interface CandidateStarvationBoundaryInput {
  activeOption: boolean
  blockedBy: string
  missing: readonly string[]
  semanticExhausted: boolean
  semanticInvalid: boolean
  semanticAbandoned: boolean
  /** Code-owned proof that the identical local affordance envelope stayed empty for its bounded recovery window. */
  localRecoveryExhausted?: boolean
}

export function evaluateCandidateStarvationBoundary(
  input: CandidateStarvationBoundaryInput,
): System2WakeBoundaryDecision {
  if (!input.activeOption) return { wake: false, reason: 'no_active_option' }
  if (input.semanticExhausted || input.semanticInvalid || input.semanticAbandoned || input.localRecoveryExhausted === true) {
    return { wake: true, reason: 'semantic_boundary' }
  }
  // `blockedBy`/`missing` are retained in the caller's evidence log. They
  // describe the local CAN envelope and cannot choose a replacement WHAT. A
  // wake becomes legal only after the controller separately proves the same
  // empty envelope persisted across its bounded, stable-state recovery window.
  return { wake: false, reason: 'local_recovery' }
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
  // #360 §11: a code-owned semantic-exhaustion proof (a full state-recurrence
  // window of verified body-only decisions with zero goal/search progress) is
  // NOT conditional on beta's own vote. Ordering `requested` first made the
  // semantic boundary unreachable exactly when beta never crosses its threshold
  // (live: max beta 0.36 < 0.5 over 2148 votes for 48.5 min), so the Option
  // survived indefinitely. This still never selects WHAT comes next.
  if (input.semanticExhausted || input.semanticInvalid) {
    return { adopt: true, wake: true, reason: 'semantic_boundary' }
  }
  if (!input.requested) return { adopt: false, wake: false, reason: 'not_requested' }
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

// ---------------------------------------------------------------------------
// wait_limit trigger backoff (bounded semantic-budget protection)
// ---------------------------------------------------------------------------
//
// The `wait_limit` Mercury trigger is COUNTER-shaped: it fires whenever the
// trailing WAIT streak reaches its threshold. That counter keeps incrementing
// for as long as the SAME stall persists, so a consultation that produced no
// plan (a provider failure, or a plan that did not break the stall) leaves the
// input unchanged and the very next request fires the identical trigger again.
//
// Measured live (source `44a65ca`, m3-live, one `collect 1 x raw_iron` freeze):
//
//   MERCURY_ATTEMPT trigger histogram: wait_limit=18, action_impossible=2, no_progress=1
//   mercury budget cache: 20/20 in window, 0 available
//   -> FATAL code=MODEL_UNAVAILABLE context=mercury:action_impossible error=budget_exhausted
//
// Six identical `wait_limit` consultations (each failing 3/3 transport attempts)
// on one unchanged stall spent 18 of the 20 hourly calls, and the resident then
// died once per restart until the whole window was empty. The trigger must make
// a repeat consultation HARDER, not equally likely.
//
// This is a pure, injectable-clock rule set. It only decides WHETHER to ask;
// it never chooses WHAT comes next (authority stays with the model), and it
// never answers a suppressed consultation with a deterministic semantic plan.
//
// Re-arm (so legitimate work is unaffected):
//   - progress (the request's authority epoch advanced) -> fresh, immediate;
//   - a different stalled Option/objective (`stallKey`) -> fresh, immediate;
//   - the trailing WAIT run restarted (streak went backwards) -> fresh;
//   - otherwise the same stall needs an exponentially growing cooldown.

/** First wait before the 2nd consecutive `wait_limit` consultation on one stall. */
export const MERCURY_WAIT_LIMIT_BACKOFF_BASE_MS_DEFAULT = 10 * 60 * 1000
/** Ceiling for the exponential wait (one consultation per this interval, at most). */
export const MERCURY_WAIT_LIMIT_BACKOFF_MAX_MS_DEFAULT = 60 * 60 * 1000

/** `BUDDY_MERCURY_WAIT_LIMIT_BACKOFF_BASE_MS` overrides the base; invalid values fall back. */
export function resolveMercuryWaitLimitBackoffBaseMs(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = Number(env.BUDDY_MERCURY_WAIT_LIMIT_BACKOFF_BASE_MS ?? MERCURY_WAIT_LIMIT_BACKOFF_BASE_MS_DEFAULT)
  return Number.isFinite(raw) && raw >= 0 ? raw : MERCURY_WAIT_LIMIT_BACKOFF_BASE_MS_DEFAULT
}

/** `BUDDY_MERCURY_WAIT_LIMIT_BACKOFF_MAX_MS` overrides the ceiling; invalid values fall back. */
export function resolveMercuryWaitLimitBackoffMaxMs(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = Number(env.BUDDY_MERCURY_WAIT_LIMIT_BACKOFF_MAX_MS ?? MERCURY_WAIT_LIMIT_BACKOFF_MAX_MS_DEFAULT)
  return Number.isFinite(raw) && raw >= 0 ? raw : MERCURY_WAIT_LIMIT_BACKOFF_MAX_MS_DEFAULT
}

/** Exponential wait for the next consultation after `consultations` recorded ones. */
export function mercuryWaitLimitBackoffDelayMs(consultations: number, baseMs: number, maxMs: number): number {
  const base = Number.isFinite(baseMs) && baseMs > 0 ? baseMs : 0
  if (base === 0 || consultations <= 0) return 0
  const max = Number.isFinite(maxMs) && maxMs >= base ? maxMs : base
  const exponent = Math.min(consultations - 1, 20)
  return Math.min(base * 2 ** exponent, max)
}

/** Durable per-stall consultation record. Plain data so it survives restarts. */
export interface MercuryWaitLimitBackoffState {
  /** stalled Option/objective identity (NOT the counter that keeps incrementing) */
  stallKey: string
  /** consecutive wait_limit consultations recorded for this stall without re-arm */
  consultations: number
  /** epoch ms of the last allowed consultation */
  lastAt: number
  /** trailing WAIT streak observed at the last consultation */
  lastWaitStreak: number
  /** semantic authority epoch at the last consultation (progress detector) */
  lastAuthorityEpoch: number | null
}

export interface MercuryWaitLimitBackoffInput {
  stallKey: string
  waitStreak: number
  /** monotonic local progress counter from the request context, when available */
  authorityEpoch?: number | null
  now: number
  baseMs: number
  maxMs: number
}

export type MercuryWaitLimitBackoffReason = 'fresh_stall' | 'progress' | 'cooldown_elapsed' | 'unchanged_stall'

export interface MercuryWaitLimitBackoffDecision {
  allow: boolean
  reason: MercuryWaitLimitBackoffReason
  state: MercuryWaitLimitBackoffState
  /** recorded consultations for this stall BEFORE this decision */
  consecutiveNoPlan: number
  /** ms until the next allowed consultation; 0 when allowed */
  waitMs: number
}

/**
 * Decide whether a `wait_limit` consultation may proceed, and return the durable
 * state to persist. On `allow` the state records the new consultation; on a
 * suppression the previous state is kept (apart from extending `lastWaitStreak`)
 * so the growing cooldown cannot be reset by the stall itself.
 */
export function evaluateMercuryWaitLimitBackoff(
  previous: MercuryWaitLimitBackoffState | null,
  input: MercuryWaitLimitBackoffInput,
): MercuryWaitLimitBackoffDecision {
  const record = (consultations: number): MercuryWaitLimitBackoffState => ({
    stallKey: input.stallKey,
    consultations,
    lastAt: input.now,
    lastWaitStreak: input.waitStreak,
    lastAuthorityEpoch: input.authorityEpoch ?? null,
  })
  const progressed =
    previous !== null &&
    previous.stallKey === input.stallKey &&
    input.authorityEpoch !== undefined &&
    input.authorityEpoch !== null &&
    previous.lastAuthorityEpoch !== null &&
    input.authorityEpoch > previous.lastAuthorityEpoch
  const sameStall = previous !== null && previous.stallKey === input.stallKey
  const restarted = sameStall && input.waitStreak < (previous?.lastWaitStreak ?? 0)

  if (!sameStall) {
    return { allow: true, reason: 'fresh_stall', state: record(1), consecutiveNoPlan: 0, waitMs: 0 }
  }
  const prior = previous as MercuryWaitLimitBackoffState
  if (progressed || restarted) {
    return {
      allow: true,
      reason: progressed ? 'progress' : 'fresh_stall',
      state: record(1),
      consecutiveNoPlan: prior.consultations,
      waitMs: 0,
    }
  }
  const required = mercuryWaitLimitBackoffDelayMs(prior.consultations, input.baseMs, input.maxMs)
  const elapsed = Math.max(0, input.now - prior.lastAt)
  if (elapsed >= required) {
    return {
      allow: true,
      reason: 'cooldown_elapsed',
      state: record(prior.consultations + 1),
      consecutiveNoPlan: prior.consultations,
      waitMs: 0,
    }
  }
  return {
    allow: false,
    reason: 'unchanged_stall',
    state: { ...prior, lastWaitStreak: Math.max(prior.lastWaitStreak, input.waitStreak) },
    consecutiveNoPlan: prior.consultations,
    waitMs: required - elapsed,
  }
}
