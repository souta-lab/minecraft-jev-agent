// replanThrottle.ts - issue #44: bound the exception-driven replan rate.
//
// The #43 WAIT bound replaced an infinite WAIT loop with a replan loop: every
// WAIT_LIMIT woke System 2, which re-emitted the SAME blocked plan, which WAITed
// again, until the wedge counter restarted the generation (measured 27
// GENERATION_START / 5 min). The bug is not the bound, it is that a replan was
// allowed with no new information and produced no body change.
//
// This module is the deterministic, pure rule set:
//
//   1. THROTTLE   - at most one replan per `reason` per window (default 10 s);
//                   a same-reason call inside the window is refused and the
//                   caller reuses the current plan (`REPLAN_THROTTLED`).
//   2. NEW INFO   - even after the window, a replan needs a changed input:
//                   inventory delta, position delta beyond a threshold, a new
//                   known resource, or a different failure signature.
//   3. BODY DELTA - a replacement plan must contain at least one `collect` /
//                   `explore` goal that changes the resource source versus the
//                   blocked goal; otherwise the caller rejects it
//                   (`REPLAN_REJECTED no_body_delta`) and keeps the plan.
//   4. ESCALATE   - issue #78: a run of `no_new_info` refusals for the SAME
//                   (reason, goal, stateHash) means the local recovery itself
//                   is making no progress. On the Nth consecutive cycle the
//                   throttle releases the replan (`kind=exhausted`) so the
//                   caller wakes System 2 with `LOCAL_RECOVERY_EXHAUSTED`.
//                   Without this the WAIT-only stall could never produce a
//                   fingerprint change and was held open indefinitely.
//   5. ACTION FAIL - a DIFFERENT loop the counters above cannot see: the same
//                   plan re-offered with its action failing the SAME typed way
//                   (`path_stuck`, `path_no_path`, ...). Those are held
//                   `local_recovery`, so no replan is attempted and no throttle
//                   counter advances. `ActionFailureEscalation` bounds it by
//                   `(plan, actionId, failureReason)` and wakes System2 on the
//                   Nth via `ACTION_FAILURE_EXHAUSTED`.
//
// No imports from the controller, no bot, no clock: `now` is injected, so the
// whole policy is unit-testable.
import { createHash } from 'node:crypto'

export const REPLAN_THROTTLE_WINDOW_MS_DEFAULT = 10_000
export const REPLAN_POSITION_DELTA_DEFAULT = 2

/**
 * Issue #78 stall escalation: how many CONSECUTIVE zero-progress
 * (`no_new_info`) throttled replan cycles for the SAME (reason, goal,
 * stateHash) fingerprint the deterministic layer tolerates before it stops
 * treating the suppression as a provable "nothing changed" and wakes System 2
 * with `LOCAL_RECOVERY_EXHAUSTED`.
 *
 * The #44 throttle suppresses a replan while the fingerprint is unchanged,
 * which is correct for mere churn. It is NOT correct when the suppressed
 * replan IS the local recovery: with only WAIT actions the fingerprint can
 * never change, so the suppression held the stall open for as long as the
 * resident lived (live: ~5 min of WAIT actions, issue #78). N bounds that
 * loop. Real progress, a changed fingerprint, or any allowed replan resets the
 * counter, so a stall that IS advancing never fires the escalation.
 */
export const REPLAN_NO_INFO_ESCALATE_CYCLES_DEFAULT = 6

/**
 * Bounded escalation for a typed ACTION failure (issue #78 follow-up).
 *
 * The #44/#78 counters above bound the *replan* rate: they only advance when a
 * replan is suppressed. They cannot see the distinct live loop where the SAME
 * plan is re-offered and its action fails with the SAME typed error
 * (`path_stuck`, `path_no_path`, ...) inside the executor. Local route failures
 * are deliberately held `local_recovery` and excluded from `same_failure_3x`,
 * so nothing advances: live run `run-muaxgdyk-15kc9` re-ran
 * `SMELT:iron_ingot reason=stuck attempts=81` with
 * `grep -c LOCAL_RECOVERY_NO_PROGRESS = 0`.
 *
 * This counter is DISTINCT from `REPLAN_NO_INFO_ESCALATE_CYCLES_DEFAULT`: it
 * counts consecutive identical `(plan, actionId, failureReason)` action
 * failures, not throttled replans. On the Nth the local recovery is exhausted
 * and System2 is woken (`ACTION_FAILURE_EXHAUSTED`). It mirrors the #78
 * default so there is one bounded-escalation shape; `BUDDY_ACTION_FAILURE_ESCALATE_CYCLES`
 * overrides it.
 */
export const ACTION_FAILURE_ESCALATE_CYCLES_DEFAULT = 6

/** `BUDDY_ACTION_FAILURE_ESCALATE_CYCLES` overrides N; invalid values fall back. */
export function resolveActionFailureEscalateCycles(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = Number(env.BUDDY_ACTION_FAILURE_ESCALATE_CYCLES ?? ACTION_FAILURE_ESCALATE_CYCLES_DEFAULT)
  return Number.isInteger(raw) && raw >= 1 ? raw : ACTION_FAILURE_ESCALATE_CYCLES_DEFAULT
}

/** `BUDDY_REPLAN_THROTTLE_MS` overrides the window; invalid values fall back. */
export function resolveReplanThrottleMs(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const raw = Number(env.BUDDY_REPLAN_THROTTLE_MS ?? REPLAN_THROTTLE_WINDOW_MS_DEFAULT)
  return Number.isFinite(raw) && raw >= 0 ? raw : REPLAN_THROTTLE_WINDOW_MS_DEFAULT
}

