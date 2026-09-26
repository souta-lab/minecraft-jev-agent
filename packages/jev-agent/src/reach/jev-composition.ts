import type { JevPolicy, JevResult } from '../jev/client.ts'
import { JevReachRouteDecisionPolicy } from './route-policy.ts'
import type { WorldState } from '../state.ts'
import { ReachMissionRuntime } from './mission-runtime.ts'
import type {
  ReachCommitFreshnessFence,
  ReachCommitFreshnessInput,
  ReachCommitFreshnessResult,
  ReachRouteDecisionInput,
} from './controller.ts'
import type { ReachIdentity } from './transition.ts'
import type { KernelTransitionAuthority } from '../reach/kernel-authority-map.ts'

export interface JevReachMutableCell<T> {
  value: T
}

export interface JevReachIdentityConfig {
  readonly serverId: string
  readonly worldEpoch: number
  readonly generationId: string | null
  readonly leaseId: string | null
}

export interface JevReachRouteDecisionRecord {
  readonly selectedRouteId: string | null
  readonly policy: JevPolicy['kind']
  readonly source: JevResult['source']
  readonly model: string
  readonly callId: string
  readonly probabilities: Record<string, number> | null
  readonly providerAttempts: number
  readonly accepted: boolean
}

export interface JevReachTelemetryLogger {
  info(source: 'vtr', message: string, detail: Record<string, unknown>, tick: number | null): void
  warn(source: 'vtr', message: string, detail: Record<string, unknown>, tick: number | null): void
}

/** Mutable host cells shared with JevController without capturing the controller itself. */
export interface JevReachVtrCompositionContext {
  /** Host-owned identity scalars are refreshed at generation/lease/world boundaries. */
  serverId: string
  worldEpoch: number
  generationId: string | null
  leaseId: string | null
  readonly policy: JevReachMutableCell<JevPolicy>
  readonly cachedWorldState: JevReachMutableCell<WorldState | null>
  readonly counters: {
    /** Historical compatibility counter: JevPolicy.decide / Decision Frame invocations, not provider requests. */
    readonly jevCalls: JevReachMutableCell<number>
    readonly lastJevAt: JevReachMutableCell<number>
    readonly tickCounter: JevReachMutableCell<number>
  }
  readonly lastRouteDecision: JevReachMutableCell<JevReachRouteDecisionRecord | null>
  readonly logger: JevReachTelemetryLogger
  /**
   * V4.1.2 production-authority gate — REQUIRED. Reach admission, activation,
   * effect issue/settlement and terminalization consult the real kernel before
   * the corresponding production act; denials fail closed. The same gate also
   * carries verified world observations into the kernel fact store.
   */
  readonly kernelAuthority: KernelTransitionAuthority
}

export interface JevReachVtrComposition {
  /** The sole production ReachMissionRuntime instance created for this context. */
  readonly runtime: ReachMissionRuntime
  /** Exposed for deterministic boundary tests; this exact instance is installed in runtime. */
  readonly routePolicy: JevReachRouteDecisionPolicy
}

/** Derive the same backend-independent Reach identity used by the production runtime. */
export function buildJevReachIdentity(
  state: WorldState,
  config: JevReachIdentityConfig,
): ReachIdentity | null {
  const dimension = state.self.dimension
  if (typeof config.serverId !== 'string' || config.serverId.trim() === ''
    || !Number.isSafeInteger(config.worldEpoch) || config.worldEpoch < 0
    || typeof dimension !== 'string' || dimension.trim() === ''
    || typeof config.generationId !== 'string' || config.generationId.trim() === ''
    || typeof config.leaseId !== 'string' || config.leaseId.trim() === '') return null
  return {
    worldKey: `${config.serverId}|${dimension}|${config.worldEpoch}`,
    dimension,
    worldEpoch: config.worldEpoch,
    generationId: config.generationId,
    leaseId: config.leaseId,
  }
}

