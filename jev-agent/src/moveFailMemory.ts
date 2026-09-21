// moveFailMemory.ts - durable, coordinate-level failure memory for movement targets (#8).
//
// Issue #8: movement failure memory was keyed by exact candidate id only, so a
// blocked bot that picked a *nearby* coordinate got a fresh bucket and retried
// forever. The live resident oscillated between two positions (y=9.0 and y=10.5
// at x=39.1) with no progress because "I already failed to reach this coordinate"
// was never remembered.
//
// This module keeps an exact, dimension-scoped record per target coordinate:
//
//   MOVE_FAILMEM key=<dim>:<x>,<y>,<z> attempts=<n> reason=<unreachable|stuck|no_path|no_progress>
//
// Once `attempts >= failureLimit` the coordinate is blacklisted for `cooldownMs`:
//
//   MOVE_TARGET_SKIPPED key=<k> attempts=<n> cooldown=<s>
//
// A reach resets the entry (`MOVE_FAILMEM_RESET key=<k> reason=reached`) and a
// cooldown expiry makes the target selectable again. The map is bounded: when it
// grows past `maxEntries` the least-failed / oldest entry is evicted.
//
// Oscillation is detected explicitly from the recent position history
// (`OSCILLATION_DETECTED from=<pos> to=<pos> cycles=<n> action=<escape|blacklist>`)
// so the loop can be broken instead of merely counted. The detector accepts
// short repeated cycles, not only an A/B pair: live exploration can circulate
// through several standable cells while the goal inventory stays unchanged.

export interface Vec3Like {
  x: number
  y: number
  z: number
}

export type MoveFailureReason = 'unreachable' | 'stuck' | 'no_path' | 'no_progress'

export interface MoveFailEntry {
  key: string
  dimension: string
  x: number
  y: number
  z: number
  attempts: number
  firstFailedAt: number
  lastFailedAt: number
  lastReason: MoveFailureReason
  /** epoch ms until which the coordinate is skipped; 0 = selectable */
  blacklistedUntil: number
  /**
   * #360: how many times an oscillation escape has suppressed this coordinate. The
   * escape cooldown escalates with repetition so a state-recurring loop is not
   * released back into the same neighbourhood every few seconds. Durable (it lives
   * on the entry), so a reload does not reset the escalation.
   */
  oscillationStrikes?: number
}

/** Upper bound for the escalation applied by repeated oscillation escapes (#360). */
const MAX_OSCILLATION_COOLDOWN_MS = 10 * 60_000

export interface MoveFailMemoryOptions {
  /** failures before a coordinate is blacklisted (default 3) */
  failureLimit?: number
  /** how long a blacklisted coordinate stays skipped (default 30_000 ms) */
  cooldownMs?: number
  /** hard cap on tracked coordinates; least-failed/oldest evicted first (default 256) */
  maxEntries?: number
  /** clock injection for deterministic tests */
  now?: () => number
  /** entries restored from the HOST-owned class-A world memory */
  initialEntries?: readonly MoveFailEntry[]
}

export interface MoveFailRecordResult {
  entry: MoveFailEntry
  blacklisted: boolean
  newlyBlacklisted: boolean
}

export interface MoveFailCheck {
  known: boolean
  attempts: number
  blacklisted: boolean
  cooldownRemainingMs: number
  lastReason: MoveFailureReason | null
}

export const DEFAULT_MOVE_FAILURE_LIMIT = 3
export const DEFAULT_MOVE_COOLDOWN_MS = 30_000
export const DEFAULT_MOVE_MAX_ENTRIES = 256

/**
 * Candidate kinds whose target is a destination worth remembering. SMELT is
 * included because its target is the FURNACE the bot must path to: a guard
 * NO_PATH on the smelt is a real unreachability fact, and recording it lets the
 * station be retired so the acquisition ladder runs instead of the same
 * unreachable furnace being re-offered every tick.
 */
const TRACKED_MOVE_KINDS = new Set(['MOVE', 'RETRIEVE', 'RETREAT', 'DESCEND', 'STEP', 'SMELT'])

