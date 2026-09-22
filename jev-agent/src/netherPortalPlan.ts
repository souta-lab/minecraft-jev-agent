// netherPortalPlan.ts - issue #80: typed Nether-portal capability grounding.
//
// WHY
// ---
// M2 is "diamond -> Nether gate". The former iron-age ladder remains a lower
// prerequisite path. This module exposes code-owned truth, hard preconditions,
// mechanically-valid affordances, and verifiable postconditions; it is not a
// semantic planner or an authority over ordering. Mercury/System2 and Jev own
// WHAT NEXT and WHICH grounded option to pursue. Issue #37 records that peaceful
// difficulty blocks M3d/M3e (blaze_rod / ender_pearl) but NOT building and
// lighting the portal, so this module owns the mechanically grounded half only:
//
//   craft flint_and_steel -> (diamond pickaxe) -> mine obsidian x10 ->
//   build the 4x5 frame -> validate shape -> light -> verify
//
// DESIGN (AGENTS.md section 8: safety / success / world truth -> deterministic code)
// --------------------------------------------------------------------------------
//  * Typed plan kinds, never a free-text item list (#19). Every operation is a
//    discriminated union member with a code-owned `capabilityId`, and compiles to
//    the existing `PlannedGoal` kinds so the GoalQueue/OptionSpec layer is reused.
//  * Every step carries a verifiable post-condition (#79). A step whose
//    post-condition is false is a failure, never a silent success.
//  * The obsidian mine is REFUSED, not attempted, without a diamond pickaxe:
//    `PRECONDITION_MISSING tool=diamond_pickaxe` (no wasted dig).
//  * The frame shape is validated before lighting. A bad frame is never lit.
//
// Pure module: no bot, no clock, no model. The in-memory simulation exists so the
// full frame -> light -> verify path is unit-testable without a live world.
import { loadGameData, requiredPickaxeRank1 } from './gameData.ts'
import type { PlannedGoal } from './goalQueue.ts'
import type { LiveStructureMember } from './blockSafety.ts'

// ---------------------------------------------------------------------------
// constants / markers
// ---------------------------------------------------------------------------

/** Exact marker the task requires when the mining tool is missing. */
export const PRECONDITION_MISSING = 'PRECONDITION_MISSING'
/** Frame validated (blocks placed, shape checked). */
export const PORTAL_FRAME_READY = 'PORTAL_FRAME_READY'
/** One obsidian frame block was placed. */
export const PORTAL_BLOCK_PLACED = 'PORTAL_BLOCK_PLACED'
/** The portal was lit. */
export const PORTAL_LIT = 'PORTAL_LIT'
/** The lit portal was verified. */
export const PORTAL_VERIFIED = 'PORTAL_VERIFIED'
/** The portal could not be lit (precondition or bad frame). */
export const PORTAL_LIGHT_REFUSED = 'PORTAL_LIGHT_REFUSED'
/** The bot entered the lit portal and the server moved it to the Nether. */
export const PORTAL_ENTERED = 'PORTAL_ENTERED'
/** Entry was refused before any movement (no lit portal / no safe approach). */
export const PORTAL_ENTER_REFUSED = 'PORTAL_ENTER_REFUSED'
/**
 * The entry route targets a REMEMBERED portal site whose interior could not be
 * observed from here. The route is offered (the walk is a real capability), and
 * the lit fact stays a precondition the executor re-verifies at arrival - so the
 * marker is evidence of an unverified approach, never of a lit portal.
 */
export const PORTAL_ENTRY_UNVERIFIED = 'PORTAL_ENTRY_UNVERIFIED'
/**
 * The bounded DIRECT WALK into a non-solid portal interior cell (the actuator
 * of last resort when the pathfinder cannot execute the destination node). The
 * line reports what the walk actually did - `from_d`/`to_d` are the feet
 * distances to the interior cell centre, `transferred` is the OBSERVED
 * dimension change - so a walk that moved nothing can never look like an entry.
 */
export const PORTAL_WALK_IN = 'PORTAL_WALK_IN'
/** The direct walk was refused before any movement, with the typed world reason. */
export const PORTAL_WALK_IN_REFUSED = 'PORTAL_WALK_IN_REFUSED'
/**
 * A multi-cell frame build finished its batch but the complete 10-edge shape is
 * still not present. This is a typed terminal cause: the batch was real work,
 * yet the frame is not verifiable, so the endless `verify_failed` retry that
 * measured 152 `PORTAL_BLOCK_PLACED` with zero `PORTAL_FRAME_READY` cannot recur.
 */
export const FRAME_BUILD_INCOMPLETE = 'FRAME_BUILD_INCOMPLETE'
/**
 * The planned frame cells do not belong to any 4x5 portal layout. The build is
 * geometrically ungrounded (a stale/foreign site) and must fail once instead of
 * placing into the void.
 */
export const FRAME_BUILD_UNGROUNDED = 'FRAME_BUILD_UNGROUNDED'
/**
 * A frame placement cell is occupied by a block the build cannot clear (not a
 * placement scaffold, not diggable, or protected). Terminal typed refusal: the
 * frame cannot be built from the current world, and the plan must say so once.
 */
export const FRAME_BUILD_BLOCKED = 'FRAME_BUILD_BLOCKED'
/**
 * The frame scan rejected every candidate origin. Names origin/axis/rule/cell/
 * block so `portal_frame_site:none` can never again be a silent starvation.
 */
export const PORTAL_FRAME_SITE_REJECTED = 'PORTAL_FRAME_SITE_REJECTED'

/**
 * The queue-level predicate that names the ignition operation. Both the
 * `light:nether_portal` and `verify:nether_portal` capability steps compile to a
 * `place nether_portal` goal carrying this predicate, so a queue dedups them
 * into ONE ignition action whose executor post-condition IS the verification.
 */
export const PORTAL_LIT_PREDICATE = 'portal_lit'

/**
 * The queue-level predicate that names the dimension-transfer operation. An
 * `enter:nether_portal` step compiles to a `place nether_portal` goal carrying
 * this predicate and the target dimension, so the GoalQueue completion check is
 * the SAME code-owned `dimensionIs` truth (never an inventory count, which
 * `nether_portal` can never satisfy).
 */
export const PORTAL_ENTERED_PREDICATE = 'portal_entered'

/** The portal frame is a 4-wide x 5-tall obsidian rectangle. */
export const PORTAL_FRAME_WIDTH = 4
export const PORTAL_FRAME_HEIGHT = 5
/** Interior opening: 2 wide x 3 tall. */
export const PORTAL_INTERIOR_WIDTH = 2
export const PORTAL_INTERIOR_HEIGHT = 3
/**
 * Obsidian needed for a valid portal. The four corners of the 4x5 rectangle are
 * optional, so the minimal frame is the 10 edge blocks the task asks to gather.
 */
export const PORTAL_OBSIDIAN_REQUIRED = 10
/** Maximum frame blocks when all four optional corners are placed. */
export const PORTAL_FRAME_BLOCKS_FULL = 14

export const OBSIDIAN = 'obsidian'
export const FLINT = 'flint'
export const FLINT_AND_STEEL = 'flint_and_steel'
export const DIAMOND_PICKAXE = 'diamond_pickaxe'
export const IRON_PICKAXE = 'iron_pickaxe'
export const DIAMOND = 'diamond'
export const IRON_INGOT = 'iron_ingot'
export const RAW_IRON = 'raw_iron'
export const NETHER_PORTAL = 'nether_portal'
export const OVERWORLD = 'minecraft:overworld'
export const NETHER = 'minecraft:the_nether'

/** Runtime rank of a diamond pickaxe (PICKAXE_TIER0: diamond=4). */
export const DIAMOND_PICKAXE_RANK = 4
/** Runtime rank of an iron pickaxe (PICKAXE_TIER0: iron=3). */
export const IRON_PICKAXE_RANK = 3

export interface PortalBlockPosition {
  readonly x: number
  readonly y: number
  readonly z: number
}

/** The axis the 4-wide side spans; the remaining horizontal axis is the normal. */
export type PortalWidthAxis = 'x' | 'z'

/**
 * A live, code-grounded frame origin.  Unlike a single placement spot, this
 * record is only emitted after the complete 4x5 footprint has been checked
 * for clear cells and a solid bottom support row.
 */
export interface PortalFrameSite {
  readonly origin: PortalBlockPosition
  readonly widthAxis: PortalWidthAxis
  readonly safe?: boolean
  readonly reachable?: boolean
  /** Required edge cells already occupied by obsidian in the live world. */
  readonly existingFrame?: readonly PortalBlockPosition[]
  /**
   * Live placement geometry fact: the minimal ten-edge sequence needs a
   * temporary solid block to place at least one cell, because the optional
   * corners are absent and no natural neighbour can serve as a reference.
   * This is an affordance fact, not a semantic preference.
   */
  readonly temporarySupportRequired?: boolean
  /**
   * Live FUNCTIONAL-CORE fact used by the general structure-liveness predicate:
   * the structure's interior currently holds the blocks that make it work (for a
   * Nether portal, lit `nether_portal` blocks). The sensor sets this from live
   * world truth, and durable memory must never carry it forward. When true the
   * site contributes its whole footprint as live-structure membership even if
   * required shell cells are missing; when absent/false the site must fully
   * validate its required geometry to count as live.
   */
  readonly coreIntact?: boolean
  /**
   * Required edge cells currently occupied by a CLEARABLE placement-scaffold
   * block (`PILLAR_PLACE_PRIORITY`, e.g. leftover cobblestone). These are not
   * obsidian and not air, so they are part of the missing set; the frame build
   * clears them before placing the obsidian. Without this the scan rejected the
   * whole site and the live plan reported a silent `portal_frame_site:none`.
   */
  readonly blockedFrame?: readonly PortalBlockPosition[]
}

function normalizeDimension(dimension: string): string {
  return dimension.replace(/^minecraft:/, '').toLowerCase()
}

