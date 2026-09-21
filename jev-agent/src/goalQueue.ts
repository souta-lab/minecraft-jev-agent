// goalQueue.ts - the LLM's long-horizon plan, represented as a *consumable queue*.
//
// The layering is by LOOKAHEAD, not by fixed period:
//
//   Mineflayer  continuous                       movement / look / dig continuation / instant avoidance
//   Jev         event-driven + <=3 s heartbeat   next action / target / danger / retreat / replan
//   LLM         exception-driven + minutes       long-horizon goals, subgoal lists, recovery
//
// System 2 (the LLM) does not drive the loop with a timer. It is *summoned* when
// an exception happens (an unknown situation, an impossible action, a long stall,
// or Jev explicitly asking with `need_llm=true`) and its answer is a list of
// high-level goals appended here. Jev and Mineflayer then *consume* that queue on
// every decision, so the expensive model is off the hot path:
//
//   LLM plan -> goal queue [collect_logs(3), craft_table, craft_pickaxe, mine_cobblestone(16)]
//            -> consumed by Jev + Mineflayer
//            -> re-summon LLM only when the queue empties or an exception fires
//
// The queue is deliberately plain data so it can be: handed to Jev inside the
// world state, written to the decision log, and unit-tested with no bot at all.
import type { OptionSpec } from './optionSpec.ts'
import {
  abandonDetail,
  formatProtectedGoalAbandoned,
  formatProtectedGoalDroppedRejected,
  formatProtectedGoalReinserted,
  formatProtectedGoalRetired,
  isProtectedGoal,
  splitProtectedGoals,
} from './protectedGoals.ts'
import { PROTECTED_SMELT_ITEM } from './placementGuard.ts'
import {
  compilePlannedGoal,
  orderPrerequisitesBeforeConsumers,
  orphanedPrerequisiteDecision,
  queuedToPlanned,
  stableOptionInstanceId,
} from './optionSpec.ts'

export type GoalKind = 'collect' | 'craft' | 'place' | 'smelt' | 'goto' | 'explore' | 'recover' | 'descend' | 'surface' | 'unknown'

/** Where a goal came from, for the decision log / debugging. */
export type GoalOrigin = 'bootstrap' | 'llm' | 'mechanical' | 'human'

export type GoalStatus = 'pending' | 'active' | 'done' | 'impossible'

/** Typed semantic operations returned by System2. */
export type PlanOp = 'continue' | 'patch' | 'replace' | 'abandon' | 'complete' | 'abort'

export type GoalStrategy =
  | 'descend_to_y16'
  | 'explore_cave'
  | 'branch_mine'
  | 'return_to_known_ore'
  | 'return_to_surface'
  | 'smelt_and_craft'

export interface ApplyPlanOptions {
  /** Replan reason, surfaced in the PROTECTED_GOAL_* / ABANDON_REASON audit lines. */
  reason?: string
  /** Audit sink for protection and readiness-merge decisions, so the controller can log them. */
  onProtection?: (line: string) => void
  /** Audit sink for goals skipped because an identical unfinished instance is already queued. */
  onDuplicate?: (line: string) => void
  /**
   * Code-owned truth may retire a protected prerequisite when a new plan is
   * grounded on a verified world fact that makes that prerequisite obsolete.
   * Returning null keeps the normal #55 reinsertion contract unchanged.
   */
  protectedGoalRetireReason?: (goal: QueuedGoal, incoming: readonly PlannedGoal[]) => string | null
  /** Code-owned DONE proof required before a `complete` operation can mutate the queue. */
  verifyCurrentComplete?: (goal: QueuedGoal) => boolean
  /** Audit sink for rejected lifecycle operations. */
  onOperationRejected?: (line: string) => void
  /** Audit sink for orphaned-prerequisite retirement (#prereq-orphan); defaults to `onProtection`. */
  onPrereqRetired?: (line: string) => void
  /** Audit sink for prerequisite reordering (#prereq-order); defaults to `onProtection`. */
  onPrereqReordered?: (line: string) => void
}

export const DUPLICATE_GOAL_SKIPPED = 'DUPLICATE_GOAL_SKIPPED'

/**
 * #prereq-orphan: an unfinished prerequisite row was retired because every row
 * that consumed its target is resolved and no live row needs it any more.
 */
export const PREREQ_RETIRED = 'PREREQ_RETIRED'

/**
 * #prereq-order: an unfinished producer was moved in front of the unfinished
 * row whose initiation predicate it satisfies.
 */
export const PREREQ_REORDERED = 'PREREQ_REORDERED'

/**
 * #prereq-dominated: an unfinished prerequisite row was retired because every
 * purpose its product serves is already fulfilled by better/alternative items
 * the bot holds (code-owned capability closure, e.g.
 * `PREREQ_DOMINATED item=iron_ingot held=diamond_pickaxe,flint_and_steel`).
 */
export const PREREQ_DOMINATED = 'PREREQ_DOMINATED'

/** A code-owned proof that a queued prerequisite's purposes are already fulfilled. */
export interface DominatedPrerequisiteDecision {
  /** the prerequisite item whose purposes are already fulfilled */
  item: string
  /** held items that prove the purpose is fulfilled */
  held: readonly string[]
  /** machine reason (`producer_rung_satisfied` / `all_consumers_satisfied` / `outcome_already_satisfied`) */
  reason: string
  /**
   * World-outcome evidence for `outcome_already_satisfied`: the placed station
   * cells (`item@x,y,z`) whose existence already provides the row's product.
   */
  outcome?: readonly string[]
}

export function formatPrereqRetired(goal: QueuedGoal, dependents: number): string {
  return (
    `${PREREQ_RETIRED} id=${goal.id} item=${goal.targetItem ?? 'none'} reason=all_dependents_resolved` +
    ` dependents=${dependents} protected=${goal.protected === true} core=${goal.core === true}`
  )
}

