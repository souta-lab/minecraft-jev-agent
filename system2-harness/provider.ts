// system2-harness/provider.ts - the transport seam (#439 sections 1/15/16/22).
//
// The provider adapter owns ONLY transport/auth/response decoding into
// `RawProviderResponse`. It must NOT own Minecraft policy, target ranking,
// Option semantics or truth: it only ever sees plain data (never a bot, planner
// or controller object).
//
// Retry policy lives ABOVE this seam: an adapter classifies a failure as
// retryable, but the harness decides whether a retry is still valid for the exact
// same epoch/projection/base revision (#439 section 16).

import type { RawProviderResponse } from './schema.ts'
import type { ProviderIdentity } from './versions.ts'
import type { System2ModelVisibleRequest } from './cache.ts'

export interface System2ProviderDispatchRequest {
  /** Deterministic request id (runId + decisionId + attempt). */
  readonly requestId: string
  /** Cache identity of this exact request (#439 section 17). */
  readonly cacheKey: string
  readonly projectionHash: string
  readonly projectionVersion: number
  readonly wakeReason: string
  readonly wakeDetailHash: string
  readonly system2Epoch: number
  /** The exact rendered prompt the model sees. */
  readonly prompt: string
  /** The exact model-visible state the cache key is derived from. */
  readonly modelVisible: System2ModelVisibleRequest
  readonly timeoutMs: number
  /** Attempt index, 0-based. Retries repeat the identical request. */
  readonly attempt: number
}

export interface ProviderUsage {
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  readonly totalTokens: number | null
}

export interface System2ProviderDispatchResponse {
  readonly provider: ProviderIdentity
  readonly raw: RawProviderResponse
  readonly providerMetadata: unknown
  readonly usage: ProviderUsage | null
}

export type System2ProviderFailureKind = 'provider_unavailable' | 'timeout' | 'aborted'

/**
 * Transport failure. `retryable` is a CLASSIFICATION only; a retry repeats the
 * identical semantic request and never means "ask again because we disliked the
 * plan" (#439 section 16).
 */
export class System2ProviderFailure extends Error {
  constructor(
    readonly kind: System2ProviderFailureKind,
    readonly retryable: boolean,
    message: string,
  ) {
    super(message)
    this.name = 'System2ProviderFailure'
  }
}

export function providerUnavailable(detail: string): System2ProviderFailure {
  return new System2ProviderFailure('provider_unavailable', true, detail)
}

export function providerTimeout(detail: string): System2ProviderFailure {
  return new System2ProviderFailure('timeout', true, detail)
}

export function providerAborted(detail: string): System2ProviderFailure {
  return new System2ProviderFailure('aborted', false, detail)
}

/** Classify an unknown thrown value from a provider SDK into a typed failure. */
export function classifyProviderError(error: unknown): System2ProviderFailure {
  if (error instanceof System2ProviderFailure) return error
  const message = error instanceof Error ? error.message : String(error)
  const name = error instanceof Error ? error.name : ''
  if (/abort/i.test(name) || /abort/i.test(message)) return providerAborted(message)
  if (/timeout|timed out|ETIMEDOUT/i.test(message)) return providerTimeout(message)
  return providerUnavailable(message)
}

export interface System2ProviderAdapter {
  readonly identity: ProviderIdentity
  /**
   * Transport class. `replay` means "provider-free: the answer came from a
   * recorded corpus". The harness records it in the artifact so a replayed
   * decision is never mistaken for a live one (#439 sections 23/24). Defaults to
   * `live`, so a new adapter does not have to know about this.
   */
  readonly kind?: 'live' | 'replay'
  dispatch(request: System2ProviderDispatchRequest, signal?: AbortSignal): Promise<System2ProviderDispatchResponse>
}

// ---------------------------------------------------------------------------
// scripted provider (fixtures + replay building block)
// ---------------------------------------------------------------------------

export type ScriptedOutcome =
  | { readonly kind: 'object'; readonly object: unknown; readonly text?: string | null; readonly finishReason?: string | null }
  | { readonly kind: 'text'; readonly text: string; readonly finishReason?: string | null }
  | { readonly kind: 'timeout'; readonly detail?: string }
  | { readonly kind: 'provider_unavailable'; readonly detail?: string }
  | { readonly kind: 'aborted'; readonly detail?: string }

export interface ScriptedProviderHooks {
  /**
   * Runs immediately before each dispatch resolves/throws. Replay and fixtures
   * use it to mutate the live identity source while the "model is thinking".
   */
  readonly beforeDispatch?: (request: System2ProviderDispatchRequest) => void | Promise<void>
}

export class ScriptedSystem2Provider implements System2ProviderAdapter {
  private readonly outcomes: ScriptedOutcome[]
  private dispatches = 0
  private readonly seen: System2ProviderDispatchRequest[] = []

  constructor(
    readonly identity: ProviderIdentity,
    outcomes: readonly ScriptedOutcome[],
    private readonly hooks: ScriptedProviderHooks = {},
  ) {
    this.outcomes = [...outcomes]
  }

  get dispatchCount(): number {
    return this.dispatches
  }

  get requests(): readonly System2ProviderDispatchRequest[] {
    return this.seen
  }

  lastRequest(): System2ProviderDispatchRequest | null {
    return this.seen[this.seen.length - 1] ?? null
  }

  remaining(): number {
    return this.outcomes.length
  }

  dispatch(request: System2ProviderDispatchRequest): Promise<System2ProviderDispatchResponse> {
    this.dispatches += 1
    this.seen.push(request)
    const outcome = this.outcomes.shift()
    return (async () => {
      await this.hooks.beforeDispatch?.(request)
      if (outcome === undefined) {
        throw providerUnavailable('scripted provider has no outcome left')
      }
      switch (outcome.kind) {
        case 'object':
          return {
            provider: this.identity,
            raw: { object: outcome.object, text: outcome.text ?? null, finishReason: outcome.finishReason ?? 'tool_call' },
            providerMetadata: { scripted: true },
            usage: { inputTokens: null, outputTokens: null, totalTokens: null },
          }
        case 'text':
          return {
            provider: this.identity,
            raw: { object: null, text: outcome.text, finishReason: outcome.finishReason ?? 'stop' },
            providerMetadata: { scripted: true },
            usage: { inputTokens: null, outputTokens: null, totalTokens: null },
          }
        case 'timeout':
          throw providerTimeout(outcome.detail ?? 'scripted timeout')
        case 'provider_unavailable':
          throw providerUnavailable(outcome.detail ?? 'scripted provider unavailable')
        case 'aborted':
          throw providerAborted(outcome.detail ?? 'scripted abort')
      }
    })()
  }
}
