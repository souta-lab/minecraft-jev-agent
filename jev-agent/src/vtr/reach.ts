import { createHash } from 'node:crypto'
import { resourceMatches } from '../resourceClass.ts'

/** JSON-shaped facts keep the contract independent of Mineflayer and model APIs. */
export type ReachJson = null | boolean | number | string | readonly ReachJson[] | { readonly [key: string]: ReachJson }

/** A grounded proposition. `id` and `proposition` describe the desired fact, not its current witness. */
export interface ReachPredicate {
  readonly id: string
  readonly proposition: ReachJson
  readonly expected: boolean
}

/** Match a source by the Mission's exact item/resource class, never by suffix coincidence. */
export function missionResourceSourceMatches(
  missionItem: string,
  sourceName: string | null | undefined,
  yieldedItem: string | null | undefined,
  knownSourceNames: readonly string[] = [],
): boolean {
  if (sourceName === null || sourceName === undefined) return false
  return (
    sourceName === missionItem ||
    knownSourceNames.includes(sourceName) ||
    resourceMatches(yieldedItem ?? sourceName, missionItem)
  )
}

/** Count either one exact Mission item or all concrete members of a resource class. */
export function countMissionInventoryResource(counts: Readonly<Record<string, number>>, missionItem: string): number {
  return Object.entries(counts).reduce(
    (total, [item, count]) => total + (resourceMatches(item, missionItem) ? count : 0),
    0,
  )
}

/** Identity pinned at commit and checked before every controller update or actuation reservation. */
export interface ReachIdentity {
  readonly worldKey: string
  readonly dimension: string
  readonly worldEpoch: number
  readonly generationId: string
  readonly leaseId: string
}

export type ReachTactic =
  | 'walk'
  | 'path_replan'
  | 'jump'
  | 'detour'
  | 'bridge'
  | 'staircase'
  | 'bounded_terrain_adaptation'

export interface ReachControllerPolicy {
  readonly allowedTactics: readonly ReachTactic[]
  readonly allowTemporaryWaypointChanges: boolean
  readonly allowWitnessSubstitution: boolean
}

/** `maxUses: null` lets the transition-wide mechanical-step budget bound an effect. */
export interface ReachAdmissibleEffect {
  readonly kind: string
  readonly maxUses: number | null
}

export interface ReachBudget {
  readonly maxMechanicalSteps: number
  readonly maxElapsedMs: number
  /** Maximum cumulative positive consumption by resource name. Unlisted resources are forbidden. */
  readonly resources: Readonly<Record<string, number>>
  /** Maximum cumulative risk by named dimension. Unlisted risk dimensions are forbidden. */
  readonly risk: Readonly<Record<string, number>>
}

export interface ReachTransitionContractInput {
  readonly transitionId: string
  readonly desiredPredicate: ReachPredicate
  readonly requires: readonly ReachPredicate[]
  readonly ensures: readonly ReachPredicate[]
  readonly invariants: readonly ReachPredicate[]
  readonly admissibleEffects: readonly ReachAdmissibleEffect[]
  readonly budget: ReachBudget
  readonly controller: ReachControllerPolicy
  readonly identity: ReachIdentity
}

export interface ReachTransitionContract extends ReachTransitionContractInput {
  readonly contractHash: string
  readonly desiredPredicateIdentity: string
  readonly ensuresIdentity: string
}

export type ReachPredicateTruth = 'true' | 'false' | 'unknown'

export interface ReachPredicateEvidence {
  readonly truth: ReachPredicateTruth
  readonly evidenceId: string | null
}

export interface ReachObservation {
  readonly identity: ReachIdentity
  readonly observedAtMs: number
  readonly predicates: Readonly<Record<string, ReachPredicateEvidence>>
}

export interface ReachWitness {
  readonly witnessId: string
  readonly target: ReachJson
  /** Must match the committed desired predicate identity; coordinates/targets are not contract identity. */
  readonly desiredPredicateIdentity: string
  readonly evidenceId: string
  /** Binds the sensor witness to the exact world/dimension/generation/lease that observed it. */
  readonly observedIdentity: ReachIdentity
  readonly observedAtMs: number
}

export interface ReachTemporaryWaypoint {
  readonly waypointId: string
  readonly target: ReachJson
  readonly evidenceId: string
}

export interface ReachProgress {
  /** Predicate-relative distance from verified world observations, never body motion alone. */
  readonly latestPredicateDistance: number | null
  readonly bestPredicateDistance: number | null
  readonly reachability: 'reachable' | 'unreachable' | 'unknown'
  readonly frontierId: string | null
  readonly evidenceId: string | null
  readonly observationSequence: number
}

export interface ReachResourceUse {
  readonly mechanicalSteps: number
  readonly elapsedMs: number
  readonly resources: Readonly<Record<string, number>>
  readonly risk: Readonly<Record<string, number>>
  readonly effects: Readonly<Record<string, number>>
}

