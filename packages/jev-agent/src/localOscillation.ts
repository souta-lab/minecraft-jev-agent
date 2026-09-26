// localOscillation.ts - the DURABLE, bounded record of a LOCAL MOTION oscillation.
//
// Operator framing (2026-09-23, live beside the Nether portal, `run-mucqgrdo-21plr`):
// the behaviours that must never be left alone are
//
//   同じ場所の往復          - a round trip in the same place
//   4点以上の局所徘徊       - local wandering over four or more points
//   目的のない DIG/MOVE     - a DIG/MOVE with no purpose
//   body motionだけで semantic stall timer が reset される
//
// Measured shape: the body sat at `(24.6,53,-10.1)` while the decisions cycled
// `MOVE:p25_54_-9` / `WAIT` / `MOVE:p24_53_-9` / `MOVE:p25_54_-10` / `MOVE:p25_54_-9`,
// every MOVE failed `reason=stuck`, `MOVE_FAILMEM attempts=6` and `attempts=7`
// proved the 30 s coordinate blacklist had already expired twice, and the log
// printed `LOCAL_PROGRESS_STALL stalledMs=91744 boundary=local_recovery` without
// anything acting on it.
//
// Why every existing counter misses exactly this shape (file:line in the message
// this module was added with):
//   - `LOCAL_PROGRESS_STALL` is diagnostic only; `boundary.wake` is never read and
//     `system2=false` is a string literal (controller.ts:8111);
//   - `noProductiveSignature` embeds the ROUNDED POSITION, so a body that moves
//     launders its own repeat counter (controller.ts:9645);
//   - `WaitStreakEscalation` only counts while `actionable > 0`, and the reported
//     tick was `presented=1` (WAIT only) so the streak is cleared every tick;
//   - `ActionFailureEscalation` is keyed `(plan, actionId, reason)`, so rotating
//     between neighbouring coordinates restarts it at 1;
//   - `evaluateOscillation` tracks ONE canonical position PAIR, so a 3-cell cycle
//     resets `cycles` at every step (oscillation.ts:67-71);
//   - `StrategicStallTracker` requires >= 6 body-progress decisions in its window,
//     and a failed/stuck MOVE reports no `body` progress at all (strategicStall.ts:54);
//   - `moveFailMemory` + `detectOscillation` DO bite, but only by blacklisting
//     individual coordinates for a WALL-CLOCK cooldown (30 s -> 10 min), so the
//     same small set is re-offered forever with no state-conditioned end.
//
// The missing general fact is therefore a SET-level, state-conditioned record:
// `the body keeps re-engaging the same small set of cells while nothing about the
// situation changes`. It is deliberately NOT a queue-head bound (that is owned by
// the durable-row starvation bound) and NOT a semantic verdict: it never reorders
// candidates, never picks a strategy, and only hands the typed fact upward.
//
// Pure and bot-free so the threshold behaviour is unit-testable, and plain data
// so the HOST can persist it as class-A world memory and seed it into the next
// generation.
import { moveFailureKey } from './moveFailMemory.ts'
import type { Vec3Like } from './moveFailMemory.ts'

/**
 * How many most-recently engaged distinct cells still count as "the same small
 * set of cells".
 *
 * The operator names a 2-3 cell loop and calls 4+ points of local wandering a
 * violation, so the envelope must be strictly larger than the largest named
 * loop, otherwise a 4-point cycle would be reported as "the body left the
 * pocket" on the step that closes it. Six cells is a ~6-block neighbourhood:
 * every measured loop fits (2 cells live, the 4-cell 2x2 pocket of #360, the
 * 3-cell Nether cycle), while a genuine route rotates the envelope forward
 * without ever re-engaging a cell still inside it.
 */
export const LOCAL_OSCILLATION_RECENT_CELLS_DEFAULT = 6

/**
 * Re-engagements of an already-engaged cell, with zero semantic progress,
 * before the bounded local recovery is code-proven exhausted.
 *
 * `MOVE_FAILMEM_LIMIT` is 3 per coordinate, so ONE full blacklist round of the
 * operator's 3-cell loop costs 9 engagements of which the first 3 open the set:
 * 8 returns is at least one complete round of the largest named loop plus a
 * repeat, i.e. proof that the wall-clock cooldown already expired without the
 * situation changing. It is also 2x the firing point of the existing pair
 * detector (`OSCILLATION_LIMIT = 3` fires at the 4th transition), so it is
 * deliberately later than the live-tuned pair bound instead of a second opinion
 * at the same threshold. At the measured decision pace this is ~16 decisions.
 */
export const LOCAL_OSCILLATION_RETURN_LIMIT_DEFAULT = 8

