// reach-controller-plane.ts — V4.1.2 Reach controller plane.
//
// Extracted from `controller-legacy.ts`. This module owns the Reach slice
// orchestration: mission projection, admission/dispatch, mechanical-step
// authorization and settlement, terminalization, verification logging, and the
// model-recovery drain for a pre-committed transition.
//
// Authority invariants (unchanged by the extraction):
// - Reach state lives in `ReachMissionRuntime`; this module only orchestrates
//   over it through the `ReachPlaneHost` port. It is not a second semantic
//   source of truth.
// - Mutation authority stays exactly one path: kernel `issueStepEffect` via
//   `reachRuntimeAdapter.dispatch` under an active contract.
// - Terminal authority stays exactly one kernel `terminalize` path.
// - SUCCESS stays exactly one kernel `VERIFY_SUCCESS` path from observed proof.
// - When the kernel/refusal declines or holds, this plane holds or closes the
//   transition; it never falls back to legacy Reach scheduling.
//
// The legacy controller calls these functions with itself as `host`; tests
// stub the `host.*` callbacks exactly as they stubbed the former private
// methods, so the dispatch seam is preserved one-for-one.

import { randomUUID } from 'node:crypto'
import type { Candidate } from '../candidates.ts'
import { CRITICAL_COMBAT_HEALTH } from '../candidates.ts'
import { sensorOptions, candidateOptions, MODEL_RECOVERY_DRAIN_GRACE_MS } from '../controller-shared.ts'
import type { RecipeIndex } from '../crafting.ts'
import type { DecisionRecordProvenance } from '../decisionlog.ts'
import type { CurrentAction, Executor } from '../executor.ts'
import type { GoalQueueState } from '../goalQueue.ts'
import type { JevReachRouteDecisionRecord } from './jev-composition.ts'
import type { EventLogger } from '../jev.ts'
import type { StateFingerprintMemory } from '../moveFailMemory.ts'
import type { PlaceRetryLedger } from '../placementGuard.ts'
import type { PrereqRankPolicy } from '../prereqOption.ts'
import {
  projectMinecraftReachMission,
  minecraftMissionSourceNames,
  isMissionReachWalkAction,
} from '../minecraft/reach-mission-projection.ts'
import type { DecisionTrigger, TriggerEvent } from '../scheduler.ts'
import { pickHigherPriority } from '../scheduler.ts'
import {
  bodyNeedsBreathEscape,
} from '../state.ts'
import type {
  AgentSignals,
  DimensionProvenance,
  GoalState,
  KnownResource,
  Vec3Json,
  WorldState,
} from '../state.ts'
import {
  countMissionInventoryResource,
} from './transition.ts'
import type {
  ReachIdentity,
  ReachTerminalOutcome,
  ReachTransitionContract,
  ReachTransitionState,
} from './transition.ts'
import type { ReachControllerResult, ReachMechanicalIntent, ReachRuntimeSnapshot } from './controller.ts'
import type { ReachMissionRuntime, ReachMissionRuntimeSession } from './mission-runtime.ts'
import type { ReachMissionSnapshotOptions } from './mission-projection.ts'
import type { ReachMechanicalActionOutcome, ReachRuntimePorts } from './ports.ts'
import type { InventoryReachMission } from './scheduler.ts'
import { assessReachViability } from './safety.ts'

/** Local alias matching `controller-legacy.ts`'s exported `VtrInventoryMission`. */
type VtrInventoryMission = InventoryReachMission

/** Session metadata projected read-only out of `ReachMissionRuntime`. */
export type ActiveReachTransition = Readonly<ReachMissionRuntimeSession> & {
  readonly contract: ReachTransitionContract
  readonly state: ReachTransitionState
}

/** Correlates a per-step terminal with the executor result that settles that same lease. */
export interface ReachTerminalActionCorrelation {
  readonly transitionId: string
  readonly intentId: string
  readonly actionId: string
  readonly outcomeKind: ReachTerminalOutcome['kind']
}

/** Narrow options slice the Reach plane reads; `JevAgentOptions` satisfies it structurally. */
export interface ReachPlaneOptions {
  readonly serverId: string
  readonly worldEpoch: number
  readonly reach: number
  readonly scanRadius: number
  readonly maxCandidateAgeTicks: number
  readonly dimensionProvenance?: DimensionProvenance | null
  readonly prereqRankPolicy: PrereqRankPolicy
  readonly vtrMission?: InventoryReachMission | null
  readonly vtrReachProbe?: boolean
  readonly decisionProvenance: Readonly<DecisionRecordProvenance>
  readonly actuationPort?: { readonly generationId?: string; assertLease(what: string): void } | null
}

/**
 * The host surface the Reach plane needs from the integration shell
 * (`JevController` in production, plain-object fixtures in tests). Methods map
 * one-for-one to the exported functions below so the shell's delegates keep
 * the original private-method stub seam intact.
 */
export interface ReachPlaneHost {
  options: ReachPlaneOptions
  logger: EventLogger

  // VTR-owned runtime state (projections; the runtime remains authoritative).
  reachRuntime: ReachMissionRuntime
  reachRuntimeAdapter: ReachRuntimePorts
  readonly reachTransition: ActiveReachTransition | null
  reachRunMetadata: Readonly<ReachMissionRuntimeSession> | null
  reachRunMetadataFixture: Readonly<ReachMissionRuntimeSession> | null
  reachRouteDecisionWorld: WorldState | null
  lastVtrReachRouteDecision: JevReachRouteDecisionRecord | null
  reachabilityProofs: StateFingerprintMemory
  pendingReachTerminalAction: ReachTerminalActionCorrelation | null
  lastReachActionFailure: string | null

  // Model-recovery drain bookkeeping for a pre-committed transition.
  modelRecoveryStopping: boolean
  modelRecoveryDrainTimer: NodeJS.Timeout | null
  modelRecoveryReachDrainTransitionId: string | null
  modelRecoveryReachDrainAdvancing: boolean
  modelRecoveryReachDrainPending: boolean

  // Lifecycle/counter cells owned by the shell.
  startedAt: number
  running: boolean
  ticking: boolean
  tickCounter: number
  jevCalls: number
  runtimeLlmCalls: number
  planCalls: number
  deferredTrigger: TriggerEvent | null
  actionStart: Vec3Json | null

  // Narrow slices of legacy collaborators.
  executor: Pick<Executor, 'current' | 'cancelCurrent'>
  queue: { readonly current: { readonly origin: string } | null }
  scheduler: { readonly worldRevision: number | null }
  recipeIndex: RecipeIndex
  signals: AgentSignals
  searchedSurfaceTargets: ReadonlySet<string>
  placementRetries: Pick<PlaceRetryLedger, 'retiredItemSet'>

  // Reach callbacks (dispatch through the shell's delegates).
  noteReachAuthorityConflict(): void
  noteReachHealth(health: number): number
  beginModelRecoveryReachDrain(runtime: ActiveReachTransition): void
  advanceModelRecoveryReachDrain(transitionId: string, trigger: string): Promise<void>
  completeModelRecoveryReachDrain(transitionId: string, outcome: string): void
  reachIdentity(state: WorldState): ReachIdentity | null
  liveReachIdentity(fallback: ReachIdentity): ReachIdentity
  buildReachWorldState(mission: InventoryReachMission): WorldState
  projectReachMission(
    mission: InventoryReachMission,
    state: WorldState,
    identity: ReachIdentity,
    contract?: ReachTransitionContract | null,
    snapshotOptions?: ReachMissionSnapshotOptions,
  ): ReturnType<typeof projectMinecraftReachMission>
  currentVtrReachRouteDecision(): JevReachRouteDecisionRecord | null
  dispatchReachIntent(
    result: ReachControllerResult,
    state: WorldState,
    identity: ReachIdentity,
    candidates: readonly Candidate[],
  ): Promise<boolean>
  logReachActuation(
    intent: ReachMechanicalIntent,
    actionId: string | null,
    epoch: number,
    candidateId: string,
    guardedCandidate: Candidate,
  ): void
  releaseUnstartedReachIntent(intentId: string, transitionId: string, evidence: string): Promise<void>
  tickReachTransition(trigger: DecisionTrigger, detail: Record<string, unknown>): Promise<boolean>
  authorizeReachMechanicalStep(
    intentId: string,
    identity: ReachIdentity,
    step: { stepId: string; leg: number; effectKind: 'locomotion' },
  ): boolean
  recordReachMechanicalOutcome(
    intentId: string,
    identity: ReachIdentity,
    step: { stepId: string; leg: number; effectKind: 'locomotion' },
  ): boolean | 'verified-terminal'
  onReachActionComplete(
    result: ReachMechanicalActionOutcome,
    candidate: Candidate,
    transitionId: string,
    intentId: string,
  ): Promise<void>
  closeReachTransition(
    reportedOutcome: ReachTerminalOutcome,
    reportedState: ReachTransitionState,
    boundary: string,
    cancelIntentId?: string | null,
    action?: { readonly intentId: string; readonly actionId: string },
  ): boolean
  logReachVerification(outcome: ReachTerminalOutcome, snapshot: ReachRuntimeSnapshot): void

