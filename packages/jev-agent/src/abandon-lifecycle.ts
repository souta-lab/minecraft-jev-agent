// Abandon-verdict and prerequisite-lifecycle plane extracted from
// controller.ts. Owns the beta-abandon verdict/apply cluster, the
// protection-vs-abandonment reconciliation, the abandonment ledger write, and
// the per-goal prerequisite path abandonment bookkeeping (furnace prereq
// reset, abandoned-path sets, retrieve-option abandonment). No authority
// moves: beta's vote still crosses host.betaDecision, enforcement still
// crosses host.enforceUnproductiveAbandon, and the System2 wake still crosses
// host.summonLlm.
import { classifyAbandonRequest, formatAbandonEnforced, formatAbandonSuppressed } from './abandonPolicy.ts'
import type { OptionAttemptTracker } from './abandonPolicy.ts'
import { betaAuthorityDecision } from './betaAuthority.ts'
import type { BetaAuthorityDecision } from './betaAuthority.ts'
import type { JevAgentOptions } from './controller-shared.ts'
import type { DecisionLlmResummonLog } from './decisionlog.ts'
import type { GoalQueue, QueuedGoal } from './goalQueue.ts'
import { abandonRequested, actionDeclined, betaShadowDecision, decisionIdFrom, formatBetaShadow } from './jev.ts'
import type { EventLogger, JevResult } from './jev.ts'
import { isEfficientLocomotionProgress, NO_LOCOMOTION_OBSERVATION } from './locomotion.ts'
import type { LocomotionObservation } from './locomotion.ts'
import { classifyAbandonReason, prerequisiteOptionName, shouldAdoptAbandon } from './placementGuard.ts'
import type { AbandonReason, PlaceRetryLedger } from './placementGuard.ts'
import { formatProtectionAbandonConflict, reconcileProtection } from './protectionConflict.ts'
import type { AbandonmentLedger } from './protectionConflict.ts'
import { formatBetaAbandonDeferred, formatBetaAbandonReleased } from './replanThrottle.ts'
import type { BetaAbandonDeferral } from './replanThrottle.ts'
import type { AgentSignals } from './state.ts'
import { formatStrategicNonProgressExhausted } from './strategicStall.ts'
import type { StrategicStallTracker } from './strategicStall.ts'
import type { LlmSummonReason, System2Outcome } from './system2/service.ts'
import { evaluateBetaTerminationBoundary } from './system2/escalation.ts'
import type { BetaTerminationBoundaryDecision } from './system2/escalation.ts'
import { MOVE_PROGRESS_EFFICIENCY_FLOOR } from './outcome-ledgers.ts'
import type { AbandonVerdict } from './goal-queue-plane.ts'

export interface AbandonLifecycleHost {
  readonly abandonedOptions: AbandonmentLedger
  readonly betaAbandonDeferral: BetaAbandonDeferral
  betaAbandonPlanId: string | null
  betaDecision(decision: JevResult): BetaAuthorityDecision
  candidateFailureCount(candidateId: string): number
  currentGoalKey(): string
  enforceUnproductiveAbandon(optionId: string, planId: string | null, attempts: number, probability: number | null): void
  lastAbandonAdopted: boolean
  lastLocomotionObservation: LocomotionObservation
  lastPlacedFurnaceCount: number
  lastStateFingerprint: string
  logger: EventLogger
  logProtectionAbandonConflict(option: string, abandonedReason: string, reason: string): void
  markOptionAbandoned(optionId: string | null, reason: string): void
  readonly optionAttempts: OptionAttemptTracker
  options: Pick<JevAgentOptions, 'abandonCooldownMs' | 'unproductiveAttemptLimit'>
  readonly placementRetries: PlaceRetryLedger
  queue: GoalQueue
  recentOutcomes: System2Outcome[]
  signals: AgentSignals
  readonly strategicStall: StrategicStallTracker
  summonLlm(reason: LlmSummonReason, detail: string): DecisionLlmResummonLog | null
  readonly tickCounter: number
  unfinishedGoals(): QueuedGoal[]
  lastDecisionId: string | null
  /** The most recent verified progress outcome already used to defer beta once. */
  lastBetaAbandonProgressOutcome: System2Outcome | null
}

/** Beta is semantic authority only when one canonical current Option exists. */
export function canAuthoritativelyAbandonOption(optionId: string | null): optionId is string {
  return typeof optionId === 'string' && optionId.length > 0
}

