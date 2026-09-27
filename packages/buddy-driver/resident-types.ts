// resident-types.ts - the HOST <-> RELOADABLE-GENERATION contract.
//
// The host owns the Mineflayer connection, the reconnect loop, the log, the
// durable state store and the FILE WRITES. The generation owns one version of the
// jev-agent intelligence (controller + planner), bundled as ONE hash-stamped ESM
// file and swapped atomically on hot reload.
//
// BOUNDARY RULE (P1): the host <-> generation contract is DATA-ONLY. No Block,
// Entity, Vec3, Window, Recipe or Bot instance is ever persisted or handed across
// as durable state. Positions cross the boundary as `Vec3Json` ({x,y,z}) and the
// consumer rehydrates with `new Vec3(...)` where it needs vector methods. A plain
// `{x,y,z}` object has `Object` as its prototype and therefore NO `.floored()`,
// `.offset()` etc. - that is the entire class of `pos.floored is not a function`.
//
// This file is imported with `import type` only, so the host's native TypeScript
// stripping removes it completely (no runtime import, no cycle).
import type { Bot } from 'mineflayer'
import type { GoalQueueSnapshot, GoalQueueState, LedgerBasis } from '../jev-agent/src/goalQueue.ts'
import type { MoveFailEntry } from '../jev-agent/src/moveFailMemory.ts'
import type { LocalOscillationRecordJson } from '../jev-agent/src/localOscillation.ts'
import type { DimensionProvenanceDiagnostic } from './dimension-provenance.ts'
import type { RepeatedOutcomeEntryJson } from '../jev-agent/src/repeatedOutcomeEscalation.ts'
import type { MilestonePredicateObservation } from './milestone-predicates.ts'
import type { ModelAvailabilitySnapshot } from './model-recovery.ts'

/** Bump when the host/generation interface changes incompatibly. */
export const CONTRACT_VERSION = 3

export interface Vec3Json {
  x: number
  y: number
  z: number
}

/** Server identity + dimension + world epoch. A world reset with the same seed is
 * still a different world, so stale coordinates must never leak across epochs. */
export interface WorldKey {
  serverId: string
  dimension: string
  worldEpoch: number
}

export function worldKeyString(key: WorldKey): string {
  return `${key.serverId}|${key.dimension}|${key.worldEpoch}`
}

/**
 * Thin traversal-failure memory. Never repeat hop-hop-hop on the same face:
 * record (obstacleSignature, from, toward, wallHeight, failureKind, attempts).
 * The order is: stock pathfinder detour -> STEP/stair-cut if the resource policy
 * allows -> suppress the candidate and replan.
 */
export interface TraversalFailure {
  obstacleSignature: string
  from: Vec3Json
  toward: Vec3Json
  wallHeight: number
  failureKind: string
  attempts: number
  lastSeenAt: number
}

/**
 * Provenance of a death hazard. `production` hazards come from real deaths and
 * may be persisted / consulted by candidate filtering. `simulation` hazards come
 * from the operator `simdeath` rehearsal and MUST stay in a separate,
 * non-durable namespace so a rehearsal can never poison a safe coordinate (#26).
 */
export type HazardSource = 'production' | 'simulation'

/** A coordinate that killed the bot. Registered on death; a coordinate that
 * kills twice is excluded permanently from dig/descent candidates. */
export interface DeathHazard {
  x: number
  y: number
  z: number
  /** dimension the death happened in; absent on old durable records, which are
   * then treated as applying to every dimension (conservative exclusion). */
  dimension?: string
  /** best-effort inferred cause: void | lava | water | fall | suffocation | unknown */
  reason: string
  /** how many deaths happened at/next to this coordinate */
  count: number
  firstSeenAt: number
  lastSeenAt: number
  /** provenance tag. Absent is treated as `production` for old durable state;
   * `simulation` entries are refused by the production merge path (#26). */
  source?: HazardSource
}

/** Snapshot of the immediately preceding real death, owned by the resident
 * host and handed only to the fresh post-death generation. It is intentionally
 * ephemeral: the durable hazard map remains the long-lived coordinate memory. */
export interface DeathRecoveryContext {
  occurredAt: number
  position: Vec3Json | null
  dimension: string
  cause: string
  lostInventory: Record<string, number>
  itemsLost: number
  nearbyHostiles: Array<{ name: string; distance: number }>
  recentDeathCount: number
  recentDeathWindowMs: number
}

/** Durable world model that must survive reloads/reconnects. Inventory and
 * position are NOT mirrored here - they are SERVER TRUTH, live on the bot, and
 * are re-observed from sensors after every reload/reconnect, never restored from
 * JSON. This holds only DURABLE SEMANTIC knowledge the bot cannot re-derive
 * cheaply. All coordinates are DTOs. */
export interface KnownResourceJson {
  /** block name at the remembered cell, e.g. "iron_ore" or "oak_log" */
  name: string
  /** broad class: ore (underground), log (surface tree), station */
  kind: 'ore' | 'log' | 'station'
  x: number
  y: number
  z: number
  /** world the cell was scanned in; a coordinate is only valid for this key (#14) */
  dimension?: string
  worldEpoch?: number
  /** epoch ms when the cell was last observed to exist */
  lastSeenAt?: number
}

/**
 * Bounded size of the durable known-resource store. The generation scan and the
 * HOST delta merge all honour this same cap through `mergeKnownResourcesInto`,
 * so memory stays bounded while it keeps learning.
 */
export const KNOWN_RESOURCE_CAP = 256

/** Exact-coordinate identity of a remembered cell: `name@round(x),round(y),round(z)`. */
function knownResourceKey(resource: { name: string; x: number; y: number; z: number }): string {
  return `${resource.name}@${Math.round(resource.x)},${Math.round(resource.y)},${Math.round(resource.z)}`
}

function knownResourceAt(resource: { x: number; y: number; z: number }): string {
  return `${Math.round(resource.x)},${Math.round(resource.y)},${Math.round(resource.z)}`
}

/** A resource identity whose LAST coordinate is a durable route anchor. */
function knownResourceIdentity(resource: KnownResourceJson): string {
  const dimension = (resource.dimension ?? '').replace(/^minecraft:/, '').toLowerCase()
  const epoch = resource.worldEpoch ?? 'legacy'
  return `${resource.name}|${dimension}|${epoch}`
}

/**
 * Recency-of-proof victim selection for a bounded durable store.
 *
 * The store is a bounded "where things are / how they connect" memory, not a
 * ranked plan: when it is full a newly observed fact must displace the
 * remembered fact that is cheapest to re-derive, rather than be dropped for the
 * lifetime of the world key. The value proxy is recency of PROOF (`lastSeenAt`),
 * which every scan/refresh path maintains:
 *
 *  - the OLDEST proof is evicted first;
 *  - entries with no `seenAt` predate the bookkeeping field (legacy durable
 *    JSON) and are treated as the oldest, so they are evicted first;
 *  - ties break toward the earliest array position (stable and deterministic).
 *
 * Returns the victim index, or -1 when nothing can be evicted. Pure.
 */
