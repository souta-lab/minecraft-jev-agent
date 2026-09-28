// controller.ts - the V4.1.2 gameplay controller loop.
//
//   Minecraft adapter -> SENSOR -> WORLD MODEL -> grounded candidates
//     -> JEV DECISION POLICY -> deterministic GUARD -> kernel-admitted
//        TRANSITION -> EXECUTOR -> VERIFY  (repeat)
//
// Authority contract:
//   * The kernel owns every actuation. A controller transition is admitted
//     through KernelTransitionAuthority before the executor claims a lease,
//     carries transitionId/contractHash provenance, and is terminalized with
//     fresh verified facts.
//   * Jev is the fast System-One decision policy over grounded candidates;
//     it does not own execution, termination, or world truth.
//   * System2 is sparse repair only; local failure/stall signals stay bounded
//     policy evidence and never summon a WHAT change by count.
//   * Deterministic truth/safety/mechanics (guard, reachability, VERIFY) are
//     code-owned and never delegated to a model.
import { randomUUID } from 'node:crypto'
import { observedAir } from './air.ts'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Bot } from 'mineflayer'
import pathfinderModule from 'mineflayer-pathfinder'
import { CRAFT_STATION_ALREADY_KNOWN, applyGroundedThreatRestriction, envHazardEscapeRoutes, envHazardReflexAction, frameBuildGrounded, frameBuildMaterialGap, generateGroundedCandidates, optionsWithWithheldStationRetirements, resourceDimensionMatches, restrictCandidatesAtCriticalHealth, restrictCandidatesDuringCriticalDamage, restrictCandidatesDuringEnvHazard, restrictCandidatesDuringSubmersion, surfaceAscentRouteless, restrictCandidatesDuringUnseenAttacker, threatEscalateCandidate, isNotExecutableHereWithheldKind, restrictCandidatesNotExecutableHere, formatNotExecutableHereBinding, formatNotExecutableHereInterrupt } from './candidates.ts'
import type { Candidate, CandidateKind, CandidateOptions, CandidateReachability, NotExecutableHereBinding, ColumnDescentRefusal, CombatKitGapEvidence, EnvHazardReflex, ExploreRouteBlocked, IgnitionRefusal, MobDropSourceGap, PlaceRefusal, PortalEntryRefusal, ProspectRefusal, ReachabilityGateOptions, ResourceSourceExclusion, ResourceSourceGap, SmeltRouteGap, SurfaceAscentRefusal, ThreatOffer, ContactRefusal } from './candidates.ts'
import { ENV_HAZARD, ENV_HAZARD_NO_EXIT, EnvHazardTracker, envHazardDamageSource, formatEnvHazardReflexEvidence } from './envHazard.ts'
import { ARMOR_SLOTS } from './gearPlan.ts'
import { bodySurvivalFacts, DEATH_CAUSE, formatDeathCause, formatMobIdentityChurn, formatSurvivalNoGroundedAction, formatSurvivalReground, regroundVanishedSurvivalChoice, survivalControlFallback, SURVIVAL_DAMAGE_RACE, SURVIVAL_ESCAPE_NONE, SURVIVAL_NO_GROUNDED_ACTION, SURVIVAL_REGROUND, THREAT_NEARBY, THREAT_NO_ESCAPE, THREAT_RANGED_UNANSWERED, ThreatTracker, weaponFacts, THREAT_BREAK_CONTACT } from './threat.ts'
import type { MobIdentityContext } from './threat.ts'
import type { AttackStandFact } from './combatClosure.ts'
import type { ArmorCraftOffer, ArmorCraftRefusal, ArmorRefusal } from './gearPlan.ts'
import { FOOD_SOURCE_NONE } from './foodSources.ts'
import type { FoodSourceGap } from './foodSources.ts'
import { capabilityKey } from './reachability.ts'
import type { DigApproachProbe, DimensionTransferRoute, StationApproachProbe, StationApproachRefusal, StationKindName } from './reachability.ts'
import { makeCausalStamp, makeChainId } from './causal.ts'
import type { CausalGoalRef } from './causal.ts'
import { OptionAttemptTracker, resolveAbandonCooldownMs, resolveUnproductiveAttemptLimit } from './abandonPolicy.ts'
import { AbandonmentLedger } from './protectionConflict.ts'
import type { ActionCommitmentState, CandidateFlapState } from './candidateCommitment.ts'
import { createRecipeIndex } from './crafting.ts'
import type { RecipeIndex } from './crafting.ts'
import { makeDecisionRecord, stableStateHash } from './decisionlog.ts'
// Issue #436 Phase 1: the structural SkillCommitment / CausalTargetIdentity /
// EffectEnvelope contract. This module owns the decision EPOCH and the outcome
// PACKET (see jevSemanticProjection.ts); the commitment module owns what a
// selection is allowed to DO and feeds its real id + contract hashes here.
import { effectEnvelopeHash, postconditionHash, targetIdentityKey } from './skillCommitment.ts'
import { ControllerTransitions } from './controller-transitions.ts'

import type { DecisionJevLog, DecisionLlmLog, DecisionLlmResummonLog, DecisionRecord, DecisionSubgoalLog } from './decisionlog.ts'
// Issue #437: the Skill <-> Jev semantic boundary (projection, decision epochs,
// stable candidate identity, typed SkillOutcomePacket). Raw mechanical telemetry
// stays on the log plane; only these objects cross into policy.
import { commitmentRefFor, formatSkillCommit, formatStaleResultDropped, JevDecisionEpochs } from './jev/semantic-projection.ts'
import type { DecisionEpoch, GroundedFact, JevSemanticProjection, PreviousDecisionFacts, SemanticCandidateView, SkillOutcomePacket } from './jev/semantic-projection.ts'
import { ActionCancelled, defaultExecutorOptions, Executor } from './executor.ts'
import type { CurrentAction, ExecutionResult, ExecutorOptions, FailureCode } from './executor.ts'
import { gateDanger } from './gating.ts'
import type { GatedScore } from './gating.ts'
import { ROW_NOT_EXECUTABLE_HERE, GoalQueue, evaluateStarvedHeadBound, toGoalQueueStateLog } from './goalQueue.ts'
import type { GoalQueueSnapshot, GoalQueueState, HeadAnswerWarrant, PlannedGoal, QueuedGoal } from './goalQueue.ts'
import { queuedToPlanned } from './optionSpec.ts'
import type { OptionWorldSnapshot, Predicate } from './optionSpec.ts'
import { NETHER, OBSIDIAN, SKILL_INTERRUPT, SKILL_POLICY_BOUNDARY, formatSkillStep, formatSkillStepAuthority } from './netherPortalPlan.ts'
import type { PortalEntryPlan, PortalFrameSite, PortalFrameValidation } from './netherPortalPlan.ts'
import type { GoalSuccessWorldProbe, RecordedPortalSite } from './goalSuccess.ts'
import { abandonRequested, createJevPolicy, decisionIdFrom, EventLogger, JsonlWriter } from './jev.ts'
import type { AgentLevel } from './jev.ts'
import { FatalModelError, ModelRecoveryRequested, describeFailure, failLoud } from './modelFailure.ts'
import type { JevPolicy, JevResult } from './jev.ts'
import { guardDecision } from './policy.ts'
import type { GuardCode, GuardResult, InFlightAction } from './policy.ts'
import { DECISION_TRIGGERS, DecisionScheduler, pickHigherPriority, TRIGGER_PRIORITY } from './scheduler.ts'
import type { DecisionTrigger, TriggerEvent } from './scheduler.ts'
import { buildWorldState, distance, isSensedStation, makeGoal } from './state.ts'
import type { AgentSignals, GoalState, KnownResource, Vec3Json, WorldState } from './state.ts'
import type { CurrentOptionContext } from './optionSpec.ts'
import { filterLegacyReachCandidates, minecraftMissionSourceNames, projectMinecraftReachMission } from './minecraft/reach-mission-projection.ts'
import type { InventoryReachMission } from './reach/scheduler.ts'
import { ReachMissionRuntime } from './reach/mission-runtime.ts'
import type { ReachControllerResult, ReachMechanicalIntent, ReachRuntimeSnapshot } from './reach/controller.ts'
import type { ReachMissionRuntimeSession } from './reach/mission-runtime.ts'
import type { KernelTransitionAuthority, MutationAuthorityContext } from './reach/kernel-authority-map.ts'
import { MineflayerReachRuntimeAdapter } from './minecraft/reach-runtime-adapter.ts'
import type { ReachMechanicalActionOutcome, ReachRuntimePorts } from './reach/ports.ts'
import { createJevReachVtrComposition } from './reach/jev-composition.ts'
import type { JevReachRouteDecisionRecord } from './reach/jev-composition.ts'
import type { ReachIdentity, ReachTerminalOutcome, ReachTransitionContract, ReachTransitionState } from './reach/transition.ts'
import type { ReachMissionSnapshotOptions } from './reach/mission-projection.ts'
import { sensorOptions, candidateOptions, currentFocusItem } from './controller-shared.ts'
import type { JevAgentOptions } from './controller-shared.ts'
import * as escalationplane from './escalation.ts'
import type { EscalationHost } from './escalation.ts'
import type { EscalationReason } from './escalation.ts'
import type { PendingDecision } from './decision-epochs.ts'
import * as diagnostics from './candidate-diagnostics.ts'
import { candidateStarvationLine, candidateStarvationMissing, ensureCraftStepActionable, goalPreconditionCause, goalStarvationBlockedBy, MAX_STARVATION_MISSING, mirroredEventToken, withheldToolGaps } from './candidate-diagnostics.ts'
import type { CandidateDiagnosticsHost } from './candidate-diagnostics.ts'
import * as evidence from './grounded-evidence.ts'
import type { GroundedEvidenceHost } from './grounded-evidence.ts'
import * as probes from './path-probes.ts'
import type { PathProbesHost } from './path-probes.ts'
import * as portal from './portal-evidence.ts'
import type { PortalEvidenceHost } from './portal-evidence.ts'
import * as threat from './threat-observers.ts'
import type { ThreatObserverHost } from './threat-observers.ts'
import * as retrieval from './retrieval-progress.ts'
import type { RetrievalProgressHost } from './retrieval-progress.ts'
import { DESCEND_STALL_TICKS, KNOWN_RETRIEVE_RETIRE_LIMIT, RETRIEVAL_STALL_TICKS, decideKnownRetrieve, filterKnownResources, formatKnownResourceRetired, shouldClearActiveRetrieval } from './retrieval-progress.ts'
export {
  KNOWN_RETRIEVE_RETIRE_LIMIT,
  decideKnownRetrieve,
  filterKnownResources,
  formatKnownResourceRetired,
  knownRetrieveMadeProgress,
  shouldClearActiveRetrieval,
  shouldRetireKnownRetrieve,
} from './retrieval-progress.ts'
import * as stall from './stall-observers.ts'
import * as modelrecovery from './model-recovery.ts'
import type { ModelRecoveryHost } from './model-recovery.ts'
import * as system2plane from './system2-plane.ts'
import * as queueplane from './goal-queue-plane.ts'
import type { AbandonVerdict, GoalQueuePlaneHost } from './goal-queue-plane.ts'
export { evaluateSurfaceRecovery, orphanedSmeltPrerequisiteReason, staleOreDescend } from './goal-queue-plane.ts'
import type { System2PlaneHost } from './system2-plane.ts'
import * as goalstate from './goal-state.ts'
import type { GoalStateHost } from './goal-state.ts'
import * as abandonlifecycle from './abandon-lifecycle.ts'
import type { AbandonLifecycleHost } from './abandon-lifecycle.ts'
export { canAuthoritativelyAbandonOption } from './abandon-lifecycle.ts'
export { betaAbandonProgressObserved } from './abandon-lifecycle.ts'
export { questionSetForTrigger } from './decision-epochs.ts'
export {
  MIRRORED_MARKERS,
  MAX_STARVATION_MISSING,
  mirroredEventToken,
  formatCandidateStarvation,
  candidateStarvationLine,
  candidateStarvationMissing,
  withheldToolGaps,
  goalStarvationBlockedBy,
  ensureCraftStepActionable,
  goalPreconditionCause,
} from './candidate-diagnostics.ts'
export { resolveBootstrapPlanOp } from './system2-plane.ts'
import type { StallObserverHost } from './stall-observers.ts'
import type { WedgeSuppressReason } from './wedge.ts'
export {
  evaluateWaitWedge,
  evaluateWedgeRepeat,
  formatWedgeAbort,
  formatWedgeSuppressed,
} from './wedge.ts'
import * as outcome from './outcome-accounting.ts'
import type { OutcomeAccountingHost } from './outcome-accounting.ts'
export {
  classifyMoveOutcome,
  decideRetrieveMemory,
  formatStationRegisteredPlaced,
  moveFailureReason,
  PLACED_STATION_ITEMS,
  registerPlacedStation,
} from './outcome-accounting.ts'
export type { MoveOutcome } from './outcome-accounting.ts'
import * as ledgers from './outcome-ledgers.ts'
import type { OutcomeLedgersHost } from './outcome-ledgers.ts'
export { controllerUnreachableMoveReason } from './outcome-ledgers.ts'
import * as epochs from './decision-epochs.ts'
import type { DecisionEpochsHost } from './decision-epochs.ts'
export { CRITICAL_TRIGGERS, guardMoveFailureReason } from './decision-epochs.ts'
export type {
  WaitWedgeDecision,
  WaitWedgeInput,
  WedgeRepeatDecision,
  WedgeRepeatInput,
  WedgeSuppressReason,
} from './wedge.ts'
export type {
  KnownRetrieveDecision,
  KnownRetrieveDecisionInput,
  KnownRetrieveRetireInput,
} from './retrieval-progress.ts'
import type { KnownResourceVerdictLatch } from './candidate-diagnostics.ts'
export {
  formatKnownResourceFalsified,
  formatKnownResourceResighted,
  nextKnownResourceVerdict,
} from './candidate-diagnostics.ts'
export type { KnownResourceVerdict, KnownResourceVerdictLatch } from './candidate-diagnostics.ts'
import * as reach from './reach/controller-plane.ts'
import type { ActiveReachTransition, ReachPlaneHost, ReachTerminalActionCorrelation } from './reach/controller-plane.ts'
import { ActionFailureEscalation, BetaAbandonDeferral, evaluateCapabilityGap, ReplanThrottle, resolveActionFailureEscalateCycles, resolveBetaAbandonDeferCycles, resolveReplanNoInfoEscalateCycles, resolveReplanPositionDelta, resolveReplanThrottleMs, resolveWaitStreakEscalateCycles, WaitStreakEscalation } from './replanThrottle.ts'
import type { CapabilityGapState, ReplanInputs } from './replanThrottle.ts'
import { detectOscillation, isInDeathZone, MoveFailMemory, StateFingerprintMemory } from './moveFailMemory.ts'
import type { BlacklistedMoveTargets, MoveFailurePathScope, MoveFailureReason } from './moveFailMemory.ts'
// The durable cross-action bound on one action's own typed outcome repeating
// identically at the same target. The module owns the ONE bound; the controller
// only observes and prunes.
import { RepeatedOutcomeEscalation, resolveRepeatedOutcomeLimit } from './repeatedOutcomeEscalation.ts'
import type { DescendProgressState } from './descendPlan.ts'
import { DigMemory } from './worldMemory.ts'
import type { ContainerRefusal } from './containerAccess.ts'
import type { PredicateEvaluation } from './predicateGoal.ts'
import { PLACE_RETRIES_EXHAUSTED, PlaceRetryLedger } from './placementGuard.ts'
import type { AbandonReason } from './placementGuard.ts'
import type { OscillationState } from './oscillation.ts'
import { NO_LOCOMOTION_OBSERVATION } from './locomotion.ts'
import type { LocomotionObservation } from './locomotion.ts'
import type { BetaAuthorityDecision } from './betaAuthority.ts'
import { formatActionUnverified, hasObservableProgress, truthfulActionOutcome, UNVERIFIED_ACTION_LIMIT } from './actionPostcondition.ts'
import type { ActionOutcomeTaxonomy, TruthfulOutcome } from './actionPostcondition.ts'
import type { ZeroProgressRoutes } from './zeroProgressRoute.ts'
import { isBridgeMove } from './bridgeRoute.ts'
import type { DigRouteRefusal } from './digRoute.ts'
import { StubSystem2 } from './system2/service.ts'
import type { LlmSummonReason, System2BlockerFacts, System2Brain, System2GroundedAlternative, System2Objective, System2Outcome, System2SemanticOutcome, System2ToolGap, System2WithheldCandidate } from './system2/service.ts'
import { buildSystem2BlockerFacts, SYSTEM2_PAYLOAD_ABSENT } from './system2/payload.ts'
import type { System2RequestContext } from './system2/authority.ts'
import { evaluateCandidateStarvationBoundary } from './system2/escalation.ts'
import type { BetaTerminationBoundaryDecision } from './system2/escalation.ts'
import { isNotableLocalOscillation, localOscillationPersistKey, restoreLocalOscillationRecord } from './localOscillation.ts'
import type { LocalOscillationRecordJson } from './localOscillation.ts'
import { resolveStrategicStallHorizon, resolveStrategicStallMaxDistinctStates, resolveStrategicStallMinBodyProgress, StrategicStallTracker } from './strategicStall.ts'
import { CriticalDamageTracker, resolveCriticalDamageLimit } from './criticalDamage.ts'
import { computeShadowMetrics } from './shadowMetrics.ts'

/** Mission shape consumed by the VTR-owned reach slice. */
export type VtrInventoryMission = InventoryReachMission

export type { JevAgentOptions } from './controller-shared.ts'

/**
 * Option fields production may default. The V4.1.2 kernel gate has no safe
 * default — it is a construction requirement on `JevController`, so the
 * defaults literal is typed to exclude it.
 */
export type JevAgentOptionDefaults = Omit<JevAgentOptions, 'kernelAuthority'>

export const defaultJevAgentOptions: JevAgentOptionDefaults = {
  goalItem: 'oak_log',
  goalCount: 1,
  vtrMission: null,
  vtrReachProbe: false,
  heartbeatMs: 3000,
  enabledTriggers: DECISION_TRIGGERS,
  schedulerCoalesceMs: 40,
  minDecisionIntervalMs: 150,
  minJevIntervalMs: 150,
  lowConfidenceThreshold: 0.55,
  stallMs: 25000,
  wedgeRepeatLimit: 5,
  waitLimit: 3,
  wedgeStallMs: 60000,
  failureStreakLimit: 3,
  candidateFailureLimit: 2,
  escalationCooldownMs: 5000,
  escalationWindowMs: 4000,
  llmCooldownMs: 3000,
  finishOnObjectiveComplete: true,
  singleShotPlanner: false,
  maxRuntimeMs: 180000,
  ledgerPath: null,
  stopAfterSubgoals: 0,
  jevTimeoutMs: 8000,
  jevMaxRetries: 3,
  jevRateLimitRetries: 4,
  jevRateLimitBaseDelayMs: 7000,
  logDir: 'logs',
  forceFallbackPolicy: false,
  unproductiveAttemptLimit: resolveUnproductiveAttemptLimit(),
  abandonCooldownMs: resolveAbandonCooldownMs(),
  verbose: true,
  scanRadius: 48,
  reach: 4.5,
  maxCandidateAgeTicks: 10,
  pathTimeoutMs: 15000,
  digTimeoutMs: 15000,
  actuation: 'pathfinder',
  replanThrottleMs: resolveReplanThrottleMs(),
  replanPositionDelta: resolveReplanPositionDelta(),
  replanNoInfoEscalateCycles: resolveReplanNoInfoEscalateCycles(),
  actionFailureEscalateCycles: resolveActionFailureEscalateCycles(),
  waitStreakEscalateCycles: resolveWaitStreakEscalateCycles(),
  repeatedOutcomeLimit: resolveRepeatedOutcomeLimit(),
  betaAbandonDeferCycles: resolveBetaAbandonDeferCycles(),
  serverId: 'local',
  worldEpoch: 0,
  decisionProvenance: { runId: null, generationId: null, sourceSha: null },
}

export interface RunSummary {
  ticks: number
  jevCalls: number
  guardRejections: number
  conflictDeferrals: number
  escalations: EscalationReason[]
  triggerCounts: Record<string, number>
  verifiedDigs: number
  blocksRemoved: number
  dropObservations: number
  itemsCollected: number
  goalItemCount: number
  /** live inventory count of the goal item at shutdown */
  goalItemInInventory: number
  goalComplete: boolean
  policyKind: JevPolicy['kind']
  policyModel: string
  maxConcurrentActions: number
  /** number of times System 2 (the LLM) was summoned */
  llmSummons: number
  llmSummonReasons: LlmSummonReason[]
  /** LLM invocations made by exception-driven summons during the run (M1 gate: 0) */
  llmRuntimeCalls: number
  /** LLM (planner stub) invocations made to bootstrap the plan (M1 gate: 1) */
  llmPlanCalls: number
  /** decisions where Jev's need_llm was adopted */
  needLlmDecisions: number
  goalQueueDepth: number
  goalQueueCurrent: string | null
  /** subgoals in the bootstrapped plan; 0 when the queue was never seeded */
  subgoalCount: number
  subgoalsDone: number
  durationMs: number
  stopped: 'goal-complete' | 'max-runtime' | 'stopped-by-caller' | 'disconnected' | 'wedge'
  success: boolean
}

export { TRIGGER_PRIORITY }

/** Pick the CORE + trigger-specific question set (P1-7). */

function emptySignals(): AgentSignals {
  return {
    consecutiveFailures: 0,
    lastFailureCode: null,
    lastPathStatus: 'idle',
    stalledMs: 0,
    lastPolicyConfidence: null,
    maxConcurrentActions: 0,
    escalationRecommended: false,
    failedCandidates: {},
    digDir: null,
    digMode: null,
    digDirCount: 0,
    digDepth: 0,
    digOscillate: false,
    knownStoneY: null,
    lastTunnel: null,
    descendNoProgress: 0,
    descendLimitReached: false,
    knownResources: [],
    strategicNonProgress: null,
    oscillationsDetected: 0,
    lastDamage: null,
  }
}

/** Mineflayer's own block-interaction cap: `canDigBlock` refuses beyond ~5.1 blocks. */
export const MAX_BLOCK_REACH = 5
/** A repeated WAIT becomes a bounded replan first (never an immediate wedge). */
/**
 * A `surface` goal whose ascent plan is refused AND whose tick offers no
 * body-changing route at all is marked `impossible` after this many consecutive
 * candidate generations under the same refusal signature. Bounded so a
 * transient blocked column never abandons a satisfiable Option.
 */
/** Issue #45: an active RETRIEVE that stops closing distance for this many ticks escalates. */
/** Issue #41: a descend goal with no vertical progress for this many ticks escalates. */
/** Issue #41: a descend goal with no executable descend candidate this long escalates. */
/** Distance decrease (m) that counts as real retrieval progress. */
/** Issue #8: do not re-log the same oscillating pair more often than this. */
/**
 * #oscillation-boundary: the size of the body's cell envelope and the bounded
 * return count that proves the local recovery is exhausted. Reasoning lives on
 * the constants in `localOscillation.ts`; they are read once here like the
 * `MOVE_FAILMEM_*` pair above.
 */

/**
 * Zero-progress known-resource retrieves before the resource is retired.
 * Bounded like UNVERIFIED_ACTION_LIMIT: the retrieve already proved it closed no
 * distance, gained no altitude and dug no step.
 */

/**
 * A remembered resource can be PRESENT yet unreachable (a y=68 log from y=59
 * with `canDig=false`), so the durable staleness proof never retires it - that
 * proof only drops ABSENT/replaced cells. The retrieval-stall timer is keyed on
 * the candidate id, which carries the resource coordinate, so every time the
 * nearest known resource changes the timer resets and the plan loops through the
 * same unreachable list. Retire the resource after a bounded number of
 * zero-progress retrieves so the generator moves to the next resource / branch.
 */

/**
 * Live iron-ore loop (run-mu8a7phm-rfm0): the executor reports
 * `verified=true status=done` for a sub-metre reuse-tunnel nudge -
 * `RETRIEVE:known:raw_iron:b25_49_37` arrived `12.63m->11.63m ... y=59.89->59.64`
 * 28 times, always `progressDelta=0`. Trusting `verified` alone cleared
 * `knownRetrieveFailures` on every attempt, so the present-but-unreachable ore was
 * never dropped from `signals.knownResources` and the generator kept re-offering
 * its RETRIEVE. The deterministic policy ranks RETRIEVE above DESCEND, so the
 * descend goal never got a body change (`DESCEND_STALLED ... hasDescendCandidate=false`).
 *
 * A known-resource retrieve only counts as progress when the controller can
 * OBSERVE a change - an item gained, a staircase block removed, or a verified
 * body change - never on the executor's lenient `verified` flag. The controller
 * already uses the exact same criterion for the move-failure memory; the
 * retirement counter must agree with it.
 */

/**
 * Pure decision the controller applies to every finished known-resource
 * retrieve. A COMPLETED retrieve clears the per-resource counter; anything else
 * charges it and retires the resource at the bounded limit.
 *
 * The boundary is completion (`completed`), not lenient observable progress:
 * the RC8 loop closed ~1 m of a 20 m approach and reported a vertical body
 * change, so `knownRetrieveMadeProgress(result.progressed === true)` cleared the
 * counter every attempt and the same unreachable station was re-offered forever.
 * `completed` is supplied by `retrieveCompleted` (arrival or acquisition); the
 * `knownRetrieveMadeProgress` fallback keeps the direct pure callers' contract.
 */

/**
 * May a finished RETRIEVE clear the controller's active-retrieval stall track?
 *
 * A known remembered resource that reported a body change but did NOT arrive
 * must keep the track alive: the existing distance/altitude stall assertion
 * (`observeRetrievalStall`, RETRIEVAL_STALL_TICKS) is the only thing that
 * retires a horizontal dead end once `hasObservableProgress` is true from a
 * vertical chunk. Clearing on that chunk re-armed the live
 * `RETRIEVE:known:raw_iron` loop: `PATH_CALLBACK ... outcome=stuck` followed by
 * `verified=true status=done` and `MOVE_FAILMEM_RESET`, forever. Surface
 * waypoints are a separate search frontier and never own an active resource
 * stall track, so they must not clear this memory.
 */

/** Drop resources the controller has proven unreachable for the current plan. */

/**
 * `KNOWN_RESOURCE_FALSIFIED item=<item> name=<name> cell=<x,y,z> reason=<reason>`.
 *
 * A remembered cell the loaded world PROVED wrong: `block_mined` (the block is
 * gone/replaced), `mob_gone` (the landmark stands but no producer is inside the
 * entity envelope) or `drop_absent` (the cell was remembered as the item itself
 * and nothing holds it). Typed truth, never a preference.
 */

/** `KNOWN_RESOURCE_RESIGHTED item=<item> name=<name> cell=<x,y,z> source=mob|drop`. */

/**
 * `KNOWN_RESOURCE_RETIRED item=<item> cell=<x,y,z> attempts=<n>`.
 *
 * The bounded-retire boundary (`decideKnownRetrieve`) dropped a remembered cell
 * as unreachable after `attempts` zero-progress retrieves. The cell was PRESENT
 * but this body could not close it: retirement is per-cell and unrelated to the
 * falsification reasons above (a merely unreachable resource is not disproved).
 */

/** Dedupe state for remembered-cell verdict lines (one per generation). */

/**
 * The report rule for one remembered-cell verdict, mutating the dedupe latch.
 *
 *   - `falsified` is reported once per (item, name, cell, reason);
 *   - a cell the world verifies again RE-ARMS that report, so a second
 *     contradiction of the same cell is reported - and durably evicted - again
 *     instead of being swallowed by the once-per-cell latch;
 *   - only a producer/drop re-sight that actually followed a withhold gets its
 *     own line: a block being present is the ordinary case and would spam.
 *
 * Pure apart from the latch. No goal, action or ranking is involved.
 */

function normalizeOptions(options: JevAgentOptions): JevAgentOptions {
  return {
    ...options,
    // Copy the host-issued tuple at each controller configuration boundary. The
    // model result and candidate objects are never consulted for this identity.
    decisionProvenance: Object.freeze({ ...options.decisionProvenance }),
    reach: Math.min(options.reach, MAX_BLOCK_REACH),
  }
}

/** #11 v2 §7: a repeat is only a wedge when the world stands still under it. */