  // Sensor/observer collaborators that stay on the shell.
  knownResourcesForSensor(): KnownResource[]
  mergeRememberedPortalFrame(state: WorldState): WorldState
  syncTerrainSignals(state: WorldState): void
  observeThreatState(state: WorldState): void
  observeUnansweredRangedThreat(state: WorldState): void
  observeEnvHazard(state: WorldState): void
  unreachableStationKeys(state: WorldState): ReadonlySet<string>
  blacklistedMoveTargets(state: WorldState): ReadonlySet<string>
  requestDecision(trigger: DecisionTrigger, detail: Record<string, unknown>): void
  noteCandidateFailure(candidateId: string): void
  noteCandidateSuccess(candidateId: string): void
  finish(stopped: string, success: boolean): void
}

export function noteReachAuthorityConflict(host: ReachPlaneHost): void {
    const runtime = host.reachRuntime as ReachMissionRuntime | undefined
    if (typeof runtime?.noteAuthorityConflict === 'function') {
      runtime.noteAuthorityConflict()
      return
    }
    const fixture = host.reachRunMetadataFixture as ({ duplicateAuthorityObserved: boolean } | null)
    if (fixture !== null) fixture.duplicateAuthorityObserved = true
  }

export function noteReachHealth(host: ReachPlaneHost, health: number): number {
    const runtime = host.reachRuntime as ReachMissionRuntime | undefined
    if (typeof runtime?.noteMissionHealth === 'function') return runtime.noteMissionHealth(health)
    const fixture = host.reachRunMetadataFixture as ({ lastHealth: number } | null)
    if (fixture === null || !Number.isFinite(health)) return 0
    const damage = Math.max(0, fixture.lastHealth - health)
    fixture.lastHealth = health
    return damage
  }

export function beginModelRecoveryReachDrain(host: ReachPlaneHost, runtime: ActiveReachTransition): void {
    const transitionId = runtime.contract.transitionId
    host.modelRecoveryReachDrainTransitionId = transitionId
    const deadlineAt = runtime.state.startedAtMs + runtime.contract.budget.maxElapsedMs + MODEL_RECOVERY_DRAIN_GRACE_MS
    const deadlineDelayMs = Math.max(0, deadlineAt - Date.now())
    host.logger.warn(
      'agent',
      `MODEL_RECOVERY_DRAIN phase=begin transitionId=${transitionId} kind=reach_transition budgetMs=${runtime.contract.budget.maxElapsedMs} remainingMs=${deadlineDelayMs}`,
      {
        transitionId,
        contractHash: runtime.contract.contractHash,
        ensures: runtime.contract.ensures,
        mechanicalSteps: runtime.state.usage.mechanicalSteps,
        budgetMs: runtime.contract.budget.maxElapsedMs,
        deadlineAt,
        authority: 'vtr-reach-controller',
      },
      host.tickCounter,
    )
    host.modelRecoveryDrainTimer = setTimeout(() => {
      host.modelRecoveryDrainTimer = null
      if (host.reachTransition?.contract.transitionId !== transitionId) {
        host.finish('stopped-by-caller', false)
        return
      }
      const current = host.executor.current
      if (
        current !== null && current.status === 'running' &&
        current.authority === 'vtr-reach' && current.transitionId === transitionId
      ) {
        host.logger.warn(
          'agent',
          `MODEL_RECOVERY_DRAIN phase=deadline transitionId=${transitionId} actionId=${current.id} -> cancel over-budget Reach leg`,
          { transitionId, actionId: current.id, epoch: current.epoch, contractHash: runtime.contract.contractHash },
          host.tickCounter,
        )
        host.executor.cancelCurrent('model recovery Reach contract exceeded its committed time budget')
      }
      void host.advanceModelRecoveryReachDrain(transitionId, 'contract-deadline')
    }, deadlineDelayMs)

    const current = host.executor.current
    if (
      current !== null && current.status === 'running' &&
      current.authority === 'vtr-reach' && current.transitionId === transitionId
    ) {
      // The existing completion handler will continue the same contract. Do not
      // attach a second callback that would finish the generation after one leg.
      return
    }
    void host.advanceModelRecoveryReachDrain(transitionId, 'model-outage')
  }

