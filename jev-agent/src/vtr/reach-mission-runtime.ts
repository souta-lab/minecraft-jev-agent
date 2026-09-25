import {
  ReachController,
  type ReachCommitFreshnessFence,
  type ReachControllerCurrent,
  type ReachControllerResult,
  type ReachRouteDecisionPolicy,
  type ReachRuntimeSnapshot,
  type ReachStepAuthorization,
} from './reach-controller.ts'
import {
  createInventoryReachTransition,
  type InventoryReachTransitionInput,
  type InventoryReachTransitionPlan,
} from './reach-scheduler.ts'
import type {
  ReachIdentity,
  ReachMechanicalStepRequest,
  ReachTerminalOutcome,
  ReachTransitionContract,
  ReachTransitionState,
} from './reach.ts'
import type { ReachRuntimeActionSnapshot } from './reach-runtime-ports.ts'
import type { KernelShadowSink } from './kernel-shadow-map.ts'

export interface ReachMissionRuntimeSession {
  readonly mission: InventoryReachTransitionInput['mission']
  readonly transitionId: string
  readonly contractHash: string
  readonly ensures: ReachTransitionContract['ensures']
  readonly identity: ReachIdentity
  readonly jevCallsAtStart: number
  readonly system2CallsAtStart: number
  readonly authorityConflictsAtStart: number
  readonly nonVtrActuationsAtStart: number
  duplicateAuthorityObserved: boolean
  lastHealth: number
}

/** Typed scheduler frame assembled from adapter observations and compatibility DTOs; it contains no live client objects. */
export interface ReachMissionRuntimeFrame {
  readonly mission: InventoryReachTransitionInput['mission']
  readonly snapshot: ReachRuntimeSnapshot
  readonly interactionReach: number
  readonly sourceNames: readonly string[]
  readonly transitionId: string
  readonly probe: boolean
  readonly schedulerOwner: 'mission' | 'human'
  readonly actuationLease:
    | { readonly status: 'owned'; readonly leaseId: string }
    | { readonly status: 'lost'; readonly expectedLeaseId: string; readonly observedLeaseId: string; readonly reason: string }
  readonly activeAction: ReachRuntimeActionSnapshot | null
  /** Compatibility adapter classification; prevents a matching legacy walk from racing VTR admission. */
  readonly activeActionMatchesMissionReach: boolean
  readonly missionSatisfiedEvidenceId?: string
  readonly reachAlreadyTrueEvidenceId?: string
  readonly safeToStart: boolean
  readonly inadmissibleRouteIds?: readonly string[]
  readonly observedHealth: number
  readonly counters: {
    readonly jevCalls: number
    readonly system2Calls: number
    readonly authorityConflicts: number
    readonly nonVtrActuations: number
  }
}

export type ReachMissionRuntimeDecision =
  | { readonly kind: 'declined'; readonly reason: string }
  | { readonly kind: 'held'; readonly reason: string; readonly transitionId?: string }
  | { readonly kind: 'revoke-action'; readonly reason: string; readonly transitionId?: string }
  | {
      readonly kind: 'transition'
      readonly result: ReachControllerResult
      readonly mission: InventoryReachTransitionInput['mission']
      readonly contract: ReachTransitionContract
      readonly snapshot: ReachRuntimeSnapshot
      readonly started: boolean
      readonly dispatch: boolean
      readonly cancelAction: boolean
    }

/** VTR policy dependencies. Production supplies Jev; tests/offline probes may supply an explicit policy. */
export interface ReachMissionRuntimeDependencies {
  readonly routePolicy: ReachRouteDecisionPolicy
  readonly commitFreshnessFence: ReachCommitFreshnessFence
  /** Run-scoped policy telemetry; does not influence VTR admission or outcomes. */
  readonly onTerminalHandoff?: (handoff: {
    readonly transitionId: string
    readonly contractHash: string
    readonly state: ReachTransitionState
    readonly outcome: ReachTerminalOutcome
  }) => void
  /** Drop telemetry for a route proposal that never acquired a committed Transition. */
  readonly onTransitionNotCommitted?: (transitionId: string) => void
  /**
   * V4.1.2 Phase-1 shadow sink. The host-owned kernel shadow receives
   * observation/commit/step/terminal inputs here; it never returns authority
   * or gates production decisions.
   */
  readonly kernelShadow?: KernelShadowSink
}

