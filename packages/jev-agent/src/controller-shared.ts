// controller-shared.ts — option builders shared by the legacy decision loop and
// the VTR Reach controller plane. Pure functions; no authority ownership.
//
// The option inputs are deliberately narrow structural slices so neither the
// legacy controller nor the Reach plane needs the other's concrete options
// type. Callers pass their full options object.

import { defaultSensorOptions } from './state.ts'
import type { DimensionProvenance, SensorOptions } from './state.ts'
import { defaultCandidateOptions } from './candidates.ts'
import type { CandidateOptions, ReachabilityGateOptions } from './candidates.ts'
import type { RecipeIndex } from './crafting.ts'
import type { GoalState } from './state.ts'
import type { GoalQueueState } from './goalQueue.ts'
import type { PortalEntryPlan, PortalFrameValidation } from './netherPortalPlan.ts'
import type { ActuationMode } from './executor.ts'
import type { ActuationPort } from './actuationPort.ts'
import type { DecisionRecordProvenance } from './decisionlog.ts'
import type { DecisionTrigger } from './scheduler.ts'
import type { FatalModelError, ModelAuthorityIdentity } from './modelFailure.ts'
import type { KernelTransitionAuthority } from './reach/kernel-authority-map.ts'
import type { KnownResource } from './state.ts'
import type { LocalOscillationRecordJson } from './localOscillation.ts'
import type { BlacklistedMoveTargets, DeathZoneHazard, MoveFailEntry } from './moveFailMemory.ts'
import type { DominatedPrerequisiteDecision, PlanIdentity, PlanObsoleteProof, QueuedGoal } from './goalQueue.ts'
import type { RepeatedOutcomeEntryJson } from './repeatedOutcomeEscalation.ts'
import type { System2RecoveryFenceRejection } from './system2/authority.ts'
import type { InventoryReachMission as VtrInventoryMission } from './reach/scheduler.ts'


export interface SensorOptionSlice {
  readonly scanRadius: number
  readonly reach: number
  readonly dimensionProvenance?: DimensionProvenance | null
}

export function sensorOptions(options: SensorOptionSlice, worldRevision: number | null = null): SensorOptions {
  return {
    ...defaultSensorOptions,
    scanRadius: options.scanRadius,
    reach: options.reach,
    worldRevision,
    // Only the decision-time build carries provenance: `sensorOptions(...)` is
    // also used for standalone portal-frame projections outside `buildWorldState`,
    // where the read gate is not armed and the reads are unchanged.
    dimensionProvenance: options.dimensionProvenance ?? null,
  }
}

export interface CandidateOptionSlice {
  readonly reach: number
}

export function candidateOptions(
  options: CandidateOptionSlice,
  recipes: RecipeIndex,
  unreachableStations: ReadonlySet<string> = new Set<string>(),
  reachability: ReachabilityGateOptions | null = null,
  blacklistedMoveTargets: BlacklistedMoveTargets = new Set<string>(),
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
  }
}

/** Hard upper bound for settling a committed safety Skill during model recovery. */
export const MODEL_RECOVERY_DRAIN_GRACE_MS = 1_000

export function currentFocusItem(goal: GoalState, queue: GoalQueueState): string | null {
  return queue.current?.targetItem ?? goal.targetItem ?? null
}

