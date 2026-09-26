import assert from 'node:assert/strict'
import { test } from 'bun:test'
import { AuthorityJevPolicy, authorityState, buildAuthorityQuestions } from './src/jev-authority.ts'
import { JevReachRouteDecisionPolicy } from './src/reach/route-policy.ts'
import type { JevAnswer, JevPolicy, JevPolicyOptions, JevRequest, JevResult } from './src/jev-legacy.ts'
import { createReachTransitionContract } from './src/reach/transition.ts'
import type { ReachIdentity } from './src/reach/transition.ts'
import type { ReachRoute, ReachRouteDecisionInput } from './src/reach/controller.ts'
import type { WorldState } from './src/state.ts'

const LEGACY_OPTION_BETA_METADATA_KEYS = [
  'betaProbability',
  'betaAdopt',
  'optionInstanceId',
  'optionTemplateId',
  'betaThreshold',
] as const

function findKeysDeep(value: unknown, sought: ReadonlySet<string>, path = '$'): string[] {
  if (Array.isArray(value)) return value.flatMap((entry, index) => findKeysDeep(entry, sought, `${path}[${index}]`))
  if (typeof value !== 'object' || value === null) return []
  return Object.entries(value).flatMap(([key, entry]) => [
    ...(sought.has(key) ? [`${path}.${key}`] : []),
    ...findKeysDeep(entry, sought, `${path}.${key}`),
  ])
}

const legacyOptionBetaMetadataKeys = new Set<string>(LEGACY_OPTION_BETA_METADATA_KEYS)

const identity: ReachIdentity = {
  worldKey: 'fixture-world|minecraft:overworld|4',
  dimension: 'minecraft:overworld',
  worldEpoch: 4,
  generationId: 'reach-route-generation',
  leaseId: 'reach-route-lease',
}
const desiredPredicate = {
  id: 'reach.resource-source',
  proposition: { kind: 'within-interaction-reach-of-resource-source', item: 'oak_log', interactionReach: 5 },
  expected: true,
} as const
const contract = createReachTransitionContract({
  transitionId: 'reach-route-transition',
  desiredPredicate,
  requires: [{ id: 'mission.unsatisfied', proposition: { kind: 'inventory-below', item: 'oak_log', count: 1 }, expected: true }],
  ensures: [desiredPredicate],
  invariants: [{ id: 'body.alive', proposition: { kind: 'health-above-zero' }, expected: true }],
  admissibleEffects: [{ kind: 'locomotion', maxUses: null }],
  budget: { maxMechanicalSteps: 12, maxElapsedMs: 60_000, resources: {}, risk: { damage: 1 } },
  controller: { allowedTactics: ['walk', 'path_replan'], allowTemporaryWaypointChanges: true, allowWitnessSubstitution: true },
  identity,
})

function route(routeId: string, x: number, distance: number): ReachRoute {
  const evidenceId = `witness:${routeId}`
  return {
    routeId,
    groundingPredicateId: `reach.route:${routeId}`,
    waypointGroundingPredicateId: `reach.waypoint:${routeId}`,
    witness: {
      witnessId: `oak_log@${x},64,0`,
      target: { x, y: 64, z: 0 },
      desiredPredicateIdentity: contract.desiredPredicateIdentity,
      evidenceId,
      observedIdentity: identity,
      observedAtMs: 10_000,
    },
    waypoint: { waypointId: routeId, target: { x: x - 1, y: 64, z: 0 }, evidenceId: `waypoint:${routeId}` },
    tactic: 'walk',
    effectKind: 'locomotion',
    estimatedDistance: distance,
    resources: {},
    risk: {},
  }
}

const routes = [route('MOVE:oak-a', 4, 6), route('MOVE:oak-b', 9, 9)]
const input: ReachRouteDecisionInput = {
  transitionId: contract.transitionId,
  contractHash: contract.contractHash,
  desiredPredicateIdentity: contract.desiredPredicateIdentity,
  contract,
  identity,
  observedAtMs: 10_000,
  observation: {
    identity,
    observedAtMs: 10_000,
    predicates: {},
  },
  progress: { predicateDistance: 6, reachability: 'reachable', frontierId: routes[0]!.routeId, evidenceId: 'progress:10', },
  currentRouteId: null,
  routes,
}