/**
 * Normalize a dimension id for comparison (`the_nether` and
 * `minecraft:the_nether` are the same dimension). Exported so the executor's
 * transfer postcondition and the queue's predicate use ONE normalizer.
 */
export function normalizePortalDimension(dimension: string): string {
  return normalizeDimension(dimension)
}

function formatPos(pos: PortalBlockPosition): string {
  return `${pos.x},${pos.y},${pos.z}`
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

// ---------------------------------------------------------------------------
// typed plan kinds (#19) + verifiable post-conditions (#79)
// ---------------------------------------------------------------------------

/**
 * Code-owned capability ids (#19). A plan may only ever name one of these; the
 * model cannot invent a verb x target pair.
 */
export type PortalCapabilityId =
  | 'collect:flint'
  | 'collect:obsidian'
  | 'collect:diamond'
  | 'collect:raw_iron'
  | 'smelt:iron_ingot'
  | 'craft:iron_pickaxe'
  | 'craft:diamond_pickaxe'
  | 'craft:flint_and_steel'
  | 'build:nether_portal_frame'
  | 'light:nether_portal'
  | 'verify:nether_portal'
  | 'enter:nether_portal'

/** The typed plan kind of a portal step. */
export type PortalStepKind =
  | 'collect'
  | 'craft'
  | 'smelt'
  | 'build_portal_frame'
  | 'light_portal'
  | 'verify_portal'
  | 'enter_portal'

/**
 * A post-condition is DATA evaluated by deterministic code (#79). A step is only
 * complete when its post-condition is provably true against a world snapshot.
 */
export type PortalPostcondition =
  | { readonly kind: 'inventoryAtLeast'; readonly item: string; readonly count: number }
  | { readonly kind: 'toolRankAtLeast'; readonly rank: number }
  | { readonly kind: 'frameShapeOk' }
  | { readonly kind: 'portalLit'; readonly dimension: string }
  | { readonly kind: 'portalVerified' }
  /** The bot's own dimension is `dimension` (the transfer postcondition). */
  | { readonly kind: 'dimensionIs'; readonly dimension: string }

interface PortalStepCommon {
  readonly capabilityId: PortalCapabilityId
  readonly description: string
  readonly postcondition: PortalPostcondition
  /** Issue #55: prerequisite work a replan must not drop. */
  readonly protected?: boolean
  /** Issue #55: core work a replan must not drop. */
  readonly core?: boolean
}

export interface PortalCollectStep extends PortalStepCommon {
  readonly kind: 'collect'
  readonly item: string
  readonly count: number
  /** minimum 1-based pickaxe tier required to harvest the target, when applicable */
  readonly requiredPickaxeRank?: number
}

export interface PortalCraftStep extends PortalStepCommon {
  readonly kind: 'craft'
  readonly item: string
  readonly count: number
}

export interface PortalSmeltStep extends PortalStepCommon {
  readonly kind: 'smelt'
  readonly item: string
  readonly count: number
}

export interface PortalBuildFrameStep extends PortalStepCommon {
  readonly kind: 'build_portal_frame'
  readonly width: number
  readonly height: number
  readonly blocks: number
  /** bottom-left frame origin; when set, the step compiles to its exact cells */
  readonly origin?: PortalBlockPosition
  readonly widthAxis?: PortalWidthAxis
}

export interface PortalLightStep extends PortalStepCommon {
  readonly kind: 'light_portal'
  readonly tool: typeof FLINT_AND_STEEL
}

export interface PortalVerifyStep extends PortalStepCommon {
  readonly kind: 'verify_portal'
  readonly dimension: string
}

export interface PortalEnterStep extends PortalStepCommon {
  readonly kind: 'enter_portal'
  /** destination dimension the transfer must produce */
  readonly dimension: string
}

export type PortalStep =
  | PortalCollectStep
  | PortalCraftStep
  | PortalSmeltStep
  | PortalBuildFrameStep
  | PortalLightStep
  | PortalVerifyStep
  | PortalEnterStep

export function isPortalStep(value: unknown): value is PortalStep {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.kind === 'string' &&
    (record.kind === 'collect' ||
      record.kind === 'craft' ||
      record.kind === 'smelt' ||
      record.kind === 'build_portal_frame' ||
      record.kind === 'light_portal' ||
      record.kind === 'verify_portal' ||
      record.kind === 'enter_portal') &&
    typeof record.capabilityId === 'string' &&
    typeof record.postcondition === 'object' &&
    record.postcondition !== null
  )
}

export interface PortalPostconditionSnapshot {
  readonly inventory: Readonly<Record<string, number>>
  readonly toolRank: number
  readonly frame: PortalFrameValidation | null
  readonly lit: boolean
  readonly litDimension: string | null
  readonly verified: boolean
  /** the bot's own live dimension, for the `dimensionIs` transfer predicate */
  readonly dimension?: string | null
}

/** Evaluate one post-condition against a plain snapshot. Pure and total. */
export function evaluatePortalPostcondition(
  postcondition: PortalPostcondition,
  snapshot: PortalPostconditionSnapshot,
): boolean {
  switch (postcondition.kind) {
    case 'inventoryAtLeast':
      return (snapshot.inventory[postcondition.item] ?? 0) >= postcondition.count
    case 'toolRankAtLeast':
      return snapshot.toolRank >= postcondition.rank
    case 'frameShapeOk':
      return snapshot.frame?.shape === 'ok'
    case 'portalLit':
      return (
        snapshot.lit &&
        snapshot.litDimension !== null &&
        normalizeDimension(snapshot.litDimension) === normalizeDimension(postcondition.dimension)
      )
    case 'portalVerified':
      return snapshot.verified
    case 'dimensionIs':
      return (
        snapshot.dimension !== undefined &&
        snapshot.dimension !== null &&
        normalizeDimension(snapshot.dimension) === normalizeDimension(postcondition.dimension)
      )
  }
}

// ---------------------------------------------------------------------------
// obsidian mining precondition (tool gate)
// ---------------------------------------------------------------------------

/** The 1-based pickaxe tier minecraft-data requires to harvest obsidian. */
export function obsidianRequiredPickaxeRank(): number {
  return requiredPickaxeRank1(loadGameData(), OBSIDIAN) ?? DIAMOND_PICKAXE_RANK
}

export interface ObsidianMiningDecision {
  /** false means the mine was REFUSED and no dig was attempted. */
  readonly attempted: boolean
  readonly count: number
  readonly line: string
}

/**
 * Decide whether obsidian can be mined. Without a diamond pickaxe the decision
 * is a refusal: `PRECONDITION_MISSING tool=diamond_pickaxe`. No attempt is made,
 * so no durability or time is wasted on an impossible dig.
 */
export function planObsidianMining(
  toolRank: number,
  count: number = PORTAL_OBSIDIAN_REQUIRED,
): ObsidianMiningDecision {
  const required = obsidianRequiredPickaxeRank()
  if (toolRank < required) {
    return { attempted: false, count, line: `${PRECONDITION_MISSING} tool=${DIAMOND_PICKAXE}` }
  }
  return { attempted: true, count, line: `MINE_OBSIDIAN target=${OBSIDIAN} count=${count} tool=${DIAMOND_PICKAXE}` }
}

// ---------------------------------------------------------------------------
// frame geometry + shape validation
// ---------------------------------------------------------------------------

function axisPosition(origin: PortalBlockPosition, widthAxis: PortalWidthAxis, w: number, h: number): PortalBlockPosition {
  return widthAxis === 'x'
    ? { x: origin.x + w, y: origin.y + h, z: origin.z }
    : { x: origin.x, y: origin.y + h, z: origin.z + w }
}

export interface PortalFrameLayout {
  readonly origin: PortalBlockPosition
  readonly widthAxis: PortalWidthAxis
  /** the 10 required edge cells (the four 4x5 corners are optional) */
  readonly frame: PortalBlockPosition[]
  /** the four optional corner cells */
  readonly corners: PortalBlockPosition[]
  /** the 2x3 interior cells that must stay clear */
  readonly interior: PortalBlockPosition[]
  /** where flint_and_steel is used (bottom interior cell) */
  readonly lightPosition: PortalBlockPosition
}

/** Build the canonical frame layout at `origin` (10 edge blocks + 4 optional corners). */
export function portalFrameLayout(origin: PortalBlockPosition, widthAxis: PortalWidthAxis = 'x'): PortalFrameLayout {
  const frame: PortalBlockPosition[] = []
  const corners: PortalBlockPosition[] = []
  const interior: PortalBlockPosition[] = []
  for (let w = 0; w < PORTAL_FRAME_WIDTH; w += 1) {
    for (let h = 0; h < PORTAL_FRAME_HEIGHT; h += 1) {
      const onRing = w === 0 || w === PORTAL_FRAME_WIDTH - 1 || h === 0 || h === PORTAL_FRAME_HEIGHT - 1
      const inInterior =
        w >= 1 && w <= PORTAL_INTERIOR_WIDTH && h >= 1 && h <= PORTAL_INTERIOR_HEIGHT
      const pos = axisPosition(origin, widthAxis, w, h)
      if (inInterior) {
        interior.push(pos)
      } else if (!onRing) {
        // unreachable by construction, kept for exhaustiveness
      } else if ((w === 0 || w === PORTAL_FRAME_WIDTH - 1) && (h === 0 || h === PORTAL_FRAME_HEIGHT - 1)) {
        corners.push(pos)
      } else {
        frame.push(pos)
      }
    }
  }
  const lightPosition = axisPosition(origin, widthAxis, 1, 1)
  return { origin, widthAxis, frame, corners, interior, lightPosition }
}

/**
 * The full cell footprint of a frame at `origin`: the ten required edge cells,
 * the four optional corners, and the interior. This is the cell set the portal
 * module contributes to the world model; it says nothing about WHY the
 * structure counts as live.
 */