/** `BUDDY_REPLAN_NO_INFO_ESCALATE_CYCLES` overrides N; invalid values fall back. */
export function resolveReplanNoInfoEscalateCycles(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = Number(env.BUDDY_REPLAN_NO_INFO_ESCALATE_CYCLES ?? REPLAN_NO_INFO_ESCALATE_CYCLES_DEFAULT)
  return Number.isInteger(raw) && raw >= 1 ? raw : REPLAN_NO_INFO_ESCALATE_CYCLES_DEFAULT
}

/** `BUDDY_REPLAN_POSITION_DELTA` overrides the block threshold; invalid values fall back. */
export function resolveReplanPositionDelta(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const raw = Number(env.BUDDY_REPLAN_POSITION_DELTA ?? REPLAN_POSITION_DELTA_DEFAULT)
  return Number.isFinite(raw) && raw >= 0 ? raw : REPLAN_POSITION_DELTA_DEFAULT
}

export interface ReplanPosition {
  x: number
  y: number
  z: number
}

/** The inputs a replan claims changed. Everything here is cheap and already live. */
export interface ReplanInputs {
  inventory: Record<string, number>
  position: ReplanPosition | null
  knownResources: number
  failureSignature: string
  /**
   * M2 capability trap: a signature while the pure `evaluateCapabilityGap`
   * predicate proves the agent cannot ascend to its remembered target, else
   * null. A capability gap is information the throttle must not swallow.
   */
  capabilityGap: string | null
  /**
   * Current durable goal key (`kind:target:count`). A different goal is new
   * information for a WHAT replan, so it is part of the fingerprint and owns a
   * separate no-progress streak (issue #78). Optional so pre-#78 fixtures and
   * callers that only have world inputs keep their old hashes.
   */
  goalKey?: string | null
  /**
   * Issue #78 follow-up: the `plan|action|reason` fingerprint of a typed
   * action-failure streak that has JUST reached its bound, else null. N
   * identical typed failures are deterministic proof that the local recovery is
   * exhausted, so the bound is genuine new information for the replan gate: the
   * controller surfaces it here so `tryReplan` releases the escalation wake
   * instead of suppressing it as `no_new_info`. It is null at every count below
   * N, so ordinary repeated failures still cannot churn a replan per tick.
   */
  actionFailureExhausted?: string | null
  /**
   * Issue #327 follow-up: the `wait|goal|count` fingerprint of an actionable
   * WAIT streak that has JUST reached its bound, else null. A model that keeps
   * choosing the no-op WAIT while real candidates are offered is itself a
   * zero-progress loop; the controller surfaces the exhaustion here so the
   * replan gate releases the wake instead of suppressing it as `no_new_info`.
   */
  waitStreakExhausted?: string | null
}

/** Canonical, order-independent inventory signature (counts > 0 only). */
export function inventorySignature(inventory: Record<string, number>): string {
  return Object.entries(inventory)
    .filter(([, count]) => count > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, count]) => `${name}=${count}`)
    .join(',')
}

/** Stable stateHash for a (reason, inputs) throttle key. */
export function hashReplanInputs(inputs: ReplanInputs): string {
  const payload = {
    inventory: inventorySignature(inputs.inventory),
    position:
      inputs.position === null
        ? null
        : `${Math.round(inputs.position.x)},${Math.round(inputs.position.y)},${Math.round(inputs.position.z)}`,
    knownResources: inputs.knownResources,
    failures: inputs.failureSignature,
    capabilityGap: inputs.capabilityGap,
    goal: inputs.goalKey ?? null,
    actionFailureExhausted: inputs.actionFailureExhausted ?? null,
    waitStreakExhausted: inputs.waitStreakExhausted ?? null,
  }
  return createHash('sha1').update(JSON.stringify(payload)).digest('hex').slice(0, 16)
}

function movedBeyond(a: ReplanPosition | null, b: ReplanPosition | null, threshold: number): boolean {
  if (a === null || b === null) return a !== b
  const dx = a.x - b.x
  const dy = a.y - b.y
  const dz = a.z - b.z
  return Math.sqrt(dx * dx + dy * dy + dz * dz) > threshold
}

/** True when any input that could justify a different plan changed. */
export function replanInputsChanged(
  previous: ReplanInputs,
  current: ReplanInputs,
  positionDelta = REPLAN_POSITION_DELTA_DEFAULT,
): boolean {
  if (current.capabilityGap !== null) return true
  if (previous.capabilityGap !== current.capabilityGap) return true
  if ((previous.goalKey ?? null) !== (current.goalKey ?? null)) return true
  if ((previous.actionFailureExhausted ?? null) !== (current.actionFailureExhausted ?? null)) return true
  if ((previous.waitStreakExhausted ?? null) !== (current.waitStreakExhausted ?? null)) return true
  if (inventorySignature(previous.inventory) !== inventorySignature(current.inventory)) return true
  if (previous.knownResources !== current.knownResources) return true
  if (previous.failureSignature !== current.failureSignature) return true
  return movedBeyond(previous.position, current.position, positionDelta)
}

export type ReplanThrottleKind = 'fresh' | 'new_info' | 'window' | 'no_new_info' | 'exhausted'

export interface ReplanThrottleDecision {
  allow: boolean
  kind: ReplanThrottleKind
  ageMs: number
  stateHash: string
  /**
   * Consecutive `no_new_info` refusals observed for this (reason, goal,
   * stateHash) fingerprint, including the current cycle. 0 when the decision
   * is not a zero-progress refusal.
   */
  noInfoStreak: number
  /** The bounded N (`REPLAN_NO_INFO_ESCALATE_CYCLES_DEFAULT`) this streak is measured against. */
  noInfoLimit: number
}

