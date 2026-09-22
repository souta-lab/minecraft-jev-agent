// skillCommitment.ts - issue #436 Phase 1: the SkillCommitment contract.
//
// Thesis (issue #436):
//
//   "A Jev selection is a commitment to one grounded semantic action, not
//    permission for one primitive Mineflayer call."
//
// This module owns the SEMANTIC-IDENTITY half of that sentence and nothing else:
//
//   - `SkillCommitment`      : the first-class identity of one selected Skill,
//                              spanning claim -> mechanical steps -> outcome;
//   - `CausalTargetIdentity` : the exact target identity that must NOT change
//                              silently while the commitment is alive (section 4);
//   - `EffectEnvelope`       : the declared classes of body/world mutation that
//                              are mechanically admissible for that Skill
//                              (section 5); anything else FAILS CLOSED;
//   - `SkillOutcome`         : the typed lifecycle outcome (section 6);
//   - step authorities        : MECHANICAL_CONTINUATION / MANDATORY_PREREQUISITE /
//                              HARD_SAFETY_REFLEX (section 17).
//
// #11 boundary this module must never cross:
//
//   * it does not rank, choose or invent a semantic target;
//   * it does not expand an envelope because execution became inconvenient
//     (section 16: the envelope "MUST NOT expand dynamically");
//   * it does not implement §3's forbidden `candidateCount == 1 -> skip Jev`
//     shortcut. Candidate count is not an authority signal, and nothing in this
//     module looks at it. Execution is only ever authorized by a policy/guard
//     selection, which is exactly what `selectedBy` + `decisionId` record;
//   * it contains no recovery ladder, no strategy list, no retry-driven branch.
//
// Phase 1 is deliberately behaviour-neutral: the envelope describes what each
// existing candidate kind already does, so wiring it in cannot make an existing
// runner illegal - it can only make an ILLEGAL step observable and fail closed.
import type { Candidate, CandidateKind } from './candidates.ts'
import {
  formatSkillEnd as formatCanonicalSkillEnd,
  formatSkillPolicyBoundary as formatCanonicalSkillPolicyBoundary,
  formatSkillStep,
  formatSkillStepAuthority,
} from './netherPortalPlan.ts'
import type { SkillStepAuthority } from './netherPortalPlan.ts'
import type { SkillTerminalReason } from './jevSemanticProjection.ts'
import type { Vec3Json } from './state.ts'
import { BRIDGE_BLOCK_META, BRIDGE_META, BRIDGE_PLACE_META } from './bridgeRoute.ts'

/**
 * The committed Skill kind. This is the executor/candidate-level vocabulary
 * (one selected grounded action); the Option layer's longer-horizon `SkillKind`
 * in `skillCandidate.ts` is a different, coarser vocabulary and is not
 * interchangeable with this one.
 */
export type SkillKind =
  | 'kill'
  | 'hunt_drop'
  | 'hold_item'
  | 'equip_item'
  | 'walk_to'
  | 'mine'
  | 'place'
  | 'craft'
  | 'smelt'
  | 'ignite'
  | 'enter_portal'
  | 'descend'
  | 'step'
  | 'retrieve'
  | 'eat'
  | 'retreat'
  | 'wait'
  | 'escalate'

/** Deterministic candidate-kind -> committed-skill-kind mapping. */
export const SKILL_KIND_BY_CANDIDATE: Readonly<Record<CandidateKind, SkillKind>> = {
  // `hold_item` joins this table in Phase 2 together with its CandidateKind.
  MINE: 'mine',
  MOVE: 'walk_to',
  CRAFT: 'craft',
  PLACE: 'place',
  SMELT: 'smelt',
  IGNITE: 'ignite',
  ENTER_PORTAL: 'enter_portal',
  DESCEND: 'descend',
  STEP: 'step',
  RETRIEVE: 'retrieve',
  ATTACK: 'kill',
  EAT: 'eat',
  EQUIP: 'equip_item',
  RETREAT: 'retreat',
  WAIT: 'wait',
  ESCALATE: 'escalate',
}

/**
 * `ATTACK` splits into two semantically distinct committed skills: a plain
 * `KILL(entity E)` (hit/kill the selected entity) and `HUNT_DROP(entity E, item)`
 * when the selected candidate carries the goal-drop producer contract, whose
 * declared postcondition legitimately includes the drop reaching the inventory.
 */
export function committedSkillKind(candidate: Candidate): SkillKind {
  if (candidate.kind !== 'ATTACK') return SKILL_KIND_BY_CANDIDATE[candidate.kind]
  return typeof candidate.meta.goalDrop === 'string' ? 'hunt_drop' : 'kill'
}

// ---------------------------------------------------------------------------
// Section 4: CausalTargetIdentity - "stable enough to prevent accidental
// retargeting".
// ---------------------------------------------------------------------------

