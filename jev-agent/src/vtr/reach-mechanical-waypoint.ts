import type { Vec3Json } from '../state.ts'

/** A pathfinder-grounded, temporary mechanical checkpoint inside one Reach contract. */
export interface ReachMechanicalWaypoint {
  readonly target: Vec3Json
  readonly pathDistance: number
  readonly remainingDistance: number
  readonly planEvidence: string
}

/** Keep an in-contract path leg short enough to reobserve and replan its next path. */
export const REACH_MECHANICAL_LEG_DISTANCE = 2

function finitePosition(value: Vec3Json): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z)
}

function distance(a: Vec3Json, b: Vec3Json): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

function blockPosition(value: Vec3Json): Vec3Json {
  return { x: Math.floor(value.x), y: Math.floor(value.y), z: Math.floor(value.z) }
}

function sameBlock(a: Vec3Json, b: Vec3Json): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z
}

/**
 * Choose a temporary waypoint only from a successful live pathfinder plan.
 * This does not alter the semantic destination: the final node is intentionally
 * omitted, and only reaching the original target can let Reach VERIFY succeed.
 */
export function selectReachMechanicalWaypoint(input: {
  readonly current: Vec3Json
  readonly destination: Vec3Json
  readonly path: readonly Vec3Json[]
  readonly maxLegDistance?: number
}): ReachMechanicalWaypoint | null {
  const { current, destination, path } = input
  const maxLegDistance = input.maxLegDistance ?? REACH_MECHANICAL_LEG_DISTANCE
  if (!finitePosition(current) || !finitePosition(destination) || !Number.isFinite(maxLegDistance) || maxLegDistance <= 0) {
    return null
  }
  if (path.length === 0 || path.some((node) => !finitePosition(node))) return null

  let previous = current
  let pathDistance = 0
  let totalDistance = 0
  let checkpoint: Vec3Json | null = null
  let checkpointDistance = 0

  for (const node of path) {
    const edge = distance(previous, node)
    if (!Number.isFinite(edge)) return null
    if (edge < 0.05) continue
    totalDistance += edge
    if (checkpoint === null) {
      // Never split inside an unusually long single pathfinder move (for example
      // a parkour arc); its physical movement must remain one indivisible leg.
      if (edge > maxLegDistance) return null
      checkpoint = blockPosition(node)
      checkpointDistance = pathDistance + edge
    } else if (pathDistance + edge <= maxLegDistance) {
      checkpoint = blockPosition(node)
      checkpointDistance = pathDistance + edge
    }
    pathDistance += edge
    previous = node
  }

  // A one-leg route already fits the mechanical reobservation interval.
  if (totalDistance <= maxLegDistance || checkpoint === null) return null
  const destinationBlock = blockPosition(destination)
  if (sameBlock(checkpoint, destinationBlock)) return null

  const remainingDistance = Math.max(0, totalDistance - checkpointDistance)
  // Avoid a tiny checkpoint immediately before the actual ensure. The original
  // destination should own that final physical segment and deterministic VERIFY.
  if (remainingDistance < 0.75) return null

  return {
    target: checkpoint,
    pathDistance: checkpointDistance,
    remainingDistance,
    planEvidence: `pathfinder-success:nodes=${path.length}:distance=${totalDistance.toFixed(2)}`,
  }
}
