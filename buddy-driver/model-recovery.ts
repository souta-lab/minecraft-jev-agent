import {
  ModelRecoveryRequested,
  modelAuthorityIdentityMismatch,
} from '../jev-agent/src/modelFailure.ts'
import type { ModelAuthorityIdentity, ModelAuthorityMismatch } from '../jev-agent/src/modelFailure.ts'
import type { FatalModelError } from '../jev-agent/src/modelFailure.ts'

export const MODEL_RETRY_BASE_DELAY_MS = 5_000
export const MODEL_RETRY_MAX_DELAY_MS = 5 * 60_000
export const MODEL_RECOVERY_ACTIVE_GENERATION_POLL_MS = 1_000

export type ModelAuthorityKind = 'jev' | 'system2'

export type ModelAvailabilityState = 'unknown' | 'available' | 'degraded'

export interface ModelFailureRecord {
  ts: string
  generationId: string | null
  context: string
  attempts: number
  error: string
  authorityKind: ModelAuthorityKind
  authority: ModelAuthorityIdentity | null
  sourceSha: string | null
}

export interface ModelRecoveryRejection {
  ts: string
  authorityKind: ModelAuthorityKind
  reason: ModelAuthorityMismatch
  expected: ModelAuthorityIdentity | null
  actual: ModelAuthorityIdentity | null
  expectedSourceSha: string | null
  actualSourceSha: string | null
}

export interface ModelAvailabilitySnapshot {
  state: ModelAvailabilityState
  consecutiveFailures: number
  retryAt: string | null
  lastFailure: ModelFailureRecord | null
  recoveredAt: string | null
  /** Exact Jev authority pinned before the current outage; cleared on recovery. */
  recoveryAuthorityKind: ModelAuthorityKind | null
  recoveryAuthority: ModelAuthorityIdentity | null
  /** Exact source SHA pinned before the current outage; cleared on recovery. */
  recoverySourceSha: string | null
  lastRecoveryRejection: ModelRecoveryRejection | null
}

export type ModelAuthorityAdmission =
  | { allowed: true; reason: 'ordinary-generation' | 'same-recovery-authority' | 'other-recovery-authority'; authorityKind: ModelAuthorityKind; expected: ModelAuthorityIdentity | null }
  | { allowed: false; reason: ModelAuthorityMismatch; authorityKind: ModelAuthorityKind; expected: ModelAuthorityIdentity | null; actual: ModelAuthorityIdentity | null; expectedSourceSha?: string | null; actualSourceSha?: string | null }

export interface ModelResponseAcceptance {
  accepted: boolean
  recovered: boolean
  reason: ModelAuthorityMismatch | null
}

export interface System2PlanResponseAcceptance extends ModelResponseAcceptance {
  responseSource: 'system2' | 'system2-cache' | null
  retry: { attempt: number; delayMs: number; retryAt: string } | null
}

export interface System2RecoveryRejection {
  reason: ModelAuthorityMismatch
  actualAuthority: ModelAuthorityIdentity | null
  actualSourceSha: string | null
}

export interface System2RecoveryRejectionTransition {
  retry: { attempt: number; delayMs: number; retryAt: string } | null
  availability: ModelAvailabilitySnapshot
}

export type ModelRecoveryStartGate =
  | { allowed: true; reason: 'not-degraded' | 'retry-already-started' | 'retry-due'; delayMs: 0 }
  | { allowed: false; reason: 'retry-backoff' | 'invalid-retry-deadline'; delayMs: number }

export type GenerationRestartStep = 'cancelled' | 'waiting-for-generation-stop' | 'started'

export interface GenerationRestartEffects {
  blocked(): boolean
  generationActive(): boolean
  waitForGenerationStop(delayMs: number): void
  recordModelRetryStarted(): void
  startGeneration(): void
}

/**
 * Advance a scheduled restart without dropping it when the outgoing generation
 * is still draining. The host supplies the timer and ownership operations so this
 * decision is exercised directly in the recovery regression.
 */