export type CausalTargetIdentity =
  /** an exact entity id (the mob instance Jev selected), never a mob TYPE */
  | { kind: 'entity'; entityId: number; mobType: string | null; dimension: string; worldEpoch: number }
  /** an exact block cell + the block identity expected there */
  | { kind: 'block'; position: Vec3Json; blockName: string | null; dimension: string; worldEpoch: number }
  /** a destination cell/region */
  | { kind: 'position'; position: Vec3Json; dimension: string; worldEpoch: number }
  /** an exact item (name + optional count/slot) */
  | { kind: 'item'; itemName: string; count: number | null; slot: string | null }
  /** a portal site (position in the dimension it lives in) */
  | { kind: 'portal_site'; position: Vec3Json; dimension: string; worldEpoch: number }
  /** a control-plane action with no physical target (WAIT/ESCALATE) */
  | { kind: 'none' }

export interface TargetIdentityContext {
  dimension: string
  worldEpoch: number
}

/** The exact target identity of one selected candidate. Pure. */
export function targetIdentityOf(candidate: Candidate, ctx: TargetIdentityContext): CausalTargetIdentity {
  switch (candidate.kind) {
    case 'ATTACK':
      return {
        kind: 'entity',
        entityId: candidate.targetEntityId ?? -1,
        mobType: candidate.targetName,
        dimension: ctx.dimension,
        worldEpoch: ctx.worldEpoch,
      }
    case 'MINE':
    case 'PLACE':
    case 'IGNITE':
    case 'DESCEND':
    case 'STEP':
      return {
        kind: 'block',
        position: candidate.target ?? { x: 0, y: 0, z: 0 },
        blockName: candidate.itemName ?? candidate.targetName,
        dimension: ctx.dimension,
        worldEpoch: ctx.worldEpoch,
      }
    case 'ENTER_PORTAL':
      return {
        kind: 'portal_site',
        position: candidate.target ?? { x: 0, y: 0, z: 0 },
        dimension: ctx.dimension,
        worldEpoch: ctx.worldEpoch,
      }
    case 'MOVE':
    case 'RETREAT':
    case 'RETRIEVE':
      return {
        kind: 'position',
        position: candidate.target ?? { x: 0, y: 0, z: 0 },
        dimension: ctx.dimension,
        worldEpoch: ctx.worldEpoch,
      }
    case 'CRAFT':
    case 'SMELT':
      return {
        kind: 'item',
        itemName: candidate.itemName ?? candidate.targetName ?? 'unknown',
        count: typeof candidate.meta.count === 'number' ? candidate.meta.count : null,
        slot: null,
      }
    case 'EQUIP':
    case 'EAT':
      return {
        kind: 'item',
        itemName: candidate.itemName ?? candidate.targetName ?? 'unknown',
        count: null,
        slot: typeof candidate.meta.slot === 'string' ? candidate.meta.slot : null,
      }
    case 'WAIT':
    case 'ESCALATE':
      return { kind: 'none' }
  }
}

/** Stable, greppable log form of one target identity. */
export function targetIdentityKey(identity: CausalTargetIdentity): string {
  switch (identity.kind) {
    case 'entity':
      return `entity=e${identity.entityId} mob=${identity.mobType ?? 'unknown'} dim=${identity.dimension} epoch=${identity.worldEpoch}`
    case 'block':
      return `block=${identity.position.x},${identity.position.y},${identity.position.z} name=${identity.blockName ?? 'unknown'} dim=${identity.dimension} epoch=${identity.worldEpoch}`
    case 'position':
      return `position=${identity.position.x},${identity.position.y},${identity.position.z} dim=${identity.dimension} epoch=${identity.worldEpoch}`
    case 'item':
      return `item=${identity.itemName} count=${identity.count ?? 'any'} slot=${identity.slot ?? 'any'}`
    case 'portal_site':
      return `portal=${identity.position.x},${identity.position.y},${identity.position.z} dim=${identity.dimension} epoch=${identity.worldEpoch}`
    case 'none':
      return 'none'
  }
}

/**
 * True when two identities denote the SAME target. Used by the invariant checks
 * (section 26): a Skill may not silently change target identity. Note that an
 * entity identity compares the exact id, never the mob type.
 */
export function sameTargetIdentity(a: CausalTargetIdentity, b: CausalTargetIdentity): boolean {
  return targetIdentityKey(a) === targetIdentityKey(b)
}

// ---------------------------------------------------------------------------
// Section 5: EffectEnvelope
// ---------------------------------------------------------------------------

export interface BlockIdentity {
  position: Vec3Json
  /** expected block name; null when the contract is "whatever is grounded there" */
  name: string | null
}

export interface PlacementIdentity {
  position: Vec3Json
  itemName: string
}

export interface InventoryTransferSpec {
  itemName: string
  count: number | null
  container: string
}

