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
import { countBlockedLogs, defaultCandidateOptions, generateCandidates } from './candidates.ts'
import type { Candidate, CandidateOptions } from './candidates.ts'
import { createRecipeIndex } from './crafting.ts'
import type { RecipeIndex } from './crafting.ts'
import { attachResult, makeDecisionRecord, stableStateHash } from './decisionlog.ts'
import type { DecisionJevLog, DecisionLlmLog, DecisionLlmResummonLog, DecisionRecord, DecisionSubgoalLog } from './decisionlog.ts'
import { ActionCancelled, defaultExecutorOptions, Executor } from './executor.ts'
import type { ActuationMode, ExecutionResult, ExecutorOptions, FailureCode } from './executor.ts'
import { applyDangerGate, DANGER_CONFIDENCE_THRESHOLD, gateBoolean, gateDanger, gateScore } from './gating.ts'
import type { GatedScore } from './gating.ts'
import { GoalQueue, toGoalQueueStateLog } from './goalQueue.ts'
import type { GoalQueueSnapshot, GoalQueueState, QueuedGoal } from './goalQueue.ts'
import { createJevPolicy, decisionIdFrom, EventLogger, JsonlWriter, questionNamesFor, writeOutcome } from './jev.ts'
import type { JevPolicy, JevResult, QuestionSetKind } from './jev.ts'
import { guardDecision } from './policy.ts'
import type { GuardCode, GuardResult, InFlightAction } from './policy.ts'
import { DECISION_TRIGGERS, DecisionScheduler, PREEMPTIVE_TRIGGERS, TRIGGER_PRIORITY } from './scheduler.ts'
import type { DecisionTrigger, TriggerEvent } from './scheduler.ts'
import { buildWorldState, defaultSensorOptions, makeGoal, refreshGoalProgress } from './state.ts'
import type { AgentSignals, GoalState, SensorOptions, Vec3Json, WorldState } from './state.ts'
import { isResourceClass, matchesResourceClass } from './resourceClass.ts'
import { decayedFailureCount, failureCount, spatialFailureKey } from './failureMemory.ts'
import { DigMemory } from './worldMemory.ts'
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
  verbose: boolean
  scanRadius: number
  reach: number
  maxCandidateAgeTicks: number
  pathTimeoutMs: number
  digTimeoutMs: number
  actuation: ActuationMode
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
  verbose: true,
  scanRadius: 48,
  reach: 4.5,
  maxCandidateAgeTicks: 10,
  pathTimeoutMs: 15000,
  digTimeoutMs: 15000,
  actuation: 'pathfinder',
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
  }
}

/** Mineflayer's own block-interaction cap: `canDigBlock` refuses beyond ~5.1 blocks. */
export const MAX_BLOCK_REACH = 5
/** A guard path probe is synchronous; this caps how long it may think. */
const PATH_PROBE_TIMEOUT_MS = 750
const { goals } = pathfinderModule

function normalizeOptions(options: JevAgentOptions): JevAgentOptions {
  return { ...options, reach: Math.min(options.reach, MAX_BLOCK_REACH) }
}

interface PendingDecision {
  record: DecisionRecord
  healthAtDecision: number
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
  private lastCandidates: readonly Candidate[] = []
  private lastCandidateSignature = ''
  private lastProgress = 0
  private lastProgressAt = Date.now()

