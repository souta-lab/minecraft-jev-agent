// Legacy outcome-accounting plane extracted from controller-legacy.ts.
// Owns the settled-action bookkeeping cluster: typed outcome taxonomy -> causal
// chain / decision-record completion, per-kind verified progress accounting,
// unverified-outcome budgeting and furnace prerequisite-path switching, typed
// failure streaks and the System2 wake boundary they feed. No authority moves:
// semantic termination still returns through the scheduler trigger and System2
// still crosses host.summonLlm.
import { classifyActionOutcome, evaluateUnverifiedBudget, formatActionUnverified, hasObservableProgress, truthfulActionOutcome, UNVERIFIED_ACTION_LIMIT } from '../actionPostcondition.ts'
import type { ActionOutcomeTaxonomy, TruthfulOutcome } from '../actionPostcondition.ts'
import type { OptionAttemptTracker } from '../abandonPolicy.ts'
import type { ActionCommitmentState } from '../candidateCommitment.ts'
import { blockId } from '../candidates.ts'
import type { Candidate, CandidateKind } from '../candidates.ts'
import { completeCausalChain, causalRecord, formatCausalLine } from '../causal.ts'
import type { JevAgentOptions } from '../controller-shared.ts'
import type { EscalationReason } from './escalation.ts'
import type { PendingDecision } from './decision-epochs.ts'
import { attachResult } from '../decisionlog.ts'
import type { DecisionLlmResummonLog } from '../decisionlog.ts'
import type { ExecutionResult, FailureCode } from '../executor.ts'
import type { GoalQueue } from '../goalQueue.ts'
import { writeOutcome } from '../jev.ts'
import type { EventLogger, JevResult, JsonlWriter } from '../jev.ts'
import type { SkillOutcomePacket } from '../jevSemanticProjection.ts'
import type { MoveFailureReason } from '../moveFailMemory.ts'
import type { CurrentOptionContext } from '../optionSpec.ts'
import type { PlaceRetryLedger } from '../placementGuard.ts'
import type { GuardCode } from '../policy.ts'
import { evaluateRetrieveAbandon, nextPrereqPath } from '../prereqOption.ts'
import type { PrereqDecision, PrereqPath, PrereqProgress, RetrieveUnverifiedState } from '../prereqOption.ts'
import type { ActionFailureEscalation, WaitStreakEscalation } from '../replanThrottle.ts'
import { pickHigherPriority, selectPostActionTrigger } from '../scheduler.ts'
import type { DecisionTrigger, TriggerEvent } from '../scheduler.ts'
import type { AgentSignals, GoalState, KnownResource, Vec3Json } from '../state.ts'
import { strategicStateKey } from '../strategicStall.ts'
import type { StrategicStallTracker } from '../strategicStall.ts'
import type { LlmSummonReason, System2Outcome, System2SemanticOutcome } from '../system2.ts'
import { recordSystem2SemanticAction } from '../system2CausalHistory.ts'
import { shouldWakeSystem2AfterLocalFailure } from '../system2Escalation.ts'
import { submitSystem2Handoff } from '../system2Handoff.ts'
import type { DigDir, DigMemory } from '../worldMemory.ts'
import type { Bot } from 'mineflayer'

export interface OutcomeAccountingHost {
  abandonRetrieveOption(line: string, candidate: Candidate, unverified: number): void
  actionCommitmentState: ActionCommitmentState | null
  readonly actionFailureEscalation: ActionFailureEscalation
  actionStart: Vec3Json | null
  readonly actionUnverified: Map<string, number>
  activeRetrieval: { id: string; resource: string; knownName: string; target: Vec3Json } | null
  blocksRemoved: number
  readonly bot: Bot
  currentDimension(): string
  currentGoalKey(): string
  currentOptionContext(): CurrentOptionContext | null
  decisionWriter: JsonlWriter
  deferredTrigger: TriggerEvent | null
  descendHaveBaseline: number
  readonly digMemory: DigMemory
  digOscillationReported: boolean
  dropObservations: number
  effectiveHave(): number
  emitSkillOutcomePacket(input: {
    actionId: string
    kind: CandidateKind
    /** the executor action lease epoch, or null when no lease was ever claimed */
    leaseEpoch: number | null
    status: string
    failure: string | null
    verified: boolean
    progressed: boolean
    itemsGained: number
    blockRemoved: boolean
    entityDefeated: boolean
    targetName: string | null
    candidate: Candidate | null
    verification: string
  }): SkillOutcomePacket
  escalate(reason: EscalationReason, detail: string): void
  failureStreak: number
  goal: GoalState
  harvestedGoalCount: number
  itemsCollected: number
  jevWriter: JsonlWriter
  lastProgress: number
  lastProgressAt: number
  logDigRouteProgress(result: ExecutionResult, candidate: Candidate): void
  logLevelScanStep(result: ExecutionResult, candidate: Candidate): void
  logger: EventLogger
  markOptionAbandoned(optionId: string | null, reason: string): void
  noteAscendOutcome(result: ExecutionResult, candidate: Candidate): void
  noteCandidateFailure(candidateId: string): void
  noteCandidateSuccess(candidateId: string): void
  noteRepeatedOutcome(
    result: ExecutionResult,
    candidate: Candidate,
    verified: boolean,
    progressKinds: readonly string[],
  ): void
  noteTypedActionFailure(reason: string, actionId: string, pending: PendingDecision | undefined): void
  onUnverifiedAction(result: ExecutionResult, postcondition: string, pending: PendingDecision | undefined): void
  advancePrereqAfterUnverified(): boolean
  observeLocalMotion(result: ExecutionResult, candidate: Candidate, taxonomy: ActionOutcomeTaxonomy): void
  onObjectiveComplete(): void
  readonly optionAttempts: OptionAttemptTracker
  options: JevAgentOptions
  pendingDecisions: Map<number, PendingDecision>
  pendingTrigger: TriggerEvent | null
  readonly placedStations: KnownResource[]
  readonly placementRetries: PlaceRetryLedger
  prereqForcedPath: PrereqPath | null
  prereqLoggedKey: string | null
  prereqPlan: PrereqDecision | null
  prereqProgress: PrereqProgress | null
  progressEpoch: number
  queue: GoalQueue
  recentEvents: string[]
  recentOutcomes: System2Outcome[]
  recentSemanticOutcomes: System2SemanticOutcome[]
  recordMoveFailure(candidate: Candidate, reason: MoveFailureReason): void
  recordMoveSuccess(candidate: Candidate): void
  recordSurfaceSearch(candidate: Candidate): void
  recordZeroProgressOutcome(result: ExecutionResult, candidate: Candidate, truthful: TruthfulOutcome): void
  requestDecision(trigger: DecisionTrigger, detail: Record<string, unknown>): void
  resetDescendBudgetAfterWorldChange(actionId: string, reason: 'verified_mine' | 'verified_move'): void
  retireFailedKnownRetrieve(candidate: Candidate, result: ExecutionResult): void
  retrievalArrived(candidate: Candidate): boolean
  retrievalTrack: { id: string; best: number; ticks: number; bestGap?: number } | null
  retrieveCompleted(candidate: Candidate, result: ExecutionResult): boolean
  retrieveUnverified: RetrieveUnverifiedState | null
  schedulePlaceRetry(result: ExecutionResult, candidate: Candidate): boolean
  semanticStateGeneration: number
  signals: AgentSignals
  skillOutcomeBoundary: boolean
  readonly strategicStall: StrategicStallTracker
  summonLlm(reason: LlmSummonReason, detail: string): DecisionLlmResummonLog | null
  surfaceSearchArrived(candidate: Candidate): boolean
  readonly tickCounter: number
  verifiedDigs: number
  readonly waitStreakEscalation: WaitStreakEscalation
  onDescendComplete(result: ExecutionResult, candidate: Candidate): void
  onRetrievalDescent(candidate: Candidate): void
  recordFailure(code: FailureCode | GuardCode | string | null, detail: string): void
}

