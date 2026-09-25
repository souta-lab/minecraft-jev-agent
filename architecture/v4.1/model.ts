// V4.1 deterministic architecture model. No Minecraft runtime imports.
// Semantic Transition identity is independent of controller generation and
// temporary resource leases so suspend/resume preserves contract identity.

export type TransitionId = string
export type ContractHash = string
export type PredicateId = string
export type ResourceKey = string
export type ResourcePath = readonly string[]
export type FactId = string

export interface WorldIdentity {
  readonly serverId: string
  readonly dimension: string
  readonly worldEpoch: number
}

export interface RuntimeBinding {
  readonly generationId: string
  readonly factRevision: number
  readonly registryRevision: number
  readonly missionRevision: number
}

export type TransitionClass = 'VIABILITY' | 'MISSION_CRITICAL' | 'MISSION' | 'BACKGROUND'
export type LeaseMode = 'SHARED_READ' | 'APPEND' | 'EXCLUSIVE_WRITE'
export type TransitionLifecycle =
  | 'ENABLED'
  | 'RUNNABLE'
  | 'ACTIVE'
  | 'SUSPENDED'
  | 'OBSERVING'
  | 'BLOCKED'
  | 'TERMINAL'

export type EffectKind =
  | 'MOVE'
  | 'LOOK'
  | 'INTERACT'
  | 'ATTACK'
  | 'INVENTORY_MUTATION'
  | 'EQUIP'
  | 'DIG'
  | 'PLACE'
  | 'CONSUME'
  | 'CRAFT'
  | 'STATION_MUTATION'
  | 'COMMAND'

export interface ResourceClaim {
  readonly resource: ResourceKey
  readonly mode: LeaseMode
  readonly preemptible: boolean
  readonly resumable: boolean
  readonly maxNonPreemptibleMs: number | null
}

export interface EffectPermit {
  readonly kind: EffectKind
  readonly scope: string
  readonly irreversible: boolean
  readonly maxCount: number
}

export interface TransitionBudget {
  readonly maxActiveMs: number
  readonly deadlineAtMs: number | null
  readonly maxMechanicalSteps: number
  readonly resources: Readonly<Record<string, number>>
  readonly risk: Readonly<Record<string, number>>
}

export interface TransitionContract {
  readonly transitionId: TransitionId
  readonly contractHash: ContractHash
  readonly family: string
  readonly class: TransitionClass
  readonly world: WorldIdentity
  readonly desiredPredicate: PredicateId
  readonly requires: readonly PredicateId[]
  readonly invariants: readonly PredicateId[]
  readonly claims: readonly ResourceClaim[]
  readonly effects: readonly EffectPermit[]
  readonly budget: TransitionBudget
  readonly progressDefinition: string
}

export type SuspendReason = 'PREEMPTED' | 'LEASE_YIELD' | 'GENERATION_REBIND_REQUIRED'
export type BlockReason =
  | 'WAITING_RESOURCE'
  | 'WAITING_DEPENDENCY'
  | 'WAITING_EXTERNAL'
  | 'WAITING_POLICY'
  | 'WAITING_OBSERVATION'

export interface ResourceLease {
  readonly owner: TransitionId
  readonly resource: ResourceKey
  readonly mode: LeaseMode
  readonly grantedAtEpoch: number
  readonly preemptible: boolean
  readonly maxNonPreemptibleMs: number | null
}

export interface TransitionUsage {
  readonly activeMs: number
  readonly mechanicalSteps: number
  readonly resources: Readonly<Record<string, number>>
  readonly risk: Readonly<Record<string, number>>
}

export interface TransitionRuntimeState {
  readonly transitionId: TransitionId
  readonly contractHash: ContractHash
  readonly lifecycle: TransitionLifecycle
  readonly semanticOwner: true
  readonly binding: RuntimeBinding
  readonly heldResources: readonly ResourceKey[]
  readonly suspendReason: SuspendReason | null
  readonly blockReason: BlockReason | null
  readonly starvationAge: number
  readonly witnessRevision: number
  readonly usage: TransitionUsage
  readonly terminalOutcome: TransitionOutcome | null
}