export async function advanceModelRecoveryReachDrain(host: ReachPlaneHost, transitionId: string, trigger: string): Promise<void> {
    if (
      !host.running || !host.modelRecoveryStopping ||
      host.modelRecoveryReachDrainTransitionId !== transitionId
    ) return
    if (host.ticking || host.modelRecoveryReachDrainAdvancing) {
      host.modelRecoveryReachDrainPending = true
      return
    }

    const runtime = host.reachTransition
    if (runtime === null || runtime.contract.transitionId !== transitionId || runtime.state.status !== 'active') {
      host.completeModelRecoveryReachDrain(transitionId, 'transition-already-terminal')
      return
    }
    const current = host.executor.current
    if (
      current !== null && current.status === 'running' &&
      current.authority === 'vtr-reach' && current.transitionId === transitionId
    ) {
      return
    }

    host.modelRecoveryReachDrainAdvancing = true
    host.modelRecoveryReachDrainPending = false
    try {
      host.logger.info(
        'agent',
        `MODEL_RECOVERY_DRAIN phase=continue transitionId=${transitionId} trigger=${trigger} mechanicalSteps=${runtime.state.usage.mechanicalSteps}`,
        { transitionId, contractHash: runtime.contract.contractHash, trigger, mechanicalSteps: runtime.state.usage.mechanicalSteps },
        host.tickCounter,
      )
      await host.tickReachTransition('heartbeat', { source: 'model-recovery-reach-drain', transitionId, trigger })

      const after = host.reachTransition
      if (after === null || after.contract.transitionId !== transitionId || after.state.status !== 'active') {
        host.completeModelRecoveryReachDrain(transitionId, after?.state.terminalOutcome?.kind ?? 'typed-terminal')
        return
      }

      const nowMs = Date.now()
      if (nowMs > after.state.startedAtMs + after.contract.budget.maxElapsedMs) {
        const fresh = host.buildReachWorldState(after.mission)
        const identity = host.reachIdentity(fresh) ?? host.liveReachIdentity(after.contract.identity)
        const projection = host.projectReachMission(after.mission, fresh, identity, after.contract)
        const expired = await host.reachRuntime.tick(projection.snapshot)
        if (expired.status === 'terminal') {
          if (expired.outcome.kind === 'SUCCESS') host.logReachVerification(expired.outcome, projection.snapshot)
          host.closeReachTransition(expired.outcome, expired.state, 'model-recovery-budget', expired.cancelIntentId)
          host.completeModelRecoveryReachDrain(transitionId, expired.outcome.kind)
          return
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      host.logger.error(
        'agent',
        `MODEL_RECOVERY_DRAIN phase=controller_error transitionId=${transitionId} error=${message}`,
        { transitionId, error: message },
        host.tickCounter,
      )
      const active = host.reachTransition
      if (active !== null && active.contract.transitionId === transitionId && active.state.status === 'active') {
        const observed = host.liveReachIdentity(active.contract.identity)
        const violation = host.reachRuntime.supersede({
          reason: `model-recovery Reach controller failed: ${message}`,
          evidenceId: `model-recovery-controller-error:${transitionId}:${Date.now()}`,
          identity: observed,
          nowMs: Date.now(),
        })
        if (violation.status === 'terminal') host.closeReachTransition(violation.outcome, violation.state, 'model-recovery-controller-error', violation.cancelIntentId)
      }
      host.completeModelRecoveryReachDrain(transitionId, 'controller-error')
      return
    } finally {
      host.modelRecoveryReachDrainAdvancing = false
    }

    if (host.modelRecoveryReachDrainPending) {
      host.modelRecoveryReachDrainPending = false
      setImmediate(() => void host.advanceModelRecoveryReachDrain(transitionId, 'pending-controller-turn'))
    }
  }

export function completeModelRecoveryReachDrain(host: ReachPlaneHost, transitionId: string, outcome: string): void {
    if (host.modelRecoveryReachDrainTransitionId !== transitionId) return
    host.logger.warn(
      'agent',
      `MODEL_RECOVERY_DRAIN phase=terminal transitionId=${transitionId} outcome=${outcome}`,
      { transitionId, outcome, schedulerStopped: true, modelAuthority: 'withdrawn' },
      host.tickCounter,
    )
    host.modelRecoveryReachDrainTransitionId = null
    host.modelRecoveryReachDrainPending = false
    if (host.modelRecoveryDrainTimer !== null) {
      clearTimeout(host.modelRecoveryDrainTimer)
      host.modelRecoveryDrainTimer = null
    }
    host.finish('stopped-by-caller', false)
  }

export function reachIdentity(host: ReachPlaneHost, state: WorldState): ReachIdentity | null {
    const generationId = host.options.decisionProvenance.generationId
    const leaseId = host.options.actuationPort?.generationId
    if (generationId === null || generationId === undefined || leaseId === undefined || leaseId.length === 0) return null
    return {
      worldKey: `${host.options.serverId}|${state.self.dimension}|${host.options.worldEpoch}`,
      dimension: state.self.dimension,
      worldEpoch: host.options.worldEpoch,
      generationId,
      leaseId,
    }
  }

export function liveReachIdentity(host: ReachPlaneHost, fallback: ReachIdentity): ReachIdentity {
    const dimension = host.reachRuntimeAdapter.currentDimension()
    const generationId = host.options.decisionProvenance.generationId
    const leaseId = host.options.actuationPort?.generationId
    return {
      worldKey: `${host.options.serverId}|${dimension}|${host.options.worldEpoch}`,
      dimension,
      worldEpoch: host.options.worldEpoch,
      generationId: generationId ?? `${fallback.generationId}:missing`,
      leaseId: leaseId ?? `${fallback.leaseId}:missing`,
    }
  }

export function buildReachWorldState(host: ReachPlaneHost, mission: VtrInventoryMission): WorldState {
    const have = countMissionInventoryResource(host.reachRuntimeAdapter.inventoryCounts(), mission.item)
    const required = Math.max(1, Math.floor(mission.count))
    const goal: GoalState = {
      id: mission.id,
      description: `Mission inventory ${mission.item} >= ${required}`,
      targetItem: mission.item,
      requiredCount: required,
      startCount: 0,
      haveCount: have,
      progress: Math.min(1, have / required),
      complete: have >= required,
      startedAtMs: host.startedAt,
    }
    const compatibilityQueue: GoalQueueState = {
      depth: 0,
      current: null,
      empty: true,
      hasImpossible: false,
      done: 0,
      goals: [],
    }
    let state = host.reachRuntimeAdapter.observeWorldState(
      {
        tick: host.tickCounter,
        goal,
        goalQueue: compatibilityQueue,
        currentOption: null,
        recentOutcomes: [],
        focusItem: mission.item,
        retrievalItems: [mission.item],
        recentEvents: [],
        signals: { ...host.signals, knownResources: host.knownResourcesForSensor() },
        rememberedStations: host.knownResourcesForSensor(),
        containerContents: host.reachRuntimeAdapter.containerContents(),
      },
      sensorOptions(host.options, host.scheduler.worldRevision),
    )
    state = host.mergeRememberedPortalFrame(state)
    host.syncTerrainSignals(state)
    host.observeThreatState(state)
    host.observeUnansweredRangedThreat(state)
    host.observeEnvHazard(state)
    return state
  }

export function projectReachMission(host: ReachPlaneHost, 
    mission: VtrInventoryMission,
    state: WorldState,
    identity: ReachIdentity,
    contract: ReachTransitionContract | null = null,
    snapshotOptions: ReachMissionSnapshotOptions = {},
  ): ReturnType<typeof projectMinecraftReachMission> {
    host.reachRouteDecisionWorld = state
    const options = candidateOptions(
      host.options,
      host.recipeIndex,
      host.unreachableStationKeys(state),
      host.reachRuntimeAdapter.reachabilityGateOptions(host.tickCounter, host.reachabilityProofs),
      host.blacklistedMoveTargets(state),
      state.portalFrame,
      host.searchedSurfaceTargets,
      null,
      host.placementRetries.retiredItemSet(),
    )
    return projectMinecraftReachMission({
      mission,
      world: state,
      candidateOptions: options,
      identity,
      witnessIdentity: host.reachIdentity(state),
      contract,
      previousFrontierId: host.reachRuntime.current?.state.progress.frontierId ?? null,
      previousActionFailure: host.lastReachActionFailure,
      snapshotOptions,
    })
  }

export function currentVtrReachRouteDecision(host: ReachPlaneHost): JevReachRouteDecisionRecord | null {
    return host.lastVtrReachRouteDecision
  }

export async function dispatchReachIntent(host: ReachPlaneHost, 
    result: ReachControllerResult,
    state: WorldState,
    identity: ReachIdentity,
    candidates: readonly Candidate[],
  ): Promise<boolean> {
    if (result.status !== 'active' || result.phase !== 'actuate' || result.intent === undefined) return false
    const intent = result.intent
    let actuationJournaled = false
    const candidate = candidates.find((entry) => entry.id === intent.routeId)
    if (candidate === undefined || candidate.target === null || JSON.stringify(candidate.target) !== JSON.stringify(intent.target)) {
      host.logger.warn(
        'vtr',
        `VTR_RUNTIME_INTENT_REFUSED transition=${intent.transitionId} route=${intent.routeId} reason=route-not-in-current-observation`,
        { transitionId: intent.transitionId, intentId: intent.intentId, routeId: intent.routeId, authority: 'vtr-transition-controller' },
        host.tickCounter,
      )
      return true
    }
    const dispatched = host.reachRuntimeAdapter.dispatch({
      intent,
      candidate,
      observation: state,
      reach: host.options.reach,
      maxCandidateAgeTicks: host.options.maxCandidateAgeTicks,
      reachability: host.reachRuntimeAdapter.reachabilityGateOptions(host.tickCounter, host.reachabilityProofs),
      liveStructureMembers: state.liveStructureMembers ?? [],
      beforeMechanicalStep: (step) => host.authorizeReachMechanicalStep(intent.intentId, identity, step),
      afterMechanicalStep: (step) => host.recordReachMechanicalOutcome(intent.intentId, identity, step),
      onBeforeRunStart: (started) => {
        actuationJournaled = true
        host.logReachActuation(intent, started.id, started.epoch, candidate.id, started.candidate)
      },
    })
    if (dispatched.status === 'route-refused') {
      host.logger.warn(
        'vtr',
        `VTR_RUNTIME_INTENT_REFUSED transition=${intent.transitionId} route=${intent.routeId} reason=${dispatched.reason}`,
        { transitionId: intent.transitionId, intentId: intent.intentId, routeId: intent.routeId, reason: dispatched.reason, authority: 'vtr-transition-controller' },
        host.tickCounter,
      )
      return true
    }
    if (dispatched.status === 'guard-refused') {
      const guard = dispatched.rejection
      host.logger.warn(
        'vtr',
        `VTR_REACH_GUARD_REFUSED id=${intent.transitionId} candidate=${candidate.id} code=${guard.code}`,
        { transitionId: intent.transitionId, intentId: intent.intentId, candidate: candidate.id, code: guard.code, reason: guard.reason },
        host.tickCounter,
      )
      host.noteCandidateFailure(candidate.id)
      await host.releaseUnstartedReachIntent(intent.intentId, intent.transitionId, `guard:${guard.code}`)
      return true
    }
    if (dispatched.status === 'claim-refused') {
      const message = dispatched.message
      if (dispatched.activeAction !== null && dispatched.activeAction.authority !== 'vtr-reach') {
        host.noteReachAuthorityConflict()
        host.reachRuntimeAdapter.cancelCurrent('VTR Reach claim refused by active legacy lease')
      }
      host.logger.error(
        'vtr',
        `VTR_EXECUTOR_CLAIM_REFUSED transition=${intent.transitionId} intent=${intent.intentId} reason=${message}`,
        { transitionId: intent.transitionId, intentId: intent.intentId, candidate: candidate.id, error: message },
        host.tickCounter,
      )
      await host.releaseUnstartedReachIntent(intent.intentId, intent.transitionId, `executor-claim:${message}`)
      return true
    }
    const { claim, candidate: guardedCandidate, actionId } = dispatched
    if (!claim.kept) host.actionStart = { ...state.self.position }
    host.lastReachActionFailure = null
    // Fresh claims through the production adapter journaled actuation inside the
    // executor claim, ahead of the first mechanical leg (causal order). Adapters
    // that do not fire the claim hook — and `kept` re-dispatches that never
    // re-enter it — still journal the same single row after dispatch returns.
    if (!actuationJournaled) host.logReachActuation(intent, actionId, claim.epoch, candidate.id, guardedCandidate)
    void claim.completion
      .then((execution) => host.onReachActionComplete(execution, guardedCandidate, intent.transitionId, intent.intentId))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        host.logger.error('vtr', `VTR_ACTION_COMPLETION_HANDLER_FAILED transition=${intent.transitionId}: ${message}`, { transitionId: intent.transitionId, intentId: intent.intentId }, host.tickCounter)
      })
    return true
  }

