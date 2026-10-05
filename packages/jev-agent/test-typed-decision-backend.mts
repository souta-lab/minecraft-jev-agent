// test-typed-decision-backend.mts - Typed Decision Plane backend/profile seam.
//
// Focused compatibility proof for the direct System One profile (Liquid d1)
// behind the unchanged AuthorityJevPolicy: Level-2 primitive semantics and
// Level-4 operational behavior (docs/architecture/TYPED-DECISION-MODELS.md
// sections 10 + 14), driven through a deterministic fetch seam - no network.
import assert from 'node:assert/strict'
import { AuthorityJevPolicy } from './src/jev/authority.ts'
import { createJevPolicy, resolveDecisionProfileId } from './src/jev.ts'
import { DANGER_LEVELS } from './src/jev/client.ts'
import type { JevPolicyOptions, JevRequest } from './src/jev/client.ts'
import type { Candidate } from './src/candidates.ts'
import { FatalModelError } from './src/modelFailure.ts'
import {
  DECISION_PROFILES,
  DEFAULT_DECISION_PROFILE_ID,
  createDirectDecisionBackend,
} from '../jev-harness/providers/systemone-direct.ts'

const FIXTURE_KEY = 'liquid_fixture_k3y_0123456789abcdef'
const IDS = ['MINE:b61_23_8', 'DESCEND:level:E:b62_20_9', 'RETRIEVE:known:log:b19_-101_9', 'WAIT'] as const
const QUESTIONS = ['action', 'abandon_option', 'danger', 'should_retreat'] as const
const PROFILE = DECISION_PROFILES['liquid-direct-d1']!
let passed = 0

function check(name: string, run: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(run)
    .then(() => {
      passed += 1
      process.stdout.write(`PASS ${name}\n`)
    })
}

type Seen = { url: string; method: string; headers: Record<string, string>; body: Record<string, any> | null }
type Responder = (seen: Seen, signal: AbortSignal, call: number) => Response | Promise<Response>

function fakeFetch(responder: Responder, seen: Seen[]) {
  return (async (input: string, init?: RequestInit) => {
    const record: Seen = {
      url: input,
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers as ConstructorParameters<typeof Headers>[0]).entries()),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    }
    seen.push(record)
    return responder(record, init!.signal as AbortSignal, seen.length)
  }) as unknown as typeof fetch
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

function hang(signal: AbortSignal): Promise<Response> {
  return new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
  })
}

function goodReply(mutate?: (reply: any) => void): any {
  const reply = {
    model: 'd1',
    answers: {
      action: {
        type: 'choice',
        choice: 'DESCEND:level:E:b62_20_9',
        confidence: 0.61,
        probabilities: { 'MINE:b61_23_8': 0.2, 'DESCEND:level:E:b62_20_9': 0.61, 'RETRIEVE:known:log:b19_-101_9': 0.09, WAIT: 0.1 },
      },
      abandon_option: { type: 'noul', noul: 0.137 },
      danger: {
        type: 'score',
        score: 1.42,
        confidence: 0.77,
        legend: { 0: 'safe', 1: 'minor risk', 2: 'dangerous', 3: 'lethal' },
        probabilities: { 0: 0.1, 1: 0.4, 2: 0.48, 3: 0.02 },
      },
      should_retreat: { type: 'noul', noul: 0.73 },
    },
    usage: { input_tokens: 812, output_tokens: 0 },
  }
  mutate?.(reply)
  return reply
}