/**
 * #11 v2 §7: termination is an event-boundary semantic decision, never a raw tick
 * counter. A repeat only extends the wedge window when ALL THREE facts hold:
 *   (a) the same chosen candidate id,
 *   (b) an unchanged semantic state fingerprint (no motion, no inventory/world/goal
 *       change - tick/clock excluded), and
 *   (c) no action currently in flight.
 * Any other tick is `suppress` and resets the window, so a slow exploration/ascent/
 * travel route can never be aborted by wall-clock ticks. A genuinely frozen no-op
 * (same id, same fingerprint, no flight) still counts and aborts at the limit.
 */

/** Kept byte-identical to the pre-fix genuine-wedge abort message. */

export type { EscalationReason } from './escalation.ts'
export type { PendingDecision } from './decision-epochs.ts'

/** #79: the controller's actual abandon decision for one Jev result. */

/**
 * Return the canonical host-event name for a marker-prefixed log message.
 * `PORTAL_VERIFIED=true` is a value-bearing marker in the human-readable line,
 * but the host recorder owns the boolean in `detail.verified` and must receive
 * the stable semantic event name `PORTAL_VERIFIED`.
 */
/** Tees marker-prefixed agent log lines to an external sink (the resident log)
 * while still writing the full run JSONL. Lets the acceptance harness observe the
 * executor's movement markers without an executor change. */
class MirroringEventLogger extends EventLogger {
  private readonly sink: (event: string, detail: Record<string, unknown>) => void

  constructor(writer: JsonlWriter | null, echo: boolean, sink: (event: string, detail: Record<string, unknown>) => void) {
    super(writer, echo)
    this.sink = sink
  }

  override log(
    source: string,
    level: AgentLevel,
    message: string,
    detail: Record<string, unknown> = {},
    tick: number | null = null,
  ): void {
    super.log(source, level, message, detail, tick)
    const token = mirroredEventToken(message)
    if (token !== null) this.sink(token, detail)
  }
}

/**
 * Local failure/path signals that remain bounded policy evidence for the
 * decision policy instead of escalating to sparse System2 repair. Structural
 * reasons (goal complete, genuinely empty frontier, death/world corruption,
 * policy error) still reach the escalation path.
 */
const LOCAL_POLICY_ESCALATIONS = new Set([
  'low_confidence',
  'same_failure_3x',
  'pathfinder_no_path',
  'pathfinder_stuck',
  'progress_stall',
])

export class JevController {
  private readonly bot: Bot
  /** Temporary Mineflayer edge for the VTR Reach slice; semantic code receives typed results only. */
  private reachRuntimeAdapter!: ReachRuntimePorts
  private options: JevAgentOptions

  private runWriter: JsonlWriter
  private jevWriter: JsonlWriter
  private decisionWriter: JsonlWriter
  private system2Writer: JsonlWriter
  private logger: EventLogger
  private jev: JevPolicy
  private executor: Executor
  /**
   * Kernel transition ownership for controller dispatch. Reads the current
   * executor/options lazily so a setOptions rebuild never strands it on a
   * replaced executor or authority.
   */
  private readonly transitions: ControllerTransitions = ((controller: JevController) => new ControllerTransitions({
    get authority() { return controller.options.kernelAuthority },
    executor: {
      get current() { return controller.executor.current },
      cancelCurrent: (reason: string) => controller.executor.cancelCurrent(reason),
    },
    world: () => ({ serverId: controller.options.serverId, worldEpoch: controller.options.worldEpoch }),
    log: (level, message, detail) => controller.logger[level]('policy', message, detail ?? {}, controller.tickCounter),
  }))(this)
  private scheduler: DecisionScheduler
  private system2: System2Brain
  private queue: GoalQueue
  private recipeIndex: RecipeIndex
  /** Backend-independent Reach cells shared with the composition through typed ports only. */
  private readonly reachVtrCells = {
    cachedWorldState: { value: null as WorldState | null },
    lastRouteDecision: { value: null as JevReachRouteDecisionRecord | null },
    counters: {
      jevCalls: { value: 0 },
      lastJevAt: { value: 0 },
      tickCounter: { value: 0 },
    },
  }
  private reachRuntime!: ReachMissionRuntime
  private get reachRouteDecisionWorld(): WorldState | null {
    return this.reachVtrCells.cachedWorldState.value
  }
  private set reachRouteDecisionWorld(state: WorldState | null) {
    this.reachVtrCells.cachedWorldState.value = state
  }
  private get lastVtrReachRouteDecision(): JevReachRouteDecisionRecord | null {
    return this.reachVtrCells.lastRouteDecision.value
  }
  private set lastVtrReachRouteDecision(decision: JevReachRouteDecisionRecord | null) {
    this.reachVtrCells.lastRouteDecision.value = decision
  }
  /** Correlates a per-step terminal with the executor result that settles that same lease. */
  private pendingReachTerminalAction: ReachTerminalActionCorrelation | null = null
  private lastReachActionFailure: string | null = null

  private goal: GoalState
  private signals: AgentSignals = emptySignals()
  private recentEvents: string[] = []
  private recentOutcomes: System2Outcome[] = []
  private recentSemanticOutcomes: System2SemanticOutcome[] = []

  private get tickCounter(): number { return this.reachVtrCells.counters.tickCounter.value }
  private set tickCounter(value: number) { this.reachVtrCells.counters.tickCounter.value = value }
  private get jevCalls(): number { return this.reachVtrCells.counters.jevCalls.value }
  private set jevCalls(value: number) { this.reachVtrCells.counters.jevCalls.value = value }
  private guardRejections = 0
  /**
   * Chosen SURVIVAL actions re-grounded from the fresh offer after their
   * volatile id changed between the Jev answer and execution (see
   * `regroundVanishedSurvivalChoice`). Counted separately from
   * `guardRejections` so the mirrored roll-up tells a repaired identity apart
   * from a dropped decision.
   */
  private survivalRegrounds = 0
  /** Doubling milestone of `guardRejections + survivalRegrounds` last mirrored. */
  private lastGuardRollupAt = 0
  private conflictDeferrals = 0
  private escalations: EscalationReason[] = []
  private triggerCounts: Record<string, number> = {}
  private verifiedDigs = 0
  private blocksRemoved = 0
  private dropObservations = 0
  private itemsCollected = 0
  private harvestedGoalCount = 0
  private failureStreak = 0
  private candidateFailures = new Map<string, number>()
  private candidateFailureAt = new Map<string, number>()
  private digMemoryState = new DigMemory()
  private digOscillationReported = false
  private descendHaveBaseline = 0
  private descendProgress: DescendProgressState | null = null
  private descendStallTicks = 0
  private descendProgressTicks = 0
  private descendGoalKey: string | null = null
  private actionStart: Vec3Json | null = null
  private positionWindow: Vec3Json[] = []
  private lastEscalationAt = new Map<EscalationReason, number>()
  private lastEscalationMs = 0

  private llmInFlight = false
  private llmSummons = 0
  private llmSummonReasons: LlmSummonReason[] = []
  private lastLlmSummonAt = new Map<LlmSummonReason, number>()
  private llmNotes: string[] = []
  private needLlmDecisions = 0
  private tickResummonLog: DecisionLlmResummonLog[] = []

  private policyEpoch = 0
  private issuedPolicyEpoch = 0
  private issuedCandidateHash = ''
  /**
   * Issue #437 §3: causal isolation for policy. Only the ACTIVE epoch may
   * authorize a commitment; a late async model result from an older epoch is
   * dropped (`STALE_JEV_RESULT_DROPPED`). Analogous to generation/lease
   * isolation for actuation.
   */
  private readonly decisionEpochs = new JevDecisionEpochs()
  /** Issue #437 §5/§9: the exact semantic projection Jev last saw. */
  private lastSemanticProjection: JevSemanticProjection | null = null
  private lastProjectionHash = ''
  /** Issue #437 §2/§7: bounded previous semantic outcomes (never raw telemetry). */
  private recentSkillOutcomes: SkillOutcomePacket[] = []
  private lastSkillOutcome: SkillOutcomePacket | null = null
  /** Issue #437 §6: the last packet ended at a policy boundary, so pi re-enters. */
  private skillOutcomeBoundary = false
  /** Issue #437 §3: a late/unauthorized model result was dropped this tick. */
  private staleDecisionDropped = false
  /**
   * Issue #437 §3: which decision epoch authorized each executor action lease,
   * so a settled action's packet names the epoch/commitment it closes.
   */
  private readonly actionEpochByLease = new Map<number, { epoch: number; commitmentId: string; identity: string }>()
  /** Issue #437 §5/§9 evidence: raw mechanical observations compressed since the
   *  last semantic outcome. Never model input; only the packet's count. */
  private compressedSkillSteps = 0
  private criticalStateVersion = 0

  private planCalls = 0
  private runtimeLlmCalls = 0
  private tickLlmCalls = 0
  private planSupplied = false
  private subgoalCount = 0
  private pendingTransition: DecisionSubgoalLog | null = null

  private lastDecision: JevResult | null = null
  private get lastJevAt(): number { return this.reachVtrCells.counters.lastJevAt.value }
  private set lastJevAt(value: number) { this.reachVtrCells.counters.lastJevAt.value = value }
  private lastDecisionId: string | null = null
  /** whether the last beta abandon vote actually led to a replan (#46 guard). */
  private lastAbandonAdopted = false
  /** #79: per-option unproductive-attempt counter (reset on verified progress). */
  private readonly optionAttempts = new OptionAttemptTracker()
  private lastCandidates: readonly Candidate[] = []
  private lastCandidateSignature = ''
  private lastLogRouteSignature = ''
  /** Dedupe key for FOOD_LOW/EAT_REFUSED/FOOD_ROUTE so a stable food state is one auditable line. */
  private lastFoodMarkerSignature = ''
  /** Live hunger bar at the previous decision tick, for FOOD_EATEN; null until the first tick. */
  private lastFoodLevel: number | null = null

  /** Food-item counts at the previous decision tick, for FOOD_ACQUIRED; null until the first tick. */
  private lastFoodCounts: Map<string, number> | null = null
  private lastProgress = 0
  private lastProgressAt = Date.now()

  private chosenCountsAtProgress = -1
  private noProductiveRepeats = 0
  private noProductiveKey: string | null = null
  private noProductiveThisTick = false
  /**
   * DURABLE NEGATIVE CONSTRAINT: typed blockers that already exhausted their
   * bounded local-recovery window at a locality. Keyed `reason|roundedCell`,
   * valued with the goal keys it defeated and how many bounded windows it
   * survived. Causal history, not a choice: the ledger only names proven CAN
   * refusals back to System2 so an identical re-plan is informed, never
   * silently replaced (portal-p14/p16/p17 `column_descent:no_safe_step` loops).
   */
  private readonly blockedAffordanceLedger = new Map<string, { reason: string; cell: string; goals: Set<string>; count: number; lastTick: number }>()
  /** Bounded evidence: distinct reason+locality refusals retained for the constraint channel. */
  private static readonly BLOCKED_AFFORDANCE_LEDGER_LIMIT = 16

  /**
   * The ledger as read-only causal facts for the semantic projection and the
   * System2 blocker channel. Entries near the body's current locality are the
   * negative constraints a re-plan must route around; far entries are kept in
   * case work returns there but are not asserted as live blockers.
   */
  private repeatedBlockerFacts(): readonly { reason: string; goals: readonly string[]; count: number }[] {
    const out: { reason: string; goals: readonly string[]; count: number }[] = []
    for (const entry of this.blockedAffordanceLedger.values()) {
      out.push({ reason: entry.reason, goals: [...entry.goals], count: entry.count })
    }
    return out
  }
  /**
   * #plan-reconciliation: dedupe for the ROW_NOT_EXECUTABLE_HERE line. The
   * measured run emitted it 227 times for one unchanged fact; the repeat count
   * rides the next emitted line instead.
   */
  private notExecutableKey: string | null = null
  private notExecutableRepeats = 0
  /**
   * #plan-reconciliation: the head row the IN-FLIGHT System2 request was asked
   * about, and why. When the answer carries a real plan for that same head, the
   * row is replaced on the strength of the answer (see
   * `GoalQueue.replaceAnsweredHead`) - otherwise `patch` keeps the very row the
   * question was about and the escalation cannot close its own loop.
   *
   * Only a summon whose reason is about the head being unable to proceed arms
   * this; every other request leaves the conservative rule untouched.
   */
  private headAnswerWarrant: HeadAnswerWarrant | null = null
  /**
   * #plan-reconciliation: the queue's proven "this head cannot execute in the live
   * dimension" fact, remembered from `reconcileHeadDimension` so the OFFER can be
   * bound to it in the same tick. Null whenever the head can run here.
   */
  private notExecutableHereBinding: NotExecutableHereBinding | null = null
  /** one interrupt per offending in-flight action, so the cancel cannot loop. */
  private notExecutableInterruptedActionId: string | null = null
  /** Latest grounded blocker context, forwarded to System 2 on exception-driven replans. */
  private starvationContext: { blockedBy: string; missing: string[] } | null = null
  /**
   * The latest tick's REFUSED grounded candidates as typed facts. Set from the
   * same `generateGroundedCandidates` result that owns `withheldCandidateIds`,
   * so the payload can never carry a stale refusal: a tick that withholds
   * nothing overwrites this with `[]`.
   *
   * These are the facts a System2 WHAT decision depends on (which grounded
   * action is impossible, its typed reason, the capability keys that are
   * missing, and the tool truth behind a named tool requirement). The controller
   * only MEASURES them here; selecting a replacement WHAT stays with the model.
   */
  private withheldCandidateFacts: System2WithheldCandidate[] = []
  /** The same tick's OFFERED grounded candidates (what the body can still do). */
  private presentedCandidateFacts: System2GroundedAlternative[] = []
  /** Typed tool gaps behind the withheld capabilities; empty when none named a tool. */
  private withheldToolGaps: System2ToolGap[] = []
  /**
   * The observed-state fingerprint the three fields above were measured in.
   * A summon is reachable from paths that do not re-run the affordance gate, so
   * the facts are attached only while this still equals the live fingerprint;
   * otherwise the payload says `SYSTEM2_PAYLOAD_ABSENT field=withheld_stale`
   * instead of asserting a refusal the body may have already escaped.
   */
  private withheldFactsFingerprint = ''
  private readonly replanThrottle: ReplanThrottle
  /**
   * Issue #78 follow-up: bounded counter for the SAME typed action failure being
   * re-offered for the same plan. Separate instance and separate streak from
   * `replanThrottle`'s #44/#78 no-progress counter by construction.
   */
  private readonly actionFailureEscalation: ActionFailureEscalation
  /** #327 follow-up: bounded chosen-WAIT streak while real actions exist. */
  private readonly waitStreakEscalation: WaitStreakEscalation
  /**
   * Bounded control-action abandon deferral (d428d1c/m3-live): `WAIT` must not
   * be able to suppress its own beta abandon indefinitely. See
   * `BetaAbandonDeferral` for the reset conditions and the authority boundary.
   */
  private readonly betaAbandonDeferral: BetaAbandonDeferral
  /** Plan revision the current `betaTerminationBoundary` decision belongs to. */
  private betaAbandonPlanId: string | null = null
  /**
   * Set for exactly one decision after an actionable WAIT streak is exhausted,
   * so WAIT is removed from the offered set and the policy must choose a real
   * candidate. Cleared at the next candidate build; never a standing filter.
   */
  private waitSuppressed = false
  private readonly loggedStaleResources = new Set<string>()
  private retrievalTrack: { id: string; best: number; ticks: number; bestGap?: number } | null = null
  private activeRetrieval: { id: string; resource: string; knownName: string; target: Vec3Json } | null = null
  /** Surface waypoints reached without finding the requested resource. */
  /** Explicit body-motion observation; idle and unobserved are never "100% efficient". */
  private lastLocomotionObservation: LocomotionObservation = NO_LOCOMOTION_OBSERVATION
  /**
   * #405: bounded LRU of cells the body has recently occupied, exposed to the
   * candidate layer as `signals.exploredCells` so the exploration fallback keeps
   * offering NEW terrain instead of re-offering a cell the body already reached.
   */
  private readonly exploredCells = new Set<string>()
  private readonly searchedSurfaceTargets = new Set<string>()
  private retrievalEscalationPending = false
  private readonly unreachableResources = new Set<string>()
  /** Report latch for `KNOWN_RESOURCE_FALSIFIED`/`KNOWN_RESOURCE_RESIGHTED` lines. */
  private readonly knownResourceVerdicts: KnownResourceVerdictLatch = {
    falsified: new Set<string>(),
    resighted: new Set<string>(),
  }
  /**
   * Consecutive zero-progress retrieves per remembered resource (`name@x,y,z`).
   * Retires a present-but-unreachable resource after KNOWN_RETRIEVE_RETIRE_LIMIT.
   */
  private readonly knownRetrieveFailures = new Map<string, number>()
  /** M2 ascent trap: bounded-window tracker owned by evaluateCapabilityGap. */
  private capabilityGapState: CapabilityGapState | null = null
  private capabilityGapActive = false
  private capabilityGapSignature: string | null = null
  private ascendRefusedSinceObservation = false
  /**
   * Previous tick's sensor state, used only to re-derive the pure vertical plan
   * for the capability target. `observeCapabilityGap` runs before this tick's
   * sensor build, so the plan fact is one tick old; the tick guard rejects a
   * stale/disconnected snapshot.
   */
  private lastWorldState: WorldState | null = null
  private lastWorldStateTick = -1
  /** last logged `ASCENT_REFUSED` line, so one dead end is one line. */
  private lastAscentRefusalKey: string | null = null
  /** last logged candidate-layer `SURFACE_ASCENT_REFUSED` line (one per signature). */
  private lastSurfaceAscentRefusalKey: string | null = null
  /**
   * Latest candidate-layer ascent refusal for the active `surface` goal, plus
   * whether the tick offered NO body-changing route at all (pure
   * `surfaceAscentRouteless`). Read by the queue-sync surface branch: a refusal
   * with no route, seen for several consecutive candidate generations under the
   * same goal, is the deterministic "this Option cannot progress from this
   * state" fact, so it becomes `impossible` instead of pacing.
   */
  private lastSurfaceAscentRefusal: SurfaceAscentRefusal | null = null
  private lastSurfaceAscentRouteless = false
  /** consecutive candidate generations that reported the same refusal signature. */
  private surfaceAscentRefusalStreak = 0
  private surfaceAscentRefusalStreakKey: string | null = null
  /** last logged candidate-layer `COLUMN_DIG` base (one line per distinct base). */
  private lastColumnDigKey: string | null = null
  private lastSurfaceGoalId: string | null = null
  private fuelSatisfiedKey: string | null = null
  private readonly loggedUnreachableMoves = new Set<string>()
  /** retirement evidence dedup: one `ACTION_TARGET_RETIRED` line per retirement, not per tick */
  private readonly loggedRetiredRepeats = new Set<string>()
  private readonly stationApproachLogged = new Set<string>()
  /** #8: exact coordinate failure memory (count, cooldown, dimension). */
  private moveFailMemory: MoveFailMemory
  /** Prevent a persisted worldRevision counter from aliasing this resident's path facts. */
  private readonly movePathFailureGenerationId = randomUUID()
  /**
   * #oscillation-boundary: the DURABLE local-motion record. It is seeded from
   * class-A world memory at construction and written back through
   * `onLocalOscillationChange`, so unlike every other stall counter in this class
   * it is not erased by a generation change. Deliberately keyed on the body's
   * cell envelope only: no queue identity, no position churn, no wall clock.
   */
  private localOscillation: LocalOscillationRecordJson | null
  /** inventory digest at the previous settled decision (the "no inventory delta" fact) */
  private localOscillationInventory = ''
  /** serialized form of the last record handed to the HOST, so unchanged records are not re-proposed */
  private localOscillationPersisted = ''
  /**
   * The DURABLE cross-action escalation ledger: one entry per
   * `(action shape, target cell)`, advanced only while the typed outcome AND the
   * target's affordance fact signature are byte-identical. Seeded from class-A
   * world memory at construction and written back through
   * `onRepeatedOutcomeChange`, so a hot reload cannot launder a repeat the way it
   * laundered the controller-scoped `ActionFailureEscalation` counter.
   */
  private repeatedOutcomes: RepeatedOutcomeEscalation
  /** serialized form of the last ledger handed to the HOST, so unchanged ledgers are not re-proposed */
  private repeatedOutcomesPersisted = ''
  /**
   * The affordance fact signature of every candidate the gate evaluated THIS
   * tick, keyed by candidate id (`reachability.ts#reachabilityTargetSignature` -
   * the target's own grounding facts, WITHOUT the body-relative vertical gap).
   *
   * The affordance plane computes this for every grounded candidate on every
   * tick, and for a candidate that PASSES the gate it was discarded: only the
   * withheld side's fingerprint ever had a consumer. It is exactly the fact the
   * cross-action bound needs - "the target's grounding facts did not change" -
   * and it deliberately excludes wall clock and fine body position.
   */
  private groundingFingerprints = new Map<string, string>()
  /**
   * Zero-observable-change route memory: (kind, target cell, stand cell, route
   * signature) -> attempts. The postcondition layer owns the verdict; this owns
   * only what happens NEXT - a repeat of the same action with unchanged
   * preconditions is never re-issued, and a bounded number of distinct
   * zero-progress routes at one stand cell exhausts that family there.
   */
  private zeroProgressRoutes: ZeroProgressRoutes = {}
  /** #11 v2 §6: reachability proved a target unreachable under a state fingerprint. */
  private readonly reachabilityProofs = new StateFingerprintMemory({ maxEntries: ledgers.MOVE_FAILMEM_MAX_ENTRIES })
  /** candidates the affordance gate withheld in the latest generation. */
  private withheldCandidateIds: ReadonlySet<string> = new Set<string>()
  /** gate facts (station/dig approach probes) resolved once per tick. */
  private gateOptions: ReachabilityGateOptions | null = null
  private gateOptionsTick = -1
  /** last logged REACHABILITY signature per candidate, so markers change with facts. */
  private readonly reachabilityLogSignatures = new Map<string, string>()
  /** last mirrored container-refusal signature set, so one dead end is one line. */
  private lastContainerRefusalKey: string | null = null
  /** last logged PLACE_REFUSED signature, so one geometry dead end is one line. */
  private lastPlacementRefusalKey: string | null = null
  /** last logged PORTAL_LIGHT_REFUSED signature, so one ignition dead end is one line. */
  private lastIgnitionRefusalKey: string | null = null
  /** last logged PORTAL_ENTER_REFUSED signature, so one transfer dead end is one line. */
  private lastEntryRefusalKey: string | null = null
  private lastEntryUnverifiedKey: string | null = null
  /** last logged EQUIP_ARMOR_REFUSED signature set, so "nothing better is held" is one line. */
  private lastArmorRefusalKey: string | null = null
  /** last logged RESOURCE_SOURCE_EXCLUDED signature set, so one protected structure is one line. */
  private lastSourceExclusionKey: string | null = null
  /** last logged ARMOR_CRAFT / ARMOR_CRAFT_REFUSED signature set, so one armour picture is one line. */
  private lastArmorCraftKey: string | null = null
  /** last logged PORTAL_FRAME_SITE_REJECTED line, so one scan rejection is one line. */
  private lastPortalFrameRejectionKey: string | null = null
  /** last logged EXPLORE_ROUTE_BLOCKED signature, so one explore dead end is one line. */
  private lastExploreRouteBlockedKey: string | null = null
  /** the current tick's typed explore dead end, fed into the starvation `missing` evidence. */
  private exploreRouteBlockedThisTick: ExploreRouteBlocked | null = null
  /** last logged COLUMN_DESCENT_REFUSED signature, so one stalled column is one line. */
  private lastColumnDescentRefusalKey: string | null = null
  /** dedupe key for the mirrored `HUNT_CONTACT_UNREACHABLE` lines */
  private lastContactRefusalKey: string | null = null
  /** last logged DIG_ROUTE_REFUSED signature, so one blocked terrain route is one line. */
  private lastDigRouteRefusalKey: string | null = null
  /** last logged REFLEX signature, so one unique binding continuation is one line. */
  private lastLegReflexKey: string | null = null
  /** last logged SKILL_POLICY_BOUNDARY signature, so one semantic boundary is one line. */
  private lastSkillBoundaryKey: string | null = null
  /** the current tick's typed dig-route refusals, fed into the starvation `missing` evidence. */
  private digRouteRefusalsThisTick: DigRouteRefusal[] = []
  /** the current tick's typed no-safe-descent fact, fed into the starvation `missing` evidence. */
  private columnDescentRefusalThisTick: ColumnDescentRefusal | null = null
  /** last logged PROSPECT_REFUSED signature, so one blocked en-route exposure is one line. */
  private lastProspectRefusalKey: string | null = null
  /** the current tick's typed blocked-exposure fact, fed into the starvation `missing` evidence. */
  private prospectRefusalThisTick: ProspectRefusal | null = null
  /** Dedupe key for the last mirrored `RESOURCE_SOURCE_NONE` line. */
  private lastSourceGapKey: string | null = null
  /** Dedupe key for the last mirrored `FOOD_SOURCE_NONE` line. */
  private lastFoodSourceGapKey: string | null = null
  /**
   * Dedupe key for the last mirrored `MOB_DROP_SOURCE_NONE` line (the M3 pearl
   * half had NO producer-side marker at all, so a pearl need with no sensed
   * enderman was invisible in the run log).
   */
  private lastMobDropGapKey: string | null = null
  /** Signature of the last `MOB_SPAWN_CONTEXT` line, so the context logs on a change. */
  private lastMobSpawnContextKey: string | null = null
  /** Signature of the last `COMBAT_KIT_GAP` line, so the gap logs on a change. */
  private lastCombatKitGapLine: string | null = null
  /** Signature of the last `THREAT_RANGED_UNANSWERED` line (dedup, not a state). */
  private lastRangedThreatLine: string | null = null
  /** Signature of the last `THREAT_BREAK_CONTACT` line (dedup, not a state). */
  private lastBreakContactLine: string | null = null
  /** #8: the movement target currently owning the body, blacklisted on oscillation. */
  private lastMoveTarget: { dimension: string; position: Vec3Json } | null = null
  /** the previous tracked move target (for oscillation suppression) */
  private previousMoveTarget: { dimension: string; position: Vec3Json } | null = null
  private lastOscillationPair: string | null = null
  private lastOscillationAt = 0
  /**
   * #46: bounded PLACE retries per item, so a bad spot never abandons the option.
   * The ledger owns the whole contract: after the bound it retires the item
   * family (so the generator stops re-offering it) and emits one typed
   * `PLACE_RETRIES_EXHAUSTED`. A verified placement clears it.
   */
  private readonly placementRetries = new PlaceRetryLedger()
  /**
   * Stations this generation verified placing. They are selectable and reachable
   * for the rest of the generation (the durable WorldMemory path only lands on a
   * later generation), so a placed furnace is never lost when the bot walks out
   * of the near-field sensor radius.
   */
  private readonly placedStations: KnownResource[] = []
  /** #46: sensor-visible placed furnaces, kept for the replan protection guard. */
  private lastPlacedFurnaceCount = 0
  /** Last mirrored `SMELT_INPUT_PREREQ` line, so a stable state logs it once. */
  private lastSmeltInputPrereqLine: string | null = null
  /** Last mirrored typed smelt route gap, so a stable state logs it once. */
  private lastSmeltRouteGapLine: string | null = null
  /** The smelt route gap observed this tick, consumed by the starvation evidence. */
  private smeltRouteGapThisTick: SmeltRouteGap | null = null
  /** Last mirrored typed station-retry line (attempts change -> one line per retry). */
  private lastSmeltStationRetryLine: string | null = null
  /** Last mirrored `CRAFT_INGREDIENT_PREREQ` line, so a stable state logs it once. */
  private lastCraftIngredientPrereqLine: string | null = null
  /** Last mirrored `CRAFT_STATION_ALREADY_KNOWN` line, so a stable state logs it once. */
  private lastCraftStationGapLine: string | null = null
  private lastPrereqStationKnownLine: string | null = null
  /** #78: consecutive `verified=false progressDelta=0` retrieve outcomes. */
  /** #78: last quantized position / swap pair / state signature. */
  private oscillationState: OscillationState | null = null
  /**
   * #360: code-owned state-recurrence evidence for the active Option. Verified
   * body-only MOVEs between a few cells with zero goal/search progress are
   * strategic non-progress; beta sees the evidence and code proves exhaustion.
   */
  private readonly strategicStall = new StrategicStallTracker(
    resolveStrategicStallHorizon(),
    resolveStrategicStallMaxDistinctStates(),
    resolveStrategicStallMinBodyProgress(),
  )
  /** #360: Option instance the recurrence evidence is currently armed on. */
  private strategicStallOptionId: string | null = null
  /**
   * SAFE: code-owned damage-at-critical-health evidence for the ACTIVE plan.
   * The measured starvation slide (14 HP -> 1 HP, `food:0`, `damage_taken ->
   * WAIT` forever) is invisible to every other counter, so this one proves the
   * plan is not ending the damage and crosses the System2 boundary once per
   * exhaustion with `CRITICAL_DAMAGE_EXHAUSTED`.
   */
  private readonly criticalDamage = new CriticalDamageTracker(resolveCriticalDamageLimit())
  /** Signature of the last `BODY_STARVING`/`CRITICAL_DAMAGE` line, so it logs on a change, not per tick. */
  private lastCriticalDamageLine: string | null = null
  /**
   * SAFE: code-owned environmental-hazard evidence for the body's own cell (fire
   * / lava / burning / drowning) plus the damage it attributes. Measured live
   * (`run-mucaq28q-1ftq1`): the body burned to death in the Nether with every
   * tick arriving as `source=null` and no marker in the whole run naming fire,
   * lava or burning. The state itself is sensed in `state.ts`
   * (`SelfState.envHazard`); this tracker only counts the damage that state
   * explains and marks the moment the hazard ends.
   */
  private readonly envHazard = new EnvHazardTracker()
  /** Signature of the last `ENV_HAZARD` line, so the state logs on a change. */
  private lastEnvHazardLine: string | null = null
  /** Signature of the last `ENV_HAZARD_NO_EXIT` line, so the gap logs on a change. */
  private lastEnvHazardGapLine: string | null = null
  /** Signature of the last `REFLEX` line, so a repeated reflex decision logs once. */
  private lastReflexLine: string | null = null
  /** last logged BRIDGE_REFUSED signature, so one refused bridge is one line. */
  private lastBridgeRefusalKey: string | null = null
  /** Signature of the last `SKILL_POLICY_BOUNDARY` line (hazard boundaries). */
  private lastEnvBoundaryLine: string | null = null
  /** True when a fresh damage observation landed this tick (fed to `envHazard`). */
  private damageObservedThisTick = false
  /**
   * SAFE: the bounded danger STATE (see `threat.ts`). Enter on the threat
   * predicate, leave only after the whole envelope has been continuously clear
   * for `THREAT_CLEAR_MS`. The measured death loop was per-tick: a body that
   * retreated once and went straight back to work when the mob's snapshot moved
   * outside `IMMEDIATE_HOSTILE_RANGE`, then died with health 2.17 after a minute
   * of the same. The candidate layer reads this through `signals.threat`.
   */
  private readonly threat = new ThreatTracker()
  /** Signature of the last `THREAT_NEARBY` line, so proximity logs on a change. */
  private lastThreatLine: string | null = null
  /** Signature of the last `THREAT_NO_ESCAPE` line, so the gap logs on a change. */
  private lastThreatGapLine: string | null = null
  /**
   * Signature of the last `SURVIVAL_DAMAGE_RACE` / `SURVIVAL_ESCAPE_NONE` line, so
   * the escape-versus-damage fact logs on a change (the line carries health, so it
   * re-logs per landed hit - the granularity a post-mortem needs).
   */
  private lastSurvivalRaceLine: string | null = null
  private lastThreatOccludedLine: string | null = null
  /** Whether the danger state was active last tick, so the exit logs once. */
  private threatWasActive = false
  /** Signature of the last `FOOD_HABITAT_REFUSED` line, so it logs on a change. */
  private lastFoodHabitatRefusalKey: string | null = null
  /**
   * Health the controller itself last observed, used to de-duplicate the two
   * damage triggers so one damage event costs one `consecutiveDamage`.
   */
  private lastObservedHealth: number | null = null
  /** #79: unverified zero-progress attempts per planId; after the limit the same strategy is abandoned. */
  private readonly actionUnverified = new Map<string, number>()
  /**
   * #11 v2 §6: abandonment is a FACT recorded under the state fingerprint that
   * produced it, so the precondition guard cannot re-protect an option that was
   * deterministically abandoned while the state is unchanged.
   */
  private readonly abandonedOptions = new AbandonmentLedger()
  /** #11 v2 §7: anti-thrash commitment - one candidate until a fact changes. */
  private commitmentState: CandidateFlapState | null = null
  /**
   * Action-lifecycle commitment: the in-flight chosen action is held for a
   * bounded window so the next decision cannot replace it before it settles.
   * Released on completion/failure (`onActionComplete`), a plan/goal change, a
   * deterministic invalidation, or the bounded window/budget.
   */
  private actionCommitmentState: ActionCommitmentState | null = null
  /** verified-outcome counter; a change clears the flap window and the commitment. */
  private progressEpoch = 0
  private commitmentProgressEpoch = 0
  /** Semantic per-tick fingerprint (inventory/world/topology), never the clock. */
  private lastStateFingerprint = ''
  /** Monotonic semantic authority generation used to invalidate stale System2 responses. */
  private semanticStateGeneration = 0
  /**
   * Same-run memory of a code-sensed partial/full portal frame. The site is a
   * verified world fact, not a semantic target: candidate grounding still
   * re-reads the live cells before actuation and the executor verifies every
   * placement. Keeping it here prevents an unloaded chunk from erasing the
   * only route to a frame that System2/Jev already selected.
   */
  private rememberedPortalFrameDimension: string | null = null
  private readonly rememberedPortalFrameSites = new Map<string, PortalFrameSite>()
  private rememberedPortalFrame: PortalFrameValidation | null = null

