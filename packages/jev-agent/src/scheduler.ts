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
import { Vec3 } from 'vec3'
import type { EventLogger } from './jev.ts'
import { observedAir } from './air.ts'
import { EYE_HEIGHT, isHostileEntityName, LOW_AIR_LEVEL, MAX_AIR, PROBE_FLUIDS } from './state.ts'

export const DECISION_TRIGGERS = [
  'start',
  'heartbeat',
  'block_broken',
  'path_completed',
  'mob_appeared',
  'damage_taken',
  'hp_changed',
  'low_air',
  'air_unknown_head_submerged',
  'inventory_changed',
  'action_completed',
  'action_timeout',
  'path_stuck',
  'path_no_path',
  'llm_plan',
  // Controller-internal request after a survival candidate vanished. This is
  // not new world evidence and must never carry damage_taken preemption.
  'survival_reground',
  'human_intent',
] as const

export type DecisionTrigger = (typeof DECISION_TRIGGERS)[number]

/**
 * A newly spawned hostile can change the immediate safety calculus only when
 * it is close enough to become an actionable threat.  The sensor still sees
 * farther entities on the next decision, but their spawn notification must
 * not cancel a long-running goal action from across the world.
 */
export const MOB_REACTION_RANGE = 8

/**
 * Exit band for the approach watch: a hostile counts as "near" only once, on
 * entry into `MOB_REACTION_RANGE`, and must leave past this distance before
 * a re-approach may fire again. Without the band a mob hovering at the
 * boundary flaps the trigger every other tick.
 */
export const MOB_APPROACH_EXIT_RANGE = MOB_REACTION_RANGE + 2

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
 * safety calculus mid-action (mob appeared, taken damage, health changed,
 * breath running out). The rest - arrival, block broken, inventory change,
 * action completion, path failure, a new LLM plan - coalesce and are deferred
 * until the action finishes, which is what stops Jev being re-asked during a
 * long walk.
 *
 * `low_air` is here because drowning is silent to every other trigger: the
 * measured death (2026-09-21T16:59:34.792Z) followed a salmon into water for
 * ~35s and only produced a `damage_taken` decision 3s before the body died.
 * Breath is lost BEFORE damage starts, so the safety calculus changes earlier
 * and the in-flight action must yield earlier. WHAT to do about it stays with
 * Jev; this only makes the fact able to interrupt.
 */
export const PREEMPTIVE_TRIGGERS: ReadonlySet<DecisionTrigger> = new Set<DecisionTrigger>([
  'mob_appeared',
  'damage_taken',
  'hp_changed',
  'low_air',
  'air_unknown_head_submerged',
  'action_timeout',
])

/**
 * An ATTACK lease is normally non-preemptive so Jev is not re-asked on every
 * hit. Once health is critical, however, deferring the damage event can keep
 * the executor attacking until death. This predicate is deliberately small
 * and pure so the safety exception is observable and testable.
 *
 * Running out of breath is the same class of exception and is NOT conditional
 * on health: the body can be at full health and still drown (measured
 * `ATTACK:e4698` followed a salmon down from y=62 to y=57 and the body died at
 * (67.5,58.3,28.5) with health 20 until the last seconds).
 */
export function shouldInterruptAttackLease(
  trigger: DecisionTrigger,
  health: number,
  criticalHealth = 6,
  air: number | null = null,
): boolean {
  if (trigger === 'air_unknown_head_submerged') return true
  if (trigger === 'low_air') {
    const observed = observedAir(air)
    return observed !== null && observed <= LOW_AIR_LEVEL
  }
  return (
    (trigger === 'damage_taken' || trigger === 'hp_changed') &&
    Number.isFinite(health) &&
    health <= criticalHealth
  )
}

/**
 * The controller's active-lease disposition for a preemptive safety trigger.
 * Kept pure so the exact branch that interrupts an in-flight ATTACK is
 * regression-tested alongside the scheduler edge that emits the trigger.
 */