export type TransitionOutcome =
  | { readonly kind: 'SUCCESS'; readonly factId: FactId; readonly causalCredit: 'self' | 'shared' | 'external' }
  | { readonly kind: 'INFEASIBLE'; readonly reason: string }
  | { readonly kind: 'FAILED_MECHANICALLY'; readonly reason: string }
  | { readonly kind: 'RESOURCE_EXHAUSTED'; readonly resource: string }
  | { readonly kind: 'RISK_BUDGET_EXHAUSTED'; readonly risk: string }
  | { readonly kind: 'DEADLINE_EXPIRED' }
  | { readonly kind: 'WORLD_CHANGED'; readonly expected: WorldIdentity; readonly observed: WorldIdentity }
  | { readonly kind: 'MISSION_SUPERSEDED'; readonly missionRevision: number }
  | { readonly kind: 'CANCELED'; readonly reason: string }
  | { readonly kind: 'RUNTIME_FAULT'; readonly reason: string }

export interface VerifiedFact<T = unknown> {
  readonly factId: FactId
  readonly predicateId: PredicateId
  readonly value: T
  readonly truth: 'true' | 'false' | 'unknown'
  readonly world: WorldIdentity
  readonly factRevision: number
  readonly observedAtMs: number
  readonly provenance: string
}

export interface PredicateVerification {
  readonly predicateId: PredicateId
  readonly factRevision: number
  readonly world: WorldIdentity
  readonly evidenceId: string
  readonly truth: 'true'
}

export interface VerificationEvidence {
  readonly transitionId: TransitionId
  readonly contractHash: ContractHash
  readonly binding: RuntimeBinding
  readonly fact: VerifiedFact
  readonly deterministic: true
  readonly causalCredit: 'self' | 'shared' | 'external'
  readonly requiresVerified: readonly PredicateVerification[]
  readonly invariantsVerified: readonly PredicateVerification[]
}

export interface ResumeProof {
  readonly transitionId: TransitionId
  readonly contractHash: ContractHash
  readonly world: WorldIdentity
  readonly binding: RuntimeBinding
  readonly witnessRevision: number
  readonly registryContainsTransition: true
  readonly missionAuthorizesPredicate: true
  readonly requiresVerified: readonly PredicateVerification[]
  readonly invariantsVerified: readonly PredicateVerification[]
}

export interface ActiveTransitionRegistry {
  readonly revision: number
  readonly transitions: ReadonlyMap<TransitionId, TransitionRuntimeState>
}

export interface ViabilityState {
  readonly stable: boolean
  readonly violatedInvariants: readonly PredicateId[]
  readonly incidentId: string | null
  readonly deadlineAtMs: number | null
}

export interface SchedulerFrame {
  readonly schedulerEpoch: number
  readonly nowMs: number
  readonly world: WorldIdentity
  readonly binding: RuntimeBinding
  readonly registry: ActiveTransitionRegistry
  readonly leases: readonly ResourceLease[]
  readonly viability: ViabilityState
}

export interface JevDecisionFrameV41 {
  readonly frameHash: string
  readonly schedulerEpoch: number
  readonly world: WorldIdentity
  readonly binding: RuntimeBinding
  readonly enabledTransitionIds: readonly TransitionId[]
  readonly activeTransitionIds: readonly TransitionId[]
  readonly suspendedTransitionIds: readonly TransitionId[]
  readonly conflicts: readonly string[]
}

export interface JevDecisionV41 {
  readonly frameHash: string
  readonly schedulerEpoch: number
  readonly binding: RuntimeBinding
  readonly rankedTransitionIds: readonly TransitionId[]
  readonly tacticChoices: Readonly<Record<TransitionId, string>>
}

export type SchedulerDecision =
  | { readonly kind: 'GRANT'; readonly transitionId: TransitionId; readonly resources: readonly ResourceKey[] }
  | { readonly kind: 'PREEMPT'; readonly transitionId: TransitionId; readonly by: TransitionId }
  | { readonly kind: 'RESUME'; readonly transitionId: TransitionId }
  | { readonly kind: 'SUSPEND'; readonly transitionId: TransitionId; readonly reason: SuspendReason }
  | { readonly kind: 'OBSERVE'; readonly transitionId: TransitionId }
  | { readonly kind: 'BLOCK'; readonly transitionId: TransitionId; readonly reason: BlockReason }
  | { readonly kind: 'NOOP'; readonly reason: string }

export interface EffectCommitToken {
  readonly commitId: string
  readonly transitionId: TransitionId
  readonly contractHash: ContractHash
  readonly effect: EffectKind
  readonly scope: string
  readonly world: WorldIdentity
  readonly binding: RuntimeBinding
  readonly leaseFingerprint: string
  readonly permitKey: string
  readonly expiresAtMs: number
}