  private pendingDecisions = new Map<number, PendingDecision>()
  private pendingTrigger: TriggerEvent | null = null
  private deferredTrigger: TriggerEvent | null = null
  private decisionTimer: NodeJS.Timeout | null = null
  private lastTickAt = 0

  private watchdog: NodeJS.Timeout | null = null
  private running = false
  /** HOST has withdrawn semantic authority; only a pre-committed safety Skill may settle. */
  private modelRecoveryStopping = false
  /** Hard upper bound for settling a committed safety Skill during model recovery. */
  private modelRecoveryDrainTimer: NodeJS.Timeout | null = null
  /** Existing VTR owner allowed to finish its already-committed Reach contract during outage. */
  private modelRecoveryReachDrainTransitionId: string | null = null
  /** Serializes recovery-only direct controller turns against each other. */
  private modelRecoveryReachDrainAdvancing = false
  private modelRecoveryReachDrainPending = false
  private ticking = false
  private startedAt = 0
  private completion: Promise<RunSummary> | null = null
  private resolveCompletion: ((summary: RunSummary) => void) | null = null

  /**
   * ReachPlaneHost view of this controller. The class keeps every field
   * private; the plane's interface is satisfied structurally, so the cast is
   * confined to this one site. Plain-object test fixtures are passed the same
   * way, so their `host.*` stubs keep the old private-method seam.
   */
  private get reachHost(): ReachPlaneHost {
    return this as unknown as ReachPlaneHost
  }

  /** CandidateDiagnosticsHost view of this controller (same structural-cast pattern as reachHost). */
  private get diagnosticsHost(): CandidateDiagnosticsHost {
    return this as unknown as CandidateDiagnosticsHost
  }

  /** PortalEvidenceHost view of this controller (same structural-cast pattern as reachHost). */
  private get portalHost(): PortalEvidenceHost {
    return this as unknown as PortalEvidenceHost
  }

  /** ThreatObserverHost view of this controller (same structural-cast pattern as reachHost). */
  private get threatHost(): ThreatObserverHost {
    return this as unknown as ThreatObserverHost
  }

  /** RetrievalProgressHost view of this controller (same structural-cast pattern as reachHost). */
  private get retrievalHost(): RetrievalProgressHost {
    return this as unknown as RetrievalProgressHost
  }

  /** StallObserverHost view of this controller (same structural-cast pattern as reachHost). */
  private get stallHost(): StallObserverHost {
    return this as unknown as StallObserverHost
  }

  /** System2PlaneHost view of this controller (same structural-cast pattern as reachHost). */
  private get system2Host(): System2PlaneHost {
    return this as unknown as System2PlaneHost
  }

  /** GoalQueuePlaneHost view of this controller (same structural-cast pattern as reachHost). */
  private get queueHost(): GoalQueuePlaneHost {
    return this as unknown as GoalQueuePlaneHost
  }



  /** OutcomeAccountingHost view of this controller (same structural-cast pattern as reachHost). */
  private get outcomeHost(): OutcomeAccountingHost {
    return this as unknown as OutcomeAccountingHost
  }

  /** GroundedEvidenceHost view of this controller (same structural-cast pattern as reachHost). */
  private get evidenceHost(): GroundedEvidenceHost {
    return this as unknown as GroundedEvidenceHost
  }

  /** PathProbesHost view of this controller (same structural-cast pattern as reachHost). */
  private get probesHost(): PathProbesHost {
    return this as unknown as PathProbesHost
  }

  /** OutcomeLedgersHost view of this controller (same structural-cast pattern as reachHost). */
  private get ledgersHost(): OutcomeLedgersHost {
    return this as unknown as OutcomeLedgersHost
  }

  /** DecisionEpochsHost view of this controller (same structural-cast pattern as reachHost). */
  private get modelRecoveryHost(): ModelRecoveryHost {
    return this as unknown as ModelRecoveryHost
  }

  private get epochsHost(): DecisionEpochsHost {
    return this as unknown as DecisionEpochsHost
  }

  /** GoalStateHost view of this controller (same structural-cast pattern as reachHost). */
  private get goalStateHost(): GoalStateHost {
    return this as unknown as GoalStateHost
  }

  /** AbandonLifecycleHost view of this controller (same structural-cast pattern as reachHost). */
  private get abandonLifecycleHost(): AbandonLifecycleHost {
    return this as unknown as AbandonLifecycleHost
  }

  private get escalationHost(): EscalationHost {
    return this as unknown as EscalationHost
  }

  /** Read-only evidence projection; Mission session and Reach state live in VTR. */
  private get reachTransition(): ActiveReachTransition | null {
    const current = this.reachRuntime.activeMission
    return current === null ? null : { ...current, contract: current.contract, state: current.state }
  }

  private reachRunMetadataFixture: Readonly<ReachMissionRuntimeSession> | null = null
  /** Read-only compatibility projection for evidence/log call sites. */
  private get reachRunMetadata(): Readonly<ReachMissionRuntimeSession> | null {
    const runtime = this.reachRuntime as ReachMissionRuntime | undefined
    return runtime !== undefined && 'missionSession' in runtime
      ? runtime.missionSession
      : this.reachRunMetadataFixture
  }

  /**
   * Test-only evidence fixture compatibility. Production ReachMissionRuntime
   * owns sessions; delete this shim once callback tests seed VTR session DTOs
   * directly instead of Object.assign'ing the removed controller field.
   */
  private set reachRunMetadata(value: Readonly<ReachMissionRuntimeSession> | null) {
    const runtime = this.reachRuntime as ReachMissionRuntime | undefined
    if (runtime !== undefined && 'missionSession' in runtime) return
    this.reachRunMetadataFixture = value
  }

  private noteReachAuthorityConflict(): void {
    return reach.noteReachAuthorityConflict(this.reachHost)
  }

  private noteReachHealth(health: number): number {
    return reach.noteReachHealth(this.reachHost, health)
  }

  constructor(bot: Bot, options: Partial<JevAgentOptions> & Pick<JevAgentOptions, 'kernelAuthority'>) {
    this.bot = bot
    this.options = normalizeOptions({ ...defaultJevAgentOptions, ...options })
    this.moveFailMemory = this.createMoveFailMemory()
    this.localOscillation = restoreLocalOscillationRecord(this.options.localOscillationRecord ?? null)
    this.localOscillationPersisted = localOscillationPersistKey(this.localOscillation)
    this.repeatedOutcomes = this.createRepeatedOutcomes()
    this.replanThrottle = new ReplanThrottle(
      this.options.replanThrottleMs,
      this.options.replanPositionDelta,
      this.options.replanNoInfoEscalateCycles,
    )
    this.actionFailureEscalation = new ActionFailureEscalation(this.options.actionFailureEscalateCycles)
    this.waitStreakEscalation = new WaitStreakEscalation(this.options.waitStreakEscalateCycles)
    this.betaAbandonDeferral = new BetaAbandonDeferral(this.options.betaAbandonDeferCycles)
    this.goal = makeGoal(this.options.goalItem, this.options.goalCount)
    this.queue = new GoalQueue()
    this.installDominatedPrerequisiteReason()
    this.installGoalSuccessProbe()
    this.recipeIndex = createRecipeIndex(bot.registry)
    this.runWriter = new JsonlWriter(join(this.options.logDir, 'run.jsonl'))
    this.jevWriter = new JsonlWriter(join(this.options.logDir, 'jev-calls.jsonl'))
    this.decisionWriter = new JsonlWriter(join(this.options.logDir, 'decisions.jsonl'))
    this.system2Writer = new JsonlWriter(join(this.options.logDir, 'system2.jsonl'))
    this.logger =
      this.options.eventSink === undefined
        ? new EventLogger(this.runWriter, this.options.verbose)
        : new MirroringEventLogger(this.runWriter, this.options.verbose, this.options.eventSink)
    this.jev = this.buildPolicy()
    this.initializeReachVtrRuntime()
    this.scheduler = this.buildScheduler()
    this.executor = new Executor(bot, this.logger, executorOptions(this.options, this.scheduler))
    this.reachRuntimeAdapter = new MineflayerReachRuntimeAdapter(bot, this.executor)
    this.system2 = new StubSystem2(this.system2Writer)
  }

  /** Compose VTR with a restricted adapter context; VTR retains no controller or Bot reference. */
  private initializeReachVtrRuntime(): void {
    this.reachRuntime = createJevReachVtrComposition({
      serverId: this.options.serverId,
      worldEpoch: this.options.worldEpoch,
      generationId: this.options.decisionProvenance.generationId,
      leaseId: this.options.actuationPort?.generationId ?? null,
      policy: { value: this.jev },
      cachedWorldState: this.reachVtrCells.cachedWorldState,
      counters: this.reachVtrCells.counters,
      lastRouteDecision: this.reachVtrCells.lastRouteDecision,
      logger: this.logger,
      kernelAuthority: this.options.kernelAuthority,
    }).runtime
  }

  /**
   * Run a HOST control-plane mutation (e.g. a chat reply to a human) under a
   * typed host scope so the kernel session attributes it to the host plane,
   * never to whichever transition happens to own the body.
   */
  withHostScope<T>(label: string, fn: () => T): T {
    return this.executor.withAuthorityScope(
      {
        actionId: null,
        epoch: null,
        authority: 'host-control-plane',
        transitionId: null,
        transitionContractHash: null,
        hostScope: { category: 'host-control-plane', label },
      },
      fn,
    )
  }

  /**
   * The executor's current actuation authority at the moment a mutation
   * dispatch was observed. Returns null when no action is in flight; the
   * kernel session records unattributed mutations as hard blockers, never as
   * silent evidence.
   */
  currentActuationAuthority(): MutationAuthorityContext | null {
    const scoped = this.executor.currentAuthorityScope
    if (scoped !== null) return scoped
    const action = this.executor.current
    if (action === null) return null
    return {
      actionId: action.id,
      epoch: action.epoch,
      authority: action.authorityLabel ?? null,
      transitionId: action.transitionId ?? null,
      transitionContractHash: action.transitionContractHash ?? null,
    }
  }

  // -------------------------------------------------------------------------
  // public surface
  // -------------------------------------------------------------------------

  get lastCandidateList(): readonly Candidate[] {
    return this.lastCandidates
  }

  get lastDecisionCandidateId(): string | null {
    return this.lastDecisionId
  }

  get lastDecisionResult(): JevResult | null {
    return this.lastDecision
  }

  get goalState(): GoalState {
    return this.goal
  }

  get goalQueueState(): GoalQueueState {
    return this.queue.state
  }

  get agent(): Executor {
    return this.executor
  }

  get policyKind(): JevPolicy['kind'] {
    return this.jev.kind
  }

  get policyModel(): string {
    return this.jev.model
  }

  get system2Model(): string {
    return this.system2.authorityModel ?? this.system2.model
  }

  get system2Provider(): string {
    return this.system2.provider ?? 'unknown'
  }

  get system2AuthorityStack(): { provider: string; model: string } {
    return this.system2.authorityStack ?? {
      provider: this.system2.provider ?? 'unknown',
      model: this.system2.authorityModel ?? this.system2.model,
    }
  }

  get policyProvider(): string {
    return this.jev.kind === 'typesafe' ? 'typesafe-ai' : 'deterministic'
  }

  get deterministicFallbackEnabled(): boolean {
    return this.options.forceFallbackPolicy || this.jev.kind !== 'typesafe'
  }

  get isRunning(): boolean {
    return this.running
  }

  /** Swap in a real long-horizon model. The interface is system2.ts#System2Brain. */
  setSystem2(brain: System2Brain): void {
    if (this.system2 !== brain) this.system2?.cancelPending?.('system2-replaced')
    this.system2 = brain
  }

  /**
   * Explicit player intent owns WHAT and therefore bypasses System2 selection,
   * but still flows through the normal GoalQueue -> Jev -> Guard -> Executor.
   * The autonomous mission is preserved behind the human interrupt queue.
   */
  submitHumanPlan(goals: readonly PlannedGoal[], requestedBy: string): QueuedGoal[] {
    return queueplane.submitHumanPlan(this.queueHost, goals, requestedBy)
  }

  /** Clear only human-owned unfinished rows and resume the preserved mission. */
  clearHumanPlan(requestedBy: string, reason = 'free'): QueuedGoal[] {
    return queueplane.clearHumanPlan(this.queueHost, requestedBy, reason)
  }

  /** Must be called before start(). Rebuilds every derived object. */
  setOptions(partial: Partial<Omit<JevAgentOptions, 'kernelAuthority'>>): void {
    if (this.running) throw new Error('setOptions() cannot be called while the agent is running')
    this.options = normalizeOptions({ ...this.options, ...partial })
    this.moveFailMemory = this.createMoveFailMemory()
    this.localOscillation = restoreLocalOscillationRecord(this.options.localOscillationRecord ?? null)
    this.localOscillationInventory = ''
    this.localOscillationPersisted = localOscillationPersistKey(this.localOscillation)
    this.repeatedOutcomes = this.createRepeatedOutcomes()
    this.repeatedOutcomesPersisted = JSON.stringify(this.repeatedOutcomes.snapshot())
    this.goal = makeGoal(this.options.goalItem, this.options.goalCount)
    this.harvestedGoalCount = 0
    this.semanticStateGeneration = 0
    this.lastStateFingerprint = ''
    this.queue = new GoalQueue()
    this.installDominatedPrerequisiteReason()
    this.installGoalSuccessProbe()
    this.runWriter = new JsonlWriter(join(this.options.logDir, 'run.jsonl'))
    this.jevWriter = new JsonlWriter(join(this.options.logDir, 'jev-calls.jsonl'))
    this.decisionWriter = new JsonlWriter(join(this.options.logDir, 'decisions.jsonl'))
    this.system2Writer = new JsonlWriter(join(this.options.logDir, 'system2.jsonl'))
    this.logger =
      this.options.eventSink === undefined
        ? new EventLogger(this.runWriter, this.options.verbose)
        : new MirroringEventLogger(this.runWriter, this.options.verbose, this.options.eventSink)
    this.jev = this.buildPolicy()
    this.initializeReachVtrRuntime()
    this.scheduler = this.buildScheduler()
    this.executor = new Executor(this.bot, this.logger, executorOptions(this.options, this.scheduler))
    this.reachRuntimeAdapter = new MineflayerReachRuntimeAdapter(this.bot, this.executor)
    this.system2 = new StubSystem2(this.system2Writer)
  }

  private buildPolicy(): JevPolicy {
    try {
      return createJevPolicy({
        writer: this.jevWriter,
        model: process.env.AI_GATEWAY_MODEL ?? null,
        timeoutMs: this.options.jevTimeoutMs,
        maxRetries: this.options.jevMaxRetries,
        rateLimitRetries: this.options.jevRateLimitRetries,
        rateLimitBaseDelayMs: this.options.jevRateLimitBaseDelayMs,
        forceFallback: this.options.forceFallbackPolicy,
      })
    } catch (error) {
      const fatal = error instanceof FatalModelError ? error : new FatalModelError('jev-policy', 1, describeFailure(error))
      return failLoud(fatal, this.policyFailureLog, this.options.terminateOnModelFailure)
    }
  }

  private readonly policyFailureLog = (event: string, detail?: Record<string, unknown>): void => {
    this.logger.error('policy', event, detail ?? {}, this.tickCounter)
  }

  private createMoveFailMemory(): MoveFailMemory {
    return ledgers.createMoveFailMemory(this.ledgersHost)
  }

  private createRepeatedOutcomes(): RepeatedOutcomeEscalation {
    return ledgers.createRepeatedOutcomes(this.ledgersHost)
  }

  private notifyRepeatedOutcomes(): void {
    return ledgers.notifyRepeatedOutcomes(this.ledgersHost)
  }

  private buildScheduler(): DecisionScheduler {
    const scheduler = new DecisionScheduler(this.bot, this.logger, {
      heartbeatMs: this.options.heartbeatMs,
      enabledTriggers: this.options.enabledTriggers,
      coalesceMs: this.options.schedulerCoalesceMs,
    })
    scheduler.onDecision((event) => {
      this.requestDecision(event.trigger, event.detail)
    })
    return scheduler
  }

  start(): void {
    if (this.running) return
    // V4.1.2: pinning the movement policy mutates pathfinder state outside any
    // Transition, so it is declared under a typed host adapter-config scope
    // rather than left unattributed or fake-attributed to a later Transition.
    this.executor.withAuthorityScope(
      {
        actionId: null,
        epoch: null,
        authority: 'host-adapter-config',
        transitionId: null,
        transitionContractHash: null,
        hostScope: { category: 'adapter-config', label: 'bootstrap-movement-pin' },
      },
      () => this.executor.ensureMovements(),
    )
    this.running = true
    this.startedAt = Date.now()
    this.lastProgressAt = Date.now()
    this.completion = new Promise<RunSummary>((resolve) => {
      this.resolveCompletion = resolve
    })

    this.logger.info(
      'agent',
      `jev-agent started policy=${this.jev.kind} provider=${this.policyProvider} model=${this.jev.model} system2Provider=${this.system2Provider} system2=${this.system2Model} goal="${this.goal.description}"`,
      {
        policy: this.jev.kind,
        model: this.jev.model,
        system2Provider: this.system2Provider,
        system2Model: this.system2Model,
        policyProvider: this.policyProvider,
        deterministicFallbackEnabled: this.deterministicFallbackEnabled,
        goal: this.goal.description,
        heartbeatMs: this.options.heartbeatMs,
        llmCooldownMs: this.options.llmCooldownMs,
        triggers: this.scheduler.triggers,
        jevJsonl: this.jevWriter.path,
        decisionsJsonl: this.decisionWriter.path,
        system2Jsonl: this.system2Writer.path,
        runJsonl: this.runWriter.path,
        gatewayKeyPresent: this.jev.kind === 'typesafe',
      },
      0,
    )

    this.bot.on('end', this.onBotEnd)
    this.bot.on('kicked', this.onBotKicked)
    this.bot.on('death', this.onBotDeath)

    if (this.options.singleShotPlanner) {
      void this.bootstrapThenStart()
    } else {
      this.scheduler.start()
    }
    if (this.options.maxRuntimeMs > 0) {
      this.watchdog = setTimeout(() => {
        this.finish('max-runtime', this.runSuccess())
      }, this.options.maxRuntimeMs)
    }
  }

  /**
   * M1 entry: obtain the plan from the planner stub exactly once, then start the
   * event-driven loop. The single plan call happens OUTSIDE any decision tick,
   * so every decision record can truthfully report `llm.called === false`.
   */
  private async bootstrapThenStart(): Promise<void> {
    try {
      await this.bootstrapPlan()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger.error('system2', `bootstrap plan failed: ${message}`, {}, this.tickCounter)
      this.recordFailure('unknown_event', `bootstrap plan failed: ${message}`)
    }
    if (!this.running) return
    this.scheduler.start()
  }

  private async bootstrapPlan(): Promise<void> {
    return system2plane.bootstrapPlan(this.system2Host)
  }

  stop(): void {
    this.system2?.cancelPending?.('controller-stop')
    this.finish('stopped-by-caller', this.runSuccess())
  }

  /** HOST quiesce fence: await the ordinary stop or the current recovery drain. */
  async quiesce(): Promise<void> {
    this.stop()
    await this.wait()
  }

  /**
   * HOST model recovery withdraws all model/scheduler decision authority
   * immediately. An already-committed VTR Reach contract retains only its own
   * controller until deterministic VERIFY or a typed contract boundary; each
   * subordinate Skill still carries that same transitionId. Legacy bounded
   * escape Skills retain their existing one-Skill drain.
   */
  stopForModelRecovery(): void {
    return modelrecovery.stopForModelRecovery(this.modelRecoveryHost)
  }

  private beginModelRecoveryReachDrain(runtime: ActiveReachTransition): void {
    return reach.beginModelRecoveryReachDrain(this.reachHost, runtime)
  }

  /** Continue only the named active Reach owner; this path never enters tick(), Jev, or System2. */
  private async advanceModelRecoveryReachDrain(transitionId: string, trigger: string): Promise<void> {
    return reach.advanceModelRecoveryReachDrain(this.reachHost, transitionId, trigger)
  }

  private completeModelRecoveryReachDrain(transitionId: string, outcome: string): void {
    return reach.completeModelRecoveryReachDrain(this.reachHost, transitionId, outcome)
  }

  wait(): Promise<RunSummary> {
    if (this.completion !== null) return this.completion
    return Promise.resolve(this.summary('stopped-by-caller', this.runSuccess()))
  }

  // -------------------------------------------------------------------------
  // bot lifecycle
  // -------------------------------------------------------------------------

  private readonly onBotEnd = (): void => {
    this.finish('disconnected', this.runSuccess())
  }

  private readonly onBotKicked = (reason: string): void => {
    this.logger.warn('agent', `kicked: ${reason}`)
    this.finish('disconnected', false)
  }

  /**
   * The generation half of the death telemetry.
   *
   * The host `DEATH` line owns position/dimension/inventory and the block-probe
   * cause; the ATTRIBUTED attacker, the code-owned danger state and the kit the
   * body died with are owned here and would otherwise be lost when this
   * generation is disposed. Measured live (`run-muc3qbug-18vg3`): the body died
   * in the Nether with `cause=damage` and no buddy.log line ever named the
   * spider that had been inside melee contact, or the ghast that had been
   * shelling it from outside perception.
   */
  private readonly onBotDeath = (): void => {
    const state = this.lastWorldState
    if (state !== null) {
      const lastDamage = state.signals.lastDamage ?? null
      const threat = state.signals.threat ?? null
      const at = state.self.position
      // SAFE: fire/lava/burning have no attacking entity, so an unattributed
      // death in one is attributed to the hazard the body's own sensed state
      // names (measured live: `killer=null` while the body burned). A real
      // Mineflayer attribution always wins inside `formatDeathCause`.
      const environmentalKiller = this.envHazardAttribution()
      const line = formatDeathCause({
        dimension: state.self.dimension,
        position: at,
        health: state.self.health,
        food: state.self.food,
        hostCause: null,
        lastDamage,
        threat,
        hostiles: state.entities.map((entity) => ({
          name: entity.name,
          distance: entity.distance,
          hostile: entity.hostile,
        })),
        weapon: weaponFacts(state.self.heldItem?.name ?? null),
        wornArmorCount: ARMOR_SLOTS.filter((slot) => {
          const piece = state.self.armor?.[slot]
          return piece !== null && piece !== undefined
        }).length,
        damageAgeMs: lastDamage === null ? null : Math.max(0, Math.round(state.timestampMs - lastDamage.atMs)),
        envHazard: environmentalKiller,
      })
      this.logger.warn(
        'agent',
        line,
        {
          dimension: state.self.dimension,
          killer: lastDamage?.sourceName ?? environmentalKiller,
          killerEvidence:
            lastDamage?.sourceName != null ? 'mineflayer' : environmentalKiller !== null ? 'environment' : 'none',
          killerId: lastDamage?.sourceId ?? null,
          threat: threat?.threatName ?? null,
          threatDistance: threat?.threatDistance ?? null,
          contact: threat?.inContact ?? false,
          health: state.self.health,
          food: state.self.food,
        },
        this.tickCounter,
      )
    }
    this.escalate('unexpected_world_state', 'bot died')
  }

