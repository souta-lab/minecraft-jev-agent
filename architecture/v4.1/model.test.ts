import { describe, expect, test } from 'bun:test'
import {
  activateTransition,
  ageRunnable,
  chooseResourceWinner,
  effectCommitIsCurrent,
  grantLeaseBundle,
  initialRuntimeState,
  jevDecisionIsCurrent,
  observeTransition,
  releaseTransitionLeases,
  resumeTransition,
  suspendTransition,
  verifyTransitionSuccess,
  type JevDecisionFrameV41,
  type JevDecisionV41,
  type ResourceClaim,
  type RuntimeBinding,
  type TransitionClass,
  type TransitionContract,
  type WorldIdentity,
} from './model.ts'

const world: WorldIdentity = { serverId: 'local', dimension: 'minecraft:overworld', worldEpoch: 7 }
const binding: RuntimeBinding = { generationId: 'gen-a', factRevision: 10, registryRevision: 3, missionRevision: 2 }

function claim(resource: string, mode: ResourceClaim['mode'] = 'EXCLUSIVE_WRITE'): ResourceClaim {
  return { resource, mode, preemptible: true, resumable: true }
}

function contract(id: string, klass: TransitionClass, claims: readonly ResourceClaim[]): TransitionContract {
  return {
    transitionId: id,
    contractHash: `hash:${id}`,
    family: id.split(':')[0] ?? id,
    class: klass,
    world,
    desiredPredicate: `predicate:${id}`,
    requires: [],
    invariants: ['viable'],
    claims,
    effects: [],
    budget: {
      maxActiveMs: 60_000,
      deadlineAtMs: null,
      maxMechanicalSteps: 100,
      resources: {},
      risk: {},
    },
    progressDefinition: `progress:${id}`,
  }
}

const reach = contract('reach:a', 'MISSION', [claim('body.locomotion')])
const search = contract('search:a', 'BACKGROUND', [
  claim('observation.world', 'SHARED_READ'),
  claim('memory.worldModel', 'APPEND'),
])