export function portalFrameFootprint(
  origin: PortalBlockPosition,
  widthAxis: PortalWidthAxis = 'x',
): PortalBlockPosition[] {
  const layout = portalFrameLayout(origin, widthAxis)
  return [...layout.frame, ...layout.corners, ...layout.interior]
}

function portalFrameFootprintMembers(origin: PortalBlockPosition, widthAxis: PortalWidthAxis): LiveStructureMember[] {
  return portalFrameFootprint(origin, widthAxis).map((cell) => ({
    kind: 'nether_portal',
    position: { x: cell.x, y: cell.y, z: cell.z },
  }))
}

/**
 * The membership fact for a frame whose FULL required geometry validates. The
 * portal module's only responsibility here is the membership fact (which cells
 * the live structure occupies); the generic source-protection predicate in
 * `blockSafety.ts` owns the refusal and the candidate layer never learns the
 * word "portal".
 *
 * A `shape: 'bad'` validation contributes nothing on its own. Together with
 * `portalFrameCoreLiveStructureMembers` this implements the general liveness
 * predicate: a structure is live while its functional core is intact OR its
 * full required geometry validates.
 */
export function portalFrameLiveStructureMembers(frame: PortalFrameValidation): LiveStructureMember[] {
  if (frame.shape !== 'ok' || frame.origin === null) return []
  return portalFrameFootprintMembers(frame.origin, frame.widthAxis)
}

/**
 * The membership fact for a frame whose FUNCTIONAL CORE is intact even though
 * shell cells may be missing. For a Nether portal the core is its lit interior:
 * while `nether_portal` blocks fill the interior the portal is the live
 * structure the agent depends on, and a single mined edge must not empty its
 * membership (the defect where 10/10 -> 9/10 let the source guard collapse and
 * the agent finished dismantling its own gate).
 *
 * The core fact is supplied by the caller from LIVE world truth (the sensor's
 * `PortalFrameSite.coreIntact`); it is never persisted, so a portal that is
 * already broken/unlit contributes nothing here and its obsidian stays an
 * ordinary source (the legitimate-deconstruction case).
 */
export function portalFrameCoreLiveStructureMembers(
  origin: PortalBlockPosition,
  widthAxis: PortalWidthAxis = 'x',
): LiveStructureMember[] {
  return portalFrameFootprintMembers(origin, widthAxis)
}

export interface PortalFrameValidation {
  readonly shape: 'ok' | 'bad'
  /** number of obsidian blocks supplied (10..14 for a valid frame) */
  readonly blocks: number
  readonly reason: string
  readonly origin: PortalBlockPosition | null
  readonly widthAxis: PortalWidthAxis
  readonly interior: PortalBlockPosition[]
  /** where the portal would be lit; null when the shape is bad */
  readonly lightPosition: PortalBlockPosition | null
}

export interface PortalFrameInput {
  readonly blocks: readonly PortalBlockPosition[]
  readonly widthAxis?: PortalWidthAxis
}

function cellKey(pos: PortalBlockPosition): string {
  return `${pos.x}|${pos.y}|${pos.z}`
}

/**
 * Validate a candidate obsidian frame:
 *   * every block lies in one plane (same coordinate on the normal axis);
 *   * it spans exactly 4 wide x 5 tall;
 *   * all 10 required edge cells are present (corners optional);
 *   * no block sits in the 2x3 interior or outside the 4x5 rectangle;
 *   * no duplicate cells.
 * Returns `shape=ok` with the interior/light cell, or `shape=bad` with a reason.
 */
export function validatePortalFrame(input: PortalFrameInput): PortalFrameValidation {
  const widthAxis = input.widthAxis ?? 'x'
  const blocks = input.blocks
  const base: PortalFrameValidation = {
    shape: 'bad',
    blocks: blocks.length,
    reason: 'empty',
    origin: null,
    widthAxis,
    interior: [],
    lightPosition: null,
  }
  if (blocks.length === 0) return { ...base, reason: 'no_blocks' }

  const normalKey = widthAxis === 'x' ? 'z' : 'x'
  const widthKey = widthAxis === 'x' ? 'x' : 'z'
  const normal = blocks[0]?.[normalKey]
  if (normal === undefined) return { ...base, reason: 'no_blocks' }
  const seen = new Set<string>()
  for (const block of blocks) {
    if (block[normalKey] !== normal) return { ...base, reason: 'not_coplanar' }
    const key = cellKey(block)
    if (seen.has(key)) return { ...base, reason: 'duplicate_block' }
    seen.add(key)
  }

  let minW = Number.POSITIVE_INFINITY
  let maxW = Number.NEGATIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const block of blocks) {
    const w = block[widthKey]
    minW = Math.min(minW, w)
    maxW = Math.max(maxW, w)
    minY = Math.min(minY, block.y)
    maxY = Math.max(maxY, block.y)
  }
  if (maxW - minW !== PORTAL_FRAME_WIDTH - 1) return { ...base, reason: 'wrong_width' }
  if (maxY - minY !== PORTAL_FRAME_HEIGHT - 1) return { ...base, reason: 'wrong_height' }

  const origin: PortalBlockPosition =
    widthAxis === 'x'
      ? { x: minW, y: minY, z: normal }
      : { x: normal, y: minY, z: minW }
  const layout = portalFrameLayout(origin, widthAxis)
  const required = new Set(layout.frame.map(cellKey))
  const frameCells = new Set([...layout.frame, ...layout.corners].map(cellKey))
  const interiorCells = new Set(layout.interior.map(cellKey))

  for (const block of blocks) {
    const key = cellKey(block)
    if (interiorCells.has(key)) return { ...base, reason: 'interior_not_clear' }
    if (!frameCells.has(key)) return { ...base, reason: 'block_outside_frame' }
  }
  for (const key of required) {
    if (!seen.has(key)) return { ...base, reason: 'missing_edge_block' }
  }

  return {
    shape: 'ok',
    blocks: blocks.length,
    reason: '10 required edge blocks present; corners optional',
    origin,
    widthAxis,
    interior: layout.interior,
    lightPosition: layout.lightPosition,
  }
}

/** The exact required instrumentation line. */
export function formatPortalFrameReady(validation: PortalFrameValidation): string {
  return `${PORTAL_FRAME_READY} blocks=${validation.blocks} shape=${validation.shape}`
}

export function formatPortalBlockPlaced(pos: PortalBlockPosition): string {
  return `${PORTAL_BLOCK_PLACED} pos=${formatPos(pos)}`
}

/** Typed terminal cause for a batch that could not complete the 10-edge frame. */
export function formatFrameBuildIncomplete(input: {
  planned: number
  placed: number
  missing: readonly PortalBlockPosition[]
  actionId?: string
}): string {
  const cells = input.missing
    .slice(0, 4)
    .map(formatPos)
    .join(';')
  const action = input.actionId === undefined ? '' : ` actionId=${input.actionId}`
  return `${FRAME_BUILD_INCOMPLETE} planned=${input.planned} placed=${input.placed} missing=${input.missing.length} cells=${cells}${action}`
}

/** Typed terminal cause for a batch that maps to no 4x5 layout at all. */
export function formatFrameBuildUngrounded(planned: number, actionId?: string): string {
  const action = actionId === undefined ? '' : ` actionId=${actionId}`
  return `${FRAME_BUILD_UNGROUNDED} planned=${planned}${action}`
}

/** Typed terminal refusal: a frame cell is occupied by an unclearable block. */
export function formatFrameBuildBlocked(input: {
  cell: PortalBlockPosition
  block: string
  actionId?: string
}): string {
  const action = input.actionId === undefined ? '' : ` actionId=${input.actionId}`
  return `${FRAME_BUILD_BLOCKED} cell=${formatPos(input.cell)} block=${input.block}${action}`
}

/** Typed scan rejection: the best candidate origin and the rule that failed. */
export function formatPortalFrameSiteRejected(input: {
  origin: PortalBlockPosition
  widthAxis: PortalWidthAxis
  rule: string
  cell: PortalBlockPosition
  block: string
  existing: number
}): string {
  return `${PORTAL_FRAME_SITE_REJECTED} origin=${formatPos(input.origin)} axis=${input.widthAxis} rule=${input.rule} cell=${formatPos(input.cell)} block=${input.block} existing=${input.existing}`
}

export interface BlockPlacementStep {
  readonly item: string
  readonly cell: PortalBlockPosition
}

/** Deterministic support-friendly order: bottom-up, then width, then normal. */
export function orderedPlacementCells(cells: readonly PortalBlockPosition[]): PortalBlockPosition[] {
  return [...cells].sort((a, b) => a.y - b.y || a.x - b.x || a.z - b.z)
}

/** Compile "place N blocks of `item` at `cells`" into an ordered cell sequence. */
export function planBlockPlacements(item: string, cells: readonly PortalBlockPosition[]): BlockPlacementStep[] {
  return orderedPlacementCells(cells).map((cell) => ({ item, cell }))
}

/**
 * Determine whether the minimal frame sequence has a placement cell with no
 * natural or already-placed reference block. The executor may then place an
 * optional corner scaffold, but that action requires a held solid block.
 *
 * This is deliberately a pure geometry/affordance predicate. It does not
 * choose a scaffold item or a semantic Option; the candidate layer owns the
 * typed prerequisite route and the executor owns the actual placement.
 */
export function portalFrameNeedsTemporarySupport(
  origin: PortalBlockPosition,
  widthAxis: PortalWidthAxis = 'x',
  existingFrame: readonly PortalBlockPosition[] = [],
  solidAt: (position: PortalBlockPosition) => boolean = () => false,
): boolean {
  const layout = portalFrameLayout(origin, widthAxis)
  const occupied = new Set(existingFrame.map(cellKey))
  const neighbours = (cell: PortalBlockPosition): PortalBlockPosition[] => [
    { x: cell.x - 1, y: cell.y, z: cell.z },
    { x: cell.x + 1, y: cell.y, z: cell.z },
    { x: cell.x, y: cell.y - 1, z: cell.z },
    { x: cell.x, y: cell.y + 1, z: cell.z },
    { x: cell.x, y: cell.y, z: cell.z - 1 },
    { x: cell.x, y: cell.y, z: cell.z + 1 },
  ]

  for (const cell of orderedPlacementCells(layout.frame)) {
    if (occupied.has(cellKey(cell))) continue
    const referenceExists = neighbours(cell).some((neighbour) => occupied.has(cellKey(neighbour)) || solidAt(neighbour))
    if (!referenceExists) return true
    occupied.add(cellKey(cell))
  }
  return false
}