export interface EffectEnvelope {
  mayMove: boolean
  mayLook: boolean
  mayJump: boolean
  maySprint: boolean
  /** exact entity ids this Skill may damage; absent/empty = none */
  mayAttackEntityIds?: readonly number[]
  /**
   * TRANSITIONAL (removed in Phase 4): the pre-§9 `goalDrop` hunt contract was
   * bound to a mob NAME, so its current executor may replace the chosen instance
   * with another sensed instance of that mob. Phase 4 binds a hunt to the exact
   * entity id per §9 ("do not automatically attack the nearest entity F, even if
   * F has the same mob type") and this field disappears with that adoption.
   * A plain KILL never sets it.
   */
  mayAttackMobTypes?: readonly string[]
  /** exact cells this Skill may dig */
  mayDigBlocks?: readonly BlockIdentity[]
  /**
   * The selected Skill's OWN contract is a grounded multi-cell dig route (a
   * route-opening MOVE / DESCEND / STEP / ENTER_PORTAL route). Set only when the
   * candidate itself carries that grounded route (`meta.digRoute`,
   * `meta.vertical`), so the envelope records a contract, never a runtime excuse
   * to dig freely.
   */
  mayDigGroundedRoute?: boolean
  /**
   * The selected Skill's OWN contract includes placing footing/scaffold blocks
   * along a grounded route the candidate DECLARED: a vertical plan
   * (pillar/stair build toward the selected target) or a BRIDGE/scaffold MOVE
   * (`meta.bridge` + `meta.bridgeBlock`, `bridgeRoute.ts`). Set only from the
   * candidate's declared route contract, never at runtime - a WALK_TO cannot gain
   * place authority from an obstruction it meets (section 7 U4).
   */
  mayPlaceGroundedRoute?: boolean
  /** exact cells this Skill may place into */
  mayPlaceBlocks?: readonly PlacementIdentity[]
  /** exact item names this Skill may equip into the hand */
  mayEquipItems?: readonly string[]
  /** exact station block names this Skill may open */
  mayUseStations?: readonly string[]
  /** exact inventory transfers this Skill may perform */
  mayTransferInventory?: readonly InventoryTransferSpec[]
}

/** The closed set of mechanical effects a runner can perform. */
export type Effect =
  | { type: 'move' }
  | { type: 'look' }
  | { type: 'jump' }
  | { type: 'sprint' }
  | { type: 'attack'; entityId: number; mobType?: string | null }
  | { type: 'dig'; position: Vec3Json; blockName: string | null }
  | { type: 'place'; position: Vec3Json; itemName: string }
  | { type: 'equip'; itemName: string; destination: string }
  | { type: 'station'; station: string }
  | { type: 'transfer'; itemName: string; count: number | null; container: string }

function cellKey(position: Vec3Json): string {
  return `${position.x},${position.y},${position.z}`
}

/**
 * One `"x,y,z"` cell from candidate meta (the shape `bridgeRoute.ts` writes into
 * `bridgePlace`), or null when the key is absent/malformed. Used so the effect
 * envelope can name the exact first placement cell the offer verified.
 */
function metaCell(value: string | number | boolean | undefined): Vec3Json | null {
  if (typeof value !== 'string' || value.length === 0) return null
  const parts = value.split(',').map((entry) => Number(entry))
  const [x, y, z] = parts
  if (x === undefined || y === undefined || z === undefined) return null
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null
  return { x, y, z }
}

/**
 * Fail-closed check (section 5/27): returns a typed reason when `effect` is NOT
 * admissible for `envelope`, or null when it is. `envelope` is the active
 * commitment's declared envelope; callers MUST treat a reason as "do not
 * perform the step and surface the violation", never as "widen the envelope".
 */
export function effectViolation(envelope: EffectEnvelope, effect: Effect): string | null {
  switch (effect.type) {
    case 'move':
      return envelope.mayMove ? null : 'move_not_declared'
    case 'look':
      return envelope.mayLook ? null : 'look_not_declared'
    case 'jump':
      return envelope.mayJump ? null : 'jump_not_declared'
    case 'sprint':
      return envelope.maySprint ? null : 'sprint_not_declared'
    case 'attack': {
      const allowed = envelope.mayAttackEntityIds ?? []
      if (allowed.includes(effect.entityId)) return null
      const mobTypes = envelope.mayAttackMobTypes ?? []
      if (effect.mobType !== undefined && effect.mobType !== null && mobTypes.includes(effect.mobType)) return null
      return `attack_entity_not_declared:e${effect.entityId}`
    }
    case 'dig': {
      const allowed = envelope.mayDigBlocks ?? []
      if (allowed.some((entry) => cellKey(entry.position) === cellKey(effect.position))) return null
      if (envelope.mayDigGroundedRoute === true) return null
      return `dig_cell_not_declared:${cellKey(effect.position)}`
    }
    case 'place': {
      const allowed = envelope.mayPlaceBlocks ?? []
      if (allowed.some((entry) => cellKey(entry.position) === cellKey(effect.position))) return null
      if (envelope.mayPlaceGroundedRoute === true) return null
      return `place_cell_not_declared:${cellKey(effect.position)}`
    }
    case 'equip': {
      const allowed = envelope.mayEquipItems ?? []
      return allowed.includes(effect.itemName) ? null : `equip_item_not_declared:${effect.itemName}`
    }
    case 'station': {
      const allowed = envelope.mayUseStations ?? []
      return allowed.includes(effect.station) ? null : `station_not_declared:${effect.station}`
    }
    case 'transfer': {
      const allowed = envelope.mayTransferInventory ?? []
      const ok = allowed.some(
        (entry) => entry.itemName === effect.itemName && entry.container === effect.container,
      )
      return ok ? null : `transfer_not_declared:${effect.itemName}->${effect.container}`
    }
  }
}

/**
 * The envelope each selected candidate kind declares. Derived from the CANDIDATE
 * the policy selected (its grounded target/params), so two selections of the same
 * kind can still have different envelopes: a `KILL(e31)` may only attack e31.
 *
 * `equipItems` is passed in explicitly by the caller because the weapon/tool a
 * Skill is allowed to put in hand must itself be grounded by the selection (see
 * `uniquelyRequiredTool`): this function never computes a "best item".
 */
