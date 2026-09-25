import { expect, test } from 'bun:test'
import { ReachMissionRuntime } from './src/vtr/reach-mission-runtime.ts'
import type { ReachMissionRuntimeFrame } from './src/vtr/reach-mission-runtime.ts'
import type { InventoryReachMission } from './src/vtr/reach-scheduler.ts'
import {
  nearestGroundedReachRoutePolicy,
  type ReachRouteDecisionPolicy,
  type ReachRoute,
  type ReachRuntimeSnapshot,
} from './src/vtr/reach-controller.ts'
import type { ReachIdentity, ReachTransitionContract } from './src/vtr/reach.ts'

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

function makeRoute(
  contract: ReachTransitionContract,
  atMs: number,
  routeId: string,
  witnessId: string,
  target: { readonly x: number; readonly y: number; readonly z: number },
): ReachRoute {
  const evidenceId = `grounding:${routeId}:${atMs}`
  return {
    routeId,
    groundingPredicateId: `predicate:${routeId}`,
    waypointGroundingPredicateId: null,
    witness: {
      witnessId,
      target,
      desiredPredicateIdentity: contract.desiredPredicateIdentity,
      evidenceId,
      observedIdentity: contract.identity,
      observedAtMs: atMs,
    },
    waypoint: null,
    tactic: 'walk',
    effectKind: 'locomotion',
    estimatedDistance: 10,
    resources: {},
    risk: {},
  }
}

function makeSnapshot(
  contract: ReachTransitionContract,
  atMs: number,
  ensures: boolean,
  distance = 10,
  routes: readonly ReachRoute[] = [makeRoute(
    contract,
    atMs,
    'approach:amethyst-cluster:7,64,3',
    'amethyst-cluster:7,64,3',
    { x: 7, y: 64, z: 3 },
  )],
  infeasibility?: { readonly reason: string; readonly evidenceId: string },
): ReachRuntimeSnapshot {
  return {
    observation: {
      identity: contract.identity,
      observedAtMs: atMs,
      predicates: {
        'mission.unsatisfied': { truth: 'true', evidenceId: `mission:${atMs}` },
        'reach.source-grounded': { truth: 'true', evidenceId: `source-class:${atMs}` },
        'body.alive': { truth: 'true', evidenceId: `health:${atMs}` },
        'reach.resource-source': {
          truth: ensures ? 'true' : 'false',
          evidenceId: ensures ? `verified-reach:${atMs}` : `outside-reach:${atMs}`,
        },
        ...Object.fromEntries(routes.map((route) => [
          route.groundingPredicateId,
          { truth: 'true', evidenceId: route.witness.evidenceId },
        ])),
      },
    },
    routes,
    progress: {
      predicateDistance: ensures ? 0 : distance,
      reachability: 'reachable',
      frontierId: routes[0]?.routeId ?? null,
      evidenceId: `reach-progress:${atMs}`,
    },
    ...(infeasibility === undefined ? {} : { infeasibility }),
  }
}

function derive(runtime: ReachMissionRuntime, overrides: {
  readonly mission?: InventoryReachMission
  readonly identity?: ReachIdentity
  readonly transitionId?: string
} = {}) {
  const selectedMission = overrides.mission ?? mission
  return runtime.deriveInventoryReachTransition({
    mission: selectedMission,
    interactionReach: 4.5,
    sourceNames: selectedMission.item === mission.item
      ? ['budding_amethyst', 'amethyst_cluster']
      : [selectedMission.item],
    identity: overrides.identity ?? identity,
    transitionId: overrides.transitionId ?? 'transition-amethyst-source-reach',
  })
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
  const plan = derive(runtime)
  const snapshot = makeSnapshot(plan.contract, 1_000, false)
  expect(plan.contract.desiredPredicate.proposition).toMatchObject({ item: 'amethyst_shard' })
  const result = await runtime.commit(plan.contract, snapshot)

  expect(plan.contract.desiredPredicate.proposition).toMatchObject({
    kind: 'within-interaction-reach-of-resource-source',
    item: 'amethyst_shard',
    sourceNames: ['amethyst_cluster', 'budding_amethyst'],
  })
  expect(plan.contract.requires.some((predicate) => JSON.stringify(predicate.proposition).includes('amethyst_shard'))).toBe(true)
  expect(plan.contract.ensures).toContainEqual(plan.contract.desiredPredicate)
  expect(JSON.stringify(plan.contract)).not.toMatch(/M2|M3|RUNGS|ladder/i)
  expect(result.status).toBe('active')
  expect(freshnessChecks).toBe(1)
})

