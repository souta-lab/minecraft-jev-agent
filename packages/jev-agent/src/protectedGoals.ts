// protectedGoals.ts - Issue #55: prerequisite/core goals are marked in the plan
// representation and enforced in code, so a Mercury/Jev `patch`/`replace` cannot
// silently drop required work.
//
// Design (matches AGENTS.md section 8 "safety / success / world truth ->
// deterministic code"): protection is a property carried on the goal, not a
// natural-language instruction to the planner. The deterministic Option
// dependency compiler (furnace prerequisite) and the ladder (core rung goal)
// mark their goals; the queue enforces the mark on every replan.
//
// Enforcement contract:
//   patch/replace + protected goal absent from the replacement
//     -> the protected goal is re-inserted (front of the new tail) and
//        `PROTECTED_GOAL_REINSERTED goal=<g> op=<op> reason=<r>` is emitted.
//   patch/replace with an EMPTY goal list while protected work remains
//     -> the whole op is rejected (queue unchanged) and
//        `PROTECTED_GOAL_DROPPED_REJECTED goal=<g> op=<op> reason=<r>` is emitted.
//   abort (explicit impossible)
//     -> removal is allowed, but each protected goal gets one structured
//        `ABANDON_REASON option=<g> reason=<r> protected=true` line and a
//        non-generic detail.
//
// `patch`/`replace` that supplies an equivalent producer (same identity
// kind|item|y|dimension) counts as satisfying the protected goal: the old copy
// may be replaced and the new copy takes over. This is issue #55's
// "equivalent dependency producer" acceptance.
// A code-owned world fact may also retire a protected prerequisite, but only
// through the explicit queue callback; that transition emits
// `PROTECTED_GOAL_RETIRED` with its exact fact-based reason.

export const PROTECTED_GOAL_REINSERTED = 'PROTECTED_GOAL_REINSERTED'
export const PROTECTED_GOAL_DROPPED_REJECTED = 'PROTECTED_GOAL_DROPPED_REJECTED'
export const PROTECTED_GOAL_RETIRED = 'PROTECTED_GOAL_RETIRED'
export const ABANDON_REASON = 'ABANDON_REASON'

/** The subset of a goal the protection logic reads (PlannedGoal or QueuedGoal). */
export interface ProtectableGoal {
  id?: string
  kind: string
  description?: string
  targetItem?: string | null
  targetY?: number | null
  dimension?: string | null
  status?: string
  protected?: boolean
  core?: boolean
  optionInstanceId?: string | null
  optionTemplateId?: string | null
  semanticOptionInstanceId?: string | null
  semanticOptionTemplateId?: string | null
}

/** A goal is protected when the deterministic compiler marked it protected or core. */
export function isProtectedGoal(goal: ProtectableGoal): boolean {
  // Food is an optional, self-contained recovery goal. Older resident snapshots
  // may still carry `core=true` from the rung compiler; preserve explicit
  // prerequisites, but let a proven no-frontier replan retire this stale row.
  if (goal.protected === true) return true
  if (isReplaceableOptionalFoodGoal(goal)) return false
  return goal.core === true
}
 
/** Optional survival rows may be replaced when a patch changes the recovery route. */
export function isReplaceableOptionalFoodGoal(goal: ProtectableGoal): boolean {
  return goal.protected !== true && goal.kind === 'collect' && goal.targetItem === 'food'
}

/**
 * A restored recovery head is not a durable mission commitment.
 *
 * The phase ledger can outlive the state that justified a recovery plan. The
 * measured p27 shape restored `explore:surface` authored for health=12/food=5
 * after the live frontier had become iron_pickaxe with four ingots already
 * held. Treat only the explicitly-typed surface recovery and food row as
 * replaceable; ordinary restored work keeps the bootstrap-preserve contract.
 */
export function isReplaceableRecoveryGoal(goal: ProtectableGoal): boolean {
  if (isReplaceableOptionalFoodGoal(goal)) return true
  if (goal.protected === true || goal.core === true || goal.kind !== 'explore') return false
  const ids = [
    goal.semanticOptionInstanceId,
    goal.semanticOptionTemplateId,
    goal.optionInstanceId,
    goal.optionTemplateId,
  ]
  return ids.some((id) => id === 'explore:surface' || id?.startsWith('explore:surface#') === true)
}

/**
 * Identity of the work a goal represents, used to recognise an equivalent
 * replacement producer. `requiredCount` is deliberately excluded: a replan may
 * change the count of the same producing goal without losing the dependency
 * edge (e.g. collect 4 vs 8 cobblestone still feeds the same furnace craft).
 */
export function goalIdentity(goal: ProtectableGoal): string {
  const item = goal.targetItem ?? ''
  const y = goal.targetY ?? ''
  const dim = goal.dimension ?? ''
  return `${goal.kind}|${item}|${y}|${dim}`
}

export interface ProtectionPartition {
  /** protected goals the incoming plan already covers by identity (equivalent producer) */
  covered: ProtectableGoal[]
  /** protected goals the incoming plan would drop */
  dropped: ProtectableGoal[]
}

/** Split the unfinished protected goals into those the incoming plan covers and those it drops. */
export function splitProtectedGoals(
  unfinished: readonly ProtectableGoal[],
  incoming: readonly ProtectableGoal[],
): ProtectionPartition {
  const incomingIdentities = new Set(incoming.map(goalIdentity))
  const covered: ProtectableGoal[] = []
  const dropped: ProtectableGoal[] = []
  for (const goal of unfinished) {
    if (!isProtectedGoal(goal)) continue
    if (incomingIdentities.has(goalIdentity(goal))) covered.push(goal)
    else dropped.push(goal)
  }
  return { covered, dropped }
}

/** Stable label for the audit line: the assigned queue id when present. */
export function goalLabel(goal: ProtectableGoal): string {
  if (typeof goal.id === 'string' && goal.id.length > 0) return goal.id
  if (typeof goal.description === 'string' && goal.description.length > 0) return goal.description
  return `${goal.kind}:${goal.targetItem ?? 'unknown'}`
}

export function formatProtectedGoalReinserted(goal: ProtectableGoal, op: string, reason: string): string {
  return `${PROTECTED_GOAL_REINSERTED} goal=${goalLabel(goal)} op=${op} reason=${reason}`
}

export function formatProtectedGoalDroppedRejected(goal: ProtectableGoal, op: string, reason: string): string {
  return `${PROTECTED_GOAL_DROPPED_REJECTED} goal=${goalLabel(goal)} op=${op} reason=${reason}`
}

/** A code-owned world fact made a protected prerequisite obsolete. */
export function formatProtectedGoalRetired(goal: ProtectableGoal, reason: string): string {
  return `${PROTECTED_GOAL_RETIRED} goal=${goalLabel(goal)} reason=${reason}`
}

export function formatProtectedGoalAbandoned(goal: ProtectableGoal, reason: string): string {
  return `${ABANDON_REASON} option=${goalLabel(goal)} reason=${reason} protected=true`
}

/** `aborted by replan` is no longer the only evidence: the caller's reason is carried through. */
export function abandonDetail(reason: string | undefined, protectedGoal: boolean): string {
  const base = reason !== undefined && reason.length > 0 ? `aborted by replan: ${reason}` : 'aborted by replan'
  return protectedGoal ? `${base} (protected)` : base
}