export function envelopeForCandidate(
  candidate: Candidate,
  input: {
    /** the exact item names this selection authorizes equipping (grounded, never ranked) */
    equipItems?: readonly string[]
    /** the exact station names this selection authorizes opening */
    stations?: readonly string[]
    /** the exact inventory transfers this selection authorizes */
    transfers?: readonly InventoryTransferSpec[]
  } = {},
): EffectEnvelope {
  const base: EffectEnvelope = {
    mayMove: true,
    mayLook: true,
    mayJump: true,
    maySprint: true,
    mayAttackEntityIds: [],
    mayAttackMobTypes: [],
    mayDigBlocks: [],
    mayDigGroundedRoute: false,
    mayPlaceGroundedRoute: false,
    mayPlaceBlocks: [],
    mayEquipItems: [...(input.equipItems ?? [])],
    mayUseStations: [...(input.stations ?? [])],
    mayTransferInventory: [...(input.transfers ?? [])],
  }
  switch (candidate.kind) {
    case 'MINE':
      // A MINE digs exactly its selected cell (plus, for a clearance MINE, the
      // single cell its own contract names).
      return {
        ...base,
        mayDigBlocks: candidate.target === null ? [] : [{ position: candidate.target, name: candidate.targetName }],
      }
    case 'PLACE': {
      const cells = candidate.placementCells ?? (candidate.target === null ? [] : [candidate.target])
      return {
        ...base,
        mayPlaceBlocks: candidate.itemName === null ? [] : cells.map((position) => ({ position, itemName: candidate.itemName as string })),
        // A multi-cell PLACE (the portal FRAME build) carries its own verified
        // support contract: it may place the scaffold block under/around its
        // cells, clear a leftover scaffold out of a frame cell, and equip the
        // carried materials/tools to do it. Derived from the candidate's own
        // ordered cell sequence, never set at runtime.
        mayPlaceGroundedRoute: (candidate.placementCells ?? []).length > 0,
        mayDigGroundedRoute: (candidate.placementCells ?? []).length > 0,
      }
    }
    case 'IGNITE':
      return {
        ...base,
        mayEquipItems: [...new Set([...(input.equipItems ?? []), 'flint_and_steel'])],
        mayPlaceBlocks: candidate.target === null ? [] : [{ position: candidate.target, itemName: 'fire' }],
      }
    case 'ATTACK':
      // A plain KILL is bound to the exact selected entity id. The transitional
      // `goalDrop` hunt keeps its current mob-name contract until Phase 4 binds
      // it to the same exact identity (see `mayAttackMobTypes`).
      return {
        ...base,
        mayAttackEntityIds: candidate.targetEntityId === null ? [] : [candidate.targetEntityId],
        mayAttackMobTypes:
          typeof candidate.meta.goalDrop === 'string' && candidate.targetName !== null ? [candidate.targetName] : [],
      }
    case 'DESCEND':
    case 'STEP':
    case 'MOVE':
    case 'ENTER_PORTAL':
    // A RETRIEVE/RETREAT is the same kind of locomotion contract: its own
    // candidate meta carries the grounded `vertical`/`digRoute` route it was
    // offered with (`candidates.ts` spreads `verticalPlanMeta` into a RETRIEVE's
    // meta exactly as it does for a MOVE). Without them here a RETRIEVE whose
    // route is a pillar - live case `RETRIEVE:known:blaze_rod:b35_60_-24`,
    // routeSig `RETRIEVE:pillar:57->60` - had its own pillar step refused
    // `effect_envelope_violation`, which spent the route and produced
    // ACTION_ZERO_PROGRESS 51 times while the body stood at y=57 unable to
    // reach the y=60 cells. A RETRIEVE with NO declared route still gets
    // neither flag, so section 7 U4 is unchanged.
    case 'RETRIEVE':
    case 'RETREAT': {
      // Route-opening locomotion / portal entry may clear and place along the
      // cells its OWN grounded route names (`digRoute` / a `vertical` plan); the
      // flags are set only from the candidate's contract, never at runtime. A
      // plain walk with no declared route gets neither, so a WALK_TO cannot gain
      // dig/place authority from an obstruction (section 7 U4).
      //
      // A BRIDGE MOVE declares its own placing route (`meta.bridge`): it places
      // exactly the block it named (`meta.bridgeBlock`, the section 5
      // `EffectEnvelope` half) into the floor cells of its own grounded span, and
      // it may hold that block - nothing else. The span's cells after the first are
      // derived live by the SAME rule that grounded the offer, so the contract
      // carries the first verified cell plus `mayPlaceGroundedRoute`.
      const bridge = candidate.meta[BRIDGE_META] === true
      const bridgeBlock = typeof candidate.meta[BRIDGE_BLOCK_META] === 'string' ? (candidate.meta[BRIDGE_BLOCK_META] as string) : null
      const firstPlaceCell = bridge ? metaCell(candidate.meta[BRIDGE_PLACE_META]) : null
      return {
        ...base,
        mayDigGroundedRoute: candidate.meta.digRoute === true || candidate.meta.vertical !== undefined,
        mayPlaceGroundedRoute: candidate.meta.vertical !== undefined || bridge,
        mayPlaceBlocks:
          bridge && firstPlaceCell !== null && bridgeBlock !== null
            ? [{ position: firstPlaceCell, itemName: bridgeBlock }]
            : [],
        mayEquipItems:
          bridge && bridgeBlock !== null
            ? [...new Set([...(input.equipItems ?? []), bridgeBlock])]
            : [...(input.equipItems ?? [])],
      }
    }
    case 'CRAFT':
      return { ...base, mayMove: false, mayJump: false, maySprint: false, mayUseStations: [...(input.stations ?? [])] }
    case 'SMELT':
      return { ...base, mayUseStations: [...(input.stations ?? [])] }
    case 'EQUIP':
    case 'EAT':
      // A local inventory/consumption action must not walk, dig, place, attack
      // or open a station: the item is already in the inventory.
      // (Phase 2 adds `HOLD_ITEM` to this group together with its CandidateKind.)
      return { ...base, mayMove: false, mayJump: false, maySprint: false }
    case 'WAIT':
      return { ...base, mayMove: false, mayLook: false, mayJump: false, maySprint: false }
    case 'ESCALATE':
      return { ...base, mayMove: false, mayLook: false, mayJump: false, maySprint: false }
  }
}