interface ThrottleRecord {
  at: number
  inputs: ReplanInputs
  stateHash: string
}

/** The zero-progress streak: same reason + goal + fingerprint, consecutive refusals. */
interface NoInfoStreak {
  reason: string
  goalKey: string | null
  stateHash: string
  count: number
}

function cloneInputs(inputs: ReplanInputs): ReplanInputs {
  return {
    inventory: { ...inputs.inventory },
    position: inputs.position === null ? null : { ...inputs.position },
    knownResources: inputs.knownResources,
    failureSignature: inputs.failureSignature,
    capabilityGap: inputs.capabilityGap,
    goalKey: inputs.goalKey ?? null,
    actionFailureExhausted: inputs.actionFailureExhausted ?? null,
    waitStreakExhausted: inputs.waitStreakExhausted ?? null,
  }
}

/** The exact log line the controller emits so log evidence and tests agree. */
export function formatReplanThrottled(reason: string, decision: ReplanThrottleDecision): string {
  return `REPLAN_THROTTLED reason=${reason} ageMs=${decision.ageMs} -> reuse plan`
}

export const LOCAL_RECOVERY_NO_PROGRESS_MARKER = 'LOCAL_RECOVERY_NO_PROGRESS'
export const LOCAL_RECOVERY_EXHAUSTED_MARKER = 'LOCAL_RECOVERY_EXHAUSTED'

/**
 * Counter marker: a replan for this fingerprint was throttled as
 * `no_new_info` for the `noInfoStreak`-th consecutive cycle. Greppable proof
 * that the local recovery is itself making no progress.
 */
export function formatLocalRecoveryNoProgress(
  goalKey: string,
  reason: string,
  decision: ReplanThrottleDecision,
): string {
  return `${LOCAL_RECOVERY_NO_PROGRESS_MARKER} count=${decision.noInfoStreak}/${decision.noInfoLimit} goal=${goalKey} reason=${reason} stateHash=${decision.stateHash}`
}

/**
 * Escalation marker: N consecutive zero-progress cycles exhausted the local
 * recovery, so the throttle released the replan and System 2 is woken with an
 * explicit semantic-boundary reason instead of being held behind `no_new_info`.
 */
export function formatLocalRecoveryExhausted(
  goalKey: string,
  reason: string,
  decision: ReplanThrottleDecision,
): string {
  return `${LOCAL_RECOVERY_EXHAUSTED_MARKER} count=${decision.noInfoStreak}/${decision.noInfoLimit} goal=${goalKey} reason=${reason} stateHash=${decision.stateHash} -> wake System2`
}

export const ACTION_FAILURE_REPEAT_MARKER = 'ACTION_FAILURE_REPEAT'
export const ACTION_FAILURE_EXHAUSTED_MARKER = 'ACTION_FAILURE_EXHAUSTED'

/** Stable `plan|action|reason` identity of one typed action-failure streak. */
export function actionFailureKey(planKey: string | null, actionId: string, reason: string): string {
  return `${planKey ?? 'unknown'}|${actionId}|${reason}`
}

export interface ActionFailureEscalationDecision {
  /** true on exactly the Nth consecutive identical typed failure */
  escalate: boolean
  /** consecutive identical typed failures including the current one */
  count: number
  /** the bounded N this streak is measured against */
  limit: number
  planKey: string | null
  actionId: string
  reason: string
}

/**
 * Counter marker: the `count`-th consecutive identical typed action failure for
 * this `(plan, actionId, reason)`. Greppable proof that the same failing action
 * is being re-offered, which the #44/#78 replan counters cannot see.
 */
export function formatActionFailureRepeat(decision: ActionFailureEscalationDecision): string {
  return `${ACTION_FAILURE_REPEAT_MARKER} count=${decision.count}/${decision.limit} plan=${decision.planKey ?? 'unknown'} action=${decision.actionId} reason=${decision.reason}`
}

/**
 * Escalation marker: N consecutive identical typed action failures exhausted the
 * local recovery, so System2 is woken with an explicit semantic-boundary reason
 * instead of the plan being re-offered unchanged.
 */
export function formatActionFailureExhausted(decision: ActionFailureEscalationDecision): string {
  return `${ACTION_FAILURE_EXHAUSTED_MARKER} count=${decision.count}/${decision.limit} plan=${decision.planKey ?? 'unknown'} action=${decision.actionId} reason=${decision.reason} -> wake System2`
}

interface ActionFailureStreak {
  planKey: string | null
  actionId: string
  reason: string
  count: number
}

/**
 * Bounded, pure counter for typed ACTION failures. Distinct from the #44/#78
 * `ReplanThrottle.noInfo` streak: that one counts suppressed replans, this one
 * counts the same action failing the same way inside the executor.
 *
 * Semantics:
 *   - consecutive identical `(planKey, actionId, reason)` failures accumulate;
 *   - ANY change of plan/action/reason restarts the streak at 1;
 *   - the caller resets it on observed progress and after escalation fires, so
 *     the bound cannot hot-loop;
 *   - on exactly the Nth failure `escalate=true` and the streak is cleared, so
 *     the next escalation needs N fresh failures;
 *   - `pendingEscalation()` holds that Nth decision until the caller resets, so
 *     the controller can surface it as new information to the replan gate.
 */
export class ActionFailureEscalation {
  private readonly limit: number
  private streak: ActionFailureStreak | null = null
  private exhausted: ActionFailureEscalationDecision | null = null

  constructor(limit: number = ACTION_FAILURE_ESCALATE_CYCLES_DEFAULT) {
    this.limit = Number.isInteger(limit) && limit >= 1 ? limit : ACTION_FAILURE_ESCALATE_CYCLES_DEFAULT
  }

