// resident-safety.ts - pure, unit-testable resident-safety primitives.
//
//   #27  bounded reconnect backoff (exponential + jitter, capped) and a
//        reconnect ledger that the control-socket report/status exposes.
//   #28  actuation-lease ownership. The HOST owns the lease; a generation may
//        only perform side-effecting bot calls while it is the active owner.
//        On bot `end`/`kicked`/`error` the HOST revokes it immediately so a
//        stale generation can never act against a dead socket.
//
// This module is imported by the HOST (agent-runner.mts, native TS stripping)
// and by the RELOADABLE generation bundle (generation-entry.ts via esbuild). It
// has no runtime dependency on mineflayer or sockets: the only imports are
// type-only, so Node strips them and nothing extra reaches the bundle.

import type { Bot } from 'mineflayer'
import type { ActuationLease } from './resident-types.ts'

// ---------------------------------------------------------------------------
// #27 reconnect backoff
// ---------------------------------------------------------------------------
export const RECONNECT_BASE_MS = 5000
/** Hard cap on the scheduled delay, so a reconnect can never tight-loop. */
export const RECONNECT_CAP_MS = 30000
/** A connection that lasted at least this long resets the attempt counter. */
export const RECONNECT_STABLE_MS = 60000
/** Sliding window used by `reconnectsLastHour`. */
export const RECONNECT_WINDOW_MS = 3600000

export type DisconnectReason = 'end' | 'kicked' | 'error'

export interface BackoffOptions {
  baseMs?: number
  capMs?: number
  /** deterministic jitter source in [0,1); defaults to Math.random */
  random?: () => number
}

export interface BackoffResult {
  /** uncapped exponential target: base * 2^(attempt-1) */
  targetMs: number
  /** final jittered + capped delay actually scheduled */
  delayMs: number
  capped: boolean
}

/**
 * Bounded exponential backoff with equal jitter.
 *
 * raw     = base * 2^(attempt-1)        (5s, 10s, 20s, 40s -> capped)
 * target  = min(cap, raw)               (5s, 10s, 20s, 30s, 30s ...)
 * delay   = target/2 + random * target/2, so delay ∈ [target/2, target]
 *
 * Jitter stays *below* the target, so the cap is never exceeded.
 */
export function computeReconnectBackoff(attempt: number, options: BackoffOptions = {}): BackoffResult {
  const base = options.baseMs ?? RECONNECT_BASE_MS
  const cap = options.capMs ?? RECONNECT_CAP_MS
  const random = options.random ?? Math.random
  const safeAttempt = Number.isFinite(attempt) && attempt > 1 ? Math.floor(attempt) : 1
  const raw = base * 2 ** (safeAttempt - 1)
  const target = Math.min(cap, raw)
  const unit = Math.min(Math.max(random(), 0), 0.999999)
  const delayMs = Math.max(1, Math.round(target / 2 + unit * (target / 2)))
  return { targetMs: target, delayMs, capped: raw > cap }
}

export interface ReconnectEpisode {
  /** 1-based reconnect ledger sequence number */
  n: number
  /** consecutive reconnect attempt number (resets after a stable connection) */
  attempt: number
  reason: DisconnectReason
  backoffMs: number
  uptimeMs: number
  at: number
  capped: boolean
}

export interface ReconnectReport {
  reconnects: number
  reconnectsLastHour: number
  reconnectAttempt: number
  reconnectReasons: Record<DisconnectReason, number>
  lastReconnectAt: number | null
  lastReconnectReason: DisconnectReason | null
  lastReconnectBackoffMs: number | null
  lastReconnectUptimeMs: number | null
}

export interface ReconnectLedgerOptions extends BackoffOptions {
  windowMs?: number
  stableMs?: number
  maxEntries?: number
  now?: () => number
}

/**
 * In-memory reconnect ledger. Every scheduled reconnect becomes one episode with
 * its reason, backoff and connection uptime; the report counters are derived from
 * it. Bounded to `maxEntries` so a long-lived host cannot grow without limit.
 */
export class ReconnectLedger {
  private readonly options: ReconnectLedgerOptions
  private readonly entries: ReconnectEpisode[] = []
  private readonly reasonCounts: Record<DisconnectReason, number> = { end: 0, kicked: 0, error: 0 }
  private total = 0
  private attempt = 0

