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
import type { DescentOption, StepCut, Vec3Json } from './state.ts'
import { distance } from './state.ts'

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
 */
export const PILLAR_UP_STEP_CAP = 24

/**
 * Altitude gain (blocks) toward a retrieval target that counts as progress in
 * `evaluateRetrievalProgress`. A one-block climb must not be mistaken for a
 * stall just because the 3D distance barely moved (56-block gap: 1/56 < the
 * 0.5 m distance epsilon).
 */
export const ASCENT_PROGRESS_EPSILON = 0.9

/**
 * Blocks that may be placed under the feet for a PILLAR_UP, in preference order.
 * The first name with a positive inventory count wins, so the choice is
 * deterministic and only solid, non-hazard building blocks are ever used.
 */
export const PILLAR_PLACE_PRIORITY: readonly string[] = [
  'cobblestone',
  'stone',
  'deepslate',
  'andesite',
  'diorite',
  'granite',
  'dirt',
  'netherrack',
  'oak_planks',
  'spruce_planks',
]

export interface PlaceableBlock {
  name: string
  count: number
}

/** Pick the held pillar block from inventory counts; null when none is usable. */
export function selectPlaceableBlock(counts: Readonly<Record<string, number>>): PlaceableBlock | null {
  for (const name of PILLAR_PLACE_PRIORITY) {
    const count = counts[name] ?? 0
    if (count > 0) return { name, count }
  }
  return null
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

/** One probed neighbour column for the grounded pillar fallback. */
export interface PillarColumnProbe {
  /** feet cell of the neighbour column (same Y as the refused column) */
  cell: Vec3Json
  /** full solid support under the column */
  supported: boolean
  /** the feet cell itself is open */
  feetClear: boolean
  /** the block above the feet is open */
  headClear: boolean
  /** the second jump cell above the feet is open (2-block headroom) */
  aboveHeadClear: boolean
  /** fluid/hazard anywhere in the neighbour column (feet-1..feet+2) */
  unsafe: boolean
}

/**
 * Deterministic selection of an adjacent, grounded pillar column when the
 * current column's ceiling cannot be cleared. Only same-level columns with
 * solid support and 2-block headroom qualify; the caller passes probes in a
 * fixed direction/level order, and strict `<` keeps that order as the
 * tie-break, so there is no randomness and no flip-flop.
 */
export function selectPillarFallbackColumn(
  probes: readonly PillarColumnProbe[],
  selfFeet: Vec3Json,
): Vec3Json | null {
  let best: { cell: Vec3Json; score: number } | null = null
  for (const probe of probes) {
    if (!probe.supported || !probe.feetClear || !probe.headClear || !probe.aboveHeadClear) continue
    if (probe.unsafe) continue
    const dy = Math.abs(probe.cell.y - selfFeet.y)
    const horizontal = Math.hypot(probe.cell.x - selfFeet.x, probe.cell.z - selfFeet.z)
    const score = dy * 100 + horizontal
    if (best === null || score < best.score) best = { cell: probe.cell, score }
  }
  return best?.cell ?? null
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
   * sensor-side column safety; false refuses the pillar plan (default true so
   * pure callers that have no hazard scan keep the old behaviour)
   */
  columnSafe?: boolean
}

function withinTunnelReach(tunnel: Vec3Json, targetY: number, fromY: number, dy: number): boolean {
  if (dy < 0) return tunnel.y < fromY && tunnel.y >= targetY - 1
  return tunnel.y > fromY && tunnel.y <= targetY + 1
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

function planUpward(input: VerticalInput, fromY: number, targetY: number, dy: number): VerticalPlan | null {
  const upStep = selectUpStep(input, fromY, targetY)
  if (upStep !== null) return upStep
  if (input.columnSafe === false) return null
  const placeable = input.placeable ?? null
  if (placeable === null || placeable.count < 1) return null
  const steps = Math.min(dy, PILLAR_UP_STEP_CAP)
  if (steps < 1) return null
  return {
    kind: 'pillar',
    fromY,
    toY: fromY + steps,
    steps,
    placeName: placeable.name,
    placeCount: placeable.count,
  }
}

/**
 * Decide the vertical leg of a retrieval. Pure: same input -> same plan.
 * Returns null when the target is level (horizontal path handles it) or when an
 * upward gap has neither a safe step cut nor a held pillar block, in which case
 * the caller falls back to explorer/climb candidates and the stall assertion.
 */
export function planVerticalApproach(input: VerticalInput): VerticalPlan | null {
  const fromY = Math.floor(input.selfFeetY)
  const targetY = input.target.y
  const dy = targetY - fromY
  if (dy === 0) return null

  const tunnel = input.tunnel ?? null

  if (dy > 0) {
    if (tunnel !== null && withinTunnelReach(tunnel, targetY, fromY, dy)) {
      return { kind: 'reuse', tunnel, fromY, toY: targetY }
    }
    return planUpward(input, fromY, targetY, dy)
  }

  // A one-block drop needs no vertical leg (the horizontal path steps down it).
  if (Math.abs(dy) <= VERTICAL_GAP) return null

  if (tunnel !== null && withinTunnelReach(tunnel, targetY, fromY, dy)) {
    return { kind: 'reuse', tunnel, fromY, toY: targetY }
  }

  const steps = (input.descent ?? []).filter(
    (step) => step.mode === 'down' && step.safe && step.diggable === true,
  )
  if (steps.length === 0) return null

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
  if (best === null) return null

  const dig = best.mode === 'down' ? (best.floorSolid ? best.floor : best.wall) : best.wall
  return {
    kind: 'staircase',
    dir: best.dir,
    fromY,
    toY: targetY,
    dig,
    step: best.step,
    digName: best.digName ?? null,
    harvestTool: best.digHarvestTool ?? null,
    harvestTier: best.digHarvestTier ?? null,
  }
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