// ---------------------------------------------------------------------------
// Section 4: budget / interrupt policy / commitment identity
// ---------------------------------------------------------------------------

export interface SkillBudget {
  /** wall-clock bound for the whole commitment (null = the runner's own bound) */
  ms: number | null
  /**
   * Bound on DISTINCT mechanical steps. A step budget never selects a different
   * strategy; exhausting it is a typed return to policy (section 15).
   */
  steps: number | null
  /** bounded same-Skill retries (verified side-effect-free only) */
  retries: number
}

/**
 * Section 6/8: what happens when safety preempts the commitment. Phase 1 records
 * the policy; the reflex AUDIT that changes behaviour is Phase 6, so every
 * commitment currently declares the conservative `return_to_policy` policy.
 */
export interface InterruptPolicy {
  safety: 'return_to_policy' | 'resume_after_stabilization'
  /** true only when the Skill's own contract proved it can resume the SAME identity */
  resumable: boolean
  maxSafetyInterrupts: number
}

export const DEFAULT_INTERRUPT_POLICY: InterruptPolicy = {
  safety: 'return_to_policy',
  resumable: false,
  maxSafetyInterrupts: 1,
}

export type SelectedBy = 'jev_pi' | 'hard_safety'

export interface SkillCommitment<P = Record<string, string | number | boolean | null>> {
  commitmentId: string
  /**
   * issue #437 section 3: the Jev decision epoch that authorized this
   * commitment. Only the currently active epoch may open a new commitment, and a
   * SkillOutcome may only close the epoch/commitment it belongs to.
   */
  decisionEpoch: number
  optionInstanceId: string
  decisionId: string
  candidateId: string
  skillKind: SkillKind
  params: P
  target: CausalTargetIdentity
  expectedPostconditions: readonly string[]
  allowedEffects: EffectEnvelope
  budget: SkillBudget
  interruptPolicy: InterruptPolicy
  selectedBy: SelectedBy
  selectedAtStateFingerprint: string
}

export interface SkillCommitmentInput {
  decisionEpoch: number
  optionInstanceId: string | null
  decisionId: string | null
  candidate: Candidate
  target: CausalTargetIdentity
  expectedPostconditions: readonly string[]
  allowedEffects: EffectEnvelope
  budget?: Partial<SkillBudget>
  interruptPolicy?: InterruptPolicy
  selectedBy: SelectedBy
  selectedAtStateFingerprint: string | null
  /** stable params of the selection, read from the candidate */
  params?: Record<string, string | number | boolean | null>
}

/** Deterministic 32-bit FNV-1a hash, hex. No crypto dependency, stable across runs. */
export function stableHash(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** Stable serialization for hashing (sorted keys, plain data only). */
function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`).join(',')}}`
}

/**
 * `postconditionHash` / `effectEnvelopeHash` (section 17): the identity of the
 * declared contract, so two commitments with the same candidate but a different
 * postcondition/envelope can never be confused in the evidence.
 */
export function postconditionHash(postconditions: readonly string[]): string {
  return stableHash(stableSerialize([...postconditions].sort()))
}

export function effectEnvelopeHash(envelope: EffectEnvelope): string {
  return stableHash(stableSerialize(envelope))
}

/** The stable identity of one commitment. Deterministic in its inputs. */
export function commitmentIdFor(input: {
  optionInstanceId: string | null
  decisionId: string | null
  candidateId: string
  skillKind: SkillKind
  targetKey: string
}): string {
  return `c${stableHash(
    stableSerialize([
      input.optionInstanceId ?? 'none',
      input.decisionId ?? 'none',
      input.candidateId,
      input.skillKind,
      input.targetKey,
    ]),
  )}`
}

