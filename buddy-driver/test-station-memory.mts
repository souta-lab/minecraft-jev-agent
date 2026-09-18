// test-station-memory.mts - issue #31: WorldMemory stations are validated and
// mutable, not add-only. Pure: no bot, no network, no live host.
//
// (a) a stale/unreachable station is not selected and is invalidated after N failures
// (b) a valid station is selected and verified
// (c) station lookup never overrides a held inventory item
// (d) re-registration refreshes a stale entry and makes it selectable again
// (e) an invalidated station is not selected again while the invalidation is in effect
import type { KnownStation } from './resident-types.ts'
import {
  STATION_MAX_FAILURES,
  STATION_STALE_TICKS,
  STATION_TICK_MS,
  applyStationFailure,
  formatStationInvalidated,
  formatStationRegistered,
  formatStationVerified,
  isStationInvalidated,
  isStationSelectable,
  normalizeStation,
  registerStation,
  selectStationForRetrieval,
  stationInvalidatedDetail,
  stationRegisteredDetail,
  stationVerifiedDetail,
  validateStationProbe,
} from './station-memory.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

const POS = { x: 29, y: 61, z: 35 }
const ID = 'b29_61_35'

function verified(kind: 'furnace' | 'crafting_table', now: number): KnownStation {
  const station = normalizeStation(POS, kind, now)
  station.status = 'verified'
  station.lastVerifiedAt = now
  station.failures = 0
  return station
}

/** Mirrors the HOST log formatter (`event key=value ...`) so the marker text is
 * asserted exactly as it appears in buddy.log. */
function formatMarker(event: string, detail: Record<string, unknown>): string {
  const parts = Object.entries(detail).map(([key, value]) => `${key}=${String(value)}`)
  return `${event} ${parts.join(' ')}`
}

addCase('(a) stale/unreachable station is not selected and invalidates after N failed validations', () => {
  const now = 1_000_000
  const station = verified('furnace', now)
  const stations = [station]
  const selectedWhileHealthy = selectStationForRetrieval({ stations, kind: 'furnace', inventory: {}, now })
  let selectedAfterFailure: KnownStation | null = null
  let invalidatedAt = -1
  for (let attempt = 1; attempt <= STATION_MAX_FAILURES; attempt += 1) {
    const result = validateStationProbe({ station, kind: 'furnace', liveBlockName: 'air', reachable: null, now: now + attempt })
    if (result.invalidated) invalidatedAt = attempt
    selectedAfterFailure = selectStationForRetrieval({ stations, kind: 'furnace', inventory: {}, now: now + attempt })
  }
  const pass =
    selectedWhileHealthy !== null &&
    selectedAfterFailure === null &&
    invalidatedAt === STATION_MAX_FAILURES &&
    isStationInvalidated(station) &&
    station.failures === STATION_MAX_FAILURES
  return {
    pass,
    detail: `healthy=${selectedWhileHealthy !== null} afterFailure=${String(selectedAfterFailure)} invalidatedAt=${invalidatedAt}/${STATION_MAX_FAILURES} failures=${String(station.failures)}`,
  }
})

addCase('(a2) a station the pathfinder reports unreachable is not selectable', () => {
  const now = 2_000_000
  const station = verified('furnace', now)
  const result = validateStationProbe({ station, kind: 'furnace', liveBlockName: 'furnace', reachable: false, now })
  const selected = selectStationForRetrieval({ stations: [station], kind: 'furnace', inventory: {}, now })
  const pass = result.outcome === 'unreachable' && result.marker === `STATION_INVALIDATED kind=furnace id=${ID} reason=unreachable` && selected === null
  return { pass, detail: `outcome=${result.outcome} selected=${String(selected)} marker=${String(result.marker)}` }
})

addCase('(b) a valid station is selected and verified', () => {
  const now = 3_000_000
  const station = normalizeStation(POS, 'furnace', now)
  const result = validateStationProbe({ station, kind: 'furnace', liveBlockName: 'furnace', reachable: true, now })
  const selected = selectStationForRetrieval({ stations: [station], kind: 'furnace', inventory: {}, now })
  const pass =
    result.outcome === 'verified' &&
    result.marker === `STATION_VERIFIED kind=furnace id=${ID} pos=29,61,35` &&
    station.status === 'verified' &&
    station.failures === 0 &&
    selected === station
  return { pass, detail: `outcome=${result.outcome} status=${String(station.status)} selected=${selected === station} marker=${String(result.marker)}` }
})

