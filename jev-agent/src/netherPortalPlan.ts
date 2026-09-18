// netherPortalPlan.ts - issue #80 (M3): the typed Nether-portal plan path.
//
// WHY
// ---
// M3 is "diamond gear -> nether -> blaze/pearl". The live M2 ladder stops at
// iron, but the portal capability must be expressible the moment M2 completes.
// Issue #37 records that peaceful difficulty blocks M3d/M3e (blaze_rod /
// ender_pearl) but NOT building and lighting the portal, so this module owns the
// deterministic half only:
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
// typed plan -> PlannedGoal compiler (#19 compatibility)
// ---------------------------------------------------------------------------

/**
 * Compile a portal step into the existing typed `PlannedGoal` kinds. Steps with
 * no queue-level equivalent (`light`/`verify`) return null: they are executor
 * sub-steps of the single `place nether_portal` operation.
 */
export function portalStepToPlannedGoal(step: PortalStep): PlannedGoal | null {
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
    case 'build_portal_frame':
      return { kind: 'place', description: step.description, targetItem: NETHER_PORTAL, requiredCount: 1, ...flags }
    case 'light_portal':
    case 'verify_portal':
      return null
  }
}

export function portalStepsToPlannedGoals(steps: readonly PortalStep[]): PlannedGoal[] {
  const goals: PlannedGoal[] = []
  for (const step of steps) {
    const goal = portalStepToPlannedGoal(step)
    if (goal !== null) goals.push(goal)
  }
  return goals
}

// ---------------------------------------------------------------------------
// deterministic prerequisite chain (ladder supply, #12/#73 generalization)
// ---------------------------------------------------------------------------

export interface NetherPortalPlanInput {
  readonly inventory: Readonly<Record<string, number>>
  readonly toolRank: number
  readonly sites?: readonly PortalSiteCandidate[]
  readonly self?: PortalBlockPosition
  readonly dimension?: string
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
 * Build the typed Nether-portal plan from a live inventory snapshot. Missing
 * materials produce the prerequisite chain (flint/iron/diamond) FIRST, so the
 * ladder supplies work instead of stalling on an impossible goal.
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
  if (obsidian < PORTAL_OBSIDIAN_REQUIRED) {
    prerequisites.push({
      kind: 'collect',
      capabilityId: 'collect:obsidian',
      description: `mine ${PORTAL_OBSIDIAN_REQUIRED - obsidian} x ${OBSIDIAN} with ${DIAMOND_PICKAXE}`,
      item: OBSIDIAN,
      count: PORTAL_OBSIDIAN_REQUIRED - obsidian,
      requiredPickaxeRank: obsidianRank,
      postcondition: { kind: 'inventoryAtLeast', item: OBSIDIAN, count: PORTAL_OBSIDIAN_REQUIRED },
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

/** Ladder helper: the typed goals a `nether_portal` rung should emit. */
export function netherPortalRungGoals(
  inventory: Readonly<Record<string, number>>,
  toolRank: number,
  dimension: string = OVERWORLD,
): PlannedGoal[] {
  return planNetherPortal({ inventory, toolRank, dimension }).goals
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
