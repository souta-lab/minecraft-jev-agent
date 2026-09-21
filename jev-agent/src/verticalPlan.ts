// verticalPlan.ts - issue #45: pure vertical reachability for a RETRIEVE.
//
// The retrieval executor walks with `movements.canDig = false`, so an 8-block
// descent with no shaft is unreachable: the bot arrives at the resource's
// horizontal bearing and then stalls. This module decides, deterministically and
// with no model call, HOW to close a vertical gap toward a remembered resource:
//
//   1. reuse an already-dug tunnel/shaft when it descends toward the target Y
//      (`REUSE_TUNNEL at=x,y,z`), otherwise
//   2. dig one safe staircase step toward the target Y (`STAIRCASE from_y=n
//      to_y=m`) using the sensor's pre-computed `DescentOption`s, then approach
//      horizontally.
//
// It also carries the pure progress assertion used by the controller: while a
// RETRIEVE is active, if the distance to the target does not decrease over N
// ticks the caller logs `RETRIEVE_STALLED` and escalates instead of WAITing.
import type { DescentOption, HarvestTool, StepCut, Vec3Json } from './state.ts'
import { distance } from './state.ts'
import { resolveHarvest, loadGameData } from './gameData.ts'
import { bestToolTier, HAZARD_PROXIMITY } from './reachability.ts'
import { selectDigTool } from './toolChoice.ts'
import {
  decidePillarStepBudget,
  DEFAULT_PILLAR_SEARCH_POLICY,
  PILLAR_PLACE_PRIORITY,
  rankPillarFallbackColumns,
  selectPlaceableBlock,
} from './pillarSearch.ts'
import type { PlaceableBlock, PillarColumnProbe } from './pillarSearch.ts'

export { PILLAR_PLACE_PRIORITY, selectPlaceableBlock }
export type { PlaceableBlock, PillarColumnProbe }

/** A vertical gap larger than this (blocks) needs an explicit vertical plan. */
export const VERTICAL_GAP = 1

/**
 * Upper bound on one PILLAR_UP action. The executor climbs at most this many
 * one-block placements, then the next decision re-plans from the new Y, so a
 * 30-block climb is a bounded sequence of actions instead of one unbounded one.
 *
 * M2 ascent persistence: the live target furnace sits at y=66 while the bot
 * oscillates at y=8-11 (~56 blocks). The old bound of 8 meant every action
 * ended mid-gap, the executor then walked back down toward the unreachable
 * bearing (y 7.8 -> 11.0 -> 9.8), and no altitude was ever retained. 24 keeps
 * each action bounded (~40 s worst case) while covering a 50+ block gap in a
 * handful of ticks; the executor additionally stops a partial climb without a
 * horizontal walk, so each tick's chunk is durable.
 *
 * Owned by `PillarSearchPolicy.stepCap` (pillarSearch.ts) so the bound is a
 * localized search/cost decision that can log chosen/alternatives/reason.
 */
export const PILLAR_UP_STEP_CAP = DEFAULT_PILLAR_SEARCH_POLICY.stepCap

/**
 * Altitude gain (blocks) toward a retrieval target that counts as progress in
 * `evaluateRetrievalProgress`. A one-block climb must not be mistaken for a
 * stall just because the 3D distance barely moved (56-block gap: 1/56 < the
 * 0.5 m distance epsilon).
 */
export const ASCENT_PROGRESS_EPSILON = 0.9

/**
 * Whether a completed vertical move changed floor in the direction of the
 * target.  Reused tunnel legs report their own movement, so the executor must
 * distinguish a real vertical step from a horizontal arrival at the tunnel
 * entry (and from an accidental fall away from the target).
 */
export function verticalStepTowardTarget(input: { startY: number; currentY: number; targetY: number }): boolean {
  if (![input.startY, input.currentY, input.targetY].every(Number.isFinite)) return false
  const startFloorY = Math.floor(input.startY)
  const currentFloorY = Math.floor(input.currentY)
  if (currentFloorY === startFloorY) return false
  return Math.abs(input.targetY - currentFloorY) < Math.abs(input.targetY - startFloorY)
}

/**
 * A completed vertical leg is a bounded action, not permission to immediately
 * walk to a far-away target at the old horizontal bearing. This applies in
 * both directions: ascent used to have this guard, while a downward staircase
 * step could still fall through to the long horizontal path and get stuck.
 * Pure so the direction/boundary contract is testable without a bot.
 */
export function shouldReplanAfterVerticalChunk(input: {
  verticalStep: boolean
  startY: number
  currentY: number
  targetY: number
}): boolean {
  if (!input.verticalStep) return false
  if (!verticalStepTowardTarget(input)) return false
  const currentFloorY = Math.floor(input.currentY)
  return Math.abs(input.targetY - currentFloorY) > 1
}

/** Why a PILLAR_UP step is refused; `reached` is the normal loop end. */
export type PillarStepRefusal = 'reached' | 'no_placeable' | 'unsafe_column' | 'no_footing' | 'no_headroom'

/**
 * The deterministic gate for one PILLAR_UP step. The executor resolves the live
 * column and passes the observations here; every refusal path is pure, so the
 * safety rules (no placeable, hazard column, no solid footing, blocked
 * headroom) are unit-testable without a bot. `remaining` is the plan's bounded
 * step budget, so `reached` also ends the loop the moment the chunk is done.
 */
export function evaluatePillarStep(input: {
  placeableCount: number
  columnSafe: boolean
  remaining: number
  footingSolid: boolean
  headroomClear: boolean
}): { ok: true } | { ok: false; reason: PillarStepRefusal } {
  if (input.remaining < 1) return { ok: false, reason: 'reached' }
  if (input.placeableCount < 1) return { ok: false, reason: 'no_placeable' }
  if (!input.columnSafe) return { ok: false, reason: 'unsafe_column' }
  if (!input.footingSolid) return { ok: false, reason: 'no_footing' }
  if (!input.headroomClear) return { ok: false, reason: 'no_headroom' }
  return { ok: true }
}

/**
 * The horizontal cells touched by a player-sized AABB at the given center.
 * Mineflayer's physics broad-phase uses `floor(min)` through `floor(max)`;
 * matching that conservative range prevents a jump from being approved when
 * an adjacent wall overlaps the body's footprint at a fractional position.
 */
