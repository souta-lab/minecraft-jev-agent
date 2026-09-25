import assert from 'node:assert/strict'
import { test } from 'bun:test'
import type { JevAnswer, JevPolicy, JevRequest, JevResult } from './src/jev-legacy.ts'
import {
  buildJevReachIdentity,
  createJevReachVtrComposition,
  type JevReachVtrCompositionContext,
} from './src/jev-reach-vtr-composition.ts'
import type { WorldState } from './src/state.ts'
import { ReachMissionRuntime } from './src/vtr/reach-mission-runtime.ts'
import { createReachTransitionContract, type ReachIdentity, type ReachTransitionContract } from './src/vtr/reach.ts'
import type { ReachRoute, ReachRouteDecisionInput, ReachRuntimeSnapshot } from './src/vtr/reach-controller.ts'

const identity: ReachIdentity = {
  worldKey: 'composition-world|minecraft:overworld|4',
  dimension: 'minecraft:overworld',
  worldEpoch: 4,
  generationId: 'composition-generation',
  leaseId: 'composition-lease',
}
const desiredPredicate = {
  id: 'reach.resource-source',
  proposition: { kind: 'within-interaction-reach-of-resource-source', item: 'oak_log', interactionReach: 5 },
  expected: true,
} as const
const contract = createReachTransitionContract({
  transitionId: 'composition-transition',
  desiredPredicate,
  requires: [{ id: 'mission.unsatisfied', proposition: { kind: 'inventory-below', item: 'oak_log', count: 1 }, expected: true }],
  ensures: [desiredPredicate],
  invariants: [{ id: 'body.alive', proposition: { kind: 'health-above-zero' }, expected: true }],
  admissibleEffects: [{ kind: 'locomotion', maxUses: null }],
  budget: { maxMechanicalSteps: 12, maxElapsedMs: 60_000, resources: {}, risk: { damage: 1 } },
  controller: { allowedTactics: ['walk', 'path_replan'], allowTemporaryWaypointChanges: true, allowWitnessSubstitution: true },
  identity,
})