function selectBoundedLruVictim<T>(list: readonly T[], seenAtOf: (entry: T) => number | undefined): number {
  let victim = -1
  let victimSeenAt = Number.NEGATIVE_INFINITY
  for (let index = 0; index < list.length; index += 1) {
    const entry = list[index]
    if (entry === undefined) continue
    const raw = seenAtOf(entry)
    const seenAt = typeof raw === 'number' && Number.isFinite(raw) ? raw : Number.NEGATIVE_INFINITY
    if (victim < 0 || seenAt < victimSeenAt) {
      victim = index
      victimSeenAt = seenAt
    }
  }
  return victim
}

/**
 * Issue #14 follow-up: capacity-eviction rule for the durable known-resource
 * store. Expressed ON TOP of `selectBoundedLruVictim`: choose the victim from
 * the MOST ABUNDANT identity class (`knownResourceIdentity`), and within that
 * class the oldest proof; only when every identity is a singleton (or nothing
 * matches) does it fall back to the generic global-oldest victim.
 *
 * The store is a bounded "where things are" memory, not a ranked plan. A dense
 * vein can contribute dozens of adjacent coal/copper cells while a rare route
 * may have only one remembered coordinate. Pure oldest-first eviction therefore
 * destroys information diversity: live, the ten remembered `obsidian` cells were
 * both duplicated and the oldest sightings, so a flood of nearby coal_ore /
 * copper_ore / oak_log (`KNOWN_RESOURCE_EVICTED item=obsidian ... reason=capacity`
 * x10) destroyed the M2 route to the portal frame. Rarity is the signal: a class
 * with one or two remembered cells is far more expensive to re-acquire than one
 * with dozens, so the abundant class pays for the new sighting.
 *
 * This is retention/compression truth only: it does not know the active goal or
 * rank resources by mission value. Returns the victim index, or -1 when nothing
 * can be evicted.
 */
export function selectKnownResourceEvictionVictim(known: KnownResourceJson[]): number {
  if (known.length === 0) return -1
  const counts = new Map<string, number>()
  for (const entry of known) {
    const identity = knownResourceIdentity(entry)
    counts.set(identity, (counts.get(identity) ?? 0) + 1)
  }

  let abundant: string | null = null
  let abundantCount = 0
  for (const [identity, count] of counts) {
    if (count > abundantCount) {
      abundant = identity
      abundantCount = count
    }
  }

  // Evict from the MOST ABUNDANT class first, and only from among that class's
  // oldest cells. The generic primitive supplies the age semantics (missing
  // `lastSeenAt` counts as oldest) and the stable earliest-index tie break, so
  // the class rule and the fallback cannot drift onto different orders.
  if (abundant !== null && abundantCount > 1) {
    const indices: number[] = []
    for (let index = 0; index < known.length; index += 1) {
      const entry = known[index]
      if (entry !== undefined && knownResourceIdentity(entry) === abundant) indices.push(index)
    }
    const relative = selectBoundedLruVictim(
      indices.map((index) => known[index] as KnownResourceJson),
      (entry) => entry.lastSeenAt,
    )
    const victimIndex = relative < 0 ? undefined : indices[relative]
    if (victimIndex !== undefined) return victimIndex
  }

  // Every identity is already a singleton (or nothing matched): fall back to the
  // generic global-oldest victim so the bounded store can still learn a genuinely
  // new identity.
  return selectBoundedLruVictim(known, (entry) => entry.lastSeenAt)
}

/**
 * The ONE bounded-LRU merge used by every durable "remembered facts" store.
 * `mergeKnownResourcesInto` and `mergeKnownTraversalsInto` are thin typed
 * wrappers over this; there is no second merge implementation.
 *
 * Contracts:
 *  - dedupe is exact-key `keyOf`;
 *  - a re-observation REFRESHES the existing entry via `refresh` instead of
 *    inserting or spending an eviction;
 *  - at the cap the store's victim rule is applied (generic oldest-proof LRU by
 *    default; see `selectBoundedLruVictim`) or, when nothing is evictable, the
 *    sighting is refused and counted in `dropped` - never silently;
 *  - `normalize` stamps/copies the stored DTO (rounded coordinates etc.).
 */
interface BoundedLruStore<T> {
  cap: number
  keyOf: (entry: T) => string
  seenAtOf: (entry: T) => number | undefined
  /** Store-specific victim rule; defaults to the generic oldest-proof LRU. The
   * known-resource store overrides it with `selectKnownResourceEvictionVictim`
   * so abundance-aware compression stays the one capacity rule. */
  selectVictim?: (list: T[]) => number
  normalize: (entry: T) => T
  refresh: (existing: T, observed: T) => void
  log?: (event: string, detail?: Record<string, unknown>) => void
  now: number
  evictedEvent: string
  evictionDetail: (victim: T, now: number) => Record<string, unknown>
  fullEvent: string
}

function mergeBoundedLruInto<T>(
  target: T[],
  found: readonly T[],
  store: BoundedLruStore<T>,
): { added: number; evicted: T[]; dropped: number; inserted: T[] } {
  const byKey = new Map<string, T>()
  for (const entry of target) {
    const key = store.keyOf(entry)
    if (!byKey.has(key)) byKey.set(key, entry)
  }
  const evicted: T[] = []
  const inserted: T[] = []
  let added = 0
  let dropped = 0
  for (const entry of found) {
    const key = store.keyOf(entry)
    const existing = byKey.get(key)
    if (existing !== undefined) {
      store.refresh(existing, entry)
      continue
    }
    if (target.length >= store.cap) {
      const victimIndex = store.selectVictim?.(target) ?? selectBoundedLruVictim(target, store.seenAtOf)
      const victim = victimIndex < 0 ? undefined : target[victimIndex]
      if (victim === undefined) {
        dropped += 1
        continue
      }
      target.splice(victimIndex, 1)
      byKey.delete(store.keyOf(victim))
      evicted.push(victim)
      store.log?.(store.evictedEvent, store.evictionDetail(victim, store.now))
    }
    const stored = store.normalize(entry)
    target.push(stored)
    byKey.set(key, stored)
    added += 1
    inserted.push(stored)
  }
  if (dropped > 0) store.log?.(store.fullEvent, { cap: store.cap, dropped })
  return { added, evicted, dropped, inserted }
}

export interface MergeKnownResourcesOptions {
  log?: (event: string, detail?: Record<string, unknown>) => void
  /** worldEpoch stamped onto the `KNOWN_RESOURCE` insert marker */
  worldEpoch?: number
  /** store bound; defaults to `KNOWN_RESOURCE_CAP` */
  cap?: number
  /** Emit the `KNOWN_RESOURCE` insert marker. The generation scan owns that
   * marker; the HOST delta merge only reports capacity evictions/drops. */
  emitInsertMarker?: boolean
}