export function runGenerationRestartStep(
  reason: string,
  activeGenerationPollMs: number,
  effects: GenerationRestartEffects,
): GenerationRestartStep {
  if (effects.blocked()) return 'cancelled'
  if (effects.generationActive()) {
    effects.waitForGenerationStop(Math.max(1, Math.floor(activeGenerationPollMs)))
    return 'waiting-for-generation-stop'
  }
  if (reason === 'model-unavailable') effects.recordModelRetryStarted()
  effects.startGeneration()
  return 'started'
}

/**
 * Central lifecycle callers must honor the host's current provider backoff.
 * Respawn, world-reset, and control paths can all request a generation start
 * independently of the timer that normally schedules model recovery. Returning
 * the remaining delay lets the HOST defer those wakes without making a model
 * decision or changing provider authority.
 */
export function modelRecoveryStartGate(
  availability: ModelAvailabilitySnapshot,
  nowMs = Date.now(),
): ModelRecoveryStartGate {
  if (availability.state !== 'degraded') {
    return { allowed: true, reason: 'not-degraded', delayMs: 0 }
  }
  if (availability.retryAt === null) {
    // The scheduled retry has already begun. Its caller may start the fresh
    // generation; unrelated wakeups share that same retry window.
    return { allowed: true, reason: 'retry-already-started', delayMs: 0 }
  }

  const retryAtMs = Date.parse(availability.retryAt)
  if (!Number.isFinite(retryAtMs)) {
    // Corrupt/invalid internal deadline must not turn an outage into immediate
    // retry churn. Defer once for the smallest configured bounded interval.
    return { allowed: false, reason: 'invalid-retry-deadline', delayMs: MODEL_RETRY_BASE_DELAY_MS }
  }

  const now = Number.isFinite(nowMs) ? nowMs : Date.now()
  const remainingMs = retryAtMs - now
  if (remainingMs <= 0) return { allowed: true, reason: 'retry-due', delayMs: 0 }
  return {
    allowed: false,
    reason: 'retry-backoff',
    delayMs: Math.min(MODEL_RETRY_MAX_DELAY_MS, Math.ceil(remainingMs)),
  }
}

export function modelRetryDelayMs(attempt: number): number {
  const normalized = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1
  return Math.min(MODEL_RETRY_MAX_DELAY_MS, MODEL_RETRY_BASE_DELAY_MS * 2 ** Math.min(20, normalized - 1))
}

export function modelFailureDisposition(
  error: Pick<FatalModelError, 'context' | 'retryable'>,
  controllerReady: boolean,
): 'recover-generation' | 'terminate-process' {
  const semanticAuthorityFailure = error.context === 'jev-authority' || error.context === 'system2-authority'
  return semanticAuthorityFailure && error.retryable && controllerReady
    ? 'recover-generation'
    : 'terminate-process'
}

export function modelFailureAuthorityKind(error: Pick<FatalModelError, 'context'>): ModelAuthorityKind | null {
  if (error.context === 'jev-authority') return 'jev'
  if (error.context === 'system2-authority') return 'system2'
  return null
}

export interface ModelRecoveryController {
  stop(): void
  /** Prefer a host-fenced drain of an already committed safety Skill. */
  stopForModelRecovery?(): void
}

export function stopGenerationForModelRecovery(
  error: FatalModelError,
  generationId: string,
  controller: ModelRecoveryController | null,
): ModelRecoveryRequested | null {
  if (modelFailureDisposition(error, controller !== null) !== 'recover-generation' || controller === null) return null
  if (controller.stopForModelRecovery !== undefined) controller.stopForModelRecovery()
  else controller.stop()
  return new ModelRecoveryRequested(error.context, generationId)
}

export class ModelAvailabilityTracker {
  private state: ModelAvailabilityState = 'unknown'
  private consecutiveFailures = 0
  private retryAt: string | null = null
  private lastFailure: ModelFailureRecord | null = null
  private recoveredAt: string | null = null
  private activeAuthorities: Record<ModelAuthorityKind, ModelAuthorityIdentity | null> = { jev: null, system2: null }
  private activeSourceSha: string | null = null
  private recoveryAuthorityKind: ModelAuthorityKind | null = null
  private recoveryAuthority: ModelAuthorityIdentity | null = null
  private recoverySourceSha: string | null = null
  private lastRecoveryRejection: ModelRecoveryRejection | null = null