export function footprintCells(center: { x: number; z: number }, halfWidth: number): { x: number; z: number }[] {
  const width = Number.isFinite(halfWidth) && halfWidth > 0 ? halfWidth : 0
  const minX = Math.floor(center.x - width)
  const maxX = Math.floor(center.x + width)
  const minZ = Math.floor(center.z - width)
  const maxZ = Math.floor(center.z + width)
  const cells: { x: number; z: number }[] = []
  for (let x = minX; x <= maxX; x += 1) {
    for (let z = minZ; z <= maxZ; z += 1) cells.push({ x, z })
  }
  return cells
}

export interface HeadroomFootprintInput {
  center: { x: number; z: number }
  feetY: number
  halfWidth: number
  isPassable: (x: number, y: number, z: number) => boolean
}

export interface HeadroomFootprintResult {
  clear: boolean
  /** First blocking cell in feet+1, feet+2, then stable x/z order. */
  blocker: Vec3Json | null
}

/**
 * Check jump headroom across the whole horizontal player footprint. A single
 * column check is insufficient while the player is near a block boundary:
 * the own column can be air while an adjacent block intersects the AABB.
 */
export function headroomAcrossFootprint(input: HeadroomFootprintInput): HeadroomFootprintResult {
  if (
    !Number.isFinite(input.center.x) ||
    !Number.isFinite(input.center.z) ||
    !Number.isFinite(input.feetY) ||
    !Number.isFinite(input.halfWidth) ||
    input.halfWidth < 0
  ) {
    return { clear: false, blocker: null }
  }
  const feet = Math.floor(input.feetY + 1e-4)
  const cells = footprintCells(input.center, input.halfWidth)
  for (const y of [feet + 1, feet + 2]) {
    for (const cell of cells) {
      if (input.isPassable(cell.x, y, cell.z)) continue
      return { clear: false, blocker: { x: cell.x, y, z: cell.z } }
    }
  }
  return { clear: true, blocker: null }
}

export interface PillarStepResolution {
  /** Y of the topmost solid block under the feet: the placement reference. */
  footingY: number
  /** The cell the new block occupies (`footingY + 1`). */
  placeY: number
  /** The Y the feet land on after the placement (`placeY + 1`). */
  landingY: number
}

/**
 * Resolve one PILLAR_UP step pose from the live column. `isSolid(y)` reports
 * whether the block at that Y in the bot's column is a full solid block.
 *
 * The scan starts at the feet cell because a partial mount (slab, path, snow,
 * carpet) lives in that cell; `feetY - 1` covers the normal full-block floor.
 * Support must be CONTIGUOUS (feet or feet-1): a solid block two cells down
 * means the bot is airborne with a gap under it, and jumping from there would
 * place into open air. Live evidence for the scan: 21x `PILLAR_UP no solid
 * support at (39,9,32)` and (40,8,31)/(39,10,34) on floor(y)-1 while the bot was
 * standing there - the old lookup read one cell below a partial mount and never
 * grounded the step, so no PILLAR_UP_STEP ever executed.
 */
export function resolvePillarStep(input: {
  feetY: number
  isSolid: (y: number) => boolean
}): PillarStepResolution | null {
  const feet = Math.floor(input.feetY)
  for (const y of [feet, feet - 1]) {
    if (!input.isSolid(y)) continue
    return { footingY: y, placeY: y + 1, landingY: y + 2 }
  }
  return null
}

// --- PILLAR_UP headroom clearing (M2 pocket escape) ----------------------------
//
// Live blocker (main ff2c733, runner.out action#99/#195): the bot sat in a pocket
// at feet (40,8,31) with the player column capped by `cobblestone` at (40,9,31).
// `clearPillarHeadroom` returned false with no log, so the executor reported the
// opaque `no_headroom` and nothing identified the obstacle. The silent return
// came from the old boolean API: a missing pickaxe (`selectDigTool` ->
// `needs_pickaxe_tier_1`) was indistinguishable from an unbreakable block. The
// pure decision below owns the classification so every refusal carries the exact
// obstacle cell/name and cause into the `PILLAR_REFUSED` marker.

/** Why a blocked jump-headroom cell could not be opened. */
export type HeadroomClearRefusal =
  | 'no_obstacle'
  | 'not_diggable'
  | 'needs_tool'
  | 'fluid_or_hazard'
  | 'flood_risk'
  | 'dig_failed'

export interface HeadroomObstacle {
  cell: Vec3Json
  name: string
}

export interface HeadroomBlockerProbe {
  /** first non-passable cell above the feet (feet+1 before feet+2) */
  cell: Vec3Json
  /** live block name at the cell (`''` when the read missed) */
  name: string
  /** registry `diggable` flag (false for bedrock and friends) */
  diggable: boolean
  /** the block itself is a fluid/hazard and is never dug */
  fluidOrHazard: boolean
  /** a fluid/hazard touches the opened cell, so a dig could flood the pocket */
  floodRisk: boolean
  /** a usable tool for this block is in the inventory (`selectDigTool(...).ok`) */
  toolOk: boolean
}

export type HeadroomClearDecision =
  | { kind: 'dig'; obstacle: HeadroomObstacle }
  | { kind: 'refuse'; obstacle: HeadroomObstacle | null; reason: HeadroomClearRefusal }

export type HeadroomClearOutcome =
  | { cleared: true }
  | { cleared: false; obstacle: HeadroomObstacle | null; reason: HeadroomClearRefusal }

/**
 * Pure classification of the cell blocking the jump headroom. `null` (or an
 * empty name) means the scan found no solid obstacle while the caller measured
 * headroom as insufficient - a stale/partial read that must surface as
 * `no_obstacle` instead of a silent `false`.
 */
export function classifyHeadroomBlocker(probe: HeadroomBlockerProbe | null): HeadroomClearDecision {
  if (probe === null || probe.name === '') return { kind: 'refuse', obstacle: null, reason: 'no_obstacle' }
  const obstacle: HeadroomObstacle = { cell: probe.cell, name: probe.name }
  if (probe.fluidOrHazard) return { kind: 'refuse', obstacle, reason: 'fluid_or_hazard' }
  if (!probe.diggable) return { kind: 'refuse', obstacle, reason: 'not_diggable' }
  if (probe.floodRisk) return { kind: 'refuse', obstacle, reason: 'flood_risk' }
  if (!probe.toolOk) return { kind: 'refuse', obstacle, reason: 'needs_tool' }
  return { kind: 'dig', obstacle }
}