export interface MergeKnownResourcesResult {
  /** inserts, unchanged meaning (duplicates/refreshes are not inserts) */
  added: number
  evicted: KnownResourceJson[]
  /** sightings refused because the store was full and nothing was evictable */
  dropped: number
}

/**
 * Insert observed cells into a bounded durable known-resource store.
 *
 * Contracts preserved from the original scan merge:
 *  - dedupe is exact-coordinate `name@round(x),round(y),round(z)`;
 *  - a re-observation REFRESHES `lastSeenAt` instead of inserting or evicting;
 *  - inserts stamp rounded coordinates, `dimension` and `worldEpoch`;
 *  - the array never exceeds `cap`.
 *
 * Capacity (`KNOWN_RESOURCE_EVICTED name=<n> at=<x,y,z> reason=capacity ageMs=<n>`):
 * at the cap a redundant coordinate is evicted before the last anchor of a
 * resource identity (then global-oldest only if every identity is a singleton;
 * see `selectKnownResourceEvictionVictim`). If no victim exists the sighting is
 * refused with `KNOWN_RESOURCE_FULL cap=<n> dropped=<n>` - never silently.
 */
export function mergeKnownResourcesInto(
  target: KnownResourceJson[],
  found: KnownResourceJson[],
  options: MergeKnownResourcesOptions = {},
): MergeKnownResourcesResult {
  const cap = options.cap ?? KNOWN_RESOURCE_CAP
  const log = options.log
  const emitInsertMarker = options.emitInsertMarker ?? false
  const result = mergeBoundedLruInto(target, found, {
    cap,
    keyOf: knownResourceKey,
    seenAtOf: (resource) => resource.lastSeenAt,
    // Capacity truth for resources is abundance-aware (721377e): a dense local
    // class pays for the new sighting before the last anchor of a rare class.
    selectVictim: selectKnownResourceEvictionVictim,
    normalize: (resource) => ({
      name: resource.name,
      kind: resource.kind,
      x: Math.round(resource.x),
      y: Math.round(resource.y),
      z: Math.round(resource.z),
      ...(resource.dimension === undefined ? {} : { dimension: resource.dimension }),
      ...(resource.worldEpoch === undefined ? {} : { worldEpoch: resource.worldEpoch }),
      ...(resource.lastSeenAt === undefined ? {} : { lastSeenAt: resource.lastSeenAt }),
    }),
    // Re-observation is free proof the cell is still valuable: refresh recency
    // instead of inserting a duplicate or spending an eviction on it. It is ALSO
    // proof of WHERE the cell stands, so a row that never recorded a dimension is
    // stamped with the observing world now (#14, run-mucqgrdo-21plr): fail-closed
    // attribution must be recoverable by the next observation, otherwise a legacy
    // row would stay unusable forever. A row that already records a dimension is
    // left alone - re-attribution is the eviction path's decision, not the merge's.
    refresh: (existing, resource) => {
      if (typeof resource.lastSeenAt === 'number' && Number.isFinite(resource.lastSeenAt)) {
        existing.lastSeenAt = resource.lastSeenAt
      }
      const existingDimension = typeof existing.dimension === 'string' ? existing.dimension.trim() : ''
      const observedDimension = typeof resource.dimension === 'string' ? resource.dimension.trim() : ''
      if (existingDimension.length === 0 && observedDimension.length > 0) {
        existing.dimension = observedDimension
        log?.('KNOWN_RESOURCE_ATTRIBUTED', {
          item: existing.name,
          at: knownResourceAt(existing),
          recordedDimension: null,
          observedDimension,
        })
      }
    },
    log,
    now: Date.now(),
    evictedEvent: 'KNOWN_RESOURCE_EVICTED',
    fullEvent: 'KNOWN_RESOURCE_FULL',
    evictionDetail: (victim, now) => ({
      item: victim.name,
      name: victim.name,
      at: knownResourceAt(victim),
      reason: 'capacity',
      ageMs:
        typeof victim.lastSeenAt === 'number' && Number.isFinite(victim.lastSeenAt) ? now - victim.lastSeenAt : null,
    }),
  })
  if (emitInsertMarker) {
    for (const stored of result.inserted) {
      log?.('KNOWN_RESOURCE', {
        item: stored.name,
        kind: stored.kind,
        at: knownResourceAt(stored),
        // The recorded dimension, named explicitly (`null` = the row records
        // none, so it is un-attributable and refused in every world).
        dimension: stored.dimension ?? null,
        ...(options.worldEpoch === undefined ? {} : { worldEpoch: options.worldEpoch }),
      })
    }
  }
  return { added: result.added, evicted: result.evicted, dropped: result.dropped }
}

// ---------------------------------------------------------------------------
// durable traversal memory (issue #354)
// ---------------------------------------------------------------------------

/** The observed traversal family. `tunnel` is reserved for a dug tunnel leg. */
export type TraversalKind = 'step' | 'descend' | 'tunnel' | 'climb'
export type TraversalResult = 'ok' | 'blocked'
/** The typed cause of a refusal; `wall` is the generic terrain/geometry refusal. */
export type TraversalBlockReason = 'lava' | 'fall' | 'wall' | 'void'

/**
 * Issue #354: a durable, world-keyed TRAVERSAL FACT observed from a real
 * locomotion outcome - which leg actually opened a route, which leg was refused.
 *
 * It is world truth recorded from an observed outcome (a move/dig that completed
 * or was refused), never a semantic preference and never a route decision:
 *  - `from`/`to` are the rounded cells of the observed leg;
 *  - `kind` is geometric (`step`/`descend`/`climb`; `tunnel` for a dug tunnel);
 *  - `result` is `ok` when the body completed the leg, `blocked` when it was
 *    refused, with the typed `reason` when known;
 *  - `worldEpoch` namespaces the fact exactly like `KnownResourceJson`.
 *
 * The newest observation of a `(kind, from, to)` leg SUPERSEDES the previous
 * one, so a route that was blocked and later opened stops being suppressed. The
 * store is bounded (`KNOWN_TRAVERSAL_CAP`, oldest-proof LRU eviction) and is
 * dropped with its world key on a `worldEpoch` change, exactly like
 * `knownResources`.
 */
export interface KnownTraversalJson {
  from: Vec3Json
  to: Vec3Json
  kind: TraversalKind
  result: TraversalResult
  reason?: TraversalBlockReason
  worldEpoch?: number
  /** epoch ms the outcome was observed */
  lastSeenAt?: number
}

/** Bounded size of the durable traversal store (same LRU rule as KNOWN_RESOURCE_CAP). */
export const KNOWN_TRAVERSAL_CAP = 128

