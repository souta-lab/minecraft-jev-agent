import { describe, expect, test } from 'bun:test'
import {
  applyKernelCommand,
  assertKernelInvariants,
  createKernelState,
  createTransitionContract,
  kernelSemanticDigest,
  recoverKernelFromJournal,
  replayKernelEvents,
  resourceId,
  type CanonicalTransitionContract,
  type EffectPermitSpec,
  type KernelCommand,
  type KernelEvent,
  type KernelState,
  type ResourceClaimSpec,
  type TransitionClass,
  type TransitionContractSpec,
  type WorldIdentity,
} from './kernel.ts'
import { trustedContractCompiler, trustedController, trustedDispatcher, trustedJournalRecovery, trustedMissionAuthority, trustedProgressEvaluator, trustedScheduler, trustedVerifier, trustedWitnessValidator, trustedWorldAdapter } from './kernel-internal/trusted-adapter.ts'

// Adversarial concurrency/crash closure. Each test is a short deterministic
// trace against the real reducer. Tests named "fences" pin fail-closed
// behavior the invariants depend on; tests named "characterizes" document a
// semantic boundary the adversarial review surfaced (cooperative-yield
// starvation, orphan preemption transactions, dead-transition bookkeeping).
// A characterization test pins what the kernel does today; whether the pinned
// semantics are acceptable is decided by the architecture review, not by this
// file.

const world: WorldIdentity = { serverId: 'local', dimension: 'minecraft:overworld', worldEpoch: 7 }
const verifier = { id: 'verifier:world', version: '1' } as const
const witnessValidator = { id: 'witness:generic', version: '1' } as const
const progress = { id: 'progress:generic', version: '1' } as const
const terminalPolicy = { id: 'terminal:generic', version: '1' } as const
const controllerDefinition = { id: 'controller:generic', version: '1' } as const
const compiler = { id: 'compiler:test', version: '1' } as const
const missionAuthority = { id: 'mission:test', version: '1' } as const
const locomotion = resourceId('body', ['locomotion'])
const worldBlocks = resourceId('world', ['blocks'])
const inventory = resourceId('inventory')