export function logReachActuation(host: ReachPlaneHost, 
    intent: ReachMechanicalIntent,
    actionId: string | null,
    epoch: number,
    candidateId: string,
    guardedCandidate: Candidate,
  ): void {
    host.logger.info(
      'vtr',
      `VTR_TRANSITION_ACTUATION id=${intent.transitionId} intent=${intent.intentId} action=${actionId ?? 'missing'} candidate=${candidateId} target=${JSON.stringify(guardedCandidate.target)} selectedBy=vtr_transition_controller`,
      { transitionId: intent.transitionId, intentId: intent.intentId, actionId, contractHash: intent.contractHash, candidate: candidateId, target: guardedCandidate.target, authority: 'vtr-transition-controller', leaseEpoch: epoch },
      host.tickCounter,
    )
  }

export async function releaseUnstartedReachIntent(host: ReachPlaneHost, intentId: string, transitionId: string, evidence: string): Promise<void> {
    const metadata = host.reachRunMetadata
    if (metadata === null || metadata.transitionId !== transitionId) return
    const state = host.buildReachWorldState(metadata.mission)
    const identity = host.reachIdentity(state) ?? metadata.identity
    const released = await host.reachRuntime.refuseIntent(intentId, {
      identity,
      evidenceId: `reach-intent-refused:${transitionId}:${intentId}:${evidence}`,
      observedAtMs: state.timestampMs,
    })
    if (released.status === 'terminal') {
      host.closeReachTransition(released.outcome, released.state, 'intent-refused-terminal', released.cancelIntentId)
      return
    }
    if (released.status === 'refused') {
      host.logger.warn('vtr', `VTR_INTENT_RELEASE_REFUSED transition=${transitionId} intent=${intentId} reason=${released.reason}`, { transitionId, intentId, reason: released.reason, evidence }, host.tickCounter)
    }
    host.requestDecision('action_completed', { transitionId, intentId, typedOutcome: 'intent-refused', evidence })
  }