function traversalCell(cell: Vec3Json): string {
  return `${Math.round(cell.x)},${Math.round(cell.y)},${Math.round(cell.z)}`
}

/** Leg identity: the latest observed outcome for a (kind, from, to) supersedes. */
function knownTraversalKey(traversal: KnownTraversalJson): string {
  return `${traversal.kind}@${traversalCell(traversal.from)}->${traversalCell(traversal.to)}`
}

export interface MergeKnownTraversalsOptions {
  log?: (event: string, detail?: Record<string, unknown>) => void
  /** store bound; defaults to `KNOWN_TRAVERSAL_CAP` */
  cap?: number
}

export interface MergeKnownTraversalsResult {
  added: number
  evicted: KnownTraversalJson[]
  /** observations refused because the store was full and nothing was evictable */
  dropped: number
}

/**
 * Insert observed traversal facts into the bounded durable store. Thin wrapper
 * over the ONE `mergeBoundedLruInto` primitive (same eviction order, same
 * refusal semantics as the known-resource store).
 *
 * Capacity: `TRAVERSAL_EVICTED from=<cell> to=<cell> kind=<...> result=<...> reason=capacity ageMs=<n>`;
 * a full store with nothing evictable refuses with `TRAVERSAL_FULL cap=<n> dropped=<n>`.
 */
export function mergeKnownTraversalsInto(
  target: KnownTraversalJson[],
  found: readonly KnownTraversalJson[],
  options: MergeKnownTraversalsOptions = {},
): MergeKnownTraversalsResult {
  const result = mergeBoundedLruInto(target, found, {
    cap: options.cap ?? KNOWN_TRAVERSAL_CAP,
    keyOf: knownTraversalKey,
    seenAtOf: (traversal) => traversal.lastSeenAt,
    normalize: (traversal) => ({
      from: { x: Math.round(traversal.from.x), y: Math.round(traversal.from.y), z: Math.round(traversal.from.z) },
      to: { x: Math.round(traversal.to.x), y: Math.round(traversal.to.y), z: Math.round(traversal.to.z) },
      kind: traversal.kind,
      result: traversal.result,
      ...(traversal.reason === undefined ? {} : { reason: traversal.reason }),
      ...(traversal.worldEpoch === undefined ? {} : { worldEpoch: traversal.worldEpoch }),
      ...(traversal.lastSeenAt === undefined ? {} : { lastSeenAt: traversal.lastSeenAt }),
    }),
    // The newest observed outcome for a leg is the truth: a leg that was blocked
    // and later opened must stop being suppressed.
    refresh: (existing, observed) => {
      existing.result = observed.result
      if (observed.reason === undefined) delete existing.reason
      else existing.reason = observed.reason
      if (observed.worldEpoch !== undefined) existing.worldEpoch = observed.worldEpoch
      if (typeof observed.lastSeenAt === 'number' && Number.isFinite(observed.lastSeenAt)) {
        existing.lastSeenAt = observed.lastSeenAt
      }
    },
    log: options.log,
    now: Date.now(),
    evictedEvent: 'TRAVERSAL_EVICTED',
    fullEvent: 'TRAVERSAL_FULL',
    evictionDetail: (victim, now) => ({
      from: traversalCell(victim.from),
      to: traversalCell(victim.to),
      kind: victim.kind,
      result: victim.result,
      reason: 'capacity',
      ageMs:
        typeof victim.lastSeenAt === 'number' && Number.isFinite(victim.lastSeenAt) ? now - victim.lastSeenAt : null,
    }),
  })
  return { added: result.added, evicted: result.evicted, dropped: result.dropped }
}

/**
 * Issue #80: a durable, world-keyed record that a VERIFIED lit nether portal
 * frame exists at these overworld coordinates. It is deliberately NOT a stored
 * verdict: `portalVerified` is still re-read from live block truth. This record
 * only says "a verified portal exists at P" (CAN fact), so the resident can route
 * back, re-verify and enter instead of rebuilding a second frame after a
 * death/respawn/reload took the structure out of the body-relative sensor window.
 *
 * Lifecycle: minted from a live sighting; dropped on a world-epoch/dimension
 * change; and revoked ONLY by positive world truth - the record's own `frame`
 * cells read back as broken, or its own cells read back as no longer a lit
 * portal. A failed sensor search is never proof of absence (the same #377 rule
 * structure sites use): measured live, the previous "nothing sensed while the bot
 * is within `PORTAL_SITE_PROOF_DISTANCE`" rule destroyed this record while the
 * body sat 6 blocks from a standing, lit gate that lay outside the sensor's
 * dy -4..+4 window.
 */
export interface KnownPortalSiteJson {
  /** frame origin cell (the layout's lowest corner) */
  x: number
  y: number
  z: number
  /** the axis the 4-wide side spans */
  widthAxis: 'x' | 'z'
  /** dimension the site was verified in; a coordinate is only valid there */
  dimension?: string
  /** world epoch the site was verified in; a reset invalidates the coordinate */
  worldEpoch?: number
  /** epoch ms the lit portal was last observed at this site */
  lastVerifiedAt?: number
  /**
   * The frame edge cells the detector observed when it verified the portal. It
   * is stored so the sensor can re-project the site as a grounded
   * `PortalFrameSite` (route/geometry), never as a lit verdict: `portalVerified`
   * is still re-read from live block truth.
   */
  frame?: Vec3Json[]
  /** The interior cells the detector computed (live `nether_portal` at record time). */
  interior?: Vec3Json[]
}

/**
 * M3: a durable, world-keyed record that a Nether structure body was SENSED at
 * these coordinates. Like `KnownPortalSiteJson` it is a CAN fact ("Nether
 * fortress fabric exists at P"), never a verdict and never a route decision: the
 * consumer re-grounds on live block truth before acting.
 *
 * Admission is NETHER-ONLY (`syncKnownStructureSites`). `nether_bricks` is a
 * real block anywhere, including a player-placed overworld decoration, so an
 * overworld sighting must never mint a fortress record. The entry survives
 * generation/reload through the staged commit path and is dropped on a
 * world-epoch or dimension change, exactly like a portal site.
 */
export interface KnownStructureSiteJson {
  /** the sensed structure body cell (rounded): the durable route anchor */
  x: number
  y: number
  z: number
  /** structure class; only the Nether fortress body is produced today */
  kind: 'nether_fortress'
  /**
   * Distinct structure body block names sensed over the site (corroboration:
   * `nether_bricks` plus the fence/stair variants when present). Evidence only.
   */
  blocks?: string[]
  /** dimension the site was sensed in; a coordinate is only valid there */
  dimension?: string
  /** world epoch the site was sensed in; a reset invalidates the coordinate */
  worldEpoch?: number
  /** epoch ms the structure body was last observed at this cell */
  lastSeenAt?: number
}

