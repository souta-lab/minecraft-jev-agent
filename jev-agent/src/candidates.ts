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
//   ESCALATE             hand control to System 2
//
// Generation is GOAL-DIRECTED: the current goal-queue subgoal selects the
// resource to mine, the craft step to surface, or the smelt/place operation, so
// the list stays small and every entry makes progress. Safety actions
// (eat/retreat/attack) are always offered regardless of subgoal.
import type { CraftOp, RecipeIndex } from './crafting.ts'
import { describeCraftOp, planNextCraftStep } from './crafting.ts'
import type { BlockState, DescentOption, EntityState, KnownResource, StationEntry, Vec3Json, WorldState } from './state.ts'
import { bodyIsOutOfAir, CRAFT_STATIONS, DIRECT_BLOCK_SOURCES, FURNACE_STATIONS, NETHER_STRUCTURE_BLOCK_NAMES, PICKAXE_RANKS, placementSpotKey, STONE_YIELDS, distance, isSensedStation, scannedBlockNames } from './state.ts'
import { findInventoryFuel, inventoryFuels, isResourceClass, matchesResourceClass, resourceMatches } from './resourceClass.ts'
import type { InventoryFuel } from './resourceClass.ts'
import { isProtectedStationBlock, isLiveStructureMember, liveStructureCellKey, liveStructureMemberIndex } from './blockSafety.ts'
import { failureCount } from './failureMemory.ts'
import { selectDigTool } from './toolChoice.ts'
import { PILLAR_PLACE_PRIORITY, selectPlaceableBlock, planVerticalApproach, planVerticalApproachDetailed, pillarColumnUnsafeFromBlocks, evaluateAscentColumn, VERTICAL_GAP } from './verticalPlan.ts'
import type { UpwardRefusalReason, VerticalInput, VerticalPlan } from './verticalPlan.ts'
import { FURNACE_STONE_COST, knownStationKey, planPrereqOptions, prereqSubjectForGoal } from './prereqOption.ts'
import type { KnownStationLike, PrereqInput, PrereqPath, PrereqRankPolicy } from './prereqOption.ts'
import { pickBestDescendStep } from './descendPlan.ts'
import type { DescendScoreInput } from './descendPlan.ts'
import { DIG_PATH_CAP } from './worldMemory.ts'
import { fuelCountFor, loadGameData, resolveHarvest, smeltInputFor as smeltInputName, PICKAXE_TIER_ORDER, smeltInventorySufficient } from './gameData.ts'
import { ASCEND_GAP_LIMIT, bestToolTier, capabilityKey, DESCEND_GAP_LIMIT, evaluateReachability, HAZARD_PROXIMITY, INTERACTION_STAND_DY, INTERACTION_STAND_OFFSETS, interactionFaceDistance, missingToolCapability, reachabilityFingerprint } from './reachability.ts'
import type { Capability, DigAccessRefusal, DigApproachProbe, PathProbeResult, ReachabilityAbilities, ReachabilityBarrier, ReachabilityResult, ReachabilityTarget, ReachabilityWorld, StationApproachProbe } from './reachability.ts'
import { moveFailureKey, StateFingerprintMemory } from './moveFailMemory.ts'
import { MAX_DEPENDENCY_DEPTH, collectItemForClass, selectCraftIngredients } from './optionSpec.ts'
import type { CraftIngredientNeed } from './optionSpec.ts'
import {
  FLINT_AND_STEEL,
  NETHER_PORTAL,
  OBSIDIAN,
  PORTAL_ENTERED_PREDICATE,
  PORTAL_LIT_PREDICATE,
  groundPortalFrame,
  planPortalIgnition,
  serializePortalCells,
} from './netherPortalPlan.ts'
import type { PortalEntryPlan, PortalFrameValidation } from './netherPortalPlan.ts'
import { armorEquipOffers, armorEquipRefusals } from './gearPlan.ts'
import type { ArmorRefusal } from './gearPlan.ts'

export type CandidateKind =
  | 'MINE'
  | 'MOVE'
  | 'CRAFT'
  | 'PLACE'
  | 'SMELT'
  | 'IGNITE'
  | 'ENTER_PORTAL'
  | 'DESCEND'
  | 'STEP'
  | 'RETRIEVE'
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
  meta: Record<string, string | number | boolean>
}

/**
 * A work action is not a safe response to a hostile entity already inside
 * melee distance.  This is a hard safety envelope, not an attack preference:
 * Jev still chooses between the grounded ATTACK and RETREAT candidates.  The
 * envelope only removes MINE/MOVE/CRAFT/etc. while the threat is physically
 * immediate, so a slow policy call cannot leave the executor digging through
 * a hit window.
 */
export const IMMEDIATE_HOSTILE_RANGE = 3.2

/**
 * Farther hostiles remain world observations, but are not combat reactions.
 * The executor may follow an entity mechanically, yet offering a 20m+ attack
 * when the active goal is temporarily blocked turns Jev's pi choice into an
 * unproductive travel plan.  Within this envelope Jev still owns ATTACK versus
 * RETREAT; beyond it the next grounded goal/recovery candidate stays visible.
 */
export const COMBAT_CANDIDATE_RANGE = 8

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
 * P1 durability: a hostile that has actually engaged the bot is a
 * response-worthy threat far beyond melee range. A skeleton opens fire at
 * roughly 10-16m, which is inside neither `IMMEDIATE_HOSTILE_RANGE` (3.2m) nor
 * `COMBAT_CANDIDATE_RANGE` (8m); without this band Jev sees the attacker in
 * `entities` but has no grounded response at all, which is the observed
 * "does not react while being shot" failure. This only guarantees the option
 * set exists - ATTACK versus RETREAT remains Jev's choice.
 */
export const THREAT_RESPONSE_RANGE = 24

/** How long a damage observation keeps a hostile response-worthy. */
export const THREAT_MEMORY_MS = 8000

/**
 * Bound on distinct retreat destinations offered, so Jev can pick a direction
 * instead of being handed a single spot. Small and fixed so the candidate list
 * cannot be crowded by escape routes.
 */
export const MAX_RETREAT_CANDIDATES = 3

/**
 * Is this hostile a threat Jev must be able to answer? Code owns only the
 * grounded predicate; the choice of ATTACK/RETREAT stays with Jev.
 *
 *   immediate   - already inside melee range (unchanged behaviour)
 *   attributed  - the recorded damage source is this exact entity
 *   engaged     - the bot was damaged inside `THREAT_MEMORY_MS` and this
 *                 hostile has line of sight (used when Mineflayer did not
 *                 attribute the attacker; `lineOfSight === undefined` is
 *                 UNKNOWN and does not invent a threat)
 *
 * `nowMs` is injectable so the fixture does not depend on wall clock.
 */