export function formatPrereqDominated(goal: QueuedGoal, decision: DominatedPrerequisiteDecision): string {
  const evidence =
    decision.held.length > 0
      ? `held=${decision.held.join(',')}`
      : `held=none outcome=${(decision.outcome ?? []).join(',')}`
  return (
    `${PREREQ_DOMINATED} id=${goal.id} item=${decision.item} ${evidence}` +
    ` reason=${decision.reason} protected=${goal.protected === true} core=${goal.core === true}`
  )
}

export function formatPrereqReordered(prerequisite: QueuedGoal, consumer: QueuedGoal): string {
  return `${PREREQ_REORDERED} id=${prerequisite.id} item=${prerequisite.targetItem ?? 'none'} before=${consumer.id} consumer=${consumer.kind}`
}

// ---------------------------------------------------------------------------
// #nonprogress-yield: the bounded SEMANTIC-progress watchdog for an OPTIONAL row
// ---------------------------------------------------------------------------
//
// Measured live (m3-live `run-mublvgjx-yldu`, source cc658cb, body 9.7,68,5.3
// health=20): the head row `g37:collect:food 0/3` was emitted by the OPTIONAL
// food rung, yet it carried `core=true` and held the queue for 27 minutes at
// zero semantic progress:
//
//   CANDIDATE_STARVATION presented=1..2 productive=0 goal=collect:food:3
//     blockedBy=no_productive_action missing=["explore_route_blocked:no_frontier"]
//   LOCAL_PROGRESS_STALL stalledMs=40773.. goal=collect:food:3 boundary=local_recovery
//   JEV_HEADS action=MOVE/WAIT abandon=0.20-0.24 decision=continue
//
// while the frontier's own entry goal waited behind it. The row's 33 `body`
// MOVE decisions spanned ~15 distinct cells and gained zero items, so neither
// body motion nor `#360`'s one-pocket recurrence (distinct<=3) recognised it;
// 0 `STRATEGIC_NON_PROGRESS*` markers appear in the whole run.
//
// The missing fact is code-owned and purely mechanical: how many controller
// decisions the row has held the head while NOTHING semantic moved. Semantic
// progress is `goal`/`search` only (items gained / goal predicate moved);
// `body` displacement and `none` (WAIT) never clear the count, however far the
// body wanders. The count lives on the durable row, so a generation reload (the
// measured row was restored repeatedly) cannot reset the bound. When it is full
// the optional row may no longer occupy the head:
//
//   - `yield`: demote the proven-non-progressing row behind the plan's next
//     unfinished row. The existing plan order decides what runs next - code
//     never invents a new WHAT (`WHICH goal` stays with System2/Jev);
//   - `escalate`: with no alternative row, after the row's yield budget is spent,
//     or while a code-owned critical survival need holds, emit
//     `NON_PROGRESS_ESCALATED` so the boundary is visible.
//
// The rule is scoped by the row's own `optional` marker (never by `core`, which
// a mandatory frontier row also carries), so a mandatory head is untouched. It
// is not food/M3-specific. #55 protection is untouched: a yielded row stays
// `pending` (never dropped, never marked done/impossible).

export const NON_PROGRESS_YIELD = 'NON_PROGRESS_YIELD'
export const NON_PROGRESS_ESCALATED = 'NON_PROGRESS_ESCALATED'

/** Controller decisions with zero semantic progress before an optional head yields. */
export const NON_PROGRESS_YIELD_LIMIT_DEFAULT = 12

/** How many times one row may yield before it must escalate instead. */
export const NON_PROGRESS_MAX_YIELDS_DEFAULT = 2

/** `BUDDY_NON_PROGRESS_YIELD_LIMIT` overrides N; invalid values fall back. */
export function resolveNonProgressYieldLimit(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = Number(env.BUDDY_NON_PROGRESS_YIELD_LIMIT ?? NON_PROGRESS_YIELD_LIMIT_DEFAULT)
  return Number.isInteger(raw) && raw >= 1 ? raw : NON_PROGRESS_YIELD_LIMIT_DEFAULT
}

/** `BUDDY_NON_PROGRESS_MAX_YIELDS` overrides N; invalid values fall back. */
export function resolveNonProgressMaxYields(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = Number(env.BUDDY_NON_PROGRESS_MAX_YIELDS ?? NON_PROGRESS_MAX_YIELDS_DEFAULT)
  return Number.isInteger(raw) && raw >= 0 ? raw : NON_PROGRESS_MAX_YIELDS_DEFAULT
}

/**
 * `goal`/`search` are semantic progress; `body`/`none` are body-only motion.
 * Identical to the landed `strategicStall` classification (#360), but here
 * `body` deliberately does NOT clear the bound at all.
 */
export function isSemanticProgressKind(kind: string): boolean {
  return kind === 'goal' || kind === 'search'
}

export type NonProgressAction = 'hold' | 'yield' | 'escalate'

export type NonProgressReason =
  | 'no_current'
  | 'not_optional'
  | 'progressing'
  | 'window_open'
  | 'yielded'
  | 'critical_need'
  | 'no_alternative'
  | 'yield_budget_exhausted'

export interface NonProgressYieldOptions {
  /** controller decisions with zero semantic progress before the head yields */
  limit?: number
  /** how many times one row may yield before it escalates instead */
  maxYields?: number
  /** code-owned critical survival fact; while true the head is kept (escalates) */
  critical?: boolean
}

export interface NonProgressYieldResult {
  action: NonProgressAction
  reason: NonProgressReason
  goalId: string | null
  goalKey: string
  /** consecutive controller decisions with zero semantic progress for the head */
  decisions: number
  limit: number
  /** yields this row has already spent */
  yields: number
  maxYields: number
  /** the row that took the head when the action was `yield` */
  nextGoalId: string | null
}

/** The compact `kind:target:count` goal key the controller logs. */
export function goalKeyOf(goal: Pick<QueuedGoal, 'kind' | 'targetItem' | 'description' | 'requiredCount'>): string {
  return `${goal.kind}:${goal.targetItem ?? goal.description}:${goal.requiredCount}`
}

export function formatNonProgressYield(result: NonProgressYieldResult): string {
  return (
    `${NON_PROGRESS_YIELD} id=${result.goalId} goal=${result.goalKey} decisions=${result.decisions}/${result.limit} ` +
    `yields=${result.yields}/${result.maxYields} next=${result.nextGoalId ?? 'none'} ` +
    `reason=no_semantic_progress action=yield`
  )
}