export function shouldPreemptActiveActionLease(
  trigger: DecisionTrigger,
  actionKind: string,
  health: number,
  criticalHealth = 6,
  air: number | null = null,
): boolean {
  if (!PREEMPTIVE_TRIGGERS.has(trigger)) return false
  if (actionKind !== 'ATTACK') return true
  return shouldInterruptAttackLease(trigger, health, criticalHealth, air)
}

/**
 * A bounded RETREAT is already the selected safety response to damage. Restarting
 * it on each hit cancels the path before it can gain separation, then asks Jev the
 * same question against a nearly unchanged position. Defer only hit/health events
 * until this retreat's bounded Skill completes; its terminal/action event will
 * replay the freshest coalesced trigger and let Jev choose from the new state.
 * New-hostile and low-air signals remain able to interrupt.
 *
 * CRITICAL-HEALTH EXCEPTION (measured portal-p14, repeated portal-p16: 9/28
 * deaths landed under an in-flight RETREAT lease): the deferral exists to let a
 * retreat gain separation, but at critical health that trade inverts - one more
 * absorbed hit ends the body while the lease is still walking. This is the same
 * boundary `shouldInterruptAttackLease` already owns for ATTACK. Below it, the
 * hit is fresh safety evidence and preempts: Jev may pick a shorter disengage,
 * cover, eating, or fighting back - semantic continuity of ESCAPING survives in
 * the offer set; blind commitment to the stale destination does not.
 *
 * ABSORBED-HIT BUDGET (measured portal-p21, 2026-09-29): a faster mob at contact
 * range never lets a retreat gain separation at all. The spider case deferred
 * 6 hits across ~18 s while the threat stayed at 1.15 m (hp 17.8 -> 3.84 ->
 * death); the critical floor only woke the decision at 5.84, too late for any
 * response. The deferral premise - "this lease is buying separation" - is
 * falsified by every hit absorbed during it, so a lease defers at most
 * `RETREAT_DEFER_HIT_BUDGET` damage/hp events; the next hit preempts while the
 * body can still fight, pillar, or pick a shorter disengage.
 */
export const RETREAT_DEFER_HIT_BUDGET = 3

export function shouldDeferDamageDuringRetreatLease(
  trigger: DecisionTrigger,
  actionKind: string,
  health = Number.POSITIVE_INFINITY,
  criticalHealth = 6,
  absorbedHits = 0,
): boolean {
  return (
    actionKind === 'RETREAT' &&
    (trigger === 'damage_taken' || trigger === 'hp_changed') &&
    absorbedHits < RETREAT_DEFER_HIT_BUDGET &&
    !(Number.isFinite(health) && health <= criticalHealth)
  )
}

/**
 * Controller repairs are not fresh world evidence. If one is queued while a
 * bounded RETREAT is executing, let that lease complete and use its completion
 * to resense the world. Real damage/health changes are also held during this
 * already-selected escape, then replayed after completion at their normal
 * preemptive priority. Other preemptive safety signals keep their usual path.
 */
export function shouldDeferTriggerDuringRetreatLease(
  trigger: DecisionTrigger,
  actionKind: string,
  health = Number.POSITIVE_INFINITY,
  criticalHealth = 6,
  absorbedHits = 0,
): boolean {
  return (
    shouldDeferDamageDuringRetreatLease(trigger, actionKind, health, criticalHealth, absorbedHits) ||
    (actionKind === 'RETREAT' && trigger === 'survival_reground')
  )
}

/**
 * The scheduler-level survival fact. `layer=scheduler` names the owner of the
 * preemption (the sensor owns the air reading, the guard/executor own refusing
 * the mechanical action); the semantic response stays Jev's.
 */
export const LOW_AIR_PREEMPT = 'LOW_AIR_PREEMPT'

export function formatLowAirPreempt(air: number, position: { x: number; y: number; z: number } | null): string {
  const at = position === null ? 'unknown' : `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`
  return `${LOW_AIR_PREEMPT} layer=scheduler air=${air}/${MAX_AIR} threshold=${LOW_AIR_LEVEL} at=${at} -> preempt in-flight action`
}

