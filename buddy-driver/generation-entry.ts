// generation-entry.ts - the RELOADABLE layer.
//
// Bun.build bundles this file (and everything it imports from ../jev-agent/src/**)
// into ONE hash-stamped ESM file. The host then `import()`s that single file: one
// file == one URL == the whole generation swaps atomically, so a new controller
// can never be wired to stale sibling modules.
//
// The generation wraps the battle-tested `JevController` (System One remains the
// sole action authority). The long-horizon brain is `PlannerBrain` (planner.ts):
// it answers the controller's replan summons with a BOUNDED goal list, choosing
// between the deterministic capability ladder and a batched Jev evaluation. The
// controller consumes the goal queue exactly as before, so the ledger and the
// reload path are untouched.
import type { Bot } from 'mineflayer'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Vec3 } from 'vec3'
import { JevController } from '../jev-agent/src/controller.ts'
import type { JevAgentOptions, RunSummary } from '../jev-agent/src/controller.ts'
import type { GoalQueueSnapshot, LedgerBasis, PlannedGoal, QueuedGoal } from '../jev-agent/src/goalQueue.ts'
import type { System2Brain, System2PlanRequest } from '../jev-agent/src/system2.ts'
import { resolveOptionCompilerEnabled } from '../jev-agent/src/optionSpec.ts'
import { Advisor, resolveAdvisorMode } from './advisor.ts'
import { M2SnapshotRecorder } from './m2-snapshot.ts'
import { OptionCompilingSystem2, optionSnapshotFromBot } from './option-brain.ts'
import {
  MERCURY_ALLOWED_GOALS,
  MERCURY_MODEL_DEFAULT,
  MercurySystem2,
  mercuryCallsPath,
  resolveMercuryEnablement,
} from './mercury-system2.ts'
import type { MercuryStateSummary, MercuryTriggerReason } from './mercury-system2.ts'
import { installDescendAwarePolicy } from './system-one-policy.ts'
import { assertActuationSurfaceCovered, createActuationPort, withActuationLease } from './resident-safety.ts'
import { ACTUATION_PORT_OPERATIONS } from '../jev-agent/src/actuationPort.ts'
import { portalFrameLayout } from '../jev-agent/src/netherPortalPlan.ts'
import {
  NETHER_STRUCTURE_BLOCK_NAMES,
  countSensedPortalFrameBlocks,
  detectLivePortalVerification,
  sensedVerifiedPortalSites,
} from '../jev-agent/src/state.ts'
import {
  PlannerBrain,
  RUNGS,
  bestPickaxeRank,
  buildLadder,
  buildPlanOptions,
  computeFrontier,
  countResource,
  debugFrontier,
  deriveResumeRung,
  goalAlreadyMet,
  goalsForStrategy,
  has,
  inventoryCounts,
  resolvePlannerMode,
} from './planner.ts'
import type { Counts, Rung } from './planner.ts'
import type {
  GenerationContext,
  GenerationResources,
  GenerationStatus,
  KnownPortalSiteJson,
  KnownResourceJson,
  KnownStation,
  KnownStructureSiteJson,
  KnownTraversalJson,
  MissionPreflightResult,
  ResidentGeneration,
  ResidentWorldMemory,
  ServerTruth,
  StationKind,
  StructuralSmokeResult,
  TraversalBlockReason,
  TraversalKind,
  TraversalResult,
  Vec3Json,
  WorldMemoryDelta,
} from './resident-types.ts'
import { KNOWN_RESOURCE_CAP, mergeKnownResourcesInto, mergeKnownTraversalsInto } from './resident-types.ts'
import { worldCacheNamespace } from './world-epoch.ts'
import {
  applyStationFailure,
  isStationSelectable,
  normalizeStation,
  registerStation,
  stationAgeTicks,
  stationBlockMatches,
  stationInvalidatedDetail,
  stationKey,
  stationRegisteredDetail,
  stationVerifiedDetail,
  validateStationProbe,
} from './station-memory.ts'

export const CONTRACT_VERSION = 3

// Loud-fail craft capability check: a future Mineflayer bump that removes the
// private `_syncWindow` API must fail loudly here instead of silently degrading
// to the stock `bot.craft` silent-3x3-failure path (#3906).
const TESTED_MINEFLAYER = '4.39.0'
function assertCraftCapability(bot: Bot, log: (event: string, detail?: Record<string, unknown>) => void): void {
  const syncable = bot as unknown as { _syncWindow?: unknown }
  if (typeof syncable._syncWindow !== 'function') {
    const version = (bot as unknown as { version?: string }).version ?? 'unknown'
    log('CRAFT_COMPAT', { ok: false, mineflayerTested: TESTED_MINEFLAYER, serverVersion: version, api: '_syncWindow' })
    throw new Error(
      `craftWindow unsupported: bot._syncWindow is not a function (tested with mineflayer ${TESTED_MINEFLAYER}, connected to ${version}). ` +
        'Refusing to run: stock bot.craft silently ignores 3x3 crafting clicks (PrismarineJS/mineflayer#3906).',
    )
  }
  log('CRAFT_COMPAT', { ok: true, mineflayerTested: TESTED_MINEFLAYER, api: '_syncWindow' })
}

export { debugFrontier }

/**
 * Compatibility projection for the controller's legacy scalar `goalItem/goalCount`.
 * The GoalQueue/System2 frontier is authoritative; this scalar exists only because
 * the current controller still requires a non-null root GoalState before the queue
 * is populated. Seed it from the first grounded ladder goal instead of the host's
 * historical `iron_ingot x3` default so an empty queue cannot leak a stale mission
 * into candidate grounding or a System2 state fingerprint.
 */
export function compatibilityRootGoal(
  goals: readonly PlannedGoal[],
  fallback: { goalItem: string; goalCount: number },
): { goalItem: string; goalCount: number } {
  const projected = goals.find(
    (goal) => typeof goal.targetItem === 'string' && goal.targetItem.length > 0,
  )
  if (projected?.targetItem === null || projected?.targetItem === undefined) return fallback
  return {
    goalItem: projected.targetItem,
    goalCount: Math.max(1, projected.requiredCount ?? 1),
  }
}

const STATION_VALIDATION_RADIUS = 48

type StationLog = (event: string, detail?: Record<string, unknown>) => void

function liveBlockNameAt(bot: Bot, position: Vec3Json): string | null {
  try {
    return bot.blockAt(new Vec3(position.x, position.y, position.z))?.name ?? null
  } catch {
    return null
  }
}

function asVec3Json(value: unknown): Vec3Json | null {
  if (value === null || typeof value !== 'object') return null
  const candidate = value as { x?: unknown; y?: unknown; z?: unknown }
  if (typeof candidate.x !== 'number' || typeof candidate.y !== 'number' || typeof candidate.z !== 'number') return null
  return { x: candidate.x, y: candidate.y, z: candidate.z }
}

function removeStation(stations: KnownStation[], station: KnownStation): void {
  const key = stationKey(station)
  for (let index = stations.length - 1; index >= 0; index -= 1) {
    const current = stations[index]
    if (current !== undefined && stationKey(current) === key) stations.splice(index, 1)
  }
}

/**
 * Issue #31: validate every remembered station against live world truth. A
 * loaded cell with the wrong block (or air) fails `missing`; an unloaded cell
 * older than the staleness budget fails `stale`; a loaded matching block is
 * re-verified. Failures accumulate on the durable record and invalidate it at
 * STATION_MAX_FAILURES, at which point it is returned in `removed`.
 */
function validateRememberedStations(
  bot: Bot,
  kind: StationKind,
  stations: KnownStation[],
  liveFound: readonly Vec3Json[],
  now: number,
  log: StationLog,
): { kept: KnownStation[]; removed: KnownStation[] } {
  const liveNames = new Map<string, string>()
  for (const position of liveFound) {
    const name = liveBlockNameAt(bot, position)
    if (name !== null) liveNames.set(stationKey(position), name)
  }
  const entity = bot.entity
  const kept: KnownStation[] = []
  const removed: KnownStation[] = []
  for (const station of stations) {
    const key = stationKey(station)
    let liveBlockName = liveNames.get(key) ?? null
    if (liveBlockName === null && entity !== undefined) {
      const distance = Math.hypot(entity.position.x - station.x, entity.position.y - station.y, entity.position.z - station.z)
      if (distance <= STATION_VALIDATION_RADIUS) liveBlockName = liveBlockNameAt(bot, station)
    }
    const result = validateStationProbe({ station, kind, liveBlockName, reachable: null, now })
    if (result.outcome === 'verified') {
      log('STATION_VERIFIED', stationVerifiedDetail(kind, station))
      kept.push(station)
      continue
    }
    if (result.outcome === 'stale') {
      log('STATION_INVALIDATED', stationInvalidatedDetail(kind, station, 'stale', stationAgeTicks(station, now)))
      removed.push(station)
      continue
    }
    if (result.outcome === 'missing' || result.outcome === 'unreachable') {
      log('STATION_INVALIDATED', stationInvalidatedDetail(kind, station, result.outcome))
      if (result.invalidated) removed.push(station)
      else kept.push(station)
      continue
    }
    kept.push(station)
  }
  return { kept, removed }
}

function registerLiveStations(
  bot: Bot,
  kind: StationKind,
  stations: KnownStation[],
  liveFound: readonly Vec3Json[],
  now: number,
  log: StationLog,
): number {
  const known = new Set(stations.map((station) => stationKey(station)))
  let added = 0
  for (const position of liveFound) {
    const key = stationKey(position)
    if (known.has(key)) continue
    const liveBlockName = liveBlockNameAt(bot, position)
    if (liveBlockName === null || !stationBlockMatches(kind, liveBlockName)) continue
    registerStation(stations, kind, position, now)
    log('STATION_REGISTERED', stationRegisteredDetail(kind, position))
    known.add(key)
    added += 1
  }
  return added
}

/**
 * The STATION_REGISTERED detail for a placement-verified station: `source=placed`
 * marks the cell as placed-by-us, so the marker distinguishes deterministic
 * placement proof from a sensed/remembered coincidence. Exported so the marker
 * contract is unit-testable without a bot.
 */
export function stationRegisteredPlacedDetail(kind: StationKind, position: Vec3Json): Record<string, unknown> {
  return { kind, source: 'placed', at: stationKey(position) }
}

const LOG_BLOCK_NAMES = [
  'oak_log',
  'birch_log',
  'spruce_log',
  'jungle_log',
  'acacia_log',
  'dark_oak_log',
  'mangrove_log',
  'cherry_log',
  'pale_oak_log',
  'crimson_stem',
  'warped_stem',
] as const

// The store bound and the capacity-eviction rule are owned by the durable
// contract (resident-types.ts) so the generation scan and the HOST delta merge
// cannot drift onto different caps or different eviction orders.
export { KNOWN_RESOURCE_CAP }
/**
 * Scan-side merge into the generation's replica of the durable store. Delegates
 * to the ONE bounded merge: at the cap an old redundant coordinate is evicted first
 * (`KNOWN_RESOURCE_EVICTED`), preserving the last anchor per resource identity when possible instead of the
 * sighting being dropped for the lifetime of the world key. Returns the number
 * of INSERTS (`added`), unchanged.
 */
export function mergeKnownResources(
  target: KnownResourceJson[],
  found: KnownResourceJson[],
  log?: (event: string, detail?: Record<string, unknown>) => void,
  worldEpoch?: number,
): number {
  return mergeKnownResourcesInto(target, found, { log, worldEpoch, emitInsertMarker: true }).added
}