/**
 * Deterministic selection of an adjacent, grounded pillar column when the
 * current column's ceiling cannot be cleared. Delegates to
 * `rankPillarFallbackColumns` (pillarSearch.ts) so the audited ranking has one
 * owner; the caller passes probes in a fixed direction/level order, and the
 * stable sort keeps that order as the tie-break.
 */
export function selectPillarFallbackColumn(
  probes: readonly PillarColumnProbe[],
  selfFeet: Vec3Json,
): Vec3Json | null {
  return rankPillarFallbackColumns(probes, selfFeet)[0]?.cell ?? null
}

/** The exact log line emitted when a PILLAR_UP step is refused. */
export function formatPillarRefused(input: {
  reason: PillarStepRefusal
  cell: Vec3Json
  obstacle: HeadroomObstacle | null
  cause?: HeadroomClearRefusal | null
}): string {
  const obstacle =
    input.obstacle === null
      ? 'none'
      : `${input.obstacle.name}@${input.obstacle.cell.x},${input.obstacle.cell.y},${input.obstacle.cell.z}`
  const cause = input.cause === undefined || input.cause === null ? '' : ` cause=${input.cause}`
  return `PILLAR_REFUSED reason=${input.reason} cell=${input.cell.x},${input.cell.y},${input.cell.z} obstacle=${obstacle}${cause}`
}

/** The exact log line emitted when the pillar relocates to an open neighbour. */
export function formatPillarRelocate(from: Vec3Json, to: Vec3Json, obstacle: HeadroomObstacle | null): string {
  const bounded =
    obstacle === null ? 'none' : `${obstacle.name}@${obstacle.cell.x},${obstacle.cell.y},${obstacle.cell.z}`
  return `PILLAR_RELOCATE from=${from.x},${from.y},${from.z} to=${to.x},${to.y},${to.z} obstacle=${bounded}`
}

export interface HazardBlockLike {
  kind: string
  position: Vec3Json
}

/**
 * Sensor-side column safety for a PILLAR_UP: a scanned hazard (lava/fire/...)
 * anywhere in the bot's own column between one below the feet and feet+2
 * refuses the pillar plan, so the bot is never sent into a hazard cell just
 * because it holds a placeable block. The executor re-checks against the live
 * world.
 */
export function pillarColumnUnsafeFromBlocks(
  self: Vec3Json,
  blocks: readonly HazardBlockLike[],
): boolean {
  const x = Math.floor(self.x)
  const z = Math.floor(self.z)
  const feet = Math.floor(self.y)
  return blocks.some(
    (block) =>
      block.kind === 'hazard' &&
      block.position.x === x &&
      block.position.z === z &&
      block.position.y >= feet - 1 &&
      block.position.y <= feet + 2,
  )
}

/** Default progress-assertion window (ticks) before a RETRIEVE is called stalled. */
export const RETRIEVAL_STALL_TICKS_DEFAULT = 40

/** `BUDDY_RETRIEVAL_STALL_TICKS` overrides the window; invalid values fall back. */
export function resolveRetrievalStallTicks(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = Number(env.BUDDY_RETRIEVAL_STALL_TICKS ?? RETRIEVAL_STALL_TICKS_DEFAULT)
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : RETRIEVAL_STALL_TICKS_DEFAULT
}

export type VerticalDir = DescentOption['dir']

export type VerticalPlan =
  | {
      kind: 'reuse'
      /** remembered tunnel cell to walk to first */
      tunnel: Vec3Json
      fromY: number
      toY: number
      /**
       * Deterministic clearance step for the entry cell, attached when the
       * offering layer already knew the entry cell was blocked by one diggable
       * block. The executor still re-validates live, but this carries the
       * pre-computed cell so the plan is never a blind waypoint.
       */
      clear?: { cell: Vec3Json; name: string }
    }
  | {
      kind: 'staircase'
      dir: VerticalDir
      fromY: number
      toY: number
      /** block to dig (the sensor-validated primary cell) */
      dig: Vec3Json
      /** feet cell the bot drops into after the dig */
      step: Vec3Json
      digName: string | null
      harvestTool: DescentOption['digHarvestTool']
      harvestTier: DescentOption['digHarvestTier']
    }
  | {
      /** the up mirror: cut the upper block of a 2-block face, then step up */
      kind: 'staircase-up'
      dir: StepCut['dir']
      fromY: number
      toY: number
      /** block above-and-ahead to dig (the sensor-validated step cut) */
      dig: Vec3Json
      /** feet cell the bot climbs into after the dig */
      step: Vec3Json
      digName: string | null
    }
  | {
      /** place a held block under the airborne feet and land on it, one at a time */
      kind: 'pillar'
      fromY: number
      /** the Y this action climbs to: min(target, fromY + steps) */
      toY: number
      /** bounded one-block placements this action will attempt (>= 1) */
      steps: number
      placeName: string
      placeCount: number
    }

export interface VerticalInput {
  /** bot feet Y (fractional is fine; it is floored) */
  selfFeetY: number
  selfPosition: Vec3Json
  target: Vec3Json
  tunnel: Vec3Json | null | undefined
  descent: readonly DescentOption[] | undefined
  /** sensor step cuts (`state.stepCuts`), the grounded up-staircase primitive */
  stepCuts?: readonly StepCut[] | null
  /** held pillar block; when absent an upward gap has no grounded plan */
  placeable?: PlaceableBlock | null
  /**
   * live inventory counts. When provided, an upward stair cut is only chosen
   * when `canDigBlock(cut.name, inventory)` proves the held tools can finish the
   * dig, so a stone cut without a pickaxe never shadows the pillar fallback.
   * Tool-agnostic callers omit it and keep the geometry-only choice.
   */
  inventory?: Readonly<Record<string, number>>
  /**
   * sensor-side column safety; false refuses the pillar plan (default true so
   * pure callers that have no hazard scan keep the old behaviour)
   */
  columnSafe?: boolean
  /**
   * live enterability facts for `tunnel`; when absent the reuse plan is offered
   * unverified and the executor validates before it walks.
   */
  tunnelEntry?: TunnelEntryProbe | null
  /** next reachable entry cells of the same tunnel, in priority order */
  tunnelAlternates?: readonly TunnelEntryProbe[] | null
}