function worldState(timestampMs = 10_000): WorldState {
  return {
    tick: 19,
    timestampMs,
    self: { position: { x: 0, y: 64, z: 0 }, dimension: identity.dimension, health: 20, food: 20, armor: null, offhand: undefined },
    inventory: { counts: {} },
    goal: 'legacy goal must not steer a VTR route choice',
    goalQueue: { depth: 1, empty: false, current: { id: 'legacy-option', description: 'stale old option' } },
    currentOption: { instanceId: 'legacy-option', templateId: 'legacy-template' },
    recentOutcomes: [],
    recentEvents: ['legacy event'],
    signals: {
      failedCandidates: {}, consecutiveFailures: 0, lastFailureCode: null, lastPathStatus: 'idle',
      escalationRecommended: false, knownResources: [], strategicNonProgress: null,
      oscillationsDetected: 0, threat: null, lastDamage: null,
    },
    blocks: [],
    entities: [],
  } as unknown as WorldState
}

function answer(value: string, probabilities: Record<string, number> | null = null): JevAnswer {
  return { name: 'action', type: 'choice', value, probability: probabilities?.[value] ?? null, confidence: null, probabilities, legend: null, note: null }
}

function result(value: string, probabilities: Record<string, number> | null = null): JevResult {
  return {
    callId: 'jev-reach-route-call', policy: 'typesafe', source: 'jev', model: 'test-primary-jev', latencyMs: 8,
    usage: null, answers: { action: answer(value, probabilities) },
  }
}

test('route choice asks Jev over grounded routes with the complete VTR contract frame', async () => {
  const calls: JevRequest[] = []
  const requests: Array<{ input: ReachRouteDecisionInput; result: JevResult; chosen: string | null }> = []
  const started: ReachRouteDecisionInput[] = []
  let providerAttemptCallbacks = 0
  const policy: JevPolicy = {
    kind: 'typesafe', model: 'test-primary-jev',
    async decide(request) {
      calls.push(request)
      return result('MOVE:oak-b', { 'MOVE:oak-a': 0.15, 'MOVE:oak-b': 0.85 })
    },
  }
  const adapter = new JevReachRouteDecisionPolicy({
    policy: () => policy,
    worldState: () => worldState(),
    onCallStart: (request) => started.push(request),
    onProviderAttempt: () => { providerAttemptCallbacks += 1 },
    onResult: (request, response, chosen) => requests.push({ input: request, result: response, chosen }),
    onFailure: (_request, reason) => assert.fail(reason),
  })

  assert.deepEqual(await adapter.chooseRoute(input), { status: 'selected', routeId: 'MOVE:oak-b' })
  assert.equal(started.length, 1)
  assert.equal(calls.length, 1)
  assert.equal(requests[0]?.result.source, 'jev')
  assert.equal(requests[0]?.result.providerAttempts, undefined, 'offline fixture policy does not claim provider evaluate attempts')
  assert.equal(providerAttemptCallbacks, 0)
  assert.equal(requests[0]?.chosen, 'MOVE:oak-b')
  assert.deepEqual(calls[0]?.candidates.map(({ id }) => id), ['MOVE:oak-a', 'MOVE:oak-b'])
  assert.deepEqual(calls[0]?.questionNames, ['action'])
  assert.equal(calls[0]?.stage, 'vtr-reach-route-reach-route-transition')
  const frame = calls[0]?.decisionFrame
  assert.equal(frame?.kind, 'vtr-reach-route')
  assert.equal(frame?.context.contractHash, contract.contractHash)
  assert.deepEqual(frame?.context.desiredPredicate, desiredPredicate)
  assert.deepEqual(frame?.context.budget, contract.budget)
  assert.deepEqual(frame?.context.identity, identity)
  assert.match(frame?.instructions ?? '', /same immutable desired predicate/)

  const payload = authorityState(calls[0]!)
  assert.deepEqual(payload.goalQueue, { depth: 0, empty: true, current: null })
  assert.equal(payload.currentOption, null)
  assert.deepEqual((payload.goal as { context: unknown }).context, frame?.context)
  const questions = buildAuthorityQuestions(calls[0]!.candidates, ['action'], frame?.instructions)
  assert.equal(questions.action?.instructions, frame?.instructions)
})