export function formatNonProgressEscalated(result: NonProgressYieldResult): string {
  return (
    `${NON_PROGRESS_ESCALATED} id=${result.goalId} goal=${result.goalKey} decisions=${result.decisions}/${result.limit} ` +
    `yields=${result.yields}/${result.maxYields} reason=${result.reason} action=escalate`
  )
}


/**
 * Default audit sink for prerequisite reconciliation, mirroring the predicate
 * `PREDICATE_UNKNOWN` sink: production wires the resident logger through
 * `onProtection`, and a queue used without a sink still emits the marker.
 */
const defaultPrereqSink = (line: string): void => {
  process.stderr.write(`[prereq] ${line}\n`)
}

let prereqAuditSink: (line: string) => void = defaultPrereqSink

/** Route `PREREQ_RETIRED` / `PREREQ_REORDERED` lines; pass null for the stderr default. */
export function setPrereqAuditSink(sink: ((line: string) => void) | null): void {
  prereqAuditSink = sink ?? defaultPrereqSink
}

/**
 * Identity of one goal *instance*: `stableOptionInstanceId` over the compiled
 * spec, so target count / dimension / targetY / predicate distinguish real
 * instances while byte-identical repeats collapse. The queue keys dedup on this
 * rather than the `gN:` runtime id, which changes on every enqueue.
 */
export function goalInstanceKey(goal: PlannedGoal | QueuedGoal): string {
  if (typeof goal.optionInstanceId === 'string' && goal.optionInstanceId.length > 0) return goal.optionInstanceId
  return stableOptionInstanceId(compilePlannedGoal('id' in goal ? queuedToPlanned(goal) : goal))
}

export function formatDuplicateGoalSkipped(goal: PlannedGoal): string {
  return `${DUPLICATE_GOAL_SKIPPED} instance=${goalInstanceKey(goal)} description="${goal.description}"`
}

/**
 * A plain-data world cell in a finite multi-cell placement sequence. This is the
 * goal-level ("place N blocks of item X at specified cells") counterpart of the
 * executor's per-cell PLACE: the geometry lives in the goal, never hardcoded in
 * the executor.
 */
export interface PlacementCell {
  readonly x: number
  readonly y: number
  readonly z: number
}

export interface QueuedGoal {
  id: string
  /**
   * Issue #55: deterministic prerequisite marking. When true, a `patch`/
   * `replace` may not drop this goal without an explicit `abort`; the queue
   * re-inserts it and logs `PROTECTED_GOAL_REINSERTED`.
   */
  protected?: boolean
  /** Issue #55: a core/rung goal that advances the current milestone. */
  core?: boolean
  /**
   * #nonprogress-yield: this row was emitted by an OPTIONAL rung (an affordance
   * that never gates the mandatory road). It stays executable and selectable,
   * but it may not sit at the queue head forever at zero SEMANTIC progress: the
   * bounded watchdog demotes it behind the plan's next unfinished row. `core`
   * cannot carry this fact (a mandatory frontier row and an optional side quest
   * both read `core=true`), so the rung's own `optional` marker must survive the
   * compile into the durable row.
   */
  optional?: boolean
  kind: GoalKind
  strategy?: GoalStrategy
  description: string
  /** item this goal targets, when the kind is `collect` */
  targetItem: string | null
  requiredCount: number
  /**
   * Predicate goal (#41/#136): success is a code-owned level predicate, not an item count alone.
   * Absent for item-counted goals and for ledgers written before #41.
   */
  targetY?: number | null
  dimension?: string | null
  /** Issue #56: named predicate preserved from a compiled Option target. */
  targetPredicate?: string | null
  /** Issue #56: exact compiled Option identity; absent when the compiler is disabled. */
  optionInstanceId?: string
  /** Issue #56: stable semantic Option template id. */
  optionTemplateId?: string
  /** Issue #56: the full plain-data spec survives queue persistence/restart. */
  optionSpec?: OptionSpec
  /**
   * Canonical System2 semantic owner of this execution row. A prerequisite
   * row keeps its own executable Option identity above, but these fields keep
   * the parent WHAT visible through compilation, recovery, beta, and evidence.
   */
  semanticOptionInstanceId?: string
  semanticOptionTemplateId?: string
  semanticOptionIntent?: string
  /** ordered cells a multi-cell `place` goal must fill with `targetItem` */
  placementCells?: readonly PlacementCell[]
  /** Code-grounded navigation target. System2 selects the semantic goal but never supplies these coordinates. */
  targetPosition?: PlacementCell | null
  /** how many relevant items the bot held when the goal was created */
  startCount: number
  /** live progress toward `requiredCount` (collect goals) */
  haveCount: number
  status: GoalStatus
  origin: GoalOrigin
  createdAt: number
  updatedAt: number
  /** why the goal was marked impossible, when it was */
  detail: string | null
  /**
   * #nonprogress-yield: how many times this row has already been demoted behind
   * the rest of the plan for making no semantic progress. Persisted with the
   * durable queue so a restart does not reset the bound; once spent, the
   * watchdog escalates instead of yielding again.
   */
  yieldCount?: number
  /**
   * #nonprogress-yield: consecutive controller decisions this row has held the
   * head without `goal`/`search` progress. Persisted with the durable row so a
   * generation reload cannot silently reset a bound the measured stall relied on.
   */
  nonProgressDecisions?: number
}