function request(): JevRequest {
  const candidates = IDS.map((id) => ({
    id, kind: id.split(':')[0], label: `fixture ${id}`, targetName: null, target: null,
    targetEntityId: null, itemName: null, requiresTool: false, toolName: null,
    inReach: true, hasStandableAdjacent: true, meta: {},
  })) as unknown as Candidate[]
  return {
    stage: 'typed-decision-backend-test',
    questionNames: [...QUESTIONS],
    candidates,
    state: {
      tick: 1,
      self: { position: { x: 61.5, y: 20, z: 9.5 }, health: 20, food: 7 },
      signals: {
        failedCandidates: {}, consecutiveFailures: 0, lastFailureCode: null,
        lastPathStatus: null, escalationRecommended: false, knownResources: [],
        strategicNonProgress: null, oscillationsDetected: 0, threat: null, lastDamage: null,
      },
      inventory: { counts: { dirt: 1 } },
      goal: { id: 'fixture', description: 'typed decision backend fixture' },
      goalQueue: { depth: 1, empty: false, current: null },
      currentOption: null,
      recentOutcomes: [], blocks: [], entities: [], recentEvents: [],
    },
  } as unknown as JevRequest
}

interface Harness {
  policy: AuthorityJevPolicy
  seen: Seen[]
  records: Array<Record<string, any>>
  waits: number[]
}

function directPolicy(responder: Responder, options: { maxRetries?: number; rateLimitRetries?: number; timeoutMs?: number } = {}): Harness {
  const seen: Seen[] = []
  const records: Array<Record<string, any>> = []
  const waits: number[] = []
  const timeoutMs = options.timeoutMs ?? 2_000
  const backend = createDirectDecisionBackend(PROFILE, { key: FIXTURE_KEY, origin: 'file:/fixture/liquid.key' }, {
    timeoutMs,
    fetch: fakeFetch(responder, seen),
  })
  const policyOptions = {
    writer: { path: 'test', write(record: Record<string, any>) { records.push(record) } },
    model: PROFILE.modelId,
    timeoutMs,
    maxRetries: options.maxRetries ?? 0,
    rateLimitRetries: options.rateLimitRetries ?? 1,
    rateLimitBaseDelayMs: 5,
  } as unknown as JevPolicyOptions
  const policy = new AuthorityJevPolicy(policyOptions, { key: '', origin: backend.keyOrigin }, {
    evaluate: backend.evaluate,
    backend: { profileId: PROFILE.profileId, providerId: PROFILE.providerId },
    sleep: async (ms) => { waits.push(ms) },
    random: () => 0.5,
  })
  return { policy, seen, records, waits }
}

async function fatalOf(policy: AuthorityJevPolicy, signal?: AbortSignal): Promise<FatalModelError> {
  try {
    await policy.decide(request(), signal)
  } catch (error) {
    assert.ok(error instanceof FatalModelError, `expected FatalModelError, got ${String(error)}`)
    return error
  }
  throw new Error('expected the decision to fail closed')
}

function failures(records: Array<Record<string, any>>): string[] {
  return records.filter((row) => row.record === 'jev-call' && row.response === null).map((row) => String(row.authority?.failure))
}

const gatewayEnvBefore = process.env.AI_GATEWAY_API_KEY

// ---------------------------------------------------------------------------
// Level 2: primitive semantics through the unchanged authority policy
// ---------------------------------------------------------------------------

