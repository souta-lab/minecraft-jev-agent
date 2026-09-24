// state.ts - the SENSOR.
//
// Reads the live Mineflayer bot and produces a *structured JSON* world state
// (not prose). Jev consumes this object directly as its `state` argument.
//
// Shape: { self, inventory, entities, blocks, terrain, goal, recentEvents, signals }
// Everything here is plain JSON-serialisable data so it can be:
//   1. handed to the model verbatim,
//   2. written to the JSONL calibration log,
//   3. replayed in the pure guard unit test with no bot at all.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { LOW_AIR_LEVEL, MAX_AIR, observedAir } from './air.ts'
export { LOW_AIR_LEVEL, MAX_AIR, observedAir } from './air.ts'
import type { GoalQueueState } from './goalQueue.ts'
import type { CurrentOptionContext } from './optionSpec.ts'
import type { System2Outcome } from './system2.ts'
import type { StrategicStallEvidence } from './strategicStall.ts'
import type { ZeroProgressRoutes } from './zeroProgressRoute.ts'
import { CRITICAL_DAMAGE_HEALTH } from './criticalDamage.ts'
import type { CriticalDamageEvidence } from './criticalDamage.ts'
import {
  activeThreats,
  MIN_KEEP_DISTANCE_GAIN,
  retreatPreservesThreatSeparation,
  THREAT_ESCAPE_DY,
  THREAT_ESCAPE_MAX_CELLS,
  THREAT_MEMORY_MS,
  threatStandoffRange,
  UNSENSED_MIN_KEEP_DISTANCE_GAIN,
  UNSENSED_THREAT_ANCHOR_RANGE,
  unsensedAttackerFacts,
} from './threat.ts'
import type { ThreatEntityLike, ThreatStateEvidence } from './threat.ts'
import { resourceMatches } from './resourceClass.ts'
import { foodSourceSpecs } from './foodSources.ts'
import type { FoodSourceRegistry } from './foodSources.ts'
import { PICKAXE_TIER0, resolveHarvest } from './gameData.ts'
import type { GameDataRegistry } from './gameData.ts'
import {
  detectPortalVerification,
  isDimensionTransferBlock,
  isPortalIgnitionPostconditionMet,
  NETHER_PORTAL,
  OBSIDIAN,
  portalFrameCoreLiveStructureMembers,
  portalFrameLayout,
  portalFrameLiveStructureMembers,
  portalFrameNeedsTemporarySupport,
  validatePortalFrame,
} from './netherPortalPlan.ts'
import type { PortalBlockPosition, PortalFrameSite, PortalFrameValidation, PortalWidthAxis } from './netherPortalPlan.ts'
import { isProtectedStationBlock, liveStructureCellKey } from './blockSafety.ts'
import type { LiveStructureMember } from './blockSafety.ts'
import { PILLAR_PLACE_PRIORITY, selectPlaceableBlock } from './pillarSearch.ts'
import type { DescentScaffoldProbe } from './descentScaffold.ts'
import { ARMOR_SLOT_INDEX, ARMOR_SLOTS } from './gearPlan.ts'
import type { ArmorSlot } from './gearPlan.ts'
import { headroomAcrossFootprint } from './bodyGeometry.ts'
import { buildEnvHazardState, envHazardKindOfBlock } from './envHazard.ts'
import type { EnvHazardCell, EnvHazardState } from './envHazard.ts'
import { BRIDGE_DIRS, BRIDGE_PROBE_DEPTH, bridgeDirOffset, isBridgeUnsafeBlockName } from './bridgeRoute.ts'
import type { BridgeDir, BridgeProbe, BridgeProbeCell } from './bridgeRoute.ts'
import { WALL_DIRS, floodEvidence, isTunnelFloodBlockName } from './wallEntry.ts'
import type { WallBlockLike, WallCell, WallProbe } from './wallEntry.ts'
import { LEVEL_SCAN_MAX_LEVELS } from './levelScan.ts'
import type { LevelLateralFacts, LevelScanProbe } from './levelScan.ts'
import { CONTAINER_BLOCK_NAMES, isContainerBlockName, normalizeBlockName } from './containerAccess.ts'
import type { ContainerObservation } from './containerAccess.ts'

export type Vec3Json = {
  x: number
  y: number
  z: number
}

function portalCellKey(pos: Vec3Json): string {
  return `${pos.x}|${pos.y}|${pos.z}`
}

/**
 * Where a perceived station entry came from:
 *
 *  - `sensed`     the live block scan saw the station this tick inside the
 *                 near-field scan radius. Authoritative: a sensed entry also
 *                 replaces any remembered record for the same cell.
 *  - `remembered` a durable, host-validated station record (WorldMemory ->
 *                 `generation-entry.ts` injection -> controller options) merged
 *                 into perception. Station validation uses
 *                 `STATION_VALIDATION_RADIUS = 48` there, so a validated
 *                 station can be remembered from much farther than the bot can
 *                 see. It is real, but NOT proof the bot can see or reach it
 *                 right now.
 */
export type StationSource = 'sensed' | 'remembered'

/**
 * A perceived station: coordinates plus provenance (see `StationSource`).
 *
 * `name` is the station's own block name when the projection knows it (a sensed
 * container resolves its live block; a remembered one keeps the host-validated
 * name it was recorded with). It is optional so desktop/replay callers that
 * build a `WorldState` by hand keep the previous entry shape.
 */
export type StationEntry = Vec3Json & { source: StationSource; name?: string }

/**
 * True when the bot's own block scan saw this station this tick. In-place
 * preconditions (craft at a table, load a furnace) must use the sensed list
 * only: a remembered coordinate must never satisfy an in-reach requirement.
 */
export function isSensedStation(station: StationEntry): boolean {
  return station.source === 'sensed'
}

/**
 * A resource whose COORDINATE is remembered durably (issue #43: known-resource
 * retrieval). `name` is the block name at the remembered cell, `kind` the broad
 * class used to decide whether a retrieval is a surface trip (log/tree) or an
 * underground trip (ore). The coordinate is the block cell, not a stand spot;
 * the executor paths within a small radius and the next sensor tick re-offers
 * the normal MINE once the block is in range.
 */
export type KnownResource = {
  name: string
  /**
   * Broad class. `portal` (issue #80) is a durable verified-portal site: it is
   * inert to the ore/log/station retrieval matches and is consumed by
   * `rememberedPortalFrameSites` so the existing portal grounding/entry
   * machinery gets a grounded route back to the site. `structure` (#342) is a
   * durable Nether fortress site: the candidate layer matches it by block name
   * (`NETHER_STRUCTURE_BLOCK_NAMES`), giving a `blaze_rod` goal a route to the
   * remembered body without asserting the body yields a blaze rod.
   */
  kind: 'ore' | 'log' | 'station' | 'portal' | 'structure'
  position: Vec3Json
  /**
   * Issue #14: the coordinate is only meaningful in the world it was scanned in.
   * `dimension` and `worldEpoch` let the planner drop an entry that belongs to a
   * previous world/dimension instead of pathing to a stale cell. Optional so a
   * partially-written durable mirror from an older build still loads.
   */
  dimension?: string
  worldEpoch?: number
  /** #80: frame width axis for a `portal` entry (defaults to 'x'). */
  widthAxis?: PortalWidthAxis
  /**
   * #80: frame edge cells recorded with a `portal` entry. They let the sensor
   * re-project the durable site as a grounded `PortalFrameSite` so the existing
   * frame/light/entry grounding routes back to it. Geometry only, never a lit
   * verdict: `portalVerified` is still re-read from live block truth.
   */
  frameCells?: readonly Vec3Json[]
}

/**
 * Live-world verdict for ONE remembered resource cell (see
 * `probeKnownResources`). Positive replacement evidence, not absence:
 *
 *  - `present`   the memory is still true. For a `producer`/`drop` claim that
 *                means the live producer instance / dropped item was SENSED at
 *                the cell - the landmark block standing there is not the claim;
 *  - `replaced`  a same-family variant occupies the cell (iron_ore ->
 *                deepslate_iron_ore); the coordinate is still a valid route;
 *  - `falsified` the loaded world DISPROVES the claim, with the typed `reason`:
 *                `block_mined` (the block is gone/replaced), `mob_gone` (a
 *                landmark whose producers are absent from the entity envelope)
 *                or `drop_absent` (a remembered item stack nothing is holding);
 *  - `unknown`   no verdict: the chunk is unloaded, the cell is outside the
 *                evidence envelope the sensor actually covers, or the read
 *                failed. UNKNOWN is never absence.
 *
 * The verdict is world truth (CAN/TRUE), never a preference. It exists so a
 * collect goal cannot keep re-targeting a memory the loaded world contradicts.
 */
export type KnownResourceEvidenceStatus = 'present' | 'replaced' | 'falsified' | 'unknown'

/** Why the loaded world disproved a remembered cell; only ever set on `falsified`. */
export type KnownResourceFalsifiedReason =
  /** the cell no longer holds the remembered block (air/fluid/another block) */
  | 'block_mined'
  /** the landmark stands, but no producer instance is inside the entity envelope */
  | 'mob_gone'
  /** the cell was remembered as the item itself and nothing holds that item */
  | 'drop_absent'

export interface KnownResourceEvidence {
  /** block (or item) name the durable memory asserted */
  name: string
  position: Vec3Json
  /** live block name at the cell, or null when the chunk is unloaded */
  observed: string | null
  status: KnownResourceEvidenceStatus
  /** what the cell asserts, and therefore how it was verified */
  claim: KnownResourceClaim
  /** the want item this verdict was computed for */
  item: string
  /** why `falsified`; absent for every other status */
  reason?: KnownResourceFalsifiedReason
  /** the live evidence behind a `present` producer/drop verdict */
  source?: 'mob' | 'drop'
}

export type HeldItemState = {
  name: string
  count: number
  slot: number
}

/** Exact durability reported by the connected item's data when it has one. */
export type ObservedDurability = {
  /** damage already applied; null when the item/version does not report it */
  durabilityUsed: number | null
  /** maximum durability; null for non-damageable or unreported items */
  maxDurability: number | null
}

// Optional in hand-built state fixtures; `buildArmor` emits both fields on
// every observed worn piece, with null reserved for unavailable values.
export type ArmorPieceState = HeldItemState & Partial<ObservedDurability>

/**
 * Worn armor per destination. Built from the mineflayer player-window armor
 * slots (5-8), which `bot.inventory.items()` deliberately excludes: a WORN
 * piece is not a carried item, so `inventory.counts` never double-counts it.
 * `null` means nothing is worn in that slot.
 */
export type ArmorState = Record<ArmorSlot, ArmorPieceState | null>

/** The observed offhand slot, distinct from the selected main-hand item. */
export type OffhandState = ArmorPieceState

/** All armor slots empty. Exported so pure fixtures need not repeat the shape. */
export const EMPTY_ARMOR: ArmorState = { head: null, torso: null, legs: null, feet: null }

/** `dry` = body not in a fluid; `out_of_air` = breath at/below `LOW_AIR_LEVEL`. */
export type SubmersionState = 'dry' | 'submerged' | 'out_of_air'

/** The body's live water/breath facts, all mechanically sensed (no inference). */
export interface BodySubmersion {
  /** remaining breath, 0..`MAX_AIR`; null means Mineflayer did not observe it */
  air: number | null
  /** the cell the feet occupy holds a fluid */
  feetInWater: boolean
  /** the cell the eyes occupy holds a fluid - the head is underwater */
  eyesInWater: boolean
  state: SubmersionState
}

/** A bounded, observed two-cell-tall water/air position a submerged body can swim toward. */
export interface SubmersionEscapeTarget {
  position: Vec3Json
  feetBlock: string
  headBlock: string
}

/** Typed survival fact line; mirrored so a submerging body is never silent. */
export const BODY_SUBMERGED = 'BODY_SUBMERGED'

export function formatBodySubmerged(submersion: BodySubmersion, at: Vec3Json): string {
  const air = submersion.air === null ? 'unknown' : String(submersion.air)
  return `${BODY_SUBMERGED} state=${submersion.state} air=${air}/${MAX_AIR} feetWet=${submersion.feetInWater} headWet=${submersion.eyesInWater} at=${at.x},${at.y},${at.z}`
}

export type SelfState = {
  username: string
  position: Vec3Json
  eyePosition: Vec3Json
  yaw: number
  pitch: number
  onGround: boolean
  health: number
  food: number
  gameMode: string
  dimension: string
  isDay: boolean
  heldItem: HeldItemState | null
  /** Offhand window slot 45; undefined means this client/version did not expose it. */
  offhand?: OffhandState | null
  /**
   * Remaining breath (vanilla bubbles) and the two fluid cells that decide
   * whether the body is underwater. `null`/absent means the client did not
   * expose breath metadata; unknown is never promoted to full air.
   */
  air?: number | null
  feetInWater?: boolean
  eyesInWater?: boolean
  /**
   * SAFE: the body's own environmental hazard state (fire/lava/burning/
   * drowning), sensed from real block truth at the body's own column and the
   * adjacent cells plus Mineflayer's own on-fire flag (see `envHazard.ts`).
   * Optional so pure fixtures that predate the hazard facts need not restate
   * them: `buildSelf` always populates it and consumers treat an absent value
   * as "the sensor never observed a hazard" - which is exactly the
   * behaviour-preserving default.
   */
  envHazard?: EnvHazardState
  /**
   * Worn armor per destination. Optional so pure fixtures that predate the
   * armor affordance need not restate it; `buildWorldState` always populates it
   * and consumers treat an absent value as all slots empty.
   */
  armor?: ArmorState
}

/**
 * The body's submersion state, derived from the three sensed facts. Pure, so
 * the guard, the executor and the fixtures all read the same answer. Air
 * remains null when unobserved, while water occupancy is derived independently.
 */
export function bodySubmersion(
  self: Pick<SelfState, 'air' | 'feetInWater' | 'eyesInWater'>,
): BodySubmersion {
  const air = observedAir(self.air)
  const feetInWater = self.feetInWater === true
  const eyesInWater = self.eyesInWater === true
  const state: SubmersionState =
    air !== null && air <= LOW_AIR_LEVEL ? 'out_of_air' : feetInWater || eyesInWater ? 'submerged' : 'dry'
  return { air, feetInWater, eyesInWater, state }
}

/** true when the body is in a fluid (either the feet or the eyes cell). */
export function bodyIsSubmerged(self: Pick<SelfState, 'air' | 'feetInWater' | 'eyesInWater'>): boolean {
  const submersion = bodySubmersion(self)
  return submersion.feetInWater || submersion.eyesInWater
}

/**
 * true when breath is at/below `LOW_AIR_LEVEL`: the SAFE boundary where
 * surfacing must preempt the current mechanical action.
 */
export function bodyIsOutOfAir(self: Pick<SelfState, 'air' | 'feetInWater' | 'eyesInWater'>): boolean {
  return bodySubmersion(self).state === 'out_of_air'
}

/**
 * SAFE: an empty hunger bar at critical health is a body that IS taking
 * vanilla starvation damage right now (1 HP every 4 s), not an inference - the
 * measured `run-mubj6ucc-si3e` slide from 14 HP to 1 HP carried `food:0` and an
 * unattributed `delta:-1` on every `hp_changed`. `food` is required on
 * `SelfState` and `buildWorldState` always populates it, so there is no
 * pre-starvation fixture to keep unchanged by making this optional.
 *
 * `food <= STARVING_FOOD_LEVEL` (0) is the exact vanilla threshold for
 * starvation damage; the health floor reuses the single critical-health number
 * owned by `criticalDamage.ts`.
 */
export const STARVING_FOOD_LEVEL = 0

/**
 * The single eat gate default: below this food level the body wants food, so
 * the sensor scans for grounded food sources and the candidate layer offers
 * EAT/hunt/forage/cook routes. `defaultCandidateOptions.eatBelowFood` and the
 * controller's `logFoodState` threshold both read this number, so perception,
 * offer and marker can never disagree about what "hungry" means.
 */
export const DEFAULT_EAT_BELOW_FOOD = 18

export function bodyStarving(
  self: Pick<SelfState, 'food' | 'health'>,
  criticalHealth: number = CRITICAL_DAMAGE_HEALTH,
): boolean {
  return (
    Number.isFinite(self.food) &&
    self.food <= STARVING_FOOD_LEVEL &&
    Number.isFinite(self.health) &&
    self.health <= criticalHealth
  )
}

/** Typed survival fact line; mirrored so a starving body is never silent. */
export const BODY_STARVING = 'BODY_STARVING'

export function formatBodyStarving(self: Pick<SelfState, 'food' | 'health'>, at: Vec3Json): string {
  return `${formatBodyStarvingFact(self)} at=${at.x},${at.y},${at.z}`
}

/**
 * The position-free starvation fact. Same wording as {@link formatBodyStarving}
 * without the cell, so a consumer that keys on the string (the option title the
 * planner hands to System2, whose identity feeds the model-call cache) does not
 * see a new value every time the body moves one block.
 */
export function formatBodyStarvingFact(self: Pick<SelfState, 'food' | 'health'>): string {
  return `${BODY_STARVING} health=${self.health}/${CRITICAL_DAMAGE_HEALTH} food=${self.food} -> only routes that can end the starvation stay offered`
}

/** Stable `x_y_z` key for a placement spot, shared by the sensor fact, guard and generator. */
export function placementSpotKey(spot: Vec3Json): string {
  return `${spot.x}_${spot.y}_${spot.z}`
}

export type InventorySlotState = {
  name: string
  count: number
  slot: number
}

export type InventoryState = {
  slots: InventorySlotState[]
  /** item name -> total count across slots */
  counts: Record<string, number>
  totalItems: number
}

export type EntityState = {
  id: number
  name: string
  kind: string
  username: string | null
  position: Vec3Json
  distance: number
  hostile: boolean
  /**
   * Mechanical line of sight from the bot's eyes to this entity
   * (`bot.canSeeBlock` accepts anything with a `position`). `true` is positive
   * sight evidence; `false` means an occluder is between the bot and the entity;
   * `undefined`/absent means the sensor could not observe it this tick. Optional
   * so replay fixtures written before the threat context still type-check.
   */
  lineOfSight?: boolean
  /**
   * Item the entity is holding right now (its main equipment slot), or `null`
   * when it holds nothing. This is how an armed attacker (a skeleton with a bow)
   * becomes visible to the decision layer without inferring mob AI.
   */
  heldItem?: string | null
  /**
   * Health reported by Mineflayer for this entity, or `null` when the version
   * does not expose mob health. Absent `null` is UNKNOWN, not full health.
   */
  health?: number | null
  /**
   * The controller's recorded recent damage source *is* this entity. Attribution
   * truth from the `entityHurt` listener within the threat-memory window, never
   * an inference from proximity. Optional so old fixtures still type-check.
   */
  attackedSelf?: boolean
  /**
   * A dropped item is an ENTITY in the world (`entity.name === 'item'`), and this
   * is WHICH item it carries, decoded from its own spawn metadata
   * (`entity.getDroppedItem()`), or `null` when the entity is not a dropped item.
   *
   * The sensor previously reported the entity with its position but not its
   * identity, so the decision layer could see "some item is lying there" and
   * never "the `blaze_rod` this goal needs is lying there" - which is why a drop
   * that outlived the bounded executor pickup window had no route back into the
   * inventory. Only ever set for a dropped-item entity, so an ordinary tick's
   * entity shape is unchanged (fail closed: an undecodable item is `null`, never
   * an invented name).
   */
  droppedItem?: string | null
}

/**
 * The most recent damage event observed by the controller. `sourceId` /
 * `sourceName` are `null` when Mineflayer reported no attacker (environmental
 * damage); the candidate layer treats the damage recency as UNKNOWN attribution
 * and falls back to line-of-sight threats rather than inventing a source.
 */
export type LastDamageEvidence = {
  /** wall-clock ms of the damage observation */
  atMs: number
  /** bot health immediately after the hit */
  health: number
  sourceId: number | null
  sourceName: string | null
  /**
   * WHERE the damage came from, as the server stated it.
   *
   * `sourcePosition` is a field of the 1.20+ `damage_event` packet
   * (`minecraft-data` 1.21.x: `entityId, sourceTypeId, sourceCauseId,
   * sourceDirectId, sourcePosition`). Mineflayer's `entityHurt` drops it, so the
   * scheduler reads it off the packet before the event fires; a resolved source
   * entity's own position is the fallback when the server sent none.
   *
   * This is the ONE fact that lets the body ground a directional response to an
   * attacker it cannot see: without it, "move away from the attacker" has no
   * direction to be away FROM, and inventing one is forbidden. Absent/`null`
   * means the body genuinely does not know where the damage came from.
   */
  sourcePosition?: Vec3Json | null
}

/**
 * Coarse mechanical category of a scanned block. `'ore'` is the name-scanned
 * resource bucket: it covers both `ORE_SOURCES` (`_ore` blocks) and
 * `DIRECT_BLOCK_SOURCES` (name-scanned non-ore drops such as obsidian), which
 * the candidate layer treats identically for MINE/MOVE/DESCEND/retrieval.
 */
export type BlockKind = 'log' | 'stone' | 'ore' | 'hazard'

export type HarvestTool = 'pickaxe' | 'axe' | 'shovel'

/**
 * Rank of a pickaxe family: index 0 is the weakest that can harvest anything.
 * Owned by `gameData.ts` (#54); re-exported here so existing callers do not
 * change.
 */
export const PICKAXE_RANKS: Readonly<Record<string, number>> = PICKAXE_TIER0

export type BlockState = {
  kind: BlockKind
  name: string
  position: Vec3Json
  distance: number
  diggable: boolean
  /** target is already within `reach` of the bot's eyes */
  inReach: boolean
  /**
   * A solid, walkable spot exists next to this block. With
   * `movements.canDig = false` this is what makes a block physically minable:
   * the executor may only *walk* to it, never tunnel to it.
   */
  hasAdjacentStandable: boolean
  adjacentStandable: Vec3Json | null
  /** primary item this block drops when harvested (from minecraft-data) */
  yield?: string | null
  /** tool required for a useful drop; null means hand-harvestable */
  harvestTool?: HarvestTool | null
  /**
   * Minimum pickaxe rank required for a useful drop (see PICKAXE_RANKS), when
   * `harvestTool === 'pickaxe'`. Iron ore needs copper/stone+, diamond ore
   * needs iron+. Enforced so a wooden pickaxe never mines diamond for nothing.
   */
  harvestTier?: number | null
  /**
   * A straight line from the eyes reaches the block (`bot.canSeeBlock`). A
   * close but occluded block must not be offered as MINE: the server refuses to
   * dig through a wall, so it becomes a tunnel target instead.
   */
  visible?: boolean
  /**
   * Perception truth (`foodSources.ts`): this sensed block is a grounded route
   * to food, and how. `forage` yields an edible item directly; `acquire` yields
   * an item that is an ingredient of a recipe producing one. Set only for a
   * hungry body, so the extra scan is bounded by an actual need. The candidate
   * layer reads it only while the body still holds no edible item.
   */
  foodRoute?: 'forage' | 'acquire'
  /** the item this food-source block yields (edible, or an ingredient) */
  foodItem?: string
}

/** One pre-computed staircase/tunnel step in a cardinal direction. */
export type DescentMode = 'down' | 'level'

/**
 * Why a pre-computed descent step is NOT safe, as a TYPED mechanical fact (the
 * live `reason` string stays human-readable). `buildDescent` is the only place
 * with live block access, so it is the only place that can name which
 * precondition of a controlled descent is absent:
 *
 *   `unbreakable` the binding cell cannot be broken at all (bedrock/barrier);
 *   `no_support`  the landing cell has no solid support (falling into void);
 *   `open_floor`  the floor is already open, so the step is an uncontrolled fall;
 *   `hazard`      lava/water touches the step column;
 *   `protected`   the step would break a protected station block.
 *
 * A caller that must refuse a descent names this instead of a bare
 * `descend_plan` token, so the refusal is actionable (build a floor, pick
 * another direction, acquire a tool) rather than a retry loop.
 */
export type DescentRefusalReason = 'unbreakable' | 'no_support' | 'open_floor' | 'hazard' | 'protected'

/**
 * A single stair-cut that turns an unclimbable 2-block vertical face directly in
 * front of the bot into a 1-block step. `cut` is the upper block of the face (the
 * cell the bot will stand in afterwards), so `cut === step`.
 */
export type StepCut = {
  dir: 'E' | 'W' | 'N' | 'S'
  dx: number
  dz: number
  cut: Vec3Json
  step: Vec3Json
  name: string
  safe: boolean
  reason: string
}

/**
 * A cell in the local jump-headroom envelope. Usually this is a solid ceiling
 * block that can become a clearance MINE. A fail-closed unknown/unloaded cell is
 * also retained with `safe=false`, so CAN never turns missing world truth into
 * executable headroom.
 */
export type HeadroomCut = {
  /** the blocking/clearance cell (feet + 1 or feet + 2; never support) */
  pos: Vec3Json
  name: string
  safe: boolean
  reason: string
  /** true only when this cell blocks the CURRENT player AABB jump headroom */
  currentFootprint?: boolean
}

/** A cardinal stair direction, plus `D` for digging straight down the bot's column. */
export type DescentDir = 'E' | 'W' | 'N' | 'S' | 'D'

export type DescentOption = {
  dir: DescentDir
  mode: DescentMode
  dx: number
  dz: number
  /** cell the bot ends in after the step (feet position) */
  step: Vec3Json
  /** front cell at the current feet level; dug when solid */
  wall: Vec3Json
  /** head cell above the front cell; dug when solid (level mode) */
  head: Vec3Json
  /** support block under the step cell; dug to open the drop (down mode) */
  floor: Vec3Json
  wallSolid: boolean
  headSolid: boolean
  floorSolid: boolean
  /** solid block under the landing cell (`feet.y - 2`); false means the drop has no floor */
  supportSolid?: boolean
  /**
   * Canonical destination truth for the landing feet cell: both body cells are
   * passable and the support is usable ground. `safe` covers clearance and
   * support; it can still be true for a collidable leaf-supported landing.
   * Optional on legacy/hand-built states; movement recovery requires `true`.
   */
  landingUsable?: boolean
  /** lava/water is inside the 3x3x3 neighbourhood of one of this step's cells */
  hazardNearby?: boolean
  /**
   * SAFE: the cell the body would stand in after this step (or its head cell) is a
   * DIMENSION TRANSFER block (a lit portal plane). A mechanical dig/locomotion
   * realization never crosses a dimension - the measured Nether arrival stands beside
   * exactly such a plane, and a body that "tunnelled" into it would be teleported back
   * to the overworld. The sensor owns this block truth (the same
   * `isDimensionTransferBlock` the transfer cells come from), the dig route refuses to
   * make such a step its route, and `policy.ts#guardDescend` denies it as a last
   * boundary; the explicit `ENTER_PORTAL` candidate is the one route that may cross.
   */
  transfersDimension?: boolean
  /**
   * Every cell this step must remove for the landing cell to be ENTERABLE as a
   * 1x2 profile, with the per-cell harvest truth the tool gate needs.
   *
   * A staircase step down is not "dig the floor": the body must end up standing
   * in the landing cell, which occupies `feet.y - 1` (the floor cell, dug) AND
   * `feet.y` (the front cell, `wall`). Leaving `wall` solid makes the offered
   * step physically un-enterable even though every individual dig was legal -
   * the measured live failure (`PATH_CALLBACK ... outcome=noPath` then `stuck`
   * on every cardinal step, each dig followed by a silent heading switch).
   * `head` is deliberately NOT part of a `down` step: the body never stands at
   * the current feet level inside the front column.
   */
  digs?: DescentDigRequirement[]
  /** true when every dig in this step is safe (no lava/water/void, solid landing) */
  safe: boolean
  reason: string
  /**
   * Typed cause when `safe === false`; absent on legacy/hand-built fixtures.
   * `reason` remains the concrete human-readable fact (block name, cell).
   */
  refusal?: DescentRefusalReason
  /** concrete name of the primary cell this step digs (down=floor else wall/head) */
  digName?: string | null
  /** harvest family of the primary cell, resolved from the live block */
  digHarvestTool?: HarvestTool | null
  /** minimum pickaxe rank for the primary cell */
  digHarvestTier?: number | null
  /** primary cell is diggable right now */
  diggable?: boolean
}

