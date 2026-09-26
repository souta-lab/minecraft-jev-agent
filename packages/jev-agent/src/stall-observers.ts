// Stall, oscillation and capability-gap observers extracted from
// controller-legacy.ts. They watch motion/progress evidence and raise
// the existing signals (stall signal, oscillation memory, capability
// gap latches, escalation). No authority moves: abort goes through
// host.abortWedge and escalation through host.escalate.
import type { ActionOutcomeTaxonomy } from './actionPostcondition.ts'
import { exploredCellKey } from './candidates.ts'
import type { Candidate } from './candidates.ts'
import type { ExecutionResult } from './executor.ts'
import type { GoalQueue } from './goalQueue.ts'
import type { EventLogger } from './jev.ts'
import { formatLocalOscillationCleared, isNotableLocalOscillation, localOscillationCell, localOscillationPersistKey, observeLocalOscillation, resolveLocalOscillationRecentCells, resolveLocalOscillationReturnLimit } from './localOscillation.ts'
import type { LocalOscillationRecordJson } from './localOscillation.ts'
import { formatLocomotionObservation, LOCOMOTION_WINDOW_SIZE, NO_LOCOMOTION_OBSERVATION, observeLocomotion } from './locomotion.ts'
import type { LocomotionObservation } from './locomotion.ts'
import { detectOscillation as detectMoveFailOscillation, formatMoveTargetSkipped, formatOscillationDetected, isTrackedMoveKind, moveFailureKey } from './moveFailMemory.ts'
import type { MoveFailMemory } from './moveFailMemory.ts'
import type { CurrentOptionContext } from './optionSpec.ts'
import { evaluateOscillation, positionKey } from './oscillation.ts'
import type { OscillationState } from './oscillation.ts'
import type { PrereqPath, PrereqProgress, RetrieveUnverifiedState } from './prereqOption.ts'
import { evaluateCapabilityGap, formatCapabilityGap, formatCapabilityGapPolicy } from './replanThrottle.ts'
import type { CapabilityGapState } from './replanThrottle.ts'
import { isSensedStation } from './state.ts'
import type { AgentSignals, GoalState, Vec3Json, WorldState } from './state.ts'
import type { StrategicStallTracker } from './strategicStall.ts'
import type { JevAgentOptions } from './controller-shared.ts'
import type { EscalationReason } from './escalation.ts'
import { evaluateLocalMotionBoundary, shouldWakeSystem2AfterLocalFailure } from './system2/escalation.ts'
import type { DigMemory } from './worldMemory.ts'
import type { Bot } from 'mineflayer'

export const LOCAL_OSCILLATION_RECENT_CELLS = resolveLocalOscillationRecentCells()
const LOCAL_OSCILLATION_RETURN_LIMIT = resolveLocalOscillationReturnLimit()
const OSCILLATION_REPEAT_LOG_MS = 5_000
const EXPLORED_CELLS_LIMIT = 512

