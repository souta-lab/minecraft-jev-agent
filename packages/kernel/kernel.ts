import { createHash } from 'node:crypto'
import { isTrustedCapability, type TrustedCapability } from './kernel-internal/authority-secret.ts'

export type TransitionId = string
export type ContractHash = string
export type PredicateId = string
export type TransitionClass = 'VIABILITY' | 'MISSION_CRITICAL' | 'MISSION' | 'BACKGROUND'
export type LeaseMode = 'SHARED_READ' | 'APPEND' | 'EXCLUSIVE_WRITE'
export type TransitionLifecycle = 'ENABLED' | 'RUNNABLE' | 'ACTIVE' | 'SUSPENDED' | 'OBSERVING' | 'BLOCKED' | 'TERMINAL'
export type EffectKind = 'MOVE' | 'LOOK' | 'INTERACT' | 'ATTACK' | 'INVENTORY_MUTATION' | 'EQUIP' | 'DIG' | 'PLACE' | 'CONSUME' | 'CRAFT' | 'STATION_MUTATION' | 'COMMAND'
export const RESOURCE_DOMAINS = ['body', 'interaction', 'attack', 'inventory', 'equipment', 'world', 'entity', 'observation', 'memory', 'station', 'container', 'window', 'command'] as const
export type ResourceDomain = (typeof RESOURCE_DOMAINS)[number]
const RESOURCE_DOMAIN_SET: ReadonlySet<string> = new Set(RESOURCE_DOMAINS)
const TRANSITION_CLASS_SET: ReadonlySet<string> = new Set(['VIABILITY', 'MISSION_CRITICAL', 'MISSION', 'BACKGROUND'])
const LEASE_MODE_SET: ReadonlySet<string> = new Set(['SHARED_READ', 'APPEND', 'EXCLUSIVE_WRITE'])
const EFFECT_KIND_SET: ReadonlySet<string> = new Set(['MOVE', 'LOOK', 'INTERACT', 'ATTACK', 'INVENTORY_MUTATION', 'EQUIP', 'DIG', 'PLACE', 'CONSUME', 'CRAFT', 'STATION_MUTATION', 'COMMAND'])

export interface WorldIdentity { readonly serverId: string; readonly dimension: string; readonly worldEpoch: number }
export interface RuntimeBinding { readonly generationId: string; readonly factRevision: number; readonly registryRevision: number; readonly missionRevision: number }

export interface ResourceId { readonly domain: ResourceDomain; readonly path: readonly string[]; readonly instance: string | null }
export interface ResourceClaimSpec { readonly resource: ResourceId; readonly mode: LeaseMode; readonly preemptible: boolean; readonly resumable: boolean; readonly maxNonPreemptibleMs?: number | null }
export interface CanonicalResourceClaim extends ResourceClaimSpec { readonly key: string; readonly maxNonPreemptibleMs: number | null }
export interface EffectResourceRequirement { readonly resource: ResourceId; readonly mode: LeaseMode }
export interface EffectPermitSpec { readonly kind: EffectKind; readonly scope: string; readonly irreversible: boolean; readonly maxCount: number; readonly requiredResources: readonly EffectResourceRequirement[] }
export interface CanonicalEffectPermit extends EffectPermitSpec { readonly key: string; readonly requiredResources: readonly (EffectResourceRequirement & { readonly key: string })[] }
export interface TransitionBudget { readonly maxActiveMs: number; readonly deadlineAtMonoMs: number | null; readonly maxMechanicalSteps: number; readonly resources: Readonly<Record<string, number>>; readonly risk: Readonly<Record<string, number>> }
export interface DefinitionIdentity { readonly id: string; readonly version: string }
export interface TransitionContractSpec {
  readonly transitionId: TransitionId; readonly family: string; readonly class: TransitionClass; readonly urgency?: number; readonly world: WorldIdentity
  readonly desiredPredicate: PredicateId; readonly requires: readonly PredicateId[]; readonly ensures: readonly PredicateId[]; readonly invariants: readonly PredicateId[]
  readonly claims: readonly ResourceClaimSpec[]; readonly effects: readonly EffectPermitSpec[]; readonly budget: TransitionBudget
  readonly progressDefinition: DefinitionIdentity; readonly controllerDefinition: DefinitionIdentity; readonly verificationDefinition: DefinitionIdentity; readonly terminalPolicy: DefinitionIdentity
  readonly witnessValidation?: DefinitionIdentity | null
}
export interface CanonicalTransitionContract extends Omit<TransitionContractSpec, 'claims' | 'effects' | 'witnessValidation' | 'urgency'> {
  readonly contractHash: ContractHash; readonly urgency: number; readonly claims: readonly CanonicalResourceClaim[]; readonly effects: readonly CanonicalEffectPermit[]; readonly witnessValidation: DefinitionIdentity | null
}

export type TerminalOutcome =
  | { readonly kind: 'SUCCESS'; readonly factIds: readonly string[]; readonly causalCredit: 'self' | 'shared' | 'external' }
  | { readonly kind: 'INFEASIBLE'; readonly reason: string }
  | { readonly kind: 'FAILED_MECHANICALLY'; readonly reason: string }
  | { readonly kind: 'RESOURCE_EXHAUSTED'; readonly resource: string }
  | { readonly kind: 'RISK_BUDGET_EXHAUSTED'; readonly risk: string }
  | { readonly kind: 'DEADLINE_EXPIRED' }
  | { readonly kind: 'ACTIVE_TIME_EXHAUSTED' }
  | { readonly kind: 'MECHANICAL_STEPS_EXHAUSTED' }
  | { readonly kind: 'WORLD_CHANGED'; readonly expected: WorldIdentity; readonly observed: WorldIdentity }
  | { readonly kind: 'MISSION_SUPERSEDED'; readonly missionRevision: number }
  | { readonly kind: 'PREEMPTED_NONRESUMABLE'; readonly by: TransitionId }
  | { readonly kind: 'CANCELED'; readonly reason: string }
  | { readonly kind: 'RUNTIME_FAULT'; readonly reason: string }

export interface TransitionUsage { readonly activeMs: number; readonly mechanicalSteps: number; readonly resources: Readonly<Record<string, number>>; readonly risk: Readonly<Record<string, number>> }
export interface TransitionState {
  readonly transitionId: TransitionId; readonly contractHash: ContractHash; readonly lifecycle: TransitionLifecycle
  readonly heldLeaseIds: readonly string[]; readonly starvationAge: number; readonly usage: TransitionUsage
  readonly suspendReason: string | null; readonly blockReason: string | null; readonly terminalOutcome: TerminalOutcome | null; readonly pendingTerminalOutcome: TerminalOutcome | null
  readonly cancelRequested: boolean; readonly activeSinceMonoMs: number | null; readonly materialRevisionAtActivation: number
  readonly witnessRevision: number; readonly lifecycleRevision: number; readonly progressRevision: number; readonly progressValueHash: string | null; readonly progressObservedAtMonoMs: number | null
}

export interface ResourceLease {
  readonly leaseGrantId: string; readonly owner: TransitionId; readonly ownerContractHash: ContractHash; readonly resource: ResourceId; readonly resourceKey: string
  readonly mode: LeaseMode; readonly world: WorldIdentity; readonly generationId: string; readonly schedulerEpoch: number
  readonly preemptible: boolean; readonly resumable: boolean; readonly criticalEnteredAtMonoMs: number | null; readonly maxNonPreemptibleMs: number | null; readonly hardYieldDeadlineMonoMs: number | null
}

export interface VerifiedFactRecord {
  readonly factId: string; readonly predicateId: PredicateId; readonly truth: 'true' | 'false' | 'unknown'; readonly valueHash: string; readonly effectCommitId: string | null
  readonly world: WorldIdentity; readonly binding: RuntimeBinding; readonly verifier: DefinitionIdentity; readonly observedAtMonoMs: number
}
export interface WitnessProofRecord {
  readonly proofId: string; readonly transitionId: TransitionId; readonly contractHash: ContractHash; readonly witnessRevision: number
  readonly witnessRefHash: string; readonly relationId: string; readonly world: WorldIdentity; readonly binding: RuntimeBinding; readonly validator: DefinitionIdentity
}

export type EffectCommitStatus = 'ISSUED' | 'DISPATCHING' | 'OBSERVED' | 'REVOKED' | 'EXPIRED' | 'UNKNOWN'
export interface EffectCommitRecord {
  readonly commitId: string; readonly transitionId: TransitionId; readonly contractHash: ContractHash; readonly permitKey: string; readonly effect: EffectKind; readonly scope: string
  readonly world: WorldIdentity; readonly binding: RuntimeBinding; readonly generationId: string; readonly leaseGrantIds: readonly string[]
  readonly issuedAtMonoMs: number; readonly expiresAtMonoMs: number; readonly status: EffectCommitStatus; readonly irreversible: boolean
  readonly dispatchEventSeq: number | null; readonly observation: 'OCCURRED' | 'NOT_OCCURRED' | 'UNKNOWN' | null; readonly factIds: readonly string[]
}

export interface PreemptionVictimPlan {
  readonly transitionId: TransitionId; readonly contractHash: ContractHash; readonly conflictingLeaseIds: readonly string[]; readonly allLeaseIdsAtPlan: readonly string[]
  readonly safeYieldAcknowledged: boolean; readonly acknowledgedAtMonoMs: number | null; readonly lateYield: boolean; readonly deadlineViolated: boolean
  readonly inheritedPriority: number | null; readonly resumable: boolean; readonly hardYieldDeadlineMonoMs: number
}
export interface PreemptionTransaction {
  readonly transactionId: string; readonly requesterId: TransitionId; readonly requesterContractHash: ContractHash; readonly requesterClaimFingerprint: string
  readonly world: WorldIdentity; readonly binding: RuntimeBinding; readonly generationId: string; readonly schedulerEpoch: number; readonly requestedAtMonoMs: number
  readonly victims: readonly PreemptionVictimPlan[]; readonly status: 'PLANNED' | 'READY' | 'COMMITTED' | 'STALE' | 'CANCELED'
}

export interface AppendRecord { readonly operationId: string; readonly payloadHash: string; readonly transitionId: TransitionId; readonly eventSeq: number }
export interface AppendStoreState { readonly resourceKey: string; readonly revision: number; readonly records: readonly AppendRecord[] }
export interface KernelConfig {
  readonly world: WorldIdentity; readonly generationId: string; readonly missionPredicates: readonly PredicateId[]; readonly verifierRegistry: readonly DefinitionIdentity[]
  readonly progressRegistry?: readonly DefinitionIdentity[]; readonly contractCompilerRegistry: readonly DefinitionIdentity[]; readonly missionAuthority: DefinitionIdentity
  readonly appendResources?: readonly ResourceId[]; readonly minResidencyMs?: number; readonly preemptibleYieldBudgetMs?: number
}
export interface KernelState {
  readonly world: WorldIdentity; readonly generationId: string; readonly monotonicMs: number; readonly factRevision: number; readonly registryRevision: number; readonly missionRevision: number
  readonly schedulerEpoch: number; readonly materialRevision: number; readonly budgetRevision: number; readonly leaseRevision: number; readonly effectRevision: number; readonly journalSequence: number
  readonly transitionSequences: Readonly<Record<TransitionId, number>>
  readonly contracts: Readonly<Record<ContractHash, CanonicalTransitionContract>>; readonly transitionContracts: Readonly<Record<TransitionId, ContractHash>>
  readonly transitions: Readonly<Record<TransitionId, TransitionState>>; readonly leases: Readonly<Record<string, ResourceLease>>; readonly effects: Readonly<Record<string, EffectCommitRecord>>
  readonly effectUsage: Readonly<Record<string, number>>; readonly facts: Readonly<Record<string, VerifiedFactRecord>>; readonly witnesses: Readonly<Record<string, WitnessProofRecord>>
  readonly preemptions: Readonly<Record<string, PreemptionTransaction>>; readonly missionPredicates: readonly PredicateId[]; readonly verifierRegistry: Readonly<Record<string, DefinitionIdentity>>; readonly progressRegistry: Readonly<Record<string, DefinitionIdentity>>
  readonly appendStores: Readonly<Record<string, AppendStoreState>>; readonly appendResourceKeys: readonly string[]; readonly minResidencyMs: number; readonly preemptibleYieldBudgetMs: number
  readonly contractCompilerRegistry: Readonly<Record<string, DefinitionIdentity>>; readonly missionAuthority: DefinitionIdentity
  readonly nextLeaseId: number; readonly nextCommitId: number; readonly nextPreemptionId: number; readonly nextFactId: number; readonly nextWitnessId: number
}

