// walkSkill.ts - issue #436: the WALK_TO family as ONE harness-layer Skill.
//
// OPERATOR DIRECTIVE (issued while watching the live body move):
//
//   "動き始めて壁にぶつかってジャンプすることはできるんだけどそれまでが長い。
//    やはりここはハーネス層にやらせるべきだ"
//   = "once it starts moving it CAN bump into a wall and jump it, but getting to
//      that point takes too long; this part should be done by the harness layer."
//
// MEASURED SYMPTOM (tools/skill-closure-metrics.mjs, run-muaxgjed-15kew):
//
//   jevDecisions 37 / actions 10 -> actionsPerDecision 0.27
//   topRepeatedActions MOVE:p19_65_22 x3, MOVE:p19_65_21 x2, MOVE:p20_65_21 x2
//   every MOVE settles `verified=true status=done progress=body` in ~0.4-1.2 s
//
// i.e. the mechanics were fine and the problem was OWNERSHIP: one committed walk
// was re-decided per primitive leg. `executor.ts#runMove` / `runRetrieve` returned
// to policy after ONE bounded leg ("bounded chunk; next decision re-plans" /
// travel-leg) and `controller-legacy.ts#onActionComplete` asked Jev again
// (`requestDecision(completionTrigger)`, controller-legacy.ts:5574) for every
// settled action.
//
// THE CONTRACT THIS MODULE SERVES (issue #436 section 3):
//
//   "A Jev selection is a commitment to one grounded semantic action, not
//    permission for one primitive Mineflayer call."
//
// While a locomotion commitment is active and inside its declared `EffectEnvelope`
// + budget, the EXECUTOR keeps making bounded mechanical progress toward the
// committed target WITHOUT a new Jev decision - including the existing
// bump-and-jump, ordinary replanning of the SAME target when a leg is blocked, and
// continuing after a leg that merely failed mechanically. Control returns to policy
// only at a SEMANTIC boundary:
//
//   arrival / declared postcondition met   -> SUCCESS (code-owned completion)
//   target invalidated / world / lease     -> typed end (section 14/23)
//   hazard / safety refusal                -> SAFETY_INTERRUPT (section 6/8)
//   budget (steps AND wall clock) spent    -> BUDGET_EXHAUSTED (section 15)
//   no authorised mechanical continuation  -> MECHANICALLY_BLOCKED + the
//                                             section 7 U3 / section 22
//                                             SKILL_POLICY_BOUNDARY
//
// WHAT THIS MODULE IS NOT (issue #436 section 22):
//
//   * it is NOT a planner and NOT a fallback: there is no `if stuck -> dig/pillar/
//     bridge` tree here, and the executor loop it serves has no route authority the
//     selected candidate's own contract did not grant. A plain WALK_TO gains
//     nothing from an obstruction it meets (section 7 U4);
//   * it ranks nothing and enumerates no candidate alternatives: the grounded
//     remedy list is owned by the layer that grounds candidates
//     (`candidates.ts#approachRouteLegs` -> `meta.legPolicyBoundary`, logged by
//     `controller-legacy.ts#logSkillPolicyBoundaries`). The executor names the typed
//     REASON it stopped, never the replacement (`formatWalkBoundary`);
//   * it never widens the commitment's `EffectEnvelope` (section 16). Every step the
//     loop takes still goes through `executor.assertEffect`, so a dig/place it was
//     not granted fails closed instead of being attempted.
//
// Everything in this file is pure: no bot, no pathfinder, no clock read.
import type { Candidate, CandidateKind } from './candidates.ts'
import { effectEnvelopeHash, formatCommittedStep } from './skillCommitment.ts'
import type { EffectEnvelope, SkillCommitment, SkillOutcome, StepAuthority } from './skillCommitment.ts'
import { formatSkillPolicyBoundary } from './skillCommitment.ts'
import { formatSkillStart, formatSkillStepAuthority } from './netherPortalPlan.ts'
import type { SkillSelectionSource } from './netherPortalPlan.ts'
import type { Vec3Json } from './state.ts'