export type PreemptionPhase =
  | 'PREEMPT_REQUESTED'
  | 'WAITING_BOUNDED_SECTION'
  | 'YIELD_ACKNOWLEDGED'
  | 'LEASES_REVOKED'
  | 'SUSPENDED'
  | 'GRANTED'
  | 'DEADLINE_EXPIRED'

export interface PreemptionTransaction {
  readonly transactionId: string
  readonly victim: TransitionId
  readonly requester: TransitionId
  readonly phase: PreemptionPhase
  readonly requestedAtMs: number
  readonly yieldDeadlineAtMs: number
  readonly conflictResources: readonly ResourceKey[]
  readonly priorityInherited: boolean
}

export function sameWorld(a: WorldIdentity, b: WorldIdentity): boolean {
  return a.serverId === b.serverId && a.dimension === b.dimension && a.worldEpoch === b.worldEpoch
}

export function leaseModesConflict(a: LeaseMode, b: LeaseMode): boolean {
  return a === 'EXCLUSIVE_WRITE' || b === 'EXCLUSIVE_WRITE'
}

export function resourcePath(resource: ResourceKey): ResourcePath {
  const parts = resource.split(/[.:@/]+/g).map((part) => part.trim()).filter(Boolean)
  if (parts.length === 0) throw new Error('resource key must contain at least one path segment')
  return parts
}

export function resourcePathsOverlap(a: ResourceKey, b: ResourceKey): boolean {
  const left = resourcePath(a)
  const right = resourcePath(b)
  const n = Math.min(left.length, right.length)
  for (let i = 0; i < n; i += 1) if (left[i] !== right[i]) return false
  return true
}

export function claimsConflict(a: ResourceClaim, b: ResourceClaim): boolean {
  return resourcePathsOverlap(a.resource, b.resource) && leaseModesConflict(a.mode, b.mode)
}

export function canonicalClaims(claims: readonly ResourceClaim[]): readonly ResourceClaim[] {
  return [...claims].sort((left, right) => left.resource.localeCompare(right.resource))
}

export function conflictingLeases(
  requester: TransitionId,
  claims: readonly ResourceClaim[],
  leases: readonly ResourceLease[],
): readonly ResourceLease[] {
  return leases.filter((lease) => {
    if (lease.owner === requester) return false
    return claims.some((claim) => resourcePathsOverlap(claim.resource, lease.resource) && leaseModesConflict(claim.mode, lease.mode))
  })
}

/** Atomic bundle acquisition: all claims are granted or none are. */
export function grantLeaseBundle(
  owner: TransitionId,
  claims: readonly ResourceClaim[],
  leases: readonly ResourceLease[],
  schedulerEpoch: number,
): { readonly ok: true; readonly leases: readonly ResourceLease[] } | { readonly ok: false; readonly conflicts: readonly ResourceLease[] } {
  const ordered = canonicalClaims(claims)
  for (const claim of ordered) {
    if (!claim.preemptible && (claim.maxNonPreemptibleMs === null || !Number.isFinite(claim.maxNonPreemptibleMs) || claim.maxNonPreemptibleMs <= 0)) {
      throw new Error(`non-preemptible claim ${claim.resource} requires a finite positive maxNonPreemptibleMs`)
    }
  }
  const conflicts = conflictingLeases(owner, ordered, leases)
  if (conflicts.length > 0) return { ok: false, conflicts }
  const retained = leases.filter((lease) => lease.owner !== owner)
  const granted = ordered.map<ResourceLease>((claim) => ({
    owner,
    resource: claim.resource,
    mode: claim.mode,
    grantedAtEpoch: schedulerEpoch,
    preemptible: claim.preemptible,
    maxNonPreemptibleMs: claim.maxNonPreemptibleMs,
  }))
  return { ok: true, leases: [...retained, ...granted] }
}

export function releaseTransitionLeases(
  transitionId: TransitionId,
  leases: readonly ResourceLease[],
): readonly ResourceLease[] {
  return leases.filter((lease) => lease.owner !== transitionId)
}

export function suspendTransition(
  state: TransitionRuntimeState,
  reason: SuspendReason,
): TransitionRuntimeState {
  if (state.lifecycle === 'TERMINAL') return state
  return {
    ...state,
    lifecycle: 'SUSPENDED',
    heldResources: [],
    suspendReason: reason,
    blockReason: null,
  }
}