export interface JevAgentOptions {
  goalItem: string
  goalCount: number
  /** Independent source of Mission truth for the V4 Reach/Navigation slice. */
  vtrMission?: VtrInventoryMission | null
  /** Isolated no-LLM probe: VTR is the only semantic/locomotion owner until stopped. */
  vtrReachProbe?: boolean
  /**
   * V4.1.2 production-authority gate — REQUIRED at construction. The kernel
   * gates every gated Reach act (admission, activation, effect issue,
   * settlement, terminalization, SUCCESS) and receives verified world
   * observations through `feedObservation`. Legacy Reach scheduling for the
   * Mission item is withheld unconditionally (no fallback); there is no
   * authority-less or observer-only Reach mode.
   */
  kernelAuthority: KernelTransitionAuthority
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
   * Resident host handler for exhausted model calls. Retryable Jev transport
   * failures may stop this generation for host recovery; all other failures
   * remain fatal. Tests omit it and observe the thrown FatalModelError.
   */
  terminateOnModelFailure?: (error: FatalModelError) => never
  /**
   * Set only by the HOST on an outage-recovery generation. A returned decision
   * must prove the exact pinned Jev provider/model before it can reach π/actuation.
   */
  recoveryPolicyAuthority?: ModelAuthorityIdentity | null
  /** Host-pinned System2 authority; recovery plans are fenced before queue mutation. */
  recoverySystem2Authority?: ModelAuthorityIdentity | null
  /** Exact source SHA pinned alongside a System2 outage. */
  recoverySourceSha?: string | null
  /** Exact source SHA of this generation, checked again at the System2 commit point. */
  generationSourceSha?: string | null
  /** Host-owned backoff/restart transition for an unproven recovered System2 answer. */
  rejectSystem2RecoveryPlan?: (rejection: System2RecoveryFenceRejection) => never
  /**
   * #79: after this many settled attempts with `verified=false && progress=0`,
   * the Option is recorded as demonstrably unproductive (code-owned evidence
   * attached to the abandon verdict).
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
   * Durable production death-hazard records injected by the resident host. When
   * present, the controller's move-target blacklist becomes a death-zone
   * predicate (isInDeathZone): a candidate target inside an area that has
   * already killed the body >= DEATH_ZONE_DEATHS times is withheld from every
   * move-target offer - CAN/SAFE filtering, not semantic choice.
   */
  deathHazards?: readonly DeathZoneHazard[]
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
   * #oscillation-boundary: the durable local-motion oscillation record restored
   * from the resident's class-A world memory. It is keyed on the BODY's cell
   * envelope, never on the queue head, so a generation change cannot launder a
   * loop in the same small set of cells.
   */
  localOscillationRecord?: LocalOscillationRecordJson | null
  /** called when the durable local-motion record changes, so the HOST can persist it */
  onLocalOscillationChange?: (record: LocalOscillationRecordJson | null) => void
  /**
   * The durable (action shape, cell, typed outcome) repeat ledger restored from
   * the resident's class-A world memory. It is the DURABLE half of the
   * cross-action escalation: the in-generation `ActionFailureEscalation` counter
   * is erased by `progress=body` and by every hot reload, which is how the
   * measured `ASCEND:habitat:p3_68_22` runaway re-issued 161 attempts at one
   * cell with the same `apex_missed` outcome and never retired the target.
   */
  repeatedOutcomeEntries?: readonly RepeatedOutcomeEntryJson[]
  /** called when the durable repeat ledger changes, so the HOST can persist it */
  onRepeatedOutcomeChange?: (entries: readonly RepeatedOutcomeEntryJson[]) => void
  /**
   * The bound for the durable repeat ledger. Defaults to the module's one
   * constant (`REPEATED_OUTCOME_LIMIT_DEFAULT`) via
   * `resolveRepeatedOutcomeLimit`; it is never a second literal.
   */
  repeatedOutcomeLimit: number
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
   * Read provenance for the bot's per-column world cache (see
   * `DimensionProvenance` in `state.ts`). The resident supplies it so every world
   * read the sensor performs is attributable to the dimension it came from; a cell
   * whose column is not attributable is refused (typed) instead of becoming an
   * offer. Absent in standalone runs and fixtures, which therefore keep the
   * un-gated sensor path exactly.
   */
  dimensionProvenance?: DimensionProvenance | null
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
  /** server identifier from the resident world key captured for this generation */
  serverId: string
  /** resident world epoch captured when this controller generation was created */
  worldEpoch: number
  /** Immutable lineage supplied by the resident HOST for this controller generation. */
  decisionProvenance: Readonly<DecisionRecordProvenance>
}