function withinTunnelReach(tunnel: Vec3Json, targetY: number, fromY: number, dy: number): boolean {
  if (dy < 0) return tunnel.y < fromY && tunnel.y >= targetY - 1
  return tunnel.y > fromY && tunnel.y <= targetY + 1
}

// --- tunnel entry validation (M2 FURNACE_READY: reuse met a blocked entry) ----
//
// Live failure on main a542593: a committed RETRIEVE 1.5 blocks from its waypoint
// failed `path_stuck` because the remembered tunnel cell the body had to occupy
// was not enterable, and `reuse` returned that cell as a blind waypoint. The
// checks below make the entry contract explicit: 2-block clearance plus a
// standable support, or a single diggable blocking block, or a typed refusal.

/** One blocking cell of a tunnel entry, with the live facts needed to clear it. */
export interface TunnelEntryBlockerProbe {
  cell: Vec3Json
  name: string
  diggable: boolean
  fluidOrHazard: boolean
  floodRisk: boolean
  toolOk: boolean
}

/** Live enterability facts for a tunnel cell the body must occupy. */
export interface TunnelEntryProbe {
  /** the feet cell the body must occupy */
  cell: Vec3Json
  bodyClear: boolean
  headClear: boolean
  supportSolid: boolean
  /** first non-passable body/head cell, when one was read */
  blocker?: TunnelEntryBlockerProbe | null
}

export type TunnelEntryRefusalReason = 'no_clearance' | 'no_support'

export type TunnelEntryDecision =
  | { kind: 'enterable' }
  | { kind: 'clear'; blocker: TunnelEntryBlockerProbe }
  | { kind: 'refuse'; reason: TunnelEntryRefusalReason; cell: Vec3Json }

export interface TunnelEntryRefusal {
  reason: TunnelEntryRefusalReason
  cell: Vec3Json
}

/**
 * Pure enterability decision for a reused tunnel cell. A blocked body/head cell
 * is clearable only when exactly one diggable, non-fluid, non-flooding block is
 * identified and a usable tool is held; otherwise the entry is refused with the
 * cause so the caller can select a different vertical plan.
 */
export function evaluateTunnelEntry(probe: TunnelEntryProbe): TunnelEntryDecision {
  if (!probe.bodyClear || !probe.headClear) {
    const blocker = probe.blocker ?? null
    if (
      blocker !== null &&
      blocker.diggable &&
      !blocker.fluidOrHazard &&
      !blocker.floodRisk &&
      blocker.toolOk
    ) {
      return { kind: 'clear', blocker }
    }
    return { kind: 'refuse', reason: 'no_clearance', cell: blocker?.cell ?? probe.cell }
  }
  if (!probe.supportSolid) return { kind: 'refuse', reason: 'no_support', cell: probe.cell }
  return { kind: 'enterable' }
}

/** Radius (blocks) within which a blocked waypoint is a local clearance, not a path failure. */
export const LOCAL_CLEAR_RADIUS = 3

/** One cell the body would traverse on the way to the tunnel, with live facts. */
export interface ApproachBlockage {
  cell: Vec3Json
  passable: boolean
  name?: string
  diggable?: boolean
  fluidOrHazard?: boolean
  floodRisk?: boolean
  toolOk?: boolean
}

export type LocalClearDecision =
  | { kind: 'clear'; cell: Vec3Json }
  | { kind: 'none' }
  | { kind: 'multiple'; cells: Vec3Json[] }

/**
 * Pick at most one approach cell to dig. A single blocked, diggable, safe cell
 * is a local clearance; several blocked cells are not a single identified cause
 * and are left alone so the executor never tunnels an arbitrary path.
 */
export function selectLocalClearCell(blockages: readonly ApproachBlockage[]): LocalClearDecision {
  const blocked = blockages.filter((entry) => !entry.passable)
  if (blocked.length === 0) return { kind: 'none' }
  if (blocked.length > 1) return { kind: 'multiple', cells: blocked.map((entry) => entry.cell) }
  const only = blocked[0]
  if (only === undefined) return { kind: 'none' }
  const safe =
    only.diggable === true && only.fluidOrHazard !== true && only.floodRisk !== true && only.toolOk === true
  return safe ? { kind: 'clear', cell: only.cell } : { kind: 'none' }
}

export type ReuseLegAction =
  | { action: 'path' }
  | { action: 'clear-entry'; blocker: TunnelEntryBlockerProbe }
  | { action: 'clear-approach'; cell: Vec3Json }
  | { action: 'refuse'; reason: TunnelEntryRefusalReason; cell: Vec3Json }
  | { action: 'fail'; code: 'path_stuck' }

/**
 * Decide the reuse leg from the entry decision and a failed walk. A near waypoint
 * that failed with a single identified blocking cell yields a local clearance
 * attempt instead of a `path_stuck` escalation; an unusable entry refuses with
 * its typed cause so the caller can fall back to another vertical plan.
 */
export function planReuseLeg(input: {
  entry: TunnelEntryDecision
  pathFailed: boolean
  distanceToTunnel: number
  approachBlockages?: readonly ApproachBlockage[] | null
}): ReuseLegAction {
  if (input.entry.kind === 'clear') return { action: 'clear-entry', blocker: input.entry.blocker }
  if (input.entry.kind === 'refuse') return { action: 'refuse', reason: input.entry.reason, cell: input.entry.cell }
  if (!input.pathFailed) return { action: 'path' }
  if (!(input.distanceToTunnel <= LOCAL_CLEAR_RADIUS)) return { action: 'fail', code: 'path_stuck' }
  const local = selectLocalClearCell(input.approachBlockages ?? [])
  if (local.kind === 'clear') return { action: 'clear-approach', cell: local.cell }
  return { action: 'fail', code: 'path_stuck' }
}

/** The exact log line emitted when a remembered tunnel entry cannot be used. */
export function formatTunnelEntryRefused(refusal: TunnelEntryRefusal): string {
  return `TUNNEL_ENTRY_REFUSED reason=${refusal.reason} cell=${refusal.cell.x},${refusal.cell.y},${refusal.cell.z}`
}

/** The exact log line emitted before the executor clears one blocking cell. */
export function formatLocalClear(
  cell: Vec3Json,
  blockName: string | null,
  tool: string | null,
  tier: number | null,
): string {
  const toolLabel = tool === null ? 'hand' : tool
  const tierLabel = tier === null ? '0' : String(tier)
  return `LOCAL_CLEAR cell=${cell.x},${cell.y},${cell.z} block=${blockName ?? 'unknown'} tool=${toolLabel} tier=${tierLabel}`
}

