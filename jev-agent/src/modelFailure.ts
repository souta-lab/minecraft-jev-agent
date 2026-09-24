// modelFailure.ts - typed model-call failure and host recovery boundary.
//
// Owner directive: a model failure must never degrade into a deterministic
// decision. Every bounded retry loop that exhausts its attempts funnels through
// `failLoud()`, which logs a FATAL line and then delegates to the host. The host
// may recycle a generation after a retryable provider outage; it must never
// replace model authority with a deterministic decision.
//
// These primitives are shared by both packages: buddy-driver imports them from
// `../jev-agent/src/modelFailure.ts`, exactly like `resolveJevApiKey`.

/** A structured logger the host already writes to (buddy.log / agent-event JSONL). */
export type FailureLog = (event: string, detail?: Record<string, unknown>) => void

/**
 * Host-owned handling for an exhausted model call. It either stops the resident
 * or requests a safe generation recovery; the policy never selects a fallback.
 */
export type FatalTerminator = (error: FatalModelError) => never

/** Effective model authority identity shared by the HOST and Jev controller. */
export interface ModelAuthorityIdentity {
  provider: string
  model: string
}

export type ModelAuthorityMismatch =
  | 'expected-identity-missing'
  | 'actual-identity-missing'
  | 'provider-mismatch'
  | 'model-mismatch'
  | 'response-source-mismatch'

/**
 * Compare non-secret, effective provider/model identity. Empty values are
 * missing evidence: callers must not silently fill them from configuration.
 */
export function modelAuthorityIdentityMismatch(
  expected: ModelAuthorityIdentity | null | undefined,
  actual: ModelAuthorityIdentity | null | undefined,
): ModelAuthorityMismatch | null {
  if (expected === null || expected === undefined || !hasIdentity(expected)) return 'expected-identity-missing'
  if (actual === null || actual === undefined || !hasIdentity(actual)) return 'actual-identity-missing'
  if (expected.provider.trim() !== actual.provider.trim()) return 'provider-mismatch'
  if (expected.model.trim() !== actual.model.trim()) return 'model-mismatch'
  return null
}

/**
 * A fresh response only proves Jev recovered when it came from the real Jev
 * policy and returned the exact model pinned before the outage. Reflex and
 * fallback decisions do not restore Jev authority.
 */
export function modelResponseAuthorityMismatch(
  expected: ModelAuthorityIdentity | null | undefined,
  actual: ModelAuthorityIdentity | null | undefined,
  source: string | null | undefined,
): ModelAuthorityMismatch | null {
  if (source !== 'jev') return 'response-source-mismatch'
  return modelAuthorityIdentityMismatch(expected, actual)
}

/** Reject an unproven recovery response before its decision can be consumed. */
export function assertRecoveryModelAuthority(
  expected: ModelAuthorityIdentity,
  actual: ModelAuthorityIdentity | null | undefined,
  source: string | null | undefined,
): void {
  const mismatch = modelResponseAuthorityMismatch(expected, actual, source)
  if (mismatch === null) return
  throw new FatalModelError(
    'jev-authority',
    1,
    `recovery authority identity rejected (${mismatch}); expected=${JSON.stringify(expected)} actual=${JSON.stringify({ authority: actual ?? null, source: source ?? null })}`,
    true,
  )
}

function hasIdentity(identity: ModelAuthorityIdentity): boolean {
  return typeof identity.provider === 'string' && identity.provider.trim().length > 0 &&
    typeof identity.model === 'string' && identity.model.trim().length > 0
}

/**
 * The one fatal error shape for "the model did not answer". `attempts` is the
 * number of bounded attempts already spent; `reason` is the underlying error.
 */
export class FatalModelError extends Error {
  readonly context: string
  readonly attempts: number
  readonly reason: string
  readonly retryable: boolean

  constructor(context: string, attempts: number, reason: string, retryable = false) {
    super(`FATAL model failure in ${context} after ${attempts} attempt(s): ${reason}`)
    this.name = 'FatalModelError'
    this.context = context
    this.attempts = attempts
    this.reason = reason
    this.retryable = retryable
  }
}

/** Control signal: the host stopped this generation and will retry with a fresh projection. */
export class ModelRecoveryRequested extends Error {
  readonly context: string
  readonly generationId: string

  constructor(context: string, generationId: string) {
    super(`model authority unavailable in ${context}; generation ${generationId} stopped for recovery`)
    this.name = 'ModelRecoveryRequested'
    this.context = context
    this.generationId = generationId
  }
}

export function describeFailure(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  try {
    return JSON.stringify(error)
  } catch {
    return '<unserialisable>'
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

export interface ModelRetryHooks {
  /** called before the next attempt after a retryable failure */
  onRetry?: (detail: { attempt: number; nextAttempt: number; error: unknown }) => void
  /** when false the failure is fatal immediately (no wasted attempts) */
  isRetryable?: (error: unknown) => boolean
  /** linear/backoff delay between attempts; default is no delay */
  delayMs?: (attempt: number) => number
}

/**
 * Run a model call with a bounded number of attempts. Rate-limit waits are NOT
 * counted here (the Jev policy owns its own rate-limit budget); this is the
 * generic "try a few times" bound. On exhaustion throws `FatalModelError`.
 */
export async function withModelRetries<T>(
  context: string,
  attempts: number,
  run: (attempt: number) => Promise<T>,
  hooks: ModelRetryHooks = {},
): Promise<T> {
  const max = Math.max(1, Math.floor(attempts))
  const isRetryable = hooks.isRetryable ?? (() => true)
  let last: unknown = null
  for (let attempt = 1; attempt <= max; attempt += 1) {
    try {
      return await run(attempt)
    } catch (error) {
      last = error
      if (attempt >= max || !isRetryable(error)) break
      hooks.onRetry?.({ attempt, nextAttempt: attempt + 1, error })
      const delay = hooks.delayMs?.(attempt) ?? 0
      if (delay > 0) await sleep(delay)
    }
  }
  throw new FatalModelError(context, max, describeFailure(last))
}

/**
 * Log the FATAL line with the underlying error, then stop. The resident host
 * passes `terminate` (non-zero exit); tests omit it and catch the thrown error.
 */
export function failLoud(error: FatalModelError, log: FailureLog, terminate: FatalTerminator | undefined): never {
  log('FATAL', {
    code: 'MODEL_UNAVAILABLE',
    context: error.context,
    attempts: error.attempts,
    error: error.reason,
    retryable: error.retryable,
  })
  if (terminate !== undefined) return terminate(error)
  throw error
}
