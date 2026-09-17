// simdeath.ts - rehearsal isolation (#26) and pre-loss telemetry (#34) for the
// operator `simdeath` control command. Pure data helpers only: no Bot, no
// network, no file IO, so the invariants are unit-testable.
//
// #26: a simulated death must never add to the real hazard memory. Simulation
// hazards live in a separate in-memory namespace that keyedMemory()/cloneMemory()
// never read, so they can never feed candidate filtering or hardHazards.
// #34: lostInventory/itemsLost must be captured BEFORE any toss/clear.
import type { DeathHazard, HazardSource, Vec3Json } from './resident-types.ts'

export type RehearsalMode = 'soft' | 'hard'

export interface DeathTelemetry {
  lostInventory: Record<string, number>
  itemsLost: number
  /** true when the snapshot was taken before the death command dropped/cleared anything */
  capturedBeforeDrop: boolean
}

export function summarizeInventory(inv: Record<string, number>): { lostInventory: Record<string, number>; itemsLost: number } {
  const lostInventory: Record<string, number> = {}
  for (const [name, count] of Object.entries(inv)) {
    if (count > 0) lostInventory[name] = count
  }
  return { lostInventory, itemsLost: Object.values(lostInventory).reduce((sum, count) => sum + count, 0) }
}

/** Snapshot the inventory a death is about to destroy. Call BEFORE tossing. (#34) */
export function capturePreLossInventory(read: () => Record<string, number>): DeathTelemetry {
  const { lostInventory, itemsLost } = summarizeInventory(read())
  return { lostInventory, itemsLost, capturedBeforeDrop: true }
}

/** Only a real death may touch the durable production hazard set (#26). */
export function shouldRegisterHazard(source: HazardSource): boolean {
  return source === 'production'
}

/** `simdeath` defaults to the non-destructive soft rehearsal; `--hard` is explicit. */
export function parseRehearsalMode(args: Record<string, unknown> | undefined): RehearsalMode {
  if (args === undefined) return 'soft'
  const hard = args.hard === true || args.hard === 'true' || args.hard === 1 || args.mode === 'hard'
  return hard ? 'hard' : 'soft'
}

// Separate, non-durable rehearsal namespace. Nothing in the resident reads this
// for planning or candidate filtering; it exists only for operator diagnostics.
const rehearsalHazards: DeathHazard[] = []
const REHEARSAL_HAZARD_CAP = 128

export function recordRehearsalHazard(pos: Vec3Json, reason: string): DeathHazard {
  const key = `${Math.round(pos.x)},${Math.round(pos.y)},${Math.round(pos.z)}`
  const existing = rehearsalHazards.find(
    (hazard) => `${hazard.x},${hazard.y},${hazard.z}` === key,
  )
  if (existing !== undefined) {
    existing.count += 1
    existing.reason = reason
    existing.lastSeenAt = Date.now()
    return existing
  }
  const created: DeathHazard = {
    x: Math.round(pos.x),
    y: Math.round(pos.y),
    z: Math.round(pos.z),
    reason,
    count: 1,
    source: 'simulation',
    firstSeenAt: Date.now(),
    lastSeenAt: Date.now(),
  }
  rehearsalHazards.push(created)
  if (rehearsalHazards.length > REHEARSAL_HAZARD_CAP) rehearsalHazards.shift()
  return created
}

export function rehearsalHazardsSnapshot(): DeathHazard[] {
  return rehearsalHazards.map((hazard) => ({ ...hazard }))
}

export function resetRehearsalHazards(): void {
  rehearsalHazards.length = 0
}

/**
 * Split proposed hazards by provenance. The production caller merges only the
 * `production` half; simulation entries can never reach the durable set (#26).
 */
export function partitionHazardsBySource(found: readonly DeathHazard[]): {
  production: DeathHazard[]
  simulation: DeathHazard[]
} {
  const production: DeathHazard[] = []
  const simulation: DeathHazard[] = []
  for (const hazard of found) {
    if (hazard.source === 'simulation') simulation.push(hazard)
    else production.push(hazard)
  }
  return { production, simulation }
}
