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
// and by the RELOADABLE generation bundle (generation-entry.ts via Bun.build). It
// has no runtime dependency on mineflayer or sockets: the only imports are
// type-only, so Node strips them and nothing extra reaches the bundle.

import type { Bot } from 'mineflayer'
import type { ActuationPose, ActuationPort } from '../jev-agent/src/actuationPort.ts'
import type { ActuationLease, GenerationResourceCounts, GenerationResourceTarget, GenerationResources } from './resident-types.ts'

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

const liveGenerationRegistries = new Set<GenerationResourceRegistry>()
const collectedRegistryIds: string[] = []
let registrySeq = 0
const registryFinalizer: FinalizationRegistry<string> | null =
  typeof FinalizationRegistry === 'function'
    ? new FinalizationRegistry<string>((id) => {
        collectedRegistryIds.push(id)
      })
    : null

/**
 * Tracks exactly the listeners and timers ONE generation owns so the host can
 * remove all of them on teardown instead of trusting that `controller.stop()`
 * covered every path (#13). A FinalizationRegistry note lets a leak test observe
 * a registry collected without an explicit dispose.
 */
export class GenerationResourceRegistry implements GenerationResources {
  readonly registryId: string
  private listeners: Array<{ target: GenerationResourceTarget; event: string; fn: (...args: unknown[]) => void }> = []
  private readonly timers = new Set<unknown>()
  private disposed = false