/** The two station kinds the resident remembers coordinates for. */
export type StationKind = 'crafting_table' | 'furnace'

/**
 * Issue #31: a station coordinate is a mutable RECORD, not an immortal point.
 *
 * `status` is the health/reachability state:
 *   known       - remembered but not yet re-verified this/last generation
 *   verified    - the block was observed present (and not proven unreachable)
 *   missing     - validation failed: the block is gone / a different block
 *   unreachable - validation failed: the pathfinder could not reach it
 *   invalidated - terminal: N failures or stale age; never selected again
 *
 * The metadata fields are optional so legacy/durable JSON and pure test
 * fixtures keep parsing; `normalizeStation()` in `station-memory.ts` fills the
 * defaults on every read and the runtime writer always populates them.
 */
export interface KnownStation extends Vec3Json {
  kind?: StationKind
  /** epoch ms the coordinate was first recorded */
  firstSeenAt?: number
  /** epoch ms the block was last observed present */
  lastVerifiedAt?: number
  /** health/reachability state (issue #31) */
  status?: StationStatus
  /** consecutive failed validations; at STATION_MAX_FAILURES the record is invalidated */
  failures?: number
}

export type StationStatus = 'known' | 'verified' | 'missing' | 'unreachable' | 'invalidated'

/**
 * Durable "where things are" memory that must survive reloads/respawns/host
 * restarts. Inventory and position are NOT mirrored here - they are SERVER TRUTH,
 * live on the bot, and are re-observed from sensors after every reload/reconnect,
 * never restored from JSON. All coordinates are DTOs.
 *
 * WRITE PATHS (audited in `test-longterm-memory.mts`, task/longterm-memory):
 *   craftingTables     generation-entry scan validation + STATION runtime events
 *   furnaces           generation-entry scan validation + STATION runtime events
 *   discoveredOres     generation-entry ore scan (names only, per world key)
 *   knownResources     generation-entry ore/log/obsidian scan + #14 stale eviction
 *   knownPortalSites   generation-entry `syncPortalSiteMemory` (#80, CAN-only)
 *   knownStructureSites generation-entry `syncStructureSiteMemory` (M3, CAN-only,
 *                      Nether-only fortress body)
 *   knownTraversals    generation-entry `recordTraversalOutcome` from the
 *                      controller/executor locomotion outcome stream (#354)
 *   moveFailures       controller `onMoveFailureMemoryChange`
 *   repeatedOutcomes   controller `onRepeatedOutcomeChange` (the cross-action
 *                      bound: N identical typed outcomes with an unchanged
 *                      grounding fact signature retire the action at that cell)
 *   localOscillation   controller `onLocalOscillationChange` (host-side class-A
 *                      record; only written once a return is observed, so
 *                      ordinary locomotion proposes no delta at all)
 *   hazards            HOST `registerDeathHazard` on a production death (#26)
 *   mined              NO runtime producer: merge/persist machinery exists, but no
 *                      caller emits a `mined` delta (depletion model never wired)
 *   traversalFailures  NO runtime producer: same as `mined` (the thin P4 wall
 *                      memory was never wired to the current controller)
 * `mined`/`traversalFailures` round-trip correctly but stay empty in live state.
 *
 * Every field is namespaced by `serverId|dimension|worldEpoch` and every write is
 * merged through the single `mergeWorldMemoryDelta`, so the staged commit point
 * and the live runtime delta path cannot diverge.
 */
export interface ResidentWorldMemory {
  /** placed crafting_table stations discovered by scanning the loaded world (#31: validated records) */
  craftingTables: KnownStation[]
  /** placed furnace stations discovered by scanning the loaded world (#31: validated records) */
  furnaces: KnownStation[]
  /** "x,y,z:block" -> times mined (depletion model, best-effort). No runtime
   * producer yet - see the interface doc; always empty in live state. */
  mined: Record<string, number>
  /** ore block names seen at least once in the world state */
  discoveredOres: string[]
  /** remembered coordinates of known resources (issue #43): ores and trees, so a
   * retrieval skill can navigate back when the resource is out of scan range */
  knownResources: KnownResourceJson[]
  /**
   * Issue #80: durable, world-keyed verified nether-portal sites. A CAN fact
   * ("a verified portal exists at P"), never a verdict: it supplies a re-approach
   * route only and is re-verified from live world truth on arrival. Survives
   * generation reload/respawn; dropped on a failed live re-check at the site and
   * on a world-epoch change.
   */
  knownPortalSites: KnownPortalSiteJson[]
  /**
   * M3: durable, world-keyed Nether-structure sites (fortress body cells). A CAN
   * fact ("fortress fabric exists at P"), admitted only while the world key is
   * the Nether and re-grounded from live block truth by the consumer. Survives
   * generation reload/respawn; dropped on a failed live re-check at the site and
   * on a world-epoch/dimension change.
   */
  knownStructureSites: KnownStructureSiteJson[]
  /**
   * Issue #354: durable, world-keyed traversal facts observed from real
   * locomotion outcomes ("this leg opened a route" / "this leg was refused").
   * It supplies the connectivity half that coordinates alone cannot: a
   * remembered `blocked` leg suppresses a waypoint the candidate layer would
   * otherwise re-offer, and a remembered `ok` leg corroborates a reachable
   * waypoint. It is never a live check: the executor re-validates the cell, and
   * the whole store is dropped with its world key on a `worldEpoch` change.
   */
  knownTraversals: KnownTraversalJson[]
  /** thin 2-block-wall / stuck memory; suppress repeat attempts. No runtime
   * producer yet - see the interface doc; always empty in live state. */
  traversalFailures: TraversalFailure[]
  /** coordinate-level movement failure memory; survives generation recovery (#12) */
  moveFailures: MoveFailEntry[]
  /**
   * The durable cross-action bound: one entry per (action shape, target cell)
   * whose typed outcome has repeated identically while the target's grounding
   * facts stayed unchanged. It lives here because the in-generation counters it
   * replaces were erased by `progress=body` and by every hot reload - the
   * measured `ASCEND:habitat:p3_68_22` runaway survived 161 attempts at one cell
   * because no counter outlived the generation or the interleaved body motion.
   */
  repeatedOutcomes: RepeatedOutcomeEntryJson[]
  /**
   * #oscillation-boundary: the durable record of the BODY re-engaging the same
   * small set of cells with zero semantic progress. Optional so legacy/partial
   * JSON keeps parsing (it defaults to `null`), and deliberately world-keyed like
   * `moveFailures`: a bound loop in this world/dimension is a fact about this
   * world, and a world reset must not carry it over. It exists so a generation
   * change cannot reset the count the way every controller-scoped stall counter
   * does; the verdict itself stays in `jev-agent/src/localOscillation.ts`.
   */
  localOscillation?: LocalOscillationRecordJson | null
  /** death coordinates; a coordinate that kills twice is excluded (hard hazard) */
  hazards: DeathHazard[]
  /**
   * Live server-truth projection; deliberately absent from WorldMemoryDelta and
   * re-observed after every generation/world change.
   */
  portalVerified?: boolean
  /**
   * Live server-truth projection of the bot's current dimension, with the same
   * contract as `portalVerified` above: deliberately absent from
   * WorldMemoryDelta and re-observed after every generation/world change. It is
   * server truth, never durable memory. The `enter_nether` rung reads it so the
   * ladder never plans Nether-only goals while the bot is still in the overworld.
   */
  dimension?: string
}