test('VTR route frame journal records bounded Jev policy input without generic pi or beta authority', async () => {
  const records: unknown[] = []
  const observedResults: JevResult[] = []
  let providerAttemptCallbacks = 0
  const evaluateStub = async (args: { questions: Record<string, unknown> }) => {
    assert.deepEqual(Object.keys(args.questions), ['action'])
    return {
      answers: {
        action: { choice: 'MOVE:oak-b', probabilities: { 'MOVE:oak-a': 0.15, 'MOVE:oak-b': 0.85 } },
      },
      providerMetadata: {},
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    } as unknown as Awaited<ReturnType<typeof import('ai').experimental_evaluate>>
  }
  const policy = new AuthorityJevPolicy(
    {
      writer: { path: 'fixture', write(record: unknown) { records.push(record) } },
      model: 'test-primary-jev',
      timeoutMs: 1_000,
      maxRetries: 0,
      rateLimitRetries: 0,
      rateLimitBaseDelayMs: 1,
    } as unknown as JevPolicyOptions,
    { key: 'fixture-only', origin: 'test' },
    {
      evaluate: evaluateStub as unknown as NonNullable<ConstructorParameters<typeof AuthorityJevPolicy>[2]>['evaluate'],
    },
  )
  const adapter = new JevReachRouteDecisionPolicy({
    policy: () => policy,
    worldState: () => worldState(),
    onCallStart: () => undefined,
    onProviderAttempt: () => { providerAttemptCallbacks += 1 },
    onResult: (_request, result) => { observedResults.push(result) },
    onFailure: (_request, reason) => assert.fail(reason),
  })

  assert.deepEqual(await adapter.chooseRoute(input), { status: 'selected', routeId: 'MOVE:oak-b' })
  assert.equal(observedResults[0]?.source, 'jev', 'route selection remains production Jev policy input')
  assert.equal(observedResults[0]?.answers.action?.value, 'MOVE:oak-b', 'the verified result retains Jev’s grounded choice')
  assert.equal(observedResults[0]?.providerAttempts, 1)
  assert.equal(providerAttemptCallbacks, 1)

  const call = records.find((record) => (record as { record?: string }).record === 'jev-call') as {
    policy: string
    model: string
    providerAttempts: number
    authority: Record<string, unknown>
    response: { answers: Record<string, JevAnswer> }
  }
  assert.equal(call.policy, 'typesafe', 'the route frame still uses the configured production Jev policy')
  assert.equal(call.model, 'test-primary-jev')
  assert.equal(call.providerAttempts, 1)
  assert.deepEqual(call.authority.decisionFrame, {
    kind: 'vtr-reach-route',
    policy: 'jev',
    questionAuthorities: { action: 'jev-policy-input' },
  })
  assert.equal(call.authority.pi, undefined)
  assert.equal(call.authority.beta, undefined)
  assert.equal(call.authority.code, 'grounding+safety+truth')
  assert.equal(call.response.answers.action?.note, 'jev-reach-route-policy-input')
  assert.equal('decision' in call.authority, false, 'route journal must not include legacy Option/β metadata')
  assert.equal('authorityDecision' in observedResults[0]!, false, 'route result must not expose legacy Option/β metadata')
  assert.deepEqual(findKeysDeep(call, legacyOptionBetaMetadataKeys), [], 'route journal must not record legacy Option/β keys at any depth')
  assert.deepEqual(findKeysDeep(observedResults[0], legacyOptionBetaMetadataKeys), [], 'route result must not expose legacy Option/β keys at any depth')
})

test('failed VTR route frame journals only route policy failure, without legacy Option/β metadata', async () => {
  const records: unknown[] = []
  let failureReason = ''
  let providerAttemptCallbacks = 0
  const policy = new AuthorityJevPolicy(
    {
      writer: { path: 'fixture', write(record: unknown) { records.push(record) } },
      model: 'test-primary-jev',
      timeoutMs: 1_000,
      maxRetries: 0,
      rateLimitRetries: 0,
      rateLimitBaseDelayMs: 1,
    } as unknown as JevPolicyOptions,
    { key: 'fixture-only', origin: 'test' },
    {
      evaluate: (async () => { throw new Error('synthetic Jev transport refusal') }) as unknown as NonNullable<ConstructorParameters<typeof AuthorityJevPolicy>[2]>['evaluate'],
    },
  )
  const adapter = new JevReachRouteDecisionPolicy({
    policy: () => policy,
    worldState: () => worldState(),
    onCallStart: () => undefined,
    onProviderAttempt: () => { providerAttemptCallbacks += 1 },
    onResult: () => assert.fail('failed Jev evaluation must not produce a route result'),
    onFailure: (_request, reason) => { failureReason = reason },
  })

  const decision = await adapter.chooseRoute(input)
  assert.equal(decision.status, 'unavailable')
  if (decision.status === 'unavailable') {
    assert.match(decision.reason, /jev_route_policy_failed:FatalModelError: FATAL model failure/)
  }
  assert.match(failureReason, /synthetic Jev transport refusal/)
  const failedCall = records.find((record) => (record as { record?: string }).record === 'jev-call') as {
    authority: Record<string, unknown>
    response: unknown
    error: string
    providerAttempts: number
  }
  assert.equal(failedCall.response, null)
  assert.equal(failedCall.providerAttempts, 1)
  assert.equal(providerAttemptCallbacks, 1)
  assert.match(failedCall.error, /synthetic Jev transport refusal/)
  assert.deepEqual(failedCall.authority.decisionFrame, {
    kind: 'vtr-reach-route',
    policy: 'jev',
    questionAuthorities: { action: 'jev-policy-input' },
  })
  assert.equal('pi' in failedCall.authority, false)
  assert.equal('beta' in failedCall.authority, false)
  assert.deepEqual(findKeysDeep(failedCall, legacyOptionBetaMetadataKeys), [], 'failed route journal must not record legacy Option/β keys at any depth')
})

