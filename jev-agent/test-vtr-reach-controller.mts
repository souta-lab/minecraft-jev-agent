import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'bun:test'
import {
  ReachController,
  nearestGroundedReachRoutePolicy,
  type ReachRoute,
  type ReachRuntimeSnapshot,
} from './src/vtr/reach-controller.ts'
import {
  createReachTransitionContract,
  type ReachIdentity,
  type ReachObservation,
  type ReachTransitionContract,
} from './src/vtr/reach.ts'

const identity: ReachIdentity = {
  worldKey: 'probe-world-1',
  dimension: 'minecraft:overworld',
  worldEpoch: 3,
  generationId: 'generation-probe-1',
  leaseId: 'lease-probe-1',
}

const contract: ReachTransitionContract = createReachTransitionContract({
  transitionId: 'reach-village-1',
  desiredPredicate: {
    id: 'mission.at-village',
    proposition: { relation: 'within_radius', target: 'village', radius: 8 },
    expected: true,
  },
  requires: [{ id: 'world.loaded', proposition: { loaded: true }, expected: true }],
  ensures: [{ id: 'mission.at-village', proposition: { relation: 'within_radius', target: 'village', radius: 8 }, expected: true }],
  invariants: [{ id: 'body.alive', proposition: { healthAbove: 0 }, expected: true }],
  admissibleEffects: [{ kind: 'locomotion', maxUses: null }, { kind: 'bounded_terrain_adaptation', maxUses: 3 }],
  budget: { maxMechanicalSteps: 8, maxElapsedMs: 60_000, resources: { food: 4 }, risk: { damage: 5 } },
  controller: {
    allowedTactics: ['walk', 'path_replan', 'jump', 'detour', 'bounded_terrain_adaptation'],
    allowTemporaryWaypointChanges: true,
    allowWitnessSubstitution: true,
  },
  identity,
})

function makeRoute(routeId: string, at: number, x: number, distance: number): ReachRoute {
  const evidenceId = `evidence:${routeId}:${at}`
  return {
    routeId,
    groundingPredicateId: `route.grounded.${routeId}`,
    waypointGroundingPredicateId: `waypoint.grounded.${routeId}`,
    witness: {
      witnessId: `village-edge:${routeId}`,
      target: { x, y: 64, z: 12 },
      desiredPredicateIdentity: contract.desiredPredicateIdentity,
      evidenceId,
      observedIdentity: identity,
      observedAtMs: at,
    },
    waypoint: { waypointId: `waypoint:${routeId}`, target: { x: x - 1, y: 64, z: 12 }, evidenceId },
    tactic: routeId === 'route-a' ? 'walk' : 'path_replan',
    effectKind: 'locomotion',
    estimatedDistance: distance,
    resources: {},
    risk: {},
  }
}

function makeObservation(at: number, reached: boolean, route?: ReachRoute): ReachObservation {
  const predicates: Record<string, { truth: 'true' | 'false'; evidenceId: string }> = {
    'world.loaded': { truth: 'true', evidenceId: `world:${at}` },
    'body.alive': { truth: 'true', evidenceId: `alive:${at}` },
    'mission.at-village': { truth: reached ? 'true' : 'false', evidenceId: `mission:${at}` },
  }
  if (route !== undefined) predicates[route.groundingPredicateId] = { truth: 'true', evidenceId: route.witness.evidenceId }
  return { identity, observedAtMs: at, predicates }
}

function makeSnapshot(at: number, reached: boolean, routes: readonly ReachRoute[]): ReachRuntimeSnapshot {
  const observation = makeObservation(at, reached)
  const predicates = { ...observation.predicates }
  for (const route of routes) {
    predicates[route.groundingPredicateId] = { truth: 'true', evidenceId: route.witness.evidenceId }
    if (route.waypoint !== null && route.waypointGroundingPredicateId !== null) {
      predicates[route.waypointGroundingPredicateId] = { truth: 'true', evidenceId: route.waypoint.evidenceId }
    }
  }
  return {
    observation: { ...observation, predicates },
    routes,
    progress: {
      predicateDistance: reached ? 0 : routes.length > 0 ? Math.min(...routes.map(({ estimatedDistance }) => estimatedDistance)) : null,
      reachability: routes.length > 0 ? 'reachable' : 'unknown',
      frontierId: routes[0]?.routeId ?? null,
      evidenceId: `progress:${at}`,
    },
  }
}

