// Goal-state snapshot helpers extracted from controller-legacy.ts, with the
// same read-only projection family consolidated out of the queue and System2
// planes. Owns the live world/body truth those planes consult: objective and
// inventory snapshots, the OptionWorldSnapshot projections, descend-goal
// evaluation, the protected retire reasons, and the capability/ascent refusal
// probes. No authority moves: every function reads through the narrow host
// surface and callers still reach the logic through the controller's private
// delegates.
import { goalCollectsFuel } from '../candidates.ts'
import { sensorOptions } from '../controller-shared.ts'
import type { SensorOptionSlice } from '../controller-shared.ts'
import type { JevAgentOptions } from '../controller-legacy.ts'
import { PICKAXE_TIER_ORDER } from '../gameData.ts'
import type { GoalQueue, PlannedGoal, QueuedGoal } from '../goalQueue.ts'
import { verifiedBlockRecordsFromKnownResources } from '../goalSuccess.ts'
import type { GoalSuccessWorldProbe, RecordedPortalSite } from '../goalSuccess.ts'
import type { EventLogger } from '../jev.ts'
import { FLINT_AND_STEEL, IRON_INGOT, OBSIDIAN, PORTAL_OBSIDIAN_REQUIRED } from '../netherPortalPlan.ts'
import type { PortalFrameSite } from '../netherPortalPlan.ts'
import { makeOptionSnapshot } from '../optionSpec.ts'
import type { OptionWorldSnapshot } from '../optionSpec.ts'
import { evaluateSpatialPredicate, predicateForGoal } from '../predicateGoal.ts'
import type { PredicateEvaluation } from '../predicateGoal.ts'
import { isResourceClass, matchesResourceClass } from '../resourceClass.ts'
import { sensedPortalFrameSites } from '../state.ts'
import type { AgentSignals, GoalState, KnownResource, Vec3Json, WorldState } from '../state.ts'
import type { System2Objective } from '../system2.ts'
import { formatAscentRefused, pillarColumnUnsafeFromBlocks, planVerticalApproachDetailed, selectPlaceableBlock } from '../verticalPlan.ts'
import { orphanedSmeltPrerequisiteReason } from './goal-queue-plane.ts'
import type { Bot } from 'mineflayer'

export interface GoalStateHost {
  activeRetrieval: { id: string; resource: string; knownName: string; target: Vec3Json } | null
  readonly bot: Bot
  countItem(name: string): number
  currentDimension(): string
  currentGoalKey(): string
  goal: GoalState
  inventorySnapshot(): Record<string, number>
  lastAscentRefusalKey: string | null
  lastWorldState: WorldState | null
  lastWorldStateTick: number
  logger: EventLogger
  options: Pick<JevAgentOptions, 'dominatedGoalReason' | 'knownResources'> & SensorOptionSlice
  predicateSnapshot(): { position: Vec3Json | null; dimension: string | null }
  queue: GoalQueue
  recordedPortalSites(): RecordedPortalSite[]
  rememberPortalFrameSites(sites: readonly PortalFrameSite[], dimension: string): void
  retrievalKey(active: { knownName: string; target: Vec3Json }): string
  signals: AgentSignals
  readonly tickCounter: number
}

export function objectiveState(host: GoalStateHost): System2Objective {
  return {
    targetItem: host.goal.targetItem,
    requiredCount: host.goal.requiredCount,
    haveCount: host.goal.haveCount,
    complete: host.goal.complete,
  }
}


export function predicateSnapshot(host: GoalStateHost): { position: Vec3Json | null; dimension: string | null } {
  const entity = host.bot.entity
  if (entity === undefined) return { position: null, dimension: null }
  return {
    position: { x: entity.position.x, y: entity.position.y, z: entity.position.z },
    dimension: host.bot.game?.dimension ?? null,
  }
}


export function evaluateDescendGoal(host: GoalStateHost,
goal: QueuedGoal): PredicateEvaluation | null {
  const predicate = predicateForGoal(goal)
  if (predicate === null) return null
  return evaluateSpatialPredicate(predicate, host.predicateSnapshot())
}


