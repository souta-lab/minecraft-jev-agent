// jevSemanticProjection.ts - issue #437: the Skill <-> Jev semantic boundary.
//
// #436 makes a selected Skill execute many mechanical steps. #437 owns what
// information crosses back into policy:
//
//   compact semantic state -> Jev pi -> Skill executes many steps
//   -> ONE typed SkillOutcomePacket -> next semantic decision
//
// This module is the single owner of that boundary:
//
//   * `SkillOutcomePacket`  (§1/§2) the bounded causal handoff object;
//   * `JevDecisionEpochs`   (§3)    causal isolation for policy: only the ACTIVE
//                                   epoch may authorize a commitment, and a late
//                                   model result from an older epoch is dropped;
//   * `semanticCandidateKey`/`dedupeSemanticCandidates` (§4/§8) stable identity
//                                   keyed on Option instance + Skill kind +
//                                   semantic target identity + meaningful
//                                   params/postcondition, never on transient
//                                   realization cells;
//   * `buildJevSemanticProjection` / `projectionHash` (§5/§7/§9) the versioned,
//                                   meaningfully-bounded state Jev sees;
//   * the seven §12 markers, kept on the raw-evidence plane so a reviewer can
//                                   reconstruct what Jev knew and why it was
//                                   asked again.
//
// #11 boundary this module must never cross (§11: the compressor owns
// REPRESENTATION, not preference):
//
//   * it never ranks candidates, never hides a valid semantic alternative
//     (dedup only collapses alternatives that are semantically EQUIVALENT -
//     MINE vs DETOUR vs PILLAR stay distinct choices because their kind and
//     target identity differ), never rewrites failure into success, never turns
//     TARGET_LOST into TARGET_KILLED, and never invents an Option or target;
//   * it contains no recovery ladder and no strategy list;
//   * Jev still chooses WHICH candidate: the projection only removes mechanical
//     telemetry (swing counts, path nodes, hotbar slots, physics ticks, retries,
//     body jitter) that is not a policy event.
//
// #436 coordination (lane 10ab585c): `src/skillCommitment.ts` owns the
// structural `SkillCommitment` / `CausalTargetIdentity` / `EffectEnvelope`
// contract that authorizes mechanical effects. When that module lands, this
// module imports its `SkillKind`/`CausalTargetIdentity` and this module's
// `SemanticTargetRef.key` is fed from `targetIdentityKey(...)`; the
// `SkillOutcomePacket` shape below does not change, only the source of two
// fields. This module deliberately does NOT define envelopes, budgets or
// authorization: it names the epoch/commitment an outcome closes.
import { createHash } from 'node:crypto'
import type { Candidate, CandidateKind } from './candidates.ts'

// ---------------------------------------------------------------------------
// §12 observability: the two planes and their markers
// ---------------------------------------------------------------------------

/**
 * RAW EXECUTION TELEMETRY (audit plane, never model input): every path node,
 * swing, hotbar move, GUI click, retry and physics event stays in the run log
 * (`ACTION`/`SKILL_STEP`/executor lines). Keep it.
 *
 * JEV SEMANTIC PROJECTION (model plane): exactly what crossed the boundary -
 * `JEV_STATE_PROJECTION` + `JEV_CANDIDATE_SET` + `SKILL_OUTCOME_PACKET` + the
 * epoch lifecycle. A reviewer reconstructs: what Jev knew, what it chose, what
 * mechanics happened, what semantic facts came back, why Jev was called again.
 */
export const JEV_DECISION_EPOCH_START = 'JEV_DECISION_EPOCH_START'
export const JEV_STATE_PROJECTION = 'JEV_STATE_PROJECTION'
export const JEV_CANDIDATE_SET = 'JEV_CANDIDATE_SET'
export const JEV_DECISION_EPOCH_END = 'JEV_DECISION_EPOCH_END'
export const SKILL_OUTCOME_PACKET = 'SKILL_OUTCOME_PACKET'
export const STALE_JEV_RESULT_DROPPED = 'STALE_JEV_RESULT_DROPPED'
/**
 * §3/§12: the moment the ACTIVE decision epoch authorizes a commitment, i.e. the
 * selected Skill becomes allowed to produce mechanical effects. Emitted by this
 * lane because §3 ("only the currently active epoch may authorize a new
 * SkillCommitment") is this lane's contract; the #436 `skillCommitment.ts` lane
 * owns the envelope/budget the commitment carries. The name is deliberately the
 * one #436's closure metrics already count (`tools/skill-closure-metrics.mjs`
 * reads `SKILL_COMMIT`), so the two lanes agree on one marker rather than two.
 */
export const SKILL_COMMIT = 'SKILL_COMMIT'

/** Every marker this module emits, for the controller's mirrored-marker list. */
export const JEV_BOUNDARY_MARKERS: readonly string[] = [
  JEV_DECISION_EPOCH_START,
  JEV_STATE_PROJECTION,
  JEV_CANDIDATE_SET,
  SKILL_COMMIT,
  SKILL_OUTCOME_PACKET,
  JEV_DECISION_EPOCH_END,
  STALE_JEV_RESULT_DROPPED,
]

/** Version of the projection contract. Bump only with a shape/semantics change. */
export const JEV_PROJECTION_VERSION = 2
export const JEV_PROJECTION_SCHEMA = 'jev-semantic-projection/v2'

/**
 * Semantic (not temporal) bounds. A 20-minute run cannot produce a materially
 * larger Jev input than a 2-minute run in the same semantic situation, because
 * every field below is capped by meaning, and raw counts survive only in
 * `counts` as evidence.
 */
export const JEV_PROJECTION_LIMITS = {
  recentOutcomes: 3,
  facts: 12,
  meaningfulDelta: 6,
  candidates: 48,
  inventoryItems: 64,
  realizationsPerIdentity: 4,
  failuresExposed: 16,
} as const

// ---------------------------------------------------------------------------
// §2 SkillOutcomePacket
// ---------------------------------------------------------------------------

/** §2 terminal reasons. A closed set: no free-form "failed" bucket. */
export type SkillTerminalReason =
  | 'done'
  | 'blocked'
  | 'drop_not_acquired'
  | 'target_lost'
  | 'safety_interrupted'
  | 'capability_lost'
  | 'budget_exhausted'
  | 'world_changed'
  | 'lease_revoked'

export interface VerificationSummary {
  /** deterministic postcondition check for THIS commitment */
  verified: boolean
  /** the declared postcondition that was (or was not) verified */
  postcondition: string
  detail: string | null
}

export interface ProgressSummary {
  kind: 'verified' | 'search' | 'mechanical' | 'none' | 'regressed'
  /** the executor's own bounded progress metric, unchanged in meaning */
  delta: number
  note: string | null
}

export interface SemanticDelta {
  /** the semantic fact that changed, e.g. `inventory.blaze_rod`, `world.dimension` */
  fact: string
  from: string | number | boolean | null
  to: string | number | boolean | null
}

export interface GroundedFact {
  /** closed fact kind, e.g. `target`, `route`, `resource`, `station`, `safety` */
  kind: string
  /** stable identity of the fact */
  key: string
  /** one-line evidence */
  detail: string
}

export interface TypedFailure {
  code: string
  reason: string
}

export interface SkillOutcomePacket {
  decisionEpoch: number
  commitmentId: string
  optionInstanceId: string
  selectedCandidateId: string
  skillKind: CandidateKind
  targetIdentity: SemanticTargetRef
  terminalReason: SkillTerminalReason
  verification: VerificationSummary
  semanticProgress: ProgressSummary
  meaningfulWorldDelta: SemanticDelta[]
  newFacts: GroundedFact[]
  failure?: TypedFailure
  nextDecisionRequired: boolean
  /**
   * #437 §9 evidence, not policy: how many raw mechanical observations were
   * compressed into this one packet. It never influences the decision.
   */
  compressedSteps?: number
}

