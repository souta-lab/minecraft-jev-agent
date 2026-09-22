// bodyGeometry.ts - shared player-footprint geometry for SENSOR/CAN and executor/HOW.
// Pure, dependency-free: same body pose + passability facts => same headroom verdict.

export type BodyCell = { x: number; y: number; z: number }

/** Horizontal block cells touched by a player-sized AABB at `center`. */
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
  blocker: BodyCell | null
}

/** Check the two jump-headroom levels across the entire horizontal body AABB. */
export function headroomAcrossFootprint(input: HeadroomFootprintInput): HeadroomFootprintResult {
  if (
    !Number.isFinite(input.center.x) ||
    !Number.isFinite(input.center.z) ||
    !Number.isFinite(input.feetY) ||
    !Number.isFinite(input.halfWidth) ||
    input.halfWidth < 0
  ) return { clear: false, blocker: null }
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