test('stale commit fence prevents the VTR Mission runtime from acquiring Reach ownership', async () => {
  const runtime = new ReachMissionRuntime({
    routePolicy: nearestGroundedReachRoutePolicy,
    commitFreshnessFence: () => ({ status: 'stale', reason: 'observation_advanced', currentObservedAtMs: 2_000 }),
  })
  const plan = derive(runtime)
  const result = await runtime.commit(plan.contract, makeSnapshot(plan.contract, 1_000, false))
  expect(result.status).toBe('decision_required')
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

  const plan = derive(runtime)
  const started = await runtime.commit(plan.contract, makeSnapshot(plan.contract, 1_000, false))
  expect(started.status).toBe('active')
  if (started.status !== 'active' || started.intent === undefined) throw new Error('expected a committed mechanical intent')
  const firstIntent = started.intent
  expect(runtime.current?.contract.contractHash).toBe(plan.contract.contractHash)

  const completion = await runtime.complete(firstIntent.intentId, {
    status: 'completed',
    evidenceId: 'walk-completed-without-postcondition',
    snapshot: makeSnapshot(plan.contract, 2_000, false, 6),
  })
  expect(completion.status).toBe('active')
  if (completion.status !== 'active') throw new Error('expected same-contract completion continuation')
  expect(completion.phase).toBe('waiting')
  expect(runtime.current?.contract.contractHash).toBe(plan.contract.contractHash)
  expect(completion.state.terminalOutcome).toBeNull()

  const continued = await runtime.tick(makeSnapshot(plan.contract, 3_000, false, 3))
  expect(continued.status).toBe('active')
  if (continued.status !== 'active' || continued.intent === undefined) throw new Error('expected continuation intent during policy outage')
  expect(continued.phase).toBe('actuate')
  expect(continued.contractHash).toBe(plan.contract.contractHash)
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
    snapshot: makeSnapshot(plan.contract, 4_000, false, 1),
  })
  expect(settled.status).toBe('active')

  const verified = await runtime.tick(makeSnapshot(plan.contract, 5_000, true, 0))
  expect(verified.status).toBe('terminal')
  if (verified.status !== 'terminal') throw new Error('expected deterministic verified SUCCESS')
  expect(verified.outcome.kind).toBe('SUCCESS')
  if (verified.outcome.kind !== 'SUCCESS') throw new Error('expected SUCCESS outcome')
  expect(verified.outcome.contractHash).toBe(plan.contract.contractHash)
  expect(verified.outcome.evidenceIds).toContain('verified-reach:5000')
  expect(runtime.current).toBeNull()

  const handoff = runtime.takeTerminalHandoff()
  expect(handoff?.contractHash).toBe(plan.contract.contractHash)
  expect(handoff?.outcome).toEqual(verified.outcome)
  expect(handoff?.state.status).toBe('terminal')
  expect(runtime.takeTerminalHandoff()).toBeNull()
  expect(policyCalls).toBe(0)
})

test('same mission and world exclude the prior terminal witness before route policy selection', async () => {
  const offeredRouteIds: string[][] = []
  const runtime = new ReachMissionRuntime({
    routePolicy: {
      async chooseRoute({ routes }) {
        offeredRouteIds.push(routes.map(({ routeId }) => routeId))
        return { status: 'selected', routeId: 'route:alternative-a' }
      },
    } satisfies ReachRouteDecisionPolicy,
    commitFreshnessFence: () => ({ status: 'current' }),
  })

  const firstPlan = derive(runtime, { transitionId: 'transition-terminal-witness' })
  const blockedRoute = makeRoute(firstPlan.contract, 1_000, 'route:blocked', 'witness:blocked', { x: 7, y: 64, z: 3 })
  const terminal = await runtime.commit(firstPlan.contract, makeSnapshot(firstPlan.contract, 1_000, false, 10, [blockedRoute], {
    reason: 'source witness is deterministically infeasible',
    evidenceId: 'infeasible:blocked-witness',
  }))
  expect(terminal.status).toBe('terminal')
  if (terminal.status !== 'terminal') throw new Error('expected proven infeasibility')
  expect(terminal.outcome.kind).toBe('PROVEN_INFEASIBLE')
  expect(runtime.takeTerminalHandoff()?.state.witness?.witnessId).toBe('witness:blocked')

  const nextPlan = derive(runtime, { transitionId: 'transition-after-terminal-witness' })
  const routes = [
    makeRoute(nextPlan.contract, 2_000, 'route:blocked-retry', 'witness:blocked', { x: 7, y: 64, z: 3 }),
    makeRoute(nextPlan.contract, 2_000, 'route:alternative-a', 'witness:alternative-a', { x: 8, y: 64, z: 3 }),
    makeRoute(nextPlan.contract, 2_000, 'route:alternative-b', 'witness:alternative-b', { x: 9, y: 64, z: 3 }),
  ]
  const result = await runtime.commit(nextPlan.contract, makeSnapshot(nextPlan.contract, 2_000, false, 10, routes))

  expect(result.status).toBe('active')
  expect(offeredRouteIds).toEqual([['route:alternative-a', 'route:alternative-b']])
  expect(runtime.current?.route.routeId).toBe('route:alternative-a')
})