/**
 * The projection-level identity of a target: a stable KEY, not a full causal
 * contract. `skillCommitment.ts` (#436 Phase 1) owns the structural
 * `CausalTargetIdentity` that authorizes effects; this type is what the
 * projection, the candidate identity and the dedup key on.
 */
export interface SemanticTargetRef {
  kind: 'entity' | 'block' | 'position' | 'item' | 'portal_site' | 'resource' | 'route' | 'none'
  /** stable semantic key; never a body-relative or transient realization cell */
  key: string
  /** human-readable evidence */
  label: string
}

/** Executor status/failure -> §2 terminal reason. ONE mapping, pure. */
export function terminalReasonFor(input: {
  status: 'done' | 'failed' | 'cancelled' | 'guard-rejected' | string
  failure: string | null
  verified: boolean
}): SkillTerminalReason {
  // The exact target died, but its declared inventory postcondition did not.
  // Keep this distinct even if a malformed caller also claims done/verified.
  if (input.failure === 'drop_not_acquired') return 'drop_not_acquired'
  if (input.status === 'cancelled') return 'lease_revoked'
  if (input.status === 'guard-rejected') {
    // A deterministic guard refusal is a typed mechanical blocker of THIS Skill.
    return input.failure === 'TARGET_GONE' ? 'target_lost' : 'blocked'
  }
  if (input.status === 'done') {
    if (input.verified) return 'done'
    // The executor reports `done` for some bounded mechanical steps that have no
    // physical postcondition (WAIT), and for steps whose postcondition could not
    // be observed. Those are NOT verified completion - never rewrite failure
    // into success (§11).
    return input.failure === null ? 'done' : 'blocked'
  }
  switch (input.failure) {
    case null:
      return 'blocked'
    case 'target_gone':
    case 'target_entity_gone':
    case 'entity_gone':
    // #436 section 9: a vanished/invalid entity is TARGET_LOST, and a bounded
    // combat lease that expired or was preempted maps onto the §2 buckets rather
    // than the generic `blocked` fallback.
    case 'target_despawned':
    case 'target_invalidated':
      return 'target_lost'
    case 'combat_interrupted':
      return 'safety_interrupted'
    case 'combat_timeout':
      return 'budget_exhausted'
    case 'submerged':
    case 'combat_unsafe':
    case 'critical_health':
    case 'lava_risk':
    case 'drowning':
      return 'safety_interrupted'
    case 'item_unavailable':
    case 'dig_no_tool':
    case 'capability_invalidated':
    case 'no_tool':
      return 'capability_lost'
    case 'path_timeout':
    case 'dig_timeout':
    case 'smelt_timeout':
    case 'timeout':
      return 'budget_exhausted'
    case 'world_changed':
    case 'dimension_changed':
      return 'world_changed'
    case 'lease_revoked':
      return 'lease_revoked'
    default:
      // A bounded mechanical failure of THIS Skill: a return to policy, never a
      // licence for code to pick another strategy (§436 section 15).
      return 'blocked'
  }
}

/** True when the packet hands authority back to policy (§6). */
export function policyBoundary(packet: Pick<SkillOutcomePacket, 'terminalReason'>): boolean {
  return packet.terminalReason !== 'done'
}

/**
 * §6 mandatory boundaries: outcomes where the premise of the previous decision
 * is destroyed, so policy MUST be re-asked even if the projection happens to
 * look similar. `blocked`/`budget_exhausted` are deliberately NOT here: a
 * repeated identical mechanical failure is §5 "identical retry telemetry", and
 * the projection already carries it (banded failure state + previous outcome),
 * so repeated identical retries do not each buy a Jev call.
 */
const MANDATORY_POLICY_BOUNDARIES: ReadonlySet<SkillTerminalReason> = new Set<SkillTerminalReason>([
  'target_lost',
  'drop_not_acquired',
  'capability_lost',
  'safety_interrupted',
  'world_changed',
  'lease_revoked',
])

export function mandatoryPolicyBoundary(reason: SkillTerminalReason): boolean {
  return MANDATORY_POLICY_BOUNDARIES.has(reason)
}

/**
 * The commitment reference used by the CURRENT architecture: the executor's
 * action lease identity (candidate id + executor action epoch). When #436
 * Phase 1 lands, `commitmentId` is sourced from `SkillCommitment.commitmentId`
 * and this helper is deleted - the packet field does not change.
 */
export function commitmentRefFor(input: { candidateId: string; epoch: number }): string {
  return `a${input.epoch}:${input.candidateId}`
}

export interface SkillOutcomePacketInput {
  decisionEpoch: number
  commitmentId: string
  optionInstanceId: string | null
  selectedCandidateId: string
  skillKind?: CandidateKind
  targetIdentity: SemanticTargetRef
  status: 'done' | 'failed' | 'cancelled' | 'guard-rejected' | string
  failure: string | null
  verified: boolean
  postcondition?: string
  verificationDetail?: string | null
  progressDelta?: number
  progressed?: boolean
  /** a verified partial result changed the search frontier but did not complete the Skill */
  searchProgress?: boolean
  meaningfulWorldDelta?: readonly SemanticDelta[]
  newFacts?: readonly GroundedFact[]
  nextDecisionRequired?: boolean
  compressedSteps?: number
  /** true when the whole Option is complete, so no further decision is needed */
  optionComplete?: boolean
}

/** Build the §2 handoff object. Pure; bounded by the caller-supplied deltas. */
export function buildSkillOutcomePacket(input: SkillOutcomePacketInput): SkillOutcomePacket {
  const terminalReason = terminalReasonFor({
    status: input.status,
    failure: input.failure,
    verified: input.verified,
  })
  const progressDelta = input.progressDelta ?? 0
  const progressKind: ProgressSummary['kind'] =
    input.verified && progressDelta > 0
      ? 'verified'
      : input.searchProgress === true
        ? 'search'
        : input.progressed === true
          ? 'mechanical'
          : progressDelta < 0
            ? 'regressed'
            : 'none'
  const packet: SkillOutcomePacket = {
    decisionEpoch: input.decisionEpoch,
    commitmentId: input.commitmentId,
    optionInstanceId: input.optionInstanceId ?? 'none',
    selectedCandidateId: input.selectedCandidateId,
    skillKind: input.skillKind ?? 'WAIT',
    targetIdentity: input.targetIdentity,
    terminalReason,
    verification: {
      verified: input.verified && terminalReason === 'done',
      postcondition: input.postcondition ?? 'declared_postcondition',
      detail: input.verificationDetail ?? null,
    },
    semanticProgress: {
      kind: progressKind,
      delta: progressDelta,
      note:
        input.searchProgress === true
          ? 'verified_target_death_drop_not_acquired'
          : input.progressed === true && !input.verified
            ? 'mechanical_body_change_only'
            : null,
    },
    meaningfulWorldDelta: [...(input.meaningfulWorldDelta ?? [])].slice(0, JEV_PROJECTION_LIMITS.meaningfulDelta),
    newFacts: [...(input.newFacts ?? [])].slice(0, JEV_PROJECTION_LIMITS.facts),
    nextDecisionRequired: input.nextDecisionRequired ?? !(terminalReason === 'done' && input.optionComplete === true),
  }
  if (terminalReason !== 'done' || input.failure !== null) {
    packet.failure = { code: input.failure ?? terminalReason, reason: describeTerminal(terminalReason, input.failure) }
  }
  if (typeof input.compressedSteps === 'number' && Number.isFinite(input.compressedSteps)) {
    packet.compressedSteps = Math.max(0, Math.floor(input.compressedSteps))
  }
  return packet
}