/**
 * Map an executor failure code onto a movement-failure reason.
 *
 * `unreachable` is a DURABLE claim: it feeds the reachability gate and resource
 * retirement, so it must only be recorded when the coordinate was actually shown
 * unreachable (`path_no_path`, a refused tunnel entry). A timeout (`dig_timeout`,
 * `smelt_timeout`, `path_timeout`) or an unrelated action error is a STALL, not a
 * proof of unreachability - recording it as `unreachable` masked the real reason
 * and blacklisted reachable coordinates.
 */
export function moveFailureReason(failure: string | null): MoveFailureReason {
  switch (failure) {
    case 'path_no_path':
      return 'no_path'
    case 'path_stuck':
    case 'path_timeout':
    case 'action_timeout':
    case 'dig_timeout':
    case 'smelt_timeout':
      return 'stuck'
    case 'tunnel_entry_refused':
      return 'unreachable'
    default:
      return 'no_progress'
  }
}


export type MoveOutcome = 'arrived' | 'unverified' | 'no-progress'


/**
 * A MOVE/RETREAT is an arrival only when the executor verified it. A
 * `done/verified=false` action that wandered ≥0.5m is NOT progress: it must keep
 * charging the coordinate failure memory, otherwise a JUMP_FAILing MOVE target
 * resets its own blacklist and is re-selected forever (the live pit loop).
 */
export function classifyMoveOutcome(verified: boolean, moved: number): MoveOutcome {
  if (!verified) return 'unverified'
  return moved < 0.5 ? 'no-progress' : 'arrived'
}


/**
 * The one boundary between a finished RETRIEVE and the movement failure memory.
 *
 * A retrieve may reset the coordinate failure memory (`MOVE_FAILMEM_RESET`) only
 * when it COMPLETED. The executor's `verified` for a RETRIEVE means only that
 * the remaining distance decreased (or the target was entered); it is NOT
 * completion. The caller supplies `retrieveCompleted` - the target actually
 * arrived or the item was acquired (`retrieveCompleted` on the controller). A
 * partial distance closure, a vertical chunk or a dug staircase step is durable
 * `progressed`/`blockRemoved` evidence, never completion - it must not reset the
 * coordinate, and it must not be charged as zero progress either.
 *
 * Live M2 boundary (RC 42cb46e, target 36,56,41): the old gate was
 * `hasObservableProgress` alone, so
 * `arrival targetDistance=11.26m->11.25m y=59.5->58 vertical=reuse`
 * reset the coordinate while PATH_CALLBACK stayed `outcome=stuck`, the
 * inventory never gained raw_iron and HOP_PLAN / JUMP_ATTEMPT looped forever.
 * RC8 (run-mu8ue5dg-10amk) showed the same reset on a ~1 m closure of a 20 m
 * approach (`21.69m->20.42m`, no station arrival).
 * A `done`/`verified=false`/`progressDelta=0` retrieve with no observable change
 * is the #78 loop and charges the coordinate so it is eventually skipped.
 */
export function decideRetrieveMemory(
  result: Pick<ExecutionResult, 'status' | 'verified' | 'itemsGained' | 'blockRemoved' | 'progressed'>,
  retrieveCompleted?: boolean,
): { reset: boolean; charge: boolean } {
  const completed = result.status === 'done' && result.verified
  if (completed && (retrieveCompleted === undefined || retrieveCompleted)) return { reset: true, charge: false }
  return { reset: false, charge: !completed && !hasObservableProgress(result) }
}


/** Item names whose VERIFIED placement registers a usable smelt station. */
export const PLACED_STATION_ITEMS: ReadonlySet<string> = new Set(['furnace', 'blast_furnace', 'smoker'])


/**
 * The mirrored registration marker for a station this controller verified
 * placing. `source=placed` is deterministic truth: only the executor's strict
 * placement post-condition (the block exists at the target) reaches this path,
 * never a sensed or remembered coincidence.
 */
