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
import { blockId, countBlockedLogs, craftIngredientPrereq, defaultCandidateOptions, formatCraftIngredientPrereq, formatFuelSatisfied, formatLogRoute, formatPlaceRefusal, formatSmeltInputPrereq, fuelSatisfaction, furnacePrereqInputFromState, generateGroundedCandidates, goalCollectsFuel, goalWantsFuel, logRouteOf, selfContainedCraftCandidates, smeltInputPrereq, staleKnownResources } from './candidates.ts'
import type { Candidate, CandidateOptions, CandidateReachability, PlaceRefusal, ReachabilityGateOptions } from './candidates.ts'
import { capabilityKey, formatCandidateWithheld, formatReachability } from './reachability.ts'
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
  CANDIDATE_COMMIT_RELEASED,
  CANDIDATE_FLAP,
  evaluateCandidateFlap,
} from './candidateCommitment.ts'
import type { CandidateFlapState, FlapCandidate } from './candidateCommitment.ts'
import { createRecipeIndex } from './crafting.ts'
import type { RecipeIndex } from './crafting.ts'
import { attachResult, makeDecisionRecord, stableStateHash } from './decisionlog.ts'
import type { DecisionJevLog, DecisionLlmLog, DecisionLlmResummonLog, DecisionRecord, DecisionSubgoalLog } from './decisionlog.ts'
import { ActionCancelled, defaultExecutorOptions, Executor } from './executor.ts'
import type { ActuationMode, ExecutionResult, ExecutorOptions, FailureCode } from './executor.ts'
import type { ActuationPort } from './actuationPort.ts'
import { applyDangerGate, DANGER_CONFIDENCE_THRESHOLD, gateBoolean, gateDanger, gateScore } from './gating.ts'
import type { GatedScore } from './gating.ts'
import { GoalQueue, toGoalQueueStateLog } from './goalQueue.ts'
import type { GoalQueueSnapshot, GoalQueueState, PlannedGoal, QueuedGoal } from './goalQueue.ts'
import { compilePlannedGoal, evaluatePredicates, makeOptionSnapshot, queuedToPlanned } from './optionSpec.ts'
import type { OptionWorldSnapshot, Predicate } from './optionSpec.ts'
import { PICKAXE_TIER_ORDER, smeltInputFor } from './gameData.ts'
import { abandonRequested, betaShadowDecision, createJevPolicy, decisionIdFrom, EventLogger, formatBetaShadow, JsonlWriter, questionNamesFor, resolveBetaAuthority, writeOutcome } from './jev.ts'
import type { AgentLevel } from './jev.ts'
import type { JevPolicy, JevResult, QuestionSetKind } from './jev.ts'
import { guardDecision, guardRejectionChargesOption } from './policy.ts'
import { formatMoveUnreachable, MOVE_VERTICAL_GAP_LIMIT, unreachableMove } from './policy.ts'
import type { GuardCode, GuardResult, InFlightAction } from './policy.ts'
import { DECISION_TRIGGERS, DecisionScheduler, PREEMPTIVE_TRIGGERS, TRIGGER_PRIORITY } from './scheduler.ts'
import type { DecisionTrigger, TriggerEvent } from './scheduler.ts'
import { buildWorldState, defaultSensorOptions, isSensedStation, makeGoal, refreshGoalProgress } from './state.ts'
import type { AgentSignals, GoalState, KnownResource, SensorOptions, Vec3Json, WorldState } from './state.ts'
import { currentOptionContextForQueuedGoal } from './optionSpec.ts'
import type { CurrentOptionContext } from './optionSpec.ts'
import { isResourceClass, matchesResourceClass, resourceMatches } from './resourceClass.ts'
import { evaluateCapabilityGap, formatCapabilityGap, formatCapabilityGapPolicy, formatReplanThrottled, ReplanThrottle, resolveReplanPositionDelta, resolveReplanThrottleMs } from './replanThrottle.ts'
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
import { ASCENT_PROGRESS_EPSILON, evaluateRetrievalProgress, formatKnownResourceUnreachable, formatRetrieveStalled, planRetrievalEscalation, resolveRetrievalStallTicks } from './verticalPlan.ts'
import { evaluateDescendProgress, formatDescendProgress, formatDescendStalled, resolveDescendNoCandidateTicks, resolveDescendStallTicks, DESCEND_PROGRESS_LOG_TICKS } from './descendPlan.ts'
import type { DescendProgressState } from './descendPlan.ts'
import { DigMemory } from './worldMemory.ts'
import type { DigDir } from './worldMemory.ts'
import { evaluateSpatialPredicate, predicateForGoal } from './predicateGoal.ts'
import type { PredicateEvaluation } from './predicateGoal.ts'
import {
  classifyAbandonReason,
  evaluatePlaceRetry,
  formatAbandonReason,
  isFurnacePrerequisiteOption,
  PLACE_RETRY_LIMIT,
  prerequisiteOptionName,
  shouldAdoptAbandon,
} from './placementGuard.ts'
import type { AbandonReason, PrerequisiteProtection } from './placementGuard.ts'
import {
  evaluatePrereqStall,
  evaluateRetrieveAbandon,
  formatPrereqOptionDetail,
  formatPrereqOptionFor,
  formatPrereqRankShadow,
  formatPrereqSwitch,
  isInventorySourced,
  knownStationKey,
  nextPrereqPath,
  planPrereqOptions,
  preferPrereqPath,
  prereqOptionReason,
  prereqProgressSignature,
  prereqSubjectForGoal,
  resolvePrereqRankPolicy,
  resolvePrereqStallTicks,
  selectPrereqPath,
} from './prereqOption.ts'
import type { PrereqDecision, PrereqPath, PrereqProgress, PrereqRankPolicy, RetrieveUnverifiedState } from './prereqOption.ts'
import { evaluateOscillation, positionKey } from './oscillation.ts'
import type { OscillationState } from './oscillation.ts'
import { betaAuthorityDecision, formatJevHeads } from './betaAuthority.ts'
import type { BetaAuthorityDecision } from './betaAuthority.ts'
import { evaluateUnverifiedBudget, formatActionUnverified, hasObservableProgress, UNVERIFIED_ACTION_LIMIT } from './actionPostcondition.ts'
import { StubSystem2 } from './system2.ts'
import type { LlmSummonReason, System2Brain, System2Objective, System2Outcome, System2PlanRequest } from './system2.ts'