await check('mixed Choice+Score+Noul batch: exact ids, raw P(true), legend, distributions, identity', async () => {
  const h = directPolicy(() => json(200, goodReply(), { 'x-request-id': 'req-fixture-1' }))
  const result = await h.policy.decide(request())
  assert.equal(result.source, 'jev')
  assert.equal(result.model, 'd1')
  assert.equal(result.provider, 'liquid')
  assert.equal(result.profileId, 'liquid-direct-d1')
  const action = result.answers.action!
  assert.equal(action.type, 'choice')
  assert.equal(action.value, 'DESCEND:level:E:b62_20_9', 'Choice must round-trip the exact grounded id')
  assert.equal(action.probability, 0.61)
  assert.equal(action.confidence, 0.61, 'reported confidence passes through untouched')
  assert.deepEqual(Object.keys(action.probabilities ?? {}), [...IDS])
  assert.equal(result.answers.abandon_option!.type, 'boolean')
  assert.equal(result.answers.abandon_option!.probability, 0.137, 'raw Noul P(true) survives normalization')
  assert.equal(result.answers.should_retreat!.probability, 0.73)
  const danger = result.answers.danger!
  assert.equal(danger.type, 'score')
  assert.equal(danger.value, 1.42)
  assert.deepEqual(danger.legend, [...DANGER_LEVELS], 'Score legend order is preserved')
  assert.equal(danger.confidence, 0.77)
  assert.deepEqual(danger.probabilities, { 0: 0.1, 1: 0.4, 2: 0.48, 3: 0.02 })
  assert.deepEqual(result.usage, { inputTokens: 812, outputTokens: 0, totalTokens: 812 })

  assert.equal(h.seen.length, 1, 'one batched request for all four questions')
  const sent = h.seen[0]!
  assert.equal(sent.url, 'https://api.liquid.ai/decisions/v1/systemone')
  assert.equal(sent.method, 'POST')
  assert.equal(sent.headers.authorization, `Bearer ${FIXTURE_KEY}`)
  assert.equal(sent.body?.model, 'd1')
  assert.equal(sent.body?.questions.action.type, 'choice')
  assert.deepEqual(Object.keys(sent.body?.questions.action.criteria), [...IDS], 'labels are sent verbatim')
  assert.equal(sent.body?.questions.abandon_option.type, 'noul', 'repo boolean is wire Noul')
  assert.equal(sent.body?.questions.should_retreat.type, 'noul')
  assert.equal(sent.body?.questions.danger.type, 'score')
  assert.deepEqual(sent.body?.questions.danger.criteria, [...DANGER_LEVELS])
  assert.equal(typeof sent.body?.state, 'object')

  const call = h.records.find((row) => row.record === 'jev-call' && row.response !== null)!
  assert.deepEqual(call.backend, { profileId: 'liquid-direct-d1', provider: 'liquid', model: 'd1', keyOrigin: 'file:/fixture/liquid.key' })
  assert.equal(call.response.requestId, 'req-fixture-1')
  assert.equal(JSON.stringify(h.records).includes(FIXTURE_KEY), false, 'the credential never reaches the journal')
  assert.equal(process.env.AI_GATEWAY_API_KEY, gatewayEnvBefore, 'a direct profile never installs its key as the gateway credential')
})

await check('reported model identity mismatch is decisive (no silent d1:free substitution)', async () => {
  const h = directPolicy(() => json(200, goodReply((reply) => { reply.model = 'd1:free' })), { maxRetries: 2 })
  const fatal = await fatalOf(h.policy)
  assert.equal(fatal.retryable, false)
  assert.equal(fatal.attempts, 1)
  assert.equal(h.seen.length, 1, 'no retry of a model-identity failure')
  assert.deepEqual(failures(h.records), ['provider-unavailable-decisive:model_identity'])
})

const malformedCases: Array<[string, (reply: any) => void]> = [
  ['choice outside the offered labels', (reply) => { reply.answers.action.choice = 'MOVE:p0_0_0' }],
  ['missing answer', (reply) => { delete reply.answers.should_retreat }],
  ['choice distribution keys differ from the offered labels', (reply) => { delete reply.answers.action.probabilities.WAIT }],
  ['score legend reordered', (reply) => { reply.answers.danger.legend = { 0: 'minor risk', 1: 'safe', 2: 'dangerous', 3: 'lethal' } }],
  ['noul outside [0,1]', (reply) => { reply.answers.abandon_option.noul = 1.3 }],
  ['answer type differs from the question type', (reply) => { reply.answers.abandon_option = { type: 'choice', choice: 'true' } }],
  ['distribution does not sum to 1', (reply) => { reply.answers.action.probabilities.WAIT = 0.6 }],
  ['score outside the rubric', (reply) => { reply.answers.danger.score = 3.5 }],
]
for (const [name, mutate] of malformedCases) {
  await check(`malformed reply fails closed: ${name}`, async () => {
    const h = directPolicy(() => json(200, goodReply(mutate)), { maxRetries: 1 })
    const fatal = await fatalOf(h.policy)
    assert.equal(fatal.retryable, false, 'a malformed answer never requests host recovery')
    assert.equal(fatal.attempts, 2, 'bounded general retry, then fatal')
    assert.match(fatal.reason, /malformed/)
    assert.equal(h.records.some((row) => row.response !== null && row.record === 'jev-call'), false)
  })
}