export function isTrackedMoveKind(kind: string): boolean {
  return TRACKED_MOVE_KINDS.has(kind)
}

/** Exact, dimension-scoped coordinate key: `<dimension>:<x>,<y>,<z>`. */
export function moveFailureKey(dimension: string, position: Vec3Like): string {
  return `${dimension}:${Math.round(position.x)},${Math.round(position.y)},${Math.round(position.z)}`
}

/** One-decimal position for log lines, matching the live HEARTBEAT format. */
export function formatMovePosition(position: Vec3Like): string {
  const round = (value: number): number => Math.round(value * 10) / 10
  return `${round(position.x)},${round(position.y)},${round(position.z)}`
}

export function formatMoveFailMem(key: string, attempts: number, reason: MoveFailureReason): string {
  return `MOVE_FAILMEM key=${key} attempts=${attempts} reason=${reason}`
}

export function formatMoveTargetSkipped(key: string, attempts: number, cooldownSeconds: number): string {
  return `MOVE_TARGET_SKIPPED key=${key} attempts=${attempts} cooldown=${cooldownSeconds}`
}

export function formatMoveFailMemReset(key: string): string {
  return `MOVE_FAILMEM_RESET key=${key} reason=reached`
}

export function formatOscillationDetected(
  from: Vec3Like,
  to: Vec3Like,
  cycles: number,
  action: 'escape' | 'blacklist',
): string {
  return `OSCILLATION_DETECTED from=${formatMovePosition(from)} to=${formatMovePosition(to)} cycles=${cycles} action=${action}`
}

export class MoveFailMemory {
  private readonly entries = new Map<string, MoveFailEntry>()
  readonly failureLimit: number
  readonly cooldownMs: number
  readonly maxEntries: number
  private readonly now: () => number