  // -------------------------------------------------------------------------
  // event-driven scheduling
  // -------------------------------------------------------------------------

  /**
   * The single entry point for every trigger. While an action is in flight,
   * non-preemptive triggers are deferred (never re-asked mid-walk); preemptive
   * triggers may interrupt. While a tick is already running, triggers coalesce.
   */
  private requestDecision(trigger: DecisionTrigger, detail: Record<string, unknown>): void {
    epochs.requestDecision(this.epochsHost, trigger, detail)
  }

  /**
   * Space decision starts by at least `minDecisionIntervalMs` and, crucially,
   * yield to the macrotask queue between decisions. Without the yield a
   * fast-failing action's already-resolved awaits starve timers (including the
   * run watchdog) and the loop spins thousands of times per second.
   */
  private scheduleTick(event: TriggerEvent): void {
    epochs.scheduleTick(this.epochsHost, event)
  }

  private clearDecisionTimer(): void {
    epochs.clearDecisionTimer(this.epochsHost)
  }

  private drainPending(): void {
    epochs.drainPending(this.epochsHost)
  }

  private reachIdentity(state: WorldState): ReachIdentity | null {
    return reach.reachIdentity(this.reachHost, state)
  }

  /** Re-read world and HOST generation identity at each mechanical boundary. */
  private liveReachIdentity(fallback: ReachIdentity): ReachIdentity {
    return reach.liveReachIdentity(this.reachHost, fallback)
  }

  /** Build a VTR-only fact view. The empty GoalQueue projection is for old sensor helpers only. */
  private buildReachWorldState(mission: VtrInventoryMission): WorldState {
    return reach.buildReachWorldState(this.reachHost, mission)
  }

  /**
   * Thin compatibility bridge: inject current typed observations and local
   * candidate affordance facts into the isolated Minecraft Reach projection.
   * Predicate, witness, route, and progress semantics live in the projection
   * adapter, never in this controller.
   */
  private projectReachMission(
    mission: VtrInventoryMission,
    state: WorldState,
    identity: ReachIdentity,
    contract: ReachTransitionContract | null = null,
    snapshotOptions: ReachMissionSnapshotOptions = {},
  ): ReturnType<typeof projectMinecraftReachMission> {
    this.reachRouteDecisionWorld = state
    const options = candidateOptions(
      this.options,
      this.recipeIndex,
      this.unreachableStationKeys(state),
      this.reachRuntimeAdapter.reachabilityGateOptions(this.tickCounter, this.reachabilityProofs),
      this.blacklistedMoveTargets(state),
      state.portalFrame,
      this.searchedSurfaceTargets,
      null,
      this.placementRetries.retiredItemSet(),
    )
    return projectMinecraftReachMission({
      mission,
      world: state,
      candidateOptions: options,
      identity,
      witnessIdentity: this.reachIdentity(state),
      contract,
      previousFrontierId: this.reachRuntime.current?.state.progress.frontierId ?? null,
      previousActionFailure: this.lastReachActionFailure,
      snapshotOptions,
    })
  }

  private currentVtrReachRouteDecision(): typeof this.lastVtrReachRouteDecision {
    return reach.currentVtrReachRouteDecision(this.reachHost)
  }

  /** Map one typed VTR intent through the temporary Mineflayer Reach actuation port. */
  private async dispatchReachIntent(
    result: ReachControllerResult,
    state: WorldState,
    identity: ReachIdentity,
    candidates: readonly Candidate[],
  ): Promise<boolean> {
    return reach.dispatchReachIntent(this.reachHost, result, state, identity, candidates)
  }

  private logReachActuation(
    intent: ReachMechanicalIntent,
    actionId: string | null,
    epoch: number,
    candidateId: string,
    guardedCandidate: Candidate,
  ): void {
    return reach.logReachActuation(this.reachHost, intent, actionId, epoch, candidateId, guardedCandidate)
  }

  private async releaseUnstartedReachIntent(intentId: string, transitionId: string, evidence: string): Promise<void> {
    return reach.releaseUnstartedReachIntent(this.reachHost, intentId, transitionId, evidence)
  }

  private async tickReachTransition(trigger: DecisionTrigger, detail: Record<string, unknown>): Promise<boolean> {
    return reach.tickReachTransition(this.reachHost, trigger, detail)
  }

  private authorizeReachMechanicalStep(
    intentId: string,
    identity: ReachIdentity,
    step: { stepId: string; leg: number; effectKind: 'locomotion' },
  ): boolean {
    return reach.authorizeReachMechanicalStep(this.reachHost, intentId, identity, step)
  }

  private recordReachMechanicalOutcome(
    intentId: string,
    identity: ReachIdentity,
    step: { stepId: string; leg: number; effectKind: 'locomotion' },
  ): boolean | 'verified-terminal' {
    return reach.recordReachMechanicalOutcome(this.reachHost, intentId, identity, step)
  }

  private async onReachActionComplete(
    result: ReachMechanicalActionOutcome,
    candidate: Candidate,
    transitionId: string,
    intentId: string,
  ): Promise<void> {
    return reach.onReachActionComplete(this.reachHost, result, candidate, transitionId, intentId)
  }

  private closeReachTransition(
    reportedOutcome: ReachTerminalOutcome,
    reportedState: ReachTransitionState,
    boundary: string,
    cancelIntentId: string | null = null,
    action: { readonly intentId: string; readonly actionId: string } | undefined = undefined,
  ): boolean {
    return reach.closeReachTransition(this.reachHost, reportedOutcome, reportedState, boundary, cancelIntentId, action)
  }

  /** Journal the exact fresh fact observation that authorized deterministic SUCCESS. */
  private logReachVerification(outcome: ReachTerminalOutcome, snapshot: ReachRuntimeSnapshot): void {
    return reach.logReachVerification(this.reachHost, outcome, snapshot)
  }
  // -------------------------------------------------------------------------
  // the one loop
  // -------------------------------------------------------------------------