export type ReachTerminalOutcome =
  | {
      readonly kind: 'SUCCESS'
      readonly contractHash: string
      readonly desiredPredicateIdentity: string
      readonly verifiedAtMs: number
      readonly evidenceIds: readonly string[]
    }
  | {
      readonly kind: 'BUDGET_EXHAUSTED'
      readonly contractHash: string
      readonly budget: string
      readonly limit: number
      readonly attempted: number
    }
  | {
      readonly kind: 'WORLD_CHANGED'
      readonly contractHash: string
      readonly field: 'worldKey' | 'dimension' | 'worldEpoch'
      readonly expected: string | number
      readonly observed: string | number
    }
  | {
      readonly kind: 'GENERATION_CHANGED'
      readonly contractHash: string
      readonly expected: string
      readonly observed: string
    }
  | {
      readonly kind: 'LEASE_LOST'
      readonly contractHash: string
      readonly expected: string
      readonly observed: string
    }
  | {
      readonly kind: 'PROVEN_INFEASIBLE'
      readonly contractHash: string
      readonly reason: string
      readonly evidenceId: string
    }
  | {
      readonly kind: 'SAFETY_INTERRUPT'
      readonly contractHash: string
      readonly reason: string
      readonly evidenceId: string
    }
  | {
      readonly kind: 'MISSION_SATISFIED'
      readonly contractHash: string
      readonly evidenceId: string
    }
  | {
      readonly kind: 'CONTRACT_SUPERSEDED'
      readonly contractHash: string
      readonly reason: string
      readonly evidenceId: string
    }
  | {
      readonly kind: 'CONTRACT_VIOLATION'
      readonly contractHash: string
      readonly violation:
        | 'contract_state_mismatch'
        | 'transition_not_active'
        | 'invariant_broken'
        | 'inadmissible_effect'
        | 'effect_limit_exceeded'
        | 'resource_not_admissible'
        | 'risk_not_admissible'
        | 'invalid_budget_delta'
        | 'duplicate_actuation_id'
        | 'tactic_not_admissible'
        | 'waypoint_change_not_admissible'
        | 'witness_substitution_not_admissible'
        | 'witness_not_grounded_for_desired_predicate'
        | 'invalid_evidence'
      readonly detail: string
    }

export type ReachTransitionStatus = 'active' | 'terminal'

/** Persistent controller state. Tactical changes do not create a new contract or model decision. */
export interface ReachTransitionState {
  readonly contractHash: string
  readonly identity: ReachIdentity
  readonly status: ReachTransitionStatus
  readonly startedAtMs: number
  readonly controllerRevision: number
  readonly tactic: ReachTactic
  readonly witness: ReachWitness | null
  readonly temporaryWaypoint: ReachTemporaryWaypoint | null
  readonly progress: ReachProgress
  readonly usage: ReachResourceUse
  readonly reservedActuationIds: readonly string[]
  readonly recordedRiskObservationIds: readonly string[]
  readonly terminalOutcome: ReachTerminalOutcome | null
}

export type ReachActiveResult =
  | { readonly status: 'active'; readonly state: ReachTransitionState }
  | { readonly status: 'terminal'; readonly state: ReachTransitionState; readonly outcome: ReachTerminalOutcome }

export type ReachStartResult =
  | ReachActiveResult
  | { readonly status: 'not_enabled'; readonly blockers: readonly string[] }

export type ReachVerificationResult =
  | ReachActiveResult
  | { readonly status: 'pending'; readonly state: ReachTransitionState; readonly reason: string }

export interface ReachActuationRequest {
  readonly actuationId: string
  readonly effectKind: string
  readonly resources: Readonly<Record<string, number>>
  readonly risk: Readonly<Record<string, number>>
  readonly nowMs: number
}

export interface ReachActuationReservation {
  readonly status: 'authorized'
  /** Persist this returned state before allowing the mechanical executor to act. */
  readonly state: ReachTransitionState
  readonly contractHash: string
  readonly actuationId: string
}

export type ReachActuationResult = ReachActuationReservation | Extract<ReachActiveResult, { status: 'terminal' }>

export interface ReachMechanicalStepRequest {
  /** Unique executor leg id; one reservation counts one physical leg against the contract budget. */
  readonly stepId: string
  readonly effectKind: string
  readonly resources: Readonly<Record<string, number>>
  readonly risk: Readonly<Record<string, number>>
  readonly nowMs: number
}

export interface ReachProgressEvidence {
  readonly observation: ReachObservation
  readonly predicateDistance: number | null
  readonly reachability: 'reachable' | 'unreachable' | 'unknown'
  readonly frontierId: string | null
  readonly evidenceId: string
}

function assertNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) throw new Error(`${label} must be non-empty`)
}

function normalizeJson(value: ReachJson): ReachJson {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('contract JSON numbers must be finite')
    return value
  }
  if (Array.isArray(value)) return value.map((entry) => normalizeJson(entry))
  if (typeof value === 'object') {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new Error('contract objects must be plain JSON objects')
    }
    const record = value as { readonly [key: string]: ReachJson }
    const result: Record<string, ReachJson> = {}
    for (const key of Object.keys(record).sort()) result[key] = normalizeJson(record[key]!)
    return result
  }
  throw new Error('contract values must be JSON')
}

function canonicalJson(value: ReachJson): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as { readonly [key: string]: ReachJson }
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key]!)}`).join(',')}}`
}