export function formatStationRegisteredPlaced(kind: string, at: Vec3Json): string {
  const x = Math.round(at.x)
  const y = Math.round(at.y)
  const z = Math.round(at.z)
  return `STATION_REGISTERED kind=${kind} source=placed at=${x},${y},${z}`
}


/**
 * Register a verified placed station in the in-generation station list.
 * Idempotent per (item, cell): a repeated verified placement at the same cell is
 * recorded once, so the STATION_REGISTERED marker fires exactly once per placed
 * cell while the station stays selectable for the rest of the generation.
 */
export function registerPlacedStation(
  stations: KnownResource[],
  item: string,
  at: Vec3Json,
  /**
   * The world the placement was VERIFIED in. A placed station is a world fact
   * like any remembered cell: without it the row is un-attributable and the
   * fail-closed dimension gate (#14, `resourceDimensionMatches`) refuses it as a
   * target in EVERY world. Optional only so a fixture can build the
   * un-attributed shape deliberately.
   */
  dimension?: string,
): { added: boolean; station: KnownResource } {
  const station: KnownResource = {
    name: item,
    kind: 'station',
    position: { x: Math.round(at.x), y: Math.round(at.y), z: Math.round(at.z) },
    ...(dimension === undefined ? {} : { dimension }),
  }
  const cellKey = (entry: { name: string; position: Vec3Json }): string =>
    `${entry.name}@${Math.round(entry.position.x)},${Math.round(entry.position.y)},${Math.round(entry.position.z)}`
  const key = cellKey(station)
  if (stations.some((entry) => cellKey(entry) === key)) return { added: false, station }
  stations.push(station)
  return { added: true, station }
}


/** A selected route after one of these outcomes starts a fresh local trajectory. */
export function closesDescentRecoveryBoundary(reason: unknown): reason is string {
  return (
    reason === 'descent_budget_exhausted' ||
    reason === 'recurrent_descent_trajectory' ||
    reason === 'selected_path_budget_exhausted' ||
    reason === 'selected_descent_blocked_or_spent' ||
    reason === 'selected_column_descent_blocked_or_spent'
  )
}


export function isActionTimeout(result: ExecutionResult): boolean {
  return result.failure === 'path_timeout' || result.failure === 'dig_timeout'
}


export function goalWithHave(goal: GoalState, have: number): GoalState {
  const required = Math.max(1, goal.requiredCount)
  return {
    ...goal,
    haveCount: have,
    progress: Math.min(1, have / required),
    complete: have >= required,
  }
}