  /**
   * Record a generation's effective model configurations before start/actuation.
   * During recovery, the stored pre-outage identity is immutable until a real
   * response from that exact authority is observed.
   */
  admitGenerationAuthority(
    actual: ModelAuthorityIdentity | null | undefined,
    authorityKind: ModelAuthorityKind = 'jev',
    sourceSha?: string | null,
  ): ModelAuthorityAdmission {
    const clonedActual = cloneAuthority(actual ?? null)
    if (this.state === 'degraded') {
      if (authorityKind !== this.recoveryAuthorityKind) {
        this.activeAuthorities[authorityKind] = clonedActual
        return { allowed: true, reason: 'other-recovery-authority', authorityKind, expected: cloneAuthority(this.recoveryAuthority) }
      }
      const reason = modelAuthorityIdentityMismatch(this.recoveryAuthority, actual)
      if (reason !== null) {
        return { allowed: false, reason, authorityKind, expected: cloneAuthority(this.recoveryAuthority), actual: clonedActual }
      }
      const normalizedSourceSha = normalizeSourceSha(sourceSha)
      if (this.recoverySourceSha === null) {
        return {
          allowed: false,
          reason: 'expected-source-missing',
          authorityKind,
          expected: cloneAuthority(this.recoveryAuthority),
          actual: clonedActual,
          expectedSourceSha: null,
          actualSourceSha: normalizedSourceSha,
        }
      }
      if (normalizedSourceSha === null) {
        return {
          allowed: false,
          reason: 'actual-source-missing',
          authorityKind,
          expected: cloneAuthority(this.recoveryAuthority),
          actual: clonedActual,
          expectedSourceSha: this.recoverySourceSha,
          actualSourceSha: null,
        }
      }
      if (normalizedSourceSha !== this.recoverySourceSha) {
        return {
          allowed: false,
          reason: 'source-mismatch',
          authorityKind,
          expected: cloneAuthority(this.recoveryAuthority),
          actual: clonedActual,
          expectedSourceSha: this.recoverySourceSha,
          actualSourceSha: normalizedSourceSha,
        }
      }
      this.activeAuthorities[authorityKind] = clonedActual
      this.activeSourceSha = normalizedSourceSha
      return { allowed: true, reason: 'same-recovery-authority', authorityKind, expected: cloneAuthority(this.recoveryAuthority) }
    }

    const reason = clonedActual === null && authorityKind === 'system2'
      ? null // deterministic baseline generations do not require a System2 provider identity
      : modelAuthorityIdentityMismatch(actual, actual)
    if (reason !== null) {
      return { allowed: false, reason: 'actual-identity-missing', authorityKind, expected: clonedActual, actual: clonedActual }
    }
    this.activeAuthorities[authorityKind] = clonedActual
    this.activeSourceSha = normalizeSourceSha(sourceSha)
    return { allowed: true, reason: 'ordinary-generation', authorityKind, expected: clonedActual }
  }

  recordUnavailable(
    failure: Omit<ModelFailureRecord, 'ts' | 'authority' | 'sourceSha'> & { ts?: string; authority?: ModelAuthorityIdentity | null; sourceSha?: string | null },
    nowMs = Date.now(),
  ): { attempt: number; delayMs: number; retryAt: string } {
    // Prefer the HOST's last admitted/observed authority. MODEL_UNAVAILABLE
    // metadata is retained as a fallback for older callers, never as a way to
    // replace the pre-failure identity being pinned.
    const authorityKind = failure.authorityKind
    const authority = cloneAuthority(this.activeAuthorities[authorityKind]) ?? cloneAuthority(failure.authority)
    if (this.state !== 'degraded') {
      this.recoveryAuthorityKind = authorityKind
      this.recoveryAuthority = authority
      this.recoverySourceSha = this.activeSourceSha ?? normalizeSourceSha(failure.sourceSha)
      this.lastRecoveryRejection = null
    } else if (this.recoveryAuthorityKind !== authorityKind) {
      // A second authority failing during an existing outage cannot replace the
      // original recovery fence. It is still recorded, but recovery continues
      // to require the authority that first entered the typed degraded state.
    }
    this.state = 'degraded'
    this.consecutiveFailures += 1
    const delayMs = modelRetryDelayMs(this.consecutiveFailures)
    const retryAt = new Date(nowMs + delayMs).toISOString()
    this.retryAt = retryAt
    this.recoveredAt = null
    this.lastFailure = {
      ts: failure.ts ?? new Date(nowMs).toISOString(),
      generationId: failure.generationId,
      context: failure.context,
      attempts: failure.attempts,
      error: failure.error,
      authorityKind,
      authority,
      sourceSha: normalizeSourceSha(failure.sourceSha) ?? this.activeSourceSha,
    }
    return { attempt: this.consecutiveFailures, delayMs, retryAt }
  }