// --- ascent-column capability (M2: `safe_column` computed from real geometry) --
//
// `safe_column` was refused as a bare capability whenever the body's own column
// could not be proven pillar-able, even when the geometry to climb existed.
// Live starvation (main 104e689, 18:04:48, bot on a partial block at y=34.5,
// cobblestone 130, stone+wooden pickaxe held): `CANDIDATE_STARVATION
// presented=2 productive=0 goal="smelt:charcoal:1" blockedBy=no_productive_action
// missing=["RETRIEVE:known:station:crafting_table:b31_63_37:safe_column",
// "RETRIEVE:known:station:furnace:b29_61_35:safe_column"]` - no productive
// candidate existed although the ascent geometry did. The evaluation below is
// the FACT the gate must carry instead of a bare token: is there at least one
// adjacent/forward cell whose 2-block body column one level up is clear (a
// walkable step) or clearable (exactly one diggable blocker + the held tool),
// with solid support beneath and no hazard/liquid?
//
// The classification reuses the audited machinery rather than adding a ladder:
//   - clear      -> the sensor `standable` proof (feet+head passable, support
//                   solid) one level up; the horizontal path climbs it;
//   - clearable  -> a sensor-safe `StepCut` at feet+1, which `selectUpStep`
//                   already turns into the grounded `staircase-up` leg (dig the
//                   one blocker, step into the cut) and `LOCAL_CLEAR` covers
//                   for a blocked reuse entry;
//   - no_tool    -> the same cut geometry without the held tool, so the gate
//                   withholds instead of offering a dig the executor cannot
//                   finish;
//   - no_clearance -> neither exists; the refusal names the examined cell.

/** Why no usable ascent column exists at all. */
export type AscentColumnRefusalReason = 'no_clearance' | 'no_tool'

/** The one diggable blocker of a clearable ascent column, with its tool facts. */
export interface AscentColumnBlocker {
  cell: Vec3Json
  name: string
  /** the inventory holds a tool that harvests this blocker */
  toolOk: boolean
  requiredTool: HarvestTool | null
  /** minimum pickaxe rank when `requiredTool === 'pickaxe'` */
  requiredTier: number | null
}

/**
 * The executor's live dig rule, pure: does the inventory hold a usable tool for
 * `blockName`? Identical to `Executor.resolveLiveDigTool` (`selectDigTool` over
 * the block's own harvest profile), so any plan/dig the gate offers is one the
 * executor can finish. Soft classes (dirt/gravel/sand/grass/...) answer true
 * without a pickaxe - `selectDigTool` falls back to the bare hand - while only
 * stone-family/ore blocks require a pickaxe.
 */
export function canDigBlock(blockName: string, inventory: Readonly<Record<string, number>>): boolean {
  const profile = resolveHarvest(loadGameData(), blockName)
  return selectDigTool(
    { name: blockName, harvestTool: profile.harvestTool, harvestTier: profile.harvestTier, diggable: true },
    (tool, tier) => bestToolTier(inventory, tool) >= (tier ?? 0),
  ).ok
}

export type AscentColumnDecision =
  | { kind: 'clear'; cell: Vec3Json }
  | { kind: 'clearable'; cell: Vec3Json; blocker: AscentColumnBlocker }
  | {
      kind: 'refuse'
      reason: AscentColumnRefusalReason
      /** the column cell the classification examined (never null: named refusal) */
      cell: Vec3Json
      blocker: AscentColumnBlocker | null
    }

export interface AscentColumnInput {
  /** bot feet Y (fractional is fine; it is floored) */
  selfFeetY: number
  selfPosition: Vec3Json
  /** destination, used only to prefer the column on the travel bearing */
  target: Vec3Json | null
  /** sensor step cuts: a safe cut at `cut.y === feet+1` is a grounded step-up */
  stepCuts?: readonly StepCut[] | null
  /** sensor standable feet cells (2-block clearance + solid support proven) */
  standable?: readonly Vec3Json[] | null
  /** sensor-classified hazard cells (lava/fire/...): a column touching one is unsafe */
  hazards?: readonly Vec3Json[] | null
  inventory: Readonly<Record<string, number>>
}

const ASCENT_COLUMN_DIRS: ReadonlyArray<{ dx: number; dz: number }> = [
  { dx: 1, dz: 0 },
  { dx: -1, dz: 0 },
  { dx: 0, dz: -1 },
  { dx: 0, dz: 1 },
]

/** 0 when the cell lies on the travel bearing, 10 otherwise (mirrors `selectUpStep`). */
function ascentAlignmentScore(cell: Vec3Json, input: AscentColumnInput): number {
  const target = input.target
  if (target === null) return 0
  const signX = Math.sign(target.x - input.selfPosition.x)
  const signZ = Math.sign(target.z - input.selfPosition.z)
  const dx = cell.x - Math.floor(input.selfPosition.x)
  const dz = cell.z - Math.floor(input.selfPosition.z)
  return dx * signX + dz * signZ > 0 ? 0 : 10
}

function hazardTouchesColumn(cell: Vec3Json, hazards: readonly Vec3Json[]): boolean {
  return hazards.some((hazard) => distance(hazard, cell) <= HAZARD_PROXIMITY)
}

function cellMatches(spot: Vec3Json, cell: Vec3Json): boolean {
  return Math.floor(spot.x) === cell.x && Math.floor(spot.y) === cell.y && Math.floor(spot.z) === cell.z
}

/**
 * The deterministic `safe_column` fact: can the body ascend through at least one
 * adjacent/forward column right now? Pure: same facts -> same decision.
 */