export const KNOWN_RESOURCE_STALENESS_RADIUS = 24

export function resourceStillPresent(
  remembered: string,
  live: string | null | undefined,
): 'unknown' | 'present' | 'replaced' | 'stale' {
  if (typeof live !== 'string' || live.length === 0) return 'unknown'
  if (live === remembered) return 'present'
  const sameFamily =
    (remembered.endsWith('_ore') && live.endsWith('_ore')) || (remembered.endsWith('_log') && live.endsWith('_log'))
  return sameFamily ? 'replaced' : 'stale'
}

function resourceKey(resource: { name: string; x: number; y: number; z: number }): string {
  return `${resource.name}@${Math.round(resource.x)},${Math.round(resource.y)},${Math.round(resource.z)}`
}

/**
 * Dimension identity for comparing a remembered resource against the active
 * world key. `the_nether` and `minecraft:the_nether` are the same dimension.
 */
function normalizeDimensionId(dimension: string): string {
  return dimension.replace(/^minecraft:/, '').toLowerCase()
}

function resourceAt(resource: { x: number; y: number; z: number }): string {
  return `${Math.round(resource.x)},${Math.round(resource.y)},${Math.round(resource.z)}`
}

/**
 * Issue #14 staleness: a remembered cell close enough that the loaded chunk
 * still contains it is proof. If the block is gone (air/stone/replaced by a
 * non-resource) the durable entry is evicted and logged; if it is a different
 * ore/log variant the entry is refreshed. Out-of-range cells are left alone
 * (absence there is not proof). Mutates `known` and returns the evicted set.
 */
export function evictStaleKnownResources(
  bot: Bot,
  known: KnownResourceJson[],
  worldKey: { dimension: string; worldEpoch: number },
  log?: (event: string, detail?: Record<string, unknown>) => void,
): KnownResourceJson[] {
  const entity = bot.entity
  if (entity === undefined) return []
  const position = entity.position
  const stale: KnownResourceJson[] = []
  const staleKeys = new Set<string>()
  for (const resource of known) {
    if (resource.worldEpoch !== undefined && resource.worldEpoch !== worldKey.worldEpoch) {
      stale.push(resource)
      staleKeys.add(resourceKey(resource))
      log?.('KNOWN_RESOURCE_STALE', { item: resource.name, at: resourceAt(resource), reason: 'worldEpoch' })
      continue
    }
    // Dimension re-anchoring: a remembered coordinate only means anything in the
    // dimension it was scanned in. A portal transfer changes the dimension while
    // the worldEpoch stays the same, so a same-epoch entry from another
    // dimension must be evicted instead of live-probed at this coordinate.
    if (
      resource.dimension !== undefined &&
      resource.dimension.length > 0 &&
      normalizeDimensionId(resource.dimension) !== normalizeDimensionId(worldKey.dimension)
    ) {
      stale.push(resource)
      staleKeys.add(resourceKey(resource))
      log?.('KNOWN_RESOURCE_STALE', {
        item: resource.name,
        at: resourceAt(resource),
        reason: 'dimension',
        dimension: resource.dimension,
      })
      continue
    }
    const distance = Math.hypot(resource.x - position.x, resource.y - position.y, resource.z - position.z)
    if (distance > KNOWN_RESOURCE_STALENESS_RADIUS) continue
    let live: string | null = null
    try {
      live = bot.blockAt(new Vec3(resource.x, resource.y, resource.z))?.name ?? null
    } catch {
      live = null
    }
    const verdict = resourceStillPresent(resource.name, live)
    if (verdict === 'stale') {
      stale.push(resource)
      staleKeys.add(resourceKey(resource))
      log?.('KNOWN_RESOURCE_STALE', { item: resource.name, at: resourceAt(resource) })
    } else if (verdict === 'present' || verdict === 'replaced') {
      resource.lastSeenAt = Date.now()
      if (verdict === 'replaced' && typeof live === 'string') resource.name = live
    }
  }
  if (staleKeys.size === 0) return stale
  for (let index = known.length - 1; index >= 0; index -= 1) {
    const resource = known[index]
    if (resource !== undefined && staleKeys.has(resourceKey(resource))) known.splice(index, 1)
  }
  return stale
}

/**
 * #80: proof distance for the durable portal site. A remembered site within this
 * radius was loaded while the bot stood there, so a live re-check that finds no
 * lit portal at the site is proof the record is stale. Outside the radius,
 * absence proves nothing and the entry is left alone (same rule as #14).
 */
export const PORTAL_SITE_PROOF_DISTANCE = 8

export interface PortalSiteSyncResult {
  /** the durable list after record + refresh + eviction */
  known: KnownPortalSiteJson[]
  /** newly verified sites to merge into durable memory */
  added: KnownPortalSiteJson[]
  /** disproved / foreign-epoch sites to drop from durable memory */
  removed: KnownPortalSiteJson[]
}

function portalOriginKey(site: { x: number; y: number; z: number }): string {
  return `${Math.round(site.x)},${Math.round(site.y)},${Math.round(site.z)}`
}

function normalizePortalDimension(dimension: string): string {
  return dimension.replace(/^minecraft:/, '').toLowerCase()
}

/**
 * #80 pure durable-site lifecycle. It records live-verified portal sites, keeps
 * existing records fresh, drops records the live re-check disproved while the bot
 * is close enough to trust the absence, and drops records from a previous world
 * epoch or dimension. It never decides "go there": it only maintains the CAN
 * fact "a verified portal exists at P".
 */
export function syncKnownPortalSites(input: {
  known: readonly KnownPortalSiteJson[]
  liveVerified: readonly {
    origin: Vec3Json
    widthAxis: 'x' | 'z'
    frame?: readonly Vec3Json[]
    interior?: readonly Vec3Json[]
  }[]
  worldKey: { dimension: string; worldEpoch: number }
  position: Vec3Json
  now?: number
  proofDistance?: number
}): PortalSiteSyncResult {
  const now = input.now ?? Date.now()
  const proofDistance = input.proofDistance ?? PORTAL_SITE_PROOF_DISTANCE
  const liveKeys = new Set(input.liveVerified.map((site) => portalOriginKey(site.origin)))
  const added: KnownPortalSiteJson[] = []
  const removed: KnownPortalSiteJson[] = []
  const kept: KnownPortalSiteJson[] = []
  const seen = new Set<string>()
  for (const site of input.known) {
    const key = portalOriginKey(site)
    if (seen.has(key)) continue
    // World-epoch / dimension re-anchoring: a coordinate is only meaningful in
    // the world it was verified in, so a stale record is dropped, never probed.
    if (site.worldEpoch !== undefined && site.worldEpoch !== input.worldKey.worldEpoch) {
      removed.push(site)
      continue
    }
    if (
      site.dimension !== undefined &&
      site.dimension.length > 0 &&
      normalizePortalDimension(site.dimension) !== normalizePortalDimension(input.worldKey.dimension)
    ) {
      removed.push(site)
      continue
    }
    if (liveKeys.has(key)) {
      seen.add(key)
      kept.push({
        ...site,
        lastVerifiedAt: now,
        ...(site.frame === undefined ? {} : { frame: site.frame.map((cell) => ({ ...cell })) }),
        ...(site.interior === undefined ? {} : { interior: site.interior.map((cell) => ({ ...cell })) }),
      })
      continue
    }
    const distance = Math.hypot(site.x - input.position.x, site.y - input.position.y, site.z - input.position.z)
    // The bot is close enough that a still-lit portal would have been sensed. The
    // live re-check returned nothing at this site, so the record is disproved.
    if (distance <= proofDistance) {
      removed.push(site)
      continue
    }
    seen.add(key)
    kept.push({ ...site })
  }
  for (const site of input.liveVerified) {
    const key = portalOriginKey(site.origin)
    if (seen.has(key)) continue
    seen.add(key)
    const record: KnownPortalSiteJson = {
      x: Math.round(site.origin.x),
      y: Math.round(site.origin.y),
      z: Math.round(site.origin.z),
      widthAxis: site.widthAxis,
      dimension: input.worldKey.dimension,
      worldEpoch: input.worldKey.worldEpoch,
      lastVerifiedAt: now,
      ...(site.frame === undefined ? {} : { frame: site.frame.map((cell) => ({ ...cell })) }),
      ...(site.interior === undefined ? {} : { interior: site.interior.map((cell) => ({ ...cell })) }),
    }
    added.push(record)
    kept.push(record)
  }
  return { known: kept, added, removed }
}

/**
 * #80: expose durable portal sites as CAN-only known-resource entries. The
 * `'portal'` kind is inert to the ore/log/station retrieval matches; the sensor
 * projects it back into `portalFrameSites` so the existing portal grounding
 * machinery gets the route to the site. It never asserts the portal is lit.
 */
export function portalSiteKnownResources(
  known: readonly KnownPortalSiteJson[],
): {
  name: string
  kind: 'portal'
  position: Vec3Json
  widthAxis: 'x' | 'z'
  dimension?: string
  worldEpoch?: number
  frameCells?: Vec3Json[]
}[] {
  return known.map((site) => ({
    name: 'nether_portal',
    kind: 'portal' as const,
    position: { x: site.x, y: site.y, z: site.z },
    widthAxis: site.widthAxis,
    ...(site.dimension === undefined ? {} : { dimension: site.dimension }),
    ...(site.worldEpoch === undefined ? {} : { worldEpoch: site.worldEpoch }),
    ...(site.frame === undefined ? {} : { frameCells: site.frame.map((cell) => ({ ...cell })) }),
  }))
}

/**
 * #342: expose durable Nether fortress sites through the same CAN-only
 * known-resource envelope as the portal sites above. `structure` is distinct
 * from `ore` for observability; the candidate layer matches it by block name
 * (`NETHER_STRUCTURE_BLOCK_NAMES`), so a `blaze_rod` goal gets the grounded
 * route to the remembered body. It never asserts the body yields a blaze rod.
 */
export function structureSiteKnownResources(
  known: readonly KnownStructureSiteJson[],
): {
  name: string
  kind: 'structure'
  position: Vec3Json
  dimension?: string
  worldEpoch?: number
}[] {
  return known.map((site) => ({
    name: 'nether_bricks',
    kind: 'structure' as const,
    position: { x: site.x, y: site.y, z: site.z },
    ...(site.dimension === undefined ? {} : { dimension: site.dimension }),
    ...(site.worldEpoch === undefined ? {} : { worldEpoch: site.worldEpoch }),
  }))
}

// ---------------------------------------------------------------------------
// #354 traversal memory: producer (observed outcome -> durable fact) and
// consumer (durable fact -> grounded candidate envelope)
// ---------------------------------------------------------------------------

/** Cardinal/vertical bearing of an observed leg (`D` = down, `U` = up). */
export type TraversalDirection = 'E' | 'W' | 'N' | 'S' | 'U' | 'D'

/** Rounded cell key, the same `x,y,z` identity the durable merges use. */
export function traversalCellKey(cell: Vec3Json): string {
  return `${Math.round(cell.x)},${Math.round(cell.y)},${Math.round(cell.z)}`
}

/**
 * Bearing of an observed leg, from the dominant axis of the displacement. `+z`
 * is south in Minecraft coordinates, matching the E/W/N/S/down convention the
 * descent planner already uses.
 */
