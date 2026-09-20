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

/**
 * The queue-level predicate that names the ignition operation. Both the
 * `light:nether_portal` and `verify:nether_portal` capability steps compile to a
 * `place nether_portal` goal carrying this predicate, so a queue dedups them
 * into ONE ignition action whose executor post-condition IS the verification.
 */
export const PORTAL_LIT_PREDICATE = 'portal_lit'

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
}

function normalizeDimension(dimension: string): string {
  return dimension.replace(/^minecraft:/, '').toLowerCase()
}

function formatPos(pos: PortalBlockPosition): string {
  return `${pos.x},${pos.y},${pos.z}`
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

/** The typed plan kind of a portal step. */
export type PortalStepKind =
  | 'collect'
  | 'craft'
  | 'smelt'
  | 'build_portal_frame'
  | 'light_portal'
  | 'verify_portal'

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

export type PortalStep =
  | PortalCollectStep
  | PortalCraftStep
  | PortalSmeltStep
  | PortalBuildFrameStep
  | PortalLightStep
  | PortalVerifyStep

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
      record.kind === 'verify_portal') &&
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
  const chosen = choosePortalSite(
    selectable.map((site) => ({ position: site.origin, safe: site.safe !== false, reachable: site.reachable !== false })),
    self,
  )
  if (chosen === null) return null
  const selected = normalized.find(
    (site) =>
      site.origin.x === chosen.position.x &&
      site.origin.y === chosen.position.y &&
      site.origin.z === chosen.position.z,
  )
  const selectedAxis = selected?.widthAxis ?? widthAxis
  const layout = portalFrameLayout(chosen.position, selectedAxis)
  const existing = new Set((selected?.existingFrame ?? []).map(cellKey))
  const missing = layout.frame.filter((cell) => !existing.has(cellKey(cell)))
  if (missing.length === 0) return null
  return { origin: chosen.position, widthAxis: selectedAxis, cells: orderedPlacementCells(missing) }
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