export function evaluateAscentColumn(input: AscentColumnInput): AscentColumnDecision {
  const feet = {
    x: Math.floor(input.selfPosition.x),
    y: Math.floor(input.selfFeetY),
    z: Math.floor(input.selfPosition.z),
  }
  const nextLevelY = feet.y + 1
  const hazards = input.hazards ?? []
  const standable = input.standable ?? []

  // 1. Clear columns: a standable feet cell one level up on a cardinal line
  //    (the sensor already proved body + head clearance and solid support).
  let bestClear: { cell: Vec3Json; score: number } | null = null
  for (const dir of ASCENT_COLUMN_DIRS) {
    for (const dist of [1, 2, 3]) {
      const cell = { x: feet.x + dir.dx * dist, y: nextLevelY, z: feet.z + dir.dz * dist }
      if (!standable.some((spot) => cellMatches(spot, cell))) continue
      if (hazardTouchesColumn(cell, hazards)) continue
      const score = ascentAlignmentScore(cell, input) + distance(cell, input.selfPosition) * 0.1
      if (bestClear === null || score < bestClear.score) bestClear = { cell, score }
    }
  }
  if (bestClear !== null) return { kind: 'clear', cell: bestClear.cell }

  // 2. Grounded 2-block faces (sensor `StepCut`): cut the top block of the face
  //    and step into the cut. `safe` already encodes breakable + landing support
  //    + headroom + no hazard; the held tool is the remaining gate.
  let bestCut: { cut: StepCut; blocker: AscentColumnBlocker; score: number } | null = null
  let bestUnsafe: { cut: StepCut; score: number } | null = null
  for (const cut of input.stepCuts ?? []) {
    if (cut.cut.y !== nextLevelY) continue
    const score = ascentAlignmentScore(cut.cut, input) + distance(cut.cut, input.selfPosition) * 0.1
    if (cut.safe !== true) {
      if (bestUnsafe === null || score < bestUnsafe.score) bestUnsafe = { cut, score }
      continue
    }
    const profile = resolveHarvest(loadGameData(), cut.name)
    // The executor resolves the same block live through `selectDigTool`
    // (`Executor.resolveLiveDigTool`), so the gate must use the identical rule:
    // only a pickaxe is a hard requirement, an axe/shovel cut falls back to hand.
    const blocker: AscentColumnBlocker = {
      cell: cut.cut,
      name: cut.name,
      toolOk: canDigBlock(cut.name, input.inventory),
      requiredTool: profile.harvestTool,
      requiredTier: profile.harvestTier,
    }
    if (bestCut === null || score < bestCut.score) bestCut = { cut, blocker, score }
  }
  if (bestCut !== null) {
    return bestCut.blocker.toolOk
      ? { kind: 'clearable', cell: bestCut.cut.cut, blocker: bestCut.blocker }
      : { kind: 'refuse', reason: 'no_tool', cell: bestCut.cut.cut, blocker: bestCut.blocker }
  }
  if (bestUnsafe !== null) {
    return { kind: 'refuse', reason: 'no_clearance', cell: bestUnsafe.cut.cut, blocker: null }
  }

  // 3. Nothing to climb: name the cardinal column cell the body would have had
  //    to use, so the marker reads `safe_column:no_clearance@x,y,z` and never a
  //    bare token.
  let fallbackDir = ASCENT_COLUMN_DIRS[0] ?? { dx: 1, dz: 0 }
  let fallbackScore = Number.POSITIVE_INFINITY
  for (const dir of ASCENT_COLUMN_DIRS) {
    const probe = { x: feet.x + dir.dx, y: nextLevelY, z: feet.z + dir.dz }
    const score = ascentAlignmentScore(probe, input)
    if (score < fallbackScore) {
      fallbackScore = score
      fallbackDir = dir
    }
  }
  return {
    kind: 'refuse',
    reason: 'no_clearance',
    cell: { x: feet.x + fallbackDir.dx, y: nextLevelY, z: feet.z + fallbackDir.dz },
    blocker: null,
  }
}

function selectUpStep(input: VerticalInput, fromY: number, targetY: number): VerticalPlan | null {
  const targetSignX = Math.sign(input.target.x - input.selfPosition.x)
  const targetSignZ = Math.sign(input.target.z - input.selfPosition.z)
  let best: StepCut | null = null
  let bestScore = Number.POSITIVE_INFINITY
  for (const cut of input.stepCuts ?? []) {
    if (!cut.safe) continue
    // The up mirror of the down staircase cuts the block directly above the
    // landing step; a higher cut is a 2-block jump and is not grounded.
    if (cut.cut.y !== fromY + 1) continue
    // A plan is only offered when its dig is mechanically executable NOW: the
    // executor re-resolves the same `selectDigTool` rule live, so a staircase-up
    // through stone without a pickaxe must fall through to the pillar fallback
    // (or to a truthful refusal) instead of shadowing it. Soft classes answer
    // true by hand, so only stone-family/ore cuts need the pickaxe here.
    if (input.inventory !== undefined && !canDigBlock(cut.name, input.inventory)) continue
    const alignment = cut.dx * targetSignX + cut.dz * targetSignZ
    const score = (alignment > 0 ? 0 : 10) + distance(cut.step, input.selfPosition) * 0.1
    if (score < bestScore) {
      bestScore = score
      best = cut
    }
  }
  if (best === null) return null
  return {
    kind: 'staircase-up',
    dir: best.dir,
    fromY,
    toY: targetY,
    dig: best.cut,
    step: best.step,
    digName: best.name,
  }
}

/**
 * Why an upward gap > VERTICAL_GAP has no grounded plan. A typed refusal is the
 * non-repeating failure a caller can act on (re-plan / abandon / acquire the
 * missing block) instead of re-issuing the same unreachable `y>=N` goal.
 */
export type UpwardRefusalReason = 'no_placeable' | 'unsafe_column'

export interface UpwardAscentRefusal {
  reason: UpwardRefusalReason
  /** feet Y the ascent would have started from */
  fromY: number
  /** requested target Y (the gap's far side) */
  toY: number
  /** the own-column feet cell the refused ascent belongs to */
  cell: Vec3Json
}

interface UpwardPlanDecision {
  plan: VerticalPlan | null
  refusal: UpwardAscentRefusal | null
}

function planUpward(input: VerticalInput, fromY: number, targetY: number, dy: number): UpwardPlanDecision {
  const cell = { x: Math.floor(input.selfPosition.x), y: fromY, z: Math.floor(input.selfPosition.z) }
  const upStep = selectUpStep(input, fromY, targetY)
  if (upStep !== null) return { plan: upStep, refusal: null }
  if (input.columnSafe === false) {
    return { plan: null, refusal: { reason: 'unsafe_column', fromY, toY: targetY, cell } }
  }
  const placeable = input.placeable ?? null
  if (placeable === null || placeable.count < 1) {
    return { plan: null, refusal: { reason: 'no_placeable', fromY, toY: targetY, cell } }
  }
  const budget = decidePillarStepBudget(dy)
  // Never emit a step that needs more placements than the bot actually holds: a
  // 17-block plan backed by 1 dirt promised a climb the executor cannot finish
  // and then broke mid-action with `no_placeable`, which read as a movement
  // failure. The bounded chunk is `min(gap, stepCap, heldCount)`; the next
  // decision re-plans from the new Y and re-acquires blocks if it must.
  const steps = Math.min(budget.steps, placeable.count)
  if (steps < 1) {
    return { plan: null, refusal: { reason: 'no_placeable', fromY, toY: targetY, cell } }
  }
  return {
    plan: {
      kind: 'pillar',
      fromY,
      toY: fromY + steps,
      steps,
      placeName: placeable.name,
      placeCount: placeable.count,
    },
    refusal: null,
  }
}