  /** A changed/missing authority is a failed recovery attempt, with bounded backoff. */
  recordRecoveryRejected(
    reason: ModelAuthorityMismatch,
    actual: ModelAuthorityIdentity | null | undefined,
    nowMs = Date.now(),
    actualSourceSha?: string | null,
  ): { attempt: number; delayMs: number; retryAt: string } | null {
    if (this.state !== 'degraded') return null
    this.consecutiveFailures += 1
    const delayMs = modelRetryDelayMs(this.consecutiveFailures)
    const retryAt = new Date(nowMs + delayMs).toISOString()
    this.retryAt = retryAt
    this.recoveredAt = null
    this.lastRecoveryRejection = {
      ts: new Date(nowMs).toISOString(),
      authorityKind: this.recoveryAuthorityKind ?? 'jev',
      reason,
      expected: cloneAuthority(this.recoveryAuthority),
      actual: cloneAuthority(actual ?? null),
      expectedSourceSha: this.recoverySourceSha,
      actualSourceSha: normalizeSourceSha(actualSourceSha),
    }
    return { attempt: this.consecutiveFailures, delayMs, retryAt }
  }

  recordRetryStarted(): void {
    if (this.state === 'degraded') this.retryAt = null
  }

  recordPolicyResponse(
    authority: ModelAuthorityIdentity | null | undefined,
    source: string | null | undefined,
    nowMs = Date.now(),
    authorityKind: ModelAuthorityKind = 'jev',
  ): ModelResponseAcceptance {
    const recoveringThisAuthority = this.state === 'degraded' && this.recoveryAuthorityKind === authorityKind
    if (this.state === 'degraded' && !recoveringThisAuthority) {
      const identityReason = modelAuthorityIdentityMismatch(authority, authority)
      if (identityReason === null) this.activeAuthorities[authorityKind] = cloneAuthority(authority ?? null)
      return { accepted: identityReason === null, recovered: false, reason: identityReason }
    }
    const recovered = recoveringThisAuthority
    const expectedSource = authorityKind === 'jev' ? 'jev' : 'system2'
    const reason = recovered
      ? (source === expectedSource ? modelAuthorityIdentityMismatch(this.recoveryAuthority, authority) : 'response-source-mismatch')
      : (source === expectedSource ? modelAuthorityIdentityMismatch(authority, authority) : 'response-source-mismatch')
    if (reason !== null) {
      return { accepted: false, recovered: false, reason }
    }

    this.activeAuthorities[authorityKind] = cloneAuthority(authority ?? null)
    if (this.state !== 'degraded' || recovered) {
      this.state = 'available'
      this.consecutiveFailures = 0
      this.retryAt = null
      if (recovered) this.recoveredAt = new Date(nowMs).toISOString()
      this.recoveryAuthorityKind = null
      this.recoveryAuthority = null
      this.recoverySourceSha = null
      this.lastRecoveryRejection = null
    }
    return { accepted: true, recovered, reason: null }
  }

  snapshot(): ModelAvailabilitySnapshot {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      retryAt: this.retryAt,
      lastFailure: this.lastFailure === null ? null : { ...this.lastFailure },
      recoveredAt: this.recoveredAt,
      recoveryAuthorityKind: this.recoveryAuthorityKind,
      recoveryAuthority: cloneAuthority(this.recoveryAuthority),
      recoverySourceSha: this.recoverySourceSha,
      lastRecoveryRejection: this.lastRecoveryRejection === null ? null : {
        ...this.lastRecoveryRejection,
        expected: cloneAuthority(this.lastRecoveryRejection.expected),
        actual: cloneAuthority(this.lastRecoveryRejection.actual),
        expectedSourceSha: this.lastRecoveryRejection.expectedSourceSha,
        actualSourceSha: this.lastRecoveryRejection.actualSourceSha,
      },
    }
  }
}

