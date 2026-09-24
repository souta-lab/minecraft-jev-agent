import assert from 'node:assert/strict'
import { describe, it } from 'bun:test'
import {
  createReachTransitionContract,
  countMissionInventoryResource,
  interruptReachForSafety,
  missionResourceSourceMatches,
  recordReachMechanicalStep,
  recordReachObservedRisk,
  recordReachProgress,
  reserveReachActuation,
  setReachTactic,
  setReachTemporaryWaypoint,
  startReachTransition,
  substituteReachWitness,
  terminateReachAsInfeasible,
  verifyReachEnsures,
  type ReachIdentity,
  type ReachJson,
  type ReachObservation,
  type ReachPredicate,
  type ReachTransitionContract,
  type ReachTransitionState,
} from './src/vtr/reach.ts'

const identity: ReachIdentity = {
  worldKey: 'world:seed-7',
  dimension: 'minecraft:overworld',
  worldEpoch: 4,
  generationId: 'generation-22',
  leaseId: 'lease-9',
}

const requires: ReachPredicate[] = [
  { id: 'world.loaded', proposition: { worldKey: 'world:seed-7' }, expected: true },
]
const desired: ReachPredicate = {
  id: 'mission.reach-village',
  proposition: { relation: 'within_radius', radius: 8, semanticTarget: 'village' },
  expected: true,
}
const invariants: ReachPredicate[] = [
  { id: 'body.alive', proposition: { healthAbove: 0 }, expected: true },
]

function makeContract(overrides: Partial<Parameters<typeof createReachTransitionContract>[0]> = {}): ReachTransitionContract {
  return createReachTransitionContract({
    transitionId: 'transition-reach-village-1',
    desiredPredicate: desired,
    requires,
    ensures: [desired],
    invariants,
    admissibleEffects: [
      { kind: 'move', maxUses: null },
      { kind: 'jump', maxUses: 4 },
      { kind: 'bounded_terrain_adaptation', maxUses: 3 },
    ],
    budget: {
      maxMechanicalSteps: 6,
      maxElapsedMs: 30_000,
      resources: { food: 2, blocks: 8 },
      risk: { expectedDamage: 4, fallDistance: 3 },
    },
    controller: {
      allowedTactics: ['walk', 'path_replan', 'jump', 'detour', 'bounded_terrain_adaptation'],
      allowTemporaryWaypointChanges: true,
      allowWitnessSubstitution: true,
    },
    identity,
    ...overrides,
  })
}

function observation(
  contract: ReachTransitionContract,
  at = 1_000,
  values: Readonly<Record<string, 'true' | 'false' | 'unknown'>> = {},
  currentIdentity: ReachIdentity = contract.identity,
): ReachObservation {
  const predicates = [...contract.requires, ...contract.invariants, ...contract.ensures]
  return {
    identity: currentIdentity,
    observedAtMs: at,
    predicates: Object.fromEntries(predicates.map((predicate) => [predicate.id, {
      truth: values[predicate.id] ?? (predicate.expected ? 'true' : 'false'),
      evidenceId: values[predicate.id] === 'unknown' ? null : `evidence:${predicate.id}:${at}`,
    }])),
  }
}

function start(contract = makeContract(), at = 1_000): ReachTransitionState {
  const result = startReachTransition(contract, observation(contract, at), { tactic: 'walk' })
  assert.equal(result.status, 'active')
  return result.state
}

function reserve(
  contract: ReachTransitionContract,
  state: ReachTransitionState,
  input: Partial<Parameters<typeof reserveReachActuation>[3]> = {},
) {
  return reserveReachActuation(contract, state, identity, {
    actuationId: 'actuation-1',
    effectKind: 'move',
    resources: {},
    risk: {},
    nowMs: 1_001,
    ...input,
  })
}