export function emptyWorldMemory(): ResidentWorldMemory {
  return {
    craftingTables: [],
    furnaces: [],
    mined: {},
    discoveredOres: [],
    knownResources: [],
    knownPortalSites: [],
    knownStructureSites: [],
    knownTraversals: [],
    traversalFailures: [],
    moveFailures: [],
    repeatedOutcomes: [],
    localOscillation: null,
    hazards: [],
  }
}

/** Fill in any missing collection on a (possibly older) memory object. This is
 * the ONE normalisation point: call it before any read so a partially-written
 * mirror can never surface `undefined` to a `craftingTables`/`furnaces` read. */
export function normalizeWorldMemory(memory: ResidentWorldMemory): ResidentWorldMemory {
  memory.craftingTables = Array.isArray(memory.craftingTables) ? memory.craftingTables : []
  memory.furnaces = Array.isArray(memory.furnaces) ? memory.furnaces : []
  memory.mined = memory.mined ?? {}
  memory.discoveredOres = Array.isArray(memory.discoveredOres) ? memory.discoveredOres : []
  memory.knownResources = Array.isArray(memory.knownResources) ? memory.knownResources : []
  memory.knownPortalSites = Array.isArray(memory.knownPortalSites) ? memory.knownPortalSites : []
  memory.knownStructureSites = Array.isArray(memory.knownStructureSites) ? memory.knownStructureSites : []
  memory.knownTraversals = Array.isArray(memory.knownTraversals) ? memory.knownTraversals : []
  memory.traversalFailures = Array.isArray(memory.traversalFailures) ? memory.traversalFailures : []
  memory.moveFailures = Array.isArray(memory.moveFailures) ? memory.moveFailures : []
  memory.repeatedOutcomes = Array.isArray(memory.repeatedOutcomes) ? memory.repeatedOutcomes : []
  memory.localOscillation = memory.localOscillation ?? null
  memory.hazards = Array.isArray(memory.hazards) ? memory.hazards : []
  return memory
}

/**
 * Issue #48: a class-A mutation proposal is never bare data. It carries the
 * revision it was based on AND the generation that produced it, so the host can
 * reject a stale/superseded proposal and no caller can silently bypass the guard.
 */
export interface LedgerProposalEnvelope {
  ledger: GoalQueueSnapshot
  /** class-A snapshot revision the generating generation was constructed from */
  baseRevision: number
  /** generation id that produced the proposal */
  generationId: string
}

/**
 * Issue #5: the generation may not archive/rename the host-owned ledger. It
 * reports the inconsistency and the HOST archives it at the commit point.
 */
export interface LedgerReconciliationProposal {
  generationId: string
  reason: string
}

/** What the generation proposes; the HOST is the only writer that commits it. */
export interface WorldMemoryDelta {
  craftingTables?: KnownStation[]
  furnaces?: KnownStation[]
  /** station records proven gone/invalidated; the host drops them from the durable
   * store so a stale coordinate is never served to a later generation (#31) */
  removeStations?: KnownStation[]
  discoveredOres?: string[]
  knownResources?: KnownResourceJson[]
  /** cells proven gone (mined/replaced); the host drops them from the durable store (#14) */
  removeKnownResources?: KnownResourceJson[]
  /** verified portal sites to remember; the host merges them by origin (#80) */
  knownPortalSites?: KnownPortalSiteJson[]
  /** portal sites whose live re-check failed / epoch changed; the host drops them (#80) */
  removeKnownPortalSites?: KnownPortalSiteJson[]
  /** Nether-structure sites to remember; the host merges them by cell (M3) */
  knownStructureSites?: KnownStructureSiteJson[]
  /** structure sites whose live re-check failed / epoch changed; the host drops them (M3) */
  removeKnownStructureSites?: KnownStructureSiteJson[]
  /** observed traversal facts to remember; the host merges them by leg (#354) */
  knownTraversals?: KnownTraversalJson[]
  mined?: Record<string, number>
  traversalFailures?: TraversalFailure[]
  moveFailures?: MoveFailEntry[]
  /** the durable cross-action repeat ledger; replaced wholesale (it is bounded state, not a log) */
  repeatedOutcomes?: RepeatedOutcomeEntryJson[]
  /** #oscillation-boundary: the durable local-motion record; `null` clears it (progress / left pocket) */
  localOscillation?: LocalOscillationRecordJson | null
  hazards?: DeathHazard[]
}

/**
 * Issue #40: every durable artifact is exactly ONE of four state classes. This
 * distinction is the contract that keeps reload/rollback semantics exact.
 *
 *   A. Authoritative mission state - HOST transactional (single writer, atomic
 *      write, typed). Enough to resume correctly after a process restart with no
 *      planner/model cache: mission/ledger, worldEpoch, world memory (known
 *      resources, hazards, traversal/failure memory), milestone + generation
 *      bookkeeping, schema/revision metadata.
 *   B. Server truth - NEVER persisted as authority; always re-observed from the
 *      live Mineflayer bot after reload/reconnect (position/health/food/inventory/
 *      entities/open windows). See `ServerTruth`.
 *   C. Disposable optimization state - planner/advisor/Mercury caches, compiled
 *      generation bundles, replay indexes. Losing them may cost latency only and
 *      MUST NOT change correctness.
 *   D. Append-only evidence - JSONL calls/actions/outcomes/acceptance/freeze
 *      reports. Evidence only; never read back as state.
 */
export type StateClass = 'A' | 'B' | 'C' | 'D'

/**
 * THE authoritative mission snapshot (class A). Exactly one of these is persisted
 * to `buddy-state.json`; the HOST is its only writer. Generations PROPOSE
 * mutations (world-memory deltas, ledger) and the host commits them atomically
 * (tmp -> rename) with schema/revision validation. No field typed `unknown` is
 * authoritative restore state.
 */