/** One cell of a descent step's 1x2 profile, with its live harvest truth. */
export interface DescentDigRequirement {
  cell: Vec3Json
  name: string | null
  harvestTool: HarvestTool | null
  harvestTier: number | null
  diggable: boolean
}

/**
 * The primary cell of a step: the block the action's identity/tool gate is
 * derived from. Shared by the candidate id, the tool gate and the executor so
 * "which block is this step about" cannot drift between them.
 */
export function descentPrimaryCell(step: DescentOption): Vec3Json {
  if (step.mode === 'down') return step.floorSolid ? step.floor : step.wall
  return step.wallSolid ? step.wall : step.head
}

/**
 * The ordered dig plan of a step: every passage cell first, the primary/landing
 * cell LAST. Digging in this order means the drop is opened only after the
 * passage into it exists, so a dig can never strand the body in a hole it cannot
 * leave (the measured live bowl).
 *
 * `digs` is absent on hand-built/legacy fixtures, so the historical single
 * primary dig is the fallback - never an empty list, because a DESCEND with
 * nothing to dig is not a dig action.
 */
export function descentDigPlan(step: DescentOption): DescentDigRequirement[] {
  const primary = descentPrimaryCell(step)
  const fallback: DescentDigRequirement = {
    cell: primary,
    name: step.digName ?? null,
    harvestTool: step.digHarvestTool ?? null,
    harvestTier: step.digHarvestTier ?? null,
    diggable: step.diggable === true,
  }
  const list = step.digs !== undefined && step.digs.length > 0 ? step.digs : [fallback]
  const key = (cell: Vec3Json): string => `${cell.x}_${cell.y}_${cell.z}`
  const primaryKey = key(primary)
  const seen = new Set<string>([primaryKey])
  const passages: DescentDigRequirement[] = []
  for (const item of list) {
    const cellKey = key(item.cell)
    if (seen.has(cellKey)) continue
    seen.add(cellKey)
    passages.push(item)
  }
  const primaryItem = list.find((item) => key(item.cell) === primaryKey) ?? fallback
  return [...passages, primaryItem]
}

export type GoalState = {
  id: string
  description: string
  targetItem: string
  requiredCount: number
  /** how many the bot had when the goal started (so drops can be attributed) */
  startCount: number
  haveCount: number
  /** 0..1 */
  progress: number
  complete: boolean
  startedAtMs: number
}

export type PathStatus = 'idle' | 'success' | 'noPath' | 'timeout' | 'stuck'

/**
 * Deterministic, mechanically-derived signals. These drive candidate
 * generation, the guard and the escalation triggers, so `candidates.ts` and
 * `policy.ts` stay pure functions of the state.
 */
export type AgentSignals = {
  consecutiveFailures: number
  lastFailureCode: string | null
  lastPathStatus: PathStatus
  /** ms since goal progress last moved */
  stalledMs: number
  /** choice confidence reported by the last policy call (null for fallback) */
  lastPolicyConfidence: number | null
  maxConcurrentActions: number
  /** set by the controller when any escalation trigger has fired */
  escalationRecommended: boolean
  /**
   * candidate id -> recent failure count. Fed back into the policy so it stops
   * re-selecting a target that mechanically keeps failing (unreachable behind a
   * wall, stale coords, and so on). This is the "learned policy head" memory.
   * The controller also writes coarser spatial keys for movement candidates so a
   * nearby coordinate cannot evade the memory (#8a).
   */
  failedCandidates: Record<string, number>
  /**
   * Zero-observable-change route memory (see `zeroProgressRoute.ts`): the exact
   * route (kind, target cell, stand cell, route signature) that just proved it
   * changes nothing. The generator withholds that exact repeat, so the next
   * attempt for the target must differ in a grounded way (a different vertical
   * plan, a different stand cell, or a travel/approach leg), and a bounded number
   * of distinct zero-progress routes at one stand cell exhausts that family
   * there. Owned by the controller; absent means "nothing has failed yet", so
   * every pure caller keeps its existing behaviour.
   */
  zeroProgressRoutes?: ZeroProgressRoutes
  /** selected descent direction, retained while that mode/heading stays grounded */
  digDir?: DescentDir | null
  /** consecutive digs in the selected direction and mode (level paths are capped) */
  digDirCount?: number
  /** staircase depth (down steps) for the current dig path */
  digDepth?: number
  /** mode of the currently selected descent continuation (`down` or `level`) */
  digMode?: 'down' | 'level' | null
  /** true when the last 6 digs showed near-zero net displacement; policy chooses recovery */
  digOscillate?: boolean
  /** deepest stone/ore level observed (positive evidence for a staircase) */
  knownStoneY?: number | null
  /** last tunnel cell recorded by WorldMemory, for `REUSE_TUNNEL` */
  lastTunnel?: Vec3Json | null
  /** successful DESCEND actions in a row that produced zero resource progress */
  descendNoProgress?: number
  /** set once the bounded no-resource-progress evidence reaches its limit */
  descendLimitReached?: boolean
  /** durable known-resource coordinates injected by the host (issue #43) */
  knownResources?: KnownResource[]
  /**
   * #405: cells the body has recently occupied, maintained by the controller as a
   * bounded LRU. The generic exploration fallback must not offer a cell the body has
   * already stood on as "unexplored terrain", otherwise a reached cell immediately
   * becomes a frontier candidate again and the walk cycles between the same few cells.
   */
  exploredCells?: ReadonlySet<string>
  /**
   * #360: code-owned state-recurrence evidence for the ACTIVE Option. Verified
   * body motion that keeps returning to the same small set of states with zero
   * goal/search progress is strategic non-progress; the semantic layer needs
   * this to see a stalled Option that every other counter misses.
   */
  strategicNonProgress?: StrategicStallEvidence | null
  /**
   * SAFE: code-owned "the body is at critical health and one plan keeps
   * absorbing damage without ending it" evidence for the ACTIVE plan. The
   * candidate layer restricts the offer to routes that can end the damage and
   * the controller crosses the System2 boundary once per exhaustion with
   * `CRITICAL_DAMAGE_EXHAUSTED`. Optional for pure fixtures.
   */
  criticalDamage?: CriticalDamageEvidence | null
  /** #360: `OSCILLATION_DETECTED` count for the active Option instance. */
  oscillationsDetected?: number
  /**
   * #78: block key (`bX_Y_Z`) of a furnace the bot placed from a held item, so
   * the SMELT candidate can report `furnaceSource=held` to FURNACE_READY.
   */
  heldFurnacePlacedAt?: string | null
  /**
   * P1 durability: the most recent damage the controller observed, including
   * the Mineflayer-reported attacker when one exists. This is what lets the
   * decision layer see "I was just shot by e4965" instead of only a falling
   * health number. Optional for pure fixtures.
   */
  lastDamage?: LastDamageEvidence | null
  /**
   * SAFE: code-owned "the body is in a fight" state with a bounded exit (see
   * `threat.ts` `ThreatTracker`). It is a STATE, not a per-tick predicate: the
   * measured death loop (`run-mubobiq6-12onv`) had the body retreat once while a
   * zombie was inside 3.2 m and go straight back to digging the moment the mob
   * left that snapshot, then take the next hit until it died. The candidate
   * layer restricts work actions while this state is active; the choice among
   * the grounded survival actions stays with Jev. Optional for fixtures.
   */
  threat?: ThreatStateEvidence | null
}

export type WorldState = {
  schemaVersion: 1
  tick: number
  timestampMs: number
  self: SelfState
  inventory: InventoryState
  entities: EntityState[]
  blocks: BlockState[]
  /**
   * The spawn context of every mob the tick declared a producer for: where that
   * mob can exist, and whether the body's own column currently satisfies the
   * rule. Populated only when the active focus item has a declared mob producer
   * (`MOB_DROP_PRODUCERS`), so an ordinary tick carries no extra read and no
   * extra state. Absent means "no producer context was asked for", which is why
   * every pre-existing fixture stays behaviourally unchanged.
   */
  spawnContexts?: MobSpawnContextObservation[]
  terrain: {
    standable: Vec3Json[]
    /**
     * SAFE: standable cells from a wider scan that genuinely gain separation
     * from the nearest dangerous hostile (see `threat.ts`
     * `selectKeepDistanceSpots`). Populated only while a hostile is inside
     * `THREAT_DANGER_RADIUS`, because the ordinary `standable` window (5x5x3,
     * `buildTerrain`) can never contain a real retreat destination - that is why
     * every measured "retreat to safety" was 1.4-2.4 m away while the zombie was
     * inside 0.8 m. Absent in old replay fixtures means "no threat escape scan".
     */
    escapeCells?: Vec3Json[]
    /**
     * SAFE/CAN: cells from the same wider scan whose sight line to the nearest
     * dangerous hostile is BLOCKED by solid geometry (see
     * `KeepDistanceInput.occludedCells`). This is the fact that makes a ranged
     * attacker answerable: stepping out of an arrow's firing line is a genuine
     * keep-distance destination even when the room gives the body no separation.
     * Carried only while non-empty, so a body with no threat keeps exactly the
     * state shape it had before this fact existed.
     */
    threatCoverCells?: Vec3Json[]
    /**
     * SAFE: cells where standing realizes a DIMENSION TRANSFER (a lit portal
     * block; `netherPortalPlan.isDimensionTransferBlock`). Real block truth from
     * the scans the sensor already runs. A mechanical locomotion realization
     * (MOVE / RETRIEVE / RETREAT) must never stand the body in one - crossing a
     * dimension is a semantic disengage, and in a portal room a "retreat" into
     * the portal is the measured `the_nether -> overworld -> the_nether` loop.
     * Only the explicit `ENTER_PORTAL` candidate may cross. Carried only while
     * non-empty, so a body with no portal nearby keeps its previous state shape.
     */
    portalWalkInCells?: Vec3Json[]
  }
  /** placed crafting_table stations: sensed near-field first, then remembered */
  craftingTables: StationEntry[]
  /** placed furnace stations: sensed near-field first, then remembered (M2 smelting) */
  furnaces?: StationEntry[]
  /**
   * Container blocks (chest / trapped_chest / barrel / ender_chest / shulker
   * box + colour variants): sensed near-field first, then remembered. A
   * container is a station-approach target, never a resource: it is in
   * `PROTECTED_STATION_BLOCKS`, so no candidate family may mine it. Optional so
   * old replay fixtures keep their previous state shape (absent = none sensed).
   */
  containers?: StationEntry[]
  /**
   * The contents an OPEN action OBSERVED, per container cell. Absent or missing
   * an entry means UNKNOWN - never empty. `items: []` in an entry means the
   * container was opened and seen empty (the typed empty result).
   */
  containerContents?: ContainerObservation[]
  /** reachable air positions with solid support where a block could be placed */
  placementSpots: Vec3Json[]
  /**
   * The bounded cardinal forward probes a BRIDGE/scaffold grounding reads: for
   * each of the four horizontal faces, the live truth of the next
   * `BRIDGE_PROBE_DEPTH` columns (open / placeable / supported / standable /
   * hazard). Absent in old replay fixtures means "no probe", so every existing
   * caller and fixture is behaviourally unchanged (no probe grounds no bridge).
   */
  bridgeProbes?: BridgeProbe[]
  /**
   * The subset of `placementSpots` whose only body access is a fluid column:
   * placing there means the body stands in water. A station must not be placed
   * from a submerged body position while a dry alternative exists, so the
   * candidate layer withholds these spots when any dry-access spot is offered.
   * Absent in old replay fixtures means "none known", which keeps them
   * behaviourally unchanged.
   */
  submergedPlacementSpots?: Vec3Json[]
  /**
   * SAFE: the adjacent cells the environmental hazard scan classified from real
   * block truth (feet/head/support per cell + the water fact), populated only
   * while `self.envHazard.active` - an inactive body carries no cells, so the
   * non-hazard state stays exactly the shape it had. The candidate layer grounds
   * hazard escapes from these cells; they are deliberately NOT part of `self`
   * (the Jev snapshot keeps `self` whole, and 24 cells per tick must not grow
   * the prompt).
   */
  envHazardCells?: EnvHazardCell[]
  /**
   * SAFE/CAN: locally observed water/air cells above a low-air body whose feet
   * and head can both occupy the destination. These are swim waypoints, not
   * claims that the cell is breathable or a semantic surface goal. Only
   * populated for a submerged body below the low-air boundary; an empty array
   * means the bounded local sample found no waypoint.
   */
  submersionEscapeTargets?: SubmersionEscapeTarget[]
  /** complete, live-grounded Nether portal footprints; absent in old replay fixtures */
  portalFrameSites?: PortalFrameSite[]
  /** complete live frame validation, when a sensed site already has all required edges */
  portalFrame?: PortalFrameValidation | null
  /**
   * Cells that belong to a structure the world model currently holds as LIVE
   * (see `blockSafety.ts`). The sourcing layer refuses these cells as
   * collect/mine sources while their structure validates, so a `collect <item>`
   * goal cannot dismantle infrastructure the resident depends on. Absent in old
   * replay fixtures means "no live structures", which keeps them behaviourally
   * unchanged.
   */
  liveStructureMembers?: LiveStructureMember[]
  /**
   * #14-world-proof: the live-world verdict for remembered resource cells that
   * match the active focus. A `falsified` cell has already been removed from
   * `signals.knownResources` by the sensor, so no candidate family can offer it;
   * this list is the typed evidence the controller mirrors. Absent in old replay
   * fixtures means "no probe ran", which keeps them behaviourally unchanged.
   */
  knownResourceEvidence?: KnownResourceEvidence[]
  /** pre-computed staircase / tunnel steps around the bot (M2 descent) */
  descent?: DescentOption[]
  /**
   * The DOWNWARD self-landing probe (`descentScaffold.ts`): the live truth of the
   * cell the body would occupy if it placed a floor under its own feet and dropped
   * onto it. Present only while the body holds a placeable block AND its own
   * descent pool refused a downward step for `no_support` - the one shape no dig
   * can answer, and the measured live blocker (`descend_plan:no_support@25,78,-2:air`
   * 1912x with the body on a floated gate). Absent in old replay fixtures means
   * "no probe", so every existing caller and fixture is behaviourally unchanged.
   */
  descentScaffold?: DescentScaffoldProbe
  /**
   * The cardinal WALL ENTRY probes: the adjacent 1x2 profile the body could mine
   * open (`wallEntry.ts`), with the pre-existing floor it would stand on and the
   * six-neighbourhood that decides whether the dig could be flooded. Populated only
   * while a sensed step is refused by `hazard`/`no_support` - i.e. only where a walk
   * step is genuinely refused - so ordinary terrain carries no probe and the offer is
   * byte-identical there. Absent in old replay fixtures means "no probe", which
   * grounds no entry (never a false capability).
   */
  wallProbes?: WallProbe[]
  /**
   * The bounded LEVEL SCAN probes (`levelScan.ts`): the own-column descent into each of the
   * next `LEVEL_SCAN_MAX_LEVELS` levels below the body, plus the four same-level lateral
   * continuations AT each of them, with their pre-existing floors and the per-cell flood
   * verdict of every pocket. Populated under exactly the same gate as `wallProbes` (a sensed
   * step refused by the body's own local geology), so ordinary terrain carries no probe and
   * the offer is byte-identical there. Absent in old replay fixtures means "no scan", which
   * grounds no route (never a false capability).
   */
  levelScan?: LevelScanProbe[]
  /** pre-computed stair-cuts that open a 1-block step in a 2-block face */
  stepCuts?: StepCut[]
  /** ceiling blocks above the bot that block a jump (canopy pocket) */
  headroomCuts?: HeadroomCut[]
  goal: GoalState
  /** the long-horizon plan from System 2 (see goalQueue.ts), consumed by Jev */
  goalQueue: GoalQueueState
  /** #56: the exact compiled Option instance currently being evaluated by Jev */
  currentOption?: CurrentOptionContext | null
  /** Typed settled outcomes; Jev beta must see control vs body/search evidence. */
  recentOutcomes?: System2Outcome[]
  recentEvents: string[]
  signals: AgentSignals
}

/**
 * Is the DATA behind one world cell attributable to the dimension the body is
 * actually in?
 *
 * Mineflayer does not expose this. A column carries no world identity:
 * `prismarine-world` keys its store by `chunkX+','+chunkZ` alone, and Mineflayer's
 * cross-dimension invalidation is conditional and silent. So the answer has to be
 * established by observation, and it has three states - never two:
 *
 *   `attributable` the column was OBSERVED loading while the live dimension was
 *                  this one; the read stands;
 *   `foreign`      the column was observed loading under a DIFFERENT dimension;
 *   `unknown`      we cannot say (no live dimension, or a column loaded before we
 *                  started watching). Unknown is NOT satisfied.
 */
export interface CellAttribution {
  kind: 'attributable' | 'foreign' | 'unknown'
  /** Canonical dimension the column's data was loaded under; `''` when unknown. */
  dimension: string
  /** Canonical live dimension; `''` when unknown. */
  liveDimension: string
  /** The chunk column that owns the cell. */
  chunk: Vec3Json
  reason: 'foreign_column' | 'unknown_column' | 'unknown_live_dimension' | null
}

/** One refused world read, as handed to the provenance evidence sink. */
export interface RefusedRead {
  cell: Vec3Json
  chunk: Vec3Json
  /** Canonical dimension of the data we would have read; `''` when unknown. */
  provenance: string
  /** Canonical live dimension; `''` when unknown. */
  liveDimension: string
  reason: 'foreign_column' | 'unknown_column' | 'unknown_live_dimension'
  /** The sensor path that refused, for triage. */
  source: string
}

/**
 * The read-provenance capability the sensor requires of a world read. Absent
 * (`undefined`/`null`) means the caller cannot prove provenance, which keeps
 * every fixture, replay and non-resident caller on the un-gated path exactly as
 * before.
 */
export interface DimensionProvenance {
  /** Canonical live dimension, or `''` when unknown. */
  readonly liveDimension: string
  /** The verdict for the column that owns this world cell. */
  cellAttribution(x: number, z: number): CellAttribution
  /** Record a typed refusal; returns false when the sink is saturated. */
  refuseRead(input: RefusedRead): boolean
  /**
   * Re-read the live dimension and apply a transition if one happened. Optional so
   * a read-only double (fixtures) can answer provenance without owning a bot; the
   * sensor calls it once per build so a build never gates on a stale dimension.
   */
  syncLiveDimension?(reason: string): void
}

export interface SensorOptions {
  /** radius (blocks) searched for candidate blocks */
  scanRadius: number
  /** block interaction reach, measured from the eyes */
  reach: number
  maxLogs: number
  maxEntities: number
  maxTerrain: number
  hazardRadius: number
  entityRadius: number
  /**
   * Radius (blocks) that HOSTILE entities stay visible in even when they are
   * beyond `entityRadius`. `entityRadius` bounds the general entity budget (food
   * animals, item entities, other players); it must not also bound the safety
   * layer, because the Nether's ranged attacker outranges it: a ghast opens fire
   * from up to 64 m, so a body with a 24 m entity radius is shelled by an
   * invisible mob. Measured live (`run-muc3qbug-18vg3`, the 18 s Nether death
   * window) the ghast that took the body from 9.5 HP to 7.5 HP never appeared in
   * a single sensor line: `mob_appeared` only ever listed a skeleton at 94 m and
   * magma cubes at 95-100 m. Widening HOSTILE perception is truth, not policy:
   * it grounds no action by itself.
   */
  hostileRadius: number
  maxStoneBlocks: number
  maxPlacementSpots: number
  /**
   * The eat gate the candidate layer uses. The sensor scans for grounded food
   * sources (edible blocks and recipe-ingredient blocks) only while the live
   * hunger bar is at or below this level, so the extra scan is bounded by an
   * actual need. Defaults to `DEFAULT_EAT_BELOW_FOOD`.
   */
  eatBelowFood?: number
  /**
   * Radius (blocks) of the threat escape scan: standable cells used only as
   * keep-distance destinations for the nearest active hostile, including an
   * engaged ranged threat outside `THREAT_DANGER_RADIUS`. Wider than the
   * 5x5x3 `maxTerrain` window because a retreat destination inside that window
   * cannot leave melee reach or a nearby ranged attacker's standoff envelope.
   */
  escapeRadius: number
  /** Upper bound on escape cells kept, so the offer cannot be crowded. */
  maxEscapeCells: number
  /**
   * Upper bound on threat-cover rays per sensor tick. A cover cell is a
   * keep-distance destination the attacker cannot see (`KeepDistanceInput.
   * occludedCells`); proving it costs one sight-line ray from the threat's eye.
   * The bound keeps the escape scan's cost proportional to the cells it would
   * already consider, so a hostile cannot make a tick unbounded.
   */
  maxThreatCoverRays: number
  /**
   * Exact world-mutation revision (see `DecisionScheduler.worldRevision`), or
   * absent/null when the caller cannot prove one. Only when it is a finite
   * number may `buildWorldState` reuse a `findBlocks` position list across
   * builds (see `stableFindBlocks`). Absent = caching off, which is what every
   * fixture and any non-resident caller gets.
   */
  worldRevision?: number | null
  /**
   * Read provenance for the bot's world cache. When present, EVERY world read this
   * sensor performs is gated on it: a cell whose column is not attributable to the
   * live dimension is REFUSED (typed, `DIMENSION_READ_REFUSED`) rather than read,
   * so a foreign dimension's block truth can never become an offer or durable
   * memory. Absent means the caller cannot establish provenance (fixtures, replays,
   * non-resident callers) and the reads are exactly what they were before this gate
   * existed - which is what keeps those callers byte-identical.
   */
  dimensionProvenance?: DimensionProvenance | null
}

export const defaultSensorOptions: SensorOptions = {
  scanRadius: 48,
  reach: 4.5,
  maxLogs: 16,
  maxEntities: 12,
  maxTerrain: 8,
  hazardRadius: 6,
  entityRadius: 24,
  hostileRadius: 48,
  maxStoneBlocks: 16,
  maxPlacementSpots: 6,
  escapeRadius: 6,
  maxEscapeCells: 12,
  maxThreatCoverRays: 48,
}

export interface SensorInput {
  tick: number
  goal: GoalState
  goalQueue: GoalQueueState
  /** #56: the exact compiled Option instance currently being evaluated by Jev */
  currentOption?: CurrentOptionContext | null
  recentOutcomes?: readonly System2Outcome[]
  /** the item the current subgoal targets, used to focus the block scan */
  focusItem?: string | null
  /**
   * Every want item the candidate generator can route to this tick: the active
   * focus plus any queued want the explicit descent proxy exposes
   * (`candidates.ts#retrievalNeeds`). Remembered cells are verified for ALL of
   * them, because a queued want's `RETRIEVE:known` route is offered from the same
   * memory: verifying only the focus left a queued want's stale cell unproven and
   * therefore permanently re-offered. Defaults to `focusItem`.
   */
  retrievalItems?: readonly string[]
  recentEvents: string[]
  signals: AgentSignals
  /**
   * Durable, host-validated station records (WorldMemory -> generation-entry
   * injection -> controller options). Merged into `craftingTables`/`furnaces`
   * as `source: 'remembered'` entries, independent of the transient
   * unreachable-resource filter the controller applies to
   * `signals.knownResources`: "I remember it" is perception truth even while
   * walking there is blocked. Falls back to `signals.knownResources` when
   * omitted.
   */
  rememberedStations?: readonly KnownResource[]
  /**
   * Contents an earlier OPEN action observed, injected by the controller from
   * the executor's own observation ledger. A container cell with no entry here
   * is UNKNOWN, not empty: the client cannot read container contents before a
   * window is opened (see `containerAccess.ts`), so the absence of an entry is
   * the absence of an observation, never a verdict of zero.
   */
  containerContents?: readonly ContainerObservation[]
}

const EYE_HEIGHT = 1.62
const LOG_NAME = /_log$/
const HAZARDS = new Set(['lava', 'fire', 'magma_block', 'campfire', 'soul_campfire', 'sweet_berry_bush', 'cactus'])
const STONE_LIKE = new Set([
  'stone',
  'cobblestone',
  'deepslate',
  'cobbled_deepslate',
  'andesite',
  'diorite',
  'granite',
  'tuff',
])
/**
 * The block names the two placed-station projections are built from
 * (`craftingTables` / `furnaces`). Exported so the candidate layer's
 * station-use-before-craft rule resolves a station ITEM to the world-model
 * projection by the SAME name sets the sensor uses - never a second list.
 */
export const CRAFT_STATIONS: ReadonlySet<string> = new Set(['crafting_table'])
export const FURNACE_STATIONS: ReadonlySet<string> = new Set(['furnace', 'blast_furnace', 'smoker'])
/**
 * The container blocks the sensor projects into `WorldState.containers`
 * (chest / trapped_chest / barrel / ender_chest / shulker_box + its 16 colour
 * variants). The table itself lives in `containerAccess.ts` so the sensor, the
 * candidate layer, the executor's open mechanics and the envelope all resolve
 * a container by the SAME names - never a second list (see `CRAFT_STATIONS`).
 * A container placed in the world by anyone (an operator, a loot chest, the
 * body itself) is therefore a SENSED station-approach target, not invisible
 * terrain.
 */
export const CONTAINER_STATIONS: ReadonlySet<string> = CONTAINER_BLOCK_NAMES
export const STONE_YIELDS = new Set(['cobblestone', 'cobbled_deepslate'])

/**
 * Ore block name -> the item it drops. Drives goal-directed ore scanning:
 * a `collect raw_iron` subgoal finds `iron_ore`/`deepslate_iron_ore`, and a
 * `collect diamond` subgoal finds both diamond ore variants.
 */
export const ORE_SOURCES: Readonly<Record<string, readonly string[]>> = {
  raw_iron: ['iron_ore', 'deepslate_iron_ore'],
  raw_copper: ['copper_ore', 'deepslate_copper_ore'],
  raw_gold: ['gold_ore', 'deepslate_gold_ore'],
  diamond: ['diamond_ore', 'deepslate_diamond_ore'],
  coal: ['coal_ore', 'deepslate_coal_ore'],
  emerald: ['emerald_ore', 'deepslate_emerald_ore'],
  lapis_lazuli: ['lapis_ore', 'deepslate_lapis_ore'],
  redstone: ['redstone_ore', 'deepslate_redstone_ore'],
}

/** Every block name that can be an ore target, regardless of the focus item. */
export const ALL_ORE_BLOCKS: readonly string[] = [...new Set(Object.values(ORE_SOURCES).flat())]

/**
 * M3: the Nether-structure body blocks worth name-scanning so a sensed Nether
 * fortress becomes representable truth. Fortresses are built from nether brick
 * blocks; the fence and stair variants are corroboration, not evidence of a
 * completed structure on their own.
 *
 * Verified against the PINNED minecraft-data (1.21.11) loaded by mineflayer:
 *   nether_bricks       id 380, diggable, hardness 2.0
 *   nether_brick_fence  id 381, diggable, hardness 2.0
 *   nether_brick_stairs id 382, diggable, hardness 2.0
 * `blaze_spawner` does NOT exist in this data version — the only spawner names
 * are `spawner` and `trial_spawner`. A generic `spawner` block would also match
 * overworld dungeons, so it is deliberately NOT used here: the fortress body
 * blocks are the grounded signal. (`nether_brick_slab`/`nether_brick_wall` also
 * exist and can be added as corroboration later; they are left out to keep the
 * scan set at the three names that most reliably mark fortress fabric.)
 *
 * The list is perception truth only. Whether a sensed body belongs to a real
 * fortress is a dimension question owned by the durable structure record
 * (`syncKnownStructureSites` in buddy-driver/generation-entry.ts), never a goal
 * or ranking decision made here.
 */
export const NETHER_STRUCTURE_BLOCK_NAMES: readonly string[] = [
  'nether_bricks',
  'nether_brick_fence',
  'nether_brick_stairs',
]

/**
 * Blocks whose primary drop is a directly collectible item that is neither an
 * `_ore` nor a log. Obsidian is the M2 case: the typed portal plan emits
 * `collect:obsidian`, but the block name carries no `_ore` suffix and is not in
 * `STONE_LIKE`, so before this table a sensed obsidian block never entered
 * `state.blocks` and the candidate generator could only offer exploration
 * MOVE/WAIT (live CANDIDATE_STARVATION presented=1 productive=0).
 *
 * This is perception truth only: it names what to scan when the active goal
 * targets the item. The MINE/MOVE/DESCEND and known-retrieval machinery still
 * owns reach, pickup adjacency and the harvest gate, and no goal or action is
 * chosen or ranked here.
 */
