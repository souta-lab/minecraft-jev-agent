// Retrieval/descend progress observers extracted from controller-legacy.ts.
// These functions watch retrieval/descend progress, retire unreachable
// resources, and record surface-search coverage. They own no scheduling
// authority: escalation and candidate withholding are still decided by
// the legacy controller through its existing methods.
import { hasObservableProgress } from '../actionPostcondition.ts'
import { currentFocusItem } from '../controller-shared.ts'
import { blockId, queuedRetrievalProxyItem, surfaceSearchKey } from '../candidates.ts'
import type { Candidate } from '../candidates.ts'
import { DESCEND_PROGRESS_LOG_TICKS, evaluateDescendProgress, formatDescendProgress, formatDescendStalled, resolveDescendNoCandidateTicks, resolveDescendStallTicks } from '../descendPlan.ts'
import type { DescendProgressState } from '../descendPlan.ts'
import type { ExecutionResult } from '../executor.ts'
import type { GoalQueue } from '../goalQueue.ts'
import type { EventLogger } from '../jev.ts'
import type { MoveFailMemory, MoveFailurePathScope } from '../moveFailMemory.ts'
import { formatPrereqSwitch, knownStationKey, nextPrereqPath } from '../prereqOption.ts'
import type { PrereqDecision, PrereqPath, PrereqProgress } from '../prereqOption.ts'
import { distance } from '../state.ts'
import type { GoalState, KnownResource, Vec3Json, WorldState } from '../state.ts'
import { ASCENT_PROGRESS_EPSILON, evaluateRetrievalProgress, formatKnownResourceUnreachable, formatRetrieveStalled, planRetrievalEscalation, resolveRetrievalStallTicks } from '../verticalPlan.ts'
import type { DigMemory } from '../worldMemory.ts'
import type { Bot } from 'mineflayer'

export interface KnownRetrieveRetireInput {
  /** `candidate.meta.retrieval` (`known` for a durable remembered resource) */
  retrieval: unknown
  /** the remembered resource cell */
  target: Vec3Json | null
  /** the retrieve finished `done`/`verified` (a real arrival / climb chunk) */
  verified: boolean
  /** consecutive zero-progress retrieves for this resource INCLUDING this one */
  attempts: number
  limit?: number
}

export type KnownRetrieveDecision =
  | { kind: 'ignore' }
  | { kind: 'clear' }
  | { kind: 'charge'; attempts: number }
  | { kind: 'retire'; attempts: number }

export interface KnownRetrieveDecisionInput {
  /** `candidate.meta.retrieval` (`known` for a durable remembered resource) */
  retrieval: unknown
  /** the remembered resource cell */
  target: Vec3Json | null
  /** the finished executor result */
  result: Pick<ExecutionResult, 'status' | 'verified' | 'itemsGained' | 'blockRemoved' | 'progressed'>
  /** consecutive zero-progress retrieves for this resource BEFORE this one */
  previousAttempts: number
  limit?: number
  /**
   * Whether this retrieve actually COMPLETED: the target arrived or the item
   * was acquired (`retrieveCompleted`). A measured distance closure or a
   * bounded vertical chunk (`progressed`) is durable body evidence, never
   * completion - the counter must be CHARGED for it (RC8: `21.69m->20.42m`
   * repeatedly, no station arrival). When omitted, the observable-progress
   * proxy `knownRetrieveMadeProgress` is used for direct pure callers.
   */
  completed?: boolean
}

export const RETRIEVAL_STALL_TICKS = resolveRetrievalStallTicks()

export const DESCEND_STALL_TICKS = resolveDescendStallTicks()

export const DESCEND_NO_CANDIDATE_TICKS = resolveDescendNoCandidateTicks()

export const RETRIEVAL_PROGRESS_EPSILON = 0.5

export const KNOWN_RETRIEVE_RETIRE_LIMIT = 2

export function shouldRetireKnownRetrieve(input: KnownRetrieveRetireInput): boolean {
  if (input.retrieval !== 'known') return false
  if (input.target === null) return false
  if (input.verified) return false
  return input.attempts >= Math.max(1, Math.floor(input.limit ?? KNOWN_RETRIEVE_RETIRE_LIMIT))
}