  constructor() {
    registrySeq += 1
    this.registryId = `res-${registrySeq.toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    liveGenerationRegistries.add(this)
    registryFinalizer?.register(this, this.registryId, this)
  }

  trackListener(target: GenerationResourceTarget, event: string, fn: (...args: unknown[]) => void): void {
    if (this.disposed) return
    this.listeners.push({ target, event, fn })
  }

  untrackListener(target: GenerationResourceTarget, event: string, fn: (...args: unknown[]) => void): void {
    this.listeners = this.listeners.filter((entry) => !(entry.target === target && entry.event === event && entry.fn === fn))
  }

  untrackAll(target: GenerationResourceTarget, event?: string): void {
    this.listeners = this.listeners.filter((entry) => !(entry.target === target && (event === undefined || entry.event === event)))
  }

  trackTimer(handle: unknown): void {
    if (!this.disposed) this.timers.add(handle)
  }

  untrackTimer(handle: unknown): void {
    this.timers.delete(handle)
  }

  counts(): GenerationResourceCounts {
    return { listeners: this.listeners.length, timers: this.timers.size }
  }

  /** Listener ownership by event, used to separate active temporary resources from leaks. */
  ownedListenerCounts(): Record<string, number> {
    const counts: Record<string, number> = {}
    for (const entry of this.listeners) counts[entry.event] = (counts[entry.event] ?? 0) + 1
    return counts
  }

  isDisposed(): boolean {
    return this.disposed
  }

  /** Removes every tracked resource. Anything that throws stays tracked and is reported. */
  dispose(): GenerationResourceCounts {
    const remaining: typeof this.listeners = []
    for (const entry of this.listeners) {
      try {
        entry.target.removeListener?.(entry.event, entry.fn)
      } catch {
        remaining.push(entry)
      }
    }
    for (const handle of this.timers) clearTrackedTimer(handle)
    this.timers.clear()
    this.listeners = remaining
    this.disposed = true
    liveGenerationRegistries.delete(this)
    registryFinalizer?.unregister(this)
    return this.counts()
  }
}

function clearTrackedTimer(handle: unknown): void {
  const withClear = handle as { clear?: unknown }
  if (typeof withClear === 'object' && withClear !== null && typeof withClear.clear === 'function') {
    ;(withClear.clear as () => void).call(handle)
    return
  }
  clearTimeout(handle as NodeJS.Timeout)
  clearInterval(handle as NodeJS.Timeout)
}

/** Leak-test hook: registries created but not yet disposed. */
export function liveGenerationRegistryCount(): number {
  return liveGenerationRegistries.size
}

/** Leak-test hook: registry ids observed by the FinalizationRegistry after GC. */
export function collectedGenerationRegistryIds(): string[] {
  return [...collectedRegistryIds]
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
  // Mineflayer's private look-free placement primitive (pillar steps).
  '_placeBlockWithOptions',
  // Actuators that were observation-only before V4.1.2 closure: a revoked
  // generation must not be able to swing, abort a dig, open a station or
  // move items through them.
  'attack',
  'stopDigging',
  'openFurnace',
  'openEnchantmentTable',
  'openVillager',
  'openAnvil',
  'activateEntity',
  'activateEntityAt',
  'placeEntity',
  'sleep',
  'wake',
  'fish',
  'mount',
  'dismount',
  'transfer',
  'withdraw',
  'deposit',
])

/**
 * One observed mutation dispatch at the lease boundary. Emitted to the kernel
 * authority session as mutation evidence; the lease assert (not the observer)
 * is what gates the call.
 */
export interface MutationObservation {
  /** e.g. `bot.setControlState`, `pathfinder.setGoal`, `_client.write`, `entity.yaw`. */
  readonly surface: string
  /** False when the surface mutates without the generation lease guard. */
  readonly guarded: boolean
  readonly leaseOutcome: 'granted' | 'denied'
  /** Compact per-argument type tags, never live object references. */
  readonly argsSignature: readonly string[]
  /** Coordinate/entity/packet instance extracted from the arguments. */
  readonly instanceHint: string | null
}

export type MutationObserver = (observation: MutationObservation) => void

/**
 * Bot methods that change client/server state but are HOST lifecycle, not
 * generation actuation (`respawn` after death, client `setSettings`). They are
 * observed without a lease assert so the kernel journal still sees them; each
 * observation is recorded as unguarded evidence.
 */
export const OBSERVED_UNGUARDED_BOT_METHODS: ReadonlySet<string> = new Set<string>([
  'respawn',
  'setSettings',
])

/** Bot methods whose promise resolves to a live Mineflayer window. */
const WINDOW_RETURNING_BOT_METHODS: ReadonlySet<string> = new Set<string>([
  'openBlock',
  'openContainer',
  'openFurnace',
  'openEnchantmentTable',
  'openVillager',
  'openAnvil',
])

/**
 * Window methods that move items or close the window. They write through the
 * raw client captured inside the Mineflayer window object, so the bot proxy
 * alone cannot see them: every window returned by a guarded `bot.open*` is
 * itself wrapped.
 */
export const MUTATING_WINDOW_METHODS: ReadonlySet<string> = new Set<string>([
  'withdraw',
  'deposit',
  'putInput',
  'putFuel',
  'takeInput',
  'takeFuel',
  'takeOutput',
  'close',
])

/** Bot fields whose direct assignment changes live physics state. */
export const MUTATING_BOT_FIELDS: ReadonlySet<string> = new Set<string>(['physicsEnabled'])

/** Compact per-argument signature for mutation evidence; reads properties, never calls methods. */
function mutationArgsSignature(args: readonly unknown[]): readonly string[] {
  return args.map((arg) => {
    if (arg === null) return 'null'
    if (arg === undefined) return 'undefined'
    const type = typeof arg
    if (type === 'string') return `string:${(arg as string).slice(0, 64)}`
    if (type === 'number' || type === 'boolean' || type === 'bigint') return `${type}:${String(arg)}`
    if (type === 'function') return 'function'
    if (Array.isArray(arg)) return `array[${arg.length}]`
    if (type === 'object') {
      const record = arg as Record<string, unknown>
      const position = record.position as Record<string, unknown> | undefined
      if (
        position !== null && position !== undefined && typeof position === 'object' &&
        typeof position.x === 'number' && typeof position.y === 'number' && typeof position.z === 'number'
      ) {
        const name = typeof record.name === 'string' ? `:${record.name}` : ''
        return `block${name}@${position.x},${position.y},${position.z}`
      }
      if (typeof record.id === 'number' || typeof record.id === 'string') return `entity#${String(record.id)}`
      if (typeof record.x === 'number' && typeof record.y === 'number' && typeof record.z === 'number') {
        return `vec3(${record.x},${record.y},${record.z})`
      }
      return 'object'
    }
    return type
  })
}

/**
 * Best-effort mutation instance from the raw arguments: a block coordinate for
 * block ops, an entity id for entity ops, the packet name for `_client.write`.
 */
function mutationInstanceHint(surface: string, args: readonly unknown[]): string | null {
  const first = args[0]
  if (surface === '_client.write') return typeof first === 'string' ? first : null
  if (first !== null && typeof first === 'object') {
    const record = first as Record<string, unknown>
    const position = record.position as Record<string, unknown> | undefined
    if (
      position !== null && position !== undefined && typeof position === 'object' &&
      typeof position.x === 'number' && typeof position.y === 'number' && typeof position.z === 'number'
    ) {
      return `${position.x},${position.y},${position.z}`
    }
    if (typeof record.id === 'number' || typeof record.id === 'string') return String(record.id)
  }
  return null
}