/** The executable frame-build sequence at `origin` (geometry from portalFrameLayout). */
export function portalFramePlacementSteps(
  origin: PortalBlockPosition,
  widthAxis: PortalWidthAxis = 'x',
  item: string = OBSIDIAN,
): BlockPlacementStep[] {
  return planBlockPlacements(item, portalFrameLayout(origin, widthAxis).frame)
}

/** The code-grounded frame site + ordered cells for an abstract build-the-frame goal. */
export interface PortalFrameGrounding {
  readonly origin: PortalBlockPosition
  readonly widthAxis: PortalWidthAxis
  readonly cells: PortalBlockPosition[]
  readonly temporarySupportRequired: boolean
}

export function groundPortalFrame(
  sites: readonly PortalFrameSite[] | readonly PortalBlockPosition[],
  self: PortalBlockPosition,
  widthAxis: PortalWidthAxis = 'x',
): PortalFrameGrounding | null {
  if (sites.length === 0) return null
  const normalized = sites.map((site) =>
    'origin' in site
      ? site
      : { origin: site, widthAxis, safe: true, reachable: true },
  )
  // Once a frame has been started, its continuation is the same grounded
  // physical operation. Prefer those sites over a fresh empty footprint so a
  // replan cannot silently abandon verified world work for a second frame.
  const continuation = normalized.filter((site) => (site.existingFrame?.length ?? 0) > 0)
  const selectable = continuation.length > 0 ? continuation : normalized
  const usable = selectable.filter((site) => site.safe !== false && site.reachable !== false)
  if (usable.length === 0) return null
  const dist = (site: PortalFrameSite): number => {
    const dx = site.origin.x - self.x
    const dy = site.origin.y - self.y
    const dz = site.origin.z - self.z
    return Math.sqrt(dx * dx + dy * dy + dz * dz)
  }
  usable.sort((a, b) => {
    // All continuation sites represent the same physical frame. Preserve the
    // greatest verified progress before distance, so a nearby one-cell false
    // footprint cannot steal execution from a seven-cell continuation.
    if (continuation.length > 0) {
      const aExisting = a.existingFrame?.length ?? 0
      const bExisting = b.existingFrame?.length ?? 0
      if (aExisting !== bExisting) return bExisting - aExisting
    }
    const da = dist(a)
    const db = dist(b)
    if (da !== db) return da - db
    if (a.origin.y !== b.origin.y) return a.origin.y - b.origin.y
    if (a.origin.x !== b.origin.x) return a.origin.x - b.origin.x
    if (a.origin.z !== b.origin.z) return a.origin.z - b.origin.z
    return a.widthAxis.localeCompare(b.widthAxis)
  })
  const selected = usable[0]
  if (selected === undefined) return null
  const selectedAxis = selected.widthAxis ?? widthAxis
  const layout = portalFrameLayout(selected.origin, selectedAxis)
  const existing = new Set((selected.existingFrame ?? []).map(cellKey))
  const missing = layout.frame.filter((cell) => !existing.has(cellKey(cell)))
  if (missing.length === 0) return null
  return {
    origin: selected.origin,
    widthAxis: selectedAxis,
    cells: orderedPlacementCells(missing),
    // Older persisted site records do not carry this optional fact. Treat
    // those records as the compatibility baseline; the live sensor populates
    // it on every newly observed site before candidate grounding.
    temporarySupportRequired: selected.temporarySupportRequired === true,
  }
}

/**
 * Recover the 4x5 layout a PARTIAL placement batch belongs to. Unlike
 * `validatePortalFrame`, this does not require the whole edge ring to be
 * present: it only requires every planned cell to be a frame edge. That is the
 * exact case where a build still needs a temporary scaffold (`ensurePortalFrameSupport`),
 * so requiring a complete frame there would make the support step unreachable.
 *
 * When several layouts contain the batch, the one with the most live obsidian
 * edges wins, so a continuation stays on the sensed frame instead of drifting to
 * a neighbouring empty footprint.
 */
export function partialPortalFrameLayout(
  plannedCells: readonly PortalBlockPosition[],
  widthAxis: PortalWidthAxis,
  obsidianAt: (position: PortalBlockPosition) => boolean = () => false,
): PortalFrameLayout | null {
  if (plannedCells.length === 0) return null
  let best: { layout: PortalFrameLayout; existing: number; distance: number } | null = null
  const seen = new Set<string>()
  for (const cell of plannedCells) {
    const width = widthAxis === 'x' ? cell.x : cell.z
    const normal = widthAxis === 'x' ? cell.z : cell.x
    for (let originWidth = width - (PORTAL_FRAME_WIDTH - 1); originWidth <= width; originWidth += 1) {
      for (let originY = cell.y - (PORTAL_FRAME_HEIGHT - 1); originY <= cell.y; originY += 1) {
        const origin =
          widthAxis === 'x'
            ? { x: originWidth, y: originY, z: normal }
            : { x: normal, y: originY, z: originWidth }
        const originKey = cellKey(origin)
        if (seen.has(originKey)) continue
        seen.add(originKey)
        const layout = portalFrameLayout(origin, widthAxis)
        const frame = new Set(layout.frame.map(cellKey))
        if (!plannedCells.every((planned) => frame.has(cellKey(planned)))) continue
        const existing = layout.frame.filter((frameCell) => obsidianAt(frameCell)).length
        const distance = plannedCells.reduce(
          (sum, planned) => sum + Math.hypot(planned.x - origin.x, planned.y - origin.y, planned.z - origin.z),
          0,
        )
        if (best === null || existing > best.existing || (existing === best.existing && distance < best.distance)) {
          best = { layout, existing, distance }
        }
      }
    }
  }
  return best?.layout ?? null
}

// ---------------------------------------------------------------------------
// safe site selection
// ---------------------------------------------------------------------------

export interface PortalSiteCandidate {
  readonly position: PortalBlockPosition
  readonly safe: boolean
  readonly reachable?: boolean
}

/**
 * Choose a reachable, safe site nearest to `self`. Deterministic: unsafe or
 * unreachable candidates are dropped, remaining candidates are ordered by
 * distance then y/x/z so the result never depends on input order.
 */
export function choosePortalSite(
  candidates: readonly PortalSiteCandidate[],
  self: PortalBlockPosition,
): PortalSiteCandidate | null {
  const usable = candidates.filter((candidate) => candidate.safe && candidate.reachable !== false)
  if (usable.length === 0) return null
  const dist = (candidate: PortalSiteCandidate): number => {
    const dx = candidate.position.x - self.x
    const dy = candidate.position.y - self.y
    const dz = candidate.position.z - self.z
    return Math.sqrt(dx * dx + dy * dy + dz * dz)
  }
  const sorted = [...usable].sort((a, b) => {
    const da = dist(a)
    const db = dist(b)
    if (da !== db) return da - db
    if (a.position.y !== b.position.y) return a.position.y - b.position.y
    if (a.position.x !== b.position.x) return a.position.x - b.position.x
    return a.position.z - b.position.z
  })
  return sorted[0] ?? null
}

// ---------------------------------------------------------------------------
// lighting + verification
// ---------------------------------------------------------------------------

export type LightPortalResult =
  | { readonly lit: true; readonly line: string; readonly position: PortalBlockPosition }
  | { readonly lit: false; readonly line: string; readonly reason: string }

export interface LightPortalInput {
  readonly frame: PortalFrameValidation
  readonly hasFlintAndSteel: boolean
  readonly dimension?: string
}

/**
 * Light a validated frame. A frame that fails shape validation is NEVER lit:
 * the result is a refusal line. Without flint_and_steel the decision is a
 * `PRECONDITION_MISSING tool=flint_and_steel` refusal.
 */
export function lightPortal(input: LightPortalInput): LightPortalResult {
  const dimension = input.dimension ?? OVERWORLD
  if (input.frame.shape !== 'ok' || input.frame.lightPosition === null) {
    return {
      lit: false,
      line: `${PORTAL_LIGHT_REFUSED} reason=frame_shape_bad shape=${input.frame.shape}`,
      reason: 'frame_shape_bad',
    }
  }
  if (!input.hasFlintAndSteel) {
    return { lit: false, line: `${PRECONDITION_MISSING} tool=${FLINT_AND_STEEL}`, reason: 'missing_tool' }
  }
  const pos = input.frame.lightPosition
  return { lit: true, line: `${PORTAL_LIT} pos=${formatPos(pos)} dimension=${dimension}`, position: pos }
}

export interface VerifyPortalInput {
  readonly lit: boolean
  readonly portalBlockPresent: boolean
  readonly dimension?: string
}

export interface VerifyPortalResult {
  readonly verified: boolean
  readonly line: string
}

/** Verify a lit portal by detecting the nether_portal block state. */
export function verifyPortal(input: VerifyPortalInput): VerifyPortalResult {
  const verified = input.lit && input.portalBlockPresent
  return { verified, line: `${PORTAL_VERIFIED}=${verified}` }
}

// ---------------------------------------------------------------------------
// live ignition decision (the executable half of `light:nether_portal`)
// ---------------------------------------------------------------------------

/** A grounded ignition candidate: the frame is valid and flint_and_steel is held. */
export interface PortalIgnitionCandidate {
  readonly id: string
  /** where flint_and_steel is used (the bottom interior cell) */
  readonly lightPosition: PortalBlockPosition
  /** the 2x3 interior cells that must become nether_portal after ignition */
  readonly portalCells: PortalBlockPosition[]
  readonly dimension: string
  readonly line: string
}