/**
 * The committed Skill ids of the locomotion family, in the canonical `skill=`
 * vocabulary. `MOVE`/`RETREAT` are the same semantic action (walk to a selected
 * destination); a `RETRIEVE` walks to a remembered resource, so its arrival
 * contract is the resource, not only the cell it was last seen in.
 */
export type WalkSkillId = 'WALK_TO(destination)' | 'RETRIEVE_TO(resource)'

export function walkSkillIdFor(kind: CandidateKind): WalkSkillId | null {
  if (kind === 'MOVE' || kind === 'RETREAT') return 'WALK_TO(destination)'
  if (kind === 'RETRIEVE') return 'RETRIEVE_TO(resource)'
  return null
}

/** The locomotion commitment kinds this loop owns. Nothing else. */
export function isWalkSkillKind(kind: CandidateKind): boolean {
  return walkSkillIdFor(kind) !== null
}

/**
 * Bounded steps AND bounded wall-clock (section 15). `WALK_SKILL_STEP_CAP` counts
 * MECHANICAL LEGS inside one commitment, so even a pathological world (every leg
 * failing instantly) cannot spin: the commitment still settles with a typed end.
 */
export const WALK_SKILL_STEP_CAP = 16
export const WALK_SKILL_MS_CAP = 45_000

/**
 * Consecutive legs that closed less than `WALK_SKILL_MIN_PROGRESS` toward the
 * committed target stop the loop. This is a STALL bound, not a strategy choice:
 * the loop may only ever replan the SAME target, so a target whose legs stop
 * closing distance is a target policy must re-decide (possibly into a different
 * remedy class - which is exactly the boundary).
 */
export const WALK_SKILL_STALL_CAP = 2
export const WALK_SKILL_MIN_PROGRESS = 0.5

/**
 * The committed postcondition is the TARGET CELL (`classifyMoveArrival`'s
 * `sameBlockCell`), while the ordinary leg mechanics accept a loose arrival
 * (the packet stepper stops within 1 m, the control walker within 1.2 m). The
 * first leg therefore keeps the EXACT pre-loop physical path, and a retry of the
 * same committed target tightens the arrival tolerance to this range - still the
 * same mechanics, same target, no new strategy: it is how the commitment's own
 * postcondition gets verified instead of being left as `done/verified=false`.
 */
export const WALK_STRICT_ARRIVAL_RANGE = 0.4
export const WALK_STRICT_ARRIVAL_TOLERANCE = 0.5

/**
 * The wall clock of ONE mechanical leg's FIRST stage (stock pathfinder + the
 * control-walk fallback). The declared budget is the whole commitment's bound, so
 * when the committed target is far enough that a committed travel leg is the
 * designed next stage (#352), the first stage may spend at most half of what is
 * left - otherwise a control walk that cannot arrive would eat the entire
 * commitment and the travel leg could never run inside its own declared budget.
 * Never a strategy choice: both stages belong to the same committed target.
 */
export function walkStageBudgetMs(remainingMs: number, travelWarranted: boolean): number {
  if (!travelWarranted) return Math.max(1, Math.floor(remainingMs))
  return Math.max(1, Math.floor(remainingMs / 2))
}

export interface WalkSkillBudget {
  /** wall-clock bound for the WHOLE commitment */
  ms: number
  /** bound on distinct mechanical legs */
  steps: number
  /** bound on consecutive no-progress legs */
  stall: number
}

/**
 * The loop's budget. The commitment's declared `budget.ms` (the same
 * `pathTimeoutMs` every walk was already charged) is the semantic bound; the
 * module cap bounds an absent/unbounded declaration.
 */