function claim(resource = locomotion, mode: ResourceClaimSpec['mode'] = 'EXCLUSIVE_WRITE', extras: Partial<ResourceClaimSpec> = {}): ResourceClaimSpec {
  return { resource, mode, preemptible: true, resumable: true, maxNonPreemptibleMs: null, ...extras }
}
function effect(kind: EffectPermitSpec['kind'], scope: string, required = locomotion, maxCount = 1): EffectPermitSpec {
  return { kind, scope, irreversible: true, maxCount, requiredResources: [{ resource: required, mode: 'EXCLUSIVE_WRITE' }] }
}
function contract(id: string, klass: TransitionClass = 'MISSION', claims: readonly ResourceClaimSpec[] = [claim()], effects: readonly EffectPermitSpec[] = [], patch: Partial<TransitionContractSpec> = {}): CanonicalTransitionContract {
  const desiredPredicate = patch.desiredPredicate ?? `goal:${id}`
  return createTransitionContract({
    transitionId: id,
    family: id.split(':')[0] ?? id,
    class: klass,
    urgency: patch.urgency ?? 0,
    world,
    desiredPredicate,
    requires: patch.requires ?? [],
    ensures: patch.ensures ?? [desiredPredicate],
    invariants: patch.invariants ?? [],
    claims,
    effects,
    budget: patch.budget ?? { maxActiveMs: 1_000, deadlineAtMonoMs: 10_000, maxMechanicalSteps: 100, resources: { items: 10 }, risk: { damage: 10 } },
    progressDefinition: patch.progressDefinition ?? progress,
    controllerDefinition: patch.controllerDefinition ?? controllerDefinition,
    verificationDefinition: patch.verificationDefinition ?? verifier,
    terminalPolicy: patch.terminalPolicy ?? terminalPolicy,
    witnessValidation: patch.witnessValidation ?? null,
  })
}
function initial(contracts: readonly CanonicalTransitionContract[]): KernelState {
  return createKernelState({ world, generationId: 'gen-a', missionPredicates: contracts.map((c) => c.desiredPredicate), verifierRegistry: [verifier], progressRegistry: [progress], contractCompilerRegistry: [compiler], missionAuthority, minResidencyMs: 250, preemptibleYieldBudgetMs: 50 })
}
type LooseCommand = Record<string, unknown> & { readonly kind: string }
function authorize(state: KernelState, command: LooseCommand): KernelCommand {
  if ('capability' in command) return command as unknown as KernelCommand
  switch (command.kind) {
    case 'REGISTER_TRANSITION': return { ...command, compiler, capability: trustedContractCompiler(compiler.id) } as unknown as KernelCommand
    case 'ADMIT_TRANSITION': case 'ACQUIRE_DECLARED_RESOURCES': case 'PAUSE_ACTIVE': case 'RESUME_TRANSITION': case 'AGE_RUNNABLE': case 'START_PREEMPTION': case 'COMMIT_PREEMPTION': case 'REQUEST_CANCEL':
      return { ...command, capability: trustedScheduler() } as unknown as KernelCommand
    case 'ACK_PREEMPTION_YIELD': return { ...command, capability: trustedController(String(command.victimId), state.transitionContracts[String(command.victimId)] ?? '', state.generationId) } as unknown as KernelCommand
    case 'ACK_PAUSE_YIELD': case 'ACK_TERMINAL_YIELD': case 'ISSUE_EFFECT': case 'APPEND_RECORD': case 'ACK_CANCEL_YIELD': {
      const id = String(command.transitionId); return { ...command, capability: trustedController(id, state.transitionContracts[id] ?? '', state.generationId) } as unknown as KernelCommand
    }
    case 'DEBIT_USAGE': {
      const id = String(command.actorTransitionId); return { ...command, capability: trustedController(id, state.transitionContracts[id] ?? '', state.generationId) } as unknown as KernelCommand
    }
    case 'BEGIN_EFFECT_DISPATCH': return { ...command, capability: trustedDispatcher() } as unknown as KernelCommand
    case 'REPORT_PROGRESS': return { ...command, evaluator: progress, capability: trustedProgressEvaluator(progress.id) } as unknown as KernelCommand
    case 'VERIFY_SUCCESS': return { ...command, verifier, capability: trustedVerifier(verifier.id) } as unknown as KernelCommand
    case 'UPDATE_MISSION': return { ...command, authority: missionAuthority, capability: trustedMissionAuthority(missionAuthority.id) } as unknown as KernelCommand
    case 'ACCEPT_WITNESS_PROOF': return { ...command, validator: witnessValidator, capability: trustedWitnessValidator(witnessValidator.id) } as unknown as KernelCommand
    default: return command as unknown as KernelCommand
  }
}
function apply(state: KernelState, command: LooseCommand, events?: KernelEvent[]): KernelState {
  const authorized = authorize(state, command)
  const r = applyKernelCommand(state, authorized)
  if (!r.ok) throw new Error(`${command.kind}: ${r.reason}`)
  events?.push(...r.events)
  assertKernelInvariants(r.state)
  return r.state
}
function reject(state: KernelState, command: LooseCommand, reason?: string): string {
  const r = applyKernelCommand(state, authorize(state, command))
  expect(r.ok).toBe(false)
  if (r.ok) return ''
  if (reason !== undefined) expect(r.reason).toBe(reason)
  expect(r.state).toBe(state)
  return r.reason
}
function registerAdmit(state: KernelState, c: CanonicalTransitionContract, events?: KernelEvent[]): KernelState {
  state = apply(state, { kind: 'REGISTER_TRANSITION', contract: c }, events)
  return apply(state, { kind: 'ADMIT_TRANSITION', transitionId: c.transitionId }, events)
}
function activate(state: KernelState, c: CanonicalTransitionContract, events?: KernelEvent[]): KernelState {
  state = registerAdmit(state, c, events)
  return apply(state, { kind: 'ACQUIRE_DECLARED_RESOURCES', transitionId: c.transitionId }, events)
}
function acceptFacts(state: KernelState, facts: readonly { predicateId: string; truth?: 'true' | 'false' | 'unknown'; valueHash?: string; effectCommitId?: string | null }[], observedAtMonoMs?: number, events?: KernelEvent[]): KernelState {
  return apply(state, {
    kind: 'ACCEPT_VERIFIED_SNAPSHOT', verifier, materialChange: true, observedAtMonoMs: observedAtMonoMs ?? state.monotonicMs,
    facts: facts.map((f) => ({ predicateId: f.predicateId, truth: f.truth ?? 'true', valueHash: f.valueHash ?? `hash:${f.predicateId}`, effectCommitId: f.effectCommitId ?? null })),
    capability: trustedVerifier(verifier.id),
  }, events)
}
function advance(state: KernelState, toMonoMs: number, events?: KernelEvent[]): KernelState {
  return apply(state, { kind: 'ADVANCE_TIME', toMonoMs, capability: trustedWorldAdapter('clock') }, events)
}
function issue(state: KernelState, c: CanonicalTransitionContract, kind: EffectPermitSpec['kind'], scope: string, ttlMs = 100, events?: KernelEvent[]): { state: KernelState; commitId: string } {
  const before = new Set(Object.keys(state.effects))
  state = apply(state, { kind: 'ISSUE_EFFECT', transitionId: c.transitionId, effect: kind, scope, ttlMs }, events)
  const commitId = Object.keys(state.effects).find((id) => !before.has(id))
  if (commitId === undefined) throw new Error('no commit id')
  return { state, commitId }
}
function planPreemption(state: KernelState, requester: CanonicalTransitionContract, events?: KernelEvent[]): { state: KernelState; transactionId: string } {
  const evts: KernelEvent[] = []
  state = apply(state, { kind: 'START_PREEMPTION', requesterId: requester.transitionId }, evts)
  const transactionId = String(evts[0]!.data.transactionId)
  events?.push(...evts)
  return { state, transactionId }
}
const criticalClaim = () => claim(locomotion, 'EXCLUSIVE_WRITE', { preemptible: false, resumable: true, maxNonPreemptibleMs: 500 })