export type PortalIgnitionPlan =
  | { readonly ok: true; readonly candidate: PortalIgnitionCandidate }
  | { readonly ok: false; readonly refused: true; readonly reason: string; readonly line: string }

/**
 * Decide whether a frame may be lit RIGHT NOW. A malformed frame is refused with
 * `PORTAL_LIGHT_REFUSED`; a valid frame without flint_and_steel is refused with
 * `PRECONDITION_MISSING tool=flint_and_steel`. Only a valid frame plus the tool
 * yields the activation candidate, so no impossible ignition is ever offered.
 */
export function planPortalIgnition(input: LightPortalInput): PortalIgnitionPlan {
  const lighting = lightPortal(input)
  if (!lighting.lit) {
    return { ok: false, refused: true, reason: lighting.reason, line: lighting.line }
  }
  const portalCells = [...input.frame.interior]
  if (portalCells.length === 0) {
    return {
      ok: false,
      refused: true,
      reason: 'frame_shape_bad',
      line: `${PORTAL_LIGHT_REFUSED} reason=frame_shape_bad shape=${input.frame.shape}`,
    }
  }
  return {
    ok: true,
    candidate: {
      id: `IGNITE:${formatPos(lighting.position)}`,
      lightPosition: lighting.position,
      portalCells,
      dimension: input.dimension ?? OVERWORLD,
      line: lighting.line,
    },
  }
}

/** The live block name at a cell, or null when the cell is unloaded. */
export type PortalBlockLookup = (pos: PortalBlockPosition) => string | null

/** Strict ignition post-condition: every expected interior cell is nether_portal. */
export function isPortalIgnitionPostconditionMet(
  expectedCells: readonly PortalBlockPosition[],
  blockAt: PortalBlockLookup,
  expectedBlock: string = NETHER_PORTAL,
): boolean {
  if (expectedCells.length === 0) return false
  return expectedCells.every((cell) => blockAt(cell) === expectedBlock)
}

/**
 * Read the portal predicate from live world truth. `nether_portal` is a block,
 * not an inventory item that can be carried across a resident restart.
 */
export function detectPortalVerification(
  dimension: string | null | undefined,
  sites: readonly PortalFrameSite[],
  blockAt: PortalBlockLookup,
): boolean {
  if (dimension !== undefined && dimension !== null && normalizeDimension(dimension) !== normalizeDimension(OVERWORLD)) return false
  for (const site of sites) {
    const validation = validatePortalFrame({ blocks: site.existingFrame ?? [], widthAxis: site.widthAxis })
    if (validation.shape !== 'ok') continue
    if (isPortalIgnitionPostconditionMet(validation.interior, blockAt)) return true
  }
  return false
}

/** Encode the expected portal cells for a candidate's primitive-only `meta`. */
export function serializePortalCells(cells: readonly PortalBlockPosition[]): string {
  return cells.map(formatPos).join(';')
}

/** Decode the `meta.portalCells` encoding back into positions. Invalid parts are dropped. */
export function parsePortalCells(serialized: string): PortalBlockPosition[] {
  const cells: PortalBlockPosition[] = []
  for (const part of serialized.split(';')) {
    if (part.length === 0) continue
    const [rawX, rawY, rawZ] = part.split(',')
    const x = Number(rawX)
    const y = Number(rawY)
    const z = Number(rawZ)
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) cells.push({ x, y, z })
  }
  return cells
}

/** The `PORTAL_LIT` marker line for a lit frame, in the required dimension. */
export function formatPortalLit(position: PortalBlockPosition, dimension: string = OVERWORLD): string {
  return `${PORTAL_LIT} pos=${formatPos(position)} dimension=${dimension}`
}

// ---------------------------------------------------------------------------
// dimension transfer: walk into the lit portal and verify the dimension change
// ---------------------------------------------------------------------------

/**
 * Why entry was refused. Each is a mechanical fact read from the live world,
 * never a preference:
 *   - `portal_not_lit`      every interior cell was OBSERVED and at least one is
 *                           not `nether_portal`;
 *   - `no_safe_approach`    the interior was observed, but no passable,
 *                           supported, in-reach stand beside the portal exists,
 *                           so walking in is not mechanically feasible;
 *   - `already_in_dimension` the bot is already in the target dimension;
 *   - `site_not_observed`   the interior could not be observed from here (chunks
 *                           unloaded) AND no remembered frame geometry exists to
 *                           route to, so no approach can be grounded;
 *   - `no_known_site`       no portal site is sensed or remembered at all.
 *
 * `site_not_observed`/`no_known_site` exist because reporting `portal_not_lit`
 * with nothing examined was a FABRICATED world claim (live run-muc3qbug-18vg3:
 * the body 96 blocks from its own verified gate, the entry option active, and the
 * offer left with no portal route and a fresh `PRECONDITION_MISSING portal=lit`).
 */
export type PortalEntryRefusalReason =
  | 'portal_not_lit'
  | 'no_safe_approach'
  | 'already_in_dimension'
  | 'site_not_observed'
  | 'no_known_site'

/**
 * A grounded entry: the interior cell the body must occupy. There is deliberately
 * no bespoke approach/stand cell here: the walk INTO that cell is the ordinary
 * generic locomotion move every other destination uses, so this layer owns only
 * which interior cell is a valid entry (world truth), never how to reach it.
 */
export interface PortalEntryCandidate {
  readonly id: string
  /** the 2x3 interior cells that must all currently be `nether_portal` */
  readonly portalCells: PortalBlockPosition[]
  /** the standable interior cell the bot must occupy to trigger the transfer */
  readonly enterCell: PortalBlockPosition
  readonly dimension: string
  readonly line: string
  /**
   * true when the interior could NOT be observed from the offering position
   * (chunks unloaded) and the route targets REMEMBERED frame geometry instead.
   * The walk is still the ordinary locomotion move; the lit fact is re-verified
   * by the executor at arrival (its entry precondition), so an unverified route
   * can never transfer through an unlit frame - it fails typed instead.
   */
  readonly unverified?: boolean
}

export type PortalEntryPlan =
  | { readonly ok: true; readonly candidate: PortalEntryCandidate }
  | { readonly ok: false; readonly refused: true; readonly reason: PortalEntryRefusalReason; readonly line: string }

export interface PortalEntryInput {
  readonly site: PortalFrameSite
  readonly self: PortalBlockPosition
  readonly blockAt: PortalBlockLookup
  /**
   * The GENERIC locomotion standability predicate (feet + head passable, block
   * below solid) applied to a candidate interior cell. Supplied by the caller
   * from the same rule the terrain sensor and MOVE guard use, so the entry
   * cannot drift into its own passability/support geometry.
   */
  readonly isStandable: (cell: PortalBlockPosition) => boolean
  readonly fromDimension?: string
  readonly dimension?: string
}

/** The exact refusal line. Never silent. */
export function formatPortalEnterRefused(reason: PortalEntryRefusalReason, detail: string = ''): string {
  const suffix = detail.length === 0 ? '' : ` ${detail}`
  return `${PORTAL_ENTER_REFUSED} reason=${reason}${suffix}`
}

/**
 * The truthful refusal when NO portal site is sensed or remembered. Reporting
 * `PRECONDITION_MISSING portal=lit` with zero sites examined asserts a world
 * fact nobody checked; this names the actual missing affordance instead.
 */
export function formatPortalEntryNoKnownSite(): string {
  return `${PRECONDITION_MISSING} portal=site reason=no_known_site`
}

/**
 * Why the entry APPROACH cannot be completed: the generic locomotion walk was
 * refused and the shared dig/vertical route machinery could not open the way
 * either. This is a typed, stable reason so the option can be abandoned after a
 * bounded number of identical failures instead of re-arming an unreachable
 * `pathTo` forever:
 *   - `no_route`          the offering layer found no grounded vertical plan
 *                         for the entry cell (nothing to climb, nothing to dig);
 *   - `route_blocked`     a grounded plan existed but its leg could not dig or
 *                         step (unbreakable face, protected block, lost support);
 *   - `budget_exhausted`  the walk consumed its path budget with no route and no
 *                         durable body change.
 * `detail` may name the obstruction (for example the ascent refusal reason).
 */
export type PortalEntryRouteBlockedReason = 'no_route' | 'route_blocked' | 'budget_exhausted'

export interface PortalEntryRouteBlockedInput {
  readonly reason: PortalEntryRouteBlockedReason
  readonly entryCell: PortalBlockPosition
  readonly fromY: number
  readonly toY: number
  readonly detail?: string
}

/** The exact `PORTAL_ENTRY_ROUTE_BLOCKED` line: the obstruction, named. */
export function formatPortalEntryRouteBlocked(input: PortalEntryRouteBlockedInput): string {
  const detail = input.detail === undefined || input.detail.length === 0 ? '' : ` detail=${input.detail}`
  return (
    `PORTAL_ENTRY_ROUTE_BLOCKED reason=${input.reason}` +
    ` entry=${formatPos(input.entryCell)} from_y=${input.fromY} to_y=${input.toY}${detail}`
  )
}

/** The exact `PORTAL_ENTERED` line. */
export function formatPortalEntered(enterCell: PortalBlockPosition, dimension: string = NETHER): string {
  return `${PORTAL_ENTERED} pos=${formatPos(enterCell)} dimension=${dimension}`
}

/**
 * Why the bounded direct walk did not run. Every reason is a live-world fact
 * read BEFORE any movement:
 *   * `out_of_range`         the body is not beside the gate (no walk considered);
 *   * `not_level`            the interior is more than one block from the feet;
 *   * `cell_not_traversable` the destination is not a non-solid portal cell
 *                            (never walk into rock);
 *   * `approach_occluded`    the straight approach is a 2-high frame face the
 *                            body cannot step over: it needs an open-face leg;
 *   * `no_support`           a step-up target has no floor under it (never step
 *                            up into a hole);
 *   * `hazard_at_body`       the body already stands in lava/fire/water;
 *   * `hazard_between`       a hazard cell lies on the walk to the interior.
 */