export interface StallObserverHost {
  abortWedge(reason: string): void
  readonly abandonedRetrievePaths: Map<PrereqPath, string>
  actionStart: Vec3Json | null
  activeRetrieval: { id: string; resource: string; knownName: string; target: Vec3Json } | null
  ascendRefusedSinceObservation: boolean
  ascentRefusedByPlan(target: { y: number } | null): boolean
  bindDigMemoryScope(dimension: string): void
  readonly bot: Bot
  capabilityGapActive: boolean
  capabilityGapSignature: string | null
  capabilityGapState: CapabilityGapState | null
  capabilityTarget(): { y: number; key: string } | null
  currentDimension(): string
  currentGoalKey(): string
  currentOptionContext(): CurrentOptionContext | null
  detectMoveOscillation(): void
  detectOscillation(position: Vec3Json): void
  digMemoryState: DigMemory
  digOscillationReported: boolean
  ensureCapabilityGapSignal(marker: string): void
  escalate(reason: EscalationReason, detail: string): void
  escapeOscillation(state: OscillationState): void
  readonly exploredCells: Set<string>
  goal: GoalState
  inventorySnapshot(): Record<string, number>
  lastDecisionId: string | null
  lastLocomotionObservation: LocomotionObservation
  lastMoveTarget: { dimension: string; position: Vec3Json } | null
  lastOscillationAt: number
  lastOscillationPair: string | null
  lastProgressAt: number
  lastStateFingerprint: string
  localOscillation: LocalOscillationRecordJson | null
  localOscillationInventory: string
  localOscillationPersisted: string
  logger: EventLogger
  moveFailMemory: MoveFailMemory
  notExecutableKey: string | null
  notExecutableRepeats: number
  noteCandidateFailure(candidateId: string): void
  notifyMoveFailureMemory(): void
  options: Pick<JevAgentOptions, 'onLocalOscillationChange' | 'serverId' | 'stallMs' | 'wedgeStallMs' | 'worldEpoch'>
  oscillationSignature(): string
  oscillationState: OscillationState | null
  persistLocalOscillation(): void
  positionWindow: Vec3Json[]
  prereqForcedPath: PrereqPath | null
  prereqLoggedKey: string | null
  prereqProgress: PrereqProgress | null
  previousMoveTarget: { dimension: string; position: Vec3Json } | null
  queue: GoalQueue
  recentEvents: string[]
  remainingCooldownSeconds(blacklistedUntil: number, now?: number): number
  retrievalEscalationPending: boolean
  retrievalKey(active: { knownName: string; target: Vec3Json }): string
  retrievalTrack: { id: string; best: number; ticks: number; bestGap?: number } | null
  retrieveUnverified: RetrieveUnverifiedState | null
  signals: AgentSignals
  readonly strategicStall: StrategicStallTracker
  strategicStallOptionId: string | null
  readonly tickCounter: number
  readonly unreachableResources: Set<string>
}

export function updateStallSignal(host: StallObserverHost): void {
  // #360: re-arm the recurrence evidence when System2 replaces the active
  // Option, and refresh the snapshot beta reads this tick.
  const optionInstanceId = host.currentOptionContext()?.instanceId ?? null
  if (optionInstanceId !== host.strategicStallOptionId) {
    host.strategicStallOptionId = optionInstanceId
    host.signals.oscillationsDetected = 0
  }
  host.strategicStall.setOption(optionInstanceId)
  host.signals.strategicNonProgress = host.strategicStall.evidence()
  const stalledMs = Date.now() - host.lastProgressAt
  host.signals.stalledMs = stalledMs
  if (!host.goal.complete && stalledMs > host.options.stallMs) {
    const boundary = shouldWakeSystem2AfterLocalFailure({
      failureCode: 'path_stuck',
      activeOption: host.queue.current !== null,
      semanticExhausted: false,
      semanticInvalid: false,
      semanticAbandoned: false,
    })
    host.logger.warn(
      'agent',
      `LOCAL_PROGRESS_STALL stalledMs=${stalledMs} system2=false reason=${boundary.reason}`,
      { stalledMs, goal: host.currentGoalKey(), boundary: boundary.reason },
      host.tickCounter,
    )
  }
  if (!host.goal.complete && stalledMs > host.options.wedgeStallMs) {
    host.abortWedge(`goal progress stayed 0 for ${stalledMs}ms`)
  }
}