function describeTerminal(reason: SkillTerminalReason, failure: string | null): string {
  if (failure === 'drop_not_acquired') {
    return 'the selected entity died, but the declared item did not enter the inventory'
  }
  if (failure !== null) return failure
  switch (reason) {
    case 'target_lost':
      return 'the selected target is no longer present (TARGET_LOST, not killed)'
    case 'safety_interrupted':
      return 'a hard safety condition preempted the commitment'
    case 'capability_lost':
      return 'the capability the commitment required is no longer available'
    case 'budget_exhausted':
      return 'the commitment budget was exhausted'
    case 'drop_not_acquired':
      return 'the selected entity died, but its declared item was not acquired'
    case 'world_changed':
      return 'the world/dimension/epoch changed under the commitment'
    case 'lease_revoked':
      return 'the actuation lease was revoked'
    case 'blocked':
      return 'the commitment stopped at a typed mechanical blocker'
    case 'done':
      return 'completed'
  }
}

/** `SKILL_OUTCOME_PACKET` line: the ONE semantic result crossing the boundary. */
export function formatSkillOutcomePacket(packet: SkillOutcomePacket): string {
  const failure = packet.failure === undefined ? '' : ` failure=${packet.failure.code}:${packet.failure.reason}`
  const steps = packet.compressedSteps === undefined ? '' : ` compressedSteps=${packet.compressedSteps}`
  return (
    `${SKILL_OUTCOME_PACKET} epoch=${packet.decisionEpoch} commitmentId=${packet.commitmentId} ` +
    `optionInstanceId=${packet.optionInstanceId} candidateId=${packet.selectedCandidateId} ` +
    `skillKind=${packet.skillKind} targetIdentity=[${packet.targetIdentity.kind}:${packet.targetIdentity.key}] ` +
    `terminalReason=${packet.terminalReason} verified=${packet.verification.verified} ` +
    `progress=${packet.semanticProgress.kind}:${packet.semanticProgress.delta} ` +
    `delta=${packet.meaningfulWorldDelta.length} newFacts=${packet.newFacts.length} ` +
    `nextDecisionRequired=${packet.nextDecisionRequired}${failure}${steps}`
  )
}

// ---------------------------------------------------------------------------
// §4/§8 stable candidate identity and semantic deduplication
// ---------------------------------------------------------------------------

export interface SemanticIdentityContext {
  /** canonical Option instance the candidates belong to (null before one exists) */
  optionInstanceId: string | null
  dimension: string
  worldEpoch: number
}

/** Meaningful `meta` keys: parameters/postconditions that change the SEMANTICS. */
const MEANINGFUL_META_KEYS: readonly string[] = [
  'count',
  'craftCount',
  'craftItem',
  'approachLeg',
  'approachResource',
  'knownName',
  'optionSkill',
  'prerequisiteRole',
  'missingCapability',
  'goalDrop',
  'food',
  'foodTarget',
  'verticalRecovery',
  'strategy',
  'purpose',
  'requiresTable',
  'tableSource',
  'furnaceSource',
  'placementAxis',
]

function cellKey(position: { x: number; y: number; z: number }): string {
  return `${position.x},${position.y},${position.z}`
}

function metaString(candidate: Candidate, key: string): string | null {
  const value = candidate.meta[key]
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return null
}

/**
 * §4: the semantic target identity of a candidate. The rule is:
 *
 *   - the exact cell IS the semantic target for MINE/PLACE/DESCEND/STEP/IGNITE
 *     (the world mutation is the choice);
 *   - a remembered resource is identified by its NAME, not by whichever cell the
 *     retrieval currently stands on;
 *   - a locomotion leg is identified by its grounded `approachTarget`/`approachLeg`
 *     anchor (the destination it realizes), not by the stand cell it picked;
 *   - an entity is identified by its exact entity id, never its mob type.
 */
export function semanticTargetRef(candidate: Candidate): SemanticTargetRef {
  switch (candidate.kind) {
    case 'ATTACK': {
      const entityId = candidate.targetEntityId ?? -1
      const drop = metaString(candidate, 'goalDrop')
      const label = `${candidate.targetName ?? 'entity'}#${entityId}`
      return {
        kind: 'entity',
        key: drop === null ? `e${entityId}` : `e${entityId}:drop=${drop}`,
        label,
      }
    }
    case 'MINE':
    case 'DESCEND':
    case 'STEP':
    case 'IGNITE': {
      const cell = candidate.target === null ? 'none' : cellKey(candidate.target)
      const name = candidate.targetName ?? candidate.itemName ?? 'block'
      return { kind: 'block', key: `${name}@${cell}`, label: `${name} at ${cell}` }
    }
    case 'PLACE': {
      const cells = (candidate.placementCells ?? (candidate.target === null ? [] : [candidate.target]))
        .map(cellKey)
        .sort()
      const name = candidate.itemName ?? 'block'
      return { kind: 'block', key: `${name}@${cells.join('+')}`, label: `place ${name} at ${cells.join('+')}` }
    }
    case 'ENTER_PORTAL': {
      const cell = candidate.target === null ? 'none' : cellKey(candidate.target)
      return { kind: 'portal_site', key: `portal@${cell}`, label: `portal entry ${cell}` }
    }
    case 'CONTAINER': {
      // A container interaction is identified by the CONTAINER (its truthful
      // `name@x,y,z` ref), never by the item chosen out of it: opening the same
      // chest for a second stack is the same semantic target, and a different
      // chest is a different one. The item, when there is one, is a parameter
      // (`semanticParamKey`), not the target identity.
      const ref = metaString(candidate, 'containerRef') ?? `${candidate.targetName ?? 'container'}@${candidate.target === null ? 'none' : cellKey(candidate.target)}`
      const action = metaString(candidate, 'containerAction') ?? 'open'
      const item = candidate.itemName
      return {
        kind: 'block',
        key: ref,
        label: action === 'withdraw' && item !== null ? `take ${item} from ${ref}` : `open ${ref}`,
      }
    }
    case 'PICKUP': {
      // A dropped item is identified by its exact entity id, like an ATTACK
      // target: the cell is not stable (the stack drifts while it falls) and the
      // item NAME is not unique (two stacks of the same item can be on the
      // ground at once). The name travels in the key as the readable half.
      const entityId = candidate.targetEntityId ?? -1
      const item = candidate.itemName ?? candidate.targetName ?? 'item'
      return { kind: 'entity', key: `e${entityId}:pickup=${item}`, label: `pick up ${item}#${entityId}` }
    }
    case 'MOVE':
    case 'RETREAT':
    case 'RETRIEVE': {
      const approachTarget = metaString(candidate, 'approachTarget')
      const approachLeg = metaString(candidate, 'approachLeg')
      if (approachTarget !== null) {
        const reason = approachLeg ?? 'leg'
        return {
          kind: 'position',
          key: `approach:${reason}->${approachTarget}`,
          label: `${reason} to ${approachTarget}`,
        }
      }
      const knownName = metaString(candidate, 'knownName')
      if (knownName !== null) {
        return { kind: 'resource', key: `resource:${knownName}`, label: `remembered ${knownName}` }
      }
      const cell = candidate.target === null ? 'none' : cellKey(candidate.target)
      return { kind: 'position', key: `cell:${cell}`, label: `destination ${cell}` }
    }
    case 'CRAFT':
    case 'SMELT': {
      const item = candidate.itemName ?? candidate.targetName ?? 'unknown'
      const count = metaString(candidate, 'count') ?? metaString(candidate, 'craftCount')
      return { kind: 'item', key: `item:${item}${count === null ? '' : `x${count}`}`, label: `${item}${count === null ? '' : ` x${count}`}` }
    }
    case 'EQUIP':
    case 'EAT': {
      const item = candidate.itemName ?? candidate.targetName ?? 'unknown'
      const slot = candidate.kind === 'EQUIP' ? metaString(candidate, 'slot') : null
      return { kind: 'item', key: `item:${item}${slot === null ? '' : `:${slot}`}`, label: item }
    }
    case 'WAIT':
    case 'ESCALATE':
      return { kind: 'none', key: 'control', label: candidate.kind.toLowerCase() }
  }
}

