import { expect, test } from 'bun:test'
import { ReachMissionRuntime } from './src/vtr/reach-mission-runtime.ts'
import type { InventoryReachMission } from './src/vtr/reach-scheduler.ts'
import {
  nearestGroundedReachRoutePolicy,
  type ReachRoute,
  type ReachRuntimeSnapshot,
} from './src/vtr/reach-controller.ts'
import { createInventoryReachTransition } from './src/vtr/reach-scheduler.ts'
import type { ReachIdentity } from './src/vtr/reach.ts'

const identity: ReachIdentity = {
  worldKey: 'mission-runtime-world',
  dimension: 'minecraft:overworld',
  worldEpoch: 12,
  generationId: 'mission-runtime-generation',
  leaseId: 'mission-runtime-lease',
}

const mission: InventoryReachMission = {
  id: 'mission-reach-amethyst',
  kind: 'inventory_at_least',
  item: 'amethyst_shard',
  count: 4,
}

function makeSnapshot(atMs: number, ensures: boolean, distance = 10): ReachRuntimeSnapshot {
  // The fixture uses the pure VTR derivation only to prepare a grounded witness
  // and sensor evidence. Production callers submit these facts; the runtime
  // independently derives and commits the contract from the Mission request.
  const { contract } = createInventoryReachTransition({
    mission,
    interactionReach: 4.5,
    sourceNames: ['budding_amethyst', 'amethyst_cluster'],
    identity,
    transitionId: 'transition-amethyst-source-reach',
  })
  const evidenceId = `grounding:${atMs}`
  const route: ReachRoute = {
    routeId: 'approach:amethyst-cluster:7,64,3',
    groundingPredicateId: 'route.amethyst-source-grounded',
    waypointGroundingPredicateId: null,
    witness: {
      witnessId: 'amethyst-cluster:7,64,3',
      target: { x: 7, y: 64, z: 3 },
      desiredPredicateIdentity: contract.desiredPredicateIdentity,
      evidenceId,
      observedIdentity: identity,
      observedAtMs: atMs,
    },
    waypoint: null,
    tactic: 'walk',
    effectKind: 'locomotion',
    estimatedDistance: distance,
    resources: {},
    risk: {},
  }
  return {
    observation: {
      identity,
      observedAtMs: atMs,
      predicates: {
        'mission.unsatisfied': { truth: 'true', evidenceId: `mission:${atMs}` },
        'reach.source-grounded': { truth: 'true', evidenceId: `source-class:${atMs}` },
        'body.alive': { truth: 'true', evidenceId: `health:${atMs}` },
        'reach.resource-source': {
          truth: ensures ? 'true' : 'false',
          evidenceId: ensures ? `verified-reach:${atMs}` : `outside-reach:${atMs}`,
        },
        [route.groundingPredicateId]: { truth: 'true', evidenceId },
      },
    },
    routes: [route],
    progress: {
      predicateDistance: ensures ? 0 : distance,
      reachability: 'reachable',
      frontierId: route.routeId,
      evidenceId: `reach-progress:${atMs}`,
    },
  }
}

test('Mission-to-Reach derives a generic resource predicate without benchmark ladder input', async () => {
  let freshnessChecks = 0
  const runtime = new ReachMissionRuntime({
    routePolicy: nearestGroundedReachRoutePolicy,
    commitFreshnessFence: ({ contract }) => {
      freshnessChecks += 1
      expect(contract.transitionId).toBe('transition-amethyst-source-reach')
      return { status: 'current' }
    },
  })
  const snapshot = makeSnapshot(1_000, false)
  const started = await runtime.startInventoryReach({
    mission,
    interactionReach: 4.5,
    sourceNames: ['budding_amethyst', 'amethyst_cluster'],
    identity,
    transitionId: 'transition-amethyst-source-reach',
    snapshotForContract: (contract) => {
      expect(contract.desiredPredicate.proposition).toMatchObject({ item: 'amethyst_shard' })
      return snapshot
    },
  })

  expect(started.contract.desiredPredicate.proposition).toMatchObject({
    kind: 'within-interaction-reach-of-resource-source',
    item: 'amethyst_shard',
    sourceNames: ['amethyst_cluster', 'budding_amethyst'],
  })
  expect(started.contract.requires.some((predicate) => JSON.stringify(predicate.proposition).includes('amethyst_shard'))).toBe(true)
  expect(started.contract.ensures).toContainEqual(started.contract.desiredPredicate)
  expect(JSON.stringify(started.contract)).not.toMatch(/M2|M3|RUNGS|ladder/i)
  expect(started.result.status).toBe('active')
  expect(freshnessChecks).toBe(1)
})