/** Build the first-class commitment for one policy-selected candidate. */
export function createSkillCommitment(input: SkillCommitmentInput): SkillCommitment {
  const skillKind = committedSkillKind(input.candidate)
  const targetKey = targetIdentityKey(input.target)
  return {
    commitmentId: commitmentIdFor({
      optionInstanceId: input.optionInstanceId,
      decisionId: input.decisionId,
      candidateId: input.candidate.id,
      skillKind,
      targetKey,
    }),
    decisionEpoch: input.decisionEpoch,
    optionInstanceId: input.optionInstanceId ?? 'none',
    decisionId: input.decisionId ?? 'none',
    candidateId: input.candidate.id,
    skillKind,
    params: input.params ?? {},
    target: input.target,
    expectedPostconditions: [...input.expectedPostconditions],
    allowedEffects: input.allowedEffects,
    budget: { ms: null, steps: null, retries: 0, ...input.budget },
    interruptPolicy: input.interruptPolicy ?? DEFAULT_INTERRUPT_POLICY,
    selectedBy: input.selectedBy,
    selectedAtStateFingerprint: input.selectedAtStateFingerprint ?? 'none',
  }
}

// ---------------------------------------------------------------------------
// Section 6/14: typed lifecycle outcomes and invalidation
// ---------------------------------------------------------------------------

export type SkillOutcome =
  | 'SUCCESS'
  | 'TARGET_INVALIDATED'
  | 'MECHANICALLY_BLOCKED'
  | 'SAFETY_INTERRUPT'
  | 'CAPABILITY_LOST'
  | 'WORLD_CHANGED'
  | 'LEASE_REVOKED'
  | 'BUDGET_EXHAUSTED'
  | 'CANCELLED'

/**
 * Outcomes that mean "the Skill stopped and policy authority resumes" (section
 * 6). SUCCESS is NOT a policy boundary: deterministic completion is code-owned
 * (section 13) and Jev is not asked "are we done?".
 */
export const POLICY_BOUNDARY_OUTCOMES: ReadonlySet<SkillOutcome> = new Set<SkillOutcome>([
  'TARGET_INVALIDATED',
  'MECHANICALLY_BLOCKED',
  'SAFETY_INTERRUPT',
  'CAPABILITY_LOST',
  'WORLD_CHANGED',
  'LEASE_REVOKED',
  'BUDGET_EXHAUSTED',
])

export function isPolicyBoundaryOutcome(outcome: SkillOutcome): boolean {
  return POLICY_BOUNDARY_OUTCOMES.has(outcome)
}

/**
 * Map an executor failure code to the typed lifecycle outcome. Pure; this is the
 * ONE place that decides which lifecycle bucket a mechanical failure belongs to,
 * so the evidence and the controller cannot drift apart.
 */
export function skillOutcomeForFailure(failureCode: string | null, status: string): SkillOutcome {
  if (status === 'cancelled') return 'LEASE_REVOKED'
  switch (failureCode) {
    case 'target_gone':
      return 'TARGET_INVALIDATED'
    case 'world_changed':
      return 'WORLD_CHANGED'
    case 'submerged':
    case 'combat_unsafe':
    // The per-step landing guard stopped the leg BEFORE a lethal step
    // (`stepLanding.ts`): a hard safety refusal, not a generic mechanical block.
    case 'hazard_between':
    case 'unsafe_landing':
      return 'SAFETY_INTERRUPT'
    case 'item_unavailable':
    case 'dig_no_tool':
    case 'capability_invalidated':
      return 'CAPABILITY_LOST'
    case 'path_timeout':
    case 'dig_timeout':
    case 'smelt_timeout':
      return 'BUDGET_EXHAUSTED'
    case null:
      return status === 'done' ? 'SUCCESS' : 'MECHANICALLY_BLOCKED'
    default:
      // Everything else is a bounded mechanical failure of THIS Skill: it is a
      // return to policy, never a licence to pick another strategy (section 15).
      return 'MECHANICALLY_BLOCKED'
  }
}

export type CommitmentInvalidationReason = 'WORLD_CHANGED' | 'TARGET_INVALIDATED' | 'LEASE_REVOKED'

/**
 * Section 14/23: a commitment is invalidated by world/epoch/lease changes that
 * break its contract. `enter_portal` is the deliberate exception to the
 * dimension rule: its own declared postcondition IS the dimension change.
 */
export function commitmentInvalidation(input: {
  commitment: Pick<SkillCommitment, 'skillKind' | 'target'>
  observedDimension: string
  observedWorldEpoch: number
  leaseHeld: boolean
}): CommitmentInvalidationReason | null {
  if (!input.leaseHeld) return 'LEASE_REVOKED'
  const target = input.commitment.target
  if (target.kind === 'item' || target.kind === 'none') return null
  if (target.worldEpoch !== input.observedWorldEpoch) return 'WORLD_CHANGED'
  if (input.commitment.skillKind === 'enter_portal') return null
  // 'unknown' is the UNOBSERVED dimension (no game state yet), not a verdict:
  // this repo's standing semantics is "unknown is not false", so an unobserved
  // dimension never invalidates a commitment.
  if (input.observedDimension === 'unknown') return null
  return target.dimension === input.observedDimension ? null : 'WORLD_CHANGED'
}

/**
 * Section 14/17: the fail-closed event when a live commitment's contract is
 * broken by the world/lease it was grounded in. Emitted by the layer that
 * OBSERVED the change (executor at a mutation choke point, controller at the
 * tick), before the typed `SKILL_END outcome=` closes it. It names the reason
 * and never a replacement: the replacement belongs to pi/beta.
 */