export function traversalDirection(from: Vec3Json, to: Vec3Json): TraversalDirection {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const dz = to.z - from.z
  const ax = Math.abs(dx)
  const ay = Math.abs(dy)
  const az = Math.abs(dz)
  if (ay > ax && ay > az) return dy < 0 ? 'D' : 'U'
  if (ax >= az) return dx >= 0 ? 'E' : 'W'
  return dz >= 0 ? 'S' : 'N'
}

/** Geometric traversal family of an observed leg. */
export function traversalKindFromDelta(from: Vec3Json, to: Vec3Json): TraversalKind {
  const dy = to.y - from.y
  if (dy <= -1) return 'descend'
  if (dy >= 1) return 'climb'
  return 'step'
}

/**
 * `moveFailureKey` is `<dimension>:<floor(x)>,<floor(y)>,<floor(z)>` (the
 * occupied block cell). The dimension may itself contain `:` (`minecraft:overworld`),
 * so the cell is parsed from the end. Pure and total: anything unparseable
 * yields null.
 */
export function parseMoveFailureCell(key: string): Vec3Json | null {
  const match = /:(-?\d+),(-?\d+),(-?\d+)$/.exec(key)
  if (match === null) return null
  return { x: Number(match[1]), y: Number(match[2]), z: Number(match[3]) }
}

/**
 * #354 producer, pure half: translate ONE existing controller/executor outcome
 * event into a durable traversal fact, or null when the event carries no
 * traversal outcome.
 *
 * The events are the controller's own settled-outcome stream, already wired to
 * the generation through `eventSink`:
 *   - `PATH_CALLBACK` `completed`/`failed` - the executor's path outcome with the
 *     destination cell and the typed failure `outcome`;
 *   - `MOVE_FAILMEM` - the controller refused a tracked move to a cell;
 *   - `MOVE_FAILMEM_RESET` - the controller observed a tracked move reaching a cell.
 *
 * `fromPosition` is the live body cell sampled before the outcome (server truth,
 * never a new sensor). `reasonAt` maps a known death hazard at the destination to
 * a typed reason; anything unmapped is the generic `wall` terrain refusal.
 */
export function traversalFactFromEvent(input: {
  event: string
  detail: Record<string, unknown>
  fromPosition: Vec3Json
  worldEpoch: number
  now?: number
  reasonAt?: (to: Vec3Json) => TraversalBlockReason | undefined
}): KnownTraversalJson | null {
  const from: Vec3Json = {
    x: Math.round(input.fromPosition.x),
    y: Math.round(input.fromPosition.y),
    z: Math.round(input.fromPosition.z),
  }
  let to: Vec3Json | null = null
  let result: TraversalResult | null = null
  let kind: TraversalKind | null = null
  if (input.event === 'PATH_CALLBACK') {
    const target = asVec3Json(input.detail.target)
    if (target === null) return null
    to = { x: Math.round(target.x), y: Math.round(target.y), z: Math.round(target.z) }
    if (input.detail.phase === 'completed') result = 'ok'
    else if (input.detail.phase === 'failed') result = 'blocked'
    else return null
  } else if (input.event === 'MOVE_FAILMEM' || input.event === 'MOVE_FAILMEM_RESET') {
    const key = typeof input.detail.key === 'string' ? input.detail.key : null
    to = key === null ? null : parseMoveFailureCell(key)
    if (to === null) return null
    result = input.event === 'MOVE_FAILMEM' ? 'blocked' : 'ok'
    // A descent candidate's own kind is authoritative over the raw delta (a
    // level-mode tunnel step does not change y).
    if (input.detail.kind === 'DESCEND') kind = 'descend'
  } else {
    return null
  }
  if (kind === null) kind = traversalKindFromDelta(from, to)
  // A completed leg that starts and ends in the same cell proves nothing; it is
  // also the duplicate arrival event (`PATH_CALLBACK completed` fires alongside
  // `MOVE_FAILMEM_RESET`), so never store it. A refusal in place is still a fact.
  if (result === 'ok' && traversalCellKey(from) === traversalCellKey(to)) return null
  const reason = result === 'blocked' ? (input.reasonAt?.(to) ?? 'wall') : undefined
  return {
    from,
    to,
    kind,
    result,
    ...(reason === undefined ? {} : { reason }),
    worldEpoch: input.worldEpoch,
    lastSeenAt: input.now ?? Date.now(),
  }
}

/**
 * #354 consumer, pure half: suppress a waypoint the candidate layer would
 * otherwise re-offer when a remembered `blocked` traversal covers it from where
 * the body is NOW. "Covered" means the remembered leg ended at the waypoint cell
 * and departed from the bot's current neighbourhood, so a blocked-west fact does
 * not suppress an unrelated west waypoint on the other side of the map. Pure.
 */
export const TRAVERSAL_LOCAL_RADIUS = 4

export interface TraversalSuppression {
  waypoint: Vec3Json
  fact: KnownTraversalJson
  direction: TraversalDirection
}

export function traversalIsLocal(from: Vec3Json, position: Vec3Json, radius = TRAVERSAL_LOCAL_RADIUS): boolean {
  return Math.hypot(from.x - position.x, from.y - position.y, from.z - position.z) <= radius
}

export function filterBlockedTraversalWaypoints<T extends { position: Vec3Json }>(
  waypoints: readonly T[],
  traversals: readonly KnownTraversalJson[],
  position: Vec3Json,
  worldEpoch: number,
  radius = TRAVERSAL_LOCAL_RADIUS,
): { kept: T[]; blocked: TraversalSuppression[] } {
  const blockedFacts = traversals.filter(
    (fact) =>
      fact.result === 'blocked' &&
      (fact.worldEpoch === undefined || fact.worldEpoch === worldEpoch) &&
      traversalIsLocal(fact.from, position, radius),
  )
  const kept: T[] = []
  const blocked: TraversalSuppression[] = []
  for (const waypoint of waypoints) {
    const key = traversalCellKey(waypoint.position)
    const fact = blockedFacts.find((candidate) => traversalCellKey(candidate.to) === key)
    if (fact === undefined) {
      kept.push(waypoint)
      continue
    }
    blocked.push({ waypoint: waypoint.position, fact, direction: traversalDirection(fact.from, fact.to) })
  }
  return { kept, blocked }
}

/**
 * #354 consumer, offer half: a waypoint already in the grounded envelope that a
 * remembered SUCCESSFUL traversal from the bot's neighbourhood actually reached.
 * The fact corroborates reachability; the candidate layer still chooses and the
 * executor still re-validates the cell. Pure.
 */
export function traversalHintsForWaypoints<T extends { position: Vec3Json }>(
  waypoints: readonly T[],
  traversals: readonly KnownTraversalJson[],
  position: Vec3Json,
  worldEpoch: number,
  radius = TRAVERSAL_LOCAL_RADIUS,
): { waypoint: Vec3Json; fact: KnownTraversalJson }[] {
  const okFacts = traversals.filter(
    (fact) =>
      fact.result === 'ok' &&
      (fact.worldEpoch === undefined || fact.worldEpoch === worldEpoch) &&
      traversalIsLocal(fact.from, position, radius),
  )
  const hints: { waypoint: Vec3Json; fact: KnownTraversalJson }[] = []
  for (const waypoint of waypoints) {
    const key = traversalCellKey(waypoint.position)
    const fact = okFacts.find((candidate) => traversalCellKey(candidate.to) === key)
    if (fact !== undefined) hints.push({ waypoint: waypoint.position, fact })
  }
  return hints
}

/** One entry of the grounded known-resource envelope generation-entry hands to Jev. */
export interface KnownResourceEnvelopeEntry {
  name: string
  kind: 'ore' | 'log' | 'station' | 'portal' | 'structure'
  position: Vec3Json
  dimension?: string
  worldEpoch?: number
  widthAxis?: 'x' | 'z'
  frameCells?: Vec3Json[]
}

/** `the_nether` dimension id, normalized (no `minecraft:` prefix). */
export const NETHER_DIMENSION_ID = 'the_nether'

/**
 * M3: Nether-only world truth. A Nether fortress can only exist in the Nether,
 * so a structure record may only be minted there; the same id spellings
 * (`the_nether` / `minecraft:the_nether`) are one dimension.
 */
export function isNetherDimension(dimension: string): boolean {
  return normalizeDimensionId(dimension) === NETHER_DIMENSION_ID
}

/**
 * M3: proof distance for a durable Nether-structure site record. A remembered
 * anchor within this radius was loaded while the bot stood there, so a live scan
 * that senses no structure fabric near the anchor is proof the record is stale.
 * Outside the radius, absence proves nothing (same rule as #14 / #80).
 */
export const STRUCTURE_SITE_PROOF_DISTANCE = 8

export interface StructureSiteSyncResult {
  /** the durable list after record + refresh + eviction */
  known: KnownStructureSiteJson[]
  /** newly sensed sites to merge into durable memory */
  added: KnownStructureSiteJson[]
  /** foreign-epoch/dimension or disproved sites to drop from durable memory */
  removed: KnownStructureSiteJson[]
}

function structureSiteKey(site: { x: number; y: number; z: number }): string {
  return `${Math.round(site.x)},${Math.round(site.y)},${Math.round(site.z)}`
}

/**
 * M3 pure durable Nether-structure-site lifecycle, mirroring
 * `syncKnownPortalSites`. It records structure body cells sensed in the Nether,
 * keeps existing records fresh, drops records the live scan disproved while the
 * bot is close enough to trust the absence, and drops records from a previous
 * world epoch or dimension.
 *
 * ADMISSION IS NETHER-ONLY: `nether_bricks` is a real block in any dimension
 * (a player can place it anywhere), but only a Nether sighting can be fortress
 * fabric. A non-Nether `worldKey.dimension` therefore mints nothing, so
 * overworld sensing can never produce a Nether structure record. It never decides
 * "go there": it only maintains the CAN fact "fortress fabric is at P".
 */
export function syncKnownStructureSites(input: {
  known: readonly KnownStructureSiteJson[]
  liveSensed: readonly { position: Vec3Json; kind: 'nether_fortress'; blocks: readonly string[] }[]
  worldKey: { dimension: string; worldEpoch: number }
  position: Vec3Json
  now?: number
  proofDistance?: number
}): StructureSiteSyncResult {
  const now = input.now ?? Date.now()
  const proofDistance = input.proofDistance ?? STRUCTURE_SITE_PROOF_DISTANCE
  const liveSensed = isNetherDimension(input.worldKey.dimension) ? input.liveSensed : []
  const liveKeys = new Set(liveSensed.map((site) => structureSiteKey(site.position)))
  const added: KnownStructureSiteJson[] = []
  const removed: KnownStructureSiteJson[] = []
  const kept: KnownStructureSiteJson[] = []
  const seen = new Set<string>()
  for (const site of input.known) {
    const key = structureSiteKey(site)
    if (seen.has(key)) continue
    // World-epoch / dimension re-anchoring: a coordinate is only meaningful in
    // the world it was sensed in, so a stale record is dropped, never probed.
    if (site.worldEpoch !== undefined && site.worldEpoch !== input.worldKey.worldEpoch) {
      removed.push(site)
      continue
    }
    if (
      site.dimension !== undefined &&
      site.dimension.length > 0 &&
      normalizeDimensionId(site.dimension) !== normalizeDimensionId(input.worldKey.dimension)
    ) {
      removed.push(site)
      continue
    }
    if (liveKeys.has(key)) {
      seen.add(key)
      kept.push({
        ...site,
        lastSeenAt: now,
        ...(site.blocks === undefined ? {} : { blocks: [...site.blocks] }),
      })
      continue
    }
    const distance = Math.hypot(site.x - input.position.x, site.y - input.position.y, site.z - input.position.z)
    // The bot is close enough that any fortress fabric at this anchor would have
    // been sensed. The live scan found none, so the record is disproved.
    if (distance <= proofDistance) {
      removed.push(site)
      continue
    }
    seen.add(key)
    kept.push({ ...site, ...(site.blocks === undefined ? {} : { blocks: [...site.blocks] }) })
  }
  for (const site of liveSensed) {
    const key = structureSiteKey(site.position)
    if (seen.has(key)) continue
    seen.add(key)
    const record: KnownStructureSiteJson = {
      x: Math.round(site.position.x),
      y: Math.round(site.position.y),
      z: Math.round(site.position.z),
      kind: site.kind,
      blocks: [...new Set(site.blocks)].sort(),
      dimension: input.worldKey.dimension,
      worldEpoch: input.worldKey.worldEpoch,
      lastSeenAt: now,
    }
    added.push(record)
    kept.push(record)
  }
  return { known: kept, added, removed }
}