export function knownRetrieveMadeProgress(
  result: Pick<ExecutionResult, 'status' | 'verified' | 'itemsGained' | 'blockRemoved' | 'progressed'>,
): boolean {
  return result.status === 'done' && result.verified && hasObservableProgress(result)
}

export function decideKnownRetrieve(input: KnownRetrieveDecisionInput): KnownRetrieveDecision {
  if (input.retrieval !== 'known' || input.target === null) return { kind: 'ignore' }
  const completed = input.completed ?? knownRetrieveMadeProgress(input.result)
  if (completed) return { kind: 'clear' }
  const attempts = input.previousAttempts + 1
  const retire = shouldRetireKnownRetrieve({
    retrieval: input.retrieval,
    target: input.target,
    verified: false,
    attempts,
    limit: input.limit,
  })
  return retire ? { kind: 'retire', attempts } : { kind: 'charge', attempts }
}

export function shouldClearActiveRetrieval(input: {
  retrieval: unknown
  hasObservableProgress: boolean
  arrived: boolean
}): boolean {
  if (!input.hasObservableProgress) return false
  if (input.retrieval !== 'known') return false
  return input.arrived
}

export function resourceKey(resource: { name: string; position: Vec3Json }): string {
  return `${resource.name}@${resource.position.x},${resource.position.y},${resource.position.z}`
}

export function filterKnownResources(
  resources: readonly KnownResource[],
  unreachable: ReadonlySet<string>,
): KnownResource[] {
  return resources.filter((resource) => !unreachable.has(resourceKey(resource)))
}

export function formatKnownResourceRetired(item: string, cell: Vec3Json, attempts: number): string {
  return `KNOWN_RESOURCE_RETIRED item=${item} cell=${cell.x},${cell.y},${cell.z} attempts=${attempts}`
}

export interface RetrievalProgressHost {
  activeRetrieval: { id: string; resource: string; knownName: string; target: Vec3Json } | null
  ascendRefusedSinceObservation: boolean
  readonly bot: Bot
  currentDimension(): string
  currentGoalKey(): string
  descendGoalKey: string | null
  descendProgress: DescendProgressState | null
  descendProgressTicks: number
  descendStallTicks: number
  readonly digMemory: DigMemory
  dropUnreachableResource(
    active: { resource: string; knownName: string; target: Vec3Json },
    current: number,
  ): void
  goal: GoalState
  readonly knownRetrieveFailures: Map<string, number>
  lastProgressAt: number
  logger: EventLogger
  moveFailMemory: MoveFailMemory
  movePathFailureScope(state?: WorldState | null): MoveFailurePathScope | null
  noteCandidateFailure(candidateId: string): void
  onRetrievalStall(
    active: { id: string; resource: string; knownName: string; target: Vec3Json },
    current: number,
  ): void
  options: {
    readonly knownResources?: readonly KnownResource[]
  }
  readonly placedStations: KnownResource[]
  prereqForcedPath: PrereqPath | null
  prereqLoggedKey: string | null
  prereqPlan: PrereqDecision | null
  prereqProgress: PrereqProgress | null
  queue: GoalQueue
  resetDescendTracking(): void
  retrievalArrived(candidate: Candidate): boolean
  retrievalDistance(target: Vec3Json | null): number | null
  retrievalDistanceExact(target: Vec3Json | null): number | null
  retrievalEscalationPending: boolean
  retrievalKey(active: { knownName: string; target: Vec3Json }): string
  retrievalTrack: { id: string; best: number; ticks: number; bestGap?: number } | null
  retrieveCompleted(candidate: Candidate, result: ExecutionResult): boolean
  readonly searchedSurfaceTargets: Set<string>
  readonly tickCounter: number
  readonly unreachableResources: Set<string>
  withheldCandidateIds: ReadonlySet<string>
}

export function noteAscendOutcome(host: RetrievalProgressHost,
result: ExecutionResult, candidate: Candidate): void {
  if (candidate.meta.vertical !== 'pillar') return
  if (result.status === 'done' && result.verified) return
  host.ascendRefusedSinceObservation = true
}


