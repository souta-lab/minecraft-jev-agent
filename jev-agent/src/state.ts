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
import type { GoalQueueState } from './goalQueue.ts'
import type { CurrentOptionContext } from './optionSpec.ts'
import type { System2Outcome } from './system2.ts'
import type { StrategicStallEvidence } from './strategicStall.ts'
import { resourceMatches } from './resourceClass.ts'
import { PICKAXE_TIER0, resolveHarvest } from './gameData.ts'
import type { GameDataRegistry } from './gameData.ts'
import {
  detectPortalVerification,
  NETHER_PORTAL,
  portalFrameLayout,
  portalFrameLiveStructureMembers,
  portalFrameNeedsTemporarySupport,
  validatePortalFrame,
} from './netherPortalPlan.ts'
import type { PortalFrameSite, PortalFrameValidation, PortalWidthAxis } from './netherPortalPlan.ts'
import { isProtectedStationBlock, liveStructureCellKey } from './blockSafety.ts'
import type { LiveStructureMember } from './blockSafety.ts'
import { PILLAR_PLACE_PRIORITY, selectPlaceableBlock } from './pillarSearch.ts'
import { ARMOR_SLOT_INDEX, ARMOR_SLOTS } from './gearPlan.ts'
import type { ArmorSlot } from './gearPlan.ts'

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

/** A perceived station: coordinates plus provenance (see `StationSource`). */
export type StationEntry = Vec3Json & { source: StationSource }

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

export type HeldItemState = {
  name: string
  count: number
  slot: number
}

/**
 * Worn armor per destination. Built from the mineflayer player-window armor
 * slots (5-8), which `bot.inventory.items()` deliberately excludes: a WORN
 * piece is not a carried item, so `inventory.counts` never double-counts it.
 * `null` means nothing is worn in that slot.
 */
export type ArmorState = Record<ArmorSlot, HeldItemState | null>

/** All armor slots empty. Exported so pure fixtures need not repeat the shape. */
export const EMPTY_ARMOR: ArmorState = { head: null, torso: null, legs: null, feet: null }

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
  /**
   * Worn armor per destination. Optional so pure fixtures that predate the
   * armor affordance need not restate it; `buildWorldState` always populates it
   * and consumers treat an absent value as all slots empty.
   */
  armor?: ArmorState
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
}

/** One pre-computed staircase/tunnel step in a cardinal direction. */
export type DescentMode = 'down' | 'level'

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
 * A solid block directly above the bot's feet that blocks a jump (the
 * "canopy pocket" trap: a 2-tall space under leaves where every step-up jump is
 * vetoed by the ceiling). Mining it opens the headroom the jump needs. `safe` is
 * false when the block must not be removed (unbreakable, or a fluid/hazard).
 */
export type HeadroomCut = {
  /** the ceiling block itself (feet + 1 or feet + 2; never the feet/support) */
  pos: Vec3Json
  name: string
  safe: boolean
  reason: string
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
  /** true when every dig in this step is safe (no lava/water/void, solid landing) */
  safe: boolean
  reason: string
  /** concrete name of the primary cell this step digs (down=floor else wall/head) */
  digName?: string | null
  /** harvest family of the primary cell, resolved from the live block */
  digHarvestTool?: HarvestTool | null
  /** minimum pickaxe rank for the primary cell */
  digHarvestTier?: number | null
  /** primary cell is diggable right now */
  diggable?: boolean
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
  /** fixed dig direction once chosen; do not flip until the cap/resource (#4) */
  digDir?: DescentDir | null
  /** consecutive digs already executed in `digDir` (cap `DIG_PATH_CAP`) */
  digDirCount?: number
  /** staircase depth (down steps) for the current dig path */
  digDepth?: number
  /** true when the last 6 digs showed near-zero net displacement -> staircase */
  digOscillate?: boolean
  /** deepest stone/ore level observed (positive evidence for a staircase) */
  knownStoneY?: number | null
  /** last tunnel cell recorded by WorldMemory, for `REUSE_TUNNEL` */
  lastTunnel?: Vec3Json | null
  /** successful DESCEND actions in a row that produced zero resource progress */
  descendNoProgress?: number
  /** set once `descendNoProgress >= DESCEND_NO_PROGRESS_LIMIT` -> lateral search */
  descendLimitReached?: boolean
  /** durable known-resource coordinates injected by the host (issue #43) */
  knownResources?: KnownResource[]
  /**
   * #360: code-owned state-recurrence evidence for the ACTIVE Option. Verified
   * body motion that keeps returning to the same small set of states with zero
   * goal/search progress is strategic non-progress; the semantic layer needs
   * this to see a stalled Option that every other counter misses.
   */
  strategicNonProgress?: StrategicStallEvidence | null
  /** #360: `OSCILLATION_DETECTED` count for the active Option instance. */
  oscillationsDetected?: number
  /**
   * #78: block key (`bX_Y_Z`) of a furnace the bot placed from a held item, so
   * the SMELT candidate can report `furnaceSource=held` to FURNACE_READY.
   */
  heldFurnacePlacedAt?: string | null
}

