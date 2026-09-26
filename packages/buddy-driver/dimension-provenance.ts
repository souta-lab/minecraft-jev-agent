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
//     `lib/plugins/blocks.js:591`); the first attach adopts the already-loaded
//     columns from that bot's current connection in place;
//   * a dimension change drops old-dimension tags and unloads only those columns,
//     preserving destination columns whose loads have already been witnessed;
//   * a column with no tag is UNKNOWN, and unknown is NOT satisfied: the sensor
//     refuses the read (typed) instead of minting durable memory from it.
//
// It is world truth only (CAN/TRUE): it never ranks or selects an action.
//
// LISTENER LIFETIME. The column store belongs to the bot, and the host owns the
// bot for the whole connection (`buddy-driver/agent-runner.mts` creates it once;
// `generation-entry.ts` hands the SAME object to every generation). Symbol.for
// keeps the store/listener-install marker stable across hash-stamped module reloads.
// The listeners are deliberately NOT generation-tracked resources: a tag must
// survive a generation swap, because the columns do. They die with the bot. The
// per-generation VIEW carries the generation's `log`, so no disposed generation is
// ever called back.

import type { Bot } from 'mineflayer'
import type { CellAttribution, DimensionProvenance, RefusedRead } from '../jev-agent/src/state.ts'
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
  loadEvents: number
  unloadEvents: number
  lastColumnLoadAt: string | null
  lastColumnUnloadAt: string | null
  lastLocalColumnUnloadAt: string | null
  /** Already-loaded current-world columns attributed when the first listener attached. */
  attachAdopted: number
}

const REFUSAL_CAP_PER_KEY = 8
const PENDING_TRANSITION_CAP = 16

// Generation bundles are hash-stamped and re-imported on hot reload. A module
// local WeakMap/WeakSet is therefore not bot-scoped in practice: every changed
// bundle would attach another pair of listeners and treat the same loaded world
// as unobserved. Symbol.for keeps these two bot-owned facts stable across bundles
// in the resident's single JS isolate, while remaining invisible to JSON output.
const STORE_KEY = Symbol.for('mc-ai.buddy.dimension-provenance.store.v1')
const ATTACHED_KEY = Symbol.for('mc-ai.buddy.dimension-provenance.attached.v1')

type BotWithProvenance = Record<symbol, unknown>

function botProvenanceFields (bot: Bot): BotWithProvenance {
  return bot as unknown as BotWithProvenance
}

function storeFor (bot: Bot): ProvenanceStore {
  const fields = botProvenanceFields(bot)
  const existing = fields[STORE_KEY]
  if (existing !== undefined && existing !== null && typeof existing === 'object') return existing as ProvenanceStore
  const created: ProvenanceStore = {
    liveDimension: '',
    columnDimension: new Map<string, string>(),
    pendingTransitions: [],
    refusals: 0,
    unloads: 0,
    loadsTagged: 0,
    loadEvents: 0,
    unloadEvents: 0,
    lastColumnLoadAt: null,
    lastColumnUnloadAt: null,
    lastLocalColumnUnloadAt: null,
    attachAdopted: 0,
  }
  fields[STORE_KEY] = created
  return created
}

/**
 * Unload every column this store knows about. We do this ourselves rather than
 * trusting mineflayer's `switchWorld()` to have run: the live defect is exactly a
 * column that was still readable after a transfer, and a store we can empty is a
 * store we can reason about.
 */