export function onActionComplete(host: OutcomeAccountingHost,
result: ExecutionResult, decision: JevResult, candidate: Candidate): void {
  // A settled action (done / failed / cancelled) releases the in-flight
  // commitment immediately, so the next decision is free to choose again. The
  // epoch match keeps a stale completion from clearing a newer action's hold.
  if (
    host.actionCommitmentState !== null &&
    host.actionCommitmentState.actionId === result.actionId &&
    host.actionCommitmentState.epoch === result.epoch
  ) {
    host.actionCommitmentState = null
  }
  const moved =
    host.actionStart === null
      ? 0
      : Math.hypot(
          host.bot.entity.position.x - host.actionStart.x,
          host.bot.entity.position.y - host.actionStart.y,
          host.bot.entity.position.z - host.actionStart.z,
        )
  const moveArrived =
    (result.kind === 'MOVE' || result.kind === 'RETREAT') && classifyMoveOutcome(result.verified, moved) === 'arrived'
  const surfaceSearchArrived = result.kind === 'RETRIEVE' && host.surfaceSearchArrived(candidate)
  const exploreSearchArrived = result.kind === 'MOVE' && candidate.meta.explore === true && moveArrived
  const searchArrived = surfaceSearchArrived || exploreSearchArrived
  const retrieveArrived = result.kind === 'RETRIEVE' && !surfaceSearchArrived && host.retrievalArrived(candidate)
  const retrieveDistanceClosed = result.kind === 'RETRIEVE' && !surfaceSearchArrived && result.distanceClosed
  const truth = truthfulActionOutcome({
    kind: result.kind,
    status: result.status,
    verified: result.verified,
    itemsGained: result.itemsGained,
    blockRemoved: result.blockRemoved,
    progressed: result.progressed,
    entityDefeated: result.entityDefeated,
    damageObserved: result.damageObserved,
    arrived: moveArrived || retrieveArrived,
    distanceClosed: retrieveDistanceClosed,
    searchArrived,
    requiresPickup: candidate.meta.requiresPickup === true,
  })
  const semanticProgress =
    result.itemsGained > 0 ||
    (truth.verified && (result.kind === 'CRAFT' || result.kind === 'SMELT' || result.kind === 'PLACE' || result.kind === 'IGNITE'))
  const taxonomy: ActionOutcomeTaxonomy = classifyActionOutcome({
    kind: result.kind,
    status: result.status,
    verified: truth.verified,
    itemsGained: result.itemsGained,
    blockRemoved: result.blockRemoved,
    progressed: result.progressed,
    entityDefeated: result.entityDefeated,
    damageObserved: result.damageObserved,
    arrived: moveArrived || retrieveArrived || searchArrived,
    distanceClosed: retrieveDistanceClosed,
    searchArrived,
    semanticProgress,
    failureCode: result.failure,
  })
  if (surfaceSearchArrived && result.itemsGained === 0 && !result.blockRemoved) {
    host.recordSurfaceSearch(candidate)
  }
  if (taxonomy.progressKinds.some((kind) => kind === 'body' || kind === 'search' || kind === 'goal')) {
    host.progressEpoch += 1
    host.semanticStateGeneration += 1
    host.lastProgress += 1
    host.lastProgressAt = Date.now()
    // Observed progress (body/search/goal) resets the typed-action-failure
    // streak: the same action failing again is no longer one unbroken run.
    host.actionFailureEscalation.reset()
    // Real progress also ends any actionable-WAIT streak (#327 follow-up).
    host.waitStreakEscalation.reset()
  }
  host.recentOutcomes.push({
    actionId: result.actionId,
    status: result.status,
    failure: result.failure,
    verified: truth.verified,
    detail: result.detail,
    execution: taxonomy.execution,
    verification: taxonomy.verification,
    progress: taxonomy.progress,
    progressKinds: taxonomy.progressKinds,
    control: taxonomy.control,
  })
  if (host.recentOutcomes.length > 16) host.recentOutcomes.shift()
  // The cross-action bound: one settled action, one typed outcome, one target.
  // Deliberately NOT gated on `progressKinds` containing `body` - the measured
  // runaway was laundered by exactly that (an interleaved PILLAR_UP_STEP reports
  // `progress=body` while the same action keeps concluding `apex_missed` at the
  // same cell), and per `buddy-driver/AGENTS.md` section 5 body motion is never
  // completion. Only a changed TYPED OUTCOME or a changed grounding fact
  // signature restarts the streak.
  host.noteRepeatedOutcome(result, candidate, truth.verified, taxonomy.progressKinds)
  host.noteAscendOutcome(result, candidate)
  // #360: feed the settled decision to the state-recurrence evidence. This runs
  // once per settled action (not per tick), and `body` progress deliberately
  // does NOT clear the window: a successful MOVE is not semantic progress.
  host.signals.strategicNonProgress = host.strategicStall.note({
    optionInstanceId: host.currentOptionContext()?.instanceId ?? null,
    stateKey: strategicStateKey(host.bot.entity.position),
    progressKinds: taxonomy.progressKinds,
  })
  // #nonprogress-yield: a settled decision that showed `goal`/`search` progress
  // clears the optional-head bound. `body`/`none` deliberately do not.
  host.queue.noteSemanticProgress(taxonomy.progressKinds)
  // #plan-reconciliation: the same settled semantic progress clears the durable
  // no-productive-head bound (`noteSemanticProgress` above resets it on the row),
  // so only a head that genuinely never advances is escalated.
  // #oscillation-boundary: the BODY's own durable motion record. It is separate
  // from the queue-head bound above on purpose: that one is about the QUEUE's
  // head and is cleared by any tick that offers a productive candidate, while
  // this one is about the BODY's cell envelope and is cleared only by a real
  // change in the situation. It therefore also observes the ticks that the head
  // bound deliberately resets on.
  host.observeLocalMotion(result, candidate, taxonomy)

  writeOutcome(host.jevWriter, {
    callId: decision.callId,
    policy: decision.policy,
    actionId: result.actionId,
    executed: result.status !== 'cancelled',
    verified: truth.verified,
    failureCode: result.failure,
    goalProgress: result.goalItemCount,
    note: `${result.status}/${result.phase}: ${result.detail}`,
  })

  // §2: the ONE semantic result that crosses back into policy. The raw trace
  // (every swing/path node/hotbar step) stays in the run log; this packet is
  // what the next decision consumes as the previous outcome.
  host.emitSkillOutcomePacket({
    actionId: result.actionId,
    kind: result.kind,
    leaseEpoch: result.epoch,
    status: result.status,
    failure: result.failure,
    verified: truth.verified,
    progressed: result.progressed === true,
    itemsGained: result.itemsGained,
    blockRemoved: result.blockRemoved,
    entityDefeated: result.entityDefeated === true,
    targetName: result.targetName ?? candidate.targetName,
    candidate,
    verification: result.unverifiedPostcondition ?? taxonomy.verification,
  })

  const pending = host.pendingDecisions.get(result.epoch)
  host.recentSemanticOutcomes = recordSystem2SemanticAction(
    host.recentSemanticOutcomes,
    pending?.record.goalQueueState.current?.id ?? null,
    taxonomy.progressKinds,
  )
  let completedOptionId: string | null = null
  let completedPlanId: string | null = null
  if (pending !== undefined) {
    host.pendingDecisions.delete(result.epoch)
    completedOptionId = pending.record.optionId
    completedPlanId = pending.record.goalQueueState.current?.id ?? null
    attachResult(pending.record, {
      actionId: result.actionId,
      success: truth.status === 'done' && truth.verified,
      durationMs: result.ms,
      damageTaken: Math.max(0, pending.healthAtDecision - host.bot.health),
      progress: host.goal.progress,
      status: result.status,
      failureCode: result.failure,
      verified: truth.verified,
      blockRemoved: result.blockRemoved,
      dropObserved: result.dropObserved,
      damageObserved: result.damageObserved ?? false,
    })
    host.decisionWriter.write(pending.record)
    const chain = completeCausalChain(
      {
        chainId: pending.record.chainId ?? 'unknown',
        optionId: pending.record.optionId,
        semanticOptionInstanceId: pending.record.semanticOptionInstanceId,
        planId: pending.record.goalQueueState.current?.id ?? null,
        strategy: pending.record.strategy,
      },
      {
        candidateId: pending.record.chosenAction,
        actionId: result.actionId,
        verified: truth.verified,
        status: truth.status,
        resource: result.yieldItem ?? result.targetName ?? null,
        progressDelta: result.itemsGained,
        observable: truth.observableProgress,
        taxonomy,
      },
    )
    host.logger.info('causal', formatCausalLine(chain), causalRecord(chain), host.tickCounter)
    if (truth.downgraded) {
      host.logger.warn(
        'agent',
        `ACTION_ZERO_PROGRESS actionId=${result.actionId} kind=${result.kind} reason=verified_without_observable_progress rawStatus=${result.status}`,
        { actionId: result.actionId, kind: result.kind, verified: result.verified, detail: result.detail },
        host.tickCounter,
      )
    }
  }

  if (result.status === 'cancelled' || result.failure === 'cancelled') {
    host.logger.info(
      'agent',
      `action#${result.epoch} ${result.actionId} ended cancelled (preempted) - ownership handover complete`,
      { actionId: result.actionId, ms: result.ms },
      host.tickCounter,
    )
    return
  }

  host.retireFailedKnownRetrieve(candidate, result)
  host.recordZeroProgressOutcome(result, candidate, truth)
  if (result.unverifiedPostcondition !== undefined) {
    host.onUnverifiedAction(result, result.unverifiedPostcondition, pending)
  } else if (truth.status === 'done' && truth.verified) {
    const settledPlanId = pending?.record.goalQueueState.current?.id ?? host.queue.current?.id ?? null
    if (settledPlanId !== null) host.actionUnverified.delete(settledPlanId)
    // A verified success ends the run of typed failures for this plan/action.
    host.actionFailureEscalation.reset()
  }

  if (completedOptionId !== null) {
    host.optionAttempts.noteOutcome(
      {
        optionId: completedOptionId,
        planId: completedPlanId,
        verified: truth.verified,
        // Beta's option productivity is semantic/goal progress only. Body or
        // search progress remains visible in the typed taxonomy and resets the
        // strategic stall clock, but it must not masquerade as Option DONE.
        progressDelta: taxonomy.progress === 'goal' ? 1 : 0,
      },
      Date.now(),
    )
  }

  if (result.status === 'done') {
    if (result.kind === 'PLACE' && result.verified && candidate.itemName !== null) {
      host.placementRetries.noteVerified(candidate.itemName)
      if (candidate.target !== null && PLACED_STATION_ITEMS.has(candidate.itemName)) {
        const registered = registerPlacedStation(
          host.placedStations,
          candidate.itemName,
          candidate.target,
          host.currentDimension(),
        )
        if (registered.added) {
          host.logger.info(
            'agent',
            formatStationRegisteredPlaced('furnace', candidate.target),
            {
              kind: 'furnace',
              source: 'placed',
              at: `${Math.round(candidate.target.x)},${Math.round(candidate.target.y)},${Math.round(candidate.target.z)}`,
            },
            host.tickCounter,
          )
        }
      }
      if (candidate.meta.furnaceSource === 'held' && candidate.target !== null) {
        host.signals.heldFurnacePlacedAt = blockId('b', candidate.target)
      }
    }
    if (result.kind === 'MINE' && truth.verified) {
      if (result.blockRemoved) host.resetDescendBudgetAfterWorldChange(result.actionId, 'verified_mine')
      host.noteCandidateSuccess(result.actionId)
      host.verifiedDigs += 1
      if (result.blockRemoved) host.blocksRemoved += 1
      if (result.dropObserved) host.dropObservations += 1
      host.itemsCollected += result.itemsGained
      // A MINE only counts as one obtained goal item when the truth layer
      // verified it: a collect MINE whose drop was not picked up is a typed
      // failure (`pickup_failed`), never a completed collection.
      const current = host.queue.current
      if (result.blockRemoved && current !== null && result.yieldItem === current.targetItem) {
        host.harvestedGoalCount += 1
      }
      host.goal = goalWithHave(host.goal, host.effectiveHave())
      if (host.goal.progress > host.lastProgress) {
        host.lastProgress = host.goal.progress
        host.lastProgressAt = Date.now()
      }
      host.recentEvents.push(
        `dug ${result.actionId}; ${host.goal.targetItem} ${host.goal.haveCount}/${host.goal.requiredCount}`,
      )
      host.logger.info(
        'agent',
        `VERIFIED ${result.actionId} removed=${result.blockRemoved} gained=${result.itemsGained} goal=${host.goal.haveCount}/${host.goal.requiredCount} progress=${Math.round(host.goal.progress * 100)}%`,
        { actionId: result.actionId, ms: result.ms },
        host.tickCounter,
      )
      if (host.goal.complete && host.queue.current?.kind !== 'descend' && !host.options.singleShotPlanner) {
        host.onObjectiveComplete()
        return
      }
    }
    if (result.kind === 'DESCEND') host.onDescendComplete(result, candidate)
    // The dig route's own progress assertion: the step CLAIMED it lands closer
    // to the goal's target, so a settled step re-measures the distance. Only a
    // real decrease is reported.
    if (candidate.meta.digRoute === true) host.logDigRouteProgress(result, candidate)
    // The level-scan descent's own measured half: the level actually reached and the
    // distance to the target after the step. Only a real downward move is reported.
    if (candidate.meta.levelScan === true) host.logLevelScanStep(result, candidate)
    if (result.kind === 'RETRIEVE') {
      if (result.blockRemoved) host.onRetrievalDescent(candidate)
      // Only a COMPLETED retrieval - the target actually arrived or the item
      // was acquired - retires the active target and resets the coordinate
      // failure memory. A measured distance closure or a vertical chunk is
      // `progressed` evidence, NOT completion: RC8 (run-mu8ue5dg-10amk) closed
      // ~1 m of a 20 m approach and still reset `MOVE_FAILMEM`, re-arming the
      // live horizontal dead end (`outcome=stuck` + `MOVE_FAILMEM_RESET`).
      const retrieveMemory = decideRetrieveMemory(result, host.retrieveCompleted(candidate, result))
      if (truth.resetsFailureMemory && retrieveMemory.reset) {
        host.activeRetrieval = null
        host.retrievalTrack = null
        host.noteCandidateSuccess(result.actionId)
        host.recordMoveSuccess(candidate)
      } else if (!truth.replanProgress && !truth.observableProgress) {
        // A retrieval that reports completion while producing nothing
        // observable must charge the coordinate failure memory so it is
        // eventually skipped, and it must never be recorded as a verified
        // success (`status=done verified=false progressDelta=0`). Bounded
        // body progress (`replanProgress`) is not zero progress.
        host.recordMoveFailure(candidate, 'no_progress')
      }
      if (truth.status === 'unreached') {
        host.logger.warn(
          'agent',
          `ACTION_RETRIEVE_UNREACHED actionId=${result.actionId} progressed=${result.progressed} blockRemoved=${result.blockRemoved} (progressed without closure)`,
          { actionId: result.actionId, target: candidate.target, progressed: result.progressed },
          host.tickCounter,
        )
      }
      if (result.actionId.startsWith('RETRIEVE:known:station:furnace')) {
        const outcome = evaluateRetrieveAbandon({
          actionId: result.actionId,
          verified: truth.verified,
          progressDelta: result.itemsGained,
          previous: host.retrieveUnverified,
        })
        host.retrieveUnverified = outcome.state
        if (outcome.abandon && outcome.line !== null) {
          host.abandonRetrieveOption(outcome.line, candidate, outcome.state.unverified)
        }
      }
    }
    if ((result.kind === 'MOVE' || result.kind === 'RETREAT') && host.actionStart !== null) {
      const outcome = classifyMoveOutcome(result.verified, moved)
      switch (outcome) {
        case 'arrived':
          host.recordMoveSuccess(candidate)
          break
        case 'unverified':
        case 'no-progress': {
          if (moved < 0.5) {
            const p = host.bot.entity.position
            const region = `${Math.floor(p.x)}_${Math.floor(p.y)}_${Math.floor(p.z)}`
            const value = Math.round(moved * 100) / 100
            host.logger.warn(
              'agent',
              `MOVE_OSCILLATE travelled=${value} net=${value} progress=0 region=${region} -> spatial_failure`,
              { actionId: result.actionId, region },
              host.tickCounter,
            )
          }
          host.noteCandidateFailure(result.actionId)
          host.recordMoveFailure(candidate, 'no_progress')
          break
        }
      }
    }
    host.actionStart = null
    if (!truth.downgraded && result.kind !== 'WAIT' && result.kind !== 'ESCALATE') {
      host.failureStreak = 0
      host.signals.consecutiveFailures = 0
    }
  } else if (result.kind === 'PLACE' && host.schedulePlaceRetry(result, candidate)) {
    host.noteCandidateFailure(result.actionId)
  } else {
    if (result.kind !== 'ESCALATE' && result.kind !== 'WAIT') {
      host.noteCandidateFailure(result.actionId)
      host.recordMoveFailure(candidate, moveFailureReason(result.failure))
      host.recordFailure(result.failure, `${result.actionId}: ${result.detail}`)
      // #78 follow-up: bound the OTHER loop - the same plan re-offered with its
      // action failing the same typed way. `onUnverifiedAction` owns unverified
      // postconditions with its own budget, and a PLACE retry was handled above,
      // so neither reaches here as an unhandled typed failure.
      if (result.unverifiedPostcondition === undefined && result.failure !== null) {
        host.noteTypedActionFailure(result.failure, result.actionId, pending)
      }
    } else {
      host.logger.info(
        'agent',
        `CONTROL_OUTCOME kind=${result.kind} status=${result.status} failure=${result.failure ?? 'null'} not_charged_as_physical_failure`,
        { actionId: result.actionId, status: result.status, failure: result.failure, control: result.kind === 'ESCALATE' ? 'escalate' : 'wait' },
        host.tickCounter,
      )
    }
  }

  const completionTrigger: DecisionTrigger = isActionTimeout(result) ? 'action_timeout' : 'action_completed'
  const deferred = host.deferredTrigger
  host.deferredTrigger = null
  if (result.kind === 'ESCALATE') {
    const candidateReason =
      typeof candidate.meta.reason === 'string' ? candidate.meta.reason.slice(0, 120) : 'selected_by_jev'
    const capabilities =
      typeof candidate.meta.capabilities === 'string' ? candidate.meta.capabilities.slice(0, 180) : ''
    const reason: LlmSummonReason = host.queue.current === null ? 'queue_empty' : 'action_impossible'
    const detail =
      `Jev selected ESCALATE actionId=${result.actionId} leaseEpoch=${result.epoch} ` +
      `candidateReason=${candidateReason}${capabilities.length > 0 ? ` capabilities=${capabilities}` : ''}`
    const handoff = submitSystem2Handoff({ reason, detail }, (summonReason, summonDetail) =>
      host.summonLlm(summonReason, summonDetail),
    )
    if (handoff.status === 'submitted') {
      host.logger.warn(
        'system2',
        `ESCALATE_HANDOFF status=submitted actionId=${result.actionId} leaseEpoch=${result.epoch} requestId=${handoff.requestId ?? 'unknown'} reason=${handoff.reason}`,
        {
          status: handoff.status,
          actionId: result.actionId,
          leaseEpoch: result.epoch,
          requestId: handoff.requestId,
          reason: handoff.reason,
          detail: handoff.detail,
        },
        host.tickCounter,
      )
    } else {
      host.logger.error(
        'system2',
        `ESCALATE_HANDOFF status=unavailable actionId=${result.actionId} leaseEpoch=${result.epoch} reason=${handoff.reason} blocker=${handoff.blocker}`,
        {
          status: handoff.status,
          actionId: result.actionId,
          leaseEpoch: result.epoch,
          reason: handoff.reason,
          detail: handoff.detail,
          blocker: handoff.blocker,
        },
        host.tickCounter,
      )
    }
    // ESCALATE is a control-plane request, not a physical Skill completion.
    // The System2 response schedules the next decision after dispatch. If the
    // request is suppressed, wait for a separate wake instead of immediately
    // asking Jev to select ESCALATE again from unchanged facts. Preserve any
    // independent trigger that arrived while the control action settled; when
    // dispatch succeeds it coalesces with the System2 response, and when it is
    // unavailable it becomes the explicit next wake. Safety triggers therefore
    // retain their normal priority without manufacturing an action-completed
    // retry from the ESCALATE request itself.
    if (deferred !== null) {
      if (handoff.status === 'submitted') {
        host.pendingTrigger = pickHigherPriority(host.pendingTrigger, deferred)
      } else {
        host.requestDecision(deferred.trigger, deferred.detail)
      }
    }
    return
  }
  const next = selectPostActionTrigger(deferred, {
    trigger: completionTrigger,
    detail: { actionId: result.actionId, status: result.status, failure: result.failure },
    ts: Date.now(),
  })
  host.requestDecision(next.trigger, next.detail)
}