  /** Record one typed action failure and return the bounded decision. */
  noteFailure(planKey: string | null, actionId: string, reason: string): ActionFailureEscalationDecision {
    const previous = this.streak
    const same =
      previous !== null &&
      previous.planKey === planKey &&
      previous.actionId === actionId &&
      previous.reason === reason
    const count = same ? previous.count + 1 : 1
    const decision: ActionFailureEscalationDecision = {
      escalate: count >= this.limit,
      count,
      limit: this.limit,
      planKey,
      actionId,
      reason,
    }
    this.streak = decision.escalate ? null : { planKey, actionId, reason, count }
    this.exhausted = decision.escalate ? decision : null
    return decision
  }

  /** The escalation awaiting handling, or null. Non-mutating. */
  pendingEscalation(): ActionFailureEscalationDecision | null {
    return this.exhausted
  }

  /** The `plan|action|reason` fingerprint of the pending escalation, or null. */
  pendingKey(): string | null {
    const pending = this.exhausted
    return pending === null ? null : actionFailureKey(pending.planKey, pending.actionId, pending.reason)
  }

  /** Consecutive identical failures recorded so far (0 when none). */
  count(): number {
    return this.streak?.count ?? 0
  }

  /** Reset on observed progress, a handled escalation, or a world-state change. */
  reset(): void {
    this.streak = null
    this.exhausted = null
  }
}

/**
 * Bounded escalation for an actionable WAIT streak (#327 follow-up).
 *
 * Measured live on `449cedd` (m3-live, planId=g3:collect:flint):
 *
 *   ACTION n=640..645 id=WAIT kind=WAIT phase=waiting
 *   JEV_HEADS action=WAIT abandon=0.37 decision=continue
 *   LOCAL_RECOVERY_NO_PROGRESS=0  LOCAL_RECOVERY_EXHAUSTED=0
 *   ACTION_FAILURE_REPEAT=0       ACTION_FAILURE_EXHAUSTED=0
 *   CANDIDATE_SET_DEGENERATE=0    (actionable >= 2: real candidates WERE offered)
 *
 * Real actionable candidates were offered and the policy itself chose the no-op
 * WAIT on every decision. The existing counters cannot see that loop:
 *   - the #44/#78 replan counters only advance on a SUPPRESSED replan;
 *   - `ActionFailureEscalation` only advances on a typed ACTION failure;
 *   - the #43 WAIT wedge requires an UNCHANGED state fingerprint, but the live
 *     body keeps collecting junk (dirt / leaf_litter / cobblestone), so the
 *     fingerprint changes every tick and `evaluateWedgeRepeat` suppresses the
 *     count as `fingerprint_changed` forever.
 *
 * This counter bounds the no-op selection itself, keyed only on the plan/goal:
 * it counts CONSECUTIVE chosen WAIT decisions while at least one actionable
 * (non-WAIT/non-ESCALATE) candidate was offered. It is NOT a preference between
 * the real candidates - it never says which action should win - it only bounds
 * the selection of the do-nothing action. On the Nth the local recovery is
 * exhausted and System2 is woken (`WAIT_EXHAUSTED`), mirroring #326/#337.
 *
 * Reset (so it cannot hot-loop):
 *   - any chosen non-WAIT action resets the streak;
 *   - actionable === 0 (WAIT is the only option) is not a streak at all;
 *   - a different goal/plan resets the streak;
 *   - the streak is cleared on the Nth decision, so the next escalation needs N
 *     fresh WAITs, and `escalate()`/`summonLlm` cooldowns bound the wake rate.
 */
export const WAIT_STREAK_ESCALATE_CYCLES_DEFAULT = 6

/** `BUDDY_WAIT_STREAK_ESCALATE_CYCLES` overrides N; invalid values fall back. */
export function resolveWaitStreakEscalateCycles(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = Number(env.BUDDY_WAIT_STREAK_ESCALATE_CYCLES ?? WAIT_STREAK_ESCALATE_CYCLES_DEFAULT)
  return Number.isInteger(raw) && raw >= 1 ? raw : WAIT_STREAK_ESCALATE_CYCLES_DEFAULT
}

export const WAIT_STREAK_MARKER = 'WAIT_STREAK'
export const WAIT_EXHAUSTED_MARKER = 'WAIT_EXHAUSTED'

export interface WaitStreakDecision {
  /** true on exactly the Nth consecutive actionable WAIT decision */
  escalate: boolean
  /** consecutive actionable WAIT decisions including the current one */
  count: number
  /** the bounded N this streak is measured against */
  limit: number
  goalKey: string
  /** actionable (non-WAIT/non-ESCALATE) candidates offered for this decision */
  actionable: number
}

/** Counter marker: the `count`-th consecutive chosen WAIT with real alternatives. */
export function formatWaitStreak(decision: WaitStreakDecision): string {
  return `${WAIT_STREAK_MARKER} count=${decision.count}/${decision.limit} goal=${decision.goalKey} actionable=${decision.actionable}`
}

/** Escalation marker: N actionable WAITs exhausted the local recovery. */
export function formatWaitExhausted(decision: WaitStreakDecision): string {
  return `${WAIT_EXHAUSTED_MARKER} count=${decision.count}/${decision.limit} goal=${decision.goalKey} -> wake System2`
}

interface WaitStreak {
  goalKey: string
  count: number
}

/**
 * Bounded, pure counter for a chosen no-op WAIT while real actions exist.
 * See the block comment above for the reset conditions and the authority
 * boundary (it bounds the no-op; it never ranks the real candidates).
 */