export function observeLocalMotion(host: StallObserverHost,

  result: ExecutionResult,
  candidate: Candidate,
  taxonomy: ActionOutcomeTaxonomy,
): void {
  const dimension = host.currentDimension()
  const position = host.bot.entity.position
  const bodyCell = localOscillationCell(dimension, position)
  const startedCell = host.actionStart === null ? null : localOscillationCell(dimension, host.actionStart)
  const attemptCell =
    isTrackedMoveKind(result.kind) && candidate.target !== null
      ? localOscillationCell(dimension, candidate.target)
      : null
  const inventory = ((): string => {
    try {
      return JSON.stringify(host.inventorySnapshot())
    } catch {
      // Inventory unreadable at a death/quit boundary: no delta evidence, and
      // the record is deliberately NOT cleared (unknown is not progress).
      return host.localOscillationInventory
    }
  })()
  const inventoryChanged = host.localOscillationInventory !== '' && host.localOscillationInventory !== inventory
  host.localOscillationInventory = inventory

  const previous = host.localOscillation
  const decision = observeLocalOscillation(
    previous,
    {
      bodyCell,
      attemptCell,
      dimension,
      goal: host.currentGoalKey(),
      cellChanged: startedCell !== null && startedCell !== bodyCell,
      semanticProgress: taxonomy.progressKinds.some((kind) => kind === 'goal' || kind === 'search'),
      inventoryChanged,
      // Only a RETRIEVE reports `distanceClosed`, and only for a run that moved
      // the body closer to its target: real locomotion toward something.
      distanceClosed: result.kind === 'RETRIEVE' && result.distanceClosed === true,
      now: Date.now(),
    },
    { recentCells: LOCAL_OSCILLATION_RECENT_CELLS, returnLimit: LOCAL_OSCILLATION_RETURN_LIMIT },
  )

  host.localOscillation = decision.record
  if (decision.cleared !== null && previous !== null && isNotableLocalOscillation(previous)) {
    host.logger.info(
      'agent',
      formatLocalOscillationCleared(previous, decision.cleared),
      { reason: decision.cleared, cells: previous.cells, goal: host.currentGoalKey() },
      host.tickCounter,
    )
    host.persistLocalOscillation()
  } else if (isNotableLocalOscillation(decision.record)) {
    // Persist the FIRST evidence of a return and every change after it, so a
    // generation change cannot restart the count. Ordinary walking (returns 0)
    // writes nothing at all.
    host.persistLocalOscillation()
  }
  if (!decision.exhausted || decision.line === null) return

  const boundary = evaluateLocalMotionBoundary({
    activeOption: host.queue.current !== null,
    oscillationExhausted: true,
  })
  host.logger.warn(
    'agent',
    decision.line,
    {
      cells: decision.record?.cells ?? [],
      returns: decision.record?.returns ?? 0,
      required: decision.required,
      trips: decision.record?.trips ?? 0,
      goal: host.currentGoalKey(),
      boundary: boundary.reason,
    },
    host.tickCounter,
  )
  if (!boundary.wake) return
  host.escalate(
    'all_candidates_invalid',
    `LOCAL_OSCILLATION_BOUNDARY: ${decision.record?.returns ?? 0} re-engagements of the same ` +
      `${decision.record?.cells.length ?? 0}-cell set with zero semantic progress; ` +
      `cells=${JSON.stringify(decision.record?.cells ?? [])}`,
  )
}


export function observeCapabilityGap(host: StallObserverHost): void {
  const entity = host.bot.entity
  if (entity === undefined) return
  const target = host.capabilityTarget()
  // A refused ascent is either an executed pillar that did not verify (the
  // executor path) OR the pure plan layer proving there is no grounded up
  // plan at all. The second is what the measured `recover_vertical_access`
  // y>=80 stretch hit: no pillar was ever offered, so no executed refusal was
  // ever recorded and the trap never fired while the body paced between two
  // cells. Both are deterministic facts, so both feed the same predicate.
  const planRefused = host.ascentRefusedByPlan(target)
  const decision = evaluateCapabilityGap(host.capabilityGapState, {
    y: entity.position.y,
    targetY: target === null ? null : target.y,
    targetKey: target === null ? null : target.key,
    ascendRefused: host.ascendRefusedSinceObservation || planRefused,
  })
  host.capabilityGapState = decision.state
  host.ascendRefusedSinceObservation = false
  if (!decision.gap) {
    if (host.capabilityGapActive) {
      host.capabilityGapActive = false
      host.capabilityGapSignature = null
      host.logger.info(
        'agent',
        `CAPABILITY_GAP_CLEARED target_y=${Math.round(decision.targetY ?? 0)}`,
        { targetY: decision.targetY },
        host.tickCounter,
      )
    }
    return
  }
  const marker = formatCapabilityGap(decision)
  if (!host.capabilityGapActive) {
    host.capabilityGapActive = true
    host.capabilityGapSignature = `ascend_blocked:${Math.round(decision.targetY ?? 0)}`
    host.logger.warn(
      'agent',
      marker,
      { attempts: decision.attempts, targetY: decision.targetY, reason: decision.reason },
      host.tickCounter,
    )
    host.logger.warn(
      'agent',
      formatCapabilityGapPolicy(decision),
      { ...decision.heuristic, attempts: decision.attempts, targetY: decision.targetY },
      host.tickCounter,
    )
  }
  host.ensureCapabilityGapSignal(marker)
  const boundary = shouldWakeSystem2AfterLocalFailure({
    failureCode: 'path_stuck',
    activeOption: host.queue.current !== null,
    semanticExhausted: false,
    semanticInvalid: false,
    semanticAbandoned: false,
  })
  host.logger.warn(
    'agent',
    `LOCAL_CAPABILITY_GAP target_y=${Math.round(decision.targetY ?? 0)} attempts=${decision.attempts} system2=false reason=${boundary.reason}`,
    { attempts: decision.attempts, targetY: decision.targetY, boundary: boundary.reason },
    host.tickCounter,
  )
}