const TRACKED_EMITTER_METHODS = new Set<string>(['on', 'once', 'addListener', 'prependListener', 'prependOnceListener'])
const UNTRACKED_EMITTER_METHODS = new Set<string>(['removeListener', 'off', 'removeAllListeners'])

function wrapEmitterResources(target: object, resources: GenerationResources): object {
  return new Proxy(target, {
    get(inner, prop, receiver): unknown {
      const value = Reflect.get(inner, prop, receiver) as unknown
      if (typeof prop !== 'string' || typeof value !== 'function') return value
      if (TRACKED_EMITTER_METHODS.has(prop)) {
        return (event: unknown, fn: unknown): unknown => {
          if (typeof event === 'string' && typeof fn === 'function') {
            resources.trackListener(inner as GenerationResourceTarget, event, fn as (...args: unknown[]) => void)
          }
          return (value as (...args: unknown[]) => unknown).apply(inner, [event, fn])
        }
      }
      if (prop === 'removeListener' || prop === 'off') {
        return (event: unknown, fn: unknown): unknown => {
          if (typeof event === 'string' && typeof fn === 'function') {
            resources.untrackListener(inner as GenerationResourceTarget, event, fn as (...args: unknown[]) => void)
          }
          return (value as (...args: unknown[]) => unknown).apply(inner, [event, fn])
        }
      }
      if (prop === 'removeAllListeners') {
        return (event?: unknown): unknown => {
          resources.untrackAll(inner as GenerationResourceTarget, typeof event === 'string' ? event : undefined)
          return (value as (...args: unknown[]) => unknown).apply(inner, [event])
        }
      }
      return value
    },
  })
}

/**
 * #38: nested capabilities that can actuate WITHOUT passing through the
 * top-level mutator set. Each is wrapped by `withActuationLease` so a stale
 * generation is denied at the capability boundary, not only at `bot.*`.
 */
export const NESTED_ACTUATION_CAPABILITIES: ReadonlySet<string> = new Set<string>([
  '_client', // raw protocol write: bot._client.write('position_look', ...)
  'collectBlock', // mineflayer-collectblock: collect() drives pathfinder/body
  'entity', // direct shared-state mutation: entity.position.set / entity.yaw =
])

/**
 * Vec3 methods that MUTATE the receiver. Read-only projections (`clone`,
 * `offset`, `distanceTo`, `floored`, ...) are deliberately NOT guarded: a stale
 * generation may still compute, it just may not mutate shared authoritative
 * state. Derived from `vec3@0.1.x` (`index.d.ts` `this`-returning methods).
 */
export const MUTATING_VEC3_METHODS: ReadonlySet<string> = new Set<string>([
  'set',
  'update',
  'round',
  'floor',
  'translate',
  'add',
  'subtract',
  'multiply',
  'divide',
  'scale',
])

/** Entity fields whose direct assignment mutates shared live state. */
export const MUTATING_ENTITY_FIELDS: ReadonlySet<string> = new Set<string>(['yaw', 'pitch', 'onGround'])

/** Env flag for the dev-only strict surface check (`BUDDY_STRICT_ACTUATION=1`). */
export const STRICT_ACTUATION_ENV = 'BUDDY_STRICT_ACTUATION'

/**
 * Proxies produced by the lease wrapper. `assertActuationSurfaceCovered` uses
 * this to prove the actuator layer is holding guarded objects, not the raw bot.
 */
const GUARDED_OBJECTS = new WeakSet<object>()

/**
 * Build a lease assertion that LOGS the denial (`LEASE_DENIED`) before
 * rethrowing the `ACTUATION_LEASE_DENIED` error, so a denied bypass is always
 * visible in the acceptance log.
 */
function makeLeaseAssert(lease: ActuationLease, id: string, log?: LeaseLog): (what: string) => void {
  return (what: string): void => {
    try {
      lease.assertActive(id, what)
    } catch (error) {
      const owner = lease.activeId.length === 0 ? 'none' : lease.activeId
      log?.('LEASE_DENIED', { what, caller: id, owner })
      throw error
    }
  }
}

