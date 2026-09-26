// index.ts - the Mineflayer PLUGIN entry point.
//
// Mineflayer is designed for `bot.loadPlugin()`; pathfinder and PVP are external
// plugins and so is this. Nothing here forks, patches or vendors Mineflayer -
// it is the published `bot.loadPlugin` extension API only.
//
//   mineflayer -> pathfinder/tool plugins -> jev-agent plugin -> brain/policy/executor
//
// Usage:
//   bot.loadPlugin(pathfinder)
//   bot.loadPlugin(jevAgent)
//   bot.jev.setOptions({ goalCount: 3 })
//   bot.jev.start()
import type { Bot } from 'mineflayer'
import { defaultJevAgentOptions, JevController } from './controller.ts'
import type { KernelReachAuthority } from './vtr/kernel-shadow-map.ts'
import type { EscalationReason, JevAgentOptions, RunSummary } from './controller.ts'
import { buildWorldState, defaultSensorOptions, makeGoal, toVec3 } from './state.ts'
import type { ActiveItemUseState, AgentSignals, BlockState, EntityState, GoalState, SelfState, Vec3Json, WorldState } from './state.ts'
import { applyReachabilityGate, defaultCandidateOptions, formatExploreRouteBlocked, formatResourceSourceExclusion, generateCandidates, generateGroundedCandidates, resourceDimensionMatches, resourceDimensionRefusals, resourceDimensionVerdict, resourceSourceExclusions } from './candidates.ts'
import type { Candidate, CandidateAffordance, CandidateKind, CandidateOptions, CandidateReachability, ExploreRouteBlocked, GroundedCandidatesResult, ReachabilityGateOptions, ResourceSourceExclusion } from './candidates.ts'
import { attachResult, makeDecisionRecord, stableStateHash } from './decisionlog.ts'
import type { CalibrationEntry, DecisionJevLog, DecisionLlmLog, DecisionLlmResummonLog, DecisionRecord, DecisionRecordProvenance, DecisionResultLog, DecisionSubgoalLog } from './decisionlog.ts'
import { createRecipeIndex } from './crafting.ts'
import type { CraftOp, CraftPlanResult, RecipeIndex, RecipeIngredient, RecipeVariant } from './crafting.ts'
import { emptyGoalQueueState, GoalQueue, toGoalQueueStateLog } from './goalQueue.ts'
import type { GoalKind, GoalOrigin, GoalQueueState, GoalQueueStateLog, GoalStatus, PlannedGoal, QueuedGoal } from './goalQueue.ts'
import { ACTING_KINDS, guardCandidate, guardDecision } from './policy.ts'
import type { GuardCode, GuardContext, GuardPhase, GuardResult, InFlightAction } from './policy.ts'
import { Executor, defaultExecutorOptions } from './executor.ts'
import type { ActuationMode, ClaimResult, CurrentAction, ExecutionResult, ExecutorHooks, ExecutorOptions, FailureCode, PathCompletedEvent, PathFailedEvent } from './executor.ts'
import { DANGER_CONFIDENCE_THRESHOLD, gateDanger, gateScore } from './gating.ts'
import type { GatedScore } from './gating.ts'
import { abandonRequested, AUTHORITATIVE_QUESTION_NAMES, betaShadowDecision, booleanEstimate, booleanEstimates, createJevPolicy, decisionIdFrom, EventLogger, formatBetaShadow, JsonlWriter, questionNamesFor, QUESTION_NAMES, resolveBetaAuthority, SAFETY_QUESTION_NAMES, SHADOW_QUESTION_NAMES, shouldRetreatFrom, writeOutcome } from './jev.ts'
import type { BooleanEstimate, BetaShadow, JevAnswer, JevCallRecord, JevOutcomeRecord, JevPolicy, JevQuestionType, JevRequest, JevResult, JevSource, JevUsage, QuestionName, QuestionSetKind } from './jev.ts'
import { betaAuthorityDecision, formatJevHeads } from './betaAuthority.ts'
import type { BetaAuthorityDecision, BetaAuthorityInput } from './betaAuthority.ts'
import { causalRecord, completeCausalChain, formatCausalLine, makeCausalStamp, makeChainId, optionIdForGoal } from './causal.ts'
import type { CausalChain, CausalGoalRef, CausalStamp } from './causal.ts'
import { DECISION_TRIGGERS, DecisionScheduler, PREEMPTIVE_TRIGGERS, defaultSchedulerOptions } from './scheduler.ts'
import type { DecisionTrigger, SchedulerOptions as JevSchedulerOptions, TriggerEvent } from './scheduler.ts'
import { buildStubPlan, evaluateSummonConditions, FixedPlanSystem2, LLM_SUMMON_REASONS, M1_PLAN_JSON, planFromJson, SINGLE_SHOT_PLANNER_MODEL, STUB_HORIZON_TAIL, STUB_SYSTEM2_MODEL, StubSystem2 } from './system2.ts'
import type { LlmSummonReason, PlanJson, PlanSubgoalJson, System2Brain, System2Objective, System2Outcome, System2Plan, System2PlanRecord, System2PlanRequest, SummonConditions } from './system2.ts'