export const DIRECT_BLOCK_SOURCES: Readonly<Record<string, readonly string[]>> = {
  obsidian: ['obsidian'],
  // M2 needs `flint` for flint_and_steel, and its only block source is gravel.
  // Without this entry `collect flint (from gravel)` had no scanned source at
  // all, so the generator produced `presented=2 productive=0`
  // (CANDIDATE_STARVATION) while the body wandered and dug exploratory DESCEND
  // shafts — the live "tunnelling for nothing" stall. Mining gravel only *may*
  // drop flint, which is fine: the route exists, and pickup/repeat stay with the
  // existing machinery.
  flint: ['gravel'],
  // M3's `blaze_rods` rung collects 7 x blaze_rod. A blaze_rod is a mob drop, so
  // there is no block whose yield is blaze_rod; what exists is the fortress body
  // that hosts the blazes. Mapping the focus item to the structure fabric is the
  // same "the block is the grounded affordance, the drop stays with the existing
  // machinery" precedent as `flint -> gravel`: the name scan makes a sensed
  // fortress visible (and durable via the Nether structure site record), and
  // MINE/RETRIEVE/pickup keep their own gates. `syncKnownStructureSites`
  // additionally refuses to mint a record outside the Nether, so a
  // player-placed `nether_bricks` block in the overworld cannot masquerade as a
  // fortress.
  blaze_rod: NETHER_STRUCTURE_BLOCK_NAMES,
}

/**
 * The block names to name-scan for a collect goal, from ore drops plus direct
 * (non-ore, non-log) drops and structure-landmark routes. Returns undefined when
 * the focus item has no name-scanned source, so callers keep their existing
 * behaviour.
 */
export function scannedBlockNames(focusItem: string | null): readonly string[] | undefined {
  if (focusItem === null) return undefined
  return ORE_SOURCES[focusItem] ?? DIRECT_BLOCK_SOURCES[focusItem]
}

/**
 * Deterministic Minecraft producer truth for the items whose only grounded
 * source is a mob drop. CAN/TRUE only: every sensed producer instance is exposed
 * as a grounded alternative and Jev still owns WHICH one to pursue.
 *
 * It lives in the sensor (not the candidate layer) because the sensor must
 * verify a remembered producer landmark against live entity truth (see
 * `probeKnownResources`); `candidates.ts` imports this one table instead of
 * keeping a second copy.
 */
export const MOB_DROP_PRODUCERS: Readonly<Record<string, ReadonlySet<string>>> = {
  ender_pearl: new Set(['enderman']),
  blaze_rod: new Set(['blaze']),
}

/**
 * WHERE a declared mob producer can exist: the vanilla spawn-context rule for a
 * mobile producer, as data.
 *
 * `MOB_DROP_PRODUCERS` answers "which mob drops the item". It does NOT answer
 * "where is that mob", and for the whole pearl half of M3 that missing half was
 * the real gap: the producer table named `enderman`, the sensor reported
 * `sensed=0`, and nothing in the system could express whether the body was
 * standing in a spawn context where an enderman CAN exist. The arrival chunk
 * genuinely was a soul sand valley (`soul_soil 630 | soul_sand 287` measured) -
 * an environment that spawns endermen in vanilla - and the body still never met
 * one, because "look for a producer" had no context to be grounded on.
 *
 * This is the same deterministic-truth convention as `ORE_SOURCES`,
 * `DIRECT_BLOCK_SOURCES` and `NETHER_STRUCTURE_BLOCK_NAMES`: public vanilla
 * facts, no ranking, no policy. It is deliberately PRODUCER-GENERIC - one entry
 * per mob, any future `MOB_DROP_PRODUCERS` entry gets a context by adding a row
 * here and nothing else - and never item-, milestone- or coordinate-specific.
 *
 * Semantics:
 *   - `dimensions`           the dimension ids in which the mob can exist at all;
 *   - `lightGatedDimensions` the subset of those where a spawn is gated on block
 *                            light (vanilla's hostile-monster rule is an
 *                            OVERWORLD rule: the Nether and the End halves of the
 *                            same mob spawn light-independently), so a
 *                            light-independent dimension never needs a light
 *                            sample to be a valid context;
 *   - `spawnLightMax`        the highest block light that still permits a spawn
 *                            in a gated dimension;
 *   - `surface`              what the mob needs to stand on;
 *   - `enclosure`            `open_sky` when the surface must not be roofed.
 */
export type MobSpawnSurface = 'solid_surface'
export type MobSpawnEnclosure = 'open_sky'

export interface MobSpawnContextFact {
  dimensions: readonly string[]
  /**
   * the dimensions where the light gate applies. A dimension in `dimensions` but
   * NOT here spawns this mob regardless of light, which is what makes the Nether
   * a valid enderman context without any light sample.
   */
  lightGatedDimensions: readonly string[]
  /** highest block light that still permits a spawn in a gated dimension */
  spawnLightMax: number
  surface: MobSpawnSurface
  enclosure: MobSpawnEnclosure | null
  /** the vanilla rule this row encodes, so a reader never has to guess */
  note: string
}

/**
 * The spawn-context rows for the declared mob producers. Data only; pure readers
 * below. Kept next to `MOB_DROP_PRODUCERS` so the two halves of producer truth
 * ("what it drops", "where it lives") cannot drift apart.
 *
 * `enderman`: hostile-monster rules. Overworld spawns require block light <= 7 on
 * an opaque surface under open sky; the Nether and the End are the
 * light-independent halves of the same mob - which is why the measured soul sand
 * valley arrival chunk is a valid enderman context on the dimension alone.
 * `blaze`: fortress-hosted, Nether only, never light-gated.
 */
export const MOB_SPAWN_CONTEXTS: Readonly<Record<string, MobSpawnContextFact>> = {
  enderman: {
    dimensions: ['minecraft:overworld', 'minecraft:the_nether', 'minecraft:the_end'],
    // The overworld half of the rule. The Nether/End halves are expressed by
    // omission: they are in `dimensions` and not here, so no light is required
    // there and a missing sample cannot make a nether enderman unspawnable.
    lightGatedDimensions: ['minecraft:overworld'],
    spawnLightMax: 7,
    surface: 'solid_surface',
    enclosure: 'open_sky',
    note: 'hostile monster: overworld spawn needs block light <= 7 on an opaque surface under open sky; the Nether and the End are light-independent',
  },
  blaze: {
    dimensions: ['minecraft:the_nether'],
    lightGatedDimensions: [],
    spawnLightMax: 0,
    surface: 'solid_surface',
    enclosure: null,
    note: 'fortress spawner mob: Nether only, no light gate, no sky requirement',
  },
}

/** The spawn-context rule for a mob name, or null when none is declared (CAN truth). */
export function mobSpawnContextFor(entityName: string): MobSpawnContextFact | null {
  return MOB_SPAWN_CONTEXTS[entityName] ?? null
}

/**
 * The block-light gate this rule imposes in `dimension`, or null when the
 * dimension does not gate this mob on light at all.
 *
 * The sensor needs this to decide whether it must read a light level before it
 * can state a verdict, and the evidence carries it so a reader can tell a
 * `spawnLightMax=none` (the dimension has no gate) from a missing measurement.
 */
export function mobSpawnLightGate(
  fact: MobSpawnContextFact,
  dimension: string,
): number | null {
  return fact.lightGatedDimensions.includes(dimension) ? fact.spawnLightMax : null
}

/**
 * Pure context-rule predicate: does a body in `dimension` with a sampled block
 * light of `light` satisfy this mob's spawn rule?
 *
 * `light` is read ONLY in a dimension the rule actually gates on; everywhere else
 * it is ignored, so a missing light sample in the Nether cannot make a nether
 * producer look unspawnable. Deliberately free of any policy: it answers "can
 * this mob exist in this context", never "should the body go there".
 */
export function mobSpawnContextMet(
  fact: MobSpawnContextFact,
  dimension: string,
  light: number | null,
): boolean {
  if (!fact.dimensions.includes(dimension)) return false
  const gate = mobSpawnLightGate(fact, dimension)
  if (gate === null) return true
  // A light-gated rule with no sample is not "met" - the caller must not read an
  // unmeasured context as a proven one.
  if (light === null) return false
  return light <= gate
}

/**
 * Typed verdict for a mob's spawn context AT ONE CELL of the live world.
 *
 *   `met`                the dimension and (where the rule gates on it) the
 *                        measured light permit a spawn here;
 *   `dimension_unmet`    this dimension cannot host the mob at all;
 *   `light_unmet`        the dimension is right but the measured light is too high;
 *   `context_unknown`    the dimension is right, but the cell could not be read
 *                        (`probeReason` names which fact was missing).
 *
 * `context_unknown` is a REAL answer, not a failure: it is what an unmeasured
 * context looks like, and the search route stays grounded on it (the body must
 * go somewhere it can measure one).
 */
export type MobSpawnContextVerdict = 'met' | 'dimension_unmet' | 'light_unmet' | 'context_unknown'

export type MobSpawnProbeReason = 'no_sensed_surface' | 'light_unavailable'

/** One mob's spawn-context observation for the live tick. */
export interface MobSpawnContextObservation {
  mob: string
  dimension: string
  verdict: MobSpawnContextVerdict
  /** the cell the surface fact was read at, or null when no surface was sampled */
  cell: Vec3Json | null
  /** the block sampled under the body (the surface a spawn would stand on) */
  surfaceBlock: string | null
  /** block light at the sampled cell, or null when the world data could not answer */
  light: number | null
  /** the block-light gate this dimension imposes, null when it imposes none */
  spawnLightMax: number | null
  /** biome name at the sampled cell, when the world data exposes one */
  biome: string | null
  /** only set on `context_unknown`: which fact was missing */
  probeReason: MobSpawnProbeReason | null
}

/**
 * Read the surface spawn context at the body's own column.
 *
 * The cell is the block directly under the body's feet when it is solid (the
 * surface a spawn would stand on), else the body's own feet cell. `blockAt` is
 * the same synchronous call `buildTerrain` already makes for every cell of its
 * 5x5x3 window, so this adds one bounded read, and it is invoked only for a
 * focus item that declared a mob producer.
 *
 * `bot.blockAt` returns a prismarine block whose `light` is the block light and
 * whose `biome` is the numeric biome id (prismarine-chunk `getBlock`), and
 * `bot.world.getBiome` is the async form. Both are read defensively: an absent
 * field is `context_unknown`, never a fabricated value.
 */
export function sampleMobSpawnContext(
  bot: Bot,
  mobName: string,
  dimension: string,
  selfPosition: Vec3Json,
): MobSpawnContextObservation {
  const fact = mobSpawnContextFor(mobName)
  const gate = fact === null ? null : mobSpawnLightGate(fact, dimension)
  const base: MobSpawnContextObservation = {
    mob: mobName,
    dimension,
    verdict: 'context_unknown',
    cell: null,
    surfaceBlock: null,
    light: null,
    spawnLightMax: gate,
    biome: null,
    probeReason: null,
  }
  // No declared rule for this mob, or a dimension that cannot host it: the answer
  // is already complete and no world read is needed to state it.
  if (fact === null) return { ...base, probeReason: 'no_sensed_surface' }
  if (!fact.dimensions.includes(dimension)) return { ...base, verdict: 'dimension_unmet' }
  const feet = {
    x: Math.floor(selfPosition.x),
    y: Math.floor(selfPosition.y),
    z: Math.floor(selfPosition.z),
  }
  const surfaceCell = { x: feet.x, y: feet.y - 1, z: feet.z }
  const read = (cell: Vec3Json): { name: string | null; light: number | null; biomeId: number | null } => {
    try {
      const block = sensorBlockAt(bot, cell as never) as unknown as
        | { name?: unknown; light?: unknown; biome?: unknown }
        | null
        | undefined
      if (block === null || block === undefined) return { name: null, light: null, biomeId: null }
      return {
        name: typeof block.name === 'string' ? block.name : null,
        light: typeof block.light === 'number' && Number.isFinite(block.light) ? block.light : null,
        biomeId: typeof block.biome === 'number' && Number.isFinite(block.biome) ? block.biome : null,
      }
    } catch {
      // An unloaded chunk / malformed world read is a MISSING fact, not a crash
      // and not a silent "spawnable".
      return { name: null, light: null, biomeId: null }
    }
  }
  // Prefer the support block; fall back to the feet cell when the body is in the
  // air (a sampled column that has no floor still has a light level).
  let sampled = read(surfaceCell)
  let cell: Vec3Json = surfaceCell
  if (sampled.name === null) {
    sampled = read(feet)
    cell = feet
  }
  // A dimension-only rule (no light gate here: the Nether/End) is already MET by
  // the dimension check alone, so an unreadable cell cannot change the verdict -
  // but the cell is still read while it can be, so the evidence says where the
  // context was observed. `probeReason` stays null because nothing was missing.
  if (gate === null) {
    return sampled.name === null
      ? { ...base, verdict: 'met' }
      : { ...base, verdict: 'met', cell, surfaceBlock: sampled.name, light: sampled.light, biome: biomeNameFor(bot, sampled.biomeId) }
  }
  if (sampled.name === null) {
    return { ...base, probeReason: 'no_sensed_surface' }
  }
  const biome = biomeNameFor(bot, sampled.biomeId)
  const measured = {
    ...base,
    cell,
    surfaceBlock: sampled.name,
    light: sampled.light,
    biome,
  }
  if (sampled.light === null) return { ...measured, probeReason: 'light_unavailable' }
  return {
    ...measured,
    verdict: mobSpawnContextMet(fact, dimension, sampled.light) ? 'met' : 'light_unmet',
  }
}

/**
 * The biome NAME for a numeric biome id the world data exposed, or null.
 *
 * The name is corroboration only - the spawn verdict never depends on it, so a
 * data version that cannot resolve an id yields null instead of a verdict
 * change. Resolved through the same pinned `minecraft-data` registry the rest of
 * the sensor uses.
 */
function biomeNameFor(bot: Bot, biomeId: number | null): string | null {
  if (biomeId === null) return null
  try {
    const registry = (bot as unknown as { registry?: { biomes?: Record<number, { name?: unknown }> } }).registry
    const name = registry?.biomes?.[biomeId]?.name
    return typeof name === 'string' ? name : null
  } catch {
    return null
  }
}

/**
 * True when every declared source name for a want is structure fabric: the block
 * is a LANDMARK that hosts the producers, not a deposit that drops the item
 * (`nether_bricks` does not yield `blaze_rod`; `resourceMatches` stays exact).
 */
export function isStructureFabricSource(blockNames: readonly string[]): boolean {
  return blockNames.length > 0 && blockNames.every((name) => NETHER_STRUCTURE_BLOCK_NAMES.includes(name))
}

/**
 * What a remembered cell ASSERTS about how the want item is obtained. Derived
 * from the name the memory recorded, never from the entry's durability `kind`
 * (#80/#342 reuse `kind` for portal/fortress envelopes that are not deposits):
 *
 *   `block`    the cell holds a block whose own drop is the item (iron_ore ->
 *              raw_iron, gravel -> flint, obsidian -> obsidian): live block
 *              truth at the cell is the whole verdict;
 *   `producer` the cell is a structure LANDMARK that hosts the item's mob
 *              producers (nether_bricks -> blaze_rod). The block standing there
 *              does not put the drop there, so the cell is a deposit route only
 *              while a producer instance (or its dropped item) is SENSED;
 *   `drop`     the cell is remembered as the item itself (loot, a death drop),
 *              so it is a route only while a dropped item entity is SENSED.
 *
 * Pure. This is the classification the offer/withhold rule is built on: a memory
 * must be verified against the thing it actually claims.
 */
export type KnownResourceClaim = 'block' | 'producer' | 'drop'

export function knownResourceClaimFor(name: string, item: string | null): KnownResourceClaim {
  if (item !== null) {
    const sources = scannedBlockNames(item)
    // A declared block source for this item is a BLOCK claim even when the block
    // and the item share a name (`obsidian` -> `obsidian` is a mine, not a drop).
    if (sources !== undefined && sources.includes(name)) {
      return isStructureFabricSource(sources) ? 'producer' : 'block'
    }
    // Remembered as the item itself (loot, a death drop) rather than as a block.
    if (name === item) return 'drop'
  }
  if (NETHER_STRUCTURE_BLOCK_NAMES.includes(name)) return 'producer'
  return 'block'
}

/** The mob producers a landmark block can host (`nether_bricks` -> `blaze`). */
function landmarkProducers(name: string): ReadonlySet<string> {
  const out = new Set<string>()
  for (const [item, producers] of Object.entries(MOB_DROP_PRODUCERS)) {
    if ((scannedBlockNames(item) ?? []).includes(name)) for (const producer of producers) out.add(producer)
  }
  return out
}

/** Resolve a block's primary drop, required tool class and required pickaxe rank. */
export function resolveBlockHarvest(
  bot: Bot,
  blockName: string,
): { yield: string | null; harvestTool: HarvestTool | null; harvestTier: number | null } {
  return resolveHarvest((bot.registry ?? {}) as GameDataRegistry, blockName)
}

/**
 * #376: line of sight fails CLOSED. An exception from `canSeeBlock` is an observation
 * failure, not evidence of visibility - returning true here manufactured line of sight
 * (and therefore MINE/MOVE affordances) for blocks the sensor could not actually see.
 * Unknown is not "visible", the same rule every other observation boundary follows.
 * Exported for the fixture that pins the boundary.
 */
export function blockVisible(bot: Bot, block: { position: { x: number; y: number; z: number } }, inReach: boolean): boolean {
  if (!inReach) return false
  try {
    return bot.canSeeBlock(block as never)
  } catch {
    return false
  }
}

/** Vec3 factory that never imports `vec3` directly (keeps deps to the spec list). */
export function toVec3(bot: Bot, p: Vec3Json) {
  return bot.entity.position.clone().set(p.x, p.y, p.z)
}

function vecJson(v: { x: number; y: number; z: number }): Vec3Json {
  return { x: round2(v.x), y: round2(v.y), z: round2(v.z) }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export function distance(a: Vec3Json, b: Vec3Json): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

/**
 * #382: the ONE passability rule, shared with the executor. Fail closed: `null` is an
 * UNLOADED cell (Mineflayer returns null for unknown points), not an empty one, so an
 * unknown cell is never proven passable. The executor previously had its own rule with
 * the opposite semantics, which let a body step into space the world model had never
 * observed and manufactured clear-headroom/pillar/step affordances from missing data.
 */
export function isPassable(block: { boundingBox: string } | null): boolean {
  // lava/water have an "empty" bounding box, so passability alone is not
  // enough for a standable spot - the support check below excludes liquids.
  return block !== null && block.boundingBox === 'empty'
}

function isSolidSupport(block: { boundingBox: string } | null): boolean {
  return block !== null && block.boundingBox === 'block'
}

/**
 * Foliage/canopy block names (`oak_leaves`, `birch_leaves`, `azalea_leaves`,
 * ...). A leaf block is COLLIDABLE - `boundingBox === 'block'` - so a 1.8-tall
 * body can physically stand on a treetop and `isStandable` must keep saying so;
 * that is locomotion truth and walking across a canopy stays legal.
 *
 * What a leaf is NOT is LOAD-BEARING GROUND. It is not a habitat surface, not a
 * foundation a block may be placed onto, and not the landing of a step-up route.
 * Every layer that picks a DESTINATION (terrain / explore / retreat cells), a
 * PLACEMENT site (station, pillar, scaffold) or a step-up LANDING therefore asks
 * for {@link isUsableGroundSupport} instead of bare solidity, so a hungry body is
 * never walked up a treetop and no block is placed on leaves.
 */
const CANOPY_BLOCK_NAME = /(^|_)leaves$/

/** True when a block name is a leaf canopy block (see {@link CANOPY_BLOCK_NAME}). */
export function isCanopyBlockName(name: string): boolean {
  return CANOPY_BLOCK_NAME.test(name)
}

/** The block slice the load-bearing-ground rule needs. */
export interface SupportBlockLike {
  name: string
  boundingBox: string
}

/**
 * The ONE load-bearing-ground rule: a full solid block that is not a leaf
 * canopy. Shared by the destination (`buildTerrain`), placement-site
 * (`buildPlacementSpots`) and step-up-landing (`buildStepCuts`) layers. It is
 * deliberately stricter than `isStandable`, which stays the locomotion and
 * passability truth.
 */
export function isUsableGroundSupport(block: SupportBlockLike | null): boolean {
  return block !== null && isSolidSupport(block) && !isCanopyBlockName(block.name)
}

/** True when the block under `feet` is genuinely usable ground (not a canopy). */
export function hasUsableGroundSupport(bot: Bot, feet: Vec3Json): boolean {
  return isUsableGroundSupport(sensorBlockAt(bot, toVec3(bot, { x: feet.x, y: feet.y - 1, z: feet.z })))
}

const REPLACEABLE_AIR = new Set(['air', 'cave_air', 'void_air'])

function isReplaceableAir(block: { name: string } | null): boolean {
  return block !== null && REPLACEABLE_AIR.has(block.name)
}

/**
 * True when a 1.8-tall body can occupy the feet cell `feet`: feet + head
 * passable and the block below solid. This is the ONE standability rule the
 * generic locomotion layer uses (terrain sensing, MOVE guard, reachability);
 * it is exported so other deterministic layers reuse it instead of inventing
 * their own passability/support geometry. It says nothing portal-specific: a
 * cell holding any non-solid block (grass, leaf litter, a nether_portal) over
 * solid support is standable.
 */
export function isStandable(bot: Bot, feet: Vec3Json): boolean {
  const feetBlock = sensorBlockAt(bot, toVec3(bot, feet))
  const headBlock = sensorBlockAt(bot, toVec3(bot, { x: feet.x, y: feet.y + 1, z: feet.z }))
  const belowBlock = sensorBlockAt(bot, toVec3(bot, { x: feet.x, y: feet.y - 1, z: feet.z }))
  return isPassable(feetBlock) && isPassable(headBlock) && isSolidSupport(belowBlock)
}

/**
 * The DESTINATION rule: the cell is standable AND its support is genuinely
 * usable ground (not a leaf canopy). Terrain sensing, explore/retreat cells and
 * every placement cell use this one, so `isStandable` keeps owning pure
 * locomotion truth while a treetop stops being a goal, a build site or a
 * landing.
 */
export function isUsableStand(bot: Bot, feet: Vec3Json): boolean {
  return isUsableStandFromBlocks(
    sensorBlockAt(bot, toVec3(bot, feet)),
    sensorBlockAt(bot, toVec3(bot, { x: feet.x, y: feet.y + 1, z: feet.z })),
    sensorBlockAt(bot, toVec3(bot, { x: feet.x, y: feet.y - 1, z: feet.z })),
  )
}

/**
 * `isUsableStand` over blocks the caller has ALREADY read. The environmental
 * hazard scan samples a 3x3x3 ring around the body every tick and must not read
 * every cell twice; both callers are the same destination rule, so a canopy top
 * cannot be standable for one of them and not the other.
 */
export function isUsableStandFromBlocks(
  feetBlock: { boundingBox: string } | null,
  headBlock: { boundingBox: string } | null,
  supportBlock: SupportBlockLike | null,
): boolean {
  return isPassable(feetBlock) && isPassable(headBlock) && isUsableGroundSupport(supportBlock)
}

/** The 8 neighbours the executor could stand on to reach a block, best first. */
function findAdjacentStandable(bot: Bot, target: Vec3Json): Vec3Json | null {
  const offsets: Array<[number, number, number]> = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 0, 1],
    [0, 0, -1],
    [1, 0, 1],
    [-1, 0, 1],
    [1, 0, -1],
    [-1, 0, -1],
    [1, -1, 0],
    [-1, -1, 0],
    [0, -1, 1],
    [0, -1, -1],
  ]
  const here = vecJson(bot.entity.position)
  let best: Vec3Json | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const [dx, dy, dz] of offsets) {
    const feet: Vec3Json = { x: target.x + dx, y: target.y + dy, z: target.z + dz }
    if (!isStandable(bot, feet)) continue
    const d = distance(feet, here)
    if (d < bestDistance) {
      bestDistance = d
      best = feet
    }
  }
  return best
}

function buildSelf(bot: Bot): SelfState {
  return buildSelfDetail(bot).self
}

/**
 * `buildSelf` plus the hazard cell sample the world state carries separately:
 * `self.envHazard` must stay lean (the Jev snapshot ships `self` whole), while
 * the candidate layer needs the 24 classified neighbours. One read pass builds
 * both.
 */
function buildSelfDetail(bot: Bot): { self: SelfState; envHazardCells: EnvHazardCell[] } {
  const position = vecJson(bot.entity.position)
  const eye = bot.entity.position.offset(0, EYE_HEIGHT, 0)
  const held = bot.heldItem
  const feet = { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) }
  const eyes = { x: Math.floor(eye.x), y: Math.floor(eye.y), z: Math.floor(eye.z) }
  const air = readAir(bot)
  const feetInWater = fluidAt(bot, feet)
  const eyesInWater = fluidAt(bot, eyes)
  const offhand = buildOffhand(bot)
  const envHazardCells = buildEnvHazardRing(bot, feet)
  const self: SelfState = {
    username: bot.username,
    position,
    eyePosition: vecJson(eye),
    yaw: round2(bot.entity.yaw),
    pitch: round2(bot.entity.pitch),
    onGround: bot.entity.onGround === true,
    health: bot.health,
    food: bot.food,
    gameMode: bot.game.gameMode,
    dimension: bot.game.dimension,
    isDay: bot.time.isDay,
    heldItem: held ? { name: held.name, count: held.count, slot: held.slot } : null,
    ...(offhand === undefined ? {} : { offhand }),
    armor: buildArmor(bot),
    air,
    feetInWater,
    eyesInWater,
    envHazard: buildEnvHazard(bot, {
      feet,
      air,
      feetInWater,
      eyesInWater,
      onFire: readOnFire(bot),
      cells: envHazardCells,
    }),
  }
  return { self, envHazardCells }
}

/**
 * SAFE: Mineflayer's OWN on-fire fact.
 *
 * `prismarine-entity` exposes no `onFire`/`fireTicks` property, but the entity
 * metadata it *does* keep carries the vanilla shared-flags byte at key 0
 * (`mineflayer/lib/plugins/entities.js` writes every metadata key it receives
 * onto `entity.metadata`), and bit 0x01 of that byte is the vanilla "entity is
 * on fire" flag - which is how the client knows to draw a burning body, and is
 * the only fire fact that survives leaving the fire block.
 *
 * `null` when the client never delivered metadata (a fixture bot, an old
 * version): UNKNOWN is not "not burning", and no other layer may turn it into a
 * positive fact.
 */
function readOnFire(bot: Bot): boolean | null {
  const metadata = (bot.entity as { metadata?: unknown }).metadata
  if (!Array.isArray(metadata)) return null
  const flags = metadata[0]
  if (typeof flags !== 'number' || !Number.isFinite(flags)) return null
  return (flags & 0x01) !== 0
}

/**
 * SAFE: the adjacent-cell sample the environmental hazard state is built from.
 *
 * The 3x3 horizontal ring at feet.y-1..feet.y+1 (24 cells, the body's own cell
 * excluded), each read as feet + head + support so the destination rule
 * (`isUsableStandFromBlocks`) and the hazard/water facts come from the SAME real
 * blocks the body would occupy. An unloaded cell (`blockAt` -> null) is never
 * standable and never a hazard: no read, no fact.
 */
function buildEnvHazardRing(bot: Bot, feet: Vec3Json): EnvHazardCell[] {
  const cells: EnvHazardCell[] = []
  const at = (x: number, y: number, z: number) => sensorBlockAt(bot, toVec3(bot, { x, y, z }))
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dz = -1; dz <= 1; dz += 1) {
      if (dx === 0 && dz === 0) continue
      for (let dy = -1; dy <= 1; dy += 1) {
        const x = feet.x + dx
        const y = feet.y + dy
        const z = feet.z + dz
        const feetBlock = at(x, y, z)
        const headBlock = at(x, y + 1, z)
        const supportBlock = at(x, y - 1, z)
        const hazardBlock =
          (feetBlock !== null && envHazardKindOfBlock(feetBlock.name) !== null
            ? feetBlock.name
            : headBlock !== null && envHazardKindOfBlock(headBlock.name) !== null
              ? headBlock.name
              : supportBlock !== null && envHazardKindOfBlock(supportBlock.name) !== null
                ? supportBlock.name
                : null)
        cells.push({
          position: { x, y, z },
          standable: isUsableStandFromBlocks(feetBlock, headBlock, supportBlock),
          hazard: envHazardKindOfBlock(hazardBlock),
          hazardBlock,
          water: feetBlock !== null && PROBE_FLUIDS.has(feetBlock.name),
        })
      }
    }
  }
  return cells
}

