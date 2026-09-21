// scheduler.ts - the EVENT-DRIVEN decision scheduler.
//
// Jev is NOT called on a fixed period. A decision is requested by world events,
// with a maximum heartbeat as the fallback:
//
//     block_broken · path_completed (arrival at target) · mob_appeared ·
//     damage_taken · hp_changed · inventory_changed · action_completed ·
//     action_timeout · path_stuck · path_no_path
//     ─────────────────────────────────────────────────────────────────────
//     heartbeat (<= 3000 ms)  - only fires while the agent is idle
//
// While the bot walks three seconds to a tree, no event fires and the heartbeat
// is suppressed because an action is in flight: the same question is asked
// once, not six times. The controller owns the "action in flight" knowledge and
// decides whether a trigger runs, defers, or is dropped; this class only turns
// bot events into named triggers.
import type { Bot } from 'mineflayer'
import type { Block } from 'prismarine-block'
import type { Entity } from 'prismarine-entity'
import type { EventLogger } from './jev.ts'
import { isHostileEntityName } from './state.ts'

export const DECISION_TRIGGERS = [
  'start',
  'heartbeat',
  'block_broken',
  'path_completed',
  'mob_appeared',
  'damage_taken',
  'hp_changed',
  'inventory_changed',
  'action_completed',
  'action_timeout',
  'path_stuck',
  'path_no_path',
  'llm_plan',
] as const

export type DecisionTrigger = (typeof DECISION_TRIGGERS)[number]

/**
 * A newly spawned hostile can change the immediate safety calculus only when
 * it is close enough to become an actionable threat.  The sensor still sees
 * farther entities on the next decision, but their spawn notification must
 * not cancel a long-running goal action from across the world.
 */
export const MOB_REACTION_RANGE = 8

export type PositionLike = { x: number; y: number; z: number }

/**
 * Unknown positions fail open: when the distance cannot be established, keep
 * the safety interrupt rather than silently suppressing it.
 */
export function mobAppearanceIsNear(
  observer: PositionLike | null | undefined,
  mob: PositionLike,
  maxDistance = MOB_REACTION_RANGE,
): boolean {
  if (
    observer === null ||
    observer === undefined ||
    !Number.isFinite(observer.x) ||
    !Number.isFinite(observer.y) ||
    !Number.isFinite(observer.z) ||
    !Number.isFinite(mob.x) ||
    !Number.isFinite(mob.y) ||
    !Number.isFinite(mob.z)
  ) {
    return true
  }
  return Math.hypot(observer.x - mob.x, observer.y - mob.y, observer.z - mob.z) <= maxDistance
}

/**
 * Triggers that may preempt an in-flight action because they can change the
 * safety calculus mid-action (mob appeared, taken damage, health changed). The
 * rest - arrival, block broken, inventory change, action completion, path
 * failure, a new LLM plan - coalesce and are deferred until the action finishes,
 * which is what stops Jev being re-asked during a long walk.
 */
export const PREEMPTIVE_TRIGGERS: ReadonlySet<DecisionTrigger> = new Set<DecisionTrigger>([
  'mob_appeared',
  'damage_taken',
  'hp_changed',
  'action_timeout',
])

/**
 * An ATTACK lease is normally non-preemptive so Jev is not re-asked on every
 * hit.  Once health is critical, however, deferring the damage event can keep
 * the executor attacking until death.  This predicate is deliberately small
 * and pure so the safety exception is observable and testable.
 */
export function shouldInterruptAttackLease(
  trigger: DecisionTrigger,
  health: number,
  criticalHealth = 6,
): boolean {
  return (
    (trigger === 'damage_taken' || trigger === 'hp_changed') &&
    Number.isFinite(health) &&
    health <= criticalHealth
  )
}

/** Higher wins when a burst of triggers is coalesced; a critical trigger is never overwritten. */
export const TRIGGER_PRIORITY: Record<DecisionTrigger, number> = {
  damage_taken: 10,
  hp_changed: 9,
  mob_appeared: 8,
  path_stuck: 7,
  path_no_path: 7,
  action_timeout: 7,
  inventory_changed: 6,
  block_broken: 5,
  path_completed: 4,
  action_completed: 3,
  llm_plan: 3,
  start: 2,
  heartbeat: 1,
}

export interface TriggerEvent {
  trigger: DecisionTrigger
  detail: Record<string, unknown>
  ts: number
}

export interface SchedulerOptions {
  /** maximum time between decisions while idle (fallback only) */
  heartbeatMs: number
  /** which world events may request a decision */
  enabledTriggers: readonly DecisionTrigger[]
  /** coalescing window for bursty events (inventory slots etc.) */
  coalesceMs: number
}