/** A goal as proposed by the LLM. The queue assigns ids and bookkeeping. */
export interface PlannedGoal {
  kind: GoalKind
  strategy?: GoalStrategy
  description: string
  targetItem?: string | null
  requiredCount?: number
  /** Predicate goal (#41/#136): complete when the code-owned level predicate holds in `dimension`. */
  targetY?: number | null
  dimension?: string | null
  /** Issue #56: named predicate preserved from a compiled Option target. */
  targetPredicate?: string | null
  /** Issue #56: exact compiled Option identity; absent when the compiler is disabled. */
  optionInstanceId?: string
  /** Issue #56: stable semantic Option template id. */
  optionTemplateId?: string
  /** Issue #56: the full plain-data spec survives queue persistence/restart. */
  optionSpec?: OptionSpec
  /** Canonical System2 semantic owner retained while this row executes. */
  semanticOptionInstanceId?: string
  semanticOptionTemplateId?: string
  semanticOptionIntent?: string
  /** ordered cells a multi-cell `place` goal must fill with `targetItem` */
  placementCells?: readonly PlacementCell[]
  /** Code-grounded navigation target. System2 selects the semantic goal but never supplies these coordinates. */
  targetPosition?: PlacementCell | null
  detail?: string
  /** Issue #55: deterministic prerequisite; a patch/replace may not drop it. */
  protected?: boolean
  /** Issue #55: core/rung goal; a patch/replace may not drop it. */
  core?: boolean
  /** #nonprogress-yield: emitted by an OPTIONAL rung; eligible for bounded yield. */
  optional?: boolean
  /**
   * Set by the readiness compiler (`orderGoalsByReadiness`) when every
   * precondition of this goal held in the snapshot it ordered against. Absent
   * means "not proven ready", never "blocked forever".
   */
  ready?: boolean
}

/**
 * Audit marker for the #46 regression fix: a ready incoming goal kept the head
 * over a protected goal the merge re-inserted behind it.
 */
export const READY_HEAD_PRIORITY = 'READY_HEAD_PRIORITY'

/**
 * True for the M2 iron smelt whose preconditions the planner proved in its
 * readiness snapshot. The queue trusts the proof (`ready`) instead of
 * recomputing inventory state it does not own.
 */
export function isReadyIronSmelt(goal: PlannedGoal): boolean {
  return goal.kind === 'smelt' && goal.targetItem === PROTECTED_SMELT_ITEM && goal.ready === true
}

export function formatReadyHeadPriority(readyGoal: PlannedGoal, over: QueuedGoal): string {
  return `${READY_HEAD_PRIORITY} preferred=${readyGoal.kind}_${readyGoal.targetItem ?? 'unknown'} over=${over.id} reason=preconditions_satisfied`
}

export interface GoalQueueState {
  /** number of goals still pending or active (the "depth" in the log) */
  depth: number
  /** the goal currently being pursued, or null when the queue is empty */
  current: QueuedGoal | null
  empty: boolean
  /** at least one goal was marked impossible - an exception worth re-summoning for */
  hasImpossible: boolean
  done: number
  goals: QueuedGoal[]
  /** Monotonic semantic queue revision; omitted only by legacy fixtures. */
  revision?: number
}

/** The compact projection written into every decision record. */
export interface GoalQueueCurrentLog {
  id: string
  kind: GoalKind
  description: string
  status: GoalStatus
  targetItem: string | null
  haveCount: number
  requiredCount: number
  targetY: number | null
  targetPosition?: PlacementCell | null
  optionInstanceId?: string | null
  optionTemplateId?: string | null
  semanticOptionInstanceId?: string | null
  semanticOptionTemplateId?: string | null
}

export interface GoalQueueStateLog {
  depth: number
  empty: boolean
  current: GoalQueueCurrentLog | null
  /** ids of the goals still queued behind the current one, in order */
  pending: string[]
}

export function toGoalQueueStateLog(state: GoalQueueState): GoalQueueStateLog {
  return {
    depth: state.depth,
    empty: state.empty,
    current:
      state.current === null
        ? null
        : {
            id: state.current.id,
            kind: state.current.kind,
            description: state.current.description,
            status: state.current.status,
            targetItem: state.current.targetItem,
            haveCount: state.current.haveCount,
            requiredCount: state.current.requiredCount,
            targetY: state.current.targetY ?? null,
            targetPosition: state.current.targetPosition ?? null,
            optionInstanceId: state.current.optionInstanceId ?? null,
            optionTemplateId: state.current.optionTemplateId ?? null,
            semanticOptionInstanceId: state.current.semanticOptionInstanceId ?? null,
            semanticOptionTemplateId: state.current.semanticOptionTemplateId ?? null,
          },
    pending: state.goals.filter((goal) => goal.status === 'pending').map((goal) => goal.id),
  }
}

export function emptyGoalQueueState(): GoalQueueState {
  return { depth: 0, current: null, empty: true, hasImpossible: false, done: 0, goals: [], revision: 0 }
}

/** A durable copy of the queue so a phase boundary can persist progress. */
export interface GoalQueueSnapshot {
  counter: number
  goals: QueuedGoal[]
  revision?: number
  /**
   * Live semantic frontier at the time this durable queue was committed.
   * Missing basis means a legacy snapshot whose unfinished semantic state is
   * not safe to restore across a fresh generation.
   */
  basis?: LedgerBasis
}

/** Minimal live context used to validate a durable semantic queue on restore. */
export interface LedgerBasis {
  worldKey: string
  frontierRungId: string
  frontierRungIndex: number
}

/**
 * A FIFO of high-level goals.
 *
 * `applyPlan` is the LLM hand-off: it replaces the *unfinished* portion with the
 * freshly planned goals (finished goals are kept for the log). A new plan may not
 * destroy a goal that already completed, but it is allowed to re-plan the work
 * that is still ahead - which is exactly what "re-summon on exception" means.
 */
export class GoalQueue {
  private goals: QueuedGoal[] = []
  private counter = 0
  private queueRevision = 0
  /** Most recent plan's audit sink, reused by later lifecycle transitions. */
  private lifecycleSink: ((line: string) => void) | undefined
  /**
   * #prereq-dominated: code-owned prerequisite-domination proof. The resident
   * wires the deterministic ladder's closure here; absent (unit tests) means no
   * domination retirement. It receives the goal only - the caller's closure reads
   * live inventory at call time.
   */
  private dominatedPrerequisiteReason:
    | ((goal: QueuedGoal) => DominatedPrerequisiteDecision | null)
    | undefined