export function ensureCapabilityGapSignal(host: StallObserverHost,
marker: string): void {
  const last = host.recentEvents[host.recentEvents.length - 1]
  if (last === marker) return
  host.recentEvents.push(marker)
}


export function detectMoveOscillation(host: StallObserverHost): void {
  const detection = detectMoveFailOscillation(host.positionWindow)
  if (!detection.detected || detection.from === null || detection.to === null) return
  const fromKey = `${detection.from.x},${detection.from.y},${detection.from.z}`
  const toKey = `${detection.to.x},${detection.to.y},${detection.to.z}`
  const pair = `${fromKey}|${toKey}`
  const now = Date.now()
  host.positionWindow.length = 0
  host.lastLocomotionObservation = NO_LOCOMOTION_OBSERVATION
  if (pair === host.lastOscillationPair && now - host.lastOscillationAt < OSCILLATION_REPEAT_LOG_MS) return
  host.lastOscillationPair = pair
  host.lastOscillationAt = now
  host.logger.warn(
    'agent',
    formatOscillationDetected(detection.from, detection.to, detection.cycles, 'blacklist'),
    { from: fromKey, to: toKey, cycles: detection.cycles, action: 'blacklist' },
    host.tickCounter,
  )
  // Blacklist both ends of the observed loop.  Blacklisting only the last
  // selected target leaves the opposite endpoint available, so Jev can
  // immediately choose A after B was retired and keep walking A<->B.
  const dimension = host.currentDimension()
  const seen = new Set<string>()
  // #360 §6: the detector reports the two BODY positions the bot swapped between,
  // while the candidate identities are the TARGET cells it stepped to. The key
  // is now the canonical occupied block cell (`moveFailureKey` floors), so the
  // body cell and the candidate cell are the same identity; the remembered
  // targets are kept as an explicit second source for a landing that stopped on
  // a cell edge. Live evidence before the fix: MOVE:p3_67_17/p3_67_18 looped
  // while the escape blacklisted overworld:4,67,18 and :4,67,19 - different
  // cells, so nothing was suppressed.
  const trackedTargets: Vec3Json[] = []
  if (host.lastMoveTarget !== null && host.lastMoveTarget.dimension === dimension) trackedTargets.push(host.lastMoveTarget.position)
  if (host.previousMoveTarget !== null && host.previousMoveTarget.dimension === dimension) trackedTargets.push(host.previousMoveTarget.position)
  for (const position of [...trackedTargets, detection.from, detection.to]) {
    if (position === null) continue
    const key = moveFailureKey(dimension, position)
    if (seen.has(key)) continue
    seen.add(key)
    const result = host.moveFailMemory.blacklist(dimension, position, 'no_progress')
    const cooldownSeconds = host.remainingCooldownSeconds(result.entry.blacklistedUntil, now)
    host.logger.warn(
      'agent',
      formatMoveTargetSkipped(key, result.entry.attempts, cooldownSeconds),
      { key, attempts: result.entry.attempts, reason: 'oscillation', cooldown: cooldownSeconds },
      host.tickCounter,
    )
  }
  if (seen.size > 0) host.notifyMoveFailureMemory()
  host.logger.warn(
    'agent',
    `LOCAL_MOVE_OSCILLATION from=${fromKey} to=${toKey} cycles=${detection.cycles} system2=false`,
    { from: fromKey, to: toKey, cycles: detection.cycles, boundary: 'local_recovery' },
    host.tickCounter,
  )
}


