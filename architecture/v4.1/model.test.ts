import { describe, expect, test } from 'bun:test'
import {
  activateTransition,
  ageRunnable,
  acknowledgePreemptionYield,
  chooseResourceWinner,
  createRegistry,
  effectCommitIsCurrent,
  grantLeaseBundle,
  initialRuntimeState,
  executePreemption,
  grantPreemptionRequester,
  jevDecisionIsCurrent,
  leaseBindingFingerprint,
  mutateTransition,
  permitKey,
  putTransition,
  removeTransition,
  requestPreemption,
  resourcePathsOverlap,
  observeTransition,
  releaseTransitionLeases,
  revokePreemptionLeases,
  resumeTransition,
  suspendPreemptionVictim,
  suspendTransition,
  verifyTransitionSuccess,
  type JevDecisionFrameV41,
  type JevDecisionV41,
  type ResourceClaim,
  type ResumeProof,
  type RuntimeBinding,
  type TransitionClass,
  type TransitionContract,
  type WorldIdentity,
} from './model.ts'

const world: WorldIdentity = { serverId: 'local', dimension: 'minecraft:overworld', worldEpoch: 7 }
const binding: RuntimeBinding = { generationId: 'gen-a', factRevision: 10, registryRevision: 3, missionRevision: 2 }