  constructor(options: MoveFailMemoryOptions = {}) {
    this.failureLimit = Math.max(1, Math.floor(options.failureLimit ?? DEFAULT_MOVE_FAILURE_LIMIT))
    this.cooldownMs = Math.max(0, options.cooldownMs ?? DEFAULT_MOVE_COOLDOWN_MS)
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_MOVE_MAX_ENTRIES))
    this.now = options.now ?? ((): number => Date.now())
    if (options.initialEntries !== undefined) this.restore(options.initialEntries)
  }

  /** Restore only data-shaped entries; the caller never hands a class instance across the resident boundary. */
  restore(entries: readonly MoveFailEntry[]): void {
    this.entries.clear()
    const now = this.now()
    for (const source of entries) {
      if (source === null || typeof source !== 'object') continue
      if (!Number.isFinite(source.x) || !Number.isFinite(source.y) || !Number.isFinite(source.z)) continue
      const dimension = typeof source.dimension === 'string' && source.dimension.length > 0 ? source.dimension : 'overworld'
      const position = { x: Math.round(source.x), y: Math.round(source.y), z: Math.round(source.z) }
      const attempts = Number.isFinite(source.attempts) ? Math.max(0, Math.floor(source.attempts)) : 0
      const firstFailedAt = Number.isFinite(source.firstFailedAt) ? source.firstFailedAt : now
      const lastFailedAt = Number.isFinite(source.lastFailedAt) ? source.lastFailedAt : firstFailedAt
      const lastReason: MoveFailureReason =
        source.lastReason === 'stuck' || source.lastReason === 'no_path' || source.lastReason === 'no_progress'
          ? source.lastReason
          : 'unreachable'
      const blacklistedUntil = Number.isFinite(source.blacklistedUntil) ? Math.max(0, source.blacklistedUntil) : 0
      const entry: MoveFailEntry = {
        key: moveFailureKey(dimension, position),
        dimension,
        ...position,
        attempts,
        firstFailedAt,
        lastFailedAt,
        lastReason,
        blacklistedUntil,
      }
      this.entries.set(entry.key, entry)
    }
    this.evictIfNeeded()
  }

  /** Record one failed attempt at a coordinate. */
  record(dimension: string, position: Vec3Like, reason: MoveFailureReason): MoveFailRecordResult {
    const now = this.now()
    const key = moveFailureKey(dimension, position)
    let entry = this.entries.get(key)
    if (entry === undefined) {
      entry = {
        key,
        dimension,
        x: Math.round(position.x),
        y: Math.round(position.y),
        z: Math.round(position.z),
        attempts: 0,
        firstFailedAt: now,
        lastFailedAt: now,
        lastReason: reason,
        blacklistedUntil: 0,
      }
      this.entries.set(key, entry)
    }
    const wasBlacklisted = entry.attempts >= this.failureLimit && entry.blacklistedUntil > now
    entry.attempts += 1
    entry.lastFailedAt = now
    entry.lastReason = reason
    let newlyBlacklisted = false
    if (entry.attempts >= this.failureLimit) {
      entry.blacklistedUntil = now + this.cooldownMs
      newlyBlacklisted = !wasBlacklisted
    }
    this.evictIfNeeded()
    return { entry, blacklisted: entry.attempts >= this.failureLimit, newlyBlacklisted }
  }

  /** Force a coordinate onto the blacklist immediately (oscillation escape). */
  blacklist(dimension: string, position: Vec3Like, reason: MoveFailureReason): MoveFailRecordResult {
    const entry = this.entries.get(moveFailureKey(dimension, position))
    const now = this.now()
    const attempts = entry === undefined ? this.failureLimit : Math.max(entry.attempts, this.failureLimit)
    if (entry !== undefined && entry.attempts >= this.failureLimit && entry.blacklistedUntil > now) {
      entry.lastReason = reason
      return { entry, blacklisted: true, newlyBlacklisted: false }
    }
    // Bring attempts up to the limit in one step but keep first-failure history.
    const base: MoveFailEntry =
      entry ??
      ({
        key: moveFailureKey(dimension, position),
        dimension,
        x: Math.round(position.x),
        y: Math.round(position.y),
        z: Math.round(position.z),
        attempts: 0,
        firstFailedAt: now,
        lastFailedAt: now,
        lastReason: reason,
        blacklistedUntil: 0,
      } satisfies MoveFailEntry)
    const first = base.attempts === 0
    base.attempts = attempts
    base.lastReason = reason
    base.lastFailedAt = now
    const strikes = (base.oscillationStrikes ?? 0) + 1
    base.oscillationStrikes = strikes
    const escalated = Math.min(this.cooldownMs * 2 ** (strikes - 1), MAX_OSCILLATION_COOLDOWN_MS)
    base.blacklistedUntil = now + escalated
    this.entries.set(base.key, base)
    this.evictIfNeeded()
    return { entry: base, blacklisted: true, newlyBlacklisted: first || base.attempts === this.failureLimit }
  }

  /** Consult the memory before attempting a coordinate. */
  check(dimension: string, position: Vec3Like): MoveFailCheck {
    const now = this.now()
    const entry = this.entries.get(moveFailureKey(dimension, position))
    if (entry === undefined) {
      return { known: false, attempts: 0, blacklisted: false, cooldownRemainingMs: 0, lastReason: null }
    }
    const blacklisted = entry.attempts >= this.failureLimit && entry.blacklistedUntil > now
    return {
      known: true,
      attempts: entry.attempts,
      blacklisted,
      cooldownRemainingMs: blacklisted ? entry.blacklistedUntil - now : 0,
      lastReason: entry.lastReason,
    }
  }

  isBlacklisted(dimension: string, position: Vec3Like): boolean {
    return this.check(dimension, position).blacklisted
  }

  /** Success resets the coordinate's memory. Returns true when an entry existed. */
  reset(dimension: string, position: Vec3Like): boolean {
    return this.entries.delete(moveFailureKey(dimension, position))
  }

  size(): number {
    return this.entries.size
  }

  snapshot(): MoveFailEntry[] {
    return [...this.entries.values()]
  }

  clear(): void {
    this.entries.clear()
  }

  /** Bounded memory: evict the least-failed entry, oldest first on ties. */
  private evictIfNeeded(): void {
    while (this.entries.size > this.maxEntries) {
      let victimKey: string | null = null
      let victimAttempts = Number.POSITIVE_INFINITY
      let victimLastFailedAt = Number.POSITIVE_INFINITY
      for (const [key, entry] of this.entries) {
        if (entry.attempts < victimAttempts || (entry.attempts === victimAttempts && entry.lastFailedAt < victimLastFailedAt)) {
          victimKey = key
          victimAttempts = entry.attempts
          victimLastFailedAt = entry.lastFailedAt
        }
      }
      if (victimKey === null) return
      this.entries.delete(victimKey)
    }
  }
}