function fingerprint(value: ReachJson): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child)
    Object.freeze(value)
  }
  return value
}

function normalizePredicate(predicate: ReachPredicate, label: string): ReachPredicate {
  assertNonEmpty(predicate.id, `${label}.id`)
  return freezeDeep({
    id: predicate.id,
    proposition: normalizeJson(predicate.proposition),
    expected: predicate.expected,
  })
}

function normalizePredicates(predicates: readonly ReachPredicate[], label: string): readonly ReachPredicate[] {
  const normalized = predicates.map((predicate) => normalizePredicate(predicate, label)).sort((a, b) => a.id.localeCompare(b.id))
  const seen = new Set<string>()
  for (const predicate of normalized) {
    if (seen.has(predicate.id)) throw new Error(`${label} contains duplicate predicate id: ${predicate.id}`)
    seen.add(predicate.id)
  }
  return freezeDeep(normalized)
}

function samePredicate(a: ReachPredicate, b: ReachPredicate): boolean {
  return canonicalJson(a as unknown as ReachJson) === canonicalJson(b as unknown as ReachJson)
}

function validateIdentity(identity: ReachIdentity): ReachIdentity {
  assertNonEmpty(identity.worldKey, 'identity.worldKey')
  assertNonEmpty(identity.dimension, 'identity.dimension')
  assertNonEmpty(identity.generationId, 'identity.generationId')
  assertNonEmpty(identity.leaseId, 'identity.leaseId')
  if (!Number.isSafeInteger(identity.worldEpoch) || identity.worldEpoch < 0) throw new Error('identity.worldEpoch must be a non-negative safe integer')
  return freezeDeep({ ...identity })
}

function validateBudget(budget: ReachBudget): ReachBudget {
  if (!Number.isSafeInteger(budget.maxMechanicalSteps) || budget.maxMechanicalSteps <= 0) {
    throw new Error('budget.maxMechanicalSteps must be a positive safe integer')
  }
  if (!Number.isFinite(budget.maxElapsedMs) || budget.maxElapsedMs <= 0) throw new Error('budget.maxElapsedMs must be positive and finite')
  const validateLimits = (limits: Readonly<Record<string, number>>, label: string) => {
    const entries = Object.entries(limits).sort(([a], [b]) => a.localeCompare(b))
    for (const [key, limit] of entries) {
      assertNonEmpty(key, `${label} key`)
      if (!Number.isFinite(limit) || limit < 0) throw new Error(`${label}.${key} must be finite and non-negative`)
    }
    return Object.fromEntries(entries)
  }
  return freezeDeep({
    maxMechanicalSteps: budget.maxMechanicalSteps,
    maxElapsedMs: budget.maxElapsedMs,
    resources: validateLimits(budget.resources, 'budget.resources'),
    risk: validateLimits(budget.risk, 'budget.risk'),
  })
}

/**
 * Build an immutable first-class contract. Dynamic positions/entities belong in witnesses,
 * never in `desiredPredicate`; all contract inputs, including identity and bounds, are hashed.
 */
export function createReachTransitionContract(input: ReachTransitionContractInput): ReachTransitionContract {
  assertNonEmpty(input.transitionId, 'transitionId')
  const desiredPredicate = normalizePredicate(input.desiredPredicate, 'desiredPredicate')
  const requires = normalizePredicates(input.requires, 'requires')
  const ensures = normalizePredicates(input.ensures, 'ensures')
  const invariants = normalizePredicates(input.invariants, 'invariants')
  if (!ensures.some((predicate) => predicate.id === desiredPredicate.id && samePredicate(predicate, desiredPredicate))) {
    throw new Error('ensures must include the exact desiredPredicate')
  }
  if (ensures.length === 0) throw new Error('ensures must be non-empty')
  const admissibleEffects = [...input.admissibleEffects]
    .map((effect) => {
      assertNonEmpty(effect.kind, 'admissibleEffects.kind')
      if (effect.maxUses !== null && (!Number.isSafeInteger(effect.maxUses) || effect.maxUses <= 0)) {
        throw new Error(`admissibleEffects.${effect.kind}.maxUses must be null or a positive integer`)
      }
      return { kind: effect.kind, maxUses: effect.maxUses }
    })
    .sort((a, b) => a.kind.localeCompare(b.kind))
  if (new Set(admissibleEffects.map(({ kind }) => kind)).size !== admissibleEffects.length) {
    throw new Error('admissibleEffects contains duplicate kinds')
  }
  if (admissibleEffects.length === 0) throw new Error('admissibleEffects must be non-empty')
  const allowedTactics = [...new Set(input.controller.allowedTactics)].sort()
  if (allowedTactics.length === 0) throw new Error('controller.allowedTactics must be non-empty')
  const controller = freezeDeep({
    allowedTactics,
    allowTemporaryWaypointChanges: input.controller.allowTemporaryWaypointChanges,
    allowWitnessSubstitution: input.controller.allowWitnessSubstitution,
  })
  const normalized = {
    transitionId: input.transitionId,
    desiredPredicate,
    requires,
    ensures,
    invariants,
    admissibleEffects: freezeDeep(admissibleEffects),
    budget: validateBudget(input.budget),
    controller,
    identity: validateIdentity(input.identity),
  }
  const desiredPredicateIdentity = fingerprint(desiredPredicate as unknown as ReachJson)
  const ensuresIdentity = fingerprint(ensures as unknown as ReachJson)
  const contractHash = fingerprint({ schema: 'vtr.reach.contract.v1', ...normalized } as unknown as ReachJson)
  return freezeDeep({ ...normalized, desiredPredicateIdentity, ensuresIdentity, contractHash })
}

