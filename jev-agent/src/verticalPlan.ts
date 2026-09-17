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
import type { DescentOption, Vec3Json } from './state.ts'
import { distance } from './state.ts'

/** A vertical gap larger than this (blocks) needs an explicit vertical plan. */
export const VERTICAL_GAP = 1

/** Default progress-assertion window (ticks) before a RETRIEVE is called stalled. */
export const RETRIEVAL_STALL_TICKS_DEFAULT = 40

/** `BUDDY_RETRIEVAL_STALL_TICKS` overrides the window; invalid values fall back. */
export function resolveRetrievalStallTicks(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = Number(env.BUDDY_RETRIEVAL_STALL_TICKS ?? RETRIEVAL_STALL_TICKS_DEFAULT)
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : RETRIEVAL_STALL_TICKS_DEFAULT
}

export type VerticalDir = 'E' | 'W' | 'N' | 'S'

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

export interface VerticalInput {
  /** bot feet Y (fractional is fine; it is floored) */
  selfFeetY: number
  selfPosition: Vec3Json
  target: Vec3Json
  tunnel: Vec3Json | null | undefined
  descent: readonly DescentOption[] | undefined
}

function withinTunnelReach(tunnel: Vec3Json, targetY: number, fromY: number, dy: number): boolean {
  if (dy < 0) return tunnel.y < fromY && tunnel.y >= targetY - 1
  return tunnel.y > fromY && tunnel.y <= targetY + 1
}

/**
 * Decide the vertical leg of a retrieval. Pure: same input -> same plan.
 * Returns null when the target is level (horizontal path handles it) or when an
 * upward gap has no safe dig-up primitive yet (the caller falls back to
 * explorer/climb candidates and the stall assertion).
 */
export function planVerticalApproach(input: VerticalInput): VerticalPlan | null {
  const fromY = Math.floor(input.selfFeetY)
  const targetY = input.target.y
  const dy = targetY - fromY
  if (Math.abs(dy) <= VERTICAL_GAP) return null

  const tunnel = input.tunnel ?? null
  if (tunnel !== null && withinTunnelReach(tunnel, targetY, fromY, dy)) {
    return { kind: 'reuse', tunnel, fromY, toY: targetY }
  }

  // Only a downward staircase is mechanically supported (dig the floor of the
  // adjacent cell and drop in). An upward gap relies on step/climb candidates.
  if (dy >= 0) return null

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