/**
 * Ceiling for the per-trip doubling of the required returns. A persistent pocket
 * must get HARDER to re-report, not equally likely (the `wait_limit` backoff and
 * `strategicStallRequiredWindow` use the same bounded-exponential convention);
 * the 4th trip needs 8x the returns, so System2 consultation cannot hot-loop.
 */
export const LOCAL_OSCILLATION_MAX_BACKOFF_EXPONENT = 3

export const LOCAL_OSCILLATION_BOUNDARY_MARKER = 'LOCAL_OSCILLATION_BOUNDARY'
export const LOCAL_OSCILLATION_CLEARED_MARKER = 'LOCAL_OSCILLATION_CLEARED'

/** `BUDDY_LOCAL_OSCILLATION_CELLS` overrides the envelope; invalid values fall back. */
export function resolveLocalOscillationRecentCells(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = Number(env.BUDDY_LOCAL_OSCILLATION_CELLS ?? LOCAL_OSCILLATION_RECENT_CELLS_DEFAULT)
  return Number.isInteger(raw) && raw >= 2 ? raw : LOCAL_OSCILLATION_RECENT_CELLS_DEFAULT
}

/** `BUDDY_LOCAL_OSCILLATION_RETURNS` overrides the limit; invalid values fall back. */
export function resolveLocalOscillationReturnLimit(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = Number(env.BUDDY_LOCAL_OSCILLATION_RETURNS ?? LOCAL_OSCILLATION_RETURN_LIMIT_DEFAULT)
  return Number.isInteger(raw) && raw >= 2 ? raw : LOCAL_OSCILLATION_RETURN_LIMIT_DEFAULT
}

/**
 * The durable record. Plain JSON data only: it is written into the class-A
 * world memory (`ResidentWorldMemory.localOscillation`) and re-seeded into every
 * later generation, so a hot reload, a respawn or a host restart cannot launder
 * the oscillation by resetting a controller-scoped counter.
 */
export interface LocalOscillationRecordJson {
  /** dimension the episode was observed in; a different dimension ends it */
  dimension: string
  /** recency-ordered dimension-scoped block-cell keys, newest first (bounded) */
  cells: string[]
  /** epoch ms of the episode's first engagement */
  firstSeenAt: number
  /** epoch ms of the most recent settled decision in the episode */
  lastSeenAt: number
  /** settled decisions observed inside the episode */
  decisions: number
  /** re-engagements of a cell already in the envelope: the oscillation itself */
  returns: number
  /** consecutive brand-new cells since the last return (the body leaving the pocket) */
  escapes: number
  /** how many times the body's own block cell actually changed */
  cellChanges: number
  /** boundary trips already fired for this unchanged situation (drives the backoff) */
  trips: number
  /** the goal key in effect when the episode opened (evidence only, never a re-arm key) */
  goal: string
}

/**
 * One settled decision, reduced to the facts the record needs. `semanticProgress`
 * / `inventoryChanged` / `distanceClosed` are the three "the situation changed"
 * facts the operator named; any of them ends the episode.
 */
export interface LocalOscillationObservation {
  /** dimension-scoped cell key of the cell the body occupies at settle time */
  bodyCell: string
  /** dimension-scoped cell key a MOVEMENT decision attempted, when there was one */
  attemptCell: string | null
  dimension: string
  /** goal key in effect (evidence only; a plan change is not progress) */
  goal: string
  /** the settled decision changed the body's block cell */
  cellChanged: boolean
  /** `goal`/`search` progress: the objective advanced or the world changed */
  semanticProgress: boolean
  /** the inventory digest changed (any item count, not only the goal item) */
  inventoryChanged: boolean
  /** a RETRIEVE closed distance to its target: real locomotion toward a target */
  distanceClosed: boolean
  now: number
}

export type LocalOscillationClearReason =
  | 'semantic_progress'
  | 'inventory_delta'
  | 'distance_closed'
  | 'left_pocket'
  | 'dimension_changed'

export interface LocalOscillationDecision {
  /** the record to persist (null once the situation changed) */
  record: LocalOscillationRecordJson | null
  /** why a non-empty record was cleared, when it was */
  cleared: LocalOscillationClearReason | null
  /** true when the bounded return window is exhausted and the fact must go upward */
  exhausted: boolean
  /** the ready-to-log typed boundary line, or null when nothing tripped */
  line: string | null
  /** returns required for the NEXT trip (doubles per trip, bounded) */
  required: number
}

export interface LocalOscillationOptions {
  recentCells?: number
  returnLimit?: number
  maxBackoffExponent?: number
}

/**
 * Rehydrate a restored record, dropping anything that is not shaped like one.
 * The HOST restores class-A JSON from disk, so this is the ONE validation point
 * between durable bytes and the controller.
 */