describe('V4.1 concurrency model', () => {
  test('compatible Reach + passive Search can both hold resources', () => {
    const first = grantLeaseBundle(reach.transitionId, reach.claims, [], 1)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const second = grantLeaseBundle(search.transitionId, search.claims, first.leases, 1)
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(new Set(second.leases.map((lease) => lease.owner))).toEqual(new Set(['reach:a', 'search:a']))
  })

  test('exclusive locomotion conflict cannot double-actuate', () => {
    const otherReach = contract('reach:b', 'MISSION', [claim('body.locomotion')])
    const first = grantLeaseBundle(reach.transitionId, reach.claims, [], 2)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const second = grantLeaseBundle(otherReach.transitionId, otherReach.claims, first.leases, 2)
    expect(second.ok).toBe(false)
    if (second.ok) return
    expect(second.conflicts.map((lease) => lease.resource)).toEqual(['body.locomotion'])
  })

  test('preemption preserves semantic identity and releases actuation resources', () => {
    const active = activateTransition(initialRuntimeState(reach, binding), ['body.locomotion'])
    const suspended = suspendTransition(active, 'PREEMPTED')
    expect(suspended.transitionId).toBe(reach.transitionId)
    expect(suspended.contractHash).toBe(reach.contractHash)
    expect(suspended.semanticOwner).toBe(true)
    expect(suspended.heldResources).toEqual([])
    expect(suspended.lifecycle).toBe('SUSPENDED')
  })

  test('Viability temporarily owns locomotion and Reach resumes unchanged', () => {
    const activeReach = activateTransition(initialRuntimeState(reach, binding), ['body.locomotion'])
    const suspendedReach = suspendTransition(activeReach, 'PREEMPTED')
    const viability = contract('viability:lava', 'VIABILITY', [claim('body.locomotion')])
    const viabilityGrant = grantLeaseBundle(viability.transitionId, viability.claims, [], 3)
    expect(viabilityGrant.ok).toBe(true)
    const resumed = resumeTransition(suspendedReach, reach, world, { ...binding, factRevision: 11 }, true)
    expect(resumed.ok).toBe(true)
    if (!resumed.ok) return
    expect(resumed.state.transitionId).toBe(reach.transitionId)
    expect(resumed.state.contractHash).toBe(reach.contractHash)
    expect(resumed.state.lifecycle).toBe('RUNNABLE')
  })

  test('stale world identity prevents resume', () => {
    const suspended = suspendTransition(initialRuntimeState(reach, binding), 'PREEMPTED')
    const changed = { ...world, worldEpoch: world.worldEpoch + 1 }
    const resumed = resumeTransition(suspended, reach, changed, { ...binding, factRevision: 12 }, true)
    expect(resumed).toEqual({ ok: false, reason: 'WORLD_CHANGED' })
  })

  test('generation change requires fresh revalidation before rebind', () => {
    const suspended = suspendTransition(initialRuntimeState(reach, binding), 'GENERATION_REBIND_REQUIRED')
    const nextBinding = { ...binding, generationId: 'gen-b', factRevision: 11 }
    expect(resumeTransition(suspended, reach, world, nextBinding, false)).toEqual({ ok: false, reason: 'STALE_REBIND' })
    expect(resumeTransition(suspended, reach, world, nextBinding, true).ok).toBe(true)
  })

  test('long-running process can observe without holding body locomotion', () => {
    const smelt = contract('smelt:iron', 'MISSION', [claim('station:furnace@1,2,3', 'EXCLUSIVE_WRITE')])
    const state = observeTransition(initialRuntimeState(smelt, binding))
    expect(state.lifecycle).toBe('OBSERVING')
    expect(state.heldResources).toEqual([])
  })

  test('deterministic VERIFY alone closes SUCCESS, including external completion', () => {
    const state = initialRuntimeState(reach, binding)
    const verified = verifyTransitionSuccess(reach, state, {
      deterministic: true,
      causalCredit: 'external',
      fact: {
        factId: 'fact:arrived',
        predicateId: reach.desiredPredicate,
        value: true,
        truth: 'true',
        world,
        factRevision: 11,
        observedAtMs: 100,
        provenance: 'fresh-sensor',
      },
    })
    expect(verified.lifecycle).toBe('TERMINAL')
    expect(verified.terminalOutcome).toEqual({ kind: 'SUCCESS', factId: 'fact:arrived', causalCredit: 'external' })
  })

  test('fairness aging eventually lifts a background transition over an ordinary mission peer', () => {
    let backgroundState = initialRuntimeState(search, binding)
    for (let i = 0; i < 150; i += 1) backgroundState = ageRunnable(backgroundState)
    const missionState = initialRuntimeState(reach, binding)
    expect(chooseResourceWinner([
      { contract: reach, state: missionState, urgency: 0 },
      { contract: search, state: backgroundState, urgency: 0 },
    ])).toBe(search.transitionId)
  })

  test('atomic bundle acquisition prevents hold-and-wait deadlock', () => {
    const ownerA = contract('task:a', 'MISSION', [claim('inventory'), claim('station:furnace')])
    const ownerB = contract('task:b', 'MISSION', [claim('station:furnace'), claim('inventory')])
    const a = grantLeaseBundle(ownerA.transitionId, ownerA.claims, [], 4)
    expect(a.ok).toBe(true)
    if (!a.ok) return
    const b = grantLeaseBundle(ownerB.transitionId, ownerB.claims, a.leases, 4)
    expect(b.ok).toBe(false)
    if (b.ok) return
    expect(a.leases.filter((lease) => lease.owner === ownerA.transitionId)).toHaveLength(2)
    expect(a.leases.filter((lease) => lease.owner === ownerB.transitionId)).toHaveLength(0)
  })

  test('stale Jev decision is dropped after scheduler or fact revision advances', () => {
    const frame: JevDecisionFrameV41 = {
      frameHash: 'frame:1', schedulerEpoch: 9, world, binding,
      enabledTransitionIds: [reach.transitionId], activeTransitionIds: [], suspendedTransitionIds: [], conflicts: [],
    }
    const decision: JevDecisionV41 = {
      frameHash: frame.frameHash, schedulerEpoch: frame.schedulerEpoch, binding,
      rankedTransitionIds: [reach.transitionId], tacticChoices: {},
    }
    expect(jevDecisionIsCurrent(frame, decision, binding, 9)).toBe(true)
    expect(jevDecisionIsCurrent(frame, decision, { ...binding, factRevision: 11 }, 9)).toBe(false)
    expect(jevDecisionIsCurrent(frame, decision, binding, 10)).toBe(false)
  })

  test('irreversible effect token fails closed after fact revision changes', () => {
    const active = activateTransition(initialRuntimeState(reach, binding), ['body.locomotion'])
    const token = {
      commitId: 'commit:1', transitionId: reach.transitionId, contractHash: reach.contractHash,
      effect: 'DIG' as const, scope: 'block@1,2,3', factRevision: 10, expiresAtMs: 1_000,
    }
    expect(effectCommitIsCurrent(token, active, 10, 500)).toBe(true)
    expect(effectCommitIsCurrent(token, active, 11, 500)).toBe(false)
    expect(effectCommitIsCurrent(token, active, 10, 1_001)).toBe(false)
  })

  test('resource preemption is explicit release then grant, never dual ownership', () => {
    const viability = contract('viability:air', 'VIABILITY', [claim('body.locomotion')])
    const reachGrant = grantLeaseBundle(reach.transitionId, reach.claims, [], 12)
    expect(reachGrant.ok).toBe(true)
    if (!reachGrant.ok) return
    const released = releaseTransitionLeases(reach.transitionId, reachGrant.leases)
    const viabilityGrant = grantLeaseBundle(viability.transitionId, viability.claims, released, 13)
    expect(viabilityGrant.ok).toBe(true)
    if (!viabilityGrant.ok) return
    expect(viabilityGrant.leases.filter((lease) => lease.resource === 'body.locomotion')).toHaveLength(1)
    expect(viabilityGrant.leases.find((lease) => lease.resource === 'body.locomotion')?.owner).toBe(viability.transitionId)
  })
})