  /**
   * Install the #prereq-dominated proof. Kept as an explicit method (not a plan
   * option) because the reconciliation runs on every lifecycle transition, not
   * only when a plan is applied.
   */
  setDominatedPrerequisiteReason(
    reason: ((goal: QueuedGoal) => DominatedPrerequisiteDecision | null) | null,
  ): void {
    this.dominatedPrerequisiteReason = reason ?? undefined
  }

  get revision(): number {
    return this.queueRevision
  }

  get size(): number {
    return this.goals.length
  }

  /** The real (mutable) reference to the first unfinished goal, if any. */
  private nextRef(): QueuedGoal | undefined {
    return this.goals.find((goal) => goal.status === 'pending' || goal.status === 'active')
  }

  get current(): QueuedGoal | null {
    const goal = this.nextRef()
    return goal === undefined ? null : { ...goal }
  }

  get isEmpty(): boolean {
    return this.nextRef() === undefined
  }

  get state(): GoalQueueState {
    const current = this.nextRef()
    const remaining = this.goals.filter((goal) => goal.status === 'pending' || goal.status === 'active')
    return {
      depth: remaining.length,
      current: current === undefined ? null : { ...current },
      empty: remaining.length === 0,
      hasImpossible: this.goals.some((goal) => goal.status === 'impossible'),
      done: this.goals.filter((goal) => goal.status === 'done').length,
      goals: this.goals.map((goal) => ({ ...goal })),
      revision: this.queueRevision,
    }
  }

  /**
   * Adopt a plan. Unfinished goals are dropped and replaced; completed goals stay
   * so the queue remains a truthful history for the log. Issue #55: protected/
   * core unfinished goals are re-inserted (or the op is rejected) instead of
   * being silently dropped. A caller may explicitly retire one only when its
   * code-owned world-truth callback proves that prerequisite obsolete.
   */
  applyPlan(
    planned: readonly PlannedGoal[],
    origin: GoalOrigin,
    op: PlanOp = 'replace',
    options: ApplyPlanOptions = {},
  ): QueuedGoal[] {
    const audit = options.onPrereqRetired ?? options.onPrereqReordered ?? options.onProtection
    if (audit !== undefined) this.lifecycleSink = audit
    const humanActive = this.goals.some(
      (goal) => goal.origin === 'human' && (goal.status === 'pending' || goal.status === 'active'),
    )
    if (origin === 'llm' && humanActive) {
      options.onOperationRejected?.(`PLAN_OP_REJECTED op=${op} reason=human_interrupt_active`)
      return []
    }
    let effectiveOp = op
    let abandonedCurrentId: string | null = null
    if (op === 'complete') {
      const current = this.nextRef()
      if (current === undefined || options.verifyCurrentComplete?.(current) !== true) {
        options.onOperationRejected?.(
          `PLAN_OP_REJECTED op=complete current=${current?.id ?? 'none'} reason=code_completion_not_verified`,
        )
        return []
      }
      current.status = 'done'
      current.haveCount = Math.max(current.haveCount, current.requiredCount)
      current.updatedAt = Date.now()
      this.activate()
      this.queueRevision += 1
      // `complete` is a lifecycle transition for the current Option only. The
      // existing pending tail is still valid and must not be erased as though
      // this were an empty `replace`.
      return []
    }
    if (op === 'abandon') {
      const current = this.nextRef()
      if (current !== undefined && isProtectedGoal(current)) {
        options.onOperationRejected?.(`PLAN_OP_REJECTED op=abandon current=${current.id} reason=protected_goal`)
        return []
      }
      if (current === undefined) {
        options.onOperationRejected?.('PLAN_OP_REJECTED op=abandon current=none reason=no_current_option')
        return []
      }
      current.status = 'impossible'
      current.detail = abandonDetail(options.reason ?? 'system2 abandon', false)
      current.updatedAt = Date.now()
      abandonedCurrentId = current.id
      // `abandon` is a typed semantic switch: retain the abandoned row as audit
      // history, discard the old pending tail, and install the returned plan.
      effectiveOp = 'replace'
    }
    if (op === 'abort') {
      const now = Date.now()
      for (const goal of this.goals) {
        if (goal.status === 'done') continue
        const protect = isProtectedGoal(goal)
        goal.status = 'impossible'
        goal.detail = abandonDetail(options.reason, protect)
        goal.updatedAt = now
        if (protect) options.onProtection?.(formatProtectedGoalAbandoned(goal, options.reason ?? 'abort'))
      }
      this.activate()
      this.queueRevision += 1
      return []
    }
    const reinserted: QueuedGoal[] = []
    if (effectiveOp === 'continue') {
      // keep every existing goal (done and unfinished) and append the new tail
    } else {
      const unfinishedProtected = this.goals.filter(
        (goal) => (goal.status === 'pending' || goal.status === 'active') && isProtectedGoal(goal),
      )
      const now = Date.now()
      const retiredProtected: QueuedGoal[] = []
      for (const goal of unfinishedProtected) {
        const reason = options.protectedGoalRetireReason?.(goal, planned)
        if (reason === undefined || reason === null || reason.length === 0) continue
        goal.status = 'impossible'
        goal.detail = `retired by verified world truth: ${reason}`
        goal.updatedAt = now
        retiredProtected.push(goal)
        options.onProtection?.(formatProtectedGoalRetired(goal, reason))
      }
      const retiredIds = new Set(retiredProtected.map((goal) => goal.id))
      const protectedForMerge = unfinishedProtected.filter((goal) => !retiredIds.has(goal.id))
      const partition = splitProtectedGoals(protectedForMerge, planned)
      // Human intent is stronger provenance than an equivalent System2 goal.
      // Even when the model proposes the same kind/item, keep the exact human
      // row so requested count/order/origin cannot be silently rewritten.
      const dropped = [...partition.dropped]
      for (const goal of protectedForMerge) {
        if (goal.origin !== 'human' || dropped.some((entry) => entry.id === goal.id)) continue
        dropped.push(goal)
      }
      if (planned.length === 0 && dropped.length > 0) {
        for (const goal of dropped) {
          options.onProtection?.(formatProtectedGoalDroppedRejected(goal, effectiveOp, options.reason ?? 'empty_replan'))
        }
        this.activate()
        return []
      }
      const droppedQueued = protectedForMerge.filter((goal) => dropped.some((found) => found.id === goal.id))
      if (effectiveOp === 'patch') {
        // keep completed history and the currently active goal; replace the pending tail
        this.goals = this.goals.filter((goal) => goal.status === 'done' || goal.status === 'active' || retiredIds.has(goal.id))
      } else {
        this.goals = this.goals.filter(
          (goal) => goal.status === 'done' || goal.id === abandonedCurrentId || retiredIds.has(goal.id),
        )
      }
      const keptIds = new Set(this.goals.map((goal) => goal.id))
      for (const original of droppedQueued) {
        if (keptIds.has(original.id)) continue
        reinserted.push({ ...original, status: 'pending', updatedAt: now })
      }
    }
    const now = Date.now()
    const added: QueuedGoal[] = []
    // Insert once per distinct unfinished instance: a plan re-applied on an
    // unchanged tick must not grow the queue with copies of goals still pending.
    const unfinishedInstances = new Set<string>()
    for (const goal of this.goals) {
      if (goal.status === 'pending' || goal.status === 'active') unfinishedInstances.add(goalInstanceKey(goal))
    }
    const insert = (plan: PlannedGoal): void => {
      const key = goalInstanceKey(plan)
      if (unfinishedInstances.has(key)) {
        options.onDuplicate?.(formatDuplicateGoalSkipped(plan))
        return
      }
      unfinishedInstances.add(key)
      added.push(this.enqueue(plan, origin, now))
    }
    // #46 regression: the planner proved this smelt ready, so a protected goal
    // re-inserted behind it must not leapfrog it back to the head.
    const readySmelt = planned.find(isReadyIronSmelt)
    const firstReinserted = reinserted[0]
    const readyHead = readySmelt !== undefined && firstReinserted !== undefined ? readySmelt : undefined
    if (readyHead !== undefined && firstReinserted !== undefined) {
      options.onProtection?.(formatReadyHeadPriority(readyHead, firstReinserted))
      insert(readyHead)
    }
    for (const original of reinserted) {
      options.onProtection?.(formatProtectedGoalReinserted(original, effectiveOp, options.reason ?? 'not_in_replacement'))
      this.goals.push(original)
      unfinishedInstances.add(goalInstanceKey(original))
    }
    for (const plan of planned) {
      if (plan === readyHead) continue
      insert(plan)
    }
    this.activate()
    this.queueRevision += 1
    return added
  }