function scanBlockPositions(bot: Bot, blockNames: readonly string[], maxDistance: number, cap: number): Vec3Json[] {
  const ids: number[] = []
  for (const name of blockNames) {
    const block = bot.registry.blocksByName[name]
    if (block !== undefined) ids.push(block.id)
  }
  if (ids.length === 0) return []
  try {
    const positions = bot.findBlocks({ matching: ids, maxDistance, count: cap })
    return positions.map((pos) => ({ x: pos.x, y: pos.y, z: pos.z }))
  } catch {
    return []
  }
}

function delay(ms: number, resources?: GenerationResources): Promise<void> {
  return new Promise((resolve) => {
    const handle = setTimeout(() => {
      resources?.untrackTimer(handle)
      resolve()
    }, ms)
    resources?.trackTimer(handle)
  })
}

interface LedgerGoal {
  kind?: string
  targetItem?: string | null
  status?: string
}

interface LedgerSnapshot {
  counter?: number
  goals?: LedgerGoal[]
}

const PICKAXE_RANK: Record<string, number> = {
  wooden_pickaxe: 1,
  stone_pickaxe: 2,
  iron_pickaxe: 3,
  diamond_pickaxe: 4,
}

/**
 * A dead bot drops its inventory; the goal-queue ledger then claims goals that
 * are no longer true. Restoring it makes the agent mine stone bare-handed. The
 * ledger is accepted only when every recorded tool/station still exists in the
 * live world or inventory (consumables like ingots/logs are excluded - those are
 * legitimately spent and their rungs express the current front, not history).
 */
export function ledgerIsConsistent(ledger: LedgerSnapshot, counts: Record<string, number>, world: ResidentWorldMemory): boolean {
  const done = new Set<string>()
  for (const goal of ledger.goals ?? []) {
    if (goal.status === 'done' && typeof goal.targetItem === 'string') done.add(goal.targetItem)
  }
  for (const [item, rank] of Object.entries(PICKAXE_RANK)) {
    if (done.has(item) && bestPickaxeRank(counts) < rank) return false
  }
  if (done.has('crafting_table') && !(has(counts, 'crafting_table') || world.craftingTables.length > 0)) return false
  if (done.has('furnace') && !(has(counts, 'furnace') || world.furnaces.length > 0)) return false
  const hasUsableFurnace = has(counts, 'furnace') || world.furnaces.length > 0
  const hasUnfinishedFurnaceAcquisition = (ledger.goals ?? []).some(
    (goal) =>
      (goal.status === 'active' || goal.status === 'pending') &&
      (goal.kind === 'craft' || goal.kind === 'place') &&
      goal.targetItem === 'furnace',
  )
  if (hasUsableFurnace && hasUnfinishedFurnaceAcquisition) return false
  return true
}

export interface LedgerGoalReopening {
  id: string
  description: string
  rungIds: string[]
  liveHave: number
  requiredCount: number
}

export interface LedgerGoalReconciliation {
  snapshot: GoalQueueSnapshot
  reopened: LedgerGoalReopening[]
}

function rungOwnsGoal(rung: Rung, goal: QueuedGoal, counts: Counts, world: ResidentWorldMemory): boolean {
  const target = goal.targetItem ?? null
  return rung.goals(counts, world).some((planned) => planned.kind === goal.kind && (planned.targetItem ?? null) === target)
}

/**
 * Reconcile a restored ledger against the LIVE bot. A `done` goal is trusted
 * only when either its own item requirement is already held, or a capability
 * rung that contains it is satisfied by the live inventory/world (a consumable
 * that was legitimately spent, e.g. raw_iron smelted into iron_ingot). A `done`
 * goal no live rung predicate covers is reopened as `pending`, so it is
 * re-activated ahead of any later-milestone goal. Pure: never mutates the input.
 */
export function reconcileLedgerGoals(
  snapshot: GoalQueueSnapshot,
  counts: Record<string, number>,
  world: ResidentWorldMemory,
): LedgerGoalReconciliation {
  const reopened: LedgerGoalReopening[] = []
  const goals = (snapshot.goals ?? []).map((goal) => {
    if (goal.status !== 'done') return { ...goal }
    const target = goal.targetItem
    if (typeof target !== 'string' || target.length === 0) return { ...goal }
    const rungs = RUNGS.filter((rung) => rung.future !== true && rungOwnsGoal(rung, goal, counts, world))
    if (rungs.length === 0) return { ...goal }
    const planned: PlannedGoal = {
      kind: goal.kind,
      description: goal.description,
      targetItem: goal.targetItem,
      requiredCount: goal.requiredCount,
    }
    if (goalAlreadyMet(planned, counts)) return { ...goal }
    if (rungs.some((rung) => rung.satisfied(counts, world))) return { ...goal }
    const liveHave = Math.max(0, countResource(counts, target))
    reopened.push({
      id: goal.id,
      description: goal.description,
      rungIds: rungs.map((rung) => rung.id),
      liveHave,
      requiredCount: goal.requiredCount,
    })
    return { ...goal, status: 'pending' as const, haveCount: Math.min(goal.haveCount, liveHave) }
  })
  return { snapshot: { ...snapshot, goals }, reopened }
}

export function selectLedgerSnapshot(
  hostSnapshot: GoalQueueSnapshot | null,
  derivedSnapshot: GoalQueueSnapshot | null,
  counts: Record<string, number>,
  world: ResidentWorldMemory,
): { source: 'host-snapshot' | 'derived-file'; snapshot: GoalQueueSnapshot; reopened: LedgerGoalReopening[] } | null {
  if (hostSnapshot !== null) {
    if (!ledgerIsConsistent(hostSnapshot, counts, world)) return null
    return { source: 'host-snapshot', ...reconcileLedgerGoals(hostSnapshot, counts, world) }
  }
  if (derivedSnapshot !== null && ledgerIsConsistent(derivedSnapshot, counts, world)) {
    return { source: 'derived-file', ...reconcileLedgerGoals(derivedSnapshot, counts, world) }
  }
  return null
}

/**
 * A durable queue is semantic state, not an all-time action history. It may be
 * restored only when its live world and mandatory frontier still match the
 * state from which it was committed. Legacy snapshots without a basis are
 * accepted only when they contain no unfinished work; otherwise the current
 * generation must re-ground instead of reviving an old Option.
 */
export function evaluateLedgerRestoreBasis(
  snapshot: GoalQueueSnapshot,
  live: LedgerBasis,
): { accept: boolean; reasons: string[] } {
  const unfinished = snapshot.goals.some((goal) => goal.status === 'active' || goal.status === 'pending')
  if (!unfinished) return { accept: true, reasons: [] }
  const basis = snapshot.basis
  if (basis === undefined) return { accept: false, reasons: ['missing_frontier_basis'] }
  const reasons: string[] = []
  if (basis.worldKey !== live.worldKey) reasons.push('world_key_changed')
  if (basis.frontierRungIndex !== live.frontierRungIndex) reasons.push('frontier_index_changed')
  if (basis.frontierRungId !== live.frontierRungId) reasons.push('frontier_id_changed')
  return { accept: reasons.length === 0, reasons }
}

interface LedgerReconciliationDecision {
  usablePath: string | null
  reason: string | null
}

/**
 * Issue #5: the generation only READS the host-owned ledger mirror. When the
 * recorded progress is inconsistent with live inventory it reports a proposal and
 * returns null; the HOST archives the file at the commit point. It never renames.
 */
function resolveLedgerPath(
  ctx: GenerationContext,
  counts: Record<string, number>,
  world: ResidentWorldMemory,
  generationId: string,
): LedgerReconciliationDecision {
  const path = ctx.ledgerPath
  if (!existsSync(path)) return { usablePath: path, reason: null }
  try {
    const ledger = JSON.parse(readFileSync(path, 'utf8')) as LedgerSnapshot
    if (ledgerIsConsistent(ledger, counts, world)) return { usablePath: path, reason: null }
    const reason = 'live inventory regressed below recorded goals'
    ctx.proposeLedgerReconciliation({ generationId, reason })
    ctx.log('LEDGER_STALE_PROPOSED', { reason, action: 'host-archive-at-commit' })
    return { usablePath: null, reason }
  } catch (error) {
    ctx.log('ERROR', { where: 'resolveLedgerPath', message: error instanceof Error ? error.message : String(error) })
    return { usablePath: path, reason: null }
  }
}

/**
 * A snapshot/plan is only usable when it is an object carrying a `goals` array.
 * The inventory-aware resume path reads `snapshot.goals`; a missing or malformed
 * snapshot (e.g. a legacy `buddy-state.json` whose `ledger` is a GoalQueueState
 * with `depth`/`current` instead of `counter`/`goals`) must degrade to an empty
 * goal list, never throw `Cannot read properties of undefined (reading 'goals')`.
 */
export function snapshotGoals(snapshot: GoalQueueSnapshot | null | undefined): GoalQueueSnapshot['goals'] {
  return Array.isArray(snapshot?.goals) ? snapshot.goals : []
}

/**
 * Restore the durable ledger into the controller. Class A says the HOST snapshot
 * is the authority (#40): the generation reads `ctx.ledgerSnapshot` first and only
 * falls back to the derived `buddy-ledger.json` compatibility mirror. A ledger
 * whose recorded tools/stations are gone from the live bot is refused.
 */