export type ResumeResult =
  | { readonly ok: true; readonly state: TransitionRuntimeState }
  | { readonly ok: false; readonly reason: 'WORLD_CHANGED' | 'STALE_REBIND' | 'TERMINAL' | 'INVALID_LIFECYCLE' | 'CONTRACT_MISMATCH' | 'PROOF_INCOMPLETE' }

function coversAtBinding(
  required: readonly PredicateId[],
  verified: readonly PredicateVerification[],
  binding: RuntimeBinding,
  world: WorldIdentity,
): boolean {
  return required.every((predicate) => verified.some((proof) =>
    proof.predicateId === predicate && proof.evidenceId.trim().length > 0 && proof.truth === 'true' && proof.factRevision === binding.factRevision && sameWorld(proof.world, world),
  ))
}

export function runtimeBindingEqual(a: RuntimeBinding, b: RuntimeBinding): boolean {
  return a.generationId === b.generationId && a.factRevision === b.factRevision &&
    a.registryRevision === b.registryRevision && a.missionRevision === b.missionRevision
}

export function resumeTransition(
  state: TransitionRuntimeState,
  contract: TransitionContract,
  proof: ResumeProof,
  liveWorld: WorldIdentity,
  liveBinding: RuntimeBinding,
): ResumeResult {
  if (state.lifecycle === 'TERMINAL') return { ok: false, reason: 'TERMINAL' }
  if (state.lifecycle !== 'SUSPENDED' && state.lifecycle !== 'BLOCKED' && state.lifecycle !== 'OBSERVING') return { ok: false, reason: 'INVALID_LIFECYCLE' }
  if (state.transitionId !== contract.transitionId || state.contractHash !== contract.contractHash ||
      proof.transitionId !== contract.transitionId || proof.contractHash !== contract.contractHash) {
    return { ok: false, reason: 'CONTRACT_MISMATCH' }
  }
  if (!sameWorld(contract.world, proof.world) || !sameWorld(proof.world, liveWorld)) return { ok: false, reason: 'WORLD_CHANGED' }
  if (!runtimeBindingEqual(proof.binding, liveBinding)) return { ok: false, reason: 'STALE_REBIND' }
  if (proof.registryContainsTransition !== true || proof.missionAuthorizesPredicate !== true) return { ok: false, reason: 'PROOF_INCOMPLETE' }
  if (proof.binding.factRevision < state.binding.factRevision ||
      proof.binding.registryRevision < state.binding.registryRevision ||
      proof.binding.missionRevision < state.binding.missionRevision) {
    return { ok: false, reason: 'STALE_REBIND' }
  }
  if (proof.witnessRevision < state.witnessRevision) return { ok: false, reason: 'STALE_REBIND' }
  if (!coversAtBinding(contract.requires, proof.requiresVerified, proof.binding, proof.world) ||
      !coversAtBinding(contract.invariants, proof.invariantsVerified, proof.binding, proof.world)) {
    return { ok: false, reason: 'PROOF_INCOMPLETE' }
  }
  return {
    ok: true,
    state: {
      ...state,
      lifecycle: 'RUNNABLE',
      binding: proof.binding,
      witnessRevision: proof.witnessRevision,
      heldResources: [],
      suspendReason: null,
      blockReason: null,
    },
  }
}

export function observeTransition(state: TransitionRuntimeState): TransitionRuntimeState {
  if (state.lifecycle === 'TERMINAL') return state
  return { ...state, lifecycle: 'OBSERVING', heldResources: [], suspendReason: null, blockReason: null }
}

export function blockTransition(state: TransitionRuntimeState, reason: BlockReason): TransitionRuntimeState {
  if (state.lifecycle === 'TERMINAL') return state
  return { ...state, lifecycle: 'BLOCKED', heldResources: [], suspendReason: null, blockReason: reason }
}

export function activateTransition(
  state: TransitionRuntimeState,
  heldResources: readonly ResourceKey[],
): TransitionRuntimeState {
  if (state.lifecycle === 'TERMINAL') return state
  return {
    ...state,
    lifecycle: 'ACTIVE',
    heldResources: [...heldResources].sort(),
    suspendReason: null,
    blockReason: null,
    starvationAge: 0,
  }
}