export type WorldState = {
  schemaVersion: 1
  tick: number
  timestampMs: number
  self: SelfState
  inventory: InventoryState
  entities: EntityState[]
  blocks: BlockState[]
  terrain: { standable: Vec3Json[] }
  /** placed crafting_table stations: sensed near-field first, then remembered */
  craftingTables: StationEntry[]
  /** placed furnace stations: sensed near-field first, then remembered (M2 smelting) */
  furnaces?: StationEntry[]
  /** reachable air positions with solid support where a block could be placed */
  placementSpots: Vec3Json[]
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
  /** pre-computed staircase / tunnel steps around the bot (M2 descent) */
  descent?: DescentOption[]
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
  maxStoneBlocks: number
  maxPlacementSpots: number
  /**
   * Exact world-mutation revision (see `DecisionScheduler.worldRevision`), or
   * absent/null when the caller cannot prove one. Only when it is a finite
   * number may `buildWorldState` reuse a `findBlocks` position list across
   * builds (see `stableFindBlocks`). Absent = caching off, which is what every
   * fixture and any non-resident caller gets.
   */
  worldRevision?: number | null
}

export const defaultSensorOptions: SensorOptions = {
  scanRadius: 48,
  reach: 4.5,
  maxLogs: 16,
  maxEntities: 12,
  maxTerrain: 8,
  hazardRadius: 6,
  entityRadius: 24,
  maxStoneBlocks: 16,
  maxPlacementSpots: 6,
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
const CRAFT_STATIONS = new Set(['crafting_table'])
const FURNACE_STATIONS = new Set(['furnace', 'blast_furnace', 'smoker'])
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

/** Resolve a block's primary drop, required tool class and required pickaxe rank. */
export function resolveBlockHarvest(
  bot: Bot,
  blockName: string,
): { yield: string | null; harvestTool: HarvestTool | null; harvestTier: number | null } {
  return resolveHarvest((bot.registry ?? {}) as GameDataRegistry, blockName)
}

function blockVisible(bot: Bot, block: { position: { x: number; y: number; z: number } }, inReach: boolean): boolean {
  if (!inReach) return false
  try {
    return bot.canSeeBlock(block as never)
  } catch {
    return true
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

function isPassable(block: { boundingBox: string } | null): boolean {
  // lava/water have an "empty" bounding box, so passability alone is not
  // enough for a standable spot - the support check below excludes liquids.
  return block !== null && block.boundingBox === 'empty'
}

function isSolidSupport(block: { boundingBox: string } | null): boolean {
  return block !== null && block.boundingBox === 'block'
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
  const feetBlock = bot.blockAt(toVec3(bot, feet))
  const headBlock = bot.blockAt(toVec3(bot, { x: feet.x, y: feet.y + 1, z: feet.z }))
  const belowBlock = bot.blockAt(toVec3(bot, { x: feet.x, y: feet.y - 1, z: feet.z }))
  return isPassable(feetBlock) && isPassable(headBlock) && isSolidSupport(belowBlock)
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
  const position = vecJson(bot.entity.position)
  const eye = bot.entity.position.offset(0, EYE_HEIGHT, 0)
  const held = bot.heldItem
  return {
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
    armor: buildArmor(bot),
  }
}

/**
 * Read the four armor destinations from the live player window. Mineflayer
 * window 0 slots 5-8 are armor head->feet; a fake bot without `slots` reports
 * every slot empty rather than throwing.
 */
function buildArmor(bot: Bot): ArmorState {
  const slots = (bot.inventory as { slots?: ReadonlyArray<{ name?: string; count?: number; slot?: number } | null> })
    .slots
  const armor = { ...EMPTY_ARMOR }
  for (const slot of ARMOR_SLOTS) {
    const index = ARMOR_SLOT_INDEX[slot]
    const item = slots?.[index]
    if (item === undefined || item === null || typeof item.name !== 'string') continue
    armor[slot] = { name: item.name, count: item.count ?? 1, slot: item.slot ?? index }
  }
  return armor
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

function buildEntities(bot: Bot, options: SensorOptions, selfPosition: Vec3Json): EntityState[] {
  const out: EntityState[] = []
  const selfId = bot.entity.id
  for (const entity of Object.values(bot.entities)) {
    if (entity.id === selfId) continue
    if (entity.isValid === false) continue
    const distanceToBot = entity.position.distanceTo(bot.entity.position)
    if (distanceToBot > options.entityRadius) continue
    const name = entity.username ?? entity.name ?? entity.kind ?? 'unknown'
    out.push({
      id: entity.id,
      name,
      kind: entity.kind ?? 'unknown',
      username: entity.username ?? null,
      position: vecJson(entity.position),
      distance: round2(distanceToBot),
      hostile: isHostile(name, entity.kind),
    })
  }
  out.sort((a, b) => a.distance - b.distance)
  return out.slice(0, options.maxEntities)
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

function stableFindBlocks(
  bot: Bot,
  scanId: string,
  options: Parameters<Bot['findBlocks']>[0],
): Vec3[] {
  const revision = activeScanRevision
  if (revision === null) return bot.findBlocks(options)
  const point = bot.entity.position.floored()
  const key = `${scanId}|${bot.game.dimension}|${point.x},${point.y},${point.z}`
  const hit = scanPositionCache.get(key)
  if (hit !== undefined && hit.revision === revision) return hit.positions
  const positions = bot.findBlocks(options)
  if (scanPositionCache.size >= SCAN_POSITION_CACHE_CAP) {
    const oldest = scanPositionCache.keys().next().value
    if (oldest !== undefined) scanPositionCache.delete(oldest)
  }
  scanPositionCache.set(key, { revision, positions })
  return positions
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
    const block = bot.blockAt(position)
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
      const neighbour = bot.blockAt(scratch.set(x + dx, y + dy, z + dz))
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
        const block = bot.blockAt(scratch.set(x, y, z))
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
    const block = bot.blockAt(position)
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
    const block = bot.blockAt(position)
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
    const block = bot.blockAt(position)
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

function buildHazardBlocks(bot: Bot, options: SensorOptions, self: SelfState): BlockState[] {
  const out: BlockState[] = []
  const positions = stableFindBlocks(bot, `hazards:${options.hazardRadius}:32`, {
    matching: (block) => HAZARDS.has(block.name),
    maxDistance: options.hazardRadius,
    count: 32,
  })
  for (const position of positions) {
    const block = bot.blockAt(position)
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
  const hazards = buildHazardBlocks(bot, options, self)
  // Keep the bounded capability envelope ahead of the broad route-planning
  // stone scan. This is not a semantic ranking: `mineCandidates` applies a
  // typed placeable-producer filter, but its mechanical candidate cap must not
  // be consumed by unrelated stone cells before the near producer is seen.
  const blocks = [...logs, ...nearbyPlaceableProducers, ...stones, ...buried, ...ores, ...hazards]
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
  const at = (x: number, y: number, z: number) => bot.blockAt(scratch.set(x, y, z))
  const solid = (x: number, y: number, z: number): boolean => {
    const block = at(x, y, z)
    return block !== null && block.boundingBox === 'block'
  }
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
    const wallSolid = solid(wall.x, wall.y, wall.z)
    const headSolid = solid(head.x, head.y, head.z)
    const floorSolid = solid(floor.x, floor.y, floor.z)
    const supportSolid = solid(support.x, support.y, support.z)
    // The bot's own column needs no front/head clearance: it digs the floor.
    const wallOk = ownColumn || clear(wall.x, wall.y, wall.z) || diggableSolid(wall.x, wall.y, wall.z)
    const headOk = ownColumn || clear(head.x, head.y, head.z) || diggableSolid(head.x, head.y, head.z)
    const floorOk = mode === 'level' || clear(floor.x, floor.y, floor.z) || diggableSolid(floor.x, floor.y, floor.z)
    let reason = 'safe'
    const protectedDig = [wall, head, floor]
      .map((cell) => at(cell.x, cell.y, cell.z))
      .find((block) => block !== null && isProtectedStationBlock(block.name))
    if (protectedDig !== undefined && protectedDig !== null) reason = `${protectedDig.name} is a protected station`
    else if (!wallOk) reason = `${at(wall.x, wall.y, wall.z)?.name ?? 'unknown'} wall is not breakable`
    else if (!headOk) reason = `${at(head.x, head.y, head.z)?.name ?? 'unknown'} head-cell is not breakable`
    else if (!floorOk) reason = `${at(floor.x, floor.y, floor.z)?.name ?? 'unknown'} floor is not breakable`
    else if (!supportSolid) reason = `no solid support at (${support.x},${support.y},${support.z})`
    else if (mode === 'down' && clear(floor.x, floor.y, floor.z)) reason = 'floor already open (uncontrolled fall)'
    else if (hazardsAround(hazardous, wall, head, floor, step, support)) reason = 'lava/water in the step column'
    const primary = mode === 'down' ? (floorSolid ? floor : wall) : wallSolid ? wall : head
    const primaryBlock = at(primary.x, primary.y, primary.z)
    const primaryHarvest =
      primaryBlock === null
        ? { yield: null, harvestTool: null, harvestTier: null }
        : resolveBlockHarvest(bot, primaryBlock.name)
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
      safe: reason === 'safe',
      reason,
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
  const at = (x: number, y: number, z: number) => bot.blockAt(scratch.set(x, y, z))
  const solid = (x: number, y: number, z: number): boolean => {
    const block = at(x, y, z)
    return block !== null && block.boundingBox === 'block'
  }
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
      else if (!solid(x, top - 1, z)) reason = 'no solid landing under the cut'
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
  const at = (x: number, y: number, z: number) => bot.blockAt(scratch.set(x, y, z))
  const clear = (x: number, y: number, z: number): boolean => {
    const block = at(x, y, z)
    return block === null || block.boundingBox === 'empty'
  }
  if (clear(feetX, feetY + 1, feetZ) && clear(feetX, feetY + 2, feetZ)) return []

  const out: HeadroomCut[] = []
  const consider = (x: number, y: number, z: number): void => {
    const block = at(x, y, z)
    if (block === null || block.boundingBox !== 'block') return
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
    out.push({ pos: { x, y, z }, name, safe, reason })
  }
  for (const dy of [1, 2]) consider(feetX, feetY + dy, feetZ)
  // Adjacent columns are included so a clearance candidate survives the 1-block
  // shuffle of the escape and the next decision can still execute the same dig.
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dz = -1; dz <= 1; dz += 1) {
      if (dx === 0 && dz === 0) continue
      for (const dy of [1, 2]) consider(feetX + dx, feetY + dy, feetZ + dz)
    }
  }
  return out
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
      for (let dy = 0; dy <= 1; dy += 1) {
        const candidate = { x: feet.x + dx, y: feet.y + dy, z: feet.z + dz }
        // A placement target must not be inside the bot's own body.
        const nearBody = distance(
          { x: candidate.x + 0.5, y: candidate.y, z: candidate.z + 0.5 },
          botBody,
        )
        if (nearBody < 1.0) continue
        const atFeet = bot.blockAt(scratch.set(candidate.x, candidate.y, candidate.z))
        const above = bot.blockAt(scratch.set(candidate.x, candidate.y + 1, candidate.z))
        const below = bot.blockAt(scratch.set(candidate.x, candidate.y - 1, candidate.z))
        // Truly replaceable air only: `leaf_litter` and similar are passable but
        // the server refuses to overwrite them, so placing there silently fails.
        if (!isReplaceableAir(atFeet)) continue
        if (above === null || above.boundingBox !== 'empty') continue
        if (below === null || below.boundingBox !== 'block') continue
        const pos = vecJson(candidate)
        if (distance(pos, self.eyePosition) > options.reach + 0.5) continue
        spots.push(pos)
      }
    }
  }
  spots.sort((a, b) => distance(a, self.position) - distance(b, self.position))
  return spots.slice(0, options.maxPlacementSpots)
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
  const base = {
    x: Math.floor(self.position.x),
    y: Math.floor(self.position.y),
    z: Math.floor(self.position.z),
  }
  const scratch = bot.entity.position.clone()
  const cache = new Map<string, ReturnType<Bot['blockAt']>>()
  const at = (x: number, y: number, z: number): ReturnType<Bot['blockAt']> => {
    const key = `${x}|${y}|${z}`
    const cached = cache.get(key)
    if (cached !== undefined) return cached
    const block = bot.blockAt(scratch.set(x, y, z))
    cache.set(key, block)
    return block
  }
  const clear = (x: number, y: number, z: number): boolean => {
    const block = at(x, y, z)
    return block !== null && REPLACEABLE_AIR.has(block.name)
  }
  const solid = (x: number, y: number, z: number): boolean => at(x, y, z)?.boundingBox === 'block'
  const axes: PortalWidthAxis[] = ['x', 'z']
  const sites: PortalFrameSite[] = []
  const body = self.position
  // The portal may have been started several blocks away from the current
  // spawn/stand position. Keep the search bounded, but wide enough to observe
  // a nearby partial frame before a planner can replace it with a new site.
  const frameRadius = Math.min(16, Math.max(8, Math.floor(_options.scanRadius / 3)))

  for (let dx = -frameRadius; dx <= frameRadius; dx += 1) {
    for (let dz = -frameRadius; dz <= frameRadius; dz += 1) {
      for (let dy = -4; dy <= 4; dy += 1) {
        const origin = { x: base.x + dx, y: base.y + dy, z: base.z + dz }
        for (const widthAxis of axes) {
          const layout = portalFrameLayout(origin, widthAxis)
          const existingFrame: Vec3Json[] = []
          let validFootprint = true
          for (const cell of layout.frame) {
            const block = at(cell.x, cell.y, cell.z)
            if (block?.name === 'obsidian') existingFrame.push(cell)
            else if (!clear(cell.x, cell.y, cell.z)) {
              validFootprint = false
              break
            }
          }
          if (!validFootprint) continue
          // Corners are optional and may already contain harmless scaffolding;
          // they are never counted toward the ten required edge blocks. The
          // interior, however, must remain clear for a future ignition.
          // A lit portal replaces the interior air with `nether_portal`. Keep
          // the frame site observable so the controller can re-check that
          // post-condition from live world truth instead of a stale queue bit.
          if (!validFootprint || !layout.interior.every((cell) => clear(cell.x, cell.y, cell.z) || at(cell.x, cell.y, cell.z)?.name === NETHER_PORTAL)) continue
          let supported = true
          for (let w = 0; w < 4; w += 1) {
            const bottom =
              widthAxis === 'x'
                ? { x: origin.x + w, y: origin.y, z: origin.z }
                : { x: origin.x, y: origin.y, z: origin.z + w }
            if (!solid(bottom.x, bottom.y - 1, bottom.z)) {
              const bottomCell = layout.frame.find((cell) => cell.x === bottom.x && cell.y === bottom.y && cell.z === bottom.z)
              const alreadyBuilt = bottomCell !== undefined && existingFrame.some((cell) => portalCellKey(cell) === portalCellKey(bottomCell))
              if (!alreadyBuilt) {
                supported = false
                break
              }
            }
          }
          if (!supported) continue
          const temporarySupportRequired = portalFrameNeedsTemporarySupport(
            origin,
            widthAxis,
            existingFrame,
            (position) => solid(position.x, position.y, position.z),
          )
          const first = { x: origin.x + 0.5, y: origin.y, z: origin.z + 0.5 }
          if (distance(first, body) < 1.0) continue
          sites.push({
            origin,
            widthAxis,
            safe: true,
            reachable: true,
            temporarySupportRequired,
            ...(existingFrame.length === 0 ? {} : { existingFrame }),
          })
        }
      }
    }
  }

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
    (position) => bot.blockAt(new Vec3(position.x, position.y, position.z))?.name ?? null,
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
      (position) => bot.blockAt(new Vec3(position.x, position.y, position.z))?.name ?? null,
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
 * The live-structure membership fact for every site whose required geometry
 * validates. Exported so any layer that re-derives `portalFrameSites` (for
 * example the controller's in-memory frame memory) can recompute the same fact
 * instead of leaving a stale membership set behind.
 */
export function liveStructureMembersForSites(sites: readonly PortalFrameSite[]): LiveStructureMember[] {
  const members: LiveStructureMember[] = []
  const seen = new Set<string>()
  for (const site of sites) {
    const blocks = site.existingFrame ?? []
    // Fewer than the ten required edges cannot validate; skip without calling
    // the validator so a partial frame never contributes membership.
    if (blocks.length < 10) continue
    const validation = validatePortalFrame({ blocks, widthAxis: site.widthAxis })
    if (validation.shape !== 'ok') continue
    for (const member of portalFrameLiveStructureMembers(validation)) {
      const key = liveStructureCellKey(member.position)
      if (seen.has(key)) continue
      seen.add(key)
      members.push(member)
    }
  }
  return members
}

function buildTerrain(bot: Bot, options: SensorOptions, self: SelfState): Vec3Json[] {
  const found: Vec3Json[] = []
  const base = { x: Math.floor(self.position.x), y: Math.floor(self.position.y), z: Math.floor(self.position.z) }
  for (let dx = -2; dx <= 2; dx += 1) {
    for (let dz = -2; dz <= 2; dz += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        const feet: Vec3Json = { x: base.x + dx, y: base.y + dy, z: base.z + dz }
        if (!isStandable(bot, feet)) continue
        found.push(feet)
      }
    }
  }
  found.sort((a, b) => distance(a, self.position) - distance(b, self.position))
  return found.slice(0, options.maxTerrain)
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
  try {
    return buildWorldStateUncached(bot, input, options)
  } finally {
    activeScanRevision = null
  }
}

function buildWorldStateUncached(bot: Bot, input: SensorInput, options: SensorOptions): WorldState {
  const self = buildSelf(bot)
  const inventory = buildInventory(bot)
  const rememberedStations = input.rememberedStations ?? input.signals.knownResources ?? []
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
  return {
    schemaVersion: 1,
    tick: input.tick,
    timestampMs: Date.now(),
    self,
    inventory,
    entities: buildEntities(bot, options, self.position),
    blocks: buildBlocks(bot, options, self, input.focusItem ?? null, inventory.counts),
    terrain: { standable: buildTerrain(bot, options, self) },
    craftingTables: buildStations(bot, options, self, CRAFT_STATIONS, rememberedStations),
    furnaces: buildFurnaces(bot, options, self, rememberedStations),
    placementSpots: buildPlacementSpots(bot, options, self),
    portalFrameSites,
    portalFrame,
    liveStructureMembers: liveStructureMembersForSites(portalFrameSites),
    descent: buildDescent(bot, options, self),
    stepCuts: buildStepCuts(bot, options, self),
    headroomCuts: buildHeadroomCuts(bot, options, self),
    goal: input.goal,
    goalQueue: input.goalQueue,
    currentOption: input.currentOption ?? null,
    recentOutcomes: [...(input.recentOutcomes ?? [])].slice(-8),
    recentEvents: input.recentEvents.slice(-12),
    signals: input.signals,
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