  private async tick(trigger: DecisionTrigger, detail: Record<string, unknown>): Promise<void> {
    if (!this.running || this.ticking) return
    this.ticking = true
    this.lastTickAt = Date.now()
    this.tickResummonLog = []
    this.tickLlmCalls = 0
    try {
      this.tickCounter += 1
      // Issue #437 §5 evidence: an action still in flight means this tick consumed
      // mechanical steps with no policy event. Counted only for the packet's
      // `compressedSteps`; never model input.
      if (this.executor.current !== null) this.compressedSkillSteps += 1
      this.damageObservedThisTick = false
      this.triggerCounts[trigger] = (this.triggerCounts[trigger] ?? 0) + 1
      if (epochs.CRITICAL_TRIGGERS.has(trigger)) this.criticalStateVersion += 1
      this.signals.maxConcurrentActions = this.executor.maxConcurrentActions
      this.signals.lastPathStatus = this.executor.lastPathStatus
      this.signals.consecutiveFailures = this.failureStreak
      this.signals.escalationRecommended = Date.now() - this.lastEscalationMs < this.options.escalationWindowMs
      this.signals.failedCandidates = this.failureSnapshot()
      this.signals.zeroProgressRoutes = this.zeroProgressRoutes
      this.signals.knownResources = filterKnownResources(
        this.knownResourcesForSensor().filter((resource) => resourceDimensionMatches(resource, this.reachRuntimeAdapter.currentDimension())),
        this.unreachableResources,
      )
      this.updateStallSignal()
      this.observeThreat(trigger, detail, this.reachRuntimeAdapter.currentHealth())

      if (!this.reachRuntimeAdapter.bodyAvailable()) return

      // V4's Reach controller runs before GoalQueue reconciliation and before
      // either model authority. While a contract is active, the legacy semantic
      // plane does not get a chance to dispatch, terminate, or replan that slice.
      if (this.options.vtrMission !== null && this.options.vtrMission !== undefined) {
        const handled = await this.tickReachTransition(trigger, detail)
        if (handled) return
      }
      if (this.options.vtrReachProbe === true) {
        const current = this.executor.current
        if (current !== null && current.authorityLabel !== 'vtr-reach') {
          this.executor.cancelCurrent('VTR Reach probe refused legacy scheduler fallback')
        }
        this.logger.warn(
          'vtr',
          `VTR_REACH_PROBE_HOLD trigger=${trigger} reason=${this.options.vtrMission === null || this.options.vtrMission === undefined ? 'mission-unavailable' : 'scheduler-declined-no-legacy-fallback'}`,
          {
            trigger,
            reason: this.options.vtrMission === null || this.options.vtrMission === undefined ? 'mission-unavailable' : 'scheduler-declined-no-legacy-fallback',
            activeActionId: current?.id ?? null,
            activeAuthority: current?.authorityLabel ?? null,
            authority: 'vtr-transition-scheduler',
          },
          this.tickCounter,
        )
        return
      }
      if (this.modelRecoveryStopping) return

      // These legacy recovery observers may wake System2. Run them only after
      // the VTR slice has had first refusal over its own contract boundary.
      this.observeRetrievalStall()
      this.observeCapabilityGap()
      this.observeCriticalDamage(trigger, detail)
      this.sampleHealthFallback()

      // Consume the queue against the live inventory: this completes the current
      // subgoal and advances it, recording the transition with the trigger.
      this.syncQueue(trigger)
      this.syncGoalToQueue()
      // #plan-reconciliation: the queue's plan/objective identity, and the
      // bounded cross-dimension head fact. Both run before the yield watchdog and
      // before the state build, so the row order and head the candidates are
      // generated against are the reconciled ones, and a stale-plan head produces
      // its typed System2 request this tick instead of an unbounded WAIT.
      this.reconcilePlanIdentity()
      this.reconcileHeadDimension()
      // #nonprogress-yield: an OPTIONAL row that has made zero semantic progress
      // for a bounded window in one pocket may not keep holding the head while
      // the frontier's own goal waits. Runs before the state build so the
      // demoted order is what candidates are generated against this tick.
      this.reconcileNonProgressingOptionalHead()

      if (
        this.options.singleShotPlanner &&
        this.planSupplied &&
        this.queue.isEmpty &&
        this.subgoalCount > 0 &&
        this.queue.state.done >= this.subgoalCount
      ) {
        this.logger.warn(
          'agent',
          `plan complete: ${this.subgoalCount} subgoal(s) done, inventory ${JSON.stringify(this.inventorySnapshot())}`,
          { subgoalCount: this.subgoalCount, trigger },
          this.tickCounter,
        )
        this.finish('goal-complete', true)
        return
      }

      if (
        this.options.stopAfterSubgoals > 0 &&
        this.queue.state.done >= this.options.stopAfterSubgoals
      ) {
        this.logger.warn(
          'agent',
          `phase boundary: ${this.queue.state.done}/${this.subgoalCount} subgoal(s) done, inventory ${JSON.stringify(this.inventorySnapshot())}; stopping so the next phase resumes from the ledger`,
          { done: this.queue.state.done, subgoalCount: this.subgoalCount, trigger },
          this.tickCounter,
        )
        this.finish('stopped-by-caller', true)
        return
      }

      let state = buildWorldState(
        this.bot,
        {
          tick: this.tickCounter,
          goal: this.goal,
          goalQueue: this.queue.state,
          currentOption: this.currentOptionContext(),
          recentOutcomes: this.recentOutcomes,
          focusItem: currentFocusItem(this.goal, this.queue.state),
          retrievalItems: this.retrievalProbeItems(),
          recentEvents: this.recentEvents,
          signals: this.signals,
          rememberedStations: this.knownResourcesForSensor(),
          // The contents this body OBSERVED by opening a container. A container
          // with no entry is UNKNOWN - the client has no other contents surface,
          // so absence of an observation must never be read as empty.
          containerContents: this.executor.containerContents(),
        },
        sensorOptions(this.options, this.scheduler.worldRevision),
      )
      state = this.mergeRememberedPortalFrame(state)
      this.syncTerrainSignals(state)
      this.sampleMovement(state.self.position)
      this.logStaleKnownResources(state)
      // Section E: the state just contradicted the running skill's target claim,
      // so stop it with a typed outcome BEFORE this tick's decision. Jev owns the
      // replacement; code never substitutes one.
      this.cancelContradictedSkillTarget(state)
      // issue #436 section 14/23: the same rule for the commitment's OWN
      // lifecycle - a world/epoch/dimension change it was not grounded in ends it
      // with a typed outcome. The lease is the HOST's (`ensureOwned`).
      this.cancelInvalidCommitment(state)
      this.lastPlacedFurnaceCount = (state.furnaces ?? []).filter(isSensedStation).length
      this.lastStateFingerprint = this.stateFingerprint(state)
      // Retain the sensor facts the pure vertical-plan refusal needs (step cuts,
      // terrain, inventory). `observeCapabilityGap` runs before the sensor build,
      // so it reads the previous tick's snapshot through the tick guard.
      this.lastWorldState = state
      this.lastWorldStateTick = this.tickCounter

      if (state.self.health <= 0) {
        // A dead body has no fight to continue: the danger state must not leak
        // into the post-respawn generation.
        this.threat.reset()
        this.threatWasActive = false
        this.lastThreatLine = null
        this.escalate('unexpected_world_state', 'health <= 0')
        return
      }

      // SAFE: advance the bounded danger state from THIS tick's sensed entities
      // and publish it on the signals the candidate layer, the guard and the Jev
      // payload read. Runs before candidate generation so the escape-cell scan,
      // the retreat grounding and the restriction all see the same state.
      this.observeThreatState(state)
      this.observeUnansweredRangedThreat(state)
      // SAFE: the body's own environmental hazard (fire/lava/burning/drowning)
      // is a sensor fact on THIS tick's state; mirror it, name the typed CAN gap
      // when the world grounds no exit, and feed the tracker the damage
      // observation so `source=null` can be attributed with evidence.
      this.observeEnvHazard(state)

      const unreachableStations = this.unreachableStationKeys(state)
      const blacklistedMoveTargets = this.blacklistedMoveTargets(state)
      const portalEntry = this.portalEntryPlan(state)
      const groundingOptions = candidateOptions(
        this.options,
        this.recipeIndex,
        unreachableStations,
        this.reachabilityGateOptions(),
        blacklistedMoveTargets,
        state.portalFrame,
        this.searchedSurfaceTargets,
        portalEntry,
        this.placementRetries.retiredItemSet(),
      )
      const grounded = generateGroundedCandidates(state, groundingOptions)
      // The affordance plane evaluated every candidate's grounding facts this
      // tick. Its fingerprint is the "did anything that could re-open this
      // target change?" fact; for the candidates that PASSED the gate it had no
      // consumer at all (only the withheld side is fed to the reachability proof
      // memory), so the cross-action bound is where it finally lands.
      this.groundingFingerprints = new Map(
        grounded.reachability.map((entry) => [entry.candidate.id, entry.targetSignature]),
      )
      this.withheldCandidateIds = new Set(grounded.withheld.map((entry) => entry.candidate.id))
      // The typed projection of the SAME refusal facts, for the System2 payload.
      // Rebuilt every tick from this tick's `grounded` result, so a summon can
      // never carry a refusal the body has already escaped.
      this.withheldCandidateFacts = grounded.withheld.map((entry) => ({
        candidate: entry.candidate.id,
        kind: String(entry.candidate.kind),
        reason: entry.result.reason,
        missing: entry.result.missingCapabilities.map(capabilityKey),
        suppressed: entry.suppressed,
        // The GROUNDED ALTERNATIVE for each missing fact: the acquisition routes
        // the same gate enumerated, or its typed refusal. Present only when the
        // acquisition pass ran, so no route is ever invented here.
        ...(entry.acquisition === undefined
          ? {}
          : {
              acquisition: entry.acquisition.map((fact) => ({
                missing: fact.missing,
                routes: [...fact.routes],
                reason: fact.reason,
                item: fact.item,
                count: fact.count,
                held: fact.held,
                tools: fact.tools,
              })),
            }),
      }))
      this.presentedCandidateFacts = grounded.candidates.map((candidate) => ({
        candidate: candidate.id,
        kind: String(candidate.kind),
      }))
      this.withheldToolGaps = withheldToolGaps(grounded.withheld, this.inventorySnapshot())
      this.withheldFactsFingerprint = this.lastStateFingerprint
      this.logReachability(grounded.reachability, grounded.withheld)
      this.logPlacementRefusal(grounded.placeRefusal)
      this.logContainerRefusals(grounded.containerRefusals)
      this.logIgnitionRefusal(grounded.ignitionRefusal)
      this.logEntryRefusal(grounded.entryRefusal)
      this.noteRouteExhaustion(grounded.entryRefusal)
      this.logEntryUnverified(portalEntry)
      this.logArmorRefusal(grounded.armorRefusals)
      this.logArmorCraft(grounded.armorCraftOffers, grounded.armorCraftRefusals)
      this.logSourceExclusions(grounded.sourceExclusions)
      this.logExploreRouteBlocked(grounded.exploreRouteBlocked)
      this.logColumnDescentRefusal(grounded.columnDescentRefusal)
      this.logContactRefusals(grounded.contactRefusals)
      this.logDigRouteRefusals(grounded.digRefusals)
      this.logLegReflexes(grounded.candidates, grounded.withheld.map((entry) => entry.candidate))
      this.logBridgeRefusals(grounded.candidates, grounded.withheld.map((entry) => entry.candidate))
      this.logSkillPolicyBoundaries(grounded.candidates, grounded.withheld.map((entry) => entry.candidate))
      this.logProspectRefusal(grounded.prospectRefusal)
      this.logResourceSourceGap(grounded.sourceGap)
      this.logFoodSourceGap(grounded.foodGap)
      this.logMobDropSourceGap(grounded.mobDropGap)
      this.logMobSpawnContext(grounded.mobDropGap)
      this.logCombatKitGap(grounded.combatKitGap)
      this.noteSurfaceAscent(grounded.surfaceAscentRefusal, grounded.candidates)
      this.noteColumnDig(grounded.candidates)
      this.noteFoodHabitat(grounded.foodHabitatRefusal)
      this.logSmeltInputPrereq(state, groundingOptions)
      this.logSmeltRouteGap(state, groundingOptions)
      this.logPrereqStationKnown(state, groundingOptions)
      this.logCraftIngredientPrereq(state, groundingOptions)
      // The gate derives its capability recovery from the withheld retrieves of
      // THIS pass; the mirrored gap must read the same set, or the log would
      // claim `station_already_known` while the offered set contains the very
      // craft that recovers from it.
      this.logCraftStationGap(
        state,
        optionsWithWithheldStationRetirements(groundingOptions, grounded.withheld),
      )
      let candidates = grounded.candidates
      const vtrMission = this.options.vtrMission
      if (vtrMission !== null && vtrMission !== undefined) {
        // Kill-switch (permanent): the V4.1.2 kernel is the sole Reach
        // authority. Mission-source MOVEs are withheld from legacy scheduling
        // unconditionally — a denied/held VTR decision must never fall back
        // into a same-body same-predicate legacy walk, and there is no
        // observer-only production mode that would re-enable it.
        const legacyReachFilter = filterLegacyReachCandidates({
          candidates,
          world: state,
          missionItem: vtrMission.item,
          missionSourceNames: minecraftMissionSourceNames(vtrMission.item),
        })
        if (legacyReachFilter.withheld.length > 0) {
          this.logger.info(
            'vtr',
            `VTR_LEGACY_REACH_MOVE_WITHHELD mission=${vtrMission.id} count=${legacyReachFilter.withheld.length} killSwitch=permanent`,
            { mission: vtrMission, candidates: legacyReachFilter.withheld.map((candidate) => candidate.id), authority: 'v4.1.2-kernel' },
            this.tickCounter,
          )
        }
        candidates = legacyReachFilter.candidates
      }
      // The cross-action bound's consequence runs beside the coordinate failure
      // memory's: a target this action provably cannot progress at is pruned the
      // same mechanical way, which forces the offer onto a different target.
      candidates = this.filterMoveCandidates(candidates, state)
      candidates = this.filterRepeatedOutcomeCandidates(candidates, state)
      // The gate's self-contained craft ladder runs before these controller
      // filters, so a move-failure-memory prune can strip the last productive
      // candidate. Backfill the deterministic craft step for the current craft
      // goal here so an inputs-held craft is never reported as starved.
      candidates = ensureCraftStepActionable(state, candidates, groundingOptions)
      // SAFE: the threat offer. Contact range removes work actions (pre-existing
      // envelope); the bounded danger STATE keeps them removed until the whole
      // envelope has been clear for a sustained interval, so the body does not
      // go back to digging between two hits of the same fight. The result also
      // names the capability gap when code grounds no attack and no
      // keep-distance route, which is mirrored as `THREAT_NO_ESCAPE` - the work
      // set is never silently handed back while a hostile is on the body.
      // #plan-reconciliation: the offer BEFORE the safety envelope, so the
      // not-executable-here binding can tell whether a safety envelope is active
      // (its escape routes must never be withdrawn by the binding below).
      const rawOfferBeforeSafety = candidates
      const threatOffer = applyGroundedThreatRestriction(state, candidates, grounded.withheld)
      candidates = threatOffer.candidates
      this.logThreatOccluded(threatOffer)
      this.logThreatGap(state, threatOffer)
      // The measured DAMAGE RACE, named: at contact, how many grounded keep-distance
      // destinations exist, whether any of them actually leaves the threat's reach,
      // which KIND of source is landing the damage, and the typed capability loss
      // when no escape exists at all. Read from the restricted offer, so the fact is
      // about the escapes the body could really choose this tick.
      this.logSurvivalRace(state, threatOffer)
      candidates = restrictCandidatesAtCriticalHealth(state, candidates)
      // SAFE: while the body is out of breath the offer collapses to the routes
      // that can end the submersion. This is the candidate-side half of the
      // drowning fix; the guard/executor half refuses stale mechanical actions
      // and the scheduler makes the fact able to preempt an in-flight lease.
      candidates = restrictCandidatesDuringSubmersion(state, candidates)
      // SAFE: at critical health with damage still landing, the offer collapses
      // to the routes that can END the damage (measured starvation slide:
      // `food:0`, `damage_taken -> WAIT` forever while ENTER/MOVE stayed on
      // offer). The controller-side half is `observeCriticalDamage`, which
      // proves exhaustion and wakes System2.
      candidates = restrictCandidatesDuringCriticalDamage(state, candidates)
      // SAFE: the bounded answer to an attacker the sensor never placed. The
      // measured end of the fortress-approach runs (`THREAT_RANGED_UNANSWERED
      // threat=ender_dragon distance=null sensed=false` -> `CRITICAL_DAMAGE
      // health=5 source=ender_dragon` -> `DEATH_CAUSE killer=ender_dragon`):
      // every damage state above keys on a SENSED hostile, so an attributed
      // attacker outside perception armed nothing and the offer could collapse
      // to WAIT/ESCALATE - which the executor realizes as "stop and stand still"
      // (`executor.ts` ESCALATE) or 300 ms of doing nothing (WAIT), and which the
      // starvation boundary then turns into an actionless tick (`return` at
      // `noProductiveRepeats >= waitLimit`). While a named attacker is landing
      // hits, the body keeps moving whenever ANY grounded locomotion exists.
      // WHICH route stays Jev's choice; the work actions that would hold it still
      // are what this removes.
      candidates = restrictCandidatesDuringUnseenAttacker(state, candidates)
      // SAFE: while the body stands in fire/lava/burning, work that keeps it
      // there is withheld and only the routes that can leave the hazard stay
      // offered (the grounded escapes, RETREAT/DESCEND, self-care, ESCALATE).
      // Drowning is excluded: `restrictCandidatesDuringSubmersion` above owns
      // that question.
      candidates = restrictCandidatesDuringEnvHazard(state, candidates)
      // #plan-reconciliation: the queue PROVED this head cannot run in the live
      // dimension (`ROW_NOT_EXECUTABLE_HERE`), and the escalation that replaces it
      // is in flight. Measured live (`run-muctsqt6-27ocr`): the offer still carried
      // the row's own descent, so the body kept DESCENDING toward an overworld
      // `levelAtMost y32` predicate while standing in the Nether at hp 10 - the
      // safe verdict and the physical actions disagreed toward the lava. The proof
      // is now binding on the offer: only control/self-care kinds stay, unless a
      // safety envelope is active (which always outranks this binding).
      const notExecutableOffer = restrictCandidatesNotExecutableHere(
        state,
        candidates,
        this.notExecutableHereBinding,
        rawOfferBeforeSafety,
      )
      if (notExecutableOffer.bound) {
        this.logger.warn(
          'agent',
          formatNotExecutableHereBinding(
            this.notExecutableHereBinding as NotExecutableHereBinding,
            notExecutableOffer,
            this.queue.current?.id ?? 'none',
          ),
          {
            goalId: this.notExecutableHereBinding?.goalId ?? null,
            goalKey: this.notExecutableHereBinding?.goalKey ?? null,
            declaredDimension: this.notExecutableHereBinding?.declaredDimension ?? null,
            liveDimension: this.notExecutableHereBinding?.liveDimension ?? null,
            queueReason: this.notExecutableHereBinding?.reason ?? null,
            withheld: notExecutableOffer.withheld.map((candidate) => candidate.id),
            kept: notExecutableOffer.candidates.map((candidate) => candidate.kind),
          },
          this.tickCounter,
        )
      } else if (this.notExecutableHereBinding !== null && notExecutableOffer.reason === 'safety_envelope_active') {
        this.logger.info(
          'agent',
          `ROW_NOT_EXECUTABLE_HERE_BINDING_SKIPPED goalId=${this.notExecutableHereBinding.goalId} reason=safety_envelope_active`,
          {
            goalId: this.notExecutableHereBinding.goalId,
            goalKey: this.notExecutableHereBinding.goalKey,
            reason: notExecutableOffer.reason,
          },
          this.tickCounter,
        )
      }
      candidates = notExecutableOffer.candidates
      // The body must also STOP working the row that cannot run here. An action
      // already in flight would otherwise keep descending while the offer is
      // correct; cancel it once, with typed evidence, unless it is a control or
      // self-care action.
      if (notExecutableOffer.bound) {
        const running = this.executor.current
        if (
          running !== null &&
          running.status === 'running' &&
          isNotExecutableHereWithheldKind(running.kind) &&
          running.id !== this.notExecutableInterruptedActionId &&
          this.notExecutableHereBinding !== null
        ) {
          const binding = this.notExecutableHereBinding
          if (this.executor.cancelCurrent(`row not executable here: ${binding.goalKey} declared=${binding.declaredDimension ?? 'none'} live=${binding.liveDimension ?? 'unknown'}`)) {
            this.notExecutableInterruptedActionId = running.id
            this.logger.warn(
              'agent',
              formatNotExecutableHereInterrupt(binding, running.id, running.kind),
              {
                actionId: running.id,
                actionKind: running.kind,
                goalId: binding.goalId,
                goalKey: binding.goalKey,
                declaredDimension: binding.declaredDimension,
                liveDimension: binding.liveDimension,
              },
              this.tickCounter,
            )
          }
        }
      }
      if (this.options.singleShotPlanner) {
        // With the planner disabled, WAIT and ESCALATE are no-ops that real Jev
        // otherwise keeps re-selecting, starving the queued plan. When a
        // productive action exists, it is the only thing on offer.
        const productive = candidates.filter(
          (candidate) => candidate.kind !== 'WAIT' && candidate.kind !== 'ESCALATE',
        )
        if (productive.length > 0) candidates = productive
      }
      // Issue #45: while a retrieval is active (or right after a stall escalation)
      // WAIT must not win - it is a no-op that would let the loop fall through
      // without closing distance. Suppress it so Jev must pick a productive body
      // change (re-select the retrieval, switch resource, branch-mine, descend).
      const retrievalGoalActive = this.activeRetrieval !== null && this.retrievalTargetExists()
      if (retrievalGoalActive || this.retrievalEscalationPending) {
        const productive = candidates.filter(
          (candidate) => candidate.kind !== 'WAIT' && candidate.kind !== 'ESCALATE',
        )
        if (productive.length > 0) candidates = candidates.filter((candidate) => candidate.kind !== 'WAIT')
      }
      this.retrievalEscalationPending = false
      // Issue #41: while a `descend_to:Y=<n>` predicate goal is active, WAIT is
      // never acceptable - it leaves the bot above the target forever. Suppress it
      // whenever any alternative exists (including ESCALATE), so the policy must
      // pick the staircase / dig-down step or hand control to System 2.
      if (this.queue.current?.kind === 'descend' && candidates.some((candidate) => candidate.kind !== 'WAIT')) {
        candidates = candidates.filter((candidate) => candidate.kind !== 'WAIT')
      }
      // #327 follow-up: an exhausted actionable-WAIT streak removes the no-op for
      // exactly one decision, so the policy must choose a real candidate. This is
      // a control bound on the no-op, never a ranking of the real candidates: it
      // only filters WAIT, and the flag is cleared here.
      if (this.waitSuppressed) {
        this.waitSuppressed = false
        if (candidates.some((candidate) => candidate.kind !== 'WAIT')) {
          candidates = candidates.filter((candidate) => candidate.kind !== 'WAIT')
          this.logger.warn(
            'agent',
            `WAIT_FORCED goal="${this.currentGoalKey()}" reason=wait_streak_exhausted`,
            { goal: this.currentGoalKey() },
            this.tickCounter,
          )
        }
      }
      this.observeDescendProgress(candidates)
      this.lastCandidates = candidates
      this.logCandidates(candidates, state)
      this.logFoodState(candidates, state, groundingOptions)
      this.logLogRoute(candidates)
      this.logFuelSatisfaction(state)

      const actionable = candidates.filter(
        (candidate) => candidate.kind !== 'WAIT' && candidate.kind !== 'ESCALATE',
      ).length
      // #11: Jev owns the action choice, so a set with nothing to choose between
      // is not a decision but a forced move — which makes live behaviour look
      // deterministic no matter how often Jev is invoked. Kept separate from
      // CANDIDATE_STARVATION (that one is about goal progress): a set can be
      // starved yet offer several real choices, and non-starved yet collapse to
      // a single action.
      if (actionable <= 1) {
        this.logger.info(
          'agent',
          `CANDIDATE_SET_DEGENERATE goal=${this.currentGoalKey()} presented=${candidates.length} actionable=${actionable}`,
        )
      }
      const noProductive = actionable === 0 && !state.goal.complete
      this.noProductiveThisTick = noProductive
      if (noProductive) {
        const key = this.noProductiveSignature(state)
        if (key === this.noProductiveKey) this.noProductiveRepeats += 1
        else {
          this.noProductiveKey = key
          this.noProductiveRepeats = 1
        }
        const preconditionCause = this.currentGoalPreconditionCause(state)
        const blockedBy = goalStarvationBlockedBy(preconditionCause, this.queue.current, grounded.withheld)
        const missing = candidateStarvationMissing(grounded.withheld)
        // A smelt goal with no grounded route names its own typed gap in the
        // same evidence the starvation/escalation boundary consumes, so a bare
        // `[WAIT]` set can never be reported without saying WHAT is missing.
        if (this.smeltRouteGapThisTick !== null) {
          const smeltToken = `smelt:${this.smeltRouteGapThisTick.missing}`
          if (!missing.includes(smeltToken)) missing.push(smeltToken)
        }
        // A declared-producer collect goal with no grounded exploration route is
        // the same kind of capability gap: name it in the starvation evidence so
        // the boundary/escalation machinery can act instead of the body pacing.
        if (this.exploreRouteBlockedThisTick !== null) {
          const exploreToken = `explore_route_blocked:${this.exploreRouteBlockedThisTick.reason}`
          if (!missing.includes(exploreToken)) missing.push(exploreToken)
        }
        // A stranded body with no safe descent is the same kind of capability
        // gap: name the geometric no-safe-step fact in the starvation evidence so
        // a WAIT on a 1-wide column can never be reported without its cause.
        if (this.columnDescentRefusalThisTick !== null) {
          const columnToken = `column_descent:${this.columnDescentRefusalThisTick.reason}`
          if (!missing.includes(columnToken)) missing.push(columnToken)
        }
        // A descending body whose exposure dig toward a sensed producer was
        // refused by the world is the same kind of capability gap: the
        // acquisition it is descending FOR has no en-route dig, and the typed
        // cause must reach the starvation/escalation evidence.
        if (this.prospectRefusalThisTick !== null) {
          const prospectToken = `prospect:${this.prospectRefusalThisTick.reason}`
          if (!missing.includes(prospectToken)) missing.push(prospectToken)
        }
        // A travel/enter/retrieve target with no walkable route whose TERRAIN
        // route was refused too is the same kind of capability gap: name the
        // mechanical cause (hazard/unbreakable/no_support/open_floor/protected/
        // no_tool/no_step/spent) in the starvation evidence, so a body sealed in
        // its own shaft can never report `no_productive_action` with no terrain
        // fact (measured run-muc9k936-1f3vb: `presented=2 productive=0
        // missing=["MOVE:...:open_path", ...]` for minutes while the known gate
        // sat 21 blocks away behind ordinary stone).
        for (const refusal of this.digRouteRefusalsThisTick) {
          const digToken = `dig_route:${refusal.reason}`
          if (!missing.includes(digToken)) missing.push(digToken)
        }
        // The typed no-source fact rides the same starvation/escalation evidence
        // so a starvation line never says only `no_productive_action` when the
        // real blocker is "the focus has no source left".
        if (grounded.sourceGap !== null) {
          const sourceToken = `resource:${grounded.sourceGap.item}:${grounded.sourceGap.reason}`
          if (!missing.includes(sourceToken)) missing.push(sourceToken)
        }
        // A body at the hunger floor with no grounded food route names that
        // survival fact in the same evidence: the starvation line can then never
        // say only `no_productive_action` while the body is starving, and the
        // existing bounded escalation boundary sees the missing affordance.
        if (grounded.foodGap !== null) {
          const foodToken = `food_source:${grounded.foodGap.reason}`
          if (!missing.includes(foodToken)) missing.push(foodToken)
        }
        // A starved `place <item>` goal must NAME its typed gap. The live defect
        // reported `missing=[]` for 21 repeats while the agent paced around the
        // destroyed frame, so the blocker stayed invisible to the escalation
        // boundary. The retired-family token is generic: it is the same
        // `PlaceRetryLedger` bound that stopped the `PLACE:furnace:p57_59_-3`
        // loop (count=10 against limit=5, live 2026-09-21T16:30:41.791Z), and a
        // retired furnace family must be as visible as a retired obsidian one.
        const placeGoal = this.queue.current?.kind === 'place' ? this.queue.current : null
        const placeFocus = placeGoal?.targetItem ?? null
        if (placeFocus !== null && this.placementRetries.isItemRetired(placeFocus)) {
          const token = `place_retries_exhausted:${placeFocus}`
          if (!missing.includes(token)) missing.push(token)
        }
        // The frame-specific tokens only apply while the family is still live: a
        // retired obsidian family is already named by the generic token above.
        if (placeFocus === OBSIDIAN && !this.placementRetries.isItemRetired(OBSIDIAN)) {
          if (!frameBuildGrounded(state, OBSIDIAN)) {
            const token = 'portal_frame_site:none'
            if (!missing.includes(token)) missing.push(token)
            // Name WHY every candidate origin was rejected (origin/axis/rule/
            // cell/block) once per distinct starvation signature, so
            // `portal_frame_site:none` is never silent. The explainer re-runs
            // the full origin sweep, so gate it on the first tick of a new
            // signature instead of paying it on every starved tick.
            if (this.noProductiveRepeats === 1) this.logPortalFrameSiteRejection(state)
          } else {
            const gap = frameBuildMaterialGap(state, OBSIDIAN)
            if (gap !== null) {
              const token = `portal_frame_material:${OBSIDIAN}:${gap.held}/${gap.missing}`
              if (!missing.includes(token)) missing.push(token)
            }
          }
        }
        // RESIDENT-LIFETIME NEGATIVE CONSTRAINT (measured portal-p14 36x,
        // portal-p16 x214, portal-p17 x325): the same typed blocker kept
        // exhausting local recovery under DIFFERENT goals
        // (explore<->descend_to<->collect), and each new System2 plan recompiled
        // to the identical unavailable affordance. The ledger carries that
        // causal history forward across goal installs and replans within this
        // resident: a blocker that already exhausted its bounded window at this
        // locality stays named in `missing`
        // with its repeat count, so the next summon sees "this path was tried
        // and failed" instead of one transient blocker string. Appended LAST so
        // persisted history can only fill capacity the live tick did not use.
        // Code owns the CAN-fact; System2 still owns the replacement WHAT.
        for (const entry of this.blockedAffordanceLedger.values()) {
          if (missing.length >= MAX_STARVATION_MISSING) break
          const token = `blocked_affordance:${entry.reason}@${entry.cell}:x${entry.count}`
          if (!missing.includes(token)) missing.push(token)
        }
        this.starvationContext = { blockedBy, missing }
        const starvation = candidateStarvationLine(
          candidates,
          this.currentGoalKey(),
          state.goal.complete,
          blockedBy,
          missing,
        )
        if (starvation !== null) {
          this.logger.warn(
            'agent',
            starvation,
            {
              presented: candidates.length,
              productive: 0,
              goal: this.currentGoalKey(),
              blockedBy,
              missing,
              repeat: this.noProductiveRepeats,
            },
            this.tickCounter,
          )
        }
        this.logger.warn(
          'agent',
          `NO_PRODUCTIVE_CANDIDATE repeat=${this.noProductiveRepeats}/${this.options.waitLimit} goal="${this.currentGoalKey()}" candidates=${candidates.length}`,
          { repeat: this.noProductiveRepeats, goal: this.currentGoalKey(), candidates: candidates.length },
          this.tickCounter,
        )
        if (this.noProductiveRepeats >= this.options.waitLimit) {
          // Record the exhausted episode as durable causal history BEFORE the
          // boundary decision: one occurrence per bounded window, carrying the
          // goal identity it defeated. The next goal that hits the same
          // reason+locality inherits the negative constraint in `missing`.
          // The ledger reason is the TYPED affordance refusal when the tick
          // produced one (`column_descent:no_safe_step`), not the generic
          // `no_productive_action` wrapper - distinct goals that recompile to
          // the same unavailable affordance then collide on one ledger entry.
          const ledgerReason =
            missing.find((token) => token.includes(':') && !token.startsWith('blocked_affordance:')) ?? blockedBy
          const ledgerCell = `${Math.round(state.self.position.x)},${Math.round(state.self.position.y)},${Math.round(state.self.position.z)}`
          const ledgerKey = `${ledgerReason}|${ledgerCell}`
          const ledgerEntry = this.blockedAffordanceLedger.get(ledgerKey)
          if (ledgerEntry === undefined) {
            if (this.blockedAffordanceLedger.size >= JevController.BLOCKED_AFFORDANCE_LEDGER_LIMIT) {
              let oldestKey: string | null = null
              let oldestTick = Number.POSITIVE_INFINITY
              for (const [entryKey, entry] of this.blockedAffordanceLedger) {
                if (entry.lastTick < oldestTick) {
                  oldestTick = entry.lastTick
                  oldestKey = entryKey
                }
              }
              if (oldestKey !== null) this.blockedAffordanceLedger.delete(oldestKey)
            }
            this.blockedAffordanceLedger.set(ledgerKey, {
              reason: ledgerReason,
              cell: ledgerCell,
              goals: new Set(this.queue.current === null ? [] : [this.currentGoalKey()]),
              count: 1,
              lastTick: this.tickCounter,
            })
          } else {
            if (this.queue.current !== null) ledgerEntry.goals.add(this.currentGoalKey())
            ledgerEntry.count += 1
            ledgerEntry.lastTick = this.tickCounter
          }
          const boundary = evaluateCandidateStarvationBoundary({
            activeOption: this.queue.current !== null,
            blockedBy,
            missing,
            semanticExhausted: false,
            semanticInvalid: false,
            semanticAbandoned: false,
            // `noProductiveRepeats` only advances while goal + rounded position
            // + inventory are unchanged (`noProductiveSignature`). Reaching the
            // bounded waitLimit is therefore code-owned proof that local CAN is
            // exhausted, not a hand-written choice of the replacement WHAT.
            localRecoveryExhausted: true,
          })
          if (boundary.wake) {
            this.escalate(
              'all_candidates_invalid',
              `NO_PRODUCTIVE_CANDIDATE repeated ${this.noProductiveRepeats}x; local recovery exhausted on goal "${this.currentGoalKey()}" blocker=${blockedBy}${missing.length > 0 ? ` missing=${JSON.stringify(missing)}` : ''}`,
            )
            // There is literally no executable local action to ask pi to choose.
            // Do not burn another Jev call on WAIT; System2 now owns the next
            // semantic decision (or the replan throttle holds it bounded).
            return
          } else {
            this.logger.warn(
              'agent',
              `LOCAL_CANDIDATE_STARVATION repeat=${this.noProductiveRepeats}/${this.options.waitLimit} system2=false reason=${boundary.reason} goal="${this.currentGoalKey()}" blocker=${blockedBy}`,
              {
                repeat: this.noProductiveRepeats,
                goal: this.currentGoalKey(),
                blocker: blockedBy,
                missing,
                boundary: boundary.reason,
              },
              this.tickCounter,
            )
          }
        }
      } else {
        this.noProductiveRepeats = 0
        this.noProductiveKey = null
        this.starvationContext = null
      }
      // #plan-reconciliation: the bounded SEMANTIC starvation bound.
      //
      // `noProductiveRepeats` only advances while the goal + rounded position +
      // inventory are unchanged (`noProductiveSignature`), so a body that MOVES
      // while producing nothing launders the stall: measured live
      // (`run-mucpugqn-20evo`) the durable head was `g1:descend:raw_iron`
      // (declared dimension `minecraft:overworld`, success `levelAtMost y32`)
      // while the body climbed to y102 in the NETHER, the signature changed on
      // every ascent, the repeat counter never reached `waitLimit`, and
      // `CANDIDATE_STARVATION` repeated unbounded with no System2 request. This
      // bound counts the decisions that presented NO productive candidate for the
      // SAME queue head with zero semantic progress, which body motion cannot
      // reset. It is code-owned evidence about the local CAN envelope - it never
      // chooses the replacement WHAT, it wakes the layer that does.
      // Measured live (`run-mucqgrdo-21plr`): the row alternated MOVE/WAIT, so a
      // NON-starved tick arrived between every starved one, and the previous
      // controller-scoped counter was reset by those ticks (and by every resident
      // reload) - `NO_PRODUCTIVE_HEAD_WINDOW count=1 limit=3` on all seven
      // occurrences and the bound never fired. The count now lives on the durable
      // ROW and is only closed by semantic progress, an explicit reset after it
      // fires, or the head changing (a different row has its own count).
      if (noProductive) {
        const count = this.queue.noteStarvedHead()
        const bound = evaluateStarvedHeadBound({ count, limit: this.options.waitLimit })
        if (bound.action === 'wake') {
          this.queue.resetStarvedHead()
          this.logger.warn(
            'agent',
            `NO_PRODUCTIVE_HEAD_BOUND count=${bound.count}/${bound.limit} goal="${this.currentGoalKey()}" blocker=${this.starvationContext?.blockedBy ?? 'unknown'}${(this.starvationContext?.missing.length ?? 0) > 0 ? ` missing=${JSON.stringify(this.starvationContext?.missing ?? [])}` : ''} -> wake System2`,
            {
              goal: this.currentGoalKey(),
              goalId: this.queue.current?.id ?? null,
              blocker: this.starvationContext?.blockedBy ?? null,
              missing: this.starvationContext?.missing ?? [],
              limit: bound.limit,
              boundary: 'semantic_boundary',
            },
            this.tickCounter,
          )
          this.escalate(
            'all_candidates_invalid',
            `NO_PRODUCTIVE_HEAD_BOUND: ${bound.count} starved decisions (no productive candidate, no semantic progress) on the same queue head "${this.currentGoalKey()}"; blocker=${this.starvationContext?.blockedBy ?? 'unknown'}${(this.starvationContext?.missing.length ?? 0) > 0 ? ` missing=${JSON.stringify(this.starvationContext?.missing ?? [])}` : ''}`,
          )
          return
        }
        if (bound.action === 'window') {
          this.logger.info(
            'agent',
            `NO_PRODUCTIVE_HEAD_WINDOW goal="${this.currentGoalKey()}" count=${bound.count} limit=${bound.limit}`,
            { goal: this.currentGoalKey(), count: bound.count, limit: bound.limit },
            this.tickCounter,
          )
        }
      }

      const planGoal: CausalGoalRef | null = state.goalQueue.current
      const causalStamp = makeCausalStamp({ chainId: makeChainId(), goal: planGoal })

      // SAFE (issue #436 section B): the hard-safety reflex. When the body is in
      // an environmental hazard and exactly ONE route out is grounded, the
      // decision is uniquely determined - deterministic code executes it without
      // spending a model call, and it may interrupt the in-flight skill
      // (SKILL_INTERRUPT). With two or more grounded routes the choice is Jev's
      // WHICH and this returns null, leaving the ordinary offered candidates.
      const reflex = envHazardReflexAction(state, candidates)
      // Read unconditionally: the §17 policy boundary needs to know whether a
      // Skill was in flight even when no reflex fires.
      const inFlightAtReflex = this.inFlight()

      // exception: the plan ran dry -> ask the LLM for the next horizon. A reflex
      // tick is a hard-safety interruption, not a new horizon, so it must not
      // summon the planner on its way out.
      if (reflex === null && this.queue.isEmpty) {
        this.summonLlm('queue_empty', 'goal queue is empty; no long-horizon goal to consume')
      }

      const decision =
        reflex === null
          ? await this.decide(state, candidates, trigger, causalStamp.chainId)
          : this.reflexDecision(reflex.candidate)
      // §3: a model result whose decision epoch was invalidated while the call was
      // in flight cannot authorize anything. The drop is already logged
      // (`STALE_JEV_RESULT_DROPPED`); no commitment may be claimed from it. A
      // deterministic hard-safety reflex never goes through `decide()`, so it
      // cannot set this flag and is never blocked here.
      if (this.staleDecisionDropped) {
        this.staleDecisionDropped = false
        return
      }
      const semantic = this.semanticEscalation(decision)
      const needLlmAdopted = semantic.escalate
      if (needLlmAdopted) {
        this.needLlmDecisions += 1
        this.summonLlm('need_llm', semantic.reason)
      }
      this.logBetaShadow(causalStamp.optionId, decision, needLlmAdopted)

      const rawChosenId = decisionIdFrom(decision) ?? 'WAIT'
      // SAFE: a hard-safety reflex is never held behind a skill lease or a
      // previous model decision - it exists to interrupt them. Both commitment
      // layers are model-decision machinery, so a reflex tick passes them by;
      // the guard below still validates the candidate mechanically.
      // mechanically.
      const committedId = reflex === null ? this.applyCandidateCommitment(rawChosenId, candidates, state) : rawChosenId
      const heldId = reflex === null ? this.applyActionCommitment(committedId, candidates, state) : committedId
      // Keep Jev's danger score as model evidence in the decision record only.
      // It cannot replace pi's selected semantic action. The exact code-owned
      // safety envelope and reflex above already restrict/interrupt choices when
      // grounded Minecraft truth requires it.
      const dangerGate = gateDanger(decision.answers.danger)
      // Re-groundable: a vanished survival action is replaced below by the SAME
      // action kind from the fresh offer (see the guard at the revalidation).
      let chosenId = heldId
      this.noteWaitStreak(chosenId, actionable)
      this.checkWedge(chosenId)

      if (this.criticalArrivedDuringFlight(trigger)) {
        // §3: this is the live "late async model result" case in this
        // architecture - a critical trigger arrived while pi was deciding, so the
        // decision's epoch is invalidated and the result must not authorize.
        const dropped = this.decisionEpochs.invalidate('superseded')
        this.logger.warn(
          'policy',
          dropped === null
            ? `discarding stale decision ${decision.callId}: an incompatible critical trigger arrived during the Jev flight`
            : formatStaleResultDropped(dropped.epoch, null, 'critical_trigger_during_flight'),
          { callId: decision.callId, trigger },
          this.tickCounter,
        )
        return
      }

      if (this.hasCriticalTriggerDuringFlight()) {
        this.logger.info(
          'policy',
          `critical trigger arrived during the Jev flight; revalidating decision ${decision.callId} against fresh state`,
          {},
          this.tickCounter,
        )
      }

      let freshState = buildWorldState(
        this.bot,
        {
          tick: this.tickCounter,
          goal: this.goal,
          goalQueue: this.queue.state,
          currentOption: this.currentOptionContext(),
          recentOutcomes: this.recentOutcomes,
          focusItem: currentFocusItem(this.goal, this.queue.state),
          retrievalItems: this.retrievalProbeItems(),
          recentEvents: this.recentEvents,
          signals: this.signals,
          rememberedStations: this.knownResourcesForSensor(),
          // The contents this body OBSERVED by opening a container. A container
          // with no entry is UNKNOWN - the client has no other contents surface,
          // so absence of an observation must never be read as empty.
          containerContents: this.executor.containerContents(),
        },
        sensorOptions(this.options, this.scheduler.worldRevision),
      )
      freshState = this.mergeRememberedPortalFrame(freshState)
      // The revalidation offer applies the SAME threat envelopes as the
      // decision-time offer (contact range + the published bounded danger
      // state), so a work action cannot slip back in between the Jev answer and
      // execution while a hostile is on the body.
      const freshOptions = candidateOptions(
        this.options,
        this.recipeIndex,
        this.unreachableStationKeys(freshState),
        this.reachabilityGateOptions(),
        this.blacklistedMoveTargets(freshState),
        freshState.portalFrame,
        this.searchedSurfaceTargets,
        this.portalEntryPlan(freshState),
        this.placementRetries.retiredItemSet(),
      )
      const freshGrounded = generateGroundedCandidates(freshState, freshOptions)
      // The revalidation offer must be built the same way the decision-time
      // offer was: the legacy-reach kill switch and the repeated-outcome prune
      // remove the same provably-dead candidates, and the deterministic craft
      // backfill restores the same executable step. Without them the fresh set
      // diverges from the offer Jev answered on identical state - the measured
      // p18 wedge: `CRAFT:oak_planks` vetoed "vanished" on every tick while the
      // backfill kept re-offering it each epoch (741 vetoes in one stall).
      let freshBeforeThreat = [...freshGrounded.candidates]
      const freshVtrMission = this.options.vtrMission
      if (freshVtrMission !== null && freshVtrMission !== undefined) {
        freshBeforeThreat = filterLegacyReachCandidates({
          candidates: freshBeforeThreat,
          world: freshState,
          missionItem: freshVtrMission.item,
          missionSourceNames: minecraftMissionSourceNames(freshVtrMission.item),
        }).candidates
      }
      freshBeforeThreat = this.filterMoveCandidates(freshBeforeThreat, freshState)
      freshBeforeThreat = this.filterRepeatedOutcomeCandidates(freshBeforeThreat, freshState)
      freshBeforeThreat = ensureCraftStepActionable(freshState, freshBeforeThreat, freshOptions)
      const freshThreatOffer = applyGroundedThreatRestriction(freshState, freshBeforeThreat, freshGrounded.withheld)
      const freshCandidates = restrictCandidatesDuringEnvHazard(
        freshState,
        restrictCandidatesDuringUnseenAttacker(
          freshState,
          restrictCandidatesDuringCriticalDamage(
            freshState,
            restrictCandidatesDuringSubmersion(
              freshState,
              restrictCandidatesAtCriticalHealth(freshState, freshThreatOffer.candidates),
            ),
          ),
        ),
      )
      const freshIds = new Set(freshCandidates.map((candidate) => candidate.id))
      if (!freshIds.has(chosenId)) {
        // SAFE: a chosen SURVIVAL action whose id is anchored to volatile sensed
        // truth (an escape cell recomputed around a knocked-back body, a sensed
        // entity that left the sensor) is re-grounded to the SAME action kind
        // from the fresh offer. Measured live (run-muc3qbug-18vg3, first 18 s in
        // the Nether): every retreat Jev chose was dropped here, so the tick
        // returned with NO action while a spider was in melee contact and health
        // went 18 -> 7.5 (630 drops in the run). Rejecting is the correct answer
        // only when nothing grounded survives; it is never correct to leave the
        // body standing in a fight.
        const vanishedChoice = candidates.find((candidate) => candidate.id === chosenId) ?? null
        // The bounded identity-churn facts (`threat.ts` `MobIdentityContext`):
        // whether the previous entity id is still in the client's TRACKED set
        // (`bot.entities` - the server's own destroy notification, NOT the 24 m
        // sensor), which entity ids the DECISION-time snapshot carried, and the
        // two snapshot times. All code-owned; any UNKNOWN refuses the adoption.
        const identityContext = this.mobIdentityContext(vanishedChoice, state, freshState)
        const reground = regroundVanishedSurvivalChoice(vanishedChoice, freshCandidates, identityContext)
        // The bounded CONTROL action executed in place of an unservable survival
        // action (see the in-contact branch below). Never a mutation, never a
        // target choice - it re-enters the semantic decision immediately.
        let controlId: string | null = null
        const threatEvidence = state.signals.threat ?? null
        const body = bodySurvivalFacts(state.self)
        if (reground.candidateId !== null) {
          this.survivalRegrounds += 1
          chosenId = reground.candidateId
          freshIds.add(chosenId)
          this.logger.warn(
            'guard',
            formatSurvivalReground(vanishedChoice?.id ?? chosenId, reground, freshCandidates.length, threatEvidence, body),
            {
              from: vanishedChoice?.id ?? null,
              to: chosenId,
              kind: reground.kind,
              reason: reground.reason,
              freshOffer: freshCandidates.length,
              threat: threatEvidence?.threatName ?? null,
              distance: threatEvidence?.threatDistance ?? null,
              contact: threatEvidence?.inContact ?? false,
              health: body.health,
            },
            this.tickCounter,
          )
          // issue #436 / mob identity churn: the SAME causal threat came back under
          // a new entity id. The typed proof is its own mirrored line, because the
          // `SURVIVAL_REGROUND` line above cannot say WHY two different ids are one
          // threat - and a post-mortem must be able to tell this apart from an
          // ordinary same-id re-ground and from a threat that genuinely died.
          if (reground.identityChurn !== null) {
            const churn = reground.identityChurn
            this.logger.warn(
              'guard',
              formatMobIdentityChurn(vanishedChoice?.id ?? chosenId, churn, threatEvidence, body),
              {
                from: vanishedChoice?.id ?? null,
                to: chosenId,
                fromEntityId: churn.fromEntityId,
                toEntityId: churn.toEntityId,
                mob: churn.name,
                kind: churn.kind,
                moved: Math.round(churn.distance * 100) / 100,
                elapsedMs: Math.round(churn.elapsedMs),
                rule: churn.rule,
                gone: churn.goneEvidence,
                new: churn.newEntity,
                outcome: reground.outcome,
                threat: threatEvidence?.threatName ?? null,
                distance: threatEvidence?.threatDistance ?? null,
                contact: threatEvidence?.inContact ?? false,
                health: body.health,
              },
              this.tickCounter,
            )
          }
        } else {
          this.guardRejections += 1
          if (reground.kind !== null) {
            // issue #436 section 9/14 + #437 section 6: the premise of the Jev
            // answer was destroyed (the exact entity it answered is gone, or no
            // grounded response of that kind survives). The typed outcome is
            // recorded AND the next decision is forced to be a real policy
            // re-entry, so a cached decision cannot be replayed onto a survival
            // action that no longer exists.
            this.skillOutcomeBoundary = true
            this.logger.warn(
              'guard',
              formatSurvivalNoGroundedAction(vanishedChoice?.id ?? chosenId, reground, freshCandidates.length, threatEvidence, body),
              {
                chosenId,
                kind: reground.kind,
                reason: reground.reason,
                outcome: reground.outcome,
                freshOffer: freshCandidates.length,
                threat: threatEvidence?.threatName ?? null,
                distance: threatEvidence?.threatDistance ?? null,
                contact: threatEvidence?.inContact ?? false,
                health: body.health,
              },
              this.tickCounter,
            )
            // SAFE, and the measured death loop (operator report + run log: a
            // wither skeleton at 0.57m, health 4.37, `freshOffer=1`, chosen
            // ATTACK/RETREAT not equivalent -> candidateId=null -> NO action, then
            // DEATH 32): a tick must never end actionless while a hostile is IN
            // CONTACT. The chosen action cannot be served, so execute the grounded
            // CONTROL action the restricted offer already carries
            // (`ESCALATE`/`WAIT`) - it mutates nothing, chooses no fight/flight, and
            // hands the semantic decision up immediately. Code still does not pick
            // a target, a destination or a strategy.
            // The contact envelope filters WAIT and ESCALATE out (they are not
            // combat answers), which left this fallback with nothing to execute and
            // the tick actionless while a reachable ATTACK sat in the offer. The
            // code-owned ESCALATE is therefore still available to the caller: it
            // mutates nothing and chooses no fight/flight, so executing it is
            // strictly better than standing still inside the hit window.
            const codeOwnedEscalate = freshCandidates.some((candidate) => candidate.kind === 'ESCALATE')
              ? null
              : threatEscalateCandidate('no_survival_action_in_contact', state.tick)
            const fallback = survivalControlFallback({
              reground,
              threatInContact: threatEvidence?.inContact === true,
              freshCandidates,
              ...(codeOwnedEscalate === null ? {} : { codeOwnedEscalate }),
            })
            if (fallback.candidateId !== null) {
              controlId = fallback.candidateId
              // Admit the code-owned control action into the revalidation offer
              // BEFORE it is guarded and executed, so the guard sees the same offer
              // the tick will run (it is a control action, not a Jev choice).
              if (codeOwnedEscalate !== null && codeOwnedEscalate.id === fallback.candidateId) {
                freshCandidates.push(codeOwnedEscalate)
                freshIds.add(codeOwnedEscalate.id)
              }
              {
                const control = { id: fallback.candidateId }
                this.logger.warn(
                  'guard',
                  `SURVIVAL_CONTROL_ACTION from=${vanishedChoice?.id ?? chosenId} kind=${reground.kind} outcome=${reground.outcome} ` +
                    `to=${control.id} reason=${fallback.reason} threat=${threatEvidence?.threatName ?? 'unknown'} contact=true health=${Math.round(body.health * 100) / 100} ` +
                    `-> never an actionless tick with a hostile in contact`,
                  {
                    from: vanishedChoice?.id ?? chosenId,
                    to: control.id,
                    fallback: fallback.reason,
                    outcome: reground.outcome,
                    threat: threatEvidence?.threatName ?? null,
                    health: body.health,
                  },
                  this.tickCounter,
                )
              }
            }
          } else {
            this.logger.warn(
              'guard',
              `chosen candidate ${chosenId} vanished between the Jev answer and execution`,
              { chosenId, freshOffer: freshCandidates.length, reground: reground.reason },
              this.tickCounter,
            )
          }
        }
        this.logGuardRejections()
        if (reground.candidateId === null) {
          // A chosen SURVIVAL action that cannot be re-grounded must not end the
          // tick with NO action while a hostile is on the body. Measured live
          // (run-mucg2obc-v75cry): `SURVIVAL_NO_GROUNDED_ACTION chosenId=RETREAT:p23_57_-20
          // reason=no_grounded_equivalent freshOffer=1 threat=wither_skeleton
          // distance=0.57 contact=true health=4.36` - the fresh offer still held a
          // reachable `ATTACK:e23324` on that same wither skeleton, but the
          // vanished RETREAT could not be re-grounded, so the tick did nothing and
          // the body was killed in the same second.
          //
          // Re-asking is the correct repair rather than substituting an action:
          // fight-vs-flight is Jev's WHICH (section 8), so code must not pick the
          // ATTACK itself. `requestDecision` only queues the fresh offer for the
          // NEXT tick (the scheduler's own priority path), so this removes the
          // idle tick without adding a model call inside this one and without
          // choosing anything. A null threat means the situation is no longer a
          // survival one and the ordinary flow owns it.
          if (threatEvidence !== null) {
            this.requestDecision('survival_reground', {
              source: 'survival_reground_failed',
              chosenId: vanishedChoice?.id ?? chosenId,
              reason: reground.reason,
              freshOffer: freshCandidates.length,
            })
          }
        }
        // issue #436 section 9, stronger than a requeue: when a hostile is IN
        // CONTACT and the restricted offer already carries a grounded CONTROL
        // action, EXECUTE it this tick (it mutates nothing and hands the semantic
        // decision up immediately), so "no action while a hostile is on the body"
        // is impossible rather than merely shorter. `survivalControlFallback` is
        // pure and returns null when nothing is offered.
        if (reground.candidateId === null && controlId === null) return
        if (controlId !== null) {
          chosenId = controlId
          freshIds.add(controlId)
        }
      }
      const sharedReachability = this.reachabilityGateOptions()
      const guarded = guardDecision(chosenId, freshCandidates, freshState, {
        phase: 'decision',
        candidateIds: freshIds,
        inFlight: this.inFlight(),
        reach: this.options.reach,
        maxCandidateAgeTicks: this.options.maxCandidateAgeTicks,
        // Candidate grounding and the final guard must consume ONE path fact in
        // this tick. A second GoalBlock search here used to contradict a passing
        // candidate probe and let the same target cycle through again.
        canComputePath: (position) =>
          sharedReachability.pathProbe === undefined || sharedReachability.pathProbe === null
            ? this.canComputePath(position)
            : sharedReachability.pathProbe(position) === 'reachable',
        // The SAME per-tick station-approach fact the candidate layer gates on
        // (`reachabilityGateOptions()` is memoised per tick), so a station the
        // grounding proved reachable through its interaction stand can never be
        // refused here by a probe of the station's own cell.
        stationApproach: sharedReachability.stationApproach ?? null,
      })

      const record = makeDecisionRecord({
        decisionId: randomUUID(),
        tick: this.tickCounter,
        trigger,
        stateHash: stableStateHash(state),
        chainId: causalStamp.chainId,
        optionId: causalStamp.optionId,
        semanticOptionInstanceId: causalStamp.semanticOptionInstanceId,
        strategy: causalStamp.strategy,
        candidates,
        failedCandidates: this.failureSnapshot(),
        jev: this.jevLog(decision, dangerGate, trigger),
        chosenAction: guarded.ok ? guarded.candidate.id : guarded.candidateId,
        confidence: decision.answers.action?.confidence ?? null,
        dangerOverride: null,
        needLlm: null,
        needLlmAdopted,
        goalQueueState: toGoalQueueStateLog(state.goalQueue),
        llmResummon: pickResummon(this.tickResummonLog, needLlmAdopted),
        llm: this.llmLog(),
        subgoal: this.consumeTransition(),
        inventory: state.inventory.counts,
      }, this.options.decisionProvenance)

      if (!guarded.ok) {
        // §8/§17: a reflex the mechanical guard REFUSED is a typed failure, never
        // a silent no-op - the reviewer sees that code tried to stabilise and the
        // guard stopped it, with the guard's own code as the failure reason.
        if (reflex !== null) {
          this.logger.warn(
            'policy',
            formatSkillStep(
              inFlightAtReflex?.id ?? state.currentOption?.templateId ?? this.currentGoalKey(),
              'env_hazard_stabilize',
              formatSkillStepAuthority(
                'HARD_SAFETY_REFLEX',
                formatEnvHazardReflexEvidence(this.envHazard.evidence()),
                'none',
                { budget: 1, failure: `guard_${guarded.code}` },
              ),
            ),
            { authority: 'HARD_SAFETY_REFLEX', action: reflex.candidate.id, failure: `guard_${guarded.code}` },
            this.tickCounter,
          )
          // The decision returns to the semantic controller with the boundary
          // recorded, so a refused stabilisation cannot silently replace the
          // Skill either.
          this.logEnvHazardBoundary(state, candidates, inFlightAtReflex)
        }
        this.onGuardReject(
          guarded,
          decision,
          record,
          freshCandidates.find((candidate) => candidate.id === guarded.candidateId),
        )
        return
      }

      if (guarded.candidate.kind === 'DESCEND') this.logDescendPlan(guarded.candidate)
      // The reflex is logged only once the guard has accepted the candidate, so
      // the line can never claim an action the mechanical checks refused.
      if (reflex !== null) {
        this.logReflex(
          reflex,
          state,
          inFlightAtReflex,
          envHazardEscapeRoutes(state, candidates)
            .filter((route) => route.id !== reflex.candidate.id)
            .map((route) => route.id),
        )
        this.lastEnvBoundaryLine = null
      } else {
        // §8/§17: code is NOT taking over. If a Skill is in flight inside this
        // hazard, record the boundary and the grounded alternatives.
        this.logEnvHazardBoundary(state, candidates, inFlightAtReflex)
      }
      if (guarded.candidate.kind === 'RETRIEVE') this.logRetrievalAction(guarded.candidate)
      if (guarded.candidate.meta.approachLeg !== undefined) this.logApproachLeg(guarded.candidate)
      if (guarded.candidate.meta.digRoute === true) {
        this.logDigRoute(guarded.candidate)
        // #436 section 17 layering: the dig route is a SEPARATE candidate of kind
        // DESCEND (never a contract attached to a MOVE), so it is realized only
        // after Jev selects it - a MECHANICAL_CONTINUATION of the chosen route,
        // never the walk silently gaining dig authority.
        this.logger.info(
          'agent',
          formatSkillStep(
            typeof guarded.candidate.meta.digRouteSkill === 'string' ? guarded.candidate.meta.digRouteSkill : 'DIG_ROUTE(approach)',
            'dig_route',
            formatSkillStepAuthority(
              'MECHANICAL_CONTINUATION',
              `target=${String(guarded.candidate.meta.digRouteTarget ?? 'unknown')} cell=${String(guarded.candidate.meta.digRouteCell ?? 'unknown')} kind=${String(guarded.candidate.meta.digRouteKind ?? 'unknown')}`,
            ),
          ),
          { actionId: guarded.candidate.id },
          this.tickCounter,
        )
      }
      if (guarded.candidate.meta.legContinuation === true) this.logSkillStep(guarded.candidate)
      // The BOUNDED LEVEL SCAN descent (`levelScan.ts`): its own mirrored `LEVEL_SCAN` line
      // plus the §7 layer half, logged only once the guard has accepted the step.
      if (guarded.candidate.meta.levelScan === true) this.logLevelScan(guarded.candidate)
      if (isBridgeMove(guarded.candidate)) this.logBridgeAuthority(guarded.candidate)
      this.checkUnreachableMove(guarded.candidate, state)
      this.rememberMoveTarget(guarded.candidate)

      // issue #436 section 4: the claimed candidate carries the provenance the
      // commitment/evidence layer needs - the decision epoch that authorized it,
      // the decision id, the semantic Option instance, the state fingerprint, the
      // world epoch and WHO selected it. Additive meta only; the id is untouched.
      const stampedCandidate = this.stampSelectionProvenance(guarded.candidate, decision, record)
      // Scheduler-directed supersession: a different running controller action
      // is cancelled AND its kernel transition closed BEFORE the replacement is
      // admitted. The replacement then acquires its resource bundle from a
      // kernel that no longer holds the incumbent's leases; nothing is ever
      // silently stolen by a claim.
      this.transitions.supersedeRunning(stampedCandidate.id, `superseded by controller selection ${stampedCandidate.id}`)
      // V4.1.2: the executor may only run a mechanical leg under a
      // kernel-admitted transition contract. A kernel denial is terminal for
      // this dispatch - there is no legacy actuation path to fall back to.
      const admission = this.transitions.admit(stampedCandidate, freshState.self.dimension)
      if (admission === null) return
      let claim: ReturnType<Executor['claim']>
      try {
        claim = this.executor.claim(stampedCandidate, {
          liveStructureMembers: freshState.liveStructureMembers ?? [],
          ...this.transitions.claimProvenance(admission),
        })
      } catch (error) {
        // A freshly admitted transition whose claim never started must not
        // hold its resource bundle: close it before propagating.
        if (!admission.reused) {
          this.transitions.close(admission, 'ACTION_FAILED', `claim-failed:${error instanceof Error ? error.message : String(error)}`)
        }
        throw error
      }
      if (!claim.kept) this.actionStart = this.bot.entity.position.clone()
      if (claim.kept) {
        this.logger.info(
          'executor',
          `ownership retained by action#${claim.epoch} ${guarded.candidate.id}`,
          { trigger },
          this.tickCounter,
        )
        this.decisionWriter.write(record)
        return
      }
      this.pendingDecisions.set(claim.epoch, { record, healthAtDecision: this.bot.health })
      // Every admitted transition has exactly one terminalizer - the
      // completion of the claim it authorized - attached before any further
      // fallible step so no early return can orphan the kernel transition.
      void claim.completion
        .then((result) => {
          const truth = this.onActionComplete(result, decision, guarded.candidate)
          this.transitions.terminalize(admission, result, truth)
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          this.logger.error('agent', `action completion handler failed: ${message}`, {}, this.tickCounter)
          this.transitions.close(admission, 'ACTION_FAILED', `completion-handler-failed:${message}`)
        })
      // §3: bind the action lease to the decision epoch that authorized it, so
      // the outcome packet names the epoch/commitment it closes instead of
      // guessing after the fact. A lease claimed when no epoch is active (bootstrap
      // / pre-#437 path) simply carries no binding.
      const authorizing = this.decisionEpochs.active
      if (authorizing !== null) {
        const identity =
          this.lastSemanticProjection?.candidates.find((view) => view.id === guarded.candidate.id)?.identity ??
          guarded.candidate.id
        // issue #436 Phase 1: the commitment the EXECUTOR built for this lease is
        // the authority object. Its real id and contract hashes replace the
        // placeholder lease ref, so `SKILL_COMMIT` and the later
        // `SKILL_OUTCOME_PACKET` name the same identity (section 4).
        const commitment = this.executor.current?.commitment ?? null
        const commitmentId =
          commitment?.commitmentId ?? commitmentRefFor({ candidateId: guarded.candidate.id, epoch: claim.epoch })
        // §3: `authorize` re-checks that this epoch is still ACTIVE. A lease that
        // arrives after the epoch was superseded/invalidated is NOT committed and
        // is logged as a dropped stale result instead of silently acting.
        const verdict = this.decisionEpochs.authorize({
          epoch: authorizing.epoch,
          commitmentId,
          selectedIdentity: identity,
        })
        if (!verdict.accepted) {
          this.logger.warn(
            'policy',
            formatStaleResultDropped(authorizing.epoch, this.decisionEpochs.active?.epoch ?? null, verdict.reason),
            { candidateId: guarded.candidate.id, leaseEpoch: claim.epoch },
            this.tickCounter,
          )
          // A stale epoch must not keep acting: cancel the claim it produced.
          // Its completion handler (attached above) closes the transition.
          this.executor.cancelCurrent(`stale decision epoch ${authorizing.epoch}: ${verdict.reason}`)
          return
        }
        this.actionEpochByLease.set(claim.epoch, { epoch: authorizing.epoch, commitmentId, identity })
        // §12: the commitment is what makes the Skill allowed to act. One line
        // joins it to the decision epoch and to the packet that later closes it.
        this.logger.info(
          'policy',
          formatSkillCommit({
            epoch: authorizing.epoch,
            commitmentId,
            leaseEpoch: claim.epoch,
            candidateId: guarded.candidate.id,
            selectedIdentity: identity,
            skillKind: commitment?.skillKind ?? guarded.candidate.kind,
            projectionHash: authorizing.projectionHash,
            // section 17: the declared contract this selection authorized.
            targetIdentity: commitment === null ? null : targetIdentityKey(commitment.target),
            postconditionHash: commitment === null ? null : postconditionHash(commitment.expectedPostconditions),
            effectEnvelopeHash: commitment === null ? null : effectEnvelopeHash(commitment.allowedEffects),
            selectedBy: commitment?.selectedBy ?? null,
            budgetMs: commitment?.budget.ms ?? null,
          }),
          { trigger, leaseEpoch: claim.epoch },
          this.tickCounter,
        )
      }
    } catch (error) {
      if (error instanceof ModelRecoveryRequested) return
      const message = error instanceof Error ? error.message : String(error)
      if (error instanceof ActionCancelled) {
        this.logger.info('agent', `tick aborted: ${message}`, {}, this.tickCounter)
      } else {
        this.logger.error('agent', `tick error: ${message}`, {}, this.tickCounter)
        this.recordFailure('unknown_event', message)
      }
    } finally {
      this.ticking = false
      this.drainPending()
      if (this.modelRecoveryReachDrainPending && this.modelRecoveryReachDrainTransitionId !== null) {
        const transitionId = this.modelRecoveryReachDrainTransitionId
        this.modelRecoveryReachDrainPending = false
        setImmediate(() => void this.advanceModelRecoveryReachDrain(transitionId, 'scheduler-turn-settled'))
      }
    }
  }