export interface ReachTerminalHandoff {
  readonly contractHash: string
  readonly state: ReachTransitionState
  readonly outcome: ReachTerminalOutcome
  readonly session: Readonly<ReachMissionRuntimeSession> | null
}

interface ReachMissionScope {
  readonly predicateIdentity: string
  readonly missionRequirement: string
  readonly worldKey: string
  readonly dimension: string
  readonly worldEpoch: number
}

interface TerminalWitnessExclusion extends ReachMissionScope {
  readonly witnessId: string
}

interface ActiveContractScope {
  readonly transitionId: string
  readonly contractHash: string
  readonly scope: ReachMissionScope
}

function missionScope(contract: ReachTransitionContract): ReachMissionScope {
  // VTR Mission identity is predicate-based. Include the unsatisfied-Mission
  // precondition so a changed required count is a different scope even when its
  // navigation predicate (the resource type) remains the same.
  const missionRequirement = contract.requires.find(({ id }) => id === 'mission.unsatisfied')
  return {
    predicateIdentity: contract.desiredPredicateIdentity,
    missionRequirement: JSON.stringify(missionRequirement?.proposition ?? null),
    worldKey: contract.identity.worldKey,
    dimension: contract.identity.dimension,
    worldEpoch: contract.identity.worldEpoch,
  }
}

function sameMissionWorldScope(exclusion: TerminalWitnessExclusion, scope: ReachMissionScope): boolean {
  return exclusion.predicateIdentity === scope.predicateIdentity &&
    exclusion.missionRequirement === scope.missionRequirement &&
    exclusion.worldKey === scope.worldKey &&
    exclusion.dimension === scope.dimension &&
    exclusion.worldEpoch === scope.worldEpoch
}

function isTerminalWitnessBoundary(outcome: ReachTerminalOutcome): boolean {
  return outcome.kind === 'BUDGET_EXHAUSTED' ||
    outcome.kind === 'PROVEN_INFEASIBLE' ||
    outcome.kind === 'CONTRACT_VIOLATION'
}

function bindMissionSnapshot(contract: ReachTransitionContract, snapshot: ReachRuntimeSnapshot): ReachRuntimeSnapshot {
  // Candidate geometry is prepared by the runtime adapter, while predicate
  // identity is owned by the VTR-derived contract. Bind it here before the
  // scheduler can admit or continue a route.
  let changed = false
  const routes = snapshot.routes.map((route) => {
    if (route.witness.desiredPredicateIdentity === contract.desiredPredicateIdentity) return route
    changed = true
    return { ...route, witness: { ...route.witness, desiredPredicateIdentity: contract.desiredPredicateIdentity } }
  })
  return changed ? { ...snapshot, routes } : snapshot
}

function withObservedLeaseLoss(snapshot: ReachRuntimeSnapshot, observedLeaseId: string): ReachRuntimeSnapshot {
  const identity: ReachIdentity = {
    ...snapshot.observation.identity,
    leaseId: observedLeaseId,
  }
  return {
    ...snapshot,
    observation: { ...snapshot.observation, identity },
  }
}

function missionSessionSnapshot(session: ReachMissionRuntimeSession): Readonly<ReachMissionRuntimeSession> {
  return Object.freeze({
    ...session,
    mission: Object.freeze({ ...session.mission }),
    ensures: Object.freeze([...session.ensures]),
    identity: Object.freeze({ ...session.identity }),
  })
}

/**
 * Production VTR ownership boundary for the first Mission→Reach slice.
 *
 * This composition owns the Mission-to-contract scheduling entry and the single
 * persistent ReachController instance. Its only inputs and outputs are typed
 * VTR DTOs; the Minecraft runtime adapter translates these operations to/from
 * the backend-specific world client.
 */
export class ReachMissionRuntime {
  private readonly controller: ReachController
  private readonly onTerminalHandoff: ReachMissionRuntimeDependencies['onTerminalHandoff']
  private readonly onTransitionNotCommitted: ReachMissionRuntimeDependencies['onTransitionNotCommitted']
  private readonly kernelShadow: KernelShadowSink | undefined
  private terminalWitnessExclusion: TerminalWitnessExclusion | null = null
  private activeContractScope: ActiveContractScope | null = null
  private session: ReachMissionRuntimeSession | null = null

