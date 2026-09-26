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
// from the human mission and current grounded world facts. The controller consumes
// the goal queue exactly as before, so the ledger and reload path are untouched.
import type { Bot } from 'mineflayer'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Vec3 } from 'vec3'
import { JevController } from '../jev-agent/src/controller.ts'
import { bindSelfAirMetadataProjection } from '../jev-agent/src/air.ts'
import { FatalModelError, ModelRecoveryRequested } from '../jev-agent/src/modelFailure.ts'
import { modelFailureAuthorityKind, modelFailureDisposition, stopGenerationForModelRecovery } from './model-recovery.ts'
import type { JevAgentOptions, RunSummary } from '../jev-agent/src/controller.ts'
import type { GoalQueueSnapshot, LedgerBasis, PlannedGoal, QueuedGoal } from '../jev-agent/src/goalQueue.ts'
import type { System2Brain, System2PlanRequest } from '../jev-agent/src/system2/service.ts'
import { canonicalDimensionId, createDimensionObserver, normalizeDimensionId } from './dimension-observer.ts'
import { createDimensionProvenanceView, writeRefusal } from './dimension-provenance.ts'
import type { DimensionProvenance } from '../jev-agent/src/state.ts'
import type { DimensionProvenanceView } from './dimension-provenance.ts'
import { HUMAN_INTENT_MAX_COUNT, parseHumanIntentCommand, parseQuantityReply } from './human-intent.ts'
import { M2SnapshotRecorder } from './m2-snapshot.ts'
import { evaluateMilestonePredicates } from './milestone-predicate-eval.ts'
import { OptionCompilingSystem2, optionSnapshotFromBot } from './option-brain.ts'
import {
  MERCURY_ALLOWED_GOALS,
  MERCURY_MODEL_DEFAULT,
  MercurySystem2,
  mercuryCallsPath,
  resolveMercuryEnablement,
  SYSTEM2_HUMAN_MISSION,
} from './mercury-system2.ts'
import { MERCURY_DEATH_HISTORY_LIMIT } from './mercury-system2.ts'
import type { MercuryStateSummary, MercuryTriggerReason } from './mercury-system2.ts'
import { SYSTEM2_SEMANTIC_HISTORY_LIMIT } from '../jev-agent/src/system2/causal-history.ts'
import {
  formatSystem2PayloadAbsentLine,
  formatSystem2PayloadLine,
  formatSystem2PayloadRefusedLine,
  projectSystem2PayloadFacts,
} from '../jev-agent/src/system2/payload.ts'
import type { System2RouteMemoryInput } from '../jev-agent/src/system2/payload.ts'
import { installDescendAwarePolicy } from './system-one-policy.ts'
import { assertActuationSurfaceCovered, createActuationPort, withActuationLease } from './resident-safety.ts'
import { createKernelAuthoritySession } from './kernel-authority-session.ts'
import type { MutationAuthorityContext } from '../jev-agent/src/reach/kernel-authority-map.ts'
import { ACTUATION_PORT_OPERATIONS } from '../jev-agent/src/actuationPort.ts'
import { isContainerBlockName, normalizeBlockName } from '../jev-agent/src/containerAccess.ts'
import { NETHER_PORTAL, PORTAL_VERIFIED, portalFrameLayout } from '../jev-agent/src/netherPortalPlan.ts'
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
  dominatedPrerequisiteReason,
  goalAlreadyMet,
  has,
  inventoryCounts,
  isMandatoryRung,
  resolvePlannerMode,
  rungConsumesItem,
  rungProducesGoal,
  starvationFact,
  worldOutcomeRungFloor,
} from './planner.ts'
import type { Counts, DurableLadderProgress, DurableLadderSource, Rung } from './planner.ts'
import { formatPlanIdentity } from '../jev-agent/src/goalQueue.ts'
import type { PlanIdentity, PlanObsoleteProof } from '../jev-agent/src/goalQueue.ts'
import type {
  DeathRecoveryContext,
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
  WorldKey,
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

/** Host-owned lineage attached to mirrored controller markers for run-scoped evidence. */
export function bindGenerationEventIdentity(
  detail: Record<string, unknown>,
  identity: { runId: string | null; generationId: string; sourceSha: string | null; buildHash: string | null },
): Record<string, unknown> {
  return { ...detail, ...identity }
}

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
 * The dynamic System2 queue owns semantic WHAT; the scalar is only a mechanical
 * inventory counter before a queue item exists. Deterministic baseline mode can
 * still project its legacy ladder into that counter, but production/model mode
 * keeps the configured objective instead of deriving a benchmark rung from it.
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
/**
 * The durable world fact a verified container placement records, or null when
 * the event does not carry a container cell. Exported so the mapping is
 * unit-testable without a bot: the EXECUTOR logs `CONTAINER_READY source=placed
 * block=<name> at=x,y,z` with the cell as a `target` object (and the text form
 * in `at`), and this is the one place that turns it into memory.
 *
 * It is deliberately the generic `kind: 'station'` known-resource record, not a
 * new memory schema: the sensor already merges those into
 * `WorldState.containers` as `remembered` entries, which is exactly the
 * "the block is now in the world, do not re-plan a placement" fact.
 */
export function containerReadyKnownResource(
  detail: Record<string, unknown> | undefined,
  worldKey: WorldKey,
): KnownResourceJson | null {
  const at = asVec3Json(detail?.target) ?? asCellString(detail?.at)
  const block = typeof detail?.block === 'string' ? detail.block : null
  if (at === null || block === null || !isContainerBlockName(block)) return null
  return {
    name: normalizeBlockName(block),
    kind: 'station',
    x: Math.round(at.x),
    y: Math.round(at.y),
    z: Math.round(at.z),
    dimension: worldKey.dimension,
    worldEpoch: worldKey.worldEpoch,
    lastSeenAt: Date.now(),
  }
}

/** Parse the `"x,y,z"` cell spelling the mirrored log lines carry, or null. */
function asCellString(value: unknown): Vec3Json | null {
  if (typeof value !== 'string') return null
  const parts = value.split(',')
  if (parts.length !== 3) return null
  const [x, y, z] = parts.map((entry) => Number(entry))
  if (x === undefined || y === undefined || z === undefined) return null
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null
  return { x, y, z }
}

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
  provenance?: DimensionProvenance | null,
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
    //
    // An entry that records NO dimension cannot be re-anchored at all: probing it
    // here would read THIS world's block at that coordinate and could "prove
    // absent" (`block_mined`) a cell that belongs to another world - deleting
    // durable memory on wrong-world evidence. It is therefore neither probed nor
    // evicted (see `resourceDimensionVerdict`): the row is kept, reported typed
    // by the jev layer (`reason=dimension_unattributed`) and re-stamped by the
    // next observation of the cell in a real world.
    if (resource.dimension === undefined || resource.dimension.length === 0) continue
    if (normalizeDimensionId(resource.dimension) !== normalizeDimensionId(worldKey.dimension)) {
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
    // Provenance gate: this probe RE-CONFIRMS a remembered cell, so a foreign
    // column would keep a bogus row alive for hours by reporting the other
    // dimension's block as `present` (measured: the seven `jungle_log` rows had
    // their `lastSeenAt` refreshed repeatedly while the body was in the Nether).
    // A cell we cannot attribute stays `null`, and `resourceStillPresent` answers
    // `unknown` - the entry is left alone, never confirmed and never evicted.
    const attribution = provenance == null ? null : provenance.cellAttribution(resource.x, resource.z)
    if (attribution !== null && attribution.kind !== 'attributable') {
      provenance?.refuseRead({
        cell: { x: resource.x, y: resource.y, z: resource.z },
        chunk: attribution.chunk,
        provenance: attribution.dimension,
        liveDimension: attribution.liveDimension,
        reason: attribution.reason ?? 'unknown_column',
        source: 'known-resource-staleness',
      })
    } else {
      try {
        live = bot.blockAt(new Vec3(resource.x, resource.y, resource.z))?.name ?? null
      } catch {
        live = null
      }
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
 * The durable known-resource entries a `KNOWN_RESOURCE_FALSIFIED` event removes.
 *
 * ONLY `block_mined` deletes: the loaded world proved the remembered BLOCK is
 * gone, so the memory is wrong and would otherwise be re-offered the moment the
 * body walks out of the loaded radius that produced the verdict (the sensor's
 * own filter is distance-scoped: an unloaded cell is `unknown` again, and the
 * stale `RETRIEVE:known` route comes straight back). A `mob_gone`/`drop_absent`
 * verdict is NOT a disproof of the landmark - a fortress stands, a mob can walk
 * back in, and the fabric scan would re-mint the cell anyway - so those verdicts
 * withhold the route for the tick that observed them and are re-derived from live
 * truth every tick. Pure.
 *
 * `block_mined` is a proof about THE WORLD the probe read, so it can only
 * invalidate a row that is ATTRIBUTABLE TO THAT SAME WORLD (#14, fail closed): a
 * row naming another dimension, or one that records no dimension at all, is
 * never removed. Probing such a row at this coordinate reads a different world's
 * block and would delete durable memory on wrong-world evidence.
 */
export function knownResourceFalsifiedRemovals(
  known: readonly KnownResourceJson[],
  detail: Record<string, unknown> | undefined,
  liveDimension: string,
): KnownResourceJson[] {
  if (detail?.reason !== 'block_mined') return []
  const cell = asVec3Json(detail?.cell)
  if (cell === null) return []
  const rounded = `${Math.round(cell.x)},${Math.round(cell.y)},${Math.round(cell.z)}`
  return known.filter((resource) => {
    if (`${Math.round(resource.x)},${Math.round(resource.y)},${Math.round(resource.z)}` !== rounded) return false
    if (resource.dimension === undefined || resource.dimension.length === 0) return false
    return normalizeDimensionId(resource.dimension) === normalizeDimensionId(liveDimension)
  })
}

/**
 * #80: the near-field radius the ORIGINAL lifecycle used to treat a failed search
 * as proof of absence. That inference is retired (see `syncKnownPortalSites`): a
 * failed search is not an observation at ANY distance. Measured live
 * (`run-mubhx20x-pie2`, 17:28:25Z): the record at 25,66,9 was dropped while the
 * body sat 6 blocks away, because the frame at y=66..70 was outside the sensor
 * window of a body at y=61.9. The constant is retained for fixtures and
 * diagnostics only; production revocation is positive-evidence-only.
 */
export const PORTAL_SITE_PROOF_DISTANCE = 8

/** Why a durable portal record was dropped. Every reason is a POSITIVE observation. */
export type PortalSiteRemovalReason =
  /** the record belongs to a previous world epoch - the coordinate is meaningless */
  | 'world_epoch'
  /** the record was verified in another dimension */
  | 'dimension'
  /** the record's own frame cells were read and at least one is no longer obsidian */
  | 'frame_broken'
  /** the record's own cells were read and the interior is no longer a lit portal */
  | 'observed_unlit'

export interface PortalSiteRemoval {
  site: KnownPortalSiteJson
  reason: PortalSiteRemovalReason
}

export interface PortalSiteSyncResult {
  /** the durable list after record + refresh + eviction */
  known: KnownPortalSiteJson[]
  /** newly verified sites to merge into durable memory */
  added: KnownPortalSiteJson[]
  /** disproved / foreign-epoch sites to drop from durable memory */
  removed: KnownPortalSiteJson[]
  /** typed reason for every removal (positive evidence only) */
  removalReasons: PortalSiteRemoval[]
  /**
   * Records whose OWN cells were positively observed this tick: every recorded
   * frame cell is `obsidian` and every recorded interior cell is `nether_portal`
   * (the same postcondition the ignition action verifies). This is live world
   * truth anchored at the record's coordinates, so it is valid even when the
   * body-relative sensor window cannot reach the structure.
   */
  confirmed: KnownPortalSiteJson[]
}

function portalOriginKey(site: { x: number; y: number; z: number }): string {
  return `${Math.round(site.x)},${Math.round(site.y)},${Math.round(site.z)}`
}

/** Exact live read of one recorded portal cell; `null` = the chunk is not loaded = UNKNOWN. */
export type PortalSiteCellProbe = (cell: Vec3Json) => string | null

/**
 * Read the record's own cells and return a POSITIVE verdict. A failed sensor
 * search is never an input here: only a readable cell decides anything, and an
 * unreadable (unloaded) cell is UNKNOWN, never proof.
 */
function portalSiteRecheck(
  site: KnownPortalSiteJson,
  probe: PortalSiteCellProbe,
): { verdict: 'lit' | 'frame_broken' | 'observed_unlit' | 'unknown'; frameCells: number; interiorCells: number } {
  const frameCells = site.frame ?? []
  const interiorCells = site.interior ?? []
  const frameReads = frameCells.map((cell) => probe(cell))
  const interiorReads = interiorCells.map((cell) => probe(cell))
  const frameReadable = frameCells.length > 0 && frameReads.every((name) => name !== null)
  const interiorReadable = interiorCells.length > 0 && interiorReads.every((name) => name !== null)
  const litInterior = interiorCells.length > 0 && interiorReads.every((name) => name === NETHER_PORTAL)
  if (litInterior && (frameCells.length === 0 || frameReads.every((name) => name === 'obsidian'))) {
    return { verdict: 'lit', frameCells: frameCells.length, interiorCells: interiorCells.length }
  }
  if (frameReadable && frameReads.some((name) => name !== 'obsidian')) {
    return { verdict: 'frame_broken', frameCells: frameCells.length, interiorCells: interiorCells.length }
  }
  if (frameReadable || interiorReadable) {
    // The recorded cells were READ and the portal postcondition does not hold:
    // the frame exists without its lit interior, or the interior is gone.
    return { verdict: 'observed_unlit', frameCells: frameCells.length, interiorCells: interiorCells.length }
  }
  return { verdict: 'unknown', frameCells: frameCells.length, interiorCells: interiorCells.length }
}

/**
 * #80 pure durable-site lifecycle. It records live-verified portal sites, keeps
 * existing records fresh, and drops only records that live world truth PROVES
 * stale: a previous world epoch / foreign dimension, the record's own frame
 * cells read as broken, or its own cells read as no longer a lit portal.
 *
 * Revocation is deliberately positive-evidence-only. The previous rule dropped a
 * record whenever the body-relative sensor search returned nothing while the
 * body was within `PORTAL_SITE_PROOF_DISTANCE`; that conflated "not observed"
 * with "observed absent" and destroyed a verified durable outcome whenever the
 * body was offset from the structure (measured live: frame at y=66..70, body at
 * y=61.9, sensor window dy -4..+4 -> nothing sensed -> record dropped -> the
 * next inventory-shaped resume rebuilt `nether_portal` and re-queued the
 * obsidian construction rows for a gate that was standing and lit).
 *
 * `probe` supplies exact block truth for the record's own cells (the same
 * pattern `evictStaleKnownResources` uses for remembered ore); `null` means the
 * chunk is not loaded and proves nothing. It never decides "go there": the
 * lifecycle only maintains the CAN fact "a verified portal exists at P".
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
  /**
   * Recorded as the observation tick's body position: diagnostics only. Distance
   * is NOT a removal criterion (see this function's doc), and `proofDistance` is
   * accepted for fixture compatibility but no longer decides anything.
   */
  position: Vec3Json
  probe?: PortalSiteCellProbe
  now?: number
  proofDistance?: number
}): PortalSiteSyncResult {
  const now = input.now ?? Date.now()
  const liveKeys = new Set(input.liveVerified.map((site) => portalOriginKey(site.origin)))
  const added: KnownPortalSiteJson[] = []
  const removed: KnownPortalSiteJson[] = []
  const removalReasons: PortalSiteRemoval[] = []
  const confirmed: KnownPortalSiteJson[] = []
  const kept: KnownPortalSiteJson[] = []
  const seen = new Set<string>()
  const drop = (site: KnownPortalSiteJson, reason: PortalSiteRemovalReason): void => {
    removed.push(site)
    removalReasons.push({ site, reason })
  }
  const refresh = (site: KnownPortalSiteJson): KnownPortalSiteJson => ({
    ...site,
    lastVerifiedAt: now,
    ...(site.frame === undefined ? {} : { frame: site.frame.map((cell) => ({ ...cell })) }),
    ...(site.interior === undefined ? {} : { interior: site.interior.map((cell) => ({ ...cell })) }),
  })
  for (const site of input.known) {
    const key = portalOriginKey(site)
    if (seen.has(key)) continue
    // World-epoch / dimension re-anchoring: a coordinate is only meaningful in
    // the world it was verified in, so a stale record is dropped, never probed.
    if (site.worldEpoch !== undefined && site.worldEpoch !== input.worldKey.worldEpoch) {
      drop(site, 'world_epoch')
      continue
    }
    if (
      site.dimension !== undefined &&
      site.dimension.length > 0 &&
      normalizeDimensionId(site.dimension) !== normalizeDimensionId(input.worldKey.dimension)
    ) {
      drop(site, 'dimension')
      continue
    }
    if (liveKeys.has(key)) {
      seen.add(key)
      kept.push(refresh(site))
      continue
    }
    if (input.probe !== undefined) {
      const recheck = portalSiteRecheck(site, input.probe)
      if (recheck.verdict === 'frame_broken' || recheck.verdict === 'observed_unlit') {
        drop(site, recheck.verdict)
        continue
      }
      if (recheck.verdict === 'lit') {
        seen.add(key)
        const record = refresh(site)
        confirmed.push(record)
        kept.push(record)
        continue
      }
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
  return { known: kept, added, removed, removalReasons, confirmed }
}

/** Provenance of the live portal verdict, recorded on every `PORTAL_TRUTH` change. */
export type PortalVerdictSource =
  /** the body-relative search saw a lit site this tick */
  | 'live-world'
  /** the run's own durable record was read back as a valid lit portal this tick */
  | 'durable-site-recheck'
  /** the run's durable verified-portal record still stands (no fresh observation needed) */
  | 'durable-site-record'
  /** world truth disproved the recorded site's own cells this tick */
  | 'world-truth-revoked'
  /** nothing observed and no record: no evidence either way */
  | 'no-evidence'

/**
 * The live portal verdict for ONE tick.
 *
 * `portalVerified` is server truth, but it is NOT re-derived from a single
 * momentary scan. Once this run has observed a valid lit gate - through the
 * body-relative search OR through a coordinate-anchored recheck of its own
 * durable record - a later tick whose scan happens to see nothing must not
 * un-observe it. Measured live (`run-mubhx20x-pie2`, 17:41Z): `PORTAL_TRUTH`
 * alternated true/false every ~2s while the gate stood lit and the body idled
 * below it, which flapped the `nether_portal` rung, re-summoned System2 with
 * `action_impossible`, and re-created `collect obsidian` work whose only source
 * was the protected gate (`RESOURCE_SOURCE_NONE item=obsidian
 * reason=live_structure sensed=10`).
 *
 * A durable record is not an immortal verdict: `syncKnownPortalSites` revokes it
 * by POSITIVE world truth (its own cells read back broken/unlit, or a
 * world-epoch/dimension change), and that same tick clears the verdict. Absence
 * from a search is never proof, so it never clears anything.
 */
export function portalVerdictForTick(input: {
  /** the body-relative search found a lit site this tick */
  liveSighted: boolean
  /** the durable record's own cells were read back as a valid lit portal this tick */
  recheckConfirmed: boolean
  /** durable verified-portal records still standing after this tick's reconciliation */
  recordedSites: number
  /** this tick positively disproved a record's own cells (frame broken / no longer lit) */
  positivelyRevoked: boolean
}): { verified: boolean; source: PortalVerdictSource } {
  const observed = input.liveSighted || input.recheckConfirmed
  if (observed || input.recordedSites > 0) {
    return {
      verified: true,
      source: input.liveSighted ? 'live-world' : observed ? 'durable-site-recheck' : 'durable-site-record',
    }
  }
  return { verified: false, source: input.positivelyRevoked ? 'world-truth-revoked' : 'no-evidence' }
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

/**
 * #377: returns null when the SCAN FAILED, which is a different fact from "the scan
 * succeeded and found nothing". Callers that treat an empty result as negative proof
 * (structure memory) must not prune on a failure: a transient `findBlocks` error would
 * otherwise erase a verified Nether-fortress site.
 */
function scanBlockPositions(
  bot: Bot,
  blockNames: readonly string[],
  maxDistance: number,
  cap: number,
  provenance: DimensionProvenanceView,
): Vec3Json[] | null {
  const ids: number[] = []
  for (const name of blockNames) {
    const block = bot.registry.blocksByName[name]
    if (block !== undefined) ids.push(block.id)
  }
  if (ids.length === 0) return []
  try {
    const positions = bot.findBlocks({ matching: ids, maxDistance, count: cap })
    // Read provenance: `findBlocks` walks every column in the bot's store with no
    // world filter, so a column left over from another dimension would otherwise be
    // reported here as live truth. A position whose column is not attributable to
    // the live dimension is refused (typed) instead of returned - this is the exact
    // path that minted the seven `jungle_log` rows stamped `minecraft:the_nether`.
    const kept: Vec3Json[] = []
    for (const position of positions) {
      const verdict = provenance.cellAttribution(position.x, position.z)
      if (verdict.kind === 'attributable') {
        kept.push({ x: position.x, y: position.y, z: position.z })
        continue
      }
      provenance.refuseRead({
        cell: { x: position.x, y: position.y, z: position.z },
        chunk: verdict.chunk,
        provenance: verdict.dimension,
        liveDimension: verdict.liveDimension,
        reason: verdict.reason ?? 'unknown_column',
        source: 'scan-block-positions',
      })
    }
    return kept
  } catch {
    return null
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

export interface LedgerGoalDominated {
  id: string
  description: string
  item: string
  held: string[]
  reason: string
  /** world-outcome evidence for `reason=outcome_already_satisfied` (`item@x,y,z`) */
  outcome?: string[]
}

export interface LedgerGoalRetirement {
  id: string
  description: string
  rungIds: string[]
}

export interface LedgerGoalReconciliation {
  snapshot: GoalQueueSnapshot
  reopened: LedgerGoalReopening[]
  dominated: LedgerGoalDominated[]
  /**
   * Unfinished rows retired because the world OUTCOME they exist for already
   * exists (every rung that emits the row is satisfied). Separate from
   * `dominated` (the inventory-shaped proof, which deliberately excludes `place`
   * rows) and logged as its own typed marker.
   */
  achieved: LedgerGoalRetirement[]
}

function rungOwnsGoal(rung: Rung, goal: QueuedGoal, counts: Counts, world: ResidentWorldMemory): boolean {
  const target = goal.targetItem ?? null
  const predicate = goal.targetPredicate ?? null
  return rung
    .goals(counts, world)
    .some(
      (planned) =>
        planned.kind === goal.kind &&
        (planned.targetItem ?? null) === target &&
        // A named predicate disambiguates rows that share kind+item: the
        // `light:nether_portal` row (`portal_lit`) and the `enter:nether_portal`
        // row (`portal_entered`) are both `place nether_portal`, but only the
        // first belongs to the nether_portal rung.
        (predicate === null || (planned.targetPredicate ?? null) === predicate),
    )
}

/**
 * The OUTCOME half of ledger reconciliation: an unfinished row exists to produce
 * a world outcome (a built/lit/verified portal, a placed station). When EVERY
 * rung that emits this row is already satisfied by the live inventory/world, the
 * outcome exists and the row is finished work the ledger never observed as
 * `done`.
 *
 * Measured live (`run-mubhx20x-pie2`): the 17:32:56Z restore reopened the five
 * construction rows with zero counts, the plan went back to building a gate that
 * was standing and lit, and the durable ledger then held `g4 collect obsidian`
 * (active), `g5 place obsidian` and `g6 place nether_portal` (pending) at the
 * queue head while the body waited underground. This is the mirror of the `done`
 * rule above and uses the same rung predicates; it is NOT the inventory-shaped
 * domination proof (`dominatedPrerequisiteReason` deliberately excludes `place`
 * rows, whose `targetItem` is the material they spend, not the product).
 */
function achievedOutcomeRetirement(
  goal: QueuedGoal,
  counts: Counts,
  world: ResidentWorldMemory,
): { record: LedgerGoalRetirement; detail: string } | null {
  const target = goal.targetItem
  if (typeof target !== 'string' || target.length === 0) return null
  const rungs = RUNGS.filter((rung) => rung.future !== true && rungOwnsGoal(rung, goal, counts, world))
  if (rungs.length === 0) return null
  const planned: PlannedGoal = {
    kind: goal.kind,
    description: goal.description,
    targetItem: goal.targetItem,
    requiredCount: goal.requiredCount,
  }
  // The row's own item requirement is already held: that is completion, not
  // retirement, and the queue resolves it through its normal completion check.
  if (goalAlreadyMet(planned, counts)) return null
  // EVERY owning rung must be satisfied: a row shared with an unsatisfied rung is
  // still live work (a `place nether_portal` entry row keeps its own predicate).
  if (!rungs.every((rung) => rung.satisfied(counts, world))) return null
  const rungIds = rungs.map((rung) => rung.id)
  return {
    record: { id: goal.id, description: goal.description, rungIds },
    detail: `retired: outcome already exists (rungs=${rungIds.join(',')})`,
  }
}

/**
 * #nonprogress-yield: is this unfinished row emitted by an OPTIONAL rung? Used
 * only to re-attach the marker to durable rows written before it survived the
 * compile. Satisfaction is deliberately not consulted: a row that exists is by
 * definition still wanted, and the rung's own `goals()` emits it in that state.
 */
function rungOwnedByOptionalRung(goal: QueuedGoal, counts: Counts, world: ResidentWorldMemory): boolean {
  return RUNGS.some(
    (rung) => rung.future !== true && rung.optional === true && rungOwnsGoal(rung, goal, counts, world),
  )
}

/**
 * Reconcile a restored ledger against the LIVE bot.
 *
 * A `done` goal is trusted only when either its own item requirement is already
 * held, or a capability rung that contains it is satisfied by the live
 * inventory/world (a consumable that was legitimately spent, e.g. raw_iron
 * smelted into iron_ingot). A `done` goal no live rung predicate covers is
 * reopened as `pending`, so it is re-activated ahead of any later-milestone
 * goal.
 *
 * #prereq-dominated: an UNFINISHED goal whose product only exists to feed rungs
 * that are all already satisfied by better items is retired (`impossible`) with
 * the code-owned proof, so a prerequisite the agent has outgrown cannot keep
 * burning time behind a starved station precondition. Pure: never mutates input.
 */
export function reconcileLedgerGoals(
  snapshot: GoalQueueSnapshot,
  counts: Record<string, number>,
  world: ResidentWorldMemory,
): LedgerGoalReconciliation {
  const reopened: LedgerGoalReopening[] = []
  const dominated: LedgerGoalDominated[] = []
  const achieved: LedgerGoalRetirement[] = []
  const goals = (snapshot.goals ?? []).map((goal) => {
    if (goal.status === 'active' || goal.status === 'pending') {
      const proof = dominatedPrerequisiteReason(
        { kind: goal.kind, targetItem: goal.targetItem, requiredCount: goal.requiredCount },
        counts,
        world,
      )
      if (proof !== null) {
        dominated.push({
          id: goal.id,
          description: goal.description,
          item: proof.item,
          held: [...proof.held],
          reason: proof.reason,
          ...(proof.outcome === undefined ? {} : { outcome: [...proof.outcome] }),
        })
        return {
          ...goal,
          status: 'impossible' as const,
          detail: `retired dominated prerequisite: item=${proof.item} held=${proof.held.join(',')} reason=${proof.reason}`,
        }
      }
      const outcome = achievedOutcomeRetirement(goal, counts, world)
      if (outcome !== null) {
        achieved.push(outcome.record)
        return { ...goal, status: 'impossible' as const, detail: outcome.detail }
      }
      // #nonprogress-yield: a durable row written before the optional marker
      // survived the compile (live `g37:collect:food core=true`, restored with a
      // valid basis) is re-attributed here: if any rung that emits this row is
      // OPTIONAL, the row is eligible for the bounded head yield. `core`
      // protection is left untouched (#55), only the missing marker is added.
      if (goal.optional !== true && rungOwnedByOptionalRung(goal, counts, world)) {
        return { ...goal, optional: true }
      }
      return { ...goal }
    }
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
  return { snapshot: { ...snapshot, goals }, reopened, dominated, achieved }
}

/**
 * #plan-reconciliation: the LIVE plan/objective identity, projected from the same
 * durable-aware ladder frontier that seeds the controller. This is the one value
 * a durable row's authoring identity is compared against.
 */
export function planIdentityFor(
  frontier: { rungId: string; rungIndex: number },
  rootGoal: { goalItem: string; goalCount: number },
): PlanIdentity {
  return {
    rungId: frontier.rungId,
    rungIndex: frontier.rungIndex,
    objectiveItem: rootGoal.goalItem,
    objectiveCount: rootGoal.goalCount,
  }
}

/** Stable semantic identity for System2-owned plans; it carries no ladder frontier. */
export const SYSTEM2_MISSION_PLAN_IDENTITY: Readonly<PlanIdentity> = Object.freeze({
  rungId: 'mission:defeat_ender_dragon',
  rungIndex: -1,
  objectiveItem: null,
  objectiveCount: 0,
})

export function isSystem2MissionPlanIdentity(identity: PlanIdentity | undefined): boolean {
  return (
    identity?.rungId === SYSTEM2_MISSION_PLAN_IDENTITY.rungId &&
    identity.rungIndex === SYSTEM2_MISSION_PLAN_IDENTITY.rungIndex &&
    identity.objectiveItem === SYSTEM2_MISSION_PLAN_IDENTITY.objectiveItem &&
    identity.objectiveCount === SYSTEM2_MISSION_PLAN_IDENTITY.objectiveCount
  )
}

/**
 * Rung-based dominated-prerequisite proofs are legacy planner closure, not
 * Minecraft truth. They may retire an explicit deterministic plan only; model
 * authored WHAT must be reconsidered by System2 against current grounded facts.
 */
export function dominatedGoalReasonForPlannerMode(
  plannerMode: ReturnType<typeof resolvePlannerMode>,
  goal: Pick<QueuedGoal, 'kind' | 'targetItem' | 'requiredCount'>,
  counts: Readonly<Record<string, number>>,
  world: ResidentWorldMemory,
): ReturnType<typeof dominatedPrerequisiteReason> {
  if (plannerMode !== 'deterministic') return null
  return dominatedPrerequisiteReason(goal, { ...counts } as Counts, world)
}

/**
 * #plan-reconciliation: the code-owned proof that an unfinished row authored
 * under a SUPERSEDED plan is obsolete for the CURRENT objective.
 *
 * Measured live (`run-mucpugqn-20evo`): the durable head was
 * `g1:descend:raw_iron` (`dim=minecraft:overworld`, success `levelAtMost y32`)
 * while the body was in the Nether and the mission was `blaze_rods`. Its own
 * predicate was genuinely unsatisfied there, so predicate retirement correctly
 * left it; what was missing is the plan/objective comparison this proof makes.
 *
 * Conservative on purpose - it returns a proof ONLY when every live question
 * about the row's target item is answered "no":
 *
 *   1. the row's authoring frontier is STRICTLY behind the live frontier, so
 *      every rung it could have advanced is already passed;
 *   2. no live rung at/after the frontier emits the row's target item;
 *   3. no UNSATISFIED live rung at/after the frontier consumes it (recipe/smelt
 *      input), so the item is not still needed as a prerequisite;
 *   4. the row is not human intent (the operator owns that WHAT, not the plan).
 *
 * It never consults the row's own success predicate: "unsatisfied" is not
 * obsolescence, and a merely-unsatisfied row whose plan is CURRENT is untouched.
 */
export function supersededPlanObsoleteProof(
  goal: Pick<QueuedGoal, 'kind' | 'targetItem' | 'requiredCount' | 'planIdentity' | 'origin'>,
  current: PlanIdentity,
  counts: Counts,
  world: ResidentWorldMemory,
): PlanObsoleteProof | null {
  const authored = goal.planIdentity
  if (authored === undefined) return null
  if (goal.origin === 'human') return null
  if (authored.rungIndex >= current.rungIndex) return null
  const item = goal.targetItem
  if (typeof item !== 'string' || item.length === 0) return null
  const rungs = RUNGS
  const live = rungs
    .map((rung, index) => ({ rung, index }))
    .filter((entry) => entry.rung.future !== true && entry.index >= current.rungIndex)
  const liveOwners = live.filter((entry) =>
    entry.rung.goals(counts, world).some((planned) => (planned.targetItem ?? null) === item),
  )
  if (liveOwners.length > 0) return null
  const liveConsumers = live.filter((entry) => rungConsumesItem(entry.rung, item, counts, world))
  const unsatisfiedConsumers = liveConsumers.filter((entry) => !entry.rung.satisfied(counts, world))
  if (unsatisfiedConsumers.length > 0) return null
  return {
    reason: 'authoring_frontier_behind_current',
    evidence: [
      `authored=${formatPlanIdentity(authored)}`,
      `current=${formatPlanIdentity(current)}`,
      `item=${item}`,
      `live_rungs=${live.length}`,
      `live_owners=0`,
      `live_consumers_satisfied=${liveConsumers.length}`,
    ],
  }
}

export function selectLedgerSnapshot(  hostSnapshot: GoalQueueSnapshot | null,
  derivedSnapshot: GoalQueueSnapshot | null,
  counts: Record<string, number>,
  world: ResidentWorldMemory,
): {
  source: 'host-snapshot' | 'derived-file'
  snapshot: GoalQueueSnapshot
  reopened: LedgerGoalReopening[]
  dominated: LedgerGoalDominated[]
  achieved: LedgerGoalRetirement[]
} | null {
  if (hostSnapshot !== null) {
    if (!ledgerIsConsistent(hostSnapshot, counts, world)) return null
    return { source: 'host-snapshot', ...reconcileLedgerGoals(hostSnapshot, counts, world) }
  }
  if (derivedSnapshot !== null && ledgerIsConsistent(derivedSnapshot, counts, world)) {
    return { source: 'derived-file', ...reconcileLedgerGoals(derivedSnapshot, counts, world) }
  }
  return null
}

/** Select a consistent model-authored queue without ladder reconciliation. */
export function selectSystem2LedgerSnapshot(
  hostSnapshot: GoalQueueSnapshot | null,
  derivedSnapshot: GoalQueueSnapshot | null,
  counts: Record<string, number>,
  world: ResidentWorldMemory,
): { source: 'host-snapshot' | 'derived-file'; snapshot: GoalQueueSnapshot } | null {
  if (hostSnapshot !== null) {
    return ledgerIsConsistent(hostSnapshot, counts, world) && isSystem2MissionPlanIdentity(hostSnapshot.planIdentity)
      ? { source: 'host-snapshot', snapshot: hostSnapshot }
      : null
  }
  if (
    derivedSnapshot !== null &&
    ledgerIsConsistent(derivedSnapshot, counts, world) &&
    isSystem2MissionPlanIdentity(derivedSnapshot.planIdentity)
  ) {
    return { source: 'derived-file', snapshot: derivedSnapshot }
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
  const basis = snapshot.basis
  // A scoped snapshot is scoped even when every row is done. Restoring a
  // done-only snapshot replaces the controller queue just like an unfinished
  // snapshot does; accepting one from another dimension/frontier can therefore
  // erase the freshly-grounded live plan (measured: Nether death -> Overworld
  // respawn lost the enter_nether row and fell into an unrelated System2 repair).
  // Legacy basis-less history remains harmless only when it has no unfinished
  // work, preserving the compatibility rule documented above.
  if (basis === undefined) {
    return unfinished ? { accept: false, reasons: ['missing_frontier_basis'] } : { accept: true, reasons: [] }
  }
  const reasons: string[] = []
  if (basis.worldKey !== live.worldKey) reasons.push('world_key_changed')
  if (basis.frontierRungIndex !== live.frontierRungIndex) reasons.push('frontier_index_changed')
  if (basis.frontierRungId !== live.frontierRungId) reasons.push('frontier_id_changed')
  return { accept: reasons.length === 0, reasons }
}

/**
 * Model-authority queue restore is scoped to the world and semantic mission.
 * The ladder frontier remains evidence, but moving it cannot authorize or reject
 * a System2 plan because it does not define the plan's WHAT.
 */
export function evaluateSystem2LedgerRestoreBasis(
  snapshot: GoalQueueSnapshot,
  live: LedgerBasis,
): { accept: boolean; reasons: string[] } {
  const basis = snapshot.basis
  if (basis === undefined) return { accept: false, reasons: ['missing_world_basis'] }
  const reasons: string[] = []
  if (basis.worldKey !== live.worldKey) reasons.push('world_key_changed')
  if (!isSystem2MissionPlanIdentity(snapshot.planIdentity)) reasons.push('mission_identity_mismatch')
  return { accept: reasons.length === 0, reasons }
}

/**
 * The restore basis must describe the frontier computed from the current live
 * ladder, not the inventory-only resume hint used to seed that ladder.
 */
export function ledgerBasisForLiveFrontier(
  worldKey: string,
  frontier: { rungId: string; rungIndex: number },
): LedgerBasis {
  return {
    worldKey,
    frontierRungId: frontier.rungId,
    frontierRungIndex: frontier.rungIndex,
  }
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
 * Compose the run-scoped DURABLE ladder record from the two durable sources the
 * generation can see, for `deriveResumeRung` / `computeFrontier`. Evidence only:
 * the ladder decides how far the record may raise the resume floor
 * (`achievedRungFloor`).
 *
 *  - the HOST-committed class-A ledger: its own frontier basis (a ledger written
 *    from frontier index k says this run had already reached every mandatory rung
 *    before k, because the ladder is a prerequisite chain) and its `done` rows (a
 *    row finished in this run owns the rung that emits it; a `done` row outlives
 *    the basis on a ledger written by an older inventory-shaped resume - the
 *    measured `run-mubobiq6-12onv` collapse);
 *  - durable world outcomes (`worldOutcomeRungFloor`): a remembered station, a
 *    lit+verified portal site, standing in the Nether.
 *
 * Scoped by `basis.worldKey`: a ledger committed in another world or another
 * worldEpoch is NOT this run's record, so a world reset / epoch change cannot be
 * papered over by it (task requirement: lost world state still resets).
 *
 * The basis is REQUIRED. A basis-less (legacy) ledger carries no world scope and
 * may not contribute; the world-outcome half still stands on its own.
 *
 * Returns null when neither source proves anything, so callers that pass it on
 * behave exactly like the pre-fix inventory-only path.
 */
export function durableLadderProgressFromLedger(
  ledger: GoalQueueSnapshot | null | undefined,
  liveWorldKey: string,
  counts: Counts,
  world: ResidentWorldMemory,
): DurableLadderProgress | null {
  const sources: DurableLadderSource[] = []
  const evidence: string[] = []
  let rungIndex = -1
  const basis = ledger?.basis
  if (ledger !== null && ledger !== undefined && basis !== undefined && basis.worldKey === liveWorldKey) {
    rungIndex = Number.isInteger(basis.frontierRungIndex)
      ? Math.min(RUNGS.length - 1, Math.max(-1, basis.frontierRungIndex - 1))
      : -1
    if (rungIndex >= 0) {
      sources.push('ledger-basis')
      evidence.push(`basis:frontier=${basis.frontierRungId}@${basis.frontierRungIndex}`)
    }
    for (const goal of snapshotGoals(ledger)) {
      if (goal.status !== 'done') continue
      const owners = RUNGS.map((rung, index) => ({ rung, index }))
        .filter((entry) => isMandatoryRung(entry.rung) && rungOwnsGoal(entry.rung, goal, counts, world))
        .map((entry) => entry.index)
      if (owners.length === 0) continue
      const owner = Math.max(...owners)
      if (owner > rungIndex) rungIndex = owner
      if (!sources.includes('ledger-goal')) sources.push('ledger-goal')
      evidence.push(`goal:${goal.id}@${RUNGS[owner]?.id ?? owner}`)
    }
  }
  const worldFloor = worldOutcomeRungFloor(world)
  if (worldFloor > rungIndex) {
    rungIndex = worldFloor
    if (!sources.includes('world-outcome')) sources.push('world-outcome')
    evidence.push(`world:${RUNGS[worldFloor]?.id ?? worldFloor}@${worldFloor}`)
  }
  if (rungIndex < 0) return null
  return { rungIndex, rungId: RUNGS[rungIndex]?.id ?? null, sources, evidence }
}

/**
 * The durable record is only usable when the death did NOT lose the inventory.
 * A generation that starts from a genuinely empty kit must re-climb from wood
 * (task requirement 3), so its durable floor is discarded for its whole lifetime
 * - including `proposeLedger()`/`status()`, which then rewrite the durable basis
 * from the retained inventory instead of resurrecting the position the total loss
 * just erased.
 */
export function durableProgressForGeneration(
  resume: { invEmpty: boolean },
  progress: DurableLadderProgress | null,
): DurableLadderProgress | null {
  return resume.invEmpty ? null : progress
}

/**
 * Restore the durable ledger into the controller. Class A says the HOST snapshot
 * is the authority (#40): the generation reads `ctx.ledgerSnapshot` first and only
 * falls back to the derived `buddy-ledger.json` compatibility mirror. A ledger
 * whose recorded tools/stations are gone from the live bot is refused.
 */
function restoreLedgerIntoController(
  controller: JevController,
  plannerMode: ReturnType<typeof resolvePlannerMode>,
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
  const chosen =
    plannerMode === 'deterministic'
      ? selectLedgerSnapshot(hostSnapshot, derivedSnapshot, counts, world)
      : selectSystem2LedgerSnapshot(hostSnapshot, derivedSnapshot, counts, world)
  if (chosen === null) {
    if (hostSnapshot !== null || derivedSnapshot !== null) {
      log('LEDGER_STALE', {
        reason:
          plannerMode === 'deterministic'
            ? 'live inventory regressed below recorded goals'
            : 'snapshot was not authored for the current System2 mission',
        source: hostSnapshot !== null ? 'host-snapshot' : 'derived-file',
      })
    }
    return
  }
  const basisDecision =
    plannerMode === 'deterministic'
      ? evaluateLedgerRestoreBasis(chosen.snapshot, liveBasis)
      : evaluateSystem2LedgerRestoreBasis(chosen.snapshot, liveBasis)
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
    const deterministicReconciliation =
      plannerMode === 'deterministic' ? (chosen as NonNullable<ReturnType<typeof selectLedgerSnapshot>>) : null
    const reopened = deterministicReconciliation?.reopened ?? []
    const dominated = deterministicReconciliation?.dominated ?? []
    const achieved = deterministicReconciliation?.achieved ?? []
    const done = goals.filter((goal) => goal.status === 'done').length
    const current = goals.find((goal) => goal.status === 'active' || goal.status === 'pending')
    log('LEDGER_RESTORED', {
      source: chosen.source,
      done,
      total: goals.length,
      current: current?.description ?? null,
      reopened: reopened.length,
      dominated: dominated.length,
      achieved: achieved.length,
      basis: chosen.snapshot.basis ?? null,
      // #plan-reconciliation: the identity those rows were AUTHORED under. The
      // basis above is re-stamped with the frontier at every commit, so it cannot
      // answer "does this queue still belong to the live plan?" - this can.
      planIdentity: chosen.snapshot.planIdentity ?? null,
    })
    if (reopened.length > 0) {
      log('LEDGER_GOAL_REOPENED', { reason: 'live predicate unmet', goals: reopened })
    }
    // The mirror of the reopen above: an unfinished row whose world OUTCOME
    // already exists is finished work the ledger never observed as `done`, so it
    // is retired (typed, recorded in the durable ledger) instead of restored at
    // the queue head. Measured live: this is what kept `place obsidian` /
    // `place nether_portal` rows alive for a gate that was standing and lit.
    for (const entry of achieved) {
      log('LEDGER_GOAL_RETIRED', {
        reason: 'outcome_already_satisfied',
        goal: entry.id,
        description: entry.description,
        rungs: entry.rungIds,
      })
    }
    for (const entry of dominated) {
      log('PREREQ_DOMINATED', {
        goal: entry.id,
        description: entry.description,
        item: entry.item,
        held: entry.held.join(','),
        ...(entry.outcome === undefined ? {} : { outcome: entry.outcome.join(',') }),
        reason: entry.reason,
      })
    }
  } catch (error) {
    log('ERROR', { where: 'restoreLedgerIntoController', message: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * The most recent durable death-hazard facts, newest first, as the payload's
 * `deathHistory`. Pure and bounded: the hazard memory is world-scoped and grows
 * for the life of the world, so the payload carries a recent window instead of
 * the whole record.
 */
export function deathHistoryFacts(world: ResidentWorldMemory, limit: number): string[] {
  const rendered = world.hazards.map((hazard) => ({
    at: hazard.lastSeenAt ?? 0,
    text: `${hazard.reason}@${Math.round(hazard.x)},${Math.round(hazard.y)},${Math.round(hazard.z)}x${hazard.count}`,
  }))
  rendered.sort((a, b) => b.at - a.at)
  return rendered.slice(0, Math.max(0, limit)).map((entry) => entry.text)
}

export function buildMercurySummary(
  bot: Bot,
  world: ResidentWorldMemory,
  request: System2PlanRequest,
  trigger: MercuryTriggerReason,
  deathRecovery: DeathRecoveryContext | null = null,
  log?: (event: string, detail?: Record<string, unknown>) => void,
): MercuryStateSummary {
  const counts = inventoryCounts(bot)
  const entity = bot.entity
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
  // BLOCKERS + GROUNDED ALTERNATIVES, as typed facts. Purely additive: the
  // projection is `null` whenever the summoning tick established no refusal, so
  // an ordinary payload is byte-for-byte what it was (no invented field).
  const traversals = world.knownTraversals ?? []
  const routeMemory: System2RouteMemoryInput | null =
    world.knownResources.length === 0 && traversals.length === 0
      ? null
      : {
          knownResources: world.knownResources.length,
          traversalsOk: traversals.filter((entry) => entry.result === 'ok').length,
          traversalsBlocked: traversals.filter((entry) => entry.result === 'blocked').length,
        }
  const payloadFacts = projectSystem2PayloadFacts(request.blockers, routeMemory)
  if (payloadFacts !== null && log !== undefined) {
    log(formatSystem2PayloadLine(payloadFacts.shape), {
      plane: 'payload',
      withheld: payloadFacts.blockers.withheld,
      withheldTotal: payloadFacts.blockers.withheldTotal,
      missing: payloadFacts.blockers.missing,
      blockedBy: payloadFacts.blockers.blockedBy ?? null,
      tools: payloadFacts.blockers.tools,
      presented: payloadFacts.alternatives.presented,
      presentedTotal: payloadFacts.alternatives.presentedTotal,
      routes: payloadFacts.alternatives.routes ?? null,
      chars: payloadFacts.shape.chars,
    })
    for (const entry of payloadFacts.shape.refused) {
      log(formatSystem2PayloadRefusedLine(entry), { ...entry, plane: 'payload' })
    }
    for (const field of payloadFacts.shape.absent) {
      log(formatSystem2PayloadAbsentLine(field), { field, plane: 'payload' })
    }
  }
  const activeGoal = request.goalQueueState.current
  // `request.objective` remains for compatibility with the deterministic
  // planner, but it can be a stale configured root goal after System2 has
  // emptied its durable queue. Model-mode WHAT must see only a real active
  // queue objective; an empty queue is represented explicitly as null.
  const activeObjective =
    activeGoal === null || activeGoal.targetItem === null
      ? null
      : {
          targetItem: activeGoal.targetItem,
          requiredCount: activeGoal.requiredCount,
          haveCount: activeGoal.haveCount,
          complete: activeGoal.status === 'done',
        }
  return {
    humanMission: SYSTEM2_HUMAN_MISSION,
    trigger,
    wakeReason: request.reason,
    wakeDetail: request.detail.slice(0, 200),
    position:
      entity === undefined
        ? null
        : { x: Math.round(entity.position.x), y: Math.round(entity.position.y), z: Math.round(entity.position.z) },
    dimension: bot.game?.dimension ?? null,
    health: entity === undefined ? null : bot.health,
    food: entity === undefined || typeof bot.food !== 'number' ? null : bot.food,
    starvation: starvationFact(bot),
    toolRank: bestPickaxeRank(counts),
    inventory,
    stations: { craftingTables: world.craftingTables.length, furnaces: world.furnaces.length },
    portal: { verified: world.portalVerified === true, knownSites: world.knownPortalSites.length },
    knownOres: [...world.discoveredOres],
    recentFailures,
    consecutiveWait: wait,
    queue: {
      depth: request.goalQueueState.depth,
      done: request.goalQueueState.done,
      current: request.goalQueueState.current?.description ?? null,
      hasImpossible: request.goalQueueState.hasImpossible,
    },
    objective: activeObjective,
    ...(request.recentSemanticOutcomes === undefined || request.recentSemanticOutcomes.length === 0
      ? {}
      : { recentSemanticOutcomes: request.recentSemanticOutcomes.slice(-SYSTEM2_SEMANTIC_HISTORY_LIMIT) }),
    // Newest-first and BOUNDED: the durable hazard memory is world-scoped and
    // grows for the life of the world, so carrying it whole made the payload a
    // log (measured live: 1098 of 3549 chars, 57 entries) and kept perturbing
    // the Mercury cache key as hazards accumulated. `deathHistoryTotal` reports
    // the pre-clamp count so a truncated history is never read as complete.
    deathHistory: deathHistoryFacts(world, MERCURY_DEATH_HISTORY_LIMIT),
    // Present ONLY when the window actually truncated: an ordinary summon whose
    // hazard memory fits carries the same field set it always did, and the total
    // appears exactly where it is needed to stop a short list reading as the
    // whole record.
    ...(world.hazards.length > MERCURY_DEATH_HISTORY_LIMIT ? { deathHistoryTotal: world.hazards.length } : {}),
    postDeath:
      trigger === 'post_death' && deathRecovery !== null
        ? {
            latestDeathPoint:
              deathRecovery.position === null
                ? null
                : {
                    x: Math.round(deathRecovery.position.x),
                    y: Math.round(deathRecovery.position.y),
                    z: Math.round(deathRecovery.position.z),
                  },
            dimension: deathRecovery.dimension,
            cause: deathRecovery.cause,
            lostInventory: { ...deathRecovery.lostInventory },
            itemsLost: deathRecovery.itemsLost,
            nearbyHostiles: deathRecovery.nearbyHostiles.map((hostile) => ({ ...hostile })),
            recentDeathCount: deathRecovery.recentDeathCount,
            recentDeathWindowSec: Math.round(deathRecovery.recentDeathWindowMs / 1000),
            recoveryChoices: ['recover_death_site', 'rebuild_equipment', 'leave_danger_area'] as const,
          }
        : null,
    allowedGoals: MERCURY_ALLOWED_GOALS,
    ...(payloadFacts === null
      ? {}
      : { blockers: payloadFacts.blockers, alternatives: payloadFacts.alternatives }),
  }
}

export function createGeneration(ctx: GenerationContext): ResidentGeneration {
  const selfAirBinding = bindSelfAirMetadataProjection(ctx.bot)
  ctx.log('AIR_SENSOR_BINDING', { binding: selfAirBinding })
  if (selfAirBinding === 'unavailable-nonconfigurable-property' || selfAirBinding === 'unavailable-self-air-metadata-key') {
    throw new Error(`Cannot bind the self-entity air sensor over Mineflayer oxygenLevel: ${selfAirBinding}`)
  }
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
    repeatedOutcomes: (ctx.worldMemory.repeatedOutcomes ?? []).map((entry) => ({ ...entry })),
    hazards: (ctx.worldMemory.hazards ?? []).map((h) => ({ ...h })),
    portalVerified: detectLivePortalVerification(ctx.bot),
    dimension: canonicalDimensionId(ctx.bot.game?.dimension),
  }
  // The body's actual dimension is the world fact a Nether arrival is proven by,
  // and the host HEARTBEAT line does not carry it. State it once here at
  // generation start (a run that starts/resumes in the Nether is never
  // evidence-blind), then once per CHANGE from `refreshLiveFacts`. Observation
  // only - it never chooses a destination.
  const dimensionObserver = createDimensionObserver(ctx.log, ctx.runId, world.dimension)
  // Read provenance for the bot's per-column world cache. This is the capability
  // the measured `jungle_log` defect was missing: the columns are the BOT's (one
  // store, created once, handed to every generation), so the tags are bot-scoped
  // and survive generation swaps, while this view carries THIS generation's log so
  // a disposed generation is never called back. `syncLiveDimension` runs once per
  // sensor build from `buildWorldState`, so a build never gates on a stale
  // dimension; on a change it drops every tag and unloads the columns.
  const dimensionProvenance = createDimensionProvenanceView(ctx.bot, ctx.log, ctx.runId, 'generation-start')
  /**
   * #80: maintain the durable verified-portal-site record from live truth, and
   * project the live-only verdict from BOTH observation routes.
   *
   * The verdict is no longer produced by the body-relative sensor window alone.
   * `sensedVerifiedPortalSites` searches around the BODY (measured live: a body
   * at y=62 cannot see a frame at y=66..70, `PORTAL_FRAME_PROGRESS blocks=0`), so
   * the OLD code read a standing, lit, already-verified gate as "no portal" the
   * moment the body was offset from it. A durable record whose own cells are read
   * back as a valid lit portal is also live world truth - anchored at the
   * record's coordinates instead of at the body - so it satisfies the verdict and
   * the run records that observation (`PORTAL_SITE_RECHECK`, `PORTAL_TRUTH`
   * source=durable-site-recheck, and this run's own M2 `PORTAL_VERIFIED`).
   *
   * Revocation stays positive-evidence-only, the same rule #377 established for
   * structure sites: a failed search is never absence. `syncKnownPortalSites`
   * drops a record only when its OWN cells read as broken/unlit, or on a
   * world-epoch/dimension change.
   */
  const applyPortalVerdict = (reason: string, liveSighted: boolean, result: PortalSiteSyncResult): void => {
    const verdict = portalVerdictForTick({
      liveSighted,
      recheckConfirmed: result.confirmed.length > 0,
      recordedSites: result.known.length,
      positivelyRevoked: result.removalReasons.some(
        (entry) => entry.reason === 'frame_broken' || entry.reason === 'observed_unlit',
      ),
    })
    if (verdict.verified === world.portalVerified) return
    world.portalVerified = verdict.verified
    ctx.log('PORTAL_TRUTH', { verified: verdict.verified, reason, source: verdict.source })
  }
  const syncPortalSiteMemory = (reason: string): PortalSiteSyncResult => {
    const liveVerified = sensedVerifiedPortalSites(ctx.bot).map((site) => ({
      origin: { x: site.origin.x, y: site.origin.y, z: site.origin.z },
      widthAxis: site.widthAxis,
      ...(site.existingFrame === undefined ? {} : { frame: site.existingFrame.map((cell) => ({ ...cell })) }),
      interior: portalFrameLayout(site.origin, site.widthAxis).interior.map((cell) => ({ ...cell })),
    }))
    const entity = ctx.bot.entity
    if (entity === undefined) {
      // No body = nothing observed this tick. Never revoke on an observation that
      // was not taken and never invent one: the run's standing record still
      // carries the verdict.
      const result: PortalSiteSyncResult = {
        known: world.knownPortalSites,
        added: [],
        removed: [],
        removalReasons: [],
        confirmed: [],
      }
      applyPortalVerdict(reason, false, result)
      return result
    }
    const result = syncKnownPortalSites({
      known: world.knownPortalSites,
      liveVerified,
      worldKey: ctx.worldKey,
      position: { x: entity.position.x, y: entity.position.y, z: entity.position.z },
      probe: (cell) => liveBlockNameAt(ctx.bot, cell),
    })
    world.knownPortalSites = result.known
    const liveSighted = liveVerified.length > 0
    applyPortalVerdict(reason, liveSighted, result)
    const changedMemory = result.added.length > 0 || result.removed.length > 0
    if (changedMemory) {
      ctx.proposeWorldMemory({
        ...(result.added.length === 0 ? {} : { knownPortalSites: result.added }),
        ...(result.removed.length === 0 ? {} : { removeKnownPortalSites: result.removed }),
      })
    }
    if (changedMemory || result.confirmed.length > 0) {
      ctx.log('PORTAL_SITE_MEMORY', {
        reason,
        source: 'live-world',
        added: result.added.length,
        removed: result.removed.length,
        known: result.known.length,
        removedSites: result.removed.map((site) => `${site.x},${site.y},${site.z}`),
        removedReasons: result.removalReasons.map(
          (entry) => `${entry.reason}@${entry.site.x},${entry.site.y},${entry.site.z}`,
        ),
        confirmedSites: result.confirmed.map((site) => `${site.x},${site.y},${site.z}`),
      })
    }
    // The run's OWN verification of a gate it did not ignite this generation:
    // the recorded cells were read back in THIS run and satisfied the exact
    // ignition postcondition. Record it once per run (the marker carries its
    // provenance) so the run has its own evidence instead of borrowing the
    // previous run's, without returning the plan to construction rows.
    if (!liveSighted && result.confirmed.length > 0 && m2Snapshot !== null) {
      const recorded = m2Snapshot.current().markers.some((marker) => marker.name === PORTAL_VERIFIED)
      if (!recorded) {
        const site = result.confirmed[0]
        if (site !== undefined) {
          m2Snapshot.recordMarker(PORTAL_VERIFIED, {
            verified: true,
            dimension: ctx.worldKey.dimension,
            at: `${site.x},${site.y},${site.z}`,
            source: 'durable-site-recheck',
          })
          ctx.log('PORTAL_SITE_RECHECK', {
            at: `${site.x},${site.y},${site.z}`,
            dimension: ctx.worldKey.dimension,
            frame: site.frame?.length ?? 0,
            interior: site.interior?.length ?? 0,
            body: `${Math.round(entity.position.x)},${Math.round(entity.position.y)},${Math.round(entity.position.z)}`,
            verified: true,
            source: 'live-world',
          })
        }
      }
    }
    return result
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
    // No coalesce here: the `scanned === null` guard below is the whole point of #377. With
    // `?? []` the guard was unreachable and one transient scan failure silently erased a
    // verified fortress site (the live set looked empty near a remembered site).
    const scanned = scanBlockPositions(ctx.bot, NETHER_STRUCTURE_BLOCK_NAMES, 64, 64, dimensionProvenance)
    if (scanned === null) {
      // #377: a failed scan is NOT evidence of absence. `syncKnownStructureSites`
      // treats an empty live set near a remembered site as negative proof, so
      // pruning here would let one transient chunk error erase a verified fortress.
      ctx.log('STRUCTURE_SCAN_FAILED', {
        scope: 'nether_fortress',
        reason,
        kept: world.knownStructureSites.length,
      })
      return []
    }
    const liveSensed: { position: Vec3Json; kind: 'nether_fortress'; blocks: string[] }[] = []
    for (const position of scanned) {
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
    // Edge-triggered: `observe` logs one DIMENSION_TRANSITION per real change and
    // nothing while the dimension is constant. Keeps `world.dimension` canonical.
    world.dimension = dimensionObserver.observe(ctx.bot.game?.dimension, reason)
    // One portal sync supplies both the durable site record and the live verdict:
    // the body-relative search (`sensedVerifiedPortalSites` is the per-site form
    // of `detectLivePortalVerification`) OR a coordinate-anchored recheck of the
    // run's own durable record, which is the only route that works while the body
    // is outside the sensor window of the structure.
    syncPortalSiteMemory(reason)
    syncStructureSiteMemory(reason)
  }
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
  // Record a portal that was already verified at generation start (e.g. after a
  // hot reload) so it is durable before the bot can wander out of sensor range.
  // This runs AFTER the recorder exists: a coordinate-anchored recheck of an
  // existing durable record is this run's own verification (see
  // `syncPortalSiteMemory`) and must be recordable in THIS run's snapshot.
  syncPortalSiteMemory('generation-start')
  // Same for a Nether-structure site already in scan range at generation start.
  syncStructureSiteMemory('generation-start')
  // V4.1.2 kernel authority session — the kernel is the only runtime authority:
  // its command path runs causally BEFORE every gated act and its verdict
  // gates production; a denial fails closed and is journaled. The session has
  // no observer-only mode, so there is nothing to select here.
  const kernelSession = createKernelAuthoritySession({
    world: {
      serverId: ctx.worldKey.serverId,
      dimension: ctx.worldKey.dimension,
      worldEpoch: ctx.worldKey.worldEpoch,
    },
    generationId: id,
    journalPath: join(ctx.logDir, 'kernel-authority.jsonl'),
  })
  const kernelAuthority = kernelSession.authority
  ctx.log('KERNEL_AUTHORITY_MODE', { mode: 'authority', generationId: id })
  // Late-bound: the controller (and its executor projection) exists only after
  // the leased bot is built. The resolver reads the CURRENT claim at mutation
  // time, so dispatches are attributed to whichever authority holds the body.
  let actuationAuthoritySource: { currentActuationAuthority(): MutationAuthorityContext | null } | null = null
  kernelSession.bindActuationContext(() => actuationAuthoritySource?.currentActuationAuthority() ?? null)
  const bot = withActuationLease(ctx.bot, ctx.lease, id, ctx.resources, ctx.log, kernelSession.observeMutation)
  // #38: the generation actuates through this allowlist capability. Every method
  // asserts the lease; the raw Bot is not the actuation contract. The dev-only
  // surface check proves the nested capabilities are guarded, not raw.
  const actuationPort = createActuationPort(bot, ctx.lease, id, ctx.log, kernelSession.observeMutation)
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

  const tables = scanBlockPositions(bot, ['crafting_table'], 48, 64, dimensionProvenance) ?? []
  const furnaces = scanBlockPositions(bot, ['furnace', 'blast_furnace', 'smoker'], 48, 32, dimensionProvenance) ?? []
  const ores = scanBlockPositions(
    bot,
    ['iron_ore', 'deepslate_iron_ore', 'diamond_ore', 'deepslate_diamond_ore', 'coal_ore', 'deepslate_coal_ore', 'copper_ore', 'gold_ore'],
    64,
    64,
    dimensionProvenance,
  ) ?? []
  const logs = scanBlockPositions(bot, LOG_BLOCK_NAMES, 64, 64, dimensionProvenance) ?? []
  // Obsidian is a non-ore direct drop required by the M2 portal plan
  // (`collect:obsidian`). Keep it in durable known-resource memory so the
  // candidate layer's known-coordinate retrieval survives after the block
  // leaves the live sensor range. It is deliberately NOT added to the `ores`
  // scan: `discoveredOres` stays `_ore`-only and obsidian carries no
  // prospecting semantics.
  const obsidian = scanBlockPositions(bot, ['obsidian'], 64, 32, dimensionProvenance) ?? []
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
    if (event === 'CONTAINER_READY') {
      // A VERIFIED container placement proved the block stands at this cell. It
      // is recorded as a durable world fact through the SAME `kind: 'station'`
      // known-resource envelope every other station uses (so the sensor merges
      // it into `WorldState.containers` as a `remembered` entry), which is what
      // makes a re-visit OPEN the box standing there instead of re-planning a
      // placement of an item that is no longer in the inventory. An unverified
      // placement never emits the marker, so nothing is remembered here.
      const known = containerReadyKnownResource(detail, ctx.worldKey)
      if (known === null) return
      const added = mergeKnownResources(world.knownResources, [known], (event, detail) => ctx.log(event, detail), ctx.worldKey.worldEpoch)
      if (added > 0) ctx.proposeWorldMemory({ knownResources: [known] })
      ctx.log('CONTAINER_REGISTERED', {
        block: known.name,
        at: stationKey(known),
        source: 'placed',
      })
    }
  }

  /**
   * `KNOWN_RESOURCE_FALSIFIED reason=block_mined` (the sensor proved the block is
   * gone) evicts the durable cell, in the same order the host replica applies
   * removals and merges. A `mob_gone`/`drop_absent` verdict deliberately does
   * NOT delete: the landmark is not disproved, and the fabric scan would re-mint
   * the cell on the next tick, so the sensor re-derives the withhold instead
   * (see `knownResourceFalsifiedRemovals`).
   */
  function handleKnownResourceFalsified(detail: Record<string, unknown> | undefined): void {
    // The live world the sensor probed: a `block_mined` proof can only invalidate
    // a row attributable to it (see `knownResourceFalsifiedRemovals`).
    const removed = knownResourceFalsifiedRemovals(world.knownResources, detail, ctx.worldKey.dimension)
    if (removed.length === 0) return
    const keys = new Set(
      removed.map((resource) => `${resource.name}@${Math.round(resource.x)},${Math.round(resource.y)},${Math.round(resource.z)}`),
    )
    for (let index = world.knownResources.length - 1; index >= 0; index -= 1) {
      const resource = world.knownResources[index]
      if (resource === undefined) continue
      const key = `${resource.name}@${Math.round(resource.x)},${Math.round(resource.y)},${Math.round(resource.z)}`
      if (keys.has(key)) world.knownResources.splice(index, 1)
    }
    ctx.proposeWorldMemory({ removeKnownResources: removed.map((resource) => ({ ...resource })) })
    for (const resource of removed) {
      ctx.log('KNOWN_RESOURCE_STALE', {
        item: resource.name,
        at: `${Math.round(resource.x)},${Math.round(resource.y)},${Math.round(resource.z)}`,
        reason: 'block_mined',
      })
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
  /**
   * The DURABLE-WRITE gate, the second half of the same capability. Even with the
   * scan gated, the writer is the last layer that can put a cell into durable
   * memory, so it re-checks provenance itself: a cell whose column is not
   * attributable to the live dimension is refused with the SAME typed line the
   * sensor uses (never a silent drop), naming the cell, the read's provenance, the
   * live dimension and the action. This is the exact stamp that produced
   * `{"name":"jungle_log","dimension":"minecraft:the_nether"}`: the stamp was
   * correct and the DATA was not, which is why only a provenance check - not a
   * dimension check - can refuse it.
   */
  function attributableCell(at: Vec3Json, item: string): boolean {
    const refusal = writeRefusal(dimensionProvenance, at, 'known-resource-write')
    if (refusal === null) return true
    dimensionProvenance.refuseRead(refusal)
    ctx.log('KNOWN_RESOURCE_PROVENANCE_REFUSED', {
      item,
      cell: `${Math.round(at.x)},${Math.round(at.y)},${Math.round(at.z)}`,
      chunk: `${refusal.chunk.x},${refusal.chunk.z}`,
      provenance: refusal.provenance.length === 0 ? 'unknown' : refusal.provenance,
      dimension: refusal.liveDimension.length === 0 ? 'unknown' : refusal.liveDimension,
      reason: refusal.reason,
      action: 'refused',
      worldKey: `${ctx.worldKey.serverId}|${ctx.worldKey.dimension}|${ctx.worldKey.worldEpoch}`,
    })
    return false
  }
  for (const ore of ores) {
    if (!attributableCell(ore, 'ore')) continue
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
    if (!attributableCell(log, 'log')) continue
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
    if (!attributableCell(block, 'obsidian')) continue
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
    for (const position of scanBlockPositions(bot, NETHER_STRUCTURE_BLOCK_NAMES, 64, 64, dimensionProvenance) ?? []) {
      if (!attributableCell(position, 'nether_structure')) continue
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
  // Fail-closed attribution evidence (measured, run-mucqgrdo-21plr): a durable
  // row that records no dimension cannot be offered as a locomotion target in
  // ANY world, so it is reported here ONCE per generation-start scan instead of
  // being silently dropped or silently defaulted. The row stays in durable
  // memory and is re-stamped by the next observation of the cell.
  const unattributedResources = world.knownResources.filter(
    (resource) => resource.dimension === undefined || resource.dimension.length === 0,
  )
  if (unattributedResources.length > 0) {
    ctx.log('KNOWN_RESOURCE_UNATTRIBUTED', {
      count: unattributedResources.length,
      recordedDimension: null,
      liveDimension: ctx.worldKey.dimension,
      worldEpoch: ctx.worldKey.worldEpoch,
      cells: unattributedResources
        .slice(0, 8)
        .map((resource) => `${resource.name}@${resourceAt(resource)}`),
      action: 'kept-not-offered',
    })
  }
  const staleRemovals = evictStaleKnownResources(
    bot,
    world.knownResources,
    ctx.worldKey,
    (event, detail) => ctx.log(event, detail),
    dimensionProvenance,
  )
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
    // Fail-closed attribution: durable rows that name no dimension. They are
    // kept (never deleted) and refused as targets in every world.
    knownResourcesUnattributed: unattributedResources.length,
    knownTraversals: world.knownTraversals.length,
    moveFailures: world.moveFailures.length,
    removedStations: removedStations.length,
  })

  const liveWorldKey = `${ctx.worldKey.serverId}|${ctx.worldKey.dimension}|${ctx.worldKey.worldEpoch}`
  // The run's own durable ladder record (class-A ledger + durable world outcomes).
  // This is what makes a NON-LOSSY death non-lossy: the resume may not re-enter at
  // the earliest rung the leftover kit implies when this run already reached a
  // higher one. The record is evidence only; the ladder owns the floor decision.
  const ledgerProgress = durableLadderProgressFromLedger(ctx.ledgerSnapshot, liveWorldKey, counts, world)
  if (ledgerProgress !== null) {
    ctx.log('LADDER_DURABLE_BASIS', {
      rungId: ledgerProgress.rungId,
      rungIndex: ledgerProgress.rungIndex,
      sources: ledgerProgress.sources,
      evidence: ledgerProgress.evidence,
      ledgerFrontierRungId: ctx.ledgerSnapshot?.basis?.frontierRungId ?? null,
      ledgerFrontierRungIndex: ctx.ledgerSnapshot?.basis?.frontierRungIndex ?? null,
    })
  }
  const resume = deriveResumeRung(counts, world, (event, detail) => ctx.log(event, detail), ledgerProgress)
  // A genuine total loss still resets, as today: an empty kit discards the durable
  // record for this generation's whole lifetime, so `proposeLedger()` below cannot
  // write the erased position back into the durable state.
  const durableLadderProgress = durableProgressForGeneration(resume, ledgerProgress)
  if (ledgerProgress !== null && durableLadderProgress === null) {
    ctx.log('LADDER_DURABLE_BASIS_DISCARDED', {
      reason: 'inventory-empty',
      rungId: ledgerProgress.rungId,
      rungIndex: ledgerProgress.rungIndex,
      invEmpty: resume.invEmpty,
    })
  }
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
  // On a death reset the host has already settled the post-respawn window (see
  // LADDER_INVENTORY_SETTLE), so `counts` is the settled observation; this marker
  // owns the reset's inventory basis, unlike the host's pending-respawn marker.
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
      // The typed resume basis: what raised the floor above the leftover kit.
      resumeBasis: resume.resumeBasis,
      achievedRungId: resume.achievedRungId ?? null,
      achievedRungIndex: resume.achievedRungIndex ?? -1,
      achievedSources: resume.achievedSources ?? [],
      ...(resume.fallbackFrom === null ? {} : { fallbackFrom: resume.fallbackFrom, fallbackNeed: resume.fallbackNeed }),
      inventory: counts,
    })
  }
  if (ctx.resetReason !== null) {
    ctx.log('LADDER_RESET', {
      reason: ctx.resetReason,
      inventoryBasis: 'live',
      invEmpty: resume.invEmpty,
      rungIndex: ladder.rungIndex,
      rungId: ladder.rungId,
      // `durable` here means the reset resumed a rung the run had already reached
      // (non-lossy death); `inventory` means the kit alone decided it.
      resumeBasis: resume.resumeBasis,
      achievedRungId: resume.achievedRungId ?? null,
      achievedRungIndex: resume.achievedRungIndex ?? -1,
      achievedSources: resume.achievedSources ?? [],
      goals: ladder.goals.map((goal) => goal.description),
    })
  }

  // The planner IS the env switch: deterministic keeps the original single-shot
  // contract, so every decision record truthfully reports `llm.called == false`.
  // `llm` turns the controller's exception paths into bounded replans. The
  // explicit Reach probe selects the real production VTR scheduler directly;
  // it leaves the compatibility ladder/ledger out of this run's WHAT path.
  const vtrReachProbe = process.env.BUDDY_VTR_REACH_PROBE?.trim() === '1'
  const configuredPlannerMode = resolvePlannerMode()
  const plannerMode = vtrReachProbe ? 'llm' : configuredPlannerMode
  if (vtrReachProbe) {
    ctx.log('VTR_REACH_PROBE_CONFIGURED', {
      mission: { kind: 'inventory_at_least', item: ctx.goalItem, count: ctx.goalCount },
      compatibilityLadder: 'observer-only',
      ledgerRestore: 'disabled',
      plannerBootstrap: 'disabled',
      system2Mode: process.env.BUDDY_SYSTEM2 ?? 'configuration-default',
      jevPolicyMode: process.env.BUDDY_POLICY ?? 'configuration-default',
    })
  }

  // A retryable Jev provider outage stops this generation and lets HOST retry
  // under the same model authority. Construction/configuration failures and
  // non-Jev model failures retain the process-fatal behavior.
  let controllerForRecovery: JevController | null = null
  let modelRecoveryStopReason: string | null = null
  const terminateResident = (error?: FatalModelError): never => {
    if (error !== undefined && controllerForRecovery !== null && modelFailureDisposition(error, true) === 'recover-generation') {
      const authorityKind = modelFailureAuthorityKind(error)
      const authority = authorityKind === 'system2'
        ? controllerForRecovery.system2AuthorityStack
        : { provider: controllerForRecovery.policyProvider, model: controllerForRecovery.policyModel }
      modelRecoveryStopReason = 'model-unavailable'
      ctx.log('MODEL_UNAVAILABLE', {
        code: 'MODEL_UNAVAILABLE',
        action: 'stop-generation-for-recovery',
        context: error.context,
        attempts: error.attempts,
        error: error.reason,
        retryable: true,
        authorityKind,
        generationId: id,
        sourceSha: ctx.sourceSha ?? null,
        buildHash: ctx.buildHash ?? null,
        provider: authority.provider,
        model: authority.model,
      })
      const recovery = stopGenerationForModelRecovery(error, id, controllerForRecovery)
      if (recovery !== null) throw recovery
    }
    ctx.log('ERROR', { code: 'MODEL_UNAVAILABLE', action: 'terminate-resident', pid: process.pid, exitCode: 1 })
    process.exit(1)
  }

  // Durable caches (survive hot reloads; keyed by world-state hash).
  const cacheNamespace = worldCacheNamespace(ctx.worldKey)
  const postDeathRecovery = ctx.resetReason === 'death'
  const mercuryConfigPath = process.env.BUDDY_SYSTEM2_CONFIG ?? join(process.cwd(), 'system2.config.json')
  const mercuryEnablement = resolveMercuryEnablement(plannerMode, mercuryConfigPath)
  const mercuryCachePath = fileURLToPath(new URL(`./mercury-cache-${cacheNamespace}.json`, import.meta.url))
  const mercury = mercuryEnablement.enabled
    ? new MercurySystem2({
        summarize: (request, trigger) =>
          buildMercurySummary(
            bot,
            world,
            request,
            trigger,
            ctx.deathRecovery ?? null,
            (event, detail) => ctx.log(event, detail),
          ),
        log: (event, detail) => ctx.log(event, detail),
        callsPath: mercuryCallsPath(ctx.logDir),
        cachePath: mercuryCachePath,
        sourceSha: ctx.sourceSha ?? null,
        buildHash: ctx.buildHash ?? null,
        requireFreshProviderDecision: ctx.recoverySystem2Authority !== undefined && ctx.recoverySystem2Authority !== null,
        worldKey: { serverId: ctx.worldKey.serverId, dimension: ctx.worldKey.dimension, worldEpoch: ctx.worldKey.worldEpoch },
        terminate: terminateResident,
        postDeathRecovery,
        isCurrent: () => ctx.lease.isActive(id),
        generationId: id,
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
        // The row's OWN dimension is the only attribution evidence. A row that
        // records none stays unattributed here - never defaulted from the durable
        // bucket, which has been measured to hold wrong-world cells - so the jev
        // dimension gate refuses it typed (`reason=dimension_unattributed`)
        // instead of letting the body walk to it.
        ...(resource.dimension === undefined ? {} : { dimension: resource.dimension }),
        ...(resource.worldEpoch === undefined ? {} : { worldEpoch: resource.worldEpoch }),
      })),
    // Keep durable stations in the controller envelope even when the same
    // item is held.  `planPrereqOptions` still ranks a valid held placement
    // first; these entries are the fallback when placement geometry refuses.
    //
    // A `KnownStation` row has no dimension field of its own, so the envelope is
    // the only place that can carry its attribution. The value is the world key
    // this memory belongs to - the world the station was registered in - not a
    // default: `world` is exactly `worldMemoryByKey[serverId|dimension|epoch]`.
    // Without it every station route dies at the fail-closed dimension gate.
    ...world.furnaces.map((furnace) => ({
      name: 'furnace',
      kind: 'station' as const,
      position: { x: furnace.x, y: furnace.y, z: furnace.z },
      dimension: ctx.worldKey.dimension,
      worldEpoch: ctx.worldKey.worldEpoch,
    })),
    ...world.craftingTables.map((table) => ({
      name: 'crafting_table',
      kind: 'station' as const,
      position: { x: table.x, y: table.y, z: table.z },
      dimension: ctx.worldKey.dimension,
      worldEpoch: ctx.worldKey.worldEpoch,
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

  const configuredObjective = { goalItem: ctx.goalItem, goalCount: ctx.goalCount }
  const rootGoal = plannerMode === 'deterministic' ? compatibilityRootGoal(ladder.goals, configuredObjective) : configuredObjective
  if (plannerMode === 'deterministic' && (rootGoal.goalItem !== ctx.goalItem || rootGoal.goalCount !== ctx.goalCount)) {
    ctx.log('ROOT_GOAL_PROJECTED', {
      source: 'ladder-frontier',
      goalItem: rootGoal.goalItem,
      goalCount: rootGoal.goalCount,
      legacyGoalItem: ctx.goalItem,
      legacyGoalCount: ctx.goalCount,
      rungId: ladder.rungId,
    })
  }

  const options: Partial<JevAgentOptions> & Pick<JevAgentOptions, 'kernelAuthority'> = {
    goalItem: rootGoal.goalItem,
    goalCount: rootGoal.goalCount,
    // V4 Mission truth is the run's configured objective, never the deterministic
    // benchmark ladder's compatibility projection. The Reach scheduler reads
    // this separately before GoalQueue/System2/π dispatch.
    vtrMission: {
      id: `run-mission:${ctx.goalItem}:${ctx.goalCount}`,
      kind: 'inventory_at_least',
      item: ctx.goalItem,
      count: ctx.goalCount,
    },
    vtrReachProbe,
    // Every decision-time world read carries provenance: a cell whose column was
    // not loaded under the live dimension is refused (typed) instead of read.
    dimensionProvenance,
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
    serverId: ctx.worldKey.serverId,
    worldEpoch: ctx.worldKey.worldEpoch,
    // Pass HOST identities through a dedicated options channel. DecisionRecord
    // construction does not inspect Jev answers or candidate metadata for these.
    decisionProvenance: {
      runId: ctx.runId ?? null,
      generationId: id,
      sourceSha: ctx.sourceSha ?? null,
      buildHash: ctx.buildHash ?? null,
    },
    terminateOnModelFailure: terminateResident,
    recoveryPolicyAuthority: ctx.recoveryPolicyAuthority ?? null,
    recoverySystem2Authority: ctx.recoverySystem2Authority ?? null,
    recoverySourceSha: ctx.recoverySourceSha ?? null,
    generationSourceSha: ctx.sourceSha ?? null,
    rejectSystem2RecoveryPlan: (rejection) => {
      modelRecoveryStopReason = 'model-unavailable'
      ctx.log('MODEL_RECOVERY_AUTHORITY_REJECTED', {
        authorityKind: 'system2',
        generationId: id,
        ...rejection,
      })
      controllerForRecovery?.stopForModelRecovery()
      throw new ModelRecoveryRequested('system2-authority', id)
    },
    actuation: 'pathfinder',
    actuationPort,
    kernelAuthority,
    reach: 5,
    scanRadius: 48,
    verbose: true,
    eventSink: (event, detail) => {
      ctx.log(event, bindGenerationEventIdentity(detail, {
        runId: ctx.runId ?? null,
        generationId: id,
        sourceSha: ctx.sourceSha ?? null,
        buildHash: ctx.buildHash ?? null,
      }))
      m2Snapshot?.recordMarker(event, detail)
      const actionId = typeof detail.actionId === 'string' ? detail.actionId : null
      const verified = detail.verified === true
      const status = typeof detail.status === 'string' ? detail.status : null
      if (actionId !== null && status !== null) m2Snapshot?.recordTerminal(actionId, { verified, status })
      handleStationEvent(event, detail)
      handleKnownResourceFalsified(detail)
      // #354: the ONE traversal producer. The executor/controller outcome stream
      // is already mirrored here; no extra listener or sensor is added.
      recordTraversalOutcome(event, detail)
    },
    moveFailureEntries: world.moveFailures,
    onMoveFailureMemoryChange: (entries) => {
      world.moveFailures = entries.map((entry) => ({ ...entry }))
      ctx.proposeWorldMemory({ moveFailures: world.moveFailures })
    },
    // #oscillation-boundary: the durable local-motion record is seeded from the
    // host's class-A world memory and written straight back, exactly like the
    // coordinate failure memory above. The record only ever holds the BODY's
    // cell envelope, so the durable row's own starvation counter and this one
    // cannot become two owners of one question.
    localOscillationRecord: world.localOscillation ?? null,
    onLocalOscillationChange: (record) => {
      world.localOscillation = record === null ? null : { ...record, cells: [...record.cells] }
      ctx.proposeWorldMemory({ localOscillation: world.localOscillation })
    },
    // The durable cross-action bound is seeded from the host's class-A world
    // memory and written straight back, exactly like the coordinate failure
    // memory and the local-motion record above. It has to be durable: the
    // measured `ASCEND:habitat:p3_68_22` runaway re-issued 161 attempts at one
    // cell across a generation swap, and every generation-scoped counter was
    // erased both by that swap and by the interleaved `progress=body` step.
    repeatedOutcomeEntries: world.repeatedOutcomes,
    onRepeatedOutcomeChange: (entries) => {
      world.repeatedOutcomes = entries.map((entry) => ({ ...entry }))
      ctx.proposeWorldMemory({ repeatedOutcomes: world.repeatedOutcomes })
    },
    knownResources: groundedWaypoints,
    // #prereq-dominated: the deterministic ladder owns the capability closure
    // (rung `satisfied` + recipe/smelt consumers). A queued prerequisite whose
    // purposes are already fulfilled by better held items retires mid-generation
    // instead of starving behind a station precondition until a reload.
    dominatedGoalReason: (goal, live) => dominatedGoalReasonForPlannerMode(plannerMode, goal, live, world),
    // #plan-reconciliation: the live plan/objective identity + the code-owned
    // supersession proof. The controller compares every unfinished durable row's
    // authoring identity against this once per tick, retires only rows this proof
    // calls obsolete, and otherwise asks System2 (the WHAT owner) to re-plan with
    // the compact state the request already carries.
    planIdentity: () => {
      if (plannerMode !== 'deterministic') return { ...SYSTEM2_MISSION_PLAN_IDENTITY }
      const counts = inventoryCounts(bot)
      const frontier = deriveResumeRung(counts, world, undefined, durableLadderProgress)
      const goals = buildLadder(counts, world, undefined, { resumeRungIndex: frontier.rungIndex }).goals
      const root = compatibilityRootGoal(goals, { goalItem: ctx.goalItem, goalCount: ctx.goalCount })
      return planIdentityFor(frontier, root)
    },
    supersededGoalReason: (goal, identity) =>
      plannerMode === 'deterministic'
        ? supersededPlanObsoleteProof(goal, identity, inventoryCounts(bot), world)
        : null,
  }

  const controller = new JevController(bot, options)
  controllerForRecovery = controller
  actuationAuthoritySource = controller
  ctx.log('KERNEL_AUTHORITY_READY', {
    id,
    journal: join(ctx.logDir, 'kernel-authority.jsonl'),
    world: `${ctx.worldKey.serverId}|${ctx.worldKey.dimension}|${ctx.worldKey.worldEpoch}`,
    kernelAuthority: 'on',
    legacyReachAuthority: 'off',
    phase: 'production-authority',
  })
  // The stock fallback has no DESCEND branch; without this wrapper a stalled
  // stone/iron goal whose only productive candidate is a descent step WAITs
  // forever and wedges. Hazards from death are excluded here.
  installDescendAwarePolicy(controller, world.hazards, (event, detail) => ctx.log(event, detail))
  // #426: the restore basis describes the frontier computed from the CURRENT live
  // ladder, not the inventory-only resume hint (`resume.rungId`) used to seed it -
  // otherwise a run that reached a rung through durable progress restores against
  // a stale floor. `liveWorldKey` is the same key the durable-progress read above
  // already uses, so there is one spelling of it.
  const liveLedgerBasis: LedgerBasis = ledgerBasisForLiveFrontier(liveWorldKey, ladder)
  if (vtrReachProbe) {
    ctx.log('VTR_REACH_PROBE_QUEUE_EMPTY', {
      source: 'configured Mission',
      restoredLegacyRows: 0,
      authority: 'vtr-transition-scheduler',
    })
  } else {
    restoreLedgerIntoController(controller, plannerMode, ctx.ledgerSnapshot, ledgerPath, counts, world, liveLedgerBasis, ctx.log)
  }
  const brain = new PlannerBrain({
    bot,
    world,
    log: (event, detail) => ctx.log(event, detail),
    runId: ctx.runId ?? null,
    generationId: id,
    sourceSha: ctx.sourceSha ?? null,
    buildHash: ctx.buildHash ?? null,
    requireFreshProviderDecision: ctx.recoverySystem2Authority !== undefined && ctx.recoverySystem2Authority !== null,
    mode: plannerMode,
    mercury,
    terminate: terminateResident,
    refreshLiveFacts: () => refreshLiveFacts('system2-grounding'),
    durableLadderProgress,
  })

  // Option compilation is unconditional: every planned goal is compiled into a
  // grounded OptionSpec and unmet preconditions are expanded into their
  // prerequisite chain before the queue is seeded. The pre-compiler
  // verbatim-PlannedGoal path is retired, so there is no environment switch.
  const optionCompilerEnabled = true
  const system2: System2Brain = optionCompilerEnabled
    ? new OptionCompilingSystem2(brain, {
        log: (event, detail) => ctx.log(event, detail),
        snapshot: () => optionSnapshotFromBot(ctx.bot, world, ctx.bot.game?.dimension ?? null),
      })
    : brain
  controller.setSystem2(system2)

  ctx.log('GENERATION_READY', {
    runId: ctx.runId ?? null,
    id,
    generationId: id,
    sourceSha: ctx.sourceSha ?? null,
    buildHash: ctx.buildHash ?? null,
    rungIndex: ladder.rungIndex,
    rungId: ladder.rungId,
    productionPlanAuthority: vtrReachProbe ? 'vtr-reach-probe' : plannerMode === 'deterministic' ? 'deterministic' : 'system2',
    ...(plannerMode === 'deterministic' ? { goals: ladder.goals.map((goal) => goal.description) } : {}),
    policy: controller.policyKind,
    policyProvider: controller.policyProvider,
    model: controller.policyModel,
    policyModel: controller.policyModel,
    system2Provider: controller.system2Provider,
    system2Model: controller.system2Model,
    system2ConfiguredProvider: controller.system2AuthorityStack.provider,
    system2ConfiguredModel: controller.system2AuthorityStack.model,
    system2AuthorityStack: controller.system2AuthorityStack,
    system2LastAuthority: { provider: controller.system2Provider, model: controller.system2Model },
    deterministicFallbackEnabled: controller.deterministicFallbackEnabled,
    planner: brain.mode,
    plannerModel: brain.model,
    advisor: mercuryEnablement.enabled
      ? `${mercury?.provider ?? 'gateway-system2'}:${mercury?.model ?? process.env.BUDDY_SYSTEM2_MODEL ?? process.env.BUDDY_MERCURY_MODEL ?? MERCURY_MODEL_DEFAULT}`
      : 'none',
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
  let humanIntentAttached = false
  const pendingHumanCounts = new Map<string, { item: string }>()

  const replyToHuman = (username: string, message: string): void => {
    if (!ctx.lease.isActive(id)) return
    controller.withHostScope('human-intent-reply', () => bot.chat(`/tell ${username} ${message}`))
    ctx.log('HUMAN_INTENT_REPLY', { username, message })
  }

  const submitHumanCollect = (username: string, item: string, count: number): void => {
    const added = controller.submitHumanPlan(
      [
        {
          kind: 'collect',
          description: `collect ${count} x ${item}`,
          targetItem: item,
          requiredCount: count,
          semanticOptionIntent: `human: collect ${count} x ${item}`,
          semanticOptionTemplateId: `human:collect:${item}`,
          semanticOptionInstanceId: `human:collect:${item}:count=${count}`,
        },
      ],
      username,
    )
    ctx.log('HUMAN_INTENT_COMMAND', {
      username,
      command: 'collect',
      item,
      count,
      accepted: added.length > 0,
    })
    replyToHuman(
      username,
      added.length > 0 ? `${item} を ${count} 個集めます。` : `${item} x${count} はすでに依頼済みです。`,
    )
  }

  const onHumanMessage = (username: string, message: string): void => {
    if (!ctx.lease.isActive(id) || username === bot.username) return

    const pending = pendingHumanCounts.get(username)
    if (pending !== undefined) {
      const count = parseQuantityReply(message)
      if (count !== null) {
        pendingHumanCounts.delete(username)
        submitHumanCollect(username, pending.item, count)
        return
      }
    }

    const command = parseHumanIntentCommand(message, bot.username)
    if (command === null) return

    if (command.kind === 'collect') {
      if (command.count === null) {
        pendingHumanCounts.set(username, { item: command.item })
        ctx.log('HUMAN_INTENT_CLARIFY', { username, item: command.item })
        replyToHuman(username, `${command.item} は何個？ 数字だけで答えてください。`)
        return
      }
      pendingHumanCounts.delete(username)
      submitHumanCollect(username, command.item, command.count)
      return
    }

    if (command.kind === 'status') {
      const queue = controller.goalQueueState
      const current = queue.current
      const action = controller.agent.current
      replyToHuman(
        username,
        current === null
          ? `待機中。human queue=0 / total=${queue.depth}`
          : `goal=${current.description} origin=${current.origin} action=${action?.kind ?? 'none'} phase=${action?.phase ?? 'none'} queue=${queue.depth}`,
      )
      ctx.log('HUMAN_INTENT_COMMAND', { username, command: 'status', currentGoal: current?.id ?? null })
      return
    }

    if (command.kind === 'stop' || command.kind === 'free') {
      pendingHumanCounts.delete(username)
      const cleared = controller.clearHumanPlan(username, command.kind)
      ctx.log('HUMAN_INTENT_COMMAND', { username, command: command.kind, cleared: cleared.length })
      replyToHuman(
        username,
        cleared.length > 0
          ? `human task を ${cleared.length} 件解除しました。自律ミッションへ戻ります。`
          : '解除する human task はありません。',
      )
      return
    }

    if (command.reason === 'count_out_of_range') {
      replyToHuman(username, `数量は 1〜${HUMAN_INTENT_MAX_COUNT} で指定してください。`)
      return
    }
    replyToHuman(username, 'M0: collect/mine/get/fetch、status、stop、free を使えます。')
  }

  const onHumanChat = (username: string, message: string): void => onHumanMessage(username, message)
  const onHumanWhisper = (username: string, message: string): void => onHumanMessage(username, message)

  function attach(): void {
    if (humanIntentAttached) return
    bot.on('chat', onHumanChat)
    bot.on('whisper', onHumanWhisper)
    humanIntentAttached = true
    ctx.log('HUMAN_INTENT_READY', {
      agent: bot.username,
      commands: ['collect', 'status', 'stop', 'free'],
      llm: false,
    })
  }

  function start(): void {
    if (runPromise !== null) return
    ctx.lease.assertActive(id, 'generation.start')
    controller.start()
    ready = true
    runPromise = controller
      .wait()
      .then((result: RunSummary) => {
        stopped = modelRecoveryStopReason ?? result.stopped
        ctx.log('GENERATION_STOP', {
          id,
          stopped,
          success: result.success,
          ticks: result.ticks,
          verifiedDigs: result.verifiedDigs,
          subgoalsDone: result.subgoalsDone,
          subgoalCount: result.subgoalCount,
          jevCalls: result.jevCalls,
        })
        const kernelSummary = kernelSession.summary()
        ctx.log('KERNEL_AUTHORITY_SUMMARY', {
          id,
          mutationsObserved: kernelSummary.mutationsObserved,
          mutationsMapped: kernelSummary.mutationsMapped,
          mutationsDeniedByLease: kernelSummary.mutationsDeniedByLease,
          mutationsAttributedToTransition: kernelSummary.mutationsAttributedToTransition,
          mutationsUnguarded: kernelSummary.mutationsUnguarded,
          lifecycleCommands: kernelSummary.lifecycleCommands,
          kernelDenied: kernelSummary.kernelDenied,
          blockers: kernelSummary.blockers.length,
          coverageComplete: kernelSummary.coverageComplete,
          authorityMode: kernelSummary.authorityMode,
          gateDenials: kernelSummary.gateDenials.length,
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
      await controller.quiesce()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.log('ERROR', { id, where: 'quiesce.stop', message })
    }
    proposeLedger()
    // `controller.quiesce()` awaits an already-committed bounded escape during
    // model recovery. Its declared Skill budget plus drain grace is the terminal
    // bound; HOST must not revoke the lease on an unrelated 3 s timer.
    await (runPromise ?? Promise.resolve())
  }

  function proposeLedger(): void {
    try {
      const holder = controller as unknown as { queue: { snapshot(): GoalQueueSnapshot } }
      // The durable basis must NOT shrink to the inventory-only frontier: this
      // proposal is what the next generation reads as the run's ladder record, so
      // proposing the inventory-shaped rung here was exactly how a non-lossy death
      // erased the position it was supposed to keep (measured `run-mubobiq6-12onv`:
      // basis frontierRungId=charcoal/6 while the portal was verified and the run
      // had reached blaze_rods).
      const current = deriveResumeRung(inventoryCounts(bot), world, undefined, durableLadderProgress)
      const inventoryOnly = deriveResumeRung(inventoryCounts(bot), world)
      const basis: LedgerBasis = {
        worldKey: liveWorldKey,
        frontierRungId: current.rungId,
        frontierRungIndex: current.rungIndex,
      }
      if (current.rungIndex !== inventoryOnly.rungIndex || current.rungId !== inventoryOnly.rungId) {
        ctx.log('LEDGER_BASIS_DURABLE', {
          rungId: current.rungId,
          rungIndex: current.rungIndex,
          inventoryRungId: inventoryOnly.rungId,
          inventoryRungIndex: inventoryOnly.rungIndex,
          achievedRungId: current.achievedRungId ?? null,
          achievedRungIndex: current.achievedRungIndex ?? -1,
          achievedSources: current.achievedSources ?? [],
          resumeBasis: current.resumeBasis,
        })
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
    // The HOST's observe loop reads this rung for milestone evidence and the
    // ledger basis it commits at heartbeat. Model-mode queue identity and its
    // configured compatibility objective do not derive from this frontier.
    const frontier = deriveResumeRung(truth.inventory, world, undefined, durableLadderProgress)
    const rootGoal =
      plannerMode === 'deterministic'
        ? compatibilityRootGoal(
            buildLadder(truth.inventory, world, undefined, { resumeRungIndex: frontier.rungIndex }).goals,
            { goalItem: ctx.goalItem, goalCount: ctx.goalCount },
          )
        : { goalItem: ctx.goalItem, goalCount: ctx.goalCount }
    const current = controller.agent.current
    return {
      running: controller.isRunning,
      sourceSha: ctx.sourceSha ?? null,
      buildHash: ctx.buildHash ?? null,
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
      // Live milestone predicate observations for the HOST observe loop to persist
      // run-scoped. Computed from THIS generation's live inventory + durable world
      // memory with the ladder's own predicates; the HOST owns the durable write.
      milestonePredicates: evaluateMilestonePredicates(truth.inventory, world, Date.now()),
      plannedGoals: plannerMode === 'deterministic' ? ladder.goals.length : controller.goalQueueState.depth,
      rungIndex: frontier.rungIndex,
      rungId: frontier.rungId,
      goalItem: rootGoal.goalItem,
      goalCount: rootGoal.goalCount,
      ledgerBasis: {
        worldKey: liveWorldKey,
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
    if (plannerMode !== 'deterministic') return { ok: SYSTEM2_HUMAN_MISSION.length > 0, reason: null, goalCount: 0 }
    const goalCount = ladder.goals.length
    return { ok: goalCount >= 1, reason: goalCount >= 1 ? null : 'deterministic planner produced an empty plan', goalCount }
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
      if (humanIntentAttached) {
        bot.removeListener('chat', onHumanChat)
        bot.removeListener('whisper', onHumanWhisper)
        humanIntentAttached = false
      }
      pendingHumanCounts.clear()
      try {
        controller.stop()
      } catch {
        // best effort
      }
      const kernelSummary = kernelSession.summary()
      ctx.log('KERNEL_AUTHORITY_SUMMARY', {
        id,
        mutationsObserved: kernelSummary.mutationsObserved,
        mutationsMapped: kernelSummary.mutationsMapped,
        mutationsDeniedByLease: kernelSummary.mutationsDeniedByLease,
        mutationsAttributedToTransition: kernelSummary.mutationsAttributedToTransition,
        mutationsUnguarded: kernelSummary.mutationsUnguarded,
        lifecycleCommands: kernelSummary.lifecycleCommands,
        kernelDenied: kernelSummary.kernelDenied,
        blockers: kernelSummary.blockers.length,
        coverageComplete: kernelSummary.coverageComplete,
        authorityMode: kernelSummary.authorityMode,
        gateDenials: kernelSummary.gateDenials.length,
      })
    },
    status,
    worldProbeProvenance: (columns) => dimensionProvenance.diagnostic(columns),
    structuralSmoke,
    missionPreflight,
    stopReason: () => stopped,
    hasStopped: () => stopped !== null,
  }
}

export default createGeneration