  private jevLog(decision: JevResult, dangerGate: GatedScore, trigger: DecisionTrigger): DecisionJevLog {
    return epochs.jevLog(this.epochsHost, decision, dangerGate, trigger)
  }

  /**
   * The one gate between the beta vote and a replan. `adopt` is the controller's
   * ACTUAL decision: with `betaAuthority: false` (default) it is always false,
   * so a β=1 cannot discard a prerequisite (#22/#55).
   */
  private betaDecision(decision: JevResult): BetaAuthorityDecision {
    return abandonlifecycle.betaDecision(this.abandonLifecycleHost, decision)
  }

  private logHeads(result: JevResult, verdict: AbandonVerdict, chainId: string | null = null): void {
    return queueplane.logHeads(this.queueHost, result, verdict, chainId)
  }

  /**
   * #plan-reconciliation: reconcile the durable queue's plan/objective identity
   * against the live one, once per tick.
   *
   * The measured blocker (m3-live): a durable row authored by an M2-era
   * exploration plan (declared overworld, `levelAtMost y32`) held the queue head
   * while the objective had moved to M3/blaze_rods and the body was in the
   * Nether. Nothing compared the two: the row's own predicate was genuinely
   * unsatisfied, so predicate retirement left it (correctly), and every other
   * boundary asked only about the ROW's own condition. This is the comparison.
   *
   * Retirement uses the resident-injected code-owned proof only. A superseded row
   * without a proof is KEPT and reported (`kept`), because "the plan that
   * authored me is gone" is not by itself obsolescence - the current objective
   * may still want the same work. The preferred repair is the System2 re-plan
   * request below: WHAT stays with the model.
   */
  private reconcilePlanIdentity(): void {
    return queueplane.reconcilePlanIdentity(this.queueHost)
  }

  /**
   * #plan-reconciliation: the bounded cross-dimension head reconciliation.
   *
   * A head row that declares a dimension the body is not in cannot execute HERE
   * AND NOW. It is NOT marked impossible (it may be legitimate work scheduled for
   * the other side) and it is NOT reordered by preference: only a BOUNDED demotion
   * behind a row that IS executable in the live dimension is allowed, and with no
   * such row the fact becomes a typed System2 request instead of an unbounded
   * `CANDIDATE_STARVATION`/ascent loop.
   */
  private reconcileHeadDimension(): void {
    return queueplane.reconcileHeadDimension(this.queueHost)
  }

  /**
   * The dedupe counter for ROW_NOT_EXECUTABLE_HERE is carried on the ONE line the
   * next changed fact emits, so suppressing the repeats never loses the count.
   */
  private resetNotExecutableDedupe(): void {
    return stall.resetNotExecutableDedupe(this.stallHost)
  }

  /**
   * #nonprogress-yield: the controller half of the bounded optional-head yield.
   * It supplies the two facts the queue cannot see - the code-owned critical
   * survival predicate (a starving low-health body still prioritises food) and
   * the goal key for the typed marker - and never selects WHAT runs next: the
   * plan's own order does, and System2 still owns the repair.
   */
  private reconcileNonProgressingOptionalHead(): void {
    return queueplane.reconcileNonProgressingOptionalHead(this.queueHost)
  }

  /** Bounded in-memory evidence feed consumed by the decision policy. */
  private pushPolicyEvidence(event: string): void {
    this.recentEvents.push(event)
    if (this.recentEvents.length > 128) {
      this.recentEvents.splice(0, this.recentEvents.length - 128)
    }
  }

  /**
   * A beta vote is semantic, but a control tick, a local route miss, or recent
   * body/search progress is not semantic abandonment. Keep this boundary pure
   * and auditable; it never selects the next Option.
   *
   * The pure gate cannot distinguish ONE control tick from a STARVED plan whose
   * only action is WAIT: in both cases `decisionActionId` is WAIT, so the gate
   * returns `control_action` and refuses to cross the lifecycle boundary. Left
   * unbounded that is circular — WAIT suppresses the abandon, and suppressing
   * the abandon keeps WAIT (live d428d1c, `attempts=74`,
   * `CANDIDATE_STARVATION presented=1 productive=0`). The controller therefore
   * bounds the DEFERRAL here: N consecutive deferrals for the same
   * `(plan, action, reason)` release beta's own vote instead of suppressing it
   * again. Verified progress resets the streak, so a genuinely productive
   * in-flight action keeps its deferral; this never selects an Option.
   *
   * #360 §11: a state-recurring body-only loop is NOT "one action that failed"
   * and NOT "recent body progress" in the semantic sense. When the code-owned
   * recurrence evidence proves exhaustion, that is a semantic boundary and it
   * must outrank the body-progress deferral, otherwise the deferral resets on
   * every successful MOVE and the Option survives forever. The evidence is
   * consumed here (the next window on the same Option must be twice as long);
   * this still never selects WHAT comes next.
   */
  private betaTerminationBoundary(decision: JevResult, optionId: string | null): BetaTerminationBoundaryDecision {
    return abandonlifecycle.betaTerminationBoundary(this.abandonLifecycleHost, decision, optionId)
  }

  /**
   * #79: decide what to do with one abandon request. Uses the per-option
   * attempt counter, so a SPECULATIVE request (attempts < limit) is suppressible
   * in shadow mode while a DEMONSTRABLY UNPRODUCTIVE one (attempts >= limit with
   * verified=false && progress=0) is enforced regardless of `betaAuthority`.
   */
  private abandonVerdict(decision: JevResult, optionId: string | null, planId: string | null): AbandonVerdict {
    const baseline = abandonlifecycle.abandonVerdict(this.abandonLifecycleHost, decision, optionId, planId)
    if (optionId === null) return baseline

    const boundary = this.betaTerminationBoundary(decision, optionId)
    if (abandonRequested(decision) && !boundary.adopt) {
      const probability = decision.answers.abandon_option?.probability ?? null
      this.logger.warn(
        'heads',
        `BETA_DEFERRED option=${optionId} reason=${boundary.reason} beta=${probability}`,
        { optionId, planId, beta: probability, reason: boundary.reason, action: decision.answers.action?.value ?? null },
        this.tickCounter,
      )
      return {
        ...baseline,
        adopt: false,
        enforced: false,
        suppressed: true,
        vote: { ...baseline.vote, adopt: false },
      }
    }

    // Semantic termination has one owner: the decision policy vote plus
    // code-owned exhaustion proof. The baseline verdict's attempt counts,
    // protection ladder and enforced/suppressed classification cannot alter
    // the live decision; deterministic completion/hard invalidity still live
    // outside beta in the queue/guard/VERIFY path. `semanticExhausted` may
    // cross the boundary even when beta's own probability stayed below
    // threshold — it only ENDS the Option and hands off to System2.
    const semanticExhausted = this.signals.strategicNonProgress?.exhausted === true
    const adopt = (abandonRequested(decision) || semanticExhausted) && boundary.adopt
    return {
      ...baseline,
      adopt,
      enforced: false,
      suppressed: false,
      vote: { ...baseline.vote, adopt },
    }
  }

  private applyAbandon(result: JevResult, verdict: AbandonVerdict): boolean {
    return abandonlifecycle.applyAbandon(this.abandonLifecycleHost, result, verdict)
  }

  /**
   * #79: retire the unproductive option and hand the planning boundary to
   * System2. The abandoned option stays retired for this goal key; the next
   * decision still sees every grounded alternative plus failure history.
   */
  private enforceUnproductiveAbandon(
    optionId: string,
    planId: string | null,
    attempts: number,
    probability: number | null,
  ): void {
    return abandonlifecycle.enforceUnproductiveAbandon(this.abandonLifecycleHost, optionId, planId, attempts, probability)
  }

  /** Why beta/controller chose abandon, from the deterministic failure signals. */
  private abandonReason(actionId: string, beta: number | null): AbandonReason {
    return abandonlifecycle.abandonReason(this.abandonLifecycleHost, actionId, beta)
  }

  /**
   * #22: record what beta WOULD have decided next to the controller's actual
   * replan behavior. `actual` is the controller's own decision: it includes
   * beta only when `betaAuthority` is on and the guard cleared it; otherwise it
   * reflects the deterministic reasons (queue_empty, semantic escalation, ...).
   */
  private logBetaShadow(optionId: string | null, decision: JevResult, actualReplanAdopted: boolean): void {
    return abandonlifecycle.logBetaShadow(this.abandonLifecycleHost, optionId, decision, actualReplanAdopted)
  }

  /**
   * Demoted semantic questions: computed by code, logged, never steering (#11).
   * #360 §9: the live run logged one identical row 2148/2148 times because
   * `goal_progress` read the legacy item-count fraction (`state.goal.progress`
   * was 1 for a `surface` plan that already held its 1 log while y stayed 67) and
   * the other three read `escalationRecommended`, which this loop never set. The
   * pure computation now reads the active plan's completion and the code-owned
   * recurrence evidence; see `shadowMetrics.ts` for the full trace.
   */
  private shadowMetrics(state: WorldState): Record<string, number> {
    return computeShadowMetrics({
      goal: { progress: state.goal.progress, complete: state.goal.complete },
      goalQueue: { empty: state.goalQueue.empty },
      signals: {
        escalationRecommended: state.signals.escalationRecommended,
        strategicNonProgress: state.signals.strategicNonProgress ?? null,
      },
    })
  }

  private logShadowMetrics(state: WorldState): void {
    this.logger.info('shadow', `SHADOW_METRICS ${JSON.stringify(this.shadowMetrics(state))}`, this.shadowMetrics(state), this.tickCounter)
  }

  private semanticEscalation(_decision: JevResult): { escalate: boolean; reason: string } {
    // should_retreat is local safety/recovery evidence. Guard/policy can
    // retreat; it is not itself a request for a different long-horizon WHAT.
    return { escalate: false, reason: 'local safety/recovery remains Jev pi + deterministic guard' }
  }

  private placeRetryExhausted(): boolean {
    return abandonlifecycle.placeRetryExhausted(this.abandonLifecycleHost)
  }

  /**
   * The live breath reading, used by the ATTACK-lease safety exception. The
   * scheduler owns the `low_air` preempt and the sensor owns `SelfState.air`;
   * this is only the controller's view of the same fact for the interrupt
   * decision. A version that never reports `oxygenLevel` leaves air unknown.
   */
  private liveAir(): number | null {
    return observedAir((this.bot as { oxygenLevel?: number }).oxygenLevel)
  }

  /** Unfinished goals in plan order; the protection guard spans the whole plan. */
  private unfinishedGoals(): QueuedGoal[] {
    return queueplane.unfinishedGoals(this.queueHost)
  }

  /**
   * #11 v2 §6/§7 semantic fingerprint of the WORLD the controller is deciding
   * against: rounded body position, inventory, remembered stations, sensed
   * furnaces and the current goal row. Deliberately excludes the tick counter,
   * wall clock and controller memory (failure counters), so a failed-but-
   * unchanged world keeps a recorded abandonment valid while an actual
   * world/inventory/topology change clears it.
   */
  private stateFingerprint(state: WorldState): string {
    return stall.stateFingerprint(this.stallHost, state)
  }

  /**
   * #11 v2 §6: protection and abandonment are mutually exclusive under one
   * fingerprint. When the guard still claims a protected option that the
   * abandonment ledger retired for the same fingerprint, the fact wins, the
   * contradiction is surfaced with the mirrored marker, and protection is off.
   */
  private logProtectionAbandonConflict(option: string, abandonedReason: string, reason: string): void {
    return abandonlifecycle.logProtectionAbandonConflict(this.abandonLifecycleHost, option, abandonedReason, reason)
  }

  /**
   * Record a deterministic abandonment under the current fingerprint. If the
   * precondition guard would still protect the same option right now, the
   * contradiction is emitted once (the live defect A sequence).
   */
  private markOptionAbandoned(optionId: string | null, reason: string): void {
    return abandonlifecycle.markOptionAbandoned(this.abandonLifecycleHost, optionId, reason)
  }

  private applyCandidateCommitment(
    chosenId: string,
    candidates: readonly Candidate[],
    state: WorldState,
  ): string {
    return epochs.applyCandidateCommitment(this.epochsHost, chosenId, candidates, state)
  }

  private candidateCommitCost(candidate: Candidate, index: number): number {
    return epochs.candidateCommitCost(this.epochsHost, candidate, index)
  }

  private deterministicInvalid(candidates: readonly Candidate[], state: WorldState): ReadonlySet<string> {
    return epochs.deterministicInvalid(this.epochsHost, candidates, state)
  }

  private applyActionCommitment(
    chosenId: string,
    candidates: readonly Candidate[],
    state: WorldState,
  ): string {
    return epochs.applyActionCommitment(this.epochsHost, chosenId, candidates, state)
  }