/**
 * Wrap a bot so every side-effecting call asserts this generation's lease first.
 * When `resources` is supplied, the same proxy records every listener the
 * generation registers (and unregisters) on the bot and its inventory, so the
 * host can remove them all on disposal (#49).
 *
 * Used by `generation-entry.ts`; exported here so the lease denial can be tested
 * against the real actuator without a live connection.
 *
 * #38: nested capabilities (`_client`, `collectBlock`, `entity`) are wrapped too,
 * because a denylist over the top-level surface let a stale generation reach
 * `bot._client.write`, `bot.collectBlock.collect` and `bot.entity.position.set`
 * without a lease assertion.
 */
export function withActuationLease(
  bot: Bot,
  lease: ActuationLease,
  id: string,
  resources?: GenerationResources,
  log?: LeaseLog,
  observe?: MutationObserver,
): Bot {
  const assert = makeLeaseAssert(lease, id, log)
  // Every mutation dispatch at this boundary is reported to the kernel
  // authority session as attribution evidence. Observation itself never gates
  // the call (the lease assert does); a thrown observer is impossible by
  // contract but still contained so an observer bug cannot change actuation.
  const see = (surface: string, guarded: boolean, leaseOutcome: 'granted' | 'denied', args: readonly unknown[]): void => {
    if (observe === undefined) return
    try {
      observe({ surface, guarded, leaseOutcome, argsSignature: mutationArgsSignature(args), instanceHint: mutationInstanceHint(surface, args) })
    } catch {
      // The observer must never break actuation.
    }
  }
  let pathfinderProxy: object | null = null
  let inventoryProxy: object | null = null
  let clientProxy: object | null = null
  let collectBlockProxy: object | null = null
  let entityProxy: object | null = null
  let positionProxy: object | null = null
  let positionTarget: object | null = null
  let velocityProxy: object | null = null
  let velocityTarget: object | null = null
  const trackedBot = resources === undefined ? null : wrapEmitterResources(bot, resources)

  const guardPosition = (position: object): object => {
    // prismarine-physics `apply()` REPLACES `entity.position` with a fresh Vec3
    // every tick (prismarine-physics/index.js: `bot.entity.position = this.pos`,
    // where `this.pos` is cloned in the PlayerState constructor) instead of
    // mutating the existing Vec3 in place. A proxy cached across that
    // replacement would keep wrapping the launch Vec3, so every guarded read
    // (`bot.entity.position.y` in the executor) would observe a frozen position
    // while `entity.velocity` - replaced on the same `apply()` call but never
    // proxied - kept advancing. Rebuild the proxy whenever the underlying Vec3
    // is no longer the one it wraps; keep the previous proxy while the object is
    // stable (the in-place `position.set(...)` path).
    if (positionProxy !== null && positionTarget === position) return positionProxy
    positionTarget = position
    positionProxy = new Proxy(position, {
      get(vTarget, vProp, vRecv): unknown {
        const vValue = Reflect.get(vTarget, vProp, vRecv) as unknown
        if (typeof vProp === 'string' && typeof vValue === 'function' && MUTATING_VEC3_METHODS.has(vProp)) {
          return (...args: unknown[]): unknown => {
            try {
              assert(`bot.entity.position.${vProp}`)
            } catch (error) {
              see(`entity.position.${vProp}`, true, 'denied', args)
              throw error
            }
            see(`entity.position.${vProp}`, true, 'granted', args)
            return (vValue as (...a: unknown[]) => unknown).apply(vTarget, args)
          }
        }
        return vValue
      },
    })
    GUARDED_OBJECTS.add(positionProxy)
    return positionProxy
  }

  const guardVelocity = (velocity: object): object => {
    // Same replace-per-tick semantics as `entity.position` (see guardPosition).
    if (velocityProxy !== null && velocityTarget === velocity) return velocityProxy
    velocityTarget = velocity
    const guardAxisOrMethod = (what: string, args: readonly unknown[]): void => {
      try {
        assert(`bot.entity.velocity.${what}`)
      } catch (error) {
        see(`entity.velocity.${what}`, true, 'denied', args)
        throw error
      }
      see(`entity.velocity.${what}`, true, 'granted', args)
    }
    velocityProxy = new Proxy(velocity, {
      get(vTarget, vProp, vRecv): unknown {
        const vValue = Reflect.get(vTarget, vProp, vRecv) as unknown
        if (typeof vProp === 'string' && typeof vValue === 'function' && MUTATING_VEC3_METHODS.has(vProp)) {
          return (...args: unknown[]): unknown => {
            guardAxisOrMethod(vProp, args)
            return (vValue as (...a: unknown[]) => unknown).apply(vTarget, args)
          }
        }
        return vValue
      },
      set(vTarget, vProp, vValue, vRecv): boolean {
        if (vProp === 'x' || vProp === 'y' || vProp === 'z') guardAxisOrMethod(vProp, [vValue])
        return Reflect.set(vTarget, vProp, vValue, vRecv)
      },
    })
    GUARDED_OBJECTS.add(velocityProxy)
    return velocityProxy
  }

  const guardEntity = (entity: object): object => {
    if (entityProxy !== null) return entityProxy
    entityProxy = new Proxy(entity, {
      get(eTarget, eProp, eRecv): unknown {
        const eValue = Reflect.get(eTarget, eProp, eRecv) as unknown
        if (eProp === 'position' && eValue !== null && typeof eValue === 'object') return guardPosition(eValue)
        if (eProp === 'velocity' && eValue !== null && typeof eValue === 'object') return guardVelocity(eValue)
        return eValue
      },
      set(eTarget, eProp, eValue, eRecv): boolean {
        if (typeof eProp === 'string' && MUTATING_ENTITY_FIELDS.has(eProp)) {
          try {
            assert(`bot.entity.${eProp}`)
          } catch (error) {
            see(`entity.${eProp}`, true, 'denied', [eValue])
            throw error
          }
          see(`entity.${eProp}`, true, 'granted', [eValue])
        }
        return Reflect.set(eTarget, eProp, eValue, eRecv)
      },
    })
    GUARDED_OBJECTS.add(entityProxy)
    return entityProxy
  }

  const guardWindow = (window: unknown): unknown => {
    if (window === null || typeof window !== 'object') return window
    const proxy = new Proxy(window, {
      get(wTarget, wProp, wRecv): unknown {
        const wValue = Reflect.get(wTarget, wProp, wRecv) as unknown
        if (typeof wProp === 'string' && typeof wValue === 'function' && MUTATING_WINDOW_METHODS.has(wProp)) {
          return (...args: unknown[]): unknown => {
            try {
              assert(`window.${wProp}`)
            } catch (error) {
              see(`window.${wProp}`, true, 'denied', args)
              throw error
            }
            see(`window.${wProp}`, true, 'granted', args)
            return (wValue as (...a: unknown[]) => unknown).apply(wTarget, args)
          }
        }
        return wValue
      },
    })
    GUARDED_OBJECTS.add(proxy)
    return proxy
  }

  const guarded = new Proxy(bot, {
    set(target, prop, value, receiver): boolean {
      if (typeof prop === 'string' && MUTATING_BOT_FIELDS.has(prop)) {
        try {
          assert(`bot.${prop}`)
        } catch (error) {
          see(`bot.${prop}`, true, 'denied', [value])
          throw error
        }
        see(`bot.${prop}`, true, 'granted', [value])
      }
      return Reflect.set(target, prop, value, receiver)
    },
    get(target, prop, receiver): unknown {
      const value = Reflect.get(target, prop, receiver) as unknown
      if (trackedBot !== null && typeof prop === 'string' && (TRACKED_EMITTER_METHODS.has(prop) || UNTRACKED_EMITTER_METHODS.has(prop))) {
        return Reflect.get(trackedBot, prop, receiver) as unknown
      }
      if (resources !== undefined && prop === 'inventory' && value !== null && typeof value === 'object') {
        if (inventoryProxy === null) inventoryProxy = wrapEmitterResources(value, resources)
        return inventoryProxy
      }
      if (typeof prop === 'string' && typeof value === 'function' && MUTATING_BOT_METHODS.has(prop)) {
        return (...args: unknown[]): unknown => {
          try {
            assert(`bot.${prop}`)
          } catch (error) {
            see(`bot.${prop}`, true, 'denied', args)
            throw error
          }
          see(`bot.${prop}`, true, 'granted', args)
          const result = (value as (...a: unknown[]) => unknown).apply(target, args)
          if (WINDOW_RETURNING_BOT_METHODS.has(prop) && result !== null && typeof result === 'object' && typeof (result as { then?: unknown }).then === 'function') {
            return (result as Promise<unknown>).then(guardWindow)
          }
          return result
        }
      }
      if (typeof prop === 'string' && typeof value === 'function' && OBSERVED_UNGUARDED_BOT_METHODS.has(prop)) {
        // HOST lifecycle surface: observed without a lease assert and recorded
        // as unguarded evidence.
        return (...args: unknown[]): unknown => {
          see(`bot.${prop}`, false, 'granted', args)
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
                  try {
                    assert(`pathfinder.${String(pfProp)}`)
                  } catch (error) {
                    see(`pathfinder.${String(pfProp)}`, true, 'denied', args)
                    throw error
                  }
                  see(`pathfinder.${String(pfProp)}`, true, 'granted', args)
                  return (pfValue as (...a: unknown[]) => unknown).apply(pfTarget, args)
                }
              }
              return pfValue
            },
          })
          GUARDED_OBJECTS.add(pathfinderProxy)
        }
        return pathfinderProxy
      }
      // #38 raw protocol writes (packet stepper).
      if (prop === '_client' && value !== null && typeof value === 'object') {
        if (clientProxy === null) {
          clientProxy = new Proxy(value, {
            get(cTarget, cProp, cRecv): unknown {
              const cValue = Reflect.get(cTarget, cProp, cRecv) as unknown
              if (cProp === 'write' && typeof cValue === 'function') {
                return (...args: unknown[]): unknown => {
                  try {
                    assert('bot._client.write')
                  } catch (error) {
                    see('_client.write', true, 'denied', args)
                    throw error
                  }
                  see('_client.write', true, 'granted', args)
                  return (cValue as (...a: unknown[]) => unknown).apply(cTarget, args)
                }
              }
              return cValue
            },
          })
          GUARDED_OBJECTS.add(clientProxy)
        }
        return clientProxy
      }
      // #38 plugin capability (mineflayer-collectblock).
      if (prop === 'collectBlock' && value !== null && typeof value === 'object') {
        if (collectBlockProxy === null) {
          collectBlockProxy = new Proxy(value, {
            get(cbTarget, cbProp, cbRecv): unknown {
              const cbValue = Reflect.get(cbTarget, cbProp, cbRecv) as unknown
              if (cbProp === 'collect' && typeof cbValue === 'function') {
                return (...args: unknown[]): unknown => {
                  try {
                    assert('bot.collectBlock.collect')
                  } catch (error) {
                    see('collectBlock.collect', true, 'denied', args)
                    throw error
                  }
                  see('collectBlock.collect', true, 'granted', args)
                  return (cbValue as (...a: unknown[]) => unknown).apply(cbTarget, args)
                }
              }
              return cbValue
            },
          })
          GUARDED_OBJECTS.add(collectBlockProxy)
        }
        return collectBlockProxy
      }
      // #38 direct shared-state mutation (entity.position.set / entity.yaw =).
      if (prop === 'entity' && value !== null && typeof value === 'object') return guardEntity(value)
      return value
    },
  }) as Bot
  GUARDED_OBJECTS.add(guarded)
  return guarded
}