export function formatSkillInvalidated(input: {
  commitmentId: string
  decisionEpoch: number
  skillKind: SkillKind
  candidateId: string
  reason: CommitmentInvalidationReason
  targetKey: string
  observedDimension: string
  observedWorldEpoch: number
  detail: string
}): string {
  return (
    `SKILL_INVALIDATED commitmentId=${input.commitmentId} decisionEpoch=${input.decisionEpoch} ` +
    `skillKind=${input.skillKind} candidateId=${input.candidateId} reason=${input.reason} ` +
    `targetIdentity=[${input.targetKey}] observedDimension=${input.observedDimension} ` +
    `observedWorldEpoch=${input.observedWorldEpoch} detail=${input.detail}`
  )
}

/**
 * Section 26 invariant: a Skill may not silently change target identity. Returns
 * a violation reason when `observed` differs from the committed identity.
 */export function targetIdentityViolation(
  committed: CausalTargetIdentity,
  observed: CausalTargetIdentity,
): string | null {
  if (sameTargetIdentity(committed, observed)) return null
  return `target_identity_changed:${targetIdentityKey(committed)}->${targetIdentityKey(observed)}`
}

/** Section 16 invariant: the envelope may never expand while a commitment lives. */
export function envelopeExpanded(original: EffectEnvelope, current: EffectEnvelope): boolean {
  return effectEnvelopeHash(original) !== effectEnvelopeHash(current)
}

// ---------------------------------------------------------------------------
// Section 17: evidence lines
// ---------------------------------------------------------------------------
//
// ONE VOCABULARY, ONE OWNER PER MARKER:
//
//   SKILL_STEP / SKILL_POLICY_BOUNDARY / SKILL_END / SKILL_INTERRUPT / SKILL_START
//       owned by `netherPortalPlan.ts` (the canonical #436 §17 vocabulary the
//       portal-entry / env-hazard / dig-route lanes already emit and parse);
//   SKILL_COMMIT / SKILL_OUTCOME_PACKET / STALE_JEV_RESULT_DROPPED and the
//       decision epochs owned by `jevSemanticProjection.ts` (the #437 lane that
//       consumes them). This module feeds that lane the REAL `commitmentId` and
//       the `CausalTargetIdentity` key - it never formats those markers itself.
//
// This module COMPOSES the canonical formatters and appends the commitment
// provenance, so a consumer greps one shape per marker:
//
//   SKILL_STEP skill=<kind> step=<name> authority=<one of the three>
//              evidence=... worldDelta=... commitmentId=... decisionEpoch=...
//              [count=] [retry=]
//   SKILL_POLICY_BOUNDARY skill=<kind> reason=<reason> alternatives=[...]
//              [commitmentId=... decisionEpoch=... detail=...]
//   SKILL_END skill=<kind> execution=... verification=... postcondition=...
//              failure=... outcome=... failureCode=... targetIdentity=[...]
//              commitmentId=... decisionEpoch=... candidateId=... ms=...
//
// `SKILL_INVALIDATED` is the §14/23 lifecycle cancellation event, owned here.

/**
 * The three deterministic layers (section 17). Every SKILL_STEP must name which
 * one it is, so a reviewer can audit #11 compliance from the log alone. This is
 * the canonical `netherPortalPlan.ts` union, re-exported so the commitment layer
 * cannot drift from it.
 */
export type StepAuthority = SkillStepAuthority

export interface SkillStepEvidence {
  commitmentId: string
  decisionEpoch: number
  skillKind: SkillKind
  stepKind: string
  authority: StepAuthority
  evidence: string
  worldDelta: string
  /** how many identical mechanical steps were aggregated into this line */
  count?: number
  retry?: number
}

/** `SKILL_STEP` - one mechanical step realizing the committed selection. */
export function formatCommittedStep(input: SkillStepEvidence): string {
  return formatSkillStep(
    input.skillKind,
    input.stepKind,
    `${formatSkillStepAuthority(input.authority, input.evidence, input.worldDelta)} ` +
      `commitmentId=${input.commitmentId} decisionEpoch=${input.decisionEpoch}` +
      (input.count === undefined ? '' : ` count=${input.count}`) +
      (input.retry === undefined ? '' : ` retry=${input.retry}`),
  )
}

export interface SkillPolicyBoundaryEvidence {
  /** the skill identity, in the canonical `skill=` vocabulary (either name works) */
  skill?: string
  skillKind?: SkillKind
  /**
   * Why code stopped. Typed where the commitment layer names it (`SkillOutcome` /
   * `SkillTerminalReason`); left as `string` so a lane may name its own boundary
   * (the env-hazard `hard_safety_interrupt` / `multiple_grounded_escapes` /
   * `no_grounded_escape`) without touching this union.
   */
  reason: SkillOutcome | SkillTerminalReason | (string & {})
  /** the grounded alternatives offered to policy, or [] when policy owns the list */
  alternatives: readonly string[]
  /** commitment provenance, appended when a commitment was in flight */
  commitmentId?: string
  decisionEpoch?: number
  detail?: string
}

