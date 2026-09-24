import assert from 'node:assert/strict'
import { AuthorityJevPolicy, extractProviderErrorDiagnostics, isTransientProviderFailure } from './src/jev-authority.ts'
import { FatalModelError } from './src/modelFailure.ts'
import type { Candidate } from './src/candidates.ts'
import type { JevPolicyOptions, JevRequest } from './src/jev-legacy.ts'

assert.equal(isTransientProviderFailure({ statusCode: 503, message: 'unavailable' }), true)
assert.equal(isTransientProviderFailure({ cause: { status: 502, message: 'bad gateway' } }), true)
assert.equal(isTransientProviderFailure(new Error('GatewayInternalServerError: Service temporarily unavailable')), true)
assert.equal(isTransientProviderFailure('connection reset by peer'), true)
assert.equal(isTransientProviderFailure({ code: 'EAI_AGAIN', message: 'temporary DNS failure' }), true)
assert.equal(isTransientProviderFailure({ cause: { code: 'ECONNREFUSED' } }), true)
assert.equal(isTransientProviderFailure({ status: 400, message: 'invalid request' }), false)
assert.equal(isTransientProviderFailure(new Error('schema mismatch')), false)
assert.equal(isTransientProviderFailure(Object.assign(new Error('cancelled'), { name: 'AbortError' })), false)
assert.deepEqual(
  extractProviderErrorDiagnostics({ statusCode: 503, responseHeaders: new Headers({ 'retry-after': '0.25' }) }),
  { httpStatus: 503, retryAfterMs: 250 },
)

type EvaluationArgs = Parameters<typeof import('ai').experimental_evaluate>[0]
type EvaluationResponse = Awaited<ReturnType<typeof import('ai').experimental_evaluate>>

function evaluationResponse(): EvaluationResponse {
  return {
    answers: { action: { choice: 'wait', probabilities: { wait: 1 } } },
    providerMetadata: {},
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  } as unknown as EvaluationResponse
}

function request(): JevRequest {
  const candidate = {
    id: 'wait', kind: 'WAIT', label: 'wait', targetName: null, target: null,
    targetEntityId: null, itemName: null, requiresTool: false, toolName: null,
    inReach: true, hasStandableAdjacent: true, meta: {},
  } as Candidate
  return {
    stage: 'provider-recovery-test',
    questionNames: ['action'],
    candidates: [candidate],
    state: {
      tick: 1,
      self: { position: { x: 0, y: 64, z: 0 }, health: 20, food: 20 },
      signals: {
        failedCandidates: [], consecutiveFailures: 0, lastFailureCode: null,
        lastPathStatus: null, escalationRecommended: false, knownResources: [],
        strategicNonProgress: null, oscillationsDetected: 0, threat: null, lastDamage: null,
      },
      inventory: { counts: {} },
      goal: { id: 'fixture', description: 'provider retry fixture' },
      goalQueue: { depth: 0, empty: true, current: null },
      currentOption: null,
      recentOutcomes: [], blocks: [], entities: [], recentEvents: [],
    },
  } as unknown as JevRequest
}

function retryPolicy(
  evaluate: (args: EvaluationArgs) => Promise<EvaluationResponse>,
  records: unknown[],
  waits: number[],
  options: Partial<Pick<JevPolicyOptions, 'timeoutMs' | 'maxRetries' | 'rateLimitRetries' | 'rateLimitBaseDelayMs'>> = {},
  signalWait?: (signal?: AbortSignal) => void,
): AuthorityJevPolicy {
  const policyOptions = {
    writer: { path: 'test', write(record: unknown) { records.push(record) } },
    model: 'typesafe-ai/jev',
    timeoutMs: options.timeoutMs ?? 1_000,
    maxRetries: options.maxRetries ?? 2,
    rateLimitRetries: options.rateLimitRetries ?? 1,
    rateLimitBaseDelayMs: options.rateLimitBaseDelayMs ?? 7_000,
  } as unknown as JevPolicyOptions
  return new AuthorityJevPolicy(policyOptions, { key: 'fixture-key', origin: 'test' }, {
    evaluate: evaluate as unknown as NonNullable<ConstructorParameters<typeof AuthorityJevPolicy>[2]>['evaluate'],
    sleep: async (ms, signal) => { waits.push(ms); signalWait?.(signal) },
    random: () => 0.5,
  })
}

{
  const records: unknown[] = []
  const waits: number[] = []
  let calls = 0
  const policy = retryPolicy(async () => {
    calls += 1
    if (calls === 1) {
      throw Object.assign(new Error('Gateway temporarily unavailable'), {
        statusCode: 503,
        responseHeaders: new Headers({ 'retry-after': '0.25', 'x-request-id': 'gateway-fixture' }),
      })
    }
    return evaluationResponse()
  }, records, waits)
  const result = await policy.decide(request())
  assert.equal(calls, 2, 'a transient 503 should retry inside the same Jev decision')
  assert.equal(result.source, 'jev', 'the retry must preserve Jev authority')
  assert.equal(result.answers.action?.value, 'wait')
  assert.deepEqual(waits, [250], 'bounded backoff should honor a safe Retry-After value')
  assert.equal(records.filter((row) => (row as { record?: string }).record === 'jev-retry').length, 1)
  assert.equal((records.find((row) => (row as { retryScheduled?: boolean }).retryScheduled === true) as { providerDiagnostics?: { retryAfterMs?: number } }).providerDiagnostics?.retryAfterMs, 250)
}

