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
import type { Candidate } from './candidates.ts'
import type { JevAgentOptions } from './controller-shared.ts'
import type { DecisionLlmResummonLog } from './decisionlog.ts'
import type { GoalQueue, QueuedGoal } from './goalQueue.ts'
import { abandonRequested, betaShadowDecision, decisionIdFrom, formatBetaShadow } from './jev.ts'
import type { EventLogger, JevResult } from './jev.ts'
import { isEfficientLocomotionProgress, NO_LOCOMOTION_OBSERVATION } from './locomotion.ts'
import type { LocomotionObservation } from './locomotion.ts'
import { classifyAbandonReason, prerequisiteOptionName, shouldAdoptAbandon } from './placementGuard.ts'
import type { AbandonReason, PlaceRetryLedger, PrerequisiteProtection } from './placementGuard.ts'
import type { PrereqDecision, PrereqPath, PrereqProgress, RetrieveUnverifiedState } from './prereqOption.ts'
import { formatProtectionAbandonConflict, reconcileProtection } from './protectionConflict.ts'
import type { AbandonmentLedger } from './protectionConflict.ts'
import { formatBetaAbandonDeferred, formatBetaAbandonReleased } from './replanThrottle.ts'
import type { BetaAbandonDeferral } from './replanThrottle.ts'
import type { AgentSignals, Vec3Json } from './state.ts'
import { formatStrategicNonProgressExhausted } from './strategicStall.ts'
import type { StrategicStallTracker } from './strategicStall.ts'
import type { LlmSummonReason, System2Outcome } from './system2/service.ts'
import { evaluateBetaTerminationBoundary } from './system2/escalation.ts'
import type { BetaTerminationBoundaryDecision } from './system2/escalation.ts'
import { MOVE_PROGRESS_EFFICIENCY_FLOOR } from './outcome-ledgers.ts'
import type { AbandonVerdict } from './goal-queue-plane.ts'
import {
  decideFurnacePrereqObservation,
  evaluatePrereqStall,
  formatPrereqOptionDetail,
  formatPrereqOptionFor,
  formatPrereqRankShadow,
  formatPrereqStationKnown,
  formatPrereqSwitch,
  isInventorySourced,
  nextPrereqPath,
  planPrereqOptions,
  preferPrereqPath,
  prereqOptionReason,
  prereqProgressSignature,
  prereqSubjectForGoal,
  prereqWithheldCraft,
  selectPrereqPath,
} from './prereqOption.ts'
import { furnacePrereqInputFromState, FURNACE_PREREQUISITE_ROLE } from './candidates.ts'
import type { CandidateOptions } from './candidates.ts'
import { isSensedStation } from './state.ts'
import type { WorldState } from './state.ts'

export interface AbandonLifecycleHost {
  readonly abandonedOptions: AbandonmentLedger
  readonly abandonedPrereqFingerprints: Map<string, string>
  readonly abandonedPrereqPaths: Map<string, Map<PrereqPath, number>>
  readonly abandonedRetrievePaths: Map<PrereqPath, string>
  activeRetrieval: { id: string; resource: string; knownName: string; target: Vec3Json } | null
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
  noteCandidateFailure(candidateId: string): void
  readonly optionAttempts: OptionAttemptTracker
  options: Pick<JevAgentOptions, 'abandonCooldownMs' | 'betaAuthority' | 'unproductiveAttemptLimit'>
  readonly placementRetries: PlaceRetryLedger
  prereqChosenPath: PrereqPath | null
  prereqForcedPath: PrereqPath | null
  prereqGoalKey: string | null
  prereqLoggedKey: string | null
  prereqPlan: PrereqDecision | null
  prereqProgress: PrereqProgress | null
  prereqStationKnownLoggedKey: string | null
  queue: GoalQueue
  recentOutcomes: System2Outcome[]
  retrievalEscalationPending: boolean
  retrievalKey(active: { knownName: string; target: Vec3Json }): string
  retrievalTrack: { id: string; best: number; ticks: number; bestGap?: number } | null
  retrieveUnverified: RetrieveUnverifiedState | null
  signals: AgentSignals
  readonly strategicStall: StrategicStallTracker
  summonLlm(reason: LlmSummonReason, detail: string): DecisionLlmResummonLog | null
  readonly tickCounter: number
  unfinishedGoals(): QueuedGoal[]
  readonly unreachableResources: Set<string>
  prereqSatisfiedLoggedKey: string | null
  readonly prereqStallTicks: number
  lastDecisionId: string | null
  furnacePrereqCandidateOptions(state: WorldState, unreachableStations: ReadonlySet<string>): CandidateOptions
  resetFurnacePrereq(): void
  abandonedPrereqSet(goalKey: string, now: number): Set<PrereqPath>
  nextUsablePrereqPath(decision: PrereqDecision, current: PrereqPath, abandoned: ReadonlySet<PrereqPath>): PrereqPath | null
}