test('provider attempt count records each entered evaluate call across retries', async () => {
  const records: unknown[] = []
  let evaluateCalls = 0
  let providerAttemptCallbacks = 0
  const policy = new AuthorityJevPolicy(
    {
      writer: { path: 'fixture', write(record: unknown) { records.push(record) } },
      model: 'test-primary-jev',
      timeoutMs: 1_000,
      maxRetries: 1,
      rateLimitRetries: 0,
      rateLimitBaseDelayMs: 1,
    } as unknown as JevPolicyOptions,
    { key: 'fixture-only', origin: 'test' },
    {
      evaluate: (async () => {
        evaluateCalls += 1
        if (evaluateCalls === 1) throw { statusCode: 503, message: 'service temporarily unavailable' }
        return {
          answers: { action: { choice: 'MOVE:oak-b', probabilities: { 'MOVE:oak-a': 0.1, 'MOVE:oak-b': 0.9 } } },
          providerMetadata: {},
          usage: null,
        } as unknown as Awaited<ReturnType<typeof import('ai').experimental_evaluate>>
      }) as unknown as NonNullable<ConstructorParameters<typeof AuthorityJevPolicy>[2]>['evaluate'],
      sleep: async () => undefined,
      random: () => 0,
    },
  )
  const finalResults: JevResult[] = []
  const adapter = new JevReachRouteDecisionPolicy({
    policy: () => policy,
    worldState: () => worldState(),
    onCallStart: () => undefined,
    onProviderAttempt: () => { providerAttemptCallbacks += 1 },
    onResult: (_request, result) => { finalResults.push(result) },
    onFailure: (_request, reason) => assert.fail(reason),
  })

  assert.deepEqual(await adapter.chooseRoute(input), { status: 'selected', routeId: 'MOVE:oak-b' })
  assert.equal(evaluateCalls, 2)
  assert.equal(providerAttemptCallbacks, 2)
  assert.equal(finalResults[0]?.providerAttempts, 2)
  const callAttempts = records
    .filter((record) => (record as { record?: string }).record === 'jev-call')
    .map((record) => (record as { providerAttempts?: number }).providerAttempts)
  assert.deepEqual(callAttempts, [1, 2], 'retry and success journals contain the cumulative entered evaluate count')
  const retry = records.find((record) => (record as { record?: string }).record === 'jev-retry') as {
    providerAttempts?: number
  }
  assert.equal(retry.providerAttempts, 1, 'a scheduled retry is not counted until its evaluate call begins')
})

test('provider timeout retry counts only evaluate calls actually entered', async () => {
  const records: unknown[] = []
  let evaluateCalls = 0
  let providerAttemptCallbacks = 0
  const policy = new AuthorityJevPolicy(
    {
      writer: { path: 'fixture', write(record: unknown) { records.push(record) } },
      model: 'test-primary-jev',
      timeoutMs: 10,
      maxRetries: 1,
      rateLimitRetries: 0,
      rateLimitBaseDelayMs: 1,
    } as unknown as JevPolicyOptions,
    { key: 'fixture-only', origin: 'test' },
    {
      evaluate: (async (args: { abortSignal: AbortSignal }) => {
        evaluateCalls += 1
        if (evaluateCalls === 1) {
          return await new Promise<never>((_resolve, reject) => {
            args.abortSignal.addEventListener('abort', () => reject(new DOMException('timed out', 'AbortError')), { once: true })
          })
        }
        return {
          answers: { action: { choice: 'MOVE:oak-b' } }, providerMetadata: {}, usage: null,
        } as unknown as Awaited<ReturnType<typeof import('ai').experimental_evaluate>>
      }) as unknown as NonNullable<ConstructorParameters<typeof AuthorityJevPolicy>[2]>['evaluate'],
      sleep: async () => undefined,
      random: () => 0,
    },
  )
  const finalResults: JevResult[] = []
  const adapter = new JevReachRouteDecisionPolicy({
    policy: () => policy,
    worldState: () => worldState(),
    onCallStart: () => undefined,
    onProviderAttempt: () => { providerAttemptCallbacks += 1 },
    onResult: (_request, result) => { finalResults.push(result) },
    onFailure: (_request, reason) => assert.fail(reason),
  })

  assert.deepEqual(await adapter.chooseRoute(input), { status: 'selected', routeId: 'MOVE:oak-b' })
  assert.equal(evaluateCalls, 2)
  assert.equal(providerAttemptCallbacks, 2)
  assert.equal(finalResults[0]?.providerAttempts, 2)
  const terminalCall = records.filter((record) => (record as { record?: string }).record === 'jev-call').at(-1) as {
    providerAttempts?: number
  }
  assert.equal(terminalCall.providerAttempts, 2)
})

