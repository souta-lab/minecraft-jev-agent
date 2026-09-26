// station-memory.ts - issue #31: validated, mutable station memory.
//
// WorldMemory station handling used to be append-only: a remembered furnace or
// crafting-table coordinate was merged in and never removed, so a broken,
// removed or unreachable station satisfied the planner forever and the agent
// looped on a dead coordinate. This module owns the station RECORD model, its
// validation state machine, selection (which must never override a held item)
// and registration, plus the STATION_* audit markers.
//
// POLICY (issue #31 / #78):
//   known       remembered, not yet re-verified
//   verified    block observed present and not proven unreachable
//   missing     validation failed: block gone or a different block
//   unreachable validation failed: pathfinder could not reach it
//   invalidated terminal: N failures or stale age; never selected again
//
// The pure helpers are side-effect free (they mutate only the record passed in)
// so they are unit-testable without a bot, network or host.
import type { KnownStation, StationKind, Vec3Json } from './resident-types.ts'

export const STATION_TICK_MS = 50
/** concession: after this many failed validations a station is invalidated */
export const STATION_MAX_FAILURES = 3
/** concession: a station not re-verified for this many ticks is stale and expires */
export const STATION_STALE_TICKS = 6000

const FURNACE_BLOCKS = new Set(['furnace', 'blast_furnace', 'smoker'])

export type StationInvalidationReason = 'missing' | 'unreachable' | 'stale'

export function stationItemName(kind: StationKind): string {
  return kind
}

export function stationKey(position: Vec3Json): string {
  return `${Math.round(position.x)},${Math.round(position.y)},${Math.round(position.z)}`
}

export function stationId(position: Vec3Json): string {
  return `b${Math.round(position.x)}_${Math.round(position.y)}_${Math.round(position.z)}`
}

export function stationBlockMatches(kind: StationKind, liveBlockName: string): boolean {
  if (kind === 'furnace') return FURNACE_BLOCKS.has(liveBlockName)
  return liveBlockName === 'crafting_table'
}

export function normalizeStation(
  station: Vec3Json & Partial<KnownStation>,
  kind: StationKind,
  now = Date.now(),
): KnownStation {
  const firstSeenAt = station.firstSeenAt ?? now
  return {
    x: Math.round(station.x),
    y: Math.round(station.y),
    z: Math.round(station.z),
    kind,
    firstSeenAt,
    lastVerifiedAt: station.lastVerifiedAt ?? firstSeenAt,
    status: station.status ?? 'known',
    failures: station.failures ?? 0,
  }
}

export function isStationInvalidated(station: KnownStation): boolean {
  return station.status === 'invalidated' || (station.failures ?? 0) >= STATION_MAX_FAILURES
}

export function isStationSelectable(station: KnownStation, now = Date.now()): boolean {
  if (isStationInvalidated(station)) return false
  if (station.status === 'missing' || station.status === 'unreachable') return false
  return !isStationStale(station, now)
}

export function stationAgeTicks(station: KnownStation, now = Date.now()): number {
  const last = station.lastVerifiedAt ?? station.firstSeenAt ?? now
  return Math.max(0, Math.floor((now - last) / STATION_TICK_MS))
}

/** A station out of range cannot be re-verified; once its recorded verification
 * is older than STATION_STALE_TICKS it is no longer trustworthy. */
export function isStationStale(station: KnownStation, now = Date.now()): boolean {
  return stationAgeTicks(station, now) >= STATION_STALE_TICKS
}

export function applyStationVerified(station: KnownStation, now = Date.now()): KnownStation {
  station.status = 'verified'
  station.failures = 0
  station.lastVerifiedAt = now
  return station
}

export interface StationFailureResult {
  station: KnownStation
  failures: number
  invalidated: boolean
}

export function applyStationFailure(
  station: KnownStation,
  reason: StationInvalidationReason,
  now = Date.now(),
): StationFailureResult {
  const failures = (station.failures ?? 0) + 1
  station.failures = failures
  const expired = reason === 'stale' || failures >= STATION_MAX_FAILURES
  station.status = expired ? 'invalidated' : reason
  if (reason === 'stale') station.lastVerifiedAt = station.lastVerifiedAt ?? now
  return { station, failures, invalidated: expired }
}

/** Upsert a station with a fresh verified state. Returns the stored record. */
export function registerStation(
  stations: KnownStation[],
  kind: StationKind,
  position: Vec3Json,
  now = Date.now(),
): KnownStation {
  const key = stationKey(position)
  const existing = stations.find((station) => (station.kind ?? kind) === kind && stationKey(station) === key)
  if (existing !== undefined) {
    existing.kind = kind
    applyStationVerified(existing, now)
    return existing
  }
  const created = normalizeStation(position, kind, now)
  created.firstSeenAt = now
  applyStationVerified(created, now)
  stations.push(created)
  return created
}

export interface StationSelectionInput {
  stations: readonly KnownStation[]
  kind: StationKind
  inventory: Record<string, number>
  now?: number
}

/**
 * The selection helper: return the nearest currently-usable station of `kind`,
 * or null. A HELD item always wins - when the inventory already satisfies the
 * item, no world station is offered for that prerequisite (#78).
 */
export function selectStationForRetrieval(input: StationSelectionInput): KnownStation | null {
  if ((input.inventory[stationItemName(input.kind)] ?? 0) > 0) return null
  const now = input.now ?? Date.now()
  for (const station of input.stations) {
    if ((station.kind ?? input.kind) !== input.kind) continue
    if (!isStationSelectable(station, now)) continue
    return station
  }
  return null
}