const SUBMERSION_WAYPOINT_AIR = new Set(['air', 'cave_air', 'void_air'])
const SUBMERSION_WAYPOINT_RISE = 3

function isSubmersionWaypointBlock(block: ReturnType<Bot['blockAt']>): block is NonNullable<ReturnType<Bot['blockAt']>> {
  return (
    block !== null &&
    block.boundingBox === 'empty' &&
    (SUBMERSION_WAYPOINT_AIR.has(block.name) || PROBE_FLUIDS.has(block.name))
  )
}

/**
 * SAFE/CAN: bounded upward swim waypoints for a body that is already running
 * out of breath. The stock pathfinder cannot route through water, so this scans
 * only the body's own x/z column and records each successive destination while
 * the two-cell body volume remains observed as water or air. The contiguous
 * column is the route witness; no horizontal swim route is inferred.
 */
function buildSubmersionEscapeTargets(bot: Bot, self: SelfState): SubmersionEscapeTarget[] {
  if (!bodyIsOutOfAir(self) || !bodyIsSubmerged(self)) return []
  const base = {
    x: Math.floor(self.position.x),
    y: Math.floor(self.position.y),
    z: Math.floor(self.position.z),
  }
  const scratch = bot.entity.position.clone()
  const at = (position: Vec3Json) =>
    sensorBlockAt(bot, scratch.set(position.x, position.y, position.z), 'submersion-waypoint')
  const targets: SubmersionEscapeTarget[] = []
  for (let rise = 1; rise <= SUBMERSION_WAYPOINT_RISE; rise += 1) {
    // Check every newly occupied row, not only the destination. This proves a
    // contiguous vertical body-sized column and deliberately rules out all
    // lateral movement that the specialized actuator does not perform.
    const feet = at({ x: base.x, y: base.y + rise, z: base.z })
    const head = at({ x: base.x, y: base.y + rise + 1, z: base.z })
    if (!isSubmersionWaypointBlock(feet) || !isSubmersionWaypointBlock(head)) break
    targets.push({
      position: { x: base.x, y: base.y + rise, z: base.z },
      feetBlock: feet.name,
      headBlock: head.name,
    })
  }
  return targets
}

/**
 * SAFE: the body's own environmental hazard state (fire/lava/burning/drowning).
 *
 * The measured live failure: the body burned to death in the Nether with every
 * damage tick arriving as `source=null` and no marker in the whole run naming
 * fire, lava or burning - nothing had ever read the block the body was standing
 * in. This reads it, plus the adjacent cells, and nothing else: no hazard is
 * ever inferred from damage, from a block *near* the body, or from a missing
 * read.
 */
function buildEnvHazard(
  bot: Bot,
  input: {
    feet: Vec3Json
    air: number | null
    feetInWater: boolean
    eyesInWater: boolean
    onFire: boolean | null
    cells: EnvHazardCell[]
  },
): EnvHazardState {
  const at = (y: number) => sensorBlockAt(bot, toVec3(bot, { x: input.feet.x, y, z: input.feet.z }))
  const feetBlock = at(input.feet.y)
  const headBlock = at(input.feet.y + 1)
  const supportBlock = at(input.feet.y - 1)
  // The cell a 1.8-tall body's head occupies when it rises one step: the
  // drowning geometry ("water at the head, air immediately above").
  const aboveHeadBlock = at(input.feet.y + 2)
  const inWater = input.feetInWater === true || input.eyesInWater === true
  return buildEnvHazardState({
    self: input.feet,
    feetBlock: feetBlock?.name ?? null,
    headBlock: headBlock?.name ?? null,
    supportBlock: supportBlock?.name ?? null,
    onFire: input.onFire,
    // The breath/water facts are `bodySubmersion`'s (one owner); the hazard
    // state only re-expresses drowning so one marker can name it.
    outOfAir: bodySubmersion({
      air: input.air,
      feetInWater: input.feetInWater,
      eyesInWater: input.eyesInWater,
    }).state === 'out_of_air',
    inWater,
    headInWater: input.eyesInWater === true,
    // "Verified AIR immediately above" is not merely "passable above": a fluid
    // cell is passable with an empty bounding box, so water above the head must
    // NOT read as a breathable cell. Only air (any non-fluid passable cell)
    // grounds the rise.
    airAbove:
      isPassable(aboveHeadBlock) &&
      aboveHeadBlock !== null &&
      !PROBE_FLUIDS.has(aboveHeadBlock.name) &&
      envHazardKindOfBlock(aboveHeadBlock.name) === null,
    cells: input.cells,
  })
}

/**
 * The remaining breath. Mineflayer sets `bot.oxygenLevel` from the server's
 * `air_supply` metadata. Missing or malformed metadata stays unknown; the
 * sensor never turns absence into a full-air world fact.
 */
function readAir(bot: Bot): number | null {
  return observedAir((bot as { oxygenLevel?: number }).oxygenLevel)
}

/** true when the loaded cell holds a fluid (`null` = unloaded, so not a fluid). */
function fluidAt(bot: Bot, cell: Vec3Json): boolean {
  const block = sensorBlockAt(bot, toVec3(bot, cell))
  return block !== null && PROBE_FLUIDS.has(block.name)
}

/**
 * Read the four armor destinations from the live player window. Mineflayer
 * window 0 slots 5-8 are armor head->feet; a fake bot without `slots` reports
 * every slot empty rather than throwing.
 *
 * Exported so the locomotion fall guard (`executor.ts guardStepLanding`) prices a
 * landing against the SAME worn-armour read the sensor publishes
 * (`SelfState.armor`) instead of opening a second window into the inventory.
 */
export function buildArmor(bot: Bot): ArmorState {
  const slots = equipmentWindowSlots(bot)
  const armor = { ...EMPTY_ARMOR }
  for (const slot of ARMOR_SLOTS) {
    const index = ARMOR_SLOT_INDEX[slot]
    armor[slot] = equipmentPieceFromWindowSlot(slots?.[index], index)
  }
  return armor
}

/**
 * Read Mineflayer's actual offhand equipment window slot. `inventory.items()`
 * intentionally returns only the carried inventory section (9–44), while slot
 * 45 is offhand. A missing slot array/version capability is UNKNOWN (undefined),
 * and a present empty slot is the observed value null.
 */
export function buildOffhand(bot: Bot): OffhandState | null | undefined {
  try {
    if (typeof bot.supportFeature === 'function' && bot.supportFeature('doesntHaveOffHandSlot')) return undefined
  } catch {
    return undefined
  }
  const slots = equipmentWindowSlots(bot)
  if (slots === undefined || slots.length <= 45) return undefined
  const item = slots[45]
  if (item === undefined) return undefined
  return equipmentPieceFromWindowSlot(item, 45)
}

type EquipmentWindowSlot = {
  name?: string
  count?: number
  slot?: number
  maxDurability?: number | null
  durabilityUsed?: number | null
}

function equipmentWindowSlots(bot: Bot): ReadonlyArray<EquipmentWindowSlot | null> | undefined {
  return (bot.inventory as { slots?: ReadonlyArray<EquipmentWindowSlot | null> }).slots
}

function equipmentPieceFromWindowSlot(
  item: EquipmentWindowSlot | null | undefined,
  fallbackSlot: number,
): ArmorPieceState | null {
  if (item === undefined || item === null || typeof item.name !== 'string') return null
  const maxDurability =
    typeof item.maxDurability === 'number' && Number.isFinite(item.maxDurability) && item.maxDurability > 0
      ? item.maxDurability
      : null
  let durabilityUsed: number | null = null
  if (maxDurability !== null) {
    // Prismarine-item exposes this as a getter over protocol-version-specific
    // NBT/components. Treat unsupported or malformed data as unknown instead
    // of letting an observation failure break the entire world snapshot.
    try {
      const used = item.durabilityUsed
      if (typeof used === 'number' && Number.isFinite(used) && used >= 0 && used <= maxDurability) {
        durabilityUsed = used
      }
    } catch {
      durabilityUsed = null
    }
  }
  return {
    name: item.name,
    count: item.count ?? 1,
    slot: item.slot ?? fallbackSlot,
    durabilityUsed,
    maxDurability,
  }
}

function buildInventory(bot: Bot): InventoryState {
  const slots: InventorySlotState[] = []
  const counts: Record<string, number> = {}
  let totalItems = 0
  for (const item of bot.inventory.items()) {
    slots.push({ name: item.name, count: item.count, slot: item.slot })
    counts[item.name] = (counts[item.name] ?? 0) + item.count
    totalItems += item.count
  }
  return { slots, counts, totalItems }
}

function buildEntities(
  bot: Bot,
  options: SensorOptions,
  selfPosition: Vec3Json,
  lastDamage: LastDamageEvidence | null | undefined,
): EntityState[] {
  const out: EntityState[] = []
  const selfId = bot.entity.id
  const attackerId = lastDamage?.sourceId ?? null
  const hostileRadius = Math.max(options.entityRadius, options.hostileRadius ?? options.entityRadius)
  for (const entity of Object.values(bot.entities)) {
    if (entity.id === selfId) continue
    if (entity.isValid === false) continue
    const distanceToBot = entity.position.distanceTo(bot.entity.position)
    const name = entity.username ?? entity.name ?? entity.kind ?? 'unknown'
    // A hostile stays visible out to `hostileRadius` even when it is beyond the
    // general entity radius (see `hostileRadius`): the safety layer must be able
    // to name what is shooting the body.
    // A mob that has just DAMAGED the body is a threat whatever its type. The
    // a-priori list cannot enumerate everything that attacks: a zombie_villager is
    // hostile but matches neither `zombie` nor the suffix rule, and a provoked
    // piglin, a bear or any summoned/plugin mob is hostile only in context. The
    // general truth is observed aggression, and `lastDamage.sourceId` is already
    // in hand here. The list stays as the a-priori fallback (and for the cases
    // where the body must be able to name what is shooting it before it is hit).
    const hostile = isHostile(name, entity.kind) || (attackerId !== null && entity.id === attackerId)
    if (distanceToBot > (hostile ? hostileRadius : options.entityRadius)) continue
    const dropped = droppedItemName(entity)
    out.push({
      id: entity.id,
      name,
      kind: entity.kind ?? 'unknown',
      username: entity.username ?? null,
      position: vecJson(entity.position),
      distance: round2(distanceToBot),
      hostile,
      lineOfSight: canSeeEntity(bot, entity),
      heldItem: heldItemName(entity),
      health: typeof entity.health === 'number' && Number.isFinite(entity.health) ? entity.health : null,
      attackedSelf: attackerId !== null && entity.id === attackerId,
      // Only a real dropped item carries the key, so every other entity's shape
      // (and every existing fixture/replay) stays byte-identical.
      ...(dropped === null ? {} : { droppedItem: dropped }),
    })
  }
  out.sort((a, b) => a.distance - b.distance)
  // Hostiles inside the widened envelope are never crowded out by passive
  // entities: a full animal budget must not hide the mob that is shooting.
  const hostiles = out.filter((entity) => entity.hostile).length
  return out.slice(0, Math.max(options.maxEntities, hostiles))
}

/**
 * THE AIM POINT of an entity: `position + height / 2`.
 *
 * This is the point `executor.runAttack` looks at immediately before it swings
 * (`bot.lookAt(entity.position.offset(0, entity.height * 0.5, 0), true)`) and the
 * point `selectAttackStand` casts its visibility ray to. Everything that asks
 * "can the body see/interact with this entity" is really asking about THIS point,
 * not about the block its feet happen to be inside.
 *
 * The height comes from the live entity when it carries one and otherwise from
 * the registry row for its name. `prismarine-entity` constructs EVERY entity with
 * `height = 0` and `width = 0`; only Mineflayer's spawn handler fills them in
 * (`lib/plugins/entities.js` `setEntityData`). A `0` is therefore "not filled in
 * yet", never "a zero-tall mob" - so it is resolved from the registry instead of
 * being believed. `null` means the height could not be resolved at all: UNKNOWN,
 * and never an invented aim point.
 */
export function entityAimPoint(
  bot: Bot,
  entity: { position: Vec3Json; height?: number; name?: string },
): Vec3Json | null {
  let height: number | null =
    typeof entity.height === 'number' && Number.isFinite(entity.height) && entity.height > 0
      ? entity.height
      : null
  if (height === null) height = registryEntityHeight(bot, entity.name)
  if (height === null) return null
  return { x: entity.position.x, y: entity.position.y + height / 2, z: entity.position.z }
}

/** The entity's height from the connected version's registry, or null. */
function registryEntityHeight(bot: Bot, name: string | undefined): number | null {
  if (typeof name !== 'string' || name.length === 0) return null
  const registry = bot.registry as
    | { entitiesByName?: Record<string, { height?: number } | undefined> }
    | undefined
  const height = registry?.entitiesByName?.[name]?.height
  return typeof height === 'number' && Number.isFinite(height) && height > 0 ? height : null
}

/**
 * Line of sight from an explicit eye position to an entity's AIM POINT.
 *
 * ONE ray, the same `bot.world.raycast` Mineflayer's own `canSeeBlock` uses, with
 * `matcher = null` so it reports the first SOLID block on the segment (non-solid
 * blocks - the portal plane, grass, the entity's own air column - do not stop it).
 *
 * WHY NOT `bot.canSeeBlock(entity)`. Mineflayer's helper cannot answer this
 * question for an ENTITY, and it never returns `true`:
 *
 *   1. it bounds the ray at `headPos.distanceTo(block.position)` - the distance to
 *      the entity's FEET - while aiming it at `block.position.offset(0.5, 0.5,
 *      0.5)`, so the ray always stops short of the point it is aimed at; and
 *   2. its matcher's identity clause is `block.position.equals(inputBlock.position)`,
 *      comparing the entity's FRACTIONAL position against INTEGER block positions,
 *      and its return value repeats the same comparison (`blocks.js` `canSeeBlock`).
 *
 * The second comparison is unsatisfiable, so the fact is structurally `false`.
 * Measured over the whole 3.07M-line live record: `los=true` occurs ZERO times
 * against 1,149 `los=false` and 172 `los=unknown` - including a human player
 * 0.25 m from the body. A `false` that can never be `true` is not a fact, and the
 * feet-vs-aim-point error is worst for exactly the TALL mobs: a 2.9-block
 * enderman standing behind a one-block ledge has its feet occluded and its chest
 * in plain view.
 *
 * `undefined` = UNKNOWN (no world raycast, an unresolvable height, or a
 * degenerate/throwing ray), never an invented verdict.
 */
export function entityVisibleFromEye(
  bot: Bot,
  eye: Vec3Json,
  entity: { position: Vec3Json; height?: number; name?: string },
): boolean | undefined {
  const aim = entityAimPoint(bot, entity)
  if (aim === null) return undefined
  const world = bot.world as unknown as
    | { raycast?: (origin: unknown, direction: unknown, range: number, matcher: null) => unknown }
    | undefined
  if (world === undefined || typeof world.raycast !== 'function') return undefined
  try {
    const dx = aim.x - eye.x
    const dy = aim.y - eye.y
    const dz = aim.z - eye.z
    const range = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (!Number.isFinite(range) || range <= 0) return undefined
    const origin = bot.entity.position.clone().set(eye.x, eye.y, eye.z)
    const direction = bot.entity.position.clone().set(dx / range, dy / range, dz / range)
    const hit = world.raycast(origin, direction, range, null)
    return hit === null || hit === undefined
  } catch {
    return undefined
  }
}

/**
 * Line of sight from the BODY's own eyes to an entity's aim point.
 *
 * The aim-point ray is used whenever the connected world offers one; a caller
 * whose bot has no `world.raycast` (fixtures, replays, offline harnesses) keeps
 * exactly the previous `canSeeBlock` behaviour, so no existing caller changes
 * verdict. Callers with no sight question to ask at all still get `undefined`
 * (UNKNOWN) rather than a false negative.
 */
function canSeeEntity(
  bot: Bot,
  entity: { position: Vec3Json; height?: number; name?: string },
): boolean | undefined {
  const eyeHeight = (bot.entity as unknown as { eyeHeight?: number }).eyeHeight ?? EYE_HEIGHT
  const position = bot.entity.position
  const eye = {
    x: position.x,
    y: position.y + eyeHeight,
    z: position.z,
  }
  const aimPointVerdict = entityVisibleFromEye(bot, eye, entity)
  if (aimPointVerdict !== undefined) return aimPointVerdict
  const canSee = bot.canSeeBlock
  if (typeof canSee !== 'function') return undefined
  try {
    return canSee.call(bot, entity as never) === true
  } catch {
    return undefined
  }
}

/** The entity's held item name, or null when it holds nothing / is not exposed. */
function heldItemName(entity: { heldItem?: { name?: string } | null }): string | null {
  const held = entity.heldItem
  return held != null && typeof held.name === 'string' && held.name.length > 0 ? held.name : null
}

/** The entity names Mineflayer/prismarine-entity use for a dropped-item entity. */
const DROPPED_ITEM_ENTITY_NAMES: ReadonlySet<string> = new Set(['item', 'Item', 'item_stack'])

/**
 * WHICH item a dropped-item entity carries, or null when the entity is not one.
 *
 * `getDroppedItem()` decodes the entity's own spawn metadata; it is the same
 * accessor the executor's pickup already uses, so the sensor and the executor
 * read one definition of "this drop is that item". A fixture entity that does not
 * implement it, or metadata this client cannot decode, yields `null` (UNKNOWN),
 * never an invented name - an unknown drop is not offered as a route.
 */
function droppedItemName(entity: { name?: string; getDroppedItem?: () => { name?: string } | null }): string | null {
  if (typeof entity.name !== 'string' || !DROPPED_ITEM_ENTITY_NAMES.has(entity.name)) return null
  if (typeof entity.getDroppedItem !== 'function') return null
  try {
    const item = entity.getDroppedItem()
    return item != null && typeof item.name === 'string' && item.name.length > 0 ? item.name : null
  } catch {
    return null
  }
}

const HOSTILE_NAMES = new Set([
  'zombie',
  'skeleton',
  'creeper',
  'spider',
  'cave_spider',
  'enderman',
  'witch',
  'slime',
  'magma_cube',
  'pillager',
  'vindicator',
  'ravager',
  'phantom',
  'drowned',
  'husk',
  'stray',
  'blaze',
  'ghast',
  'piglin_brute',
  'warden',
  'hoglin',
  'zoglin',
  // Hostile in vanilla but absent from the list above, so they were invisible to
  // the safety layer: `zombie_villager` neither matches `zombie` nor the
  // `_zombie`/`_skeleton` suffix rule, and the rest are simply other hostile
  // families. Live evidence: a summoned `zombie_villager` damaged the body
  // (`CRITICAL_DAMAGE ... source=zombie_villager`, `DEATH_CAUSE killer=zombie_villager`)
  // while no threat was ever sensed, so no ATTACK/RETREAT was ever offered and
  // the body never fought back.
  'zombie_villager',
  'evoker',
  'illusioner',
  'vex',
  'silverfish',
  'endermite',
  'shulker',
  'guardian',
  'elder_guardian',
  'wither',
  'ender_dragon',
])

function isHostile(name: string, kind: string | undefined): boolean {
  if (HOSTILE_NAMES.has(name)) return true
  if (kind !== undefined && HOSTILE_NAMES.has(kind)) return true
  return name.endsWith('_zombie') || name.endsWith('_skeleton')
}

export function isHostileEntityName(name: string, kind: string | undefined): boolean {
  return isHostile(name, kind)
}

/**
 * Cross-build reuse of expensive `bot.findBlocks` position lists.
 *
 * `findBlocks` is the sensor's hot spot: Mineflayer walks an octahedron of 16^3
 * sections and, for every section whose palette contains a match, materialises
 * all 4096 blocks through `bot.blockAt`. A stalled resident re-runs the same
 * scans every decision (measured ~282k block lookups per build, ~56% of them in
 * the log scan and ~36% in the two station scans).
 *
 * A position list from `findBlocks` depends on exactly three things:
 *   1. `bot.entity.position` floored to the block (Mineflayer uses it as the
 *      search centre), and
 *   2. the world model inside the loaded chunks, and
 *   3. the query (matcher, maxDistance, count), folded into `scanId`.
 *
 * This helper requires (1) and (3) to be identical and (2) to be *proven*
 * unchanged by the caller's `worldRevision`. When that proof is absent
 * (`activeScanRevision === null`) it calls `findBlocks` directly, so fixtures,
 * replays and any non-resident caller keep the uncached behaviour exactly.
 *
 * Everything position-dependent in a `BlockState` (`distance`, `inReach`,
 * `adjacentStandable`) is re-derived from live block reads after the cached
 * positions are returned, so a cached list can never carry a stale distance or
 * a stale stand-affordance. What the cache could hide is a world change that the
 * revision did not witness; the scheduler counts every `blockUpdate`,
 * `chunkColumnLoad` and `chunkColumnUnload`, which is the complete set of
 * mutations Mineflayer applies to `bot.world`.
 */
interface ScanPositionCacheEntry {
  revision: number
  positions: Vec3[]
}

/** Bounded so a long walk cannot accumulate position lists without limit. */
const SCAN_POSITION_CACHE_CAP = 64
const scanPositionCache = new Map<string, ScanPositionCacheEntry>()
let activeScanRevision: number | null = null

/**
 * The read-provenance gate for the CURRENT `buildWorldState` call, or null when the
 * caller cannot establish provenance (fixtures, replays, non-resident callers).
 * Established here rather than threaded through ~40 helper signatures for the same
 * reason `activeScanRevision` is: it is a per-build fact about the bot's world, not
 * a per-helper option. Set and cleared by `buildWorldState` around the build.
 */
let activeDimensionProvenance: DimensionProvenance | null = null

/**
 * The ONE gated world read. Returns `null` - the "this cell is not readable from
 * here" answer every existing caller already handles as unloaded - when the cell's
 * column is not attributable to the live dimension, and records the typed refusal
 * (`DIMENSION_READ_REFUSED`, naming the cell, the read's provenance, the live
 * dimension and the action) through the provenance sink.
 *
 * A null return is deliberately the SAME shape as an unloaded chunk: `unloaded` is
 * already the sensor's no-verdict state, so a refused read cannot be mistaken for
 * absence. In particular `probKnownResources` keeps such a cell `unknown` and never
 * `falsified`, so no durable memory is deleted on the strength of a read we refused.
 */
function sensorBlockAt(bot: Bot, position: Vec3, source = 'world-state'): ReturnType<Bot['blockAt']> {
  const provenance = activeDimensionProvenance
  if (provenance === null) return bot.blockAt(position)
  const verdict = provenance.cellAttribution(position.x, position.z)
  if (verdict.kind === 'attributable') return bot.blockAt(position)
  provenance.refuseRead({
    cell: vecJson(position),
    chunk: verdict.chunk,
    provenance: verdict.dimension,
    liveDimension: verdict.liveDimension,
    reason: verdict.reason ?? 'unknown_column',
    source,
  })
  return null
}

/**
 * The same gate applied to a `findBlocks` position list. `findBlocks` returns
 * positions from every column in Mineflayer's store with no world filter, and some
 * scans (`buildStations`) turn those positions straight into an offer WITHOUT
 * re-reading the block - so the position list itself has to be gated, not only the
 * per-cell reads.
 */
function sensorPositions(positions: Vec3[], source: string): Vec3[] {
  const provenance = activeDimensionProvenance
  if (provenance === null) return positions
  const kept: Vec3[] = []
  for (const position of positions) {
    const verdict = provenance.cellAttribution(position.x, position.z)
    if (verdict.kind === 'attributable') {
      kept.push(position)
      continue
    }
    provenance.refuseRead({
      cell: vecJson(position),
      chunk: verdict.chunk,
      provenance: verdict.dimension,
      liveDimension: verdict.liveDimension,
      reason: verdict.reason ?? 'unknown_column',
      source,
    })
  }
  return kept
}

function stableFindBlocks(
  bot: Bot,
  scanId: string,
  options: Parameters<Bot['findBlocks']>[0],
): Vec3[] {
  const revision = activeScanRevision
  if (revision === null) return sensorPositions(bot.findBlocks(options), scanId)
  const point = bot.entity.position.floored()
  const key = `${scanId}|${bot.game.dimension}|${point.x},${point.y},${point.z}`
  const hit = scanPositionCache.get(key)
  // The gate is applied on the way OUT, on BOTH paths. The hit path used to return
  // the cached raw list directly, which contradicted the comment below and let a
  // cached position list survive a provenance change: the live record shows exactly
  // that shape - `DIMENSION_READ_REFUSED cell=10,59,8 provenance=unknown
  // reason=unknown_column` from the per-cell name read while the cached station
  // position list still offered the cell, so the candidate kept its POSITION but lost
  // its NAME and grounding degraded to `CONTAINER_REFUSED reason=unreachable ...
  // detail=block_unknown` (candidates.ts). `sensorPositions` is idempotent for an
  // already-attributed list, so re-gating a hit costs a map lookup and can only
  // ever REMOVE a position that is no longer attributable.
  if (hit !== undefined && hit.revision === revision) return sensorPositions(hit.positions, scanId)
  const positions = bot.findBlocks(options)
  if (scanPositionCache.size >= SCAN_POSITION_CACHE_CAP) {
    const oldest = scanPositionCache.keys().next().value
    if (oldest !== undefined) scanPositionCache.delete(oldest)
  }
  // The CACHE holds the raw list (it is keyed by the world revision, which counts
  // every column load/unload); the GATE is applied on the way out so a cached list
  // can never smuggle a foreign column past it.
  scanPositionCache.set(key, { revision, positions })
  return sensorPositions(positions, scanId)
}

function buildLogBlocks(bot: Bot, options: SensorOptions, self: SelfState): BlockState[] {
  const positions = stableFindBlocks(bot, `logs:${options.scanRadius}:256`, {
    matching: (block) => LOG_NAME.test(block.name),
    maxDistance: options.scanRadius,
    count: 256,
  })
  // Resolve the cheap, world-read-free facts first, cut to the kept list, and
  // only then probe the 12 stand neighbours. `findAdjacentStandable` costs 36
  // block reads per target, and the old order ran it for up to 256 logs before
  // `slice(0, maxLogs)` threw ~240 of them away. The sort key (distance then y)
  // never depended on adjacency, so the kept list is identical.
  const rows: Array<{ block: Exclude<ReturnType<Bot['blockAt']>, null>; pos: Vec3Json; distance: number; harvest: ReturnType<typeof resolveBlockHarvest> }> = []
  for (const position of positions) {
    const block = sensorBlockAt(bot, position, 'log-scan')
    if (block === null) continue
    const pos = vecJson(position)
    rows.push({
      block,
      pos,
      distance: round2(distance(pos, self.position)),
      harvest: resolveBlockHarvest(bot, block.name),
    })
  }
  rows.sort((a, b) => a.distance - b.distance || b.pos.y - a.pos.y)
  return rows.slice(0, options.maxLogs).map((row) => {
    const adjacentStandable = findAdjacentStandable(bot, row.pos)
    return {
      kind: 'log' as const,
      name: row.block.name,
      position: row.pos,
      distance: row.distance,
      diggable: row.block.diggable,
      inReach: distance(row.pos, self.eyePosition) <= options.reach,
      hasAdjacentStandable: adjacentStandable !== null,
      adjacentStandable,
      yield: row.harvest.yield,
      harvestTool: row.harvest.harvestTool,
      harvestTier: row.harvest.harvestTier,
    }
  })
}

/**
 * Surface stone scan, focused on the current subgoal item.
 *
 * Deep underground stone has no standable neighbour and is therefore not
 * executable under `canDig=false`, so a plain nearest-N scan would only ever
 * return unreachable blocks. Instead we walk columns from the surface down,
 * keep the topmost stone-like block that is exposed to air, and let the caller
 * drop any whose primary drop does not match the focus item.
 */