/** The meaningful parameters/postcondition anchor of a candidate (§4). */
export function semanticParamKey(candidate: Candidate): string {
  const parts: string[] = []
  const item = candidate.itemName
  if (item !== null) parts.push(`item=${item}`)
  if (candidate.requiresTool) parts.push(`tool=${candidate.toolName ?? 'required'}:${candidate.toolTier ?? 'any'}`)
  for (const key of MEANINGFUL_META_KEYS) {
    const value = metaString(candidate, key)
    // approachTarget/approachLeg already form the target identity; keeping them
    // out of the param key avoids double-counting the same semantic fact.
    if (value === null || key === 'approachTarget' || key === 'approachLeg') continue
    parts.push(`${key}=${value}`)
  }
  return parts.length === 0 ? 'params=none' : parts.sort().join('|')
}

/**
 * §4: the stable semantic identity of one candidate realization. Two candidates
 * with the same key are mechanically equivalent realizations of the SAME Jev
 * choice; two candidates with different keys stay distinct choices (#11).
 */
export function semanticCandidateKey(candidate: Candidate, ctx: SemanticIdentityContext): string {
  const target = semanticTargetRef(candidate)
  return [
    `opt=${ctx.optionInstanceId ?? 'none'}`,
    `skill=${candidate.kind}`,
    `target=${target.kind}:${target.key}`,
    semanticParamKey(candidate),
  ].join('|')
}

export interface SemanticCandidateView {
  /** §4 stable identity (what the projection hash and the log key on) */
  identity: string
  /** the concrete candidate id Jev may answer with (a real realization) */
  id: string
  kind: CandidateKind
  label: string
  targetName: string | null
  inReach: boolean
  /** raw decayed failure count: model-visible evidence */
  failureCount: number
  /**
   * §5 banded failure state. The cache key uses the BAND, never the raw count:
   * failure #4 and #5 of an identical retry are the same semantic situation,
   * while none -> some -> many are three genuinely different ones.
   */
  failureBand: FailureBand
  /** other concrete realizations collapsed into this identity (bounded evidence) */
  realizations: readonly string[]
}

export type FailureBand = 'none' | 'some' | 'many'

export function failureBandOf(count: number): FailureBand {
  if (!Number.isFinite(count) || count <= 0) return 'none'
  return count >= 3 ? 'many' : 'some'
}

export interface SemanticDedupeResult {
  /** the representatives offered to Jev, in input order */
  offered: Candidate[]
  /** representative candidate id -> stable identity */
  views: Map<string, SemanticCandidateView>
  /** identity -> every realization id collapsed into it, in input order */
  groups: Map<string, string[]>
  /** how many realizations were collapsed away */
  merged: number
}

/**
 * §8: collapse mechanically-equivalent realizations before asking Jev. The
 * representative is the FIRST offered realization (input order is deterministic
 * and code-owned); this is presentation dedup, never a preference - every
 * collapsed realization is provably the same semantic choice, and the executor
 * still receives the full grounded set.
 */
export function dedupeSemanticCandidates(
  candidates: readonly Candidate[],
  ctx: SemanticIdentityContext,
  failureCount: (candidateId: string) => number = () => 0,
  limit: number = JEV_PROJECTION_LIMITS.candidates,
): SemanticDedupeResult {
  const offered: Candidate[] = []
  const views = new Map<string, SemanticCandidateView>()
  const groups = new Map<string, string[]>()
  const representativeByIdentity = new Map<string, string>()
  let merged = 0
  for (const candidate of candidates) {
    const identity = semanticCandidateKey(candidate, ctx)
    const existing = groups.get(identity)
    if (existing !== undefined) {
      existing.push(candidate.id)
      merged += 1
      const view = views.get(representativeByIdentity.get(identity) as string)
      if (view !== undefined && view.realizations.length < JEV_PROJECTION_LIMITS.realizationsPerIdentity) {
        views.set(view.id, { ...view, realizations: [...view.realizations, candidate.id] })
      }
      continue
    }
    groups.set(identity, [candidate.id])
    representativeByIdentity.set(identity, candidate.id)
    if (offered.length >= limit) continue
    offered.push(candidate)
    const count = failureCount(candidate.id)
    views.set(candidate.id, {
      identity,
      id: candidate.id,
      kind: candidate.kind,
      label: candidate.label,
      targetName: candidate.targetName,
      inReach: candidate.inReach,
      failureCount: count,
      failureBand: failureBandOf(count),
      realizations: [],
    })
  }
  return { offered, views, groups, merged }
}

/**
 * The §4 candidate set Jev sees: stable identities + one concrete id per
 * identity. Mechanical realization ids beyond the representative are evidence.
 */
export function semanticCandidateSet(
  candidates: readonly Candidate[],
  ctx: SemanticIdentityContext,
  failureCount: (candidateId: string) => number = () => 0,
): { views: SemanticCandidateView[]; dedupe: SemanticDedupeResult } {
  const dedupe = dedupeSemanticCandidates(candidates, ctx, failureCount)
  const views = dedupe.offered
    .map((candidate) => dedupe.views.get(candidate.id))
    .filter((view): view is SemanticCandidateView => view !== undefined)
  return { views, dedupe }
}

// ---------------------------------------------------------------------------
// §5/§7/§9 the semantic projection
// ---------------------------------------------------------------------------

export interface SemanticGoalFacts {
  /** stable goal key (target item + count + queue row id) */
  key: string
  targetItem: string | null
  have: number
  required: number
  complete: boolean
  progress: number
}

export interface SemanticOptionFacts {
  instanceId: string | null
  templateId: string | null
  /** the Option's own declared skills/phase, when one exists */
  skillKind: string | null
  targetKey: string | null
}

export interface SemanticWorldFacts {
  dimension: string
  worldEpoch: number
  generationId: string | null
  leaseHeld: boolean
  /** a dimension/epoch change invalidates the active epoch and the cache key */
  alive: boolean
}

export interface SemanticSafetyFacts {
  /** banded health (`healthy`/`hurt`/`low`/`critical`/`dead`), never raw HP churn */
  healthBand: string
  foodBand: string
  /** banded breath (`full`/`low`/`critical`/`unknown`): a drowning body is a hard
   *  safety condition, so it is semantic even though air is a raw number */
  airBand: string
  /** the body is in water (a hard safety envelope the candidate layer restricts on) */
  submerged: boolean | null
  /** bounded danger state from the threat tracker */
  threatKey: string | null
  criticalDamageKey: string | null
  /** last observed damage event, so a hit is never hidden by banding */
  lastDamageKey: string | null
}

/**
 * Progress/exhaustion facts the model already reasons over (beta's #360
 * `strategicNonProgress` evidence + the failure counters). They are part of the
 * model-visible semantic state, so they MUST be part of the projection hash: a
 * stall that advances is a reason to re-ask policy, while an identical retry is
 * not (§5).
 */
export interface SemanticProgressFacts {
  consecutiveFailures: number
  lastFailureCode: string | null
  escalationRecommended: boolean
  oscillationsDetected: number
  stallExhausted: boolean | null
  stallDistinctStates: number | null
}

/**
 * §5/§10: the sensed world in SEMANTIC form. The model payload also carries the
 * exact nearest blocks/entities as bounded evidence, but the DECISION key must
 * change when a new resource or a new threat appears and stay stable while a mob
 * wanders one block or a sensed cell is re-scanned. Names + range bands are the
 * semantic answer; cells and distances are realization detail.
 */
export interface SemanticSenseFacts {
  /** distinct sensed block names (bounded), sorted: a new resource/terrain fact */
  blockNames: string[]
  /** distinct hostile kinds with a range band (bounded), sorted: a new threat fact */
  threats: string[]
}

export interface PreviousDecisionFacts {
  selectedCandidateId: string | null
  selectedIdentity: string | null
  skillKind: string | null
  targetKey: string | null
  commitmentId: string | null
  terminalReason: SkillTerminalReason | null
  failureCode: string | null
  progressKind: ProgressSummary['kind'] | null
}

export interface CompactOutcome {
  decisionEpoch: number
  identity: string | null
  skillKind: string | null
  targetKey: string | null
  terminalReason: SkillTerminalReason
  progressKind: ProgressSummary['kind']
  failureCode: string | null
}