function unloadKnownColumns (bot: Bot, store: ProvenanceStore, onlyKeys: readonly string[] = [...store.columnDimension.keys()]): number {
  const world = bot.world as unknown as { unloadColumn?: (chunkX: number, chunkZ: number) => void } | undefined
  if (world === undefined || world === null || typeof world.unloadColumn !== 'function') return 0
  let unloaded = 0
  for (const key of onlyKeys) {
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
  if (unloaded > 0) store.lastLocalColumnUnloadAt = new Date().toISOString()
  return unloaded
}

/**
 * Install the column-provenance listeners on a bot once. Idempotent per bot
 * object, so every generation may call it and only the first one installs.
 *
 * On first attach, already-loaded columns are tagged with the bot's current
 * dimension. They belong to this Mineflayer connection and WorldSync does not
 * request replacement columns when it locally unloads them. Later dimensions
 * remain guarded by observed load events and transition invalidation.
 */
export function attachDimensionProvenance (bot: Bot): void {
  const fields = botProvenanceFields(bot)
  if (fields[ATTACHED_KEY] === true) return
  fields[ATTACHED_KEY] = true
  const store = storeFor(bot)
  const onLoad = (corner: ColumnCorner): void => {
    const chunk = cornerChunk(corner)
    if (chunk === null) return
    store.loadEvents += 1
    store.lastColumnLoadAt = new Date().toISOString()
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
    store.unloadEvents += 1
    store.lastColumnUnloadAt = new Date().toISOString()
    store.columnDimension.delete(chunkKey(chunk.chunkX, chunk.chunkZ))
  }
  bot.on('chunkColumnLoad', onLoad)
  bot.on('chunkColumnUnload', onUnload)
  // First attach happens as the resident generation starts for this Mineflayer
  // connection. Existing columns were loaded by this bot in its current world.
  // Attribute them in place: WorldSync.unloadColumn() only erases the LOCAL cache;
  // it sends no request that tells the server to resend those columns. Dropping
  // here (and especially doing it again from every re-imported generation bundle)
  // can leave the body with no readable support/terrain until the player crosses
  // out of and back into each chunk. A true dimension transition still drops
  // witnessed old-dimension columns in syncStore() below.
  store.attachAdopted = tagExistingColumns(bot, store, canonicalDimensionId(bot.game?.dimension))
}

/** Tag already loaded columns without mutating Mineflayer's local cache. */
function tagExistingColumns (bot: Bot, store: ProvenanceStore, liveDimension: string): number {
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
  if (liveDimension.length === 0) return 0
  for (const key of keys) store.columnDimension.set(key, liveDimension)
  return keys.length
}

/**
 * Move the store to a newly observed live dimension. Drop old/foreign tags and
 * unload only those old columns; columns already witnessed loading in `next`
 * survive the synchronization.
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
  // empty; columns present at first attach were loaded by this bot in its current world
  // and already carry that dimension tag. Record the live dimension without invalidating
  // those current-world reads.
  if (store.liveDimension.length === 0) {
    store.liveDimension = next
    return { changed: false, from: '', to: next, columnsDropped: 0, columnsUnloaded: 0 }
  }
  const from = store.liveDimension
  store.liveDimension = next
  const destination = normalizeDimensionId(next)
  const staleKeys = [...store.columnDimension.entries()]
    .filter(([, taggedDimension]) => normalizeDimensionId(taggedDimension) !== destination)
    .map(([key]) => key)
  const columnsDropped = staleKeys.length
  const columnsUnloaded = unloadKnownColumns(bot, store, staleKeys)
  for (const key of staleKeys) store.columnDimension.delete(key)
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
  attachAdopted: number
  refusals: number
  unloads: number
  loadEvents: number
  unloadEvents: number
  lastColumnLoadAt: string | null
  lastColumnUnloadAt: string | null
  lastLocalColumnUnloadAt: string | null
}

export interface DimensionProvenanceColumnDiagnostic {
  chunkX: number
  chunkZ: number
  kind: CellAttribution['kind']
  dimension: string | null
  liveDimension: string | null
  reason: CellAttribution['reason']
}

export interface DimensionProvenanceDiagnostic extends DimensionProvenanceStats {
  /** Which lifetime supplied this read-only snapshot. */
  sourceScope?: 'generation' | 'host-bot'
  columns: DimensionProvenanceColumnDiagnostic[]
  columnsTruncated: boolean
}

export interface DimensionProvenanceProbe {
  diagnostic: DimensionProvenanceDiagnostic | null
  sourceScope: 'generation' | 'host-bot' | 'unavailable'
  /** Explains a host-side read when the active generation could not provide it. */
  fallbackReason: 'generation-unavailable' | 'generation-view-missing' | 'generation-view-error' | 'bot-provenance-store-unavailable' | null
}

/** A world cache read needs both loaded data and positive live-dimension attribution. */
export function isProbeColumnReadable (
  loaded: boolean,
  kind: string | null | undefined,
): boolean {
  return loaded === true && kind === 'attributable'
}

export interface DimensionProvenanceView extends DimensionProvenance {
  /** Refresh the live dimension from the bot and apply a transition if one happened. */
  syncLiveDimension (reason: string): void
  /** Observation counters, for the generation's own evidence line. */
  stats (): DimensionProvenanceStats
  /** Read-only requested-column attribution snapshot; does not sync or mutate the store. */
  diagnostic (columns: readonly { chunkX: number; chunkZ: number }[]): DimensionProvenanceDiagnostic
}

/**
 * Read a probe snapshot from the bot-owned provenance store without depending on
 * an active generation. This is intentionally read-only: unlike `syncStore`, it
 * neither drops tags nor unloads Mineflayer columns. The live dimension comes
 * from the bot at sample time, so a probe during a generation recovery cannot
 * accidentally treat the last generation's dimension as current.
 *
 * A missing store is UNKNOWN. This function never creates one or adopts current
 * cache columns, because doing so would invent load provenance after the fact.
 */