export function restoreLocalOscillationRecord(value: unknown): LocalOscillationRecordJson | null {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) return null
  const source = value as Record<string, unknown>
  if (typeof source.dimension !== 'string' || source.dimension.length === 0) return null
  const cells = Array.isArray(source.cells) ? source.cells.filter((cell): cell is string => typeof cell === 'string') : []
  if (cells.length === 0) return null
  const count = (raw: unknown, fallback: number): number =>
    typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : fallback
  const firstSeenAt = count(source.firstSeenAt, 0)
  const lastSeenAt = count(source.lastSeenAt, firstSeenAt)
  return {
    dimension: source.dimension,
    cells: [...new Set(cells)],
    firstSeenAt,
    lastSeenAt,
    decisions: count(source.decisions, 0),
    returns: count(source.returns, 0),
    escapes: count(source.escapes, 0),
    cellChanges: count(source.cellChanges, 0),
    trips: count(source.trips, 0),
    goal: typeof source.goal === 'string' ? source.goal : '',
  }
}

/** The returns required before the next trip: `limit * 2 ** min(trips, cap)`. */
export function requiredLocalOscillationReturns(
  returnLimit: number,
  trips: number,
  maxBackoffExponent: number = LOCAL_OSCILLATION_MAX_BACKOFF_EXPONENT,
): number {
  const exponent = Math.min(Math.max(0, Math.floor(trips)), Math.max(0, Math.floor(maxBackoffExponent)))
  return returnLimit * 2 ** exponent
}

/** Short human cell key (`x,y,z`) for the typed evidence, when it parses. */
export function shortCellKey(cell: string): string {
  const separator = cell.lastIndexOf(':')
  const coordinates = separator >= 0 ? cell.slice(separator + 1) : cell
  return /^-?\d+,-?\d+,-?\d+$/.test(coordinates) ? coordinates : cell
}

/** Bounding-box diagonal of the recorded cells, in blocks. 0 for a single cell. */
export function localOscillationSpan(cells: readonly string[]): number {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let minZ = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  let maxZ = Number.NEGATIVE_INFINITY
  let seen = 0
  for (const cell of cells) {
    const separator = cell.lastIndexOf(':')
    const parts = (separator >= 0 ? cell.slice(separator + 1) : cell).split(',')
    if (parts.length !== 3) continue
    const [x, y, z] = parts.map((part) => Number(part))
    if (x === undefined || y === undefined || z === undefined) continue
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    minZ = Math.min(minZ, z)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
    maxZ = Math.max(maxZ, z)
    seen += 1
  }
  if (seen === 0) return 0
  return Math.round(Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) * 10) / 10
}

/** The typed boundary line: cells, span, elapsed time, and what stayed unchanged. */
export function formatLocalOscillationBoundary(
  record: LocalOscillationRecordJson,
  required: number,
  recentCells: number = LOCAL_OSCILLATION_RECENT_CELLS_DEFAULT,
): string {
  const elapsedMs = Math.max(0, record.lastSeenAt - record.firstSeenAt)
  const cells = record.cells.map((cell) => shortCellKey(cell)).join(' ')
  return (
    `${LOCAL_OSCILLATION_BOUNDARY_MARKER} cells=[${cells}] count=${record.cells.length}/${recentCells} ` +
    `returns=${record.returns}/${required} span=${localOscillationSpan(record.cells)}m elapsedMs=${elapsedMs} ` +
    `decisions=${record.decisions} cellChanges=${record.cellChanges} goal="${record.goal}" ` +
    `unchanged=inventory,blocks,cell_set -> wake System2`
  )
}

/** The typed clear line, emitted only for a record that had something to clear. */
export function formatLocalOscillationCleared(
  record: LocalOscillationRecordJson,
  reason: LocalOscillationClearReason,
): string {
  const elapsedMs = Math.max(0, record.lastSeenAt - record.firstSeenAt)
  return (
    `${LOCAL_OSCILLATION_CLEARED_MARKER} reason=${reason} cells=${record.cells.length} ` +
    `returns=${record.returns} trips=${record.trips} elapsedMs=${elapsedMs} goal="${record.goal}"`
  )
}

/** True when a record carries evidence worth persisting (plain walking does not). */
export function isNotableLocalOscillation(record: LocalOscillationRecordJson | null): boolean {
  return record !== null && (record.returns > 0 || record.trips > 0)
}

/**
 * Change-detection key for the durable half. `lastSeenAt` and `decisions` move on
 * every settled decision, so including them would turn an ordinary WAIT tick into
 * a class-A world-memory write; what must reach the next generation is the return
 * count, the cell envelope and the trip count.
 */
export function localOscillationPersistKey(record: LocalOscillationRecordJson | null): string {
  if (record === null) return 'null'
  return JSON.stringify({ ...record, lastSeenAt: 0, decisions: 0 })
}