function makeOutcomeState(state: ReachTransitionState, outcome: ReachTerminalOutcome): ReachTransitionState {
  return freezeDeep({ ...state, status: 'terminal', terminalOutcome: outcome, controllerRevision: state.controllerRevision + 1 })
}

function terminal(state: ReachTransitionState, outcome: ReachTerminalOutcome): Extract<ReachActiveResult, { status: 'terminal' }> {
  const terminalState = makeOutcomeState(state, outcome)
  return { status: 'terminal', state: terminalState, outcome }
}

function identityMismatch(contract: ReachTransitionContract, observed: ReachIdentity): ReachTerminalOutcome | null {
  const expected = contract.identity
  for (const field of ['worldKey', 'dimension', 'worldEpoch'] as const) {
    if (expected[field] !== observed[field]) {
      return { kind: 'WORLD_CHANGED', contractHash: contract.contractHash, field, expected: expected[field], observed: observed[field] }
    }
  }
  if (expected.generationId !== observed.generationId) {
    return { kind: 'GENERATION_CHANGED', contractHash: contract.contractHash, expected: expected.generationId, observed: observed.generationId }
  }
  if (expected.leaseId !== observed.leaseId) {
    return { kind: 'LEASE_LOST', contractHash: contract.contractHash, expected: expected.leaseId, observed: observed.leaseId }
  }
  return null
}

function predicateBlockers(predicates: readonly ReachPredicate[], observation: ReachObservation): string[] {
  const blockers: string[] = []
  for (const predicate of predicates) {
    const evidence = observation.predicates[predicate.id]
    if (evidence === undefined || evidence.truth === 'unknown' || evidence.evidenceId === null || evidence.evidenceId.trim() === '') {
      blockers.push(`${predicate.id}:unknown`)
    } else if ((evidence.truth === 'true') !== predicate.expected) {
      blockers.push(`${predicate.id}:false`)
    }
  }
  return blockers
}

function emptyUsage(): ReachResourceUse {
  return { mechanicalSteps: 0, elapsedMs: 0, resources: {}, risk: {}, effects: {} }
}

function initialProgress(): ReachProgress {
  return {
    latestPredicateDistance: null,
    bestPredicateDistance: null,
    reachability: 'unknown',
    frontierId: null,
    evidenceId: null,
    observationSequence: 0,
  }
}

/** Commit a contract only when the pinned runtime identity and its declared preconditions hold. */
export function startReachTransition(
  contract: ReachTransitionContract,
  observation: ReachObservation,
  initial: { readonly tactic: ReachTactic; readonly witness?: ReachWitness | null },
): ReachStartResult {
  const mismatch = identityMismatch(contract, observation.identity)
  if (mismatch !== null) {
    const empty: ReachTransitionState = freezeDeep({
      contractHash: contract.contractHash,
      identity: contract.identity,
      status: 'active',
      startedAtMs: observation.observedAtMs,
      controllerRevision: 0,
      tactic: initial.tactic,
      witness: null,
      temporaryWaypoint: null,
      progress: initialProgress(),
      usage: emptyUsage(),
      reservedActuationIds: [],
      recordedRiskObservationIds: [],
      terminalOutcome: null,
    })
    return terminal(empty, mismatch)
  }
  if (!Number.isFinite(observation.observedAtMs) || observation.observedAtMs < 0) {
    throw new Error('observation.observedAtMs must be non-negative and finite')
  }
  const blockers = predicateBlockers(contract.requires, observation)
  if (blockers.length > 0) return { status: 'not_enabled', blockers }
  const invariantBlockers = predicateBlockers(contract.invariants, observation)
  if (invariantBlockers.length > 0) return { status: 'not_enabled', blockers: invariantBlockers.map((value) => `invariant:${value}`) }
  if (!contract.controller.allowedTactics.includes(initial.tactic)) {
    return { status: 'not_enabled', blockers: [`tactic_not_admissible:${initial.tactic}`] }
  }
  const witness = initial.witness ?? null
  if (witness !== null && !witnessGroundedForContract(contract, witness, observation.observedAtMs)) {
    return { status: 'not_enabled', blockers: ['initial_witness_not_grounded_for_desired_predicate'] }
  }
  const state: ReachTransitionState = freezeDeep({
    contractHash: contract.contractHash,
    identity: contract.identity,
    status: 'active',
    startedAtMs: observation.observedAtMs,
    controllerRevision: 0,
    tactic: initial.tactic,
    witness,
    temporaryWaypoint: null,
    progress: initialProgress(),
    usage: emptyUsage(),
    reservedActuationIds: [],
    recordedRiskObservationIds: [],
    terminalOutcome: null,
  })
  return { status: 'active', state }
}