export async function tickReachTransition(host: ReachPlaneHost, trigger: DecisionTrigger, detail: Record<string, unknown>): Promise<boolean> {
    // Strangler entry only: HOST/control-loop code prepares a typed Mission,
    // Reach snapshot, route-candidate and lease/action DTOs. These DTOs are the
    // only gameplay input crossing into VTR; Mission scheduling/session/lifecycle
    // ownership lives in the backend-independent ReachMissionRuntime.
    // Delete this shim after Reach observation, typed actuation and evidence callbacks
    // are wired directly through the canonical Runtime Adapter ports and fresh
    // exact-source evidence proves no legacy caller needs this entry point.
    if (
      host.modelRecoveryStopping &&
      (host.modelRecoveryReachDrainTransitionId === null ||
        host.reachRuntime.current?.contract.transitionId !== host.modelRecoveryReachDrainTransitionId)
    ) return true
    const configuredMission = host.options.vtrMission
    if (configuredMission === null || configuredMission === undefined || configuredMission.id.trim() === '' || configuredMission.item.trim() === '') return false
    if (!Number.isSafeInteger(configuredMission.count) || configuredMission.count < 1) return false

    const activeBefore = host.reachRuntime.activeMission
    const observedMission = activeBefore?.mission ?? configuredMission
    const state = host.buildReachWorldState(observedMission)

    let identity = host.reachIdentity(state)
    if (identity === null) {
      if (activeBefore === null) return false
      identity = {
        ...activeBefore.contract.identity,
        dimension: state.self.dimension,
        worldKey: `${host.options.serverId}|${state.self.dimension}|${host.options.worldEpoch}`,
        worldEpoch: host.options.worldEpoch,
        generationId: host.options.decisionProvenance.generationId ?? 'generation-missing',
        leaseId: host.options.actuationPort?.generationId ?? 'lease-missing',
      }
    }
    const expectedLeaseId = identity.leaseId
    let leaseFailure: string | null = null
    try {
      host.options.actuationPort?.assertLease(`vtr-reach-observe:${configuredMission.id}`)
    } catch (error) {
      leaseFailure = error instanceof Error ? error.message : String(error)
      identity = { ...identity, leaseId: `lease-denied:${leaseFailure}` }
    }

    const active = host.reachRuntime.activeMission
    const runtimeMission = active?.mission ?? configuredMission
    const action = host.reachRuntimeAdapter.currentAction()
    const sourceNames = minecraftMissionSourceNames(configuredMission.item)
    const legacyReachAction = active === null && action !== null &&
      isMissionReachWalkAction(action, configuredMission.item, state.self.dimension, host.options.worldEpoch, sourceNames)

    const health = state.self.health
    const threat = state.signals.threat
    const viability = assessReachViability(trigger, {
      criticalHealth: health <= CRITICAL_COMBAT_HEALTH,
      needsBreathEscape: bodyNeedsBreathEscape(state.self),
      environmentalHazard: state.self.envHazard?.active === true,
      activeThreat: threat?.active === true,
    })
    const unsafeFacts = [
      ...(health <= CRITICAL_COMBAT_HEALTH ? ['critical-health'] : []),
      ...(bodyNeedsBreathEscape(state.self) ? ['breath-escape'] : []),
      ...(state.self.envHazard?.active === true ? ['environmental-hazard'] : []),
      ...(threat?.active === true ? ['active-threat'] : []),
    ]
    const snapshotOptions: ReachMissionSnapshotOptions = {
      ...(active !== null && viability.shouldInterrupt
        ? {
            safetyInterruption: {
              reason: viability.safetyTrigger
                ? `safety trigger ${trigger} confirmed by ${unsafeFacts.join(',')}`
                : `fresh viability facts require a different transition: ${unsafeFacts.join(',')}`,
              evidenceId: `viability:${state.tick}:${trigger}:${state.self.health}:${state.self.food}`,
            },
          }
        : {}),
      ...(active !== null && active.state.witness !== null
        ? (() => {
            const witness = active.state.witness!
            const falsified = state.knownResourceEvidence?.find((entry) =>
              entry.status === 'falsified' &&
              entry.position.x === (witness.target as { x?: number }).x &&
              entry.position.y === (witness.target as { y?: number }).y &&
              entry.position.z === (witness.target as { z?: number }).z,
            )
            return falsified === undefined
              ? {}
              : {
                  infeasibility: {
                    reason: `grounded resource witness ${falsified.name} was falsified (${falsified.reason ?? 'world evidence'})`,
                    evidenceId: `known-resource:${state.tick}:${falsified.name}:${falsified.reason ?? 'falsified'}`,
                  },
                }
          })()
        : {}),
    }
    const projection = host.projectReachMission(runtimeMission, state, identity, active?.contract ?? null, snapshotOptions)
    const snapshot = projection.snapshot
    const candidates = projection.candidates
    const rejectedReachRoutes = projection.inadmissibleCandidates
    const missionSatisfiedEvidenceId = projection.missionSatisfiedEvidenceId
    const ensureAlreadyTrueEvidenceId = active === null ? projection.ensuresAlreadyTrueEvidenceId : undefined
    const safeToStart = health > CRITICAL_COMBAT_HEALTH &&
      !bodyNeedsBreathEscape(state.self) &&
      state.self.envHazard?.active !== true &&
      threat?.active !== true

    if (active === null) host.lastVtrReachRouteDecision = null
    const decision = await host.reachRuntime.driveMission({
      mission: configuredMission,
      snapshot,
      interactionReach: host.options.reach,
      sourceNames: projection.missionSourceNames,
      transitionId: active?.contract.transitionId ?? randomUUID(),
      probe: host.options.vtrReachProbe === true,
      schedulerOwner: host.queue.current?.origin === 'human' ? 'human' : 'mission',
      actuationLease: leaseFailure === null
        ? { status: 'owned', leaseId: identity.leaseId }
        : {
            status: 'lost',
            expectedLeaseId,
            observedLeaseId: identity.leaseId,
            reason: leaseFailure,
          },
      activeAction: action,
      activeActionMatchesMissionReach: legacyReachAction,
      ...(active !== null || missionSatisfiedEvidenceId === undefined ? {} : { missionSatisfiedEvidenceId }),
      ...(active !== null || ensureAlreadyTrueEvidenceId === undefined ? {} : { reachAlreadyTrueEvidenceId: ensureAlreadyTrueEvidenceId }),
      safeToStart,
      ...(rejectedReachRoutes.length === 0 ? {} : { inadmissibleRouteIds: rejectedReachRoutes.map((candidate) => candidate.id) }),
      observedHealth: health,
      counters: {
        jevCalls: host.jevCalls,
        system2Calls: host.runtimeLlmCalls + host.planCalls,
        authorityConflicts: host.reachRuntimeAdapter.authorityConflictCount(),
        nonVtrActuations: host.reachRuntimeAdapter.nonVtrActuationCount(),
      },
    })

    if (viability.safetyTrigger && active !== null && !viability.shouldInterrupt) {
      host.logger.info(
        'vtr',
        `VTR_SAFETY_TRIGGER_STALE transition=${active.contract.transitionId} trigger=${trigger} -> continue; no current unsafe fact`,
        {
          transitionId: active.contract.transitionId,
          trigger,
          observedFacts: { health, air: state.self.air, needsBreathEscape: bodyNeedsBreathEscape(state.self), environmentalHazard: state.self.envHazard?.active === true, activeThreat: threat?.active === true },
          actionId: action?.id ?? null,
        },
        host.tickCounter,
      )
    }

    if (decision.kind === 'declined') return false
    if (decision.kind === 'held') {
      const level = decision.reason === 'body-not-safe' ? 'warn' : 'info'
      const message = decision.reason === 'no-admissible-reach-route'
        ? `VTR_SCHEDULER_HOLDS_NO_ADMISSIBLE_ROUTE mission=${configuredMission.id} item=${configuredMission.item} candidates=${rejectedReachRoutes.length}`
        : host.options.vtrReachProbe === true
          ? `VTR_REACH_PROBE_HOLD mission=${configuredMission.id} reason=${decision.reason}`
          : `VTR_MISSION_RUNTIME_HOLD mission=${configuredMission.id} reason=${decision.reason}`
      host.logger[level]('vtr', message, {
        mission: configuredMission,
        reason: decision.reason,
        candidateIds: candidates.map((candidate) => candidate.id),
        ...(decision.reason === 'body-not-safe' ? {
          safetyFacts: {
            health,
            needsBreathEscape: bodyNeedsBreathEscape(state.self),
            environmentalHazard: state.self.envHazard?.active === true,
            activeThreat: threat?.active === true,
          },
        } : {}),
        ...(rejectedReachRoutes.length === 0 ? {} : { rejectedCandidates: rejectedReachRoutes.map((candidate) => candidate.id) }),
        authority: 'vtr-transition-scheduler',
      }, host.tickCounter)
      return active !== null || host.options.vtrReachProbe === true || decision.reason === 'no-admissible-reach-route' || decision.reason === 'route-decision-required'
    }
    if (decision.kind === 'revoke-action') {
      const cancelled = host.reachRuntimeAdapter.cancelCurrent(
        decision.reason === 'legacy-reach-handoff'
          ? 'VTR takes ownership of the Mission Reach predicate'
          : decision.reason === 'orphan-vtr-actuation-without-active-contract'
            ? 'VTR action has no active Reach contract'
            : decision.reason === 'probe-revokes-legacy-actuation'
              ? 'VTR Reach probe owns the configured Mission'
              : 'VTR mission runtime revoked conflicting actuation',
      )
      host.logger.info(
        'vtr',
        decision.reason === 'legacy-reach-handoff'
          ? `VTR_LEGACY_REACH_HANDOFF mission=${configuredMission.id} action=${action?.id ?? 'none'} cancelled=${cancelled}`
          : `VTR_REACH_AUTHORITY_REVOKE reason=${decision.reason} action=${action?.id ?? 'none'} cancelled=${cancelled}`,
        { mission: configuredMission, reason: decision.reason, actionId: action?.id ?? null, authority: 'vtr-mission-runtime' },
        host.tickCounter,
      )
      if (decision.reason === 'legacy-reach-handoff' && cancelled && host.reachRuntimeAdapter.currentAction() === null) {
        return host.tickReachTransition(trigger, { ...detail, source: 'vtr-legacy-reach-handoff' })
      }
      return true
    }

    const { result, mission, contract, snapshot: acceptedSnapshot } = decision
    const routeSelection = decision.started ? host.currentVtrReachRouteDecision() : null
    if (decision.started) {
      host.lastReachActionFailure = null
      host.logger.info(
        'vtr',
        `VTR_TRANSITION_COMMIT id=${contract.transitionId} mission=${mission.id} ensures=${contract.desiredPredicate.id} contractHash=${contract.contractHash}`,
        {
          transitionId: contract.transitionId,
          contractHash: contract.contractHash,
          mission,
          desiredPredicate: contract.desiredPredicate,
          desiredPredicateIdentity: contract.desiredPredicateIdentity,
          requires: contract.requires,
          ensures: contract.ensures,
          ensuresIdentity: contract.ensuresIdentity,
          invariants: contract.invariants,
          admissibleEffects: contract.admissibleEffects,
          budget: contract.budget,
          controller: contract.controller,
          progressDefinition: contract.progressDefinition,
          identity,
          selectedRoute: host.reachRuntime.current?.route ?? null,
          witness: host.reachRuntime.current?.route.witness ?? null,
          observedRouteIds: acceptedSnapshot.routes.map((route) => route.routeId),
          routePolicy: routeSelection === null
            ? { authority: 'jev-decision-frame-or-single-grounded-route', callId: null, source: null, model: null, probabilities: null }
            : {
                authority: !routeSelection.accepted
                  ? 'jev-choice-refused'
                  : routeSelection.source === 'jev' ? 'jev' : 'explicit-policy-configuration',
                selectedRouteId: routeSelection.selectedRouteId,
                callId: routeSelection.callId,
                source: routeSelection.source,
                policy: routeSelection.policy,
                model: routeSelection.model,
                probabilities: routeSelection.probabilities,
              },
          compatibilityProjection: 'GoalQueue is ignored for VTR Reach scheduling',
        },
        host.tickCounter,
      )
    }

    if (result.status === 'terminal') {
      if (result.outcome.kind === 'SUCCESS') host.logReachVerification(result.outcome, acceptedSnapshot)
      host.closeReachTransition(
        result.outcome,
        result.state,
        result.outcome.kind === 'SUCCESS' ? 'verified-terminal' : 'typed-terminal',
        result.cancelIntentId,
      )
      if (decision.cancelAction) host.reachRuntimeAdapter.cancelCurrent('VTR transition terminal')
      return true
    }
    if (result.status !== 'active') {
      host.logger.warn(
        'vtr',
        `VTR_MISSION_RUNTIME_TRANSITION_REFUSED transition=${contract.transitionId} status=${result.status}`,
        { transitionId: contract.transitionId, result },
        host.tickCounter,
      )
      return true
    }
    const currentState = host.reachRuntime.current?.state ?? result.state
    host.logger.info(
      'vtr',
      `VTR_TRANSITION_PROGRESS id=${contract.transitionId} sequence=${currentState.progress.observationSequence} distance=${currentState.progress.latestPredicateDistance ?? 'unknown'} reachable=${currentState.progress.reachability} mechanicalSteps=${currentState.usage.mechanicalSteps}`,
      { transitionId: contract.transitionId, contractHash: contract.contractHash, progress: currentState.progress, usage: currentState.usage },
      host.tickCounter,
    )
    if (decision.cancelAction) host.reachRuntimeAdapter.cancelCurrent('VTR terminal request')
    if (!decision.dispatch) return true
    await host.dispatchReachIntent(result, state, identity, candidates)
    return true
  }