export class WaitStreakEscalation {
  private readonly limit: number
  private streak: WaitStreak | null = null
  private exhausted: WaitStreakDecision | null = null

  constructor(limit: number = WAIT_STREAK_ESCALATE_CYCLES_DEFAULT) {
    this.limit = Number.isInteger(limit) && limit >= 1 ? limit : WAIT_STREAK_ESCALATE_CYCLES_DEFAULT
  }

  /**
   * Record one chosen action. Only `WAIT` chosen while `actionable > 0` extends
   * the streak; every other choice, an empty actionable set, or a different
   * goal clears it.
   */
  noteChoice(chosenId: string, actionable: number, goalKey: string): WaitStreakDecision {
    const degenerate = chosenId === 'WAIT' && actionable > 0
    if (!degenerate) {
      this.streak = null
      this.exhausted = null
      return { escalate: false, count: 0, limit: this.limit, goalKey, actionable }
    }
    const same = this.streak !== null && this.streak.goalKey === goalKey
    const count = same ? (this.streak?.count ?? 0) + 1 : 1
    const decision: WaitStreakDecision = {
      escalate: count >= this.limit,
      count,
      limit: this.limit,
      goalKey,
      actionable,
    }
    this.streak = decision.escalate ? null : { goalKey, count }
    this.exhausted = decision.escalate ? decision : null
    return decision
  }

  /** The escalation awaiting handling, or null. Non-mutating. */
  pendingExhaustion(): WaitStreakDecision | null {
    return this.exhausted
  }

  /** Stable fingerprint of the pending escalation, or null. */
  pendingKey(): string | null {
    const pending = this.exhausted
    return pending === null ? null : `wait|${pending.goalKey}|${pending.count}`
  }

  /** Consecutive actionable WAITs recorded so far (0 when none). */
  count(): number {
    return this.streak?.count ?? 0
  }

  /** Reset on progress, a plan/goal change, or after the escalation is handled. */
  reset(): void {
    this.streak = null
    this.exhausted = null
  }
}

/**
 * Bounded beta-abandon deferral (live defect, source `d428d1c`, m3-live).
 *
 * Measured freeze, `planId=g3:collect:flint`:
 *
 *   BETA_DEFERRED optionId=front_nether_portal planId=g3:collect:flint beta=0.52
 *                 reason=control_action action=WAIT
 *   BETA_SHADOW   optionId=front_nether_portal beta=0.52 threshold=0.5
 *                 would=abandon actual=continue agree=false mode=authority
 *   JEV_HEADS     action=WAIT abandon=0.53 decision=continue abandonRequested=true
 *                 betaAuthority=true betaShadowed=false abandonEnforced=false
 *                 abandonSuppressed=true attempts=74
 *   ACTION        n=746..748 id=WAIT kind=WAIT phase=waiting
 *
 * With `betaAuthority=true`, beta crossed its abandon threshold and requested the
 * abandon, but `evaluateBetaTerminationBoundary` refuses to cross the lifecycle
 * boundary while `decisionActionId` is a control action (WAIT/ESCALATE), because
 * a control tick is not semantic abandonment. That rule is correct for ONE
 * decision: do not yank a running action. It is circular when the plan is
 * starved (presented=1, actionable=0) and the only action a stuck plan can emit
 * is WAIT — WAIT suppresses the abandon, and suppressing the abandon keeps WAIT.
 * The `#343` WAIT_STREAK/WAIT_EXHAUSTED counters cannot see this shape either:
 * they only count while `actionable > 0`.
 *
 * This counter bounds the DEFERRAL, not the abandon decision: after N
 * consecutive deferrals for the same `(plan, action, reason)` the controller
 * honors beta's vote instead of suppressing it again. It never selects an
 * Option, ranks candidates, or decides WHAT comes next — the released abandon
 * still runs through the ordinary `markOptionAbandoned` + System2 handoff.
 *
 * Reset (so a legitimate deferral is preserved and the bound cannot hot-loop):
 *   - verified progress (`progressed`) resets the streak: a genuinely
 *     productive in-flight action keeps its deferral indefinitely;
 *   - a different plan/action/reason restarts the streak at 1;
 *   - the streak clears on the Nth release, so the next release needs N fresh
 *     deferrals; `applyAbandon`'s `abandonCooldownMs` and `summonLlm`'s cooldown
 *     bound the wake rate.
 */
export const BETA_ABANDON_DEFER_CYCLES_DEFAULT = 6

/** `BUDDY_BETA_ABANDON_DEFER_CYCLES` overrides N; invalid values fall back. */
export function resolveBetaAbandonDeferCycles(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = Number(env.BUDDY_BETA_ABANDON_DEFER_CYCLES ?? BETA_ABANDON_DEFER_CYCLES_DEFAULT)
  return Number.isInteger(raw) && raw >= 1 ? raw : BETA_ABANDON_DEFER_CYCLES_DEFAULT
}

export const BETA_ABANDON_DEFERRED_MARKER = 'BETA_ABANDON_DEFERRED'
export const BETA_ABANDON_RELEASED_MARKER = 'BETA_ABANDON_RELEASED'

export interface BetaAbandonDeferralInput {
  plan: string | null
  action: string
  /** the pure boundary's deferral reason (`control_action`, `control_outcome`, ...) */
  reason: string
  /** verified goal/body/search progress for this plan; resets the streak. */
  progressed?: boolean
}

export interface BetaAbandonDeferralDecision {
  /** true while the deferral is still allowed; false on the Nth (release). */
  defer: boolean
  /** consecutive deferrals for this `(plan, action, reason)` including the current one. */
  count: number
  /** the bounded N this streak is measured against. */
  limit: number
  plan: string | null
  action: string
  reason: string
  /** true exactly on the Nth deferral: the caller must honor the abandon. */
  released: boolean
}