export function walkSkillBudget(declaredMs: number | null, stepCap: number = WALK_SKILL_STEP_CAP): WalkSkillBudget {
  const ms =
    declaredMs === null || !Number.isFinite(declaredMs) || declaredMs <= 0
      ? WALK_SKILL_MS_CAP
      : Math.min(declaredMs, WALK_SKILL_MS_CAP)
  return { ms, steps: stepCap, stall: WALK_SKILL_STALL_CAP }
}

/**
 * A failure code the harness may CONTINUE through: the leg did not finish, but the
 * same committed target may still be walkable by the SAME ordinary mechanics from a
 * fresh plan at the new body position.
 *
 * Deliberately a closed allow-list, not "everything that is not safety": an
 * envelope violation, a protected block, a deterministic vertical/route refusal, a
 * missing tool or an unknown crash must never be retried by a loop - those are
 * terminal for the commitment and return to policy on the FIRST occurrence.
 */
export const WALK_LEG_CONTINUABLE: ReadonlySet<string> = new Set<string>([
  'path_stuck',
  'path_no_path',
  'out_of_reach',
])

export type WalkStopReason =
  | 'arrived'
  | 'budget_exhausted'
  | 'stalled'
  | 'safety'
  | 'invalidated'
  | 'remedy_required'
  | 'capability'

/**
 * Why the leg failed, in the loop's own vocabulary. `outcome` is the #436 section
 * 6 lifecycle outcome (the SAME closed set the commitment evidence uses), so the
 * loop and `SKILL_END` can never disagree about what kind of stop this was.
 */
export interface WalkLegFailure {
  code: string | null
  outcome: SkillOutcome
}

export interface WalkStop {
  stop: true
  reason: WalkStopReason
  outcome: SkillOutcome
  /** the failure code the settled action carries (null = the leg simply did not finish) */
  failureCode: string | null
  /** true when code reached a decision it must NOT make: policy owns the next move */
  policyBoundary: boolean
}

export interface WalkContinue {
  stop: false
}

export interface WalkBoundaryInput {
  /** distinct mechanical legs spent inside this one commitment */
  legs: number
  /** consecutive legs that closed less than `WALK_SKILL_MIN_PROGRESS` */
  stalledLegs: number
  elapsedMs: number
  budget: WalkSkillBudget
  /** the committed postcondition was verified by the last leg */
  arrived: boolean
  /** the last leg's typed failure, when it had one */
  failure: WalkLegFailure | null
  /** the world/epoch grounded identity became invalid, when observed (section 14/23) */
  invalidated: SkillOutcome | null
}

/**
 * THE ONE boundary decision. Pure and total: given what the last leg did and what
 * the commitment has spent, either continue mechanically or stop with a typed
 * reason. The order encodes the contract:
 *
 *   1. invalidation (world/epoch/lease) - the contract is gone;
 *   2. arrival - the declared postcondition is met (code-owned completion);
 *   3. safety - a hard-safety failure returns to policy IMMEDIATELY;
 *   4. budget (steps or wall clock) - a typed end, never a silent stop;
 *   5. a non-continuable failure (envelope/tool/deterministic refusal) - terminal:
 *      retrying a deterministic refusal is not mechanical progress;
 *   6. a stalled commitment - no authorised mechanical continuation is left.
 */