function buildStoneBlocks(
  bot: Bot,
  options: SensorOptions,
  self: SelfState,
  focusItem: string | null,
): BlockState[] {
  const base = {
    x: Math.floor(self.position.x),
    y: Math.floor(self.position.y),
    z: Math.floor(self.position.z),
  }
  const radius = Math.min(options.scanRadius, 32)
  const top = base.y + 6
  const bottom = base.y - 20
  const scratch = bot.entity.position.clone()
  const out: BlockState[] = []
  const seen = new Set<string>()
  const faces: Array<[number, number, number]> = [
    [0, 1, 0],
    [0, -1, 0],
    [1, 0, 0],
    [-1, 0, 0],
    [0, 0, 1],
    [0, 0, -1],
  ]
  const isExposed = (x: number, y: number, z: number): boolean => {
    for (const [dx, dy, dz] of faces) {
      const neighbour = sensorBlockAt(bot, scratch.set(x + dx, y + dy, z + dz), 'stone-scan')
      if (neighbour !== null && neighbour.boundingBox === 'empty') return true
    }
    return false
  }

  for (let dx = -radius; dx <= radius; dx += 1) {
    for (let dz = -radius; dz <= radius; dz += 1) {
      if (dx * dx + dz * dz > radius * radius) continue
      const x = base.x + dx
      const z = base.z + dz
      for (let y = top; y >= bottom; y -= 1) {
        const block = sensorBlockAt(bot, scratch.set(x, y, z), 'stone-scan')
        if (block === null || !STONE_LIKE.has(block.name)) continue
        if (!isExposed(x, y, z)) break
        const harvest = resolveBlockHarvest(bot, block.name)
        if (focusItem !== null && !resourceMatches(harvest.yield, focusItem)) break
        const key = `${x}_${y}_${z}`
        if (!seen.has(key)) {
          seen.add(key)
          const pos = { x, y, z }
          const adjacentStandable = findAdjacentStandable(bot, pos)
          out.push({
            kind: 'stone',
            name: block.name,
            position: pos,
            distance: round2(distance(pos, self.position)),
            diggable: block.diggable,
            inReach: distance(pos, self.eyePosition) <= options.reach,
            hasAdjacentStandable: adjacentStandable !== null,
            adjacentStandable,
            yield: harvest.yield,
            harvestTool: harvest.harvestTool,
            harvestTier: harvest.harvestTier,
          })
        }
        break
      }
    }
  }
  out.sort((a, b) => a.distance - b.distance || b.position.y - a.position.y)
  return out.slice(0, options.maxStoneBlocks)
}

/**
 * Buried stone-like blocks near the bot, used only as tunnel targets. Unlike
 * `buildStoneBlocks` (which keeps the topmost *exposed* block per column), this
 * records solid stone with no walk-up access so the agent knows where to dig
 * toward when no exposed stone is reachable under `canDig=false`.
 */
function buildBuriedStoneBlocks(
  bot: Bot,
  options: SensorOptions,
  self: SelfState,
  focusItem: string | null,
  scanAllStone = false,
): BlockState[] {
  if (focusItem === null && !scanAllStone) return []
  if (focusItem !== null && !STONE_YIELDS.has(focusItem)) return []
  const radius = Math.min(options.scanRadius, 24)
  const positions = stableFindBlocks(bot, `buriedStone:${radius}:96`, {
    matching: (block) => STONE_LIKE.has(block.name),
    maxDistance: radius,
    count: 96,
  })
  const out: BlockState[] = []
  for (const position of positions) {
    const block = sensorBlockAt(bot, position, 'buried-stone-scan')
    if (block === null) continue
    const pos = vecJson(position)
    const harvest = resolveBlockHarvest(bot, block.name)
    if (focusItem !== null && !resourceMatches(harvest.yield, focusItem)) continue
    if (distance(pos, self.position) <= options.reach) continue
    const adjacentStandable = findAdjacentStandable(bot, pos)
    out.push({
      kind: 'stone',
      name: block.name,
      position: pos,
      distance: round2(distance(pos, self.position)),
      diggable: block.diggable,
      inReach: distance(pos, self.eyePosition) <= options.reach,
      hasAdjacentStandable: adjacentStandable !== null,
      adjacentStandable,
      yield: harvest.yield,
      harvestTool: harvest.harvestTool,
      harvestTier: harvest.harvestTier,
    })
  }
  out.sort((a, b) => a.distance - b.distance)
  return out.slice(0, options.maxStoneBlocks)
}

/**
 * Keep a bounded near-field envelope of every grounded block that can provide
 * a placeable item. `buildStoneBlocks` intentionally keeps the topmost exposed
 * stone per column for route planning; that invariant is wrong for capability
 * acquisition because a nearby producer can be exposed below a buried block
 * in the same column (live pocket: andesite at (4,54,13) below buried stone).
 *
 * This is sensor truth only. It does not choose a block or add a semantic goal;
 * `mineCandidates` still applies reach, visibility, pickup and tool guards and
 * the prerequisite envelope tags the resulting candidate.
 */
function buildNearbyPlaceableProducers(bot: Bot, options: SensorOptions, self: SelfState): BlockState[] {
  const radius = Math.max(options.reach + 2, 8)
  const positions = stableFindBlocks(bot, `nearbyPlaceable:${radius}:256`, {
    matching: (block) => STONE_LIKE.has(block.name),
    maxDistance: radius,
    count: 256,
  })
  const out: BlockState[] = []
  for (const position of positions) {
    const block = sensorBlockAt(bot, position, 'placeable-producer-scan')
    if (block === null) continue
    const pos = vecJson(position)
    const harvest = resolveBlockHarvest(bot, block.name)
    if (typeof harvest.yield !== 'string' || !PILLAR_PLACE_PRIORITY.includes(harvest.yield)) continue
    const inReach = distance(pos, self.eyePosition) <= options.reach
    const adjacentStandable = findAdjacentStandable(bot, pos)
    out.push({
      kind: 'stone',
      name: block.name,
      position: pos,
      distance: round2(distance(pos, self.position)),
      diggable: block.diggable,
      inReach,
      hasAdjacentStandable: adjacentStandable !== null,
      adjacentStandable,
      yield: harvest.yield,
      harvestTool: harvest.harvestTool,
      harvestTier: harvest.harvestTier,
      visible: blockVisible(bot, { position: pos }, inReach),
    })
  }
  out.sort((a, b) => a.distance - b.distance || b.position.y - a.position.y)
  return out.slice(0, Math.max(options.maxStoneBlocks, 64))
}

/**
 * Name scan for the current collect subgoal. Ores are found by name through
 * `bot.findBlocks` (which sees loaded chunks in every direction) so buried and
 * deepslate ores become tunnel targets, not just exposed surface veins. Direct
 * (non-ore) drops such as obsidian use the same scan so a sensed lava-adjacent
 * block is real candidate-generation truth instead of invisible.
 */
function buildScannedResourceBlocks(
  bot: Bot,
  options: SensorOptions,
  self: SelfState,
  focusItem: string | null,
): BlockState[] {
  const sources = scannedBlockNames(focusItem)
  if (sources === undefined) return []
  const wanted = new Set(sources)
  const radius = Math.max(options.scanRadius, 64)
  const positions = stableFindBlocks(bot, `scanned:${focusItem ?? 'none'}:${radius}:96`, {
    matching: (block) => wanted.has(block.name),
    maxDistance: radius,
    count: 96,
  })
  const out: BlockState[] = []
  for (const position of positions) {
    const block = sensorBlockAt(bot, position, 'resource-scan')
    if (block === null) continue
    const pos = vecJson(position)
    const adjacentStandable = findAdjacentStandable(bot, pos)
    const harvest = resolveBlockHarvest(bot, block.name)
    out.push({
      kind: 'ore',
      name: block.name,
      position: pos,
      distance: round2(distance(pos, self.position)),
      diggable: block.diggable,
      inReach: distance(pos, self.eyePosition) <= options.reach,
      hasAdjacentStandable: adjacentStandable !== null,
      adjacentStandable,
      yield: harvest.yield,
      harvestTool: harvest.harvestTool,
      harvestTier: harvest.harvestTier,
    })
  }
  out.sort((a, b) => a.distance - b.distance)
  return out.slice(0, 48)
}

/** Bound on food-source cells the sensor keeps (and probes adjacency for). */
const FOOD_SOURCE_SCAN_CAP = 24

/**
 * Food-source scan for a hungry body.
 *
 * The measured live failure (run-muc0l5fp-158ak / run-mubobiq6-12onv lineage):
 * `food=0` for a whole run with an oak/birch forest in reach, because the food
 * focus declared no scanned block names at all, so no edible block was ever in
 * the world state and no forage/acquire route could be generated. This scan is
 * the perception half of the fix: while the live hunger bar is at/below the eat
 * gate, every block the running data version can turn into food
 * (`foodSources.foodSourceSpecs`) is name-scanned and tagged with what it
 * yields. The candidate layer decides whether the route is offered; this
 * function only reports what is there.
 */
function buildFoodSourceBlocks(bot: Bot, options: SensorOptions, self: SelfState): BlockState[] {
  const eatBelow = typeof options.eatBelowFood === 'number' ? options.eatBelowFood : DEFAULT_EAT_BELOW_FOOD
  if (!(Number.isFinite(self.food) && self.food <= eatBelow)) return []
  const specs = foodSourceSpecs((bot as { registry?: FoodSourceRegistry }).registry ?? null)
  if (specs.size === 0) return []
  const radius = Math.max(options.scanRadius, 64)
  const positions = stableFindBlocks(bot, `food:${radius}:48`, {
    matching: (block) => specs.has(block.name),
    maxDistance: radius,
    count: 48,
  })
  // Resolve the cheap facts only for the NEAREST cells: `findAdjacentStandable`
  // costs 36 block reads per target, so probing all 48 candidates to keep 24 is
  // the same waste the log scan was optimized out of.
  const nearest = [...positions]
    .sort((a, b) => distance(vecJson(a), self.position) - distance(vecJson(b), self.position))
    .slice(0, FOOD_SOURCE_SCAN_CAP)
  const out: BlockState[] = []
  for (const position of nearest) {
    const block = sensorBlockAt(bot, position, 'food-scan')
    if (block === null) continue
    const spec = specs.get(block.name)
    if (spec === undefined) continue
    const pos = vecJson(position)
    const adjacentStandable = findAdjacentStandable(bot, pos)
    const harvest = resolveBlockHarvest(bot, block.name)
    out.push({
      kind: 'ore',
      name: block.name,
      position: pos,
      distance: round2(distance(pos, self.position)),
      diggable: block.diggable,
      inReach: distance(pos, self.eyePosition) <= options.reach,
      hasAdjacentStandable: adjacentStandable !== null,
      adjacentStandable,
      yield: harvest.yield,
      harvestTool: harvest.harvestTool,
      harvestTier: harvest.harvestTier,
      foodRoute: spec.route,
      foodItem: spec.item,
    })
  }
  out.sort((a, b) => a.distance - b.distance)
  return out.slice(0, FOOD_SOURCE_SCAN_CAP)
}

/**
 * Blocks that can occupy a remembered resource cell without disproving the
 * memory: air/fluids are indistinguishable from a not-yet-sent chunk section
 * here, so they stay `unknown`. Only a DIFFERENT solid block is positive proof
 * that the remembered resource is gone.
 */
/**
 * Loaded cells whose content PROVES a remembered resource is no longer there.
 *
 * Mineflayer's `bot.blockAt` contract distinguishes the two cases this classifier
 * must not merge (#406): `null` means the cell is not loaded (no verdict), while a
 * returned `Block('air')` means the loaded cell IS air. So air variants and fluids
 * at a remembered resource cell are positive evidence of absence - the route is
 * stale - not "unknown".
 */
const ABSENCE_PROVING_CELL_BLOCKS: ReadonlySet<string> = new Set([
  'air',
  'cave_air',
  'void_air',
  'water',
  'flowing_water',
  'lava',
  'flowing_lava',
])

function sameRememberedFamily(remembered: string, observed: string): boolean {
  return (
    (remembered.endsWith('_ore') && observed.endsWith('_ore')) ||
    (remembered.endsWith('_log') && observed.endsWith('_log'))
  )
}

/** Does a remembered cell belong to the active focus's scanned source names? */
function rememberedMatchesFocus(focusItem: string | null, name: string): boolean {
  if (focusItem === null) return false
  // A cell remembered as the item itself (loot, a death drop) is matched by
  // identity: no block-source table can name it.
  if (name === focusItem) return true
  const sources = scannedBlockNames(focusItem)
  if (sources !== undefined) return sources.includes(name)
  if (
    focusItem === 'log' ||
    focusItem === 'charcoal' ||
    focusItem === 'planks' ||
    focusItem === 'fuel' ||
    focusItem.endsWith('_log')
  ) {
    return name.endsWith('_log')
  }
  return false
}

/** A raw entity from `bot.entities`, defensively typed (fixture doubles included). */
interface LiveEntityLike {
  name?: string
  username?: string | null
  kind?: string
  position?: { x: number; y: number; z: number }
  getDroppedItem?: () => { name?: string } | null
}

/** Live producer/drop evidence a remembered producer/drop claim needs. */
export interface KnownResourceProbeOptions {
  /**
   * Every want item this tick's retrieval machinery could route to: the active
   * focus PLUS any queued want the explicit descent proxy exposes (see
   * `candidates.ts#retrievalNeeds`). Defaults to the single `focusItem`, so a
   * caller that does not know about queued wants keeps its exact scope.
   */
  items?: readonly (string | null)[]
  /** live general-entity radius (`SensorOptions.entityRadius`) */
  entityRadius?: number
  /** widened hostile radius (`SensorOptions.hostileRadius`) */
  hostileRadius?: number
}

/**
 * #14-world-proof: positive live-world evidence for the remembered resource
 * cells the retrieval machinery would otherwise offer as targets.
 *
 * The durable staleness eviction (`generation-entry.ts#evictStaleKnownResources`)
 * only probes cells inside a 24-block "definitely loaded" radius. A memory that
 * the loaded world contradicts farther away (the measured M2 case: remembered
 * obsidian cells that now read as stone, ~50 blocks from the resident) therefore
 * stayed a live `RETRIEVE:known:obsidian` route forever and the body kept walking
 * to it. This probe reads the actual block at the cell: `bot.blockAt` returns
 * null for an unloaded chunk, so a far-but-loaded replacement is provable while
 * an unloaded one stays `unknown`.
 *
 * The verdict follows the CLAIM the cell makes (`knownResourceClaimFor`), because
 * "the block is still there" is not the truth a mob-drop memory asserts: a
 * remembered fortress body whose producers are all absent is a stale route even
 * though every `nether_bricks` block still stands (the measured M3 shape: the
 * body walked to remembered fortress cells for `blaze_rod` while the run's own
 * entity sensor reported `sensed=0`). A `producer`/`drop` claim is therefore
 * verified against the live ENTITY envelope, and absence is only a verdict inside
 * the radius that envelope actually covers: an unloaded cell, a read failure, or
 * a cell beyond the sensor's radius stays `unknown`, never "gone".
 *
 * It is world truth only (CAN/TRUE): the sensor removes `falsified` cells from
 * `signals.knownResources` and reports the typed evidence; no goal, action or
 * ranking is decided here. Pure aside from the read-only `bot` probes.
 */
export function probeKnownResources(
  bot: Bot,
  focusItem: string | null,
  remembered: readonly KnownResource[],
  options: KnownResourceProbeOptions = {},
): KnownResourceEvidence[] {
  const items = (options.items ?? [focusItem]).filter(
    (item): item is string => typeof item === 'string' && item.length > 0,
  )
  if (items.length === 0) return []
  const entityRadius = options.entityRadius ?? defaultSensorOptions.entityRadius
  const hostileRadius = options.hostileRadius ?? defaultSensorOptions.hostileRadius
  const entities = liveEntities(bot)
  // One cell, one verdict: a cell matching several wants resolves to the
  // strongest one (falsified wins), because the candidate layer withholds a cell
  // by coordinate regardless of which want it was serving.
  const byCell = new Map<string, KnownResourceEvidence>()
  for (const resource of remembered) {
    if (resource.kind !== 'ore' && resource.kind !== 'log' && resource.kind !== 'structure') continue
    for (const item of items) {
      if (!rememberedMatchesFocus(item, resource.name)) continue
      const evidence = probeRememberedCell(bot, entities, resource, item, entityRadius, hostileRadius)
      if (evidence === null) continue
      const cell = `${evidence.position.x},${evidence.position.y},${evidence.position.z}`
      byCell.set(cell, preferredEvidence(byCell.get(cell), evidence))
    }
  }
  return [...byCell.values()]
}

const EVIDENCE_RANK: Readonly<Record<KnownResourceEvidenceStatus, number>> = {
  unknown: 0,
  replaced: 1,
  present: 2,
  falsified: 3,
}

function preferredEvidence(
  previous: KnownResourceEvidence | undefined,
  next: KnownResourceEvidence,
): KnownResourceEvidence {
  if (previous === undefined) return next
  return EVIDENCE_RANK[next.status] >= EVIDENCE_RANK[previous.status] ? next : previous
}

/** `bot.entities`, or null when this bot double cannot report entities at all. */
function liveEntities(bot: Bot): Record<string, LiveEntityLike> | null {
  const entities = (bot as { entities?: unknown }).entities
  if (entities === null || typeof entities !== 'object') return null
  return entities as Record<string, LiveEntityLike>
}

/** The bot's own feet cell, or null when the double exposes no entity. */
function botSelfPosition(bot: Bot): Vec3Json | null {
  const position = (bot as { entity?: { position?: { x: number; y: number; z: number } } }).entity?.position
  if (position === undefined) return null
  return { x: position.x, y: position.y, z: position.z }
}

/**
 * The cell's live block. `loaded: false` is Mineflayer's "chunk not loaded" (or a
 * read failure); a loaded cell always yields a name, `air` included (#406).
 */
function readCellBlock(
  bot: Bot,
  cell: Vec3Json,
): { name: string | null; loaded: boolean; boundingBox: string | null } {
  try {
    const block = sensorBlockAt(bot, new Vec3(cell.x, cell.y, cell.z), 'probe-known-resources') as {
      name?: string
      boundingBox?: string
    } | null
    if (block === null || block === undefined) return { name: null, loaded: false, boundingBox: null }
    return {
      name: typeof block.name === 'string' ? block.name : null,
      loaded: true,
      boundingBox: typeof block.boundingBox === 'string' ? block.boundingBox : null,
    }
  } catch {
    return { name: null, loaded: false, boundingBox: null }
  }
}

/** A dropped item's item name, or null when this entity is not a dropped item. */
function droppedItemOf(entity: LiveEntityLike): string | null {
  if (entity.name !== 'item' && entity.name !== 'Item' && entity.name !== 'item_stack') return null
  try {
    const item = entity.getDroppedItem?.()
    return item != null && typeof item.name === 'string' && item.name.length > 0 ? item.name : null
  } catch {
    return null
  }
}

/**
 * Is a live producer instance (or a dropped instance of the wanted item) sensed
 * inside the cell's own neighbourhood? `entities === null` means the bot double
 * cannot report entities, which is NOT "nothing is there".
 */
function liveProducerOrDrop(
  entities: Record<string, LiveEntityLike> | null,
  cell: Vec3Json,
  producers: ReadonlySet<string>,
  item: string,
  radius: number,
): 'mob' | 'drop' | null {
  if (entities === null) return null
  for (const entity of Object.values(entities)) {
    const position = entity?.position
    if (position === undefined) continue
    if (distance({ x: position.x, y: position.y, z: position.z }, cell) > radius) continue
    // A PLAYER is never the producer: `buildEntities` reads `username` first, so
    // an online player named `blaze` must not verify a fortress.
    if (typeof entity.username !== 'string') {
      if (typeof entity.name === 'string' && producers.has(entity.name)) return 'mob'
      if (typeof entity.kind === 'string' && producers.has(entity.kind)) return 'mob'
    }
    if (droppedItemOf(entity) === item) return 'drop'
  }
  return null
}

/** The radius the entity sensor covers for these producers (hostiles are widened). */
function producerProofRadius(
  producers: ReadonlySet<string>,
  entityRadius: number,
  hostileRadius: number,
): number {
  let radius = 0
  for (const producer of producers) {
    radius = Math.max(radius, isHostile(producer, undefined) ? hostileRadius : entityRadius)
  }
  return radius
}

function probeRememberedCell(
  bot: Bot,
  entities: Record<string, LiveEntityLike> | null,
  resource: KnownResource,
  item: string,
  entityRadius: number,
  hostileRadius: number,
): KnownResourceEvidence | null {
  const position = resource.position
  const cell: Vec3Json = { x: position.x, y: position.y, z: position.z }
  const block = readCellBlock(bot, cell)
  const claim = knownResourceClaimFor(resource.name, item)
  if (claim === 'producer' || claim === 'drop') {
    const producers = claim === 'producer' ? landmarkProducers(resource.name) : new Set<string>()
    // A landmark with no declared producers is not a producer route: verify it as
    // the block it is instead of inventing a mob claim for it.
    if (claim === 'producer' && producers.size === 0) {
      return blockEvidence(resource, item, block, 'block', [])
    }
    const radius = claim === 'drop' ? entityRadius : producerProofRadius(producers, entityRadius, hostileRadius)
    const source = liveProducerOrDrop(entities, cell, producers, item, radius)
    if (source !== null) {
      return { name: resource.name, position: cell, observed: block.name, status: 'present', claim, item, source }
    }
    const self = botSelfPosition(bot)
    // No producer/drop inside the envelope. That is a contradiction only when the
    // cell is actually observable (loaded + inside the radius the entity sensor
    // covers); otherwise it is UNKNOWN - a mob that walked away, a chunk that is
    // not loaded or a cell out of sensor range is never proof of absence.
    if (entities === null || self === null || !block.loaded || distance(self, cell) > radius) {
      return { name: resource.name, position: cell, observed: block.name, status: 'unknown', claim, item }
    }
    return {
      name: resource.name,
      position: cell,
      observed: block.name,
      status: 'falsified',
      claim,
      item,
      reason: claim === 'drop' ? 'drop_absent' : 'mob_gone',
    }
  }
  return blockEvidence(resource, item, block, claim, scannedBlockNames(item) ?? [])
}

/** The live-block verdict for a cell whose claim is the block itself. */
function blockEvidence(
  resource: KnownResource,
  item: string,
  block: { name: string | null; loaded: boolean; boundingBox: string | null },
  claim: KnownResourceClaim,
  focusSources: readonly string[],
): KnownResourceEvidence {
  const cell: Vec3Json = { x: resource.position.x, y: resource.position.y, z: resource.position.z }
  const observed = block.loaded ? block.name : null
  let status: KnownResourceEvidenceStatus
  let reason: KnownResourceFalsifiedReason | undefined
  if (observed === null) status = 'unknown'
  else if (observed === resource.name) status = 'present'
  // A same-family variant (ore -> deepslate ore) or another declared source
  // name for this focus (nether_bricks -> nether_brick_fence) still serves the
  // want, so the cell stays a valid route and is reported as `replaced`.
  else if (sameRememberedFamily(resource.name, observed) || focusSources.includes(observed)) status = 'replaced'
  // Any other LOADED block falsifies the memory: `null` above is the only
  // no-verdict case (unloaded cell). Air/fluids and empty-shape blocks are a
  // loaded cell whose resource is gone, so a stale RETRIEVE route must not
  // survive them (#406).
  else if (ABSENCE_PROVING_CELL_BLOCKS.has(observed) || block.boundingBox === 'empty') {
    status = 'falsified'
    reason = 'block_mined'
  } else {
    status = 'falsified'
    reason = 'block_mined'
  }
  return {
    name: resource.name,
    position: cell,
    observed,
    status,
    claim,
    item,
    ...(reason === undefined ? {} : { reason }),
  }
}

function buildHazardBlocks(bot: Bot, options: SensorOptions, self: SelfState): BlockState[] {
  const out: BlockState[] = []
  const positions = stableFindBlocks(bot, `hazards:${options.hazardRadius}:32`, {
    matching: (block) => HAZARDS.has(block.name),
    maxDistance: options.hazardRadius,
    count: 32,
  })
  for (const position of positions) {
    const block = sensorBlockAt(bot, position, 'hazard-scan')
    if (block === null) continue
    const pos = vecJson(position)
    out.push({
      kind: 'hazard',
      name: block.name,
      position: pos,
      distance: round2(distance(pos, self.position)),
      diggable: block.diggable,
      inReach: false,
      hasAdjacentStandable: false,
      adjacentStandable: null,
      yield: null,
      harvestTool: null,
    })
  }
  out.sort((a, b) => a.distance - b.distance)
  return out
}

/**
 * The mob names the tick declared a producer FOR: the active focus item's
 * `MOB_DROP_PRODUCERS` row, or null when the focus is not a mob drop.
 *
 * The focus is read in the same order `buildBlocks` reads it (`input.focusItem`,
 * then the goal's own target), so the scan and the spawn context can never
 * disagree about which item the tick is about. Pure.
 */
function focusMobProducers(input: SensorInput): ReadonlySet<string> | null {
  const focus = input.focusItem ?? input.goal.targetItem ?? null
  if (focus === null) return null
  return MOB_DROP_PRODUCERS[focus] ?? null
}