describe('raw-client-free VTR Reach controller', () => {
  it('keeps one committed contract through witness/waypoint substitution and verifies only from facts', async () => {
    const firstRoute = makeRoute('route-a', 1_000, 20, 20)
    const routePolicy = { calls: 0 }
    const controller = new ReachController({
      async chooseRoute() {
        routePolicy.calls += 1
        return { status: 'unavailable', reason: 'unexpected policy call' }
      },
    })

    const first = await controller.commit(contract, makeSnapshot(1_000, false, [firstRoute]))
    assert.equal(first.status, 'active')
    assert.equal(first.phase, 'actuate')
    if (first.status !== 'active' || first.intent === undefined) throw new Error('expected initial mechanical intent')
    assert.equal(routePolicy.calls, 0, 'one grounded route must not require Jev')
    const originalIntent = first.intent

    const staleTruth = await controller.tick(makeSnapshot(999, true, []))
    assert.equal(staleTruth.status, 'active')
    if (staleTruth.status !== 'active') throw new Error('stale observations must not close the contract')
    assert.equal(staleTruth.phase, 'waiting')
    assert.equal(controller.currentOutcome, null)

    const step1 = controller.authorizeMechanicalStep(originalIntent.intentId, identity, {
      stepId: 'step-1', effectKind: 'locomotion', resources: {}, risk: {}, nowMs: 1_001,
    })
    assert.equal(step1.status, 'authorized')
    const doubleStep = controller.authorizeMechanicalStep(originalIntent.intentId, identity, {
      stepId: 'step-duplicate-live', effectKind: 'locomotion', resources: {}, risk: {}, nowMs: 1_001,
    })
    assert.equal(doubleStep.status, 'refused', 'one controller cannot authorize overlapping body actions')

    const replacement = makeRoute('route-b', 1_002, 29, 11)
    const settled = controller.recordMechanicalStepOutcome(originalIntent.intentId, 'step-1', {
      snapshot: makeSnapshot(1_002, false, [replacement]),
      observedRisk: { damage: 0.25 },
    })
    assert.equal(settled.status, 'active')
    if (settled.status !== 'active') throw new Error('mechanical settlement must leave contract active')
    assert.equal(settled.phase, 'waiting', 'settling one leg does not close the Transition')

    const continued = await controller.complete(originalIntent.intentId, {
      status: 'completed',
      evidenceId: 'executor-says-walk-ended',
      snapshot: makeSnapshot(1_003, false, [makeRoute('route-b', 1_003, 29, 11)]),
    })
    assert.equal(continued.status, 'active')
    if (continued.status !== 'active') throw new Error('expected controller-owned continuation')
    assert.equal(continued.phase, 'waiting', 'completion verifies facts but waits for a newer snapshot before another dispatch')
    const replacementAt1004 = makeRoute('route-b', 1_004, 29, 11)
    const next = await controller.tick(makeSnapshot(1_004, false, [replacementAt1004]))
    assert.equal(next.status, 'active')
    if (next.status !== 'active' || next.intent === undefined) throw new Error(`expected controller-owned continuation; got ${JSON.stringify(next)}`)
    assert.equal(next.phase, 'actuate')
    assert.equal(next.contractHash, contract.contractHash)
    assert.equal(next.state.usage.mechanicalSteps, 1)
    assert.equal(next.state.witness?.witnessId, replacementAt1004.witness.witnessId)
    assert.equal(next.state.temporaryWaypoint?.waypointId, replacementAt1004.waypoint?.waypointId)
    assert.equal(routePolicy.calls, 0, 'a unique replacement route stays inside the active contract')
    const secondIntent = next.intent

    const step2 = controller.authorizeMechanicalStep(secondIntent.intentId, identity, {
      stepId: 'step-2', effectKind: 'locomotion', resources: {}, risk: {}, nowMs: 1_004,
    })
    assert.equal(step2.status, 'authorized')
    controller.recordMechanicalStepOutcome(secondIntent.intentId, 'step-2', {
      snapshot: makeSnapshot(1_005, false, [makeRoute('route-b', 1_005, 29, 11)]),
    })

    // The executor reports completion again, but world truth still says the predicate is false.
    const third = await controller.complete(secondIntent.intentId, {
      status: 'completed',
      evidenceId: 'executor-says-path-ended',
      snapshot: makeSnapshot(1_006, false, [makeRoute('route-b', 1_006, 29, 11)]),
    })
    assert.equal(third.status, 'active')
    if (third.status !== 'active') throw new Error('expected same-contract continuation')
    const thirdIntentResult = await controller.tick(makeSnapshot(1_008, false, [makeRoute('route-b', 1_008, 29, 11)]))
    assert.equal(thirdIntentResult.status, 'active')
    if (thirdIntentResult.status !== 'active' || thirdIntentResult.intent === undefined) throw new Error('expected same-contract continuation')
    assert.equal(controller.current?.contract.contractHash, contract.contractHash)
    assert.equal(thirdIntentResult.state.usage.mechanicalSteps, 2)

    const success = await controller.tick(makeSnapshot(1_009, true, []))
    assert.equal(success.status, 'terminal')
    if (success.status !== 'terminal') throw new Error('expected terminal verified result')
    assert.equal(success.outcome.kind, 'SUCCESS')
    assert.equal(success.outcome.kind === 'SUCCESS' ? success.outcome.desiredPredicateIdentity : '', contract.desiredPredicateIdentity)
    assert.equal(success.cancelIntentId, thirdIntentResult.intent.intentId, 'VERIFY cancels a still-running realization when predicate becomes true')
    assert.equal(controller.current, null)
    assert.equal(controller.takeOutcome()?.kind, 'SUCCESS')
    assert.equal(controller.currentOutcome, null)
  })

  it('requires explicit choice for multiple grounded routes and offers a configured no-LLM policy', async () => {
    const near = makeRoute('near', 2_000, 4, 4)
    const far = makeRoute('far', 2_000, 25, 25)
    const multi = makeSnapshot(2_000, false, [far, near])

    const undecided = await new ReachController().commit(contract, multi)
    assert.equal(undecided.status, 'decision_required')
    if (undecided.status !== 'decision_required') throw new Error('expected explicit route decision boundary')
    assert.deepEqual(undecided.routeIds, ['far', 'near'])

    const selected = await new ReachController(nearestGroundedReachRoutePolicy).commit(contract, multi)
    assert.equal(selected.status, 'active')
    if (selected.status !== 'active' || selected.intent === undefined) throw new Error('expected configured deterministic policy to commit')
    assert.equal(selected.intent.routeId, 'near')
  })

  it('will not commit a route without fresh TRUE grounding evidence', async () => {
    const route = makeRoute('unobserved', 3_000, 10, 10)
    const snapshot = makeSnapshot(3_000, false, [route])
    const predicates = { ...snapshot.observation.predicates, [route.groundingPredicateId]: { truth: 'unknown' as const, evidenceId: null } }
    const result = await new ReachController().commit(contract, { ...snapshot, observation: { ...snapshot.observation, predicates } })
    assert.equal(result.status, 'not_enabled')
  })

  it('rejects an ungrounded waypoint target before it can become an actuation intent', async () => {
    const route = { ...makeRoute('bad-waypoint', 4_000, 10, 10), waypoint: { waypointId: 'bad', target: { note: 'not a position' }, evidenceId: 'waypoint:evidence' } }
    const result = await new ReachController().commit(contract, makeSnapshot(4_000, false, [route]))
    assert.equal(result.status, 'not_enabled')
  })

  it('releases a Guard-refused intent for same-contract replanning without claiming success', async () => {
    const initialRoute = makeRoute('guard-refused', 4_500, 11, 11)
    const controller = new ReachController()
    const committed = await controller.commit(contract, makeSnapshot(4_500, false, [initialRoute]))
    assert.equal(committed.status, 'active')
    if (committed.status !== 'active' || committed.intent === undefined) throw new Error('expected first intent')

    const refused = await controller.refuseIntent(committed.intent.intentId, {
      identity,
      evidenceId: 'guard:route-not-admissible-under-live-facts',
      observedAtMs: 4_501,
    })
    assert.equal(refused.status, 'active')
    if (refused.status !== 'active') throw new Error('a pre-dispatch Guard refusal is not terminal')
    assert.equal(refused.phase, 'waiting')
    assert.equal(controller.current?.intent, null)
    assert.equal(controller.current?.lastCompletion?.status, 'failed')
    assert.equal(controller.current?.lastCompletion?.evidenceId, 'guard:route-not-admissible-under-live-facts')
    assert.equal(controller.currentOutcome, null)

    const freshRoute = makeRoute('fresh-after-guard', 4_502, 13, 9)
    const replanned = await controller.tick(makeSnapshot(4_502, false, [freshRoute]))
    assert.equal(replanned.status, 'active')
    if (replanned.status !== 'active' || replanned.intent === undefined) throw new Error('expected fresh same-contract route')
    assert.equal(replanned.intent.routeId, freshRoute.routeId)
    assert.equal(replanned.contractHash, contract.contractHash)
    assert.equal(replanned.state.usage.mechanicalSteps, 0, 'refusal before dispatch does not spend a physical step')
  })

  it('does not let a stale true predicate outrun the latest false snapshot', async () => {
    const route = makeRoute('fresh-false', 100, 10, 10)
    const controller = new ReachController()
    const committed = await controller.commit(contract, makeSnapshot(100, false, [route]))
    assert.equal(committed.status, 'active')

    // The previously observed world says false at t=100. A delayed t=90 sample
    // saying true must not call VERIFY or regress elapsed/progress state.
    const stale = await controller.tick(makeSnapshot(90, true, []))
    assert.equal(stale.status, 'active')
    if (stale.status !== 'active') throw new Error('stale facts cannot terminalize')
    assert.equal(stale.phase, 'waiting')
    assert.equal(stale.reason, 'stale_or_replayed_snapshot')
    assert.equal(controller.currentOutcome, null)
    assert.equal(controller.current?.state.progress.observationSequence, 1)
  })

  it('fences a stale mechanical callback before it can verify or regress state', async () => {
    const route = makeRoute('step-stale', 100, 10, 10)
    const controller = new ReachController()
    const committed = await controller.commit(contract, makeSnapshot(100, false, [route]))
    assert.equal(committed.status, 'active')
    if (committed.status !== 'active' || committed.intent === undefined) throw new Error('expected intent')
    const reservation = controller.authorizeMechanicalStep(committed.intent.intentId, identity, {
      stepId: 'step-stale-callback', effectKind: 'locomotion', resources: {}, risk: {}, nowMs: 101,
    })
    assert.equal(reservation.status, 'authorized')

    const staleCallback = controller.recordMechanicalStepOutcome(committed.intent.intentId, 'step-stale-callback', {
      snapshot: makeSnapshot(90, true, []),
    })
    assert.equal(staleCallback.status, 'refused')
    if (staleCallback.status !== 'refused') throw new Error('stale callback must not verify')
    assert.equal(staleCallback.reason, 'mechanical_step_snapshot_stale')
    assert.equal(controller.currentOutcome, null)
    assert.equal(controller.current?.inFlightStepId, 'step-stale-callback')
  })

  it('serializes concurrent commits and revalidates after an in-flight route-policy wait', async () => {
    let releaseCommitDecision!: (decision: { readonly status: 'selected'; readonly routeId: string }) => void
    let signalCommitPolicy!: () => void
    const commitPolicyStarted = new Promise<void>((resolve) => { signalCommitPolicy = resolve })
    const commitDecision = new Promise<{ readonly status: 'selected'; readonly routeId: string }>((resolve) => { releaseCommitDecision = resolve })
    let commitPolicyCalls = 0
    const commitController = new ReachController({
      async chooseRoute() {
        commitPolicyCalls += 1
        signalCommitPolicy()
        return commitDecision
      },
    })
    const routes = [makeRoute('race-a', 200, 5, 5), makeRoute('race-b', 200, 9, 9)]
    const firstCommit = commitController.commit(contract, makeSnapshot(200, false, routes))
    await commitPolicyStarted
    const secondCommit = commitController.commit(contract, makeSnapshot(200, false, routes))
    releaseCommitDecision({ status: 'selected', routeId: 'race-a' })
    const [first, second] = await Promise.all([firstCommit, secondCommit])
    assert.equal(first.status, 'active')
    assert.equal(second.status, 'refused')
    assert.equal(commitPolicyCalls, 1, 'the serialized second commit sees the first committed owner')

    // Once a current intent is completed, a new policy epoch can be outstanding.
    // A terminal risk observation must win; the delayed route answer cannot dispatch.
    let releaseTickDecision!: (decision: { readonly status: 'selected'; readonly routeId: string }) => void
    let signalTickPolicy!: () => void
    const tickPolicyStarted = new Promise<void>((resolve) => { signalTickPolicy = resolve })
    const tickDecision = new Promise<{ readonly status: 'selected'; readonly routeId: string }>((resolve) => { releaseTickDecision = resolve })
    const raceController = new ReachController({
      async chooseRoute() {
        signalTickPolicy()
        return tickDecision
      },
    })
    const start = await raceController.commit(contract, makeSnapshot(300, false, [makeRoute('old', 300, 15, 15)]))
    assert.equal(start.status, 'active')
    if (start.status !== 'active' || start.intent === undefined) throw new Error('expected initial intent')
    const ended = await raceController.complete(start.intent.intentId, {
      status: 'failed', evidenceId: 'route-needs-new-choice', snapshot: makeSnapshot(301, false, [makeRoute('old', 301, 15, 15)]),
    })
    assert.equal(ended.status, 'active')
    const pendingTick = raceController.tick(makeSnapshot(302, false, [makeRoute('new-a', 302, 13, 13), makeRoute('new-b', 302, 17, 17)]))
    await tickPolicyStarted
    const exhausted = raceController.observeRisk(identity, 'risk-while-jev-waits', { damage: 6 }, 303)
    assert.equal(exhausted.status, 'terminal')
    releaseTickDecision({ status: 'selected', routeId: 'new-a' })
    const delayed = await pendingTick
    assert.equal(delayed.status, 'refused')
    assert.equal(raceController.current, null)
    assert.equal(raceController.currentOutcome?.kind, 'BUDGET_EXHAUSTED')
  })

  it('admits bounded terrain adaptation only when grounded, declared, and within effect/resource/risk budgets', async () => {
    const terrainContract = (transitionId: string, admissibleEffects = [{ kind: 'bounded_terrain_adaptation', maxUses: 1 }]) =>
      createReachTransitionContract({
        transitionId,
        desiredPredicate: {
          id: 'mission.at-village',
          proposition: { relation: 'within_radius', target: 'village', radius: 8 },
          expected: true,
        },
        requires: [{ id: 'world.loaded', proposition: { loaded: true }, expected: true }],
        ensures: [{ id: 'mission.at-village', proposition: { relation: 'within_radius', target: 'village', radius: 8 }, expected: true }],
        invariants: [{ id: 'body.alive', proposition: { healthAbove: 0 }, expected: true }],
        admissibleEffects,
        budget: { maxMechanicalSteps: 3, maxElapsedMs: 10_000, resources: { blocks: 2 }, risk: { fallDistance: 1 } },
        controller: {
          allowedTactics: ['bounded_terrain_adaptation'],
          allowTemporaryWaypointChanges: true,
          allowWitnessSubstitution: true,
        },
        identity,
      })
    const routeFor = (
      routeContract: ReachTransitionContract,
      routeId: string,
      at: number,
      resources: Readonly<Record<string, number>>,
      risk: Readonly<Record<string, number>>,
    ): ReachRoute => {
      const route = makeRoute(routeId, at, 10, 10)
      return {
        ...route,
        witness: { ...route.witness, desiredPredicateIdentity: routeContract.desiredPredicateIdentity },
        tactic: 'bounded_terrain_adaptation',
        effectKind: 'bounded_terrain_adaptation',
        resources,
        risk,
      }
    }

    const allowed = terrainContract('reach-terrain-adaptation')
    const groundedRoute = routeFor(allowed, 'adapt-bridge', 5_000, { blocks: 2 }, { fallDistance: 0.75 })
    const groundedSnapshot = makeSnapshot(5_000, false, [groundedRoute])
    assert.equal(groundedSnapshot.observation.predicates[groundedRoute.groundingPredicateId]?.truth, 'true')
    assert.equal(groundedSnapshot.observation.predicates[groundedRoute.waypointGroundingPredicateId!]?.evidenceId, groundedRoute.waypoint?.evidenceId)

    const controller = new ReachController()
    const committed = await controller.commit(allowed, groundedSnapshot)
    assert.equal(committed.status, 'active')
    if (committed.status !== 'active' || committed.intent === undefined) throw new Error('expected grounded in-contract adaptation intent')
    assert.equal(committed.intent.effectKind, 'bounded_terrain_adaptation')
    assert.deepEqual(committed.intent.resources, { blocks: 2 })
    assert.deepEqual(committed.intent.risk, { fallDistance: 0.75 })

    const reservation = controller.authorizeMechanicalStep(committed.intent.intentId, identity, {
      stepId: 'adapt-bridge-step-1',
      effectKind: committed.intent.effectKind,
      resources: committed.intent.resources,
      risk: committed.intent.risk,
      nowMs: 5_001,
    })
    assert.equal(reservation.status, 'authorized')
    if (reservation.status !== 'authorized') throw new Error('declared bounded adaptation should reserve within its contract')
    assert.equal(reservation.state.usage.effects.bounded_terrain_adaptation, 1)
    assert.equal(reservation.state.usage.mechanicalSteps, 1)
    assert.deepEqual(reservation.state.usage.resources, { blocks: 2 })
    assert.deepEqual(reservation.state.usage.risk, { fallDistance: 0.75 })
    const settled = controller.recordMechanicalStepOutcome(committed.intent.intentId, 'adapt-bridge-step-1', {
      snapshot: makeSnapshot(5_002, false, [routeFor(allowed, 'adapt-bridge', 5_002, { blocks: 2 }, { fallDistance: 0.75 })]),
    })
    assert.equal(settled.status, 'active', 'mechanical completion keeps the Reach contract open for deterministic verification')

    const tooExpensive = routeFor(allowed, 'adapt-over-budget-route', 6_000, { blocks: 3 }, { fallDistance: 1.1 })
    const rejectedRoute = await new ReachController().commit(allowed, makeSnapshot(6_000, false, [tooExpensive]))
    assert.equal(rejectedRoute.status, 'not_enabled', 'route estimates beyond either finite budget cannot become intents')

    const undeclared = terrainContract('reach-undeclared-adaptation', [{ kind: 'locomotion', maxUses: 1 }])
    const undeclaredRoute = routeFor(undeclared, 'adapt-not-declared', 7_000, { blocks: 1 }, { fallDistance: 0.5 })
    const rejectedEffect = await new ReachController().commit(undeclared, makeSnapshot(7_000, false, [undeclaredRoute]))
    assert.equal(rejectedEffect.status, 'not_enabled', 'the controller tactic alone cannot authorize an undeclared world effect')

    const overrunController = new ReachController()
    const withinBudgetRoute = routeFor(allowed, 'adapt-mechanical-budget', 8_000, { blocks: 1 }, { fallDistance: 0.5 })
    const withinBudget = await overrunController.commit(allowed, makeSnapshot(8_000, false, [withinBudgetRoute]))
    assert.equal(withinBudget.status, 'active')
    if (withinBudget.status !== 'active' || withinBudget.intent === undefined) throw new Error('expected route under its finite budget')
    const overrun = overrunController.authorizeMechanicalStep(withinBudget.intent.intentId, identity, {
      stepId: 'adapt-overrun-step',
      effectKind: 'bounded_terrain_adaptation',
      resources: { blocks: 3 },
      risk: { fallDistance: 0.5 },
      nowMs: 8_001,
    })
    assert.equal(overrun.status, 'terminal')
    if (overrun.status !== 'terminal') throw new Error('over-budget adaptation must not reach the mechanical adapter')
    assert.equal(overrun.outcome.kind, 'BUDGET_EXHAUSTED')
    assert.equal(overrun.outcome.kind === 'BUDGET_EXHAUSTED' ? overrun.outcome.budget : '', 'resource:blocks')
  })

  it('keeps the controller core free of backend and legacy runtime types', async () => {
    const source = await readFile(new URL('./src/vtr/reach-controller.ts', import.meta.url), 'utf8')
    assert.doesNotMatch(source, /from\s+['"](?:mineflayer|mineflayer-[^'"]*|vec3)['"]/, 'no backend imports')
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
    assert.doesNotMatch(code, /\b(?:Bot|WorldState|Candidate|Executor)\b/, 'no raw or legacy runtime types')
  })
})