function worldState(timestampMs = 10_000): WorldState {
  return {
    tick: 19,
    timestampMs,
    self: { position: { x: 0, y: 64, z: 0 }, dimension: identity.dimension, health: 20, food: 20, armor: null, offhand: undefined },
    inventory: { counts: {} },
    goal: null,
    goalQueue: { depth: 0, empty: true, current: null },
    currentOption: null,
    recentOutcomes: [],
    recentEvents: [],
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

function jevResult(value: string, probabilities: Record<string, number> | null = null): JevResult {
  return {
    callId: 'composition-jev-call', policy: 'typesafe', source: 'jev', model: 'test-primary-jev', latencyMs: 8,
    usage: null, answers: { action: answer(value, probabilities) },
  }
}

function routeFor(contractValue: ReachTransitionContract, observedAtMs: number, id = 'MOVE:oak-a'): ReachRoute {
  const evidenceId = `witness:${id}`
  return {
    routeId: id,
    groundingPredicateId: `grounded:${id}`,
    waypointGroundingPredicateId: null,
    witness: {
      witnessId: 'oak_log@4,64,0', target: { x: 4, y: 64, z: 0 },
      desiredPredicateIdentity: contractValue.desiredPredicateIdentity,
      evidenceId, observedIdentity: identity, observedAtMs,
    },
    waypoint: null,
    tactic: 'walk', effectKind: 'locomotion', estimatedDistance: 4,
    resources: {}, risk: {},
  }
}

function inputFor(contractValue: ReachTransitionContract, observedAtMs = 10_000): ReachRouteDecisionInput {
  const routes = [routeFor(contractValue, observedAtMs, 'MOVE:oak-a'), routeFor(contractValue, observedAtMs, 'MOVE:oak-b')]
  return {
    transitionId: contractValue.transitionId,
    contractHash: contractValue.contractHash,
    desiredPredicateIdentity: contractValue.desiredPredicateIdentity,
    contract: contractValue,
    identity,
    observedAtMs,
    observation: { identity, observedAtMs, predicates: {} },
    progress: { predicateDistance: 8, reachability: 'reachable', frontierId: routes[0]!.routeId, evidenceId: 'progress:10' },
    currentRouteId: null,
    routes,
  }
}

function makeContext(policy: JevPolicy, state = worldState()): { context: JevReachVtrCompositionContext; logs: Array<{ level: string; message: string; detail: Record<string, unknown> }> } {
  const logs: Array<{ level: string; message: string; detail: Record<string, unknown> }> = []
  const context: JevReachVtrCompositionContext = {
    serverId: 'composition-world', worldEpoch: identity.worldEpoch,
    generationId: identity.generationId, leaseId: identity.leaseId,
    policy: { value: policy }, cachedWorldState: { value: state },
    counters: { jevCalls: { value: 0 }, lastJevAt: { value: 0 }, tickCounter: { value: 42 } },
    lastRouteDecision: { value: null },
    logger: {
      info: (_source, message, detail) => logs.push({ level: 'info', message, detail }),
      warn: (_source, message, detail) => logs.push({ level: 'warn', message, detail }),
    },
  }
  return { context, logs }
}

function startSnapshot(contractValue: ReachTransitionContract, observedAtMs: number, route: ReachRoute): ReachRuntimeSnapshot {
  const predicates: Record<string, { truth: 'true' | 'false'; evidenceId: string }> = {
    'mission.unsatisfied': { truth: 'true', evidenceId: 'mission:unsatisfied' },
    'reach.source-grounded': { truth: 'true', evidenceId: 'source:grounded' },
    'body.alive': { truth: 'true', evidenceId: 'body:alive' },
    [contractValue.desiredPredicate.id]: { truth: 'false', evidenceId: 'reach:not-yet' },
    [route.groundingPredicateId]: { truth: 'true', evidenceId: route.witness.evidenceId },
  }
  return {
    observation: { identity, observedAtMs, predicates },
    routes: [route],
    progress: { predicateDistance: 8, reachability: 'reachable', frontierId: route.routeId, evidenceId: 'progress:commit' },
  }
}

function snapshotForRoutes(
  contractValue: ReachTransitionContract,
  observedAtMs: number,
  routes: readonly ReachRoute[],
): ReachRuntimeSnapshot {
  const first = routes[0]
  if (first === undefined) throw new Error('test requires at least one grounded route')
  const initial = startSnapshot(contractValue, observedAtMs, first)
  return {
    ...initial,
    routes,
    observation: {
      ...initial.observation,
      predicates: {
        ...initial.observation.predicates,
        ...Object.fromEntries(routes.map((candidate) => [
          candidate.groundingPredicateId,
          { truth: 'true' as const, evidenceId: candidate.witness.evidenceId },
        ])),
      },
    },
  }
}

async function finishMetricsTransition(policy: JevPolicy): Promise<{
  readonly context: JevReachVtrCompositionContext
  readonly logs: Array<{ level: string; message: string; detail: Record<string, unknown> }>
  readonly terminalOutcome: string
}> {
  const { context, logs } = makeContext(policy)
  const composition = createJevReachVtrComposition(context)
  const offeredRoutes = [routeFor(contract, 10_000, 'MOVE:oak-a'), routeFor(contract, 10_000, 'MOVE:oak-b')]
  const committed = await composition.runtime.commit(contract, snapshotForRoutes(contract, 10_000, offeredRoutes))
  if (committed.status !== 'active' || committed.intent === undefined) {
    throw new Error(`expected route policy to commit an active Reach intent; got ${committed.status}`)
  }
  const authorization = composition.runtime.authorizeMechanicalStep(committed.intent.intentId, identity, {
    stepId: `${committed.intent.intentId}:leg:1`,
    effectKind: committed.intent.effectKind,
    resources: {},
    risk: {},
    nowMs: 10_001,
  })
  if (authorization.status !== 'authorized') throw new Error(`expected one mechanical reservation; got ${authorization.status}`)
  const settled = composition.runtime.recordMechanicalStepOutcome(committed.intent.intentId, authorization.stepId, {
    snapshot: snapshotForRoutes(contract, 10_100, offeredRoutes),
  })
  if (settled.status !== 'active') throw new Error(`expected settled mechanical leg; got ${settled.status}`)
  const unverified = snapshotForRoutes(contract, 10_200, offeredRoutes)
  const completed = await composition.runtime.complete(committed.intent.intentId, {
    status: 'completed',
    evidenceId: 'executor:reach-done',
    snapshot: {
      ...unverified,
      observation: {
        ...unverified.observation,
        predicates: {
          ...unverified.observation.predicates,
          [contract.desiredPredicate.id]: { truth: 'true', evidenceId: 'verified:reach-predicate' },
        },
      },
    },
  })
  if (completed.status !== 'terminal') throw new Error(`expected deterministic verified terminal; got ${completed.status}`)
  const handoff = composition.runtime.takeTerminalHandoff()
  if (handoff === null) throw new Error('expected one typed terminal handoff')
  return { context, logs, terminalOutcome: handoff.outcome.kind }
}

test('composition builds the runtime and preserves Jev route telemetry through context-owned callbacks', async () => {
  const requests: JevRequest[] = []
  const policy: JevPolicy = {
    kind: 'typesafe', model: 'test-primary-jev',
    async decide(request) {
      requests.push(request)
      return jevResult('MOVE:oak-b', { 'MOVE:oak-a': 0.2, 'MOVE:oak-b': 0.8 })
    },
  }
  const { context, logs } = makeContext(policy)
  const composition = createJevReachVtrComposition(context)

  assert.ok(composition.runtime instanceof ReachMissionRuntime)
  assert.deepEqual(await composition.routePolicy.chooseRoute(inputFor(contract)), { status: 'selected', routeId: 'MOVE:oak-b' })
  assert.equal(requests.length, 1)
  assert.equal(requests[0]?.decisionFrame?.kind, 'vtr-reach-route')
  assert.equal(context.counters.jevCalls.value, 1)
  assert.ok(context.counters.lastJevAt.value > 0)
  assert.deepEqual(context.lastRouteDecision.value, {
    selectedRouteId: 'MOVE:oak-b', policy: 'typesafe', source: 'jev', model: 'test-primary-jev',
    callId: 'composition-jev-call', probabilities: { 'MOVE:oak-a': 0.2, 'MOVE:oak-b': 0.8 }, providerAttempts: 0, accepted: true,
  })
  assert.equal(logs[0]?.detail.selectedGroundedRouteId, 'MOVE:oak-b')
  assert.equal(logs[0]?.detail.callId, 'composition-jev-call')
  assert.equal(logs[0]?.detail.identity && (logs[0]!.detail.identity as ReachIdentity).leaseId, identity.leaseId)
})

test('terminal Reach model metrics bind frame invocations separately from provider evaluate attempts', async () => {
  const policy: JevPolicy = {
    kind: 'typesafe', model: 'test-primary-jev',
    async decide(request) {
      request.onProviderAttempt?.()
      request.onProviderAttempt?.()
      return { ...jevResult('MOVE:oak-b'), providerAttempts: 2 }
    },
  }
  const { context, logs, terminalOutcome } = await finishMetricsTransition(policy)
  const event = logs.find(({ message }) => message.startsWith('VTR_TRANSITION_MODEL_METRICS '))
  assert.equal(terminalOutcome, 'SUCCESS')
  assert.ok(event, 'one separate typed event records metrics for the completed Transition')
  assert.equal(event?.detail.transitionId, contract.transitionId)
  assert.equal(event?.detail.contractHash, contract.contractHash)
  assert.equal(event?.detail.typedTerminalOutcome, 'SUCCESS')
  assert.equal(event?.detail.mechanicalSteps, 1)
  assert.equal(event?.detail.jevDecisionFrameInvocations, 1, 'counts JevPolicy.decide/Decision Frame invocations')
  assert.equal(event?.detail.jevDecisionFramesPerMechanicalStep, 1)
  assert.equal(event?.detail.jevModelProviderEvaluateAttempts, 2, 'counts actual provider evaluate entries including retries')
  assert.equal(event?.detail.jevModelProviderEvaluateAttemptsPerMechanicalStep, 2)
  assert.equal('jevCallsPerTransition' in (event?.detail ?? {}), false, 'new model metrics do not reuse the legacy Jev call label')
  assert.equal('modelCallsPerMechanicalStep' in (event?.detail ?? {}), false, 'decision frames are not mislabeled as provider model calls')
  assert.equal(context.counters.jevCalls.value, 1, 'legacy Jev call counter remains the Decision Frame invocation count')
})

test('fallback Decision Frame records zero model provider evaluate attempts', async () => {
  const policy: JevPolicy = {
    kind: 'fallback', model: 'offline',
    async decide() {
      return {
        callId: 'fallback-route-call', policy: 'fallback', source: 'fallback', model: 'offline', latencyMs: 0,
        usage: null, answers: { action: answer('MOVE:oak-a') },
      }
    },
  }
  const { context, logs, terminalOutcome } = await finishMetricsTransition(policy)
  const event = logs.find(({ message }) => message.startsWith('VTR_TRANSITION_MODEL_METRICS '))
  assert.equal(terminalOutcome, 'SUCCESS')
  assert.ok(event)
  assert.equal(context.counters.jevCalls.value, 1, 'offline policy invocation remains separately observable')
  assert.equal(event?.detail.jevDecisionFrameInvocations, 1)
  assert.equal(event?.detail.jevModelProviderEvaluateAttempts, 0)
  assert.equal(event?.detail.jevModelProviderEvaluateAttemptsPerMechanicalStep, 0)
})

test('composition fences commit when mutable world identity changes after the snapshot is made', async () => {
  const { context } = makeContext({
    kind: 'typesafe', model: 'not-used-for-single-route',
    async decide() { throw new Error('a single grounded route must not call Jev') },
  })
  const composition = createJevReachVtrComposition(context)
  const plan = composition.runtime.deriveInventoryReachTransition({
    mission: { id: 'mission:oak', kind: 'inventory_at_least', item: 'oak_log', count: 1 },
    interactionReach: 5,
    sourceNames: ['oak_log'],
    identity,
    transitionId: 'composition-commit-transition',
  })
  const route = routeFor(plan.contract, 10_000, 'MOVE:oak-commit')
  const snapshot = startSnapshot(plan.contract, 10_000, route)
  const worldChanged = worldState(10_001)
  context.cachedWorldState.value = {
    ...worldChanged,
    self: { ...worldChanged.self, dimension: 'minecraft:the_nether' },
  } as WorldState
  const result = await composition.runtime.commit(plan.contract, snapshot)

  assert.equal(result.status, 'decision_required')
  if (result.status !== 'decision_required') return
  assert.match(result.reason, /reach_commit_stale_identity_changed/)
  assert.equal(composition.runtime.current, null)
})

test('identity builder and Jev route choice reject stale generation or observation boundaries', async () => {
  const { context } = makeContext({
    kind: 'typesafe', model: 'test-primary-jev',
    async decide() { return jevResult('MOVE:oak-a') },
  })
  const composition = createJevReachVtrComposition(context)

  assert.deepEqual(buildJevReachIdentity(worldState(), context), identity)
  context.generationId = 'replacement-generation'
  assert.deepEqual(await composition.routePolicy.chooseRoute(inputFor(contract)), {
    status: 'unavailable', reason: 'fresh_reach_world_state_unavailable',
  })
  assert.equal(context.counters.jevCalls.value, 0)

  context.generationId = identity.generationId
  context.cachedWorldState.value = worldState(9_999)
  assert.deepEqual(await composition.routePolicy.chooseRoute(inputFor(contract)), {
    status: 'unavailable', reason: 'fresh_reach_world_state_unavailable',
  })
  assert.equal(context.counters.jevCalls.value, 0)
})