export interface SemanticProjectionInput {
  goal: SemanticGoalFacts
  option: SemanticOptionFacts
  world: SemanticWorldFacts
  safety: SemanticSafetyFacts
  progress: SemanticProgressFacts
  /** sensed world in semantic form; omitted means "not observed" */
  sense?: SemanticSenseFacts
  inventory: Readonly<Record<string, number>>
  /**
   * Raw recent events, filtered to meaningful KINDS with identical retries
   * collapsed (§5). A repeated `failure path_timeout` is one fact, not a churn
   * stream, and never changes the hash by itself.
   */
  events?: readonly string[]
  candidates: readonly Candidate[]
  identityContext: SemanticIdentityContext
  failureCount?: (candidateId: string) => number
  previous?: PreviousDecisionFacts | null
  /** bounded previous packets (§7: previous N semantic Skill outcomes) */
  recentOutcomes?: readonly SkillOutcomePacket[]
  meaningfulDelta?: readonly SemanticDelta[]
  facts?: readonly GroundedFact[]
  /** evidence-only raw telemetry counters (never model policy input) */
  rawTelemetry?: { skillSteps?: number; events?: number }
}

export interface JevSemanticProjection {
  schema: string
  version: number
  goal: SemanticGoalFacts
  option: SemanticOptionFacts
  world: SemanticWorldFacts
  safety: SemanticSafetyFacts
  progress: SemanticProgressFacts
  sense: SemanticSenseFacts | null
  events: string[]
  inventory: Record<string, number>
  inventoryTruncated: boolean
  /** §4 candidate identities, deterministically ordered */
  candidates: SemanticCandidateView[]
  previousDecision: PreviousDecisionFacts | null
  meaningfulDelta: SemanticDelta[]
  recentOutcomes: CompactOutcome[]
  facts: GroundedFact[]
  counts: {
    candidatesOffered: number
    candidatesMerged: number
    rawSkillSteps: number
    rawEvents: number
  }
}

function bandHealth(health: number): string {
  if (health <= 0) return 'dead'
  if (health <= 4) return 'critical'
  if (health <= 10) return 'low'
  if (health <= 16) return 'hurt'
  return 'healthy'
}

function bandFood(food: number): string {
  if (food <= 0) return 'starving'
  if (food <= 6) return 'low'
  if (food <= 14) return 'ok'
  return 'full'
}

export function healthBand(health: number): string {
  return bandHealth(health)
}

export function foodBand(food: number): string {
  return bandFood(food)
}

/** `undefined` air means "not observed"; `full` is the vanilla 300-tick ceiling. */
export function airBand(air: number | null | undefined): string {
  if (air === null || air === undefined || !Number.isFinite(air)) return 'unknown'
  if (air <= 40) return 'critical'
  if (air <= 140) return 'low'
  return 'full'
}

function boundedInventory(
  inventory: Readonly<Record<string, number>>,
): { counts: Record<string, number>; truncated: boolean } {
  const entries = Object.entries(inventory)
    .filter(([, count]) => typeof count === 'number' && Number.isFinite(count) && count !== 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const truncated = entries.length > JEV_PROJECTION_LIMITS.inventoryItems
  const counts: Record<string, number> = {}
  for (const [name, count] of entries.slice(0, JEV_PROJECTION_LIMITS.inventoryItems)) counts[name] = count
  return { counts, truncated }
}

function compactOutcome(packet: SkillOutcomePacket): CompactOutcome {
  return {
    decisionEpoch: packet.decisionEpoch,
    identity: null,
    skillKind: packet.skillKind,
    targetKey: `${packet.targetIdentity.kind}:${packet.targetIdentity.key}`,
    terminalReason: packet.terminalReason,
    progressKind: packet.semanticProgress.kind,
    failureCode: packet.failure?.code ?? null,
  }
}

/**
 * §9: the bounded semantic state Jev sees. Every field is a meaning, never a
 * mechanical tick: no `tick`, no raw position floats, no path nodes, no swing
 * counts, no hotbar/GUI mechanics, no retry telemetry.
 */
export function buildJevSemanticProjection(input: SemanticProjectionInput): JevSemanticProjection {
  const { views, dedupe } = semanticCandidateSet(
    input.candidates,
    input.identityContext,
    input.failureCount,
  )
  const { counts, truncated } = boundedInventory(input.inventory)
  // The derived world facts of a candidate are part of the semantic state: a new
  // resource/route/station fact changes the decision problem (§5).
  const facts = boundedFacts(input.facts ?? [])
  return {
    schema: JEV_PROJECTION_SCHEMA,
    version: JEV_PROJECTION_VERSION,
    goal: { ...input.goal },
    option: { ...input.option },
    world: { ...input.world },
    safety: { ...input.safety },
    progress: { ...input.progress },
    sense: boundedSense(input.sense),
    events: meaningfulEventKinds(input.events ?? []),
    inventory: counts,
    inventoryTruncated: truncated,
    candidates: views,
    previousDecision: input.previous ?? null,
    meaningfulDelta: [...(input.meaningfulDelta ?? [])].slice(0, JEV_PROJECTION_LIMITS.meaningfulDelta),
    recentOutcomes: [...(input.recentOutcomes ?? [])]
      .slice(-JEV_PROJECTION_LIMITS.recentOutcomes)
      .map(compactOutcome),
    facts,
    counts: {
      candidatesOffered: input.candidates.length,
      candidatesMerged: dedupe.merged,
      rawSkillSteps: input.rawTelemetry?.skillSteps ?? 0,
      rawEvents: input.rawTelemetry?.events ?? 0,
    },
  }
}

/** Range bands for a sensed threat: contact/near/far, never a raw distance. */
export function threatBand(distance: number | null | undefined): string {
  if (distance === null || distance === undefined || !Number.isFinite(distance)) return 'unknown'
  if (distance <= 2) return 'contact'
  if (distance <= 8) return 'near'
  return 'far'
}

function boundedSense(sense: SemanticSenseFacts | undefined): SemanticSenseFacts | null {
  if (sense === undefined) return null
  return {
    blockNames: [...new Set(sense.blockNames)].sort().slice(0, 12),
    threats: [...new Set(sense.threats)].sort().slice(0, 6),
  }
}

function boundedFacts(facts: readonly GroundedFact[]): GroundedFact[] {
  const seen = new Set<string>()
  const out: GroundedFact[] = []
  for (const fact of facts) {
    const id = `${fact.kind}:${fact.key}`
    if (seen.has(id)) continue
    seen.add(id)
    out.push(fact)
    if (out.length >= JEV_PROJECTION_LIMITS.facts) break
  }
  return out
}

/**
 * §5 meaningful-delta filter for the event plane. Raw event strings carry
 * candidate ids and coordinates, so an identical retry would look like a new
 * fact every tick. Each event is reduced to its KIND (`failure:path_timeout`,
 * `guard:TARGET_GONE`, `goal_impossible`, `dug`, ...), duplicates collapse, and
 * only the most recent distinct kinds survive. This is representation only: a
 * genuinely NEW kind of failure is still a new semantic fact.
 */
export function meaningfulEventKinds(events: readonly string[], limit = 6): string[] {
  const kinds: string[] = []
  for (const event of events) {
    const kind = eventKind(event)
    if (kind === null || kinds.includes(kind)) continue
    kinds.push(kind)
  }
  // Keep the MOST RECENT distinct kinds: the tail is what the decision needs.
  return kinds.slice(-limit)
}

function eventKind(event: string): string | null {
  const trimmed = event.trim()
  if (trimmed.length === 0) return null
  const tokens = trimmed.split(/\s+/)
  const first = tokens[0] ?? ''
  switch (first) {
    case 'failure':
      return `failure:${normalizeToken(tokens[1] ?? 'unknown')}`
    case 'guard':
      return `guard:${normalizeToken(tokens[1] ?? 'unknown')}`
    case 'dug':
      return 'dug'
    case 'goal':
      return tokens[1] === 'impossible' ? 'goal_impossible' : 'goal'
    case 'all':
      return 'candidates_exhausted'
    default:
      // Markers already carry a typed kind as their first token. Drop any
      // trailing coordinate/id payload so repeated identical telemetry is one
      // fact.
      return /^[A-Z][A-Z0-9_]{2,}$/.test(first) ? first : normalizeToken(first)
  }
}

function normalizeToken(token: string): string {
  // Strip separators/coordinates entirely (`path_timeout:` -> `path_timeout`) so
  // two spellings of the same typed failure collapse to one kind.
  return token.replace(/[^A-Za-z0-9_]/g, '').slice(0, 32)
}

/**
 * The hashable CORE of a projection. Mechanical realization detail (`id`,
 * `label`, `realizations`, `counts`) is EXCLUDED: tiny body jitter must not
 * change the projection hash, while any model-visible semantic change must.
 */
function projectionCore(projection: JevSemanticProjection): Record<string, unknown> {
  const previous = projection.previousDecision
  return {
    schema: projection.schema,
    version: projection.version,
    goal: projection.goal,
    option: projection.option,
    world: projection.world,
    safety: projection.safety,
    progress: projection.progress,
    sense: projection.sense,
    events: projection.events,
    inventory: projection.inventory,
    inventoryTruncated: projection.inventoryTruncated,
    candidates: projection.candidates
      .map((view) => ({
        identity: view.identity,
        kind: view.kind,
        targetName: view.targetName,
        // §5: the BAND, not the raw retry count - identical retries are the same
        // semantic situation, while none/some/many are three different ones.
        failureBand: view.failureBand,
      }))
      .sort((a, b) => (a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0)),
    // §4/§5: the causal previous-outcome block WITHOUT the mechanical realization
    // id, the action-lease commitment id or the epoch counter. Those churn per
    // decision while the semantic situation is identical.
    previousDecision:
      previous === null
        ? null
        : {
            selectedIdentity: previous.selectedIdentity,
            skillKind: previous.skillKind,
            targetKey: previous.targetKey,
            terminalReason: previous.terminalReason,
            failureCode: previous.failureCode,
            progressKind: previous.progressKind,
          },
    meaningfulDelta: projection.meaningfulDelta,
    recentOutcomes: projection.recentOutcomes.map((outcome) => ({
      identity: outcome.identity,
      skillKind: outcome.skillKind,
      targetKey: outcome.targetKey,
      terminalReason: outcome.terminalReason,
      progressKind: outcome.progressKind,
      failureCode: outcome.failureCode,
    })),
    facts: projection.facts,
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) out[key] = canonicalize(record[key])
    return out
  }
  return value
}