export function observeRetrievalStall(host: RetrievalProgressHost): void {
  const active = host.activeRetrieval
  const entity = host.bot.entity
  if (active === null || entity === undefined) {
    host.retrievalTrack = null
    return
  }
  if (host.goal.complete || host.unreachableResources.has(host.retrievalKey(active))) {
    host.activeRetrieval = null
    host.retrievalTrack = null
    return
  }
  const current = Math.hypot(
    entity.position.x - active.target.x,
    entity.position.y - active.target.y,
    entity.position.z - active.target.z,
  )
  const verticalGap = Math.abs(entity.position.y - active.target.y)
  if (host.retrievalTrack === null || host.retrievalTrack.id !== active.id) {
    host.retrievalTrack = { id: active.id, best: current, ticks: 0, bestGap: verticalGap }
    return
  }
  const previousBestGap = host.retrievalTrack.bestGap
  const decision = evaluateRetrievalProgress({
    previous: {
      best: host.retrievalTrack.best,
      ticks: host.retrievalTrack.ticks,
      bestGap: previousBestGap,
    },
    distance: current,
    verticalGap,
    verticalEpsilon: ASCENT_PROGRESS_EPSILON,
    epsilon: RETRIEVAL_PROGRESS_EPSILON,
    stallTicks: RETRIEVAL_STALL_TICKS,
  })
  host.retrievalTrack.best = decision.best
  host.retrievalTrack.ticks = decision.ticks
  host.retrievalTrack.bestGap = decision.bestGap
  // Altitude gain is real progress for the whole run too: a 56-block climb
  // does not move the goal inventory, so without this the wedge clock would
  // keep aging while the bot is demonstrably ascending.
  const altitudeImproved =
    decision.outcome === 'progress' &&
    previousBestGap !== undefined &&
    verticalGap <= previousBestGap - ASCENT_PROGRESS_EPSILON
  if (altitudeImproved) host.lastProgressAt = Date.now()
  if (decision.outcome === 'stalled') host.onRetrievalStall(active, current)
}


export function retrievalKey(host: RetrievalProgressHost,
active: { knownName: string; target: Vec3Json }): string {
  return resourceKey({ name: active.knownName, position: active.target })
}


export function observeDescendProgress(host: RetrievalProgressHost,
candidates: readonly Candidate[]): void {
  const current = host.queue.current
  const entity = host.bot.entity
  if (current === null || current.kind !== 'descend' || typeof current.targetY !== 'number' || entity === undefined) {
    host.resetDescendTracking()
    return
  }
  const targetY: number = current.targetY
  const y = entity.position.y
  const goalKey = `${current.id}:${targetY}`
  if (host.descendGoalKey !== goalKey) {
    host.descendGoalKey = goalKey
    host.descendProgress = { bestY: y, ticks: 0 }
    host.descendStallTicks = 0
    host.descendProgressTicks = 0
  }
  const previous = host.descendProgress ?? { bestY: y, ticks: 0 }
  const decision = evaluateDescendProgress({ previous, y, stallTicks: DESCEND_STALL_TICKS })
  host.descendProgress = { bestY: decision.bestY, ticks: decision.ticks }
  const delta = Math.round((decision.bestY - y) * 10) / 10
  if (decision.outcome === 'progress') {
    host.descendProgressTicks = 0
    host.descendStallTicks = 0
    host.logger.info(
      'agent',
      formatDescendProgress(Math.floor(y), targetY, delta, 0),
      { y, targetY, delta, outcome: decision.outcome },
      host.tickCounter,
    )
    return
  }
  const hasDescendCandidate = candidates.some((candidate) => candidate.kind === 'DESCEND')
  host.descendStallTicks = hasDescendCandidate ? 0 : host.descendStallTicks + 1
  host.descendProgressTicks += 1
  if (host.descendProgressTicks % DESCEND_PROGRESS_LOG_TICKS === 0) {
    host.logger.info(
      'agent',
      formatDescendProgress(Math.floor(y), targetY, delta, host.descendStallTicks),
      { y, targetY, delta, hasDescendCandidate, stallTicks: host.descendStallTicks },
      host.tickCounter,
    )
  }
  const noCandidateStalled = host.descendStallTicks >= DESCEND_NO_CANDIDATE_TICKS
  if (!noCandidateStalled && decision.outcome !== 'stalled') return
  const stallTicks = noCandidateStalled ? host.descendStallTicks : DESCEND_STALL_TICKS
  host.logger.warn(
    'agent',
    formatDescendStalled(Math.floor(y), targetY, stallTicks),
    { y, targetY, stallTicks, hasDescendCandidate },
    host.tickCounter,
  )
  // Strategy switch: forget the latched descent budget and chosen direction so
  // the next tick can pick a different column/step. This is local mechanical
  // recovery; a stalled actuator is not a semantic Option boundary.
  host.digMemory.markResourceProgress()
  host.descendProgress = { bestY: y, ticks: 0 }
  host.descendStallTicks = 0
  host.logger.warn(
    'agent',
    `LOCAL_DESCEND_STALL goal=${current.id} y=${Math.floor(y)} target_y=${targetY} ticks=${stallTicks} system2=false`,
    { goal: current.id, y, targetY, stallTicks, boundary: 'local_recovery' },
    host.tickCounter,
  )
}