export function abandonVerdict(host: AbandonLifecycleHost,
decision: JevResult, optionId: string | null, planId: string | null): AbandonVerdict {
  // §18 Gate F: declining the sole grounded action on a singleton offer is a
  // beta-form vote - the Option's only means was refused, so it counts as a
  // request to end it (deferral/cooldown bounds still apply).
  const requested = abandonRequested(decision) || actionDeclined(decision)
  const now = Date.now()
  // The wrapper calls this immediately before `betaTerminationBoundary`, so the
  // deferral bound below is keyed on the same plan revision this verdict used.
  host.betaAbandonPlanId = planId
  if (!canAuthoritativelyAbandonOption(optionId)) {
    const classification = classifyAbandonRequest({
      abandonRequested: requested,
      attempts: 0,
      lastVerified: false,
      lastProgressDelta: 0,
      attemptLimit: host.options.unproductiveAttemptLimit,
      alreadyAbandoned: false,
    })
    const vote = host.betaDecision(decision)
    if (requested) {
      host.logger.warn(
        'heads',
        `BETA_NONAUTHORITATIVE option=none reason=no_current_option beta=${decision.answers.abandon_option?.probability ?? 'null'}`,
        { optionId: null, planId, reason: 'no_current_option', beta: decision.answers.abandon_option?.probability ?? null },
        host.tickCounter,
      )
    }
    return { adopt: false, enforced: false, suppressed: requested, classification, vote, optionId: null, planId }
  }
  const state = host.optionAttempts.stateFor(optionId, planId)
  const classification = classifyAbandonRequest({
    abandonRequested: requested,
    attempts: state.attempts,
    lastVerified: state.verified,
    lastProgressDelta: state.progressDelta,
    attemptLimit: host.options.unproductiveAttemptLimit,
    alreadyAbandoned: host.optionAttempts.isAbandoned(optionId, planId, now, host.options.abandonCooldownMs),
  })
  const vote = host.betaDecision(decision)
  if (!requested) return { adopt: false, enforced: false, suppressed: false, classification, vote, optionId, planId }
  if (classification.reason === 'unproductive') {
    return { adopt: true, enforced: true, suppressed: false, classification, vote, optionId, planId }
  }
  if (classification.reason === 'authority') {
    return { adopt: vote.adopt, enforced: false, suppressed: false, classification, vote, optionId, planId }
  }
  return { adopt: false, enforced: false, suppressed: classification.suppressed, classification, vote, optionId, planId }
}

export function applyAbandon(host: AbandonLifecycleHost,
result: JevResult, verdict: AbandonVerdict): boolean {
  if (verdict.enforced) {
    if (verdict.optionId === null) return false
    const probability = result.answers.abandon_option?.probability ?? null
    host.logger.warn(
      'heads',
      formatAbandonEnforced({
        optionId: verdict.optionId,
        attempts: verdict.classification.attempts,
        verified: verdict.classification.verified,
        progressDelta: verdict.classification.progressDelta,
        abandonRequested: true,
      }),
      {
        optionId: verdict.optionId,
        planId: verdict.planId,
        attempts: verdict.classification.attempts,
        abandonRequested: true,
        action: 'abandon',
      },
      host.tickCounter,
    )
    host.enforceUnproductiveAbandon(verdict.optionId, verdict.planId, verdict.classification.attempts, probability)
    return true
  }
  if (verdict.optionId === null) return false
  if (verdict.adopt) {
    const probability = result.answers.abandon_option?.probability ?? null
    host.markOptionAbandoned(verdict.optionId, 'authority')
    host.summonLlm('no_progress', `abandon_option=${probability} crossed the replan threshold`)
    return true
  }
  if (verdict.suppressed && verdict.classification.reason === 'cooldown' && abandonRequested(result)) {
    host.logger.info(
      'heads',
      formatAbandonSuppressed({
        optionId: verdict.optionId,
        reason: 'cooldown',
        attempts: verdict.classification.attempts,
      }),
      {
        optionId: verdict.optionId,
        planId: verdict.planId,
        reason: verdict.classification.reason,
        attempts: verdict.classification.attempts,
        action: 'continue',
      },
      host.tickCounter,
    )
  }
  return false
}

export function abandonReason(host: AbandonLifecycleHost,
actionId: string, beta: number | null): AbandonReason {
  return classifyAbandonReason({
    beta,
    lastFailureCode: host.signals.lastFailureCode,
    candidateFailures: host.candidateFailureCount(actionId),
    escalationRecommended: host.signals.escalationRecommended,
  })
}