{
  const records: unknown[] = []
  const waits: number[] = []
  let calls = 0
  const policy = retryPolicy(async () => {
    calls += 1
    throw Object.assign(new Error('Service temporarily unavailable'), { statusCode: 503 })
  }, records, waits, { maxRetries: 2 })
  let thrown: unknown
  try {
    await policy.decide(request())
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown instanceof FatalModelError)
  assert.equal((thrown as FatalModelError).retryable, true, 'only exhausted transient failures request host recovery')
  assert.equal((thrown as FatalModelError).attempts, 3)
  assert.equal(calls, 3, 'maxRetries counts the original call plus two retries')
  assert.equal(waits.length, 2)
  assert.equal(records.filter((row) => (row as { record?: string }).record === 'jev-retry').length, 2)
  assert.equal(records.some((row) => (row as { policy?: string }).policy === 'fallback'), false)
}

{
  const records: unknown[] = []
  const waits: number[] = []
  const controller = new AbortController()
  let calls = 0
  const policy = retryPolicy(async () => {
    calls += 1
    controller.abort()
    throw Object.assign(new Error('request aborted'), { name: 'AbortError' })
  }, records, waits)
  let thrown: unknown
  try {
    await policy.decide(request(), controller.signal)
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown instanceof FatalModelError)
  assert.equal((thrown as FatalModelError).retryable, false, 'caller cancellation is not a provider outage')
  assert.equal(calls, 1)
  assert.equal(waits.length, 0)
  assert.equal(records.some((row) => (row as { record?: string }).record === 'jev-retry'), false)
}

{
  const records: unknown[] = []
  const waits: number[] = []
  let calls = 0
  const policy = retryPolicy(async (args) => {
    calls += 1
    if (calls === 1) {
      const callSignal = (args as { abortSignal: AbortSignal }).abortSignal
      await new Promise<void>((resolve) => callSignal.addEventListener('abort', () => resolve(), { once: true }))
      throw Object.assign(new Error('timed out'), { name: 'AbortError' })
    }
    return evaluationResponse()
  }, records, waits, { timeoutMs: 2, maxRetries: 1 })
  const result = await policy.decide(request())
  assert.equal(result.source, 'jev')
  assert.equal(calls, 2, 'the per-call timeout is retryable even though its transport signal aborts')
  assert.equal(waits.length, 1)
}

{
  const records: unknown[] = []
  const waits: number[] = []
  let calls = 0
  const policy = retryPolicy(async () => {
    calls += 1
    if (calls === 1) throw Object.assign(new Error('rate limited'), { statusCode: 429 })
    return evaluationResponse()
  }, records, waits, { maxRetries: 3, rateLimitRetries: 1, rateLimitBaseDelayMs: 7_000 })
  const result = await policy.decide(request())
  assert.equal(result.source, 'jev')
  assert.equal(calls, 2, '429 keeps using its dedicated rate-limit retry budget')
  assert.deepEqual(waits, [7_000], '429 retains the configured linear rate-limit delay')
  assert.equal(records.some((row) => (row as { retryClass?: string }).retryClass === 'transient-provider'), false)
}

for (const [label, rateLimitError, expectedDelayMs] of [
  ['status', { status: 429 }, 7_000],
  ['httpStatus', { httpStatus: 429 }, 7_000],
  ['nested response', { response: { status: 429, headers: new Headers({ 'retry-after': '10' }) } }, 10_000],
  ['nested cause', { cause: { status: 429 } }, 7_000],
  ['nested lastError', { lastError: { httpStatus: 429 } }, 7_000],
  ['nested errors', { errors: [{ statusCode: 429 }] }, 7_000],
] as const) {
  const records: unknown[] = []
  const waits: number[] = []
  let calls = 0
  const policy = retryPolicy(async () => {
    calls += 1
    if (calls === 1) throw rateLimitError
    return evaluationResponse()
  }, records, waits, { maxRetries: 0, rateLimitRetries: 1, rateLimitBaseDelayMs: 7_000 })
  const result = await policy.decide(request())
  assert.equal(result.source, 'jev', `${label}: rate limit retry must retain Jev authority`)
  assert.equal(calls, 2, `${label}: status 429 must use the dedicated rate-limit retry budget`)
  assert.deepEqual(waits, [expectedDelayMs], `${label}: status 429 must use dedicated delay and honor Retry-After`)
  assert.equal(records.some((row) => (row as { retryClass?: string }).retryClass === 'transient-provider'), false,
    `${label}: status 429 must not consume the generic transient-provider retry path`)
  assert.equal(
    (records.find((row) => (row as { record?: string }).record === 'jev-call') as { rateLimitRetries?: number }).rateLimitRetries,
    1,
    `${label}: successful call should report the dedicated rate-limit retry`,
  )
}

console.log('provider recovery classification: PASS')