test('provider attempt count does not include a retry whose wait aborts before evaluate', async () => {
  const records: unknown[] = []
  let evaluateCalls = 0
  let providerAttemptCallbacks = 0
  const policy = new AuthorityJevPolicy(
    {
      writer: { path: 'fixture', write(record: unknown) { records.push(record) } },
      model: 'test-primary-jev',
      timeoutMs: 1_000,
      maxRetries: 2,
      rateLimitRetries: 0,
      rateLimitBaseDelayMs: 1,
    } as unknown as JevPolicyOptions,
    { key: 'fixture-only', origin: 'test' },
    {
      evaluate: (async () => {
        evaluateCalls += 1
        throw { statusCode: 503, message: 'service temporarily unavailable' }
      }) as unknown as NonNullable<ConstructorParameters<typeof AuthorityJevPolicy>[2]>['evaluate'],
      sleep: async () => { throw new DOMException('cancelled while waiting', 'AbortError') },
      random: () => 0,
    },
  )
  let failureReason = ''
  const adapter = new JevReachRouteDecisionPolicy({
    policy: () => policy,
    worldState: () => worldState(),
    onCallStart: () => undefined,
    onProviderAttempt: () => { providerAttemptCallbacks += 1 },
    onResult: () => assert.fail('an aborted retry wait cannot return a route'),
    onFailure: (_request, reason) => { failureReason = reason },
  })

  assert.equal((await adapter.chooseRoute(input)).status, 'unavailable')
  assert.match(failureReason, /aborted during transient retry wait/)
  assert.equal(evaluateCalls, 1)
  assert.equal(providerAttemptCallbacks, 1)
  const call = records.find((record) => (record as { record?: string }).record === 'jev-call') as {
    providerAttempts?: number
    retryScheduled?: boolean
  }
  assert.equal(call.providerAttempts, 1)
  assert.equal(call.retryScheduled, true)
  const retry = records.find((record) => (record as { record?: string }).record === 'jev-retry') as {
    providerAttempts?: number
  }
  assert.equal(retry.providerAttempts, 1, 'sleeping on a scheduled retry must not increment provider attempts')
})

test('an unoffered Jev route is refused without deterministic substitution', async () => {
  let failures = 0
  const adapter = new JevReachRouteDecisionPolicy({
    policy: () => ({ kind: 'typesafe', model: 'test-primary-jev', decide: async () => result('MOVE:invented') }),
    worldState: () => worldState(),
    onCallStart: () => undefined,
    onProviderAttempt: () => undefined,
    onResult: () => undefined,
    onFailure: () => { failures += 1 },
  })

  assert.deepEqual(await adapter.chooseRoute(input), { status: 'unavailable', reason: 'jev_returned_unoffered_route:MOVE:invented' })
  assert.equal(failures, 0)
})

test('stale route world evidence suspends choice before invoking Jev', async () => {
  let calls = 0
  let reason = ''
  const adapter = new JevReachRouteDecisionPolicy({
    policy: () => ({ kind: 'typesafe', model: 'test-primary-jev', decide: async () => { calls += 1; return result('MOVE:oak-a') } }),
    worldState: () => worldState(9_999),
    onCallStart: () => undefined,
    onProviderAttempt: () => undefined,
    onResult: () => undefined,
    onFailure: (_request, value) => { reason = value },
  })

  assert.deepEqual(await adapter.chooseRoute(input), { status: 'unavailable', reason: 'fresh_reach_world_state_unavailable' })
  assert.equal(calls, 0)
  assert.equal(reason, 'fresh_reach_world_state_unavailable')
})