function buildBlocks(
  bot: Bot,
  options: SensorOptions,
  self: SelfState,
  focusItem: string | null,
  inventoryCounts: Readonly<Record<string, number>>,
): BlockState[] {
  const logs = buildLogBlocks(bot, options, self)
  const stoneFocus = focusItem !== null && STONE_YIELDS.has(focusItem) ? focusItem : null
  // A vertical Skill can be mechanically blocked by the absence of a held
  // placeable block while the parent Option is collecting/crafting something
  // else (the live log route is the canonical example).  The prerequisite
  // solver is deliberately allowed to acquire cobblestone from grounded stone
  // producers, but that requires the sensor to retain those producers outside
  // the current semantic focus.  This is perception of a mechanical fact, not
  // a semantic goal switch: keep the extra scan bounded and only enable it
  // while the capability is actually missing.
  const scanPrerequisiteStone = stoneFocus === null && selectPlaceableBlock(inventoryCounts) === null
  const stoneScanOptions = scanPrerequisiteStone
    ? { ...options, maxStoneBlocks: Math.max(options.maxStoneBlocks, 64) }
    : options
  const stones =
    stoneFocus !== null
      ? buildStoneBlocks(bot, options, self, stoneFocus)
      : scanPrerequisiteStone
        ? buildStoneBlocks(bot, stoneScanOptions, self, null)
        : []
  const nearbyPlaceableProducers = scanPrerequisiteStone
    ? buildNearbyPlaceableProducers(bot, stoneScanOptions, self)
    : []
  const buried =
    stoneFocus !== null
      ? buildBuriedStoneBlocks(bot, options, self, stoneFocus)
      : scanPrerequisiteStone
        ? buildBuriedStoneBlocks(bot, stoneScanOptions, self, null, true)
        : []
  const ores = buildScannedResourceBlocks(bot, options, self, focusItem)
  // A hungry body's food sources are sensed independently of the active focus:
  // the measured live starvation ran under a `craft acacia_planks` goal, so a
  // focus-only scan would have kept every edible block invisible.
  const foodSources = buildFoodSourceBlocks(bot, options, self)
  const hazards = buildHazardBlocks(bot, options, self)
  // Keep the bounded capability envelope ahead of the broad route-planning
  // stone scan. This is not a semantic ranking: `mineCandidates` applies a
  // typed placeable-producer filter, but its mechanical candidate cap must not
  // be consumed by unrelated stone cells before the near producer is seen.
  const blocks = [...logs, ...nearbyPlaceableProducers, ...stones, ...buried, ...ores, ...foodSources, ...hazards]
  const seen = new Set<string>()
  return blocks.filter((block) => {
    const key = `${block.kind}:${block.position.x},${block.position.y},${block.position.z}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Max SENSED stations per kind kept from the near-field block scan.
 */
export const SENSED_STATION_CAP = 8

/**
 * Max REMEMBERED stations per kind merged from the host's durable memory. This
 * is a safety bound against an unbounded host list, not a filter: the host
 * keeps only validated, selectable stations (measured live: 14 tables + 3
 * furnaces), far below this bound, so a validated station is never silently
 * dropped. Raise it if the durable station count can approach it.
 */
export const REMEMBERED_STATION_CAP = 256

function stationCellKey(position: Vec3Json): string {
  return `${position.x},${position.y},${position.z}`
}

function rememberedStationPositions(
  remembered: readonly KnownResource[],
  names: ReadonlySet<string>,
): Vec3Json[] {
  const out: Vec3Json[] = []
  for (const resource of remembered) {
    if (resource.kind !== 'station') continue
    if (!names.has(resource.name)) continue
    out.push(resource.position)
  }
  return out
}

/**
 * Perceived stations of one kind. The live scan stays near-field (16 blocks):
 * it answers "can I see it now", and `isSensedStation` is what in-place
 * preconditions consume. Durable, host-validated records (validation radius 48
 * in `generation-entry.ts`) are merged in as `remembered` so a known station is
 * never invisible just because it is beyond the scan radius. Sensed entries are
 * authoritative: a remembered duplicate of a sensed cell is dropped.
 */
function buildStations(
  bot: Bot,
  options: SensorOptions,
  self: SelfState,
  names: ReadonlySet<string>,
  remembered: readonly KnownResource[],
): StationEntry[] {
  const radius = Math.max(16, options.reach + 8)
  // One cache id per station kind (the `names` set is the query). The two live
  // station scans were ~36% of all block lookups in a stalled build.
  const scanId = `stations:${[...names].sort().join(',')}:${radius}:${SENSED_STATION_CAP}`
  const sensed: StationEntry[] = stableFindBlocks(bot, scanId, {
    matching: (block) => names.has(block.name),
    maxDistance: radius,
    count: SENSED_STATION_CAP,
  })
    .map((position) => ({ ...vecJson(position), source: 'sensed' as const }))
    .sort((a, b) => distance(a, self.position) - distance(b, self.position))
  const sensedCells = new Set(sensed.map((station) => stationCellKey(station)))
  const rememberedEntries: StationEntry[] = rememberedStationPositions(remembered, names)
    .filter((position) => !sensedCells.has(stationCellKey(position)))
    .map((position) => ({ ...position, source: 'remembered' as const }))
    .sort((a, b) => distance(a, self.position) - distance(b, self.position))
  return [...sensed, ...rememberedEntries.slice(0, REMEMBERED_STATION_CAP)]
}

function buildFurnaces(
  bot: Bot,
  options: SensorOptions,
  self: SelfState,
  remembered: readonly KnownResource[],
): StationEntry[] {
  return buildStations(bot, options, self, FURNACE_STATIONS, remembered)
}

/**
 * The container projection: the SAME `buildStations` scan/merge the crafting
 * table and furnace use, plus the container's own block NAME so a candidate can
 * declare the truthful `name@x,y,z` reference it will open.
 *
 * A sensed entry resolves its name from the live block (bounded: at most
 * `SENSED_STATION_CAP` reads). A remembered entry keeps the name the durable
 * memory recorded, which the host re-validated against live world truth
 * (`validateRememberedStations`) - so an unloaded remembered container still
 * names itself, and the executor's own live read is what refuses it if the
 * block is gone.
 */
function buildContainers(
  bot: Bot,
  options: SensorOptions,
  self: SelfState,
  remembered: readonly KnownResource[],
): StationEntry[] {
  const entries = buildStations(bot, options, self, CONTAINER_STATIONS, remembered)
  return entries.map((entry) => {
    if (entry.source === 'sensed') {
      const live = sensorBlockAt(bot, new Vec3(entry.x, entry.y, entry.z), 'container-scan')?.name ?? null
      if (live !== null && isContainerBlockName(live)) return { ...entry, name: normalizeBlockName(live) }
    }
    const rememberedName = rememberedContainerName(remembered, entry)
    return rememberedName === null ? { ...entry } : { ...entry, name: rememberedName }
  })
}

/** The durable container name recorded for one remembered cell, or null. */
function rememberedContainerName(remembered: readonly KnownResource[], entry: Vec3Json): string | null {
  for (const resource of remembered) {
    if (resource.kind !== 'station') continue
    if (resource.position.x !== entry.x || resource.position.y !== entry.y || resource.position.z !== entry.z) continue
    if (!isContainerBlockName(resource.name)) continue
    return normalizeBlockName(resource.name)
  }
  return null
}

export const PROBE_HAZARDS = new Set(['lava', 'fire', 'magma_block', 'campfire', 'soul_campfire', 'cactus'])
export const PROBE_FLUIDS = new Set(['water', 'flowing_water', 'bubble_column'])

/**
 * The block slice the breakability rule needs.
 */
export interface BreakabilityProbe {
  diggable: boolean
  boundingBox: string
}

/**
 * Minecraft truth for "can this block ever be broken": mineflayer's `diggable`
 * flag is derived from the block hardness (false for bedrock, barrier and the
 * portal blocks), and an empty cell is nothing to break. Tool adequacy is NOT
 * part of this predicate - `hasTool`/`selectDigTool` decide that from
 * `gameData.resolveHarvest`, so obsidian is breakable here (it needs a diamond
 * pickaxe) and must not be excluded by a hardcoded unbreakable list.
 */
export function isBreakableSolidBlock(block: BreakabilityProbe): boolean {
  return block.boundingBox !== 'empty' && block.diggable
}

/**
 * Pre-compute the four cardinal staircase/tunnel steps. This is the only place
 * with live block access, so `candidates.ts` stays a pure function of the state
 * and the guard can re-check a step mechanically. A step is `safe` only when
 * every dig involved is breakable, no lava/water touches the column, and the
 * landing cell has solid support so the bot never drops into a void.
 */
function buildDescent(bot: Bot, options: SensorOptions, self: SelfState): DescentOption[] {
  const feet = {
    x: Math.floor(self.position.x),
    y: Math.floor(self.position.y),
    z: Math.floor(self.position.z),
  }
  const scratch = bot.entity.position.clone()
  const at = (x: number, y: number, z: number) => sensorBlockAt(bot, scratch.set(x, y, z), 'descent')
  const diggableSolid = (x: number, y: number, z: number): boolean => {
    const block = at(x, y, z)
    return block !== null && isBreakableSolidBlock(block)
  }
  const hazardous = (x: number, y: number, z: number): boolean => {
    const block = at(x, y, z)
    return block !== null && (PROBE_HAZARDS.has(block.name) || PROBE_FLUIDS.has(block.name)) && block.boundingBox === 'empty'
  }
  const clear = (x: number, y: number, z: number): boolean => {
    const block = at(x, y, z)
    return block === null || block.boundingBox === 'empty'
  }

  const dirs: Array<{ dir: DescentOption['dir']; dx: number; dz: number }> = [
    { dir: 'E', dx: 1, dz: 0 },
    { dir: 'W', dx: -1, dz: 0 },
    { dir: 'N', dx: 0, dz: -1 },
    { dir: 'S', dx: 0, dz: 1 },
  ]

  const makeOption = (dir: DescentDir, mode: DescentMode, dx: number, dz: number): DescentOption => {
    const ownColumn = dx === 0 && dz === 0
    const wall = { x: feet.x + dx, y: feet.y, z: feet.z + dz }
    const head = { x: feet.x + dx, y: feet.y + 1, z: feet.z + dz }
    const stepY = mode === 'down' ? feet.y - 1 : feet.y
    const step = { x: feet.x + dx, y: stepY, z: feet.z + dz }
    const floor = { x: feet.x + dx, y: feet.y - 1, z: feet.z + dz }
    const support = { x: feet.x + dx, y: stepY - 1, z: feet.z + dz }
    const wallBlock = at(wall.x, wall.y, wall.z)
    const headBlock = at(head.x, head.y, head.z)
    const floorBlock = at(floor.x, floor.y, floor.z)
    const supportBlock = at(support.x, support.y, support.z)
    const wallSolid = wallBlock !== null && wallBlock.boundingBox === 'block'
    const headSolid = headBlock !== null && headBlock.boundingBox === 'block'
    const floorSolid = floorBlock !== null && floorBlock.boundingBox === 'block'
    const supportSolid = supportBlock !== null && supportBlock.boundingBox === 'block'
    const landingUsable = isUsableStandFromBlocks(
      mode === 'level' ? wallBlock : floorBlock,
      mode === 'level' ? headBlock : wallBlock,
      supportBlock,
    )
    // The bot's own column needs no front/head clearance: it digs the floor.
    const wallOk = ownColumn || clear(wall.x, wall.y, wall.z) || diggableSolid(wall.x, wall.y, wall.z)
    const headOk = ownColumn || clear(head.x, head.y, head.z) || diggableSolid(head.x, head.y, head.z)
    const floorOk = mode === 'level' || clear(floor.x, floor.y, floor.z) || diggableSolid(floor.x, floor.y, floor.z)
    // One hazard probe for the whole step: the refusal chain below reports a
    // single (highest-priority) reason, so a step refused as `open_floor` could
    // still sit next to lava. The ordered dig list and the "step into an existing
    // opening" route both need the hazard fact separately from the refusal.
    const hazardNearby = hazardsAround(hazardous, wall, head, floor, step, support)
    let reason = 'safe'
    let refusal: DescentRefusalReason | undefined
    const protectedDig = [wall, head, floor]
      .map((cell) => at(cell.x, cell.y, cell.z))
      .find((block) => block !== null && isProtectedStationBlock(block.name))
    if (protectedDig !== undefined && protectedDig !== null) {
      reason = `${protectedDig.name} is a protected station`
      refusal = 'protected'
    } else if (!wallOk) {
      reason = `${at(wall.x, wall.y, wall.z)?.name ?? 'unknown'} wall is not breakable`
      refusal = 'unbreakable'
    } else if (!headOk) {
      reason = `${at(head.x, head.y, head.z)?.name ?? 'unknown'} head-cell is not breakable`
      refusal = 'unbreakable'
    } else if (!floorOk) {
      reason = `${at(floor.x, floor.y, floor.z)?.name ?? 'unknown'} floor is not breakable`
      refusal = 'unbreakable'
    } else if (!supportSolid) {
      reason = `no solid support at (${support.x},${support.y},${support.z})`
      refusal = 'no_support'
    } else if (mode === 'down' && clear(floor.x, floor.y, floor.z)) {
      reason = 'floor already open (uncontrolled fall)'
      refusal = 'open_floor'
    } else if (hazardNearby) {
      reason = 'lava/water in the step column'
      refusal = 'hazard'
    }
    const primary = mode === 'down' ? (floorSolid ? floor : wall) : wallSolid ? wall : head
    const primaryBlock = at(primary.x, primary.y, primary.z)
    // The body's 1x2 profile at the landing: the cell it stands in and the cell above it.
    // A transfer block in either one means this step is not a locomotion step but a
    // dimension change, whatever the tool gate says.
    const landingHead = { x: step.x, y: step.y + 1, z: step.z }
    const transfersDimension =
      isDimensionTransferBlock(at(step.x, step.y, step.z)?.name) ||
      isDimensionTransferBlock(at(landingHead.x, landingHead.y, landingHead.z)?.name)
    const primaryHarvest =
      primaryBlock === null
        ? { yield: null, harvestTool: null, harvestTier: null }
        : resolveBlockHarvest(bot, primaryBlock.name)
    // Everything the body's landing cell occupies, minus the cells that are
    // already open. `down` lands at feet.y - 1 and needs the front cell at
    // feet.y (the body's upper half); `level` lands at feet.y and needs the
    // 2-high corridor (front + head). The own column never digs a cell the body
    // itself occupies.
    const digCells: Vec3Json[] = ownColumn
      ? floorSolid
        ? [floor]
        : []
      : mode === 'down'
        ? [...(wallSolid ? [wall] : []), ...(floorSolid ? [floor] : [])]
        : [...(wallSolid ? [wall] : []), ...(headSolid ? [head] : [])]
    const digs: DescentDigRequirement[] = digCells.map((cell) => {
      const block = at(cell.x, cell.y, cell.z)
      const harvest = block === null ? null : resolveBlockHarvest(bot, block.name)
      return {
        cell,
        name: block?.name ?? null,
        harvestTool: harvest?.harvestTool ?? null,
        harvestTier: harvest?.harvestTier ?? null,
        diggable: block?.diggable ?? false,
      }
    })
    return {
      dir,
      mode,
      dx,
      dz,
      step,
      wall,
      head,
      floor,
      wallSolid,
      headSolid,
      floorSolid,
      supportSolid,
      landingUsable,
      hazardNearby,
      ...(transfersDimension ? { transfersDimension: true } : {}),
      digs,
      safe: reason === 'safe',
      reason,
      ...(refusal === undefined ? {} : { refusal }),
      digName: primaryBlock?.name ?? null,
      digHarvestTool: primaryHarvest.harvestTool,
      digHarvestTier: primaryHarvest.harvestTier,
      diggable: primaryBlock?.diggable ?? false,
    }
  }

  const out: DescentOption[] = []
  for (const { dir, dx, dz } of dirs) {
    for (const mode of ['down', 'level'] as const) out.push(makeOption(dir, mode, dx, dz))
  }
  // #41: the bot's own column is the last-resort descent when every cardinal
  // staircase step is unsafe (open floor / no support / hazard). It digs the
  // block under the feet and drops one controlled block.
  out.push(makeOption('D', 'down', 0, 0))
  return out
}

/**
 * The DOWNWARD self-landing probe (`descentScaffold.ts`): the live truth of the one
 * cell the body would occupy if it placed a floor under its own feet and dropped
 * onto it, plus the cell below that floor.
 *
 * WHY IT EXISTS. The descent vocabulary has two remedies and both are DIGS - cut a
 * cardinal staircase step, or dig the body's own column - so a landing whose
 * support is air can only ever be REFUSED. Measured live (main 974e954, the
 * operator's floated-portal trial, body 23.5,79.0,1.5): 1912 `needs_descend`
 * acquisitions, all carrying the correct typed
 * `descend_plan:no_support@25,78,-2:air`, and no route that could answer it.
 *
 * The mechanic is the MIRROR of the bridge's own `self_landing` scaffold
 * (`bridgeRoute.ts#planBridgeSpan`): there the body lays the floor of the cell it
 * is about to occupy and steps sideways onto it; here it lays the floor of the cell
 * below it and drops onto it. The geometry is the same, rotated: the placement
 * reference is the block the body is already standing on, its BOTTOM face
 * (`bridgeRoute.ts#planBridgeSpan`'s "place against the block under my feet, side
 * face in the direction of travel"). So this adds a probe, not a second rule.
 *
 * BOUNDED, and only where the world needs it: probed only while the body holds a
 * placeable block AND its own sensor pool refused a downward step for `no_support`
 * - the one shape no dig can answer. An ordinary tick reads nothing extra.
 */
function buildDescentScaffoldProbe(
  bot: Bot,
  self: SelfState,
  descent: readonly DescentOption[],
): DescentScaffoldProbe | null {
  // Gate: the body's OWN COLUMN is the one shape this route answers. A descent
  // self-landing is a straight drop - the body lays the floor of the cell under its
  // own feet and stands on it - so the probe is anchored on the own-column step
  // (`dir: 'D'`, the sensor's own last-resort down step). A refused CARDINAL step is
  // a different geometry (it would land one cell sideways) and the ordinary
  // walk/dig remedies own it. Any other refusal reason (`open_floor`, `hazard`,
  // `unbreakable`, `protected`) is already answered or is a hard stop.
  const ownColumn = descent.find((step) => step.dir === 'D' && step.mode === 'down')
  if (ownColumn === undefined || ownColumn.safe || ownColumn.refusal !== 'no_support') return null
  const feet = {
    x: Math.floor(self.position.x),
    y: Math.floor(self.position.y),
    z: Math.floor(self.position.z),
  }
  const scratch = bot.entity.position.clone()
  const at = (x: number, y: number, z: number) => sensorBlockAt(bot, scratch.set(x, y, z), 'descent-scaffold')
  const readCell = (cell: Vec3Json): WallBlockLike | null => {
    const block = at(cell.x, cell.y, cell.z)
    return block === null
      ? null
      : { name: block.name, boundingBox: block.boundingBox, diggable: block.diggable === true }
  }
  const landing = { x: feet.x, y: feet.y - 1, z: feet.z }
  const place = { x: feet.x, y: feet.y - 2, z: feet.z }
  const landingHead = { x: feet.x, y: feet.y, z: feet.z }
  const support = { x: feet.x, y: feet.y - 3, z: feet.z }
  const below = { x: landing.x, y: landing.y - 1, z: landing.z }
  const landingBlock = at(landing.x, landing.y, landing.z)
  const headBlock = at(landingHead.x, landingHead.y, landingHead.z)
  const placeBlock = at(place.x, place.y, place.z)
  const supportBlock = at(support.x, support.y, support.z)
  // The same six-neighbourhood flood reader every wall entry and the bridge
  // self-landing use: a fluid FACE-ADJACENT to the 1x2 pocket the body would
  // occupy would pour in, and the body that lays its own floor has no
  // pre-existing floor verdict to fall back on.
  const flood = floodEvidence([landing, landingHead], readCell)
  // Every cell the step touches, for the hazard verdict - unloaded cells are never
  // hazards (the rule the rest of the sensor uses), so a chunk that has not arrived
  // can only make the step refuse, never look safe.
  const hazardBlocks = [landingBlock, headBlock, placeBlock, supportBlock]
  const hazardBlock: { name: string } | null =
    hazardBlocks.find((block) => block !== null && isBridgeUnsafeBlockName(block.name)) ?? null
  return {
    selfFeet: feet,
    landing,
    place,
    landingOpen: isPassable(landingBlock),
    landingHeadOpen: isPassable(headBlock),
    placeable: isReplaceableAir(placeBlock),
    placeSupported: isSolidSupport(supportBlock),
    supportName: supportBlock?.name ?? null,
    landingName: landingBlock?.name ?? null,
    landingHeadName: headBlock?.name ?? null,
    placeName: placeBlock?.name ?? null,
    belowName: at(below.x, below.y, below.z)?.name ?? null,
    hazard: hazardBlock !== null,
    hazardBlock: hazardBlock?.name ?? null,
    flood: flood !== null,
    floodCell: flood?.cell ?? null,
    floodBlock: flood?.block ?? null,
    footing: isUsableGroundSupport(at(feet.x, feet.y - 1, feet.z)),
  }
}

function hazardsAround(
  hazardous: (x: number, y: number, z: number) => boolean,
  ...cells: Vec3Json[]
): boolean {
  const seen = new Set<string>()
  for (const cell of cells) {
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dz = -1; dz <= 1; dz += 1) {
          const key = `${cell.x + dx}_${cell.y + dy}_${cell.z + dz}`
          if (seen.has(key)) continue
          seen.add(key)
          if (hazardous(cell.x + dx, cell.y + dy, cell.z + dz)) return true
        }
      }
    }
  }
  return false
}

function buildStepCuts(bot: Bot, options: SensorOptions, self: SelfState): StepCut[] {
  const feetX = Math.floor(self.position.x)
  const feetY = Math.floor(self.position.y)
  const feetZ = Math.floor(self.position.z)
  const scratch = bot.entity.position.clone()
  const at = (x: number, y: number, z: number) => sensorBlockAt(bot, scratch.set(x, y, z))
  const solid = (x: number, y: number, z: number): boolean => {
    const block = at(x, y, z)
    return block !== null && block.boundingBox === 'block'
  }
  const usableGround = (x: number, y: number, z: number): boolean => isUsableGroundSupport(at(x, y, z))
  const clear = (x: number, y: number, z: number): boolean => {
    const block = at(x, y, z)
    return block === null || block.boundingBox === 'empty'
  }
  const diggableSolid = (x: number, y: number, z: number): boolean => {
    const block = at(x, y, z)
    return block !== null && isBreakableSolidBlock(block)
  }
  const hazardous = (x: number, y: number, z: number): boolean => {
    const block = at(x, y, z)
    return block !== null && (PROBE_HAZARDS.has(block.name) || PROBE_FLUIDS.has(block.name)) && block.boundingBox === 'empty'
  }

  const dirs: Array<{ dir: StepCut['dir']; dx: number; dz: number }> = [
    { dir: 'E', dx: 1, dz: 0 },
    { dir: 'W', dx: -1, dz: 0 },
    { dir: 'N', dx: 0, dz: -1 },
    { dir: 'S', dx: 0, dz: 1 },
  ]

  const out: StepCut[] = []
  for (const { dir, dx, dz } of dirs) {
    for (const dist of [1, 2, 3]) {
      const x = feetX + dx * dist
      const z = feetZ + dz * dist
      let top: number | null = null
      for (let y = feetY + 2; y >= feetY - 1; y -= 1) {
        if (solid(x, y, z)) {
          top = y
          break
        }
      }
      if (top === null) continue
      if (top - (feetY - 1) < 2) continue
      const cut = { x, y: top, z }
      const step = { x, y: top, z }
      const name = at(x, top, z)?.name ?? 'unknown'
      let reason = 'safe'
      if (isProtectedStationBlock(name)) reason = `${name} is a protected station`
      else if (!diggableSolid(x, top, z)) reason = `${name} is not breakable`
      // The landing must be usable GROUND, not merely solid: a cut whose step
      // rests on a leaf block turns a treetop into an up-staircase destination
      // (measured live: `STEP:N:b75_78_8 phase=digging` while the body clambered
      // through a canopy at y=74-78).
      else if (!usableGround(x, top - 1, z)) reason = 'no usable ground under the cut'
      else if (!clear(x, top + 1, z) || !clear(x, top + 2, z)) reason = 'no headroom above the new step'
      else if (hazardsAround(hazardous, cut, step, { x, y: top - 1, z })) reason = 'lava/water in the step column'
      out.push({ dir, dx, dz, cut, step, name, safe: reason === 'safe', reason })
      break
    }
  }
  return out
}

function buildHeadroomCuts(bot: Bot, options: SensorOptions, self: SelfState): HeadroomCut[] {
  const feetX = Math.floor(self.position.x)
  const feetY = Math.floor(self.position.y)
  const feetZ = Math.floor(self.position.z)
  const scratch = bot.entity.position.clone()
  const at = (x: number, y: number, z: number) => sensorBlockAt(bot, scratch.set(x, y, z))
  const halfWidth = bot.entity.width > 0 ? bot.entity.width / 2 : 0.3
  const current = headroomAcrossFootprint({
    center: { x: self.position.x, z: self.position.z },
    feetY: self.position.y,
    halfWidth,
    // Match executor.passableAt exactly: unknown/unloaded is NOT proven clear.
    isPassable: (x, y, z) => isPassable(at(x, y, z)),
  })
  if (current.clear) return []

  const out = new Map<string, HeadroomCut>()
  const consider = (x: number, y: number, z: number, currentFootprint: boolean): void => {
    const block = at(x, y, z)
    if (block === null) {
      if (currentFootprint) {
        out.set(`${x},${y},${z}`, {
          pos: { x, y, z },
          name: 'unknown',
          safe: false,
          reason: 'cell is unloaded/unknown',
          currentFootprint: true,
        })
      }
      return
    }
    if (block.boundingBox === 'empty') return
    const name = block.name
    let safe = true
    let reason = 'safe'
    if (isProtectedStationBlock(name)) {
      safe = false
      reason = `${name} is a protected station`
    } else if (!isBreakableSolidBlock(block)) {
      safe = false
      reason = `${name} is not breakable`
    } else if (PROBE_HAZARDS.has(name) || PROBE_FLUIDS.has(name)) {
      safe = false
      reason = `${name} would flood or burn the pocket`
    }
    const key = `${x},${y},${z}`
    const existing = out.get(key)
    out.set(key, { pos: { x, y, z }, name, safe, reason, currentFootprint: currentFootprint || existing?.currentFootprint === true })
  }
  if (current.blocker !== null) consider(current.blocker.x, current.blocker.y, current.blocker.z, true)
  // Adjacent columns remain in the observation pool so a small body shuffle does
  // not erase local geometry. They are context only: candidate generation exposes
  // the `currentFootprint` blocker, never these neighbours, as headroom acquisition.
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dz = -1; dz <= 1; dz += 1) {
      for (const dy of [1, 2]) consider(feetX + dx, feetY + dy, feetZ + dz, false)
    }
  }
  return [...out.values()]
}

/**
 * The cells a placing body could stand in to use the spot: the 4 cardinal
 * neighbours at the spot's own level plus the 4 diagonal ones. `isStandable`
 * accepts a fluid cell (water has an empty bounding box), which is exactly how a
 * placement can be executed from a submerged body position - so the dry/fluid
 * verdict is computed here instead of being inferred from standability.
 */
function placementAccessCells(spot: Vec3Json): Vec3Json[] {
  const offsets: Array<[number, number]> = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [-1, 1],
    [1, -1],
    [-1, -1],
  ]
  return offsets.map(([dx, dz]) => ({ x: spot.x + dx, y: spot.y, z: spot.z + dz }))
}

/**
 * true when EVERY standable access to the spot is a fluid column, i.e. the body
 * can only place there while standing in water. A spot with no standable access
 * at all is not marked (unknown access keeps the historical behaviour).
 */
function placementAccessSubmerged(bot: Bot, spot: Vec3Json): boolean {
  let sawStandable = false
  for (const access of placementAccessCells(spot)) {
    if (!isStandable(bot, access)) continue
    sawStandable = true
    const head = { x: access.x, y: access.y + 1, z: access.z }
    if (!fluidAt(bot, access) && !fluidAt(bot, head)) return false
  }
  return sawStandable
}

function buildPlacementSpots(bot: Bot, options: SensorOptions, self: SelfState): Vec3Json[] {
  const base = {
    x: Math.floor(self.position.x),
    y: Math.floor(self.position.y),
    z: Math.floor(self.position.z),
  }
  const feet = base
  const scratch = bot.entity.position.clone()
  const spots: Vec3Json[] = []
  const botBody = { x: self.position.x, y: self.position.y, z: self.position.z }
  for (let dx = -2; dx <= 2; dx += 1) {
    for (let dz = -2; dz <= 2; dz += 1) {
      // `dy = -1` is the FLOOR cell of a hole beside the body: the cell a
      // same-level bridge/scaffold places into (`bridgeRoute.ts`). The scan used
      // to start at `dy = 0`, so a hole's floor was never a sensed placement spot
      // and a bridge could not be grounded at all (measured: the Nether fortress
      // edge over the lava basin had no candidate of any kind for the gap).
      // On ordinary terrain this adds NOTHING: there the adjacent column's floor
      // cell is already solid, so `isReplaceableAir(atFeet)` rejects it and the
      // sensed spot set is byte-identical. The body-overlap rule below still
      // excludes the cell directly under the feet (distance exactly 1.0).
      for (let dy = -1; dy <= 1; dy += 1) {
        const candidate = { x: feet.x + dx, y: feet.y + dy, z: feet.z + dz }
        // A placement target must not be inside the bot's own body.
        const nearBody = distance(
          { x: candidate.x + 0.5, y: candidate.y, z: candidate.z + 0.5 },
          botBody,
        )
        if (nearBody < 1.0) continue
        const atFeet = sensorBlockAt(bot, scratch.set(candidate.x, candidate.y, candidate.z), 'placement-spots')
        const above = sensorBlockAt(bot, scratch.set(candidate.x, candidate.y + 1, candidate.z), 'placement-spots')
        const below = sensorBlockAt(bot, scratch.set(candidate.x, candidate.y - 1, candidate.z), 'placement-spots')
        // Truly replaceable air only: `leaf_litter` and similar are passable but
        // the server refuses to overwrite them, so placing there silently fails.
        if (!isReplaceableAir(atFeet)) continue
        if (above === null || above.boundingBox !== 'empty') continue
        // Usable ground only: a leaf canopy is solid enough for the server to
        // accept a placement, but a block on leaves is not a station, scaffold
        // or pillar step. Measured live (run-mubobiq6-12onv): a hungry body
        // pillared itself up a treetop and the operator photographed a
        // cobblestone block sitting on the canopy.
        if (!isUsableGroundSupport(below)) continue
        const pos = vecJson(candidate)
        if (distance(pos, self.eyePosition) > options.reach + 0.5) continue
        spots.push(pos)
      }
    }
  }
  spots.sort((a, b) => distance(a, self.position) - distance(b, self.position))
  return spots.slice(0, options.maxPlacementSpots)
}

/** The subset of `spots` whose only body access is a fluid column. */
function submergedPlacementSpots(bot: Bot, spots: readonly Vec3Json[]): Vec3Json[] {
  return spots.filter((spot) => placementAccessSubmerged(bot, spot))
}