function restoreLedgerIntoController(
  controller: JevController,
  hostSnapshot: GoalQueueSnapshot | null,
  ledgerPath: string | null,
  counts: Record<string, number>,
  world: ResidentWorldMemory,
  liveBasis: LedgerBasis,
  log: (event: string, detail?: Record<string, unknown>) => void,
): void {
  let derivedSnapshot: GoalQueueSnapshot | null = null
  if (ledgerPath !== null && existsSync(ledgerPath)) {
    try {
      const parsed = JSON.parse(readFileSync(ledgerPath, 'utf8')) as GoalQueueSnapshot
      if (Array.isArray(parsed.goals) && typeof parsed.counter === 'number') derivedSnapshot = parsed
    } catch (error) {
      log('ERROR', { where: 'restoreLedgerIntoController.read', message: error instanceof Error ? error.message : String(error) })
    }
  }
  const chosen = selectLedgerSnapshot(hostSnapshot, derivedSnapshot, counts, world)
  if (chosen === null) {
    if (hostSnapshot !== null || derivedSnapshot !== null) {
      log('LEDGER_STALE', { reason: 'live inventory regressed below recorded goals', source: hostSnapshot !== null ? 'host-snapshot' : 'derived-file' })
    }
    return
  }
  const basisDecision = evaluateLedgerRestoreBasis(chosen.snapshot, liveBasis)
  if (!basisDecision.accept) {
    log('LEDGER_RESTORE_DISCARDED', {
      source: chosen.source,
      reasons: basisDecision.reasons,
      liveBasis,
      snapshotBasis: chosen.snapshot.basis ?? null,
      unfinished: chosen.snapshot.goals.filter((goal) => goal.status === 'active' || goal.status === 'pending').length,
    })
    return
  }
  try {
    const holder = controller as unknown as { queue: { restore(snapshot: GoalQueueSnapshot): void } }
    holder.queue.restore(chosen.snapshot)
    const goals = snapshotGoals(chosen.snapshot)
    const done = goals.filter((goal) => goal.status === 'done').length
    const current = goals.find((goal) => goal.status === 'active' || goal.status === 'pending')
    log('LEDGER_RESTORED', {
      source: chosen.source,
      done,
      total: goals.length,
      current: current?.description ?? null,
      reopened: chosen.reopened.length,
      basis: chosen.snapshot.basis ?? null,
    })
    if (chosen.reopened.length > 0) {
      log('LEDGER_GOAL_REOPENED', { reason: 'live predicate unmet', goals: chosen.reopened })
    }
  } catch (error) {
    log('ERROR', { where: 'restoreLedgerIntoController', message: error instanceof Error ? error.message : String(error) })
  }
}

function buildMercurySummary(
  bot: Bot,
  world: ResidentWorldMemory,
  request: System2PlanRequest,
  trigger: MercuryTriggerReason,
): MercuryStateSummary {
  const counts = inventoryCounts(bot)
  const entity = bot.entity
  const frontier = deriveResumeRung(counts, world)
  const inventory: Record<string, number> = {}
  for (const [name, n] of Object.entries(counts)) if (n > 0) inventory[name] = n
  let wait = 0
  for (let i = request.recentOutcomes.length - 1; i >= 0; i -= 1) {
    const outcome = request.recentOutcomes[i]
    if (outcome === undefined || outcome.actionId !== 'WAIT') break
    wait += 1
  }
  const recentFailures = request.recentOutcomes
    .slice(-6)
    .map((outcome) => `${outcome.actionId}:${outcome.status}${outcome.failure === null ? '' : `:${outcome.failure}`}`)
  return {
    trigger,
    wakeReason: request.reason,
    wakeDetail: request.detail.slice(0, 200),
    rung: frontier.rungId,
    rungIndex: frontier.rungIndex,
    position:
      entity === undefined
        ? null
        : { x: Math.round(entity.position.x), y: Math.round(entity.position.y), z: Math.round(entity.position.z) },
    dimension: bot.game?.dimension ?? null,
    health: entity === undefined ? null : bot.health,
    toolRank: bestPickaxeRank(counts),
    inventory,
    stations: { craftingTables: world.craftingTables.length, furnaces: world.furnaces.length },
    knownOres: [...world.discoveredOres],
    recentFailures,
    consecutiveWait: wait,
    queue: {
      depth: request.goalQueueState.depth,
      done: request.goalQueueState.done,
      current: request.goalQueueState.current?.description ?? null,
      hasImpossible: request.goalQueueState.hasImpossible,
    },
    objective: request.objective,
    deathHistory: world.hazards.map(
      (hazard) => `${hazard.reason}@${Math.round(hazard.x)},${Math.round(hazard.y)},${Math.round(hazard.z)}x${hazard.count}`,
    ),
    allowedGoals: MERCURY_ALLOWED_GOALS,
  }
}

