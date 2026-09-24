import {
  finishReachForMissionSatisfied,
  interruptReachForSafety,
  recordReachMechanicalStep,
  recordReachObservedRisk,
  recordReachProgress,
  setReachTactic,
  setReachTemporaryWaypoint,
  startReachTransition,
  supersedeReachTransition,
  substituteReachWitness,
  terminateReachAsInfeasible,
  verifyReachEnsures,
  type ReachIdentity,
  type ReachJson,
  type ReachMechanicalStepRequest,
  type ReachObservation,
  type ReachProgressEvidence,
  type ReachTactic,
  type ReachTerminalOutcome,
  type ReachTransitionContract,
  type ReachTransitionState,
  type ReachWitness,
  type ReachTemporaryWaypoint,
} from './reach.ts'

/** A candidate realization of the same desired Reach predicate. No backend objects cross this port. */
export interface ReachRoute {
  readonly routeId: string
  /** Snapshot predicate whose TRUE evidence grounds this exact route/witness. */
  readonly groundingPredicateId: string
  /** When present, this separate TRUE snapshot predicate must ground the temporary waypoint. */
  readonly waypointGroundingPredicateId: string | null
  readonly witness: ReachWitness
  readonly waypoint: ReachTemporaryWaypoint | null
  readonly tactic: ReachTactic
  readonly effectKind: string
  readonly estimatedDistance: number
  /** Estimated total route consumption, checked against the remaining contract budget. */
  readonly resources: Readonly<Record<string, number>>
  readonly risk: Readonly<Record<string, number>>
  readonly policyData?: Readonly<Record<string, ReachJson>>
}

export interface ReachRuntimeSnapshot {
  readonly observation: ReachObservation
  readonly routes: readonly ReachRoute[]
  readonly progress: Omit<ReachProgressEvidence, 'observation'>
  /** Set only when fresh deterministic evidence says the parent Mission predicate is already satisfied. */
  readonly parentMissionSatisfied?: { readonly evidenceId: string }
  readonly safetyInterruption?: { readonly reason: string; readonly evidenceId: string }
  readonly infeasibility?: { readonly reason: string; readonly evidenceId: string }
}

export interface ReachRouteDecisionInput {
  readonly transitionId: string
  readonly contractHash: string
  readonly desiredPredicateIdentity: string
  readonly identity: ReachIdentity
  readonly observedAtMs: number
  readonly currentRouteId: string | null
  readonly routes: readonly ReachRoute[]
}

export type ReachRouteDecision =
  | { readonly status: 'selected'; readonly routeId: string }
  | { readonly status: 'unavailable'; readonly reason: string }

/** Jev adapter seam: called only when more than one grounded route remains and no active route can continue. */
export interface ReachRouteDecisionPolicy {
  chooseRoute(input: ReachRouteDecisionInput): Promise<ReachRouteDecision>
}

/** Explicit deterministic policy for no-LLM probes and configured offline runs. */
export const nearestGroundedReachRoutePolicy: ReachRouteDecisionPolicy = {
  async chooseRoute({ routes }): Promise<ReachRouteDecision> {
    const selected = [...routes].sort((a, b) =>
      a.estimatedDistance - b.estimatedDistance ||
      Object.values(a.risk).reduce((sum, amount) => sum + amount, 0) - Object.values(b.risk).reduce((sum, amount) => sum + amount, 0) ||
      a.routeId.localeCompare(b.routeId),
    )[0]
    return selected === undefined ? { status: 'unavailable', reason: 'no_grounded_routes' } : { status: 'selected', routeId: selected.routeId }
  },
}

/** Typed command for the runtime adapter. The adapter must reserve each physical leg before dispatch. */
export interface ReachMechanicalIntent {
  readonly intentId: string
  readonly transitionId: string
  readonly contractHash: string
  readonly desiredPredicateIdentity: string
  readonly routeId: string
  readonly identity: ReachIdentity
  readonly target: ReachJson
  readonly waypoint: ReachTemporaryWaypoint | null
  readonly tactic: ReachTactic
  readonly effectKind: string
  readonly estimatedDistance: number
  readonly resources: Readonly<Record<string, number>>
  readonly risk: Readonly<Record<string, number>>
  readonly createdAtMs: number
}

