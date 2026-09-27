import { describe, expect, test } from 'bun:test'
import {
  admitJevDecision,
  appendSnapshot,
  applyKernelCommand,
  assertKernelInvariants,
  buildJevDecisionFrame,
  createKernelState,
  createTransitionContract,
  currentBinding,
  currentEffectivePriority,
  kernelSemanticDigest,
  replayKernelEvents,
  recoverKernelFromJournal,
  selectSchedulerExecution,
  resourceId,
  resourceKey,
  resourcesOverlap,
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

const world: WorldIdentity = { serverId: 'local', dimension: 'minecraft:overworld', worldEpoch: 7 }
const verifier = { id: 'verifier:world', version: '1' } as const
const progress = { id: 'progress:generic', version: '1' } as const
const terminalPolicy = { id: 'terminal:generic', version: '1' } as const
const controllerDefinition = { id: 'controller:generic', version: '1' } as const
const compiler = { id: 'compiler:test', version: '1' } as const
const missionAuthority = { id: 'mission:test', version: '1' } as const
const body = resourceId('body')
const locomotion = resourceId('body', ['locomotion'])
const orientation = resourceId('body', ['orientation'])
const inventory = resourceId('inventory')
const worldBlocks = resourceId('world', ['blocks'])
const memory = resourceId('memory', ['worldModel'])

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
function initial(contracts: readonly CanonicalTransitionContract[], appendResources: readonly ReturnType<typeof resourceId>[] = []): KernelState {
  return createKernelState({ world, generationId: 'gen-a', missionPredicates: contracts.map((c) => c.desiredPredicate), verifierRegistry: [verifier], progressRegistry: [progress], contractCompilerRegistry: [compiler], missionAuthority, appendResources, minResidencyMs: 250, preemptibleYieldBudgetMs: 50 })
}
type LooseCommand = Record<string, unknown> & { readonly kind: string }
function authorize(state: KernelState, command: LooseCommand): KernelCommand {
  if ('capability' in command) return command as unknown as KernelCommand
  switch (command.kind) {
    case 'REGISTER_TRANSITION': return { ...command, compiler, capability: trustedContractCompiler(compiler.id) } as unknown as KernelCommand
    case 'ADMIT_TRANSITION': case 'ACQUIRE_DECLARED_RESOURCES': case 'PAUSE_ACTIVE': case 'RESUME_TRANSITION': case 'AGE_RUNNABLE': case 'START_PREEMPTION': case 'COMMIT_PREEMPTION': case 'CANCEL_PREEMPTION': case 'REQUEST_CANCEL':
      return { ...command, capability: trustedScheduler() } as unknown as KernelCommand
    case 'ACK_PREEMPTION_YIELD': return { ...command, capability: trustedController(String(command.victimId), state.transitionContracts[String(command.victimId)] ?? '', state.generationId) } as unknown as KernelCommand
    case 'ISSUE_EFFECT': case 'APPEND_RECORD': case 'ACK_CANCEL_YIELD': {
      const id = String(command.transitionId); return { ...command, capability: trustedController(id, state.transitionContracts[id] ?? '', state.generationId) } as unknown as KernelCommand
    }
    case 'DEBIT_USAGE': {
      const id = String(command.actorTransitionId); return { ...command, capability: trustedController(id, state.transitionContracts[id] ?? '', state.generationId) } as unknown as KernelCommand
    }
    case 'BEGIN_EFFECT_DISPATCH': return { ...command, capability: trustedDispatcher() } as unknown as KernelCommand
    case 'REPORT_PROGRESS': return { ...command, evaluator: progress, capability: trustedProgressEvaluator(progress.id) } as unknown as KernelCommand
    case 'VERIFY_SUCCESS': return { ...command, verifier, capability: trustedVerifier(verifier.id) } as unknown as KernelCommand
    case 'UPDATE_MISSION': return { ...command, authority: missionAuthority, capability: trustedMissionAuthority(missionAuthority.id) } as unknown as KernelCommand
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
function acceptFacts(state: KernelState, facts: readonly { predicateId: string; truth?: 'true' | 'false' | 'unknown'; valueHash?: string; effectCommitId?: string | null }[], materialChange = true, events?: KernelEvent[]): KernelState {
  return apply(state, {
    kind: 'ACCEPT_VERIFIED_SNAPSHOT', verifier, materialChange, observedAtMonoMs: state.monotonicMs,
    facts: facts.map((f) => ({ predicateId: f.predicateId, truth: f.truth ?? 'true', valueHash: f.valueHash ?? `hash:${f.predicateId}`, effectCommitId: f.effectCommitId ?? null })),
    capability: trustedVerifier(verifier.id),
  }, events)
}
function advance(state: KernelState, toMonoMs: number, events?: KernelEvent[]): KernelState {
  return apply(state, { kind: 'ADVANCE_TIME', toMonoMs, capability: trustedWorldAdapter('clock') }, events)
}
function issue(state: KernelState, c: CanonicalTransitionContract, kind: EffectPermitSpec['kind'], scope: string, events?: KernelEvent[]): { state: KernelState; commitId: string } {
  const before = new Set(Object.keys(state.effects))
  state = apply(state, { kind: 'ISSUE_EFFECT', transitionId: c.transitionId, effect: kind, scope, ttlMs: 100 }, events)
  const commitId = Object.keys(state.effects).find((id) => !before.has(id))
  if (commitId === undefined) throw new Error('no commit id')
  return { state, commitId }
}

describe('V4.1.2 production-grade executable kernel regressions', () => {
  test('terminal transition cannot acquire lease', () => {
    const c = contract('reach:terminal')
    let s = activate(initial([c]), c)
    s = acceptFacts(s, [{ predicateId: c.desiredPredicate }])
    s = apply(s, { kind: 'VERIFY_SUCCESS', transitionId: c.transitionId, causalCredit: 'self' })
    expect(s.transitions[c.transitionId]?.lifecycle).toBe('TERMINAL')
    expect(Object.values(s.leases).filter((l) => l.owner === c.transitionId)).toHaveLength(0)
    reject(s, { kind: 'ACQUIRE_DECLARED_RESOURCES', transitionId: c.transitionId }, 'ONLY_RUNNABLE_CAN_ACQUIRE')
  })

  test('suspended transition cannot activate without ResumeProof', () => {
    const c = contract('reach:suspend')
    let s = activate(initial([c]), c)
    s = apply(s, { kind: 'CHANGE_GENERATION', generationId: 'gen-b', capability: trustedWorldAdapter('runtime') })
    expect(s.transitions[c.transitionId]?.lifecycle).toBe('SUSPENDED')
    reject(s, { kind: 'ACQUIRE_DECLARED_RESOURCES', transitionId: c.transitionId }, 'ONLY_RUNNABLE_CAN_ACQUIRE')
  })

  test('suspend/block/observe atomically revoke required actuation leases', () => {
    for (const to of ['OBSERVING', 'BLOCKED'] as const) {
      const c = contract(`reach:${to.toLowerCase()}`)
      let s = activate(initial([c]), c)
      expect(Object.values(s.leases).some((l) => l.owner === c.transitionId)).toBe(true)
      s = apply(s, { kind: 'PAUSE_ACTIVE', transitionId: c.transitionId, to, reason: 'test' })
      expect(s.transitions[c.transitionId]?.heldLeaseIds).toEqual([])
      expect(Object.values(s.leases).some((l) => l.owner === c.transitionId)).toBe(false)
    }
  })

  test('removing active transition cannot orphan leases', () => {
    const c = contract('reach:no-remove')
    const s = activate(initial([c]), c)
    const r = applyKernelCommand(s, { kind: 'REMOVE_TRANSITION', transitionId: c.transitionId } as unknown as KernelCommand)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('UNKNOWN_COMMAND')
    expect(Object.values(s.leases).some((l) => l.owner === c.transitionId)).toBe(true)
    expect(() => assertKernelInvariants(s)).not.toThrow()
  })

  test('effect token cannot be current without required leases', () => {
    const c = contract('dig:no-lease', 'MISSION', [claim(worldBlocks)], [effect('DIG', 'block:1,2,3', worldBlocks)])
    let s = registerAdmit(initial([c]), c)
    reject(s, { kind: 'ISSUE_EFFECT', transitionId: c.transitionId, effect: 'DIG', scope: 'block:1,2,3', ttlMs: 100 }, 'TRANSITION_NOT_EFFECT_ELIGIBLE')
    s = apply(s, { kind: 'ACQUIRE_DECLARED_RESOURCES', transitionId: c.transitionId })
    s = apply(s, { kind: 'PAUSE_ACTIVE', transitionId: c.transitionId, to: 'OBSERVING', reason: 'release' })
    reject(s, { kind: 'ISSUE_EFFECT', transitionId: c.transitionId, effect: 'DIG', scope: 'block:1,2,3', ttlMs: 100 }, 'TRANSITION_NOT_EFFECT_ELIGIBLE')
  })

  test('effect token is single-use', () => {
    const c = contract('dig:single', 'MISSION', [claim(worldBlocks)], [effect('DIG', 'block:a', worldBlocks, 2)])
    let s = activate(initial([c]), c)
    const issued = issue(s, c, 'DIG', 'block:a'); s = issued.state
    s = apply(s, { kind: 'BEGIN_EFFECT_DISPATCH', commitId: issued.commitId })
    reject(s, { kind: 'BEGIN_EFFECT_DISPATCH', commitId: issued.commitId }, 'EFFECT_COMMIT_NOT_ISSUED')
  })

  test('effect permit maxCount is enforced', () => {
    const c = contract('dig:max', 'MISSION', [claim(worldBlocks)], [effect('DIG', 'block:max', worldBlocks, 1)])
    let s = activate(initial([c]), c)
    const issued = issue(s, c, 'DIG', 'block:max'); s = issued.state
    s = apply(s, { kind: 'BEGIN_EFFECT_DISPATCH', commitId: issued.commitId })
    reject(s, { kind: 'ISSUE_EFFECT', transitionId: c.transitionId, effect: 'DIG', scope: 'block:max', ttlMs: 100 }, 'EFFECT_MAX_COUNT_EXHAUSTED')
  })

  test('same-hash mutated contract cannot verify', () => {
    const c = contract('verify:canonical')
    let s = registerAdmit(initial([c]), c)
    const fake = { ...c, ensures: [...c.ensures, 'goal:forged'] } as CanonicalTransitionContract
    reject(s, { kind: 'REGISTER_TRANSITION', contract: fake }, 'NON_CANONICAL_CONTRACT')
    s = acceptFacts(s, [{ predicateId: c.desiredPredicate }])
    s = apply(s, { kind: 'VERIFY_SUCCESS', transitionId: c.transitionId, causalCredit: 'external' })
    expect(s.transitions[c.transitionId]?.terminalOutcome?.kind).toBe('SUCCESS')
  })

  test('same-hash mutated contract cannot add effect authority', () => {
    const c = contract('effect:canonical', 'MISSION', [claim(worldBlocks)], [])
    let s = activate(initial([c]), c)
    const fake = { ...c, effects: [effect('DIG', 'block:forged', worldBlocks)] } as unknown as CanonicalTransitionContract
    reject(s, { kind: 'REGISTER_TRANSITION', contract: fake }, 'NON_CANONICAL_CONTRACT')
    reject(s, { kind: 'ISSUE_EFFECT', transitionId: c.transitionId, effect: 'DIG', scope: 'block:forged', ttlMs: 100 }, 'EFFECT_NOT_PERMITTED')
  })

  test('registry revision and live binding cannot diverge', () => {
    const c = contract('registry:coherent')
    let s = initial([c])
    expect(currentBinding(s).registryRevision).toBe(s.registryRevision)
    s = registerAdmit(s, c)
    expect(currentBinding(s).registryRevision).toBe(s.registryRevision)
    s = apply(s, { kind: 'ACQUIRE_DECLARED_RESOURCES', transitionId: c.transitionId })
    expect(currentBinding(s).registryRevision).toBe(s.registryRevision)
  })

  test('Jev world mismatch is stale', () => {
    const c = contract('jev:world')
    const s = registerAdmit(initial([c]), c)
    const frame = buildJevDecisionFrame(s, { [c.transitionId]: ['walk', 'wait'] })
    const decision = { frameHash: frame.frameHash, schedulerEpoch: frame.schedulerEpoch, world: { ...world, worldEpoch: 8 }, binding: frame.binding, rankedTransitionIds: [c.transitionId], tacticChoices: { [c.transitionId]: 'walk' } }
    expect(admitJevDecision(s, frame, decision)).toEqual({ ok: false, reason: 'STALE_WORLD' })
  })

  test('Jev unknown transition/tactic is rejected', () => {
    const c = contract('jev:ground')
    const s = registerAdmit(initial([c]), c)
    const frame = buildJevDecisionFrame(s, { [c.transitionId]: ['walk'] })
    const base = { frameHash: frame.frameHash, schedulerEpoch: frame.schedulerEpoch, world, binding: frame.binding }
    expect(admitJevDecision(s, frame, { ...base, rankedTransitionIds: ['EVIL'], tacticChoices: {} })).toEqual({ ok: false, reason: 'UNGROUNDED_TRANSITION_ID' })
    expect(admitJevDecision(s, frame, { ...base, rankedTransitionIds: [c.transitionId], tacticChoices: { [c.transitionId]: 'teleport' } })).toEqual({ ok: false, reason: 'UNGROUNDED_TACTIC' })
  })

  test('resolved preemption transaction cannot revoke a lease granted after cancel', () => {
    const victim = contract('reach:victim')
    const requester = contract('viability:requester', 'VIABILITY')
    let s = initial([victim, requester]); s = activate(s, victim); s = registerAdmit(s, requester)
    const planned = applyKernelCommand(s, authorize(s, { kind: 'START_PREEMPTION', requesterId: requester.transitionId })); expect(planned.ok).toBe(true); if (!planned.ok) return
    s = planned.state
    const txId = Object.keys(s.preemptions)[0]!
    // A live transaction owns the victim's lease set: an independent pause is
    // refused. Explicit cancel releases that ownership.
    reject(s, { kind: 'PAUSE_ACTIVE', transitionId: victim.transitionId, to: 'BLOCKED', reason: 'external' }, 'PREEMPTION_TRANSACTION_IN_FLIGHT')
    s = apply(s, { kind: 'CANCEL_PREEMPTION', transactionId: txId, reason: 'scheduler replan' })
    s = apply(s, { kind: 'PAUSE_ACTIVE', transitionId: victim.transitionId, to: 'BLOCKED', reason: 'external' })
    s = apply(s, { kind: 'RESUME_TRANSITION', transitionId: victim.transitionId })
    s = apply(s, { kind: 'ACQUIRE_DECLARED_RESOURCES', transitionId: victim.transitionId })
    reject(s, { kind: 'ACK_PREEMPTION_YIELD', transactionId: txId, victimId: victim.transitionId, safeYield: true, atMonoMs: s.monotonicMs }, 'STALE_PREEMPTION')
    expect(s.transitions[victim.transitionId]?.lifecycle).toBe('ACTIVE')
  })

  test('preemption requester bundle cannot change between request and grant', () => {
    const victim = contract('reach:bundle-victim')
    const requester = contract('viability:bundle', 'VIABILITY', [claim(locomotion)])
    let s = initial([victim, requester]); s = activate(s, victim); s = registerAdmit(s, requester)
    s = apply(s, { kind: 'START_PREEMPTION', requesterId: requester.transitionId })
    const txId = Object.keys(s.preemptions)[0]!
    s = apply(s, { kind: 'ACK_PREEMPTION_YIELD', transactionId: txId, victimId: victim.transitionId, safeYield: true, atMonoMs: s.monotonicMs })
    s = apply(s, { kind: 'COMMIT_PREEMPTION', transactionId: txId, requesterClaims: [claim(inventory)] } as unknown as KernelCommand)
    const owned = Object.values(s.leases).filter((l) => l.owner === requester.transitionId)
    expect(owned.map((l) => l.resourceKey)).toEqual([resourceKey(locomotion)])
  })

  test('resumable=false has explicit enforced semantics', () => {
    const victim = contract('craft:nonresumable', 'MISSION', [claim(inventory, 'EXCLUSIVE_WRITE', { resumable: false })])
    const requester = contract('viability:inventory', 'VIABILITY', [claim(inventory)])
    let s = initial([victim, requester]); s = activate(s, victim); s = registerAdmit(s, requester)
    s = apply(s, { kind: 'START_PREEMPTION', requesterId: requester.transitionId })
    const txId = Object.keys(s.preemptions)[0]!
    s = apply(s, { kind: 'ACK_PREEMPTION_YIELD', transactionId: txId, victimId: victim.transitionId, safeYield: true, atMonoMs: 0 })
    s = apply(s, { kind: 'COMMIT_PREEMPTION', transactionId: txId })
    expect(s.transitions[victim.transitionId]?.lifecycle).toBe('TERMINAL')
    expect(s.transitions[victim.transitionId]?.terminalOutcome).toEqual({ kind: 'PREEMPTED_NONRESUMABLE', by: requester.transitionId })
  })

  test('suspended transition cannot bypass resume via activate', () => {
    const c = contract('reach:no-bypass')
    let s = activate(initial([c]), c)
    s = apply(s, { kind: 'CHANGE_GENERATION', generationId: 'gen-b', capability: trustedWorldAdapter('runtime') })
    reject(s, { kind: 'ACQUIRE_DECLARED_RESOURCES', transitionId: c.transitionId }, 'ONLY_RUNNABLE_CAN_ACQUIRE')
  })

  test('deadline/budget exhaustion is enforced', () => {
    const c = contract('budget:deadline', 'MISSION', [claim()], [], { budget: { maxActiveMs: 5, deadlineAtMonoMs: 10, maxMechanicalSteps: 1, resources: { items: 1 }, risk: { damage: 1 } } })
    let s = activate(initial([c]), c)
    s = advance(s, 6)
    expect(s.transitions[c.transitionId]?.terminalOutcome?.kind).toBe('ACTIVE_TIME_EXHAUSTED')
    const c2 = contract('budget:steps', 'MISSION', [claim()], [], { budget: { maxActiveMs: 100, deadlineAtMonoMs: 100, maxMechanicalSteps: 1, resources: { items: 1 }, risk: { damage: 1 } } })
    s = activate(initial([c2]), c2)
    s = apply(s, { kind: 'DEBIT_USAGE', actorTransitionId: c2.transitionId, targetTransitionId: c2.transitionId, mechanicalSteps: 2 })
    expect(s.transitions[c2.transitionId]?.terminalOutcome?.kind).toBe('MECHANICAL_STEPS_EXHAUSTED')
  })

  test('duplicate same-hash ATR bootstrap is rejected', () => {
    const c = contract('registry:duplicate')
    let s = initial([c]); s = apply(s, { kind: 'REGISTER_TRANSITION', contract: c })
    reject(s, { kind: 'REGISTER_TRANSITION', contract: c }, 'DUPLICATE_TRANSITION_ID')
  })

  test('ResumeProof cannot self-attest registry/Mission booleans', () => {
    const c = contract('resume:no-self-attest')
    let s = activate(initial([c]), c)
    s = apply(s, { kind: 'CHANGE_GENERATION', generationId: 'gen-b', capability: trustedWorldAdapter('runtime') })
    s = apply(s, { kind: 'UPDATE_MISSION', predicates: [] })
    expect(s.transitions[c.transitionId]?.terminalOutcome).toEqual({ kind: 'MISSION_SUPERSEDED', missionRevision: s.missionRevision })
    reject(s, { kind: 'RESUME_TRANSITION', transitionId: c.transitionId, registryContainsTransition: true, missionAuthorizesPredicate: true } as unknown as LooseCommand, 'ILLEGAL_LIFECYCLE_EDGE')
  })

  test('active ATR removal cannot leave token/lease authority', () => {
    const c = contract('cancel:cleanup', 'MISSION', [claim(worldBlocks)], [effect('DIG', 'block:cancel', worldBlocks)])
    let s = activate(initial([c]), c)
    const issued = issue(s, c, 'DIG', 'block:cancel'); s = issued.state
    s = apply(s, { kind: 'REQUEST_CANCEL', transitionId: c.transitionId, reason: 'user' })
    expect(s.transitions[c.transitionId]?.lifecycle).toBe('TERMINAL')
    expect(Object.values(s.leases).filter((l) => l.owner === c.transitionId)).toHaveLength(0)
    expect(s.effects[issued.commitId]?.status).toBe('REVOKED')
  })

  test('late safe-yield may recover without erasing deadline violation', () => {
    const victim = contract('critical:late', 'MISSION', [claim(inventory, 'EXCLUSIVE_WRITE', { preemptible: false, maxNonPreemptibleMs: 10 })])
    const requester = contract('viability:late', 'VIABILITY', [claim(inventory)])
    let s = initial([victim, requester]); s = activate(s, victim); s = registerAdmit(s, requester)
    s = apply(s, { kind: 'START_PREEMPTION', requesterId: requester.transitionId })
    const txId = Object.keys(s.preemptions)[0]!
    s = advance(s, 11)
    s = apply(s, { kind: 'ACK_PREEMPTION_YIELD', transactionId: txId, victimId: victim.transitionId, safeYield: true, atMonoMs: 11 })
    expect(s.preemptions[txId]?.victims[0]?.deadlineViolated).toBe(true)
    expect(s.preemptions[txId]?.victims[0]?.lateYield).toBe(true)
    s = apply(s, { kind: 'COMMIT_PREEMPTION', transactionId: txId })
    expect(s.transitions[requester.transitionId]?.lifecycle).toBe('ACTIVE')
    expect(s.preemptions[txId]?.victims[0]?.deadlineViolated).toBe(true)
  })

  test('non-preemptible bound uses actual critical-section start', () => {
    const victim = contract('critical:start', 'MISSION', [claim(inventory, 'EXCLUSIVE_WRITE', { preemptible: false, maxNonPreemptibleMs: 10 })])
    const requester = contract('viability:start', 'VIABILITY', [claim(inventory)])
    let s = initial([victim, requester]); s = advance(s, 5); s = activate(s, victim); s = registerAdmit(s, requester); s = advance(s, 8)
    s = apply(s, { kind: 'START_PREEMPTION', requesterId: requester.transitionId })
    const tx = Object.values(s.preemptions)[0]!
    expect(tx.victims[0]?.hardYieldDeadlineMonoMs).toBe(15)
  })

  test('multi-owner conflict cannot partially suspend victims without a valid plan', () => {
    const a = contract('owner:a', 'MISSION', [claim(locomotion)])
    const b = contract('owner:b', 'MISSION', [claim(inventory)])
    const r = contract('viability:multi', 'VIABILITY', [claim(locomotion), claim(inventory)])
    let s = initial([a, b, r]); s = activate(s, a); s = activate(s, b); s = registerAdmit(s, r)
    s = apply(s, { kind: 'START_PREEMPTION', requesterId: r.transitionId })
    const txId = Object.keys(s.preemptions)[0]!
    const victims = s.preemptions[txId]!.victims.map((v) => v.transitionId).sort(); expect(victims).toEqual([a.transitionId, b.transitionId].sort())
    s = apply(s, { kind: 'ACK_PREEMPTION_YIELD', transactionId: txId, victimId: a.transitionId, safeYield: true, atMonoMs: 0 })
    reject(s, { kind: 'COMMIT_PREEMPTION', transactionId: txId }, 'PREEMPTION_NOT_READY')
    expect(s.transitions[a.transitionId]?.lifecycle).toBe('ACTIVE')
    expect(s.transitions[b.transitionId]?.lifecycle).toBe('ACTIVE')
  })

  test('APPEND merge remains deterministic/idempotent', () => {
    const a = contract('search:a', 'BACKGROUND', [claim(memory, 'APPEND')])
    const b = contract('search:b', 'BACKGROUND', [claim(memory, 'APPEND')])
    const make = (order: readonly [string, string][]) => {
      let s = initial([a, b], [memory]); s = activate(s, a); s = activate(s, b)
      for (const [op, payload] of order) s = apply(s, { kind: 'APPEND_RECORD', transitionId: op === 'op:b' ? b.transitionId : a.transitionId, resource: memory, operationId: op, payloadHash: payload })
      s = apply(s, { kind: 'APPEND_RECORD', transitionId: a.transitionId, resource: memory, operationId: 'op:a', payloadHash: 'A' })
      return s
    }
    const s1 = make([['op:a', 'A'], ['op:b', 'B']])
    const s2 = make([['op:b', 'B'], ['op:a', 'A']])
    expect(appendSnapshot(s1, memory).payloadHashes).toEqual(['A', 'B'])
    expect(appendSnapshot(s2, memory).payloadHashes).toEqual(['A', 'B'])
  })

  test('canonical contract preserves V4 requires/ensures/invariants semantics', () => {
    expect(() => contract('bad:ensure', 'MISSION', [claim()], [], { desiredPredicate: 'goal:primary', ensures: ['goal:other'] })).toThrow('desiredPredicate must be included in ensures')
    const c = contract('multi:ensure', 'MISSION', [claim()], [], { requires: ['pre:a'], ensures: ['goal:multi:ensure', 'post:b'], invariants: ['inv:safe'] })
    expect(c.requires).toEqual(['pre:a']); expect(c.ensures).toEqual(['goal:multi:ensure', 'post:b']); expect(c.invariants).toEqual(['inv:safe'])
    let s = registerAdmit(initial([c]), c)
    s = acceptFacts(s, [{ predicateId: 'goal:multi:ensure' }, { predicateId: 'inv:safe' }])
    reject(s, { kind: 'VERIFY_SUCCESS', transitionId: c.transitionId, causalCredit: 'self' }, 'TRUSTED_VERIFY_PROOF_MISSING')
    s = acceptFacts(s, [{ predicateId: 'goal:multi:ensure' }, { predicateId: 'post:b' }, { predicateId: 'inv:safe' }])
    s = apply(s, { kind: 'VERIFY_SUCCESS', transitionId: c.transitionId, causalCredit: 'self' })
    expect(s.transitions[c.transitionId]?.terminalOutcome?.kind).toBe('SUCCESS')
  })
})

describe('V4.1.2 additional authority, liveness, and replay hardening', () => {
  test('contract hash is kernel-owned and runtime contract is deep immutable', () => {
    const c = contract('contract:freeze')
    expect(Object.isFrozen(c)).toBe(true); expect(Object.isFrozen(c.claims)).toBe(true); expect(Object.isFrozen(c.budget)).toBe(true)
    expect(() => ((c as unknown as { family: string }).family = 'evil')).toThrow()
    const changed = contract('contract:freeze', 'MISSION', [claim()], [], { progressDefinition: { id: 'progress:other', version: '1' } })
    expect(changed.contractHash).not.toBe(c.contractHash)
  })

  test('forged verifier and witness attestations cannot create authority', () => {
    const c = contract('proof:trusted', 'MISSION', [claim()], [], { requires: ['pre:trusted'], witnessValidation: { id: 'witness:path', version: '1' } })
    let s = registerAdmit(initial([c]), c)
    reject(s, { kind: 'ACCEPT_VERIFIED_SNAPSHOT', verifier, facts: [{ predicateId: 'pre:trusted', truth: 'true', valueHash: 'x' }], materialChange: true, observedAtMonoMs: 0, capability: { source: 'VERIFIER', id: verifier.id } }, 'UNTRUSTED_VERIFIER_CAPABILITY')
    reject(s, { kind: 'ACCEPT_WITNESS_PROOF', transitionId: c.transitionId, witnessRevision: 1, witnessRefHash: 'w', relationId: 'reachable', validator: { id: 'witness:path', version: '1' }, capability: { source: 'WITNESS_VALIDATOR', id: 'witness:path' } }, 'UNTRUSTED_WITNESS_CAPABILITY')
    s = apply(s, { kind: 'ACCEPT_VERIFIED_SNAPSHOT', verifier, facts: [{ predicateId: 'pre:trusted', truth: 'true', valueHash: 'x' }], materialChange: true, observedAtMonoMs: 0, capability: trustedVerifier(verifier.id) })
    s = apply(s, { kind: 'ACCEPT_WITNESS_PROOF', transitionId: c.transitionId, witnessRevision: 1, witnessRefHash: 'w', relationId: 'reachable', validator: { id: 'witness:path', version: '1' }, capability: trustedWitnessValidator('witness:path') })
    s = apply(s, { kind: 'ACQUIRE_DECLARED_RESOURCES', transitionId: c.transitionId })
    expect(s.transitions[c.transitionId]?.lifecycle).toBe('ACTIVE')
  })

  test('structured resource identity gives parent/child conflict without punctuation parsing', () => {
    expect(resourcesOverlap(body, locomotion)).toBe(true)
    expect(resourcesOverlap(resourceId('station', ['furnace']), resourceId('station', ['furnace'], '1:2:3'))).toBe(true)
    expect(resourcesOverlap(resourceId('entity', ['mob'], 'a:b/c'), resourceId('entity', ['mob'], 'a:b/c'))).toBe(true)
    expect(resourcesOverlap(resourceId('entity', ['mob'], 'a:b/c'), resourceId('entity', ['mob'], 'other'))).toBe(false)
  })

  test('contradictory overlapping same-owner resource claims fail contract construction', () => {
    expect(() => contract('claims:bad', 'MISSION', [claim(inventory, 'SHARED_READ'), claim(resourceId('inventory', ['slot'], '0'), 'EXCLUSIVE_WRITE')])).toThrow('ambiguous overlapping claims')
  })

  test('resource acquisition does not silently replace an existing bundle', () => {
    const c = contract('bundle:no-replace', 'MISSION', [claim(locomotion), claim(orientation)])
    let s = activate(initial([c]), c)
    const before = s.transitions[c.transitionId]!.heldLeaseIds
    reject(s, { kind: 'ACQUIRE_DECLARED_RESOURCES', transitionId: c.transitionId }, 'ONLY_RUNNABLE_CAN_ACQUIRE')
    expect(s.transitions[c.transitionId]!.heldLeaseIds).toEqual(before)
  })

  test('priority inheritance changes executable effective priority and releases after commit', () => {
    const victim = contract('background:critical', 'BACKGROUND', [claim(inventory, 'EXCLUSIVE_WRITE', { preemptible: false, maxNonPreemptibleMs: 20 })])
    const requester = contract('viability:priority', 'VIABILITY', [claim(inventory)])
    let s = initial([victim, requester]); s = activate(s, victim); s = registerAdmit(s, requester)
    const before = currentEffectivePriority(s, victim.transitionId); const req = currentEffectivePriority(s, requester.transitionId); expect(req).toBeGreaterThan(before)
    s = apply(s, { kind: 'START_PREEMPTION', requesterId: requester.transitionId })
    expect(currentEffectivePriority(s, victim.transitionId)).toBe(req)
    const txId = Object.keys(s.preemptions)[0]!
    s = apply(s, { kind: 'ACK_PREEMPTION_YIELD', transactionId: txId, victimId: victim.transitionId, safeYield: true, atMonoMs: 0 })
    s = apply(s, { kind: 'COMMIT_PREEMPTION', transactionId: txId })
    expect(currentEffectivePriority(s, victim.transitionId)).toBe(before)
  })

  test('lower priority requester cannot create meaningless inheritance', () => {
    const victim = contract('viability:owner', 'VIABILITY', [claim(inventory, 'EXCLUSIVE_WRITE', { preemptible: false, maxNonPreemptibleMs: 20 })])
    const requester = contract('background:requester', 'BACKGROUND', [claim(inventory)])
    let s = initial([victim, requester]); s = activate(s, victim); s = registerAdmit(s, requester)
    reject(s, { kind: 'START_PREEMPTION', requesterId: requester.transitionId }, 'LOWER_PRIORITY_CANNOT_PREEMPT')
  })

  test('BLOCKED transition does not accumulate runnable starvation age', () => {
    const c = contract('blocked:no-age')
    let s = activate(initial([c]), c); s = apply(s, { kind: 'PAUSE_ACTIVE', transitionId: c.transitionId, to: 'BLOCKED', reason: 'WAITING_EXTERNAL' })
    reject(s, { kind: 'AGE_RUNNABLE', transitionId: c.transitionId }, 'ONLY_RUNNABLE_AGES')
    expect(s.transitions[c.transitionId]?.starvationAge).toBe(0)
  })

  test('equal-priority residency hysteresis blocks ping-pong until residency expires', () => {
    const a = contract('mission:a')
    const b = contract('mission:b')
    let s = initial([a, b]); s = activate(s, a); s = registerAdmit(s, b)
    reject(s, { kind: 'START_PREEMPTION', requesterId: b.transitionId }, 'RESIDENCY_HYSTERESIS')
    s = advance(s, 251)
    s = apply(s, { kind: 'START_PREEMPTION', requesterId: b.transitionId })
    expect(Object.values(s.preemptions)).toHaveLength(1)
  })

  test('generation change preserves semantic contract but invalidates mechanical authority and old proof', () => {
    const c = contract('generation:fence', 'MISSION', [claim()], [], { requires: ['pre:fresh'] })
    let s = registerAdmit(initial([c]), c); s = acceptFacts(s, [{ predicateId: 'pre:fresh' }]); s = apply(s, { kind: 'ACQUIRE_DECLARED_RESOURCES', transitionId: c.transitionId })
    const hash = c.contractHash; s = apply(s, { kind: 'CHANGE_GENERATION', generationId: 'gen-b', capability: trustedWorldAdapter('runtime') })
    expect(s.transitionContracts[c.transitionId]).toBe(hash); expect(Object.values(s.leases)).toHaveLength(0)
    reject(s, { kind: 'RESUME_TRANSITION', transitionId: c.transitionId }, 'FRESH_PRECONDITION_PROOF_REQUIRED')
    s = acceptFacts(s, [{ predicateId: 'pre:fresh' }]); s = apply(s, { kind: 'RESUME_TRANSITION', transitionId: c.transitionId })
    expect(s.transitions[c.transitionId]?.lifecycle).toBe('RUNNABLE')
  })

  test('world boundary invalidates leases effects preemption facts witnesses and Jev frame', () => {
    const a = contract('world:a', 'MISSION', [claim(worldBlocks)], [effect('DIG', 'block:world', worldBlocks)])
    const b = contract('viability:world', 'VIABILITY', [claim(worldBlocks)])
    let s = initial([a, b]); s = activate(s, a); s = registerAdmit(s, b)
    const issued = issue(s, a, 'DIG', 'block:world'); s = issued.state
    s = apply(s, { kind: 'START_PREEMPTION', requesterId: b.transitionId })
    const oldFrame = buildJevDecisionFrame(s, { [b.transitionId]: ['wait'] })
    const changed = { ...world, dimension: 'minecraft:the_nether', worldEpoch: 8 }
    s = apply(s, { kind: 'CHANGE_WORLD', world: changed, capability: trustedWorldAdapter('world') })
    // The live transaction dies with its world: terminalizing its participants
    // resolves it CANCELED through the durable cleanup path, and the record is
    // preserved rather than erased.
    expect(Object.values(s.leases)).toHaveLength(0); expect(Object.values(s.preemptions)).toHaveLength(1); expect(Object.values(s.preemptions)[0]?.status).toBe('CANCELED'); expect(Object.values(s.facts)).toHaveLength(0); expect(Object.values(s.witnesses)).toHaveLength(0)
    expect(s.effects[issued.commitId]?.status).toBe('REVOKED')
    const decision = { frameHash: oldFrame.frameHash, schedulerEpoch: oldFrame.schedulerEpoch, world: oldFrame.world, binding: oldFrame.binding, rankedTransitionIds: [b.transitionId], tacticChoices: { [b.transitionId]: 'wait' } }
    expect(admitJevDecision(s, oldFrame, decision)).toEqual({ ok: false, reason: 'STALE_WORLD' })
  })

  test('irreversible effect crash UNKNOWN cannot auto-retry or replay commitId', () => {
    const c = contract('effect:crash', 'MISSION', [claim(worldBlocks)], [effect('DIG', 'block:crash', worldBlocks, 1)])
    let s = activate(initial([c]), c); const issued = issue(s, c, 'DIG', 'block:crash'); s = issued.state
    s = apply(s, { kind: 'BEGIN_EFFECT_DISPATCH', commitId: issued.commitId })
    s = apply(s, { kind: 'RECONCILE_EFFECT', commitId: issued.commitId, observation: 'UNKNOWN', factIds: [], verifier, capability: trustedVerifier(verifier.id) })
    expect(s.effects[issued.commitId]?.status).toBe('UNKNOWN')
    reject(s, { kind: 'BEGIN_EFFECT_DISPATCH', commitId: issued.commitId }, 'EFFECT_COMMIT_NOT_ISSUED')
    reject(s, { kind: 'ISSUE_EFFECT', transitionId: c.transitionId, effect: 'DIG', scope: 'block:crash', ttlMs: 100 }, 'EFFECT_MAX_COUNT_EXHAUSTED')
  })

  test('cancellation after dispatch preserves irreversible ambiguity and blocks new dispatch', () => {
    const c = contract('cancel:race', 'MISSION', [claim(worldBlocks)], [effect('DIG', 'block:race', worldBlocks, 2)])
    let s = activate(initial([c]), c); const issued = issue(s, c, 'DIG', 'block:race'); s = issued.state; s = apply(s, { kind: 'BEGIN_EFFECT_DISPATCH', commitId: issued.commitId })
    s = apply(s, { kind: 'REQUEST_CANCEL', transitionId: c.transitionId, reason: 'stop' })
    expect(s.transitions[c.transitionId]?.lifecycle).toBe('TERMINAL'); expect(s.effects[issued.commitId]?.status).toBe('UNKNOWN')
    reject(s, { kind: 'ISSUE_EFFECT', transitionId: c.transitionId, effect: 'DIG', scope: 'block:race', ttlMs: 100 }, 'TRANSITION_NOT_EFFECT_ELIGIBLE')
  })

  test('event replay survives JSON round-trip without re-querying models', () => {
    const c = contract('replay:a')
    const events: KernelEvent[] = []; const seed = initial([c]); let s = seed
    s = registerAdmit(s, c, events); s = apply(s, { kind: 'ACQUIRE_DECLARED_RESOURCES', transitionId: c.transitionId }, events); s = acceptFacts(s, [{ predicateId: c.desiredPredicate }], true, events); s = apply(s, { kind: 'VERIFY_SUCCESS', transitionId: c.transitionId, causalCredit: 'external' }, events)
    const roundTrip = JSON.parse(JSON.stringify(events)) as KernelEvent[]
    const replayed = replayKernelEvents(seed, roundTrip)
    expect(kernelSemanticDigest(replayed)).toBe(kernelSemanticDigest(s))
    expect(replayed.journalSequence).toBe(s.journalSequence)
  })

  test('effect permit required physical authority is mandatory at contract construction', () => {
    expect(() => createTransitionContract({
      transitionId: 'bad:effect', family: 'bad', class: 'MISSION', world, desiredPredicate: 'goal:bad', requires: [], ensures: ['goal:bad'], invariants: [], claims: [],
      effects: [{ kind: 'DIG', scope: 'x', irreversible: true, maxCount: 1, requiredResources: [] }],
      budget: { maxActiveMs: 1, deadlineAtMonoMs: 2, maxMechanicalSteps: 1, resources: {}, risk: {} }, progressDefinition: progress, controllerDefinition, verificationDefinition: verifier, terminalPolicy,
    })).toThrow('requires explicit physical resource authority')
  })

  test('same transition cannot debit another transition ledger', () => {
    const a = contract('budget:a', 'MISSION', [claim(locomotion)]), b = contract('budget:b', 'MISSION', [claim(orientation)])
    let s = initial([a, b]); s = activate(s, a); s = activate(s, b)
    reject(s, { kind: 'DEBIT_USAGE', actorTransitionId: a.transitionId, targetTransitionId: b.transitionId, mechanicalSteps: 1 }, 'CROSS_TRANSITION_DEBIT_FORBIDDEN')
  })
})

describe('V4.1.2 capability provenance and journal audit', () => {
  test('forged kernel snapshot is rejected before command evaluation', () => {
    const c = contract('state:provenance')
    const s = initial([c])
    const forged = { ...s } as KernelState
    const r = applyKernelCommand(forged, { kind: 'REGISTER_TRANSITION', contract: c, compiler, capability: trustedContractCompiler(compiler.id) })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('UNTRUSTED_KERNEL_STATE')
  })

  test('contract registration requires trusted compiler provenance', () => {
    const c = contract('compiler:provenance')
    const s = initial([c])
    const r = applyKernelCommand(s, { kind: 'REGISTER_TRANSITION', contract: c, compiler, capability: { source: 'CONTRACT_COMPILER', id: compiler.id } })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('UNTRUSTED_CONTRACT_COMPILER')
  })

  test('mission frontier mutation requires trusted mission authority and terminalizes superseded work atomically', () => {
    const c = contract('mission:authority')
    let s = activate(initial([c]), c)
    const forged = applyKernelCommand(s, { kind: 'UPDATE_MISSION', predicates: [], authority: missionAuthority, capability: { source: 'MISSION', id: missionAuthority.id } })
    expect(forged.ok).toBe(false)
    if (!forged.ok) expect(forged.reason).toBe('UNTRUSTED_MISSION_AUTHORITY')
    s = apply(s, { kind: 'UPDATE_MISSION', predicates: [] })
    expect(s.transitions[c.transitionId]?.terminalOutcome).toEqual({ kind: 'MISSION_SUPERSEDED', missionRevision: s.missionRevision })
    expect(Object.values(s.leases).filter((l) => l.owner === c.transitionId)).toHaveLength(0)
  })

  test('scheduler and dispatcher capabilities cannot be forged as plain objects', () => {
    const c = contract('caps:runtime', 'MISSION', [claim(worldBlocks)], [effect('DIG', 'block:caps', worldBlocks, 2)])
    let s = registerAdmit(initial([c]), c)
    let r = applyKernelCommand(s, { kind: 'ACQUIRE_DECLARED_RESOURCES', transitionId: c.transitionId, capability: { source: 'SCHEDULER', id: 'scheduler' } })
    expect(r.ok).toBe(false); if (!r.ok) expect(r.reason).toBe('UNTRUSTED_SCHEDULER')
    s = apply(s, { kind: 'ACQUIRE_DECLARED_RESOURCES', transitionId: c.transitionId })
    const issued = issue(s, c, 'DIG', 'block:caps'); s = issued.state
    r = applyKernelCommand(s, { kind: 'BEGIN_EFFECT_DISPATCH', commitId: issued.commitId, capability: { source: 'DISPATCHER', id: 'runtime' } })
    expect(r.ok).toBe(false); if (!r.ok) expect(r.reason).toBe('UNTRUSTED_DISPATCHER')
  })

  test('old generation controller capability cannot authorize new generation work', () => {
    const c = contract('controller:generation', 'MISSION', [claim(worldBlocks)], [effect('DIG', 'block:generation', worldBlocks)])
    let s = activate(initial([c]), c)
    const oldCap = trustedController(c.transitionId, c.contractHash, 'gen-a')
    s = apply(s, { kind: 'CHANGE_GENERATION', generationId: 'gen-b', capability: trustedWorldAdapter('runtime') })
    const r = applyKernelCommand(s, { kind: 'ISSUE_EFFECT', transitionId: c.transitionId, effect: 'DIG', scope: 'block:generation', ttlMs: 100, capability: oldCap })
    expect(r.ok).toBe(false); if (!r.ok) expect(r.reason).toBe('UNTRUSTED_CONTROLLER')
  })

  test('APPEND operation id collision with different payload fails closed', () => {
    const c = contract('append:collision', 'BACKGROUND', [claim(memory, 'APPEND')])
    let s = activate(initial([c], [memory]), c)
    s = apply(s, { kind: 'APPEND_RECORD', transitionId: c.transitionId, resource: memory, operationId: 'op:1', payloadHash: 'A' })
    reject(s, { kind: 'APPEND_RECORD', transitionId: c.transitionId, resource: memory, operationId: 'op:1', payloadHash: 'B' }, 'APPEND_OPERATION_ID_COLLISION')
    expect(appendSnapshot(s, memory)).toEqual({ revision: 1, payloadHashes: ['A'] })
  })

  test('effect reconciliation requires live trusted fact references for definite outcome', () => {
    const c = contract('effect:reconcile', 'MISSION', [claim(worldBlocks)], [effect('DIG', 'block:reconcile', worldBlocks, 2)])
    let s = activate(initial([c]), c)
    const issued = issue(s, c, 'DIG', 'block:reconcile'); s = issued.state
    s = apply(s, { kind: 'BEGIN_EFFECT_DISPATCH', commitId: issued.commitId })
    reject(s, { kind: 'RECONCILE_EFFECT', commitId: issued.commitId, observation: 'OCCURRED', factIds: ['made-up'], verifier, capability: trustedVerifier(verifier.id) }, 'UNTRUSTED_RECONCILIATION_FACT')
    s = acceptFacts(s, [{ predicateId: 'effect:dig:observed', effectCommitId: issued.commitId }])
    const factId = Object.keys(s.facts).at(-1)!
    s = apply(s, { kind: 'RECONCILE_EFFECT', commitId: issued.commitId, observation: 'OCCURRED', factIds: [factId], verifier, capability: trustedVerifier(verifier.id) })
    expect(s.effects[issued.commitId]?.status).toBe('OBSERVED')
  })

  test('journal carries global eventSeq and per-transition transitionSeq', () => {
    const c = contract('journal:seq')
    const events: KernelEvent[] = []
    let s = initial([c])
    s = registerAdmit(s, c, events)
    s = apply(s, { kind: 'ACQUIRE_DECLARED_RESOURCES', transitionId: c.transitionId }, events)
    const transitionEvents = events.filter((e) => e.transitionId === c.transitionId)
    expect(events.map((e) => e.eventSeq)).toEqual(events.map((_, i) => i + 1))
    expect(transitionEvents.map((e) => e.transitionSeq)).toEqual(transitionEvents.map((_, i) => i + 1))
    expect(s.transitionSequences[c.transitionId]).toBe(transitionEvents.length)
  })
})


describe('V4.1.2 five-pass adversarial closure', () => {
  test('bounded deadline terminalization waits for safe yield instead of force revoking', () => {
    const c = contract('critical:deadline-pending', 'MISSION', [claim(inventory, 'EXCLUSIVE_WRITE', { preemptible: false, maxNonPreemptibleMs: 10 })], [], {
      budget: { maxActiveMs: 100, deadlineAtMonoMs: 5, maxMechanicalSteps: 100, resources: {}, risk: {} },
    })
    let s = activate(initial([c]), c)
    const leaseIds = [...s.transitions[c.transitionId]!.heldLeaseIds]
    s = advance(s, 6)
    expect(s.transitions[c.transitionId]?.lifecycle).toBe('ACTIVE')
    expect(s.transitions[c.transitionId]?.pendingTerminalOutcome).toEqual({ kind: 'DEADLINE_EXPIRED' })
    expect(s.transitions[c.transitionId]?.heldLeaseIds).toEqual(leaseIds)
    expect(Object.values(s.leases).filter((l) => l.owner === c.transitionId).map((l) => l.leaseGrantId)).toEqual(leaseIds)
    reject(s, { kind: 'ISSUE_EFFECT', transitionId: c.transitionId, effect: 'MOVE', scope: 'x', ttlMs: 10 }, 'TRANSITION_NOT_EFFECT_ELIGIBLE')
    s = apply(s, { kind: 'ACK_TERMINAL_YIELD', transitionId: c.transitionId, atMonoMs: s.monotonicMs, capability: trustedController(c.transitionId, c.contractHash, s.generationId) })
    expect(s.transitions[c.transitionId]?.terminalOutcome).toEqual({ kind: 'DEADLINE_EXPIRED' })
    expect(Object.values(s.leases).filter((l) => l.owner === c.transitionId)).toHaveLength(0)
  })

  test('bounded active pause requires controller safe-yield acknowledgement', () => {
    const c = contract('critical:pause-yield', 'MISSION', [claim(inventory, 'EXCLUSIVE_WRITE', { preemptible: false, maxNonPreemptibleMs: 10 })])
    let s = activate(initial([c]), c)
    reject(s, { kind: 'PAUSE_ACTIVE', transitionId: c.transitionId, to: 'OBSERVING', reason: 'wait' }, 'SAFE_YIELD_REQUIRED')
    expect(s.transitions[c.transitionId]?.lifecycle).toBe('ACTIVE')
    s = apply(s, { kind: 'ACK_PAUSE_YIELD', transitionId: c.transitionId, to: 'OBSERVING', reason: 'wait', atMonoMs: s.monotonicMs, capability: trustedController(c.transitionId, c.contractHash, s.generationId) })
    expect(s.transitions[c.transitionId]?.lifecycle).toBe('OBSERVING')
    expect(Object.values(s.leases).filter((l) => l.owner === c.transitionId)).toHaveLength(0)
  })

  test('VERIFY success in bounded critical section becomes pending until safe yield', () => {
    const c = contract('critical:verify-yield', 'MISSION', [claim(inventory, 'EXCLUSIVE_WRITE', { preemptible: false, maxNonPreemptibleMs: 10 })])
    let s = activate(initial([c]), c)
    s = acceptFacts(s, [{ predicateId: c.desiredPredicate }])
    s = apply(s, { kind: 'VERIFY_SUCCESS', transitionId: c.transitionId, causalCredit: 'self' })
    expect(s.transitions[c.transitionId]?.lifecycle).toBe('ACTIVE')
    expect(s.transitions[c.transitionId]?.pendingTerminalOutcome?.kind).toBe('SUCCESS')
    s = apply(s, { kind: 'ACK_TERMINAL_YIELD', transitionId: c.transitionId, atMonoMs: s.monotonicMs, capability: trustedController(c.transitionId, c.contractHash, s.generationId) })
    expect(s.transitions[c.transitionId]?.terminalOutcome?.kind).toBe('SUCCESS')
  })

  test('Mission supersession in bounded critical section becomes pending until safe yield', () => {
    const c = contract('critical:mission-yield', 'MISSION', [claim(inventory, 'EXCLUSIVE_WRITE', { preemptible: false, maxNonPreemptibleMs: 10 })])
    let s = activate(initial([c]), c)
    s = apply(s, { kind: 'UPDATE_MISSION', predicates: [], authority: missionAuthority, capability: trustedMissionAuthority(missionAuthority.id) })
    expect(s.transitions[c.transitionId]?.lifecycle).toBe('ACTIVE')
    expect(s.transitions[c.transitionId]?.pendingTerminalOutcome?.kind).toBe('MISSION_SUPERSEDED')
    s = apply(s, { kind: 'ACK_TERMINAL_YIELD', transitionId: c.transitionId, atMonoMs: s.monotonicMs, capability: trustedController(c.transitionId, c.contractHash, s.generationId) })
    expect(s.transitions[c.transitionId]?.terminalOutcome?.kind).toBe('MISSION_SUPERSEDED')
  })

  test('multi-critical preemption waits for the last declared bound before a forced yield is lawful', () => {
    const station = resourceId('station', ['furnace'], '1,2,3')
    const victim = contract('critical:two-bounds', 'MISSION', [
      claim(inventory, 'EXCLUSIVE_WRITE', { preemptible: false, maxNonPreemptibleMs: 10 }),
      claim(station, 'EXCLUSIVE_WRITE', { preemptible: false, maxNonPreemptibleMs: 25 }),
    ])
    const requester = contract('viability:two-bounds', 'VIABILITY', [claim(inventory), claim(station)])
    let s = initial([victim, requester]); s = activate(s, victim); s = registerAdmit(s, requester)
    s = apply(s, { kind: 'START_PREEMPTION', requesterId: requester.transitionId })
    // A forced commit releases every victim lease; forcing before the latest
    // bound would truncate a critical section the victim still legitimately
    // holds (the 25ms station section).
    expect(Object.values(s.preemptions)[0]?.victims[0]?.hardYieldDeadlineMonoMs).toBe(25)
  })

  test('audit replay result cannot be promoted to live authority', () => {
    const c = contract('replay:offline')
    const start = initial([c]); const events: KernelEvent[] = []
    let s = registerAdmit(start, c, events)
    const replayed = replayKernelEvents(start, JSON.parse(JSON.stringify(events)) as KernelEvent[])
    const r = applyKernelCommand(replayed, authorize(replayed, { kind: 'ACQUIRE_DECLARED_RESOURCES', transitionId: c.transitionId }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('UNTRUSTED_KERNEL_STATE')
    expect(() => recoverKernelFromJournal(start, events, { source: 'JOURNAL', id: 'recovery' } as never)).toThrow()
    const recovered = recoverKernelFromJournal(start, events, trustedJournalRecovery())
    expect(applyKernelCommand(recovered, authorize(recovered, { kind: 'ACQUIRE_DECLARED_RESOURCES', transitionId: c.transitionId })).ok).toBe(true)
  })

  test('tampered replay event is rejected even when embedded command is unchanged', () => {
    const c = contract('replay:tamper')
    const start = initial([c]); const events: KernelEvent[] = []
    registerAdmit(start, c, events)
    const tampered = JSON.parse(JSON.stringify(events)) as KernelEvent[]
    const first = tampered[0]!
    tampered[0] = { ...first, data: { ...first.data, forged: true } }
    expect(() => replayKernelEvents(start, tampered)).toThrow(/replay event mismatch/)
  })

  test('priority inheritance gives blocking critical owner the executable slot', () => {
    const victim = contract('background:critical-slot', 'BACKGROUND', [claim(inventory, 'EXCLUSIVE_WRITE', { preemptible: false, maxNonPreemptibleMs: 20 })])
    const requester = contract('viability:critical-slot', 'VIABILITY', [claim(inventory)])
    let s = initial([victim, requester]); s = activate(s, victim); s = registerAdmit(s, requester)
    s = apply(s, { kind: 'START_PREEMPTION', requesterId: requester.transitionId })
    expect(selectSchedulerExecution(s, [requester.transitionId])).toEqual({ kind: 'CRITICAL_SECTION_OWNER', transitionId: victim.transitionId, effectivePriority: currentEffectivePriority(s, victim.transitionId) })
  })

  test('stale preemption cannot retain inherited scheduling priority', () => {
    const victim = contract('background:stale-inheritance', 'BACKGROUND', [claim(inventory, 'EXCLUSIVE_WRITE', { preemptible: false, maxNonPreemptibleMs: 20 })])
    const requester = contract('viability:stale-inheritance', 'VIABILITY', [claim(inventory)])
    let s = initial([victim, requester]); s = activate(s, victim); s = registerAdmit(s, requester)
    const base = currentEffectivePriority(s, victim.transitionId)
    s = apply(s, { kind: 'START_PREEMPTION', requesterId: requester.transitionId })
    expect(currentEffectivePriority(s, victim.transitionId)).toBeGreaterThan(base)
    s = acceptFacts(s, [{ predicateId: 'unrelated:material' }], true)
    expect(currentEffectivePriority(s, victim.transitionId)).toBe(base)
  })

  test('witness revision is monotonic and witness changes stale the Jev frame', () => {
    const validator = { id: 'witness:reach', version: '1' } as const
    const c = contract('reach:witness-monotonic', 'MISSION', [claim()], [], { witnessValidation: validator })
    let s = initial([c]); s = registerAdmit(s, c)
    const frame = buildJevDecisionFrame(s, { [c.transitionId]: ['path:a'] })
    s = apply(s, { kind: 'ACCEPT_WITNESS_PROOF', transitionId: c.transitionId, witnessRevision: 2, witnessRefHash: 'w:2', relationId: 'reachable', validator, capability: trustedWitnessValidator(validator.id) })
    expect(s.transitions[c.transitionId]?.witnessRevision).toBe(2)
    reject(s, { kind: 'ACCEPT_WITNESS_PROOF', transitionId: c.transitionId, witnessRevision: 1, witnessRefHash: 'w:1', relationId: 'reachable', validator, capability: trustedWitnessValidator(validator.id) }, 'WITNESS_REVISION_REGRESSION')
    expect(buildJevDecisionFrame(s, { [c.transitionId]: ['path:a'] }).frameHash).not.toBe(frame.frameHash)
  })

  test('verified snapshot rejects duplicate predicates and observation time regression', () => {
    const c = contract('facts:coherent')
    let s = initial([c])
    const duplicate = applyKernelCommand(s, { kind: 'ACCEPT_VERIFIED_SNAPSHOT', verifier, facts: [
      { predicateId: 'p', truth: 'true', valueHash: 'a' }, { predicateId: 'p', truth: 'false', valueHash: 'b' },
    ], materialChange: true, observedAtMonoMs: 0, capability: trustedVerifier(verifier.id) })
    expect(duplicate.ok).toBe(false)
    if (!duplicate.ok) expect(duplicate.reason).toBe('DUPLICATE_PREDICATE_IN_SNAPSHOT')
    s = advance(s, 10)
    s = acceptFacts(s, [{ predicateId: 'p' }])
    const regressed = applyKernelCommand(s, { kind: 'ACCEPT_VERIFIED_SNAPSHOT', verifier, facts: [{ predicateId: 'q', truth: 'true', valueHash: 'q' }], materialChange: true, observedAtMonoMs: 9, capability: trustedVerifier(verifier.id) })
    expect(regressed.ok).toBe(false)
    if (!regressed.ok) expect(regressed.reason).toBe('OBSERVATION_TIME_REGRESSION')
  })

  test('contract builder rejects unknown resource domain and undeclared effect authority', () => {
    expect(() => resourceId('plugin:anything' as never)).toThrow(/unknown resource domain/)
    expect(() => contract('effect:undeclared', 'MISSION', [claim(locomotion)], [effect('DIG', 'block:x', worldBlocks)])).toThrow(/undeclared resource authority/)
  })

  test('Jev frame carries lifecycle conflict urgency witness and authority digests', () => {
    const active = contract('mission:frame-active')
    const blocked = contract('background:frame-blocked', 'BACKGROUND', [claim(orientation)])
    let s = initial([active, blocked]); s = activate(s, active); s = activate(s, blocked)
    s = apply(s, { kind: 'PAUSE_ACTIVE', transitionId: blocked.transitionId, to: 'BLOCKED', reason: 'external' })
    const frame = buildJevDecisionFrame(s, {})
    expect(frame.activeTransitionIds).toContain(active.transitionId)
    expect(frame.blockedTransitionIds).toContain(blocked.transitionId)
    for (const digest of [frame.leaseDigest, frame.conflictDigest, frame.urgencyDigest, frame.witnessDigest, frame.factsDigest, frame.missionFrontierDigest, frame.budgetDigest, frame.progressDigest, frame.recentOutcomeDigest]) expect(digest.length).toBeGreaterThan(0)
  })
})

describe('V4.1.2 verifier authority closure', () => {
  test('VERIFY requires the contract verifier capability and cannot self-assign causal credit', () => {
    const c = contract('verify:authority')
    let s = activate(initial([c]), c)
    s = acceptFacts(s, [{ predicateId: c.desiredPredicate }])
    const forged = applyKernelCommand(s, {
      kind: 'VERIFY_SUCCESS', transitionId: c.transitionId, causalCredit: 'self', verifier,
      capability: { source: 'VERIFIER', id: verifier.id },
    } as unknown as KernelCommand)
    expect(forged.ok).toBe(false)
    if (!forged.ok) expect(forged.reason).toBe('UNTRUSTED_VERIFIER_CAPABILITY')
    const wrong = { id: verifier.id, version: 'wrong' }
    const mismatch = applyKernelCommand(s, {
      kind: 'VERIFY_SUCCESS', transitionId: c.transitionId, causalCredit: 'external', verifier: wrong,
      capability: trustedVerifier(wrong.id),
    })
    expect(mismatch.ok).toBe(false)
    if (!mismatch.ok) expect(mismatch.reason).toBe('VERIFICATION_DEFINITION_MISMATCH')
    s = apply(s, { kind: 'VERIFY_SUCCESS', transitionId: c.transitionId, causalCredit: 'external' })
    expect(s.transitions[c.transitionId]?.terminalOutcome?.kind).toBe('SUCCESS')
  })
})

describe('V4.1.2 preemption safe-yield closure', () => {
  test('preemption ACK revokes unused effects and forbids new work before atomic commit', () => {
    const victim = contract('mission:yielded-effect', 'MISSION', [claim(locomotion)], [effect('MOVE', 'move:yield', locomotion)])
    const requester = contract('viability:yielded-effect', 'VIABILITY', [claim(locomotion)])
    let s = initial([victim, requester])
    s = activate(s, victim)
    const issued = issue(s, victim, 'MOVE', 'move:yield'); s = issued.state
    s = registerAdmit(s, requester)
    s = apply(s, { kind: 'START_PREEMPTION', requesterId: requester.transitionId })
    const txId = Object.keys(s.preemptions)[0]!
    s = apply(s, { kind: 'ACK_PREEMPTION_YIELD', transactionId: txId, victimId: victim.transitionId, safeYield: true, atMonoMs: s.monotonicMs })
    expect(s.effects[issued.commitId]?.status).toBe('REVOKED')
    reject(s, { kind: 'ISSUE_EFFECT', transitionId: victim.transitionId, effect: 'MOVE', scope: 'move:yield', ttlMs: 10 }, 'TRANSITION_NOT_EFFECT_ELIGIBLE')
    reject(s, { kind: 'DEBIT_USAGE', actorTransitionId: victim.transitionId, targetTransitionId: victim.transitionId, mechanicalSteps: 1 }, 'TRANSITION_NOT_DEBITABLE')
    expect(() => assertKernelInvariants(s)).not.toThrow()
    s = apply(s, { kind: 'COMMIT_PREEMPTION', transactionId: txId })
    expect(s.transitions[requester.transitionId]?.lifecycle).toBe('ACTIVE')
  })

  test('safe-yield ACK is rejected while an irreversible dispatch is still in flight', () => {
    const victim = contract('mission:dispatching-yield', 'MISSION', [claim(locomotion)], [effect('MOVE', 'move:dispatch', locomotion)])
    const requester = contract('viability:dispatching-yield', 'VIABILITY', [claim(locomotion)])
    let s = initial([victim, requester]); s = activate(s, victim)
    const issued = issue(s, victim, 'MOVE', 'move:dispatch'); s = issued.state
    s = apply(s, { kind: 'BEGIN_EFFECT_DISPATCH', commitId: issued.commitId, capability: trustedDispatcher() })
    s = registerAdmit(s, requester); s = apply(s, { kind: 'START_PREEMPTION', requesterId: requester.transitionId })
    const txId = Object.keys(s.preemptions)[0]!
    reject(s, { kind: 'ACK_PREEMPTION_YIELD', transactionId: txId, victimId: victim.transitionId, safeYield: true, atMonoMs: s.monotonicMs }, 'EFFECT_DISPATCH_IN_FLIGHT')
  })
})

describe('V4.1.2 scheduler class/urgency/deadline closure', () => {
  test('fairness aging and urgency never cross a higher scheduling class', () => {
    const ordinary = contract('mission:max-within-class', 'MISSION', [claim(orientation)], [], { urgency: 799 })
    const critical = contract('critical:min-within-class', 'MISSION_CRITICAL', [claim(inventory)], [], { urgency: 0 })
    let s = initial([ordinary, critical])
    s = registerAdmit(s, ordinary); s = registerAdmit(s, critical)
    for (let i = 0; i < 250; i += 1) s = apply(s, { kind: 'AGE_RUNNABLE', transitionId: ordinary.transitionId })
    expect(s.transitions[ordinary.transitionId]?.starvationAge).toBe(199)
    expect(currentEffectivePriority(s, ordinary.transitionId)).toBeLessThan(currentEffectivePriority(s, critical.transitionId))
  })

  test('explicit urgency orders peers without changing class authority', () => {
    const low = contract('mission:urgency-low', 'MISSION', [claim(orientation)], [], { urgency: 10 })
    const high = contract('mission:urgency-high', 'MISSION', [claim(inventory)], [], { urgency: 500 })
    let s = initial([low, high]); s = registerAdmit(s, low); s = registerAdmit(s, high)
    expect(currentEffectivePriority(s, high.transitionId)).toBeGreaterThan(currentEffectivePriority(s, low.transitionId))
  })

  test('earlier deadline is a bounded tie-break inside the same class/urgency/age', () => {
    const early = contract('mission:deadline-early', 'MISSION', [claim(orientation)], [], { urgency: 100, budget: { maxActiveMs: 1000, deadlineAtMonoMs: 100, maxMechanicalSteps: 100, resources: {}, risk: {} } })
    const late = contract('mission:deadline-late', 'MISSION', [claim(inventory)], [], { urgency: 100, budget: { maxActiveMs: 1000, deadlineAtMonoMs: 200, maxMechanicalSteps: 100, resources: {}, risk: {} } })
    let s = initial([early, late]); s = registerAdmit(s, early); s = registerAdmit(s, late)
    expect(currentEffectivePriority(s, early.transitionId)).toBeGreaterThan(currentEffectivePriority(s, late.transitionId))
  })
})

describe('V4.1.2 effect causal evidence closure', () => {
  test('a current trusted but unrelated fact cannot reconcile another effect', () => {
    const c = contract('effect:causal-binding', 'MISSION', [claim(worldBlocks)], [effect('DIG', 'block:causal', worldBlocks, 2)])
    let s = activate(initial([c]), c)
    const issued = issue(s, c, 'DIG', 'block:causal'); s = issued.state
    s = apply(s, { kind: 'BEGIN_EFFECT_DISPATCH', commitId: issued.commitId })
    s = acceptFacts(s, [{ predicateId: 'world:still-daylight' }])
    const unrelatedFactId = Object.keys(s.facts).at(-1)!
    reject(s, {
      kind: 'RECONCILE_EFFECT', commitId: issued.commitId, observation: 'OCCURRED',
      factIds: [unrelatedFactId], verifier, capability: trustedVerifier(verifier.id),
    }, 'EFFECT_CAUSAL_EVIDENCE_REQUIRED')
    s = acceptFacts(s, [{ predicateId: 'effect:dig:causal', effectCommitId: issued.commitId }])
    const directFactId = Object.keys(s.facts).at(-1)!
    s = apply(s, {
      kind: 'RECONCILE_EFFECT', commitId: issued.commitId, observation: 'OCCURRED',
      factIds: [directFactId], verifier, capability: trustedVerifier(verifier.id),
    })
    expect(s.effects[issued.commitId]?.status).toBe('OBSERVED')
  })
})

describe('V4.1.2 progress and Jev live-projection closure', () => {
  test('progress report requires the contract-bound registered evaluator and monotonic revision', () => {
    const c = contract('search:progress')
    let s = initial([c]); s = registerAdmit(s, c)
    const forged = applyKernelCommand(s, {
      kind: 'REPORT_PROGRESS', transitionId: c.transitionId, progressRevision: 1,
      valueHash: 'progress:1', observedAtMonoMs: s.monotonicMs, evaluator: progress,
      capability: { source: 'PROGRESS', id: progress.id },
    } as unknown as KernelCommand)
    expect(forged.ok).toBe(false)
    if (!forged.ok) expect(forged.reason).toBe('UNTRUSTED_PROGRESS_CAPABILITY')
    s = apply(s, { kind: 'REPORT_PROGRESS', transitionId: c.transitionId, progressRevision: 1, valueHash: 'progress:1', observedAtMonoMs: s.monotonicMs })
    expect(s.transitions[c.transitionId]?.progressRevision).toBe(1)
    expect(s.transitions[c.transitionId]?.progressValueHash).toBe('progress:1')
    reject(s, { kind: 'REPORT_PROGRESS', transitionId: c.transitionId, progressRevision: 1, valueHash: 'progress:replay', observedAtMonoMs: s.monotonicMs }, 'PROGRESS_REVISION_NOT_NEXT')
  })

  test('old Jev frame is stale after progress changes without binding or scheduler epoch changes', () => {
    const c = contract('search:jev-progress')
    let s = initial([c]); s = registerAdmit(s, c)
    const frame = buildJevDecisionFrame(s, { [c.transitionId]: ['scan:left'] })
    const decision = { frameHash: frame.frameHash, schedulerEpoch: frame.schedulerEpoch, world: frame.world, binding: frame.binding, rankedTransitionIds: [c.transitionId], tacticChoices: { [c.transitionId]: 'scan:left' } }
    s = apply(s, { kind: 'REPORT_PROGRESS', transitionId: c.transitionId, progressRevision: 1, valueHash: 'frontier:1', observedAtMonoMs: s.monotonicMs })
    expect(currentBinding(s)).toEqual(frame.binding)
    expect(s.schedulerEpoch).toBe(frame.schedulerEpoch)
    expect(admitJevDecision(s, frame, decision)).toEqual({ ok: false, reason: 'STALE_FRAME_STATE' })
  })

  test('old Jev frame is stale after effect commit state changes at the same binding', () => {
    const c = contract('dig:jev-effect', 'MISSION', [claim(worldBlocks)], [effect('DIG', 'block:jev-effect', worldBlocks, 2)])
    let s = activate(initial([c]), c)
    const frame = buildJevDecisionFrame(s, {})
    const decision = { frameHash: frame.frameHash, schedulerEpoch: frame.schedulerEpoch, world: frame.world, binding: frame.binding, rankedTransitionIds: [], tacticChoices: {} }
    const issued = issue(s, c, 'DIG', 'block:jev-effect'); s = issued.state
    expect(currentBinding(s)).toEqual(frame.binding)
    expect(s.schedulerEpoch).toBe(frame.schedulerEpoch)
    expect(admitJevDecision(s, frame, decision)).toEqual({ ok: false, reason: 'STALE_FRAME_STATE' })
  })
})

// Minimized adversarial traces from the V4.1.2 closure audit.
//
// K1 (preempting a victim that starts quiescing after the plan) is fenced:
// REQUEST_CANCEL / VERIFY_SUCCESS bump registryRevision, which is part of the
// plan's binding, so the transaction goes STALE and ACK/COMMIT fail closed.
// These cases pin that dependency: removing registryRevision from the binding
// (a tempting "over-fencing" cleanup) would re-open K1.
//
// K2 (generation change while a transition is quiescing) reached a state the
// reducer's own `assertKernelInvariants` rejects; the fix honors the requested
// terminal instead of suspending with pending control state.
describe('V4.1.2 minimized counterexamples', () => {
  function quiescingVictimSetup(): { s: KernelState; victim: CanonicalTransitionContract; requester: CanonicalTransitionContract; txId: string } {
    const victim = contract('critical:quiesce', 'MISSION', [claim(inventory, 'EXCLUSIVE_WRITE', { preemptible: false, maxNonPreemptibleMs: 50 })])
    const requester = contract('viability:quiesce', 'VIABILITY', [claim(inventory)])
    let s = initial([victim, requester]); s = activate(s, victim); s = registerAdmit(s, requester)
    s = apply(s, { kind: 'START_PREEMPTION', requesterId: requester.transitionId })
    return { s, victim, requester, txId: Object.keys(s.preemptions)[0]! }
  }

  test('K1a: a victim that starts quiescing (cancel) after the preemption plan cannot be preempted mid critical section', () => {
    const { s: planned, victim, txId } = quiescingVictimSetup()
    const s = apply(planned, { kind: 'REQUEST_CANCEL', transitionId: victim.transitionId, reason: 'operator stop' })
    expect(s.transitions[victim.transitionId]?.cancelRequested).toBe(true)
    reject(s, { kind: 'ACK_PREEMPTION_YIELD', transactionId: txId, victimId: victim.transitionId, safeYield: true, atMonoMs: s.monotonicMs }, 'STALE_PREEMPTION')
  })

  test('K1b: a victim holding a pending verified SUCCESS cannot be preempted into SUSPENDED', () => {
    const { s: planned, victim, txId } = quiescingVictimSetup()
    let s = acceptFacts(planned, [{ predicateId: victim.desiredPredicate }])
    s = apply(s, { kind: 'VERIFY_SUCCESS', transitionId: victim.transitionId, causalCredit: 'self' })
    expect(s.transitions[victim.transitionId]?.pendingTerminalOutcome?.kind).toBe('SUCCESS')
    reject(s, { kind: 'ACK_PREEMPTION_YIELD', transactionId: txId, victimId: victim.transitionId, safeYield: true, atMonoMs: s.monotonicMs }, 'STALE_PREEMPTION')
  })

  test('K1c: an already-acknowledged plan cannot commit once its victim starts quiescing', () => {
    const { s: planned, victim, txId } = quiescingVictimSetup()
    let s = apply(planned, { kind: 'ACK_PREEMPTION_YIELD', transactionId: txId, victimId: victim.transitionId, safeYield: true, atMonoMs: planned.monotonicMs })
    s = apply(s, { kind: 'REQUEST_CANCEL', transitionId: victim.transitionId, reason: 'operator stop' })
    reject(s, { kind: 'COMMIT_PREEMPTION', transactionId: txId }, 'STALE_PREEMPTION')
  })

  test('K2: a generation change honors a quiescing transition\'s requested terminal instead of suspending it', () => {
    const cancelled = contract('critical:gen-cancel', 'MISSION', [claim(inventory, 'EXCLUSIVE_WRITE', { preemptible: false, maxNonPreemptibleMs: 50 })])
    const verified = contract('critical:gen-verified', 'MISSION', [claim(locomotion, 'EXCLUSIVE_WRITE', { preemptible: false, maxNonPreemptibleMs: 50 })])
    let s = initial([cancelled, verified]); s = activate(s, cancelled); s = activate(s, verified)
    s = apply(s, { kind: 'REQUEST_CANCEL', transitionId: cancelled.transitionId, reason: 'operator stop' })
    s = acceptFacts(s, [{ predicateId: verified.desiredPredicate }])
    s = apply(s, { kind: 'VERIFY_SUCCESS', transitionId: verified.transitionId, causalCredit: 'self' })
    s = apply(s, { kind: 'CHANGE_GENERATION', generationId: 'gen-b', capability: trustedWorldAdapter('runtime') })
    expect(s.transitions[cancelled.transitionId]?.lifecycle).toBe('TERMINAL')
    expect(s.transitions[cancelled.transitionId]?.terminalOutcome?.kind).toBe('CANCELED')
    expect(s.transitions[verified.transitionId]?.lifecycle).toBe('TERMINAL')
    expect(s.transitions[verified.transitionId]?.terminalOutcome?.kind).toBe('SUCCESS')
    expect(Object.keys(s.leases)).toHaveLength(0)
  })
})