export interface StationProbe {
  station: KnownStation
  kind: StationKind
  /** live block name at the station cell, or null when the cell is not loaded */
  liveBlockName: string | null
  /** pathfinder reachability; null when the probe did not run */
  reachable: boolean | null
  now?: number
}

export type StationValidationOutcome = 'verified' | 'missing' | 'unreachable' | 'stale' | 'unverified'

export interface StationValidationResult {
  station: KnownStation
  outcome: StationValidationOutcome
  failures: number
  invalidated: boolean
  marker: string | null
}

export function stationVerifiedDetail(kind: StationKind, station: Vec3Json): Record<string, unknown> {
  return { kind, id: stationId(station), pos: positionText(station) }
}

export function stationRegisteredDetail(kind: StationKind, station: Vec3Json): Record<string, unknown> {
  return { kind, pos: positionText(station), verified: true }
}

export function stationInvalidatedDetail(
  kind: StationKind,
  station: Vec3Json,
  reason: StationInvalidationReason,
  ageTicks?: number,
): Record<string, unknown> {
  const detail: Record<string, unknown> = { kind, id: stationId(station), reason }
  if (reason === 'stale') detail.ageTicks = ageTicks ?? 0
  return detail
}

function positionText(position: Vec3Json): string {
  return `${Math.round(position.x)},${Math.round(position.y)},${Math.round(position.z)}`
}

export function formatStationVerified(kind: StationKind, station: Vec3Json): string {
  return `STATION_VERIFIED kind=${kind} id=${stationId(station)} pos=${positionText(station)}`
}

export function formatStationRegistered(kind: StationKind, station: Vec3Json): string {
  return `STATION_REGISTERED kind=${kind} pos=${positionText(station)} verified=true`
}

export function formatStationInvalidated(
  kind: StationKind,
  station: Vec3Json,
  reason: StationInvalidationReason,
  ageTicks?: number,
): string {
  const base = `STATION_INVALIDATED kind=${kind} id=${stationId(station)} reason=${reason}`
  return reason === 'stale' ? `${base} ageTicks=${ageTicks ?? 0}` : base
}

/**
 * Validate one remembered station against live world truth. A loaded cell that
 * holds the wrong block is `missing`; a loaded correct block that the
 * pathfinder cannot reach is `unreachable`; an unloaded/stale cell expires. Only
 * a loaded correct-and-not-proven-unreachable block becomes `verified`.
 */
export function validateStationProbe(probe: StationProbe): StationValidationResult {
  const now = probe.now ?? Date.now()
  const station = probe.station
  if (probe.liveBlockName !== null) {
    if (stationBlockMatches(probe.kind, probe.liveBlockName)) {
      if (probe.reachable === false) {
        const failed = applyStationFailure(station, 'unreachable', now)
        return {
          station,
          outcome: 'unreachable',
          failures: failed.failures,
          invalidated: failed.invalidated,
          marker: formatStationInvalidated(probe.kind, station, 'unreachable'),
        }
      }
      applyStationVerified(station, now)
      return { station, outcome: 'verified', failures: 0, invalidated: false, marker: formatStationVerified(probe.kind, station) }
    }
    const failed = applyStationFailure(station, 'missing', now)
    return {
      station,
      outcome: 'missing',
      failures: failed.failures,
      invalidated: failed.invalidated,
      marker: formatStationInvalidated(probe.kind, station, 'missing'),
    }
  }
  if (probe.reachable === false) {
    const failed = applyStationFailure(station, 'unreachable', now)
    return {
      station,
      outcome: 'unreachable',
      failures: failed.failures,
      invalidated: failed.invalidated,
      marker: formatStationInvalidated(probe.kind, station, 'unreachable'),
    }
  }
  if (isStationStale(station, now)) {
    applyStationFailure(station, 'stale', now)
    return {
      station,
      outcome: 'stale',
      failures: station.failures ?? 0,
      invalidated: true,
      marker: formatStationInvalidated(probe.kind, station, 'stale', stationAgeTicks(station, now)),
    }
  }
  return { station, outcome: 'unverified', failures: station.failures ?? 0, invalidated: isStationInvalidated(station), marker: null }
}

/** Drop and report every station that is already invalid or has gone stale. */
export function expireStaleStations(
  stations: KnownStation[],
  kind: StationKind,
  now = Date.now(),
): { kept: KnownStation[]; removed: KnownStation[]; markers: string[] } {
  const kept: KnownStation[] = []
  const removed: KnownStation[] = []
  const markers: string[] = []
  for (const station of stations) {
    if (isStationInvalidated(station)) {
      removed.push(station)
      continue
    }
    if (isStationStale(station, now)) {
      const ageTicks = stationAgeTicks(station, now)
      applyStationFailure(station, 'stale', now)
      removed.push(station)
      markers.push(formatStationInvalidated(kind, station, 'stale', ageTicks))
      continue
    }
    kept.push(station)
  }
  return { kept, removed, markers }
}

export function partitionStationValidity(stations: readonly KnownStation[], now = Date.now()): {
  selectable: KnownStation[]
  invalidated: KnownStation[]
  unverified: KnownStation[]
} {
  const selectable: KnownStation[] = []
  const invalidated: KnownStation[] = []
  const unverified: KnownStation[] = []
  for (const station of stations) {
    if (isStationInvalidated(station) || isStationStale(station, now)) invalidated.push(station)
    else if (station.status === 'verified') selectable.push(station)
    else unverified.push(station)
  }
  return { selectable, invalidated, unverified }
}