/** Action completion is deliberately absent from this API. Only verified facts close SUCCESS. */
export function verifyTransitionSuccess(
  contract: TransitionContract,
  state: TransitionRuntimeState,
  evidence: VerificationEvidence,
  liveWorld: WorldIdentity,
  liveBinding: RuntimeBinding,
): TransitionRuntimeState {
  if (state.lifecycle === 'TERMINAL') return state
  if (evidence.deterministic !== true) return state
  if (state.transitionId !== contract.transitionId || state.contractHash !== contract.contractHash) return state
  if (evidence.transitionId !== state.transitionId || evidence.contractHash !== state.contractHash) return state
  if (!runtimeBindingEqual(evidence.binding, state.binding) || !runtimeBindingEqual(evidence.binding, liveBinding)) return state
  if (!sameWorld(contract.world, evidence.fact.world) || !sameWorld(evidence.fact.world, liveWorld)) return state
  if (evidence.fact.factRevision !== evidence.binding.factRevision) return state
  if (!coversAtBinding(contract.requires, evidence.requiresVerified, evidence.binding, evidence.fact.world) ||
      !coversAtBinding(contract.invariants, evidence.invariantsVerified, evidence.binding, evidence.fact.world)) return state
  if (evidence.fact.predicateId !== contract.desiredPredicate) return state
  if (evidence.fact.truth !== 'true') return state
  const outcome: TransitionOutcome = {
    kind: 'SUCCESS',
    factId: evidence.fact.factId,
    causalCredit: evidence.causalCredit,
  }
  return {
    ...state,
    lifecycle: 'TERMINAL',
    heldResources: [],
    suspendReason: null,
    blockReason: null,
    terminalOutcome: outcome,
  }
}

export function jevDecisionIsCurrent(
  frame: JevDecisionFrameV41,
  decision: JevDecisionV41,
  liveBinding: RuntimeBinding,
  liveSchedulerEpoch: number,
): boolean {
  return (
    decision.frameHash === frame.frameHash &&
    decision.schedulerEpoch === frame.schedulerEpoch &&
    decision.schedulerEpoch === liveSchedulerEpoch &&
    runtimeBindingEqual(frame.binding, decision.binding) &&
    runtimeBindingEqual(decision.binding, liveBinding)
  )
}

const CLASS_PRIORITY: Readonly<Record<TransitionClass, number>> = {
  VIABILITY: 400,
  MISSION_CRITICAL: 300,
  MISSION: 200,
  BACKGROUND: 100,
}

/** Fairness aging is mechanical scheduling policy, not semantic goal selection. */
export function effectiveSchedulingPriority(
  contract: TransitionContract,
  state: TransitionRuntimeState,
  urgency: number,
): number {
  const boundedUrgency = Math.max(0, Math.min(99, urgency))
  const boundedAge = Math.max(0, Math.min(199, state.starvationAge))
  return CLASS_PRIORITY[contract.class] + boundedUrgency + boundedAge
}

export function chooseResourceWinner(
  candidates: readonly { contract: TransitionContract; state: TransitionRuntimeState; urgency: number }[],
): TransitionId | null {
  if (candidates.length === 0) return null
  return [...candidates]
    .sort((a, b) => {
      const delta = effectiveSchedulingPriority(b.contract, b.state, b.urgency) - effectiveSchedulingPriority(a.contract, a.state, a.urgency)
      return delta !== 0 ? delta : a.contract.transitionId.localeCompare(b.contract.transitionId)
    })[0]?.contract.transitionId ?? null
}

export function ageRunnable(state: TransitionRuntimeState): TransitionRuntimeState {
  if (state.lifecycle !== 'RUNNABLE' && state.lifecycle !== 'BLOCKED') return state
  return { ...state, starvationAge: Math.min(199, state.starvationAge + 1) }
}

export function initialRuntimeState(
  contract: TransitionContract,
  binding: RuntimeBinding,
  lifecycle: TransitionLifecycle = 'RUNNABLE',
): TransitionRuntimeState {
  return {
    transitionId: contract.transitionId,
    contractHash: contract.contractHash,
    lifecycle,
    semanticOwner: true,
    binding,
    heldResources: [],
    suspendReason: null,
    blockReason: null,
    starvationAge: 0,
    witnessRevision: 0,
    usage: { activeMs: 0, mechanicalSteps: 0, resources: {}, risk: {} },
    terminalOutcome: null,
  }
}