function sameReachIdentity(left: ReachIdentity, right: ReachIdentity): boolean {
  return left.worldKey === right.worldKey
    && left.dimension === right.dimension
    && left.worldEpoch === right.worldEpoch
    && left.generationId === right.generationId
    && left.leaseId === right.leaseId
}

/** Read only a cached typed observation matching the exact decision epoch and Reach identity. */
function currentReachWorldState(
  context: JevReachVtrCompositionContext,
  input: ReachRouteDecisionInput,
): WorldState | null {
  const state = context.cachedWorldState.value
  if (state === null
    || state.timestampMs !== input.observedAtMs
    || state.self.dimension !== input.identity.dimension) return null
  const identity = buildJevReachIdentity(state, context)
  return identity !== null && sameReachIdentity(identity, input.identity) ? state : null
}

function commitFreshness(
  context: JevReachVtrCompositionContext,
  { contract, snapshot }: ReachCommitFreshnessInput,
): ReachCommitFreshnessResult {
  const currentState = context.cachedWorldState.value
  if (currentState === null) return { status: 'stale', reason: 'unavailable' }
  const currentIdentity = buildJevReachIdentity(currentState, context)
  if (currentIdentity === null) return { status: 'stale', reason: 'unavailable' }
  const submittedIdentity = snapshot.observation.identity
  if (!sameReachIdentity(currentIdentity, submittedIdentity)
    || !sameReachIdentity(currentIdentity, contract.identity)) {
    return { status: 'stale', reason: 'identity_changed', currentIdentity }
  }
  if (currentState.timestampMs !== snapshot.observation.observedAtMs) {
    return {
      status: 'stale',
      reason: 'observation_advanced',
      currentObservedAtMs: currentState.timestampMs,
      currentIdentity,
    }
  }
  return { status: 'current' }
}

function recordDecisionFrameInvocation(context: JevReachVtrCompositionContext): void {
  context.counters.jevCalls.value += 1
  context.counters.lastJevAt.value = Date.now()
}

interface ReachRouteTransitionMetrics {
  readonly contractHash: string
  decisionFrameInvocations: number
  providerEvaluateAttempts: number
}

function metricsForTransition(
  metrics: Map<string, ReachRouteTransitionMetrics>,
  input: ReachRouteDecisionInput,
): ReachRouteTransitionMetrics {
  const existing = metrics.get(input.transitionId)
  if (existing !== undefined && existing.contractHash === input.contractHash) return existing
  const created: ReachRouteTransitionMetrics = {
    contractHash: input.contractHash,
    decisionFrameInvocations: 0,
    providerEvaluateAttempts: 0,
  }
  metrics.set(input.transitionId, created)
  return created
}

function recordRouteResult(
  context: JevReachVtrCompositionContext,
  input: ReachRouteDecisionInput,
  result: JevResult,
  selectedRouteId: string | null,
  accepted: boolean,
): void {
  const answer = result.answers.action
  const providerAttempts = result.providerAttempts ?? 0
  context.lastRouteDecision.value = {
    selectedRouteId,
    policy: result.policy,
    source: result.source,
    model: result.model,
    callId: result.callId,
    probabilities: answer?.probabilities ?? null,
    providerAttempts,
    accepted,
  }
  context.logger.info(
    'vtr',
    `VTR_REACH_ROUTE_DECISION transition=${input.transitionId} selected=${selectedRouteId ?? 'unavailable'} source=${result.source} policy=${result.policy} model=${result.model}`,
    {
      transitionId: input.transitionId,
      contractHash: input.contractHash,
      desiredPredicate: input.contract.desiredPredicate,
      routeIds: input.routes.map((route) => route.routeId),
      selectedRouteId,
      accepted,
      selectedGroundedRouteId: accepted ? selectedRouteId : null,
      source: result.source,
      policy: result.policy,
      model: result.model,
      callId: result.callId,
      latencyMs: result.latencyMs,
      providerAttempts,
      actionProbability: answer?.probability ?? null,
      probabilities: answer?.probabilities ?? null,
      identity: input.identity,
    },
    context.counters.tickCounter.value,
  )
}