export type EscalationReason =
  | 'low_confidence'
  | 'same_failure_3x'
  | 'pathfinder_no_path'
  | 'pathfinder_stuck'
  | 'progress_stall'
  | 'unexpected_world_state'
  | 'all_candidates_invalid'
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
  goal_complete: 'queue_empty',
  unknown_event: 'unknown_situation',
  policy_error: 'unknown_situation',
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
   * #11 v2: furnace-prerequisite ordering. `cost` (default) selects the cheapest
   * feasible path and shadow-logs the #78 rank order; `rank` restores the rank
   * order for A/B. `BUDDY_PREREQ_RANK_POLICY=rank` switches it.
   */
  prereqRankPolicy: PrereqRankPolicy
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
  jevMaxRetries: 0,
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
  prereqRankPolicy: resolvePrereqRankPolicy(),
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

/** Safety-critical events: a decision made before one of these is stale. */
export const CRITICAL_TRIGGERS: ReadonlySet<DecisionTrigger> = new Set<DecisionTrigger>([
  'damage_taken',
  'hp_changed',
  'mob_appeared',
])

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
  }
}

/** Mineflayer's own block-interaction cap: `canDigBlock` refuses beyond ~5.1 blocks. */
export const MAX_BLOCK_REACH = 5
/** A repeated WAIT becomes a bounded replan first (never an immediate wedge). */
const WAIT_REPLAN_LIMIT = 4
/** Issue #45: an active RETRIEVE that stops closing distance for this many ticks escalates. */
const RETRIEVAL_STALL_TICKS = resolveRetrievalStallTicks()
/** Issue #41: a descend goal with no vertical progress for this many ticks escalates. */
const DESCEND_STALL_TICKS = resolveDescendStallTicks()
/** Issue #41: a descend goal with no executable descend candidate this long escalates. */
const DESCEND_NO_CANDIDATE_TICKS = resolveDescendNoCandidateTicks()
/** Distance decrease (m) that counts as real retrieval progress. */
const RETRIEVAL_PROGRESS_EPSILON = 0.5
/** Issue #8: failed attempts at one coordinate before it is blacklisted. */
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