export type PortalWalkInRefusal =
  | 'out_of_range'
  | 'not_level'
  | 'cell_not_traversable'
  | 'approach_occluded'
  | 'no_support'
  | 'hazard_at_body'
  | 'hazard_between'

export interface PortalWalkInInput {
  readonly cell: PortalBlockPosition
  readonly fromD: number
  readonly toD: number
  readonly transferred: boolean
}

/** The exact `PORTAL_WALK_IN` line: the measured motion of the direct walk. */
export function formatPortalWalkIn(input: PortalWalkInInput): string {
  return (
    `${PORTAL_WALK_IN} cell=${formatPos(input.cell)}` +
    ` from_d=${round2(input.fromD)} to_d=${round2(input.toD)} transferred=${input.transferred}`
  )
}

/** The exact `PORTAL_WALK_IN_REFUSED` line: no movement, typed reason. */
export function formatPortalWalkInRefused(
  cell: PortalBlockPosition,
  fromD: number,
  refusal: PortalWalkInRefusal,
): string {
  return `${PORTAL_WALK_IN_REFUSED} cell=${formatPos(cell)} from_d=${round2(fromD)} reason=${refusal}`
}

/**
 * The bounded step-aside leg onto an OPEN face of the portal: the straight
 * approach to the interior is blocked by a frame column, so the body must first
 * stand on a cell beside the interior at its own level and walk in from there.
 * The line names the intermediate cell so the run log shows the detour, never
 * only its absence.
 */
export const PORTAL_APPROACH_LEG = 'PORTAL_APPROACH_LEG'
/** No open-face leg could be grounded; the typed reason names why. */
export const PORTAL_APPROACH_REFUSED = 'PORTAL_APPROACH_REFUSED'

export type PortalApproachRefusal = 'no_open_face' | 'unreachable' | 'multiple_open_faces'

/**
 * A step-aside onto an open face is a SHORT move, not a travel leg: both layers
 * (the candidate's offer and the executor's own leg) use this same bound.
 */
export const PORTAL_OPEN_FACE_MAX_DISTANCE = 4

export interface PortalApproachLegInput {
  readonly cell: PortalBlockPosition
  readonly target: PortalBlockPosition
  readonly fromD: number
  readonly toD: number
}

/** The exact `PORTAL_APPROACH_LEG` line: the stand cell the body reached. */
export function formatPortalApproachLeg(input: PortalApproachLegInput): string {
  return (
    `${PORTAL_APPROACH_LEG} cell=${formatPos(input.cell)} target=${formatPos(input.target)}` +
    ` from_d=${round2(input.fromD)} to_d=${round2(input.toD)}`
  )
}

/** The exact `PORTAL_APPROACH_REFUSED` line. */
export function formatPortalApproachRefused(
  target: PortalBlockPosition,
  fromD: number,
  refusal: PortalApproachRefusal,
): string {
  return `${PORTAL_APPROACH_REFUSED} target=${formatPos(target)} from_d=${round2(fromD)} reason=${refusal}`
}

// ---------------------------------------------------------------------------
// Issue #436 "Reflex + Skill closure": every executed Skill states its own
// boundary, and a mechanically MANDATORY prerequisite that code finishes on the
// already-selected target's behalf is logged as a REFLEX carrying the geometry
// that proved it was the ONLY continuation. The governing rule, stated once:
//
//   code may execute a uniquely-determined safety/mechanical prerequisite;
//   if multiple semantically meaningful alternatives remain, return to Jev.
//
// A silent extra action is exactly what this vocabulary forbids: the run log
// must let a reviewer tell "Jev chose the target" (SKILL_START selectedBy=jev)
// from "code finished that choice" (REFLEX ... reason=unique_binding_prerequisite).
// ---------------------------------------------------------------------------
export const SKILL_START = 'SKILL_START'
export const SKILL_STEP = 'SKILL_STEP'
export const SKILL_INTERRUPT = 'SKILL_INTERRUPT'
export const SKILL_END = 'SKILL_END'
export const REFLEX = 'REFLEX'

/** The entry Skill's stable id (the `skill` / `ownerSkill` field). */
export const PORTAL_ENTER_SKILL = 'ENTER_PORTAL(portalSite)'

/** Who selected the target this Skill executes (never a per-tick motor choice). */
export type SkillSelectionSource = 'jev' | 'system2-derived' | 'hard-safety'

export function formatSkillStart(
  skill: string,
  selectedBy: SkillSelectionSource,
  params: string,
): string {
  return `${SKILL_START} skill=${skill} selectedBy=${selectedBy} params=${params}`
}

export function formatSkillStep(skill: string, step: string, detail: string = ''): string {
  return `${SKILL_STEP} skill=${skill} step=${step}${detail.length === 0 ? '' : ` ${detail}`}`
}

export function formatSkillInterrupt(skill: string, reason: string): string {
  return `${SKILL_INTERRUPT} skill=${skill} reason=${reason}`
}

export function formatSkillEnd(
  skill: string,
  execution: string,
  verification: string,
  postcondition: string,
  failure: string | null = null,
): string {
  return (
    `${SKILL_END} skill=${skill} execution=${execution} verification=${verification} postcondition=${postcondition}` +
    (failure === null || failure.length === 0 ? '' : ` failure=${failure}`)
  )
}

export interface ReflexInput {
  readonly ownerSkill: string
  /** what code did (a bounded mechanical continuation, never a new destination) */
  readonly action: string
  /** the block/geometry fact that proved the continuation was the only one */
  readonly evidence: string
}

/** The exact `REFLEX` line: a uniquely-determined prerequisite, with its proof. */
export function formatReflex(input: ReflexInput): string {
  return (
    `${REFLEX} ownerSkill=${input.ownerSkill} reason=unique_binding_prerequisite` +
    ` action=${input.action} evidence=${input.evidence}`
  )
}

/**
 * The portal's OPEN approach cells, derived from STRUCTURE truth and never from
 * the plan's wording: a cell horizontally beside an interior cell at the
 * interior's standing level, outside the frame ring (a frame column is solid and
 * therefore not standable) and standable for a 1.8-tall body. `isStandable` is
 * the caller's own truth source (the live bot's block grid, or the sensed
 * terrain list), so both layers share ONE geometric rule. Nearest to `from`
 * first and bounded by `maxDistance`.
 */
export function portalOpenFaceCells(
  interiorCells: readonly PortalBlockPosition[],
  standingLevel: number,
  isStandable: (cell: PortalBlockPosition) => boolean,
  from: PortalBlockPosition,
  maxDistance: number,
): PortalBlockPosition[] {
  const found = new Map<string, PortalBlockPosition>()
  for (const interior of interiorCells) {
    if (interior.y !== standingLevel) continue
    for (const dir of [
      { x: 1, z: 0 },
      { x: -1, z: 0 },
      { x: 0, z: 1 },
      { x: 0, z: -1 },
    ]) {
      const spot: PortalBlockPosition = { x: interior.x + dir.x, y: interior.y, z: interior.z + dir.z }
      const key = formatPos(spot)
      if (found.has(key)) continue
      // The interior itself is never an approach cell, and a cell outside the
      // body's reach of the gate is not a step aside.
      if (interiorCells.some((cell) => formatPos(cell) === key)) continue
      if (Math.hypot(spot.x + 0.5 - (from.x + 0.5), spot.z + 0.5 - (from.z + 0.5)) > maxDistance) continue
      if (!isStandable(spot)) continue
      found.set(key, spot)
    }
  }
  return [...found.values()].sort(
    (left, right) =>
      Math.hypot(left.x + 0.5 - (from.x + 0.5), left.z + 0.5 - (from.z + 0.5)) -
      Math.hypot(right.x + 0.5 - (from.x + 0.5), right.z + 0.5 - (from.z + 0.5)),
  )
}

/** The exact `PORTAL_ENTRY_UNVERIFIED` line: a remembered-site route, no lit claim. */
export function formatPortalEntryUnverified(
  site: PortalBlockPosition,
  enterCell: PortalBlockPosition,
  dimension: string = NETHER,
): string {
  return `${PORTAL_ENTRY_UNVERIFIED} reason=site_not_observed site=${formatPos(site)} enter=${formatPos(enterCell)} dimension=${dimension}`
}

/**
 * Decide whether the lit portal at `site` may be entered RIGHT NOW. Every
 * precondition is a live-world fact and every failure is a typed refusal:
 *   * a portal whose 2x3 interior is not fully `nether_portal` is refused with
 *     `PRECONDITION_MISSING portal=lit` - the bot must never walk at a frame
 *     that is not actually lit;
 *   * a lit portal with no interior cell a 1.8-tall body can stand in (both body
 *     rows `nether_portal`, solid support below, proven by the generic
 *     standability rule) is refused with
 *     `PRECONDITION_MISSING approach=safe_stand`; the body cannot occupy a cell
 *     it cannot stand in, so no entry is mechanically feasible;
 *   * a bot already in the destination dimension is refused as
 *     `already_in_dimension` (nothing to transfer).
 * Only then is an entry candidate emitted. Geometry/precondition only: this
 * never chooses WHEN to enter, never ranks one portal against another, and never
 * plans the walk (the executor uses the ordinary generic locomotion move to
 * `enterCell`; standing in a portal block is the world mechanic that transfers).
 *
 * When the interior blocks cannot be READ (a remembered durable site whose chunks
 * are unloaded) the function must not claim `portal_not_lit` - that is a world
 * fact nobody checked. If the site carries remembered frame geometry it emits the
 * same entry candidate marked `unverified`, so "walk back to your remembered gate"
 * is a real route and the executor's arrival precondition owns the lit check. With
 * no observed interior and no remembered geometry the refusal is
 * `site_not_observed`; with no site at all the caller reports `no_known_site`.
 */