/**
 * The temporary placement-scaffold materials the frame build itself places
 * (`PILLAR_PLACE_PRIORITY`). A frame cell occupied by one of these is a
 * CLEARABLE obstruction: the build clears it and then places the obsidian,
 * instead of the whole site silently disappearing. Any other non-air,
 * non-obsidian block is a hard rejection that must be named with its
 * rule/cell/block (measured live 2026-09-21: leftover cobblestone scaffolds in
 * the left-edge cells made `portal_frame_site:none` silent).
 */
const FRAME_CLEARABLE_BLOCKS: ReadonlySet<string> = new Set(PILLAR_PLACE_PRIORITY)

export type PortalFrameSiteRejectionRule =
  | 'footprint_blocked'
  | 'interior_blocked'
  | 'unsupported_bottom'
  | 'body_overlap'

/** One typed reason the frame scan rejected a candidate origin. */
export interface PortalFrameSiteRejection {
  readonly origin: PortalBlockPosition
  readonly widthAxis: PortalWidthAxis
  readonly rule: PortalFrameSiteRejectionRule
  readonly cell: PortalBlockPosition
  readonly block: string
  /** obsidian edges already present at this origin, for ranking the best candidate */
  readonly existing: number
  /** clearable scaffold edges already present at this origin (same ranking) */
  readonly blocked: number
}

interface FrameScanBlock {
  readonly name: string
  readonly boundingBox: string
}

interface FrameScanWorld {
  readonly at: (x: number, y: number, z: number) => FrameScanBlock | null
  readonly solid: (x: number, y: number, z: number) => boolean
}

/**
 * The ONE frame-site acceptance rule, shared by the live sensor and the typed
 * explainer so a rejection reason can never drift from the acceptance.
 */
function evaluatePortalFrameSite(
  world: FrameScanWorld,
  origin: PortalBlockPosition,
  widthAxis: PortalWidthAxis,
  body: PortalBlockPosition,
): { site: PortalFrameSite } | { rejection: PortalFrameSiteRejection } {
  const layout = portalFrameLayout(origin, widthAxis)
  const existingFrame: Vec3Json[] = []
  const blockedFrame: Vec3Json[] = []
  let hard: { rule: PortalFrameSiteRejectionRule; cell: PortalBlockPosition; block: string } | null = null
  for (const cell of layout.frame) {
    const block = world.at(cell.x, cell.y, cell.z)
    if (block?.name === 'obsidian') {
      existingFrame.push(cell)
      continue
    }
    if (block === null || REPLACEABLE_AIR.has(block.name)) continue
    if (FRAME_CLEARABLE_BLOCKS.has(block.name)) {
      blockedFrame.push(cell)
      continue
    }
    // Record the first hard obstruction but keep scanning so the rejection
    // carries the FULL existing/blocked counts (the ranking that picks the real
    // partial frame needs them, not the prefix before the obstruction).
    if (hard === null) hard = { rule: 'footprint_blocked', cell, block: block.name }
  }
  if (hard !== null) return { rejection: { origin, widthAxis, ...hard, existing: existingFrame.length, blocked: blockedFrame.length } }
  // Corners are optional and may already contain harmless scaffolding; they are
  // never counted toward the ten required edge blocks. The interior, however,
  // must remain clear for a future ignition (or be the lit functional core).
  for (const cell of layout.interior) {
    const name = world.at(cell.x, cell.y, cell.z)?.name ?? null
    if (name === null || (!REPLACEABLE_AIR.has(name) && name !== NETHER_PORTAL)) {
      return {
        rejection: { origin, widthAxis, rule: 'interior_blocked', cell, block: name ?? 'unknown', existing: existingFrame.length, blocked: blockedFrame.length },
      }
    }
  }
  // Bottom support is only required for the bottom EDGE cells the build still
  // has to place. The two bottom corners are optional (a valid minimal frame
  // omits them), so their columns never gate the site: an agent that mined the
  // support row under the corners can still see and continue the four edge
  // cells it actually placed.
  for (const bottom of layout.frame) {
    if (bottom.y !== origin.y) continue
    if (existingFrame.some((cell) => portalCellKey(cell) === portalCellKey(bottom))) continue
    if (!world.solid(bottom.x, bottom.y - 1, bottom.z)) {
      return {
        rejection: {
          origin,
          widthAxis,
          rule: 'unsupported_bottom',
          cell: bottom,
          block: world.at(bottom.x, bottom.y - 1, bottom.z)?.name ?? 'air',
          existing: existingFrame.length,
          blocked: blockedFrame.length,
        },
      }
    }
  }
  const first = { x: origin.x + 0.5, y: origin.y, z: origin.z + 0.5 }
  if (distance(first, body) < 1.0) {
    return {
      rejection: { origin, widthAxis, rule: 'body_overlap', cell: origin, block: 'body', existing: existingFrame.length, blocked: blockedFrame.length },
    }
  }
  const coreIntact = isPortalIgnitionPostconditionMet(
    layout.interior,
    (cell) => world.at(cell.x, cell.y, cell.z)?.name ?? null,
    NETHER_PORTAL,
  )
  const temporarySupportRequired = portalFrameNeedsTemporarySupport(
    origin,
    widthAxis,
    existingFrame,
    (position) => world.solid(position.x, position.y, position.z),
  )
  return {
    site: {
      origin,
      widthAxis,
      safe: true,
      reachable: true,
      temporarySupportRequired,
      coreIntact,
      ...(existingFrame.length === 0 ? {} : { existingFrame }),
      ...(blockedFrame.length === 0 ? {} : { blockedFrame }),
    },
  }
}

/** The bounded origin sweep shared by the live scan and the typed explainer. */
function scanPortalFrameCandidates(
  world: FrameScanWorld,
  scanRadius: number,
  self: SelfState,
  onSite: (site: PortalFrameSite) => void,
  onRejection: (rejection: PortalFrameSiteRejection) => void,
): void {
  const base = {
    x: Math.floor(self.position.x),
    y: Math.floor(self.position.y),
    z: Math.floor(self.position.z),
  }
  const body = self.position
  // The portal may have been started several blocks away from the current
  // spawn/stand position. Keep the search bounded, but wide enough to observe
  // a nearby partial frame before a planner can replace it with a new site.
  const frameRadius = Math.min(16, Math.max(8, Math.floor(scanRadius / 3)))
  const axes: PortalWidthAxis[] = ['x', 'z']
  for (let dx = -frameRadius; dx <= frameRadius; dx += 1) {
    for (let dz = -frameRadius; dz <= frameRadius; dz += 1) {
      for (let dy = -4; dy <= 4; dy += 1) {
        const origin = { x: base.x + dx, y: base.y + dy, z: base.z + dz }
        for (const widthAxis of axes) {
          const outcome = evaluatePortalFrameSite(world, origin, widthAxis, body)
          if ('site' in outcome) onSite(outcome.site)
          else onRejection(outcome.rejection)
        }
      }
    }
  }
}

/** Map the bot onto the pure `FrameScanWorld` view the acceptance rule reads. */
function frameScanWorld(bot: Bot): FrameScanWorld {
  const scratch = bot.entity.position.clone()
  const cache = new Map<string, ReturnType<Bot['blockAt']>>()
  const at = (x: number, y: number, z: number): ReturnType<Bot['blockAt']> => {
    const key = `${x}|${y}|${z}`
    const cached = cache.get(key)
    if (cached !== undefined) return cached
    const block = sensorBlockAt(bot, scratch.set(x, y, z), 'portal-frame-scan')
    cache.set(key, block)
    return block
  }
  return {
    at: (x, y, z) => {
      const block = at(x, y, z)
      return block === null ? null : { name: block.name, boundingBox: block.boundingBox }
    },
    solid: (x, y, z) => at(x, y, z)?.boundingBox === 'block',
  }
}

/**
 * Ground a whole portal footprint, not just its first placement cell.
 *
 * A single supported air cell is insufficient for a frame: the other bottom
 * cells may be occupied, the interior may be blocked, or the selected cell
 * may be inside the bot after the sensor snapshot goes stale.  This scan is
 * still only a mechanical affordance check.  It does not choose a semantic
 * goal or rank Jev actions.
 */
export function buildPortalFrameSites(bot: Bot, _options: SensorOptions, self: SelfState): PortalFrameSite[] {
  const sites: PortalFrameSite[] = []
  scanPortalFrameCandidates(
    frameScanWorld(bot),
    _options.scanRadius,
    self,
    (site) => sites.push(site),
    () => undefined,
  )

  sites.sort((a, b) => {
    const aExisting = a.existingFrame?.length ?? 0
    const bExisting = b.existingFrame?.length ?? 0
    if ((aExisting > 0) !== (bExisting > 0)) return aExisting > 0 ? -1 : 1
    if (aExisting !== bExisting) return bExisting - aExisting
    const da = distance(a.origin, self.position)
    const db = distance(b.origin, self.position)
    if (da !== db) return da - db
    if (a.origin.y !== b.origin.y) return a.origin.y - b.origin.y
    if (a.origin.x !== b.origin.x) return a.origin.x - b.origin.x
    if (a.origin.z !== b.origin.z) return a.origin.z - b.origin.z
    return a.widthAxis.localeCompare(b.widthAxis)
  })
  return sites.slice(0, 24)
}

/** Public late-sensor view used when a planner call outlives the policy snapshot. */
export function sensedPortalFrameSites(bot: Bot, options: SensorOptions = defaultSensorOptions): PortalFrameSite[] {
  // Planner fixtures use a plain `{x,y,z}` entity position rather than a
  // Mineflayer Vec3. That is an unobserved frame, not a reason to make the
  // fixture construct a fake vector API.
  if (typeof (bot.entity?.position as unknown as { offset?: unknown })?.offset !== 'function') return []
  return buildPortalFrameSites(bot, options, buildSelf(bot))
}

/**
 * WHY the frame scan grounded no site, named as origin/axis/rule/cell/block.
 * The acceptance rule is shared with `buildPortalFrameSites`, so this can never
 * drift from what the sensor actually rejected. The best candidate is the one
 * with the most obsidian edges already present, then nearest to the body: that
 * is the real partial frame, not an arbitrary empty footprint.
 */
export function explainNearestPortalFrameRejection(
  bot: Bot,
  options: SensorOptions = defaultSensorOptions,
  self: SelfState = buildSelf(bot),
): PortalFrameSiteRejection | null {
  if (typeof (bot.entity?.position as unknown as { offset?: unknown })?.offset !== 'function') return null
  let best: PortalFrameSiteRejection | null = null
  const isBetter = (candidate: PortalFrameSiteRejection, current: PortalFrameSiteRejection): boolean => {
    if (candidate.existing !== current.existing) return candidate.existing > current.existing
    if (candidate.blocked !== current.blocked) return candidate.blocked > current.blocked
    return distance(candidate.origin, self.position) < distance(current.origin, self.position)
  }
  scanPortalFrameCandidates(
    frameScanWorld(bot),
    options.scanRadius,
    self,
    () => undefined,
    (rejection) => {
      if (best === null || isBetter(rejection, best)) best = rejection
    },
  )
  return best
}

/** Count the required edge blocks in the nearest live partial/full frame. */
export function countSensedPortalFrameBlocks(bot: Bot): number {
  const sites = sensedPortalFrameSites(bot)
  return Math.max(0, ...sites.map((site) => site.existingFrame?.length ?? 0))
}

/**
 * Live server-truth projection for the ladder frontier. It is never persisted:
 * an externally broken portal must become unsatisfied on the next read.
 */
export function detectLivePortalVerification(bot: Bot): boolean {
  const dimension = String(bot.game?.dimension ?? 'minecraft:overworld')
  if (dimension !== 'minecraft:overworld' && dimension !== 'overworld') return false
  const sites = sensedPortalFrameSites(bot)
  return detectPortalVerification(
    dimension,
    sites,
    (position) => sensorBlockAt(bot, new Vec3(position.x, position.y, position.z), 'portal-verification')?.name ?? null,
  )
}

/**
 * #80: the live frame sites whose interior is currently a lit nether portal.
 * This is the same live truth `detectLivePortalVerification` reads, returned per
 * site so the caller can record WHERE the verified portal is. It is never a
 * durable verdict by itself.
 */
export function sensedVerifiedPortalSites(bot: Bot): PortalFrameSite[] {
  const dimension = String(bot.game?.dimension ?? 'minecraft:overworld')
  if (dimension !== 'minecraft:overworld' && dimension !== 'overworld') return []
  return sensedPortalFrameSites(bot).filter((site) =>
    detectPortalVerification(
      dimension,
      [site],
      (position) => sensorBlockAt(bot, new Vec3(position.x, position.y, position.z), 'portal-verification')?.name ?? null,
    ),
  )
}

/**
 * #80: turn durable remembered portal entries into the same `PortalFrameSite`
 * shape the live sensor emits. The record supplies the route/geometry only; the
 * interior is NOT claimed lit here, so every consumer still re-reads live block
 * truth before acting (the frame site is an affordance, never a verdict).
 */
export function rememberedPortalFrameSites(remembered: readonly KnownResource[] | undefined): PortalFrameSite[] {
  const sites: PortalFrameSite[] = []
  for (const resource of remembered ?? []) {
    if (resource.kind !== 'portal') continue
    const frame = (resource.frameCells ?? []).map((cell) => ({ x: cell.x, y: cell.y, z: cell.z }))
    sites.push({
      origin: { x: resource.position.x, y: resource.position.y, z: resource.position.z },
      widthAxis: resource.widthAxis ?? 'x',
      safe: true,
      reachable: true,
      ...(frame.length === 0 ? {} : { existingFrame: frame }),
    })
  }
  return sites
}

/** Deduplicate live and remembered frame sites by origin+axis; live wins. */
function mergePortalFrameSites(live: readonly PortalFrameSite[], remembered: readonly PortalFrameSite[]): PortalFrameSite[] {
  const seen = new Set<string>()
  const merged: PortalFrameSite[] = []
  for (const site of [...live, ...remembered]) {
    const key = `${site.origin.x},${site.origin.y},${site.origin.z}|${site.widthAxis}`
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(site)
  }
  return merged
}

/**
 * The live-structure membership fact for every site that is currently LIVE.
 *
 * GENERAL predicate (structure-agnostic; the portal module only supplies its
 * footprint and its core fact):
 *
 *   live(site) := functionalCoreIntact(site) OR fullRequiredGeometryValid(site)
 *
 * A structure contributes its whole footprint as membership while its functional
 * core is intact, even when shell cells are missing - so removing one edge from
 * a lit portal cannot empty the membership set and let the agent finish
 * dismantling the structure it depends on. A site with no core fact must still
 * validate its full required geometry, which preserves the legitimate
 * "damaged/unlit structure is mineable" behaviour.
 *
 * Exported so any layer that re-derives `portalFrameSites` (for example the
 * controller's in-memory frame memory) can recompute the same fact instead of
 * leaving a stale membership set behind.
 */
/**
 * Membership for a structure the ACTIVE plan is building, derived from the sensed
 * frame sites regardless of whether that structure is lit or complete.
 *
 * Why this exists: a shell item and its construction are the same goal chain (the
 * M2 frame needs ten obsidian and the frame is made of obsidian). With only
 * live-structure membership the sourcing layer kept offering the cells the build
 * had just placed, so the agent mined its own construction and re-placed it -
 * measured live as pacing around a half-built frame while `PLACE` reported
 * `verify_failed`. A structure under construction is not a resource source.
 *
 * This is the same generic fact as every other membership: a plain cell set the
 * sourcing layer refuses. The portal module contributes only its footprint, and a
 * site that is neither lit nor complete contributes nothing once the build goal is
 * gone, so legitimate deconstruction still works.
 */
export function underConstructionMembers(
  sites: readonly PortalFrameSite[],
  goal: { kind?: string; targetItem?: string | null } | null | undefined,
): LiveStructureMember[] {
  if (goal == null || goal.kind !== 'place' || goal.targetItem !== OBSIDIAN) return []
  const out: LiveStructureMember[] = []
  for (const site of sites) {
    out.push(...portalFrameCoreLiveStructureMembers(site.origin, site.widthAxis))
  }
  return out
}

/** Union membership facts, deduped by cell key so a cell is never counted twice. */
function mergeLiveStructureMembers(
  ...groups: readonly (readonly LiveStructureMember[])[]
): LiveStructureMember[] {
  const seen = new Set<string>()
  const out: LiveStructureMember[] = []
  for (const group of groups) {
    for (const member of group) {
      const key = liveStructureCellKey(member.position)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(member)
    }
  }
  return out
}

export function liveStructureMembersForSites(sites: readonly PortalFrameSite[]): LiveStructureMember[] {
  const members: LiveStructureMember[] = []
  const seen = new Set<string>()
  for (const site of sites) {
    let contribution: LiveStructureMember[]
    if (site.coreIntact === true) {
      contribution = portalFrameCoreLiveStructureMembers(site.origin, site.widthAxis)
    } else {
      const blocks = site.existingFrame ?? []
      // Fewer than the ten required edges cannot validate; skip without calling
      // the validator so a partial frame without a functional core never
      // contributes membership.
      if (blocks.length < 10) continue
      const validation = validatePortalFrame({ blocks, widthAxis: site.widthAxis })
      if (validation.shape !== 'ok') continue
      contribution = portalFrameLiveStructureMembers(validation)
    }
    for (const member of contribution) {
      const key = liveStructureCellKey(member.position)
      if (seen.has(key)) continue
      seen.add(key)
      members.push(member)
    }
  }
  return members
}

/**
 * The local terrain scan, plus the DIMENSION-TRANSFER cells it walked over.
 *
 * The transfer set is the same block truth the executor's walk-in mechanic
 * reads (`isDimensionTransferBlock`): standing with the feet or the head in a lit
 * portal block transfers the body. A cell is recorded when EITHER its feet or
 * its head block is transfer material, so the recorded cell is exactly "feet
 * here transfers". The candidate gate refuses to realize a mechanical locomotion
 * leg into one, and the keep-distance solver refuses to offer one; the explicit
 * `ENTER_PORTAL` candidate is the only route that may cross.
 */
function buildTerrain(
  bot: Bot,
  options: SensorOptions,
  self: SelfState,
): { standable: Vec3Json[]; portalWalkInCells: Vec3Json[] } {
  const found: Vec3Json[] = []
  const transfer: Vec3Json[] = []
  const base = { x: Math.floor(self.position.x), y: Math.floor(self.position.y), z: Math.floor(self.position.z) }
  const scratch = bot.entity.position.clone()
  const at = (p: Vec3Json) => sensorBlockAt(bot, scratch.set(p.x, p.y, p.z), 'terrain')
  for (let dx = -2; dx <= 2; dx += 1) {
    for (let dz = -2; dz <= 2; dz += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        const feet: Vec3Json = { x: base.x + dx, y: base.y + dy, z: base.z + dz }
        // The same three blocks `isUsableStand` reads, read once: the standable
        // verdict below must stay byte-identical to it.
        const feetBlock = at(feet)
        const headBlock = at({ x: feet.x, y: feet.y + 1, z: feet.z })
        const supportBlock = at({ x: feet.x, y: feet.y - 1, z: feet.z })
        if (isDimensionTransferBlock(feetBlock?.name) || isDimensionTransferBlock(headBlock?.name)) {
          transfer.push(feet)
        }
        // A canopy top is collidable but is not a destination: terrain cells are
        // the standable set every MOVE/explore/retreat/placement solve picks
        // from, so a leaf-supported cell here became "walk onto the treetop".
        if (!isUsableStandFromBlocks(feetBlock, headBlock, supportBlock)) continue
        found.push(feet)
      }
    }
  }
  found.sort((a, b) => distance(a, self.position) - distance(b, self.position))
  return { standable: found.slice(0, options.maxTerrain), portalWalkInCells: transfer }
}

/**
 * ONE cardinal direction's bounded forward probe: the live block truth a
 * BRIDGE/scaffold grounding needs (`bridgeRoute.planBridgeSpan`).
 *
 * The flat terrain scan (`buildTerrain`, 5x5x3) and the cardinal step sample
 * (`buildDescent`, one cell per direction) between them cannot answer the two
 * questions a bridge must answer - "is the FAR side still standable?" and "is
 * every cell between here and there bridgeable?" - so the gap was named by the
 * sensor (`DescentOption.refusal === 'no_support'`) with nothing able to act on
 * the name. This reads at most `BRIDGE_PROBE_DEPTH` columns ahead per direction
 * and classifies each with the SAME predicates the rest of the sensor uses
 * (`isPassable` / `isSolidSupport` / `isUsableGroundSupport` / `isUsableStand`),
 * so a probed cell cannot disagree with `terrain.standable` about standability.
 *
 * Exported because the executor re-probes the SAME direction live immediately
 * before each placement: the offered span and the executed span then come from
 * one implementation instead of two.
 */
export function probeBridgeDirection(
  bot: Bot,
  feet: Vec3Json,
  dir: BridgeDir,
  depth: number = BRIDGE_PROBE_DEPTH,
): BridgeProbe {
  const scratch = bot.entity.position.clone()
  const at = (x: number, y: number, z: number) => sensorBlockAt(bot, scratch.set(x, y, z), 'bridge-probe')
  // The block slice `wallEntry.ts#floodEvidence` reads, from the same live blocks
  // (`null` = unloaded, which the flood rule never turns into a hazard).
  const readCell = (cell: Vec3Json): WallBlockLike | null => {
    const block = at(cell.x, cell.y, cell.z)
    return block === null
      ? null
      : { name: block.name, boundingBox: block.boundingBox, diggable: block.diggable === true }
  }
  const { dx, dz } = bridgeDirOffset(dir)
  const cells: BridgeProbeCell[] = []
  for (let step = 1; step <= Math.max(1, Math.floor(depth)); step += 1) {
    const cell = { x: feet.x + dx * step, y: feet.y, z: feet.z + dz * step }
    const floor = { x: cell.x, y: cell.y - 1, z: cell.z }
    const feetBlock = at(cell.x, cell.y, cell.z)
    const headBlock = at(cell.x, cell.y + 1, cell.z)
    const floorBlock = at(cell.x, floor.y, cell.z)
    // An unloaded cell (`null`) is never a hazard - the same rule the
    // environmental hazard scan uses - so a chunk that has not arrived can only
    // make a bridge REFUSE (open/placeable are false), never look safe.
    const belowFloorBlock = at(cell.x, floor.y - 1, cell.z)
    const hazard = [feetBlock, headBlock, floorBlock, belowFloorBlock].some(
      (block) => block !== null && isBridgeUnsafeBlockName(block.name),
    )
    // THE SELF-LANDING SCAFFOLD's own world truth: the 1x2 pocket this column
    // would make the body occupy, judged for face-adjacent fluids by the SAME
    // reader the wall entry uses (`wallEntry.ts#floodEvidence`, imported once).
    // A body that lays the floor of the cell it steps into has no pre-existing
    // floor to check, so the flood verdict IS its safety fact - and it is read
    // only for the FIRST cell (a self-landing span is one cell by construction),
    // so the probe stays bounded: one extra six-neighbourhood while the body
    // already holds a placeable block and a step is refused.
    const flood = step === 1 ? floodEvidence([cell, { x: cell.x, y: cell.y + 1, z: cell.z }], readCell) : null
    cells.push({
      cell,
      floor,
      open: isPassable(feetBlock),
      headOpen: isPassable(headBlock),
      placeable: isReplaceableAir(floorBlock),
      supported: isSolidSupport(floorBlock),
      standable: isUsableStandFromBlocks(feetBlock, headBlock, floorBlock),
      hazard,
      cellName: feetBlock?.name ?? null,
      floorName: floorBlock?.name ?? null,
      headName: headBlock?.name ?? null,
      ...(step === 1
        ? {
            flood: flood !== null,
            floodCell: flood?.cell ?? null,
            floodBlock: flood?.block ?? null,
          }
        : {}),
    })
  }
  return {
    dir,
    dx,
    dz,
    cells,
    // The body's own footing: the face a bridge placement is made against
    // (`placeBlock(footing, face=<dir>)`), exactly the human scaffold gesture.
    footing: isUsableGroundSupport(at(feet.x, feet.y - 1, feet.z)),
  }
}

/**
 * The four cardinal probes one sensor tick seeds for the bridge grounding.
 *
 * Bounded and constant: 4 directions x `BRIDGE_PROBE_DEPTH` columns of direct
 * chunk lookups (no block scan, no pathfinder probe), skipped entirely while the
 * body holds nothing it could place - a body that cannot bridge cannot lose a
 * refusal by not being sensed, because `bridgeRoute.planBridgeRoute` answers
 * `no_block` from the inventory fact BEFORE it reads any probe.
 */
function buildBridgeProbes(bot: Bot, self: SelfState): BridgeProbe[] {
  const feet = {
    x: Math.floor(self.position.x),
    y: Math.floor(self.position.y),
    z: Math.floor(self.position.z),
  }
  // Cardinally adjacent only: a bridge is a same-level 4-neighbour step, and the
  // probe is bounded so a sensor tick cannot grow with the terrain.
  return BRIDGE_DIRS.map((dir) => probeBridgeDirection(bot, feet, dir))
}

/**
 * The cardinal WALL ENTRY probes: what the body could mine open beside itself, and
 * whether the pocket it would open could be flooded.
 *
 * WHY THIS IS A SEPARATE FACT FROM `descent` (measured, live, the operator's flooded
 * Nether arrival): `buildDescent`'s `safe` verdict is a 3x3x3 PROXIMITY rule, so a
 * body standing beside a lava band has every step refused `hazard` even where the
 * cell to be mined is dry solid rock whose new pocket no fluid can reach. The step
 * vocabulary cannot express "this dig is safe because of WHICH cell is mined and what
 * touches it"; this probe does, per cell, from the same live blocks:
 *
 *   * each probe carries the sensor's OWN `DescentOption` for that direction and mode
 *     (`level` and `down`), so the profile, the primary cell, the dig plan, the route
 *     identity and the executor are all reused, never recomputed;
 *   * `pocket` is the 1x2 profile the body will occupy: `[landing, landing + 1]` -
 *     for `level` those are the sensor's `wall`/`head`, for `down` its `floor`/`wall`;
 *   * `floor` is `landing.y - 1` and is NEVER mined: the tunnel's floor is pre-existing
 *     rock, which is why this step is safe where a walk step over lava is not;
 *   * `flood` is `wallEntry.ts#floodEvidence`: a fluid FACE-ADJACENT to a pocket cell
 *     would pour in, and a fluid two cells away (with the solid cell between them
 *     still solid) cannot.
 *
 * Reads are direct chunk lookups and bounded (4 directions x 2 modes x [2 profile
 * cells + 1 floor + the pocket's six-neighbourhood]), and the caller only builds the
 * probe while a walk step is actually refused, so ordinary terrain reads nothing extra.
 *
 * Exported for the same reason `probeBridgeDirection` is: the facts it classifies are
 * the input of a load-bearing safety rule (`wallEntry.ts#groundWallEntries`), so a
 * fixture must be able to drive the REAL classification from a modelled world instead
 * of re-implementing it.
 */
export function buildWallProbes(
  bot: Bot,
  self: SelfState,
  descent: readonly DescentOption[],
): WallProbe[] {
  const scratch = bot.entity.position.clone()
  const read = (cell: Vec3Json): WallBlockLike | null => {
    const block = sensorBlockAt(bot, scratch.set(cell.x, cell.y, cell.z), 'wall-probes')
    return block === null
      ? null
      : { name: block.name, boundingBox: block.boundingBox, diggable: block.diggable === true }
  }
  const classify = (cell: Vec3Json): WallCell => {
    const block = read(cell)
    const open = block !== null && block.boundingBox === 'empty'
    const solid = block !== null && block.boundingBox !== 'empty'
    return {
      cell,
      name: block?.name ?? null,
      open,
      solid,
      breakable: solid && block?.diggable === true && !isTunnelFloodBlockName(block.name),
      observed: block !== null,
    }
  }
  const probes: WallProbe[] = []
  for (const dir of WALL_DIRS) {
    for (const mode of ['level', 'down'] as const) {
      const step = descent.find((option) => option.dir === dir && option.mode === mode)
      if (step === undefined) continue
      const landing = step.step
      const head = { x: landing.x, y: landing.y + 1, z: landing.z }
      const floor = { x: landing.x, y: landing.y - 1, z: landing.z }
      // The pocket the dig makes open: the body's own 1x2 profile at the landing, and
      // a fluid face-adjacent to either cell can pour into it.
      const flood = floodEvidence([landing, head], read)
      probes.push({
        dir,
        mode,
        dx: step.dx,
        dz: step.dz,
        landing,
        pocket: [classify(landing), classify(head)],
        floor: classify(floor),
        flood: flood !== null,
        floodCell: flood?.cell ?? null,
        floodBlock: flood?.block ?? null,
        step,
      })
    }
  }
  return probes
}