/**
 * Remaining breath from the live bot. Missing or malformed metadata remains
 * unknown; only a measured low value can fire the preemptive trigger.
 */
function readAir(bot: Bot): number | null {
  return observedAir((bot as { oxygenLevel?: number }).oxygenLevel)
}

interface BreathPosition {
  readonly x: number
  readonly y: number
  readonly z: number
}

function breathPosition(bot: Bot): BreathPosition | null {
  try {
    const position = (bot.entity as unknown as { position?: Partial<BreathPosition> } | undefined)?.position
    if (
      position === undefined ||
      !Number.isFinite(position.x) ||
      !Number.isFinite(position.y) ||
      !Number.isFinite(position.z)
    ) return null
    return { x: position.x as number, y: position.y as number, z: position.z as number }
  } catch {
    return null
  }
}

function sampleBreathCell(bot: Bot, position: BreathPosition | null): Record<string, unknown> {
  if (position === null) return { provenance: 'unknown', blockName: null, samplePosition: null, reason: 'self_position_unavailable' }
  const samplePosition = { x: position.x, y: position.y, z: position.z }
  try {
    if (typeof bot.blockAt !== 'function') {
      return { provenance: 'unknown', blockName: null, samplePosition, reason: 'block_at_unavailable' }
    }
    const block = bot.blockAt(new Vec3(position.x, position.y, position.z))
    if (block === null) {
      return { provenance: 'unknown', blockName: null, samplePosition, reason: 'chunk_not_loaded_or_unobserved' }
    }
    return {
      provenance: 'loaded',
      blockName: typeof block.name === 'string' ? block.name : null,
      samplePosition,
    }
  } catch {
    return { provenance: 'unknown', blockName: null, samplePosition, reason: 'block_at_threw' }
  }
}

/** Read the self player's raw air_supply slot only when the registry names it. */
function sampleRawSelfAirMetadata(bot: Bot): Record<string, unknown> {
  try {
    const registry = (bot as unknown as {
      registry?: { entitiesByName?: Record<string, { metadataKeys?: unknown } | undefined> }
    }).registry
    const metadataKeys = registry?.entitiesByName?.player?.metadataKeys
    if (!Array.isArray(metadataKeys)) return { status: 'unknown', reason: 'player_metadata_keys_unavailable' }
    const index = metadataKeys.indexOf('air_supply')
    if (index < 0) return { status: 'unknown', reason: 'air_supply_metadata_key_unavailable' }
    const metadata = (bot.entity as unknown as { metadata?: unknown } | undefined)?.metadata
    if (metadata === null || typeof metadata !== 'object') {
      return { status: 'unknown', reason: 'self_entity_metadata_unavailable', metadataIndex: index }
    }
    const value = Reflect.get(metadata, String(index)) as unknown
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return { status: 'unknown', reason: 'self_air_supply_value_unavailable', metadataIndex: index }
    }
    return { status: 'observed', source: 'self-entity-metadata', key: 'air_supply', metadataIndex: index, value }
  } catch {
    return { status: 'unknown', reason: 'self_air_metadata_read_failed' }
  }
}

function breathDimension(bot: Bot): string | null {
  try {
    const dimension = (bot as unknown as { game?: { dimension?: unknown } }).game?.dimension
    return typeof dimension === 'string' ? dimension : null
  } catch {
    return null
  }
}

let schedulerInstanceSequence = 0

/** Higher wins when a burst of triggers is coalesced; a critical trigger is never overwritten. */export const TRIGGER_PRIORITY: Record<DecisionTrigger, number> = {
  damage_taken: 10,
  hp_changed: 9,
  low_air: 9,
  air_unknown_head_submerged: 9,
  mob_appeared: 8,
  path_stuck: 7,
  path_no_path: 7,
  action_timeout: 7,
  human_intent: 7,
  inventory_changed: 6,
  block_broken: 5,
  path_completed: 4,
  action_completed: 3,
  llm_plan: 3,
  // Real safety/progress events that arrive while ticking supersede this
  // lowest-priority controller repair request.
  survival_reground: 2,
  start: 2,
  heartbeat: 1,
}

