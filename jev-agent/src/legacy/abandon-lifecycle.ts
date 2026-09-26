// Abandon-verdict and prerequisite-lifecycle plane extracted from
// controller-legacy.ts. Owns the beta-abandon verdict/apply cluster, the
// protection-vs-abandonment reconciliation, the abandonment ledger write, and
// the per-goal prerequisite path abandonment bookkeeping (furnace prereq
// reset, abandoned-path sets, retrieve-option abandonment). No authority
// moves: beta's vote still crosses host.betaDecision, enforcement still
// crosses host.enforceUnproductiveAbandon, and the System2 wake still crosses
// host.summonLlm.
import { classifyAbandonRequest, formatAbandonEnforced, formatAbandonSuppressed } from '../abandonPolicy.ts'
import type { OptionAttemptTracker } from '../abandonPolicy.ts'
import type { BetaAuthorityDecision } from '../betaAuthority.ts'
import type { Candidate } from '../candidates.ts'
import type { JevAgentOptions } from '../controller-legacy.ts'
import type { DecisionLlmResummonLog } from '../decisionlog.ts'
import type { QueuedGoal } from '../goalQueue.ts'
import { abandonRequested } from '../jev.ts'
import type { EventLogger, JevResult } from '../jev.ts'
import { classifyAbandonReason, prerequisiteOptionName, shouldAdoptAbandon } from '../placementGuard.ts'
import type { AbandonReason, PlaceRetryLedger, PrerequisiteProtection } from '../placementGuard.ts'
import type { PrereqDecision, PrereqPath, PrereqProgress, RetrieveUnverifiedState } from '../prereqOption.ts'
import { formatProtectionAbandonConflict, reconcileProtection } from '../protectionConflict.ts'
import type { AbandonmentLedger } from '../protectionConflict.ts'
import type { AgentSignals, Vec3Json } from '../state.ts'
import type { LlmSummonReason } from '../system2.ts'
import type { AbandonVerdict } from './goal-queue-plane.ts'

export interface AbandonLifecycleHost {
  readonly abandonedOptions: AbandonmentLedger
  readonly abandonedPrereqFingerprints: Map<string, string>
  readonly abandonedPrereqPaths: Map<string, Map<PrereqPath, number>>
  readonly abandonedRetrievePaths: Map<PrereqPath, string>
  activeRetrieval: { id: string; resource: string; knownName: string; target: Vec3Json } | null
  betaAbandonPlanId: string | null
  betaDecision(decision: JevResult): BetaAuthorityDecision
  candidateFailureCount(candidateId: string): number
  currentGoalKey(): string
  enforceUnproductiveAbandon(optionId: string, planId: string | null, attempts: number, probability: number | null): void
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
  retrievalEscalationPending: boolean
  retrievalKey(active: { knownName: string; target: Vec3Json }): string
  retrievalTrack: { id: string; best: number; ticks: number; bestGap?: number } | null
  retrieveUnverified: RetrieveUnverifiedState | null
  signals: AgentSignals
  summonLlm(reason: LlmSummonReason, detail: string): DecisionLlmResummonLog | null
  readonly tickCounter: number
  unfinishedGoals(): QueuedGoal[]
  readonly unreachableResources: Set<string>
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