/** §5/§10: the single versioned hash of everything Jev can see. */
export function projectionHash(projection: JevSemanticProjection): string {
  const digest = createHash('sha256').update(JSON.stringify(canonicalize(projectionCore(projection)))).digest('hex')
  return `jp${JEV_PROJECTION_VERSION}:${digest.slice(0, 16)}`
}

/** Evidence-only projection size (bounded by semantics, not run duration). */
export function projectionBytes(projection: JevSemanticProjection): number {
  return Buffer.byteLength(JSON.stringify(projection))
}

/**
 * §1/§9/§10: the MODEL-VISIBLE projection. `counts` is evidence for the
 * `JEV_STATE_PROJECTION` log line - how much mechanical churn was compressed -
 * and is deliberately NOT policy input: a raw `SKILL_STEP`/event count is exactly
 * the telemetry §1 keeps out of the prompt. Stripping it here also makes the
 * model payload's top-level keys exactly the keys `projectionCore` hashes, so the
 * cache key and the payload provably cannot drift (§10). The remaining
 * sub-object reductions inside `projectionCore` (raw `failureCount`, mechanical
 * `id`/`label`, and the collapsed `realizations`) are the documented §4/§5
 * churn-only fields, which cannot change WHICH semantic option is correct.
 */
export function projectionModelView(projection: JevSemanticProjection): Omit<JevSemanticProjection, 'counts'> {
  const { counts: _evidenceOnly, ...view } = projection
  return view
}

/**
 * §4/§10: translate a REPLAYED decision onto the current offer.
 *
 * A semantic identity is stable across mechanical churn, but the *representative
 * realization id* it maps to is not (§4: identity is "not transient
 * implementation coordinates"). A cache hit therefore returns the same semantic
 * CHOICE, which must be re-pointed at the current representative - otherwise the
 * replay names a cell that is no longer grounded and no commitment can be claimed
 * for it. This changes no preference: dedup already proved the realizations
 * equivalent, so the identity the model chose is the identity replayed.
 *
 * Verdict:
 *  - `repointed`  the same identity is still offered under a different real id;
 *  - neither flag  the id was not a semantic candidate choice (WAIT, reflex, ...);
 *  - `lost`       the chosen identity is GONE, which is a genuine semantic change
 *                 and must be re-queried instead of replayed.
 */
export function repointReplayedChoice(
  chosenId: string | null,
  previousViews: readonly SemanticCandidateView[],
  currentViews: readonly SemanticCandidateView[],
): { chosenId: string | null; repointed: boolean; lost: boolean } {
  if (chosenId === null) return { chosenId: null, repointed: false, lost: false }
  const previous = previousViews.find((view) => view.id === chosenId)
  // Not a semantic candidate selection: nothing to translate, keep it verbatim.
  if (previous === undefined) return { chosenId, repointed: false, lost: false }
  const current = currentViews.find((view) => view.identity === previous.identity)
  if (current === undefined) return { chosenId, repointed: false, lost: true }
  return { chosenId: current.id, repointed: current.id !== chosenId, lost: false }
}