/**
 * Apply the host's typed SYSTEM2_PLAN_APPLIED recovery decision. The event must
 * carry the same source and effective authority stack that passed the
 * pre-commit fence; cached/unknown provenance can never restore authority.
 */
export function recordSystem2PlanResponse(
  tracker: ModelAvailabilityTracker,
  authority: ModelAuthorityIdentity | null,
  intentSource: string | null,
  sourceSha: string | null,
  nowMs = Date.now(),
  applicationAccepted = true,
): System2PlanResponseAcceptance {
  const responseSource = intentSource === 'intent' || intentSource === 'enrichment' || intentSource === 'ungrounded'
    ? 'system2'
    : intentSource === 'cached' ? 'system2-cache' : null
  const before = tracker.snapshot()
  if (!applicationAccepted && before.state === 'degraded' && before.recoveryAuthorityKind === 'system2') {
    const actualSource = normalizeSourceSha(sourceSha)
    const sourceMismatch: ModelAuthorityMismatch | null = before.recoverySourceSha === null
      ? 'expected-source-missing'
      : actualSource === null
        ? 'actual-source-missing'
        : actualSource !== before.recoverySourceSha
          ? 'source-mismatch'
          : null
    const authorityMismatch = modelAuthorityIdentityMismatch(before.recoveryAuthority, authority)
    const reason = sourceMismatch ?? authorityMismatch ?? 'plan-application-rejected'
    const retry = tracker.recordRecoveryRejected(reason, authority, nowMs, sourceSha)
    return { accepted: false, recovered: false, reason, responseSource, retry }
  }
  let response: ModelResponseAcceptance
  if (before.state === 'degraded' && before.recoveryAuthorityKind === 'system2') {
    const actualSource = normalizeSourceSha(sourceSha)
    const sourceMismatch: ModelAuthorityMismatch | null = before.recoverySourceSha === null
      ? 'expected-source-missing'
      : actualSource === null
        ? 'actual-source-missing'
        : actualSource !== before.recoverySourceSha
          ? 'source-mismatch'
          : null
    response = sourceMismatch === null
      ? tracker.recordPolicyResponse(authority, responseSource, nowMs, 'system2')
      : { accepted: false, recovered: false, reason: sourceMismatch }
  } else {
    response = tracker.recordPolicyResponse(authority, responseSource, nowMs, 'system2')
  }
  const retry = !response.accepted && response.reason !== null &&
    tracker.snapshot().state === 'degraded' && tracker.snapshot().recoveryAuthorityKind === 'system2'
    ? tracker.recordRecoveryRejected(response.reason, authority, nowMs, sourceSha)
    : null
  return { ...response, responseSource, retry }
}

/** Record a host-observed pre-commit recovery fence rejection and its backoff. */
export function recordSystem2RecoveryRejection(
  tracker: ModelAvailabilityTracker,
  rejection: System2RecoveryRejection,
  nowMs = Date.now(),
): System2RecoveryRejectionTransition {
  const retry = tracker.recordRecoveryRejected(
    rejection.reason,
    rejection.actualAuthority,
    nowMs,
    rejection.actualSourceSha,
  )
  return { retry, availability: tracker.snapshot() }
}

function cloneAuthority(identity: ModelAuthorityIdentity | null | undefined): ModelAuthorityIdentity | null {
  if (identity === null || identity === undefined || typeof identity.provider !== 'string' || typeof identity.model !== 'string') return null
  return { provider: identity.provider, model: identity.model }
}

function normalizeSourceSha(sourceSha: string | null | undefined): string | null {
  if (typeof sourceSha !== 'string') return null
  const normalized = sourceSha.trim().toLowerCase()
  return /^[a-f0-9]{40}$/.test(normalized) ? normalized : null
}