// ---------------------------------------------------------------------------
// #38 allowlist ActuationPort
// ---------------------------------------------------------------------------

/** The raw (or guarded) bot surface the port delegates to. Structural, not `any`. */
interface ActuationDelegate {
  entity?: { position: { set(x: number, y: number, z: number): unknown }; yaw: number; pitch: number; onGround: boolean }
  pathfinder?: { setGoal(goal: unknown): void; stop(): void }
  collectBlock?: { collect(entity: unknown, options?: unknown): Promise<unknown> }
  _client?: { write(name: string, payload: Record<string, unknown>): boolean }
  setControlState?: (control: string, state: boolean) => void
  clearControlStates?: () => void
  lookAt?: (point: unknown, force?: boolean) => Promise<void>
  dig?: (block: unknown, forceLook?: 'ignore') => Promise<void>
  placeBlock?: (refBlock: unknown, face: unknown) => Promise<void>
  activateItem?: (offhand?: boolean) => Promise<void>
  activateBlock?: (block: unknown, face?: unknown) => Promise<void>
  equip?: (item: unknown, destination?: unknown) => Promise<void>
  craft?: (recipe: unknown, count?: number, craftingTable?: unknown) => Promise<void>
  openBlock?: (block: unknown, face?: unknown) => Promise<unknown>
  registry?: { itemsByName?: Record<string, { id?: number }> }
  currentWindow?: {
    inventoryStart?: number
    itemsRange?: (start: number, end: number) => Array<{ name: string; type: number; count: number }>
    withdraw?: (itemType: number, metadata: number | null, count: number) => Promise<unknown>
  } | null
}