describe('pure VTR Reach contract and controller state machine', () => {
  it('matches exact Mission wood species and counts resource classes without crossing species', () => {
    assert.equal(missionResourceSourceMatches('oak_log', 'oak_log', 'oak_log'), true)
    assert.equal(missionResourceSourceMatches('oak_log', 'acacia_log', 'acacia_log'), false)
    assert.equal(missionResourceSourceMatches('oak_log', 'birch_log', 'oak_log'), true)
    assert.equal(missionResourceSourceMatches('log', 'acacia_log', 'acacia_log'), true)
    assert.equal(countMissionInventoryResource({ oak_log: 2, acacia_log: 3 }, 'oak_log'), 2)
    assert.equal(countMissionInventoryResource({ oak_log: 2, acacia_log: 3 }, 'log'), 5)
  })

  it('pins a stable desired predicate while tactics, waypoint, and valid witness change', () => {
    const contract = makeContract()
    const initialWitness = {
      witnessId: 'village-marker-east',
      target: { x: 120, y: 70, z: 44 },
      desiredPredicateIdentity: contract.desiredPredicateIdentity,
      evidenceId: 'world-observation:marker-east',
      observedIdentity: identity,
      observedAtMs: 1_000,
    }
    const started = startReachTransition(contract, observation(contract), { tactic: 'walk', witness: initialWitness })
    assert.equal(started.status, 'active')
    const beforeHash = started.state.contractHash
    const beforeEnsureIdentity = contract.ensuresIdentity
    const tightenedBudget = makeContract({ budget: { ...contract.budget, maxElapsedMs: contract.budget.maxElapsedMs - 1 } })
    assert.notEqual(tightenedBudget.contractHash, beforeHash, 'a different budget is a different immutable contract')

    const replanned = setReachTactic(contract, started.state, identity, 'path_replan', 1_100)
    assert.equal(replanned.status, 'active')
    const jumped = setReachTactic(contract, replanned.state, identity, 'jump', 1_200)
    assert.equal(jumped.status, 'active')
    const waypoint = setReachTemporaryWaypoint(contract, jumped.state, identity, {
      waypointId: 'temporary-clearance-point',
      target: { x: 116, y: 71, z: 39 },
      evidenceId: 'world-observation:clearance-point',
    }, 1_300)
    assert.equal(waypoint.status, 'active')

    const substituted = substituteReachWitness(contract, waypoint.state, identity, {
      witnessId: 'village-marker-west',
      target: { x: 108, y: 70, z: 51 },
      desiredPredicateIdentity: contract.desiredPredicateIdentity,
      evidenceId: 'world-observation:marker-west',
      observedIdentity: identity,
      observedAtMs: 1_400,
    }, 1_400)
    assert.equal(substituted.status, 'active')
    assert.equal(substituted.state.witness?.witnessId, 'village-marker-west')
    assert.equal(substituted.state.contractHash, beforeHash)
    assert.equal(contract.ensuresIdentity, beforeEnsureIdentity)
    assert.equal(substituted.state.temporaryWaypoint?.waypointId, 'temporary-clearance-point')
    assert.equal(substituted.state.tactic, 'jump')
  })

  it('does not let body progress or a mechanical action verify the desired predicate', () => {
    const contract = makeContract()
    const state = start(contract)
    const progress = recordReachProgress(contract, state, identity, {
      observation: observation(contract, 1_100),
      predicateDistance: 1.25,
      reachability: 'reachable',
      frontierId: 'frontier:village-approach',
      evidenceId: 'verified-world-distance:1',
    })
    assert.equal(progress.status, 'active')
    assert.equal(progress.state.progress.bestPredicateDistance, 1.25)

    const action = reserve(contract, progress.state)
    assert.equal(action.status, 'authorized')
    assert.equal(action.state.status, 'active')
    assert.equal(action.state.terminalOutcome, null)
    const stillOutside = verifyReachEnsures(contract, action.state, observation(contract, 1_200, {
      'mission.reach-village': 'false',
    }))
    assert.equal(stillOutside.status, 'pending')
    if (stillOutside.status === 'pending') assert.match(stillOutside.reason, /mission\.reach-village:false/)
  })

  it('counts each uniquely identified executor leg before dispatch', () => {
    const contract = makeContract()
    const state = start(contract)
    const leg1 = recordReachMechanicalStep(contract, state, identity, {
      stepId: 'path-execution-7:leg-1', effectKind: 'move', resources: {}, risk: {}, nowMs: 1_010,
    })
    assert.equal(leg1.status, 'authorized')
    const leg2 = recordReachMechanicalStep(contract, leg1.state, identity, {
      stepId: 'path-execution-7:leg-2', effectKind: 'move', resources: {}, risk: {}, nowMs: 1_020,
    })
    assert.equal(leg2.status, 'authorized')
    assert.equal(leg2.state.usage.mechanicalSteps, 2)
    const duplicate = recordReachMechanicalStep(contract, leg2.state, identity, {
      stepId: 'path-execution-7:leg-2', effectKind: 'move', resources: {}, risk: {}, nowMs: 1_030,
    })
    assert.equal(duplicate.status, 'terminal')
    if (duplicate.status === 'terminal') {
      assert.equal(duplicate.outcome.kind, 'CONTRACT_VIOLATION')
      if (duplicate.outcome.kind === 'CONTRACT_VIOLATION') assert.equal(duplicate.outcome.violation, 'duplicate_actuation_id')
    }
  })

  it('issues SUCCESS only from deterministic ensure evidence and then rejects further actuation', () => {
    const contract = makeContract()
    const state = start(contract)
    const pending = verifyReachEnsures(contract, state, observation(contract, 1_100, {
      'mission.reach-village': 'unknown',
    }))
    assert.equal(pending.status, 'pending')

    const verified = verifyReachEnsures(contract, state, observation(contract, 1_200, {
      'mission.reach-village': 'true',
      'body.alive': 'true',
    }))
    assert.equal(verified.status, 'terminal')
    if (verified.status === 'terminal') {
      assert.equal(verified.outcome.kind, 'SUCCESS')
      if (verified.outcome.kind === 'SUCCESS') {
        assert.equal(verified.outcome.desiredPredicateIdentity, contract.desiredPredicateIdentity)
        assert.deepEqual(verified.outcome.evidenceIds, ['evidence:mission.reach-village:1200'])
      }
      const denied = reserve(contract, verified.state, { actuationId: 'after-success' })
      assert.equal(denied.status, 'terminal')
      assert.equal(denied.state.usage.mechanicalSteps, 0)
    }
  })

  it('records post-leg risk before deterministic verification and rejects a budget overrun', () => {
    const contract = makeContract({ budget: { ...makeContract().budget, risk: { damage: 1 } } })
    const state = start(contract)
    const step = recordReachMechanicalStep(contract, state, identity, {
      stepId: 'path-execution-8:leg-1', effectKind: 'move', resources: {}, risk: {}, nowMs: 1_010,
    })
    assert.equal(step.status, 'authorized')
    const observed = recordReachObservedRisk(contract, step.state, identity, {
      observationId: 'path-execution-8:leg-1', risk: { damage: 1 }, nowMs: 1_020,
    })
    assert.equal(observed.status, 'active')
    if (observed.status !== 'active') return
    assert.equal(observed.state.usage.risk.damage, 1)
    const second = recordReachObservedRisk(contract, observed.state, identity, {
      observationId: 'path-execution-8:leg-2', risk: { damage: 1 }, nowMs: 1_030,
    })
    assert.equal(second.status, 'terminal')
    if (second.status === 'terminal') {
      assert.equal(second.outcome.kind, 'BUDGET_EXHAUSTED')
      if (second.outcome.kind === 'BUDGET_EXHAUSTED') assert.equal(second.outcome.budget, 'risk:damage')
      assert.equal(second.state.usage.risk.damage, 1, 'an over-budget observation cannot mutate the recorded total')
    }
    const cannotVerifyAfterOverrun = verifyReachEnsures(contract, second.state, observation(contract, 1_040, {
      'mission.reach-village': 'true',
      'body.alive': 'true',
    }))
    assert.equal(cannotVerifyAfterOverrun.status, 'terminal')
  })

  it('rejects actuation when world epoch, generation, or lease identity changes', () => {
    const contract = makeContract()
    const state = start(contract)
    const staleWorld = reserveReachActuation(contract, state, { ...identity, worldEpoch: identity.worldEpoch + 1 }, {
      actuationId: 'stale-world-action', effectKind: 'move', resources: {}, risk: {}, nowMs: 1_100,
    })
    assert.equal(staleWorld.status, 'terminal')
    if (staleWorld.status === 'terminal') {
      assert.equal(staleWorld.outcome.kind, 'WORLD_CHANGED')
      assert.equal(staleWorld.state.usage.mechanicalSteps, 0)
    }

    const staleGeneration = reserveReachActuation(contract, state, { ...identity, generationId: 'generation-new' }, {
      actuationId: 'stale-generation-action', effectKind: 'move', resources: {}, risk: {}, nowMs: 1_100,
    })
    assert.equal(staleGeneration.status, 'terminal')
    if (staleGeneration.status === 'terminal') assert.equal(staleGeneration.outcome.kind, 'GENERATION_CHANGED')

    const lostLease = reserveReachActuation(contract, state, { ...identity, leaseId: 'lease-revoked' }, {
      actuationId: 'revoked-lease-action', effectKind: 'move', resources: {}, risk: {}, nowMs: 1_100,
    })
    assert.equal(lostLease.status, 'terminal')
    if (lostLease.status === 'terminal') assert.equal(lostLease.outcome.kind, 'LEASE_LOST')
  })

  it('returns typed budget exhaustion and effect-envelope violations', () => {
    const oneStep = makeContract({ budget: {
      maxMechanicalSteps: 1, maxElapsedMs: 100, resources: { food: 1 }, risk: { damage: 1 },
    } })
    const initial = start(oneStep, 1_000)
    const first = reserveReachActuation(oneStep, initial, identity, {
      actuationId: 'step-1', effectKind: 'move', resources: { food: 1 }, risk: { damage: 1 }, nowMs: 1_010,
    })
    assert.equal(first.status, 'authorized')
    const stepLimit = reserveReachActuation(oneStep, first.state, identity, {
      actuationId: 'step-2', effectKind: 'move', resources: {}, risk: {}, nowMs: 1_020,
    })
    assert.equal(stepLimit.status, 'terminal')
    if (stepLimit.status === 'terminal') {
      assert.equal(stepLimit.outcome.kind, 'BUDGET_EXHAUSTED')
      if (stepLimit.outcome.kind === 'BUDGET_EXHAUSTED') assert.equal(stepLimit.outcome.budget, 'mechanicalSteps')
    }

    const resourceContract = makeContract()
    const resourceResult = reserve(resourceContract, start(resourceContract), {
      actuationId: 'too-much-food', resources: { food: 3 }, risk: {},
    })
    assert.equal(resourceResult.status, 'terminal')
    if (resourceResult.status === 'terminal') {
      assert.equal(resourceResult.outcome.kind, 'BUDGET_EXHAUSTED')
      if (resourceResult.outcome.kind === 'BUDGET_EXHAUSTED') assert.equal(resourceResult.outcome.budget, 'resource:food')
    }

    const riskContract = makeContract()
    const riskResult = reserve(riskContract, start(riskContract), {
      actuationId: 'too-risky', resources: {}, risk: { expectedDamage: 5 },
    })
    assert.equal(riskResult.status, 'terminal')
    if (riskResult.status === 'terminal') {
      assert.equal(riskResult.outcome.kind, 'BUDGET_EXHAUSTED')
      if (riskResult.outcome.kind === 'BUDGET_EXHAUSTED') assert.equal(riskResult.outcome.budget, 'risk:expectedDamage')
    }

    const effectResult = reserve(resourceContract, start(resourceContract), {
      actuationId: 'undeclared-dig', effectKind: 'dig', resources: {}, risk: {},
    })
    assert.equal(effectResult.status, 'terminal')
    if (effectResult.status === 'terminal') {
      assert.equal(effectResult.outcome.kind, 'CONTRACT_VIOLATION')
      if (effectResult.outcome.kind === 'CONTRACT_VIOLATION') assert.equal(effectResult.outcome.violation, 'inadmissible_effect')
    }

    const adaptationContract = makeContract()
    let adaptationState = start(adaptationContract)
    for (let index = 1; index <= 3; index += 1) {
      const reservation = reserveReachActuation(adaptationContract, adaptationState, identity, {
        actuationId: `terrain-adaptation-${index}`,
        effectKind: 'bounded_terrain_adaptation',
        resources: { blocks: 1 },
        risk: {},
        nowMs: 1_000 + index,
      })
      assert.equal(reservation.status, 'authorized')
      adaptationState = reservation.state
    }
    const fourthAdaptation = reserveReachActuation(adaptationContract, adaptationState, identity, {
      actuationId: 'terrain-adaptation-4',
      effectKind: 'bounded_terrain_adaptation',
      resources: { blocks: 1 },
      risk: {},
      nowMs: 1_010,
    })
    assert.equal(fourthAdaptation.status, 'terminal')
    if (fourthAdaptation.status === 'terminal') {
      assert.equal(fourthAdaptation.outcome.kind, 'CONTRACT_VIOLATION')
      if (fourthAdaptation.outcome.kind === 'CONTRACT_VIOLATION') assert.equal(fourthAdaptation.outcome.violation, 'effect_limit_exceeded')
    }
  })

  it('bounds elapsed time and rejects double-reserved mechanical actuation', () => {
    const contract = makeContract({ budget: {
      maxMechanicalSteps: 6, maxElapsedMs: 50, resources: { food: 2, blocks: 8 }, risk: { expectedDamage: 4, fallDistance: 3 },
    } })
    const state = start(contract, 1_000)
    const expired = reserveReachActuation(contract, state, identity, {
      actuationId: 'late-step', effectKind: 'move', resources: {}, risk: {}, nowMs: 1_051,
    })
    assert.equal(expired.status, 'terminal')
    if (expired.status === 'terminal') {
      assert.equal(expired.outcome.kind, 'BUDGET_EXHAUSTED')
      if (expired.outcome.kind === 'BUDGET_EXHAUSTED') assert.equal(expired.outcome.budget, 'elapsedMs')
    }

    const first = reserveReachActuation(contract, state, identity, {
      actuationId: 'unique-step', effectKind: 'move', resources: {}, risk: {}, nowMs: 1_010,
    })
    assert.equal(first.status, 'authorized')
    const duplicate = reserveReachActuation(contract, first.state, identity, {
      actuationId: 'unique-step', effectKind: 'move', resources: {}, risk: {}, nowMs: 1_020,
    })
    assert.equal(duplicate.status, 'terminal')
    if (duplicate.status === 'terminal') {
      assert.equal(duplicate.outcome.kind, 'CONTRACT_VIOLATION')
      if (duplicate.outcome.kind === 'CONTRACT_VIOLATION') assert.equal(duplicate.outcome.violation, 'duplicate_actuation_id')
    }
  })

  it('returns explicit infeasibility evidence and fails a broken invariant closed', () => {
    const contract = makeContract()
    const state = start(contract)
    const infeasible = terminateReachAsInfeasible(contract, state, identity, {
      reason: 'all observed approaches are sealed by protected terrain',
      evidenceId: 'scan:sealed-approaches-v2',
      nowMs: 1_200,
    })
    assert.equal(infeasible.status, 'terminal')
    if (infeasible.status === 'terminal') {
      assert.equal(infeasible.outcome.kind, 'PROVEN_INFEASIBLE')
      if (infeasible.outcome.kind === 'PROVEN_INFEASIBLE') assert.equal(infeasible.outcome.evidenceId, 'scan:sealed-approaches-v2')
    }

    const broken = verifyReachEnsures(contract, state, observation(contract, 1_200, {
      'mission.reach-village': 'true',
      'body.alive': 'false',
    }))
    assert.equal(broken.status, 'terminal')
    if (broken.status === 'terminal') {
      assert.equal(broken.outcome.kind, 'CONTRACT_VIOLATION')
      if (broken.outcome.kind === 'CONTRACT_VIOLATION') assert.equal(broken.outcome.violation, 'invariant_broken')
    }
  })

  it('returns a typed safety interrupt for the scheduler without mislabeling it a contract violation', () => {
    const contract = makeContract()
    const state = start(contract)
    const interrupted = interruptReachForSafety(contract, state, identity, {
      reason: 'hostile threat crossed the viability boundary',
      evidenceId: 'threat-observation:zombie-3:0.8m',
      nowMs: 1_250,
    })
    assert.equal(interrupted.status, 'terminal')
    if (interrupted.status === 'terminal') {
      assert.equal(interrupted.outcome.kind, 'SAFETY_INTERRUPT')
      if (interrupted.outcome.kind === 'SAFETY_INTERRUPT') {
        assert.equal(interrupted.outcome.evidenceId, 'threat-observation:zombie-3:0.8m')
        assert.equal(interrupted.outcome.contractHash, contract.contractHash)
      }
    }
  })

  it('does not start without required predicates and rejects a witness for another desired predicate', () => {
    const contract = makeContract()
    const notEnabled = startReachTransition(contract, observation(contract, 1_000, { 'world.loaded': 'unknown' }), { tactic: 'walk' })
    assert.equal(notEnabled.status, 'not_enabled')

    const state = start(contract)
    const invalidWitness = substituteReachWitness(contract, state, identity, {
      witnessId: 'other-place',
      target: { x: 3, y: 60, z: 90 },
      desiredPredicateIdentity: 'another-predicate-hash',
      evidenceId: 'observation:other-place',
      observedIdentity: identity,
      observedAtMs: 1_100,
    }, 1_100)
    assert.equal(invalidWitness.status, 'terminal')
    if (invalidWitness.status === 'terminal') {
      assert.equal(invalidWitness.outcome.kind, 'CONTRACT_VIOLATION')
      if (invalidWitness.outcome.kind === 'CONTRACT_VIOLATION') assert.equal(invalidWitness.outcome.violation, 'witness_not_grounded_for_desired_predicate')
    }
  })

  it('rejects a witness observed under a different world or dimension identity before accepting substitution', () => {
    const contract = makeContract()
    const state = start(contract)
    for (const observedIdentity of [
      { ...identity, worldKey: 'world:another-server' },
      { ...identity, dimension: 'minecraft:the_nether' },
      { ...identity, worldEpoch: identity.worldEpoch + 1 },
      { ...identity, generationId: 'another-generation' },
      { ...identity, leaseId: 'another-lease' },
    ]) {
      const result = substituteReachWitness(contract, state, identity, {
        witnessId: 'other-grounded-witness',
        target: { x: 12, y: 70, z: 44 },
        desiredPredicateIdentity: contract.desiredPredicateIdentity,
        evidenceId: 'world-observation:foreign-world',
        observedIdentity,
        observedAtMs: 1_100,
      }, 1_100)
      assert.equal(result.status, 'terminal')
      if (result.status === 'terminal') {
        assert.equal(result.outcome.kind, 'CONTRACT_VIOLATION')
        if (result.outcome.kind === 'CONTRACT_VIOLATION') {
          assert.equal(result.outcome.violation, 'witness_not_grounded_for_desired_predicate')
        }
        assert.equal(result.state.witness, null)
      }
    }
  })

  it('rejects a stale or malformed replacement witness even when its world identity matches', () => {
    const contract = makeContract()
    const state = start(contract)
    const makeWitness = (target: ReachJson, observedAtMs = 1_100) => ({
      witnessId: 'same-world-witness',
      target,
      desiredPredicateIdentity: contract.desiredPredicateIdentity,
      evidenceId: 'world-observation:same-world',
      observedIdentity: identity,
      observedAtMs,
    })

    const stale = substituteReachWitness(contract, state, identity, makeWitness({ x: 12, y: 70, z: 44 }), 1_200)
    assert.equal(stale.status, 'terminal')
    if (stale.status === 'terminal') {
      assert.equal(stale.outcome.kind, 'CONTRACT_VIOLATION')
      if (stale.outcome.kind === 'CONTRACT_VIOLATION') {
        assert.equal(stale.outcome.violation, 'witness_not_grounded_for_desired_predicate')
      }
    }

    const malformed = substituteReachWitness(
      contract,
      state,
      identity,
      makeWitness({ x: Number.NaN, y: 70, z: 44 }),
      1_100,
    )
    assert.equal(malformed.status, 'terminal')
    if (malformed.status === 'terminal') {
      assert.equal(malformed.outcome.kind, 'CONTRACT_VIOLATION')
      if (malformed.outcome.kind === 'CONTRACT_VIOLATION') {
        assert.equal(malformed.outcome.violation, 'witness_not_grounded_for_desired_predicate')
      }
    }
  })
})