/** Deterministic diff of two projections: the meaningful world delta (§5/§7). */
export function diffSemanticProjections(
  previous: JevSemanticProjection | null,
  current: JevSemanticProjection,
): { delta: SemanticDelta[]; newFacts: GroundedFact[] } {
  if (previous === null) return { delta: [], newFacts: boundedFacts(current.facts) }
  const delta: SemanticDelta[] = []
  const push = (fact: string, from: unknown, to: unknown): void => {
    if (delta.length >= JEV_PROJECTION_LIMITS.meaningfulDelta) return
    if (stableScalar(from) === stableScalar(to)) return
    delta.push({ fact, from: scalar(from), to: scalar(to) })
  }
  push('goal.key', previous.goal.key, current.goal.key)
  push('goal.progress', previous.goal.progress, current.goal.progress)
  push('goal.complete', previous.goal.complete, current.goal.complete)
  push('option.instanceId', previous.option.instanceId, current.option.instanceId)
  push('option.skillKind', previous.option.skillKind, current.option.skillKind)
  push('option.targetKey', previous.option.targetKey, current.option.targetKey)
  push('world.dimension', previous.world.dimension, current.world.dimension)
  push('world.worldEpoch', previous.world.worldEpoch, current.world.worldEpoch)
  push('world.leaseHeld', previous.world.leaseHeld, current.world.leaseHeld)
  push('safety.healthBand', previous.safety.healthBand, current.safety.healthBand)
  push('safety.foodBand', previous.safety.foodBand, current.safety.foodBand)
  push('safety.airBand', previous.safety.airBand, current.safety.airBand)
  push('safety.submerged', previous.safety.submerged, current.safety.submerged)
  push('safety.threatKey', previous.safety.threatKey, current.safety.threatKey)
  push('safety.criticalDamageKey', previous.safety.criticalDamageKey, current.safety.criticalDamageKey)
  push('safety.lastDamageKey', previous.safety.lastDamageKey, current.safety.lastDamageKey)
  push('progress.consecutiveFailures', previous.progress.consecutiveFailures, current.progress.consecutiveFailures)
  push('progress.lastFailureCode', previous.progress.lastFailureCode, current.progress.lastFailureCode)
  push('progress.escalationRecommended', previous.progress.escalationRecommended, current.progress.escalationRecommended)
  push('progress.stallExhausted', previous.progress.stallExhausted, current.progress.stallExhausted)
  push('progress.stallDistinctStates', previous.progress.stallDistinctStates, current.progress.stallDistinctStates)
  for (const name of current.sense?.blockNames ?? []) {
    if (!(previous.sense?.blockNames ?? []).includes(name) && delta.length < JEV_PROJECTION_LIMITS.meaningfulDelta) {
      delta.push({ fact: 'sensed.block', from: null, to: name })
    }
  }
  for (const threat of current.sense?.threats ?? []) {
    if (!(previous.sense?.threats ?? []).includes(threat) && delta.length < JEV_PROJECTION_LIMITS.meaningfulDelta) {
      delta.push({ fact: 'sensed.threat', from: null, to: threat })
    }
  }
  for (const kind of current.events) {
    if (!previous.events.includes(kind) && delta.length < JEV_PROJECTION_LIMITS.meaningfulDelta) {
      delta.push({ fact: 'event', from: null, to: kind })
    }
  }
  for (const name of new Set([...Object.keys(previous.inventory), ...Object.keys(current.inventory)])) {
    push(`inventory.${name}`, previous.inventory[name] ?? 0, current.inventory[name] ?? 0)
  }
  const previousIdentities = new Set(previous.candidates.map((view) => view.identity))
  const currentIdentities = new Set(current.candidates.map((view) => view.identity))
  for (const identity of currentIdentities) {
    if (!previousIdentities.has(identity) && delta.length < JEV_PROJECTION_LIMITS.meaningfulDelta) {
      delta.push({ fact: 'candidate.added', from: null, to: identity })
    }
  }
  for (const identity of previousIdentities) {
    if (!currentIdentities.has(identity) && delta.length < JEV_PROJECTION_LIMITS.meaningfulDelta) {
      delta.push({ fact: 'candidate.removed', from: identity, to: null })
    }
  }
  const previousFacts = new Set(previous.facts.map((fact) => `${fact.kind}:${fact.key}`))
  const newFacts = current.facts.filter((fact) => !previousFacts.has(`${fact.kind}:${fact.key}`))
  return { delta, newFacts: boundedFacts(newFacts) }
}

function scalar(value: unknown): string | number | boolean | null {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  return value === undefined ? null : JSON.stringify(value)
}

function stableScalar(value: unknown): string {
  return JSON.stringify(scalar(value))
}

/** `JEV_STATE_PROJECTION` - exactly what Jev saw, with its versioned hash. */
export function formatJevStateProjection(projection: JevSemanticProjection, hash: string): string {
  const bytes = projectionBytes(projection)
  return (
    `${JEV_STATE_PROJECTION} hash=${hash} version=${projection.version} schema=${projection.schema} ` +
    `bytes=${bytes} candidates=${projection.candidates.length}/${projection.counts.candidatesOffered} ` +
    `merged=${projection.counts.candidatesMerged} rawSkillSteps=${projection.counts.rawSkillSteps} ` +
    `rawEvents=${projection.counts.rawEvents} facts=${projection.facts.length} ` +
    `recentOutcomes=${projection.recentOutcomes.length} goal=${projection.goal.key} ` +
    `option=${projection.option.instanceId ?? 'none'} skill=${projection.option.skillKind ?? 'none'}`
  )
}

/**
 * `JEV_CANDIDATE_SET` - the §4 identities offered to Jev. A reviewer can see the
 * whole semantic choice set on one line and prove no valid alternative was
 * hidden (§11).
 */
export function formatJevCandidateSet(
  views: readonly SemanticCandidateView[],
  limit = 16,
): string {
  const rendered = views
    .slice(0, limit)
    .map((view) => `${view.identity}<-${view.id}`)
    .join(' , ')
  const more = views.length > limit ? ` (+${views.length - limit} more)` : ''
  return `${JEV_CANDIDATE_SET} count=${views.length} identities=[${rendered}${more}]`
}

// ---------------------------------------------------------------------------
// §3 decision epochs
// ---------------------------------------------------------------------------

export type EpochInvalidationReason =
  | 'world_changed'
  | 'generation_changed'
  | 'lease_revoked'
  | 'dimension_changed'
  | 'superseded'

export interface DecisionEpoch {
  epoch: number
  projectionHash: string
  candidateIdentities: readonly string[]
  dimension: string
  worldEpoch: number
  openedAtMs: number
  /** true when this epoch authorized a CACHED decision for an unchanged state */
  cacheHit: boolean
  /** the epoch this decision was replayed from, when cacheHit */
  reusedFrom: number | null
  closed: boolean
  closeReason: SkillTerminalReason | 'superseded' | 'no_authorization' | null
  commitmentId: string | null
  selectedIdentity: string | null
}

export interface BeginEpochInput {
  projectionHash: string
  candidateIdentities: readonly string[]
  dimension: string
  worldEpoch: number
  nowMs: number
  cacheHit?: boolean
  reusedFrom?: number | null
}

export interface EpochAcceptVerdict {
  accepted: boolean
  epoch: number
  reason: 'active' | 'stale_epoch' | 'epoch_closed' | 'none'
}

/**
 * §3 causal isolation for policy, analogous to generation/lease isolation for
 * actuation. Pure and clock-injected so the whole lifecycle is unit-testable.
 */
export class JevDecisionEpochs {
  private next = 1
  private current: DecisionEpoch | null = null
  private readonly history: DecisionEpoch[] = []
  private readonly historyLimit: number

  constructor(historyLimit = 16) {
    this.historyLimit = Math.max(1, Math.floor(historyLimit))
  }

  get active(): DecisionEpoch | null {
    return this.current
  }

  get lastClosed(): DecisionEpoch | null {
    for (let index = this.history.length - 1; index >= 0; index -= 1) {
      const entry = this.history[index]
      if (entry !== undefined && entry.closed) return entry
    }
    return null
  }

  snapshot(): readonly DecisionEpoch[] {
    return [...this.history]
  }

  /** Every pi decision (model call OR a cached replay) opens a new epoch. */
  begin(input: BeginEpochInput): DecisionEpoch {
    if (this.current !== null && !this.current.closed) this.supersede('superseded')
    const epoch: DecisionEpoch = {
      epoch: this.next,
      projectionHash: input.projectionHash,
      candidateIdentities: [...input.candidateIdentities],
      dimension: input.dimension,
      worldEpoch: input.worldEpoch,
      openedAtMs: input.nowMs,
      cacheHit: input.cacheHit === true,
      reusedFrom: input.reusedFrom ?? null,
      closed: false,
      closeReason: null,
      commitmentId: null,
      selectedIdentity: null,
    }
    this.next += 1
    this.current = epoch
    this.history.push(epoch)
    while (this.history.length > this.historyLimit) this.history.shift()
    return epoch
  }

  private supersede(reason: 'superseded'): void {
    const active = this.current
    if (active === null) return
    active.closed = true
    active.closeReason = reason
    this.current = null
  }

  /**
   * §3: only the ACTIVE epoch may authorize a commitment. A late async model
   * result from an older epoch is rejected here, before any action is claimed.
   */
  accept(epoch: number): EpochAcceptVerdict {
    const active = this.current
    if (active === null) return { accepted: false, epoch, reason: 'none' }
    if (active.epoch === epoch) return { accepted: true, epoch, reason: 'active' }
    if (active.epoch > epoch) return { accepted: false, epoch, reason: 'stale_epoch' }
    return { accepted: false, epoch, reason: 'epoch_closed' }
  }

  /** Record the selection this epoch authorized (the commitment claim). */
  authorize(input: { epoch: number; commitmentId: string; selectedIdentity: string }): EpochAcceptVerdict {
    const verdict = this.accept(input.epoch)
    if (verdict.accepted && this.current !== null) {
      this.current.commitmentId = input.commitmentId
      this.current.selectedIdentity = input.selectedIdentity
    }
    return verdict
  }