export function effectiveHave(host: GoalStateHost): number {
  const current = host.queue.current
  if (current === null || current.targetItem === null) return 0
  // M1 completion is inventory-verified: a subgoal only completes when the item
  // is actually in the inventory. A dig whose drop was not picked up simply
  // leaves the subgoal open and the bot mines another block. A wood goal counts
  // every `*_log` the bot holds, so `birch_log` satisfies an `oak_log` goal.
  // Issue #43: a fuel subgoal (`collect N x log (fuel)`) is satisfied by any
  // accepted fuel item (log/planks/coal/charcoal/blaze_rod), not only logs. A
  // smelt goal still counts its own output, never the fuel it consumes.
  if (goalCollectsFuel(current)) return countFuelSubstitutes(host)
  return countGoalCategory(host, current.targetItem)
}


export function countFuelSubstitutes(host: GoalStateHost): number {
  let total = 0
  for (const item of host.bot.inventory.items()) {
    if (item.name === 'stick') continue
    if (matchesResourceClass(item.name, 'fuel')) total += item.count
  }
  return total
}


export function countGoalCategory(host: GoalStateHost,
name: string): number {
  if (!isResourceClass(name)) return host.countItem(name)
  let total = 0
  for (const item of host.bot.inventory.items()) {
    if (matchesResourceClass(item.name, name)) total += item.count
  }
  return total
}


export function countItem(host: GoalStateHost,
name: string): number {
  const registry = host.bot.registry as { itemsByName?: Record<string, { id?: number }> } | undefined
  const id = registry?.itemsByName?.[name]?.id
  if (typeof id !== 'number') return 0
  return host.bot.inventory.count(id, null)
}


export function inventorySnapshot(host: GoalStateHost): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const item of host.bot.inventory.items()) {
    counts[item.name] = (counts[item.name] ?? 0) + item.count
  }
  return counts
}


export function optionSnapshot(host: GoalStateHost,
state: WorldState): OptionWorldSnapshot {
  const counts = host.inventorySnapshot()
  let toolRank = 0
  for (let i = 0; i < PICKAXE_TIER_ORDER.length; i += 1) {
    const name = PICKAXE_TIER_ORDER[i]
    if (name !== undefined && (counts[name] ?? 0) > 0) toolRank = i + 1
  }
  const knownStations = new Set<'crafting_table' | 'furnace'>()
  if ((counts['crafting_table'] ?? 0) > 0) knownStations.add('crafting_table')
  if ((counts['furnace'] ?? 0) > 0) knownStations.add('furnace')
  if (state.craftingTables.length > 0) knownStations.add('crafting_table')
  if ((state.furnaces?.length ?? 0) > 0) knownStations.add('furnace')
  const knownOres: string[] = []
  for (const resource of host.options.knownResources ?? []) {
    if (resource.name === 'furnace') knownStations.add('furnace')
    if (resource.name === 'crafting_table') knownStations.add('crafting_table')
    if (resource.kind === 'ore') knownOres.push(resource.name)
  }
  const position = host.bot.entity?.position
  return makeOptionSnapshot({
    inventory: counts,
    dimension: host.bot.game?.dimension ?? null,
    position: position === undefined ? null : { x: position.x, y: position.y, z: position.z },
    health: host.bot.health ?? null,
    toolRank,
    knownStations: [...knownStations],
    knownOres,
  })
}