/** The exact log line emitted when an upward gap has no grounded plan. */
export function formatAscentRefused(refusal: UpwardAscentRefusal): string {
  return `ASCENT_REFUSED reason=${refusal.reason} from_y=${refusal.fromY} to_y=${refusal.toY} cell=${refusal.cell.x},${refusal.cell.y},${refusal.cell.z}`
}

export interface VerticalApproachDecision {
  plan: VerticalPlan | null
  /** set when a remembered tunnel was offered but its entry was not usable */
  tunnelRefusal: TunnelEntryRefusal | null
  /**
   * set when an upward gap > VERTICAL_GAP has NO grounded plan. `plan: null`
   * alone cannot distinguish "no vertical leg needed" (level/downward, or a
   * one-block drop) from "the requested ascent is impossible right now", which
   * let a caller re-issue an unreachable `y>=N` goal forever. The typed cause is
   * the non-repeating failure the caller turns into a re-plan/abandon.
   */
  ascentRefusal: UpwardAscentRefusal | null
}

type TunnelResolution =
  | { kind: 'skip' }
  | { kind: 'reuse'; tunnel: Vec3Json; clear: { cell: Vec3Json; name: string } | null }
  | { kind: 'refused'; refusal: TunnelEntryRefusal }

function reusePlan(
  tunnel: Vec3Json,
  clear: { cell: Vec3Json; name: string } | null,
  fromY: number,
  targetY: number,
): VerticalPlan {
  return clear === null
    ? { kind: 'reuse', tunnel, fromY, toY: targetY }
    : { kind: 'reuse', tunnel, fromY, toY: targetY, clear }
}

/**
 * Resolve the remembered tunnel against the live entry facts. An enterable cell
 * (primary or the first usable alternate) wins; a clearable cell yields the
 * pre-computed clearance step; otherwise the first typed refusal is returned so
 * the caller can fall back to a different vertical plan.
 */
function resolveTunnelEntry(
  input: VerticalInput,
  tunnel: Vec3Json,
  targetY: number,
  fromY: number,
  dy: number,
): TunnelResolution {
  if (!withinTunnelReach(tunnel, targetY, fromY, dy)) return { kind: 'skip' }
  const primary = input.tunnelEntry ?? null
  const probes: TunnelEntryProbe[] = primary !== null ? [primary] : []
  for (const alternate of input.tunnelAlternates ?? []) probes.push(alternate)
  if (probes.length === 0) return { kind: 'reuse', tunnel, clear: null }

  let firstClear: { tunnel: Vec3Json; clear: { cell: Vec3Json; name: string } } | null = null
  let firstRefusal: TunnelEntryRefusal | null = null
  for (const probe of probes) {
    if (probe !== primary && !withinTunnelReach(probe.cell, targetY, fromY, dy)) continue
    const decision = evaluateTunnelEntry(probe)
    if (decision.kind === 'enterable') return { kind: 'reuse', tunnel: probe.cell, clear: null }
    if (decision.kind === 'clear') {
      if (firstClear === null) {
        firstClear = { tunnel: probe.cell, clear: { cell: decision.blocker.cell, name: decision.blocker.name } }
      }
      continue
    }
    if (firstRefusal === null) firstRefusal = { reason: decision.reason, cell: decision.cell }
  }
  if (firstClear !== null) return { kind: 'reuse', tunnel: firstClear.tunnel, clear: firstClear.clear }
  return { kind: 'refused', refusal: firstRefusal ?? { reason: 'no_clearance', cell: tunnel } }
}

/**
 * Decide the vertical leg of a retrieval, carrying any tunnel-entry refusal.
 * Pure: same input -> same plan. Returns null when the target is level
 * (horizontal path handles it) or when an upward gap has neither a safe step cut
 * nor a held pillar block, in which case the caller falls back to explorer/climb
 * candidates and the stall assertion.
 */
export function planVerticalApproachDetailed(input: VerticalInput): VerticalApproachDecision {
  const fromY = Math.floor(input.selfFeetY)
  const targetY = input.target.y
  const dy = targetY - fromY
  if (dy === 0) return { plan: null, tunnelRefusal: null, ascentRefusal: null }

  const tunnel = input.tunnel ?? null

  if (dy > 0) {
    const resolution = tunnel !== null ? resolveTunnelEntry(input, tunnel, targetY, fromY, dy) : { kind: 'skip' as const }
    if (resolution.kind === 'reuse') {
      return { plan: reusePlan(resolution.tunnel, resolution.clear, fromY, targetY), tunnelRefusal: null, ascentRefusal: null }
    }
    const upward = planUpward(input, fromY, targetY, dy)
    return {
      plan: upward.plan,
      tunnelRefusal: resolution.kind === 'refused' ? resolution.refusal : null,
      ascentRefusal: upward.refusal,
    }
  }

  // A one-block drop needs no vertical leg (the horizontal path steps down it).
  if (Math.abs(dy) <= VERTICAL_GAP) return { plan: null, tunnelRefusal: null, ascentRefusal: null }

  const resolution = tunnel !== null ? resolveTunnelEntry(input, tunnel, targetY, fromY, dy) : { kind: 'skip' as const }
  if (resolution.kind === 'reuse') {
    return { plan: reusePlan(resolution.tunnel, resolution.clear, fromY, targetY), tunnelRefusal: null, ascentRefusal: null }
  }
  const tunnelRefusal = resolution.kind === 'refused' ? resolution.refusal : null

  const steps = (input.descent ?? []).filter(
    (step) => step.mode === 'down' && step.safe && step.diggable === true,
  )
  if (steps.length === 0) return { plan: null, tunnelRefusal, ascentRefusal: null }

  const tdx = input.target.x - input.selfPosition.x
  const tdz = input.target.z - input.selfPosition.z
  const targetSignX = Math.sign(tdx)
  const targetSignZ = Math.sign(tdz)

  let best: DescentOption | null = null
  let bestScore = Number.POSITIVE_INFINITY
  for (const step of steps) {
    const alignment = step.dx * targetSignX + step.dz * targetSignZ
    const openFront = !step.wallSolid && !step.headSolid
    const stepDistance = distance(step.step, input.selfPosition)
    const score = (alignment > 0 ? 0 : 10) + (openFront ? 0 : 5) + stepDistance * 0.1
    if (score < bestScore) {
      bestScore = score
      best = step
    }
  }
  if (best === null) return { plan: null, tunnelRefusal, ascentRefusal: null }

  const dig = best.mode === 'down' ? (best.floorSolid ? best.floor : best.wall) : best.wall
  return {
    plan: {
      kind: 'staircase',
      dir: best.dir,
      fromY,
      toY: targetY,
      dig,
      step: best.step,
      digName: best.digName ?? null,
      harvestTool: best.digHarvestTool ?? null,
      harvestTier: best.digHarvestTier ?? null,
    },
    tunnelRefusal,
    ascentRefusal: null,
  }
}