export function isResponseWorthyThreat(
  state: Pick<WorldState, 'entities' | 'signals'>,
  entity: Pick<EntityState, 'id' | 'hostile' | 'distance' | 'attackedSelf' | 'lineOfSight'>,
  nowMs = Date.now(),
): boolean {
  if (!entity.hostile) return false
  if (!Number.isFinite(entity.distance) || entity.distance > THREAT_RESPONSE_RANGE) return false
  if (entity.distance <= IMMEDIATE_HOSTILE_RANGE) return true
  if (entity.attackedSelf === true) return true
  const last = state.signals.lastDamage ?? null
  if (last === null || !Number.isFinite(last.atMs) || nowMs - last.atMs > THREAT_MEMORY_MS) return false
  // Attribution unknown -> require positive sight evidence; never invent one.
  return entity.lineOfSight === true
}

export function restrictCandidatesDuringImmediateThreat(
  state: Pick<WorldState, 'entities'>,
  candidates: readonly Candidate[],
): Candidate[] {
  const immediateHostile = state.entities.some((entity) => entity.hostile && entity.distance <= IMMEDIATE_HOSTILE_RANGE)
  if (!immediateHostile) return [...candidates]
  const combat = candidates.filter(
    (candidate) => candidate.kind === 'ATTACK' || candidate.kind === 'RETREAT' || candidate.kind === 'ESCALATE',
  )
  // If perception has no grounded combat response, preserve the original set
  // and let the normal guard report the capability gap; never silently erase
  // all candidates or invent an attack target.
  return combat.length > 0 ? combat : [...candidates]
}

/**
 * A critical-health response must not silently fall back to an attack that was
 * already in flight.  The retreat candidate is still generated from sensed
 * terrain and Jev retains the choice between the grounded escape and an
 * escalation.  If perception cannot ground either response, preserve the
 * original set so the missing affordance remains observable.
 */