export function permitKey(kind: EffectKind, scope: string): string {
  return `${kind}:${scope}`
}

export function leaseBindingFingerprint(owner: TransitionId, leases: readonly ResourceLease[]): string {
  return leases.filter((lease) => lease.owner === owner)
    .map((lease) => `${lease.resource}|${lease.mode}|${lease.grantedAtEpoch}|${lease.preemptible}|${lease.maxNonPreemptibleMs ?? 'none'}`)
    .sort().join(';;')
}

export function effectCommitIsCurrent(
  token: EffectCommitToken,
  contract: TransitionContract,
  state: TransitionRuntimeState,
  world: WorldIdentity,
  liveBinding: RuntimeBinding,
  leases: readonly ResourceLease[],
  nowMs: number,
): boolean {
  const permit = contract.effects.find((candidate) => candidate.kind === token.effect && candidate.scope === token.scope)
  return (
    state.lifecycle === 'ACTIVE' &&
    token.transitionId === state.transitionId && token.transitionId === contract.transitionId &&
    token.contractHash === state.contractHash && token.contractHash === contract.contractHash &&
    sameWorld(token.world, world) && sameWorld(contract.world, world) &&
    runtimeBindingEqual(token.binding, liveBinding) && runtimeBindingEqual(state.binding, liveBinding) &&
    token.leaseFingerprint === leaseBindingFingerprint(state.transitionId, leases) &&
    permit !== undefined && token.permitKey === permitKey(permit.kind, permit.scope) &&
    token.expiresAtMs >= nowMs
  )
}

export function createRegistry(states: readonly TransitionRuntimeState[] = []): ActiveTransitionRegistry {
  const transitions = new Map<TransitionId, TransitionRuntimeState>()
  for (const state of states) {
    const existing = transitions.get(state.transitionId)
    if (existing !== undefined && existing.contractHash !== state.contractHash) {
      throw new Error('ATR initialization contains duplicate transitionId with different contractHash')
    }
    transitions.set(state.transitionId, state)
  }
  return { revision: 0, transitions }
}

export function putTransition(registry: ActiveTransitionRegistry, state: TransitionRuntimeState): ActiveTransitionRegistry {
  const existing = registry.transitions.get(state.transitionId)
  if (existing !== undefined && existing.contractHash !== state.contractHash) {
    throw new Error('ATR put cannot replace a semantic owner with a different contractHash')
  }
  const transitions = new Map(registry.transitions)
  transitions.set(state.transitionId, state)
  return { revision: registry.revision + 1, transitions }
}

export function mutateTransition(
  registry: ActiveTransitionRegistry,
  transitionId: TransitionId,
  mutate: (state: TransitionRuntimeState) => TransitionRuntimeState,
): ActiveTransitionRegistry {
  const current = registry.transitions.get(transitionId)
  if (current === undefined) return registry
  const next = mutate(current)
  if (next.transitionId !== transitionId || next.contractHash !== current.contractHash) {
    throw new Error('ATR mutation cannot change semantic identity')
  }
  return putTransition(registry, next)
}

export function removeTransition(registry: ActiveTransitionRegistry, transitionId: TransitionId): ActiveTransitionRegistry {
  if (!registry.transitions.has(transitionId)) return registry
  const transitions = new Map(registry.transitions)
  transitions.delete(transitionId)
  return { revision: registry.revision + 1, transitions }
}

export function requestPreemption(
  transactionId: string,
  victim: TransitionId,
  requester: TransitionId,
  requesterClaims: readonly ResourceClaim[],
  leases: readonly ResourceLease[],
  requestedAtMs: number,
  preemptibleYieldBudgetMs: number,
): PreemptionTransaction | null {
  const conflicts = conflictingLeases(requester, requesterClaims, leases).filter((lease) => lease.owner === victim)
  if (conflicts.length === 0) return null
  const bounded = conflicts.some((lease) => !lease.preemptible)
  const bounds = conflicts.filter((lease) => !lease.preemptible).map((lease) => lease.maxNonPreemptibleMs)
  if (bounds.some((bound) => bound === null || !Number.isFinite(bound) || Number(bound) <= 0)) {
    throw new Error('non-preemptible lease requires a finite positive maxNonPreemptibleMs')
  }
  const waitMs = bounded ? Math.max(...bounds.map(Number)) : preemptibleYieldBudgetMs
  if (!Number.isFinite(waitMs) || waitMs <= 0) throw new Error('preemption yield budget must be finite and positive')
  return {
    transactionId, victim, requester,
    phase: bounded ? 'WAITING_BOUNDED_SECTION' : 'PREEMPT_REQUESTED',
    requestedAtMs, yieldDeadlineAtMs: requestedAtMs + waitMs,
    conflictResources: conflicts.map((lease) => lease.resource).sort(),
    priorityInherited: bounded,
  }
}