export function authorizeReachMechanicalStep(host: ReachPlaneHost, 
    intentId: string,
    identity: ReachIdentity,
    step: { stepId: string; leg: number; effectKind: 'locomotion' },
  ): boolean {
    const active = host.reachRuntime.current
    if (active === null || active.intent?.intentId !== intentId) return false
    let observedIdentity = host.liveReachIdentity(identity)
    try {
      host.options.actuationPort?.assertLease(`vtr-reach-step:${step.stepId}`)
    } catch (error) {
      observedIdentity = { ...observedIdentity, leaseId: `lease-denied:${error instanceof Error ? error.message : String(error)}` }
    }
    const result = host.reachRuntime.authorizeMechanicalStep(intentId, observedIdentity, {
      stepId: step.stepId,
      effectKind: step.effectKind,
      resources: {},
      risk: {},
      nowMs: Date.now(),
    })
    if (result.status === 'terminal') {
      host.closeReachTransition(result.outcome, result.state, 'actuation-reservation', result.cancelIntentId)
      if (result.cancelIntentId !== null) host.reachRuntimeAdapter.cancelCurrent('VTR mechanical reservation terminal')
      return false
    }
    if (result.status !== 'authorized') {
      host.logger.warn(
        'vtr',
        `VTR_MECHANICAL_STEP_REFUSED transition=${active.contract.transitionId} step=${step.stepId} reason=${result.reason}`,
        { transitionId: active.contract.transitionId, intentId, stepId: step.stepId, reason: result.reason },
        host.tickCounter,
      )
      host.reachRunMetadata = null
      return false
    }
    const actionId = host.reachRuntimeAdapter.currentAction()?.id ?? null
    host.logger.info(
      'vtr',
      `VTR_MECHANICAL_STEP_RESERVED transition=${active.contract.transitionId} intent=${intentId} action=${actionId ?? 'missing'} step=${step.stepId} leg=${step.leg} count=${result.state.usage.mechanicalSteps}/${active.contract.budget.maxMechanicalSteps}`,
      { transitionId: active.contract.transitionId, contractHash: active.contract.contractHash, intentId, actionId, stepId: step.stepId, leg: step.leg, effectKind: step.effectKind, usage: result.state.usage },
      host.tickCounter,
    )
    return true
  }

export function recordReachMechanicalOutcome(host: ReachPlaneHost, 
    intentId: string,
    identity: ReachIdentity,
    step: { stepId: string; leg: number; effectKind: 'locomotion' },
  ): boolean | 'verified-terminal' {
    const active = host.reachRuntime.current
    const metadata = host.reachRunMetadata
    if (active === null || metadata === null || active.intent?.intentId !== intentId) return false
    const state = host.buildReachWorldState(metadata.mission)
    const observedIdentity = host.reachIdentity(state) ?? host.liveReachIdentity(identity)
    const snapshot = host.projectReachMission(metadata.mission, state, observedIdentity, active.contract).snapshot
    const damage = host.noteReachHealth(state.self.health)
    const result = host.reachRuntime.recordMechanicalStepOutcome(intentId, step.stepId, {
      snapshot,
      ...(damage > 0 ? { observedRisk: { damage } } : {}),
    })
    const settledState = 'state' in result ? result.state : active.state
    const settledOutcome = result.status === 'terminal'
      ? result.outcome.kind
      : result.status === 'refused'
        ? 'REFUSED'
        : 'CONTINUING'
    const actionId = host.reachRuntimeAdapter.currentAction()?.id ?? null
    const stepEvent = `VTR_MECHANICAL_STEP_OUTCOME transition=${active.contract.transitionId} intent=${intentId} action=${actionId ?? 'missing'} step=${step.stepId} leg=${step.leg} status=${result.status} outcome=${settledOutcome} verified=${result.status === 'terminal' && result.outcome.kind === 'SUCCESS'} mechanicalSteps=${settledState.usage.mechanicalSteps}`
    const stepDetail = {
      transitionId: active.contract.transitionId,
      contractHash: active.contract.contractHash,
      intentId,
      actionId,
      stepId: step.stepId,
      leg: step.leg,
      effectKind: step.effectKind,
      status: result.status,
      outcome: settledOutcome,
      verified: result.status === 'terminal' && result.outcome.kind === 'SUCCESS',
      reason: result.status === 'refused' ? result.reason : null,
      identity: snapshot.observation.identity,
      observedAtMs: snapshot.observation.observedAtMs,
      usage: settledState.usage,
    }
    if (result.status === 'refused') host.logger.warn('vtr', stepEvent, stepDetail, host.tickCounter)
    else host.logger.info('vtr', stepEvent, stepDetail, host.tickCounter)
    if (result.status === 'terminal') {
      if (result.outcome.kind === 'SUCCESS') host.logReachVerification(result.outcome, snapshot)
      const current = host.reachRuntimeAdapter.currentAction()
      const actionCorrelation =
        current?.authority === 'vtr-reach' && current.transitionId === active.contract.transitionId
          ? { intentId, actionId: current.id }
          : undefined
      const closed = host.closeReachTransition(result.outcome, result.state, 'mechanical-step-outcome', result.cancelIntentId, actionCorrelation)
      if (result.cancelIntentId !== null && !closed) host.reachRuntimeAdapter.cancelCurrent('VTR mechanical step outcome terminal')
      return result.outcome.kind === 'SUCCESS' && closed && actionCorrelation !== undefined ? 'verified-terminal' : false
    }
    if (result.status === 'refused') {
      host.logger.warn('vtr', `VTR_MECHANICAL_OUTCOME_REFUSED transition=${active.contract.transitionId} step=${step.stepId} reason=${result.reason}`, { transitionId: active.contract.transitionId, intentId, stepId: step.stepId, reason: result.reason }, host.tickCounter)
      return false
    }
    if (result.status !== 'active') return false
    if (damage > 0) {
      host.logger.info(
        'vtr',
        `VTR_RISK_OBSERVED transition=${active.contract.transitionId} step=${step.stepId} damage=${damage} total=${result.state.usage.risk.damage ?? 0}`,
        { transitionId: active.contract.transitionId, intentId, stepId: step.stepId, observedDamage: damage, usage: result.state.usage },
        host.tickCounter,
      )
    }
    return true
  }