export function restrictCandidatesAtCriticalHealth(
  state: Pick<WorldState, 'entities' | 'self'>,
  candidates: readonly Candidate[],
): Candidate[] {
  const immediateHostile = state.entities.some(
    (entity) => entity.hostile && entity.distance <= IMMEDIATE_HOSTILE_RANGE,
  )
  if (!immediateHostile || state.self.health > CRITICAL_COMBAT_HEALTH) return [...candidates]
  const escape = candidates.filter((candidate) => candidate.kind === 'RETREAT' || candidate.kind === 'ESCALATE')
  return escape.length > 0 ? escape : [...candidates]
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
  if (!bodyIsOutOfAir(state.self)) return [...candidates]
  const rescue = candidates.filter((candidate) => SURVIVAL_KINDS.has(candidate.kind))
  return rescue.length > 0 ? rescue : [...candidates]
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

export interface CandidateReachability {
  candidate: Candidate
  result: ReachabilityResult
  fingerprint: string
  withheld: boolean
  suppressed: boolean
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
 * but is a member of a live structure the resident depends on. This is the
 * explicit fact that replaces silently dismantling the asset: the cell stays
 * unavailable while the structure validates, and the plan must source the item
 * elsewhere (other sensed/remembered cells, or exploration).
 *
 * Generic by construction: the reason is a membership predicate, and the
 * diagnostic `structure` field is never matched on.
 */
export type ResourceSourceExclusionReason = 'live_structure'

export interface ResourceSourceExclusion {
  /** the item the active collect goal wants */
  item: string
  cell: Vec3Json
  reason: ResourceSourceExclusionReason
  /** diagnostic structure kind only (never matched on) */
  structure: string
}

export const RESOURCE_SOURCE_EXCLUDED = 'RESOURCE_SOURCE_EXCLUDED'

export function formatResourceSourceExclusion(exclusion: ResourceSourceExclusion): string {
  return `${RESOURCE_SOURCE_EXCLUDED} item=${exclusion.item} cell=${exclusion.cell.x},${exclusion.cell.y},${exclusion.cell.z} reason=${exclusion.reason}`
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
  /** the grounded next step the mechanical layer can offer right now */
  next: 'explore' | 'escalate'
}

export const RESOURCE_SOURCE_NONE = 'RESOURCE_SOURCE_NONE'

export function formatResourceSourceGap(gap: ResourceSourceGap): string {
  return `${RESOURCE_SOURCE_NONE} item=${gap.item} reason=${gap.reason} sensed=${gap.sensed} remembered=${gap.remembered} falsified=${gap.falsified} excluded=${gap.excluded} next=${gap.next}`
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
 * The typed `RESOURCE_SOURCE_EXCLUDED` facts for the active collect goal: every
 * sensed or remembered source cell the generator would otherwise offer that is a
 * member of a live structure. Enumeration only - the actual refusal is applied
 * at the two source selectors (`mineCandidates` for sensed cells,
 * `knownResourceFor` for remembered cells), so the marker can never disagree
 * with the offered set.
 */
export function resourceSourceExclusions(state: WorldState): ResourceSourceExclusion[] {
  const index = liveStructureIndexOf(state)
  if (index.size === 0) return []
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
  const excluded = exclusions.filter((exclusion) => exclusion.item === want.item).length
  const falsified = (state.knownResourceEvidence ?? []).filter((evidence) => evidence.status === 'falsified').length
  const reason: ResourceSourceGapReason =
    sensedOpen > 0 || rememberedOpen > 0
      ? 'source_withheld'
      : falsified > 0
        ? 'remembered_falsified'
        : excluded > 0
          ? 'live_structure'
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
    next,
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
export function entryCandidates(
  state: WorldState,
  options: CandidateOptions,
): { candidates: Candidate[]; refusal: PortalEntryRefusal | null } {
  const current = state.goalQueue?.current ?? null
  const focusItem = current?.targetItem ?? state.goal.targetItem ?? null
  if (focusItem !== NETHER_PORTAL) return { candidates: [], refusal: null }
  if (current?.targetPredicate !== PORTAL_ENTERED_PREDICATE) return { candidates: [], refusal: null }
  const plan = options.portalEntry ?? null
  if (plan === null) return { candidates: [], refusal: null }
  if (!plan.ok) return { candidates: [], refusal: { reason: plan.reason, line: plan.line } }
  const entry = plan.candidate
  return {
    candidates: [
      {
        id: entry.id,
        kind: 'ENTER_PORTAL',
        label: `walk into the lit nether portal at (${entry.enterCell.x},${entry.enterCell.y},${entry.enterCell.z}) and transfer to ${entry.dimension}`,
        targetName: NETHER_PORTAL,
        // The interior cell itself is the locomotion target: the generic MOVE
        // machinery walks the body in (standing in a portal block is the world
        // mechanic that transfers). ENTER_PORTAL carries no bespoke approach.
        target: entry.enterCell,
        targetEntityId: null,
        itemName: null,
        requiresTool: false,
        toolName: null,
        inReach: distance(entry.enterCell, state.self.eyePosition) <= options.reach,
        hasStandableAdjacent: true,
        meta: {
          tick: state.tick,
          enterX: entry.enterCell.x,
          enterY: entry.enterCell.y,
          enterZ: entry.enterCell.z,
          dimension: entry.dimension,
          portalCells: serializePortalCells(entry.portalCells),
        },
      },
    ],
    refusal: null,
  }
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
  eatBelowFood: 18,
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

/**
 * Deterministic Minecraft producer truth for mob-drop collect goals. This table
 * answers CAN/TRUE only: when the active collect target is one of these items,
 * every currently sensed producer is exposed as a grounded ATTACK alternative.
 * Jev still owns WHICH producer/action to pursue.
 */
const MOB_DROP_PRODUCERS: Readonly<Record<string, ReadonlySet<string>>> = {
  ender_pearl: new Set(['enderman']),
  blaze_rod: new Set(['blaze']),
}

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

function moveToBlockLabel(block: BlockState, spot: Vec3Json): string {
  const where = `(${block.position.x},${block.position.y},${block.position.z})`
  const tool = block.harvestTool === null ? 'hand-harvestable' : `needs a ${block.harvestTool}`
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
  const raw = generateRawCandidates(state, options)
  return applyReachabilityGate(
    raw.candidates,
    state,
    options,
    raw.placeRefusal,
    raw.ignitionRefusal,
    raw.entryRefusal,
    raw.armorRefusals,
    raw.surfaceAscentRefusal,
    raw.sourceExclusions,
  )
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
 */
function hasAdvancingGoalRoute(candidate: Candidate): boolean {
  if (candidate.meta.clearance === true) return false
  switch (candidate.kind) {
    case 'WAIT':
    case 'ESCALATE':
    case 'RETREAT':
    case 'EAT':
    case 'EQUIP':
      return false
    case 'ATTACK':
      // A `goalDrop` ATTACK is the direct grounded producer route for the active
      // mob-drop collect goal (the executor verifies the kill and the drop);
      // ordinary combat is a local reaction, not a goal route.
      return typeof candidate.meta.goalDrop === 'string'
    case 'DESCEND':
      return candidate.meta.grounded === true
    default:
      return true
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

function generateRawCandidates(
  state: WorldState,
  options: CandidateOptions = defaultCandidateOptions,
): RawCandidatesResult {
  let candidates: Candidate[] = []
  let placeRefusal: PlaceRefusal | null = null
  let ignitionRefusal: IgnitionRefusal | null = null
  let entryRefusal: PortalEntryRefusal | null = null
  const armorRefusals = armorEquipRefusals(state.self.armor, state.inventory.counts)
  const current = state.goalQueue?.current ?? null
  const focusItem = current?.targetItem ?? state.goal.targetItem ?? null
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
      const entry = entryCandidates(state, options)
      candidates.push(...entry.candidates)
      entryRefusal = entry.refusal
      break
    }
    default:
      candidates.push(...mineCandidates(state, options, focusItem, descendTargetY))
      break
  }

  // A `surface` goal's vertical route (the leg the goal exists for). Computed
  // here so the typed refusal is available even when the family offers nothing,
  // and appended after the explore fallback below so the level-move enumeration
  // and the clearance filter are unchanged: CAN enumeration, never an override
  // and never a rank.
  const surfaceAscent = surfaceAscentCandidates(state, options)

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

  const hostiles = state.entities.filter(
    (entity) => entity.hostile && entity.distance <= COMBAT_CANDIDATE_RANGE,
  )
  // Goal-directed mob drops: when the ACTIVE collect goal targets an item whose
  // only producer is a mob (`ender_pearl` <- enderman, `blaze_rod` <- blaze),
  // expose every sensed producer as a grounded ATTACK candidate. This is
  // producer truth (CAN), never a preference: Jev still owns WHICH
  // producer/action to pursue, and the `goalDrop` meta is what makes the
  // executor verify a real kill plus the wanted drop (see `runAttack`).
  const producerNames = focusItem === null || goalKind !== 'collect' ? undefined : MOB_DROP_PRODUCERS[focusItem]
  const goalDropTargets =
    producerNames === undefined ? [] : state.entities.filter((entity) => producerNames.has(entity.name))
  const goalDropByEntity = new Set(goalDropTargets.map((entity) => entity.id))
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
  const attackTargets = [...hostiles, ...huntTargets]
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
  for (const entity of attackTargets) {
    const isFoodTarget = huntTargets.includes(entity)
    const goalDrop = goalDropByEntity.has(entity.id) ? focusItem : null
    candidates.push({
      id: `ATTACK:e${entity.id}`,
      kind: 'ATTACK',
      label:
        goalDrop === null
          ? `attack ${entity.name} ${entity.distance}m away at (${entity.position.x},${entity.position.y},${entity.position.z})`
          : `hunt ${entity.name} ${entity.distance}m away for ${goalDrop} at (${entity.position.x},${entity.position.y},${entity.position.z})`,
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
        ...(goalDrop === null ? {} : { goalDrop, requiresKill: true }),
        // Typed CAN fact: this ATTACK is the grounded route to food, and which
        // animal it targets. The marker reader/log must not infer it from the
        // entity name alone (a hostile and a food animal can share no name).
        ...(isFoodTarget ? { foodAnimal: true, foodRoute: 'animal', foodTarget: entity.name } : {}),
      },
    })
  }

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

  // Armor-equip affordance: offered alongside the other local self-care actions
  // (EAT/ATTACK/RETREAT), independent of the active goal. The generator reports
  // CAN; Jev owns whether the body puts on better armor this tick.
  candidates.push(...armorEquipCandidates(state))

  const danger = nearestDanger(state, HAZARD_DANGER_RADIUS)
  // Response-worthy threats include ranged attackers that have already engaged
  // the bot, not just the melee-immediate ones. This is the P1 durability fix:
  // a skeleton shooting from 10m previously produced neither ATTACK (8m cap) nor
  // RETREAT (3.2m cap), so Jev could only WAIT/MOVE while being hit.
  const responseThreats = state.entities
    .filter((entity) => isResponseWorthyThreat(state, entity, state.timestampMs))
    .sort((a, b) => a.distance - b.distance)
  const primaryThreat = responseThreats[0] ?? null
  const retreats = pickRetreats(
    state,
    state.terrain.standable,
    danger,
    responseThreats,
    options.blacklistedMoveTargets,
  )
  for (const retreat of retreats) {
    candidates.push({
      id: `RETREAT:${blockId('p', retreat)}`,
      kind: 'RETREAT',
      label: moveLabel(retreat, 'retreat to safety', state.self.position),
      targetName: null,
      target: retreat,
      targetEntityId: null,
      itemName: null,
      requiresTool: false,
      toolName: null,
      inReach: distance(retreat, state.self.position) <= options.reach,
      hasStandableAdjacent: true,
      meta: {
        tick: state.tick,
        x: retreat.x,
        y: retreat.y,
        z: retreat.z,
        ...(primaryThreat === null
          ? {}
          : {
              threatEntityId: primaryThreat.id,
              threatName: primaryThreat.name,
              threatDistance: primaryThreat.distance,
              separation: Math.round(distance(retreat, primaryThreat.position) * 100) / 100,
              ...(primaryThreat.attackedSelf === true ? { threatAttackedSelf: true } : {}),
              ...(primaryThreat.heldItem != null ? { threatHeldItem: primaryThreat.heldItem } : {}),
            }),
      },
    })
  }

  // A known-resource retrieval is grounded even when other (non-progressing)
  // candidates exist: if the wanted block is not visible but its coordinate is
  // remembered, going there is strictly better than re-issuing the front goal.
  // Once the active goal already has a grounded route, however, do not admit a
  // retrieval for a later queue row into this Option. That is a different
  // semantic action, not an alternative mechanical route for the active goal;
  // it was observed live as raw_iron -> unrelated future log retrieval.
  candidates.push(...retrievalCandidates(state, options, focusItem, candidates.length === 0))

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
  const declaredProducerNeedsExploration =
    goalKind === 'collect' &&
    descendTargetY === null &&
    focusItem !== null &&
    !isResourceClass(focusItem) &&
    (DIRECT_BLOCK_SOURCES[focusItem] !== undefined || MOB_DROP_PRODUCERS[focusItem] !== undefined)
  if (candidates.length === 0 || (declaredProducerNeedsExploration && !hasAdvancingRoute)) {
    candidates.push(...exploreFallbackCandidates(state, options, focusItem, goalKind))
  }
  candidates.push(...surfaceAscent.candidates)

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

  if (state.signals.escalationRecommended) {
    candidates.push({
      id: 'ESCALATE',
      kind: 'ESCALATE',
      label: `hand control to System 2 (${state.signals.lastFailureCode ?? 'unknown trigger'})`,
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
    surfaceAscentRefusal: surfaceAscent.refusal,
    sourceExclusions: resourceSourceExclusions(state),
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

function digAccessMove(state: WorldState, block: BlockState, stand: Vec3Json): Candidate {
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
  const matching = mineable.filter(
    (block) =>
      focusItem === null ||
      resourceMatches(block.yield, focusItem) ||
      (sourceNames?.includes(block.name) ?? false),
  )
  const fallback =
    focusItem === null && matching.length === 0 ? mineable.filter((block) => block.kind === 'log') : matching
  const pool = fallback
  const mineActions: Candidate[] = []
  const moveActions: Candidate[] = []
  const accessActions: Candidate[] = []
  const tunnelTargets: BlockState[] = []
  let moveCount = 0
  const self = state.self.position

  for (const block of pool) {
    if (mineActions.length + moveActions.length + accessActions.length >= options.maxMineCandidates) break
    if (!block.diggable) continue
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
    if (!hasTool(state, harvestTool, tier)) continue

    const requiresTool = harvestTool !== null
    const baseMeta = {
      tick: state.tick,
      x: block.position.x,
      y: block.position.y,
      z: block.position.z,
      diggable: block.diggable,
      yieldItem: block.yield ?? block.name,
      ...(block.kind === 'log' ? { [LOG_ROUTE_META]: 'mine_sensed' } : {}),
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
    if (block.inReach && block.visible !== false && pickupSafe) {
      mineActions.push({
        id: `MINE:${blockId('b', block.position)}`,
        kind: 'MINE',
        label: mineLabel(block),
        targetName: block.name,
        target: block.position,
        targetEntityId: null,
        itemName: null,
        requiresTool,
        toolName: harvestTool,
        toolTier: tier,
        inReach: true,
        hasStandableAdjacent: block.hasAdjacentStandable,
        meta: { ...baseMeta, requiresPickup },
      })
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
        label: moveToBlockLabel(block, spot),
        targetName: block.name,
        target: spot,
        targetEntityId: null,
        itemName: null,
        requiresTool,
        toolName: harvestTool,
        toolTier: tier,
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
        accessActions.push(digAccessMove(state, block, stand))
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
    candidates.push(...descent)
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
  const self = state.self.position
  const feet = { x: Math.floor(self.x), y: Math.floor(self.y), z: Math.floor(self.z) }
  if (targetY - self.y <= VERTICAL_GAP) return { candidates: [], refusal: null }
  // The same own-column target the controller's pure plan refusal uses
  // (`ascentRefusedByPlan`), so the offered candidate and the refusal describe
  // the same plan.
  const target = { x: feet.x, y: targetY, z: feet.z }
  const decision = planVerticalApproachDetailed(verticalInputFor(state, target))
  if (decision.plan === null) {
    const refusal = decision.ascentRefusal
    if (refusal === null) return { candidates: [], refusal: null }
    return {
      candidates: [],
      refusal: {
        reason: refusal.reason,
        goalId: current.id,
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
    ...verticalPlanMeta(plan, feet.y, targetY),
    ...(plan.kind === 'reuse' ? fallbackVerticalMeta(tunnelFallback) : {}),
  }
  const digTool =
    plan.kind === 'staircase'
      ? selectDigTool(
          {
            name: plan.digName ?? '',
            harvestTool: plan.harvestTool ?? null,
            harvestTier: plan.harvestTier ?? null,
            diggable: true,
          },
          (tool, tier) => hasTool(state, tool, tier),
        )
      : null
  return {
    candidates: [
      {
        id: `ASCEND:surface:${blockId('p', targetCell)}`,
        kind: 'MOVE',
        label: `ascend toward the surface y>=${targetY}${verticalPlanLabel(plan)}`,
        targetName: null,
        target: targetCell,
        targetEntityId: null,
        itemName: null,
        // The plan itself already proved the dig is executable (`selectUpStep`
        // checks `canDigBlock` against the live inventory), so an up-staircase
        // needs no separate tool gate here.
        requiresTool: plan.kind === 'staircase',
        toolName: digTool !== null && digTool.ok ? digTool.tool : null,
        toolTier: plan.kind === 'staircase' ? plan.harvestTier : null,
        inReach: distance(targetCell, state.self.eyePosition) <= options.reach,
        hasStandableAdjacent: true,
        meta: {
          tick: state.tick,
          x: targetCell.x,
          y: targetCell.y,
          z: targetCell.z,
          surfaceAscent: true,
          surfaceGoalId: current.id,
          ascentTargetY: targetY,
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
  const cuts = (state.headroomCuts ?? []).filter(
    (cut) =>
      cut.safe && failureCount(state.signals.failedCandidates, `MINE:${blockId('b', cut.pos)}`) < failureLimit,
  )
  if (cuts.length === 0) return []
  const feet = {
    x: Math.floor(state.self.position.x),
    y: Math.floor(state.self.position.y),
    z: Math.floor(state.self.position.z),
  }
  return cuts.slice(0, 2).map((cut) => ({
    id: `MINE:${blockId('b', cut.pos)}`,
    kind: 'MINE' as const,
    label: `mine the ${cut.name} ceiling block at (${cut.pos.x},${cut.pos.y},${cut.pos.z}) to open jump headroom and escape the pocket`,
    targetName: cut.name,
    target: cut.pos,
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: distance(cut.pos, state.self.eyePosition) <= options.reach,
    hasStandableAdjacent: true,
    meta: {
      tick: state.tick,
      x: cut.pos.x,
      y: cut.pos.y,
      z: cut.pos.z,
      clearance: true,
      requiresPickup: false,
      yieldItem: cut.name,
      distance: Math.hypot(cut.pos.x + 0.5 - feet.x, cut.pos.z + 0.5 - feet.z),
    },
  }))
}

/**
 * A `STEP` candidate removes the upper block of an adjacent 2-block vertical
 * face, turning it into a 1-block step. Without it the offered MOVE stand spot
 * is behind a rise no vanilla client can climb (jump apex 1.2522), so the route
 * is simply not executable.
 */
function stepCutCandidates(state: WorldState, options: CandidateOptions): Candidate[] {
  const cuts = (state.stepCuts ?? []).filter((cut) => cut.safe && !isProtectedStationBlock(cut.name))
  if (cuts.length === 0) return []
  const focus = state.goalQueue?.current?.targetItem ?? state.goal.targetItem ?? null
  const target = nearestResource(state, focus)
  const feet = {
    x: Math.floor(state.self.position.x),
    y: Math.floor(state.self.position.y),
    z: Math.floor(state.self.position.z),
  }
  const scored: Array<{ cut: NonNullable<WorldState['stepCuts']>[number]; score: number }> = []
  for (const cut of cuts) {
    const known = state.blocks.find(
      (block) =>
        block.position.x === cut.cut.x && block.position.y === cut.cut.y && block.position.z === cut.cut.z,
    )
    const tool = known?.harvestTool ?? null
    if (!hasTool(state, tool, tool === null ? null : known?.harvestTier ?? null)) continue
    let penalty = 0
    if (target !== null) {
      const tdx = target.position.x - feet.x
      const tdz = target.position.z - feet.z
      const dot = cut.dx * Math.sign(tdx) + cut.dz * Math.sign(tdz)
      penalty = dot > 0 ? 0 : 10
    }
    scored.push({ cut, score: penalty + distance(cut.step, state.self.position) })
  }
  if (scored.length === 0) return []
  scored.sort((a, b) => a.score - b.score)

  return scored.slice(0, 2).map(({ cut }) => {
    const known = state.blocks.find(
      (block) =>
        block.position.x === cut.cut.x && block.position.y === cut.cut.y && block.position.z === cut.cut.z,
    )
    const tool = known?.harvestTool ?? null
    return {
      id: `STEP:${cut.dir}:${blockId('b', cut.cut)}`,
      kind: 'STEP' as const,
      label: `cut a 1-block step into the ${cut.name} face (${cut.dir}) at (${cut.cut.x},${cut.cut.y},${cut.cut.z}); the blocked route becomes climbable`,
      targetName: cut.name,
      target: cut.cut,
      targetEntityId: null,
      itemName: null,
      requiresTool: tool !== null,
      toolName: tool,
      toolTier: known?.harvestTier ?? null,
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
 * no-progress budget (`signals.descendLimitReached`) stops runaway descent.
 *
 * #4: once a dig direction is chosen it is held until the resource appears or the
 * `DIG_PATH_CAP` is reached, so the path cannot zigzag. Oscillation forces a
 * straight downward staircase.
 */
function descendCandidates(
  state: WorldState,
  options: CandidateOptions,
  focusItem: string | null,
  tunnelTargets: readonly BlockState[],
  descendTargetY: number | null = null,
): Candidate[] {
  if (focusItem === null && descendTargetY === null) return []
  // #41: the no-progress latch caps runaway descent for *item* goals. A predicate
  // `descend_to:Y=<n>` is the objective itself; suppressing its only body change
  // is exactly the permanent WAIT this issue fixes. The controller's stall
  // assertion bounds a genuinely impossible descent instead.
  // When the latch fires, the next valid mechanical move is a lateral search
  // step, not a semantic replan. Preserve safe level steps while suppressing
  // only further down steps. Returning [] here made the controller manufacture
  // `ESCALATE`, which promoted local route starvation into a Mercury mission
  // switch and left the active Option behind a control-only loop.
  const lateralSearchOnly = state.signals.descendLimitReached === true && descendTargetY === null
  const steps = (state.descent ?? []).filter(
    (step) =>
      step.safe &&
      !isProtectedStationBlock(step.digName ?? '') &&
      (!lateralSearchOnly || step.mode !== 'down'),
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
  const wantDown = descendToY || targetBelow || (target === null && downEvidence)
  const hasTunnelTarget = tunnelTargets.length > 0
  const oscillate = state.signals.digOscillate === true
  const fixedDir = state.signals.digDir ?? null
  const fixedCount = state.signals.digDirCount ?? 0

  let pool = steps.filter((step) => downEvidence || oscillate || step.mode !== 'down')
  if (oscillate) {
    pool = pool.filter((step) => step.mode === 'down' && (fixedDir === null || step.dir === fixedDir))
  } else if (fixedDir !== null && fixedCount > 0 && fixedCount < DIG_PATH_CAP) {
    pool = pool.filter((step) => step.dir === fixedDir)
  }
  if (pool.length === 0) pool = steps.filter((step) => downEvidence || oscillate || step.mode !== 'down')
  if (pool.length === 0) return []

  const scoreInput: DescendScoreInput = {
    wantDown,
    hasTunnelTarget,
    predicateDescend: descendTargetY !== null,
    target: target === null ? null : target.position,
    feet,
  }
  const notFailed = pool.filter(
    (step) =>
      failureCount(state.signals.failedCandidates, descendId(step)) <
      (options.descendFailureLimit ?? DEFAULT_CANDIDATE_DESCEND_FAILURE_LIMIT),
  )
  let best = pickBestDescendStep(notFailed, scoreInput)
  if (best === null && descendTargetY !== null) {
    // A predicate goal must yield a body change rather than WAIT. Retry over the
    // full safe pool even when stale failure memory suppressed every step; the
    // controller's DESCEND_STALLED assertion bounds a genuinely impossible descent.
    best = pickBestDescendStep(pool, scoreInput)
  }
  if (best === null) return []

  const primary = best.mode === 'down' ? best.floor : best.wallSolid ? best.wall : best.head
  // A DESCEND is a ROUTE only when the world grounds it: a sensed/tunnel target,
  // an explicit predicate, a remembered stone level below (for an underground
  // source), or a stone-class focus. Otherwise it is a blind search step, and
  // the declared-source exploration fallback may run beside it.
  const grounded = descendToY || hasGoalTarget || knownStoneBelow || stoneGoal
  const choice = selectDigTool(
    {
      name: best.digName ?? '',
      harvestTool: best.digHarvestTool ?? null,
      harvestTier: best.digHarvestTier ?? null,
      diggable: best.diggable === true,
    },
    (tool, tier) => hasTool(state, tool, tier),
  )
  if (!choice.ok) return []

  return [
    {
      id: descendId(best),
      kind: 'DESCEND',
      label: `${best.dir === 'D' ? 'dig straight down' : best.mode === 'down' ? 'dig a staircase step down' : 'tunnel one block forward'} toward ${focusItem ?? (descendTargetY === null ? 'unknown' : `descend_to:Y=${descendTargetY}`)} (${best.dir}), dig (${primary.x},${primary.y},${primary.z}) then stand at (${best.step.x},${best.step.y},${best.step.z})`,
      targetName: focusItem,
      target: primary,
      targetEntityId: null,
      itemName: null,
      requiresTool: choice.tool !== null,
      toolName: choice.tool,
      toolTier: choice.tier,
      inReach: distance(primary, state.self.eyePosition) <= options.reach,
      hasStandableAdjacent: true,
      meta: {
        tick: state.tick,
        mode: best.mode,
        dir: best.dir,
        dx: best.dx,
        dz: best.dz,
        focusItem: focusItem ?? 'unknown',
        predicate: descendTargetY === null ? 'none' : `descend_to:Y=${descendTargetY}`,
        descendTargetY: descendTargetY ?? 'none',
        digBlockName: best.digName ?? 'unknown',
        toolReason: choice.reason,
        staircase: oscillate || (best.mode === 'down' && fixedCount === 0),
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
        digX: primary.x,
        digY: primary.y,
        digZ: primary.z,
        diggable: true,
        safe: best.safe,
        grounded,
      },
    },
  ]
}

function descendId(step: DescentOption): string {
  const primary = step.mode === 'down' ? step.floor : step.wall
  return `DESCEND:${step.mode}:${step.dir}:${blockId('b', primary)}`
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
  candidates: Candidate[]
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
  if (raw === null) return { item: focusItem, missing: missingLabel, producer: 'none', candidates: [], depthBoundHit: false }
  return {
    item: focusItem,
    missing: missingLabel,
    producer: `collect ${raw.spec}`,
    candidates: collectRouteCandidates(state, options, raw.spec),
    depthBoundHit: raw.depthBoundHit,
  }
}

/** The one-line `CRAFT_INGREDIENT_PREREQ` record for a craft goal's missing ingredient. */
export interface CraftIngredientPrereqLine {
  /** the craft goal's item, e.g. `wooden_pickaxe` */
  item: string
  /** the missing ingredient (`birch_planks`), or the plan's next intermediate */
  missing: string
  /** `craft <item>` for a satisfiable step, else `collect <spec>` (or `none`) */
  producer: string
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
  return { item, missing: route.missing, producer: route.producer, depthBoundHit: route.depthBoundHit }
}

export function formatCraftIngredientPrereq(entry: CraftIngredientPrereqLine): string {
  const bound = entry.depthBoundHit ? ' depth=bound' : ''
  return `CRAFT_INGREDIENT_PREREQ item=${entry.item} missing=${entry.missing} producer=${entry.producer}${bound}`
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
  /** typed ascent refusal for a `surface` goal with no grounded vertical route */
  surfaceAscentRefusal: SurfaceAscentRefusal | null
  /** live-structure member cells refused as sources for the active collect goal */
  sourceExclusions: ResourceSourceExclusion[]
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
  return [
    {
      id: `PLACE:${focusItem}:${blockId('p', spot)}`,
      kind: 'PLACE',
      label: `place ${focusItem} at (${spot.x},${spot.y},${spot.z}), ${distance(spot, state.self.position)}m away`,
      targetName: focusItem,
      target: spot,
      targetEntityId: null,
      itemName: focusItem,
      requiresTool: false,
      toolName: null,
      inReach: distance(spot, state.self.eyePosition) <= options.reach,
      hasStandableAdjacent: true,
      meta: { tick: state.tick, x: spot.x, y: spot.y, z: spot.z },
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
  kind: 'furnace' | 'crafting_table',
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
  const probe = options.reachability?.pathProbe ?? null
  if (probe === null) return explicit
  const walkable: { position: Vec3Json; key: string; walk: number }[] = []
  for (const entry of state.furnaces ?? []) {
    const position: Vec3Json = { x: entry.x, y: entry.y, z: entry.z }
    const walk = distance(position, state.self.eyePosition)
    if (walk <= options.reach) continue
    walkable.push({ position, key: knownStationKey({ name: 'furnace', position }), walk })
  }
  walkable.sort((a, b) => a.walk - b.walk)
  let extended: Set<string> | null = null
  for (const station of walkable.slice(0, STATION_WALK_PROBE_BUDGET)) {
    if (explicit.has(station.key)) continue
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
  if (direct.inReach) return [direct]
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
   * `signals.knownResources` records. These are the cells that block a duplicate
   * station craft (see `stationCraftAllowed`).
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
 * retrieval ladder can be sent to, and a blacklisted one still EXISTS - it is
 * exactly the case the rule must not answer with a duplicate craft, so it is
 * reported as the typed `craftStationGap` instead.
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
 * Crafting a station item is a correct route only when the world model holds no
 * DURABLE station of that kind and none is held (see `stationWorldTruth` for why
 * a sensed cell is not part of that decision).
 */
export function stationCraftAllowed(truth: StationWorldTruth): boolean {
  return truth.remembered.length === 0 && truth.held === 0
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
    placementSpot: state.placementSpots.length > 0 ? leastFailedPlacementSpot(state, 'furnace') : null,
    knownStation: reachableFurnace ?? furnaces[0] ?? null,
    unreachableStations,
    self: state.self.position,
    rankPolicy: options.prereqRankPolicy,
  }
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
  if (source === null) return []
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
  return {
    selfFeetY: state.self.position.y,
    selfPosition: state.self.position,
    target,
    tunnel: state.signals.lastTunnel,
    descent: state.descent,
    stepCuts: state.stepCuts,
    placeable: selectPlaceableBlock(state.inventory.counts),
    columnSafe: !pillarColumnUnsafeFromBlocks(state.self.position, state.blocks),
    inventory: state.inventory.counts,
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
 */
const STRUCTURE_FABRIC_NAMES: ReadonlySet<string> = new Set(NETHER_STRUCTURE_BLOCK_NAMES)

function isStructureFabricSource(blockNames: readonly string[]): boolean {
  return blockNames.length > 0 && blockNames.every((name) => STRUCTURE_FABRIC_NAMES.has(name))
}

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
  } else if (current.kind !== 'smelt' && includeQueued && allowsQueuedRetrievalProxy(current)) {
    const rows = state.goalQueue.goals
    const currentIndex = rows.findIndex((queued) => queued.id === current.id)
    if (currentIndex >= 0) {
      const next = rows
        .slice(currentIndex + 1)
        .find((queued) => queued.status !== 'done' && queued.status !== 'impossible')
      if (next !== undefined) push(next.targetItem, goalWantsFuel(next), next)
    }
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
    const matches = want.kind === 'log' ? resource.name.endsWith('_log') : want.blockNames.includes(resource.name)
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
 * in the dimension it was scanned in. Entries written before the field existed
 * carry no dimension and remain valid (backwards compatible); an entry whose
 * recorded dimension differs from the bot's current one is NEVER offered as a
 * retrieval target. This is a world-truth filter, not a preference: the cell is
 * a different place in a different dimension.
 */
export function resourceDimensionMatches(resource: KnownResource, dimension: string): boolean {
  if (resource.dimension === undefined || resource.dimension.length === 0) return true
  const normalize = (value: string): string => value.replace(/^minecraft:/, '').toLowerCase()
  return normalize(resource.dimension) === normalize(dimension)
}

function retrievalCandidatesForWant(state: WorldState, options: CandidateOptions, want: RetrievalWant): Candidate[] {
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
    return [
      {
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
      },
    ]
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
): Candidate[] {
  const recipes = options.recipes ?? null
  const queuedProxy = allowsQueuedRetrievalProxy(state.goalQueue?.current ?? null)
  for (const want of retrievalNeeds(state, focusItem, includeQueued)) {
    // The explicit descent proxy intentionally exposes the next unresolved
    // prerequisite even though its item differs from the proxy's cobblestone
    // focus.  Every ordinary row remains focus-bounded.
    if (!queuedProxy && !retrievalWantAdvancesFocus(focusItem, want, recipes)) continue
    const candidates = retrievalCandidatesForWant(state, options, want)
    if (candidates.length > 0) return candidates
  }
  return []
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
  return matchesResourceClass(name, 'food')
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
 * Ranked retreat destinations. The first entry is the spot with the greatest
 * separation from the nearest response-worthy threat; up to
 * `MAX_RETREAT_CANDIDATES` are returned so Jev can choose a direction instead of
 * receiving one pre-picked spot. Every returned spot must *increase* separation
 * from an immediate/attributed threat, so a retreat can never be a re-labeled
 * MOVE. With no sensed threat the original hazard/self escape semantics are
 * preserved.
 */
function pickRetreats(
  state: WorldState,
  standable: Vec3Json[],
  danger: BlockState | null,
  threats: readonly EntityState[],
  blacklistedMoveTargets: ReadonlySet<string> | undefined,
): Vec3Json[] {
  const hurt = state.self.health <= CRITICAL_COMBAT_HEALTH
  if (danger === null && threats.length === 0 && !hurt) return []
  const hostile = threats.length > 0 ? threats[0] ?? null : null
  const threat = danger?.position ?? hostile?.position ?? state.self.position
  const currentThreatDistance = hostile === null ? null : distance(state.self.position, hostile.position)
  const scored: Array<{ spot: Vec3Json; separation: number }> = []
  for (const spot of standable) {
    if (isBlacklistedMoveTarget(state, blacklistedMoveTargets, spot)) continue
    scored.push({ spot, separation: distance(spot, threat) })
  }
  if (scored.length === 0) return []
  scored.sort((a, b) => b.separation - a.separation)
  const qualifying =
    hostile !== null
      ? scored.filter((entry) => currentThreatDistance !== null && entry.separation > currentThreatDistance + 0.25)
      : scored.filter((entry) => entry.separation >= HAZARD_DANGER_RADIUS)
  return qualifying.slice(0, MAX_RETREAT_CANDIDATES).map((entry) => entry.spot)
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
      distance(spot, state.self.position) > 1.5 &&
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
  state: WorldState,
  blacklistedMoveTargets: ReadonlySet<string> | undefined,
  position: Vec3Json,
): boolean {
  return blacklistedMoveTargets?.has(moveFailureKey(state.self.dimension, position)) ?? false
}

function exploreMoveCandidate(
  state: WorldState,
  options: CandidateOptions,
  spot: Vec3Json,
  label: string,
  logRoute: LogRouteMode | null,
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
  const out = [
    exploreMoveCandidate(
      state,
      options,
      best,
      moveLabel(best, 'walk toward unexplored terrain', state.self.position),
      logRoute,
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
  if (focus === null || isResourceClass(focus)) return null
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
    (entry) => entry.candidate.kind === 'MOVE' || entry.candidate.kind === 'RETRIEVE',
  )
  const frontierExists = state.terrain.standable.some(
    (spot) => distance(spot, state.self.position) > 1.5,
  )
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
  sourceExclusions: ResourceSourceExclusion[] | null = null,
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
  const acquisitions = capabilityAcquisitionCandidates(
    state,
    options,
    withheld,
    new Set(presented.map((candidate) => candidate.id)),
  )
  run(acquisitions)

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
    run(selfContainedCraftCandidates(state, options).filter((candidate) => !seen.has(candidate.id)))
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
  const hasGroundedGoalRoute = presented.some(
    (candidate) =>
      candidate.kind !== 'WAIT' &&
      candidate.kind !== 'ESCALATE' &&
      (candidate.kind !== 'ATTACK' || typeof candidate.meta.goalDrop === 'string') &&
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
    surfaceAscentRefusal,
    sourceExclusions: exclusions,
    exploreRouteBlocked: exploreRouteBlockedFact(state, candidates, withheld),
    sourceGap: resourceSourceGapFor(state, candidates, exclusions),
  }
}

/** null when the candidate carries no capability precondition of its own. */
function evaluateCandidate(
  candidate: Candidate,
  context: ReachabilityGateContext,
): CandidateReachability | null {
  const position = candidate.target
  if (position === null || !REACHABILITY_GATED_KINDS.has(candidate.kind)) return null
  // Portal entry owns a bounded approach phase in the executor. A GoalBlock
  // probe treats the non-solid portal interior as unpathable and withholds the
  // only ENTER candidate before that approach can establish a stand beside the
  // frame. The live lit/standable preconditions remain code-owned in
  // planPortalEntry; executor verification still requires the dimension change.
  if (candidate.kind === 'ENTER_PORTAL') return null
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
  // run that plan. Every other locomotion candidate must have a current path
  // fact when the host provides one. A standable destination alone is not a
  // route: the live M2 wedge showed MOVE candidates whose destination was
  // grounded but whose pathfinder timed out and whose control-walk had no jump
  // headroom.
  const probe = hasVerticalPlan(candidate)
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
): CandidateReachability {
  return {
    candidate: withAffordance(candidate, result),
    result,
    fingerprint: reachabilityFingerprint({
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
  const block =
    cell === null
      ? undefined
      : state.blocks.find(
          (entry) => entry.position.x === cell.x && entry.position.y === cell.y && entry.position.z === cell.z,
        )
  if (block === undefined || block.harvestTool == null) return null
  return {
    position: block.position,
    name: block.name,
    requiredTool: block.harvestTool,
    requiredTier: block.harvestTier ?? null,
  }
}

function columnFacts(state: WorldState): ColumnFacts {
  const feet = {
    x: Math.floor(state.self.position.x),
    y: Math.floor(state.self.position.y),
    z: Math.floor(state.self.position.z),
  }
  const ownCut = (state.headroomCuts ?? []).find(
    (cut) => cut.pos.x === feet.x && cut.pos.z === feet.z && (cut.pos.y === feet.y + 1 || cut.pos.y === feet.y + 2),
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
  return {
    self: state.self.position,
    approach: candidate.hasStandableAdjacent ? position : null,
    reach,
    hazardAtTarget:
      position !== null &&
      state.blocks.some((block) => block.kind === 'hazard' && distance(block.position, position) <= HAZARD_PROXIMITY),
    footingSolid: column.footingSolid,
    headroomClear: column.headroomClear,
  }
}

export function deriveReachabilityAbilities(
  state: WorldState,
  target: Vec3Json,
  column: ColumnFacts = columnFacts(state),
): ReachabilityAbilities {
  const counts = state.inventory.counts
  const dy = Math.round(target.y - state.self.position.y)
  const plan = planVerticalApproach({
    selfFeetY: state.self.position.y,
    selfPosition: state.self.position,
    target,
    tunnel: state.signals.lastTunnel,
    descent: state.descent,
    stepCuts: state.stepCuts,
    placeable: column.placeable,
    columnSafe: column.columnSafe,
    inventory: counts,
  })

  // The ascent column is a FACT, not a plan: an adjacent/forward cell whose
  // 2-block body column one level up is clear (walkable step) or clearable
  // (one diggable blocker + the held tool) with solid support and no hazard.
  const ascent = evaluateAscentColumn({
    selfFeetY: state.self.position.y,
    selfPosition: state.self.position,
    target,
    stepCuts: state.stepCuts,
    standable: state.terrain.standable,
    hazards: state.blocks.filter((block) => block.kind === 'hazard').map((block) => block.position),
    inventory: counts,
  })

  // A plan counts as an available ascend only when it is mechanically
  // executable NOW: a pillar needs a supported, safe column with jump headroom;
  // an up-staircase needs the held tool for the block it cuts, or the executor
  // would walk into a dig it cannot finish (`RETRIEVE staircase cannot dig`).
  const ascendPlanAvailable =
    (plan !== null &&
      (plan.kind !== 'pillar' || (column.columnSafe && column.footingSolid && column.headroomClear)) &&
      (plan.kind !== 'staircase-up' || ascent.kind !== 'refuse')) ||
    ascent.kind === 'clear'

  const ascendMissing: Capability[] = []
  if (dy > ASCEND_GAP_LIMIT && !ascendPlanAvailable) {
    if (column.placeable === null) ascendMissing.push({ kind: 'placeable_block' })
    if (!column.headroomClear) {
      // The blocked jump cell is the binding immediate fact; the acquisition
      // pass offers its clearance, so the column is not additionally refused.
      ascendMissing.push({ kind: 'headroom', cell: column.headroomCell })
      const cell = column.headroomCell
      const blocker =
        cell === null
          ? undefined
          : state.blocks.find(
              (block) =>
                block.position.x === cell.x && block.position.y === cell.y && block.position.z === cell.z,
            )
      if (blocker?.harvestTool != null) {
        const tier = blocker.harvestTier ?? 0
        if (bestToolTier(counts, blocker.harvestTool) < tier) {
          ascendMissing.push({ kind: 'tool', tool: blocker.harvestTool, tier })
        }
      }
    } else if (ascent.kind === 'refuse') {
      // Name the specific absent fact (`safe_column:no_clearance@x,y,z` /
      // `safe_column:no_tool@x,y,z:pickaxe@n`) instead of a bare token.
      const requiredTool = ascent.blocker?.requiredTool ?? null
      ascendMissing.push({
        kind: 'safe_column',
        reason: ascent.reason,
        cell: ascent.cell,
        tool: requiredTool,
        tier: ascent.blocker?.requiredTier ?? null,
      })
      if (ascent.reason === 'no_tool' && requiredTool !== null) {
        ascendMissing.push({ kind: 'tool', tool: requiredTool, tier: ascent.blocker?.requiredTier ?? 0 })
      }
    }
    if (ascendMissing.length === 0) ascendMissing.push({ kind: 'ascend_plan' })
  }

  const descendMissing: Capability[] = []
  if (dy < -DESCEND_GAP_LIMIT) {
    if (plan === null) {
      descendMissing.push({ kind: 'descend_plan' })
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

/** Grounded candidates that would acquire a withheld target's missing capability. */
function capabilityAcquisitionCandidates(
  state: WorldState,
  options: CandidateOptions,
  withheld: readonly CandidateReachability[],
  existingIds: ReadonlySet<string>,
): Candidate[] {
  const out: Candidate[] = []
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
        source = mineCandidates(
          state,
          options,
          null,
          null,
          (block) => typeof block.yield === 'string' && PILLAR_PLACE_PRIORITY.includes(block.yield),
        )
      } else if (capability.kind === 'tool') {
        const item = toolItemForCapability(capability)
        if (item !== null) source = craftCandidates(state, options, item).candidates
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
        source = routeOpeningCandidates(state, options, entry.candidate.target)
      } else if (capability.kind === 'descend_plan') {
        // A safe staircase can disappear after one bounded step when the bot
        // is standing on a canopy/ledge.  The sensor still proves a same-level
        // descent step, so expose that level move as the prerequisite action;
        // the next observation can then derive the next down plan.  Do not
        // invent a drop or an arbitrary exploration target here.
        source = (state.descent ?? [])
          .filter((step) => step.mode === 'level' && step.safe && step.floorSolid && (step.dx !== 0 || step.dz !== 0))
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
      }
      for (const candidate of source) {
        if (seen.has(candidate.id)) continue
        seen.add(candidate.id)
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
            missingCapability: capabilityKey(capability),
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
    }
  }
  return out
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
): Candidate[] {
  const focus = state.goalQueue?.current?.targetItem ?? state.goal.targetItem ?? null
  const out: Candidate[] = [
    ...stepCutCandidates(state, options),
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
  const currentDistance = distance(current, blockedTarget)
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
function openLevelStepMoves(state: WorldState, options: CandidateOptions): Candidate[] {
  const feet = {
    x: Math.floor(state.self.position.x),
    y: Math.floor(state.self.position.y),
    z: Math.floor(state.self.position.z),
  }
  const out: Candidate[] = []
  for (const step of state.descent ?? []) {
    if (step.mode !== 'level' || !step.safe) continue
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

function toolItemForCapability(capability: Capability): string | null {
  if (capability.kind !== 'tool' || capability.tool !== 'pickaxe') return null
  for (const name of PICKAXE_TIER_ORDER) {
    const rank = PICKAXE_RANKS[name]
    if (rank !== undefined && rank >= capability.tier) return name
  }
  return null
}

function escalateRefusal(state: WorldState, withheld: readonly CandidateReachability[]): Candidate {
  const missing = [
    ...new Set(withheld.flatMap((entry) => entry.result.missingCapabilities.map(capabilityKey))),
  ]
  return {
    id: 'ESCALATE',
    kind: 'ESCALATE',
    label: `hand control to System 2: no reachable candidate (missing: ${missing.join(',') || 'unknown'})`,
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