  /** Close an epoch with the typed outcome that ended it (§2/§3). */
  close(input: { epoch: number; reason: DecisionEpoch['closeReason'] }): DecisionEpoch | null {
    const entry = this.history.find((candidate) => candidate.epoch === input.epoch) ?? null
    if (entry === null) return null
    entry.closed = true
    entry.closeReason = input.reason
    if (this.current !== null && this.current.epoch === input.epoch) this.current = null
    return entry
  }

  /**
   * §3: a world/generation/lease change invalidates the active epoch. Any late
   * result attributed to it can no longer authorize a commitment.
   */
  invalidate(reason: EpochInvalidationReason): DecisionEpoch | null {
    const active = this.current
    if (active === null) return null
    active.closed = true
    active.closeReason = reason === 'lease_revoked' ? 'lease_revoked' : 'world_changed'
    this.current = null
    return active
  }

  /** True when the live world identity still matches the active epoch. */
  matchesWorld(input: { dimension: string; worldEpoch: number }): boolean {
    const active = this.current
    if (active === null) return true
    return active.dimension === input.dimension && active.worldEpoch === input.worldEpoch
  }
}

export function formatEpochStart(epoch: DecisionEpoch, reason: string): string {
  const cache = epoch.cacheHit ? ` cacheHit=true reusedFrom=${epoch.reusedFrom ?? 'none'}` : ''
  return (
    `${JEV_DECISION_EPOCH_START} epoch=${epoch.epoch} projectionHash=${epoch.projectionHash} ` +
    `candidates=${epoch.candidateIdentities.length} dimension=${epoch.dimension} worldEpoch=${epoch.worldEpoch} ` +
    `reason=${reason}${cache}`
  )
}

export function formatEpochEnd(epoch: DecisionEpoch): string {
  return (
    `${JEV_DECISION_EPOCH_END} epoch=${epoch.epoch} projectionHash=${epoch.projectionHash} ` +
    `closeReason=${epoch.closeReason ?? 'open'} commitmentId=${epoch.commitmentId ?? 'none'} ` +
    `selected=${epoch.selectedIdentity ?? 'none'} cacheHit=${epoch.cacheHit}`
  )
}

export function formatStaleResultDropped(epoch: number, activeEpoch: number | null, reason: string): string {
  return `${STALE_JEV_RESULT_DROPPED} epoch=${epoch} activeEpoch=${activeEpoch ?? 'none'} reason=${reason}`
}

/**
 * §3/§12: one line per authorized commitment, so a reviewer can join "which
 * decision epoch allowed this Skill" to "what that Skill returned"
 * (`SKILL_OUTCOME_PACKET ... commitmentId=...`) without inferring it from timing.
 * `leaseEpoch` is the executor action lease the commitment was claimed under;
 * `selectedIdentity` is the stable §4 semantic identity, NOT the transient
 * candidate id, so the commit/outcome pair still joins after mechanical churn.
 */
export function formatSkillCommit(input: {
  epoch: number
  commitmentId: string
  leaseEpoch: number
  candidateId: string
  selectedIdentity: string
  skillKind: string | null
  projectionHash: string
  /**
   * #436 Phase 1: the DECLARED CONTRACT of the commitment this epoch authorized,
   * appended when the executor built one (`SkillCommitment`). Optional so a lease
   * claimed with no commitment (bootstrap / pre-Phase-1 path) keeps the exact
   * shape above. These are hashes/ids of what was authorized, never a decision:
   * the envelope hash is what a later fail-closed violation is measured against.
   */
  targetIdentity?: string | null
  postconditionHash?: string | null
  effectEnvelopeHash?: string | null
  selectedBy?: string | null
  budgetMs?: number | null
}): string {
  const contract =
    input.targetIdentity === undefined || input.targetIdentity === null
      ? ''
      : ` targetIdentity=[${input.targetIdentity}] selectedBy=${input.selectedBy ?? 'unknown'}` +
        ` postconditionHash=${input.postconditionHash ?? 'none'} effectEnvelopeHash=${input.effectEnvelopeHash ?? 'none'}` +
        ` budgetMs=${input.budgetMs ?? 'runner'}`
  return (
    `${SKILL_COMMIT} epoch=${input.epoch} commitmentId=${input.commitmentId} lease=${input.leaseEpoch} ` +
    `skill=${input.skillKind ?? 'unknown'} candidate=${input.candidateId} identity=${input.selectedIdentity} ` +
    `projectionHash=${input.projectionHash}${contract}`
  )
}

// ---------------------------------------------------------------------------
// §6 re-query only at semantic boundaries
// ---------------------------------------------------------------------------

export type SemanticBoundaryReason =
  | 'first_decision'
  | 'no_active_epoch'
  | 'semantic_state_changed'
  | 'candidate_set_changed'
  | 'safety_changed'
  | 'goal_or_option_changed'
  | 'world_or_lease_changed'
  | 'skill_outcome_boundary'
  | 'same_semantic_state'

export interface SemanticBoundaryInput {
  active: DecisionEpoch | null
  /** the projection hash of the world as it is NOW */
  projectionHash: string
  candidateIdentities: readonly string[]
  worldKey: { dimension: string; worldEpoch: number; leaseHeld: boolean }
  optionKey: string | null
  safetyKey: string
  goalKey: string
  /** the last packet closed a policy boundary (§6: code returned alternatives) */
  lastOutcomeRequiredDecision?: boolean
}

export interface SemanticBoundaryVerdict {
  requery: boolean
  reason: SemanticBoundaryReason
}

/**
 * §6/§9: Jev is re-queried only at a semantic boundary. When the semantic
 * projection is unchanged, a settled mechanical step is NOT a policy event, so
 * the decision is replayed inside a NEW epoch (causal isolation is preserved:
 * the replay is attributed to the current epoch, not to the old one).
 */
export function classifySemanticBoundary(input: SemanticBoundaryInput): SemanticBoundaryVerdict {
  const active = input.active
  if (active === null) return { requery: true, reason: 'first_decision' }
  if (input.lastOutcomeRequiredDecision === true) return { requery: true, reason: 'skill_outcome_boundary' }
  if (active.dimension !== input.worldKey.dimension || active.worldEpoch !== input.worldKey.worldEpoch) {
    return { requery: true, reason: 'world_or_lease_changed' }
  }
  if (!input.worldKey.leaseHeld) return { requery: true, reason: 'world_or_lease_changed' }
  if (active.projectionHash === input.projectionHash) return { requery: false, reason: 'same_semantic_state' }
  const previous = new Set(active.candidateIdentities)
  const current = new Set(input.candidateIdentities)
  const sameCandidates =
    previous.size === current.size && [...current].every((identity) => previous.has(identity))
  if (!sameCandidates) return { requery: true, reason: 'candidate_set_changed' }
  return { requery: true, reason: 'semantic_state_changed' }
}

/** Classify WHY a changed projection is a boundary (evidence, not authority). */
export function classifyProjectionChange(
  previous: JevSemanticProjection | null,
  current: JevSemanticProjection,
): { safetyChanged: boolean; goalOrOptionChanged: boolean; worldChanged: boolean; candidatesChanged: boolean } {
  if (previous === null) {
    return { safetyChanged: true, goalOrOptionChanged: true, worldChanged: true, candidatesChanged: true }
  }
  const identityOf = (views: readonly SemanticCandidateView[]): string =>
    views.map((view) => view.identity).sort().join('|')
  return {
    safetyChanged: JSON.stringify(previous.safety) !== JSON.stringify(current.safety),
    goalOrOptionChanged:
      JSON.stringify(previous.goal) !== JSON.stringify(current.goal) ||
      JSON.stringify(previous.option) !== JSON.stringify(current.option),
    worldChanged: JSON.stringify(previous.world) !== JSON.stringify(current.world),
    candidatesChanged: identityOf(previous.candidates) !== identityOf(current.candidates),
  }
}