export interface TrackableMoveCandidate {
  kind: string
  target: Vec3Like | null
}

export interface SkippedMoveCandidate<T> {
  candidate: T
  key: string
  attempts: number
  cooldownSeconds: number
  reason: MoveFailureReason | null
}

export interface FilterBlacklistedResult<T> {
  kept: T[]
  skipped: SkippedMoveCandidate<T>[]
}

/**
 * Drop movement candidates whose coordinate is currently blacklisted, so the
 * caller is forced onto a different target/plan in the same cycle. Non-movement
 * candidates (WAIT/ESCALATE/MINE/...) pass through untouched.
 */
export function filterBlacklistedMoves<T extends TrackableMoveCandidate>(
  candidates: readonly T[],
  memory: MoveFailMemory,
  dimension: string,
): FilterBlacklistedResult<T> {
  const kept: T[] = []
  const skipped: SkippedMoveCandidate<T>[] = []
  for (const candidate of candidates) {
    if (candidate.target === null || !isTrackedMoveKind(candidate.kind)) {
      kept.push(candidate)
      continue
    }
    const check = memory.check(dimension, candidate.target)
    if (!check.blacklisted) {
      kept.push(candidate)
      continue
    }
    skipped.push({
      candidate,
      key: moveFailureKey(dimension, candidate.target),
      attempts: check.attempts,
      cooldownSeconds: Math.ceil(check.cooldownRemainingMs / 1000),
      reason: check.lastReason,
    })
  }
  return { kept, skipped }
}

export interface OscillationDetection {
  detected: boolean
  from: Vec3Like | null
  to: Vec3Like | null
  /** how many times the repeated position cycle appears in the suffix */
  cycles: number
}

export interface OscillationOptions {
  /** positions closer than this count as the same spot (default 0.75 blocks) */
  epsilon?: number
  /** only inspect this many trailing samples (default 40) */
  window?: number
  /** minimum cycle repetitions to call it oscillation (default 3) */
  minCycles?: number
}

/**
 * Detect a short repeating position cycle (A B A B ..., or A B C D A B C D ...)
 * in the recent position history. Pure function so the escape action is
 * testable without a live bot.
 */
export function detectOscillation(history: readonly Vec3Like[], options: OscillationOptions = {}): OscillationDetection {
  const epsilon = options.epsilon ?? 0.75
  const window = Math.max(1, Math.floor(options.window ?? 40))
  const minCycles = Math.max(2, Math.floor(options.minCycles ?? 3))
  const none: OscillationDetection = { detected: false, from: null, to: null, cycles: 0 }
  if (history.length < minCycles * 2) return none

  const tail = history.slice(-window)
  // Collapse consecutive samples that sit on the same spot so only real moves remain.
  const points: Vec3Like[] = []
  for (const point of tail) {
    const previous = points[points.length - 1]
    if (previous !== undefined && samePosition(previous, point, epsilon)) continue
    points.push(point)
  }
  if (points.length < minCycles * 2) return none

  const maxPeriod = Math.min(8, Math.floor(points.length / minCycles))
  for (let period = 2; period <= maxPeriod; period += 1) {
    if (points.length < period * minCycles) continue
    const lastCycleStart = points.length - period
    let cycles = 1
    while (points.length >= (cycles + 1) * period) {
      const cycleStart = points.length - (cycles + 1) * period
      let matches = true
      for (let offset = 0; offset < period; offset += 1) {
        const prior = points[cycleStart + offset]
        const current = points[lastCycleStart + offset]
        if (prior === undefined || current === undefined || !samePosition(prior, current, epsilon)) {
          matches = false
          break
        }
      }
      if (!matches) break
      cycles += 1
    }
    if (cycles < minCycles) continue
    const from = points[lastCycleStart]
    const to = points[points.length - 1]
    if (from === undefined || to === undefined || samePosition(from, to, epsilon)) continue
    return { detected: true, from, to, cycles }
  }
  return none
}