  /**
   * Insert explicit human work ahead of autonomous unfinished work without
   * deleting the mission. Multiple human requests are FIFO. Human rows are
   * protected so asynchronous System2 repairs cannot replace the player's WHAT.
   */
  interruptWithHumanPlan(planned: readonly PlannedGoal[], options: Pick<ApplyPlanOptions, 'onDuplicate'> = {}): QueuedGoal[] {
    if (planned.length === 0) return []
    const now = Date.now()
    const humanInstances = new Set(
      this.goals
        .filter((goal) => goal.origin === 'human' && (goal.status === 'pending' || goal.status === 'active'))
        .map((goal) => goalInstanceKey(goal)),
    )
    const current = this.nextRef()
    const firstAutonomous = this.goals.findIndex(
      (goal) => goal.origin !== 'human' && (goal.status === 'pending' || goal.status === 'active'),
    )
    const insertionIndex = firstAutonomous < 0 ? this.goals.length : firstAutonomous
    const originalLength = this.goals.length
    const added: QueuedGoal[] = []
    for (const plan of planned) {
      const humanPlan: PlannedGoal = { ...plan, protected: true }
      const key = goalInstanceKey(humanPlan)
      if (humanInstances.has(key)) {
        options.onDuplicate?.(formatDuplicateGoalSkipped(humanPlan))
        continue
      }
      humanInstances.add(key)
      added.push(this.enqueue(humanPlan, 'human', now))
    }
    if (added.length === 0) return []
    const appended = this.goals.splice(originalLength)
    if (current !== undefined && current.origin !== 'human' && current.status === 'active') {
      current.status = 'pending'
      current.updatedAt = now
    }
    this.goals.splice(insertionIndex, 0, ...appended)
    this.activate()
    this.queueRevision += 1
    return added
  }

  /** Cancel unfinished human interrupts only; completed history and mission rows remain. */
  clearHumanInterrupts(reason = 'human free'): QueuedGoal[] {
    const now = Date.now()
    const cleared: QueuedGoal[] = []
    for (const goal of this.goals) {
      if (goal.origin !== 'human' || (goal.status !== 'pending' && goal.status !== 'active')) continue
      goal.status = 'impossible'
      goal.detail = `cancelled by human: ${reason}`
      goal.updatedAt = now
      cleared.push({ ...goal })
    }
    if (cleared.length === 0) return []
    this.activate()
    this.queueRevision += 1
    return cleared
  }

  /** Build the queued form of an incoming planned goal, assigning its id. */
  private enqueue(plan: PlannedGoal, origin: GoalOrigin, now: number): QueuedGoal {
    const spec = plan.optionSpec ?? compilePlannedGoal(plan)
    const optionTemplateId = plan.optionTemplateId ?? spec.id
    const optionInstanceId = plan.optionInstanceId ?? stableOptionInstanceId(spec)
    this.counter += 1
    const goal: QueuedGoal = {
      id: `g${this.counter}:${plan.kind}${plan.targetItem != null ? `:${plan.targetItem}` : ''}`,
      kind: plan.kind,
      ...(plan.strategy === undefined ? {} : { strategy: plan.strategy }),
      description: plan.description,
      targetItem: plan.targetItem ?? null,
      requiredCount: Math.max(1, Math.floor(plan.requiredCount ?? 1)),
      targetY: plan.targetY ?? null,
      dimension: plan.dimension ?? null,
      ...(plan.targetPredicate === undefined ? {} : { targetPredicate: plan.targetPredicate ?? null }),
      optionInstanceId,
      optionTemplateId,
      optionSpec: spec,
      ...(plan.semanticOptionInstanceId === undefined ? {} : { semanticOptionInstanceId: plan.semanticOptionInstanceId }),
      ...(plan.semanticOptionTemplateId === undefined ? {} : { semanticOptionTemplateId: plan.semanticOptionTemplateId }),
      ...(plan.semanticOptionIntent === undefined ? {} : { semanticOptionIntent: plan.semanticOptionIntent }),
      ...(plan.placementCells === undefined ? {} : { placementCells: [...plan.placementCells] }),
      ...(plan.targetPosition === undefined
        ? {}
        : { targetPosition: plan.targetPosition === null ? null : { ...plan.targetPosition } }),
      startCount: 0,
      haveCount: 0,
      status: 'pending',
      origin,
      createdAt: now,
      updatedAt: now,
      detail: plan.detail ?? null,
      protected: plan.protected === true,
      core: plan.core === true,
      ...(plan.optional === true ? { optional: true } : {}),
    }
    this.goals.push(goal)
    return goal
  }