export async function onReachActionComplete(host: ReachPlaneHost, 
    result: ReachMechanicalActionOutcome,
    candidate: Candidate,
    transitionId: string,
    intentId: string,
  ): Promise<void> {
    const terminalAction = host.pendingReachTerminalAction
    if (
      terminalAction != null &&
      terminalAction.transitionId === transitionId &&
      terminalAction.intentId === intentId &&
      terminalAction.actionId === result.actionId
    ) {
      host.pendingReachTerminalAction = null
      const verifiedSettlement = terminalAction.outcomeKind === 'SUCCESS' && result.status === 'done' && result.verified
      host.logger.info(
        'vtr',
        `VTR_TERMINAL_ACTION_CORRELATED transition=${transitionId} intent=${intentId} action=${result.actionId} outcome=${terminalAction.outcomeKind} status=${result.status} verified=${result.verified}`,
        { transitionId, intentId, actionId: result.actionId, outcome: terminalAction.outcomeKind, status: result.status, verified: result.verified, verifiedSettlement },
        host.tickCounter,
      )
      if (terminalAction.outcomeKind === 'SUCCESS' && !verifiedSettlement) {
        host.logger.warn(
          'vtr',
          `VTR_TERMINAL_ACTION_SETTLEMENT_MISMATCH transition=${transitionId} intent=${intentId} action=${result.actionId} expected=done/verified actual=${result.status}/${result.verified}`,
          { transitionId, intentId, actionId: result.actionId, outcome: terminalAction.outcomeKind, status: result.status, verified: result.verified },
          host.tickCounter,
        )
      }
      if (host.modelRecoveryReachDrainTransitionId === transitionId) {
        void host.advanceModelRecoveryReachDrain(transitionId, 'action-completed')
      } else {
        const deferred = host.deferredTrigger
        host.deferredTrigger = null
        const handoff: TriggerEvent = {
          trigger: 'action_completed',
          detail: { actionId: result.actionId, transitionId, intentId, typedOutcome: terminalAction.outcomeKind, schedulerHandoff: true },
          ts: Date.now(),
        }
        const next = deferred === null ? handoff : pickHigherPriority(deferred, handoff)
        host.requestDecision(next.trigger, next.detail)
      }
      return
    }
    const active = host.reachRuntime.current
    const metadata = host.reachRunMetadata
    if (active === null || metadata === null || active.contract.transitionId !== transitionId || active.intent?.intentId !== intentId) {
      host.logger.warn('vtr', `VTR_ORPHAN_ACTION_OUTCOME transition=${transitionId} intent=${intentId} action=${result.actionId} status=${result.status}`, { transitionId, intentId, result }, host.tickCounter)
      if (host.modelRecoveryReachDrainTransitionId === transitionId) host.completeModelRecoveryReachDrain(transitionId, 'transition-closed-during-action')
      return
    }
    host.lastReachActionFailure = result.status === 'failed' || result.status === 'cancelled' ? result.failure ?? 'cancelled' : null
    if (result.status === 'failed') host.noteCandidateFailure(candidate.id)
    else if (result.status === 'done' && result.verified) host.noteCandidateSuccess(candidate.id)
    const world = host.buildReachWorldState(metadata.mission)
    const identity = host.reachIdentity(world) ?? host.liveReachIdentity(active.contract.identity)
    const snapshot = host.projectReachMission(metadata.mission, world, identity, active.contract).snapshot
    const damage = host.noteReachHealth(world.self.health)
    host.logger.info(
      'vtr',
      `VTR_MECHANICAL_OUTCOME transition=${transitionId} action=${result.actionId} status=${result.status} verified=${result.verified} failure=${result.failure ?? 'none'} progress=${result.progressed === true ? 'body' : 'none'}`,
      { transitionId, intentId, contractHash: active.contract.contractHash, actionId: result.actionId, status: result.status, verified: result.verified, failure: result.failure ?? null, progress: result.progressed === true ? 'body' : 'none', usage: active.state.usage },
      host.tickCounter,
    )
    const completed = await host.reachRuntime.complete(intentId, {
      status: result.status === 'done' ? 'completed' : result.status === 'cancelled' ? 'cancelled' : 'failed',
      evidenceId: `executor:${result.actionId}:${result.status}`,
      snapshot,
      ...(damage > 0 ? { observedRisk: { damage } } : {}),
    })
    if (completed.status === 'terminal') {
      if (completed.outcome.kind === 'SUCCESS') host.logReachVerification(completed.outcome, snapshot)
      host.closeReachTransition(completed.outcome, completed.state, completed.outcome.kind === 'SUCCESS' ? 'verified-terminal' : 'typed-terminal', completed.cancelIntentId)
      if (completed.cancelIntentId !== null) host.reachRuntimeAdapter.cancelCurrent('VTR completion terminal')
    } else if (completed.status === 'refused') {
      host.logger.warn('vtr', `VTR_COMPLETION_REFUSED transition=${transitionId} intent=${intentId} reason=${completed.reason}`, { transitionId, intentId, reason: completed.reason }, host.tickCounter)
    }
    if (host.modelRecoveryReachDrainTransitionId === transitionId) {
      void host.advanceModelRecoveryReachDrain(transitionId, 'action-completed')
    } else {
      host.requestDecision('action_completed', { actionId: result.actionId, transitionId, intentId, authority: 'vtr-reach' })
    }
  }