/**
 * #79: a `done`/`verified=false`/`progressDelta=0` action is a FAILURE. Log
 * ACTION_UNVERIFIED with the plan/strategy/post-condition, charge the failure,
 * advance the furnace prerequisite path so the plan is never re-queued
 * unchanged, and after UNVERIFIED_ACTION_LIMIT attempts for one planId emit
 * `ABANDON_REASON=action_unverified` and wake System 2 for a different option.
 */
export function onUnverifiedAction(host: OutcomeAccountingHost,
result: ExecutionResult, postcondition: string, pending: PendingDecision | undefined): void {
  const planId = pending?.record.goalQueueState.current?.id ?? host.queue.current?.id ?? null
  const strategy = pending?.record.strategy ?? null
  const key = planId ?? result.actionId
  const attempts = (host.actionUnverified.get(key) ?? 0) + 1
  host.actionUnverified.set(key, attempts)
  host.logger.warn(
    'agent',
    formatActionUnverified({ planId, actionId: result.actionId, strategy, postcondition }),
    { planId, actionId: result.actionId, strategy, attempts, postcondition, progressDelta: result.itemsGained, detail: result.detail },
    host.tickCounter,
  )
  host.noteCandidateFailure(result.actionId)
  host.recordFailure('verify_failed', `${result.actionId} unverified: ${result.detail}`)

  const switched = host.advancePrereqAfterUnverified()
  const budget = evaluateUnverifiedBudget({ attempts, limit: UNVERIFIED_ACTION_LIMIT, planId: key, strategy })
  if (budget.abandon) {
    host.markOptionAbandoned(result.actionId, 'action_unverified')
    host.logger.warn(
      'agent',
      budget.line ?? `ABANDON_REASON=action_unverified planId=${key} attempts=${attempts} strategy=${strategy ?? 'null'}`,
      { planId: key, attempts, strategy, switched, postcondition },
      host.tickCounter,
    )
  }
  if (budget.abandon) {
    // This is now a semantic boundary: the current Option exhausted its
    // code-owned postcondition budget. A single local verification miss is
    // evidence for Jev/Skill recovery, not a new System2 mission.
    host.summonLlm(
      'action_impossible',
      `semantic option exhausted after unverified outcome planId=${key} attempts=${attempts} strategy=${strategy ?? 'null'}`,
    )
  } else if (switched) {
    host.logger.info(
      'agent',
      `LOCAL_PREREQ_RECOVERY planId=${key} attempts=${attempts} next_path_selected=true system2=false`,
      { planId: key, attempts, strategy, postcondition },
      host.tickCounter,
    )
  } else {
    host.logger.info(
      'agent',
      `LOCAL_VERIFY_RECOVERY planId=${key} attempts=${attempts} system2=false`,
      { planId: key, attempts, strategy, postcondition },
      host.tickCounter,
    )
  }
}