  /**
   * #nonprogress-yield: a settled executor decision that showed `goal`/`search`
   * progress clears the zero-semantic-progress bound for the row that holds the
   * queue. `body` displacement and WAIT deliberately do NOT (see the module
   * comment): a successful MOVE - however far it wanders - is not semantic
   * progress. The counter lives on the durable row, so a generation reload cannot
   * silently reset the bound. Returns the resulting count for diagnostics.
   */
  noteSemanticProgress(progressKinds: readonly string[]): number {
    const goal = this.nextRef()
    if (goal === undefined) return 0
    if (progressKinds.some(isSemanticProgressKind)) goal.nonProgressDecisions = 0
    return goal.nonProgressDecisions ?? 0
  }

  /**
   * #nonprogress-yield: the bounded head-progress reconciliation. The controller
   * runs it once per decision/tick; it is pure with respect to world state (the
   * caller supplies the code-owned `critical` survival fact) and directly
   * fixture-testable. Each call counts as one decision for an optional head.
   *
   *   - only a row emitted by an OPTIONAL rung is eligible; a mandatory/frontier
   *     head is returned unchanged with `reason=not_optional` and is not counted;
   *   - `yield` demotes a proven-non-progressing row behind the plan's next
   *     unfinished row. This is an execution-order transition, not a new WHAT:
   *     the plan already ordered the alternatives, and System2 still owns them;
   *   - `escalate` fires when there is no alternative row, when the row's yield
   *     budget is spent, or while a critical survival need holds - always with
   *     the typed `NON_PROGRESS_ESCALATED` marker so the boundary is visible.
   */
  reconcileNonProgressingHead(options: NonProgressYieldOptions = {}): NonProgressYieldResult {
    const limit = Math.max(1, Math.floor(options.limit ?? resolveNonProgressYieldLimit()))
    const maxYields = Math.max(0, Math.floor(options.maxYields ?? resolveNonProgressMaxYields()))
    const current = this.nextRef()
    if (current === undefined) {
      return {
        action: 'hold',
        reason: 'no_current',
        goalId: null,
        goalKey: 'none',
        decisions: 0,
        limit,
        yields: 0,
        maxYields,
        nextGoalId: null,
      }
    }
    const yields = current.yieldCount ?? 0
    if (current.optional !== true) {
      return {
        action: 'hold',
        reason: 'not_optional',
        goalId: current.id,
        goalKey: goalKeyOf(current),
        decisions: current.nonProgressDecisions ?? 0,
        limit,
        yields,
        maxYields,
        nextGoalId: null,
      }
    }
    // One reconcile call is one controller decision for the optional head.
    current.nonProgressDecisions = (current.nonProgressDecisions ?? 0) + 1
    const decisions = current.nonProgressDecisions
    const base = { goalId: current.id, goalKey: goalKeyOf(current), decisions, limit, yields, maxYields }
    if (decisions < limit) {
      return { ...base, action: 'hold', reason: decisions <= 1 ? 'progressing' : 'window_open', nextGoalId: null }
    }
    const alternative = this.goals.find(
      (goal) => goal.id !== current.id && (goal.status === 'pending' || goal.status === 'active'),
    )
    // A proven-critical survival need keeps the head but is still reported, so a
    // starving body's optional food row can never sit silent even when it yields
    // no progress. Its bound is re-armed so the NEXT window still escalates.
    if (options.critical === true) {
      current.nonProgressDecisions = 0
      return { ...base, action: 'escalate', reason: 'critical_need', nextGoalId: alternative?.id ?? null }
    }
    if (alternative === undefined) {
      current.nonProgressDecisions = 0
      return { ...base, action: 'escalate', reason: 'no_alternative', nextGoalId: null }
    }
    if (yields >= maxYields) {
      current.nonProgressDecisions = 0
      return { ...base, action: 'escalate', reason: 'yield_budget_exhausted', nextGoalId: alternative.id }
    }
    current.yieldCount = yields + 1
    current.nonProgressDecisions = 0
    current.status = 'pending'
    current.updatedAt = Date.now()
    const nextGoalId = this.demoteToBack(current)
    this.queueRevision += 1
    return { ...base, yields: yields + 1, action: 'yield', reason: 'yielded', nextGoalId }
  }

  /**
   * Move one unfinished row after every other unfinished row, preserving the
   * plan's relative order for the rest. Resolved history keeps its ledger slot.
   * Returns the row that now holds the queue.
   */
  private demoteToBack(current: QueuedGoal): string | null {
    const unfinished = this.goals.filter((goal) => goal.status === 'pending' || goal.status === 'active')
    if (unfinished.length <= 1) return null
    const ordered = [...unfinished.filter((goal) => goal.id !== current.id), current]
    let cursor = 0
    this.goals = this.goals.map((goal) => {
      if (goal.status !== 'pending' && goal.status !== 'active') return goal
      const replacement = ordered[cursor]
      cursor += 1
      return replacement ?? goal
    })
    this.activate()
    return this.nextRef()?.id ?? null
  }