declare module 'mineflayer' {
  interface Bot {
    jev: JevController
  }
}

const registered = new WeakSet<Bot>()

/**
 * Register the agent on a bot. Side-effect free: it only attaches the
 * controller, so the caller decides when to `start()` (typically on 'spawn').
 * The caller MUST supply the host-owned V4.1.2 kernel authority gate — the
 * plugin cannot mint one, so a plain `bot.loadPlugin(jevAgent)` is no longer a
 * valid semantic entry point (use the buddy-driver generation composition).
 */
export function jevAgent(bot: Bot, kernelAuthority: KernelReachAuthority): void {
  if (registered.has(bot)) return
  registered.add(bot)
  bot.jev = new JevController(bot, { ...defaultJevAgentOptions, kernelAuthority })
}

export default jevAgent

export { JevController, defaultJevAgentOptions, Executor, defaultExecutorOptions }
export { buildWorldState, makeGoal, toVec3, defaultSensorOptions }
export { generateCandidates, generateGroundedCandidates, applyReachabilityGate, defaultCandidateOptions, ACTING_KINDS }
export {
  formatResourceSourceExclusion,
  resourceSourceExclusions,
  // #14 fail-closed attribution: the typed refusal surface and the predicate it
  // mirrors, so a consumer can tell "another world" from "no world recorded".
  resourceDimensionRefusals,
  resourceDimensionMatches,
  resourceDimensionVerdict,
  formatExploreRouteBlocked,
}
export { guardCandidate, guardDecision }
export { createJevPolicy, EventLogger, JsonlWriter, writeOutcome, decisionIdFrom }
export { QUESTION_NAMES, AUTHORITATIVE_QUESTION_NAMES, SAFETY_QUESTION_NAMES, SHADOW_QUESTION_NAMES, questionNamesFor, shouldRetreatFrom, abandonRequested }
export { booleanEstimate, booleanEstimates, betaShadowDecision, formatBetaShadow, resolveBetaAuthority }
export { betaAuthorityDecision, formatJevHeads }
export { makeChainId, makeCausalStamp, completeCausalChain, optionIdForGoal, formatCausalLine, causalRecord }
export type { BooleanEstimate, BetaShadow, CausalChain, CausalGoalRef, CausalStamp }
export type { BetaAuthorityDecision, BetaAuthorityInput }
export type { QuestionName, QuestionSetKind }
export { DECISION_TRIGGERS, DecisionScheduler, PREEMPTIVE_TRIGGERS, defaultSchedulerOptions }
export { DANGER_CONFIDENCE_THRESHOLD, gateDanger, gateScore }
export { attachResult, makeDecisionRecord, stableStateHash }
// Issue #437: the Skill <-> Jev semantic boundary (projection, decision epochs,
// stable candidate identity, SkillOutcomePacket).
export {
  buildJevSemanticProjection,
  buildSemanticCombatFacts,
  buildSkillOutcomePacket,
  classifyProjectionChange,
  classifySemanticBoundary,
  commitmentRefFor,
  dedupeSemanticCandidates,
  diffSemanticProjections,
  failureBandOf,
  foodBand,
  formatEpochEnd,
  formatEpochStart,
  formatJevCandidateSet,
  formatJevStateProjection,
  formatSkillCommit,
  formatSkillOutcomePacket,
  formatStaleResultDropped,
  healthBand,
  JEV_BOUNDARY_MARKERS,
  JEV_CANDIDATE_SET,
  JEV_DECISION_EPOCH_END,
  JEV_DECISION_EPOCH_START,
  JEV_PROJECTION_LIMITS,
  JEV_PROJECTION_SCHEMA,
  JEV_PROJECTION_VERSION,
  JEV_STATE_PROJECTION,
  JevDecisionEpochs,
  mandatoryPolicyBoundary,
  meaningfulEventKinds,
  policyBoundary,
  projectionBytes,
  projectionHash,
  projectionModelView,
  repointReplayedChoice,
  semanticCandidateKey,
  semanticCandidateSet,
  semanticTargetRef,
  SKILL_COMMIT,
  SKILL_OUTCOME_PACKET,
  STALE_JEV_RESULT_DROPPED,
  terminalReasonFor,
} from './jevSemanticProjection.ts'
export type {
  CompactOutcome,
  SemanticCombatEscape,
  SemanticCombatFacts,
  SemanticCombatInput,
  SemanticCombatTarget,
  SemanticCombatThreat,
  DecisionEpoch,
  GroundedFact,
  JevSemanticProjection,
  PreviousDecisionFacts,
  ProgressSummary,
  SemanticCandidateView,
  SemanticDelta,
  SemanticProjectionInput,
  SemanticTargetRef,
  SkillOutcomePacket,
  SkillTerminalReason,
  VerificationSummary,
} from './jevSemanticProjection.ts'
export { GoalQueue, emptyGoalQueueState, toGoalQueueStateLog }
export { StubSystem2, buildStubPlan, evaluateSummonConditions, LLM_SUMMON_REASONS, STUB_HORIZON_TAIL, STUB_SYSTEM2_MODEL }
export { FixedPlanSystem2, SINGLE_SHOT_PLANNER_MODEL, M1_PLAN_JSON, planFromJson }
export { createRecipeIndex }
export type { CraftOp, CraftPlanResult, RecipeIndex, RecipeIngredient, RecipeVariant }
export type { PlanJson, PlanSubgoalJson, DecisionLlmLog, DecisionSubgoalLog }
export type {
  JevAgentOptions,
  RunSummary,
  EscalationReason,
  WorldState,
  SelfState,
  ActiveItemUseState,
  GoalState,
  AgentSignals,
  BlockState,
  EntityState,
  Vec3Json,
  Candidate,
  CandidateAffordance,
  CandidateKind,
  CandidateOptions,
  CandidateReachability,
  ExploreRouteBlocked,
  GroundedCandidatesResult,
  ReachabilityGateOptions,
  ResourceSourceExclusion,
  GuardCode,
  GuardContext,
  GuardPhase,
  GuardResult,
  InFlightAction,
  ExecutionResult,
  ActuationMode,
  ClaimResult,
  CurrentAction,
  ExecutorHooks,
  ExecutorOptions,
  FailureCode,
  PathCompletedEvent,
  PathFailedEvent,
  JevPolicy,
  JevRequest,
  JevResult,
  JevAnswer,
  JevSource,
  JevUsage,
  JevCallRecord,
  JevOutcomeRecord,
  JevQuestionType,
  DecisionRecord,
  DecisionRecordProvenance,
  DecisionJevLog,
  DecisionLlmResummonLog,
  DecisionResultLog,
  CalibrationEntry,
  DecisionTrigger,
  TriggerEvent,
  JevSchedulerOptions,
  GatedScore,
  GoalKind,
  GoalOrigin,
  GoalStatus,
  GoalQueueState,
  GoalQueueStateLog,
  PlannedGoal,
  QueuedGoal,
  LlmSummonReason,
  System2Brain,
  System2Objective,
  System2Outcome,
  System2Plan,
  System2PlanRecord,
  System2PlanRequest,
  SummonConditions,
}