export function placeRetryExhausted(host: AbandonLifecycleHost): boolean {
  return host.placementRetries.anyExhausted()
}

export function logProtectionAbandonConflict(host: AbandonLifecycleHost,
option: string, abandonedReason: string, reason: string): void {
  if (!host.abandonedOptions.claimConflict(option, host.lastStateFingerprint)) return
  host.logger.warn(
    'heads',
    formatProtectionAbandonConflict(option, 'abandoned', abandonedReason),
    { option, action: 'abandoned', abandonedReason, reason, fingerprint: host.lastStateFingerprint },
    host.tickCounter,
  )
}

export function markOptionAbandoned(host: AbandonLifecycleHost,
optionId: string | null, reason: string): void {
  if (optionId === null) return
  const option = prerequisiteOptionName(optionId)
  const guard = shouldAdoptAbandon({
    actionId: optionId,
    goals: host.unfinishedGoals(),
    placedFurnaceCount: host.lastPlacedFurnaceCount,
    abandonRequested: true,
  })
  if (guard.protection.protect) host.logProtectionAbandonConflict(option, reason, 'abandoned')
  host.abandonedOptions.markAbandoned(option, host.lastStateFingerprint, reason)
}

// ---------------------------------------------------------------------------
// Beta verdict + shadow cluster (moved from controller.ts)
// ---------------------------------------------------------------------------

/**
 * Verified goal/body/search progress observed for the current decision. Used
 * only to reset the bounded beta-abandon deferral (a productive in-flight action
 * keeps its deferral); it never selects an action.
 */
export function betaAbandonProgressObserved(
  reason: string,
  outcome: System2Outcome | null,
  locomotionObservation: LocomotionObservation = NO_LOCOMOTION_OBSERVATION,
): boolean {
  const kinds = outcome?.progressKinds ?? []
  const progress = outcome?.progress ?? null
  if (progress === 'goal' || progress === 'search' || kinds.includes('goal') || kinds.includes('search')) return true
  const bodyProgress =
    outcome === null
      ? reason === 'body_or_search_progress'
      : progress === 'body' || kinds.includes('body') || reason === 'body_or_search_progress'
  if (!bodyProgress) return false
  // Issue #360 sections 8 and 11: body motion kept the bounded beta-abandon deferral
  // alive every cycle, so Jev beta's abandon vote (measured live at 0.68-0.73 against a
  // 0.5 threshold) was deferred forever and the Option never ended. Walking is still
  // legitimate progress, so the deferral is kept only when the body is actually going
  // somewhere: the windowed locomotion efficiency must be above the same floor the
  // move-failure memory uses. A state-recurring micro-move loop sits at ~0-6% and no
  // longer holds the Option open. An idle or not-yet-sampled window is not
  // locomotion evidence and therefore cannot keep the deferral alive either.
  return isEfficientLocomotionProgress(locomotionObservation, MOVE_PROGRESS_EFFICIENCY_FLOOR)
}

export function betaDecision(host: AbandonLifecycleHost, decision: JevResult): BetaAuthorityDecision {
  const vote = betaAuthorityDecision({
    abandonRequested: abandonRequested(decision),
    actionId: decisionIdFrom(decision),
    goals: host.unfinishedGoals(),
    placedFurnaceCount: host.lastPlacedFurnaceCount,
  })
  if (!vote.protection.protect) return vote
  // A protection claim and a live abandonment fact are mutually exclusive under
  // one fingerprint; the abandonment (the observed fact) wins via the shared
  // reconciliation rule. Once released, the beta vote itself decides.
  const abandonedReason = host.abandonedOptions.reasonUnder(vote.protection.option, host.lastStateFingerprint)
  const reconciliation = reconcileProtection({ protection: vote.protection, abandonedReason })
  if (reconciliation.conflictLine !== null && abandonedReason !== null) {
    host.logProtectionAbandonConflict(vote.protection.option, abandonedReason, 'authority')
  }
  if (reconciliation.protect === vote.protection.protect) return vote
  return {
    ...vote,
    adopt: abandonRequested(decision),
    protection: { ...vote.protection, protect: reconciliation.protect },
  }
}