  /** Record live progress on the current inventory-counted goal (`collect`/`craft`); completes it if met. */
  markProgress(haveCount: number): void {
    const goal = this.nextRef()
    if (goal === undefined) return
    if (goal.kind !== 'collect' && goal.kind !== 'craft' && goal.kind !== 'smelt') return
    const nextHave = Math.max(0, haveCount)
    const wasStatus = goal.status
    if (nextHave === goal.haveCount && !(nextHave >= goal.requiredCount && wasStatus !== 'done')) return
    goal.haveCount = nextHave
    goal.updatedAt = Date.now()
    if (goal.haveCount >= goal.requiredCount) {
      goal.status = 'done'
      this.activate()
    }
    this.queueRevision += 1
  }

  /** Mark the current goal impossible (the PoC cannot execute it) and advance. */
  markImpossible(detail: string): QueuedGoal | null {
    const goal = this.nextRef()
    if (goal === undefined) return null
    goal.status = 'impossible'
    goal.detail = detail
    goal.updatedAt = Date.now()
    const clone = { ...goal }
    this.activate()
    this.queueRevision += 1
    return clone
  }

  /** Mark the current goal done regardless of count (e.g. a crafted item). */
  markDone(): void {
    const goal = this.nextRef()
    if (goal === undefined) return
    goal.status = 'done'
    goal.haveCount = Math.max(goal.haveCount, goal.requiredCount)
    goal.updatedAt = Date.now()
    this.activate()
    this.queueRevision += 1
  }

  reset(): void {
    this.goals = []
    this.counter = 0
    this.queueRevision += 1
  }

  /**
   * #prereq-orphan: retire every unfinished row that the durable ledger proves
   * is a leftover prerequisite - every row that consumed its target is resolved
   * (done/impossible) and no live row requires the target any more. Retirement
   * cascades (retiring `place:furnace` orphans the `craft:furnace` that fed it)
   * and is bounded by the ledger length. It never marks a row done and never
   * drops a row a live consumer still requires, so a genuinely required but
   * unsatisfiable row still fails visibly (issue #55).
   */
  retireOrphanedPrerequisites(options: ApplyPlanOptions = {}, now: number = Date.now()): QueuedGoal[] {
    const sink = options.onPrereqRetired ?? options.onProtection ?? this.lifecycleSink ?? prereqAuditSink
    const retired: QueuedGoal[] = []
    let changed = true
    let guard = 0
    while (changed && guard <= this.goals.length) {
      changed = false
      guard += 1
      for (const goal of this.goals) {
        if (goal.status !== 'pending' && goal.status !== 'active') continue
        // #prereq-dominated: a code-owned proof that the purposes this row's
        // product serves are already fulfilled by better items retires it before
        // the orphan heuristic (which cannot see a consumer row that was pruned).
        const dominated = this.dominatedPrerequisiteReason?.(goal)
        if (dominated !== null && dominated !== undefined) {
          const evidence =
            dominated.held.length > 0
              ? `held=${dominated.held.join(',')}`
              : `held=none outcome=${(dominated.outcome ?? []).join(',')}`
          goal.status = 'impossible'
          goal.detail = `retired dominated prerequisite: item=${dominated.item} ${evidence} reason=${dominated.reason}`
          goal.updatedAt = now
          retired.push(goal)
          sink(formatPrereqDominated(goal, dominated))
          changed = true
          continue
        }
        const decision = orphanedPrerequisiteDecision(goal, this.goals)
        if (!decision.retire) continue
        goal.status = 'impossible'
        goal.detail = `retired prerequisite: reason=${decision.reason} dependents=${decision.dependents}`
        goal.updatedAt = now
        retired.push(goal)
        sink(formatPrereqRetired(goal, decision.dependents))
        changed = true
      }
    }
    if (retired.length > 0) this.queueRevision += 1
    return retired
  }

  /**
   * #prereq-order: reorder only the UNFINISHED subsequence so an unfinished
   * producer precedes the unfinished row whose initiation predicate it
   * satisfies. Resolved history keeps its ledger position, and no row is added,
   * dropped, or completed. Returns the moves that were applied.
   */
  orderPrerequisites(
    options: ApplyPlanOptions = {},
  ): Array<{ prerequisite: QueuedGoal; consumer: QueuedGoal }> {
    const unfinished = this.goals.filter((goal) => goal.status === 'pending' || goal.status === 'active')
    if (unfinished.length < 2) return []
    const { rows, moves } = orderPrerequisitesBeforeConsumers(unfinished)
    if (moves.length === 0) return []
    const sink = options.onPrereqReordered ?? options.onProtection ?? this.lifecycleSink ?? prereqAuditSink
    let cursor = 0
    this.goals = this.goals.map((goal) => {
      if (goal.status !== 'pending' && goal.status !== 'active') return goal
      const replacement = rows[cursor]
      cursor += 1
      return replacement ?? goal
    })
    for (const move of moves) sink(formatPrereqReordered(move.prerequisite, move.consumer))
    this.queueRevision += 1
    return moves
  }

  /**
   * Deterministic prerequisite reconciliation, run on every lifecycle
   * transition (plan apply, progress, completion, restore). It cannot add work,
   * cannot mark a row done, and cannot drop a row a live consumer requires.
   */
  private reconcilePrerequisites(): void {
    this.retireOrphanedPrerequisites()
    this.orderPrerequisites()
  }

  snapshot(): GoalQueueSnapshot {
    return { counter: this.counter, goals: this.goals.map((goal) => ({ ...goal })), revision: this.queueRevision }
  }

  restore(snapshot: GoalQueueSnapshot): void {
    this.counter = snapshot.counter
    this.goals = snapshot.goals.map((goal) => {
      const copy = { ...goal }
      const spec = copy.optionSpec ?? compilePlannedGoal(queuedToPlanned(copy as QueuedGoal))
      copy.optionSpec = spec
      copy.optionTemplateId = copy.optionTemplateId ?? spec.id
      copy.optionInstanceId = copy.optionInstanceId ?? stableOptionInstanceId(spec)
      return copy
    })
    this.queueRevision = Math.max(this.queueRevision + 1, snapshot.revision ?? 0)
    this.activate()
  }

  private activate(): void {
    this.reconcilePrerequisites()
    const goal = this.nextRef()
    if (goal !== undefined) goal.status = 'active'
  }
}