/**
 * Should this tick sense the wall-entry probes at all?
 *
 * ONLY when a sensed step is refused by `hazard` or `no_support` - the two refusals
 * whose cause is the body's own local geology rather than its tools, its goal or a
 * protected block. That is the exact precondition `wallEntry.ts` answers, and it keeps
 * the sensor (and therefore the offer) byte-identical on ordinary terrain: there every
 * cardinal step is either `safe` or refused for a reason no dig could change.
 */
function shouldProbeWallEntry(descent: readonly DescentOption[]): boolean {
  return descent.some((option) => option.refusal === 'hazard' || option.refusal === 'no_support')
}

/**
 * The BOUNDED LEVEL SCAN probes (`levelScan.ts`): the controlled own-column descent into
 * each of the next `LEVEL_SCAN_MAX_LEVELS` levels below the body, plus the four same-level
 * lateral continuations AT each of them.
 *
 * WHY IT IS A SEPARATE FACT: the measured Nether arrival (run-muchajde-1qhat, the operator's
 * flooded-island case) has every step at the body's OWN level refused or useless (the portal
 * plane is `portal_plane`, the frame is `protected`, the rest is already open air), while the
 * rock BELOW is solid and a dry tunnel east exists two levels down. `buildDescent` only ever
 * computes the body's own level, so nothing in the offer can name that level; this probe
 * reads exactly the cells the composed route needs and hands them to the ONE rule
 * (`levelScan.ts#groundLevelScan`), which judges each pocket with the SAME per-cell function
 * the adjacent wall entry uses (`wallEntry.ts#wallPocketRefusal`).
 *
 * BOUNDED BY CONSTRUCTION: `LEVEL_SCAN_MAX_LEVELS` levels x (1 own-column shaft + 4 cardinal
 * laterals) = `LEVEL_SCAN_MAX_PROBES` probes, each a 1x2 profile + its floor + the pocket's
 * six-neighbourhood (direct chunk lookups only, no block scan, no pathfinder probe), i.e.
 * <= ~225 cell reads while the gate is open. `maxLevels` is clamped to the declared constant
 * so a caller cannot widen the window.
 *
 * The depth-1 shaft carries the SENSOR's own verdict for the body's own-column step
 * (`state.descent`'s `D/down`), because that is the step the offer will execute and the guard
 * will re-read: a verdict the per-cell rule cannot supersede (an open floor, no support)
 * breaks the chain, so what is offered and what the guard accepts cannot disagree.
 *
 * Exported for the same reason `buildWallProbes` is: a fixture must be able to drive the REAL
 * classification from a modelled world instead of re-implementing it.
 */
export function buildLevelScanProbes(
  bot: Bot,
  self: SelfState,
  descent: readonly DescentOption[],
  maxLevels: number = LEVEL_SCAN_MAX_LEVELS,
): LevelScanProbe[] {
  const feet = {
    x: Math.floor(self.position.x),
    y: Math.floor(self.position.y),
    z: Math.floor(self.position.z),
  }
  const scratch = bot.entity.position.clone()
  const read = (cell: Vec3Json): WallBlockLike | null => {
    const block = sensorBlockAt(bot, scratch.set(cell.x, cell.y, cell.z), 'level-scan')
    return block === null
      ? null
      : { name: block.name, boundingBox: block.boundingBox, diggable: block.diggable === true }
  }
  const classify = (cell: Vec3Json): WallCell => {
    const block = read(cell)
    const open = block !== null && block.boundingBox === 'empty'
    const solid = block !== null && block.boundingBox !== 'empty'
    return {
      cell,
      name: block?.name ?? null,
      open,
      solid,
      breakable: solid && block?.diggable === true && !isTunnelFloodBlockName(block.name),
      observed: block !== null,
    }
  }
  const ownColumn = descent.find((option) => option.dir === 'D' && option.mode === 'down')
  const window = Math.max(0, Math.min(LEVEL_SCAN_MAX_LEVELS, Math.floor(maxLevels)))
  const probes: LevelScanProbe[] = []
  for (let depth = 1; depth <= window; depth += 1) {
    const y = feet.y - depth
    // The own-column shaft: the body digs the floor cell (x,y,z) and stands in it, so its
    // 1x2 profile is that cell plus the cell above, and the pre-existing floor is (x,y-1,z).
    const shaftLanding = { x: feet.x, y, z: feet.z }
    const shaftHead = { x: feet.x, y: y + 1, z: feet.z }
    const shaftFloor = { x: feet.x, y: y - 1, z: feet.z }
    const shaftFlood = floodEvidence([shaftLanding, shaftHead], read)
    const laterals: LevelLateralFacts[] = []
    for (const dir of WALL_DIRS) {
      const dx = dir === 'E' ? 1 : dir === 'W' ? -1 : 0
      const dz = dir === 'S' ? 1 : dir === 'N' ? -1 : 0
      const cell = { x: feet.x + dx, y, z: feet.z + dz }
      const head = { x: cell.x, y: y + 1, z: cell.z }
      const floor = { x: cell.x, y: y - 1, z: cell.z }
      const feetCell = classify(cell)
      const headCell = classify(head)
      const floorCell = classify(floor)
      // A WALK continuation is an already-open, already-supported, dry 1x2 passage that does
      // not transfer the body: nothing is mined, so there is no new pocket to flood and the
      // ordinary MOVE/landing guards own the step. Everything else is judged as a DIG by the
      // shared per-cell rule.
      const transfers =
        (feetCell.observed && isDimensionTransferBlock(feetCell.name)) ||
        (headCell.observed && isDimensionTransferBlock(headCell.name))
      const walk =
        feetCell.open &&
        headCell.open &&
        floorCell.observed &&
        floorCell.solid &&
        !isTunnelFloodBlockName(floorCell.name) &&
        !transfers
      const flood = walk ? null : floodEvidence([cell, head], read)
      laterals.push({
        dir,
        dx,
        dz,
        cell,
        landing: cell,
        pocket: [feetCell, headCell],
        floor: floorCell,
        flood: flood !== null,
        floodCell: flood?.cell ?? null,
        floodBlock: flood?.block ?? null,
        walk,
      })
    }
    probes.push({
      y,
      depth,
      shaft: {
        landing: shaftLanding,
        pocket: [classify(shaftLanding), classify(shaftHead)],
        floor: classify(shaftFloor),
        flood: shaftFlood !== null,
        floodCell: shaftFlood?.cell ?? null,
        floodBlock: shaftFlood?.block ?? null,
        // Only the body's own level has a sensor verdict: it is the step the guard re-reads.
        ...(depth === 1 ? { sensorRefusal: ownColumn?.refusal ?? null } : {}),
      },
      laterals,
    })
  }
  return probes
}

/**
 * SAFE: keep-distance destinations for an active threat.
 *
 * The measured retreat failure is a SENSING failure as much as a policy one:
 * `buildTerrain` samples a 5x5x3 window, so `pickRetreats` could only ever
 * choose a cell ~2 m away - while the zombie that killed the body was inside
 * 0.8 m. `RETREAT:p4_69_-9` was "0.71m away" and executed as `moved=0m`.
 *
 * The nearest active hostile supplies the primary direction: either one inside
 * the bounded danger radius or a ranged/other hostile the code has evidence is
 * engaged. Every sampled destination also preserves safe separation from the
 * other active threats, so an escape from a zombie cannot run into a skeleton.
 * The scan uses the SAME DESTINATION predicate as `buildTerrain` (`isUsableStand`:
 * standable, and its support is load-bearing ground rather than a leaf canopy -
 * a treetop is locomotion truth, not a retreat destination), and keeps only
 * cells that genuinely gain separation from that response-worthy hostile. The
 * result is a CAN fact; Jev still chooses whether to take one.
 *
 * It also owns the two facts a keep-distance destination cannot be grounded
 * without:
 *   * `coverCells` - cells the threat's own sight line cannot reach (real block
 *     truth from one bounded ray per candidate). This is what answers a RANGED
 *     attacker: the body cannot outrun an arrow, but it can step out of the
 *     firing line. A cell the ray cannot be computed for is simply absent;
 *     unknown never counts as cover.
 *   * `portalWalkInCells` - cells where standing realizes a DIMENSION TRANSFER.
 *     They are sampled here as well as in `buildTerrain` because this wider scan
 *     is where a "retreat" destination comes from, and a keep-distance leg must
 *     never be realized as a dimension change.
 */
function buildEscapeCells(
  bot: Bot,
  options: SensorOptions,
  self: SelfState,
  entities: readonly EntityState[],
  lastDamage?: LastDamageEvidence | null,
  nowMs = Date.now(),
): { cells: Vec3Json[]; coverCells: Vec3Json[]; portalWalkInCells: Vec3Json[] } {
  // Use the same generic response predicate as candidate generation. Restricting
  // this scan to the melee/danger radius left a ranged attacker at (for example)
  // 9.5 m with an ATTACK candidate but no RETREAT destination: the body has to
  // walk into the firing lane before it can choose an escape. Unengaged distant
  // hostiles remain passive because `activeThreats` requires the danger radius,
  // actual aggression, or recent damage with sight evidence.
  const sensedThreats = activeThreats(entities as readonly ThreatEntityLike[], lastDamage ?? null, nowMs)
  const sensed = sensedThreats[0] ?? null
  const additionalThreats = sensedThreats.slice(1).map((entity) => ({
    position: entity.position,
    standoff: threatStandoffRange(entity.name),
  }))
  // The UNSEEN attacker: the damage attribution names a position the sensor
  // never witnessed. Same scan, same block truth, same solver - the only change
  // is where "away from" and "out of sight of" are measured from. When the
  // attribution carries no position this stays null and the scan does not run:
  // an origin is never invented to make a destination look grounded.
  const attributed = sensed === null ? attributedThreatAnchor(entities, lastDamage ?? null, self.position, nowMs) : null
  const threat = sensed ?? attributed
  if (threat === null) return { cells: [], coverCells: [], portalWalkInCells: [] }
  const radius = Math.max(0, Math.floor(options.escapeRadius))
  if (radius === 0) return { cells: [], coverCells: [], portalWalkInCells: [] }
  const standoff = threatStandoffRange(threat.name)
  // A distant origin cannot be outrun: the local scan can only offer a lateral
  // step, so the qualification threshold drops for it (cover remains the
  // load-bearing fact). A SENSED threat keeps the measured threshold exactly.
  const minGain = attributed === null ? MIN_KEEP_DISTANCE_GAIN : UNSENSED_MIN_KEEP_DISTANCE_GAIN
  const current = distance(threat.position, self.position)
  const base = { x: Math.floor(self.position.x), y: Math.floor(self.position.y), z: Math.floor(self.position.z) }
  const found: Vec3Json[] = []
  const cover: Vec3Json[] = []
  const transfer: Vec3Json[] = []
  const usable: Vec3Json[] = []
  let coverRays = 0
  const maxCoverRays = Math.max(0, Math.floor(options.maxThreatCoverRays ?? 0))
  const scratch = bot.entity.position.clone()
  const at = (p: Vec3Json) => sensorBlockAt(bot, scratch.set(p.x, p.y, p.z), 'escape-cells')
  for (let dx = -radius; dx <= radius; dx += 1) {
    for (let dz = -radius; dz <= radius; dz += 1) {
      for (let dy = -THREAT_ESCAPE_DY; dy <= THREAT_ESCAPE_DY; dy += 1) {
        const feet: Vec3Json = { x: base.x + dx, y: base.y + dy, z: base.z + dz }
        const separation = distance(feet, threat.position)
        const gain = separation - current
        const feetBlock = at(feet)
        const headBlock = at({ x: feet.x, y: feet.y + 1, z: feet.z })
        if (isDimensionTransferBlock(feetBlock?.name) || isDimensionTransferBlock(headBlock?.name)) {
          transfer.push(feet)
          // A transfer cell is never a keep-distance destination, so it cannot
          // become a covered one either: do not spend a ray proving cover for a
          // cell the solver will refuse.
          continue
        }
        // Destination rule, shared with `buildTerrain`: a canopy top is not a
        // place the body may be sent to keep distance from a mob.
        if (!isUsableStandFromBlocks(feetBlock, headBlock, at({ x: feet.x, y: feet.y - 1, z: feet.z }))) continue
        if (!retreatPreservesThreatSeparation(self.position, feet, additionalThreats)) continue
        usable.push(feet)
        // Same qualification rule as `selectKeepDistanceSpots`: a real gain, or
        // standing outside the threat's reach without moving closer.
        if (gain >= minGain || (separation >= standoff && gain > 0)) found.push(feet)
      }
    }
  }
  // Cover is the third way to genuinely keep distance from a RANGED attacker: a
  // cell its sight line cannot reach. Unlike separation this does NOT require
  // moving away, so it is probed for every usable destination - an unseen
  // attacker's origin is far enough that no local cell gains meaningful radial
  // separation, and a lateral step out of the firing line is the only answer the
  // local scan can offer.
  //
  // The ray budget is BOUNDED, so it must be spent where cover can exist AND
  // where the body could actually step. Cover requires moving perpendicular to
  // the attacker->body axis, so cells on that axis are skipped entirely; the
  // rest are probed nearest-to-the-body first, because a cover cell 6 m away is
  // not a step the body can take before the next hit. Spending the budget in
  // loop order instead wasted all rays on one corner of the scan and found no
  // cover at all.
  if (maxCoverRays > 0) {
    const axis = normalize({ x: threat.position.x - self.position.x, y: 0, z: threat.position.z - self.position.z })
    // Perpendicular offset from the attacker->body axis (the axis through the
    // BODY, so "on the axis" means "still in the firing line").
    const lateral = (cell: Vec3Json): number =>
      axis === null
        ? Math.hypot(cell.x - self.position.x, cell.z - self.position.z)
        : Math.abs((cell.x - self.position.x) * axis.z - (cell.z - self.position.z) * axis.x)
    const ordered = [...usable].sort((a, b) => {
      const byCost =
        rayPriority(distance(a, self.position), lateral(a)) - rayPriority(distance(b, self.position), lateral(b))
      if (byCost !== 0) return byCost
      return a.x - b.x || a.y - b.y || a.z - b.z
    })
    for (const feet of ordered) {
      if (coverRays >= maxCoverRays) break
      coverRays += 1
      // Only ever credited on positive block truth: `threatSightLineBlocked`
      // returns false when it cannot ray, so an unprovable cell is never cover.
      if (threatSightLineBlocked(bot, threat.position, feet)) cover.push(feet)
    }
  }
  found.sort((a, b) => distance(b, threat.position) - distance(a, threat.position))
  const cap = Math.max(0, Math.floor(options.maxEscapeCells ?? THREAT_ESCAPE_MAX_CELLS))
  return { cells: found.slice(0, cap), coverCells: cover, portalWalkInCells: transfer }
}

/** Unit vector of a horizontal offset, or null when it is degenerate. */
function normalize(offset: Vec3Json): { x: number; z: number } | null {
  const length = Math.hypot(offset.x, offset.z)
  if (!Number.isFinite(length) || length === 0) return null
  return { x: offset.x / length, z: offset.z / length }
}

/**
 * The lateral offset below which a cell is not worth a cover ray: it is still
 * (nearly) on the attacker->body axis, so it cannot leave the firing line.
 */
const COVER_LATERAL_FLOOR = 0.75

/**
 * Lower is probed first. A cell with no usable lateral offset is never cover, so
 * it sorts last; everything else is ordered by how close it is to the body - the
 * step the body can actually take before the next hit.
 */
function rayPriority(approach: number, lateral: number): number {
  if (lateral <= COVER_LATERAL_FLOOR) return Number.POSITIVE_INFINITY
  return approach
}

/**
 * SAFE: the damage attribution as a threat anchor, for an attacker the sensor
 * never witnessed.
 *
 * This only reports what the server already said (`damage_event.sourcePosition`,
 * captured by the scheduler) and only while the hit is inside
 * `THREAT_MEMORY_MS`. It never reads a mob's attack range, the body's facing or
 * any inferred direction. A missing/absurd position or an origin beyond
 * `UNSENSED_THREAT_ANCHOR_RANGE` yields null, which the caller reads as "no
 * anchor", never as "no threat".
 */
function attributedThreatAnchor(
  entities: readonly EntityState[],
  lastDamage: LastDamageEvidence | null,
  selfPosition: Vec3Json,
  nowMs = Date.now(),
): { name: string; position: Vec3Json } | null {
  const attacker = unsensedAttackerFacts({
    entities: entities as readonly ThreatEntityLike[],
    signals: { lastDamage },
    timestampMs: nowMs,
  })
  if (attacker === null || attacker.position === null) return null
  if (attacker.ageMs !== null && attacker.ageMs > THREAT_MEMORY_MS) return null
  return distance(attacker.position, selfPosition) <= UNSENSED_THREAT_ANCHOR_RANGE
    ? { name: attacker.name, position: attacker.position }
    : null
}

/**
 * SAFE/CAN: is the hostile at `from` (its feet) BLOCKED from seeing a body
 * standing at `cell`? True means the cell is genuine cover.
 *
 * The threat's eye is its feet plus the same eye height the body's own
 * `SelfState.eyePosition` uses, and the target is the body's chest. One ray, no
 * guessing: `bot.world.raycast` is the synchronous world raycast mineflayer's
 * own `canSeeBlock` uses, and it reports the first SOLID block on the segment
 * (non-solid blocks such as the portal itself do not stop it).
 *
 * False unless there is positive evidence: a bot without a world raycast, a
 * degenerate segment, or a throwing raycast all yield false, so "unknown" is
 * never handed to the solver as a covered destination.
 */
function threatSightLineBlocked(bot: Bot, from: Vec3Json, cell: Vec3Json): boolean {
  const world = bot.world as unknown as
    | { raycast?: (origin: unknown, direction: unknown, range: number, matcher: null) => unknown }
    | undefined
  if (world === undefined || typeof world.raycast !== 'function') return false
  try {
    const eye = bot.entity.position.clone().set(from.x, from.y + EYE_HEIGHT, from.z)
    const target = bot.entity.position.clone().set(cell.x + 0.5, cell.y + 1, cell.z + 0.5)
    const dx = target.x - eye.x
    const dy = target.y - eye.y
    const dz = target.z - eye.z
    const range = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (!Number.isFinite(range) || range <= 0) return false
    const direction = bot.entity.position.clone().set(dx / range, dy / range, dz / range)
    const hit = world.raycast(eye, direction, range, null)
    return hit !== null && hit !== undefined
  } catch {
    return false
  }
}

/** Positional dedupe for the cell facts, preserving first-seen order. */
function dedupeCells(cells: readonly Vec3Json[]): Vec3Json[] {
  const seen = new Set<string>()
  const out: Vec3Json[] = []
  for (const cell of cells) {
    const key = `${cell.x},${cell.y},${cell.z}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(cell)
  }
  return out
}

/**
 * The SENSOR entry point.
 *
 * Reads the bot once per policy tick and returns the JSON world state. Every
 * block lookup is defensive: unloaded chunks yield `null` and are simply
 * omitted rather than crashing the loop.
 */
export function buildWorldState(bot: Bot, input: SensorInput, options: SensorOptions = defaultSensorOptions): WorldState {
  const revision = options.worldRevision
  activeScanRevision = typeof revision === 'number' && Number.isFinite(revision) ? revision : null
  // The read-provenance gate is armed for the whole build. Refresh the live
  // dimension first: if the body changed dimension since the last build, this drops
  // every column tag and unloads the columns, so nothing loaded under the previous
  // dimension can be read by this build.
  const provenance = options.dimensionProvenance ?? null
  provenance?.syncLiveDimension?.('sensor-build')
  // Save/restore rather than clear, so a nested or already-armed gate is never
  // disarmed by an inner build's exit.
  const previousProvenance = activeDimensionProvenance
  activeDimensionProvenance = provenance
  try {
    return buildWorldStateUncached(bot, input, options)
  } finally {
    activeScanRevision = null
    activeDimensionProvenance = previousProvenance
  }
}

function buildWorldStateUncached(bot: Bot, input: SensorInput, options: SensorOptions): WorldState {
  const timestampMs = Date.now()
  const { self, envHazardCells } = buildSelfDetail(bot)
  const submersionEscapeTargets = buildSubmersionEscapeTargets(bot, self)
  const inventory = buildInventory(bot)
  const rememberedStations = input.rememberedStations ?? input.signals.knownResources ?? []
  // #14-world-proof: falsify remembered resource cells the loaded world
  // contradicts before any candidate family can see them.
  const knownResourceEvidence = probeKnownResources(
    bot,
    input.focusItem ?? null,
    input.signals.knownResources ?? [],
    {
      ...(input.retrievalItems === undefined ? {} : { items: input.retrievalItems }),
      entityRadius: options.entityRadius,
      hostileRadius: options.hostileRadius,
    },
  )
  const falsifiedKnownCells = new Set(
    knownResourceEvidence
      .filter((evidence) => evidence.status === 'falsified')
      .map((evidence) => `${evidence.position.x},${evidence.position.y},${evidence.position.z}`),
  )
  const liveKnownResources =
    falsifiedKnownCells.size === 0
      ? input.signals.knownResources
      : (input.signals.knownResources ?? []).filter(
          (resource) =>
            !falsifiedKnownCells.has(`${resource.position.x},${resource.position.y},${resource.position.z}`),
        )
  const signals =
    falsifiedKnownCells.size === 0 ? input.signals : { ...input.signals, knownResources: liveKnownResources }
  const portalFrameSites = mergePortalFrameSites(
    buildPortalFrameSites(bot, options, self),
    rememberedPortalFrameSites(rememberedStations),
  )
  const portalFrame =
    portalFrameSites
      .map((site) => {
        const blocks = site.existingFrame ?? []
        return blocks.length >= 10 ? validatePortalFrame({ blocks, widthAxis: site.widthAxis }) : null
      })
      .find((validation): validation is PortalFrameValidation => validation?.shape === 'ok') ?? null
  const placementSpots = buildPlacementSpots(bot, options, self)
  const entities = buildEntities(bot, options, self.position, input.signals.lastDamage)
  const terrain = buildTerrain(bot, options, self)
  const escape = buildEscapeCells(bot, options, self, entities, input.signals.lastDamage ?? null, timestampMs)
  // Both transfer-cell sources are unioned: the local terrain window is where an
  // ordinary MOVE destination can come from, the wider escape scan is where a
  // keep-distance destination comes from, and the gate must see both.
  const portalWalkInCells = dedupeCells([...terrain.portalWalkInCells, ...escape.portalWalkInCells])
  // The descent vocabulary is sensed ONCE and read by both the dig route and the
  // wall-entry probes (`buildWallProbes` carries the very steps it produces, so the
  // offered entry and the sensor's own step cannot disagree).
  const descent = buildDescent(bot, options, self)
  return {
    schemaVersion: 1,
    tick: input.tick,
    timestampMs,
    self,
    inventory,
    entities,
    blocks: buildBlocks(bot, options, self, input.focusItem ?? null, inventory.counts),
    // The spawn-context observations are read ONLY for a focus whose item
    // declared a mob producer (`ender_pearl` <- enderman, `blaze_rod` <- blaze):
    // an ordinary tick pays nothing, and the fact exists exactly where the
    // producer search needs it. A missing dimension string is not a context, so
    // nothing is sampled for it.
    ...(focusMobProducers(input) === null
      ? {}
      : {
          spawnContexts: [...(focusMobProducers(input) as ReadonlySet<string>)]
            .sort()
            .map((mob) => sampleMobSpawnContext(bot, mob, self.dimension, self.position)),
        }),
    // The hazard cell sample is carried only while a hazard is actually present:
    // an inactive body's state keeps exactly the shape it had before this fact
    // existed, and the candidate layer reads "no cells" as "no hazard".
    ...(envHazardCells.length > 0 && self.envHazard?.active === true ? { envHazardCells } : {}),
    ...(bodyIsOutOfAir(self) && bodyIsSubmerged(self) ? { submersionEscapeTargets } : {}),
    // Both new terrain facts follow the same rule: a body with no portal and no
    // cover nearby keeps exactly the state shape it had before they existed.
    terrain: {
      standable: terrain.standable,
      escapeCells: escape.cells,
      ...(escape.coverCells.length === 0 ? {} : { threatCoverCells: dedupeCells(escape.coverCells) }),
      ...(portalWalkInCells.length === 0 ? {} : { portalWalkInCells }),
    },
    craftingTables: buildStations(bot, options, self, CRAFT_STATIONS, rememberedStations),
    furnaces: buildFurnaces(bot, options, self, rememberedStations),
    // The SAME station scan/build path as the crafting table and the furnace -
    // never a forked approach: a container placed in the world (by an operator,
    // a structure, or the body itself) is sensed here and remembered durably
    // through the identical `kind: 'station'` known-resource envelope.
    containers: buildContainers(bot, options, self, rememberedStations),
    ...(input.containerContents === undefined || input.containerContents.length === 0
      ? {}
      : { containerContents: input.containerContents.map((entry) => ({ ...entry, items: entry.items.map((stack) => ({ ...stack })) })) }),
    placementSpots,
    submergedPlacementSpots: submergedPlacementSpots(bot, placementSpots),
    // Sensing is gated on the material possibility (a bridge needs a block to
    // place), never on a decision: the typed `no_block` refusal is derived from the
    // inventory fact alone, so an empty-handed body still reads its gap.
    ...(selectPlaceableBlock(inventory.counts) === null ? {} : { bridgeProbes: buildBridgeProbes(bot, self) }),
    portalFrameSites,
    portalFrame,
    liveStructureMembers: mergeLiveStructureMembers(
      liveStructureMembersForSites(portalFrameSites),
      underConstructionMembers(portalFrameSites, input.goalQueue?.current ?? null),
    ),
    knownResourceEvidence,
    descent,
    // The DOWNWARD self-landing probe. Sensing is gated on the WORLD shape (the
    // body's own descent pool refused a downward step for `no_support`), never on
    // a decision: the typed `no_block` refusal is derived from the inventory fact
    // alone, so an empty-handed body still reads its own unsupported landing and
    // can say exactly what it is missing. An ordinary tick reads nothing extra.
    ...((): { descentScaffold?: DescentScaffoldProbe } => {
      const probe = buildDescentScaffoldProbe(bot, self, descent)
      return probe === null ? {} : { descentScaffold: probe }
    })(),
    // The wall-entry probes exist only where a step is refused by the body's own
    // local geology: on ordinary terrain this adds nothing at all. The bounded LEVEL
    // SCAN rides the same gate (the measured island is exactly this shape): a body
    // whose own level offers nothing gets the levels below it read too.
    ...(shouldProbeWallEntry(descent)
      ? { wallProbes: buildWallProbes(bot, self, descent), levelScan: buildLevelScanProbes(bot, self, descent) }
      : {}),
    stepCuts: buildStepCuts(bot, options, self),
    headroomCuts: buildHeadroomCuts(bot, options, self),
    goal: input.goal,
    goalQueue: input.goalQueue,
    currentOption: input.currentOption ?? null,
    recentOutcomes: [...(input.recentOutcomes ?? [])].slice(-8),
    recentEvents: input.recentEvents.slice(-12),
    signals,
  }
}

/** Convenience: reload the goal counters from the live inventory after a dig. */
export function refreshGoalProgress(goal: GoalState, haveCount: number): GoalState {
  const gained = Math.max(0, haveCount - goal.startCount)
  const progress = goal.requiredCount === 0 ? 1 : Math.min(1, gained / goal.requiredCount)
  return {
    ...goal,
    haveCount,
    progress,
    complete: gained >= goal.requiredCount,
  }
}

/** True for any wood log item (`oak_log`, `birch_log`, ... , `stripped_*_log`). */
export function isLogItem(name: string): boolean {
  return name.endsWith('_log')
}

export function makeGoal(targetItem: string, requiredCount: number): GoalState {
  return {
    id: `chop:${targetItem}`,
    description: `collect ${requiredCount} x ${targetItem}`,
    targetItem,
    requiredCount,
    startCount: 0,
    haveCount: 0,
    progress: 0,
    complete: false,
    startedAtMs: Date.now(),
  }
}