export function betaTerminationBoundary(host: AbandonLifecycleHost, decision: JevResult, optionId: string | null): BetaTerminationBoundaryDecision {
  const outcome = host.recentOutcomes.at(-1) ?? null
  const evidence = host.signals?.strategicNonProgress ?? null
  const semanticExhausted = evidence !== null && evidence.exhausted
  if (semanticExhausted) {
    host.logger.warn(
      'agent',
      formatStrategicNonProgressExhausted(host.currentGoalKey(), evidence),
      {
        option: optionId,
        windowSize: evidence.windowSize,
        horizon: evidence.horizon,
        distinctStates: evidence.distinctStates,
        bodyProgressDecisions: evidence.bodyProgressDecisions,
        exhaustedRepeats: evidence.exhaustedRepeats,
        boundary: 'semantic_exhausted',
      },
      host.tickCounter,
    )
    // Clear the consumed window but leave `signals.strategicNonProgress` as the
    // exhausted snapshot for this decision, so the authority facade can see it.
    host.strategicStall.acknowledgeExhaustion()
  }
  const boundary = evaluateBetaTerminationBoundary({
    optionId,
    requested: abandonRequested(decision),
    decisionActionId: decisionIdFrom(decision),
    latestOutcome: outcome,
    semanticExhausted,
    semanticInvalid: false,
  })
  if (!abandonRequested(decision) || boundary.adopt) {
    // A vote that is honored (or not requested) ends the deferred streak.
    host.betaAbandonDeferral.reset()
    return boundary
  }
  const action = decisionIdFrom(decision) ?? 'WAIT'
  // `recentOutcomes` is a bounded history, not a per-epoch event. The last
  // verified search/goal outcome can remain at its tail while the same cached
  // DECLINE is replayed. Consume that progress once so it grants one deferral;
  // subsequent unchanged epochs advance the bounded lifecycle instead of
  // treating the old success as fresh progress forever.
  const freshOutcome = outcome !== null && outcome !== host.lastBetaAbandonProgressOutcome
  const progressed = freshOutcome && betaAbandonProgressObserved(boundary.reason, outcome, host.lastLocomotionObservation)
  if (progressed && outcome !== null) host.lastBetaAbandonProgressOutcome = outcome
  const bounded = host.betaAbandonDeferral.note({
    plan: host.betaAbandonPlanId,
    action,
    reason: boundary.reason,
    progressed,
  })
  if (bounded.defer) {
    host.logger.info(
      'heads',
      formatBetaAbandonDeferred(bounded),
      {
        count: bounded.count,
        limit: bounded.limit,
        planId: bounded.plan,
        action: bounded.action,
        reason: bounded.reason,
        progressed,
      },
      host.tickCounter,
    )
    return boundary
  }
  const probability = decision.answers.abandon_option?.probability ?? null
  host.logger.warn(
    'heads',
    formatBetaAbandonReleased(bounded.plan, bounded.action, bounded.reason, probability),
    { planId: bounded.plan, action: bounded.action, reason: bounded.reason, beta: probability },
    host.tickCounter,
  )
  // Beta already voted to end the Option; the deferral budget is spent, so
  // honor that vote. The released abandon still runs through the ordinary
  // `markOptionAbandoned` + System2 handoff — this layer never picks WHAT next.
  return { adopt: true, wake: true, reason: 'semantic_abandon' }
}

export function logBetaShadow(host: AbandonLifecycleHost, optionId: string | null, decision: JevResult, actualReplanAdopted: boolean): void {
  const beta = decision.answers.abandon_option?.probability ?? null
  const vote = host.betaDecision(decision)
  const actualReplan = actualReplanAdopted || host.queue.isEmpty || host.lastAbandonAdopted
  const shadow = betaShadowDecision({ optionId, beta, actualReplan })
  host.logger.info(
    'beta-shadow',
    formatBetaShadow(shadow),
    {
      ...shadow,
      adopted: vote.adopt,
    },
    host.tickCounter,
  )
}

// ---------------------------------------------------------------------------
// Unproductive-option enforcement
// ---------------------------------------------------------------------------

/**
 * Bounded code-owned enforcement: an Option that burned
 * `unproductiveAttemptLimit` attempts without progress is retired and the
 * planner is woken. This ends an exhausted effort; it never picks WHAT next.
 */
export function enforceUnproductiveAbandon(host: AbandonLifecycleHost,
  optionId: string,
  planId: string | null,
  attempts: number,
  probability: number | null,
  ): void {
  host.optionAttempts.markAbandoned(optionId, planId, Date.now())
  host.markOptionAbandoned(host.lastDecisionId ?? optionId, 'unproductive')
  host.summonLlm('no_progress', `abandon_option=${probability} enforced: ${optionId} unproductive after ${attempts} attempts`)
}
