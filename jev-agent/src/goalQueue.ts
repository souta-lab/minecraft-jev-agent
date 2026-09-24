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
import { PORTAL_ENTERED_PREDICATE } from './netherPortalPlan.ts'
import {
  abandonDetail,
  formatProtectedGoalAbandoned,
  formatProtectedGoalDroppedRejected,
  formatProtectedGoalReinserted,
  formatProtectedGoalRetired,
  isProtectedGoal,
  isReplaceableOptionalFoodGoal,
  splitProtectedGoals,
} from './protectedGoals.ts'
import { PROTECTED_SMELT_ITEM } from './placementGuard.ts'
import {
  formatGoalSuccessProbeError,
  formatGoalSuccessRetirement,
} from './goalSuccess.ts'
import type { GoalSuccessEvidence } from './goalSuccess.ts'
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

export function formatPrereqRetired(
  goal: QueuedGoal,
  decision: { dependents: number; causalOwnerIds: readonly string[]; dependentIds: readonly string[] },
): string {
  const causal = ` causalOwners=[${decision.causalOwnerIds.join(',')}] consumers=[${decision.dependentIds.join(',')}]`
  return (
    `${PREREQ_RETIRED} id=${goal.id} item=${goal.targetItem ?? 'none'} reason=all_dependents_resolved` +
    ` dependents=${decision.dependents}${causal} protected=${goal.protected === true} core=${goal.core === true}`
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

// ---------------------------------------------------------------------------
// #plan-reconciliation: the plan/objective identity a durable row was authored
// under, and the reconciliation that compares it with the live objective.
// ---------------------------------------------------------------------------
//
// Measured live (m3-live, `run-mucpugqn-20evo`): the durable queue's head was
// `g1:descend:raw_iron kind=descend dim=minecraft:overworld` with the spatial
// success predicate `levelAtMost y32`, while the body was in the NETHER at y63
// and the mission had moved to `blaze_rods` (M3). The row was authored by an
// M2-era exploration plan; nothing in the queue, the controller or the host
// compared the plan that authored it with the plan the objective now implies.
// The row's own predicate was genuinely UNSATISFIED there, so predicate
// retirement correctly left it alone (goalSuccess.ts), and it could not
// complete: the body climbed to y102 in the Nether chasing an overworld y32
// target, forever.
//
// A row therefore carries the identity of the plan/objective projection that
// authored it (`QueuedGoal.planIdentity`), and the queue reconciles that
// identity against the live one on every lifecycle transition. Retirement is
// never a preference and never "the predicate is unsatisfied": it requires a
// code-owned proof supplied by the caller (`isObsolete`), exactly like the
// #prereq-dominated closure.
export interface PlanIdentity {
  /** frontier rung that owned the outstanding work when the plan was authored */
  rungId: string
  rungIndex: number
  /** item-bearing objective the plan existed to advance */
  objectiveItem: string | null
  objectiveCount: number
}

/**
 * Stable comparison id for a plan identity.
 *
 * The PLAN identity is its frontier projection (`rungId@rungIndex`): that is the
 * ladder's own code-owned statement of which rung's work is outstanding, so two
 * identities with the same frontier are the same plan even if the objective
 * projection around them is spelled differently (e.g. a legacy snapshot restored
 * from `basis`, whose rows carried no objective). The objective fields are
 * evidence in `formatPlanIdentity`, not part of the comparison - including them
 * would make every generation start look like a supersession.
 */
export function planIdentityId(identity: PlanIdentity): string {
  return `${identity.rungId}@${identity.rungIndex}`
}

/** Compact one-line identity evidence for the durable log. */
export function formatPlanIdentity(identity: PlanIdentity | null): string {
  if (identity === null) return 'none'
  return `${identity.rungId}@${identity.rungIndex} objective=${identity.objectiveItem ?? 'none'}x${identity.objectiveCount}`
}

export const PLAN_IDENTITY_CHANGED = 'PLAN_IDENTITY_CHANGED'
export const PLAN_ROW_RETIRED = 'PLAN_ROW_RETIRED'
export const ROW_NOT_EXECUTABLE_HERE = 'ROW_NOT_EXECUTABLE_HERE'
export const ROW_DEFERRED_NOT_EXECUTABLE_HERE = 'ROW_DEFERRED_NOT_EXECUTABLE_HERE'
/**
 * #plan-reconciliation: the head row System2 was EXPLICITLY asked about
 * (`action_impossible` / `no_progress`) was replaced by the plan it authored.
 * This is the one retirement that does not need the authoring-frontier proof,
 * because the model's own answer IS the statement that the old plan is over.
 */
export const PLAN_HEAD_REPLACED = 'PLAN_HEAD_REPLACED'

/** The bounded, per-request authority to replace the head System2 answered about. */
export interface HeadAnswerWarrant {
  /** the request whose answer may replace the head */
  requestId: string
  /** the head row the request was about */
  headId: string
  headKey: string
  /** the summon reason (`action_impossible`, `no_progress`, ...) */
  reason: string
}

export interface HeadReplacementOptions {
  /** the row must still be the head; any other row leaves this a no-op */
  headId: string
  requestId: string
  /** the summon reason that asked the question */
  reason: string
  /** the answering plan's own note/op, for the audit line */
  note?: string
  onReplaced?: (line: string, detail: Record<string, unknown>) => void
  now?: number
}

export function formatPlanHeadReplaced(goal: QueuedGoal, options: HeadReplacementOptions): string {
  return (
    `${PLAN_HEAD_REPLACED} id=${goal.id} goal=${goalKeyOf(goal)} reason=${options.reason}` +
    ` requestId=${options.requestId} note="${(options.note ?? '').slice(0, 80)}"`
  )
}

/** A code-owned proof that a row authored under a superseded plan is obsolete. */
export interface PlanObsoleteProof {
  /** machine reason (e.g. `authoring_frontier_behind_current`) */
  reason: string
  /** typed evidence tokens naming the facts the proof used */
  evidence: readonly string[]
}

export interface PlanRowRetirement {
  id: string
  description: string
  goalKey: string
  /** identity the row was authored under (null for an unstamped legacy row) */
  authoredUnder: string | null
  reason: string
  evidence: readonly string[]
}

export interface PlanIdentityReconciliation {
  previous: PlanIdentity | null
  current: PlanIdentity
  /** current vs previous identity id */
  changed: boolean
  /** unfinished rows authored under a superseded identity, with or without a proof */
  superseded: number
  /** rows retired by the code-owned proof */
  retired: PlanRowRetirement[]
  /** superseded rows kept because no proof said they are obsolete */
  kept: PlanRowRetirement[]
  /** unstamped legacy rows that adopted the current identity */
  adoptedLegacy: number
  /** the head row is authored under a superseded identity */
  headSuperseded: boolean
}

export interface PlanReconciliationOptions {
  current: PlanIdentity
  /** Code-owned obsolescence proof; returning null keeps the row. */
  isObsolete?: (goal: QueuedGoal) => PlanObsoleteProof | null
  /** Audit sink for retired rows; defaults to the lifecycle sink. */
  onSuperseded?: (line: string, detail: Record<string, unknown>) => void
  now?: number
}

export interface NotExecutableHeadOptions {
  /** live bot dimension (e.g. `minecraft:the_nether`), null when unknown */
  liveDimension: string | null
  /** how many times one row may be deferred before it escalates instead */
  limit?: number
  now?: number
}

/**
 * #plan-reconciliation: the postconditions whose SUCCESS is a dimension change.
 *
 * A row carrying one of these declares its `dimension` as the DESTINATION, not as
 * a place it can only run: the whole point of the row is that the body is on the
 * other side. Measured live (main 06c5976, the floated-portal trial):
 * `g99:place:nether_portal targetPredicate=portal_entered dimension=the_nether` was
 * classified not-executable-here while the body stood in the overworld, the offer
 * binding then withheld the entry's own climb/dig legs for 1370 firings (one hour)
 * and the body froze at (26.3,64.0,6.3) - unable even to reach the gate it was
 * supposed to enter.
 */
export const DIMENSION_TRANSFER_PREDICATES: ReadonlySet<string> = new Set<string>([PORTAL_ENTERED_PREDICATE])

/** Compiled Option identities that realize a dimension transfer. */
export const DIMENSION_TRANSFER_TEMPLATES: ReadonlySet<string> = new Set<string>(['enter:nether_portal', 'enter_portal'])

/**
 * Is this row's own SUCCESS a dimension change? If so its `dimension` is the
 * target dimension and the not-executable-here arm must not apply to it. The
 * `goto` arm keeps its own dimension guard (a goto target really is a place).
 */
export function isDimensionTransferGoal(
  goal: Pick<QueuedGoal, 'kind' | 'targetPredicate' | 'optionTemplateId' | 'semanticOptionTemplateId'>,
): boolean {
  if (goal.kind === 'goto') return false
  const predicate = goal.targetPredicate ?? null
  if (predicate !== null && DIMENSION_TRANSFER_PREDICATES.has(predicate)) return true
  const template = goal.optionTemplateId ?? goal.semanticOptionTemplateId ?? null
  return template !== null && DIMENSION_TRANSFER_TEMPLATES.has(template)
}

export type NotExecutableHeadAction = 'hold' | 'defer' | 'escalate'

export type NotExecutableHeadReason =
  | 'no_current'
  | 'executable_here'
  | 'unknown_dimension'
  /** a dimension-TRANSFER row: its declared dimension is the destination */
  | 'dimension_transfer_goal'
  | 'deferred'
  | 'no_executable_alternative'
  | 'defer_budget_exhausted'

export interface NotExecutableHeadResult {
  action: NotExecutableHeadAction
  reason: NotExecutableHeadReason
  goalId: string | null
  goalKey: string
  declaredDimension: string | null
  liveDimension: string | null
  /** the row that took the head when the action was `defer` */
  nextGoalId: string | null
  /** defers this row has already spent */
  defers: number
  limit: number
}

/** Default bound on the typed dimension deferral. */
export const NOT_EXECUTABLE_DEFER_LIMIT_DEFAULT = 3

export function resolveNotExecutableDeferLimit(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = Number(env.BUDDY_NOT_EXECUTABLE_DEFER_LIMIT ?? NOT_EXECUTABLE_DEFER_LIMIT_DEFAULT)
  return Number.isInteger(raw) && raw >= 0 ? raw : NOT_EXECUTABLE_DEFER_LIMIT_DEFAULT
}

/** `minecraft:the_nether` and `the_nether` are the same dimension. */
export function normalizeGoalDimension(dimension: string | null | undefined): string | null {
  if (typeof dimension !== 'string') return null
  const trimmed = dimension.trim().replace(/^minecraft:/, '')
  return trimmed.length === 0 ? null : trimmed
}

export function formatPlanRowRetired(
  goal: QueuedGoal,
  current: PlanIdentity,
  proof: PlanObsoleteProof,
): string {
  return (
    `${PLAN_ROW_RETIRED} id=${goal.id} goal=${goalKeyOf(goal)} reason=${proof.reason}` +
    ` evidence=${proof.evidence.join(',')} current=${formatPlanIdentity(current)}`
  )
}

export function formatPlanIdentityChanged(result: PlanIdentityReconciliation): string {  return (
    `${PLAN_IDENTITY_CHANGED} from=${formatPlanIdentity(result.previous)} to=${formatPlanIdentity(result.current)}` +
    ` superseded=${result.superseded} retired=${result.retired.length} kept=${result.kept.length}` +
    ` head_superseded=${result.headSuperseded}`
  )
}

export function formatRowNotExecutableHere(result: NotExecutableHeadResult): string {
  return (
    `${ROW_NOT_EXECUTABLE_HERE} id=${result.goalId ?? 'none'} goal=${result.goalKey}` +
    ` declared=${result.declaredDimension ?? 'none'} live=${result.liveDimension ?? 'unknown'}` +
    ` action=${result.action} reason=${result.reason} defers=${result.defers}/${result.limit}` +
    ` next=${result.nextGoalId ?? 'none'}`
  )
}

export function formatRowDeferredNotExecutableHere(result: NotExecutableHeadResult): string {
  return (
    `${ROW_DEFERRED_NOT_EXECUTABLE_HERE} id=${result.goalId ?? 'none'} goal=${result.goalKey}` +
    ` declared=${result.declaredDimension ?? 'none'} live=${result.liveDimension ?? 'unknown'}` +
    ` defers=${result.defers}/${result.limit} next=${result.nextGoalId ?? 'none'}`
  )
}

/**
 * #plan-reconciliation: the typed System2 re-plan request a superseded durable
 * queue produces. This is the PREFERRED repair (WHAT belongs to System2): the
 * request names the obsolete plan identity, the live objective identity, what was
 * retired and what was kept. The caller supplies the compact state
 * (`System2PlanRequest`: objective, queue head, recent outcomes/events, grounded
 * alternatives, world facts, blocker detail) through its normal summon path.
 *
 * Null when nothing is superseded, so a healthy queue never generates a request.
 */
export function planReplanRequest(result: PlanIdentityReconciliation): { reason: 'no_progress'; detail: string } | null {
  if (result.superseded === 0) return null
  return {
    reason: 'no_progress',
    detail:
      `${PLAN_IDENTITY_CHANGED} from=${formatPlanIdentity(result.previous)} to=${formatPlanIdentity(result.current)}` +
      ` superseded=${result.superseded} retired=${result.retired.length} kept=${result.kept.length}` +
      ` retired_ids=${result.retired.map((entry) => entry.id).join(',') || 'none'}` +
      ` kept_ids=${result.kept.map((entry) => entry.id).join(',') || 'none'}` +
      ` head_superseded=${result.headSuperseded}`,
  }
}

/**
 * #plan-reconciliation: the typed System2 request a head that cannot execute in
 * the live dimension produces when there is no row that can (or its bounded
 * deferral budget is spent). It never chooses the replacement WHAT.
 */
export function notExecutableReplanRequest(
  result: NotExecutableHeadResult,
): { reason: 'action_impossible'; detail: string } | null {
  if (result.action !== 'escalate') return null
  return {
    reason: 'action_impossible',
    detail:
      `row not executable here: goal=${result.goalKey} id=${result.goalId ?? 'none'}` +
      ` declared=${result.declaredDimension ?? 'none'} live=${result.liveDimension ?? 'unknown'}` +
      ` reason=${result.reason} defers=${result.defers}/${result.limit}`,
  }
}

/**
 * #plan-reconciliation: the reason a head row accumulated starved decisions.
 * `window` is the first starved decision of a new window (evidence), `wake` is the
 * bound being reached (escalate to System2, then reset).
 */
export type StarvedHeadAction = 'hold' | 'window' | 'wake'

export type StarvedHeadReason =
  | 'below_window'
  | 'window_open'
  | 'no_productive_candidate_bound'

export interface StarvedHeadBoundDecision {
  action: StarvedHeadAction
  reason: StarvedHeadReason
  count: number
  limit: number
}

/**
 * The bound that ends the measured MOVE/WAIT starvation loop.
 *
 * Pure: the count lives on the durable row (`QueuedGoal.starvedDecisions`), so the
 * only inputs are the count and the bound. `count === 1` opens a new window (one
 * evidence line), `count >= limit` wakes System2 once, and everything between is
 * silent - the decision never chooses WHAT comes next.
 */
export function evaluateStarvedHeadBound(input: { count: number; limit: number }): StarvedHeadBoundDecision {
  const limit = Math.max(1, Math.floor(input.limit))
  const count = Math.max(0, Math.floor(input.count))
  if (count <= 0) return { action: 'hold', reason: 'below_window', count, limit }
  if (count >= limit) return { action: 'wake', reason: 'no_productive_candidate_bound', count, limit }
  if (count === 1) return { action: 'window', reason: 'window_open', count, limit }
  return { action: 'hold', reason: 'below_window', count, limit }
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

/**
 * The compact `kind:target:count` goal key the controller logs.
 *
 * The parameter is widened to the fields the key actually reads, so a caller
 * holding a pre-queue goal (`PlannedGoal`, whose `targetItem`/`requiredCount` are
 * optional) names the same goal with the same vocabulary instead of
 * re-implementing the format.
 */
export function goalKeyOf(
  goal: Pick<QueuedGoal, 'kind' | 'description'> & Partial<Pick<QueuedGoal, 'targetItem' | 'requiredCount'>>,
): string {
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
  /**
   * Runtime causal occurrence witnesses for prerequisite reconciliation.
   * Unlike semantic Option identity, these distinguish accepted plan occurrences
   * and are unioned when one compiled producer is shared by multiple consumers.
   */
  prerequisiteCausalOwnerIds?: string[]
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
  /**
   * #plan-reconciliation: the plan/objective identity that AUTHORED this row.
   * Absent only on rows written before this field existed (they adopt the
   * restored plan identity, so they are never misread as superseded).
   */
  planIdentity?: PlanIdentity
  /**
   * #plan-reconciliation: how many times this row has been deferred because it
   * declares a dimension other than the live one. Persisted with the durable row
   * so a reload cannot reset the bound.
   */
  deferCount?: number
  /**
   * #plan-reconciliation: controller decisions this row held the head and
   * presented NO productive candidate (only WAIT/ESCALATE), with no semantic
   * progress in between. Persisted with the durable row on purpose: the measured
   * live loop (`run-mucqgrdo-21plr`) alternated MOVE/WAIT on one unachievable row
   * across several resident reloads, and a controller-scoped counter was reset by
   * the MOVE ticks AND by every reload - the row stayed permanently stalled while
   * the evidence that it was stalled kept being erased. If the row survives a
   * reload, the evidence that it is unproductive survives with it.
   */
  starvedDecisions?: number
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
  /** Persisted causal occurrence witnesses for exact dependency edges (#467). */
  prerequisiteCausalOwnerIds?: string[]
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
  /**
   * #plan-reconciliation: the plan/objective identity the queue was last
   * authored under. Persisted so a restore can tell a row that belongs to a
   * superseded plan from one the current objective still wants; a legacy
   * snapshot without it falls back to `basis` (its committed frontier), which is
   * the identity those rows were in fact authored under.
   */
  planIdentity?: PlanIdentity
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
  /**
   * #plan-reconciliation: the plan/objective identity new rows are stamped with.
   * Null until the resident installs one (standalone tests / deterministic
   * baselines keep the previous behaviour byte for byte).
   */
  private planIdentity: PlanIdentity | null = null
  /**
   * #plan-reconciliation: the head row retired on the strength of a System2 answer
   * (`replaceAnsweredHead`). It is preserved as durable `impossible` history by the
   * next `applyPlan`, so the ledger keeps naming what the answer replaced.
   */
  private answeredHeadAuditId: string | null = null
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
   * #predicate-retire: code-owned proof that the row's OWN success predicate
   * already holds (installed by the controller, reads live world truth at
   * evaluation time). Absent (unit tests, deterministic baseline) means no
   * predicate retirement at all - the previous behaviour, byte for byte.
   */
  private goalSuccessProbe: ((goal: QueuedGoal) => GoalSuccessEvidence | null) | undefined
  /** Evidence sink for `GOAL_RETIRED_PREDICATE`; defaults to the lifecycle sink. */
  private goalSuccessSink: ((line: string, detail: Record<string, unknown>) => void) | undefined

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

  /**
   * #predicate-retire: the code-owned "does this row's success ALREADY hold in
   * the world?" probe (see `goalSuccess.ts`), plus its evidence sink. The probe
   * is installed by the controller because only the controller owns live world
   * truth; the queue itself stays plain data. Kept as an explicit method (not a
   * plan option) for the same reason as the domination proof above: the
   * retirement runs on every lifecycle transition, not only when a plan arrives.
   */
  setGoalSuccessProbe(
    probe: ((goal: QueuedGoal) => GoalSuccessEvidence | null) | null,
    sink?: ((line: string, detail: Record<string, unknown>) => void) | null,
  ): void {
    this.goalSuccessProbe = probe ?? undefined
    if (sink !== undefined) this.goalSuccessSink = sink ?? undefined
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
        // Keep completed history and the active goal, except for an optional
        // food recovery row that a new semantic route is explicitly replacing.
        // #plan-reconciliation: a head replaced on the strength of System2's own
        // answer is kept as `impossible` audit history, not erased (the same reason
        // `abandon` keeps `abandonedCurrentId`), so a reload cannot resurrect it as
        // fresh work and the ledger still names what the answer replaced.
        this.goals = this.goals.filter(
          (goal) =>
            goal.status === 'done' ||
            goal.id === this.answeredHeadAuditId ||
            (goal.status === 'active' && !isReplaceableOptionalFoodGoal(goal)) ||
            retiredIds.has(goal.id),
        )
      } else {
        this.goals = this.goals.filter(
          (goal) =>
            goal.status === 'done' ||
            goal.id === abandonedCurrentId ||
            goal.id === this.answeredHeadAuditId ||
            retiredIds.has(goal.id),
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
        const existing = this.goals.find(
          (goal) => goalInstanceKey(goal) === key && (goal.status === 'pending' || goal.status === 'active'),
        )
        if (existing !== undefined && plan.prerequisiteCausalOwnerIds !== undefined) {
          existing.prerequisiteCausalOwnerIds = [
            ...new Set([...(existing.prerequisiteCausalOwnerIds ?? []), ...plan.prerequisiteCausalOwnerIds]),
          ].sort()
        }
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
      ...(plan.prerequisiteCausalOwnerIds === undefined
        ? {}
        : { prerequisiteCausalOwnerIds: [...plan.prerequisiteCausalOwnerIds] }),
      ...(plan.placementCells === undefined ? {} : { placementCells: [...plan.placementCells] }),
      ...(plan.targetPosition === undefined
        ? {}
        : { targetPosition: plan.targetPosition === null ? null : { ...plan.targetPosition } }),
      // #plan-reconciliation: the identity that authored this row, so a later
      // objective can tell whether the row still belongs to the live plan.
      ...(this.planIdentity === null ? {} : { planIdentity: { ...this.planIdentity } }),
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
    if (progressKinds.some(isSemanticProgressKind)) {
      goal.nonProgressDecisions = 0
      // Semantic progress also closes the starvation window: a head that is
      // actually advancing must never accumulate the unproductive bound.
      goal.starvedDecisions = 0
    }
    return goal.nonProgressDecisions ?? 0
  }

  /**
   * #plan-reconciliation: record one controller decision on which the head
   * presented NO productive candidate (only WAIT/ESCALATE). The count lives on the
   * durable row, so interleaved body-only decisions (a MOVE offered on the next
   * tick) and a generation reload cannot erase it; only semantic progress
   * (`noteSemanticProgress`), a different head (its own row), an explicit reset, or
   * firing the bound clears it. The queue revision is deliberately NOT bumped: this
   * is diagnostic evidence, and bumping it would invalidate an in-flight System2
   * request (system2Authority compares `queueRevision`).
   */
  noteStarvedHead(): number {
    const goal = this.nextRef()
    if (goal === undefined) return 0
    goal.starvedDecisions = (goal.starvedDecisions ?? 0) + 1
    return goal.starvedDecisions
  }

  /** Close the starvation window for the current head (after the bound fired). */
  resetStarvedHead(): void {
    const goal = this.nextRef()
    if (goal === undefined) return
    goal.starvedDecisions = 0
  }

  /** The head's durable starved-decision count (diagnostics/fixtures). */
  get starvedHeadCount(): number {
    return this.nextRef()?.starvedDecisions ?? 0
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
        goal.detail =
          `retired prerequisite: reason=${decision.reason} dependents=${decision.dependents}` +
          ` causalOwners=[${decision.causalOwnerIds.join(',')}] consumers=[${decision.dependentIds.join(',')}]`
        goal.updatedAt = now
        retired.push(goal)
        sink(formatPrereqRetired(goal, decision))
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
    return {
      counter: this.counter,
      goals: this.goals.map((goal) => ({
        ...goal,
        ...(goal.prerequisiteCausalOwnerIds === undefined
          ? {}
          : { prerequisiteCausalOwnerIds: [...goal.prerequisiteCausalOwnerIds] }),
      })),
      revision: this.queueRevision,
      ...(this.planIdentity === null ? {} : { planIdentity: { ...this.planIdentity } }),
    }
  }

  restore(snapshot: GoalQueueSnapshot): void {
    this.counter = snapshot.counter
    this.goals = snapshot.goals.map((goal) => {
      const copy = {
        ...goal,
        ...(goal.prerequisiteCausalOwnerIds === undefined
          ? {}
          : { prerequisiteCausalOwnerIds: [...goal.prerequisiteCausalOwnerIds] }),
      }
      const spec = copy.optionSpec ?? compilePlannedGoal(queuedToPlanned(copy as QueuedGoal))
      copy.optionSpec = spec
      copy.optionTemplateId = copy.optionTemplateId ?? spec.id
      copy.optionInstanceId = copy.optionInstanceId ?? stableOptionInstanceId(spec)
      return copy
    })
    // #plan-reconciliation: adopt the identity the restored queue was authored
    // under. A legacy snapshot has no identity field, but its committed `basis`
    // is exactly the frontier those rows were authored against, so it is the
    // honest fallback - never "current", which would erase the supersession the
    // reconciliation exists to detect.
    this.planIdentity =
      snapshot.planIdentity !== undefined
        ? { ...snapshot.planIdentity }
        : snapshot.basis === undefined
          ? null
          : {
              rungId: snapshot.basis.frontierRungId,
              rungIndex: snapshot.basis.frontierRungIndex,
              objectiveItem: null,
              objectiveCount: 0,
            }
    if (this.planIdentity !== null) {
      for (const goal of this.goals) {
        if (goal.planIdentity === undefined) goal.planIdentity = { ...this.planIdentity }
      }
    }
    this.queueRevision = Math.max(this.queueRevision + 1, snapshot.revision ?? 0)
    this.activate()
  }

  /** The plan/objective identity the queue is currently authored under. */
  get authoredPlanIdentity(): PlanIdentity | null {
    return this.planIdentity === null ? null : { ...this.planIdentity }
  }

  /**
   * Adopt a plan identity without reconciling (rows keep their own stamp).
   * Returns the identity that was current before the call.
   */
  setPlanIdentity(identity: PlanIdentity): PlanIdentity | null {
    const previous = this.planIdentity
    this.planIdentity = { ...identity }
    return previous
  }

  /**
   * #plan-reconciliation: compare every unfinished row's authoring identity with
   * the live one and retire ONLY the rows a code-owned proof calls obsolete.
   *
   * A superseded row without a proof is kept and reported (`kept`), never
   * retired: "the plan that authored me is gone" alone is not obsolescence -
   * the current objective may still require the same work. Rows with no stamp
   * (legacy) adopt the current identity and are never treated as superseded.
   */
  reconcilePlanIdentity(options: PlanReconciliationOptions): PlanIdentityReconciliation {
    const previous = this.planIdentity
    const current: PlanIdentity = { ...options.current }
    this.planIdentity = current
    const currentId = planIdentityId(current)
    const changed = previous === null || planIdentityId(previous) !== currentId
    const sink = options.onSuperseded ?? this.lifecycleSink
    const now = options.now ?? Date.now()
    const retired: PlanRowRetirement[] = []
    const kept: PlanRowRetirement[] = []
    let adoptedLegacy = 0
    let headSuperseded = false
    const head = this.nextRef()
    for (const goal of this.goals) {
      if (goal.status !== 'pending' && goal.status !== 'active') continue
      if (goal.planIdentity === undefined) {
        goal.planIdentity = { ...current }
        adoptedLegacy += 1
        continue
      }
      const authoredId = planIdentityId(goal.planIdentity)
      if (authoredId === currentId) continue
      const authoredUnder = authoredId
      if (goal === head) headSuperseded = true
      const proof = options.isObsolete?.(goal) ?? null
      if (proof === null) {
        kept.push({
          id: goal.id,
          description: goal.description,
          goalKey: goalKeyOf(goal),
          authoredUnder,
          reason: 'no_code_owned_proof',
          evidence: [],
        })
        continue
      }
      goal.status = 'impossible'
      goal.detail = `retired superseded plan: ${proof.reason}${proof.evidence.length === 0 ? '' : ` (${proof.evidence.join(',')})`}`
      goal.updatedAt = now
      const entry: PlanRowRetirement = {
        id: goal.id,
        description: goal.description,
        goalKey: goalKeyOf(goal),
        authoredUnder,
        reason: proof.reason,
        evidence: [...proof.evidence],
      }
      retired.push(entry)
      sink?.(formatPlanRowRetired(goal, current, proof), {
        id: goal.id,
        goalKey: entry.goalKey,
        authoredUnder,
        reason: proof.reason,
        evidence: entry.evidence,
        current: formatPlanIdentity(current),
      })
    }
    if (retired.length > 0) {
      this.queueRevision += 1
      this.activate()
    }
    return {
      previous,
      current,
      changed,
      superseded: retired.length + kept.length,
      retired,
      kept,
      adoptedLegacy,
      headSuperseded,
    }
  }

  /**
   * #plan-reconciliation: replace the head row that System2 was EXPLICITLY asked
   * about, on the strength of the answer it authored.
   *
   * Measured live (`run-mucqgrdo-21plr`): the starvation bound fired, System2 was
   * summoned with `reason=action_impossible`, the model DID author a Nether/blaze
   * plan (`op=patch`), and the queue head was unchanged - `patch` deliberately keeps
   * the active row - so the row survived the very escalation that was about it and
   * the cycle could repeat forever.
   *
   * Authority: System2 owns WHAT, so its answer to "this head is impossible" is the
   * authoritative statement that the old WHAT is over. Code's job is to apply that
   * boundedly: ONLY the exact row the request was about, only while it is still the
   * head, never human intent, and with typed evidence naming the row and the
   * request. Every other row keeps the conservative rule (`reconcilePlanIdentity`
   * retires only with a code-owned proof).
   */
  replaceAnsweredHead(options: HeadReplacementOptions): QueuedGoal | null {
    const goal = this.nextRef()
    if (goal === undefined) return null
    if (goal.id !== options.headId) return null
    if (goal.origin === 'human') return null
    const now = options.now ?? Date.now()
    goal.status = 'impossible'
    goal.detail =
      `replaced by System2 answer: reason=${options.reason} requestId=${options.requestId}` +
      `${options.note === undefined || options.note.length === 0 ? '' : ` note="${options.note.slice(0, 160)}"`}`
    goal.updatedAt = now
    const clone = { ...goal }
    this.answeredHeadAuditId = goal.id
    this.queueRevision += 1
    ;(options.onReplaced ?? this.lifecycleSink)?.(formatPlanHeadReplaced(goal, options), {
      id: goal.id,
      goalKey: goalKeyOf(goal),
      reason: options.reason,
      requestId: options.requestId,
      note: options.note ?? null,
    })
    this.activate()
    return clone
  }

  /**
   * #plan-reconciliation: the measured cross-dimension starvation.
   *
   * A head row that declares a dimension the body is not in cannot be executed
   * HERE and NOW. That is a feasibility fact, not obsolescence: the row is kept
   * (never marked impossible) and the queue's own plan order is preserved except
   * for a BOUNDED demotion behind the next row that IS executable in the live
   * dimension. With no such row the fact is returned as `escalate` so the
   * controller asks System2 (the WHAT owner) instead of looping.
   */
  reconcileNotExecutableHead(options: NotExecutableHeadOptions): NotExecutableHeadResult {
    const limit = Math.max(0, Math.floor(options.limit ?? resolveNotExecutableDeferLimit()))
    const current = this.nextRef()
    if (current === undefined) {
      return {
        action: 'hold',
        reason: 'no_current',
        goalId: null,
        goalKey: 'none',
        declaredDimension: null,
        liveDimension: options.liveDimension,
        nextGoalId: null,
        defers: 0,
        limit,
      }
    }
    const declared = normalizeGoalDimension(current.dimension)
    const live = normalizeGoalDimension(options.liveDimension)
    const base = {
      goalId: current.id,
      goalKey: goalKeyOf(current),
      declaredDimension: declared,
      liveDimension: live,
      defers: current.deferCount ?? 0,
      limit,
    }
    if (declared === null) return { ...base, action: 'hold', reason: 'unknown_dimension', nextGoalId: null }
    if (live === null) return { ...base, action: 'hold', reason: 'unknown_dimension', nextGoalId: null }
    if (declared === live) return { ...base, action: 'hold', reason: 'executable_here', nextGoalId: null }
    // A TRANSFER row (success = dimension change) declares where it is going, not
    // where it may run. Classifying it here made the entry row permanently
    // not-executable-here and the offer binding then withheld its own climb legs.
    if (isDimensionTransferGoal(current)) {
      return { ...base, action: 'hold', reason: 'dimension_transfer_goal', nextGoalId: null }
    }
    if (base.defers >= limit) {
      return { ...base, action: 'escalate', reason: 'defer_budget_exhausted', nextGoalId: null }
    }
    const alternative = this.goals.find(
      (goal) =>
        goal.id !== current.id &&
        (goal.status === 'pending' || goal.status === 'active') &&
        (normalizeGoalDimension(goal.dimension) === null || normalizeGoalDimension(goal.dimension) === live),
    )
    if (alternative === undefined) {
      return { ...base, action: 'escalate', reason: 'no_executable_alternative', nextGoalId: null }
    }
    current.deferCount = base.defers + 1
    current.status = 'pending'
    current.updatedAt = options.now ?? Date.now()
    const nextGoalId = this.demoteToBack(current)
    this.queueRevision += 1
    return {
      ...base,
      action: 'defer',
      reason: 'deferred',
      defers: base.defers + 1,
      nextGoalId: nextGoalId ?? alternative.id,
    }
  }

  private activate(): void {
    // #predicate-retire: a row whose own success predicate ALREADY holds is
    // finished work (`Code = DONE`), so it retires without executing its action
    // sequence. This runs BEFORE the prerequisite reconciliation so a row that
    // describes an existing world outcome is retired as `done` instead of being
    // mislabelled impossible as an orphan. It cannot add or reorder a goal, and
    // it never replaces one: it only resolves rows whose own postcondition the
    // world already holds.
    this.retireSatisfiedGoals()
    this.reconcilePrerequisites()
    const goal = this.nextRef()
    if (goal !== undefined) goal.status = 'active'
  }

  /**
   * #predicate-retire: the ADDITIONAL, code-owned retirement path. On every
   * lifecycle transition (restore, plan apply, progress/completion, yield) an
   * unfinished row is asked one question - "does the postcondition you exist to
   * produce already hold in the world?" - and is marked `done` when the answer is
   * provably yes. Every world-outcome row drains in the same transition (the
   * measured shape: `place obsidian` + `place nether_portal` restored in front of
   * an already built, lit and verified gate), and the prerequisite reconciliation
   * below then retires whatever consumers no longer need.
   *
   * A stale INVENTORY prerequisite (a `collect obsidian` row whose count
   * genuinely does not hold) is deliberately NOT touched here: "is this
   * prerequisite still wanted?" is the prerequisite-orphan question
   * (`retireOrphanedPrerequisites`), not a success predicate.
   *
   * Cost/rhythm: this is transition-driven, never per-tick, and each row is
   * probed at most once per transition (one block read per cell at most).
   *
   * Truth rules: only the probe's explicit `satisfied` verdict retires a row.
   * `unsatisfied` and `unknown` leave the row exactly as it was, so every
   * existing completion path (the `markDone()` sites and the per-tick spatial
   * predicate) keeps working unchanged. A probe that throws is a bug, not a
   * verdict: it is reported and the row is left alone.
   *
   * Returns the rows retired by this transition (diagnostics/tests).
   */
  private retireSatisfiedGoals(now: number = Date.now()): QueuedGoal[] {
    const probe = this.goalSuccessProbe
    if (probe === undefined) return []
    // The retirement is evidence-bearing work: it always reaches a sink. The
    // controller's mirrored sink wins; otherwise the plan audit sink; otherwise
    // the module default (stderr), exactly like `PREREQ_RETIRED`.
    const emit = (line: string, detail: Record<string, unknown>): void => {
      if (this.goalSuccessSink !== undefined) {
        this.goalSuccessSink(line, detail)
        return
      }
      const fallback = this.lifecycleSink ?? prereqAuditSink
      fallback(line)
    }
    const retired: QueuedGoal[] = []
    // Every UNFINISHED row is asked once per lifecycle transition, not only the
    // head: the measured restore put a non-predicate row first
    // (`g4:collect:obsidian` active, then `g5:place:obsidian`,
    // `g6:place:nether_portal`), and a head-only check would never reach the
    // rows whose outcome already exists. Rows whose predicate cannot be
    // evaluated are simply skipped; the prerequisite reconciliation below then
    // retires whatever their consumers no longer need.
    const unfinished = this.goals.filter((goal) => goal.status === 'pending' || goal.status === 'active')
    for (const goal of unfinished) {
      let evidence: GoalSuccessEvidence | null
      try {
        evidence = probe(goal)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        emit(formatGoalSuccessProbeError(goal.id, message), { id: goal.id, error: message })
        continue
      }
      if (evidence === null || evidence.status !== 'satisfied') continue
      goal.status = 'done'
      goal.haveCount = Math.max(goal.haveCount, goal.requiredCount)
      goal.detail = `retired: success predicate '${evidence.predicate}' already holds (${evidence.detail})`
      goal.updatedAt = now
      retired.push(goal)
      emit(formatGoalSuccessRetirement(goal, evidence), {
        id: goal.id,
        kind: goal.kind,
        targetItem: goal.targetItem,
        predicate: evidence.predicate,
        source: evidence.source,
        detail: evidence.detail,
      })
    }
    if (retired.length > 0) this.queueRevision += 1
    return retired
  }
}