test('changed Mission or world scope allows a route to reuse the prior witness id', async () => {
  const setupRuntimeWithExcludedWitness = async (suffix: string) => {
    const runtime = new ReachMissionRuntime({
      routePolicy: {
        async chooseRoute({ routes }) {
          return { status: 'selected', routeId: routes[0]!.routeId }
        },
      },
      commitFreshnessFence: () => ({ status: 'current' }),
    })
    const firstPlan = derive(runtime, { transitionId: `transition-terminal-${suffix}` })
    const blockedRoute = makeRoute(firstPlan.contract, 1_000, 'route:blocked', 'witness:reusable', { x: 7, y: 64, z: 3 })
    const terminal = await runtime.commit(firstPlan.contract, makeSnapshot(firstPlan.contract, 1_000, false, 10, [blockedRoute], {
      reason: 'source witness is deterministically infeasible',
      evidenceId: `infeasible:${suffix}`,
    }))
    expect(terminal.status).toBe('terminal')
    runtime.takeTerminalHandoff()
    return runtime
  }

  const changedMission = { ...mission, id: 'mission-reach-oak', item: 'oak_log' }
  const missionRuntime = await setupRuntimeWithExcludedWitness('mission')
  const changedMissionPlan = derive(missionRuntime, {
    mission: changedMission,
    transitionId: 'transition-changed-mission',
  })
  const missionRoute = makeRoute(changedMissionPlan.contract, 2_000, 'route:reused-witness-new-mission', 'witness:reusable', { x: 7, y: 64, z: 3 })
  const missionResult = await missionRuntime.commit(
    changedMissionPlan.contract,
    makeSnapshot(changedMissionPlan.contract, 2_000, false, 10, [missionRoute]),
  )
  expect(missionResult.status).toBe('active')
  expect(missionRuntime.current?.route.witness.witnessId).toBe('witness:reusable')

  const worldRuntime = await setupRuntimeWithExcludedWitness('world')
  const changedWorld: ReachIdentity = { ...identity, worldKey: 'mission-runtime-world-next', worldEpoch: 13 }
  const changedWorldPlan = derive(worldRuntime, {
    identity: changedWorld,
    transitionId: 'transition-changed-world',
  })
  const worldRoute = makeRoute(changedWorldPlan.contract, 2_000, 'route:reused-witness-new-world', 'witness:reusable', { x: 7, y: 64, z: 3 })
  const worldResult = await worldRuntime.commit(
    changedWorldPlan.contract,
    makeSnapshot(changedWorldPlan.contract, 2_000, false, 10, [worldRoute]),
  )
  expect(worldResult.status).toBe('active')
  expect(worldRuntime.current?.route.witness.witnessId).toBe('witness:reusable')
})

function driveFrame(
  runtime: ReachMissionRuntime,
  atMs: number,
  overrides: Partial<ReachMissionRuntimeFrame> = {},
): ReachMissionRuntimeFrame {
  const plan = derive(runtime, { transitionId: 'transition-production-drive' })
  const snapshot = makeSnapshot(plan.contract, atMs, false, 8)
  return {
    mission,
    snapshot,
    interactionReach: 4.5,
    sourceNames: ['amethyst_cluster', 'budding_amethyst'],
    transitionId: 'transition-production-drive',
    probe: false,
    schedulerOwner: 'mission',
    actuationLease: { status: 'owned', leaseId: identity.leaseId },
    activeAction: null,
    activeActionMatchesMissionReach: false,
    safeToStart: true,
    observedHealth: 20,
    counters: { jevCalls: 0, system2Calls: 0, authorityConflicts: 0, nonVtrActuations: 0 },
    ...overrides,
  }
}

