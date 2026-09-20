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
  isProtectedGoal,
  splitProtectedGoals,
} from './protectedGoals.ts'
import { PROTECTED_SMELT_ITEM } from './placementGuard.ts'
import { compilePlannedGoal, queuedToPlanned, stableOptionInstanceId } from './optionSpec.ts'

export type GoalKind = 'collect' | 'craft' | 'place' | 'smelt' | 'explore' | 'recover' | 'descend' | 'surface' | 'unknown'

/** Where a goal came from, for the decision log / debugging. */
export type GoalOrigin = 'bootstrap' | 'llm' | 'mechanical'

export type GoalStatus = 'pending' | 'active' | 'done' | 'impossible'

export type PlanOp = 'continue' | 'patch' | 'replace' | 'abort'

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
}

export const DUPLICATE_GOAL_SKIPPED = 'DUPLICATE_GOAL_SKIPPED'

/**
 * Identity of one goal *instance*: `stableOptionInstanceId` over the compiled
 * spec, so target count / dimension / targetY / predicate distinguish real
 * instances while byte-identical repeats collapse. The queue keys dedup on this
 * rather than the `gN:` runtime id, which changes on every enqueue.
 */
export function goalInstanceKey(goal: PlannedGoal | QueuedGoal): string {
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
  /** ordered cells a multi-cell `place` goal must fill with `targetItem` */
  placementCells?: readonly PlacementCell[]
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
  /** ordered cells a multi-cell `place` goal must fill with `targetItem` */
  placementCells?: readonly PlacementCell[]
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
          },
    pending: state.goals.filter((goal) => goal.status === 'pending').map((goal) => goal.id),
  }
}

export function emptyGoalQueueState(): GoalQueueState {
  return { depth: 0, current: null, empty: true, hasImpossible: false, done: 0, goals: [] }
}

/** A durable copy of the queue so a phase boundary can persist progress. */
export interface GoalQueueSnapshot {
  counter: number
  goals: QueuedGoal[]
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
    }
  }

  /**
   * Adopt a plan. Unfinished goals are dropped and replaced; completed goals stay
   * so the queue remains a truthful history for the log. Issue #55: protected/
   * core unfinished goals are re-inserted (or the op is rejected) instead of
   * being silently dropped.
   */
  applyPlan(
    planned: readonly PlannedGoal[],
    origin: GoalOrigin,
    op: PlanOp = 'replace',
    options: ApplyPlanOptions = {},
  ): QueuedGoal[] {
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
      return []
    }
    const reinserted: QueuedGoal[] = []
    if (op === 'continue') {
      // keep every existing goal (done and unfinished) and append the new tail
    } else {
      const unfinishedProtected = this.goals.filter(
        (goal) => (goal.status === 'pending' || goal.status === 'active') && isProtectedGoal(goal),
      )
      const { dropped } = splitProtectedGoals(unfinishedProtected, planned)
      if (planned.length === 0 && dropped.length > 0) {
        for (const goal of dropped) {
          options.onProtection?.(formatProtectedGoalDroppedRejected(goal, op, options.reason ?? 'empty_replan'))
        }
        this.activate()
        return []
      }
      const droppedQueued = unfinishedProtected.filter((goal) => dropped.some((found) => found.id === goal.id))
      if (op === 'patch') {
        // keep completed history and the currently active goal; replace the pending tail
        this.goals = this.goals.filter((goal) => goal.status === 'done' || goal.status === 'active')
      } else {
        this.goals = this.goals.filter((goal) => goal.status === 'done')
      }
      const keptIds = new Set(this.goals.map((goal) => goal.id))
      const now = Date.now()
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
      options.onProtection?.(formatProtectedGoalReinserted(original, op, options.reason ?? 'not_in_replacement'))
      this.goals.push(original)
      unfinishedInstances.add(goalInstanceKey(original))
    }
    for (const plan of planned) {
      if (plan === readyHead) continue
      insert(plan)
    }
    this.activate()
    return added
  }

  /** Build the queued form of an incoming planned goal, assigning its id. */
  private enqueue(plan: PlannedGoal, origin: GoalOrigin, now: number): QueuedGoal {
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
      ...(plan.optionInstanceId === undefined ? {} : { optionInstanceId: plan.optionInstanceId }),
      ...(plan.optionTemplateId === undefined ? {} : { optionTemplateId: plan.optionTemplateId }),
      ...(plan.optionSpec === undefined ? {} : { optionSpec: plan.optionSpec }),
      ...(plan.placementCells === undefined ? {} : { placementCells: [...plan.placementCells] }),
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
    goal.haveCount = Math.max(0, haveCount)
    goal.updatedAt = Date.now()
    if (goal.haveCount >= goal.requiredCount) {
      goal.status = 'done'
      this.activate()
    }
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
  }

  reset(): void {
    this.goals = []
    this.counter = 0
  }

  snapshot(): GoalQueueSnapshot {
    return { counter: this.counter, goals: this.goals.map((goal) => ({ ...goal })) }
  }

  restore(snapshot: GoalQueueSnapshot): void {
    this.counter = snapshot.counter
    this.goals = snapshot.goals.map((goal) => ({ ...goal }))
    this.activate()
  }

  private activate(): void {
    const goal = this.nextRef()
    if (goal !== undefined) goal.status = 'active'
  }
}