/** Beta is semantic authority only when one canonical current Option exists. */
export function canAuthoritativelyAbandonOption(optionId: string | null): optionId is string {
  return typeof optionId === 'string' && optionId.length > 0
}


export function abandonVerdict(host: AbandonLifecycleHost,
decision: JevResult, optionId: string | null, planId: string | null): AbandonVerdict {
  const requested = abandonRequested(decision)
  const now = Date.now()
  // The wrapper calls this immediately before `betaTerminationBoundary`, so the
  // deferral bound below is keyed on the same plan revision this verdict used.
  host.betaAbandonPlanId = planId
  if (!canAuthoritativelyAbandonOption(optionId)) {
    const classification = classifyAbandonRequest({
      abandonRequested: requested,
      betaAuthority: false,
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
    betaAuthority: host.options.betaAuthority,
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
    return { adopt: vote.adopt, enforced: false, suppressed: vote.shadowed, classification, vote, optionId, planId }
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
        betaAuthority: host.options.betaAuthority,
        betaShadowed: verdict.vote.shadowed,
        abandonRequested: true,
      }),
      {
        optionId: verdict.optionId,
        planId: verdict.planId,
        attempts: verdict.classification.attempts,
        betaAuthority: host.options.betaAuthority,
        betaShadowed: verdict.vote.shadowed,
        abandonRequested: true,
        action: 'abandon',
      },
      host.tickCounter,
    )
    host.enforceUnproductiveAbandon(verdict.optionId, verdict.planId, verdict.classification.attempts, probability)
    return true
  }
  if (verdict.optionId === null) return false
  if (host.options.betaAuthority) {
    if (!verdict.adopt) return false
    const probability = result.answers.abandon_option?.probability ?? null
    host.markOptionAbandoned(verdict.optionId, 'authority')
    host.summonLlm('no_progress', `abandon_option=${probability} crossed the replan threshold`)
    return true
  }
  if (verdict.suppressed && abandonRequested(result)) {
    host.logger.info(
      'heads',
      formatAbandonSuppressed({
        optionId: verdict.optionId,
        reason: verdict.classification.reason === 'cooldown' ? 'cooldown' : 'speculative',
        attempts: verdict.classification.attempts,
      }),
      {
        optionId: verdict.optionId,
        planId: verdict.planId,
        reason: verdict.classification.reason,
        attempts: verdict.classification.attempts,
        mode: 'shadow',
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


export function reconciledProtection(host: AbandonLifecycleHost,
protection: PrerequisiteProtection, reason: string): PrerequisiteProtection {
  const abandonedReason = protection.protect
    ? host.abandonedOptions.reasonUnder(protection.option, host.lastStateFingerprint)
    : null
  const reconciliation = reconcileProtection({ protection, abandonedReason })
  if (reconciliation.conflictLine !== null && abandonedReason !== null) {
    host.logProtectionAbandonConflict(protection.option, abandonedReason, reason)
  }
  return reconciliation.protect === protection.protect
    ? protection
    : { ...protection, protect: reconciliation.protect }
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


export function abandonedPrereqSet(host: AbandonLifecycleHost,
goalKey: string, now: number): Set<PrereqPath> {
  const bucket = host.abandonedPrereqPaths.get(goalKey)
  const abandoned = new Set<PrereqPath>()
  if (bucket === undefined) return abandoned
  for (const [path, at] of bucket) {
    if (now - at >= host.options.abandonCooldownMs) continue
    if (host.abandonedPrereqFingerprints.get(`${goalKey}|${path}`) !== host.lastStateFingerprint) continue
    abandoned.add(path)
  }
  return abandoned
}


export function resetFurnacePrereq(host: AbandonLifecycleHost): void {
  host.prereqPlan = null
  host.prereqForcedPath = null
  host.prereqGoalKey = null
  host.prereqLoggedKey = null
  host.prereqStationKnownLoggedKey = null
  host.prereqProgress = null
  host.prereqChosenPath = null
  host.abandonedRetrievePaths.clear()
  host.abandonedPrereqFingerprints.clear()
  host.retrieveUnverified = null
}


export function abandonRetrieveOption(host: AbandonLifecycleHost,
line: string, candidate: Candidate, unverified: number): void {
  host.logger.warn(
    'agent',
    line,
    { option: candidate.id, unverified, goal: host.currentGoalKey() },
    host.tickCounter,
  )
  host.abandonedRetrievePaths.set('use_known_station', host.lastStateFingerprint)
  if (candidate.target !== null) {
    const knownName =
      typeof candidate.meta.knownName === 'string' ? candidate.meta.knownName : candidate.targetName ?? 'station'
    host.unreachableResources.add(host.retrievalKey({ knownName, target: candidate.target }))
  }
  host.noteCandidateFailure(candidate.id)
  host.markOptionAbandoned(candidate.id, 'retrieve_unverified')
  host.activeRetrieval = null
  host.retrievalTrack = null
  host.retrieveUnverified = null
  host.prereqForcedPath = null
  host.prereqProgress = null
  host.prereqLoggedKey = null
  host.retrievalEscalationPending = true
  host.logger.warn(
    'agent',
    `LOCAL_RETRIEVE_RECOVERY candidate=${candidate.id} unverified=${unverified} system2=false`,
    { candidate: candidate.id, unverified, boundary: 'local_recovery' },
    host.tickCounter,
  )
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
    betaAuthority: host.options.betaAuthority,
    abandonRequested: abandonRequested(decision),
    actionId: decisionIdFrom(decision),
    goals: host.unfinishedGoals(),
    placedFurnaceCount: host.lastPlacedFurnaceCount,
  })
  if (!vote.protection.protect) return vote
  const abandonedReason = host.abandonedOptions.reasonUnder(vote.protection.option, host.lastStateFingerprint)
  if (abandonedReason === null) return vote
  host.logProtectionAbandonConflict(vote.protection.option, abandonedReason, 'authority')
  return {
    ...vote,
    adopt: host.options.betaAuthority && !vote.shadowed,
    protection: { ...vote.protection, protect: false },
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
  const progressed = betaAbandonProgressObserved(boundary.reason, outcome, host.lastLocomotionObservation)
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
      mode: host.options.betaAuthority ? 'authority' : 'shadow',
      betaAuthority: host.options.betaAuthority,
      shadowed: vote.shadowed,
    },
    host.tickCounter,
  )
}

// ---------------------------------------------------------------------------
// Furnace-prerequisite path selection + unproductive-option enforcement
// (moved from controller.ts; the path lifecycle belongs with the
// abandonment bookkeeping above)
// ---------------------------------------------------------------------------

/**
 * Keep the active furnace prerequisite's semantic envelope closed.
 *
 * A furnace route may need a mechanically-derived acquisition step (for
 * example clearing headroom before retrieving a remembered crafting table),
 * so those candidates inherit the selected `prereqPath` from candidates.ts.
 * Safety and control remain available regardless of the selected route.  An
 * untagged productive candidate is not a safe fallback: allowing it here
 * silently replaces the selected prerequisite with a different semantic goal
 * and was the source of the exact-run `CRAFT:stick` detour.
 */
export function filterFurnacePrerequisiteCandidates(
  candidates: readonly Candidate[],
  chosen: PrereqPath | null,
): Candidate[] {
  return candidates.filter((candidate) => {
    if (
      candidate.kind === 'ATTACK' ||
      candidate.kind === 'EAT' ||
      candidate.kind === 'EQUIP' ||
      candidate.kind === 'RETREAT' ||
      candidate.kind === 'WAIT' ||
      candidate.kind === 'ESCALATE'
    ) {
      return true
    }
    const role = candidate.meta.prerequisiteRole
    return role === FURNACE_PREREQUISITE_ROLE && chosen !== null && candidate.meta.prereqPath === chosen
  })
}

export function enforceUnproductiveAbandon(host: AbandonLifecycleHost,
  optionId: string,
  planId: string | null,
  attempts: number,
  probability: number | null,
  ): void {
  const now = Date.now()
  host.optionAttempts.markAbandoned(optionId, planId, now)
  if (host.prereqPlan !== null && host.prereqChosenPath !== null) {
    const current = host.prereqChosenPath
    const goalKey = host.prereqGoalKey ?? host.currentGoalKey()
    const bucket = host.abandonedPrereqPaths.get(goalKey) ?? new Map<PrereqPath, number>()
    bucket.set(current, now)
    host.abandonedPrereqPaths.set(goalKey, bucket)
    host.abandonedPrereqFingerprints.set(`${goalKey}|${current}`, host.lastStateFingerprint)
    const next = nextPrereqPath(host.prereqPlan, current)
    host.prereqForcedPath = next
    host.prereqProgress = null
    host.prereqLoggedKey = null
    host.logger.warn(
      'agent',
      `PREREQ_ABANDON from=${current} to=${next ?? 'none'} reason=unproductive attempts=${attempts}`,
      { from: current, to: next, reason: 'unproductive', attempts, goal: goalKey },
      host.tickCounter,
    )
  }
  host.markOptionAbandoned(host.lastDecisionId ?? optionId, 'unproductive')
  host.summonLlm('no_progress', `abandon_option=${probability} enforced: ${optionId} unproductive after ${attempts} attempts`)
}

export function applyFurnacePrereq(host: AbandonLifecycleHost,
  state: WorldState,
  candidates: readonly Candidate[],
  unreachableStations: ReadonlySet<string>,
  ): Candidate[] {
  const goal = state.goalQueue?.current ?? null
  // Same predicate the candidate generator uses (candidates.ts#furnaceAcquisitionCandidates):
  // a furnace prerequisite exists only for a smelt goal with no placed furnace. Using the
  // stricter targetItem check here would let a retrieval candidate through unfiltered (#78).
  const subject = prereqSubjectForGoal(goal)
  if (subject === null) {
    host.resetFurnacePrereq()
    return [...candidates]
  }
  const sensedStationCount = (state.furnaces ?? []).filter(isSensedStation).length
  const observation = decideFurnacePrereqObservation({
    subject,
    sensedStationCount,
    goalKey: host.currentGoalKey(),
    previousKey: host.prereqSatisfiedLoggedKey,
  })
  if (observation.key !== null) {
    // A satisfied prerequisite is not a path choice: emit the distinct typed
    // observation at most once per goal instead of a false PREREQ_OPTION.
    host.resetFurnacePrereq()
    if (observation.line !== null) {
      host.prereqSatisfiedLoggedKey = observation.key
      host.logger.info(
        'agent',
        observation.line,
        { subject, source: 'sensed', sensedStationCount },
        host.tickCounter,
      )
    }
    return [...candidates]
  }
  const input = furnacePrereqInputFromState(state, host.furnacePrereqCandidateOptions(state, unreachableStations))
  const decision = planPrereqOptions(input)
  const goalKey = host.currentGoalKey()
  if (host.prereqGoalKey !== goalKey) {
    host.prereqGoalKey = goalKey
    host.prereqForcedPath = null
    host.prereqProgress = null
    host.prereqLoggedKey = null
    host.prereqStationKnownLoggedKey = null
    host.abandonedRetrievePaths.clear()
    host.retrieveUnverified = null
  }
  const abandoned = host.abandonedPrereqSet(goalKey, Date.now())
  for (const [path, fingerprint] of host.abandonedRetrievePaths) {
    if (fingerprint === host.lastStateFingerprint) abandoned.add(path)
  }
  const base = selectPrereqPath(decision, abandoned)
  const forced = host.prereqForcedPath !== null && !abandoned.has(host.prereqForcedPath) ? host.prereqForcedPath : null
  const chosen = preferPrereqPath(base, forced, decision)
  if (host.prereqForcedPath !== null && host.prereqForcedPath !== chosen) host.prereqForcedPath = null
  host.prereqPlan = decision
  host.prereqChosenPath = chosen
  const logKey = `${goalKey}|${chosen ?? 'none'}`
  if (host.prereqLoggedKey !== logKey) {
    host.prereqLoggedKey = logKey
    host.logger.info(
      'agent',
      formatPrereqOptionFor(decision, chosen),
      {
        chosen,
        options: decision.options.map((option) => ({ path: option.path, feasible: option.feasible, cost: option.cost, reason: option.reason })),
      },
      host.tickCounter,
    )
    host.logger.info(
      'agent',
      formatPrereqRankShadow(decision, chosen),
      {
        policy: decision.policy,
        costChoice: chosen,
        rankChoice: decision.rankBaseline,
        agree: chosen === decision.rankBaseline,
      },
      host.tickCounter,
    )
    if (chosen !== null && isInventorySourced(chosen)) {
      host.logger.info(
        'agent',
        formatPrereqOptionDetail('furnace', chosen, prereqOptionReason(chosen), input.heldCount),
      { chosen, heldCount: input.heldCount, abandoned: [...abandoned] },
        host.tickCounter,
      )
    }
  }
  // OPERATOR RULE (station-use-before-craft): when the world already holds a
  // usable station of the needed kind the craft path is INELIGIBLE, so say so
  // with its own typed line instead of only omitting `CRAFT:furnace` from the
  // offered set. The line is derived from the very option the planner marked
  // ineligible, and it names the path that runs instead, so the run log can
  // never show a withheld duplicate craft without its reason.
  const withheldCraft = prereqWithheldCraft(decision)
  if (withheldCraft !== null && input.knownStation !== null) {
    const stationKnownLine = formatPrereqStationKnown(input.knownStation, input.heldCount, chosen)
    if (stationKnownLine !== host.prereqStationKnownLoggedKey) {
      host.prereqStationKnownLoggedKey = stationKnownLine
      host.logger.info(
        'agent',
        stationKnownLine,
        {
          reason: withheldCraft.reason,
          station: input.knownStation,
          held: input.heldCount,
          chosen,
          goal: goalKey,
        },
        host.tickCounter,
      )
    }
  } else {
    host.prereqStationKnownLoggedKey = null
  }
  const kept = filterFurnacePrerequisiteCandidates(candidates, chosen)
  if (chosen === null) return kept

  const signature = prereqProgressSignature(chosen, input)
  const evaluated = evaluatePrereqStall({
    previous: host.prereqProgress,
    path: chosen,
    signature,
    stallTicks: host.prereqStallTicks,
  })
  host.prereqProgress = evaluated.progress
  if (!evaluated.stalled) return kept

  const next = host.nextUsablePrereqPath(decision, chosen, abandoned)
  if (next === null) return kept
  host.prereqForcedPath = next
  host.prereqChosenPath = next
  host.prereqProgress = null
  host.prereqLoggedKey = null
  host.logger.warn(
    'agent',
    formatPrereqSwitch(chosen, next),
    { from: chosen, to: next, stallTicks: host.prereqStallTicks, goal: goalKey },
    host.tickCounter,
  )
  return filterFurnacePrerequisiteCandidates(candidates, next)
}

export function nextUsablePrereqPath(host: AbandonLifecycleHost,
  decision: PrereqDecision,
  current: PrereqPath,
  abandoned: ReadonlySet<PrereqPath>,
  ): PrereqPath | null {
  const seen = new Set<PrereqPath>([current])
  for (;;) {
    const next = nextPrereqPath(decision, current)
    if (next === null || seen.has(next)) break
    if (!abandoned.has(next)) return next
    seen.add(next)
    current = next
  }
  return null
}