export function closeReachTransition(host: ReachPlaneHost, 
    reportedOutcome: ReachTerminalOutcome,
    reportedState: ReachTransitionState,
    boundary: string,
    cancelIntentId: string | null = null,
    action: { readonly intentId: string; readonly actionId: string } | undefined = undefined,
  ): boolean {
    const projectedSession = host.reachRunMetadata
    const handoff = host.reachRuntime.takeTerminalHandoff()
    const metadata = handoff?.session ?? projectedSession
    if (metadata === null) return false
    if (
      handoff === null ||
      handoff.contractHash !== metadata.contractHash ||
      reportedOutcome.contractHash !== handoff.contractHash ||
      reportedState.contractHash !== handoff.contractHash ||
      // The kernel may downgrade a controller-reported SUCCESS to
      // CONTRACT_VIOLATION when VERIFY_SUCCESS is denied; that divergence is
      // the designed authority-denial outcome, not a handoff corruption.
      (reportedOutcome.kind !== handoff.outcome.kind &&
        !(reportedOutcome.kind === 'SUCCESS' && handoff.outcome.kind === 'CONTRACT_VIOLATION'))
    ) {
      host.logger.error(
        'vtr',
        `VTR_TERMINAL_HANDOFF_REFUSED transition=${metadata.transitionId} reason=runtime-outcome-state-mismatch`,
        {
          transitionId: metadata.transitionId,
          expectedContractHash: metadata.contractHash,
          reportedContractHash: reportedOutcome.contractHash,
          handedOffContractHash: handoff?.contractHash ?? null,
          reportedOutcome: reportedOutcome.kind,
          handedOffOutcome: handoff?.outcome.kind ?? null,
        },
        host.tickCounter,
      )
      return false
    }
    const outcome = handoff.outcome
    const state = handoff.state
    // SUCCESS is evidence-backed predicate verification, irrespective of which
    // runtime callback observed it. The validator and downstream journal use
    // this boundary to distinguish verified closure from an action/step result.
    // A kernel-denied SUCCESS arrives here already downgraded, so it must not
    // inherit the caller's 'verified-terminal' label.
    const terminalBoundary = outcome.kind === 'SUCCESS'
      ? 'verified-terminal'
      : boundary === 'verified-terminal' ? 'typed-terminal' : boundary
    let settleVerifiedAction = false
    if (action !== undefined) {
      const current = host.reachRuntimeAdapter.currentAction()
      if (
        current?.authority === 'vtr-reach' &&
        current.transitionId === metadata.transitionId &&
        current.id === action.actionId &&
        action.intentId.length > 0
      ) {
        host.pendingReachTerminalAction = {
          transitionId: metadata.transitionId,
          intentId: action.intentId,
          actionId: action.actionId,
          outcomeKind: outcome.kind,
        }
        settleVerifiedAction = outcome.kind === 'SUCCESS'
      } else {
        host.logger.error(
          'vtr',
          `VTR_TERMINAL_ACTION_CORRELATION_REFUSED transition=${metadata.transitionId} reason=active-lease-mismatch`,
          { transitionId: metadata.transitionId, intentId: action.intentId, actionId: action.actionId, currentActionId: current?.id ?? null, currentAuthority: current?.authority ?? null },
          host.tickCounter,
        )
      }
    }
    // A terminal Reach result returned by afterMechanicalStep is immediately
    // converted into a verified `done` result by runWalkSkill. Keep that
    // selected action's lease alive long enough for the skill to settle; aborting
    // it here turns a verified SUCCESS into LEASE_REVOKED and leaves the
    // mechanical reservation without its outcome record. Terminals observed
    // outside that correlated callback still cancel the live action below.
    const shouldCancelAction = cancelIntentId !== null && !settleVerifiedAction
    const cancelAfterWake = shouldCancelAction && action !== undefined
    if (shouldCancelAction && !cancelAfterWake) {
      const current = host.reachRuntimeAdapter.currentAction()
      if (current?.authority === 'vtr-reach' && current.transitionId === metadata.transitionId) {
        host.reachRuntimeAdapter.cancelCurrent(`VTR terminal ${outcome.kind}`)
      }
    }
    const jevCalls = Math.max(0, host.jevCalls - metadata.jevCallsAtStart)
    const system2Calls = Math.max(0, host.runtimeLlmCalls + host.planCalls - metadata.system2CallsAtStart)
    const duplicateAuthorityConflicts = Math.max(0, host.reachRuntimeAdapter.authorityConflictCount() - metadata.authorityConflictsAtStart)
    const duplicateAuthority = metadata.duplicateAuthorityObserved || duplicateAuthorityConflicts > 0
    const concurrentLegacyActuations = Math.max(0, host.reachRuntimeAdapter.nonVtrActuationCount() - metadata.nonVtrActuationsAtStart)
    host.logger.info(
      'vtr',
      `VTR_TRANSITION_OUTCOME id=${metadata.transitionId} outcome=${outcome.kind} boundary=${terminalBoundary} mechanicalSteps=${state.usage.mechanicalSteps} jevCalls=${jevCalls} system2Calls=${system2Calls}`,
      {
        transitionId: metadata.transitionId,
        contractHash: metadata.contractHash,
        identity: metadata.identity,
        runId: host.options.decisionProvenance.runId,
        sourceSha: host.options.decisionProvenance.sourceSha,
        outcome,
        boundary: terminalBoundary,
        progress: state.progress,
        usage: state.usage,
        metrics: {
          verifiedTransitionCompletion: outcome.kind === 'SUCCESS' ? 1 : 0,
          mechanicalStepsPerTransition: state.usage.mechanicalSteps,
          jevCallsPerTransition: jevCalls,
          system2CallsPerTransition: system2Calls,
          modelCallsPerMechanicalStep: state.usage.mechanicalSteps === 0 ? null : (jevCalls + system2Calls) / state.usage.mechanicalSteps,
          typedTerminalOutcome: outcome.kind,
          duplicateAuthority,
          duplicateAuthorityConflicts,
          concurrentLegacyActuations,
        },
      },
      host.tickCounter,
    )
    host.reachRunMetadata = null
    host.lastReachActionFailure = null
    host.requestDecision('action_completed', {
      transitionId: metadata.transitionId,
      typedOutcome: outcome.kind,
      schedulerHandoff: true,
      boundary: terminalBoundary,
    })
    // For a per-step terminal, queue the handoff while the current lease is
    // still visible so requestDecision defers it until the correlated executor
    // settlement. A verified action settles naturally; cancelling first would
    // turn SUCCESS into LEASE_REVOKED. Non-success terminals are cancelled only
    // after queuing, so the completion callback cannot schedule a duplicate wake.
    if (cancelAfterWake) {
      const current = host.reachRuntimeAdapter.currentAction()
      if (current?.authority === 'vtr-reach' && current.transitionId === metadata.transitionId) {
        host.reachRuntimeAdapter.cancelCurrent(`VTR terminal ${outcome.kind}`)
      }
    }
    return true
  }

export function logReachVerification(host: ReachPlaneHost, outcome: ReachTerminalOutcome, snapshot: ReachRuntimeSnapshot): void {
    if (outcome.kind !== 'SUCCESS') return
    const metadata = host.reachRunMetadata
    if (metadata === null || metadata.transitionId === '' || metadata.contractHash !== outcome.contractHash) {
      host.logger.error(
        'vtr',
        `VTR_VERIFY_JOURNAL_REFUSED transition=${metadata?.transitionId ?? 'missing'} reason=contract-metadata-mismatch`,
        { transitionId: metadata?.transitionId ?? null, contractHash: metadata?.contractHash ?? null, outcomeContractHash: outcome.contractHash },
        host.tickCounter,
      )
      return
    }
    const observation = snapshot.observation
    const predicates = metadata.ensures.map((predicate) => {
      const evidence = observation.predicates[predicate.id]
      return {
        id: predicate.id,
        expected: predicate.expected,
        truth: evidence?.truth ?? 'unknown',
        evidenceId: evidence?.evidenceId ?? null,
      }
    })
    const evidenceIds = predicates.map(({ evidenceId }) => evidenceId).filter((id): id is string => id !== null)
    const identityMatches =
      observation.identity.worldKey === metadata.identity.worldKey &&
      observation.identity.dimension === metadata.identity.dimension &&
      observation.identity.worldEpoch === metadata.identity.worldEpoch &&
      observation.identity.generationId === metadata.identity.generationId &&
      observation.identity.leaseId === metadata.identity.leaseId
    const predicatesVerified = predicates.length > 0 && predicates.every(({ expected, truth, evidenceId }) =>
      truth === (expected ? 'true' : 'false') && evidenceId !== null && outcome.evidenceIds.includes(evidenceId),
    )
    const timeMatches = observation.observedAtMs === outcome.verifiedAtMs
    const truth = identityMatches && predicatesVerified && timeMatches ? 'TRUE' : 'FALSE'
    const serverId = metadata.identity.worldKey.split('|')[0] ?? null
    host.logger.info(
      'vtr',
      `VTR_TRANSITION_VERIFY id=${metadata.transitionId} contractHash=${metadata.contractHash} truth=${truth} verifiedAtMs=${outcome.verifiedAtMs} evidenceIds=${JSON.stringify(outcome.evidenceIds)}`,
      {
        transitionId: metadata.transitionId,
        contractHash: metadata.contractHash,
        desiredPredicateIdentity: outcome.desiredPredicateIdentity,
        truth,
        predicates,
        evidenceIds,
        verifiedAtMs: outcome.verifiedAtMs,
        observedAtMs: observation.observedAtMs,
        runId: host.options.decisionProvenance.runId,
        serverId,
        generationId: metadata.identity.generationId,
        leaseId: metadata.identity.leaseId,
        sourceSha: host.options.decisionProvenance.sourceSha,
        buildHash: host.options.decisionProvenance.buildHash ?? null,
        worldKey: metadata.identity.worldKey,
        worldEpoch: metadata.identity.worldEpoch,
        dimension: metadata.identity.dimension,
        identityMatches,
        predicatesVerified,
      },
      host.tickCounter,
    )
  }