/** Counter marker: the `count`-th consecutive deferral of a requested abandon. */
export function formatBetaAbandonDeferred(decision: BetaAbandonDeferralDecision): string {
  return `${BETA_ABANDON_DEFERRED_MARKER} count=${decision.count}/${decision.limit} plan=${decision.plan ?? 'unknown'} action=${decision.action} reason=${decision.reason}`
}

/** Release marker: N deferrals exhausted; beta's abandon is honored at this boundary. */
export function formatBetaAbandonReleased(
  plan: string | null,
  action: string,
  reason: string,
  beta: number | null,
): string {
  return `${BETA_ABANDON_RELEASED_MARKER} plan=${plan ?? 'unknown'} action=${action} beta=${beta ?? 'null'} reason=${reason}`
}

interface BetaAbandonStreak {
  plan: string | null
  action: string
  reason: string
  count: number
}

/**
 * Bounded, pure counter for a repeatedly deferred beta abandon. See the block
 * comment above for the defect, the reset conditions and the authority
 * boundary (it releases a decision beta already made; it never makes one).
 */
export class BetaAbandonDeferral {
  private readonly limit: number
  private streak: BetaAbandonStreak | null = null

  constructor(limit: number = BETA_ABANDON_DEFER_CYCLES_DEFAULT) {
    this.limit = Number.isInteger(limit) && limit >= 1 ? limit : BETA_ABANDON_DEFER_CYCLES_DEFAULT
  }

  /** Record one deferred abandon request and return the bounded decision. */
  note(input: BetaAbandonDeferralInput): BetaAbandonDeferralDecision {
    if (input.progressed === true) {
      this.streak = null
      return {
        defer: true,
        count: 0,
        limit: this.limit,
        plan: input.plan,
        action: input.action,
        reason: input.reason,
        released: false,
      }
    }
    const previous = this.streak
    const same =
      previous !== null &&
      previous.plan === input.plan &&
      previous.action === input.action &&
      previous.reason === input.reason
    const count = same ? previous.count + 1 : 1
    if (count >= this.limit) {
      this.streak = null
      return {
        defer: false,
        count,
        limit: this.limit,
        plan: input.plan,
        action: input.action,
        reason: input.reason,
        released: true,
      }
    }
    this.streak = { plan: input.plan, action: input.action, reason: input.reason, count }
    return {
      defer: true,
      count,
      limit: this.limit,
      plan: input.plan,
      action: input.action,
      reason: input.reason,
      released: false,
    }
  }

  /** Consecutive deferrals recorded so far (0 when none / reset by progress). */
  count(): number {
    return this.streak?.count ?? 0
  }

  /** Reset on verified progress, a plan change, an honored abandon, or after release. */
  reset(): void {
    this.streak = null
  }
}

/**
 * Bounded replan rate. Keyed by summon `reason`; the recorded `stateHash`
 * (inventory + position + known resources + failure signature + goal) is what
 * the acceptance means by `(reason, stateHash)`. Rule 4 bounds the case where
 * the suppressed replan is the only local recovery available.
 */
export class ReplanThrottle {
  private readonly windowMs: number
  private readonly positionDelta: number
  private readonly noInfoEscalateCycles: number
  private readonly records = new Map<string, ThrottleRecord>()
  /** consecutive zero-progress refusals for one (reason, goal, fingerprint) */
  private noInfo: NoInfoStreak | null = null

  constructor(
    windowMs: number = REPLAN_THROTTLE_WINDOW_MS_DEFAULT,
    positionDelta: number = REPLAN_POSITION_DELTA_DEFAULT,
    noInfoEscalateCycles: number = REPLAN_NO_INFO_ESCALATE_CYCLES_DEFAULT,
  ) {
    this.windowMs = windowMs
    this.positionDelta = positionDelta
    this.noInfoEscalateCycles =
      Number.isInteger(noInfoEscalateCycles) && noInfoEscalateCycles >= 1
        ? noInfoEscalateCycles
        : REPLAN_NO_INFO_ESCALATE_CYCLES_DEFAULT
  }

  /** Query without recording. Never mutates. */
  check(reason: string, inputs: ReplanInputs, now = Date.now()): ReplanThrottleDecision {
    const stateHash = hashReplanInputs(inputs)
    const previous = this.records.get(reason)
    const base = { noInfoStreak: 0, noInfoLimit: this.noInfoEscalateCycles }
    if (previous === undefined) return { allow: true, kind: 'fresh', ageMs: 0, stateHash, ...base }
    const ageMs = now - previous.at
    if (!replanInputsChanged(previous.inputs, inputs, this.positionDelta)) {
      return { allow: false, kind: 'no_new_info', ageMs, stateHash, ...base }
    }
    if (ageMs < this.windowMs) return { allow: false, kind: 'window', ageMs, stateHash, ...base }
    return { allow: true, kind: 'new_info', ageMs, stateHash, ...base }
  }

  /** Record that a replan happened at `now`. */
  record(reason: string, inputs: ReplanInputs, now = Date.now()): void {
    this.records.set(reason, { at: now, inputs: cloneInputs(inputs), stateHash: hashReplanInputs(inputs) })
  }