type StateGuard = { readonly ok: true } | { readonly ok: false; readonly outcome: ReachTerminalOutcome }

function guardState(
  contract: ReachTransitionContract,
  state: ReachTransitionState,
  identity: ReachIdentity,
  nowMs: number,
): StateGuard {
  if (state.contractHash !== contract.contractHash) {
    return { ok: false, outcome: { kind: 'CONTRACT_VIOLATION', contractHash: contract.contractHash, violation: 'contract_state_mismatch', detail: 'state belongs to a different immutable contract' } }
  }
  if (state.status !== 'active') {
    return { ok: false, outcome: state.terminalOutcome ?? { kind: 'CONTRACT_VIOLATION', contractHash: contract.contractHash, violation: 'transition_not_active', detail: 'terminal transition cannot actuate or update' } }
  }
  const mismatch = identityMismatch(contract, identity)
  if (mismatch !== null) return { ok: false, outcome: mismatch }
  if (!Number.isFinite(nowMs) || nowMs < state.startedAtMs) {
    return { ok: false, outcome: { kind: 'CONTRACT_VIOLATION', contractHash: contract.contractHash, violation: 'invalid_evidence', detail: 'controller time must be finite and monotonic' } }
  }
  const elapsed = nowMs - state.startedAtMs
  if (elapsed > contract.budget.maxElapsedMs) {
    return {
      ok: false,
      outcome: { kind: 'BUDGET_EXHAUSTED', contractHash: contract.contractHash, budget: 'elapsedMs', limit: contract.budget.maxElapsedMs, attempted: elapsed },
    }
  }
  return { ok: true }
}

function fromGuard(state: ReachTransitionState, guard: StateGuard): Extract<ReachActiveResult, { status: 'terminal' }> | null {
  return guard.ok ? null : terminal(state, guard.outcome)
}

/** Change a controller-local tactic under the same committed ensures and effect/risk contract. */
export function setReachTactic(
  contract: ReachTransitionContract,
  state: ReachTransitionState,
  identity: ReachIdentity,
  tactic: ReachTactic,
  nowMs: number,
): ReachActiveResult {
  const guard = guardState(contract, state, identity, nowMs)
  const blocked = fromGuard(state, guard)
  if (blocked !== null) return blocked
  if (!contract.controller.allowedTactics.includes(tactic)) {
    return terminal(state, { kind: 'CONTRACT_VIOLATION', contractHash: contract.contractHash, violation: 'tactic_not_admissible', detail: tactic })
  }
  return { status: 'active', state: freezeDeep({ ...state, tactic, controllerRevision: state.controllerRevision + 1, usage: { ...state.usage, elapsedMs: nowMs - state.startedAtMs } }) }
}

/** Temporary waypoints are controller state; replacing them never changes desired predicate identity. */
export function setReachTemporaryWaypoint(
  contract: ReachTransitionContract,
  state: ReachTransitionState,
  identity: ReachIdentity,
  waypoint: ReachTemporaryWaypoint | null,
  nowMs: number,
): ReachActiveResult {
  const guard = guardState(contract, state, identity, nowMs)
  const blocked = fromGuard(state, guard)
  if (blocked !== null) return blocked
  if (!contract.controller.allowTemporaryWaypointChanges) {
    return terminal(state, { kind: 'CONTRACT_VIOLATION', contractHash: contract.contractHash, violation: 'waypoint_change_not_admissible', detail: 'contract disallows temporary waypoint changes' })
  }
  if (waypoint !== null && (!waypoint.waypointId.trim() || !waypoint.evidenceId.trim())) {
    return terminal(state, { kind: 'CONTRACT_VIOLATION', contractHash: contract.contractHash, violation: 'invalid_evidence', detail: 'temporary waypoint requires ids and grounding evidence' })
  }
  return { status: 'active', state: freezeDeep({ ...state, temporaryWaypoint: waypoint, controllerRevision: state.controllerRevision + 1, usage: { ...state.usage, elapsedMs: nowMs - state.startedAtMs } }) }
}

/** Substitute a newly observed witness only when it grounds the unchanged desired predicate. */
export function substituteReachWitness(
  contract: ReachTransitionContract,
  state: ReachTransitionState,
  identity: ReachIdentity,
  witness: ReachWitness,
  nowMs: number,
): ReachActiveResult {
  const guard = guardState(contract, state, identity, nowMs)
  const blocked = fromGuard(state, guard)
  if (blocked !== null) return blocked
  if (!contract.controller.allowWitnessSubstitution) {
    return terminal(state, { kind: 'CONTRACT_VIOLATION', contractHash: contract.contractHash, violation: 'witness_substitution_not_admissible', detail: 'contract disallows witness substitution' })
  }
  if (!witnessGroundedForContract(contract, witness, nowMs)) {
    return terminal(state, { kind: 'CONTRACT_VIOLATION', contractHash: contract.contractHash, violation: 'witness_not_grounded_for_desired_predicate', detail: 'replacement witness does not carry matching desired-predicate grounding evidence' })
  }
  return { status: 'active', state: freezeDeep({ ...state, witness: freezeDeep({ ...witness, target: normalizeJson(witness.target) }), controllerRevision: state.controllerRevision + 1, usage: { ...state.usage, elapsedMs: nowMs - state.startedAtMs } }) }
}