  private actionCommitmentPlanKey(state: WorldState): string {
    return epochs.actionCommitmentPlanKey(this.epochsHost, state)
  }

  private noteWaitStreak(chosenId: string, actionable: number): void {
    return epochs.noteWaitStreak(this.epochsHost, chosenId, actionable)
  }

  /** OutcomeAccountingHost calls this through host.: keep the delegate, not just the plane fn. */
  private schedulePlaceRetry(result: ExecutionResult, candidate: Candidate): boolean {
    return epochs.schedulePlaceRetry(this.epochsHost, result, candidate)
  }

  private criticalArrivedDuringFlight(trigger: DecisionTrigger): boolean {
    return epochs.criticalArrivedDuringFlight(this.epochsHost, trigger)
  }

  private hasCriticalTriggerDuringFlight(): boolean {
    return epochs.hasCriticalTriggerDuringFlight(this.epochsHost)
  }

  private async decide(
    state: WorldState,
    candidates: readonly Candidate[],
    trigger: DecisionTrigger,
    chainId: string,
  ): Promise<JevResult> {
    return epochs.decide(this.epochsHost, state, candidates, trigger, chainId)
  }

  private logBoundary(
    epoch: ReturnType<JevDecisionEpochs['begin']>,
    reason: string,
    projection: JevSemanticProjection,
    hash: string,
    views: readonly SemanticCandidateView[],
    trigger: DecisionTrigger,
    sinceLastCallMs: number | null,
  ): void {
    return epochs.logBoundary(this.epochsHost, epoch, reason, projection, hash, views, trigger, sinceLastCallMs)
  }

  private logEpochSuperseded(previous: DecisionEpoch | null): void {
    return epochs.logEpochSuperseded(this.epochsHost, previous)
  }

  private repointReplay(result: JevResult, views: readonly SemanticCandidateView[]): JevResult | null {
    return epochs.repointReplay(this.epochsHost, result, views)
  }

  /**
   * §7: the previous selection and how it ended, carried causally into the next
   * projection. `identity` comes from the projection Jev last saw, so the
   * semantic identity survives even when the mechanical realization id changed.
   */
  private previousDecisionFacts(): PreviousDecisionFacts | null {
    return queueplane.previousDecisionFacts(this.queueHost)
  }

  /**
   * §5: grounded world facts relevant to the current Option, keyed by semantic
   * identity so a resource's cell never becomes a churn fact.
   */
  private semanticFacts(state: WorldState): GroundedFact[] {
    return system2plane.semanticFacts(this.system2Host, state)
  }

  /**
   * §5/§7/§9: build the bounded semantic projection Jev sees. Meaningful deltas
   * only (no tick, no raw body position, no path nodes, no swing counts), with
   * the previous selection + its terminal outcome carried causally.
   */
  private buildSemanticProjection(
    state: WorldState,
    candidates: readonly Candidate[],
    mergedCandidates: number,
  ): JevSemanticProjection {
    return system2plane.buildSemanticProjection(this.system2Host, state, candidates, mergedCandidates)
  }

  /** OutcomeAccountingHost calls this through host.: keep the delegate, not just the plane fn. */
  private emitSkillOutcomePacket(input: {
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
  }): SkillOutcomePacket {
    return epochs.emitSkillOutcomePacket(this.epochsHost, input)
  }

  private onGuardReject(
    guarded: Extract<GuardResult, { ok: false }>,
    decision: JevResult,
    record: DecisionRecord,
    candidate: Candidate | undefined,
  ): void {
    return epochs.onGuardReject(this.epochsHost, guarded, decision, record, candidate)
  }

  private chargeGuardRejection(record: DecisionRecord, code: GuardCode): void {
    return epochs.chargeGuardRejection(this.epochsHost, record, code)
  }

  private stampSelectionProvenance(candidate: Candidate, decision: JevResult, record: DecisionRecord): Candidate {
    return epochs.stampSelectionProvenance(this.epochsHost, candidate, decision, record)
  }

  private cancelInvalidCommitment(state: WorldState): void {
    return epochs.cancelInvalidCommitment(this.epochsHost, state)
  }

  private onActionComplete(result: ExecutionResult, decision: JevResult, candidate: Candidate): TruthfulOutcome {
    return outcome.onActionComplete(this.outcomeHost, result, decision, candidate)
  }

  private onUnverifiedAction(result: ExecutionResult, postcondition: string, pending: PendingDecision | undefined): void {
    const planId = pending?.record?.goalQueueState?.current?.id ?? this.queue.current?.id ?? null
    const strategy = pending?.record?.strategy ?? null
    const key = planId ?? result.actionId
    const attempts = (this.actionUnverified.get(key) ?? 0) + 1
    this.actionUnverified.set(key, attempts)
    this.noteCandidateFailure(result.actionId)

    // Keep the full postcondition failure as bounded policy evidence. No
    // retry-budget semantic controller, no abandon-by-count, no prerequisite
    // path switch, no System2 summon from a magic number. The decision policy
    // sees this evidence and owns termination.
    const marker = formatActionUnverified({
      planId,
      actionId: result.actionId,
      strategy,
      postcondition,
    })
    this.pushPolicyEvidence(
      `action unverified: ${result.actionId}; postcondition=${postcondition}; attempts=${attempts}`,
    )
    this.logger.warn(
      'agent',
      `${marker} authority=jev_pi_beta`,
      {
        planId,
        actionId: result.actionId,
        strategy,
        attempts,
        postcondition,
        progressDelta: result.itemsGained,
        detail: result.detail,
      },
      this.tickCounter,
    )
  }

  private onRetrievalDescent(candidate: Candidate): void {
    return outcome.onRetrievalDescent(this.outcomeHost, candidate)
  }

  private syncTerrainSignals(state: WorldState): void {
    return stall.syncTerrainSignals(this.stallHost, state)
  }

  private sampleMovement(position: Vec3Json): void {
    return stall.sampleMovement(this.stallHost, position)
  }

  private oscillationSignature(): string {
    return `${this.currentGoalKey()}|${JSON.stringify(this.inventorySnapshot())}`
  }

  /**
   * #78: detect the same position pair repeating with no inventory/goal change
   * and take the escape action (drop the retrieval, abandon the world station,
   * escalate) instead of walking between two cells forever.
   */
  private detectOscillation(position: Vec3Json): void {
    return stall.detectOscillation(this.stallHost, position)
  }

  private escapeOscillation(_state: OscillationState): void {
    // Oscillation is an observation. No auto-abandon of a retrieval, no
    // prerequisite route switch, no System2 wake. Expose it to the policy.
    this.oscillationState = null
    if (this.lastDecisionId !== null) {
      this.noteCandidateFailure(this.lastDecisionId)
    }
    this.pushPolicyEvidence('oscillation detected; semantic authority=jev_pi_beta')
  }

  /**
   * An APPROACH_LEG candidate: the remembered target's own route proved zero
   * observable change, so the generator offers a travel leg that changes the
   * stand cell (a grounded MOVE toward the target) instead of re-issuing the same
   * action. Logged when Jev actually selects it, so the marker means "this body
   * is now walking the approach", not "a leg existed".
   */
  private logApproachLeg(candidate: Candidate): void {
    return diagnostics.logApproachLeg(this.diagnosticsHost, candidate)
  }
  private logBridgeRefusals(offered: readonly Candidate[], withheld: readonly Candidate[]): void {
    return diagnostics.logBridgeRefusals(this.diagnosticsHost, offered, withheld)
  }
  private logBridgeAuthority(candidate: Candidate): void {
    return diagnostics.logBridgeAuthority(this.diagnosticsHost, candidate)
  }
  private logSkillPolicyBoundaries(offered: readonly Candidate[], withheld: readonly Candidate[]): void {
    return diagnostics.logSkillPolicyBoundaries(this.diagnosticsHost, offered, withheld)
  }
  private logLegReflexes(offered: readonly Candidate[], withheld: readonly Candidate[]): void {
    return diagnostics.logLegReflexes(this.diagnosticsHost, offered, withheld)
  }
  private logSkillStep(candidate: Candidate): void {
    return diagnostics.logSkillStep(this.diagnosticsHost, candidate)
  }
  private logLevelScan(candidate: Candidate): void {
    return diagnostics.logLevelScan(this.diagnosticsHost, candidate)
  }
  private logLevelScanStep(result: ExecutionResult, candidate: Candidate): void {
    return diagnostics.logLevelScanStep(this.diagnosticsHost, result, candidate)
  }
  private logDigRoute(candidate: Candidate): void {
    return diagnostics.logDigRoute(this.diagnosticsHost, candidate)
  }
  private logDigRouteProgress(result: ExecutionResult, candidate: Candidate): void {
    return diagnostics.logDigRouteProgress(this.diagnosticsHost, result, candidate)
  }
  private logDigRouteRefusals(refusals: readonly DigRouteRefusal[]): void {
    return diagnostics.logDigRouteRefusals(this.diagnosticsHost, refusals)
  }
  private logDescendPlan(candidate: Candidate): void {
    return diagnostics.logDescendPlan(this.diagnosticsHost, candidate)
  }
  private onDescendComplete(result: ExecutionResult, candidate: Candidate): void {
    return outcome.onDescendComplete(this.outcomeHost, result, candidate)
  }

  // -------------------------------------------------------------------------
  // long-horizon layer (System 2 / the goal queue)
  // -------------------------------------------------------------------------

  private objectiveState(): System2Objective {
    return goalstate.objectiveState(this.goalStateHost)
  }

  /**
   * Consume the queue against the live world: `collect` and `craft` goals are
   * inventory-counted and advance the queue when met. The transition is recorded
   * with the trigger that caused it, so every subgoal change is tied to a Jev
   * decision. A goal kind the PoC cannot execute is an exception that re-summons
   * System 2 (suppressed in single-shot mode).
   */
  private syncQueue(trigger: DecisionTrigger): void {
    return queueplane.syncQueue(this.queueHost, trigger)
  }

  private predicateSnapshot(): { position: Vec3Json | null; dimension: string | null } {
    return goalstate.predicateSnapshot(this.goalStateHost)
  }

  private evaluateDescendGoal(goal: QueuedGoal): PredicateEvaluation | null {
    return goalstate.evaluateDescendGoal(this.goalStateHost, goal)
  }

  /**
   * World truth for the portal predicate. `nether_portal` is not an inventory
   * item, and a prior queue record must never make an unlit frame look done.
   * Re-sense the frame and require every live interior cell to be a portal.
   */
  private portalLitTruth(goal: QueuedGoal): boolean {
    return portal.portalLitTruth(this.portalHost, goal)
  }
  private portalEntryPlan(state: WorldState): PortalEntryPlan | null {
    return portal.portalEntryPlan(this.portalHost, state)
  }
  private logEntryUnverified(plan: PortalEntryPlan | null): void {
    return portal.logEntryUnverified(this.portalHost, plan)
  }
  private portalEnteredTruth(goal: QueuedGoal): boolean {
    return portal.portalEnteredTruth(this.portalHost, goal)
  }
  private logEntryRefusal(refusal: PortalEntryRefusal | null): void {
    return portal.logEntryRefusal(this.portalHost, refusal)
  }
  private noteRouteExhaustion(refusal: PortalEntryRefusal | null): void {
    return portal.noteRouteExhaustion(this.portalHost, refusal)
  }
  private effectiveHave(): number {
    return goalstate.effectiveHave(this.goalStateHost)
  }

  private syncGoalToQueue(): void {
    return queueplane.syncGoalToQueue(this.queueHost)
  }

  private consumeTransition(): DecisionSubgoalLog | null {
    return queueplane.consumeTransition(this.queueHost)
  }

  private llmLog(): DecisionLlmLog {
    return { called: this.tickLlmCalls > 0, runtimeCalls: this.runtimeLlmCalls, planCalls: this.planCalls }
  }

  private countItem(name: string): number {
    return goalstate.countItem(this.goalStateHost, name)
  }

  private inventorySnapshot(): Record<string, number> {
    return goalstate.inventorySnapshot(this.goalStateHost)
  }

  private currentGoalPreconditionCause(state: WorldState): string | null {
    const current = this.queue.state.current
    if (current === null) return null
    return goalPreconditionCause(queuedToPlanned(current), this.optionSnapshot(state))
  }

  private semanticOptionSnapshot(): OptionWorldSnapshot {
    return system2plane.semanticOptionSnapshot(this.system2Host)
  }

  private optionSnapshot(state: WorldState): OptionWorldSnapshot {
    return goalstate.optionSnapshot(this.goalStateHost, state)
  }

  /**
   * The OptionSpec preconditions a queue goal is checked against, built before
   * the tick's `WorldState` exists. Only inventory and station names are read by
   * the smelt item preconditions `staleOreDescend` inspects.
   */
  private queuePreconditionSnapshot(): OptionWorldSnapshot {
    return goalstate.queuePreconditionSnapshot(this.goalStateHost)
  }

  /**
   * Wire the resident-injected #prereq-dominated proof into the queue. The
   * closure reads LIVE inventory at reconciliation time, so a queued
   * prerequisite retires as soon as the better items exist - not only at a
   * reload boundary.
   */
  private installDominatedPrerequisiteReason(): void {
    return goalstate.installDominatedPrerequisiteReason(this.goalStateHost)
  }

  /**
   * #predicate-retire: wire the code-owned "does this row's success already hold
   * in the world?" probe into the queue. The closure reads LIVE world truth at
   * evaluation time (the queue runs it on every lifecycle transition, including
   * restore), so a row whose postcondition is already true - the measured
   * built/lit/verified Nether gate in front of a restored `place nether_portal`
   * row - retires as DONE instead of holding the queue head forever and starving
   * the ladder's M3 work.
   *
   * It answers CAN/TRUE/DONE only: it never adds, reorders or replaces a goal,
   * and a predicate it cannot evaluate is UNKNOWN, which is never satisfaction.
   */
  private installGoalSuccessProbe(): void {
    return queueplane.installGoalSuccessProbe(this.queueHost)
  }

  /** The live world facts the success-predicate probe may read. Plain reads only. */
  private goalWorldProbe(): GoalSuccessWorldProbe {
    return goalstate.goalWorldProbe(this.goalStateHost)
  }

  /**
   * The run's durable verified-portal records, in the geometry envelope the
   * world memory already carries (`KnownResource` kind `portal`: origin +
   * widthAxis + recorded frame cells). The records are minted and revoked by the
   * world-memory sync from LIVE block truth (`syncKnownPortalSites` /
   * `PORTAL_VERIFIED`); this reader neither adds nor revokes one.
   */
  private recordedPortalSites(): RecordedPortalSite[] {
    return portal.recordedPortalSites(this.portalHost)
  }
  private protectedGoalRetireReason(goal: QueuedGoal, incoming: readonly PlannedGoal[]): string | null {
    return goalstate.protectedGoalRetireReason(this.goalStateHost, goal, incoming)
  }

  /**
   * Preserve only partial/full frame sites observed by this generation. Empty
   * candidate footprints are intentionally not remembered. A remembered site
   * is an affordance hint for re-observation; it never bypasses the executor's
   * live block and post-condition checks.
   */
  private mergeRememberedPortalFrame(state: WorldState): WorldState {
    return portal.mergeRememberedPortalFrame(this.portalHost, state)
  }
  private rememberPortalFrameSites(sites: readonly PortalFrameSite[], dimension: string): void {
    return portal.rememberPortalFrameSites(this.portalHost, sites, dimension)
  }
  private logSubgoalStart(goal: QueuedGoal, inventory: Record<string, number>, cause: string): void {
    return goalstate.logSubgoalStart(this.goalStateHost, goal, inventory, cause)
  }

  /**
   * Summon the long-horizon brain. This is the ONE place an LLM call is made; it
   * is never periodic, only exception-driven. Returns the resummon record for the
   * decision log, or null when the call was suppressed (in flight / cooldown).
   */
  /**
   * The typed blocker + grounded-alternative facts for a summon, or `null` when
   * this controller holds none (the payload then carries no `blockers` field at
   * all - never an invented one).
   *
   * Every value here was produced by a deterministic layer in THIS tick:
   * `withheldCandidateFacts`/`presentedCandidateFacts`/`withheldToolGaps` from
   * the same `generateGroundedCandidates` result the affordance gate used, and
   * `blockedBy`/`missing`/`repeats` from the candidate-starvation evidence.
   * `buildSystem2BlockerFacts` only projects, bounds and clamps; it never ranks,
   * selects or recommends a replacement WHAT.
   *
   * `alternatives.routes` is intentionally left unset here: durable world memory
   * is owned by the resident host, so the payload builder fills it where that
   * memory is actually in scope.
   */
  private system2BlockerFacts(): System2BlockerFacts | null {
    return system2plane.system2BlockerFacts(this.system2Host)
  }

  private semanticStateFingerprint(): string {
    return system2plane.semanticStateFingerprint(this.system2Host)
  }

  /**
   * The semantic inputs that must still hold when an asynchronous System2 plan
   * returns. Body position and body-relative reach are deliberately absent: a
   * successful MOVE does not change WHAT authority. World topology, resource
   * truth, inventory, objective, dimension and the safety envelope remain hard
   * fences. OptionCompilingSystem2 recompiles returned goals against a fresh
   * live snapshot before this controller can atomically apply them.
   */
  private system2ApplyIdentity(state: WorldState | null): Pick<
    System2RequestContext,
    | 'objectiveFingerprint'
    | 'inventoryFingerprint'
    | 'dimension'
    | 'worldTopologyRevision'
    | 'worldFactsFingerprint'
    | 'threatFingerprint'
    | 'survivalFingerprint'
  > {
    return system2plane.system2ApplyIdentity(this.system2Host, state)
  }

  private rememberSystem2PlanOutcome(input: {
    proposalId: string
    operation: 'continue' | 'patch' | 'replace' | 'abandon' | 'complete' | 'abort'
    intentSource: System2SemanticOutcome['intentSource']
    intent: string
    requestedGoalsTotal: number
    acceptedGoals: readonly QueuedGoal[]
    optionInstanceBefore: string | null
    queueDoneBefore: number
    stateFingerprintBefore: string
    blockersBefore: System2BlockerFacts | null
    successSnapshot: OptionWorldSnapshot
  }): void {
    return system2plane.rememberSystem2PlanOutcome(this.system2Host, input)
  }

  private summonLlm(reason: LlmSummonReason, detail: string): DecisionLlmResummonLog | null {
    return system2plane.summonLlm(this.system2Host, reason, detail)
  }

  private onObjectiveComplete(): void {
    return escalationplane.onObjectiveComplete(this.escalationHost)
  }

  // -------------------------------------------------------------------------
  // escalation
  // -------------------------------------------------------------------------

  private escalate(reason: EscalationReason, detail: string): void {
    if (LOCAL_POLICY_ESCALATIONS.has(reason)) {
      // Local path/stall/confidence/failure signals are compact policy memory;
      // they do not change WHAT. Structural reasons still reach the System2
      // handoff below.
      this.pushPolicyEvidence(`${reason}: ${detail}; semantic authority=jev_pi_beta`)
      return
    }
    return escalationplane.escalate(this.escalationHost, reason, detail)
  }

  private recordFailure(code: FailureCode | GuardCode | string | null, detail: string): void {
    return outcome.recordFailure(this.outcomeHost, code, detail)
  }

  private noteTypedActionFailure(reason: string, actionId: string, pending: PendingDecision | undefined): void {
    return ledgers.noteTypedActionFailure(this.ledgersHost, reason, actionId, pending)
  }

  private failureSnapshot(): Record<string, number> {
    return ledgers.failureSnapshot(this.ledgersHost)
  }

  private candidateFailureCount(candidateId: string): number {
    return ledgers.candidateFailureCount(this.ledgersHost, candidateId)
  }

  private noteCandidateFailure(candidateId: string): void {
    return ledgers.noteCandidateFailure(this.ledgersHost, candidateId)
  }

  private noteCandidateSuccess(candidateId: string): void {
    return ledgers.noteCandidateSuccess(this.ledgersHost, candidateId)
  }

  private updateStallSignal(): void {
    return stall.updateStallSignal(this.stallHost)
  }

  /**
   * #oscillation-boundary: feed one settled decision into the DURABLE local-motion
   * record and hand the typed fact upward when its bounded return window is
   * exhausted.
   *
   * The three facts that END an episode are the ones the operator named - the
   * world changed (`goal`/`search` progress), the inventory changed, or the body
   * actually closed distance to a target. Everything else is evidence:
   *   - a MOVEMENT decision engages its DESTINATION cell, so a MOVE that fails
   *     `stuck` still re-engages the same coordinate (the measured loop);
   *   - verified body motion that only revisits the same cells does NOT reset it,
   *     because "body motionだけで semantic stall timer が reset される" is the
   *     defect, not the fix;
   *   - a plan/goal change is recorded, never used to re-arm.
   *
   * The trip is state-conditioned: no clock participates in the decision, and a
   * plain walk produces no record worth persisting (`isNotableLocalOscillation`),
   * so ordinary locomotion is untouched.
   */
  private observeLocalMotion(
    result: ExecutionResult,
    candidate: Candidate,
    taxonomy: ActionOutcomeTaxonomy,
  ): void {
    return stall.observeLocalMotion(this.stallHost, result, candidate, taxonomy)
  }

  /** Write the durable half through the HOST callback; never throws into the tick. */
  private persistLocalOscillation(): void {
    return stall.persistLocalOscillation(this.stallHost)
  }