/** Fail closed when an allowlisted actuator primitive is missing on the bot. */
function requiredMethod<T>(value: T | undefined, what: string): T {
  if (typeof value !== 'function') throw new Error(`ACTUATION_PORT_MISSING method=${what}`)
  return value
}

/**
 * Build the allowlist capability the generation actuates through. Every method
 * asserts the lease BEFORE the side effect, then delegates to the (leased) bot.
 *
 * There is deliberately no method that returns the raw bot / `_client` /
 * `collectBlock` / `entity`: the bypasses closed in #38 are only reachable via
 * the guarded primitives below (`writeMovementPacket`, `setPose`, `collect`).
 */
export function createActuationPort(bot: Bot, lease: ActuationLease, id: string, log?: LeaseLog, observe?: MutationObserver): ActuationPort {
  const assert = makeLeaseAssert(lease, id, log)
  const see = (surface: string, args: readonly unknown[]): void => {
    if (observe === undefined) return
    try {
      observe({ surface, guarded: true, leaseOutcome: 'granted', argsSignature: mutationArgsSignature(args), instanceHint: mutationInstanceHint(surface, args) })
    } catch {
      // The observer must never break actuation.
    }
  }
  const delegate = bot as unknown as ActuationDelegate
  return {
    generationId: id,
    assertLease: (what: string): void => assert(what),
    pathTo: (goal: unknown): void => {
      assert('port.pathTo')
      requiredMethod(delegate.pathfinder?.setGoal, 'pathfinder.setGoal').call(delegate.pathfinder, goal)
    },
    stopPath: (): void => {
      assert('port.stopPath')
      requiredMethod(delegate.pathfinder?.stop, 'pathfinder.stop').call(delegate.pathfinder)
    },
    setControls: (controls: Record<string, boolean>): void => {
      assert('port.setControls')
      const setControlState = requiredMethod(delegate.setControlState, 'setControlState')
      for (const [control, state] of Object.entries(controls)) setControlState.call(delegate, control, state)
    },
    clearControls: (): void => {
      assert('port.clearControls')
      requiredMethod(delegate.clearControlStates, 'clearControlStates').call(delegate)
    },
    lookAt: (point, force): Promise<void> => {
      assert('port.lookAt')
      return requiredMethod(delegate.lookAt, 'lookAt').call(delegate, point, force)
    },
    dig: (block, forceLook): Promise<void> => {
      assert('port.dig')
      return requiredMethod(delegate.dig, 'dig').call(delegate, block, forceLook)
    },
    placeBlock: (refBlock, face): Promise<void> => {
      assert('port.placeBlock')
      return requiredMethod(delegate.placeBlock, 'placeBlock').call(delegate, refBlock, face)
    },
    activateItem: (offhand): Promise<void> => {
      assert('port.activateItem')
      return requiredMethod(delegate.activateItem, 'activateItem').call(delegate, offhand)
    },
    activateBlock: (block, face): Promise<void> => {
      assert('port.activateBlock')
      return requiredMethod(delegate.activateBlock, 'activateBlock').call(delegate, block, face)
    },
    equip: (item, destination): Promise<void> => {
      assert('port.equip')
      return requiredMethod(delegate.equip, 'equip').call(delegate, item, destination)
    },
    collect: (entity, options): Promise<unknown> => {
      assert('port.collect')
      const collect = requiredMethod(delegate.collectBlock?.collect, 'collectBlock.collect')
      return collect.call(delegate.collectBlock, entity, options)
    },
    craft: (recipe, count, craftingTable): Promise<void> => {
      assert('port.craft')
      return requiredMethod(delegate.craft, 'craft').call(delegate, recipe, count, craftingTable)
    },
    openContainer: (block, face): Promise<unknown> => {
      assert('port.openContainer')
      return requiredMethod(delegate.openBlock, 'openBlock').call(delegate, block, face)
    },
    withdrawFromContainer: (itemName, count): Promise<unknown> => {
      // The lease is asserted at the TRANSFER, not only at the open: the window
      // object's own `withdraw` reaches `bot._client.write` directly and is not
      // covered by `MUTATING_BOT_METHODS`, which is exactly the #38 nested
      // actuation bypass this port operation exists to close.
      assert('port.withdrawFromContainer')
      const window = delegate.currentWindow
      if (window === null || window === undefined) {
        throw new Error('ACTUATION_PORT_MISSING method=currentWindow (no container window is open)')
      }
      const withdraw = requiredMethod(window.withdraw, 'currentWindow.withdraw')
      // `window.withdraw` reaches the raw client captured inside the Mineflayer
      // window object, so the guarded-bot proxy never sees the physical write.
      // The port is the semantic dispatch boundary: report the bypass-level
      // mutation here so the kernel mutation evidence has complete coverage.
      see('window.withdraw', [itemName, count])
      const slots =
        typeof window.itemsRange === 'function' && typeof window.inventoryStart === 'number'
          ? window.itemsRange(0, window.inventoryStart)
          : []
      // mineflayer's withdraw takes a NUMERIC item id (inventory.js:275-305). The
      // open window's own container slots already carry it, so the id is read
      // from the live stack and never guessed from a name.
      const live = slots.find((stack) => stack.name === itemName && stack.count > 0)
      const type = live?.type ?? delegate.registry?.itemsByName?.[itemName]?.id
      if (typeof type !== 'number') {
        throw new Error(`ACTUATION_PORT_UNKNOWN_ITEM item=${itemName}`)
      }
      return withdraw.call(window, type, null, count)
    },
    writeMovementPacket: (name: string, payload: Record<string, unknown>): void => {
      assert('port.writeMovementPacket')
      const write = requiredMethod(delegate._client?.write, '_client.write')
      write.call(delegate._client, name, payload)
    },
    setPose: (pose: ActuationPose): void => {
      assert('port.setPose')
      const entity = delegate.entity
      if (entity === undefined) throw new Error('ACTUATION_PORT_MISSING method=entity')
      if (pose.yaw !== undefined) entity.yaw = pose.yaw
      if (pose.pitch !== undefined) entity.pitch = pose.pitch
      if (pose.onGround !== undefined) entity.onGround = pose.onGround
      entity.position.set(pose.x, pose.y, pose.z)
    },
  }
}