export function readOnlyBotDimensionProvenanceDiagnostic (
  bot: Bot,
  columns: readonly { chunkX: number; chunkZ: number }[],
): DimensionProvenanceDiagnostic | null {
  const stored = botProvenanceFields(bot)[STORE_KEY]
  if (stored === undefined || stored === null || typeof stored !== 'object') return null
  const store = stored as ProvenanceStore
  if (!(store.columnDimension instanceof Map)) return null

  const liveDimension = canonicalDimensionId(bot.game?.dimension)
  const bounded = columns.slice(0, 128)
  const unique = new Map<string, { chunkX: number; chunkZ: number }>()
  for (const column of bounded) {
    if (!Number.isFinite(column.chunkX) || !Number.isFinite(column.chunkZ)) continue
    const chunkX = Math.floor(column.chunkX)
    const chunkZ = Math.floor(column.chunkZ)
    unique.set(chunkKey(chunkX, chunkZ), { chunkX, chunkZ })
  }
  const diagnostics = [...unique.values()].map(({ chunkX, chunkZ }) => {
    const taggedDimension = store.columnDimension.get(chunkKey(chunkX, chunkZ))
    if (liveDimension.length === 0) {
      return {
        chunkX,
        chunkZ,
        kind: 'unknown' as const,
        dimension: taggedDimension ?? null,
        liveDimension: null,
        reason: 'unknown_live_dimension' as const,
      }
    }
    if (taggedDimension === undefined) {
      return {
        chunkX,
        chunkZ,
        kind: 'unknown' as const,
        dimension: null,
        liveDimension,
        reason: 'unknown_column' as const,
      }
    }
    if (normalizeDimensionId(taggedDimension) !== normalizeDimensionId(liveDimension)) {
      return {
        chunkX,
        chunkZ,
        kind: 'foreign' as const,
        dimension: taggedDimension,
        liveDimension,
        reason: 'foreign_column' as const,
      }
    }
    return {
      chunkX,
      chunkZ,
      kind: 'attributable' as const,
      dimension: taggedDimension,
      liveDimension,
      reason: null,
    }
  })

  return {
    sourceScope: 'host-bot',
    liveDimension,
    taggedColumns: store.columnDimension.size,
    loadsTagged: store.loadsTagged,
    attachAdopted: store.attachAdopted,
    refusals: store.refusals,
    unloads: store.unloads,
    loadEvents: store.loadEvents,
    unloadEvents: store.unloadEvents,
    lastColumnLoadAt: store.lastColumnLoadAt,
    lastColumnUnloadAt: store.lastColumnUnloadAt,
    lastLocalColumnUnloadAt: store.lastLocalColumnUnloadAt,
    columns: diagnostics,
    columnsTruncated: columns.length > bounded.length,
  }
}

/**
 * Prefer the active generation's view, but keep the read-only world probe alive
 * while that generation is absent, missing the optional capability, or failing
 * to answer. A host-bot result conveys block provenance only; it does not imply
 * that any decision, Option, or milestone belongs to a generation.
 */
export function dimensionProvenanceForProbe (
  bot: Bot,
  generation: { worldProbeProvenance?: (columns: readonly { chunkX: number; chunkZ: number }[]) => DimensionProvenanceDiagnostic } | null,
  columns: readonly { chunkX: number; chunkZ: number }[],
): DimensionProvenanceProbe {
  let fallbackReason: DimensionProvenanceProbe['fallbackReason'] = generation === null
    ? 'generation-unavailable'
    : typeof generation.worldProbeProvenance === 'function' ? null : 'generation-view-missing'
  if (typeof generation?.worldProbeProvenance === 'function') {
    try {
      const diagnostic = generation.worldProbeProvenance(columns)
      if (diagnostic === null || typeof diagnostic !== 'object') throw new Error('invalid-generation-provenance-view')
      return {
        diagnostic,
        sourceScope: 'generation',
        fallbackReason: null,
      }
    } catch {
      fallbackReason = 'generation-view-error'
    }
  }

  const diagnostic = readOnlyBotDimensionProvenanceDiagnostic(bot, columns)
  return diagnostic === null
    ? { diagnostic: null, sourceScope: 'unavailable', fallbackReason: 'bot-provenance-store-unavailable' }
    : { diagnostic, sourceScope: 'host-bot', fallbackReason }
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
        attachAdopted: store.attachAdopted,
        refusals: store.refusals,
        unloads: store.unloads,
        loadEvents: store.loadEvents,
        unloadEvents: store.unloadEvents,
        lastColumnLoadAt: store.lastColumnLoadAt,
        lastColumnUnloadAt: store.lastColumnUnloadAt,
        lastLocalColumnUnloadAt: store.lastLocalColumnUnloadAt,
      }
    },
    diagnostic (columns) {
      const bounded = columns.slice(0, 128)
      const unique = new Map<string, { chunkX: number; chunkZ: number }>()
      for (const column of bounded) {
        if (!Number.isFinite(column.chunkX) || !Number.isFinite(column.chunkZ)) continue
        const chunkX = Math.floor(column.chunkX)
        const chunkZ = Math.floor(column.chunkZ)
        unique.set(chunkKey(chunkX, chunkZ), { chunkX, chunkZ })
      }
      const columnDiagnostics = [...unique.values()].map(({ chunkX, chunkZ }) => {
        const verdict = this.cellAttribution(chunkX * 16, chunkZ * 16)
        return {
          chunkX,
          chunkZ,
          kind: verdict.kind,
          dimension: verdict.dimension.length === 0 ? null : verdict.dimension,
          liveDimension: verdict.liveDimension.length === 0 ? null : verdict.liveDimension,
          reason: verdict.reason,
        }
      })
      return {
        sourceScope: 'generation',
        ...this.stats(),
        columns: columnDiagnostics,
        columnsTruncated: columns.length > 128,
      }
    },
  }
}
