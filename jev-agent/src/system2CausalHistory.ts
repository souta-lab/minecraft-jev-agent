import { createHash } from 'node:crypto'
import type { QueuedGoal, PlanOp } from './goalQueue.ts'
import { evaluatePredicateTruth } from './optionSpec.ts'
import type { OptionWorldSnapshot, Predicate, PredicateTruth } from './optionSpec.ts'
import type {
  System2BlockerFacts,
  System2SemanticAcceptedGoal,
  System2SemanticBlocker,
  System2SemanticOutcome,
} from './system2.ts'

export const SYSTEM2_SEMANTIC_HISTORY_LIMIT = 4
export const SYSTEM2_SEMANTIC_GOAL_LIMIT = 8

export function system2SemanticBlocker(facts: System2BlockerFacts | null): System2SemanticBlocker | null {
  if (facts === null) return null
  const withheld = facts.withheld.slice(0, 4).map((entry) => ({
    candidate: short(entry.candidate, 96),
    kind: short(entry.kind, 40),
    reason: short(entry.reason, 80),
    missing: entry.missing.slice(0, 4).map((value) => short(value, 64)),
  }))
  const offered = facts.alternatives.presented.slice(0, 4).map((entry) => ({
    candidate: short(entry.candidate, 96),
    kind: short(entry.kind, 40),
  }))
  const toolsUnmet = facts.tools.unmet.slice(0, 3).map((entry) => ({
    tool: short(entry.tool, 32),
    requiredTier: entry.requiredTier,
    heldTier: entry.heldTier,
    candidate: short(entry.candidate, 96),
  }))
  return {
    blockedBy: facts.blockedBy === undefined ? null : short(facts.blockedBy, 80),
    missing: facts.missing.slice(0, 6).map((value) => short(value, 64)),
    withheld,
    offered,
    toolsUnmet,
    truncated:
      facts.withheld.length > withheld.length ||
      facts.alternatives.presented.length > offered.length ||
      facts.tools.unmet.length > toolsUnmet.length ||
      facts.missing.length > 6,
  }
}

/**
 * Fingerprint observed world facts, not blocker labels or queue/goal identity.
 * The blocker is carried separately, so a newly measured refusal cannot
 * masquerade as a world change and installing a WHAT cannot count as progress.
 */
export function system2SemanticFingerprint(
  worldFingerprint: string,
  dimension: string | null,
  observed: { health: number | null; food: number | null; targetItem: string; requiredCount: number; haveCount: number; complete: boolean },
): string {
  const world = worldFingerprint.split('|goal=')[0] ?? worldFingerprint
  return createHash('sha256')
    .update(JSON.stringify({ world, dimension, observed }))
    .digest('hex')
    .slice(0, 20)
}

export function createSystem2SemanticOutcome(input: {
  proposalId: string
  operation: PlanOp
  intentSource: System2SemanticOutcome['intentSource']
  intent: string
  requestedGoalsTotal: number
  acceptedGoals: readonly QueuedGoal[]
  optionInstanceBefore: string | null
  queueDoneBefore: number
  stateFingerprintBefore: string
  blockerBefore: System2SemanticBlocker | null
  successSnapshot: OptionWorldSnapshot
}): System2SemanticOutcome {
  const accepted: System2SemanticAcceptedGoal[] = input.acceptedGoals
    .slice(0, SYSTEM2_SEMANTIC_GOAL_LIMIT)
    .map((goal) => ({
      goalId: short(goal.id, 80),
      optionId: short(goal.semanticOptionTemplateId ?? goal.optionTemplateId ?? '', 80) || null,
      optionInstanceId: short(goal.semanticOptionInstanceId ?? goal.optionInstanceId ?? '', 120) || null,
      description: short(goal.semanticOptionIntent ?? goal.description, 160),
      successPredicates: (goal.optionSpec?.success ?? []).slice(0, 8).map((predicate) => ({ ...predicate })),
      successTruthBefore: typedGoalSuccessTruth(goal.optionSpec?.success ?? [], input.successSnapshot),
    }))
  const intent = short(input.intent, 240)
  const semanticIntentKey = createHash('sha256')
    .update(JSON.stringify({
      operation: input.operation,
      intent: intent.toLocaleLowerCase().replace(/\s+/g, ' ').trim(),
      goals: accepted.map((goal) => goal.description.toLocaleLowerCase()),
      acceptedGoalsTotal: input.acceptedGoals.length,
      requestedGoalsTotal: input.requestedGoalsTotal,
    }))
    .digest('hex')
    .slice(0, 20)
  return {
    proposalId: short(input.proposalId, 80),
    semanticIntentKey,
    operation: input.operation,
    intentSource: input.intentSource,
    intent,
    acceptedGoals: accepted,
    acceptedGoalsTotal: input.acceptedGoals.length,
    requestedGoalsTotal: input.requestedGoalsTotal,
    optionInstanceBefore: input.optionInstanceBefore === null ? null : short(input.optionInstanceBefore, 120),
    queueDoneBefore: input.queueDoneBefore,
    stateFingerprintBefore: input.stateFingerprintBefore,
    blockerBefore: input.blockerBefore,
    progress: { body: false, search: false, goal: false, option: false },
    stateFingerprintAfter: null,
    blockerAfter: null,
    outcome: 'pending',
  }
}

