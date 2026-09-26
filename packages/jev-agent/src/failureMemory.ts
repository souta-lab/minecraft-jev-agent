// failureMemory.ts - coarse, decaying failure identity for movement candidates.
//
// #8a: failure memory was keyed by exact candidate id. Because candidate ids
// encode the exact target coordinate, a blocked bot picking a *nearby* cell got
// a fresh bucket and evaded the limit, so it wandered around the same obstacle
// forever. We keep the exact bucket and add a coarse spatial bucket keyed by
// (candidate kind, quantized target cell); lookups consider the spatial bucket's
// 3x3x3 neighbourhood so "changed by one or two blocks" no longer resets the
// strategy-level memory. Buckets also decay with age.

export const SPATIAL_GRID = 3
export const FAILURE_DECAY_MS = 30_000

const CANDIDATE_ID = /^([A-Z]+):.*?([bp])(-?\d+)_(-?\d+)_(-?\d+)$/

interface ParsedCandidateId {
  kind: string
  x: number
  y: number
  z: number
}

export function parseCandidateTarget(candidateId: string): ParsedCandidateId | null {
  const match = CANDIDATE_ID.exec(candidateId)
  if (match === null) return null
  const [, kind, , x, y, z] = match
  if (kind === undefined || x === undefined || y === undefined || z === undefined) return null
  return { kind, x: Number(x), y: Number(y), z: Number(z) }
}

function quantize(value: number): number {
  return Math.floor(value / SPATIAL_GRID)
}

/** Coarse bucket id for a candidate's spatial identity, or null when unparseable. */
export function spatialFailureKey(candidateId: string): string | null {
  const parsed = parseCandidateTarget(candidateId)
  if (parsed === null) return null
  return `${parsed.kind}@${quantize(parsed.x)},${quantize(parsed.y)},${quantize(parsed.z)}`
}

/** Coarse bucket plus its 3x3x3 neighbourhood, so nearby coords share memory. */
export function spatialNeighborhoodKeys(candidateId: string): string[] {
  const parsed = parseCandidateTarget(candidateId)
  if (parsed === null) return []
  const qx = quantize(parsed.x)
  const qy = quantize(parsed.y)
  const qz = quantize(parsed.z)
  const keys: string[] = []
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dz = -1; dz <= 1; dz += 1) {
        keys.push(`${parsed.kind}@${qx + dx},${qy + dy},${qz + dz}`)
      }
    }
  }
  return keys
}

/**
 * Failure count for a candidate: the exact bucket OR any coarse spatial bucket
 * in its neighbourhood, whichever is larger. Pure; the caller owns the map.
 */
export function failureCount(failed: Record<string, number>, candidateId: string): number {
  let best = failed[candidateId] ?? 0
  for (const key of spatialNeighborhoodKeys(candidateId)) {
    const count = failed[key] ?? 0
    if (count > best) best = count
  }
  return best
}

/** Age-based decay: one failure point per `FAILURE_DECAY_MS` of age. */
export function decayedFailureCount(count: number, ageMs: number): number {
  if (ageMs <= FAILURE_DECAY_MS) return count
  return Math.max(0, count - Math.floor(ageMs / FAILURE_DECAY_MS))
}

/** Candidate ids used for movement/traversal failure memory (not mining). */
const MOVEMENT_KINDS = new Set(['MOVE', 'RETREAT', 'DESCEND', 'STEP'])

export function isMovementCandidate(candidateId: string): boolean {
  const parsed = parseCandidateTarget(candidateId)
  return parsed !== null && MOVEMENT_KINDS.has(parsed.kind)
}