function claim(resource: string, mode: ResourceClaim['mode'] = 'EXCLUSIVE_WRITE'): ResourceClaim {
  return { resource, mode, preemptible: true, resumable: true, maxNonPreemptibleMs: null }
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

function predicateProofs(predicates: readonly string[], nextBinding: RuntimeBinding, proofWorld: WorldIdentity = world) {
  return predicates.map((predicateId) => ({ predicateId, factRevision: nextBinding.factRevision, world: proofWorld, evidenceId: `proof:${predicateId}`, truth: 'true' as const }))
}

function resumeProof(c: TransitionContract, nextBinding: RuntimeBinding = binding): ResumeProof {
  return {
    transitionId: c.transitionId,
    contractHash: c.contractHash,
    world: c.world,
    binding: nextBinding,
    witnessRevision: 0,
    registryContainsTransition: true,
    missionAuthorizesPredicate: true,
    requiresVerified: predicateProofs(c.requires, nextBinding, c.world),
    invariantsVerified: predicateProofs(c.invariants, nextBinding, c.world),
  }
}

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
    const resumed = resumeTransition(suspendedReach, reach, resumeProof(reach, { ...binding, factRevision: 11 }), world, { ...binding, factRevision: 11 })
    expect(resumed.ok).toBe(true)
    if (!resumed.ok) return
    expect(resumed.state.transitionId).toBe(reach.transitionId)
    expect(resumed.state.contractHash).toBe(reach.contractHash)
    expect(resumed.state.lifecycle).toBe('RUNNABLE')
  })

  test('stale world identity prevents resume', () => {
    const suspended = suspendTransition(initialRuntimeState(reach, binding), 'PREEMPTED')
    const changed = { ...world, worldEpoch: world.worldEpoch + 1 }
    const resumed = resumeTransition(suspended, reach, { ...resumeProof(reach, { ...binding, factRevision: 12 }), world: changed }, changed, { ...binding, factRevision: 12 })
    expect(resumed).toEqual({ ok: false, reason: 'WORLD_CHANGED' })
  })

  test('generation change requires fresh revalidation before rebind', () => {
    const suspended = suspendTransition(initialRuntimeState(reach, binding), 'GENERATION_REBIND_REQUIRED')
    const nextBinding = { ...binding, generationId: 'gen-b', factRevision: 11 }
    expect(resumeTransition(suspended, reach, { ...resumeProof(reach, nextBinding), invariantsVerified: [] }, world, nextBinding)).toEqual({ ok: false, reason: 'PROOF_INCOMPLETE' })
    expect(resumeTransition(suspended, reach, resumeProof(reach, nextBinding), world, nextBinding).ok).toBe(true)
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
      transitionId: reach.transitionId,
      contractHash: reach.contractHash,
      binding,
      deterministic: true,
      causalCredit: 'external',
      requiresVerified: predicateProofs(reach.requires, binding),
      invariantsVerified: predicateProofs(reach.invariants, binding),
      fact: {
        factId: 'fact:arrived',
        predicateId: reach.desiredPredicate,
        value: true,
        truth: 'true',
        world,
        factRevision: binding.factRevision,
        observedAtMs: 100,
        provenance: 'fresh-sensor',
      },
    }, world, binding)
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

  test('irreversible effect token is bound to world, generation, lease and permit', () => {
    const dig = { ...contract('dig:a', 'MISSION', [claim('world.blocks')]), effects: [{ kind: 'DIG' as const, scope: 'block@1,2,3', irreversible: true, maxCount: 1 }] }
    const granted = grantLeaseBundle(dig.transitionId, dig.claims, [], 7)
    expect(granted.ok).toBe(true)
    if (!granted.ok) return
    const active = activateTransition(initialRuntimeState(dig, binding), ['world.blocks'])
    const token = {
      commitId: 'commit:1', transitionId: dig.transitionId, contractHash: dig.contractHash,
      effect: 'DIG' as const, scope: 'block@1,2,3', world, binding,
      leaseFingerprint: leaseBindingFingerprint(dig.transitionId, granted.leases),
      permitKey: permitKey('DIG', 'block@1,2,3'), expiresAtMs: 1_000,
    }
    expect(effectCommitIsCurrent(token, dig, active, world, binding, granted.leases, 500)).toBe(true)
    expect(effectCommitIsCurrent(token, dig, active, world, { ...binding, generationId: 'gen-b' }, granted.leases, 500)).toBe(false)
    expect(effectCommitIsCurrent(token, dig, active, { ...world, worldEpoch: 8 }, binding, granted.leases, 500)).toBe(false)
    expect(effectCommitIsCurrent(token, dig, active, world, binding, [], 500)).toBe(false)
    expect(effectCommitIsCurrent({ ...token, permitKey: 'DIG:other' }, dig, active, world, binding, granted.leases, 500)).toBe(false)
    expect(effectCommitIsCurrent(token, dig, active, world, binding, granted.leases, 1_001)).toBe(false)
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

  test('hierarchical resource parent conflicts with child exclusive ownership', () => {
    expect(resourcePathsOverlap('body', 'body.locomotion')).toBe(true)
    expect(resourcePathsOverlap('inventory', 'inventory.slot.hotbar.1')).toBe(true)
    expect(resourcePathsOverlap('station:furnace', 'station:furnace@1,2,3')).toBe(true)
    const parent = contract('body-owner', 'MISSION', [claim('body')])
    const child = contract('locomotion-owner', 'MISSION', [claim('body.locomotion')])
    const first = grantLeaseBundle(parent.transitionId, parent.claims, [], 20)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(grantLeaseBundle(child.transitionId, child.claims, first.leases, 20).ok).toBe(false)
  })

  test('resume rejects fact, registry and mission revision regression even with a typed proof', () => {
    const suspended = suspendTransition(initialRuntimeState(reach, binding), 'PREEMPTED')
    expect(resumeTransition(suspended, reach, resumeProof(reach, { ...binding, factRevision: 9 }), world, binding)).toEqual({ ok: false, reason: 'STALE_REBIND' })
    expect(resumeTransition(suspended, reach, resumeProof(reach, { ...binding, registryRevision: 2 }), world, binding)).toEqual({ ok: false, reason: 'STALE_REBIND' })
    expect(resumeTransition(suspended, reach, resumeProof(reach, { ...binding, missionRevision: 1 }), world, binding)).toEqual({ ok: false, reason: 'STALE_REBIND' })
  })

  test('resume accepts a newer mission revision only with complete proof on that binding', () => {
    const suspended = suspendTransition(initialRuntimeState(reach, binding), 'PREEMPTED')
    const next = { ...binding, missionRevision: 3, factRevision: 11 }
    expect(resumeTransition(suspended, reach, { ...resumeProof(reach, next), invariantsVerified: [] }, world, next)).toEqual({ ok: false, reason: 'PROOF_INCOMPLETE' })
    expect(resumeTransition(suspended, reach, resumeProof(reach, next), world, next).ok).toBe(true)
  })

  test('VERIFY cannot close SUCCESS with another contract sharing the desired predicate', () => {
    const other = { ...contract('reach:b', 'MISSION', reach.claims), desiredPredicate: reach.desiredPredicate }
    const state = initialRuntimeState(reach, binding)
    const evidence = {
      transitionId: other.transitionId, contractHash: other.contractHash, binding,
      deterministic: true as const, causalCredit: 'external' as const,
      requiresVerified: predicateProofs(other.requires, binding), invariantsVerified: predicateProofs(other.invariants, binding),
      fact: { factId: 'fact:same-predicate', predicateId: reach.desiredPredicate, value: true, truth: 'true' as const,
        world, factRevision: binding.factRevision, observedAtMs: 1, provenance: 'sensor' },
    }
    expect(verifyTransitionSuccess(other, state, evidence, world, binding).lifecycle).not.toBe('TERMINAL')
  })

  test('VERIFY requires evidence at the exact live runtime binding', () => {
    const state = initialRuntimeState(reach, binding)
    const stale = { ...binding, factRevision: binding.factRevision - 1 }
    const evidence = {
      transitionId: reach.transitionId, contractHash: reach.contractHash, binding: stale,
      deterministic: true as const, causalCredit: 'self' as const,
      requiresVerified: predicateProofs(reach.requires, stale), invariantsVerified: predicateProofs(reach.invariants, stale),
      fact: { factId: 'fact:stale', predicateId: reach.desiredPredicate, value: true, truth: 'true' as const,
        world, factRevision: stale.factRevision, observedAtMs: 1, provenance: 'stale-sensor' },
    }
    expect(verifyTransitionSuccess(reach, state, evidence, world, binding).lifecycle).not.toBe('TERMINAL')
  })

  test('preemption requires controller safe-yield acknowledgement before revoke and grant', () => {
    const viability = contract('viability:lava', 'VIABILITY', [claim('body.locomotion')])
    const granted = grantLeaseBundle(reach.transitionId, reach.claims, [], 30)
    expect(granted.ok).toBe(true)
    if (!granted.ok) return
    const active = activateTransition(initialRuntimeState(reach, binding), ['body.locomotion'])
    const tx = requestPreemption('p:1', reach.transitionId, viability.transitionId, viability.claims, granted.leases, 100, 100)
    expect(tx?.phase).toBe('PREEMPT_REQUESTED')
    if (tx === null) return
    expect(executePreemption(tx, active, viability.claims, granted.leases, 31)).toEqual({ ok: false, reason: 'SAFE_YIELD_REQUIRED' })
    const ack = acknowledgePreemptionYield(tx, 150, true)
    const result = executePreemption(ack, active, viability.claims, granted.leases, 31)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.phases).toEqual(['YIELD_ACKNOWLEDGED', 'LEASES_REVOKED', 'SUSPENDED', 'GRANTED'])
    expect(result.victimState.lifecycle).toBe('SUSPENDED')
    expect(result.leases.find((lease) => lease.resource === 'body.locomotion')?.owner).toBe(viability.transitionId)
  })

  test('non-preemptible bounded section inherits priority and cannot be force-revoked at deadline', () => {
    const criticalClaim = { ...claim('inventory'), preemptible: false, maxNonPreemptibleMs: 20 }
    const victim = contract('craft:critical', 'MISSION', [criticalClaim])
    const requester = contract('viability:inventory', 'VIABILITY', [claim('inventory')])
    const granted = grantLeaseBundle(victim.transitionId, victim.claims, [], 40)
    expect(granted.ok).toBe(true)
    if (!granted.ok) return
    const active = activateTransition(initialRuntimeState(victim, binding), ['inventory'])
    const tx = requestPreemption('p:2', victim.transitionId, requester.transitionId, requester.claims, granted.leases, 100, 20)
    expect(tx?.phase).toBe('WAITING_BOUNDED_SECTION')
    expect(tx?.priorityInherited).toBe(true)
    if (tx === null) return
    const expired = acknowledgePreemptionYield(tx, 121, false)
    expect(expired.phase).toBe('DEADLINE_EXPIRED')
    expect(executePreemption(expired, active, requester.claims, granted.leases, 41)).toEqual({ ok: false, reason: 'DEADLINE_EXPIRED' })
    expect(granted.leases.find((lease) => lease.resource === 'inventory')?.owner).toBe(victim.transitionId)
  })

  test('Jev currentness requires frame binding == decision binding == live binding', () => {
    const frame: JevDecisionFrameV41 = { frameHash: 'frame:bind', schedulerEpoch: 50, world, binding,
      enabledTransitionIds: [reach.transitionId], activeTransitionIds: [], suspendedTransitionIds: [], conflicts: [] }
    const decision: JevDecisionV41 = { frameHash: frame.frameHash, schedulerEpoch: frame.schedulerEpoch,
      binding: { ...binding, missionRevision: binding.missionRevision + 1 }, rankedTransitionIds: [reach.transitionId], tacticChoices: {} }
    expect(jevDecisionIsCurrent(frame, decision, decision.binding, 50)).toBe(false)
  })

  test('ATR mutation APIs monotonically revise registry and reject semantic identity mutation', () => {
    let registry = createRegistry()
    registry = putTransition(registry, initialRuntimeState(reach, binding))
    expect(registry.revision).toBe(1)
    registry = mutateTransition(registry, reach.transitionId, (state) => suspendTransition(state, 'PREEMPTED'))
    expect(registry.revision).toBe(2)
    expect(registry.transitions.get(reach.transitionId)?.lifecycle).toBe('SUSPENDED')
    expect(() => mutateTransition(registry, reach.transitionId, (state) => ({ ...state, contractHash: 'evil' }))).toThrow()
    registry = removeTransition(registry, reach.transitionId)
    expect(registry.revision).toBe(3)
    expect(registry.transitions.has(reach.transitionId)).toBe(false)
  })


  test('resume predicate proof must be from the exact new fact revision and world', () => {
    const suspended = suspendTransition(initialRuntimeState(reach, binding), 'PREEMPTED')
    const next = { ...binding, factRevision: 11 }
    const wrongRevision = { ...resumeProof(reach, next), invariantsVerified: predicateProofs(reach.invariants, binding) }
    expect(resumeTransition(suspended, reach, wrongRevision, world, next)).toEqual({ ok: false, reason: 'PROOF_INCOMPLETE' })
    const wrongWorld = { ...world, dimension: 'minecraft:the_nether' }
    const wrongWorldProof = { ...resumeProof(reach, next), invariantsVerified: predicateProofs(reach.invariants, next, wrongWorld) }
    expect(resumeTransition(suspended, reach, wrongWorldProof, world, next)).toEqual({ ok: false, reason: 'PROOF_INCOMPLETE' })
  })

  test('preemption staged APIs make revoke -> suspend -> grant order unskippable', () => {
    const viability = contract('viability:stage', 'VIABILITY', [claim('body.locomotion')])
    const granted = grantLeaseBundle(reach.transitionId, reach.claims, [], 60)
    expect(granted.ok).toBe(true)
    if (!granted.ok) return
    const active = activateTransition(initialRuntimeState(reach, binding), ['body.locomotion'])
    const tx0 = requestPreemption('p:stage', reach.transitionId, viability.transitionId, viability.claims, granted.leases, 0, 50)
    if (tx0 === null) return
    expect(() => revokePreemptionLeases(tx0, granted.leases)).toThrow()
    const tx1 = acknowledgePreemptionYield(tx0, 1, true)
    const revoked = revokePreemptionLeases(tx1, granted.leases)
    expect(revoked.transaction.phase).toBe('LEASES_REVOKED')
    expect(revoked.leases.some((lease) => lease.owner === reach.transitionId)).toBe(false)
    expect(() => grantPreemptionRequester(revoked.transaction, viability.claims, revoked.leases, 61)).toThrow()
    const suspended = suspendPreemptionVictim(revoked.transaction, active)
    expect(suspended.transaction.phase).toBe('SUSPENDED')
    const final = grantPreemptionRequester(suspended.transaction, viability.claims, revoked.leases, 61)
    expect(final.ok).toBe(true)
    if (final.ok) expect(final.transaction.phase).toBe('GRANTED')
  })

  test('non-preemptible claim without a finite bound cannot enter preemption protocol', () => {
    const badClaim = { ...claim('inventory'), preemptible: false, maxNonPreemptibleMs: null }
    const victim = contract('bad:critical', 'MISSION', [badClaim])
    const requester = contract('viability:bad', 'VIABILITY', [claim('inventory')])
    expect(() => grantLeaseBundle(victim.transitionId, victim.claims, [], 70)).toThrow()
    expect(requester.transitionId).toBe('viability:bad')
  })


  test('resume proof must equal the live binding, not merely be newer than suspended state', () => {
    const suspended = suspendTransition(initialRuntimeState(reach, binding), 'PREEMPTED')
    const proofBinding = { ...binding, factRevision: 11, registryRevision: 4 }
    const live = { ...proofBinding, registryRevision: 5 }
    expect(resumeTransition(suspended, reach, resumeProof(reach, proofBinding), world, live)).toEqual({ ok: false, reason: 'STALE_REBIND' })
  })

  test('VERIFY cannot use a state/evidence binding older than the live binding', () => {
    const state = initialRuntimeState(reach, binding)
    const evidence = {
      transitionId: reach.transitionId, contractHash: reach.contractHash, binding,
      deterministic: true as const, causalCredit: 'self' as const,
      requiresVerified: predicateProofs(reach.requires, binding), invariantsVerified: predicateProofs(reach.invariants, binding),
      fact: { factId: 'fact:true-but-old', predicateId: reach.desiredPredicate, value: true, truth: 'true' as const,
        world, factRevision: binding.factRevision, observedAtMs: 1, provenance: 'sensor' },
    }
    const live = { ...binding, factRevision: binding.factRevision + 1 }
    expect(verifyTransitionSuccess(reach, state, evidence, world, live).lifecycle).not.toBe('TERMINAL')
  })

  test('ATR put cannot launder an existing transitionId into another contract', () => {
    let registry = createRegistry([initialRuntimeState(reach, binding)])
    const evil = { ...initialRuntimeState(reach, binding), contractHash: 'hash:other' }
    expect(() => putTransition(registry, evil)).toThrow()
    expect(registry.transitions.get(reach.transitionId)?.contractHash).toBe(reach.contractHash)
  })


  test('late safe-yield ACK still records bounded-section deadline expiry', () => {
    const criticalClaim = { ...claim('inventory'), preemptible: false, maxNonPreemptibleMs: 20 }
    const victim = contract('craft:late', 'MISSION', [criticalClaim])
    const requester = contract('viability:late', 'VIABILITY', [claim('inventory')])
    const granted = grantLeaseBundle(victim.transitionId, victim.claims, [], 80)
    expect(granted.ok).toBe(true)
    if (!granted.ok) return
    const tx = requestPreemption('p:late', victim.transitionId, requester.transitionId, requester.claims, granted.leases, 100, 5)
    if (tx === null) return
    expect(tx.yieldDeadlineAtMs).toBe(120)
    expect(acknowledgePreemptionYield(tx, 121, true).phase).toBe('DEADLINE_EXPIRED')
  })

  test('preemption cannot suspend a state belonging to a different victim', () => {
    const tx = { transactionId: 'p:mismatch', victim: reach.transitionId, requester: 'viability:x', phase: 'LEASES_REVOKED' as const,
      requestedAtMs: 0, yieldDeadlineAtMs: 10, conflictResources: ['body.locomotion'], priorityInherited: false }
    const other = contract('reach:other', 'MISSION', [claim('body.locomotion')])
    expect(() => suspendPreemptionVictim(tx, initialRuntimeState(other, binding))).toThrow()
  })

  test('ATR initialization rejects duplicate semantic ids with different contracts', () => {
    const a = initialRuntimeState(reach, binding)
    const b = { ...a, contractHash: 'hash:collision' }
    expect(() => createRegistry([a, b])).toThrow()
  })

  test('witness revision cannot regress across resume', () => {
    const suspended = { ...suspendTransition(initialRuntimeState(reach, binding), 'PREEMPTED'), witnessRevision: 4 }
    const proof = { ...resumeProof(reach), witnessRevision: 3 }
    expect(resumeTransition(suspended, reach, proof, world, binding)).toEqual({ ok: false, reason: 'STALE_REBIND' })
  })

})