/** Map an executor failure code onto a movement-failure reason. */
function moveFailureReason(failure: string | null): MoveFailureReason {
  switch (failure) {
    case 'path_no_path':
      return 'no_path'
    case 'path_stuck':
    case 'path_timeout':
    case 'action_timeout':
      return 'stuck'
    default:
      return 'unreachable'
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
}

/**
 * Pure decision the controller applies to every finished known-resource
 * retrieve. Observable progress clears the per-resource counter; anything else
 * charges it and retires the resource at the bounded limit. This is the exact
 * boundary the live iron-ore loop got wrong: the old rule cleared on
 * `result.verified`, which a sub-metre nudge satisfies.
 */
export function decideKnownRetrieve(input: KnownRetrieveDecisionInput): KnownRetrieveDecision {
  if (input.retrieval !== 'known' || input.target === null) return { kind: 'ignore' }
  if (knownRetrieveMadeProgress(input.result)) return { kind: 'clear' }
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
  optionId: string
  planId: string | null
}

export const MIRRORED_MARKERS: ReadonlySet<string> = new Set([
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
  'MOVE_FAILMEM',
  'MOVE_FAILMEM_RESET',
  'MOVE_TARGET_SKIPPED',
  'OSCILLATION_DETECTED',
  'RETURN_TO_KNOWN_RESOURCE',
  'RETRIEVE_STALLED',
  'KNOWN_RESOURCE_STALE',
  'EXPLORE',
  'REPLAN_THROTTLED',
  'REPLAN_REJECTED',
  'CAPABILITY_GAP',
  'CAPABILITY_GAP_POLICY',
  'CAPABILITY_GAP_CLEARED',
  'RETURN_TO_SURFACE',
  'PRECONDITION_PROTECTED',
  'PLACE_RETRY',
  'ABANDON_REASON',
  'ABANDON_REASON=retrieve_unverified',
  'PREREQ_OPTION',
  'PREREQ_RANK_SHADOW',
  'PREREQ_SWITCH',
  'FURNACE_READY',
  'STATION_REGISTERED',
  'SMELT_DONE',
  'SMELT_INPUT_PREREQ',
  'CRAFT_INGREDIENT_PREREQ',
  'OSCILLATION_DETECTED',
  'ABANDON_REASON=action_unverified',
  'ACTION_UNVERIFIED',
  'REACHABILITY',
  'CANDIDATE_WITHHELD',
  'CANDIDATE_STARVATION',
  'LOG_ROUTE',
  'WEDGE_SUPPRESSED',
  PROTECTION_ABANDON_CONFLICT,
  CANDIDATE_FLAP,
  CANDIDATE_COMMIT_RELEASED,
])

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
    const token = message.split(' ')[0]
    if (token !== undefined && MIRRORED_MARKERS.has(token)) this.sink(token, detail)
  }
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
  private criticalStateVersion = 0

  private planCalls = 0
  private runtimeLlmCalls = 0
  private tickLlmCalls = 0
  private planSupplied = false
  private subgoalCount = 0
  private pendingTransition: DecisionSubgoalLog | null = null

  private lastDecision: JevResult | null = null
  private lastJevAt = 0
  private lastDecisionStateHash = ''
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
  private wedgeReason: string | null = null
  private readonly replanThrottle: ReplanThrottle
  private readonly loggedStaleResources = new Set<string>()
  private retrievalTrack: { id: string; best: number; ticks: number; bestGap?: number } | null = null
  private activeRetrieval: { id: string; resource: string; knownName: string; target: Vec3Json } | null = null
  private retrievalEscalationPending = false
  private readonly unreachableResources = new Set<string>()
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
  private lastSurfaceGoalId: string | null = null
  private fuelSatisfiedKey: string | null = null
  private readonly loggedUnreachableMoves = new Set<string>()
  /** #8: exact coordinate failure memory (count, cooldown, dimension). */
  private moveFailMemory: MoveFailMemory
  /** #11 v2 §6: reachability proved a target unreachable under a state fingerprint. */
  private readonly reachabilityProofs = new StateFingerprintMemory({ maxEntries: MOVE_FAILMEM_MAX_ENTRIES })
  /** candidates the affordance gate withheld in the latest generation. */
  private withheldCandidateIds: ReadonlySet<string> = new Set<string>()
  /** last logged REACHABILITY signature per candidate, so markers change with facts. */
  private readonly reachabilityLogSignatures = new Map<string, string>()
  /** last logged PLACE_REFUSED signature, so one geometry dead end is one line. */
  private lastPlacementRefusalKey: string | null = null
  /** #8: the movement target currently owning the body, blacklisted on oscillation. */
  private lastMoveTarget: { dimension: string; position: Vec3Json } | null = null
  private lastOscillationPair: string | null = null
  private lastOscillationAt = 0
  /** #46: bounded PLACE retries per item, so a bad spot never abandons the option. */
  private readonly placementRetries = new Map<string, number>()
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
  /** Last mirrored `CRAFT_INGREDIENT_PREREQ` line, so a stable state logs it once. */
  private lastCraftIngredientPrereqLine: string | null = null
  /** #58: the last scored furnace-prerequisite plan and its selected path. */
  private prereqPlan: PrereqDecision | null = null
  private prereqForcedPath: PrereqPath | null = null
  private prereqGoalKey: string | null = null
  private prereqLoggedKey: string | null = null
  private prereqProgress: PrereqProgress | null = null
  private readonly prereqStallTicks = resolvePrereqStallTicks()
  /** #78: options excluded for the current goal after repeated unverified failure (path -> fingerprint). */
  private readonly abandonedRetrievePaths = new Map<PrereqPath, string>()
  /** #78: consecutive `verified=false progressDelta=0` retrieve outcomes. */
  private retrieveUnverified: RetrieveUnverifiedState | null = null
  /** #78: last quantized position / swap pair / state signature. */
  private oscillationState: OscillationState | null = null
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
  /** verified-outcome counter; a change clears the flap window and the commitment. */
  private progressEpoch = 0
  private commitmentProgressEpoch = 0
  /** Semantic per-tick fingerprint (inventory/world/topology), never the clock. */
  private lastStateFingerprint = ''
  /** The fingerprint that produced each abandoned prerequisite-path fact. */
  private readonly abandonedPrereqFingerprints = new Map<string, string>()

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
    this.replanThrottle = new ReplanThrottle(this.options.replanThrottleMs, this.options.replanPositionDelta)
    this.goal = makeGoal(this.options.goalItem, this.options.goalCount)
    this.queue = new GoalQueue()
    this.recipeIndex = createRecipeIndex(bot.registry)
    this.runWriter = new JsonlWriter(join(this.options.logDir, 'run.jsonl'))
    this.jevWriter = new JsonlWriter(join(this.options.logDir, 'jev-calls.jsonl'))
    this.decisionWriter = new JsonlWriter(join(this.options.logDir, 'decisions.jsonl'))
    this.system2Writer = new JsonlWriter(join(this.options.logDir, 'system2.jsonl'))
    this.logger =
      this.options.eventSink === undefined
        ? new EventLogger(this.runWriter, this.options.verbose)
        : new MirroringEventLogger(this.runWriter, this.options.verbose, this.options.eventSink)
    this.jev = createJevPolicy({
      writer: this.jevWriter,
      model: process.env.AI_GATEWAY_MODEL ?? null,
      timeoutMs: this.options.jevTimeoutMs,
      maxRetries: this.options.jevMaxRetries,
      rateLimitRetries: this.options.jevRateLimitRetries,
      rateLimitBaseDelayMs: this.options.jevRateLimitBaseDelayMs,
      forceFallback: this.options.forceFallbackPolicy,
    })
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
    return this.system2.model
  }

  get isRunning(): boolean {
    return this.running
  }

  /** Swap in a real long-horizon model. The interface is system2.ts#System2Brain. */
  setSystem2(brain: System2Brain): void {
    this.system2 = brain
  }

  /** Must be called before start(). Rebuilds every derived object. */
  setOptions(partial: Partial<JevAgentOptions>): void {
    if (this.running) throw new Error('setOptions() cannot be called while the agent is running')
    this.options = normalizeOptions({ ...this.options, ...partial })
    this.moveFailMemory = this.createMoveFailMemory()
    this.goal = makeGoal(this.options.goalItem, this.options.goalCount)
    this.harvestedGoalCount = 0
    this.queue = new GoalQueue()
    this.runWriter = new JsonlWriter(join(this.options.logDir, 'run.jsonl'))
    this.jevWriter = new JsonlWriter(join(this.options.logDir, 'jev-calls.jsonl'))
    this.decisionWriter = new JsonlWriter(join(this.options.logDir, 'decisions.jsonl'))
    this.system2Writer = new JsonlWriter(join(this.options.logDir, 'system2.jsonl'))
    this.logger =
      this.options.eventSink === undefined
        ? new EventLogger(this.runWriter, this.options.verbose)
        : new MirroringEventLogger(this.runWriter, this.options.verbose, this.options.eventSink)
    this.jev = createJevPolicy({
      writer: this.jevWriter,
      model: process.env.AI_GATEWAY_MODEL ?? null,
      timeoutMs: this.options.jevTimeoutMs,
      maxRetries: this.options.jevMaxRetries,
      rateLimitRetries: this.options.jevRateLimitRetries,
      rateLimitBaseDelayMs: this.options.jevRateLimitBaseDelayMs,
      forceFallback: this.options.forceFallbackPolicy,
    })
    this.scheduler = this.buildScheduler()
    this.executor = new Executor(this.bot, this.logger, executorOptions(this.options, this.scheduler))
    this.system2 = new StubSystem2(this.system2Writer)
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
      `jev-agent started policy=${this.jev.kind} model=${this.jev.model} system2=${this.system2.model} goal="${this.goal.description}"`,
      {
        policy: this.jev.kind,
        model: this.jev.model,
        system2Model: this.system2.model,
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
    const added = this.queue.applyPlan(plan.goals, 'llm', plan.op ?? 'replace', {
      reason: plan.note,
      onProtection: (line) => this.logger.warn('agent', line, { op: plan.op ?? 'replace', phase: 'bootstrap' }, this.tickCounter),
      onDuplicate: (line) => this.logger.warn('agent', line, { op: plan.op ?? 'replace', phase: 'bootstrap' }, this.tickCounter),
    })
    this.logQueueDepthDelta(depthBefore, plan.op ?? 'replace', `bootstrap`)
    this.subgoalCount = added.length
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
      `bootstrap plan applied model=${this.system2.model} call=1 goals=${added.length} depth=${this.queue.state.depth} :: ${plan.note}`,
      {
        model: this.system2.model,
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

  private readonly onBotDeath = (): void => {
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
      this.triggerCounts[trigger] = (this.triggerCounts[trigger] ?? 0) + 1
      if (CRITICAL_TRIGGERS.has(trigger)) this.criticalStateVersion += 1
      this.signals.maxConcurrentActions = this.executor.maxConcurrentActions
      this.signals.lastPathStatus = this.executor.lastPathStatus
      this.signals.consecutiveFailures = this.failureStreak
      this.signals.escalationRecommended = Date.now() - this.lastEscalationMs < this.options.escalationWindowMs
      this.signals.failedCandidates = this.failureSnapshot()
      this.signals.knownResources = filterKnownResources(this.knownResourcesForSensor(), this.unreachableResources)
      this.updateStallSignal()
      this.observeRetrievalStall()
      this.observeCapabilityGap()

      if (this.bot.entity === undefined) return

      // Consume the queue against the live inventory: this completes the current
      // subgoal and advances it, recording the transition with the trigger.
      this.syncQueue(trigger)
      this.syncGoalToQueue()

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

      const state = buildWorldState(
        this.bot,
        {
          tick: this.tickCounter,
          goal: this.goal,
          goalQueue: this.queue.state,
          currentOption: this.currentOptionContext(),
          focusItem: currentFocusItem(this.goal, this.queue.state),
          recentEvents: this.recentEvents,
          signals: this.signals,
          rememberedStations: this.knownResourcesForSensor(),
        },
        sensorOptions(this.options),
      )
      this.syncTerrainSignals(state)
      this.sampleMovement(state.self.position)
      this.logStaleKnownResources(state)
      this.lastPlacedFurnaceCount = (state.furnaces ?? []).filter(isSensedStation).length
      this.lastStateFingerprint = this.stateFingerprint(state)

      if (state.self.health <= 0) {
        this.escalate('unexpected_world_state', 'health <= 0')
        return
      }

      const unreachableStations = this.unreachableStationKeys(state)
      const blacklistedMoveTargets = this.blacklistedMoveTargets(state)
      const groundingOptions = candidateOptions(
        this.options,
        this.recipeIndex,
        unreachableStations,
        this.reachabilityGateOptions(),
        blacklistedMoveTargets,
      )
      const grounded = generateGroundedCandidates(state, groundingOptions)
      this.withheldCandidateIds = new Set(grounded.withheld.map((entry) => entry.candidate.id))
      this.logReachability(grounded.reachability, grounded.withheld)
      this.logPlacementRefusal(grounded.placeRefusal)
      this.logSmeltInputPrereq(state, groundingOptions)
      this.logCraftIngredientPrereq(state, groundingOptions)
      let candidates = grounded.candidates
      candidates = this.applyFurnacePrereq(state, candidates, unreachableStations)
      candidates = this.filterMoveCandidates(candidates, state)
      // The gate's self-contained craft ladder runs before these controller
      // filters, so a move-failure-memory prune can strip the last productive
      // candidate. Backfill the deterministic craft step for the current craft
      // goal here so an inputs-held craft is never reported as starved.
      candidates = ensureCraftStepActionable(state, candidates, groundingOptions)
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
      this.observeDescendProgress(candidates)
      this.lastCandidates = candidates
      this.logCandidates(candidates, state)
      this.logLogRoute(candidates)
      this.logFuelSatisfaction(state)

      const actionable = candidates.filter(
        (candidate) => candidate.kind !== 'WAIT' && candidate.kind !== 'ESCALATE',
      ).length
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
          this.escalate(
            'all_candidates_invalid',
            `NO_PRODUCTIVE_CANDIDATE repeated ${this.noProductiveRepeats}x with no state change on goal "${this.currentGoalKey()}"`,
          )
        }
      } else {
        this.noProductiveRepeats = 0
        this.noProductiveKey = null
      }
      this.breakFailureDeadlock(candidates)

      // exception: the plan ran dry -> ask the LLM for the next horizon
      if (this.queue.isEmpty) {
        this.summonLlm('queue_empty', 'goal queue is empty; no long-horizon goal to consume')
      }

      const planGoal: CausalGoalRef | null = state.goalQueue.current
      const causalStamp = makeCausalStamp({ chainId: makeChainId(), goal: planGoal })

      const decision = await this.decide(state, candidates, trigger, causalStamp.chainId)
      const semantic = this.semanticEscalation(decision)
      const needLlmAdopted = semantic.escalate
      if (needLlmAdopted) {
        this.needLlmDecisions += 1
        this.summonLlm('need_llm', semantic.reason)
      }
      this.logBetaShadow(causalStamp.optionId, decision, needLlmAdopted)

      const rawChosenId = decisionIdFrom(decision) ?? 'WAIT'
      const committedId = this.applyCandidateCommitment(rawChosenId, candidates, state)
      const dangerGate = gateDanger(decision.answers.danger)
      const gated = this.applyDangerGate(committedId, dangerGate, candidates)
      const chosenId = gated.chosenId
      this.checkWedge(chosenId)
      if (this.wedgeAborted) return

      if (this.criticalArrivedDuringFlight()) {
        this.logger.warn(
          'policy',
          `discarding stale decision ${decision.callId}: a critical trigger arrived during the Jev flight`,
          {},
          this.tickCounter,
        )
        return
      }

      const freshState = buildWorldState(
        this.bot,
        {
          tick: this.tickCounter,
          goal: this.goal,
          goalQueue: this.queue.state,
          currentOption: this.currentOptionContext(),
          focusItem: currentFocusItem(this.goal, this.queue.state),
          recentEvents: this.recentEvents,
          signals: this.signals,
          rememberedStations: this.knownResourcesForSensor(),
        },
        sensorOptions(this.options),
      )
      const freshCandidates = this.filterMoveCandidates(
        generateGroundedCandidates(
          freshState,
          candidateOptions(
            this.options,
            this.recipeIndex,
            this.unreachableStationKeys(freshState),
            this.reachabilityGateOptions(),
            this.blacklistedMoveTargets(freshState),
          ),
        ).candidates,
        freshState,
        false,
      )
      const freshIds = new Set(freshCandidates.map((candidate) => candidate.id))
      if (!freshIds.has(chosenId)) {
        this.guardRejections += 1
        this.logger.warn(
          'guard',
          `chosen candidate ${chosenId} vanished between the Jev answer and execution`,
          { chosenId },
          this.tickCounter,
        )
        return
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
        this.onGuardReject(
          guarded,
          decision,
          record,
          freshCandidates.find((candidate) => candidate.id === guarded.candidateId),
        )
        return
      }

      if (guarded.candidate.kind === 'DESCEND') this.logDescendPlan(guarded.candidate)
      if (guarded.candidate.kind === 'RETRIEVE') this.logRetrievalAction(guarded.candidate)
      this.checkUnreachableMove(guarded.candidate, state)
      this.rememberMoveTarget(guarded.candidate)

      const claim = this.executor.claim(guarded.candidate)
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
      const option = action === 'WAIT' ? 'none' : prerequisiteOptionName(action)
      this.logger.warn('heads', formatAbandonReason(option, reason), { option, reason, beta: abandon, action }, this.tickCounter)
    }
  }

  /**
   * #79: decide what to do with one abandon request. Uses the per-option
   * attempt counter, so a SPECULATIVE request (attempts < limit) is suppressible
   * in shadow mode while a DEMONSTRABLY UNPRODUCTIVE one (attempts >= limit with
   * verified=false && progress=0) is enforced regardless of `betaAuthority`.
   */
  private abandonVerdict(decision: JevResult, optionId: string, planId: string | null): AbandonVerdict {
    const requested = abandonRequested(decision)
    const now = Date.now()
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
    if (this.options.betaAuthority) return this.adoptAbandon(result)
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

  /** Demoted semantic questions: computed by code, logged, never steering (#11). */
  private shadowMetrics(state: WorldState): Record<string, number> {
    const escalating = state.signals.escalationRecommended
    return {
      goal_progress: Math.round(state.goal.progress * 4),
      plan_still_valid: escalating ? 1 : 4,
      situation_understood: state.goalQueue.empty && !state.goal.complete ? 2 : 4,
      goal_blocked: escalating ? 1 : 0,
      strategy_change_needed: escalating ? 1 : 0,
    }
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
    const vote = this.betaDecision(decision)
    const probability = decision.answers.abandon_option?.probability ?? null
    if (vote.adopt) {
      this.markOptionAbandoned(decisionIdFrom(decision), 'authority')
      this.summonLlm('no_progress', `abandon_option=${probability} crossed the replan threshold`)
      return true
    }
    const protection = this.reconciledProtection(vote.protection, decisionIdFrom(decision) ?? 'abandon')
    if (protection.protect && !this.placeRetryExhausted()) {
      this.logger.warn(
        'heads',
        protection.line,
        { option: protection.option, because: protection.because, actionId: decisionIdFrom(decision), abandon: probability },
        this.tickCounter,
      )
      return false
    }
    this.markOptionAbandoned(decisionIdFrom(decision), 'authority')
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
    for (const count of this.placementRetries.values()) {
      if (count > PLACE_RETRY_LIMIT) return true
    }
    return false
  }

  private placeRetryCount(item: string | null): number {
    if (item === null) return 0
    return this.placementRetries.get(item) ?? 0
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
    const goal = `${this.currentGoalKey()}|depth=${state.goalQueue?.depth ?? 0}`
    return `fp1|pos=${position}|inv=${inventory}|stations=${stations}|furnaces=${furnaces}|goal=${goal}`
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
   * #46 requirement 2: a placement failure at one spot is NOT an abandon. Log
   * PLACE_RETRY, retire the spot so the next decision relocates a few blocks,
   * and only give up after PLACE_RETRY_LIMIT attempts.
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
    const prior = this.placeRetryCount(item)
    const decision = evaluatePlaceRetry({ at, reason: result.failure ?? 'place_failed', priorRetries: prior })
    if (item !== null) this.placementRetries.set(item, decision.count)
    if (!decision.retry) {
      this.logger.warn(
        'agent',
        `${decision.line} retry_exhausted=${prior}/${PLACE_RETRY_LIMIT} -> allow replan`,
        { actionId: result.actionId, count: prior, limit: PLACE_RETRY_LIMIT, reason: result.failure },
        this.tickCounter,
      )
      return false
    }
    this.logger.warn(
      'agent',
      decision.line,
      { actionId: result.actionId, count: decision.count, limit: PLACE_RETRY_LIMIT, reason: result.failure },
      this.tickCounter,
    )
    return true
  }

  private criticalArrivedDuringFlight(): boolean {
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
    if (
      this.lastDecision !== null &&
      now - this.lastJevAt < this.options.minJevIntervalMs &&
      stateHash === this.lastDecisionStateHash
    ) {
      this.logger.info(
        'policy',
        `rate limited (${now - this.lastJevAt}ms < ${this.options.minJevIntervalMs}ms, same state), reusing decision ${this.lastDecisionId}`,
        { trigger },
        this.tickCounter,
      )
      return this.lastDecision
    }

    try {
      this.policyEpoch += 1
      this.issuedPolicyEpoch = this.policyEpoch
      this.issuedCandidateHash = candidates.map((candidate) => candidate.id).join('|')
      const result = await this.jev.decide({
        stage: `policy-tick-${this.tickCounter}-${trigger}`,
        state,
        candidates,
        questionNames: questionNamesFor(questionSetForTrigger(trigger)),
      })
      this.jevCalls += 1
      this.lastJevAt = Date.now()
      this.lastDecision = result
      this.lastDecisionStateHash = stateHash
      this.lastDecisionId = decisionIdFrom(result)
      this.signals.lastPolicyConfidence = result.answers.action?.confidence ?? null

      const chosen = candidates.find((candidate) => candidate.id === this.lastDecisionId)
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
      const optionId = optionIdForGoal(planGoal) ?? this.currentGoalKey()
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
      const message = error instanceof Error ? error.message : String(error)
      this.logger.error('policy', `Jev call failed: ${message}`, { trigger }, this.tickCounter)
      this.escalate('policy_error', message)
      this.recordFailure('unknown_event', `policy error: ${message}`)
      return this.syntheticWait()
    }
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
    this.recentEvents.push(`guard ${guarded.code} on ${guarded.candidateId}`)
    this.noteCandidateFailure(guarded.candidateId)
    const movementFailure = guardMoveFailureReason(candidate, guarded.code)
    if (candidate !== undefined && movementFailure !== null) this.recordMoveFailure(candidate, movementFailure)
    this.chargeGuardRejection(record, guarded.code)
    this.recordFailure(guarded.code, guarded.reason)
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

  private onActionComplete(result: ExecutionResult, decision: JevResult, candidate: Candidate): void {
    if (result.itemsGained > 0 || result.blockRemoved) this.progressEpoch += 1
    this.recentOutcomes.push({
      actionId: result.actionId,
      status: result.status,
      failure: result.failure,
      verified: result.verified,
      detail: result.detail,
    })
    if (this.recentOutcomes.length > 16) this.recentOutcomes.shift()
    this.noteAscendOutcome(result, candidate)

    writeOutcome(this.jevWriter, {
      callId: decision.callId,
      policy: decision.policy,
      actionId: result.actionId,
      executed: result.status !== 'cancelled',
      verified: result.verified,
      failureCode: result.failure,
      goalProgress: result.goalItemCount,
      note: `${result.status}/${result.phase}: ${result.detail}`,
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
        success: result.status === 'done' && result.verified,
        durationMs: result.ms,
        damageTaken: Math.max(0, pending.healthAtDecision - this.bot.health),
        progress: this.goal.progress,
        status: result.status,
        failureCode: result.failure,
        verified: result.verified,
        blockRemoved: result.blockRemoved,
        dropObserved: result.dropObserved,
      })
      this.decisionWriter.write(pending.record)
      const chain = completeCausalChain(
        {
          chainId: pending.record.chainId ?? 'unknown',
          optionId: pending.record.optionId,
          planId: pending.record.goalQueueState.current?.id ?? null,
          strategy: pending.record.strategy,
        },
        {
          candidateId: pending.record.chosenAction,
          actionId: result.actionId,
          verified: result.verified,
          status: result.status,
          resource: result.yieldItem ?? result.targetName ?? null,
          progressDelta: result.itemsGained,
        },
      )
      this.logger.info('causal', formatCausalLine(chain), causalRecord(chain), this.tickCounter)
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
    if (result.unverifiedPostcondition !== undefined) {
      this.onUnverifiedAction(result, result.unverifiedPostcondition, pending)
    } else if (result.status === 'done' && result.verified) {
      const settledPlanId = pending?.record.goalQueueState.current?.id ?? this.queue.current?.id ?? null
      if (settledPlanId !== null) this.actionUnverified.delete(settledPlanId)
    }

    if (completedOptionId !== null) {
      this.optionAttempts.noteOutcome(
        {
          optionId: completedOptionId,
          planId: completedPlanId,
          verified: result.verified,
          progressDelta: result.itemsGained,
        },
        Date.now(),
      )
    }

    if (result.status === 'done') {
      if (result.kind === 'PLACE' && result.verified && candidate.itemName !== null) {
        this.placementRetries.delete(candidate.itemName)
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
      if (result.kind === 'MINE' && result.verified) {
        this.noteCandidateSuccess(result.actionId)
        this.verifiedDigs += 1
        if (result.blockRemoved) this.blocksRemoved += 1
        if (result.dropObserved) this.dropObservations += 1
        this.itemsCollected += result.itemsGained
        // A verified dig whose target block is gone counts as one obtained goal
        // item even when the pickup walk cannot reach the drop: VERIFY already
        // accepts `blockRemoved` + `dropObserved` as proof of the dig.
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
      if (result.kind === 'RETRIEVE') {
        if (result.blockRemoved) this.onRetrievalDescent(candidate)
        // Only a real retrieval (a dug staircase step, an obtained item, or a
        // verified climb chunk that gained altitude) retires the active target.
        // The executor reports `verified=true` for a sub-metre nudge, so clearing
        // on that would disarm the stall assertion before it can ever fire.
        if (hasObservableProgress(result)) {
          this.activeRetrieval = null
          this.retrievalTrack = null
          this.noteCandidateSuccess(result.actionId)
          this.recordMoveSuccess(candidate)
        } else {
          // `status=done verified=false progressDelta=0` is the live #78 loop: a
          // retrieval that reports completion while producing nothing must charge
          // the coordinate failure memory so it is eventually skipped.
          this.recordMoveFailure(candidate, 'no_progress')
        }
        if (result.actionId.startsWith('RETRIEVE:known:station:furnace')) {
          const outcome = evaluateRetrieveAbandon({
            actionId: result.actionId,
            verified: result.verified,
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
        const moved = Math.hypot(
          this.bot.entity.position.x - this.actionStart.x,
          this.bot.entity.position.y - this.actionStart.y,
          this.bot.entity.position.z - this.actionStart.z,
        )
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
      this.failureStreak = 0
      this.signals.consecutiveFailures = 0
    } else if (result.kind === 'PLACE' && this.schedulePlaceRetry(result, candidate)) {
      this.noteCandidateFailure(result.actionId)
    } else {
      this.noteCandidateFailure(result.actionId)
      this.recordMoveFailure(candidate, moveFailureReason(result.failure))
      this.recordFailure(result.failure, `${result.actionId}: ${result.detail}`)
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
    if (!switched) {
      this.summonLlm(
        budget.abandon ? 'action_impossible' : 'no_progress',
        `action_unverified planId=${key} attempts=${attempts} strategy=${strategy ?? 'null'}`,
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
    })
    this.oscillationState = decision.state
    if (!decision.detected || decision.line === null) return
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
    this.escalate('progress_stall', `position oscillation ${state.pair ?? 'pair'} cycles=${state.cycles}; escaping the loop`)
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
        this.digMemory.resetPath()
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
    const current = this.queue.current
    if (current === null) return
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
      if (current.targetItem !== null && this.countItem(current.targetItem) <= 0) {
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
      if (evaluation === null || !evaluation.satisfied) return
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
      // A place goal is the inverse of the inventory-counted goals: it completes
      // when the held station has LEFT the inventory. `have` is the inventory
      // count, so map "still held" to 0 progress and "gone" to complete.
      const placed = have <= 0
      this.goal = { ...subgoalState(current, placed ? current.requiredCount : 0), haveCount: have }
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
        return { triggered: false, reason, detail: message }
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

    const queueState = this.queue.state
    const request: System2PlanRequest = {
      reason,
      detail,
      tick: this.tickCounter,
      goalQueueState: queueState,
      objective: this.objectiveState(),
      recentEvents: this.recentEvents.slice(-8),
      recentOutcomes: this.recentOutcomes.slice(-8),
    }
    const resummon: DecisionLlmResummonLog = { triggered: true, reason, detail }
    this.tickResummonLog.push(resummon)

    this.logger.warn(
      'system2',
      `SUMMON LLM reason=${reason} queueDepth=${queueState.depth} current=${queueState.current?.description ?? 'none'} :: ${detail}`,
      {
        reason,
        queueDepth: queueState.depth,
        currentGoal: queueState.current?.description ?? null,
        detail,
        model: this.system2.model,
      },
      this.tickCounter,
    )

    void this.system2
      .plan(request)
      .then((plan) => {
        const depthBefore = this.queue.state.depth
        const added = this.queue.applyPlan(plan.goals, 'llm', plan.op ?? 'replace', {
          reason: plan.note,
          onProtection: (line) => this.logger.warn('agent', line, { op: plan.op ?? 'replace', reason, phase: 'runtime' }, this.tickCounter),
          onDuplicate: (line) => this.logger.warn('agent', line, { op: plan.op ?? 'replace', reason, phase: 'runtime' }, this.tickCounter),
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
          `LLM plan applied model=${this.system2.model}: ${added.length} goal(s) depth=${this.queue.state.depth} :: ${plan.note}`,
          {
            model: this.system2.model,
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
        const message = error instanceof Error ? error.message : String(error)
        this.logger.error('system2', `LLM plan failed: ${message}`, { reason }, this.tickCounter)
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
    if (code === 'path_no_path') this.escalate('pathfinder_no_path', detail)
    else if (code === 'path_stuck') this.escalate('pathfinder_stuck', detail)
    else if (code === 'unknown_event') this.escalate('unknown_event', detail)
    else if (code === 'verify_failed') this.escalate('unexpected_world_state', detail)
    if (this.failureStreak >= this.options.failureStreakLimit) {
      this.escalate('same_failure_3x', `${code ?? 'unknown'} failed ${this.failureStreak}x: ${detail}`)
    }
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
    this.escalate(
      'all_candidates_invalid',
      `all ${actionable.length} actionable candidate(s) exceeded ${this.options.candidateFailureLimit} failures; letting decay/suppression reroute instead of clearing memory`,
    )
    this.recentEvents.push('all local candidates exhausted; waiting for decay/spatial suppression to reroute')
  }

  private updateStallSignal(): void {
    const stalledMs = Date.now() - this.lastProgressAt
    this.signals.stalledMs = stalledMs
    if (!this.goal.complete && stalledMs > this.options.stallMs) {
      this.escalate('progress_stall', `no goal progress for ${stalledMs}ms`)
    }
    if (!this.goal.complete && stalledMs > this.options.wedgeStallMs) {
      this.abortWedge(`goal progress stayed 0 for ${stalledMs}ms`)
    }
  }

  /**
   * The remembered target the ascent trap is measured against: the active
   * retrieval when one exists, else the highest remembered resource still above
   * the bot. Pure lookup; the trap predicate itself is `evaluateCapabilityGap`.
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
    if (best === null) return null
    return { y: best.position.y, key: `known:${best.name}@${best.position.x},${best.position.y},${best.position.z}` }
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
    const decision = evaluateCapabilityGap(this.capabilityGapState, {
      y: entity.position.y,
      targetY: target === null ? null : target.y,
      targetKey: target === null ? null : target.key,
      ascendRefused: this.ascendRefusedSinceObservation,
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
    this.summonLlm('no_progress', `capability gap: ${marker} -> strategic replan`)
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
    // the next tick can pick a different column/step, then wake System 2.
    this.digMemory.markResourceProgress()
    this.descendProgress = { bestY: y, ticks: 0 }
    this.descendStallTicks = 0
    this.escalate(
      'progress_stall',
      `descend goal ${current.id} stuck at y=${Math.floor(y)} (target ${targetY}) for ${stallTicks} ticks; switching strategy`,
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
    this.escalate('pathfinder_stuck', `retrieval stalled at ${Math.round(current)}m for ${ticks} ticks`)
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
   * A known-resource RETRIEVE that produced no OBSERVABLE progress charges a
   * per-resource counter. After KNOWN_RETRIEVE_RETIRE_LIMIT the resource is
   * dropped as unreachable and removed from `signals.knownResources`, so the
   * generator stops re-offering the same present-but-unreachable cell and the
   * plan advances to the next resource or the branch-mine route instead of
   * looping forever. `decideKnownRetrieve` owns the boundary; the executor's
   * lenient `verified` flag is deliberately not trusted (a sub-metre nudge
   * satisfies it - the live iron-ore loop).
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
    })
    if (decision.kind === 'ignore') return
    if (decision.kind === 'clear') {
      this.knownRetrieveFailures.delete(key)
      return
    }
    this.knownRetrieveFailures.set(key, decision.attempts)
    if (decision.kind === 'charge') return
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
      const summon = this.summonLlm(
        'no_progress',
        `WAIT chosen ${wait.n}x on goal "${goalKey}" with no verified progress; requesting a replan`,
      )
      const counted = summon?.triggered === true
      if (counted) this.waitReplans += 1
      this.waitStreak = 0
      this.wedgeRepeats = 0
      this.logger.warn(
        'agent',
        `WAIT_LIMIT n=${wait.n} -> replan (${this.waitReplans}/${WAIT_REPLAN_LIMIT}) goal="${goalKey}"${this.noProductiveThisTick ? ' NO_PRODUCTIVE_CANDIDATE' : ''}${counted ? '' : ' THROTTLED'}`,
        {
          actionId,
          count: wait.n,
          goal: goalKey,
          waitReplans: this.waitReplans,
          llmSummoned: counted,
          throttled: !counted,
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
    const optionId = current.optionTemplateId ?? optionIdForGoal(current) ?? this.currentGoalKey()
    const attempts = this.optionAttempts.stateFor(optionId, current.id)
    return currentOptionContextForQueuedGoal(current, {
      failures: attempts.attempts,
      verifiedProgress: current.haveCount,
      lastProgressAt: current.updatedAt,
    })
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
    const entity = this.bot.entity
    if (target === null || entity === undefined) return null
    return Math.round(Math.hypot(entity.position.x - target.x, entity.position.y - target.y, entity.position.z - target.z))
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
   * M2 blocker: remembered stations whose grounded retrieve the move-failure
   * memory has blacklisted (`MOVE_TARGET_SKIPPED`) or the reachability gate has
   * withheld (`CANDIDATE_WITHHELD`) are handed to the pure prerequisite planner
   * as an explicit unreachable set. Without it the planner keeps choosing
   * `use_known_station`, the blacklist filter removes every candidate of that
   * path, and the resident collapses to WAIT.
   *
   * The sensor's remembered furnace entries are included because a placed-by-us
   * furnace is evicted from `signals.knownResources` once the move-failure
   * memory blacklists its cell, yet it is still offered by `knownFurnaces`; an
   * unblacklisted copy would re-issue the failing RETRIEVE forever.
   *
   * SENSED furnaces are considered too: a furnace the bot placed and then cannot
   * path back to is blacklisted by a SMELT guard NO_PATH (SMELT is a tracked
   * target kind). Skipping sensed entries here would leave `smeltCandidates`
   * re-offering the unreachable furnace while the acquisition ladder it needs
   * never runs (the live charcoal-starve loop).
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
    if (prereqSubjectForGoal(goal) === null || (state.furnaces ?? []).some(isSensedStation)) {
      this.resetFurnacePrereq()
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
      ),
    )
    const decision = planPrereqOptions(input)
    const goalKey = this.currentGoalKey()
    if (this.prereqGoalKey !== goalKey) {
      this.prereqGoalKey = goalKey
      this.prereqForcedPath = null
      this.prereqProgress = null
      this.prereqLoggedKey = null
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
    const keep = (candidate: Candidate): boolean => {
      const path = candidate.meta.prereqPath
      if (path === undefined) return true
      return chosen !== null && path === chosen
    }
    const kept = candidates.filter(keep)
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
    return candidates.filter((candidate) => {
      const path = candidate.meta.prereqPath
      return path === undefined || path === next
    })
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
    this.escalate('pathfinder_stuck', `${candidate.id} unverified progress=0 x${unverified}; abandoned option`)
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
      return plan.status !== 'noPath'
    } catch {
      return false
    }
  }

  private logCandidates(candidates: readonly Candidate[], state: WorldState): void {
    const signature = candidates.map((candidate) => candidate.id).join('|')
    if (signature === this.lastCandidateSignature) return
    this.lastCandidateSignature = signature
    this.logger.info(
      'candidates',
      `generated ${candidates.length} executable candidate(s); skipped ${countBlockedLogs(state)} blocked log(s) (canDig=false, no walk-up access)`,
      { ids: candidates.map((candidate) => candidate.id), detail: candidates.map((candidate) => candidate.label) },
      this.tickCounter,
    )
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
    }
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

  /** Gate facts, shared by both candidate generations in one tick. */
  private reachabilityGateOptions(): ReachabilityGateOptions {
    return { memory: this.reachabilityProofs, pathProbe: null }
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
    if (candidate.kind !== 'MOVE' && candidate.kind !== 'RETRIEVE') return
    if (candidate.target === null) return
    const dy = Math.round(candidate.target.y - state.self.position.y)
    if (dy <= MOVE_VERTICAL_GAP_LIMIT) return
    const key = `${candidate.id}:${dy}`
    if (!this.loggedUnreachableMoves.has(key)) {
      this.loggedUnreachableMoves.add(key)
      this.logger.warn(
        'agent',
        formatMoveUnreachable(candidate.target, dy),
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
      formatMoveTargetSkipped(key, result.entry.attempts, Math.ceil(this.moveFailMemory.cooldownMs / 1000)),
      { actionId: candidate.id, key, attempts: result.entry.attempts, reason },
      this.tickCounter,
    )
  }

  private recordMoveSuccess(candidate: Candidate): void {
    if (candidate.target === null || !isTrackedMoveKind(candidate.kind)) return
    const dimension = this.currentDimension()
    const key = moveFailureKey(dimension, candidate.target)
    if (!this.moveFailMemory.reset(dimension, candidate.target)) return
    if (this.lastMoveTarget !== null && this.lastMoveTarget.position.x === candidate.target.x && this.lastMoveTarget.position.z === candidate.target.z) {
      this.lastMoveTarget = null
    }
    this.logger.info('agent', formatMoveFailMemReset(key), { actionId: candidate.id, key, kind: candidate.kind }, this.tickCounter)
    this.notifyMoveFailureMemory()
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
    const target = this.lastMoveTarget
    if (target !== null) {
      const result = this.moveFailMemory.blacklist(target.dimension, target.position, 'no_progress')
      const key = moveFailureKey(target.dimension, target.position)
      this.logger.warn(
        'agent',
        formatMoveTargetSkipped(key, result.entry.attempts, Math.ceil(this.moveFailMemory.cooldownMs / 1000)),
        { key, attempts: result.entry.attempts, reason: 'oscillation', cooldown: Math.ceil(this.moveFailMemory.cooldownMs / 1000) },
        this.tickCounter,
      )
      this.notifyMoveFailureMemory()
    }
    this.escalate(
      'progress_stall',
      `OSCILLATION_DETECTED from=${fromKey} to=${toKey} cycles=${detection.cycles}; blacklisting the movement target`,
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

function sensorOptions(options: JevAgentOptions): SensorOptions {
  return { ...defaultSensorOptions, scanRadius: options.scanRadius, reach: options.reach }
}

function candidateOptions(
  options: JevAgentOptions,
  recipes: RecipeIndex,
  unreachableStations: ReadonlySet<string> = new Set<string>(),
  reachability: ReachabilityGateOptions | null = null,
  blacklistedMoveTargets: ReadonlySet<string> = new Set<string>(),
): CandidateOptions {
  return {
    ...defaultCandidateOptions,
    reach: options.reach,
    recipes,
    unreachableStations,
    blacklistedMoveTargets,
    reachability,
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
