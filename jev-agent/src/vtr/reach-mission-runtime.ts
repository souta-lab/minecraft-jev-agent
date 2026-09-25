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
  type InventoryReachMission,
} from './reach-scheduler.ts'
import type {
  ReachIdentity,
  ReachMechanicalStepRequest,
  ReachTerminalOutcome,
  ReachTransitionContract,
  ReachTransitionState,
} from './reach.ts'

/** VTR policy dependencies. Production supplies Jev; tests/offline probes may supply an explicit policy. */
export interface ReachMissionRuntimeDependencies {
  readonly routePolicy: ReachRouteDecisionPolicy
  readonly commitFreshnessFence: ReachCommitFreshnessFence
}

/** A typed Mission request. Snapshot facts and candidate routes contain no runtime client objects. */
export interface StartInventoryReachInput {
  readonly mission: InventoryReachMission
  readonly interactionReach: number
  readonly sourceNames: readonly string[]
  readonly identity: ReachIdentity
  readonly transitionId: string
  /** Typed Minecraft adapter projects facts/routes only after VTR derives the contract. */
  readonly snapshotForContract: (contract: ReachTransitionContract) => ReachRuntimeSnapshot
}

export interface InventoryReachCommit {
  readonly mission: InventoryReachMission
  readonly contract: ReachTransitionContract
  readonly result: ReachControllerResult
}

export interface ReachTerminalHandoff {
  readonly contractHash: string
  readonly state: ReachTransitionState
  readonly outcome: ReachTerminalOutcome
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
  private terminalWitnessExclusion: TerminalWitnessExclusion | null = null
  private activeContractScope: ActiveContractScope | null = null

  constructor(dependencies: ReachMissionRuntimeDependencies) {
    this.controller = new ReachController(dependencies.routePolicy, dependencies.commitFreshnessFence)
  }

  get current(): ReachControllerCurrent | null {
    return this.controller.current
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
      this.activeContractScope = { contractHash: contract.contractHash, scope: missionScope(contract) }
    }
    return result
  }

  /**
   * Temporary strangler compatibility for callers that still need a callback
   * to project a snapshot after contract derivation. Delete once
   * `controller-legacy.ts` uses deriveInventoryReachTransition() followed by
   * typed snapshot construction and commit(contract, snapshot).
   *
   * @deprecated Use deriveInventoryReachTransition() and commit().
   */
  async startInventoryReach(input: StartInventoryReachInput): Promise<InventoryReachCommit> {
    const { contract } = this.deriveInventoryReachTransition({
      mission: input.mission,
      interactionReach: input.interactionReach,
      sourceNames: input.sourceNames,
      identity: input.identity,
      transitionId: input.transitionId,
    })
    const snapshot = input.snapshotForContract(contract)
    return {
      mission: input.mission,
      contract,
      result: await this.commit(contract, snapshot),
    }
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
    return this.controller.authorizeMechanicalStep(intentId, identity, step)
  }

  /** Settle executor evidence without allowing an action return to imply SUCCESS. */
  recordMechanicalStepOutcome(
    intentId: string,
    stepId: string,
    input: { readonly snapshot: ReachRuntimeSnapshot; readonly observedRisk?: Readonly<Record<string, number>> },
  ): ReachControllerResult {
    return this.controller.recordMechanicalStepOutcome(intentId, stepId, input)
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
    this.activeContractScope = null
    return { contractHash: state.contractHash, state, outcome }
  }

  /** Filter a previously terminal witness before VTR asks its route decision policy. */
  private excludePriorTerminalWitness(contract: ReachTransitionContract, snapshot: ReachRuntimeSnapshot): ReachRuntimeSnapshot {
    const exclusion = this.terminalWitnessExclusion
    if (exclusion === null || !sameMissionWorldScope(exclusion, missionScope(contract))) return snapshot
    const routes = snapshot.routes.filter(({ witness }) => witness.witnessId !== exclusion.witnessId)
    return routes.length === snapshot.routes.length ? snapshot : { ...snapshot, routes }
  }
}