// ---------------------------------------------------------------------------
// Level 4: typed availability + operational behavior
// ---------------------------------------------------------------------------

const decisiveCases: Array<[string, number, unknown, string]> = [
  ['401 authentication', 401, { error: 'invalid api key' }, 'auth'],
  ['402 payment required', 402, { error: 'payment required' }, 'credit'],
  ['5xx carrying a credit-balance message (the Vercel outage shape)', 503, { error: 'A positive credit balance is required for all requests' }, 'credit'],
  ['403 entitlement', 403, { error: 'model not enabled for this account' }, 'entitlement'],
  ['404 unknown model/route', 404, { error: 'not found' }, 'bad_request'],
]
for (const [name, status, body, availability] of decisiveCases) {
  await check(`decisive availability is fatal without retry: ${name}`, async () => {
    const h = directPolicy(() => json(status, body), { maxRetries: 3 })
    const fatal = await fatalOf(h.policy)
    assert.equal(fatal.retryable, false, 'decisive failures terminate instead of recycling generations')
    assert.equal(fatal.attempts, 1)
    assert.equal(h.seen.length, 1)
    assert.deepEqual(failures(h.records), [`provider-unavailable-decisive:${availability}`])
  })
}

await check('a key echoed in an error body is scrubbed from evidence', async () => {
  const h = directPolicy(() => json(401, { error: `invalid key ${FIXTURE_KEY}` }))
  const fatal = await fatalOf(h.policy)
  assert.equal(fatal.message.includes(FIXTURE_KEY), false)
  assert.equal(JSON.stringify(h.records).includes(FIXTURE_KEY), false)
})

await check('429 honors the bounded rate-limit budget, then succeeds', async () => {
  const h = directPolicy((_seen, _signal, call) => (call === 1 ? json(429, { error: 'slow down' }, { 'retry-after': '0' }) : json(200, goodReply())))
  const result = await h.policy.decide(request())
  assert.equal(result.source, 'jev')
  assert.equal(h.seen.length, 2)
  assert.equal(h.waits.length, 1)
})

await check('5xx is transient: retried inside the decision, then succeeds', async () => {
  const h = directPolicy((_seen, _signal, call) => (call === 1 ? json(500, { error: 'upstream' }) : json(200, goodReply())), { maxRetries: 1 })
  const result = await h.policy.decide(request())
  assert.equal(result.answers.action!.value, 'DESCEND:level:E:b62_20_9')
  assert.equal(h.seen.length, 2)
})

await check('exhausted 5xx requests host recovery (retryable) - never a fallback decision', async () => {
  const h = directPolicy(() => json(503, { error: 'service unavailable' }), { maxRetries: 2 })
  const fatal = await fatalOf(h.policy)
  assert.equal(fatal.retryable, true)
  assert.equal(fatal.attempts, 3)
  assert.equal(h.records.some((row) => row.policy === 'fallback'), false)
})

await check('connection failure is transient network availability', async () => {
  const h = directPolicy(() => { throw new TypeError('fetch failed') }, { maxRetries: 1 })
  const fatal = await fatalOf(h.policy)
  assert.equal(fatal.retryable, true)
  assert.match(fatal.reason, /network/)
  assert.equal(h.seen.length, 2)
})

await check('caller abort terminates the in-flight request as cancelled', async () => {
  const h = directPolicy((_seen, signal) => hang(signal), { maxRetries: 2 })
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 20)
  const fatal = await fatalOf(h.policy, controller.signal)
  assert.equal(fatal.retryable, false)
  assert.equal(h.seen.length, 1)
  assert.deepEqual(failures(h.records), ['cancelled'])
})