/** Back-compat wrapper: the plan only, without the tunnel-entry refusal. */
export function planVerticalApproach(input: VerticalInput): VerticalPlan | null {
  return planVerticalApproachDetailed(input).plan
}

export interface RetrievalProgressState {
  /** closest distance seen so far for the active retrieval */
  best: number
  /** consecutive ticks without a decrease */
  ticks: number
  /** best (smallest) |selfY - targetY| seen, when vertical tracking is on */
  bestGap?: number
}

export type RetrievalProgressOutcome = 'progress' | 'tracking' | 'stalled'

export interface RetrievalProgressDecision extends RetrievalProgressState {
  outcome: RetrievalProgressOutcome
}

/**
 * Pure progress assertion for an active RETRIEVE. `stalled` is emitted once the
 * distance has failed to decrease by `epsilon` for `stallTicks` consecutive
 * observations; the caller then logs `RETRIEVE_STALLED` and escalates. The tick
 * counter resets on both a real decrease and a stall so the assertion re-arms
 * instead of firing on every subsequent tick.
 *
 * `verticalGap` (M2 ascent): when supplied, a gain of `verticalEpsilon` blocks
 * toward the target's Y also counts as progress and resets the counter. A
 * 56-block climb moves the 3D distance by only ~1/56 per step, so without this
 * the stall assertion would abandon a retrieval that is genuinely climbing.
 */
export function evaluateRetrievalProgress(input: {
  previous: RetrievalProgressState
  distance: number
  epsilon: number
  stallTicks: number
  verticalGap?: number
  verticalEpsilon?: number
}): RetrievalProgressDecision {
  const { previous, distance: current, epsilon, stallTicks } = input
  const verticalEpsilon = input.verticalEpsilon ?? ASCENT_PROGRESS_EPSILON
  const gap = input.verticalGap
  const bestGap =
    gap === undefined ? previous.bestGap : previous.bestGap === undefined ? gap : Math.min(previous.bestGap, gap)
  const distanceProgress = current <= previous.best - epsilon
  const altitudeProgress =
    gap !== undefined && previous.bestGap !== undefined && gap <= previous.bestGap - verticalEpsilon
  if (distanceProgress || altitudeProgress) {
    return { best: current, ticks: 0, bestGap, outcome: 'progress' }
  }
  const ticks = previous.ticks + 1
  if (ticks >= stallTicks) return { best: previous.best, ticks: 0, bestGap, outcome: 'stalled' }
  return { best: previous.best, ticks, bestGap, outcome: 'tracking' }
}

/**
 * M2 ascent marker: one line per bounded climb chunk, emitted by the executor
 * after a pillar/staircase-up action so the resident log proves sustained
 * ascent as `from_y` rises toward `to_y=target_y` across ticks.
 */
export function formatAscentProgress(fromY: number, toY: number, targetY: number): string {
  return `ASCENT_PROGRESS from_y=${fromY} to_y=${toY} target_y=${targetY}`
}

// --- stall escalation (issue #45 requirement 3) --------------------------------
//
// A stalled retrieval target has consumed its bounded effort. The controller must
// stop re-issuing it and pick a different body change: another remembered resource
// of the same kind (nearest first), or a branch-mine at the failed target's Y.
// Pure and deterministic so the escalation policy is unit-testable.

export interface KnownResourceLike {
  name: string
  position: Vec3Json
}

export type RetrievalEscalation =
  | { kind: 'switch-resource'; name: string; position: Vec3Json }
  | { kind: 'branch-mine'; y: number }

/**
 * Choose the replacement strategy after a RETRIEVE stall. The failed cell is
 * excluded; another remembered resource of the same block name wins when one
 * exists, otherwise the caller branch-mines at the failed target's Y.
 */
export function planRetrievalEscalation(input: {
  failedName: string
  failedTarget: Vec3Json
  known: readonly KnownResourceLike[]
  self: Vec3Json
}): RetrievalEscalation {
  let best: KnownResourceLike | null = null
  for (const resource of input.known) {
    if (resource.name !== input.failedName) continue
    const sameCell =
      resource.position.x === input.failedTarget.x &&
      resource.position.y === input.failedTarget.y &&
      resource.position.z === input.failedTarget.z
    if (sameCell) continue
    if (best === null || distance(resource.position, input.self) < distance(best.position, input.self)) {
      best = resource
    }
  }
  if (best !== null) return { kind: 'switch-resource', name: best.name, position: best.position }
  return { kind: 'branch-mine', y: input.failedTarget.y }
}

/** The exact log line emitted while a RETRIEVE makes no distance progress. */
export function formatRetrieveStalled(target: Vec3Json, dist: number, ticks: number): string {
  return `RETRIEVE_STALLED target=${target.x},${target.y},${target.z} dist=${dist} ticks=${ticks}`
}

/** The exact log line emitted when a remembered resource is dropped as unreachable. */
export function formatKnownResourceUnreachable(item: string, name: string, at: Vec3Json): string {
  return `KNOWN_RESOURCE_UNREACHABLE item=${item} name=${name} at=${at.x},${at.y},${at.z}`
}