export interface VerifiedSnapshotInput { readonly predicateId: PredicateId; readonly truth: 'true' | 'false' | 'unknown'; readonly valueHash: string; readonly effectCommitId?: string | null }
export type KernelCommand =
  | { readonly kind: 'REGISTER_TRANSITION'; readonly contract: CanonicalTransitionContract; readonly compiler: DefinitionIdentity; readonly capability: unknown }
  | { readonly kind: 'ADMIT_TRANSITION'; readonly transitionId: TransitionId; readonly capability: unknown }
  | { readonly kind: 'ACCEPT_VERIFIED_SNAPSHOT'; readonly verifier: DefinitionIdentity; readonly facts: readonly VerifiedSnapshotInput[]; readonly materialChange: boolean; readonly observedAtMonoMs: number; readonly capability: unknown }
  | { readonly kind: 'ACCEPT_WITNESS_PROOF'; readonly transitionId: TransitionId; readonly witnessRevision: number; readonly witnessRefHash: string; readonly relationId: string; readonly validator: DefinitionIdentity; readonly capability: unknown }
  | { readonly kind: 'ACQUIRE_DECLARED_RESOURCES'; readonly transitionId: TransitionId; readonly capability: unknown }
  | { readonly kind: 'PAUSE_ACTIVE'; readonly transitionId: TransitionId; readonly to: 'OBSERVING' | 'BLOCKED'; readonly reason: string; readonly capability: unknown }
  | { readonly kind: 'ACK_PAUSE_YIELD'; readonly transitionId: TransitionId; readonly to: 'OBSERVING' | 'BLOCKED'; readonly reason: string; readonly atMonoMs: number; readonly capability: unknown }
  | { readonly kind: 'RESUME_TRANSITION'; readonly transitionId: TransitionId; readonly capability: unknown }
  | { readonly kind: 'AGE_RUNNABLE'; readonly transitionId: TransitionId; readonly capability: unknown }
  | { readonly kind: 'START_PREEMPTION'; readonly requesterId: TransitionId; readonly capability: unknown }
  | { readonly kind: 'ACK_PREEMPTION_YIELD'; readonly transactionId: string; readonly victimId: TransitionId; readonly safeYield: boolean; readonly atMonoMs: number; readonly capability: unknown }
  | { readonly kind: 'COMMIT_PREEMPTION'; readonly transactionId: string; readonly capability: unknown }
  | { readonly kind: 'ISSUE_EFFECT'; readonly transitionId: TransitionId; readonly effect: EffectKind; readonly scope: string; readonly ttlMs: number; readonly capability: unknown }
  | { readonly kind: 'BEGIN_EFFECT_DISPATCH'; readonly commitId: string; readonly capability: unknown }
  | { readonly kind: 'RECONCILE_EFFECT'; readonly commitId: string; readonly observation: 'OCCURRED' | 'NOT_OCCURRED' | 'UNKNOWN'; readonly factIds: readonly string[]; readonly verifier: DefinitionIdentity; readonly capability: unknown }
  | { readonly kind: 'REPORT_PROGRESS'; readonly transitionId: TransitionId; readonly progressRevision: number; readonly valueHash: string; readonly observedAtMonoMs: number; readonly evaluator: DefinitionIdentity; readonly capability: unknown }
  | { readonly kind: 'DEBIT_USAGE'; readonly actorTransitionId: TransitionId; readonly targetTransitionId: TransitionId; readonly capability: unknown; readonly mechanicalSteps?: number; readonly resource?: { readonly key: string; readonly amount: number }; readonly risk?: { readonly key: string; readonly amount: number } }
  | { readonly kind: 'ADVANCE_TIME'; readonly toMonoMs: number; readonly capability: unknown }
  | { readonly kind: 'REQUEST_CANCEL'; readonly transitionId: TransitionId; readonly reason: string; readonly capability: unknown }
  | { readonly kind: 'ACK_CANCEL_YIELD'; readonly transitionId: TransitionId; readonly atMonoMs: number; readonly capability: unknown }
  | { readonly kind: 'ACK_TERMINAL_YIELD'; readonly transitionId: TransitionId; readonly atMonoMs: number; readonly capability: unknown }
  | { readonly kind: 'VERIFY_SUCCESS'; readonly transitionId: TransitionId; readonly causalCredit: 'self' | 'shared' | 'external'; readonly verifier: DefinitionIdentity; readonly capability: unknown }
  | { readonly kind: 'UPDATE_MISSION'; readonly predicates: readonly PredicateId[]; readonly authority: DefinitionIdentity; readonly capability: unknown }
  | { readonly kind: 'CHANGE_GENERATION'; readonly generationId: string; readonly capability: unknown }
  | { readonly kind: 'CHANGE_WORLD'; readonly world: WorldIdentity; readonly capability: unknown }
  | { readonly kind: 'APPEND_RECORD'; readonly transitionId: TransitionId; readonly resource: ResourceId; readonly operationId: string; readonly payloadHash: string; readonly capability: unknown }

export interface ReplayCommand { readonly command: Omit<KernelCommand, 'capability'> & { readonly capability?: never } }
export interface KernelEvent { readonly eventSeq: number; readonly transitionSeq: number | null; readonly transitionSeqs: Readonly<Record<TransitionId, number>>; readonly kind: string; readonly transitionId: string | null; readonly data: Readonly<Record<string, unknown>>; readonly replay: ReplayCommand }
export type KernelResult = { readonly ok: true; readonly state: KernelState; readonly events: readonly KernelEvent[] } | { readonly ok: false; readonly state: KernelState; readonly reason: string; readonly events: readonly KernelEvent[] }

const CANONICAL_CONTRACTS = new WeakSet<object>()
const KERNEL_STATES = new WeakSet<object>()
const JEV_FRAMES = new WeakSet<object>()

