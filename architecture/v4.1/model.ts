// V4.1 deterministic architecture model. No Minecraft runtime imports.
// Semantic Transition identity is independent of controller generation and
// temporary resource leases so suspend/resume preserves contract identity.

export type TransitionId = string
export type ContractHash = string
export type PredicateId = string
export type ResourceKey = string
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

export interface VerificationEvidence {
  readonly fact: VerifiedFact
  readonly deterministic: true
  readonly causalCredit: 'self' | 'shared' | 'external'
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
  readonly factRevision: number
  readonly expiresAtMs: number
}

export function sameWorld(a: WorldIdentity, b: WorldIdentity): boolean {
  return a.serverId === b.serverId && a.dimension === b.dimension && a.worldEpoch === b.worldEpoch
}

export function leaseModesConflict(a: LeaseMode, b: LeaseMode): boolean {
  return a === 'EXCLUSIVE_WRITE' || b === 'EXCLUSIVE_WRITE'
}

export function claimsConflict(a: ResourceClaim, b: ResourceClaim): boolean {
  return a.resource === b.resource && leaseModesConflict(a.mode, b.mode)
}

export function canonicalClaims(claims: readonly ResourceClaim[]): readonly ResourceClaim[] {
  return [...claims].sort((left, right) => left.resource.localeCompare(right.resource))
}

export function conflictingLeases(
  requester: TransitionId,
  claims: readonly ResourceClaim[],
  leases: readonly ResourceLease[],
): readonly ResourceLease[] {
  const wanted = new Map(claims.map((claim) => [claim.resource, claim.mode]))
  return leases.filter((lease) => {
    if (lease.owner === requester) return false
    const requestedMode = wanted.get(lease.resource)
    return requestedMode !== undefined && leaseModesConflict(requestedMode, lease.mode)
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
  const conflicts = conflictingLeases(owner, ordered, leases)
  if (conflicts.length > 0) return { ok: false, conflicts }
  const retained = leases.filter((lease) => lease.owner !== owner)
  const granted = ordered.map<ResourceLease>((claim) => ({
    owner,
    resource: claim.resource,
    mode: claim.mode,
    grantedAtEpoch: schedulerEpoch,
    preemptible: claim.preemptible,
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
  | { readonly ok: false; readonly reason: 'WORLD_CHANGED' | 'STALE_REBIND' | 'TERMINAL' }

export function resumeTransition(
  state: TransitionRuntimeState,
  contract: TransitionContract,
  observedWorld: WorldIdentity,
  binding: RuntimeBinding,
  freshRevalidation: boolean,
): ResumeResult {
  if (state.lifecycle === 'TERMINAL') return { ok: false, reason: 'TERMINAL' }
  if (!sameWorld(contract.world, observedWorld)) return { ok: false, reason: 'WORLD_CHANGED' }
  const generationChanged = state.binding.generationId !== binding.generationId
  if (generationChanged && !freshRevalidation) return { ok: false, reason: 'STALE_REBIND' }
  if (binding.factRevision < state.binding.factRevision && !freshRevalidation) return { ok: false, reason: 'STALE_REBIND' }
  return {
    ok: true,
    state: {
      ...state,
      lifecycle: 'RUNNABLE',
      binding,
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
): TransitionRuntimeState {
  if (state.lifecycle === 'TERMINAL') return state
  if (!sameWorld(contract.world, evidence.fact.world)) return state
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
    decision.binding.generationId === liveBinding.generationId &&
    decision.binding.factRevision === liveBinding.factRevision &&
    decision.binding.registryRevision === liveBinding.registryRevision &&
    decision.binding.missionRevision === liveBinding.missionRevision
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
    usage: { activeMs: 0, mechanicalSteps: 0, resources: {}, risk: {} },
    terminalOutcome: null,
  }
}

export function effectCommitIsCurrent(
  token: EffectCommitToken,
  state: TransitionRuntimeState,
  factRevision: number,
  nowMs: number,
): boolean {
  return (
    state.lifecycle === 'ACTIVE' &&
    token.transitionId === state.transitionId &&
    token.contractHash === state.contractHash &&
    token.factRevision === factRevision &&
    token.expiresAtMs >= nowMs
  )
}