  constructor(dependencies: ReachMissionRuntimeDependencies) {
    this.controller = new ReachController(dependencies.routePolicy, dependencies.commitFreshnessFence)
    this.onTerminalHandoff = dependencies.onTerminalHandoff
    this.onTransitionNotCommitted = dependencies.onTransitionNotCommitted
    this.kernelShadow = dependencies.kernelShadow
  }

  /** Fire-and-forget shadow input. A throwing sink is contained: the shadow never affects VTR authority. */
  private shadow(input: Parameters<KernelShadowSink>[0]): void {
    if (this.kernelShadow === undefined) return
    try {
      this.kernelShadow(input)
    } catch {
      // Observation must never break the production runtime.
    }
  }

  get current(): ReachControllerCurrent | null {
    return this.controller.current
  }

  /** Mission/session ownership belongs here; callers receive a read-only projection. */
  get missionSession(): Readonly<ReachMissionRuntimeSession> | null {
    return this.session === null ? null : missionSessionSnapshot(this.session)
  }

  get activeMission(): (Readonly<ReachMissionRuntimeSession> & ReachControllerCurrent) | null {
    const current = this.controller.current
    const session = this.session
    if (current === null || session === null || current.contract.contractHash !== session.contractHash) return null
    return { ...missionSessionSnapshot(session), ...current }
  }