export function planPortalEntry(input: PortalEntryInput): PortalEntryPlan {
  const dimension = input.dimension ?? NETHER
  const fromDimension = input.fromDimension ?? OVERWORLD
  if (normalizeDimension(fromDimension) === normalizeDimension(dimension)) {
    return {
      ok: false,
      refused: true,
      reason: 'already_in_dimension',
      line: formatPortalEnterRefused('already_in_dimension', `dimension=${fromDimension}`),
    }
  }
  const layout = portalFrameLayout(input.site.origin, input.site.widthAxis)
  const portalCells = layout.interior
  const observed = portalCells.map((cell) => input.blockAt(cell))
  if (observed.some((name) => name === null)) {
    // Unobserved interior: do not assert lit-ness either way.
    if ((input.site.existingFrame?.length ?? 0) === 0) {
      return {
        ok: false,
        refused: true,
        reason: 'site_not_observed',
        line: formatPortalEnterRefused('site_not_observed', `site=${formatPos(input.site.origin)}`),
      }
    }
    const rows = [...portalCells].sort((a, b) => a.y - b.y || entryDistance(a, input.self) - entryDistance(b, input.self))
    const enterCell = rows[0]
    if (enterCell === undefined) {
      return {
        ok: false,
        refused: true,
        reason: 'site_not_observed',
        line: formatPortalEnterRefused('site_not_observed', `site=${formatPos(input.site.origin)}`),
      }
    }
    return {
      ok: true,
      candidate: {
        id: `ENTER:${formatPos(enterCell)}`,
        portalCells: [...portalCells],
        enterCell,
        dimension,
        unverified: true,
        line: `${formatPortalEntryUnverified(input.site.origin, enterCell, dimension)} expected=${portalCells.length}`,
      },
    }
  }
  const lit = observed.every((name) => name === NETHER_PORTAL)
  if (!lit) {
    return {
      ok: false,
      refused: true,
      reason: 'portal_not_lit',
      line: `${PRECONDITION_MISSING} portal=lit`,
    }
  }

  // The 1.8-tall body occupies two rows: both must be portal blocks, and the
  // generic locomotion layer must prove the feet cell standable. The lowest
  // interior row qualifies (its block below is the frame's solid bottom); a
  // higher row does not, because the block below it is itself portal, not
  // support. Getting INTO that cell may need one step up from the ground in
  // front of the frame - that is the generic mover's job, not this layer's.
  const entryCells = portalCells.filter(
    (cell) =>
      input.blockAt({ x: cell.x, y: cell.y + 1, z: cell.z }) === NETHER_PORTAL && input.isStandable(cell),
  )
  if (entryCells.length === 0) {
    return {
      ok: false,
      refused: true,
      reason: 'no_safe_approach',
      line: `${PRECONDITION_MISSING} approach=safe_stand`,
    }
  }
  entryCells.sort((a, b) => {
    const da = entryDistance(a, input.self)
    const db = entryDistance(b, input.self)
    if (da !== db) return da - db
    if (a.y !== b.y) return a.y - b.y
    if (a.x !== b.x) return a.x - b.x
    return a.z - b.z
  })
  const enterCell = entryCells[0]
  if (enterCell === undefined) {
    return {
      ok: false,
      refused: true,
      reason: 'no_safe_approach',
      line: `${PRECONDITION_MISSING} approach=safe_stand`,
    }
  }
  return {
    ok: true,
    candidate: {
      id: `ENTER:${formatPos(enterCell)}`,
      portalCells: [...portalCells],
      enterCell,
      dimension,
      line: formatPortalEntered(enterCell, dimension),
    },
  }
}

function entryDistance(cell: PortalBlockPosition, self: PortalBlockPosition): number {
  return Math.hypot(cell.x + 0.5 - self.x, cell.y - self.y, cell.z + 0.5 - self.z)
}

// ---------------------------------------------------------------------------
// typed plan -> PlannedGoal compiler (#19 compatibility)
// ---------------------------------------------------------------------------

/**
 * Compile a portal step into the existing typed `PlannedGoal` kinds. The
 * `light`/`verify` operations are executor sub-steps of the ONE `place
 * nether_portal` ignition action: both compile to the same goal, carrying
 * `PORTAL_LIT_PREDICATE`, so the GoalQueue dedups them and the IGNITE executor
 * owns lighting AND its verification post-condition.
 */
export function portalStepToPlannedGoal(step: PortalStep): PlannedGoal {
  const flags = {
    ...(step.protected === true ? { protected: true } : {}),
    ...(step.core === true ? { core: true } : {}),
  }
  switch (step.kind) {
    case 'collect':
      return { kind: 'collect', description: step.description, targetItem: step.item, requiredCount: step.count, ...flags }
    case 'craft':
      return { kind: 'craft', description: step.description, targetItem: step.item, requiredCount: step.count, ...flags }
    case 'smelt':
      return { kind: 'smelt', description: step.description, targetItem: step.item, requiredCount: step.count, ...flags }
    case 'build_portal_frame': {
      const cells =
        step.origin === undefined
          ? undefined
          : portalFramePlacementSteps(step.origin, step.widthAxis ?? 'x').map((entry) => entry.cell)
      return {
        kind: 'place',
        description: step.description,
        targetItem: OBSIDIAN,
        requiredCount: cells?.length ?? step.blocks,
        ...(cells === undefined ? {} : { placementCells: cells }),
        ...flags,
      }
    }
    case 'light_portal':
      return {
        kind: 'place',
        description: step.description,
        targetItem: NETHER_PORTAL,
        requiredCount: 1,
        targetPredicate: PORTAL_LIT_PREDICATE,
        dimension: step.postcondition.kind === 'portalLit' ? step.postcondition.dimension : OVERWORLD,
        ...flags,
      }
    case 'verify_portal':
      return {
        kind: 'place',
        description: step.description,
        targetItem: NETHER_PORTAL,
        requiredCount: 1,
        targetPredicate: PORTAL_LIT_PREDICATE,
        dimension: step.dimension,
        ...flags,
      }
    case 'enter_portal':
      // The transfer is a `place nether_portal` goal under a DIFFERENT predicate
      // than ignition: the queue's completion check is the `dimensionIs` truth,
      // never an item count (`nether_portal` cannot be carried).
      return {
        kind: 'place',
        description: step.description,
        targetItem: NETHER_PORTAL,
        requiredCount: 1,
        targetPredicate: PORTAL_ENTERED_PREDICATE,
        dimension: step.dimension,
        ...flags,
      }
  }
}

export function portalStepsToPlannedGoals(steps: readonly PortalStep[]): PlannedGoal[] {
  return steps.map((step) => portalStepToPlannedGoal(step))
}

// ---------------------------------------------------------------------------
// grounded prerequisite envelope (mechanical dependencies, #12/#73 generalization)
// ---------------------------------------------------------------------------

export interface NetherPortalPlanInput {
  readonly inventory: Readonly<Record<string, number>>
  readonly toolRank: number
  readonly sites?: readonly PortalSiteCandidate[]
  readonly self?: PortalBlockPosition
  readonly dimension?: string
  /** Required frame edge blocks already proven by a live world sensor. */
  readonly existingFrameBlocks?: number
}

export interface NetherPortalPlan {
  /** typed prerequisite steps, in dependency order */
  readonly prerequisites: PortalStep[]
  /** the portal operations themselves: build -> light -> verify */
  readonly operations: PortalStep[]
  /** prerequisites then operations */
  readonly steps: PortalStep[]
  /** the queue-expressible typed goals (prerequisites + the place operation) */
  readonly goals: PlannedGoal[]
  /** true when no prerequisite step was needed */
  readonly ready: boolean
  readonly site: PortalSiteCandidate | null
}

function count(inventory: Readonly<Record<string, number>>, item: string): number {
  return inventory[item] ?? 0
}

/**
 * Build the typed Nether-portal grounding from a live inventory snapshot.
 * Missing materials expose code-proven prerequisite affordances (flint/iron/
 * diamond) so Mercury/System2 and Jev can select productive work instead of
 * receiving an impossible obsidian claim. The dependency order is mechanical
 * data, not a semantic ranking or an authoritative plan choice.
 */