export function resetDescendTracking(host: RetrievalProgressHost): void {
  host.descendProgress = null
  host.descendStallTicks = 0
  host.descendProgressTicks = 0
  host.descendGoalKey = null
}


export function retrievalTargetExists(host: RetrievalProgressHost): boolean {
  const active = host.activeRetrieval
  if (active === null) return false
  return (host.options.knownResources ?? []).some(
    (resource) =>
      resource.name === active.knownName &&
      resource.position.x === active.target.x &&
      resource.position.y === active.target.y &&
      resource.position.z === active.target.z,
  )
}


export function onRetrievalStall(host: RetrievalProgressHost,

  active: { id: string; resource: string; knownName: string; target: Vec3Json },
  current: number,
): void {
  const ticks = RETRIEVAL_STALL_TICKS
  host.logger.warn(
    'agent',
    formatRetrieveStalled(active.target, Math.round(current), ticks),
    { target: active.target, dist: Math.round(current), ticks },
    host.tickCounter,
  )
  // Issue #58: a stalled furnace-station retrieval is not an unreachable
  // resource to give up on - it is one prereq path losing to another. Switch
  // to the next scored path (place held / craft) and keep the parent smelt.
  if (active.resource === 'furnace' && host.prereqPlan !== null) {
    const next = nextPrereqPath(host.prereqPlan, 'use_known_station')
    if (next !== null) {
      host.logger.warn(
        'agent',
        formatPrereqSwitch('use_known_station', next),
        { from: 'use_known_station', to: next, stallTicks: ticks, goal: host.currentGoalKey() },
        host.tickCounter,
      )
      host.prereqForcedPath = next
      host.prereqProgress = null
      host.prereqLoggedKey = null
      host.noteCandidateFailure(active.id)
      host.digMemory.markResourceProgress()
      host.activeRetrieval = null
      host.retrievalTrack = null
      return
    }
  }
  host.dropUnreachableResource(active, current)
  host.noteCandidateFailure(active.id)
  host.digMemory.markResourceProgress()
  host.activeRetrieval = null
  host.retrievalTrack = null
  host.retrievalEscalationPending = true
  host.logger.warn(
    'agent',
    `LOCAL_RETRIEVAL_STALL target=${active.target.x},${active.target.y},${active.target.z} dist=${Math.round(current)} ticks=${ticks} system2=false`,
    { target: active.target, dist: Math.round(current), ticks, boundary: 'local_recovery' },
    host.tickCounter,
  )
}