  private chosenCounts = new Map<string, number>()
  private chosenCountsAtProgress = -1
  private wedgeAborted = false
  private wedgeReason: string | null = null

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
    this.goal = makeGoal(this.options.goalItem, this.options.goalCount)
    this.queue = new GoalQueue()
    this.recipeIndex = createRecipeIndex(bot.registry)
    this.runWriter = new JsonlWriter(join(this.options.logDir, 'run.jsonl'))
    this.jevWriter = new JsonlWriter(join(this.options.logDir, 'jev-calls.jsonl'))
    this.decisionWriter = new JsonlWriter(join(this.options.logDir, 'decisions.jsonl'))
    this.system2Writer = new JsonlWriter(join(this.options.logDir, 'system2.jsonl'))
    this.logger = new EventLogger(this.runWriter, this.options.verbose)
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
    this.goal = makeGoal(this.options.goalItem, this.options.goalCount)
    this.harvestedGoalCount = 0
    this.queue = new GoalQueue()
    this.runWriter = new JsonlWriter(join(this.options.logDir, 'run.jsonl'))
    this.jevWriter = new JsonlWriter(join(this.options.logDir, 'jev-calls.jsonl'))
    this.decisionWriter = new JsonlWriter(join(this.options.logDir, 'decisions.jsonl'))
    this.system2Writer = new JsonlWriter(join(this.options.logDir, 'system2.jsonl'))
    this.logger = new EventLogger(this.runWriter, this.options.verbose)
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
    const added = this.queue.applyPlan(plan.goals, 'llm', plan.op ?? 'replace')
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
      this.updateStallSignal()

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
          focusItem: currentFocusItem(this.goal, this.queue.state),
          recentEvents: this.recentEvents,
          signals: this.signals,
        },
        sensorOptions(this.options),
      )
      this.syncTerrainSignals(state)

      if (state.self.health <= 0) {
        this.escalate('unexpected_world_state', 'health <= 0')
        return
      }

      let candidates = generateCandidates(state, candidateOptions(this.options, this.recipeIndex))
      if (this.options.singleShotPlanner) {
        // With the planner disabled, WAIT and ESCALATE are no-ops that real Jev
        // otherwise keeps re-selecting, starving the queued plan. When a
        // productive action exists, it is the only thing on offer.
        const productive = candidates.filter(
          (candidate) => candidate.kind !== 'WAIT' && candidate.kind !== 'ESCALATE',
        )
        if (productive.length > 0) candidates = productive
      }
      this.lastCandidates = candidates
      this.logCandidates(candidates, state)

      const actionable = candidates.filter(
        (candidate) => candidate.kind !== 'WAIT' && candidate.kind !== 'ESCALATE',
      ).length
      if (actionable === 0 && !state.goal.complete) {
        this.escalate('all_candidates_invalid', 'candidate generator produced no actionable candidate')
      }
      this.breakFailureDeadlock(candidates)

      // exception: the plan ran dry -> ask the LLM for the next horizon
      if (this.queue.isEmpty) {
        this.summonLlm('queue_empty', 'goal queue is empty; no long-horizon goal to consume')
      }

      const decision = await this.decide(state, candidates, trigger)
      const semantic = this.semanticEscalation(decision)
      const needLlmAdopted = semantic.escalate
      if (needLlmAdopted) {
        this.needLlmDecisions += 1
        this.summonLlm('need_llm', semantic.reason)
      }

      const rawChosenId = decisionIdFrom(decision) ?? 'WAIT'
      const dangerGate = gateDanger(decision.answers.danger)
      const gated = this.applyDangerGate(rawChosenId, dangerGate, candidates)
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
          focusItem: currentFocusItem(this.goal, this.queue.state),
          recentEvents: this.recentEvents,
          signals: this.signals,
        },
        sensorOptions(this.options),
      )
      const freshCandidates = generateCandidates(freshState, candidateOptions(this.options, this.recipeIndex))
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
        this.onGuardReject(guarded, decision, record)
        return
      }

      if (guarded.candidate.kind === 'DESCEND') this.logDescendPlan(guarded.candidate)

      const claim = this.executor.claim(guarded.candidate)
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
    const strongReasons: string[] = []
    const uncertain: string[] = []

    for (const name of ['goal_blocked', 'strategy_change_needed', 'should_retreat'] as const) {
      const gate = gateBoolean(decision.answers[name])
      if (gate.band === 'strong_true') strongReasons.push(`${name} ${gate.reason}`)
      if (gate.band === 'uncertain') uncertain.push(name)
    }
    for (const name of ['plan_still_valid', 'situation_understood'] as const) {
      const answer = decision.answers[name]
      if (answer === undefined) continue
      const gate = gateScore(answer, DANGER_CONFIDENCE_THRESHOLD)
      if (gate.actionable && gate.value !== null && gate.value <= 1) strongReasons.push(`${name} low (${gate.value})`)
      if (!gate.actionable) uncertain.push(name)
    }

    for (const name of ['goal_blocked', 'strategy_change_needed', 'plan_still_valid', 'situation_understood']) {
      this.uncertainStreaks.set(name, uncertain.includes(name) ? (this.uncertainStreaks.get(name) ?? 0) + 1 : 0)
    }
    const repeated = ['goal_blocked', 'strategy_change_needed', 'plan_still_valid', 'situation_understood'].filter(
      (name) => (this.uncertainStreaks.get(name) ?? 0) >= 2,
    )

    if (strongReasons.length > 0) return { escalate: true, reason: `strong semantic signal: ${strongReasons.join('; ')}` }
    if (repeated.length > 0) return { escalate: true, reason: `uncertain semantic signal repeated: ${repeated.join(', ')}` }
    if (uncertain.length > 0 && this.signals.stalledMs > this.options.stallMs) {
      return { escalate: true, reason: `uncertain signal ${uncertain.join(', ')} with no-progress (stalledMs=${this.signals.stalledMs})` }
    }
    if (uncertain.length > 0) return { escalate: false, reason: `uncertain once, keeping current action: ${uncertain.join(', ')}` }
    return { escalate: false, reason: 'no semantic escalation' }
  }

  private criticalArrivedDuringFlight(): boolean {
    const pending = this.pendingTrigger
    const deferred = this.deferredTrigger
    return (
      (pending !== null && CRITICAL_TRIGGERS.has(pending.trigger)) ||
      (deferred !== null && CRITICAL_TRIGGERS.has(deferred.trigger))
    )
  }

  private async decide(state: WorldState, candidates: readonly Candidate[], trigger: DecisionTrigger): Promise<JevResult> {
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
          latencyMs: result.latencyMs,
          inputTokens: result.usage?.inputTokens ?? null,
          actionConfidence: result.answers.action?.confidence ?? null,
          dangerScore: result.answers.danger?.value ?? null,
          dangerConfidence: result.answers.danger?.confidence ?? null,
          shouldRetreat: result.answers.should_retreat?.probability ?? null,
          goalProgressScore: result.answers.goal_progress?.value ?? null,
          planStillValid: result.answers.plan_still_valid?.value ?? null,
          situationUnderstood: result.answers.situation_understood?.value ?? null,
          goalBlocked: result.answers.goal_blocked?.probability ?? null,
          strategyChangeNeeded: result.answers.strategy_change_needed?.probability ?? null,
        },
        this.tickCounter,
      )

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
        { code: guarded.code, decisionCallId: decision.callId },
        this.tickCounter,
      )
      return
    }
    this.guardRejections += 1
    this.logger.warn(
      'guard',
      `REJECTED ${guarded.candidateId} code=${guarded.code} :: ${guarded.reason}`,
      { code: guarded.code, policy: decision.policy, callId: decision.callId },
      this.tickCounter,
    )
    this.recentEvents.push(`guard ${guarded.code} on ${guarded.candidateId}`)
    this.noteCandidateFailure(guarded.candidateId)
    this.recordFailure(guarded.code, guarded.reason)
  }

  private onActionComplete(result: ExecutionResult, decision: JevResult, candidate: Candidate): void {
    this.recentOutcomes.push({
      actionId: result.actionId,
      status: result.status,
      failure: result.failure,
      verified: result.verified,
      detail: result.detail,
    })
    if (this.recentOutcomes.length > 16) this.recentOutcomes.shift()

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
    if (pending !== undefined) {
      this.pendingDecisions.delete(result.epoch)
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

    if (result.status === 'done') {
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
        if (this.goal.complete && !this.options.singleShotPlanner) {
          this.onObjectiveComplete()
          return
        }
      }
      if (result.kind === 'DESCEND') this.onDescendComplete(result, candidate)
      this.failureStreak = 0
      this.signals.consecutiveFailures = 0
    } else {
      this.noteCandidateFailure(result.actionId)
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
      const to = this.digMemory.knownStoneY ?? from - 8
      this.logger.info('agent', `STAIRCASE from_y=${from} to_y=${to}`, { actionId: candidate.id }, this.tickCounter)
    }
  }

  private onDescendComplete(result: ExecutionResult, candidate: Candidate): void {
    const target = candidate.target
    const dir = candidate.meta.dir
    if (target !== null && (dir === 'E' || dir === 'W' || dir === 'N' || dir === 'S')) {
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
    if (delta > 0) {
      this.descendHaveBaseline = have
      this.digMemory.markResourceProgress()
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
    const impossible = this.queue.markImpossible(
      `goal kind '${current.kind}' is not executable by this PoC`,
    )
    if (impossible !== null) {
      this.recentEvents.push(`goal impossible: ${impossible.description}`)
      this.summonLlm('action_impossible', `current goal is not executable: ${impossible.description}`)
    }
  }

  private effectiveHave(): number {
    const current = this.queue.current
    if (current === null || current.targetItem === null) return 0
    // M1 completion is inventory-verified: a subgoal only completes when the item
    // is actually in the inventory. A dig whose drop was not picked up simply
    // leaves the subgoal open and the bot mines another block. A wood goal counts
    // every `*_log` the bot holds, so `birch_log` satisfies an `oak_log` goal.
    return this.countGoalCategory(current.targetItem)
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
    if (current === null || current.targetItem === null) return
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
    if (now - last < this.options.llmCooldownMs) {
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
        const added = this.queue.applyPlan(plan.goals, 'llm', plan.op ?? 'replace')
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
   * If every actionable candidate has exhausted its retries, clear the memory
   * and escalate so System 2 gets a chance to change the approach instead of
   * the agent looping on a dead candidate set forever.
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
      `all ${actionable.length} actionable candidate(s) exceeded ${this.options.candidateFailureLimit} failures; clearing failure memory`,
    )
    this.candidateFailures.clear()
    this.signals.failedCandidates = {}
    this.recentEvents.push('cleared failure memory after all candidates failed')
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

  private checkWedge(actionId: string): void {
    if (this.lastProgress > this.chosenCountsAtProgress) {
      this.chosenCounts.clear()
      this.chosenCountsAtProgress = this.lastProgress
    }
    const count = (this.chosenCounts.get(actionId) ?? 0) + 1
    this.chosenCounts.set(actionId, count)
    if (count > this.options.wedgeRepeatLimit) {
      this.abortWedge(`action id ${actionId} chosen ${count}x with no verified progress (limit ${this.options.wedgeRepeatLimit})`)
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

function candidateOptions(options: JevAgentOptions, recipes: RecipeIndex): CandidateOptions {
  return { ...defaultCandidateOptions, reach: options.reach, recipes }
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
    hooks: {
      onPathCompleted: (event) => {
        scheduler.notify('path_completed', {
          actionId: event.actionId,
          target: event.target,
          mode: event.mode,
        })
      },
      onPathFailed: (event) => {
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
