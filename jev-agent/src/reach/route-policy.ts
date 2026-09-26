import type { Candidate } from '../candidates.ts'
import type { JevPolicy, JevResult } from '../jev-legacy.ts'
import type { WorldState, Vec3Json } from '../state.ts'
import type {
  ReachRouteDecision,
  ReachRouteDecisionInput,
  ReachRouteDecisionPolicy,
} from './controller.ts'

const REACH_ROUTE_INSTRUCTIONS =
  'Choose exactly one currently grounded route for the active VTR Reach transition. Every offered route preserves the ' +
  'same immutable desired predicate, admissible effects, risk/resource budget, world identity, and deterministic success ' +
  'verification. Choose using the current world facts, witness evidence, route distance, risk, and recent failure evidence. ' +
  'You may choose only an offered route id. Do not change the desired predicate, add effects, or infer success from movement.'

export interface JevReachRouteDecisionCallbacks {
  readonly policy: () => JevPolicy
  /** The runtime adapter returns only the fresh typed WorldState matching this exact observation. */
  readonly worldState: (input: ReachRouteDecisionInput) => WorldState | null
  readonly onCallStart: (input: ReachRouteDecisionInput) => void
  readonly onProviderAttempt?: (input: ReachRouteDecisionInput) => void
  readonly onResult: (input: ReachRouteDecisionInput, result: JevResult, selectedRouteId: string | null, accepted: boolean) => void
  readonly onFailure: (input: ReachRouteDecisionInput, reason: string) => void
}

function position(value: unknown): Vec3Json | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  return typeof record.x === 'number' && Number.isFinite(record.x) &&
    typeof record.y === 'number' && Number.isFinite(record.y) &&
    typeof record.z === 'number' && Number.isFinite(record.z)
    ? { x: record.x, y: record.y, z: record.z }
    : null
}

function missionItem(input: ReachRouteDecisionInput): string {
  const proposition = input.contract.desiredPredicate.proposition
  if (typeof proposition === 'object' && proposition !== null && !Array.isArray(proposition)) {
    const item = (proposition as Record<string, unknown>).item
    if (typeof item === 'string' && item.trim() !== '') return item
  }
  return input.contract.desiredPredicate.id
}

function candidateForRoute(input: ReachRouteDecisionInput, routeIndex: number): Candidate | null {
  const route = input.routes[routeIndex]
  if (route === undefined) return null
  const target = position(route.waypoint?.target ?? route.witness.target)
  if (target === null) return null
  const item = missionItem(input)
  const sourceName = route.witness.witnessId.split('@', 1)[0] || item
  const witnessPosition = position(route.witness.target)
  return {
    id: route.routeId,
    kind: 'MOVE',
    label: `Continue Reach(${item}) via ${route.tactic} to ${sourceName} at ${target.x},${target.y},${target.z}; distance=${route.estimatedDistance.toFixed(2)}; risk=${JSON.stringify(route.risk)}`,
    targetName: sourceName,
    target,
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: false,
    hasStandableAdjacent: true,
    meta: {
      vtrTransitionId: input.transitionId,
      vtrContractHash: input.contractHash,
      vtrRouteId: route.routeId,
      vtrDesiredPredicateIdentity: input.desiredPredicateIdentity,
      tactic: route.tactic,
      effectKind: route.effectKind,
      estimatedDistance: route.estimatedDistance,
      witnessId: route.witness.witnessId,
      witnessEvidenceId: route.witness.evidenceId,
      witnessPosition: witnessPosition === null ? 'unknown' : `${witnessPosition.x},${witnessPosition.y},${witnessPosition.z}`,
    },
  }
}

/**
 * Production Jev Decision Frame adapter for grounded route choices. It uses
 * only typed route facts and a fresh WorldState supplied by the Minecraft
 * runtime adapter; Jev proposes a route id, while ReachController revalidates
 * and owns the intent.
 */
export class JevReachRouteDecisionPolicy implements ReachRouteDecisionPolicy {
  constructor(private readonly callbacks: JevReachRouteDecisionCallbacks) {}

  async chooseRoute(input: ReachRouteDecisionInput): Promise<ReachRouteDecision> {
    const state = this.callbacks.worldState(input)
    if (state === null || state.timestampMs !== input.observedAtMs || state.self.dimension !== input.identity.dimension) {
      const reason = 'fresh_reach_world_state_unavailable'
      this.callbacks.onFailure(input, reason)
      return { status: 'unavailable', reason }
    }

    const candidates = input.routes.map((_route, index) => candidateForRoute(input, index))
    if (candidates.some((candidate) => candidate === null)) {
      const reason = 'grounded_route_could_not_be_projected_to_jev_candidate'
      this.callbacks.onFailure(input, reason)
      return { status: 'unavailable', reason }
    }
    const groundedCandidates = candidates as Candidate[]
    try {
      const policy = this.callbacks.policy()
      try {
        this.callbacks.onCallStart(input)
      } catch {
        // Telemetry must not prevent invoking the configured Jev policy.
      }
      const result = await policy.decide({
        stage: `vtr-reach-route-${input.transitionId}`,
        state,
        candidates: groundedCandidates,
        questionNames: ['action'],
        onProviderAttempt: () => this.callbacks.onProviderAttempt?.(input),
        decisionFrame: {
          kind: 'vtr-reach-route',
          instructions: REACH_ROUTE_INSTRUCTIONS,
          context: {
            transitionId: input.contract.transitionId,
            contractHash: input.contract.contractHash,
            desiredPredicateIdentity: input.contract.desiredPredicateIdentity,
            desiredPredicate: input.contract.desiredPredicate,
            requires: input.contract.requires,
            ensures: input.contract.ensures,
            invariants: input.contract.invariants,
            admissibleEffects: input.contract.admissibleEffects,
            budget: input.contract.budget,
            controller: input.contract.controller,
            identity: input.contract.identity,
            progressDefinition: input.contract.progressDefinition,
            observation: input.observation,
            progress: input.progress,
            currentRouteId: input.currentRouteId,
            routes: input.routes,
          },
        },
      })
      const answer = result.answers.action
      const selectedRouteId = typeof answer?.value === 'string' ? answer.value : null
      const observationIsCurrent = this.callbacks.worldState(input) !== null
      const routeIsOffered = selectedRouteId !== null && input.routes.some((route) => route.routeId === selectedRouteId)
      const accepted = observationIsCurrent && routeIsOffered
      this.callbacks.onResult(input, result, selectedRouteId, accepted)
      if (!observationIsCurrent) {
        return { status: 'unavailable', reason: 'reach_observation_superseded_during_jev_decision' }
      }
      return routeIsOffered
        ? { status: 'selected', routeId: selectedRouteId! }
        : { status: 'unavailable', reason: `jev_returned_unoffered_route:${selectedRouteId ?? 'missing'}` }
    } catch (error) {
      const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      this.callbacks.onFailure(input, reason)
      return { status: 'unavailable', reason: `jev_route_policy_failed:${reason}` }
    }
  }
}