  /**
   * Allow-and-record in one step: the controller's entry point.
   *
   * Bounds the #78 WAIT loop: a run of `no_new_info` refusals for the SAME
   * (reason, goal, stateHash) is a local recovery that is itself making no
   * progress. On the `noInfoEscalateCycles`-th consecutive one the throttle
   * releases the replan (`kind=exhausted`) so the caller wakes System 2 with
   * `LOCAL_RECOVERY_EXHAUSTED` instead of holding the stall open forever.
   * Progress, changed inputs, a different goal, or any allowed replan resets
   * the counter, so genuine progress and ordinary churn are unaffected.
   */
  tryReplan(reason: string, inputs: ReplanInputs, now = Date.now()): ReplanThrottleDecision {
    const decision = this.check(reason, inputs, now)
    if (decision.allow) {
      this.noInfo = null
      this.record(reason, inputs, now)
      return decision
    }
    if (decision.kind !== 'no_new_info') {
      // New information arrived (window still held): not a zero-progress stall.
      this.noInfo = null
      return decision
    }
    const goalKey = inputs.goalKey ?? null
    const previous = this.noInfo
    const sameStreak =
      previous !== null &&
      previous.reason === reason &&
      previous.goalKey === goalKey &&
      previous.stateHash === decision.stateHash
    const count = sameStreak ? (previous?.count ?? 0) + 1 : 1
    if (count >= this.noInfoEscalateCycles) {
      this.noInfo = null
      this.record(reason, inputs, now)
      return {
        allow: true,
        kind: 'exhausted',
        ageMs: decision.ageMs,
        stateHash: decision.stateHash,
        noInfoStreak: count,
        noInfoLimit: this.noInfoEscalateCycles,
      }
    }
    this.noInfo = { reason, goalKey, stateHash: decision.stateHash, count }
    return { ...decision, noInfoStreak: count, noInfoLimit: this.noInfoEscalateCycles }
  }

  reset(): void {
    this.records.clear()
    this.noInfo = null
  }
}

export interface GoalLike {
  kind: string
  targetItem?: string | null
  requiredCount?: number
}

/**
 * Issue #44 requirement 3: a replacement plan must change the body. A
 * `collect` of a different resource than the blocked goal, or an `explore`
 * goal, changes position / resource source (descent, branch mine, retrieval,
 * surface trip). A stationary craft/smelt/place of the same target does not.
 * Exposed as a pure predicate so the planner and its tests share one rule.
 */
export function hasBodyDelta(planned: readonly GoalLike[], current: GoalLike | null): boolean {
  if (planned.length === 0) return false
  if (current === null) return true
  const currentItem = current.targetItem ?? null
  return planned.some((goal) => {
    if (goal.kind === 'explore') return true
    if (goal.kind === 'descend') return true
    if (goal.kind === 'place') return true
    if (goal.kind === 'surface') return true
    if (goal.kind !== 'collect') return false
    const item = goal.targetItem ?? null
    if (item === null) return false
    return item !== currentItem
  })
}

/**
 * M2 capability trap: the pure, deterministic rule that says "this is not a
 * movement problem any more". It is the truth owner for the trap; the retry /
 * score fields are a localized policy (heuristic-authority rule).
 */
export interface CapabilityGapPolicy {
  /** how far above the live feet a remembered target must be to count as an ascent */
  minClimbBlocks: number
  /** bounded observation window, in decision ticks */
  windowTicks: number
  /** net altitude gain at or below this (toward the target) does not count as progress */
  altitudeEpsilon: number
  /** refused ascend attempts within the window that make the gap fire */
  minAscendRefusals: number
  /**
   * Returns below the best altitude more than this many times inside the window
   * are an oscillation: the body keeps giving back ground it already held, so
   * the window is no progress even when a transient peak looked like a climb.
   */
  maxReturnsBelowBest: number
}

export const DEFAULT_CAPABILITY_GAP_POLICY: CapabilityGapPolicy = {
  minClimbBlocks: 8,
  windowTicks: 40,
  altitudeEpsilon: 0.9,
  minAscendRefusals: 3,
  maxReturnsBelowBest: 2,
}

export interface CapabilityGapState {
  /** remembered target the window is tracking; a new target restarts the window */
  targetKey: string
  /**
   * Progress anchor: the best feet y when the window opened/re-armed. Progress
   * is `bestY - startY`, never `currentY - startY`, so a fall back to an
   * altitude the body already held can never be counted as progress again.
   */
  startY: number
  /** highest feet y seen inside the window */
  bestY: number
  /** decision ticks observed inside the window */
  ticks: number
  /** refused ascend attempts observed inside the window */
  ascendRefusals: number
  /** times the body dropped below `bestY - altitudeEpsilon` inside the window */
  returnsBelowBest: number
  /** latch so one continuous descent counts as one return */
  belowBest: boolean
}

export interface CapabilityGapObservation {
  y: number
  targetY: number | null
  targetKey: string | null
  /** an ascend attempt was refused since the previous observation */
  ascendRefused: boolean
}

export type CapabilityGapHeuristicReason =
  | 'no_target'
  | 'target_reached'
  | 'target_in_range'
  | 'progress'
  | 'oscillation'
  | 'no_net_progress'
  | 'insufficient_evidence'

/** Localized policy surface: the window's verdict in `{chosen, score, alternatives, reason}` form. */
export interface CapabilityGapHeuristic {
  chosen: 'escalate' | 'keep_climbing'
  /** net altitude gained inside the window (the progress measure) */
  score: number
  alternatives: string[]
  reason: CapabilityGapHeuristicReason
}

export interface CapabilityGapDecision {
  gap: boolean
  attempts: number
  targetY: number | null
  reason: 'ascend_blocked' | null
  state: CapabilityGapState | null
  heuristic: CapabilityGapHeuristic
}

interface CapabilityGapVerdict {
  targetY: number | null
  state: CapabilityGapState | null
  gap: boolean
  attempts: number
  heuristic: CapabilityGapHeuristic
}

