// controller.ts - the loop that wires everything together.
//
//   Minecraft -> SENSOR -> WORLD MODEL -> deterministic candidates
//             -> JEV POLICY -> deterministic GUARD -> EXECUTOR -> VERIFY  (repeat)
//
// The layers are separated by LOOKAHEAD, not by fixed period:
//
//   * Mineflayer  - continuous: movement, look, dig continuation, instant avoidance.
//   * Jev         - event-driven + max 3 s heartbeat: next action / target / danger /
//                   continue-vs-retreat / replan-needed. It is asked ONCE per decision
//                   with every question batched into a single call, and it is NOT
//                   re-asked while normal movement is progressing.
//   * System 2 LLM- exception-driven + minutes: long-horizon goals and recovery. Jev is
//                   its interrupt controller (`need_llm`), and its answers become a
//                   goal queue consumed by the layers below.
//
//       Mineflayer -> Jev -> ( normal handling | need_llm=true -> LLM )
//
//       LLM plan -> goal queue -> consumed by Jev + Mineflayer
//                -> re-summon only on queue_empty | action_impossible |
//                   unknown_situation | no_progress | need_llm=true
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Bot } from 'mineflayer'
import pathfinderModule from 'mineflayer-pathfinder'
import { CRITICAL_COMBAT_HEALTH, CRAFT_STATION_ALREADY_KNOWN, FURNACE_PREREQUISITE_ROLE, altitudeRouteOnOffer, applyGroundedThreatRestriction, blockId, CONTACT_THREAT_KINDS, countBlockedLogs, craftIngredientPrereq, craftStationGap, defaultCandidateOptions, envHazardEscapeRoutes, envHazardEscapeSpots, envHazardReflexAction, exploredCellKey, frameBuildGrounded, frameBuildMaterialGap, formatColumnDescentRefused, formatCraftIngredientPrereq, formatCraftStationGap, formatExploreRouteBlocked, formatFoodHabitatRefused, formatFuelSatisfied, formatLogRoute, formatMobDropSourceGap, formatMobSpawnContext, formatPlaceRefusal, formatProspectRefused, formatResourceSourceExclusion, formatResourceSourceGap, formatSmeltInputPrereq, formatSmeltRouteGap, formatSmeltStationRetry, formatSurfaceAscentRefused, fuelSatisfaction, furnacePrereqInputFromState, generateGroundedCandidates, goalCollectsFuel, goalWantsFuel, isFoodItem, logRouteOf, optionsWithWithheldStationRetirements, pickFood, KNOWN_RETRIEVE_SKILL, queuedRetrievalProxyItem, resourceDimensionMatches, restrictCandidatesAtCriticalHealth, restrictCandidatesDuringCriticalDamage, restrictCandidatesDuringEnvHazard, restrictCandidatesDuringSubmersion, selfContainedCraftCandidates, smeltInputPrereq, smeltRouteGap, smeltStationRetry, staleKnownResources, surfaceAscentRouteless, surfaceSearchKey, restrictCandidatesDuringUnseenAttacker, unseenAttackerOffer } from './candidates.ts'
import type { Candidate, CandidateKind, CandidateOptions, CandidateReachability, ColumnDescentRefusal, CombatKitGapEvidence, EnvHazardReflex, ExploreRouteBlocked, IgnitionRefusal, MobDropSourceGap, PlaceRefusal, PortalEntryRefusal, ProspectRefusal, ReachabilityGateOptions, ResourceSourceExclusion, ResourceSourceGap, SmeltRouteGap, SurfaceAscentRefusal, ThreatOffer, ContactRefusal } from './candidates.ts'
import { ENV_HAZARD, ENV_HAZARD_CLEAR, ENV_HAZARD_NO_EXIT, EnvHazardTracker, envHazardDamageSource, formatEnvHazard, formatEnvHazardClear, formatEnvHazardNoExit, formatEnvHazardReflexEvidence } from './envHazard.ts'
import { MOVE_LEG_STOPPED } from './stepLanding.ts'
import { ARMOR_SLOTS } from './gearPlan.ts'
import { bodySurvivalFacts, DEATH_CAUSE, formatDeathCause, formatMobIdentityChurn, formatSurvivalNoGroundedAction, formatSurvivalReground, formatThreatClear, formatThreatNearby, formatThreatNoEscape, formatThreatOccluded, formatThreatRangedUnanswered, GUARD_REJECTIONS, MELEE_THREAT_REACH, MOB_IDENTITY_CHURN, THREAT_MEMORY_MS, regroundVanishedSurvivalChoice, survivalControlFallback, SURVIVAL_NO_GROUNDED_ACTION, SURVIVAL_REGROUND, THREAT_CLEAR, THREAT_NEARBY, THREAT_NO_ESCAPE, THREAT_OCCLUDED, THREAT_RANGED_UNANSWERED, ThreatTracker, unansweredRangedThreats, weaponFacts, formatThreatBreakContact, THREAT_BREAK_CONTACT, unsensedAttackerFacts, unsensedThreatResponse } from './threat.ts'
import type { MobIdentityContext } from './threat.ts'
import { formatArmorRefusal, formatCombatKitGap } from './gearPlan.ts'
import { formatContactUnreachable } from './combatClosure.ts'
import type { ArmorRefusal } from './gearPlan.ts'
import { FOOD_SOURCE_NONE, formatFoodSourceGap } from './foodSources.ts'
import type { FoodSourceGap } from './foodSources.ts'
import { capabilityKey, formatCandidateWithheld, formatDigAccessRetired, formatReachability, formatStationUnreachable } from './reachability.ts'
import type { DigApproachFact, DigApproachProbe, DimensionTransferRoute, StationApproachFact, StationApproachProbe, StationApproachRefusal } from './reachability.ts'
import { completeCausalChain, causalRecord, formatCausalLine, makeCausalStamp, makeChainId, optionIdForGoal, planRevisionForGoal } from './causal.ts'
import type { CausalGoalRef } from './causal.ts'
import {
  classifyAbandonRequest,
  formatAbandonEnforced,
  formatAbandonSuppressed,
  OptionAttemptTracker,
  resolveAbandonCooldownMs,
  resolveUnproductiveAttemptLimit,
  selectLadderOption,
} from './abandonPolicy.ts'
import type { AbandonClassification } from './abandonPolicy.ts'
import {
  AbandonmentLedger,
  formatProtectionAbandonConflict,
  PROTECTION_ABANDON_CONFLICT,
  reconcileProtection,
} from './protectionConflict.ts'
import {
  ACTION_COMMIT,
  ACTION_PREEMPT,
  CANDIDATE_COMMIT_RELEASED,
  CANDIDATE_FLAP,
  evaluateActionCommitment,
  evaluateCandidateFlap,
} from './candidateCommitment.ts'
import type { ActionCommitmentState, CandidateFlapState, FlapCandidate } from './candidateCommitment.ts'
import { createRecipeIndex } from './crafting.ts'
import type { RecipeIndex } from './crafting.ts'
import { attachResult, makeDecisionRecord, stableStateHash } from './decisionlog.ts'
// Issue #436 Phase 1: the structural SkillCommitment / CausalTargetIdentity /
// EffectEnvelope contract. This module owns the decision EPOCH and the outcome
// PACKET (see jevSemanticProjection.ts); the commitment module owns what a
// selection is allowed to DO and feeds its real id + contract hashes here.
import {
  commitmentInvalidation,
  effectEnvelopeHash,
  formatSkillInvalidated,
  postconditionHash,
  targetIdentityKey,
} from './skillCommitment.ts'
import type { DecisionJevLog, DecisionLlmLog, DecisionLlmResummonLog, DecisionRecord, DecisionSubgoalLog } from './decisionlog.ts'
// Issue #437: the Skill <-> Jev semantic boundary (projection, decision epochs,
// stable candidate identity, typed SkillOutcomePacket). Raw mechanical telemetry
// stays on the log plane; only these objects cross into policy.
import {
  buildJevSemanticProjection,
  buildSkillOutcomePacket,
  classifySemanticBoundary,
  classifyProjectionChange,
  commitmentRefFor,
  dedupeSemanticCandidates,
  diffSemanticProjections,
  formatEpochEnd,
  formatEpochStart,
  formatJevCandidateSet,
  formatJevStateProjection,
  formatSkillCommit,
  formatSkillOutcomePacket,
  formatStaleResultDropped,
  JevDecisionEpochs,
  mandatoryPolicyBoundary,
  repointReplayedChoice,
  semanticTargetRef,
  foodBand,
  threatBand,
  airBand,
  healthBand,
  projectionHash as semanticProjectionHash,
} from './jevSemanticProjection.ts'
import type {
  DecisionEpoch,
  GroundedFact,
  JevSemanticProjection,
  PreviousDecisionFacts,
  SemanticCandidateView,
  SemanticDelta,
  SemanticProgressFacts,
  SkillOutcomePacket,
  SkillTerminalReason,
} from './jevSemanticProjection.ts'
import { ActionCancelled, defaultExecutorOptions, Executor, interactionStandCandidates, MELEE_ATTACK_RANGE } from './executor.ts'
import type { ActuationMode, ExecutionResult, ExecutorOptions, FailureCode } from './executor.ts'
import type { ActuationPort } from './actuationPort.ts'
import { applyDangerGate, DANGER_CONFIDENCE_THRESHOLD, gateBoolean, gateDanger, gateScore } from './gating.ts'
import type { GatedScore } from './gating.ts'
import {
  PLAN_IDENTITY_CHANGED,
  PLAN_ROW_RETIRED,
  ROW_DEFERRED_NOT_EXECUTABLE_HERE,
  ROW_NOT_EXECUTABLE_HERE,
  formatNonProgressEscalated,
  formatNonProgressYield,
  formatPlanIdentity,
  formatPlanIdentityChanged,
  formatRowDeferredNotExecutableHere,
  formatRowNotExecutableHere,
  GoalQueue,
  notExecutableReplanRequest,
  planReplanRequest,
  toGoalQueueStateLog,
} from './goalQueue.ts'
import type { DominatedPrerequisiteDecision, GoalQueueSnapshot, GoalQueueState, PlanIdentity, PlanObsoleteProof, PlanOp, PlannedGoal, QueuedGoal } from './goalQueue.ts'
import { compilePlannedGoal, evaluatePredicates, makeOptionSnapshot, queuedToPlanned } from './optionSpec.ts'
import type { OptionWorldSnapshot, Predicate } from './optionSpec.ts'
import { PICKAXE_TIER_ORDER, smeltInputFor } from './gameData.ts'
import { FLINT_AND_STEEL, IRON_INGOT, NETHER, NETHER_PORTAL, OBSIDIAN, OVERWORLD, PORTAL_ENTERED_PREDICATE, PORTAL_LIT_PREDICATE, PORTAL_OBSIDIAN_REQUIRED, PRECONDITION_MISSING, SKILL_END, SKILL_INTERRUPT, SKILL_POLICY_BOUNDARY, formatPortalEntryNoKnownSite, formatPortalFrameSiteRejected, formatReflex, formatSkillEnd, formatSkillInterrupt, formatSkillPolicyBoundary, formatSkillStep, formatSkillStepAuthority, isDimensionTransferBlock, isPortalIgnitionPostconditionMet, planPortalEntry, portalFrameLayout } from './netherPortalPlan.ts'
import type { PortalEntryPlan, PortalFrameSite, PortalFrameValidation, SkillPolicyBoundaryReason } from './netherPortalPlan.ts'
import { GOAL_RETIRED_PREDICATE, GOAL_SUCCESS_PROBE_ERROR, evaluateGoalSuccess, recordedPortalSitesFromKnownResources, verifiedBlockRecordsFromKnownResources } from './goalSuccess.ts'
import type { GoalSuccessWorldProbe, RecordedPortalSite } from './goalSuccess.ts'
import { abandonRequested, betaShadowDecision, createJevPolicy, decisionIdFrom, EventLogger, formatBetaShadow, JsonlWriter, questionNamesFor, resolveBetaAuthority, writeOutcome } from './jev.ts'
import type { AgentLevel } from './jev.ts'
import { FatalModelError, describeFailure, failLoud } from './modelFailure.ts'
import type { JevPolicy, JevResult, QuestionSetKind } from './jev.ts'
import { guardDecision, guardRejectionChargesOption } from './policy.ts'
import { ACTION_REJECTED, formatActionRejected, formatMoveUnreachable, MOVE_VERTICAL_GAP_LIMIT, unreachableMove } from './policy.ts'
import type { GuardCode, GuardResult, InFlightAction } from './policy.ts'
import { DECISION_TRIGGERS, DecisionScheduler, LOW_AIR_PREEMPT, PREEMPTIVE_TRIGGERS, shouldInterruptAttackLease, TRIGGER_PRIORITY } from './scheduler.ts'
import type { DecisionTrigger, TriggerEvent } from './scheduler.ts'
import { BODY_SUBMERGED, bodyStarving, distance, formatBodyStarving, buildWorldState, defaultSensorOptions, explainNearestPortalFrameRejection, isSensedStation, isStandable, liveStructureMembersForSites, makeGoal, MAX_AIR, refreshGoalProgress, sensedPortalFrameSites } from './state.ts'
import type { AgentSignals, GoalState, KnownResource, KnownResourceEvidence, KnownResourceFalsifiedReason, SensorOptions, Vec3Json, WorldState } from './state.ts'
import { currentOptionContextForQueuedGoal } from './optionSpec.ts'
import type { CurrentOptionContext } from './optionSpec.ts'
import { isResourceClass, matchesResourceClass, resourceMatches } from './resourceClass.ts'
import { ActionFailureEscalation, BetaAbandonDeferral, BETA_ABANDON_DEFERRED_MARKER, BETA_ABANDON_RELEASED_MARKER, evaluateCapabilityGap, formatActionFailureExhausted, formatActionFailureRepeat, formatBetaAbandonDeferred, formatBetaAbandonReleased, formatCapabilityGap, formatCapabilityGapPolicy, formatLocalRecoveryExhausted, formatLocalRecoveryNoProgress, formatReplanThrottled, ReplanThrottle, resolveActionFailureEscalateCycles, resolveBetaAbandonDeferCycles, resolveReplanNoInfoEscalateCycles, resolveReplanPositionDelta, resolveReplanThrottleMs, resolveWaitStreakEscalateCycles, formatWaitExhausted, formatWaitStreak, WAIT_EXHAUSTED_MARKER, WAIT_STREAK_MARKER, WaitStreakEscalation } from './replanThrottle.ts'
import type { CapabilityGapState, ReplanInputs } from './replanThrottle.ts'
import { decayedFailureCount, failureCount, spatialFailureKey } from './failureMemory.ts'
import {
  detectOscillation,
  filterBlacklistedMoves,
  formatMoveFailMem,
  formatMoveFailMemReset,
  formatMoveTargetSkipped,
  formatOscillationDetected,
  isTrackedMoveKind,
  MoveFailMemory,
  moveFailureKey,
  StateFingerprintMemory,
} from './moveFailMemory.ts'
import type { MoveFailEntry, MoveFailureReason } from './moveFailMemory.ts'
import { ASCENT_PROGRESS_EPSILON, evaluateRetrievalProgress, formatAscentRefused, formatKnownResourceUnreachable, formatRetrieveStalled, pillarColumnUnsafeFromBlocks, planRetrievalEscalation, planVerticalApproachDetailed, resolveRetrievalStallTicks, selectPlaceableBlock } from './verticalPlan.ts'
import { evaluateDescendProgress, formatDescendProgress, formatDescendStalled, resolveDescendNoCandidateTicks, resolveDescendStallTicks, DESCEND_PROGRESS_LOG_TICKS } from './descendPlan.ts'
import type { DescendProgressState } from './descendPlan.ts'
import { DigMemory } from './worldMemory.ts'
import type { DigDir } from './worldMemory.ts'
import { evaluateSpatialPredicate, predicateForGoal } from './predicateGoal.ts'
import type { PredicateEvaluation } from './predicateGoal.ts'
import {
  classifyAbandonReason,
  formatAbandonReason,
  isFurnacePrerequisiteOption,
  PLACE_RETRIES_EXHAUSTED,
  PlaceRetryLedger,
  prerequisiteOptionName,
  shouldAdoptAbandon,
} from './placementGuard.ts'
import type { AbandonReason, PrerequisiteProtection } from './placementGuard.ts'
import {
  decideFurnacePrereqObservation,
  evaluatePrereqStall,
  evaluateRetrieveAbandon,
  formatPrereqOptionDetail,
  formatPrereqOptionFor,
  formatPrereqRankShadow,
  formatPrereqStationKnown,
  formatPrereqSwitch,
  isInventorySourced,
  knownStationKey,
  nextPrereqPath,
  planPrereqOptions,
  preferPrereqPath,
  PREREQ_STATION_ALREADY_KNOWN,
  prereqOptionReason,
  prereqProgressSignature,
  prereqSubjectForGoal,
  prereqWithheldCraft,
  resolvePrereqRankPolicy,
  resolvePrereqStallTicks,
  selectPrereqPath,
} from './prereqOption.ts'
import type { PrereqDecision, PrereqPath, PrereqProgress, PrereqRankPolicy, RetrieveUnverifiedState } from './prereqOption.ts'
import { evaluateOscillation, positionKey } from './oscillation.ts'
import type { OscillationState } from './oscillation.ts'
import { betaAuthorityDecision, formatJevHeads } from './betaAuthority.ts'
import type { BetaAuthorityDecision } from './betaAuthority.ts'
import { classifyActionOutcome, evaluateUnverifiedBudget, formatActionUnverified, hasObservableProgress, isZeroProgressOutcome, truthfulActionOutcome, UNVERIFIED_ACTION_LIMIT } from './actionPostcondition.ts'
import type { ActionOutcomeTaxonomy } from './actionPostcondition.ts'
import {
  cellKey,
  clearZeroProgressStand,
  clearZeroProgressTarget,
  formatActionZeroProgress,
  formatApproachLeg,
  formatDescendRetired,
  formatRetrieveRetired,
  formatRetrieveRouteBlocked,
  formatRouteSpent,
  formatRouteStageFailed,
  isZeroProgressRouteKind,
  observeZeroProgressRoute,
  routeFailureStage,
  routeSignature,
  ROUTE_ALL_SPENT_REASON,
  ZERO_PROGRESS_STAND_ROUTE_LIMIT,
} from './zeroProgressRoute.ts'
import type { ZeroProgressRoutes } from './zeroProgressRoute.ts'
import { formatDigRouteProgress, formatDigRouteRefused } from './digRoute.ts'
import { formatLevelScanStep } from './levelScan.ts'
import { BRIDGE_AUTHORITY_META, BRIDGE_REFUSED_META, isBridgeMove } from './bridgeRoute.ts'
import type { DigRouteRefusal } from './digRoute.ts'
import { StubSystem2 } from './system2.ts'
import type { LlmSummonReason, System2Brain, System2Objective, System2Outcome, System2PlanRequest } from './system2.ts'
import { evaluateSystem2Apply, formatSystem2Discard, system2BodyOwned } from './system2Authority.ts'
import type { System2ApplyState, System2RequestContext } from './system2Authority.ts'
import {
  evaluateBetaTerminationBoundary,
  evaluateCandidateStarvationBoundary,
  shouldWakeSystem2AfterLocalFailure,
} from './system2Escalation.ts'
import type { BetaTerminationBoundaryDecision } from './system2Escalation.ts'
import {
  formatStrategicNonProgressExhausted,
  resolveStrategicStallHorizon,
  resolveStrategicStallMaxDistinctStates,
  resolveStrategicStallMinBodyProgress,
  strategicStateKey,
  StrategicStallTracker,
} from './strategicStall.ts'
import {
  CriticalDamageTracker,
  formatCriticalDamageEvidence,
  formatCriticalDamageExhausted,
  resolveCriticalDamageLimit,
  sampleHealthTransition,
} from './criticalDamage.ts'
import { computeShadowMetrics } from './shadowMetrics.ts'

export type EscalationReason =
  | 'low_confidence'
  | 'same_failure_3x'
  | 'pathfinder_no_path'
  | 'pathfinder_stuck'
  | 'progress_stall'
  | 'unexpected_world_state'
  | 'all_candidates_invalid'
  /**
   * Every grounded route for the active goal's target is spent (`ROUTE_ESCALATE
   * ... reason=all_routes_spent`) and no approach leg changes the stand cell.
   * This is a STRUCTURAL capability boundary, not a local path/stall signal:
   * code proved it can ground no route at all, so WHAT comes next belongs to
   * System2. It is deliberately NOT in the facade's `LOCAL_POLICY_ESCALATIONS`.
   */
  | 'route_exhausted'
  | 'goal_complete'
  | 'unknown_event'
  | 'policy_error'

/**
 * Which exception reason wakes System 2. This is the Jev -> LLM bridge: every
 * escalation the mechanical layer detects becomes one of the five documented
 * `LlmSummonReason`s (see system2.ts).
 */
const ESCALATION_TO_SUMMON: Record<EscalationReason, LlmSummonReason> = {
  low_confidence: 'need_llm',
  same_failure_3x: 'action_impossible',
  pathfinder_no_path: 'action_impossible',
  pathfinder_stuck: 'action_impossible',
  progress_stall: 'no_progress',
  unexpected_world_state: 'unknown_situation',
  all_candidates_invalid: 'action_impossible',
  route_exhausted: 'action_impossible',
  goal_complete: 'queue_empty',
  unknown_event: 'unknown_situation',
  policy_error: 'unknown_situation',
}

/**
 * Keep the active furnace prerequisite's semantic envelope closed.
 *
 * A furnace route may need a mechanically-derived acquisition step (for
 * example clearing headroom before retrieving a remembered crafting table),
 * so those candidates inherit the selected `prereqPath` from candidates.ts.
 * Safety and control remain available regardless of the selected route.  An
 * untagged productive candidate is not a safe fallback: allowing it here
 * silently replaces the selected prerequisite with a different semantic goal
 * and was the source of the exact-run `CRAFT:stick` detour.
 */
export function filterFurnacePrerequisiteCandidates(
  candidates: readonly Candidate[],
  chosen: PrereqPath | null,
): Candidate[] {
  return candidates.filter((candidate) => {
    if (
      candidate.kind === 'ATTACK' ||
      candidate.kind === 'EAT' ||
      candidate.kind === 'EQUIP' ||
      candidate.kind === 'RETREAT' ||
      candidate.kind === 'WAIT' ||
      candidate.kind === 'ESCALATE'
    ) {
      return true
    }
    const role = candidate.meta.prerequisiteRole
    return role === FURNACE_PREREQUISITE_ROLE && chosen !== null && candidate.meta.prereqPath === chosen
  })
}

export interface JevAgentOptions {
  goalItem: string
  goalCount: number
  /** maximum time between decisions while idle (the fallback heartbeat) */
  heartbeatMs: number
  /** which world events may request a decision */
  enabledTriggers: readonly DecisionTrigger[]
  /** coalescing window for bursty events */
  schedulerCoalesceMs: number
  /** floor between decision starts; keeps a fast-failing action from hot-looping */
  minDecisionIntervalMs: number
  minJevIntervalMs: number
  lowConfidenceThreshold: number
  stallMs: number
  wedgeRepeatLimit: number
  /**
   * Consecutive WAITs on the SAME goal before the goal is treated as a wedge and
   * replaced (issue #43). Deliberately much smaller than `wedgeRepeatLimit`: a
   * WAIT is a no-op, so it must never be chosen indefinitely.
   */
  waitLimit: number
  wedgeStallMs: number
  failureStreakLimit: number
  candidateFailureLimit: number
  escalationCooldownMs: number
  escalationWindowMs: number
  /** minimum spacing between LLM summons, per reason */
  llmCooldownMs: number
  /** stop the run as soon as the configured objective is complete */
  finishOnObjectiveComplete: boolean
  /**
   * M1 mode: the planner supplies the plan exactly once at start and is then
   * never invoked again (escalations are recorded but do not call the LLM).
   */
  singleShotPlanner: boolean
  maxRuntimeMs: number
  /** durable goal-queue ledger path; null disables phase persistence */
  ledgerPath: string | null
  /** stop successfully once this many subgoals are done (0 = run to plan end) */
  stopAfterSubgoals: number
  jevTimeoutMs: number
  jevMaxRetries: number
  jevRateLimitRetries: number
  jevRateLimitBaseDelayMs: number
  logDir: string
  forceFallbackPolicy: boolean
  /**
   * Resident host terminator. When set, an exhausted Jev model call logs FATAL
   * and exits the process instead of degrading to a synthetic WAIT. Tests omit
   * it and observe the thrown FatalModelError.
   */
  terminateOnModelFailure?: () => never
  /**
   * #22: `false` (default) keeps `abandon_option` shadow-only: it is recorded
   * as a `BETA_SHADOW` vote and can never, by itself, cause a replan/abandon.
   * `true` is the explicit #24 opt-in that lets a threshold-crossing beta drive
   * a replan, still subject to the deterministic prerequisite guard.
   */
  betaAuthority: boolean
  /**
   * #79: after this many settled attempts with `verified=false && progress=0`,
   * an abandon request is enforced even while `betaAuthority=false` (shadow).
   * A never-attempted option stays protected (speculative suppression).
   */
  unproductiveAttemptLimit: number
  /** #79: how long an enforced option stays retired before it may be retried. */
  abandonCooldownMs: number
  verbose: boolean
  scanRadius: number
  reach: number
  maxCandidateAgeTicks: number
  pathTimeoutMs: number
  digTimeoutMs: number
  actuation: ActuationMode
  /**
   * #38: the resident's allowlist actuation capability. When provided, the
   * executor routes raw movement packets, entity-pose writes and stock
   * collectblock through it (each asserts the actuation lease) instead of
   * touching `bot._client`/`bot.collectBlock`/`bot.entity` directly. Absent in
   * standalone runs and unit tests, where the stock actuator is used.
   */
  actuationPort?: ActuationPort
  /**
   * Mirror of the movement markers (DIG_PATH/STAIRCASE/DESCEND_LIMIT/...) into an
   * external sink (the resident log). The controller's own logger writes to the
   * run JSONL; the resident's acceptance harness reads these markers from
   * `buddy.log`, so a generation can forward them without the host changing.
   */
  eventSink?: (event: string, detail: Record<string, unknown>) => void
  /** durable known-resource coordinates injected by the resident host (issue #43) */
  knownResources?: KnownResource[]
  /**
   * #prereq-dominated: code-owned proof that an unfinished queued prerequisite's
   * purposes are already fulfilled by better items the bot holds. The resident
   * passes the deterministic ladder closure; returning null keeps the row under
   * the normal #55 / orphan reconciliation. Absent in standalone tests.
   */
  dominatedGoalReason?: (
    goal: QueuedGoal,
    counts: Readonly<Record<string, number>>,
  ) => DominatedPrerequisiteDecision | null
  /**
   * #plan-reconciliation: the LIVE plan/objective identity the durable queue is
   * reconciled against. The resident derives it from the same durable-aware
   * ladder frontier that seeds the controller, so a plan whose frontier has moved
   * on is a typed fact, not a guess. The objective item/count ride along as
   * evidence; the COMPARISON is the frontier projection (`planIdentityId`).
   * Absent in standalone tests / deterministic baselines, where the whole
   * reconciliation stays inert and behaviour is unchanged.
   */
  planIdentity?: () => PlanIdentity | null
  /**
   * #plan-reconciliation: code-owned proof that a row authored under a
   * superseded plan is obsolete for the CURRENT objective. Returning null keeps
   * the row: "the plan that authored me is gone" alone is never obsolescence.
   */
  supersededGoalReason?: (goal: QueuedGoal, identity: PlanIdentity) => PlanObsoleteProof | null
  /** coordinate-level movement failures restored from the resident's class-A memory */
  moveFailureEntries?: readonly MoveFailEntry[]
  /** called after movement failure memory changes so the HOST can persist a DTO snapshot */
  onMoveFailureMemoryChange?: (entries: readonly MoveFailEntry[]) => void
  /**
   * #44: minimum spacing between replans for the same summon reason. A second
   * replan inside the window (with unchanged inputs) reuses the current plan.
   */
  replanThrottleMs: number
  /** #44: position delta in blocks that counts as new information. */
  replanPositionDelta: number
  /**
   * #78: consecutive zero-progress (`no_new_info`) throttled replan cycles for
   * the same (reason, goal, stateHash) after which the local recovery is
   * declared exhausted and System2 is woken (`LOCAL_RECOVERY_EXHAUSTED`).
   * `BUDDY_REPLAN_NO_INFO_ESCALATE_CYCLES` overrides it.
   */
  replanNoInfoEscalateCycles: number
  /**
   * Issue #78 follow-up: consecutive identical typed ACTION failures for the
   * same `(plan, actionId, failureReason)` after which the local recovery is
   * declared exhausted and System2 is woken (`ACTION_FAILURE_EXHAUSTED`).
   * `BUDDY_ACTION_FAILURE_ESCALATE_CYCLES` overrides it. Distinct from the
   * replan-throttle bound above: that one counts suppressed replans, this one
   * counts the same action failing the same way inside the executor.
   */
  actionFailureEscalateCycles: number
  /**
   * Issue #327 follow-up: consecutive chosen WAIT decisions while real
   * actionable candidates exist, after which the local recovery is declared
   * exhausted and System2 is woken (`WAIT_EXHAUSTED`).
   * `BUDDY_WAIT_STREAK_ESCALATE_CYCLES` overrides it.
   */
  waitStreakEscalateCycles: number
  /**
   * Control-action abandon-deferral bound (live defect, d428d1c/m3-live): a
   * beta abandon requested above threshold while the only action is a control
   * action (WAIT/ESCALATE) is deferred at most this many consecutive times for
   * the same `(plan, action, reason)` before it is honored. Verified progress or
   * a plan change resets the streak.
   * `BUDDY_BETA_ABANDON_DEFER_CYCLES` overrides it.
   */
  betaAbandonDeferCycles: number
  /**
   * #11 v2: furnace-prerequisite ordering. `cost` (default) selects the cheapest
   * feasible path and shadow-logs the #78 rank order; `rank` restores the rank
   * order for A/B. `BUDDY_PREREQ_RANK_POLICY=rank` switches it.
  */
  prereqRankPolicy: PrereqRankPolicy
  /** resident world epoch captured when this controller generation was created */
  worldEpoch: number
}

export const defaultJevAgentOptions: JevAgentOptions = {
  goalItem: 'oak_log',
  goalCount: 1,
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
  betaAuthority: resolveBetaAuthority(),
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
  betaAbandonDeferCycles: resolveBetaAbandonDeferCycles(),
  prereqRankPolicy: resolvePrereqRankPolicy(),
  worldEpoch: 0,
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

/** Safety-critical events: an incompatible threat makes the Jev answer stale. */
export const CRITICAL_TRIGGERS: ReadonlySet<DecisionTrigger> = new Set<DecisionTrigger>([
  'damage_taken',
  'hp_changed',
  'mob_appeared',
  // Breath running out is the same class of safety event as an injury: a
  // semantic WHAT decision taken before the body started drowning must not
  // still authorize building/placing. It shares the `injury` family below
  // because drowning IS injury damage in progress - the air gauge is simply an
  // earlier, cheaper signal than the first drowning hit.
  'low_air',
])

type CriticalThreatFamily = 'injury' | 'mob'

function criticalThreatFamily(trigger: DecisionTrigger): CriticalThreatFamily {
  return trigger === 'mob_appeared' ? 'mob' : 'injury'
}

const STALL_TRIGGERS: ReadonlySet<DecisionTrigger> = new Set<DecisionTrigger>([
  'path_stuck',
  'path_no_path',
  'action_timeout',
])

/** Pick the CORE + trigger-specific question set (P1-7). */
export function questionSetForTrigger(trigger: DecisionTrigger): QuestionSetKind {
  if (CRITICAL_TRIGGERS.has(trigger)) return 'threat'
  if (STALL_TRIGGERS.has(trigger)) return 'stall'
  return 'core'
}

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
const WAIT_REPLAN_LIMIT = 4
/**
 * A `surface` goal whose ascent plan is refused AND whose tick offers no
 * body-changing route at all is marked `impossible` after this many consecutive
 * candidate generations under the same refusal signature. Bounded so a
 * transient blocked column never abandons a satisfiable Option.
 */
const SURFACE_ASCENT_IMPOSSIBLE_STREAK = 3
/** Issue #45: an active RETRIEVE that stops closing distance for this many ticks escalates. */
const RETRIEVAL_STALL_TICKS = resolveRetrievalStallTicks()
/** Issue #41: a descend goal with no vertical progress for this many ticks escalates. */
const DESCEND_STALL_TICKS = resolveDescendStallTicks()
/** Issue #41: a descend goal with no executable descend candidate this long escalates. */
const DESCEND_NO_CANDIDATE_TICKS = resolveDescendNoCandidateTicks()
/** Distance decrease (m) that counts as real retrieval progress. */
const RETRIEVAL_PROGRESS_EPSILON = 0.5
/** Issue #8: failed attempts at one coordinate before it is blacklisted. */
// Below this windowed locomotion efficiency a verified MOVE is mechanical success
// without progress, so it must not clear the failure memory (issue #360).
const MOVE_PROGRESS_EFFICIENCY_FLOOR = resolveEnvPositiveInt('BUDDY_MOVE_PROGRESS_EFFICIENCY_FLOOR', 20)
/** #405: how many recently occupied cells the exploration fallback treats as visited. */
const EXPLORED_CELLS_LIMIT = 512
const MOVE_FAILMEM_LIMIT = resolveEnvPositiveInt('BUDDY_MOVE_FAILMEM_LIMIT', 3)
/** Issue #8: how long a blacklisted coordinate stays skipped. */
const MOVE_FAILMEM_COOLDOWN_MS = resolveEnvPositiveInt('BUDDY_MOVE_FAILMEM_COOLDOWN_MS', 30_000)
/** Issue #8: bound on tracked coordinates (least-failed/oldest evicted first). */
const MOVE_FAILMEM_MAX_ENTRIES = resolveEnvPositiveInt('BUDDY_MOVE_FAILMEM_MAX_ENTRIES', 256)
/** Issue #8: do not re-log the same oscillating pair more often than this. */
const OSCILLATION_REPEAT_LOG_MS = 5_000

function resolveEnvPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
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

/** A guard-level NO_PATH is a real movement failure, not merely a policy rejection. */
export function guardMoveFailureReason(
  candidate: Pick<Candidate, 'kind'> | undefined,
  code: GuardCode,
): MoveFailureReason | null {
  if (candidate === undefined || !isTrackedMoveKind(candidate.kind)) return null
  return code === 'NO_PATH' ? 'unreachable' : null
}

/**
 * Zero-progress known-resource retrieves before the resource is retired.
 * Bounded like UNVERIFIED_ACTION_LIMIT: the retrieve already proved it closed no
 * distance, gained no altitude and dug no step.
 */
export const KNOWN_RETRIEVE_RETIRE_LIMIT = 2

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

/**
 * A remembered resource can be PRESENT yet unreachable (a y=68 log from y=59
 * with `canDig=false`), so the durable staleness proof never retires it - that
 * proof only drops ABSENT/replaced cells. The retrieval-stall timer is keyed on
 * the candidate id, which carries the resource coordinate, so every time the
 * nearest known resource changes the timer resets and the plan loops through the
 * same unreachable list. Retire the resource after a bounded number of
 * zero-progress retrieves so the generator moves to the next resource / branch.
 */
export function shouldRetireKnownRetrieve(input: KnownRetrieveRetireInput): boolean {
  if (input.retrieval !== 'known') return false
  if (input.target === null) return false
  if (input.verified) return false
  return input.attempts >= Math.max(1, Math.floor(input.limit ?? KNOWN_RETRIEVE_RETIRE_LIMIT))
}

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
export function knownRetrieveMadeProgress(
  result: Pick<ExecutionResult, 'status' | 'verified' | 'itemsGained' | 'blockRemoved' | 'progressed'>,
): boolean {
  return result.status === 'done' && result.verified && hasObservableProgress(result)
}

/** What `retireFailedKnownRetrieve` must do with one finished known-resource retrieve. */
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
export function shouldClearActiveRetrieval(input: {
  retrieval: unknown
  hasObservableProgress: boolean
  arrived: boolean
}): boolean {
  if (!input.hasObservableProgress) return false
  if (input.retrieval !== 'known') return false
  return input.arrived
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

/**
 * The queue op the single-shot bootstrap plan is actually applied with.
 *
 * buddy-driver restores the durable host ledger into the controller queue
 * BEFORE `controller.start()` (`generation-entry.ts` -> `restoreLedgerIntoController`)
 * and resident mode passes `ledgerPath: null`, so the controller's own
 * post-plan `loadLedger()` cannot re-read it. When a plan with `op=replace`
 * arrived a non-empty queue was wiped anyway: live run-mu8kgmjm-ujwg restored
 * `current=smelt 3 x iron_ingot` and 74 ms later logged `QUEUE_DEPTH op=replace
 * reason=bootstrap`; the ladder's `craft 1 x iron_pickaxe` took the head and no
 * SMELT/FURNACE marker was ever emitted. A restored, not-yet-done goal is work
 * the bot already committed to, so bootstrap merges the ladder BEHIND it
 * (`continue`) instead of replacing it. Not smelt-specific: any restored head is
 * preserved. An empty queue (fresh bootstrap) keeps the requested op unchanged,
 * and an explicit `abort` is never overridden.
 */
/**
 * Pure decision behind the orphaned-smelt prerequisite retirement. A
 * `smelt:iron_ingot` row exists only to feed a craft that consumes the ingot, so
 * it is obsolete once that craft's product is held (`held`) and nothing live
 * wants an iron ingot (`stillWanted`). Returns the audit reason, or null to keep
 * the normal #55 protection. Exported so the decision is fixture-testable
 * without a bot.
 */
export function orphanedSmeltPrerequisiteReason(input: {
  kind: string
  item: string | null
  held: number
  stillWanted: boolean
}): string | null {
  if (input.kind !== 'smelt' || input.item !== IRON_INGOT) return null
  if (input.stillWanted || input.held < 1) return null
  return `orphaned smelt prerequisite: ${FLINT_AND_STEEL}=${input.held} and no live row or incoming goal requires ${IRON_INGOT}`
}

export function resolveBootstrapPlanOp(queue: GoalQueue, requested: PlanOp | undefined): PlanOp {
  const op = requested ?? 'replace'
  if (op === 'replace' && queue.current !== null) return 'continue'
  return op
}

function resourceKey(resource: { name: string; position: Vec3Json }): string {
  return `${resource.name}@${resource.position.x},${resource.position.y},${resource.position.z}`
}

/** Drop resources the controller has proven unreachable for the current plan. */
export function filterKnownResources(
  resources: readonly KnownResource[],
  unreachable: ReadonlySet<string>,
): KnownResource[] {
  return resources.filter((resource) => !unreachable.has(resourceKey(resource)))
}

/**
 * `KNOWN_RESOURCE_FALSIFIED item=<item> name=<name> cell=<x,y,z> reason=<reason>`.
 *
 * A remembered cell the loaded world PROVED wrong: `block_mined` (the block is
 * gone/replaced), `mob_gone` (the landmark stands but no producer is inside the
 * entity envelope) or `drop_absent` (the cell was remembered as the item itself
 * and nothing holds it). Typed truth, never a preference.
 */
export function formatKnownResourceFalsified(
  item: string,
  name: string,
  cell: Vec3Json,
  reason: KnownResourceFalsifiedReason,
): string {
  return `KNOWN_RESOURCE_FALSIFIED item=${item} name=${name} cell=${cell.x},${cell.y},${cell.z} reason=${reason}`
}

/** `KNOWN_RESOURCE_RESIGHTED item=<item> name=<name> cell=<x,y,z> source=mob|drop`. */
export function formatKnownResourceResighted(
  item: string,
  name: string,
  cell: Vec3Json,
  source: 'mob' | 'drop',
): string {
  return `KNOWN_RESOURCE_RESIGHTED item=${item} name=${name} cell=${cell.x},${cell.y},${cell.z} source=${source}`
}

/**
 * `KNOWN_RESOURCE_RETIRED item=<item> cell=<x,y,z> attempts=<n>`.
 *
 * The bounded-retire boundary (`decideKnownRetrieve`) dropped a remembered cell
 * as unreachable after `attempts` zero-progress retrieves. The cell was PRESENT
 * but this body could not close it: retirement is per-cell and unrelated to the
 * falsification reasons above (a merely unreachable resource is not disproved).
 */
export function formatKnownResourceRetired(item: string, cell: Vec3Json, attempts: number): string {
  return `KNOWN_RESOURCE_RETIRED item=${item} cell=${cell.x},${cell.y},${cell.z} attempts=${attempts}`
}

/** Dedupe state for remembered-cell verdict lines (one per generation). */
export interface KnownResourceVerdictLatch {
  /** `<item>:<name>@<cell>:<reason>` already reported */
  falsified: Set<string>
  /** `<item>:<name>@<cell>` re-sight already reported */
  resighted: Set<string>
}

export type KnownResourceVerdict =
  | { kind: 'none' }
  | { kind: 'falsified'; reason: KnownResourceFalsifiedReason }
  | { kind: 'resighted'; source: 'mob' | 'drop' }

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
export function nextKnownResourceVerdict(
  latch: KnownResourceVerdictLatch,
  evidence: Pick<KnownResourceEvidence, 'item' | 'name' | 'position' | 'status' | 'reason' | 'source'>,
): KnownResourceVerdict {
  const base = `${evidence.item}:${evidence.name}@${evidence.position.x},${evidence.position.y},${evidence.position.z}`
  if (evidence.status === 'falsified') {
    const reason: KnownResourceFalsifiedReason = evidence.reason ?? 'block_mined'
    const key = `${base}:${reason}`
    if (latch.falsified.has(key)) return { kind: 'none' }
    latch.falsified.add(key)
    latch.resighted.delete(base)
    return { kind: 'falsified', reason }
  }
  if (evidence.status !== 'present' && evidence.status !== 'replaced') return { kind: 'none' }
  const withheld = [...latch.falsified].some((key) => key.startsWith(`${base}:`))
  for (const key of [...latch.falsified]) {
    if (key.startsWith(`${base}:`)) latch.falsified.delete(key)
  }
  if (evidence.source === undefined || !withheld || latch.resighted.has(base)) return { kind: 'none' }
  latch.resighted.add(base)
  return { kind: 'resighted', source: evidence.source }
}

function knownResourceVerdictDetail(
  evidence: KnownResourceEvidence,
  reason: KnownResourceFalsifiedReason | null,
): Record<string, unknown> {
  return {
    item: evidence.item,
    name: evidence.name,
    cell: evidence.position,
    observed: evidence.observed,
    claim: evidence.claim,
    ...(reason === null ? {} : { reason }),
    ...(evidence.source === undefined ? {} : { source: evidence.source }),
  }
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
): { added: boolean; station: KnownResource } {
  const station: KnownResource = {
    name: item,
    kind: 'station',
    position: { x: Math.round(at.x), y: Math.round(at.y), z: Math.round(at.z) },
  }
  const cellKey = (entry: { name: string; position: Vec3Json }): string =>
    `${entry.name}@${Math.round(entry.position.x)},${Math.round(entry.position.y)},${Math.round(entry.position.z)}`
  const key = cellKey(station)
  if (stations.some((entry) => cellKey(entry) === key)) return { added: false, station }
  stations.push(station)
  return { added: true, station }
}

/** A guard path probe is synchronous; this caps how long it may think. */
const PATH_PROBE_TIMEOUT_MS = 750
const { goals } = pathfinderModule

function normalizeOptions(options: JevAgentOptions): JevAgentOptions {
  return { ...options, reach: Math.min(options.reach, MAX_BLOCK_REACH) }
}

export interface WaitWedgeInput {
  actionId: string
  goalKey: string
  previousGoalKey: string | null
  streak: number
  waitLimit: number
  replans: number
  replanLimit: number
}

export interface WaitWedgeDecision {
  outcome: 'not-wait' | 'below-limit' | 'replan' | 'wedge'
  streak: number
  goalKey: string
  n: number
}

export function evaluateWaitWedge(input: WaitWedgeInput): WaitWedgeDecision {
  if (input.actionId !== 'WAIT') return { outcome: 'not-wait', streak: 0, goalKey: input.goalKey, n: 0 }
  const streak = input.goalKey === input.previousGoalKey ? input.streak + 1 : 1
  if (streak < input.waitLimit) return { outcome: 'below-limit', streak, goalKey: input.goalKey, n: streak }
  if (input.replans < input.replanLimit) return { outcome: 'replan', streak: 0, goalKey: input.goalKey, n: streak }
  return { outcome: 'wedge', streak: 0, goalKey: input.goalKey, n: streak }
}

/** #11 v2 §7: a repeat is only a wedge when the world stands still under it. */
export type WedgeSuppressReason = 'progressing' | 'in_flight' | 'fingerprint_changed'

export interface WedgeRepeatInput {
  actionId: string
  previousActionId: string | null
  fingerprint: string
  previousFingerprint: string | null
  inFlight: boolean
  progressed: boolean
  repeats: number
}

export interface WedgeRepeatDecision {
  outcome: 'count' | 'suppress'
  reason: WedgeSuppressReason | null
  /** next consecutive count; 0 after a suppression, 1 on a window restart. */
  repeats: number
  restarted: boolean
}

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
export function evaluateWedgeRepeat(input: WedgeRepeatInput): WedgeRepeatDecision {
  if (input.progressed) return { outcome: 'suppress', reason: 'progressing', repeats: 0, restarted: false }
  if (input.inFlight) return { outcome: 'suppress', reason: 'in_flight', repeats: 0, restarted: false }
  if (input.previousActionId !== input.actionId) {
    return { outcome: 'count', reason: null, repeats: 1, restarted: true }
  }
  if (input.previousFingerprint !== null && input.previousFingerprint !== input.fingerprint) {
    return { outcome: 'suppress', reason: 'fingerprint_changed', repeats: 0, restarted: false }
  }
  return { outcome: 'count', reason: null, repeats: input.repeats + 1, restarted: false }
}

export function formatWedgeSuppressed(reason: WedgeSuppressReason, candidate: string, repeats: number): string {
  return `WEDGE_SUPPRESSED reason=${reason} candidate=${candidate} repeats=${repeats}`
}

/** Kept byte-identical to the pre-fix genuine-wedge abort message. */
export function formatWedgeAbort(actionId: string, repeats: number, limit: number): string {
  return `action id ${actionId} chosen ${repeats}x with no verified progress (limit ${limit})`
}

interface PendingDecision {
  record: DecisionRecord
  healthAtDecision: number
}

/** #79: the controller's actual abandon decision for one Jev result. */
interface AbandonVerdict {
  adopt: boolean
  enforced: boolean
  suppressed: boolean
  classification: AbandonClassification
  vote: BetaAuthorityDecision
  optionId: string | null
  planId: string | null
}

export const MIRRORED_MARKERS: ReadonlySet<string> = new Set([
  // Issue #437: the two evidence planes must both be live-visible. Without these
  // in the mirrored list the live sink DROPS them, and a reviewer cannot
  // reconstruct what Jev knew (`JEV_STATE_PROJECTION`/`JEV_CANDIDATE_SET`), which
  // epoch allowed the Skill to act (`SKILL_COMMIT`), why Jev was asked again
  // (`JEV_DECISION_EPOCH_*`), what semantics came back (`SKILL_OUTCOME_PACKET`),
  // or that a late model result was rejected (`STALE_JEV_RESULT_DROPPED`).
  'JEV_DECISION_EPOCH_START',
  'JEV_STATE_PROJECTION',
  'JEV_CANDIDATE_SET',
  'JEV_DECISION_EPOCH_END',
  'SKILL_COMMIT',
  'SKILL_OUTCOME_PACKET',
  'STALE_JEV_RESULT_DROPPED',
  'JEV_HEADS',
  'BETA_SHADOW',
  'CAUSAL',
  'SHADOW_METRICS',
  'TOOL_CHOICE',
  'QUEUE_DEPTH',
  'PLACE_REFUSED',
  'DIG_PATH',
  'JUMP_ATTEMPT',
  'JUMP_FAIL',
  'JUMP_ESCAPE',
  'DESCEND_LIMIT',
  'STAIRCASE',
  'REUSE_TUNNEL',
  'TUNNEL_ENTRY_REFUSED',
  'LOCAL_CLEAR',
  'ASCEND_STEP',
  'ASCENT_PROGRESS',
  // The descent half of the vertical vocabulary: a refused local descent names
  // its missing precondition, and a durable descent chunk is run evidence
  // (a `descend_plan` refusal that was never named is what left the M3 body
  // standing above its own lit gate).
  'DESCENT_REFUSED',
  'DESCENT_CHUNK',
  // The WALL ENTRY (`wallEntry.ts`): the tunnel a body opens when every walk step
  // around it is refused. Without this in the mirrored list the live sink DROPS the
  // one line that says which wall was opened, on which heading, at which level, and
  // that no fluid could reach the pocket - and "the body mined the wall because the
  // pocket is provably dry" cannot be told apart from an ordinary tunnel step.
  'DIG_ROUTE_ENTRY',
  // The BOUNDED LEVEL SCAN (`levelScan.ts`): the descent a body takes when NOTHING at its
  // own level can ground a route and the rock below can. Without these in the mirrored
  // list the live sink DROPS the two lines that say which level the body descended to, which
  // lateral continuation and material the route ends at, the per-level flood verdict, and
  // the distance change - and a descent that is the first step of a route that ends closer
  // cannot be told apart from a blind search descent.
  'LEVEL_SCAN',
  'LEVEL_SCAN_STEP',
  'PORTAL_ENTRY_UNVERIFIED',
  // The bounded direct walk into a non-solid portal cell: the live run needs
  // both the measured motion (`PORTAL_WALK_IN ... transferred=`) and the typed
  // pre-movement refusal, or its log cannot tell "walked in" from "never tried".
  'PORTAL_WALK_IN',
  'PORTAL_WALK_IN_REFUSED',
  // The step-aside onto an open face of the portal: the detour must be visible
  // in the run log, or "the body refused to step one block aside" cannot be
  // told apart from "no leg was ever grounded".
  'PORTAL_APPROACH_LEG',
  'PORTAL_APPROACH_REFUSED',
  // Issue #436: the Skill boundary and the reflex proof must both be live-visible,
  // or a reviewer cannot tell "Jev chose the target" from "code finished it".
  'SKILL_START',
  'SKILL_COMMIT',
  'SKILL_STEP',
  'SKILL_INTERRUPT',
  'SKILL_POLICY_BOUNDARY',
  'SKILL_END',
  'REFLEX',
  'PORTAL_WALK_IN_BLOCKED',
  SKILL_POLICY_BOUNDARY,
  'PILLAR_UP',
  'PILLAR_UP_STEP',
  'PILLAR_FAIL',
  'PILLAR_TAKEOFF',
  'PILLAR_SEARCH',
  'HOP_PLAN',
  'DESCEND_STALLED',
  'DESCEND_PROGRESS',
  'DIG_OSCILLATE',
  'MOVE_OSCILLATE',
  // The per-step landing guard (`stepLanding.ts`): a locomotion leg that stopped
  // BEFORE a lethal step must be visible in the run log, or "the body stopped at
  // the walkway edge" cannot be told apart from "the leg never ran" - the live
  // fortress death (`ENV_HAZARD kind=lava` -> `ENV_HAZARD_NO_EXIT` -> DEATH) was
  // a fall the leg took with no typed line at all.
  MOVE_LEG_STOPPED,
  'MOVE_FAILMEM',
  'MOVE_FAILMEM_RESET',
  'MOVE_TARGET_SKIPPED',
  'OSCILLATION_DETECTED',
  'RETURN_TO_KNOWN_RESOURCE',
  'RETRIEVE_STALLED',
  'LOCAL_RETRIEVAL_STALL',
  'LOCAL_RETRIEVE_RECOVERY',
  'LOCAL_DESCEND_STALL',
  'LOCAL_OSCILLATION_ESCAPE',
  'LOCAL_PROGRESS_STALL',
  'LOCAL_MOVE_OSCILLATION',
  'LOCAL_WAIT_RECOVERY',
  'KNOWN_RESOURCE_STALE',
  'KNOWN_RESOURCE_FALSIFIED',
  'KNOWN_RESOURCE_RESIGHTED',
  'KNOWN_RESOURCE_RETIRED',
  SKILL_END,
  SKILL_INTERRUPT,
  'EXPLORE',
  'REPLAN_THROTTLED',
  'REPLAN_REJECTED',
  'CAPABILITY_GAP',
  'LOCAL_CAPABILITY_GAP',
  'CAPABILITY_GAP_POLICY',
  'CAPABILITY_GAP_CLEARED',
  'RETURN_TO_SURFACE',
  'PRECONDITION_PROTECTED',
  'PLACE_RETRY',
  // Bounded-attempt terminal + typed frame-build causes are run-scoped
  // acceptance evidence: they prove the option was retired and the frame build
  // failed ONCE with a named cause instead of looping on `verify_failed`.
  'PLACE_RETRIES_EXHAUSTED',
  'FRAME_BUILD_INCOMPLETE',
  'FRAME_BUILD_UNGROUNDED',
  'FRAME_BUILD_BLOCKED',
  'PORTAL_FRAME_SITE_REJECTED',
  'PORTAL_FRAME_CELL_CLEARED',
  // Drowning is a P1 durability failure (DEATH ... cause=water, 2026-09-21
  // 16:59:34.792Z). The sensor fact and the scheduler preempt must be on the
  // mirrored event path so a body losing breath is run-scoped evidence rather
  // than only a line in the executor log.
  'BODY_SUBMERGED',
  'LOW_AIR_PREEMPT',
  // SAFE: the body's own environmental hazard (fire/lava/burning/drowning).
  // Measured live (`run-mucaq28q-1ftq1`) the body burned to death in the Nether
  // with ZERO lines naming fire, lava or burning, so these must be on the
  // mirrored path a post-mortem reads. (`REFLEX` / `SKILL_INTERRUPT` are already
  // above: one #436 vocabulary, owned by `netherPortalPlan.ts`.)
  ENV_HAZARD,
  ENV_HAZARD_NO_EXIT,
  ENV_HAZARD_CLEAR,
  'ABANDON_REASON',
  'ABANDON_REASON=retrieve_unverified',
  'PREREQ_OPTION',
  'PREREQ_RANK_SHADOW',
  'PREREQ_SWITCH',
  // OPERATOR RULE (station-use-before-craft): the smelt prerequisite withheld a
  // duplicate station craft because a usable station of that kind already
  // exists. Keep the typed fact on the mirrored event path so a run proves the
  // duplicate was refused for a named reason instead of merely being absent.
  PREREQ_STATION_ALREADY_KNOWN,
  'FURNACE_READY',
  'STATION_REGISTERED',
  'SMELT_DONE',
  'SMELT_INPUT_PREREQ',
  'CRAFT_INGREDIENT_PREREQ',
  CRAFT_STATION_ALREADY_KNOWN,
  // Portal milestones are run-scoped acceptance evidence as well as human
  // diagnostics. Keep them on the same mirrored event path so the host-owned
  // M2 snapshot recorder receives the structured detail object; reconstructing
  // these markers from the all-time JSONL would lose run/generation authority.
  'PORTAL_SUPPORT_PLACED',
  'PORTAL_BLOCK_PLACED',
  'PORTAL_FRAME_READY',
  'PORTAL_LIT',
  'PORTAL_VERIFIED',
  'PORTAL_LIGHT_REFUSED',
  'OSCILLATION_DETECTED',
  'ABANDON_REASON=action_unverified',
  'ACTION_UNVERIFIED',
  ACTION_REJECTED,
  // The route-family vocabulary is run-scoped evidence: a settled route stage
  // failure, the exact route it spends, and a goal whose grounded routes are all
  // spent. Measured live (run-muc620xb-1d312) the recorder DID write
  // `ACTION_ZERO_PROGRESS ... kind=ENTER_PORTAL retry=1..20`, but the marker was
  // not mirrored, so the resident log showed zero of them and the frozen route
  // looked like a route that was never spent. Keep every existing route marker
  // here too (`ACTION_ZERO_PROGRESS`, the retirements, the approach leg) so the
  // next measurement reads the same facts the runtime acted on.
  'ROUTE_STAGE_FAILED',
  'ROUTE_SPENT',
  'ROUTE_ESCALATE',
  'ACTION_ZERO_PROGRESS',
  'DESCEND_RETIRED',
  'RETRIEVE_RETIRED',
  'RETRIEVE_ROUTE_BLOCKED',
  'APPROACH_LEG',
  // #predicate-retire: a row retired because its OWN success predicate already
  // held in world truth is a DONE decision, and the queue transition it causes
  // (the head moving to the next row) is exactly what the measured M3 blocker
  // turned on. Unmirrored it would be invisible in `buddy.log`: the run would
  // show a queue that silently advanced from an M2 row to the `blaze_rods` work
  // with no named reason.
  GOAL_RETIRED_PREDICATE,
  GOAL_SUCCESS_PROBE_ERROR,
  // The dig-route family: the target a travel/enter/retrieve goal could not walk
  // to, the bounded terrain route the offer grounded toward it, the typed cause
  // when even that could not be grounded, and the measured distance gain of a
  // settled dig step. A body sealed in its own shaft produced none of these
  // before (measured run-muc9k936-1f3vb: `presented=['WAIT','ESCALATE']` for
  // minutes while the known gate sat 21 blocks away), so the whole route family
  // must be observable run-scoped.
  'DIG_ROUTE',
  'DIG_ROUTE_REFUSED',
  'DIG_ROUTE_PROGRESS',
  // The BRIDGE/scaffold family (`bridgeRoute.ts`): the leg that places a floor
  // across a same-level gap and advances onto it, its per-step mechanic, its typed
  // end, and the typed reason a needed bridge was refused. A bridge that reaches
  // `buddy.log` only as a `MOVE` would be indistinguishable from an ordinary walk,
  // and the #436 section 5 effect (`mayPlaceBlocks` + the consumed block) would not
  // be auditable run-scoped.
  'BRIDGE_START',
  'BRIDGE_STEP',
  'BRIDGE_END',
  'BRIDGE_REFUSED',
  // A locomotion route's OWN placement declaration (`routePlaceDeclaration.ts`).
  // The measured defect (live: `PILLAR_UP actionId=MOVE:b35_60_-26 ... failed
  // SKILL_ENVELOPE_VIOLATION violation=equip_item_not_declared:cobblestone`, and
  // the sibling `RETRIEVE:known:blaze_rod:b35_60_-22`) is a route that places a
  // block its commitment refused to let it equip. The fix authorizes exactly the
  // block(s) the route DECLARED at candidate time, so which block that was, which
  // meta key declared it, and whether it was actually carried must be readable
  // run-scoped - otherwise a reviewer sees only a different
  // `SKILL_COMMIT effectEnvelopeHash=` with no named cause. Unmirrored markers
  // never reach `buddy.log`, so this one is registered next to its family.
  'ROUTE_PLACE_DECLARED',
  // #436 reflex/continuation vocabulary: a bounded mechanical continuation that is
  // the UNIQUE binding prerequisite of the active leg (`REFLEX
  // reason=unique_binding_prerequisite`) and the mechanical step when it runs.
  'REFLEX',
  'SKILL_STEP',
  'SKILL_POLICY_BOUNDARY',
  'REACHABILITY',
  'CANDIDATE_WITHHELD',
  'CANDIDATE_STARVATION',
  'RESOURCE_SOURCE_NONE',
  // The M3 producer side of the same observability rule. A pearl need with no
  // sensed enderman produced MOVEs and nothing else in the run log: no marker
  // named the need, its producer mob, the absence of any sensed instance, or the
  // grounded search the tick was offering. `MOB_DROP_SOURCE_NONE` is that fact.
  'MOB_DROP_SOURCE_NONE',
  // A hunt is a bounded Skill; how it ended is run-scoped evidence, not a
  // private executor line. The measured live shape (an enderman that left the
  // tracked set before the first swing) reached only `status=failed`, so the
  // mechanical cause was unrecoverable from the log.
  'HUNT_END',
  'HUNT_RETARGET',
  'HUNT_TARGET_LOST',
  'HUNT_REACQUIRE_EXHAUSTED',
  // The HOVER half of the same vocabulary. Every measured blaze hunt ended
  // `HUNT_END ... reason=out_of_range swings=0 hits=0`, which reads as a failed
  // attempt; the mechanical cause was that a producer hovering above the walkway
  // has a vertical contact component no walk can express. A target the body's melee
  // envelope provably cannot be brought onto is now a NAMED fact (the contact
  // geometry, the vertical planner's own refusal, and the carried block a pillar
  // would consume), so unreachable and merely-missed are distinct run evidence.
  'HUNT_CONTACT_UNREACHABLE',
  // Starvation is a run-scoped survival fact, not a private diagnostic. The
  // measured live failure (run-muc0l5fp-158ak: `food=0` for the whole run, the
  // body pinned at the server's 1 HP starvation floor) emitted BODY_STARVING and
  // FOOD_LOW to the generation console only, because neither token rode the
  // mirrored event path - the run log showed a body doing heavy work with no
  // visible reason. Keep the whole hunger vocabulary mirrored so the state, the
  // refusal, the grounded route and the bounded dead end are all run evidence.
  'BODY_STARVING',
  'CRITICAL_DAMAGE',
  'CRITICAL_DAMAGE_EXHAUSTED',
  // Mob-fight state is run-scoped survival evidence, exactly like the hunger and
  // critical-damage vocabulary above. Measured live (run-muc3qbug-18vg3): the
  // body died in the Nether 18 s after arriving, and `THREAT_NEARBY` - which
  // names the mob, its distance, contact/danger, the code-owned weapon and
  // whether the body can regenerate - had been written 8 times to the
  // generation event stream but NEVER to buddy.log (0 occurrences in 71 MB),
  // because none of the threat tokens rode the mirrored event path. A
  // post-mortem of the death window therefore could not see that a spider was
  // inside melee contact. Keep the whole threat vocabulary, plus the
  // survival-regrounding pair, on the mirrored path.
  THREAT_NEARBY,
  THREAT_NO_ESCAPE,
  THREAT_CLEAR,
  SURVIVAL_REGROUND,
  SURVIVAL_NO_GROUNDED_ACTION,
  // The bounded identity-churn adoption (`threat.ts`): the one line that says a
  // chosen ATTACK's entity id was replaced by the SAME mob kind at the SAME place
  // while the body kept fighting it. Unmirrored, a reviewer sees only
  // `SURVIVAL_REGROUND`/`TARGET_LOST` and cannot tell a churn fight from a threat
  // that genuinely died, so the identity proof must ride the live sink.
  MOB_IDENTITY_CHURN,
  GUARD_REJECTIONS,
  'COMBAT_KIT_GAP',
  THREAT_RANGED_UNANSWERED,
  THREAT_BREAK_CONTACT,
  DEATH_CAUSE,
  'FOOD_LOW',
  'EAT_REFUSED',
  'FOOD_ROUTE',
  'FOOD_ACQUIRED',
  FOOD_SOURCE_NONE,
  'LOG_ROUTE',
  'WEDGE_SUPPRESSED',
  PROTECTION_ABANDON_CONFLICT,
  CANDIDATE_FLAP,
  CANDIDATE_COMMIT_RELEASED,
  ACTION_COMMIT,
  ACTION_PREEMPT,
  WAIT_STREAK_MARKER,
  WAIT_EXHAUSTED_MARKER,
  BETA_ABANDON_DEFERRED_MARKER,
  BETA_ABANDON_RELEASED_MARKER,
  'BETA_DEFERRED',
  // Issue #436 section 17: three evidence lines were EMITTED but never mirrored, so the live
  // sink dropped them and a reviewer saw only the downstream outcome (`failure=effect_envelope_violation`
  // without WHICH effect or WHY). The envelope refusal is the fail-closed boundary itself, and the
  // invalidation/selection lines are the rest of the commitment lifecycle; all three belong in the
  // live record.
  'SKILL_ENVELOPE_VIOLATION',
  'SKILL_INVALIDATED',
  'SKILL_SELECTED',
  // #plan-reconciliation: the objective-identity reconciliation and the bounded
  // cross-dimension escalation. Unmirrored markers never reach buddy.log, which
  // is how the measured `g1:descend:raw_iron`-while-in-the-Nether stall stayed
  // invisible: the row's own predicate was unsatisfied, so no existing boundary
  // had anything to say about it.
  PLAN_IDENTITY_CHANGED,
  PLAN_ROW_RETIRED,
  ROW_NOT_EXECUTABLE_HERE,
  ROW_DEFERRED_NOT_EXECUTABLE_HERE,
  'NO_PRODUCTIVE_HEAD_BOUND',
])

/**
 * Return the canonical host-event name for a marker-prefixed log message.
 * `PORTAL_VERIFIED=true` is a value-bearing marker in the human-readable line,
 * but the host recorder owns the boolean in `detail.verified` and must receive
 * the stable semantic event name `PORTAL_VERIFIED`.
 */
export function mirroredEventToken(message: string): string | null {
  const token = message.split(' ')[0]
  if (token === undefined) return null
  if (token.startsWith('PORTAL_VERIFIED=')) return 'PORTAL_VERIFIED'
  return MIRRORED_MARKERS.has(token) ? token : null
}

/**
 * Starvation marker: the candidate set offered to the policy has no productive
 * option, so the only possible answers are WAIT/ESCALATE. `NO_PRODUCTIVE_CANDIDATE`
 * already warned about this, but it was not a mirrored marker, so it never
 * surfaced as the binding condition. Pure and exported so the contract is
 * unit-testable without a bot.
 *
 * The line has exactly one meaning per field:
 *   - `blockedBy` is the CURRENT GOAL's own deterministic blocker (its unmet
 *     precondition, else its own target's refusal reason, else
 *     `no_productive_action`). It is never a withheld sibling's reason.
 *   - `missing` is the ordered, bounded union of each withheld candidate's
 *     missing capability, tagged with that candidate's id:
 *     `["MINE:b40_10_33:tool:pickaxe@0","RETRIEVE:known:x:needs_ascend"]`.
 */
export function formatCandidateStarvation(
  presented: number,
  goal: string,
  blockedBy: string,
  missing: readonly string[] = [],
): string {
  const all = missing.length > 0 ? ` missing=${JSON.stringify(missing)}` : ''
  return `CANDIDATE_STARVATION presented=${presented} productive=0 goal="${goal}" blockedBy=${blockedBy}${all}`
}

export function candidateStarvationLine(
  candidates: readonly Candidate[],
  goal: string,
  goalComplete: boolean,
  blockedBy: string,
  missing: readonly string[] = [],
): string | null {
  if (goalComplete) return null
  const productive = candidates.some((candidate) => candidate.kind !== 'WAIT' && candidate.kind !== 'ESCALATE')
  return productive ? null : formatCandidateStarvation(candidates.length, goal, blockedBy, missing)
}

/** Upper bound on the `missing=[...]` union so the marker stays one readable line. */
export const MAX_STARVATION_MISSING = 8

/**
 * Each withheld candidate's missing capability, in candidate order, each token
 * tagged with its candidate id (`<candidateId>:<capability>`). A candidate whose
 * refusal names no capability contributes its reason instead, so no withheld
 * target is silently dropped. Deduped and bounded (`MAX_STARVATION_MISSING`) so
 * the list stays a stable, readable ordered set.
 */
export function candidateStarvationMissing(
  withheld: readonly CandidateReachability[],
  limit: number = MAX_STARVATION_MISSING,
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const entry of withheld) {
    const capabilities = entry.result.missingCapabilities.map(capabilityKey)
    const labels = capabilities.length > 0 ? capabilities : [entry.result.reason]
    for (const label of labels) {
      const token = `${entry.candidate.id}:${label}`
      if (seen.has(token)) continue
      seen.add(token)
      out.push(token)
      if (out.length >= limit) return out
    }
  }
  return out
}

/** True when a withheld candidate is a route for `item` itself (not a sibling). */
function candidateTargetsItem(candidate: Candidate, item: string): boolean {
  if (candidate.targetName === item) return true
  if (candidate.itemName === item) return true
  const known = candidate.meta.knownName
  return typeof known === 'string' && known === item
}

/**
 * The single reason the STARVED GOAL has no productive candidate, derived only
 * from the goal's own deterministic state: an unmet compiled precondition, else
 * the refusal reason of the goal's OWN route candidate (a withheld candidate
 * whose target is the goal's target item), else `no_productive_action`. A
 * withheld candidate for some other target (a prerequisite, a sibling) must
 * never leak into `blockedBy` - it belongs in `missing` tagged with its id.
 */
export function goalStarvationBlockedBy(
  preconditionCause: string | null,
  goal: Pick<QueuedGoal, 'kind' | 'targetItem'> | null,
  withheld: readonly CandidateReachability[],
): string {
  if (preconditionCause !== null) return preconditionCause
  if (goal === null || goal.kind !== 'collect') return 'no_productive_action'
  const target = goal.targetItem
  if (target === null) return 'no_productive_action'
  const own = withheld.find((entry) => candidateTargetsItem(entry.candidate, target))
  return own?.result.reason ?? 'no_productive_action'
}

function isProductiveCandidate(candidate: Candidate): boolean {
  return candidate.kind !== 'WAIT' && candidate.kind !== 'ESCALATE'
}

/**
 * The starvation contract's actionable-goal clause: if the current goal is a
 * craft whose recipe inputs are held, the offered set must contain a productive
 * candidate. The candidate gate already runs this ladder, but it runs before the
 * controller's own filters (move-failure memory, furnace prerequisite), so the
 * last productive candidate can be removed afterwards. This backfills the
 * deterministic self-contained craft step for the current craft goal only when
 * nothing productive survives, so `productive` is > 0 and no starvation line is
 * emitted for a craftable goal.
 */
export function ensureCraftStepActionable(
  state: WorldState,
  candidates: readonly Candidate[],
  options: CandidateOptions,
): Candidate[] {
  if (candidates.some(isProductiveCandidate)) return [...candidates]
  const current = state.goalQueue?.current ?? null
  if (current === null || current.kind !== 'craft') return [...candidates]
  const seen = new Set(candidates.map((candidate) => candidate.id))
  const step = selfContainedCraftCandidates(state, options).filter((candidate) => !seen.has(candidate.id))
  return step.length === 0 ? [...candidates] : [...candidates, ...step]
}

/** Capability name for one unmet predicate, used in the `precondition:<cause>` blockedBy. */
function preconditionCauseName(predicate: Predicate): string {
  switch (predicate.kind) {
    case 'pickaxeRankAtLeast':
      return 'pickaxe'
    case 'inventoryAtLeast':
      return predicate.item
    case 'inventoryClassAtLeast':
      return `class:${predicate.cls}`
    case 'stationKnown':
      return `station:${predicate.station}`
    case 'oreKnown':
      return `ore:${predicate.item}`
    case 'dimensionIs':
      return `dimension:${predicate.dimension}`
    case 'levelAtMost':
      return `y<=${predicate.y}`
    case 'levelAtLeast':
      return `y>=${predicate.y}`
    case 'positionNear':
      return `position:${predicate.position.x},${predicate.position.y},${predicate.position.z}`
    case 'healthAtLeast':
      return 'health'
    case 'custom':
      return `custom:${predicate.id}`
  }
}

export interface SurfaceRecoveryEvaluation {
  /** The code-owned vertical predicate; Y alone is never sufficient. */
  vertical: PredicateEvaluation
  /** Inventory count for the explicit recovery resource, e.g. the log class. */
  have: number
  required: number
  resourceSatisfied: boolean
  satisfied: boolean
}

/**
 * Evaluate the existing return-recovery contract as plain data.
 *
 * The planner describes this route as "reach the upper access hint and collect
 * a log". Keep those two facts together at the controller boundary so a high
 * remembered ore/station coordinate cannot be mistaken for verified surface
 * truth. The function is pure and intentionally uses the same level predicate
 * that the Option compiler emits.
 */
export function evaluateSurfaceRecovery(
  goal: Pick<QueuedGoal, 'kind' | 'targetY' | 'dimension' | 'targetItem' | 'requiredCount'>,
  snapshot: {
    position: Vec3Json | null
    dimension: string | null
    inventory: Readonly<Record<string, number>>
  },
): SurfaceRecoveryEvaluation | null {
  if (goal.kind !== 'surface') return null
  const predicate = predicateForGoal(goal)
  if (predicate === null || predicate.kind !== 'levelAtLeast') return null
  const vertical = evaluateSpatialPredicate(predicate, {
    position: snapshot.position,
    dimension: snapshot.dimension,
  })
  const required = Math.max(1, goal.requiredCount)
  const target = goal.targetItem
  let have = 0
  if (target !== null) {
    for (const [name, count] of Object.entries(snapshot.inventory)) {
      if (isResourceClass(target) ? matchesResourceClass(name, target) : name === target) have += count
    }
  }
  const resourceSatisfied = target === null || have >= required
  return {
    vertical,
    have,
    required,
    resourceSatisfied,
    satisfied: vertical.satisfied && resourceSatisfied,
  }
}

/**
 * The code-owned precondition that stops `goal` from starting, rendered as a
 * `blockedBy` cause (`precondition:pickaxe`), or null when it is startable. A
 * deterministic block must be surfaced instead of a generic `verify_failed`
 * spin, so the starvation line names what actually has to be produced.
 */
export function goalPreconditionCause(goal: PlannedGoal | null, snapshot: OptionWorldSnapshot): string | null {
  if (goal === null) return null
  const { ok, unmet } = evaluatePredicates(compilePlannedGoal(goal, snapshot).preconditions, snapshot)
  if (ok) return null
  const first = unmet[0]
  return first === undefined ? null : `precondition:${preconditionCauseName(first)}`
}

/**
 * Live M2 blocker (run-mu8b2647-rj7f, RC 8a671a0): the deterministic single-shot
 * plan was built while `raw_iron: 0`, so the ladder floor led with the ORE
 * descent `descend_to:Y=-3` and only then `collect 3 x raw_iron` / `smelt 3 x
 * iron_ingot`. The bot acquired `raw_iron: 3` + `charcoal: 1` while descending,
 * but `singleShotPlanner` supplies the plan exactly once, so
 * `planner.ts#smeltPriorityGoal` (which would lead with the smelt) was never
 * consulted again. The queue stayed on the stale ore descent and the smelt - with
 * its PREREQ_OPTION -> FURNACE_READY -> SMELT_DONE chain - never ran.
 *
 * A `descend` goal exists only to bring its ore within reach for a later
 * smelt/collect. When the queue already holds a smelt for an item produced from
 * the ore this descend targets, and that smelt's ITEM preconditions (input count
 * + fuel) all hold, the descend is a STALE PREREQUISITE. It is retired so the
 * queue advances to the smelt (and, when the furnace station is still missing,
 * to the existing furnace prereq path). The criterion reads the existing
 * OptionSpec precondition set, so it introduces no second smelt policy: it only
 * recognises a prerequisite the compiler already declares obsolete.
 */
export function staleOreDescend(
  current: Pick<QueuedGoal, 'kind' | 'targetItem'>,
  goals: readonly QueuedGoal[],
  snapshot: OptionWorldSnapshot,
): QueuedGoal | null {
  if (current.kind !== 'descend' || current.targetItem === null) return null
  for (const candidate of goals) {
    if (candidate.kind !== 'smelt' || candidate.targetItem === null) continue
    if (candidate.status === 'done' || candidate.status === 'impossible') continue
    const input = smeltInputFor(candidate.targetItem)
    if (input === null) continue
    if (!resourceMatches(current.targetItem, input)) continue
    const spec = compilePlannedGoal(queuedToPlanned(candidate), snapshot)
    const itemPreconditions = spec.preconditions.filter((predicate) => predicate.kind !== 'stationKnown')
    if (itemPreconditions.length === 0) continue
    if (!evaluatePredicates(itemPreconditions, snapshot).ok) continue
    return candidate
  }
  return null
}

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
 * Keep controller failure-memory charging on the same mechanical predicate
 * as the affordance/policy gate. In particular, a generated vertical plan
 * is executable even when its target is more than the horizontal pathfinder
 * gap above the bot.
 */
export function controllerUnreachableMoveReason(candidate: Candidate, state: WorldState): ReturnType<typeof unreachableMove> {
  return unreachableMove(candidate, state)
}

/** Beta is semantic authority only when one canonical current Option exists. */
export function canAuthoritativelyAbandonOption(optionId: string | null): optionId is string {
  return typeof optionId === 'string' && optionId.length > 0
}

/**
 * Verified goal/body/search progress observed for the current decision. Used
 * only to reset the bounded beta-abandon deferral (a productive in-flight action
 * keeps its deferral); it never selects an action.
 */
export function betaAbandonProgressObserved(
  reason: string,
  outcome: System2Outcome | null,
  locomotionEfficiency = 100,
): boolean {
  const kinds = outcome?.progressKinds ?? []
  const progress = outcome?.progress ?? null
  if (progress === 'goal' || progress === 'search' || kinds.includes('goal') || kinds.includes('search')) return true
  const bodyProgress =
    outcome === null
      ? reason === 'body_or_search_progress'
      : progress === 'body' || kinds.includes('body') || reason === 'body_or_search_progress'
  if (!bodyProgress) return false
  // Issue #360 sections 8 and 11: body motion kept the bounded beta-abandon deferral
  // alive every cycle, so Jev beta's abandon vote (measured live at 0.68-0.73 against a
  // 0.5 threshold) was deferred forever and the Option never ended. Walking is still
  // legitimate progress, so the deferral is kept only when the body is actually going
  // somewhere: the windowed locomotion efficiency must be above the same floor the
  // move-failure memory uses. A state-recurring micro-move loop sits at ~0-6% and no
  // longer holds the Option open.
  return locomotionEfficiency >= MOVE_PROGRESS_EFFICIENCY_FLOOR
}

export class JevController {
  private readonly bot: Bot
  private options: JevAgentOptions

  private runWriter: JsonlWriter
  private jevWriter: JsonlWriter
  private decisionWriter: JsonlWriter
  private system2Writer: JsonlWriter
  private logger: EventLogger
  private jev: JevPolicy
  private executor: Executor
  private scheduler: DecisionScheduler
  private system2: System2Brain
  private queue: GoalQueue
  private recipeIndex: RecipeIndex

  private goal: GoalState
  private signals: AgentSignals = emptySignals()
  private recentEvents: string[] = []
  private recentOutcomes: System2Outcome[] = []

  private tickCounter = 0
  private jevCalls = 0
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
  private readonly digMemory = new DigMemory()
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
  private uncertainStreaks = new Map<string, number>()
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
  private lastJevAt = 0
  private lastDecisionId: string | null = null
  /** whether the last beta abandon vote actually led to a replan (#46 guard). */
  private lastAbandonAdopted = false
  /** #79: per-option unproductive-attempt counter (reset on verified progress). */
  private readonly optionAttempts = new OptionAttemptTracker()
  /** #79: prereq paths retired by enforcement, keyed by goal then path. */
  private readonly abandonedPrereqPaths = new Map<string, Map<PrereqPath, number>>()
  /** #79: the prereq path chosen on the last tick, retired on enforcement. */
  private prereqChosenPath: PrereqPath | null = null
  private lastCandidates: readonly Candidate[] = []
  private lastCandidateSignature = ''
  private lastLogRouteSignature = ''
  /** Dedupe key for FOOD_LOW/EAT_REFUSED/FOOD_ROUTE so a stable food state is one auditable line. */
  private lastFoodMarkerSignature = ''
  /** Food-item counts at the previous decision tick, for FOOD_ACQUIRED; null until the first tick. */
  private lastFoodCounts: Map<string, number> | null = null
  private lastProgress = 0
  private lastProgressAt = Date.now()

  private chosenCountsAtProgress = -1
  private wedgeWindowId: string | null = null
  private wedgeWindowFingerprint: string | null = null
  private wedgeRepeats = 0
  private wedgeAborted = false
  private waitReplans = 0
  private waitStreak = 0
  private waitGoalKey: string | null = null
  private noProductiveRepeats = 0
  private noProductiveKey: string | null = null
  private noProductiveThisTick = false
  /**
   * #plan-reconciliation: decisions that presented no productive candidate for
   * the SAME queue row, counted regardless of body motion. `noProductiveRepeats`
   * resets whenever the rounded position changes, so a body that paces or climbs
   * while producing nothing never reaches its own bound.
   */
  private noProductiveHeadKey: string | null = null
  private noProductiveHeadCount = 0
  /** Latest grounded blocker context, forwarded to System 2 on exception-driven replans. */
  private starvationContext: { blockedBy: string; missing: string[] } | null = null
  private wedgeReason: string | null = null
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
  /** windowed locomotion efficiency (%) over the last 40 samples; 100 when idle */
  private lastLocomotionEfficiency = 100
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
  private readonly stationApproachLogged = new Set<string>()
  /** #8: exact coordinate failure memory (count, cooldown, dimension). */
  private moveFailMemory: MoveFailMemory
  /**
   * Zero-observable-change route memory: (kind, target cell, stand cell, route
   * signature) -> attempts. The postcondition layer owns the verdict; this owns
   * only what happens NEXT - a repeat of the same action with unchanged
   * preconditions is never re-issued, and a bounded number of distinct
   * zero-progress routes at one stand cell exhausts that family there.
   */
  private zeroProgressRoutes: ZeroProgressRoutes = {}
  /** #11 v2 §6: reachability proved a target unreachable under a state fingerprint. */
  private readonly reachabilityProofs = new StateFingerprintMemory({ maxEntries: MOVE_FAILMEM_MAX_ENTRIES })
  /** candidates the affordance gate withheld in the latest generation. */
  private withheldCandidateIds: ReadonlySet<string> = new Set<string>()
  /** gate facts (station/dig approach probes) resolved once per tick. */
  private gateOptions: ReachabilityGateOptions | null = null
  private gateOptionsTick = -1
  /** last logged REACHABILITY signature per candidate, so markers change with facts. */
  private readonly reachabilityLogSignatures = new Map<string, string>()
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
  /** #58: the last scored furnace-prerequisite plan and its selected path. */
  private prereqPlan: PrereqDecision | null = null
  private prereqForcedPath: PrereqPath | null = null
  private prereqGoalKey: string | null = null
  private prereqLoggedKey: string | null = null
  /** goal|line key of the last `FURNACE_PREREQ_ALREADY_SATISFIED` observation logged */
  private prereqSatisfiedLoggedKey: string | null = null
  /** goal|line key of the last `PREREQ_STATION_ALREADY_KNOWN` line logged. */
  private prereqStationKnownLoggedKey: string | null = null
  private prereqProgress: PrereqProgress | null = null
  private readonly prereqStallTicks = resolvePrereqStallTicks()
  /** #78: options excluded for the current goal after repeated unverified failure (path -> fingerprint). */
  private readonly abandonedRetrievePaths = new Map<PrereqPath, string>()
  /** #78: consecutive `verified=false progressDelta=0` retrieve outcomes. */
  private retrieveUnverified: RetrieveUnverifiedState | null = null
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
  /** The fingerprint that produced each abandoned prerequisite-path fact. */
  private readonly abandonedPrereqFingerprints = new Map<string, string>()

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
  private ticking = false
  private startedAt = 0
  private completion: Promise<RunSummary> | null = null
  private resolveCompletion: ((summary: RunSummary) => void) | null = null

  constructor(bot: Bot, options: Partial<JevAgentOptions> = {}) {
    this.bot = bot
    this.options = normalizeOptions({ ...defaultJevAgentOptions, ...options })
    this.moveFailMemory = this.createMoveFailMemory()
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
    this.scheduler = this.buildScheduler()
    this.executor = new Executor(bot, this.logger, executorOptions(this.options, this.scheduler))
    this.system2 = new StubSystem2(this.system2Writer)
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
    this.system2 = brain
  }

  /**
   * Explicit player intent owns WHAT and therefore bypasses System2 selection,
   * but still flows through the normal GoalQueue -> Jev -> Guard -> Executor.
   * The autonomous mission is preserved behind the human interrupt queue.
   */
  submitHumanPlan(goals: readonly PlannedGoal[], requestedBy: string): QueuedGoal[] {
    const previous = this.queue.current
    const added = this.queue.interruptWithHumanPlan(goals, {
      onDuplicate: (line) => this.logger.info('human', line, { requestedBy }, this.tickCounter),
    })
    if (added.length === 0) return []
    this.semanticStateGeneration += 1
    if (previous !== null && previous.origin !== 'human') {
      this.executor.cancelCurrent(`human intent from ${requestedBy}`)
    }
    this.logger.warn(
      'human',
      `HUMAN_INTENT_APPLIED requestedBy=${requestedBy} goals=${added.length}`,
      { requestedBy, goals: added.map((goal) => goal.description), queueDepth: this.queue.state.depth },
      this.tickCounter,
    )
    this.requestDecision('human_intent', { requestedBy, goals: added.map((goal) => goal.id) })
    return added
  }

  /** Clear only human-owned unfinished rows and resume the preserved mission. */
  clearHumanPlan(requestedBy: string, reason = 'free'): QueuedGoal[] {
    const currentWasHuman = this.queue.current?.origin === 'human'
    const cleared = this.queue.clearHumanInterrupts(reason)
    if (cleared.length === 0) return []
    this.semanticStateGeneration += 1
    if (currentWasHuman) this.executor.cancelCurrent(`human ${reason} from ${requestedBy}`)
    this.logger.warn(
      'human',
      `HUMAN_INTENT_CLEARED requestedBy=${requestedBy} reason=${reason} goals=${cleared.length}`,
      { requestedBy, reason, goals: cleared.map((goal) => goal.id), queueDepth: this.queue.state.depth },
      this.tickCounter,
    )
    this.requestDecision('human_intent', { requestedBy, reason, cleared: cleared.map((goal) => goal.id) })
    return cleared
  }

  /** Must be called before start(). Rebuilds every derived object. */
  setOptions(partial: Partial<JevAgentOptions>): void {
    if (this.running) throw new Error('setOptions() cannot be called while the agent is running')
    this.options = normalizeOptions({ ...this.options, ...partial })
    this.moveFailMemory = this.createMoveFailMemory()
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
    this.scheduler = this.buildScheduler()
    this.executor = new Executor(this.bot, this.logger, executorOptions(this.options, this.scheduler))
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
    return new MoveFailMemory({
      failureLimit: MOVE_FAILMEM_LIMIT,
      cooldownMs: MOVE_FAILMEM_COOLDOWN_MS,
      maxEntries: MOVE_FAILMEM_MAX_ENTRIES,
      initialEntries: this.options.moveFailureEntries,
    })
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
    this.executor.ensureMovements()
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
    const request: System2PlanRequest = {
      reason: 'queue_empty',
      detail: 'single-shot bootstrap: supply the long-horizon plan once',
      tick: this.tickCounter,
      goalQueueState: this.queue.state,
      objective: this.objectiveState(),
      recentEvents: [],
      recentOutcomes: [],
    }
    const plan = await this.system2.plan(request)
    this.planCalls += 1
    const depthBefore = this.queue.state.depth
    const restoredHead = this.queue.current !== null
    const requestedOp = plan.op ?? 'replace'
    const op = resolveBootstrapPlanOp(this.queue, plan.op)
    const added = this.queue.applyPlan(plan.goals, 'llm', op, {
      reason: plan.note,
      onProtection: (line) => this.logger.warn('agent', line, { op, requested: requestedOp, phase: 'bootstrap' }, this.tickCounter),
      onDuplicate: (line) => this.logger.warn('agent', line, { op, requested: requestedOp, phase: 'bootstrap' }, this.tickCounter),
      protectedGoalRetireReason: (goal, incoming) => this.protectedGoalRetireReason(goal, incoming),
    })
    this.logQueueDepthDelta(depthBefore, op, `bootstrap`)
    this.subgoalCount = Math.max(added.length, this.queue.size)
    if (restoredHead && op !== requestedOp) {
      this.logger.warn(
        'system2',
        `BOOTSTRAP_HEAD_PRESERVED current=${this.queue.current?.description ?? 'none'} op=${op} requested=${requestedOp} depth=${this.queue.state.depth}`,
        { op, requested: requestedOp, depth: this.queue.state.depth, current: this.queue.current?.description ?? null },
        0,
      )
    }
    this.planSupplied = true
    const restored = this.loadLedger()
    if (restored !== null) {
      this.queue.restore(restored)
      this.subgoalCount = Math.max(this.subgoalCount, restored.goals.length)
      this.logger.warn(
        'system2',
        `phase ledger restored: ${restored.goals.filter((goal) => goal.status === 'done').length} subgoal(s) already done; current=${this.queue.current?.description ?? 'none'}`,
        { done: restored.goals.filter((goal) => goal.status === 'done').length, total: restored.goals.length },
        0,
      )
    }
    const current = this.queue.current
    this.logger.warn(
      'system2',
      `bootstrap plan applied provider=${this.system2Provider} model=${this.system2Model} call=1 goals=${added.length} depth=${this.queue.state.depth} :: ${plan.note}`,
      {
        provider: this.system2Provider,
        model: this.system2Model,
        planCalls: this.planCalls,
        goals: added.map((goal) => goal.description),
        note: plan.note,
      },
      0,
    )
    if (current !== null) this.logSubgoalStart(current, this.inventorySnapshot(), 'bootstrap')
  }

  stop(): void {
    this.finish('stopped-by-caller', this.runSuccess())
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
    if (!this.running) return
    const event: TriggerEvent = { trigger, detail, ts: Date.now() }
    if (this.ticking) {
      if (trigger !== 'heartbeat') this.pendingTrigger = pickHigherPriority(this.pendingTrigger, event)
      return
    }
    const inFlight = this.executor.current
    if (inFlight !== null) {
      if (PREEMPTIVE_TRIGGERS.has(trigger)) {
        // ATTACK is a Jev-selected combat lease.  Damage/entity events are
        // expected while the selected attack is being aimed and delivered;
        // asking Jev again on every hit cancels the attack before its next
        // cooldown and lets a nearby zombie turn the agent into a MOVE/WAIT
        // loop.  Keep the selected attack mechanics together and replay the
        // highest-priority threat trigger immediately after the short lease.
        if (inFlight.kind === 'ATTACK') {
          const air = this.liveAir()
          if (shouldInterruptAttackLease(trigger, this.bot.health, CRITICAL_COMBAT_HEALTH, air)) {
            this.logger.warn(
              'scheduler',
              `trigger=${trigger} interrupts ATTACK lease#${inFlight.epoch} ${inFlight.id} at critical health=${this.bot.health} air=${air}`,
              detail,
              this.tickCounter,
            )
            this.scheduleTick(event)
            return
          }
          this.deferredTrigger = pickHigherPriority(this.deferredTrigger, event)
          this.logger.info(
            'scheduler',
            `trigger=${trigger} deferred during ATTACK lease#${inFlight.epoch} ${inFlight.id}`,
            detail,
          )
          return
        }
        this.logger.info(
          'scheduler',
          `trigger=${trigger} preempts action#${inFlight.epoch} ${inFlight.id}`,
          detail,
          this.tickCounter,
        )
        this.scheduleTick(event)
        return
      }
      this.deferredTrigger = pickHigherPriority(this.deferredTrigger, event)
      this.logger.info(
        'scheduler',
        `trigger=${trigger} deferred while action#${inFlight.epoch} ${inFlight.id} is in flight`,
        detail,
        this.tickCounter,
      )
      return
    }
    this.scheduleTick(event)
  }

  /**
   * Space decision starts by at least `minDecisionIntervalMs` and, crucially,
   * yield to the macrotask queue between decisions. Without the yield a
   * fast-failing action's already-resolved awaits starve timers (including the
   * run watchdog) and the loop spins thousands of times per second.
   */
  private scheduleTick(event: TriggerEvent): void {
    if (this.decisionTimer !== null) {
      this.pendingTrigger = pickHigherPriority(this.pendingTrigger, event)
      return
    }
    const elapsed = Date.now() - this.lastTickAt
    const delay = Math.max(0, this.options.minDecisionIntervalMs - elapsed)
    this.decisionTimer = setTimeout(() => {
      this.decisionTimer = null
      const queued = this.pendingTrigger
      this.pendingTrigger = null
      const next = queued === null ? event : pickHigherPriority(event, queued)
      void this.tick(next.trigger, next.detail)
    }, delay)
  }

  private clearDecisionTimer(): void {
    if (this.decisionTimer !== null) {
      clearTimeout(this.decisionTimer)
      this.decisionTimer = null
    }
  }

  private drainPending(): void {
    if (!this.running) return
    const pending = this.pendingTrigger
    this.pendingTrigger = null
    if (pending !== null) {
      this.requestDecision(pending.trigger, pending.detail)
      return
    }
    const deferred = this.deferredTrigger
    this.deferredTrigger = null
    if (deferred !== null) this.requestDecision(deferred.trigger, deferred.detail)
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
      if (CRITICAL_TRIGGERS.has(trigger)) this.criticalStateVersion += 1
      this.signals.maxConcurrentActions = this.executor.maxConcurrentActions
      this.signals.lastPathStatus = this.executor.lastPathStatus
      this.signals.consecutiveFailures = this.failureStreak
      this.signals.escalationRecommended = Date.now() - this.lastEscalationMs < this.options.escalationWindowMs
      this.signals.failedCandidates = this.failureSnapshot()
      this.signals.zeroProgressRoutes = this.zeroProgressRoutes
      this.signals.knownResources = filterKnownResources(
        this.knownResourcesForSensor().filter((resource) => resourceDimensionMatches(resource, this.currentDimension())),
        this.unreachableResources,
      )
      this.updateStallSignal()
      this.observeRetrievalStall()
      this.observeCapabilityGap()
      this.observeThreat(trigger, detail)
      this.observeCriticalDamage(trigger, detail)
      this.sampleHealthFallback()

      if (this.bot.entity === undefined) return

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
      this.withheldCandidateIds = new Set(grounded.withheld.map((entry) => entry.candidate.id))
      this.logReachability(grounded.reachability, grounded.withheld)
      this.logPlacementRefusal(grounded.placeRefusal)
      this.logIgnitionRefusal(grounded.ignitionRefusal)
      this.logEntryRefusal(grounded.entryRefusal)
      this.noteRouteExhaustion(grounded.entryRefusal)
      this.logEntryUnverified(portalEntry)
      this.logArmorRefusal(grounded.armorRefusals)
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
      candidates = this.applyFurnacePrereq(state, candidates, unreachableStations)
      candidates = this.filterMoveCandidates(candidates, state)
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
      const threatOffer = applyGroundedThreatRestriction(state, candidates, grounded.withheld)
      candidates = threatOffer.candidates
      this.logThreatOccluded(threatOffer)
      this.logThreatGap(state, threatOffer)
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
      if (noProductive) {
        const headKey = `${this.queue.current?.id ?? 'none'}|${this.currentGoalKey()}`
        if (headKey === this.noProductiveHeadKey) this.noProductiveHeadCount += 1
        else {
          this.noProductiveHeadKey = headKey
          this.noProductiveHeadCount = 1
        }
        if (this.noProductiveHeadCount >= this.options.waitLimit) {
          this.noProductiveHeadCount = 0
          this.logger.warn(
            'agent',
            `NO_PRODUCTIVE_HEAD_BOUND count=${this.options.waitLimit}/${this.options.waitLimit} goal="${this.currentGoalKey()}" blocker=${this.starvationContext?.blockedBy ?? 'unknown'}${(this.starvationContext?.missing.length ?? 0) > 0 ? ` missing=${JSON.stringify(this.starvationContext?.missing ?? [])}` : ''} -> wake System2`,
            {
              goal: this.currentGoalKey(),
              goalId: this.queue.current?.id ?? null,
              blocker: this.starvationContext?.blockedBy ?? null,
              missing: this.starvationContext?.missing ?? [],
              limit: this.options.waitLimit,
              boundary: 'semantic_boundary',
            },
            this.tickCounter,
          )
          this.escalate(
            'all_candidates_invalid',
            `NO_PRODUCTIVE_HEAD_BOUND: ${this.options.waitLimit} decisions presented no productive candidate for the same queue head "${this.currentGoalKey()}" with zero semantic progress; blocker=${this.starvationContext?.blockedBy ?? 'unknown'}`,
          )
          return
        }
        if (this.noProductiveHeadCount === 1) {
          this.logger.info(
            'agent',
            `NO_PRODUCTIVE_HEAD_WINDOW goal="${this.currentGoalKey()}" limit=${this.options.waitLimit}`,
            { goal: this.currentGoalKey(), count: this.noProductiveHeadCount, limit: this.options.waitLimit },
            this.tickCounter,
          )
        }
      } else {
        this.noProductiveHeadKey = null
        this.noProductiveHeadCount = 0
      }
      this.breakFailureDeadlock(candidates)

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
      // layers and the danger gate are model-decision machinery, so a reflex tick
      // passes them by; the guard below still validates the candidate
      // mechanically.
      const committedId = reflex === null ? this.applyCandidateCommitment(rawChosenId, candidates, state) : rawChosenId
      const heldId = reflex === null ? this.applyActionCommitment(committedId, candidates, state) : committedId
      const dangerGate = gateDanger(decision.answers.danger)
      const gated =
        reflex === null
          ? this.applyDangerGate(heldId, dangerGate, candidates)
          : { chosenId: heldId, overridden: false }
      // Re-groundable: a vanished survival action is replaced below by the SAME
      // action kind from the fresh offer (see the guard at the revalidation).
      let chosenId = gated.chosenId
      this.noteWaitStreak(chosenId, actionable)
      this.checkWedge(chosenId)
      if (this.wedgeAborted) return

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
        },
        sensorOptions(this.options, this.scheduler.worldRevision),
      )
      freshState = this.mergeRememberedPortalFrame(freshState)
      // The revalidation offer applies the SAME threat envelopes as the
      // decision-time offer (contact range + the published bounded danger
      // state), so a work action cannot slip back in between the Jev answer and
      // execution while a hostile is on the body.
      const freshGrounded = generateGroundedCandidates(
        freshState,
        candidateOptions(
          this.options,
          this.recipeIndex,
          this.unreachableStationKeys(freshState),
          this.reachabilityGateOptions(),
          this.blacklistedMoveTargets(freshState),
          freshState.portalFrame,
          this.searchedSurfaceTargets,
          this.portalEntryPlan(freshState),
          this.placementRetries.retiredItemSet(),
        ),
      )
      const freshBeforeThreat = this.filterMoveCandidates(freshGrounded.candidates, freshState, false)
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
            const fallback = survivalControlFallback({
              reground,
              threatInContact: threatEvidence?.inContact === true,
              freshCandidates,
            })
            if (fallback.candidateId !== null) {
              controlId = fallback.candidateId
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
            this.requestDecision('damage_taken', {
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
      const guarded = guardDecision(chosenId, freshCandidates, freshState, {
        phase: 'decision',
        candidateIds: freshIds,
        inFlight: this.inFlight(),
        reach: this.options.reach,
        maxCandidateAgeTicks: this.options.maxCandidateAgeTicks,
        canComputePath: (position) => this.canComputePath(position),
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
        dangerOverride: gated.overridden ? chosenId : null,
        needLlm: null,
        needLlmAdopted,
        goalQueueState: toGoalQueueStateLog(state.goalQueue),
        llmResummon: pickResummon(this.tickResummonLog, needLlmAdopted),
        llm: this.llmLog(),
        subgoal: this.consumeTransition(),
        inventory: state.inventory.counts,
      })

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
      const claim = this.executor.claim(this.stampSelectionProvenance(guarded.candidate, decision, record))
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
      void claim.completion
        .then((result) => {
          this.onActionComplete(result, decision, guarded.candidate)
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          this.logger.error('agent', `action completion handler failed: ${message}`, {}, this.tickCounter)
        })
    } catch (error) {
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
    }
  }

  private jevLog(decision: JevResult, dangerGate: GatedScore, trigger: DecisionTrigger): DecisionJevLog {
    return {
      policy: decision.policy,
      source: decision.source,
      model: decision.model,
      callId: decision.callId,
      latencyMs: decision.latencyMs,
      usage: decision.usage,
      answers: decision.answers,
      dangerGate,
      trigger,
    }
  }

  /**
   * The one gate between the beta vote and a replan. `adopt` is the controller's
   * ACTUAL decision: with `betaAuthority: false` (default) it is always false,
   * so a β=1 cannot discard a prerequisite (#22/#55).
   */
  private betaDecision(decision: JevResult): BetaAuthorityDecision {
    const vote = betaAuthorityDecision({
      betaAuthority: this.options.betaAuthority,
      abandonRequested: abandonRequested(decision),
      actionId: decisionIdFrom(decision),
      goals: this.unfinishedGoals(),
      placedFurnaceCount: this.lastPlacedFurnaceCount,
    })
    if (!vote.protection.protect) return vote
    const abandonedReason = this.abandonedOptions.reasonUnder(vote.protection.option, this.lastStateFingerprint)
    if (abandonedReason === null) return vote
    this.logProtectionAbandonConflict(vote.protection.option, abandonedReason, 'authority')
    return {
      ...vote,
      adopt: this.options.betaAuthority && !vote.shadowed,
      protection: { ...vote.protection, protect: false },
    }
  }

  private logHeads(result: JevResult, verdict: AbandonVerdict, chainId: string | null = null): void {
    const action = decisionIdFrom(result) ?? 'WAIT'
    const abandon = result.answers.abandon_option?.probability ?? null
    const vote = verdict.vote
    this.logger.info(
      'heads',
      formatJevHeads(action, abandon, verdict.adopt),
      {
        action,
        abandon,
        decision: verdict.adopt ? 'replan' : 'continue',
        abandonRequested: abandonRequested(result),
        betaAuthority: this.options.betaAuthority,
        betaShadowed: vote.shadowed,
        abandonEnforced: verdict.enforced,
        abandonSuppressed: verdict.suppressed,
        attempts: verdict.classification.attempts,
        chainId,
      },
      this.tickCounter,
    )
    if (verdict.adopt) {
      const reason = this.abandonReason(action, abandon)
      if (verdict.optionId !== null) {
        const option = verdict.optionId
        this.logger.warn('heads', formatAbandonReason(option, reason), { option, reason, beta: abandon, action }, this.tickCounter)
      }
    }
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
    const provider = this.options.planIdentity
    if (provider === undefined) return
    let live: PlanIdentity | null = null
    try {
      live = provider()
    } catch (error) {
      this.logger.warn(
        'agent',
        `PLAN_IDENTITY_UNAVAILABLE error=${error instanceof Error ? error.message : String(error)}`,
        {},
        this.tickCounter,
      )
      return
    }
    if (live === null) return
    const proof = this.options.supersededGoalReason
    const result = this.queue.reconcilePlanIdentity({
      current: live,
      isObsolete: proof === undefined ? undefined : (goal) => proof(goal, live as PlanIdentity),
      onSuperseded: (line, detail) => this.logger.warn('queue', line, detail, this.tickCounter),
    })
    if (result.adoptedLegacy > 0 && result.previous === null) {
      // First reconciliation of a legacy/queued ledger: rows adopt the live
      // identity, so nothing is misread as superseded. Evidence only.
      this.logger.info(
        'queue',
        `PLAN_IDENTITY_ADOPTED identity=${formatPlanIdentity(result.current)} rows=${result.adoptedLegacy}`,
        { identity: formatPlanIdentity(result.current), rows: result.adoptedLegacy },
        this.tickCounter,
      )
    }
    if (result.retired.length > 0 || (result.changed && result.superseded > 0)) {
      this.logger.warn(
        'agent',
        formatPlanIdentityChanged(result),
        {
          from: formatPlanIdentity(result.previous),
          to: formatPlanIdentity(result.current),
          superseded: result.superseded,
          retired: result.retired.map((entry) => entry.id),
          kept: result.kept.map((entry) => entry.id),
          headSuperseded: result.headSuperseded,
        },
        this.tickCounter,
      )
    }
    if (result.superseded === 0) return
    // The preferred arm: ask System2 (the WHAT owner) to re-plan, carrying the
    // compact state the request already builds (objective, queue head, recent
    // outcomes/events, grounded alternatives, world facts, blocker detail). The
    // replan throttle and the model cooldown bound it; `planIdentityKey` in
    // `replanInputs()` makes a genuinely new objective new information while a
    // repeated identical supersession is held.
    const request = planReplanRequest(result)
    if (request === null) return
    this.summonLlm(request.reason, request.detail)
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
    if (this.queue.isEmpty) return
    const live = this.bot.game?.dimension ?? null
    const result = this.queue.reconcileNotExecutableHead({ liveDimension: live })
    if (result.action === 'hold') return
    if (result.action === 'defer') {
      this.logger.warn(
        'agent',
        formatRowDeferredNotExecutableHere(result),
        {
          goalId: result.goalId,
          goalKey: result.goalKey,
          declaredDimension: result.declaredDimension,
          liveDimension: result.liveDimension,
          defers: result.defers,
          limit: result.limit,
          nextGoalId: result.nextGoalId,
        },
        this.tickCounter,
      )
      return
    }
    this.logger.warn(
      'agent',
      `${formatRowNotExecutableHere(result)} -> wake System2`,
      {
        goalId: result.goalId,
        goalKey: result.goalKey,
        declaredDimension: result.declaredDimension,
        liveDimension: result.liveDimension,
        reason: result.reason,
        defers: result.defers,
        limit: result.limit,
      },
      this.tickCounter,
    )
    const request = notExecutableReplanRequest(result)
    if (request === null) return
    this.summonLlm(request.reason, request.detail)
  }

  /**
   * #nonprogress-yield: the controller half of the bounded optional-head yield.
   * It supplies the two facts the queue cannot see - the code-owned critical
   * survival predicate (a starving low-health body still prioritises food) and
   * the goal key for the typed marker - and never selects WHAT runs next: the
   * plan's own order does, and System2 still owns the repair.
   */
  private reconcileNonProgressingOptionalHead(): void {    if (this.queue.isEmpty) return
    const critical = bodyStarving({
      food: typeof this.bot.food === 'number' ? this.bot.food : Number.NaN,
      health: this.bot.health,
    })
    const result = this.queue.reconcileNonProgressingHead({ critical })
    const detail = {
      goalId: result.goalId,
      goalKey: result.goalKey,
      decisions: result.decisions,
      limit: result.limit,
      yields: result.yields,
      maxYields: result.maxYields,
      nextGoalId: result.nextGoalId,
      reason: result.reason,
      critical,
    }
    if (result.action === 'yield') {
      this.logger.warn('agent', formatNonProgressYield(result), detail, this.tickCounter)
    } else if (result.action === 'escalate') {
      this.logger.warn('agent', formatNonProgressEscalated(result), detail, this.tickCounter)
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
    const outcome = this.recentOutcomes.at(-1) ?? null
    const evidence = this.signals?.strategicNonProgress ?? null
    const semanticExhausted = evidence !== null && evidence.exhausted
    if (semanticExhausted) {
      this.logger.warn(
        'agent',
        formatStrategicNonProgressExhausted(this.currentGoalKey(), evidence),
        {
          option: optionId,
          windowSize: evidence.windowSize,
          horizon: evidence.horizon,
          distinctStates: evidence.distinctStates,
          bodyProgressDecisions: evidence.bodyProgressDecisions,
          exhaustedRepeats: evidence.exhaustedRepeats,
          boundary: 'semantic_exhausted',
        },
        this.tickCounter,
      )
      // Clear the consumed window but leave `signals.strategicNonProgress` as the
      // exhausted snapshot for this decision, so the authority facade can see it.
      this.strategicStall.acknowledgeExhaustion()
    }
    const boundary = evaluateBetaTerminationBoundary({
      optionId,
      requested: abandonRequested(decision),
      decisionActionId: decisionIdFrom(decision),
      latestOutcome: outcome,
      semanticExhausted,
      semanticInvalid: false,
    })
    if (!abandonRequested(decision) || boundary.adopt) {
      // A vote that is honored (or not requested) ends the deferred streak.
      this.betaAbandonDeferral.reset()
      return boundary
    }
    const action = decisionIdFrom(decision) ?? 'WAIT'
    const progressed = betaAbandonProgressObserved(boundary.reason, outcome, this.lastLocomotionEfficiency)
    const bounded = this.betaAbandonDeferral.note({
      plan: this.betaAbandonPlanId,
      action,
      reason: boundary.reason,
      progressed,
    })
    if (bounded.defer) {
      this.logger.info(
        'heads',
        formatBetaAbandonDeferred(bounded),
        {
          count: bounded.count,
          limit: bounded.limit,
          planId: bounded.plan,
          action: bounded.action,
          reason: bounded.reason,
          progressed,
        },
        this.tickCounter,
      )
      return boundary
    }
    const probability = decision.answers.abandon_option?.probability ?? null
    this.logger.warn(
      'heads',
      formatBetaAbandonReleased(bounded.plan, bounded.action, bounded.reason, probability),
      { planId: bounded.plan, action: bounded.action, reason: bounded.reason, beta: probability },
      this.tickCounter,
    )
    // Beta already voted to end the Option; the deferral budget is spent, so
    // honor that vote. The released abandon still runs through the ordinary
    // `markOptionAbandoned` + System2 handoff — this layer never picks WHAT next.
    return { adopt: true, wake: true, reason: 'semantic_abandon' }
  }

  /**
   * #79: decide what to do with one abandon request. Uses the per-option
   * attempt counter, so a SPECULATIVE request (attempts < limit) is suppressible
   * in shadow mode while a DEMONSTRABLY UNPRODUCTIVE one (attempts >= limit with
   * verified=false && progress=0) is enforced regardless of `betaAuthority`.
   */
  private abandonVerdict(decision: JevResult, optionId: string | null, planId: string | null): AbandonVerdict {
    const requested = abandonRequested(decision)
    const now = Date.now()
    // The wrapper calls this immediately before `betaTerminationBoundary`, so the
    // deferral bound below is keyed on the same plan revision this verdict used.
    this.betaAbandonPlanId = planId
    if (!canAuthoritativelyAbandonOption(optionId)) {
      const classification = classifyAbandonRequest({
        abandonRequested: requested,
        betaAuthority: false,
        attempts: 0,
        lastVerified: false,
        lastProgressDelta: 0,
        attemptLimit: this.options.unproductiveAttemptLimit,
        alreadyAbandoned: false,
      })
      const vote = this.betaDecision(decision)
      if (requested) {
        this.logger.warn(
          'heads',
          `BETA_NONAUTHORITATIVE option=none reason=no_current_option beta=${decision.answers.abandon_option?.probability ?? 'null'}`,
          { optionId: null, planId, reason: 'no_current_option', beta: decision.answers.abandon_option?.probability ?? null },
          this.tickCounter,
        )
      }
      return { adopt: false, enforced: false, suppressed: requested, classification, vote, optionId: null, planId }
    }
    const state = this.optionAttempts.stateFor(optionId, planId)
    const classification = classifyAbandonRequest({
      abandonRequested: requested,
      betaAuthority: this.options.betaAuthority,
      attempts: state.attempts,
      lastVerified: state.verified,
      lastProgressDelta: state.progressDelta,
      attemptLimit: this.options.unproductiveAttemptLimit,
      alreadyAbandoned: this.optionAttempts.isAbandoned(optionId, planId, now, this.options.abandonCooldownMs),
    })
    const vote = this.betaDecision(decision)
    if (!requested) return { adopt: false, enforced: false, suppressed: false, classification, vote, optionId, planId }
    if (classification.reason === 'unproductive') {
      return { adopt: true, enforced: true, suppressed: false, classification, vote, optionId, planId }
    }
    if (classification.reason === 'authority') {
      return { adopt: vote.adopt, enforced: false, suppressed: vote.shadowed, classification, vote, optionId, planId }
    }
    return { adopt: false, enforced: false, suppressed: classification.suppressed, classification, vote, optionId, planId }
  }

  private applyAbandon(result: JevResult, verdict: AbandonVerdict): boolean {
    if (verdict.enforced) {
      if (verdict.optionId === null) return false
      const probability = result.answers.abandon_option?.probability ?? null
      this.logger.warn(
        'heads',
        formatAbandonEnforced({
          optionId: verdict.optionId,
          attempts: verdict.classification.attempts,
          verified: verdict.classification.verified,
          progressDelta: verdict.classification.progressDelta,
          betaAuthority: this.options.betaAuthority,
          betaShadowed: verdict.vote.shadowed,
          abandonRequested: true,
        }),
        {
          optionId: verdict.optionId,
          planId: verdict.planId,
          attempts: verdict.classification.attempts,
          betaAuthority: this.options.betaAuthority,
          betaShadowed: verdict.vote.shadowed,
          abandonRequested: true,
          action: 'abandon',
        },
        this.tickCounter,
      )
      this.enforceUnproductiveAbandon(verdict.optionId, verdict.planId, verdict.classification.attempts, probability)
      return true
    }
    if (verdict.optionId === null) return false
    if (this.options.betaAuthority) {
      if (!verdict.adopt) return false
      const probability = result.answers.abandon_option?.probability ?? null
      this.markOptionAbandoned(verdict.optionId, 'authority')
      this.summonLlm('no_progress', `abandon_option=${probability} crossed the replan threshold`)
      return true
    }
    if (verdict.suppressed && abandonRequested(result)) {
      this.logger.info(
        'heads',
        formatAbandonSuppressed({
          optionId: verdict.optionId,
          reason: verdict.classification.reason === 'cooldown' ? 'cooldown' : 'speculative',
          attempts: verdict.classification.attempts,
        }),
        {
          optionId: verdict.optionId,
          planId: verdict.planId,
          reason: verdict.classification.reason,
          attempts: verdict.classification.attempts,
          mode: 'shadow',
          action: 'continue',
        },
        this.tickCounter,
      )
    }
    return false
  }

  /**
   * #79: retire the unproductive option and advance the ladder. A smelt
   * prerequisite retires its current path so `applyFurnacePrereq` selects the
   * next feasible rung (place_held -> use_known_station -> craft_and_place ->
   * escalate) instead of re-selecting the abandoned one. Otherwise the existing
   * exception-driven replan is the abandon action.
   */
  private enforceUnproductiveAbandon(
    optionId: string,
    planId: string | null,
    attempts: number,
    probability: number | null,
  ): void {
    const now = Date.now()
    this.optionAttempts.markAbandoned(optionId, planId, now)
    if (this.prereqPlan !== null && this.prereqChosenPath !== null) {
      const current = this.prereqChosenPath
      const goalKey = this.prereqGoalKey ?? this.currentGoalKey()
      const bucket = this.abandonedPrereqPaths.get(goalKey) ?? new Map<PrereqPath, number>()
      bucket.set(current, now)
      this.abandonedPrereqPaths.set(goalKey, bucket)
      this.abandonedPrereqFingerprints.set(`${goalKey}|${current}`, this.lastStateFingerprint)
      const next = nextPrereqPath(this.prereqPlan, current)
      this.prereqForcedPath = next
      this.prereqProgress = null
      this.prereqLoggedKey = null
      this.logger.warn(
        'agent',
        `PREREQ_ABANDON from=${current} to=${next ?? 'none'} reason=unproductive attempts=${attempts}`,
        { from: current, to: next, reason: 'unproductive', attempts, goal: goalKey },
        this.tickCounter,
      )
    }
    this.markOptionAbandoned(this.lastDecisionId ?? optionId, 'unproductive')
    this.summonLlm('no_progress', `abandon_option=${probability} enforced: ${optionId} unproductive after ${attempts} attempts`)
  }

  /** Why beta/controller chose abandon, from the deterministic failure signals. */
  private abandonReason(actionId: string, beta: number | null): AbandonReason {
    return classifyAbandonReason({
      beta,
      lastFailureCode: this.signals.lastFailureCode,
      candidateFailures: this.candidateFailureCount(actionId),
      escalationRecommended: this.signals.escalationRecommended,
    })
  }

  /**
   * #22: record what beta WOULD have decided next to the controller's actual
   * replan behavior. `actual` is the controller's own decision: it includes
   * beta only when `betaAuthority` is on and the guard cleared it; otherwise it
   * reflects the deterministic reasons (queue_empty, semantic escalation, ...).
   */
  private logBetaShadow(optionId: string | null, decision: JevResult, actualReplanAdopted: boolean): void {
    const beta = decision.answers.abandon_option?.probability ?? null
    const vote = this.betaDecision(decision)
    const actualReplan = actualReplanAdopted || this.queue.isEmpty || this.lastAbandonAdopted
    const shadow = betaShadowDecision({ optionId, beta, actualReplan })
    this.logger.info(
      'beta-shadow',
      formatBetaShadow(shadow),
      {
        ...shadow,
        mode: this.options.betaAuthority ? 'authority' : 'shadow',
        betaAuthority: this.options.betaAuthority,
        shadowed: vote.shadowed,
      },
      this.tickCounter,
    )
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

  /**
   * The 2D rule: a `score` answer is (value x certainty). A low-certainty danger
   * score must not change behaviour - the executor keeps the current safe action.
   */
  private applyDangerGate(
    chosenId: string,
    gate: GatedScore,
    candidates: readonly Candidate[],
  ): { chosenId: string; overridden: boolean } {
    const safeAction =
      candidates.find((candidate) => candidate.kind === 'RETREAT')?.id ??
      candidates.find((candidate) => candidate.kind === 'ESCALATE')?.id ??
      null
    const decision = applyDangerGate(chosenId, gate, safeAction)
    if (decision.outcome === 'preserved') {
      this.logger.info(
        'gating',
        `danger score=${gate.value} confidence=${gate.confidence} < ${gate.threshold}: score NOT actionable -> preserveCurrentSafeAction(${decision.chosenId})`,
        { dangerGate: gate },
        this.tickCounter,
      )
    } else if (decision.outcome === 'override') {
      this.logger.warn(
        'gating',
        `danger score=${gate.value} (${gate.level}) confidence=${gate.confidence} >= ${gate.threshold}: actionable -> forcing safe action ${decision.chosenId} over ${chosenId}`,
        { dangerGate: gate },
        this.tickCounter,
      )
    }
    return { chosenId: decision.chosenId, overridden: decision.overridden }
  }

  private semanticEscalation(decision: JevResult): { escalate: boolean; reason: string } {
    const retreat = gateBoolean(decision.answers.should_retreat)
    if (retreat.band === 'strong_true') {
      return { escalate: true, reason: `strong semantic signal: should_retreat ${retreat.reason}` }
    }
    return { escalate: false, reason: 'no semantic escalation' }
  }

  /**
   * The only semantic replan trigger: an `abandon_option` vote that has explicit
   * `betaAuthority` and clears the deterministic prerequisite guard (#22/#46).
   * In the default shadow mode the controller never reaches here.
   */
  private adoptAbandon(decision: JevResult): boolean {
    if (!abandonRequested(decision)) return false
    const current = this.queue.current
    const optionId = current === null ? null : optionIdForGoal(current)
    if (!canAuthoritativelyAbandonOption(optionId)) {
      this.logger.warn(
        'heads',
        'BETA_NONAUTHORITATIVE option=none reason=no_current_option',
        { optionId: null, reason: 'no_current_option', beta: decision.answers.abandon_option?.probability ?? null },
        this.tickCounter,
      )
      return false
    }
    const vote = this.betaDecision(decision)
    const probability = decision.answers.abandon_option?.probability ?? null
    if (vote.adopt) {
      this.markOptionAbandoned(optionId, 'authority')
      this.summonLlm('no_progress', `abandon_option=${probability} crossed the replan threshold`)
      return true
    }
    const protection = this.reconciledProtection(vote.protection, optionId)
    if (protection.protect && !this.placeRetryExhausted()) {
      this.logger.warn(
        'heads',
        protection.line,
        { option: protection.option, because: protection.because, actionId: decisionIdFrom(decision), abandon: probability },
        this.tickCounter,
      )
      return false
    }
    this.markOptionAbandoned(optionId, 'authority')
    this.summonLlm('no_progress', `abandon_option=${probability} crossed the replan threshold`)
    return true
  }

  /**
   * #46: a required precondition is deterministic code, not a model vote. When
   * the last chosen action is the furnace prerequisite of the ready smelt, a
   * replan is suppressed (and logged) until the bounded placement retries run out.
   */
  private protectedReplanSuppressed(reason: LlmSummonReason): boolean {
    if (this.capabilityGapActive) return false
    if (reason !== 'no_progress' && reason !== 'action_impossible' && reason !== 'unknown_situation') return false
    const guard = shouldAdoptAbandon({
      actionId: this.lastDecisionId,
      goals: this.unfinishedGoals(),
      placedFurnaceCount: this.lastPlacedFurnaceCount,
      abandonRequested: true,
    })
    if (guard.adopt) return false
    const protection = this.reconciledProtection(guard.protection, reason)
    if (!protection.protect) return false
    if (this.placeRetryExhausted()) return false
    this.logger.warn(
      'heads',
      protection.line,
      { option: protection.option, because: protection.because, reason },
      this.tickCounter,
    )
    return true
  }

  private placeRetryExhausted(): boolean {
    return this.placementRetries.anyExhausted()
  }

  /**
   * The live breath reading, used by the ATTACK-lease safety exception. The
   * scheduler owns the `low_air` preempt and the sensor owns `SelfState.air`;
   * this is only the controller's view of the same fact for the interrupt
   * decision. A version that never reports `oxygenLevel` reads full air.
   */
  private liveAir(): number {
    const air = (this.bot as { oxygenLevel?: number }).oxygenLevel
    return typeof air === 'number' && Number.isFinite(air) ? air : MAX_AIR
  }

  private placeRetryCount(item: string | null): number {
    return this.placementRetries.countFor(item)
  }

  /** Unfinished goals in plan order; the protection guard spans the whole plan. */
  private unfinishedGoals(): QueuedGoal[] {
    return this.queue.state.goals.filter((goal) => goal.status === 'pending' || goal.status === 'active')
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
    const goal = `${this.currentGoalKey()}|depth=${state.goalQueue?.depth ?? 0}|revision=${state.goalQueue?.revision ?? this.queue.revision}|optionInstance=${current?.semanticOptionInstanceId ?? current?.optionInstanceId ?? 'none'}|optionTemplate=${current?.semanticOptionTemplateId ?? current?.optionTemplateId ?? 'none'}`
    return `fp2|epoch=${this.options.worldEpoch}|pos=${position}|inv=${inventory}|stations=${stations}|furnaces=${furnaces}|goal=${goal}`
  }

  /**
   * #11 v2 §6: protection and abandonment are mutually exclusive under one
   * fingerprint. When the guard still claims a protected option that the
   * abandonment ledger retired for the same fingerprint, the fact wins, the
   * contradiction is surfaced with the mirrored marker, and protection is off.
   */
  private reconciledProtection(protection: PrerequisiteProtection, reason: string): PrerequisiteProtection {
    const abandonedReason = protection.protect
      ? this.abandonedOptions.reasonUnder(protection.option, this.lastStateFingerprint)
      : null
    const reconciliation = reconcileProtection({ protection, abandonedReason })
    if (reconciliation.conflictLine !== null && abandonedReason !== null) {
      this.logProtectionAbandonConflict(protection.option, abandonedReason, reason)
    }
    return reconciliation.protect === protection.protect
      ? protection
      : { ...protection, protect: reconciliation.protect }
  }

  private logProtectionAbandonConflict(option: string, abandonedReason: string, reason: string): void {
    if (!this.abandonedOptions.claimConflict(option, this.lastStateFingerprint)) return
    this.logger.warn(
      'heads',
      formatProtectionAbandonConflict(option, 'abandoned', abandonedReason),
      { option, action: 'abandoned', abandonedReason, reason, fingerprint: this.lastStateFingerprint },
      this.tickCounter,
    )
  }

  /**
   * Record a deterministic abandonment under the current fingerprint. If the
   * precondition guard would still protect the same option right now, the
   * contradiction is emitted once (the live defect A sequence).
   */
  private markOptionAbandoned(optionId: string | null, reason: string): void {
    if (optionId === null) return
    const option = prerequisiteOptionName(optionId)
    const guard = shouldAdoptAbandon({
      actionId: optionId,
      goals: this.unfinishedGoals(),
      placedFurnaceCount: this.lastPlacedFurnaceCount,
      abandonRequested: true,
    })
    if (guard.protection.protect) this.logProtectionAbandonConflict(option, reason, 'abandoned')
    this.abandonedOptions.markAbandoned(option, this.lastStateFingerprint, reason)
  }

  /**
   * #11 v2 §7: one candidate until a fact changes. While a flap window is
   * active the policy's raw choice is replaced by the cheap-feasible commitment;
   * a deterministic rejection releases it to the next cheapest feasible.
   */
  private applyCandidateCommitment(
    chosenId: string,
    candidates: readonly Candidate[],
    state: WorldState,
  ): string {
    const progressed = this.progressEpoch !== this.commitmentProgressEpoch
    this.commitmentProgressEpoch = this.progressEpoch
    const offered: readonly FlapCandidate[] = candidates.map((candidate, index) => ({
      id: candidate.id,
      cost: this.candidateCommitCost(candidate, index),
    }))
    const decision = evaluateCandidateFlap({
      previous: this.commitmentState,
      chosenId,
      fingerprint: this.lastStateFingerprint,
      progressed,
      candidates: offered,
      invalid: this.deterministicInvalid(candidates, state),
    })
    this.commitmentState = decision.state
    if (decision.line !== null) {
      this.logger.warn(
        'policy',
        decision.line,
        { chosenId, committedId: decision.state.committedId, fingerprint: this.lastStateFingerprint },
        this.tickCounter,
      )
    }
    if (decision.releaseLine !== null) {
      this.logger.warn(
        'policy',
        decision.releaseLine,
        { chosenId, committedId: decision.state.committedId },
        this.tickCounter,
      )
    }
    return decision.chosenId
  }

  /** The caller's existing cost policy: a declared cost, else the generator order. */
  private candidateCommitCost(candidate: Candidate, index: number): number {
    const cost = candidate.meta.cost
    if (typeof cost === 'number') return cost
    const prereqCost = candidate.meta.prereqCost
    if (typeof prereqCost === 'number') return prereqCost
    return index
  }

  /** Candidate ids deterministic feasibility has already rejected. */
  private deterministicInvalid(candidates: readonly Candidate[], state: WorldState): ReadonlySet<string> {
    const invalid = new Set<string>(this.withheldCandidateIds)
    for (const candidate of candidates) {
      if (unreachableMove(candidate, state) !== null) invalid.add(candidate.id)
    }
    return invalid
  }

  /**
   * Action-lifecycle commitment: hold the action the executor is ALREADY running
   * for a bounded window instead of letting this decision cancel it via
   * `Executor.claim` (which cancels any different in-flight action first).
   *
   * This is the same authority invariant as the flap commitment: it can only
   * keep the action Jev already chose, or release to the raw choice - code never
   * substitutes a different candidate. `ACTION_COMMIT` is logged when a switch is
   * suppressed; `ACTION_PREEMPT` when the held action is released and replaced.
   */
  private applyActionCommitment(
    chosenId: string,
    candidates: readonly Candidate[],
    state: WorldState,
  ): string {
    const running = this.executor.current
    const invalid = running === null ? null : this.deterministicInvalid(candidates, state)
    // SAFE: in melee contact a threat response must execute now. Code owns only
    // the contact fact and the kind test; the choice is still Jev's (the newer
    // one). Without this, the measured fight held the in-flight RETREAT while
    // Jev selected ATTACK three decisions in a row and the body never swung.
    const chosen = candidates.find((candidate) => candidate.id === chosenId) ?? null
    const contactThreatResponse =
      chosen !== null &&
      CONTACT_THREAT_KINDS.has(chosen.kind) &&
      state.entities.some((entity) => entity.hostile && entity.distance <= MELEE_THREAT_REACH)
    const decision = evaluateActionCommitment({
      previous: this.actionCommitmentState,
      inFlight:
        running === null
          ? null
          : { id: running.id, epoch: running.epoch, startedAtMs: running.startedAt },
      chosenId,
      planKey: this.actionCommitmentPlanKey(state),
      nowMs: Date.now(),
      inFlightInvalid: running !== null && invalid !== null && invalid.has(running.id),
      inFlightOffered: running !== null && candidates.some((candidate) => candidate.id === running.id),
      contactThreatResponse,
    })
    this.actionCommitmentState = decision.state
    if (decision.line !== null) {
      this.logger.warn(
        'policy',
        decision.line,
        { chosenId, heldId: decision.chosenId, planKey: this.actionCommitmentPlanKey(state) },
        this.tickCounter,
      )
    }
    if (decision.releaseLine !== null) {
      this.logger.warn(
        'policy',
        decision.releaseLine,
        { chosenId, heldId: null, planKey: this.actionCommitmentPlanKey(state) },
        this.tickCounter,
      )
    }
    return decision.chosenId
  }

  /** Plan/goal identity for the action commitment; a change resets it. */
  private actionCommitmentPlanKey(state: WorldState): string {
    const current = state.goalQueue?.current
    return `${this.currentGoalKey()}|plan=${current?.id ?? 'none'}|rev=${state.goalQueue?.revision ?? this.queue.revision}`
  }

  /**
   * #327 follow-up: bound the chosen no-op WAIT while real actionable candidates
   * are offered. The policy model itself can keep choosing WAIT with several real
   * actions on the table; no existing counter sees that (`LOCAL_RECOVERY_*` only
   * advance on suppressed replans, `ACTION_FAILURE_*` only on typed action
   * failures, and the #43 WAIT wedge is suppressed when the junk-inventory
   * fingerprint churns every tick).
   *
   * On the Nth consecutive actionable WAIT the local recovery is exhausted:
   * `WAIT_EXHAUSTED` is logged, `progress_stall` wakes System2 through the same
   * `escalate()` path #326/#337 use, and WAIT is removed for exactly one decision
   * so the policy must choose a real candidate. The streak clears on any non-WAIT
   * choice, on `actionable === 0`, on a goal/plan change (inside the counter), on
   * progress (in `onActionComplete`), and on the Nth decision - so the next
   * escalation needs N fresh WAITs and no hot wake loop is possible. Its
   * fingerprint is exposed through `replanInputs()` so the #44 throttle cannot
   * swallow this one wake as `no_new_info`.
   */
  private noteWaitStreak(chosenId: string, actionable: number): void {
    const goalKey = this.currentGoalKey()
    const decision = this.waitStreakEscalation.noteChoice(chosenId, actionable, goalKey)
    if (decision.count === 0) return
    const detail = {
      goal: goalKey,
      actionable,
      count: decision.count,
      limit: decision.limit,
    }
    if (!decision.escalate) {
      this.logger.warn('policy', formatWaitStreak(decision), detail, this.tickCounter)
      return
    }
    this.logger.warn('policy', formatWaitExhausted(decision), { ...detail, boundary: 'semantic_boundary' }, this.tickCounter)
    // Force the next decision to choose a real candidate, then reset so the
    // bound cannot hot-loop: N fresh WAITs are required before the next wake.
    this.waitSuppressed = true
    this.escalate(
      'progress_stall',
      `WAIT_EXHAUSTED count=${decision.count}/${decision.limit} goal=${goalKey} actionable=${actionable}`,
    )
    this.waitStreakEscalation.reset()
  }

  /**
   * #46 requirement 2: a placement failure at one spot is NOT an abandon. Log
   * PLACE_RETRY while the bounded attempts remain, then RETIRE the candidate
   * family with one typed `PLACE_RETRIES_EXHAUSTED` so it cannot be re-offered
   * forever. The ledger clamps the ordinal at limit+1 and the retired item set
   * is threaded into the candidate generator, which is what makes the limit
   * authoritative instead of advisory (measured live: count=18 against limit=5).
   */
  private schedulePlaceRetry(result: ExecutionResult, candidate: Candidate): boolean {
    const at =
      candidate.target ??
      ({
        x: Math.floor(this.bot.entity.position.x),
        y: Math.floor(this.bot.entity.position.y),
        z: Math.floor(this.bot.entity.position.z),
      } satisfies Vec3Json)
    const item = candidate.itemName
    const decision = this.placementRetries.noteFailure({
      item,
      actionId: result.actionId,
      at,
      reason: result.failure ?? 'place_failed',
    })
    if (!decision.retry) {
      // The retire line is emitted exactly once by the ledger. If the ledger
      // already announced this family, keep the existing `retry_exhausted` audit
      // line for the repeated failure but never report the bound as still live.
      const line =
        decision.exhaustedLine ??
        `${PLACE_RETRIES_EXHAUSTED} at=${at.x},${at.y},${at.z} item=${item ?? 'unknown'} count=${decision.count}/${decision.limit} actionId=${result.actionId} reason=${result.failure} (already retired)`
      this.logger.warn(
        'agent',
        line,
        {
          actionId: result.actionId,
          item,
          count: decision.count,
          limit: decision.limit,
          reason: result.failure,
          retired: this.placementRetries.isItemRetired(item),
        },
        this.tickCounter,
      )
      return false
    }
    this.logger.warn(
      'agent',
      decision.line,
      { actionId: result.actionId, count: decision.count, limit: decision.limit, reason: result.failure },
      this.tickCounter,
    )
    return true
  }

  private criticalArrivedDuringFlight(trigger: DecisionTrigger): boolean {
    const pending = this.pendingTrigger
    const deferred = this.deferredTrigger
    const critical = [pending, deferred].find((event) => event !== null && CRITICAL_TRIGGERS.has(event.trigger))
    if (critical === undefined || critical === null) return false
    if (!CRITICAL_TRIGGERS.has(trigger)) return true
    return criticalThreatFamily(trigger) !== criticalThreatFamily(critical.trigger)
  }

  private hasCriticalTriggerDuringFlight(): boolean {
    const pending = this.pendingTrigger
    const deferred = this.deferredTrigger
    return (
      (pending !== null && CRITICAL_TRIGGERS.has(pending.trigger)) ||
      (deferred !== null && CRITICAL_TRIGGERS.has(deferred.trigger))
    )
  }

  private async decide(
    state: WorldState,
    candidates: readonly Candidate[],
    trigger: DecisionTrigger,
    chainId: string,
  ): Promise<JevResult> {
    this.lastAbandonAdopted = false
    const now = Date.now()
    const stateHash = stableStateHash(state)
    // §6 rate evidence. The raw-state reuse key (`stateHash ===
    // this.lastDecisionStateHash`) is GONE: `stableStateHash` covers `tick`, the
    // float body position and the per-tick `recentEvents`, so it changed every
    // tick and the old gate effectively never fired. The semantic projection hash
    // below is the reuse key now; `sinceLastCallMs` only reports how fast the
    // semantic plane is moving.
    const sinceLastCallMs = this.lastJevAt === 0 ? null : now - this.lastJevAt
    const identityContext = {
      optionInstanceId: optionIdForGoal(state.goalQueue.current) ?? state.currentOption?.instanceId ?? null,
      dimension: state.self.dimension,
      worldEpoch: this.options.worldEpoch,
    }
    // §4/§8: the semantic offer - stable identities, mechanically-equivalent
    // realizations collapsed. The controller keeps the FULL grounded set for
    // guard/commitment/execution; only the model's choice set is deduped, and
    // every representative id below is a real member of that full set.
    const dedupe = dedupeSemanticCandidates(candidates, identityContext, (candidateId) =>
      failureCount(state.signals.failedCandidates, candidateId),
    )
    const projection = this.buildSemanticProjection(state, candidates, dedupe.merged)
    // The projection's own candidate views are the single source of truth for the
    // hash, the log and the offer: one identity function, no drift.
    const views = projection.candidates
    const hash = semanticProjectionHash(projection)
    const candidateIdentities = views.map((view) => view.identity)

    // §3: a world/epoch change invalidates the ACTIVE epoch, so a result
    // attributed to it can no longer authorize a commitment.
    if (!this.decisionEpochs.matchesWorld({ dimension: state.self.dimension, worldEpoch: this.options.worldEpoch })) {
      const invalidated = this.decisionEpochs.invalidate('world_changed')
      if (invalidated !== null) {
        this.logger.warn(
          'policy',
          formatStaleResultDropped(invalidated.epoch, null, 'world_or_epoch_changed'),
          { projectionHash: invalidated.projectionHash, dimension: state.self.dimension },
          this.tickCounter,
        )
      }
    }

    // §6/§9: re-query only at a semantic boundary. A settled mechanical step with
    // an unchanged semantic projection is NOT a policy event, so the previous
    // decision is replayed inside a NEW epoch: causal isolation is preserved (the
    // replay is attributed to the current epoch, never to the stale one), and no
    // model call is spent on an identical semantic state.
    const boundary = classifySemanticBoundary({
      active: this.decisionEpochs.active,
      projectionHash: hash,
      candidateIdentities,
      worldKey: { dimension: state.self.dimension, worldEpoch: this.options.worldEpoch, leaseHeld: true },
      optionKey: projection.option.instanceId,
      safetyKey: JSON.stringify(projection.safety),
      goalKey: projection.goal.key,
      lastOutcomeRequiredDecision: this.skillOutcomeBoundary,
    })
    // §4/§10: the cached decision names the realization that was representative
    // when the model chose. Identity is stable, the realization id is mechanical,
    // so the SAME semantic choice is re-pointed at the current representative. If
    // the chosen identity is gone the state genuinely changed -> re-query below
    // instead of replaying an unusable decision.
    const replayed = this.lastDecision === null ? null : this.repointReplay(this.lastDecision, views)
    if (!boundary.requery && replayed !== null) {
      const previousActive = this.decisionEpochs.active
      const reusedFrom = previousActive?.epoch ?? null
      const epoch = this.decisionEpochs.begin({
        projectionHash: hash,
        candidateIdentities,
        dimension: state.self.dimension,
        worldEpoch: this.options.worldEpoch,
        nowMs: now,
        cacheHit: true,
        reusedFrom,
      })
      this.logEpochSuperseded(previousActive)
      this.logBoundary(epoch, boundary.reason, projection, hash, views, trigger, sinceLastCallMs)
      this.lastSemanticProjection = projection
      this.lastProjectionHash = hash
      this.skillOutcomeBoundary = false
      this.lastDecision = replayed
      return replayed
    }

    try {
      this.policyEpoch += 1
      this.issuedPolicyEpoch = this.policyEpoch
      this.issuedCandidateHash = candidateIdentities.join('|')
      const previousActive = this.decisionEpochs.active
      const epoch = this.decisionEpochs.begin({
        projectionHash: hash,
        candidateIdentities,
        dimension: state.self.dimension,
        worldEpoch: this.options.worldEpoch,
        nowMs: now,
      })
      this.logEpochSuperseded(previousActive)
      this.logBoundary(epoch, boundary.reason, projection, hash, views, trigger, sinceLastCallMs)
      this.lastSemanticProjection = projection
      this.lastProjectionHash = hash
      this.skillOutcomeBoundary = false
      // issue #436 section 3: `candidates.length === 1` is deliberately NOT a
      // Jev bypass here. A superficially single remaining candidate does not prove
      // there is no semantic choice (generation may be incomplete, the active
      // Option may be stale, and beta still owns semantic termination), so policy
      // is consulted on every decision regardless of the candidate count. The only
      // deterministic authority classes are a selected Skill's mechanical
      // continuation / DONE / hard safety / the U1..U6 prerequisite contract, and
      // each of those is recorded by the executor's `SKILL_STEP authority=`.
      const result = await this.jev.decide({
        stage: `policy-tick-${this.tickCounter}-${trigger}`,
        state,
        // §8: Jev sees one representative per semantic identity. The controller's
        // own `candidates` stays complete, so guard/commitment resolution and the
        // executor are unchanged.
        candidates: dedupe.offered,
        semanticProjection: projection,
        projectionHash: hash,
        questionNames: questionNamesFor(questionSetForTrigger(trigger)),
      })
      this.jevCalls += 1
      this.lastJevAt = Date.now()
      this.lastDecision = result
      this.lastDecisionId = decisionIdFrom(result)
      this.signals.lastPolicyConfidence = result.answers.action?.confidence ?? null

      // §3: only the ACTIVE epoch may authorize. A result whose epoch was
      // invalidated while the model call was in flight is DROPPED here, before
      // any commitment is claimed.
      const acceptance = this.decisionEpochs.accept(epoch.epoch)
      if (!acceptance.accepted) {
        this.staleDecisionDropped = true
        this.logger.warn(
          'policy',
          formatStaleResultDropped(epoch.epoch, this.decisionEpochs.active?.epoch ?? null, acceptance.reason),
          { trigger, callId: result.callId, chosen: this.lastDecisionId },
          this.tickCounter,
        )
        return result
      }

      const chosen = dedupe.offered.find((candidate) => candidate.id === this.lastDecisionId)
      this.logger.info(
        'policy',
        `trigger=${trigger} -> action=${this.lastDecisionId ?? 'none'} kind=${chosen?.kind ?? 'unknown'} | ${chosen?.label ?? 'no matching candidate'}`,
        {
          trigger,
          source: result.source,
          policy: result.policy,
          model: result.model,
          callId: result.callId,
          chainId,
          projectionHash: hash,
          decisionEpoch: epoch.epoch,
          latencyMs: result.latencyMs,
          inputTokens: result.usage?.inputTokens ?? null,
          actionConfidence: result.answers.action?.confidence ?? null,
          dangerScore: result.answers.danger?.value ?? null,
          dangerConfidence: result.answers.danger?.confidence ?? null,
          shouldRetreat: result.answers.should_retreat?.probability ?? null,
          abandonOption: result.answers.abandon_option?.probability ?? null,
        },
        this.tickCounter,
      )
      const planGoal = state.goalQueue.current
      const optionId = optionIdForGoal(planGoal)
      const planId = planRevisionForGoal(planGoal)
      const verdict = this.abandonVerdict(result, optionId, planId)
      this.logHeads(result, verdict, chainId)
      this.logShadowMetrics(state)
      this.lastAbandonAdopted = this.applyAbandon(result, verdict)

      const confidence = result.answers.action?.confidence
      if (typeof confidence === 'number' && confidence < this.options.lowConfidenceThreshold) {
        this.escalate(
          'low_confidence',
          `action confidence ${confidence} < ${this.options.lowConfidenceThreshold} for ${this.lastDecisionId ?? 'none'}`,
        )
      }
      return result
    } catch (error) {
      const fatal = error instanceof FatalModelError ? error : new FatalModelError('jev-policy', 1, describeFailure(error))
      return failLoud(fatal, (event, detail) => this.logger.error('policy', event, { trigger, ...(detail ?? {}) }, this.tickCounter), this.options.terminateOnModelFailure)
    }
  }

  /**
   * §12: emit the three Jev-plane records for one decision - the epoch that owns
   * it, the projection hash/version Jev saw, and the stable candidate identities
   * offered. One line each, so the boundary is reconstructible from the log.
   */
  private logBoundary(
    epoch: ReturnType<JevDecisionEpochs['begin']>,
    reason: string,
    projection: JevSemanticProjection,
    hash: string,
    views: readonly SemanticCandidateView[],
    trigger: DecisionTrigger,
    sinceLastCallMs: number | null,
  ): void {
    const change =
      reason === 'semantic_state_changed' && this.lastSemanticProjection !== null
        ? classifyProjectionChange(this.lastSemanticProjection, projection)
        : null
    // §6: `flap=true` means the semantic plane changed faster than
    // `minJevIntervalMs` - the gate is working as designed (a real semantic change
    // always re-queries) but the projection is quantized too finely for this
    // situation if it stays true. Evidence only; it never suppresses a query,
    // because replaying a genuinely changed semantic state would be exactly the
    // hidden-staleness §6 forbids. This is what keeps `minJevIntervalMs` a live
    // diagnostic instead of the dead rate-limit key it was before #437.
    const flap = sinceLastCallMs !== null && sinceLastCallMs < this.options.minJevIntervalMs
    this.logger.info(
      'policy',
      formatEpochStart(epoch, reason),
      {
        trigger,
        projectionHash: hash,
        ...(sinceLastCallMs === null ? {} : { sinceLastCallMs, flap }),
        ...(change ?? {}),
      },
      this.tickCounter,
    )
    this.logger.info('policy', formatJevStateProjection(projection, hash), { trigger }, this.tickCounter)
    this.logger.info('policy', formatJevCandidateSet(views), { trigger, offered: views.length }, this.tickCounter)
  }

  /**
   * §12: exactly one `JEV_DECISION_EPOCH_END` per epoch. An epoch that is
   * superseded by the next decision (rather than closed by an outcome packet)
   * still gets its end record, so `START`/`END` balance in the run log.
   */
  private logEpochSuperseded(previous: DecisionEpoch | null): void {
    if (previous === null || !previous.closed) return
    this.logger.info('policy', formatEpochEnd(previous), {}, this.tickCounter)
  }

  /**
   * §4/§10: re-point a replayed decision at the current representative of the
   * SAME semantic identity (see `repointReplayedChoice`). Returns null when the
   * chosen identity is no longer offered, which means the semantic state really
   * did change and the caller must re-query rather than replay. Never changes the
   * choice: only its mechanical realization id.
   */
  private repointReplay(result: JevResult, views: readonly SemanticCandidateView[]): JevResult | null {
    const choice = repointReplayedChoice(
      decisionIdFrom(result),
      this.lastSemanticProjection?.candidates ?? [],
      views,
    )
    if (choice.lost) return null
    if (!choice.repointed || choice.chosenId === null) return result
    const answer = result.answers.action
    if (answer === undefined) return result
    this.logger.info(
      'policy',
      `JEV_REPLAY_REPOINTED identity=${this.lastSemanticProjection?.candidates.find((view) => view.id === decisionIdFrom(result))?.identity ?? 'unknown'} from=${decisionIdFrom(result) ?? 'none'} to=${choice.chosenId}`,
      { trigger: 'semantic_boundary' },
      this.tickCounter,
    )
    return { ...result, answers: { ...result.answers, action: { ...answer, value: choice.chosenId } } }
  }

  /**
   * §7: the previous selection and how it ended, carried causally into the next
   * projection. `identity` comes from the projection Jev last saw, so the
   * semantic identity survives even when the mechanical realization id changed.
   */
  private previousDecisionFacts(): PreviousDecisionFacts | null {
    const outcome = this.lastSkillOutcome
    if (this.lastDecisionId === null && outcome === null) return null
    const view =
      this.lastDecisionId === null
        ? undefined
        : this.lastSemanticProjection?.candidates.find((candidate) => candidate.id === this.lastDecisionId)
    return {
      selectedCandidateId: this.lastDecisionId,
      selectedIdentity: view?.identity ?? null,
      skillKind: view?.kind ?? this.lastSkillOutcome?.skillKind ?? null,
      targetKey: outcome === null ? null : `${outcome.targetIdentity.kind}:${outcome.targetIdentity.key}`,
      commitmentId: outcome?.commitmentId ?? null,
      terminalReason: outcome?.terminalReason ?? null,
      failureCode: outcome?.failure?.code ?? null,
      progressKind: outcome?.semanticProgress.kind ?? null,
    }
  }

  /**
   * §5: grounded world facts relevant to the current Option, keyed by semantic
   * identity so a resource's cell never becomes a churn fact.
   */
  private semanticFacts(state: WorldState): GroundedFact[] {
    const facts: GroundedFact[] = []
    const resources = new Set<string>()
    for (const resource of state.signals.knownResources ?? []) {
      if (facts.length >= 8) break
      if (resources.has(resource.name)) continue
      resources.add(resource.name)
      facts.push({ kind: 'resource', key: resource.name, detail: `${resource.name} is known to the world memory` })
    }
    const portalSites = state.portalFrameSites?.length ?? 0
    if (portalSites > 0 || state.portalFrame != null) {
      facts.push({
        kind: 'structure',
        key: 'portal_frame',
        detail: state.portalFrame == null ? `${portalSites} portal site(s) grounded` : 'complete portal frame validated',
      })
    }
    if (this.activeRetrieval !== null) {
      facts.push({
        kind: 'target',
        key: `retrieval:${this.activeRetrieval.resource}`,
        detail: `the active retrieval target is ${this.activeRetrieval.resource}`,
      })
    }
    if (this.capabilityGapActive) {
      facts.push({
        kind: 'capability',
        key: this.capabilityGapSignature ?? 'capability_gap',
        detail: 'a capability gap is currently grounded',
      })
    }
    if (this.starvationContext !== null) {
      facts.push({
        kind: 'blocked',
        key: this.starvationContext.blockedBy,
        detail: `local candidates are blocked by ${this.starvationContext.blockedBy}`,
      })
    }
    const queue = state.goalQueue
    if (queue.current !== null) {
      facts.push({
        kind: 'goal',
        key: `${queue.current.id}:${queue.current.requiredCount ?? 0}`,
        detail: `queue head is ${queue.current.description}`,
      })
    }
    return facts
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
    const option = state.currentOption ?? null
    const optionId = optionIdForGoal(state.goalQueue.current) ?? option?.instanceId ?? null
    const threat = this.signals.threat ?? null
    const critical = this.signals.criticalDamage ?? null
    const lastDamage = this.signals.lastDamage ?? null
    const stall = this.signals.strategicNonProgress ?? null
    const progress: SemanticProgressFacts = {
      consecutiveFailures: this.signals.consecutiveFailures,
      lastFailureCode: this.signals.lastFailureCode ?? null,
      escalationRecommended: this.signals.escalationRecommended === true,
      oscillationsDetected: this.signals.oscillationsDetected ?? 0,
      stallExhausted: stall === null ? null : stall.exhausted === true,
      stallDistinctStates: stall === null ? null : stall.distinctStates ?? null,
    }
    const base = buildJevSemanticProjection({
      goal: {
        key: this.currentGoalKey(),
        targetItem: this.goal.targetItem ?? null,
        have: this.goal.haveCount,
        required: this.goal.requiredCount,
        complete: this.goal.complete === true,
        progress: this.goal.progress,
      },
      option: {
        instanceId: optionId,
        templateId: option?.templateId ?? null,
        skillKind: option?.kind ?? null,
        targetKey: option === null ? null : JSON.stringify(option.target),
      },
      world: {
        dimension: state.self.dimension,
        worldEpoch: this.options.worldEpoch,
        generationId: null,
        leaseHeld: true,
        alive: state.self.health > 0,
      },
      safety: {
        healthBand: healthBand(state.self.health),
        foodBand: foodBand(state.self.food),
        airBand: airBand(state.self.air ?? null),
        submerged:
          state.self.feetInWater === undefined && state.self.eyesInWater === undefined
            ? null
            : state.self.feetInWater === true || state.self.eyesInWater === true,
        threatKey:
          threat === null
            ? null
            : `${threat.threatName ?? 'unknown'}:${threatBand(threat.threatDistance ?? null)}:${threat.inContact === true}`,
        criticalDamageKey: critical === null ? null : `${critical.planKey}:${critical.consecutiveDamage}:${critical.sourceName ?? 'unattributed'}`,
        lastDamageKey: lastDamage === null ? null : `${lastDamage.sourceId ?? 'unknown'}`,
      },
      progress,
      sense: {
        blockNames: state.blocks.map((block) => block.name),
        threats: state.entities
          .filter((entity) => entity.hostile === true)
          .map((entity) => `${entity.name ?? 'unknown'}:${threatBand(entity.distance)}`),
      },
      inventory: state.inventory.counts,
      events: state.recentEvents,
      candidates,
      identityContext: {
        optionInstanceId: optionId,
        dimension: state.self.dimension,
        worldEpoch: this.options.worldEpoch,
      },
      failureCount: (candidateId) => failureCount(state.signals.failedCandidates, candidateId),
      previous: this.previousDecisionFacts(),
      recentOutcomes: this.recentSkillOutcomes,
      facts: this.semanticFacts(state),
      rawTelemetry: { skillSteps: this.compressedSkillSteps, events: state.recentEvents.length },
    })
    const delta = diffSemanticProjections(this.lastSemanticProjection, base).delta
    return {
      ...base,
      meaningfulDelta: delta,
      counts: { ...base.counts, candidatesMerged: mergedCandidates },
    }
  }

  /**
   * §2/§12: compress a settled Skill into ONE typed SkillOutcomePacket, store it
   * as the bounded previous-outcome context, and close the decision epoch it
   * belongs to. Pure evidence: it never chooses anything.
   */
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
    const binding = input.leaseEpoch === null ? null : this.actionEpochByLease.get(input.leaseEpoch) ?? null
    if (input.leaseEpoch !== null) this.actionEpochByLease.delete(input.leaseEpoch)
    const option = this.currentOptionContext()
    const target =
      input.candidate === null
        ? { kind: 'none' as const, key: input.targetName ?? 'unknown', label: input.actionId }
        : semanticTargetRef(input.candidate)
    const deltas: SemanticDelta[] = []
    if (input.blockRemoved) {
      deltas.push({ fact: 'block.removed', from: null, to: input.targetName ?? input.actionId })
    }
    if (input.itemsGained > 0) deltas.push({ fact: 'inventory.gained', from: 0, to: input.itemsGained })
    if (input.entityDefeated) {
      deltas.push({ fact: 'target.entity', from: `e${input.candidate?.targetEntityId ?? -1}`, to: 'dead' })
    }
    const facts: GroundedFact[] = []
    if (input.failure === 'target_gone') {
      facts.push({
        kind: 'target',
        key: target.key,
        detail: 'the selected target is no longer present (TARGET_LOST, not killed)',
      })
    }
    const packet = buildSkillOutcomePacket({
      decisionEpoch: binding?.epoch ?? this.decisionEpochs.active?.epoch ?? 0,
      commitmentId:
        binding?.commitmentId ??
        (input.leaseEpoch === null
          ? `g:${input.actionId}`
          : commitmentRefFor({ candidateId: input.actionId, epoch: input.leaseEpoch })),
      optionInstanceId: option?.instanceId ?? null,
      selectedCandidateId: input.actionId,
      skillKind: input.kind,
      targetIdentity: target,
      status: input.status,
      failure: input.failure,
      verified: input.verified,
      postcondition: input.verification,
      verificationDetail: input.verification,
      progressDelta: input.verified ? Math.max(0, input.itemsGained + (input.blockRemoved ? 1 : 0)) : 0,
      progressed: input.progressed,
      meaningfulWorldDelta: deltas,
      newFacts: facts,
      optionComplete: this.goal.complete === true,
      compressedSteps: this.compressedSkillSteps,
    })
    this.recentSkillOutcomes.push(packet)
    if (this.recentSkillOutcomes.length > 3) this.recentSkillOutcomes.shift()
    this.lastSkillOutcome = packet
    // §6: target/capability/safety/world/lease outcomes destroy the premise of the
    // previous decision, so policy must be re-asked. A repeated mechanical blocker
    // is carried by the projection instead (no per-retry Jev call).
    this.skillOutcomeBoundary = mandatoryPolicyBoundary(packet.terminalReason)
    this.compressedSkillSteps = 0
    this.logger.info(
      'agent',
      formatSkillOutcomePacket(packet),
      {
        actionId: input.actionId,
        terminalReason: packet.terminalReason,
        progress: packet.semanticProgress.kind,
        delta: packet.meaningfulWorldDelta.length,
        nextDecisionRequired: packet.nextDecisionRequired,
      },
      this.tickCounter,
    )
    const closed = this.decisionEpochs.close({ epoch: packet.decisionEpoch, reason: packet.terminalReason })
    if (closed !== null) {
      this.logger.info('policy', formatEpochEnd(closed), { actionId: input.actionId }, this.tickCounter)
    }
    return packet
  }

  private onGuardReject(
    guarded: Extract<GuardResult, { ok: false }>,
    decision: JevResult,
    record: DecisionRecord,
    candidate: Candidate | undefined,
  ): void {
    attachResult(record, {
      actionId: guarded.candidateId,
      success: false,
      durationMs: 0,
      damageTaken: 0,
      progress: this.goal.progress,
      status: 'guard-rejected',
      failureCode: guarded.code,
      verified: false,
      blockRemoved: false,
      dropObserved: false,
    })
    this.decisionWriter.write(record)
    if (guarded.code === 'CONFLICT_IN_FLIGHT') {
      // expected: the in-flight action keeps ownership, the new mine waits
      this.conflictDeferrals += 1
      this.logger.info(
        'guard',
        `deferred ${guarded.candidateId} -> ${guarded.reason}`,
        { code: guarded.code, decisionCallId: decision.callId, chainId: record.chainId },
        this.tickCounter,
      )
      return
    }
    this.guardRejections += 1
    this.logger.warn(
      'guard',
      `REJECTED ${guarded.candidateId} code=${guarded.code} :: ${guarded.reason}`,
      { code: guarded.code, policy: decision.policy, callId: decision.callId, chainId: record.chainId },
      this.tickCounter,
    )
    // The `guard` category is not part of the mirrored agent stream, so without
    // this line a selected candidate that the guard drops leaves no diagnosable
    // trace at all (see ACTION_REJECTED in policy.ts). Emit the typed cause on
    // the mirrored path with the same candidate id, code and reason.
    this.logger.warn(
      'agent',
      formatActionRejected(guarded.candidateId, guarded.code, guarded.reason),
      {
        actionId: guarded.candidateId,
        code: guarded.code,
        reason: guarded.reason,
        policy: decision.policy,
        callId: decision.callId,
        chainId: record.chainId,
      },
      this.tickCounter,
    )
    this.recentEvents.push(`guard ${guarded.code} on ${guarded.candidateId}`)
    this.noteCandidateFailure(guarded.candidateId)
    const movementFailure = guardMoveFailureReason(candidate, guarded.code)
    if (candidate !== undefined && movementFailure !== null) this.recordMoveFailure(candidate, movementFailure)
    if (candidate !== undefined) this.logSmeltStationRetry(candidate)
    this.chargeGuardRejection(record, guarded.code)
    this.recordFailure(guarded.code, guarded.reason)
    // §2: a deterministic guard refusal is a settled typed outcome of THIS
    // selection, so it crosses the boundary as a packet (never as a silent drop).
    this.emitSkillOutcomePacket({
      actionId: guarded.candidateId,
      kind: candidate?.kind ?? 'WAIT',
      leaseEpoch: null,
      status: 'guard-rejected',
      failure: guarded.code,
      verified: false,
      progressed: false,
      itemsGained: 0,
      blockRemoved: false,
      entityDefeated: false,
      targetName: candidate?.targetName ?? null,
      candidate: candidate ?? null,
      verification: 'rejected_before_execution',
    })
  }

  /**
   * #79: a mechanical guard rejection is a settled zero-progress outcome for the
   * option that was just chosen. A rejected candidate never reaches
   * `onActionComplete`, which is the only other place the unproductive counter
   * is fed, so without this a permanently rejected option stays at `attempts=0`
   * and its abandon request is suppressed as "speculative" forever
   * (`abandonEnforced=false`). Charging it here lets the bounded attempt limit
   * retire the option with `reason=unproductive`.
   */
  private chargeGuardRejection(record: DecisionRecord, code: GuardCode): void {
    if (!guardRejectionChargesOption(code)) return
    const optionId = record.optionId
    if (optionId === null || optionId.length === 0) return
    this.optionAttempts.noteOutcome(
      {
        optionId,
        planId: record.goalQueueState.current?.id ?? null,
        verified: false,
        progressDelta: 0,
      },
      Date.now(),
    )
  }

  /**
   * issue #436 section 4: stamp the selection provenance onto the candidate the
   * executor will claim. `selectedBy` is honest about which policy chose it, the
   * epoch ties the commitment to the decision that authorized it, and the world
   * epoch is what a later lifecycle revalidation compares against.
   */
  private stampSelectionProvenance(candidate: Candidate, decision: JevResult, record: DecisionRecord): Candidate {
    const optionInstanceId = record.semanticOptionInstanceId ?? record.optionId ?? null
    return {
      ...candidate,
      meta: {
        ...candidate.meta,
        decisionEpoch: this.decisionEpochs.active?.epoch ?? 0,
        decisionId: decision.callId,
        selectedBy: decision.policy === 'typesafe' ? 'jev' : 'deterministic',
        stateFingerprint: record.stateHash,
        worldEpoch: this.options.worldEpoch,
        ...(optionInstanceId === null ? {} : { optionInstanceId }),
      },
    }
  }

  /**
   * issue #436 section 14/23: the running commitment's contract can be broken by
   * the world it was grounded in, independently of any target-claim
   * contradiction: the dimension changed, or the host's world epoch moved.
   *
   * This is deterministic cancellation, never a recovery: the commitment's
   * `CausalTargetIdentity` is meaningless in another world, so the action is
   * CANCELLED with the typed `WORLD_CHANGED` outcome (`SKILL_INVALIDATED`, then
   * the ordinary `SKILL_OUTCOME_PACKET`/`SKILL_END` close it). Code does not pick
   * a replacement target; the tick continues to Jev, which owns WHICH is next.
   */
  private cancelInvalidCommitment(state: WorldState): void {
    const running = this.executor.current
    const commitment = running?.commitment ?? null
    if (running === null || commitment === null) return
    const observedDimension = typeof state.self.dimension === 'string' ? state.self.dimension : 'unknown'
    const reason = commitmentInvalidation({
      commitment,
      observedDimension,
      observedWorldEpoch: this.options.worldEpoch,
      // The actuation lease is the HOST's: a revoked lease already aborts this
      // action through `ensureOwned` and settles it LEASE_REVOKED.
      leaseHeld: true,
    })
    if (reason === null) return
    this.executor.cancelCurrent(`commitment ${commitment.commitmentId} invalidated (${reason})`)
    this.logger.warn(
      'agent',
      formatSkillInvalidated({
        commitmentId: commitment.commitmentId,
        decisionEpoch: commitment.decisionEpoch,
        skillKind: commitment.skillKind,
        candidateId: commitment.candidateId,
        reason,
        targetKey: targetIdentityKey(commitment.target),
        observedDimension,
        observedWorldEpoch: this.options.worldEpoch,
        detail: 'live commitment revalidation at the tick boundary',
      }),
      {
        actionId: commitment.candidateId,
        commitmentId: commitment.commitmentId,
        reason,
        observedDimension,
        observedWorldEpoch: this.options.worldEpoch,
      },
      this.tickCounter,
    )
  }

  private onActionComplete(result: ExecutionResult, decision: JevResult, candidate: Candidate): void {
    // A settled action (done / failed / cancelled) releases the in-flight
    // commitment immediately, so the next decision is free to choose again. The
    // epoch match keeps a stale completion from clearing a newer action's hold.
    if (
      this.actionCommitmentState !== null &&
      this.actionCommitmentState.actionId === result.actionId &&
      this.actionCommitmentState.epoch === result.epoch
    ) {
      this.actionCommitmentState = null
    }
    const moved =
      this.actionStart === null
        ? 0
        : Math.hypot(
            this.bot.entity.position.x - this.actionStart.x,
            this.bot.entity.position.y - this.actionStart.y,
            this.bot.entity.position.z - this.actionStart.z,
          )
    const moveArrived =
      (result.kind === 'MOVE' || result.kind === 'RETREAT') && classifyMoveOutcome(result.verified, moved) === 'arrived'
    const surfaceSearchArrived = result.kind === 'RETRIEVE' && this.surfaceSearchArrived(candidate)
    const retrieveArrived = result.kind === 'RETRIEVE' && !surfaceSearchArrived && this.retrievalArrived(candidate)
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
      searchArrived: surfaceSearchArrived,
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
      arrived: moveArrived || retrieveArrived || surfaceSearchArrived,
      distanceClosed: retrieveDistanceClosed,
      searchArrived: surfaceSearchArrived,
      semanticProgress,
      failureCode: result.failure,
    })
    if (surfaceSearchArrived && result.itemsGained === 0 && !result.blockRemoved) {
      this.recordSurfaceSearch(candidate)
    }
    if (taxonomy.progressKinds.some((kind) => kind === 'body' || kind === 'search' || kind === 'goal')) {
      this.progressEpoch += 1
      this.semanticStateGeneration += 1
      this.lastProgress += 1
      this.lastProgressAt = Date.now()
      // Observed progress (body/search/goal) resets the typed-action-failure
      // streak: the same action failing again is no longer one unbroken run.
      this.actionFailureEscalation.reset()
      // Real progress also ends any actionable-WAIT streak (#327 follow-up).
      this.waitStreakEscalation.reset()
    }
    this.recentOutcomes.push({
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
    if (this.recentOutcomes.length > 16) this.recentOutcomes.shift()
    this.noteAscendOutcome(result, candidate)
    // #360: feed the settled decision to the state-recurrence evidence. This runs
    // once per settled action (not per tick), and `body` progress deliberately
    // does NOT clear the window: a successful MOVE is not semantic progress.
    this.signals.strategicNonProgress = this.strategicStall.note({
      optionInstanceId: this.currentOptionContext()?.instanceId ?? null,
      stateKey: strategicStateKey(this.bot.entity.position),
      progressKinds: taxonomy.progressKinds,
    })
    // #nonprogress-yield: a settled decision that showed `goal`/`search` progress
    // clears the optional-head bound. `body`/`none` deliberately do not.
    this.queue.noteSemanticProgress(taxonomy.progressKinds)
    // #plan-reconciliation: the same settled semantic progress clears the
    // no-productive-head bound, so only a head that genuinely never advances is
    // escalated.
    if (taxonomy.progressKinds.some((kind) => kind === 'goal' || kind === 'search')) {
      this.noProductiveHeadKey = null
      this.noProductiveHeadCount = 0
    }

    writeOutcome(this.jevWriter, {
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
    this.emitSkillOutcomePacket({
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
      verification: taxonomy.verification,
    })

    const pending = this.pendingDecisions.get(result.epoch)
    let completedOptionId: string | null = null
    let completedPlanId: string | null = null
    if (pending !== undefined) {
      this.pendingDecisions.delete(result.epoch)
      completedOptionId = pending.record.optionId
      completedPlanId = pending.record.goalQueueState.current?.id ?? null
      attachResult(pending.record, {
        actionId: result.actionId,
        success: truth.status === 'done' && truth.verified,
        durationMs: result.ms,
        damageTaken: Math.max(0, pending.healthAtDecision - this.bot.health),
        progress: this.goal.progress,
        status: result.status,
        failureCode: result.failure,
        verified: truth.verified,
        blockRemoved: result.blockRemoved,
        dropObserved: result.dropObserved,
        damageObserved: result.damageObserved ?? false,
      })
      this.decisionWriter.write(pending.record)
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
      this.logger.info('causal', formatCausalLine(chain), causalRecord(chain), this.tickCounter)
      if (truth.downgraded) {
        this.logger.warn(
          'agent',
          `ACTION_ZERO_PROGRESS actionId=${result.actionId} kind=${result.kind} reason=verified_without_observable_progress rawStatus=${result.status}`,
          { actionId: result.actionId, kind: result.kind, verified: result.verified, detail: result.detail },
          this.tickCounter,
        )
      }
    }

    if (result.status === 'cancelled' || result.failure === 'cancelled') {
      this.logger.info(
        'agent',
        `action#${result.epoch} ${result.actionId} ended cancelled (preempted) - ownership handover complete`,
        { actionId: result.actionId, ms: result.ms },
        this.tickCounter,
      )
      return
    }

    this.retireFailedKnownRetrieve(candidate, result)
    this.recordZeroProgressOutcome(result, candidate, truth)
    if (result.unverifiedPostcondition !== undefined) {
      this.onUnverifiedAction(result, result.unverifiedPostcondition, pending)
    } else if (truth.status === 'done' && truth.verified) {
      const settledPlanId = pending?.record.goalQueueState.current?.id ?? this.queue.current?.id ?? null
      if (settledPlanId !== null) this.actionUnverified.delete(settledPlanId)
      // A verified success ends the run of typed failures for this plan/action.
      this.actionFailureEscalation.reset()
    }

    if (completedOptionId !== null) {
      this.optionAttempts.noteOutcome(
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
        this.placementRetries.noteVerified(candidate.itemName)
        if (candidate.target !== null && PLACED_STATION_ITEMS.has(candidate.itemName)) {
          const registered = registerPlacedStation(this.placedStations, candidate.itemName, candidate.target)
          if (registered.added) {
            this.logger.info(
              'agent',
              formatStationRegisteredPlaced('furnace', candidate.target),
              {
                kind: 'furnace',
                source: 'placed',
                at: `${Math.round(candidate.target.x)},${Math.round(candidate.target.y)},${Math.round(candidate.target.z)}`,
              },
              this.tickCounter,
            )
          }
        }
        if (candidate.meta.furnaceSource === 'held' && candidate.target !== null) {
          this.signals.heldFurnacePlacedAt = blockId('b', candidate.target)
        }
      }
      if (result.kind === 'MINE' && truth.verified) {
        if (result.blockRemoved) this.resetDescendBudgetAfterWorldChange(result.actionId, 'verified_mine')
        this.noteCandidateSuccess(result.actionId)
        this.verifiedDigs += 1
        if (result.blockRemoved) this.blocksRemoved += 1
        if (result.dropObserved) this.dropObservations += 1
        this.itemsCollected += result.itemsGained
        // A MINE only counts as one obtained goal item when the truth layer
        // verified it: a collect MINE whose drop was not picked up is a typed
        // failure (`pickup_failed`), never a completed collection.
        const current = this.queue.current
        if (result.blockRemoved && current !== null && result.yieldItem === current.targetItem) {
          this.harvestedGoalCount += 1
        }
        this.goal = goalWithHave(this.goal, this.effectiveHave())
        if (this.goal.progress > this.lastProgress) {
          this.lastProgress = this.goal.progress
          this.lastProgressAt = Date.now()
        }
        this.recentEvents.push(
          `dug ${result.actionId}; ${this.goal.targetItem} ${this.goal.haveCount}/${this.goal.requiredCount}`,
        )
        this.logger.info(
          'agent',
          `VERIFIED ${result.actionId} removed=${result.blockRemoved} gained=${result.itemsGained} goal=${this.goal.haveCount}/${this.goal.requiredCount} progress=${Math.round(this.goal.progress * 100)}%`,
          { actionId: result.actionId, ms: result.ms },
          this.tickCounter,
        )
        if (this.goal.complete && this.queue.current?.kind !== 'descend' && !this.options.singleShotPlanner) {
          this.onObjectiveComplete()
          return
        }
      }
      if (result.kind === 'DESCEND') this.onDescendComplete(result, candidate)
      // The dig route's own progress assertion: the step CLAIMED it lands closer
      // to the goal's target, so a settled step re-measures the distance. Only a
      // real decrease is reported.
      if (candidate.meta.digRoute === true) this.logDigRouteProgress(result, candidate)
      // The level-scan descent's own measured half: the level actually reached and the
      // distance to the target after the step. Only a real downward move is reported.
      if (candidate.meta.levelScan === true) this.logLevelScanStep(result, candidate)
      if (result.kind === 'RETRIEVE') {
        if (result.blockRemoved) this.onRetrievalDescent(candidate)
        // Only a COMPLETED retrieval - the target actually arrived or the item
        // was acquired - retires the active target and resets the coordinate
        // failure memory. A measured distance closure or a vertical chunk is
        // `progressed` evidence, NOT completion: RC8 (run-mu8ue5dg-10amk) closed
        // ~1 m of a 20 m approach and still reset `MOVE_FAILMEM`, re-arming the
        // live horizontal dead end (`outcome=stuck` + `MOVE_FAILMEM_RESET`).
        const retrieveMemory = decideRetrieveMemory(result, this.retrieveCompleted(candidate, result))
        if (truth.resetsFailureMemory && retrieveMemory.reset) {
          this.activeRetrieval = null
          this.retrievalTrack = null
          this.noteCandidateSuccess(result.actionId)
          this.recordMoveSuccess(candidate)
        } else if (!truth.replanProgress && !truth.observableProgress) {
          // A retrieval that reports completion while producing nothing
          // observable must charge the coordinate failure memory so it is
          // eventually skipped, and it must never be recorded as a verified
          // success (`status=done verified=false progressDelta=0`). Bounded
          // body progress (`replanProgress`) is not zero progress.
          this.recordMoveFailure(candidate, 'no_progress')
        }
        if (truth.status === 'unreached') {
          this.logger.warn(
            'agent',
            `ACTION_RETRIEVE_UNREACHED actionId=${result.actionId} progressed=${result.progressed} blockRemoved=${result.blockRemoved} (progressed without closure)`,
            { actionId: result.actionId, target: candidate.target, progressed: result.progressed },
            this.tickCounter,
          )
        }
        if (result.actionId.startsWith('RETRIEVE:known:station:furnace')) {
          const outcome = evaluateRetrieveAbandon({
            actionId: result.actionId,
            verified: truth.verified,
            progressDelta: result.itemsGained,
            previous: this.retrieveUnverified,
          })
          this.retrieveUnverified = outcome.state
          if (outcome.abandon && outcome.line !== null) {
            this.abandonRetrieveOption(outcome.line, candidate, outcome.state.unverified)
          }
        }
      }
      if ((result.kind === 'MOVE' || result.kind === 'RETREAT') && this.actionStart !== null) {
        const outcome = classifyMoveOutcome(result.verified, moved)
        switch (outcome) {
          case 'arrived':
            this.recordMoveSuccess(candidate)
            break
          case 'unverified':
          case 'no-progress': {
            if (moved < 0.5) {
              const p = this.bot.entity.position
              const region = `${Math.floor(p.x)}_${Math.floor(p.y)}_${Math.floor(p.z)}`
              const value = Math.round(moved * 100) / 100
              this.logger.warn(
                'agent',
                `MOVE_OSCILLATE travelled=${value} net=${value} progress=0 region=${region} -> spatial_failure`,
                { actionId: result.actionId, region },
                this.tickCounter,
              )
            }
            this.noteCandidateFailure(result.actionId)
            this.recordMoveFailure(candidate, 'no_progress')
            break
          }
        }
      }
      this.actionStart = null
      if (!truth.downgraded && result.kind !== 'WAIT' && result.kind !== 'ESCALATE') {
        this.failureStreak = 0
        this.signals.consecutiveFailures = 0
      }
    } else if (result.kind === 'PLACE' && this.schedulePlaceRetry(result, candidate)) {
      this.noteCandidateFailure(result.actionId)
    } else {
      if (result.kind !== 'ESCALATE' && result.kind !== 'WAIT') {
        this.noteCandidateFailure(result.actionId)
        this.recordMoveFailure(candidate, moveFailureReason(result.failure))
        this.recordFailure(result.failure, `${result.actionId}: ${result.detail}`)
        // #78 follow-up: bound the OTHER loop - the same plan re-offered with its
        // action failing the same typed way. `onUnverifiedAction` owns unverified
        // postconditions with its own budget, and a PLACE retry was handled above,
        // so neither reaches here as an unhandled typed failure.
        if (result.unverifiedPostcondition === undefined && result.failure !== null) {
          this.noteTypedActionFailure(result.failure, result.actionId, pending)
        }
      } else {
        this.logger.info(
          'agent',
          `CONTROL_OUTCOME kind=${result.kind} status=${result.status} failure=${result.failure ?? 'null'} not_charged_as_physical_failure`,
          { actionId: result.actionId, status: result.status, failure: result.failure, control: result.kind === 'ESCALATE' ? 'escalate' : 'wait' },
          this.tickCounter,
        )
      }
    }

    const completionTrigger: DecisionTrigger = isActionTimeout(result) ? 'action_timeout' : 'action_completed'
    const deferred = this.deferredTrigger
    this.deferredTrigger = null
    const trigger =
      deferred !== null && TRIGGER_PRIORITY[deferred.trigger] > TRIGGER_PRIORITY[completionTrigger]
        ? deferred.trigger
        : completionTrigger
    const detail =
      deferred !== null && TRIGGER_PRIORITY[deferred.trigger] > TRIGGER_PRIORITY[completionTrigger]
        ? deferred.detail
        : { actionId: result.actionId, status: result.status, failure: result.failure }
    this.requestDecision(trigger, detail)
  }

  /**
   * #79: a `done`/`verified=false`/`progressDelta=0` action is a FAILURE. Log
   * ACTION_UNVERIFIED with the plan/strategy/post-condition, charge the failure,
   * advance the furnace prerequisite path so the plan is never re-queued
   * unchanged, and after UNVERIFIED_ACTION_LIMIT attempts for one planId emit
   * `ABANDON_REASON=action_unverified` and wake System 2 for a different option.
   */
  private onUnverifiedAction(result: ExecutionResult, postcondition: string, pending: PendingDecision | undefined): void {
    const planId = pending?.record.goalQueueState.current?.id ?? this.queue.current?.id ?? null
    const strategy = pending?.record.strategy ?? null
    const key = planId ?? result.actionId
    const attempts = (this.actionUnverified.get(key) ?? 0) + 1
    this.actionUnverified.set(key, attempts)
    this.logger.warn(
      'agent',
      formatActionUnverified({ planId, actionId: result.actionId, strategy, postcondition }),
      { planId, actionId: result.actionId, strategy, attempts, postcondition, progressDelta: result.itemsGained, detail: result.detail },
      this.tickCounter,
    )
    this.noteCandidateFailure(result.actionId)
    this.recordFailure('verify_failed', `${result.actionId} unverified: ${result.detail}`)

    const switched = this.advancePrereqAfterUnverified()
    const budget = evaluateUnverifiedBudget({ attempts, limit: UNVERIFIED_ACTION_LIMIT, planId: key, strategy })
    if (budget.abandon) {
      this.markOptionAbandoned(result.actionId, 'action_unverified')
      this.logger.warn(
        'agent',
        budget.line ?? `ABANDON_REASON=action_unverified planId=${key} attempts=${attempts} strategy=${strategy ?? 'null'}`,
        { planId: key, attempts, strategy, switched, postcondition },
        this.tickCounter,
      )
    }
    if (budget.abandon) {
      // This is now a semantic boundary: the current Option exhausted its
      // code-owned postcondition budget. A single local verification miss is
      // evidence for Jev/Skill recovery, not a new System2 mission.
      this.summonLlm(
        'action_impossible',
        `semantic option exhausted after unverified outcome planId=${key} attempts=${attempts} strategy=${strategy ?? 'null'}`,
      )
    } else if (switched) {
      this.logger.info(
        'agent',
        `LOCAL_PREREQ_RECOVERY planId=${key} attempts=${attempts} next_path_selected=true system2=false`,
        { planId: key, attempts, strategy, postcondition },
        this.tickCounter,
      )
    } else {
      this.logger.info(
        'agent',
        `LOCAL_VERIFY_RECOVERY planId=${key} attempts=${attempts} system2=false`,
        { planId: key, attempts, strategy, postcondition },
        this.tickCounter,
      )
    }
  }

  /**
   * #79/#58: an unverified prerequisite attempt must not repeat the same path.
   * Advance the scored furnace-prerequisite plan to the next feasible option
   * (place_held -> use_known_station -> craft_and_place). The parent goal is
   * never abandoned here.
   */
  private advancePrereqAfterUnverified(): boolean {
    if (this.prereqPlan === null) return false
    const current = this.prereqForcedPath ?? this.prereqPlan.chosen
    if (current === null) return false
    const next = nextPrereqPath(this.prereqPlan, current)
    if (next === null) return false
    this.prereqForcedPath = next
    this.prereqProgress = null
    this.prereqLoggedKey = null
    this.logger.warn(
      'agent',
      `PREREQ_SWITCH from=${current} to=${next} reason=action_unverified`,
      { from: current, to: next, reason: 'action_unverified', goal: this.currentGoalKey() },
      this.tickCounter,
    )
    return true
  }

  private syncTerrainSignals(state: WorldState): void {
    const feetY = Math.floor(state.self.position.y)
    let deepest: number | null = null
    for (const block of state.blocks) {
      if (block.kind !== 'stone' && block.kind !== 'ore') continue
      if (block.position.y >= feetY) continue
      if (deepest === null || block.position.y < deepest) deepest = block.position.y
    }
    if (deepest !== null) this.digMemory.observeStoneY(deepest)
    const memory = this.digMemory.snapshot()
    this.signals.digDir = memory.digDir
    this.signals.digDirCount = memory.digDirCount
    this.signals.digDepth = memory.digDepth
    this.signals.digOscillate = memory.digOscillate
    this.signals.knownStoneY = memory.knownStoneY
    this.signals.lastTunnel = memory.lastTunnel
    this.signals.descendNoProgress = memory.descendNoProgress
    this.signals.descendLimitReached = memory.descendLimitReached
  }

  private sampleMovement(position: Vec3Json): void {
    this.positionWindow.push({ x: position.x, y: position.y, z: position.z })
    while (this.positionWindow.length > 40) this.positionWindow.shift()
    const cellKey = exploredCellKey(position)
    this.exploredCells.delete(cellKey)
    this.exploredCells.add(cellKey)
    while (this.exploredCells.size > EXPLORED_CELLS_LIMIT) {
      const oldest = this.exploredCells.values().next().value
      if (oldest === undefined) break
      this.exploredCells.delete(oldest)
    }
    this.signals.exploredCells = this.exploredCells
    this.detectOscillation(position)
    if (this.positionWindow.length < 40) return
    const first = this.positionWindow[0]
    const last = this.positionWindow[this.positionWindow.length - 1]
    if (first === undefined || last === undefined) return
    let traveled = 0
    for (let index = 1; index < this.positionWindow.length; index += 1) {
      const a = this.positionWindow[index - 1]
      const b = this.positionWindow[index]
      if (a === undefined || b === undefined) continue
      traveled += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)
    }
    const net = Math.hypot(last.x - first.x, last.y - first.y, last.z - first.z)
    const efficiency = traveled > 0.01 ? Math.round((net / traveled) * 100) : 100
    this.lastLocomotionEfficiency = efficiency
    this.logger.info(
      'agent',
      `MOVE_EFFICIENCY samples=40 traveled=${Math.round(traveled * 100) / 100} net=${Math.round(net * 100) / 100} efficiency=${efficiency}%`,
      { traveled, net, efficiency, windowStart: first, windowEnd: last },
      this.tickCounter,
    )
    this.detectMoveOscillation()
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
    const decision = evaluateOscillation({
      position: positionKey(position),
      signature: this.oscillationSignature(),
      previous: this.oscillationState,
      // The goal key is passed separately so junk pickups (which change the
      // inventory part of the signature) cannot re-arm the loop detector.
      goal: this.currentGoalKey(),
    })
    this.oscillationState = decision.state
    if (!decision.detected || decision.line === null) return
    // #360: cumulative detection count for the active Option, so the semantic
    // layer can see 401 oscillation events that no longer change behaviour.
    this.signals.oscillationsDetected = (this.signals.oscillationsDetected ?? 0) + 1
    this.logger.warn(
      'agent',
      decision.line,
      { cycles: decision.state.cycles, pair: decision.state.pair, goal: this.currentGoalKey() },
      this.tickCounter,
    )
    this.escapeOscillation(decision.state)
  }

  private escapeOscillation(state: OscillationState): void {
    this.oscillationState = null
    this.abandonedRetrievePaths.set('use_known_station', this.lastStateFingerprint)
    if (this.activeRetrieval !== null) {
      this.unreachableResources.add(this.retrievalKey(this.activeRetrieval))
      this.noteCandidateFailure(this.activeRetrieval.id)
    }
    if (this.lastDecisionId !== null) this.noteCandidateFailure(this.lastDecisionId)
    this.activeRetrieval = null
    this.retrievalTrack = null
    this.retrieveUnverified = null
    this.prereqForcedPath = null
    this.prereqProgress = null
    this.prereqLoggedKey = null
    this.retrievalEscalationPending = true
    this.logger.warn(
      'agent',
      `LOCAL_OSCILLATION_ESCAPE pair=${state.pair ?? 'pair'} cycles=${state.cycles} system2=false`,
      { pair: state.pair, cycles: state.cycles, boundary: 'local_recovery' },
      this.tickCounter,
    )
  }

  /**
   * An APPROACH_LEG candidate: the remembered target's own route proved zero
   * observable change, so the generator offers a travel leg that changes the
   * stand cell (a grounded MOVE toward the target) instead of re-issuing the same
   * action. Logged when Jev actually selects it, so the marker means "this body
   * is now walking the approach", not "a leg existed".
   */
  private logApproachLeg(candidate: Candidate): void {
    const target = candidate.target
    if (target === null) return
    const reason = typeof candidate.meta.approachLeg === 'string' ? candidate.meta.approachLeg : 'target_not_observable'
    this.logger.info(
      'agent',
      formatApproachLeg(reason, target),
      {
        actionId: candidate.id,
        target,
        resource: typeof candidate.meta.approachResource === 'string' ? candidate.meta.approachResource : null,
      },
      this.tickCounter,
    )
  }

  /**
   * The typed `BRIDGE_REFUSED reason=<no_block|no_verified_landing|hazard|
   * protected|budget> ...` facts: the leg needed a same-level gap crossed, the
   * sensor's bounded forward probe saw it, and the bridge was refused for a NAMED
   * reason (`bridgeRoute.ts`). Logged for WITHHELD candidates too, so the refusal is
   * visible on the tick it exists instead of looking like "no gap was ever seen".
   * Deduped like the other typed dead-end facts.
   */
  private logBridgeRefusals(offered: readonly Candidate[], withheld: readonly Candidate[]): void {
    const lines: string[] = []
    for (const candidate of [...offered, ...withheld]) {
      const line = candidate.meta[BRIDGE_REFUSED_META]
      if (typeof line === 'string' && line.length > 0 && !lines.includes(line)) lines.push(line)
    }
    const key = lines.length === 0 ? null : lines.join('|')
    if (key === this.lastBridgeRefusalKey) return
    this.lastBridgeRefusalKey = key
    if (key === null) return
    for (const line of lines) this.logger.warn('agent', line, { line }, this.tickCounter)
  }

  /**
   * The selected BRIDGE leg's #436 section 17 layer: `SKILL_STEP skill=<id>
   * step=bridge authority=<MECHANICAL_CONTINUATION|MANDATORY_PREREQUISITE>
   * evidence=... worldDelta=place_blocks=1 budget=<span>`. Logged when the action is
   * taken, so the marker means "the body is now running this bridge", and the layer
   * half says whether code finished a UNIQUE prerequisite (U1..U6) or merely
   * realized the route Jev selected. The `REFLEX reason=unique_binding_prerequisite`
   * proof, when there is one, rides `logLegReflexes` from the same candidate meta.
   */
  private logBridgeAuthority(candidate: Candidate): void {
    const detail = typeof candidate.meta[BRIDGE_AUTHORITY_META] === 'string' ? candidate.meta[BRIDGE_AUTHORITY_META] : null
    const skill = typeof candidate.meta.legContinuationSkill === 'string' ? candidate.meta.legContinuationSkill : 'BRIDGE(approach)'
    const line =
      detail === null
        ? formatSkillStep(skill, 'bridge', `target=${candidate.target === null ? 'unknown' : `${candidate.target.x},${candidate.target.y},${candidate.target.z}`}`)
        : formatSkillStep(skill, 'bridge', detail)
    this.logger.info('agent', line, {
      actionId: candidate.id,
      target: candidate.target,
      dir: candidate.meta.bridgeDir ?? null,
      block: candidate.meta.bridgeBlock ?? null,
      span: candidate.meta.bridgeSpan ?? null,
      mayPlaceBlocks: candidate.meta.mayPlaceBlocks === true,
    })
  }

  /**
   * The #436 `SKILL_POLICY_BOUNDARY skill=<id> reason=<reason> alternatives=[...]`
   * facts: where the offer grounded several NON-EQUIVALENT remedies and code
   * therefore stopped instead of ranking them (section 7 U3 / section 19 (8, 28) /
   * section 22). Deduped like the other typed facts, and logged for WITHHELD
   * candidates too, so the boundary is visible on the tick it exists.
   */
  private logSkillPolicyBoundaries(offered: readonly Candidate[], withheld: readonly Candidate[]): void {
    const lines: string[] = []
    for (const candidate of [...offered, ...withheld]) {
      const line = candidate.meta.legPolicyBoundary
      if (typeof line === 'string' && line.length > 0 && !lines.includes(line)) lines.push(line)
    }
    const key = lines.length === 0 ? null : lines.join('|')
    if (key === this.lastSkillBoundaryKey) return
    this.lastSkillBoundaryKey = key
    if (key === null) return
    for (const line of lines) this.logger.warn('agent', line, { line }, this.tickCounter)
  }

  /**
   * The #436 `REFLEX ownerSkill=<skill> reason=unique_binding_prerequisite
   * action=<step_up|step_over> cell=... via=... ledge=... evidence=...` facts: the
   * bounded mechanical continuation that is the UNIQUE way the active leg can
   * reach its waypoint from here (see `candidates.ts#pocketContinuations`).
   * Deduped like the other typed dead-end facts, and logged for the WITHHELD
   * candidates too, so "the only way out is this step" is visible in the resident
   * log even while Jev is still choosing (measured run-mucbyro1-1hqhm: the body
   * was stuck on a stuck MOVE with an empty contract and no such fact at all).
   */
  private logLegReflexes(offered: readonly Candidate[], withheld: readonly Candidate[]): void {
    const lines: string[] = []
    for (const candidate of [...offered, ...withheld]) {
      const line = candidate.meta.legReflex
      if (typeof line === 'string' && line.length > 0 && !lines.includes(line)) lines.push(line)
    }
    const key = lines.length === 0 ? null : lines.join('|')
    if (key === this.lastLegReflexKey) return
    this.lastLegReflexKey = key
    if (key === null) return
    for (const line of lines) {
      this.logger.info('agent', line, { line }, this.tickCounter)
    }
  }

  /**
   * The mechanical continuation Jev selected (`SKILL_STEP action=... cell=...
   * via=... ledge=... vertical=staircase-up`). Logged when the action is taken, so
   * the marker means "the body is now running this step", not "a step existed";
   * the ordinary MOVE/PATH/VERIFIED markers then report its outcome unchanged.
   */
  private logSkillStep(candidate: Candidate): void {
    const line = typeof candidate.meta.legContinuationLine === 'string' ? candidate.meta.legContinuationLine : null
    this.logger.info(
      'agent',
      line ??
        `SKILL_STEP action=${String(candidate.meta.legContinuationAction ?? 'step_up')} cell=${String(candidate.meta.legContinuationCell ?? 'unknown')} vertical=${String(candidate.meta.vertical ?? 'none')}`,
      {
        actionId: candidate.id,
        skill: typeof candidate.meta.legContinuationSkill === 'string' ? candidate.meta.legContinuationSkill : null,
        action: typeof candidate.meta.legContinuationAction === 'string' ? candidate.meta.legContinuationAction : null,
        cell: typeof candidate.meta.legContinuationCell === 'string' ? candidate.meta.legContinuationCell : null,
        via: typeof candidate.meta.legContinuationVia === 'string' ? candidate.meta.legContinuationVia : null,
        ledge: typeof candidate.meta.legContinuationLedge === 'string' ? candidate.meta.legContinuationLedge : null,
        vertical: typeof candidate.meta.vertical === 'string' ? candidate.meta.vertical : null,
      },
      this.tickCounter,
    )
  }

  /**
   * The selected LEVEL SCAN descent (`levelScan.ts`): nothing at the body's own level could
   * ground a route toward the travel/enter/retrieve target, so the bounded level scan offered
   * the own-column descent that STARTS a composed route ending strictly closer to the target.
   *
   * Logged when Jev actually selects it, so the marker means "this body is now descending
   * toward the scanned level", not "a route was enumerated". The line names the level, the
   * continuation cell and material, whether it is a dig or a walk, the pre-existing floor, the
   * per-level flood verdict (`levels=`) and the distance change; the §7 layer half rides the
   * same mirrored `SKILL_STEP` channel the wall entry uses.
   */
  private logLevelScan(candidate: Candidate): void {
    const line = typeof candidate.meta.levelScanLine === 'string' ? candidate.meta.levelScanLine : null
    if (line === null) return
    this.logger.info(
      'agent',
      line,
      {
        actionId: candidate.id,
        target: typeof candidate.meta.levelScanTarget === 'string' ? candidate.meta.levelScanTarget : null,
        level: typeof candidate.meta.levelScanLevel === 'number' ? candidate.meta.levelScanLevel : null,
        depth: typeof candidate.meta.levelScanDepth === 'number' ? candidate.meta.levelScanDepth : null,
        dir: typeof candidate.meta.levelScanDir === 'string' ? candidate.meta.levelScanDir : null,
        via: typeof candidate.meta.levelScanVia === 'string' ? candidate.meta.levelScanVia : null,
        cell: typeof candidate.meta.levelScanCell === 'string' ? candidate.meta.levelScanCell : null,
        block: typeof candidate.meta.levelScanBlock === 'string' ? candidate.meta.levelScanBlock : null,
        fromD: typeof candidate.meta.levelScanFrom === 'number' ? candidate.meta.levelScanFrom : null,
        toD: typeof candidate.meta.levelScanTo === 'number' ? candidate.meta.levelScanTo : null,
        alternatives:
          typeof candidate.meta.levelScanAlternatives === 'string' ? candidate.meta.levelScanAlternatives : null,
        evidence: typeof candidate.meta.levelScanEvidence === 'string' ? candidate.meta.levelScanEvidence : null,
      },
      this.tickCounter,
    )
    const authorityLine =
      typeof candidate.meta.levelScanAuthorityLine === 'string' ? candidate.meta.levelScanAuthorityLine : null
    if (authorityLine !== null) {
      this.logger.info('agent', authorityLine, { actionId: candidate.id, step: 'level_scan' }, this.tickCounter)
    }
  }

  /**
   * The settled level-scan descent measured against the world: the level the body actually
   * reached, how many own-column steps still separate it from the continuation's level, and
   * the distance to the target before/after. Emitted only when the descent measurably moved
   * the body DOWN toward the scanned level, so "the scan descended toward a route" is a
   * measured fact instead of an assumption, and a descent that did nothing is not reported.
   */
  private logLevelScanStep(result: ExecutionResult, candidate: Candidate): void {
    if (candidate.meta.levelScan !== true) return
    const targetText = typeof candidate.meta.levelScanTarget === 'string' ? candidate.meta.levelScanTarget : null
    const targetLevel = typeof candidate.meta.levelScanLevel === 'number' ? candidate.meta.levelScanLevel : null
    const fromD = typeof candidate.meta.levelScanFrom === 'number' ? candidate.meta.levelScanFrom : null
    if (targetText === null || targetLevel === null || fromD === null) return
    const parts = targetText.split(',').map((value) => Number(value))
    const [x, y, z] = parts
    if (x === undefined || y === undefined || z === undefined) return
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return
    const feet = {
      x: Math.floor(this.bot.entity.position.x),
      y: Math.floor(this.bot.entity.position.y),
      z: Math.floor(this.bot.entity.position.z),
    }
    const started = {
      x: typeof candidate.meta.wallX === 'number' ? candidate.meta.wallX : feet.x,
      y: typeof candidate.meta.wallY === 'number' ? candidate.meta.wallY : feet.y + 1,
      z: typeof candidate.meta.wallZ === 'number' ? candidate.meta.wallZ : feet.z,
    }
    // The measured claim: the body is one level LOWER than it was. A descent that did not
    // change the level is not progress and emits nothing.
    if (!(feet.y < started.y)) return
    const toD = Math.round(distance(feet, { x, y, z }) * 100) / 100
    this.logger.info(
      'agent',
      formatLevelScanStep({ from: started, to: feet, targetLevel, fromDistance: fromD, toDistance: toD }),
      { actionId: result.actionId, kind: result.kind, status: result.status, level: feet.y, targetLevel, fromD, toD },
      this.tickCounter,
    )
  }

  /**
   * The selected DIG route: the travel/enter/retrieve target had no walkable
   * route, so the offer grounded a bounded dig step toward it. Logged when Jev
   * actually selects it, so the marker means "this body is now digging the route",
   * not "a route was enumerated". The `from_d`/`to_d` pair is the mechanical
   * claim the route makes (the step lands strictly closer to the target), and the
   * settled action re-measures it in `DIG_ROUTE_PROGRESS`.
   */
  private logDigRoute(candidate: Candidate): void {
    const line = typeof candidate.meta.digRouteLine === 'string' ? candidate.meta.digRouteLine : null
    this.logger.info(
      'agent',
      line ?? `DIG_ROUTE reason=${String(candidate.meta.digRouteReason ?? 'no_walkable_route')} actionId=${candidate.id}`,
      {
        actionId: candidate.id,
        target: typeof candidate.meta.digRouteTarget === 'string' ? candidate.meta.digRouteTarget : null,
        bearing: typeof candidate.meta.digRouteBearing === 'string' ? candidate.meta.digRouteBearing : null,
        cell: typeof candidate.meta.digRouteCell === 'string' ? candidate.meta.digRouteCell : null,
        block: typeof candidate.meta.digRouteBlock === 'string' ? candidate.meta.digRouteBlock : null,
        kind: typeof candidate.meta.digRouteKind === 'string' ? candidate.meta.digRouteKind : null,
        fromD: typeof candidate.meta.digRouteFrom === 'number' ? candidate.meta.digRouteFrom : null,
        toD: typeof candidate.meta.digRouteTo === 'number' ? candidate.meta.digRouteTo : null,
        detour: candidate.meta.digRouteDetour === true,
        skipped: typeof candidate.meta.digRouteSkipped === 'string' ? candidate.meta.digRouteSkipped : null,
        skippedBlock:
          typeof candidate.meta.digRouteSkippedBlock === 'string' ? candidate.meta.digRouteSkippedBlock : null,
        entry: candidate.meta.digRouteEntry === true,
        entryMode: typeof candidate.meta.digRouteEntryMode === 'string' ? candidate.meta.digRouteEntryMode : null,
        entryLevel: typeof candidate.meta.digRouteEntryLevel === 'number' ? candidate.meta.digRouteEntryLevel : null,
        entryEvidence:
          typeof candidate.meta.digRouteEntryEvidence === 'string' ? candidate.meta.digRouteEntryEvidence : null,
      },
      this.tickCounter,
    )
    // The WALL ENTRY's own line (`DIG_ROUTE_ENTRY`): the same fact in the wall-entry
    // vocabulary - the cell the body came from, the heading, the tunnel level, the
    // pre-existing floor and how many alternatives were grounded. Emitted only for an
    // entry, so an ordinary dig route logs exactly what it logged before.
    const entryLine = typeof candidate.meta.digRouteEntryLine === 'string' ? candidate.meta.digRouteEntryLine : null
    if (entryLine !== null) {
      this.logger.info(
        'agent',
        entryLine,
        {
          actionId: candidate.id,
          dir: typeof candidate.meta.digRouteBearing === 'string' ? candidate.meta.digRouteBearing : null,
          mode: typeof candidate.meta.digRouteEntryMode === 'string' ? candidate.meta.digRouteEntryMode : null,
          level: typeof candidate.meta.digRouteEntryLevel === 'number' ? candidate.meta.digRouteEntryLevel : null,
          floorBlock: typeof candidate.meta.digRouteEntryFloorBlock === 'string' ? candidate.meta.digRouteEntryFloorBlock : null,
          alternatives:
            typeof candidate.meta.digRouteEntryAlternatives === 'string' ? candidate.meta.digRouteEntryAlternatives : null,
        },
        this.tickCounter,
      )
    }
    // #436 section 17 for the entry: the same mirrored `SKILL_STEP` channel the bridge
    // uses, so the layer half (`authority=MANDATORY_PREREQUISITE` when the entry was the
    // only grounded remedy / `MECHANICAL_CONTINUATION` when Jev had alternatives) is
    // live-visible for the action the body actually took.
    const authorityLine = typeof candidate.meta.digRouteAuthorityLine === 'string' ? candidate.meta.digRouteAuthorityLine : null
    if (authorityLine !== null) {
      this.logger.info('agent', authorityLine, { actionId: candidate.id, step: 'wall_entry' }, this.tickCounter)
    }
  }

  /**
   * The settled dig route measured against the world: `from_d` is what the route
   * claimed when it was offered and `to_d` the live distance now. Emitted only
   * when the distance actually shrank, so "the distance strictly decreases as the
   * body advances" is a measured fact per action instead of an assumption.
   */
  private logDigRouteProgress(result: ExecutionResult, candidate: Candidate): void {
    const fromD = typeof candidate.meta.digRouteFrom === 'number' ? candidate.meta.digRouteFrom : null
    const targetText = typeof candidate.meta.digRouteTarget === 'string' ? candidate.meta.digRouteTarget : null
    if (fromD === null || targetText === null) return
    const parts = targetText.split(',').map((value) => Number(value))
    const [x, y, z] = parts
    if (x === undefined || y === undefined || z === undefined) return
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return
    const target = { x, y, z }
    // Measured on the SAME basis the offer used (the floored feet cell), so a
    // body that dug and did not change its cell can never be reported as having
    // advanced: a fractional position 0.5 blocks into the old cell must not read
    // as a distance gain.
    const feet = {
      x: Math.floor(this.bot.entity.position.x),
      y: Math.floor(this.bot.entity.position.y),
      z: Math.floor(this.bot.entity.position.z),
    }
    const toD = Math.round(distance(feet, target) * 100) / 100
    if (!(toD < fromD)) return
    this.logger.info(
      'agent',
      formatDigRouteProgress(fromD, toD, target, feet),
      {
        actionId: result.actionId,
        kind: result.kind,
        status: result.status,
        fromD,
        toD,
        target,
      },
      this.tickCounter,
    )
  }

  /**
   * The typed `DIG_ROUTE_REFUSED` facts for this tick's travel/enter/retrieve
   * targets that could be neither walked to nor dug toward. Deduped like the
   * column-descent refusal (one line per distinct cause), so the dead end is
   * stated (hazard / unbreakable / no support / open floor / protected / no tool /
   * no step / spent) instead of the offer silently collapsing to WAIT + ESCALATE.
   */
  private logDigRouteRefusals(refusals: readonly DigRouteRefusal[]): void {
    this.digRouteRefusalsThisTick = refusals.map((refusal) => ({ ...refusal }))
    const lines = refusals.map((refusal) => formatDigRouteRefused(refusal))
    const key = lines.length === 0 ? null : lines.join('|')
    if (key === this.lastDigRouteRefusalKey) return
    this.lastDigRouteRefusalKey = key
    if (key === null) return
    for (let index = 0; index < refusals.length; index += 1) {
      const refusal = refusals[index]
      if (refusal === undefined) continue
      this.logger.warn(
        'agent',
        lines[index] ?? formatDigRouteRefused(refusal),
        {
          reason: refusal.reason,
          target: refusal.target,
          bearing: refusal.bearing,
          cell: refusal.cell,
          block: refusal.block,
          detail: refusal.detail,
        },
        this.tickCounter,
      )
    }
  }

  private logDescendPlan(candidate: Candidate): void {
    const dir = typeof candidate.meta.dir === 'string' ? candidate.meta.dir : 'unknown'
    const mode = candidate.meta.mode === 'down' ? 'down' : 'level'
    const focus = typeof candidate.meta.focusItem === 'string' ? candidate.meta.focusItem : 'unknown'
    const depth = this.digMemory.dirCount + 1
    this.logger.info(
      'agent',
      `DIG_PATH dir=${dir} depth=${depth} target=${focus}`,
      { actionId: candidate.id, mode, dir, depth },
      this.tickCounter,
    )
    // The heading PLAN of the descent: held while the world offers a safe step
    // under it, changed only with the typed obstruction that forced it. Without
    // this line a heading change was invisible in the log (the measured
    // `W 23 | E 17 | N 12 | S 8` histogram over 60 steps).
    const headingLine = typeof candidate.meta.headingLine === 'string' ? candidate.meta.headingLine : null
    if (headingLine !== null) {
      const changed = candidate.meta.planHeadingHeld === false
      this.logger[changed ? 'warn' : 'info'](
        'agent',
        headingLine,
        {
          actionId: candidate.id,
          planHeading: typeof candidate.meta.planHeading === 'string' ? candidate.meta.planHeading : dir,
          headingChangeReason:
            typeof candidate.meta.headingChangeReason === 'string' ? candidate.meta.headingChangeReason : null,
          headingChangeCell:
            typeof candidate.meta.headingChangeCell === 'string' ? candidate.meta.headingChangeCell : null,
          headingChangeBlock:
            typeof candidate.meta.headingChangeBlock === 'string' ? candidate.meta.headingChangeBlock : null,
        },
        this.tickCounter,
      )
    }
    const digCells = typeof candidate.meta.digCells === 'string' ? candidate.meta.digCells : null
    if (digCells !== null) {
      this.logger.info(
        'agent',
        `DESCEND_PROFILE cells=${digCells} count=${String(candidate.meta.digCount ?? 1)} tool=${String(candidate.meta.profileTool ?? 'hand')}`,
        { actionId: candidate.id, digCells },
        this.tickCounter,
      )
    }
    const tunnel = this.digMemory.lastTunnel
    if (this.digMemory.dirCount > 0 && tunnel !== null) {
      this.logger.info('agent', `REUSE_TUNNEL at=${tunnel.x},${tunnel.y},${tunnel.z}`, { actionId: candidate.id }, this.tickCounter)
    }
    if (mode === 'down' && this.digMemory.dirCount === 0) {
      const from = Math.floor(this.bot.entity.position.y)
      const predicateY = this.queue.current?.kind === 'descend' ? this.queue.current.targetY : null
      const to = typeof predicateY === 'number' ? predicateY : (this.digMemory.knownStoneY ?? from - 8)
      this.logger.info('agent', `STAIRCASE from_y=${from} to_y=${to}`, { actionId: candidate.id }, this.tickCounter)
    }
  }

  private onDescendComplete(result: ExecutionResult, candidate: Candidate): void {
    const target = candidate.target
    const dir = candidate.meta.dir
    if (target !== null && (dir === 'E' || dir === 'W' || dir === 'N' || dir === 'S' || dir === 'D')) {
      this.digMemory.record({
        x: target.x,
        y: target.y,
        z: target.z,
        dir,
        mode: candidate.meta.mode === 'down' ? 'down' : 'level',
        target: typeof candidate.meta.focusItem === 'string' ? candidate.meta.focusItem : null,
        atMs: Date.now(),
      })
    }
    const have = this.effectiveHave()
    const delta = have - this.descendHaveBaseline
    const y = this.bot.entity.position.y
    const yProgressed = this.actionStart !== null && y < this.actionStart.y - 0.5
    const descending = this.queue.current?.kind === 'descend'
    if (delta > 0 || (descending && yProgressed)) {
      this.descendHaveBaseline = have
      this.digMemory.markResourceProgress()
      // A descending predicate goal makes progress by losing altitude, not by
      // gaining items, so a verified drop must also reset the progress-stall clock.
      if (descending && yProgressed) this.lastProgressAt = Date.now()
    } else {
      const budget = this.digMemory.markDescend(false)
      this.logger.info(
        'agent',
        `DESCEND_PROGRESS actionSuccess=true resourceDelta=${delta} streak=${budget.noProgress}`,
        { actionId: result.actionId, noProgress: budget.noProgress },
        this.tickCounter,
      )
      if (budget.limitReached) {
        this.logger.warn(
          'agent',
          `DESCEND_LIMIT depth=${this.digMemory.depth} noProgress=${budget.noProgress} -> strategy=lateral`,
          { actionId: result.actionId },
          this.tickCounter,
        )
        this.signals.descendLimitReached = true
        // A `descend_to:Y=<n>` predicate makes progress by losing altitude, not by
        // finding an item, so `resourceDelta=0` says nothing about the plan: the
        // lateral-search reset would drop the descent heading every 4 steps and
        // re-open the zig-zag (measured live: `DESCEND_LIMIT` fired at every
        // fourth D step, `DIG_PATH dir=D depth=1` restarted each time). Keep the
        // heading for a predicate descent; `DESCEND_STALLED` still bounds a
        // genuinely impossible one. Item-goal search keeps the reset.
        if (!descending) this.digMemory.resetPath()
      }
    }
    if (this.digMemory.isOscillating()) {
      const net = Math.round(this.digMemory.netDisplacement() * 100) / 100
      this.logger.warn(
        'agent',
        `DIG_OSCILLATE net=${net} -> strategy=staircase`,
        { actionId: result.actionId, dir: this.digMemory.dir },
        this.tickCounter,
      )
      this.digMemory.markStaircase()
    }
  }

  /**
   * Issue #45: a RETRIEVE that dug its own staircase records the new tunnel cell
   * so the next retrieval can prefer `REUSE_TUNNEL` over digging a fresh one.
   */
  private onRetrievalDescent(candidate: Candidate): void {
    if (candidate.meta.vertical !== 'staircase') return
    const x = candidate.meta.stairStepX
    const y = candidate.meta.stairStepY
    const z = candidate.meta.stairStepZ
    const dir = candidate.meta.stairDir
    if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') return
    if (typeof dir !== 'string') return
    this.digMemory.record({
      x,
      y,
      z,
      dir: dir as DigDir,
      mode: 'down',
      target: typeof candidate.meta.resource === 'string' ? candidate.meta.resource : null,
      atMs: Date.now(),
    })
  }

  // -------------------------------------------------------------------------
  // long-horizon layer (System 2 / the goal queue)
  // -------------------------------------------------------------------------

  private objectiveState(): System2Objective {
    return {
      targetItem: this.goal.targetItem,
      requiredCount: this.goal.requiredCount,
      haveCount: this.goal.haveCount,
      complete: this.goal.complete,
    }
  }

  /**
   * Consume the queue against the live world: `collect` and `craft` goals are
   * inventory-counted and advance the queue when met. The transition is recorded
   * with the trigger that caused it, so every subgoal change is tied to a Jev
   * decision. A goal kind the PoC cannot execute is an exception that re-summons
   * System 2 (suppressed in single-shot mode).
   */
  private syncQueue(trigger: DecisionTrigger): void {
    // Live diagnosis (M2 hand-off): the queue's light row re-ignited thousands of
    // times without ever completing, and `portalLitTruth` (the row's completion
    // predicate) never ran. Record what the controller believes the current row is
    // so the gap is decided by evidence.
    {
      const row = this.queue.current
      this.logger.info(
        'queue',
        `SYNC_QUEUE trigger=${trigger} current=${row === null ? 'none' : `${row.id}|kind=${row.kind}|pred=${row.targetPredicate ?? 'none'}|status=${row.status ?? 'n/a'}`} depth=${this.queue.size}`,
        { current: row?.id ?? null, kind: row?.kind ?? null, predicate: row?.targetPredicate ?? null },
        this.tickCounter,
      )
    }
    const current = this.queue.current
    if (current === null) return
    if (current.kind === 'goto') {
      const target = current.targetPosition ?? null
      if (target === null) {
        const impossible = this.queue.markImpossible(`goto goal '${current.id}' has no code-grounded target position`)
        if (impossible !== null) {
          this.recentEvents.push(`goal impossible: ${impossible.description}`)
          this.summonLlm('action_impossible', `current goal is not executable: ${impossible.description}`)
        }
        return
      }
      const goalDimension = (current.dimension ?? '').replace(/^minecraft:/, '')
      const liveDimension = this.currentDimension().replace(/^minecraft:/, '')
      if (goalDimension.length > 0 && goalDimension !== liveDimension) {
        const impossible = this.queue.markImpossible(
          `goto goal '${current.id}' belongs to dimension ${current.dimension ?? 'unknown'} but live dimension is ${this.currentDimension()}`,
        )
        if (impossible !== null) {
          this.recentEvents.push(`goal impossible: ${impossible.description}`)
          this.summonLlm('action_impossible', `current goal is not executable: ${impossible.description}`)
        }
        return
      }
      const position = this.bot.entity.position
      const distanceToTarget = Math.hypot(position.x - target.x, position.y - target.y, position.z - target.z)
      if (distanceToTarget > 2.5) return
      const beforeId = current.id
      const beforeDescription = current.description
      this.queue.markDone()
      const after = this.queue.current
      this.pendingTransition = {
        fromId: beforeId,
        fromDescription: beforeDescription,
        toId: after?.id ?? null,
        toDescription: after?.description ?? null,
        trigger,
        inventory: this.inventorySnapshot(),
      }
      this.lastProgressAt = Date.now()
      this.lastProgress = 0
      this.logger.warn(
        'queue',
        `subgoal COMPLETE [${beforeDescription}] -> [${after?.description ?? 'plan complete'}] trigger=${trigger} distance=${Math.round(distanceToTarget * 100) / 100}`,
        { from: beforeId, to: after?.id ?? null, trigger, distance: distanceToTarget, target },
        this.tickCounter,
      )
      if (after !== null) this.logSubgoalStart(after, this.pendingTransition.inventory, `advance:${trigger}`)
      return
    }
    if (current.kind === 'descend') {
      // The plan was supplied before the smelt inputs were held, so the ore
      // descent that preceded the smelt is now a stale prerequisite. Retire it
      // so the queue advances to the smelt / its furnace path instead of
      // descending forever (see `staleOreDescend`).
      const staleSmelt = staleOreDescend(current, this.queue.state.goals, this.queuePreconditionSnapshot())
      if (staleSmelt !== null) {
        const beforeId = current.id
        const beforeDescription = current.description
        this.queue.markDone()
        const after = this.queue.current
        this.pendingTransition = {
          fromId: beforeId,
          fromDescription: beforeDescription,
          toId: after?.id ?? null,
          toDescription: after?.description ?? null,
          trigger,
          inventory: this.inventorySnapshot(),
        }
        this.lastProgressAt = Date.now()
        this.lastProgress = 0
        this.descendHaveBaseline = 0
        this.digMemory.markResourceProgress()
        this.logger.warn(
          'queue',
          `subgoal COMPLETE [${beforeDescription}] -> [${after?.description ?? 'plan complete'}] trigger=${trigger} stale_ore_descend_for=${staleSmelt.description} inventory=${JSON.stringify(this.pendingTransition.inventory)}`,
          { from: beforeId, to: after?.id ?? null, trigger, staleFor: staleSmelt.id, staleForDescription: staleSmelt.description },
          this.tickCounter,
        )
        if (after !== null) this.logSubgoalStart(after, this.pendingTransition.inventory, `advance:${trigger}:stale-ore-descend`)
        return
      }
      const evaluation = this.evaluateDescendGoal(current)
      if (evaluation === null) {
        const impossible = this.queue.markImpossible(`descend goal '${current.id}' has no targetY predicate`)
        if (impossible !== null) {
          this.recentEvents.push(`goal impossible: ${impossible.description}`)
          this.summonLlm('action_impossible', `current goal is not executable: ${impossible.description}`)
        }
        return
      }
      this.logger.info(
        'queue',
        `PREDICATE_EVAL [${current.id}] ${evaluation.detail}`,
        {
          id: current.id,
          predicate: 'descend_to',
          targetY: current.targetY,
          y: evaluation.y,
          dimensionOk: evaluation.dimensionOk,
          satisfied: evaluation.satisfied,
        },
        this.tickCounter,
      )
      if (!evaluation.satisfied) return
      const beforeId = current.id
      const beforeDescription = current.description
      this.queue.markDone()
      const after = this.queue.current
      this.pendingTransition = {
        fromId: beforeId,
        fromDescription: beforeDescription,
        toId: after?.id ?? null,
        toDescription: after?.description ?? null,
        trigger,
        inventory: this.inventorySnapshot(),
      }
      this.harvestedGoalCount = 0
      this.lastProgressAt = Date.now()
      this.lastProgress = 0
      this.descendHaveBaseline = 0
      this.digMemory.markResourceProgress()
      this.logger.warn(
        'queue',
        `subgoal COMPLETE [${beforeDescription}] -> [${after?.description ?? 'plan complete'}] trigger=${trigger} reached=${evaluation.y} targetY=${current.targetY} inventory=${JSON.stringify(this.pendingTransition.inventory)}`,
        { from: beforeId, to: after?.id ?? null, trigger, y: evaluation.y, targetY: current.targetY },
        this.tickCounter,
      )
      if (after !== null) this.logSubgoalStart(after, this.pendingTransition.inventory, `advance:${trigger}`)
      return
    }
    if (current.targetItem !== null && (current.kind === 'collect' || current.kind === 'craft' || current.kind === 'smelt')) {
      const have = this.effectiveHave()
      const beforeId = current.id
      const beforeDescription = current.description
      this.queue.markProgress(have)
      const after = this.queue.current
      if (after === null || after.id !== beforeId) {
        this.pendingTransition = {
          fromId: beforeId,
          fromDescription: beforeDescription,
          toId: after?.id ?? null,
          toDescription: after?.description ?? null,
          trigger,
          inventory: this.inventorySnapshot(),
        }
        this.harvestedGoalCount = 0
        this.lastProgressAt = Date.now()
        this.lastProgress = 0
        this.descendHaveBaseline = have
        this.digMemory.markResourceProgress()
        this.logger.warn(
          'queue',
          `subgoal COMPLETE [${beforeDescription}] -> [${after?.description ?? 'plan complete'}] trigger=${trigger} have=${have} inventory=${JSON.stringify(this.pendingTransition.inventory)}`,
          { from: beforeId, to: after?.id ?? null, trigger, have },
          this.tickCounter,
        )
        if (after !== null) this.logSubgoalStart(after, this.pendingTransition.inventory, `advance:${trigger}`)
      }
      return
    }
    if (current.kind === 'place') {
      // Being in the Nether proves the overworld light row has served its purpose.
      // `portalLitTruth` is dimension-bound to the row's own dimension (overworld),
      // so without this the row can never complete after the transfer and the
      // queue never drains to the M3 goals - live: the body stood in the Nether
      // with a plan already containing `collect 7 x blaze_rod` / `collect 12 x
      // ender_pearl` while it WAITed on the light row forever.
      const inNether = String(this.bot.game?.dimension ?? '') === 'minecraft:the_nether'
      const complete =
        current.targetPredicate === PORTAL_LIT_PREDICATE
          ? this.portalLitTruth(current) || inNether
          : current.targetPredicate === PORTAL_ENTERED_PREDICATE
            ? this.portalEnteredTruth(current)
            : current.targetItem !== null && this.countItem(current.targetItem) <= 0
      if (complete) {
        const beforeId = current.id
        const beforeDescription = current.description
        this.queue.markDone()
        const after = this.queue.current
        this.pendingTransition = {
          fromId: beforeId,
          fromDescription: beforeDescription,
          toId: after?.id ?? null,
          toDescription: after?.description ?? null,
          trigger,
          inventory: this.inventorySnapshot(),
        }
        this.lastProgressAt = Date.now()
        this.lastProgress = 0
        this.logger.warn(
          'queue',
          `subgoal COMPLETE [${beforeDescription}] -> [${after?.description ?? 'plan complete'}] trigger=${trigger} inventory=${JSON.stringify(this.pendingTransition.inventory)}`,
          { from: beforeId, to: after?.id ?? null, trigger },
          this.tickCounter,
        )
        if (after !== null) this.logSubgoalStart(after, this.pendingTransition.inventory, `advance:${trigger}`)
      }
      return
    }
    if (current.kind === 'surface') {
      if (typeof current.targetY !== 'number' || !Number.isFinite(current.targetY)) {
        const badPredicate = this.queue.markImpossible(`surface goal '${current.id}' has no targetY predicate`)
        if (badPredicate !== null) {
          this.recentEvents.push(`goal impossible: ${badPredicate.description}`)
          this.summonLlm('action_impossible', `current goal is not executable: ${badPredicate.description}`)
        }
        return
      }
      if (this.lastSurfaceGoalId !== current.id) {
        this.lastSurfaceGoalId = current.id
        this.logger.warn(
          'agent',
          `RETURN_TO_SURFACE goal=${current.id} target_y=${current.targetY} reason=capability_gap`,
          { id: current.id, targetY: current.targetY },
          this.tickCounter,
        )
      }
      const evaluation = evaluateSurfaceRecovery(current, {
        ...this.predicateSnapshot(),
        inventory: this.inventorySnapshot(),
      })
      if (evaluation === null || !evaluation.satisfied) {
        // Deterministic feasibility (CAN/TRUE, not a preference): the candidate
        // layer proved there is no grounded ascent route for this `targetY`, the
        // tick offered NO body-changing route at all (`surfaceAscentRouteless`),
        // and that same refusal has held for several consecutive candidate
        // generations under this goal. The Option provably cannot progress from
        // this state, so mark it impossible and let System2 replace it instead of
        // the body pacing in the level-move set (the measured 48-minute loop).
        // The stale CAPABILITY_GAP marker is dropped here so the planner's
        // forced-surface path (planner-legacy `forcedSurface`) cannot immediately
        // re-issue the same impossible row; the durable log lines remain.
        const refusal = this.lastSurfaceAscentRefusal
        if (
          refusal !== null &&
          this.lastSurfaceAscentRouteless &&
          this.surfaceAscentRefusalStreak >= SURFACE_ASCENT_IMPOSSIBLE_STREAK &&
          refusal.goalId === current.id
        ) {
          const impossible = this.queue.markImpossible(
            `surface goal '${current.id}' has no grounded ascent route (${formatSurfaceAscentRefused(refusal)})`,
          )
          if (impossible !== null) {
            this.capabilityGapActive = false
            this.capabilityGapSignature = null
            this.lastSurfaceAscentRefusal = null
            this.lastSurfaceAscentRefusalKey = null
            this.surfaceAscentRefusalStreak = 0
            this.surfaceAscentRefusalStreakKey = null
            this.recentEvents = this.recentEvents.filter((line) => !line.startsWith('CAPABILITY_GAP '))
            this.recentEvents.push(`goal impossible: ${impossible.description}`)
            this.summonLlm('action_impossible', `current goal is not executable: ${impossible.description}`)
          }
        }
        return
      }
      const beforeId = current.id
      const beforeDescription = current.description
      this.queue.markDone()
      const after = this.queue.current
      this.pendingTransition = {
        fromId: beforeId,
        fromDescription: beforeDescription,
        toId: after?.id ?? null,
        toDescription: after?.description ?? null,
        trigger,
        inventory: this.inventorySnapshot(),
      }
      this.harvestedGoalCount = 0
      this.lastProgressAt = Date.now()
      this.lastProgress = 0
      this.capabilityGapActive = false
      this.capabilityGapSignature = null
      this.digMemory.markResourceProgress()
      this.logger.warn(
        'agent',
        `RETURN_TO_SURFACE goal=${beforeId} reached=true predicate=levelAtLeast+inventory y=${Math.round(evaluation.vertical.y ?? 0)} target_y=${current.targetY} log=${evaluation.have}/${evaluation.required}`,
        {
          from: beforeId,
          to: after?.id ?? null,
          trigger,
          y: evaluation.vertical.y,
          targetY: current.targetY,
          resourceHave: evaluation.have,
          resourceRequired: evaluation.required,
        },
        this.tickCounter,
      )
      if (after !== null) this.logSubgoalStart(after, this.pendingTransition.inventory, `advance:${trigger}`)
      return
    }
    const impossible = this.queue.markImpossible(
      `goal kind '${current.kind}' is not executable by this PoC`,
    )
    if (impossible !== null) {
      this.recentEvents.push(`goal impossible: ${impossible.description}`)
      this.summonLlm('action_impossible', `current goal is not executable: ${impossible.description}`)
    }
  }

  private predicateSnapshot(): { position: Vec3Json | null; dimension: string | null } {
    const entity = this.bot.entity
    if (entity === undefined) return { position: null, dimension: null }
    return {
      position: { x: entity.position.x, y: entity.position.y, z: entity.position.z },
      dimension: this.bot.game?.dimension ?? null,
    }
  }

  private evaluateDescendGoal(goal: QueuedGoal): PredicateEvaluation | null {
    const predicate = predicateForGoal(goal)
    if (predicate === null) return null
    return evaluateSpatialPredicate(predicate, this.predicateSnapshot())
  }

  /**
   * World truth for the portal predicate. `nether_portal` is not an inventory
   * item, and a prior queue record must never make an unlit frame look done.
   * Re-sense the frame and require every live interior cell to be a portal.
   */
  private portalLitTruth(goal: QueuedGoal): boolean {
    if (goal.targetPredicate !== PORTAL_LIT_PREDICATE) return false
    const actualDimension = this.bot.game?.dimension ?? null
    const expectedDimension = goal.dimension ?? OVERWORLD
    const normalize = (value: string): string => value.replace(/^minecraft:/, '').toLowerCase()
    if (actualDimension === null || normalize(actualDimension) !== normalize(expectedDimension)) return false
    const sites = sensedPortalFrameSites(this.bot, sensorOptions(this.options))
    const scratch = this.bot.entity?.position?.clone()
    if (scratch === undefined) return false
    const samples: string[] = []
    const lit = sites.some((site) => {
      const blocks = site.existingFrame?.length ?? 0
      if (blocks < PORTAL_OBSIDIAN_REQUIRED) {
        samples.push(`origin=${site.origin.x},${site.origin.y},${site.origin.z} blocks=${blocks} <required`)
        return false
      }
      const layout = portalFrameLayout(site.origin, site.widthAxis)
      const interior = layout.interior.map(
        (cell) => this.bot.blockAt(scratch.set(cell.x, cell.y, cell.z))?.name ?? 'null',
      )
      const ok = isPortalIgnitionPostconditionMet(layout.interior, (cell) => this.bot.blockAt(scratch.set(cell.x, cell.y, cell.z))?.name ?? null, NETHER_PORTAL)
      samples.push(`origin=${site.origin.x},${site.origin.y},${site.origin.z} blocks=${blocks} interior=[${interior.join(',')}] ok=${ok}`)
      return ok
    })
    // Live diagnosis for the M2 hand-off: the portal is `PORTAL_VERIFIED` yet the
    // queue's light row kept re-igniting hundreds of times, so the queue never
    // emptied and the ladder never advanced to `enter_nether`. This records the
    // exact world truth the predicate saw (dimension, sites, interior cells).
    this.logger.info(
      'agent',
      `PORTAL_LIT_TRUTH goal=${goal.id} dimension=${actualDimension} expected=${expectedDimension} sites=${sites.length} lit=${lit} ${samples.join(' | ')}`,
      { actionId: goal.id },
    )
    return lit
  }

  /**
   * Ground the dimension-transfer plan for the active `portal_entered` goal from
   * LIVE world truth only: the interior must currently be `nether_portal` and at
   * least one interior cell must be standable by the GENERIC locomotion rule
   * (the same `isStandable` the terrain sensor and MOVE guard use). Returns null
   * when the active goal does not request entry. Never silent: a requested entry
   * with no lit/standable portal returns the pure module's typed refusal.
   */
  private portalEntryPlan(state: WorldState): PortalEntryPlan | null {
    const current = state.goalQueue?.current ?? null
    if (current === null) return null
    if (current.kind !== 'place' || current.targetPredicate !== PORTAL_ENTERED_PREDICATE) return null
    const entity = this.bot.entity
    if (entity === undefined) return null
    const scratch = entity.position.clone()
    const blockAt = (cell: { x: number; y: number; z: number }): string | null =>
      this.bot.blockAt(scratch.set(cell.x, cell.y, cell.z))?.name ?? null
    const sites = state.portalFrameSites ?? []
    const dimension = current.dimension ?? NETHER
    const self = {
      x: Math.floor(state.self.position.x),
      y: Math.floor(state.self.position.y),
      z: Math.floor(state.self.position.z),
    }
    let refusal: PortalEntryPlan | null = null
    for (const site of sites) {
      const plan = planPortalEntry({
        site,
        self,
        blockAt,
        isStandable: (cell) => isStandable(this.bot, cell),
        fromDimension: state.self.dimension,
        dimension,
      })
      if (plan.ok) return plan
      if (refusal === null) refusal = plan
    }
    return (
      refusal ?? {
        ok: false,
        refused: true,
        reason: 'no_known_site',
        // With ZERO sites examined there is no observation at all, so claiming
        // `portal_not_lit` would be a fabricated world fact (live
        // run-muc3qbug-18vg3 emitted exactly that while the run's own durable
        // record said the gate was lit and verified). Name what is missing.
        line: formatPortalEntryNoKnownSite(),
      }
    )
  }

  /**
   * The remembered-site approach marker: the entry route targets a portal whose
   * lit interior could not be observed from here, so the walk is offered and the
   * executor re-verifies the `nether_portal` interior at arrival. Distinct from
   * `logEntryRefusal` (which owns the refusals) and deduped by line so a stable
   * unverified route is one run-scoped fact, not a per-tick flood.
   */
  private logEntryUnverified(plan: PortalEntryPlan | null): void {
    const line = plan !== null && plan.ok && plan.candidate.unverified === true ? plan.candidate.line : null
    if (line === this.lastEntryUnverifiedKey) return
    this.lastEntryUnverifiedKey = line
    if (line === null) return
    this.logger.info('agent', line, { reason: 'site_not_observed', enter: line }, this.tickCounter)
  }

  /**
   * World truth for the dimension-transfer predicate. The row is complete ONLY
   * when the bot's own live dimension equals the goal's target; no inventory
   * count can substitute for it (`nether_portal` is not an item).
   */
  private portalEnteredTruth(goal: QueuedGoal): boolean {
    if (goal.targetPredicate !== PORTAL_ENTERED_PREDICATE) return false
    const actual = this.bot.game?.dimension ?? null
    if (actual === null) return false
    const normalize = (value: string): string => value.replace(/^minecraft:/, '').toLowerCase()
    return normalize(actual) === normalize(goal.dimension ?? NETHER)
  }

  private logEntryRefusal(refusal: PortalEntryRefusal | null): void {
    const key = refusal === null ? null : refusal.line
    if (key === this.lastEntryRefusalKey) return
    this.lastEntryRefusalKey = key
    if (refusal === null) return
    this.logger.warn('agent', refusal.line, { reason: refusal.reason }, this.tickCounter)
  }

  /**
   * A route arm that reports `all_routes_spent` has proved a STRUCTURAL
   * capability boundary: every route it can ground from this body cell to the
   * goal's target is spent, and no grounded approach leg changes the stand cell.
   * That is exactly the WHAT-next boundary System2 owns, so it goes through the
   * ordinary bounded escalation (`escalationCooldownMs` / `escalationWindowMs`
   * and the `ESCALATION_TO_SUMMON` mapping) instead of re-offering the dead
   * route. Code still owns the fact (CAN/TRUE); Jev still chooses WHICH among
   * the remaining grounded offers; System2 owns WHAT comes next.
   */
  private noteRouteExhaustion(refusal: PortalEntryRefusal | null): void {
    if (refusal === null || refusal.reason !== ROUTE_ALL_SPENT_REASON) return
    this.escalate('route_exhausted', refusal.line)
  }

  private effectiveHave(): number {
    const current = this.queue.current
    if (current === null || current.targetItem === null) return 0
    // M1 completion is inventory-verified: a subgoal only completes when the item
    // is actually in the inventory. A dig whose drop was not picked up simply
    // leaves the subgoal open and the bot mines another block. A wood goal counts
    // every `*_log` the bot holds, so `birch_log` satisfies an `oak_log` goal.
    // Issue #43: a fuel subgoal (`collect N x log (fuel)`) is satisfied by any
    // accepted fuel item (log/planks/coal/charcoal/blaze_rod), not only logs. A
    // smelt goal still counts its own output, never the fuel it consumes.
    if (goalCollectsFuel(current)) return this.countFuelSubstitutes()
    return this.countGoalCategory(current.targetItem)
  }

  private countFuelSubstitutes(): number {
    let total = 0
    for (const item of this.bot.inventory.items()) {
      if (item.name === 'stick') continue
      if (matchesResourceClass(item.name, 'fuel')) total += item.count
    }
    return total
  }

  private countGoalCategory(name: string): number {
    if (!isResourceClass(name)) return this.countItem(name)
    let total = 0
    for (const item of this.bot.inventory.items()) {
      if (matchesResourceClass(item.name, name)) total += item.count
    }
    return total
  }

  private syncGoalToQueue(): void {
    const current = this.queue.current
    if (current === null) return
    if (current.kind === 'descend') {
      const evaluation = this.evaluateDescendGoal(current)
      const satisfied = evaluation?.satisfied ?? false
      this.goal = {
        id: current.id,
        description: current.description,
        targetItem: current.targetItem ?? '',
        requiredCount: 1,
        startCount: 0,
        haveCount: satisfied ? 1 : 0,
        progress: satisfied ? 1 : 0,
        complete: satisfied,
        startedAtMs: current.createdAt,
      }
      return
    }
    if (current.kind === 'surface') {
      const evaluation = evaluateSurfaceRecovery(current, {
        ...this.predicateSnapshot(),
        inventory: this.inventorySnapshot(),
      })
      const have = evaluation?.have ?? 0
      this.goal = {
        id: current.id,
        description: current.description,
        targetItem: current.targetItem ?? '',
        requiredCount: current.requiredCount,
        startCount: 0,
        haveCount: have,
        progress: evaluation?.satisfied === true ? 1 : Math.min(1, have / Math.max(1, current.requiredCount)),
        complete: evaluation?.satisfied === true,
        startedAtMs: current.createdAt,
      }
      return
    }
    if (current.targetItem === null) return
    const have = this.effectiveHave()
    if (current.kind === 'place') {
      // Ordinary PLACE goals are inverse inventory goals. A portal ignition or
      // dimension transfer is different: `nether_portal` is a world block, never
      // an inventory item, so zero inventory must not masquerade as a completed
      // predicate. Each portal predicate owns its own live-world truth.
      const placed =
        current.targetPredicate === PORTAL_LIT_PREDICATE
          ? this.portalLitTruth(current)
          : current.targetPredicate === PORTAL_ENTERED_PREDICATE
            ? this.portalEnteredTruth(current)
            : have <= 0
      this.goal = { ...subgoalState(current, placed ? current.requiredCount : 0), haveCount: placed ? current.requiredCount : have }
      return
    }
    this.goal = subgoalState(current, have)
  }

  private consumeTransition(): DecisionSubgoalLog | null {
    const transition = this.pendingTransition
    this.pendingTransition = null
    return transition
  }

  private llmLog(): DecisionLlmLog {
    return { called: this.tickLlmCalls > 0, runtimeCalls: this.runtimeLlmCalls, planCalls: this.planCalls }
  }

  private countItem(name: string): number {
    const registry = this.bot.registry as { itemsByName?: Record<string, { id?: number }> } | undefined
    const id = registry?.itemsByName?.[name]?.id
    if (typeof id !== 'number') return 0
    return this.bot.inventory.count(id, null)
  }

  private inventorySnapshot(): Record<string, number> {
    const counts: Record<string, number> = {}
    for (const item of this.bot.inventory.items()) {
      counts[item.name] = (counts[item.name] ?? 0) + item.count
    }
    return counts
  }

  private currentGoalPreconditionCause(state: WorldState): string | null {
    const current = this.queue.state.current
    if (current === null) return null
    return goalPreconditionCause(queuedToPlanned(current), this.optionSnapshot(state))
  }

  private optionSnapshot(state: WorldState): OptionWorldSnapshot {
    const counts = this.inventorySnapshot()
    let toolRank = 0
    for (let i = 0; i < PICKAXE_TIER_ORDER.length; i += 1) {
      const name = PICKAXE_TIER_ORDER[i]
      if (name !== undefined && (counts[name] ?? 0) > 0) toolRank = i + 1
    }
    const knownStations = new Set<'crafting_table' | 'furnace'>()
    if ((counts['crafting_table'] ?? 0) > 0) knownStations.add('crafting_table')
    if ((counts['furnace'] ?? 0) > 0) knownStations.add('furnace')
    if (state.craftingTables.length > 0) knownStations.add('crafting_table')
    if ((state.furnaces?.length ?? 0) > 0) knownStations.add('furnace')
    const knownOres: string[] = []
    for (const resource of this.options.knownResources ?? []) {
      if (resource.name === 'furnace') knownStations.add('furnace')
      if (resource.name === 'crafting_table') knownStations.add('crafting_table')
      if (resource.kind === 'ore') knownOres.push(resource.name)
    }
    const position = this.bot.entity?.position
    return makeOptionSnapshot({
      inventory: counts,
      dimension: this.bot.game?.dimension ?? null,
      position: position === undefined ? null : { x: position.x, y: position.y, z: position.z },
      health: this.bot.health ?? null,
      toolRank,
      knownStations: [...knownStations],
      knownOres,
    })
  }

  /**
   * The OptionSpec preconditions a queue goal is checked against, built before
   * the tick's `WorldState` exists. Only inventory and station names are read by
   * the smelt item preconditions `staleOreDescend` inspects.
   */
  private queuePreconditionSnapshot(): OptionWorldSnapshot {
    const counts = this.inventorySnapshot()
    let toolRank = 0
    for (let i = 0; i < PICKAXE_TIER_ORDER.length; i += 1) {
      const name = PICKAXE_TIER_ORDER[i]
      if (name !== undefined && (counts[name] ?? 0) > 0) toolRank = i + 1
    }
    const knownStations = new Set<'crafting_table' | 'furnace'>()
    if ((counts['crafting_table'] ?? 0) > 0) knownStations.add('crafting_table')
    if ((counts['furnace'] ?? 0) > 0) knownStations.add('furnace')
    for (const resource of this.options.knownResources ?? []) {
      if (resource.name === 'furnace') knownStations.add('furnace')
      if (resource.name === 'crafting_table') knownStations.add('crafting_table')
    }
    const position = this.bot.entity?.position
    return makeOptionSnapshot({
      inventory: counts,
      dimension: this.bot.game?.dimension ?? null,
      position: position === undefined ? null : { x: position.x, y: position.y, z: position.z },
      health: this.bot.health ?? null,
      toolRank,
      knownStations: [...knownStations],
      knownOres: [],
    })
  }

  /**
   * Wire the resident-injected #prereq-dominated proof into the queue. The
   * closure reads LIVE inventory at reconciliation time, so a queued
   * prerequisite retires as soon as the better items exist - not only at a
   * reload boundary.
   */
  private installDominatedPrerequisiteReason(): void {
    const reason = this.options.dominatedGoalReason
    if (reason === undefined) {
      this.queue.setDominatedPrerequisiteReason(null)
      return
    }
    this.queue.setDominatedPrerequisiteReason((goal) => reason(goal, this.inventorySnapshot()))
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
    this.queue.setGoalSuccessProbe(
      (goal) => evaluateGoalSuccess(goal, this.goalWorldProbe()),
      (line, detail) => this.logger?.warn('queue', line, detail, this.tickCounter),
    )
  }

  /** The live world facts the success-predicate probe may read. Plain reads only. */
  private goalWorldProbe(): GoalSuccessWorldProbe {
    const scratch = this.bot.entity?.position?.clone()
    return {
      dimension: this.bot.game?.dimension ?? null,
      blockAt: (cell) => {
        if (scratch === undefined) return null
        try {
          return this.bot.blockAt(scratch.set(cell.x, cell.y, cell.z))?.name ?? null
        } catch {
          // An unreadable cell is unobservable world truth, never absence.
          return null
        }
      },
      recordedPortalSites: this.recordedPortalSites(),
      verifiedBlockRecords: verifiedBlockRecordsFromKnownResources(this.options.knownResources),
    }
  }

  /**
   * The run's durable verified-portal records, in the geometry envelope the
   * world memory already carries (`KnownResource` kind `portal`: origin +
   * widthAxis + recorded frame cells). The records are minted and revoked by the
   * world-memory sync from LIVE block truth (`syncKnownPortalSites` /
   * `PORTAL_VERIFIED`); this reader neither adds nor revokes one.
   */
  private recordedPortalSites(): RecordedPortalSite[] {
    return recordedPortalSitesFromKnownResources(this.options.knownResources)
  }

  /**
   * Retire a stale protected prerequisite that world truth has already made
   * unnecessary. This is a world-truth/lifecycle reconciliation, not a semantic
   * preference: every other protected goal keeps the normal #55 reinsertion
   * guarantee.
   */
  private protectedGoalRetireReason(goal: QueuedGoal, incoming: readonly PlannedGoal[]): string | null {
    // An `smelt:iron_ingot` row exists only to feed a craft that consumes the
    // ingot. Once that craft is resolved — the bot holds the flint_and_steel it
    // produced — and nothing live still wants an iron ingot, the row can only
    // re-run a smelt with no consumer, while its own station precondition (a
    // furnace) blocks the queue head indefinitely. Observed live: the queue head
    // was `smelt 1 x iron_ingot` with
    // `CANDIDATE_STARVATION blockedBy=precondition:station:furnace repeat=36`
    // while the real next step, `collect 10 x obsidian`, sat behind it.
    if (goal.kind === 'smelt' && goal.targetItem === IRON_INGOT) {
      const stillWanted =
        incoming.some((planned) => planned.targetItem === IRON_INGOT) ||
        this.queue.state.goals.some(
          (row) =>
            row.id !== goal.id &&
            row.status !== 'done' &&
            row.status !== 'impossible' &&
            row.targetItem === IRON_INGOT,
        )
      const reason = orphanedSmeltPrerequisiteReason({
        kind: goal.kind,
        item: goal.targetItem,
        held: this.countItem(FLINT_AND_STEEL),
        stillWanted,
      })
      if (reason !== null) return reason
    }
    if (goal.kind !== 'collect' || goal.targetItem !== OBSIDIAN) return null
    const continuesPortalFrame = incoming.some(
      (planned) =>
        planned.kind === 'place' &&
        planned.targetItem === OBSIDIAN &&
        (planned.optionTemplateId === 'place:obsidian' || planned.description.toLowerCase().includes('portal frame')),
    )
    if (!continuesPortalFrame) return null
    const sensedSites = sensedPortalFrameSites(this.bot, sensorOptions(this.options))
    this.rememberPortalFrameSites(sensedSites, this.currentDimension())
    const existing = Math.max(0, ...sensedSites.map((site) => site.existingFrame?.length ?? 0))
    const held = this.countItem(OBSIDIAN)
    if (existing + held < PORTAL_OBSIDIAN_REQUIRED) return null
    return `portal frame coverage existing=${existing} held=${held} required=${PORTAL_OBSIDIAN_REQUIRED}`
  }

  /**
   * Preserve only partial/full frame sites observed by this generation. Empty
   * candidate footprints are intentionally not remembered. A remembered site
   * is an affordance hint for re-observation; it never bypasses the executor's
   * live block and post-condition checks.
   */
  private mergeRememberedPortalFrame(state: WorldState): WorldState {
    const dimension = state.self.dimension
    if (this.rememberedPortalFrameDimension !== dimension) {
      this.rememberedPortalFrameDimension = dimension
      this.rememberedPortalFrameSites.clear()
      this.rememberedPortalFrame = null
    }
    this.rememberPortalFrameSites(state.portalFrameSites ?? [], dimension)
    if (state.portalFrame?.shape === 'ok') this.rememberedPortalFrame = state.portalFrame
    if (this.rememberedPortalFrameSites.size === 0 && this.rememberedPortalFrame === null) return state

    const merged: PortalFrameSite[] = []
    const seen = new Set<string>()
    // LIVE sites win over remembered copies: the live functional-core fact
    // (`coreIntact`) is current world truth, and a remembered geometry-only copy
    // must never shadow it. Memory only fills sites the sensor did not observe
    // this tick, matching `mergePortalFrameSites` in the sensor.
    for (const site of [...(state.portalFrameSites ?? []), ...this.rememberedPortalFrameSites.values()]) {
      const key = `${site.origin.x},${site.origin.y},${site.origin.z}|${site.widthAxis}`
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(site)
    }
    return {
      ...state,
      portalFrameSites: merged,
      portalFrame: state.portalFrame ?? this.rememberedPortalFrame,
      // Re-derive the source-protection membership from the MERGED sites: the
      // sensor computed it from the sites it saw this tick, and a frame that
      // only this generation's memory still holds must stay protected too.
      liveStructureMembers: liveStructureMembersForSites(merged),
    }
  }

  private rememberPortalFrameSites(sites: readonly PortalFrameSite[], dimension: string): void {
    if (this.rememberedPortalFrameDimension !== dimension) {
      this.rememberedPortalFrameDimension = dimension
      this.rememberedPortalFrameSites.clear()
      this.rememberedPortalFrame = null
    }
    for (const site of sites) {
      if ((site.existingFrame?.length ?? 0) === 0) continue
      const key = `${site.origin.x},${site.origin.y},${site.origin.z}|${site.widthAxis}`
      // Durable memory keeps geometry only. `coreIntact` is a volatile live-world
      // verdict (the portal's lit interior) and must be re-observed, never
      // replayed, or a destroyed portal's obsidian would stay protected forever.
      this.rememberedPortalFrameSites.set(key, {
        origin: { ...site.origin },
        widthAxis: site.widthAxis,
        safe: site.safe,
        reachable: site.reachable,
        temporarySupportRequired: site.temporarySupportRequired,
        existingFrame: site.existingFrame === undefined ? undefined : site.existingFrame.map((cell) => ({ ...cell })),
      })
    }
  }

  private logSubgoalStart(goal: QueuedGoal, inventory: Record<string, number>, cause: string): void {
    this.logger.warn(
      'queue',
      `subgoal START [${goal.id}] ${goal.description} kind=${goal.kind} target=${goal.targetItem ?? 'none'} required=${goal.requiredCount} cause=${cause} inventory=${JSON.stringify(inventory)}`,
      { id: goal.id, kind: goal.kind, targetItem: goal.targetItem, requiredCount: goal.requiredCount, cause },
      this.tickCounter,
    )
  }

  /**
   * Summon the long-horizon brain. This is the ONE place an LLM call is made; it
   * is never periodic, only exception-driven. Returns the resummon record for the
   * decision log, or null when the call was suppressed (in flight / cooldown).
   */
  private summonLlm(reason: LlmSummonReason, detail: string): DecisionLlmResummonLog | null {
    if (!this.running) return null
    if (this.queue.current?.origin === 'human') {
      this.logger.info(
        'system2',
        `HUMAN_INTENT_SYSTEM2_SUPPRESSED reason=${reason}`,
        { reason, detail, current: this.queue.current.description },
        this.tickCounter,
      )
      return { triggered: false, reason, detail: 'human intent owns WHAT until the interrupt completes or is cleared' }
    }
    if (this.protectedReplanSuppressed(reason)) {
      return { triggered: false, reason, detail: 'protected prerequisite: replan suppressed (#46)' }
    }
    if (this.options.singleShotPlanner && this.planSupplied) {
      this.logger.warn(
        'system2',
        `LLM summon suppressed reason=${reason} (single-shot planner: plan supplied once)`,
        { reason, detail },
        this.tickCounter,
      )
      return {
        triggered: false,
        reason,
        detail: 'single-shot planner: plan already supplied; the LLM must not be re-called',
      }
    }
    const now = Date.now()
    if (this.llmInFlight) {
      this.logger.info(
        'system2',
        `LLM summon suppressed reason=${reason} (a plan call is already in flight)`,
        { reason, detail },
        this.tickCounter,
      )
      return { triggered: false, reason, detail: 'a plan call is already in flight' }
    }
    const last = this.lastLlmSummonAt.get(reason) ?? 0
    if (reason !== 'queue_empty') {
      const throttle = this.replanThrottle.tryReplan(reason, this.replanInputs(), now)
      if (!throttle.allow) {
        const message = formatReplanThrottled(reason, throttle)
        this.logger.warn(
          'agent',
          message,
          { reason, ageMs: throttle.ageMs, stateHash: throttle.stateHash, because: throttle.kind },
          this.tickCounter,
        )
        if (throttle.kind === 'no_new_info') {
          // #78 counter: this local recovery has now been suppressed for
          // `count` consecutive zero-progress cycles with an unchanged
          // fingerprint. Bounded by `noInfoLimit`; see the exhausted branch.
          this.logger.warn(
            'agent',
            formatLocalRecoveryNoProgress(this.currentGoalKey(), reason, throttle),
            {
              reason,
              goal: this.currentGoalKey(),
              stateHash: throttle.stateHash,
              noInfoStreak: throttle.noInfoStreak,
              noInfoLimit: throttle.noInfoLimit,
            },
            this.tickCounter,
          )
        }
        return { triggered: false, reason, detail: message }
      }
      if (throttle.kind === 'exhausted') {
        // #78 escalation: N consecutive zero-progress cycles prove the local
        // recovery is itself stuck, which is a semantic boundary. The throttle
        // released the replan above, so the System2 call below is the explicit
        // escalation instead of an unbounded `REPLAN_THROTTLED no_new_info`.
        this.logger.warn(
          'agent',
          formatLocalRecoveryExhausted(this.currentGoalKey(), reason, throttle),
          {
            reason,
            goal: this.currentGoalKey(),
            stateHash: throttle.stateHash,
            noInfoStreak: throttle.noInfoStreak,
            noInfoLimit: throttle.noInfoLimit,
            boundary: 'semantic_boundary',
          },
          this.tickCounter,
        )
        // Same escalation vocabulary the rest of the controller uses, recorded
        // inline because `escalate()` would re-enter this throttle and
        // re-suppress the replan exhaustion just released. The throttle's own
        // N-cycle bound rate-limits this, so a cooldown is not needed.
        this.escalations.push('progress_stall')
        this.lastEscalationAt.set('progress_stall', now)
        this.lastEscalationMs = now
        this.signals.escalationRecommended = true
      }
    } else if (now - last < this.options.llmCooldownMs) {
      this.logger.info(
        'system2',
        `LLM summon suppressed reason=${reason} (${now - last}ms < ${this.options.llmCooldownMs}ms cooldown)`,
        { reason, detail },
        this.tickCounter,
      )
      return { triggered: false, reason, detail: `cooldown ${now - last}ms < ${this.options.llmCooldownMs}ms` }
    }

    this.lastLlmSummonAt.set(reason, now)
    this.llmInFlight = true
    this.llmSummons += 1
    this.runtimeLlmCalls += 1
    this.tickLlmCalls += 1
    this.llmSummonReasons.push(reason)

    const groundedDetail =
      this.noProductiveThisTick && this.starvationContext !== null
        ? `${detail}; grounded blocker=${this.starvationContext.blockedBy}${this.starvationContext.missing.length > 0 ? ` missing=${JSON.stringify(this.starvationContext.missing)}` : ''}`
        : detail
    const queueState = this.queue.state
    const currentOption = queueState.current
    const requestContext: System2RequestContext = {
      requestId: randomUUID(),
      queueRevision: this.queue.revision,
      optionInstanceId: currentOption?.semanticOptionInstanceId ?? currentOption?.optionInstanceId ?? null,
      optionTemplateId: currentOption?.semanticOptionTemplateId ?? currentOption?.optionTemplateId ?? null,
      worldEpoch: this.options.worldEpoch,
      stateFingerprint: this.lastStateFingerprint || 'unobserved',
      // Local semantic progress and critical threat changes both invalidate an
      // asynchronous WHAT decision. `criticalStateVersion` covers health/mob
      // events that are intentionally absent from the compact world fingerprint.
      authorityEpoch: this.semanticStateGeneration + this.criticalStateVersion,
    }
    const request: System2PlanRequest = {
      reason,
      detail: groundedDetail,
      tick: this.tickCounter,
      goalQueueState: queueState,
      objective: this.objectiveState(),
      recentEvents: this.recentEvents.slice(-8),
      recentOutcomes: this.recentOutcomes.slice(-8),
      requestContext,
    }
    const resummon: DecisionLlmResummonLog = { triggered: true, reason, detail: groundedDetail }
    this.tickResummonLog.push(resummon)

    this.logger.warn(
      'system2',
      `SUMMON LLM reason=${reason} queueDepth=${queueState.depth} current=${queueState.current?.description ?? 'none'} :: ${groundedDetail}`,
      {
        reason,
        queueDepth: queueState.depth,
        currentGoal: queueState.current?.description ?? null,
        detail: groundedDetail,
        model: this.system2Model,
        provider: this.system2Provider,
        requestId: requestContext.requestId,
        requestContext,
      },
      this.tickCounter,
    )

    void this.system2
      .plan(request)
      .then((plan) => {
        if (!this.running) {
          this.logger.warn(
            'system2',
            'SYSTEM2_STALE_DISCARD reason=controller_stopped',
            { reason, requestId: requestContext.requestId, note: plan.note, op: plan.op ?? 'replace' },
            this.tickCounter,
          )
          this.llmInFlight = false
          return
        }
        const current = this.queue.state
        const currentContext: System2ApplyState = {
          queueRevision: this.queue.revision,
          optionInstanceId: current.current?.semanticOptionInstanceId ?? current.current?.optionInstanceId ?? null,
          optionTemplateId: current.current?.semanticOptionTemplateId ?? current.current?.optionTemplateId ?? null,
          worldEpoch: this.options.worldEpoch,
          stateFingerprint: this.lastStateFingerprint || 'unobserved',
          // Local semantic progress and critical threat changes both invalidate an
          // asynchronous WHAT decision. `criticalStateVersion` covers health/mob
          // events that are intentionally absent from the compact world fingerprint.
          authorityEpoch: this.semanticStateGeneration + this.criticalStateVersion,
          actionInFlight: system2BodyOwned(this.executor.current?.kind ?? null),
        }
        const validity = evaluateSystem2Apply(requestContext, currentContext)
        if (!validity.apply) {
          const line = formatSystem2Discard(requestContext, validity.reasons)
          this.logger.warn(
            'system2',
            line,
            {
              requestId: requestContext.requestId,
              reasons: validity.reasons,
              requestContext,
              currentContext,
              note: plan.note,
              op: plan.op ?? 'replace',
            },
            this.tickCounter,
          )
          this.llmInFlight = false
          this.requestDecision('llm_plan', { reason, discarded: true, reasons: validity.reasons })
          return
        }
        const depthBefore = this.queue.state.depth
        const added = this.queue.applyPlan(plan.goals, 'llm', plan.op ?? 'replace', {
          reason: plan.note,
          onProtection: (line) => this.logger.warn('agent', line, { op: plan.op ?? 'replace', reason, phase: 'runtime' }, this.tickCounter),
          onDuplicate: (line) => this.logger.warn('agent', line, { op: plan.op ?? 'replace', reason, phase: 'runtime' }, this.tickCounter),
          protectedGoalRetireReason: (goal, incoming) => this.protectedGoalRetireReason(goal, incoming),
          verifyCurrentComplete: (goal) => this.verifyQueuedGoalComplete(goal),
          onOperationRejected: (line) => this.logger.warn('system2', line, { requestId: requestContext.requestId, op: plan.op ?? 'replace' }, this.tickCounter),
        })
        this.logQueueDepthDelta(depthBefore, plan.op ?? 'replace', `summon:${reason}`)
        this.waitReplans = 0
        if (added.length > 0) {
          this.wedgeWindowId = null
          this.wedgeWindowFingerprint = null
          this.wedgeRepeats = 0
          this.chosenCountsAtProgress = this.lastProgress
          this.lastProgressAt = Date.now()
        }
        this.llmNotes.push(plan.note)
        if (this.llmNotes.length > 12) this.llmNotes.shift()
        this.logger.info(
          'system2',
          `LLM plan applied provider=${this.system2Provider} model=${this.system2Model}: ${added.length} goal(s) depth=${this.queue.state.depth} :: ${plan.note}`,
          {
            provider: this.system2Provider,
            model: this.system2Model,
            requestId: requestContext.requestId,
            requestContext,
            queueDepth: this.queue.state.depth,
            goals: added.map((goal) => goal.description),
            note: plan.note,
          },
          this.tickCounter,
        )
        this.llmInFlight = false
        this.requestDecision('llm_plan', { reason, goals: added.length })
      })
      .catch((error: unknown) => {
        this.llmInFlight = false
        if (!this.running) {
          this.logger.warn(
            'system2',
            'SYSTEM2_STALE_DISCARD reason=controller_stopped_error',
            { reason, requestId: requestContext.requestId, error: describeFailure(error) },
            this.tickCounter,
          )
          return
        }
        const fatal = error instanceof FatalModelError ? error : new FatalModelError('system2-plan', 1, describeFailure(error))
        failLoud(fatal, (event, detail) => this.logger.error('system2', event, { reason, ...(detail ?? {}) }, this.tickCounter), this.options.terminateOnModelFailure)
      })

    return resummon
  }

  private onObjectiveComplete(): void {
    this.queue.markProgress(this.goal.haveCount)
    this.escalations.push('goal_complete')
    this.signals.escalationRecommended = true
    const queueState = this.queue.state
    this.logger.warn(
      'system2',
      `objective complete: ${this.goal.description}; goal queue depth=${queueState.depth} current=${queueState.current?.description ?? 'none'}`,
      { queueDepth: queueState.depth, currentGoal: queueState.current?.description ?? null },
      this.tickCounter,
    )
    if (this.options.finishOnObjectiveComplete) {
      this.finish('goal-complete', true)
      return
    }
    this.summonLlm('queue_empty', 'objective complete; the queue needs its next horizon')
  }

  // -------------------------------------------------------------------------
  // escalation
  // -------------------------------------------------------------------------

  private escalate(reason: EscalationReason, detail: string): void {
    const now = Date.now()
    const last = this.lastEscalationAt.get(reason) ?? 0
    if (now - last < this.options.escalationCooldownMs) return
    this.lastEscalationAt.set(reason, now)
    this.lastEscalationMs = now
    this.escalations.push(reason)
    this.signals.escalationRecommended = true
    const summonReason = ESCALATION_TO_SUMMON[reason]
    this.logger.warn(
      'escalate',
      `-> System 2: reason=${reason} summon=${summonReason} detail=${detail}`,
      { reason, summonReason, detail },
      this.tickCounter,
    )
    this.summonLlm(summonReason, `${reason}: ${detail}`)
  }

  private recordFailure(code: FailureCode | GuardCode | string | null, detail: string): void {
    this.failureStreak += 1
    this.signals.consecutiveFailures = this.failureStreak
    this.signals.lastFailureCode = code
    this.recentEvents.push(`failure ${code ?? 'unknown'}: ${detail}`)
    this.logger.warn(
      'agent',
      `failure streak ${this.failureStreak}/${this.options.failureStreakLimit} code=${code ?? 'unknown'}`,
      { detail },
      this.tickCounter,
    )
    const boundary = shouldWakeSystem2AfterLocalFailure({
      failureCode: code,
      activeOption: this.queue.current !== null,
      semanticExhausted: false,
      semanticInvalid: false,
      semanticAbandoned: false,
    })
    const localRouteFailure = code === 'path_no_path' || code === 'path_stuck' || code === 'no_path' || code === 'no_standable_approach' || code === 'open_path'
    if (localRouteFailure && !boundary.wake && boundary.reason === 'local_recovery') {
      // A local route failure is evidence for grounded Jev/Skill recovery. It is
      // not a semantic mission boundary and must not summon System2 by itself.
      this.logger.info(
        'agent',
        `LOCAL_ROUTE_FAILURE code=${code ?? 'unknown'} system2=false detail=${detail}`,
        { code, detail, failureStreak: this.failureStreak, boundary: boundary.reason },
        this.tickCounter,
      )
    } else if (code === 'unknown_event') this.escalate('unknown_event', detail)
    else if (code === 'verify_failed') {
      this.logger.info('agent', `LOCAL_VERIFY_FAILURE system2=false detail=${detail}`, { code, detail }, this.tickCounter)
    }
    if (this.failureStreak >= this.options.failureStreakLimit && !localRouteFailure && code !== 'verify_failed') {
      this.escalate('same_failure_3x', `${code ?? 'unknown'} failed ${this.failureStreak}x: ${detail}`)
    }
  }

  /**
   * Issue #78 follow-up: bounded escalation for a typed ACTION failure that
   * repeats identically. `recordFailure` charges every typed failure, but the
   * local-recovery route failures (`path_stuck`, `path_no_path`, ...) are
   * deliberately excluded from `same_failure_3x`, and the #44/#78 replan
   * throttle only advances on suppressed replans. Nothing therefore bounded the
   * loop where the SAME plan is re-offered and its action fails the SAME way.
   *
   * Counts consecutive identical `(plan, actionId, reason)` failures. On the Nth
   * the failure is reclassified as a semantic boundary: `ACTION_FAILURE_EXHAUSTED`
   * is logged and the existing `same_failure_3x -> action_impossible` escalation
   * vocabulary is used. The pending streak is exposed through `replanInputs()`
   * so the #44 throttle cannot suppress this one wake as `no_new_info`; that
   * keeps it "exactly like #326" rather than a parallel wake path.
   *
   * The counter resets on a different plan/action/reason (in the counter), on
   * any observed progress (in `onActionComplete`), and here after the escalation
   * is handed off, so it cannot hot-loop. Failures already owned by another
   * handler (a verified/done action, a scheduled PLACE retry, or an unverified
   * postcondition handled by `onUnverifiedAction`) never reach this method.
   */
  private noteTypedActionFailure(reason: string, actionId: string, pending: PendingDecision | undefined): void {
    const planKey = pending?.record.goalQueueState.current?.id ?? this.queue.current?.id ?? this.currentGoalKey()
    const decision = this.actionFailureEscalation.noteFailure(planKey, actionId, reason)
    this.logger.warn(
      'agent',
      formatActionFailureRepeat(decision),
      {
        planId: planKey,
        actionId,
        reason,
        count: decision.count,
        limit: decision.limit,
      },
      this.tickCounter,
    )
    if (!decision.escalate) return
    this.logger.warn(
      'agent',
      formatActionFailureExhausted(decision),
      {
        planId: planKey,
        actionId,
        reason,
        count: decision.count,
        limit: decision.limit,
        boundary: 'semantic_boundary',
      },
      this.tickCounter,
    )
    // Reuse the existing escalation vocabulary. `replanInputs()` carries the
    // exhausted streak, so the throttle releases this one wake; #78's own bound
    // remains the backstop if the throttle still refuses it.
    this.escalate(
      'same_failure_3x',
      `ACTION_FAILURE_EXHAUSTED plan=${planKey} action=${actionId} reason=${reason} count=${decision.count}/${decision.limit}`,
    )
    this.actionFailureEscalation.reset()
  }

  private failureSnapshot(): Record<string, number> {
    const now = Date.now()
    const snapshot: Record<string, number> = {}
    for (const [id, count] of this.candidateFailures) {
      const age = now - (this.candidateFailureAt.get(id) ?? now)
      const decayed = decayedFailureCount(count, age)
      if (decayed > 0) snapshot[id] = decayed
    }
    return snapshot
  }

  private candidateFailureCount(candidateId: string): number {
    return failureCount(this.failureSnapshot(), candidateId)
  }

  private noteCandidateFailure(candidateId: string): void {
    const now = Date.now()
    this.candidateFailures.set(candidateId, (this.candidateFailures.get(candidateId) ?? 0) + 1)
    this.candidateFailureAt.set(candidateId, now)
    const spatial = spatialFailureKey(candidateId)
    if (spatial !== null) {
      this.candidateFailures.set(spatial, (this.candidateFailures.get(spatial) ?? 0) + 1)
      this.candidateFailureAt.set(spatial, now)
    }
    this.signals.failedCandidates = this.failureSnapshot()
  }

  private noteCandidateSuccess(candidateId: string): void {
    this.candidateFailures.delete(candidateId)
    this.candidateFailureAt.delete(candidateId)
    const spatial = spatialFailureKey(candidateId)
    if (spatial !== null) {
      this.candidateFailures.delete(spatial)
      this.candidateFailureAt.delete(spatial)
    }
    this.signals.failedCandidates = this.failureSnapshot()
  }

  /**
   * If every actionable candidate has exhausted its retries, escalate so System 2
   * gets a chance to change the approach. Failure memory is NOT cleared: it decays
   * on its own, and wiping it would let a nearby coordinate evade the spatial
   * memory that #8a introduced.
   */
  private breakFailureDeadlock(candidates: readonly Candidate[]): void {
    const actionable = candidates.filter(
      (candidate) => candidate.kind !== 'WAIT' && candidate.kind !== 'ESCALATE',
    )
    if (actionable.length === 0) return
    const allExhausted = actionable.every(
      (candidate) => this.candidateFailureCount(candidate.id) >= this.options.candidateFailureLimit,
    )
    if (!allExhausted) return
    const localRouteOnly = actionable.every(
      (candidate) => candidate.kind === 'MOVE' || candidate.kind === 'RETRIEVE' || candidate.kind === 'DESCEND' || candidate.kind === 'STEP',
    )
    if (localRouteOnly) {
      this.logger.warn(
        'agent',
        `LOCAL_CANDIDATES_EXHAUSTED count=${actionable.length} system2=false grounded_recovery=true`,
        { candidates: actionable.map((candidate) => candidate.id), limit: this.options.candidateFailureLimit },
        this.tickCounter,
      )
      return
    }
    this.escalate(
      'all_candidates_invalid',
      `all ${actionable.length} actionable candidate(s) exceeded ${this.options.candidateFailureLimit} failures; letting decay/suppression reroute instead of clearing memory`,
    )
    this.recentEvents.push('all local candidates exhausted; waiting for decay/spatial suppression to reroute')
  }

  private updateStallSignal(): void {
    // #360: re-arm the recurrence evidence when System2 replaces the active
    // Option, and refresh the snapshot beta reads this tick.
    const optionInstanceId = this.currentOptionContext()?.instanceId ?? null
    if (optionInstanceId !== this.strategicStallOptionId) {
      this.strategicStallOptionId = optionInstanceId
      this.signals.oscillationsDetected = 0
    }
    this.strategicStall.setOption(optionInstanceId)
    this.signals.strategicNonProgress = this.strategicStall.evidence()
    const stalledMs = Date.now() - this.lastProgressAt
    this.signals.stalledMs = stalledMs
    if (!this.goal.complete && stalledMs > this.options.stallMs) {
      const boundary = shouldWakeSystem2AfterLocalFailure({
        failureCode: 'path_stuck',
        activeOption: this.queue.current !== null,
        semanticExhausted: false,
        semanticInvalid: false,
        semanticAbandoned: false,
      })
      this.logger.warn(
        'agent',
        `LOCAL_PROGRESS_STALL stalledMs=${stalledMs} system2=false reason=${boundary.reason}`,
        { stalledMs, goal: this.currentGoalKey(), boundary: boundary.reason },
        this.tickCounter,
      )
    }
    if (!this.goal.complete && stalledMs > this.options.wedgeStallMs) {
      this.abortWedge(`goal progress stayed 0 for ${stalledMs}ms`)
    }
  }

  /**
   * The remembered target the ascent trap is measured against: the active
   * retrieval when one exists, else the active surface-recovery goal's own
   * `targetY`, else the highest remembered resource still above the bot. Pure
   * lookup; the trap predicate itself is `evaluateCapabilityGap`.
   *
   * The surface goal is included because the planner's capability-gap handling
   * forces exactly that goal (`buddy-driver/planner-legacy.ts`), and its
   * `targetY` is the Y the body must actually reach. Without it, a shaft with no
   * remembered upper feature had no target at all, so the trap could not fire.
   */
  private capabilityTarget(): { y: number; key: string } | null {
    const active = this.activeRetrieval
    if (active !== null) return { y: active.target.y, key: this.retrievalKey(active) }
    const entity = this.bot.entity
    if (entity === undefined) return null
    let best: KnownResource | null = null
    for (const resource of this.signals.knownResources ?? []) {
      if (resource.position.y <= entity.position.y) continue
      if (best === null || resource.position.y > best.position.y) best = resource
    }
    const current = this.queue.current
    const surfaceTargetY =
      current?.kind === 'surface' && typeof current.targetY === 'number' && Number.isFinite(current.targetY)
        ? current.targetY
        : null
    if (surfaceTargetY !== null && surfaceTargetY > entity.position.y && (best === null || surfaceTargetY > best.position.y)) {
      return { y: surfaceTargetY, key: `surface:${current?.id ?? 'surface'}:${surfaceTargetY}` }
    }
    if (best === null) return null
    return { y: best.position.y, key: `known:${best.name}@${best.position.x},${best.position.y},${best.position.z}` }
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
    const state = this.lastWorldState
    const entity = this.bot.entity
    if (state === null || entity === undefined || target === null) return false
    if (this.lastWorldStateTick !== this.tickCounter - 1) return false
    const decision = planVerticalApproachDetailed({
      selfFeetY: entity.position.y,
      selfPosition: { x: entity.position.x, y: entity.position.y, z: entity.position.z },
      target: { x: entity.position.x, y: target.y, z: entity.position.z },
      tunnel: state.signals.lastTunnel ?? null,
      descent: state.descent,
      stepCuts: state.stepCuts,
      placeable: selectPlaceableBlock(state.inventory.counts),
      columnSafe: !pillarColumnUnsafeFromBlocks(state.self.position, state.blocks),
      inventory: state.inventory.counts,
    })
    const refusal = decision.ascentRefusal
    if (decision.plan !== null || refusal === null) return false
    const line = formatAscentRefused(refusal)
    if (line !== this.lastAscentRefusalKey) {
      this.lastAscentRefusalKey = line
      this.logger.warn('agent', line, { ...refusal, goal: this.currentGoalKey() }, this.tickCounter)
    }
    return true
  }

  /**
   * P1 durability: turn the scheduler's damage observation into sensor
   * evidence. `damage_taken` carries the Mineflayer-attributed attacker, so
   * `signals.lastDamage` records *who* hit the bot (null = environmental /
   * unattributed, never an invented source). A negative `hp_changed` without a
   * fresh attributed event keeps attribution only inside the same hit burst.
   */
  private observeThreat(trigger: DecisionTrigger, detail: Record<string, unknown>): void {
    const now = Date.now()
    if (trigger === 'damage_taken') {
      const sourceId =
        typeof detail.attackerId === 'number' && Number.isFinite(detail.attackerId) ? detail.attackerId : null
      const sourceName = typeof detail.attackerName === 'string' && detail.attackerName.length > 0 ? detail.attackerName : null
      const sourcePosition = damageOrigin(detail.attackerPosition)
      this.signals.lastDamage = {
        atMs: now,
        health: this.bot.health ?? 0,
        sourceId,
        sourceName,
        // The server-stated damage ORIGIN (the scheduler reads it off the
        // `damage_event` packet, which mineflayer's `entityHurt` drops). This is
        // the fact that lets the body ground a direction to break contact with an
        // attacker it cannot see. Absent means UNKNOWN - the field is left off
        // rather than filled with a guess.
        ...(sourcePosition === null ? {} : { sourcePosition }),
      }
      return
    }
    if (trigger !== 'hp_changed') return
    const delta = typeof detail.delta === 'number' ? detail.delta : 0
    if (delta >= 0) return
    const previous = this.signals.lastDamage ?? null
    const sameBurst = previous !== null && now - previous.atMs <= 1500
    this.signals.lastDamage = {
      atMs: now,
      health: typeof detail.health === 'number' ? detail.health : this.bot.health ?? 0,
      sourceId: sameBurst ? previous.sourceId : null,
      sourceName: sameBurst ? previous.sourceName : null,
      // Attribution follows the same-burst rule as identity: a negative health
      // step inside the same hit burst keeps the origin the damage event stated,
      // and a step outside it keeps nothing (an origin without a source is not
      // an attacker).
      ...(sameBurst && previous?.sourcePosition !== undefined && previous.sourcePosition !== null
        ? { sourcePosition: previous.sourcePosition }
        : {}),
    }
  }

  /**
   * SAFE: the bounded danger STATE no other counter owns.
   *
   * `restrictCandidatesDuringImmediateThreat` is a per-tick predicate: it arms
   * while a hostile is inside `IMMEDIATE_HOSTILE_RANGE` in the CURRENT snapshot.
   * Measured live, that let the body retreat once and go straight back to
   * digging the moment the mob's snapshot moved outside it; the zombie followed,
   * landed the next hit, and health eroded 20 -> 18 -> 16 -> 2 -> death over a
   * minute (eight deaths in seven minutes, `run-mubobiq6-12onv`). This tracker
   * owns the missing state: enter on the threat predicate, stay while any
   * hostile is inside the bounded danger radius or has engaged the body, and
   * leave only after the whole envelope has been continuously clear for
   * `THREAT_CLEAR_MS`.
   *
   * The typed `THREAT_NEARBY` line is emitted on a change with the mob name,
   * distance, contact/danger flags, the code-owned weapon the body holds and
   * whether the body can regenerate at all - so a post-mortem never has to guess
   * what killed the body or what it was holding. `THREAT_CLEAR` records the
   * bounded exit.
   */
  private observeThreatState(state: WorldState): void {
    const evidence = this.threat.note({
      atMs: state.timestampMs,
      entities: state.entities,
      lastDamage: state.signals.lastDamage ?? null,
    })
    this.signals.threat = evidence
    state.signals = { ...state.signals, threat: evidence }
    const goalKey = this.currentGoalKey()
    if (!evidence.active) {
      this.lastThreatLine = null
      if (this.threatWasActive) {
        this.threatWasActive = false
        this.logger.info(
          'agent',
          formatThreatClear(goalKey, evidence),
          { clearMs: evidence.clearMs, clearForMs: evidence.clearForMs },
          this.tickCounter,
        )
      }
      return
    }
    this.threatWasActive = true
    const weapon = weaponFacts(state.self.heldItem?.name ?? null)
    const line = formatThreatNearby(goalKey, evidence, weapon, bodySurvivalFacts(state.self))
    // Bounded dedup: the line carries `activeMs`, which changes every decision,
    // so the signature drops it and keeps the facts a post-mortem needs
    // (identity, whole-metre distance, contact/danger, envelope size, weapon). A
    // mob hovering at the same distance does not re-log every tick.
    const signature = [
      evidence.threatId,
      evidence.threatName,
      evidence.inContact ? 'contact' : evidence.inDanger ? 'danger' : 'engaged',
      evidence.threatDistance === null ? 'na' : Math.round(evidence.threatDistance),
      evidence.hostileCount,
      weapon.name ?? 'fists',
    ].join('|')
    if (signature === this.lastThreatLine) return
    this.lastThreatLine = signature
    this.logger.warn(
      'agent',
      line,
      {
        threat: evidence.threatName,
        threatId: evidence.threatId,
        distance: evidence.threatDistance,
        contact: evidence.inContact,
        danger: evidence.inDanger,
        entryReason: evidence.entryReason,
        activeMs: evidence.activeMs,
        weapon: state.self.heldItem?.name ?? 'fists',
        food: state.self.food,
        health: state.self.health,
      },
      this.tickCounter,
    )
  }

  /**
   * The code-owned identity facts the bounded mob-churn rule reads
   * (`threat.ts` `MobIdentityContext`).
   *
   * `previousEntityTracked` is read from the CLIENT's tracked set (`bot.entities`),
   * never from the sensor snapshot: the sensor is a bounded radius, so "gone from
   * the snapshot" cannot be told apart from "walked 30 m away", while
   * `bot.entities[id] === undefined` means the server destroyed that exact id
   * (`entity_destroy`). An entity that is present but `isValid === false` counts as
   * gone for the same reason; anything the controller cannot resolve (no candidate
   * entity id) stays `null` = UNKNOWN, and the rule refuses.
   *
   * `knownEntityIds` is the DECISION-time snapshot, so the rule can require the
   * replacement to be an entity that appeared during the churn window instead of a
   * bystander of the same kind that was already standing there.
   */
  private mobIdentityContext(
    chosen: Candidate | null,
    decisionState: WorldState,
    freshState: WorldState,
  ): MobIdentityContext {
    const entityId = chosen?.targetEntityId ?? null
    let previousEntityTracked: boolean | null = null
    if (entityId !== null) {
      const live = this.bot.entities[entityId]
      previousEntityTracked = live !== undefined && live.isValid !== false
    }
    return {
      previousEntityTracked,
      knownEntityIds: new Set(decisionState.entities.map((entity) => entity.id)),
      chosenAtMs: decisionState.timestampMs,
      nowMs: freshState.timestampMs,
    }
  }

  /**
   * Bounded roll-up of the revalidation-guard counters.
   *
   * Measured live (`run-muc3qbug-18vg3`): 630 `chosen candidate ... vanished
   * between the Jev answer and execution` drops, five of them inside the 18 s
   * Nether death window, and the run log carried no aggregate anywhere - so a
   * post-mortem reading buddy.log could not see that the body had spent the
   * whole death window dropping every survival choice it made. Emitted on
   * doubling milestones so the total is visible without one line per drop.
   */
  private logGuardRejections(): void {
    const total = this.guardRejections + this.survivalRegrounds
    if (total < 1 || total < this.lastGuardRollupAt * 2) return
    this.lastGuardRollupAt = total
    this.logger.warn(
      'guard',
      `${GUARD_REJECTIONS} total=${total} dropped=${this.guardRejections} regrounded=${this.survivalRegrounds} ` +
        `-> chosen candidates revalidated against the fresh offer (dropped = tick ended without that action)`,
      { total, dropped: this.guardRejections, regrounded: this.survivalRegrounds },
      this.tickCounter,
    )
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
    const unanswered = unansweredRangedThreats(state.entities)
    const threat = unanswered[0] ?? null
    const sourceName = state.signals.lastDamage?.sourceName ?? null
    // The unsensed case: the attacker is named by the damage attribution and is
    // NOT in the sensor snapshot. `unsensedAttackerFacts` owns that predicate
    // (identity + recency + absence), so the marker, the offer restriction and
    // the death telemetry all read ONE fact instead of three near-copies.
    const attacker = unsensedAttackerFacts(state)
    const unsensed = threat === null && attacker !== null
    if (threat === null && !unsensed) {
      this.lastRangedThreatLine = null
      return
    }
    // What the body can still DO: the sensor builds its escape/cover cells for
    // the attributed origin too, so a non-empty escape set is a real grounded
    // destination. No cells means no direction could be grounded - which the
    // marker says explicitly instead of implying there is no threat.
    const escapeCells = state.terrain.escapeCells ?? []
    const coverCells = state.terrain.threatCoverCells ?? []
    const response = unsensedThreatResponse({
      attacker,
      groundedDestinations: attacker?.position === null ? 0 : escapeCells.length + coverCells.length,
      coverCells: coverCells.length,
      availableMoves: escapeCells.length + coverCells.length,
    })
    const line = formatThreatRangedUnanswered({
      goalKey: this.currentGoalKey(),
      threat,
      sourceName: unsensed ? (attacker?.name ?? sourceName) : null,
      body: bodySurvivalFacts(state.self),
      weapon: weaponFacts(state.self.heldItem?.name ?? null),
      attacker,
      response: attacker === null ? undefined : response,
    })
    if (line === this.lastRangedThreatLine) return
    this.lastRangedThreatLine = line
    this.logger.warn(
      'agent',
      line,
      {
        threat: threat?.name ?? attacker?.name ?? sourceName,
        distance: threat?.distance ?? null,
        sensed: threat !== null,
        standoff: threat?.standoff ?? attacker?.standoff ?? null,
        sourcePosition: attacker?.position ?? null,
        response: attacker === null ? null : response.kind,
        missing: response.missing,
        health: state.self.health,
        weapon: state.self.heldItem?.name ?? 'fists',
        source: sourceName,
      },
      this.tickCounter,
    )
    // The bounded break-contact evidence: no destination could be grounded from
    // the damage attribution, so the body's only answer is to keep moving. This
    // is the typed statement that the body is NOT idle, and exactly which facts
    // were missing to do better.
    if (attacker === null || response.grounded || response.kind !== 'break_contact') {
      this.lastBreakContactLine = null
      return
    }
    const moves = (state.terrain.escapeCells ?? []).map((cell) => `${cell.x},${cell.y},${cell.z}`)
    const breakLine = formatThreatBreakContact({
      goalKey: this.currentGoalKey(),
      attacker,
      response,
      body: bodySurvivalFacts(state.self),
      weapon: weaponFacts(state.self.heldItem?.name ?? null),
      availableMoves: moves,
    })
    if (breakLine === this.lastBreakContactLine) return
    this.lastBreakContactLine = breakLine
    this.logger.warn(
      'guard',
      breakLine,
      {
        marker: THREAT_BREAK_CONTACT,
        threat: attacker.name,
        attackerId: attacker.id,
        sourcePosition: attacker.position,
        missing: response.missing,
        response: response.kind,
        health: state.self.health,
        food: state.self.food,
      },
      this.tickCounter,
    )
  }

  /** Current CAN says the conservative proximity threat is occluded/unreachable. */
  private logThreatOccluded(offer: ThreatOffer): void {
    if (offer.occluded === null || offer.threat === null) {
      this.lastThreatOccludedLine = null
      return
    }
    const line = formatThreatOccluded(this.currentGoalKey(), offer.threat, offer.occluded.entityIds)
    if (line === this.lastThreatOccludedLine) return
    this.lastThreatOccludedLine = line
    this.logger.info(
      'agent',
      line,
      {
        marker: THREAT_OCCLUDED,
        threat: offer.threat.threatName,
        ids: offer.occluded.entityIds,
        distance: offer.threat.threatDistance,
        reason: offer.occluded.reason,
      },
      this.tickCounter,
    )
  }

  /**
   * Mirror the code-owned threat capability gap: the body is under threat and
   * the deterministic layer could ground neither an attack nor a keep-distance
   * route, so only a bounded ESCALATE is offered. This is the honest replacement
   * for the old fallback that returned the work set while a zombie was inside
   * melee reach.
   */
  private logThreatGap(state: WorldState, offer: ThreatOffer): void {
    if (offer.gap === null || offer.threat === null) {
      this.lastThreatGapLine = null
      return
    }
    const line = formatThreatNoEscape(
      this.currentGoalKey(),
      offer.threat,
      weaponFacts(state.self.heldItem?.name ?? null),
      `${offer.gap.reason}${offer.inContact ? '@contact' : '@danger'}`,
    )
    if (line === this.lastThreatGapLine) return
    this.lastThreatGapLine = line
    this.logger.warn(
      'agent',
      line,
      {
        threat: offer.threat.threatName,
        distance: offer.threat.threatDistance,
        inContact: offer.inContact,
        reason: offer.gap.reason,
      },
      this.tickCounter,
    )
  }

  /**
   * SAFE: the survival fact no other counter owns. `damage_taken` / `hp_changed`
   * carry the health step, so this records consecutive damage at critical health
   * for the ACTIVE plan; the code-owned `bodyStarving` sensor fact is fed on
   * every decision so the durable critical STARVING state arms the same counter
   * even when no damage event arrives (the measured live plateau: health 1,
   * food 0, no further `hp_changed`). Once the bounded count is exhausted it logs
   * the typed `CRITICAL_DAMAGE_EXHAUSTED` (or `BODY_STARVING` when the hunger bar
   * is empty), removes WAIT for one decision, and wakes System2 through the same
   * `escalate()` path #326/#337 use. The choice of WHAT ends the damage stays
   * with Jev; this only proves the current plan is not ending it.
   *
   * Health is de-duplicated against the controller's own last observation, not
   * `detail.previousHealth`: both triggers can be delivered for one damage event
   * (and the scheduler's coalescing keeps only `damage_taken`), so counting the
   * step itself is what makes one hit cost exactly one.
   */
  private observeCriticalDamage(trigger: DecisionTrigger, detail: Record<string, unknown>): void {
    const rawHealth = typeof detail.health === 'number' && Number.isFinite(detail.health) ? detail.health : this.bot.health
    const health = typeof rawHealth === 'number' && Number.isFinite(rawHealth) ? rawHealth : Number.NaN
    const rawFood = typeof detail.food === 'number' && Number.isFinite(detail.food) ? detail.food : this.bot.food
    const food = typeof rawFood === 'number' && Number.isFinite(rawFood) ? rawFood : null
    const planKey = `${this.currentGoalKey()}|${this.queue.current?.id ?? 'none'}`
    if (trigger === 'damage_taken' || trigger === 'hp_changed') {
      // A fresh damage observation advances the event counter exactly once per
      // health step. Only damage triggers may overwrite `lastObservedHealth`: a
      // non-damage tick that did so would erase the step before it is counted.
      const previousHealth = this.lastObservedHealth
      if (Number.isFinite(health)) this.lastObservedHealth = health
      // The environmental-hazard tracker counts the SAME observation. A real
      // negative health step is damage; a `damage_taken` event with no comparable
      // step (a respawn/hot-reload boundary) is still a hit.
      if (
        (typeof previousHealth === 'number' && Number.isFinite(previousHealth) && health < previousHealth) ||
        (trigger === 'damage_taken' && !(typeof previousHealth === 'number' && Number.isFinite(previousHealth)))
      ) {
        this.damageObservedThisTick = true
      }
      this.criticalDamage.note({
        health,
        previousHealth,
        planKey,
        food,
        // SAFE: Mineflayer's attribution wins; when there is none and the body's
        // own hazard state names a damage-dealing environmental cause, that cause
        // is the honest source (`source=fire` instead of the measured
        // `source=environment` while burning). `envHazardDamageSource` refuses to
        // attribute damage to a hazard that cannot deal it (`adjacent_lava`
        // alone).
        sourceName: this.signals.lastDamage?.sourceName ?? this.envHazardAttribution(),
      })
    }
    // SAFE: the critical STARVING state is a durable sensor fact, not an event.
    // On this server starvation damage floors at 1 HP, so the measured live body
    // (health 1, food 0, no food item, no `hp_changed` for a whole generation)
    // never armed the event counter and idled with no escalation. Feeding the
    // state fact on every decision - not only on a damage trigger - lets the same
    // bounded boundary fire; a grounded food route that actually ends the
    // starvation clears the fact and resets the count on the next decision.
    const starving = food !== null && bodyStarving({ food, health })
    const evidence = this.criticalDamage.noteStarving({ planKey, health, food, starving })
    this.signals.criticalDamage = evidence
    const goalKey = this.currentGoalKey()
    if (!evidence.active) {
      this.lastCriticalDamageLine = null
      return
    }
    const entity = this.bot.entity
    const at = entity === undefined ? { x: 0, y: 0, z: 0 } : entity.position
    const line =
      evidence.food !== null && bodyStarving({ food: evidence.food, health: evidence.health })
        ? formatBodyStarving({ food: evidence.food, health: evidence.health }, at)
        : formatCriticalDamageEvidence(goalKey, evidence)
    if (line !== this.lastCriticalDamageLine) {
      this.lastCriticalDamageLine = line
      this.logger.warn(
        'agent',
        line,
        {
          health: evidence.health,
          food: evidence.food,
          source: evidence.sourceName,
          damage: evidence.consecutiveDamage,
          limit: evidence.limit,
        },
        this.tickCounter,
      )
    }
    if (!evidence.exhausted) return
    this.logger.warn(
      'agent',
      formatCriticalDamageExhausted(goalKey, evidence),
      {
        health: evidence.health,
        food: evidence.food,
        source: evidence.sourceName,
        damage: evidence.consecutiveDamage,
        limit: evidence.limit,
        boundary: 'semantic_boundary',
      },
      this.tickCounter,
    )
    // Consume the evidence (the next boundary needs a longer run on the same
    // plan) and force the next decision to pick a real candidate, so the body
    // cannot settle into an unbounded WAIT while it keeps losing health.
    this.signals.criticalDamage = this.criticalDamage.acknowledgeEscalation()
    this.lastCriticalDamageLine = null
    this.waitSuppressed = true
    this.escalate(
      'progress_stall',
      `CRITICAL_DAMAGE_EXHAUSTED goal=${goalKey} health=${evidence.health} food=${evidence.food ?? 'unknown'} damage=${evidence.consecutiveDamage}/${evidence.limit} source=${evidence.sourceName ?? 'environment'}`,
    )
  }

  /**
   * SAFE (issue #436 §8/§17): the hard-safety reflex telemetry.
   *
   * Three lines, all emitted only after the guard accepted the candidate so a
   * line can never claim an action the mechanical checks refused:
   *
   *   SKILL_STEP ... authority=HARD_SAFETY_REFLEX budget=1
   *     the §17 layer: this step was an immediate safety stabilisation, not a
   *     mechanical continuation of the selected Skill;
   *   REFLEX ownerSkill=<the interrupted skill> reason=hard_safety action=<what>
   *     evidence=<the block/flag that proved it>
   *     the §8 proof: code was allowed to finish exactly this action;
   *   SKILL_INTERRUPT + SKILL_POLICY_BOUNDARY skill=... reason=hard_safety_interrupt
   *     alternatives=[...]
   *     the boundary: the in-flight Skill was preempted and the decision returns
   *     to the semantic controller with the other grounded routes exposed.
   *
   * The REFLEX line is de-duplicated by its own facts so a persistent hazard
   * does not re-log every tick.
   */
  private logReflex(
    reflex: EnvHazardReflex,
    state: WorldState,
    inFlight: InFlightAction | null,
    alternatives: readonly string[],
  ): void {
    const interruptReason: SkillPolicyBoundaryReason = 'hard_safety_interrupt'
    const evidence = formatEnvHazardReflexEvidence(this.envHazard.evidence())
    const ownerSkill = inFlight?.id ?? state.currentOption?.templateId ?? this.currentGoalKey()
    const line = formatReflex({
      ownerSkill,
      reason: 'hard_safety',
      action: reflex.candidate.id,
      evidence,
    })
    if (line !== this.lastReflexLine) {
      this.lastReflexLine = line
      this.logger.warn(
        'policy',
        line,
        {
          ownerSkill,
          reason: 'hard_safety',
          action: reflex.candidate.id,
          kind: reflex.kind,
          escapeKind: reflex.escapeKind,
          evidence,
          goal: this.currentGoalKey(),
        },
        this.tickCounter,
      )
    }
    this.logger.warn(
      'policy',
      formatSkillStep(
        ownerSkill,
        'env_hazard_stabilize',
        formatSkillStepAuthority('HARD_SAFETY_REFLEX', evidence, 'stabilize_one_step', { budget: 1 }),
      ),
      {
        ownerSkill,
        authority: 'HARD_SAFETY_REFLEX',
        stepKind: 'env_hazard_stabilize',
        budget: 1,
        action: reflex.candidate.id,
        kind: reflex.kind,
        target: reflex.candidate.target,
      },
      this.tickCounter,
    )
    if (inFlight === null) return
    this.logger.warn(
      'policy',
      `${formatSkillInterrupt(inFlight.id, reflex.kind)} -> kind=${inFlight.kind} reflex=${reflex.candidate.id}`,
      {
        reason: reflex.kind,
        interrupted: inFlight.id,
        interruptedKind: inFlight.kind,
        reflex: reflex.candidate.id,
      },
      this.tickCounter,
    )
    // §8: the reflex may preempt, but the decision then returns to the semantic
    // controller - which the boundary line records with the remaining grounded
    // routes exposed.
    this.logger.warn(
      'policy',
      formatSkillPolicyBoundary({
        skill: inFlight.id,
        reason: interruptReason,
        alternatives,
      }),
      { skill: inFlight.id, reason: 'hard_safety_interrupt', alternatives, authority: 'HARD_SAFETY_REFLEX' },
      this.tickCounter,
    )
  }

  /**
   * SAFE (issue #436 §8/§17): the boundary where code must NOT take over.
   *
   * The body is in an environmental hazard with an in-flight Skill, and the exit
   * is not a unique immediate stabilisation - either several grounded routes
   * exist (Jev's WHICH) or none does (the typed `ENV_HAZARD_NO_EXIT` gap). This
   * line names that boundary and exposes the grounded alternatives so a reviewer
   * can see that code returned the decision instead of picking a destination.
   */
  private logEnvHazardBoundary(
    state: WorldState,
    candidates: readonly Candidate[],
    inFlight: InFlightAction | null,
  ): void {
    const hazard = state.self.envHazard ?? null
    if (hazard?.active !== true || hazard.escapeRequired !== true || inFlight === null) return
    const routes = envHazardEscapeRoutes(state, candidates)
    const reason: SkillPolicyBoundaryReason =
      routes.length === 0 ? 'no_grounded_escape' : 'multiple_grounded_escapes'
    const line = formatSkillPolicyBoundary({
      skill: inFlight.id,
      reason,
      alternatives: routes.map((route) => route.id),
    })
    if (line === this.lastEnvBoundaryLine) return
    this.lastEnvBoundaryLine = line
    this.logger.warn(
      'policy',
      line,
      {
        skill: inFlight.id,
        reason,
        alternatives: routes.map((route) => route.id),
        kind: hazard.kinds.join('+'),
      },
      this.tickCounter,
    )
  }

  /**
   * The synthetic decision a hard-safety reflex carries: the SAME downstream
   * pipeline (decision record, guard, executor claim) with an explicit
   * provenance that is neither Jev nor the deterministic fallback, and NO model
   * call. `answers.action` is the one authoritative choice the executor reads.
   */
  private reflexDecision(candidate: Candidate): JevResult {
    return {
      callId: `reflex:${randomUUID()}`,
      policy: 'reflex',
      source: 'reflex',
      model: 'hard_safety_reflex',
      latencyMs: 0,
      usage: null,
      answers: {
        action: {
          name: 'action',
          type: 'choice',
          value: candidate.id,
          probability: 1,
          confidence: 1,
          probabilities: null,
          legend: null,
          note: 'uniquely-determined hard-safety reflex (issue #436 section B)',
        },
      },
    }
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
    const evidence = this.envHazard.evidence()
    if (!evidence.active) return null
    return envHazardDamageSource(evidence.kinds)
  }

  /**
   * SAFE: the body's own environmental-hazard telemetry (fire / lava / burning /
   * drowning).
   *
   * Measured live (`run-mucaq28q-1ftq1`, main 99f0020): the body burned to death
   * in the Nether, every tick arrived as `source=environment`, and a scan of the
   * whole run found FIRE 0 | LAVA 0 | HAZARD_FIRE 0 | IN_FIRE 0 | BURN 0 - the
   * system had NO state for it. This mirrors the sensed fact as `ENV_HAZARD`
   * (with the exits the world actually grounds), the typed CAN gap
   * `ENV_HAZARD_NO_EXIT` when it grounds none, and `ENV_HAZARD_CLEAR` when the
   * body gets out. It never invents a route and never ranks one: the exits are
   * ordinary candidates and the choice among them stays Jev's
   * (`envHazardReflexAction` fires only when exactly one is grounded).
   */
  private observeEnvHazard(state: WorldState): void {
    const hazard = state.self.envHazard ?? null
    const evidence = this.envHazard.note({
      atMs: state.timestampMs,
      hazard,
      damageObserved: this.damageObservedThisTick,
    })
    this.damageObservedThisTick = false
    const goalKey = this.currentGoalKey()
    if (evidence.active) {
      const escapes = envHazardEscapeSpots(state, this.blacklistedMoveTargets(state))
      const line = formatEnvHazard(goalKey, evidence, escapes)
      if (line !== this.lastEnvHazardLine) {
        this.lastEnvHazardLine = line
        this.logger.warn(
          'agent',
          line,
          {
            kind: evidence.kinds.join('+'),
            cell: evidence.cell,
            block: evidence.block,
            damage: evidence.damage,
            activeMs: evidence.activeMs,
            onFire: evidence.onFire,
            headWet: evidence.headInWater,
            airAbove: evidence.airAbove,
            exits: escapes.length,
            waterExit: escapes.some((escape) => escape.water),
          },
          this.tickCounter,
        )
      }
      if (evidence.escapeRequired && escapes.length === 0) {
        const gap = formatEnvHazardNoExit(goalKey, evidence, state.envHazardCells?.length ?? 0)
        if (gap !== this.lastEnvHazardGapLine) {
          this.lastEnvHazardGapLine = gap
          this.logger.warn(
            'agent',
            gap,
            { kind: evidence.kinds.join('+'), cell: evidence.cell, reason: 'no_safe_adjacent_cell' },
            this.tickCounter,
          )
        }
      } else {
        this.lastEnvHazardGapLine = null
      }
      return
    }
    this.lastEnvHazardLine = null
    this.lastEnvHazardGapLine = null
    const cleared = this.envHazard.takeCleared()
    if (cleared !== null) {
      this.logger.info(
        'agent',
        formatEnvHazardClear(cleared),
        {
          lastKind: cleared.kinds.join('+'),
          lastCell: cleared.cell,
          lastBlock: cleared.block,
          damage: cleared.damage,
          activeMs: cleared.activeMs,
        },
        this.tickCounter,
      )
    }
  }

  /**
   * Health events are authoritative when delivered. A direct per-tick sample is
   * the fail-safe for hot-reload/respawn windows where Mineflayer changes
   * `bot.health` but the scheduler event is not observed by this generation.
   * The pure transition helper prevents an initial seed or an unchanged sample
   * from inventing damage; only a real delta enters the existing tracker.
   */
  private sampleHealthFallback(): void {
    const health = this.bot.health
    const transition = sampleHealthTransition(this.lastObservedHealth, health)
    if (this.lastObservedHealth === null && Number.isFinite(health)) {
      this.lastObservedHealth = health
    }
    if (!transition.observe) return
    this.observeCriticalDamage('hp_changed', {
      health,
      previousHealth: transition.previousHealth,
      food: this.bot.food,
      delta: transition.delta,
    })
  }

  /**
   * M2 capability trap observable. The deterministic predicate decides; this
   * method only feeds it the live y / target / refusal flag and reacts with the
   * `CAPABILITY_GAP` marker plus a strategic replan. It is not a movement
   * heuristic and it never claims success.
   */
  private observeCapabilityGap(): void {
    const entity = this.bot.entity
    if (entity === undefined) return
    const target = this.capabilityTarget()
    // A refused ascent is either an executed pillar that did not verify (the
    // executor path) OR the pure plan layer proving there is no grounded up
    // plan at all. The second is what the measured `recover_vertical_access`
    // y>=80 stretch hit: no pillar was ever offered, so no executed refusal was
    // ever recorded and the trap never fired while the body paced between two
    // cells. Both are deterministic facts, so both feed the same predicate.
    const planRefused = this.ascentRefusedByPlan(target)
    const decision = evaluateCapabilityGap(this.capabilityGapState, {
      y: entity.position.y,
      targetY: target === null ? null : target.y,
      targetKey: target === null ? null : target.key,
      ascendRefused: this.ascendRefusedSinceObservation || planRefused,
    })
    this.capabilityGapState = decision.state
    this.ascendRefusedSinceObservation = false
    if (!decision.gap) {
      if (this.capabilityGapActive) {
        this.capabilityGapActive = false
        this.capabilityGapSignature = null
        this.logger.info(
          'agent',
          `CAPABILITY_GAP_CLEARED target_y=${Math.round(decision.targetY ?? 0)}`,
          { targetY: decision.targetY },
          this.tickCounter,
        )
      }
      return
    }
    const marker = formatCapabilityGap(decision)
    if (!this.capabilityGapActive) {
      this.capabilityGapActive = true
      this.capabilityGapSignature = `ascend_blocked:${Math.round(decision.targetY ?? 0)}`
      this.logger.warn(
        'agent',
        marker,
        { attempts: decision.attempts, targetY: decision.targetY, reason: decision.reason },
        this.tickCounter,
      )
      this.logger.warn(
        'agent',
        formatCapabilityGapPolicy(decision),
        { ...decision.heuristic, attempts: decision.attempts, targetY: decision.targetY },
        this.tickCounter,
      )
    }
    this.ensureCapabilityGapSignal(marker)
    const boundary = shouldWakeSystem2AfterLocalFailure({
      failureCode: 'path_stuck',
      activeOption: this.queue.current !== null,
      semanticExhausted: false,
      semanticInvalid: false,
      semanticAbandoned: false,
    })
    this.logger.warn(
      'agent',
      `LOCAL_CAPABILITY_GAP target_y=${Math.round(decision.targetY ?? 0)} attempts=${decision.attempts} system2=false reason=${boundary.reason}`,
      { attempts: decision.attempts, targetY: decision.targetY, boundary: boundary.reason },
      this.tickCounter,
    )
  }

  /** Keep the gap marker the newest recent event so the planner sees it. */
  private ensureCapabilityGapSignal(marker: string): void {
    const last = this.recentEvents[this.recentEvents.length - 1]
    if (last === marker) return
    this.recentEvents.push(marker)
  }

  /** A pillar ascent attempt that did not verify is a refused ascend. */
  private noteAscendOutcome(result: ExecutionResult, candidate: Candidate): void {
    if (candidate.meta.vertical !== 'pillar') return
    if (result.status === 'done' && result.verified) return
    this.ascendRefusedSinceObservation = true
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
    const active = this.activeRetrieval
    const entity = this.bot.entity
    if (active === null || entity === undefined) {
      this.retrievalTrack = null
      return
    }
    if (this.goal.complete || this.unreachableResources.has(this.retrievalKey(active))) {
      this.activeRetrieval = null
      this.retrievalTrack = null
      return
    }
    const current = Math.hypot(
      entity.position.x - active.target.x,
      entity.position.y - active.target.y,
      entity.position.z - active.target.z,
    )
    const verticalGap = Math.abs(entity.position.y - active.target.y)
    if (this.retrievalTrack === null || this.retrievalTrack.id !== active.id) {
      this.retrievalTrack = { id: active.id, best: current, ticks: 0, bestGap: verticalGap }
      return
    }
    const previousBestGap = this.retrievalTrack.bestGap
    const decision = evaluateRetrievalProgress({
      previous: {
        best: this.retrievalTrack.best,
        ticks: this.retrievalTrack.ticks,
        bestGap: previousBestGap,
      },
      distance: current,
      verticalGap,
      verticalEpsilon: ASCENT_PROGRESS_EPSILON,
      epsilon: RETRIEVAL_PROGRESS_EPSILON,
      stallTicks: RETRIEVAL_STALL_TICKS,
    })
    this.retrievalTrack.best = decision.best
    this.retrievalTrack.ticks = decision.ticks
    this.retrievalTrack.bestGap = decision.bestGap
    // Altitude gain is real progress for the whole run too: a 56-block climb
    // does not move the goal inventory, so without this the wedge clock would
    // keep aging while the bot is demonstrably ascending.
    const altitudeImproved =
      decision.outcome === 'progress' &&
      previousBestGap !== undefined &&
      verticalGap <= previousBestGap - ASCENT_PROGRESS_EPSILON
    if (altitudeImproved) this.lastProgressAt = Date.now()
    if (decision.outcome === 'stalled') this.onRetrievalStall(active, current)
  }

  private retrievalKey(active: { knownName: string; target: Vec3Json }): string {
    return resourceKey({ name: active.knownName, position: active.target })
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
    const current = this.queue.current
    const entity = this.bot.entity
    if (current === null || current.kind !== 'descend' || typeof current.targetY !== 'number' || entity === undefined) {
      this.resetDescendTracking()
      return
    }
    const targetY: number = current.targetY
    const y = entity.position.y
    const goalKey = `${current.id}:${targetY}`
    if (this.descendGoalKey !== goalKey) {
      this.descendGoalKey = goalKey
      this.descendProgress = { bestY: y, ticks: 0 }
      this.descendStallTicks = 0
      this.descendProgressTicks = 0
    }
    const previous = this.descendProgress ?? { bestY: y, ticks: 0 }
    const decision = evaluateDescendProgress({ previous, y, stallTicks: DESCEND_STALL_TICKS })
    this.descendProgress = { bestY: decision.bestY, ticks: decision.ticks }
    const delta = Math.round((decision.bestY - y) * 10) / 10
    if (decision.outcome === 'progress') {
      this.descendProgressTicks = 0
      this.descendStallTicks = 0
      this.logger.info(
        'agent',
        formatDescendProgress(Math.floor(y), targetY, delta, 0),
        { y, targetY, delta, outcome: decision.outcome },
        this.tickCounter,
      )
      return
    }
    const hasDescendCandidate = candidates.some((candidate) => candidate.kind === 'DESCEND')
    this.descendStallTicks = hasDescendCandidate ? 0 : this.descendStallTicks + 1
    this.descendProgressTicks += 1
    if (this.descendProgressTicks % DESCEND_PROGRESS_LOG_TICKS === 0) {
      this.logger.info(
        'agent',
        formatDescendProgress(Math.floor(y), targetY, delta, this.descendStallTicks),
        { y, targetY, delta, hasDescendCandidate, stallTicks: this.descendStallTicks },
        this.tickCounter,
      )
    }
    const noCandidateStalled = this.descendStallTicks >= DESCEND_NO_CANDIDATE_TICKS
    if (!noCandidateStalled && decision.outcome !== 'stalled') return
    const stallTicks = noCandidateStalled ? this.descendStallTicks : DESCEND_STALL_TICKS
    this.logger.warn(
      'agent',
      formatDescendStalled(Math.floor(y), targetY, stallTicks),
      { y, targetY, stallTicks, hasDescendCandidate },
      this.tickCounter,
    )
    // Strategy switch: forget the latched descent budget and chosen direction so
    // the next tick can pick a different column/step. This is local mechanical
    // recovery; a stalled actuator is not a semantic Option boundary.
    this.digMemory.markResourceProgress()
    this.descendProgress = { bestY: y, ticks: 0 }
    this.descendStallTicks = 0
    this.logger.warn(
      'agent',
      `LOCAL_DESCEND_STALL goal=${current.id} y=${Math.floor(y)} target_y=${targetY} ticks=${stallTicks} system2=false`,
      { goal: current.id, y, targetY, stallTicks, boundary: 'local_recovery' },
      this.tickCounter,
    )
  }

  private resetDescendTracking(): void {
    this.descendProgress = null
    this.descendStallTicks = 0
    this.descendProgressTicks = 0
    this.descendGoalKey = null
  }

  private retrievalTargetExists(): boolean {
    const active = this.activeRetrieval
    if (active === null) return false
    return (this.options.knownResources ?? []).some(
      (resource) =>
        resource.name === active.knownName &&
        resource.position.x === active.target.x &&
        resource.position.y === active.target.y &&
        resource.position.z === active.target.z,
    )
  }

  private onRetrievalStall(
    active: { id: string; resource: string; knownName: string; target: Vec3Json },
    current: number,
  ): void {
    const ticks = RETRIEVAL_STALL_TICKS
    this.logger.warn(
      'agent',
      formatRetrieveStalled(active.target, Math.round(current), ticks),
      { target: active.target, dist: Math.round(current), ticks },
      this.tickCounter,
    )
    // Issue #58: a stalled furnace-station retrieval is not an unreachable
    // resource to give up on - it is one prereq path losing to another. Switch
    // to the next scored path (place held / craft) and keep the parent smelt.
    if (active.resource === 'furnace' && this.prereqPlan !== null) {
      const next = nextPrereqPath(this.prereqPlan, 'use_known_station')
      if (next !== null) {
        this.logger.warn(
          'agent',
          formatPrereqSwitch('use_known_station', next),
          { from: 'use_known_station', to: next, stallTicks: ticks, goal: this.currentGoalKey() },
          this.tickCounter,
        )
        this.prereqForcedPath = next
        this.prereqProgress = null
        this.prereqLoggedKey = null
        this.noteCandidateFailure(active.id)
        this.digMemory.markResourceProgress()
        this.activeRetrieval = null
        this.retrievalTrack = null
        return
      }
    }
    this.dropUnreachableResource(active, current)
    this.noteCandidateFailure(active.id)
    this.digMemory.markResourceProgress()
    this.activeRetrieval = null
    this.retrievalTrack = null
    this.retrievalEscalationPending = true
    this.logger.warn(
      'agent',
      `LOCAL_RETRIEVAL_STALL target=${active.target.x},${active.target.y},${active.target.z} dist=${Math.round(current)} ticks=${ticks} system2=false`,
      { target: active.target, dist: Math.round(current), ticks, boundary: 'local_recovery' },
      this.tickCounter,
    )
  }

  private dropUnreachableResource(
    active: { resource: string; knownName: string; target: Vec3Json },
    current: number,
  ): void {
    const key = this.retrievalKey(active)
    if (this.unreachableResources.has(key)) return
    this.unreachableResources.add(key)
    this.logger.warn(
      'agent',
      formatKnownResourceUnreachable(active.resource, active.knownName, active.target),
      { item: active.resource, name: active.knownName, at: active.target, dist: Math.round(current) },
      this.tickCounter,
    )
    const entity = this.bot.entity
    const escalation = planRetrievalEscalation({
      failedName: active.knownName,
      failedTarget: active.target,
      known: this.options.knownResources ?? [],
      self:
        entity === undefined
          ? { x: 0, y: 0, z: 0 }
          : { x: entity.position.x, y: entity.position.y, z: entity.position.z },
    })
    this.logger.info(
      'agent',
      escalation.kind === 'switch-resource'
        ? `RETRIEVAL_ESCALATION kind=switch-resource name=${escalation.name} at=${escalation.position.x},${escalation.position.y},${escalation.position.z}`
        : `RETRIEVAL_ESCALATION kind=branch-mine y=${escalation.y}`,
      { escalation },
      this.tickCounter,
    )
  }

  /**
   * A known-resource RETRIEVE that did NOT complete (no arrival, no acquired
   * item) charges a per-resource counter. After KNOWN_RETRIEVE_RETIRE_LIMIT the
   * resource is dropped as unreachable and removed from `signals.knownResources`,
   * so the generator stops re-offering the same present-but-unreachable cell and
   * the plan advances to the next resource or the branch-mine route instead of
   * looping forever. `decideKnownRetrieve` owns the boundary; the executor's
   * lenient `verified` flag is deliberately not trusted (a sub-metre nudge and a
   * partial 20 m approach both satisfy it - the live iron-ore and RC8 loops).
   */
  private retireFailedKnownRetrieve(candidate: Candidate, result: ExecutionResult): void {
    if (candidate.meta.retrieval !== 'known' || candidate.target === null) return
    const knownName =
      typeof candidate.meta.knownName === 'string' ? candidate.meta.knownName : candidate.targetName ?? 'resource'
    const key = resourceKey({ name: knownName, position: candidate.target })
    const decision = decideKnownRetrieve({
      retrieval: candidate.meta.retrieval,
      target: candidate.target,
      result,
      previousAttempts: this.knownRetrieveFailures.get(key) ?? 0,
      completed: this.retrieveCompleted(candidate, result),
    })
    if (decision.kind === 'ignore') return
    if (decision.kind === 'clear') {
      this.knownRetrieveFailures.delete(key)
      return
    }
    this.knownRetrieveFailures.set(key, decision.attempts)
    if (decision.kind === 'charge') return
    // The retire boundary is about reachability, not truth: the cell was never
    // disproved, so it is dropped (bounded) rather than falsified. The typed
    // marker keeps the two apart in the run log.
    this.logger.warn(
      'agent',
      formatKnownResourceRetired(
        typeof candidate.meta.resource === 'string' ? candidate.meta.resource : knownName,
        candidate.target,
        decision.attempts,
      ),
      { item: candidate.meta.resource ?? knownName, cell: candidate.target, attempts: decision.attempts, limit: KNOWN_RETRIEVE_RETIRE_LIMIT },
      this.tickCounter,
    )
    this.dropUnreachableResource(
      {
        resource: typeof candidate.meta.resource === 'string' ? candidate.meta.resource : knownName,
        knownName,
        target: candidate.target,
      },
      this.retrievalDistance(candidate.target) ?? 0,
    )
    this.activeRetrieval = null
    this.retrievalTrack = null
  }

  /**
   * The postcondition layer owns the verdict (`isZeroProgressOutcome` is a
   * FAILURE). This owns what happens NEXT for the route families whose
   * postcondition is a world change (RETRIEVE/DESCEND/STEP/ENTER_PORTAL):
   *
   *   - a completed action clears the zero-progress memory at its stand cell
   *     (and for its target), so a transient blockage is never permanent;
   *   - a route candidate that settled FAILED at any executor stage - the path
   *     stage (`PATH_CALLBACK phase=failed outcome=noPath|stuck`) included - is
   *     recorded as the exact route (kind, target, stand cell, route signature)
   *     that just proved it cannot complete, even when the lease also produced
   *     lenient body progress. The candidate layer withholds that exact repeat,
   *     so the next attempt for the target must differ in a grounded way (a
   *     different vertical plan, a different stand cell, or a travel/approach
   *     leg);
   *   - `ZERO_PROGRESS_STAND_ROUTE_LIMIT` distinct zero-progress routes at one
   *     stand cell exhaust that family there (`DESCEND_RETIRED`), which forces a
   *     route change instead of sampling new cells from the same blocked body
   *     position;
   *   - every route fact is mirrored as the typed `ROUTE_STAGE_FAILED` /
   *     `ROUTE_SPENT` marker, and a route arm that can ground no alternative at
   *     all reports `ROUTE_ESCALATE ... reason=all_routes_spent` (see
   *     `noteRouteExhaustion`), so the resident log can never again show an
   *     unchanged failing route being re-offered with no typed cause.
   *
   * Live evidence (run-muc3qbug-18vg3): 82 zero-observable chains in ten minutes,
   * 75 of them `DESCEND:down:<dir>:b...` steps whose dig removed nothing
   * (`outcome=noPath|stuck`), each with a fresh candidate id but the SAME body
   * cell - a per-id failure memory can never see that as one failure.
   *
   * Live evidence (run-muc620xb-1d312): the route memory DID record
   * `ACTION_ZERO_PROGRESS ... kind=ENTER_PORTAL retry=1..20 stand=10,54,25` with
   * an UNCHANGED signature, but nothing consumed it for the entry arm, so
   * `ENTER:26,67,9` was re-offered 669 times. The typed markers above make the
   * next measurement of this shape unambiguous.
   */
  private recordZeroProgressOutcome(
    result: ExecutionResult,
    candidate: Candidate,
    truthful: ReturnType<typeof truthfulActionOutcome>,
  ): void {
    if (!isZeroProgressRouteKind(result.kind)) return
    const stand = this.actionStart
    if (stand === null) return
    const standKey = cellKey(stand)
    const targetKey = candidate.target === null ? null : cellKey(candidate.target)
    if (truthful.verified) {
      const clearedStand = clearZeroProgressStand(this.zeroProgressRoutes, result.kind, standKey)
      const clearedTarget =
        targetKey === null ? clearedStand : clearZeroProgressTarget(clearedStand, result.kind, targetKey)
      if (clearedTarget !== this.zeroProgressRoutes) {
        this.zeroProgressRoutes = clearedTarget
        this.signals.zeroProgressRoutes = clearedTarget
      }
      return
    }
    if (candidate.target === null) return
    // A route candidate that settled FAILED at an executor stage is a spent
    // route for its exact identity even when the lenient body-progress signal
    // rode along with it: `PATH_CALLBACK phase=failed outcome=noPath|stuck`
    // settles `failed`, but a lease that also nudged the body carries
    // `progressed=true`, and that must not make the same route re-offerable from
    // the same stand cell. A body that really moved stands in a different cell,
    // which is a different identity and a fresh attempt.
    const stage = result.status === 'failed' ? routeFailureStage(result.failure) : null
    if (stage === null) {
      if (!isZeroProgressOutcome(result)) return
    }
    const decision = observeZeroProgressRoute(this.zeroProgressRoutes, {
      kind: result.kind,
      targetKey: cellKey(candidate.target),
      standKey,
      routeSig: routeSignature({ kind: candidate.kind, id: candidate.id, meta: candidate.meta }),
      reason: result.failure ?? result.status,
      nowMs: Date.now(),
    })
    this.zeroProgressRoutes = decision.routes
    this.signals.zeroProgressRoutes = decision.routes
    if (stage !== null) {
      // The typed stage fact: WHERE the route broke, so a path-stage failure is
      // never again only a `PATH_CALLBACK` line with an unchanged offer.
      this.logger.warn(
        'agent',
        formatRouteStageFailed({
          kind: result.kind,
          target: candidate.target,
          stand,
          stage,
          failure: result.failure,
        }),
        { actionId: result.actionId, kind: result.kind, target: candidate.target, stand, stage, failure: result.failure },
        this.tickCounter,
      )
    }
    if (decision.routeSpentNow) {
      this.logger.warn(
        'agent',
        formatRouteSpent(result.kind, candidate.target, decision.attempts),
        {
          actionId: result.actionId,
          kind: result.kind,
          target: candidate.target,
          attempts: decision.attempts,
          routeSig: decision.entry.routeSig,
        },
        this.tickCounter,
      )
    }
    this.logger.warn(
      'agent',
      formatActionZeroProgress({
        action: result.actionId,
        target: candidate.target,
        kind: result.kind,
        retry: decision.attempts,
        routeChanged: decision.routeChanged,
        stand,
      }),
      {
        actionId: result.actionId,
        kind: result.kind,
        target: candidate.target,
        stand,
        retry: decision.attempts,
        routeChanged: decision.routeChanged,
        routeSig: decision.entry.routeSig,
      },
      this.tickCounter,
    )
    if (result.kind === 'DESCEND' && decision.familyExhausted) {
      this.logger.warn(
        'agent',
        formatDescendRetired('zero_progress_exhausted', stand, decision.familyAttempts),
        { stand, routes: decision.familyAttempts, limit: ZERO_PROGRESS_STAND_ROUTE_LIMIT },
        this.tickCounter,
      )
    }
    if (result.kind === 'RETRIEVE') {
      if (decision.attempts >= KNOWN_RETRIEVE_RETIRE_LIMIT) {
        this.logger.warn(
          'agent',
          formatRetrieveRetired('zero_progress_budget', candidate.target, decision.attempts),
          { target: candidate.target, attempts: decision.attempts, limit: KNOWN_RETRIEVE_RETIRE_LIMIT },
          this.tickCounter,
        )
      }
      if (candidate.meta.retrieval === 'known') {
        // This exact route is now withheld from this stand cell: re-offering it
        // would be the same action with unchanged preconditions.
        this.logger.warn(
          'agent',
          formatRetrieveRouteBlocked('zero_progress_route_unchanged', candidate.target, stand),
          { target: candidate.target, stand, retry: decision.attempts },
          this.tickCounter,
        )
      }
    }
  }

  private checkWedge(actionId: string): void {
    const waitPath = actionId === 'WAIT' && !this.options.singleShotPlanner
    const limit = waitPath ? this.options.waitLimit : this.options.wedgeRepeatLimit
    const progressed = this.lastProgress > this.chosenCountsAtProgress
    if (progressed) this.chosenCountsAtProgress = this.lastProgress
    const previousRepeats = this.wedgeRepeats
    const verdict = evaluateWedgeRepeat({
      actionId,
      previousActionId: this.wedgeWindowId,
      fingerprint: this.lastStateFingerprint,
      previousFingerprint: this.wedgeWindowFingerprint,
      inFlight: this.inFlight() !== null,
      progressed,
      repeats: previousRepeats,
    })
    this.wedgeWindowId = actionId
    this.wedgeWindowFingerprint = this.lastStateFingerprint
    this.wedgeRepeats = verdict.repeats
    if (verdict.outcome === 'suppress') {
      if (previousRepeats >= limit) this.logWedgeSuppressed(verdict.reason ?? 'progressing', actionId, previousRepeats)
      if (waitPath) {
        this.waitStreak = 0
        this.waitGoalKey = this.currentGoalKey()
      }
      return
    }
    if (waitPath) {
      this.checkWaitWedge()
      return
    }
    const count = this.wedgeRepeats
    if (count <= this.options.wedgeRepeatLimit) return
    // Issue #58: a protected furnace prerequisite is owned by the prereq path
    // controller (which switches path after PREREQ_STALL_TICKS). Aborting here
    // would abandon the parent smelt goal, so never wedge-abort it.
    if (this.prereqPlan !== null && isFurnacePrerequisiteOption(actionId)) return
    this.abortWedge(formatWedgeAbort(actionId, count, this.options.wedgeRepeatLimit))
  }

  private logWedgeSuppressed(reason: WedgeSuppressReason, candidate: string, repeats: number): void {
    this.logger.warn(
      'agent',
      formatWedgeSuppressed(reason, candidate, repeats),
      { reason, candidate, repeats },
      this.tickCounter,
    )
  }

  private checkWaitWedge(): void {
    const actionId = 'WAIT'
    const goalKey = this.currentGoalKey()
    const wait = evaluateWaitWedge({
      actionId,
      goalKey,
      previousGoalKey: this.waitGoalKey,
      streak: this.waitStreak,
      waitLimit: this.options.waitLimit,
      replans: this.waitReplans,
      replanLimit: WAIT_REPLAN_LIMIT,
    })
    this.waitStreak = wait.streak
    this.waitGoalKey = wait.goalKey
    if (wait.outcome === 'below-limit') return
    if (wait.outcome === 'replan') {
      const boundary = shouldWakeSystem2AfterLocalFailure({
        failureCode: 'path_stuck',
        activeOption: this.queue.current !== null,
        semanticExhausted: false,
        semanticInvalid: false,
        semanticAbandoned: false,
      })
      // WAIT is a control outcome, not evidence that the current semantic
      // Option should be replaced. Keep the local recovery loop bounded by
      // candidate/state changes; a repeated WAIT cannot itself summon WHAT.
      const summon = boundary.wake
        ? this.summonLlm(
            'no_progress',
            `WAIT chosen ${wait.n}x on goal "${goalKey}" with no verified progress; semantic boundary=${boundary.reason}`,
          )
        : null
      const counted = summon?.triggered === true
      if (counted) this.waitReplans += 1
      this.waitStreak = 0
      this.wedgeRepeats = 0
      this.logger.warn(
        'agent',
        `${boundary.wake ? 'WAIT_LIMIT' : 'LOCAL_WAIT_RECOVERY'} n=${wait.n} -> replan (${this.waitReplans}/${WAIT_REPLAN_LIMIT}) goal="${goalKey}"${this.noProductiveThisTick ? ' NO_PRODUCTIVE_CANDIDATE' : ''}${counted ? '' : ' SYSTEM2=false'}`,
        {
          actionId,
          count: wait.n,
          goal: goalKey,
          waitReplans: this.waitReplans,
          llmSummoned: counted,
          throttled: !counted,
          boundary: boundary.reason,
        },
        this.tickCounter,
      )
      return
    }
    if (wait.outcome === 'wedge') {
      this.abortWedge(
        `WAIT chosen ${wait.n}x on goal "${goalKey}" with no verified progress after ${this.waitReplans} replan(s)`,
      )
    }
  }

  private currentOptionContext(): CurrentOptionContext | null {
    const current = this.queue.state.current
    if (current === null || typeof current.optionInstanceId !== 'string' || current.optionInstanceId.length === 0) return null
    const optionId = current.semanticOptionTemplateId ?? current.optionTemplateId ?? optionIdForGoal(current) ?? this.currentGoalKey()
    const attempts = this.optionAttempts.stateFor(optionId, current.id)
    return currentOptionContextForQueuedGoal(current, {
      failures: attempts.attempts,
      verifiedProgress: current.haveCount,
      lastProgressAt: current.updatedAt,
    })
  }

  /** Code-owned completion proof for the typed System2 `complete` operation. */
  private verifyQueuedGoalComplete(goal: QueuedGoal): boolean {
    const snapshot = this.queuePreconditionSnapshot()
    const spec = goal.optionSpec ?? compilePlannedGoal(queuedToPlanned(goal), snapshot)
    const predicate = evaluatePredicates(spec.success, snapshot)
    if (predicate.ok) return true
    if ((goal.kind === 'collect' || goal.kind === 'craft' || goal.kind === 'smelt') && goal.targetItem !== null) {
      return (snapshot.inventory[goal.targetItem] ?? 0) >= goal.requiredCount
    }
    return false
  }

  private currentGoalKey(): string {
    const current = this.queue.state.current
    if (current !== null) {
      return `${current.kind}:${current.targetItem ?? current.description}:${current.requiredCount}`
    }
    return `objective:${this.goal.targetItem}:${this.goal.requiredCount}`
  }

  private logQueueDepthDelta(before: number, op: string, reason: string): void {
    const state = this.queue.state
    const delta = state.depth - before
    if (delta === 0) return
    const signed = delta > 0 ? `+${delta}` : `${delta}`
    this.logger.info(
      'queue',
      `QUEUE_DEPTH delta=${signed} depth=${state.depth} done=${state.done} op=${op} reason=${reason}`,
      { delta, depth: state.depth, done: state.done, op, reason },
      this.tickCounter,
    )
  }

  private noProductiveSignature(state: WorldState): string {
    const inventory = Object.entries(state.inventory.counts)
      .filter(([, count]) => count > 0)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, count]) => `${name}=${count}`)
      .join(',')
    const position = `${Math.round(state.self.position.x)},${Math.round(state.self.position.y)},${Math.round(state.self.position.z)}`
    return `${this.currentGoalKey()}|${position}|${inventory}`
  }

  private replanInputs(): ReplanInputs {
    const inventory: Record<string, number> = {}
    try {
      for (const item of this.bot.inventory.items()) inventory[item.name] = (inventory[item.name] ?? 0) + item.count
    } catch {
      // inventory unreadable at a death/quit boundary; an empty snapshot is safe
    }
    const entity = this.bot.entity
    const position =
      entity === undefined
        ? null
        : { x: Math.round(entity.position.x), y: Math.round(entity.position.y), z: Math.round(entity.position.z) }
    const failureSignature = this.recentOutcomes
      .slice(-4)
      .map((outcome) => `${outcome.actionId}:${outcome.status}${outcome.failure === null ? '' : `:${outcome.failure}`}`)
      .join(',')
    return {
      inventory,
      position,
      knownResources: (this.signals.knownResources ?? []).length,
      failureSignature,
      capabilityGap: this.capabilityGapActive ? this.capabilityGapSignature : null,
      goalKey: this.currentGoalKey(),
      // #plan-reconciliation: a genuinely different plan/objective identity is new
      // information for the replan gate (so the supersession wake is not swallowed
      // as `no_new_info`), while the identical supersession repeated stays bounded
      // by the same throttle.
      planIdentityKey: (() => {
        try {
          const identity = this.options.planIdentity?.() ?? null
          return identity === null ? null : formatPlanIdentity(identity)
        } catch {
          return null
        }
      })(),
      // The Nth identical typed action failure is proof the local recovery is
      // exhausted, so it is genuine new information for the replan gate even
      // though the cheap world inputs are identical. Null at every count < N.
      actionFailureExhausted: this.actionFailureEscalation.pendingKey(),
      // The Nth actionable WAIT is proof the no-op selection itself is the loop,
      // so it is genuine new information for the replan gate.
      waitStreakExhausted: this.waitStreakEscalation.pendingKey(),
    }
  }

  private logRetrievalAction(candidate: Candidate): void {
    const resource = typeof candidate.meta.resource === 'string' ? candidate.meta.resource : 'unknown'
    const at = candidate.target === null ? null : `${candidate.target.x},${candidate.target.y},${candidate.target.z}`
    if (candidate.meta.retrieval === 'surface') {
      this.logger.info(
        'agent',
        `EXPLORE kind=surface target=${resource} at=${at ?? 'unknown'}`,
        { kind: 'surface', target: resource, at },
        this.tickCounter,
      )
      return
    }
    const dist = this.retrievalDistance(candidate.target)
    const vertical = typeof candidate.meta.vertical === 'string' ? candidate.meta.vertical : 'none'
    const knownName = typeof candidate.meta.knownName === 'string' ? candidate.meta.knownName : resource
    if (candidate.target !== null) {
      this.activeRetrieval = { id: candidate.id, resource, knownName, target: candidate.target }
    }
    this.logger.info(
      'agent',
      `RETURN_TO_KNOWN_RESOURCE item=${resource} target=${at ?? 'unknown'} dist=${dist ?? 'unknown'} vertical=${vertical}`,
      { item: resource, name: candidate.targetName, target: at, dist, vertical },
      this.tickCounter,
    )
  }

  private retrievalDistance(target: Vec3Json | null): number | null {
    const exact = this.retrievalDistanceExact(target)
    return exact === null ? null : Math.round(exact)
  }

  private retrievalDistanceExact(target: Vec3Json | null): number | null {
    const entity = this.bot.entity
    if (target === null || entity === undefined) return null
    return Math.hypot(entity.position.x - target.x, entity.position.y - target.y, entity.position.z - target.z)
  }

  /**
   * Did a known-resource RETRIEVE actually reach its target? `pathToNear` aims
   * for 2 blocks, so a coordinate still further than that is a miss even when the
   * executor reported `verified=true` from a vertical chunk. Pure callers use
   * `shouldClearActiveRetrieval`; this only measures the live body.
   */
  private retrievalArrived(candidate: Candidate): boolean {
    if (candidate.meta.retrieval !== 'known' || candidate.target === null) return false
    const distance = this.retrievalDistanceExact(candidate.target)
    return distance !== null && distance <= 2
  }

  /**
   * A surface RETRIEVE is a search waypoint, not a remembered resource. Its
   * postcondition is local arrival so the search frontier can advance; arrival
   * must never be treated as acquisition of the parent collect Option.
   */
  private surfaceSearchArrived(candidate: Candidate): boolean {
    if (candidate.meta.retrieval !== 'surface' || candidate.target === null) return false
    const distance = this.retrievalDistanceExact(candidate.target)
    return distance !== null && distance <= 2
  }

  private recordSurfaceSearch(candidate: Candidate): void {
    if (candidate.target === null) return
    const key = surfaceSearchKey(this.currentDimension(), candidate.target)
    if (this.searchedSurfaceTargets.has(key)) return
    this.searchedSurfaceTargets.add(key)
    this.logger.info(
      'agent',
      `SURFACE_SEARCH_RECORDED target=${candidate.target.x},${candidate.target.y},${candidate.target.z}`,
      { target: candidate.target, key, frontier: 'advanced', resource: candidate.meta.resource ?? null },
      this.tickCounter,
    )
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
    if (result.itemsGained > 0) return true
    // Surface arrival proves only that a search waypoint was visited. The
    // requested resource is still absent until the next sensor/MINE cycle.
    if (candidate.meta.retrieval !== 'known') return false
    const arrived = this.retrievalArrived(candidate)
    if (arrived) return true
    return shouldClearActiveRetrieval({
      retrieval: candidate.meta.retrieval,
      hasObservableProgress: hasObservableProgress(result),
      arrived,
    })
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
    const out: KnownResource[] = []
    const seen = new Set<string>()
    for (const resource of [...(this.options.knownResources ?? []), ...this.placedStations]) {
      const key = resourceKey(resource)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(resource)
    }
    return out
  }

  /**
   * Every want item this tick's retrieval machinery can route to: the active
   * focus plus the queued want the explicit descent proxy exposes. The sensor
   * verifies remembered cells for all of them (`SensorInput.retrievalItems`),
   * because `retrievalNeeds` offers the proxied row's `RETRIEVE:known` from the
   * same memory - verifying only the focus left that cell unproven forever.
   */
  private retrievalProbeItems(): string[] {
    const out: string[] = []
    const focus = currentFocusItem(this.goal, this.queue.state)
    if (focus !== null) out.push(focus)
    const proxy = queuedRetrievalProxyItem(this.queue.state)
    if (proxy !== null && !out.includes(proxy)) out.push(proxy)
    return out
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
    const keys = new Set<string>()
    const dimension = state.self.dimension
    const consider = (name: string, position: Vec3Json): void => {
      const retrieveId = `RETRIEVE:known:station:${name}:${blockId('b', position)}`
      const withheld = this.withheldCandidateIds.has(retrieveId)
      if (!withheld && !this.moveFailMemory.isBlacklisted(dimension, position)) return
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

  /**
   * Feed the active coordinate blacklist into candidate selection. The
   * post-generation filter remains the final guard, but selection must see
   * restored entries too; otherwise pickExplore/retrievalCandidates chooses a
   * target that filterMoveCandidates immediately removes, leaving only WAIT.
   */
  private blacklistedMoveTargets(state: WorldState): ReadonlySet<string> {
    const dimension = state.self.dimension
    const keys = new Set<string>()
    for (const entry of this.moveFailMemory.snapshot()) {
      if (entry.dimension !== dimension) continue
      if (this.moveFailMemory.isBlacklisted(dimension, entry)) keys.add(entry.key)
    }
    return keys
  }

  private applyFurnacePrereq(
    state: WorldState,
    candidates: readonly Candidate[],
    unreachableStations: ReadonlySet<string>,
  ): Candidate[] {
    const goal = state.goalQueue?.current ?? null
    // Same predicate the candidate generator uses (candidates.ts#furnaceAcquisitionCandidates):
    // a furnace prerequisite exists only for a smelt goal with no placed furnace. Using the
    // stricter targetItem check here would let a retrieval candidate through unfiltered (#78).
    const subject = prereqSubjectForGoal(goal)
    if (subject === null) {
      this.resetFurnacePrereq()
      return [...candidates]
    }
    const sensedStationCount = (state.furnaces ?? []).filter(isSensedStation).length
    const observation = decideFurnacePrereqObservation({
      subject,
      sensedStationCount,
      goalKey: this.currentGoalKey(),
      previousKey: this.prereqSatisfiedLoggedKey,
    })
    if (observation.key !== null) {
      // A satisfied prerequisite is not a path choice: emit the distinct typed
      // observation at most once per goal instead of a false PREREQ_OPTION.
      this.resetFurnacePrereq()
      if (observation.line !== null) {
        this.prereqSatisfiedLoggedKey = observation.key
        this.logger.info(
          'agent',
          observation.line,
          { subject, source: 'sensed', sensedStationCount },
          this.tickCounter,
        )
      }
      return [...candidates]
    }
    const input = furnacePrereqInputFromState(
      state,
      candidateOptions(
        this.options,
        this.recipeIndex,
        unreachableStations,
        this.reachabilityGateOptions(),
        this.blacklistedMoveTargets(state),
        null,
        this.searchedSurfaceTargets,
      ),
    )
    const decision = planPrereqOptions(input)
    const goalKey = this.currentGoalKey()
    if (this.prereqGoalKey !== goalKey) {
      this.prereqGoalKey = goalKey
      this.prereqForcedPath = null
      this.prereqProgress = null
      this.prereqLoggedKey = null
      this.prereqStationKnownLoggedKey = null
      this.abandonedRetrievePaths.clear()
      this.retrieveUnverified = null
    }
    const abandoned = this.abandonedPrereqSet(goalKey, Date.now())
    for (const [path, fingerprint] of this.abandonedRetrievePaths) {
      if (fingerprint === this.lastStateFingerprint) abandoned.add(path)
    }
    const base = selectPrereqPath(decision, abandoned)
    const forced = this.prereqForcedPath !== null && !abandoned.has(this.prereqForcedPath) ? this.prereqForcedPath : null
    const chosen = preferPrereqPath(base, forced, decision)
    if (this.prereqForcedPath !== null && this.prereqForcedPath !== chosen) this.prereqForcedPath = null
    this.prereqPlan = decision
    this.prereqChosenPath = chosen
    const logKey = `${goalKey}|${chosen ?? 'none'}`
    if (this.prereqLoggedKey !== logKey) {
      this.prereqLoggedKey = logKey
      this.logger.info(
        'agent',
        formatPrereqOptionFor(decision, chosen),
        {
          chosen,
          options: decision.options.map((option) => ({ path: option.path, feasible: option.feasible, cost: option.cost, reason: option.reason })),
        },
        this.tickCounter,
      )
      this.logger.info(
        'agent',
        formatPrereqRankShadow(decision, chosen),
        {
          policy: decision.policy,
          costChoice: chosen,
          rankChoice: decision.rankBaseline,
          agree: chosen === decision.rankBaseline,
        },
        this.tickCounter,
      )
      if (chosen !== null && isInventorySourced(chosen)) {
        this.logger.info(
          'agent',
          formatPrereqOptionDetail('furnace', chosen, prereqOptionReason(chosen), input.heldCount),
        { chosen, heldCount: input.heldCount, abandoned: [...abandoned] },
          this.tickCounter,
        )
      }
    }
    // OPERATOR RULE (station-use-before-craft): when the world already holds a
    // usable station of the needed kind the craft path is INELIGIBLE, so say so
    // with its own typed line instead of only omitting `CRAFT:furnace` from the
    // offered set. The line is derived from the very option the planner marked
    // ineligible, and it names the path that runs instead, so the run log can
    // never show a withheld duplicate craft without its reason.
    const withheldCraft = prereqWithheldCraft(decision)
    if (withheldCraft !== null && input.knownStation !== null) {
      const stationKnownLine = formatPrereqStationKnown(input.knownStation, input.heldCount, chosen)
      if (stationKnownLine !== this.prereqStationKnownLoggedKey) {
        this.prereqStationKnownLoggedKey = stationKnownLine
        this.logger.info(
          'agent',
          stationKnownLine,
          {
            reason: withheldCraft.reason,
            station: input.knownStation,
            held: input.heldCount,
            chosen,
            goal: goalKey,
          },
          this.tickCounter,
        )
      }
    } else {
      this.prereqStationKnownLoggedKey = null
    }
    const kept = filterFurnacePrerequisiteCandidates(candidates, chosen)
    if (chosen === null) return kept

    const signature = prereqProgressSignature(chosen, input)
    const evaluated = evaluatePrereqStall({
      previous: this.prereqProgress,
      path: chosen,
      signature,
      stallTicks: this.prereqStallTicks,
    })
    this.prereqProgress = evaluated.progress
    if (!evaluated.stalled) return kept

    const next = this.nextUsablePrereqPath(decision, chosen, abandoned)
    if (next === null) return kept
    this.prereqForcedPath = next
    this.prereqChosenPath = next
    this.prereqProgress = null
    this.prereqLoggedKey = null
    this.logger.warn(
      'agent',
      formatPrereqSwitch(chosen, next),
      { from: chosen, to: next, stallTicks: this.prereqStallTicks, goal: goalKey },
      this.tickCounter,
    )
    return filterFurnacePrerequisiteCandidates(candidates, next)
  }

  /** The next feasible prereq path that has not been abandoned for this goal. */
  private nextUsablePrereqPath(
    decision: PrereqDecision,
    current: PrereqPath,
    abandoned: ReadonlySet<PrereqPath>,
  ): PrereqPath | null {
    const seen = new Set<PrereqPath>([current])
    for (;;) {
      const next = nextPrereqPath(decision, current)
      if (next === null || seen.has(next)) break
      if (!abandoned.has(next)) return next
      seen.add(next)
      current = next
    }
    return null
  }

  private abandonedPrereqSet(goalKey: string, now: number): Set<PrereqPath> {
    const bucket = this.abandonedPrereqPaths.get(goalKey)
    const abandoned = new Set<PrereqPath>()
    if (bucket === undefined) return abandoned
    for (const [path, at] of bucket) {
      if (now - at >= this.options.abandonCooldownMs) continue
      if (this.abandonedPrereqFingerprints.get(`${goalKey}|${path}`) !== this.lastStateFingerprint) continue
      abandoned.add(path)
    }
    return abandoned
  }

  private resetFurnacePrereq(): void {
    this.prereqPlan = null
    this.prereqForcedPath = null
    this.prereqGoalKey = null
    this.prereqLoggedKey = null
    this.prereqStationKnownLoggedKey = null
    this.prereqProgress = null
    this.prereqChosenPath = null
    this.abandonedRetrievePaths.clear()
    this.abandonedPrereqFingerprints.clear()
    this.retrieveUnverified = null
  }

  /**
   * #78: the same known-station retrieve finished unverified with zero progress
   * past the bound, so abandon that option for the current goal and let the next
   * scored path run. The abandoned path is never re-selected while the goal key
   * is unchanged.
   */
  private abandonRetrieveOption(line: string, candidate: Candidate, unverified: number): void {
    this.logger.warn(
      'agent',
      line,
      { option: candidate.id, unverified, goal: this.currentGoalKey() },
      this.tickCounter,
    )
    this.abandonedRetrievePaths.set('use_known_station', this.lastStateFingerprint)
    if (candidate.target !== null) {
      const knownName =
        typeof candidate.meta.knownName === 'string' ? candidate.meta.knownName : candidate.targetName ?? 'station'
      this.unreachableResources.add(this.retrievalKey({ knownName, target: candidate.target }))
    }
    this.noteCandidateFailure(candidate.id)
    this.markOptionAbandoned(candidate.id, 'retrieve_unverified')
    this.activeRetrieval = null
    this.retrievalTrack = null
    this.retrieveUnverified = null
    this.prereqForcedPath = null
    this.prereqProgress = null
    this.prereqLoggedKey = null
    this.retrievalEscalationPending = true
    this.logger.warn(
      'agent',
      `LOCAL_RETRIEVE_RECOVERY candidate=${candidate.id} unverified=${unverified} system2=false`,
      { candidate: candidate.id, unverified, boundary: 'local_recovery' },
      this.tickCounter,
    )
  }

  private logStaleKnownResources(state: WorldState): void {
    for (const resource of staleKnownResources(state)) {
      const at = `${resource.position.x},${resource.position.y},${resource.position.z}`
      const key = `${resource.name}@${at}`
      if (this.loggedStaleResources.has(key)) continue
      this.loggedStaleResources.add(key)
      this.logger.info(
        'agent',
        `KNOWN_RESOURCE_STALE item=${resource.name} at=${at}`,
        { item: resource.name, at },
        this.tickCounter,
      )
    }
    this.logKnownResourceVerdicts(state)
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
    for (const evidence of state.knownResourceEvidence ?? []) {
      const verdict = nextKnownResourceVerdict(this.knownResourceVerdicts, evidence)
      if (verdict.kind === 'falsified') {
        this.logger.warn(
          'agent',
          formatKnownResourceFalsified(evidence.item, evidence.name, evidence.position, verdict.reason),
          knownResourceVerdictDetail(evidence, verdict.reason),
          this.tickCounter,
        )
        continue
      }
      if (verdict.kind === 'resighted') {
        this.logger.info(
          'agent',
          formatKnownResourceResighted(evidence.item, evidence.name, evidence.position, verdict.source),
          knownResourceVerdictDetail(evidence, null),
          this.tickCounter,
        )
      }
    }
  }

  /**
   * #436 section E (deterministic cancellation / failure):
   *
   *   "observed world state contradicts the claimed postcondition -> never report
   *    success"; "selected block changed into another block -> stop + re-observe";
   *    "selected entity despawned / identity invalidated -> stop + typed
   *    target-gone outcome"; "No deterministic failure branch may silently choose
   *    a different semantic objective."
   *
   * The RUNNING known-resource skill is grounded on the remembered cell's claim
   * (the block is there / a producer is there / the drop is there). When the state
   * this tick PROVED that claim false, the skill is CANCELLED with a typed
   * outcome - it is never silently re-pointed at another cell or another item.
   * The tick then continues to Jev, which owns WHICH action comes next.
   *
   * The boundaries that keep this a truth rule and not a retry policy:
   *   - only `falsified` (a real contradiction) cancels. `unknown` (unloaded
   *     chunk / outside the entity envelope) is not a verdict and a merely
   *     UNREACHABLE target keeps the existing bounded `decideKnownRetrieve`
   *     retry/retire - a side-effect-free transient failure may be retried inside
   *     its explicit bound;
   *   - a cancelled skill is never restarted by code: the falsified cell is
   *     withheld from `signals.knownResources`, so only a real re-sighting can
   *     put it back in front of Jev;
   *   - when the side-effect state is unknown, nothing here retries blindly.
   */
  private cancelContradictedSkillTarget(state: WorldState): void {
    const active = this.activeRetrieval
    if (active === null) return
    const running = this.executor.current
    if (running === null || running.id !== active.id) return
    const contradiction = (state.knownResourceEvidence ?? []).find(
      (evidence) =>
        evidence.status === 'falsified' &&
        evidence.position.x === active.target.x &&
        evidence.position.y === active.target.y &&
        evidence.position.z === active.target.z,
    )
    if (contradiction === undefined) return
    const reason: 'contradicted' | 'target_gone' =
      contradiction.reason === 'mob_gone' ? 'contradicted' : 'target_gone'
    const failure = contradiction.reason ?? 'falsified'
    const cancelled = this.executor.cancelCurrent(`contradicted target ${active.id} (${failure})`)
    this.logger.warn(
      'agent',
      // The canonical #436 vocabulary (netherPortalPlan.ts): a Skill that ended
      // because the world contradicted the state its postcondition was grounded
      // on, with the typed failure code.
      formatSkillEnd(KNOWN_RETRIEVE_SKILL, 'cancelled', 'failed', `${contradiction.claim}_present`, failure),
      {
        actionId: active.id,
        item: active.resource,
        name: active.knownName,
        cell: active.target,
        claim: contradiction.claim,
        observed: contradiction.observed,
        cancelled,
      },
      this.tickCounter,
    )
    this.logger.warn(
      'agent',
      formatSkillInterrupt(KNOWN_RETRIEVE_SKILL, reason),
      { actionId: active.id, item: active.resource, cell: active.target, reason: failure },
      this.tickCounter,
    )
    this.activeRetrieval = null
    this.retrievalTrack = null
  }

  private abortWedge(reason: string): void {
    if (this.wedgeAborted) return
    this.wedgeAborted = true
    this.wedgeReason = reason
    this.logger.error('agent', `ABORT: wedge detected (${reason})`, { reason }, this.tickCounter)
    process.stdout.write(`\n[agent] ABORT: wedge detected (${reason})\n`)
    this.finish('wedge', false)
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
    if (this.bot.pathfinder === undefined) return false
    try {
      const goal = new goals.GoalBlock(position.x, position.y, position.z)
      const plan = this.bot.pathfinder.getPathTo(this.bot.pathfinder.movements, goal, PATH_PROBE_TIMEOUT_MS)
      // `timeout` is not a usable route fact. The exact M2 wedge was a
      // GoalBlock timeout followed by a control-walk with no jump headroom;
      // treating a partial search as reachable re-admitted the same MOVE.
      return plan.status === 'success'
    } catch {
      return false
    }
  }

  /**
   * CAN fact for a plain ATTACK lease. The executor follows until it is within
   * `MELEE_ATTACK_RANGE`; probing GoalBlock is stricter than the real action and
   * can falsely reject a perfectly hittable target, so use the same near radius.
   * Timeout is UNKNOWN/non-executable for this short lease, exactly like the
   * ordinary reachability probe: only a complete path is a current CAN proof.
   */
  private canComputeMeleePath(position: Vec3Json): boolean {
    if (this.bot.pathfinder === undefined) return false
    try {
      const goal = new goals.GoalNear(position.x, position.y, position.z, Math.max(1, MELEE_ATTACK_RANGE - 0.2))
      const plan = this.bot.pathfinder.getPathTo(this.bot.pathfinder.movements, goal, PATH_PROBE_TIMEOUT_MS)
      return plan.status === 'success'
    } catch {
      return false
    }
  }

  private logCandidates(candidates: readonly Candidate[], state: WorldState): void {
    const option = state.currentOption
    const signature = JSON.stringify({
      optionInstanceId: option?.instanceId ?? null,
      optionTemplateId: option?.templateId ?? null,
      allowedSkills: option?.allowedSkills ?? [],
      queueRevision: this.queue.revision,
      candidates: candidates.map((candidate) => ({
        id: candidate.id,
        optionSkill: candidate.meta.optionSkill ?? null,
        prerequisiteRole: candidate.meta.prerequisiteRole ?? null,
        missingCapability: candidate.meta.missingCapability ?? null,
      })),
    })
    if (signature === this.lastCandidateSignature) return
    this.lastCandidateSignature = signature
    this.logger.info(
      'candidates',
      `generated ${candidates.length} executable candidate(s); skipped ${countBlockedLogs(state)} blocked log(s) (canDig=false, no walk-up access)`,
      {
        ids: candidates.map((candidate) => candidate.id),
        detail: candidates.map((candidate) => candidate.label),
        option: option === undefined || option === null
          ? null
          : {
              instanceId: option.instanceId,
              templateId: option.templateId,
              allowedSkills: [...option.allowedSkills],
              queueRevision: this.queue.revision,
            },
        candidateEvidence: candidates.map((candidate) => ({
          id: candidate.id,
          kind: candidate.kind,
          optionSkill: candidate.meta.optionSkill ?? null,
          prerequisiteRole: candidate.meta.prerequisiteRole ?? null,
          missingCapability: candidate.meta.missingCapability ?? null,
          capabilityAcquisition: candidate.meta.capabilityAcquisition === true,
          included: true,
          exclusionReason: null,
        })),
        sensorBlocks: state.blocks
          .filter((block) => block.kind === 'log' || block.kind === 'stone' || block.kind === 'ore')
          .slice(0, 32)
          .map((block) => ({
            kind: block.kind,
            name: block.name,
            yield: block.yield ?? null,
            position: block.position,
            inReach: block.inReach,
            hasAdjacentStandable: block.hasAdjacentStandable,
            adjacentStandable: block.adjacentStandable,
          })),
      },
      this.tickCounter,
    )
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
   *
   * Deduped by (food, threshold, held food, offered routes) so a stable food
   * state is one auditable line, matching the LOG_ROUTE convention.
   */
  private logFoodState(candidates: readonly Candidate[], state: WorldState, options: CandidateOptions): void {
    const threshold = options.eatBelowFood
    const food = state.self.food
    const held = pickFood(state)
    const routes = candidates.filter((candidate) => typeof candidate.meta.foodRoute === 'string')
    const signature = [
      food,
      threshold,
      held ?? 'none',
      routes
        .map((candidate) => `${String(candidate.meta.foodRoute)}:${String(candidate.meta.foodTarget)}`)
        .sort()
        .join(','),
    ].join('|')
    if (signature !== this.lastFoodMarkerSignature) {
      this.lastFoodMarkerSignature = signature
      if (food <= threshold) {
        this.logger.info(
          'food',
          `FOOD_LOW food=${food} threshold=${threshold}`,
          { food, threshold, heldFood: held },
          this.tickCounter,
        )
      }
      if (held !== null && food > threshold) {
        this.logger.info(
          'food',
          'EAT_REFUSED reason=full',
          { food, threshold, heldFood: held },
          this.tickCounter,
        )
      }
      if (held === null && food <= threshold) {
        this.logger.info('food', 'EAT_REFUSED reason=no_food', { food, threshold }, this.tickCounter)
      }
      for (const candidate of routes) {
        this.logger.info(
          'food',
          `FOOD_ROUTE kind=${String(candidate.meta.foodRoute)} target=${String(candidate.meta.foodTarget)}`,
          {
            candidate: candidate.id,
            kind: candidate.meta.foodRoute,
            target: candidate.meta.foodTarget,
            distance: candidate.meta.distance ?? null,
          },
          this.tickCounter,
        )
      }
    }

    // FOOD_ACQUIRED is an inventory delta, not a route fact. The first observed
    // tick only seeds the baseline; a pre-existing stack is not an acquisition.
    const current = new Map<string, number>()
    for (const [name, count] of Object.entries(state.inventory.counts)) {
      if (!isFoodItem(name)) continue
      current.set(name, count)
      if (this.lastFoodCounts === null) continue
      const previous = this.lastFoodCounts.get(name) ?? 0
      if (count > previous) {
        this.logger.info(
          'food',
          `FOOD_ACQUIRED item=${name} count=${count}`,
          { item: name, count, previous },
          this.tickCounter,
        )
      }
    }
    this.lastFoodCounts = current
  }

  /**
   * The `LOG_ROUTE` marker: which log route the policy has on offer this tick
   * (`mode=mine_sensed|retrieve_known|ascend_then_mine|explore`), so a frozen
   * non-yield MINE can never again pass as progress. Deduped by
   * (mode, target, candidate) so a stable route is one auditable line; the
   * `trigger=... -> action=...` line still records the action actually chosen.
   */
  private logLogRoute(candidates: readonly Candidate[]): void {
    const route = logRouteOf(candidates)
    if (route === null) return
    const signature = `${route.mode}|${route.target.x},${route.target.y},${route.target.z}|${route.candidateId}`
    if (signature === this.lastLogRouteSignature) return
    this.lastLogRouteSignature = signature
    this.logger.info(
      'candidates',
      formatLogRoute(route),
      { mode: route.mode, target: route.target, candidateId: route.candidateId },
      this.tickCounter,
    )
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
    for (const entry of evaluated) {
      const candidateId = entry.candidate.id
      const signature = `reach:${entry.result.reachable}|${entry.result.reason}|${entry.fingerprint}`
      this.logReachabilityOnce(candidateId, signature, !entry.result.reachable, entry)
    }
    for (const entry of withheld) {
      const candidateId = entry.candidate.id
      const signature = `withheld:${entry.result.reason}|${entry.fingerprint}|${entry.suppressed}`
      this.logReachabilityOnce(`withheld:${candidateId}`, signature, true, entry)
    }
  }

  private logReachabilityOnce(
    key: string,
    signature: string,
    asWarning: boolean,
    entry: CandidateReachability,
  ): void {
    if (this.reachabilityLogSignatures.get(key) === signature) return
    this.reachabilityLogSignatures.set(key, signature)
    const target = {
      candidateId: entry.candidate.id,
      kind: entry.candidate.kind,
      position: entry.candidate.target,
      barrier: null,
    }
    const detail = {
      candidate: entry.candidate.id,
      kind: entry.candidate.kind,
      reachable: entry.result.reachable,
      reason: entry.result.reason,
      missing: entry.result.missingCapabilities.map(capabilityKey),
      fingerprint: entry.fingerprint,
      suppressed: entry.suppressed,
    }
    const line = formatReachability(target, entry.result)
    if (asWarning) this.logger.warn('agent', line, detail, this.tickCounter)
    else this.logger.info('agent', line, detail, this.tickCounter)
    if (entry.withheld) {
      this.logger.warn(
        'agent',
        formatCandidateWithheld(entry.candidate.id, entry.result.reason),
        detail,
        this.tickCounter,
      )
      const refusal = entry.candidate.meta.digAccessRefusal
      const block = entry.candidate.target
      if (block !== null && (refusal === 'no_interaction_stand' || refusal === 'no_path_to_stand')) {
        this.logger.warn('agent', formatDigAccessRetired(block, refusal), detail, this.tickCounter)
      }
    }
  }

  /**
   * Surface the generator's typed ascent refusal (`SURFACE_ASCENT_REFUSED
   * reason=no_placeable|unsafe_column goal=... from_y=... to_y=...`) once per
   * distinct refusal, and retain the two facts the queue-sync `surface` branch
   * needs. The measured 48-minute loop ran with no route enumerated AND nothing
   * saying why; this makes the dead end explicit and feeds the existing
   * capability-gap latch so the planner re-plans instead of the body pacing
   * inside the level-move set. The refusal is a deterministic plan fact, not a
   * semantic preference.
   */
  private noteSurfaceAscent(refusal: SurfaceAscentRefusal | null, candidates: readonly Candidate[]): void {
    this.lastSurfaceAscentRefusal = refusal
    // Pure candidate fact: is any body-changing route on offer at all? A single
    // refused pillar must never erase a real level/mine/step alternative.
    // For an ALTITUDE goal a level MOVE is not a route: an offer only clears the
    // dead end when it can actually raise the body toward `targetY`. Otherwise a
    // pocket with level moves paced forever (LIVE: LOCAL_CAPABILITY_GAP
    // attempts>131) because every body-changing candidate masked the dead end.
    const current = this.queue.current
    const surfaceTargetY =
      current?.kind === 'surface' && typeof current.targetY === 'number' && Number.isFinite(current.targetY)
        ? current.targetY
        : null
    const feetY = this.bot.entity?.position?.y
    const altitudeless =
      surfaceTargetY !== null &&
      typeof feetY === 'number' &&
      !altitudeRouteOnOffer(candidates, Math.floor(feetY), surfaceTargetY)
    this.lastSurfaceAscentRouteless = surfaceAscentRouteless(candidates) || altitudeless
    if (refusal !== null) this.ascendRefusedSinceObservation = true
    const key = refusal === null ? null : formatSurfaceAscentRefused(refusal)
    if (key === null || key !== this.surfaceAscentRefusalStreakKey) {
      this.surfaceAscentRefusalStreakKey = key
      this.surfaceAscentRefusalStreak = key === null ? 0 : 1
    } else {
      this.surfaceAscentRefusalStreak += 1
    }
    if (key === this.lastSurfaceAscentRefusalKey) return
    this.lastSurfaceAscentRefusalKey = key
    if (refusal === null) return
    this.logger.warn(
      'agent',
      formatSurfaceAscentRefused(refusal),
      { ...refusal, goal: this.currentGoalKey() },
      this.tickCounter,
    )
  }

  /**
   * Surface the generator's column-dig route (`COLUMN_DIG target=x,y,z top_y=n`)
   * once per distinct base cell. This is the "obtain a resource whose supporting
   * column is reachable" capability: the body mines the column from its
   * reachable base and the drop falls into pickup range, so a floating trunk /
   * pillar cap / wall resource is obtainable with no kit. Observability only -
   * the CHOICE of whether to take it stays with Jev.
   */
  private noteColumnDig(candidates: readonly Candidate[]): void {
    const dig = candidates.find((candidate) => candidate.meta.columnDig === true && candidate.target !== null)
    const key = dig === undefined || dig.target === null
      ? null
      : `${blockId('b', dig.target)}|${String(dig.meta.columnTopY ?? '')}`
    if (key === this.lastColumnDigKey) return
    this.lastColumnDigKey = key
    if (key === null || dig === undefined || dig.target === null) return
    this.logger.warn(
      'agent',
      `COLUMN_DIG target=${dig.target.x},${dig.target.y},${dig.target.z} top_y=${String(dig.meta.columnTopY ?? '')}`,
      { actionId: dig.id },
      this.tickCounter,
    )
  }

  /**
   * Surface the hungry hunt's typed vertical-route refusal
   * (`FOOD_HABITAT_REFUSED reason=... -> no grounded route to animal habitat`)
   * once per distinct refusal. Measured `run-mubj6ucc-si3e`: a health-1 body
   * underground with no sensed animal and `collect:food 0/3` produced an
   * unbounded `WAIT/DESCEND` hunt; with no route up, the dead end must be an
   * explicit fact the semantic layer can re-plan on instead of silence.
   */
  private noteFoodHabitat(refusal: SurfaceAscentRefusal | null): void {
    const key = refusal === null ? null : formatFoodHabitatRefused(refusal)
    if (key === this.lastFoodHabitatRefusalKey) return
    this.lastFoodHabitatRefusalKey = key
    if (refusal === null) return
    this.logger.warn('agent', formatFoodHabitatRefused(refusal), { ...refusal, goal: this.currentGoalKey() }, this.tickCounter)
  }

  /**
   * Surface the generator's typed placement refusal (`PLACE_REFUSED
   * reason=no_support|no_clearance|out_of_reach cell=x,y,z item=...`) once per
   * distinct refusal, so a geometry dead end is an explicit fact instead of the
   * silence that let a held station stall the craft goal.
   */
  private logPlacementRefusal(refusal: PlaceRefusal | null): void {
    const key =
      refusal === null ? null : `${refusal.reason}|${blockId('p', refusal.cell)}|${refusal.item}`
    if (key === this.lastPlacementRefusalKey) return
    this.lastPlacementRefusalKey = key
    if (refusal === null) return
    this.logger.warn(
      'agent',
      formatPlaceRefusal(refusal),
      { reason: refusal.reason, cell: refusal.cell, item: refusal.item },
      this.tickCounter,
    )
  }

  /**
   * Surface every carried armor piece that was NOT offered because it is not
   * strictly better than what is worn (`EQUIP_ARMOR_REFUSED slot=... item=...
   * worn=... reason=not_better`), once per distinct refusal set. This is the
   * explicit "nothing better is held" fact, never a silent churn.
   */
  private logArmorRefusal(refusals: readonly ArmorRefusal[]): void {
    const key = refusals.length === 0 ? null : refusals.map(formatArmorRefusal).join('|')
    if (key === this.lastArmorRefusalKey) return
    this.lastArmorRefusalKey = key
    for (const refusal of refusals) {
      this.logger.warn('agent', formatArmorRefusal(refusal), { ...refusal }, this.tickCounter)
    }
  }

  /**
   * Surface every collect-source cell refused because it is a member of a live
   * structure (`RESOURCE_SOURCE_EXCLUDED item=... cell=... reason=live_structure`),
   * once per distinct set. This is the explicit fact that the bot is NOT
   * dismantling infrastructure it depends on: the plan must source the item
   * elsewhere instead.
   */
  private logSourceExclusions(exclusions: readonly ResourceSourceExclusion[]): void {
    const key = exclusions.length === 0 ? null : exclusions.map(formatResourceSourceExclusion).join('|')
    if (key === this.lastSourceExclusionKey) return
    this.lastSourceExclusionKey = key
    for (const exclusion of exclusions) {
      this.logger.warn('agent', formatResourceSourceExclusion(exclusion), { ...exclusion }, this.tickCounter)
    }
  }

  /**
   * Name WHY the frame scan grounded no site, once per distinct rejection. The
   * explainer shares the sensor's acceptance rule, so the line is the actual
   * failing rule (origin/axis/rule/cell/block) rather than a bare
   * `portal_frame_site:none`. Measured live 2026-09-21: the four-edge frame was
   * rejected because leftover cobblestone scaffolds occupied left-edge cells.
   */
  private logPortalFrameSiteRejection(state: WorldState): void {
    const rejection = explainNearestPortalFrameRejection(this.bot, sensorOptions(this.options), state.self)
    if (rejection === null) return
    const line = formatPortalFrameSiteRejected(rejection)
    if (line === this.lastPortalFrameRejectionKey) return
    this.lastPortalFrameRejectionKey = line
    this.logger.warn(
      'agent',
      line,
      {
        origin: rejection.origin,
        axis: rejection.widthAxis,
        rule: rejection.rule,
        cell: rejection.cell,
        block: rejection.block,
        existing: rejection.existing,
      },
      this.tickCounter,
    )
  }

  /**
   * Surface the generator's typed explore dead end
   * (`EXPLORE_ROUTE_BLOCKED goal=... item=... reason=no_frontier|unreachable|exhausted`)
   * once per distinct line. When the active collect goal's item has a declared
   * producer (a name-scanned block source or a mob drop) but the tick offers no
   * grounded route - not even a generic exploration frontier - the stall must be
   * an explicit typed fact instead of silent WAIT / a blind non-advancing dig.
   * The marker is deterministic CAN truth about the OFFERED set, never a
   * preference; the same fact is fed into the starvation `missing` evidence so a
   * persistent dead end reaches the existing capability-gap boundary.
   */
  private logExploreRouteBlocked(blocked: ExploreRouteBlocked | null): void {
    this.exploreRouteBlockedThisTick = blocked
    const key = blocked === null ? null : formatExploreRouteBlocked(blocked)
    if (key === this.lastExploreRouteBlockedKey) return
    this.lastExploreRouteBlockedKey = key
    if (blocked === null) return
    this.logger.warn(
      'agent',
      formatExploreRouteBlocked(blocked),
      { goal: blocked.goal, item: blocked.item, reason: blocked.reason },
      this.tickCounter,
    )
  }

  /**
   * Surface the generator's typed no-safe-descent fact
   * (`COLUMN_DESCENT_REFUSED reason=no_safe_step|no_tool|exhausted cell=x,y,z`)
   * once per distinct line. A body with no standable frontier beyond its own cell
   * has no walking route at all; when even the bounded, damage-free vertical step
   * down its own support column is unavailable, the dead end must be an explicit
   * fact instead of a bare WAIT. Deterministic SAFE truth about the OFFERED set,
   * never a preference; the token also rides the starvation `missing` evidence so
   * the cause reaches the capability-gap boundary.
   */
  private logColumnDescentRefusal(refusal: ColumnDescentRefusal | null): void {
    this.columnDescentRefusalThisTick = refusal
    const key = refusal === null ? null : formatColumnDescentRefused(refusal)
    if (key === this.lastColumnDescentRefusalKey) return
    this.lastColumnDescentRefusalKey = key
    if (refusal === null) return
    this.logger.warn(
      'agent',
      formatColumnDescentRefused(refusal),
      { ...refusal, goal: this.currentGoalKey() },
      this.tickCounter,
    )
  }

  /**
   * Typed `HUNT_CONTACT_UNREACHABLE` evidence: a sensed fight target that sits
   * above the body's walk envelope and for which the ONE vertical planner grounds
   * no route to its level. Code withholds the ATTACK for it BY CAN (the candidate
   * gate reports `needs_ascend` + `ascend_plan`), so the target is never leased as
   * a 0-swing `out_of_range` attempt; this line names the geometry and the
   * planner's own refusal. Deduplicated on the exact line so a stationary hover
   * does not repeat every tick.
   */
  private logContactRefusals(refusals: readonly ContactRefusal[]): void {
    const lines = refusals.map((refusal) =>
      formatContactUnreachable({
        actionId: `ATTACK:e${refusal.entityId}`,
        entityId: refusal.entityId,
        targetName: refusal.targetName,
        // A candidate-side refusal is always the GATE's proof: the contact geometry
        // alone ruled the melee envelope out before any lease existed.
        evidence: 'vertical_gap' as const,
        approach: refusal.approach,
        distance: refusal.distance,
        gapY: refusal.gapY,
        meleeReach: MELEE_THREAT_REACH,
        walkGap: MELEE_THREAT_REACH,
        ascentRefusal: refusal.reason,
        placeable: refusal.placeable,
      }),
    )
    const key = lines.join('|')
    if (key === this.lastContactRefusalKey) return
    this.lastContactRefusalKey = key
    for (let index = 0; index < refusals.length; index += 1) {
      const refusal = refusals[index]
      const line = lines[index]
      if (line === undefined) continue
      this.logger.warn(
        'agent',
        line,
        { ...refusal, goal: this.currentGoalKey() },
        this.tickCounter,
      )
    }
  }

  /**
   * The typed `PROSPECT_REFUSED` fact: the active descend/travel-to-acquire row
   * passed a sensed producer of its focus and the exposure dig that would have
   * offered it en route was refused by the world (hazard, unbreakable wall, no
   * support, missing harvest tool). Deduped like the column-descent refusal so a
   * blocked exposure is one line, and carried into the starvation `missing`
   * evidence so the descend step can never be the only thing on offer without its
   * stated mechanical cause.
   */
  private logProspectRefusal(refusal: ProspectRefusal | null): void {
    this.prospectRefusalThisTick = refusal
    const key = refusal === null ? null : formatProspectRefused(refusal)
    if (key === this.lastProspectRefusalKey) return
    this.lastProspectRefusalKey = key
    if (refusal === null) return
    this.logger.warn(
      'agent',
      formatProspectRefused(refusal),
      { ...refusal, goal: this.currentGoalKey() },
      this.tickCounter,
    )
  }

  /**
   * The typed "this collect focus has no available source" fact (SOURCE-side,
   * orthogonal to the MOVEMENT-side `EXPLORE_ROUTE_BLOCKED`). Emitted once per
   * distinct gap (deduped like the live-structure exclusions) so the semantic
   * layer sees WHY no route exists instead of the plan silently re-targeting a
   * stale remembered cell.
   */
  private logResourceSourceGap(gap: ResourceSourceGap | null): void {
    const key = gap === null ? null : formatResourceSourceGap(gap)
    if (key === this.lastSourceGapKey) return
    this.lastSourceGapKey = key
    if (gap === null) return
    this.logger.warn('agent', formatResourceSourceGap(gap), { ...gap }, this.tickCounter)
  }

  /**
   * The typed "a hungry body has NO grounded route to food" fact
   * (`FOOD_SOURCE_NONE item=food reason=no_source_sensed|source_withheld ...`).
   *
   * Bounded and descriptive: it names which affordances are missing (no edible
   * item held, no food animal sensed, no edible/ingredient block sensed, no
   * cookable recipe) and what the world still affords (`next=explore|escalate`).
   * Deduped per distinct line, so a stable dead end is one auditable fact, and
   * an escalating one (`starving=true`) is visible as the body reaches the
   * code-owned starvation floor. It never selects an action.
   */
  /**
   * Mirror the combat-kit prerequisite gap once per distinct line.
   *
   * M3's remaining items are mob drops, and the measured Nether arrival body
   * had no armour and no sword: the tick offered `hunt blaze ... with bare
   * fists` and nothing said the fight was unwinnable. This marker names the
   * target, the swing damage, the worn-armour count, what is missing, and
   * whichever grounded prerequisite route (sword craft / armour equip) the tick
   * actually offers - so a post-mortem can tell "walked into a fight it could
   * not win" apart from "had a route and lost".
   */
  private logCombatKitGap(gap: CombatKitGapEvidence | null): void {
    const line =
      gap === null
        ? null
        : formatCombatKitGap({
            focus: gap.focus,
            target: gap.target,
            distance: gap.distance,
            assessment: gap.assessment,
            heldItem: gap.heldItem,
            prerequisite: gap.prerequisite,
          })
    if (line === this.lastCombatKitGapLine) return
    this.lastCombatKitGapLine = line
    if (line === null || gap === null) return
    this.logger.warn(
      'agent',
      line,
      {
        focus: gap.focus,
        target: gap.target,
        distance: gap.distance,
        held: gap.heldItem,
        swingDamage: gap.assessment.swingDamage,
        armor: gap.assessment.wornArmorCount,
        missing: gap.assessment.missing.join(','),
        regenerating: gap.assessment.regenerating,
        prerequisite: gap.prerequisite,
        goal: this.currentGoalKey(),
      },
      this.tickCounter,
    )
  }

  private logFoodSourceGap(gap: FoodSourceGap | null): void {
    const key = gap === null ? null : formatFoodSourceGap(gap)
    if (key === this.lastFoodSourceGapKey) return
    this.lastFoodSourceGapKey = key
    if (gap === null) return
    this.logger.warn('agent', formatFoodSourceGap(gap), { ...gap, goal: this.currentGoalKey() }, this.tickCounter)
  }

  /**
   * The typed "the active collect goal needs a MOB DROP and no producer route is
   * on offer" fact
   * (`MOB_DROP_SOURCE_NONE item=ender_pearl reason=no_producer_sensed producers=["enderman"] sensed=0 offered=["explore"] next=explore`).
   *
   * This is the producer-side half of the M3 pearl gap: the run log had no line
   * that said the pearl need existed, that its producer is an enderman, that no
   * enderman was sensed, and that the tick was offering the generic exploration
   * arm instead. Descriptive only - it names the missing affordance and the
   * grounded next step, never a chosen action. Deduped per distinct line.
   */
  private logMobDropSourceGap(gap: MobDropSourceGap | null): void {
    const key = gap === null ? null : formatMobDropSourceGap(gap)
    if (key === this.lastMobDropGapKey) return
    this.lastMobDropGapKey = key
    if (gap === null) return
    this.logger.warn('agent', formatMobDropSourceGap(gap), { ...gap, goal: this.currentGoalKey() }, this.tickCounter)
  }

  /**
   * The typed "where this producer can exist, and whether the live context was
   * actually read" fact (`MOB_SPAWN_CONTEXT item=ender_pearl ... reason=met|context_unknown|light_unmet|dimension_unmet ... searchGrounded=true`).
   *
   * Emitted whenever the producer search is live and its spawn context could NOT
   * be positively confirmed, so the three shapes that all looked like
   * `MOB_DROP_SOURCE_NONE ... sensed=0` in the measured M3 run are now
   * distinguishable: a valid spawn context ahead, a context nobody could
   * measure, and a dimension that can never host the producer. A `met` verdict
   * is already carried on the offered search MOVE, so it is not mirrored again
   * here. Deduped per distinct line; descriptive only.
   */
  private logMobSpawnContext(gap: MobDropSourceGap | null): void {
    if (gap === null) {
      this.lastMobSpawnContextKey = null
      return
    }
    const context = gap.spawnContext
    if (context !== null && context.reason === 'met') return
    const line = formatMobSpawnContext(gap.item, gap.producers, context)
    if (line === this.lastMobSpawnContextKey) return
    this.lastMobSpawnContextKey = line
    this.logger.warn('agent', line, { item: gap.item, producers: gap.producers, spawnContext: context, goal: this.currentGoalKey() }, this.tickCounter)
  }

  /** Mirror an ignition refusal once per distinct line: malformed frame or no flint_and_steel. */
  private logIgnitionRefusal(refusal: IgnitionRefusal | null): void {
    const key = refusal === null ? null : refusal.line
    if (key === this.lastIgnitionRefusalKey) return
    this.lastIgnitionRefusalKey = key
    if (refusal === null) return
    this.logger.warn('agent', refusal.line, { reason: refusal.reason, frameShape: refusal.frameShape }, this.tickCounter)
  }

  /**
   * Mirror the smelt input prerequisite once per distinct line: which concrete
   * input the current smelt goal needs, whether it is held, and whether the
   * deterministic collect route was offered. Data-driven input (a `*_log` for
   * charcoal, raw_iron for iron_ingot), so the marker names the item the bot
   * must collect instead of letting the goal starve silently.
   */
  private logSmeltInputPrereq(state: WorldState, options: CandidateOptions): void {
    const entry = smeltInputPrereq(state, options)
    const line = entry === null ? null : formatSmeltInputPrereq(entry)
    if (line === this.lastSmeltInputPrereqLine) return
    this.lastSmeltInputPrereqLine = line
    if (entry === null || line === null) return
    this.logger.warn('agent', line, { ...entry }, this.tickCounter)
  }

  /**
   * Mirror the craft ingredient prerequisite once per distinct line: which
   * ingredient the current craft goal is missing and which producer the
   * candidate generator offers for it (`collect log` for the live wooden_pickaxe
   * shape, `craft oak_planks` when the plan already has an executable step).
   */
  private logCraftIngredientPrereq(state: WorldState, options: CandidateOptions): void {
    const entry = craftIngredientPrereq(state, options)
    const line = entry === null ? null : formatCraftIngredientPrereq(entry)
    if (line === this.lastCraftIngredientPrereqLine) return
    this.lastCraftIngredientPrereqLine = line
    if (entry === null || line === null) return
    this.logger.warn('agent', line, { ...entry }, this.tickCounter)
  }

  /**
   * Mirror the typed station fact for a station-requiring CRAFT goal once per
   * distinct line. OPERATOR RULE (station-use-before-craft; measured live
   * 2026-09-21): while 26 crafting tables and 17 furnaces were known, the queue
   * crafted a table and then a furnace. A station craft is withheld whenever the
   * world model already holds that station, so the state must SAY why the craft
   * disappeared: `CRAFT_STATION_ALREADY_KNOWN ... reason=... next=...` names the
   * known cells, the retired ones, and the route the generator offered instead
   * (`use_known_station` / `place_held` / the typed `capability_gap`).
   */
  private logCraftStationGap(state: WorldState, options: CandidateOptions): void {
    const gap = craftStationGap(state, options)
    const line = gap === null ? null : formatCraftStationGap(gap)
    if (line === this.lastCraftStationGapLine) return
    this.lastCraftStationGapLine = line
    if (gap === null || line === null) return
    this.logger.warn('agent', line, { ...gap }, this.tickCounter)
  }

  /**
   * Mirror the typed smelt route gap once per distinct line. A smelt goal whose
   * station/input/fuel precondition has no grounded route must SAY so instead of
   * presenting a bare `[WAIT]` set: `SMELT_STATION_MISSING` names what is
   * missing, how many stations are held/placed, and where the known ones are, so
   * the same starvation/escalation evidence that wakes System2 carries a typed
   * reason. The value is also kept for this tick's `CANDIDATE_STARVATION`.
   */
  private logSmeltRouteGap(state: WorldState, options: CandidateOptions): void {
    const gap = smeltRouteGap(state, options)
    this.smeltRouteGapThisTick = gap
    const line = gap === null ? null : formatSmeltRouteGap(gap)
    if (line === this.lastSmeltRouteGapLine) return
    this.lastSmeltRouteGapLine = line
    if (gap === null || line === null) return
    this.logger.warn('agent', line, { ...gap }, this.tickCounter)
  }

  /**
   * A `SMELT` candidate the guard refuses at a station the active smelt goal
   * keeps naming must SAY which station, how many attempts it has taken there,
   * and which grounded route the ladder offers instead. `NO_PATH` alone repeated
   * 200+ times is evidence without a typed outcome - the silent strategic-stall
   * family this lane closes. `next=travel` is the generic locomotion route
   * (a remembered/registered station), `next=place` a held furnace, and
   * `next=capability_gap` the typed no-route case.
   */
  private logSmeltStationRetry(candidate: Candidate): void {
    if (candidate.kind !== 'SMELT' || candidate.target === null) return
    const state = this.lastWorldState
    if (state === null) return
    const entry = smeltStationRetry(
      state,
      candidateOptions(
        this.options,
        this.recipeIndex,
        this.unreachableStationKeys(state),
        this.reachabilityGateOptions(),
        this.blacklistedMoveTargets(state),
        null,
        this.searchedSurfaceTargets,
      ),
    )
    if (entry === null) return
    const target = candidate.target
    if (target.x !== entry.station.x || target.y !== entry.station.y || target.z !== entry.station.z) return
    const attempts = this.moveFailMemory.check(this.currentDimension(), target).attempts
    const line = formatSmeltStationRetry(entry, attempts)
    if (line === this.lastSmeltStationRetryLine) return
    this.lastSmeltStationRetryLine = line
    this.logger.warn('agent', line, { station: entry.station, attempts, next: entry.next }, this.tickCounter)
  }

  /** Gate facts, shared by both candidate generations in one tick. */
  private reachabilityGateOptions(): ReachabilityGateOptions {
    if (this.gateOptions !== null && this.gateOptionsTick === this.tickCounter) return this.gateOptions
    // One plan per destination, two facts out of it: whether the body can walk
    // there at all, and whether the route it would walk stands it in a
    // dimension-transfer cell. Computing the plan twice would double the
    // pathfinder cost of the whole gate.
    const pathCache = new Map<string, { probe: 'reachable' | 'no_path'; transfer: DimensionTransferRoute }>()
    const attackPathCache = new Map<string, 'reachable' | 'no_path'>()
    const pathFacts = (position: Vec3Json) => {
      const key = `${position.x},${position.y},${position.z}`
      const cached = pathCache.get(key)
      if (cached !== undefined) return cached
      const result = this.computePathFacts(position)
      pathCache.set(key, result)
      return result
    }
    this.gateOptions = {
      memory: this.reachabilityProofs,
      pathProbe: (position) => pathFacts(position).probe,
      dimensionTransferProbe: (position) => pathFacts(position).transfer,
      attackPathProbe: (position) => {
        const key = `${position.x},${position.y},${position.z}`
        const cached = attackPathCache.get(key)
        if (cached !== undefined) return cached
        const result = this.canComputeMeleePath(position) ? 'reachable' : 'no_path'
        attackPathCache.set(key, result)
        return result
      },
      stationApproach: this.stationApproachProbe(),
      digApproach: this.digApproachProbe(),
    }
    this.gateOptionsTick = this.tickCounter
    return this.gateOptions
  }

  /**
   * SAFE/CAN: the route facts for one destination, from ONE plan.
   *
   * `probe` keeps the exact semantics `canComputePath` had (a `timeout` is not a
   * usable route fact, an exception is `no_path`), so no existing verdict moves.
   * `transfer` is the route-side half of the dimension-transfer invariant: does
   * the path the body would actually walk stand it in a lit portal block?
   * `unknown` when no plan exists (nothing is refused on an unavailable probe).
   */
  private computePathFacts(position: Vec3Json): { probe: 'reachable' | 'no_path'; transfer: DimensionTransferRoute } {
    if (this.bot.pathfinder === undefined) return { probe: 'no_path', transfer: 'unknown' }
    try {
      const goal = new goals.GoalBlock(position.x, position.y, position.z)
      const plan = this.bot.pathfinder.getPathTo(this.bot.pathfinder.movements, goal, PATH_PROBE_TIMEOUT_MS)
      if (plan.status !== 'success') return { probe: 'no_path', transfer: 'unknown' }
      return { probe: 'reachable', transfer: this.routeCrossesDimensionTransfer(plan.path) }
    } catch {
      return { probe: 'no_path', transfer: 'unknown' }
    }
  }

  /**
   * Does this planned route stand the body in a dimension-transfer cell? Every
   * path node is a cell the executor will occupy (feet), so the body's feet or
   * head being portal material at any node is exactly the transfer condition the
   * executor's own walk-in mechanic waits for.
   */
  private routeCrossesDimensionTransfer(path: readonly { x: number; y: number; z: number }[]): DimensionTransferRoute {
    for (const node of path) {
      if (this.botStandsInDimensionTransfer({ x: node.x, y: node.y, z: node.z })) return 'crosses'
    }
    return 'clear'
  }

  /** Live block truth: would standing with the feet at this cell transfer the body? */
  private botStandsInDimensionTransfer(feet: Vec3Json): boolean {
    const scratch = this.bot.entity.position.clone()
    const feetBlock = this.bot.blockAt(scratch.set(feet.x, feet.y, feet.z))
    if (isDimensionTransferBlock(feetBlock?.name)) return true
    const headBlock = this.bot.blockAt(scratch.set(feet.x, feet.y + 1, feet.z))
    return isDimensionTransferBlock(headBlock?.name)
  }

  /**
   * The #244 interaction stand, generalised from stations to blocked dig targets.
   * A blocked target's sensor adjacency fact only samples 12 neighbours; a stand
   * one stance away can still make the block diggable. The stand is resolved with
   * the SAME live passable+support+face-reach machinery the station path uses.
   * The expensive `canDig=false` path probe is budgeted per tick; beyond it the
   * verdict is left unknown and the guard's own path probe still gates the MOVE.
   */
  private digApproachProbe(): DigApproachProbe {
    const cache = new Map<string, DigApproachFact>()
    let pathProbes = 0
    const pathProbeBudget = 4
    return (block) => {
      const cacheKey = `${block.x},${block.y},${block.z}`
      const cached = cache.get(cacheKey)
      if (cached !== undefined) return cached
      const feet = this.bot.entity.position
      const stands = interactionStandCandidates(
        block,
        { x: feet.x, y: feet.y, z: feet.z },
        {
          passable: (x, y, z) => this.botPassableAt(x, y, z),
          solidSupport: (x, y, z) => this.botSolidSupportAt(x, y, z),
        },
        this.options.reach,
      )
      const stand = stands[0] ?? null
      let fact: DigApproachFact
      if (stand === null) {
        fact = { approach: null, path: null }
      } else if (pathProbes < pathProbeBudget) {
        pathProbes += 1
        fact = { approach: stand, path: this.canComputePathNear(stand) ? 'reachable' : 'no_path' }
      } else {
        fact = { approach: stand, path: null }
      }
      cache.set(cacheKey, fact)
      return fact
    }
  }

  private stationApproachProbe(): StationApproachProbe {
    const cache = new Map<string, StationApproachFact>()
    return (station, kind) => {
      const cacheKey = `${kind}:${station.x},${station.y},${station.z}`
      const cached = cache.get(cacheKey)
      if (cached !== undefined) return cached
      const feet = this.bot.entity.position
      const stands = interactionStandCandidates(
        station,
        { x: feet.x, y: feet.y, z: feet.z },
        {
          passable: (x, y, z) => this.botPassableAt(x, y, z),
          solidSupport: (x, y, z) => this.botSolidSupportAt(x, y, z),
        },
        this.options.reach,
      )
      const stand = stands[0] ?? null
      let fact: StationApproachFact
      if (stand === null) {
        this.noteStationUnreachable(kind, station, 'no_interaction_stand')
        fact = { approach: null, path: null }
      } else {
        const path = this.canComputePathNear(stand) ? 'reachable' : 'no_path'
        if (path === 'no_path') this.noteStationUnreachable(kind, station, 'no_path_to_stand')
        else this.forgetStationUnreachable(kind, station)
        fact = { approach: stand, path }
      }
      cache.set(cacheKey, fact)
      return fact
    }
  }

  private botPassableAt(x: number, y: number, z: number): boolean {
    const block = this.bot.blockAt(this.bot.entity.position.clone().set(x, y, z))
    return block === null || block.boundingBox === 'empty'
  }

  private botSolidSupportAt(x: number, y: number, z: number): boolean {
    const block = this.bot.blockAt(this.bot.entity.position.clone().set(x, y, z))
    return block !== null && block.boundingBox === 'block'
  }

  private canComputePathNear(position: Vec3Json): boolean {
    if (this.bot.pathfinder === undefined) return false
    try {
      const goal = new goals.GoalNear(position.x, position.y, position.z, 1)
      const plan = this.bot.pathfinder.getPathTo(this.bot.pathfinder.movements, goal, PATH_PROBE_TIMEOUT_MS)
      return plan.status !== 'noPath'
    } catch {
      return false
    }
  }

  private noteStationUnreachable(
    kind: 'furnace' | 'crafting_table',
    station: Vec3Json,
    reason: StationApproachRefusal,
  ): void {
    const key = formatStationUnreachable(kind, station, reason)
    if (this.stationApproachLogged.has(key)) return
    this.stationApproachLogged.add(key)
    this.logger.warn('agent', key, { kind, station, reason }, this.tickCounter)
  }

  private forgetStationUnreachable(kind: 'furnace' | 'crafting_table', station: Vec3Json): void {
    for (const reason of ['no_interaction_stand', 'no_path_to_stand'] as const) {
      this.stationApproachLogged.delete(formatStationUnreachable(kind, station, reason))
    }
  }

  /**
   * Issue #43: the fuel subgoal is inventory-first. When the live inventory
   * already holds a valid fuel item the plan must not obtain another one, so the
   * skip is logged once per goal+item and retrieval is suppressed downstream.
   */
  private logFuelSatisfaction(state: WorldState): void {
    const current = this.queue.current
    if (!goalWantsFuel(current)) return
    const satisfaction = fuelSatisfaction(state)
    if (satisfaction === null) return
    const key = `${current?.id ?? 'none'}:${satisfaction.item}:${satisfaction.count}`
    if (this.fuelSatisfiedKey === key) return
    this.fuelSatisfiedKey = key
    this.logger.warn(
      'agent',
      formatFuelSatisfied(satisfaction.item, satisfaction.count),
      { item: satisfaction.item, have: satisfaction.count, goal: current?.description ?? null, action: 'skip' },
      this.tickCounter,
    )
  }

  /**
   * Issue #43: a MOVE/RETRIEVE target above the climb limit is unreachable with
   * `canDig=false`. Log it and charge the failure memory so repeated selection
   * exhausts MOVE_FAILURE_LIMIT and the generator stops re-issuing it, letting
   * another candidate (descend/explore/reachable target) win instead.
   */
  private checkUnreachableMove(candidate: Candidate, state: WorldState): void {
    const reason = controllerUnreachableMoveReason(candidate, state)
    if (reason === null) return
    const { target, dy } = reason
    const key = `${candidate.id}:${dy}`
    if (!this.loggedUnreachableMoves.has(key)) {
      this.loggedUnreachableMoves.add(key)
      this.logger.warn(
        'agent',
        formatMoveUnreachable(target, dy),
        { actionId: candidate.id, dy, kind: candidate.kind, limit: MOVE_VERTICAL_GAP_LIMIT },
        this.tickCounter,
      )
    }
    this.noteCandidateFailure(candidate.id)
    this.recordMoveFailure(candidate, 'unreachable')
  }

  /** #8: drop movement targets still inside their blacklist cooldown. */
  private filterMoveCandidates(candidates: readonly Candidate[], state: WorldState, log = true): Candidate[] {
    const dimension = state.self.dimension
    const { kept, skipped } = filterBlacklistedMoves(candidates, this.moveFailMemory, dimension)
    if (!log) return kept
    for (const entry of skipped) {
      this.logger.warn(
        'agent',
        formatMoveTargetSkipped(entry.key, entry.attempts, entry.cooldownSeconds),
        {
          actionId: entry.candidate.id,
          key: entry.key,
          attempts: entry.attempts,
          cooldown: entry.cooldownSeconds,
          reason: entry.reason,
        },
        this.tickCounter,
      )
    }
    return kept
  }

  private rememberMoveTarget(candidate: Candidate): void {
    if (candidate.target === null || !isTrackedMoveKind(candidate.kind)) return
    const previous = this.lastMoveTarget
    if (previous !== null) this.previousMoveTarget = previous
    this.lastMoveTarget = { dimension: this.currentDimension(), position: { ...candidate.target } }
  }

  private recordMoveFailure(candidate: Candidate, reason: MoveFailureReason): void {
    if (candidate.target === null || !isTrackedMoveKind(candidate.kind)) return
    const dimension = this.currentDimension()
    const result = this.moveFailMemory.record(dimension, candidate.target, reason)
    const key = moveFailureKey(dimension, candidate.target)
    this.logger.warn(
      'agent',
      formatMoveFailMem(key, result.entry.attempts, reason),
      { actionId: candidate.id, key, attempts: result.entry.attempts, reason, kind: candidate.kind },
      this.tickCounter,
    )
    this.notifyMoveFailureMemory()
    if (!result.newlyBlacklisted) return
    this.logger.warn(
      'agent',
      formatMoveTargetSkipped(key, result.entry.attempts, this.remainingCooldownSeconds(result.entry.blacklistedUntil)),
      { actionId: candidate.id, key, attempts: result.entry.attempts, reason },
      this.tickCounter,
    )
  }

  /**
   * Telemetry truth for a skip: the cooldown actually in force, including the
   * #360 oscillation escalation. Reporting the base cooldown would log
   * `cooldown=30` for a 60 s/10 min escalated suppression, which is exactly the
   * "skip logged, surface unchanged" shape this fix closes.
   */
  private remainingCooldownSeconds(blacklistedUntil: number, now = Date.now()): number {
    return Math.max(0, Math.ceil((blacklistedUntil - now) / 1000))
  }

  private recordMoveSuccess(candidate: Candidate): void {
    if (candidate.target === null || !isTrackedMoveKind(candidate.kind)) return
    this.resetDescendBudgetAfterWorldChange(candidate.id, 'verified_move')
    const dimension = this.currentDimension()
    const key = moveFailureKey(dimension, candidate.target)
    // A verified micro-MOVE inside a low-efficiency window is mechanical success, not
    // progress. Resetting the failure memory there is exactly what let the live
    // 48-minute A<->B loop undo every oscillation blacklist (issue #360: 401
    // OSCILLATION_DETECTED vs 49 blacklists, 1533 blocks travelled in a one-block
    // box). Keeping the memory means the loop's own cells stay suppressed and the body
    // must change neighbourhood instead of re-winning the same step.
    if (this.lastLocomotionEfficiency < MOVE_PROGRESS_EFFICIENCY_FLOOR) {
      this.logger.info(
        'agent',
        `MOVE_FAILMEM_RESET_SKIPPED efficiency=${this.lastLocomotionEfficiency}% reason=strategic_non_progress`,
        { actionId: candidate.id, key },
        this.tickCounter,
      )
      return
    }
    if (!this.moveFailMemory.reset(dimension, candidate.target)) return
    if (this.lastMoveTarget !== null && this.lastMoveTarget.position.x === candidate.target.x && this.lastMoveTarget.position.z === candidate.target.z) {
      this.lastMoveTarget = null
    }
    this.logger.info('agent', formatMoveFailMemReset(key), { actionId: candidate.id, key, kind: candidate.kind }, this.tickCounter)
    this.notifyMoveFailureMemory()
  }

  private resetDescendBudgetAfterWorldChange(actionId: string, reason: 'verified_mine' | 'verified_move'): void {
    const dig = this.digMemory.snapshot()
    if (!dig.descendLimitReached) return
    this.digMemory.resetDescendBudget()
    this.logger.info(
      'agent',
      `DESCEND_BUDGET_RESET actionId=${actionId} reason=${reason}`,
      { actionId, previousNoProgress: dig.descendNoProgress, reason },
      this.tickCounter,
    )
  }

  private notifyMoveFailureMemory(): void {
    const callback = this.options.onMoveFailureMemoryChange
    if (callback === undefined) return
    try {
      callback(this.moveFailMemory.snapshot().map((entry) => ({ ...entry })))
    } catch (error) {
      this.logger.warn('agent', 'MOVE_FAILMEM_PERSIST_FAILED', { message: error instanceof Error ? error.message : String(error) }, this.tickCounter)
    }
  }

  private currentDimension(): string {
    const game = this.bot.game
    return game === undefined ? 'overworld' : game.dimension
  }

  /**
   * #8: an A/B position pair repeating without progress is an oscillation, not a
   * path. Log it, blacklist the target that caused it, and clear the window so the
   * detector cannot fire on the same stale samples again.
   */
  private detectMoveOscillation(): void {
    const detection = detectOscillation(this.positionWindow)
    if (!detection.detected || detection.from === null || detection.to === null) return
    const fromKey = `${detection.from.x},${detection.from.y},${detection.from.z}`
    const toKey = `${detection.to.x},${detection.to.y},${detection.to.z}`
    const pair = `${fromKey}|${toKey}`
    const now = Date.now()
    this.positionWindow.length = 0
    if (pair === this.lastOscillationPair && now - this.lastOscillationAt < OSCILLATION_REPEAT_LOG_MS) return
    this.lastOscillationPair = pair
    this.lastOscillationAt = now
    this.logger.warn(
      'agent',
      formatOscillationDetected(detection.from, detection.to, detection.cycles, 'blacklist'),
      { from: fromKey, to: toKey, cycles: detection.cycles, action: 'blacklist' },
      this.tickCounter,
    )
    // Blacklist both ends of the observed loop.  Blacklisting only the last
    // selected target leaves the opposite endpoint available, so Jev can
    // immediately choose A after B was retired and keep walking A<->B.
    const dimension = this.currentDimension()
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
    if (this.lastMoveTarget !== null && this.lastMoveTarget.dimension === dimension) trackedTargets.push(this.lastMoveTarget.position)
    if (this.previousMoveTarget !== null && this.previousMoveTarget.dimension === dimension) trackedTargets.push(this.previousMoveTarget.position)
    for (const position of [...trackedTargets, detection.from, detection.to]) {
      if (position === null) continue
      const key = moveFailureKey(dimension, position)
      if (seen.has(key)) continue
      seen.add(key)
      const result = this.moveFailMemory.blacklist(dimension, position, 'no_progress')
      const cooldownSeconds = this.remainingCooldownSeconds(result.entry.blacklistedUntil, now)
      this.logger.warn(
        'agent',
        formatMoveTargetSkipped(key, result.entry.attempts, cooldownSeconds),
        { key, attempts: result.entry.attempts, reason: 'oscillation', cooldown: cooldownSeconds },
        this.tickCounter,
      )
    }
    if (seen.size > 0) this.notifyMoveFailureMemory()
    this.logger.warn(
      'agent',
      `LOCAL_MOVE_OSCILLATION from=${fromKey} to=${toKey} cycles=${detection.cycles} system2=false`,
      { from: fromKey, to: toKey, cycles: detection.cycles, boundary: 'local_recovery' },
      this.tickCounter,
    )
  }

  private syntheticWait(): JevResult {
    const callId = randomUUID()
    return {
      callId,
      policy: this.jev.kind,
      source: this.jev.kind === 'typesafe' ? 'jev' : 'fallback',
      model: this.jev.model,
      latencyMs: 0,
      usage: null,
      answers: {
        action: {
          name: 'action',
          type: 'choice',
          value: 'WAIT',
          probability: 1,
          confidence: null,
          probabilities: { WAIT: 1 },
          legend: null,
          note: 'synthetic WAIT after a policy failure',
        },
      },
    }
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

  private finish(stopped: RunSummary['stopped'], success: boolean): void {
    if (!this.running) return
    this.running = false
    this.saveLedger()
    this.scheduler.stop()
    this.clearDecisionTimer()
    if (this.watchdog !== null) {
      clearTimeout(this.watchdog)
      this.watchdog = null
    }
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

export function pickHigherPriority(current: TriggerEvent | null, next: TriggerEvent): TriggerEvent {
  if (current === null) return next
  return TRIGGER_PRIORITY[next.trigger] > TRIGGER_PRIORITY[current.trigger] ? next : current
}

function isActionTimeout(result: ExecutionResult): boolean {
  return result.failure === 'path_timeout' || result.failure === 'dig_timeout'
}

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

function sensorOptions(options: JevAgentOptions, worldRevision: number | null = null): SensorOptions {
  return { ...defaultSensorOptions, scanRadius: options.scanRadius, reach: options.reach, worldRevision }
}

function candidateOptions(
  options: JevAgentOptions,
  recipes: RecipeIndex,
  unreachableStations: ReadonlySet<string> = new Set<string>(),
  reachability: ReachabilityGateOptions | null = null,
  blacklistedMoveTargets: ReadonlySet<string> = new Set<string>(),
  portalFrame: PortalFrameValidation | null = null,
  searchedSurfaceTargets: ReadonlySet<string> = new Set<string>(),
  portalEntry: PortalEntryPlan | null = null,
  retiredPlaceItems: ReadonlySet<string> = new Set<string>(),
): CandidateOptions {
  return {
    ...defaultCandidateOptions,
    reach: options.reach,
    recipes,
    unreachableStations,
    blacklistedMoveTargets,
    searchedSurfaceTargets,
    reachability,
    portalFrame,
    portalEntry,
    retiredPlaceItems,
    prereqRankPolicy: options.prereqRankPolicy,
  }
}

function subgoalState(goal: QueuedGoal, have: number): GoalState {
  const required = Math.max(1, goal.requiredCount)
  return {
    id: goal.id,
    description: goal.description,
    targetItem: goal.targetItem ?? '',
    requiredCount: required,
    startCount: 0,
    haveCount: have,
    progress: Math.min(1, have / required),
    complete: have >= required,
    startedAtMs: goal.createdAt,
  }
}

function goalWithHave(goal: GoalState, have: number): GoalState {
  const required = Math.max(1, goal.requiredCount)
  return {
    ...goal,
    haveCount: have,
    progress: Math.min(1, have / required),
    complete: have >= required,
  }
}

function currentFocusItem(goal: GoalState, queue: GoalQueueState): string | null {
  return queue.current?.targetItem ?? goal.targetItem ?? null
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

/**
 * The damage ORIGIN a scheduler trigger carries, validated, or null.
 *
 * The scheduler only ever sets `attackerPosition` from a finite server-stated
 * coordinate (the `damage_event` packet's `sourcePosition`, or the resolved
 * source entity's position), but this is the boundary where an untrusted
 * payload could reach the durable signal: a non-finite or malformed value is
 * dropped here so "unknown" stays unknown instead of poisoning a distance
 * comparison downstream.
 */
function damageOrigin(value: unknown): Vec3Json | null {
  if (typeof value !== 'object' || value === null) return null
  const point = value as { x?: unknown; y?: unknown; z?: unknown }
  if (typeof point.x !== 'number' || typeof point.y !== 'number' || typeof point.z !== 'number') return null
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z)) return null
  return { x: point.x, y: point.y, z: point.z }
}