  /**
   * Production Mission scheduler and lifecycle boundary. The adapter prepares
   * immutable typed facts/routes; this runtime alone decides admission,
   * continuation, supersession, and typed controller handoff.
   */
  async driveMission(frame: ReachMissionRuntimeFrame): Promise<ReachMissionRuntimeDecision> {
    const current = this.controller.current
    const session = this.session
    const mission = frame.mission
    this.shadow({
      type: 'world-observation',
      observedAtMs: frame.snapshot.observation.observedAtMs,
      predicates: frame.snapshot.observation.predicates,
    })
    if (mission.id.trim() === '' || mission.item.trim() === '' || !Number.isSafeInteger(mission.count) || mission.count < 1) {
      return { kind: 'declined', reason: 'invalid-mission' }
    }

    if (frame.schedulerOwner === 'human') {
      if (current === null) return frame.probe ? { kind: 'held', reason: 'human-intent-owns-scheduler' } : { kind: 'declined', reason: 'human-intent-owns-scheduler' }
      const result = await this.supersede({
        reason: 'human intent replaced the autonomous Mission owner',
        evidenceId: `human-intent:${frame.snapshot.observation.observedAtMs}`,
        identity: frame.snapshot.observation.identity,
        nowMs: frame.snapshot.observation.observedAtMs,
      })
      if (result.status === 'terminal') {
        return {
          kind: 'transition', result, mission: session?.mission ?? mission, contract: current.contract,
          snapshot: frame.snapshot, started: false, dispatch: false, cancelAction: frame.activeAction !== null,
        }
      }
      return { kind: 'held', reason: 'human-intent-supersession-refused', transitionId: current.contract.transitionId }
    }

    if (current !== null) {
      if (session === null || session.contractHash !== current.contract.contractHash) {
        const result = await this.supersede({
          reason: 'active Reach contract has no matching Mission session',
          evidenceId: `mission-session-mismatch:${current.contract.transitionId}`,
          identity: frame.snapshot.observation.identity,
          nowMs: frame.snapshot.observation.observedAtMs,
        })
        return result.status === 'terminal'
          ? { kind: 'transition', result, mission, contract: current.contract, snapshot: frame.snapshot, started: false, dispatch: false, cancelAction: frame.activeAction !== null }
          : { kind: 'held', reason: 'mission-session-mismatch', transitionId: current.contract.transitionId }
      }
      if (session.mission.id !== mission.id || session.mission.item !== mission.item || session.mission.count !== mission.count) {
        const result = await this.supersede({
          reason: 'parent Mission predicate changed',
          evidenceId: `mission-revision:${mission.id}:${mission.item}:${mission.count}`,
          identity: frame.snapshot.observation.identity,
          nowMs: frame.snapshot.observation.observedAtMs,
        })
        return result.status === 'terminal'
          ? { kind: 'transition', result, mission: session.mission, contract: current.contract, snapshot: frame.snapshot, started: false, dispatch: false, cancelAction: frame.activeAction !== null }
          : { kind: 'held', reason: 'mission-revision-supersession-refused', transitionId: current.contract.transitionId }
      }
      if (frame.activeAction !== null && (
        frame.activeAction.status === 'running' &&
        (frame.activeAction.authority !== 'vtr-reach' || frame.activeAction.transitionId !== current.contract.transitionId)
      )) {
        session.duplicateAuthorityObserved = true
        const currentOwner = frame.activeAction.authority === 'vtr-reach'
          ? `foreign VTR transition ${frame.activeAction.transitionId ?? 'missing'}`
          : `legacy action ${frame.activeAction.id}`
        const result = await this.supersede({
          reason: `${currentOwner} overlapped active Reach contract ${current.contract.transitionId}`,
          evidenceId: `dual-authority:${frame.activeAction.epoch}:${frame.activeAction.id}:${frame.activeAction.transitionId ?? 'missing'}`,
          identity: frame.snapshot.observation.identity,
          nowMs: frame.snapshot.observation.observedAtMs,
        })
        return result.status === 'terminal'
          ? { kind: 'transition', result, mission: session.mission, contract: current.contract, snapshot: frame.snapshot, started: false, dispatch: false, cancelAction: true }
          : { kind: 'held', reason: 'dual-authority-supersession-refused', transitionId: current.contract.transitionId }
      }
      const snapshot = bindMissionSnapshot(current.contract, frame.snapshot)
      if (frame.actuationLease.status === 'lost') {
        const lostSnapshot = withObservedLeaseLoss(snapshot, frame.actuationLease.observedLeaseId)
        const result = await this.tick(lostSnapshot)
        return this.transitionDecision(result, session.mission, current.contract, lostSnapshot, false, frame.activeAction !== null)
      }
      const damage = Math.max(0, session.lastHealth - frame.observedHealth)
      session.lastHealth = frame.observedHealth
      if (damage > 0) {
        const risk = this.observeRisk(current.contract.identity, `world-observation:${snapshot.observation.observedAtMs}`, { damage }, snapshot.observation.observedAtMs)
        if (risk.status === 'terminal') {
          return this.transitionDecision(risk, session.mission, current.contract, snapshot, false, frame.activeAction !== null)
        }
        return { kind: 'held', reason: 'risk-observation-accounted', transitionId: current.contract.transitionId }
      }
      const result = await this.tick(snapshot)
      return this.transitionDecision(result, session.mission, current.contract, snapshot, false, frame.activeAction !== null)
    }

    if (frame.activeAction !== null) {
      if (frame.activeAction.authority === 'vtr-reach') {
        return { kind: 'revoke-action', reason: 'orphan-vtr-actuation-without-active-contract', transitionId: frame.activeAction.transitionId }
      }
      if (frame.activeActionMatchesMissionReach || frame.probe) {
        return { kind: 'revoke-action', reason: frame.activeActionMatchesMissionReach ? 'legacy-reach-handoff' : 'probe-revokes-legacy-actuation' }
      }
      return { kind: 'declined', reason: 'unrelated-action-owns-actuation' }
    }
    if (frame.actuationLease.status === 'lost') return frame.probe ? { kind: 'held', reason: 'actuation-lease-unavailable' } : { kind: 'declined', reason: 'actuation-lease-unavailable' }
    if (frame.actuationLease.leaseId !== frame.snapshot.observation.identity.leaseId) {
      return frame.probe
        ? { kind: 'held', reason: 'lease-identity-mismatch' }
        : { kind: 'declined', reason: 'lease-identity-mismatch' }
    }
    if (frame.missionSatisfiedEvidenceId !== undefined) {
      return frame.probe ? { kind: 'held', reason: 'mission-already-satisfied' } : { kind: 'declined', reason: 'mission-already-satisfied' }
    }
    if (frame.reachAlreadyTrueEvidenceId !== undefined) {
      return frame.probe ? { kind: 'held', reason: 'ensures-already-true' } : { kind: 'declined', reason: 'ensures-already-true' }
    }
    if (!frame.safeToStart) return frame.probe ? { kind: 'held', reason: 'body-not-safe' } : { kind: 'declined', reason: 'body-not-safe' }
    if (frame.snapshot.routes.length === 0) {
      return frame.probe || (frame.inadmissibleRouteIds?.length ?? 0) > 0
        ? { kind: 'held', reason: (frame.inadmissibleRouteIds?.length ?? 0) > 0 ? 'no-admissible-reach-route' : 'no-grounded-reach-candidate' }
        : { kind: 'declined', reason: 'no-grounded-reach-candidate' }
    }

    const plan = this.deriveInventoryReachTransition({
      mission,
      interactionReach: frame.interactionReach,
      sourceNames: frame.sourceNames,
      identity: frame.snapshot.observation.identity,
      transitionId: frame.transitionId,
    })
    const snapshot = bindMissionSnapshot(plan.contract, frame.snapshot)
    this.session = {
      mission,
      transitionId: plan.contract.transitionId,
      contractHash: plan.contract.contractHash,
      ensures: plan.contract.ensures,
      identity: plan.contract.identity,
      jevCallsAtStart: frame.counters.jevCalls,
      system2CallsAtStart: frame.counters.system2Calls,
      authorityConflictsAtStart: frame.counters.authorityConflicts,
      nonVtrActuationsAtStart: frame.counters.nonVtrActuations,
      duplicateAuthorityObserved: false,
      lastHealth: frame.observedHealth,
    }
    const result = await this.commit(plan.contract, snapshot)
    if (result.status !== 'active' && result.status !== 'terminal') {
      this.session = null
      return { kind: 'held', reason: result.status === 'decision_required' ? 'route-decision-required' : 'contract-not-admitted', transitionId: plan.contract.transitionId }
    }
    return this.transitionDecision(result, mission, plan.contract, snapshot, true, false)
  }