export function dropUnreachableResource(host: RetrievalProgressHost,

  active: { resource: string; knownName: string; target: Vec3Json },
  current: number,
): void {
  const key = host.retrievalKey(active)
  if (host.unreachableResources.has(key)) return
  host.unreachableResources.add(key)
  host.logger.warn(
    'agent',
    formatKnownResourceUnreachable(active.resource, active.knownName, active.target),
    { item: active.resource, name: active.knownName, at: active.target, dist: Math.round(current) },
    host.tickCounter,
  )
  const entity = host.bot.entity
  const escalation = planRetrievalEscalation({
    failedName: active.knownName,
    failedTarget: active.target,
    known: host.options.knownResources ?? [],
    self:
      entity === undefined
        ? { x: 0, y: 0, z: 0 }
        : { x: entity.position.x, y: entity.position.y, z: entity.position.z },
  })
  host.logger.info(
    'agent',
    escalation.kind === 'switch-resource'
      ? `RETRIEVAL_ESCALATION kind=switch-resource name=${escalation.name} at=${escalation.position.x},${escalation.position.y},${escalation.position.z}`
      : `RETRIEVAL_ESCALATION kind=branch-mine y=${escalation.y}`,
    { escalation },
    host.tickCounter,
  )
}


export function retireFailedKnownRetrieve(host: RetrievalProgressHost,
candidate: Candidate, result: ExecutionResult): void {
  if (candidate.meta.retrieval !== 'known' || candidate.target === null) return
  const knownName =
    typeof candidate.meta.knownName === 'string' ? candidate.meta.knownName : candidate.targetName ?? 'resource'
  const key = resourceKey({ name: knownName, position: candidate.target })
  const decision = decideKnownRetrieve({
    retrieval: candidate.meta.retrieval,
    target: candidate.target,
    result,
    previousAttempts: host.knownRetrieveFailures.get(key) ?? 0,
    completed: host.retrieveCompleted(candidate, result),
  })
  if (decision.kind === 'ignore') return
  if (decision.kind === 'clear') {
    host.knownRetrieveFailures.delete(key)
    return
  }
  host.knownRetrieveFailures.set(key, decision.attempts)
  if (decision.kind === 'charge') return
  // The retire boundary is about reachability, not truth: the cell was never
  // disproved, so it is dropped (bounded) rather than falsified. The typed
  // marker keeps the two apart in the run log.
  host.logger.warn(
    'agent',
    formatKnownResourceRetired(
      typeof candidate.meta.resource === 'string' ? candidate.meta.resource : knownName,
      candidate.target,
      decision.attempts,
    ),
    { item: candidate.meta.resource ?? knownName, cell: candidate.target, attempts: decision.attempts, limit: KNOWN_RETRIEVE_RETIRE_LIMIT },
    host.tickCounter,
  )
  host.dropUnreachableResource(
    {
      resource: typeof candidate.meta.resource === 'string' ? candidate.meta.resource : knownName,
      knownName,
      target: candidate.target,
    },
    host.retrievalDistance(candidate.target) ?? 0,
  )
  host.activeRetrieval = null
  host.retrievalTrack = null
}


export function logRetrievalAction(host: RetrievalProgressHost,
candidate: Candidate): void {
  const resource = typeof candidate.meta.resource === 'string' ? candidate.meta.resource : 'unknown'
  const at = candidate.target === null ? null : `${candidate.target.x},${candidate.target.y},${candidate.target.z}`
  if (candidate.meta.retrieval === 'surface') {
    host.logger.info(
      'agent',
      `EXPLORE kind=surface target=${resource} at=${at ?? 'unknown'}`,
      { kind: 'surface', target: resource, at },
      host.tickCounter,
    )
    return
  }
  const dist = host.retrievalDistance(candidate.target)
  const vertical = typeof candidate.meta.vertical === 'string' ? candidate.meta.vertical : 'none'
  const knownName = typeof candidate.meta.knownName === 'string' ? candidate.meta.knownName : resource
  if (candidate.target !== null) {
    host.activeRetrieval = { id: candidate.id, resource, knownName, target: candidate.target }
  }
  host.logger.info(
    'agent',
    `RETURN_TO_KNOWN_RESOURCE item=${resource} target=${at ?? 'unknown'} dist=${dist ?? 'unknown'} vertical=${vertical}`,
    { item: resource, name: candidate.targetName, target: at, dist, vertical },
    host.tickCounter,
  )
}


export function retrievalDistance(host: RetrievalProgressHost,
target: Vec3Json | null): number | null {
  const exact = host.retrievalDistanceExact(target)
  return exact === null ? null : Math.round(exact)
}


