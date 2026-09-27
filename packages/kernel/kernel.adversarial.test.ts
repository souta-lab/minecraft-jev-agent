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
    case 'ADMIT_TRANSITION': case 'ACQUIRE_DECLARED_RESOURCES': case 'PAUSE_ACTIVE': case 'RESUME_TRANSITION': case 'AGE_RUNNABLE': case 'START_PREEMPTION': case 'COMMIT_PREEMPTION': case 'CANCEL_PREEMPTION': case 'REQUEST_CANCEL':
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
  test('K3 fences: a preemptible victim that never yields is force-yielded by the contract deadline, not wedged forever', () => {
    const victim = contract('victim:walk', 'MISSION', [claim()], [effect('MOVE', 'scope:victim:walk')])
    const requester = contract('requester:urgent', 'MISSION', [claim()], [], { urgency: 100 })
    let state = initial([victim, requester])
    state = activate(state, victim)
    state = registerAdmit(state, requester)
    const plan = planPreemption(state, requester); state = plan.state

    // Inside the bounded yield window the unacknowledged victim still wedges
    // the commit and stays effect-eligible - that window is the safe-yield
    // protocol's concession, not a defect.
    reject(state, { kind: 'COMMIT_PREEMPTION', transactionId: plan.transactionId }, 'PREEMPTION_NOT_READY')
    reject(state, { kind: 'ACQUIRE_DECLARED_RESOURCES', transitionId: requester.transitionId }, 'RESOURCE_CONFLICT')
    expect(state.transitions[victim.transitionId]!.lifecycle).toBe('ACTIVE')
    const issued = issue(state, victim, 'MOVE', 'scope:victim:walk'); state = issued.state

    // Past hardYieldDeadlineMonoMs the claim's own bound authorizes the forced
    // commit: the victim is suspended (resumable work preserved) inside the
    // same atomic transaction that grants the requester.
    state = advance(state, 1_000)
    state = apply(state, { kind: 'COMMIT_PREEMPTION', transactionId: plan.transactionId })
    expect(state.transitions[victim.transitionId]!.lifecycle).toBe('SUSPENDED')
    expect(state.transitions[requester.transitionId]!.lifecycle).toBe('ACTIVE')
    expect(state.preemptions[plan.transactionId]!.status).toBe('COMMITTED')
  })

  test('K4 fences: the scheduler cannot pause a yield-acknowledged victim out of a READY transaction', () => {
    const victim = contract('victim:walk', 'MISSION', [claim()])
    const requester = contract('requester:urgent', 'MISSION', [claim()], [], { urgency: 100 })
    let state = initial([victim, requester])
    state = activate(state, victim)
    state = registerAdmit(state, requester)
    const plan = planPreemption(state, requester); state = plan.state
    state = apply(state, { kind: 'ACK_PREEMPTION_YIELD', transactionId: plan.transactionId, victimId: victim.transitionId, safeYield: true, atMonoMs: state.monotonicMs })
    expect(state.preemptions[plan.transactionId]!.status).toBe('READY')

    // PAUSE_ACTIVE now gates on transaction participation: the victim's lease
    // set belongs to the READY transaction until commit or cancel.
    reject(state, { kind: 'PAUSE_ACTIVE', transitionId: victim.transitionId, to: 'OBSERVING', reason: 'scheduler pause' }, 'PREEMPTION_TRANSACTION_IN_FLIGHT')
    expect(state.transitions[victim.transitionId]!.lifecycle).toBe('ACTIVE')
    state = apply(state, { kind: 'COMMIT_PREEMPTION', transactionId: plan.transactionId })
    expect(state.transitions[victim.transitionId]!.lifecycle).toBe('SUSPENDED')
    expect(state.transitions[requester.transitionId]!.lifecycle).toBe('ACTIVE')
  })

  test('K4b fences: a non-preemptible victim cannot veto an acknowledged preemption by yielding to pause', () => {
    const victim = contract('victim:critical', 'MISSION', [criticalClaim()])
    const requester = contract('requester:urgent', 'MISSION', [claim()], [], { urgency: 100 })
    let state = initial([victim, requester])
    state = activate(state, victim)
    state = registerAdmit(state, requester)
    const plan = planPreemption(state, requester); state = plan.state
    state = apply(state, { kind: 'ACK_PREEMPTION_YIELD', transactionId: plan.transactionId, victimId: victim.transitionId, safeYield: true, atMonoMs: state.monotonicMs })
    expect(state.preemptions[plan.transactionId]!.status).toBe('READY')

    // ACK_PAUSE_YIELD carries the same gate: the controller cannot leak the
    // critical lease outside the atomic commit.
    reject(state, { kind: 'ACK_PAUSE_YIELD', transitionId: victim.transitionId, to: 'OBSERVING', reason: 'victim pause', atMonoMs: state.monotonicMs }, 'PREEMPTION_TRANSACTION_IN_FLIGHT')
    expect(state.transitions[victim.transitionId]!.lifecycle).toBe('ACTIVE')
    expect(Object.keys(state.leases)).toHaveLength(1)
    state = apply(state, { kind: 'COMMIT_PREEMPTION', transactionId: plan.transactionId })
    expect(state.transitions[victim.transitionId]!.lifecycle).toBe('SUSPENDED')
    expect(state.transitions[requester.transitionId]!.lifecycle).toBe('ACTIVE')
  })

  test('K5 fences: a victim cannot pause mid-plan, and CANCEL_PREEMPTION resolves the plan explicitly', () => {
    const victim = contract('victim:walk', 'MISSION', [claim()])
    const requester = contract('requester:urgent', 'MISSION', [claim()], [], { urgency: 100 })
    let state = initial([victim, requester])
    state = activate(state, victim)
    state = registerAdmit(state, requester)
    const plan = planPreemption(state, requester); state = plan.state

    // A merely-planned victim's lease set is transaction-owned: pausing it
    // would orphan the plan, so the pause is refused outright.
    reject(state, { kind: 'PAUSE_ACTIVE', transitionId: victim.transitionId, to: 'OBSERVING', reason: 'unrelated pause' }, 'PREEMPTION_TRANSACTION_IN_FLIGHT')
    // The explicit resolution path is CANCEL_PREEMPTION - after it the victim
    // can pause normally and the record is durable.
    state = apply(state, { kind: 'CANCEL_PREEMPTION', transactionId: plan.transactionId, reason: 'scheduler replan' })
    state = apply(state, { kind: 'PAUSE_ACTIVE', transitionId: victim.transitionId, to: 'OBSERVING', reason: 'unrelated pause' })
    expect(state.transitions[victim.transitionId]!.lifecycle).toBe('OBSERVING')
    expect(state.preemptions[plan.transactionId]!.status).toBe('CANCELED')
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

import { createHash } from 'node:crypto'

describe('V4.1.2 adversarial command-validation and audit-integrity edges', () => {
  test('K20 fences: pause commands cannot inject an arbitrary lifecycle', () => {
    const c = contract('mission:walk', 'MISSION', [claim()])
    let state = initial([c])
    state = activate(state, c)
    // Before the fix, lifecycle: command.to was written verbatim: to:'TERMINAL'
    // produced a TERMINAL transition with terminalOutcome null (falsified journal:
    // the emitted event was TRANSITION_OBSERVING) and to:'GARBAGE' produced a
    // zombie unreachable by most commands.
    reject(state, { kind: 'PAUSE_ACTIVE', transitionId: c.transitionId, to: 'TERMINAL', reason: 'inject' }, 'INVALID_PAUSE_TARGET')
    reject(state, { kind: 'PAUSE_ACTIVE', transitionId: c.transitionId, to: 'GARBAGE', reason: 'inject' }, 'INVALID_PAUSE_TARGET')
    reject(state, { kind: 'PAUSE_ACTIVE', transitionId: c.transitionId, to: 'SUSPENDED', reason: 'inject' }, 'INVALID_PAUSE_TARGET')
    reject(state, { kind: 'ACK_PAUSE_YIELD', transitionId: c.transitionId, to: 'TERMINAL', reason: 'inject', atMonoMs: state.monotonicMs }, 'INVALID_PAUSE_TARGET')
    state = apply(state, { kind: 'PAUSE_ACTIVE', transitionId: c.transitionId, to: 'OBSERVING', reason: 'legit' })
    expect(state.transitions[c.transitionId]!.lifecycle).toBe('OBSERVING')
  })

  test('K21 fences: malformed commands fail closed at the authority boundary instead of throwing', () => {
    const c = contract('mission:walk', 'MISSION', [claim()], [], { witnessValidation: witnessValidator })
    let state = initial([c])
    state = registerAdmit(state, c)

    const malformed = (command: LooseCommand): void => {
      const r = applyKernelCommand(state, authorize(state, command))
      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.reason).toMatch(/^MALFORMED_KERNEL_COMMAND:/)
      expect(r.state).toBe(state)
      expect(r.events).toEqual([])
    }
    // assertId/assertFiniteNonNegative inside applyInternal threw raw Errors
    // through the sole authority path; non-iterable fields threw TypeErrors.
    malformed({ kind: 'ACCEPT_WITNESS_PROOF', transitionId: c.transitionId, witnessRevision: 0, witnessRefHash: '', relationId: 'r:1', validator: witnessValidator })
    malformed({ kind: 'ACCEPT_VERIFIED_SNAPSHOT', verifier, materialChange: true, observedAtMonoMs: state.monotonicMs, facts: 'not-an-array', capability: trustedVerifier(verifier.id) })
    malformed({ kind: 'ACCEPT_VERIFIED_SNAPSHOT', verifier: null, materialChange: true, observedAtMonoMs: state.monotonicMs, facts: [], capability: trustedVerifier('x') })

    state = apply(state, { kind: 'ACCEPT_WITNESS_PROOF', transitionId: c.transitionId, witnessRevision: 0, witnessRefHash: 'w:0', relationId: 'r:1', validator: witnessValidator })
    state = apply(state, { kind: 'ACQUIRE_DECLARED_RESOURCES', transitionId: c.transitionId })
    malformed({ kind: 'DEBIT_USAGE', actorTransitionId: c.transitionId, targetTransitionId: c.transitionId, resource: { key: '', amount: 1 } })
    malformed({ kind: 'REPORT_PROGRESS', transitionId: c.transitionId, progressRevision: 1, valueHash: '', observedAtMonoMs: state.monotonicMs, evaluator: progress })
  })

  test('K22 fences: a command failure returns the caller state even when preprocess mutated internally', () => {
    const c = contract('mission:doomed', 'MISSION', [claim()], [], { budget: { maxActiveMs: 1_000, deadlineAtMonoMs: 5, maxMechanicalSteps: 10, resources: {}, risk: {} } })
    let state = initial([c])
    state = advance(state, 10)
    state = apply(state, { kind: 'REGISTER_TRANSITION', contract: c })
    // preprocess terminalizes the deadline-expired ENABLED transition inside
    // applyInternal; before the fix the failing command returned that mutated
    // (unmarked, unusable) state instead of the caller-visible input.
    const input = state
    expect(input.transitions[c.transitionId]!.lifecycle).toBe('ENABLED')
    const r = applyKernelCommand(input, authorize(input, { kind: 'ADMIT_TRANSITION', transitionId: c.transitionId }))
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.reason).toBe('ILLEGAL_LIFECYCLE_EDGE')
    expect(r.state).toBe(input)
    // The returned state is still trusted: the caller can keep operating on it.
    const r2 = applyKernelCommand(r.state, authorize(r.state, { kind: 'ADMIT_TRANSITION', transitionId: c.transitionId }))
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect(r2.reason).toBe('ILLEGAL_LIFECYCLE_EDGE')
  })

  test('K23 fences: an APPEND lease on a narrower resource does not authorize writes to a broader store', () => {
    const store = resourceId('memory', ['x'])
    const narrower = resourceId('memory', ['x', 'y'])
    const narrowClaim = claim(narrower, 'APPEND')
    const c = contract('mission:writer', 'MISSION', [narrowClaim])
    const rootClaim = claim(resourceId('memory'), 'APPEND')
    const c2 = contract('mission:writer2', 'MISSION', [rootClaim])
    let state = createKernelState({ world, generationId: 'gen-a', missionPredicates: [c.desiredPredicate, c2.desiredPredicate], verifierRegistry: [verifier], progressRegistry: [progress], contractCompilerRegistry: [compiler], missionAuthority, appendResources: [store], minResidencyMs: 250, preemptibleYieldBudgetMs: 50 })
    state = activate(state, c)
    // resourcesOverlap(memory/x/y, memory/x) is true (prefix match either
    // direction), so the old symmetric check authorized the write; the lease
    // must instead subsume the targeted store.
    reject(state, { kind: 'APPEND_RECORD', transitionId: c.transitionId, resource: store, operationId: 'op:1', payloadHash: 'h:1' }, 'APPEND_LEASE_REQUIRED')

    // Positive control: a lease on the parent resource covers the child store.
    state = registerAdmit(state, c2)
    state = apply(state, { kind: 'ACQUIRE_DECLARED_RESOURCES', transitionId: c2.transitionId })
    state = apply(state, { kind: 'APPEND_RECORD', transitionId: c2.transitionId, resource: store, operationId: 'op:2', payloadHash: 'h:2' })
    expect(state.appendStores['memory/x']!.records).toHaveLength(1)
  })

  test('K24 fences: journal replay re-validates full contract semantics, not just hash self-consistency', () => {
    const c = contract('mission:walk')
    const start = initial([c])
    const events: KernelEvent[] = []
    apply(start, { kind: 'REGISTER_TRANSITION', contract: c }, events)

    // Forge a contract that is hash-self-consistent but fails constructor
    // semantics: desiredPredicate removed from ensures, hash recomputed.
    const forged = JSON.parse(JSON.stringify(c)) as Record<string, unknown>
    forged['desiredPredicate'] = 'goal:evil'
    const { contractHash: _ignored, ...semantic } = forged
    const stableLocal = (v: unknown): unknown =>
      Array.isArray(v) ? v.map(stableLocal)
        : v !== null && typeof v === 'object' ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, stableLocal(x)]))
          : v
    forged['contractHash'] = createHash('sha256').update(JSON.stringify(stableLocal(semantic))).digest('hex')
    const tamperedEvents = JSON.parse(JSON.stringify(events)) as KernelEvent[]
    const replayCmd = tamperedEvents[0]!.replay.command as unknown as Record<string, unknown>
    replayCmd['contract'] = forged

    // Before the fix, replay only required canonicalContractHashValid: the
    // forged contract registered and entered recovered live state.
    expect(() => replayKernelEvents(start, tamperedEvents)).toThrow('NON_CANONICAL_CONTRACT')
    // The unforged journal still replays.
    expect(kernelSemanticDigest(replayKernelEvents(start, events))).toBeDefined()
  })

  test('K25 fences: a committed preemption record survives participant terminalization as COMMITTED', () => {
    const victim = contract('victim:walk', 'MISSION', [claim()])
    const requester = contract('requester:urgent', 'MISSION', [claim()], [], { urgency: 100 })
    let state = initial([victim, requester])
    state = activate(state, victim)
    state = registerAdmit(state, requester)
    const plan = planPreemption(state, requester); state = plan.state
    state = apply(state, { kind: 'ACK_PREEMPTION_YIELD', transactionId: plan.transactionId, victimId: victim.transitionId, safeYield: true, atMonoMs: state.monotonicMs })
    state = apply(state, { kind: 'COMMIT_PREEMPTION', transactionId: plan.transactionId })
    expect(state.preemptions[plan.transactionId]!.status).toBe('COMMITTED')

    // The requester then terminalizes; cleanupPreemptions previously rewrote
    // the COMMITTED audit record to CANCELED, falsifying durable history.
    state = apply(state, { kind: 'REQUEST_CANCEL', transitionId: requester.transitionId, reason: 'requester done' })
    expect(state.transitions[requester.transitionId]!.lifecycle).toBe('TERMINAL')
    expect(state.preemptions[plan.transactionId]!.status).toBe('COMMITTED')
  })

  test('K26 fences: observation and causal-credit fields are validated against their unions', () => {
    const c = contract('mission:dig', 'MISSION', [claim(worldBlocks)], [effect('DIG', 'scope:dig', worldBlocks)])
    let state = initial([c])
    state = activate(state, c)
    const issued = issue(state, c, 'DIG', 'scope:dig'); state = issued.state
    state = apply(state, { kind: 'BEGIN_EFFECT_DISPATCH', commitId: issued.commitId })
    reject(state, { kind: 'RECONCILE_EFFECT', commitId: issued.commitId, observation: 'GARBAGE', factIds: [], verifier, capability: trustedVerifier(verifier.id) }, 'INVALID_OBSERVATION')
    state = acceptFacts(state, [{ predicateId: c.desiredPredicate }])
    reject(state, { kind: 'VERIFY_SUCCESS', transitionId: c.transitionId, causalCredit: 'GARBAGE' }, 'INVALID_CAUSAL_CREDIT')
    state = apply(state, { kind: 'VERIFY_SUCCESS', transitionId: c.transitionId, causalCredit: 'self' })
    expect(state.transitions[c.transitionId]!.lifecycle).toBe('TERMINAL')
  })
})