function witnessGroundedForContract(
  contract: ReachTransitionContract,
  witness: ReachWitness,
  observationTimeMs: number,
): boolean {
  return typeof witness === 'object' && witness !== null &&
    typeof witness.desiredPredicateIdentity === 'string' && witness.desiredPredicateIdentity === contract.desiredPredicateIdentity &&
    typeof witness.witnessId === 'string' && witness.witnessId.trim() !== '' &&
    typeof witness.evidenceId === 'string' && witness.evidenceId.trim() !== '' &&
    Number.isFinite(observationTimeMs) &&
    Number.isFinite(witness.observedAtMs) && witness.observedAtMs === observationTimeMs &&
    isReachIdentity(witness.observedIdentity) &&
    identityMismatch(contract, witness.observedIdentity) === null &&
    isReachPosition(witness.target) && isFiniteJson(witness.target)
}

function isReachIdentity(identity: unknown): identity is ReachIdentity {
  if (typeof identity !== 'object' || identity === null || Array.isArray(identity)) return false
  const value = identity as Record<string, unknown>
  return typeof value.worldKey === 'string' && value.worldKey.trim() !== '' &&
    typeof value.dimension === 'string' && value.dimension.trim() !== '' &&
    Number.isSafeInteger(value.worldEpoch) && Number(value.worldEpoch) >= 0 &&
    typeof value.generationId === 'string' && value.generationId.trim() !== '' &&
    typeof value.leaseId === 'string' && value.leaseId.trim() !== ''
}

function isReachPosition(value: ReachJson): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const position = value as Readonly<Record<string, ReachJson>>
  return typeof position.x === 'number' && Number.isFinite(position.x) &&
    typeof position.y === 'number' && Number.isFinite(position.y) &&
    typeof position.z === 'number' && Number.isFinite(position.z)
}

function isFiniteJson(value: ReachJson): boolean {
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isFiniteJson)
  if (value !== null && typeof value === 'object') return Object.values(value).every(isFiniteJson)
  return true
}

function validateDelta(delta: Readonly<Record<string, number>>): string | null {
  for (const [key, amount] of Object.entries(delta)) {
    if (key.trim() === '' || !Number.isFinite(amount) || amount < 0) return `invalid delta ${key}`
  }
  return null
}

function addDelta(
  contract: ReachTransitionContract,
  current: Readonly<Record<string, number>>,
  delta: Readonly<Record<string, number>>,
  limits: Readonly<Record<string, number>>,
  label: 'resource' | 'risk',
): { readonly values?: Readonly<Record<string, number>>; readonly outcome?: ReachTerminalOutcome } {
  const invalid = validateDelta(delta)
  if (invalid !== null) return { outcome: { kind: 'CONTRACT_VIOLATION', contractHash: contract.contractHash, violation: 'invalid_budget_delta', detail: invalid } }
  const next = { ...current }
  for (const [key, amount] of Object.entries(delta)) {
    if (!(key in limits)) {
      return { outcome: { kind: 'CONTRACT_VIOLATION', contractHash: contract.contractHash, violation: label === 'resource' ? 'resource_not_admissible' : 'risk_not_admissible', detail: key } }
    }
    const attempted = (current[key] ?? 0) + amount
    const limit = limits[key]!
    if (attempted > limit) {
      return { outcome: { kind: 'BUDGET_EXHAUSTED', contractHash: contract.contractHash, budget: `${label}:${key}`, limit, attempted } }
    }
    next[key] = attempted
  }
  return { values: freezeDeep(next) }
}

/** Reserve a bounded mechanical step before dispatch; denied reservations must not reach an executor. */
export function reserveReachActuation(
  contract: ReachTransitionContract,
  state: ReachTransitionState,
  identity: ReachIdentity,
  request: ReachActuationRequest,
): ReachActuationResult {
  const guard = guardState(contract, state, identity, request.nowMs)
  const blocked = fromGuard(state, guard)
  if (blocked !== null) return blocked
  if (!request.actuationId.trim()) {
    return terminal(state, { kind: 'CONTRACT_VIOLATION', contractHash: contract.contractHash, violation: 'invalid_evidence', detail: 'actuationId must be non-empty' })
  }
  if (state.reservedActuationIds.includes(request.actuationId)) {
    return terminal(state, { kind: 'CONTRACT_VIOLATION', contractHash: contract.contractHash, violation: 'duplicate_actuation_id', detail: request.actuationId })
  }
  if (state.usage.mechanicalSteps >= contract.budget.maxMechanicalSteps) {
    return terminal(state, { kind: 'BUDGET_EXHAUSTED', contractHash: contract.contractHash, budget: 'mechanicalSteps', limit: contract.budget.maxMechanicalSteps, attempted: state.usage.mechanicalSteps + 1 })
  }
  const effect = contract.admissibleEffects.find(({ kind }) => kind === request.effectKind)
  if (effect === undefined) {
    return terminal(state, { kind: 'CONTRACT_VIOLATION', contractHash: contract.contractHash, violation: 'inadmissible_effect', detail: request.effectKind })
  }
  const effectCount = state.usage.effects[request.effectKind] ?? 0
  if (effect.maxUses !== null && effectCount >= effect.maxUses) {
    return terminal(state, { kind: 'CONTRACT_VIOLATION', contractHash: contract.contractHash, violation: 'effect_limit_exceeded', detail: request.effectKind })
  }
  const resourceResult = addDelta(contract, state.usage.resources, request.resources, contract.budget.resources, 'resource')
  if (resourceResult.outcome !== undefined) return terminal(state, resourceResult.outcome)
  const riskResult = addDelta(contract, state.usage.risk, request.risk, contract.budget.risk, 'risk')
  if (riskResult.outcome !== undefined) return terminal(state, riskResult.outcome)
  const nextState = freezeDeep({
    ...state,
    controllerRevision: state.controllerRevision + 1,
    reservedActuationIds: [...state.reservedActuationIds, request.actuationId],
    usage: {
      mechanicalSteps: state.usage.mechanicalSteps + 1,
      elapsedMs: request.nowMs - state.startedAtMs,
      resources: resourceResult.values!,
      risk: riskResult.values!,
      effects: { ...state.usage.effects, [request.effectKind]: effectCount + 1 },
    },
  })
  return { status: 'authorized', state: nextState, contractHash: contract.contractHash, actuationId: request.actuationId }
}