export function queuePreconditionSnapshot(host: GoalStateHost): OptionWorldSnapshot {
  const counts = host.inventorySnapshot()
  let toolRank = 0
  for (let i = 0; i < PICKAXE_TIER_ORDER.length; i += 1) {
    const name = PICKAXE_TIER_ORDER[i]
    if (name !== undefined && (counts[name] ?? 0) > 0) toolRank = i + 1
  }
  const knownStations = new Set<'crafting_table' | 'furnace'>()
  if ((counts['crafting_table'] ?? 0) > 0) knownStations.add('crafting_table')
  if ((counts['furnace'] ?? 0) > 0) knownStations.add('furnace')
  for (const resource of host.options.knownResources ?? []) {
    if (resource.name === 'furnace') knownStations.add('furnace')
    if (resource.name === 'crafting_table') knownStations.add('crafting_table')
  }
  const position = host.bot.entity?.position
  return makeOptionSnapshot({
    inventory: counts,
    dimension: host.bot.game?.dimension ?? null,
    position: position === undefined ? null : { x: position.x, y: position.y, z: position.z },
    health: host.bot.health ?? null,
    toolRank,
    knownStations: [...knownStations],
    knownOres: [],
  })
}


export function installDominatedPrerequisiteReason(host: GoalStateHost): void {
  const reason = host.options.dominatedGoalReason
  if (reason === undefined) {
    host.queue.setDominatedPrerequisiteReason(null)
    return
  }
  host.queue.setDominatedPrerequisiteReason((goal) => reason(goal, host.inventorySnapshot()))
}


export function goalWorldProbe(host: GoalStateHost): GoalSuccessWorldProbe {
  const scratch = host.bot.entity?.position?.clone()
  return {
    dimension: host.bot.game?.dimension ?? null,
    blockAt: (cell) => {
      if (scratch === undefined) return null
      try {
        return host.bot.blockAt(scratch.set(cell.x, cell.y, cell.z))?.name ?? null
      } catch {
        // An unreadable cell is unobservable world truth, never absence.
        return null
      }
    },
    recordedPortalSites: host.recordedPortalSites(),
    verifiedBlockRecords: verifiedBlockRecordsFromKnownResources(host.options.knownResources),
  }
}


export function protectedGoalRetireReason(host: GoalStateHost,
goal: QueuedGoal, incoming: readonly PlannedGoal[]): string | null {
  // An `smelt:iron_ingot` row exists only to feed a craft that consumes the
  // ingot. Once that craft is resolved — the bot holds the flint_and_steel it
  // produced — and nothing live still wants an iron ingot, the row can only
  // re-run a smelt with no consumer, while its own station precondition (a
  // furnace) blocks the queue head indefinitely. Observed live: the queue head
  // was `smelt 1 x iron_ingot` with
  // `CANDIDATE_STARVATION blockedBy=precondition:station:furnace repeat=36`
  // while the real next step, `collect 10 x obsidian`, sat behind it.
  if (goal.kind === 'smelt' && goal.targetItem === IRON_INGOT) {
    const stillWanted =
      incoming.some((planned) => planned.targetItem === IRON_INGOT) ||
      host.queue.state.goals.some(
        (row) =>
          row.id !== goal.id &&
          row.status !== 'done' &&
          row.status !== 'impossible' &&
          row.targetItem === IRON_INGOT,
      )
    const reason = orphanedSmeltPrerequisiteReason({
      kind: goal.kind,
      item: goal.targetItem,
      held: host.countItem(FLINT_AND_STEEL),
      stillWanted,
    })
    if (reason !== null) return reason
  }
  if (goal.kind !== 'collect' || goal.targetItem !== OBSIDIAN) return null
  const continuesPortalFrame = incoming.some(
    (planned) =>
      planned.kind === 'place' &&
      planned.targetItem === OBSIDIAN &&
      (planned.optionTemplateId === 'place:obsidian' || planned.description.toLowerCase().includes('portal frame')),
  )
  if (!continuesPortalFrame) return null
  const sensedSites = sensedPortalFrameSites(host.bot, sensorOptions(host.options))
  host.rememberPortalFrameSites(sensedSites, host.currentDimension())
  const existing = Math.max(0, ...sensedSites.map((site) => site.existingFrame?.length ?? 0))
  const held = host.countItem(OBSIDIAN)
  if (existing + held < PORTAL_OBSIDIAN_REQUIRED) return null
  return `portal frame coverage existing=${existing} held=${held} required=${PORTAL_OBSIDIAN_REQUIRED}`
}


