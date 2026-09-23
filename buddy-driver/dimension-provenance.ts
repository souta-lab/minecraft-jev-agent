// dimension-provenance.ts - "a block read must be attributable to the dimension
// it came from".
//
// WHY THIS EXISTS (measured, not hypothetical): the durable store held seven
// `jungle_log` rows stamped `minecraft:the_nether`. A jungle tree cannot exist in
// the Nether. The rows were minted 3.358 s after a portal transfer that the run
// log shows completing (`SPAWN ... dimension=minecraft:the_nether respawn=false`),
// and 52 sibling cells of the same batch were later read as `observed=air`
// (`KNOWN_RESOURCE_FALSIFIED ... reason=block_mined`), i.e. the block truth behind
// those writes was the OVERWORLD's, delivered while `bot.game.dimension` was
// already the Nether.
//
// Mineflayer keeps ONE column store per bot (`bot.world`, created once at
// `lib/plugins/blocks.js:543-546` and never replaced) and a column carries NO
// world identity: `prismarine-world@3.7.0/src/world.js:22` is keyed by
// `chunkX+','+chunkZ` only. Its cross-dimension invalidation is conditional
// (`lib/plugins/blocks.js:563-580` -> `switchWorld()` at `:523-547`) and emits
// nothing a consumer can read. So `bot.blockAt`/`bot.findBlocks` return a foreign
// dimension's data as if it were current, and the writer then faithfully stamped
// the LIVE dimension onto a cell whose DATA came from somewhere else.
//
// This module supplies the missing provenance instead of assuming it:
//
//   * every column the bot loads is tagged with the dimension that was live when
//     the load was OBSERVED (`chunkColumnLoad`, forwarded by mineflayer at
//     `lib/plugins/blocks.js:591`);
//   * a dimension change DROPS every tag and ACTIVELY unloads every column we know
//     about, so the sensor never depends on mineflayer's conditional clear having
//     run;
//   * a column with no tag is UNKNOWN, and unknown is NOT satisfied: the sensor
//     refuses the read (typed) instead of minting durable memory from it.
//
// It is world truth only (CAN/TRUE): it never ranks or selects an action.
//
// LISTENER LIFETIME. The column store belongs to the bot, and the host owns the
// bot for the whole connection (`buddy-driver/agent-runner.mts:1384` creates it
// once; `generation-entry.ts` hands the SAME object to every generation). The
// listeners are therefore installed once per bot object and are deliberately NOT
// generation-tracked resources: a tag must survive a generation swap, because the
// columns do. They die with the bot. The per-generation VIEW is what carries the
// generation's `log`, so no disposed generation is ever called back.

import type { Bot } from 'mineflayer'
import type { DimensionProvenance, RefusedRead } from '../jev-agent/src/state.ts'
import { canonicalDimensionId, normalizeDimensionId } from './dimension-observer.ts'

export type DimensionLog = (event: string, detail?: Record<string, unknown>) => void

/** Chunk coords owning a cell. */
function chunkOf (value: number): number {
  return Math.floor(value / 16)
}

function chunkKey (chunkX: number, chunkZ: number): string {
  return `${chunkX},${chunkZ}`
}

/** A `chunkColumnLoad`/`chunkColumnUnload` payload is the column's corner. */
interface ColumnCorner {
  x?: unknown
  y?: unknown
  z?: unknown
}

function cornerChunk (corner: ColumnCorner | null | undefined): { chunkX: number; chunkZ: number } | null {
  if (corner === null || corner === undefined) return null
  const x = corner.x
  const z = corner.z
  if (typeof x !== 'number' || typeof z !== 'number' || !Number.isFinite(x) || !Number.isFinite(z)) return null
  return { chunkX: chunkOf(x), chunkZ: chunkOf(z) }
}

/**
 * Bot-scoped, generation-independent state: the column -> dimension tags, the
 * live dimension, and the transitions that happened while no generation was
 * attached to log them.
 */
interface ProvenanceStore {
  liveDimension: string
  /** `chunkX,chunkZ` -> canonical dimension observed at that column's load. */
  columnDimension: Map<string, string>
  /** Transitions observed with no generation attached, drained by the next view. */
  pendingTransitions: Array<Record<string, unknown>>
  refusals: number
  unloads: number
  loadsTagged: number
  /** Columns discarded at first attach because their provenance could not be proven. */
  attachDropped: number
}

const REFUSAL_CAP_PER_KEY = 8
const PENDING_TRANSITION_CAP = 16

const stores = new WeakMap<object, ProvenanceStore>()

function storeFor (bot: Bot): ProvenanceStore {
  const key = bot as unknown as object
  const existing = stores.get(key)
  if (existing !== undefined) return existing
  const created: ProvenanceStore = {
    liveDimension: '',
    columnDimension: new Map<string, string>(),
    pendingTransitions: [],
    refusals: 0,
    unloads: 0,
    loadsTagged: 0,
    attachDropped: 0,
  }
  stores.set(key, created)
  return created
}