/**
 * #79/#58: an unverified prerequisite attempt must not repeat the same path.
 * Advance the scored furnace-prerequisite plan to the next feasible option
 * (place_held -> use_known_station -> craft_and_place). The parent goal is
 * never abandoned here.
 */
export function advancePrereqAfterUnverified(host: OutcomeAccountingHost): boolean {
  if (host.prereqPlan === null) return false
  const current = host.prereqForcedPath ?? host.prereqPlan.chosen
  if (current === null) return false
  const next = nextPrereqPath(host.prereqPlan, current)
  if (next === null) return false
  host.prereqForcedPath = next
  host.prereqProgress = null
  host.prereqLoggedKey = null
  host.logger.warn(
    'agent',
    `PREREQ_SWITCH from=${current} to=${next} reason=action_unverified`,
    { from: current, to: next, reason: 'action_unverified', goal: host.currentGoalKey() },
    host.tickCounter,
  )
  return true
}


export function onDescendComplete(host: OutcomeAccountingHost,
result: ExecutionResult, candidate: Candidate): void {
  const recoveryBoundaryReason = candidate.meta.recoveryBoundaryReason
  if (closesDescentRecoveryBoundary(recoveryBoundaryReason)) {
    // Jev has selected a grounded route after the previous trajectory reached
    // its typed boundary. Give that new route its own bounded mechanical
    // continuation budget; otherwise the exhausted latch would evict the
    // newly selected heading/mode again on every following dig.
    host.digMemory.beginSelectedRecoveryPath()
    host.digOscillationReported = false
    host.logger.info(
      'agent',
      `DESCEND_RECOVERY_SELECTED reason=${recoveryBoundaryReason} action=${result.actionId}`,
      {
        actionId: result.actionId,
        reason: recoveryBoundaryReason,
        dir: candidate.meta.dir ?? null,
        mode: candidate.meta.mode ?? null,
        target: candidate.target,
        outcome: candidate.meta.skillOutcome ?? null,
        authority: 'jev_pi',
      },
      host.tickCounter,
    )
  }
  const target = candidate.target
  const dir = candidate.meta.dir
  if (target !== null && (dir === 'E' || dir === 'W' || dir === 'N' || dir === 'S' || dir === 'D')) {
    host.digMemory.record({
      x: target.x,
      y: target.y,
      z: target.z,
      dir,
      mode: candidate.meta.mode === 'down' ? 'down' : 'level',
      target: typeof candidate.meta.focusItem === 'string' ? candidate.meta.focusItem : null,
      atMs: Date.now(),
    })
  }
  const have = host.effectiveHave()
  const delta = have - host.descendHaveBaseline
  const y = host.bot.entity.position.y
  const yProgressed = host.actionStart !== null && y < host.actionStart.y - 0.5
  const descending = host.queue.current?.kind === 'descend'
  if (delta > 0 || (descending && yProgressed)) {
    host.descendHaveBaseline = have
    // Predicate descent has already made monotone Y progress inside its current
    // Skill. Reset its no-progress budget, while keeping the chosen heading and
    // mode so the next safe step remains a mechanical continuation. A collected
    // resource changes the search state, so that separate semantic progress
    // starts with a fresh path.
    if (descending && yProgressed) host.digMemory.resetDescendBudget()
    else host.digMemory.markResourceProgress()
    // A descending predicate goal makes progress by losing altitude, not by
    // gaining items, so a verified drop must also reset the progress-stall clock.
    if (descending && yProgressed) host.lastProgressAt = Date.now()
  } else {
    // No resource delta is evidence about this trajectory, not a mandate to
    // switch to lateral search. Keep the active path contract intact; when the
    // bounded budget is exhausted, grounding returns distinct alternatives to
    // Jev instead of installing one recovery strategy here.
    const budgetAlreadyExhausted = host.digMemory.snapshot().descendLimitReached
    const budget = host.digMemory.markDescend(false)
    host.logger.info(
      'agent',
      `DESCEND_NO_PROGRESS action=${result.actionId} resourceDelta=${delta} streak=${budget.noProgress}`,
      { actionId: result.actionId, resourceDelta: delta, noProgress: budget.noProgress },
      host.tickCounter,
    )
    host.logger.info(
      'agent',
      `DESCEND_PROGRESS actionSuccess=true resourceDelta=${delta} streak=${budget.noProgress}`,
      { actionId: result.actionId, noProgress: budget.noProgress },
      host.tickCounter,
    )
    if (budget.limitReached && !budgetAlreadyExhausted) {
      host.skillOutcomeBoundary = true
      host.logger.warn(
        'agent',
        `DESCEND_LIMIT depth=${host.digMemory.depth} noProgress=${budget.noProgress} outcome=BUDGET_EXHAUSTED recovery=policy_boundary`,
        { actionId: result.actionId, outcome: 'BUDGET_EXHAUSTED', recoveryAuthority: 'jev_pi' },
        host.tickCounter,
      )
      host.signals.descendLimitReached = true
    }
    if (budget.limitReached) host.signals.descendLimitReached = true
  }
  const oscillating = host.digMemory.isOscillating()
  if (oscillating && !host.digOscillationReported) {
    host.skillOutcomeBoundary = true
    const net = Math.round(host.digMemory.netDisplacement() * 100) / 100
    host.logger.warn(
      'agent',
      `DIG_OSCILLATE net=${net} outcome=RECURRENT_STATE recovery=policy_boundary`,
      { actionId: result.actionId, dir: host.digMemory.dir, outcome: 'RECURRENT_STATE', recoveryAuthority: 'jev_pi' },
      host.tickCounter,
    )
  }
  host.digOscillationReported = oscillating
}


