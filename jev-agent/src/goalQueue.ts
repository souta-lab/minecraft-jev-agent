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
export type GoalOrigin = 'bootstrap' | 'llm' | 'mechanical'

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

export function formatPrereqRetired(goal: QueuedGoal, dependents: number): string {
  return (
    `${PREREQ_RETIRED} id=${goal.id} item=${goal.targetItem ?? 'none'} reason=all_dependents_resolved` +
    ` dependents=${dependents} protected=${goal.protected === true} core=${goal.core === true}`
  )
}

export function formatPrereqReordered(prerequisite: QueuedGoal, consumer: QueuedGoal): string {
  return `${PREREQ_REORDERED} id=${prerequisite.id} item=${prerequisite.targetItem ?? 'none'} before=${consumer.id} consumer=${consumer.kind}`
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
      const { dropped } = splitProtectedGoals(protectedForMerge, planned)
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
    }
    this.goals.push(goal)
    return goal
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