describe('V4.1.2 adversarial semantic characterizations (pinned for architecture review)', () => {
  test('K27 characterizes: a pending terminal sticks - a later deadline cannot override it, and ensures are never revalidated', () => {
    const c = contract('mission:critical', 'MISSION', [criticalClaim()])
    let state = initial([c])
    state = activate(state, c)
    state = acceptFacts(state, [{ predicateId: c.desiredPredicate }])
    state = apply(state, { kind: 'VERIFY_SUCCESS', transitionId: c.transitionId, causalCredit: 'self' })
    expect(state.transitions[c.transitionId]!.pendingTerminalOutcome?.kind).toBe('SUCCESS')

    // The contract deadline passes while the transition awaits safe yield:
    // requestTerminal early-returns on the existing pending outcome.
    state = advance(state, 20_000)
    // An intervening ensures-false fact does not reopen the pending verify.
    state = acceptFacts(state, [{ predicateId: c.desiredPredicate, truth: 'false' }], state.monotonicMs)
    state = apply(state, { kind: 'ACK_TERMINAL_YIELD', transitionId: c.transitionId, atMonoMs: state.monotonicMs })
    expect(state.transitions[c.transitionId]!.terminalOutcome?.kind).toBe('SUCCESS')
  })

  test('K28 characterizes: cancel + deadline expiry arm two terminal paths whose outcome is decided by ack order', () => {
    const c = contract('mission:critical', 'MISSION', [criticalClaim()])
    let state = initial([c])
    state = activate(state, c)
    state = apply(state, { kind: 'REQUEST_CANCEL', transitionId: c.transitionId, reason: 'operator cancel' })
    expect(state.transitions[c.transitionId]!.cancelRequested).toBe(true)

    // The deadline then expires: requestTerminal checks pendingTerminalOutcome
    // (null) but not cancelRequested, so a second quiescing path arms.
    state = advance(state, 20_000)
    const quiescing = state.transitions[c.transitionId]!
    expect(quiescing.cancelRequested).toBe(true)
    expect(quiescing.pendingTerminalOutcome?.kind).toBe('DEADLINE_EXPIRED')

    const terminalFirst = applyKernelCommand(state, authorize(state, { kind: 'ACK_TERMINAL_YIELD', transitionId: c.transitionId, atMonoMs: state.monotonicMs }))
    expect(terminalFirst.ok).toBe(true)
    if (terminalFirst.ok) expect(terminalFirst.state.transitions[c.transitionId]!.terminalOutcome?.kind).toBe('DEADLINE_EXPIRED')
    const cancelFirst = applyKernelCommand(state, authorize(state, { kind: 'ACK_CANCEL_YIELD', transitionId: c.transitionId, atMonoMs: state.monotonicMs }))
    expect(cancelFirst.ok).toBe(true)
    if (cancelFirst.ok) expect(cancelFirst.state.transitions[c.transitionId]!.terminalOutcome?.kind).toBe('CANCELED')
    // Same quiescing state, two legal but different terminal outcomes.
  })

  test('K29 characterizes: a DISPATCHING effect never expires and wedges the owner until reconcile/cancel/generation resolves it', () => {
    const bigBudget = { maxActiveMs: 2_000_000, deadlineAtMonoMs: null, maxMechanicalSteps: 10_000_000, resources: {}, risk: {} }
    const victim = contract('victim:dig', 'MISSION', [claim(worldBlocks)], [effect('DIG', 'scope:dig', worldBlocks)], { budget: bigBudget })
    const requester = contract('requester:urgent', 'MISSION', [claim(worldBlocks)], [], { urgency: 100, budget: bigBudget })
    let state = initial([victim, requester])
    state = activate(state, victim)
    state = registerAdmit(state, requester)
    const issued = issue(state, victim, 'DIG', 'scope:dig'); state = issued.state
    state = apply(state, { kind: 'BEGIN_EFFECT_DISPATCH', commitId: issued.commitId })

    state = advance(state, 1_000_000)
    expect(state.effects[issued.commitId]!.status).toBe('DISPATCHING')
    reject(state, { kind: 'PAUSE_ACTIVE', transitionId: victim.transitionId, to: 'OBSERVING', reason: 'pause' }, 'EFFECT_DISPATCH_IN_FLIGHT')
    const plan = planPreemption(state, requester); state = plan.state
    reject(state, { kind: 'ACK_PREEMPTION_YIELD', transactionId: plan.transactionId, victimId: victim.transitionId, safeYield: true, atMonoMs: state.monotonicMs }, 'EFFECT_DISPATCH_IN_FLIGHT')
    // Only explicit verifier reconciliation (UNKNOWN), cancel, or a
    // generation/world change unblocks the wedge.
    state = apply(state, { kind: 'RECONCILE_EFFECT', commitId: issued.commitId, observation: 'UNKNOWN', factIds: [], verifier, capability: trustedVerifier(verifier.id) })
    state = apply(state, { kind: 'ACK_PREEMPTION_YIELD', transactionId: plan.transactionId, victimId: victim.transitionId, safeYield: true, atMonoMs: state.monotonicMs })
    expect(state.preemptions[plan.transactionId]!.status).toBe('READY')
  })

  test('K30 characterizes: reusing a generation id re-arms controller capabilities minted under the earlier era', () => {
    const c = contract('mission:walk', 'MISSION', [claim()], [effect('MOVE', 'scope:v')])
    let state = initial([c])
    state = activate(state, c)
    const eraOneCap = trustedController(c.transitionId, c.contractHash, 'gen-a')

    state = apply(state, { kind: 'CHANGE_GENERATION', generationId: 'gen-b', capability: trustedWorldAdapter('runtime') })
    state = apply(state, { kind: 'RESUME_TRANSITION', transitionId: c.transitionId })
    state = apply(state, { kind: 'ACQUIRE_DECLARED_RESOURCES', transitionId: c.transitionId })
    // Under gen-b the era-one capability is stale: fenced.
    const staleAttempt = applyKernelCommand(state, { kind: 'ISSUE_EFFECT', transitionId: c.transitionId, effect: 'MOVE', scope: 'scope:v', ttlMs: 100, capability: eraOneCap })
    expect(staleAttempt.ok).toBe(false)
    if (!staleAttempt.ok) expect(staleAttempt.reason).toBe('UNTRUSTED_CONTROLLER')

    state = apply(state, { kind: 'CHANGE_GENERATION', generationId: 'gen-a', capability: trustedWorldAdapter('runtime') })
    state = apply(state, { kind: 'RESUME_TRANSITION', transitionId: c.transitionId })
    state = apply(state, { kind: 'ACQUIRE_DECLARED_RESOURCES', transitionId: c.transitionId })
    // Capabilities bind to the generationId string; cycling back re-arms the
    // era-one capability even though it was minted before the gen-b era.
    const rearmed = applyKernelCommand(state, { kind: 'ISSUE_EFFECT', transitionId: c.transitionId, effect: 'MOVE', scope: 'scope:v', ttlMs: 100, capability: eraOneCap })
    expect(rearmed.ok).toBe(true)
  })

  test('K31 characterizes: resumability and yield deadlines are computed from conflicting leases only', () => {
    const victim = contract('victim:dig', 'MISSION', [claim(), claim(worldBlocks, 'EXCLUSIVE_WRITE', { resumable: false })])
    const requester = contract('requester:urgent', 'MISSION', [claim()], [], { urgency: 100 })
    let state = initial([victim, requester])
    state = activate(state, victim)
    state = registerAdmit(state, requester)
    const plan = planPreemption(state, requester); state = plan.state
    const victimPlan = state.preemptions[plan.transactionId]!.victims.find((v) => v.transitionId === victim.transitionId)!
    // The victim also declared a resumable:false claim on worldBlocks, which
    // the requester does not conflict with: the plan's resumable flag only
    // inspects conflicting leases, so the victim is marked resumable and will
    // be SUSPENDED with its non-resumable claim silently released.
    expect(victimPlan.resumable).toBe(true)
    state = apply(state, { kind: 'ACK_PREEMPTION_YIELD', transactionId: plan.transactionId, victimId: victim.transitionId, safeYield: true, atMonoMs: state.monotonicMs })
    state = apply(state, { kind: 'COMMIT_PREEMPTION', transactionId: plan.transactionId })
    expect(state.transitions[victim.transitionId]!.lifecycle).toBe('SUSPENDED')
    expect(Object.values(state.leases).filter((l) => l.owner === victim.transitionId)).toHaveLength(0)
  })

  test('K32 characterizes: VERIFY_SUCCESS can terminalize a transition that never executed', () => {
    const c = contract('mission:preordained')
    let state = initial([c])
    state = apply(state, { kind: 'REGISTER_TRANSITION', contract: c })
    expect(state.transitions[c.transitionId]!.lifecycle).toBe('ENABLED')
    state = acceptFacts(state, [{ predicateId: c.desiredPredicate }])
    state = apply(state, { kind: 'VERIFY_SUCCESS', transitionId: c.transitionId, causalCredit: 'external' })
    const t = state.transitions[c.transitionId]!
    expect(t.lifecycle).toBe('TERMINAL')
    expect(t.terminalOutcome?.kind).toBe('SUCCESS')
    // The ensures-already-true terminal is journaled as SUCCESS with no
    // activation, actuation, or progress - the verifier's attestation alone
    // is the authority.
  })

  test('K33 characterizes: an unbounded ttlMs issues a token that can never expire', () => {
    const c = contract('mission:dig', 'MISSION', [claim(worldBlocks)], [effect('DIG', 'scope:dig', worldBlocks, 2)], { budget: { maxActiveMs: 2_000_000_000, deadlineAtMonoMs: null, maxMechanicalSteps: 10_000_000_000, resources: {}, risk: {} } })
    let state = initial([c])
    state = activate(state, c)
    const issued = issue(state, c, 'DIG', 'scope:dig', Number.MAX_VALUE); state = issued.state
    state = advance(state, 1_000_000_000)
    expect(state.effects[issued.commitId]!.status).toBe('ISSUED')
    // The token is effectively permanent while the binding holds; ttl only
    // bounds the dispatch window and there is no cap on it.
  })
})