test('production Mission drive owns one active Transition through outage and verifies SUCCESS only from ensures', async () => {
  let policyCalls = 0
  const runtime = new ReachMissionRuntime({
    routePolicy: { async chooseRoute() { policyCalls += 1; throw new Error('Jev unavailable') } },
    commitFreshnessFence: () => ({ status: 'current' }),
  })
  const first = await runtime.driveMission(driveFrame(runtime, 1_000))
  expect(first.kind).toBe('transition')
  if (first.kind !== 'transition' || first.result.status !== 'active') throw new Error('expected committed active Transition')
  const transitionId = first.result.transitionId
  const contractHash = first.contract.contractHash
  expect(first.started).toBe(true)
  expect(first.dispatch).toBe(true)
  expect(runtime.missionSession?.mission).toEqual(mission)

  const continuedFrame = driveFrame(runtime, 2_000, {
    snapshot: makeSnapshot(first.contract, 2_000, false, 5),
  })
  if (first.result.status !== 'active' || first.result.intent === undefined) throw new Error('expected first mechanical intent')
  const settled = await runtime.complete(first.result.intent.intentId, {
    status: 'completed',
    evidenceId: 'walk-leg-settled-without-ensures',
    snapshot: continuedFrame.snapshot,
  })
  expect(settled.status).toBe('active')
  const continued = await runtime.driveMission(driveFrame(runtime, 3_000, {
    snapshot: makeSnapshot(first.contract, 3_000, false, 4),
  }))
  expect(continued.kind).toBe('transition')
  if (continued.kind !== 'transition' || continued.result.status !== 'active') throw new Error('expected same active Transition')
  expect(continued.started).toBe(false)
  expect(continued.result.transitionId).toBe(transitionId)
  expect(continued.contract.contractHash).toBe(contractHash)
  expect(continued.dispatch).toBe(true)
  expect(policyCalls).toBe(0)

  const verifiedFrame = driveFrame(runtime, 3_000, {
    snapshot: makeSnapshot(first.contract, 4_000, true, 0),
  })
  const verified = await runtime.driveMission(verifiedFrame)
  expect(verified.kind).toBe('transition')
  if (verified.kind !== 'transition' || verified.result.status !== 'terminal') throw new Error('expected deterministic terminal verification')
  expect(verified.result.outcome.kind).toBe('SUCCESS')
  if (verified.result.outcome.kind !== 'SUCCESS') throw new Error('expected verified SUCCESS outcome')
  expect(verified.result.outcome.evidenceIds).toContain('verified-reach:4000')
  const handoff = runtime.takeTerminalHandoff()
  expect(handoff?.session?.transitionId).toBe(transitionId)
  expect(runtime.missionSession).toBeNull()
  expect(policyCalls).toBe(0)
})

test('production Mission drive returns typed stale-world and lease-loss boundaries', async () => {
  const mismatchRuntime = new ReachMissionRuntime({ routePolicy: nearestGroundedReachRoutePolicy, commitFreshnessFence: () => ({ status: 'current' }) })
  const leaseMismatch = await mismatchRuntime.driveMission(driveFrame(mismatchRuntime, 1_000, {
    actuationLease: { status: 'owned', leaseId: 'different-lease' },
  }))
  expect(leaseMismatch).toMatchObject({ kind: 'declined', reason: 'lease-identity-mismatch' })
  expect(mismatchRuntime.current).toBeNull()

  const worldRuntime = new ReachMissionRuntime({ routePolicy: nearestGroundedReachRoutePolicy, commitFreshnessFence: () => ({ status: 'current' }) })
  const started = await worldRuntime.driveMission(driveFrame(worldRuntime, 1_000))
  if (started.kind !== 'transition' || started.result.status !== 'active') throw new Error('expected active Transition')
  const changedIdentity: ReachIdentity = { ...identity, worldKey: 'mission-runtime-next-world', worldEpoch: identity.worldEpoch + 1 }
  const changedSnapshot = {
    ...makeSnapshot(started.contract, 2_000, false),
    observation: { ...makeSnapshot(started.contract, 2_000, false).observation, identity: changedIdentity },
  }
  const staleWorld = await worldRuntime.driveMission(driveFrame(worldRuntime, 2_000, { snapshot: changedSnapshot }))
  expect(staleWorld.kind).toBe('transition')
  if (staleWorld.kind !== 'transition' || staleWorld.result.status !== 'terminal') throw new Error('expected world identity terminal')
  expect(staleWorld.result.outcome.kind).toBe('WORLD_CHANGED')

  const leaseRuntime = new ReachMissionRuntime({ routePolicy: nearestGroundedReachRoutePolicy, commitFreshnessFence: () => ({ status: 'current' }) })
  const leaseStart = await leaseRuntime.driveMission(driveFrame(leaseRuntime, 1_000))
  if (leaseStart.kind !== 'transition' || leaseStart.result.status !== 'active') throw new Error('expected active Transition')
  const leaseLost = await leaseRuntime.driveMission(driveFrame(leaseRuntime, 2_000, {
    snapshot: makeSnapshot(leaseStart.contract, 2_000, false),
    actuationLease: {
      status: 'lost',
      expectedLeaseId: identity.leaseId,
      observedLeaseId: 'lease-denied:fixture',
      reason: 'fixture lease lost',
    },
  }))
  expect(leaseLost.kind).toBe('transition')
  if (leaseLost.kind !== 'transition' || leaseLost.result.status !== 'terminal') throw new Error('expected lease terminal')
  expect(leaseLost.result.outcome.kind).toBe('LEASE_LOST')

  const budgetRuntime = new ReachMissionRuntime({ routePolicy: nearestGroundedReachRoutePolicy, commitFreshnessFence: () => ({ status: 'current' }) })
  const budgetStart = await budgetRuntime.driveMission(driveFrame(budgetRuntime, 1_000))
  if (budgetStart.kind !== 'transition' || budgetStart.result.status !== 'active') throw new Error('expected active Transition')
  const exhausted = await budgetRuntime.driveMission(driveFrame(budgetRuntime, 2_000, {
    snapshot: makeSnapshot(budgetStart.contract, 2_000, false),
    observedHealth: 18,
  }))
  expect(exhausted.kind).toBe('transition')
  if (exhausted.kind !== 'transition' || exhausted.result.status !== 'terminal') throw new Error('expected typed risk-budget terminal')
  expect(exhausted.result.outcome.kind).toBe('BUDGET_EXHAUSTED')
})