/**
 * Track the body's local cell envelope for one no-progress episode.
 *
 * Semantics (state-conditioned, never wall-clock):
 *   - the envelope holds the `recentCells` most recently engaged distinct cells;
 *   - a MOVEMENT decision engages its destination cell even when the body never
 *     arrives, which is what makes the measured `reason=stuck` cycle visible;
 *   - re-engaging a cell already in the envelope is a RETURN; the episode trips
 *     when returns reach `limit` (doubling per trip, bounded);
 *   - `goal`/`search` progress, an inventory delta and a closed distance each END
 *     the episode: those are the situation changes the operator named, and they
 *     are the only things that may reset the evidence - verified body motion that
 *     only revisits the same cells deliberately does NOT;
 *   - `recentCells` brand-new cells in a row END the episode: a full envelope of
 *     new ground since the last re-engagement means the body is going somewhere;
 *   - a plan/goal change alone is evidence, never a re-arm: otherwise replacing
 *     the Option would launder the very loop this record exists to prove.
 */
export function observeLocalOscillation(
  previous: LocalOscillationRecordJson | null,
  observation: LocalOscillationObservation,
  options: LocalOscillationOptions = {},
): LocalOscillationDecision {
  const recentCells =
    options.recentCells !== undefined && Number.isInteger(options.recentCells) && options.recentCells >= 2
      ? options.recentCells
      : LOCAL_OSCILLATION_RECENT_CELLS_DEFAULT
  const returnLimit =
    options.returnLimit !== undefined && Number.isInteger(options.returnLimit) && options.returnLimit >= 2
      ? options.returnLimit
      : LOCAL_OSCILLATION_RETURN_LIMIT_DEFAULT
  const maxBackoffExponent =
    options.maxBackoffExponent !== undefined
    && Number.isInteger(options.maxBackoffExponent)
    && options.maxBackoffExponent >= 0
      ? options.maxBackoffExponent
      : LOCAL_OSCILLATION_MAX_BACKOFF_EXPONENT

  const restored = restoreLocalOscillationRecord(previous)
  const cleared = (reason: LocalOscillationClearReason): LocalOscillationDecision => ({
    record: null,
    cleared: reason,
    exhausted: false,
    line: null,
    required: requiredLocalOscillationReturns(returnLimit, 0, maxBackoffExponent),
  })

  if (observation.semanticProgress) return cleared('semantic_progress')
  if (observation.inventoryChanged) return cleared('inventory_delta')
  if (observation.distanceClosed) return cleared('distance_closed')
  if (restored !== null && restored.dimension !== observation.dimension) return cleared('dimension_changed')

  const now = Number.isFinite(observation.now) ? observation.now : 0
  const base: LocalOscillationRecordJson = restored ?? {
    dimension: observation.dimension,
    cells: [],
    firstSeenAt: now,
    lastSeenAt: now,
    decisions: 0,
    returns: 0,
    escapes: 0,
    cellChanges: 0,
    trips: 0,
    goal: observation.goal,
  }

  const cells = [...base.cells]
  let returns = base.returns
  let escapes = base.escapes
  let cellChanges = base.cellChanges

  const engagements: string[] = []
  if (cells.length === 0 || observation.cellChanged) engagements.push(observation.bodyCell)
  if (observation.attemptCell !== null) engagements.push(observation.attemptCell)
  if (observation.cellChanged) cellChanges += 1

  // One settled decision engages a cell once. A successful MOVE settles with the
  // body standing on its own target, so `bodyCell === attemptCell` there and
  // counting it twice would manufacture a return out of every ordinary arrival.
  for (const cell of new Set(engagements)) {
    const index = cells.indexOf(cell)
    if (index >= 0) {
      returns += 1
      escapes = 0
      cells.splice(index, 1)
    } else {
      escapes += 1
    }
    cells.unshift(cell)
  }
  while (cells.length > recentCells) cells.pop()

  if (escapes >= recentCells) {
    // A full envelope of brand-new cells since the last re-engagement: the body
    // is travelling, so this is no longer the same small set of cells.
    return cleared('left_pocket')
  }

  const next: LocalOscillationRecordJson = {
    ...base,
    cells,
    returns,
    escapes,
    cellChanges,
    lastSeenAt: now,
    decisions: base.decisions + 1,
  }
  const required = requiredLocalOscillationReturns(returnLimit, next.trips, maxBackoffExponent)
  if (returns >= required) {
    next.trips += 1
    return {
      record: next,
      cleared: null,
      exhausted: true,
      line: formatLocalOscillationBoundary(next, required, recentCells),
      required: requiredLocalOscillationReturns(returnLimit, next.trips, maxBackoffExponent),
    }
  }
  return { record: next, cleared: null, exhausted: false, line: null, required }
}

/** Convenience for wiring: the dimension-scoped cell key of a position. */
export function localOscillationCell(dimension: string, position: Vec3Like): string {
  return moveFailureKey(dimension, position)
}