export function samePosition(a: Vec3Like, b: Vec3Like, epsilon = 0.75): boolean {
  return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) <= epsilon
}

// --- state-conditioned failure memory (#11 v2 §6, affordance reachability) -----
//
// The cooldown form above re-opens a proven-unreachable target on a wall clock,
// so a 52-block climb was attempted again every 30 s forever. Reachability uses
// the same persisted-fact idea keyed by a SEMANTIC state fingerprint instead:
// target C proven unreachable for reason R under fingerprint F is not offered
// again while F is unchanged. It becomes selectable again the moment the
// relevant state (tool held / placeable block / headroom / topology) changes,
// with no timer and no retry count. Failure history stays readable via
// `snapshot()` and `check()`.

export interface FingerprintFailure {
  key: string
  fingerprint: string
  reason: string
  at: number
}

export interface FingerprintCheck {
  known: boolean
  suppressed: boolean
  fingerprint: string | null
  reason: string | null
  at: number | null
}

export interface StateFingerprintMemoryOptions {
  /** hard cap on tracked targets; oldest evicted first (default 256) */
  maxEntries?: number
  /** clock injection for deterministic tests */
  now?: () => number
}

export class StateFingerprintMemory {
  private readonly entries = new Map<string, FingerprintFailure>()
  readonly maxEntries: number
  private readonly now: () => number

  constructor(options: StateFingerprintMemoryOptions = {}) {
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_MOVE_MAX_ENTRIES))
    this.now = options.now ?? ((): number => Date.now())
  }

  /**
   * Remember that `key` failed for `reason` under `fingerprint`. Re-recording an
   * identical fact keeps the original timestamp (history is a fact, not a count).
   */
  record(key: string, fingerprint: string, reason: string): FingerprintFailure {
    const existing = this.entries.get(key)
    if (existing !== undefined && existing.fingerprint === fingerprint && existing.reason === reason) {
      return existing
    }
    const entry: FingerprintFailure = { key, fingerprint, reason, at: this.now() }
    this.entries.delete(key)
    this.entries.set(key, entry)
    this.evictIfNeeded()
    return entry
  }

  /** True while the unchanged fingerprint still proves the recorded failure. */
  isSuppressed(key: string, fingerprint: string): boolean {
    return this.entries.get(key)?.fingerprint === fingerprint
  }

  check(key: string, fingerprint: string): FingerprintCheck {
    const entry = this.entries.get(key)
    if (entry === undefined) {
      return { known: false, suppressed: false, fingerprint: null, reason: null, at: null }
    }
    return {
      known: true,
      suppressed: entry.fingerprint === fingerprint,
      fingerprint: entry.fingerprint,
      reason: entry.reason,
      at: entry.at,
    }
  }

  /** The state changed so much that the proof no longer holds. */
  forget(key: string): boolean {
    return this.entries.delete(key)
  }

  size(): number {
    return this.entries.size
  }

  snapshot(): FingerprintFailure[] {
    return [...this.entries.values()]
  }

  clear(): void {
    this.entries.clear()
  }

  /** Bounded memory: evict the oldest entry first. */
  private evictIfNeeded(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next()
      if (oldest.done === true) return
      this.entries.delete(oldest.value)
    }
  }
}