export function syncTerrainSignals(host: StallObserverHost, state: WorldState): void {
  // Use the same typed observation that produced this snapshot when scoping
  // coordinate memory. Going back through the legacy `digMemory` getter here
  // would resample Mineflayer's live dimension during VTR fact construction.
  host.bindDigMemoryScope(state.self.dimension)
  const feetY = Math.floor(state.self.position.y)
  let deepest: number | null = null
  for (const block of state.blocks) {
    if (block.kind !== 'stone' && block.kind !== 'ore') continue
    if (block.position.y >= feetY) continue
    if (deepest === null || block.position.y < deepest) deepest = block.position.y
  }
  if (deepest !== null) host.digMemoryState.observeStoneY(deepest)
  const memory = host.digMemoryState.snapshot()
  host.signals.digDir = memory.digDir
  host.signals.digMode = memory.digMode
  host.signals.digDirCount = memory.digDirCount
  host.signals.digDepth = memory.digDepth
  host.signals.digOscillate = memory.digOscillate
  host.signals.knownStoneY = memory.knownStoneY
  host.signals.lastTunnel = memory.lastTunnel
  host.signals.descendNoProgress = memory.descendNoProgress
  host.signals.descendLimitReached = memory.descendLimitReached
}


export function bindDigMemoryScope(host: StallObserverHost, dimension: string): void {
  const change = host.digMemoryState.bindScope({
    serverId: host.options.serverId,
    dimension,
    worldEpoch: host.options.worldEpoch,
  })
  if (change.changed) host.digOscillationReported = false
  if (!change.changed || change.previous === null) return
  host.logger.warn(
    'agent',
    `DIG_MEMORY_SCOPE_RESET previous=${change.previous.serverId}|${change.previous.dimension}@${change.previous.worldEpoch} current=${change.current.serverId}|${change.current.dimension}@${change.current.worldEpoch}`,
    {
      previous: change.previous,
      current: change.current,
      cleared: ['direction', 'tunnelCoordinates', 'oscillationWindow', 'knownStoneY', 'descendBudget'],
    },
    host.tickCounter,
  )
}


export function sampleMovement(host: StallObserverHost, position: Vec3Json): void {
  host.positionWindow.push({ x: position.x, y: position.y, z: position.z })
  while (host.positionWindow.length > LOCOMOTION_WINDOW_SIZE) host.positionWindow.shift()
  const cellKey = exploredCellKey(position)
  host.exploredCells.delete(cellKey)
  host.exploredCells.add(cellKey)
  while (host.exploredCells.size > EXPLORED_CELLS_LIMIT) {
    const oldest = host.exploredCells.values().next().value
    if (oldest === undefined) break
    host.exploredCells.delete(oldest)
  }
  host.signals.exploredCells = host.exploredCells
  host.detectOscillation(position)
  if (host.positionWindow.length < LOCOMOTION_WINDOW_SIZE) return
  const first = host.positionWindow[0]
  const last = host.positionWindow[host.positionWindow.length - 1]
  if (first === undefined || last === undefined) return
  const observation = observeLocomotion(host.positionWindow)
  host.lastLocomotionObservation = observation
  host.logger.info(
    'agent',
    `MOVE_EFFICIENCY samples=${LOCOMOTION_WINDOW_SIZE} ${formatLocomotionObservation(observation)}`,
    { ...observation, windowStart: first, windowEnd: last },
    host.tickCounter,
  )
  host.detectMoveOscillation()
}