export interface AgentSnapshot {
  /** schema version of this JSON file (independent of CONTRACT_VERSION) */
  schemaVersion: number
  /** monotonically increasing commit revision; bumped on every committed write */
  revision: number
  /** incremented when the world instance changes (world reset / explicit reset) */
  worldEpoch: number
  /** generation id the host last committed as action owner */
  generationId: string | null
  bot: string
  /** server identity this state was written for, e.g. "127.0.0.1:25565" */
  serverId: string
  /** dimension of the last observed world, e.g. "minecraft:overworld" */
  dimension: string
  /** last observed level name, when the server exposes one */
  levelName: string | null
  firstSeenAt: number
  updatedAt: number
  /** highest ladder rung index the bot has satisfied */
  milestoneIndex: number
  /** id of that rung (e.g. "iron_pickaxe") */
  milestone: string | null
  /** last committed goal-queue state - the durable mission ledger (class A). A
   * generation proposes it via `GenerationContext.proposeLedger`; the host commits.
   * `buddy-ledger.json` is a DERIVED compatibility mirror of this, never authority. */
  ledger: GoalQueueSnapshot | null
  /** durable semantic memory, namespaced by server|dimension|worldEpoch */
  worldMemoryByKey: Record<string, ResidentWorldMemory>
  /** how many generations have been attached in this process lifetime */
  generations: number
  /** how many hot reloads were performed */
  reloads: number
  /** how many times the host recovered after the controller stopped */
  recoveries: number
  /** the owner active immediately before `generationId` (previous owner) */
  lastGenerationId: string | null
  /** monotonic action counter for ACTION log lines */
  actions: number
}

/** Back-compat alias: the single class-A snapshot persisted to buddy-state.json. */
export type ResidentState = AgentSnapshot

/** SERVER TRUTH: re-observed from the live bot after every reload/reconnect. Never persisted. */
export interface ServerTruth {
  position: Vec3Json | null
  health: number | null
  food: number | null
  dimension: string | null
  onGround: boolean | null
  inventory: Record<string, number>
}

/**
 * The actuation lease. The HOST owns `activeGenerationId`; a generation may only
 * perform side-effecting bot calls while it is the active owner. The swap commit
 * point is the lease switch: before it the new generation cannot act, after it
 * the old generation cannot act. `id` is the generation's own id.
 */
export interface ActuationLease {
  /** the id the host currently considers the action owner ('' when none) */
  readonly activeId: string
  isActive(id: string): boolean
  assertActive(id: string, what: string): void
}

/** A read-only projection of the running generation, used by host logging/control. */
export interface GenerationStatus {
  running: boolean
  /** exact source revision this immutable generation bundle was built from */
  sourceSha?: string | null
  buildHash?: string | null
  policyKind: string
  policyProvider: string
  policyModel: string
  system2Provider: string
  system2Model: string
  /** Configured System2 authority stack; separate from the last answering authority. */
  system2AuthorityStack?: { provider: string; model: string }
  /** Last provider/model that actually answered a System2 request. */
  system2LastAuthority?: { provider: string; model: string }
  deterministicFallbackEnabled: boolean
  queue: GoalQueueState
  currentAction: { id: string; kind: string; phase: string; startedAt: number } | null
  /** SERVER TRUTH, DTO only */
  truth: ServerTruth
  /**
   * RUN-SCOPED milestone predicate observations evaluated from the live
   * inventory + durable world memory, reusing the ladder's own `satisfied`
   * predicates. The HOST persists these in the observe loop so the run-scoped
   * artifact carries first-class predicate evidence instead of a post-hoc
   * derivation. Optional for contract compatibility with older generations.
   */
  milestonePredicates?: MilestonePredicateObservation[]
  /** deterministic seed size, or the live System2 queue depth in model mode */
  plannedGoals: number
  /** observer-only index of the first unsatisfied legacy ladder rung */
  rungIndex: number
  /** observer-only id of that legacy ladder rung */
  rungId: string
  /**
   * Deterministic mode's compatibility goal projected from the live frontier;
   * model mode reports its configured objective. The rung fields remain
   * observer evidence and do not define production System2 intent.
   */
  goalItem?: string
  goalCount?: number
  /** live basis attached to host heartbeat ledger commits */
  ledgerBasis?: LedgerBasis
  /** true once start() has run and no irreversible action can happen before the lease */
  ready: boolean
  contractVersion: number
  worldKey: WorldKey
}

/**
 * Issue #13/#49: a generation-owned resource ledger. The HOST creates exactly one
 * `GenerationResources` per generation and the generation registers every bot
 * listener / timer it owns. On teardown the host calls `dispose()`, which removes
 * exactly those resources, and then asserts the host listener counts returned to
 * baseline. This makes "old generation fully disposed" mechanically checkable
 * instead of assumed from `controller.stop()`.
 */
export interface GenerationResourceCounts {
  /** tracked listeners still registered after the last dispose (must be 0) */
  listeners: number
  /** tracked timers still active after the last dispose (must be 0) */
  timers: number
}

/** Minimal emitter surface a tracked target must expose (bot, bot.inventory, ...). */
export interface GenerationResourceTarget {
  on?(event: string, fn: (...args: unknown[]) => void): unknown
  removeListener?(event: string, fn: (...args: unknown[]) => void): unknown
}

export interface GenerationResources {
  trackListener(target: GenerationResourceTarget, event: string, fn: (...args: unknown[]) => void): void
  untrackListener(target: GenerationResourceTarget, event: string, fn: (...args: unknown[]) => void): void
  untrackAll(target: GenerationResourceTarget, event?: string): void
  trackTimer(handle: unknown): void
  untrackTimer(handle: unknown): void
  counts(): GenerationResourceCounts
  /** remove every tracked resource; returns the counts that could NOT be removed */
  dispose(): GenerationResourceCounts
}

/** Structural smoke result: must PASS with an EMPTY plan and no completed goals. */
export interface StructuralSmokeResult {
  ok: boolean
  checks: string[]
  failures: string[]
}

/** MISSION preflight: separate from reload; hot reload never depends on a goal existing. */
export interface MissionPreflightResult {
  ok: boolean
  reason: string | null
  goalCount: number
}

/**
 * P0 durability evidence (#378/#379/#381/#384/#388). One recorded durability
 * outcome: the exact marker that was also written to `buddy.log`, plus its detail.
 */
export interface HostDurabilityEventJson {
  marker: string
  at: string
  detail: Record<string, unknown>
}

/**
 * Run-scoped mirror of the HOST durability markers. Every field is a count of a
 * marker that appears in the run log; `markers` exists so the acceptance record
 * shows the exact marker names observed in THIS run instead of a bare total.
 *
 *   writeFailures    STATE_WRITE_FAILED       a durable write did not land
 *   stateQuarantines STATE_QUARANTINED        unreadable/newer state moved aside
 *   lockReclaims     HOST_LOCK_RECLAIMED      a provably stale lock was taken over
 *   lockLosses       HOST_LOCK_LOST           a live holder/foreign pid was found
 *   fatalShutdowns   FATAL_SHUTDOWN           fatal handler revoked lease + exited
 */