  noteAuthorityConflict(): void {
    if (this.session !== null) this.session.duplicateAuthorityObserved = true
  }

  noteMissionHealth(health: number): number {
    if (!Number.isFinite(health)) return 0
    const session = this.session
    if (session === null) return 0
    const damage = Math.max(0, session.lastHealth - health)
    session.lastHealth = health
    return damage
  }

  /** Derive a value contract; adapters may build a typed snapshot from this value before commit. */
  deriveInventoryReachTransition(input: InventoryReachTransitionInput): InventoryReachTransitionPlan {
    return createInventoryReachTransition(input)
  }

  /** Commit an already-derived contract and typed snapshot through VTR ownership. */
  async commit(contract: ReachTransitionContract, snapshot: ReachRuntimeSnapshot): Promise<ReachControllerResult> {
    const scopedSnapshot = this.excludePriorTerminalWitness(contract, snapshot)
    const result = await this.controller.commit(contract, scopedSnapshot)
    if (result.status === 'active' || result.status === 'terminal') {
      this.activeContractScope = { transitionId: contract.transitionId, contractHash: contract.contractHash, scope: missionScope(contract) }
      this.shadow({
        type: 'transition-committed',
        contract,
        witness: result.state.witness,
        lifecycle: result.status,
      })
    } else {
      try {
        this.onTransitionNotCommitted?.(contract.transitionId)
      } catch {
        // Telemetry cleanup must not affect the VTR admission result.
      }
    }
    return result
  }

  /** Re-observe facts and continue the same committed contract. */
  tick(snapshot: ReachRuntimeSnapshot): Promise<ReachControllerResult> {
    return this.controller.tick(snapshot)
  }

  /** Reserve one physical leg before the runtime adapter dispatches it. */
  authorizeMechanicalStep(
    intentId: string,
    identity: ReachIdentity,
    step: ReachMechanicalStepRequest,
  ): ReachStepAuthorization {
    const result = this.controller.authorizeMechanicalStep(intentId, identity, step)
    if (result.status === 'authorized') {
      this.shadow({
        type: 'mechanical-step-issued',
        transitionId: result.transitionId,
        intentId,
        stepId: step.stepId,
        effectKind: step.effectKind,
      })
    }
    return result
  }

  /** Settle executor evidence without allowing an action return to imply SUCCESS. */
  recordMechanicalStepOutcome(
    intentId: string,
    stepId: string,
    input: { readonly snapshot: ReachRuntimeSnapshot; readonly observedRisk?: Readonly<Record<string, number>> },
  ): ReachControllerResult {
    const result = this.controller.recordMechanicalStepOutcome(intentId, stepId, input)
    const transitionId = this.session?.transitionId ?? this.controller.current?.contract.transitionId ?? 'unknown'
    this.shadow({
      type: 'world-observation',
      observedAtMs: input.snapshot.observation.observedAtMs,
      predicates: input.snapshot.observation.predicates,
    })
    this.shadow({
      type: 'mechanical-step-settled',
      transitionId,
      intentId,
      stepId,
      status: result.status,
      verified: result.status === 'terminal' && result.outcome.kind === 'SUCCESS',
      progressed: result.status === 'active',
    })
    return result
  }