/** Pre-leg callback API: count one executor leg before dispatch using its stable unique id. */
export function recordReachMechanicalStep(
  contract: ReachTransitionContract,
  state: ReachTransitionState,
  identity: ReachIdentity,
  step: ReachMechanicalStepRequest,
): ReachActuationResult {
  return reserveReachActuation(contract, state, identity, {
    actuationId: step.stepId,
    effectKind: step.effectKind,
    resources: step.resources,
    risk: step.risk,
    nowMs: step.nowMs,
  })
}

/** Charge observed risk after a mechanical leg, before VERIFY may issue SUCCESS. */
export function recordReachObservedRisk(
  contract: ReachTransitionContract,
  state: ReachTransitionState,
  identity: ReachIdentity,
  input: { readonly observationId: string; readonly risk: Readonly<Record<string, number>>; readonly nowMs: number },
): ReachActiveResult {
  const guard = guardState(contract, state, identity, input.nowMs)
  const blocked = fromGuard(state, guard)
  if (blocked !== null) return blocked
  if (!input.observationId.trim()) {
    return terminal(state, { kind: 'CONTRACT_VIOLATION', contractHash: contract.contractHash, violation: 'invalid_evidence', detail: 'risk observation id must be non-empty' })
  }
  if (state.recordedRiskObservationIds.includes(input.observationId)) {
    return terminal(state, { kind: 'CONTRACT_VIOLATION', contractHash: contract.contractHash, violation: 'duplicate_actuation_id', detail: `risk:${input.observationId}` })
  }
  const riskResult = addDelta(contract, state.usage.risk, input.risk, contract.budget.risk, 'risk')
  if (riskResult.outcome !== undefined) return terminal(state, riskResult.outcome)
  return {
    status: 'active',
    state: freezeDeep({
      ...state,
      recordedRiskObservationIds: [...state.recordedRiskObservationIds, input.observationId],
      controllerRevision: state.controllerRevision + 1,
      usage: { ...state.usage, elapsedMs: input.nowMs - state.startedAtMs, risk: riskResult.values! },
    }),
  }
}

/** Record navigation-specific, world-grounded progress; it never closes the contract. */
export function recordReachProgress(
  contract: ReachTransitionContract,
  state: ReachTransitionState,
  identity: ReachIdentity,
  input: ReachProgressEvidence,
): ReachActiveResult {
  const guard = guardState(contract, state, identity, input.observation.observedAtMs)
  const blocked = fromGuard(state, guard)
  if (blocked !== null) return blocked
  const mismatch = identityMismatch(contract, input.observation.identity)
  if (mismatch !== null) return terminal(state, mismatch)
  if (!input.evidenceId.trim() || (input.predicateDistance !== null && (!Number.isFinite(input.predicateDistance) || input.predicateDistance < 0))) {
    return terminal(state, { kind: 'CONTRACT_VIOLATION', contractHash: contract.contractHash, violation: 'invalid_evidence', detail: 'progress requires evidence and a finite non-negative predicate distance' })
  }
  const previousBest = state.progress.bestPredicateDistance
  const bestPredicateDistance = input.predicateDistance === null
    ? previousBest
    : previousBest === null ? input.predicateDistance : Math.min(previousBest, input.predicateDistance)
  const progress = freezeDeep({
    latestPredicateDistance: input.predicateDistance,
    bestPredicateDistance,
    reachability: input.reachability,
    frontierId: input.frontierId,
    evidenceId: input.evidenceId,
    observationSequence: state.progress.observationSequence + 1,
  })
  return { status: 'active', state: freezeDeep({ ...state, progress, controllerRevision: state.controllerRevision + 1, usage: { ...state.usage, elapsedMs: input.observation.observedAtMs - state.startedAtMs } }) }
}

