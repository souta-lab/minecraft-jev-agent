import { ModelRecoveryRequested } from '../jev-agent/src/modelFailure.ts'
import type { FatalModelError } from '../jev-agent/src/modelFailure.ts'

export const MODEL_RETRY_BASE_DELAY_MS = 5_000
export const MODEL_RETRY_MAX_DELAY_MS = 5 * 60_000

export type ModelAvailabilityState = 'unknown' | 'available' | 'degraded'

export interface ModelFailureRecord {
  ts: string
  generationId: string | null
  context: string
  attempts: number
  error: string
}

export interface ModelAvailabilitySnapshot {
  state: ModelAvailabilityState
  consecutiveFailures: number
  retryAt: string | null
  lastFailure: ModelFailureRecord | null
  recoveredAt: string | null
}

export type ModelRecoveryStartGate =
  | { allowed: true; reason: 'not-degraded' | 'retry-already-started' | 'retry-due'; delayMs: 0 }
  | { allowed: false; reason: 'retry-backoff' | 'invalid-retry-deadline'; delayMs: number }

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
  return error.context === 'jev-authority' && error.retryable && controllerReady
    ? 'recover-generation'
    : 'terminate-process'
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

  recordUnavailable(
    failure: Omit<ModelFailureRecord, 'ts'> & { ts?: string },
    nowMs = Date.now(),
  ): { attempt: number; delayMs: number; retryAt: string } {
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
    }
    return { attempt: this.consecutiveFailures, delayMs, retryAt }
  }

  recordRetryStarted(): void {
    if (this.state === 'degraded') this.retryAt = null
  }

  recordSuccess(nowMs = Date.now()): boolean {
    const recovered = this.state === 'degraded'
    this.state = 'available'
    this.consecutiveFailures = 0
    this.retryAt = null
    if (recovered) this.recoveredAt = new Date(nowMs).toISOString()
    return recovered
  }

  snapshot(): ModelAvailabilitySnapshot {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      retryAt: this.retryAt,
      lastFailure: this.lastFailure === null ? null : { ...this.lastFailure },
      recoveredAt: this.recoveredAt,
    }
  }
}