describe('V4.1.2 preemption transaction integrity (K3/K4/K5 fixes)', () => {
  test('K34 fences: a deadline-expired victim can no longer wedge the preemptor - the commit forces the yield', () => {
    const victim = contract('victim:walk', 'MISSION', [claim()], [effect('MOVE', 'scope:victim:walk')])
    const requester = contract('requester:urgent', 'MISSION', [claim()], [], { urgency: 100 })
    let state = initial([victim, requester])
    state = activate(state, victim)
    state = registerAdmit(state, requester)
    const plan = planPreemption(state, requester); state = plan.state

    // Inside the contract-bounded yield window the unacknowledged victim still
    // blocks the commit.
    reject(state, { kind: 'COMMIT_PREEMPTION', transactionId: plan.transactionId }, 'PREEMPTION_NOT_READY')

    // Past hardYieldDeadlineMonoMs the contract itself bound the critical
    // section: the commit resolves the unresponsive victim inside the same
    // atomic transaction and marks the forced yield in the journal.
    state = advance(state, 1_000)
    const evts: KernelEvent[] = []
    state = apply(state, { kind: 'COMMIT_PREEMPTION', transactionId: plan.transactionId }, evts)
    expect(state.transitions[victim.transitionId]!.lifecycle).toBe('SUSPENDED')
    expect(state.transitions[victim.transitionId]!.suspendReason).toBe(`PREEMPTED_BY:${requester.transitionId}`)
    expect(state.transitions[requester.transitionId]!.lifecycle).toBe('ACTIVE')
    expect(state.preemptions[plan.transactionId]!.status).toBe('COMMITTED')
    const commit = evts.find((e) => e.kind === 'PREEMPTION_COMMITTED')!
    expect(commit.data.forcedVictims).toEqual([victim.transitionId])
  })

  test('K34b fences: a forced yield marks an in-flight irreversible dispatch UNKNOWN like any other quiesce', () => {
    const victim = contract('victim:dig', 'MISSION', [claim(worldBlocks)], [effect('DIG', 'scope:dig', worldBlocks)])
    const requester = contract('requester:urgent', 'MISSION', [claim(worldBlocks)], [], { urgency: 100 })
    let state = initial([victim, requester])
    state = activate(state, victim)
    state = registerAdmit(state, requester)
    const issued = issue(state, victim, 'DIG', 'scope:dig'); state = issued.state
    state = apply(state, { kind: 'BEGIN_EFFECT_DISPATCH', commitId: issued.commitId })
    const plan = planPreemption(state, requester); state = plan.state
    // An in-flight dispatch cannot safe-yield, so the victim cannot ack: the
    // deadline expiring is what un-wedges this, not an ack that can never come.
    reject(state, { kind: 'ACK_PREEMPTION_YIELD', transactionId: plan.transactionId, victimId: victim.transitionId, safeYield: true, atMonoMs: state.monotonicMs }, 'EFFECT_DISPATCH_IN_FLIGHT')
    state = advance(state, 1_000)
    state = apply(state, { kind: 'COMMIT_PREEMPTION', transactionId: plan.transactionId })
    expect(state.transitions[victim.transitionId]!.lifecycle).toBe('SUSPENDED')
    expect(state.effects[issued.commitId]!.status).toBe('UNKNOWN')
    expect(state.transitions[requester.transitionId]!.lifecycle).toBe('ACTIVE')
  })

  test('K35 fences: a preemption participant cannot pause out of a live transaction', () => {
    const victim = contract('victim:walk', 'MISSION', [claim()])
    const requester = contract('requester:urgent', 'MISSION', [claim()], [], { urgency: 100 })
    let state = initial([victim, requester])
    state = activate(state, victim)
    state = registerAdmit(state, requester)
    const plan = planPreemption(state, requester); state = plan.state

    // Even a merely-planned victim's lease set is owned by the transaction:
    // pausing would diverge it and orphan the plan (old K5).
    reject(state, { kind: 'PAUSE_ACTIVE', transitionId: victim.transitionId, to: 'OBSERVING', reason: 'unrelated pause' }, 'PREEMPTION_TRANSACTION_IN_FLIGHT')
    reject(state, { kind: 'ACK_PAUSE_YIELD', transitionId: victim.transitionId, to: 'OBSERVING', reason: 'victim pause', atMonoMs: state.monotonicMs }, 'PREEMPTION_TRANSACTION_IN_FLIGHT')

    // The acked victim is likewise locked until commit/cancel (old K4/K4b).
    state = apply(state, { kind: 'ACK_PREEMPTION_YIELD', transactionId: plan.transactionId, victimId: victim.transitionId, safeYield: true, atMonoMs: state.monotonicMs })
    expect(state.preemptions[plan.transactionId]!.status).toBe('READY')
    reject(state, { kind: 'PAUSE_ACTIVE', transitionId: victim.transitionId, to: 'OBSERVING', reason: 'scheduler pause' }, 'PREEMPTION_TRANSACTION_IN_FLIGHT')
    reject(state, { kind: 'ACK_PAUSE_YIELD', transitionId: victim.transitionId, to: 'OBSERVING', reason: 'victim pause', atMonoMs: state.monotonicMs }, 'PREEMPTION_TRANSACTION_IN_FLIGHT')
    expect(state.transitions[victim.transitionId]!.lifecycle).toBe('ACTIVE')
    expect(Object.keys(state.leases)).toHaveLength(1)
  })

  test('K36 fences: CANCEL_PREEMPTION resolves live and stale transactions explicitly', () => {
    const victim = contract('victim:walk', 'MISSION', [claim()], [effect('MOVE', 'scope:victim:walk')])
    const requester = contract('requester:urgent', 'MISSION', [claim()], [], { urgency: 100 })
    let state = initial([victim, requester])
    state = activate(state, victim)
    state = registerAdmit(state, requester)
    const plan = planPreemption(state, requester); state = plan.state
    state = apply(state, { kind: 'ACK_PREEMPTION_YIELD', transactionId: plan.transactionId, victimId: victim.transitionId, safeYield: true, atMonoMs: state.monotonicMs })

    const evts: KernelEvent[] = []
    state = apply(state, { kind: 'CANCEL_PREEMPTION', transactionId: plan.transactionId, reason: 'requester abandoned' }, evts)
    expect(state.preemptions[plan.transactionId]!.status).toBe('CANCELED')
    expect(evts.some((e) => e.kind === 'PREEMPTION_CANCELED' && e.data.reason === 'requester abandoned')).toBe(true)
    // The released victim is effect-eligible again; the transaction record is
    // durable and cannot be re-resolved.
    reject(state, { kind: 'COMMIT_PREEMPTION', transactionId: plan.transactionId }, 'STALE_PREEMPTION')
    reject(state, { kind: 'CANCEL_PREEMPTION', transactionId: plan.transactionId, reason: 'again' }, 'PREEMPTION_ALREADY_RESOLVED')
    const issued = issue(state, victim, 'MOVE', 'scope:victim:walk'); state = issued.state
    expect(state.effects[issued.commitId]!.status).toBe('ISSUED')
    // After cancel, K35's pause gate no longer applies.
    state = apply(state, { kind: 'PAUSE_ACTIVE', transitionId: victim.transitionId, to: 'OBSERVING', reason: 'scheduler pause' })
    expect(state.transitions[victim.transitionId]!.lifecycle).toBe('OBSERVING')
  })

  test('K36b fences: a generation change resolves live transactions to STALE and cancel refuses to rewrite that durable verdict', () => {
    const victim = contract('victim:walk', 'MISSION', [claim()])
    const requester = contract('requester:urgent', 'MISSION', [claim()], [], { urgency: 100 })
    let state = initial([victim, requester])
    state = activate(state, victim)
    state = registerAdmit(state, requester)
    const plan = planPreemption(state, requester); state = plan.state
    state = apply(state, { kind: 'CHANGE_GENERATION', generationId: 'gen-b', capability: trustedWorldAdapter('runtime') })
    // The generation fence resolves the transaction record itself: STALE is a
    // terminal tx status - neither commit nor cancel may rewrite it.
    expect(state.preemptions[plan.transactionId]!.status).toBe('STALE')
    reject(state, { kind: 'COMMIT_PREEMPTION', transactionId: plan.transactionId }, 'STALE_PREEMPTION')
    reject(state, { kind: 'CANCEL_PREEMPTION', transactionId: plan.transactionId, reason: 'generation fenced' }, 'PREEMPTION_ALREADY_RESOLVED')
  })
})