/** Only this deterministic predicate check can issue SUCCESS; action results never can. */
export function verifyReachEnsures(
  contract: ReachTransitionContract,
  state: ReachTransitionState,
  observation: ReachObservation,
): ReachVerificationResult {
  const guard = guardState(contract, state, observation.identity, observation.observedAtMs)
  const blocked = fromGuard(state, guard)
  if (blocked !== null) return blocked
  const invariantBlockers = predicateBlockers(contract.invariants, observation)
  const brokenInvariant = invariantBlockers.find((entry) => entry.endsWith(':false'))
  if (brokenInvariant !== undefined) {
    return terminal(state, { kind: 'CONTRACT_VIOLATION', contractHash: contract.contractHash, violation: 'invariant_broken', detail: brokenInvariant })
  }
  if (invariantBlockers.length > 0) return { status: 'pending', state, reason: `invariants_unknown:${invariantBlockers.join(',')}` }
  const ensureBlockers = predicateBlockers(contract.ensures, observation)
  if (ensureBlockers.length > 0) return { status: 'pending', state, reason: `ensures_not_verified:${ensureBlockers.join(',')}` }
  const evidenceIds = contract.ensures.map((predicate) => observation.predicates[predicate.id]?.evidenceId).filter((id): id is string => id !== undefined && id !== null)
  const outcome: ReachTerminalOutcome = {
    kind: 'SUCCESS',
    contractHash: contract.contractHash,
    desiredPredicateIdentity: contract.desiredPredicateIdentity,
    verifiedAtMs: observation.observedAtMs,
    evidenceIds,
  }
  return terminal(state, outcome)
}

/** Explicitly return proven infeasibility to the scheduler with evidence; no generic β decision is involved. */
export function terminateReachAsInfeasible(
  contract: ReachTransitionContract,
  state: ReachTransitionState,
  identity: ReachIdentity,
  input: { readonly reason: string; readonly evidenceId: string; readonly nowMs: number },
): ReachActiveResult {
  const guard = guardState(contract, state, identity, input.nowMs)
  const blocked = fromGuard(state, guard)
  if (blocked !== null) return blocked
  if (!input.reason.trim() || !input.evidenceId.trim()) {
    return terminal(state, { kind: 'CONTRACT_VIOLATION', contractHash: contract.contractHash, violation: 'invalid_evidence', detail: 'proven infeasibility requires reason and evidence id' })
  }
  return terminal(state, { kind: 'PROVEN_INFEASIBLE', contractHash: contract.contractHash, reason: input.reason, evidenceId: input.evidenceId })
}

/** End this contract at a grounded viability boundary so the scheduler can stabilize and re-derive. */
export function interruptReachForSafety(
  contract: ReachTransitionContract,
  state: ReachTransitionState,
  identity: ReachIdentity,
  input: { readonly reason: string; readonly evidenceId: string; readonly nowMs: number },
): ReachActiveResult {
  const guard = guardState(contract, state, identity, input.nowMs)
  const blocked = fromGuard(state, guard)
  if (blocked !== null) return blocked
  if (!input.reason.trim() || !input.evidenceId.trim()) {
    return terminal(state, { kind: 'CONTRACT_VIOLATION', contractHash: contract.contractHash, violation: 'invalid_evidence', detail: 'safety interrupt requires reason and evidence id' })
  }
  return terminal(state, { kind: 'SAFETY_INTERRUPT', contractHash: contract.contractHash, reason: input.reason, evidenceId: input.evidenceId })
}

/** Hand the child navigation contract back when its parent Mission predicate is already true. */
export function finishReachForMissionSatisfied(
  contract: ReachTransitionContract,
  state: ReachTransitionState,
  identity: ReachIdentity,
  input: { readonly evidenceId: string; readonly nowMs: number },
): ReachActiveResult {
  const guard = guardState(contract, state, identity, input.nowMs)
  const blocked = fromGuard(state, guard)
  if (blocked !== null) return blocked
  if (!input.evidenceId.trim()) {
    return terminal(state, { kind: 'CONTRACT_VIOLATION', contractHash: contract.contractHash, violation: 'invalid_evidence', detail: 'mission completion handoff requires evidence' })
  }
  return terminal(state, { kind: 'MISSION_SATISFIED', contractHash: contract.contractHash, evidenceId: input.evidenceId })
}

/** End a child Transition when its scheduler-owned assumptions are explicitly replaced. */
export function supersedeReachTransition(
  contract: ReachTransitionContract,
  state: ReachTransitionState,
  identity: ReachIdentity,
  input: { readonly reason: string; readonly evidenceId: string; readonly nowMs: number },
): ReachActiveResult {
  const guard = guardState(contract, state, identity, input.nowMs)
  const blocked = fromGuard(state, guard)
  if (blocked !== null) return blocked
  if (!input.reason.trim() || !input.evidenceId.trim()) {
    return terminal(state, { kind: 'CONTRACT_VIOLATION', contractHash: contract.contractHash, violation: 'invalid_evidence', detail: 'supersession requires a reason and evidence' })
  }
  return terminal(state, { kind: 'CONTRACT_SUPERSEDED', contractHash: contract.contractHash, reason: input.reason, evidenceId: input.evidenceId })
}