export function retrievalDistanceExact(host: RetrievalProgressHost,
target: Vec3Json | null): number | null {
  const entity = host.bot.entity
  if (target === null || entity === undefined) return null
  return Math.hypot(entity.position.x - target.x, entity.position.y - target.y, entity.position.z - target.z)
}


export function retrievalArrived(host: RetrievalProgressHost,
candidate: Candidate): boolean {
  if (candidate.meta.retrieval !== 'known' || candidate.target === null) return false
  const distance = host.retrievalDistanceExact(candidate.target)
  return distance !== null && distance <= 2
}


export function surfaceSearchArrived(host: RetrievalProgressHost,
candidate: Candidate): boolean {
  if (candidate.meta.retrieval !== 'surface' || candidate.target === null) return false
  const distance = host.retrievalDistanceExact(candidate.target)
  return distance !== null && distance <= 2
}


export function recordSurfaceSearch(host: RetrievalProgressHost,
candidate: Candidate): void {
  if (candidate.target === null) return
  const key = surfaceSearchKey(host.currentDimension(), candidate.target)
  if (host.searchedSurfaceTargets.has(key)) return
  host.searchedSurfaceTargets.add(key)
  host.logger.info(
    'agent',
    `SURFACE_SEARCH_RECORDED target=${candidate.target.x},${candidate.target.y},${candidate.target.z}`,
    { target: candidate.target, key, frontier: 'advanced', resource: candidate.meta.resource ?? null },
    host.tickCounter,
  )
}


export function retrieveCompleted(host: RetrievalProgressHost,
candidate: Candidate, result: ExecutionResult): boolean {
  if (result.itemsGained > 0) return true
  // Surface arrival proves only that a search waypoint was visited. The
  // requested resource is still absent until the next sensor/MINE cycle.
  if (candidate.meta.retrieval !== 'known') return false
  const arrived = host.retrievalArrived(candidate)
  if (arrived) return true
  return shouldClearActiveRetrieval({
    retrieval: candidate.meta.retrieval,
    hasObservableProgress: hasObservableProgress(result),
    arrived,
  })
}


export function knownResourcesForSensor(host: RetrievalProgressHost): KnownResource[] {
  const out: KnownResource[] = []
  const seen = new Set<string>()
  for (const resource of [...(host.options.knownResources ?? []), ...host.placedStations]) {
    const key = resourceKey(resource)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(resource)
  }
  return out
}


export function retrievalProbeItems(host: RetrievalProgressHost): string[] {
  const out: string[] = []
  const focus = currentFocusItem(host.goal, host.queue.state)
  if (focus !== null) out.push(focus)
  const proxy = queuedRetrievalProxyItem(host.queue.state)
  if (proxy !== null && !out.includes(proxy)) out.push(proxy)
  return out
}


export function unreachableStationKeys(host: RetrievalProgressHost,
state: WorldState): ReadonlySet<string> {
  const keys = new Set<string>()
  const dimension = state.self.dimension
  const pathFailureScope = host.movePathFailureScope(state)
  const consider = (name: string, position: Vec3Json): void => {
    const retrieveId = `RETRIEVE:known:station:${name}:${blockId('b', position)}`
    const withheld = host.withheldCandidateIds.has(retrieveId)
    if (!withheld && !host.moveFailMemory.isBlacklisted(dimension, position, pathFailureScope)) return
    keys.add(knownStationKey({ name, position }))
  }
  for (const resource of state.signals.knownResources ?? []) {
    if (resource.kind === 'station') consider(resource.name, resource.position)
  }
  for (const station of state.furnaces ?? []) {
    consider('furnace', station)
  }
  for (const station of state.craftingTables ?? []) {
    consider('crafting_table', station)
  }
  return keys
}


export function blacklistedMoveTargets(host: RetrievalProgressHost,
state: WorldState): ReadonlySet<string> {
  const dimension = state.self.dimension
  const pathFailureScope = host.movePathFailureScope(state)
  const keys = new Set<string>()
  for (const entry of host.moveFailMemory.snapshot()) {
    if (entry.dimension !== dimension) continue
    if (host.moveFailMemory.isBlacklisted(dimension, entry, pathFailureScope)) keys.add(entry.key)
  }
  return keys
}
