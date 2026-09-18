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
 */
export const PILLAR_UP_STEP_CAP = 8

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
 */
export function evaluateRetrievalProgress(input: {
  previous: RetrievalProgressState
  distance: number
  epsilon: number
  stallTicks: number
}): RetrievalProgressDecision {
  const { previous, distance: current, epsilon, stallTicks } = input
  if (current <= previous.best - epsilon) {
    return { best: current, ticks: 0, outcome: 'progress' }
  }
  const ticks = previous.ticks + 1
  if (ticks >= stallTicks) return { best: previous.best, ticks: 0, outcome: 'stalled' }
  return { best: previous.best, ticks, outcome: 'tracking' }
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