/** The bot's `chunkColumnLoad` tag; module-level so nothing of a generation is retained. */
const TAGGED = new WeakSet<object>()

/**
 * Unload every column this store knows about. We do this ourselves rather than
 * trusting mineflayer's `switchWorld()` to have run: the live defect is exactly a
 * column that was still readable after a transfer, and a store we can empty is a
 * store we can reason about.
 */
function unloadKnownColumns (bot: Bot, store: ProvenanceStore): number {
  const world = bot.world as unknown as { unloadColumn?: (chunkX: number, chunkZ: number) => void } | undefined
  if (world === undefined || world === null || typeof world.unloadColumn !== 'function') return 0
  let unloaded = 0
  for (const key of store.columnDimension.keys()) {
    const parts = key.split(',')
    const chunkX = Number(parts[0])
    const chunkZ = Number(parts[1])
    if (!Number.isFinite(chunkX) || !Number.isFinite(chunkZ)) continue
    try {
      world.unloadColumn(chunkX, chunkZ)
      unloaded += 1
    } catch {
      // A column the world refuses to drop is still dropped from our tags, so the
      // next read of it is UNKNOWN and the sensor refuses it (fail closed).
    }
  }
  store.unloads += unloaded
  return unloaded
}

/**
 * Install the column-provenance listeners on a bot once. Idempotent per bot
 * object, so every generation may call it and only the first one installs.
 *
 * The first install also DISCARDS every column that is already loaded. Those were
 * loaded before we could witness anything, so their provenance is genuinely
 * unknown - and unknown is not satisfied. The remedy for unknown is to obtain a
 * known provenance, not to assume one: the columns are dropped and the server
 * re-sends them under the dimension we are watching. The cost is bounded by one
 * chunk-delivery cycle, it happens once per bot object (a reconnect, where the
 * world is new anyway), and it means no unprovable column is ever readable.
 */
export function attachDimensionProvenance (bot: Bot): void {
  const key = bot as unknown as object
  if (TAGGED.has(key)) return
  TAGGED.add(key)
  const store = storeFor(bot)
  const onLoad = (corner: ColumnCorner): void => {
    const chunk = cornerChunk(corner)
    if (chunk === null) return
    // The dimension live at the moment the load was OBSERVED. `map_chunk` arrives
    // long after the `respawn` handler relabelled `bot.game.dimension`, so this is
    // the new dimension for a transfer; a same-tick load would be tagged with the
    // old one and simply read as `foreign` (fail closed).
    const dimension = canonicalDimensionId(bot.game?.dimension)
    if (dimension.length === 0) return
    store.columnDimension.set(chunkKey(chunk.chunkX, chunk.chunkZ), dimension)
    store.loadsTagged += 1
  }
  const onUnload = (corner: ColumnCorner): void => {
    const chunk = cornerChunk(corner)
    if (chunk === null) return
    store.columnDimension.delete(chunkKey(chunk.chunkX, chunk.chunkZ))
  }
  bot.on('chunkColumnLoad', onLoad)
  bot.on('chunkColumnUnload', onUnload)
  store.attachDropped = dropEveryLoadedColumn(bot, store, canonicalDimensionId(bot.game?.dimension))
}

/**
 * Drop every column the world currently holds. Used once at attach, where
 * "already loaded" and "unprovable" are the same set.
 */
function dropEveryLoadedColumn (bot: Bot, store: ProvenanceStore, liveDimension: string): number {
  const world = bot.world as unknown as { getColumns?: () => Array<{ chunkX?: unknown; chunkZ?: unknown }> } | undefined
  const keys: string[] = []
  if (world !== undefined && world !== null && typeof world.getColumns === 'function') {
    let columns: Array<{ chunkX?: unknown; chunkZ?: unknown }> = []
    try {
      columns = world.getColumns() ?? []
    } catch {
      columns = []
    }
    for (const column of columns) {
      const chunkX = Number(column.chunkX)
      const chunkZ = Number(column.chunkZ)
      if (!Number.isFinite(chunkX) || !Number.isFinite(chunkZ)) continue
      keys.push(chunkKey(chunkX, chunkZ))
    }
  }
  if (keys.length === 0) return 0
  // THE TAG MUST BE READABLE IF THE UNLOAD CANNOT HAPPEN.
  //
  // The original form tagged every loaded column with the EMPTY dimension - a tag no read
  // can accept - and then cleared the map, so the column was left neither unloaded nor
  // attributed. That is only sound when the world really drops the column and the server
  // re-sends it (a `chunkColumnLoad` then re-tags it). Measured live on a FRESH WORLD: the
  // installed client has no `unloadColumn`, so nothing was ever unloaded, nothing was ever
  // re-sent, and every read of the body's own neighbourhood failed closed -
  // `DIMENSION_READ_REFUSED cell=5,66,-8 provenance=unknown reason=unknown_column
  // source=level-scan`, 10,102 of them in one run. The consequence was not a cautious body
  // but a BLIND one: `isStandable` needs three cell reads, all refused, so no cell in the
  // melee envelope was a legal stance, an adjacent attacker's ATTACK was withheld
  // `no_attack_stand refusal=no_standable_cell`, the escape machinery reported
  // `SURVIVAL_ESCAPE_NONE`, and the body sat at full health next to a threat it could
  // neither hit nor leave.
  //
  // At ATTACH there is no transition to fail closed against - the columns were loaded by
  // this bot in this world - so when the unload cannot happen they stay attributed to the
  // LIVE dimension. A column that survives a TRANSITION is a different event and keeps the
  // original treatment in `syncStore`: dropped, unloaded where possible, and unreadable.
  for (const key of keys) store.columnDimension.set(key, liveDimension)
  const dropped = unloadKnownColumns(bot, store)
  if (dropped > 0) store.columnDimension.clear()
  return dropped
}