function capabilityGapDecision(verdict: CapabilityGapVerdict): CapabilityGapDecision {
  return {
    gap: verdict.gap,
    attempts: verdict.attempts,
    targetY: verdict.targetY,
    reason: verdict.gap ? 'ascend_blocked' : null,
    state: verdict.state,
    heuristic: verdict.heuristic,
  }
}

/** Exact marker the controller emits when the pure predicate fires. */
export function formatCapabilityGap(decision: CapabilityGapDecision): string {
  return `CAPABILITY_GAP reason=ascend_blocked attempts=${decision.attempts} target_y=${Math.round(decision.targetY ?? 0)}`
}

/**
 * Localized heuristic log line (audit rule): `alternatives` lists the losing
 * options; they are only logged when the window's verdict is emitted.
 */
export function formatCapabilityGapPolicy(decision: CapabilityGapDecision): string {
  const { chosen, score, alternatives, reason } = decision.heuristic
  return `CAPABILITY_GAP_POLICY chosen=${chosen} score=${score} alternatives=[${alternatives.join(',')}] reason=${reason}`
}

export const CAPABILITY_GAP_MARKER = 'CAPABILITY_GAP'

export interface CapabilityGapSignal {
  attempts: number
  targetY: number | null
}

/** Read the newest capability-gap marker out of a recent-events window, or null. */
export function parseCapabilityGap(events: readonly string[]): CapabilityGapSignal | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const line = events[index]
    if (line === undefined || !line.startsWith(`${CAPABILITY_GAP_MARKER} `)) continue
    const attempts = /attempts=(\d+)/.exec(line)
    const targetY = /target_y=(-?\d+)/.exec(line)
    return {
      attempts: attempts === null ? 0 : Number(attempts[1]),
      targetY: targetY === null ? null : Number(targetY[1]),
    }
  }
  return null
}

/**
 * Bounded-window trap detector. Fires only when a remembered target sits
 * `minClimbBlocks` above the agent, the window made no NET progress toward it,
 * AND at least `minAscendRefusals` ascend attempts were refused.
 *
 * Net progress is measured against the window's anchor (the best altitude when
 * the window opened, re-armed upward after proven progress): a transient climb
 * that falls back to ground the body already held is not progress. Repeated
 * returns below the window's best altitude (`maxReturnsBelowBest`) are an
 * explicit oscillation and make the window no-progress. Genuine monotonic
 * climbing and reaching the target keep the gap cleared.
 */
export function evaluateCapabilityGap(
  previous: CapabilityGapState | null,
  observation: CapabilityGapObservation,
  policy: CapabilityGapPolicy = DEFAULT_CAPABILITY_GAP_POLICY,
): CapabilityGapDecision {
  const { y, targetY, targetKey } = observation
  const cleared = (reason: CapabilityGapHeuristicReason): CapabilityGapDecision =>
    capabilityGapDecision({
      targetY,
      state: null,
      gap: false,
      attempts: 0,
      heuristic: { chosen: 'keep_climbing', score: 0, alternatives: ['escalate'], reason },
    })
  if (targetY === null || targetKey === null) return cleared('no_target')
  if (y >= targetY) return cleared('target_reached')
  if (targetY - y < policy.minClimbBlocks) return cleared('target_in_range')

  const restart = previous === null || previous.targetKey !== targetKey
  const window: CapabilityGapState = restart
    ? { targetKey, startY: y, bestY: y, ticks: 0, ascendRefusals: 0, returnsBelowBest: 0, belowBest: false }
    : previous
  const bestY = Math.max(window.bestY, y)
  const belowBest = y < bestY - policy.altitudeEpsilon
  const returnsBelowBest = window.returnsBelowBest + (belowBest && !window.belowBest ? 1 : 0)
  const ticks = window.ticks + 1
  const ascendRefusals = window.ascendRefusals + (observation.ascendRefused ? 1 : 0)
  // Net progress TOWARD the target: the best altitude must improve over the
  // anchor, the body must still hold it, and it must not be a sawtooth of
  // returns below that same best altitude.
  const netGain = Math.round((bestY - window.startY) * 100) / 100
  const score = Math.round(netGain * 10) / 10
  const progressed =
    netGain > policy.altitudeEpsilon &&
    !belowBest &&
    returnsBelowBest <= policy.maxReturnsBelowBest

  if (ticks >= policy.windowTicks && progressed) {
    return capabilityGapDecision({
      targetY,
      state: { targetKey, startY: bestY, bestY, ticks: 0, ascendRefusals: 0, returnsBelowBest: 0, belowBest: false },
      gap: false,
      attempts: 0,
      heuristic: { chosen: 'keep_climbing', score, alternatives: ['escalate'], reason: 'progress' },
    })
  }

  const state: CapabilityGapState = {
    targetKey,
    startY: window.startY,
    bestY,
    ticks,
    ascendRefusals,
    returnsBelowBest,
    belowBest,
  }
  const windowDone = ticks >= policy.windowTicks
  const gap = windowDone && ascendRefusals >= policy.minAscendRefusals
  const reason: CapabilityGapHeuristicReason = !gap
    ? 'insufficient_evidence'
    : returnsBelowBest > policy.maxReturnsBelowBest
      ? 'oscillation'
      : 'no_net_progress'
  return capabilityGapDecision({
    targetY,
    state,
    gap,
    attempts: ascendRefusals,
    heuristic: {
      chosen: gap ? 'escalate' : 'keep_climbing',
      score,
      alternatives: gap ? ['keep_climbing'] : ['escalate'],
      reason,
    },
  })
}