export const defaultSchedulerOptions: SchedulerOptions = {
  heartbeatMs: 3000,
  enabledTriggers: DECISION_TRIGGERS,
  coalesceMs: 40,
}

/**
 * Process-lifetime count of observed world mutations, shared by every scheduler
 * instance. Module-scoped so a scheduler rebuild inside one generation can never
 * reset the revision under which a scan result was cached.
 */
let worldMutationCount = 0

export class DecisionScheduler {
  private readonly bot: Bot
  private readonly logger: EventLogger
  private readonly options: SchedulerOptions
  private readonly enabled: ReadonlySet<DecisionTrigger>

  private handler: ((event: TriggerEvent) => void) | null = null
  private heartbeatTimer: NodeJS.Timeout | null = null
  private coalesceTimer: NodeJS.Timeout | null = null
  private pendingTriggers = new Map<DecisionTrigger, TriggerEvent>()
  private started = false
  private lastHealth: number | null = null
  private lastFood: number | null = null
  /**
   * Whether this scheduler currently observes every world mutation. Both the
   * block-state listener and the chunk-column listeners must be attached before
   * the revision is a complete witness (see `worldRevision`).
   */
  private observesBlocks = false
  private observesChunks = false

  constructor(bot: Bot, logger: EventLogger, options: Partial<SchedulerOptions> = {}) {
    this.bot = bot
    this.logger = logger
    this.options = { ...defaultSchedulerOptions, ...options }
    this.enabled = new Set(this.options.enabledTriggers)
  }

  get heartbeatMs(): number {
    return this.options.heartbeatMs
  }

  get triggers(): readonly DecisionTrigger[] {
    return [...this.enabled]
  }

  /**
   * The exact world-mutation revision, or `null` when this scheduler does not
   * observe every world mutation. `null` means "no complete witness exists" and
   * every cache keyed on it must stay off.
   *
   * Mineflayer re-emits `blockUpdate`, `chunkColumnLoad` and `chunkColumnUnload`
   * from `bot.world` (`lib/plugins/blocks.js`), and every block packet path
   * (`multi_block_change`, `block_change`, explosion, digging feedback) reaches
   * `world.setBlockStateId`, which emits `blockUpdate`. Counting all three is
   * therefore a complete witness of "the bot's world model changed".
   */
  get worldRevision(): number | null {
    if (!this.observesBlocks || !this.observesChunks || !this.started) return null
    return worldMutationCount
  }

  onDecision(handler: (event: TriggerEvent) => void): void {
    this.handler = handler
  }

  /** Internal events (executor path phase / timeout / action result). */
  notify(trigger: DecisionTrigger, detail: Record<string, unknown> = {}): void {
    this.request(trigger, detail)
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.lastHealth = this.bot.health
    this.lastFood = this.bot.food
    if (this.enabled.has('block_broken')) {
      this.bot.on('blockUpdate', this.onBlockUpdate)
      this.observesBlocks = true
    }
    // Chunk load/unload are not decision triggers, but they do add/remove the
    // blocks a scan can see, so they must be part of the world revision.
    this.bot.on('chunkColumnLoad', this.onWorldChunkChange)
    this.bot.on('chunkColumnUnload', this.onWorldChunkChange)
    this.observesChunks = true
    if (this.enabled.has('path_completed')) this.bot.on('goal_reached', this.onGoalReached)
    if (this.enabled.has('mob_appeared')) this.bot.on('entitySpawn', this.onEntitySpawn)
    if (this.enabled.has('damage_taken')) this.bot.on('entityHurt', this.onEntityHurt)
    if (this.enabled.has('hp_changed')) this.bot.on('health', this.onHealth)
    if (this.enabled.has('inventory_changed')) {
      this.bot.on('playerCollect', this.onPlayerCollect)
      this.bot.inventory.on('updateSlot', this.onInventorySlot)
    }
    this.heartbeatTimer = setInterval(() => {
      this.request('heartbeat', {})
    }, this.options.heartbeatMs)
    this.request('start', { heartbeatMs: this.options.heartbeatMs, triggers: this.triggers })
  }

  stop(): void {
    if (!this.started) return
    this.started = false
    this.bot.removeListener('blockUpdate', this.onBlockUpdate)
    this.bot.removeListener('chunkColumnLoad', this.onWorldChunkChange)
    this.bot.removeListener('chunkColumnUnload', this.onWorldChunkChange)
    this.observesBlocks = false
    this.observesChunks = false
    this.bot.removeListener('goal_reached', this.onGoalReached)
    this.bot.removeListener('entitySpawn', this.onEntitySpawn)
    this.bot.removeListener('entityHurt', this.onEntityHurt)
    this.bot.removeListener('health', this.onHealth)
    this.bot.removeListener('playerCollect', this.onPlayerCollect)
    this.bot.inventory.removeListener('updateSlot', this.onInventorySlot)
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    this.clearPending()
    this.handler = null
  }