export function planNetherPortal(input: NetherPortalPlanInput): NetherPortalPlan {
  const inventory = input.inventory
  const dimension = input.dimension ?? OVERWORLD
  const prerequisites: PortalStep[] = []

  const obsidianRank = obsidianRequiredPickaxeRank()
  const hasDiamondPickaxe = input.toolRank >= DIAMOND_PICKAXE_RANK || count(inventory, DIAMOND_PICKAXE) > 0
  const hasIronPickaxe = input.toolRank >= IRON_PICKAXE_RANK || count(inventory, IRON_PICKAXE) > 0

  const ironIngots = count(inventory, IRON_INGOT)
  const rawIron = count(inventory, RAW_IRON)
  const diamond = count(inventory, DIAMOND)
  const flint = count(inventory, FLINT)
  const flintAndSteel = count(inventory, FLINT_AND_STEEL)
  const obsidian = count(inventory, OBSIDIAN)
  const existingFrameBlocks = Math.max(
    0,
    Math.min(PORTAL_OBSIDIAN_REQUIRED, Math.floor(input.existingFrameBlocks ?? 0)),
  )

  const ironNeededForPickaxe = hasIronPickaxe ? 0 : 3
  const ironNeededForSteel = flintAndSteel < 1 ? 1 : 0
  const ironIngotsNeeded = Math.max(ironNeededForPickaxe, ironNeededForSteel)
  const ironShortfall = Math.max(0, ironIngotsNeeded - ironIngots)
  const rawIronNeeded = Math.max(0, ironShortfall - rawIron)

  // 1. raw iron (smelt input), dependency of every iron_ingot step
  if (rawIronNeeded > 0) {
    prerequisites.push({
      kind: 'collect',
      capabilityId: 'collect:raw_iron',
      description: `collect ${rawIronNeeded} x ${RAW_IRON}`,
      item: RAW_IRON,
      count: rawIronNeeded,
      postcondition: { kind: 'inventoryAtLeast', item: RAW_IRON, count: rawIron + rawIronNeeded },
      protected: true,
    })
  }
  // 2. iron ingots (pickaxe + flint_and_steel)
  if (ironShortfall > 0) {
    prerequisites.push({
      kind: 'smelt',
      capabilityId: 'smelt:iron_ingot',
      description: `smelt ${ironShortfall} x ${IRON_INGOT}`,
      item: IRON_INGOT,
      count: ironShortfall,
      postcondition: { kind: 'inventoryAtLeast', item: IRON_INGOT, count: ironIngots + ironShortfall },
      protected: true,
    })
  }
  // 3. flint (from gravel) before flint_and_steel
  if (flintAndSteel < 1 && flint < 1) {
    prerequisites.push({
      kind: 'collect',
      capabilityId: 'collect:flint',
      description: `collect 1 x ${FLINT} (from gravel)`,
      item: FLINT,
      count: 1,
      postcondition: { kind: 'inventoryAtLeast', item: FLINT, count: 1 },
      protected: true,
    })
  }
  // 4. flint_and_steel
  if (flintAndSteel < 1) {
    prerequisites.push({
      kind: 'craft',
      capabilityId: 'craft:flint_and_steel',
      description: `craft 1 x ${FLINT_AND_STEEL}`,
      item: FLINT_AND_STEEL,
      count: 1,
      postcondition: { kind: 'inventoryAtLeast', item: FLINT_AND_STEEL, count: 1 },
      protected: true,
    })
  }
  // 5. iron pickaxe (stone_pickaxe -> iron_pickaxe -> diamond_pickaxe chain)
  if (!hasIronPickaxe) {
    prerequisites.push({
      kind: 'craft',
      capabilityId: 'craft:iron_pickaxe',
      description: `craft 1 x ${IRON_PICKAXE}`,
      item: IRON_PICKAXE,
      count: 1,
      postcondition: { kind: 'toolRankAtLeast', rank: IRON_PICKAXE_RANK },
      protected: true,
    })
  }
  // 6. diamonds for the diamond pickaxe
  if (!hasDiamondPickaxe && diamond < 3) {
    prerequisites.push({
      kind: 'collect',
      capabilityId: 'collect:diamond',
      description: `collect ${3 - diamond} x ${DIAMOND}`,
      item: DIAMOND,
      count: 3 - diamond,
      requiredPickaxeRank: IRON_PICKAXE_RANK,
      postcondition: { kind: 'inventoryAtLeast', item: DIAMOND, count: 3 },
      protected: true,
    })
  }
  // 7. diamond pickaxe (required to mine obsidian)
  if (!hasDiamondPickaxe) {
    prerequisites.push({
      kind: 'craft',
      capabilityId: 'craft:diamond_pickaxe',
      description: `craft 1 x ${DIAMOND_PICKAXE}`,
      item: DIAMOND_PICKAXE,
      count: 1,
      postcondition: { kind: 'toolRankAtLeast', rank: obsidianRank },
      protected: true,
      core: true,
    })
  }
  // 8. obsidian (mined only with the diamond pickaxe; the mining decision is gated)
  const obsidianNeeded = Math.max(0, PORTAL_OBSIDIAN_REQUIRED - existingFrameBlocks - obsidian)
  if (obsidianNeeded > 0) {
    prerequisites.push({
      kind: 'collect',
      capabilityId: 'collect:obsidian',
      description: `mine ${obsidianNeeded} x ${OBSIDIAN} with ${DIAMOND_PICKAXE}`,
      item: OBSIDIAN,
      count: obsidianNeeded,
      requiredPickaxeRank: obsidianRank,
      postcondition: { kind: 'inventoryAtLeast', item: OBSIDIAN, count: obsidian + obsidianNeeded },
      protected: true,
      core: true,
    })
  }

  const site =
    input.sites === undefined || input.sites.length === 0
      ? null
      : choosePortalSite(input.sites, input.self ?? { x: 0, y: 0, z: 0 })

  const operations: PortalStep[] = [
    {
      kind: 'build_portal_frame',
      capabilityId: 'build:nether_portal_frame',
      description: `build the ${PORTAL_FRAME_WIDTH}x${PORTAL_FRAME_HEIGHT} obsidian portal frame (${PORTAL_OBSIDIAN_REQUIRED} blocks)`,
      width: PORTAL_FRAME_WIDTH,
      height: PORTAL_FRAME_HEIGHT,
      blocks: PORTAL_OBSIDIAN_REQUIRED,
      ...(site === null ? {} : { origin: site.position, widthAxis: 'x' as const }),
      postcondition: { kind: 'frameShapeOk' },
      core: true,
    },
    {
      kind: 'light_portal',
      capabilityId: 'light:nether_portal',
      description: `light the portal with ${FLINT_AND_STEEL}`,
      tool: FLINT_AND_STEEL,
      postcondition: { kind: 'portalLit', dimension },
      core: true,
    },
    {
      kind: 'verify_portal',
      capabilityId: 'verify:nether_portal',
      description: 'verify the lit nether_portal block in the overworld',
      dimension,
      postcondition: { kind: 'portalVerified' },
      core: true,
    },
  ]

  const steps = [...prerequisites, ...operations]
  return {
    prerequisites,
    operations,
    steps,
    goals: portalStepsToPlannedGoals(steps),
    ready: prerequisites.length === 0,
    site,
  }
}

/**
 * Grounding helper: typed goals a `nether_portal` rung may expose to the
 * Option/Jev path. The caller retains semantic choice authority.
 */
export function netherPortalRungGoals(
  inventory: Readonly<Record<string, number>>,
  toolRank: number,
  dimension: string = OVERWORLD,
  existingFrameBlocks: number = 0,
): PlannedGoal[] {
  return planNetherPortal({ inventory, toolRank, dimension, existingFrameBlocks }).goals
}

/**
 * The typed goal for the dimension transfer, exposed beside the other portal
 * operations so a ladder/planner can request it. This does NOT append entry to
 * `planNetherPortal`'s operation order: when to enter stays a caller decision
 * (root AGENTS.md section 8: code owns CAN/TRUE/SAFE/DONE, not WHAT NEXT).
 */
export function netherPortalEntryGoal(dimension: string = NETHER): PlannedGoal {
  return portalStepToPlannedGoal({
    kind: 'enter_portal',
    capabilityId: 'enter:nether_portal',
    description: `enter the lit nether portal and transfer to ${dimension}`,
    dimension,
    postcondition: { kind: 'dimensionIs', dimension },
    core: true,
  })
}

// ---------------------------------------------------------------------------
// end-to-end simulation (frame -> light -> verify)
// ---------------------------------------------------------------------------

export interface PortalSimulationInput {
  readonly inventory: Readonly<Record<string, number>>
  readonly toolRank: number
  readonly dimension?: string
  /**
   * Pre-placed obsidian blocks. When omitted the simulation mines (gated on the
   * diamond pickaxe) and builds the minimal 10-block frame at `site`.
   */
  readonly frame?: readonly PortalBlockPosition[]
  readonly frameWidthAxis?: PortalWidthAxis
  readonly site?: PortalBlockPosition
  /** Default: whether the inventory holds flint_and_steel. */
  readonly hasFlintAndSteel?: boolean
  /** Default true: the lit nether_portal is detectable. */
  readonly detectPortalBlock?: boolean
}

export interface PortalSimulationResult {
  readonly logs: string[]
  readonly frame: PortalFrameValidation
  readonly miningAttempted: boolean
  readonly miningRefused: boolean
  readonly lit: boolean
  readonly verified: boolean
  readonly lightPosition: PortalBlockPosition | null
}

/**
 * Deterministic, in-memory execution of the portal path. This is the unit-test
 * harness: it proves the ordering (mine gate -> frame validate -> light -> verify)
 * and that a bad frame is never lit, with no bot and no clock.
 */
export function simulatePortalPlan(input: PortalSimulationInput): PortalSimulationResult {
  const logs: string[] = []
  const emit = (line: string): void => {
    logs.push(line)
  }
  const dimension = input.dimension ?? OVERWORLD

  const mining = planObsidianMining(input.toolRank, PORTAL_OBSIDIAN_REQUIRED)
  emit(mining.line)

  let validation: PortalFrameValidation
  if (input.frame !== undefined) {
    validation = validatePortalFrame({ blocks: input.frame, ...(input.frameWidthAxis === undefined ? {} : { widthAxis: input.frameWidthAxis }) })
  } else if (!mining.attempted) {
    validation = validatePortalFrame({ blocks: [] })
  } else {
    const origin = input.site ?? { x: 0, y: 64, z: 0 }
    const layout = portalFrameLayout(origin, input.frameWidthAxis ?? 'x')
    for (const block of layout.frame) emit(formatPortalBlockPlaced(block))
    validation = validatePortalFrame({ blocks: layout.frame, widthAxis: layout.widthAxis })
  }
  emit(formatPortalFrameReady(validation))

  let lit = false
  let verified = false
  let lightPosition: PortalBlockPosition | null = null
  if (validation.shape === 'ok') {
    const hasFlintAndSteel = input.hasFlintAndSteel ?? (input.inventory[FLINT_AND_STEEL] ?? 0) > 0
    const lighting = lightPortal({ frame: validation, hasFlintAndSteel, dimension })
    emit(lighting.line)
    if (lighting.lit) {
      lit = true
      lightPosition = lighting.position
      const verification = verifyPortal({
        lit: true,
        portalBlockPresent: input.detectPortalBlock ?? true,
        dimension,
      })
      verified = verification.verified
      emit(verification.line)
    }
  }

  return {
    logs,
    frame: validation,
    miningAttempted: mining.attempted,
    miningRefused: !mining.attempted,
    lit,
    verified,
    lightPosition,
  }
}