await check('per-attempt timeout is transient and bounded', async () => {
  const h = directPolicy((_seen, signal) => hang(signal), { maxRetries: 1, timeoutMs: 40 })
  const fatal = await fatalOf(h.policy)
  assert.equal(fatal.retryable, true)
  assert.equal(h.seen.length, 2)
  assert.deepEqual(failures(h.records), ['transient-provider-retry', 'transient-provider-unavailable'])
})

// ---------------------------------------------------------------------------
// profile selection: explicit, provenance-visible, no silent fallback
// ---------------------------------------------------------------------------

function factoryOptions(overrides: Partial<JevPolicyOptions> = {}): JevPolicyOptions {
  return {
    writer: { path: 'test', write() {} },
    model: null,
    timeoutMs: 1_000,
    maxRetries: 0,
    rateLimitRetries: 0,
    rateLimitBaseDelayMs: 1,
    forceFallback: false,
    resolveKey: () => ({ key: FIXTURE_KEY, origin: 'test:fixture' }),
    ...overrides,
  } as unknown as JevPolicyOptions
}

await check('Liquid direct d1 is the committed default profile', () => {
  assert.equal(DEFAULT_DECISION_PROFILE_ID, 'liquid-direct-d1')
  assert.equal(resolveDecisionProfileId({}), 'liquid-direct-d1')
  assert.equal(resolveDecisionProfileId({ BUDDY_DECISION_PROFILE: '  ' }), 'liquid-direct-d1')
  assert.equal(resolveDecisionProfileId({ BUDDY_DECISION_PROFILE: 'typesafe-gateway-jev' }), 'typesafe-gateway-jev')
  const policy = createJevPolicy(factoryOptions({ decisionProfile: resolveDecisionProfileId({}) }))
  assert.equal(policy.kind, 'typesafe')
  assert.equal(policy.provider, 'liquid')
  assert.equal(policy.profileId, 'liquid-direct-d1')
  assert.equal(policy.model, 'd1')
  assert.equal(process.env.AI_GATEWAY_API_KEY, gatewayEnvBefore)
})

await check('the profile pins its model: a gateway model override cannot redirect d1', () => {
  const policy = createJevPolicy(factoryOptions({ decisionProfile: 'liquid-direct-d1', model: 'typesafe-ai/jev' }))
  assert.equal(policy.model, 'd1')
})

await check('TypeSafe gateway Jev and d1:free stay explicitly selectable, never implicit', () => {
  const gateway = createJevPolicy(factoryOptions({ decisionProfile: 'typesafe-gateway-jev' }))
  assert.equal(gateway.provider, 'typesafe-ai')
  assert.equal(gateway.model, 'typesafe-ai/jev')
  if (gatewayEnvBefore === undefined) delete process.env.AI_GATEWAY_API_KEY
  else process.env.AI_GATEWAY_API_KEY = gatewayEnvBefore
  const free = createJevPolicy(factoryOptions({ decisionProfile: 'liquid-direct-d1-free' }))
  assert.equal(free.provider, 'liquid')
  assert.equal(free.model, 'd1:free')
  assert.notEqual(DEFAULT_DECISION_PROFILE_ID, 'liquid-direct-d1-free')
})

await check('an unknown profile is fatal; nothing is substituted', () => {
  assert.throws(
    () => createJevPolicy(factoryOptions({ decisionProfile: 'liquid-direct-d2' })),
    (error: unknown) => error instanceof FatalModelError && error.context === 'jev-policy-profile',
  )
})

await check('a missing credential is fatal, never a deterministic fallback', () => {
  assert.throws(
    () => createJevPolicy(factoryOptions({ decisionProfile: 'liquid-direct-d1', resolveKey: () => null })),
    (error: unknown) => error instanceof FatalModelError && error.context === 'jev-policy-key' && /no key resolved/.test(error.message),
  )
})

process.stdout.write(`typed decision backend: ${passed} passed\n`)