function assertId(value: string, label: string): void { if (value.trim().length === 0) throw new Error(`${label} must be non-empty`) }
function assertFiniteNonNegative(value: number, label: string): void { if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be finite and non-negative`) }
function assertNonNegativeInteger(value: number, label: string): void { if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`) }
function assertNoDuplicates(values: readonly string[], label: string): void { if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicates`) }
function uniqSorted(values: readonly string[]): readonly string[] { return [...new Set(values)].sort() }
function sameWorld(a: WorldIdentity, b: WorldIdentity): boolean { return a.serverId === b.serverId && a.dimension === b.dimension && a.worldEpoch === b.worldEpoch }
function bindingOf(state: KernelState): RuntimeBinding { return { generationId: state.generationId, factRevision: state.factRevision, registryRevision: state.registryRevision, missionRevision: state.missionRevision } }
function bindingEqual(a: RuntimeBinding, b: RuntimeBinding): boolean { return a.generationId === b.generationId && a.factRevision === b.factRevision && a.registryRevision === b.registryRevision && a.missionRevision === b.missionRevision }
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)]))
  return value
}
function canonicalJson(value: unknown): string { return JSON.stringify(stable(value)) }
function sha(value: unknown): string { return createHash('sha256').update(canonicalJson(value)).digest('hex') }
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item)
  }
  return value
}
function markKernelState<T extends KernelState>(state: T): T {
  const frozen = deepFreeze(state)
  KERNEL_STATES.add(frozen)
  return frozen
}
function cloneRecord<T>(record: Readonly<Record<string, T>>): Record<string, T> { return { ...record } }

export function resourceId(domain: ResourceDomain, path: readonly string[] = [], instance: string | null = null): ResourceId {
  assertId(domain, 'resource domain'); if (!RESOURCE_DOMAIN_SET.has(domain)) throw new Error(`unknown resource domain ${domain}`)
  for (const segment of path) assertId(segment, 'resource path segment')
  if (instance !== null) assertId(instance, 'resource instance')
  return deepFreeze({ domain, path: [...path], instance })
}
export function resourceKey(resource: ResourceId): string {
  return `${encodeURIComponent(resource.domain)}/${resource.path.map(encodeURIComponent).join('/')}${resource.instance === null ? '' : `#${encodeURIComponent(resource.instance)}`}`
}
export function resourcesOverlap(a: ResourceId, b: ResourceId): boolean {
  if (a.domain !== b.domain) return false
  const n = Math.min(a.path.length, b.path.length)
  for (let i = 0; i < n; i += 1) if (a.path[i] !== b.path[i]) return false
  if (a.instance !== null && b.instance !== null && a.instance !== b.instance) return false
  return true
}
function resourceSubsumes(parent: ResourceId, child: ResourceId): boolean {
  if (parent.domain !== child.domain || parent.path.length > child.path.length) return false
  for (let i = 0; i < parent.path.length; i += 1) if (parent.path[i] !== child.path[i]) return false
  return parent.instance === null || parent.instance === child.instance
}
function modesConflict(a: LeaseMode, b: LeaseMode): boolean { return a === 'EXCLUSIVE_WRITE' || b === 'EXCLUSIVE_WRITE' }
function modeSatisfies(actual: LeaseMode, required: LeaseMode): boolean { return actual === required || actual === 'EXCLUSIVE_WRITE' }

function canonicalizeClaims(specs: readonly ResourceClaimSpec[]): readonly CanonicalResourceClaim[] {
  const byExact = new Map<string, CanonicalResourceClaim>()
  for (const spec of specs) {
    if (!LEASE_MODE_SET.has(spec.mode)) throw new Error(`invalid lease mode ${String(spec.mode)}`)
    if (typeof spec.preemptible !== 'boolean' || typeof spec.resumable !== 'boolean') throw new Error('claim preemptible/resumable must be boolean')
    const normalizedResource = resourceId(spec.resource.domain as ResourceDomain, spec.resource.path, spec.resource.instance)
    const key = resourceKey(normalizedResource)
    const bound = spec.preemptible ? null : (spec.maxNonPreemptibleMs ?? null)
    if (!spec.preemptible && (bound === null || !Number.isFinite(bound) || bound <= 0)) throw new Error(`non-preemptible claim ${key} requires finite maxNonPreemptibleMs`)
    const claim = deepFreeze({ ...spec, resource: normalizedResource, key, maxNonPreemptibleMs: bound })
    const prior = byExact.get(key)
    if (prior !== undefined) {
      if (prior.mode !== claim.mode || prior.preemptible !== claim.preemptible || prior.resumable !== claim.resumable || prior.maxNonPreemptibleMs !== claim.maxNonPreemptibleMs) throw new Error(`incompatible duplicate claim ${key}`)
      continue
    }
    byExact.set(key, claim)
  }
  const all = [...byExact.values()].sort((a, b) => a.key.localeCompare(b.key))
  for (let i = 0; i < all.length; i += 1) for (let j = i + 1; j < all.length; j += 1) {
    const a = all[i]!, b = all[j]!
    if (!resourcesOverlap(a.resource, b.resource)) continue
    if (a.mode !== b.mode || a.preemptible !== b.preemptible || a.resumable !== b.resumable || a.maxNonPreemptibleMs !== b.maxNonPreemptibleMs) throw new Error(`ambiguous overlapping claims ${a.key} and ${b.key}`)
  }
  return deepFreeze(all.filter((claim, i) => !all.some((other, j) => j !== i && other.key !== claim.key && resourceSubsumes(other.resource, claim.resource))))
}
function effectPermitKey(kind: EffectKind, scope: string): string { return `${kind}:${scope}` }
function canonicalizeEffects(specs: readonly EffectPermitSpec[]): readonly CanonicalEffectPermit[] {
  const keys = new Set<string>(); const out: CanonicalEffectPermit[] = []
  for (const spec of specs) {
    if (!EFFECT_KIND_SET.has(spec.kind)) throw new Error(`invalid effect kind ${String(spec.kind)}`)
    if (typeof spec.irreversible !== 'boolean') throw new Error('effect irreversible must be boolean')
    assertId(spec.scope, 'effect scope'); if (!Number.isInteger(spec.maxCount) || spec.maxCount <= 0) throw new Error('effect maxCount must be positive integer')
    if (spec.requiredResources.length === 0) throw new Error(`effect ${spec.kind}:${spec.scope} requires explicit physical resource authority`)
    const key = effectPermitKey(spec.kind, spec.scope); if (keys.has(key)) throw new Error(`duplicate effect permit ${key}`); keys.add(key)
    const requiredSeen = new Set<string>()
    const requiredResources = spec.requiredResources.map((r) => {
      if (!LEASE_MODE_SET.has(r.mode)) throw new Error(`invalid required resource mode ${String(r.mode)}`)
      const resource = resourceId(r.resource.domain as ResourceDomain, r.resource.path, r.resource.instance)
      const requiredKey = resourceKey(resource)
      if (requiredSeen.has(requiredKey)) throw new Error(`duplicate effect resource requirement ${requiredKey}`)
      requiredSeen.add(requiredKey)
      return deepFreeze({ resource, mode: r.mode, key: requiredKey })
    }).sort((a, b) => a.key.localeCompare(b.key))
    out.push(deepFreeze({ ...spec, key, requiredResources }))
  }
  return deepFreeze(out.sort((a, b) => a.key.localeCompare(b.key)))
}
function normalizeDefinition(def: DefinitionIdentity, label: string): DefinitionIdentity { assertId(def.id, `${label}.id`); assertId(def.version, `${label}.version`); return deepFreeze({ id: def.id, version: def.version }) }

export function createTransitionContract(spec: TransitionContractSpec): CanonicalTransitionContract {
  assertId(spec.transitionId, 'transitionId'); assertId(spec.family, 'family'); assertId(spec.desiredPredicate, 'desiredPredicate')
  if (!TRANSITION_CLASS_SET.has(spec.class)) throw new Error(`invalid transition class ${String(spec.class)}`)
  const urgency = spec.urgency ?? 0
  if (!Number.isInteger(urgency) || urgency < 0 || urgency > 799) throw new Error('urgency must be an integer in [0,799]')
  assertId(spec.world.serverId, 'world.serverId'); assertId(spec.world.dimension, 'world.dimension'); assertNonNegativeInteger(spec.world.worldEpoch, 'world.worldEpoch')
  for (const [label, values] of [['requires', spec.requires], ['ensures', spec.ensures], ['invariants', spec.invariants]] as const) for (const value of values) assertId(value, label)
  assertNoDuplicates(spec.requires, 'requires'); assertNoDuplicates(spec.ensures, 'ensures'); assertNoDuplicates(spec.invariants, 'invariants')
  const requires = uniqSorted(spec.requires), ensures = uniqSorted(spec.ensures), invariants = uniqSorted(spec.invariants)
  if (!ensures.includes(spec.desiredPredicate)) throw new Error('desiredPredicate must be included in ensures')
  assertFiniteNonNegative(spec.budget.maxActiveMs, 'maxActiveMs'); if (spec.budget.deadlineAtMonoMs !== null) assertFiniteNonNegative(spec.budget.deadlineAtMonoMs, 'deadlineAtMonoMs')
  assertNonNegativeInteger(spec.budget.maxMechanicalSteps, 'maxMechanicalSteps')
  for (const [k, v] of Object.entries(spec.budget.resources)) { assertId(k, 'resource budget key'); assertFiniteNonNegative(v, `resource budget ${k}`) }
  for (const [k, v] of Object.entries(spec.budget.risk)) { assertId(k, 'risk budget key'); assertFiniteNonNegative(v, `risk budget ${k}`) }
  const claims = canonicalizeClaims(spec.claims)
  const effects = canonicalizeEffects(spec.effects)
  for (const permit of effects) for (const requirement of permit.requiredResources) {
    if (!claims.some((claim) => resourceSubsumes(claim.resource, requirement.resource) && modeSatisfies(claim.mode, requirement.mode))) {
      throw new Error(`effect ${permit.key} requires undeclared resource authority ${requirement.key}`)
    }
  }
  const semantic = {
    transitionId: spec.transitionId, family: spec.family, class: spec.class, urgency, world: deepFreeze({ ...spec.world }), desiredPredicate: spec.desiredPredicate,
    requires, ensures, invariants, claims, effects,
    budget: deepFreeze({ maxActiveMs: spec.budget.maxActiveMs, deadlineAtMonoMs: spec.budget.deadlineAtMonoMs, maxMechanicalSteps: spec.budget.maxMechanicalSteps, resources: { ...spec.budget.resources }, risk: { ...spec.budget.risk } }),
    progressDefinition: normalizeDefinition(spec.progressDefinition, 'progressDefinition'), controllerDefinition: normalizeDefinition(spec.controllerDefinition, 'controllerDefinition'), verificationDefinition: normalizeDefinition(spec.verificationDefinition, 'verificationDefinition'),
    terminalPolicy: normalizeDefinition(spec.terminalPolicy, 'terminalPolicy'), witnessValidation: spec.witnessValidation === undefined || spec.witnessValidation === null ? null : normalizeDefinition(spec.witnessValidation, 'witnessValidation'),
  }
  const contract = deepFreeze({ ...semantic, contractHash: sha(semantic) }) as CanonicalTransitionContract
  CANONICAL_CONTRACTS.add(contract)
  return contract
}
function canonicalContractHashValid(contract: CanonicalTransitionContract): boolean {
  const { contractHash: ignored, ...semantic } = contract
  return contract.contractHash === sha(semantic)
}
function canonicalContractValid(contract: CanonicalTransitionContract): boolean { return CANONICAL_CONTRACTS.has(contract) && canonicalContractHashValid(contract) }

function emptyUsage(): TransitionUsage { return deepFreeze({ activeMs: 0, mechanicalSteps: 0, resources: {}, risk: {} }) }
function verifierMap(defs: readonly DefinitionIdentity[]): Readonly<Record<string, DefinitionIdentity>> {
  const out: Record<string, DefinitionIdentity> = {}; for (const def of defs) { const n = normalizeDefinition(def, 'verifier'); if (out[n.id] !== undefined) throw new Error(`duplicate verifier ${n.id}`); out[n.id] = n }; return deepFreeze(out)
}
export function createKernelState(config: KernelConfig): KernelState {
  assertId(config.world.serverId, 'world.serverId'); assertId(config.world.dimension, 'world.dimension'); assertNonNegativeInteger(config.world.worldEpoch, 'world.worldEpoch')
  assertId(config.generationId, 'generationId')
  for (const predicate of config.missionPredicates) assertId(predicate, 'mission predicate')
  const minResidencyMs = config.minResidencyMs ?? 250; const preemptibleYieldBudgetMs = config.preemptibleYieldBudgetMs ?? 50
  assertFiniteNonNegative(minResidencyMs, 'minResidencyMs'); if (!Number.isFinite(preemptibleYieldBudgetMs) || preemptibleYieldBudgetMs <= 0) throw new Error('preemptibleYieldBudgetMs must be finite and positive')
  const appendResourceKeys = uniqSorted((config.appendResources ?? []).map((r) => resourceKey(resourceId(r.domain as ResourceDomain, r.path, r.instance))))
  const appendStores: Record<string, AppendStoreState> = {}; for (const key of appendResourceKeys) appendStores[key] = deepFreeze({ resourceKey: key, revision: 0, records: [] })
  return markKernelState({
    world: { ...config.world }, generationId: config.generationId, monotonicMs: 0, factRevision: 0, registryRevision: 0, missionRevision: 0, schedulerEpoch: 0, materialRevision: 0, budgetRevision: 0, leaseRevision: 0, effectRevision: 0, journalSequence: 0, transitionSequences: {},
    contracts: {}, transitionContracts: {}, transitions: {}, leases: {}, effects: {}, effectUsage: {}, facts: {}, witnesses: {}, preemptions: {}, missionPredicates: uniqSorted(config.missionPredicates), verifierRegistry: verifierMap(config.verifierRegistry), progressRegistry: verifierMap(config.progressRegistry ?? []), contractCompilerRegistry: verifierMap(config.contractCompilerRegistry), missionAuthority: normalizeDefinition(config.missionAuthority, 'missionAuthority'), appendStores, appendResourceKeys,
    minResidencyMs, preemptibleYieldBudgetMs,
    nextLeaseId: 1, nextCommitId: 1, nextPreemptionId: 1, nextFactId: 1, nextWitnessId: 1,
  })
}

function commandWithoutCapability(command: KernelCommand): ReplayCommand {
  const copy = { ...command } as Record<string, unknown>; delete copy.capability
  return deepFreeze({ command: copy as ReplayCommand['command'] })
}
function success(state: KernelState, command: KernelCommand, eventKind: string, transitionId: string | null, data: Record<string, unknown>, affectedTransitionIds: readonly string[] = transitionId === null ? [] : [transitionId]): KernelResult {
  const eventSeq = state.journalSequence + 1
  let transitionSequences = state.transitionSequences
  const eventTransitionSeqs: Record<string, number> = {}
  for (const id of uniqSorted(affectedTransitionIds)) {
    if (state.transitions[id] === undefined) continue
    const next = (transitionSequences[id] ?? 0) + 1
    transitionSequences = { ...transitionSequences, [id]: next }
    eventTransitionSeqs[id] = next
  }
  const transitionSeq = transitionId === null ? null : eventTransitionSeqs[transitionId] ?? null
  const event: KernelEvent = deepFreeze({ eventSeq, transitionSeq, transitionSeqs: eventTransitionSeqs, kind: eventKind, transitionId, data: deepFreeze(data), replay: commandWithoutCapability(command) })
  return { ok: true, state: markKernelState({ ...state, journalSequence: eventSeq, transitionSequences }), events: [event] }
}
function failure(state: KernelState, reason: string): KernelResult { return { ok: false, state, reason, events: [] } }
function updateTransition(state: KernelState, transition: TransitionState, registryMutation = true): KernelState {
  const transitions = cloneRecord(state.transitions); transitions[transition.transitionId] = deepFreeze(transition)
  return deepFreeze({ ...state, transitions, registryRevision: state.registryRevision + (registryMutation ? 1 : 0) })
}
function contractFor(state: KernelState, transitionId: TransitionId): CanonicalTransitionContract | null {
  const hash = state.transitionContracts[transitionId]; return hash === undefined ? null : state.contracts[hash] ?? null
}
function leasesFor(state: KernelState, transitionId: TransitionId): readonly ResourceLease[] { return Object.values(state.leases).filter((lease) => lease.owner === transitionId).sort((a, b) => a.leaseGrantId.localeCompare(b.leaseGrantId)) }
function leaseFingerprint(leases: readonly ResourceLease[]): string { return sha(leases.map((l) => [l.leaseGrantId, l.resourceKey, l.mode, l.schedulerEpoch, l.generationId])) }
function claimFingerprint(claims: readonly CanonicalResourceClaim[]): string { return sha(claims.map((c) => [c.key, c.mode, c.preemptible, c.resumable, c.maxNonPreemptibleMs])) }
function leaseConflicts(claim: CanonicalResourceClaim, lease: ResourceLease): boolean { return resourcesOverlap(claim.resource, lease.resource) && modesConflict(claim.mode, lease.mode) }
function conflictsFor(state: KernelState, owner: TransitionId, claims: readonly CanonicalResourceClaim[]): readonly ResourceLease[] { return Object.values(state.leases).filter((lease) => lease.owner !== owner && claims.some((claim) => leaseConflicts(claim, lease))) }
function proofsCurrentFor(state: KernelState, predicates: readonly string[], verifier: DefinitionIdentity): { ok: boolean; factIds: string[] } {
  const binding = bindingOf(state); const ids: string[] = []
  for (const predicateId of predicates) {
    const candidates = Object.values(state.facts).filter((f) => f.predicateId === predicateId && f.truth === 'true' && sameWorld(f.world, state.world) && bindingEqual(f.binding, binding) && f.verifier.id === verifier.id && f.verifier.version === verifier.version)
    const fact = candidates.sort((a, b) => a.factId.localeCompare(b.factId)).at(-1); if (fact === undefined) return { ok: false, factIds: [] }; ids.push(fact.factId)
  }
  return { ok: true, factIds: ids }
}
function witnessCurrentFor(state: KernelState, transition: TransitionState, contract: CanonicalTransitionContract): boolean {
  if (contract.witnessValidation === null) return true
  const binding = bindingOf(state)
  return Object.values(state.witnesses).some((w) => w.transitionId === transition.transitionId && w.contractHash === contract.contractHash && w.witnessRevision >= transition.witnessRevision && sameWorld(w.world, state.world) && bindingEqual(w.binding, binding) && w.validator.id === contract.witnessValidation!.id && w.validator.version === contract.witnessValidation!.version)
}
function activationPreconditions(state: KernelState, transition: TransitionState, contract: CanonicalTransitionContract): string | null {
  if (!state.missionPredicates.includes(contract.desiredPredicate)) return 'MISSION_NOT_AUTHORIZED'
  const p = proofsCurrentFor(state, [...contract.requires, ...contract.invariants], contract.verificationDefinition); if (!p.ok) return 'FRESH_PRECONDITION_PROOF_REQUIRED'
  if (!witnessCurrentFor(state, transition, contract)) return 'FRESH_WITNESS_PROOF_REQUIRED'
  return null
}
function releaseAllLeases(state: KernelState, transitionId: TransitionId): KernelState {
  const leases = Object.fromEntries(Object.entries(state.leases).filter(([, lease]) => lease.owner !== transitionId))
  if (Object.keys(leases).length === Object.keys(state.leases).length) return state
  return deepFreeze({ ...state, leases, leaseRevision: state.leaseRevision + 1 })
}
function revokeUnusedEffects(state: KernelState, transitionId: TransitionId): KernelState {
  let changed = false; const effects = cloneRecord(state.effects)
  for (const [id, token] of Object.entries(effects)) if (token.transitionId === transitionId && token.status === 'ISSUED') { effects[id] = deepFreeze({ ...token, status: 'REVOKED' }); changed = true }
  return changed ? deepFreeze({ ...state, effects, effectRevision: state.effectRevision + 1 }) : state
}
function quiesceTransitionEffects(state: KernelState, transitionId: TransitionId): KernelState {
  let changed = false; const effects = cloneRecord(state.effects)
  for (const [id, token] of Object.entries(effects)) {
    if (token.transitionId !== transitionId) continue
    if (token.status === 'ISSUED') { effects[id] = deepFreeze({ ...token, status: 'REVOKED' }); changed = true }
    else if (token.status === 'DISPATCHING') { effects[id] = deepFreeze({ ...token, status: 'UNKNOWN', observation: 'UNKNOWN' }); changed = true }
  }
  return changed ? deepFreeze({ ...state, effects, effectRevision: state.effectRevision + 1 }) : state
}
function cleanupPreemptions(state: KernelState, transitionId: TransitionId): KernelState {
  const preemptions = cloneRecord(state.preemptions); let changed = false
  for (const [id, tx] of Object.entries(preemptions)) if (tx.requesterId === transitionId || tx.victims.some((v) => v.transitionId === transitionId)) { preemptions[id] = deepFreeze({ ...tx, status: 'CANCELED' }); changed = true }
  return changed ? deepFreeze({ ...state, preemptions }) : state
}
function hasBoundedNonPreemptibleLease(state: KernelState, transitionId: TransitionId): boolean {
  return leasesFor(state, transitionId).some((lease) => !lease.preemptible)
}
function terminalize(state: KernelState, transitionId: TransitionId, outcome: TerminalOutcome): KernelState {
  const current = state.transitions[transitionId]; if (current === undefined || current.lifecycle === 'TERMINAL') return state
  let next = releaseAllLeases(state, transitionId); next = quiesceTransitionEffects(next, transitionId); next = cleanupPreemptions(next, transitionId)
  const transition = deepFreeze({ ...current, lifecycle: 'TERMINAL' as const, heldLeaseIds: [], terminalOutcome: outcome, pendingTerminalOutcome: null, activeSinceMonoMs: null, cancelRequested: false, lifecycleRevision: current.lifecycleRevision + 1 })
  return updateTransition(next, transition, true)
}
function requestTerminal(state: KernelState, transitionId: TransitionId, outcome: TerminalOutcome): KernelState {
  const current = state.transitions[transitionId]
  if (current === undefined || current.lifecycle === 'TERMINAL') return state
  if (current.pendingTerminalOutcome !== null) return state
  if (current.lifecycle === 'ACTIVE' && hasBoundedNonPreemptibleLease(state, transitionId)) {
    let next = revokeUnusedEffects(state, transitionId)
    const live = next.transitions[transitionId]!
    return updateTransition(next, deepFreeze({ ...live, pendingTerminalOutcome: outcome, lifecycleRevision: live.lifecycleRevision + 1 }), true)
  }
  return terminalize(state, transitionId, outcome)
}
function expireTokens(state: KernelState): KernelState {
  const effects = cloneRecord(state.effects); let changed = false
  for (const [id, token] of Object.entries(effects)) if (token.status === 'ISSUED' && state.monotonicMs > token.expiresAtMonoMs) { effects[id] = deepFreeze({ ...token, status: 'EXPIRED' }); changed = true }
  return changed ? deepFreeze({ ...state, effects, effectRevision: state.effectRevision + 1 }) : state
}
function enforceBudgets(state: KernelState): KernelState {
  let next = state
  for (const transition of Object.values(state.transitions)) {
    if (transition.lifecycle === 'TERMINAL') continue
    const contract = contractFor(next, transition.transitionId); if (contract === null) continue
    if (contract.budget.deadlineAtMonoMs !== null && next.monotonicMs > contract.budget.deadlineAtMonoMs) { next = requestTerminal(next, transition.transitionId, { kind: 'DEADLINE_EXPIRED' }); continue }
    if (transition.usage.activeMs > contract.budget.maxActiveMs) { next = requestTerminal(next, transition.transitionId, { kind: 'ACTIVE_TIME_EXHAUSTED' }); continue }
    if (transition.usage.mechanicalSteps > contract.budget.maxMechanicalSteps) { next = requestTerminal(next, transition.transitionId, { kind: 'MECHANICAL_STEPS_EXHAUSTED' }); continue }
    for (const [k, limit] of Object.entries(contract.budget.resources)) if ((transition.usage.resources[k] ?? 0) > limit) { next = requestTerminal(next, transition.transitionId, { kind: 'RESOURCE_EXHAUSTED', resource: k }); break }
    const afterResource = next.transitions[transition.transitionId]; if (afterResource?.lifecycle === 'TERMINAL' || afterResource?.pendingTerminalOutcome !== null) continue
    for (const [k, limit] of Object.entries(contract.budget.risk)) if ((transition.usage.risk[k] ?? 0) > limit) { next = requestTerminal(next, transition.transitionId, { kind: 'RISK_BUDGET_EXHAUSTED', risk: k }); break }
  }
  return next
}
function preprocess(state: KernelState): KernelState { return enforceBudgets(expireTokens(state)) }

function grantDeclared(state: KernelState, transitionId: TransitionId, prevalidated = false): KernelState | string {
  const transition = state.transitions[transitionId]; const contract = contractFor(state, transitionId)
  if (transition === undefined || contract === null) return 'UNKNOWN_TRANSITION'
  if (transition.lifecycle !== 'RUNNABLE') return 'ONLY_RUNNABLE_CAN_ACQUIRE'
  if (!prevalidated) { const pre = activationPreconditions(state, transition, contract); if (pre !== null) return pre }
  if (conflictsFor(state, transitionId, contract.claims).length > 0) return 'RESOURCE_CONFLICT'
  const leases = cloneRecord(state.leases); const ids: string[] = []; let nextId = state.nextLeaseId
  for (const claim of contract.claims) {
    const id = `lease:${nextId++}`; ids.push(id)
    leases[id] = deepFreeze({ leaseGrantId: id, owner: transitionId, ownerContractHash: contract.contractHash, resource: claim.resource, resourceKey: claim.key, mode: claim.mode, world: state.world, generationId: state.generationId, schedulerEpoch: state.schedulerEpoch + 1, preemptible: claim.preemptible, resumable: claim.resumable, criticalEnteredAtMonoMs: claim.preemptible ? null : state.monotonicMs, maxNonPreemptibleMs: claim.maxNonPreemptibleMs, hardYieldDeadlineMonoMs: claim.preemptible ? null : state.monotonicMs + claim.maxNonPreemptibleMs! })
  }
  const activated: TransitionState = deepFreeze({ ...transition, lifecycle: 'ACTIVE', heldLeaseIds: ids, starvationAge: 0, suspendReason: null, blockReason: null, activeSinceMonoMs: state.monotonicMs, materialRevisionAtActivation: state.materialRevision, lifecycleRevision: transition.lifecycleRevision + 1 })
  const transitions = cloneRecord(state.transitions); transitions[transitionId] = activated
  return deepFreeze({ ...state, transitions, leases, nextLeaseId: nextId, schedulerEpoch: state.schedulerEpoch + 1, leaseRevision: state.leaseRevision + 1, registryRevision: state.registryRevision + 1 })
}
function currentLeaseSetMatchesTransition(state: KernelState, transition: TransitionState): boolean {
  const owned = leasesFor(state, transition.transitionId).map((l) => l.leaseGrantId).sort(); return canonicalJson(owned) === canonicalJson([...transition.heldLeaseIds].sort())
}
function requiredLeasesForPermit(state: KernelState, transitionId: TransitionId, permit: CanonicalEffectPermit): readonly ResourceLease[] | null {
  const owned = leasesFor(state, transitionId)
  const matched: ResourceLease[] = []
  for (const requirement of permit.requiredResources) {
    const lease = owned.find((candidate) => resourcesOverlap(candidate.resource, requirement.resource) && modeSatisfies(candidate.mode, requirement.mode) && sameWorld(candidate.world, state.world) && candidate.generationId === state.generationId)
    if (lease === undefined) return null; matched.push(lease)
  }
  return [...new Map(matched.map((l) => [l.leaseGrantId, l])).values()].sort((a, b) => a.leaseGrantId.localeCompare(b.leaseGrantId))
}
const CLASS_PRIORITY: Record<TransitionClass, number> = { VIABILITY: 4000, MISSION_CRITICAL: 3000, MISSION: 2000, BACKGROUND: 1000 }
function deadlineTieBoost(state: KernelState, contract: CanonicalTransitionContract): number {
  if (contract.budget.deadlineAtMonoMs === null) return 0
  const slack = Math.max(0, contract.budget.deadlineAtMonoMs - state.monotonicMs)
  return 1 / (2 + slack)
}
function effectivePriority(state: KernelState, transitionId: TransitionId): number {
  const t = state.transitions[transitionId]; const c = contractFor(state, transitionId); if (t === undefined || c === null) return -Infinity
  let p = CLASS_PRIORITY[c.class] + c.urgency + Math.min(199, t.starvationAge) + deadlineTieBoost(state, c)
  for (const tx of Object.values(state.preemptions)) if ((tx.status === 'PLANNED' || tx.status === 'READY') && txCurrent(state, tx)) for (const v of tx.victims) if (v.transitionId === transitionId && v.inheritedPriority !== null) p = Math.max(p, v.inheritedPriority)
  return p
}
function txCurrent(state: KernelState, tx: PreemptionTransaction): boolean {
  return tx.status !== 'CANCELED' && tx.status !== 'STALE' && sameWorld(tx.world, state.world) && tx.generationId === state.generationId && bindingEqual(tx.binding, bindingOf(state)) && tx.schedulerEpoch === state.schedulerEpoch
}
function preemptionYielded(state: KernelState, transitionId: TransitionId): boolean {
  return Object.values(state.preemptions).some((tx) =>
    (tx.status === 'PLANNED' || tx.status === 'READY') && txCurrent(state, tx) &&
    tx.victims.some((victim) => victim.transitionId === transitionId && victim.safeYieldAcknowledged))
}
function hasDispatchInFlight(state: KernelState, transitionId: TransitionId): boolean {
  return Object.values(state.effects).some((effect) => effect.transitionId === transitionId && effect.status === 'DISPATCHING')
}

function applyInternal(inputState: KernelState, command: KernelCommand, replay = false): KernelResult {
  let state = preprocess(inputState)
  const getVerifier = (def: DefinitionIdentity): DefinitionIdentity | null => { const r = state.verifierRegistry[def.id]; return r !== undefined && r.version === def.version ? r : null }
  const schedulerAuthorized = (capability: unknown): boolean => replay || isTrustedCapability(capability, 'SCHEDULER', 'scheduler')
  const controllerAuthorized = (transitionId: string, capability: unknown): boolean => { const c = contractFor(state, transitionId); return c !== null && (replay || isTrustedCapability(capability, 'CONTROLLER', `${transitionId}|${c.contractHash}|${state.generationId}`)) }
  switch (command.kind) {
    case 'REGISTER_TRANSITION': {
      const compiler = state.contractCompilerRegistry[command.compiler.id]
      if (compiler === undefined || compiler.version !== command.compiler.version) return failure(state, 'UNKNOWN_CONTRACT_COMPILER')
      if (!replay && !isTrustedCapability(command.capability, 'CONTRACT_COMPILER', command.compiler.id)) return failure(state, 'UNTRUSTED_CONTRACT_COMPILER')
      if (!(replay ? canonicalContractHashValid(command.contract) : canonicalContractValid(command.contract))) return failure(state, 'NON_CANONICAL_CONTRACT')
      const acceptedContract = replay ? deepFreeze(command.contract) : command.contract
      if (!sameWorld(acceptedContract.world, state.world)) return failure(state, 'CONTRACT_WORLD_MISMATCH')
      if (state.transitions[acceptedContract.transitionId] !== undefined) return failure(state, 'DUPLICATE_TRANSITION_ID')
      const existingHash = state.contracts[acceptedContract.contractHash]
      if (existingHash !== undefined && canonicalJson(existingHash) !== canonicalJson(acceptedContract)) return failure(state, 'CONTRACT_HASH_COLLISION_OR_FORGERY')
      const contracts = cloneRecord(state.contracts); contracts[acceptedContract.contractHash] = acceptedContract
      const tc = cloneRecord(state.transitionContracts); tc[acceptedContract.transitionId] = acceptedContract.contractHash
      const transitions = cloneRecord(state.transitions); transitions[acceptedContract.transitionId] = deepFreeze({ transitionId: acceptedContract.transitionId, contractHash: acceptedContract.contractHash, lifecycle: 'ENABLED', heldLeaseIds: [], starvationAge: 0, usage: emptyUsage(), suspendReason: null, blockReason: null, terminalOutcome: null, pendingTerminalOutcome: null, cancelRequested: false, activeSinceMonoMs: null, materialRevisionAtActivation: state.materialRevision, witnessRevision: 0, lifecycleRevision: 0, progressRevision: 0, progressValueHash: null, progressObservedAtMonoMs: null })
      state = deepFreeze({ ...state, contracts, transitionContracts: tc, transitions, registryRevision: state.registryRevision + 1 })
      return success(state, command, 'TRANSITION_REGISTERED', acceptedContract.transitionId, { contractHash: acceptedContract.contractHash })
    }
    case 'ADMIT_TRANSITION': {
      if (!schedulerAuthorized(command.capability)) return failure(state, 'UNTRUSTED_SCHEDULER')
      const t = state.transitions[command.transitionId]; const c = contractFor(state, command.transitionId); if (t === undefined || c === null) return failure(state, 'UNKNOWN_TRANSITION')
      if (t.lifecycle !== 'ENABLED') return failure(state, 'ILLEGAL_LIFECYCLE_EDGE')
      if (!state.missionPredicates.includes(c.desiredPredicate)) return failure(state, 'MISSION_NOT_AUTHORIZED')
      state = updateTransition(state, { ...t, lifecycle: 'RUNNABLE', lifecycleRevision: t.lifecycleRevision + 1 }, true)
      return success(state, command, 'TRANSITION_ADMITTED', command.transitionId, {})
    }
    case 'ACCEPT_VERIFIED_SNAPSHOT': {
      if (!replay && !isTrustedCapability(command.capability, 'VERIFIER', command.verifier.id)) return failure(state, 'UNTRUSTED_VERIFIER_CAPABILITY')
      if (getVerifier(command.verifier) === null) return failure(state, 'UNKNOWN_VERIFIER')
      if (!Number.isFinite(command.observedAtMonoMs) || command.observedAtMonoMs < 0) return failure(state, 'INVALID_OBSERVATION_TIME'); if (command.observedAtMonoMs > state.monotonicMs) return failure(state, 'FUTURE_OBSERVATION')
      const latestObservedAt = Object.values(state.facts).reduce((max, fact) => Math.max(max, fact.observedAtMonoMs), -Infinity)
      if (command.observedAtMonoMs < latestObservedAt) return failure(state, 'OBSERVATION_TIME_REGRESSION')
      const seenPredicates = new Set<string>()
      for (const input of command.facts) {
        assertId(input.predicateId, 'predicateId'); assertId(input.valueHash, 'valueHash')
        if (!['true', 'false', 'unknown'].includes(input.truth)) return failure(state, 'INVALID_FACT_TRUTH')
        if (input.effectCommitId !== undefined && input.effectCommitId !== null) {
          assertId(input.effectCommitId, 'effectCommitId')
          const effect = state.effects[input.effectCommitId]
          if (effect === undefined || !sameWorld(effect.world, state.world)) return failure(state, 'UNKNOWN_EFFECT_EVIDENCE_TARGET')
        }
        if (seenPredicates.has(input.predicateId)) return failure(state, 'DUPLICATE_PREDICATE_IN_SNAPSHOT')
        seenPredicates.add(input.predicateId)
      }
      const nextRevision = state.factRevision + 1; const facts = cloneRecord(state.facts); let nextFactId = state.nextFactId
      const nextBinding = { generationId: state.generationId, factRevision: nextRevision, registryRevision: state.registryRevision, missionRevision: state.missionRevision }
      for (const input of command.facts) { const id = `fact:${nextFactId++}`; facts[id] = deepFreeze({ factId: id, predicateId: input.predicateId, truth: input.truth, valueHash: input.valueHash, effectCommitId: input.effectCommitId ?? null, world: state.world, binding: nextBinding, verifier: command.verifier, observedAtMonoMs: command.observedAtMonoMs }) }
      state = deepFreeze({ ...state, factRevision: nextRevision, facts, nextFactId, materialRevision: state.materialRevision + (command.materialChange ? 1 : 0) })
      return success(state, command, 'VERIFIED_SNAPSHOT_ACCEPTED', null, { factRevision: nextRevision, count: command.facts.length, materialChange: command.materialChange })
    }
    case 'ACCEPT_WITNESS_PROOF': {
      const t = state.transitions[command.transitionId]; const c = contractFor(state, command.transitionId); if (t === undefined || c === null) return failure(state, 'UNKNOWN_TRANSITION')
      if (c.witnessValidation === null || c.witnessValidation.id !== command.validator.id || c.witnessValidation.version !== command.validator.version) return failure(state, 'WITNESS_VALIDATOR_MISMATCH')
      if (!replay && !isTrustedCapability(command.capability, 'WITNESS_VALIDATOR', command.validator.id)) return failure(state, 'UNTRUSTED_WITNESS_CAPABILITY')
      if (!Number.isInteger(command.witnessRevision) || command.witnessRevision < 0) return failure(state, 'INVALID_WITNESS_REVISION'); if (command.witnessRevision < t.witnessRevision) return failure(state, 'WITNESS_REVISION_REGRESSION')
      assertId(command.witnessRefHash, 'witnessRefHash'); assertId(command.relationId, 'relationId')
      const id = `witness:${state.nextWitnessId}`; const witnesses = cloneRecord(state.witnesses); witnesses[id] = deepFreeze({ proofId: id, transitionId: t.transitionId, contractHash: c.contractHash, witnessRevision: command.witnessRevision, witnessRefHash: command.witnessRefHash, relationId: command.relationId, world: state.world, binding: bindingOf(state), validator: command.validator })
      state = deepFreeze({ ...state, witnesses, nextWitnessId: state.nextWitnessId + 1 })
      state = updateTransition(state, { ...t, witnessRevision: command.witnessRevision }, false)
      return success(state, command, 'WITNESS_PROOF_ACCEPTED', command.transitionId, { proofId: id, witnessRevision: command.witnessRevision })
    }
    case 'ACQUIRE_DECLARED_RESOURCES': {
      if (!schedulerAuthorized(command.capability)) return failure(state, 'UNTRUSTED_SCHEDULER')
      const granted = grantDeclared(state, command.transitionId); if (typeof granted === 'string') return failure(state, granted); state = granted
      return success(state, command, 'RESOURCE_BUNDLE_GRANTED', command.transitionId, { leaseIds: state.transitions[command.transitionId]!.heldLeaseIds })
    }
    case 'PAUSE_ACTIVE': {
      if (!schedulerAuthorized(command.capability)) return failure(state, 'UNTRUSTED_SCHEDULER')
      const t = state.transitions[command.transitionId]; if (t === undefined) return failure(state, 'UNKNOWN_TRANSITION'); if (t.lifecycle !== 'ACTIVE') return failure(state, 'ILLEGAL_LIFECYCLE_EDGE'); if (!currentLeaseSetMatchesTransition(state, t)) return failure(state, 'LEASE_STATE_DIVERGENCE')
      if (t.cancelRequested || t.pendingTerminalOutcome !== null) return failure(state, 'TRANSITION_QUIESCING')
      if (hasDispatchInFlight(state, t.transitionId)) return failure(state, 'EFFECT_DISPATCH_IN_FLIGHT')
      if (hasBoundedNonPreemptibleLease(state, t.transitionId)) return failure(state, 'SAFE_YIELD_REQUIRED')
      state = releaseAllLeases(state, t.transitionId); state = quiesceTransitionEffects(state, t.transitionId)
      state = updateTransition(state, { ...t, lifecycle: command.to, heldLeaseIds: [], activeSinceMonoMs: null, blockReason: command.to === 'BLOCKED' ? command.reason : null, suspendReason: null, lifecycleRevision: t.lifecycleRevision + 1 }, true)
      return success(state, command, command.to === 'OBSERVING' ? 'TRANSITION_OBSERVING' : 'TRANSITION_BLOCKED', t.transitionId, { reason: command.reason })
    }
    case 'ACK_PAUSE_YIELD': {
      if (!controllerAuthorized(command.transitionId, command.capability)) return failure(state, 'UNTRUSTED_CONTROLLER')
      const t = state.transitions[command.transitionId]; if (t === undefined || t.lifecycle !== 'ACTIVE') return failure(state, 'ILLEGAL_LIFECYCLE_EDGE')
      if (t.cancelRequested || t.pendingTerminalOutcome !== null) return failure(state, 'TRANSITION_QUIESCING')
      if (hasDispatchInFlight(state, t.transitionId)) return failure(state, 'EFFECT_DISPATCH_IN_FLIGHT')
      if (command.atMonoMs !== state.monotonicMs) return failure(state, 'STALE_YIELD_ACK')
      if (!currentLeaseSetMatchesTransition(state, t)) return failure(state, 'LEASE_STATE_DIVERGENCE')
      const late = leasesFor(state, t.transitionId).some((l) => !l.preemptible && command.atMonoMs > l.hardYieldDeadlineMonoMs!)
      state = releaseAllLeases(state, t.transitionId); state = quiesceTransitionEffects(state, t.transitionId)
      state = updateTransition(state, { ...t, lifecycle: command.to, heldLeaseIds: [], activeSinceMonoMs: null, blockReason: command.to === 'BLOCKED' ? command.reason : null, suspendReason: null, lifecycleRevision: t.lifecycleRevision + 1 }, true)
      return success(state, command, late ? 'PAUSE_LATE_YIELD_COMPLETED' : (command.to === 'OBSERVING' ? 'TRANSITION_OBSERVING' : 'TRANSITION_BLOCKED'), t.transitionId, { reason: command.reason, deadlineViolated: late })
    }
    case 'RESUME_TRANSITION': {
      if (!schedulerAuthorized(command.capability)) return failure(state, 'UNTRUSTED_SCHEDULER')
      const t = state.transitions[command.transitionId]; const c = contractFor(state, command.transitionId); if (t === undefined || c === null) return failure(state, 'UNKNOWN_TRANSITION')
      if (!['SUSPENDED', 'OBSERVING', 'BLOCKED'].includes(t.lifecycle)) return failure(state, 'ILLEGAL_LIFECYCLE_EDGE')
      if (leasesFor(state, t.transitionId).length !== 0) return failure(state, 'NONACTIVE_TRANSITION_HAS_LEASE')
      const pre = activationPreconditions(state, t, c); if (pre !== null) return failure(state, pre)
      state = updateTransition(state, { ...t, lifecycle: 'RUNNABLE', suspendReason: null, blockReason: null, lifecycleRevision: t.lifecycleRevision + 1 }, true)
      return success(state, command, 'TRANSITION_RESUMED_TO_RUNNABLE', t.transitionId, {})
    }
    case 'AGE_RUNNABLE': {
      if (!schedulerAuthorized(command.capability)) return failure(state, 'UNTRUSTED_SCHEDULER')
      const t = state.transitions[command.transitionId]; if (t === undefined) return failure(state, 'UNKNOWN_TRANSITION'); if (t.lifecycle !== 'RUNNABLE') return failure(state, 'ONLY_RUNNABLE_AGES')
      state = updateTransition(state, { ...t, starvationAge: Math.min(199, t.starvationAge + 1) }, false)
      return success(state, command, 'RUNNABLE_AGED', t.transitionId, { age: state.transitions[t.transitionId]!.starvationAge })
    }
    case 'START_PREEMPTION': {
      if (!schedulerAuthorized(command.capability)) return failure(state, 'UNTRUSTED_SCHEDULER')
      const requester = state.transitions[command.requesterId]; const c = contractFor(state, command.requesterId); if (requester === undefined || c === null) return failure(state, 'UNKNOWN_TRANSITION'); if (requester.lifecycle !== 'RUNNABLE') return failure(state, 'REQUESTER_NOT_RUNNABLE')
      const pre = activationPreconditions(state, requester, c); if (pre !== null) return failure(state, pre)
      const conflicts = conflictsFor(state, requester.transitionId, c.claims); if (conflicts.length === 0) return failure(state, 'NO_PREEMPTION_NEEDED')
      const requesterPriority = effectivePriority(state, requester.transitionId); const victimIds = uniqSorted(conflicts.map((l) => l.owner)); const victims: PreemptionVictimPlan[] = []
      for (const victimId of victimIds) {
        const vt = state.transitions[victimId]; const vc = contractFor(state, victimId); if (vt === undefined || vc === null || vt.lifecycle !== 'ACTIVE') return failure(state, 'CONFLICT_OWNER_NOT_ACTIVE'); if (vt.cancelRequested || vt.pendingTerminalOutcome !== null) return failure(state, 'CONFLICT_OWNER_QUIESCING')
        const conflictLeases = conflicts.filter((l) => l.owner === victimId); const victimPriority = effectivePriority(state, victimId)
        if (requesterPriority < victimPriority) return failure(state, 'LOWER_PRIORITY_CANNOT_PREEMPT')
        if (requesterPriority === victimPriority && vt.activeSinceMonoMs !== null && state.monotonicMs - vt.activeSinceMonoMs < state.minResidencyMs && state.materialRevision === vt.materialRevisionAtActivation) return failure(state, 'RESIDENCY_HYSTERESIS')
        const nonPreemptible = conflictLeases.filter((l) => !l.preemptible); const hard = nonPreemptible.length > 0 ? Math.min(...nonPreemptible.map((l) => l.hardYieldDeadlineMonoMs!)) : state.monotonicMs + state.preemptibleYieldBudgetMs
        victims.push(deepFreeze({ transitionId: victimId, contractHash: vc.contractHash, conflictingLeaseIds: conflictLeases.map((l) => l.leaseGrantId).sort(), allLeaseIdsAtPlan: leasesFor(state, victimId).map((l) => l.leaseGrantId), safeYieldAcknowledged: false, acknowledgedAtMonoMs: null, lateYield: false, deadlineViolated: false, inheritedPriority: nonPreemptible.length > 0 && requesterPriority > victimPriority ? requesterPriority : null, resumable: conflictLeases.every((l) => l.resumable), hardYieldDeadlineMonoMs: hard }))
      }
      const id = `preempt:${state.nextPreemptionId}`; const schedulerEpoch = state.schedulerEpoch + 1
      const tx: PreemptionTransaction = deepFreeze({ transactionId: id, requesterId: requester.transitionId, requesterContractHash: c.contractHash, requesterClaimFingerprint: claimFingerprint(c.claims), world: state.world, binding: bindingOf(state), generationId: state.generationId, schedulerEpoch, requestedAtMonoMs: state.monotonicMs, victims, status: 'PLANNED' })
      const preemptions = cloneRecord(state.preemptions); preemptions[id] = tx; state = deepFreeze({ ...state, preemptions, schedulerEpoch, nextPreemptionId: state.nextPreemptionId + 1 })
      return success(state, command, 'PREEMPTION_PLANNED', requester.transitionId, { transactionId: id, victims: victimIds })
    }
    case 'ACK_PREEMPTION_YIELD': {
      if (!controllerAuthorized(command.victimId, command.capability)) return failure(state, 'UNTRUSTED_CONTROLLER')
      const tx = state.preemptions[command.transactionId]; if (tx === undefined) return failure(state, 'UNKNOWN_PREEMPTION'); if (!txCurrent(state, tx)) return failure(state, 'STALE_PREEMPTION')
      const vi = tx.victims.findIndex((v) => v.transitionId === command.victimId); if (vi < 0) return failure(state, 'UNKNOWN_PREEMPTION_VICTIM')
      const victim = tx.victims[vi]!; const currentIds = leasesFor(state, victim.transitionId).map((l) => l.leaseGrantId).sort(); if (canonicalJson(currentIds) !== canonicalJson(victim.allLeaseIdsAtPlan)) return failure(state, 'STALE_PREEMPTION_LEASES')
      if (!command.safeYield) return failure(state, 'SAFE_YIELD_NOT_REACHED')
      if (command.atMonoMs !== state.monotonicMs) return failure(state, 'STALE_YIELD_ACK')
      if (hasDispatchInFlight(state, victim.transitionId)) return failure(state, 'EFFECT_DISPATCH_IN_FLIGHT')
      const late = command.atMonoMs > victim.hardYieldDeadlineMonoMs; const victims = [...tx.victims]; victims[vi] = deepFreeze({ ...victim, safeYieldAcknowledged: true, acknowledgedAtMonoMs: command.atMonoMs, lateYield: late, deadlineViolated: victim.deadlineViolated || late })
      const ready = victims.every((v) => v.safeYieldAcknowledged); const preemptions = cloneRecord(state.preemptions); preemptions[tx.transactionId] = deepFreeze({ ...tx, victims, status: ready ? 'READY' : 'PLANNED' })
      state = revokeUnusedEffects(state, victim.transitionId)
      state = deepFreeze({ ...state, preemptions })
      return success(state, command, late ? 'PREEMPTION_LATE_YIELD_ACKNOWLEDGED' : 'PREEMPTION_YIELD_ACKNOWLEDGED', victim.transitionId, { transactionId: tx.transactionId, deadlineViolated: late, ready })
    }
    case 'COMMIT_PREEMPTION': {
      if (!schedulerAuthorized(command.capability)) return failure(state, 'UNTRUSTED_SCHEDULER')
      const tx = state.preemptions[command.transactionId]; if (tx === undefined) return failure(state, 'UNKNOWN_PREEMPTION'); if (!txCurrent(state, tx)) return failure(state, 'STALE_PREEMPTION'); if (tx.status !== 'READY') return failure(state, 'PREEMPTION_NOT_READY')
      const requester = state.transitions[tx.requesterId]; const rc = contractFor(state, tx.requesterId); if (requester === undefined || rc === null || requester.lifecycle !== 'RUNNABLE') return failure(state, 'REQUESTER_NOT_RUNNABLE')
      if (rc.contractHash !== tx.requesterContractHash || claimFingerprint(rc.claims) !== tx.requesterClaimFingerprint) return failure(state, 'REQUESTER_BUNDLE_CHANGED')
      const plannedVictimIds = new Set(tx.victims.map((v) => v.transitionId)); const conflicts = conflictsFor(state, requester.transitionId, rc.claims); if (conflicts.some((l) => !plannedVictimIds.has(l.owner))) return failure(state, 'UNPLANNED_CONFLICT')
      for (const v of tx.victims) {
        const vt = state.transitions[v.transitionId]; const vc = contractFor(state, v.transitionId); if (vt === undefined || vc === null || vt.lifecycle !== 'ACTIVE' || vc.contractHash !== v.contractHash) return failure(state, 'STALE_VICTIM')
        if (canonicalJson(leasesFor(state, v.transitionId).map((l) => l.leaseGrantId)) !== canonicalJson(v.allLeaseIdsAtPlan)) return failure(state, 'STALE_PREEMPTION_LEASES')
      }
      let next = state
      for (const v of tx.victims) { next = releaseAllLeases(next, v.transitionId); next = quiesceTransitionEffects(next, v.transitionId) }
      const transitions = cloneRecord(next.transitions)
      for (const v of tx.victims) { const vt = transitions[v.transitionId]!; transitions[v.transitionId] = v.resumable ? deepFreeze({ ...vt, lifecycle: 'SUSPENDED', heldLeaseIds: [], suspendReason: `PREEMPTED_BY:${tx.requesterId}`, activeSinceMonoMs: null, lifecycleRevision: vt.lifecycleRevision + 1 }) : deepFreeze({ ...vt, lifecycle: 'TERMINAL', heldLeaseIds: [], terminalOutcome: { kind: 'PREEMPTED_NONRESUMABLE', by: tx.requesterId }, activeSinceMonoMs: null, lifecycleRevision: vt.lifecycleRevision + 1 }) }
      next = deepFreeze({ ...next, transitions, registryRevision: next.registryRevision + 1 })
      const grant = grantDeclared(next, tx.requesterId, true); if (typeof grant === 'string') return failure(state, `ATOMIC_PREEMPTION_GRANT_FAILED:${grant}`); next = grant
      const preemptions = cloneRecord(next.preemptions); preemptions[tx.transactionId] = deepFreeze({ ...tx, status: 'COMMITTED' }); next = deepFreeze({ ...next, preemptions })
      state = next
      return success(state, command, 'PREEMPTION_COMMITTED', tx.requesterId, { transactionId: tx.transactionId, victims: tx.victims.map((v) => v.transitionId), deadlineViolations: tx.victims.filter((v) => v.deadlineViolated).map((v) => v.transitionId) }, [tx.requesterId, ...tx.victims.map((v) => v.transitionId)])
    }
    case 'ISSUE_EFFECT': {
      if (!controllerAuthorized(command.transitionId, command.capability)) return failure(state, 'UNTRUSTED_CONTROLLER')
      const t = state.transitions[command.transitionId]; const c = contractFor(state, command.transitionId); if (t === undefined || c === null) return failure(state, 'UNKNOWN_TRANSITION'); if (t.lifecycle !== 'ACTIVE' || t.cancelRequested || t.pendingTerminalOutcome !== null || preemptionYielded(state, t.transitionId)) return failure(state, 'TRANSITION_NOT_EFFECT_ELIGIBLE'); if (!currentLeaseSetMatchesTransition(state, t)) return failure(state, 'LEASE_STATE_DIVERGENCE')
      const currentPreconditions = activationPreconditions(state, t, c); if (currentPreconditions !== null) return failure(state, currentPreconditions)
      const permit = c.effects.find((p) => p.kind === command.effect && p.scope === command.scope); if (permit === undefined) return failure(state, 'EFFECT_NOT_PERMITTED')
      const usageKey = `${t.transitionId}|${permit.key}`; if ((state.effectUsage[usageKey] ?? 0) >= permit.maxCount) return failure(state, 'EFFECT_MAX_COUNT_EXHAUSTED')
      const required = requiredLeasesForPermit(state, t.transitionId, permit); if (required === null || required.length === 0) return failure(state, 'REQUIRED_EFFECT_LEASE_MISSING')
      if (!Number.isFinite(command.ttlMs) || command.ttlMs <= 0) return failure(state, 'INVALID_EFFECT_TTL')
      const id = `commit:${state.nextCommitId}`; const effects = cloneRecord(state.effects); effects[id] = deepFreeze({ commitId: id, transitionId: t.transitionId, contractHash: c.contractHash, permitKey: permit.key, effect: permit.kind, scope: permit.scope, world: state.world, binding: bindingOf(state), generationId: state.generationId, leaseGrantIds: required.map((l) => l.leaseGrantId), issuedAtMonoMs: state.monotonicMs, expiresAtMonoMs: state.monotonicMs + command.ttlMs, status: 'ISSUED', irreversible: permit.irreversible, dispatchEventSeq: null, observation: null, factIds: [] })
      state = deepFreeze({ ...state, effects, nextCommitId: state.nextCommitId + 1, effectRevision: state.effectRevision + 1 })
      return success(state, command, 'EFFECT_COMMIT_ISSUED', t.transitionId, { commitId: id, permitKey: permit.key })
    }
    case 'BEGIN_EFFECT_DISPATCH': {
      if (!replay && !isTrustedCapability(command.capability, 'DISPATCHER', 'runtime')) return failure(state, 'UNTRUSTED_DISPATCHER')
      const token = state.effects[command.commitId]; if (token === undefined) return failure(state, 'UNKNOWN_EFFECT_COMMIT'); if (token.status !== 'ISSUED') return failure(state, 'EFFECT_COMMIT_NOT_ISSUED'); if (state.monotonicMs > token.expiresAtMonoMs) return failure(state, 'EFFECT_COMMIT_EXPIRED')
      const t = state.transitions[token.transitionId]; const c = contractFor(state, token.transitionId); if (t === undefined || c === null || t.lifecycle !== 'ACTIVE' || t.cancelRequested || t.pendingTerminalOutcome !== null || preemptionYielded(state, t.transitionId)) return failure(state, 'TRANSITION_NOT_EFFECT_ELIGIBLE'); if (c.contractHash !== token.contractHash || !sameWorld(token.world, state.world) || !bindingEqual(token.binding, bindingOf(state)) || token.generationId !== state.generationId) return failure(state, 'STALE_EFFECT_COMMIT')
      const permit = c.effects.find((p) => p.key === token.permitKey); if (permit === undefined) return failure(state, 'PERMIT_REMOVED'); const required = requiredLeasesForPermit(state, t.transitionId, permit); if (required === null || canonicalJson(required.map((l) => l.leaseGrantId).sort()) !== canonicalJson([...token.leaseGrantIds].sort())) return failure(state, 'EFFECT_LEASE_BINDING_CHANGED')
      const usageKey = `${t.transitionId}|${permit.key}`; const used = state.effectUsage[usageKey] ?? 0; if (used >= permit.maxCount) return failure(state, 'EFFECT_MAX_COUNT_EXHAUSTED')
      const effects = cloneRecord(state.effects); effects[token.commitId] = deepFreeze({ ...token, status: 'DISPATCHING', dispatchEventSeq: state.journalSequence + 1 }); const effectUsage = cloneRecord(state.effectUsage); effectUsage[usageKey] = used + 1
      state = deepFreeze({ ...state, effects, effectUsage, effectRevision: state.effectRevision + 1 })
      return success(state, command, 'EFFECT_DISPATCH_LINEARIZED', t.transitionId, { commitId: token.commitId, usage: used + 1, maxCount: permit.maxCount })
    }
    case 'RECONCILE_EFFECT': {
      const token = state.effects[command.commitId]; if (token === undefined) return failure(state, 'UNKNOWN_EFFECT_COMMIT'); if (!['DISPATCHING', 'UNKNOWN'].includes(token.status)) return failure(state, 'EFFECT_NOT_RECONCILABLE')
      if (!replay && !isTrustedCapability(command.capability, 'VERIFIER', command.verifier.id)) return failure(state, 'UNTRUSTED_VERIFIER_CAPABILITY'); if (getVerifier(command.verifier) === null) return failure(state, 'UNKNOWN_VERIFIER')
      const reconciledFactIds = uniqSorted(command.factIds)
      if (command.observation !== 'UNKNOWN') {
        if (!sameWorld(token.world, state.world)) return failure(state, 'EFFECT_WORLD_NOT_RECONCILABLE')
        if (reconciledFactIds.length === 0) return failure(state, 'RECONCILIATION_FACT_REQUIRED')
        const liveBinding = bindingOf(state)
        let directEffectEvidence = false
        for (const factId of reconciledFactIds) {
          const fact = state.facts[factId]
          if (fact === undefined || !sameWorld(fact.world, state.world) || !bindingEqual(fact.binding, liveBinding) || fact.verifier.id !== command.verifier.id || fact.verifier.version !== command.verifier.version) return failure(state, 'UNTRUSTED_RECONCILIATION_FACT')
          if (fact.effectCommitId === token.commitId) directEffectEvidence = true
        }
        if (!directEffectEvidence) return failure(state, 'EFFECT_CAUSAL_EVIDENCE_REQUIRED')
      }
      const effects = cloneRecord(state.effects); effects[token.commitId] = deepFreeze({ ...token, status: command.observation === 'UNKNOWN' ? 'UNKNOWN' : 'OBSERVED', observation: command.observation, factIds: reconciledFactIds }); state = deepFreeze({ ...state, effects, effectRevision: state.effectRevision + 1 })
      return success(state, command, command.observation === 'UNKNOWN' ? 'EFFECT_RECONCILIATION_UNKNOWN' : 'EFFECT_RECONCILED', token.transitionId, { commitId: token.commitId, observation: command.observation })
    }
    case 'REPORT_PROGRESS': {
      const t = state.transitions[command.transitionId]; const c = contractFor(state, command.transitionId); if (t === undefined || c === null) return failure(state, 'UNKNOWN_TRANSITION')
      if (t.lifecycle === 'TERMINAL') return failure(state, 'TRANSITION_NOT_PROGRESS_ELIGIBLE')
      if (command.evaluator.id !== c.progressDefinition.id || command.evaluator.version !== c.progressDefinition.version) return failure(state, 'PROGRESS_DEFINITION_MISMATCH')
      const registered = state.progressRegistry[command.evaluator.id]; if (registered === undefined || registered.version !== command.evaluator.version) return failure(state, 'UNKNOWN_PROGRESS_EVALUATOR')
      if (!replay && !isTrustedCapability(command.capability, 'PROGRESS', command.evaluator.id)) return failure(state, 'UNTRUSTED_PROGRESS_CAPABILITY')
      if (!Number.isInteger(command.progressRevision) || command.progressRevision !== t.progressRevision + 1) return failure(state, 'PROGRESS_REVISION_NOT_NEXT')
      assertId(command.valueHash, 'progress valueHash')
      if (!Number.isFinite(command.observedAtMonoMs) || command.observedAtMonoMs < 0 || command.observedAtMonoMs > state.monotonicMs) return failure(state, 'INVALID_PROGRESS_TIME')
      if (t.progressObservedAtMonoMs !== null && command.observedAtMonoMs < t.progressObservedAtMonoMs) return failure(state, 'PROGRESS_TIME_REGRESSION')
      state = updateTransition(state, { ...t, progressRevision: command.progressRevision, progressValueHash: command.valueHash, progressObservedAtMonoMs: command.observedAtMonoMs }, false)
      return success(state, command, 'PROGRESS_RECORDED', t.transitionId, { progressRevision: command.progressRevision, valueHash: command.valueHash })
    }
    case 'DEBIT_USAGE': {
      if (!controllerAuthorized(command.actorTransitionId, command.capability)) return failure(state, 'UNTRUSTED_CONTROLLER')
      if (command.actorTransitionId !== command.targetTransitionId) return failure(state, 'CROSS_TRANSITION_DEBIT_FORBIDDEN'); const t = state.transitions[command.targetTransitionId]; if (t === undefined || t.lifecycle !== 'ACTIVE' || t.cancelRequested || t.pendingTerminalOutcome !== null || preemptionYielded(state, t.transitionId)) return failure(state, 'TRANSITION_NOT_DEBITABLE')
      const debitContract = contractFor(state, t.transitionId); if (debitContract === null) return failure(state, 'UNKNOWN_TRANSITION')
      let usage = t.usage; if (command.mechanicalSteps !== undefined) { if (!Number.isInteger(command.mechanicalSteps) || command.mechanicalSteps < 0) return failure(state, 'INVALID_MECHANICAL_STEP_DEBIT'); usage = { ...usage, mechanicalSteps: usage.mechanicalSteps + command.mechanicalSteps } }
      if (command.resource !== undefined) { assertId(command.resource.key, 'resource debit key'); if (debitContract.budget.resources[command.resource.key] === undefined) return failure(state, 'UNDECLARED_RESOURCE_BUDGET'); assertFiniteNonNegative(command.resource.amount, 'resource debit'); usage = { ...usage, resources: { ...usage.resources, [command.resource.key]: (usage.resources[command.resource.key] ?? 0) + command.resource.amount } } }
      if (command.risk !== undefined) { assertId(command.risk.key, 'risk debit key'); if (debitContract.budget.risk[command.risk.key] === undefined) return failure(state, 'UNDECLARED_RISK_BUDGET'); assertFiniteNonNegative(command.risk.amount, 'risk debit'); usage = { ...usage, risk: { ...usage.risk, [command.risk.key]: (usage.risk[command.risk.key] ?? 0) + command.risk.amount } } }
      state = updateTransition(state, { ...t, usage: deepFreeze(usage) }, false); state = deepFreeze({ ...state, budgetRevision: state.budgetRevision + 1 }); state = enforceBudgets(state)
      return success(state, command, 'USAGE_DEBITED', t.transitionId, { terminal: state.transitions[t.transitionId]?.lifecycle === 'TERMINAL' })
    }
    case 'ADVANCE_TIME': {
      if (!replay && !isTrustedCapability(command.capability, 'WORLD_ADAPTER', 'clock')) return failure(state, 'UNTRUSTED_CLOCK_CAPABILITY'); if (!Number.isFinite(command.toMonoMs) || command.toMonoMs < state.monotonicMs) return failure(state, 'MONOTONIC_TIME_REGRESSION')
      const delta = command.toMonoMs - state.monotonicMs; const transitions = cloneRecord(state.transitions); let changed = false
      for (const [id, t] of Object.entries(transitions)) if (t.lifecycle === 'ACTIVE') { transitions[id] = deepFreeze({ ...t, usage: deepFreeze({ ...t.usage, activeMs: t.usage.activeMs + delta }) }); changed = true }
      state = deepFreeze({ ...state, monotonicMs: command.toMonoMs, transitions, budgetRevision: state.budgetRevision + (changed ? 1 : 0) }); state = preprocess(state)
      return success(state, command, 'MONOTONIC_TIME_ADVANCED', null, { toMonoMs: command.toMonoMs })
    }
    case 'REQUEST_CANCEL': {
      if (!schedulerAuthorized(command.capability)) return failure(state, 'UNTRUSTED_SCHEDULER')
      const t = state.transitions[command.transitionId]; if (t === undefined || t.lifecycle === 'TERMINAL') return failure(state, 'TRANSITION_NOT_CANCELABLE')
      if (t.pendingTerminalOutcome !== null) return failure(state, 'TERMINAL_OUTCOME_PENDING')
      state = quiesceTransitionEffects(state, t.transitionId)
      const live = state.transitions[t.transitionId]!
      const nonPreemptible = hasBoundedNonPreemptibleLease(state, t.transitionId)
      if (live.lifecycle === 'ACTIVE' && nonPreemptible) { state = updateTransition(state, { ...live, cancelRequested: true, lifecycleRevision: live.lifecycleRevision + 1 }, true); return success(state, command, 'CANCEL_PENDING_SAFE_YIELD', live.transitionId, { reason: command.reason }) }
      state = terminalize(state, live.transitionId, { kind: 'CANCELED', reason: command.reason }); return success(state, command, 'TRANSITION_CANCELED', live.transitionId, { reason: command.reason })
    }
    case 'ACK_CANCEL_YIELD': {
      if (!controllerAuthorized(command.transitionId, command.capability)) return failure(state, 'UNTRUSTED_CONTROLLER')
      const t = state.transitions[command.transitionId]; if (t === undefined || !t.cancelRequested || t.lifecycle !== 'ACTIVE') return failure(state, 'NO_PENDING_CANCEL')
      if (command.atMonoMs !== state.monotonicMs) return failure(state, 'STALE_YIELD_ACK')
      const late = leasesFor(state, t.transitionId).some((l) => !l.preemptible && command.atMonoMs > l.hardYieldDeadlineMonoMs!); state = terminalize(state, t.transitionId, { kind: 'CANCELED', reason: late ? 'cancel safe-yield after critical-section deadline' : 'cancel safe-yield' })
      return success(state, command, late ? 'CANCEL_LATE_YIELD_COMPLETED' : 'CANCEL_YIELD_COMPLETED', t.transitionId, { deadlineViolated: late })
    }
    case 'ACK_TERMINAL_YIELD': {
      if (!controllerAuthorized(command.transitionId, command.capability)) return failure(state, 'UNTRUSTED_CONTROLLER')
      const t = state.transitions[command.transitionId]; if (t === undefined || t.lifecycle !== 'ACTIVE' || t.pendingTerminalOutcome === null) return failure(state, 'NO_PENDING_TERMINAL')
      if (command.atMonoMs !== state.monotonicMs) return failure(state, 'STALE_YIELD_ACK')
      const late = leasesFor(state, t.transitionId).some((l) => !l.preemptible && command.atMonoMs > l.hardYieldDeadlineMonoMs!)
      const outcome = t.pendingTerminalOutcome; state = terminalize(state, t.transitionId, outcome)
      return success(state, command, late ? 'TERMINAL_LATE_YIELD_COMPLETED' : 'TERMINAL_YIELD_COMPLETED', t.transitionId, { deadlineViolated: late, outcome: outcome.kind })
    }
    case 'VERIFY_SUCCESS': {
      const t = state.transitions[command.transitionId]; const c = contractFor(state, command.transitionId); if (t === undefined || c === null) return failure(state, 'UNKNOWN_TRANSITION'); if (t.lifecycle === 'TERMINAL' || t.cancelRequested || t.pendingTerminalOutcome !== null) return failure(state, 'TRANSITION_NOT_VERIFIABLE')
      if (command.verifier.id !== c.verificationDefinition.id || command.verifier.version !== c.verificationDefinition.version) return failure(state, 'VERIFICATION_DEFINITION_MISMATCH')
      if (getVerifier(command.verifier) === null) return failure(state, 'UNKNOWN_VERIFIER')
      if (!replay && !isTrustedCapability(command.capability, 'VERIFIER', command.verifier.id)) return failure(state, 'UNTRUSTED_VERIFIER_CAPABILITY')
      const proofs = proofsCurrentFor(state, [...c.ensures, ...c.invariants], command.verifier); if (!proofs.ok) return failure(state, 'TRUSTED_VERIFY_PROOF_MISSING')
      const outcome: TerminalOutcome = { kind: 'SUCCESS', factIds: proofs.factIds, causalCredit: command.causalCredit }
      state = requestTerminal(state, t.transitionId, outcome)
      const pending = state.transitions[t.transitionId]?.pendingTerminalOutcome !== null
      return success(state, command, pending ? 'VERIFY_SUCCESS_PENDING_SAFE_YIELD' : 'TRANSITION_VERIFIED_SUCCESS', t.transitionId, { factIds: proofs.factIds, ensures: c.ensures, verifier: command.verifier, pendingSafeYield: pending })
    }
    case 'UPDATE_MISSION': {
      if (command.authority.id !== state.missionAuthority.id || command.authority.version !== state.missionAuthority.version) return failure(state, 'MISSION_AUTHORITY_MISMATCH')
      if (!replay && !isTrustedCapability(command.capability, 'MISSION', command.authority.id)) return failure(state, 'UNTRUSTED_MISSION_AUTHORITY')
      for (const predicate of command.predicates) assertId(predicate, 'mission predicate'); const predicates = uniqSorted(command.predicates); state = deepFreeze({ ...state, missionPredicates: predicates, missionRevision: state.missionRevision + 1 })
      const superseded: string[] = []
      for (const t of Object.values(state.transitions)) {
        if (t.lifecycle === 'TERMINAL') continue
        const c = contractFor(state, t.transitionId)
        if (c !== null && !predicates.includes(c.desiredPredicate)) { superseded.push(t.transitionId); state = requestTerminal(state, t.transitionId, { kind: 'MISSION_SUPERSEDED', missionRevision: state.missionRevision }) }
      }
      return success(state, command, 'MISSION_UPDATED', null, { missionRevision: state.missionRevision, predicates, superseded }, superseded)
    }
    case 'CHANGE_GENERATION': {
      if (!replay && !isTrustedCapability(command.capability, 'WORLD_ADAPTER', 'runtime')) return failure(state, 'UNTRUSTED_RUNTIME_CAPABILITY'); assertId(command.generationId, 'generationId'); if (command.generationId === state.generationId) return failure(state, 'GENERATION_UNCHANGED')
      const affected = Object.values(state.transitions).filter((t) => t.lifecycle !== 'TERMINAL' && t.lifecycle !== 'ENABLED').map((t) => t.transitionId)
      let next = state; for (const t of Object.values(state.transitions)) if (t.lifecycle !== 'TERMINAL' && t.lifecycle !== 'ENABLED') {
        // A quiescing transition already has a requested terminal (a verified
        // SUCCESS awaiting safe yield, or a cancel). The old generation can no
        // longer acknowledge that yield, so the requested terminal is honored
        // rather than suspending with pending control state.
        if (t.pendingTerminalOutcome !== null) { next = terminalize(next, t.transitionId, t.pendingTerminalOutcome); continue }
        if (t.cancelRequested) { next = terminalize(next, t.transitionId, { kind: 'CANCELED', reason: 'generation changed during cancel safe-yield' }); continue }
        next = releaseAllLeases(next, t.transitionId); next = quiesceTransitionEffects(next, t.transitionId); const current = next.transitions[t.transitionId]!; next = updateTransition(next, { ...current, lifecycle: 'SUSPENDED', heldLeaseIds: [], suspendReason: 'GENERATION_REBIND_REQUIRED', activeSinceMonoMs: null, lifecycleRevision: current.lifecycleRevision + 1 }, true)
      }
      const preemptions = Object.fromEntries(Object.entries(next.preemptions).map(([id, tx]) => [id, deepFreeze({ ...tx, status: 'STALE' as const })])); state = deepFreeze({ ...next, generationId: command.generationId, preemptions })
      return success(state, command, 'GENERATION_CHANGED', null, { generationId: command.generationId, affected }, affected)
    }
    case 'CHANGE_WORLD': {
      if (!replay && !isTrustedCapability(command.capability, 'WORLD_ADAPTER', 'world')) return failure(state, 'UNTRUSTED_WORLD_CAPABILITY'); assertId(command.world.serverId, 'world.serverId'); assertId(command.world.dimension, 'world.dimension'); assertNonNegativeInteger(command.world.worldEpoch, 'world.worldEpoch'); if (sameWorld(command.world, state.world)) return failure(state, 'WORLD_UNCHANGED')
      const oldWorld = state.world; const affected = Object.values(state.transitions).filter((t) => t.lifecycle !== 'TERMINAL').map((t) => t.transitionId); let next = state; for (const t of Object.values(state.transitions)) if (t.lifecycle !== 'TERMINAL') next = terminalize(next, t.transitionId, { kind: 'WORLD_CHANGED', expected: contractFor(next, t.transitionId)?.world ?? oldWorld, observed: command.world })
      state = deepFreeze({ ...next, world: deepFreeze({ ...command.world }), factRevision: next.factRevision + 1, facts: {}, witnesses: {}, preemptions: {}, leases: {}, effects: Object.fromEntries(Object.entries(next.effects).map(([id, token]) => [id, token.status === 'ISSUED' ? deepFreeze({ ...token, status: 'REVOKED' as const }) : token.status === 'DISPATCHING' ? deepFreeze({ ...token, status: 'UNKNOWN' as const, observation: 'UNKNOWN' as const }) : token])), leaseRevision: next.leaseRevision + 1, effectRevision: next.effectRevision + 1 })
      return success(state, command, 'WORLD_CHANGED', null, { from: oldWorld, to: command.world, affected }, affected)
    }
    case 'APPEND_RECORD': {
      if (!controllerAuthorized(command.transitionId, command.capability)) return failure(state, 'UNTRUSTED_CONTROLLER')
      const t = state.transitions[command.transitionId]; if (t === undefined || t.lifecycle !== 'ACTIVE' || t.cancelRequested || t.pendingTerminalOutcome !== null || preemptionYielded(state, t.transitionId)) return failure(state, 'APPEND_OWNER_NOT_ACTIVE'); const key = resourceKey(command.resource); if (!state.appendResourceKeys.includes(key)) return failure(state, 'RESOURCE_NOT_REGISTERED_APPEND_SAFE')
      const lease = leasesFor(state, t.transitionId).find((l) => l.mode === 'APPEND' && resourcesOverlap(l.resource, command.resource)); if (lease === undefined) return failure(state, 'APPEND_LEASE_REQUIRED')
      assertId(command.operationId, 'operationId'); assertId(command.payloadHash, 'payloadHash'); const store = state.appendStores[key]!; const existingAppend = store.records.find((r) => r.operationId === command.operationId); if (existingAppend !== undefined) { if (existingAppend.payloadHash !== command.payloadHash) return failure(state, 'APPEND_OPERATION_ID_COLLISION'); return success(state, command, 'APPEND_DUPLICATE_SUPPRESSED', t.transitionId, { operationId: command.operationId, revision: store.revision }) }
      const record: AppendRecord = deepFreeze({ operationId: command.operationId, payloadHash: command.payloadHash, transitionId: t.transitionId, eventSeq: state.journalSequence + 1 }); const records = [...store.records, record].sort((a, b) => a.operationId.localeCompare(b.operationId)); const appendStores = cloneRecord(state.appendStores); appendStores[key] = deepFreeze({ resourceKey: key, revision: store.revision + 1, records }); state = deepFreeze({ ...state, appendStores })
      return success(state, command, 'APPEND_MERGED', t.transitionId, { operationId: command.operationId, revision: store.revision + 1 })
    }
    default: return failure(state, 'UNKNOWN_COMMAND')
  }
}

export function applyKernelCommand(state: KernelState, command: KernelCommand): KernelResult {
  if (!KERNEL_STATES.has(state)) return { ok: false, state, reason: 'UNTRUSTED_KERNEL_STATE', events: [] }
  return applyInternal(state, command, false)
}

export function replayKernelEvents(initial: KernelState, events: readonly KernelEvent[]): KernelState {
  if (!KERNEL_STATES.has(initial)) throw new Error('untrusted initial kernel state')
  let state = initial; let expected = initial.journalSequence + 1
  for (const event of events) {
    if (event.eventSeq !== expected) throw new Error(`journal gap: expected ${expected}, got ${event.eventSeq}`)
    const command = event.replay.command as KernelCommand; const result = applyInternal(state, command, true); if (!result.ok) throw new Error(`replay rejected ${event.kind}: ${result.reason}`)
    if (result.events.length !== 1 || canonicalJson(result.events[0]) !== canonicalJson(event)) throw new Error(`replay event mismatch for ${event.kind}`)
    state = result.state; expected += 1
  }
  // Audit replay is intentionally non-authoritative. A caller cannot fabricate a
  // journal and feed the resulting snapshot back into applyKernelCommand().
  return deepFreeze(JSON.parse(JSON.stringify(state)) as KernelState)
}

export function recoverKernelFromJournal(initial: KernelState, events: readonly KernelEvent[], capability: TrustedCapability): KernelState {
  if (!isTrustedCapability(capability, 'JOURNAL', 'recovery')) throw new Error('untrusted journal recovery capability')
  const replayed = replayKernelEvents(initial, events)
  assertKernelInvariants(replayed)
  return markKernelState(replayed)
}

export function kernelSemanticDigest(state: KernelState): string { return sha({ ...state, journalSequence: 0 }) }
export function appendSnapshot(state: KernelState, resource: ResourceId): { readonly revision: number; readonly payloadHashes: readonly string[] } {
  const store = state.appendStores[resourceKey(resource)]; if (store === undefined) throw new Error('unknown append store'); return deepFreeze({ revision: store.revision, payloadHashes: store.records.map((r) => r.payloadHash) })
}
export function currentBinding(state: KernelState): RuntimeBinding { return deepFreeze(bindingOf(state)) }
export function currentEffectivePriority(state: KernelState, transitionId: TransitionId): number { return effectivePriority(state, transitionId) }
export type SchedulerExecutionSelection =
  | { readonly kind: 'CRITICAL_SECTION_OWNER'; readonly transitionId: TransitionId; readonly effectivePriority: number }
  | { readonly kind: 'RUNNABLE'; readonly transitionId: TransitionId; readonly effectivePriority: number }
  | { readonly kind: 'NONE' }
export function selectSchedulerExecution(state: KernelState, candidateIds: readonly TransitionId[]): SchedulerExecutionSelection {
  const inheritedOwners = Object.values(state.preemptions)
    .filter((tx) => (tx.status === 'PLANNED' || tx.status === 'READY') && txCurrent(state, tx))
    .flatMap((tx) => tx.victims)
    .filter((v) => v.inheritedPriority !== null && !v.safeYieldAcknowledged && state.transitions[v.transitionId]?.lifecycle === 'ACTIVE')
    .map((v) => ({ transitionId: v.transitionId, effectivePriority: effectivePriority(state, v.transitionId) }))
    .sort((a, b) => b.effectivePriority - a.effectivePriority || a.transitionId.localeCompare(b.transitionId))
  const inherited = inheritedOwners[0]
  if (inherited !== undefined) return deepFreeze({ kind: 'CRITICAL_SECTION_OWNER', ...inherited })
  const runnable = uniqSorted(candidateIds).filter((id) => state.transitions[id]?.lifecycle === 'RUNNABLE')
    .map((transitionId) => ({ transitionId, effectivePriority: effectivePriority(state, transitionId) }))
    .sort((a, b) => b.effectivePriority - a.effectivePriority || a.transitionId.localeCompare(b.transitionId))[0]
  return runnable === undefined ? deepFreeze({ kind: 'NONE' }) : deepFreeze({ kind: 'RUNNABLE', ...runnable })
}

export interface JevDecisionFrameV412 {
  readonly frameHash: string; readonly schedulerEpoch: number; readonly world: WorldIdentity; readonly binding: RuntimeBinding; readonly materialRevision: number
  readonly enabledTransitionIds: readonly string[]; readonly runnableTransitionIds: readonly string[]; readonly activeTransitionIds: readonly string[]; readonly suspendedTransitionIds: readonly string[]; readonly observingTransitionIds: readonly string[]; readonly blockedTransitionIds: readonly string[]
  readonly leaseDigest: string; readonly effectDigest: string; readonly conflictDigest: string; readonly urgencyDigest: string; readonly witnessDigest: string; readonly factsDigest: string; readonly missionFrontierDigest: string; readonly budgetDigest: string; readonly progressDigest: string; readonly recentOutcomeDigest: string; readonly viabilityDigest: string
  readonly tacticCandidates: Readonly<Record<string, readonly string[]>>
}
export interface JevDecisionV412 { readonly frameHash: string; readonly schedulerEpoch: number; readonly world: WorldIdentity; readonly binding: RuntimeBinding; readonly rankedTransitionIds: readonly string[]; readonly tacticChoices: Readonly<Record<string, string>> }

export function buildJevDecisionFrame(state: KernelState, tacticCandidates: Readonly<Record<string, readonly string[]>>): JevDecisionFrameV412 {
  const normalizedTactics: Record<string, readonly string[]> = {}; for (const [id, tactics] of Object.entries(tacticCandidates)) { if (state.transitions[id] === undefined) throw new Error(`unknown transition in tactic candidates: ${id}`); normalizedTactics[id] = uniqSorted(tactics) }
  const base = {
    schedulerEpoch: state.schedulerEpoch, world: state.world, binding: bindingOf(state), materialRevision: state.materialRevision,
    enabledTransitionIds: Object.values(state.transitions).filter((t) => t.lifecycle === 'ENABLED').map((t) => t.transitionId).sort(),
    runnableTransitionIds: Object.values(state.transitions).filter((t) => t.lifecycle === 'RUNNABLE').map((t) => t.transitionId).sort(),
    activeTransitionIds: Object.values(state.transitions).filter((t) => t.lifecycle === 'ACTIVE').map((t) => t.transitionId).sort(),
    suspendedTransitionIds: Object.values(state.transitions).filter((t) => t.lifecycle === 'SUSPENDED').map((t) => t.transitionId).sort(),
    observingTransitionIds: Object.values(state.transitions).filter((t) => t.lifecycle === 'OBSERVING').map((t) => t.transitionId).sort(),
    blockedTransitionIds: Object.values(state.transitions).filter((t) => t.lifecycle === 'BLOCKED').map((t) => t.transitionId).sort(),
    leaseDigest: sha(state.leases), effectDigest: sha([state.effects, state.effectUsage]),
    conflictDigest: sha(Object.values(state.transitions).filter((t) => t.lifecycle === 'RUNNABLE').map((t) => { const c = contractFor(state, t.transitionId); return [t.transitionId, c === null ? [] : conflictsFor(state, t.transitionId, c.claims).map((l) => l.leaseGrantId).sort()] })),
    urgencyDigest: sha(Object.values(state.transitions).filter((t) => t.lifecycle !== 'TERMINAL').map((t) => { const c = contractFor(state, t.transitionId); return [t.transitionId, c?.class, c?.urgency, effectivePriority(state, t.transitionId), c?.budget.deadlineAtMonoMs, t.starvationAge] })),
    witnessDigest: sha(state.witnesses), factsDigest: sha(state.facts), missionFrontierDigest: sha(state.missionPredicates),
    budgetDigest: sha(Object.values(state.transitions).map((t) => [t.transitionId, t.usage, contractFor(state, t.transitionId)?.budget])),
    progressDigest: sha(Object.values(state.transitions).map((t) => [t.transitionId, state.contracts[t.contractHash]?.progressDefinition, t.progressRevision, t.progressValueHash, t.progressObservedAtMonoMs])), recentOutcomeDigest: sha(Object.values(state.transitions).filter((t) => t.terminalOutcome !== null).map((t) => [t.transitionId, t.terminalOutcome])), viabilityDigest: sha(Object.values(state.transitions).filter((t) => contractFor(state, t.transitionId)?.class === 'VIABILITY').map((t) => [t.transitionId, t.lifecycle, t.usage, t.pendingTerminalOutcome, t.terminalOutcome, leasesFor(state, t.transitionId).map((l) => l.leaseGrantId)])), tacticCandidates: deepFreeze(normalizedTactics),
  }
  const frame = deepFreeze({ ...base, frameHash: sha(base) }); JEV_FRAMES.add(frame); return frame
}
export function admitJevDecision(state: KernelState, frame: JevDecisionFrameV412, decision: JevDecisionV412): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (!JEV_FRAMES.has(frame)) return { ok: false, reason: 'UNTRUSTED_FRAME' }
  const { frameHash: ignored, ...base } = frame; if (frame.frameHash !== sha(base)) return { ok: false, reason: 'FRAME_HASH_MISMATCH' }
  if (!sameWorld(frame.world, state.world) || !sameWorld(decision.world, state.world)) return { ok: false, reason: 'STALE_WORLD' }
  if (frame.schedulerEpoch !== state.schedulerEpoch || decision.schedulerEpoch !== state.schedulerEpoch) return { ok: false, reason: 'STALE_SCHEDULER_EPOCH' }
  if (!bindingEqual(frame.binding, bindingOf(state)) || !bindingEqual(decision.binding, bindingOf(state))) return { ok: false, reason: 'STALE_BINDING' }
  const liveFrame = buildJevDecisionFrame(state, frame.tacticCandidates)
  if (liveFrame.frameHash !== frame.frameHash) return { ok: false, reason: 'STALE_FRAME_STATE' }
  if (decision.frameHash !== frame.frameHash) return { ok: false, reason: 'FRAME_HASH_MISMATCH' }
  if (new Set(decision.rankedTransitionIds).size !== decision.rankedTransitionIds.length) return { ok: false, reason: 'DUPLICATE_RANKING' }
  if (decision.rankedTransitionIds.some((id) => !frame.runnableTransitionIds.includes(id))) return { ok: false, reason: 'UNGROUNDED_TRANSITION_ID' }
  for (const [id, tactic] of Object.entries(decision.tacticChoices)) if (!frame.runnableTransitionIds.includes(id) || !(frame.tacticCandidates[id] ?? []).includes(tactic)) return { ok: false, reason: 'UNGROUNDED_TACTIC' }
  return { ok: true }
}

export function assertKernelInvariants(state: KernelState): void {
  for (const [hash, contract] of Object.entries(state.contracts)) {
    if (hash !== contract.contractHash || !canonicalContractHashValid(contract)) throw new Error(`invalid canonical contract ${hash}`)
  }
  const leasesByOwner = new Map<string, ResourceLease[]>(); for (const lease of Object.values(state.leases)) { const a = leasesByOwner.get(lease.owner) ?? []; a.push(lease); leasesByOwner.set(lease.owner, a); const t = state.transitions[lease.owner]; if (t === undefined || t.lifecycle !== 'ACTIVE') throw new Error(`lease owned by non-ACTIVE ${lease.owner}`); const c = contractFor(state, lease.owner); if (c === null || c.contractHash !== lease.ownerContractHash || !sameWorld(lease.world, state.world) || lease.generationId !== state.generationId) throw new Error(`stale lease ${lease.leaseGrantId}`) }
  const leases = Object.values(state.leases); for (let i = 0; i < leases.length; i += 1) for (let j = i + 1; j < leases.length; j += 1) if (leases[i]!.owner !== leases[j]!.owner && resourcesOverlap(leases[i]!.resource, leases[j]!.resource) && modesConflict(leases[i]!.mode, leases[j]!.mode)) throw new Error('overlapping exclusive authority')
  for (const t of Object.values(state.transitions)) {
    if (state.transitionContracts[t.transitionId] !== t.contractHash || state.contracts[t.contractHash] === undefined) throw new Error(`transition contract binding divergence ${t.transitionId}`)
    const ownedLeases = leasesByOwner.get(t.transitionId) ?? []; const owned = ownedLeases.map((l) => l.leaseGrantId).sort(); if (t.lifecycle === 'ACTIVE' && canonicalJson(owned) !== canonicalJson([...t.heldLeaseIds].sort())) throw new Error(`ACTIVE lease divergence ${t.transitionId}`)
    if (t.lifecycle !== 'ACTIVE' && owned.length > 0) throw new Error(`non-ACTIVE owns leases ${t.transitionId}`)
    if (t.cancelRequested && t.lifecycle !== 'ACTIVE') throw new Error(`cancel-pending non-ACTIVE ${t.transitionId}`)
    if (t.pendingTerminalOutcome !== null && (t.lifecycle !== 'ACTIVE' || !ownedLeases.some((lease) => !lease.preemptible))) throw new Error(`pending terminal without bounded critical authority ${t.transitionId}`)
    if (t.pendingTerminalOutcome !== null && Object.values(state.effects).some((e) => e.transitionId === t.transitionId && e.status === 'ISSUED')) throw new Error(`pending terminal retains unused effect token ${t.transitionId}`)
    if (t.lifecycle === 'TERMINAL' && (t.pendingTerminalOutcome !== null || t.cancelRequested)) throw new Error(`terminal retains pending control state ${t.transitionId}`)
    if (t.lifecycle === 'TERMINAL' && Object.values(state.effects).some((e) => e.transitionId === t.transitionId && (e.status === 'ISSUED' || e.status === 'DISPATCHING'))) throw new Error(`terminal has live token ${t.transitionId}`)
    const c = state.contracts[t.contractHash]!
    for (const permit of c.effects) if ((state.effectUsage[`${t.transitionId}|${permit.key}`] ?? 0) > permit.maxCount) throw new Error(`effect maxCount exceeded ${t.transitionId}:${permit.key}`)
  }
  for (const effect of Object.values(state.effects)) if (effect.status === 'ISSUED' || effect.status === 'DISPATCHING') { const t = state.transitions[effect.transitionId]; if (t === undefined || t.lifecycle !== 'ACTIVE' || !sameWorld(effect.world, state.world) || effect.generationId !== state.generationId || effect.contractHash !== t.contractHash) throw new Error(`stale live effect ${effect.commitId}`) }
  for (const tx of Object.values(state.preemptions)) if ((tx.status === 'PLANNED' || tx.status === 'READY') && txCurrent(state, tx)) for (const victim of tx.victims) if (victim.safeYieldAcknowledged) {
    if (Object.values(state.effects).some((effect) => effect.transitionId === victim.transitionId && (effect.status === 'ISSUED' || effect.status === 'DISPATCHING'))) throw new Error(`yielded preemption victim retains live effect ${victim.transitionId}`)
  }
}