/**
 * The remembered target the ascent trap is measured against: the active
 * retrieval when one exists, else the active surface-recovery goal's own
 * `targetY`, else the highest remembered resource still above the bot. Pure
 * lookup; the trap predicate itself is `evaluateCapabilityGap`.
 *
 * The surface goal is included because the planner's capability-gap handling
 * forces exactly that goal (`buddy-driver/planner-legacy.ts`), and its
 * `targetY` is the Y the body must actually reach. Without it, a shaft with no
 * remembered upper feature had no target at all, so the trap could not fire.
 */
export function capabilityTarget(host: GoalStateHost): { y: number; key: string } | null {
  const active = host.activeRetrieval
  if (active !== null) return { y: active.target.y, key: host.retrievalKey(active) }
  const entity = host.bot.entity
  if (entity === undefined) return null
  let best: KnownResource | null = null
  for (const resource of host.signals.knownResources ?? []) {
    if (resource.position.y <= entity.position.y) continue
    if (best === null || resource.position.y > best.position.y) best = resource
  }
  const current = host.queue.current
  const surfaceTargetY =
    current?.kind === 'surface' && typeof current.targetY === 'number' && Number.isFinite(current.targetY)
      ? current.targetY
      : null
  if (surfaceTargetY !== null && surfaceTargetY > entity.position.y && (best === null || surfaceTargetY > best.position.y)) {
    return { y: surfaceTargetY, key: `surface:${current?.id ?? 'surface'}:${surfaceTargetY}` }
  }
  if (best === null) return null
  return { y: best.position.y, key: `known:${best.name}@${best.position.x},${best.position.y},${best.position.z}` }
}


/**
 * Pure plan fact for the capability target: is an upward gap with no grounded
 * plan? Reuses the same `planVerticalApproachDetailed` the candidate layer
 * offers with, so the controller's refusal is exactly the plan the executor
 * would have been given. A `plan` (pillar or staircase-up) or a level/downward
 * target is not a refusal; only a typed `ascentRefusal` is. Logs the typed
 * `ASCENT_REFUSED` line once per signature so the dead end is observable
 * without spamming one line per tick.
 */
export function ascentRefusedByPlan(host: GoalStateHost,
target: { y: number } | null): boolean {
  const state = host.lastWorldState
  const entity = host.bot.entity
  if (state === null || entity === undefined || target === null) return false
  if (host.lastWorldStateTick !== host.tickCounter - 1) return false
  const decision = planVerticalApproachDetailed({
    selfFeetY: entity.position.y,
    selfPosition: { x: entity.position.x, y: entity.position.y, z: entity.position.z },
    target: { x: entity.position.x, y: target.y, z: entity.position.z },
    tunnel: state.signals.lastTunnel ?? null,
    descent: state.descent,
    stepCuts: state.stepCuts,
    placeable: selectPlaceableBlock(state.inventory.counts),
    columnSafe: !pillarColumnUnsafeFromBlocks(state.self.position, state.blocks),
    inventory: state.inventory.counts,
  })
  const refusal = decision.ascentRefusal
  if (decision.plan !== null || refusal === null) return false
  const line = formatAscentRefused(refusal)
  if (line !== host.lastAscentRefusalKey) {
    host.lastAscentRefusalKey = line
    host.logger.warn('agent', line, { ...refusal, goal: host.currentGoalKey() }, host.tickCounter)
  }
  return true
}


export function logSubgoalStart(host: GoalStateHost,
goal: QueuedGoal, inventory: Record<string, number>, cause: string): void {
  host.logger.warn(
    'queue',
    `subgoal START [${goal.id}] ${goal.description} kind=${goal.kind} target=${goal.targetItem ?? 'none'} required=${goal.requiredCount} cause=${cause} inventory=${JSON.stringify(inventory)}`,
    { id: goal.id, kind: goal.kind, targetItem: goal.targetItem, requiredCount: goal.requiredCount, cause },
    host.tickCounter,
  )
}