export interface TriggerEvent {
  trigger: DecisionTrigger
  detail: Record<string, unknown>
  ts: number
}

/**
 * Complete an in-flight action before replaying a deferred trigger unless that
 * trigger carries a higher-priority fact. In particular, a stale
 * `survival_reground` request is superseded by the fresh action completion,
 * while actual damage remains queued for an immediate safety decision.
 */
export function selectPostActionTrigger(
  deferred: TriggerEvent | null,
  completion: TriggerEvent,
): TriggerEvent {
  return deferred !== null && TRIGGER_PRIORITY[deferred.trigger] > TRIGGER_PRIORITY[completion.trigger]
    ? deferred
    : completion
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
let worldBlockMutationCount = 0

export class DecisionScheduler {
  private readonly bot: Bot
  private readonly logger: EventLogger
  private readonly options: SchedulerOptions
  private readonly enabled: ReadonlySet<DecisionTrigger>
  private readonly schedulerInstanceId: string

  private handler: ((event: TriggerEvent) => void) | null = null
  private heartbeatTimer: NodeJS.Timeout | null = null
  private coalesceTimer: NodeJS.Timeout | null = null
  private pendingTriggers = new Map<DecisionTrigger, TriggerEvent>()
  private started = false
  private lastHealth: number | null = null
  private lastFood: number | null = null
  /** last low-air band (10/5/0) announced, so the breath trigger stays an edge */
  private lowAirBand: number | null = null
  /** whether the eyes are currently underwater while the breath sensor is unknown */
  private unknownAirHeadSubmerged = false
  /**
   * Whether this scheduler currently observes every world mutation. Both the
   * block-state listener and the chunk-column listeners must be attached before
   * the revision is a complete witness (see `worldRevision`).
   */
  private observesBlocks = false
  private observesChunks = false
  /**
   * The `damage_event` origin the server stated for the hit being delivered.
   *
   * Mineflayer's `entityHurt` carries only `(entity, source)`, so it DROPS the
   * packet's own `sourcePosition` field - the one fact that says where the
   * damage came from when the attacker is not in `bot.entities` at all (a ghast
   * beyond the entity radius, an ender dragon, any summoned/plugin entity).
   * Without it the body cannot ground a direction to move away from, and the
   * measured Nether deaths (`killer=ender_dragon killerEvidence=mineflayer`,
   * `sensed=false`) had no answer at all.
   *
   * Set from the packet listener immediately before `entityHurt` is emitted,
   * consumed once, and never derived from proximity or a mob's attack range.
   */
  private pendingDamageOrigin: { x: number; y: number; z: number } | null = null

  constructor(bot: Bot, logger: EventLogger, options: Partial<SchedulerOptions> = {}) {
    this.bot = bot
    this.logger = logger
    this.options = { ...defaultSchedulerOptions, ...options }
    this.enabled = new Set(this.options.enabledTriggers)
    schedulerInstanceSequence += 1
    this.schedulerInstanceId = `scheduler-${schedulerInstanceSequence.toString(36)}`
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

  /**
   * Exact observed block-state mutation revision, excluding chunk load/unload.
   * Chunk residency can change solely because a body moved while an async plan
   * was in flight; that is a new observation window, not a world edit. The
   * separately sensed block facts still fence newly discovered semantics.
   */
  get blockRevision(): number | null {
    if (!this.observesBlocks || !this.started) return null
    return worldBlockMutationCount
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
    if (this.enabled.has('mob_appeared')) {
      this.bot.on('entitySpawn', this.onEntitySpawn)
      this.bot.on('entityMoved', this.onEntityMoved)
      this.bot.on('entityGone', this.onEntityGone)
    }
    if (this.enabled.has('damage_taken')) {
      this.bot.on('entityHurt', this.onEntityHurt)
      // The packet's own origin, which mineflayer's `entityHurt` does not carry.
      // Guarded: `_client` is private API and a fixture double may not have one.
      this.client()?.on('damage_event', this.onDamageEvent)
    }
    if (this.enabled.has('hp_changed')) this.bot.on('health', this.onHealth)
    if (this.enabled.has('low_air')) this.bot.on('breath', this.onBreath)
    if (this.enabled.has('air_unknown_head_submerged')) this.bot.on('physicsTick', this.onPhysicsTick)
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
    this.bot.removeListener('entityMoved', this.onEntityMoved)
    this.bot.removeListener('entityGone', this.onEntityGone)
    this.nearHostileIds.clear()
    this.bot.removeListener('entityHurt', this.onEntityHurt)
    this.client()?.removeListener('damage_event', this.onDamageEvent)
    this.bot.removeListener('health', this.onHealth)
    this.bot.removeListener('breath', this.onBreath)
    this.bot.removeListener('physicsTick', this.onPhysicsTick)
    this.bot.removeListener('playerCollect', this.onPlayerCollect)
    this.bot.inventory.removeListener('updateSlot', this.onInventorySlot)
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    this.clearPending()
    this.unknownAirHeadSubmerged = false
    this.handler = null
  }

  private readonly onBlockUpdate = (oldBlock: Block | null, newBlock: Block): void => {
    // Counted before the trigger filter: the revision must witness every block
    // state change, not only the "block became air" ones this trigger wants.
    worldMutationCount += 1
    worldBlockMutationCount += 1
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
      this.nearHostileIds.delete(entity.id)
      return
    }
    // Mark the entry so an already-reported near hostile does not fire again
    // from `entityMoved` while it stays inside the band.
    this.nearHostileIds.add(entity.id)
    this.request('mob_appeared', detail)
  }

  /**
   * Hostile entity ids already reported inside `MOB_REACTION_RANGE`. An entry
   * fires `mob_appeared` exactly once until the entity leaves past
   * `MOB_APPROACH_EXIT_RANGE` or despawns, then it may re-approach again.
   */
  private readonly nearHostileIds = new Set<number>()

  /**
   * `entitySpawn` only evaluates distance AT spawn: a hostile that appeared
   * outside the reaction band ("action continues") and then walks in produced
   * no decision boundary until its first `damage_taken` - measured portal-p23
   * (zombie id 2213 closed >8m -> 2.06m during a 4s MINE; first signal was the
   * first hit; drowned id 1584 camped three consecutive respawns). The moved
   * event supplies the missing entry boundary: same trigger name, same
   * preempt class, `reason=approach` distinguishes the evidence. One entry per
   * band crossing; the hysteresis keeps boundary-hover from flapping it.
   */
  private readonly onEntityMoved = (entity: Entity): void => {
    const observer = this.bot.entity?.position
    const distance = observer === undefined ? null : observer.distanceTo(entity.position)
    if (this.nearHostileIds.has(entity.id)) {
      // Re-arm only on a clear exit; inside the hysteresis band the entity
      // keeps its "already reported" state so hovering cannot flap the trigger.
      if (distance !== null && distance > MOB_APPROACH_EXIT_RANGE) this.nearHostileIds.delete(entity.id)
      else return
    }
    const name = entity.username ?? entity.name ?? entity.kind ?? 'unknown'
    if (!isHostileEntityName(name, entity.kind ?? undefined)) return
    const position = { x: entity.position.x, y: entity.position.y, z: entity.position.z }
    if (distance !== null && distance > MOB_REACTION_RANGE) return
    this.nearHostileIds.add(entity.id)
    const detail = { entity: name, id: entity.id, position, distance, reason: 'approach' }
    this.logger.info('scheduler', 'mob_appeared entered reaction range by movement; decision requested', detail)
    this.request('mob_appeared', detail)
  }

  private readonly onEntityGone = (entity: Entity): void => {
    this.nearHostileIds.delete(entity.id)
  }

  /**
   * The private mineflayer client, or null when this bot double has none. Only
   * used to read the ONE packet field `entityHurt` drops (see
   * `pendingDamageOrigin`); never to write, and never required for the scheduler
   * to run.
   */
  private client(): { on: (event: string, handler: (packet: unknown) => void) => void; removeListener: (event: string, handler: (packet: unknown) => void) => void } | null {
    const client = (this.bot as unknown as { _client?: unknown })._client
    if (client === null || client === undefined) return null
    const candidate = client as { on?: unknown; removeListener?: unknown }
    if (typeof candidate.on !== 'function' || typeof candidate.removeListener !== 'function') return null
    return candidate as {
      on: (event: string, handler: (packet: unknown) => void) => void
      removeListener: (event: string, handler: (packet: unknown) => void) => void
    }
  }

  /**
   * SAFE: read the damage origin the server stated for an incoming hit.
   *
   * The 1.20+ `damage_event` packet is
   * `{entityId, sourceTypeId, sourceCauseId, sourceDirectId, sourcePosition}`.
   * `sourcePosition` is optional on the wire and is exactly what it says: the
   * position the damage came from when the server provides one. It is recorded
   * ONLY when all three components are finite; anything else leaves the origin
   * UNKNOWN, which the decision layer reports as a missing fact rather than
   * filling in a guess.
   */
  private readonly onDamageEvent = (packet: unknown): void => {
    this.pendingDamageOrigin = null
    if (typeof packet !== 'object' || packet === null) return
    const raw = (packet as { sourcePosition?: unknown }).sourcePosition
    if (typeof raw !== 'object' || raw === null) return
    const value = raw as { x?: unknown; y?: unknown; z?: unknown }
    if (typeof value.x !== 'number' || typeof value.y !== 'number' || typeof value.z !== 'number') return
    if (!Number.isFinite(value.x) || !Number.isFinite(value.y) || !Number.isFinite(value.z)) return
    this.pendingDamageOrigin = { x: value.x, y: value.y, z: value.z }
  }

  private readonly onEntityHurt = (entity: Entity | undefined, source?: Entity): void => {
    const origin = this.pendingDamageOrigin
    this.pendingDamageOrigin = null
    if (this.bot.entity === undefined || entity === undefined || entity.id !== this.bot.entity.id) return
    // Mineflayer's `damage_event` carries the attacking entity when the server
    // attributes the damage; `source` is undefined for environmental damage.
    // Recording it here is what makes the attacker visible to the decision
    // layer instead of leaving only a falling health number.
    const attackerName =
      source === undefined || source === null
        ? null
        : source.username ?? source.name ?? source.kind ?? 'unknown'
    // The stated damage origin: the packet's own `sourcePosition` when the
    // server sent one, else the resolved source entity's position. A source
    // entity that exists always has a position; a source the client never
    // received has neither, and then the origin stays UNKNOWN.
    const entityPosition = source?.position
    const position =
      origin ??
      (entityPosition !== undefined &&
      entityPosition !== null &&
      Number.isFinite(entityPosition.x) &&
      Number.isFinite(entityPosition.y) &&
      Number.isFinite(entityPosition.z)
        ? { x: entityPosition.x, y: entityPosition.y, z: entityPosition.z }
        : null)
    this.request('damage_taken', {
      health: this.bot.health,
      attackerId: source?.id ?? null,
      attackerName,
      ...(position === null ? {} : { attackerPosition: position }),
    })
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

  /**
   * The breath trigger. Mineflayer emits `breath` whenever the server updates
   * the `air_supply` metadata, i.e. roughly every tick while the head is under
   * water, so this listener must be an EDGE, not a level: it fires when the
   * body enters a new low-air band (10, 5, 0) and stays quiet inside the band.
   * Re-asking Jev every tick would replace "the body is drowning" with a
   * decision storm, and the executor already stops the mechanical action with a
   * typed `submerged` failure.
   */
  private readonly onBreath = (): void => {
    this.observeUnknownAirHeadSubmersion()
    const oxygenLevel = (this.bot as unknown as { oxygenLevel?: unknown }).oxygenLevel
    const air = observedAir(oxygenLevel)
    if (air === null || air > LOW_AIR_LEVEL) {
      this.lowAirBand = null
      return
    }
    // Only values on the Mineflayer 0..20 scale reach this point; malformed or
    // legacy raw-tick values were normalized to unknown above.
    const band = Math.max(0, Math.floor(air / 5))
    if (this.lowAirBand === band) return
    this.lowAirBand = band
    const position = breathPosition(this.bot)
    const finiteOxygenLevel = typeof oxygenLevel === 'number' && Number.isFinite(oxygenLevel) ? oxygenLevel : null
    const feetCell = sampleBreathCell(this.bot, position)
    const eyesPosition = position === null ? null : { x: position.x, y: position.y + EYE_HEIGHT, z: position.z }
    const eyesCell = sampleBreathCell(this.bot, eyesPosition)
    // LOW_AIR_PREEMPT is mirrored by the resident logger; its HOST sink binds
    // this same detail to runId, generationId, sourceSha and buildHash.
    this.logger.warn(
      'scheduler',
      formatLowAirPreempt(air, position),
      {
        air,
        threshold: LOW_AIR_LEVEL,
        trigger: 'low_air',
        diagnosticVersion: 1,
        schedulerInstanceId: this.schedulerInstanceId,
        lowAirBand: band,
        mineflayerOxygenLevel: finiteOxygenLevel,
        mineflayerOxygenLevelStatus: finiteOxygenLevel === null ? 'unknown' : 'observed',
        rawSelfAirMetadata: sampleRawSelfAirMetadata(this.bot),
        position,
        dimension: breathDimension(this.bot),
        feetCell,
        eyesCell,
      },
    )
    this.request('low_air', { air, threshold: LOW_AIR_LEVEL })
  }

  private readonly onPhysicsTick = (): void => {
    this.observeUnknownAirHeadSubmersion()
  }

  /** Emit one preemptive edge when the eyes enter observed water without breath metadata. */
  private observeUnknownAirHeadSubmersion(): void {
    const air = readAir(this.bot)
    const position = this.bot.entity?.position ?? null
    let headBlock: Block | null = null
    if (air === null && position !== null && typeof this.bot.blockAt === 'function') {
      try {
        headBlock = this.bot.blockAt(position.offset(0, EYE_HEIGHT, 0))
      } catch {
        headBlock = null
      }
    }
    const headInWater = headBlock !== null && PROBE_FLUIDS.has(headBlock.name)
    const unknownAirUnderwater = air === null && headInWater
    if (!unknownAirUnderwater) {
      this.unknownAirHeadSubmerged = false
      return
    }
    if (this.unknownAirHeadSubmerged) return
    this.unknownAirHeadSubmerged = true
    const at = position === null ? 'unknown' : `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`
    const detail = {
      air: null,
      headInWater: true,
      headBlock: headBlock?.name ?? 'unknown',
      position: position === null ? null : { x: position.x, y: position.y, z: position.z },
    }
    this.logger.warn(
      'scheduler',
      `UNKNOWN_AIR_HEAD_SUBMERGED layer=scheduler air=unknown/${MAX_AIR} headBlock=${detail.headBlock} at=${at} -> preempt in-flight action`,
      detail,
    )
    this.request('air_unknown_head_submerged', detail)
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

/** Coalesced trigger pick: the higher-priority trigger wins; a critical trigger is never overwritten by a lower one. */
export function pickHigherPriority(current: TriggerEvent | null, next: TriggerEvent): TriggerEvent {
  if (current === null) return next
  return TRIGGER_PRIORITY[next.trigger] > TRIGGER_PRIORITY[current.trigger] ? next : current
}