/**
 * Move the store to a newly observed live dimension. On a change every tag is
 * dropped and every known column is unloaded, so nothing loaded under the previous
 * dimension can be read afterwards.
 */
function syncStore (
  bot: Bot,
  store: ProvenanceStore,
  dimension: string | null | undefined,
  reason: string,
): { changed: boolean; from: string; to: string; columnsDropped: number; columnsUnloaded: number } {
  const next = canonicalDimensionId(dimension)
  if (next === store.liveDimension) {
    return { changed: false, from: store.liveDimension, to: next, columnsDropped: 0, columnsUnloaded: 0 }
  }
  // NAMING THE LIVE DIMENSION FOR THE FIRST TIME IS NOT A TRANSITION. The store starts
  // with an empty live dimension, and until it is named the columns attached under it were
  // tagged with the dimension the bot was ALREADY in (`attachDimensionProvenance` tags the
  // loaded columns with `canonicalDimensionId(bot.game.dimension)` when it cannot unload
  // them). Treating that first naming as a change ran the reset path over tags that were
  // already correct - dropping and (where possible) unloading columns that had not gone
  // anywhere, which on a client without `unloadColumn` left every one of them unattributed
  // and every read refused. That is the blindness this branch is here to prevent, so the
  // naming is recorded and nothing else changes.
  if (store.liveDimension.length === 0) {
    store.liveDimension = next
    return { changed: false, from: '', to: next, columnsDropped: 0, columnsUnloaded: 0 }
  }
  const from = store.liveDimension
  store.liveDimension = next
  const columnsDropped = store.columnDimension.size
  // UNLOAD FIRST, THEN CLEAR. The unload walks `store.columnDimension` to know which
  // columns to drop, so clearing the tag map first left it an empty list: every reset
  // reported `columnsUnloaded=0` while `columnsDropped` counted the tags it had just
  // discarded (measured live: 108 resets, columnsUnloaded 0 on all of them, dropped up
  // to 190). The consequence is the freeze this fix is for - a column whose tag was
  // discarded but which the world still holds is read as `provenance=unknown`, the
  // sensor refuses it (`DIMENSION_READ_REFUSED ... reason=unknown_column source=world-state`),
  // and the cell it could not read then yields no tool fact, no acquisition route and no
  // candidate at all: the body froze in a hole holding 81 logs it could not turn into a
  // pickaxe because the CELL ABOVE IT WAS NEVER READ. The module's own documented remedy
  // ("drop the column so the server re-sends it") only works in this order.
  const columnsUnloaded = unloadKnownColumns(bot, store)
  store.columnDimension.clear()
  const record = { from, to: next, reason, columnsDropped, columnsUnloaded }
  // A transition with no live generation is kept as plain data for the next view
  // to mirror, so the evidence is never silently lost across a generation swap.
  store.pendingTransitions.push(record)
  if (store.pendingTransitions.length > PENDING_TRANSITION_CAP) store.pendingTransitions.shift()
  return { changed: true, ...record }
}

/**
 * The DURABLE-WRITE verdict for one cell: `null` means "write it", anything else is
 * the typed refusal to record. The writer is the last layer that can put a cell
 * into durable memory, so it asks this itself instead of trusting the scan that
 * produced the cell.
 *
 * Note what this can and cannot do. It refuses a cell whose COLUMN provenance
 * disagrees with the live dimension. It cannot make the stamp wrong-but-honest:
 * the measured defect stamped the then-correct live Nether dimension onto data
 * that came from the Overworld, which is precisely why a `dimension === live` check
 * (the existing `evictStaleKnownResources` re-anchoring) could never catch it.
 */