/**
 * `SKILL_POLICY_BOUNDARY` - the typed "code must not choose here" event. Emitted
 * by whichever layer holds the grounded alternatives (the controller, which owns
 * the next candidate set); the executor only names the reason.
 *
 * This is the ONE formatter for the marker: it composes the canonical
 * `netherPortalPlan.ts` shape (`skill= reason= alternatives=[]`) and appends the
 * commitment provenance when there was a commitment to close. Callers with only
 * the canonical fields keep the exact canonical line.
 */
export function formatSkillPolicyBoundary(input: SkillPolicyBoundaryEvidence): string {
  const skill = input.skill ?? input.skillKind
  if (skill === undefined) throw new Error('formatSkillPolicyBoundary requires skill or skillKind')
  const base = formatCanonicalSkillPolicyBoundary({
    skill,
    reason: String(input.reason),
    alternatives: input.alternatives,
  })
  const provenance =
    input.commitmentId === undefined
      ? ''
      : ` commitmentId=${input.commitmentId} decisionEpoch=${input.decisionEpoch ?? 'none'}`
  return `${base}${provenance}${input.detail === undefined ? '' : ` detail=${input.detail}`}`
}

/**
 * issue #437 section 2 CONSUMPTION POINT: the Skill -> policy handoff packet and
 * the decision-epoch machinery are OWNED by `jevSemanticProjection.ts` (the lane
 * that consumes them). This module deliberately defines neither: it names the
 * epoch/commitment a packet closes and feeds it the real `commitmentId` and the
 * `CausalTargetIdentity` key. The §6 lifecycle outcome below maps onto that
 * module's closed `SkillTerminalReason` set through `skillTerminalReasonFor`.
 */
export function skillTerminalReasonFor(outcome: SkillOutcome): SkillTerminalReason {
  switch (outcome) {
    case 'SUCCESS':
      return 'done'
    case 'TARGET_INVALIDATED':
      return 'target_lost'
    case 'SAFETY_INTERRUPT':
      return 'safety_interrupted'
    case 'CAPABILITY_LOST':
      return 'capability_lost'
    case 'WORLD_CHANGED':
      return 'world_changed'
    case 'LEASE_REVOKED':
      return 'lease_revoked'
    case 'BUDGET_EXHAUSTED':
      return 'budget_exhausted'
    case 'MECHANICALLY_BLOCKED':
      return 'blocked'
    case 'CANCELLED':
      return 'lease_revoked'
  }
}

export interface SkillEndEvidence {
  commitmentId: string
  decisionEpoch: number
  skillKind: SkillKind
  candidateId: string
  execution: string
  verification: string
  progress: string
  failureCode: string | null
  outcome: SkillOutcome
  targetIdentityKey: string
  ms: number
}

/** `SKILL_END` - execution/verification/progress/failureCode + target identity. */
export function formatCommittedEnd(input: SkillEndEvidence): string {
  const postcondition = input.progress.length > 0 ? input.progress : 'none'
  return (
    `${formatCanonicalSkillEnd(input.skillKind, input.execution, input.verification, postcondition, input.failureCode)} ` +
    `outcome=${input.outcome} failureCode=${input.failureCode ?? 'none'} ` +
    `targetIdentity=[${input.targetIdentityKey}] commitmentId=${input.commitmentId} ` +
    `decisionEpoch=${input.decisionEpoch} candidateId=${input.candidateId} ms=${input.ms}`
  )
}

/**
 * The declared postcondition of each committed Skill, in words. Evidence only:
 * the postcondition the run ACTUALLY verified still travels on the
 * `ExecutionResult` and through `postconditionHash`.
 */
export function declaredPostconditions(candidate: Candidate): readonly string[] {
  const skill = committedSkillKind(candidate)
  switch (skill) {
    case 'kill':
      return ['the exact selected entity id emits a server entityDead event during this commitment']
    case 'hunt_drop':
      return [
        'the exact selected entity id emits a server entityDead event during this commitment',
        `the selected drop ${candidate.itemName ?? 'unknown'} reaches the inventory (verified delta)`,
      ]
    case 'hold_item':
      return ['the selected item name is in the main hand (live held item)']
    case 'equip_item':
      return ['the selected item name is worn in the selected armor slot (live armor slot)']
    case 'walk_to':
    case 'retreat':
      return ['the body reaches the selected destination (arrival predicate)']
    case 'mine':
      return ['the selected block cell no longer holds the selected block']
    case 'place':
      return ['the selected block exists at the selected cell']
    case 'craft':
      return ['the selected recipe output count increased']
    case 'smelt':
      return ['the selected smelt output is present at the required count OR the furnace consumed the placed input+fuel']
    case 'ignite':
      return ['the nether_portal block exists at every expected portal cell']
    case 'enter_portal':
      return ['the body dimension equals the selected target dimension']
    case 'descend':
    case 'step':
      return ['the selected step/descend cell was cleared and the body advanced']
    case 'retrieve':
      return ['the remembered resource was reached (distance closed) or the item count increased']
    case 'eat':
      return ['the selected food item was consumed']
    case 'wait':
      return ['the bounded wait elapsed (control action, no physical postcondition)']
    case 'escalate':
      return ['control handed to the semantic layer (no physical postcondition)']
  }
}
