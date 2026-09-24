// candidates.ts - the DETERMINISTIC candidate generator.
//
// Runs *before* the model. It enumerates only actions that are actually
// executable against the current world state, so the policy can never pick a
// block or entity that does not exist. Candidate ids encode the concrete
// target, which lets the guard re-validate the exact same object later:
//
//   MINE:b-31_68_12      mine the block at (-31, 68, 12)
//   MOVE:p12_70_8        walk to the standable spot (12, 70, 8)
//   CRAFT:oak_planks     craft one step toward the current craft subgoal
//   PLACE:crafting_table place the held station at a reachable support block
//   SMELT:iron_ingot     put input+fuel into the placed furnace and take output
//   DESCEND:E:down:b…    dig a staircase/tunnel step in a cardinal direction
//   RETREAT:p4_70_9      retreat to the standable spot (4, 70, 9)
//   ATTACK:e19           attack entity id 19
//   EAT:bread            eat one bread
//   WAIT                 do nothing this tick
//   ESCALATE             request a System 2 semantic review
//
// Generation is GOAL-DIRECTED: the current goal-queue subgoal selects the
// resource to mine, the craft step to surface, or the smelt/place operation, so
// the list stays small and every entry makes progress. Safety actions
// (eat/retreat/attack) are always offered regardless of subgoal.
import type { CraftOp, RecipeIndex } from './crafting.ts'
import { describeCraftOp, planNextCraftStep } from './crafting.ts'
import type { BlockState, DescentDir, DescentOption, DescentRefusalReason, EntityState, HarvestTool, KnownResource, MobSpawnContextObservation, StationEntry, Vec3Json, WorldState } from './state.ts'
import { DEFAULT_EAT_BELOW_FOOD, bodyHasUnknownAirWithSubmergedEyes, bodyIsOutOfAir, bodyIsSubmerged, bodyNeedsBreathEscape, bodyStarving, CRAFT_STATIONS, DIRECT_BLOCK_SOURCES, FURNACE_STATIONS, MOB_DROP_PRODUCERS, MOB_SPAWN_CONTEXTS, NETHER_STRUCTURE_BLOCK_NAMES, PICKAXE_RANKS, isStructureFabricSource, mobSpawnContextFor, placementSpotKey, STONE_YIELDS, descentDigPlan, descentPrimaryCell, distance, isSensedStation, scannedBlockNames } from './state.ts'
import { containerBlockForItem, containerObservationAt, containerRef, isContainerBlockName, rollupContainerItems } from './containerAccess.ts'
import type { ContainerItemStack, ContainerRefusal } from './containerAccess.ts'
import { findInventoryFuel, inventoryFuels, isResourceClass, matchesResourceClass, resourceMatches } from './resourceClass.ts'
import type { InventoryFuel } from './resourceClass.ts'
import { isEdibleFoodItem } from './foodSources.ts'
import type { FoodSourceGap, FoodSourceMissingLink } from './foodSources.ts'
import { isProtectedStationBlock, isLiveStructureMember, liveStructureCellKey, liveStructureMemberIndex } from './blockSafety.ts'
import { failureCount } from './failureMemory.ts'
import { selectClearanceTool, selectDigTool, strongestDigRequirement } from './toolChoice.ts'
import { PILLAR_PLACE_PRIORITY, selectPlaceableBlock, planVerticalApproach, planVerticalApproachDetailed, pillarColumnUnsafeFromBlocks, evaluateAscentColumn, VERTICAL_GAP } from './verticalPlan.ts'
import {
  cellKey,
  formatRouteEscalate,
  goalSpentRouteCount,
  isZeroProgressRouteRepeat,
  routeSignature,
  ROUTE_ALL_SPENT_REASON,
  standFamilyExhausted,
} from './zeroProgressRoute.ts'
import type { UpwardRefusalReason, VerticalInput, VerticalPlan } from './verticalPlan.ts'
import { FURNACE_STONE_COST, knownStationKey, planPrereqOptions, prereqSubjectForGoal } from './prereqOption.ts'
import type { KnownStationLike, PrereqInput, PrereqPath, PrereqRankPolicy } from './prereqOption.ts'
import { descentHeadingObstruction, formatDescentHeading } from './descendPlan.ts'
import type { DescentHeadingChangeReason, DescentHeadingObstruction, DescentHeadingPlan } from './descendPlan.ts'
import { digRouteBearing, DIG_ROUTE_ARRIVE_DISTANCE, DIG_ROUTE_MIN_ADVANCE, formatDigRoute, formatDigRouteRefused, planDigRoute } from './digRoute.ts'
import type { DigRouteRefusal, DigRouteRefusalReason, DigRouteStep } from './digRoute.ts'
import { formatWallEntry, groundWallEntries } from './wallEntry.ts'
import type { WallEntryRefusal, WallEntryRoute, WallProbe } from './wallEntry.ts'
import { formatLevelScan, groundLevelScan } from './levelScan.ts'
import type { LevelScanRefusalReason } from './levelScan.ts'
import { DIG_PATH_CAP } from './worldMemory.ts'
import type { DigMode } from './worldMemory.ts'
import {
  BRIDGE_AUTHORITY_META,
  BRIDGE_BLOCK_META,
  BRIDGE_DIR_META,
  BRIDGE_LANDING_META,
  BRIDGE_LINE_META,
  BRIDGE_MAX_SPAN,
  BRIDGE_MAY_PLACE_META,
  BRIDGE_META,
  BRIDGE_PLACE_META,
  BRIDGE_POCKET_EVIDENCE_META,
  BRIDGE_REFUSED_META,
  BRIDGE_SELF_LANDING_META,
  BRIDGE_SPAN_META,
  BRIDGE_TARGET_META,
  bridgeContractMeta,
  formatBridgeRefused,
  isBridgeMove,
  planBridgeRoute,
} from './bridgeRoute.ts'
import type { BridgePlan, BridgeRefusal } from './bridgeRoute.ts'
import type { DescendPlanRefusalReason } from './reachability.ts'
import {
  DESCEND_SCAFFOLD_BLOCK_META,
  DESCEND_SCAFFOLD_FROM_META,
  DESCEND_SCAFFOLD_GAP_META,
  DESCEND_SCAFFOLD_LANDING_META,
  DESCEND_SCAFFOLD_PLACE_META,
  DESCEND_SCAFFOLD_POCKET_META,
  DESCEND_SCAFFOLD_REFERENCE_META,
  DESCEND_SCAFFOLD_REFUSED_META,
  descentScaffoldBridgeReason,
  descendScaffoldReachabilityReason,
  formatDescentScaffoldRefused,
  planDescentScaffoldStep,
} from './descentScaffold.ts'
import type { DescentScaffoldPlan, DescentScaffoldRefusal } from './descentScaffold.ts'
import { FOOD_SMELT_INPUT, fuelCountFor, loadGameData, resolveHarvest, smeltInputFor as smeltInputName, PICKAXE_TIER_ORDER, smeltInventorySufficient } from './gameData.ts'
import { ASCEND_GAP_LIMIT, bestToolTier, capabilityKey, DESCEND_GAP_LIMIT, evaluateReachability, HAZARD_PROXIMITY, INTERACTION_STAND_DY, INTERACTION_STAND_OFFSETS, interactionFaceDistance, missingToolCapability, reachabilityFingerprint, reachabilityTargetSignature } from './reachability.ts'
import type { AscendPlanRefusalReason } from './reachability.ts'
import type { Capability, DigAccessRefusal, DigApproachProbe, DimensionTransferRoute, PathProbeResult, ReachabilityAbilities, ReachabilityBarrier, ReachabilityResult, ReachabilityTarget, ReachabilityWorld, StationApproachProbe, StationKindName } from './reachability.ts'
import { moveFailureKey, StateFingerprintMemory } from './moveFailMemory.ts'
import { MAX_DEPENDENCY_DEPTH, collectItemForClass, inventoryClassCount, inventoryCount, selectCraftIngredients } from './optionSpec.ts'
import type { CraftIngredientNeed } from './optionSpec.ts'
import {
  FLINT_AND_STEEL,
  NETHER_PORTAL,
  OBSIDIAN,
  PORTAL_ENTERED_PREDICATE,
  PORTAL_LIT_PREDICATE,
  PORTAL_ENTER_SKILL,
  PORTAL_OPEN_FACE_MAX_DISTANCE,
  PORTAL_WALK_IN_LEVEL_TOLERANCE,
  formatReflex,
  formatSkillPolicyBoundary,
  formatSkillStep,
  formatSkillStepAuthority,
  groundPortalFrame,
  planPortalIgnition,
  portalOpenFaceCells,
  serializePortalCells,
} from './netherPortalPlan.ts'
import type { PortalBlockPosition, PortalEntryCandidate, PortalEntryPlan, PortalFrameValidation } from './netherPortalPlan.ts'
import { armorCraftTargets, armorEquipOffers, armorEquipRefusals, armorSlotFor, assessCombatKit, combatSwingFor, CRAFTABLE_SWORDS, weaponArmOffers, weaponDamage as gearWeaponDamage } from './gearPlan.ts'
import type { ArmorCraftOffer, ArmorCraftRefusal, ArmorCraftTarget, ArmorRefusal, CombatKitAssessment } from './gearPlan.ts'
import {
  activeThreats,
  bodySurvivalFacts,
  isResponseWorthyThreat,
  MELEE_THREAT_REACH,
  selectKeepDistanceSpots,
  THREAT_DANGER_RADIUS,
  THREAT_MEMORY_MS,
  THREAT_RESPONSE_RANGE,
  threatStandoffRange,
  UNSENSED_MIN_KEEP_DISTANCE_GAIN,
  unsensedAttackerFacts,
  unsensedThreatResponse,
  weaponFacts,
} from './threat.ts'
import type { UnsensedAttacker, UnansweredThreatResponse } from './threat.ts'
import type { KeepDistanceSpot, ThreatEntityLike, ThreatStateEvidence } from './threat.ts'
import {
  classifyContactApproach,
  contactGapY,
  formatContactUnreachable,
  HUNT_APPROACH_BUDGET,
  MELEE_ATTACK_REACH,
  meleeWalkGap,
} from './combatClosure.ts'
import type { AttackStandEvidence, AttackStandFact, ContactApproach } from './combatClosure.ts'
import {
  envHazardProximityDenied,
  MAX_ENV_HAZARD_ESCAPES,
  selectEnvHazardEscapes,
} from './envHazard.ts'
import type { EnvHazardCell, EnvHazardEscape, EnvHazardKind, EnvHazardState } from './envHazard.ts'

// The threat envelope numbers and the response predicate are owned by
// `threat.ts` (it also keeps the bounded danger state and scans the escape
// cells). They stay re-exported here because the candidate layer and its
// fixtures name them at this boundary.
export { isResponseWorthyThreat, THREAT_MEMORY_MS, THREAT_RESPONSE_RANGE }

export type CandidateKind =
  | 'MINE'
  | 'MOVE'
  | 'CRAFT'
  | 'PLACE'
  | 'SMELT'
  | 'CONTAINER'
  | 'IGNITE'
  | 'ENTER_PORTAL'
  | 'DESCEND'
  | 'STEP'
  | 'RETRIEVE'
  | 'PICKUP'
  | 'ATTACK'
  | 'EAT'
  | 'EQUIP'
  | 'RETREAT'
  | 'WAIT'
  | 'ESCALATE'

export interface CandidateAffordance {
  feasible: boolean
  reason: ReachabilityResult['reason']
  missingCapabilities: readonly Capability[]
}

export interface Candidate {
  id: string
  kind: CandidateKind
  /** one-line human description, used as the Jev choice criteria text */
  label: string
  targetName: string | null
  target: Vec3Json | null
  targetEntityId: number | null
  itemName: string | null
  requiresTool: boolean
  toolName: 'pickaxe' | 'axe' | 'shovel' | null
  /** minimum pickaxe rank required for `requiresTool` (see PICKAXE_RANKS) */
  toolTier?: number | null
  /** target was within reach when the sensor ran */
  inReach: boolean
  hasStandableAdjacent: boolean
  /** deterministic affordance facts: infeasible candidates are never presented */
  affordance?: CandidateAffordance
  /** ordered cells a multi-cell PLACE fills with `itemName` (generic frame build) */
  placementCells?: Vec3Json[]
  /** plane axis of a placement sequence; 'x' spans x (normal z), 'z' spans z */
  placementAxis?: 'x' | 'z'
  /**
   * The typed stance refusal this candidate was withheld with (`no_attack_stand`),
   * when the ATTACK gate could not ground a cell the body can stand on, legally,
   * inside the melee envelope AND see the entity from. Typed rather than a `meta`
   * scalar because a reviewer needs the whole geometry (entity, melee constant,
   * nearest refused stance and the route verdict), and it is mirrored verbatim as
   * `NO_ATTACK_STAND`. Absent on every other candidate, so nothing else changes.
   */
  attackStandRefusal?: AttackStandEvidence
  meta: Record<string, string | number | boolean>
}

/**
 * A work action is not a safe response to a hostile entity already inside
 * melee distance.  This is a hard safety envelope, not an attack preference:
 * Jev still chooses between the grounded ATTACK and RETREAT candidates.  The
 * envelope only removes MINE/MOVE/CRAFT/etc. while the threat is physically
 * immediate, so a slow policy call cannot leave the executor digging through
 * a hit window.
 *
 * The number itself is owned by `threat.ts` (`MELEE_THREAT_REACH`) so the
 * contact envelope, the danger state and the escape scan cannot drift apart.
 */
export const IMMEDIATE_HOSTILE_RANGE = MELEE_THREAT_REACH

/**
 * Farther hostiles remain world observations, but are not combat reactions.
 * The executor may follow an entity mechanically, yet offering a 20m+ attack
 * when the active goal is temporarily blocked turns Jev's pi choice into an
 * unproductive travel plan.  Within this envelope Jev still owns ATTACK versus
 * RETREAT; beyond it the next grounded goal/recovery candidate stays visible.
 *
 * This is the bounded danger radius (`THREAT_DANGER_RADIUS`): a walking hostile
 * inside it closes to melee within one policy decision, so the survival offer
 * must be grounded here rather than only at contact range.
 */
/**
 * issue #436/#11 (operator directive: "even if a mob is not in the hostile list,
 * Jev could simply decide to attack it").
 *
 * Code owns the entity TRUTH; code does NOT own "which entities are worth
 * attacking". These sets are the non-mob FAMILIES a melee swing can never resolve
 * into a kill - dropped items, xp orbs, projectiles and the decorative/technical
 * entities. Excluding them is entity truth, not a preference: they are not
 * living targets, so offering an ATTACK for them would be a lie about CAN.
 */
const NON_MOB_ENTITY_KINDS: ReadonlySet<string> = new Set([
  'object',
  'orb',
  'projectile',
  'arrow',
  'item',
  'xp_orb',
  'experience_orb',
  'area_effect_cloud',
  'armor_stand',
  'end_crystal',
  'eye_of_ender',
  'firework_rocket',
  'falling_block',
  'tnt',
  'boat',
  'chest_boat',
  'minecart',
  'painting',
  'item_frame',
  'glow_item_frame',
  'leash_knot',
  'lightning_bolt',
  'evoker_fangs',
  'fishing_bobber',
  'egg',
  'ender_pearl',
  'snowball',
  'potion',
  'splash_potion',
  'lingering_potion',
  'trident',
  'shulker_bullet',
  'llama_spit',
  'dragon_fireball',
  'fireball',
  'small_fireball',
  'wither_skull',
  'spectral_arrow',
  'experience_bottle',
])

/** Names Mineflayer uses for non-living entities that carry no mob `kind`. */
const NON_MOB_ENTITY_NAMES: ReadonlySet<string> = new Set([
  'item',
  'xp_orb',
  'experience_orb',
  'armor_stand',
  'item_frame',
  'glow_item_frame',
  'painting',
  'arrow',
  'spectral_arrow',
  'snowball',
  'egg',
  'ender_pearl',
  'eye_of_ender',
  'potion',
  'splash_potion',
  'lingering_potion',
  'experience_bottle',
  'firework_rocket',
  'fishing_bobber',
  'leash_knot',
  'area_effect_cloud',
  'evoker_fangs',
  'lightning_bolt',
  'falling_block',
  'tnt',
  'boat',
  'chest_boat',
  'minecart',
  'trident',
  'shulker_bullet',
  'llama_spit',
  'dragon_fireball',
  'fireball',
  'small_fireball',
  'wither_skull',
  'unknown',
])

/**
 * True when a sensed entity is a LIVING mob a melee ATTACK could resolve. Pure and
 * flag-independent: the hostile flag is a fact CARRIED on the candidate, never the
 * reason the candidate exists. The body itself never reaches here (the sensor
 * skips `bot.entity.id`).
 */
export function isAttackableEntity(entity: { name: string; kind: string }): boolean {
  if (NON_MOB_ENTITY_KINDS.has(entity.kind)) return false
  if (NON_MOB_ENTITY_NAMES.has(entity.name)) return false
  return true
}

/** The item this mob is a known producer for, or null (producer truth only). */
export function producerDropFor(entityName: string): string | null {
  for (const [item, producers] of Object.entries(MOB_DROP_PRODUCERS)) {
    if (producers.has(entityName)) return item
  }
  return null
}

export const COMBAT_CANDIDATE_RANGE = THREAT_DANGER_RADIUS

/**
 * At this health the bot cannot safely trade another melee hit for one more
 * attack lease.  This is a hard safety envelope, not a combat preference:
 * above it Jev still chooses ATTACK versus RETREAT; below it ATTACK is kept
 * only when no grounded escape response exists.
 */
export const CRITICAL_COMBAT_HEALTH = 6

/**
 * The candidate kinds that can end a submersion. Movement carries the
 * `ASCEND:surface:*` route (kind MOVE); RETREAT is the other grounded escape and
 * ESCALATE hands the situation to the semantic layer. Everything kept out of
 * this set mechanically holds the body where it is while the breath runs out.
 */
export const SURVIVAL_KINDS: ReadonlySet<CandidateKind> = new Set<CandidateKind>([
  'MOVE',
  'RETREAT',
  'STEP',
  'ESCALATE',
])

/**
 * Bound on distinct retreat destinations offered, so Jev can pick a direction
 * instead of being handed a single spot. Small and fixed so the candidate list
 * cannot be crowded by escape routes.
 */
export const MAX_RETREAT_CANDIDATES = 3

/**
 * The kinds that answer a hostile at contact range: an attack with whatever the
 * body holds, a grounded keep-distance route, a bounded escalation, and the two
 * local self-care actions that change what the body can survive with (eat to keep
 * regeneration running, arm the best carried weapon).
 *
 * `WAIT`/work actions mechanically leave the body inside a hit window, which is
 * the measured death shape, so they stay out. But the narrower contact envelope
 * must not be STRICTER than the wider `THREAT_SURVIVAL_KINDS` danger envelope:
 * measured live (`buddy.log` 2026-09-22T10:49:5x) the body was in contact with a
 * magma_cube while both EAT and the weapon arm were erased by this filter, and
 * the measured starvation attrition (`food:0` under attack, never one EAT) is the
 * same shape at the danger band. Self-care is CAN, and WHICH action is taken
 * stays Jev's choice.
 */
export const CONTACT_THREAT_KINDS: ReadonlySet<CandidateKind> = new Set<CandidateKind>([
  'ATTACK',
  'RETREAT',
  'ESCALATE',
  'EAT',
  'EQUIP',
])

/**
 * The kinds that keep answering a hostile while the bounded danger state is
 * active. Adds the local self-care actions: eating (saturation healing) and
 * putting on armor are survival, not work, and must not be erased by the
 * restriction. WHICH of these is taken stays Jev's choice.
 */
export const THREAT_SURVIVAL_KINDS: ReadonlySet<CandidateKind> = new Set<CandidateKind>([
  'ATTACK',
  'RETREAT',
  'ESCALATE',
  'EAT',
  'EQUIP',
])

/**
 * The bounded escalation offered when the body is under threat and the code
 * cannot ground a single attack or keep-distance route. Returning the work set
 * here (the pre-existing fallback) is exactly the measured "keeps mining next to
 * the zombie" behaviour, so the fallback is now an explicit capability gap the
 * semantic layer can act on - never a silent return to work.
 */
export function threatEscalateCandidate(reason: string, tick = 0): Candidate {
  return {
    id: 'ESCALATE',
    kind: 'ESCALATE',
    label: `request System 2 review (${reason})`,
    targetName: null,
    target: null,
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: true,
    hasStandableAdjacent: true,
    meta: { tick, reason, threatResponse: true },
  }
}

type DescentRecoveryOutcome = 'BLOCKED' | 'BUDGET_EXHAUSTED' | 'RECURRENT_STATE'

/** A bounded control candidate that returns an exhausted local Skill to policy. */
function descentPolicyEscalateCandidate(input: {
  tick: number
  reason: string
  outcome: DescentRecoveryOutcome
  label: string
}): Candidate {
  return {
    id: 'ESCALATE',
    kind: 'ESCALATE',
    label: input.label,
    targetName: null,
    target: null,
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: true,
    hasStandableAdjacent: true,
    meta: {
      tick: input.tick,
      reason: input.reason,
      skillOutcome: input.outcome,
      legPolicyBoundary: formatSkillPolicyBoundary({
        skill: 'DESCEND(groundedRoute)',
        reason: input.reason,
        alternatives: [],
      }),
    },
  }
}

export function restrictCandidatesDuringImmediateThreat(
  state: Pick<WorldState, 'entities'>,
  candidates: readonly Candidate[],
): Candidate[] {
  const immediateHostile = state.entities.some((entity) => entity.hostile && entity.distance <= IMMEDIATE_HOSTILE_RANGE)
  if (!immediateHostile) return [...candidates]
  const combat = candidates.filter((candidate) => CONTACT_THREAT_KINDS.has(candidate.kind))
  // A body in melee contact with no grounded attack and no grounded escape must
  // NOT be handed its work set back: that is the measured "digs while the zombie
  // kills it" loop. Offer the bounded escalation instead and let the controller
  // name the missing affordance (`THREAT_NO_ESCAPE`).
  return combat.length > 0 ? combat : [threatEscalateCandidate('no_grounded_threat_response')]
}

/**
 * A critical-health response must not silently fall back to an attack that was
 * already in flight - but it must not take the choice away from Jev either.
 *
 * The set this keeps is the SAME set its sibling (`restrictCandidatesDuringDangerousThreat`)
 * documents as the survival/self-care actions it keeps and leaves WHICH to Jev:
 * `ATTACK`, `RETREAT`, `ESCALATE`, `EAT`, `EQUIP`. Dropping `ATTACK` here made code, not
 * Jev, choose "flee" - and the measured consequence is a body pinned at health 10 in the
 * Nether with a magma cube in contact and no food: it could neither win by fleeing nor heal,
 * and the offer was three RETREAT cells plus an ESCALATE for tick after tick
 * (`RETREAT:p14_37_-7 / -8 / -9` at 0.59-2.43 m, health 10 unchanged, no death). An ATTACK
 * that is grounded (the entity is sensed in reach and a weapon is held) is exactly the kind
 * of second valid option the operator's authority split says must go to Jev rather than be
 * ranked by code. The original purpose still holds: nothing here re-ranks, and a set with no
 * grounded survival action at all is preserved unchanged so the missing affordance stays
 * observable.
 */
export function restrictCandidatesAtCriticalHealth(
  state: Pick<WorldState, 'entities' | 'self'>,
  candidates: readonly Candidate[],
): Candidate[] {
  const immediateHostile = state.entities.some(
    (entity) => entity.hostile && entity.distance <= IMMEDIATE_HOSTILE_RANGE,
  )
  if (!immediateHostile || state.self.health > CRITICAL_COMBAT_HEALTH) return [...candidates]
  const survival = candidates.filter(
    (candidate) =>
      candidate.kind === 'ATTACK' ||
      candidate.kind === 'RETREAT' ||
      candidate.kind === 'ESCALATE' ||
      candidate.kind === 'EAT' ||
      candidate.kind === 'EQUIP',
  )
  return survival.length > 0 ? survival : [...candidates]
}

/**
 * SAFE: while the bounded danger state is ACTIVE, work actions do not stay
 * selectable. This is the state half of the measured death loop: the body
 * retreated once while a zombie was inside `IMMEDIATE_HOSTILE_RANGE`, then went
 * straight back to digging/retrieving/crafting the moment the mob left that
 * single snapshot. The zombie followed, landed the next hit, and health eroded
 * 20 -> 18 -> 16 -> 2 -> death over a minute with no state that remembered the
 * fight was still on.
 *
 * The state itself (`ThreatTracker`) enters on the threat predicate and leaves
 * only when the whole envelope has been continuously clear for a bounded
 * interval, so this restriction cannot flap per tick. It keeps every grounded
 * survival/self-care action (`ATTACK`, `RETREAT`, `ESCALATE`, `EAT`, `EQUIP`)
 * and leaves WHICH one to Jev; when the code can ground none of them it returns
 * a bounded ESCALATE and the caller mirrors the capability gap
 * (`THREAT_NO_ESCAPE`) instead of silently handing the work set back.
 */
export function restrictCandidatesDuringDangerousThreat(
  state: Pick<WorldState, 'entities' | 'signals'>,
  candidates: readonly Candidate[],
): Candidate[] {
  const threat = state.signals?.threat ?? null
  if (threat === null || threat.active !== true) return [...candidates]
  const survival = candidates.filter((candidate) => THREAT_SURVIVAL_KINDS.has(candidate.kind))
  if (survival.length > 0) return survival
  return [
    threatEscalateCandidate(
      threat.threatName === null ? 'no_grounded_threat_response' : `no_grounded_threat_response:${threat.threatName}`,
    ),
  ]
}

/**
 * The exact threat offer the controller applies: contact-range restriction,
 * then the persistent danger-state restriction. Returns the code-owned gap so
 * the caller can mirror `THREAT_NO_ESCAPE` when the body was left with nothing
 * but an escalation while a hostile is on it.
 */
export interface ThreatRestrictionFacts {
  /** Ordinary hostile ids whose current melee approach was proven no_path. */
  unreachableThreatEntityIds?: ReadonlySet<number>
}

export interface ThreatOffer {
  candidates: Candidate[]
  /** the danger state this offer was computed against (null when none) */
  threat: ThreatStateEvidence | null
  /** true when work actions were removed because of the threat */
  restricted: boolean
  /** the body is at contact range right now */
  inContact: boolean
  /** code grounded no attack and no keep-distance route under threat */
  gap: { reason: string } | null
  /**
   * Current danger-radius hostiles are all occluded and have no melee path. The
   * conservative tracker remains active, but this snapshot does not suppress
   * goal work solely because Euclidean distance is small through sealed terrain.
   */
  occluded: { reason: 'no_los_no_path'; entityIds: number[] } | null
}

function occludedThreatBypass(
  state: Pick<WorldState, 'entities' | 'signals' | 'timestampMs'>,
  facts: ThreatRestrictionFacts,
): { reason: 'no_los_no_path'; entityIds: number[] } | null {
  const threat = state.signals?.threat ?? null
  const unreachable = facts.unreachableThreatEntityIds ?? new Set<number>()
  if (threat === null || threat.active !== true || unreachable.size === 0) return null
  // A recent hit keeps the survival envelope conservative even if the attacker
  // has just moved behind cover. This preserves the original hysteresis safety.
  const damage = state.signals.lastDamage ?? null
  if (damage !== null && Number.isFinite(damage.atMs) && state.timestampMs - damage.atMs <= THREAT_MEMORY_MS) return null

  const nearby = state.entities.filter(
    (entity) => entity.hostile && Number.isFinite(entity.distance) && entity.distance <= THREAT_DANGER_RADIUS,
  )
  if (nearby.length === 0) return null // lingering clear-state hysteresis stays unchanged
  const allOccludedAndUnreachable = nearby.every(
    (entity) =>
      entity.distance > IMMEDIATE_HOSTILE_RANGE &&
      entity.attackedSelf !== true &&
      entity.lineOfSight === false &&
      unreachable.has(entity.id),
  )
  if (!allOccludedAndUnreachable) return null
  return { reason: 'no_los_no_path', entityIds: nearby.map((entity) => entity.id).sort((a, b) => a - b) }
}

/**
 * Project the reachability layer's CURRENT ordinary-hostile CAN facts into the
 * threat restriction. Both decision-time offer generation and the pre-execution
 * guard MUST call this adapter; otherwise the same state can expose goal work to
 * Jev and then erase it during revalidation.
 */
// ---------------------------------------------------------------------------
// #plan-reconciliation: the code-owned not-executable-here fact bound to the OFFER
// ---------------------------------------------------------------------------
//
// Measured live (`run-muctsqt6-27ocr`, main 3002d84): the durable head was
// `g14:descend:raw_iron` declaring `minecraft:overworld` with the success
// predicate `levelAtMost y32`, while the body was in the NETHER at y37 and hp 10.
// The queue layer had already PROVEN the row cannot run there
// (`ROW_NOT_EXECUTABLE_HERE declared=overworld live=the_nether`), and the
// escalation that replaces it was in flight - yet the offer still carried the
// row's own descent, so the body kept DESCENDING toward y32 in the Nether, which
// is where the lava is. The safe verdict and the physical actions disagreed, and
// the disagreement pointed at the hazard.
//
// This binding keeps the OFFER honest while the proof holds: only control and
// self-care kinds stay on offer, so the next decision cannot drive the body toward
// a predicate it cannot reach here. It never reorders or retires a queue row, and
// a code-owned safety envelope always outranks it (an escape route must never be
// removed by this rule).

/** The queue's proven "this head cannot execute in the live dimension" fact. */
export interface NotExecutableHereBinding {
  goalId: string
  goalKey: string
  declaredDimension: string | null
  liveDimension: string | null
  /** the queue's own reason (`no_executable_alternative`, `defer_budget_exhausted`) */
  reason: string
}

/**
 * The kinds this binding withholds: the ones that MOVE THE BODY or DIG THE WORLD
 * toward the row's own (unreachable here) predicate.
 *
 * The first version of this withheld every work kind and deadlocked the body for
 * an hour (main 06c5976: 1370 firings, the goal's own climb legs and even a needed
 * pickaxe craft withheld, body frozen at 26.3,64.0,6.3 for the whole trial). A
 * mis-dimensioned row is a reason to stop walking/digging toward its predicate,
 * never a reason to stop working: CRAFT/SMELT/PLACE/CONTAINER/IGNITE/RETRIEVE/
 * MINE/ENTER_PORTAL/ATTACK/EAT/EQUIP/RETREAT/WAIT/ESCALATE all stay on offer.
 */
export const NOT_EXECUTABLE_HERE_WITHHELD_KINDS: ReadonlySet<CandidateKind> = new Set<CandidateKind>([
  'MOVE',
  'STEP',
  'DESCEND',
])

export function isNotExecutableHereWithheldKind(kind: CandidateKind): boolean {
  return NOT_EXECUTABLE_HERE_WITHHELD_KINDS.has(kind)
}

export type NotExecutableHereOfferReason =
  | 'no_binding'
  | 'safety_envelope_active'
  | 'no_kept_candidates'
  | 'bound'
  | 'not_narrowing'

export interface NotExecutableHereOfferRestriction {
  candidates: Candidate[]
  withheld: Candidate[]
  bound: boolean
  reason: NotExecutableHereOfferReason
}

/**
 * Is a code-owned safety envelope narrowing the raw offer right now?
 *
 * Reuses the SAME restriction functions that shape the live offer, applied to the
 * pre-safety-envelope list, so a new safety envelope automatically vetoes this
 * binding instead of having to be added here. A body in lava/fire, out of air, in
 * critical damage, at critical health with a hostile on it, or under a named
 * attacker is in a safety envelope and keeps its full escape offer.
 */
export function safetyEnvelopeActive(state: WorldState, rawCandidates: readonly Candidate[]): boolean {
  if (rawCandidates.length === 0) return false
  const probes: Candidate[][] = [
    restrictCandidatesAtCriticalHealth(state, rawCandidates),
    restrictCandidatesDuringCriticalDamage(state, rawCandidates),
    restrictCandidatesDuringSubmersion(state, rawCandidates),
    restrictCandidatesDuringEnvHazard(state, rawCandidates),
    restrictCandidatesDuringUnseenAttacker(state, rawCandidates),
    applyGroundedThreatRestriction(state, rawCandidates, []).candidates,
  ]
  return probes.some((probe) => probe.length < rawCandidates.length)
}

/**
 * Bind the queue's not-executable-here proof to the physical offer. Pure.
 * `rawCandidates` is the offer BEFORE the safety-envelope restrictions, so the
 * safety veto sees what the body would otherwise be allowed to do.
 */
export function restrictCandidatesNotExecutableHere(
  state: WorldState,
  candidates: readonly Candidate[],
  binding: NotExecutableHereBinding | null,
  rawCandidates: readonly Candidate[] = candidates,
): NotExecutableHereOfferRestriction {
  if (binding === null) {
    return { candidates: [...candidates], withheld: [], bound: false, reason: 'no_binding' }
  }
  if (safetyEnvelopeActive(state, rawCandidates)) {
    return { candidates: [...candidates], withheld: [], bound: false, reason: 'safety_envelope_active' }
  }
  const kept = candidates.filter((candidate) => !isNotExecutableHereWithheldKind(candidate.kind))
  if (kept.length === 0) {
    // Never hand an empty offer to the decision layer: with nothing but withheld
    // body-motion left, the pre-existing starvation/escalation machinery owns the
    // tick (and the queue's own escalation is already running).
    return { candidates: [...candidates], withheld: [], bound: false, reason: 'no_kept_candidates' }
  }
  const withheld = candidates.filter((candidate) => isNotExecutableHereWithheldKind(candidate.kind))
  if (withheld.length === 0) {
    return { candidates: kept, withheld: [], bound: false, reason: 'not_narrowing' }
  }
  return { candidates: kept, withheld, bound: true, reason: 'bound' }
}

export function formatNotExecutableHereBinding(
  binding: NotExecutableHereBinding,
  restriction: NotExecutableHereOfferRestriction,
  goalQueueHead: string,
): string {
  return (
    `ROW_NOT_EXECUTABLE_HERE_BINDING goalId=${binding.goalId} goal=${binding.goalKey}` +
    ` declared=${binding.declaredDimension ?? 'none'} live=${binding.liveDimension ?? 'unknown'}` +
    ` queueReason=${binding.reason} withheld=${restriction.withheld.length}` +
    ` kept=[${restriction.candidates.map((candidate) => candidate.kind).join(',')}]` +
    ` action=${restriction.reason} head=${goalQueueHead}`
  )
}

export function formatNotExecutableHereInterrupt(
  binding: NotExecutableHereBinding,
  actionId: string,
  actionKind: CandidateKind,
): string {
  return (
    `ROW_NOT_EXECUTABLE_HERE_INTERRUPT actionId=${actionId} actionKind=${actionKind}` +
    ` goalId=${binding.goalId} goal=${binding.goalKey}` +
    ` declared=${binding.declaredDimension ?? 'none'} live=${binding.liveDimension ?? 'unknown'}`
  )
}

export function applyGroundedThreatRestriction(
  state: Pick<WorldState, 'entities' | 'signals' | 'timestampMs'>,
  candidates: readonly Candidate[],
  withheld: readonly CandidateReachability[],
): ThreatOffer {
  const unreachableThreatEntityIds = new Set<number>(
    withheld
      .filter(
        (entry) =>
          entry.candidate.kind === 'ATTACK' &&
          // `no_path` and `no_attack_stand` are the SAME fact for this set ("this
          // hostile's melee approach is not groundable by CAN"), with the more
          // precise name now that the stance geometry is checked: a mob behind
          // sealed terrain has no path AND no stance that can hit it, so omitting
          // the new reason would silently stop releasing work for exactly the
          // occluded shape this bypass exists for.
          (entry.result.reason === 'no_path' || entry.result.reason === 'no_attack_stand') &&
          entry.candidate.targetEntityId !== null,
      )
      .map((entry) => entry.candidate.targetEntityId as number),
  )
  return applyThreatRestriction(state, candidates, { unreachableThreatEntityIds })
}

export function applyThreatRestriction(
  state: Pick<WorldState, 'entities' | 'signals' | 'timestampMs'>,
  candidates: readonly Candidate[],
  facts: ThreatRestrictionFacts = {},
): ThreatOffer {
  const threat = state.signals?.threat ?? null
  const inContact = state.entities.some((entity) => entity.hostile && entity.distance <= IMMEDIATE_HOSTILE_RANGE)
  const occluded = occludedThreatBypass(state, facts)
  if (occluded !== null) {
    return { candidates: [...candidates], threat, restricted: false, inContact: false, gap: null, occluded }
  }
  const contact = restrictCandidatesDuringImmediateThreat(state, candidates)
  const restricted = restrictCandidatesDuringDangerousThreat(state, contact)
  const onlyEscalate = restricted.length === 1 && restricted[0]?.kind === 'ESCALATE'
  const gap = onlyEscalate && (threat?.active === true || inContact) ? { reason: 'no_grounded_threat_response' } : null
  return {
    candidates: restricted,
    threat,
    restricted: restricted.length !== candidates.length,
    inContact,
    gap,
    occluded: null,
  }
}

/**
 * SAFE: while the body is out of air, only routes that can end the submersion
 * stay selectable - movement (including the `ASCEND:surface:*` route, which is
 * a MOVE), retreat and an escalate. `PLACE`/`ATTACK`/`MINE`/`CRAFT`/`SMELT`
 * mechanically keep the body where it is while the breath runs out, which is
 * the measured `ATTACK:e4698` death shape (2026-09-21T16:59:34.792Z, body at
 * (67.5,58.3,28.5)).
 *
 * This is the same deterministic-restriction pattern as
 * `restrictCandidatesAtCriticalHealth`, and it keeps Jev's choice: every
 * grounded way out of the water is offered and WHICH one is taken is still the
 * model's decision. If perception grounds no rescue at all, the original set is
 * preserved so the missing affordance stays observable instead of silently
 * erasing the candidate set.
 */
export function restrictCandidatesDuringSubmersion(
  state: Pick<WorldState, 'self'>,
  candidates: readonly Candidate[],
): Candidate[] {
  if (bodyHasUnknownAirWithSubmergedEyes(state.self)) {
    // Unknown breath with the head confirmed underwater is not a safe fact.
    // Keep only a grounded upward route (or a semantic handoff if no route is
    // available); generic movement, combat, work and WAIT do not prove that the
    // body will leave the water.
    const ascent = candidates.filter(
      (candidate) =>
        candidate.kind === 'ESCALATE' ||
        (candidate.kind === 'MOVE' &&
          (candidate.meta.submersionEscape === true || candidate.meta.surfaceAscent === true)),
    )
    if (ascent.length > 0) return ascent
    const escalation = candidates.find((candidate) => candidate.kind === 'ESCALATE')
    const tick = candidates
      .map((candidate) => candidate.meta.tick)
      .find((value): value is number => typeof value === 'number' && Number.isFinite(value))
    return [escalation ?? threatEscalateCandidate('head_submerged_air_unknown', tick)]
  }
  if (!bodyIsOutOfAir(state.self)) return [...candidates]
  const rescue = candidates.filter((candidate) => SURVIVAL_KINDS.has(candidate.kind))
  return rescue.length > 0 ? rescue : [...candidates]
}

/**
 * SAFE: while the body is at critical health and still absorbing damage, only
 * routes that can END the damage stay selectable. This is the same
 * deterministic-restriction pattern as `restrictCandidatesDuringSubmersion` and
 * `restrictCandidatesAtCriticalHealth`, extended to damage that has no
 * attributed attacker.
 *
 * Measured `run-mubj6ucc-si3e` (source e37e0237): 14 HP -> 1 HP with `food:0`
 * on every `hp_changed`, every `mob_appeared` outside reaction range, an open
 * y=52..55 pocket, and `trigger=damage_taken -> action=WAIT` over and over. The
 * offer held MOVE/RETREAT/ENTER/WAIT, none of which ends starvation, and the
 * plan settled into WAIT until the body was one hit from death.
 *
 * The kept set is every grounded way to end the damage - movement/retreat/step
 * (repositioning away from an environmental source), eating, a food-animal hunt
 * (the grounded route to food), and ESCALATE (hand the situation to the
 * semantic layer). WHICH one is taken stays Jev's choice. If perception grounds
 * no damage-ending route at all the original set is preserved, so the missing
 * affordance stays observable instead of silently erasing the candidate set -
 * the controller then proves exhaustion with `CRITICAL_DAMAGE_EXHAUSTED`.
 */
export const CRITICAL_DAMAGE_KINDS: ReadonlySet<CandidateKind> = new Set<CandidateKind>([
  ...SURVIVAL_KINDS,
  'EAT',
])

/**
 * The exact damage-ending subset of an offer: the same predicate
 * `restrictCandidatesDuringCriticalDamage` keeps, exported so the controller and
 * fixtures can name the code-owned fact "no rescue is grounded" without
 * re-listing kinds and drifting from the restriction.
 */
export function damageEndingCandidates(candidates: readonly Candidate[]): Candidate[] {
  return candidates.filter(
    (candidate) =>
      CRITICAL_DAMAGE_KINDS.has(candidate.kind) ||
      // A food route is the grounded route to food, not a combat/crafting
      // preference: the hunt ATTACK, the forage/acquire MINE and the cook CRAFT
      // are the ones that can end starvation. Any other ATTACK/CRAFT/MINE keeps
      // the body working while the hunger bar kills it. `foodAnimal` stays
      // accepted on its own: it is the older typed hunt fact and a stale or
      // foreign candidate may carry only that one.
      typeof candidate.meta.foodRoute === 'string' || candidate.meta.foodAnimal === true,
  )
}

export function restrictCandidatesDuringCriticalDamage(
  state: Pick<WorldState, 'signals' | 'self'>,
  candidates: readonly Candidate[],
): Candidate[] {
  const evidence = state.signals.criticalDamage ?? null
  if (evidence?.active !== true && !bodyStarving(state.self)) return [...candidates]
  const rescue = damageEndingCandidates(candidates)
  return rescue.length > 0 ? rescue : [...candidates]
}

// ---------------------------------------------------------------------------
// SAFE: the bounded answer to an attacker the sensor never placed.
//
// Measured live (main `cd7b38b`, operator-summoned ender dragon at the fortress
// approach; server log `/summon minecraft:ender_dragon`, then `AI_Buddy was
// killed by Ender Dragon using magic`):
//
//   THREAT_RANGED_UNANSWERED threat=ender_dragon distance=null sensed=false
//   CRITICAL_DAMAGE health=5 food=20 source=ender_dragon damage=1 limit=3
//   DEATH_CAUSE killer=ender_dragon killerEvidence=mineflayer killerId=39414 threat=null
//
// The damage was attributed to a NAMED entity that never entered the sensor, so
// `activeThreats` and `signals.threat` both stayed empty and the danger-state
// restriction never armed. Nothing else owned "the body is being hit by an
// attacker it cannot see", so the tick could end on a no-op while health fell.
//
// This restriction is the general form: it depends on NO mob name and NO
// summonability. It fixes the ordering the other restrictions have - the
// all-or-nothing `threatNotInContact -> return` that leaves the body idle - by
// sorting the offer into routes that MOVE the body and routes that do not:
//
//   * a grounded move/escape exists  -> the non-physical kinds (WAIT, ESCALATE,
//     and the work actions that hold the body still) are removed, so the body
//     keeps moving. WHICH route stays Jev's choice.
//   * no grounded route exists       -> the offer is left whole, because
//     deleting the only remaining action would return an empty tick; the
//     controller's own survival control bounds it, and the typed
//     `THREAT_BREAK_CONTACT` evidence names the missing facts.
// ---------------------------------------------------------------------------

/** What the body can still do about an unsensed attacker (evidence + answer). */
export interface UnseenAttackerOffer {
  /** the attacker the damage attribution named and the sensor did not place */
  attacker: UnsensedAttacker | null
  /** the code-owned answer facts (see `unsensedThreatResponse`) */
  response: UnansweredThreatResponse
  /** the whole input offer, so a caller can see what was removed */
  offered: Candidate[]
  /** how many grounded destinations the escape scan produced for the origin */
  groundedDestinations: number
  /** ids of the grounded locomotion actions the offer still carries */
  moveIds: string[]
  /** ids of the locomotion actions whose destination came from the threat scan */
  escapeIds: string[]
}

/**
 * The candidate kinds that MOVE the body: only these can break contact. Each
 * one changes the body's block cell when it executes, so choosing it is a real
 * body displacement rather than a stance.
 *
 * Deliberately NOT the same set as `MECHANICAL_LOCOMOTION_KINDS` below, which
 * answers a different question ("may this leg be realized as a dimension
 * transfer?") and therefore includes `RETRIEVE`. A retrieve physically walks the
 * body, but toward the goal's own target - it is the work that was happening
 * while the measured body died, not an answer to the attacker. `DESCEND` and
 * `STEP` are here for the same reason `MOVE` is: their realization ends with the
 * body in a different cell, dug or stepped.
 *
 * `MINE`/`CRAFT`/`PLACE`/`SMELT`/`IGNITE` are not here: they change the WORLD
 * while the body keeps taking hits from the same spot, which is the measured
 * "digs while it dies" shape. `ENTER_PORTAL` is not either (and a keep-distance
 * realization may never cross a dimension, `crosses_dimension`); whether to
 * disengage is Jev's semantic choice, not a mechanical break-contact leg.
 */
const BREAK_CONTACT_KINDS: ReadonlySet<CandidateKind> = new Set<CandidateKind>([
  'MOVE',
  'RETREAT',
  'STEP',
  'DESCEND',
])

/**
 * The kinds that hold the body where it is while the attacker keeps firing: the
 * explicit no-ops, the work actions, and `RETRIEVE` (body motion toward the
 * goal's target). Removed while an unsensed attacker is landing hits and a
 * grounded break-contact route exists.
 *
 * The two sets partition `CandidateKind` exactly, so a kind added later is
 * covered by one of them by construction and can never silently escape this
 * restriction by being in neither.
 */
const STATIONARY_KINDS: ReadonlySet<CandidateKind> = new Set<CandidateKind>([
  'WAIT',
  'ESCALATE',
  'MINE',
  'CRAFT',
  'PLACE',
  'SMELT',
  // A container interaction is work done from one spot, like a smelt: it is not
  // an answer to an attacker the body cannot see (BREAK_CONTACT_KINDS owns
  // those), and it must be withheld with the other work actions.
  'CONTAINER',
  'IGNITE',
  'ENTER_PORTAL',
  'RETRIEVE',
  // Walking onto a dropped item is goal-directed locomotion, exactly like
  // RETRIEVE (which is why RETRIEVE is here): it moves the body toward the
  // goal's own target, so it is not a direction AWAY from an attacker the body
  // cannot see. It shares RETRIEVE's classification deliberately - the two are
  // the same mechanical family.
  'PICKUP',
])

function isStationaryKind(kind: CandidateKind): boolean {
  return STATIONARY_KINDS.has(kind)
}

/**
 * The locomotion candidates whose destination is the threat-escape scan: the
 * cells the sensor grounded FROM the attributed origin, plus the cells its sight
 * line cannot reach. These are the only destinations that answer an attacker the
 * body cannot see; a goal-directed MOVE is body motion but not an escape, and
 * `unsensedThreatResponse` must not count it as one.
 */
function groundedEscapeIds(state: Pick<WorldState, 'terrain'>, candidates: readonly Candidate[]): string[] {
  const cells = new Set<string>()
  for (const cell of [...(state.terrain.escapeCells ?? []), ...(state.terrain.threatCoverCells ?? [])]) {
    cells.add(`${cell.x},${cell.y},${cell.z}`)
  }
  return candidates
    .filter(
      (candidate) =>
        BREAK_CONTACT_KINDS.has(candidate.kind) &&
        candidate.target !== null &&
        cells.has(`${candidate.target.x},${candidate.target.y},${candidate.target.z}`),
    )
    .map((candidate) => candidate.id)
}

/**
 * SAFE: the exact damage/origin facts for the offer, independent of kind
 * filtering. Pure; exported so the controller can mirror the typed evidence.
 */
export function unseenAttackerOffer(
  state: Pick<WorldState, 'entities' | 'signals' | 'timestampMs' | 'terrain'>,
  candidates: readonly Candidate[],
): UnseenAttackerOffer {
  const attacker = unsensedAttackerFacts(state)
  // `groundedDestinations` counts ESCAPE destinations (the sensor's own cells for
  // this origin), not every locomotion action: a goal-directed walk is movement
  // but it is not a direction away from the attacker, and the marker must not
  // claim the body can answer when all it can do is keep working.
  const escapeIds = groundedEscapeIds(state, candidates)
  const moveIds = candidates
    .filter((candidate) => BREAK_CONTACT_KINDS.has(candidate.kind))
    .map((candidate) => candidate.id)
  const response = unsensedThreatResponse({
    attacker,
    groundedDestinations: attacker === null || attacker.position === null ? 0 : escapeIds.length,
    coverCells: (state.terrain.threatCoverCells ?? []).length,
    availableMoves: moveIds.length,
  })
  return { attacker, response, offered: [...candidates], groundedDestinations: escapeIds.length, moveIds, escapeIds }
}

/**
 * SAFE: while an unsensed attacker is hitting the body, no candidate may hold
 * the body still if ANY grounded way to move exists. Returns the offer
 * unchanged when the premise does not hold (no unsensed attacker, or nothing
 * grounded to move with), so ordinary survival and the sensed paths are
 * byte-identical.
 */
export function restrictCandidatesDuringUnseenAttacker(
  state: Pick<WorldState, 'entities' | 'signals' | 'timestampMs' | 'terrain'>,
  candidates: readonly Candidate[],
): Candidate[] {
  const offer = unseenAttackerOffer(state, candidates)
  if (offer.attacker === null) return [...candidates]
  if (offer.moveIds.length === 0) return [...candidates]
  const moved = candidates.filter((candidate) => !isStationaryKind(candidate.kind))
  return moved.length > 0 ? moved : [...candidates]
}

// ---------------------------------------------------------------------------
// SAFE: the body's own environmental hazard (fire / lava / burning / drowning).
//
// Measured live (`run-mucaq28q-1ftq1`, main 99f0020): the body burned in the
// Nether and every tick of it arrived as `source=environment`, because fire,
// lava and burning have no attacking entity for the entity-keyed `THREAT_*`
// machinery to name. Nothing in the sensor read the block the body stood in, so
// no candidate could leave it and the offer settled on `MOVE`/`ACCESS` targets
// that were all `no_path` until the body died in lava.
//
// The escape candidates are ordinary MOVE candidates - the same kind, the same
// executor, the same guard - grounded from real block truth by
// `envHazard.selectEnvHazardEscapes`. Jev still chooses WHICH one is taken;
// System2 still owns WHAT the body is doing.
// ---------------------------------------------------------------------------

/**
 * The candidate kinds that can END an environmental hazard: movement carries the
 * grounded escape, RETREAT is the wider keep-distance route, DESCEND is the
 * "dig down instead of walking out" alternative (its own guard already refuses
 * hazardous steps, so a DESCEND on offer is proven safe), and ESCALATE hands the
 * situation to the semantic layer. Everything else mechanically holds the body
 * inside the hazard.
 *
 * ATTACK / EAT / EQUIP are kept for the same reason `THREAT_SURVIVAL_KINDS`
 * keeps them: they are local self-care/response actions, not work, and dropping
 * them would let this envelope fight the threat or starvation owner for the same
 * decision.
 */
export const ENV_HAZARD_KEPT_KINDS: ReadonlySet<CandidateKind> = new Set<CandidateKind>([
  ...SURVIVAL_KINDS,
  'DESCEND',
  'ATTACK',
  'EAT',
  'EQUIP',
])

/** `meta.envHazardEscape` value on a generated escape: the hazard it leaves. */
export const ENV_HAZARD_ESCAPE_META = 'envHazardEscape'

/**
 * The exact hazard-ending subset of an offer: the predicate
 * `restrictCandidatesDuringEnvHazard` keeps, exported so the controller and its
 * fixtures can name the code-owned fact "no grounded exit" without re-listing
 * kinds and drifting from the restriction.
 *
 * A MOVE/RETREAT/STEP whose DESTINATION is itself a hazard cell is NOT an
 * escape: "do not walk into a hazard to escape another". The destination truth
 * comes from the sensor's classified ring (`state.envHazardCells`), so this is
 * real block truth and never a proximity guess; a destination the ring never
 * sampled is left untouched (unknown is not unsafe).
 */
export function envHazardEndingCandidates(
  candidates: readonly Candidate[],
  hazardCells: ReadonlySet<string>,
): Candidate[] {
  return candidates.filter((candidate) => {
    // "Do not walk into a hazard to escape another" is checked FIRST and applies
    // to every candidate, including a code-grounded escape: a destination that
    // real block truth says is a hazard cell is never a way out.
    if (
      candidate.target !== null &&
      hazardCells.has(`${candidate.target.x},${candidate.target.y},${candidate.target.z}`)
    ) {
      return false
    }
    if (candidate.meta[ENV_HAZARD_ESCAPE_META] !== undefined) return true
    return ENV_HAZARD_KEPT_KINDS.has(candidate.kind)
  })
}

/**
 * The precise hazard-ending ROUTES of an offer: the physical ways OUT, counted
 * for the reflex uniqueness rule (issue #436 section B). ESCALATE is a hand-off
 * and EAT/EQUIP/ATTACK are local actions, so none of them is a way out of a fire;
 * a route counts only when it is one of:
 *
 *   - a code-grounded environmental escape (`meta.envHazardEscape`, adjacent);
 *   - the existing grounded surface ascent (`meta.surfaceAscent`) while the body
 *     is drowning - the "rise toward air" route;
 *   - a RETREAT whose destination clears the hazard cell by the bounded hazard
 *     radius (the wider keep-distance route the candidate layer already grounded
 *     for this hazard);
 *   - a LOCAL DESCEND/STEP body change (the target within `LOCAL_ROUTE_RADIUS`)
 *     that is not itself a hazard cell - the "dig down instead of walking out"
 *     alternative, already proven safe by its own descent/step guard.
 *
 * An ordinary goal MOVE 20 m away is NOT counted: it was not grounded as an exit
 * from this hazard, and counting it would make the reflex unreachable while
 * telling Jev nothing. Every counted route must have a destination that is not a
 * proven hazard cell, so "the only way out" can never be a way INTO the hazard.
 */
export const ENV_HAZARD_LOCAL_ROUTE_RADIUS = 2

export function envHazardEscapeRoutes(
  state: Pick<WorldState, 'self' | 'envHazardCells'> & { signals?: WorldState['signals'] },
  candidates: readonly Candidate[],
): Candidate[] {
  const hazard = state.self.envHazard ?? null
  if (hazard?.active !== true) return []
  const hazardCells = envHazardProvenCells(state)
  const drowning = hazard.kinds.includes('drowning') && !hazard.escapeRequired
  return candidates.filter((candidate) => {
    const target = candidate.target
    if (target === null) return false
    if (hazardCells.has(`${target.x},${target.y},${target.z}`)) return false
    if (candidate.meta[ENV_HAZARD_ESCAPE_META] !== undefined) return true
    if (drowning && candidate.meta.surfaceAscent === true && candidate.kind === 'MOVE') return true
    if (candidate.kind === 'RETREAT') {
      // A keep-distance route only counts as a way out when it actually leaves
      // the hazard: a threat retreat 0.7 m from the fire is not an escape.
      return hazard.cell !== null && distance(target, hazard.cell) >= HAZARD_DANGER_RADIUS
    }
    if (candidate.kind === 'DESCEND' || candidate.kind === 'STEP') {
      return distance(target, state.self.position) <= ENV_HAZARD_LOCAL_ROUTE_RADIUS
    }
    return false
  })
}

/** The uniquely-determined environmental escape, as the controller reads it. */
export interface EnvHazardReflex {
  candidate: Candidate
  /** the hazard kind the reflex answers */
  kind: EnvHazardKind
  /** which grounded route family the reflex took */
  escapeKind: 'env' | 'retreat' | 'local' | 'surface'
}

/**
 * The hard-safety reflex (issue #436 §8): the ONE uniquely-determined
 * STABILISATION that leaves the body's own environmental hazard, or null when
 * the decision is Jev's.
 *
 * §8 allows a reflex to "stop / stabilize / move minimally to safety" and
 * forbids it from choosing a new destination, a long retreat strategy, a mining
 * expedition or an Option change. So the reflex ACTION is only ever one of:
 *
 *   - a grounded ADJACENT escape MOVE (`meta.envHazardEscape`, <= 1.5 m);
 *   - the existing grounded surface ascent while drowning, and only when the
 *     sensor verified air immediately above (`airAbove`) - "rise toward air".
 *
 * "Uniquely determined" is a count of ALL the grounded ROUTES out
 * ({@link envHazardEscapeRoutes}), never a direction preference: two safe
 * directions, "dig down vs walk out", or a keep-distance RETREAT are several
 * semantically meaningful alternatives. Their presence means code must NOT take
 * over - even when only one of them is left, a RETREAT/DESCEND/STEP is a
 * semantic choice and stays Jev's (the caller reports the policy boundary and
 * exposes the alternatives).
 *
 * While a hostile threat is engaged the reflex deliberately does NOT fire: that
 * decision belongs to the threat envelope, and a second safety owner would
 * substitute one hazard response for another.
 */
export function envHazardReflexAction(
  state: Pick<WorldState, 'self' | 'envHazardCells' | 'entities' | 'signals'>,
  candidates: readonly Candidate[],
): EnvHazardReflex | null {
  const hazard = state.self.envHazard ?? null
  if (hazard?.active !== true) return null
  // One safety owner at a time: with a hostile engaged, the threat envelope owns
  // the response.
  const threatActive = state.signals?.threat?.active === true
  const hostileNearby = state.entities.some(
    (entity) => entity.hostile && entity.distance <= THREAT_DANGER_RADIUS,
  )
  if (threatActive || hostileNearby) return null
  const routes = envHazardEscapeRoutes(state, candidates)
  if (routes.length !== 1) return null
  const route = routes[0]
  if (route === undefined || route.target === null) return null
  const drowningOnly = hazard.kinds.includes('drowning') && !hazard.escapeRequired
  if (drowningOnly) {
    // The surface ascent is the only route family this layer may take for
    // drowning, and only with verified air immediately above.
    if (route.meta.surfaceAscent !== true || route.kind !== 'MOVE' || !hazard.airAbove) return null
    return { candidate: route, kind: 'drowning', escapeKind: 'surface' }
  }
  // Everything below is the fire/lava/burning/adjacent-lava case: the reflex may
  // only take the minimal adjacent escape. A unique RETREAT/DESCEND/STEP is a
  // semantic choice, not a stabilisation (§8).
  const escapeMeta = route.meta[ENV_HAZARD_ESCAPE_META]
  if (escapeMeta === undefined || route.kind !== 'MOVE') return null
  const kind = hazard.kinds.find((entry) => entry !== 'drowning') ?? hazard.kinds[0] ?? 'fire'
  return { candidate: route, kind, escapeKind: 'env' }
}

/**
 * The cells real block truth PROVES are hazards: every ring cell whose own
 * column (or the block it stands on) holds a hazard block, plus the body's OWN
 * cell when the state says the body is standing in fire/lava or beside lava.
 *
 * The own cell is not part of the adjacent ring sample, so without it a
 * candidate that walks back into the fire the body is standing in would not be
 * recognised as a route INTO a hazard.
 */
export function envHazardProvenCells(
  state: Pick<WorldState, 'self' | 'envHazardCells'>,
): ReadonlySet<string> {
  const keys = new Set(
    (state.envHazardCells ?? [])
      .filter((cell) => cell.hazard !== null)
      .map((cell) => `${cell.position.x},${cell.position.y},${cell.position.z}`),
  )
  const hazard = state.self.envHazard
  if (hazard != null && (hazard.inFire || hazard.inLava || hazard.adjacentLava) && hazard.cell !== null) {
    keys.add(`${hazard.cell.x},${hazard.cell.y},${hazard.cell.z}`)
  }
  return keys
}

/**
 * SAFE: while the body is in an environmental hazard it must not be walked
 * further into it. Only the routes that can leave the hazard stay selectable -
 * the grounded escape MOVEs, RETREAT, STEP and ESCALATE - and any survival MOVE
 * whose destination is itself a hazard cell is dropped. If the world grounds no
 * exit at all the original set is preserved, so the missing affordance stays
 * observable (`ENV_HAZARD_NO_EXIT`) instead of silently erasing the offer;
 * drowning is excluded because the existing submersion restriction already owns
 * it (`restrictCandidatesDuringSubmersion`).
 */
export function restrictCandidatesDuringEnvHazard(
  state: Pick<WorldState, 'self' | 'envHazardCells'>,
  candidates: readonly Candidate[],
): Candidate[] {
  const hazard = state.self.envHazard ?? null
  // Only CONTACT with fire/lava withholds the work offer: there, any grounded
  // safe step ends the damage and staying put is definitely wrong. A body that
  // is merely burning has one step-deliverable remedy (water), which is offered
  // as an ordinary candidate and reflexed only when it is the single grounded
  // route - it must not be panicked into walking around while the fire ticks out
  // (§8: "move minimally to safety", never a new destination).
  if (hazard?.active !== true || !(hazard.inFire || hazard.inLava)) return [...candidates]
  const rescue = envHazardEndingCandidates(candidates, envHazardProvenCells(state))
  return rescue.length > 0 ? rescue : [...candidates]
}

/**
 * The grounded exits from the hazard, as plain destinations (the controller's
 * telemetry reads the SAME selection the candidate layer offers).
 */
export function envHazardEscapeSpots(
  state: Pick<WorldState, 'self' | 'blocks' | 'envHazardCells'>,
  blacklistedMoveTargets?: ReadonlySet<string>,
): EnvHazardEscape[] {
  const hazard = state.self.envHazard ?? null
  if (hazard?.active !== true) return []
  const cells = (state.envHazardCells ?? []).filter(
    (cell) => !isBlacklistedMoveTarget(state, blacklistedMoveTargets, cell.position),
  )
  return selectEnvHazardEscapes({
    self: state.self.position,
    hazard,
    cells,
    hazardBlocks: state.blocks.filter((block) => block.kind === 'hazard'),
    max: MAX_ENV_HAZARD_ESCAPES,
  })
}

/**
 * The grounded escape candidates themselves: ordinary MOVEs whose destination is
 * a real, standable, hazard-free adjacent cell. Water destinations are offered
 * first while the body is burning, because the water is what puts the fire out.
 * An empty list means the world grounds no exit - the caller reports the typed
 * gap, never a route through the hazard.
 */
export function envHazardEscapeCandidates(
  state: WorldState,
  blacklistedMoveTargets?: ReadonlySet<string>,
  reach = 4.5,
): Candidate[] {
  const hazard = state.self.envHazard ?? null
  if (hazard?.active !== true || hazard.escapeRequired !== true) return []
  const escapes = envHazardEscapeSpots(state, blacklistedMoveTargets)
  const kind = hazard.kinds.find((entry) => entry !== 'drowning') ?? hazard.kinds[0] ?? 'fire'
  return escapes.map((escape) => ({
    id: `MOVE:env:${kind}:${blockId('p', escape.spot)}`,
    kind: 'MOVE' as CandidateKind,
    label: `${moveLabel(
      escape.spot,
      escape.water
        ? 'step into the water to put the fire out'
        : `step out of the ${kind === 'lava' || kind === 'adjacent_lava' ? 'lava' : 'fire'}`,
      state.self.position,
    )} (hazard at ${hazard.cell === null ? 'unknown' : `${hazard.cell.x},${hazard.cell.y},${hazard.cell.z}`})`,
    targetName: null,
    target: escape.spot,
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: distance(escape.spot, state.self.position) <= reach,
    hasStandableAdjacent: true,
    meta: {
      tick: state.tick,
      x: escape.spot.x,
      y: escape.spot.y,
      z: escape.spot.z,
      [ENV_HAZARD_ESCAPE_META]: kind,
      envHazardCell: hazard.cell === null ? 'unknown' : `${hazard.cell.x},${hazard.cell.y},${hazard.cell.z}`,
      ...(escape.water ? { envHazardWater: true } : {}),
    },
  }))
}

/**
 * SAFE/CAN fact: the placement spots a station may be placed from.
 *
 * A spot in `submergedPlacementSpots` has only fluid-column body access, i.e.
 * the body would place while standing in water (`isStandable` accepts a water
 * cell, so this cannot be inferred from standability alone). When ANY dry-access
 * spot exists, the submerged-access spots are NOT offered: a station must not be
 * built from a submerged body position while a dry alternative exists. When no
 * dry alternative exists the historical set is returned unchanged, so a
 * legitimate underwater build is not silently erased and the caller still names
 * the reason through the normal starvation path.
 */
export function dryAwarePlacementSpots(
  state: Pick<WorldState, 'placementSpots'> & { submergedPlacementSpots?: Vec3Json[] },
): Vec3Json[] {
  const submerged = state.submergedPlacementSpots ?? []
  if (submerged.length === 0) return state.placementSpots
  const wet = new Set(submerged.map((spot) => placementSpotKey(spot)))
  const dry = state.placementSpots.filter((spot) => !wet.has(placementSpotKey(spot)))
  return dry.length > 0 ? dry : state.placementSpots
}

/**
 * Typed role for candidates that acquire the furnace station required to
 * initiate the active smelt Option.  The role is deliberately separate from
 * `prereqPath`: the path identifies the semantic route selected by the
 * prerequisite solver, while the role explains why a mechanically-derived
 * acquisition candidate is still inside that route's envelope.
 */
export const FURNACE_PREREQUISITE_ROLE = 'furnace_station' as const

export interface CandidateOptions {
  reach: number
  maxMineCandidates: number
  maxAttackCandidates: number
  /** below this food level the bot is willing to eat */
  eatBelowFood: number
  /**
   * furthest distance (m) at which a sensed passive food animal is offered as a
   * hunt route. The sensor only reports entities inside `SensorOptions.entityRadius`
   * (default 24m, see state.ts) and the ATTACK executor already paths to the
   * entity with `GoalFollow`, so this is the CAN boundary of the hunt affordance.
   * It must NOT be the 8m melee `COMBAT_CANDIDATE_RANGE`: a hungry resident
   * standing 9m from a cow was offered no way to obtain food at all.
   */
  foodHuntRange?: number
  /**
   * Grounded animal-habitat target Y supplied by the controller from a LOCAL
   * surface structure (a station the resident can sense from here). The
   * hungry-hunt ascent aims here instead of the bare sea-level floor, so the
   * route lands on real surface rather than inside a dirt column. Absent means
   * "no sensed local surface", which falls back to `sensedSurfaceY` and then to
   * `ANIMAL_HABITAT_SEA_LEVEL`; a REMEMBERED station is not accepted as a hint
   * because the route climbs the body's own column (see `sensedSurfaceY`).
   */
  foodHabitatY?: number | null
  /** nearest distance (m) at which an out-of-reach block earns a MOVE candidate */
  moveMinDistance?: number
  /** furthest distance (m) at which a walk-up MOVE is offered (chained moves) */
  moveMaxDistance?: number
  /** furthest distance (m) at which a buried block becomes a tunnel target */
  tunnelMaxDistance?: number
  /** upper bound on MOVE candidates, so navigation cannot crowd out the policy list */
  maxMoveCandidates?: number
  /** recipe lookup used to surface grounded CRAFT/PLACE steps (null disables) */
  recipes?: RecipeIndex | null
  /**
   * M2 blocker: `knownStationKey`s blacklisted by the controller's move-failure
   * memory. Passed explicitly (never read from a global) so the pure
   * prerequisite planner stops choosing an unreachable remembered station.
   */
  unreachableStations?: ReadonlySet<string>
  /**
   * Coordinate keys currently blacklisted by durable movement failure memory.
   * Candidate selection consumes this fact before it chooses an exploration or
   * retrieval target; filtering only after generation would leave WAIT as the
   * apparent fallback when the sole target is restored from a prior generation.
   */
  blacklistedMoveTargets?: ReadonlySet<string>
  /**
   * Surface-search waypoints already reached in this world epoch. These are
   * search-frontier facts, not retry counts: arriving at a waypoint without
   * seeing/acquiring the requested resource must move the frontier onward, or
   * the same RETRIEVE:surface candidate is regenerated forever.
   */
  searchedSurfaceTargets?: ReadonlySet<string>
  /** failures at one MOVE/RETRIEVE target before the generator stops offering it (default 4) */
  moveFailureLimit?: number
  /**
   * The widest verified bridge span one BRIDGE/scaffold offer may declare, in
   * blocks (`bridgeRoute.BRIDGE_MAX_SPAN` when absent). A bound, not a rank: a gap
   * whose verified continuation is wider than this is refused `budget` rather than
   * bridged on faith.
   */
  bridgeMaxSpan?: number
  /** failures at one DESCEND step before the generator stops offering it (default 3) */
  descendFailureLimit?: number
  /** failures at one placement spot before a fallback spot is used (default 2) */
  placeSpotRetryLimit?: number
  /**
   * Items whose bounded PLACE attempts are exhausted (`PLACE_RETRIES_EXHAUSTED`).
   * Passed by the controller from its `PlaceRetryLedger` so the generator cannot
   * re-offer a retired placement family. This is the enforcement half of the
   * bounded-attempt contract: without it the counter is advisory and the same
   * candidate is re-selected (measured 2026-09-21: count=18 against limit=5).
   */
  retiredPlaceItems?: ReadonlySet<string>
  /** affordance gate facts: pathfinder probe + state-fingerprint suppression memory */
  reachability?: ReachabilityGateOptions | null
  /**
   * #11 v2: ordering policy for the furnace prerequisite ladder (`cost` default,
   * `rank` for A/B). Shared by the generator and the controller so both agree on
   * which path the candidate set represents.
   */
  prereqRankPolicy?: PrereqRankPolicy
  /**
   * The validated Nether portal frame the current goal refers to, when one has
   * been sensed/validated. Present + tool held + a `nether_portal` place goal is
   * the ONLY way an IGNITE candidate is offered (issue lane: live ignition).
   */
  portalFrame?: PortalFrameValidation | null
  /**
   * The grounded dimension-transfer plan for an `enter:nether_portal` goal,
   * computed by the controller from live world truth (lit interior cells + a
   * safe, supported, in-reach stand) and evaluated by the pure
   * `planPortalEntry`. Null when no entry goal is active. The plan carries its
   * own typed refusal so a lit-but-unapproachable portal is never silent.
   */
  portalEntry?: PortalEntryPlan | null
}

/** Stable key for a surface-search waypoint in one dimension/world view. */
export function surfaceSearchKey(dimension: string, position: Vec3Json): string {
  return `${dimension}:${blockId('p', position)}`
}

export interface ReachabilityGateOptions {
  /** pathfinder fact for a destination; absent = unknown (no probe) */
  pathProbe?: ((position: Vec3Json) => PathProbeResult) | null
  /**
   * Ordinary hostile ATTACK uses GoalFollow/near-melee semantics, not GoalBlock.
   * The controller supplies the matching near-target path fact separately so an
   * entity behind sealed terrain is not advertised as an executable fight.
   * Absent = unknown and preserves pure/offline callers.
   */
  attackPathProbe?: ((position: Vec3Json) => PathProbeResult) | null
  /**
   * The live STANCE fact for an ATTACK: is there a cell the body can stand on,
   * legally, from which the entity is inside the melee envelope AND visible?
   * `combatClosure.selectAttackStand` is the pure search; the controller wires
   * the world questions to live truth (the sensor's own standability rule, the
   * `envHazard` classes, and the same `world.raycast` the threat-cover logic
   * casts). This is the fact a path probe cannot answer: a path to a cell beside
   * the target is not a position from which a swing lands (the operator's
   * embedded magma cube; the measured 6.11 m enderman with zero swings).
   *
   * Absent, or `null` for this entity (the host could not read its geometry),
   * means NO VERDICT and preserves the previous gate exactly - an unavailable
   * probe never deletes the only productive action.
   */
  attackStandProbe?:
    | ((query: { entityId: number; position: Vec3Json }) => AttackStandFact | null)
    | null
  /**
   * SAFE: does the body's own route to this destination stand it in a
   * dimension-transfer cell (a lit portal block)? The destination-side half of
   * the same fact lives in `WorldState.terrain.portalWalkInCells`; this half
   * covers a route that only CROSSES the portal on its way somewhere else.
   * `'unknown'` (no route planner) never invents a refusal, exactly like every
   * other probe.
   */
  dimensionTransferProbe?: ((position: Vec3Json) => DimensionTransferRoute) | null
  /** proven-unreachable (candidateId -> fingerprint) suppression memory */
  memory?: StateFingerprintMemory | null
  /**
   * #station-reachability: the live interaction-stand + path verdict for a
   * sensed station. Absent = no probe (pure callers keep the existing behavior).
   * Supplied by the controller so a sensed furnace/crafting_table is only
   * offered when the executor can actually stand at and walk to its face.
   */
  stationApproach?: StationApproachProbe | null
  /**
   * The same #244 interaction-stand geometry generalised to a dig target with no
   * walk-up access: the stand from which the block becomes diggable plus the
   * `canDig=false` path verdict. Absent = no probe (existing behavior).
   */
  digApproach?: DigApproachProbe | null
}

/**
 * Why a withheld capability had NO grounded acquisition route, as a typed fact.
 *
 *   `no_producer`  - the sensor proved no world source for the missing thing (no
 *                    producer block/mob in the observation envelope);
 *   `no_material`  - a recipe route exists (the thing is craftable in principle)
 *                    but its ingredient is neither held nor producible;
 *   `no_station`   - a recipe route exists and EVERY ingredient is held, but the
 *                    craft needs a placed station the body cannot obtain or
 *                    place; the named item is the STATION, not the product. The
 *                    measured shape (`run-mudlqw62-19miy`, live): a body holding
 *                    planks + sticks + a carried crafting_table in a flooded
 *                    pocket with no placement geometry was told
 *                    `no_material item=wooden_pickaxe count=1` - naming the tool
 *                    as its own missing material while it held everything the
 *                    recipe needs;
 *   `cell_unread`  - the missing fact is a CELL the sensor could not read at all
 *                    (an unloaded / provenance-refused column). No harvest
 *                    requirement and no clearance route can exist for a cell
 *                    whose block was never observed, so the refusal names the
 *                    CELL instead of inventing an item. The measured live freeze:
 *                    `CANDIDATE_ACQUISITION_REFUSED ... missing=headroom@-8,52,-6
 *                    reason=no_producer item=null count=null` while
 *                    `DIMENSION_READ_REFUSED cell=-8,52,-6 provenance=unknown
 *                    reason=unknown_column source=world-state` proves the read
 *                    itself was refused.
 */
export type AcquisitionRefusalReason = 'no_producer' | 'no_material' | 'no_station' | 'cell_unread'

/**
 * The acquisition evidence for ONE capability a candidate was withheld for: the
 * grounded routes enumerated for it this tick, or - when there are none - the
 * typed reason. `missing` is the same `capabilityKey` the withhold line carries,
 * so the offer and the evidence can never disagree.
 *
 * This is EVIDENCE, not authority: attaching it changes no offer. The withheld
 * candidate stays withheld; what the acquisition pass adds is a DIFFERENT
 * grounded candidate for the missing fact, and this record is how a reader can
 * tell the two apart (`CANDIDATE_ACQUISITION`) or see that nothing obtainable
 * exists (`CANDIDATE_ACQUISITION_REFUSED`, naming the item and count).
 */
export interface CandidateAcquisition {
  /** the withheld capability this fact is about (`capabilityKey`) */
  missing: string
  /** candidate ids of the grounded routes enumerated for it (empty when none) */
  routes: string[]
  /** typed reason NO route exists; null whenever `routes` is non-empty */
  reason: AcquisitionRefusalReason | null
  /** the concrete item that could not be obtained (item facts only) */
  item: string | null
  /** how many of `item` the route would need (item facts only) */
  count: number | null
  /** how many of `item` the body actually holds (item facts only) */
  held: number | null
  /**
   * The CELL the missing fact belongs to, for a fact that is a cell rather than
   * an item (`cell_unread`). Null for every item/material fact, so the marker
   * stays byte-identical wherever it named an item before.
   */
  cell?: Vec3Json | null
  /** the held tool state per family the missing fact named, e.g. `pickaxe:-1` */
  tools: string
}

export interface CandidateReachability {
  candidate: Candidate
  result: ReachabilityResult
  fingerprint: string
  /**
   * The TARGET's own grounding facts (`reachabilityTargetSignature`): the same
   * digest without the body-relative vertical gap.
   *
   * The full fingerprint above is consumed only for candidates the gate
   * WITHHELD (the unreachability proof memory). For a candidate that passed,
   * this is the fact that says "no fact about this target's grounding changed",
   * which the cross-action repeat bound needs: the live `ASCEND:habitat:p3_68_22`
   * runaway alternated the full fingerprint's `gap` term 122x/115x as the body
   * rose one block and fell back, so a counter keyed on it could never advance.
   */
  targetSignature: string
  withheld: boolean
  suppressed: boolean
  /**
   * The acquisition evidence for this withheld candidate's own missing facts.
   * Present only when the reachability gate ran (the acquisition pass owns it),
   * so pure callers and existing fixtures are unchanged.
   */
  acquisition?: CandidateAcquisition[]
}

/** `CANDIDATE_ACQUISITION`: the grounded route offered for a withheld fact. */
export function formatCandidateAcquisition(candidateId: string, entry: CandidateAcquisition): string {
  return `CANDIDATE_ACQUISITION candidate=${candidateId} missing=${entry.missing} route=${entry.routes.join('|')} tools=${entry.tools}`
}

/**
 * `CANDIDATE_ACQUISITION_REFUSED`: no grounded route exists for a withheld fact.
 * The item+count are named whenever the missing thing is a material, so the line
 * is actionable (`item=oak_log count=3`) instead of a token that can only be
 * retried. A fact that is a CELL rather than an item (`cell_unread`) names the
 * cell (`cell=-8,52,-6`) and adds no item fields - the two shapes never mix, so a
 * reader can tell "get this material" from "this cell was never read".
 */
export function formatCandidateAcquisitionRefused(candidateId: string, entry: CandidateAcquisition): string {
  const named =
    entry.item === null
      ? ''
      : ` item=${entry.item} count=${entry.count ?? 1} held=${entry.held ?? 0}`
  const cell =
    entry.cell === undefined || entry.cell === null
      ? ''
      : ` cell=${entry.cell.x},${entry.cell.y},${entry.cell.z}`
  return `CANDIDATE_ACQUISITION_REFUSED candidate=${candidateId} missing=${entry.missing} reason=${entry.reason ?? 'no_producer'}${named}${cell} tools=${entry.tools}`
}

export interface GroundedCandidatesResult {
  candidates: Candidate[]
  /** every affordance evaluation this cycle (facts for observability) */
  reachability: CandidateReachability[]
  /** the subset whose target is not mechanically reachable */
  withheld: CandidateReachability[]
  /**
   * Typed placement-geometry refusal: a held station could not be placed from
   * the terrain the sensor already knows. Non-null means the refusal was
   * surfaced (never silent), even when no alternative candidate exists.
   */
  placeRefusal: PlaceRefusal | null
  /**
   * Typed ascent refusal (`SURFACE_ASCENT_REFUSED reason=no_placeable|
   * unsafe_column`) when the active `surface` goal's `targetY` is above the body
   * beyond `VERTICAL_GAP` and no grounded vertical plan can be built. Non-null
   * means "no route is enumerated AND the reason is said", the exact silence the
   * 48-minute pacing loop ran in. Null when no surface ascent was requested.
   */
  surfaceAscentRefusal: SurfaceAscentRefusal | null
  /**
   * Typed refusal (`FOOD_HABITAT_REFUSED`) when a hungry body with no sensed
   * food animal has no grounded vertical route up to animal habitat. Non-null
   * means the hunt cannot progress where the body is and the reason is said,
   * instead of an unbounded zero-progress underground hunt. Null when the body
   * is not in that state.
   */
  foodHabitatRefusal: SurfaceAscentRefusal | null
  /**
   * Typed ignition refusal (`PORTAL_LIGHT_REFUSED` / `PRECONDITION_MISSING`)
   * when a portal goal's frame could not be lit. Null when no ignition was
   * requested this cycle (never when one was requested and withheld).
   */
  ignitionRefusal: IgnitionRefusal | null
  /**
   * Typed dimension-transfer refusal (`PORTAL_ENTER_REFUSED` /
   * `PRECONDITION_MISSING`) when an entry goal's lit portal could not be
   * entered. Null when no entry was requested this cycle (never when one was
   * requested and withheld).
   */
  entryRefusal: PortalEntryRefusal | null
  /**
   * Carried armor pieces that produce no EQUIP offer because they are not
   * strictly better than what is worn. Non-empty means "nothing better is
   * held" was surfaced explicitly instead of silently churning.
   */
  armorRefusals: ArmorRefusal[]
  /**
   * The grounded armour CRAFT steps this tick actually offers, derived from the
   * OFFERED candidate set (never the raw one), each naming the piece, the
   * material it spends and its count (`ARMOR_CRAFT slot=torso item=iron_chestplate
   * material=iron_ingot need=8 have=8 candidate=CRAFT:iron_chestplate worn=none`).
   * Empty when nothing improvable is affordable.
   */
  armorCraftOffers: ArmorCraftOffer[]
  /**
   * Typed `ARMOR_CRAFT_REFUSED` shortfalls: the material and count that stop an
   * armour craft, carried through the gate unchanged (world truth, not the
   * offered set). This is what makes `COMBAT_KIT_GAP ... missing=[armor]
   * prerequisite=none` explainable instead of silent.
   */
  armorCraftRefusals: ArmorCraftRefusal[]
  /**
   * Cells withheld from the active collect goal because they are members of a
   * live structure (`RESOURCE_SOURCE_EXCLUDED ... reason=live_structure`). Empty
   * when no candidate cell is protected.
   */
  sourceExclusions: ResourceSourceExclusion[]
  /**
   * Typed `EXPLORE_ROUTE_BLOCKED ... reason=...` when the active collect goal's
   * item has a declared producer but the tick offers no grounded route at all -
   * not even a generic exploration frontier. Null when the goal has a route, has
   * no declared producer, or is not a collect goal. Non-null means "the dead end
   * is said", never a silent WAIT.
   */
  exploreRouteBlocked: ExploreRouteBlocked | null
  /**
   * Typed `COMBAT_KIT_GAP` fact when the active collect goal needs a kill the
   * body's kit cannot win: the missing capability is named and the grounded
   * prerequisite route (if any) is carried. Null when no producer is sensed or
   * the kit is sufficient.
   */
  combatKitGap: CombatKitGapEvidence | null
  /**
   * Typed `COLUMN_DESCENT_REFUSED reason=no_safe_step|no_tool|exhausted` when the
   * body is stranded on its own support column and no bounded, damage-free
   * descent off it can be offered. Null whenever the body is not stranded or a
   * safe descent candidate was offered. Non-null means the WAIT has a stated
   * cause instead of being silent.
   */
  columnDescentRefusal: ColumnDescentRefusal | null
  /**
   * Typed `HUNT_CONTACT_UNREACHABLE` refusals: a sensed fight target that is
   * ABOVE the body's walk envelope (`gapY > VERTICAL_GAP`) for which the ONE
   * vertical planner grounds no route to its level. Each entry names the target,
   * the contact geometry and the planner's own refusal (`no_placeable` /
   * `unsafe_column`). Empty when every fight target is reachable by a walk or by
   * a grounded ascent.
   *
   * Non-empty means the ATTACK for that target was withheld BY CAN and no lease
   * is started for it - the difference between a target the body cannot reach at
   * all and the measured 0-swing `out_of_range` lease that only LOOKED like an
   * attempt (21 blaze hunts, `swings=0 hits=0`).
   */
  contactRefusals: ContactRefusal[]
  /**
   * Typed `DIG_ROUTE_REFUSED reason=...` facts for the travel/enter/retrieve
   * targets this tick could not walk to AND could not dig toward: the target is
   * named with the bearing, the refused cell/block and the sensor's own cause
   * (`hazard`/`unbreakable`/`no_support`/`open_floor`/`protected`/`no_tool`/
   * `no_step`/`spent`). Empty while a dig route is on offer, and empty when no
   * travel target needed one. Non-empty means "the dead end is said" instead of
   * the offer silently collapsing to WAIT/ESCALATE.
   */
  digRefusals: DigRouteRefusal[]
  /**
   * Typed `PROSPECT_REFUSED reason=hazard|unbreakable|no_support|open_floor|
   * protected|no_tool|no_safe_step` when the active descend/travel-to-acquire row
   * passed a sensed producer of its focus and the exposure dig toward it was
   * grounded by geometry but refused by the world. Null while a probe is offered,
   * and null when no producer was in probe range. Non-null means the missing
   * en-route acquisition has a stated mechanical cause instead of silence.
   */
  prospectRefusal: ProspectRefusal | null
  /**
   * Typed `CONTAINER_REFUSED reason=unreachable|empty|...` facts for the
   * container cells this tick could not offer an interaction for: no interaction
   * stand / no path (unreachable), a cell with no container block truth left, or
   * a container that was opened and observed EMPTY. Empty while every candidate
   * container was offered. Non-empty means an unopened or empty container is a
   * NAMED fact, never a silent no-op and never mistaken for an empty inventory.
   */
  containerRefusals: ContainerRefusal[]
  /**
   * The typed "no available source for the active collect focus" fact, or null
   * when a grounded source route was offered (or the focus has no name-scanned
   * source at all). Mirrored as `RESOURCE_SOURCE_NONE ...`.
   *
   * SOURCE-side fact: which remembered/sensed sources exist, how many the loaded
   * world falsified, and whether the generator already offers a grounded
   * exploration body-change (`next=explore`) or the starvation/escalation path
   * must take over (`next=escalate`). It is orthogonal to `exploreRouteBlocked`
   * (MOVEMENT-side: the exploration arm itself was blocked); on a full dead end
   * both fire, and each names its own half of the reason.
   */
  sourceGap: ResourceSourceGap | null
  /**
   * Typed `FOOD_SOURCE_NONE ...` when a hungry body has NO grounded route to
   * food at all: nothing edible held, no sensed food animal, no sensed edible
   * block, no sensed recipe-ingredient block, no cookable recipe. Null whenever
   * any route (or the EAT mechanic) is on offer, and null for a fed body. This
   * is the bounded escalation the starvation path needs: it NAMES the missing
   * affordance instead of leaving a silent food-less WAIT.
   */
  foodGap: FoodSourceGap | null
  /**
   * Typed `MOB_DROP_SOURCE_NONE ...` when the active collect goal's item is a mob
   * drop (`ender_pearl` <- enderman, `blaze_rod` <- blaze) and NO producer route
   * is on offer: the missing affordance is named together with the producer mob
   * names, how many instances the sensor reported, and the grounded next step.
   * Null as soon as a hunt candidate for the focus is offered. Orthogonal to
   * `exploreRouteBlocked` (MOVEMENT-side) and to `sourceGap` (block sources):
   * this is the PRODUCER-side fact the M3 pearl half had no marker for at all.
   */
  mobDropGap: MobDropSourceGap | null
}

/**
 * Why a held station could not be placed from the terrain the sensor already
 * knows, naming the exact cell the mechanical solve evaluated:
 *
 *   - `no_support`   no standable terrain is known; the only air cell (the bot's
 *                    own head space) has no block under it to place onto;
 *   - `no_clearance` the only known placeable cell is the bot's own body cell,
 *                    so the placement is blocked by the bot itself;
 *   - `out_of_reach` a valid placement cell exists but is beyond interaction
 *                    reach; the bot must walk closer first.
 */
export type PlaceRefusalReason = 'no_support' | 'no_clearance' | 'out_of_reach'

export interface PlaceRefusal {
  item: string
  reason: PlaceRefusalReason
  cell: Vec3Json
}

/** The exact `PLACE_REFUSED` observability line for one typed refusal. */
export function formatPlaceRefusal(refusal: PlaceRefusal): string {
  return `PLACE_REFUSED reason=${refusal.reason} cell=${refusal.cell.x},${refusal.cell.y},${refusal.cell.z} item=${refusal.item}`
}

/**
 * A cell that WOULD have been offered as a source for the active collect goal
 * but is refused by a grounded world-truth gate. The marker is the explicit fact
 * that replaces a silent refusal: the cell stays unavailable and the plan must
 * source the item elsewhere (other sensed/remembered cells, or exploration).
 *
 * Generic by construction: the reason is a membership predicate, and the
 * diagnostic `structure` field is never matched on.
 *
 * Why a cell that matches the active want is NOT offered as a source:
 *
 *   live_structure         the cell is a member of a live structure (dismantling
 *                          the asset is worse than sourcing elsewhere)
 *   dimension_mismatch     the cell is remembered in ANOTHER dimension
 *   dimension_unattributed the cell records no dimension at all, so it cannot be
 *                          attributed to the live world (fail closed, #14)
 *
 * The two dimension reasons are the honest report side of
 * `resourceDimensionVerdict`: the row is never deleted for them.
 */
export type ResourceSourceExclusionReason = 'live_structure' | 'dimension_mismatch' | 'dimension_unattributed'

export interface ResourceSourceExclusion {
  /** the item the active collect goal wants */
  item: string
  cell: Vec3Json
  reason: ResourceSourceExclusionReason
  /** diagnostic structure kind only (never matched on); set iff reason is `live_structure` */
  structure?: string
  /**
   * The dimension the row ITSELF records, or `null` when it records none. Never
   * invented from the durable bucket: the durable key has been measured to hold
   * wrong-world cells (see `resourceDimensionVerdict`).
   */
  recordedDimension?: string | null
  /** the live dimension the cell was refused in */
  liveDimension?: string
}

export const RESOURCE_SOURCE_EXCLUDED = 'RESOURCE_SOURCE_EXCLUDED'

/**
 * The `live_structure` spelling is unchanged (byte-identical); a dimension
 * refusal additionally names the recorded dimension (or its absence) and the
 * live dimension, so one line carries the whole fact.
 */
export function formatResourceSourceExclusion(exclusion: ResourceSourceExclusion): string {
  const base = `${RESOURCE_SOURCE_EXCLUDED} item=${exclusion.item} cell=${exclusion.cell.x},${exclusion.cell.y},${exclusion.cell.z} reason=${exclusion.reason}`
  if (exclusion.reason === 'live_structure') return base
  return `${base} recorded_dimension=${exclusion.recordedDimension ?? 'none'} live_dimension=${exclusion.liveDimension ?? 'unknown'}`
}

/**
 * The typed "this collect goal has no available source" fact. It is the honest
 * replacement for a silent stale-retarget loop: when the world offers neither a
 * sensed source block nor a remembered coordinate that survived the live-world
 * probe, the mechanical layer says so and names what little it CAN still do.
 *
 * This is a capability gap (TRUE), not a choice (WHAT): `reason` is derived from
 * counts of ground facts and `next` only reports whether the generator could
 * already offer a grounded exploration body-change (`explore`) or whether the
 * existing starvation/escalation path must take over (`escalate`). Obsidian is
 * the measured case, but nothing here names obsidian - the same marker fires for
 * gravel/flint and any other name-scanned source.
 */
export type ResourceSourceGapReason =
  /** the source is declared in the scan table but neither sensed nor remembered */
  | 'no_source_sensed'
  /** every remembered matching cell was disproved by the loaded world */
  | 'remembered_falsified'
  /** the only matching cells are members of a live structure */
  | 'live_structure'
  /** every matching remembered cell records another / no dimension (#14) */
  | 'dimension_refused'
  /** matching cells exist, but every offered route was withheld (tool/reach/path) */
  | 'source_withheld'

export interface ResourceSourceGap {
  item: string
  reason: ResourceSourceGapReason
  /** sensed source blocks matching the focus */
  sensed: number
  /** remembered matching coordinates that survived the world probe */
  remembered: number
  /** remembered matching cells the loaded world disproved */
  falsified: number
  /** matching cells withheld as live-structure members */
  excluded: number
  /** matching remembered cells refused because they name another / no dimension */
  dimensionRefused: number
  /** the grounded next step the mechanical layer can offer right now */
  next: 'explore' | 'escalate'
}

export const RESOURCE_SOURCE_NONE = 'RESOURCE_SOURCE_NONE'

export function formatResourceSourceGap(gap: ResourceSourceGap): string {
  return `${RESOURCE_SOURCE_NONE} item=${gap.item} reason=${gap.reason} sensed=${gap.sensed} remembered=${gap.remembered} falsified=${gap.falsified} excluded=${gap.excluded} dimension_refused=${gap.dimensionRefused} next=${gap.next}`
}

/** Remembered matching cells the loaded world proved are no longer the resource. */
function falsifiedKnownCellKeys(state: WorldState): ReadonlySet<string> {
  const out = new Set<string>()
  for (const evidence of state.knownResourceEvidence ?? []) {
    if (evidence.status !== 'falsified') continue
    out.add(`${evidence.position.x},${evidence.position.y},${evidence.position.z}`)
  }
  return out
}

/** The live-structure membership index for this world state (empty when none). */
function liveStructureIndexOf(state: WorldState): ReadonlyMap<string, string> {
  return liveStructureMemberIndex(state.liveStructureMembers)
}

/**
 * The ONE protected-resource predicate every placing route offers with: a
 * protected station block by NAME, or any cell of a LIVE structure (which is what
 * a portal frame and its interior cells are). Shared so a descent scaffold, a
 * bridge and a wall entry can never disagree about what may be placed into.
 */
export function protectedResourceTest(state: WorldState): (cell: Vec3Json, name: string | null) => boolean {
  const liveStructures = liveStructureIndexOf(state)
  return (cell, name) => (name !== null && isProtectedStationBlock(name)) || isLiveStructureMember(liveStructures, cell)
}

/**
 * The typed `RESOURCE_SOURCE_EXCLUDED` facts for the active collect goal: every
 * sensed or remembered source cell the generator would otherwise offer that is a
 * member of a live structure. Enumeration only - the actual refusal is applied
 * at the two source selectors (`mineCandidates` for sensed cells,
 * `knownResourceFor` for remembered cells), so the marker can never disagree
 * with the offered set.
 */
export function resourceSourceExclusions(state: WorldState): ResourceSourceExclusion[] {
  const focusItem = state.goalQueue?.current?.targetItem ?? state.goal.targetItem ?? null
  if (focusItem === null) return []
  const out: ResourceSourceExclusion[] = []
  const seen = new Set<string>()
  const record = (position: Vec3Json, structure: string): void => {
    const key = liveStructureCellKey(position)
    if (seen.has(key)) return
    seen.add(key)
    out.push({
      item: focusItem,
      cell: { x: position.x, y: position.y, z: position.z },
      reason: 'live_structure',
      structure,
    })
  }
  const index = liveStructureIndexOf(state)
  if (index.size > 0) {
    // (1) Sensed cells the MINE/MOVE/DESCEND families would otherwise offer, using
    // the SAME source matching as `mineCandidates` (drop match plus the declared
    // scanned block name, so `flint -> gravel` is covered too).
    const want = retrievalWant(focusItem)
    const sourceNames = want !== null && want.kind === 'ore' ? want.blockNames : null
    for (const block of state.blocks) {
      if (block.kind !== 'log' && block.kind !== 'stone' && block.kind !== 'ore') continue
      if (!resourceMatches(block.yield, focusItem) && !(sourceNames?.includes(block.name) ?? false)) continue
      const structure = index.get(liveStructureCellKey(block.position))
      if (structure !== undefined) record(block.position, structure)
    }
    // (2) Remembered cells the RETRIEVE:known family would otherwise offer, using
    // the same want matching and dimension re-anchoring as `knownResourceFor`.
    if (want !== null) {
      for (const resource of state.signals.knownResources ?? []) {
        if (!resourceDimensionMatches(resource, state.self.dimension)) continue
        const matches = want.kind === 'log' ? resource.name.endsWith('_log') : want.blockNames.includes(resource.name)
        if (!matches) continue
        const structure = index.get(liveStructureCellKey(resource.position))
        if (structure !== undefined) record(resource.position, structure)
      }
    }
  }
  // (3) Remembered cells refused by the dimension gate. Independent of live
  // structures: an un-attributable cell is withheld whether or not any structure
  // stands nearby (see `resourceDimensionVerdict`).
  for (const refusal of resourceDimensionRefusals(state, focusItem)) {
    const key = liveStructureCellKey(refusal.cell)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(refusal)
  }
  return out
}

/**
 * The typed `RESOURCE_SOURCE_EXCLUDED ... reason=dimension_mismatch|dimension_unattributed`
 * facts for the active collect focus: every remembered cell that matches the want
 * `knownResourceFor` would offer and is refused because it cannot be attributed to
 * the live dimension.
 *
 * Enumeration only; the refusal itself is applied by `resourceDimensionMatches`
 * at the source selectors, so this marker cannot disagree with the offered set.
 * Each fact names the cell, the dimension the row records (or its absence) and the
 * live dimension - the three values needed to tell "another world" apart from
 * "nowhere recorded". Pure.
 */
export function resourceDimensionRefusals(
  state: WorldState,
  focusItem?: string | null,
): ResourceSourceExclusion[] {
  const item = focusItem ?? state.goalQueue?.current?.targetItem ?? state.goal.targetItem ?? null
  if (item === null) return []
  const want = retrievalWant(item)
  if (want === null) return []
  const live = state.self.dimension
  const out: ResourceSourceExclusion[] = []
  const seen = new Set<string>()
  for (const resource of state.signals.knownResources ?? []) {
    const verdict = resourceDimensionVerdict(resource, live)
    if (verdict === 'same') continue
    // The SAME want matching `knownResourceFor` uses: a logged cell matches by
    // suffix, every other declared source name by membership (or by being the
    // wanted item itself, which is how a remembered drop is routed).
    const matches =
      want.kind === 'log'
        ? resource.name.endsWith('_log')
        : want.blockNames.includes(resource.name) || resource.name === item
    if (!matches) continue
    const key = liveStructureCellKey(resource.position)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      item,
      cell: { x: resource.position.x, y: resource.position.y, z: resource.position.z },
      reason: verdict === 'unattributed' ? 'dimension_unattributed' : 'dimension_mismatch',
      recordedDimension: resource.dimension ?? null,
      liveDimension: live,
    })
  }
  return out
}

/**
 * True when a candidate is an actual source route for the active want: a sensed
 * MINE/MOVE onto the source block, or the remembered-coordinate RETRIEVE. This
 * is how the gap detector distinguishes "no source at all" from "a source route
 * exists"; it never ranks candidates.
 */
function sourceRouteForWant(candidate: Candidate, want: RetrievalWant): boolean {
  if (candidate.kind === 'RETRIEVE') return candidate.meta.resource === want.item
  if (candidate.kind === 'MINE' || candidate.kind === 'MOVE') {
    const yieldItem = candidate.meta.yieldItem
    if (typeof yieldItem === 'string' && resourceMatches(yieldItem, want.item)) return true
    return candidate.targetName !== null && want.blockNames.includes(candidate.targetName)
  }
  return false
}

/**
 * The typed no-source gap for the active collect focus, computed from ground
 * facts the generator already has (sensed source blocks, surviving remembered
 * coordinates, falsified evidence, live-structure exclusions) plus whether any
 * source route survived into the offered set. Returns null when a source route
 * exists or the focus has no name-scanned source. Pure; no candidate is changed.
 */
export function resourceSourceGapFor(
  state: WorldState,
  candidates: readonly Candidate[],
  exclusions: readonly ResourceSourceExclusion[],
): ResourceSourceGap | null {
  const focusItem = state.goalQueue?.current?.targetItem ?? state.goal.targetItem ?? null
  const want = retrievalWant(focusItem)
  if (want === null || want.kind !== 'ore') return null
  if (candidates.some((candidate) => sourceRouteForWant(candidate, want))) return null
  const liveStructures = liveStructureIndexOf(state)
  const sensedBlocks = state.blocks.filter(
    (block) =>
      (block.kind === 'log' || block.kind === 'stone' || block.kind === 'ore') &&
      (resourceMatches(block.yield, want.item) || want.blockNames.includes(block.name)),
  )
  const rememberedResources = (state.signals.knownResources ?? []).filter(
    (resource) =>
      resourceDimensionMatches(resource, state.self.dimension) && want.blockNames.includes(resource.name),
  )
  // A cell that is a live-structure member is not a source (see
  // `resourceSourceExclusions`); count it as protected so the gap reason can name
  // the real blocker instead of claiming "nothing was ever there".
  const sensedOpen = sensedBlocks.filter((block) => !isLiveStructureMember(liveStructures, block.position)).length
  const rememberedOpen = rememberedResources.filter(
    (resource) => !isLiveStructureMember(liveStructures, resource.position),
  ).length
  const excluded = exclusions.filter(
    (exclusion) => exclusion.item === want.item && exclusion.reason === 'live_structure',
  ).length
  // Kept separate from `excluded`: a dimension refusal is not a protected
  // structure, and reporting it as one would name the wrong blocker.
  const dimensionRefused = exclusions.filter(
    (exclusion) => exclusion.item === want.item && exclusion.reason !== 'live_structure',
  ).length
  const falsified = (state.knownResourceEvidence ?? []).filter((evidence) => evidence.status === 'falsified').length
  const reason: ResourceSourceGapReason =
    sensedOpen > 0 || rememberedOpen > 0
      ? 'source_withheld'
      : falsified > 0
        ? 'remembered_falsified'
        : excluded > 0
          ? 'live_structure'
          : dimensionRefused > 0
            ? 'dimension_refused'
            : 'no_source_sensed'
  const next: ResourceSourceGap['next'] = candidates.some((candidate) => candidate.meta.explore === true)
    ? 'explore'
    : 'escalate'
  return {
    item: want.item,
    reason,
    sensed: sensedBlocks.length,
    remembered: rememberedResources.length,
    falsified,
    excluded,
    dimensionRefused,
    next,
  }
}

/**
 * The typed "the active collect goal needs a MOB DROP and no producer instance is
 * on offer" fact - the mob-drop sibling of `ResourceSourceGap` (block sources)
 * and `FoodSourceGap` (edible routes).
 *
 * The measured M3 gap (`run-muc3qbug-18vg3`, source 35dfd29): the pearl rung had
 * no sensed enderman at all. The candidate generator DID offer the generic
 * exploration arm (a `MobDrop`-producer focus gets the same frontier MOVEs a
 * scanned block source gets), but nothing in the run-scoped log said WHY: the
 * pearl need produced no candidate id naming a producer, no `RETRIEVE:known:*`
 * (there is no remembered pearl source of any kind) and no typed gap, because
 * `resourceSourceGapFor` only covers `kind === 'ore'` wants and
 * `exploreRouteBlocked` is silent whenever any exploration MOVE is on offer.
 *
 * This marker closes that observability hole. It is enumerated from the OFFERED
 * set, exactly like `foodSourceGap`, so it can never claim a missing producer
 * while a producer route is actually on offer. CAN/TRUE only: it names the mob
 * names that drop the item (deterministic Minecraft producer truth), how many
 * producer instances the SENSOR reported, and which grounded route kinds the
 * tick offers. Choosing among them stays Jev's.
 */
export type MobDropSourceGapReason =
  /** no producer instance is in the sensed entity list at all */
  | 'no_producer_sensed'
  /** a producer is sensed, but no offered route reaches it (reachability gate) */
  | 'producer_withheld'

export const MOB_DROP_SOURCE_NONE = 'MOB_DROP_SOURCE_NONE'

export const MOB_SPAWN_CONTEXT = 'MOB_SPAWN_CONTEXT'

/**
 * WHY a producer search can be grounded at all, from the vanilla spawn-context
 * rule (`MOB_SPAWN_CONTEXTS`) plus the sensor's own observation of the body's
 * column:
 *
 *   - `met`             the body's context satisfies the rule (right dimension,
 *                       and where the rule gates on it a measured light level
 *                       that permits a spawn): a producer SEARCH here is grounded
 *                       on the live world, not on a guess;
 *   - `context_unknown` the dimension is right but the context could not be read
 *                       (`probeReason` names the missing fact): the search is
 *                       still the grounded next step, and this verdict is the
 *                       honest statement that it is a search for the context
 *                       rather than a proven spawn surface;
 *   - `light_unmet`     right dimension, measured light too high: a search must
 *                       find a darker surface (still a search, not a dead end);
 *   - `dimension_unmet` this dimension cannot host the mob at all: a search here
 *                       cannot ever succeed, so it is NOT grounded.
 */
export type MobDropSpawnContextReason = 'met' | 'context_unknown' | 'light_unmet' | 'dimension_unmet'

/**
 * The SPAWN CONTEXT half of the mob-drop producer fact: "item X's producers are
 * mobs with spawn context C".
 *
 * Before this existed the producer table answered only "which mob drops the
 * item", the gap said `sensed=0`, and no layer could express whether the body
 * was standing anywhere the mob could exist. The measured pearl half of M3 is
 * exactly that shape: the arrival chunk was a soul sand valley
 * (`soul_soil 630 | soul_sand 287`) - a vanilla enderman environment - and the
 * body still never met one.
 */
export interface MobDropSpawnContext {
  /** the producer mobs covered by this observation, sorted */
  mobs: string[]
  /** the dimension ids the union of those mobs' rules permits */
  dimensions: string[]
  /** the body's dimension this tick */
  dimension: string
  /** the reasoned verdict for the body's own column */
  reason: MobDropSpawnContextReason
  /** the sampled cell, or null when the observation did not read one */
  cell: Vec3Json | null
  /** the mob name that produced `reason`, when a rule exists for it */
  mob: string | null
  /** the block the spawn surface was read at (the block under the body), or null */
  surfaceBlock: string | null
  /** the block-light gate the rule imposes at this dimension, null when none */
  spawnLightMax: number | null
  /** the measured block light, or null when the world data could not answer */
  light: number | null
  /** the biome name at the sampled cell, when the world exposes one */
  biome: string | null
  /** only set on `context_unknown`: which fact was missing */
  probeReason: MobSpawnContextObservation['probeReason']
  /**
   * TRUE when the mechanical layer may ground a SEARCH for the producer from
   * this context. False ONLY for `dimension_unmet` - the one verdict that says a
   * search here can never succeed. It is deliberately NOT gated on `met`: a
   * search that is the way to FIND a valid context is still a grounded route,
   * and withholding it would leave the body with no step at all.
   */
  searchGrounded: boolean
}

export interface MobDropSourceGap {
  /** the item the active collect goal wants */
  item: string
  /** the deterministic mob producers of that item, sorted */
  producers: string[]
  /** producer instances in the sensor's entity list, at any distance */
  sensed: number
  /**
   * grounded route kinds on offer this tick. A hunt candidate for the focus
   * would have closed the gap, so the only value this can carry is `explore`
   * (the generic search arm), or nothing at all on a dead end.
   */
  offered: string[]
  reason: MobDropSourceGapReason
  /** the grounded next step the mechanical layer can offer right now */
  next: 'explore' | 'escalate'
  /**
   * WHERE the producers can exist, from the sensor's own spawn-context
   * observation. Null when the item's producers have no declared spawn rule at
   * all - an honest "the context is not expressible", never a silent no-op.
   */
  spawnContext: MobDropSpawnContext | null
}

/**
 * The spawn-context half of a mob-drop gap, or null when the item's producers
 * have no declared rule (`MOB_SPAWN_CONTEXTS` absent for all of them: a
 * production fact the repo does not know, reported as null, never invented).
 *
 * Pure. The verdict is read from the SENSOR's observation
 * (`state.spawnContexts`), never from the offered set, so it can never claim a
 * spawn surface the sensor did not look at.
 */
export function mobDropSpawnContextFor(
  state: Pick<WorldState, 'self' | 'spawnContexts'>,
  producers: readonly string[],
): MobDropSpawnContext | null {
  const observed = state.spawnContexts ?? []
  const rules = producers.filter((mob) => mobSpawnContextFor(mob) !== null)
  if (rules.length === 0) return null
  const row = observed.find((entry) => rules.includes(entry.mob)) ?? null
  const dimensions = [...new Set(rules.flatMap((mob) => mobSpawnContextFor(mob)?.dimensions ?? []))].sort()
  // The verdict is the SENSOR's, verbatim. The gap layer must never recompute it:
  // a second implementation here could disagree with the observation the run log
  // actually carries (and did, in this lane's own fixture: it reported `met` for a
  // body the sensor had measured as `dimension_unmet`).
  const reason: MobDropSpawnContextReason =
    row !== null
      ? row.verdict
      : dimensions.includes(state.self.dimension)
        ? 'context_unknown'
        : 'dimension_unmet'
  return {
    mobs: rules.slice().sort(),
    dimensions,
    dimension: state.self.dimension,
    reason,
    cell: row?.cell ?? null,
    mob: row?.mob ?? null,
    surfaceBlock: row?.surfaceBlock ?? null,
    spawnLightMax: row?.spawnLightMax ?? mobSpawnContextFor(rules[0] as string)?.spawnLightMax ?? null,
    light: row?.light ?? null,
    biome: row?.biome ?? null,
    probeReason: row?.probeReason ?? (row === null ? 'no_sensed_surface' : null),
    searchGrounded: reason !== 'dimension_unmet',
  }
}

/**
 * `MOB_SPAWN_CONTEXT` - the typed "where this producer can exist, and whether the
 * live context was actually read" fact.
 *
 * Its own line (the `MOB_DROP_SOURCE_NONE` wording is stable and pinned) so a
 * reader of the run log can tell apart the three shapes that all looked like
 * `sensed=0` before it existed: the body IS in a valid spawn context and the
 * search is grounded on live world truth; the context could not be measured, so
 * the search is a search FOR the context; or this dimension can never host the
 * producer, so a search here is not grounded at all.
 */
export function formatMobSpawnContext(
  item: string,
  producers: readonly string[],
  context: MobDropSpawnContext | null,
): string {
  const head = `${MOB_SPAWN_CONTEXT} item=${item} producers=${JSON.stringify([...producers].sort())}`
  if (context === null) {
    return `${head} context=none reason=no_declared_spawn_rule mobs=[] dimensions=[] searchGrounded=false`
  }
  const cell = context.cell === null ? 'unknown' : `${context.cell.x},${context.cell.y},${context.cell.z}`
  const light = context.light === null ? 'unknown' : String(context.light)
  const gate = context.spawnLightMax === null ? 'none' : String(context.spawnLightMax)
  const probe = context.probeReason === null ? '' : ` probe=${context.probeReason}`
  return (
    `${head} mobs=${JSON.stringify(context.mobs)} dimensions=${JSON.stringify(context.dimensions)} ` +
    `dimension=${context.dimension} reason=${context.reason} cell=${cell} light=${light} ` +
    `spawnLightMax=${gate} biome=${context.biome ?? 'unknown'}${probe} searchGrounded=${context.searchGrounded}`
  )
}


export function formatMobDropSourceGap(gap: MobDropSourceGap): string {
  return (
    `${MOB_DROP_SOURCE_NONE} item=${gap.item} reason=${gap.reason} ` +
    `producers=${JSON.stringify(gap.producers)} sensed=${gap.sensed} ` +
    `offered=${JSON.stringify(gap.offered)} next=${gap.next}`
  )
}

/**
 * The typed no-producer gap for the active mob-drop need, or null when a producer
 * route is on offer / the goal has no declared mob producer. Pure.
 *
 * The need is the goal's own: for `collect X` it is exactly `X` (unchanged,
 * whether or not the body already holds enough), and for any other goal kind it is
 * the first item of the goal's BILL OF MATERIALS whose only grounded producer is a
 * mob. That second half is what makes a `craft ender_eye` goal report the same
 * typed fact a `collect blaze_rod` goal does: `item=blaze_rod
 * producers=["blaze"] sensed=0 next=explore`, instead of silently offering only
 * fortress fabric for an item no block drops.
 */
export function mobDropSourceGap(
  state: WorldState,
  offered: readonly Candidate[],
  recipes: RecipeIndex | null = null,
): MobDropSourceGap | null {
  const current = state.goalQueue?.current ?? null
  const goalKind = current?.kind ?? 'collect'
  const focusItem = current?.targetItem ?? state.goal.targetItem ?? null
  if (focusItem === null) return null
  const need =
    goalKind === 'collect'
      ? MOB_DROP_PRODUCERS[focusItem] === undefined
        ? undefined
        : focusItem
      : mobDropNeedsForGoal(
          focusItem,
          Math.max(1, Math.floor(current?.requiredCount ?? 1)),
          recipes,
          state.inventory.counts,
        )[0]
  if (need === undefined) return null
  const producerNames = MOB_DROP_PRODUCERS[need]
  if (producerNames === undefined) return null
  // A hunt candidate for this need IS the grounded producer route (the executor
  // verifies the kill plus the drop), so the gap is closed.
  if (offered.some((candidate) => candidate.meta.goalDrop === need)) return null
  const sensed = state.entities.filter((entity) => producerNames.has(entity.name)).length
  // `meta.explore` is the grounded-exploration marker `exploreMoveCandidate`
  // sets, so the gap's `next` agrees with the no-source gap and with the
  // exploration arm's own trigger.
  const explores = offered.some((candidate) => candidate.meta.explore === true)
  const offeredRoutes = explores ? ['explore'] : []
  const producers = [...producerNames].sort()
  return {
    item: need,
    producers,
    sensed,
    offered: offeredRoutes,
    reason: sensed > 0 ? 'producer_withheld' : 'no_producer_sensed',
    next: explores ? 'explore' : 'escalate',
    // The context half travels with the gap so a `sensed=0` tick is never again
    // indistinguishable from "the producer cannot exist here" or "nobody looked".
    spawnContext: mobDropSpawnContextFor(state, producers),
  }
}

/**
 * Vertical-safety truth for the MINE layer (owner rule: never dig the block you
 * are standing on).
 *
 * The DESCEND own-column (`dir === 'D'`) step is already gated in `state.ts`
 * (`no solid support at feet-2` / `floor already open (uncontrolled fall)`), but
 * the plain MINE path had no equivalent check. `buildStoneBlocks` walks every
 * column from the surface down and keeps the topmost air-exposed stone-like
 * block; for the bot's own column the feet cell is air, so the support block at
 * `feet.y - 1` is recorded as a normal `stone` BlockState. It is pickup-adjacent
 * (`horizontal ~0`, `vertical 1.0 <= PICKUP_MINE_VERTICAL`), so `mineCandidates`
 * emitted `MINE:<feet-1>` and removing it dropped the bot one block with no
 * support check - the uncontrolled straight-down dig the owner reported.
 *
 * This is feasibility/safety truth, not ranking: the support cell is refused as
 * a MINE and the controlled DESCEND step (which requires solid support at
 * feet-2) owns it instead. The marker reuses the existing
 * `DIG_DOWN_REFUSED reason=<...> cell=x,y,z` convention.
 */
export type DigDownRefusalReason = 'bot_support'

export interface DigDownRefusal {
  reason: DigDownRefusalReason
  /** the support cell the dig would remove (the bot's own floor) */
  cell: Vec3Json
}

/** The block cell directly beneath the bot's feet, from a (possibly fractional) position. */
export function botSupportCell(position: Vec3Json): Vec3Json {
  return { x: Math.floor(position.x), y: Math.floor(position.y) - 1, z: Math.floor(position.z) }
}

/**
 * Non-null when `target` is the block directly beneath the bot's feet. Pure, so
 * the candidate generator and the executor share the exact same truth.
 */
export function digsBotSupport(position: Vec3Json, target: Vec3Json | null): DigDownRefusal | null {
  if (target === null) return null
  const support = botSupportCell(position)
  if (target.x !== support.x || target.y !== support.y || target.z !== support.z) return null
  return { reason: 'bot_support', cell: support }
}

/** The exact `DIG_DOWN_REFUSED` observability line for a refused dig-down MINE. */
export function formatDigDownRefused(refusal: DigDownRefusal): string {
  return `DIG_DOWN_REFUSED reason=${refusal.reason} cell=${refusal.cell.x},${refusal.cell.y},${refusal.cell.z}`
}

/**
 * Why a `surface` goal's upward gap has no grounded ascent route. `surface`
 * goals (`kind: 'surface'`, `strategy: 'return_to_surface'`, `targetY` from
 * `deriveUpperAccessTargetY`) exist to regain the surface, but the `default`
 * branch of `generateRawCandidates` routed them through `mineCandidates`, which
 * offers only the sensed log pool, and `retrievalCandidates`/`surfaceSpot`,
 * which can only name a standable cell the sensor already saw (at most
 * `floor(self.y) + 1`). No family enumerated the vertical leg the goal exists
 * for, so the body paced inside the level-move set (live 48-minute loop: 144 x
 * `MOVE:p3_6*`, zero ascent markers). This is the typed cause of that dead end:
 * `no_placeable` (no block to pillar with) or `unsafe_column` (hazard in the
 * ascent column).
 */
export interface SurfaceAscentRefusal {
  reason: UpwardRefusalReason
  /** the `surface` goal id the refused ascent belongs to */
  goalId: string
  /** feet Y the ascent would have started from */
  fromY: number
  /** the goal's requested target Y */
  toY: number
  /** the own-column feet cell the refused ascent belongs to */
  cell: Vec3Json
}

/** The exact `SURFACE_ASCENT_REFUSED` observability line for the candidate layer. */
export function formatSurfaceAscentRefused(refusal: SurfaceAscentRefusal): string {
  return `SURFACE_ASCENT_REFUSED reason=${refusal.reason} goal=${refusal.goalId} from_y=${refusal.fromY} to_y=${refusal.toY} cell=${refusal.cell.x},${refusal.cell.y},${refusal.cell.z}`
}

/**
 * A sensed FIGHT target the body's melee envelope provably cannot be brought
 * onto from where it stands: the target is above the walk envelope and the ONE
 * vertical planner grounds no route to its level.
 *
 * The refused ascent is the same `SurfaceAscentRefusal` every other ascent arm
 * reports (`no_placeable` when no pillar block is held, `unsafe_column` when the
 * body's own column is a hazard), joined to the ENTITY identity and the contact
 * geometry so the fact is about `e<id>` rather than about a goal kind.
 */
export interface ContactRefusal extends SurfaceAscentRefusal {
  /** the sensed entity the contact was refused for */
  entityId: number
  targetName: string | null
  /** target feet Y minus body feet Y (positive: the target is ABOVE) */
  gapY: number
  /** the 3-D distance the walk would have to close */
  distance: number
  /** the contact verdict `classifyContactApproach` reached */
  approach: ContactApproach
  /** the carried block a pillar would consume, or null when none is held */
  placeable: string | null
}

/**
 * Deterministic feasibility fact for a `surface` goal whose ascent plan is
 * refused: is ANY offered candidate a body-changing route? A sensed MINE, a
 * locomotion MOVE, a dig STEP/DESCEND, a remembered RETRIEVE, an attached
 * vertical plan, or a capability acquisition that could build the missing fact
 * all count. When this is false the tick offers only WAIT/ESCALATE/EAT/EQUIP, so
 * the Option provably cannot progress from the current state - the fact the
 * controller may turn into `impossible` instead of pacing. Pure and exported so
 * the threshold is testable without a bot, and deliberately broad so a single
 * blocked pillar never erases a real alternative route.
 */
export function surfaceAscentRouteless(candidates: readonly Candidate[]): boolean {
  return !candidates.some(
    (candidate) =>
      candidate.kind === 'MINE' ||
      candidate.kind === 'MOVE' ||
      candidate.kind === 'STEP' ||
      candidate.kind === 'DESCEND' ||
      candidate.kind === 'RETRIEVE' ||
      candidate.meta.capabilityAcquisition === true ||
      candidate.meta.surfaceAscent === true ||
      (typeof candidate.meta.vertical === 'string' && candidate.meta.vertical !== 'none'),
  )
}

/**
 * True when at least one offered candidate can raise the body's ALTITUDE toward
 * a target above it. This is the `surface`/altitude-goal complement of
 * {@link surfaceAscentRouteless}: a level MOVE keeps the body inside its current
 * level set, so it is NOT an ascent route even though it changes the body cell.
 * Live (run-mublvgjx-yldu): a body in a pocket paced between two level cells
 * while `LOCAL_CAPABILITY_GAP attempts` passed 131 - the level moves masked the
 * dead end because every body-changing candidate counted. Only when no offer can
 * change altitude is the goal genuinely routeless and must escalate once.
 *
 * Pure and exported so the threshold is testable without a bot.
 */
export function altitudeRouteOnOffer(
  candidates: readonly Candidate[],
  fromY: number,
  targetY: number,
): boolean {
  if (targetY - fromY <= VERTICAL_GAP) return true
  return candidates.some((candidate) => {
    if (candidate.kind === 'WAIT' || candidate.kind === 'ESCALATE' || candidate.kind === 'DESCEND') return false
    if (typeof candidate.meta.vertical === 'string' && candidate.meta.vertical !== 'none') return true
    if (candidate.meta.surfaceAscent === true || candidate.meta[COLUMN_DIG_META] === true) return true
    const target = candidate.target
    return target !== null && target.y > fromY
  })
}

/**
 * Why a collect goal whose item has a declared producer has no grounded route at
 * all: the generic exploration arm could not put a body-changing route on offer.
 *
 *   - `no_frontier`  the sensor knows no standable frontier cell beyond the body's
 *                    own cell, so there is nowhere to walk;
 *   - `unreachable`  frontier cells were enumerated but every locomotion
 *                    candidate was withheld by the reachability gate;
 *   - `exhausted`    a frontier exists but the arm offered nothing (all cells are
 *                    blacklisted by move-failure memory).
 *
 * This is a deterministic CAN fact about the OFFERED set, never a preference. It
 * exists so a declared-producer goal can never stall silently on WAIT / a blind
 * DESCEND: the tick says "no exploration route, and here is why".
 */
export type ExploreRouteBlockedReason = 'no_frontier' | 'unreachable' | 'exhausted'

export interface ExploreRouteBlocked {
  /** goal key of the blocked collect goal, e.g. `collect:blaze_rod` */
  goal: string
  /** the focus item whose declared producer has no grounded route */
  item: string
  reason: ExploreRouteBlockedReason
}

/** The exact `EXPLORE_ROUTE_BLOCKED` observability line. */
export function formatExploreRouteBlocked(blocked: ExploreRouteBlocked): string {
  return `EXPLORE_ROUTE_BLOCKED goal=${blocked.goal} item=${blocked.item} reason=${blocked.reason}`
}

/**
 * Why a STRANDED body (no standable frontier beyond its own cell - the same
 * world fact `ExploreRouteBlocked` reports as `no_frontier`) could not be
 * offered any controlled descent off its own support column:
 *
 *   - `no_safe_step`  no `DescentOption` is both safe and diggable (hazard,
 *                     protected station, open floor, or no solid support), so
 *                     there is no bounded step that cannot hurt the body;
 *   - `no_tool`       a safe step exists but the body lacks the harvest tool
 *                     its block needs;
 *   - `exhausted`     every safe step has spent its bounded failure budget.
 *   - `recurrent`     the only remembered safe continuation has oscillated; it
 *                     is retired and the policy boundary receives the no-frontier fact.
 *
 * This is deterministic CAN/SAFE truth about the OFFERED set, never a
 * preference: it exists so "the body is cut off and the safe way down is
 * unavailable" is a typed fact instead of a bare WAIT. A damaging drop is never
 * a substitute - the refusal is the honest answer when no safe step exists.
 */
export type ColumnDescentRefusalReason = 'no_safe_step' | 'no_tool' | 'exhausted' | 'recurrent'

export interface ColumnDescentRefusal {
  reason: ColumnDescentRefusalReason
  /** the stalled body cell the descent would leave (floored feet cell) */
  cell: Vec3Json
  /** required harvest tool when `reason === 'no_tool'` */
  tool?: string | null
  /** required pickaxe rank when `reason === 'no_tool'` */
  tier?: number | null
}

/** The exact `COLUMN_DESCENT_REFUSED` observability line. */
export function formatColumnDescentRefused(refusal: ColumnDescentRefusal): string {
  const tool = refusal.reason === 'no_tool' ? ` tool=${refusal.tool ?? 'unknown'} tier=${refusal.tier ?? 0}` : ''
  return `COLUMN_DESCENT_REFUSED reason=${refusal.reason} cell=${refusal.cell.x},${refusal.cell.y},${refusal.cell.z}${tool}`
}

/**
 * The frontier distance `pickExplore` uses to reject the body's own cell. Shared
 * so "no walkable frontier" cannot drift between the exploration arm, the
 * typed explore dead end and the stranded-column descent.
 */
const STRANDED_FRONTIER_DISTANCE = 1.5

/**
 * A body is STRANDED when the sensor knows no standable cell beyond the one it
 * occupies: `pickExplore` finds no frontier and no ordinary walking MOVE can be
 * enumerated. This is the one geometric precondition for
 * {@link columnDescentCandidates} and is exported pure so the offer and its
 * typed refusal read the same fact. It says nothing about pillars: a 1-wide
 * ledge, a 1x1 shaft and a self-built column are the same world state.
 */
export function strandedOnColumn(state: Pick<WorldState, 'terrain' | 'self'>): boolean {
  return !state.terrain.standable.some((spot) => distance(spot, state.self.position) > STRANDED_FRONTIER_DISTANCE)
}

/**
 * Candidate kinds that move the body to another world cell. Used as the CAN
 * envelope for the stranded-column descent: while ANY of these is on offer the
 * tick already has a way out of the current cell, so the last-resort vertical
 * step is not enumerated.
 */
const LOCOMOTION_CANDIDATE_KINDS: ReadonlySet<CandidateKind> = new Set<CandidateKind>([
  'MOVE',
  'RETRIEVE',
  'RETREAT',
  'STEP',
  'DESCEND',
  'ENTER_PORTAL',
  // Walking onto a dropped item moves the body to another cell, so it is a way
  // out of the current cell exactly like RETRIEVE.
  'PICKUP',
])

/**
 * Why an ignition was not offered: a malformed frame (`PORTAL_LIGHT_REFUSED`)
 * or a missing flint_and_steel (`PRECONDITION_MISSING`). Surfaced instead of
 * silence, so a portal goal can never look "starved" for no reason.
 */
export interface IgnitionRefusal {
  reason: string
  line: string
  frameShape: 'ok' | 'bad'
}

/**
 * The grounded ignition candidates for the active goal. Offered only while the
 * goal targets the `nether_portal` place operation and a validated frame is
 * supplied, and only when flint_and_steel is held; otherwise the typed refusal
 * (or null when the goal is unrelated) is returned.
 */
export function ignitionCandidates(
  state: WorldState,
  options: CandidateOptions,
): { candidates: Candidate[]; refusal: IgnitionRefusal | null } {
  const current = state.goalQueue?.current ?? null
  const focusItem = current?.targetItem ?? state.goal.targetItem ?? null
  if (focusItem !== NETHER_PORTAL) return { candidates: [], refusal: null }
  // A `nether_portal` goal under the entry predicate is the DIMENSION TRANSFER,
  // not the ignition: offering flint_and_steel there would be a different
  // semantic action. Only the ignition goal (explicit `portal_lit`, or a legacy
  // row with no predicate) may be offered IGNITE.
  const predicate = current?.targetPredicate ?? null
  if (predicate !== null && predicate !== PORTAL_LIT_PREDICATE) return { candidates: [], refusal: null }
  const frame = options.portalFrame ?? null
  if (frame === null) return { candidates: [], refusal: null }

  const hasTool = (state.inventory.counts[FLINT_AND_STEEL] ?? 0) > 0
  const plan = planPortalIgnition({ frame, hasFlintAndSteel: hasTool })
  if (!plan.ok) {
    return { candidates: [], refusal: { reason: plan.reason, line: plan.line, frameShape: frame.shape } }
  }
  const ignition = plan.candidate
  return {
    candidates: [
      {
        id: ignition.id,
        kind: 'IGNITE',
        label: `use ${FLINT_AND_STEEL} on the portal frame at (${ignition.lightPosition.x},${ignition.lightPosition.y},${ignition.lightPosition.z}) to light the nether portal`,
        targetName: NETHER_PORTAL,
        target: ignition.lightPosition,
        targetEntityId: null,
        itemName: FLINT_AND_STEEL,
        requiresTool: false,
        toolName: null,
        inReach: distance(ignition.lightPosition, state.self.eyePosition) <= options.reach,
        hasStandableAdjacent: true,
        meta: {
          tick: state.tick,
          lightX: ignition.lightPosition.x,
          lightY: ignition.lightPosition.y,
          lightZ: ignition.lightPosition.z,
          dimension: ignition.dimension,
          portalCells: serializePortalCells(ignition.portalCells),
        },
      },
    ],
    refusal: null,
  }
}

/**
 * Why entry was refused: the exact `planPortalEntry` reason and line. Surfaced
 * instead of silence so a `portal_entered` goal can never look starved while the
 * lit portal is unreachable or not actually lit.
 */
export interface PortalEntryRefusal {
  reason: string
  line: string
}

/**
 * The grounded dimension-transfer candidate for the active goal. Offered ONLY
 * while the goal targets the `nether_portal` place operation under the
 * `portal_entered` predicate; the transfer itself is then a single deterministic
 * body action with a `dimension == <target>` postcondition. The controller
 * supplies the live plan (lit interior + safe approach); this never chooses WHEN
 * to enter.
 */
/**
 * The step-aside leg onto an OPEN face of the portal, offered ALONGSIDE the
 * entry (never instead of it).
 *
 * Measured live (run-mucaq28q-1ftq1, main 4c5645b): the body stood WEST of the
 * left frame column at 24.7,67,9.7 while the entry cell (26,67,9) sat 1.8 blocks
 * east BEHIND the obsidian column at (25,67,9). The straight walk is a 2-high
 * frame face, so the entry could never get in and the offer collapsed to
 * WAIT/ESCALATE - the operator's "it would get through if it stepped one block
 * aside". The generic travel approach leg cannot ground this move either: every
 * open-face cell is FARTHER from the target than the occluded stand cell, so the
 * "reduce the distance" rule rejects exactly the leg that is needed.
 *
 * The face is derived from STRUCTURE truth - a standable cell beside an interior
 * cell at its level, outside the frame ring - never from the plan's wording.
 * This is a mechanically necessary prerequisite of the entry, offered as an
 * ordinary MOVE the guard/reachability gate still own; Jev keeps the choice.
 */
function portalOpenFaceLegs(state: WorldState, options: CandidateOptions, entry: PortalEntryCandidate): Candidate[] {
  const standable = new Set(state.terrain.standable.map((spot) => cellKey(spot)))
  const interior: PortalBlockPosition[] = entry.portalCells
  const bodyCell = cellKey(state.self.position)
  const faces = portalOpenFaceCells(
    interior,
    entry.enterCell.y,
    (spot) => standable.has(cellKey(spot)),
    state.self.position,
    PORTAL_OPEN_FACE_MAX_DISTANCE,
  ).filter((spot) => cellKey(spot) !== bodyCell)
  const faceLegs = faces.map((spot) => ({
      id: `MOVE:${blockId('p', spot)}`,
      kind: 'MOVE' as const,
      label:
        `step onto the portal's open face at (${spot.x},${spot.y},${spot.z}) so the walk into ` +
        `(${entry.enterCell.x},${entry.enterCell.y},${entry.enterCell.z}) is not blocked by the frame`,
      targetName: NETHER_PORTAL,
      target: spot,
      targetEntityId: null,
      itemName: null,
      requiresTool: false,
      toolName: null,
      inReach: distance(spot, state.self.position) <= options.reach,
      hasStandableAdjacent: true,
    meta: {
      tick: state.tick,
      x: spot.x,
      y: spot.y,
      z: spot.z,
      approachLeg: 'portal_open_face',
      approachTarget: `${entry.enterCell.x},${entry.enterCell.y},${entry.enterCell.z}`,
    },
  }))
  // THE BOUNDED CONTINUATION at the site where the entry lane grounds the face:
  // measured live (run-mucbyro1-1hqhm) the one open face was standable but NOT
  // reachable by its own leg probe - the 1-block hole at (24,67,10)/(24,66,10)
  // sits between the body and the face - so the offer refused `faces=1` while the
  // generic MOVE arm never saw the pocket. The same `pocketContinuations` grounder
  // the travel arm uses is attached here, aimed at the FACE, so the mechanical
  // route into the pocket is on offer in the decision that owns the entry.
  const out: Candidate[] = [...faceLegs]
  const reachableFaces = faceLegs.filter((leg) => leg.target !== null && levelWalkReachable(state, leg.target))
  const unreachableFaces = faceLegs.filter((leg) => leg.target !== null && !levelWalkReachable(state, leg.target))
  for (const leg of unreachableFaces) {
    const target = leg.target
    if (target === null) continue
    const continuations = pocketContinuations(state, target)
    const unique = continuations.length === 1 && reachableFaces.length === 0 && faceLegs.length === 1
    for (const cont of continuations) {
      const reflex = unique
        ? formatLegReflex({
            skill: 'enter_portal',
            action: cont.action,
            cell: cont.via ?? cont.landing,
            via: cont.via,
            ledge: cont.ledge,
            evidence:
              `exactly one standable open face (${cellText(target)}) is not level-walk reachable from ` +
              `(${cellText(state.self.position)}); the bounded continuation is ` +
              `${cont.action === 'step_over' ? `drop into (${cont.via === null ? 'none' : cellText(cont.via)}) then ` : ''}` +
              `step up onto (${cellText(cont.ledge)}) at (${cellText(cont.landing)}); ` +
              `d=${round2Number(distance(state.self.position, target))}->${round2Number(cont.toTarget)}`,
          })
        : null
      out.push(
        continuationCandidate(
          state,
          options,
          {
            target,
            targetName: NETHER_PORTAL,
            reason: 'portal_open_face',
            skill: PORTAL_ENTER_SKILL,
            extraMeta: {
              entryCell: `${entry.enterCell.x},${entry.enterCell.y},${entry.enterCell.z}`,
              faceCell: `${target.x},${target.y},${target.z}`,
            },
          },
          cont,
          reflex,
        ),
      )
    }
  }
  return out
}

export function entryCandidates(
  state: WorldState,
  options: CandidateOptions,
  digRefusals: DigRouteRefusalSink = [],
): { candidates: Candidate[]; refusal: PortalEntryRefusal | null } {
  const current = state.goalQueue?.current ?? null
  const focusItem = current?.targetItem ?? state.goal.targetItem ?? null
  if (focusItem !== NETHER_PORTAL) return { candidates: [], refusal: null }
  if (current?.targetPredicate !== PORTAL_ENTERED_PREDICATE) return { candidates: [], refusal: null }
  const plan = options.portalEntry ?? null
  if (plan === null) return { candidates: [], refusal: null }
  if (!plan.ok) return { candidates: [], refusal: { reason: plan.reason, line: plan.line } }
  const entry = plan.candidate
  // The entry cell is reached by the SAME bounded dig/vertical route machinery
  // every other "get to a cell" goal uses: the grounded vertical plan is
  // compiled into the MOVE contract meta (`vertical=staircase-up|...`) and the
  // executor runs it with the ordinary vertical leg when the plain walk cannot
  // reach the cell. Live (run-mubj6ucc-si3e, source 52594db) the body sat ~14
  // blocks BELOW the lit gate behind diggable terrain and the entry carried no
  // route at all, so `pathTo(enterCell)` reported `noPath`/`stuck` forever. When
  // no grounded plan exists the refusal is carried too, so the executor fails
  // ONCE with the obstruction instead of re-arming the same unreachable walk.
  const route = planVerticalApproachDetailed(verticalInputFor(state, entry.enterCell))
  const verticalMeta = verticalPlanMeta(route.plan, Math.floor(state.self.position.y), entry.enterCell.y)
  // The SECOND grounded plan of the SAME contract, so the entry's vertical leg
  // has a composed fallback the executor can run when the first one cannot close
  // the height. Two live shapes made this necessary (both the operator's floated
  // gate, both ending in `PORTAL_WALK_IN_REFUSED ... refusal=not_level`):
  //
  //   * run.jsonl 2026-09-22T15:47:37Z `ENTER:27,67,9`, interior (27,67,9) five
  //     above a body at y=62: the primary was a `reuse` plan whose remembered
  //     tunnel sat at (-7,66,9), 34 blocks west. The leg STALLED rather than
  //     refusing typed, and `runVerticalContract` consults `fallbackVertical`
  //     only on the typed refusal - so the already-grounded own-column pillar
  //     (`routeSig ...:pillar=0:fallback=pillar`) was never executed.
  //   * run.jsonl 2026-09-22T15:56:03Z `ENTER:26,67,9`, seven above: the primary
  //     was a `staircase-up` whose dig/step cell was (22,67,1) - a sensor step cut
  //     four blocks west and eight north of the interior - and it carried
  //     `fallback=none`, so there was nothing to fall back to at all.
  //
  // Both legs come from the ONE planner (`planVerticalApproachDetailed`): the
  // primary is its answer with the body's remembered tunnel, the fallback is its
  // answer with that tunnel and the sensor's step-cut pool removed - i.e. the
  // own-column ascent (`pillar` / the up-staircase the body's own column can
  // cut) that `ascentRouteTo` grounds for every other ascent. No second planner,
  // no ranking: both plans realize the SAME climb to the interior's level and are
  // executed in a fixed order, primary first. Gated to an interior ABOVE the body
  // beyond the walk-in tolerance, so a level gate and a one-block step-up keep
  // exactly the meta they had.
  const climbInput = verticalInputFor(state, entry.enterCell)
  const climbNeeded = entry.enterCell.y - Math.floor(state.self.position.y) > PORTAL_WALK_IN_LEVEL_TOLERANCE
  const tunnelFallback =
    route.plan?.kind === 'reuse' ? planVerticalApproach({ ...climbInput, tunnel: null }) : null
  // The portal plane is never mined: the own-column ascent is grounded WITHOUT
  // the sensor's step cuts, so the fallback can never choose a dig that opens the
  // frame (`candidates.ts` filters protected structure out of `stepCuts` too, but
  // the entry must not depend on that filter alone).
  const ownColumnFallback =
    tunnelFallback === null && climbNeeded && route.plan !== null && route.plan.kind !== 'pillar'
      ? planVerticalApproach({ ...climbInput, tunnel: null, stepCuts: null })
      : null
  const fallbackPlan = tunnelFallback ?? ownColumnFallback
  // EXACTLY the same condition as before for a `reuse` primary (byte-identical
  // meta, including the `fallbackVertical: 'none'` a tunnel-less descent emits),
  // plus the own-column ascent only where it is a genuinely different second leg.
  const declaresFallback = route.plan?.kind === 'reuse' || ownColumnFallback !== null
  // THE CROSSING LEG (the operator's trial, second half - see
  // `groundEntryBridgeLeg`): when the body already stands at the interior's own
  // level and the way across is open air, the missing mechanical fact is a
  // scaffolded span, grounded by the SAME bridge rule every other leg uses. It is
  // attached with the ONE shared contract (`bridgeRoute.ts#bridgeContractMeta`),
  // so the executor reads exactly the keys this offer wrote. Grounded ONLY when a
  // span really exists: a level gate, a one-block step-up and an ordinary walkable
  // gate keep byte-identical meta (no `bridge*` key, no crossing marker).
  const bridgePlan = groundEntryBridgeLeg(state, options, entry)
  const meta: Record<string, string | number | boolean> = {
    tick: state.tick,
    enterX: entry.enterCell.x,
    enterY: entry.enterCell.y,
    enterZ: entry.enterCell.z,
    dimension: entry.dimension,
    portalCells: serializePortalCells(entry.portalCells),
    // A remembered-site route (interior unobservable from here) is offered
    // with the fact named: the executor re-verifies the lit interior at
    // arrival, so this can never transfer through an unlit frame.
    ...(entry.unverified === true ? { entryUnverified: true } : {}),
    ...verticalMeta,
    ...(declaresFallback ? fallbackVerticalMeta(fallbackPlan) : {}),
    // The crossing contract, exactly like a MOVE bridge carries it (plus the
    // §17 authority line and the owning skill, which is THIS Skill).
    ...(bridgePlan === null
      ? {}
      : {
          ...bridgeContractMeta(bridgePlan),
          bridgeAuthorityLine: entryBridgeAuthorityLine(bridgePlan),
          legContinuationSkill: PORTAL_ENTER_SKILL,
        }),
    ...(route.plan === null && route.ascentRefusal !== null
      ? { entryRouteRefusal: route.ascentRefusal.reason }
      : {}),
  }
  const candidate: Candidate = {
    id: entry.id,
    kind: 'ENTER_PORTAL',
    label: `walk into the lit nether portal at (${entry.enterCell.x},${entry.enterCell.y},${entry.enterCell.z}) and transfer to ${entry.dimension}`,
    targetName: NETHER_PORTAL,
    // The interior cell itself is the locomotion target: the generic MOVE
    // machinery walks the body in (standing in a portal block is the world
    // mechanic that transfers). Where the walk cannot reach it, the same
    // grounded vertical plan a MOVE candidate carries supplies the dig leg.
    target: entry.enterCell,
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: distance(entry.enterCell, state.self.eyePosition) <= options.reach,
    hasStandableAdjacent: true,
    meta,
  }
  // A route that already proved it cannot complete from this body cell - a
  // path-stage failure (`PATH_CALLBACK phase=failed outcome=noPath|stuck`) is
  // recorded as a SPENT route exactly like zero observable change - must not be
  // re-offered unchanged. The grounded next step is an approach leg that changes
  // the STAND CELL, so the body meets a different mechanical situation and the
  // entry is re-offered from there (never a premature permanent suppression).
  const standKey = cellKey(state.self.position)
  const targetKey = cellKey(entry.enterCell)
  if (
    isZeroProgressRouteRepeat(state.signals.zeroProgressRoutes, {
      kind: 'ENTER_PORTAL',
      targetKey,
      standKey,
      routeSig: routeSignature({ kind: candidate.kind, id: candidate.id, meta: candidate.meta }),
      nowMs: state.timestampMs,
    })
  ) {
    // Two grounded route changes, offered together: a walk leg that changes the
    // STAND CELL, and the bounded DIG route that changes the TERRAIN toward the
    // entry cell. A sealed body (the measured 1-wide shaft) senses no standable
    // cell beyond its own, so only the dig route can act there; a body whose leg
    // exists but whose path is refused keeps the dig route as the executable
    // alternative. Neither is a replacement: Jev chooses, and the entry is
    // re-offered from the new cell.
    const legs = travelApproachLegs(
      state,
      options,
      {
        target: entry.enterCell,
        targetName: NETHER_PORTAL,
        reason: 'route_spent',
        skill: PORTAL_ENTER_SKILL,
        label: (best) =>
          `walk an approach leg toward the lit nether portal at (${entry.enterCell.x},${entry.enterCell.y},${entry.enterCell.z}): the last route there failed, so stand at (${best.x},${best.y},${best.z}) first`,
        extraMeta: { entryCell: `${entry.enterCell.x},${entry.enterCell.y},${entry.enterCell.z}` },
      },
      digRefusals,
    )
    const faceLegs = portalOpenFaceLegs(state, options, entry)
    const withFaces = [...legs, ...faceLegs.filter((leg) => !legs.some((other) => other.id === leg.id))]
    if (withFaces.length > 0) return { candidates: withFaces, refusal: null }
    // No grounded route, no grounded approach leg and no grounded dig route
    // changes anything from here: every route this goal can ground is spent. Say
    // it typed and let the ordinary bounded escalation reach System2 - never
    // re-offer the dead route and never leave the offer at (failing route, WAIT).
    const routes = goalSpentRouteCount(state.signals.zeroProgressRoutes, {
      kind: 'ENTER_PORTAL',
      targetKey,
      nowMs: state.timestampMs,
    })
    return {
      candidates: [],
      refusal: {
        reason: ROUTE_ALL_SPENT_REASON,
        line: formatRouteEscalate(current?.id ?? 'unknown', ROUTE_ALL_SPENT_REASON, routes),
      },
    }
  }
  // Every open face stays policy-visible (#436): several ways in are a CHOICE,
  // so code offers them all as ordinary MOVE legs and never picks one.
  const faceLegs = portalOpenFaceLegs(state, options, entry)
  return { candidates: [candidate, ...faceLegs], refusal: null }
}

/**
 * The route a log-class collect goal currently offers, mirrored as `LOG_ROUTE`:
 *
 *   - `mine_sensed`      a log is sensed, in reach and visible: dig it now;
 *   - `retrieve_known`   walk to a remembered log coordinate on the same level;
 *   - `ascend_then_mine` the remembered log is above: add the vertical leg
 *                        (pillar / staircase-up / reuse) before the walk;
 *   - `explore`          no log is sensed or reachable: move the body toward
 *                        unexplored terrain instead of mining in place.
 */
export type LogRouteMode = 'mine_sensed' | 'retrieve_known' | 'ascend_then_mine' | 'explore'

export interface LogRouteDecision {
  mode: LogRouteMode
  target: Vec3Json
  candidateId: string
}

/** The candidate-meta key that carries a `LogRouteMode`; the controller mirrors it. */
export const LOG_ROUTE_META = 'logRoute'

const LOG_ROUTE_MODES: ReadonlySet<string> = new Set(['mine_sensed', 'retrieve_known', 'ascend_then_mine', 'explore'])

function logRouteModeOf(candidate: Candidate): LogRouteMode | null {
  const value = candidate.meta[LOG_ROUTE_META]
  return typeof value === 'string' && LOG_ROUTE_MODES.has(value) ? (value as LogRouteMode) : null
}

function carriesLogRoute(candidate: Candidate): boolean {
  return logRouteModeOf(candidate) !== null
}

/**
 * The first presented candidate (candidate order is the policy's preference
 * order) that carries a log route, or null. Pure and exported so the controller
 * can mirror `LOG_ROUTE` for exactly the route the policy sees on offer.
 */
export function logRouteOf(candidates: readonly Candidate[]): LogRouteDecision | null {
  for (const candidate of candidates) {
    const mode = logRouteModeOf(candidate)
    if (mode === null || candidate.target === null) continue
    return { mode, target: candidate.target, candidateId: candidate.id }
  }
  return null
}

/** The exact `LOG_ROUTE` observability line for one route decision. */
export function formatLogRoute(route: LogRouteDecision): string {
  return `LOG_ROUTE mode=${route.mode} target=${route.target.x},${route.target.y},${route.target.z}`
}

/**
 * True when the CURRENT goal is a `collect` whose item is a log-class want
 * (`log`, `*_log`, `charcoal`, `planks`, `fuel`). Only such a goal promises the
 * user a log, so only such a goal must always hold a body-moving log route.
 */
export function logCollectGoal(state: WorldState): boolean {
  const current = state.goalQueue?.current ?? null
  if ((current?.kind ?? 'collect') !== 'collect') return false
  const focus = current?.targetItem ?? state.goal.targetItem ?? null
  return focus !== null && retrievalWant(focus)?.kind === 'log'
}

function focusWantsLog(goalKind: string, focusItem: string | null): boolean {
  return goalKind === 'collect' && focusItem !== null && retrievalWant(focusItem)?.kind === 'log'
}

/**
 * Name the remembered-log route by the leg it actually carries: a vertical plan
 * for an above-target makes it `ascend_then_mine`, a same-level walk is
 * `retrieve_known` (a target one block up is stepped, not ascended).
 */
function logRetrieveMode(state: WorldState, target: Vec3Json, vertical: VerticalPlan | null): LogRouteMode {
  return target.y - state.self.position.y > VERTICAL_GAP && vertical !== null ? 'ascend_then_mine' : 'retrieve_known'
}

const DEFAULT_MOVE_MIN_DISTANCE = 0
const DEFAULT_MOVE_MAX_DISTANCE = 48
const DEFAULT_TUNNEL_MAX_DISTANCE = 24
const DEFAULT_MAX_MOVE_CANDIDATES = 6
const DEFAULT_CANDIDATE_MOVE_FAILURE_LIMIT = 4
const DEFAULT_CANDIDATE_DESCEND_FAILURE_LIMIT = 3
const DEFAULT_PLACE_SPOT_RETRY_LIMIT = 2
/**
 * Widest distance at which a sensed passive food animal can be a hunt route.
 * This equals the sensor's default `entityRadius` (24m, state.ts
 * `defaultSensorOptions`): `buildEntities` drops anything farther, so no hunt
 * candidate can be grounded beyond it. The ATTACK executor's `GoalFollow` arm
 * already walks the body to the entity, so the old 8m melee gate was a
 * candidate-generation cap, not a physical one.
 */
const DEFAULT_FOOD_HUNT_RANGE = 24
/** Block within this horizontal distance of the bot counts as pickup-adjacent. */
const PICKUP_MINE_HORIZONTAL = 2.75
/** Vertical band (relative to the feet) in which a drop still lands in reach. */
const PICKUP_MINE_VERTICAL = 1.5

export const defaultCandidateOptions: CandidateOptions = {
  reach: 4.5,
  maxMineCandidates: 12,
  maxAttackCandidates: 4,
  eatBelowFood: DEFAULT_EAT_BELOW_FOOD,
  foodHuntRange: DEFAULT_FOOD_HUNT_RANGE,
  moveMinDistance: DEFAULT_MOVE_MIN_DISTANCE,
  moveMaxDistance: DEFAULT_MOVE_MAX_DISTANCE,
  tunnelMaxDistance: DEFAULT_TUNNEL_MAX_DISTANCE,
  maxMoveCandidates: DEFAULT_MAX_MOVE_CANDIDATES,
  moveFailureLimit: DEFAULT_CANDIDATE_MOVE_FAILURE_LIMIT,
  descendFailureLimit: DEFAULT_CANDIDATE_DESCEND_FAILURE_LIMIT,
  placeSpotRetryLimit: DEFAULT_PLACE_SPOT_RETRY_LIMIT,
  recipes: null,
}

/**
 * The shared `food` resource class. A `collect food` goal is the survival goal
 * the ladder's optional `food` rung emits; its producers are FOOD_ANIMALS.
 */
const FOOD_CLASS = 'food'

/**
 * Passive animals whose drop is an edible item in the shared food class. They
 * are not `hostile`, so the hostile-only combat filter never offers them;
 * without this list the resident has no way to acquire food and cannot
 * regenerate health.
 */
const FOOD_ANIMALS = new Set([
  'cow',
  'mooshroom',
  'pig',
  'chicken',
  'sheep',
  'rabbit',
  'cod',
  'salmon',
  'tropical_fish',
])

const HAZARD_DANGER_RADIUS = 3

export function blockId(prefix: 'b' | 'p', position: Vec3Json): string {
  return `${prefix}${position.x}_${position.y}_${position.z}`
}

function isExecutable(block: BlockState): boolean {
  return block.diggable && (block.inReach || block.hasAdjacentStandable)
}

export function countBlockedLogs(state: WorldState): number {
  return state.blocks.filter((block) => block.kind === 'log' && !isExecutable(block)).length
}

function mineLabel(block: BlockState): string {
  const where = `(${block.position.x},${block.position.y},${block.position.z})`
  const reach = block.inReach ? 'in reach' : `${block.distance}m away`
  const access = block.hasAdjacentStandable ? 'walk-up access' : 'no walk-up access'
  const tool = block.harvestTool === null ? 'hand-harvestable' : `needs a ${block.harvestTool}`
  return `mine ${block.name} at ${where}, ${reach}, ${access}, ${tool}`
}

function moveLabel(target: Vec3Json, role: string, botPosition: Vec3Json): string {
  return `${role} (${target.x},${target.y},${target.z}), ${distance(target, botPosition)}m away`
}

function moveToBlockLabel(block: BlockState, spot: Vec3Json, routeOnly = false): string {
  const where = `(${block.position.x},${block.position.y},${block.position.z})`
  const tool = routeOnly
    ? 'route to the structure, nothing is mined'
    : block.harvestTool === null
      ? 'hand-harvestable'
      : `needs a ${block.harvestTool}`
  const reach = block.inReach ? 'not pickup-adjacent yet' : 'out of reach'
  return `walk to ${block.name} at ${where}, ${block.distance}m away (${reach}), stand at (${spot.x},${spot.y},${spot.z}), ${tool}`
}

function hasTool(state: WorldState, toolName: Candidate['toolName'], tier: number | null = null): boolean {
  if (toolName === null) return true
  const counts = state.inventory.counts
  if (tier === null || tier <= 0) {
    const suffix = `_${toolName}`
    return Object.keys(counts).some((name) => name.endsWith(suffix) && (counts[name] ?? 0) > 0)
  }
  return Object.entries(counts).some(([name, count]) => {
    if (count <= 0) return false
    const rank = PICKAXE_RANKS[name]
    return rank !== undefined && rank >= tier
  })
}

/**
 * Pure, deterministic. Same state in -> same candidate list out (ordering
 * included), which is what makes the guard and the calibration log meaningful.
 * The affordance gate (#11 v2) runs inside: only mechanically reachable targets
 * are presented, and withheld targets carry a typed reason + missing
 * capabilities instead of being silently retried.
 */
export function generateCandidates(
  state: WorldState,
  options: CandidateOptions = defaultCandidateOptions,
): Candidate[] {
  return generateGroundedCandidates(state, options).candidates
}

export function generateGroundedCandidates(
  state: WorldState,
  options: CandidateOptions = defaultCandidateOptions,
): GroundedCandidatesResult {
  // The dig-route refusals are collected across BOTH passes (the raw offer and
  // the gate's own capability-acquisition pass), so the tick reports every travel
  // target it could neither walk to nor dig toward.
  const digRefusals: DigRouteRefusalSink = []
  const raw = generateRawCandidates(state, options, digRefusals)
  const grounded = applyReachabilityGate(
    raw.candidates,
    state,
    options,
    raw.placeRefusal,
    raw.ignitionRefusal,
    raw.entryRefusal,
    raw.armorRefusals,
    raw.surfaceAscentRefusal,
    raw.foodHabitatRefusal,
    raw.sourceExclusions,
    raw.columnDescentRefusal,
    raw.prospectRefusal,
    digRefusals,
    raw.contactRefusals,
    raw.containerRefusals,
    raw.armorCraftRefusals,
  )
  // The survival fact is computed from the OFFERED set, never from the raw one,
  // so "no food route" can never be reported while a route is actually on offer.
  // The mob-drop producer gap follows the same rule: it is derived from the same
  // offered set, so it can never claim a missing producer while one is on offer.
  return {
    ...grounded,
    foodGap: foodSourceGap(state, options, grounded.candidates),
    // The combat-kit fact is the other half of the same producer path: which
    // prerequisite (a sword craft, an armour equip or the armour craft that
    // produces the piece) this body's kit is missing for the required kill.
    combatKitGap: combatKitGap(state, grounded.candidates),
    mobDropGap: mobDropSourceGap(state, grounded.candidates, options.recipes ?? null),
    // Same "OFFERED set" rule as the gaps above: an armour craft the reachability
    // gate withheld must never be reported as a grounded CAN.
    armorCraftOffers: armorCraftOfferEvidence(grounded.candidates),
  }
}

/**
 * The typed `ARMOR_CRAFT` evidence for the armour crafts actually on offer this
 * tick, read off the OFFERED candidates (`meta.armorCraft`). Derived, never
 * restated: the marker and the candidate cannot disagree about the piece, the
 * material, the count or the slot.
 */
function armorCraftOfferEvidence(offered: readonly Candidate[]): ArmorCraftOffer[] {
  const out: ArmorCraftOffer[] = []
  for (const candidate of offered) {
    if (candidate.meta.armorCraft !== true) continue
    const slot = candidate.meta.armorSlot
    if (slot !== 'head' && slot !== 'torso' && slot !== 'legs' && slot !== 'feet') continue
    const material = candidate.meta.armorMaterial
    const worn = candidate.meta.armorWorn
    out.push({
      slot,
      itemName: candidate.itemName ?? 'unknown',
      material: typeof material === 'string' && material !== 'none' ? material : null,
      need: typeof candidate.meta.armorNeed === 'number' ? candidate.meta.armorNeed : 0,
      have: typeof candidate.meta.armorHave === 'number' ? candidate.meta.armorHave : 0,
      candidateId: candidate.id,
      worn: typeof worn === 'string' && worn !== 'none' ? worn : null,
    })
  }
  return out
}

/**
 * True when a candidate is an actual ROUTE for the active focus: a sensed
 * MINE/MOVE/dig-access, a remembered RETRIEVE, a craft/smelt/place/portal step, a
 * goalDrop ATTACK (the grounded producer route for a mob-drop item), or a DESCEND
 * the world grounds (a sensed/tunnel target, a remembered stone level below, a
 * stone-class focus, or an explicit `descend_to` predicate).
 *
 * A blind DESCEND carries none of those facts: it exists only because the focus
 * item has a declared scanned source, which is perception truth rather than a
 * route. Ordinary reactions (WAIT/ESCALATE/ATTACK/RETREAT/EAT) and clearance
 * MINEs are never routes either.
 *
 * A standing SELF-CARE craft is not a focus route either. Measured while landing
 * the armour craft affordance: a body collecting `blaze_rod` with a sensed blaze
 * in contact and 4 iron ingots carried offered `CRAFT:iron_boots`, and that alone
 * flipped this predicate to "the goal has a route", which withdrew the goal's own
 * producer-search MOVEs (`meta.producerSearch`) - the affordance silently crowded
 * out the focus's route. The armour craft advances the self-care goal
 * (`armorCraft` meta), so it is excluded exactly like a clearance MINE.
 */
function hasAdvancingGoalRoute(candidate: Candidate): boolean {
  if (candidate.meta.clearance === true) return false
  if (candidate.meta.armorCraft === true) return false
  switch (candidate.kind) {
    case 'WAIT':
    case 'ESCALATE':
    case 'RETREAT':
    case 'EAT':
    case 'EQUIP':
      return false
    case 'ATTACK':
      // A `goalDrop` ATTACK is the direct grounded producer route for the active
      // mob-drop collect goal (the executor verifies the kill and the drop); a
      // `foodRoute=animal` ATTACK is the same kind of route for the survival food
      // goal (the ATTACK executor walks to the animal and kills it). Ordinary
      // combat is a local reaction, not a goal route.
      return typeof candidate.meta.goalDrop === 'string' || candidate.meta.foodRoute === 'animal'
    case 'DESCEND':
      return candidate.meta.grounded === true
    case 'CONTAINER':
      // A WITHDRAW of the item the goal wants is a grounded producer route; an
      // OPEN/inspect probe carries no claim at all (its contents are UNKNOWN),
      // so it is not an advancing route.
      return candidate.meta.containerProducer !== undefined
    default:
      return true
  }
}

/** Cap on edible recipe results examined per tick, so a large recipe table stays bounded. */
const FOOD_RECIPE_SCAN_CAP = 64

/** Cap on cook candidates offered per tick. */
const FOOD_COOK_CAP = 4

/** Stable cell key for joining the sensor's food-source tags with a block candidate. */
function blockCellKey(position: Vec3Json): string {
  return `${position.x},${position.y},${position.z}`
}

/** True when the body is at/below the single eat gate. */
function bodyHungry(state: Pick<WorldState, 'self'>, options: CandidateOptions): boolean {
  return Number.isFinite(state.self.food) && state.self.food <= options.eatBelowFood
}

/**
 * The edible recipe results known to the running data version, in the recipe
 * index's own order. A foreign/fixture `RecipeIndex` may not enumerate results;
 * that yields no cook route rather than an invented one.
 */
function edibleRecipeResults(recipes: RecipeIndex | null): readonly string[] {
  if (recipes === null) return []
  return (recipes.resultItems?.() ?? []).filter((item) => isEdibleFoodItem(item)).slice(0, FOOD_RECIPE_SCAN_CAP)
}

/**
 * True when a sensed `acquire` cell is a real route to food: the ingredient it
 * drops is the LAST missing piece of an edible recipe the body can otherwise
 * finish (held, or one executable craft step away). Without this gate, mining a
 * brown_mushroom while holding no red_mushroom and no plan would be reported as
 * a food route when it is only clutter - the CAN fact must be grounded in the
 * recipe the body can actually complete.
 */
function foodIngredientCompletesRecipe(state: WorldState, options: CandidateOptions, item: string): boolean {
  const recipes = options.recipes ?? null
  if (recipes === null) return false
  const counts = state.inventory.counts
  for (const result of edibleRecipeResults(recipes)) {
    const tableAvailable = sensedCraftingTableAvailable(state, options, result)
    for (const variant of recipes.recipesFor(result)) {
      if (!variant.ingredients.some((ingredient) => ingredient.item === item)) continue
      const complete = variant.ingredients.every((ingredient) => {
        if (ingredient.item === item) return true
        if ((counts[ingredient.item] ?? 0) >= ingredient.count) return true
        return planNextCraftStep(recipes, ingredient.item, counts, tableAvailable, ingredient.count).op !== null
      })
      if (complete) return true
    }
  }
  return false
}

/**
 * The sensed blocks that ground a food route for THIS tick, keyed by cell.
 *
 * `forage` cells (an edible drop) are offered to any hungry body with no edible
 * item held. `acquire` cells (a recipe ingredient) only when the ingredient
 * completes an edible recipe the body can finish. Code owns this CAN fact and
 * nothing else: no route is preferred, ranked or auto-selected here.
 */
function foodRouteCells(
  state: WorldState,
  options: CandidateOptions,
): ReadonlyMap<string, { route: 'forage' | 'acquire'; item: string }> {
  const out = new Map<string, { route: 'forage' | 'acquire'; item: string }>()
  if (pickFood(state) !== null || !bodyHungry(state, options)) return out
  for (const block of state.blocks) {
    const route = block.foodRoute
    const item = block.foodItem
    if (route === undefined || typeof item !== 'string' || item.length === 0) continue
    if (route === 'acquire' && !foodIngredientCompletesRecipe(state, options, item)) continue
    out.set(blockCellKey(block.position), { route, item })
  }
  return out
}

/**
 * The grounded FORAGE/ACQUIRE candidates: the MINE/MOVE/ACCESS routes to the
 * sensed food-source cells, generated as their own bounded call.
 *
 * Separate from the focus pool on purpose. The measured live starvation ran
 * under a `craft acacia_planks` goal inside an oak/birch forest: folding the
 * food cells into the focus pool would have let the 12-slot mechanical cap
 * consume every slot with focus logs before a single edible block was offered.
 * The same reasoning that keeps the food hunt out of the combat budget applies
 * here - the survival affordance is an ADDITIONAL grounded set for Jev, never a
 * replacement or a re-ranking of the focus's own routes.
 */
function foodForageCandidates(state: WorldState, options: CandidateOptions): Candidate[] {
  const cells = foodRouteCells(state, options)
  if (cells.size === 0) return []
  const keys = new Set(cells.keys())
  return mineCandidates(state, options, null, null, (block) => keys.has(blockCellKey(block.position)))
}

/**
 * The grounded FURNACE-COOK candidates: one executable SMELT per edible smelt
 * output whose input the body already carries, when a furnace it can reach is
 * sensed.
 *
 * The CRAFT half above can only produce a food item that is a crafting recipe
 * (mushroom_stew, bread, cookie, pumpkin_pie). An ingredient the edible truth
 * does not let the body eat raw - `potato` (60% Poison in vanilla, so it is a
 * policy-excluded edible) - is food ONLY after a FURNACE step, and no tier could
 * ever ground it: the same shape the task's "cook an ingredient it carries in a
 * furnace it can reach" names. A raw meat is already edible, so the EAT tier owns
 * it; offering a cook route to a body that already holds food would change the
 * fed body's offer, which the survival contract forbids.
 *
 * The step reuses the smelt path's own station and fuel truth
 * (`directSmeltFurnace`, `smeltFuelFor`, `smeltInventorySufficient`,
 * `fuelCountFor`), so the candidate can never be a SMELT the executor refuses,
 * and its meta is the smelt goal's direct-candidate meta plus the food tags.
 *
 * Reachability is the CAN fact here: no reachable furnace means no route, and
 * `foodSourceGap` then names `no_reachable_furnace` instead of staying silent.
 */
function foodSmeltCandidates(state: WorldState, options: CandidateOptions): Candidate[] {
  const counts = state.inventory.counts
  const out: Candidate[] = []
  for (const [output, input] of Object.entries(FOOD_SMELT_INPUT)) {
    if (!isEdibleFoodItem(output)) continue
    if ((counts[input] ?? 0) <= 0) continue
    const fuelItem = smeltFuelFor(state, input, 1)
    if (fuelItem === null) continue
    const fuelCount = fuelCountFor(1, fuelItem)
    if (!smeltInventorySufficient(counts, input, 1, fuelItem, fuelCount)) continue
    const furnace = directSmeltFurnace(state, options)
    if (furnace === null) continue
    out.push({
      id: `SMELT:${output}`,
      kind: 'SMELT',
      label: `smelt 1x ${output} from ${input} in the furnace at (${furnace.x},${furnace.y},${furnace.z}) using ${fuelItem} so the body can eat`,
      targetName: output,
      target: furnace,
      targetEntityId: null,
      itemName: output,
      requiresTool: false,
      toolName: null,
      inReach: distance(furnace, state.self.eyePosition) <= options.reach,
      hasStandableAdjacent: true,
      meta: {
        tick: state.tick,
        furnaceX: furnace.x,
        furnaceY: furnace.y,
        furnaceZ: furnace.z,
        inputItem: input,
        inputCount: 1,
        fuelItem,
        fuelCount,
        outputItem: output,
        count: 1,
        ...(state.signals.heldFurnacePlacedAt === blockId('b', furnace) ? { furnaceSource: 'held' } : {}),
        foodRoute: 'cook',
        foodTarget: output,
      },
    })
    if (out.length >= FOOD_COOK_CAP) break
  }
  return out
}

/** True when a held item is a furnace input for an edible output (the smelt-cook link). */
function hasSmeltableFoodIngredient(state: WorldState): boolean {
  const counts = state.inventory.counts
  return Object.entries(FOOD_SMELT_INPUT).some(
    ([output, input]) => isEdibleFoodItem(output) && (counts[input] ?? 0) > 0,
  )
}

/**
 * The bounded, typed "a hungry body has no grounded route to food" fact.
 *
 * Descriptive only: it lists which affordances ARE grounded (`offered`), which
 * ones are missing, and what the world still affords as a next step. It never
 * picks an action and never ranks one. Null for a fed body or as soon as any
 * route is on offer, so a healthy resident never emits the marker.
 */
export function foodSourceGap(
  state: WorldState,
  options: CandidateOptions,
  candidates: readonly Candidate[],
): FoodSourceGap | null {
  const hungry = bodyHungry(state, options)
  if (!hungry) return null
  const held = pickFood(state)
  const offered = [
    ...(held === null ? [] : ['eat']),
    ...candidates
      .filter((candidate) => typeof candidate.meta.foodRoute === 'string')
      .map((candidate) => String(candidate.meta.foodRoute)),
  ]
  const uniqueOffered = [...new Set(offered)].sort()
  if (uniqueOffered.length > 0) return null
  const huntRange = options.foodHuntRange ?? DEFAULT_FOOD_HUNT_RANGE
  const sensedAnimal = state.entities.some(
    (entity) => !entity.hostile && FOOD_ANIMALS.has(entity.name) && entity.distance <= huntRange,
  )
  const sensedEdibleBlock = state.blocks.some((block) => block.foodRoute === 'forage')
  // The ACQUIRE tier counts only when the sensed ingredient really would
  // complete an edible recipe: a mushroom with no plan is not a route, so the
  // marker must not report `source_withheld` for it.
  const sensedIngredientBlock = state.blocks.some(
    (block) =>
      block.foodRoute === 'acquire' &&
      typeof block.foodItem === 'string' &&
      foodIngredientCompletesRecipe(state, options, block.foodItem),
  )
  // Both cook halves are read off the RAW link facts, not restated as `false` and
  // not read off the offered set: a recipe the live inventory can complete exists
  // whether or not the reachability gate (or the missing station/fuel
  // precondition) let its step through, and reporting `cookableRecipe=false`
  // about a body that holds the ingredients is exactly the kind of untruth this
  // marker exists to prevent.
  const smeltableIngredient = hasSmeltableFoodIngredient(state)
  const cookableRecipe =
    smeltableIngredient || foodCookCandidates(state, options).length > 0
  const sensedFurnace = smeltableIngredient && directSmeltFurnace(state, options) !== null
  const sourceExists = sensedAnimal || sensedEdibleBlock || sensedIngredientBlock || cookableRecipe
  return {
    offered: uniqueOffered,
    heldEdible: held !== null,
    sensedAnimal,
    sensedEdibleBlock,
    sensedIngredientBlock,
    cookableRecipe,
    smeltableIngredient,
    sensedFurnace,
    hungry,
    starving: bodyStarving(state.self),
    reason: sourceExists ? 'source_withheld' : 'no_source_sensed',
    missingLink: firstMissingFoodLink({
      heldEdible: held !== null,
      sensedEdibleBlock,
      sensedIngredientBlock,
      sensedAnimal,
      smeltableIngredient,
      sensedFurnace,
      cookableRecipe,
    }),
    next: candidates.some((candidate) => candidate.meta.explore === true) ? 'explore' : 'escalate',
  }
}

/**
 * The decisive missing link, named in route-chain order. Evidence only: it
 * reports which grounded fact is absent, never an action to take.
 */
function firstMissingFoodLink(facts: {
  heldEdible: boolean
  sensedEdibleBlock: boolean
  sensedIngredientBlock: boolean
  sensedAnimal: boolean
  smeltableIngredient: boolean
  sensedFurnace: boolean
  cookableRecipe: boolean
}): FoodSourceMissingLink {
  if (facts.heldEdible) return 'no_edible_held'
  // A source IS sensed and no route is on offer: the missing link is the ROUTE
  // to it (in-reach dig, walk-up stand, column base or dig-access walk). This is
  // the shape that used to be reported as if the world held no food at all.
  if (facts.sensedEdibleBlock || facts.sensedIngredientBlock) return 'no_route_to_sensed_source'
  if (facts.smeltableIngredient && !facts.sensedFurnace) return 'no_reachable_furnace'
  if (facts.cookableRecipe) return 'no_cookable_recipe'
  return 'no_edible_source_sensed'
}

/**
 * The grounded COOK candidates: one executable next step per edible recipe the
 * live inventory can actually complete. The step is the same
 * `planNextCraftStep`/`craftPlanStepCandidate` pair the craft path uses, so the
 * candidate can never be a craft the executor would refuse, and the meta carries
 * `foodRoute=cook` so the survival restriction and the run log can name it.
 */
function foodCookCandidates(state: WorldState, options: CandidateOptions): Candidate[] {
  const recipes = options.recipes ?? null
  if (recipes === null) return []
  const counts = state.inventory.counts
  const out: Candidate[] = []
  for (const result of edibleRecipeResults(recipes)) {
    const tableAvailable = sensedCraftingTableAvailable(state, options, result)
    const plan = planNextCraftStep(recipes, result, counts, tableAvailable, 1)
    if (plan.op === null) continue
    const step = craftPlanStepCandidate(state, options, plan.op, `food:${result}`)
    if (step.candidate === null) continue
    out.push({
      ...step.candidate,
      meta: { ...step.candidate.meta, foodRoute: 'cook', foodTarget: result },
    })
    if (out.length >= FOOD_COOK_CAP) break
  }
  return out
}

/** Bounded: one prerequisite step per tick, so the offer cannot be crowded. */
const COMBAT_KIT_CANDIDATE_CAP = 1

/**
 * The grounded PREREQUISITE for a required kill the body's kit cannot win.
 *
 * M3's two remaining items are both mob drops (`blaze_rod` <- blaze,
 * `ender_pearl` <- enderman). A required kill is not the same mechanical
 * situation as "a hostile is on the body": the body must close and trade hits
 * until the mob dies. Measured live (`run-muc3qbug-18vg3`, arrival in the
 * Nether) the body had no armour and no sword, so the offered "route" was
 * `hunt blaze ... with bare fists` - a route any post-mortem would read as a
 * capability. This enumerates the grounded step that would make the kill
 * winnable instead: the best sword the LIVE inventory can produce right now,
 * through the same `planNextCraftStep`/`craftPlanStepCandidate` pair every other
 * craft route uses, so a candidate can never be a craft the executor refuses.
 *
 * CAN only: the ATTACK stays on offer and Jev owns whether to fight or arm
 * first. The typed `COMBAT_KIT_GAP` fact is computed from the OFFERED set
 * (`combatKitGap`), so it can never claim a missing prerequisite while this
 * route is on offer.
 */
function combatKitPrerequisiteCandidates(
  state: WorldState,
  options: CandidateOptions,
  target: string,
): Candidate[] {
  const recipes = options.recipes ?? null
  if (recipes === null) return []
  const counts = state.inventory.counts
  const out: Candidate[] = []
  for (const sword of CRAFTABLE_SWORDS) {
    if (gearWeaponDamage(sword) === null) continue
    const plan = planNextCraftStep(
      recipes,
      sword,
      counts,
      sensedCraftingTableAvailable(state, options, sword),
      1,
    )
    if (plan.op === null) continue
    const step = craftPlanStepCandidate(state, options, plan.op, `combat:${sword}`)
    if (step.candidate === null) continue
    out.push({
      ...step.candidate,
      meta: { ...step.candidate.meta, combatKit: 'sword', combatWeapon: sword, combatTarget: target },
    })
    if (out.length >= COMBAT_KIT_CANDIDATE_CAP) break
  }
  return out
}

/** The typed `COMBAT_KIT_GAP` evidence for one required kill, or null. */
export interface CombatKitGapEvidence {
  focus: string
  target: string
  distance: number | null
  assessment: CombatKitAssessment
  heldItem: string | null
  /** the grounded sword/armour route on offer, or null when none is */
  prerequisite: string | null
}

/**
 * The typed fact that the active collect goal needs a kill the body's kit cannot
 * win, plus whichever prerequisite route the tick actually offers.
 *
 * Computed from the OFFERED set (like `foodSourceGap`), never from the raw one:
 * a gap is only reported when the route that would close it is genuinely absent.
 * Null when the focus item has no mob producer, no producer is sensed, or the
 * kit is sufficient.
 */
export function combatKitGap(
  state: WorldState,
  offered: readonly Candidate[],
): CombatKitGapEvidence | null {
  const current = state.goalQueue?.current ?? null
  const goalKind = current?.kind ?? 'collect'
  const focusItem = current?.targetItem ?? state.goal.targetItem ?? null
  if (focusItem === null || goalKind !== 'collect') return null
  const producers = MOB_DROP_PRODUCERS[focusItem]
  if (producers === undefined) return null
  const target = state.entities.find((entity) => producers.has(entity.name)) ?? null
  if (target === null) return null
  const heldItem = state.self.heldItem?.name ?? null
  const assessment = assessCombatKit({
    heldItem,
    carried: state.inventory.counts,
    worn: state.self.armor ?? {},
    health: state.self.health,
    food: state.self.food,
  })
  if (!assessment.insufficient) return null
  // The reported prerequisite must be a route that CLOSES a reported gap. A sword
  // craft is a prerequisite only while `sword` is missing; an armour gap is closed
  // by wearing a carried piece, or by the armour CRAFT that produces one when
  // nothing wearable is carried (the measured live arrival kit: iron in the
  // inventory, no armour on the body - the craft is the only route that closes
  // it, and it is what the marker now names). Otherwise the marker would name a
  // prerequisite that cannot close the gap it is printed next to.
  const prerequisite =
    (assessment.missing.includes('sword')
      ? offered.find((candidate) => candidate.meta.combatKit === 'sword')?.id
      : undefined) ??
    (assessment.missing.includes('armor')
      ? (offered.find((candidate) => candidate.kind === 'EQUIP' && candidate.meta.slot !== 'hand')?.id ??
        offered.find((candidate) => candidate.meta.armorCraft === true)?.id)
      : undefined) ??
    null
  return {
    focus: focusItem,
    target: target.name,
    distance: target.distance,
    assessment,
    heldItem,
    prerequisite,
  }
}

/**
 * Armor-equip affordance. For every carried armor piece that is STRICTLY better
 * than what is worn in its slot, offer one EQUIP candidate to that slot's
 * destination. This is CAN enumeration: the generator reports the mechanically
 * possible equips and Jev chooses whether to take one; a piece that is only
 * equal-or-worse than what is worn yields no candidate (no churn). The executor
 * owns the post-condition (the piece is actually worn).
 */
function armorEquipCandidates(state: WorldState): Candidate[] {
  return armorEquipOffers(state.self.armor, state.inventory.counts).map((offer) => ({
    id: `EQUIP:${offer.slot}:${offer.itemName}`,
    kind: 'EQUIP' as const,
    label: `equip ${offer.itemName} to ${offer.slot} (currently worn: ${offer.replaced ?? 'none'})`,
    targetName: offer.itemName,
    target: null,
    targetEntityId: null,
    itemName: offer.itemName,
    requiresTool: false,
    toolName: null,
    inReach: true,
    hasStandableAdjacent: true,
    meta: {
      tick: state.tick,
      slot: offer.slot,
      itemName: offer.itemName,
      replaced: offer.replaced ?? 'none',
      itemTier: offer.itemTier,
      wornTier: offer.wornTier,
    },
  }))
}

/**
 * The armour items the live data version can produce, memoized per `RecipeIndex`
 * (immutable). 1.21.11 produces 21 of them (`leather`/`golden`/`iron`/`diamond`
 * per slot plus `turtle_helmet`, and the `copper_*` set, which `armorTier`
 * refuses). `chainmail_*` and `netherite_*` have no crafting recipe in the
 * registry, so they are absent here rather than guessed at.
 */
const armorItemCache = new WeakMap<RecipeIndex, string[]>()
function producibleArmorItems(recipes: RecipeIndex): readonly string[] {
  const cached = armorItemCache.get(recipes)
  if (cached !== undefined) return cached
  const items = (recipes.resultItems?.() ?? []).filter((name) => armorSlotFor(name) !== null)
  armorItemCache.set(recipes, items)
  return items
}

/** `have` for one craft need: the exact item, or every item of its class. */
function craftNeedHave(need: CraftIngredientNeed, counts: Readonly<Record<string, number>>): number {
  return need.cls === null ? inventoryCount(counts, need.item) : inventoryClassCount(counts, need.cls)
}

/** The material a craft need names: its class (`planks`) or its concrete item. */
function craftNeedName(need: CraftIngredientNeed): string {
  return need.cls ?? need.item
}

/** One tick's armour-craft affordance: the grounded steps plus the typed shortfalls. */
interface ArmorCraftScan {
  candidates: Candidate[]
  refusals: ArmorCraftRefusal[]
}

/**
 * ARMOUR CRAFT: "craft the armour you can afford from what you carry, and wear
 * it", as a capability CLASS rather than an iron-armour special case.
 *
 * For every armour piece the LIVE data version can produce whose slot is empty
 * or under-armoured (`armorCraftTargets`, armour truth), ask the SAME recipe
 * machinery every other craft route uses (`planNextCraftStep` over
 * `RecipeIndex`, recipe legality) whether the whole ingredient chain is
 * reachable from the live inventory. When it is, the step is emitted through the
 * SAME `craftPlanStepCandidate` the craft path uses, so a candidate can never be
 * a craft the executor refuses; the EQUIP affordance then wears the piece on a
 * following tick, because `armorEquipOffers` reads the inventory.
 *
 * Nothing here names a material or a slot preference: leather from cow drops,
 * gold from nether_gold_ore, iron, diamond and turtle scutes all travel this one
 * path, and a single affordable piece is offered exactly like a full set. Which
 * affordable piece to craft is Jev's choice; whether the body is dressed at all
 * is code's fact.
 *
 * When the step is NOT affordable the tick says WHY with the material and the
 * exact count (`insufficient_material`), or names the station instead
 * (`no_station`) - never a silent "no armour" while `COMBAT_KIT_GAP` reports
 * `prerequisite=none`. A refusal is only emitted when the body actually holds
 * some of the recipe's own ingredient: a body that carries none of that material
 * has nothing to be short OF, and inventing a material would be a guess.
 */
function armorCraftCandidates(state: WorldState, options: CandidateOptions): ArmorCraftScan {
  const recipes = options.recipes ?? null
  if (recipes === null) return { candidates: [], refusals: [] }
  const targets = armorCraftTargets({ worn: state.self.armor, producible: producibleArmorItems(recipes) })
  if (targets.length === 0) return { candidates: [], refusals: [] }
  const counts = state.inventory.counts
  const candidates: Candidate[] = []
  const refusals: ArmorCraftRefusal[] = []
  for (const target of targets) {
    const variants = recipes.recipesFor(target.itemName)
    if (variants.length === 0) continue
    const tableAvailable = sensedCraftingTableAvailable(state, options, target.itemName)
    const plan = planNextCraftStep(recipes, target.itemName, counts, tableAvailable, 1)
    const selection = selectCraftIngredients(variants, counts)
    const step = plan.op === null ? null : craftPlanStepCandidate(state, options, plan.op, `armor:${target.itemName}`)
    if (step !== null && step.candidate !== null) {
      const primary = selection?.needs[0] ?? null
      candidates.push({
        ...step.candidate,
        meta: {
          ...step.candidate.meta,
          // The armour facts the typed `ARMOR_CRAFT` evidence is computed from.
          armorCraft: true,
          armorSlot: target.slot,
          armorTier: target.tier,
          armorWorn: target.worn ?? 'none',
          armorMaterial: primary === null ? 'none' : craftNeedName(primary),
          armorNeed: primary?.count ?? 0,
          armorHave: primary === null ? 0 : craftNeedHave(primary, counts),
        },
      })
      continue
    }
    const refused = armorCraftRefusal(target, selection, counts)
    if (refused !== null) refusals.push(refused)
  }
  return { candidates, refusals }
}

/**
 * The typed shortfall for one armour piece the plan could not step toward, or
 * null when the body holds none of the material that would be short (see
 * `armorCraftCandidates`).
 */
function armorCraftRefusal(
  target: ArmorCraftTarget,
  selection: { needs: CraftIngredientNeed[]; missing: CraftIngredientNeed[] } | null,
  counts: Readonly<Record<string, number>>,
): ArmorCraftRefusal | null {
  if (selection === null) return null
  const missing = selection.missing[0] ?? null
  if (missing === null) {
    // Every ingredient is held: what stopped the plan is the station chain (the
    // measured shape: 8 iron, no reachable crafting_table, plan reason
    // `no satisfiable recipe for crafting_table`). Reported only when the body
    // actually holds an ingredient of this recipe, so an irrelevant slot is
    // never named.
    if (!selection.needs.some((need) => craftNeedHave(need, counts) > 0)) return null
    return {
      slot: target.slot,
      itemName: target.itemName,
      material: null,
      need: 0,
      have: 0,
      shortfall: 0,
      reason: 'no_station',
      worn: target.worn,
    }
  }
  const have = craftNeedHave(missing, counts)
  if (have <= 0) return null
  return {
    slot: target.slot,
    itemName: target.itemName,
    material: craftNeedName(missing),
    need: missing.count,
    have,
    shortfall: Math.max(0, missing.count - have),
    reason: 'insufficient_material',
    worn: target.worn,
  }
}

/**
 * The ARM affordance as candidates: one `EQUIP:hand:<item>` per carried weapon
 * that out-damages the item in hand, at most one per weapon class, and nothing at
 * all while no fight is on the table or the hand already holds a carried weapon.
 *
 * The candidate is an ordinary `EQUIP` (the executor equips the NAMED item and
 * verifies the live main hand), so it travels the same guard (`policy.ts`
 * `guardEquip`), the same effect envelope (`executor.ts` `assertEffect`) and the
 * same actuation lease as every other equip. It is `slot: 'hand'`, which is what
 * distinguishes it from the armor destinations.
 */
export function weaponArmCandidates(state: WorldState, fightOnTheTable: boolean): Candidate[] {
  if (!fightOnTheTable) return []
  const held = state.self.heldItem?.name ?? null
  return weaponArmOffers(held, state.inventory.counts).map((offer) => ({
    id: `EQUIP:hand:${offer.itemName}`,
    kind: 'EQUIP' as const,
    label:
      `hold ${offer.itemName} (${offer.damage} damage) instead of ${offer.replaced ?? 'an empty hand'} ` +
      `(${offer.klass}: a fight is on the table)`,
    targetName: offer.itemName,
    target: null,
    targetEntityId: null,
    itemName: offer.itemName,
    requiresTool: false,
    toolName: null,
    inReach: true,
    hasStandableAdjacent: true,
    meta: {
      tick: state.tick,
      slot: 'hand',
      itemName: offer.itemName,
      replaced: offer.replaced ?? 'none',
      weaponDamage: offer.damage,
      weaponClass: offer.klass,
      heldDamage: offer.heldDamage,
      weaponArm: true,
    },
  }))
}

function generateRawCandidates(
  state: WorldState,
  options: CandidateOptions = defaultCandidateOptions,
  digRefusals: DigRouteRefusalSink = [],
): RawCandidatesResult {
  let candidates: Candidate[] = []
  let containerRefusals: ContainerRefusal[] = []
  let placeRefusal: PlaceRefusal | null = null
  let ignitionRefusal: IgnitionRefusal | null = null
  let entryRefusal: PortalEntryRefusal | null = null
  let prospect: ProspectResult = { candidates: [], refusal: null }
  const armorRefusals = armorEquipRefusals(state.self.armor, state.inventory.counts)
  const armorCraftRefusals: ArmorCraftRefusal[] = []
  const current = state.goalQueue?.current ?? null
  const focusItem = current === null ? (state.goal.targetItem ?? null) : current.targetItem
  const goalKind = current?.kind ?? 'collect'
  const strategy = current?.strategy ?? null
  const descendTargetY = current?.kind === 'descend' ? (current.targetY ?? null) : null

  switch (goalKind) {
    case 'goto': {
      const target = current?.targetPosition ?? null
      if (target !== null) {
        candidates.push({
          id: `GOTO:${blockId('p', target)}`,
          kind: 'MOVE',
          label: moveLabel(target, 'return to the code-grounded target', state.self.position),
          targetName: current?.targetPredicate ?? null,
          target,
          targetEntityId: null,
          itemName: null,
          requiresTool: false,
          toolName: null,
          inReach: distance(target, state.self.position) <= options.reach,
          hasStandableAdjacent: true,
          meta: {
            tick: state.tick,
            x: target.x,
            y: target.y,
            z: target.z,
            groundedGoto: true,
            ...(current?.targetPredicate === undefined ? {} : { targetPredicate: current.targetPredicate ?? '' }),
          },
        })
      }
      break
    }
    case 'explore':
      candidates.push(...exploreFallbackCandidates(state, options, null, goalKind))
      break
    case 'craft': {
      const craft = craftCandidates(state, options, focusItem)
      candidates.push(...craft.candidates)
      placeRefusal = craft.placeRefusal
      break
    }
    case 'smelt':
      candidates.push(...smeltCandidates(state, options, focusItem))
      break
    case 'place': {
      candidates.push(...placeCandidates(state, options, focusItem))
      const ignition = ignitionCandidates(state, options)
      candidates.push(...ignition.candidates)
      ignitionRefusal = ignition.refusal
      const entry = entryCandidates(state, options, digRefusals)
      candidates.push(...entry.candidates)
      entryRefusal = entry.refusal
      break
    }
    default:
      candidates.push(...mineCandidates(state, options, focusItem, descendTargetY))
      // The exposure dig the descend arm cannot offer by itself: a body carving a
      // 1-wide staircase removes only its own path, so a producer sensed in the
      // wall beside it has no stand, is not pickup-adjacent, and is never the
      // block any offered step digs. Enumerated AFTER the mine/descend family and
      // ALONGSIDE it - never replacing the step, never ranked above it.
      prospect = prospectCandidates(state, options, focusItem, descendTargetY)
      candidates.push(...prospect.candidates)
      break
  }

  // The container family (see `containerCandidates`). A container is a supply
  // source of UNKNOWN content, so the OPEN probe is offered only while the goal
  // has grounded NOTHING of its own this tick (or there is no focus item at
  // all); a container whose contents were OBSERVED offers one ordinary WITHDRAW
  // step per stack, tagged as a producer when the stack is the focus item. This
  // is CAN enumeration appended alongside every other family - never an
  // override, never a rank, and never a claim about what is inside.
  const goalHasGroundedRoute = focusItem !== null && candidates.some((candidate) => hasAdvancingGoalRoute(candidate))
  // An UNOPENED container is offered whenever it is reachable, not only when the
  // current goal lacks a route of its own. Its contents are unknown, so opening it
  // is a bounded, reversible INSPECTION rather than a commitment to a strategy -
  // and it is self-limiting: once opened, the observation is recorded and this arm
  // stops offering it (see `containerObservationAt`). The operator asked for the
  // supplied container beside the Nether gate to be usable, and restricting the
  // offer to "the goal has no route" made it invisible to a body that always has
  // one. Jev still chooses; code ranks nothing.
  const environment = containerCandidates(state, options, focusItem, true)
  candidates.push(...environment.candidates)
  containerRefusals = environment.refusals

  // A `surface` goal's vertical route (the leg the goal exists for). Computed
  // here so the typed refusal is available even when the family offers nothing,
  // and appended after the explore fallback below so the level-move enumeration
  // and the clearance filter are unchanged: CAN enumeration, never an override
  // and never a rank.
  const surfaceAscent = surfaceAscentCandidates(state, options)
  // A low-air body must have an upward waypoint even when the active Option is
  // unrelated to surface recovery. The sensor proves a contiguous vertical
  // water/air column; Jev still chooses which waypoint.
  const submersionAscent = submersionAscentCandidates(state, options)
  // The hungry body's vertical route to where passive animals can exist. Same
  // CAN enumeration: appended alongside every other candidate, never an override
  // and never a rank.
  const foodHabitat = foodHabitatAscent(state, options)

  if (strategy === 'explore_cave') {
    const explore = pickExplore(
      state,
      state.terrain.standable,
      focusItem,
      options.moveFailureLimit ?? DEFAULT_CANDIDATE_MOVE_FAILURE_LIMIT,
      options.blacklistedMoveTargets,
    )
    if (explore !== null) {
      candidates.unshift({
        id: `EXPLORE_CAVE:${blockId('p', explore)}`,
        kind: 'MOVE',
        label: moveLabel(explore, 'explore a cave frontier', state.self.position),
        targetName: null,
        target: explore,
        targetEntityId: null,
        itemName: null,
        requiresTool: false,
        toolName: null,
        inReach: distance(explore, state.self.position) <= options.reach,
        hasStandableAdjacent: true,
        meta: { tick: state.tick, x: explore.x, y: explore.y, z: explore.z, strategy },
      })
    }
  }
  if (strategy === 'branch_mine') {
    candidates = candidates.map((candidate) =>
      candidate.kind === 'MINE' || candidate.kind === 'MOVE' || candidate.kind === 'DESCEND'
        ? { ...candidate, id: `BRANCH_MINE:${candidate.id}`, meta: { ...candidate.meta, strategy } }
        : candidate,
    )
  } else if (strategy === 'return_to_known_ore') {
    candidates = candidates.map((candidate) =>
      candidate.kind === 'RETRIEVE' ? { ...candidate, id: `RETURN_TO_KNOWN_ORE:${candidate.id}`, meta: { ...candidate.meta, strategy } } : candidate,
    )
  }

  const localHostiles = state.entities.filter(
    (entity) => isAttackableEntity(entity) && entity.distance <= COMBAT_CANDIDATE_RANGE,
  )
  // P1 durability (measured `run-mucgir1z-1p7oh`): the 8 m danger bound is the
  // MELEE reaction envelope, and using it as the ATTACK offer bound left an
  // ENGAGED attacker unanswerable. A skeleton that had already put an arrow in
  // the body at 8.93 m - inside its own firing band, outside melee and outside
  // the danger radius - produced no ATTACK at all, so the only grounded response
  // in the Nether portal room was "keep distance", and the only keep-distance
  // cells were the portal itself (`the_nether -> overworld -> the_nether`).
  //
  // An entity that has ENGAGED the body (`isResponseWorthyThreat`: attributed
  // attacker, or line of sight after damage) is therefore attackable anywhere
  // inside the response envelope (`THREAT_RESPONSE_RANGE`) - the same envelope
  // `activeThreats` and the bounded danger state already answer to. This is CAN,
  // not a preference: the approach is grounded separately by the reachability
  // gate's melee path probe (`evaluateOrdinaryAttackCandidate`), so an attacker
  // the body cannot reach is withheld with a typed reason, and Jev still chooses
  // ATTACK vs any keep-distance route vs ESCALATE.
  //
  // The engaged set is kept OUT of the ordinary `maxAttackCandidates` budget for
  // the same reason the goalDrop producers are (see below): a distant attacker
  // must not crowd a local food hunt or a reaction target out of Jev's candidate
  // set. It is an additional grounded affordance, never a replacement.
  const engagedHostiles = state.entities.filter(
    (entity) =>
      isAttackableEntity(entity) &&
      entity.distance > COMBAT_CANDIDATE_RANGE &&
      isResponseWorthyThreat(state, entity, state.timestampMs),
  )
  // Goal-directed mob drops: when the ACTIVE goal still needs an item whose only
  // producer is a mob (`blaze_rod` <- blaze, `ender_pearl` <- enderman), expose
  // every sensed producer as a grounded ATTACK candidate. This is producer truth
  // (CAN), never a preference: Jev still owns WHICH producer/action to pursue,
  // and the `goalDrop` meta is what makes the executor verify a real kill plus
  // the wanted drop (see `runAttack`).
  //
  // The need is the goal's OWN bill of materials, not the focus item's name:
  // the earlier `goalKind !== 'collect'` gate meant the terminal `craft 12 x
  // ender_eye` goal withheld every hunt, so its ingredient descent to
  // `blaze_rod`/`ender_pearl` (a mob drop with no block source) could offer only
  // MINE/RETRIEVE on fortress fabric - a chain that crosses two producer kinds
  // (recipe -> mob drop) had no route at its mob end. `mobDropNeedsForGoal` is
  // the same recipe truth for every goal kind, so `collect blaze_rod` keeps
  // exactly its old offer.
  const requiredCount = Math.max(1, Math.floor(state.goalQueue?.current?.requiredCount ?? 1))
  const mobDropNeeds = mobDropNeedsForGoal(focusItem, requiredCount, options.recipes ?? null, state.inventory.counts)
  const goalDropByEntity = new Map<number, string>()
  const goalDropTargets: EntityState[] = []
  for (const entity of state.entities) {
    const drop = producerDropFor(entity.name)
    if (drop === null || !mobDropNeeds.includes(drop)) continue
    goalDropByEntity.set(entity.id, drop)
    goalDropTargets.push(entity)
  }
  // Food acquisition: when the resident is hungry (at or below `eatBelowFood`)
  // and holds no food, offer the grounded ATTACK affordance for every sensed
  // passive food animal so Jev can choose to hunt. Code only reports CAN (a real
  // sensed entity); the choice of WHICH action/target stays with Jev. The range
  // is the sensor's entity radius, not the 8m melee range, because the ATTACK
  // executor already paths to the entity with GoalFollow.
  const heldFood = pickFood(state)
  const hungry = state.self.food <= options.eatBelowFood
  const foodHuntRange = options.foodHuntRange ?? DEFAULT_FOOD_HUNT_RANGE
  const huntTargets =
    heldFood === null && hungry
      ? state.entities.filter(
          (entity) => !entity.hostile && FOOD_ANIMALS.has(entity.name) && entity.distance <= foodHuntRange,
        )
      : []
  // The ordinary combat budget bounds local reaction candidates only. A sensed
  // producer for the ACTIVE collect Option is an additional grounded affordance,
  // not a semantically preferred occupant of that budget. Keeping the two sets
  // independent prevents code from deciding WHICH by crowding either a safety
  // threat or a goal producer out of Jev's candidate set.
  const seenAttackIds = new Set<number>()
  const attackTargets = [...localHostiles, ...huntTargets]
    .filter((entity) => {
      if (seenAttackIds.has(entity.id)) return false
      seenAttackIds.add(entity.id)
      return true
    })
    .slice(0, options.maxAttackCandidates)
  for (const producer of goalDropTargets) {
    if (seenAttackIds.has(producer.id)) continue
    seenAttackIds.add(producer.id)
    attackTargets.push(producer)
  }
  // Engaged attackers beyond the melee reaction envelope: the response the
  // measured Nether skeleton had no candidate for at 8.93 m. Same treatment as
  // the goalDrop producers - an independent grounded affordance.
  for (const engaged of engagedHostiles) {
    if (seenAttackIds.has(engaged.id)) continue
    seenAttackIds.add(engaged.id)
    attackTargets.push(engaged)
  }
  // The body's own capability facts for a fight. Code owns CAN: which item the
  // body is holding (fists are a weapon too), its vanilla damage when this
  // module can pin it, whether the body can heal between hits at all (natural
  // regeneration needs food >= 18; the measured resident held food 0-2 for the
  // whole attrition window and never executed a single EAT), and - measured live
  // in the fatal 10:49 window - the weapon the ATTACK LEASE will actually swing.
  // The lease arms the best carried weapon before the first swing
  // (`executor.ts` `equipCombatWeapon`), so a candidate that reported only the
  // held `stone_pickaxe` while a `diamond_sword` sat in the inventory described a
  // weaker fight than the one Jev was choosing. These are reported on the ATTACK
  // candidate and never used to rank it away: Jev still chooses ATTACK versus
  // keep-distance versus escalate.
  const weapon = weaponFacts(state.self.heldItem?.name ?? null)
  const swing = combatSwingFor(state.self.heldItem?.name ?? null, state.inventory.counts)
  const body = bodySurvivalFacts(state.self)
  for (const entity of attackTargets) {
    const isFoodTarget = huntTargets.includes(entity)
    const goalDrop = goalDropByEntity.get(entity.id) ?? null
    // The label states the fight the LEASE will run, not only what the hand holds
    // right now: `with diamond_sword (armed on attack from stone_pickaxe)`.
    const armNote =
      swing.willArm === null
        ? null
        : ` (armed on attack from ${state.self.heldItem?.name ?? 'an empty hand'})`
    const weaponNote = swing.itemName === null ? 'with bare fists' : `with ${swing.itemName}${armNote ?? ''}`
    candidates.push({
      id: `ATTACK:e${entity.id}`,
      kind: 'ATTACK',
      label:
        goalDrop === null
          ? `attack ${entity.name} ${entity.distance}m away at (${entity.position.x},${entity.position.y},${entity.position.z}) ${weaponNote}`
          : `hunt ${entity.name} ${entity.distance}m away for ${goalDrop} at (${entity.position.x},${entity.position.y},${entity.position.z}) ${weaponNote}`,
      targetName: entity.name,
      target: entity.position,
      targetEntityId: entity.id,
      itemName: goalDrop,
      requiresTool: false,
      toolName: null,
      inReach: entity.distance <= options.reach,
      hasStandableAdjacent: true,
      meta: {
        tick: state.tick,
        entityId: entity.id,
        distance: entity.distance,
        // Typed CAN facts: what the body swings with, and whether it can heal
        // the damage it is about to trade. Never a preference.
        weapon: weapon.label,
        weaponKind: weapon.kind,
        ...(weapon.name === null ? {} : { weaponItem: weapon.name }),
        ...(weapon.damage === null ? {} : { weaponDamage: weapon.damage }),
        // The swing the lease will actually run once it arms the best carried
        // weapon, and the item that arming will displace. Absent when the hand
        // already holds the best carried weapon (no churn, no new fact).
        ...(swing.willArm === null
          ? {}
          : {
              swingItem: swing.willArm,
              swingDamage: swing.damage,
              armOnAttackFrom: state.self.heldItem?.name ?? 'empty_hand',
            }),
        bodyHealth: body.health,
        bodyFood: body.food,
        bodyRegenerates: body.regenerating,
        ...(goalDrop === null ? {} : { goalDrop, requiresKill: true }),
        // Typed producer facts: this ATTACK is the mob-drop route to `goalDrop`
        // and this instance is a real sensed producer. issue #436 section 9: the
        // committed ENTITY ID is the target for the whole Skill - the bounded hunt
        // re-acquires THAT id across occlusion/teleport and never adopts another
        // instance of the mob, so this candidate is a claim about e<entityId>
        // specifically. Never a preference; Jev still chose it.
        ...(goalDrop === null
          ? {}
          : { producerMob: entity.name, producerRoute: 'mob_drop' as const }),
        // Typed CAN fact: this ATTACK is the grounded route to food, and which
        // animal it targets. The marker reader/log must not infer it from the
        // entity name alone (a hostile and a food animal can share no name).
        ...(isFoodTarget ? { foodAnimal: true, foodRoute: 'animal', foodTarget: entity.name } : {}),
        // issue #436/#11 (operator directive): this candidate exists because the
        // entity is ATTACKABLE and in range - not because a flag said so. The gate
        // consults this fact, never the hostile flag.
        attackable: true,
        // the entity TRUTH Jev reasons with.
        // `hostile` is a fact now, not the gate that created this candidate, and
        // the hostile-only facts below are only meaningful when it is true. NOTHING
        // in code ranks on these - no closest-first, no type preference, no
        // `if hostile then prefer`.
        hostile: entity.hostile,
        ...(entity.hostile ? { targetHostile: true, targetStandoff: threatStandoffRange(entity.name) } : {}),
        // "this entity ENGAGED the body recently" is damage-attribution truth from
        // the sensor (`attackedSelf`), which is what makes a provoked neutral mob
        // (the zombie_villager shape) a legitimate target without a name list.
        ...(entity.attackedSelf === true ? { attackedSelf: true } : {}),
        ...(entity.heldItem === undefined || entity.heldItem === null ? {} : { targetHeldItem: entity.heldItem }),
        ...(entity.activeItemUse == null
          ? {}
          : {
              targetUsingItem: entity.activeItemUse.active,
              targetUseHand: entity.activeItemUse.hand ?? 'none',
              ...(entity.activeItemUse.item === null ? {} : { targetUseItem: entity.activeItemUse.item }),
            }),
        ...(entity.health === undefined || entity.health === null ? {} : { targetHealth: entity.health }),
        ...(entity.lineOfSight === undefined ? {} : { targetLineOfSight: entity.lineOfSight }),
        ...(entity.kind === undefined ? {} : { targetKind: entity.kind }),
        // the drop this entity is a producer for, when it is one (the same
        // producer truth `MOB_DROP_PRODUCERS` already carries)
        ...(producerDropFor(entity.name) === null ? {} : { dropItem: producerDropFor(entity.name) as string }),
        // reachability as a FACT on this candidate (`inReach` above is the melee
        // reach; this is the approach contract the gate already computed)
        reachability: entity.distance <= MELEE_THREAT_REACH ? 'contact' : 'approach',
      },
    })
  }

  // The grounded PREREQUISITE for a required kill the kit cannot win (M3: blaze
  // rod / ender pearl are mob drops). Offered alongside the ATTACK so Jev can
  // choose to arm first instead of trading bare-handed; the typed
  // `COMBAT_KIT_GAP` fact is derived from the OFFERED set by `combatKitGap`.
  if (goalDropTargets.length > 0) {
    const kit = assessCombatKit({
      heldItem: state.self.heldItem?.name ?? null,
      carried: state.inventory.counts,
      worn: state.self.armor ?? {},
      health: state.self.health,
      food: state.self.food,
    })
    if (kit.insufficient) {
      // A sword craft closes the `sword` gap only. Measured live
      // (`buddy.log` 2026-09-22T11:57:25) the marker read
      // `swingDamage=7 armor=0 missing=armor prerequisite=CRAFT:iron_sword` while a
      // `diamond_sword` was already carried - the body was told to craft a weapon
      // it had, when the missing half was armour. The prerequisite is enumerated
      // from the missing half the assessment actually reported.
      if (kit.missing.includes('sword')) {
        candidates.push(
          ...combatKitPrerequisiteCandidates(state, options, goalDropTargets[0]?.name ?? focusItem ?? 'unknown'),
        )
      }
    }
  }

  // The REPOSITION half of a fight whose target sits above the walk envelope: the
  // own-column vertical route to the target's level, offered as an ordinary
  // MOVE-family candidate ALONGSIDE the ATTACK. CAN enumeration only - code says
  // whether a grounded route to that level exists and never ranks it against the
  // fight; Jev chooses. When no route exists the arm returns a typed refusal (see
  // `contactRefusals`), which is what lets the gate withhold the ATTACK BY CAN
  // instead of leasing a target the body provably cannot bring melee onto.
  const contactApproach = contactApproachCandidates(state, options, attackTargets)
  candidates.push(...contactApproach.candidates)

  const foodName = heldFood
  if (foodName !== null && hungry) {
    candidates.push({
      id: `EAT:${foodName}`,
      kind: 'EAT',
      label: `eat ${foodName} (food=${state.self.food})`,
      targetName: foodName,
      target: null,
      targetEntityId: null,
      itemName: foodName,
      requiresTool: false,
      toolName: null,
      inReach: true,
      hasStandableAdjacent: true,
      meta: { tick: state.tick, food: state.self.food },
    })
  }
  // The grounded FORAGE/ACQUIRE routes: the sensed blocks the running data
  // version can turn into food. Measured live (run-muc0l5fp-158ak): the food
  // focus declared no scanned block names, so a starving body in an oak forest
  // had no edible block in the world state at all.
  if (heldFood === null && hungry) candidates.push(...foodForageCandidates(state, options))
  // The grounded COOK route: a recipe the body can actually finish that produces
  // an edible item. Measured live: the starving body held a red_mushroom, so the
  // only way that item could ever become food was mushroom_stew - and no layer
  // ever asked the recipe planner for an edible result. The step comes from the
  // same `planNextCraftStep` the craft path uses, so a candidate exists only when
  // the whole ingredient chain is reachable from the live inventory; Jev owns
  // whether to cook it.
  if (heldFood === null && hungry) candidates.push(...foodCookCandidates(state, options))
  // The grounded FURNACE-COOK route: an ingredient the body carries that only a
  // furnace turns into food (raw_beef -> cooked_beef), offered when a furnace it
  // can reach is sensed. Same gate as the tiers above, so a body that is fed or
  // already holds food sees a byte-identical offer.
  if (heldFood === null && hungry) candidates.push(...foodSmeltCandidates(state, options))

  // Armor-equip affordance: offered alongside the other local self-care actions
  // (EAT/ATTACK/RETREAT), independent of the active goal. The generator reports
  // CAN; Jev owns whether the body puts on better armor this tick.
  candidates.push(...armorEquipCandidates(state))

  // The ARMOUR CRAFT affordance: the missing PRODUCER half of the same self-care
  // pair. The equip affordance can only wear armour that exists, and measured live
  // (NETHER-SURVIVAL-2026-09-22, the fatal window at 33.3 h) no layer ever made
  // any: the body arrived in the Nether with iron ingots and no armour and
  // `COMBAT_KIT_GAP ... missing=[armor] prerequisite=none` named the gap without a
  // route. Crafting is offered with the same standing shape as the equip (any
  // tick, any material the live data version defines, any single piece) because
  // the piece has to exist BEFORE the fight, not during it; it is self-limiting
  // (a piece that would not improve its slot yields no target, so an armoured
  // body stops being offered crafts) and Jev owns whether to spend the material.
  // The typed shortfall when the material is short is carried out as evidence.
  const armorCraft = armorCraftCandidates(state, options)
  candidates.push(...armorCraft.candidates)
  armorCraftRefusals.push(...armorCraft.refusals)

  // The ARM affordance: a carried weapon that out-damages the item in hand, while
  // a fight is on the table this tick. Same CAN shape as the armor offer, and for
  // the same measured reason: measured live (`buddy.log` 2026-09-22T10:49:5x) the
  // hand held a `stone_pickaxe` with a `diamond_sword` in the inventory while the
  // body retreated from a magma_cube, `ATTACK:e45891` was reachable and offered,
  // and Jev chose RETREAT twice - so the only code that could have armed the body
  // (the ATTACK lease's own `equipCombatWeapon`) never ran and the damage race was
  // lost with a pickaxe. Arming is therefore its own grounded action, not a side
  // effect of one kind of action.
  //
  // Offered only while a fight is on the table (a hostile is being answered or an
  // ATTACK is enumerated) so a body mining with a tool never churns its held item;
  // an armed body gets nothing at all (see `weaponArmOffers`).
  candidates.push(...weaponArmCandidates(state, attackTargets.length > 0 || state.signals?.threat?.active === true))

  const danger = nearestDanger(state, HAZARD_DANGER_RADIUS)
  // Every threat the body must answer right now, nearest first: hostiles inside
  // the bounded danger radius (engaged or not) plus response-worthy hostiles
  // inside the response envelope. This is the P1 durability fix (a skeleton
  // shooting from 10m previously produced neither ATTACK nor RETREAT) extended
  // to "a zombie 6m away and closing": the survival offer must be grounded
  // before the first hit, not only after it.
  const responseThreats = activeThreats(state.entities, state.signals.lastDamage ?? null, state.timestampMs)
  const primaryThreat = responseThreats[0] ?? null
  // The attacker the sensor never witnessed, when the damage attribution named
  // one. Its POSITION is the only thing that can ground a directional answer for
  // it; when the attribution carries no position this is null and no destination
  // is invented (the break-contact restriction owns that case).
  const attacker = unsensedAttackerFacts(state)
  const attributedThreat =
    attacker !== null && attacker.position !== null ? { name: attacker.name, position: attacker.position } : null
  const retreats = pickRetreats(
    state,
    state.terrain.standable,
    danger,
    responseThreats,
    options.blacklistedMoveTargets,
    attributedThreat,
  )
  for (const retreat of retreats) {
    const spot = retreat.spot
    const threatName = primaryThreat?.name ?? attributedThreat?.name ?? null
    candidates.push({
      id: `RETREAT:${blockId('p', spot)}`,
      kind: 'RETREAT',
      // The label states the separation the destination ACTUALLY buys. The old
      // "retreat to safety" conflated a 1.4m shuffle with an escape, and the
      // measured body died standing on a spot labelled exactly that way.
      label:
        threatName === null
          ? moveLabel(spot, 'retreat to safety', state.self.position)
          : `${moveLabel(spot, `keep distance from ${threatName}`, state.self.position)} ` +
            `(+${Math.round(retreat.gain * 100) / 100}m separation, ${Math.round(retreat.separation * 100) / 100}m away` +
            `${retreat.outsideReach ? ', outside its reach' : ''}${retreat.occluded ? ', out of its sight line' : ''}${retreat.escape ? ', escape scan' : ''})`,
      targetName: null,
      target: spot,
      targetEntityId: null,
      itemName: null,
      requiresTool: false,
      toolName: null,
      inReach: distance(spot, state.self.position) <= options.reach,
      hasStandableAdjacent: true,
      meta: {
        tick: state.tick,
        x: spot.x,
        y: spot.y,
        z: spot.z,
        separation: Math.round(retreat.separation * 100) / 100,
        separationGain: Math.round(retreat.gain * 100) / 100,
        outsideReach: retreat.outsideReach,
        ...(retreat.escape ? { escapeScan: true } : {}),
        // Code-owned cover fact: this destination is NOT in the threat's sight
        // line (real block truth). It is what makes a ranged attacker answerable
        // when the room gives the body no separation to buy. Jev still chooses
        // whether to take it.
        ...(retreat.occluded ? { threatOccluded: true } : {}),
        // The attacker was NOT in the sensor snapshot: the destination was
        // grounded from the damage attribution's stated origin. Typed so a
        // post-mortem can tell a witnessed retreat from an answered ambush. The
        // origin itself stays off `meta` (which carries scalars only) and travels
        // on `LastDamageEvidence.sourcePosition`.
        ...(attributedThreat !== null && primaryThreat === null
          ? { threatUnsensed: true, threatName: attributedThreat.name }
          : {}),
        ...(primaryThreat === null
          ? {}
          : {
              threatEntityId: primaryThreat.id,
              threatName: primaryThreat.name,
              threatDistance: primaryThreat.distance,
              threatStandoff: threatStandoffRange(primaryThreat.name),
              ...(primaryThreat.attackedSelf === true ? { threatAttackedSelf: true } : {}),
              ...(primaryThreat.heldItem != null ? { threatHeldItem: primaryThreat.heldItem } : {}),
            }),
      },
    })
  }

  // SAFE: the environmental-hazard exits. Ordinary MOVE candidates to real,
  // standable, hazard-free adjacent cells, grounded by the sensor's classified
  // ring. They are offered alongside everything else - Jev still chooses WHICH
  // one is taken - and the controller may execute one directly as a bounded
  // hard-safety reflex only when it is the single grounded route out
  // (`envHazardReflexAction`).
  candidates.push(...envHazardEscapeCandidates(state, options.blacklistedMoveTargets, options.reach))

  // A known-resource retrieval is grounded even when other (non-progressing)
  // candidates exist: if the wanted block is not visible but its coordinate is
  // remembered, going there is strictly better than re-issuing the front goal.
  // Once the active goal already has a grounded route, however, do not admit a
  // retrieval for a later queue row into this Option. That is a different
  // semantic action, not an alternative mechanical route for the active goal;
  // it was observed live as raw_iron -> unrelated future log retrieval.
  candidates.push(...retrievalCandidates(state, options, focusItem, candidates.length === 0, digRefusals))

  // A dropped item the goal can use is on the GROUND: the body must walk onto it
  // (the server picks it up; Mineflayer only observes). This is the route a drop
  // that outlived the bounded executor pickup window otherwise never had. CAN
  // enumeration appended alongside every other family - never an override, never
  // a rank. It is offered for any sensed drop that advances the active focus or
  // its recipe chain, so it is general for every craft/drop chain, not M3's.
  candidates.push(...pickupCandidates(state, options, focusItem))

  // Clearance MINEs are route-opening safety affordances, not semantic goal
  // actions. Once the active goal has another grounded route (for example a
  // remembered raw_iron RETRIEVE), keep the dirt/stone clearance from becoming
  // an unrelated action Jev can select. A clearance-only pocket is unchanged.
  const hasGoalRoute = candidates.some(
    (candidate) =>
      candidate.meta.clearance !== true &&
      candidate.kind !== 'WAIT' &&
      candidate.kind !== 'ESCALATE' &&
      (candidate.kind !== 'ATTACK' || candidate.meta.goalDrop === focusItem) &&
      candidate.kind !== 'RETREAT' &&
      candidate.kind !== 'EAT' &&
      candidate.kind !== 'EQUIP',
  )
  if (hasGoalRoute) candidates = candidates.filter((candidate) => candidate.meta.clearance !== true)

  // A collect focus can name a DECLARED PRODUCER (a name-scanned block source,
  // or a mob whose drop is the item) while the tick offers no grounded route at
  // all: nothing is sensed and nothing is remembered. That is a SEARCH problem,
  // and the general answer is the same exploration/locomotion machinery used
  // anywhere else - enumerate the nearest grounded frontier cells so the body
  // can reach unsensed terrain (where the sensor can then recognise the source).
  // A declared producer is perception truth ("which block/mob to look for"),
  // never a route. This is deliberately producer-agnostic: it covers structure
  // fabric (`blaze_rod` -> Nether fortress body), mob drops (`ender_pearl` ->
  // enderman) and direct block sources (`flint` -> gravel) with the same arm, and
  // it never names a structure or a dimension.
  //
  // SCOPE: resource-class focuses (`log`/`planks`) keep their dedicated
  // surface-explore arm, and ORE sources keep their DESCEND search arm; this only
  // covers the declared DIRECT/mob producers that had none.
  const hasAdvancingRoute = candidates.some(hasAdvancingGoalRoute)
  // The `food` resource class is a declared-producer focus too (its producers are the passive
  // FOOD_ANIMALS), so it needs the same exploration arm as the block/mob-drop producers. It is a
  // resource class, so the plain `!isResourceClass` guard excluded it and a food goal with no animal
  // sensed offered only WAIT (live: health=1 at habitat height, `collect:food 0/3`, candidates =
  // ASCEND:habitat + WAIT, no search route). Keeping this in step with `declaredProducerFocus` means
  // the typed explore-blocked fact and the offered set can never disagree.
  // A focus with a DECLARED producer (a block source, a mob-drop producer, or the food
  // class) must be able to search for that producer. The previous `!isResourceClass`
  // guard excluded every resource-class focus, so an ore goal whose remembered ore was
  // not reachable collapsed to flat MOVEs + WAIT: live, `collect:raw_iron` offered only
  // MOVE:p7_53_-9 / MOVE:p9_53_-10 / MOVE:p10_54_-7 / MOVE:p9_54_-7 / WAIT for 100+ s
  // with 21 remembered raw_iron sites and no MINE/RETRIEVE/DESCEND at all. This mirrors
  // `declaredProducerFocus`, so the typed explore-blocked fact and the offered set agree.
  const declaredProducerNeedsExploration =
    goalKind === 'collect' &&
    descendTargetY === null &&
    focusItem !== null &&
    (focusItem === FOOD_CLASS ||
      DIRECT_BLOCK_SOURCES[focusItem] !== undefined ||
      MOB_DROP_PRODUCERS[focusItem] !== undefined)
  if (candidates.length === 0 || (declaredProducerNeedsExploration && !hasAdvancingRoute)) {
    candidates.push(...exploreFallbackCandidates(state, options, focusItem, goalKind))
  }
  candidates.push(...surfaceAscent.candidates)
  candidates.push(...submersionAscent)
  candidates.push(...foodHabitat.candidates)

  // A stranded body (no standable frontier beyond its own cell) has no walking
  // route at all: expose the bounded, damage-free vertical step down off its own
  // support column through the same DESCEND mechanics the goal-grounded descent
  // already uses. Offered only when the tick has NO other locomotion candidate,
  // so an existing route is never displaced (this is a CAN envelope, not a
  // preference: Jev still owns WHICH of the remaining candidates to take). The
  // typed refusal is returned when even that safe step does not exist, so the
  // tick never falls through to a bare WAIT without a stated cause.
  const hasLocomotionCandidate = candidates.some((candidate) =>
      LOCOMOTION_CANDIDATE_KINDS.has(candidate.kind),
    )
  const columnDescent = hasLocomotionCandidate
    ? { candidates: [], refusal: null }
    : columnDescentCandidates(state, options, focusItem)
  const columnIds = new Set(candidates.map((candidate) => candidate.id))
  for (const candidate of columnDescent.candidates) {
    if (columnIds.has(candidate.id)) continue
    columnIds.add(candidate.id)
    candidates.push(candidate)
  }
  if (columnDescent.refusal?.reason === 'recurrent' && candidates.length === 0) {
    candidates.push(
      descentPolicyEscalateCandidate({
        tick: state.tick,
        reason: 'recurrent_descent_no_alternative',
        outcome: 'RECURRENT_STATE',
        label: 'hand control to System 2 (the only safe column descent is recurrent)',
      }),
    )
  }

  candidates.push({
    id: 'WAIT',
    kind: 'WAIT',
    label: 'do nothing for one tick',
    targetName: null,
    target: null,
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: true,
    hasStandableAdjacent: true,
    meta: { tick: state.tick, waitMs: 300 },
  })

  if (state.signals.escalationRecommended && !candidates.some((candidate) => candidate.kind === 'ESCALATE')) {
    candidates.push({
      id: 'ESCALATE',
      kind: 'ESCALATE',
      label: `request System 2 review (${state.signals.lastFailureCode ?? 'unknown trigger'})`,
      targetName: null,
      target: null,
      targetEntityId: null,
      itemName: null,
      requiresTool: false,
      toolName: null,
      inReach: true,
      hasStandableAdjacent: true,
      meta: { tick: state.tick, reason: state.signals.lastFailureCode ?? 'unknown' },
    })
  }

  return {
    candidates,
    placeRefusal,
    ignitionRefusal,
    entryRefusal,
    armorRefusals,
    armorCraftRefusals,
    surfaceAscentRefusal: surfaceAscent.refusal,
    foodHabitatRefusal: foodHabitat.refusal,
    columnDescentRefusal: columnDescent.refusal,
    contactRefusals: contactApproach.refusals,
    digRefusals: dedupeDigRouteRefusals(digRefusals),
    prospectRefusal: prospect.refusal,
    sourceExclusions: resourceSourceExclusions(state),
    containerRefusals,
  }
}

/** The candidate id of the dig-access MOVE for a block (kind MOVE, explicit prerequisite). */
export function digAccessCandidateId(position: Vec3Json): string {
  return `ACCESS:${blockId('b', position)}`
}

const DIG_ACCESS_REFUSAL_META = 'digAccessRefusal'

function digAccessRefusalOf(candidate: Candidate): DigAccessRefusal | null {
  const value = candidate.meta[DIG_ACCESS_REFUSAL_META]
  return value === 'no_interaction_stand' || value === 'no_path_to_stand' ? value : null
}

/**
 * The #244 interaction-stand geometry generalised to a dig target: the caller's
 * live probe returns the stand from which the block becomes diggable plus the
 * `canDig=false` path verdict. No probe means the generator keeps its existing
 * behavior (the target stays a tunnel target). A reachable stand is offered as
 * an ACCESS MOVE; otherwise the typed refusal retires the target explicitly.
 */
function digAccessFor(
  state: WorldState,
  options: CandidateOptions,
  block: BlockState,
): { stand: Vec3Json | null; refusal: DigAccessRefusal | null } {
  const probe = options.reachability?.digApproach ?? null
  if (probe === null) return { stand: null, refusal: null }
  const fact = probe(block.position)
  if (fact.approach !== null && fact.path !== 'no_path') return { stand: fact.approach, refusal: null }
  return { stand: null, refusal: fact.approach === null ? 'no_interaction_stand' : 'no_path_to_stand' }
}

function digAccessMove(
  state: WorldState,
  block: BlockState,
  stand: Vec3Json,
  /** the sensed food route this dig-access walk serves, when it is one (see `columnDigMine`) */
  foodTag: { route: 'forage' | 'acquire'; item: string } | null = null,
): Candidate {
  const harvestTool = block.harvestTool ?? null
  return {
    id: digAccessCandidateId(block.position),
    kind: 'MOVE',
    label: `walk to the dig-access stand at (${stand.x},${stand.y},${stand.z}) so ${block.name} at (${block.position.x},${block.position.y},${block.position.z}) becomes in reach and diggable`,
    targetName: block.name,
    target: stand,
    targetEntityId: null,
    itemName: null,
    requiresTool: harvestTool !== null,
    toolName: harvestTool,
    toolTier: block.harvestTier ?? null,
    inReach: false,
    hasStandableAdjacent: true,
    meta: {
      tick: state.tick,
      x: stand.x,
      y: stand.y,
      z: stand.z,
      diggable: block.diggable,
      yieldItem: block.yield ?? block.name,
      digAccess: true,
      targetBlockX: block.position.x,
      targetBlockY: block.position.y,
      targetBlockZ: block.position.z,
      targetBlockName: block.name,
      ...(foodTag === null ? {} : { foodRoute: foodTag.route, foodTarget: foodTag.item }),
    },
  }
}

/**
 * The explicit retirement of a dig target with no reachable access. The target is
 * not presented: the affordance gate withholds it with the typed reason carried
 * here and records the state fingerprint, so it is not silently re-offered every
 * tick while the relevant facts are unchanged.
 */
function digAccessRetirement(state: WorldState, block: BlockState, refusal: DigAccessRefusal): Candidate {
  const harvestTool = block.harvestTool ?? null
  return {
    id: digAccessCandidateId(block.position),
    kind: 'MOVE',
    label: `no reachable dig access for ${block.name} at (${block.position.x},${block.position.y},${block.position.z}) (${refusal})`,
    targetName: block.name,
    target: block.position,
    targetEntityId: null,
    itemName: null,
    requiresTool: harvestTool !== null,
    toolName: harvestTool,
    toolTier: block.harvestTier ?? null,
    inReach: false,
    hasStandableAdjacent: false,
    meta: {
      tick: state.tick,
      x: block.position.x,
      y: block.position.y,
      z: block.position.z,
      diggable: block.diggable,
      yieldItem: block.yield ?? block.name,
      digAccess: true,
      [DIG_ACCESS_REFUSAL_META]: refusal,
    },
  }
}

/**
 * The candidate-meta key that marks a MINE as the reachable BASE of a resource
 * column: the item is obtained by mining the column from the bottom up, the
 * drop falling into the pickup volume, rather than by walking to a stand.
 */
export const COLUMN_DIG_META = 'columnDig'

/**
 * The general "obtain a resource whose supporting column is reachable" route.
 *
 * A sensed resource cell (log/stone/ore) can be out of walk-up reach while its
 * own vertical column still has a REACHABLE base: the lowest same-kind cell is
 * inside the body's interaction reach, and the column below it opens onto a
 * standable landing the body can occupy, so the mined drop falls into the
 * pickup volume. That is the ordinary way a trunk, a pillar cap or a wall
 * resource is harvested with no kit: mine the base, the drop lands on the
 * floor, the next cell up becomes the base. No tree/pillar special case - the
 * rule reads only the column at the target's own (x,z), the block kind and the
 * sensor's standable cells.
 *
 * Returns the base cell to MINE now, or null when no such reachable base exists
 * (the caller keeps its typed refusal / escalation).
 */
function columnDigBaseFor(state: WorldState, block: BlockState): BlockState | null {
  if (block.kind !== 'log' && block.kind !== 'stone' && block.kind !== 'ore') return null
  const column = state.blocks.filter(
    (candidate) =>
      candidate.kind === block.kind &&
      candidate.position.x === block.position.x &&
      candidate.position.z === block.position.z,
  )
  if (column.length === 0) return null
  let base: BlockState = column[0] as BlockState
  for (const cell of column) if (cell.position.y < base.position.y) base = cell
  if (!base.diggable) return null
  if (!hasTool(state, base.harvestTool ?? null, base.harvestTier ?? null)) return null
  // The dig happens from where the body already stands, so the base must be in
  // interaction reach; the sensor computed this exact eye-reach fact.
  if (base.inReach !== true) return null
  const landing = columnLandingFor(state, base)
  if (landing === null) return null
  // No sensed block may stand between the landing and the base: a drop would
  // rest on it instead of falling into pickup range.
  const blocked = state.blocks.some(
    (cell) =>
      cell.position.x === base.position.x &&
      cell.position.z === base.position.z &&
      cell.position.y > landing.y &&
      cell.position.y < base.position.y,
  )
  return blocked ? null : base
}

/**
 * The standable cell in `base`'s own (x,z) column BELOW it that the body can
 * occupy: the floor the mined drop falls onto. Bounded to the body's step band
 * and pickup-adjacent walk band so the offered MINE is collectable.
 */
function columnLandingFor(state: WorldState, base: BlockState): Vec3Json | null {
  const self = state.self.position
  let best: Vec3Json | null = null
  let bestScore = Number.POSITIVE_INFINITY
  for (const spot of state.terrain.standable) {
    if (Math.floor(spot.x) !== base.position.x || Math.floor(spot.z) !== base.position.z) continue
    if (spot.y >= base.position.y) continue
    const vertical = Math.abs(spot.y - self.y)
    if (vertical > VERTICAL_GAP) continue
    const horizontal = Math.hypot(Math.floor(spot.x) + 0.5 - self.x, Math.floor(spot.z) + 0.5 - self.z)
    if (horizontal > PICKUP_MINE_HORIZONTAL + VERTICAL_GAP) continue
    const score = vertical + horizontal * 0.1
    if (score < bestScore) {
      bestScore = score
      best = spot
    }
  }
  return best
}

/**
 * The MINE candidate for a column base. Identical in contract to the ordinary
 * in-place MINE (same `MINE:<block>` id, same pickup/verify path in the
 * executor) plus the `columnDig`/`columnTopY` facts that name the column it is
 * the bottom of.
 */
function columnDigMine(
  state: WorldState,
  base: BlockState,
  topY: number,
  requiresPickup: boolean,
  /**
   * The sensed food route this column belongs to, when it is one. A canopy cell
   * is not pickup-adjacent and has no walk-up stand (`findAdjacentStandable`
   * never samples the cell above the target), so the ONLY offered step toward it
   * is this column-base MINE - and it used to carry no `foodRoute` tag at all.
   * The candidate was on offer while `foodSourceGap.offered` stayed empty, so a
   * hungry body with a sensed apple canopy was reported as having NO food route
   * (measured: `FOOD_SOURCE_NONE ... sensedEdibleBlock=true offered=[]`). Tagging
   * the branch is the whole consequence: the route kind and the item are the
   * facts the food accounting, the survival restriction and the run log read.
   */
  foodTag: { route: 'forage' | 'acquire'; item: string } | null = null,
): Candidate {
  const harvestTool = base.harvestTool ?? null
  return {
    id: `MINE:${blockId('b', base.position)}`,
    kind: 'MINE',
    label: `mine the base ${base.name} at (${base.position.x},${base.position.y},${base.position.z}) of the column up to y=${topY} so the drop falls into reach and the body can work upward`,
    targetName: base.name,
    target: base.position,
    targetEntityId: null,
    itemName: null,
    requiresTool: harvestTool !== null,
    toolName: harvestTool,
    toolTier: base.harvestTier ?? null,
    inReach: true,
    hasStandableAdjacent: base.hasAdjacentStandable,
    meta: {
      tick: state.tick,
      x: base.position.x,
      y: base.position.y,
      z: base.position.z,
      diggable: base.diggable,
      yieldItem: base.yield ?? base.name,
      requiresPickup,
      [COLUMN_DIG_META]: true,
      columnTopY: topY,
      ...(base.kind === 'log' ? { [LOG_ROUTE_META]: 'mine_sensed' } : {}),
      ...(foodTag === null ? {} : { foodRoute: foodTag.route, foodTarget: foodTag.item }),
    },
  }
}

/**
 * Bounds the recipe-closure walk used by {@link mineDropAdvancesFocus}. The real
 * chains are <10 items; the cap only stops a malformed recipe graph.
 */
const MAX_FOCUS_CHAIN_ITEMS = 64

/** True when `material` appears anywhere in `root`'s bounded recipe closure. */
function recipeChainContains(recipes: RecipeIndex, root: string, material: string): boolean {
  const seen = new Set<string>()
  const queue: string[] = [root]
  while (queue.length > 0) {
    const item = queue.shift() as string
    if (seen.has(item)) continue
    seen.add(item)
    if (seen.size > MAX_FOCUS_CHAIN_ITEMS) return false
    for (const variant of recipes.recipesFor(item)) {
      for (const ingredient of variant.ingredients) {
        if (ingredient.item === material) return true
        if (!seen.has(ingredient.item)) queue.push(ingredient.item)
      }
    }
  }
  return false
}

/**
 * Feasibility (CAN) rule for a MINE candidate against the active focus item.
 *
 * Mining a block whose drop is `dropItem` can advance the goal only when the
 * drop IS the focus item (or satisfies its resource class), or when it is a
 * material in the focus item's achievable recipe dependency chain: a furnace or
 * a stone tool genuinely needs cobblestone, so plain stone serves those goals.
 * Plain stone when the focus is `flint`/`gravel`/`raw_iron` cannot advance it and
 * must not be offered.
 *
 * This is a WITHHOLDING rule, not a ranking: it removes provably non-advancing
 * MINEs and never reorders or re-scores the remaining candidates. A resource
 * class (`log`, `stone`, `planks`, `fuel`, `pickaxe`) and the null focus keep
 * the historical behaviour (every producer stays offered), which preserves
 * generic early-game goals. Without a recipe index the closure cannot be proven
 * either way, so the candidate is kept (withhold only on proof).
 *
 * The withholding is a pure function of the active focus, so it is durable for
 * the goal and resets the moment the goal/focus changes; no mutable memory is
 * added (the generator stays a pure function of the state).
 */
function mineDropAdvancesFocus(
  focusItem: string | null,
  dropItem: string | null,
  recipes: RecipeIndex | null,
): boolean {
  if (focusItem === null) return true
  if (dropItem === null || dropItem.length === 0) return true
  if (resourceMatches(dropItem, focusItem)) return true
  if (isResourceClass(focusItem)) return true
  if (recipes === null) return true
  return recipeChainContains(recipes, focusItem, dropItem)
}

/**
 * Whether a dropped entity is a route for the active focus.
 *
 * The mined-block rule above deliberately keeps the historical broad envelope
 * for resource-class focuses: mining any sensed resource may be useful to the
 * next horizon. A dropped item is different: it is already a concrete,
 * one-step acquisition, so unrelated drops must not masquerade as progress for
 * the current Option or suppress its route-opening candidates. For classes,
 * accept a member of the class (plus logs as the mechanical source of planks);
 * for item focuses, accept the focus or a proven recipe ingredient. When recipe
 * truth is unavailable, keep the candidate rather than claiming it cannot help.
 */
function pickupDropAdvancesFocus(
  focusItem: string | null,
  dropItem: string | null,
  recipes: RecipeIndex | null,
): boolean {
  if (focusItem === null || dropItem === null || dropItem.length === 0) return true
  if (resourceMatches(dropItem, focusItem)) return true
  if (isResourceClass(focusItem)) {
    return focusItem === 'planks' && matchesResourceClass(dropItem, 'log')
  }
  if (recipes === null) return true
  return recipeChainContains(recipes, focusItem, dropItem)
}

/** One material the active goal needs, with the amount the goal implies. */
export interface GoalMaterialNeed {
  item: string
  /** how many the goal's own recipe chain requires (units, rounded up per craft) */
  required: number
  /** how many the body holds right now */
  held: number
}

/**
 * The goal's BILL OF MATERIALS: the focus item plus every ingredient its recipe
 * chain implies, each with the amount the goal requires.
 *
 * This is plain recipe arithmetic, not a policy: the goal is `craft N x X`, and
 * the chain multiplies out (`craft 12 x ender_eye` -> 12 x ender_pearl + 12 x
 * blaze_powder -> 6 x blaze_rod, because one rod yields two powder). Amounts are
 * aggregated by MAX over paths, which is the conservative (never-short) reading
 * of a recipe DAG, and the descent is depth- and cycle-bounded so a malformed
 * table can only produce a truncated BOM.
 *
 * The variant per item is chosen with `selectCraftIngredients`, the SAME
 * deterministic selection the craft planner and the ingredient route use, so the
 * BOM cannot disagree with the step that will actually be executed.
 */
export function goalMaterialNeeds(
  focusItem: string | null,
  requiredCount: number,
  recipes: RecipeIndex | null,
  inventory: Readonly<Record<string, number>>,
): GoalMaterialNeed[] {
  if (focusItem === null) return []
  const required = new Map<string, number>()
  const bump = (item: string, amount: number): void => {
    const next = Math.max(required.get(item) ?? 0, amount)
    required.set(item, next)
  }
  bump(focusItem, Math.max(1, Math.floor(requiredCount)))
  if (recipes !== null) {
    const stack = new Set<string>()
    const descend = (item: string, want: number, depth: number): void => {
      if (depth >= MAX_DEPENDENCY_DEPTH || stack.has(item)) return
      if (required.size > MAX_FOCUS_CHAIN_ITEMS) return
      // A DECOMPOSITION recipe (`diamond` <= `diamond_block` <= 9 `diamond`) is a
      // recipe whose ingredient's own chain leads back to the item: it does not
      // make the item craftable, and expanding it would demand 2 diamond_blocks
      // for 3 diamonds. Skip such variants, exactly as the goal layer's
      // `hasCraftingProducer` does, so the BOM describes the goal's real
      // ingredient chain.
      const variants = recipes
        .recipesFor(item)
        .filter(
          (variant) =>
            !variant.ingredients.some(
              (ingredient) => ingredient.item === item || recipeChainContains(recipes, ingredient.item, item),
            ),
        )
      if (variants.length === 0) return
      const selection = selectCraftIngredients(variants, inventory)
      if (selection === null) return
      const perCraft = Math.max(1, selection.variant.resultCount)
      const crafts = Math.ceil(want / perCraft)
      stack.add(item)
      for (const ingredient of selection.variant.ingredients) {
        const amount = crafts * ingredient.count
        bump(ingredient.item, amount)
        descend(ingredient.item, amount, depth + 1)
      }
      stack.delete(item)
    }
    descend(focusItem, required.get(focusItem) as number, 0)
  }
  return [...required.entries()]
    .map(([item, amount]) => ({ item, required: amount, held: inventory[item] ?? 0 }))
    .sort((a, b) => (a.item === b.item ? 0 : a.item < b.item ? -1 : 1))
}

/**
 * The items the ACTIVE goal still needs whose only grounded producer is a MOB.
 *
 * The general form the mission needs: "item X is produced by recipe R from
 * ingredients I, or dropped by mob M". `MOB_DROP_PRODUCERS` (state.ts) owns the
 * "dropped by M" half; `goalMaterialNeeds` owns the recipe half. Crossing them
 * answers the question the candidate layer previously answered only for a
 * `collect` goal: a `craft ender_eye` goal needs `blaze_powder`, whose raw
 * producer is `blaze_rod`, whose ONLY producer is a blaze - so the hunt is a
 * grounded route for the CRAFT goal too, not just for `collect blaze_rod`.
 *
 * "Still needs" is the BOM's own shortfall (`held < required`), so an ingredient
 * the body already holds in the required amount is not chased again. Sorted, and
 * pure: the same state yields the same list.
 */
export function mobDropNeedsForGoal(
  focusItem: string | null,
  requiredCount: number,
  recipes: RecipeIndex | null,
  inventory: Readonly<Record<string, number>>,
): string[] {
  return goalMaterialNeeds(focusItem, requiredCount, recipes, inventory)
    .filter((need) => MOB_DROP_PRODUCERS[need.item] !== undefined && need.held < need.required)
    .map((need) => need.item)
}

/**
 * The item a MINE candidate's target yields. A regular MINE carries its block
 * drop in `meta.yieldItem`. A clearance MINE targets a ceiling cell that may not
 * be in `state.blocks`; resolve the sensed block's drop when present, else the
 * canonical mechanics table (#54) using the cut's block name.
 */
function mineCandidateDrop(state: WorldState, candidate: Candidate): string | null {
  const metaYield = candidate.meta?.yieldItem
  if (candidate.meta?.clearance !== true && typeof metaYield === 'string' && metaYield.length > 0) {
    return metaYield
  }
  const target = candidate.target
  if (target !== null) {
    const sensed = state.blocks.find(
      (block) =>
        block.position.x === target.x && block.position.y === target.y && block.position.z === target.z,
    )
    if (sensed !== undefined && typeof sensed.yield === 'string' && sensed.yield.length > 0) return sensed.yield
  }
  const name =
    typeof candidate.targetName === 'string' && candidate.targetName.length > 0
      ? candidate.targetName
      : typeof metaYield === 'string'
        ? metaYield
        : ''
  if (name.length === 0) return null
  return resolveHarvest(loadGameData(), name).yield ?? name
}

/**
 * MINE/MOVE/DESCEND candidates for the current collect subgoal only.
 *
 *  - a block is mined in place only when the bot is already standing next to it
 *    (`PICKUP_MINE_HORIZONTAL`/`PICKUP_MINE_VERTICAL`), so the drop lands inside
 *    the automatic-pickup volume instead of several metres away;
 *  - a reachable block that is *not* pickup-adjacent is demoted to a MOVE toward
 *    its standable spot, so the next sensor tick re-offers it as a safe MINE;
 *  - a block with no walk-up access is a tunnel target, and the generator emits
 *    a DESCEND staircase/tunnel step toward the nearest one;
 *  - a block with no walk-up access AND a reachable #244 interaction stand gets
 *    an ACCESS MOVE to that stand; with no reachable stand and no downward
 *    tunnel route it is retired with a typed withheld refusal.
 */
function mineCandidates(
  state: WorldState,
  options: CandidateOptions,
  focusItem: string | null,
  descendTargetY: number | null = null,
  blockFilter: ((block: BlockState) => boolean) | null = null,
  /**
   * CAN-enumeration ONLY, for the capability-acquisition pass: keep a SENSED
   * producer whose harvest tool the body does not hold yet, instead of dropping
   * it inside the generator. Dropping it made the tool need invisible - the
   * acquisition pass then had no route and reported `no_producer` for a producer
   * the sensor had actually proved, and no `{kind:'tool'}` fact existed anywhere
   * to route to. The candidate this produces is NOT executable: the reachability
   * gate refuses it with `missing_tool` on its own barrier (and the guard denies
   * EMPTY_HAND), which is exactly how the tool need becomes a fact the
   * acquisition closure can answer. False for every ordinary caller, so the
   * offer is unchanged where the tool is already held.
   */
  keepUnharvestable = false,
): Candidate[] {
  // A MINE that feeds an inventory-counted goal (collect/craft/smelt) must end
  // with its drop in the inventory; a navigation goal (descend/surface/explore)
  // only needs the block gone, because its drop may be transformed or lost.
  const goalKind = state.goalQueue?.current?.kind ?? 'collect'
  const requiresPickup = goalKind === 'collect' || goalKind === 'craft' || goalKind === 'smelt'
  // A block that is a member of a live structure the resident depends on is not
  // a source, whatever its name (see blockSafety.ts). Live portal frames are the
  // measured case: `collect obsidian` must not dismantle the portal it just used
  // or built. This is the general membership predicate, not a portal rule - the
  // generator never learns which structure the cell belongs to.
  const liveStructures = liveStructureIndexOf(state)
  const mineable = state.blocks.filter(
    (block) =>
      (block.kind === 'log' || block.kind === 'stone' || block.kind === 'ore') &&
      !isLiveStructureMember(liveStructures, block.position) &&
      (blockFilter === null || blockFilter(block)),
  )
  // The declared scanned source names the blocks that carry the focus item
  // (`flint -> gravel`). Mining gravel only *may* drop flint, and minecraft-data
  // reports gravel's primary drop as gravel, so a drop-name match alone never
  // reaches the declared source. Match the source block by name as well; this is
  // the same perception-truth mapping the scanner used to sense it. Structure
  // fabric is excluded (`want.kind !== 'ore'`): `nether_bricks` is a landmark
  // that hosts blazes, never a source that yields `blaze_rod`.
  const want = focusItem === null ? null : retrievalWant(focusItem)
  const sourceNames = want !== null && want.kind === 'ore' ? want.blockNames : null
  // M3 structure route: when the focus item's only declared source is structure
  // FABRIC (`blaze_rod` -> the Nether-fortress body), a SENSED fabric block
  // grounds an APPROACH - a MOVE to a standable cell beside the fortress - and
  // never a MINE. The durable-site `RETRIEVE:known:*` arm only exists after the
  // host has minted a structure site; measured live on arrival in the Nether
  // (run-muc3qbug-18vg3) the body held 65 remembered sites, but a body whose
  // first sighting has not been recorded yet was offered nothing but
  // `MOVE ... unexplored terrain` + WAIT (probe: `blaze_rod` focus + sensed
  // `nether_bricks` at 8 m => explore only). The fabric is a landmark that hosts
  // the mob, never a block that yields the item (`resourceMatches` stays exact),
  // so this pool is built from the sensed blocks directly - it is deliberately
  // NOT part of `mineable`, which excludes live-structure members to protect
  // them - and the MINE branch is skipped for these cells.
  const structureFabricNames =
    want !== null && want.kind === 'structure' ? new Set(want.blockNames) : null
  const structureApproach =
    structureFabricNames === null
      ? []
      : state.blocks.filter((block) => structureFabricNames.has(block.name))
  // Tagging only: the food cells are offered by their own bounded call
  // (`foodForageCandidates`), never by crowding the focus pool's mechanical cap.
  const foodCells = foodRouteCells(state, options)
  const matching = mineable.filter(
    (block) =>
      focusItem === null ||
      resourceMatches(block.yield, focusItem) ||
      (sourceNames?.includes(block.name) ?? false),
  )
  const fallback =
    focusItem === null && matching.length === 0 ? mineable.filter((block) => block.kind === 'log') : matching
  const pool = [...fallback, ...structureApproach]
  const isStructureFabricCell = (block: BlockState): boolean =>
    structureFabricNames !== null && structureFabricNames.has(block.name)
  const mineActions: Candidate[] = []
  const moveActions: Candidate[] = []
  const accessActions: Candidate[] = []
  const tunnelTargets: BlockState[] = []
  // Column bases already offered as a MINE this cycle, so a multi-cell column
  // contributes one base MINE instead of one per cell.
  const columnDigIds = new Set<string>()
  let moveCount = 0
  const self = state.self.position

  for (const block of pool) {
    if (mineActions.length + moveActions.length + accessActions.length >= options.maxMineCandidates) break
    const fabricCell = isStructureFabricCell(block)
    // A fortress body block is a ROUTE landmark, not a source: it needs neither a
    // diggable cell nor the harvest tool, because nothing is ever mined from it.
    if (!fabricCell && !block.diggable) continue
    // Owner vertical-safety rule: never offer the block the bot is standing on as
    // a MINE. The sensor records the air-exposed support block at feet.y - 1
    // (buildStoneBlocks), and because it is pickup-adjacent the stock MINE branch
    // would remove it and drop the bot uncontrolled. The controlled DESCEND
    // own-column step owns that cell instead (state.ts requires solid support at
    // feet-2). Feasibility truth only: this removes an unsafe affordance, it does
    // not rank or replace the remaining candidates.
    if (digsBotSupport(state.self.position, block.position) !== null) continue
    const harvestTool = block.harvestTool ?? null
    const tier = block.harvestTier ?? null
    if (!fabricCell && !hasTool(state, harvestTool, tier) && !keepUnharvestable) continue

    // A structure-approach cell is never harvested here, so the MOVE must not
    // inherit the fabric's harvest-tool requirement: a fortress is a place to
    // walk to with or without a pickaxe, and gating the approach on
    // `tool:pickaxe@<nether_bricks tier>` withheld the only route to it.
    const requiresTool = !fabricCell && harvestTool !== null
    const approachTool = fabricCell ? null : harvestTool
    const approachTier = fabricCell ? null : tier
    const foodCell = foodCells.get(blockCellKey(block.position))
    const baseMeta = {
      tick: state.tick,
      x: block.position.x,
      y: block.position.y,
      z: block.position.z,
      diggable: block.diggable,
      yieldItem: block.yield ?? block.name,
      // Typed CAN fact for a structure-route MOVE: this cell is fortress fabric,
      // so the candidate is an APPROACH to the structure hosting the wanted mob
      // and carries no yield claim for the focus item.
      ...(fabricCell ? { resourceKind: 'structure', structureApproach: true } : {}),
      ...(block.kind === 'log' ? { [LOG_ROUTE_META]: 'mine_sensed' } : {}),
      // Typed CAN fact: this cell is a grounded route to food and which item it
      // yields. The survival restriction and the FOOD_ROUTE marker read this
      // instead of re-deriving it from the block name.
      ...(foodCell === undefined ? {} : { foodRoute: foodCell.route, foodTarget: foodCell.item }),
    }

    const horizontal = Math.hypot(block.position.x + 0.5 - self.x, block.position.z + 0.5 - self.z)
    const vertical = Math.abs(block.position.y - self.y)
    const spot = block.adjacentStandable
    const spotHorizontal =
      spot === null ? Number.POSITIVE_INFINITY : Math.hypot(spot.x + 0.5 - self.x, spot.z + 0.5 - self.z)
    const atSpot = spot !== null && spotHorizontal <= 0.9 && Math.abs(spot.y - self.y) <= 1.5
    const pickupSafe =
      (horizontal <= PICKUP_MINE_HORIZONTAL && vertical <= PICKUP_MINE_VERTICAL) || atSpot

    // In reach, visible AND pickup-adjacent: mine it now. Anything farther would
    // drop the item outside the pickup volume, so it becomes a MOVE instead.
    // A structure-fabric cell is skipped: the fortress body never yields the
    // wanted mob drop, so the only route it can ground is the APPROACH below.
    if (!fabricCell && block.inReach && block.visible !== false && pickupSafe) {
      mineActions.push({
        id: `MINE:${blockId('b', block.position)}`,
        kind: 'MINE',
        label: mineLabel(block),
        targetName: block.name,
        target: block.position,
        targetEntityId: null,
        itemName: null,
        requiresTool,
        toolName: approachTool,
        toolTier: approachTier,
        inReach: true,
        hasStandableAdjacent: block.hasAdjacentStandable,
        meta: { ...baseMeta, requiresPickup },
      })
      columnDigIds.add(`MINE:${blockId('b', block.position)}`)
      continue
    }

    // Reachable but not pickup-adjacent (or out of reach): MOVE:<block id> is the
    // navigation decision. On arrival the next sensor tick re-offers MINE.
    const moveMin = options.moveMinDistance ?? DEFAULT_MOVE_MIN_DISTANCE
    const moveMax = options.moveMaxDistance ?? DEFAULT_MOVE_MAX_DISTANCE
    const maxMoves = options.maxMoveCandidates ?? DEFAULT_MAX_MOVE_CANDIDATES
    if (isExecutable(block) && block.hasAdjacentStandable) {
      if (block.distance < moveMin || block.distance > moveMax) {
        if (block.distance > moveMax) tunnelTargets.push(block)
        continue
      }
      if (moveCount >= maxMoves) continue
      if (failureCount(state.signals.failedCandidates, `MOVE:${blockId('b', block.position)}`) >= (options.moveFailureLimit ?? DEFAULT_CANDIDATE_MOVE_FAILURE_LIMIT)) continue
      if (spot === null || atSpot) continue
      if (isBlacklistedMoveTarget(state, options.blacklistedMoveTargets, spot)) {
        if (block.distance <= (options.tunnelMaxDistance ?? DEFAULT_TUNNEL_MAX_DISTANCE)) tunnelTargets.push(block)
        continue
      }
      moveCount += 1
      // A visible resource can be many blocks above the current floor.  Keep
      // the same deterministic vertical contract as RETRIEVE candidates on
      // the MOVE that takes the body to its standable spot; otherwise the
      // executor sees only a horizontal path and repeatedly stalls below the
      // resource even though the sensor proved a safe pillar/staircase leg.
      const vertical = planVerticalApproach(verticalInputFor(state, block.position))
      const tunnelFallback =
        vertical?.kind === 'reuse'
          ? planVerticalApproach({ ...verticalInputFor(state, block.position), tunnel: null })
          : null
      const verticalMeta = {
        ...verticalPlanMeta(vertical, Math.floor(state.self.position.y), block.position.y),
        ...(vertical?.kind === 'reuse' ? fallbackVerticalMeta(tunnelFallback) : {}),
      }
      moveActions.push({
        id: `MOVE:${blockId('b', block.position)}`,
        kind: 'MOVE',
        label: moveToBlockLabel(block, spot, fabricCell),
        targetName: block.name,
        target: spot,
        targetEntityId: null,
        itemName: null,
        requiresTool,
        toolName: approachTool,
        toolTier: approachTier,
        inReach: false,
        hasStandableAdjacent: true,
        meta: {
          ...baseMeta,
          x: spot.x,
          y: spot.y,
          z: spot.z,
          targetBlockX: block.position.x,
          targetBlockY: block.position.y,
          targetBlockZ: block.position.z,
          targetBlockName: block.name,
          distance: block.distance,
          ...verticalMeta,
        },
      })
      continue
    }

    // No walk-up access. The general "supporting column is reachable" route
    // comes first: when this resource's own column has a reachable base, mining
    // that base drops the item onto a floor the body can occupy, and the column
    // can then be worked upward (a floating trunk/branch, a pillar cap, a wall
    // resource). CAN enumeration only - the dig-access stand route below stays
    // on offer too, and Jev owns WHICH. The id is the ordinary `MINE:<base>` so
    // the executor's dig/pickup/verify contract is unchanged.
    const columnBase = columnDigBaseFor(state, block)
    if (columnBase !== null) {
      const columnId = `MINE:${blockId('b', columnBase.position)}`
      if (
        !columnDigIds.has(columnId) &&
        mineActions.length + moveActions.length + accessActions.length < options.maxMineCandidates
      ) {
        columnDigIds.add(columnId)
        mineActions.push(columnDigMine(state, columnBase, block.position.y, requiresPickup, foodCell ?? null))
      }
    }

    // No walk-up access. The sensor sampled only the 12 immediate neighbours,
    // so a reachable stand may still exist from which the block becomes
    // diggable. Offer that walk as an explicit dig prerequisite; if none exists
    // (and the block cannot be tunnelled downward) retire it with a typed
    // refusal instead of dropping it silently.
    const access = digAccessFor(state, options, block)
    if (access.stand !== null) {
      const stand = access.stand
      const atStand =
        Math.hypot(stand.x + 0.5 - self.x, stand.z + 0.5 - self.z) <= 0.9 &&
        Math.abs(stand.y - self.y) <= 1.5
      if (
        !atStand &&
        mineActions.length + moveActions.length + accessActions.length < options.maxMineCandidates &&
        !isBlacklistedMoveTarget(state, options.blacklistedMoveTargets, stand) &&
        failureCount(state.signals.failedCandidates, digAccessCandidateId(block.position)) <
          (options.moveFailureLimit ?? DEFAULT_CANDIDATE_MOVE_FAILURE_LIMIT)
      ) {
        accessActions.push(digAccessMove(state, block, stand, foodCell ?? null))
        continue
      }
    } else if (
      access.refusal !== null &&
      block.position.y >= Math.floor(self.y)
    ) {
      accessActions.push(digAccessRetirement(state, block, access.refusal))
      continue
    }

    const tunnelMax = options.tunnelMaxDistance ?? DEFAULT_TUNNEL_MAX_DISTANCE
    if (block.distance <= tunnelMax) tunnelTargets.push(block)
  }

  const candidates = [...mineActions]
  // Route-opening options come BEFORE MOVE: a MOVE whose stand spot is behind a
  // 2-block face (or under a canopy ceiling) can never execute, so the cut/clear
  // that opens the route must be the first thing the policy sees.
  if (mineActions.length === 0) candidates.push(...headroomCandidates(state, options))
  if (moveActions.length > 0) candidates.push(...stepCutCandidates(state, options))
  candidates.push(...moveActions)
  candidates.push(...accessActions)
  const descent = descendCandidates(state, options, focusItem, tunnelTargets, descendTargetY)
  if (candidates.length === 0) {
    // Reuse before carve: an opening the world already has, or the shaft the body
    // already dug, is offered as a grounded route BEFORE the new dig step. Both
    // stay on offer (nothing is suppressed) and Jev owns the choice.
    candidates.push(...existingDescentRouteCandidates(state, options))
    candidates.push(...descent)
    // A descend goal whose direct column offers NO safe step must not leave an
    // escalate-only offer on an active row (live: y=55 idle, `kinds=['ESCALATE']`
    // with the target 109 blocks below). Retarget a fresh standable column; the
    // next observation re-derives the descent there.
    if (candidates.length === 0 && descendTargetY !== null) {
      candidates.push(...descentRetargetCandidates(state, options))
    }
    // THE MIRROR OF THE CROSSING. When the landing cell has AIR under it, no dig
    // can answer the descent and the bounded retarget above is a lateral step, not
    // a descent: the body lays the floor of the cell under its own feet and drops
    // onto it (`descentScaffold.ts`), which is exactly what the bridge does
    // sideways. Offered ALONGSIDE the retarget, never instead of it.
    if (candidates.length === 0 && descendTargetY !== null) {
      const scaffold = descentScaffoldForLevel(state, options, {
        targetY: descendTargetY,
        goalId: state.goalQueue?.current?.id ?? null,
        label: 'descend by placing its own landing',
      })
      if (scaffold.candidate !== null) candidates.push(scaffold.candidate)
    }
    // A descent predicate with no grounded local route has reached the semantic
    // boundary. Surface that typed gap to Jev/System2; do not silently leave an
    // active descent Skill with only WAIT or choose a new recovery strategy here.
    if (candidates.length === 0 && descendTargetY !== null) {
      candidates.push(
        descentPolicyEscalateCandidate({
          tick: state.tick,
          reason: 'no_grounded_local_frontier',
          outcome: 'BLOCKED',
          label: `hand control to System 2 (no grounded descent recovery at Y=${descendTargetY})`,
        }),
      )
    }
  } else if (
    mineActions.length === 0 &&
    (moveActions.length > 0 || accessActions.length > 0) &&
    focusItem !== null &&
    (STONE_YIELDS.has(focusItem) || scannedBlockNames(focusItem) !== undefined)
  ) {
    // A visible underground target can be mechanically valid but still too far
    // below the current floor for the MOVE stand spot to be useful.  Preserve
    // the safe staircase/tunnel fact alongside those MOVE candidates so Jev
    // can choose the vertical route.  This is candidate enumeration, not a
    // deterministic preference: no MOVE is replaced or selected here.
    candidates.push(...descent)
  }
  // Feasibility (CAN) filter: a MINE whose drop cannot advance the active focus
  // is withheld. The focused pool already satisfies this, so the rule bites on
  // the clearance/headroom MINEs that bypass it: with `collect 1 x flint (from
  // gravel)`, a ceiling stone clearance MINE completes with progressDelta=0 and
  // is re-offered forever. This removes only provably non-advancing MINEs; the
  // remaining candidates keep their order (no ranking).
  return candidates.filter(
    (candidate) =>
      candidate.kind !== 'MINE' ||
      mineDropAdvancesFocus(focusItem, mineCandidateDrop(state, candidate), options.recipes ?? null) ||
      mineSourceAdvancesFocus(focusItem, candidate),
  )
}

// ---------------------------------------------------------------------------
// PROSPECT: the exposure dig a descend/travel-to-acquire row is missing
// ---------------------------------------------------------------------------
//
// Measured (live run-muc3qbug-18vg3, main 4f4e0cb): a `descend_to:Y=-54` row for
// `raw_iron` walked a 1-wide staircase from y=63 to y=8 over ~40 minutes. Every
// one of the 1886 iron-ore-facing candidates in the run was offered by an arm
// this file already has (the descend branch does call `mineCandidates(...,
// descendTargetY)`), and the 110-decision descend window was
// `{DESCEND} 100x, {RETRIEVE} 7x, {ESCALATE} 2x, {MINE} 1x`. The arm was not
// starved: it legitimately had nothing to offer.
//
// The reason is the shape of "exposed" in this file. A sensed producer becomes an
// offered MINE only when it is in reach AND pickup-adjacent
// (`PICKUP_MINE_HORIZONTAL`/`PICKUP_MINE_VERTICAL`, below); a walk-up MOVE needs
// an adjacent standable cell (the sensor samples 12 neighbours); everything else
// is at most a tunnel TARGET that only steers the DESCEND scorer. A staircase
// removes exactly the cells the body walks through and leaves solid rock on every
// other side, so a vein one block behind a wall is sensed (`state.blocks` keeps
// name-scanned ores out to radius 64) but has no stand, is not pickup-adjacent,
// and is never the block any offered step digs.
//
// The missing capability is prospecting, and it is general for any
// "travel/descend to acquire X" row: while such a row is active for an item with
// block producers, enumerate - ALONGSIDE the descend step, never replacing it -
// the bounded lateral dig that would expose a sensed producer of that item. The
// claim is mechanical and built from real geometry: the producer is sensed, lies
// in the cardinal probe corridor at the body's own depth band, the wall in front
// of it is a real diggable wall with a pre-computed SAFE level step, and the body
// holds the harvest tool for the producer (CAN). No fixed coordinates, no
// per-item direction policy: Jev still chooses WHICH, and a producer the ordinary
// MINE/MOVE arm can already reach is left to that arm.
//
// A probe is a DESCEND (`mode: 'level'`) from the sensor's own pre-computed
// steps, so it reuses that step's typed refusal (`hazard`, `unbreakable`,
// `no_support`, `open_floor`, `protected`), the `planDescend` guard and the
// `runDescend` executor verbatim: this family adds enumeration, never mechanics.

/**
 * Candidate meta marking a lateral exposure probe. The candidate is a DESCEND
 * (`mode: 'level'`) so it executes through exactly the same safe-step mechanics,
 * guard and postcondition as the stair step it is offered beside; this marker is
 * what makes it readable as a PROSPECT in the decision log instead of an
 * unexplained level step.
 */
export const PROSPECT_META = 'prospect'

/** How many blocks of bounded branch tunnel one probe may aim through. */
export const PROSPECT_MAX_LATERAL = 3

/** Why an exposure probe the geometry grounded could NOT be offered. */
export type ProspectRefusalReason = DescentRefusalReason | 'no_tool' | 'no_safe_step'

/** The sensed producer a probe aims at, and the cell where the probe would dig. */
export interface ProspectRefusal {
  reason: ProspectRefusalReason
  /** cardinal probe direction (never `D`: a probe is lateral by definition) */
  dir: DescentDir
  producer: string
  producerCell: Vec3Json
  /** the solid wall cell the level step would remove */
  digCell: Vec3Json
}

/** The exact `PROSPECT_REFUSED` observability line for one typed refusal. */
export function formatProspectRefused(refusal: ProspectRefusal): string {
  const producer = refusal.producerCell
  const dig = refusal.digCell
  return `PROSPECT_REFUSED reason=${refusal.reason} producer=${refusal.producer} dir=${refusal.dir} cell=${producer.x},${producer.y},${producer.z} dig=${dig.x},${dig.y},${dig.z}`
}

export interface ProspectResult {
  candidates: Candidate[]
  refusal: ProspectRefusal | null
}

/** Stable id of the exposure probe that digs `digCell` in direction `dir`. */
export function prospectCandidateId(dir: DescentDir, digCell: Vec3Json): string {
  return `PROSPECT:level:${dir}:${blockId('b', digCell)}`
}

const PROSPECT_CARDINALS: ReadonlyArray<{ dir: DescentDir; dx: number; dz: number }> = [
  { dir: 'E', dx: 1, dz: 0 },
  { dir: 'W', dx: -1, dz: 0 },
  { dir: 'N', dx: 0, dz: -1 },
  { dir: 'S', dx: 0, dz: 1 },
]

/** Manhattan-1 adjacency: a shared face, never a corner or an edge. */
function faceAdjacent(a: Vec3Json, b: Vec3Json): boolean {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z) === 1
}

/**
 * The active row is acquiring an item by going DOWN through rock: an explicit
 * `descend` row, a target below the feet, or a sensed producer of the focus
 * sitting below the body. This is the context the measured run was in; a purely
 * local row that is not moving the body downward is not a prospecting context.
 */
function acquisitionTravelActive(state: WorldState, feetY: number, producerBelow: boolean): boolean {
  const current = state.goalQueue?.current ?? null
  if (current === null) return false
  if (current.kind === 'descend') return true
  const targetY = typeof current.targetY === 'number' && Number.isFinite(current.targetY) ? current.targetY : null
  if (targetY !== null && targetY < feetY) return true
  const target = current.targetPosition ?? null
  if (target !== null && target.y < feetY) return true
  return producerBelow
}

/**
 * The bounded lateral exposure family for a descend/travel-to-acquire row.
 *
 * Enumerates at most one probe per cardinal direction: the level step the sensor
 * already computed for that direction, offered when a sensed producer of the
 * focus lies in its probe corridor. The corridor is the straight cardinal line
 * at the body's own depth band (`along` 1..`PROSPECT_MAX_LATERAL`, `|perp| <= 1`,
 * `dy === 0`) and the producer must not be one the ordinary MINE (pickup
 * adjacent now) or MOVE (walk-up stand) arm can already reach. Removing the
 * step's primary cell either exposes that producer directly (it shares a face
 * with the cell the body will stand in) or advances a bounded branch toward it;
 * the next observation re-derives the same rule, so the branch stops as soon as
 * the producer becomes walk-up reachable or leaves the corridor. CAN enumeration
 * only: nothing is suppressed, nothing is ranked, and the DESCEND step is offered
 * beside every probe.
 */
export function prospectCandidates(
  state: WorldState,
  options: CandidateOptions,
  focusItem: string | null,
  descendTargetY: number | null = null,
): ProspectResult {
  const none: ProspectResult = { candidates: [], refusal: null }
  if (focusItem === null) return none
  // The focus item's declared name-scanned sources are its block producers.
  // Stone-class focuses (`cobblestone`) declare none on purpose: every wall is
  // stone, so there is nothing to prospect for.
  const sourceNames = scannedBlockNames(focusItem)
  if (sourceNames === undefined) return none
  const self = state.self.position
  const feet = {
    x: Math.floor(state.self.position.x),
    y: Math.floor(state.self.position.y),
    z: Math.floor(state.self.position.z),
  }
  const vertical = (block: BlockState): number => Math.abs(block.position.y - self.y)
  const horizontal = (block: BlockState): number =>
    Math.hypot(block.position.x + 0.5 - self.x, block.position.z + 0.5 - self.z)
  const pickupAdjacent = (block: BlockState): boolean =>
    horizontal(block) <= PICKUP_MINE_HORIZONTAL && vertical(block) <= PICKUP_MINE_VERTICAL
  // A producer the ordinary arm can already COMPLETE is not prospected for:
  //   MOVE -> the sensor sampled a walk-up stand beside it;
  //   MINE -> it shares a face with the body's own cell and is pickup-adjacent,
  //           so there is no intervening wall for a probe to remove.
  // Everything else is a producer the row is passing where the dig - if the arm
  // offers one at all - would have to go through rock first, and a rock face
  // between the eyes and the target is exactly what the server refuses to dig
  // (`BlockState.visible`: "a close but occluded block must not be offered as
  // MINE"). That producer is what this family exists for.
  const buried = state.blocks.filter(
    (block) =>
      block.kind === 'ore' &&
      sourceNames.includes(block.name) &&
      block.diggable &&
      !block.hasAdjacentStandable &&
      !(
        Math.abs(block.position.x - feet.x) +
          Math.abs(block.position.y - feet.y) +
          Math.abs(block.position.z - feet.z) ===
          1 && pickupAdjacent(block)
      ),
  )
  if (buried.length === 0) return none
  const producerBelow = buried.some((block) => block.position.y < feet.y)
  if (!acquisitionTravelActive(state, feet.y, producerBelow)) return none
  const steps = state.descent ?? []
  const candidates: Candidate[] = []
  const refusals: ProspectRefusal[] = []
  for (const { dir, dx, dz } of PROSPECT_CARDINALS) {
    const step = steps.find(
      (entry) => entry.mode === 'level' && entry.dir === dir && entry.dx === dx && entry.dz === dz,
    )
    if (step === undefined) continue
    // A probe digs a WALL: an already-open level cell is a route, not an
    // exposure. The cell whose removal exposes the producer is the step's own
    // primary (`descentPrimaryCell`: wall first, else the head above it), so the
    // exposure claim is exactly the cell `runDescend` digs last.
    if (step.wallSolid !== true && step.headSolid !== true) continue
    const digKind: 'wall' | 'head' = step.wallSolid === true ? 'wall' : 'head'
    const digCell = descentPrimaryCell(step)
    // Corridor membership from the body's cell: how far the producer sits along
    // the probe direction and how far off-axis, at the body's OWN level. The
    // level step clears the feet level, so a producer at any other level is not
    // what this dig exposes.
    const aimed = buried
      .map((block) => {
        const ox = block.position.x - feet.x
        const oz = block.position.z - feet.z
        return {
          block,
          along: ox * dx + oz * dz,
          perp: dx === 0 ? Math.abs(ox) : Math.abs(oz),
          dy: block.position.y - feet.y,
        }
      })
      .filter(
        (entry) =>
          entry.along >= 1 && entry.along <= PROSPECT_MAX_LATERAL && entry.perp <= 1 && entry.dy === 0,
      )
      .sort((a, b) => a.along - b.along || a.perp - b.perp)
    const aim = aimed[0]
    if (aim === undefined) continue
    const refusal = (reason: ProspectRefusalReason): void => {
      refusals.push({
        reason,
        dir,
        producer: aim.block.name,
        producerCell: aim.block.position,
        digCell,
      })
    }
    if (step.safe !== true) {
      // SAFE: the step's own pre-computed typed refusal is reused verbatim;
      // nothing about hazard/support/breakability is re-derived here.
      refusal(step.refusal ?? 'no_safe_step')
      continue
    }
    if (protectedStepProfileRefusal(state, strictStepDigProfile(state, step)) !== null) {
      refusal('protected')
      continue
    }
    // CAN: exposing a producer the body cannot harvest is not acquisition.
    if (!hasTool(state, aim.block.harvestTool ?? null, aim.block.harvestTier ?? null)) {
      refusal('no_tool')
      continue
    }
    const id = prospectCandidateId(dir, digCell)
    if (
      failureCount(state.signals.failedCandidates, id) >=
      (options.descendFailureLimit ?? DEFAULT_CANDIDATE_DESCEND_FAILURE_LIMIT)
    ) {
      continue
    }
    const built = descendCandidateFromStep(state, options, step, {
      focusItem,
      descendTargetY,
      // Grounded: the world holds a sensed producer of the focus this dig
      // exposes or advances a bounded branch toward (see the corridor above).
      grounded: true,
      staircase: false,
      extraMeta: {
        [PROSPECT_META]: true,
        prospectProducer: aim.block.name,
        prospectProducerX: aim.block.position.x,
        prospectProducerY: aim.block.position.y,
        prospectProducerZ: aim.block.position.z,
        prospectProducerDistance: Math.round(distance(aim.block.position, self) * 100) / 100,
        prospectDir: dir,
        prospectAlong: aim.along,
        prospectDeltaY: aim.dy,
        prospectDigKind: digKind,
        prospectDigX: digCell.x,
        prospectDigY: digCell.y,
        prospectDigZ: digCell.z,
        // The dig exposes the producer NOW (it shares a face with the cell the
        // body will stand in) or advances the bounded branch toward it.
        prospectExposure: faceAdjacent(digCell, aim.block.position) ? 'exposed_by_this_dig' : 'branch_toward',
      },
    })
    if (built === null) {
      // The dig itself needs a harvest tool the body does not hold.
      refusal('no_tool')
      continue
    }
    // The step's own 1x2 dig plan and step phase are kept verbatim: the passage
    // cells are dug first and the landing cell last, so the body can always enter
    // the cell whose wall it just removed.
    candidates.push({
      ...built.candidate,
      id,
      label: `probe the ${dir} ${digKind} (${digCell.x},${digCell.y},${digCell.z}) to expose ${aim.block.name} at (${aim.block.position.x},${aim.block.position.y},${aim.block.position.z}), dig it then stand at (${step.step.x},${step.step.y},${step.step.z})`,
    })
  }
  return {
    candidates,
    // Said only when the world grounded a probe and refused every one of them: a
    // partial offer is not a dead end, and no refusal is invented for a tick with
    // nothing to expose.
    refusal: candidates.length === 0 ? (refusals[0] ?? null) : null,
  }
}

/** The candidate family plus the typed refusal that answers a `surface` goal. */
export interface SurfaceAscentResult {
  candidates: Candidate[]
  refusal: SurfaceAscentRefusal | null
}

/**
 * The vertical route a `surface` goal actually asks for.
 *
 * A `surface` goal (`recover_vertical_access`, `kind: 'surface'`, `targetY` from
 * `deriveUpperAccessTargetY`) promises "recover vertical access to y>=N". The
 * candidate layer used to answer it with level exploration MOVEs only: the
 * `default` branch of `generateRawCandidates` routes it through `mineCandidates`
 * (empty log pool when no log is sensed) and `retrievalCandidates`, whose
 * `surfaceSpot` can only name a standable cell the sensor saw - never higher than
 * `floor(self.y) + 1` (`buildTerrain` scans dy in [-1, +1]). Nothing enumerated
 * the ascent, so the Option could never satisfy and the body shuffled inside the
 * level set (measured: 144 x `MOVE:p3_6*` over 4 minutes, 0 ASCENT/PILLAR
 * markers, 1533 blocks travelled / 0.815 net).
 *
 * This enumerates the SAME grounded vertical route the MINE/RETRIEVE paths
 * already attach to an above target: reuse a remembered tunnel, cut an
 * up-staircase, or pillar with a held placeable block. It is CAN enumeration -
 * the route is appended alongside every other candidate, never an override and
 * never ranked. When no grounded plan exists it returns the typed
 * `SURFACE_ASCENT_REFUSED` refusal instead of silence, so the dead end is an
 * explicit fact the controller can surface/re-plan on.
 */
export function surfaceAscentCandidates(state: WorldState, options: CandidateOptions): SurfaceAscentResult {
  const current = state.goalQueue?.current ?? null
  if (current?.kind !== 'surface') return { candidates: [], refusal: null }
  const targetY =
    typeof current.targetY === 'number' && Number.isFinite(current.targetY) ? current.targetY : null
  if (targetY === null) return { candidates: [], refusal: null }
  return ascentRouteTo(state, options, {
    targetY,
    goalId: current.id,
    idPrefix: 'ASCEND:surface:',
    label: 'ascend toward the surface',
    extraMeta: { surfaceAscent: true, surfaceGoalId: current.id },
  })
}

/**
 * Goal-independent swim waypoints for a body with measured low air or unknown
 * breath while its eyes are underwater. Unlike the scaffold-oriented
 * `surface`/`habitat` routes, these MOVE candidates target only the sensor's
 * contiguous vertical water/air column; they spend no blocks and do not assert
 * that the waypoint itself is breathable.
 */
export function submersionAscentCandidates(state: WorldState, options: CandidateOptions): Candidate[] {
  if (!bodyNeedsBreathEscape(state.self)) return []
  const maxCandidates = options.maxMoveCandidates ?? DEFAULT_MAX_MOVE_CANDIDATES
  const targets = [...(state.submersionEscapeTargets ?? [])]
    .filter(
      (entry) =>
        entry.position.y > Math.floor(state.self.position.y) &&
        entry.position.y - Math.floor(state.self.position.y) <= 3,
    )
    .sort((a, b) => distance(a.position, state.self.position) - distance(b.position, state.self.position))
    .slice(0, maxCandidates)
  return targets.map((entry) => ({
    id: `ASCEND:breath:${blockId('p', entry.position)}`,
    kind: 'MOVE',
    label: `swim upward to observed ${entry.feetBlock}/${entry.headBlock} space at (${entry.position.x},${entry.position.y},${entry.position.z})`,
    targetName: null,
    target: entry.position,
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: distance(entry.position, state.self.eyePosition) <= options.reach,
    hasStandableAdjacent: false,
    meta: {
      tick: state.tick,
      submersionEscape: true,
      submersionEscapeReason: bodyIsOutOfAir(state.self) ? 'low_air' : 'head_wet_air_unknown',
      ...(typeof state.self.air === 'number' && Number.isFinite(state.self.air)
        ? { submersionAir: state.self.air }
        : {}),
      submersionFeetBlock: entry.feetBlock,
      submersionHeadBlock: entry.headBlock,
    },
  }))
}

/**
 * Passive land animals (cow, pig, sheep, chicken, rabbit) spawn on grass blocks
 * with sky access. Code-owned Minecraft spawn truth: in the 1.18+ overworld the
 * surface - and therefore grass - does not exist below sea level (y=63). A
 * hungry body below that band cannot be standing where animals are, so the only
 * grounded hunt route is a vertical one.
 *
 * Measured `run-mubj6ucc-si3e` (source d0ab2bd): health 1 at (23.3,53.0,8.9),
 * ledger `active g37:collect:food 0/3`, WHAT correctly chose `food`, and the
 * hunt was pursued entirely underground (`WAIT, WAIT, DESCEND:level:W:b22_53_9`)
 * where passive animals never spawn - so the food Option could never complete and
 * health never regenerated.
 */
export const ANIMAL_HABITAT_SEA_LEVEL = 63

/** Typed refusal: a hungry body with no grounded route up to animal habitat. */
export const FOOD_HABITAT_REFUSED = 'FOOD_HABITAT_REFUSED'

export function formatFoodHabitatRefused(refusal: SurfaceAscentRefusal): string {
  return (
    `${FOOD_HABITAT_REFUSED} goal=${refusal.goalId} reason=${refusal.reason} fromY=${refusal.fromY} ` +
    `toY=${refusal.toY} cell=${refusal.cell.x},${refusal.cell.y},${refusal.cell.z} ` +
    `-> no grounded route to animal habitat; the hunt cannot progress underground`
  )
}

/**
 * The hungry body's vertical route to animal habitat.
 *
 * Fires only when the resident is hungry, holds no food, has NO sensed food
 * animal in range, and is BELOW the habitat band - i.e. exactly the state where
 * the hunt has no grounded route at all and would otherwise degenerate to
 * WAIT/DESCEND. At or above the band the body is already where animals can spawn,
 * so no upward route is offered (see the band check below). It reuses the SAME
 * `planVerticalApproachDetailed` machinery (and therefore
 * reuse/staircase-up/pillar) as the `surface` goal and the MOVE/RETRIEVE
 * ascents, and returns the same typed refusal when no plan exists. CAN
 * enumeration only: the route is appended alongside every other candidate and
 * never overrides or ranks one.
 */
export function foodHabitatAscent(state: WorldState, options: CandidateOptions): SurfaceAscentResult {
  const heldFood = pickFood(state)
  if (heldFood !== null || state.self.food > options.eatBelowFood) return { candidates: [], refusal: null }
  // The premise this arm rests on is OVERWORLD spawn truth, and the arm itself
  // says so ("passive animals need grass with sky access, and in the 1.18+
  // overworld that surface does not exist below sea level"). No other dimension
  // has that band: the Nether has no grass-surface passive spawn at all, so
  // ascending toward sea level there is a route to nowhere. Measured live (fresh
  // run on 3570c79): a hungry body IN THE NETHER climbed to y102 chasing this
  // band while no passive animal can exist there - the futile half of the same
  // class the level scan and contact-ascent work fixed for real targets. The food
  // gap itself stays typed: `FOOD_SOURCE_NONE` still reports sensedAnimal=false.
  const habitatDimension = (state.self.dimension ?? '').replace(/^minecraft:/, '')
  if (habitatDimension.length > 0 && habitatDimension !== 'overworld') {
    return { candidates: [], refusal: null }
  }
  const foodHuntRange = options.foodHuntRange ?? DEFAULT_FOOD_HUNT_RANGE
  const animalSensed = state.entities.some(
    (entity) => !entity.hostile && FOOD_ANIMALS.has(entity.name) && entity.distance <= foodHuntRange,
  )
  if (animalSensed) return { candidates: [], refusal: null }
  // The arm's ONLY grounded premise is Minecraft spawn truth: passive animals
  // need grass with sky access, and in the 1.18+ overworld that surface does not
  // exist below sea level. A body already AT or ABOVE the band is standing in the
  // band, so climbing higher has no grounded reason - and inside a leaf canopy
  // "higher" is the treetop. Measured live (run-mubobiq6-12onv): `food = 0` held
  // for hours, the body sat in an oak canopy at y=74-78, and this arm kept
  // offering `ASCEND:habitat:p76_78_12` (own-column pillar) up a tree it had no
  // reason to be in. A body genuinely below the band still gets the route, and a
  // plan-less band ascent still returns its typed `FOOD_HABITAT_REFUSED`.
  if (Math.floor(state.self.position.y) >= ANIMAL_HABITAT_SEA_LEVEL) return { candidates: [], refusal: null }
  const hinted =
    typeof options.foodHabitatY === 'number' && Number.isFinite(options.foodHabitatY)
      ? options.foodHabitatY
      : sensedSurfaceY(state)
  const targetY = Math.max(ANIMAL_HABITAT_SEA_LEVEL, hinted ?? ANIMAL_HABITAT_SEA_LEVEL)
  const current = state.goalQueue?.current ?? null
  const goalId = current?.id ?? 'food-habitat'
  return ascentRouteTo(state, options, {
    targetY,
    goalId,
    idPrefix: 'ASCEND:habitat:',
    label: 'ascend toward animal habitat (grass + sky)',
    extraMeta: { foodHabitat: true, foodHabitatGoalId: goalId },
  })
}

/**
 * The highest Y among the surface structures the body can SEE right now (a
 * NEAR-FIELD sensed station - `isSensedStation`), or null when it sees none.
 *
 * This is the grounded "I can see the real surface from here" hint that turns
 * the sea-level floor into the local surface, so a hungry ascent lands next to
 * grass instead of inside a dirt column. Only SENSED cells qualify: the route
 * this hint feeds climbs the BODY'S OWN column, and a durable remembered station
 * can be hundreds of blocks away at a different altitude (measured live
 * run-mubobiq6-12onv: a remembered `crafting_table` at (-50,79,-7) raised the
 * own-column habitat target to y=79, so a hungry body at y=73 pillared straight
 * up through an oak canopy toward an altitude that had nothing to do with where
 * it stood). A remembered cell is real, but it is not evidence about the terrain
 * above the body. Pure: it reads only the sensed world state, never a global.
 */
function sensedSurfaceY(state: WorldState): number | null {
  let best: number | null = null
  const consider = (y: unknown): void => {
    if (typeof y !== 'number' || !Number.isFinite(y)) return
    best = best === null ? y : Math.max(best, y)
  }
  for (const station of state.craftingTables ?? []) if (isSensedStation(station)) consider(station.y)
  for (const station of state.furnaces ?? []) if (isSensedStation(station)) consider(station.y)
  return best
}

/**
 * The shared grounded vertical route: an own-column target Y, the SAME
 * `planVerticalApproachDetailed` plan the controller's pure refusal
 * (`ascentRefusedByPlan`) describes, and one MOVE candidate carrying the plan
 * meta. `idPrefix`/`label`/`extraMeta` are the only per-caller differences, so a
 * `surface` goal and a hungry hunt cannot drift into two implementations of the
 * same ascent.
 */
function ascentRouteTo(
  state: WorldState,
  options: CandidateOptions,
  spec: {
    targetY: number
    goalId: string
    idPrefix: string
    label: string
    extraMeta: Record<string, string | number | boolean>
  },
): SurfaceAscentResult {
  const own = state.self.position
  const feet = { x: Math.floor(own.x), y: Math.floor(own.y), z: Math.floor(own.z) }
  if (spec.targetY - own.y <= VERTICAL_GAP) return { candidates: [], refusal: null }
  const target = { x: feet.x, y: spec.targetY, z: feet.z }
  const decision = planVerticalApproachDetailed(verticalInputFor(state, target))
  if (decision.plan === null) {
    const refusal = decision.ascentRefusal
    if (refusal === null) return { candidates: [], refusal: null }
    return {
      candidates: [],
      refusal: {
        reason: refusal.reason,
        goalId: spec.goalId,
        fromY: refusal.fromY,
        toY: refusal.toY,
        cell: refusal.cell,
      },
    }
  }
  const plan = decision.plan
  const targetCell =
    plan.kind === 'pillar' ? { x: feet.x, y: plan.toY, z: feet.z } : plan.kind === 'reuse' ? plan.tunnel : plan.step
  const tunnelFallback =
    plan.kind === 'reuse' ? planVerticalApproach({ ...verticalInputFor(state, target), tunnel: null }) : null
  const verticalMeta = {
    ...verticalPlanMeta(plan, feet.y, spec.targetY),
    ...(plan.kind === 'reuse' ? fallbackVerticalMeta(tunnelFallback) : {}),
  }
  const planHarvest = plan.kind === 'staircase' ? resolveHarvest(loadGameData(), plan.digName ?? '') : null
  const digTool =
    plan.kind === 'staircase'
      ? selectClearanceTool(
          {
            name: plan.digName ?? '',
            harvestTool: plan.harvestTool ?? null,
            harvestTier: plan.harvestTier ?? null,
            diggable: true,
            knownBlock: planHarvest !== null && planHarvest.yield !== null,
          },
          (tool, tier) => hasTool(state, tool, tier),
        )
      : null
  return {
    candidates: [
      {
        id: `${spec.idPrefix}${blockId('p', targetCell)}`,
        kind: 'MOVE',
        label: `${spec.label} y>=${spec.targetY}${verticalPlanLabel(plan)}`,
        targetName: null,
        target: targetCell,
        targetEntityId: null,
        itemName: null,
        // A staircase is a clearance action. The selected tool is an optional
        // speed preference; the harvest tier controls drops, not breakability.
        requiresTool: false,
        toolName: digTool !== null && digTool.ok ? digTool.tool : null,
        toolTier: plan.kind === 'staircase' ? plan.harvestTier : null,
        inReach: distance(targetCell, state.self.eyePosition) <= options.reach,
        hasStandableAdjacent: true,
        meta: {
          tick: state.tick,
          x: targetCell.x,
          y: targetCell.y,
          z: targetCell.z,
          ...spec.extraMeta,
          ascentTargetY: spec.targetY,
          ...(plan.kind === 'staircase' || plan.kind === 'staircase-up' ? { clearance: true } : {}),
          ...verticalMeta,
        },
      },
    ],
    refusal: null,
  }
}

/**
 * A MINE whose target block NAME is a declared scanned source of the focus
 * advances the goal even when the block's own drop name differs: `flint` is
 * sourced from `gravel`, and gravel drops gravel (flint only probabilistically).
 * This mirrors {@link scannedBlockNames} — the same mapping the scanner used to
 * sense the block — and is CAN/TRUE only: it never ranks among actions and it
 * excludes structure fabric (`nether_bricks` does not yield `blaze_rod`).
 */
function mineSourceAdvancesFocus(focusItem: string | null, candidate: Candidate): boolean {
  if (focusItem === null) return true
  const want = retrievalWant(focusItem)
  if (want === null || want.kind !== 'ore') return false
  return typeof candidate.targetName === 'string' && want.blockNames.includes(candidate.targetName)
}

/**
 * Canopy-pocket escape: a solid block above the bot vetoes every jump, so a
 * required step-up route cannot be walked. Mine the ceiling block(s) to open
 * the headroom. Only offered when the current goal has no in-reach MINE (i.e.
 * the only way forward is navigation), so normal mining keeps priority.
 */
function headroomCandidates(state: WorldState, options: CandidateOptions): Candidate[] {
  const failureLimit = options.moveFailureLimit ?? DEFAULT_CANDIDATE_MOVE_FAILURE_LIMIT
  // Live wedge on main 7acd849: `collect 1 x log` at y=33 re-offered the stone
  // ceiling MINE 30x while every dig timed out (dig_timeout), because the
  // clearance candidate ignored failure memory. A cut that has exhausted the
  // same retry budget every other target honours is not executable now; the
  // log route / exploration fallback must take over.
  const observedCuts = state.headroomCuts ?? []
  // New sensor states distinguish the exact cell currently intersecting the
  // player's AABB from neighbouring clearance observations retained across a
  // small shuffle. Only the binding current-footprint blocker is an executable
  // headroom acquisition. Exposing the neighbours as peer MINE choices made Jev
  // excavate a room per ascent (live y55-y58) even though CAN named one blocker.
  // Legacy replay fixtures have no metadata, so preserve their historical pool.
  const hasFootprintMetadata = observedCuts.some((cut) => cut.currentFootprint !== undefined)
  const isProtected = protectedResourceTest(state)
  const cuts = observedCuts.filter(
    (cut) =>
      (!hasFootprintMetadata || cut.currentFootprint === true) &&
      cut.safe &&
      !isProtected(cut.pos, cut.name) &&
      failureCount(state.signals.failedCandidates, `MINE:${blockId('b', cut.pos)}`) < failureLimit,
  )
  if (cuts.length === 0) return []
  const feet = {
    x: Math.floor(state.self.position.x),
    y: Math.floor(state.self.position.y),
    z: Math.floor(state.self.position.z),
  }
  return cuts.slice(0, 2).flatMap((cut) => {
    // Clearance only requires the block to be mechanically diggable. A harvest
    // tool is an optional speed preference because these drops are not the goal.
    const barrier = cellHarvestBarrier(state, cut.pos)
    const profile = resolveHarvest(loadGameData(), cut.name)
    const choice = selectClearanceTool(
      {
        name: cut.name,
        harvestTool: barrier?.requiredTool ?? profile.harvestTool,
        harvestTier: barrier?.requiredTier ?? profile.harvestTier,
        diggable: true,
        knownBlock: profile.yield !== null,
      },
      (tool, tier) => hasTool(state, tool, tier),
    )
    if (!choice.ok) return []
    return [{
      id: `MINE:${blockId('b', cut.pos)}`,
      kind: 'MINE' as const,
      label: `mine the ${cut.name} ceiling block at (${cut.pos.x},${cut.pos.y},${cut.pos.z}) to open jump headroom and escape the pocket`,
      targetName: cut.name,
      target: cut.pos,
      targetEntityId: null,
      itemName: null,
      requiresTool: false,
      toolName: choice.tool,
      toolTier: choice.tier,
      inReach: distance(cut.pos, state.self.eyePosition) <= options.reach,
      hasStandableAdjacent: true,
      meta: {
        tick: state.tick,
        x: cut.pos.x,
        y: cut.pos.y,
        z: cut.pos.z,
        clearance: true,
        toolReason: choice.reason,
        requiresPickup: false,
        yieldItem: cut.name,
        distance: Math.hypot(cut.pos.x + 0.5 - feet.x, cut.pos.z + 0.5 - feet.z),
      },
    }]
  })
}

/**
 * A `STEP` candidate removes the upper block of an adjacent 2-block vertical
 * face, turning it into a 1-block step. Without it the offered MOVE stand spot
 * is behind a rise no vanilla client can climb (jump apex 1.2522), so the route
 * is simply not executable.
 */
function stepCutCandidates(state: WorldState, options: CandidateOptions): Candidate[] {
  const isProtected = protectedResourceTest(state)
  const cuts = (state.stepCuts ?? []).filter((cut) => cut.safe && !isProtected(cut.cut, cut.name))
  if (cuts.length === 0) return []
  const focus = state.goalQueue?.current?.targetItem ?? state.goal.targetItem ?? null
  const target = nearestResource(state, focus)
  const feet = {
    x: Math.floor(state.self.position.x),
    y: Math.floor(state.self.position.y),
    z: Math.floor(state.self.position.z),
  }
  const scored: Array<{
    cut: NonNullable<WorldState['stepCuts']>[number]
    score: number
    tool: HarvestTool | null
    tier: number | null
    toolReason: string
  }> = []
  const standKey = cellKey(state.self.position)
  for (const cut of cuts) {
    const known = state.blocks.find(
      (block) =>
        block.position.x === cut.cut.x && block.position.y === cut.cut.y && block.position.z === cut.cut.z,
    )
    // The cell's harvest truth comes from every sensor pool, not only the
    // resource index. The registry confirms the cut name is a known block; its
    // harvest tool remains only an optional speed preference for clearance.
    const barrier = cellHarvestBarrier(state, cut.cut)
    const harvestTool = barrier?.requiredTool ?? known?.harvestTool ?? null
    const harvestTier = barrier?.requiredTier ?? known?.harvestTier ?? null
    const profile = resolveHarvest(loadGameData(), cut.name)
    const choice = selectClearanceTool(
      { name: cut.name, harvestTool, harvestTier, diggable: true, knownBlock: profile.yield !== null },
      (candidateTool, candidateTier) => hasTool(state, candidateTool, candidateTier),
    )
    if (!choice.ok) continue
    // The same 1-block step cut that just proved it changes nothing from this
    // body cell is not re-offered: the identity is (STEP, cut cell, stand cell,
    // dir/step route), so a different cut or a body that moved stays offerable.
    if (
      isZeroProgressRouteRepeat(state.signals.zeroProgressRoutes, {
        kind: 'STEP',
        targetKey: cellKey(cut.cut),
        standKey,
        routeSig: routeSignature({
          kind: 'STEP',
          id: `STEP:${cut.dir}:${blockId('b', cut.cut)}`,
          meta: {
            dir: cut.dir,
            stepX: cut.step.x,
            stepY: cut.step.y,
            stepZ: cut.step.z,
            // A step cut REMOVES the block in the step's own column, so the commitment's
            // EffectEnvelope must grant the dig (skillCommitment.ts derives
            // mayDigGroundedRoute from a declared dig). Measured before this line: the STEP
            // arm was the last one still refused fail-closed - `dig_cell_not_declared` and
            // `equip_item_not_declared` on STEP:* candidates, the residual an independent
            // audit found after the other five arms were fixed at their construction site.
            digStep: true,
            digStepReason: `step_cut:${cut.dir}`,
          },
        }),
        nowMs: state.timestampMs,
      })
    )
      continue
    let penalty = 0
    if (target !== null) {
      const tdx = target.position.x - feet.x
      const tdz = target.position.z - feet.z
      const dot = cut.dx * Math.sign(tdx) + cut.dz * Math.sign(tdz)
      penalty = dot > 0 ? 0 : 10
    }
    scored.push({ cut, score: penalty + distance(cut.step, state.self.position), tool: choice.tool, tier: choice.tier, toolReason: choice.reason })
  }
  if (scored.length === 0) return []
  scored.sort((a, b) => a.score - b.score)

  return scored.slice(0, 2).map(({ cut, tool, tier, toolReason }) => {
    return {
      id: `STEP:${cut.dir}:${blockId('b', cut.cut)}`,
      kind: 'STEP' as const,
      label: `cut a 1-block step into the ${cut.name} face (${cut.dir}) at (${cut.cut.x},${cut.cut.y},${cut.cut.z}); the blocked route becomes climbable`,
      targetName: cut.name,
      target: cut.cut,
      targetEntityId: null,
      itemName: null,
      requiresTool: false,
      toolName: tool,
      toolTier: tier,
      inReach: distance(cut.cut, state.self.eyePosition) <= options.reach,
      hasStandableAdjacent: true,
      meta: {
        tick: state.tick,
        x: cut.cut.x,
        y: cut.cut.y,
        z: cut.cut.z,
        dir: cut.dir,
        stepX: cut.step.x,
        stepY: cut.step.y,
        stepZ: cut.step.z,
        diggable: true,
        clearance: true,
        toolReason,
        // This arm builds the SAME kind of step cut as its sibling above (it removes
        // the cell it cuts into), so it must declare the dig for the same reason: the
        // commitment's EffectEnvelope derives mayDigGroundedRoute from a declared dig,
        // and without it the step's own dig is refused fail-closed
        // (`dig_cell_not_declared`, measured 94 times on STEP:* candidates after the
        // sibling arm was fixed - this was the last arm still missing the declaration).
        digStep: true,
        digStepReason: `step_cut:${cut.dir}`,
      },
    }
  })
}

/**
 * One grounded staircase/tunnel step toward the nearest target resource.
 *
 * #3: `target === null` no longer means "descend". A downward step needs positive
 * evidence (a visible target below, or a remembered stone/ore level below for a
 * stone/ore goal); otherwise only level steps are offered. A per-subgoal
 * no-progress budget (`signals.descendLimitReached`) is evidence that the
 * selected trajectory has stalled and returns recovery choice to Jev.
 *
 * A selected mode and heading are held while their safe continuation remains
 * grounded. An obstruction, recurrence, or exhausted path budget closes that
 * continuation and exposes the remaining mechanically valid routes as policy
 * candidates; this function never chooses a replacement mode or heading.
 */
function descendCandidates(
  state: WorldState,
  options: CandidateOptions,
  focusItem: string | null,
  tunnelTargets: readonly BlockState[],
  descendTargetY: number | null = null,
): Candidate[] {
  if (focusItem === null && descendTargetY === null) return []
  const nowMs = state.timestampMs
  const standKey = cellKey(state.self.position)
  // Zero-progress route memory: a descend step whose dig provably removed nothing
  // (`ACTION_ZERO_PROGRESS ... kind=DESCEND`) must not be re-attempted with the
  // same plan from the same body cell - that is the same action with unchanged
  // preconditions. Once ZERO_PROGRESS_STAND_ROUTE_LIMIT distinct down routes have
  // proved nothing at this stand cell, the family itself is withheld there so the
  // body must change its stand cell (a level/lateral step, MOVE, or the existing
  // bounded DESCEND_STALLED escalation) instead of sampling more cells forever.
  const standDownSpent = standFamilyExhausted(state.signals.zeroProgressRoutes, 'DESCEND', standKey, { nowMs })
  const steps = (state.descent ?? []).filter(
    (step) =>
      step.safe &&
      protectedStepProfileRefusal(state, strictStepDigProfile(state, step)) === null &&
      // A spent exact route and a spent family at this stand are hard evidence
      // that this particular down route cannot execute here. Keep the typed
      // remaining options; the family exhaustion itself must not install a
      // lateral-search strategy.
      !(standDownSpent && step.mode === 'down') &&
      !isZeroProgressRouteRepeat(state.signals.zeroProgressRoutes, {
        kind: 'DESCEND',
        targetKey: cellKey(descentPrimaryCell(step)),
        standKey,
        routeSig: descendStepRouteSignature(step),
        nowMs,
      }),
  )
  if (steps.length === 0) return []

  const target = tunnelTargets[0] ?? nearestResource(state, focusItem)
  const feet = {
    x: Math.floor(state.self.position.x),
    y: Math.floor(state.self.position.y),
    z: Math.floor(state.self.position.z),
  }
  const knownStoneY = state.signals.knownStoneY ?? null
  // A `structure` want's scanned source is built terrain (fortress fabric), not
  // an underground vein: a downward staircase/tunnel step cannot reach it and
  // must not be classified as an underground search. ORE sources and stone-class
  // focuses keep the historical underground verdict unchanged.
  const focusWant = focusItem === null ? null : retrievalWant(focusItem)
  const goalIsUnderground =
    focusItem !== null &&
    (STONE_YIELDS.has(focusItem) || (scannedBlockNames(focusItem) !== undefined && focusWant?.kind !== 'structure'))
  const stoneGoal = focusItem !== null && STONE_YIELDS.has(focusItem)

  // Feasibility (CAN) rule for a SPECIFIC focus item whose source is not
  // underground and has no sensed/tunnel target: a staircase or level tunnel
  // step cannot reach that source, so it is withheld instead of being re-offered
  // forever (live `collect 1 x flint (from gravel)` carved a tunnel network while
  // the goal never moved). Descending stays legitimate for underground resources
  // (`goalIsUnderground`: ore/obsidian/stone goals), for an explicit
  // `descend_to:Y` predicate (vertical recovery), for a sensed/tunnel target, and
  // for resource-class goals (early-game `log`/`planks` keep the historical
  // behaviour). Withholding only; the remaining candidates keep their order.
  const focusIsSpecific = focusItem !== null && !isResourceClass(focusItem)
  const hasGoalTarget = target !== null || tunnelTargets.length > 0
  if (focusIsSpecific && descendTargetY === null && !goalIsUnderground && !hasGoalTarget) return []

  const targetBelow = target !== null && target.position.y < feet.y
  const knownStoneBelow = knownStoneY !== null && knownStoneY < feet.y && goalIsUnderground
  // #41: an explicit descend predicate is positive evidence for a downward step
  // even when no ore is visible, and (unlike a collect goal) it does not need one.
  const descendToY = descendTargetY !== null && state.self.position.y > descendTargetY
  const downEvidence = descendToY || targetBelow || (target === null && (knownStoneBelow || stoneGoal))
  const oscillate = state.signals.digOscillate === true
  const budgetExhausted = state.signals.descendLimitReached === true
  const fixedDir = state.signals.digDir ?? null
  const fixedMode = state.signals.digMode ?? null
  const fixedCount = state.signals.digDirCount ?? 0

  const base = steps.filter((step) => downEvidence || step.mode !== 'down')
  if (base.length === 0) return []
  // The level-path budget is a hard bound on continuing the SAME selected
  // direction/mode. It does not erase a different heading or mode that the world
  // still grounds; those choices are returned to π as new candidates.
  const withinPathBudget = base.filter(
    (step) =>
      step.mode !== 'level' ||
      step.dir !== fixedDir ||
      fixedMode !== 'level' ||
      fixedCount < DIG_PATH_CAP,
  )
  const failureLimit = options.descendFailureLimit ?? DEFAULT_CANDIDATE_DESCEND_FAILURE_LIMIT
  const available = withinPathBudget.filter(
    (step) => failureCount(state.signals.failedCandidates, descendId(step)) < failureLimit,
  )
  if (available.length === 0) return []

  const sameSkillContinuation =
    fixedDir === null || fixedMode === null
      ? []
      : available.filter((step) => step.dir === fixedDir && step.mode === fixedMode)
  let boundaryReason: string | null = null
  let offeredSteps = available
  if (budgetExhausted) {
    boundaryReason = 'descent_budget_exhausted'
    offeredSteps = endRecoveryContinuation(available, fixedDir, fixedMode)
  } else if (oscillate) {
    boundaryReason = 'recurrent_descent_trajectory'
    offeredSteps = endRecoveryContinuation(available, fixedDir, fixedMode)
  }
  else if (fixedDir !== null && fixedMode !== null && sameSkillContinuation.length === 0) {
    boundaryReason =
      fixedMode === 'level' && fixedCount >= DIG_PATH_CAP
        ? 'selected_path_budget_exhausted'
        : 'selected_descent_blocked_or_spent'
  } else if (fixedDir !== null && fixedMode !== null) {
    offeredSteps = sameSkillContinuation
    if (offeredSteps.length > 1) boundaryReason = 'multiple_grounded_same_skill_routes'
  } else if (available.length > 1) {
    boundaryReason = 'multiple_grounded_descent_routes'
  }

  const obstruction = fixedDir === null ? null : headingObstructionFor(state.descent ?? [], fixedDir, fixedMode, fixedCount)
  const terminalOutcome = boundaryReason === null ? null : descentRecoveryOutcome(boundaryReason)
  const grounded: Candidate[] = []
  for (const step of offeredSteps) {
    const heading = descentHeadingForStep(step.dir, fixedDir, obstruction, oscillate, budgetExhausted, fixedMode, fixedCount)
    const built = descendCandidateFromStep(state, options, step, {
      focusItem,
      descendTargetY,
      grounded: descendToY || hasGoalTarget || knownStoneBelow || stoneGoal,
      // This describes the candidate's geometry, not a recovery strategy.
      staircase: step.mode === 'down' && (step.dx !== 0 || step.dz !== 0),
      heading,
      ...(boundaryReason === null
        ? {}
        : {
            extraMeta: {
              recoveryBoundaryReason: boundaryReason,
              recoveryAlternatives: offeredSteps.length,
              ...(terminalOutcome === null ? {} : { skillOutcome: terminalOutcome }),
            },
          }),
    })
    if (built !== null) grounded.push(built.candidate)
  }

  const policyBoundary = descentPolicyBoundary(grounded, boundaryReason)
  if (policyBoundary !== null) {
    for (const candidate of grounded) candidate.meta.legPolicyBoundary = policyBoundary
  }
  return grounded
}

function descentHeadingForStep(
  dir: DescentDir,
  previous: DescentDir | null,
  obstruction: DescentHeadingObstruction | null,
  oscillating: boolean,
  budgetExhausted: boolean,
  previousMode: DigMode | null,
  previousCount: number,
): DescentHeadingPlan {
  if (previous === null) return { dir, status: 'new', from: null, change: null }
  if (previous === dir) return { dir, status: 'held', from: previous, change: null }
  const reason: DescentHeadingChangeReason = oscillating
    ? 'oscillation'
    : budgetExhausted
      ? 'budget'
      : previousMode === 'level' && previousCount >= DIG_PATH_CAP
        ? 'cap'
        : (obstruction?.reason ?? 'no_step')
  return {
    dir,
    status: 'changed',
    from: previous,
    change: {
      from: previous,
      to: dir,
      reason,
      cell: obstruction?.cell ?? null,
      block: obstruction?.block ?? null,
    },
  }
}

function descentPolicyBoundary(candidates: readonly Candidate[], reason: string | null): string | null {
  if (candidates.length === 0 || (reason === null && candidates.length < 2)) return null
  const alternatives = candidates.map((candidate) => {
    const position = candidate.target
    return `${String(candidate.meta.mode)}:${String(candidate.meta.dir)}@${position === null ? 'unknown' : `${position.x},${position.y},${position.z}`}`
  })
  return formatSkillPolicyBoundary({
    skill: 'DESCEND(groundedRoute)',
    reason: reason ?? 'multiple_grounded_descent_routes',
    alternatives,
  })
}

/** Close the current direction/mode contract when its budget or recurrence fired. */
function endRecoveryContinuation(
  steps: readonly DescentOption[],
  fixedDir: DescentDir | null,
  fixedMode: DigMode | null,
): DescentOption[] {
  if (fixedDir === null || fixedMode === null) return [...steps]
  return steps.filter((step) => step.dir !== fixedDir || step.mode !== fixedMode)
}

function descentRecoveryOutcome(reason: string): DescentRecoveryOutcome | null {
  if (reason === 'descent_budget_exhausted' || reason === 'selected_path_budget_exhausted') {
    return 'BUDGET_EXHAUSTED'
  }
  if (reason === 'recurrent_descent_trajectory') return 'RECURRENT_STATE'
  if (reason === 'selected_descent_blocked_or_spent' || reason === 'selected_column_descent_blocked_or_spent') {
    return 'BLOCKED'
  }
  return null
}

/**
 * Why the held heading could not continue: the sensor's typed refusal when the
 * world obstructs it, or `cap` when the level path budget was spent. This is
 * evidence attached to each policy-selected alternative, never a code selection.
 */
function headingObstructionFor(
  steps: readonly DescentOption[],
  dir: DescentDir,
  fixedMode: DigMode | null,
  fixedCount: number,
): DescentHeadingObstruction {
  const found = descentHeadingObstruction(steps, dir)
  if (found.reason !== 'no_step') return found
  return { reason: fixedMode === 'level' && fixedCount >= DIG_PATH_CAP ? 'cap' : 'no_step', cell: null, block: null }
}

function descendId(step: DescentOption): string {
  const primary = step.mode === 'down' ? step.floor : step.wall
  return `DESCEND:${step.mode}:${step.dir}:${blockId('b', primary)}`
}

/**
 * The exact route signature `descendCandidateFromStep` will attach to this step's
 * candidate, derived from the step itself so the pre-selection filter and the
 * settled outcome agree on what "this same descend action" means. The primary cell
 * is the canonical `descentPrimaryCell` the builder uses for `target`/`dig*`.
 */
function descendStepRouteSignature(step: DescentOption): string {
  const primary = descentPrimaryCell(step)
  return routeSignature({
    kind: 'DESCEND',
    id: descendId(step),
    meta: {
      mode: step.mode,
      dir: step.dir,
      digX: primary.x,
      digY: primary.y,
      digZ: primary.z,
      stepX: step.step.x,
      stepY: step.step.y,
      stepZ: step.step.z,
    },
  })
}

/**
 * The STRICT dig feasibility of one sensor step: its whole 1x2 profile folded into
 * the strongest harvest requirement and resolved against the held tools. This is
 * the single gate both the DESCEND candidate builder (`descendCandidateFromStep`,
 * which may relax it for a stranded body's escape dig) and `planDigRoute`'s step
 * probe (`digRouteCandidate`) use, so the step the dig route picks can never be a
 * step the builder then refuses - that disagreement is exactly how a route arm
 * ends up offering nothing while a legal detour step exists.
 */
/**
 * True only for a cell we KNOW is open air. An EMPTY name is an unloaded or unknown
 * cell, and unknown is never satisfied (the repo's standing rule) - treating it as
 * air would let a step into a cell nobody has read. Measured while fixing the
 * `air needs a tool tier 0` refusal: a filter that accepted `''` as air also
 * un-gated ordinary terrain, which a level-scan fixture caught immediately.
 */
function isOpenAirName(name: string | null | undefined): boolean {
  return name === 'air' || name === 'cave_air' || name === 'void_air'
}

function strictStepDigProfile(
  state: WorldState,
  step: DescentOption,
): {
  digPlan: ReturnType<typeof descentDigPlan>
  primary: Vec3Json
  requirement: ReturnType<typeof strongestDigRequirement> | null
  choice: ReturnType<typeof selectDigTool>
  clearanceChoice: ReturnType<typeof selectClearanceTool>
} {
  const digPlan = descentDigPlan(step)
  const primary = descentPrimaryCell(step)
  // The gate is the STRONGEST cell of the 1x2 profile: a step with a stone front
  // and a dirt floor is not diggable without a pickaxe, and offering it anyway
  // produced a dig that could not finish (measured live: every cardinal step dug
  // its floor, then `PATH_CALLBACK outcome=noPath|stuck`).
  //
  // A cell that is ALREADY EMPTY is excluded first: there is nothing to remove, so
  // it can never be the profile's requirement. Leaving it in made the strongest
  // requirement "not diggable" (air is `diggable:false`), and the arm then refused
  // with the nonsense detail `air needs a tool tier 0` - measured live 203 times in
  // one run, every time on a profile whose front was already open, which is exactly
  // the state where the step should simply be taken. A tool is required for rock,
  // never for air.
  const requirement = strongestDigRequirement(
    digPlan
      .filter((item) => !isOpenAirName(item.name))
      .map((item) => ({
        name: item.name ?? '',
        harvestTool: item.harvestTool ?? null,
        harvestTier: item.harvestTier ?? null,
        diggable: item.diggable,
      })),
  )
  const choice = selectDigTool(
    {
      name: requirement.name ?? '',
      harvestTool: requirement.harvestTool ?? null,
      harvestTier: requirement.harvestTier ?? null,
      diggable: requirement.diggable === true,
    },
    (tool, tier) => hasTool(state, tool, tier),
  )
  const requirementHarvest = resolveHarvest(loadGameData(), requirement.name ?? '')
  const clearanceChoice = selectClearanceTool(
    {
      name: requirement.name ?? '',
      harvestTool: requirement.harvestTool ?? null,
      harvestTier: requirement.harvestTier ?? null,
      diggable: requirement.diggable === true,
      knownBlock: requirementHarvest.yield !== null,
    },
    (tool, tier) => hasTool(state, tool, tier),
  )
  return { digPlan, primary, requirement, choice, clearanceChoice }
}

/** A descent's entire dig profile must preserve stations and live structures. */
function protectedStepProfileRefusal(
  state: WorldState,
  profile: ReturnType<typeof strictStepDigProfile>,
  fallbackBlock: string | null = null,
): { block: string | null; detail: string } | null {
  const isProtected = protectedResourceTest(state)
  for (const cell of profile.digPlan) {
    if (!isProtected(cell.cell, cell.name ?? null)) continue
    const name = cell.name ?? ''
    return {
      block: name.length > 0 ? name : fallbackBlock,
      detail: isProtectedStationBlock(name)
        ? `${name} at (${cell.cell.x},${cell.cell.y},${cell.cell.z}) is a protected station`
        : `(${cell.cell.x},${cell.cell.y},${cell.cell.z}) is a member of a live structure`,
    }
  }
  return null
}

/**
 * One DESCEND candidate from an already-safe step. Shared by the goal-grounded
 * descent family (`descendCandidates`) and the stranded-column descent
 * (`columnDescentCandidates`), so a body descending toward a resource and a body
 * descending off its own support column execute through exactly the same
 * mechanics, guard and postcondition. Returns null when the step's block needs a
 * known, mechanically diggable block; a harvest tool is only an optional
 * speed preference because route clearance does not require the block's drops.
 */
function descendCandidateFromStep(
  state: WorldState,
  options: CandidateOptions,
  best: DescentOption,
  spec: {
    focusItem: string | null
    descendTargetY: number | null
    grounded: boolean
    staircase: boolean
    /** the selected heading and any typed obstruction being crossed */
    heading?: DescentHeadingPlan
    extraMeta?: Record<string, string | number | boolean>
  },
): { candidate: Candidate; toolReason: string } | null {
  const profile = strictStepDigProfile(state, best)
  // This is the shared fail-closed boundary for every DESCEND family. Some
  // callers report the typed refusal before reaching this builder; the builder
  // also protects future callers and newly exposed candidate arms.
  if (protectedStepProfileRefusal(state, profile) !== null) return null
  const digPlan = profile.digPlan
  const primary = profile.primary
  const requirement = profile.requirement
  const choice = profile.clearanceChoice
  if (!choice.ok) return null
  const toward =
    spec.focusItem ?? (spec.descendTargetY === null ? 'unknown' : `descend_to:Y=${spec.descendTargetY}`)
  const headingDir = spec.heading?.dir ?? best.dir
  const headingLine = spec.heading === undefined ? null : formatDescentHeading(spec.heading)
  const digList = digPlan.map((item) => `${item.cell.x},${item.cell.y},${item.cell.z}`).join(';')
  return {
    toolReason: choice.reason,
    candidate: {
      id: descendId(best),
      kind: 'DESCEND',
      label: `${best.dir === 'D' ? 'dig straight down' : best.mode === 'down' ? 'dig a staircase step down' : 'tunnel one block forward'} toward ${toward} (${best.dir}), dig (${primary.x},${primary.y},${primary.z}) then stand at (${best.step.x},${best.step.y},${best.step.z})`,
      targetName: spec.focusItem,
      target: primary,
      targetEntityId: null,
      itemName: null,
      requiresTool: false,
      toolName: choice.tool,
      toolTier: choice.tier,
      inReach: distance(primary, state.self.eyePosition) <= options.reach,
      hasStandableAdjacent: true,
      meta: {
        tick: state.tick,
        // Declared HERE, once, because this function only ever builds a DIG step
        // ("dig (x,y,z) then stand at ..."). The commitment's EffectEnvelope derives
        // `mayDigGroundedRoute` from a declared dig (skillCommitment.ts), so an arm that
        // forgot to declare one had its own dig refused fail-closed (`dig_cell_not_declared`)
        // and the route died at its first move. Measured before this line: 78 refusals in the
        // live run, 20 of them AFTER the level-scan arm was fixed individually - three of the
        // six arms (prospect, descend, column-descent) never declared it.
        // A separate flag, not `digRoute`: that name identifies the dig-ROUTE candidate
        // (the tunnel arm) and is read as such by the fixtures and the equip path.
        digStep: true,
        digStepReason: spec.focusItem === null ? 'focus:none' : `focus:${spec.focusItem}`,
        mode: best.mode,
        dir: best.dir,
        dx: best.dx,
        dz: best.dz,
        focusItem: spec.focusItem ?? 'unknown',
        predicate: spec.descendTargetY === null ? 'none' : `descend_to:Y=${spec.descendTargetY}`,
        descendTargetY: spec.descendTargetY ?? 'none',
        digBlockName: best.digName ?? 'unknown',
        toolReason: choice.reason,
        clearance: true,
        staircase: spec.staircase,
        stepX: best.step.x,
        stepY: best.step.y,
        stepZ: best.step.z,
        wallX: best.wall.x,
        wallY: best.wall.y,
        wallZ: best.wall.z,
        headX: best.head.x,
        headY: best.head.y,
        headZ: best.head.z,
        floorX: best.floor.x,
        floorY: best.floor.y,
        floorZ: best.floor.z,
        wallSolid: best.wallSolid,
        headSolid: best.headSolid,
        floorSolid: best.floorSolid,
        supportSolid: best.supportSolid === true,
        // The full 1x2 dig profile, passage first / primary last: the executor
        // digs exactly these cells, so the offered step and the executed step
        // cannot disagree about the shape being opened.
        digCells: digList,
        digCount: digPlan.length,
        profileTool: requirement?.harvestTool ?? choice.tool ?? 'hand',
        profileTier: requirement?.harvestTier ?? choice.tier ?? 0,
        // HEADING PLAN: the coherent heading of this descent and whether it was
        // held from the previous step or changed with a typed obstruction.
        planHeading: headingDir,
        planHeadingHeld: spec.heading === undefined ? true : spec.heading.status !== 'changed',
        ...(spec.heading?.change === null || spec.heading?.change === undefined
          ? {}
          : {
              headingChangeFrom: spec.heading.change.from,
              headingChangeReason: spec.heading.change.reason,
              headingChangeCell:
                spec.heading.change.cell === null
                  ? 'none'
                  : `${spec.heading.change.cell.x},${spec.heading.change.cell.y},${spec.heading.change.cell.z}`,
              headingChangeBlock: spec.heading.change.block ?? 'unknown',
            }),
        digX: primary.x,
        digY: primary.y,
        digZ: primary.z,
        diggable: true,
        safe: best.safe,
        grounded: spec.grounded,
        ...(headingLine === null ? {} : { headingLine }),
        ...(spec.extraMeta ?? {}),
      },
    },
  }
}

/**
 * The bounded descent off a body that is stranded on its own support column.
 *
 * `strandedOnColumn` (no standable cell beyond the body's own) is exactly the
 * state where `pickExplore` can offer no MOVE and no ordinary route exists. The
 * only body change the world allows is a controlled vertical step down, and the
 * sensor has already proved which ones are SAFE (`state.descent`: safe, diggable,
 * solid support under the landing cell, no hazard) - a one-block drop with
 * support, never a damaging fall. This family exposes those existing
 * `DescentOption`s as ordinary DESCEND candidates.
 *
 * General by construction: the trigger is the geometric "no walkable frontier"
 * fact (a 1-wide ledge, a 1x1 shaft and a self-built column are identical here),
 * the action is the shared DESCEND mechanics, and the choice stays with Jev.
 * Nothing here is pillar-, goal- or M3-specific, and no candidate is ever a
 * damaging drop: when no safe step exists the typed refusal says so instead.
 *
 * The `descendLimitReached` no-progress latch is deliberately NOT applied here.
 * That latch bounds blind SEARCH descent (which can carve an unbounded tunnel
 * network). A stranded body has nowhere else to go and this step is a verified
 * block removal plus a monotone Y change, re-planned from fresh state every
 * action; the bound is the safe-step fact itself (it is withdrawn the moment the
 * body is no longer stranded, the floor is not diggable, a hazard appears, or
 * the failure budget for the step is spent).
 */
function columnDescentCandidates(
  state: WorldState,
  options: CandidateOptions,
  focusItem: string | null,
): { candidates: Candidate[]; refusal: ColumnDescentRefusal | null } {
  if (!strandedOnColumn(state)) return { candidates: [], refusal: null }
  const feet = {
    x: Math.floor(state.self.position.x),
    y: Math.floor(state.self.position.y),
    z: Math.floor(state.self.position.z),
  }
  const safeDown = (state.descent ?? []).filter(
    (step) =>
      step.mode === 'down' &&
      step.safe &&
      step.diggable === true &&
      protectedStepProfileRefusal(state, strictStepDigProfile(state, step)) === null,
  )
  if (safeDown.length === 0) {
    return { candidates: [], refusal: { reason: 'no_safe_step', cell: feet } }
  }
  const fixedDir = state.signals.digDir ?? null
  const fixedMode = state.signals.digMode ?? null
  const fixedCount = state.signals.digDirCount ?? 0
  const oscillating = state.signals.digOscillate === true
  const failureLimit = options.descendFailureLimit ?? DEFAULT_CANDIDATE_DESCEND_FAILURE_LIMIT
  const retryable = safeDown.filter(
    (step) => failureCount(state.signals.failedCandidates, descendId(step)) < failureLimit,
  )
  if (retryable.length === 0) {
    return { candidates: [], refusal: { reason: 'exhausted', cell: feet } }
  }
  const sameSkillContinuation =
    fixedDir === null || fixedMode !== 'down'
      ? []
      : retryable.filter((step) => step.dir === fixedDir && step.mode === 'down')
  let boundaryReason: string | null = null
  let offeredSteps = retryable
  if (oscillating) {
    boundaryReason = 'recurrent_descent_trajectory'
    offeredSteps = endRecoveryContinuation(retryable, fixedDir, fixedMode)
    if (offeredSteps.length === 0) {
      return { candidates: [], refusal: { reason: 'recurrent', cell: feet } }
    }
  }
  else if (fixedDir !== null && fixedMode === 'down' && sameSkillContinuation.length === 0) {
    boundaryReason = 'selected_column_descent_blocked_or_spent'
  } else if (fixedDir !== null && fixedMode === 'down') {
    offeredSteps = sameSkillContinuation
    if (offeredSteps.length > 1) boundaryReason = 'multiple_grounded_column_steps'
  } else if (retryable.length > 1) {
    boundaryReason = 'multiple_grounded_column_descents'
  }

  const obstruction = fixedDir === null ? null : headingObstructionFor(state.descent ?? [], fixedDir, fixedMode, fixedCount)
  const terminalOutcome = boundaryReason === null ? null : descentRecoveryOutcome(boundaryReason)
  const candidates: Candidate[] = []
  let toolRefusal: DescentOption | null = null
  for (const step of offeredSteps) {
    const built = descendCandidateFromStep(state, options, step, {
      focusItem,
      descendTargetY: null,
      grounded: true,
      staircase: step.dx !== 0 || step.dz !== 0,
      heading: descentHeadingForStep(
        step.dir,
        fixedDir,
        obstruction,
        oscillating,
        false,
        fixedMode,
        fixedCount,
      ),
      extraMeta: {
        columnDescent: true,
        ...(boundaryReason === null
          ? {}
          : {
              recoveryBoundaryReason: boundaryReason,
              recoveryAlternatives: offeredSteps.length,
              ...(terminalOutcome === null ? {} : { skillOutcome: terminalOutcome }),
            }),
      },
    })
    if (built === null) toolRefusal ??= step
    else candidates.push(built.candidate)
  }
  if (candidates.length === 0) {
    if (toolRefusal !== null) {
      return {
        candidates: [],
        refusal: {
          reason: 'no_tool',
          cell: feet,
          tool: toolRefusal.digHarvestTool ?? null,
          tier: toolRefusal.digHarvestTier ?? null,
        },
      }
    }
    return { candidates: [], refusal: { reason: 'no_safe_step', cell: feet } }
  }
  const policyBoundary = descentPolicyBoundary(candidates, boundaryReason)
  if (policyBoundary !== null) {
    for (const candidate of candidates) candidate.meta.legPolicyBoundary = policyBoundary
  }
  return { candidates, refusal: null }
}

/** PLACE candidate for a held station at a grounded spot (used for self-placed stations). */
function placeStationCandidate(
  state: WorldState,
  options: CandidateOptions,
  item: string,
  spot: Vec3Json,
  purpose: string,
): Candidate {
  return {
    id: `PLACE:${item}:${blockId('p', spot)}`,
    kind: 'PLACE',
    label: `place ${item} at (${spot.x},${spot.y},${spot.z}), ${distance(spot, state.self.position)}m away, then ${purpose}`,
    targetName: item,
    target: spot,
    targetEntityId: null,
    itemName: item,
    requiresTool: false,
    toolName: null,
    inReach: distance(spot, state.self.eyePosition) <= options.reach,
    hasStandableAdjacent: true,
    meta: { tick: state.tick, x: spot.x, y: spot.y, z: spot.z, purpose },
  }
}

/** One held-station placement solve: an in-reach spot, or the typed reason it was refused. */
interface HeldStationPlacement {
  spot: Vec3Json | null
  refusal: PlaceRefusal | null
  /** grounded alternative offered instead of silence (approach MOVE / clear-headroom MINE) */
  alternative: Candidate | null
}

/**
 * True when a block placed at `cell` would intersect the bot's own body. Mirrors
 * the sensor's `nearBody < 1.0` rule in `buildPlacementSpots`, so the terrain
 * solve can never pick the cell the bot is standing in.
 */
function placementIntersectsBody(cell: Vec3Json, self: Vec3Json): boolean {
  return distance({ x: cell.x + 0.5, y: cell.y, z: cell.z + 0.5 }, self) < 1.0
}

/** Nearest-first known placement cells: the strict live spots plus the sensed standable terrain. */
function knownPlacementCells(state: WorldState): Vec3Json[] {
  const seen = new Set<string>()
  const cells: Vec3Json[] = []
  for (const cell of [...state.placementSpots, ...state.terrain.standable]) {
    const key = blockId('p', cell)
    if (seen.has(key)) continue
    seen.add(key)
    cells.push(cell)
  }
  cells.sort((a, b) => distance(a, state.self.position) - distance(b, state.self.position))
  return cells
}

/**
 * The known standable cell that walks the bot toward an out-of-reach placement
 * cell: nearest to the target among the cells strictly closer to the target than
 * the bot is now. The target itself is the last resort - arriving there
 * re-senses its neighbourhood and the next solve step finds a neighbouring cell.
 */
function placementApproachCell(
  state: WorldState,
  target: Vec3Json,
  blacklistedMoveTargets: ReadonlySet<string> | undefined,
): Vec3Json {
  const here = distance(state.self.position, target)
  const options = state.terrain.standable.filter(
    (cell) =>
      !placementIntersectsBody(cell, state.self.position) &&
      !isBlacklistedMoveTarget(state, blacklistedMoveTargets, cell) &&
      !(cell.x === target.x && cell.y === target.y && cell.z === target.z) &&
      distance(cell, target) < here,
  )
  options.sort((a, b) => distance(a, target) - distance(b, target))
  return options[0] ?? target
}

/** Grounded MOVE toward an out-of-reach placement cell; carries the refusal token in its meta. */
function placementApproachCandidate(
  state: WorldState,
  options: CandidateOptions,
  item: string,
  target: Vec3Json,
  purpose: string,
): Candidate {
  const approach = placementApproachCell(state, target, options.blacklistedMoveTargets)
  return {
    id: `MOVE:${blockId('p', approach)}`,
    kind: 'MOVE',
    label: `walk to (${approach.x},${approach.y},${approach.z}) to bring the placement cell (${target.x},${target.y},${target.z}) within reach, then place ${item} to ${purpose}`,
    targetName: null,
    target: approach,
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: distance(approach, state.self.position) <= options.reach,
    hasStandableAdjacent: true,
    meta: {
      tick: state.tick,
      x: approach.x,
      y: approach.y,
      z: approach.z,
      placeRefused: 'out_of_reach',
      placeRefusedCell: blockId('p', target),
      placeItem: item,
    },
  }
}

/** Grounded clear-headroom alternative: the safe ceiling MINE that opens placement space when the bot blocks it. */
function placementHeadroomAlternative(
  state: WorldState,
  options: CandidateOptions,
  refusal: PlaceRefusal,
): Candidate | null {
  const cut = headroomCandidates(state, options)[0]
  if (cut === undefined) return null
  return {
    ...cut,
    meta: {
      ...cut.meta,
      placeRefused: refusal.reason,
      placeRefusedCell: blockId('p', refusal.cell),
      placeItem: refusal.item,
    },
  }
}

/**
 * The mechanical held-station placement solve over the terrain the sensor already
 * knows:
 *
 *   1. the strict live spots (`placementSpots`) keep their old priority;
 *   2. otherwise a sensed standable cell (air + 2-block clearance + solid support)
 *      outside the bot's body is a placement cell when it is within reach;
 *   3. an out-of-reach valid cell refuses with `out_of_reach` and offers the
 *      approach MOVE; the bot's own body cell refuses with `no_clearance` and
 *      offers the clear-headroom MINE; no standable terrain at all refuses with
 *      `no_support` at the bot's unsupported head cell.
 */
function heldStationPlacement(
  state: WorldState,
  options: CandidateOptions,
  item: string,
  purpose: string,
): HeldStationPlacement {
  const failureCountFor = (cell: Vec3Json): number =>
    state.signals.failedCandidates[`PLACE:${item}:${blockId('p', cell)}`] ?? 0
  const retryLimit = options.placeSpotRetryLimit ?? DEFAULT_PLACE_SPOT_RETRY_LIMIT

  if (state.placementSpots.length > 0) {
    // A station is not placed from a submerged body position while a dry-access
    // spot exists (SAFE/CAN fact, see dryAwarePlacementSpots).
    const spot = dryAwarePlacementSpots(state).find((cell) => failureCountFor(cell) < retryLimit)
    if (spot !== undefined) return { spot, refusal: null, alternative: null }
  }

  let bodyCell: Vec3Json | null = null
  let outOfReach: Vec3Json | null = null
  for (const cell of knownPlacementCells(state)) {
    if (placementIntersectsBody(cell, state.self.position)) {
      bodyCell = bodyCell ?? cell
      continue
    }
    if (failureCountFor(cell) >= retryLimit) continue
    if (distance(cell, state.self.eyePosition) <= options.reach) {
      return { spot: cell, refusal: null, alternative: null }
    }
    outOfReach = outOfReach ?? cell
  }

  if (outOfReach !== null) {
    const refusal: PlaceRefusal = { item, reason: 'out_of_reach', cell: outOfReach }
    return { spot: null, refusal, alternative: placementApproachCandidate(state, options, item, outOfReach, purpose) }
  }

  if (bodyCell !== null) {
    const refusal: PlaceRefusal = { item, reason: 'no_clearance', cell: bodyCell }
    return { spot: null, refusal, alternative: placementHeadroomAlternative(state, options, refusal) }
  }

  const headCell: Vec3Json = {
    x: Math.floor(state.self.position.x),
    y: Math.floor(state.self.position.y) + 1,
    z: Math.floor(state.self.position.z),
  }
  const refusal: PlaceRefusal = { item, reason: 'no_support', cell: headCell }
  return { spot: null, refusal, alternative: placementHeadroomAlternative(state, options, refusal) }
}

/**
 * The absolute copy count the recipe planner must satisfy for `focusItem`.
 *
 * A `craft N x item` goal is only done once N copies are held, so the planner's
 * top-level requirement is `requiredCount`, not 1. The still-outstanding amount
 * is `requiredCount - haveCount`, and `planNextCraftStep` measures it against the
 * live inventory (`held >= want`), so the absolute count that the outstanding
 * amount is measured from is the correct argument. Anything that is not the
 * active goal item (a tool or a prerequisite craft) keeps the single-item
 * default.
 */
function craftGoalRequirement(state: WorldState, focusItem: string): number {
  const current = state.goalQueue?.current ?? null
  if (current === null || current.kind !== 'craft' || current.targetItem !== focusItem) return 1
  return Math.max(1, Math.floor(current.requiredCount))
}

/**
 * CRAFT/PLACE candidates driven by the pure recipe planner: exactly one grounded
 * step toward the current craft subgoal, or nothing when no step is executable
 * in this world state.
 */
function craftCandidates(
  state: WorldState,
  options: CandidateOptions,
  focusItem: string | null,
): CraftCandidatesResult {
  const none: CraftCandidatesResult = { candidates: [], placeRefusal: null }
  const recipes = options.recipes ?? null
  if (recipes === null || focusItem === null) return none
  // #58 keeps sensed-only semantics and is focus-aware; placespot supplied the result shape.
  const tableAvailable = sensedCraftingTableAvailable(state, options, focusItem)
  const want = craftGoalRequirement(state, focusItem)
  const plan = planNextCraftStep(recipes, focusItem, state.inventory.counts, tableAvailable, want)
  const op = plan.op

  // OPERATOR RULE (station-use-before-craft; measured live 2026-09-21):
  // `craft furnace` was queued while 26 crafting tables and 17 furnaces were
  // known, and the goal's own product was then CRAFTED. A station item the world
  // model already knows (or the bot holds) is never a craft target: the correct
  // route is the station-source ladder - place the held one, walk to a known one,
  // and, when every known cell was retired, the typed `craftStationGap` fact.
  // See `stationWorldTruth` for the rule and `craftStationGap` for the marker.
  const productStation = stationKindOfItem(focusItem)
  if (productStation !== null) {
    const truth = stationWorldTruth(state, options, productStation, focusItem)
    if (!stationCraftAllowed(truth)) {
      return stationAcquisitionCandidates(state, options, focusItem, productStation, `craft ${focusItem}`)
    }
  }

  // M2 craft deadlock: a recipe whose chosen variant needs a 3x3 station must
  // not collapse to WAIT while a usable table is held or remembered. Offer the
  // same station ladder the smelt prerequisite path uses before the plan;
  // falling through keeps (c) the existing craft-a-table-from-planks step.
  // #craft-ingredient-prereq: a missing ingredient route is merged in, so a
  // withheld station retrieval cannot starve a craft that still needs a log.
  if (!tableAvailable && planRequiresTable(recipes, focusItem, state.inventory.counts, want)) {
    const acquisition = tableAcquisitionCandidates(state, options, focusItem)
    const route = craftIngredientRoute(state, options, focusItem)
    const merged = route === null ? [...acquisition.candidates] : [...acquisition.candidates, ...route.candidates]
    // A remembered station is a grounded alternative, not a guarantee that its
    // route is mechanically reachable this tick. Preserve the 2x2 prerequisite
    // step as a second grounded candidate so the reachability gate can withdraw
    // only the bad retrieval route instead of collapsing the craft Option to
    // MOVE/WAIT. Jev still chooses between every surviving semantic action.
    //
    // OPERATOR RULE: that 2x2 step is the 2x2 CRAFT OF THE STATION ITSELF. When
    // the world model already holds a crafting_table the step is a duplicate and
    // is withheld - the ladder above (or the typed gap) is the whole answer.
    const fallbackPlan = planNextCraftStep(recipes, focusItem, state.inventory.counts, false, want)
    if (fallbackPlan.op !== null && !planStepCraftsKnownStation(state, options, fallbackPlan.op)) {
      const fallback = craftPlanStepCandidate(state, options, fallbackPlan.op, focusItem).candidate
      if (fallback !== null && !merged.some((candidate) => candidate.id === fallback.id)) merged.push(fallback)
    }
    if (merged.length > 0 || acquisition.placeRefusal !== null) return { candidates: merged, placeRefusal: acquisition.placeRefusal }
  }

  // #craft-ingredient-prereq: no variant is satisfiable from the live inventory
  // (the live shape: 2 planks < 3 and no log). Offer the deterministic producer
  // route for the missing ingredient instead of starving to a WAIT-only set.
  if (op === null) return { candidates: craftIngredientRoute(state, options, focusItem)?.candidates ?? [], placeRefusal: null }

  // OPERATOR RULE: when the ladder above had nothing to offer (every known
  // station retired) the plan's own step is the station craft itself. It is a
  // duplicate route and is withheld; the caller reports the typed gap.
  if (planStepCraftsKnownStation(state, options, op)) {
    const acquisition = tableAcquisitionCandidates(state, options, focusItem)
    return { candidates: acquisition.candidates, placeRefusal: acquisition.placeRefusal }
  }

  if (op.type === 'craft') {
    const nearestTable = state.craftingTables.find(isSensedStation) ?? null
    const table = op.requiresTable ? nearestTable : null
    // A station the bot must WALK to can be unreachable (a natural village table
    // behind a canopy / 2-block face). When the recipe needs a station, the bot
    // HOLDS its own crafting_table, the only known station is out of interaction
    // reach, and walking to it has already failed once, place our own station at
    // a nearby grounded spot instead. Gated on a prior failure so the common
    // walk-to-table path is untouched.
    const tableInReach = nearestTable !== null && distance(nearestTable, state.self.eyePosition) <= options.reach
    const holdsTable = (state.inventory.counts.crafting_table ?? 0) > 0
    const craftFailed = (state.signals.failedCandidates[`CRAFT:${op.item}`] ?? 0) > 0
    if (op.requiresTable && !tableInReach && holdsTable && craftFailed && state.placementSpots.length > 0) {
      const spot = dryAwarePlacementSpots(state).find(
        (candidate) =>
          (state.signals.failedCandidates[`PLACE:crafting_table:${blockId('p', candidate)}`] ?? 0) <
          (options.placeSpotRetryLimit ?? DEFAULT_PLACE_SPOT_RETRY_LIMIT),
      )
      if (spot !== undefined) {
        return {
          candidates: [placeStationCandidate(state, options, 'crafting_table', spot, `craft ${focusItem}`)],
          placeRefusal: null,
        }
      }
    }
  }

  const step = craftPlanStepCandidate(state, options, op, focusItem)
  return {
    candidates: step.candidate === null ? [] : [step.candidate],
    placeRefusal: step.refusal,
  }
}

/** The deterministic sourcing decision for one missing craft ingredient. */
interface CraftIngredientRoute {
  item: string
  missing: string
  /** `collect <spec>`, or `none` when no raw producer could be resolved */
  producer: string
  /**
   * The mob that drops `rawItem`, when its only grounded source is a mob drop
   * (`MOB_DROP_PRODUCERS`), else null. This is what turns "collect blaze_rod" -
   * an item with no block source at all - into a route a reader can act on.
   */
  producerMob: string | null
  candidates: Candidate[]
  /**
   * How many of `missing` the selected variant needs. Carried so the typed
   * refusal can name the item AND its count (`item=oak_log count=3`) instead of
   * an unactionable token; `selectCraftIngredients` already computes it.
   */
  missingCount: number
  /** true when the recipe descent stopped at the dependency depth cap */
  depthBoundHit: boolean
}

/** Immutable state of the ingredient recipe descent. */
interface IngredientDescent {
  recipes: RecipeIndex
  counts: Readonly<Record<string, number>>
  depth: number
  stack: ReadonlySet<string>
}

/**
 * Follow the recipe chain of a missing ingredient down to the first item with no
 * recipe (log <- planks <- stick <- pickaxe). Depth-bounded by the shared
 * dependency cap so a malformed cycle can never recurse forever; at the cap the
 * deepest item is still returned as a collect route rather than nothing.
 */
function rawProducerForNeed(
  need: CraftIngredientNeed,
  descent: IngredientDescent,
): { spec: string; depthBoundHit: boolean } | null {
  const concrete = need.cls === null ? need.item : collectItemForClass(need.cls)
  if (concrete === null) return null
  const spec = matchesResourceClass(concrete, 'log') ? 'log' : concrete
  const variants = descent.recipes.recipesFor(concrete)
  if (variants.length === 0) return { spec, depthBoundHit: false }
  if (descent.depth >= MAX_DEPENDENCY_DEPTH) return { spec, depthBoundHit: true }
  if (descent.stack.has(concrete)) return null
  const selection = selectCraftIngredients(variants, descent.counts)
  const next = selection?.missing[0]
  if (next === undefined) return null
  const stack = new Set(descent.stack)
  stack.add(concrete)
  return rawProducerForNeed(next, { ...descent, depth: descent.depth + 1, stack })
}

/** Grounded candidates for a raw collect spec: visible MINE/MOVE plus the remembered RETRIEVE route. */
function collectRouteCandidates(state: WorldState, options: CandidateOptions, spec: string): Candidate[] {
  const candidates = [...mineCandidates(state, options, spec, null)]
  const want = retrievalWant(spec)
  if (want !== null) candidates.push(...retrievalCandidatesForWant(state, options, want))
  return candidates
}

/**
 * The ingredient-sourcing route for a craft goal whose plan is not executable:
 * select the deterministic best recipe variant, descend to the raw producer of
 * the first missing ingredient and offer that collect route. Mirrors
 * `completeStartablePrerequisites` so the queue layer and the candidate layer
 * name the same producer. Null when nothing is missing or no route exists.
 */
function craftIngredientRoute(
  state: WorldState,
  options: CandidateOptions,
  focusItem: string,
): CraftIngredientRoute | null {
  const recipes = options.recipes ?? null
  if (recipes === null) return null
  const variants = recipes.recipesFor(focusItem)
  if (variants.length === 0) return null
  const selection = selectCraftIngredients(variants, state.inventory.counts)
  const missing = selection?.missing[0]
  if (missing === undefined) return null
  const missingLabel = missing.cls === null ? missing.item : missing.cls
  const raw = rawProducerForNeed(missing, { recipes, counts: state.inventory.counts, depth: 0, stack: new Set<string>() })
  if (raw === null) {
    return {
      item: focusItem,
      missing: missingLabel,
      producer: 'none',
      producerMob: null,
      candidates: [],
      missingCount: missing.count,
      depthBoundHit: false,
    }
  }
  return {
    item: focusItem,
    missing: missingLabel,
    producer: `collect ${raw.spec}`,
    producerMob: producerMobForItem(raw.spec),
    candidates: collectRouteCandidates(state, options, raw.spec),
    missingCount: missing.count,
    depthBoundHit: raw.depthBoundHit,
  }
}

/**
 * The mob that drops `item`, or null when its source is not a declared mob drop.
 * A stable, sorted spelling of every declared producer (`blaze`), so the same
 * world data always yields the same producer fact.
 */
export function producerMobForItem(item: string | null): string | null {
  if (item === null) return null
  const producers = MOB_DROP_PRODUCERS[item]
  if (producers === undefined) return null
  return [...producers].sort().join('|')
}

/** The one-line `CRAFT_INGREDIENT_PREREQ` record for a craft goal's missing ingredient. */
export interface CraftIngredientPrereqLine {
  /** the craft goal's item, e.g. `wooden_pickaxe` */
  item: string
  /** the missing ingredient (`birch_planks`), or the plan's next intermediate */
  missing: string
  /** `craft <item>` for a satisfiable step, else `collect <spec>` (or `none`) */
  producer: string
  /**
   * The mob that drops the raw producer, when its only grounded source is a mob
   * drop, else null. This is the PRODUCER FACT the line needs to be actionable:
   * `missing=blaze_powder producer=collect blaze_rod` names an item with no block
   * source at all, and the reader could not tell whether the run was missing a
   * dig site or a kill. Omitted (not `null`) from the line when absent, so every
   * non-mob ingredient's marker stays byte-identical.
   */
  producerMob?: string | null
  /** true when the recipe descent stopped at the shared dependency depth cap */
  depthBoundHit: boolean
}

/**
 * The code-owned ingredient view of the current craft goal, for the mirrored
 * `CRAFT_INGREDIENT_PREREQ` marker. When the recipe planner already has a step,
 * the marker names that step; otherwise it names the raw producer the same
 * `craftIngredientRoute` offers, so the logged action always matches the
 * presented candidates.
 */
export function craftIngredientPrereq(state: WorldState, options: CandidateOptions): CraftIngredientPrereqLine | null {
  const current = state.goalQueue?.current ?? null
  if (current === null || current.kind !== 'craft') return null
  const item = current.targetItem
  if (item === null) return null
  const recipes = options.recipes ?? null
  if (recipes === null || recipes.recipesFor(item).length === 0) return null
  const plan = planNextCraftStep(
    recipes,
    item,
    state.inventory.counts,
    sensedCraftingTableAvailable(state, options, item),
    craftGoalRequirement(state, item),
  )
  if (plan.op !== null) {
    if (plan.op.type !== 'craft') return null
    return { item, missing: plan.op.item, producer: `craft ${plan.op.item}`, depthBoundHit: false }
  }
  const route = craftIngredientRoute(state, options, item)
  if (route === null) return null
  return {
    item,
    missing: route.missing,
    producer: route.producer,
    ...(route.producerMob === null ? {} : { producerMob: route.producerMob }),
    depthBoundHit: route.depthBoundHit,
  }
}

export function formatCraftIngredientPrereq(entry: CraftIngredientPrereqLine): string {
  const bound = entry.depthBoundHit ? ' depth=bound' : ''
  // The producer fact is appended ONLY for a mob-drop raw producer: every other
  // ingredient's line is unchanged byte for byte.
  const mob = entry.producerMob == null ? '' : ` mob=${entry.producerMob}`
  return `CRAFT_INGREDIENT_PREREQ item=${entry.item} missing=${entry.missing} producer=${entry.producer}${bound}${mob}`
}

/** One craft-plan step plus any placement refusal met while resolving it. */
interface CraftStep {
  candidate: Candidate | null
  refusal: PlaceRefusal | null
}

/** The craft path's candidates plus the typed placement refusal when a held station could not be placed. */
interface CraftCandidatesResult {
  candidates: Candidate[]
  placeRefusal: PlaceRefusal | null
}

/** Raw candidates plus the placement refusal one of them refused, for the gate to surface. */
interface RawCandidatesResult {
  candidates: Candidate[]
  placeRefusal: PlaceRefusal | null
  ignitionRefusal: IgnitionRefusal | null
  entryRefusal: PortalEntryRefusal | null
  /** carried armor pieces that are not better than what is worn (no churn) */
  armorRefusals: ArmorRefusal[]
  /**
   * Typed shortfalls for the armour pieces the carried material cannot afford
   * (`ARMOR_CRAFT_REFUSED ... material=iron_ingot need=8 have=2 shortfall=6`).
   * Carried through the gate unchanged: it is computed from world truth, not from
   * the offered set, and it is exactly what explains a `COMBAT_KIT_GAP ...
   * missing=[armor] prerequisite=none`.
   */
  armorCraftRefusals: ArmorCraftRefusal[]
  /** typed ascent refusal for a `surface` goal with no grounded vertical route */
  surfaceAscentRefusal: SurfaceAscentRefusal | null
  /** typed refusal for a hungry hunt with no grounded route up to animal habitat */
  foodHabitatRefusal: SurfaceAscentRefusal | null
  /** typed refusal when a stranded body has no safe descent off its own column */
  columnDescentRefusal: ColumnDescentRefusal | null
  /**
   * Typed `HUNT_CONTACT_UNREACHABLE` refusals: a sensed fight target the body's
   * melee envelope provably cannot be brought onto from here (see
   * `GroundedCandidatesResult.contactRefusals`).
   */
  contactRefusals: ContactRefusal[]
  /**
   * Typed `DIG_ROUTE_REFUSED reason=...` facts collected while grounding this
   * tick's offers (see `GroundedCandidatesResult.digRefusals`).
   */
  digRefusals: DigRouteRefusal[]
  /**
   * Typed `PROSPECT_REFUSED reason=...` when the descending body's geometry
   * grounded an exposure probe toward a sensed producer of its focus and every
   * such probe was refused (hazard, unbreakable, no support, missing tool). Null
   * while a probe was offered, and null when there was nothing to expose at all.
   */
  prospectRefusal: ProspectRefusal | null
  /** live-structure member cells refused as sources for the active collect goal */
  sourceExclusions: ResourceSourceExclusion[]
  /**
   * Typed container refusals collected while grounding the container family
   * (`CONTAINER_REFUSED reason=unreachable|empty|...`). Never a silent no-op: an
   * unopened/unreachable container and an observed-empty one both name the fact.
   */
  containerRefusals: ContainerRefusal[]
}

/**
 * The single grounded candidate for one executable craft-plan op. The gate's
 * last-resort ladder calls it with the plan already computed as if no station
 * were available, so a table-requiring recipe falls back to crafting/placing the
 * station itself instead of waiting on an unreachable remembered one.
 */
function craftPlanStepCandidate(
  state: WorldState,
  options: CandidateOptions,
  op: CraftOp,
  focusItem: string,
): CraftStep {
  if (op.type === 'craft') {
    const table = op.requiresTable ? state.craftingTables.find(isSensedStation) ?? null : null
    if (op.requiresTable && table === null) return { candidate: null, refusal: null }
    const where = table === null ? 'inventory 2x2' : `at crafting_table (${table.x},${table.y},${table.z})`
    return {
      candidate: {
        id: `CRAFT:${op.item}`,
        kind: 'CRAFT',
        label: `${describeCraftOp(op)} ${where}, ${focusItem} subgoal`,
        targetName: op.item,
        target: table,
        targetEntityId: null,
        itemName: op.item,
        requiresTool: false,
        toolName: null,
        inReach: table === null || distance(table, state.self.eyePosition) <= options.reach,
        hasStandableAdjacent: true,
        meta: {
          tick: state.tick,
          craftItem: op.item,
          craftCount: op.count,
          requiresTable: op.requiresTable,
        },
      },
      refusal: null,
    }
  }

  const placement = heldStationPlacement(state, options, op.item, `craft ${focusItem}`)
  if (placement.spot !== null) {
    return {
      candidate: placeStationCandidate(state, options, op.item, placement.spot, `craft ${focusItem}`),
      refusal: null,
    }
  }
  return { candidate: placement.alternative, refusal: placement.refusal }
}

/**
 * The self-contained ladder step for the current craft goal, planned as if no
 * station were available. Its every input comes from the live inventory, so it
 * is executable NOW whenever it exists at all - the gate offers it before
 * declaring starvation.
 *
 * OPERATOR RULE (station-use-before-craft): the last-resort step must obey the
 * same station rule as `craftCandidates`. A step that would craft a station the
 * world model already knows is a duplicate route, so it is not offered here
 * either - the ladder (`stationAcquisitionCandidates`) or the typed
 * `craftStationGap` fact is the answer instead.
 */
export function selfContainedCraftCandidates(
  state: WorldState,
  options: CandidateOptions,
): Candidate[] {
  const recipes = options.recipes ?? null
  const current = state.goalQueue?.current ?? null
  const focusItem = current?.targetItem ?? state.goal.targetItem ?? null
  if (recipes === null || focusItem === null || (current?.kind ?? 'collect') !== 'craft') return []
  const plan = planNextCraftStep(
    recipes,
    focusItem,
    state.inventory.counts,
    sensedCraftingTableAvailable(state, options, focusItem),
    craftGoalRequirement(state, focusItem),
  )
  if (plan.op === null) return []
  if (planStepCraftsKnownStation(state, options, plan.op)) return []
  const step = craftPlanStepCandidate(state, options, plan.op, focusItem)
  return step.candidate === null ? [] : [step.candidate]
}

/**
 * A sensed station is not automatically a usable station.  A craft action can
 * fail after the sensor sees a table when the table is above a disconnected
 * ledge or otherwise has no path from the current position.  Once the exact
 * craft candidate has a path failure, re-plan as if the table were absent so
 * the recipe ladder can craft/place a local table or retrieve another one.
 *
 * The explicit blacklist remains authoritative when the controller has already
 * proved the coordinate unreachable.  The path-failure check is deliberately
 * scoped to the same CRAFT:<item> candidate; unrelated movement failures must
 * not make every nearby table disappear.
 */
function sensedCraftingTableAvailable(state: WorldState, options: CandidateOptions, focusItem: string): boolean {
  const unreachableStations = options.unreachableStations ?? EMPTY_STATIONS
  // Sensed stations use the same explicit reachability blacklist as remembered
  // stations. A stale sensor result must not bypass MOVE_FAILMEM and re-enter
  // the same CRAFT:furnace -> JUMP_FAIL loop on every prerequisite decision.
  const sensed = state.craftingTables.find(
    (position) =>
      isSensedStation(position) &&
      !unreachableStations.has(knownStationKey({ name: 'crafting_table', position })) &&
      stationApproachReachable(state, options, position, 'crafting_table'),
  )
  if (sensed === undefined) return false
  const craftFailures = state.signals.failedCandidates[`CRAFT:${focusItem}`] ?? 0
  const lastFailure = state.signals.lastFailureCode
  const pathFailure = lastFailure === 'path_no_path' || lastFailure === 'path_stuck'
  return !(craftFailures > 0 && pathFailure)
}

/**
 * #46: pick the placement spot with the fewest recorded failures so a failed
 * placement retries at a different nearby block instead of re-failing in place.
 */
function leastFailedPlacementSpot(state: WorldState, item: string): Vec3Json | null {
  const failed = state.signals.failedCandidates
  let best: Vec3Json | null = null
  let bestCount = Number.POSITIVE_INFINITY
  for (const spot of dryAwarePlacementSpots(state)) {
    const count = failed[`PLACE:${item}:${blockId('p', spot)}`] ?? 0
    if (count < bestCount) {
      best = spot
      bestCount = count
    }
  }
  return best
}

function explicitPlacementCells(state: WorldState): Vec3Json[] | null {
  const cells = state.goalQueue?.current?.placementCells ?? null
  if (cells === null || cells.length === 0) return null
  return cells.map((cell) => ({ x: cell.x, y: cell.y, z: cell.z }))
}

/**
 * Code-owned frame geometry for an abstract `place obsidian` goal: the site is
 * chosen from the live placement spots and the cells come from `portalFrameLayout`.
 * This is where the executor-time grounding happens, never in the model plan.
 */
function frameBuildCells(state: WorldState): Vec3Json[] | null {
  return frameBuildGrounding(state)?.cells.map((cell) => ({ x: cell.x, y: cell.y, z: cell.z })) ?? null
}

function frameBuildGrounding(state: WorldState): ReturnType<typeof groundPortalFrame> {
  const current = state.goalQueue?.current ?? null
  if (current === null || current.kind !== 'place' || current.targetItem !== OBSIDIAN) return null
  // A portal is a multi-cell mechanics operation.  Prefer sensor-grounded
  // complete footprints; the placementSpots fallback preserves old replay
  // fixtures and the generic single-cell behavior.
  const grounding = groundPortalFrame(state.portalFrameSites ?? state.placementSpots, state.self.position)
  return grounding
}

function placeSequenceCells(state: WorldState, focusItem: string): Vec3Json[] | null {
  const explicit = explicitPlacementCells(state)
  if (explicit !== null) return explicit
  const frame = frameBuildCells(state)
  if (frame === null) return null
  if ((state.inventory.counts[focusItem] ?? 0) < frame.length) return null
  return frame
}

function placementAxisFor(cells: readonly Vec3Json[]): 'x' | 'z' {
  const first = cells[0]
  if (first === undefined) return 'x'
  const sameZ = cells.every((cell) => cell.z === first.z)
  const sameX = cells.every((cell) => cell.x === first.x)
  return sameZ && !sameX ? 'x' : 'z'
}

/**
 * Deterministic CAN truth for a starved `place obsidian` goal whose frame
 * grounding exists but whose remaining cells exceed the held material. Without
 * this the generator returns an empty candidate set with no named cause and the
 * starvation evidence reads `missing=[]` (live 2026-09-21: `CANDIDATE_STARVATION
 * ... goal=place:obsidian:10 blockedBy=no_productive_action missing=[] repeat=21`).
 *
 * Returns null when the grounding itself is absent (no site to build on) or when
 * the held material is sufficient; the caller names the no-site case separately.
 */
export function frameBuildMaterialGap(
  state: WorldState,
  focusItem: string,
): { missing: number; held: number } | null {
  if (focusItem !== OBSIDIAN) return null
  const current = state.goalQueue?.current ?? null
  if (current === null || current.kind !== 'place' || current.targetItem !== OBSIDIAN) return null
  const grounding = frameBuildGrounding(state)
  if (grounding === null) return null
  const held = state.inventory.counts[focusItem] ?? 0
  if (held >= grounding.cells.length) return null
  return { missing: grounding.cells.length, held }
}

/** The grounding exists for the active frame goal, regardless of material. */
export function frameBuildGrounded(state: WorldState, focusItem: string): boolean {
  if (focusItem !== OBSIDIAN) return false
  const current = state.goalQueue?.current ?? null
  if (current === null || current.kind !== 'place' || current.targetItem !== OBSIDIAN) return false
  return frameBuildGrounding(state) !== null
}

/**
 * PLACE candidate for a `place` subgoal (e.g. the M2 furnace). The item is in
 * the inventory and there is a grounded placement spot within reach.
 */
function placeCandidates(state: WorldState, options: CandidateOptions, focusItem: string | null): Candidate[] {
  if (focusItem === null) return []
  // A placement family whose bounded attempts are exhausted must not be
  // re-offered: the ledger already retired it with a typed PLACE_RETRIES_EXHAUSTED.
  if (options.retiredPlaceItems?.has(focusItem) === true) return []
  if ((state.inventory.counts[focusItem] ?? 0) <= 0) return []
  const sequence = placeSequenceCells(state, focusItem)
  if (sequence !== null) {
    const grounding = focusItem === OBSIDIAN ? frameBuildGrounding(state) : null
    if (
      focusItem === OBSIDIAN &&
      grounding?.temporarySupportRequired === true &&
      selectPlaceableBlock(state.inventory.counts) === null
    ) {
      return portalFrameSupportPrerequisiteCandidates(state, options)
    }
    const target = sequence[0] ?? null
    return [
      {
        id: `PLACE:${focusItem}:build:${sequence.length}@${target === null ? 'none' : blockId('p', target)}`,
        kind: 'PLACE',
        label: `place ${sequence.length} x ${focusItem} at ${sequence.length} specified cells, starting at (${target?.x},${target?.y},${target?.z})`,
        targetName: focusItem,
        target,
        targetEntityId: null,
        itemName: focusItem,
        requiresTool: false,
        toolName: null,
        inReach: target !== null && distance(target, state.self.eyePosition) <= options.reach,
        hasStandableAdjacent: true,
        placementCells: sequence,
        placementAxis: placementAxisFor(sequence),
        meta: {
          tick: state.tick,
          x: target?.x ?? 0,
          y: target?.y ?? 0,
          z: target?.z ?? 0,
          placementCount: sequence.length,
        },
      },
    ]
  }
  const current = state.goalQueue?.current ?? null
  if (current !== null && current.kind === 'place' && current.targetItem === OBSIDIAN) return []
  const spot = leastFailedPlacementSpot(state, focusItem)
  if (spot === null) return []
  // A held CONTAINER is a legal PLACE like any other block item - there is no
  // placeable-block table gating this family - and the placement is worth
  // naming for what it enables: once the block stands there, OPENING it is an
  // ordinary station interaction. The cell legality is the same
  // `placementSpots`/reference geometry every other placement uses, and the
  // executor re-verifies the post-condition (the block must actually appear).
  const asContainer = containerBlockForItem(focusItem)
  return [
    {
      id: `PLACE:${focusItem}:${blockId('p', spot)}`,
      kind: 'PLACE',
      label: `place ${focusItem} at (${spot.x},${spot.y},${spot.z}), ${distance(spot, state.self.position)}m away${asContainer === null ? '' : ' (a container to open once placed)'}`,
      targetName: focusItem,
      target: spot,
      targetEntityId: null,
      itemName: focusItem,
      requiresTool: false,
      toolName: null,
      inReach: distance(spot, state.self.eyePosition) <= options.reach,
      hasStandableAdjacent: true,
      meta: {
        tick: state.tick,
        x: spot.x,
        y: spot.y,
        z: spot.z,
        ...(asContainer === null ? {} : { containerPlacement: asContainer }),
      },
    },
  ]
}

/**
 * A minimal obsidian frame can be geometrically grounded while still needing
 * one temporary solid reference block for an upper edge. Keep that missing
 * capability inside the active semantic Option: the producer route is the
 * existing generic placeable-block acquisition envelope, tagged as a typed
 * prerequisite so Jev can select it without waking System2 or inventing a
 * portal-specific mission.
 */
function portalFrameSupportPrerequisiteCandidates(state: WorldState, options: CandidateOptions): Candidate[] {
  return mineCandidates(
    state,
    options,
    null,
    null,
    (block) => typeof block.yield === 'string' && PILLAR_PLACE_PRIORITY.includes(block.yield),
  ).map((candidate) => ({
    ...candidate,
    meta: {
      ...candidate.meta,
      optionSkill: 'PREREQUISITE',
      prerequisiteRole: 'portal_frame_support',
      prerequisiteItem: 'placeable_block',
      capabilityAcquisition: true,
      missingCapability: 'placeable_block',
    },
  }))
}

/**
 * Generic station-approach evaluation: can the executor stand at `station` and
 * interact with its face? The controller supplies the live facts (a passable,
 * supported stand within reach plus the `canDig=false` path verdict to it), and
 * this runs the SAME `evaluateReachability` the affordance gate uses for
 * locomotion targets, so hazard/vertical/approach/path all apply.
 *
 * When no probe is supplied the station is treated as viable: pure callers
 * (tests, offline generation) keep the existing behavior and the controller is
 * the only place that can add live world facts.
 */
function stationApproachReachable(
  state: WorldState,
  options: CandidateOptions,
  station: Vec3Json,
  kind: StationKindName,
): boolean {
  const probe = options.reachability?.stationApproach ?? null
  if (probe === null) return true
  const fact = probe(station, kind)
  if (fact.approach === null) return false
  const column = columnFacts(state)
  const abilities = deriveReachabilityAbilities(state, station, column)
  const target: ReachabilityTarget = {
    candidateId: `STATION:${kind}:${blockId('b', station)}`,
    kind,
    position: station,
    barrier: null,
  }
  const world: ReachabilityWorld = {
    self: state.self.position,
    approach: fact.approach,
    reach: options.reach,
    hazardAtTarget: state.blocks.some(
      (block) => block.kind === 'hazard' && distance(block.position, station) <= HAZARD_PROXIMITY,
    ),
    footingSolid: column.footingSolid,
    headroomClear: column.headroomClear,
  }
  return evaluateReachability(target, world, state.inventory.counts, abilities, fact.path ?? 'unknown').reachable
}

/**
 * The CONTAINER family: open a sensed/remembered container, and take what its
 * OBSERVED contents hold.
 *
 * A container is a SUPPLY SOURCE OF UNKNOWN CONTENT. The client cannot read a
 * container's contents before a window is open (see `containerAccess.ts`:
 * mineflayer's only contents surface is the opened window), so:
 *
 *   * contents UNKNOWN -> offer the OPEN/INSPECT step, whose label says so.
 *     It is offered when the current goal has NO grounded source of its own
 *     (`offerUnknown`), or when the body has no focus item at all - i.e. when a
 *     supply source of unknown content is genuinely worth a look. Code never
 *     assumes a container holds anything.
 *   * contents OBSERVED -> offer one ordinary WITHDRAW step per observed
 *     stack, tagged as a producer for the focus item when it is one. Jev picks;
 *     code ranks nothing and withholds nothing it has grounded.
 *   * contents observed EMPTY -> no candidate at all, plus the typed
 *     `reason=empty` refusal, so an empty container can never look like a
 *     silent success.
 *   * no reachable interaction stand -> the typed `reason=unreachable` refusal
 *     naming the measured fact, never a silent no-op.
 *
 * Every candidate goes through the EXISTING station-approach evaluation
 * (`stationApproachReachable`, the same `evaluateReachability` the affordance
 * gate uses), so hazard/vertical/approach/path still apply. Nothing here is
 * container-specific safety: a container is a station, and it is protected from
 * mining by `PROTECTED_STATION_BLOCKS`.
 */
export interface ContainerGroundingResult {
  candidates: Candidate[]
  refusals: ContainerRefusal[]
}

/**
 * How many containers one tick offers, and how many stacks one container offers.
 * A bound on enumeration, never a rank: containers are taken nearest-first as
 * the sensor already ordered them, and a stack the goal actually wants is ALWAYS
 * included (see the selection below) so the bound can never hide the one item
 * the body was looking for.
 */
export const MAX_CONTAINER_OFFERS = 3
export const MAX_CONTAINER_ITEM_OFFERS = 6

function containerOpenCandidate(
  state: WorldState,
  options: CandidateOptions,
  entry: StationEntry,
  blockName: string,
  ref: string,
): Candidate {
  const position: Vec3Json = { x: entry.x, y: entry.y, z: entry.z }
  return {
    id: `CONTAINER:open:${ref}`,
    kind: 'CONTAINER',
    label: `open ${blockName} at (${position.x},${position.y},${position.z}), ${distance(position, state.self.position)}m away (contents unknown until opened)`,
    targetName: blockName,
    target: position,
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: distance(position, state.self.eyePosition) <= options.reach,
    hasStandableAdjacent: true,
    meta: {
      tick: state.tick,
      x: position.x,
      y: position.y,
      z: position.z,
      containerRef: ref,
      containerAction: 'open',
      containerBlock: blockName,
      containerContents: 'unknown',
      containerSource: entry.source,
    },
  }
}

function containerWithdrawCandidate(
  state: WorldState,
  options: CandidateOptions,
  entry: StationEntry,
  blockName: string,
  ref: string,
  item: ContainerItemStack,
  observedCount: number,
  focusItem: string | null,
): Candidate {
  const position: Vec3Json = { x: entry.x, y: entry.y, z: entry.z }
  const producer = focusItem !== null && focusItem === item.name
  return {
    id: `CONTAINER:withdraw:${ref}:${item.name}`,
    kind: 'CONTAINER',
    label: `take ${item.name} x${observedCount} out of ${blockName} at (${position.x},${position.y},${position.z}), ${distance(position, state.self.position)}m away${producer ? ` (a producer for ${focusItem})` : ''}`,
    targetName: blockName,
    target: position,
    targetEntityId: null,
    itemName: item.name,
    requiresTool: false,
    toolName: null,
    inReach: distance(position, state.self.eyePosition) <= options.reach,
    hasStandableAdjacent: true,
    meta: {
      tick: state.tick,
      x: position.x,
      y: position.y,
      z: position.z,
      containerRef: ref,
      containerAction: 'withdraw',
      containerBlock: blockName,
      containerItem: item.name,
      containerCount: observedCount,
      containerContents: 'known',
      containerSource: entry.source,
      ...(producer ? { containerProducer: focusItem } : {}),
    },
  }
}

function containerRefusal(
  entry: StationEntry,
  blockName: string,
  ref: string,
  reason: ContainerRefusal['reason'],
  detail: string | null = null,
  item: string | null = null,
): ContainerRefusal {
  return {
    reason,
    container: ref,
    block: blockName,
    position: { x: entry.x, y: entry.y, z: entry.z },
    item,
    detail,
  }
}

/**
 * `offerUnknown` gates whether an UNOPENED container may be offered at all (the
 * caller passes true: an unopened container is a bounded inspection, and the
 * observation recorded on opening makes it self-limiting)," 
 * computed from the candidate set the goal already grounded. It is a WITHHOLDING
 * rule, never a rank: it decides whether an unknown-content probe is worth
 * offering, and it never reorders or replaces any other candidate.
 */
function containerCandidates(
  state: WorldState,
  options: CandidateOptions,
  focusItem: string | null,
  offerUnknown: boolean,
): ContainerGroundingResult {
  const candidates: Candidate[] = []
  const refusals: ContainerRefusal[] = []
  let offered = 0
  for (const entry of state.containers ?? []) {
    if (offered >= MAX_CONTAINER_OFFERS) break
    const position: Vec3Json = { x: entry.x, y: entry.y, z: entry.z }
    const blockName = entry.name ?? null
    if (blockName === null || !isContainerBlockName(blockName)) {
      // A remembered container cell with no block truth left (unloaded chunk, or
      // a block the durable record no longer matches) is UNREACHABLE, typed and
      // named - never silently skipped and never treated as empty.
      refusals.push(containerRefusal(entry, blockName ?? 'container', containerRef(blockName ?? 'container', position), 'unreachable', 'block_unknown'))
      continue
    }
    const ref = containerRef(blockName, position)
    const observed = containerObservationAt(state.containerContents, position)
    if (observed === null) {
      // UNKNOWN, never empty. A container nobody opened can only be offered as
      // an inspect step, and only when the goal actually lacks a source.
      if (!offerUnknown) continue
      if (!stationApproachReachable(state, options, position, 'container')) {
        refusals.push(containerRefusal(entry, blockName, ref, 'unreachable', 'no_interaction_stand_or_path'))
        continue
      }
      candidates.push(containerOpenCandidate(state, options, entry, blockName, ref))
      offered += 1
      continue
    }
    if (observed.items.length === 0) {
      // Opened and seen empty: a typed EMPTY result, never a silent success and
      // never a withdrawal candidate.
      refusals.push(containerRefusal(entry, blockName, ref, 'empty'))
      continue
    }
    if (!stationApproachReachable(state, options, position, 'container')) {
      refusals.push(containerRefusal(entry, blockName, ref, 'unreachable', 'no_interaction_stand_or_path'))
      continue
    }
    // The goal-relevant stacks are enumerated first so the bound can never hide
    // the item the goal wants; the remaining observed stacks follow in the
    // order the container reported them. This is inclusion, not ranking: it
    // never reorders two equally relevant stacks and never drops one silently
    // in favour of a "better" one.
    const rolled = rollupContainerItems(observed.items)
    const relevant = focusItem === null ? [] : rolled.filter((item) => item.name === focusItem)
    const rest = rolled.filter((item) => focusItem === null || item.name !== focusItem)
    const selected = [...relevant, ...rest].slice(0, MAX_CONTAINER_ITEM_OFFERS)
    for (const item of selected) {
      candidates.push(containerWithdrawCandidate(state, options, entry, blockName, ref, item, item.count, focusItem))
    }
    if (selected.length > 0) offered += 1
  }
  return { candidates, refusals }
}

/**
 * The first sensed furnace the controller has NOT proven unreachable AND whose
 * interaction approach is viable. A station the `canDig=false` pathfinder cannot
 * path to does not satisfy the smelt precondition (nor belong in a direct SMELT
 * candidate): offering it produced the live loop where `SMELT:charcoal` was
 * guard-rejected `NO_PATH` every tick while the acquisition ladder
 * (`craft_and_place` -> a reachable/placed furnace) was never generated, so
 * `SMELT_DONE` never fired. The same fact now also rejects a sensed furnace with
 * no reachable interaction stand (live RC9: `SMELT:iron_ingot` -> `path_stuck`
 * four times at the first sensed furnace before the recovery ladder ran).
 *
 * The station must ALSO pass the code-owned `canDig=false` verdict the executor
 * guard enforces (`reachability.pathProbe`, the controller's `GoalBlock` walk).
 * The interaction-stand geometry (`stationApproach`) answers a different question
 * - "is there a stand in front of this station" - and the two disagree for a
 * station the body can stand beside but cannot walk to. Generation must not name
 * a direct smelt at a cell the guard will refuse: measured live, `SMELT:iron_ingot`
 * at `(28,63,6)` was re-offered and `NO_PATH`-rejected 230+ times because the
 * stand probe passed while the guard's walk probe failed.
 */
function reachableSensedFurnace(state: WorldState, options: CandidateOptions): StationEntry | null {
  const unreachableStations = stationUnreachableSet(state, options)
  for (const entry of state.furnaces ?? []) {
    if (!isSensedStation(entry)) continue
    const position: Vec3Json = { x: entry.x, y: entry.y, z: entry.z }
    if (unreachableStations.has(knownStationKey({ name: 'furnace', position }))) continue
    if (!stationApproachReachable(state, options, position, 'furnace')) continue
    return entry
  }
  return null
}

/**
 * The station cells the smelt prerequisite must treat as unreachable: the
 * controller's explicit move-failure/manual set PLUS every station cell the
 * code-owned `canDig=false` probe refuses.
 *
 * The probe is the SAME verdict the executor guard enforces, so a station it
 * refuses is not an alternative route and must not be offered as one. Without
 * this the direct step was re-offered forever while the acquisition ladder
 * (`knownFurnaces` -> `use_known_station`) named the very same refused cell as
 * its own replacement, so a satisfiable smelt had no grounded route and no typed
 * gap. In-reach stations are skipped: no walk is needed, so there is nothing to
 * refuse.
 */
/**
 * Upper bound on the `canDig=false` station probes one generation pass adds. The
 * dig-approach probe budgets its own probes the same way; a station walk probe
 * costs up to `PATH_PROBE_TIMEOUT_MS`, so the pass must not scan every
 * remembered station.
 */
export const STATION_WALK_PROBE_BUDGET = 6

function stationUnreachableSet(state: WorldState, options: CandidateOptions): ReadonlySet<string> {
  const explicit = options.unreachableStations ?? EMPTY_STATIONS
  const blacklisted = options.blacklistedMoveTargets
  let extended: Set<string> | null = null
  for (const entry of state.furnaces ?? []) {
    const position: Vec3Json = { x: entry.x, y: entry.y, z: entry.z }
    const key = knownStationKey({ name: 'furnace', position })
    if (!isBlacklistedMoveTarget(state, blacklisted, position)) continue
    extended ??= new Set(explicit)
    extended.add(key)
  }
  const probe = options.reachability?.pathProbe ?? null
  if (probe === null) return extended ?? explicit
  const walkable: { position: Vec3Json; key: string; walk: number }[] = []
  for (const entry of state.furnaces ?? []) {
    const position: Vec3Json = { x: entry.x, y: entry.y, z: entry.z }
    const walk = distance(position, state.self.eyePosition)
    if (walk <= options.reach) continue
    walkable.push({ position, key: knownStationKey({ name: 'furnace', position }), walk })
  }
  walkable.sort((a, b) => a.walk - b.walk)
  for (const station of walkable.slice(0, STATION_WALK_PROBE_BUDGET)) {
    if (explicit.has(station.key) || extended?.has(station.key)) continue
    if (probe(station.position) !== 'no_path') continue
    extended ??= new Set(explicit)
    extended.add(station.key)
  }
  return extended ?? explicit
}

/**
 * The station the DIRECT smelt step names: a sensed furnace whose interaction
 * approach is mechanically viable (`reachableSensedFurnace`, unchanged).
 *
 * A REMEMBERED station is deliberately NOT a direct step even when it is within
 * reach: `knownStationRetrievalCandidate` is the pinned route for a
 * registered-but-not-sensed station ("walk to the remembered station, then
 * smelt"), and `buddy-driver/test-furnace-place.mts` asserts exactly that.
 * Keeping the split means "smelt here" (sensed, in place) and "go there"
 * (remembered/registered) stay distinct grounded routes.
 */
function directSmeltFurnace(state: WorldState, options: CandidateOptions): StationEntry | null {
  return reachableSensedFurnace(state, options)
}

/**
 * SMELT candidate for a `smelt` subgoal: a placed furnace is in sensor range,
 * the input and a fuel item are in the inventory, and the output is still short.
 *
 * The station is a LADDER of grounded routes, exactly like `craftingTableSource`
 * is for a 3x3 craft, and the direct step never replaces the rest of the ladder:
 *
 *  1. a station the body can smelt at now (`directSmeltFurnace`) -> direct SMELT;
 *  2. when that station is out of interaction reach the body must TRAVEL, so the
 *     generic furnace-acquisition ladder is enumerated alongside it (walk to a
 *     remembered/registered station, place a held furnace, craft one at a table)
 *     through `furnaceAcquisitionCandidates`, which is the same route set the
 *     no-station case already used;
 *  3. with no sensed station at all the ladder alone is the answer.
 *
 * The union matters because the two code-owned reachability facts can disagree
 * (measured live: `stationApproach` resolved a `GoalNear` interaction stand while
 * the guard's `GoalBlock` probe on the same furnace returned `NO_PATH` 86x). An
 * exclusive direct step then re-offered one unreachable furnace forever and the
 * 15 remembered furnaces were never a candidate, leaving a degenerate
 * `[SMELT, WAIT]` set and a silent WAIT until the semantic boundary.
 */
function smeltCandidates(state: WorldState, options: CandidateOptions, focusItem: string | null): Candidate[] {
  if (focusItem === null) return []
  const inputSpec = smeltInputName(focusItem)
  if (inputSpec === null) return []
  const furnace = directSmeltFurnace(state, options)
  if (furnace === null) return furnaceAcquisitionCandidates(state, options)
  const inputItem = smeltInputFor(state, focusItem)
  if (inputItem === null) {
    // Not executable yet: the input/fuel is a code-owned precondition
    // (optionSpec#smeltPreconditions), so offer the deterministic collect route
    // for the missing producer instead of starving to WAIT. `fuel` is the
    // data-driven class route (a log or coal), symmetric with the input route.
    return smeltPrerequisiteCandidates(state, options, inputSpec, 'smelt_input')
  }

  const haveOutput = state.inventory.counts[focusItem] ?? 0
  const required = state.goalQueue?.current?.requiredCount ?? state.goal.requiredCount
  if (haveOutput >= required) return []
  const needed = Math.max(1, required - haveOutput)
  const available = state.inventory.counts[inputItem] ?? 0
  if (available <= 0) return []
  const count = Math.min(needed, available)
  const fuelItem = smeltFuelFor(state, inputItem, count)
  if (fuelItem === null) return smeltPrerequisiteCandidates(state, options, 'fuel', 'smelt_fuel')
  const fuelCount = fuelCountFor(count, fuelItem)
  // A single item cannot occupy both furnace slots. In particular, a
  // one-log charcoal route must acquire a second log before SMELT is offered;
  // otherwise the executor transfers the input and then fails fuel transfer,
  // leaving a stale furnace slot that makes the next attempt report
  // `destination full`.
  if (!smeltInventorySufficient(state.inventory.counts, inputItem, count, fuelItem, fuelCount)) {
    return smeltPrerequisiteCandidates(state, options, 'fuel', 'smelt_fuel')
  }

  const direct: Candidate = {
    id: `SMELT:${focusItem}`,
    kind: 'SMELT',
    label: `smelt ${count}x ${focusItem} from ${inputItem} in the furnace at (${furnace.x},${furnace.y},${furnace.z}) using ${fuelItem}`,
    targetName: focusItem,
    target: furnace,
    targetEntityId: null,
    itemName: focusItem,
    requiresTool: false,
    toolName: null,
    inReach: distance(furnace, state.self.eyePosition) <= options.reach,
    hasStandableAdjacent: true,
    meta: {
      tick: state.tick,
      furnaceX: furnace.x,
      furnaceY: furnace.y,
      furnaceZ: furnace.z,
      inputItem,
      inputCount: count,
      fuelItem,
      fuelCount,
      outputItem: focusItem,
      count,
      ...(state.signals.heldFurnacePlacedAt === blockId('b', furnace) ? { furnaceSource: 'held' } : {}),
    },
  }
  // The direct step must never REPLACE the rest of the ladder (see the contract above): the two
  // code-owned reachability facts can disagree, and when they do the tick degenerates to
  // `[SMELT, WAIT]`. Measured live (run-mubobiq6-12onv, source 7a55dba): a furnace the selector
  // believed was in reach was refused by the guard every tick (`SMELT:charcoal code=NO_PATH
  // canDig=false`, `key=overworld:33,66,12 attempts=414 reason=unreachable`) while the body held 57
  // cobblestone, so `CANDIDATE_STARVATION presented=2 productive=0 goal=smelt:charcoal:1` starved
  // with the craft/place-furnace route never offered. Keep the cheap `[direct]` offer while the
  // direct step has NO recorded failure (the common, working case), and open the full ladder as soon
  // as it has failed at least once - the same retry-memory pattern `sensedCraftingTableAvailable`
  // already uses for the table path.
  const directFailures = state.signals.failedCandidates[direct.id] ?? 0
  if (direct.inReach && directFailures === 0) return [direct]
  const travel = furnaceAcquisitionCandidates(state, options).filter((candidate) => candidate.id !== direct.id)
  return [direct, ...travel]
}

/**
 * Ground the producer route for a missing smelt precondition and keep its
 * semantic role visible to Jev.  `mineCandidates` alone only sees the current
 * sensor window; the collect route also admits a non-stale remembered ore/log
 * coordinate.  Without that second leg an active smelt can present only
 * clearance/WAIT candidates after the bot has walked away from the last sensed
 * producer, which is candidate starvation rather than a real impossibility.
 */
function smeltPrerequisiteCandidates(
  state: WorldState,
  options: CandidateOptions,
  spec: string,
  prerequisiteRole: 'smelt_input' | 'smelt_fuel',
): Candidate[] {
  return collectRouteCandidates(state, options, spec).map((candidate) => ({
    ...candidate,
    meta: {
      ...candidate.meta,
      optionSkill: 'PREREQUISITE',
      prerequisiteRole,
      prerequisiteItem: spec,
    },
  }))
}

function smeltInputFor(state: WorldState, focusItem: string): string | null {
  if (focusItem === 'charcoal') {
    const log = Object.keys(state.inventory.counts).find(
      (name) => name.endsWith('_log') && (state.inventory.counts[name] ?? 0) > 0,
    )
    return log ?? null
  }
  const mapped = smeltInputName(focusItem)
  if (mapped === null) return null
  return (state.inventory.counts[mapped] ?? 0) > 0 ? mapped : null
}

function smeltFuelFor(state: WorldState, inputItem: string, count: number): string | null {
  return (
    inventoryFuels(state.inventory.counts).find((fuel) =>
      smeltInventorySufficient(state.inventory.counts, inputItem, count, fuel.item, fuelCountFor(count, fuel.item)),
    )?.item ?? null
  )
}

/** The one-line `SMELT_INPUT_PREREQ` record for a smelt goal's input producer. */
export interface SmeltInputPrereqLine {
  /** the smelt output the goal wants, e.g. `charcoal` */
  item: string
  /** concrete input item: held when present, else the nearest world producer */
  input: string
  present: boolean
  /** `insert_collect` when the missing input offers a collect route */
  action: 'insert_collect' | 'none' | 'no_collect_route'
}

/**
 * The code-owned input-prerequisite view of the current smelt goal, for the
 * mirrored `SMELT_INPUT_PREREQ` marker. Data-driven: the input comes from
 * gameData.smeltInputFor, so charcoal reports a `*_log` and iron_ingot reports
 * raw_iron. The route is the same `mineCandidates` set the generator offers for
 * a missing input, so the logged action always matches the presented candidates.
 */
export function smeltInputPrereq(state: WorldState, options: CandidateOptions): SmeltInputPrereqLine | null {
  const current = state.goalQueue?.current ?? null
  if (current === null || current.kind !== 'smelt') return null
  const item = current.targetItem
  if (item === null) return null
  const inputSpec = smeltInputName(item)
  if (inputSpec === null) return null
  if (directSmeltFurnace(state, options) === null) return null
  const held = smeltInputFor(state, item)
  if (held !== null) return { item, input: held, present: true, action: 'none' }
  const route = smeltPrerequisiteCandidates(state, options, inputSpec, 'smelt_input')
  return {
    item,
    input: nearestProducerYield(state, inputSpec) ?? inputSpec,
    present: false,
    action: route.length > 0 ? 'insert_collect' : 'no_collect_route',
  }
}

export function formatSmeltInputPrereq(entry: SmeltInputPrereqLine): string {
  return `SMELT_INPUT_PREREQ item=${entry.item} input=${entry.input} present=${entry.present} action=${entry.action}`
}

/**
 * The one-line typed capability gap for a smelt goal that has NO grounded
 * route. `smeltCandidates` returns an empty set only when every station route
 * (`directSmeltFurnace`, the acquisition ladder) is infeasible or the
 * input/fuel producer route is empty. Before this marker that state was a bare
 * `[WAIT]` set: Jev had nothing to choose, no typed reason existed, and the
 * resident waited out the semantic boundary. The marker names what is missing
 * and where the known stations are, so the replan can reconsider them instead
 * of re-deriving the same dead end.
 */
export interface SmeltRouteGap {
  /** the smelt output the goal wants */
  item: string
  /** the precondition with no grounded route */
  missing: 'station' | 'input' | 'fuel'
  /** how many of the station item are held */
  heldFurnace: number
  /** how many stations the sensor can see */
  placedStations: number
  /** a 3x3 station is available for the craft route */
  tableAvailable: boolean
  /** furnace material the craft route would use */
  stoneCount: number
  /** remembered/registered furnace coordinates, nearest first */
  knownStations: string[]
  /** known stations the move-failure memory / reachability gate has retired */
  unreachableStations: string[]
}

/** Upper bound on the coordinates one marker line names. */
export const MAX_GAP_STATIONS = 8

/**
 * `SMELT_STATION_MISSING` / `SMELT_INPUT_MISSING` / `SMELT_FUEL_MISSING`.
 *
 * Strictly derived from the same `smeltCandidates` the policy sees: a gap is
 * reported only when that set is empty, so a satisfiable smelt can never be
 * labelled missing.
 */
export function smeltRouteGap(state: WorldState, options: CandidateOptions): SmeltRouteGap | null {
  const current = state.goalQueue?.current ?? null
  if (current === null || current.kind !== 'smelt') return null
  const item = current.targetItem
  if (item === null) return null
  if (smeltInputName(item) === null) return null
  if (smeltCandidates(state, options, item).length > 0) return null

  const unreachableStations = stationUnreachableSet(state, options)
  const input = furnacePrereqInputFromState(state, options)
  const missing: SmeltRouteGap['missing'] =
    directSmeltFurnace(state, options) === null
      ? 'station'
      : smeltInputFor(state, item) === null
        ? 'input'
        : 'fuel'
  const describe = (station: KnownStationLike): string =>
    `${station.position.x},${station.position.y},${station.position.z}`
  return {
    item,
    missing,
    heldFurnace: input.heldCount,
    placedStations: input.placedCount,
    tableAvailable: input.tableAvailable,
    stoneCount: input.stoneCount,
    knownStations: knownFurnaces(state, unreachableStations).map(describe),
    unreachableStations: [...unreachableStations].sort(),
  }
}

export function formatSmeltRouteGap(gap: SmeltRouteGap): string {
  const known = gap.knownStations.slice(0, MAX_GAP_STATIONS)
  return [
    `SMELT_${gap.missing.toUpperCase()}_MISSING`,
    `item=${gap.item}`,
    `missing=${gap.missing}`,
    `held_furnace=${gap.heldFurnace}`,
    `placed_stations=${gap.placedStations}`,
    `table=${gap.tableAvailable}`,
    `stone=${gap.stoneCount}`,
    `known_stations=[${known.join(';')}]`,
    `unreachable_stations=[${gap.unreachableStations.slice(0, MAX_GAP_STATIONS).join(';')}]`,
  ].join(' ')
}

/**
 * A smelt station the pinned `canDig=false` walk keeps refusing, with the route
 * the ladder offers instead. The retry itself is a mechanical fact (the guard's
 * `NO_PATH`); this type is what makes the RETRY typed and bounded instead of a
 * silent 200+-attempt loop on the same cell.
 */
export interface SmeltStationRetry {
  /** the station cell the direct/leg route keeps naming */
  station: Vec3Json
  /** the grounded route the ladder offers instead of retrying the same cell */
  next: 'travel' | 'place' | 'capability_gap'
}

/**
 * The station a `smelt` goal keeps re-naming while the executor's own
 * `canDig=false` verdict refuses the walk, plus the replacement route.
 *
 * The refusal fact is the SAME probe the guard uses (`reachability.pathProbe`,
 * the controller's `GoalBlock` pathfinder verdict), so this cannot be satisfied
 * by the looser generation-side interaction-stand probe that produced the live
 * disagreement. A station already retired by the explicit blacklist counts too.
 *
 * Returns null when no refused station is in play, so a satisfiable smelt never
 * carries a false "unreachable" marker.
 */
export function smeltStationRetry(state: WorldState, options: CandidateOptions): SmeltStationRetry | null {
  const current = state.goalQueue?.current ?? null
  if (current === null || current.kind !== 'smelt') return null
  const item = current.targetItem
  if (item === null || smeltInputName(item) === null) return null
  const station = refusedSmeltStation(state, options)
  if (station === null) return null
  const candidates = smeltCandidates(state, options, item)
  const next: SmeltStationRetry['next'] = candidates.some(
    (candidate) => candidate.kind === 'PLACE' && candidate.meta.furnaceSource === 'held',
  )
    ? 'place'
    : candidates.some((candidate) => candidate.kind === 'RETRIEVE' || candidate.kind === 'MOVE')
      ? 'travel'
      : 'capability_gap'
  return { station, next }
}

export function formatSmeltStationRetry(entry: SmeltStationRetry, attempts: number): string {
  return `SMELT_STATION_UNREACHABLE station=${entry.station.x},${entry.station.y},${entry.station.z} attempts=${attempts} next=${entry.next}`
}

/**
 * The refused station the active smelt would have to walk to, in the same order
 * the generator names them: the sensed direct target first, then the remembered
 * stations the ladder would retrieve. In-reach stations are skipped - no walk is
 * needed, so there is nothing to refuse.
 */
function refusedSmeltStation(state: WorldState, options: CandidateOptions): Vec3Json | null {
  const unreachableStations = stationUnreachableSet(state, options)
  const probe = options.reachability?.pathProbe ?? null
  const refused = (position: Vec3Json): boolean =>
    unreachableStations.has(knownStationKey({ name: 'furnace', position })) ||
    (probe !== null && probe(position) === 'no_path')
  for (const entry of state.furnaces ?? []) {
    if (!isSensedStation(entry)) continue
    const position: Vec3Json = { x: entry.x, y: entry.y, z: entry.z }
    if (distance(position, state.self.eyePosition) <= options.reach) continue
    if (refused(position)) return position
  }
  for (const station of knownFurnaces(state, unreachableStations)) {
    const position = station.position
    if (distance(position, state.self.eyePosition) <= options.reach) continue
    if (!refused(position)) continue
    return { x: position.x, y: position.y, z: position.z }
  }
  return null
}

/** Nearest mineable block whose yield satisfies `spec` (`oak_log` for `log`). */
function nearestProducerYield(state: WorldState, spec: string): string | null {
  let best: BlockState | null = null
  for (const block of state.blocks) {
    if (block.kind !== 'log' && block.kind !== 'stone' && block.kind !== 'ore') continue
    if (!resourceMatches(block.yield ?? block.name, spec)) continue
    if (best === null || block.distance < best.distance) best = block
  }
  return best === null ? null : (best.yield ?? best.name)
}

const EMPTY_STATIONS: ReadonlySet<string> = new Set<string>()

/** Remembered stations of one kind, nearest first. */
function knownStations(state: WorldState, station: string): KnownStationLike[] {
  const found: KnownStationLike[] = []
  for (const resource of state.signals.knownResources ?? []) {
    if (resource.kind !== 'station' || !resource.name.includes(station)) continue
    found.push({ name: resource.name, position: resource.position })
  }
  found.sort((a, b) => distance(a.position, state.self.position) - distance(b.position, state.self.position))
  return found
}

/**
 * Furnace coordinates the smelt prerequisite can walk to.
 *
 * `signals.knownResources` is the controller's canonical, filtered durable
 * resource set. `state.furnaces` is also a grounded projection of remembered
 * and sensed stations. It is needed here when the host has intentionally
 * withheld a station from the filtered signal envelope (for example while a
 * furnace is held); the explicit unreachable set remains the safety boundary
 * so a retired station cannot be reintroduced.
 *
 * Sensed furnaces are handled separately by `reachableSensedFurnace`; a
 * registered/remembered furnace reaches this list through either the canonical
 * signal set or the grounded station projection, including a station placed by
 * this generation.
 */
function knownFurnaces(
  state: WorldState,
  unreachableStations: ReadonlySet<string> = EMPTY_STATIONS,
): KnownStationLike[] {
  const found = knownStations(state, 'furnace')
  const seen = new Set(found.map((station) => knownStationKey(station)))
  for (const entry of state.furnaces ?? []) {
    const station: KnownStationLike = {
      name: 'furnace',
      position: { x: entry.x, y: entry.y, z: entry.z },
    }
    const key = knownStationKey(station)
    if (seen.has(key) || unreachableStations.has(key)) continue
    seen.add(key)
    found.push(station)
  }
  found.sort((a, b) => distance(a.position, state.self.position) - distance(b.position, state.self.position))
  return found
}

/**
 * A placed-station kind the world model tracks (`state.ts`: the `craftingTables`
 * / `furnaces` projections).
 */
export type StationKind = 'crafting_table' | 'furnace'

interface StationKindProjection {
  kind: StationKind
  /** block names the sensor projects into this kind's station list */
  names: ReadonlySet<string>
  /** projected station cells (sensed near-field first, then remembered) */
  project: (state: WorldState) => readonly StationEntry[]
}

/**
 * Station item -> world-model projection, resolved through the SAME name sets
 * the sensor builds the projections from (`CRAFT_STATIONS` / `FURNACE_STATIONS`).
 * There is deliberately no second station list here.
 */
const STATION_KIND_PROJECTIONS: readonly StationKindProjection[] = [
  { kind: 'crafting_table', names: CRAFT_STATIONS, project: (state) => state.craftingTables },
  { kind: 'furnace', names: FURNACE_STATIONS, project: (state) => state.furnaces ?? [] },
]

/**
 * The world-model station kind an item name belongs to, or null when the item is
 * not a placed station the world model tracks. Data-driven (the sensor's own
 * name sets), so no station item is special-cased at a call site.
 */
export function stationKindOfItem(item: string): StationKind | null {
  const normalized = item.includes(':') ? item.slice(item.lastIndexOf(':') + 1) : item
  for (const projection of STATION_KIND_PROJECTIONS) {
    if (projection.names.has(normalized)) return projection.kind
  }
  return null
}

/** What the world model knows about one station kind right now. */
export interface StationWorldTruth {
  /** every station cell the world model holds, nearest first (blacklist NOT applied) */
  cells: KnownStationLike[]
  /**
   * the DURABLE cells of `cells`: projection entries the host remembered plus
   * `signals.knownResources` records. A cell here blocks a duplicate station
   * craft only while it is USABLE (not in `unreachable`); see `stationCraftAllowed`.
   */
  remembered: KnownStationLike[]
  /** the cells of `cells` the explicit reachability blacklist retired */
  unreachable: KnownStationLike[]
  /** stations of this kind the near-field sensor can see this tick */
  sensed: number
  /** how many of the station ITEM the bot holds */
  held: number
}

/**
 * OPERATOR RULE (station-use-before-craft; measured live 2026-09-21): while 26
 * crafting tables and 17 furnaces were known, the queue crafted a crafting table
 * (wasted planks) and then a furnace (wasted cobblestone). A station that already
 * exists in the world model must be USED or WALKED TO before that station is
 * crafted; crafting a station item is correct only when no station of that kind
 * exists anywhere in the world model and none is held.
 *
 * What counts as "already exists" is the DURABLE world knowledge only
 * (`remembered`, plus a held copy): those cells are real station coordinates the
 * retrieval ladder can be sent to. What counts as USABLE is narrower still: a
 * cell the runtime proved unreachable (the move-failure memory / the reachability
 * gate's withheld `RETRIEVE`) does not block a new craft, because a cell that
 * cannot be reached is not a route (`stationCraftAllowed`).
 *
 * #58 SENSED-ONLY SEMANTICS ARE KEPT LOAD-BEARING HERE: a near-field sensed cell
 * is deliberately NOT part of `remembered`. In-place station availability and the
 * "a sensed station that already failed a pathing craft is re-planned as
 * unavailable, so the ladder may craft/place a local station" re-plan are owned by
 * `sensedCraftingTableAvailable` / `sensedTableUsable` and stay exactly as they
 * were (pinned by buddy-driver/test-furnace-place: a sensed table that failed
 * pathing, or that the controller explicitly blacklisted, must still keep the
 * local station craft). A remembered coordinate, by contrast, is durable
 * knowledge that the body must reach - it is never satisfied in place.
 *
 * This is world truth (TRUE), not a preference: the count comes from the same
 * per-kind projection (`state.craftingTables` / `state.furnaces`) and the same
 * remembered records (`signals.knownResources`, kind `station`) the existing
 * station-source machinery already reads, so this introduces no second station
 * model.
 */
export function stationWorldTruth(
  state: WorldState,
  options: CandidateOptions,
  kind: StationKind,
  item: string = kind,
): StationWorldTruth {
  const unreachableStations = options.unreachableStations ?? EMPTY_STATIONS
  const projection = STATION_KIND_PROJECTIONS.find((entry) => entry.kind === kind)
  const cells = new Map<string, KnownStationLike>()
  const remembered = new Map<string, KnownStationLike>()
  let sensed = 0
  if (projection !== undefined) {
    for (const entry of projection.project(state)) {
      const station: KnownStationLike = {
        name: projection.kind,
        position: { x: entry.x, y: entry.y, z: entry.z },
      }
      const key = knownStationKey(station)
      if (isSensedStation(entry)) {
        sensed += 1
      } else {
        remembered.set(key, station)
      }
      if (!cells.has(key)) cells.set(key, station)
    }
  }
  for (const known of knownStations(state, kind)) {
    const key = knownStationKey(known)
    remembered.set(key, known)
    if (!cells.has(key)) cells.set(key, known)
  }
  const nearestFirst = (entries: Iterable<KnownStationLike>): KnownStationLike[] =>
    [...entries].sort(
      (a, b) => distance(a.position, state.self.position) - distance(b.position, state.self.position),
    )
  const all = nearestFirst(cells.values())
  return {
    cells: all,
    remembered: nearestFirst(remembered.values()),
    unreachable: all.filter((station) => unreachableStations.has(knownStationKey(station))),
    sensed,
    held: state.inventory.counts[item] ?? 0,
  }
}

/**
 * Crafting a station item is a correct route when no USABLE station of that kind
 * exists and none is held (see `stationWorldTruth` for why a sensed cell is not
 * part of that decision).
 *
 * A durable cell the runtime PROVED unreachable - the move-failure memory
 * blacklisted it or the reachability gate withheld its `RETRIEVE` (`needs_descend`
 * / `missing_tool`) - is not a usable station, so it must not suppress making a
 * new one. This is exactly the escape hatch that keeps the craft path alive when
 * every known cell is retired, and the same world truth `stationAcquisitionCandidates`
 * already uses when it declines to offer a walk to a retired cell.
 *
 * Measured live (run-mubobiq6-12onv, source 580705a, m3-live): the body held
 * 5 oak_planks + 64 cobblestone + 4 sticks with NO pickaxe, inside an oak-leaf
 * canopy 7 blocks above the remembered furnace. Both known stations (furnace
 * b8_65_24, crafting_table b17_71_-11) were withheld `reason=needs_descend
 * missing=[tool:pickaxe@0]`, and the active `smelt:charcoal` goal starved to
 * `CANDIDATE_STARVATION presented=2 productive=0`: the remembered-but-unreachable
 * table blocked the 2x2 `CRAFT:crafting_table` step that would have broken the
 * deadlock (furnace needs a table -> table needs a pickaxe to reach -> pickaxe
 * needs a table). A cell that cannot be reached is not a route.
 */
export function stationCraftAllowed(truth: StationWorldTruth): boolean {
  if (truth.held > 0) return false
  if (truth.remembered.length === 0) return true
  const retired = new Set(truth.unreachable.map((station) => knownStationKey(station)))
  return truth.remembered.every((station) => retired.has(knownStationKey(station)))
}

/**
 * The typed fact behind a withheld station craft: the current craft goal needs
 * (or would produce) a station kind the world model already knows, so the craft
 * step was replaced by the station-source ladder - use/walk-to when a route
 * exists, and this typed gap when every known cell was retired.
 *
 * Derived from the SAME truth and the SAME ladder the generator used, so the
 * marker can never disagree with the offered set (mirror of `smeltRouteGap`).
 */
export interface CraftStationGap {
  /** the craft goal's item (for example `furnace`) */
  item: string
  /** the station kind the craft needs or would produce */
  station: StationKind
  reason: 'station_held' | 'known_station' | 'known_station_unreachable'
  /** how many of the station item the bot holds */
  held: number
  /** stations of this kind the sensor can see */
  sensed: number
  /** known station cells, nearest first */
  knownStations: string[]
  /** known station cells the move-failure memory / reachability gate retired */
  unreachableStations: string[]
  /** the grounded step the generator offered instead of the craft */
  next: 'use_known_station' | 'place_held' | 'capability_gap'
}

export const CRAFT_STATION_ALREADY_KNOWN = 'CRAFT_STATION_ALREADY_KNOWN'

export function formatCraftStationGap(gap: CraftStationGap): string {
  const known = gap.knownStations.slice(0, MAX_GAP_STATIONS)
  return [
    CRAFT_STATION_ALREADY_KNOWN,
    `item=${gap.item}`,
    `station=${gap.station}`,
    `reason=${gap.reason}`,
    `held=${gap.held}`,
    `sensed=${gap.sensed}`,
    `known_stations=[${known.join(';')}]`,
    `unreachable_stations=[${gap.unreachableStations.slice(0, MAX_GAP_STATIONS).join(';')}]`,
    `next=${gap.next}`,
  ].join(' ')
}

/** The station requirement the current craft goal would satisfy by crafting. */
function craftStationRequirement(
  state: WorldState,
  options: CandidateOptions,
): { item: string; station: StationKind; stationItem: string; purpose: string } | null {
  const recipes = options.recipes ?? null
  const current = state.goalQueue?.current ?? null
  if (recipes === null || current === null || current.kind !== 'craft') return null
  const item = current.targetItem
  if (item === null) return null
  // (1) the goal's own product is a station item the world model already knows
  //     (this is the branch `craftCandidates` takes first)
  const productKind = stationKindOfItem(item)
  if (productKind !== null && !stationCraftAllowed(stationWorldTruth(state, options, productKind, item))) {
    return { item, station: productKind, stationItem: item, purpose: `craft ${item}` }
  }
  // (2) the recipe needs a placed 3x3 station the world model already knows
  if (sensedCraftingTableAvailable(state, options, item)) return null
  if (!planRequiresTable(recipes, item, state.inventory.counts, craftGoalRequirement(state, item))) return null
  const table = stationWorldTruth(state, options, 'crafting_table', 'crafting_table')
  if (stationCraftAllowed(table)) return null
  return { item, station: 'crafting_table', stationItem: 'crafting_table', purpose: `craft ${item}` }
}

/**
 * `CRAFT_STATION_ALREADY_KNOWN`: the craft goal's station requirement is already
 * satisfied by a station the world model holds, so no `CRAFT:<station>` step is
 * offered. Null whenever the craft path is a correct route (no station known and
 * none held) or the goal is not a station-requiring craft.
 */
export function craftStationGap(state: WorldState, options: CandidateOptions): CraftStationGap | null {
  const requirement = craftStationRequirement(state, options)
  if (requirement === null) return null
  const truth = stationWorldTruth(state, options, requirement.station, requirement.stationItem)
  if (stationCraftAllowed(truth)) return null
  const ladder = stationAcquisitionCandidates(
    state,
    options,
    requirement.stationItem,
    requirement.station,
    requirement.purpose,
  )
  const whatHappens: CraftStationGap['next'] =
    truth.held > 0 && ladder.candidates.some((candidate) => candidate.kind === 'PLACE')
      ? 'place_held'
      : ladder.candidates.some((candidate) => candidate.kind === 'RETRIEVE' || candidate.kind === 'MOVE')
        ? 'use_known_station'
        : 'capability_gap'
  const reason: CraftStationGap['reason'] =
    truth.held > 0
      ? 'station_held'
      : whatHappens === 'capability_gap'
        ? 'known_station_unreachable'
        : 'known_station'
  const describe = (station: KnownStationLike): string =>
    `${station.position.x},${station.position.y},${station.position.z}`
  return {
    item: requirement.item,
    station: requirement.station,
    reason,
    held: truth.held,
    sensed: truth.sensed,
    knownStations: truth.remembered.map(describe),
    unreachableStations: truth.unreachable.map(describe),
    next: whatHappens,
  }
}

/**
 * A sensed station is not automatically a grounded route (mirror of
 * `sensedCraftingTableAvailable` for craft goals): once the exact `CRAFT:furnace`
 * step failed with a path failure, re-plan as if that table were absent so the
 * ladder falls through to a remembered/held table. The controller's explicit
 * blacklist applies to the sensed cell exactly like its remembered copy - they
 * are the SAME coordinate, and the live M2 loop blacklisted the remembered
 * `crafting_table@40,29,35` while a `CRAFT:furnace` at the sensed copy of that
 * cell was still offered, producing `ABANDON_REASON ... reason=unreachable`.
 */
function sensedTableUsable(
  state: WorldState,
  options: CandidateOptions,
  sensed: Vec3Json,
): boolean {
  const unreachableStations = options.unreachableStations ?? EMPTY_STATIONS
  if (unreachableStations.has(knownStationKey({ name: 'crafting_table', position: sensed }))) return false
  if (!stationApproachReachable(state, options, sensed, 'crafting_table')) return false
  const craftFailures = state.signals.failedCandidates['CRAFT:furnace'] ?? 0
  const lastFailure = state.signals.lastFailureCode
  const pathFailure = lastFailure === 'path_no_path' || lastFailure === 'path_stuck'
  return !(craftFailures > 0 && pathFailure)
}

/**
 * Where the furnace craft step gets its 3x3 station, as a ladder of GROUNDED
 * routes. A sensed table only serves the in-place CRAFT when it is inside
 * interaction reach; otherwise the sub-step is an acquisition (retrieve a
 * remembered table / place a held one), and only as a last resort is the CRAFT
 * step issued against a distant sensed table the executor must walk to. A
 * proven-unreachable coordinate (blacklist) or a table that already failed a
 * pathing CRAFT is never re-selected as if it were fresh.
 */
function craftingTableSource(
  state: WorldState,
  options: CandidateOptions,
): { kind: 'sensed' | 'remembered'; station: KnownStationLike } | { kind: 'held-place'; spot: Vec3Json } | null {
  const unreachableStations = options.unreachableStations ?? EMPTY_STATIONS
  const placeSpotRetryLimit = options.placeSpotRetryLimit ?? DEFAULT_PLACE_SPOT_RETRY_LIMIT
  // Sensed stations use the same explicit reachability blacklist and path-failure
  // memory as remembered stations: a stale sensor result must not bypass
  // MOVE_FAILMEM and re-enter the same CRAFT:furnace -> JUMP_FAIL loop. The first
  // USABLE sensed table wins; blacklisted/failed cells are skipped, not fatal.
  const sensed = state.craftingTables.find(
    (position) =>
      isSensedStation(position) && sensedTableUsable(state, options, position),
  )
  const sensedInReach = sensed !== undefined && distance(sensed, state.self.eyePosition) <= options.reach
  if (sensed !== undefined && sensedInReach) return { kind: 'sensed', station: { name: 'crafting_table', position: sensed } }
  const remembered = knownStations(state, 'crafting_table').find(
    (station) => !unreachableStations.has(knownStationKey(station)),
  )
  if (remembered !== undefined) return { kind: 'remembered', station: remembered }
  if ((state.inventory.counts.crafting_table ?? 0) > 0) {
    const spot = dryAwarePlacementSpots(state).find(
      (candidate) =>
        (state.signals.failedCandidates[`PLACE:crafting_table:${blockId('p', candidate)}`] ?? 0) <
        placeSpotRetryLimit,
    )
    if (spot !== undefined) return { kind: 'held-place', spot }
  }
  if (sensed !== undefined) return { kind: 'sensed', station: { name: 'crafting_table', position: sensed } }
  return null
}

/**
 * True when the recipe variant `planNextCraftStep` selected for this goal needs
 * a placed crafting_table. Re-planning with an assumed station (only the
 * `tableAvailable` flag changes) reports the chosen variant's own
 * `requiresTable`, so this never guesses from a second recipe lookup. `want` is
 * forwarded so a partially-held `craft N x item` goal still reports the station
 * requirement instead of looking already satisfied.
 */
function planRequiresTable(
  recipes: RecipeIndex,
  focusItem: string,
  counts: Readonly<Record<string, number>>,
  want = 1,
): boolean {
  const op = planNextCraftStep(recipes, focusItem, counts, true, want).op
  return op !== null && op.type === 'craft' && op.requiresTable
}

/**
 * The station-source ladder for one station ITEM, mirroring the smelt
 * prerequisite path (`furnaceAcquisitionCandidates`):
 *
 *   (a) place a held station at a grounded spot (inventory first, #78);
 *   (b) walk to a DURABLE (remembered/registered) station the move-failure
 *       blacklist has not excluded;
 *   (c) else nothing - the caller still owns the in-place CRAFT at a sensed
 *       station and the material route.
 *
 * `heldStationPlacement` is the same mechanical solve the place branch uses, so
 * a held station the known terrain can host is placed even when the strict live
 * spot scan is empty; a genuine geometry dead end is refused with its typed
 * reason and the grounded alternative instead of collapsing to nothing.
 *
 * Walk targets come from the DURABLE cells (the `state` projection's remembered
 * entries + `signals.knownResources`), the same union the smelt ladder reads, so
 * the host withholding a station from the filtered signal envelope cannot hide a
 * station from the craft path. A merely SENSED cell is deliberately not a walk
 * target: its availability is `sensedCraftingTableAvailable`'s decision, and a
 * sensed table that just failed a pathing craft must not be re-offered as a fresh
 * walk (#58, pinned by buddy-driver/test-furnace-place).
 */
function stationAcquisitionCandidates(
  state: WorldState,
  options: CandidateOptions,
  item: string,
  station: StationKind,
  purpose: string,
): CraftCandidatesResult {
  const unreachableStations = options.unreachableStations ?? EMPTY_STATIONS
  const truth = stationWorldTruth(state, options, station, item)
  const known = truth.remembered.find((cell) => !unreachableStations.has(knownStationKey(cell)))
  if (truth.held > 0) {
    const placement = heldStationPlacement(state, options, item, purpose)
    if (placement.spot !== null) {
      return { candidates: [placeStationCandidate(state, options, item, placement.spot, purpose)], placeRefusal: null }
    }
    if (known !== undefined) {
      return { candidates: [knownStationRetrievalCandidate(state, options, known)], placeRefusal: null }
    }
    return {
      candidates: placement.alternative === null ? [] : [placement.alternative],
      placeRefusal: placement.refusal,
    }
  }
  if (known !== undefined) return { candidates: [knownStationRetrievalCandidate(state, options, known)], placeRefusal: null }
  return { candidates: [], placeRefusal: null }
}

/**
 * M2 craft deadlock: the station ladder for a table-requiring CRAFT goal. This
 * is `stationAcquisitionCandidates` for the 3x3 table, kept as the named entry
 * point the craft path and its fixtures already use.
 */
function tableAcquisitionCandidates(
  state: WorldState,
  options: CandidateOptions,
  focusItem: string,
): CraftCandidatesResult {
  return stationAcquisitionCandidates(state, options, 'crafting_table', 'crafting_table', `craft ${focusItem}`)
}

/**
 * True when this plan step would craft a station ITEM the world model already
 * knows or the bot already holds. Such a step is never a route (operator rule,
 * see `stationWorldTruth`): the station-source ladder answers instead. A `place`
 * step is the held-station route and is deliberately not withheld here.
 */
function planStepCraftsKnownStation(state: WorldState, options: CandidateOptions, op: CraftOp): boolean {
  if (op.type !== 'craft') return false
  const station = stationKindOfItem(op.item)
  if (station === null) return false
  return !stationCraftAllowed(stationWorldTruth(state, options, station, op.item))
}

/**
 * Issue #58: build the pure cost/feasibility input for the furnace precondition
 * from the live world state and the explicit station blacklist. `tableAvailable`
 * is true for any table the bot can actually reach (`craftingTableSource`), so
 * an unreachable remembered furnace no longer leaves `craft_and_place`
 * infeasible and the whole prerequisite collapsing to WAIT.
 */
export function furnacePrereqInputFromState(state: WorldState, options: CandidateOptions): PrereqInput {
  const counts = state.inventory.counts
  let stoneCount = 0
  for (const [name, count] of Object.entries(counts)) {
    if (count > 0 && matchesResourceClass(name, 'stone')) stoneCount += count
  }
  const unreachableStations = stationUnreachableSet(state, options)
  const furnaces = knownFurnaces(state, unreachableStations)
  const reachableFurnace = furnaces.find((station) => !unreachableStations.has(knownStationKey(station))) ?? null
  return {
    goal: state.goalQueue?.current ?? null,
    heldCount: counts.furnace ?? 0,
    placedCount: (state.furnaces ?? []).filter(isSensedStation).length,
    stoneCount,
    tableAvailable:
      craftingTableSource(state, options) !== null,
    // `tableAvailable` is a USABLE (held/reachable) station. A table that is not
    // usable but is craftable from the held materials is still a valid route
    // (craft the 2x2 table, place it, then craft the furnace at it), so the pure
    // feasibility input names that fact instead of answering `no_crafting_table`
    // and starving. Resolved through the same recipe planner the craft path uses.
    tableCraftable: craftingTableCraftable(state, options),
    placementSpot: state.placementSpots.length > 0 ? leastFailedPlacementSpot(state, 'furnace') : null,
    knownStation: reachableFurnace ?? furnaces[0] ?? null,
    unreachableStations,
    self: state.self.position,
    rankPolicy: options.prereqRankPolicy,
  }
}

/**
 * True when a `crafting_table` can be produced from the live inventory alone
 * (2x2 inventory-grid recipe) or is already held. Placement geometry is a
 * separate fact (`placementSpots` / `heldStationPlacement`); this answers only
 * the recipe-material half, so the typed `no_crafting_table` refusal is reserved
 * for a genuine missing-material case.
 */
function craftingTableCraftable(state: WorldState, options: CandidateOptions): boolean {
  if ((state.inventory.counts.crafting_table ?? 0) > 0) return true
  const recipes = options.recipes ?? null
  if (recipes === null) return false
  return planNextCraftStep(recipes, 'crafting_table', state.inventory.counts, false).op !== null
}

/** One grounded candidate for each feasible path (craft_and_place = the CRAFT step). */
function candidatesForPrereqPath(
  state: WorldState,
  options: CandidateOptions,
  path: PrereqPath,
  input: PrereqInput,
): Candidate[] {
  switch (path) {
    case 'place_held':
      return placeCandidates(state, options, 'furnace')
    case 'use_known_station': {
      const known = input.knownStation
      return known === null ? [] : [knownStationRetrievalCandidate(state, options, known)]
    }
    case 'craft_and_place':
      return craftFurnaceCandidate(state, options)
  }
}

/** CRAFT/PLACE step toward a furnace: use a table in reach, walk to a remembered one, or place a held one. */
function craftFurnaceCandidate(state: WorldState, options: CandidateOptions): Candidate[] {
  const source = craftingTableSource(state, options)
  if (source === null) {
    // NO usable table (none held, none sensed/reachable, every remembered cell
    // retired). That does not make the furnace unreachable: a crafting_table is
    // itself a 2x2 INVENTORY-GRID recipe, so when its materials are held the
    // next grounded step is making (then placing) the table. Without this arm the
    // `craft_and_place` path returned nothing, `planPrereqOptions` reported
    // `no_crafting_table` and the live smelt starved while the body held 5 planks
    // + 64 cobblestone (run-mubobiq6-12onv). The plan step is resolved by the
    // SAME pure recipe planner the craft goals use, so the furnace and its table
    // can never disagree on the recipe chain.
    const recipes = options.recipes ?? null
    if (recipes === null) return []
    const plan = planNextCraftStep(recipes, 'furnace', state.inventory.counts, false)
    if (plan.op === null) return []
    if (planStepCraftsKnownStation(state, options, plan.op)) return []
    const step = craftPlanStepCandidate(state, options, plan.op, 'furnace').candidate
    return step === null ? [] : [step]
  }
  if (source.kind === 'held-place') {
    return [placeStationCandidate(state, options, 'crafting_table', source.spot, `craft ${FURNACE_STONE_COST} cobblestone into a furnace`)]
  }
  if (source.kind === 'remembered') {
    return [knownStationRetrievalCandidate(state, options, source.station)]
  }
  const table = source.station.position
  return [
    {
      id: 'CRAFT:furnace',
      kind: 'CRAFT',
      label: `craft 1 x furnace from ${FURNACE_STONE_COST} cobblestone at the crafting table, then place it`,
      targetName: 'furnace',
      target: table,
      targetEntityId: null,
      itemName: 'furnace',
      requiresTool: false,
      toolName: null,
      inReach: distance(table, state.self.eyePosition) <= options.reach,
      hasStandableAdjacent: true,
      meta: { tick: state.tick, craftItem: 'furnace', craftCount: 1, requiresTable: true, furnaceSource: 'craft', tableSource: 'sensed' },
    },
  ]
}

/**
 * Issue #58: enumerate EVERY feasible way to satisfy "a usable furnace is
 * available" (place held / use known station / craft-and-place), score them by
 * cost, and return the candidates cheapest-path-first. Each candidate carries
 * `meta.prereqPath` so the controller can log `PREREQ_OPTION` and suppress the
 * paths that lost.
 */
function furnaceAcquisitionCandidates(state: WorldState, options: CandidateOptions): Candidate[] {
  if (prereqSubjectForGoal(state.goalQueue?.current ?? null) === null) return []
  const input = furnacePrereqInputFromState(state, options)
  const decision = planPrereqOptions(input)
  const out: Candidate[] = []
  for (const option of decision.options) {
    if (!option.feasible) continue
    for (const candidate of candidatesForPrereqPath(state, options, option.path, input)) {
      out.push({
        ...candidate,
        meta: {
          ...candidate.meta,
          prereqPath: option.path,
          prerequisiteRole: FURNACE_PREREQUISITE_ROLE,
          prereqCost: Math.round(option.cost * 10) / 10,
          ...(option.path === 'place_held' ? { furnaceSource: 'held' } : {}),
        },
      })
    }
  }
  return out
}

/**
 * Why a remembered non-furnace station is retrieved: a smelt goal walks to a
 * table to craft its furnace, a table-requiring craft goal walks to one to
 * craft its target.
 */
function stationRetrievalPurpose(state: WorldState): string {
  const goal = state.goalQueue?.current ?? null
  const focus = goal?.targetItem ?? state.goal.targetItem
  if (goal?.kind === 'craft' && typeof focus === 'string' && focus.length > 0) return `craft ${focus}`
  return 'craft a furnace'
}

/**
 * Flatten a vertical plan into candidate meta, mirroring the executor's
 * `vertical=reuse|staircase|staircase-up|pillar` contract.
 */
function verticalPlanMeta(
  vertical: VerticalPlan | null,
  fallbackFromY: number,
  fallbackToY: number,
): Record<string, string | number | boolean> {
  const meta: Record<string, string | number | boolean> = {
    vertical: vertical?.kind ?? 'none',
    verticalFromY: vertical?.fromY ?? fallbackFromY,
    verticalToY: vertical?.toY ?? fallbackToY,
  }
  switch (vertical?.kind) {
    case undefined:
      return meta
    case 'reuse':
      meta.tunnelX = vertical.tunnel.x
      meta.tunnelY = vertical.tunnel.y
      meta.tunnelZ = vertical.tunnel.z
      if (vertical.clear !== undefined) {
        meta.tunnelClearX = vertical.clear.cell.x
        meta.tunnelClearY = vertical.clear.cell.y
        meta.tunnelClearZ = vertical.clear.cell.z
        meta.tunnelClearName = vertical.clear.name
      }
      return meta
    case 'staircase':
      meta.stairDir = vertical.dir
      meta.stairFromY = vertical.fromY
      meta.stairToY = vertical.toY
      meta.stairDigX = vertical.dig.x
      meta.stairDigY = vertical.dig.y
      meta.stairDigZ = vertical.dig.z
      meta.stairStepX = vertical.step.x
      meta.stairStepY = vertical.step.y
      meta.stairStepZ = vertical.step.z
      meta.stairBlockName = vertical.digName ?? 'unknown'
      return meta
    case 'staircase-up':
      meta.upDir = vertical.dir
      meta.upFromY = vertical.fromY
      meta.upToY = vertical.toY
      meta.upDigX = vertical.dig.x
      meta.upDigY = vertical.dig.y
      meta.upDigZ = vertical.dig.z
      meta.upStepX = vertical.step.x
      meta.upStepY = vertical.step.y
      meta.upStepZ = vertical.step.z
      meta.upBlockName = vertical.digName ?? 'unknown'
      return meta
    case 'pillar':
      meta.pillarFromY = vertical.fromY
      meta.pillarToY = vertical.toY
      meta.pillarSteps = vertical.steps
      meta.pillarPlaceName = vertical.placeName
      meta.pillarPlaceCount = vertical.placeCount
      return meta
  }
}

function verticalPlanLabel(vertical: VerticalPlan | null): string {
  switch (vertical?.kind) {
    case undefined:
      return ''
    case 'reuse':
      return ` (reuse the tunnel at ${vertical.tunnel.x},${vertical.tunnel.y},${vertical.tunnel.z})`
    case 'staircase':
      return ` (dig a staircase down from y=${vertical.fromY} toward y=${vertical.toY})`
    case 'staircase-up':
      return ` (cut a staircase up at (${vertical.dig.x},${vertical.dig.y},${vertical.dig.z}) from y=${vertical.fromY} toward y=${vertical.toY})`
    case 'pillar':
      return ` (pillar up ${vertical.steps} block(s) from y=${vertical.fromY} toward y=${vertical.toY} with ${vertical.placeName})`
  }
}

/**
 * The same vertical input the primary plan used, minus the remembered tunnel, so
 * the executor can fall back to a different vertical plan when the live reuse
 * entry turns out to be unusable.
 */
function verticalInputFor(state: WorldState, target: Vec3Json): VerticalInput {
  const digSources = protectedVerticalDigSources(state)
  return {
    selfFeetY: state.self.position.y,
    selfPosition: state.self.position,
    target,
    tunnel: state.signals.lastTunnel,
    descent: digSources.descent,
    stepCuts: digSources.stepCuts,
    placeable: selectPlaceableBlock(state.inventory.counts),
    columnSafe: !pillarColumnUnsafeFromBlocks(state.self.position, state.blocks),
    inventory: state.inventory.counts,
  }
}

/** Candidate route legs must obey the same live-structure protection as direct digs. */
function protectedVerticalDigSources(state: WorldState): {
  descent: WorldState['descent']
  stepCuts: WorldState['stepCuts']
} {
  const isProtected = protectedResourceTest(state)
  return {
    descent: (state.descent ?? []).filter(
      (step) => protectedStepProfileRefusal(state, strictStepDigProfile(state, step)) === null,
    ),
    stepCuts: (state.stepCuts ?? []).filter((cut) => !isProtected(cut.cut, cut.name)),
  }
}

function fallbackVerticalMeta(fallback: VerticalPlan | null): Record<string, string | number | boolean> {
  if (fallback === null || fallback.kind === 'reuse') return { fallbackVertical: 'none' }
  switch (fallback.kind) {
    case 'staircase':
      return {
        fallbackVertical: 'staircase',
        fallbackStairDir: fallback.dir,
        fallbackStairToY: fallback.toY,
        fallbackStairDigX: fallback.dig.x,
        fallbackStairDigY: fallback.dig.y,
        fallbackStairDigZ: fallback.dig.z,
        fallbackStairStepX: fallback.step.x,
        fallbackStairStepY: fallback.step.y,
        fallbackStairStepZ: fallback.step.z,
        fallbackStairBlockName: fallback.digName ?? 'unknown',
      }
    case 'staircase-up':
      return {
        fallbackVertical: 'staircase-up',
        fallbackUpDir: fallback.dir,
        fallbackUpToY: fallback.toY,
        fallbackUpDigX: fallback.dig.x,
        fallbackUpDigY: fallback.dig.y,
        fallbackUpDigZ: fallback.dig.z,
        fallbackUpStepX: fallback.step.x,
        fallbackUpStepY: fallback.step.y,
        fallbackUpStepZ: fallback.step.z,
        fallbackUpBlockName: fallback.digName ?? 'unknown',
      }
    case 'pillar':
      return {
        fallbackVertical: 'pillar',
        fallbackPillarToY: fallback.toY,
        fallbackPillarSteps: fallback.steps,
        fallbackPillarPlaceName: fallback.placeName,
      }
  }
}

function knownStationRetrievalCandidate(
  state: WorldState,
  options: CandidateOptions,
  known: KnownStationLike,
): Candidate {
  const isFurnace = known.name.includes('furnace')
  const purpose = isFurnace ? 'smelt' : stationRetrievalPurpose(state)
  const vertical = planVerticalApproach(verticalInputFor(state, known.position))
  const tunnelFallback =
    vertical?.kind === 'reuse'
      ? planVerticalApproach({ ...verticalInputFor(state, known.position), tunnel: null })
      : null
  const verticalMeta = {
    ...verticalPlanMeta(vertical, Math.floor(state.self.position.y), known.position.y),
    ...(vertical?.kind === 'reuse' ? fallbackVerticalMeta(tunnelFallback) : {}),
  }
  return {
    id: `RETRIEVE:known:station:${known.name}:${blockId('b', known.position)}`,
    kind: 'RETRIEVE',
    label: `return to the remembered ${known.name} at (${known.position.x},${known.position.y},${known.position.z}) to ${purpose}, ${distance(known.position, state.self.position)}m away${verticalPlanLabel(vertical)}`,
    targetName: known.name,
    target: known.position,
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: distance(known.position, state.self.eyePosition) <= options.reach,
    hasStandableAdjacent: true,
    meta: {
      tick: state.tick,
      retrieval: 'known',
      resource: isFurnace ? 'furnace' : 'crafting_table',
      resourceKind: 'station',
      knownName: known.name,
      ...(isFurnace ? { furnaceSource: 'known' } : { tableSource: 'remembered' }),
      x: known.position.x,
      y: known.position.y,
      z: known.position.z,
      ...verticalMeta,
    },
  }
}

function nearestResource(state: WorldState, focusItem: string | null): BlockState | null {
  // Match the declared scanned source by block name as well as by drop, so the
  // nearest `gravel` block is the bearing for a `flint` goal even though gravel's
  // own drop is `gravel` (flint is only a probabilistic drop).
  const want = focusItem === null ? null : retrievalWant(focusItem)
  const sourceNames = want !== null && want.kind === 'ore' ? want.blockNames : null
  // A live-structure member is not a bearing either: aiming descent/exploration
  // at the protected structure would keep the body circling the asset instead of
  // re-sourcing the item. Membership truth only; no structure is named here.
  const liveStructures = liveStructureIndexOf(state)
  let best: BlockState | null = null
  for (const block of state.blocks) {
    if (block.kind === 'hazard') continue
    if (isLiveStructureMember(liveStructures, block.position)) continue
    if (
      focusItem !== null &&
      !resourceMatches(block.yield, focusItem) &&
      !(sourceNames?.includes(block.name) ?? false)
    )
      continue
    if (best === null || block.distance < best.distance) best = block
  }
  return best
}

/**
 * Return the resource bearing that an exploration leg should approach.
 *
 * A sensed block is the strongest local fact, but it is not the only grounded
 * fact available to the candidate generator.  The controller's durable
 * `knownResources` signal is also a mechanically valid bearing after the
 * direct retrieval candidate has been withheld for local recovery.  Falling
 * back to an arbitrary nearby standable cell in that case turns recovery into
 * a two-cell walk loop and hides the fact that the current Option still has a
 * useful route.  This helper preserves the same typed resource matching and
 * stale/blacklist rules as `knownResourceFor`; it does not choose a semantic
 * Option or rank missions.
 */
function explorationResourcePosition(
  state: WorldState,
  focusItem: string | null,
  blacklistedMoveTargets: ReadonlySet<string> | undefined,
): Vec3Json | null {
  const sensed = nearestResource(state, focusItem)
  if (sensed !== null) return sensed.position
  const want = retrievalWant(focusItem)
  if (want === null) return null
  return knownResourceFor(state, want, blacklistedMoveTargets)?.position ?? null
}

interface RetrievalWant {
  item: string
  kind: 'ore' | 'log' | 'structure'
  blockNames: readonly string[]
}

/**
 * M3: the name-scanned source of a focus item can be structure FABRIC rather
 * than a block that drops the item. `blaze_rod` is a blaze mob drop; the only
 * grounded affordance is the Nether-fortress body (`NETHER_STRUCTURE_BLOCK_NAMES`)
 * that hosts the blazes. A want whose scanned source is entirely structure
 * fabric is therefore a STRUCTURE ROUTE: it is a trip to the fortress, and the
 * kill/pickup machinery still owns the actual rod. It is never a claim that
 * `nether_bricks` yields `blaze_rod` (`resourceMatches` stays exact), so the
 * MINE arm keeps withholding the body blocks for a `blaze_rod` focus.
 *
 * `isStructureFabricSource` lives in `state.ts` because the SENSOR needs the same
 * classification to verify the cell against the claim it makes (a producer
 * landmark is not verified by its own block being present).
 */
function retrievalWant(focusItem: string | null): RetrievalWant | null {
  if (focusItem === null) return null
  const blocks = scannedBlockNames(focusItem)
  if (blocks !== undefined) {
    return {
      item: focusItem,
      kind: isStructureFabricSource(blocks) ? 'structure' : 'ore',
      blockNames: blocks,
    }
  }
  if (
    focusItem === 'charcoal' ||
    focusItem === 'log' ||
    focusItem === 'planks' ||
    focusItem === 'fuel' ||
    focusItem.endsWith('_log')
  ) {
    return { item: focusItem, kind: 'log', blockNames: [] }
  }
  return null
}

const RETRIEVAL_NEED_CAP = 6

/** Issue #43: the live-inventory fuel, or null. */
export function fuelSatisfaction(state: WorldState): InventoryFuel | null {
  return findInventoryFuel(state.inventory.counts)
}

/** The exact skip line emitted when a fuel need is already covered by the inventory. */
export function formatFuelSatisfied(item: string, have: number): string {
  return `FUEL_SATISFIED item=${item} have=${have} -> skip`
}

/** True when the current subgoal exists only to obtain furnace fuel. */
export function goalWantsFuel(goal: { kind?: string; description?: string; targetItem?: string | null } | null): boolean {
  if (goal === null) return false
  if (goal.kind === 'smelt') return true
  return goalCollectsFuel(goal)
}

/** True when the subgoal is a collect whose completion is a fuel substitute. */
export function goalCollectsFuel(goal: { kind?: string; description?: string; targetItem?: string | null } | null): boolean {
  if (goal === null || goal.kind !== 'collect') return false
  if (goal.targetItem === 'fuel' || goal.targetItem === 'planks') return true
  return typeof goal.description === 'string' && /\(fuel\)/i.test(goal.description)
}

/**
 * Issue #43: a retrieval need that a held fuel item already satisfies, so the
 * surface/known trip must not be emitted. The caller only consults this for a
 * fuel need; a `charcoal` smelt still needs its own log input to be held.
 */
export function fuelNeedSatisfiedByInventory(state: WorldState, item: string): boolean {
  const fuel = fuelSatisfaction(state)
  if (fuel === null) return false
  if (item === 'charcoal') return hasLogInInventory(state)
  return true
}

function hasLogInInventory(state: WorldState): boolean {
  return Object.entries(state.inventory.counts).some(
    ([name, count]) => count > 0 && (name.endsWith('_log') || name.endsWith('_wood')),
  )
}

/**
 * Total held furnace-fuel units, mirroring `planner.ts#goalHave` for a
 * `log`/`planks`/`fuel` goal (`countClass(counts, 'fuel') - stick`). A single
 * held log is NOT enough for a `collect 2 x log (fuel)` goal, so the fuel guard
 * must compare against the goal's required count instead of merely "any fuel
 * present" - the live stall held `oak_log:1`, the head goal was skipped, and the
 * generator leaked the queued `collect 3 x raw_iron` need into
 * `RETRIEVE:known:raw_iron` from the very first action.
 */
function heldFuelUnits(state: WorldState): number {
  let total = 0
  for (const [name, count] of Object.entries(state.inventory.counts)) {
    if (count <= 0 || name === 'stick') continue
    if (matchesResourceClass(name, 'fuel')) total += count
  }
  return total
}

/**
 * Does a fuel goal's own required count already hold? For a `collect N x log
 * (fuel)` goal the requirement is N fuel units. A smelt goal's fuel predicate is
 * not a count on the goal itself, so callers keep the historical "any held fuel
 * satisfies the trip" rule for those (see `retrievalNeeds`).
 */
function fuelGoalCountReached(state: WorldState, goal: { requiredCount?: number | null } | null): boolean {
  if (goal === null) return false
  const required = Math.max(1, Math.floor(goal.requiredCount ?? 1))
  return heldFuelUnits(state) >= required
}

/**
 * A queued future row may cross the active-goal retrieval boundary only when
 * the CURRENT row explicitly represents the historical descent proxy.  That
 * proxy is execution scaffolding for a later ore goal, so exposing the next
 * unresolved ore coordinate is part of the proxy's declared meaning.  Ordinary
 * collect/craft/place rows are not proxies: their later queue siblings are a
 * different semantic objective and must stay invisible to local pi.
 */
function allowsQueuedRetrievalProxy(current: { kind?: string; targetItem?: string | null; description?: string } | null): boolean {
  if (current === null) return false
  if (current.kind === 'descend') return true
  return (
    current.kind === 'collect' &&
    current.targetItem === 'cobblestone' &&
    typeof current.description === 'string' &&
    current.description.includes('descend toward ore levels')
  )
}

/**
 * The queued row the CURRENT row's explicit descent proxy exposes, or null.
 *
 * One definition for both consumers: `retrievalNeeds` offers this row's
 * `RETRIEVE:known` route, and the sensor must verify the same row's remembered
 * cells (`SensorInput.retrievalItems`) - verifying only the active focus left a
 * proxied want's stale cell unproven, so it was re-offered forever.
 */
function queuedRetrievalProxyRow<Row extends { id?: string; status?: string; targetItem?: string | null }>(
  queue: { current: { id?: string; kind?: string; targetItem?: string | null; description?: string } | null; goals: readonly Row[] } | null | undefined,
): Row | null {
  const current = queue?.current ?? null
  if (current === null || !allowsQueuedRetrievalProxy(current)) return null
  const rows = queue?.goals ?? []
  const currentIndex = rows.findIndex((queued) => queued.id === current.id)
  if (currentIndex < 0) return null
  return rows.slice(currentIndex + 1).find((queued) => queued.status !== 'done' && queued.status !== 'impossible') ?? null
}

/** The item name of the proxied queued want, for the sensor's verification scope. */
export function queuedRetrievalProxyItem(
  queue: Parameters<typeof queuedRetrievalProxyRow>[0],
): string | null {
  const row = queuedRetrievalProxyRow(queue)
  const item = row?.targetItem
  return typeof item === 'string' && item.length > 0 ? item : null
}

/**
 * Ordered retrieval needs for the ACTIVE execution row.  The active focus is
 * always first.  `state.goal.targetItem` is only a legacy fallback when there
 * is no queue current; while a queue row is active it is mission-level state
 * and may describe a later target (the live #341 flint -> obsidian leak).
 *
 * Future queue rows are NOT a generic fallback.  The sole compatibility
 * exception is the explicit descent proxy above, and even there only the first
 * unresolved row after the current proxy is exposed.  Resolved rows never
 * contribute candidates. Pure.
 *
 * A `craft` goal's missing ingredient is therefore NOT sourced here: that is
 * `craftIngredientRoute`'s job, and it proves the need from the recipe index
 * (the same producer `completeStartablePrerequisites` names). A caller that
 * omits `options.recipes` gets no craft-prerequisite retrieval on purpose; the
 * queue row is not a substitute for the recipe-owned expansion.
 */
function retrievalNeeds(state: WorldState, focusItem: string | null, includeQueued = true): RetrievalWant[] {
  const current = state.goalQueue?.current ?? null
  // A fuel need may only be dropped when the goal that owns it is actually
  // satisfied. `fuelNeedSatisfiedByInventory` answers "is ANY fuel held", which
  // is correct for a smelt's fuel predicate but WRONG for a `collect N x log
  // (fuel)` goal carrying its own required count: `oak_log:1` satisfied a
  // `collect 2 x log (fuel)` head and the generator skipped straight to a
  // queued `collect 3 x raw_iron` need, emitting `RETRIEVE:known:raw_iron` from
  // the first action of the live run. For a fuel-collect goal compare the held
  // fuel units against requiredCount; smelt goals keep the historical rule.
  const needs: Array<{ item: string; fuel: boolean; countReached: boolean }> = []
  const push = (
    item: string | null | undefined,
    fuel: boolean,
    owner: { kind?: string; description?: string; targetItem?: string | null; requiredCount?: number | null } | null,
  ): void => {
    if (typeof item !== 'string' || item.length === 0 || needs.some((need) => need.item === item)) return
    const countReached = goalCollectsFuel(owner) ? fuelGoalCountReached(state, owner) : true
    needs.push({ item, fuel, countReached })
  }
  push(focusItem, goalWantsFuel(current), current)
  if (current === null) {
    push(state.goal.targetItem, false, null)
  } else if (current.kind !== 'smelt' && includeQueued) {
    // The proxy's OWN row decides what it exposes (`queuedRetrievalProxyRow`), so
    // the offered route and the sensor's verification scope cannot diverge.
    const next = queuedRetrievalProxyRow(state.goalQueue)
    if (next !== null) push(next.targetItem, goalWantsFuel(next), next)
  }
  const wants: RetrievalWant[] = []
  for (const need of needs) {
    if (need.fuel && need.countReached && fuelNeedSatisfiedByInventory(state, need.item)) continue
    const want = retrievalWant(need.item)
    if (want !== null) wants.push(want)
    if (wants.length >= RETRIEVAL_NEED_CAP) break
  }
  return wants
}

function mineableNow(block: BlockState): boolean {
  return block.diggable && block.inReach && block.visible !== false
}

/**
 * The sensed block that already serves the want THIS tick - the same
 * precondition as `mineCandidates`' MINE arm, so its presence means the item is
 * obtainable without leaving, and a remembered-coordinate trip must not be
 * offered on top of it.
 *
 * Presence in `state.blocks` alone is NOT a route: a log sensed only at
 * distance (live shape at y=33: surface logs 32 blocks above, no walk-up
 * access) cannot be mined here. Treating those as visible suppressed
 * `RETRIEVE:known:*`, which is the ascent leg that reaches the remembered
 * surface trees, and left the clearance MINE as the only action.
 */
function mineableBlockFor(state: WorldState, want: RetrievalWant): BlockState | null {
  if (want.kind === 'structure') {
    // A structure route's target is the fortress body, not the wanted item: the
    // body block does not drop `blaze_rod` (`resourceMatches` is exact), so it
    // can never satisfy the want in place. Returning null keeps the remembered
    // site as the offered route instead of letting a sensed `nether_bricks`
    // block suppress it. Route only (CAN); the blaze kill and the rod pickup
    // stay with the existing combat/pickup machinery.
    return null
  }
  // A live-structure member is NOT obtainable in place (mineCandidates refuses
  // it), so it must not suppress the remembered-coordinate route either: the
  // remembered route is how the plan re-sources the item elsewhere.
  const liveStructures = liveStructureIndexOf(state)
  const mineableSource = (block: BlockState): boolean =>
    !isLiveStructureMember(liveStructures, block.position) && mineableNow(block)
  if (want.kind === 'ore') {
    return (
      state.blocks.find(
        (block) =>
          block.kind === 'ore' &&
          (resourceMatches(block.yield, want.item) || want.blockNames.includes(block.name)) &&
          mineableSource(block),
      ) ?? null
    )
  }
  return state.blocks.find((block) => block.kind === 'log' && mineableSource(block)) ?? null
}

function knownResourceFor(
  state: WorldState,
  want: RetrievalWant,
  blacklistedMoveTargets: ReadonlySet<string> | undefined,
): KnownResource | null {
  const known = state.signals.knownResources ?? []
  const liveStructures = liveStructureIndexOf(state)
  const falsified = falsifiedKnownCellKeys(state)
  let best: KnownResource | null = null
  for (const resource of known) {
    if (!resourceDimensionMatches(resource, state.self.dimension)) continue
    // `ore` and `structure` routes both match the remembered cell by block name
    // from `scannedBlockNames(focusItem)`; only the log route matches by suffix.
    // A durable fortress site (kind `structure` at injection) and the
    // `nether_bricks` cells #342 also records as `ore` both land here, so the
    // site-anchor route does not depend on the entry's own kind. Dimension
    // re-anchoring above is what keeps an overworld sighting out (see (b) in
    // test-fortress-route.mts): a Nether site never routes from the overworld.
    // A cell remembered as the wanted item ITSELF (loot, a death drop) is a route
    // by identity; the sensor verifies it against live dropped-item truth and
    // withholds it (`drop_absent`) when nothing holds that item any more.
    const matches =
      want.kind === 'log'
        ? resource.name.endsWith('_log')
        : want.blockNames.includes(resource.name) || resource.name === want.item
    if (!matches) continue
    // A remembered cell inside a live structure is not a source: a retrieval
    // there would mine the structure the same way the sensed MINE would. Skip it
    // and keep looking, so a farther ordinary cell is still preferred over
    // dismantling the asset.
    if (isLiveStructureMember(liveStructures, resource.position)) continue
    // #14-world-proof: the loaded world proved this cell no longer holds the
    // remembered resource, so it is not a route (see state.ts#probeKnownResources).
    if (falsified.has(`${resource.position.x},${resource.position.y},${resource.position.z}`)) continue
    if (resourceDepleted(state, resource)) continue
    if (isBlacklistedMoveTarget(state, blacklistedMoveTargets, resource.position)) continue
    if (best === null || distance(resource.position, state.self.position) < distance(best.position, state.self.position)) {
      best = resource
    }
  }
  return best
}

/**
 * The stable id of the executed `RETRIEVE:known` Skill, for the #436 Skill
 * vocabulary (`SKILL_START`/`SKILL_INTERRUPT`/`SKILL_END`). One id for every
 * remembered-cell trip, whatever item or claim it carries.
 */
export const KNOWN_RETRIEVE_SKILL = 'RETRIEVE(knownResource)'

export const KNOWN_RESOURCE_PROOF_DISTANCE = 8

function resourceDepleted(
  state: WorldState,
  resource: KnownResource,
  proofDistance = KNOWN_RESOURCE_PROOF_DISTANCE,
): boolean {
  if (distance(resource.position, state.self.position) > proofDistance) return false
  return !state.blocks.some(
    (block) =>
      block.kind !== 'hazard' &&
      block.position.x === resource.position.x &&
      block.position.y === resource.position.y &&
      block.position.z === resource.position.z,
  )
}

/**
 * Issue #14 staleness: remembered ore/log cells close enough that the sensor
 * would have seen the block if it still existed, but which are absent from the
 * current block list (mined/replaced). The controller logs KNOWN_RESOURCE_STALE
 * for these and the durable store drops them. Pure.
 */
export function staleKnownResources(
  state: WorldState,
  proofDistance = KNOWN_RESOURCE_PROOF_DISTANCE,
): KnownResource[] {
  return (state.signals.knownResources ?? []).filter(
    (resource) =>
      resourceDimensionMatches(resource, state.self.dimension) &&
      (resource.kind === 'ore' || resource.kind === 'log') &&
      resourceDepleted(state, resource, proofDistance),
  )
}

/**
 * Issue #14 dimension re-anchoring: a remembered coordinate is only meaningful
 * in the dimension it was scanned in.
 *
 * The three-way verdict, not a boolean, because "another world" and "no world
 * recorded" are different facts and only the first is evidence:
 *
 *   same          the row names the live dimension: the cell is a target here
 *   other         the row names a different dimension: the cell is a place in
 *                 another world (a Nether fortress cell is not in the overworld)
 *   unattributed  the row names NO dimension: we do not know where the cell is
 *
 * `unattributed` FAILS CLOSED (measured, run-mucqgrdo-21plr). Treating a missing
 * dimension as "matches everything" is the repo's forbidden shape - unknown read
 * as satisfied - one level down from the goal layer: it is exactly how an
 * overworld tree cell (a `jungle_log` at y=85, impossible in the Nether) becomes
 * a Nether locomotion target that the body then burns ticks pillar-climbing
 * toward (`RETRIEVE:known:log:b8_85_6 ... reason=needs_ascend`). Not knowing
 * where a cell is must never be a licence to walk to it.
 *
 * The row is never deleted for this (durable memory is not dropped on ignorance):
 * it is kept, reported typed by the caller
 * (`RESOURCE_SOURCE_EXCLUDED ... reason=dimension_unattributed recorded_dimension=none
 * live_dimension=...`), and becomes usable again through the ordinary write paths,
 * which stamp the world a cell was actually observed in - including the merge's
 * re-observation refresh, which heals a row that never carried one.
 */
export type ResourceDimensionVerdict = 'same' | 'other' | 'unattributed'

/** Prefix-insensitive dimension equality, the same form the durable key uses. */
function normalizeDimensionId(value: string): string {
  return value.replace(/^minecraft:/, '').toLowerCase()
}

/**
 * Classify a remembered cell against the live dimension. Pure; no candidate and
 * no durable row is changed here.
 */
export function resourceDimensionVerdict(resource: KnownResource, dimension: string): ResourceDimensionVerdict {
  const recorded = typeof resource.dimension === 'string' ? resource.dimension.trim() : ''
  if (recorded.length === 0) return 'unattributed'
  return normalizeDimensionId(recorded) === normalizeDimensionId(dimension) ? 'same' : 'other'
}

/**
 * True only when the cell is attributable to the live dimension. An entry whose
 * recorded dimension differs from the bot's current one is NEVER offered as a
 * retrieval target, and neither is an entry that records none. This is a
 * world-truth filter, not a preference.
 */
export function resourceDimensionMatches(resource: KnownResource, dimension: string): boolean {
  return resourceDimensionVerdict(resource, dimension) === 'same'
}

/**
 * The per-tick sink the offer fills with its typed `DIG_ROUTE_REFUSED` facts.
 * Threaded explicitly through the arms so the generator stays a pure function of
 * its inputs (no module-level state, no logger).
 */
type DigRouteRefusalSink = DigRouteRefusal[]

/** Bound on retained refusals per tick: a dead end is stated once, not N times. */
const DIG_ROUTE_REFUSAL_CAP = 8

function dedupeDigRouteRefusals(refusals: readonly DigRouteRefusal[]): DigRouteRefusal[] {
  const seen = new Set<string>()
  const out: DigRouteRefusal[] = []
  for (const refusal of refusals) {
    const line = formatDigRouteRefused(refusal)
    if (seen.has(line)) continue
    seen.add(line)
    out.push(refusal)
    if (out.length >= DIG_ROUTE_REFUSAL_CAP) break
  }
  return out
}

function cellText(position: Vec3Json): string {
  return `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`
}

/**
 * The general "the target has no walkable route, so change the TERRAIN" route.
 *
 * MEASURED (run-muc9k936-1f3vb, main ebec6f2, m3-live): a body sealed inside the
 * 1-wide shaft it had climbed sensed only its OWN feet cell as standable
 * (`state.ts#buildTerrain` samples 5x5x3), so `travelApproachLeg` found no cell
 * that changes the stand situation, `entryCandidates` reported
 * `ROUTE_ESCALATE reason=all_routes_spent`, and the offer collapsed to
 * `['WAIT','ESCALATE']` while the KNOWN gate sat 21 blocks away behind ordinary
 * stone. Every bounded recovery family was starved for the same reason: they all
 * move the BODY to a cell the sensor already believes is standable.
 *
 * The sensor knows more than the walk arms use: `state.descent` carries one
 * pre-computed cardinal option per direction x {down, level} with the concrete
 * dig cells, the block, its harvest requirement and the SAFE verdict including
 * its typed refusal. A `level` option is exactly "tunnel one block forward", a
 * `down` option is "staircase one block down/forward". Grounding the one that
 * STRICTLY reduces the distance to the goal's own target is therefore the
 * mechanical route a player would take, and it needs no new executor, guard or
 * postcondition: the candidate is built through the SAME
 * `descendCandidateFromStep` and runs through the SAME `runDescend` as every
 * other bounded dig step.
 *
 * CAN/TRUE/SAFE stays with code (which cells exist, which are breakable with the
 * held tools, which direction actually closes the bearing, which the sensor
 * proved safe). Jev still owns WHICH grounded candidate to take, System2 still
 * owns WHAT the goal is. No portal/M3 branch, no hard-coded coordinate: the only
 * target is the goal's own target cell and the only direction is
 * `sign(target - feet)`.
 */
function digRouteCandidate(
  state: WorldState,
  options: CandidateOptions,
  spec: {
    target: Vec3Json
    targetName: string | null
    reason: string
    extraMeta?: Record<string, string | number | boolean>
  },
  refusals: DigRouteRefusalSink,
): Candidate | null {
  const standKey = cellKey(state.self.position)
  const feet = {
    x: Math.floor(state.self.position.x),
    y: Math.floor(state.self.position.y),
    z: Math.floor(state.self.position.z),
  }
  const decision = planDigRoute({
    selfPosition: state.self.position,
    target: spec.target,
    descent: state.descent,
    // The body's own cell is the only standable cell the sensor knows: a lateral
    // dig here is a shaft exit, which is the difference the marker reports.
    sealed: strandedOnColumn(state),
    // The dig route is a ROUTE like every other: a step whose exact identity
    // already proved zero observable change from this stand cell is withheld (the
    // body must move first), and the ordinary ledger spends it when it fails.
    isSpent: (step) =>
      isZeroProgressRouteRepeat(state.signals.zeroProgressRoutes, {
        kind: 'DESCEND',
        targetKey: cellKey(descentPrimaryCell(step)),
        standKey,
        routeSig: descendStepRouteSignature(step),
        nowMs: state.timestampMs,
      }),
    // The tool gate the candidate builder applies, so a step the body cannot dig
    // is never chosen as the route: the planner then offers the next-best step
    // that still strictly reduces the distance (a detour) instead of refusing the
    // whole arm - the measured pocket is exactly this shape (the best-closing east
    // step is the gate's own obsidian column, needing pickaxe tier 4).
    stepRefusal: (step) => {
      const refusal = stepGateRefusal(state, step)
      return refusal === null ? null : { dir: step.dir, mode: step.mode, ...refusal }
    },
  })
  if (decision.kind === 'refuse') {
    refusals.push(decision.refusal)
    return null
  }
  const route = decision.route
  const built = descendCandidateFromStep(state, options, route.step, {
    focusItem: spec.targetName,
    descendTargetY: null,
    // The step is the sensor's own safe option and it strictly reduces the
    // distance to the goal's target: a grounded route, never a blind search step.
    grounded: true,
    staircase: route.mode === 'down',
    extraMeta: {
      digRoute: true,
      digRouteReason: spec.reason,
      digRouteKind: route.kind,
      digRouteTarget: cellText(spec.target),
      digRouteCell: cellText(route.cell),
      digRouteBlock: route.block ?? 'unknown',
      digRouteFrom: round2Number(route.fromDistance),
      digRouteTo: round2Number(route.toDistance),
      digRouteBearing: route.dir,
      ...(route.detour && route.skipped !== null
        ? {
            digRouteDetour: true,
            digRouteSkipped: `${route.skipped.dir}:${route.skipped.reason}`,
            digRouteSkippedBlock: route.skipped.block ?? 'unknown',
          }
        : {}),
      digRouteLine: formatDigRoute(route, spec.reason, spec.target),
      ...(spec.extraMeta ?? {}),
    },
  })
  if (built === null) {
    refusals.push({
      reason: 'no_tool',
      target: spec.target,
      bearing: digRouteBearing(feet, spec.target),
      cell: route.dig,
      block: route.block,
      detail: `${route.block ?? 'the bearing block'} needs ${route.harvestTool ?? 'a tool'} tier ${route.harvestTier ?? 0}`,
    })
    return null
  }
  // Its OWN id namespace: the collect descent arm can ground the same sensor step
  // for a stone/ore focus, and two candidates with one id in the same offer would
  // make the guard resolve a decision to the wrong meta. The route IDENTITY for
  // the spend ledger is (kind, dig cell, stand cell, route signature) and is
  // deliberately unchanged, so a step spent by either arm is spent for both.
  return {
    ...built.candidate,
    id: `DIG_ROUTE:${route.mode}:${route.dir}:${blockId('b', route.dig)}`,
  }
}

/**
 * The ONE gate a dig step's whole 1x2 profile must pass before it may be a route:
 * #436 U5 (a protected station / a live structure's member is never mined as a route)
 * and the mechanical clearance gate (an unknown/non-diggable profile is refused).
 * Shared by the descent dig route and the wall entry so a step the
 * builder would refuse can never be the route either - the disagreement that arm
 * exists to prevent.
 */
function stepGateRefusal(
  state: WorldState,
  step: DescentOption,
): { reason: 'protected' | 'no_tool'; block: string | null; detail: string } | null {
  const profile = strictStepDigProfile(state, step)
  // #436 U5 (SAFE / protected resources): a step whose profile would break a
  // protected station block or a member of a LIVE structure is never a route,
  // whatever the tool gate says. The measured case is the portal frame's own
  // obsidian: the bearing route into the interior runs THROUGH frame cells, and
  // no route may dismantle the asset the trip is for.
  const protectedRefusal = protectedStepProfileRefusal(state, profile, step.digName ?? null)
  if (protectedRefusal !== null) {
    return { reason: 'protected', ...protectedRefusal }
  }
  if (profile.clearanceChoice.ok) return null
  const requirement = profile.requirement
  return {
    reason: 'no_tool',
    block: requirement?.name ?? step.digName ?? null,
    detail: `cannot prove clearance for ${requirement?.name ?? 'the binding block'} (${profile.clearanceChoice.reason})`,
  }
}

/**
 * The WALL ENTRY family: the tunnel a player opens when the terrain around them is
 * unsurvivable to walk on.
 *
 * MEASURED (live, the operator's flooded Nether arrival at (2.7,59,-2.5) on main
 * a0bc3d6): `MOVE_LEG_STOPPED x4`, `BRIDGE_REFUSED reason=no_verified_landing`,
 * `DIG_ROUTE_REFUSED reason=hazard` x765 - every walk step, the level bridge and the
 * ordinary dig route all refused, each for its own correct reason, and the body
 * pinned. The missing affordance is the one a human uses: mine the SOLID wall beside
 * you, because the pocket you open has a pre-existing rock floor (so there is no fall
 * column to fall into) and no fluid can reach it.
 *
 * `state.ts#buildWallProbes` senses exactly that (the adjacent 1x2 profile, its
 * pre-existing floor and the pocket's six-neighbourhood); `wallEntry.ts#groundWallEntries`
 * is the ONE rule that decides which directions may be opened; this arm turns each
 * grounded direction into an ORDINARY DESCEND candidate through the SAME
 * `descendCandidateFromStep` every other dig step uses.
 *
 * IT IS AN OFFER, NEVER A SUBSTITUTION (#436 section 22): the entry is only
 * enumerated when the ordinary dig route REFUSED (the caller runs this after
 * `digRouteCandidate` returned null) and only from a sensor probe that exists only
 * while a walk step is refused. Nothing is removed, re-aimed or force-selected; when
 * two or more directions ground, every one of them is offered and the section 7 U3
 * boundary is stated with the alternatives, so Jev chooses the direction.
 */
function wallEntryCandidates(
  state: WorldState,
  options: CandidateOptions,
  spec: {
    target: Vec3Json
    targetName: string | null
    reason: string
    extraMeta?: Record<string, string | number | boolean>
  },
  refusals: DigRouteRefusalSink,
): { candidates: Candidate[]; classes: string[] } {
  const walls = state.wallProbes
  if (walls === undefined || walls.length === 0) return { candidates: [], classes: [] }
  const feet = {
    x: Math.floor(state.self.position.x),
    y: Math.floor(state.self.position.y),
    z: Math.floor(state.self.position.z),
  }
  // The arrival rule the dig route itself uses: inside the arrival radius the ordinary
  // walk / vertical approach owns the last block, and a dig there would be tunnelling
  // into the destination. The entry is never consulted at arrival.
  if (distance(feet, spec.target) <= DIG_ROUTE_ARRIVE_DISTANCE) return { candidates: [], classes: [] }
  const standKey = cellKey(state.self.position)
  const liveStructures = liveStructureIndexOf(state)
  const decision = groundWallEntries({
    selfPosition: state.self.position,
    target: spec.target,
    walls,
    minAdvance: DIG_ROUTE_MIN_ADVANCE,
    isProtected: (cell, name) =>
      (name !== null && isProtectedStationBlock(name)) || isLiveStructureMember(liveStructures, cell),
    // The entry's spend identity is the ordinary DESCEND route identity of the very
    // sensor step it executes, so a step that already proved zero observable change
    // from this stand cell is withheld here exactly as it is for the dig route.
    isSpent: (probe) =>
      isZeroProgressRouteRepeat(state.signals.zeroProgressRoutes, {
        kind: 'DESCEND',
        targetKey: cellKey(descentPrimaryCell(probe.step)),
        standKey,
        routeSig: descendStepRouteSignature(probe.step),
        nowMs: state.timestampMs,
      }),
    stepRefusal: (probe) => stepGateRefusal(state, probe.step),
  })
  if (decision.kind === 'refuse') {
    refusals.push(asDigRouteRefusal(decision.refusal, spec.target, feet))
    return { candidates: [], classes: [] }
  }
  const alternatives = decision.routes.map((route) => `${route.dir}:${route.mode}`)
  const out: Candidate[] = []
  for (const route of decision.routes) {
    const built = descendCandidateFromStep(state, options, route.probe.step, {
      focusItem: spec.targetName,
      descendTargetY: null,
      // The step is the sensor's own profile and it strictly reduces the distance to
      // the goal's target: a grounded route, never a blind search step.
      grounded: true,
      staircase: route.mode === 'down',
      extraMeta: {
        digRoute: true,
        digRouteReason: spec.reason,
        digRouteKind: 'tunnel',
        digRouteEntry: true,
        digRouteTarget: cellText(spec.target),
        digRouteCell: cellText(route.cell),
        digRouteBlock: route.block ?? 'unknown',
        digRouteFrom: round2Number(route.fromDistance),
        digRouteTo: round2Number(route.toDistance),
        digRouteBearing: route.dir,
        digRouteEntryMode: route.mode,
        digRouteEntryLevel: route.cell.y,
        digRouteEntryFloor: cellText(route.probe.floor.cell),
        digRouteEntryFloorBlock: route.probe.floor.name ?? 'unknown',
        digRouteEntryEvidence: route.evidence,
        digRouteEntryAlternatives: alternatives.join(','),
        digRouteLine: formatDigRoute(wallEntryStep(route), spec.reason, spec.target),
        digRouteEntryLine: formatWallEntry({
          route,
          target: spec.target,
          reason: spec.reason,
          alternativeCount: alternatives.length,
        }),
        ...(spec.extraMeta ?? {}),
      },
    })
    if (built === null) {
      refusals.push({
        reason: 'no_tool',
        target: spec.target,
        bearing: route.dir,
        cell: route.dig,
        block: route.block,
        detail: `${route.block ?? 'the wall'} cannot be finished with the held tools`,
      })
      continue
    }
    // Its OWN id namespace (`WALL_ENTRY:<mode>:<dir>:<cell>`): a reviewer can tell
    // which arm produced the step, while the SPEND identity stays the shared DESCEND
    // identity of the sensor step, so a spent step is spent for both arms.
    out.push({ ...built.candidate, id: `WALL_ENTRY:${route.mode}:${route.dir}:${blockId('b', route.dig)}` })
  }
  return { candidates: out, classes: out.length === 0 ? [] : ['dig:wall_entry'] }
}

/**
 * THE CONTACT GEOMETRY of one sensed FIGHT target, from facts the candidate layer
 * already owns: the 3-D distance the executor closes on, the vertical component
 * of that gap, and whether the ONE vertical planner (`planVerticalApproachDetailed`,
 * own column - the same call `ascentRouteTo` makes) grounds a route to the
 * target's level.
 *
 * Pure over the world state: no pathfinder, no clock, no mob name. A producer
 * that hovers four blocks above the walkway and a skeleton on a ledge four blocks
 * up are the SAME case here, because the mechanical fact is the gap, not the mob.
 */
function contactGeometryFor(
  state: WorldState,
  entity: { position: Vec3Json; distance: number },
): {
  approach: ContactApproach
  gapY: number
  distance: number
  placeable: string | null
  ascentRefusal: UpwardRefusalReason | null
  /** the level the planner was asked for, so the caller cannot disagree with it */
  targetY: number
} {
  const bodyLevel = Math.floor(state.self.position.y)
  const targetY = Math.floor(entity.position.y)
  const gapY = contactGapY(bodyLevel, targetY)
  const placeable = selectPlaceableBlock(state.inventory.counts)
  const decision = planVerticalApproachDetailed(
    verticalInputFor(state, {
      x: Math.floor(state.self.position.x),
      y: targetY,
      z: Math.floor(state.self.position.z),
    }),
  )
  const ascentRefusal = decision.plan === null ? (decision.ascentRefusal?.reason ?? null) : null
  return {
    approach: classifyContactApproach({
      distance: entity.distance,
      meleeReach: MELEE_THREAT_REACH,
      gapY,
      // A walk cannot change the body's LEVEL, but the body's own height already
      // spans the first `MELEE_REACH_UP` of an upward gap, so the largest vertical
      // component a walk-only close can still express is the melee envelope PLUS
      // that height (`meleeWalkGap`). The old `walkGap = meleeReach` form declared
      // the measured 4-block blaze gap (`HUNT_CONTACT_UNREACHABLE
      // actionId=ATTACK:e85793 gap_y=4 horizontal=1.70`) ascent-required when the
      // body's own upper half is 2.93 m from the target - inside the envelope.
      // Whole-block verdicts with the tree's constants: 4 = walk, 5 = ascent.
      walkGap: meleeWalkGap(MELEE_THREAT_REACH),
      ascentRefused: ascentRefusal !== null,
    }),
    gapY,
    distance: entity.distance,
    placeable: placeable === null ? null : placeable.name,
    ascentRefusal,
    targetY,
  }
}

export interface ContactApproachResult {
  candidates: Candidate[]
  refusals: ContactRefusal[]
}

/**
 * The REPOSITION remedy for a fight whose target sits above the walk envelope.
 *
 * MEASURED (21 blaze hunts, every one `HUNT_END ... reason=out_of_range swings=0
 * hits=0`, `blaze_rod 0` in every inventory sample): the hunt gate bounded the
 * approach with `HUNT_APPROACH_BUDGET` - a WALKING budget - against the raw 3-D
 * distance. A producer hovering above the fortress walkway over a lava basin is
 * therefore "inside the budget" while no walk can ever close its vertical
 * component, so the lease ran to its deadline without a swing.
 *
 * The remedy is NOT new machinery and NOT an attack: it is the SAME own-column
 * vertical route every other ascent uses (`ascentRouteTo` -> reuse a remembered
 * tunnel / cut an up-staircase / pillar with a held block), offered as an
 * ordinary MOVE-family candidate alongside everything else. Code enumerates CAN
 * (is there a grounded route to that level?); Jev owns WHICH.
 *
 * ONE OFFER PER TARGET LEVEL, not one per entity: every grounded route to the
 * same level begins with the same mechanical step, so N copies would put N
 * identical actions in front of Jev and bias the choice - the same reasoning
 * `levelScanCandidates` records. The motivating entity is named in the meta.
 *
 * When the planner grounds NOTHING the arm offers no candidate and returns a
 * typed `ContactRefusal` instead of silence: the caller withholds the ATTACK by
 * CAN so the target is never leased as a 0-swing attempt that looks like one.
 */
function contactApproachCandidates(
  state: WorldState,
  options: CandidateOptions,
  targets: readonly { id: number; name: string; position: Vec3Json; distance: number }[],
): ContactApproachResult {
  const candidates: Candidate[] = []
  const refusals: ContactRefusal[] = []
  const offeredLevels = new Set<number>()
  const refusedLevels = new Set<number>()
  const feet = {
    x: Math.floor(state.self.position.x),
    y: Math.floor(state.self.position.y),
    z: Math.floor(state.self.position.z),
  }
  for (const entity of targets) {
    const geometry = contactGeometryFor(state, entity)
    if (geometry.approach !== 'ascent_required' && geometry.approach !== 'no_grounded_remedy') continue
    const base: ContactRefusal = {
      reason: geometry.ascentRefusal ?? 'no_placeable',
      goalId: `contact:e${entity.id}`,
      fromY: feet.y,
      toY: geometry.targetY,
      cell: feet,
      entityId: entity.id,
      targetName: entity.name,
      gapY: geometry.gapY,
      distance: geometry.distance,
      approach: geometry.approach,
      placeable: geometry.placeable,
    }
    if (geometry.approach === 'no_grounded_remedy') {
      if (refusedLevels.has(geometry.targetY)) continue
      refusedLevels.add(geometry.targetY)
      refusals.push(base)
      continue
    }
    if (offeredLevels.has(geometry.targetY)) continue
    const ascent = ascentRouteTo(state, options, {
      targetY: geometry.targetY,
      goalId: base.goalId,
      idPrefix: 'ASCEND:contact:',
      label: `ascend to ${entity.name}'s level for melee contact`,
      extraMeta: {
        contactAscent: true,
        contactEntityId: entity.id,
        contactTargetName: entity.name,
        contactGapY: geometry.gapY,
        contactApproach: geometry.approach,
      },
    })
    if (ascent.candidates.length === 0) {
      // The planner agreed there is no route after all: the refusal is the fact,
      // never a silent empty arm.
      if (refusedLevels.has(geometry.targetY)) continue
      refusedLevels.add(geometry.targetY)
      refusals.push({ ...base, reason: ascent.refusal?.reason ?? base.reason })
      continue
    }
    offeredLevels.add(geometry.targetY)
    candidates.push(...ascent.candidates)
  }
  return { candidates, refusals }
}

/**
 * The VERTICAL remedy for a locomotion target that sits ABOVE the body and has no
 * walkable route.
 *
 * MEASURED (live, overworld, `JEV_CANDIDATE_SET offered=9` IDENTICAL tick after tick
 * at (28.5,61,6.5)): the body sat on the floor of a ~6-block shaft whose only wall was
 * x=27 while the Nether gate stood at y67. The offer held `SKILL_STEP:step_up:p29_62_6`
 * and six surface MOVEs at y67-68 - none of which can lift a body out of a pit - and
 * the only vertical candidate in the whole log was `ASCEND:habitat:p28_62_6`, whose two
 * owners are goal-kind-keyed: `surfaceAscentCandidates` (candidates.ts:4173) returns
 * nothing unless the active goal kind is `surface`, and `foodHabitatAscent` refuses at
 * or above `ANIMAL_HABITAT_SEA_LEVEL` (candidates.ts:4243) because it answers the food
 * goal. A `place:nether_portal` goal whose target is six blocks up therefore had NO
 * vertical remedy at all, while the machinery that could produce one already exists.
 *
 * The rule here is the GEOMETRY of the locomotion target, never a goal kind or a place:
 * the committed target is more than `VERTICAL_GAP` above the body, the ordinary walk
 * cannot express the route, and the ONE vertical planner every ascent already uses
 * (`planVerticalApproachDetailed` through `ascentRouteTo`: reuse a remembered tunnel,
 * cut an up-staircase, or pillar with a held placeable block) grounds a plan to that
 * level. The existing `surface`/`habitat` arms are untouched - they keep their own
 * refusals, which record their own measured incidents.
 */
function verticalRemedyCandidates(
  state: WorldState,
  options: CandidateOptions,
  spec: { target: Vec3Json; reason: string; skill: string },
): { candidates: Candidate[]; classes: string[] } {
  const dy = spec.target.y - state.self.position.y
  if (!(dy > VERTICAL_GAP)) return { candidates: [], classes: [] }
  const targetY = Math.floor(spec.target.y)
  const feet = {
    x: Math.floor(state.self.position.x),
    y: Math.floor(state.self.position.y),
    z: Math.floor(state.self.position.z),
  }
  const ascent = ascentRouteTo(state, options, {
    targetY,
    goalId: spec.skill,
    idPrefix: 'ASCEND:target:',
    label: `ascend toward the ${spec.reason} target`,
    extraMeta: {
      ascentForLocomotionTarget: `${spec.target.x},${spec.target.y},${spec.target.z}`,
      ascentReason: spec.reason,
      ascentFromY: feet.y,
    },
  })
  if (ascent.candidates.length === 0) return { candidates: [], classes: [] }
  return { candidates: ascent.candidates, classes: ['ascent:vertical'] }
}

/**
 * THE DOWNWARD SELF-LANDING remedy for a locomotion target BELOW the body: the
 * exact mirror of the bridge (`groundBridgeLeg`), one level down.
 *
 * MEASURED (main 974e954, the operator's floated-portal trial; body 23.5,79.0,1.5,
 * portal interior 26,67,9):
 *
 *   CANDIDATE_ACQUISITION candidate=MOVE:b26_74_-14 kind=MOVE reachable=false
 *     reason=needs_descend missing=["descend_plan:no_support@25,78,-2:air"]
 *   counts in this run: needs_descend 1912 | column_descent 4006
 *
 * The typed fact was right and the ANSWER did not exist: the descent vocabulary's
 * only two remedies are DIGS (cut a staircase step, dig the body's own column), so
 * a landing whose support is air could only be refused - 1912 times - although the
 * body held blocks it could have laid. The missing mechanic is the bridge's own
 * `self_landing` scaffold rotated: lay the floor of the cell below, drop onto it.
 *
 * WHAT BOUNDS IT (nothing here is an unbounded project):
 *   * the SAME one-block-per-leg discipline: the rule grounds exactly one cell and
 *     the executor's budget is 1 by construction (`descentScaffold.ts`, `span` 1);
 *   * STRICT VERTICAL REDUCTION the SAME way the horizontal scaffold strictly
 *     reduces horizontal distance: the landing must not step past the target level,
 *     and it is one block below the body by construction, so every leg closes
 *     exactly one of the gap and the loop stops at the target level;
 *   * the SAME per-cell pocket rule the wall entry / level scan / bridge use
 *     (`wallEntry.ts#wallPocketOccupationRefusal` + `#wallPocketFloodRefusal`, via
 *     `bridgeRoute.ts#scaffoldPocketRefusal`): hazard, protected, dimension-transfer
 *     plane, unobserved and would_flood are all refused in the shared vocabulary;
 *   * the portal plane is never mined at all - this route never digs.
 *
 * OFFERED ALONGSIDE, NEVER INSTEAD: the caller enumerates it as one more grounded
 * remedy class beside the walk / dig / ascend routes and stops at the policy
 * boundary when more than one is grounded. A route the ordinary walk can already
 * express grounds nothing here (`walkable`), so the walkable control is untouched.
 */
function groundDescentScaffoldLeg(
  state: WorldState,
  spec: { target: Vec3Json; walkable: boolean },
): { plan: DescentScaffoldPlan | null; refusal: DescentScaffoldRefusal | null; line: string | null } {
  // Only a target genuinely BELOW the body asks the descent question, and only a
  // leg the ordinary walk cannot already express. A walkable leg grounds nothing.
  if (spec.walkable) return { plan: null, refusal: null, line: null }
  const feet = {
    x: Math.floor(state.self.position.x),
    y: Math.floor(state.self.position.y),
    z: Math.floor(state.self.position.z),
  }
  if (!(spec.target.y < feet.y)) return { plan: null, refusal: null, line: null }
  const probe = state.descentScaffold ?? null
  const placeable = selectPlaceableBlock(state.inventory.counts)
  const decision = planDescentScaffoldStep({
    probe,
    blockName: placeable?.name ?? null,
    blockCount: placeable?.count ?? 0,
    targetY: Math.floor(spec.target.y),
    target: spec.target,
    isProtected: protectedResourceTest(state),
  })
  if (decision.kind === 'step') return { plan: decision.plan, refusal: null, line: null }
  if (decision.kind === 'not_a_gap') return { plan: null, refusal: null, line: null }
  return { plan: null, refusal: decision.refusal, line: formatDescentScaffoldRefused(decision.refusal) }
}

/**
 * The offered DESCEND: the downward self-landing leg. It DECLARES the one block it
 * consumes and the one cell it places into (`descentScaffold.ts` meta keys), which
 * is what the `EffectEnvelope` derives `mayPlaceGroundedRoute` + `mayPlaceBlocks`
 * from and what `routePlaceDeclaration.ts` authorizes the EQUIP with - the mirror
 * of the bridge MOVE's own declaration.
 */
function descentScaffoldCandidate(
  state: WorldState,
  options: CandidateOptions,
  spec: { target: Vec3Json; targetName: string | null; reason: string; skill: string | null },
  plan: DescentScaffoldPlan,
  authority: string,
  reflex: string | null,
  boundary: string | null,
): Candidate {
  const gap = plan.fromGap === null || plan.toGap === null ? 'gap=none' : `gap=${plan.fromGap}->${plan.toGap}`
  return {
    id: `DESCEND:place:D:${blockId('b', plan.place)}`,
    kind: 'DESCEND',
    label:
      `descend by placing ${plan.block} at (${cellText(plan.place)}) against the footing's underside and dropping onto the floor it ` +
      `makes at (${cellText(plan.landing)}), toward (${cellText(spec.target)})`,
    targetName: spec.targetName,
    // The primary cell is the cell this leg PLACES into, exactly as a dig step's
    // primary is the cell it removes: the leg's target is the cell it changes.
    target: plan.place,
    targetEntityId: null,
    // The effect lives in meta (`mayPlaceBlocks` + the consumed block), never in
    // `itemName`: a DESCEND is not a PLACE, and the item bookkeeping paths must not
    // read a descent as "a route for cobblestone".
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: distance(plan.place, state.self.eyePosition) <= options.reach,
    // The landing is a 1x2 pocket the step itself creates the floor of, exactly
    // like a pillar apex that is air until the executor places the column.
    hasStandableAdjacent: true,
    meta: {
      tick: state.tick,
      x: plan.place.x,
      y: plan.place.y,
      z: plan.place.z,
      [DESCEND_SCAFFOLD_FROM_META]: cellText(plan.from),
      [DESCEND_SCAFFOLD_LANDING_META]: cellText(plan.landing),
      [DESCEND_SCAFFOLD_PLACE_META]: cellText(plan.place),
      [DESCEND_SCAFFOLD_BLOCK_META]: plan.block,
      [DESCEND_SCAFFOLD_REFERENCE_META]: cellText(plan.reference),
      [DESCEND_SCAFFOLD_POCKET_META]: plan.pocketEvidence,
      [DESCEND_SCAFFOLD_GAP_META]: gap,
      [BRIDGE_AUTHORITY_META]: authority,
      ...(spec.skill === null ? {} : { legContinuationSkill: spec.skill }),
      approachLeg: spec.reason,
      approachTarget: `${spec.target.x},${spec.target.y},${spec.target.z}`,
      ...(reflex === null ? {} : { legReflex: reflex }),
      ...(boundary === null ? {} : { legPolicyBoundary: boundary }),
    },
  }
}

/**
 * #436 section 7 uniqueness proof for a downward scaffold that is the ONLY grounded
 * remedy: the exact geometry (landing / placement cell / the block below it) plus
 * the strict vertical-reduction claim, in the ONE `REFLEX` vocabulary
 * `netherPortalPlan.ts` owns.
 */
function formatDescentScaffoldReflex(skill: string, plan: DescentScaffoldPlan): string {
  return formatReflex({
    ownerSkill: skill,
    action: 'descent_scaffold',
    evidence:
      `gap@${cellText(plan.landing)}:no_support;place@${cellText(plan.place)}:${plan.block};` +
      `landing@${cellText(plan.landing)}:placed;from@${cellText(plan.from)};` +
      `gap=${plan.fromGap ?? 'none'}->${plan.toGap ?? 'none'}`,
  })
}

/**
 * The DESCEND remedy offer for one locomotion leg target below the body. Returns
 * the candidate plus its declared authority line; `plan === null` NEVER becomes a
 * candidate, so an ungrounded descent can never surface as an executable action.
 */
function descentRemedyCandidates(
  state: WorldState,
  options: CandidateOptions,
  spec: { target: Vec3Json; targetName: string | null; reason: string; skill: string | null; walkable: boolean },
): {
  candidates: Candidate[]
  classes: string[]
  refusal: DescentScaffoldRefusal | null
  refusalLine: string | null
} {
  const grounded = groundDescentScaffoldLeg(state, spec)
  if (grounded.plan === null) {
    return { candidates: [], classes: [], refusal: grounded.refusal, refusalLine: grounded.line }
  }
  const plan = grounded.plan
  const authority = formatSkillStepAuthority(
    'MECHANICAL_CONTINUATION',
    `cell=${cellText(plan.place)} landing=${cellText(plan.landing)} from=${cellText(plan.from)} ` +
      `block=${plan.block} self_landing_down=true probe=bounded(1)`,
    'place_blocks=1',
    { budget: 1 },
  )
  return {
    candidates: [
      descentScaffoldCandidate(
        state,
        options,
        spec,
        plan,
        authority,
        formatDescentScaffoldReflex(spec.skill ?? 'descend', plan),
        null,
      ),
    ],
    classes: ['place:descent_scaffold'],
    refusal: null,
    refusalLine: null,
  }
}

/**
 * The descent scaffold for a `descend_to:Y=<n>` PREDICATE row, where there is no
 * locomotion target - only a level to reach. The same rule, the same candidate
 * contract, the same executor leg; only the leg's declared aim differs (a LEVEL
 * instead of a target cell), so a predicate descent and a target-below leg can
 * never ground two different mechanics.
 */
function descentScaffoldForLevel(
  state: WorldState,
  options: CandidateOptions,
  spec: { targetY: number; goalId: string | null; label: string },
): { candidate: Candidate | null; refusal: DescentScaffoldRefusal | null } {
  const feet = {
    x: Math.floor(state.self.position.x),
    y: Math.floor(state.self.position.y),
    z: Math.floor(state.self.position.z),
  }
  if (!(feet.y > spec.targetY)) return { candidate: null, refusal: null }
  const probe = state.descentScaffold ?? null
  const placeable = selectPlaceableBlock(state.inventory.counts)
  const decision = planDescentScaffoldStep({
    probe,
    blockName: placeable?.name ?? null,
    blockCount: placeable?.count ?? 0,
    targetY: spec.targetY,
    target: null,
    isProtected: protectedResourceTest(state),
  })
  if (decision.kind !== 'step') {
    return { candidate: null, refusal: decision.kind === 'refuse' ? decision.refusal : null }
  }
  const plan = decision.plan
  const authority = formatSkillStepAuthority(
    'MECHANICAL_CONTINUATION',
    `cell=${cellText(plan.place)} landing=${cellText(plan.landing)} from=${cellText(plan.from)} ` +
      `block=${plan.block} self_landing_down=true probe=bounded(1)`,
    'place_blocks=1',
    { budget: 1 },
  )
  const built = descentScaffoldCandidate(
    state,
    options,
    { target: plan.landing, targetName: null, reason: 'predicate_descend', skill: spec.goalId },
    plan,
    authority,
    formatDescentScaffoldReflex(spec.goalId ?? 'descend', plan),
    null,
  )
  return {
    candidate: {
      ...built,
      id: `DESCEND:place:D:${blockId('b', plan.place)}`,
      label: `${spec.label}: ${built.label}`,
    },
    refusal: null,
  }
}

/**
 * The BOUNDED LEVEL SCAN offer: the own-column descent that starts a composed route whose
 * TERMINUS (a lateral dig or walk at a level below) strictly reduces the distance to the
 * target.
 *
 * MEASURED (live, the operator's flooded Nether arrival, run-muchajde-1qhat): at
 * (2.7,59,-2.5) every step at the body's OWN level is refused or useless - the portal plane
 * east is `portal_plane`, the frame is `protected`, the rest is already open air - while the
 * rock below is solid and a dry tunnel east exists two levels down. `digRoute.ts` correctly
 * refuses (`DIG_ROUTE_REFUSED reason=no_grounded_route ... ledger: E=no_wall Ev=protected`)
 * because a pure descent does not reduce the 3-D distance, and `wallEntryCandidates` judges
 * only the body's own adjacent cells. This arm is the missing third case: a descent that is
 * the FIRST STEP OF A ROUTE THAT ENDS CLOSER, never a descent on its own.
 *
 * The rule is `levelScan.ts#groundLevelScan` (the sensor's per-level probes through the SAME
 * per-cell pocket rule the wall entry uses); this arm turns each grounded route into the ONE
 * mechanical action it starts with - the own-column dig at the body's current level, built
 * through the SAME `descendCandidateFromStep`, executed by the SAME `runDescend`, guarded by
 * the SAME `guardDescend` - and carries the level, the continuation cell/material, the
 * per-level flood verdict and the distance change as evidence.
 *
 * WHY ONE CANDIDATE AND NOT ONE PER ROUTE: every grounded route begins with the same
 * mechanical step (dig the own-column floor), so offering N copies would put N identical
 * actions in front of Jev and bias the choice - exactly the ranking/substitution the
 * authority rules forbid. The alternatives are therefore ENUMERATED in the evidence
 * (`levelScanAlternatives` + the section 7 U3 boundary when more than one grounded) and code
 * chooses neither a level nor a direction; the direction becomes a real choice when the body
 * reaches the level, where the ordinary dig route / wall entry enumerates it.
 *
 * IT IS AN OFFER, NEVER A SUBSTITUTION: enumerated only when the ordinary dig route AND the
 * adjacent wall entry both refused, and only from a sensor probe that exists only while a
 * step is refused by the body's own local geology.
 */
function levelScanCandidates(
  state: WorldState,
  options: CandidateOptions,
  spec: { target: Vec3Json; targetName: string | null; reason: string; skill: string | null; extraMeta?: Record<string, string | number | boolean> },
  refusals: DigRouteRefusalSink,
): { candidates: Candidate[]; classes: string[]; boundary: string | null } {
  const probes = state.levelScan
  if (probes === undefined || probes.length === 0) return { candidates: [], classes: [], boundary: null }
  const feet = {
    x: Math.floor(state.self.position.x),
    y: Math.floor(state.self.position.y),
    z: Math.floor(state.self.position.z),
  }
  // The arrival rule the dig route and the wall entry use: inside the arrival radius the
  // ordinary walk / vertical approach owns the last block.
  if (distance(feet, spec.target) <= DIG_ROUTE_ARRIVE_DISTANCE) return { candidates: [], classes: [], boundary: null }
  const standKey = cellKey(state.self.position)
  const liveStructures = liveStructureIndexOf(state)
  const decision = groundLevelScan({
    selfPosition: state.self.position,
    target: spec.target,
    levels: probes,
    minAdvance: DIG_ROUTE_MIN_ADVANCE,
    isProtected: (cell, name) =>
      (name !== null && isProtectedStationBlock(name)) || isLiveStructureMember(liveStructures, cell),
  })
  if (decision.kind === 'refuse') {
    refusals.push({
      reason: asDigRouteRefusalReason(decision.refusal.reason),
      target: spec.target,
      bearing: digRouteBearing(feet, spec.target),
      cell: decision.refusal.cell,
      block: decision.refusal.block,
      detail: decision.refusal.detail,
    })
    return { candidates: [], classes: [], boundary: null }
  }
  // The descent is executed by the SENSOR's own own-column step, so the guard's re-read
  // (`state.descent` + the depth-1 shaft probe) and this offer cannot disagree.
  const shaft = (state.descent ?? []).find((step) => step.dir === 'D' && step.mode === 'down')
  if (shaft === undefined) {
    refusals.push({
      reason: 'no_grounded_route',
      target: spec.target,
      bearing: digRouteBearing(feet, spec.target),
      cell: null,
      block: null,
      detail: 'the sensor carries no own-column descent step, so the scanned descent cannot be executed',
    })
    return { candidates: [], classes: [], boundary: null }
  }
  // The SAME step gate the dig route and the wall entry use (#436 U5 protection + the strict
  // tool gate): a shaft that would break a protected block or that the held tools cannot
  // finish is refused with its own typed reason, never offered and then re-aimed forever.
  const gate = stepGateRefusal(state, shaft)
  if (gate !== null) {
    refusals.push({
      reason: gate.reason,
      target: spec.target,
      bearing: 'D',
      cell: descentPrimaryCell(shaft),
      block: gate.block,
      detail: gate.detail,
    })
    return { candidates: [], classes: [], boundary: null }
  }
  // The ordinary zero-progress DESCEND identity: a descent that already proved zero
  // observable change from this stand cell is withheld (the body must move first).
  if (
    isZeroProgressRouteRepeat(state.signals.zeroProgressRoutes, {
      kind: 'DESCEND',
      targetKey: cellKey(descentPrimaryCell(shaft)),
      standKey,
      routeSig: descendStepRouteSignature(shaft),
      nowMs: state.timestampMs,
    })
  ) {
    refusals.push({
      reason: 'spent',
      target: spec.target,
      bearing: 'D',
      cell: descentPrimaryCell(shaft),
      block: shaft.digName ?? null,
      detail: 'this descent already proved zero observable change from this stand cell',
    })
    return { candidates: [], classes: [], boundary: null }
  }
  const alternatives = decision.routes.map((route) => `${route.level}:${route.dir}:${route.walk ? 'walk' : 'dig'}`)
  const best = decision.routes[0]
  if (best === undefined) return { candidates: [], classes: [], boundary: null }
  const built = descendCandidateFromStep(state, options, shaft, {
    focusItem: spec.targetName,
    descendTargetY: null,
    // The step is the sensor's own controlled own-column dig and the route it starts ends
    // strictly closer to the goal's target: a grounded route, never a blind search step.
    grounded: true,
    staircase: false,
    extraMeta: {
      // The step DUGS its own column, so the commitment's EffectEnvelope must grant the dig:
      // the envelope derives `mayDigGroundedRoute` from this flag (skillCommitment.ts,
      // DESCEND/MOVE/STEP/RETRIEVE/RETREAT), and without it the step's own dig is refused
      // `dig_cell_not_declared` and the route dies at its first move. Measured live before this
      // line existed: DESCEND:level:E:b6_54_10 -> SKILL_ENVELOPE_VIOLATION effect=dig 6,55,10
      // violation=dig_cell_not_declared:6,55,10, 40 times in ten minutes. The ordinary dig route
      // declares exactly this (candidates.ts, digRouteCandidate), which is why it does not hit it.
      digRoute: true,
      digRouteReason: spec.reason,
      digRouteKind: 'level_scan',
      levelScan: true,
      levelScanReason: spec.reason,
      levelScanTarget: cellText(spec.target),
      levelScanLevel: best.level,
      levelScanDepth: best.depth,
      levelScanLength: best.length,
      levelScanDir: best.dir,
      levelScanVia: best.walk ? 'walk' : 'dig',
      levelScanCell: cellText(best.cell),
      levelScanBlock: best.block ?? 'unknown',
      levelScanFloor: cellText(best.floor),
      levelScanFloorBlock: best.floorBlock ?? 'unknown',
      levelScanFrom: round2Number(best.fromDistance),
      levelScanTo: round2Number(best.toDistance),
      levelScanLevelFrom: round2Number(best.levelFromDistance),
      levelScanLevelTo: round2Number(best.levelToDistance),
      levelScanAlternatives: alternatives.join(','),
      levelScanEvidence: best.evidence,
      levelScanLine: formatLevelScan({
        route: best,
        target: spec.target,
        reason: spec.reason,
        alternativeCount: alternatives.length,
      }),
      ...(spec.extraMeta ?? {}),
    },
  })
  if (built === null) {
    refusals.push({
      reason: 'no_tool',
      target: spec.target,
      bearing: 'D',
      cell: descentPrimaryCell(shaft),
      block: shaft.digName ?? null,
      detail: `${shaft.digName ?? 'the own-column floor'} cannot be finished with the held tools`,
    })
    return { candidates: [], classes: [], boundary: null }
  }
  // Its OWN id namespace (`LEVEL_SCAN:down:D:<cell>`): a reviewer can tell which arm produced
  // the step, while the SPEND identity stays the ordinary DESCEND identity of the sensor step.
  const candidate: Candidate = {
    ...built.candidate,
    id: `LEVEL_SCAN:down:D:${blockId('b', descentPrimaryCell(shaft))}`,
  }
  // §7 (U3): several grounded (level, direction) routes are several PLANS whose first
  // mechanical step is the same action. Code chooses neither the level nor the direction, and
  // the boundary says so with every alternative named.
  const boundary =
    alternatives.length > 1
      ? formatSkillPolicyBoundary({
          skill: spec.skill ?? 'LEVEL_SCAN',
          reason: 'multiple_grounded_level_routes',
          alternatives: alternatives.map((alternative) => `dig:level_scan:${alternative}`),
        })
      : null
  if (boundary !== null) candidate.meta.legPolicyBoundary = boundary
  // §7 layering for the descent: a UNIQUE grounded route (this is the only remedy and the only
  // plan) is a prerequisite code may finish; several means the step only realizes the route the
  // plans agree on, and the descent still belongs to Jev's choice of plan.
  const unique = alternatives.length === 1
  candidate.meta.levelScanAuthorityLine = formatSkillStep(
    spec.skill ?? 'LEVEL_SCAN',
    'level_scan',
    formatSkillStepAuthority(
      unique ? 'MANDATORY_PREREQUISITE' : 'MECHANICAL_CONTINUATION',
      `target=${cellText(spec.target)} level=${best.level} depth=${best.depth} dir=${best.dir} ` +
        `via=${best.walk ? 'walk' : 'dig'} cell=${cellText(best.cell)} block=${best.block ?? 'unknown'} ` +
        `floor=${cellText(best.floor)}:${best.floorBlock ?? 'unknown'} ` +
        `d=${round2Number(best.fromDistance)}->${round2Number(best.toDistance)} alternatives=${alternatives.length}`,
      'dig_blocks=1',
      { budget: 1 },
    ),
  )
  if (unique) {
    candidate.meta.legReflex = formatReflex({
      ownerSkill: spec.skill ?? 'LEVEL_SCAN',
      action: 'level_scan',
      evidence:
        `no_grounded_level_progress;level=${best.level};depth=${best.depth};` +
        `shaft@${cellText(best.firstStep)}:${best.firstStepBlock ?? 'unknown'};` +
        `cell@${cellText(best.cell)}:${best.block ?? 'unknown'};` +
        `d=${round2Number(best.fromDistance)}->${round2Number(best.toDistance)}`,
    })
  }
  return { candidates: [candidate], classes: ['dig:level_scan'], boundary }
}

/** The dig-route vocabulary a level-scan refusal maps into (the sink is shared). */
function asDigRouteRefusalReason(reason: LevelScanRefusalReason): DigRouteRefusalReason {
  switch (reason) {
    case 'no_progress':
    case 'chain_broken':
      return 'no_grounded_route'
    default:
      return reason
  }
}

/** The `DigRouteStep` an entry route is, for the shared `DIG_ROUTE` line. */
function wallEntryStep(route: WallEntryRoute): DigRouteStep {
  return {
    kind: 'tunnel',
    dir: route.dir,
    mode: route.mode,
    cell: route.cell,
    dig: route.dig,
    block: route.block,
    harvestTool: route.probe.step.digHarvestTool ?? null,
    harvestTier: route.probe.step.digHarvestTier ?? null,
    digCells: descentDigPlan(route.probe.step).map((entry) => entry.cell),
    fromDistance: route.fromDistance,
    toDistance: route.toDistance,
    step: route.probe.step,
    detour: false,
    skipped: null,
    entry: true,
    entryEvidence: route.evidence,
  }
}

/** The wall-entry refusal in the dig route's own typed vocabulary. */
function asDigRouteRefusal(refusal: WallEntryRefusal, target: Vec3Json, feet: Vec3Json): DigRouteRefusal {
  return {
    reason: refusal.reason,
    target,
    bearing: digRouteBearing(feet, target),
    cell: refusal.cell,
    block: refusal.block,
    detail: refusal.detail,
  }
}

/**
 * The grounded travel/approach legs for a locomotion target whose own route just
 * proved spent from this body cell.
 *
 * The postcondition proved the previous attempt changed nothing (or failed at
 * its path stage); the mechanical fact behind it is usually "the path from HERE
 * is blocked" (live: `PATH_CALLBACK ... outcome=noPath|stuck` 17-18m from the
 * remembered ore, and the same shape 16m/13-bricks from a lit gate). The
 * grounded way to make the target reachable again is to change the STAND CELL,
 * so this offers the nearest standable cell that measurably reduces the distance
 * to the target - a real MOVE the ordinary guard and reachability gate still
 * own. It is an offer, never a replacement: Jev decides whether to walk it, and
 * the route is re-offered the moment the body stands somewhere new.
 *
 * When the sensor knows NO standable cell that improves the distance (the
 * measured sealed shaft), or when the only such cell is itself unreachable, the
 * body's own cell is the whole world the walk arms can see. The terrain is then
 * the only thing that can change, so the bounded dig route toward the same target
 * is grounded alongside the walk leg (`digRouteCandidate`). Both are offers; when
 * neither can be grounded the caller keeps its existing typed escalation.
 */
/**
 * One bounded, mechanically-determined continuation for a travel waypoint that no
 * sensed standable cell can WALK to.
 *
 * MEASURED LIVE (run-mucbyro1-1hqhm, the M3 pocket, world truth read with
 * `tools/world-truth-plane.mjs` on chunk (1,0) y63-69):
 *
 *   body (24,67,9) feet y=67 on cobblestone; E (25,67,9) = the gate's own
 *   obsidian column; S (24,67,10) = air with (24,66,10) air and (24,65,10) grass
 *   below; the waypoint (26,67,10) is standable over the dirt at (25,66,10).
 *
 *   `MOVE:p26_67_10` -> `PATH_CALLBACK phase=failed outcome=stuck` x8 ->
 *   `MOVE_FAILMEM ... reason=stuck` with an EMPTY contract (no `vertical`, no dig
 *   profile): `runMove` (executor.ts:1921) runs the vertical contract first, finds
 *   nothing, and then `pathTo(target, 'GoalBlock')` cannot express the only
 *   mechanical route, which a walk-only BFS over the same grid proves is 4 moves
 *   and needs NO dig and NO placement:
 *
 *     (24,67,9) --1-block drop S--> (24,66,10) --1-block step UP E onto the
 *     verified ledge (25,66,10)--> (25,67,10) --2 level walks--> (26,67,9)
 *
 * So the missing piece is not a dig (a dig cannot create a floor) and not a
 * placement (none is required): it is the ordinary 1-block STEP-UP onto a sensed
 * ledge, which the stock MOVE contract cannot express from a cell that is itself
 * one block below the ledge's standing level.
 *
 * The continuation is derived ONLY from the sensor's own facts: the pre-computed
 * descent options (`state.descent`, `state.ts#buildDescent`) carry the controlled
 * 1-block drop (`open_floor` + `supportSolid` + no hazard + no wall in the way),
 * and `terrain.standable` (the same `isUsableStand` rule every walk arm uses)
 * verifies BOTH the hole floor the body drops into and the ledge top it steps
 * onto. `ledge` is the landing's own support cell - the block the body climbs.
 */
interface PocketContinuation {
  action: 'step_over' | 'step_up'
  /** the verified standable cell the body drops into first (null for a direct step-up) */
  via: Vec3Json | null
  /** the verified standable cell the body ends on (the ledge top) */
  landing: Vec3Json
  /** the block the body climbs onto: the landing's support cell */
  ledge: Vec3Json
  /** the horizontal face the body steps up through (never the own column) */
  dir: 'E' | 'W' | 'N' | 'S'
  /** the continuation's own distance to the leg target (strictly closer than the body's) */
  toTarget: number
}

/** At most this many alternative continuations are enumerated (Jev still chooses). */
const POCKET_CONTINUATION_CAP = 2

function pocketContinuations(
  state: WorldState,
  target: Vec3Json,
): PocketContinuation[] {
  const feet = {
    x: Math.floor(state.self.position.x),
    y: Math.floor(state.self.position.y),
    z: Math.floor(state.self.position.z),
  }
  const currentDistance = distance(feet, target)
  const standable = new Set(state.terrain.standable.map((cell) => cellKey(cell)))
  const out: PocketContinuation[] = []
  const seen = new Set<string>()
  const push = (entry: PocketContinuation): void => {
    const landingKey = cellKey(entry.landing)
    if (seen.has(landingKey)) return
    seen.add(landingKey)
    out.push(entry)
  }
  const descent = state.descent ?? []
  for (const level of descent) {
    if (level.dx === 0 && level.dz === 0) continue
    // (a) A DIRECT 1-block step-up: the front cell at feet level is the ledge
    //     block (`wallSolid`), nothing stands above it (`headSolid` false), and
    //     the cell above the ledge is a verified stand.
    const upCell = { x: feet.x + level.dx, y: feet.y + 1, z: feet.z + level.dz }
    if (level.wallSolid === true && level.headSolid === false && standable.has(cellKey(upCell))) {
      const d = distance(upCell, target)
      if (d <= currentDistance - DIG_ROUTE_MIN_ADVANCE) {
        push({
          action: 'step_up',
          via: null,
          landing: upCell,
          ledge: level.wall,
          // A horizontal option's direction is one of the four faces (`dx`/`dz`
          // are non-zero by the guard above), never the own column.
          dir: level.dir as PocketContinuation['dir'],
          toTarget: d,
        })
      }
    }
    // (b) A STEP OVER a verified 1-block drop: the sensor's own controlled-drop
    //     geometry, the hole floor is a verified stand, and from it a cardinal
    //     1-block step-up lands on a verified stand that closes the distance.
    const down = descent.find((step) => step.dir === level.dir && step.mode === 'down')
    if (down === undefined) continue
    if (
      down.refusal !== 'open_floor' ||
      down.supportSolid !== true ||
      down.hazardNearby === true ||
      down.wallSolid !== false ||
      down.headSolid !== false
    ) {
      continue
    }
    const via = down.step
    if (!standable.has(cellKey(via))) continue
    for (const step of PROSPECT_CARDINALS) {
      const landing = { x: via.x + step.dx, y: via.y + 1, z: via.z + step.dz }
      if (!standable.has(cellKey(landing))) continue
      const d = distance(landing, target)
      if (!(d <= currentDistance - DIG_ROUTE_MIN_ADVANCE)) continue
      push({
        action: 'step_over',
        via,
        landing,
        ledge: { x: landing.x, y: landing.y - 1, z: landing.z },
        // `PROSPECT_CARDINALS` are the four horizontal faces, never the own column.
        dir: step.dir as PocketContinuation['dir'],
        toTarget: d,
      })
      if (out.length >= POCKET_CONTINUATION_CAP) return out
    }
  }
  return out
}

/**
 * Is `goal` reachable from the body's own cell by ORDINARY LEVEL WALKS over the
 * sensed standable set? A stand the body must DROP into (or climb onto) to reach
 * is not a walk: the stock `GoalBlock` MOVE contract can only express level
 * walking, which is exactly why the measured leg failed `outcome=stuck` with an
 * empty contract. Bounded by the sensor's own `terrain.standable` window.
 */
function levelWalkReachable(state: WorldState, goal: Vec3Json): boolean {
  const start = cellKey(state.self.position)
  const goalKey = cellKey(goal)
  const stands = new Set(state.terrain.standable.map((cell) => cellKey(cell)))
  if (!stands.has(goalKey)) return false
  const startCell = { x: Math.floor(state.self.position.x), y: Math.floor(state.self.position.y), z: Math.floor(state.self.position.z) }
  const seen = new Set<string>([start])
  const queue: Vec3Json[] = [startCell]
  while (queue.length > 0) {
    const current = queue.shift()
    if (current === undefined) break
    if (cellKey(current) === goalKey) return true
    for (const step of PROSPECT_CARDINALS) {
      const next = { x: current.x + step.dx, y: current.y, z: current.z + step.dz }
      const nextKey = cellKey(next)
      if (seen.has(nextKey) || !stands.has(nextKey)) continue
      seen.add(nextKey)
      queue.push(next)
    }
  }
  return false
}

/**
 * The grounded MOVE candidate for one continuation.
 *
 * TWO mechanical shapes, because the executor's order is fixed
 * (`executor.ts#runMove` runs the vertical contract BEFORE the walk):
 *
 *   - `step_up` (the ledge is face-adjacent and one level up): target = the
 *     landing WITH the SAME `vertical=staircase-up` contract the ordinary
 *     up-staircase uses. The dig cell is the empty cell above the ledge, so
 *     `digRetrievalStaircase` skips the dig and drives
 *     `pathTo(step, 'GoalGetToBlock')` - an ordinary adjacent 1-block jump, which
 *     is exactly what the contract expresses.
 *   - `step_over` (a verified hole lies between the body and the ledge): target =
 *     the hole FLOOR, the cell the body must stand in before it can jump. A
 *     vertical contract here would run BEFORE the walk that gets the body into the
 *     hole and could only fail, so the step-up is grounded as the NEXT tick's
 *     ordinary leg from that floor (it is then face-adjacent and one up). The
 *     landing/ledge/direction are carried in the meta so the operator and the
 *     next offer read the same mechanical plan.
 *
 * Nothing is invented in the executor, and no block has to be placed.
 */
function continuationCandidate(
  state: WorldState,
  options: CandidateOptions,
  spec: { target: Vec3Json; targetName: string | null; reason: string; extraMeta: Record<string, string | number | boolean>; skill: string },
  cont: PocketContinuation,
  reflex: string | null,
  boundary: string | null = null,
): Candidate {
  const feet = {
    x: Math.floor(state.self.position.x),
    y: Math.floor(state.self.position.y),
    z: Math.floor(state.self.position.z),
  }
  const target = cont.action === 'step_over' ? (cont.via ?? cont.landing) : cont.landing
  const via = cont.via === null ? 'none' : cellText(cont.via)
  const contract =
    cont.action === 'step_up'
      ? verticalPlanMeta(
          {
            kind: 'staircase-up',
            dir: cont.dir,
            fromY: feet.y,
            toY: cont.landing.y,
            // The cell above the ledge is already open: the step-up IS the whole HOW.
            dig: cont.landing,
            step: cont.landing,
            digName: null,
          } satisfies VerticalPlan,
          feet.y,
          cont.landing.y,
        )
      : // The hole floor comes FIRST: no vertical contract here (the executor runs
        // the contract before the walk), but the fact is stated explicitly so the
        // meta is never silently empty.
        { vertical: 'none' }
  // #436 section 17: the step states which deterministic layer justified it. A
  // candidate-layer continuation is realized only AFTER Jev selects it, so its
  // authority is MECHANICAL_CONTINUATION; the executor's in-skill step-over (the
  // unique prerequisite of an already-selected entry) is MANDATORY_PREREQUISITE.
  const line = formatSkillStep(
    spec.skill,
    cont.action,
    formatSkillStepAuthority(
      'MECHANICAL_CONTINUATION',
      `cell=${cellText(target)} via=${via} landing=${cellText(cont.landing)} ledge=${cellText(cont.ledge)} ` +
        `vertical=${cont.action === 'step_up' ? 'staircase-up' : 'none'} ` +
        `envelope=movement-only(no_dig,no_place)`,
    ),
  )
  const label =
    cont.action === 'step_over'
      ? `step over the hole into (${cellText(target)}) first: from there the ledge at (${cellText(cont.ledge)}) is one step up to (${cellText(cont.landing)}), toward (${cellText(spec.target)})`
      : `step up onto the ledge at (${cellText(cont.ledge)}) to stand at (${cellText(cont.landing)}), toward (${cellText(spec.target)})`
  return {
    id: `SKILL_STEP:${cont.action}:${blockId('p', target)}`,
    kind: 'MOVE',
    label,
    targetName: spec.targetName,
    target,
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: distance(target, state.self.eyePosition) <= options.reach,
    hasStandableAdjacent: true,
    meta: {
      tick: state.tick,
      x: target.x,
      y: target.y,
      z: target.z,
      approachLeg: spec.reason,
      approachTarget: `${spec.target.x},${spec.target.y},${spec.target.z}`,
      ...contract,
      legContinuation: true,
      legContinuationAction: cont.action,
      legContinuationSkill: spec.skill,
      legContinuationCell: cellText(target),
      legContinuationVia: via,
      legContinuationLanding: cellText(cont.landing),
      legContinuationLedge: cellText(cont.ledge),
      legContinuationDir: cont.dir,
      legContinuationToD: round2Number(cont.toTarget),
      legContinuationLine: line,
      ...(reflex === null ? {} : { legReflex: reflex }),
      ...(boundary === null ? {} : { legPolicyBoundary: boundary }),
      ...spec.extraMeta,
    },
  }
}

/**
 * The #436 `REFLEX` line for a unique binding continuation: the landed
 * `netherPortalPlan.formatReflex` shape (ownerSkill / reason / action / evidence),
 * with the cell, the hole floor and the ledge carried inside `evidence` so the
 * marker family stays ONE vocabulary across the candidate layer and the skill.
 */
function formatLegReflex(input: {
  skill: string
  action: PocketContinuation['action']
  /** the cell the step starts from (the hole floor) or lands on (a direct step-up) */
  cell: Vec3Json
  via: Vec3Json | null
  ledge: Vec3Json
  evidence: string
}): string {
  return formatReflex({
    ownerSkill: input.skill,
    action: input.action,
    evidence: `cell=${cellText(input.cell)} via=${input.via === null ? 'none' : cellText(input.via)} ledge=${cellText(input.ledge)} ${input.evidence}`,
  })
}

function travelApproachLegs(
  state: WorldState,
  options: CandidateOptions,
  spec: {
    target: Vec3Json
    targetName: string | null
    reason: string
    /** the skill/option that owns this leg, for the `REFLEX ownerSkill=` fact */
    skill: string
    label: (spot: Vec3Json) => string
    extraMeta: Record<string, string | number | boolean>
  },
  refusals: DigRouteRefusalSink,
): Candidate[] {
  const moveFailureLimit = options.moveFailureLimit ?? DEFAULT_CANDIDATE_MOVE_FAILURE_LIMIT
  const currentDistance = distance(state.self.position, spec.target)
  const standKey = cellKey(state.self.position)
  const targetKey = cellKey(spec.target)
  let best: Vec3Json | null = null
  let bestScore = Number.POSITIVE_INFINITY
  // A leg that IS the destination is not an approach. The destination's own route
  // is the one that just failed, so re-offering the destination as its own approach
  // waypoint is the same failing action under a different id. Measured live
  // (run-mucaq28q-1ftq1, the M3 pocket): the body 2 blocks west of the portal
  // interior with the frame's obsidian column between offered
  // `MOVE:p26_67_9` - a walk INTO the portal interior, which failed
  // `phase=pathing` - while the standable open face at (26,67,10), strictly closer
  // than the body and reachable, was never offered. The destination cell is only
  // excluded as a WAYPOINT; the destination's own candidate is untouched.
  for (const spot of state.terrain.standable) {
    // Only a DIFFERENT stand cell can change the mechanical situation: a "leg"
    // to the cell the body already occupies is not a route change, and the exact
    // float distance to a target can make the body's own floor cell look
    // "closer" than its centre.
    if (cellKey(spot) === standKey) continue
    if (cellKey(spot) === targetKey) continue
    if (isBlacklistedMoveTarget(state, options.blacklistedMoveTargets, spot)) continue
    const toTarget = distance(spot, spec.target)
    if (toTarget >= currentDistance) continue
    if (
      failureCount(state.signals.failedCandidates, `MOVE:${blockId('p', spot)}`) >= moveFailureLimit
    )
      continue
    const score = toTarget + distance(spot, state.self.position) * 0.1
    if (score < bestScore) {
      bestScore = score
      best = spot
    }
  }
  const legs: Candidate[] = []
  if (best !== null) {
    legs.push({
      id: `MOVE:${blockId('p', best)}`,
      kind: 'MOVE',
      label: spec.label(best),
      targetName: spec.targetName,
      target: best,
      targetEntityId: null,
      itemName: null,
      requiresTool: false,
      toolName: null,
      inReach: distance(best, state.self.position) <= options.reach,
      hasStandableAdjacent: true,
      meta: {
        tick: state.tick,
        x: best.x,
        y: best.y,
        z: best.z,
        approachLeg: spec.reason,
        approachTarget: `${spec.target.x},${spec.target.y},${spec.target.z}`,
        ...spec.extraMeta,
      },
    })
  }
  const dig = digRouteCandidate(
    state,
    options,
    {
      target: spec.target,
      targetName: spec.targetName,
      reason: 'no_walkable_route',
      extraMeta: spec.extraMeta,
    },
    refusals,
  )
  if (dig !== null) legs.push(dig)
  // The other grounded way the terrain can change when the walk steps are refused:
  // mine the adjacent SOLID wall open (`wallEntryCandidates`). Enumerated only when
  // the dig route above could not be grounded at all - the entry is an additional
  // ORDINARY candidate for exactly that shape (an offer Jev may take or ignore),
  // never a replacement for a route that exists and never a `if stuck then dig` step.
  const entries =
    dig === null
      ? wallEntryCandidates(
          state,
          options,
          { target: spec.target, targetName: spec.targetName, reason: 'no_walkable_route', extraMeta: spec.extraMeta },
          refusals,
        )
      : { candidates: [], classes: [] }
  for (const entry of entries.candidates) legs.push(entry)
  // The third way the terrain can change when nothing at the body's own level can: the
  // BOUNDED LEVEL SCAN (`levelScan.ts`). Enumerated only when BOTH the dig route and the
  // adjacent wall entry grounded nothing - the measured island - and only from the sensor's
  // own per-level probes, so the descent is the first step of a route that ends strictly
  // closer to the target, never a descent for its own sake.
  const levels =
    dig === null && entries.candidates.length === 0
      ? levelScanCandidates(
          state,
          options,
          {
            target: spec.target,
            targetName: spec.targetName,
            reason: 'no_walkable_route',
            skill: spec.skill,
            extraMeta: spec.extraMeta,
          },
          refusals,
        )
      : { candidates: [], classes: [], boundary: null }
  for (const level of levels.candidates) legs.push(level)
  // The last grounded route change: a bounded, sensor-derived continuation onto a
  // verified ledge when no sensed standable cell can walk to the waypoint at all
  // (see `pocketContinuations`). A continuation is a DIFFERENT stand cell, so the
  // ordinary MOVE / reachability / failure-memory machinery still owns the
  // execution and the spend budget; a stepping stone that proves zero change is
  // spent like any other leg.
  // Fire the continuation grounder only when the ordinary walk cannot express the
  // route: no advancing cell at all, or an advancing cell that is not reachable by
  // LEVEL WALKS over the sensed stands (measured live: `MOVE:p26_67_10` was a
  // sensed stand across a 1-block hole, so the stock MOVE contract failed `stuck`
  // with an empty contract). A genuinely walkable leg is therefore untouched.
  const walkable = best !== null && levelWalkReachable(state, best)
  const continuations = walkable ? [] : pocketContinuations(state, spec.target)
  // The BRIDGE/scaffold remedy: a same-level gap whose floor cell is placed while
  // the body advances. Grounded ONLY on the sensor's own bounded forward probe
  // (`state.bridgeProbes`) plus a held placeable block, and only when the route
  // genuinely needs to cross a gap (the same `walkable` gate the hole
  // step-over/step-up uses), so ordinary walkable terrain grounds nothing here.
  const bridge = groundBridgeLeg(state, options, spec, walkable)
  // The VERTICAL remedy when the target itself is above the body: the same grounded
  // ascent every other arm uses (`planVerticalApproachDetailed`), hung off the
  // locomotion target's GEOMETRY instead of a goal kind (see
  // `verticalRemedyCandidates`). Gated on the ordinary walk being unable to express
  // the route, exactly like the continuations and the bridge.
  const vertical =
    walkable || (best === null && continuations.length === 0 && bridge.plan === null)
      ? { candidates: [], classes: [] }
      : verticalRemedyCandidates(state, options, { target: spec.target, reason: spec.reason, skill: spec.skill })
  for (const ascent of vertical.candidates) legs.push(ascent)
  // #436 section 7 (U3) / section 19 (8, 28) / section 22: the grounded remedies
  // are ENUMERATED by semantic class, never ranked. `movement` is the hole
  // step-over/step-up; `dig:route` is the bounded dig route and `dig:wall_entry` the
  // tunnel into the adjacent solid wall, both separate DESCEND candidates (never a
  // contract on a MOVE, so a walk never silently gains dig authority);
  // `ascent:vertical` is the grounded climb to a target above; `place:bridge` is a
  // MOVE that DECLARES `mayPlaceBlocks` and the block it consumes. When more than one
  // class is on offer the next move is Jev's, and the boundary is stated.
  const remedyClasses = [
    ...(best !== null ? ['movement:walk'] : []),
    ...continuations.map((cont) => `movement:${cont.action}`),
    ...(dig !== null ? ['dig:route'] : []),
    ...entries.classes,
    ...levels.classes,
    ...vertical.classes,
    ...(bridge.plan !== null ? ['place:bridge'] : []),
    ...(bridge.plan !== null && ascendAlternativeAvailable(state, spec.target) ? ['place:pillar'] : []),
  ]
  // #436 section 7 U3 / section 19 (8, 28) / section 22: several grounded remedies are
  // several routes for Jev and code stops. When the alternatives are whole remedy
  // CLASSES the boundary names the classes; when the classes agree but several WALL
  // ENTRY directions/modes grounded, it names those instead; when the classes agree but
  // several LEVEL SCAN routes grounded (several levels and/or directions below), it names
  // those - either way the line says which alternatives code refused to rank.
  const entryAlternatives =
    entries.candidates.length > 1
      ? entries.candidates.map(
          (candidate) => `dig:wall_entry:${String(candidate.meta.digRouteBearing ?? '?')}:${String(candidate.meta.digRouteEntryMode ?? '?')}`,
        )
      : []
  // The level-scan alternatives are the (level, direction, via) triples the rule grounded;
  // when the scan grounded more than one, the arm's own boundary line already names them and
  // is carried on the candidate (`levels.boundary` below).
  const boundary =
    remedyClasses.length > 1
      ? formatSkillPolicyBoundary({
          skill: spec.skill,
          reason: 'multiple_non_equivalent_recoveries',
          alternatives: remedyClasses,
        })
      : entryAlternatives.length > 1
        ? formatSkillPolicyBoundary({
            skill: spec.skill,
            reason: 'multiple_grounded_wall_entries',
            alternatives: entryAlternatives,
          })
        : levels.boundary
  const uniqueContinuation =
    continuations.length === 1 &&
    dig === null &&
    !walkable &&
    bridge.plan === null &&
    entries.classes.length === 0 &&
    levels.classes.length === 0 &&
    vertical.classes.length === 0
  for (const cont of continuations) {
    const reflex = uniqueContinuation
      ? formatLegReflex({
          skill: spec.skill,
          action: cont.action,
          // the cell the continuation MOVES INTO (the hole floor for a step-over)
          cell: cont.via ?? cont.landing,
          via: cont.via,
          ledge: cont.ledge,
          evidence:
            (cont.via === null
              ? `ledge@${cellText(cont.ledge)}:solid`
              : `hole_floor@${cellText(cont.via)}:standable+support_solid;ledge@${cellText(cont.ledge)}:solid`) +
            `;d=${round2Number(currentDistance)}->${round2Number(cont.toTarget)}`,
        })
      : null
    legs.push(continuationCandidate(state, options, spec, cont, reflex, boundary))
  }
  if (bridge.plan !== null) {
    // #436 section 7: when the bridge is the ONLY grounded remedy class, code may
    // finish the already-selected leg's mechanical prerequisite, and the step says
    // so (`authority=MANDATORY_PREREQUISITE` + the `REFLEX
    // reason=unique_binding_prerequisite` proof). When several classes are grounded
    // the step is only a mechanical continuation of the route Jev selected, and the
    // boundary line names the alternatives code refused to rank.
    const unique = remedyClasses.length === 1
    const authority = formatSkillStepAuthority(
      unique ? 'MANDATORY_PREREQUISITE' : 'MECHANICAL_CONTINUATION',
      `cell=${cellText(bridge.plan.landing)} place=${cellText(bridge.plan.place)} far=${cellText(bridge.plan.far)} ` +
        `dir=${bridge.plan.dir} block=${bridge.plan.block} span=${bridge.plan.span} probe=bounded(${bridge.plan.span})`,
      'place_blocks=1',
      { budget: bridge.plan.span },
    )
    const reflex = unique ? formatBridgeReflex(spec.skill, bridge.plan) : null
    legs.push(bridgeLegCandidate(state, options, spec, bridge.plan, authority, reflex, boundary))
  }
  // A boundary with no continuation candidate still has to be visible: attach it to
  // the walk leg / dig route so the operator sees that BOTH classes were grounded
  // and that code stopped.
  if (boundary !== null && legs.length > 0) {
    for (const leg of legs) leg.meta.legPolicyBoundary = boundary
  }
  // #436 section 17 for every WALL ENTRY leg: the layer half says whether code finished
  // a UNIQUE prerequisite or merely realized the route Jev selected. The line is
  // carried in meta exactly like the bridge's authority line, and the controller logs
  // it through the same mirrored `SKILL_STEP` marker when the entry is selected.
  for (const leg of legs) {
    if (leg.meta.digRouteEntry !== true) continue
    // §7's unique-remedy test: ONE grounded remedy in total (this entry) is a
    // prerequisite code may finish; several (another class, or another entry
    // direction) means the step only realizes the route Jev selected.
    const unique = remedyClasses.length === 1 && entries.candidates.length === 1
    leg.meta.digRouteAuthorityLine = formatSkillStep(
      spec.skill,
      'wall_entry',
      formatSkillStepAuthority(
        unique ? 'MANDATORY_PREREQUISITE' : 'MECHANICAL_CONTINUATION',
        `target=${cellText(spec.target)} dir=${String(leg.meta.digRouteBearing ?? 'unknown')} ` +
          `mode=${String(leg.meta.digRouteEntryMode ?? 'unknown')} cell=${String(leg.meta.digRouteCell ?? 'unknown')} ` +
          `floor=${String(leg.meta.digRouteEntryFloor ?? 'unknown')}:${String(leg.meta.digRouteEntryFloorBlock ?? 'unknown')} ` +
          `evidence=${String(leg.meta.digRouteEntryEvidence ?? 'none')} alternatives=${String(leg.meta.digRouteEntryAlternatives ?? 'none')}`,
        'dig_blocks=1',
        { budget: 1 },
      ),
    )
    if (unique) {
      leg.meta.legReflex = formatReflex({
        ownerSkill: spec.skill,
        action: 'wall_entry',
        evidence:
          `no_walkable_route;wall@${String(leg.meta.digRouteCell ?? 'unknown')}:` +
          `${String(leg.meta.digRouteBlock ?? 'unknown')};floor:${String(leg.meta.digRouteEntryFloorBlock ?? 'unknown')};` +
          `d=${String(leg.meta.digRouteFrom ?? 'unknown')}->${String(leg.meta.digRouteTo ?? 'unknown')}`,
      })
    }
  }
  // The typed refusal is attached to the legs this offer DID ground, exactly like
  // `legPolicyBoundary`: a reviewer reads "the bridge was needed here and refused
  // for THIS reason" instead of inferring it from an absent candidate.
  if (bridge.refusal !== null && legs.length > 0) {
    const line = formatBridgeRefused(bridge.refusal)
    for (const leg of legs) leg.meta[BRIDGE_REFUSED_META] = line
  }
  return legs
}

/** What one bridge offer (and its candidate) is aimed at. */
interface BridgeLegSpec {
  target: Vec3Json
  targetName: string | null
  /** why this leg exists, carried into the meta (`route_spent` / `route_withheld`) */
  reason: string
  /** the owning Skill, or null for a route-opening offer no Skill encloses */
  skill: string | null
  extraMeta?: Record<string, string | number | boolean>
}

/**
 * The bridge offer for one leg. Returns the verified plan or the typed refusal;
 * `plan === null` NEVER becomes a candidate, so "no placeable block" and "no
 * verified landing" can never surface as an executable action.
 *
 * The `walkable` gate is the same one the hole step-over/step-up uses: a leg the
 * ordinary level walk can already express is untouched, so ordinary walkable
 * terrain offers no bridge, attaches no marker and places nothing.
 */
function groundBridgeLeg(
  state: WorldState,
  options: CandidateOptions,
  spec: { target: Vec3Json; targetName: string | null },
  walkable: boolean,
): { plan: BridgePlan | null; refusal: BridgeRefusal | null } {
  if (walkable) return { plan: null, refusal: null }
  const feet = {
    x: Math.floor(state.self.position.x),
    y: Math.floor(state.self.position.y),
    z: Math.floor(state.self.position.z),
  }
  // A bridge is a SAME-LEVEL structure: its probes live at the body's feet Y and
  // its self-landing place cell is `feet.y - 1`, so it can neither climb to a
  // target above nor descend to one below. The entry crossing has carried this
  // gate since it landed (`Math.abs(entry.enterCell.y - feet.y) > PORTAL_WALK_IN_LEVEL_TOLERANCE`);
  // the general MOVE leg did not, which is how a body perched at y79 with its
  // target at y67 built an elevated highway across the area instead of descending.
  // The vertical planner owns the difference; this leg declines it, typed.
  // The gate is ASYMMETRIC because the mechanics are: a bridge places a floor and
  // advances onto it, and with a pillar leg it can also rise to a target above -
  // that is the legitimate "tower" remedy the entry fixture pins (a target at
  // +6 still offers place:bridge + place:pillar). It cannot DESCEND, because
  // placing below the feet and stepping down is a different act (the descent
  // scaffold owns it). So only a target BELOW this bridge's own plane is refused.
  if (feet.y - spec.target.y > PORTAL_WALK_IN_LEVEL_TOLERANCE) {
    return {
      plan: null,
      refusal: {
        reason: 'level',
        cell: feet,
        target: spec.target,
        block: null,
        detail: `target y=${spec.target.y} is ${Math.abs(spec.target.y - feet.y)} block(s) from the body's feet y=${feet.y}; a bridge advances only in its own plane`,
      },
    }
  }
  const liveStructures = liveStructureIndexOf(state)
  const decision = planBridgeRoute({
    selfFeet: feet,
    target: spec.target,
    probes: state.bridgeProbes,
    placeable: selectPlaceableBlock(state.inventory.counts),
    isProtected: (cell, name) =>
      (name !== null && isProtectedStationBlock(name)) || isLiveStructureMember(liveStructures, cell),
    maxSpan: options.bridgeMaxSpan ?? BRIDGE_MAX_SPAN,
  })
  return { plan: decision.plan, refusal: decision.refusal }
}

/**
 * THE CROSSING LEG of the portal entry (the operator's trial, second half).
 *
 * Measured, live (`runs/` operator trial 2026-09-23, body `(26.3,64.0,6.3)` on a
 * ledge, floated gate interior `(26,67,9)`): the body's ledge ends and there is
 * open air - not a step, not a dig - between it and the gate. The frame's bottom
 * row is obsidian at `y=66`, so standing in the interior means standing ON that
 * row, and the interior's own floor is not a cell the body can walk to: the
 * `canDig=false` pathfinder cannot express "place a block into the void and step
 * onto it", and the dig/vertical route has nothing to dig because the gap is AIR.
 * Every ENTER realization therefore ended `PATH_CALLBACK phase=failed
 * outcome=stuck`, and the previous lane closed only the CLIMB half.
 *
 * This grounds the missing half with the SAME rule every other bridge uses
 * (`bridgeRoute.ts#planBridgeRoute` over the sensor's own bounded forward probes
 * `state.bridgeProbes`), gated on the ONE geometry where the crossing is the
 * missing mechanical fact:
 *
 *   the body is already at the interior's own level, within the walk-in's
 *   tolerance (`PORTAL_WALK_IN_LEVEL_TOLERANCE`).
 *
 * When the interior is higher than that, the CLIMB is the missing fact and this
 * returns no plan: the two legs are not alternatives, they are consecutive halves
 * of one route (climb, then cross, then the verified walk-in), and grounding a
 * crossing at the ledge's own level would spend blocks on a span that still does
 * not reach the gate. When the interior is lower, the descent half owns it.
 *
 * The protected predicate is the ONE shared source rule (`blockSafety.ts`):
 * a protected station by name, or a cell of a LIVE structure - which is what the
 * portal frame and interior cells are. So the crossing can never place into the
 * gate, and it can never bridge ONTO a gate cell.
 *
 * The refusal is deliberately NOT attached to the entry offer: an entry whose
 * ordinary walk can close the last block needs no crossing, and a refusal key on
 * it would put a "the bridge was refused" fact on a route that needed no bridge -
 * as well as changing the offer of a level gate. The crossing's typed refusals are
 * reported where they are real: live, by `runBridge`'s own `BRIDGE_REFUSED`, and on
 * the terminal `PORTAL_ENTRY_ROUTE_BLOCKED ... cross=` when a declared crossing
 * leg could not execute.
 */
function groundEntryBridgeLeg(
  state: WorldState,
  options: CandidateOptions,
  entry: PortalEntryCandidate,
): BridgePlan | null {
  const feet = {
    x: Math.floor(state.self.position.x),
    y: Math.floor(state.self.position.y),
    z: Math.floor(state.self.position.z),
  }
  if (Math.abs(entry.enterCell.y - feet.y) > PORTAL_WALK_IN_LEVEL_TOLERANCE) return null
  const liveStructures = liveStructureIndexOf(state)
  const decision = planBridgeRoute({
    selfFeet: feet,
    target: entry.enterCell,
    probes: state.bridgeProbes,
    placeable: selectPlaceableBlock(state.inventory.counts),
    isProtected: (cell, name) =>
      (name !== null && isProtectedStationBlock(name)) || isLiveStructureMember(liveStructures, cell),
    maxSpan: options.bridgeMaxSpan ?? BRIDGE_MAX_SPAN,
  })
  return decision.plan
}

/**
 * The crossing leg's #436 section 17 layer, in the SAME `SKILL_STEP ... step=bridge`
 * vocabulary the MOVE bridge offer writes (`bridgeLegCandidate`): the ENTER action
 * is the one Jev selected, so its crossing realizes that selection mechanically.
 * `legContinuationSkill` names the owning Skill for the controller's mirror, exactly
 * as the MOVE leg does for a route-opening offer.
 */
function entryBridgeAuthorityLine(plan: BridgePlan): string {
  return formatSkillStep(
    PORTAL_ENTER_SKILL,
    'bridge',
    formatSkillStepAuthority(
      'MECHANICAL_CONTINUATION',
      `cell=${cellText(plan.landing)} place=${cellText(plan.place)} far=${cellText(plan.far)} ` +
        `dir=${plan.dir} block=${plan.block} span=${plan.span} probe=bounded(${plan.span})`,
      'place_blocks=1',
      { budget: plan.span },
    ),
  )
}

/**
 * #436 section 7 uniqueness proof for a bridge that is the ONLY grounded remedy:
 * the exact geometry (landing / placement cell / verified far side) plus the
 * distance claim, in the ONE `REFLEX` vocabulary `netherPortalPlan.ts` owns.
 */
function formatBridgeReflex(skill: string, plan: BridgePlan): string {
  return formatReflex({
    ownerSkill: skill,
    action: 'bridge',
    evidence:
      `gap@${cellText(plan.landing)}:no_support;place@${cellText(plan.place)}:${plan.block};` +
      `far@${cellText(plan.far)}:${plan.selfLanding === true ? 'placed' : 'standable'};dir=${plan.dir};span=${plan.span};` +
      `d=${round2Number(plan.from)}->${round2Number(plan.to)}`,
  })
}

/**
 * Is an ASCENT (tower/pillar) genuinely available for this leg target? Read from
 * the ONE vertical planner every ascend candidate already uses, so the tower is
 * named as an alternative only when it really is one. It is deliberately used for
 * the policy BOUNDARY only: code never selects it here, and Jev remains the only
 * chooser between tower / bridge / dig / walk-around.
 */
function ascendAlternativeAvailable(state: WorldState, target: Vec3Json): boolean {
  if (target.y - state.self.position.y <= VERTICAL_GAP) return false
  const abilities = deriveReachabilityAbilities(state, target, columnFacts(state))
  return abilities.ascend.available
}

/** The offered BRIDGE MOVE: the verified far side is its own postcondition. */
function bridgeLegCandidate(
  state: WorldState,
  options: CandidateOptions,
  spec: BridgeLegSpec,
  plan: BridgePlan,
  authority: string,
  reflex: string | null,
  boundary: string | null,
): Candidate {
  const selfLanding = plan.selfLanding === true
  return {
    id: `BRIDGE:${plan.dir}:${blockId('p', plan.landing)}`,
    kind: 'MOVE',
    label: selfLanding
      ? `scaffold ${plan.dir}: place ${plan.block} at (${cellText(plan.place)}) against the footing and step onto the floor it makes at ` +
        `(${cellText(plan.landing)}), toward (${cellText(spec.target)})`
      : `bridge the gap ${plan.dir}: place ${plan.block} at (${cellText(plan.place)}) against the footing and step onto ` +
        `(${cellText(plan.landing)}), continuing to the verified stand at (${cellText(plan.far)}), toward (${cellText(spec.target)})`,
    targetName: spec.targetName,
    // The postcondition cell is the VERIFIED FAR SIDE: the body only claims this
    // MOVE when it stands there (`executor.runBridge`), never when it merely
    // placed a block somewhere. For a self-landing scaffold the far side IS the
    // landing, so the same postcondition says "the body stands on the floor this
    // leg placed" - which is exactly what a scaffold claims.
    target: plan.far,
    targetEntityId: null,
    // The effect lives in meta (`mayPlaceBlocks` + the consumed block), never in
    // `itemName`: a MOVE is not a PLACE, and the item bookkeeping paths must not
    // read a bridge as "a route for cobblestone".
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: distance(plan.far, state.self.eyePosition) <= options.reach,
    // The far side is a verified stand from the probe's own `isUsableStand` read; it
    // may sit outside the flat 5x5x3 scan, exactly like a pillar apex that is air
    // until the executor places the column.
    hasStandableAdjacent: true,
    meta: {
      tick: state.tick,
      x: plan.far.x,
      y: plan.far.y,
      z: plan.far.z,
      // The ONE bridge contract (`bridgeRoute.ts#bridgeContractMeta`), shared with
      // the portal entry's crossing leg so an offer can never declare a subset of
      // what `runBridge` reads.
      ...bridgeContractMeta(plan),
      [BRIDGE_AUTHORITY_META]: authority,
      // The skill that owns this leg, in the SAME meta key the hole
      // step-over/step-up continuation uses, so the controller's `SKILL_STEP`
      // mirror names one skill vocabulary (never a parallel one). Null for a
      // route-opening offer, which no enclosing Skill owns.
      ...(spec.skill === null ? {} : { legContinuationSkill: spec.skill }),
      approachLeg: spec.reason,
      approachTarget: `${spec.target.x},${spec.target.y},${spec.target.z}`,
      ...(reflex === null ? {} : { legReflex: reflex }),
      ...(boundary === null ? {} : { legPolicyBoundary: boundary }),
      ...spec.extraMeta,
    },
  }
}

function round2Number(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * The named-resource spelling of {@link travelApproachLegs}: the remembered
 * resource's own route proved zero observable change, so the legs name the
 * resource and the item the trip is for.
 */
function knownResourceApproachLegs(
  state: WorldState,
  options: CandidateOptions,
  want: RetrievalWant,
  known: KnownResource,
  refusals: DigRouteRefusalSink,
): Candidate[] {
  return travelApproachLegs(
    state,
    options,
    {
      target: known.position,
      targetName: known.name,
      reason: 'target_not_observable',
      skill: KNOWN_RETRIEVE_SKILL,
      label: (best) =>
        `walk an approach leg toward the remembered ${known.name} at (${known.position.x},${known.position.y},${known.position.z}) for ${want.item}: the last route there changed nothing, so stand at (${best.x},${best.y},${best.z}) first`,
      extraMeta: { approachResource: want.item, knownName: known.name },
    },
    refusals,
  )
}

function retrievalCandidatesForWant(
  state: WorldState,
  options: CandidateOptions,
  want: RetrievalWant,
  digRefusals: DigRouteRefusalSink = [],
): Candidate[] {
  if (mineableBlockFor(state, want) !== null) return []
  const known = knownResourceFor(state, want, options.blacklistedMoveTargets)
  if (known !== null) {
    const id = `RETRIEVE:known:${want.item}:${blockId('b', known.position)}`
    if (
      failureCount(state.signals.failedCandidates, id) >=
      (options.moveFailureLimit ?? DEFAULT_CANDIDATE_MOVE_FAILURE_LIMIT)
    )
      return []
    // Issue #45: a remembered resource below the current level needs a vertical
    // leg (reuse a tunnel, else dig a staircase step) or retrieval stalls at the
    // horizontal bearing and falls back to WAIT.
    const vertical = planVerticalApproach(verticalInputFor(state, known.position))
    const tunnelFallback =
      vertical?.kind === 'reuse'
        ? planVerticalApproach({ ...verticalInputFor(state, known.position), tunnel: null })
        : null
    const verticalMeta = {
      ...verticalPlanMeta(vertical, Math.floor(state.self.position.y), known.position.y),
      ...(vertical?.kind === 'reuse' ? fallbackVerticalMeta(tunnelFallback) : {}),
    }
    const verticalLabel = verticalPlanLabel(vertical)
    const logRoute = want.kind === 'log' ? logRetrieveMode(state, known.position, vertical) : null
    const candidate: Candidate = {
      id,
      kind: 'RETRIEVE',
      label: `return to remembered ${known.name} at (${known.position.x},${known.position.y},${known.position.z}) for ${want.item}, ${distance(known.position, state.self.position)}m away${verticalLabel}`,
      targetName: known.name,
      target: known.position,
      targetEntityId: null,
      itemName: null,
      requiresTool: false,
      toolName: null,
      inReach: distance(known.position, state.self.eyePosition) <= options.reach,
      hasStandableAdjacent: true,
      meta: {
        tick: state.tick,
        retrieval: 'known',
        resource: want.item,
        resourceKind: want.kind,
        knownName: known.name,
        x: known.position.x,
        y: known.position.y,
        z: known.position.z,
        ...verticalMeta,
        ...(logRoute === null ? {} : { [LOG_ROUTE_META]: logRoute }),
      },
    }
    // The settled postcondition proved this exact route changes NOTHING from this
    // body cell (`ACTION_ZERO_PROGRESS ... kind=RETRIEVE route_changed=false`).
    // Re-offering the same action with unchanged preconditions is the forbidden
    // retry; a grounded approach leg that changes the stand cell is the
    // alternative, and if none exists the target waits for the existing bounded
    // retire/stall machinery instead of burning another action.
    const standKey = cellKey(state.self.position)
    if (
      isZeroProgressRouteRepeat(state.signals.zeroProgressRoutes, {
        kind: 'RETRIEVE',
        targetKey: cellKey(known.position),
        standKey,
        routeSig: routeSignature({ kind: candidate.kind, id: candidate.id, meta: candidate.meta }),
        nowMs: state.timestampMs,
      })
    ) {
      // The grounded route changes for a spent retrieval: a walk leg that changes
      // the stand cell, and/or the bounded dig route through the terrain toward
      // the remembered cell when no standable cell improves the distance.
      return knownResourceApproachLegs(state, options, want, known, digRefusals)
    }
    return [candidate]
  }
  if (want.kind !== 'log') return []
  const spot = surfaceSpot(
    state,
    want.item,
    options.moveFailureLimit ?? DEFAULT_CANDIDATE_MOVE_FAILURE_LIMIT,
    options.blacklistedMoveTargets,
    options.searchedSurfaceTargets,
  )
  if (spot === null) return []
  return [
    {
      id: `RETRIEVE:surface:${want.item}:${blockId('p', spot)}`,
      kind: 'RETRIEVE',
      label: `explore the surface for ${want.item} (logs are a surface resource; none visible from y=${Math.round(state.self.position.y)}), stand at (${spot.x},${spot.y},${spot.z})`,
      targetName: null,
      target: spot,
      targetEntityId: null,
      itemName: null,
      requiresTool: false,
      toolName: null,
      inReach: distance(spot, state.self.eyePosition) <= options.reach,
      hasStandableAdjacent: true,
      meta: {
        tick: state.tick,
        retrieval: 'surface',
        resource: want.item,
        resourceKind: 'log',
        surface: true,
        x: spot.x,
        y: spot.y,
        z: spot.z,
        [LOG_ROUTE_META]: 'explore',
      },
    },
  ]
}

/**
 * Feasibility (CAN) rule for the known-resource RETRIEVE arm, mirroring
 * {@link mineDropAdvancesFocus} for MINEs.
 *
 * A remembered-coordinate trip is a real body change (it walks/pillars/digs to
 * the cell), so offering one for an item that cannot advance the ACTIVE focus is
 * a live zero-progress loop: `planId=g3:collect:flint` had Jev select
 * `RETRIEVE:known:obsidian:b28_67_9` (obsidian sits at y=67), pillar up to it,
 * then a DESCEND step pulled the body back down -- a depth oscillation that never
 * reached the gravel the flint goal needed. The MINE arm already withholds
 * non-advancing drops; the RETRIEVE arm did not.
 *
 * Same reasoning and the same proof obligation as the MINE rule: keep the trip
 * when the needed item IS the focus (or satisfies its class), when it is a
 * material in the focus's achievable recipe chain (`ender_eye` -> blaze_powder
 * -> blaze_rod), or when the focus is a resource class / absent / has no recipe
 * index. Withhold only on proof that the trip cannot advance the focus. This is
 * a withholding rule, never a ranking: the remaining candidates keep their
 * order, and if the only retrieval is withheld the exploration fallback for the
 * focus is still generated.
 */
function retrievalWantAdvancesFocus(
  focusItem: string | null,
  want: RetrievalWant,
  recipes: RecipeIndex | null,
): boolean {
  return mineDropAdvancesFocus(focusItem, want.item, recipes)
}

/**
 * Issue #14: offer a grounded return-to-known candidate for the earliest need
 * in the queue that has a remembered coordinate but no visible block. Returns
 * only the first satisfiable need so the probe stays bounded.
 */
function retrievalCandidates(
  state: WorldState,
  options: CandidateOptions,
  focusItem: string | null,
  includeQueued = true,
  digRefusals: DigRouteRefusalSink = [],
): Candidate[] {
  const recipes = options.recipes ?? null
  const queuedProxy = allowsQueuedRetrievalProxy(state.goalQueue?.current ?? null)
  for (const want of retrievalNeeds(state, focusItem, includeQueued)) {
    // The explicit descent proxy intentionally exposes the next unresolved
    // prerequisite even though its item differs from the proxy's cobblestone
    // focus.  Every ordinary row remains focus-bounded.
    if (!queuedProxy && !retrievalWantAdvancesFocus(focusItem, want, recipes)) continue
    const candidates = retrievalCandidatesForWant(state, options, want, digRefusals)
    if (candidates.length > 0) return candidates
  }
  return []
}

/** Cap on sensed drops offered as PICKUPs per tick (nearest first). */
export const MAX_PICKUP_CANDIDATES = 4

/**
 * The grounded PICKUP affordance for a DROPPED ITEM ENTITY.
 *
 * A killed mob's drop (or a dropped block yield, or any other item on the
 * ground) is an ENTITY at a world position, and the ONLY way it reaches the
 * inventory is the body walking into it: Mineflayer sends nothing, the server
 * picks the item up when the body is inside the pickup volume (mineflayer 4.39.0
 * `lib/plugins/entities.js` only OBSERVES the inbound `collect` packet). The
 * executor already knows how to do that walk (`collectDrop`), but until now it
 * could only ever be reached from INSIDE another action - a MINE verify, or a
 * hunt that had just proved a kill. An item that outlived that bounded window
 * (the kill landed at the edge of the lease, the drop fell outside the 4-block
 * search radius, the nudge stalled) had NO decision-layer route back: the
 * candidate layer could not even name such an entity (`droppedItem` did not
 * exist on the sensor's entity state), so a `blaze_rod`/`ender_pearl` on the
 * ground was invisible forever and the run reported "0 held" with no action left
 * to take.
 *
 * This is CAN enumeration, never a rank and never M3-specific:
 *   * it is driven by `pickupDropAdvancesFocus`: a concrete class member or a
 *     proven recipe ingredient is on offer, while unrelated loot cannot masquerade
 *     as progress for the ACTIVE goal (`ender_eye` -> blaze_powder -> blaze_rod
 *     is one such chain);
 *   * one candidate per sensed drop, keyed on the ENTITY id (a falling item's
 *     position changes every tick, so a position key would defeat the bounded
 *     failure memory while an id is stable for the drop's whole lifetime);
 *   * the reachability gate owns whether the body can actually walk there;
 *   * it is appended ALONGSIDE every other family, so Jev still chooses.
 */
function pickupCandidates(
  state: WorldState,
  options: CandidateOptions,
  focusItem: string | null,
): Candidate[] {
  const recipes = options.recipes ?? null
  const failureLimit = options.moveFailureLimit ?? DEFAULT_CANDIDATE_MOVE_FAILURE_LIMIT
  const drops = state.entities
    .filter((entity) => {
      const item = entity.droppedItem
      if (typeof item !== 'string' || item.length === 0) return false
      if (!pickupDropAdvancesFocus(focusItem, item, recipes)) return false
      if (failureCount(state.signals.failedCandidates, `PICKUP:e${entity.id}`) >= failureLimit) return false
      return true
    })
    .sort((a, b) => (a.distance === b.distance ? a.id - b.id : a.distance - b.distance))
    .slice(0, MAX_PICKUP_CANDIDATES)
  return drops.map((entity) => {
    const item = entity.droppedItem as string
    const inReach = distance(entity.position, state.self.eyePosition) <= options.reach
    return {
      // The entity ID is the identity of THIS drop for its whole lifetime.
      id: `PICKUP:e${entity.id}`,
      kind: 'PICKUP' as const,
      label: `walk onto the dropped ${item} ${entity.distance}m away at (${entity.position.x},${entity.position.y},${entity.position.z}) and pick it up`,
      targetName: item,
      target: entity.position,
      targetEntityId: entity.id,
      itemName: item,
      requiresTool: false,
      toolName: null,
      inReach,
      hasStandableAdjacent: true,
      meta: {
        tick: state.tick,
        pickupItem: item,
        pickupEntityId: entity.id,
        distance: entity.distance,
        // The drop is a WORLD entity, not a remembered coordinate: the executor
        // must re-locate the item entity by name near this position rather than
        // trusting a stale cell (an item keeps falling for a few ticks).
        pickupRoute: 'dropped_item_entity',
      },
    }
  })
}

export function surfaceSpot(
  state: WorldState,
  item: string,
  moveFailureLimit: number,
  blacklistedMoveTargets: ReadonlySet<string> | undefined,
  searchedSurfaceTargets: ReadonlySet<string> | undefined,
): Vec3Json | null {
  let best: Vec3Json | null = null
  for (const spot of state.terrain.standable) {
    // buildTerrain only scans dy in [-1, +1] (state.ts buildTerrain), so the
    // largest reachable standable y is floor(self.y)+1 < self.y+2. The old
    // `+ 2` threshold was therefore UNSATISFIABLE: surfaceSpot always returned
    // null, RETRIEVE:surface was never emitted, and post-death surface
    // exploration collapsed to local MOVE + WAIT (live run-mu9crrhw-1b5xw, RC
    // a137735). Require strictly higher ground (+1), which the sensor can
    // actually reach. Same semantics (explore upward), same candidate id, same
    // blacklist ordering - only the unreachable constant is fixed.
    if (spot.y <= state.self.position.y) continue
    if (isBlacklistedMoveTarget(state, blacklistedMoveTargets, spot)) continue
    if (searchedSurfaceTargets?.has(surfaceSearchKey(state.self.dimension, spot))) continue
    const id = `RETRIEVE:surface:${item}:${blockId('p', spot)}`
    if (failureCount(state.signals.failedCandidates, id) >= moveFailureLimit) continue
    if (best === null || spot.y > best.y) best = spot
  }
  return best
}

/** True when an item name is edible (the shared `food` resource class). */
export function isFoodItem(name: string): boolean {
  return isEdibleFoodItem(name)
}

/**
 * The food item the bot would eat, or null when it holds no edible item. Exported
 * so the controller's FOOD_LOW/EAT_REFUSED markers read the same truth table the
 * EAT candidate is grounded on instead of re-listing item names.
 */
export function pickFood(state: WorldState): string | null {
  let best: string | null = null
  let bestCount = 0
  for (const [name, count] of Object.entries(state.inventory.counts)) {
    if (!matchesResourceClass(name, 'food')) continue
    if (count > bestCount) {
      best = name
      bestCount = count
    }
  }
  return best
}

function nearestDanger(state: WorldState, radius: number): BlockState | null {
  let nearest: BlockState | null = null
  for (const block of state.blocks) {
    if (block.kind !== 'hazard') continue
    if (block.distance > radius) continue
    if (nearest === null || block.distance < nearest.distance) nearest = block
  }
  return nearest
}

/**
 * Grounded keep-distance destinations, best separation first. The nearest
 * active hostile supplies the primary keep-distance direction; every other
 * active hostile constrains the returned cells so a retreat from one enemy
 * cannot walk into another. Up to `MAX_RETREAT_CANDIDATES` remain for Jev to
 * choose a direction instead of receiving one pre-picked spot.
 *
 * A destination qualifies only when it ACTUALLY keeps distance from the threat:
 * it reaches that threat's standoff range without moving closer, or it gains at
 * least `MIN_KEEP_DISTANCE_GAIN` of separation. The previous rule (`> current +
 * 0.25`) admitted a 1.4 m shuffle inside melee reach and labelled it "retreat to
 * safety"; the measured body selected exactly such a spot, executed `moved=0m`,
 * and died on it. Destinations come from the local `standable` window AND from
 * the threat escape scan (`terrain.escapeCells`), because the local window is
 * only 5x5x3 and can never contain a real escape.
 *
 * With no sensed threat the original hazard/self escape semantics are preserved.
 */
function pickRetreats(
  state: WorldState,
  standable: Vec3Json[],
  danger: BlockState | null,
  threats: readonly ThreatEntityLike[],
  blacklistedMoveTargets: ReadonlySet<string> | undefined,
  /** the damage attribution as a threat origin, for an attacker never sensed */
  attributed: { name: string; position: Vec3Json } | null = null,
): KeepDistanceSpot[] {
  const hurt = state.self.health <= CRITICAL_COMBAT_HEALTH
  if (danger === null && threats.length === 0 && !hurt && attributed === null) return []
  const hostile = threats.length > 0 ? threats[0] ?? null : null
  const threat = danger?.position ?? hostile?.position ?? attributed?.position ?? state.self.position
  // The hostile branch below measures RETREAT from this nearest hostile; every
  // other active hostile constrains the destination geometry.
  const primaryHostileId = hostile?.id ?? null
  const additionalThreats = threats
    .filter((other) => other.id !== primaryHostileId)
    .map((other) => ({ position: other.position, standoff: threatStandoffRange(other.name) }))
  const usable = (spot: Vec3Json): boolean => !isBlacklistedMoveTarget(state, blacklistedMoveTargets, spot)
  const standableUsable = standable.filter(usable)
  if (hostile !== null || attributed !== null) {
    // The unseen-attacker arm: the body cannot see the mob, but the server told
    // it WHERE the damage came from. The destinations are the sensor's own cells
    // for exactly that origin (`escapeCells` + `threatCoverCells` are built from
    // it, see `state.ts#buildEscapeCells`), and the qualification threshold is
    // the unseen one - a distant origin can only be answered laterally, so cover
    // (real block truth) is the load-bearing fact. With a SENSED hostile the
    // measured threshold and behaviour are unchanged.
    //
    // An ATTACKER takes precedence over the hazard BLOCK here: the hazard escape
    // has its own owner (`envHazardEscapeCandidates`, offered every tick), and a
    // destination measured from a hazard block while an attacker is known would
    // have no relation to that attacker at all.
    const unseen = hostile === null
    return selectKeepDistanceSpots({
      self: state.self.position,
      threat: hostile?.position ?? attributed?.position ?? state.self.position,
      standable: standableUsable,
      escapeCells: (state.terrain.escapeCells ?? []).filter(usable),
      // The two CAN facts the sensor owns for this threat (real block truth):
      // the cells its sight line cannot reach (cover - the only thing that
      // answers a ranged attacker in a room) and the cells where standing
      // realizes a dimension transfer (never a keep-distance destination).
      occludedCells: (state.terrain.threatCoverCells ?? []).filter(usable),
      transferCells: state.terrain.portalWalkInCells ?? [],
      standoff: threatStandoffRange(hostile?.name ?? attributed?.name ?? 'unknown'),
      ...(additionalThreats.length === 0 ? {} : { additionalThreats }),
      ...(unseen ? { minGain: UNSENSED_MIN_KEEP_DISTANCE_GAIN } : {}),
      max: MAX_RETREAT_CANDIDATES,
    })
  }
  // Hazard-only (or critical-health-with-no-sensed-hostile): unchanged semantics
  // - the destination must clear the hazard radius. A dimension-transfer cell is
  // still never a destination: a hazard escape must not leave the dimension.
  const transfer = new Set((state.terrain.portalWalkInCells ?? []).map((cell) => blockId('p', cell)))
  const scored: KeepDistanceSpot[] = []
  for (const spot of standableUsable) {
    if (transfer.has(blockId('p', spot))) continue
    const separation = distance(spot, threat)
    if (separation < HAZARD_DANGER_RADIUS) continue
    scored.push({
      spot,
      separation,
      gain: separation - distance(state.self.position, threat),
      outsideReach: true,
      escape: false,
      occluded: false,
    })
  }
  scored.sort((a, b) => b.separation - a.separation)
  return scored.slice(0, MAX_RETREAT_CANDIDATES)
}

/**
 * Exploration target when the subgoal produced nothing.
 *
 * Two properties are required and both were bugs before:
 *  1. the NEAREST useful standable target is preferred (the old farthest-first
 *     pick oscillated between two spots 181x/180x and never made progress);
 *  2. when the subgoal resource is known, the spot that most reduces the
 *     distance to that resource is preferred, so exploring walks toward the
 *     resource beyond the move band instead of wandering away from it.
 */
function pickExplore(
  state: WorldState,
  standable: Vec3Json[],
  focusItem: string | null,
  moveFailureLimit: number,
  blacklistedMoveTargets: ReadonlySet<string> | undefined,
): Vec3Json | null {
  const options = standable.filter(
    (spot) =>
      distance(spot, state.self.position) > STRANDED_FRONTIER_DISTANCE &&
      !isBlacklistedMoveTarget(state, blacklistedMoveTargets, spot) &&
      failureCount(state.signals.failedCandidates, `MOVE:${blockId('p', spot)}`) < moveFailureLimit,
  )
  if (options.length === 0) return null

  const resourcePosition = explorationResourcePosition(state, focusItem, blacklistedMoveTargets)
  if (resourcePosition !== null) {
    const currentDistance = distance(state.self.position, resourcePosition)
    let best: Vec3Json | null = null
    let bestScore = Number.POSITIVE_INFINITY
    for (const spot of options) {
      const toResource = distance(spot, resourcePosition)
      if (toResource >= currentDistance) continue
      const score = toResource + distance(spot, state.self.position) * 0.1
      if (score < bestScore) {
        bestScore = score
        best = spot
      }
    }
    if (best !== null) return best
  }

  let best: Vec3Json | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const spot of options) {
    const d = distance(spot, state.self.position)
    if (d < bestDistance) {
      bestDistance = d
      best = spot
    }
  }
  return best
}

function isBlacklistedMoveTarget(
  state: Pick<WorldState, 'self'>,
  blacklistedMoveTargets: ReadonlySet<string> | undefined,
  position: Vec3Json,
): boolean {
  return blacklistedMoveTargets?.has(moveFailureKey(state.self.dimension, position)) ?? false
}

/**
 * The facts that make an exploration MOVE a PRODUCER SEARCH rather than generic
 * wandering: which item the active collect focus wants, which mobs produce it,
 * and whether the live context was actually read.
 *
 * This is the search objective a `collect <mob drop>` need grounds when no
 * producer instance is sensed. It travels on the SAME `meta.explore` MOVEs the
 * generic exploration arm already offers - the arm is reused, never forked - so
 * code adds no route, no ranking and no new locomotion mechanism; it only makes
 * the existing search state WHY it is being run.
 */
export interface ProducerSearchFacts {
  item: string
  producers: string[]
  spawnContext: MobDropSpawnContext | null
}

/** Candidate-meta projection of {@link ProducerSearchFacts}, or nothing when null. */
function producerSearchMeta(
  facts: ProducerSearchFacts | null,
): Record<string, string | boolean | number> {
  if (facts === null) return {}
  const context = facts.spawnContext
  return {
    producerSearch: true,
    producerItem: facts.item,
    producerMobs: JSON.stringify(facts.producers),
    ...(context === null
      ? { producerSpawnContext: 'none' }
      : {
          producerSpawnContext: context.reason,
          producerSpawnMobs: JSON.stringify(context.mobs),
          producerSpawnDimensions: JSON.stringify(context.dimensions),
          producerSpawnSearchGrounded: context.searchGrounded,
        }),
  }
}

/**
 * The producer SEARCH facts for the active collect focus, or null when the tick
 * is not a search for a mob-drop producer.
 *
 * Null whenever a producer IS sensed (the hunt route owns that situation and the
 * search is over), whenever the focus has no declared producer, and whenever the
 * context verdict says a search here can never succeed (`dimension_unmet`).
 * Pure.
 */
function producerSearchFacts(state: WorldState): ProducerSearchFacts | null {
  const current = state.goalQueue?.current ?? null
  const goalKind = current?.kind ?? 'collect'
  const focusItem = current?.targetItem ?? state.goal.targetItem ?? null
  if (focusItem === null || goalKind !== 'collect') return null
  const producerNames = MOB_DROP_PRODUCERS[focusItem]
  if (producerNames === undefined) return null
  if (state.entities.some((entity) => producerNames.has(entity.name))) return null
  const producers = [...producerNames].sort()
  const spawnContext = mobDropSpawnContextFor(state, producers)
  if (spawnContext !== null && !spawnContext.searchGrounded) return null
  return { item: focusItem, producers, spawnContext }
}

function exploreMoveCandidate(
  state: WorldState,
  options: CandidateOptions,
  spot: Vec3Json,
  label: string,
  logRoute: LogRouteMode | null,
  producerSearch: ProducerSearchFacts | null = null,
): Candidate {
  return {
    id: `MOVE:${blockId('p', spot)}`,
    kind: 'MOVE',
    label,
    targetName: null,
    target: spot,
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: distance(spot, state.self.position) <= options.reach,
    hasStandableAdjacent: true,
    meta: {
      tick: state.tick,
      x: spot.x,
      y: spot.y,
      z: spot.z,
      // Grounded exploration marker: this MOVE is a search body-change toward
      // unexplored terrain, not a route to a sensed source. The typed no-source
      // gap reads it to report `next=explore` instead of `next=escalate`.
      explore: true,
      ...(logRoute === null ? {} : { [LOG_ROUTE_META]: logRoute }),
      // The producer SEARCH facts, when this search exists because the active
      // collect focus declared a mob producer nobody has sensed yet. Fully
      // generic across mob drops (the facts come from `MOB_DROP_PRODUCERS` and
      // `MOB_SPAWN_CONTEXTS`, never from a mob/item name here) and honest about
      // whether the context was actually measured.
      ...producerSearchMeta(producerSearch),
    },
  }
}

/**
 * Grounded exploration alternatives for a state whose subgoal produced no route.
 *
 * The stock fallback offered a single `pickExplore` MOVE, so Jev saw
 * `presented=2` (WAIT + one action) or `presented=1` (WAIT only) and its choice
 * carried no information: live `collect 1 x flint (from gravel)` logged
 * `CANDIDATE_STARVATION presented=2 productive=0` x21 and `presented=1` x6 while
 * Jev was invoked 120x. Enumerate up to `maxMoveCandidates` DISTINCT,
 * mechanically grounded frontier cells (the nearest-first `pickExplore` pick
 * first, then the remaining nearest frontier cells with a deterministic
 * coordinate tie-break) so Jev pi has a real decision.
 *
 * Enumeration only: this adds valid actions, it does not rank, replace or
 * suppress any existing candidate. The reachability gate still withholds any
 * cell the body cannot actually reach, so "grounded" stays code-owned.
 */
/**
 * #405: drop standable spots the body has already visited from the exploration
 * fallback. `exploredCells` is a controller-owned bounded LRU of occupied cells; a
 * cell the body has stood on is not "unexplored terrain". An empty result is a real
 * fact (no novel frontier in sensor range) and the caller already has a typed
 * blocked/exhausted path for it, which is better than an unbounded A-B-A-B walk.
 */
export function exploreNoveltySpots(
  spots: readonly Vec3Json[],
  exploredCells: ReadonlySet<string> | undefined,
): Vec3Json[] {
  if (exploredCells === undefined || exploredCells.size === 0) return [...spots]
  return spots.filter((spot) => !exploredCells.has(exploredCellKey(spot)))
}

/**
 * #405: the ONE identity for "the body occupied this cell", shared by the controller
 * (which records it) and the exploration filter (which reads it). It floors because a
 * body position is fractional (`36.5`) while a standable spot is a block cell, so the
 * identity must not depend on the caller's coordinate form.
 */
export function exploredCellKey(position: Vec3Json): string {
  return `p${Math.floor(position.x)}_${Math.floor(position.y)}_${Math.floor(position.z)}`
}

function exploreFallbackCandidates(
  state: WorldState,
  options: CandidateOptions,
  focusItem: string | null,
  goalKind: string,
): Candidate[] {
  const moveFailureLimit = options.moveFailureLimit ?? DEFAULT_CANDIDATE_MOVE_FAILURE_LIMIT
  const limit = Math.max(1, options.maxMoveCandidates ?? DEFAULT_MAX_MOVE_CANDIDATES)
  const novel = exploreNoveltySpots(state.terrain.standable, state.signals.exploredCells)
  const best = pickExplore(
    state,
    novel,
    focusItem,
    moveFailureLimit,
    options.blacklistedMoveTargets,
  )
  if (best === null) return []
  const logRoute = focusWantsLog(goalKind, focusItem) ? 'explore' : null
  // A `collect <mob drop>` focus with no sensed producer turns these same
  // frontier MOVEs into a producer SEARCH: the route is unchanged (reused, not
  // forked), and the facts say which item/mobs the search is for and whether the
  // body's own spawn context was actually measured.
  const producerSearch = producerSearchFacts(state)
  const out = [
    exploreMoveCandidate(
      state,
      options,
      best,
      moveLabel(best, 'walk toward unexplored terrain', state.self.position),
      logRoute,
      producerSearch,
    ),
  ]
  const bestKey = blockId('p', best)
  const alternatives = novel
    .filter(
      (spot) =>
        blockId('p', spot) !== bestKey &&
        distance(spot, state.self.position) > 1.5 &&
        !isBlacklistedMoveTarget(state, options.blacklistedMoveTargets, spot) &&
        failureCount(state.signals.failedCandidates, `MOVE:${blockId('p', spot)}`) < moveFailureLimit,
    )
    .sort(
      (a, b) =>
        distance(a, state.self.position) - distance(b, state.self.position) ||
        a.x - b.x ||
        a.y - b.y ||
        a.z - b.z,
    )
  for (const spot of alternatives) {
    if (out.length >= limit) break
    out.push(
      exploreMoveCandidate(
        state,
        options,
        spot,
        moveLabel(spot, 'walk toward unexplored terrain', state.self.position),
        logRoute,
        producerSearch,
      ),
    )
  }
  return out
}

/**
 * The `explore` leg of a log route: the nearest standable frontier that reduces
 * the distance to the nearest sensed/remembered log bearing. Used by the gate
 * when every log MINE/MOVE/RETRIEVE this tick was withheld, so the policy still
 * has a body change instead of a stationary non-yield MINE.
 */
function logExploreCandidates(state: WorldState, options: CandidateOptions): Candidate[] {
  const currentFocus = state.goalQueue?.current?.targetItem ?? state.goal.targetItem ?? null
  // A prerequisite log can sit behind a craft goal (`craft wooden_pickaxe`
  // needs a log), so the active focus is often not log-class. Bias the
  // exploration heuristic on the resource class the fallback can actually find
  // instead of asking it to match blocks against `wooden_pickaxe`.
  //
  // #341 made `retrievalNeeds` active-row-only, so the queued prerequisite no
  // longer appears there and must NOT be recovered from the queue (that was the
  // leak #341 removed). This fallback is only reached for a log need
  // (`logCollectGoal` or a withheld log route), so the class is already known:
  // aim at the log bearing directly. Search-direction only - it never
  // authorizes a retrieval for another item.
  const focusItem = retrievalWant(currentFocus)?.kind === 'log' ? currentFocus : 'log'
  const spot = pickExplore(
    state,
    state.terrain.standable,
    focusItem,
    options.moveFailureLimit ?? DEFAULT_CANDIDATE_MOVE_FAILURE_LIMIT,
    options.blacklistedMoveTargets,
  )
  if (spot === null) return []
  return [
    exploreMoveCandidate(
      state,
      options,
      spot,
      moveLabel(spot, 'explore toward the log bearing', state.self.position),
      'explore',
    ),
  ]
}

// --- affordance gate (#11 v2): only mechanically reachable targets are presented
//
// Candidates are FACTS provided to Jev, so a locomotion target the body cannot
// physically reach with its current inventory/abilities must not be offered at
// all. The gate evaluates each MOVE/RETRIEVE/RETREAT target through the pure
// reachability module, withholds the infeasible ones with a typed reason and
// missing-capability list, offers the grounded capability-acquisition candidates
// that would fix them, and suppresses a proven-unreachable target while its
// semantic state fingerprint is unchanged.

const LOCOMOTION_GATED_KINDS: ReadonlySet<CandidateKind> = new Set<CandidateKind>([
  'MOVE',
  'RETRIEVE',
  'RETREAT',
  // ENTER_PORTAL walks the body to a named cell (the portal interior), so it is a locomotion
  // candidate like the others: without it here the entry was offered even when the body could not
  // route to it, and the live run re-armed `ENTER:26,67,9` (outcome=noPath/stuck) while the MOVE
  // steps that would have advanced the body were passed over. A destination that cannot be reached
  // is withheld with the same typed reason every other locomotion candidate uses, so the ordinary
  // MOVE/vertical candidates drive the body instead.
  'ENTER_PORTAL',
  // PICKUP walks the body onto a sensed dropped item entity. It is locomotion to
  // a concrete world position like RETRIEVE, so it inherits the same reachability
  // contract: an item the body cannot route to is withheld with the same typed
  // reason (never offered as a route that cannot be walked).
  'PICKUP',
])

/**
 * Candidate-local capability attribution, by kind:
 *   MINE              -> the harvest tool tier of the block IT names;
 *   MOVE/RETRIEVE/
 *   RETREAT           -> path/vertical feasibility of ITS OWN destination;
 *   CRAFT/PLACE/SMELT -> not gated: the generator emits them only when their
 *                        own recipe/input/station requirement is satisfiable
 *                        NOW, so they must never inherit a sibling's tool need.
 */
/** Beyond this range a `no_path` probe is not evidence of a local blockage. */
export const FAR_LEG_PROBE_RADIUS = 24

const REACHABILITY_GATED_KINDS: ReadonlySet<CandidateKind> = new Set<CandidateKind>([
  'MINE',
  ...LOCOMOTION_GATED_KINDS,
])

export interface ColumnFacts {
  placeable: ReturnType<typeof selectPlaceableBlock>
  columnSafe: boolean
  footingSolid: boolean
  headroomClear: boolean
  headroomCell: Vec3Json | null
}

/**
 * The cells a candidate's OWN execution will BREAK, read from the same
 * declaration the executor reads - never a cell the candidate does not name.
 *
 *   - `meta.digCells` is the descent/branch dig plan the executor parses itself
 *     (`executor.descentDigCellsFromMeta`: `"x,y,z;x,y,z"`, passage cells first,
 *     primary last), so the offered shape and the checked shape cannot drift;
 *   - an arm whose TARGET is the block it breaks (`MINE`, `STEP`, and the
 *     `DESCEND` leg `runDescend` calls the same parser for) has no plan meta, and
 *     the executor's own fallback for that case is the target - mirrored here.
 *
 * A candidate that declares no dig returns [] and is untouched by the gate.
 */
export function declaredDigCells(candidate: Candidate): Vec3Json[] {
  const cells: Vec3Json[] = []
  const seen = new Set<string>()
  const push = (cell: Vec3Json): void => {
    const key = `${cell.x},${cell.y},${cell.z}`
    if (seen.has(key)) return
    seen.add(key)
    cells.push(cell)
  }
  const raw = candidate.meta.digCells
  if (typeof raw === 'string' && raw.length > 0) {
    for (const part of raw.split(';')) {
      const [x, y, z] = part.split(',').map((value) => Number(value))
      if (x === undefined || y === undefined || z === undefined) continue
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue
      push({ x, y, z })
    }
    // The executor returns the PARSED plan when the meta carries one; the target
    // is only its fallback, so it must not be added beside a real plan.
    if (cells.length > 0) return cells
  }
  if (DIG_TARGET_KINDS.has(candidate.kind) && candidate.target !== null) push(candidate.target)
  return cells
}

/** The kinds whose own `target` is the block their execution breaks. */
const DIG_TARGET_KINDS: ReadonlySet<CandidateKind> = new Set<CandidateKind>(['MINE', 'STEP', 'DESCEND'])

/**
 * THE DIG-TOOL GATE: the first block a candidate's own execution must break whose
 * harvest requirement the inventory cannot satisfy, or null.
 *
 * THE PROPERTY IT PINS (measured live, run-mudkuea9-124kk gen-mudkuerj-8ehpqk):
 * a candidate whose execution requires a tool the body lacks must be WITHHELD
 * with `missing_tool` BEFORE it is leased, and the acquisition route (or the
 * typed refusal naming item+count) is offered instead - for EVERY dig arm, not
 * only the headroom clearance.
 *
 *   `SKILL_END actionId=STEP:S:b23_80_8 outcome=CAPABILITY_LOST
 *    failure=dig_no_tool policyBoundary=true`
 *
 * was that contract being violated by the step-cut arm: it derived the cell's
 * harvest truth from the scanner's RESOURCE index (`state.blocks`), which does
 * not carry terrain, so the cut cell resolved to "no tool required", the STEP
 * was offered without a reachability verdict (STEP is not a locomotion kind) and
 * the body only discovered the missing pickaxe inside the executor
 * (`executor.requireHarvestTool` -> `dig_no_tool`).
 *
 * Enforcing it HERE, at the single gate every candidate passes through, is what
 * makes it hold for every arm rather than for the arm that happened to be
 * measured: the withholding is `missing_tool` on the cell's REAL harvest truth
 * (`cellHarvestBarrier`), so the acquisition pass answers it with a
 * `{kind:'tool'}` route exactly as it does for a MINE.
 *
 * Applied only to kinds the reachability contract does not already judge: `MINE`
 * and the locomotion family keep their existing verdicts byte-for-byte, and a
 * candidate whose tool IS held falls through to its historical behaviour.
 */
function declaredDigToolRefusal(
  state: WorldState,
  candidate: Candidate,
): { barrier: ReachabilityBarrier; capability: Capability } | null {
  // This typed action removes a known blocker without requiring its drop. Its
  // candidate was already grounded from the sensor's `safe`/`diggable` fact;
  // harvest-tool acquisition is relevant only to resource-yield actions.
  if (candidate.meta.clearance === true) return null
  for (const cell of declaredDigCells(candidate)) {
    const barrier = cellHarvestBarrier(state, cell)
    if (barrier === null) continue
    const capability = missingToolCapability(barrier, state.inventory.counts)
    if (capability !== null) return { barrier, capability }
  }
  return null
}

interface ReachabilityGateContext {
  state: WorldState
  options: CandidateOptions
  memory: StateFingerprintMemory | null
  column: ColumnFacts
}

/**
 * The active collect goal's focus item when that item names a DECLARED producer
 * (a name-scanned block source or a mob drop producer). Null for every other
 * goal: a goal without a declared producer has no "search for the source"
 * contract, so it must not be reported as explore-blocked.
 */
function declaredProducerFocus(state: WorldState): string | null {
  const current = state.goalQueue?.current ?? null
  const kind = current?.kind ?? 'collect'
  if (kind !== 'collect') return null
  const focus = current?.targetItem ?? state.goal.targetItem ?? null
  if (focus === null) return null
  // The `food` resource class is a declared-producer focus: its producers are the
  // passive FOOD_ANIMALS. Without this, a food collect goal where no animal is
  // sensed has no declared-producer contract and the tick stalls silently
  // (live: health=1, `collect:food 0/3`, only WAIT/DESCEND zero-progress).
  if (focus === FOOD_CLASS) return focus
  if (isResourceClass(focus)) return null
  if (DIRECT_BLOCK_SOURCES[focus] === undefined && MOB_DROP_PRODUCERS[focus] === undefined) return null
  return focus
}

/**
 * Pure CAN fact: does the OFFERED set ground a route to the declared producer of
 * the active collect focus? Uses the same route predicate as the exploration
 * fallback trigger (`hasAdvancingGoalRoute`), so the marker can never disagree
 * with the set it describes. Null when the goal is not a declared-producer
 * collect or already has a route.
 */
function exploreRouteBlockedFact(
  state: WorldState,
  candidates: readonly Candidate[],
  withheld: readonly CandidateReachability[],
): ExploreRouteBlocked | null {
  const item = declaredProducerFocus(state)
  if (item === null) return null
  if (candidates.some(hasAdvancingGoalRoute)) return null
  const movementWithheld = withheld.some(
    (entry) =>
      entry.candidate.kind === 'MOVE' || entry.candidate.kind === 'RETRIEVE' || entry.candidate.kind === 'PICKUP',
  )
  const frontierExists = !strandedOnColumn(state)
  const reason: ExploreRouteBlockedReason = movementWithheld
    ? 'unreachable'
    : frontierExists
      ? 'exhausted'
      : 'no_frontier'
  return { goal: `collect:${item}`, item, reason }
}

export function applyReachabilityGate(
  raw: readonly Candidate[],
  state: WorldState,
  options: CandidateOptions = defaultCandidateOptions,
  placeRefusal: PlaceRefusal | null = null,
  ignitionRefusal: IgnitionRefusal | null = null,
  entryRefusal: PortalEntryRefusal | null = null,
  armorRefusals: ArmorRefusal[] = [],
  surfaceAscentRefusal: SurfaceAscentRefusal | null = null,
  foodHabitatRefusal: SurfaceAscentRefusal | null = null,
  sourceExclusions: ResourceSourceExclusion[] | null = null,
  columnDescentRefusal: ColumnDescentRefusal | null = null,
  prospectRefusal: ProspectRefusal | null = null,
  digRefusals: DigRouteRefusalSink = [],
  /**
   * Typed `HUNT_CONTACT_UNREACHABLE` refusals the generator already derived (see
   * `GroundedCandidatesResult.contactRefusals`). Appended at the END of the
   * parameter list so every existing positional caller keeps its meaning; the
   * gate does not re-derive them - it re-derives the GEOMETRY per candidate,
   * which is what decides the withhold, and carries the generator's typed
   * refusal out as evidence.
   */
  contactRefusals: ContactRefusal[] = [],
  containerRefusals: ContainerRefusal[] = [],
  /**
   * Typed `ARMOR_CRAFT_REFUSED` shortfalls the generator already derived (see
   * `GroundedCandidatesResult.armorCraftRefusals`). Appended at the END of the
   * parameter list so every existing positional caller keeps its meaning; the
   * gate does not re-derive them (they are world truth about the carried
   * material, not a property of any candidate).
   */
  armorCraftRefusals: ArmorCraftRefusal[] = [],
): GroundedCandidatesResult {
  // Direct callers (fixtures) may pass only raw candidates; derive the typed
  // exclusions from the world state so the marker can never be dropped.
  const exclusions = sourceExclusions ?? resourceSourceExclusions(state)
  const context: ReachabilityGateContext = {
    state,
    options,
    memory: options.reachability?.memory ?? null,
    column: columnFacts(state),
  }
  let presented: Candidate[] = []
  const reachability: CandidateReachability[] = []
  const withheld: CandidateReachability[] = []

  const run = (candidates: readonly Candidate[]): void => {
    for (const candidate of candidates) {
      const record = evaluateCandidate(candidate, context)
      if (record === null) {
        presented.push(withAffordance(candidate, null))
        continue
      }
      reachability.push(record)
      if (record.result.reachable) {
        context.memory?.forget(candidate.id)
        presented.push(record.candidate)
        continue
      }
      record.withheld = true
      record.suppressed = context.memory?.isSuppressed(candidate.id, record.fingerprint) ?? false
      context.memory?.record(candidate.id, record.fingerprint, record.result.reason)
      withheld.push(record)
    }
  }

  run(raw)
  // The explicit `unreachableStations` set arrives from the controller's PREVIOUS
  // tick (its withheld ids). On the tick a station FIRST fails the gate it is
  // still treated as usable, so the duplicate-craft guard suppresses the very
  // craft that could acquire the missing capability, and the acquisition pass
  // offers nothing: the measured `presented=[WAIT, ESCALATE]` starvation
  // (run-mubobiq6-12onv). Treat this pass's own refused station retrieves as
  // retired so the enabling craft is offered in the SAME decision.
  //
  // The enabling chain can itself add a refused station retrieve (to craft a
  // pickaxe the step is `walk to the remembered table`; that walk is withheld for
  // the very capability being acquired), so the retirement set is closed in
  // bounded passes over the acquisition output. Each pass can only add distinct
  // station cells, so the loop terminates.
  let retired = retiredStationsFromWithheld(withheld)
  let acquisitionOptions = optionsWithRetiredStations(options, retired)
  // The acquisition evidence, per missing-capability key: the grounded routes
  // enumerated for it, or the typed reason none exists. Filled by the passes and
  // attached to the withheld entry it belongs to, so `CANDIDATE_ACQUISITION` /
  // `CANDIDATE_ACQUISITION_REFUSED` name the SAME facts the offer was built from.
  const acquisitionRoutes = new Map<string, string[]>()
  const acquisitionRefusals = new Map<
    string,
    { reason: AcquisitionRefusalReason; item: string | null; count: number | null; cell?: Vec3Json | null }
  >()
  // The acquisition closure is over CAPABILITIES, not only over station
  // retirement. A withheld fact is often answered by a route that is itself
  // withheld for a second, deeper fact - clearing the jump cell needs a tool, the
  // tool needs a material, the material needs a station. Each pass can introduce
  // such a fact, so the loop continues while the capability set grows (bounded by
  // the same MAX_ACQUISITION_RETIRE_PASSES), and the closed set is monotone, so
  // it terminates.
  let expandedCapabilities = new Set(
    withheld.flatMap((entry) => entry.result.missingCapabilities.map(capabilityKey)),
  )
  for (let pass = 0; pass < MAX_ACQUISITION_RETIRE_PASSES; pass += 1) {
    const seen = new Set([
      ...presented.map((candidate) => candidate.id),
      ...withheld.map((entry) => entry.candidate.id),
    ])
    const acquired = capabilityAcquisitionCandidates(state, acquisitionOptions, withheld, seen, digRefusals)
    run(acquired.candidates)
    for (const [key, ids] of acquired.routes) {
      acquisitionRoutes.set(key, [...(acquisitionRoutes.get(key) ?? []), ...ids])
      acquisitionRefusals.delete(key)
    }
    for (const [key, refusal] of acquired.refusals) {
      if (!acquisitionRoutes.has(key)) acquisitionRefusals.set(key, refusal)
    }
    const next = retiredStationsFromWithheld(withheld)
    const capabilities = new Set(
      withheld.flatMap((entry) => entry.result.missingCapabilities.map(capabilityKey)),
    )
    const grewCapability = [...capabilities].some((key) => !expandedCapabilities.has(key))
    expandedCapabilities = capabilities
    if (!grewCapability && next.size === retired.size) break
    retired = next
    acquisitionOptions = optionsWithRetiredStations(options, retired)
  }
  // Attach the evidence to the withheld candidate whose fact it answers. This is
  // observability only: the candidate stays withheld exactly as before.
  for (const entry of withheld) {
    if (entry.result.missingCapabilities.length === 0) continue
    entry.acquisition = entry.result.missingCapabilities.map((capability) => {
      const key = capabilityKey(capability)
      const routes = acquisitionRoutes.get(key) ?? []
      const refusal = routes.length > 0 ? null : acquisitionRefusals.get(key) ?? null
      const item = refusal?.item ?? null
      return {
        missing: key,
        routes,
        reason: refusal?.reason ?? null,
        item,
        count: refusal?.count ?? null,
        held: item === null ? null : (state.inventory.counts[item] ?? 0),
        cell: refusal?.cell ?? null,
        tools: toolStateForCapabilities(state, [capability]),
      }
    })
  }

  // A log-class collect goal must never be left with a stationary non-yield
  // MINE as its only productive action (live wedge on 7acd849: `MINE:b30_35_35`
  // stone ceiling, 30x dig_timeout, chosen 25x). When every log MINE/MOVE/
  // RETRIEVE this tick was withheld, offer the exploration MOVE so the policy
  // still has a body change that can lead to a log. The same condition also
  // applies when a prerequisite log route is withheld while the CURRENT goal
  // is a craft (for example `craft wooden_pickaxe`): the craft goal itself is
  // not a `collect log`, but WAIT cannot acquire the missing ingredient.
  const withheldLogRoute = withheld.some(
    (entry) =>
      entry.candidate.meta.resourceKind === 'log' ||
      (entry.candidate.kind === 'MINE' && isLogMine(entry.candidate)),
  )
  if ((logCollectGoal(state) || withheldLogRoute) && !presented.some(carriesLogRoute)) {
    const seen = new Set([...presented.map((candidate) => candidate.id), ...withheld.map((entry) => entry.candidate.id)])
    run(logExploreCandidates(state, options).filter((candidate) => !seen.has(candidate.id)))
  }

  // Last-resort candidate-local ladder: one unreachable remembered station must
  // not starve a craft goal whose own recipe inputs are all held - the step that
  // crafts/places the station from those inputs is satisfiable NOW. EQUIP is a
  // local self-care action like WAIT/ESCALATE here: offering it must never hide
  // the inputs-held craft step from Jev.
  if (
    presented.every(
      (candidate) =>
        candidate.kind === 'WAIT' || candidate.kind === 'ESCALATE' || candidate.kind === 'EQUIP',
    )
  ) {
    const seen = new Set([...presented.map((candidate) => candidate.id), ...withheld.map((entry) => entry.candidate.id)])
    run(selfContainedCraftCandidates(state, acquisitionOptions).filter((candidate) => !seen.has(candidate.id)))
  }

  // A generic route-opening candidate is an enabling alternative only while
  // the active goal has no grounded route of its own.  Once a direct goal
  // candidate is reachable (the live case was RETRIEVE:known:log), keeping
  // capability-acquisition MOVEs in the same set lets Jev abandon the goal
  // route for a local tunnel and repeatedly jump/pillar without progress.
  // This is a candidate-validity envelope, not a semantic preference: when no
  // direct route exists, all grounded recovery families remain available.
  // Ordinary ATTACK/RETREAT/EAT are local safety/control actions. Their presence
  // says nothing about whether the active semantic goal has a grounded route.
  // A goalDrop ATTACK is the exception: it is a direct grounded producer route
  // for the current collect Option, so route-opening prerequisites may retire.
  // A `foodRoute=animal` ATTACK is the same kind of route for the food goal.
  const hasGroundedGoalRoute = presented.some(
    (candidate) =>
      candidate.kind !== 'WAIT' &&
      candidate.kind !== 'ESCALATE' &&
      (candidate.kind !== 'ATTACK' ||
        typeof candidate.meta.goalDrop === 'string' ||
        candidate.meta.foodRoute === 'animal') &&
      candidate.kind !== 'RETREAT' &&
      candidate.kind !== 'EAT' &&
      candidate.kind !== 'EQUIP' &&
      candidate.meta.capabilityAcquisition !== true &&
      candidate.meta.clearance !== true,
  )
  if (hasGroundedGoalRoute) {
    presented = presented.filter(
      (candidate) =>
        !(
          candidate.meta.capabilityAcquisition === true &&
          (candidate.meta.missingCapability === 'open_path' || candidate.meta.missingCapability === 'standable_approach')
        ),
    )
  }

  const waite = presented.filter((candidate) => candidate.kind === 'WAIT' || candidate.kind === 'ESCALATE')
  const productive = presented.filter((candidate) => candidate.kind !== 'WAIT' && candidate.kind !== 'ESCALATE')
  const candidates = [...productive, ...waite]
  if (
    withheld.length > 0 &&
    productive.length === 0 &&
    !waite.some((candidate) => candidate.kind === 'ESCALATE')
  ) {
    candidates.push(escalateRefusal(state, withheld))
  }
  return {
    candidates,
    reachability,
    withheld,
    placeRefusal,
    ignitionRefusal,
    entryRefusal,
    armorRefusals,
    // Filled by `generateGroundedCandidates` from the OFFERED set, like the
    // survival gaps below: an offer the reachability gate withheld must not be
    // reported as grounded CAN.
    armorCraftOffers: [],
    armorCraftRefusals,
    surfaceAscentRefusal,
    foodHabitatRefusal,
    columnDescentRefusal,
    contactRefusals,
    prospectRefusal,
    digRefusals: dedupeDigRouteRefusals(digRefusals),
    containerRefusals,
    sourceExclusions: exclusions,
    exploreRouteBlocked: exploreRouteBlockedFact(state, candidates, withheld),
    sourceGap: resourceSourceGapFor(state, candidates, exclusions),
    // Filled by `generateGroundedCandidates` from the OFFERED set, once the gate
    // has finished; the raw gate has no survival fact of its own.
    foodGap: null,
    mobDropGap: null,
    combatKitGap: null,
  }
}

/**
 * SAFE/CAN: a mechanical locomotion leg must never be realized as a DIMENSION
 * TRANSFER.
 *
 * Measured live (`run-mucgir1z-1p7oh`): a skeleton engaged the body at ~9 m in
 * the Nether portal room, the grounded keep-distance cells were cells of the
 * portal, and "move away from the threat" was realized as a dimension change -
 * `the_nether -> overworld -> the_nether` 186 times, 30-90 s apart, each
 * re-entry walking straight back to the same skeleton. Crossing a dimension is
 * not a way to keep distance; it abandons the whole objective, and in this
 * geometry it guarantees the loop.
 *
 * The fact is code-owned and two-sided, so it cannot be dodged by choosing a
 * different route:
 *   * DESTINATION: the cell the body would stand in is a live transfer cell
 *     (`state.terrain.portalWalkInCells`, sampled from real block truth).
 *   * ROUTE: the path the body would actually walk to the destination stands it
 *     in one (`reachability.dimensionTransferProbe`; the controller answers it
 *     from the same pathfinder plan `pathProbe` already computes).
 *
 * `ENTER_PORTAL` is deliberately exempt: it IS the explicit dimension-transfer
 * decision (`Jev`/System2 owns WHICH), walks into a portal the goal names, and
 * is the only candidate whose purpose is to cross. `MINE` and the remaining
 * gated kinds are not body-locomotion realizations and keep their own contracts.
 */
const MECHANICAL_LOCOMOTION_KINDS: ReadonlySet<CandidateKind> = new Set<CandidateKind>([
  'MOVE',
  'RETRIEVE',
  'RETREAT',
  // A pickup is a walk to a cell, so it is subject to the dimension-transfer
  // refusal like every other mechanical locomotion realization: routing onto a
  // lit portal plane to reach an item would CROSS a dimension, and no goal item
  // is worth an unauthorized transfer. Leaving PICKUP out of this set would have
  // exempted it from the one safety check the locomotion family shares.
  'PICKUP',
])

function dimensionTransferRefusal(
  candidate: Candidate,
  position: Vec3Json,
  context: ReachabilityGateContext,
): ReachabilityResult | null {
  if (!MECHANICAL_LOCOMOTION_KINDS.has(candidate.kind)) return null
  const key = blockId('p', position)
  const onTransferCell = (context.state.terrain.portalWalkInCells ?? []).some((cell) => blockId('p', cell) === key)
  if (onTransferCell) return { reachable: false, reason: 'crosses_dimension', missingCapabilities: [] }
  const probe = context.options.reachability?.dimensionTransferProbe
  if (typeof probe !== 'function') return null
  return probe(position) === 'crosses'
    ? { reachable: false, reason: 'crosses_dimension', missingCapabilities: [] }
    : null
}

/** null when the candidate carries no capability precondition of its own. */
function evaluateCandidate(
  candidate: Candidate,
  context: ReachabilityGateContext,
): CandidateReachability | null {
  const position = candidate.target
  if (position === null) return null
  // A submersion waypoint is a vertical swim target through a sensor-verified
  // water/air column. The pinned pathfinder cannot express swimming and will
  // report no-path for valid routes; the specialized Guard and Executor re-read
  // and realize this exact column, so do not apply the ordinary ground route
  // solver or pathProbe here.
  if (candidate.meta.submersionEscape === true) {
    return null
  }
  // A plain survival ATTACK is locomotion too: outside contact range the executor
  // must first GoalFollow the entity into melee. The live portal run repeatedly
  // advertised a skeleton 7.83m away through sealed terrain as the ONLY
  // executable action; every 2.2s lease then failed `out_of_reach`. Gate that
  // mechanical approach here. Goal-directed mob/food hunts keep their dedicated
  // longer/re-acquisition executor contract and are intentionally unchanged.
  if (candidate.kind === 'ATTACK') return evaluateOrdinaryAttackCandidate(candidate, context)
  if (!REACHABILITY_GATED_KINDS.has(candidate.kind)) {
    // THE DIG-TOOL GATE for every arm the locomotion contract does not judge
    // (STEP, and any descent/branch dig leg): a candidate that must break a block
    // the inventory cannot harvest is withheld `missing_tool` here, BEFORE it can
    // be leased, so the acquisition pass answers the missing tool with a craft or
    // collect route (or the typed refusal). A candidate whose tool is held, and a
    // candidate that breaks nothing, fall through to the historical behaviour.
    const dig = declaredDigToolRefusal(context.state, candidate)
    if (dig === null) return null
    const digTarget: ReachabilityTarget = {
      ...reachabilityTargetFor(context.state, candidate),
      barrier: dig.barrier,
    }
    const digWorld = reachabilityWorldFor(context.state, candidate, context.options.reach, context.column)
    return reachabilityRecord(
      candidate,
      digTarget,
      digWorld,
      { reachable: false, reason: 'missing_tool', missingCapabilities: [dig.capability] },
      context,
    )
  }
  // SAFE: a dimension transfer is not locomotion. Checked before every other
  // mechanical verdict so the typed reason cannot be masked by a path/tool
  // refusal: "this leg would leave the dimension" is the fact that matters, and
  // it is the one the operator's portal loop was made of.
  const transfer = dimensionTransferRefusal(candidate, position, context)
  if (transfer !== null) {
    const target = reachabilityTargetFor(context.state, candidate)
    const world = reachabilityWorldFor(context.state, candidate, context.options.reach, context.column)
    return reachabilityRecord(candidate, target, world, transfer, context)
  }
  if (candidate.kind === 'MINE') return evaluateMineCandidate(candidate, context)
  const accessRefusal = digAccessRefusalOf(candidate)
  if (accessRefusal !== null) {
    const target = reachabilityTargetFor(context.state, candidate)
    const world = reachabilityWorldFor(context.state, candidate, context.options.reach, context.column)
    // A dig-access probe answers only whether the interaction stand was found;
    // it must not erase independent body capabilities needed to get to that
    // target.  The live M2 wedge had a log above the bot with no interaction
    // stand, and this branch reduced the full fact to only
    // `standable_approach`, so the prerequisite compiler never offered a
    // placeable block / vertical recovery candidate and Jev was left with
    // WAIT.  Evaluate the same target through the ordinary reachability
    // contract first, then retain the probe refusal as an additional fact.
    const abilities = deriveReachabilityAbilities(context.state, position, context.column)
    const probe: PathProbeResult = accessRefusal === 'no_path_to_stand' ? 'no_path' : 'unknown'
    const vertical = evaluateReachability(target, world, context.state.inventory.counts, abilities, probe)
    const accessCapability: Capability =
      accessRefusal === 'no_path_to_stand' ? { kind: 'open_path' } : { kind: 'standable_approach' }
    const missingCapabilities = [...vertical.missingCapabilities]
    if (!missingCapabilities.some((capability) => capabilityKey(capability) === capabilityKey(accessCapability))) {
      missingCapabilities.push(accessCapability)
    }
    const reason =
      vertical.reason === 'needs_ascend' || vertical.reason === 'needs_descend'
        ? vertical.reason
        : accessRefusal === 'no_path_to_stand'
          ? 'no_path'
          : 'no_standable_approach'
    const result: ReachabilityResult = { reachable: false, reason, missingCapabilities }
    return reachabilityRecord(candidate, target, world, result, context)
  }
  const target = reachabilityTargetFor(context.state, candidate)
  const world = reachabilityWorldFor(context.state, candidate, context.options.reach, context.column)
  const abilities = deriveReachabilityAbilities(context.state, position, context.column)
  // A generated vertical plan owns its own route (staircase/pillar/reuse); the
  // ordinary horizontal GoalBlock probe would reject it before the executor can
  // run that plan. A BRIDGE leg is the same shape: the stock `canDig=false`
  // pathfinder cannot express "place a block and step onto it", so the bridge IS
  // the path for its own candidate (`bridgeRoute.ts`). Every other locomotion
  // candidate must have a current path fact when the host provides one. A
  // standable destination alone is not a route: the live M2 wedge showed MOVE
  // candidates whose destination was grounded but whose pathfinder timed out and
  // whose control-walk had no jump headroom.
  const probe = hasVerticalPlan(candidate) || isBridgeMove(candidate)
    ? 'unknown'
    : context.options.reachability?.pathProbe?.(position) ?? 'unknown'
  // A `no_path` verdict from the path probe is a fact about the probe's search
  // range as much as about the world. For a target far beyond that range it does
  // not prove a local blockage, and treating it as one deletes the only
  // progress-making action. Live (source 5ac2617): the active M2 obsidian goal
  // had a remembered cell ~167m west while the body sat in a surface pocket, the
  // retrieval was withheld as `RETRIEVE:known:obsidian:b28_68_9:open_path`, and
  // the policy was left searching locally in place
  // (`resource=obsidian progressDelta=0 ... progress=search`, east/west pacing).
  // Keep such a target as a travel leg: the executor still pathfinds and its
  // post-condition and failure memory bound the attempt. Close targets keep the
  // refusal, because there `no_path` really does mean the adjacent route is
  // blocked (live: `MOVE:p193_67_-15 reachable=false reason=no_path`).
  const farTarget = distance(position, context.state.self.position) > FAR_LEG_PROBE_RADIUS
  const effectiveProbe: PathProbeResult = probe === 'no_path' && farTarget ? 'unknown' : probe
  const result = evaluateReachability(target, world, context.state.inventory.counts, abilities, effectiveProbe)
  return reachabilityRecord(candidate, target, world, result, context)
}

/**
 * THE STANCE FACT for one ATTACK: is there a cell the body can stand on,
 * legally, from which this entity is inside the melee envelope AND visible?
 *
 * `null` means NO VERDICT - the host did not supply a stance probe, or could not
 * read the entity's own geometry - and every existing rule then applies
 * unchanged. That is deliberate: an unavailable probe must never delete the only
 * productive action (the same rule every other probe in this gate follows), and
 * it is what keeps every pre-existing fixture and offline caller byte-identical.
 *
 * A verdict of `stand === null` (no legal, visible cell inside the envelope) or
 * a stance the body cannot walk to is a CAN refusal. The ATTACK is withheld with
 * the typed `no_attack_stand` reason and the full evidence, never leased into a
 * `out_of_reach` / `verify_failed` attempt that could not have swung.
 */
interface AttackStandVerdict {
  reachable: boolean
  result: ReachabilityResult
  missingCapabilities: Capability[]
  evidence: AttackStandEvidence | null
}

function attackStandVerdict(
  candidate: Candidate,
  context: ReachabilityGateContext,
): AttackStandVerdict | null {
  const probe = context.options.reachability?.attackStandProbe ?? null
  if (probe === null) return null
  const position = candidate.target
  const entityId =
    typeof candidate.meta.entityId === 'number' ? candidate.meta.entityId : candidate.targetEntityId
  if (position === null || entityId === null) return null
  const fact = probe({ entityId, position })
  if (fact === null) return null
  const base = {
    actionId: candidate.id,
    entityId,
    targetName: candidate.targetName,
    entityPosition: position,
    reach: MELEE_ATTACK_REACH,
  }
  if (fact.stand === null) {
    // No cell inside the melee envelope is a legal stance from which the entity
    // is visible: the screenshot shape (embedded in geometry) and the shape of a
    // target only reachable from cells that are solid, on fire, or occluded.
    return {
      reachable: false,
      result: { reachable: false, reason: 'no_attack_stand', missingCapabilities: [] },
      missingCapabilities: [{ kind: 'standable_approach' }],
      evidence: {
        ...base,
        refusal: fact.refusal ?? 'no_standable_cell',
        nearest: fact.nearest,
        stand: null,
        path: null,
      },
    }
  }
  if (fact.onBody) {
    // The body already stands on a legal, visible cell inside the envelope, so a
    // swing can land right now. This is the engaged-attacker response: a mob that
    // walked up to the body stays attackable whatever any path probe says.
    return {
      reachable: true,
      result: { reachable: true, reason: 'reachable', missingCapabilities: [] },
      missingCapabilities: [],
      evidence: null,
    }
  }
  // The stance exists; the body must be able to WALK to it. Same probe (and same
  // far-leg relaxation) every other locomotion leg in this gate uses, so a stance
  // is not refused by a probe of the body's own neighbourhood.
  const standFar = distance(context.state.self.position, fact.stand) > FAR_LEG_PROBE_RADIUS
  const path = standFar ? 'unknown' : (context.options.reachability?.pathProbe?.(fact.stand) ?? 'unknown')
  if (path === 'no_path') {
    return {
      reachable: false,
      result: { reachable: false, reason: 'no_attack_stand', missingCapabilities: [] },
      missingCapabilities: [{ kind: 'open_path' }],
      evidence: {
        ...base,
        refusal: 'no_reachable_stand',
        nearest: fact.nearest,
        stand: fact.stand,
        path,
      },
    }
  }
  return {
    reachable: true,
    result: { reachable: true, reason: 'reachable', missingCapabilities: [] },
    missingCapabilities: [],
    evidence: null,
  }
}

function evaluateOrdinaryAttackCandidate(
  candidate: Candidate,
  context: ReachabilityGateContext,
): CandidateReachability | null {
  const target = candidate.target
  if (target === null) return null
  // Producer/food hunts are a KILL too: the body must be able to close on the
  // exact entity inside the hunt's own approach budget, or the lease can only end
  // with 0 swings (measured `ATTACK:e16002`: producer ~37 blocks away, polls=17,
  // swings=0, reason=no_reacquire). They are not exempt from CAN; they carry a
  // different budget, which `evaluateHuntAttackCandidate` applies.
  const isHunt = typeof candidate.meta.goalDrop === 'string' || candidate.meta.foodRoute === 'animal'
  // issue #436/#11 (operator directive): the ATTACK offer no longer depends on the
  // hostile flag to exist, so the CAN gate keys on the candidate's own
  // `attackable` fact (set for every grounded attackable entity, hostile or not)
  // rather than on `targetHostile`. A hostile IN CONTACT stays unconditionally
  // executable below, and the reachability rule is otherwise unchanged.
  if (!isHunt && candidate.meta.attackable !== true) return null

  const distanceToTarget =
    typeof candidate.meta.distance === 'number'
      ? candidate.meta.distance
      : distance(context.state.self.position, target)
  const targetFact = reachabilityTargetFor(context.state, candidate)
  const world = reachabilityWorldFor(context.state, candidate, context.options.reach, context.column)
  if (isHunt) return evaluateHuntAttackCandidate(candidate, context, distanceToTarget, targetFact, world)

  // THE STANCE GATE. Contact is only executable from a position that can actually
  // hit the target: `distanceToTarget <= MELEE_THREAT_REACH` used to be accepted
  // unconditionally, which is how a magma cube embedded in the wall beside the
  // body was leased into `MECHANICALLY_BLOCKED failure=verify_failed` /
  // `out_of_reach` on repeat. A stance that is standable, hazard-free, inside the
  // melee envelope and has line of sight to the entity is required, and when the
  // body is not already on one the stance must be walkable.
  const stance = attackStandVerdict(candidate, context)
  if (stance !== null) {
    return stance.reachable
      ? reachabilityRecord(candidate, targetFact, world, stance.result, context, stance.evidence)
      : reachabilityRecord(
          candidate,
          targetFact,
          world,
          { reachable: false, reason: 'no_attack_stand', missingCapabilities: stance.missingCapabilities },
          context,
          stance.evidence,
        )
  }

  // Contact is already executable: do not let a path probe erase a mob the body
  // can hit right now. WHICH response to take remains Jev's choice.
  if (distanceToTarget <= MELEE_THREAT_REACH) {
    return reachabilityRecord(
      candidate,
      targetFact,
      world,
      { reachable: true, reason: 'reachable', missingCapabilities: [] },
      context,
    )
  }

  // The ORDINARY (non-hunt) ATTACK keeps the probe rule unchanged: its probe is a
  // 3-D `GoalNear`, which already answers the vertical case correctly, and the
  // pinned survival fixtures own that vocabulary. The HUNT path is the one that
  // needed the contact decomposition (its 24 m budget is a WALKING distance
  // compared against a 3-D distance), and `evaluateHuntAttackCandidate` applies it.
  const probe = context.options.reachability?.attackPathProbe?.(target) ?? 'unknown'
  if (probe === 'unknown') return null
  const result: ReachabilityResult =
    probe === 'reachable'
      ? { reachable: true, reason: 'reachable', missingCapabilities: [] }
      : { reachable: false, reason: 'no_path', missingCapabilities: [{ kind: 'open_path' }] }
  return reachabilityRecord(candidate, targetFact, world, result, context)
}

/**
 * issue #436 section 9: the KILL reachability contract for a goal-directed hunt.
 *
 * A Jev-selected `KILL(E)` / `HUNT_DROP(E,item)` is a bounded Skill, and code owns
 * CAN. The candidate must not be offered for a producer the body cannot possibly
 * touch inside the hunt's own budget: that produced the measured 0-swing lease
 * (`ATTACK:e16002`, body 25.5,54.9,-12.5, last known 60.5,59,-23.5, ~37 blocks,
 * `polls=17 swings=0 reason=no_reacquire`).
 *
 * The three-valued rule is the same one every locomotion candidate uses:
 *
 *   contact (<= MELEE_THREAT_REACH)   -> executable. A hostile already on the body
 *       must ALWAYS produce an ATTACK, whatever any path probe says; WHICH
 *       response to take stays Jev's.
 *   inside the hunt approach budget   -> executable. `HUNT_APPROACH_BUDGET` is the
 *       distance one bounded lease can actually WALK, so the kill is groundable by
 *       construction (the case that already works).
 *   beyond the budget                 -> offered UNLESS the route probe POSITIVELY
 *       reports `no_path`. There the body cannot route to the producer at all, so
 *       the kill is withheld with a typed reason + missing capability instead of
 *       leasing an attempt that can only end with 0 swings. The ordinary
 *       MOVE/route candidates keep advancing the body, and the ATTACK is offered
 *       again as soon as the producer is inside the budget (or a route appears).
 *       `unknown` is NOT a verdict - exactly like every locomotion candidate, an
 *       unavailable probe never deletes the only productive action.
 *
 * MEASURED CORRECTION (21 blaze hunts, EVERY one `HUNT_END ... reason=out_of_range
 * swings=0 hits=0`, `blaze_rod 0` in every inventory sample): the budget above is a
 * WALKING distance and it was compared against the raw 3-D distance. A producer
 * that hovers above the walkway is "inside the budget" while no walk can close its
 * vertical component, and the ATTACK lease's own envelope (`GoalFollow` +
 * `bot.attack`, weapon-only equip list) cannot gain height - so the lease ran to
 * its deadline without a swing and ended `out_of_range`, which reads as a failed
 * attempt rather than an unreachable target. The contact geometry is therefore
 * decomposed FIRST (`contactGeometryFor`, the SAME vertical planner every ascent
 * uses): a target above the walk envelope is withheld with `needs_ascend` +
 * `ascend_plan` and its own-column vertical route is enumerated as a MOVE-family
 * candidate instead. Nothing about WHICH action to take is decided here.
 */
function evaluateHuntAttackCandidate(
  candidate: Candidate,
  context: ReachabilityGateContext,
  distanceToTarget: number,
  targetFact: ReachabilityTarget,
  world: ReachabilityWorld,
): CandidateReachability {
  const contact = contactGeometryFor(context.state, {
    position: candidate.target as Vec3Json,
    distance: distanceToTarget,
  })
  if (contact.approach === 'ascent_required' || contact.approach === 'no_grounded_remedy') {
    return reachabilityRecord(
      candidate,
      targetFact,
      world,
      {
        reachable: false,
        reason: 'needs_ascend',
        missingCapabilities: [{ kind: 'ascend_plan' }],
      },
      context,
    )
  }
  // THE STANCE GATE for a kill, applied where the hunt's walking budget says the
  // body is expected to be able to fight: inside `HUNT_APPROACH_BUDGET`. A target
  // that far away still needs a stance it can reach and hit from - the measured
  // enderman at 6.11 m was INSIDE this budget, so the budget branch below accepted
  // it and the lease burned 47 s with zero swings. Beyond the budget the ordinary
  // route candidates advance the body and the target is re-evaluated as it closes,
  // so the existing `attackPathProbe` / `hunt_approach_budget` contract stays in
  // charge there and nothing is refused before it is walked toward.
  if (distanceToTarget <= HUNT_APPROACH_BUDGET) {
    const stance = attackStandVerdict(candidate, context)
    if (stance !== null && !stance.reachable) {
      return reachabilityRecord(
        candidate,
        targetFact,
        world,
        {
          reachable: false,
          reason: 'no_attack_stand',
          missingCapabilities: stance.missingCapabilities,
        },
        context,
        stance.evidence,
      )
    }
  }
  if (distanceToTarget <= MELEE_THREAT_REACH || distanceToTarget <= HUNT_APPROACH_BUDGET) {
    return reachabilityRecord(
      candidate,
      targetFact,
      world,
      { reachable: true, reason: 'reachable', missingCapabilities: [] },
      context,
    )
  }
  const probe = context.options.reachability?.attackPathProbe?.(candidate.target as Vec3Json) ?? 'unknown'
  if (probe !== 'no_path') {
    // `reachable` = a current route proof; `unknown` = no verdict (an unavailable
    // probe is not evidence the producer is unreachable).
    return reachabilityRecord(
      candidate,
      targetFact,
      world,
      { reachable: true, reason: 'reachable', missingCapabilities: [] },
      context,
    )
  }
  return reachabilityRecord(
    candidate,
    targetFact,
    world,
    { reachable: false, reason: 'hunt_approach_budget', missingCapabilities: [{ kind: 'open_path' }] },
    context,
  )
}

function hasVerticalPlan(candidate: Candidate): boolean {
  return (
    candidate.meta.vertical === 'reuse' ||
    candidate.meta.vertical === 'staircase' ||
    candidate.meta.vertical === 'staircase-up' ||
    candidate.meta.vertical === 'pillar'
  )
}

/**
 * True when this MINE names a log-class block (the item a `collect log` goal
 * must actually obtain). Log MINEs additionally carry the block-facts contract
 * below; a stone clearance MINE does not.
 */
function isLogMine(candidate: Candidate): boolean {
  if (candidate.kind !== 'MINE') return false
  const yieldItem = candidate.meta.yieldItem
  if (typeof yieldItem === 'string' && matchesResourceClass(yieldItem, 'log')) return true
  return typeof candidate.targetName === 'string' && candidate.targetName.endsWith('_log')
}

function mineBlockFor(state: WorldState, candidate: Candidate): BlockState | undefined {
  const target = candidate.target
  if (target === null) return undefined
  return state.blocks.find(
    (entry) =>
      entry.position.x === target.x && entry.position.y === target.y && entry.position.z === target.z,
  )
}

/**
 * A MINE candidate is dug in place: its only precondition is the harvest tool
 * tier of the block IT names. Path, vertical gap and standable approach are NOT
 * part of its contract, so it must not be run through the locomotion evaluator
 * (that would withhold a block already in reach).
 *
 * A LOG MINE is stricter: it must name a block that is present in the sensed
 * world AND in reach (the exact `mineCandidates` MINE arm). A log typed as
 * MINE while out of reach or absent from `state.blocks` cannot yield the item,
 * so it is withheld with `out_of_reach` rather than presented as executable.
 */
function evaluateMineCandidate(
  candidate: Candidate,
  context: ReachabilityGateContext,
): CandidateReachability | null {
  if (isLogMine(candidate)) {
    const block = mineBlockFor(context.state, candidate)
    const inReach = block !== undefined && block.inReach === true && block.visible !== false
    if (!inReach) {
      const result: ReachabilityResult = {
        reachable: false,
        reason: 'out_of_reach',
        missingCapabilities: [{ kind: 'standable_approach' }],
      }
      const target: ReachabilityTarget = {
        candidateId: candidate.id,
        kind: candidate.kind,
        position: candidate.target,
        barrier: barrierForCandidate(context.state, candidate),
      }
      const world = reachabilityWorldFor(context.state, candidate, context.options.reach, context.column)
      return reachabilityRecord(candidate, target, world, result, context)
    }
  }
  if (candidate.meta.clearance === true) return null
  const barrier = barrierForCandidate(context.state, candidate)
  if (barrier === null) return null
  const missing = missingToolCapability(barrier, context.state.inventory.counts)
  const result: ReachabilityResult =
    missing === null
      ? { reachable: true, reason: 'reachable', missingCapabilities: [] }
      : { reachable: false, reason: 'missing_tool', missingCapabilities: [missing] }
  const target: ReachabilityTarget = { candidateId: candidate.id, kind: candidate.kind, position: candidate.target, barrier }
  const world = reachabilityWorldFor(context.state, candidate, context.options.reach, context.column)
  return reachabilityRecord(candidate, target, world, result, context)
}

function reachabilityRecord(
  candidate: Candidate,
  target: ReachabilityTarget,
  world: ReachabilityWorld,
  result: ReachabilityResult,
  context: ReachabilityGateContext,
  /**
   * Optional typed refusal evidence for this verdict, carried on the candidate's
   * own `meta` (the same seam `digAccessRefusal` uses) so the controller can
   * mirror the fact when it logs the withhold. Absent for every verdict that has
   * nothing extra to say, which keeps every existing marker unchanged.
   */
  evidence: AttackStandEvidence | null = null,
): CandidateReachability {
  const withEvidence: Candidate =
    evidence === null ? candidate : { ...candidate, attackStandRefusal: evidence }
  return {
    candidate: withAffordance(withEvidence, result),
    result,
    fingerprint: reachabilityFingerprint({
      target,
      result,
      inventory: context.state.inventory.counts,
      world,
      placeableBlock: context.column.placeable !== null,
    }),
    targetSignature: reachabilityTargetSignature({
      target,
      result,
      inventory: context.state.inventory.counts,
      world,
      placeableBlock: context.column.placeable !== null,
    }),
    withheld: false,
    suppressed: false,
  }
}

function withAffordance(candidate: Candidate, result: ReachabilityResult | null): Candidate {
  const affordance: CandidateAffordance =
    result === null
      ? { feasible: true, reason: 'reachable', missingCapabilities: [] }
      : {
          feasible: result.reachable,
          reason: result.reason,
          missingCapabilities: result.missingCapabilities,
        }
  return { ...candidate, affordance }
}

function reachabilityTargetFor(state: WorldState, candidate: Candidate): ReachabilityTarget {
  return {
    candidateId: candidate.id,
    kind: candidate.kind,
    position: candidate.target,
    barrier: barrierForCandidate(state, candidate),
  }
}

/**
 * The block a candidate must break, resolved ONLY from the candidate's own
 * coordinates: `meta.targetBlock*` when the candidate walks toward a block, else
 * its own destination cell (a MINE candidate targets the block itself). Never a
 * block the candidate does not name.
 */
function barrierForCandidate(state: WorldState, candidate: Candidate): ReachabilityBarrier | null {
  const x = candidate.meta.targetBlockX
  const y = candidate.meta.targetBlockY
  const z = candidate.meta.targetBlockZ
  const cell =
    typeof x === 'number' && typeof y === 'number' && typeof z === 'number'
      ? { x, y, z }
      : candidate.kind === 'MINE'
        ? candidate.target
        : null
  return cell === null ? null : cellHarvestBarrier(state, cell)
}

/** The block NAME a cut pool observed at `cell` (headroom first, then step cuts). */
function observedCutName(state: WorldState, cell: Vec3Json): string | null {
  const at = (pos: Vec3Json): boolean => pos.x === cell.x && pos.y === cell.y && pos.z === cell.z
  const head = (state.headroomCuts ?? []).find((cut) => at(cut.pos))
  if (head !== undefined) return head.name
  const step = (state.stepCuts ?? []).find((cut) => at(cut.cut))
  if (step !== undefined) return step.name
  return null
}

/**
 * THE HARVEST TRUTH OF A CELL, from every piece of sensor truth the state holds.
 *
 * `state.blocks` is the scanner's RESOURCE index: it carries the sensor's
 * resolved harvest profile (tool family + minimum tier), but ordinary terrain is
 * not in it. A ceiling or a step face is sensed as a CUT (`headroomCuts` /
 * `stepCuts`), and those carry only the block NAME. Reading the requirement from
 * `state.blocks` alone therefore made a terrain tool need invisible - the
 * measured live freeze on main 38cbb22:
 *
 *   - the ascend column refused the jump at the body's own head cell and the
 *     withheld fact was `headroom@27,62,15` with `tools=[]`, i.e. no tool fact at
 *     all, while that cell is a block a bare hand cannot harvest and the body held
 *     no pickaxe of any tier;
 *   - the clearance MINE was generated with `requiresTool=false`, so the gate had
 *     no barrier to refuse it with, the lease dug the block bare-handed into
 *     `dig_timeout` until move-failure memory retired the cut, and only then did
 *     the acquisition pass have nothing left to offer;
 *   - no `{kind:'tool'}` capability was ever derived for the cell, so nothing in
 *     the run could turn "the climb needs the cell above cleared" into "get a
 *     tool", and the offer stayed `[WAIT, ESCALATE]`.
 *
 * The requirement is resolved deterministically from facts the state already
 * carries: the scanner's own entry first (its profile is the sensor's), else the
 * cut pools by NAME through the shared mechanics owner (#54 `resolveHarvest`). An
 * unknown/unobserved name resolves to null: a fact the sensor did not prove never
 * becomes a tool requirement, and the caller keeps its previous behaviour instead
 * of inventing a refusal.
 */
function cellHarvestBarrier(state: WorldState, cell: Vec3Json): ReachabilityBarrier | null {
  const block = state.blocks.find(
    (entry) => entry.position.x === cell.x && entry.position.y === cell.y && entry.position.z === cell.z,
  )
  if (block !== undefined && block.harvestTool != null) {
    return {
      position: block.position,
      name: block.name,
      requiredTool: block.harvestTool,
      requiredTier: block.harvestTier ?? null,
    }
  }
  const name = block?.name ?? observedCutName(state, cell)
  if (name === undefined || name === null || name === '' || name === 'unknown') return null
  const profile = resolveHarvest(loadGameData(), name)
  if (profile.harvestTool === null) return null
  return { position: cell, name, requiredTool: profile.harvestTool, requiredTier: profile.harvestTier }
}

function columnFacts(state: WorldState): ColumnFacts {
  const feet = {
    x: Math.floor(state.self.position.x),
    y: Math.floor(state.self.position.y),
    z: Math.floor(state.self.position.z),
  }
  const cuts = state.headroomCuts ?? []
  const ownCut =
    cuts.find((cut) => cut.currentFootprint === true) ??
    // Backward-compatible replay fixtures written before `currentFootprint`:
    // only the old own-column shape may stand in for the current blocker.
    cuts.find(
      (cut) =>
        cut.currentFootprint === undefined &&
        cut.pos.x === feet.x &&
        cut.pos.z === feet.z &&
        (cut.pos.y === feet.y + 1 || cut.pos.y === feet.y + 2),
    )
  // The sensor reports standable FEET cells. The body's feet cell is floor(y),
  // but a body standing on a partial block (slab/path/stair, live y=34.5) has
  // its standable cell one level above the floor cell. Live starvation (main
  // 104e689, fingerprint foot=0) withheld every ascend target as
  // `safe_column` for exactly that stance, so the fact must match all three.
  const footingSolid = state.terrain.standable.some((spot) => {
    const cell = { x: Math.floor(spot.x), y: Math.floor(spot.y), z: Math.floor(spot.z) }
    return (
      cell.x === feet.x &&
      cell.z === feet.z &&
      (cell.y === feet.y || cell.y === feet.y - 1 || cell.y === feet.y + 1)
    )
  })
  return {
    placeable: selectPlaceableBlock(state.inventory.counts),
    columnSafe: !pillarColumnUnsafeFromBlocks(state.self.position, state.blocks),
    footingSolid,
    headroomClear: ownCut === undefined,
    headroomCell: ownCut?.pos ?? null,
  }
}

function reachabilityWorldFor(
  state: WorldState,
  candidate: Candidate,
  reach: number,
  column: ColumnFacts,
): ReachabilityWorld {
  const position = candidate.target
  // SAFE: a code-grounded environmental escape was proven hazard-free by its own
  // selection (real block truth at the destination); the blanket proximity rule
  // would otherwise withhold EVERY exit from a burning body, because each
  // neighbour of the fire it stands in is inside the margin. Lava-class hazards
  // still block it (`envHazardProximityDenied`).
  const escape = candidate.meta[ENV_HAZARD_ESCAPE_META] !== undefined
  return {
    self: state.self.position,
    approach: candidate.hasStandableAdjacent ? position : null,
    reach,
    hazardAtTarget:
      position !== null &&
      state.blocks.some(
        (block) =>
          block.kind === 'hazard' &&
          distance(block.position, position) <= HAZARD_PROXIMITY &&
          envHazardProximityDenied(escape, block.name),
      ),
    footingSolid: column.footingSolid,
    headroomClear: column.headroomClear,
    // A body with a walkable frontier can TRAVEL to a far target below and
    // re-derive the descent where the terrain provides one; only a body confined
    // to its own column must already hold the local descent step. This is the
    // general "approach a target that requires descending" fact.
    canTravel: !strandedOnColumn(state),
  }
}

export function deriveReachabilityAbilities(
  state: WorldState,
  target: Vec3Json,
  column: ColumnFacts = columnFacts(state),
): ReachabilityAbilities {
  const counts = state.inventory.counts
  const dy = Math.round(target.y - state.self.position.y)
  const digSources = protectedVerticalDigSources(state)
  const route = planVerticalApproachDetailed({
    selfFeetY: state.self.position.y,
    selfPosition: state.self.position,
    target,
    tunnel: state.signals.lastTunnel,
    descent: digSources.descent,
    stepCuts: digSources.stepCuts,
    placeable: column.placeable,
    columnSafe: column.columnSafe,
    inventory: counts,
  })
  const plan = route.plan

  // The ascent column is a FACT, not a plan: an adjacent/forward cell whose
  // 2-block body column one level up is clear (walkable step) or clearable
  // (one diggable blocker + the held tool) with solid support and no hazard.
  const ascent = evaluateAscentColumn({
    selfFeetY: state.self.position.y,
    selfPosition: state.self.position,
    target,
    stepCuts: digSources.stepCuts,
    standable: state.terrain.standable,
    hazards: state.blocks.filter((block) => block.kind === 'hazard').map((block) => block.position),
    inventory: counts,
  })

  // A plan counts as an available ascend only when it is mechanically
  // executable NOW: a pillar needs a supported, safe column with jump headroom;
  // an up-staircase needs a known clearance block, but not the harvest tool for
  // drops the route does not require.
  const explicitPlanAvailable =
    plan !== null &&
    (plan.kind !== 'pillar' || (column.columnSafe && column.footingSolid && column.headroomClear)) &&
    (plan.kind !== 'staircase-up' || ascent.kind !== 'refuse')
  // `ascent.kind === clear` is only evidence for the no-explicit-plan path. If
  // the candidate already carries a concrete pillar/staircase HOW, the executor
  // will execute THAT plan; an unrelated adjacent step cannot make its blocked
  // current-column mechanics executable. Live 2026-09-22 y54 proved the old OR
  // false-positive: fingerprint head=0, ENTER reachable=true, then PILLAR_REFUSED.
  const ascendPlanAvailable = plan === null ? ascent.kind === 'clear' : explicitPlanAvailable

  const ascendMissing: Capability[] = []
  if (dy > ASCEND_GAP_LIMIT && !ascendPlanAvailable) {
    if (column.placeable === null) ascendMissing.push({ kind: 'placeable_block' })
    if (!column.headroomClear) {
      // The blocked jump cell is the binding immediate fact; the acquisition
      // pass offers its mechanical clearance. Harvest-tool requirements apply
      // only when the action needs this block's drops, which headroom clearance
      // does not.
      ascendMissing.push({ kind: 'headroom', cell: column.headroomCell })
    } else if (ascent.kind === 'refuse') {
      // Name the specific absent fact (`safe_column:no_clearance@x,y,z` /
      // `safe_column:no_tool@x,y,z`) instead of a bare token.
      const requiredTool = ascent.blocker?.requiredTool ?? null
      ascendMissing.push({
        kind: 'safe_column',
        reason: ascent.reason,
        cell: ascent.cell,
        tool: requiredTool,
        tier: ascent.blocker?.requiredTier ?? null,
      })
    }
    if (ascendMissing.length === 0) {
      // Nothing else named a fact, and a bare `ascend_plan` would hide WHICH
      // concrete HOW was rejected (the live trial: `place=1 hazard=0 tools=[]`
      // with 834 identical bare-token withholdings while the body stood frozen).
      // Name the plan the column carried and the precondition that stopped it -
      // the same rule `descend_plan` already follows - so the refusal is
      // actionable instead of retryable.
      const feetCell = {
        x: Math.floor(state.self.position.x),
        y: Math.floor(state.self.position.y),
        z: Math.floor(state.self.position.z),
      }
      // The ONLY fact this branch can be holding is the column's support: every
      // other precondition (placeable block, headroom + tool, safe-column refusal)
      // pushes its own capability above, and a plan is grounded unless one of them
      // refused. `plan !== null && !footingSolid` is therefore the live shape.
      const reason: AscendPlanRefusalReason = plan !== null && !column.footingSolid ? 'no_footing' : 'plan_unavailable'
      ascendMissing.push({ kind: 'ascend_plan', plan: plan?.kind ?? null, reason, cell: feetCell })
    }
  }

  const descendMissing: Capability[] = []
  if (dy < -DESCEND_GAP_LIMIT) {
    if (plan === null) {
      // Name WHICH mechanical precondition of a controlled descent is absent
      // (unsafe landing, lava, bedrock floor, protected station) and the cell it
      // belongs to. A bare `descend_plan` token is only kept when the sensor pool
      // carried no down step at all to judge.
      const refusal = route.descentRefusal
      // THE ANSWER BEFORE THE REFUSAL. A landing whose support is air is the ONE
      // shape no dig can answer, and it is exactly the shape the body measured live
      // 1912 times (`descend_plan:no_support@25,78,-2:air` on the operator's floated
      // gate). The downward self-landing scaffold (`descentScaffold.ts`) changes it
      // by PLACING the floor it lands on - the mirror of the bridge the same run
      // proved live. So the descent is available exactly when that step grounds, and
      // when it does not the refusal names the missing fact instead of the same
      // retryable token.
      if (refusal !== null && refusal.reason === 'no_support') {
        const scaffold = groundDescentScaffoldLeg(state, { target, walkable: false })
        if (scaffold.plan === null) {
          const missing = scaffold.refusal
          if (missing !== null && missing.reason === 'no_block') {
            // The body holds nothing it could place: the ONE capability that would
            // make the descent reachable. Named as the material fact (the same
            // shape the ascent branch uses) so the acquisition pass can ROUTE to
            // obtaining a block instead of retrying a token.
            descendMissing.push({ kind: 'placeable_block' })
          } else if (missing !== null) {
            descendMissing.push({
              kind: 'descend_plan',
              reason: descendScaffoldReachabilityReason(missing.reason) as DescendPlanRefusalReason,
              cell: missing.cell,
              block: missing.block,
              tool: null,
              tier: null,
            })
          } else {
            descendMissing.push({
              kind: 'descend_plan',
              reason: refusal.reason,
              cell: refusal.cell,
              block: refusal.block,
              tool: null,
              tier: null,
            })
          }
        }
      } else {
        descendMissing.push(
          refusal === null
            ? { kind: 'descend_plan' }
            : {
                kind: 'descend_plan',
                reason: refusal.reason,
                cell: refusal.cell,
                block: refusal.block,
                tool: null,
                tier: null,
              },
        )
      }
    } else if (plan.kind === 'staircase' && typeof plan.harvestTool === 'string') {
      const tier = plan.harvestTier ?? 0
      if (bestToolTier(counts, plan.harvestTool) < tier) {
        descendMissing.push({ kind: 'tool', tool: plan.harvestTool, tier })
      }
    }
  }

  return {
    ascend: { available: ascendMissing.length === 0, missing: ascendMissing },
    descend: { available: descendMissing.length === 0, missing: descendMissing },
  }
}

/**
 * The held tool state for the tool families a set of missing capabilities names,
 * as `family:bestHeldTier` (`pickaxe:-1` = none of any tier, the live shape).
 * Part of the acquisition evidence: a reader must be able to see the tool state
 * the acquisition decision was made against, not just the decision.
 */
function toolStateForCapabilities(state: WorldState, capabilities: readonly Capability[]): string {
  const families = [
    ...new Set(
      capabilities
        .filter((capability): capability is Extract<Capability, { kind: 'tool' }> => capability.kind === 'tool')
        .map((capability) => capability.tool),
    ),
  ].sort()
  if (families.length === 0) return 'none'
  return families.map((tool) => `${tool}:${bestToolTier(state.inventory.counts, tool)}`).join('|')
}

/**
 * Bounded closure passes over the capability-acquisition output (see
 * `applyReachabilityGate`). The bound holds for BOTH closure conditions - the
 * station-retirement set and the capability set can only grow, and each pass adds
 * at least one distinct member, so a small fixed bound terminates and cannot loop.
 */
export const MAX_ACQUISITION_RETIRE_PASSES = 3

/**
 * The grounded travel leg toward a descent destination: the standable frontier
 * cell that most reduces the distance to the withheld target.
 *
 * When a locomotion target is below and the body's OWN cell has no safe descent
 * step, the body is not standing at the descent cell yet. The mechanically valid
 * forward change is therefore to TRAVEL toward that destination and re-derive the
 * descent from fresh state (the SAME `planVerticalApproachDetailed` the candidate
 * carries), which is exactly the "walk there, then descend" route. Emits at most
 * one candidate, requires strict progress (>= 1 block closer), and is a plain
 * MOVE: no DESCEND is invented (the pool has no safe step by construction), no
 * drop is taken, and nothing is ranked.
 */
function descentApproachCandidates(
  state: WorldState,
  options: CandidateOptions,
  destination: Vec3Json | null,
): Candidate[] {
  if (destination === null) return []
  const selfDistance = distance(state.self.position, destination)
  const advances = state.terrain.standable
    .filter((spot) => !isBlacklistedMoveTarget(state, options.blacklistedMoveTargets, spot))
    .filter((spot) => distance(spot, state.self.position) > 1)
    .filter((spot) => distance(spot, destination) <= selfDistance - 1)
  if (advances.length === 0) return []
  const toward = advances.reduce((best, spot) => {
    const da = distance(spot, destination)
    const db = distance(best, destination)
    if (da !== db) return da < db ? spot : best
    const sa = distance(spot, state.self.position)
    const sb = distance(best, state.self.position)
    if (sa !== sb) return sa < sb ? spot : best
    if (spot.y !== best.y) return spot.y < best.y ? spot : best
    if (spot.x !== best.x) return spot.x < best.x ? spot : best
    return spot.z < best.z ? spot : best
  })
  const candidate = exploreMoveCandidate(
    state,
    options,
    toward,
    moveLabel(toward, 'travel toward the descent cell', state.self.position),
    null,
  )
  return [
    {
      ...candidate,
      meta: { ...candidate.meta, verticalRecovery: 'descend_approach' },
    },
  ]
}

/**
 * The grounded retarget for a `descend_to:Y=<n>` goal whose own column offers NO
 * safe descent step at all (every cardinal cell and the own column refused by
 * hazard / no support / unbreakable floor).
 *
 * The live shape (run-muc3qbug-18vg3, main 35dfd29): after descending to y=47 the
 * body climbed back to y=55 and the descend row went IDLE with
 * `candidates n=1 kinds=['ESCALATE']` - no grounded body change at all, on an
 * active row. A column with no safe step is not evidence that no descent exists;
 * it is evidence that THIS column is blocked. The mechanically valid forward
 * change is to a DIFFERENT standable column: walk to a standable cell that keeps
 * or lowers altitude, where the sensor gets a fresh descent pool and the normal
 * staircase/dig route re-derives.
 *
 * Bounded and grounded: only sensed standable cells, at most `maxMoveCandidates`,
 * ordered lowest-first then nearest-first (deterministic), never a drop, never a
 * dig, no ranking of any other family, and the reachability gate still evaluates
 * every cell. Empty only when perception grounds no standable cell at all - the
 * typed bounded case the caller escalates with.
 */
function descentRetargetCandidates(state: WorldState, options: CandidateOptions): Candidate[] {
  const limit = Math.max(1, options.maxMoveCandidates ?? DEFAULT_MAX_MOVE_CANDIDATES)
  const feetY = Math.floor(state.self.position.y)
  const standable = state.terrain.standable
    .filter((spot) => !isBlacklistedMoveTarget(state, options.blacklistedMoveTargets, spot))
    .filter((spot) => distance(spot, state.self.position) > 1)
  if (standable.length === 0) return []
  const lower = standable.filter((spot) => Math.floor(spot.y) <= feetY)
  const pool = lower.length > 0 ? lower : standable
  const ordered = [...pool].sort((a, b) => {
    if (a.y !== b.y) return a.y - b.y
    const da = distance(a, state.self.position)
    const db = distance(b, state.self.position)
    if (da !== db) return da - db
    if (a.x !== b.x) return a.x - b.x
    return a.z - b.z
  })
  return ordered.slice(0, limit).map((spot) => {
    const candidate = exploreMoveCandidate(
      state,
      options,
      spot,
      moveLabel(spot, 'retarget a fresh descent column (this column has no safe step)', state.self.position),
      null,
    )
    return {
      ...candidate,
      meta: {
        ...candidate.meta,
        explore: false,
        verticalRecovery: 'descent_retarget',
        descendRetarget: true,
        columnBlocked: true,
      },
    }
  })
}

/** `options` with `retired` merged into its explicit unreachable-station set. */
function optionsWithRetiredStations(
  options: CandidateOptions,
  retired: ReadonlySet<string>,
): CandidateOptions {
  if (retired.size === 0) return options
  return {
    ...options,
    unreachableStations: new Set([...(options.unreachableStations ?? []), ...retired]),
  }
}

/**
 * `options` whose explicit unreachable-station set also names every station cell
 * this decision's withheld retrieves proved unreachable. The gate uses it to
 * derive the capability-acquisition candidates, and the controller uses it for
 * the mirrored `craftStationGap` fact so the offered recovery and the logged
 * marker can never disagree (both read the SAME withheld set).
 */
export function optionsWithWithheldStationRetirements(
  options: CandidateOptions,
  withheld: readonly CandidateReachability[],
): CandidateOptions {
  return optionsWithRetiredStations(options, retiredStationsFromWithheld(withheld))
}

/**
 * The durable station cells THIS gate pass just proved unreachable: a
 * `RETRIEVE:known:station:<kind>:<cell>` whose reachability verdict refused it
 * (`needs_descend`, `missing_tool`, `no_path`, ...). The controller's explicit
 * `unreachableStations` set is derived from the PREVIOUS tick's withheld ids, so
 * on the tick a station first fails there is a one-decision window where it still
 * counts as "usable" - exactly long enough for the duplicate-station-craft guard
 * to suppress the craft that would acquire the missing capability, leaving
 * `presented=[WAIT, ESCALATE]` forever (run-mubobiq6-12onv). Observing the pass's
 * own withheld retrieves closes that window inside the same decision. World truth
 * only: the cell is still remembered, it just cannot be reached right now, so it
 * must not block making a new station.
 */
function retiredStationsFromWithheld(withheld: readonly CandidateReachability[]): ReadonlySet<string> {
  const retired = new Set<string>()
  for (const entry of withheld) {
    const candidate = entry.candidate
    if (candidate.kind !== 'RETRIEVE' || candidate.target === null) continue
    if (candidate.meta.resourceKind !== 'station') continue
    const name =
      typeof candidate.meta.resource === 'string' ? candidate.meta.resource : candidate.targetName
    if (name !== 'furnace' && name !== 'crafting_table') continue
    retired.add(knownStationKey({ name, position: candidate.target }))
  }
  return retired
}

/** The result of one acquisition pass: the candidates plus the per-fact evidence. */
interface AcquisitionPassResult {
  candidates: Candidate[]
  /**
   * `capabilityKey` -> the candidate ids this pass enumerated for it. A key with
   * an entry has a grounded route; a key with no entry (and no emission) is the
   * typed refusal case.
   */
  routes: Map<string, string[]>
  /** `capabilityKey` -> the typed reason no grounded route exists for it */
  refusals: Map<
    string,
    { reason: AcquisitionRefusalReason; item: string | null; count: number | null; cell?: Vec3Json | null }
  >
}

/**
 * The typed reason no grounded route exists for one missing capability, with the
 * concrete item and count when the missing thing is a MATERIAL. The item comes
 * from the SAME recipe view the craft route uses (`craftIngredientRoute`), so the
 * refusal names what the body would have to obtain rather than a token.
 *
 * Every arm below is a fact the acquisition pass MEASURED this tick: the generic
 * `no_producer` is reserved for the case where the sensor really did prove no
 * world source, and a cell the sensor never read is named as such instead of
 * being reported as a world verdict (`cell_unread`).
 */
function acquisitionRefusalFor(
  state: WorldState,
  options: CandidateOptions,
  capability: Capability,
): { reason: AcquisitionRefusalReason; item: string | null; count: number | null; cell?: Vec3Json | null } {
  if (capability.kind === 'tool') {
    const item = toolItemsForCapability(state, options, capability)[0]
    if (item === undefined) return { reason: 'no_producer', item: null, count: null }
    const route = craftIngredientRoute(state, options, item)
    if (route === null) {
      // Every ingredient of the recipe IS held, so the plan cannot be short of
      // material: what it can be short of is the STATION a 3x3 step needs. Naming
      // the tool as its own missing material (the old shape) is a false fact; the
      // station is the obtainable thing (place the carried one / walk to a known
      // one / craft it from what the body carries).
      const recipes = options.recipes ?? null
      if (
        recipes !== null &&
        planRequiresTable(recipes, item, state.inventory.counts, craftGoalRequirement(state, item))
      ) {
        return { reason: 'no_station', item: 'crafting_table', count: 1 }
      }
      return { reason: 'no_material', item, count: 1 }
    }
    // `producer: 'none'` is the route's own statement that no raw source exists;
    // either way the ingredient the body lacks is named with its count.
    return { reason: 'no_material', item: route.missing, count: route.missingCount }
  }
  if (capability.kind === 'headroom' && capability.cell !== null) {
    // A clearance cell the sensor never read is not a missing producer and not a
    // missing material: it is a missing READ. Naming the cell keeps the record
    // honest (`cell_unread cell=-8,52,-6`) instead of the bare `no_producer`
    // token, which reads as a world verdict the pass never measured.
    if (cellHarvestBarrier(state, capability.cell) === null && observedCutName(state, capability.cell) === 'unknown') {
      return { reason: 'cell_unread', item: null, count: null, cell: capability.cell }
    }
  }
  return { reason: 'no_producer', item: null, count: null }
}

/** Grounded candidates that would acquire a withheld target's missing capability. */
function capabilityAcquisitionCandidates(
  state: WorldState,
  options: CandidateOptions,
  withheld: readonly CandidateReachability[],
  existingIds: ReadonlySet<string>,
  digRefusals: DigRouteRefusalSink = [],
): AcquisitionPassResult {
  const out: Candidate[] = []
  const routes = new Map<string, string[]>()
  const refusals = new Map<string, { reason: AcquisitionRefusalReason; item: string | null; count: number | null }>()
  const seen = new Set<string>(existingIds)
  // A candidate already withheld this cycle must never be re-emitted: the
  // acquisition pass would re-evaluate the same id and double-record its
  // refusal (issue: duplicated withheld work).
  for (const entry of withheld) seen.add(entry.candidate.id)
  for (const entry of withheld) {
    for (const capability of entry.result.missingCapabilities) {
      let source: Candidate[] = []
      if (capability.kind === 'headroom') {
        source = headroomCandidates(state, options)
      } else if (capability.kind === 'placeable_block') {
        // A vertical Skill may need a held solid block for a pillar/step.  The
        // missing capability is mechanical, so acquire it from a grounded
        // producer already in the sensor envelope; do not wake System2 or
        // smuggle a semantic collect goal into the queue.  Use the complete
        // placeable producer envelope (cobblestone, andesite, dirt, etc.), not
        // only cobblestone: a wall block such as andesite can be the only
        // reachable producer in a pocket. `mineCandidates` supplies the same
        // tool, pickup and reachability facts as an ordinary route, while the
        // typed envelope below preserves why it is admitted under the active
        // Option.
        //
        // `keepUnharvestable` is what makes the MATERIAL route honest: a sensed
        // producer whose tool the body still lacks IS the route to the material,
        // and it must be enumerated so the gate can say `missing_tool` and the
        // closure can offer the tool. Dropping it here made the acquisition pass
        // report `no_producer` for a producer the sensor had proved.
        source = mineCandidates(
          state,
          options,
          null,
          null,
          (block) => typeof block.yield === 'string' && PILLAR_PLACE_PRIORITY.includes(block.yield),
          true,
        )
      } else if (capability.kind === 'tool') {
        // Enumerate every tier-satisfying tool the inventory can actually make
        // (weakest first), not only the weakest canonical name. A body holding
        // 64 cobblestone + 4 sticks and no planks must be offered
        // `craft:stone_pickaxe` now, not sent to collect planks for a wooden one
        // it cannot afford (live shape, run-mubobiq6-12onv). CAN only: the list
        // is a fact set and Jev still chooses.
        for (const item of toolItemsForCapability(state, options, capability)) {
          source.push(...craftCandidates(state, options, item).candidates)
        }
      } else if (capability.kind === 'open_path' || capability.kind === 'standable_approach') {
        // A locomotion target withheld for `no_path` / `no_standable_approach`
        // must not leave Jev a barren set (live: `CANDIDATE_STARVATION
        // goal=place:furnace:1 presented=2 productive=0` after `REACHABILITY
        // candidate=MOVE:p56_60_24 reachable=false reason=no_path
        // missing=[open_path]`). Contribute the EXISTING generic route-opening
        // affordances the raw generator already emits - cut a step, take a safe
        // descend step, or walk to the nearest standable frontier - so a
        // mechanically-valid forward body change is on offer. This is CAN
        // enumeration only: no item/coordinate/portal special-casing, no
        // ordering or ranking, and the model still owns WHAT and WHICH.
        // Ground the generic recovery family in the exact locomotion target
        // whose path was refused.  A route-opening MOVE that does not reduce
        // the distance to that target is only local wandering; the live
        // underground wedge repeatedly offered such moves and Jev selected
        // them in a p13/p14/p12 loop with zero inventory progress.  STEP and
        // DESCEND remain available as mechanical route-opening facts because
        // they can change the topology even when their immediate landing cell
        // is not closer in Euclidean distance.
        source = routeOpeningCandidates(state, options, entry.candidate.target, digRefusals)
      } else if (capability.kind === 'descend_plan') {
        // A safe staircase can disappear after one bounded step when the bot
        // is standing on a canopy/ledge.  The sensor still proves a same-level
        // descent step, so expose that level move as the prerequisite action;
        // the next observation can then derive the next down plan.  Do not
        // invent a drop or an arbitrary exploration target here.
        const levelSteps = (state.descent ?? [])
          .filter((step) => hasUsableLevelLanding(step) && step.floorSolid && (step.dx !== 0 || step.dz !== 0))
          .map((step) => {
            const target = step.step
            const candidate = exploreMoveCandidate(
              state,
              options,
              target,
              moveLabel(target, 'reposition on a safe level step for descent', state.self.position),
              null,
            )
            return {
              ...candidate,
              meta: {
                ...candidate.meta,
                verticalRecovery: 'safe_level_step',
              },
            }
          })
        // The retained target is where the descent must happen. When the body is
        // not standing there yet, travelling toward it is the other grounded
        // prerequisite: the descent is re-derived from fresh state on arrival,
        // so a far/higher body gets a real forward leg instead of a local-only
        // pool that never advances (live run-muc3qbug-18vg3: ENTER withheld for
        // `descend_plan` while every offered MOVE/MINE stayed around the body).
        const approach = descentApproachCandidates(state, options, entry.candidate.target)
        // AND the answer this capability was measured to be missing: when the
        // withheld descent is refused because the landing has no support, the
        // downward self-landing scaffold IS the grounded prerequisite - the exact
        // one block and one cell that makes the withheld target reachable. Offered
        // here, beside the level step and the approach leg, never instead of them:
        // the measured live shape was 1912 acquisitions with no route at all
        // (`descend_plan:no_support@25,78,-2:air`).
        const scaffold =
          entry.candidate.target === null
            ? { candidates: [], classes: [], refusal: null, refusalLine: null }
            : descentRemedyCandidates(state, options, {
                target: entry.candidate.target,
                targetName: null,
                reason: 'acquisition_prerequisite',
                skill: null,
                walkable: false,
              })
        source = [...levelSteps, ...approach, ...scaffold.candidates]
      }
      const key = capabilityKey(capability)
      const emitted: string[] = []
      for (const candidate of source) {
        if (seen.has(candidate.id)) continue
        seen.add(candidate.id)
        emitted.push(candidate.id)
        const inheritedPrereqPath =
          typeof entry.candidate.meta.prereqPath === 'string' ? entry.candidate.meta.prereqPath : null
        const inheritedPrerequisiteRole =
          typeof entry.candidate.meta.prerequisiteRole === 'string'
            ? entry.candidate.meta.prerequisiteRole
            : inheritedPrereqPath === null
              ? null
              : FURNACE_PREREQUISITE_ROLE
        const placeablePrerequisite =
          capability.kind === 'placeable_block' && inheritedPrereqPath === null && inheritedPrerequisiteRole === null
        out.push({
          ...withAffordance(candidate, null),
          meta: {
            ...candidate.meta,
            capabilityAcquisition: true,
            missingCapability: key,
            ...(placeablePrerequisite
              ? { optionSkill: 'PREREQUISITE', prerequisiteRole: 'placeable_block' }
              : {}),
            ...(inheritedPrereqPath === null
              ? {}
              : {
                  prereqPath: inheritedPrereqPath,
                  prerequisiteRole: inheritedPrerequisiteRole ?? FURNACE_PREREQUISITE_ROLE,
                }),
          },
        })
      }
      if (emitted.length > 0) {
        routes.set(key, [...(routes.get(key) ?? []), ...emitted])
      } else if (!refusals.has(key)) {
        // Nothing grounded could be enumerated for this fact. Say WHY, in typed
        // form and with the item+count when one exists - never silence.
        refusals.set(key, acquisitionRefusalFor(state, options, capability))
      }
    }
  }
  return { candidates: out, routes, refusals }
}

/**
 * The generic route-opening affordances for a withheld locomotion target: the
 * existing STEP / DESCEND / explore-MOVE families. A STEP cuts the upper block
 * of a blocked face, a DESCEND takes one safe staircase/tunnel step toward the
 * goal resource, and the MOVE walks to the nearest standable frontier. None is
 * item/coordinate/portal special-cased and none is ordered or ranked against
 * the others; they are facts Jev selects from.
 */
function routeOpeningCandidates(
  state: WorldState,
  options: CandidateOptions,
  blockedTarget: Vec3Json | null = null,
  digRefusals: DigRouteRefusalSink = [],
): Candidate[] {
  const focus = state.goalQueue?.current?.targetItem ?? state.goal.targetItem ?? null
  const out: Candidate[] = [
    ...stepCutCandidates(state, options),
    ...existingDescentRouteCandidates(state, options),
    ...descendCandidates(state, options, focus, [], null),
    ...openLevelStepMoves(state, options),
  ]
  const spot = pickExplore(
    state,
    state.terrain.standable,
    focus,
    options.moveFailureLimit ?? DEFAULT_CANDIDATE_MOVE_FAILURE_LIMIT,
    options.blacklistedMoveTargets,
  )
  if (spot !== null) {
    out.push(
      exploreMoveCandidate(
        state,
        options,
        spot,
        moveLabel(spot, 'walk toward the unreachable target', state.self.position),
        null,
      ),
    )
  }
  if (blockedTarget === null) return out
  // `pickExplore` picks the NEAREST standable frontier, which is frequently
  // behind the body when the withheld locomotion target is far away. The
  // `moveAdvancesTowardTarget` filter below then removes every MOVE and Jev is
  // left with WAIT/ESCALATE only. Observed live with the active M2 obsidian
  // goal:
  //   CANDIDATE_STARVATION presented=2 productive=0 goal=collect:obsidian:10
  //     blockedBy=no_path missing=["RETRIEVE:known:obsidian:b28_67_9:open_path"]
  //   body frozen at x=199.5 while the remembered cell is ~175m west, so the
  //   goal could never be satisfied. Add the standable spot closest to the
  //   withheld target as one more grounded MOVE fact: still a plain locomotion
  //   candidate, no ranking, no coordinate special-casing.
  // The refused target's own neighbourhood is exactly where the body cannot go
  // (live: `MOVE:p193_67_-15 reachable=false reason=no_path` with lava adjacent),
  // so aiming the waypoint at it just re-creates the refusal. Prefer a standable
  // spot that is *away* from that neighbourhood: a detour the body can actually
  // take, still chosen for closeness to the withheld target.
  const nearRefused = (spot: Vec3Json): boolean =>
    Math.abs(spot.x - blockedTarget.x) <= 3 &&
    Math.abs(spot.y - blockedTarget.y) <= 1 &&
    Math.abs(spot.z - blockedTarget.z) <= 3
  const candidatesForWaypoint = state.terrain.standable
    .filter((spot) => !isBlacklistedMoveTarget(state, options.blacklistedMoveTargets, spot))
    .filter((spot) => distance(spot, state.self.position) > 1)
  // The waypoint must make real progress toward the withheld target. Offering the
  // closest spot while ignoring distance produced an east/west oscillation at the
  // same spot (operator: "it keeps pacing left and right"; live `pos` cycled
  // 195.5 <-> 199) because lateral spots are no worse than forward ones under a
  // pure closeness sort. Require the spot to be strictly closer to the target
  // than the body is (>= 1 block), which is the same grounding the
  // `moveAdvancesTowardTarget` filter already applies to plain MOVEs.
  // Aim at the REAL destination, not only at the cell that was just refused.
  // The refused target is a local obstacle; the goal (for example the remembered
  // obsidian the portal frame needs) is what the body must keep moving toward.
  // Live (#352): with the blocked-target-only target the body paced and stalled
  // in local pockets at x~135-146 while its seven remembered obsidian cells sat
  // ~100m further west, because every offered waypoint was measured against the
  // refused neighbour instead of the destination.
  const rememberedForFocus = (state.signals.knownResources ?? []).filter(
    (resource) => focus !== null && resource.name === focus,
  )
  const goalTarget: Vec3Json =
    rememberedForFocus.length > 0
      ? rememberedForFocus.reduce((best, entry) =>
          distance(entry.position, state.self.position) < distance(best.position, state.self.position)
            ? entry
            : best,
        ).position
      : blockedTarget
  const selfDistance = distance(state.self.position, goalTarget)
  const detours = candidatesForWaypoint
    .filter((spot) => !nearRefused(spot))
    .filter((spot) => distance(spot, goalTarget) <= selfDistance - 1)
  const toward = detours.sort((a, b) => distance(a, goalTarget) - distance(b, goalTarget))[0]
  if (toward !== undefined) {
    out.push(
      exploreMoveCandidate(
        state,
        options,
        toward,
        moveLabel(toward, 'walk toward the unreachable target', state.self.position),
        null,
      ),
    )
  }
  // A withheld locomotion target whose WALK cannot be re-grounded at all (a
  // sealed body, or a refused path with no standable detour) still has one
  // grounded route change left: the TERRAIN between the body and the destination.
  // Ground the bounded dig step that strictly reduces the distance to the REAL
  // destination (`goalTarget`, never the local obstacle), so the recovery family
  // is not limited to walking to cells the body cannot reach. This is the same
  // CAN enumeration as every other entry here: Jev still chooses, and a refusal
  // is typed (`DIG_ROUTE_REFUSED`) instead of silent.
  const dig = digRouteCandidate(
    state,
    options,
    { target: goalTarget, targetName: null, reason: 'route_withheld' },
    digRefusals,
  )
  if (dig !== null && !out.some((candidate) => candidate.id === dig.id)) out.push(dig)
  // The same precondition as above, in the recovery family: when the dig route could
  // not be grounded at all, the adjacent WALL ENTRY is the other grounded way the
  // terrain can change. Ordinary MOVE-family candidates, offered beside everything
  // else - Jev chooses, and the `moveAdvancesTowardTarget` gate below never applies to
  // a DESCEND (it is a real terrain change, not a lateral walk).
  else if (dig === null) {
    const entries = wallEntryCandidates(
      state,
      options,
      { target: goalTarget, targetName: null, reason: 'route_withheld' },
      digRefusals,
    )
    for (const entry of entries.candidates) {
      if (!out.some((candidate) => candidate.id === entry.id)) out.push(entry)
    }
    // The third case, on the same precondition: nothing at the body's own level can be
    // walked OR opened, so the bounded LEVEL SCAN offers the own-column descent that starts a
    // route ending strictly closer to the real destination (see `levelScanCandidates`).
    if (entries.candidates.length === 0) {
      const levels = levelScanCandidates(
        state,
        options,
        { target: goalTarget, targetName: null, reason: 'route_withheld', skill: null },
        digRefusals,
      )
      for (const level of levels.candidates) {
        if (!out.some((candidate) => candidate.id === level.id)) out.push(level)
      }
    }
  }
  // No enclosing Skill owns this recovery family, so the vertical remedy here is an
  // ordinary candidate like every other: `MECHANICAL_CONTINUATION`, no section 7
  // prerequisite claim, no boundary ranking - Jev chooses. The walk to the advancing
  // cell above is still owned by the ordinary reachability/path machinery.
  {
    const vertical = verticalRemedyCandidates(state, options, {
      target: goalTarget,
      reason: 'route_withheld',
      skill: 'ROUTE_CONTINUATION',
    })
    for (const ascent of vertical.candidates) {
      if (!out.some((candidate) => candidate.id === ascent.id)) out.push(ascent)
    }
  }
  // The SAME blocker, the other grounded remedy: when the withheld target lies
  // across a gap (a landing cell with no support), the bounded bridge span changes
  // the route by PLACING a floor instead of removing rock. Grounded here as well as
  // in `travelApproachLegs`, so the capability is a general MOVE remedy for ANY
  // blocked locomotion target (a GOTO, a retrieve, a goalDrop approach) rather than
  // a portal-leg-only trick. No enclosing Skill owns this offer, so it is an
  // ordinary candidate: `MECHANICAL_CONTINUATION`, no section 7 prerequisite claim,
  // no boundary ranking - Jev chooses, and the `moveAdvancesTowardTarget` gate below
  // still owns the validity of every MOVE in this family.
  const bridge = groundBridgeLeg(state, options, { target: goalTarget, targetName: null }, false)
  if (bridge.plan !== null) {
    const bridged = bridgeLegCandidate(
      state,
      options,
      { target: goalTarget, targetName: null, reason: 'route_withheld', skill: null },
      bridge.plan,
      formatSkillStepAuthority(
        'MECHANICAL_CONTINUATION',
        `cell=${cellText(bridge.plan.landing)} place=${cellText(bridge.plan.place)} far=${cellText(bridge.plan.far)} ` +
          `dir=${bridge.plan.dir} block=${bridge.plan.block} span=${bridge.plan.span}`,
        'place_blocks=1',
        { budget: bridge.plan.span },
      ),
      null,
      null,
    )
    if (!out.some((candidate) => candidate.id === bridged.id)) out.push(bridged)
  }
  if (bridge.refusal !== null && out.length > 0) {
    const line = formatBridgeRefused(bridge.refusal)
    for (const leg of out) leg.meta[BRIDGE_REFUSED_META] = line
  }
  // The MIRROR remedy, one level down: when the withheld target lies BELOW the body
  // and its landing cell has no floor, the descent changes the route by PLACING the
  // floor it lands on instead of removing rock - the downward rotation of the same
  // bounded one-cell scaffold. Grounded on the sensor's own downward probe
  // (`state.descentScaffold`) plus a held placeable block, offered ALONGSIDE every
  // other remedy in this family (never instead of one), and it never digs. No
  // enclosing Skill owns this offer, so it is an ordinary candidate:
  // `MECHANICAL_CONTINUATION`, no section 7 prerequisite claim, no boundary ranking.
  const descentRemedy = descentRemedyCandidates(state, options, {
    target: goalTarget,
    targetName: null,
    reason: 'route_withheld',
    skill: null,
    walkable: false,
  })
  for (const descended of descentRemedy.candidates) {
    if (!out.some((candidate) => candidate.id === descended.id)) out.push(descended)
  }
  if (descentRemedy.refusalLine !== null && out.length > 0) {
    for (const leg of out) leg.meta[DESCEND_SCAFFOLD_REFUSED_META] = descentRemedy.refusalLine
  }
  // REVERTED (da7d66e): returning the unfiltered family when the advancing set is
  // empty stopped the WAIT wedge but produced a pacing loop - the operator watched
  // the body walk east/west at the same spot (live `pos` cycled 195.5 <-> 199) for
  // minutes, which burns time and tool durability without progress and hides the
  // stall. A barren set is the honest signal that no grounded progress exists; the
  // remaining work is to produce a real multi-leg route (walk a committed leg
  // toward the target, then re-plan) rather than to offer lateral wandering.
  return out.filter(
    (candidate) => candidate.kind !== 'MOVE' || moveAdvancesTowardTarget(state.self.position, candidate, goalTarget),
  )
}

/**
 * A route-continuation MOVE is an enabling fact only when it makes measurable
 * progress toward the exact locomotion target that was withheld.  This is a
 * validity gate, not a policy ranking: Jev still chooses among every surviving
 * candidate family.  A small epsilon avoids re-offering the current cell due
 * to fractional player coordinates.
 */
function moveAdvancesTowardTarget(
  current: Vec3Json,
  candidate: Candidate,
  blockedTarget: Vec3Json,
): boolean {
  if (candidate.target === null) return false
  // LIKE FOR LIKE: every candidate target is a CELL, so the current point must be
  // the body's own CELL too. Comparing a cell against the body's FRACTIONAL
  // position (the historical form) mis-measures a genuine one-cell advance whenever
  // the body does not stand at its cell's centre - measured (2026-09-23, a plain
  // MOVE across a void): a grounded SELF-LANDING scaffold toward a target one cell
  // over was dropped, because `distance(bodyFraction, target)` was smaller than
  // `distance(landingCell, target)` even though the step really is one cell closer
  // - which `bridgeRoute.ts#planBridgeSpan`'s own strict reduction already proved in
  // the same cell units (`to <= from - BRIDGE_MIN_ADVANCE`, both cells). The intent
  // is unchanged (a target that is NOT closer than the body's own cell is still
  // refused, so no lateral wandering), only the measurement is now consistent.
  const from = { x: Math.floor(current.x), y: Math.floor(current.y), z: Math.floor(current.z) }
  const currentDistance = distance(from, blockedTarget)
  const nextDistance = distance(candidate.target, blockedTarget)
  return nextDistance + 0.1 < currentDistance
}

/**
 * Route-continuation: a safe `level` step whose wall and head cells are already
 * clear has nothing left to dig, so `descendCandidates` (which requires a
 * diggable primary) emits no DESCEND for it. The step is still a mechanically
 * valid forward body change that continues the route the previous dig opened.
 * Enumerate its landing cell as an ordinary MOVE so one failed/opened route
 * attempt cannot collapse the next state to `presented=2 productive=0`
 * (live RC run-mu99dkap-19w1f: `DESCEND:level:E:b55_61_26` dug its column, then
 * the stock path returned `noPath` and the next state starved). Facts only: no
 * item/coordinate/portal special-casing, no ordering, and Jev still chooses.
 */
/** `safe` proves the step mechanics; MOVE also needs a passable body and usable support. */
function hasUsableLevelLanding(step: DescentOption): boolean {
  return step.mode === 'level' && step.safe && step.landingUsable === true
}

function openLevelStepMoves(state: WorldState, options: CandidateOptions): Candidate[] {
  const feet = {
    x: Math.floor(state.self.position.x),
    y: Math.floor(state.self.position.y),
    z: Math.floor(state.self.position.z),
  }
  const out: Candidate[] = []
  for (const step of state.descent ?? []) {
    if (!hasUsableLevelLanding(step)) continue
    // A solid wall or head is still a DESCEND owned by `descendCandidates`.
    if (step.wallSolid || step.headSolid) continue
    if (step.dx === 0 && step.dz === 0) continue
    const target = step.step
    if (target.x === feet.x && target.y === feet.y && target.z === feet.z) continue
    out.push(
      exploreMoveCandidate(
        state,
        options,
        target,
        moveLabel(target, 'step into the route the previous dig opened', state.self.position),
        null,
      ),
    )
  }
  return out
}

/**
 * Descent routes the world ALREADY has, so a staircase is not carved beside one.
 *
 * Two grounded facts, both of them world truth rather than a preference:
 *
 *   1. an opening the sensor can see beside the body - a `down` step whose floor
 *      cell is already air while the cell under it is solid. That is exactly the
 *      `open_floor` refusal, and its geometry is a one-block drop onto support, so
 *      it is a safe step down, not an uncontrolled fall. `hazardNearby` is checked
 *      separately because the refusal chain reports a single highest-priority
 *      reason (an `open_floor` step can still sit next to lava).
 *   2. the shaft the body itself carved and still remembers (`signals.lastTunnel`)
 *      when it is at least two blocks below the feet - the body climbed back up
 *      and the known route down is still there. It is offered with the existing
 *      `vertical: reuse` contract, so the executor validates the entry live and
 *      refuses it with a typed reason instead of walking into a wall.
 *
 * A DESCEND cannot express either one: a DESCEND is a DIG action, and these cells
 * have nothing left to dig. Both are therefore ordinary MOVEs. Reuse-before-carve
 * is expressed as enumeration order (existing routes first) and never as a
 * ranking: nothing is suppressed and Jev still chooses between walking the known
 * route and cutting a new step.
 */
function existingDescentRouteCandidates(state: WorldState, options: CandidateOptions): Candidate[] {
  const feet = {
    x: Math.floor(state.self.position.x),
    y: Math.floor(state.self.position.y),
    z: Math.floor(state.self.position.z),
  }
  const key = (cell: Vec3Json): string => `${cell.x}_${cell.y}_${cell.z}`
  const seen = new Set<string>()
  const out: Candidate[] = []
  for (const step of state.descent ?? []) {
    if (step.mode !== 'down') continue
    if (step.dx === 0 && step.dz === 0) continue
    if (step.refusal !== 'open_floor') continue
    if (step.supportSolid !== true) continue
    if (step.hazardNearby === true) continue
    if (step.wallSolid) continue
    const target = step.step
    if (target.y >= feet.y) continue
    const cellKey = key(target)
    if (seen.has(cellKey)) continue
    seen.add(cellKey)
    const candidate = exploreMoveCandidate(
      state,
      options,
      target,
      moveLabel(target, 'step down into the opening the world already has', state.self.position),
      null,
    )
    out.push({
      ...candidate,
      meta: {
        ...candidate.meta,
        verticalRecovery: 'open_shaft_step',
        shaftSource: 'sensed_open_floor',
      },
    })
  }
  const tunnel = state.signals.lastTunnel ?? null
  if (
    tunnel !== null &&
    tunnel.y <= feet.y - 2 &&
    distance(tunnel, state.self.position) <= (options.tunnelMaxDistance ?? DEFAULT_TUNNEL_MAX_DISTANCE) &&
    !seen.has(key(tunnel))
  ) {
    const targetY = state.goalQueue?.current?.targetY ?? tunnel.y
    const candidate = exploreMoveCandidate(
      state,
      options,
      tunnel,
      moveLabel(tunnel, 'descend through the shaft the body already dug', state.self.position),
      null,
    )
    out.push({
      ...candidate,
      meta: {
        ...candidate.meta,
        verticalRecovery: 'remembered_shaft',
        ...verticalPlanMeta({ kind: 'reuse', tunnel, fromY: feet.y, toY: Math.min(tunnel.y, targetY) }, feet.y, targetY),
        fallbackVertical: 'none',
      },
    })
  }
  return out
}

/**
 * The tool ITEMS that satisfy a missing-tool `capability` AND whose recipe
 * inputs the live inventory can obtain (weakest first). A tool the body cannot
 * make is not an answer to "acquire the missing capability", so the acquisition
 * pass enumerates every craftable-now item instead of only the weakest canonical
 * name. When NONE is craftable it returns the weakest satisfying name so the
 * existing ingredient route (collect the missing material) still runs rather
 * than collapsing to WAIT.
 *
 * The family is read from the capability, never assumed: pickaxes carry the
 * canonical material ladder (`PICKAXE_TIER_ORDER`, the one family the game gates
 * a harvest on in practice), and every other family is enumerated from the item
 * registry by its own suffix. Nothing here is pickaxe-specific except the tier
 * ordering the game itself defines for that family.
 *
 * CAN/producibility only (recipe truth), never a preference ranking: an offered
 * `craft:<tool>` is a grounded step the model still chooses between.
 */
function toolItemsForCapability(
  state: WorldState,
  options: CandidateOptions,
  capability: Capability,
): string[] {
  if (capability.kind !== 'tool') return []
  const suffix = `_${capability.tool}`
  const satisfying =
    capability.tool === 'pickaxe'
      ? PICKAXE_TIER_ORDER.filter((name) => (PICKAXE_RANKS[name] ?? -1) >= capability.tier)
      : Object.keys(loadGameData().itemsByName ?? {})
          .filter((name) => name.endsWith(suffix))
          .sort()
  if (satisfying.length === 0) return []
  const recipes = options.recipes ?? null
  if (recipes === null) return [satisfying[0]!]
  const hasRecipe = (name: string): boolean => recipes.recipesFor(name).length > 0
  // `tableAvailable: true` answers only "are the recipe's inputs obtainable": a
  // table needed for a 3x3 tier is itself a grounded step the craft path owns.
  const craftable = satisfying.filter(
    (name) => hasRecipe(name) && planNextCraftStep(recipes, name, state.inventory.counts, true).op !== null,
  )
  if (craftable.length > 0) return craftable
  // Nothing is craftable now. Name the weakest item of the family the recipe
  // index can actually make, so the ingredient route (collect the missing
  // material) runs; a family with NO recipe at all is not routable and stays a
  // typed refusal rather than a bogus craft step.
  const weakest = satisfying.find(hasRecipe)
  return weakest === undefined ? [] : [weakest]
}

function escalateRefusal(state: WorldState, withheld: readonly CandidateReachability[]): Candidate {
  const missing = [
    ...new Set(withheld.flatMap((entry) => entry.result.missingCapabilities.map(capabilityKey))),
  ]
  return {
    id: 'ESCALATE',
    kind: 'ESCALATE',
    label: `request System 2 review: no reachable candidate (missing: ${missing.join(',') || 'unknown'})`,
    targetName: null,
    target: null,
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: true,
    hasStandableAdjacent: true,
    affordance: { feasible: true, reason: 'reachable', missingCapabilities: [] },
    meta: { tick: state.tick, reason: 'reachability_refused', capabilities: missing.join('|') },
  }
}