export function acknowledgePreemptionYield(
  tx: PreemptionTransaction,
  nowMs: number,
  safeYield: boolean,
): PreemptionTransaction {
  if (tx.phase === 'GRANTED' || tx.phase === 'DEADLINE_EXPIRED') return tx
  if (nowMs > tx.yieldDeadlineAtMs) return { ...tx, phase: 'DEADLINE_EXPIRED', priorityInherited: true }
  if (!safeYield) return tx
  return { ...tx, phase: 'YIELD_ACKNOWLEDGED' }
}

export function revokePreemptionLeases(
  tx: PreemptionTransaction,
  leases: readonly ResourceLease[],
): { readonly transaction: PreemptionTransaction; readonly leases: readonly ResourceLease[] } {
  if (tx.phase !== 'YIELD_ACKNOWLEDGED') throw new Error('safe yield acknowledgement required before lease revocation')
  return { transaction: { ...tx, phase: 'LEASES_REVOKED' }, leases: releaseTransitionLeases(tx.victim, leases) }
}

export function suspendPreemptionVictim(
  tx: PreemptionTransaction,
  victimState: TransitionRuntimeState,
): { readonly transaction: PreemptionTransaction; readonly victimState: TransitionRuntimeState } {
  if (tx.phase !== 'LEASES_REVOKED') throw new Error('leases must be revoked before victim suspension')
  if (victimState.transitionId !== tx.victim) throw new Error('preemption victim state does not match transaction victim')
  return { transaction: { ...tx, phase: 'SUSPENDED' }, victimState: suspendTransition(victimState, 'PREEMPTED') }
}

export function grantPreemptionRequester(
  tx: PreemptionTransaction,
  requesterClaims: readonly ResourceClaim[],
  leases: readonly ResourceLease[],
  schedulerEpoch: number,
): { readonly ok: true; readonly transaction: PreemptionTransaction; readonly leases: readonly ResourceLease[] }
  | { readonly ok: false; readonly reason: 'GRANT_CONFLICT' } {
  if (tx.phase !== 'SUSPENDED') throw new Error('victim must be suspended before requester grant')
  const grant = grantLeaseBundle(tx.requester, requesterClaims, leases, schedulerEpoch)
  if (!grant.ok) return { ok: false, reason: 'GRANT_CONFLICT' }
  return { ok: true, transaction: { ...tx, phase: 'GRANTED' }, leases: grant.leases }
}

export function executePreemption(
  tx: PreemptionTransaction,
  victimState: TransitionRuntimeState,
  requesterClaims: readonly ResourceClaim[],
  leases: readonly ResourceLease[],
  schedulerEpoch: number,
): { readonly ok: true; readonly transaction: PreemptionTransaction; readonly victimState: TransitionRuntimeState; readonly leases: readonly ResourceLease[]; readonly phases: readonly PreemptionPhase[] }
  | { readonly ok: false; readonly reason: 'SAFE_YIELD_REQUIRED' | 'DEADLINE_EXPIRED' | 'GRANT_CONFLICT' } {
  if (tx.phase === 'DEADLINE_EXPIRED') return { ok: false, reason: 'DEADLINE_EXPIRED' }
  if (tx.phase !== 'YIELD_ACKNOWLEDGED') return { ok: false, reason: 'SAFE_YIELD_REQUIRED' }
  const revoked = revokePreemptionLeases(tx, leases)
  const suspended = suspendPreemptionVictim(revoked.transaction, victimState)
  const granted = grantPreemptionRequester(suspended.transaction, requesterClaims, revoked.leases, schedulerEpoch)
  if (!granted.ok) return granted
  return {
    ok: true,
    transaction: granted.transaction,
    victimState: suspended.victimState,
    leases: granted.leases,
    phases: ['YIELD_ACKNOWLEDGED', 'LEASES_REVOKED', 'SUSPENDED', 'GRANTED'],
  }
}