export function walkBoundaryAfterLeg(input: WalkBoundaryInput): WalkStop | WalkContinue {
  if (input.invalidated !== null) {
    return {
      stop: true,
      reason: 'invalidated',
      outcome: input.invalidated,
      failureCode: input.failure?.code ?? null,
      policyBoundary: false,
    }
  }
  if (input.arrived) {
    return { stop: true, reason: 'arrived', outcome: 'SUCCESS', failureCode: null, policyBoundary: false }
  }
  const failure = input.failure
  if (failure !== null) {
    switch (failure.outcome) {
      // A safety stop is an INTERRUPT with a typed end (the guard's own
      // `MOVE_LEG_STOPPED`, the env-hazard reflex's own boundary line when it has
      // one), not a "code must not choose" event: `policyBoundary` stays false so
      // the boundary counter keeps meaning the section 22 decision.
      case 'SAFETY_INTERRUPT':
        return {
          stop: true,
          reason: 'safety',
          outcome: 'SAFETY_INTERRUPT',
          failureCode: failure.code,
          policyBoundary: false,
        }
      case 'BUDGET_EXHAUSTED':
        return {
          stop: true,
          reason: 'budget_exhausted',
          outcome: 'BUDGET_EXHAUSTED',
          failureCode: failure.code,
          policyBoundary: false,
        }
      case 'CAPABILITY_LOST':
        return {
          stop: true,
          reason: 'capability',
          outcome: 'CAPABILITY_LOST',
          failureCode: failure.code,
          policyBoundary: false,
        }
      case 'TARGET_INVALIDATED':
      case 'WORLD_CHANGED':
      case 'LEASE_REVOKED':
        return {
          stop: true,
          reason: 'invalidated',
          outcome: failure.outcome,
          failureCode: failure.code,
          policyBoundary: false,
        }
      default:
        break
    }
  }
  if (input.legs >= input.budget.steps || input.elapsedMs >= input.budget.ms) {
    return {
      stop: true,
      reason: 'budget_exhausted',
      outcome: 'BUDGET_EXHAUSTED',
      failureCode: 'path_timeout',
      policyBoundary: false,
    }
  }
  if (failure !== null && !WALK_LEG_CONTINUABLE.has(failure.code ?? '')) {
    return {
      stop: true,
      reason: 'remedy_required',
      outcome: 'MECHANICALLY_BLOCKED',
      failureCode: failure.code,
      policyBoundary: true,
    }
  }
  if (input.stalledLegs >= input.budget.stall) {
    return {
      stop: true,
      reason: 'stalled',
      outcome: 'MECHANICALLY_BLOCKED',
      failureCode: failure?.code ?? 'path_stuck',
      policyBoundary: true,
    }
  }
  return { stop: false }
}

// ---------------------------------------------------------------------------
// Evidence (issue #436 section 17 vocabulary, composed - never re-declared)
// ---------------------------------------------------------------------------

/** The `selectedBy` half of `SKILL_START`, from the commitment's own provenance. */
export function walkSelectedBy(commitment: Pick<SkillCommitment, 'selectedBy'>): SkillSelectionSource {
  return commitment.selectedBy === 'hard_safety' ? 'hard-safety' : 'jev'
}

/**
 * `SKILL_START skill=<walk skill> selectedBy=<jev|hard-safety> params=...` with the
 * commitment provenance appended. ONE line per commitment - every mechanical leg
 * after it carries the same `commitmentId`, so a reviewer can count exactly how
 * many primitive legs ONE decision bought.
 *
 * `params` names the DECLARED contract, not the plan: the committed target, the
 * budget bounds, and whether this selection holds any route authority at all
 * (`routeAuthority=none` for a plain walk, section 7 U4).
 */
export function formatWalkSkillStart(input: {
  skill: WalkSkillId
  commitment: SkillCommitment
  budget: WalkSkillBudget
  target: Vec3Json
  envelope: EffectEnvelope
}): string {
  const routeAuthority =
    input.envelope.mayDigGroundedRoute === true && input.envelope.mayPlaceGroundedRoute === true
      ? 'dig+place'
      : input.envelope.mayDigGroundedRoute === true
        ? 'dig'
        : input.envelope.mayPlaceGroundedRoute === true
          ? 'place'
          : 'none'
  const params =
    `target=${input.target.x},${input.target.y},${input.target.z} ` +
    `stepCap=${input.budget.steps} msBudget=${input.budget.ms} routeAuthority=${routeAuthority}`
  return (
    `${formatSkillStart(input.skill, walkSelectedBy(input.commitment), params)} ` +
    `commitmentId=${input.commitment.commitmentId} decisionEpoch=${input.commitment.decisionEpoch} ` +
    `candidateId=${input.commitment.candidateId} envelopeHash=${effectEnvelopeHash(input.envelope)} ` +
    `postconditions=${input.commitment.expectedPostconditions.length}`
  )
}