  constructor(options: ReconnectLedgerOptions = {}) {
    this.options = options
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  get reconnects(): number {
    return this.total
  }

  currentAttempt(): number {
    return this.attempt
  }

  reasonsSnapshot(): Record<DisconnectReason, number> {
    return { ...this.reasonCounts }
  }

  /**
   * Record a disconnect episode and compute its bounded backoff. A connection
   * that lasted at least `stableMs` resets the consecutive-attempt counter first,
   * so an occasional drop always retries quickly after healthy operation.
   */
  noteDisconnect(reason: DisconnectReason, uptimeMs: number): ReconnectEpisode {
    const stableMs = this.options.stableMs ?? RECONNECT_STABLE_MS
    if (uptimeMs >= stableMs) this.attempt = 0
    this.attempt += 1
    const backoff = computeReconnectBackoff(this.attempt, this.options)
    const episode: ReconnectEpisode = {
      n: this.total + 1,
      attempt: this.attempt,
      reason,
      backoffMs: backoff.delayMs,
      uptimeMs,
      at: this.now(),
      capped: backoff.capped,
    }
    this.total += 1
    this.reasonCounts[reason] += 1
    this.entries.push(episode)
    const maxEntries = this.options.maxEntries ?? 512
    if (this.entries.length > maxEntries) this.entries.splice(0, this.entries.length - maxEntries)
    return episode
  }

  reconnectsLastHour(now = this.now()): number {
    const windowMs = this.options.windowMs ?? RECONNECT_WINDOW_MS
    const floor = now - windowMs
    return this.entries.filter((episode) => episode.at > floor).length
  }

  report(now = this.now()): ReconnectReport {
    const last = this.entries.length > 0 ? this.entries[this.entries.length - 1] : undefined
    return {
      reconnects: this.total,
      reconnectsLastHour: this.reconnectsLastHour(now),
      reconnectAttempt: this.attempt,
      reconnectReasons: { ...this.reasonCounts },
      lastReconnectAt: last?.at ?? null,
      lastReconnectReason: last?.reason ?? null,
      lastReconnectBackoffMs: last?.backoffMs ?? null,
      lastReconnectUptimeMs: last?.uptimeMs ?? null,
    }
  }
}

// ---------------------------------------------------------------------------
// #28 actuation lease
// ---------------------------------------------------------------------------
export interface LeaseLog {
  (event: string, detail?: Record<string, unknown>): void
}

export interface LeaseRevokeEvent {
  reason: string
  generationId: string | null
  revoked: boolean
}

/**
 * HOST-owned actuation lease. Only the host calls `acquire`/`revoke`; generations
 * receive a read-only `ActuationLease` view and call `assertActive` before every
 * side effect.
 */
export class ActuationLeaseManager implements ActuationLease {
  private current: string | null = null
  private acquisitions = 0
  private revocations = 0

  get activeId(): string {
    return this.current ?? ''
  }

  isActive(id: string): boolean {
    return this.current !== null && this.current === id
  }

  assertActive(id: string, what: string): void {
    if (this.current !== id) {
      throw new Error(
        `ACTUATION_LEASE_DENIED what=${what} owner=${this.current ?? 'none'} caller=${id} - refusing a side-effecting call`,
      )
    }
  }

  acquire(id: string, log?: LeaseLog): void {
    if (id.length === 0) throw new Error('LEASE_ACQUIRE_INVALID empty generation id')
    this.current = id
    this.acquisitions += 1
    log?.('LEASE_ACQUIRED', { generationId: id, acquisitions: this.acquisitions })
  }

  /**
   * Idempotent revoke. If no owner is active (e.g. `kicked` already revoked and
   * `end` follows) nothing is revoked and nothing is logged twice.
   */
  revoke(reason: string, log?: LeaseLog): LeaseRevokeEvent {
    const previous = this.current
    if (previous === null) return { reason, generationId: null, revoked: false }
    this.current = null
    this.revocations += 1
    log?.('LEASE_REVOKED', { reason, generationId: previous, revocations: this.revocations })
    return { reason, generationId: previous, revoked: true }
  }

  snapshot(): { activeId: string; acquisitions: number; revocations: number } {
    return { activeId: this.current ?? '', acquisitions: this.acquisitions, revocations: this.revocations }
  }
}

/**
 * Every bot method that can change server-side state. Mineflayer's read-only
 * surface is untouched; these are wrapped by the lease proxy below.
 */
export const MUTATING_BOT_METHODS: ReadonlySet<string> = new Set<string>([
  'dig',
  'placeBlock',
  'equip',
  'unequip',
  'activateItem',
  'deactivateItem',
  'activateBlock',
  'clickWindow',
  'putSelectedItemRange',
  'craft',
  'openBlock',
  'openContainer',
  'closeWindow',
  'setControlState',
  'clearControlStates',
  'look',
  'lookAt',
  'toss',
  'tossStack',
  'chat',
  'setQuickBarSlot',
  'consume',
  'updateSign',
  'useOn',
  'swingArm',
])

/**
 * Wrap a bot so every side-effecting call asserts this generation's lease first.
 * Used by `generation-entry.ts`; exported here so the lease denial can be tested
 * against the real actuator without a live connection.
 */
export function withActuationLease(bot: Bot, lease: ActuationLease, id: string): Bot {
  const assert = (what: string): void => lease.assertActive(id, what)
  let pathfinderProxy: object | null = null
  return new Proxy(bot, {
    get(target, prop, receiver): unknown {
      const value = Reflect.get(target, prop, receiver) as unknown
      if (typeof prop === 'string' && typeof value === 'function' && MUTATING_BOT_METHODS.has(prop)) {
        return (...args: unknown[]): unknown => {
          assert(`bot.${prop}`)
          return (value as (...a: unknown[]) => unknown).apply(target, args)
        }
      }
      if (prop === 'pathfinder' && value !== null && typeof value === 'object') {
        if (pathfinderProxy === null) {
          pathfinderProxy = new Proxy(value, {
            get(pfTarget, pfProp, pfRecv): unknown {
              const pfValue = Reflect.get(pfTarget, pfProp, pfRecv) as unknown
              if (
                (pfProp === 'setGoal' || pfProp === 'setMovements' || pfProp === 'stop' || pfProp === 'goto') &&
                typeof pfValue === 'function'
              ) {
                return (...args: unknown[]): unknown => {
                  assert(`pathfinder.${String(pfProp)}`)
                  return (pfValue as (...a: unknown[]) => unknown).apply(pfTarget, args)
                }
              }
              return pfValue
            },
          })
        }
        return pathfinderProxy
      }
      return value
    },
  }) as Bot
}