export interface HostDurabilityRecord {
  writeFailures: number
  stateQuarantines: number
  lockReclaims: number
  lockLosses: number
  fatalShutdowns: number
  /** distinct durability marker names observed during this run */
  markers: string[]
  lastEvent: HostDurabilityEventJson | null
  /** path of the most recent quarantined state file (null when none) */
  stateQuarantinePath: string | null
}

/** Machine-readable acceptance record emitted per run. */
export interface AcceptanceRecord {
  record: 'acceptance'
  runId: string
  ts: string
  /** the run's SOURCE identity: the boot commit (immutable), never the live checkout (#395) */
  gitCommit: string | null
  /** the mutable working checkout HEAD at write time, kept separate so it cannot be mistaken for the run source */
  checkoutHead?: string | null
  generationHash: string | null
  generationId: string | null
  modelAvailability?: ModelAvailabilitySnapshot
  contractVersion: number
  stateSchemaVersion: number
  stateRevision: number
  dependencies: Record<string, string>
  serverId: string
  dimension: string
  levelName: string | null
  worldEpoch: number
  seed: string | null
  /** HOST proof for the clean-run world identity fields above. */
  worldIdentityEvidence?: {
    levelName: Record<string, unknown> | null
    seed: Record<string, unknown> | null
  }
  botUsername: string
  startPosition: Vec3Json | null
  mode: string
  goalComplete: boolean
  wedge: boolean
  reconnects: number
  reloads: number
  reloadsChangedHash: number
  reloadsSkippedUnchanged: number
  reloadsFailed: number
  freezeCycles: number
  listenerBaseline: Record<string, number>
  listenerExpected: Record<string, number>
  listenerCurrent: Record<string, number>
  listenerLeak: boolean
  worldMemoryKeys: string[]
  /**
   * P0 durability mirror (#379/#388/#378/#381). The run's write-failure /
   * quarantine / lock-reclaim / lock-loss / fatal-shutdown markers. Optional so
   * an older host's acquisition record still parses (#63 evidence taxonomy).
   */
  durability?: HostDurabilityRecord
}

/**
 * One generation of the reloadable intelligence. `quiesce()` stops the scheduler
 * and persists the goal-queue ledger while leaving the Mineflayer connection
 * untouched. Ordinarily it cancels in-flight work; after model authority is
 * withdrawn, it lets only an already-committed bounded safety escape reach its
 * terminal boundary before HOST revokes the lease.
 */
export interface ResidentGeneration {
  readonly id: string
  readonly startedAt: number
  readonly rungIndex: number
  readonly rungId: string
  /** register listeners only (no timers, no side effects). Called before start(). */
  attach(): void
  /** begin scheduling. MUST assert the actuation lease for this id first. */
  start(): void
  /** stop timers/actions and persist; resolves after bounded in-flight settlement. */
  quiesce(): Promise<void>
  /** best-effort synchronous teardown. */
  dispose(): void
  status(): GenerationStatus
  /** structural validity of the module surface + frozen-data pure functions. */
  structuralSmoke(): StructuralSmokeResult
  /** mission-level preflight (goal exists, candidates generatable); never gates reload. */
  missionPreflight(): MissionPreflightResult
  /** controller stop reason, once it has stopped; null while running. */
  stopReason(): string | null
  /** true after the controller stopped for any reason */
  hasStopped(): boolean
  /** Read-only attribution of the requested chunk columns for the observer probe. */
  worldProbeProvenance?(columns: readonly { chunkX: number; chunkZ: number }[]): DimensionProvenanceDiagnostic
}

/**
 * Issue #48: the mandatory envelope for a generation ledger proposal. The HOST
 * validates `generationId` (still the committed/allowed generation) and
 * `baseRevision` (the committed snapshot revision the generation was seeded from)
 * before it writes. A proposal can never omit identity/revision and bypass the
 * stale check.
 */
export interface LedgerProposal {
  generationId: string
  baseRevision: number
  ledger: GoalQueueSnapshot
}

export interface GenerationContext {
  bot: Bot
  /** structured log line: host prefixes the ISO timestamp; detail is JSON. */
  log: (event: string, detail?: Record<string, unknown>) => void
  /** the actuation lease; the generation asserts it before side effects. */
  lease: ActuationLease
  /** host-owned resource ledger; the generation registers every listener/timer it owns. */
  resources?: GenerationResources
  /** read-only durable semantic memory for the current world key (a COPY). */
  worldMemory: ResidentWorldMemory
  /** the world key this generation runs under. */
  worldKey: WorldKey
  /** the class-A revision this generation was constructed from (#48 lineage). */
  snapshotRevision: number
  /** the generation stages memory deltas; the HOST commits them at the commit point. */
  proposeWorldMemory(delta: WorldMemoryDelta): void
  /**
   * Issue #40/#48: the generation PROPOSES its authoritative ledger (class A); the
    * HOST validates lineage/revision and commits it atomically. Never a bare write.
    */
   proposeLedger(proposal: LedgerProposalEnvelope): void
  /**
   * Issue #5: report that the derived ledger mirror is inconsistent; the HOST
   * archives it at the commit point. The generation must never rename it.
   */
  proposeLedgerReconciliation(proposal: LedgerReconciliationProposal): void
  /** class-A ledger the HOST committed; the generation restores from THIS, not cache/logs. */
  ledgerSnapshot: GoalQueueSnapshot | null
  /** goal-queue ledger path handed to the controller (derived compatibility mirror). */
  ledgerPath: string
  /** jsonl log dir handed to the controller. */
  logDir: string
  /** configured objective seed. */
  goalItem: string
  goalCount: number
  /** Host-pinned Jev identity required only while recovering from provider outage. */
  recoveryPolicyAuthority?: { provider: string; model: string } | null
  /** Host-pinned System2 identity required only while recovering from provider outage. */
  recoverySystem2Authority?: { provider: string; model: string } | null
  /** Source SHA pinned when System2 first became unavailable. */
  recoverySourceSha?: string | null
  /** why this generation was created fresh (e.g. "death"); drives LADDER_RESET. */
  resetReason: string | null
  /** host-captured facts for the immediately preceding real death. */
  deathRecovery?: DeathRecoveryContext | null
  /** resident runId (host-lifetime identity); scopes the run-scoped M2 snapshot. */
  runId?: string
  /** git commit the resident booted from (BOOT `source`). */
  bootSourceSha?: string | null
  /** Exact git commit the currently loaded generation module was built from. */
  sourceSha?: string | null
  /** generation bundle hash (BUILD `hash`) the running generation was loaded from. */
  buildHash?: string | null
  /** directory the resident writes run-scoped M2 evidence snapshots into. */
  m2SnapshotDir?: string
}

export interface GenerationModule {
  CONTRACT_VERSION: number
  createGeneration(ctx: GenerationContext): ResidentGeneration
}