export function writeRefusal (
  provenance: DimensionProvenance | null | undefined,
  at: { x: number; y: number; z: number },
  source: string,
): RefusedRead | null {
  if (provenance === null || provenance === undefined) return null
  const verdict = provenance.cellAttribution(at.x, at.z)
  if (verdict.kind === 'attributable') return null
  return {
    cell: { x: at.x, y: at.y, z: at.z },
    chunk: verdict.chunk,
    provenance: verdict.dimension,
    liveDimension: verdict.liveDimension,
    reason: verdict.reason ?? 'unknown_column',
    source,
  }
}

/** The generation-scoped view handed to the sensor. */
export interface DimensionProvenanceStats {
  liveDimension: string
  taggedColumns: number
  loadsTagged: number
  attachDropped: number
  refusals: number
  unloads: number
}

export interface DimensionProvenanceView extends DimensionProvenance {
  /** Refresh the live dimension from the bot and apply a transition if one happened. */
  syncLiveDimension (reason: string): void
  /** Observation counters, for the generation's own evidence line. */
  stats (): DimensionProvenanceStats
}

/**
 * Create the provenance view for one generation. `log` is the generation's own
 * log, so the typed lines land in the run that observed them; the tags themselves
 * are shared per bot and survive generation swaps.
 */
export function createDimensionProvenanceView (
  bot: Bot,
  log: DimensionLog,
  runId: string | null | undefined,
  reason: string,
): DimensionProvenanceView {
  attachDimensionProvenance(bot)
  const store = storeFor(bot)
  const emitted = new Map<string, number>()

  const syncLiveDimension = (syncReason: string): void => {
    const result = syncStore(bot, store, bot.game?.dimension, syncReason)
    if (result.changed) {
      log('DIMENSION_PROVENANCE_RESET', {
        from: result.from.length === 0 ? 'unknown' : result.from,
        to: result.to.length === 0 ? 'unknown' : result.to,
        dimensions: result.to.length === 0 ? 'unknown' : result.to,
        reason: syncReason,
        columnsDropped: result.columnsDropped,
        columnsUnloaded: result.columnsUnloaded,
        runId: runId ?? null,
      })
    }
    // Mirror anything that happened between generations, then clear it.
    while (store.pendingTransitions.length > 0) {
      const pending = store.pendingTransitions.shift()
      if (pending === undefined) break
      if (pending.from === result.from && pending.to === result.to && pending.reason === syncReason) continue
      log('DIMENSION_PROVENANCE_RESET', { ...pending, mirrored: true, runId: runId ?? null })
    }
  }
  syncLiveDimension(reason)

  return {
    syncLiveDimension,
    get liveDimension (): string {
      return store.liveDimension
    },
    cellAttribution (x: number, z: number) {
      const chunkX = chunkOf(x)
      const chunkZ = chunkOf(z)
      const chunk = { x: chunkX, y: 0, z: chunkZ }
      const live = store.liveDimension
      const tagged = store.columnDimension.get(chunkKey(chunkX, chunkZ))
      if (live.length === 0) {
        return { kind: 'unknown' as const, dimension: tagged ?? '', liveDimension: '', chunk, reason: 'unknown_live_dimension' as const }
      }
      if (tagged === undefined) {
        return { kind: 'unknown' as const, dimension: '', liveDimension: live, chunk, reason: 'unknown_column' as const }
      }
      if (normalizeDimensionId(tagged) !== normalizeDimensionId(live)) {
        return { kind: 'foreign' as const, dimension: tagged, liveDimension: live, chunk, reason: 'foreign_column' as const }
      }
      return { kind: 'attributable' as const, dimension: tagged, liveDimension: live, chunk, reason: null }
    },
    refuseRead (input: RefusedRead): boolean {
      const dedupeKey = `${input.source}|${input.reason}|${input.provenance}`
      const seen = emitted.get(dedupeKey) ?? 0
      if (seen >= REFUSAL_CAP_PER_KEY) return false
      emitted.set(dedupeKey, seen + 1)
      store.refusals += 1
      log('DIMENSION_READ_REFUSED', {
        cell: `${input.cell.x},${input.cell.y},${input.cell.z}`,
        chunk: `${input.chunk.x},${input.chunk.z}`,
        provenance: input.provenance.length === 0 ? 'unknown' : input.provenance,
        dimension: input.liveDimension.length === 0 ? 'unknown' : input.liveDimension,
        reason: input.reason,
        source: input.source,
        action: 'refused',
        refusal: seen + 1,
        runId: runId ?? null,
      })
      return true
    },
    stats () {
      return {
        liveDimension: store.liveDimension,
        taggedColumns: store.columnDimension.size,
        loadsTagged: store.loadsTagged,
        attachDropped: store.attachDropped,
        refusals: store.refusals,
        unloads: store.unloads,
      }
    },
  }
}
