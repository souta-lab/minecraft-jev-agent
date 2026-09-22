// jev-harness/provider.ts - the transport seam (#438 section 16).
//
// The provider adapter owns ONLY authentication/transport, API request shape,
// provider primitive mapping, provider response decoding and provider metadata.
// It must NOT own Minecraft policy, candidate generation, Option semantics,
// target ranking, safety rules or success verification - so this interface only
// ever sees plain data and typed questions, never a bot/planner/controller object
// (I10).
//
// Retry policy lives ABOVE this seam (#438 section 8): an adapter classifies a
// failure as retryable, but the harness decides whether a retry is still valid
// for the exact same decision epoch/projection/candidate set.

import type { JevFailureKind, JevPrimitive } from './contract.ts'

export interface ProviderQuestion {
  readonly id: string
  readonly primitive: JevPrimitive
  readonly instructions: string
  readonly criteria: Readonly<Record<string, string>> | readonly string[]
}

export interface ProviderDispatchRequest {
  readonly questionIds: readonly string[]
  /** Plain data only: no live object references (validated by the harness). */
  readonly projection: unknown
  /**
   * Projection metadata. A provider may ignore it; it exists so transport-level
   * evidence and the replay adapter can identify the exact decision problem
   * without re-deriving anything from gameplay state.
   */
  readonly projectionId?: string
  readonly projectionVersion?: number
  readonly projectionHash?: string
  readonly questions: readonly ProviderQuestion[]
  readonly timeoutMs: number
}

export interface ProviderRawAnswer {
  readonly questionId: string
  /** The provider-shaped answer. Only the strict decoder may interpret it. */
  readonly raw: unknown
}

export interface ProviderUsage {
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  readonly totalTokens: number | null
}

export interface ProviderDispatchResponse {
  readonly provider: string
  readonly model: string
  readonly answers: Readonly<Record<string, ProviderRawAnswer>>
  readonly providerMetadata: unknown
  readonly usage: ProviderUsage | null
}

/**
 * Transport failure. `retryable` is a CLASSIFICATION only: a retry is a
 * transport-level retry of the exact same semantic request, never "ask again
 * because the answer was inconvenient" (#438 section 8).
 */
export class ProviderFailure extends Error {
  constructor(
    readonly kind: Extract<JevFailureKind, 'provider_unavailable' | 'timeout' | 'aborted'>,
    readonly retryable: boolean,
    message: string,
  ) {
    super(message)
    this.name = 'ProviderFailure'
  }
}

export interface JevProviderAdapter {
  readonly providerId: string
  readonly modelId: string
  dispatch(request: ProviderDispatchRequest, signal?: AbortSignal): Promise<ProviderDispatchResponse>
}

export function providerUnavailable(message: string, retryable = true): ProviderFailure {
  return new ProviderFailure('provider_unavailable', retryable, message)
}

export function providerTimeout(message: string): ProviderFailure {
  return new ProviderFailure('timeout', true, message)
}

export function providerAborted(message: string): ProviderFailure {
  return new ProviderFailure('aborted', false, message)
}

/** Classify an unknown thrown value into a typed provider failure. */
export function classifyProviderError(error: unknown, signal?: AbortSignal): ProviderFailure {
  if (error instanceof ProviderFailure) return error
  if (signal?.aborted === true) return providerAborted('request aborted by caller')
  const message = describeError(error)
  if (isAbortError(error)) return providerTimeout(`provider call timed out: ${message}`)
  if (isRateLimitError(error)) return providerUnavailable(`provider rate limited: ${message}`, true)
  if (isTransientError(error)) return providerUnavailable(message, true)
  return providerUnavailable(message, true)
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  try {
    return JSON.stringify(error)
  } catch {
    return '<unserialisable>'
  }
}

function isAbortError(error: unknown, depth = 0): boolean {
  if (depth > 4 || typeof error !== 'object' || error === null) return false
  const row = error as Record<string, unknown>
  if (typeof row.name === 'string' && (row.name === 'AbortError' || row.name === 'TimeoutError')) return true
  if (typeof row.code === 'string' && (row.code === 'ABORT_ERR' || row.code === 'ETIMEDOUT')) return true
  return isAbortError(row.cause, depth + 1) || isAbortError(row.lastError, depth + 1)
}

/** Walks the AI SDK's wrapped error chain, exactly like the production call sites do. */
export function isRateLimitError(error: unknown, depth = 0): boolean {
  if (depth > 4 || typeof error !== 'object' || error === null) return false
  const row = error as Record<string, unknown>
  if (row.statusCode === 429) return true
  if (typeof row.name === 'string' && row.name.includes('RateLimit')) return true
  if (isRateLimitError(row.cause, depth + 1) || isRateLimitError(row.lastError, depth + 1)) return true
  return Array.isArray(row.errors) && row.errors.some((entry) => isRateLimitError(entry, depth + 1))
}

function isTransientError(error: unknown, depth = 0): boolean {
  if (depth > 4 || typeof error !== 'object' || error === null) return false
  const row = error as Record<string, unknown>
  const status = row.statusCode
  if (typeof status === 'number' && (status === 502 || status === 503 || status === 504)) return true
  const code = row.code
  if (typeof code === 'string' && ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'ENOTFOUND'].includes(code)) return true
  if (typeof row.name === 'string' && (row.name.includes('GatewayInternalServerError') || row.name.includes('ServiceUnavailable'))) {
    return true
  }
  return isTransientError(row.cause, depth + 1) || isTransientError(row.lastError, depth + 1)
}