function recordRouteFailure(
  context: JevReachVtrCompositionContext,
  input: ReachRouteDecisionInput,
  reason: string,
): void {
  context.lastRouteDecision.value = null
  context.logger.warn(
    'vtr',
    `VTR_REACH_ROUTE_DECISION transition=${input.transitionId} selected=unavailable reason=${reason}`,
    {
      transitionId: input.transitionId,
      contractHash: input.contractHash,
      routeIds: input.routes.map((route) => route.routeId),
      reason,
      identity: input.identity,
    },
    context.counters.tickCounter.value,
  )
}

/** Compose Jev's bounded route decision policy with the one persistent VTR Reach runtime. */
export function createJevReachVtrComposition(
  context: JevReachVtrCompositionContext,
): JevReachVtrComposition {
  const transitionMetrics = new Map<string, ReachRouteTransitionMetrics>()
  const routePolicy = new JevReachRouteDecisionPolicy({
    policy: () => context.policy.value,
    worldState: (input) => currentReachWorldState(context, input),
    onCallStart: (input) => {
      recordDecisionFrameInvocation(context)
      metricsForTransition(transitionMetrics, input).decisionFrameInvocations += 1
    },
    onProviderAttempt: (input) => {
      metricsForTransition(transitionMetrics, input).providerEvaluateAttempts += 1
    },
    onResult: (input, result, selectedRouteId, accepted) =>
      recordRouteResult(context, input, result, selectedRouteId, accepted),
    onFailure: (input, reason) => recordRouteFailure(context, input, reason),
  })
  const commitFreshnessFence: ReachCommitFreshnessFence = (input) => commitFreshness(context, input)
  const runtime = new ReachMissionRuntime({
    routePolicy,
    commitFreshnessFence,
    kernelAuthority: context.kernelAuthority,
    onTransitionNotCommitted: (transitionId) => { transitionMetrics.delete(transitionId) },
    onTerminalHandoff: ({ transitionId, contractHash, state, outcome }) => {
      const routeMetrics = transitionMetrics.get(transitionId)
      const decisionFrameInvocations = routeMetrics?.contractHash === contractHash ? routeMetrics.decisionFrameInvocations : 0
      const providerEvaluateAttempts = routeMetrics?.contractHash === contractHash ? routeMetrics.providerEvaluateAttempts : 0
      const mechanicalSteps = state.usage.mechanicalSteps
      const decisionFramesPerMechanicalStep = mechanicalSteps === 0 ? null : decisionFrameInvocations / mechanicalSteps
      const providerAttemptsPerMechanicalStep = mechanicalSteps === 0 ? null : providerEvaluateAttempts / mechanicalSteps
      context.logger.info(
        'vtr',
        `VTR_TRANSITION_MODEL_METRICS transitionId=${transitionId} contractHash=${contractHash} outcome=${outcome.kind} mechanicalSteps=${mechanicalSteps} decisionFrameInvocations=${decisionFrameInvocations} providerEvaluateAttempts=${providerEvaluateAttempts}`,
        {
          transitionId,
          contractHash,
          typedTerminalOutcome: outcome.kind,
          mechanicalSteps,
          jevDecisionFrameInvocations: decisionFrameInvocations,
          jevDecisionFramesPerMechanicalStep: decisionFramesPerMechanicalStep,
          jevModelProviderEvaluateAttempts: providerEvaluateAttempts,
          jevModelProviderEvaluateAttemptsPerMechanicalStep: providerAttemptsPerMechanicalStep,
          policy: 'jev-reach-route',
          identity: state.identity,
        },
        context.counters.tickCounter.value,
      )
      transitionMetrics.delete(transitionId)
    },
  })
  return { runtime, routePolicy }
}