describe('V4.1.2 adversarial safe-yield and preemption edges', () => {
  test('K3 characterizes: a preemptible victim that never yields wedges the preemptor past the yield deadline', () => {
    const victim = contract('victim:walk', 'MISSION', [claim()], [effect('MOVE', 'scope:victim:walk')])
    const requester = contract('requester:urgent', 'MISSION', [claim()], [], { urgency: 100 })
    let state = initial([victim, requester])
    state = activate(state, victim)
    state = registerAdmit(state, requester)
    const plan = planPreemption(state, requester); state = plan.state

    // The victim's yield deadline passes with no acknowledgement and nothing
    // forces the yield: the kernel only records lateness when an ack arrives.
    state = advance(state, 1_000)
    reject(state, { kind: 'COMMIT_PREEMPTION', transactionId: plan.transactionId }, 'PREEMPTION_NOT_READY')
    reject(state, { kind: 'ACQUIRE_DECLARED_RESOURCES', transitionId: requester.transitionId }, 'RESOURCE_CONFLICT')
    expect(state.transitions[victim.transitionId]!.lifecycle).toBe('ACTIVE')
    // The victim is still fully effect-eligible: the unacknowledged plan does
    // not fence it.
    const issued = issue(state, victim, 'MOVE', 'scope:victim:walk'); state = issued.state

    // Scheduler recourse exists but is destructive: cancel terminalizes the
    // victim instead of suspending it, so resumable work is lost.
    state = apply(state, { kind: 'REQUEST_CANCEL', transitionId: victim.transitionId, reason: 'preemption wedge' })
    expect(state.transitions[victim.transitionId]!.terminalOutcome).toEqual({ kind: 'CANCELED', reason: 'preemption wedge' })
    state = apply(state, { kind: 'ACQUIRE_DECLARED_RESOURCES', transitionId: requester.transitionId })
    expect(state.transitions[requester.transitionId]!.lifecycle).toBe('ACTIVE')
  })

  test('K4 characterizes: the scheduler can pause a yield-acknowledged victim out of a READY transaction', () => {
    const victim = contract('victim:walk', 'MISSION', [claim()])
    const requester = contract('requester:urgent', 'MISSION', [claim()], [], { urgency: 100 })
    let state = initial([victim, requester])
    state = activate(state, victim)
    state = registerAdmit(state, requester)
    const plan = planPreemption(state, requester); state = plan.state
    state = apply(state, { kind: 'ACK_PREEMPTION_YIELD', transactionId: plan.transactionId, victimId: victim.transitionId, safeYield: true, atMonoMs: state.monotonicMs })
    expect(state.preemptions[plan.transactionId]!.status).toBe('READY')

    // PAUSE_ACTIVE does not gate on preemptionYielded: the yielded victim's
    // leases are released outside the atomic transaction, so the READY plan
    // can never commit and can never be cancelled.
    state = apply(state, { kind: 'PAUSE_ACTIVE', transitionId: victim.transitionId, to: 'OBSERVING', reason: 'scheduler pause' })
    expect(state.transitions[victim.transitionId]!.lifecycle).toBe('OBSERVING')
    reject(state, { kind: 'COMMIT_PREEMPTION', transactionId: plan.transactionId }, 'STALE_PREEMPTION')
    reject(state, { kind: 'ACK_PREEMPTION_YIELD', transactionId: plan.transactionId, victimId: victim.transitionId, safeYield: true, atMonoMs: state.monotonicMs }, 'STALE_PREEMPTION')
    expect(state.preemptions[plan.transactionId]!.status).toBe('READY')
  })

  test('K4b characterizes: a non-preemptible victim can veto an acknowledged preemption by yielding to pause', () => {
    const victim = contract('victim:critical', 'MISSION', [criticalClaim()])
    const requester = contract('requester:urgent', 'MISSION', [claim()], [], { urgency: 100 })
    let state = initial([victim, requester])
    state = activate(state, victim)
    state = registerAdmit(state, requester)
    const plan = planPreemption(state, requester); state = plan.state
    state = apply(state, { kind: 'ACK_PREEMPTION_YIELD', transactionId: plan.transactionId, victimId: victim.transitionId, safeYield: true, atMonoMs: state.monotonicMs })
    expect(state.preemptions[plan.transactionId]!.status).toBe('READY')

    // ACK_PAUSE_YIELD also lacks the preemptionYielded gate: the victim's own
    // controller unilaterally releases the critical lease mid-transaction and
    // the atomic commit becomes unresolvable.
    state = apply(state, { kind: 'ACK_PAUSE_YIELD', transitionId: victim.transitionId, to: 'OBSERVING', reason: 'victim pause', atMonoMs: state.monotonicMs })
    expect(state.transitions[victim.transitionId]!.lifecycle).toBe('OBSERVING')
    expect(Object.keys(state.leases)).toHaveLength(0)
    reject(state, { kind: 'COMMIT_PREEMPTION', transactionId: plan.transactionId }, 'STALE_PREEMPTION')
    expect(state.preemptions[plan.transactionId]!.status).toBe('READY')
    // The requester is now free, but only because the victim leaked its lease
    // outside the transaction - the plan did not suspend it.
    state = apply(state, { kind: 'ACQUIRE_DECLARED_RESOURCES', transitionId: requester.transitionId })
    expect(state.transitions[requester.transitionId]!.lifecycle).toBe('ACTIVE')
  })

  test('K5 characterizes: a victim pausing mid-plan orphans the transaction record forever', () => {
    const victim = contract('victim:walk', 'MISSION', [claim()])
    const requester = contract('requester:urgent', 'MISSION', [claim()], [], { urgency: 100 })
    let state = initial([victim, requester])
    state = activate(state, victim)
    state = registerAdmit(state, requester)
    const plan = planPreemption(state, requester); state = plan.state

    state = apply(state, { kind: 'PAUSE_ACTIVE', transitionId: victim.transitionId, to: 'OBSERVING', reason: 'unrelated pause' })
    // Neither ack nor commit can resolve the orphaned plan; no cancel command
    // exists. The record sits in state.preemptions until a participant
    // terminalizes or the generation changes.
    reject(state, { kind: 'ACK_PREEMPTION_YIELD', transactionId: plan.transactionId, victimId: victim.transitionId, safeYield: true, atMonoMs: state.monotonicMs }, 'STALE_PREEMPTION')
    reject(state, { kind: 'COMMIT_PREEMPTION', transactionId: plan.transactionId }, 'STALE_PREEMPTION')
    state = apply(state, { kind: 'ACQUIRE_DECLARED_RESOURCES', transitionId: requester.transitionId })
    expect(state.preemptions[plan.transactionId]!.status).toBe('PLANNED')
  })

  test('K6 fences: requesting cancel on a non-preemptible critical section quiesces in-flight dispatch immediately', () => {
    const c = contract('mission:dig', 'MISSION', [claim(worldBlocks, 'EXCLUSIVE_WRITE', { preemptible: false, resumable: true, maxNonPreemptibleMs: 500 })], [effect('DIG', 'scope:dig', worldBlocks)])
    let state = initial([c])
    state = activate(state, c)
    const issued = issue(state, c, 'DIG', 'scope:dig'); state = issued.state
    state = apply(state, { kind: 'BEGIN_EFFECT_DISPATCH', commitId: issued.commitId })
    expect(state.effects[issued.commitId]!.status).toBe('DISPATCHING')

    // The cancel request marks the still-in-flight irreversible dispatch
    // UNKNOWN before the safe yield completes: the transition still owns the
    // critical lease, but the dispatch can no longer settle as OBSERVED under
    // the live binding.
    state = apply(state, { kind: 'REQUEST_CANCEL', transitionId: c.transitionId, reason: 'cancel during critical' })
    const t = state.transitions[c.transitionId]!
    expect(t.lifecycle).toBe('ACTIVE')
    expect(t.cancelRequested).toBe(true)
    expect(state.effects[issued.commitId]!.status).toBe('UNKNOWN')
    state = apply(state, { kind: 'ACK_CANCEL_YIELD', transitionId: c.transitionId, atMonoMs: state.monotonicMs })
    expect(state.transitions[c.transitionId]!.terminalOutcome).toEqual({ kind: 'CANCELED', reason: 'cancel safe-yield' })
  })

  test('K7 characterizes: terminal yield does not gate an in-flight dispatch the way preemption yield does', () => {
    const c = contract('mission:dig', 'MISSION', [claim(worldBlocks, 'EXCLUSIVE_WRITE', { preemptible: false, resumable: true, maxNonPreemptibleMs: 500 })], [effect('DIG', 'scope:dig', worldBlocks)])
    let state = initial([c])
    state = activate(state, c)
    const issued = issue(state, c, 'DIG', 'scope:dig'); state = issued.state
    state = apply(state, { kind: 'BEGIN_EFFECT_DISPATCH', commitId: issued.commitId })
    state = acceptFacts(state, [{ predicateId: c.desiredPredicate }])
    state = apply(state, { kind: 'VERIFY_SUCCESS', transitionId: c.transitionId, causalCredit: 'self' })
    expect(state.transitions[c.transitionId]!.pendingTerminalOutcome?.kind).toBe('SUCCESS')

    state = apply(state, { kind: 'ACK_TERMINAL_YIELD', transitionId: c.transitionId, atMonoMs: state.monotonicMs })
    expect(state.transitions[c.transitionId]!.terminalOutcome?.kind).toBe('SUCCESS')
    expect(state.effects[issued.commitId]!.status).toBe('UNKNOWN')
  })

  test('K8 characterizes: a world change discards a pending verified SUCCESS that a generation change would honor', () => {
    const c = contract('mission:critical', 'MISSION', [criticalClaim()])
    let state = initial([c])
    state = activate(state, c)
    state = acceptFacts(state, [{ predicateId: c.desiredPredicate }])
    state = apply(state, { kind: 'VERIFY_SUCCESS', transitionId: c.transitionId, causalCredit: 'self' })
    expect(state.transitions[c.transitionId]!.pendingTerminalOutcome?.kind).toBe('SUCCESS')

    state = apply(state, { kind: 'CHANGE_WORLD', world: { ...world, worldEpoch: world.worldEpoch + 1 }, capability: trustedWorldAdapter('world') })
    const outcome = state.transitions[c.transitionId]!.terminalOutcome
    expect(outcome?.kind).toBe('WORLD_CHANGED')
    // The verified ensures belonged to the old world; the journaled terminal
    // outcome records the world move rather than the superseded verify.
    expect(state.transitions[c.transitionId]!.lifecycle).toBe('TERMINAL')
  })

  test('K9 fences: pre-terminal observation evidence cannot reconcile after the binding moved, but re-attestation can', () => {
    const c = contract('mission:dig', 'MISSION', [claim(worldBlocks)], [effect('DIG', 'scope:dig', worldBlocks)])
    let state = initial([c])
    state = activate(state, c)
    const issued = issue(state, c, 'DIG', 'scope:dig'); state = issued.state
    state = apply(state, { kind: 'BEGIN_EFFECT_DISPATCH', commitId: issued.commitId })
    const factEvents: KernelEvent[] = []
    state = acceptFacts(state, [{ predicateId: 'observed:dig-result', effectCommitId: issued.commitId }], undefined, factEvents)
    const factId = Object.keys(state.facts).find((id) => state.facts[id]!.effectCommitId === issued.commitId)!

    // A preemptible cancel terminalizes immediately; the registry bump makes
    // the just-recorded evidence binding-stale.
    state = apply(state, { kind: 'REQUEST_CANCEL', transitionId: c.transitionId, reason: 'cancel after evidence' })
    expect(state.effects[issued.commitId]!.status).toBe('UNKNOWN')
    reject(state, { kind: 'RECONCILE_EFFECT', commitId: issued.commitId, observation: 'OCCURRED', factIds: [factId], verifier, capability: trustedVerifier(verifier.id) }, 'UNTRUSTED_RECONCILIATION_FACT')

    // The verifier can still settle the ambiguity by re-attesting under the
    // live binding; UNKNOWN is the honest record until then.
    state = acceptFacts(state, [{ predicateId: 'observed:dig-result', effectCommitId: issued.commitId }])
    const freshFactId = Object.keys(state.facts).find((id) => state.facts[id]!.effectCommitId === issued.commitId && id !== factId)!
    state = apply(state, { kind: 'RECONCILE_EFFECT', commitId: issued.commitId, observation: 'OCCURRED', factIds: [freshFactId], verifier, capability: trustedVerifier(verifier.id) })
    expect(state.effects[issued.commitId]!.status).toBe('OBSERVED')
  })
})