/**
 * Issue #45: a RETRIEVE that dug its own staircase records the new tunnel cell
 * so the next retrieval can prefer `REUSE_TUNNEL` over digging a fresh one.
 */
export function onRetrievalDescent(host: OutcomeAccountingHost,
candidate: Candidate): void {
  if (candidate.meta.vertical !== 'staircase') return
  const x = candidate.meta.stairStepX
  const y = candidate.meta.stairStepY
  const z = candidate.meta.stairStepZ
  const dir = candidate.meta.stairDir
  if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') return
  if (typeof dir !== 'string') return
  host.digMemory.record({
    x,
    y,
    z,
    dir: dir as DigDir,
    mode: 'down',
    target: typeof candidate.meta.resource === 'string' ? candidate.meta.resource : null,
    atMs: Date.now(),
  })
}


export function recordFailure(host: OutcomeAccountingHost,
code: FailureCode | GuardCode | string | null, detail: string): void {
  host.failureStreak += 1
  host.signals.consecutiveFailures = host.failureStreak
  host.signals.lastFailureCode = code
  host.recentEvents.push(`failure ${code ?? 'unknown'}: ${detail}`)
  host.logger.warn(
    'agent',
    `failure streak ${host.failureStreak}/${host.options.failureStreakLimit} code=${code ?? 'unknown'}`,
    { detail },
    host.tickCounter,
  )
  const boundary = shouldWakeSystem2AfterLocalFailure({
    failureCode: code,
    activeOption: host.queue.current !== null,
    semanticExhausted: false,
    semanticInvalid: false,
    semanticAbandoned: false,
  })
  const localRouteFailure = code === 'path_no_path' || code === 'path_stuck' || code === 'no_path' || code === 'no_standable_approach' || code === 'open_path'
  if (localRouteFailure && !boundary.wake && boundary.reason === 'local_recovery') {
    // A local route failure is evidence for grounded Jev/Skill recovery. It is
    // not a semantic mission boundary and must not summon System2 by itself.
    host.logger.info(
      'agent',
      `LOCAL_ROUTE_FAILURE code=${code ?? 'unknown'} system2=false detail=${detail}`,
      { code, detail, failureStreak: host.failureStreak, boundary: boundary.reason },
      host.tickCounter,
    )
  } else if (code === 'unknown_event') host.escalate('unknown_event', detail)
  else if (code === 'verify_failed') {
    host.logger.info('agent', `LOCAL_VERIFY_FAILURE system2=false detail=${detail}`, { code, detail }, host.tickCounter)
  }
  // `verify_failed` used to be excluded here on the theory that the unverified
  // ACTION budget bounds it instead. Measured live: that budget is keyed per plan
  // (falling back to the action id) and both rotate as the body re-decides - the log
  // shows `ACTION_UNVERIFIED planId=null ... attempts=1` every time and
  // `ABANDON_REASON=action_unverified` ZERO times in the whole run, while one ATTACK
  // ended `MECHANICALLY_BLOCKED failure=verify_failed` three times in a row (30 such
  // attacks: the single most common ATTACK outcome). The operator saw the result
  // directly - "ずっと攻撃モードになってて次の行動を再開しない", stuck in attack mode and
  // never resuming. A repeated verification failure is exactly what this streak bound
  // exists for, so it is no longer excluded.
  if (host.failureStreak >= host.options.failureStreakLimit && !localRouteFailure) {
    host.escalate('same_failure_3x', `${code ?? 'unknown'} failed ${host.failureStreak}x: ${detail}`)
  }
}