/**
 * `SKILL_STEP skill=<walk skill> step=walk_leg authority=MECHANICAL_CONTINUATION
 * evidence=... worldDelta=... commitmentId=... count=<leg> [failure=...]`.
 *
 * One line per mechanical leg of the committed walk: the leg counter is the
 * "actions per decision" evidence, and a leg that failed mechanically and was
 * continued carries its typed `failure=` so no retry is invisible.
 */
export function formatWalkLeg(input: {
  skill: WalkSkillId
  commitment: SkillCommitment
  leg: number
  evidence: string
  worldDelta: string
  authority?: StepAuthority
  failure?: string | null
}): string {
  return formatCommittedStep({
    commitmentId: input.commitment.commitmentId,
    decisionEpoch: input.commitment.decisionEpoch,
    skillKind: input.commitment.skillKind,
    stepKind: 'walk_leg',
    authority: input.authority ?? 'MECHANICAL_CONTINUATION',
    evidence: `${input.evidence} skill=${input.skill}`,
    worldDelta: input.worldDelta,
    count: input.leg,
    ...(input.failure === null || input.failure === undefined ? {} : { retry: input.leg }),
  })
}

/**
 * The section 7 U3 / section 22 boundary: code stopped because continuing would be
 * a semantic choice it does not own (the mechanical continuation space for the
 * SAME committed target is exhausted).
 *
 * `alternatives=[]` is deliberate and is the contract's own "policy owns the list"
 * form: the layer that grounds remedy CANDIDATES (`candidates.ts`) names them
 * (`meta.legPolicyBoundary`, reason `multiple_non_equivalent_recoveries`) and the
 * controller logs that line. The executor must not enumerate remedies it has not
 * grounded, so it reports only the typed reason and the mechanical facts that
 * produced it - and performs NONE of them.
 */
export function formatWalkBoundary(input: {
  skill: WalkSkillId
  commitment: SkillCommitment
  stop: WalkStop
  legs: number
  remaining: number
  target: Vec3Json
  stalledLegs: number
}): string {
  const detail =
    `legs=${input.legs} stalledLegs=${input.stalledLegs} remaining=${Math.round(input.remaining * 100) / 100}m ` +
    `target=${input.target.x},${input.target.y},${input.target.z} ` +
    `routeAuthority=${
      input.commitment.allowedEffects.mayDigGroundedRoute === true || input.commitment.allowedEffects.mayPlaceGroundedRoute === true
        ? 'declared'
        : 'none'
    } groundedRemedies=policy_owned`
  const line = formatSkillPolicyBoundary({
    skill: input.skill,
    reason: `${input.stop.reason}:${input.stop.failureCode ?? 'no_leg_failure'}`,
    alternatives: [],
    commitmentId: input.commitment.commitmentId,
    decisionEpoch: input.commitment.decisionEpoch,
    detail,
  })
  return `${line} outcome=${input.stop.outcome}`
}

/**
 * The one-line mechanical fact of a leg, for `formatWalkLeg`. Bounded to the facts
 * the loop actually measured (distance closed, body delta, the typed failure).
 */
export function walkLegEvidence(input: {
  leg: number
  from: number
  to: number
  failureCode: string | null
  phase: string
}): string {
  const closed = Math.round((input.from - input.to) * 100) / 100
  return (
    `leg=${input.leg} phase=${input.phase} remaining=${Math.round(input.to * 100) / 100}m ` +
    `closed=${closed}m${input.failureCode === null ? '' : ` continuedAfter=${input.failureCode}`}`
  )
}

/** The target cell a locomotion commitment walks to, or null when it declares none. */
export function walkTargetOf(candidate: Pick<Candidate, 'target'>): Vec3Json | null {
  return candidate.target ?? null
}