  /**
   * The remembered target the ascent trap is measured against: the active
   * retrieval when one exists, else the active surface-recovery goal's own
   * `targetY`, else the highest remembered resource still above the bot. Pure
   * lookup; the trap predicate itself is `evaluateCapabilityGap`.
   *
   * The surface goal is included because the planner's capability-gap handling
   * forces exactly that goal (`buddy-driver/planner-ladder.ts`), and its
   * `targetY` is the Y the body must actually reach. Without it, a shaft with no
   * remembered upper feature had no target at all, so the trap could not fire.
   */
  private capabilityTarget(): { y: number; key: string } | null {
    return goalstate.capabilityTarget(this.goalStateHost)
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
  private ascentRefusedByPlan(target: { y: number } | null): boolean {
    return goalstate.ascentRefusedByPlan(this.goalStateHost, target)
  }

  /**
   * P1 durability: turn the scheduler's damage observation into sensor
   * evidence. `damage_taken` carries the Mineflayer-attributed attacker, so
   * `signals.lastDamage` records *who* hit the bot (null = environmental /
   * unattributed, never an invented source). A negative `hp_changed` without a
   * fresh attributed event keeps attribution only inside the same hit burst.
   */
  private observeThreat(trigger: DecisionTrigger, detail: Record<string, unknown>, currentHealth: number): void {
    return threat.observeThreat(this.threatHost, trigger, detail, currentHealth)
  }
  private observeThreatState(state: WorldState): void {
    return threat.observeThreatState(this.threatHost, state)
  }
  private mobIdentityContext(
    chosen: Candidate | null,
    decisionState: WorldState,
    freshState: WorldState,
  ): MobIdentityContext {
    return epochs.mobIdentityContext(this.epochsHost, chosen, decisionState, freshState)
  }

  private logGuardRejections(): void {
    return evidence.logGuardRejections(this.evidenceHost)
  }

  /**
   * SAFE: name the attacker the local layer cannot answer.
   *
   * Measured live (`run-muc3qbug-18vg3`, the 18 s Nether death window): a ghast
   * (`attackerId=49201 attackerName=ghast`) took the body 9.5 HP -> 7.5 HP while
   * never appearing in the sensor at all (`entityRadius` was 24 m; a ghast fires
   * from 64 m), so no `THREAT_NEARBY` line named it and the run said nothing
   * about the shelling. This is the typed GAP for that situation: the attacker
   * is reported from real damage attribution and from the widened hostile
   * envelope, and NO action is invented for a mob whose position the body cannot
   * ground a response from.
   */
  private observeUnansweredRangedThreat(state: WorldState): void {
    return threat.observeUnansweredRangedThreat(this.threatHost, state)
  }
  private logThreatOccluded(offer: ThreatOffer): void {
    return threat.logThreatOccluded(this.threatHost, offer)
  }
  private logSurvivalRace(state: WorldState, offer: ThreatOffer): void {
    return threat.logSurvivalRace(this.threatHost, state, offer)
  }
  private logThreatGap(state: WorldState, offer: ThreatOffer): void {
    return threat.logThreatGap(this.threatHost, state, offer)
  }
  private observeCriticalDamage(trigger: DecisionTrigger, detail: Record<string, unknown>): void {
    return threat.observeCriticalDamage(this.threatHost, trigger, detail)
  }
  private logReflex(
    reflex: EnvHazardReflex,
    state: WorldState,
    inFlight: InFlightAction | null,
    alternatives: readonly string[],
  ): void {
    return threat.logReflex(this.threatHost, reflex, state, inFlight, alternatives)
  }
  private logEnvHazardBoundary(
    state: WorldState,
    candidates: readonly Candidate[],
    inFlight: InFlightAction | null,
  ): void {
    return threat.logEnvHazardBoundary(this.threatHost, state, candidates, inFlight)
  }
  private reflexDecision(candidate: Candidate): JevResult {
    return epochs.reflexDecision(this.epochsHost, candidate)
  }

  /**
   * SAFE: the environmental cause an UNATTRIBUTED damage event is attributed to,
   * or null when the body is in no damage-dealing hazard.
   *
   * Reads the tracker's last observation, which is one decision old by
   * construction: `observeCriticalDamage` runs before the sensor build, and the
   * hazard state is part of that build. A hazard the body is standing in persists
   * across decisions, so the attribution names the cause that is actually
   * dealing the damage; `envHazardDamageSource` still refuses to attribute to a
   * hazard that cannot deal damage (`adjacent_lava` alone).
   */
  private envHazardAttribution(): string | null {
    return threat.envHazardAttribution(this.threatHost)
  }
  private observeEnvHazard(state: WorldState): void {
    return threat.observeEnvHazard(this.threatHost, state)
  }
  private sampleHealthFallback(): void {
    return threat.sampleHealthFallback(this.threatHost)
  }
  private observeCapabilityGap(): void {
    return stall.observeCapabilityGap(this.stallHost)
  }

  /** Keep the gap marker the newest recent event so the planner sees it. */
  private ensureCapabilityGapSignal(marker: string): void {
    return stall.ensureCapabilityGapSignal(this.stallHost, marker)
  }

  /** A pillar ascent attempt that did not verify is a refused ascend. */
  private noteAscendOutcome(result: ExecutionResult, candidate: Candidate): void {
    return retrieval.noteAscendOutcome(this.retrievalHost, result, candidate)
  }

  /**
   * Issue #45 progress assertion: while a retrieval is active its distance to the
   * remembered target must keep decreasing. When it does not for
   * RETRIEVAL_STALL_TICKS the target is dropped as unreachable, RETRIEVE_STALLED
   * is logged, and the next decision is forced onto a different strategy instead
   * of WAIT. Tracking is keyed on the active retrieval, not the last chosen action,
   * so an intervening WAIT no longer resets the assertion.
   *
   * M2 ascent: altitude gain toward the target also counts as progress (a
   * 56-block climb moves the 3D distance by ~1/56 per step), and it re-arms the
   * run's stall clock so a long climb is never abandoned mid-ascent.
   */
  private observeRetrievalStall(): void {
    return retrieval.observeRetrievalStall(this.retrievalHost)
  }

  private retrievalKey(active: { knownName: string; target: Vec3Json }): string {
    return retrieval.retrievalKey(this.retrievalHost, active)
  }

  /**
   * Issue #41 progress + stall assertion for an active `descend_to:Y=<n>` goal.
   * The feet Y must keep decreasing. If the generator offers no DESCEND candidate
   * (or the decision made no progress) for DESCEND_STALL_TICKS ticks, this logs
   * `DESCEND_STALLED`, drops the latched descent budget so a different column can
   * be tried, and escalates to System 2 - WAIT is never the answer for a descend
   * goal. Tracking resets whenever the goal changes or is satisfied.
   */
  private observeDescendProgress(candidates: readonly Candidate[]): void {
    return retrieval.observeDescendProgress(this.retrievalHost, candidates)
  }

  private resetDescendTracking(): void {
    return retrieval.resetDescendTracking(this.retrievalHost)
  }

  private retrievalTargetExists(): boolean {
    return retrieval.retrievalTargetExists(this.retrievalHost)
  }

  private onRetrievalStall(
    active: { id: string; resource: string; knownName: string; target: Vec3Json },
    current: number,
  ): void {
    return retrieval.onRetrievalStall(this.retrievalHost, active, current)
  }

  private dropUnreachableResource(
    active: { resource: string; knownName: string; target: Vec3Json },
    current: number,
  ): void {
    return retrieval.dropUnreachableResource(this.retrievalHost, active, current)
  }

  private isRouteDeclaredMove(candidate: Candidate): boolean {
    return ledgers.isRouteDeclaredMove(candidate)
  }

  private recordZeroProgressOutcome(
    result: ExecutionResult,
    candidate: Candidate,
    truthful: ReturnType<typeof truthfulActionOutcome>,
  ): void {
    return ledgers.recordZeroProgressOutcome(this.ledgersHost, result, candidate, truthful)
  }

  private checkWedge(actionId: string): void {
    // Repeated WAIT is history for the decision policy, not
    // "N waits -> System2/abort".
    if (actionId === 'WAIT') {
      this.pushPolicyEvidence('Jev pi selected WAIT with no verified progress yet')
    }
  }

  private currentOptionContext(): CurrentOptionContext | null {
    return queueplane.currentOptionContext(this.queueHost)
  }

  /** Code-owned completion proof for the typed System2 `complete` operation. */
  private verifyQueuedGoalComplete(goal: QueuedGoal): boolean {
    return queueplane.verifyQueuedGoalComplete(this.queueHost, goal)
  }

  private currentGoalKey(): string {
    return queueplane.currentGoalKey(this.queueHost)
  }

  private logQueueDepthDelta(before: number, op: string, reason: string): void {
    return queueplane.logQueueDepthDelta(this.queueHost, before, op, reason)
  }

  private noProductiveSignature(state: WorldState): string {
    return queueplane.noProductiveSignature(this.queueHost, state)
  }

  private replanInputs(): ReplanInputs {
    return queueplane.replanInputs(this.queueHost)
  }

  private logRetrievalAction(candidate: Candidate): void {
    return retrieval.logRetrievalAction(this.retrievalHost, candidate)
  }

  private retrievalDistance(target: Vec3Json | null): number | null {
    return retrieval.retrievalDistance(this.retrievalHost, target)
  }

  private retrievalDistanceExact(target: Vec3Json | null): number | null {
    return retrieval.retrievalDistanceExact(this.retrievalHost, target)
  }

  /**
   * Did a known-resource RETRIEVE actually reach its target? `pathToNear` aims
   * for 2 blocks, so a coordinate still further than that is a miss even when the
   * executor reported `verified=true` from a vertical chunk. Pure callers use
   * `shouldClearActiveRetrieval`; this only measures the live body.
   */
  private retrievalArrived(candidate: Candidate): boolean {
    return retrieval.retrievalArrived(this.retrievalHost, candidate)
  }

  /**
   * A surface RETRIEVE is a search waypoint, not a remembered resource. Its
   * postcondition is local arrival so the search frontier can advance; arrival
   * must never be treated as acquisition of the parent collect Option.
   */
  private surfaceSearchArrived(candidate: Candidate): boolean {
    return retrieval.surfaceSearchArrived(this.retrievalHost, candidate)
  }

  private recordSurfaceSearch(candidate: Candidate): void {
    return retrieval.recordSurfaceSearch(this.retrievalHost, candidate)
  }

  /**
   * Did a finished RETRIEVE actually COMPLETE: the target arrived or the item
   * was acquired? This is the one gate for resetting failure memory and for
   * retiring the per-resource counter. A measured distance closure or a bounded
   * vertical chunk is durable `progressed` evidence, never completion - RC8
   * (`run-mu8ue5dg-10amk`) closed ~1 m of a 20 m approach with a vertical body
   * change and no arrival, which must not count. `shouldClearActiveRetrieval`
   * already owns the known+progress+not-arrived boundary; the acquisition case
   * is added here.
   */
  private retrieveCompleted(candidate: Candidate, result: ExecutionResult): boolean {
    return retrieval.retrieveCompleted(this.retrievalHost, candidate, result)
  }

  /**
   * Issue #58: score every feasible furnace-prerequisite path, log the chosen
   * one with its alternatives, suppress the losing paths so the code choice is
   * authoritative, and switch to the next-best path when the chosen one stalls.
   * Never abandons the parent goal: the placement guard keeps the prerequisite
   * protected and the switch only re-routes HOW it is satisfied.
   *
   * #11 v2: the feasible path is chosen by cost and the #78 rank winner is
   * shadow-logged (`PREREQ_RANK_SHADOW`); abandonment only demotes a path, so a
   * feasible route is never dropped to null/WAIT.
   */
  /**
   * Durable known resources plus the stations this controller verified placing,
   * deduplicated by (name, cell). The sensor's remembered-station merge and the
   * candidate ladder consume the same list, so a placed furnace is selectable on
   * the very next tick without waiting for a generation swap.
   */
  private knownResourcesForSensor(): KnownResource[] {
    return retrieval.knownResourcesForSensor(this.retrievalHost)
  }

  /**
   * Every want item this tick's retrieval machinery can route to: the active
   * focus plus the queued want the explicit descent proxy exposes. The sensor
   * verifies remembered cells for all of them (`SensorInput.retrievalItems`),
   * because `retrievalNeeds` offers the proxied row's `RETRIEVE:known` from the
   * same memory - verifying only the focus left that cell unproven forever.
   */
  private retrievalProbeItems(): string[] {
    return retrieval.retrievalProbeItems(this.retrievalHost)
  }

  /**
   * M2 blocker: remembered stations whose grounded retrieve the move-failure
   * memory has blacklisted (`MOVE_TARGET_SKIPPED`) or the reachability gate has
   * withheld (`CANDIDATE_WITHHELD`) are handed to the pure prerequisite planner
   * as an explicit unreachable set. Without it the planner keeps choosing
   * `use_known_station`, the blacklist filter removes every candidate of that
   * path, and the resident collapses to WAIT.
   *
   * The sensor's remembered station entries are included because a placed-by-us
   * furnace or crafting table is evicted from `signals.knownResources` once the
   * move-failure memory blacklists its cell, yet it is still offered by the
   * corresponding station projection; an unblacklisted copy would re-issue the
   * failing RETRIEVE forever.
   *
   * SENSED furnaces and crafting tables are considered too: a station the bot
   * placed and then cannot path back to is blacklisted by a guard NO_PATH
   * (SMELT/CRAFT is a tracked target kind). Skipping sensed entries here would
   * leave the station ladder re-offering the unreachable cell while its local
   * fallback never runs.
   */
  private unreachableStationKeys(state: WorldState): ReadonlySet<string> {
    // Failure-count station blacklists cannot hide otherwise-grounded
    // alternatives from the decision policy; hard reachability is still
    // enforced by grounded candidate generation + Guard.
    void state
    return new Set<string>()
  }

  /**
   * Feed the active coordinate blacklist into candidate selection. The
   * post-generation filter remains the final guard, but selection must see
   * restored entries too; otherwise pickExplore/retrievalCandidates chooses a
   * target that filterMoveCandidates immediately removes, leaving only WAIT.
   */
  private blacklistedMoveTargets(state: WorldState): BlacklistedMoveTargets {
    const hazards = this.options.deathHazards
    if (hazards === undefined || hazards.length === 0) return new Set<string>()
    void state
    return (dimension, position) => isInDeathZone(hazards, position, dimension) !== null
  }

  private logStaleKnownResources(state: WorldState): void {
    return diagnostics.logStaleKnownResources(this.diagnosticsHost, state)
  }

  /**
   * The typed VERDICT for every remembered cell the sensor proved or disproved
   * this tick (`state.knownResourceEvidence`), so a stale memory is observable in
   * the run log instead of only its silent withholding.
   *
   *   - `KNOWN_RESOURCE_FALSIFIED ... reason=block_mined|mob_gone|drop_absent`:
   *     the loaded world contradicts the memory. Logged once per (cell, item,
   *     reason); a cell that is re-sighted re-arms it, so a second absence is a
   *     second marker;
   *   - `KNOWN_RESOURCE_RESIGHTED ... source=mob|drop`: a producer/drop cell the
   *     memory still asserts has live evidence again, which is exactly when its
   *     `RETRIEVE:known` route is offered again.
   *
   * This is enumeration of world truth: no goal, action or ranking is decided.
   */
  private logKnownResourceVerdicts(state: WorldState): void {
    return diagnostics.logKnownResourceVerdicts(this.diagnosticsHost, state)
  }

  private cancelContradictedSkillTarget(state: WorldState): void {
    return epochs.cancelContradictedSkillTarget(this.epochsHost, state)
  }

  private abortWedge(reason: string): void {
    // Wall-clock/count based no-progress is not a deterministic proof that the
    // process should abort. Preserve the evidence; termination ownership stays
    // with the decision policy and hard safety/lifecycle failures elsewhere.
    this.pushPolicyEvidence(`wedge observation: ${reason}; termination authority=jev_beta`)
  }

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  private inFlight(): InFlightAction | null {
    const current = this.executor.current
    if (current === null) return null
    return { id: current.id, kind: current.kind }
  }

  private canComputePath(position: Vec3Json): boolean {
    return probes.canComputePath(this.probesHost, position)
  }

  private canComputeMeleePath(position: Vec3Json): boolean {
    return probes.canComputeMeleePath(this.probesHost, position)
  }

  private logCandidates(candidates: readonly Candidate[], state: WorldState): void {
    return diagnostics.logCandidates(this.diagnosticsHost, candidates, state)
  }

  /**
   * Hunger observability. The eat mechanic itself is deterministic and already
   * works when food is held; the live failure was a body with `food=0` and no
   * edible item and no grounded route to one. These markers make each state
   * greppable:
   *
   *   FOOD_LOW food=<n> threshold=<n>            hunger is at/below the eat gate
   *   EAT_REFUSED reason=full|no_food            why no EAT candidate was offered
   *   FOOD_ROUTE kind=animal target=<entity>     a grounded hunt route is on offer
   *   FOOD_ACQUIRED item=<name> count=<n>        a food item count rose this tick
   *   FOOD_EATEN item=<name> food=<a>-><b> health=<n>  the hunger bar rose this tick
   *
   * Deduped by (food, threshold, held food, offered routes) so a stable food
   * state is one auditable line, matching the LOG_ROUTE convention.
   */
  private logFoodState(candidates: readonly Candidate[], state: WorldState, options: CandidateOptions): void {
    return diagnostics.logFoodState(this.diagnosticsHost, candidates, state, options)
  }

  /**
   * The `LOG_ROUTE` marker: which log route the policy has on offer this tick
   * (`mode=mine_sensed|retrieve_known|ascend_then_mine|explore`), so a frozen
   * non-yield MINE can never again pass as progress. Deduped by
   * (mode, target, candidate) so a stable route is one auditable line; the
   * `trigger=... -> action=...` line still records the action actually chosen.
   */
  private logLogRoute(candidates: readonly Candidate[]): void {
    return diagnostics.logLogRoute(this.diagnosticsHost, candidates)
  }

  /**
   * #11 v2 affordance gate: `REACHABILITY target=<x,y,z> reachable=<bool>
   * reason=<reason> missing=[...]` for every evaluated target whose facts
   * changed, and `CANDIDATE_WITHHELD reason=<reason> candidate=<id>` for every
   * withheld candidate. Deduped by (candidate, fingerprint) so an unchanged
   * unreachable target is a stable fact, not a per-tick log flood.
   */
  private logReachability(
    evaluated: readonly CandidateReachability[],
    withheld: readonly CandidateReachability[],
  ): void {
    return diagnostics.logReachability(this.diagnosticsHost, evaluated, withheld)
  }

  private logReachabilityOnce(
    key: string,
    signature: string,
    asWarning: boolean,
    entry: CandidateReachability,
  ): void {
    return diagnostics.logReachabilityOnce(this.diagnosticsHost, key, signature, asWarning, entry)
  }

  private noteSurfaceAscent(refusal: SurfaceAscentRefusal | null, candidates: readonly Candidate[]): void {
    return evidence.noteSurfaceAscent(this.evidenceHost, refusal, candidates)
  }

  private noteColumnDig(candidates: readonly Candidate[]): void {
    return evidence.noteColumnDig(this.evidenceHost, candidates)
  }

  private noteFoodHabitat(refusal: SurfaceAscentRefusal | null): void {
    return evidence.noteFoodHabitat(this.evidenceHost, refusal)
  }

  private logContainerRefusals(refusals: readonly ContainerRefusal[]): void {
    return evidence.logContainerRefusals(this.evidenceHost, refusals)
  }

  private logPlacementRefusal(refusal: PlaceRefusal | null): void {
    return evidence.logPlacementRefusal(this.evidenceHost, refusal)
  }

  private logArmorRefusal(refusals: readonly ArmorRefusal[]): void {
    return evidence.logArmorRefusal(this.evidenceHost, refusals)
  }

  private logArmorCraft(offers: readonly ArmorCraftOffer[], refusals: readonly ArmorCraftRefusal[]): void {
    return evidence.logArmorCraft(this.evidenceHost, offers, refusals)
  }

  private logSourceExclusions(exclusions: readonly ResourceSourceExclusion[]): void {
    return evidence.logSourceExclusions(this.evidenceHost, exclusions)
  }

  private logPortalFrameSiteRejection(state: WorldState): void {
    return evidence.logPortalFrameSiteRejection(this.evidenceHost, state)
  }

  private logExploreRouteBlocked(blocked: ExploreRouteBlocked | null): void {
    return evidence.logExploreRouteBlocked(this.evidenceHost, blocked)
  }

  private logColumnDescentRefusal(refusal: ColumnDescentRefusal | null): void {
    return evidence.logColumnDescentRefusal(this.evidenceHost, refusal)
  }

  private logContactRefusals(refusals: readonly ContactRefusal[]): void {
    return evidence.logContactRefusals(this.evidenceHost, refusals)
  }

  private logProspectRefusal(refusal: ProspectRefusal | null): void {
    return evidence.logProspectRefusal(this.evidenceHost, refusal)
  }

  private logResourceSourceGap(gap: ResourceSourceGap | null): void {
    return evidence.logResourceSourceGap(this.evidenceHost, gap)
  }

  private logCombatKitGap(gap: CombatKitGapEvidence | null): void {
    return evidence.logCombatKitGap(this.evidenceHost, gap)
  }

  private logFoodSourceGap(gap: FoodSourceGap | null): void {
    return evidence.logFoodSourceGap(this.evidenceHost, gap)
  }

  private logMobDropSourceGap(gap: MobDropSourceGap | null): void {
    return evidence.logMobDropSourceGap(this.evidenceHost, gap)
  }

  private logMobSpawnContext(gap: MobDropSourceGap | null): void {
    return evidence.logMobSpawnContext(this.evidenceHost, gap)
  }

  private logIgnitionRefusal(refusal: IgnitionRefusal | null): void {
    return evidence.logIgnitionRefusal(this.evidenceHost, refusal)
  }

  private logSmeltInputPrereq(state: WorldState, options: CandidateOptions): void {
    return evidence.logSmeltInputPrereq(this.evidenceHost, state, options)
  }

  private logCraftIngredientPrereq(state: WorldState, options: CandidateOptions): void {
    return evidence.logCraftIngredientPrereq(this.evidenceHost, state, options)
  }

  private logCraftStationGap(state: WorldState, options: CandidateOptions): void {
    return evidence.logCraftStationGap(this.evidenceHost, state, options)
  }

  private logPrereqStationKnown(state: WorldState, options: CandidateOptions): void {
    return evidence.logPrereqStationKnown(this.evidenceHost, state, options)
  }

  private logSmeltRouteGap(state: WorldState, options: CandidateOptions): void {
    return evidence.logSmeltRouteGap(this.evidenceHost, state, options)
  }

  private logSmeltStationRetry(candidate: Candidate): void {
    return evidence.logSmeltStationRetry(this.evidenceHost, candidate)
  }

  private reachabilityGateOptions(): ReachabilityGateOptions {
    return probes.reachabilityGateOptions(this.probesHost)
  }

  private attackStandProbe(): (query: { entityId: number; position: Vec3Json }) => AttackStandFact | null {
    return probes.attackStandProbe(this.probesHost)
  }

  private botStandColumnHazardAt(x: number, y: number, z: number): boolean {
    return probes.botStandColumnHazardAt(this.probesHost, x, y, z)
  }

  private botSeesEntityFrom(x: number, y: number, z: number, entityPosition: Vec3Json, height: number): boolean {
    return probes.botSeesEntityFrom(this.probesHost, x, y, z, entityPosition, height)
  }

  private computePathFacts(position: Vec3Json): { probe: 'reachable' | 'no_path'; transfer: DimensionTransferRoute } {
    return probes.computePathFacts(this.probesHost, position)
  }

  private routeCrossesDimensionTransfer(path: readonly { x: number; y: number; z: number }[]): DimensionTransferRoute {
    return probes.routeCrossesDimensionTransfer(this.probesHost, path)
  }

  private botStandsInDimensionTransfer(feet: Vec3Json): boolean {
    return probes.botStandsInDimensionTransfer(this.probesHost, feet)
  }

  private digApproachProbe(): DigApproachProbe {
    return probes.digApproachProbe(this.probesHost)
  }

  private stationApproachProbe(): StationApproachProbe {
    return probes.stationApproachProbe(this.probesHost)
  }

  private botPassableAt(x: number, y: number, z: number): boolean {
    return probes.botPassableAt(this.probesHost, x, y, z)
  }

  private botSolidSupportAt(x: number, y: number, z: number): boolean {
    return probes.botSolidSupportAt(this.probesHost, x, y, z)
  }

  private canComputePathNear(position: Vec3Json): boolean {
    return probes.canComputePathNear(this.probesHost, position)
  }

  private noteStationUnreachable(
    kind: StationKindName,
    station: Vec3Json,
    reason: StationApproachRefusal,
  ): void {
    return probes.noteStationUnreachable(this.probesHost, kind, station, reason)
  }

  private forgetStationUnreachable(kind: StationKindName, station: Vec3Json): void {
    return probes.forgetStationUnreachable(this.probesHost, kind, station)
  }

  private logFuelSatisfaction(state: WorldState): void {
    return evidence.logFuelSatisfaction(this.evidenceHost, state)
  }

  private checkUnreachableMove(candidate: Candidate, state: WorldState): void {
    return ledgers.checkUnreachableMove(this.ledgersHost, candidate, state)
  }

  private noteRepeatedOutcome(
    result: ExecutionResult,
    candidate: Candidate,
    verified: boolean,
    progressKinds: readonly string[],
  ): void {
    return ledgers.noteRepeatedOutcome(this.ledgersHost, result, candidate, verified, progressKinds)
  }

  private filterRepeatedOutcomeCandidates(
    candidates: readonly Candidate[],
    state: WorldState,
    log = true,
  ): Candidate[] {
    return ledgers.filterRepeatedOutcomeCandidates(this.ledgersHost, candidates, state, log)
  }

  private filterMoveCandidates(
    candidates: readonly Candidate[],
    state: WorldState,
    log = true,
  ): Candidate[] {
    return ledgers.filterMoveCandidates(this.ledgersHost, candidates, state, log)
  }

  private rememberMoveTarget(candidate: Candidate): void {
    return ledgers.rememberMoveTarget(this.ledgersHost, candidate)
  }

  private recordMoveFailure(candidate: Candidate, reason: MoveFailureReason): void {
    return ledgers.recordMoveFailure(this.ledgersHost, candidate, reason)
  }

  private movePathFailureScope(state?: WorldState | null): MoveFailurePathScope | null {
    return ledgers.movePathFailureScope(this.ledgersHost, state)
  }

  private remainingCooldownSeconds(blacklistedUntil: number, now = Date.now()): number {
    return ledgers.remainingCooldownSeconds(blacklistedUntil, now)
  }

  private recordMoveSuccess(candidate: Candidate): void {
    return ledgers.recordMoveSuccess(this.ledgersHost, candidate)
  }

  private resetDescendBudgetAfterWorldChange(actionId: string, reason: 'verified_mine' | 'verified_move'): void {
    return ledgers.resetDescendBudgetAfterWorldChange(this.ledgersHost, actionId, reason)
  }

  private notifyMoveFailureMemory(): void {
    return ledgers.notifyMoveFailureMemory(this.ledgersHost)
  }

  private currentDimension(): string {
    return ledgers.currentDimension(this.ledgersHost)
  }

  /**
   * DigMemory contains absolute block coordinates, so every access is fenced to
   * the controller's full host world identity and Mineflayer's live dimension.
   * A server switch, portal transfer, or world replacement clears that coordinate
   * history; ordinary ticks in the same world preserve it.
   */
  private get digMemory(): DigMemory {
    this.bindDigMemoryScope(this.currentDimension())
    return this.digMemoryState
  }

  /** Test seams and isolated controller fixtures can replace the memory object. */
  private set digMemory(value: DigMemory) {
    this.digMemoryState = value
  }

  private bindDigMemoryScope(dimension: string): void {
    return stall.bindDigMemoryScope(this.stallHost, dimension)
  }

  /**
   * #8: an A/B position pair repeating without progress is an oscillation, not a
   * path. Log it, blacklist the target that caused it, and clear the window so the
   * detector cannot fire on the same stale samples again.
   */
  private detectMoveOscillation(): void {
    return stall.detectMoveOscillation(this.stallHost)
  }

  private runSuccess(): boolean {
    if (this.options.singleShotPlanner && this.subgoalCount > 0) {
      return this.queue.state.done >= this.subgoalCount
    }
    return this.verifiedDigs > 0
  }

  private loadLedger(): GoalQueueSnapshot | null {
    const path = this.options.ledgerPath
    if (path === null || !existsSync(path)) return null
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as GoalQueueSnapshot
      if (!Array.isArray(parsed.goals) || typeof parsed.counter !== 'number') return null
      return parsed
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger.warn('system2', `could not read the phase ledger ${path}: ${message}`)
      return null
    }
  }

  private saveLedger(): void {
    const path = this.options.ledgerPath
    if (path === null) return
    try {
      writeFileSync(path, `${JSON.stringify(this.queue.snapshot(), null, 2)}\n`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger.warn('system2', `could not write the phase ledger ${path}: ${message}`)
    }
  }

  private modelRecoveryDrainAction(): CurrentAction | null {
    return modelrecovery.modelRecoveryDrainAction(this.modelRecoveryHost)
  }

  private finish(stopped: RunSummary['stopped'], success: boolean): void {
    if (!this.running) return
    if (this.modelRecoveryStopping && stopped !== 'disconnected') {
      const draining = this.modelRecoveryDrainAction()
      const recoveryReachId = this.modelRecoveryReachDrainTransitionId ?? null
      const reachDrain = recoveryReachId !== null &&
        this.reachTransition?.contract.transitionId === recoveryReachId &&
        this.reachTransition.state.status === 'active'
      if (draining !== null || reachDrain) {
        const transitionId = this.modelRecoveryReachDrainTransitionId
        this.logger.warn(
          'agent',
          `MODEL_RECOVERY_DRAIN phase=finish_deferred actionId=${draining?.id ?? 'none'} kind=${draining?.kind ?? 'reach_transition'} transitionId=${transitionId ?? 'none'} requestedReason=${stopped}`,
          {
            actionId: draining?.id ?? null,
            kind: draining?.kind ?? 'reach_transition',
            commitmentId: draining?.commitment?.commitmentId ?? null,
            requestedReason: stopped,
            epoch: draining?.epoch ?? null,
            transitionId,
          },
          this.tickCounter,
        )
        return
      }
    }
    this.system2?.cancelPending?.(`controller-finished:${stopped}`)
    this.running = false
    this.saveLedger()
    this.scheduler.stop()
    this.clearDecisionTimer()
    if (this.watchdog !== null) {
      clearTimeout(this.watchdog)
      this.watchdog = null
    }
    if (this.modelRecoveryDrainTimer !== null) {
      clearTimeout(this.modelRecoveryDrainTimer)
      this.modelRecoveryDrainTimer = null
    }
    this.modelRecoveryReachDrainTransitionId = null
    this.modelRecoveryReachDrainPending = false
    this.bot.removeListener('end', this.onBotEnd)
    this.bot.removeListener('kicked', this.onBotKicked)
    this.bot.removeListener('death', this.onBotDeath)
    this.executor.cancelCurrent('agent stopping')
    for (const pending of this.pendingDecisions.values()) {
      this.decisionWriter.write(pending.record)
    }
    this.pendingDecisions.clear()
    const summary = this.summary(stopped, success)
    this.logger.info('agent', `stopped reason=${stopped} success=${success} verifiedDigs=${this.verifiedDigs}`, {
      escalations: summary.escalations,
      triggerCounts: summary.triggerCounts,
      guardRejections: summary.guardRejections,
      conflictDeferrals: summary.conflictDeferrals,
      maxConcurrentActions: summary.maxConcurrentActions,
      llmSummons: summary.llmSummons,
      llmSummonReasons: summary.llmSummonReasons,
      needLlmDecisions: summary.needLlmDecisions,
      goalQueueDepth: summary.goalQueueDepth,
      goalQueueCurrent: summary.goalQueueCurrent,
    })
    this.resolveCompletion?.(summary)
  }

  private summary(stopped: RunSummary['stopped'], success: boolean): RunSummary {
    const queueState = this.queue.state
    return {
      ticks: this.tickCounter,
      jevCalls: this.jevCalls,
      guardRejections: this.guardRejections,
      conflictDeferrals: this.conflictDeferrals,
      escalations: [...this.escalations],
      triggerCounts: { ...this.triggerCounts },
      verifiedDigs: this.verifiedDigs,
      blocksRemoved: this.blocksRemoved,
      dropObservations: this.dropObservations,
      itemsCollected: this.itemsCollected,
      goalItemCount: this.executor.lastResult?.goalItemCount ?? 0,
      goalItemInInventory: this.countItem(this.goal.targetItem),
      goalComplete: this.goal.complete,
      policyKind: this.jev.kind,
      policyModel: this.jev.model,
      maxConcurrentActions: this.executor.maxConcurrentActions,
      llmSummons: this.llmSummons,
      llmSummonReasons: [...this.llmSummonReasons],
      llmRuntimeCalls: this.runtimeLlmCalls,
      llmPlanCalls: this.planCalls,
      needLlmDecisions: this.needLlmDecisions,
      goalQueueDepth: queueState.depth,
      goalQueueCurrent: queueState.current?.description ?? null,
      subgoalCount: this.subgoalCount,
      subgoalsDone: queueState.done,
      durationMs: Date.now() - this.startedAt,
      stopped,
      success,
    }
  }
}

// Kept as a public re-export: tests and `controller.ts`'s `export *` consume it
// from this module's historical location. Definition lives in `scheduler.ts`.
export { pickHigherPriority }

/** Prefer the `need_llm` resummon for the record; otherwise the tick's first one. */
function pickResummon(
  log: readonly DecisionLlmResummonLog[],
  needLlmAdopted: boolean,
): DecisionLlmResummonLog {
  if (needLlmAdopted) {
    const needLlm = log.find((entry) => entry.reason === 'need_llm')
    if (needLlm !== undefined) return needLlm
  }
  const first = log[0]
  return first ?? { triggered: false, reason: null, detail: null }
}

function executorOptions(options: JevAgentOptions, scheduler: DecisionScheduler): ExecutorOptions {
  return {
    ...defaultExecutorOptions,
    reach: options.reach,
    pathTimeoutMs: options.pathTimeoutMs,
    digTimeoutMs: options.digTimeoutMs,
    goalItem: options.goalItem,
    actuation: options.actuation,
    actuationPort: options.actuationPort,
    // issue #436 section 14/23: the world epoch this generation runs in, so the
    // executor can revalidate a live commitment against an epoch the host mutates
    // in-place. A world reset that arrives as a host reload builds a new
    // controller+executor, so the old commitment dies with its action anyway.
    observedWorldEpoch: () => options.worldEpoch,
    hooks: {
      onPathCompleted: (event) => {
        options.eventSink?.('PATH_CALLBACK', { phase: 'completed', ...event })
        scheduler.notify('path_completed', {
          actionId: event.actionId,
          target: event.target,
          mode: event.mode,
        })
      },
      onPathFailed: (event) => {
        options.eventSink?.('PATH_CALLBACK', { phase: 'failed', ...event })
        const trigger: DecisionTrigger =
          event.outcome === 'noPath' ? 'path_no_path' : event.outcome === 'timeout' ? 'action_timeout' : 'path_stuck'
        scheduler.notify(trigger, {
          actionId: event.actionId,
          target: event.target,
          mode: event.mode,
          outcome: event.outcome,
        })
      },
    },
  }
}