addCase('(c) station lookup never overrides a held inventory item', () => {
  const now = 4_000_000
  const station = verified('furnace', now)
  const selectedHeld = selectStationForRetrieval({ stations: [station], kind: 'furnace', inventory: { furnace: 1 }, now })
  const selectedEmpty = selectStationForRetrieval({ stations: [station], kind: 'furnace', inventory: {}, now })
  const pass = selectedHeld === null && selectedEmpty === station
  return { pass, detail: `held=${String(selectedHeld)} empty=${selectedEmpty === station}` }
})

addCase('(d) re-registration refreshes a stale entry and makes it selectable again', () => {
  const now = 5_000_000
  const stale = normalizeStation(POS, 'furnace', now)
  stale.status = 'verified'
  stale.lastVerifiedAt = now - STATION_STALE_TICKS * STATION_TICK_MS - 1
  const before = selectStationForRetrieval({ stations: [stale], kind: 'furnace', inventory: {}, now })
  const registered = registerStation([stale], 'furnace', POS, now)
  const after = selectStationForRetrieval({ stations: [stale], kind: 'furnace', inventory: {}, now })
  const pass =
    before === null &&
    registered === stale &&
    stale.status === 'verified' &&
    stale.failures === 0 &&
    stale.lastVerifiedAt === now &&
    after === stale
  return { pass, detail: `before=${String(before)} after=${after === stale} status=${String(stale.status)} lastVerifiedAt=${String(stale.lastVerifiedAt)}` }
})

addCase('(d2) re-registration clears accumulated failures below the invalid threshold', () => {
  const now = 6_000_000
  const station = verified('furnace', now)
  applyStationFailure(station, 'missing', now)
  const blocked = selectStationForRetrieval({ stations: [station], kind: 'furnace', inventory: {}, now })
  registerStation([station], 'furnace', POS, now)
  const revived = selectStationForRetrieval({ stations: [station], kind: 'furnace', inventory: {}, now })
  const pass = blocked === null && station.failures === 0 && revived === station
  return { pass, detail: `blocked=${String(blocked)} failures=${String(station.failures)} revived=${revived === station}` }
})

addCase('(e) an invalidated station is not selected again while the invalidation is in effect', () => {
  const now = 7_000_000
  const station = verified('furnace', now)
  station.status = 'invalidated'
  station.failures = STATION_MAX_FAILURES
  const selected = selectStationForRetrieval({ stations: [station], kind: 'furnace', inventory: {}, now })
  const partitionSelectable = isStationSelectable(station, now)
  const pass = selected === null && partitionSelectable === false && isStationInvalidated(station)
  return { pass, detail: `selected=${String(selected)} selectable=${partitionSelectable} status=${String(station.status)}` }
})

addCase('station markers match the required STATION_* vocabulary', () => {
  const now = 8_000_000
  const station = verified('furnace', now)
  const invalid = formatStationInvalidated('furnace', POS, 'missing')
  const stale = formatStationInvalidated('furnace', POS, 'stale', 4321)
  const verifiedMarker = formatStationVerified('furnace', POS)
  const registered = formatStationRegistered('furnace', POS)
  const invalidatedDetail = formatMarker('STATION_INVALIDATED', stationInvalidatedDetail('furnace', POS, 'missing'))
  const staleDetail = formatMarker('STATION_INVALIDATED', stationInvalidatedDetail('furnace', POS, 'stale', 4321))
  const verifiedDetail = formatMarker('STATION_VERIFIED', stationVerifiedDetail('furnace', POS))
  const registeredDetail = formatMarker('STATION_REGISTERED', stationRegisteredDetail('furnace', POS))
  const pass =
    invalid === `STATION_INVALIDATED kind=furnace id=${ID} reason=missing` &&
    stale === `STATION_INVALIDATED kind=furnace id=${ID} reason=stale ageTicks=4321` &&
    verifiedMarker === `STATION_VERIFIED kind=furnace id=${ID} pos=29,61,35` &&
    registered === 'STATION_REGISTERED kind=furnace pos=29,61,35 verified=true' &&
    invalidatedDetail === invalid &&
    staleDetail === stale &&
    verifiedDetail === verifiedMarker &&
    registeredDetail === registered
  return { pass, detail: `${invalid} | ${stale} | ${verifiedMarker} | ${registered}` }
})

let failures = 0
process.stdout.write('WorldMemory station validation + invalidation (#31)\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} station-memory cases passed\n`)
if (failures > 0) process.exit(1)