describe('V4.1.2 adversarial ordering, fencing, and replay edges', () => {
  test('K10 fences: reordered and repeated effect completions are rejected at every edge', () => {
    const c = contract('mission:dig', 'MISSION', [claim(worldBlocks)], [effect('DIG', 'scope:dig', worldBlocks, 2)])
    let state = initial([c])
    state = activate(state, c)
    const first = issue(state, c, 'DIG', 'scope:dig'); state = first.state

    // Completion observed before the dispatch linearizes: not reconcilable.
    reject(state, { kind: 'RECONCILE_EFFECT', commitId: first.commitId, observation: 'UNKNOWN', factIds: [], verifier, capability: trustedVerifier(verifier.id) }, 'EFFECT_NOT_RECONCILABLE')

    // A commit linearizes once; the same commitId can never dispatch again.
    state = apply(state, { kind: 'BEGIN_EFFECT_DISPATCH', commitId: first.commitId })
    reject(state, { kind: 'BEGIN_EFFECT_DISPATCH', commitId: first.commitId }, 'EFFECT_COMMIT_NOT_ISSUED')
    state = acceptFacts(state, [{ predicateId: 'observed:dig-result', effectCommitId: first.commitId }])
    const factId = Object.keys(state.facts).find((id) => state.facts[id]!.effectCommitId === first.commitId)!
    state = apply(state, { kind: 'RECONCILE_EFFECT', commitId: first.commitId, observation: 'OCCURRED', factIds: [factId], verifier, capability: trustedVerifier(verifier.id) })
    reject(state, { kind: 'RECONCILE_EFFECT', commitId: first.commitId, observation: 'OCCURRED', factIds: [factId], verifier, capability: trustedVerifier(verifier.id) }, 'EFFECT_NOT_RECONCILABLE')

    // A revoked (quiesced, never dispatched) token is not reconcilable.
    const second = issue(state, c, 'DIG', 'scope:dig'); state = second.state
    state = apply(state, { kind: 'REQUEST_CANCEL', transitionId: c.transitionId, reason: 'quiesce second token' })
    expect(state.effects[second.commitId]!.status).toBe('REVOKED')
    reject(state, { kind: 'RECONCILE_EFFECT', commitId: second.commitId, observation: 'OCCURRED', factIds: [factId], verifier, capability: trustedVerifier(verifier.id) }, 'EFFECT_NOT_RECONCILABLE')
  })

  test('K11 fences: a NOT_OCCURRED reconciliation still consumes the irreversible dispatch budget', () => {
    const c = contract('mission:dig', 'MISSION', [claim(worldBlocks)], [effect('DIG', 'scope:dig', worldBlocks, 1)])
    let state = initial([c])
    state = activate(state, c)
    const issued = issue(state, c, 'DIG', 'scope:dig'); state = issued.state
    state = apply(state, { kind: 'BEGIN_EFFECT_DISPATCH', commitId: issued.commitId })
    state = acceptFacts(state, [{ predicateId: 'observed:dig-result', effectCommitId: issued.commitId }])
    const factId = Object.keys(state.facts).find((id) => state.facts[id]!.effectCommitId === issued.commitId)!
    state = apply(state, { kind: 'RECONCILE_EFFECT', commitId: issued.commitId, observation: 'NOT_OCCURRED', factIds: [factId], verifier, capability: trustedVerifier(verifier.id) })

    // Dispatch linearization is the irreversible act; observing that the world
    // effect did not land does not refund the permit.
    reject(state, { kind: 'ISSUE_EFFECT', transitionId: c.transitionId, effect: 'DIG', scope: 'scope:dig', ttlMs: 100 }, 'EFFECT_MAX_COUNT_EXHAUSTED')
  })

  test('K12 fences: the global observation-time regression fence rejects honest but earlier-observed snapshots', () => {
    const c = contract('mission:walk')
    let state = initial([c])
    state = advance(state, 1_000)
    state = acceptFacts(state, [{ predicateId: 'p:a' }], 900)
    // A different predicate observed earlier than the newest accepted fact is
    // rejected even though the observation itself is valid and fresh.
    reject(state, { kind: 'ACCEPT_VERIFIED_SNAPSHOT', verifier, facts: [{ predicateId: 'p:b', truth: 'true', valueHash: 'h:b' }], materialChange: true, observedAtMonoMs: 500, capability: trustedVerifier(verifier.id) }, 'OBSERVATION_TIME_REGRESSION')
    state = acceptFacts(state, [{ predicateId: 'p:b' }], 950)
    expect(Object.values(state.facts).some((f) => f.predicateId === 'p:b')).toBe(true)
  })

  test('K13 characterizes: progress reports are journaled for a transition that never ran', () => {
    const c = contract('mission:walk')
    let state = initial([c])
    state = apply(state, { kind: 'REGISTER_TRANSITION', contract: c })
    expect(state.transitions[c.transitionId]!.lifecycle).toBe('ENABLED')
    state = apply(state, { kind: 'REPORT_PROGRESS', transitionId: c.transitionId, progressRevision: 1, valueHash: 'p:1', observedAtMonoMs: state.monotonicMs, evaluator: progress })
    expect(state.transitions[c.transitionId]!.progressRevision).toBe(1)
  })

  test('K14 characterizes: witness proofs are journaled for a TERMINAL transition', () => {
    const c = contract('mission:walk', 'MISSION', [claim()], [], { witnessValidation: witnessValidator })
    let state = initial([c])
    state = apply(state, { kind: 'REGISTER_TRANSITION', contract: c })
    state = apply(state, { kind: 'ADMIT_TRANSITION', transitionId: c.transitionId })
    state = apply(state, { kind: 'ACCEPT_WITNESS_PROOF', transitionId: c.transitionId, witnessRevision: 0, witnessRefHash: 'w:0', relationId: 'r:1', validator: witnessValidator })
    state = apply(state, { kind: 'ACQUIRE_DECLARED_RESOURCES', transitionId: c.transitionId })
    state = acceptFacts(state, [{ predicateId: c.desiredPredicate }])
    state = apply(state, { kind: 'VERIFY_SUCCESS', transitionId: c.transitionId, causalCredit: 'self' })
    expect(state.transitions[c.transitionId]!.lifecycle).toBe('TERMINAL')
    state = apply(state, { kind: 'ACCEPT_WITNESS_PROOF', transitionId: c.transitionId, witnessRevision: 5, witnessRefHash: 'w:5', relationId: 'r:1', validator: witnessValidator })
    expect(state.transitions[c.transitionId]!.witnessRevision).toBe(5)
  })

  test('K15 fences: stale yield acknowledgements are rejected at every quiescing edge', () => {
    const critical = contract('mission:critical', 'MISSION', [claim(worldBlocks, 'EXCLUSIVE_WRITE', { preemptible: false, resumable: true, maxNonPreemptibleMs: 500 })])
    const terminal = contract('mission:terminal', 'MISSION', [claim(inventory, 'EXCLUSIVE_WRITE', { preemptible: false, resumable: true, maxNonPreemptibleMs: 500 })])
    const victim = contract('victim:walk', 'MISSION', [claim()])
    const requester = contract('requester:urgent', 'MISSION', [claim()], [], { urgency: 100 })
    let state = initial([critical, terminal, victim, requester])
    state = activate(state, critical)
    state = activate(state, terminal)
    state = activate(state, victim)
    state = registerAdmit(state, requester)
    state = advance(state, 100)

    reject(state, { kind: 'ACK_PAUSE_YIELD', transitionId: critical.transitionId, to: 'OBSERVING', reason: 'pause', atMonoMs: 50 }, 'STALE_YIELD_ACK')
    const plan = planPreemption(state, requester); state = plan.state
    reject(state, { kind: 'ACK_PREEMPTION_YIELD', transactionId: plan.transactionId, victimId: victim.transitionId, safeYield: true, atMonoMs: 50 }, 'STALE_YIELD_ACK')
    state = apply(state, { kind: 'REQUEST_CANCEL', transitionId: critical.transitionId, reason: 'cancel' })
    reject(state, { kind: 'ACK_CANCEL_YIELD', transitionId: critical.transitionId, atMonoMs: 50 }, 'STALE_YIELD_ACK')
    state = acceptFacts(state, [{ predicateId: terminal.desiredPredicate }])
    state = apply(state, { kind: 'VERIFY_SUCCESS', transitionId: terminal.transitionId, causalCredit: 'self' })
    expect(state.transitions[terminal.transitionId]!.pendingTerminalOutcome?.kind).toBe('SUCCESS')
    reject(state, { kind: 'ACK_TERMINAL_YIELD', transitionId: terminal.transitionId, atMonoMs: 50 }, 'STALE_YIELD_ACK')
  })

  test('K16 fences: an expired issued token cannot dispatch and does not consume the permit', () => {
    const c = contract('mission:dig', 'MISSION', [claim(worldBlocks)], [effect('DIG', 'scope:dig', worldBlocks, 1)])
    let state = initial([c])
    state = activate(state, c)
    const issued = issue(state, c, 'DIG', 'scope:dig', 100); state = issued.state
    state = advance(state, 200)
    expect(state.effects[issued.commitId]!.status).toBe('EXPIRED')
    reject(state, { kind: 'BEGIN_EFFECT_DISPATCH', commitId: issued.commitId }, 'EFFECT_COMMIT_NOT_ISSUED')
    // Usage counts linearized dispatches, not issues; the transition may issue
    // a replacement token for the never-dispatched effect.
    const second = issue(state, c, 'DIG', 'scope:dig', 100); state = second.state
    state = apply(state, { kind: 'BEGIN_EFFECT_DISPATCH', commitId: second.commitId })
    expect(state.effects[second.commitId]!.status).toBe('DISPATCHING')
  })

  test('K17 fences: replay through a mid-protocol crash reproduces the identical semantic state', () => {
    const victim = contract('victim:walk', 'MISSION', [claim()], [effect('MOVE', 'scope:v', locomotion)])
    const requester = contract('requester:urgent', 'MISSION', [claim()], [], { urgency: 100 })
    const start = initial([victim, requester])
    let state = start
    const events: KernelEvent[] = []
    state = activate(state, victim, events)
    state = registerAdmit(state, requester, events)
    const issued = issue(state, victim, 'MOVE', 'scope:v', 100, events); state = issued.state
    state = apply(state, { kind: 'BEGIN_EFFECT_DISPATCH', commitId: issued.commitId }, events)
    const plan = planPreemption(state, requester, events); state = plan.state

    const replayed = replayKernelEvents(start, JSON.parse(JSON.stringify(events)) as KernelEvent[])
    assertKernelInvariants(replayed)
    expect(kernelSemanticDigest(replayed)).toBe(kernelSemanticDigest(state))
    expect(state.effects[issued.commitId]!.status).toBe('DISPATCHING')
    expect(state.preemptions[plan.transactionId]!.status).toBe('PLANNED')

    // A trusted journal recovery produces a state the live reducer accepts;
    // the protocol continues where the journal left off: the in-flight
    // dispatch reconciles to UNKNOWN first, then the victim's yield ack lands.
    const recovered = recoverKernelFromJournal(start, JSON.parse(JSON.stringify(events)) as KernelEvent[], trustedJournalRecovery())
    const reconciled = applyKernelCommand(recovered, { kind: 'RECONCILE_EFFECT', commitId: issued.commitId, observation: 'UNKNOWN', factIds: [], verifier, capability: trustedVerifier(verifier.id) })
    expect(reconciled.ok).toBe(true)
    if (!reconciled.ok) throw new Error('unreachable')
    const continued = applyKernelCommand(reconciled.state, authorize(reconciled.state, { kind: 'ACK_PREEMPTION_YIELD', transactionId: plan.transactionId, victimId: victim.transitionId, safeYield: true, atMonoMs: reconciled.state.monotonicMs }))
    expect(continued.ok).toBe(true)
  })

  test('K18 fences: a generation change mid-READY-preemption stales the plan and suspends both parties', () => {
    const victim = contract('victim:walk', 'MISSION', [claim()])
    const requester = contract('requester:urgent', 'MISSION', [claim()], [], { urgency: 100 })
    let state = initial([victim, requester])
    state = activate(state, victim)
    state = registerAdmit(state, requester)
    const plan = planPreemption(state, requester); state = plan.state
    state = apply(state, { kind: 'ACK_PREEMPTION_YIELD', transactionId: plan.transactionId, victimId: victim.transitionId, safeYield: true, atMonoMs: state.monotonicMs })

    state = apply(state, { kind: 'CHANGE_GENERATION', generationId: 'gen-b', capability: trustedWorldAdapter('runtime') })
    expect(state.preemptions[plan.transactionId]!.status).toBe('STALE')
    expect(state.transitions[victim.transitionId]!.lifecycle).toBe('SUSPENDED')
    expect(state.transitions[requester.transitionId]!.lifecycle).toBe('SUSPENDED')
    reject(state, { kind: 'COMMIT_PREEMPTION', transactionId: plan.transactionId }, 'STALE_PREEMPTION')

    // Both parties rebind under the new generation: same contract, fresh
    // mechanical authority, fresh lease identities.
    state = apply(state, { kind: 'RESUME_TRANSITION', transitionId: victim.transitionId })
    state = apply(state, { kind: 'ACQUIRE_DECLARED_RESOURCES', transitionId: victim.transitionId })
    expect(state.transitions[victim.transitionId]!.lifecycle).toBe('ACTIVE')
    expect(Object.values(state.leases).every((l) => l.generationId === 'gen-b')).toBe(true)
    state = apply(state, { kind: 'RESUME_TRANSITION', transitionId: requester.transitionId })
    // The preempt plan did not survive the rebind; the conflict is live again.
    reject(state, { kind: 'ACQUIRE_DECLARED_RESOURCES', transitionId: requester.transitionId }, 'RESOURCE_CONFLICT')
  })

  test('K19 fences: a superseded-then-restored mission predicate cannot resurrect the terminalized transition', () => {
    const c = contract('mission:walk')
    const other = contract('mission:other')
    let state = initial([c, other])
    state = activate(state, c)
    state = apply(state, { kind: 'UPDATE_MISSION', predicates: [other.desiredPredicate], authority: missionAuthority })
    expect(state.transitions[c.transitionId]!.lifecycle).toBe('TERMINAL')
    expect(state.transitions[c.transitionId]!.terminalOutcome?.kind).toBe('MISSION_SUPERSEDED')

    state = apply(state, { kind: 'UPDATE_MISSION', predicates: [c.desiredPredicate, other.desiredPredicate], authority: missionAuthority })
    expect(state.transitions[c.transitionId]!.lifecycle).toBe('TERMINAL')
    reject(state, { kind: 'ADMIT_TRANSITION', transitionId: c.transitionId }, 'ILLEGAL_LIFECYCLE_EDGE')
    reject(state, { kind: 'RESUME_TRANSITION', transitionId: c.transitionId }, 'ILLEGAL_LIFECYCLE_EDGE')
    reject(state, { kind: 'REGISTER_TRANSITION', contract: c }, 'DUPLICATE_TRANSITION_ID')
  })
})