export type ReachControllerResult =
  | {
      readonly status: 'active'
      readonly phase: 'actuate' | 'waiting' | 'decision_required'
      readonly transitionId: string
      readonly contractHash: string
      readonly state: ReachTransitionState
      readonly intent?: ReachMechanicalIntent
      readonly reason?: string
      readonly routeIds?: readonly string[]
    }
  | {
      readonly status: 'terminal'
      readonly state: ReachTransitionState
      readonly outcome: ReachTerminalOutcome
      readonly cancelIntentId: string | null
    }
  | {
      readonly status: 'decision_required'
      readonly transitionId: string
      readonly contractHash: string
      readonly reason: string
      readonly routeIds: readonly string[]
    }
  | { readonly status: 'not_enabled'; readonly blockers: readonly string[] }
  | { readonly status: 'refused'; readonly reason: string }

export type ReachStepAuthorization =
  | { readonly status: 'authorized'; readonly transitionId: string; readonly contractHash: string; readonly state: ReachTransitionState; readonly stepId: string }
  | { readonly status: 'terminal'; readonly state: ReachTransitionState; readonly outcome: ReachTerminalOutcome; readonly cancelIntentId: string | null }
  | { readonly status: 'refused'; readonly reason: string }

export interface ReachControllerCurrent {
  readonly contract: ReachTransitionContract
  readonly state: ReachTransitionState
  readonly route: ReachRoute
  readonly intent: ReachMechanicalIntent | null
  readonly inFlightStepId: string | null
  readonly lastCompletion: ActiveReach['lastCompletion']
}

interface ActiveReach {
  readonly contract: ReachTransitionContract
  state: ReachTransitionState
  route: ReachRoute
  intent: ReachMechanicalIntent | null
  inFlightStepId: string | null
  intentSequence: number
  lastObservedAtMs: number | null
  lastCompletion: { readonly status: 'completed' | 'failed' | 'cancelled'; readonly evidenceId: string; readonly atMs: number } | null
}

type SelectedRoute = { readonly status: 'selected'; readonly route: ReachRoute }
  | { readonly status: 'none' }
  | { readonly status: 'decision_required'; readonly reason: string; readonly routeIds: readonly string[] }
type RouteApplyResult = { readonly status: 'active'; readonly state: ReachTransitionState }
  | { readonly status: 'terminal'; readonly state: ReachTransitionState; readonly outcome: ReachTerminalOutcome }

function sameIdentity(a: ReachIdentity, b: ReachIdentity): boolean {
  return a.worldKey === b.worldKey && a.dimension === b.dimension && a.worldEpoch === b.worldEpoch &&
    a.generationId === b.generationId && a.leaseId === b.leaseId
}

function finiteJson(value: ReachJson): boolean {
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(finiteJson)
  if (value !== null && typeof value === 'object') return Object.values(value).every(finiteJson)
  return true
}

function isPosition(value: ReachJson): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Readonly<Record<string, ReachJson>>
  return typeof record.x === 'number' && Number.isFinite(record.x) &&
    typeof record.y === 'number' && Number.isFinite(record.y) &&
    typeof record.z === 'number' && Number.isFinite(record.z) && finiteJson(value)
}

function nonEmpty(value: string): boolean {
  return value.trim().length > 0
}

function finiteNonNegativeRecord(value: Readonly<Record<string, number>>): boolean {
  return Object.entries(value).every(([key, amount]) => nonEmpty(key) && Number.isFinite(amount) && amount >= 0)
}