test('production Mission drive revokes legacy Reach ownership before commit and terminalizes foreign active authority', async () => {
  const runtime = new ReachMissionRuntime({ routePolicy: nearestGroundedReachRoutePolicy, commitFreshnessFence: () => ({ status: 'current' }) })
  const plan = derive(runtime, { transitionId: 'transition-production-drive' })
  const legacyAction = {
    id: 'legacy-walk', kind: 'MOVE' as const, epoch: 5, status: 'running' as const,
    authority: 'legacy' as const, transitionId: undefined,
  }
  const blocked = await runtime.driveMission(driveFrame(runtime, 1_000, {
    snapshot: makeSnapshot(plan.contract, 1_000, false),
    activeAction: legacyAction,
    activeActionMatchesMissionReach: true,
  }))
  expect(blocked).toMatchObject({ kind: 'revoke-action', reason: 'legacy-reach-handoff' })
  expect(runtime.current).toBeNull()

  const started = await runtime.driveMission(driveFrame(runtime, 2_000, { snapshot: makeSnapshot(plan.contract, 2_000, false) }))
  if (started.kind !== 'transition' || started.result.status !== 'active') throw new Error('expected start after legacy lease release')
  const foreignAction = { ...legacyAction, id: 'legacy-raced-back-in', epoch: 6 }
  const conflict = await runtime.driveMission(driveFrame(runtime, 3_000, {
    snapshot: makeSnapshot(started.contract, 3_000, false),
    activeAction: foreignAction,
  }))
  expect(conflict.kind).toBe('transition')
  if (conflict.kind !== 'transition' || conflict.result.status !== 'terminal') throw new Error('expected typed double-authority boundary')
  expect(conflict.result.outcome.kind).toBe('CONTRACT_SUPERSEDED')
  expect(conflict.cancelAction).toBe(true)
  expect(runtime.missionSession?.duplicateAuthorityObserved).toBe(true)
})

test('a missing Jev admission choice stays a typed VTR hold with no legacy semantic fallback', async () => {
  const runtime = new ReachMissionRuntime({
    routePolicy: { async chooseRoute() { throw new Error('Jev provider unavailable') } },
    commitFreshnessFence: () => ({ status: 'current' }),
  })
  const plan = derive(runtime, { transitionId: 'transition-production-drive' })
  const routes = [
    makeRoute(plan.contract, 1_000, 'route:choice-a', 'witness:choice-a', { x: 7, y: 64, z: 3 }),
    makeRoute(plan.contract, 1_000, 'route:choice-b', 'witness:choice-b', { x: 8, y: 64, z: 3 }),
  ]
  const result = await runtime.driveMission(driveFrame(runtime, 1_000, {
    snapshot: makeSnapshot(plan.contract, 1_000, false, 10, routes),
  }))
  expect(result).toMatchObject({ kind: 'held', reason: 'route-decision-required' })
  expect(runtime.current).toBeNull()
  expect(runtime.missionSession).toBeNull()
})