export function detectOscillation(host: StallObserverHost, position: Vec3Json): void {
  const decision = evaluateOscillation({
    position: positionKey(position),
    signature: host.oscillationSignature(),
    previous: host.oscillationState,
    // The goal key is passed separately so junk pickups (which change the
    // inventory part of the signature) cannot re-arm the loop detector.
    goal: host.currentGoalKey(),
  })
  host.oscillationState = decision.state
  if (!decision.detected || decision.line === null) return
  // #360: cumulative detection count for the active Option, so the semantic
  // layer can see 401 oscillation events that no longer change behaviour.
  host.signals.oscillationsDetected = (host.signals.oscillationsDetected ?? 0) + 1
  host.logger.warn(
    'agent',
    decision.line,
    { cycles: decision.state.cycles, pair: decision.state.pair, goal: host.currentGoalKey() },
    host.tickCounter,
  )
  host.escapeOscillation(decision.state)
}


export function escapeOscillation(host: StallObserverHost, state: OscillationState): void {
  host.oscillationState = null
  host.abandonedRetrievePaths.set('use_known_station', host.lastStateFingerprint)
  if (host.activeRetrieval !== null) {
    host.unreachableResources.add(host.retrievalKey(host.activeRetrieval))
    host.noteCandidateFailure(host.activeRetrieval.id)
  }
  if (host.lastDecisionId !== null) host.noteCandidateFailure(host.lastDecisionId)
  host.activeRetrieval = null
  host.retrievalTrack = null
  host.retrieveUnverified = null
  host.prereqForcedPath = null
  host.prereqProgress = null
  host.prereqLoggedKey = null
  host.retrievalEscalationPending = true
  host.logger.warn(
    'agent',
    `LOCAL_OSCILLATION_ESCAPE pair=${state.pair ?? 'pair'} cycles=${state.cycles} system2=false`,
    { pair: state.pair, cycles: state.cycles, boundary: 'local_recovery' },
    host.tickCounter,
  )
}


export function stateFingerprint(host: StallObserverHost, state: WorldState): string {
  const inventory = Object.entries(state.inventory.counts)
    .filter(([, count]) => count > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, count]) => `${name}=${count}`)
    .join(',')
  const position = `${Math.round(state.self.position.x)},${Math.round(state.self.position.y)},${Math.round(state.self.position.z)}`
  const stations = (state.signals.knownResources ?? [])
    .filter((resource) => resource.kind === 'station')
    .map((resource) => `${resource.name}@${resource.position.x},${resource.position.y},${resource.position.z}`)
    .sort()
    .join(';')
  const furnaces = (state.furnaces ?? [])
    .filter(isSensedStation)
    .map((station) => `${station.x},${station.y},${station.z}`)
    .sort()
    .join(';')
  const current = state.goalQueue?.current
  const goal = `${host.currentGoalKey()}|depth=${state.goalQueue?.depth ?? 0}|revision=${state.goalQueue?.revision ?? host.queue.revision}|optionInstance=${current?.semanticOptionInstanceId ?? current?.optionInstanceId ?? 'none'}|optionTemplate=${current?.semanticOptionTemplateId ?? current?.optionTemplateId ?? 'none'}`
  return `fp2|epoch=${host.options.worldEpoch}|pos=${position}|inv=${inventory}|stations=${stations}|furnaces=${furnaces}|goal=${goal}`
}


export function persistLocalOscillation(host: StallObserverHost): void {
  const signature = localOscillationPersistKey(host.localOscillation)
  if (signature === host.localOscillationPersisted) return
  host.localOscillationPersisted = signature
  const callback = host.options.onLocalOscillationChange
  if (callback === undefined) return
  try {
    callback(
      host.localOscillation === null ? null : { ...host.localOscillation, cells: [...host.localOscillation.cells] },
    )
  } catch (error) {
    host.logger.warn(
      'agent',
      'LOCAL_OSCILLATION_PERSIST_FAILED',
      { message: error instanceof Error ? error.message : String(error) },
      host.tickCounter,
    )
  }
}


export function resetNotExecutableDedupe(host: StallObserverHost): void {
  if (host.notExecutableRepeats > 0 && host.notExecutableKey !== null) {
    host.logger.info(
      'agent',
      `ROW_NOT_EXECUTABLE_HERE_REPEATS suppressed=${host.notExecutableRepeats} key=${host.notExecutableKey}`,
      { suppressed: host.notExecutableRepeats, key: host.notExecutableKey },
      host.tickCounter,
    )
  }
  host.notExecutableKey = null
  host.notExecutableRepeats = 0
}