test('stale commit fence prevents the VTR Mission runtime from acquiring Reach ownership', async () => {
  const runtime = new ReachMissionRuntime({
    routePolicy: nearestGroundedReachRoutePolicy,
    commitFreshnessFence: () => ({ status: 'stale', reason: 'observation_advanced', currentObservedAtMs: 2_000 }),
  })
  const started = await runtime.startInventoryReach({
    mission,
    interactionReach: 4.5,
    sourceNames: ['budding_amethyst', 'amethyst_cluster'],
    identity,
    transitionId: 'transition-amethyst-source-reach',
    snapshotForContract: () => makeSnapshot(1_000, false),
  })
  expect(started.result.status).toBe('decision_required')
  expect(runtime.current).toBeNull()
})

test('committed Reach continues the same contract through policy outage and succeeds only on verified predicate', async () => {
  let policyCalls = 0
  const runtime = new ReachMissionRuntime({
    routePolicy: {
      async chooseRoute() {
        policyCalls += 1
        throw new Error('Jev provider unavailable')
      },
    },
    commitFreshnessFence: () => ({ status: 'current' }),
  })

  const started = await runtime.startInventoryReach({
    mission,
    interactionReach: 4.5,
    sourceNames: ['budding_amethyst', 'amethyst_cluster'],
    identity,
    transitionId: 'transition-amethyst-source-reach',
    snapshotForContract: () => makeSnapshot(1_000, false),
  })
  expect(started.result.status).toBe('active')
  if (started.result.status !== 'active' || started.result.intent === undefined) throw new Error('expected a committed mechanical intent')
  const firstIntent = started.result.intent
  expect(runtime.current?.contract.contractHash).toBe(started.contract.contractHash)

  const completion = await runtime.complete(firstIntent.intentId, {
    status: 'completed',
    evidenceId: 'walk-completed-without-postcondition',
    snapshot: makeSnapshot(2_000, false, 6),
  })
  expect(completion.status).toBe('active')
  if (completion.status !== 'active') throw new Error('expected same-contract completion continuation')
  expect(completion.phase).toBe('waiting')
  expect(runtime.current?.contract.contractHash).toBe(started.contract.contractHash)
  expect(completion.state.terminalOutcome).toBeNull()

  const continued = await runtime.tick(makeSnapshot(3_000, false, 3))
  expect(continued.status).toBe('active')
  if (continued.status !== 'active' || continued.intent === undefined) throw new Error('expected continuation intent during policy outage')
  expect(continued.phase).toBe('actuate')
  expect(continued.contractHash).toBe(started.contract.contractHash)
  expect(continued.intent.transitionId).toBe(firstIntent.transitionId)
  expect(policyCalls).toBe(0)

  const reservation = runtime.authorizeMechanicalStep(continued.intent.intentId, identity, {
    stepId: `${continued.intent.intentId}:leg:1`,
    effectKind: continued.intent.effectKind,
    resources: {},
    risk: {},
    nowMs: 3_001,
  })
  expect(reservation.status).toBe('authorized')
  if (reservation.status !== 'authorized') throw new Error('expected mechanical step reservation')
  const settled = runtime.recordMechanicalStepOutcome(continued.intent.intentId, reservation.stepId, {
    snapshot: makeSnapshot(4_000, false, 1),
  })
  expect(settled.status).toBe('active')

  const verified = await runtime.tick(makeSnapshot(5_000, true, 0))
  expect(verified.status).toBe('terminal')
  if (verified.status !== 'terminal') throw new Error('expected deterministic verified SUCCESS')
  expect(verified.outcome.kind).toBe('SUCCESS')
  if (verified.outcome.kind !== 'SUCCESS') throw new Error('expected SUCCESS outcome')
  expect(verified.outcome.contractHash).toBe(started.contract.contractHash)
  expect(verified.outcome.evidenceIds).toContain('verified-reach:5000')
  expect(runtime.current).toBeNull()

  const handoff = runtime.takeTerminalHandoff()
  expect(handoff?.contractHash).toBe(started.contract.contractHash)
  expect(handoff?.outcome).toEqual(verified.outcome)
  expect(handoff?.state.status).toBe('terminal')
  expect(runtime.takeTerminalHandoff()).toBeNull()
  expect(policyCalls).toBe(0)
})