/** True when `candidate` is a bot returned by `withActuationLease`. */
export function isLeasedBot(candidate: object): boolean {
  return GUARDED_OBJECTS.has(candidate)
}

export interface ActuationSurfaceReport {
  ok: boolean
  /** uncovered surfaces, e.g. `bot(not-leased-proxy)` or `bot._client` */
  uncovered: string[]
}

/**
 * Dev-only check (#38): prove the actuator layer holds a LEASED bot whose known
 * nested actuation capabilities are all guarded. Flags:
 *   - passing the raw bot instead of the `withActuationLease` proxy
 *   - a nested capability that was returned unguarded (a future denylist hole)
 *
 * Non-strict mode logs `ACTUATION_SURFACE_CHECK`. Strict mode
 * (`BUDDY_STRICT_ACTUATION=1`) throws `ACTUATION_SURFACE_UNCOVERED`, so CI/dev
 * can turn the flag into a hard gate without touching production behaviour.
 */
export function assertActuationSurfaceCovered(candidate: unknown, log?: LeaseLog): ActuationSurfaceReport {
  const uncovered: string[] = []
  if (candidate === null || typeof candidate !== 'object') {
    uncovered.push('bot(not-an-object)')
  } else if (!GUARDED_OBJECTS.has(candidate)) {
    uncovered.push('bot(not-leased-proxy)')
  } else {
    const holder = candidate as unknown as Record<string, unknown>
    for (const name of NESTED_ACTUATION_CAPABILITIES) {
      const value = holder[name]
      if (value === null || value === undefined) continue
      if ((typeof value === 'object' || typeof value === 'function') && !GUARDED_OBJECTS.has(value)) {
        uncovered.push(`bot.${name}`)
      }
    }
  }
  const report: ActuationSurfaceReport = { ok: uncovered.length === 0, uncovered }
  if (!report.ok) {
    if (process.env[STRICT_ACTUATION_ENV] === '1') {
      throw new Error(
        `ACTUATION_SURFACE_UNCOVERED uncovered=${uncovered.join(',')} - refusing to run with an unguarded nested actuation capability`,
      )
    }
    log?.('ACTUATION_SURFACE_CHECK', { ok: false, uncovered })
  }
  return report
}