function sameJson(a: ReachJson | null, b: ReachJson | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function sameWaypoint(a: ReachTemporaryWaypoint | null, b: ReachTemporaryWaypoint | null): boolean {
  return a?.waypointId === b?.waypointId && a?.evidenceId === b?.evidenceId && sameJson(a?.target ?? null, b?.target ?? null)
}

function sameWitness(a: ReachWitness | null, b: ReachWitness): boolean {
  return a?.witnessId === b.witnessId && a.evidenceId === b.evidenceId && a.observedAtMs === b.observedAtMs &&
    a.desiredPredicateIdentity === b.desiredPredicateIdentity && sameJson(a.target, b.target)
}

function routeIsGrounded(contract: ReachTransitionContract, snapshot: ReachRuntimeSnapshot, route: ReachRoute): boolean {
  const { witness, waypoint } = route
  const observation = snapshot.observation
  const grounding = observation.predicates[route.groundingPredicateId]
  if (!nonEmpty(route.routeId) || !nonEmpty(route.effectKind) || !Number.isFinite(route.estimatedDistance) || route.estimatedDistance < 0) return false
  if (!nonEmpty(route.groundingPredicateId) || grounding?.truth !== 'true' || !nonEmpty(grounding.evidenceId ?? '') || grounding.evidenceId !== witness.evidenceId) return false
  if (!contract.controller.allowedTactics.includes(route.tactic)) return false
  if (!contract.admissibleEffects.some((effect) => effect.kind === route.effectKind)) return false
  if (!finiteNonNegativeRecord(route.resources) || !finiteNonNegativeRecord(route.risk)) return false
  if (route.policyData !== undefined && !Object.values(route.policyData).every(finiteJson)) return false
  if (witness.desiredPredicateIdentity !== contract.desiredPredicateIdentity || !nonEmpty(witness.witnessId) || !nonEmpty(witness.evidenceId)) return false
  if (!sameIdentity(witness.observedIdentity, contract.identity) || !sameIdentity(witness.observedIdentity, observation.identity)) return false
  if (witness.observedAtMs !== observation.observedAtMs || !isPosition(witness.target)) return false
  if (waypoint !== null) {
    const waypointEvidence = route.waypointGroundingPredicateId === null
      ? undefined
      : observation.predicates[route.waypointGroundingPredicateId]
    if (!contract.controller.allowTemporaryWaypointChanges || !nonEmpty(waypoint.waypointId) || !nonEmpty(waypoint.evidenceId) || !isPosition(waypoint.target)) return false
    if (!nonEmpty(route.waypointGroundingPredicateId ?? '') || waypointEvidence?.truth !== 'true' || waypointEvidence.evidenceId !== waypoint.evidenceId) return false
  } else if (route.waypointGroundingPredicateId !== null) {
    return false
  }
  for (const [resource, amount] of Object.entries(route.resources)) {
    const limit = contract.budget.resources[resource]
    if (limit === undefined || amount > limit) return false
  }
  for (const [risk, amount] of Object.entries(route.risk)) {
    const limit = contract.budget.risk[risk]
    if (limit === undefined || amount > limit) return false
  }
  return true
}

/**
 * Persistent VTR owner for one immutable Reach Contract. It emits typed mechanical
 * intents and accepts typed observations; it never imports or stores a runtime client.
 */
export class ReachController {
  private active: ActiveReach | null = null
  private outcome: ReachTerminalOutcome | null = null
  private terminalState: ReachTransitionState | null = null
  private operationTail: Promise<void> = Promise.resolve()

  constructor(private readonly routePolicy?: ReachRouteDecisionPolicy) {}

  get current(): ReachControllerCurrent | null {
    const active = this.active
    if (active === null) return null
    return {
      contract: active.contract,
      state: active.state,
      route: active.route,
      intent: active.intent,
      inFlightStepId: active.inFlightStepId,
      lastCompletion: active.lastCompletion,
    }
  }

  get currentOutcome(): ReachTerminalOutcome | null {
    return this.outcome
  }

  get lastTerminalState(): ReachTransitionState | null {
    return this.terminalState
  }

  /** Scheduler consumes typed handoff once; until then a new contract cannot hide it. */
  takeOutcome(): ReachTerminalOutcome | null {
    const outcome = this.outcome
    this.outcome = null
    this.terminalState = null
    return outcome
  }

  async commit(contract: ReachTransitionContract, snapshot: ReachRuntimeSnapshot): Promise<ReachControllerResult> {
    return this.exclusive(() => this.commitInternal(contract, snapshot))
  }

  private async commitInternal(contract: ReachTransitionContract, snapshot: ReachRuntimeSnapshot): Promise<ReachControllerResult> {
    if (this.active !== null) return { status: 'refused', reason: `transition ${this.active.contract.transitionId} already owns Reach` }
    if (this.outcome !== null) return { status: 'refused', reason: 'unconsumed typed terminal outcome must be handed to the scheduler first' }
    const routes = this.groundedRoutes(contract, snapshot, null)
    if (routes.length === 0) return { status: 'not_enabled', blockers: ['no_grounded_admissible_reach_route'] }
    const selection = await this.selectRoute(contract, snapshot, routes, null)
    if (selection.status === 'decision_required') {
      return { status: 'decision_required', transitionId: contract.transitionId, contractHash: contract.contractHash, reason: selection.reason, routeIds: selection.routeIds }
    }
    if (selection.status === 'none') return { status: 'not_enabled', blockers: ['no_grounded_admissible_reach_route'] }
    const route = selection.route
    const started = startReachTransition(contract, snapshot.observation, { tactic: route.tactic, witness: route.witness })
    if (started.status === 'not_enabled') return { status: 'not_enabled', blockers: started.blockers }
    if (started.status === 'terminal') return this.close(started.state, started.outcome, null)
    this.active = {
      contract,
      state: started.state,
      route,
      intent: null,
      inFlightStepId: null,
      intentSequence: 0,
      lastObservedAtMs: null,
      lastCompletion: null,
    }
    return this.advance(snapshot, true)
  }

  /** Reconcile fresh facts, verify the contract, then either continue or emit one typed actuation intent. */
  async tick(snapshot: ReachRuntimeSnapshot): Promise<ReachControllerResult> {
    return this.exclusive(() => this.advance(snapshot, true))
  }

  private async advance(snapshot: ReachRuntimeSnapshot, allowDispatch: boolean): Promise<ReachControllerResult> {
    const active = this.active
    if (active === null) return { status: 'refused', reason: 'no active Reach Transition' }
    const { contract } = active
    // A world/generation/lease change must be typed even if its sample time is stale.
    // For the same identity, an equal or older sample cannot verify or move state forward.
    if (sameIdentity(snapshot.observation.identity, contract.identity) &&
      active.lastObservedAtMs !== null && snapshot.observation.observedAtMs <= active.lastObservedAtMs) {
      return this.waiting(active, 'stale_or_replayed_snapshot')
    }
    const verified = verifyReachEnsures(contract, active.state, snapshot.observation)
    if (verified.status === 'terminal') return this.close(verified.state, verified.outcome, active.intent?.intentId ?? null)
    active.state = verified.state
    active.lastObservedAtMs = snapshot.observation.observedAtMs

    if (snapshot.parentMissionSatisfied !== undefined) {
      const finished = finishReachForMissionSatisfied(contract, active.state, snapshot.observation.identity, {
        evidenceId: snapshot.parentMissionSatisfied.evidenceId,
        nowMs: snapshot.observation.observedAtMs,
      })
      if (finished.status === 'terminal') return this.close(finished.state, finished.outcome, active.intent?.intentId ?? null)
    }
    if (snapshot.safetyInterruption !== undefined) {
      const interrupted = interruptReachForSafety(contract, active.state, snapshot.observation.identity, {
        ...snapshot.safetyInterruption,
        nowMs: snapshot.observation.observedAtMs,
      })
      if (interrupted.status === 'terminal') return this.close(interrupted.state, interrupted.outcome, active.intent?.intentId ?? null)
    }
    if (snapshot.infeasibility !== undefined) {
      const impossible = terminateReachAsInfeasible(contract, active.state, snapshot.observation.identity, {
        ...snapshot.infeasibility,
        nowMs: snapshot.observation.observedAtMs,
      })
      if (impossible.status === 'terminal') return this.close(impossible.state, impossible.outcome, active.intent?.intentId ?? null)
    }
    if (verified.status === 'pending' && verified.reason.startsWith('invariants_unknown:')) {
      return this.waiting(active, `invariant_evidence_required:${verified.reason}`)
    }

    const progress: ReachProgressEvidence = { ...snapshot.progress, observation: snapshot.observation }
    const advanced = recordReachProgress(contract, active.state, snapshot.observation.identity, progress)
    if (advanced.status === 'terminal') return this.close(advanced.state, advanced.outcome, active.intent?.intentId ?? null)
    active.state = advanced.state

    if (!allowDispatch) return this.waiting(active, 'completion_verified; next actuation awaits a fresh snapshot')

    if (active.intent !== null) return this.waiting(active, `mechanical_intent_in_flight:${active.intent.intentId}`)

    const routes = this.groundedRoutes(contract, snapshot, active.state)
    if (routes.length === 0) {
      if (snapshot.infeasibility !== undefined) {
        const impossible = terminateReachAsInfeasible(contract, active.state, snapshot.observation.identity, {
          ...snapshot.infeasibility,
          nowMs: snapshot.observation.observedAtMs,
        })
        if (impossible.status === 'terminal') return this.close(impossible.state, impossible.outcome, null)
      }
      return this.waiting(active, 'no_grounded_admissible_route')
    }
    const stillCurrent = routes.find((route) => route.routeId === active.route.routeId)
    const selection = stillCurrent === undefined
      ? await this.selectRoute(contract, snapshot, routes, active.route.routeId)
      : { status: 'selected' as const, route: stillCurrent }
    if (selection.status === 'decision_required') {
      return {
        status: 'active', phase: 'decision_required', transitionId: contract.transitionId,
        contractHash: contract.contractHash, state: active.state, reason: selection.reason, routeIds: selection.routeIds,
      }
    }
    if (selection.status === 'none') return this.waiting(active, 'no_grounded_admissible_route')
    // A safety/risk/supersession event may terminalize the owner while Jev is
    // deciding. Never let the late policy response resurrect its intent.
    if (this.active !== active) return { status: 'refused', reason: 'Reach owner changed during route-policy consultation' }
    if (active.lastObservedAtMs !== snapshot.observation.observedAtMs) {
      return this.waiting(active, 'world_evidence_advanced_during_route-policy_consultation')
    }
    const applied = this.applyRoute(active, selection.route, snapshot.observation)
    if (applied.status === 'terminal') return this.close(applied.state, applied.outcome, null)
    active.state = applied.state
    active.route = selection.route

    const intent = this.makeIntent(active, selection.route, snapshot.observation)
    active.intent = intent
    return { status: 'active', phase: 'actuate', transitionId: contract.transitionId, contractHash: contract.contractHash, state: active.state, intent }
  }

  /** Reserve one physical leg before adapter dispatch; only one leg may be live at a time. */
  authorizeMechanicalStep(intentId: string, identity: ReachIdentity, step: ReachMechanicalStepRequest): ReachStepAuthorization {
    const active = this.active
    if (active === null || active.intent === null || active.intent.intentId !== intentId) return { status: 'refused', reason: 'intent_not_current' }
    if (active.inFlightStepId !== null) return { status: 'refused', reason: `mechanical_step_already_in_flight:${active.inFlightStepId}` }
    if (!sameIdentity(identity, active.contract.identity)) {
      const checked = verifyReachEnsures(active.contract, active.state, {
        identity,
        observedAtMs: Math.max(step.nowMs, active.state.startedAtMs),
        predicates: {},
      })
      if (checked.status === 'terminal') {
        const terminal = this.close(checked.state, checked.outcome, intentId)
        return terminal.status === 'terminal'
          ? { status: 'terminal', state: terminal.state, outcome: terminal.outcome, cancelIntentId: terminal.cancelIntentId }
          : { status: 'refused', reason: 'identity mismatch could not be terminalized' }
      }
      return { status: 'refused', reason: 'identity_mismatch' }
    }
    if (step.effectKind !== active.intent.effectKind) return { status: 'refused', reason: 'step_effect_differs_from_committed_route' }
    const result = recordReachMechanicalStep(active.contract, active.state, identity, step)
    if (result.status === 'terminal') {
      const terminal = this.close(result.state, result.outcome, intentId)
      if (terminal.status === 'terminal') {
        return { status: 'terminal', state: terminal.state, outcome: terminal.outcome, cancelIntentId: terminal.cancelIntentId }
      }
      return { status: 'refused', reason: 'mechanical reservation terminal handoff failed' }
    }
    active.state = result.state
    active.inFlightStepId = step.stepId
    return { status: 'authorized', transitionId: active.contract.transitionId, contractHash: active.contract.contractHash, state: active.state, stepId: step.stepId }
  }

  /** Settle a reserved leg and account observed risk. This never finishes the Reach Transition. */
  recordMechanicalStepOutcome(
    intentId: string,
    stepId: string,
    input: { readonly snapshot: ReachRuntimeSnapshot; readonly observedRisk?: Readonly<Record<string, number>> },
  ): ReachControllerResult {
    const active = this.active
    if (active === null || active.intent === null || active.intent.intentId !== intentId) return { status: 'refused', reason: 'intent_not_current' }
    if (active.inFlightStepId !== stepId) return { status: 'refused', reason: 'step_not_currently_reserved' }
    if (sameIdentity(input.snapshot.observation.identity, active.contract.identity) && active.lastObservedAtMs !== null &&
      input.snapshot.observation.observedAtMs <= active.lastObservedAtMs) {
      return { status: 'refused', reason: 'mechanical_step_snapshot_stale' }
    }
    if (input.observedRisk !== undefined && Object.keys(input.observedRisk).length > 0) {
      const risk = recordReachObservedRisk(active.contract, active.state, input.snapshot.observation.identity, {
        observationId: `step-risk:${stepId}:${input.snapshot.observation.observedAtMs}`,
        risk: input.observedRisk,
        nowMs: input.snapshot.observation.observedAtMs,
      })
      if (risk.status === 'terminal') return this.close(risk.state, risk.outcome, intentId)
      active.state = risk.state
    }
    active.inFlightStepId = null
    const verified = verifyReachEnsures(active.contract, active.state, input.snapshot.observation)
    if (verified.status === 'terminal') return this.close(verified.state, verified.outcome, intentId)
    active.state = verified.state
    active.lastObservedAtMs = input.snapshot.observation.observedAtMs
    return this.waiting(active, 'mechanical_step_settled; intent retains contract ownership')
  }

  /** End the adapter invocation, then re-observe/re-plan inside the same contract. An action result alone is not SUCCESS. */
  async complete(
    intentId: string,
    completion: {
      readonly status: 'completed' | 'failed' | 'cancelled'
      readonly evidenceId: string
      readonly snapshot: ReachRuntimeSnapshot
      readonly observedRisk?: Readonly<Record<string, number>>
    },
  ): Promise<ReachControllerResult> {
    return this.exclusive(() => this.completeInternal(intentId, completion))
  }

  /**
   * Release an intent rejected before dispatch (for example by Guard). This records
   * refusal evidence and frees same-contract replanning; it does not reserve a step,
   * verify SUCCESS, or terminalize the Transition.
   */
  async refuseIntent(
    intentId: string,
    input: { readonly identity: ReachIdentity; readonly evidenceId: string; readonly observedAtMs: number },
  ): Promise<ReachControllerResult> {
    return this.exclusive(async () => {
      const active = this.active
      if (active === null || active.intent === null || active.intent.intentId !== intentId) return { status: 'refused', reason: 'intent_not_current' }
      if (active.inFlightStepId !== null) return { status: 'refused', reason: `reserved_step_not_settled:${active.inFlightStepId}` }
      if (!nonEmpty(input.evidenceId)) return { status: 'refused', reason: 'intent_refusal_requires_evidence_id' }
      if (sameIdentity(input.identity, active.contract.identity) && active.lastObservedAtMs !== null && input.observedAtMs <= active.lastObservedAtMs) {
        return { status: 'refused', reason: 'intent_refusal_evidence_stale' }
      }
      if (!sameIdentity(input.identity, active.contract.identity)) {
        const identityResult = verifyReachEnsures(active.contract, active.state, {
          identity: input.identity,
          observedAtMs: Math.max(input.observedAtMs, active.state.startedAtMs),
          predicates: {},
        })
        if (identityResult.status === 'terminal') return this.close(identityResult.state, identityResult.outcome, null)
        return { status: 'refused', reason: 'identity_mismatch' }
      }
      active.intent = null
      active.lastObservedAtMs = input.observedAtMs
      active.lastCompletion = { status: 'failed', evidenceId: input.evidenceId, atMs: input.observedAtMs }
      return this.waiting(active, 'intent_refused_before_dispatch; awaiting fresh grounded route facts')
    })
  }

  private async completeInternal(
    intentId: string,
    completion: {
      readonly status: 'completed' | 'failed' | 'cancelled'
      readonly evidenceId: string
      readonly snapshot: ReachRuntimeSnapshot
      readonly observedRisk?: Readonly<Record<string, number>>
    },
  ): Promise<ReachControllerResult> {
    const active = this.active
    if (active === null || active.intent === null || active.intent.intentId !== intentId) return { status: 'refused', reason: 'intent_not_current' }
    if (active.inFlightStepId !== null) return { status: 'refused', reason: `reserved_step_not_settled:${active.inFlightStepId}` }
    if (!nonEmpty(completion.evidenceId)) return { status: 'refused', reason: 'completion_requires_evidence_id' }
    if (sameIdentity(completion.snapshot.observation.identity, active.contract.identity) && active.lastObservedAtMs !== null &&
      completion.snapshot.observation.observedAtMs <= active.lastObservedAtMs) {
      return { status: 'refused', reason: 'completion_snapshot_stale' }
    }
    const finishedIntent = active.intent
    active.intent = null
    active.lastCompletion = {
      status: completion.status,
      evidenceId: completion.evidenceId,
      atMs: completion.snapshot.observation.observedAtMs,
    }
    if (completion.observedRisk !== undefined && Object.keys(completion.observedRisk).length > 0) {
      const risk = recordReachObservedRisk(active.contract, active.state, completion.snapshot.observation.identity, {
        observationId: `intent-risk:${finishedIntent.intentId}:${completion.snapshot.observation.observedAtMs}`,
        risk: completion.observedRisk,
        nowMs: completion.snapshot.observation.observedAtMs,
      })
      if (risk.status === 'terminal') return this.close(risk.state, risk.outcome, null)
      active.state = risk.state
    }
    // Verify this completion snapshot, but wait for a newer snapshot before issuing
    // another intent. An executor result by itself cannot close the predicate.
    return this.advance(completion.snapshot, false)
  }

  /** Account world-observed risk between mechanical callbacks without ending the active contract. */
  observeRisk(
    identity: ReachIdentity,
    observationId: string,
    risk: Readonly<Record<string, number>>,
    nowMs: number,
  ): ReachControllerResult {
    const active = this.active
    if (active === null) return { status: 'refused', reason: 'no active Reach Transition' }
    if (sameIdentity(identity, active.contract.identity) && active.lastObservedAtMs !== null && nowMs <= active.lastObservedAtMs) {
      return { status: 'refused', reason: 'risk_observation_stale' }
    }
    const result = recordReachObservedRisk(active.contract, active.state, identity, { observationId, risk, nowMs })
    if (result.status === 'terminal') return this.close(result.state, result.outcome, active.intent?.intentId ?? null)
    active.state = result.state
    active.lastObservedAtMs = nowMs
    return this.waiting(active, 'risk_observed; active Reach contract retained')
  }

  /** A scheduler may end this Transition only with explicit grounded evidence. */
  supersede(input: { readonly reason: string; readonly evidenceId: string; readonly identity: ReachIdentity; readonly nowMs: number }): ReachControllerResult {
    const active = this.active
    if (active === null) return { status: 'refused', reason: 'no active Reach Transition' }
    if (sameIdentity(input.identity, active.contract.identity) && active.lastObservedAtMs !== null && input.nowMs <= active.lastObservedAtMs) {
      return { status: 'refused', reason: 'supersession_evidence_stale' }
    }
    const result = supersedeReachTransition(active.contract, active.state, input.identity, {
      reason: input.reason,
      evidenceId: input.evidenceId,
      nowMs: input.nowMs,
    })
    if (result.status === 'terminal') return this.close(result.state, result.outcome, active.intent?.intentId ?? null)
    return { status: 'refused', reason: 'supersession was not terminalized' }
  }

  private groundedRoutes(contract: ReachTransitionContract, snapshot: ReachRuntimeSnapshot, state: ReachTransitionState | null): ReachRoute[] {
    const counts = new Map<string, number>()
    for (const route of snapshot.routes) counts.set(route.routeId, (counts.get(route.routeId) ?? 0) + 1)
    return snapshot.routes.filter((route) => {
      if (counts.get(route.routeId) !== 1 || !routeIsGrounded(contract, snapshot, route)) return false
      if (state === null) return true
      for (const [resource, amount] of Object.entries(route.resources)) {
        if ((state.usage.resources[resource] ?? 0) + amount > contract.budget.resources[resource]!) return false
      }
      for (const [risk, amount] of Object.entries(route.risk)) {
        if ((state.usage.risk[risk] ?? 0) + amount > contract.budget.risk[risk]!) return false
      }
      const effect = contract.admissibleEffects.find(({ kind }) => kind === route.effectKind)
      if (effect?.maxUses !== null && effect?.maxUses !== undefined && (state.usage.effects[route.effectKind] ?? 0) >= effect.maxUses) return false
      return true
    })
  }

  private async selectRoute(
    contract: ReachTransitionContract,
    snapshot: ReachRuntimeSnapshot,
    routes: readonly ReachRoute[],
    currentRouteId: string | null,
  ): Promise<SelectedRoute> {
    if (routes.length === 1) return { status: 'selected', route: routes[0]! }
    if (routes.length === 0) return { status: 'none' }
    if (this.routePolicy === undefined) {
      return { status: 'decision_required', reason: 'multiple_grounded_routes_require_jev_policy', routeIds: routes.map(({ routeId }) => routeId) }
    }
    let decision: ReachRouteDecision
    try {
      decision = await this.routePolicy.chooseRoute({
        transitionId: contract.transitionId,
        contractHash: contract.contractHash,
        desiredPredicateIdentity: contract.desiredPredicateIdentity,
        identity: snapshot.observation.identity,
        observedAtMs: snapshot.observation.observedAtMs,
        currentRouteId,
        routes,
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return { status: 'decision_required', reason: `jev_route_policy_unavailable:${reason}`, routeIds: routes.map(({ routeId }) => routeId) }
    }
    if (decision.status === 'unavailable') {
      return { status: 'decision_required', reason: decision.reason, routeIds: routes.map(({ routeId }) => routeId) }
    }
    const route = routes.find(({ routeId }) => routeId === decision.routeId)
    if (route === undefined) {
      return { status: 'decision_required', reason: `jev_selected_ungrounded_route:${decision.routeId}`, routeIds: routes.map(({ routeId }) => routeId) }
    }
    return { status: 'selected', route }
  }

  private applyRoute(
    active: ActiveReach,
    route: ReachRoute,
    observation: ReachObservation,
  ): RouteApplyResult {
    let state = active.state
    const { contract } = active
    if (state.tactic !== route.tactic) {
      const changed = setReachTactic(contract, state, observation.identity, route.tactic, observation.observedAtMs)
      if (changed.status === 'terminal') return changed
      state = changed.state
    }
    if (!sameWitness(state.witness, route.witness)) {
      const substituted = substituteReachWitness(contract, state, observation.identity, route.witness, observation.observedAtMs)
      if (substituted.status === 'terminal') return substituted
      state = substituted.state
    }
    if (!sameWaypoint(state.temporaryWaypoint, route.waypoint)) {
      const waypoint = setReachTemporaryWaypoint(contract, state, observation.identity, route.waypoint, observation.observedAtMs)
      if (waypoint.status === 'terminal') return waypoint
      state = waypoint.state
    }
    return { status: 'active', state }
  }

  private makeIntent(active: ActiveReach, route: ReachRoute, observation: ReachObservation): ReachMechanicalIntent {
    active.intentSequence += 1
    const intentId = `${active.contract.transitionId}:intent:${active.intentSequence}`
    return {
      intentId,
      transitionId: active.contract.transitionId,
      contractHash: active.contract.contractHash,
      desiredPredicateIdentity: active.contract.desiredPredicateIdentity,
      routeId: route.routeId,
      identity: active.contract.identity,
      target: route.waypoint?.target ?? route.witness.target,
      waypoint: route.waypoint,
      tactic: route.tactic,
      effectKind: route.effectKind,
      estimatedDistance: route.estimatedDistance,
      resources: route.resources,
      risk: route.risk,
      createdAtMs: observation.observedAtMs,
    }
  }

  private waiting(active: ActiveReach, reason: string): ReachControllerResult {
    return {
      status: 'active', phase: 'waiting', transitionId: active.contract.transitionId,
      contractHash: active.contract.contractHash, state: active.state, reason,
    }
  }

  private close(state: ReachTransitionState, outcome: ReachTerminalOutcome, cancelIntentId: string | null): ReachControllerResult {
    this.active = null
    this.outcome = outcome
    this.terminalState = state
    return { status: 'terminal', state, outcome, cancelIntentId }
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation)
    this.operationTail = result.then(() => undefined, () => undefined)
    return result
  }

}