export function createGeneration(ctx: GenerationContext): ResidentGeneration {
  const startedAt = Date.now()
  const now = startedAt
  const counts = inventoryCounts(ctx.bot)
  assertCraftCapability(ctx.bot, ctx.log)
  const world: ResidentWorldMemory = {
    craftingTables: ctx.worldMemory.craftingTables.map((station) => normalizeStation(station, 'crafting_table', now)),
    furnaces: ctx.worldMemory.furnaces.map((station) => normalizeStation(station, 'furnace', now)),
    mined: { ...ctx.worldMemory.mined },
    discoveredOres: [...ctx.worldMemory.discoveredOres],
    knownResources: (ctx.worldMemory.knownResources ?? []).map((resource) => ({ ...resource })),
    knownPortalSites: (ctx.worldMemory.knownPortalSites ?? []).map((site) => ({ ...site })),
    knownStructureSites: (ctx.worldMemory.knownStructureSites ?? []).map((site) => ({
      ...site,
      ...(site.blocks === undefined ? {} : { blocks: [...site.blocks] }),
    })),
    knownTraversals: (ctx.worldMemory.knownTraversals ?? []).map((traversal) => ({
      ...traversal,
      from: { ...traversal.from },
      to: { ...traversal.to },
    })),
    traversalFailures: (ctx.worldMemory.traversalFailures ?? []).map((t) => ({ ...t, from: { ...t.from }, toward: { ...t.toward } })),
    moveFailures: (ctx.worldMemory.moveFailures ?? []).map((entry) => ({ ...entry })),
    hazards: (ctx.worldMemory.hazards ?? []).map((h) => ({ ...h })),
    portalVerified: detectLivePortalVerification(ctx.bot),
    dimension: String(ctx.bot.game?.dimension ?? ''),
  }
  /**
   * #80: maintain the durable verified-portal-site record from live truth. The
   * verdict itself stays live (`portalVerified`); this only records where a
   * verified portal was, and drops the record when the live re-check disproves it
   * at close range or the world epoch/dimension changed.
   */
  const syncPortalSiteMemory = (reason: string): { origin: Vec3Json; widthAxis: 'x' | 'z' }[] => {
    const liveVerified = sensedVerifiedPortalSites(ctx.bot).map((site) => ({
      origin: { x: site.origin.x, y: site.origin.y, z: site.origin.z },
      widthAxis: site.widthAxis,
      ...(site.existingFrame === undefined ? {} : { frame: site.existingFrame.map((cell) => ({ ...cell })) }),
      interior: portalFrameLayout(site.origin, site.widthAxis).interior.map((cell) => ({ ...cell })),
    }))
    const entity = ctx.bot.entity
    if (entity === undefined) return liveVerified
    const result = syncKnownPortalSites({
      known: world.knownPortalSites,
      liveVerified,
      worldKey: ctx.worldKey,
      position: { x: entity.position.x, y: entity.position.y, z: entity.position.z },
    })
    world.knownPortalSites = result.known
    if (result.added.length === 0 && result.removed.length === 0) return liveVerified
    ctx.proposeWorldMemory({
      ...(result.added.length === 0 ? {} : { knownPortalSites: result.added }),
      ...(result.removed.length === 0 ? {} : { removeKnownPortalSites: result.removed }),
    })
    ctx.log('PORTAL_SITE_MEMORY', {
      reason,
      source: 'live-world',
      added: result.added.length,
      removed: result.removed.length,
      known: result.known.length,
      removedSites: result.removed.map((site) => `${site.x},${site.y},${site.z}`),
    })
    return liveVerified
  }
  /**
   * M3: maintain the durable Nether-structure-site record from live perception.
   * The record is CAN-only ("fortress fabric sensed at P"): it never decides "go
   * there" and never sets a goal. Admission is Nether-only, so an overworld
   * `nether_bricks` sighting mints nothing (see `syncKnownStructureSites`). Mirrors
   * `syncPortalSiteMemory` including the generation-start write, so the record is
   * durable before the bot wanders out of sensor range.
   */
  const syncStructureSiteMemory = (
    reason: string,
  ): { position: Vec3Json; kind: 'nether_fortress'; blocks: string[] }[] => {
    const entity = ctx.bot.entity
    if (entity === undefined) return []
    const liveSensed: { position: Vec3Json; kind: 'nether_fortress'; blocks: string[] }[] = []
    for (const position of scanBlockPositions(ctx.bot, NETHER_STRUCTURE_BLOCK_NAMES, 64, 64)) {
      const name = liveBlockNameAt(ctx.bot, position)
      if (name === null || !NETHER_STRUCTURE_BLOCK_NAMES.includes(name)) continue
      liveSensed.push({ position, kind: 'nether_fortress', blocks: [name] })
    }
    const result = syncKnownStructureSites({
      known: world.knownStructureSites,
      liveSensed,
      worldKey: ctx.worldKey,
      position: { x: entity.position.x, y: entity.position.y, z: entity.position.z },
    })
    world.knownStructureSites = result.known
    if (result.added.length === 0 && result.removed.length === 0) return liveSensed
    ctx.proposeWorldMemory({
      ...(result.added.length === 0 ? {} : { knownStructureSites: result.added }),
      ...(result.removed.length === 0 ? {} : { removeKnownStructureSites: result.removed }),
    })
    ctx.log('STRUCTURE_SITE_MEMORY', {
      reason,
      source: 'live-world',
      kind: 'nether_fortress',
      dimension: ctx.worldKey.dimension,
      added: result.added.length,
      removed: result.removed.length,
      known: result.known.length,
      removedSites: result.removed.map((site) => `${site.x},${site.y},${site.z}`),
    })
    return liveSensed
  }
  const refreshLiveFacts = (reason: string): void => {
    const nextDimension = String(ctx.bot.game?.dimension ?? '')
    if (nextDimension !== world.dimension) {
      world.dimension = nextDimension
      ctx.log('DIMENSION_TRUTH', { dimension: nextDimension, reason, source: 'live-world' })
    }
    // One live scan supplies both the durable site record and the live-only
    // verdict: `sensedVerifiedPortalSites` is the per-site form of
    // `detectLivePortalVerification`, so a non-empty result IS the verdict.
    const liveVerified = syncPortalSiteMemory(reason)
    syncStructureSiteMemory(reason)
    const next = liveVerified.length > 0
    if (next === world.portalVerified) return
    world.portalVerified = next
    ctx.log('PORTAL_TRUTH', { verified: next, reason, source: 'live-world' })
  }
  // Record a portal that was already verified at generation start (e.g. after a
  // hot reload) so it is durable before the bot can wander out of sensor range.
  syncPortalSiteMemory('generation-start')
  // Same for a Nether-structure site already in scan range at generation start.
  syncStructureSiteMemory('generation-start')
  const id = `gen-${startedAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const m2Snapshot =
    ctx.runId === undefined || ctx.m2SnapshotDir === undefined
      ? null
      : new M2SnapshotRecorder({
          runId: ctx.runId,
          generationId: id,
          bootSourceSha: ctx.bootSourceSha ?? null,
          buildHash: ctx.buildHash ?? null,
          worldEpoch: ctx.worldKey.worldEpoch,
          worldKey: `${ctx.worldKey.serverId}|${ctx.worldKey.dimension}|${ctx.worldKey.worldEpoch}`,
          dir: ctx.m2SnapshotDir,
          readInventory: () => inventoryCounts(ctx.bot),
          initialInventory: counts,
          log: (event, detail) => ctx.log(event, detail),
        })
  ctx.log('M2_SNAPSHOT_INIT', {
    enabled: m2Snapshot !== null,
    runId: ctx.runId ?? null,
    dir: ctx.m2SnapshotDir ?? null,
    path: m2Snapshot?.path ?? null,
  })
  const bot = withActuationLease(ctx.bot, ctx.lease, id, ctx.resources, ctx.log)
  // #38: the generation actuates through this allowlist capability. Every method
  // asserts the lease; the raw Bot is not the actuation contract. The dev-only
  // surface check proves the nested capabilities are guarded, not raw.
  const actuationPort = createActuationPort(bot, ctx.lease, id, ctx.log)
  const surface = assertActuationSurfaceCovered(bot, ctx.log)
  ctx.log('ACTUATION_PORT_READY', {
    id,
    operations: ACTUATION_PORT_OPERATIONS,
    surfaceOk: surface.ok,
    surfaceUncovered: surface.uncovered,
  })
  if (world.moveFailures.length > 0) {
    ctx.log('MOVE_FAILMEM_RESTORED', {
      entries: world.moveFailures.length,
      blacklisted: world.moveFailures.filter((entry) => entry.blacklistedUntil > Date.now()).length,
    })
  }

  const tables = scanBlockPositions(bot, ['crafting_table'], 48, 64)
  const furnaces = scanBlockPositions(bot, ['furnace', 'blast_furnace', 'smoker'], 48, 32)
  const ores = scanBlockPositions(
    bot,
    ['iron_ore', 'deepslate_iron_ore', 'diamond_ore', 'deepslate_diamond_ore', 'coal_ore', 'deepslate_coal_ore', 'copper_ore', 'gold_ore'],
    64,
    64,
  )
  const logs = scanBlockPositions(bot, LOG_BLOCK_NAMES, 64, 64)
  // Obsidian is a non-ore direct drop required by the M2 portal plan
  // (`collect:obsidian`). Keep it in durable known-resource memory so the
  // candidate layer's known-coordinate retrieval survives after the block
  // leaves the live sensor range. It is deliberately NOT added to the `ores`
  // scan: `discoveredOres` stays `_ore`-only and obsidian carries no
  // prospecting semantics.
  const obsidian = scanBlockPositions(bot, ['obsidian'], 64, 32)
  const stationRuntimeLog = (event: string, detail?: Record<string, unknown>): void => ctx.log(event, detail)
  const tableValidation = validateRememberedStations(bot, 'crafting_table', world.craftingTables, tables, now, stationRuntimeLog)
  const furnaceValidation = validateRememberedStations(bot, 'furnace', world.furnaces, furnaces, now, stationRuntimeLog)
  const newTables = registerLiveStations(bot, 'crafting_table', tableValidation.kept, tables, now, stationRuntimeLog)
  const newFurnaces = registerLiveStations(bot, 'furnace', furnaceValidation.kept, furnaces, now, stationRuntimeLog)
  const durableTables = tableValidation.kept
  const durableFurnaces = furnaceValidation.kept
  const removedStations: KnownStation[] = [...tableValidation.removed, ...furnaceValidation.removed]
  world.craftingTables = durableTables.filter((station) => isStationSelectable(station, now))
  world.furnaces = durableFurnaces.filter((station) => isStationSelectable(station, now))

  const runtimeFailedStations = new Set<string>()

  function durableStations(kind: StationKind): KnownStation[] {
    return kind === 'furnace' ? durableFurnaces : durableTables
  }

  function stationRuntimeFailure(kind: StationKind, position: Vec3Json): void {
    const dedupeKey = `${kind}:${stationKey(position)}`
    if (runtimeFailedStations.has(dedupeKey)) return
    runtimeFailedStations.add(dedupeKey)
    const durable = durableStations(kind)
    let station = durable.find((current) => (current.kind ?? kind) === kind && stationKey(current) === stationKey(position))
    if (station === undefined) {
      station = normalizeStation(position, kind, now)
      durable.push(station)
    }
    const result = applyStationFailure(station, 'unreachable', Date.now())
    stationRuntimeLog('STATION_INVALIDATED', stationInvalidatedDetail(kind, station, 'unreachable'))
    if (result.invalidated) removeStation(durable, station)
    removeStation(kind === 'furnace' ? world.furnaces : world.craftingTables, station)
    ctx.proposeWorldMemory({
      ...(kind === 'furnace' ? { furnaces: [...durable] } : { craftingTables: [...durable] }),
      ...(result.invalidated ? { removeStations: [station] } : {}),
    })
  }

  function stationRuntimeUse(kind: StationKind, position: Vec3Json, source: 'placed' | null = null): void {
    const durable = durableStations(kind)
    const alreadyKnown = durable.some(
      (station) => (station.kind ?? kind) === kind && stationKey(station) === stationKey(position),
    )
    const registered = registerStation(durable, kind, position, Date.now())
    const selectable = kind === 'furnace' ? world.furnaces : world.craftingTables
    if (!selectable.some((current) => stationKey(current) === stationKey(registered))) selectable.push(registered)
    if (source === 'placed') {
      if (!alreadyKnown) stationRuntimeLog('STATION_REGISTERED', stationRegisteredPlacedDetail(kind, position))
    } else {
      stationRuntimeLog('STATION_REGISTERED', stationRegisteredDetail(kind, position))
    }
    ctx.proposeWorldMemory(kind === 'furnace' ? { furnaces: [...durable] } : { craftingTables: [...durable] })
  }

  function handleStationEvent(event: string, detail: Record<string, unknown> | undefined): void {
    if (event === 'KNOWN_RESOURCE_UNREACHABLE') {
      const item = typeof detail?.item === 'string' ? detail.item : null
      const at = asVec3Json(detail?.at)
      if (at !== null && (item === 'furnace' || item === 'crafting_table')) stationRuntimeFailure(item, at)
      return
    }
    if (event === 'RETRIEVE_STALLED') {
      const at = asVec3Json(detail?.target)
      if (at === null) return
      for (const kind of ['furnace', 'crafting_table'] as const) {
        if (durableStations(kind).some((current) => stationKey(current) === stationKey(at))) stationRuntimeFailure(kind, at)
      }
      return
    }
    if (event === 'FURNACE_READY') {
      const at = asVec3Json(detail?.target)
      if (at !== null) stationRuntimeUse('furnace', at, detail?.source === 'placed' ? 'placed' : null)
    }
  }

  const unusableStationKeys = new Set<string>()
  for (const station of [...durableFurnaces, ...durableTables]) {
    if (isStationSelectable(station, now)) continue
    unusableStationKeys.add(`${station.kind ?? 'furnace'}:${stationKey(station)}`)
  }
  const discoveredOres: string[] = []
  const foundResources: KnownResourceJson[] = []
  const seenAt = Date.now()
  for (const ore of ores) {
    const name = bot.blockAt(new Vec3(ore.x, ore.y, ore.z))?.name ?? 'unknown_ore'
    if (!world.discoveredOres.includes(name)) world.discoveredOres.push(name)
    if (!discoveredOres.includes(name)) discoveredOres.push(name)
    foundResources.push({
      name,
      kind: 'ore',
      x: ore.x,
      y: ore.y,
      z: ore.z,
      dimension: ctx.worldKey.dimension,
      worldEpoch: ctx.worldKey.worldEpoch,
      lastSeenAt: seenAt,
    })
  }
  for (const log of logs) {
    const name = bot.blockAt(new Vec3(log.x, log.y, log.z))?.name ?? 'unknown_log'
    foundResources.push({
      name,
      kind: 'log',
      x: log.x,
      y: log.y,
      z: log.z,
      dimension: ctx.worldKey.dimension,
      worldEpoch: ctx.worldKey.worldEpoch,
      lastSeenAt: seenAt,
    })
  }
  for (const block of obsidian) {
    const name = bot.blockAt(new Vec3(block.x, block.y, block.z))?.name ?? 'obsidian'
    foundResources.push({
      name,
      // The `'ore'` kind is the name-scanned-resource bucket the candidate
      // layer's known retrieval matches on; producing this entry does not
      // assert obsidian is an ore (see DIRECT_BLOCK_SOURCES in state.ts).
      kind: 'ore',
      x: block.x,
      y: block.y,
      z: block.z,
      dimension: ctx.worldKey.dimension,
      worldEpoch: ctx.worldKey.worldEpoch,
      lastSeenAt: seenAt,
    })
  }
  // M3: Nether fortress body cells also become remembered resource coordinates,
  // so the existing `RETRIEVE:known` machinery has a grounded route to the
  // fortress after it leaves live sensor range (the `blaze_rods` step's target).
  // Dimension-gated exactly like the durable structure record: `nether_bricks`
  // placed in the overworld is a real block but not a fortress landmark, so it is
  // never recorded as a blaze_rod route there.
  if (isNetherDimension(ctx.worldKey.dimension)) {
    for (const position of scanBlockPositions(bot, NETHER_STRUCTURE_BLOCK_NAMES, 64, 64)) {
      const name = liveBlockNameAt(bot, position)
      if (name === null || !NETHER_STRUCTURE_BLOCK_NAMES.includes(name)) continue
      foundResources.push({
        name,
        // Same name-scanned-resource bucket as obsidian: this records the
        // fortress landmark cell, it does NOT assert that nether bricks yield
        // blaze_rod (see DIRECT_BLOCK_SOURCES in state.ts).
        kind: 'ore',
        x: position.x,
        y: position.y,
        z: position.z,
        dimension: ctx.worldKey.dimension,
        worldEpoch: ctx.worldKey.worldEpoch,
        lastSeenAt: seenAt,
      })
    }
  }
  const staleRemovals = evictStaleKnownResources(bot, world.knownResources, ctx.worldKey, (event, detail) => ctx.log(event, detail))
  const newKnownResources = mergeKnownResources(
    world.knownResources,
    foundResources,
    (event, detail) => ctx.log(event, detail),
    ctx.worldKey.worldEpoch,
  )
  const proposal: WorldMemoryDelta = {
    craftingTables: durableTables,
    furnaces: durableFurnaces,
    removeStations: removedStations,
    discoveredOres,
    knownResources: foundResources,
    removeKnownResources: staleRemovals,
    knownTraversals: world.knownTraversals,
    traversalFailures: world.traversalFailures,
    moveFailures: world.moveFailures,
  }
  // The generation proposes; the HOST is the only writer that commits.
  ctx.proposeWorldMemory(proposal)
  ctx.log('WORLDMEMORY', {
    worldKey: `${ctx.worldKey.serverId}|${ctx.worldKey.dimension}|${ctx.worldKey.worldEpoch}`,
    craftingTables: world.craftingTables.length,
    newCraftingTables: newTables,
    furnaces: world.furnaces.length,
    newFurnaces,
    discoveredOres: world.discoveredOres,
    knownResources: world.knownResources.length,
    newKnownResources,
    knownTraversals: world.knownTraversals.length,
    moveFailures: world.moveFailures.length,
    removedStations: removedStations.length,
  })

  const resume = deriveResumeRung(counts, world, (event, detail) => ctx.log(event, detail))
  const ledger = resolveLedgerPath(ctx, counts, world, id)
  const ledgerPath = ledger.usablePath
  const ladder = buildLadder(counts, world, (event, detail) => ctx.log(event, detail), {
    dimension: ctx.bot.game?.dimension ?? null,
    placedFurnacesNear: furnaces.length,
    knownFurnaces: world.furnaces.length,
    resumeRungIndex: resume.rungIndex,
    // #80: a durable verified portal site is a complete 10-block frame. Feeding
    // its coverage makes the portal rung re-verify the existing lit portal instead
    // of planning a second obsidian collection/build after a respawn.
    portalFrameBlocks: Math.max(countSensedPortalFrameBlocks(ctx.bot), world.knownPortalSites.length > 0 ? 10 : 0),
  })
  if (ladder.unsatisfiable !== null) {
    ctx.log('LADDER_UNSATISFIABLE', { reason: ladder.unsatisfiable, rungId: ladder.rungId })
  }

  // A reset resumes from the LIVE inventory; `invEmpty` is computed, not assumed.
  if (ctx.resetReason !== null || resume.rungIndex > 0) {
    const resumeReason = ctx.resetReason ?? 'inventory-resume'
    const resumeGoals = snapshotGoals(ctx.ledgerSnapshot)
    if (ctx.ledgerSnapshot === null || !Array.isArray(ctx.ledgerSnapshot.goals)) {
      ctx.log('LADDER_RESUME_NO_SNAPSHOT', { reason: resumeReason, goals: resumeGoals.length })
    }
    ctx.log('LADDER_RESUME', {
      rung: resume.rungId,
      rungIndex: resume.rungIndex,
      reason: resumeReason,
      invEmpty: resume.invEmpty,
      ...(resume.fallbackFrom === null ? {} : { fallbackFrom: resume.fallbackFrom, fallbackNeed: resume.fallbackNeed }),
      inventory: counts,
    })
  }
  if (ctx.resetReason !== null) {
    ctx.log('LADDER_RESET', {
      reason: ctx.resetReason,
      invEmpty: resume.invEmpty,
      rungIndex: ladder.rungIndex,
      rungId: ladder.rungId,
      goals: ladder.goals.map((goal) => goal.description),
    })
  }

  // The planner IS the env switch: deterministic keeps the original single-shot
  // contract, so every decision record truthfully reports `llm.called == false`.
  // `llm` turns the controller's exception paths into bounded replans.
  const plannerMode = resolvePlannerMode()

  // OWNER DIRECTIVE: a model failure is never hidden. The host terminator logs a
  // FATAL line (through each component's log) and exits non-zero, so the resident
  // process stops instead of silently degrading to the deterministic ladder.
  const terminateResident = (): never => {
    ctx.log('ERROR', { code: 'MODEL_UNAVAILABLE', action: 'terminate-resident', pid: process.pid, exitCode: 1 })
    process.exit(1)
  }

  // Durable caches (survive hot reloads; keyed by world-state hash).
  const cacheNamespace = worldCacheNamespace(ctx.worldKey)
  const cachePath = fileURLToPath(new URL(`./planner-cache-${cacheNamespace}.json`, import.meta.url))
  const advisorCachePath = fileURLToPath(new URL(`./advisor-cache-${cacheNamespace}.json`, import.meta.url))
  const advisor = new Advisor({
    log: (event, detail) => ctx.log(event, detail),
    cachePath: advisorCachePath,
    mode: resolveAdvisorMode(plannerMode),
    terminate: terminateResident,
    compile: (strategy, state) =>
      goalsForStrategy(strategy, state.inventory, world, {
        placedFurnacesNear: furnaces.length,
        knownFurnaces: world.furnaces.length,
      }),
  })

  const postDeathRecovery = ctx.resetReason === 'death'
  const mercuryConfigPath = process.env.BUDDY_SYSTEM2_CONFIG ?? join(process.cwd(), 'system2.config.json')
  const mercuryEnablement = resolveMercuryEnablement(plannerMode, mercuryConfigPath)
  const mercuryCachePath = fileURLToPath(new URL(`./mercury-cache-${cacheNamespace}.json`, import.meta.url))
  const mercury = mercuryEnablement.enabled
    ? new MercurySystem2({
        summarize: (request, trigger) => buildMercurySummary(bot, world, request, trigger),
        log: (event, detail) => ctx.log(event, detail),
        callsPath: mercuryCallsPath(ctx.logDir),
        cachePath: mercuryCachePath,
        worldKey: { serverId: ctx.worldKey.serverId, dimension: ctx.worldKey.dimension, worldEpoch: ctx.worldKey.worldEpoch },
        terminate: terminateResident,
        postDeathRecovery,
      })
    : undefined

  /**
   * #354 producer (the ONLY one): route a settled controller/executor locomotion
   * outcome from the existing `eventSink` stream into the durable traversal
   * store. No new sensor: `from` is the body cell sampled from server truth at
   * the previous observed outcome (so a completion records the leg it actually
   * traversed, not the arrival cell).
   */
  const traversalReasonAt = (to: Vec3Json): TraversalBlockReason | undefined => {
    const hazard = world.hazards.find(
      (h) => Math.round(h.x) === to.x && Math.round(h.y) === to.y && Math.round(h.z) === to.z,
    )
    if (hazard === undefined) return undefined
    if (hazard.reason === 'lava') return 'lava'
    if (hazard.reason === 'fall') return 'fall'
    if (hazard.reason === 'void') return 'void'
    return undefined
  }
  const liveCell = (): Vec3Json | null => {
    const position = ctx.bot.entity?.position
    if (position === undefined || position === null) return null
    return { x: Math.round(position.x), y: Math.round(position.y), z: Math.round(position.z) }
  }
  let traversalFromCell: Vec3Json | null = liveCell()
  const recordTraversalOutcome = (event: string, detail: Record<string, unknown>): void => {
    const from = traversalFromCell ?? liveCell()
    if (from === null) return
    const fact = traversalFactFromEvent({
      event,
      detail,
      fromPosition: from,
      worldEpoch: ctx.worldKey.worldEpoch,
      reasonAt: traversalReasonAt,
    })
    if (fact !== null) {
      mergeKnownTraversalsInto(world.knownTraversals, [fact], { log: (e, d) => ctx.log(e, d) })
      ctx.proposeWorldMemory({ knownTraversals: [fact] })
      ctx.log('TRAVERSAL_RECORDED', {
        from: traversalCellKey(fact.from),
        to: traversalCellKey(fact.to),
        kind: fact.kind,
        result: fact.result,
        ...(fact.reason === undefined ? {} : { reason: fact.reason }),
      })
    }
    const next = liveCell()
    if (next !== null) traversalFromCell = next
  }

  /**
   * #354 consumer (the ONLY one): project durable traversal facts into the SAME
   * grounded known-resource envelope the candidate layer already reads, instead
   * of adding a candidate-layer hook. A remembered `blocked` leg from the bot's
   * neighbourhood removes the waypoint cell it covers, so the candidate layer
   * cannot re-offer that direction; a remembered `ok` leg only corroborates a
   * reachable waypoint (TRAVERSAL_HINT). Both are envelope-level facts: Jev still
   * chooses, the executor still re-validates the cell, and no ranking is added.
   */
  const knownResourceEnvelope: KnownResourceEnvelopeEntry[] = [
    ...world.knownResources
      .filter((resource) => {
        if (resource.kind !== 'station') return true
        // Holding a station makes PLACE the preferred prerequisite path, but
        // it does not make remembered world stations disappear.  In a cave
        // with no valid placement spot, hiding every known furnace/table
        // collapses the prerequisite ladder to WAIT even though retrieval is
        // still a grounded fallback.
        return !unusableStationKeys.has(`${resource.name}:${stationKey(resource)}`)
      })
      .map((resource) => ({
        name: resource.name,
        kind: resource.kind,
        position: { x: resource.x, y: resource.y, z: resource.z },
        ...(resource.dimension === undefined ? {} : { dimension: resource.dimension }),
        ...(resource.worldEpoch === undefined ? {} : { worldEpoch: resource.worldEpoch }),
      })),
    // Keep durable stations in the controller envelope even when the same
    // item is held.  `planPrereqOptions` still ranks a valid held placement
    // first; these entries are the fallback when placement geometry refuses.
    ...world.furnaces.map((furnace) => ({
      name: 'furnace',
      kind: 'station' as const,
      position: { x: furnace.x, y: furnace.y, z: furnace.z },
    })),
    ...world.craftingTables.map((table) => ({
      name: 'crafting_table',
      kind: 'station' as const,
      position: { x: table.x, y: table.y, z: table.z },
    })),
    // #80: durable verified-portal sites ride the same known-resource envelope.
    // The `portal` kind is CAN-only: it is the grounded route back to a site the
    // live detector already verified, never a claim that the portal is lit now.
    ...portalSiteKnownResources(world.knownPortalSites),
    // #342: durable Nether fortress sites ride the same envelope so the
    // `blaze_rods` goal gets a grounded route to the remembered body.
    ...structureSiteKnownResources(world.knownStructureSites ?? []),
  ]
  const traversalProjectionCell = liveCell() ?? { x: 0, y: 0, z: 0 }
  const traversalProjection = filterBlockedTraversalWaypoints(
    knownResourceEnvelope,
    world.knownTraversals,
    traversalProjectionCell,
    ctx.worldKey.worldEpoch,
  )
  const groundedWaypoints = traversalProjection.kept
  for (const suppression of traversalProjection.blocked) {
    ctx.log('TRAVERSAL_BLOCKED', {
      from: traversalCellKey(suppression.fact.from),
      dir: suppression.direction,
      reason: suppression.fact.reason ?? 'wall',
      waypoint: traversalCellKey(suppression.waypoint),
    })
  }
  for (const hint of traversalHintsForWaypoints(
    groundedWaypoints,
    world.knownTraversals,
    traversalProjectionCell,
    ctx.worldKey.worldEpoch,
  )) {
    ctx.log('TRAVERSAL_HINT', { waypoint: traversalCellKey(hint.waypoint), source: 'memory' })
  }

  const rootGoal = compatibilityRootGoal(ladder.goals, { goalItem: ctx.goalItem, goalCount: ctx.goalCount })
  if (rootGoal.goalItem !== ctx.goalItem || rootGoal.goalCount !== ctx.goalCount) {
    ctx.log('ROOT_GOAL_PROJECTED', {
      source: 'ladder-frontier',
      goalItem: rootGoal.goalItem,
      goalCount: rootGoal.goalCount,
      legacyGoalItem: ctx.goalItem,
      legacyGoalCount: ctx.goalCount,
      rungId: ladder.rungId,
    })
  }

  const options: Partial<JevAgentOptions> = {
    goalItem: rootGoal.goalItem,
    goalCount: rootGoal.goalCount,
    heartbeatMs: 3000,
    // A resident never stops on a timer and never aborts a wedge: the host would
    // have to restart the generation, so make the controller self-heal instead.
    maxRuntimeMs: 0,
    wedgeStallMs: 12 * 60 * 60 * 1000,
    wedgeRepeatLimit: 24,
    failureStreakLimit: 6,
    candidateFailureLimit: 3,
    finishOnObjectiveComplete: false,
    // Dynamic planner: the controller wakes System 2 on queue_empty /
    // action_impossible / no_progress / need_llm and consumes whatever bounded
    // goal list it returns.
    // OWNER DIRECTIVE (#11): LLM and Jev invocation are MANDATORY. The Jev action
    // policy uses the real TypeSafeJevPolicy whenever a gateway key resolves;
    // deterministic is opt-in only via BUDDY_POLICY=fallback (offline/CI).
    singleShotPlanner: plannerMode === 'deterministic',
    // Bounded replan frequency: the planner also throttles LLM calls itself, but
    // keep the controller from re-summoning every tick while a goal is blocked.
    llmCooldownMs: 15000,
    ledgerPath: null,
    stopAfterSubgoals: 0,
    logDir: ctx.logDir,
    // Real Jev policy by default (key from the gateway key file or
    // AI_GATEWAY_API_KEY); deterministic fallback only when explicitly requested.
    forceFallbackPolicy: (process.env.BUDDY_POLICY ?? '').trim().toLowerCase() === 'fallback',
    worldEpoch: ctx.worldKey.worldEpoch,
    terminateOnModelFailure: terminateResident,
    actuation: 'pathfinder',
    actuationPort,
    reach: 5,
    scanRadius: 48,
    verbose: true,
    eventSink: (event, detail) => {
      ctx.log(event, { ...detail, generationId: id })
      m2Snapshot?.recordMarker(event, detail)
      const actionId = typeof detail.actionId === 'string' ? detail.actionId : null
      const verified = detail.verified === true
      const status = typeof detail.status === 'string' ? detail.status : null
      if (actionId !== null && status !== null) m2Snapshot?.recordTerminal(actionId, { verified, status })
      handleStationEvent(event, detail)
      // #354: the ONE traversal producer. The executor/controller outcome stream
      // is already mirrored here; no extra listener or sensor is added.
      recordTraversalOutcome(event, detail)
    },
    moveFailureEntries: world.moveFailures,
    onMoveFailureMemoryChange: (entries) => {
      world.moveFailures = entries.map((entry) => ({ ...entry }))
      ctx.proposeWorldMemory({ moveFailures: world.moveFailures })
    },
    knownResources: groundedWaypoints,
  }

  const controller = new JevController(bot, options)
  // The stock fallback has no DESCEND branch; without this wrapper a stalled
  // stone/iron goal whose only productive candidate is a descent step WAITs
  // forever and wedges. Hazards from death are excluded here.
  installDescendAwarePolicy(controller, world.hazards, (event, detail) => ctx.log(event, detail))
  const liveLedgerBasis: LedgerBasis = {
    worldKey: `${ctx.worldKey.serverId}|${ctx.worldKey.dimension}|${ctx.worldKey.worldEpoch}`,
    frontierRungId: resume.rungId,
    frontierRungIndex: resume.rungIndex,
  }
  restoreLedgerIntoController(controller, ctx.ledgerSnapshot, ledgerPath, counts, world, liveLedgerBasis, ctx.log)
  const brain = new PlannerBrain({
    bot,
    world,
    log: (event, detail) => ctx.log(event, detail),
    cachePath,
    worldKey: { serverId: ctx.worldKey.serverId, dimension: ctx.worldKey.dimension, worldEpoch: ctx.worldKey.worldEpoch },
    mode: plannerMode,
    advisor,
    mercury,
    terminate: terminateResident,
    postDeathRecovery,
    refreshLiveFacts: () => refreshLiveFacts('system2-grounding'),
  })

  // #21: opt-in Option compiler. OFF by default, so the planner output continues
  // to enter the GoalQueue verbatim (the ledger and deterministic guarantees are
  // untouched). When BUDDY_OPTION_COMPILER is enabled, every planned goal is
  // compiled into a grounded OptionSpec and unmet preconditions are expanded into
  // their prerequisite chain before the queue is seeded.
  const optionCompilerEnabled = resolveOptionCompilerEnabled()
  const system2: System2Brain = optionCompilerEnabled
    ? new OptionCompilingSystem2(brain, {
        log: (event, detail) => ctx.log(event, detail),
        snapshot: () => optionSnapshotFromBot(ctx.bot, world, ctx.bot.game?.dimension ?? null),
      })
    : brain
  controller.setSystem2(system2)

  ctx.log('GENERATION_READY', {
    id,
    rungIndex: ladder.rungIndex,
    rungId: ladder.rungId,
    goals: ladder.goals.map((goal) => goal.description),
    policy: controller.policyKind,
    policyProvider: controller.policyProvider,
    model: controller.policyModel,
    policyModel: controller.policyModel,
    system2Provider: controller.system2Provider,
    system2Model: controller.system2Model,
    system2AuthorityStack: controller.system2AuthorityStack,
    system2LastAuthority: { provider: controller.system2Provider, model: controller.system2Model },
    deterministicFallbackEnabled: controller.deterministicFallbackEnabled,
    planner: brain.mode,
    plannerModel: brain.model,
    plannerCache: cachePath,
    advisor: mercuryEnablement.enabled
      ? `${mercury?.provider ?? 'gateway-system2'}:${mercury?.model ?? process.env.BUDDY_SYSTEM2_MODEL ?? process.env.BUDDY_MERCURY_MODEL ?? MERCURY_MODEL_DEFAULT}`
      : resolveAdvisorMode(plannerMode),
    advisorSource: mercuryEnablement.source,
    optionCompiler: optionCompilerEnabled,
    futureRungs: ladder.futureRungIds,
    prereqReplaced: ladder.prereqReplaced,
    craftingTables: world.craftingTables.length,
    furnaces: world.furnaces.length,
  })

  let stopped: string | null = null
  let runPromise: Promise<void> | null = null
  let ready = false

  function attach(): void {
    // The controller registers its own bot listeners in start(); nothing to do.
  }

  function start(): void {
    if (runPromise !== null) return
    ctx.lease.assertActive(id, 'generation.start')
    controller.start()
    ready = true
    runPromise = controller
      .wait()
      .then((result: RunSummary) => {
        stopped = result.stopped
        ctx.log('GENERATION_STOP', {
          id,
          stopped: result.stopped,
          success: result.success,
          ticks: result.ticks,
          verifiedDigs: result.verifiedDigs,
          subgoalsDone: result.subgoalsDone,
          subgoalCount: result.subgoalCount,
          jevCalls: result.jevCalls,
        })
        proposeLedger()
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        stopped = 'generation-error'
        ctx.log('ERROR', { id, where: 'generation.wait', message })
      })
  }

  async function quiesce(): Promise<void> {
    try {
      controller.stop()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.log('ERROR', { id, where: 'quiesce.stop', message })
    }
    proposeLedger()
    // Bounded settle: the executor cancels the in-flight action on stop.
    await Promise.race([runPromise ?? Promise.resolve(), delay(3000, ctx.resources)])
  }

  function proposeLedger(): void {
    try {
      const holder = controller as unknown as { queue: { snapshot(): GoalQueueSnapshot } }
      const current = deriveResumeRung(inventoryCounts(bot), world)
      const basis: LedgerBasis = {
        worldKey: `${ctx.worldKey.serverId}|${ctx.worldKey.dimension}|${ctx.worldKey.worldEpoch}`,
        frontierRungId: current.rungId,
        frontierRungIndex: current.rungIndex,
      }
      ctx.proposeLedger({ generationId: id, baseRevision: ctx.snapshotRevision, ledger: { ...holder.queue.snapshot(), basis } })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.log('ERROR', { id, where: 'proposeLedger', message })
    }
  }

  function readTruth(): ServerTruth {
    const entity = bot.entity
    const raw = entity === undefined ? null : entity.position
    return {
      position: raw === null || raw === undefined ? null : { x: raw.x, y: raw.y, z: raw.z },
      health: entity === undefined ? null : bot.health,
      food: entity === undefined ? null : bot.food,
      dimension: bot.game?.dimension ?? null,
      onGround: entity === undefined ? null : (entity.onGround ?? null),
      inventory: inventoryCounts(bot),
    }
  }

  function status(): GenerationStatus {
    refreshLiveFacts('status')
    const truth = readTruth()
    const frontier = deriveResumeRung(truth.inventory, world)
    const current = controller.agent.current
    return {
      running: controller.isRunning,
      policyKind: controller.policyKind,
      policyProvider: controller.policyProvider,
      policyModel: controller.policyModel,
      system2Provider: controller.system2Provider,
      system2Model: controller.system2Model,
      system2AuthorityStack: controller.system2AuthorityStack,
      system2LastAuthority: { provider: controller.system2Provider, model: controller.system2Model },
      deterministicFallbackEnabled: controller.deterministicFallbackEnabled,
      queue: controller.goalQueueState,
      currentAction:
        current === null ? null : { id: current.id, kind: current.kind, phase: current.phase, startedAt: current.startedAt },
      truth,
      plannedGoals: ladder.goals.length,
      rungIndex: frontier.rungIndex,
      rungId: frontier.rungId,
      ledgerBasis: {
        worldKey: `${ctx.worldKey.serverId}|${ctx.worldKey.dimension}|${ctx.worldKey.worldEpoch}`,
        frontierRungId: frontier.rungId,
        frontierRungIndex: frontier.rungIndex,
      },
      ready,
      contractVersion: CONTRACT_VERSION,
      worldKey: ctx.worldKey,
    }
  }

  function structuralSmoke(): StructuralSmokeResult {
    const checks: string[] = []
    const failures: string[] = []
    const check = (name: string, fn: () => boolean): void => {
      try {
        if (fn()) checks.push(name)
        else failures.push(name)
      } catch (error) {
        failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    check('id', () => typeof id === 'string' && id.length > 0)
    check('startedAt', () => Number.isFinite(startedAt))
    check('rungId', () => typeof ladder.rungId === 'string' && ladder.rungId.length > 0)
    check('contract-version', () => CONTRACT_VERSION === 3)
    check('status-readable', () => {
      const s = status()
      return typeof s.running === 'boolean' && typeof s.policyKind === 'string' && s.policyKind.length > 0
    })
    check('snapshot-schema', () => {
      const s = status()
      return (
        typeof s.queue === 'object' &&
        s.queue !== null &&
        typeof s.queue.done === 'number' &&
        typeof s.queue.depth === 'number' &&
        typeof s.plannedGoals === 'number' &&
        typeof s.rungIndex === 'number'
      )
    })
    check('sensor-truth-dto', () => {
      const t = status().truth
      if (t.position === null) return t.health === null || typeof t.health === 'number'
      return (
        Number.isFinite(t.position.x) &&
        Number.isFinite(t.position.y) &&
        Number.isFinite(t.position.z) &&
        Object.getPrototypeOf(t.position) === Object.prototype
      )
    })
    check('pure-buildLadder', () => buildLadder({}, world).goals.length > 0)
    check('pure-buildPlanOptions', () => Array.isArray(buildPlanOptions({}, world)))
    check('pure-computeFrontier', () => typeof computeFrontier({}, world).rungIndex === 'number')
    return { ok: failures.length === 0, checks, failures }
  }

  function missionPreflight(): MissionPreflightResult {
    const goalCount = ladder.goals.length
    return { ok: goalCount >= 1, reason: goalCount >= 1 ? null : 'planner produced an empty plan', goalCount }
  }

  return {
    id,
    startedAt,
    rungIndex: ladder.rungIndex,
    rungId: ladder.rungId,
    attach,
    start,
    quiesce,
    dispose: () => {
      try {
        controller.stop()
      } catch {
        // best effort
      }
    },
    status,
    structuralSmoke,
    missionPreflight,
    stopReason: () => stopped,
    hasStopped: () => stopped !== null,
  }
}

export default createGeneration