  private readonly onBlockUpdate = (oldBlock: Block | null, newBlock: Block): void => {
    // Counted before the trigger filter: the revision must witness every block
    // state change, not only the "block became air" ones this trigger wants.
    worldMutationCount += 1
    if (oldBlock === null || oldBlock.type === 0 || newBlock.type !== 0) return
    this.request('block_broken', {
      block: oldBlock.name,
      position: { x: oldBlock.position.x, y: oldBlock.position.y, z: oldBlock.position.z },
    })
  }

  private readonly onWorldChunkChange = (): void => {
    worldMutationCount += 1
  }

  private readonly onGoalReached = (): void => {
    this.request('path_completed', { source: 'goal_reached' })
  }

  private readonly onEntitySpawn = (entity: Entity): void => {
    const name = entity.username ?? entity.name ?? entity.kind ?? 'unknown'
    if (!isHostileEntityName(name, entity.kind ?? undefined)) return
    const position = { x: entity.position.x, y: entity.position.y, z: entity.position.z }
    const observer = this.bot.entity?.position
    const distance = observer === undefined ? null : observer.distanceTo(entity.position)
    const detail = {
      entity: name,
      id: entity.id,
      position,
      distance,
    }
    if (!mobAppearanceIsNear(observer, position)) {
      this.logger.info('scheduler', 'mob_appeared observed outside reaction range; action continues', detail)
      return
    }
    this.request('mob_appeared', detail)
  }

  private readonly onEntityHurt = (entity: Entity): void => {
    if (this.bot.entity === undefined || entity.id !== this.bot.entity.id) return
    this.request('damage_taken', { health: this.bot.health })
  }

  private readonly onHealth = (): void => {
    const health = this.bot.health
    const food = this.bot.food
    const previousHealth = this.lastHealth
    this.lastHealth = health
    this.lastFood = food
    if (previousHealth === null || health === previousHealth) return
    this.request('hp_changed', { health, previousHealth, food, delta: health - previousHealth })
  }

  private readonly onPlayerCollect = (collector: Entity, collected: Entity): void => {
    if (collector.id !== this.bot.entity?.id) return
    this.request('inventory_changed', { collected: collected.name ?? 'unknown', source: 'playerCollect' })
  }

  private readonly onInventorySlot = (slot: number, oldItem: { name: string; count: number } | null, newItem: { name: string; count: number } | null): void => {
    const before = oldItem === null ? null : `${oldItem.name}x${oldItem.count}`
    const after = newItem === null ? null : `${newItem.name}x${newItem.count}`
    if (before === after) return
    this.request('inventory_changed', { slot, before, after, source: 'updateSlot' })
  }

  private request(trigger: DecisionTrigger, detail: Record<string, unknown>): void {
    if (!this.enabled.has(trigger)) return
    if (this.handler === null) return
    const event: TriggerEvent = { trigger, detail, ts: Date.now() }
    if (trigger === 'heartbeat') {
      if (this.pendingTriggers.size > 0) return
      this.handler(event)
      return
    }
    if (trigger === 'start' || PREEMPTIVE_TRIGGERS.has(trigger)) {
      // Deliver immediately without duplicating into the coalesced set; any
      // already-queued lower-priority triggers survive and flush afterwards.
      this.handler(event)
      return
    }
    this.pendingTriggers.set(trigger, event)
    this.ensureCoalesceTimer()
  }

  private ensureCoalesceTimer(): void {
    if (this.coalesceTimer !== null) return
    this.coalesceTimer = setTimeout(() => {
      this.coalesceTimer = null
      this.flushPending()
    }, this.options.coalesceMs)
  }

  /** Deliver every coalesced trigger highest-priority first; none are dropped. */
  private flushPending(): void {
    while (this.pendingTriggers.size > 0) {
      let best: TriggerEvent | null = null
      for (const event of this.pendingTriggers.values()) {
        if (best === null || TRIGGER_PRIORITY[event.trigger] > TRIGGER_PRIORITY[best.trigger]) best = event
      }
      if (best === null) return
      this.pendingTriggers.delete(best.trigger)
      if (this.handler !== null) this.handler(best)
    }
  }

  private clearPending(): void {
    if (this.coalesceTimer !== null) {
      clearTimeout(this.coalesceTimer)
      this.coalesceTimer = null
    }
    this.pendingTriggers.clear()
  }
}