  complete(
    intentId: string,
    completion: {
      readonly status: 'completed' | 'failed' | 'cancelled'
      readonly evidenceId: string
      readonly snapshot: ReachRuntimeSnapshot
      readonly observedRisk?: Readonly<Record<string, number>>
    },
  ): Promise<ReachControllerResult> {
    return this.controller.complete(intentId, completion)
  }

  refuseIntent(
    intentId: string,
    input: { readonly identity: ReachIdentity; readonly evidenceId: string; readonly observedAtMs: number },
  ): Promise<ReachControllerResult> {
    return this.controller.refuseIntent(intentId, input)
  }

  observeRisk(
    identity: ReachIdentity,
    observationId: string,
    risk: Readonly<Record<string, number>>,
    nowMs: number,
  ): ReachControllerResult {
    return this.controller.observeRisk(identity, observationId, risk, nowMs)
  }

  supersede(input: { readonly reason: string; readonly evidenceId: string; readonly identity: ReachIdentity; readonly nowMs: number }): ReachControllerResult {
    return this.controller.supersede(input)
  }

  /**
   * Consume an outcome and its final state as one scheduler handoff. The legacy
   * controller exposes these two read/consume methods separately, so the
   * composition joins them synchronously and prevents outcome-only handoffs.
   */
  takeTerminalHandoff(): ReachTerminalHandoff | null {
    const state = this.controller.lastTerminalState
    const outcome = this.controller.takeOutcome()
    if (state === null || outcome === null) return null
    const scope = this.activeContractScope
    if (
      scope !== null &&
      scope.contractHash === state.contractHash &&
      isTerminalWitnessBoundary(outcome) &&
      state.witness !== null
    ) {
      this.terminalWitnessExclusion = { ...scope.scope, witnessId: state.witness.witnessId }
    }
    if (scope !== null && scope.contractHash === state.contractHash) {
      this.shadow({
        type: 'transition-terminal',
        transitionId: scope.transitionId,
        contractHash: state.contractHash,
        outcome,
      })
      try {
        this.onTerminalHandoff?.({
          transitionId: scope.transitionId,
          contractHash: state.contractHash,
          state,
          outcome,
        })
      } catch {
        // Run telemetry must not prevent delivering an already-consumed typed handoff.
      }
    }
    this.activeContractScope = null
    const session = this.session === null ? null : missionSessionSnapshot(this.session)
    this.session = null
    return { contractHash: state.contractHash, state, outcome, session }
  }

  private transitionDecision(
    result: ReachControllerResult,
    mission: InventoryReachTransitionInput['mission'],
    contract: ReachTransitionContract,
    snapshot: ReachRuntimeSnapshot,
    started: boolean,
    actionAlreadyRunning: boolean,
  ): ReachMissionRuntimeDecision {
    if (result.status === 'terminal') return { kind: 'transition', result, mission, contract, snapshot, started, dispatch: false, cancelAction: result.cancelIntentId !== null }
    if (result.status === 'active') {
      return {
        kind: 'transition', result, mission, contract, snapshot, started,
        dispatch: !actionAlreadyRunning && result.phase === 'actuate' && result.intent !== undefined,
        cancelAction: false,
      }
    }
    return { kind: 'held', reason: result.status === 'refused' ? result.reason : result.status, transitionId: contract.transitionId }
  }

  /** Filter a previously terminal witness before VTR asks its route decision policy. */
  private excludePriorTerminalWitness(contract: ReachTransitionContract, snapshot: ReachRuntimeSnapshot): ReachRuntimeSnapshot {
    const exclusion = this.terminalWitnessExclusion
    if (exclusion === null || !sameMissionWorldScope(exclusion, missionScope(contract))) return snapshot
    const routes = snapshot.routes.filter(({ witness }) => witness.witnessId !== exclusion.witnessId)
    return routes.length === snapshot.routes.length ? snapshot : { ...snapshot, routes }
  }
}