/**
 * Retain the exact current row as accepted context for continue/patch only when
 * the queue confirms that the operation applied and that row stayed current.
 * A rejected plan can leave the old head untouched, which is not acceptance.
 */
export function acceptedSystem2PlanGoals(input: {
  operation: PlanOp
  added: readonly QueuedGoal[]
  currentBefore: QueuedGoal | null
  currentAfter: QueuedGoal | null
  applied: boolean
}): QueuedGoal[] {
  const accepted = [...input.added]
  if (
    !input.applied ||
    (input.operation !== 'continue' && input.operation !== 'patch') ||
    input.currentBefore === null ||
    input.currentAfter?.id !== input.currentBefore.id ||
    accepted.some((goal) => goal.id === input.currentBefore?.id)
  ) return accepted
  // A retained head is the proposal's semantic subject; keep it inside the
  // same fixed bound as the model's maximum eight-row plan.
  if (accepted.length >= SYSTEM2_SEMANTIC_GOAL_LIMIT) return accepted
  accepted.unshift(input.currentAfter)
  return accepted
}

/** Attach observed body motion only; taxonomy search/goal flags are not WHAT proof. */
export function recordSystem2SemanticAction(
  history: readonly System2SemanticOutcome[],
  goalId: string | null,
  progressKinds: readonly string[],
): System2SemanticOutcome[] {
  if (goalId === null) return history.slice(-SYSTEM2_SEMANTIC_HISTORY_LIMIT)
  const kinds = new Set(progressKinds)
  let matched = false
  const next = history.map((entry) => {
    if (
      entry.outcome !== 'pending' ||
      !entry.acceptedGoals.some((goal) => goal.goalId === goalId)
    ) return entry
    matched = true
    return {
      ...entry,
      progress: {
        body: entry.progress.body || kinds.has('body'),
        search: entry.progress.search,
        goal: entry.progress.goal,
        option: entry.progress.option,
      },
    }
  })
  return matched ? next.slice(-SYSTEM2_SEMANTIC_HISTORY_LIMIT) : history.slice(-SYSTEM2_SEMANTIC_HISTORY_LIMIT)
}

export function finalizeSystem2SemanticOutcomes(
  history: readonly System2SemanticOutcome[],
  current: { stateFingerprint: string; blocker: System2SemanticBlocker | null; snapshot: OptionWorldSnapshot },
): System2SemanticOutcome[] {
  return history.slice(-SYSTEM2_SEMANTIC_HISTORY_LIMIT).map((entry) => {
    if (entry.outcome !== 'pending') return entry
    const successTransition = entry.acceptedGoals.some((goal) =>
      goal.successTruthBefore === 'false' &&
      typedGoalSuccessTruth(goal.successPredicates ?? [], current.snapshot) === 'true',
    )
    const progress = successTransition
      ? { ...entry.progress, goal: true, option: true }
      : entry.progress
    const semanticProgress = progress.goal || progress.search || progress.option
    const sameWorld = entry.stateFingerprintBefore === current.stateFingerprint
    const fullyBlocked = isFullyBlocked(current.blocker)
    const outcome: System2SemanticOutcome['outcome'] = semanticProgress
      ? 'semantic_progress'
      : progress.body
        ? 'body_only'
        : sameWorld && fullyBlocked
          ? 'blocked'
          : sameWorld
            ? current.blocker === null
              ? 'no_progress'
              : 'unknown'
            : 'unknown'
    return {
      ...entry,
      progress,
      stateFingerprintAfter: current.stateFingerprint,
      blockerAfter: current.blocker,
      outcome,
    }
  })
}

/** Partial/truncated refusals or any offered alternatives do not prove total blockage. */
export function isFullyBlocked(blocker: System2SemanticBlocker | null): boolean {
  return blocker !== null &&
    !blocker.truncated &&
    blocker.blockedBy !== null &&
    blocker.blockedBy.length > 0 &&
    blocker.missing.length > 0 &&
    blocker.offered.length === 0 &&
    blocker.withheld.length > 0 &&
    blocker.withheld.every((entry) => entry.missing.length > 0)
}

function typedGoalSuccessTruth(predicates: readonly Predicate[], snapshot: OptionWorldSnapshot): PredicateTruth {
  // Unregistered/custom success predicates cannot establish an authoritative
  // WHAT transition here, even if their executor has separate custom logic.
  if (predicates.length === 0 || predicates.some((predicate) => predicate.kind === 'custom')) return 'unknown'
  let unknown = false
  for (const predicate of predicates) {
    const result = evaluatePredicateTruth(predicate, snapshot).truth
    if (result === 'false') return 'false'
    if (result === 'unknown') unknown = true
  }
  return unknown ? 'unknown' : 'true'
}

function short(value: string, limit: number): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit)
}
