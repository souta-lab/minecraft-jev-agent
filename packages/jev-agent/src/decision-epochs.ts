// decision-epochs.ts — the decision-epoch / commitment plumbing extracted
// from controller.ts (issue #437 epoch machinery + #11 v2 §7 / #436
// commitment surfaces).
//
// Owns the causal-isolation records around one policy decision: the epoch
// START/END/REPOINTED lines, the SkillOutcomePacket that closes the epoch the
// settled Skill belonged to, the deterministic guard-rejection path (charge,
// provenance stamp, typed packet), the candidate-flap and action-lifecycle
// commitment windows, the WAIT streak bound, the bounded PLACE retry, the
// in-flight critical-trigger checks, and the two deterministic commitment
// cancellations (world/epoch invalidation, contradicted skill target).
//
// Seam: escalate is patched through controller.ts internals, and
// emitSkillOutcomePacket / schedulePlaceRetry are declared on
// OutcomeAccountingHost (called there through host.), so in-module calls to
// cross-plane names go through the host and the class keeps one-line
// delegates everywhere.


import { randomUUID } from 'node:crypto'
import type { Bot } from 'mineflayer'
import type { OptionAttemptTracker } from './abandonPolicy.ts'
import { evaluateActionCommitment, evaluateCandidateFlap } from './candidateCommitment.ts'
import type { ActionCommitmentState, CandidateFlapState, FlapCandidate } from './candidateCommitment.ts'
import { CONTACT_THREAT_KINDS, CRITICAL_COMBAT_HEALTH, KNOWN_RETRIEVE_SKILL } from './candidates.ts'
import type { Candidate, CandidateKind } from './candidates.ts'
import { attachResult } from './decisionlog.ts'
import type { DecisionJevLog, DecisionRecord } from './decisionlog.ts'
import type { ExecutionResult, Executor, FailureCode } from './executor.ts'
import type { GatedScore } from './gating.ts'
import type { GoalQueue } from './goalQueue.ts'
import { decisionIdFrom } from './jev.ts'
import type { EventLogger, JevResult, JsonlWriter, QuestionSetKind } from './jev.ts'
import {
  buildSkillOutcomePacket,
  classifyProjectionChange,
  commitmentRefFor,
  formatEpochEnd,
  formatEpochStart,
  formatJevCandidateSet,
  formatJevStateProjection,
  formatSkillOutcomePacket,
  mandatoryPolicyBoundary,
  repointReplayedChoice,
  semanticTargetRef,
} from './jev/semantic-projection.ts'
import type {
  DecisionEpoch,
  GroundedFact,
  JevDecisionEpochs,
  JevSemanticProjection,
  SemanticCandidateView,
  SemanticDelta,
  SkillOutcomePacket,
} from './jev/semantic-projection.ts'
import { isTrackedMoveKind } from './moveFailMemory.ts'
import type { MoveFailureReason } from './moveFailMemory.ts'
import { formatSkillEnd, formatSkillInterrupt } from './netherPortalPlan.ts'
import type { CurrentOptionContext } from './optionSpec.ts'
import { PLACE_RETRIES_EXHAUSTED } from './placementGuard.ts'
import type { PlaceRetryLedger } from './placementGuard.ts'
import { formatActionRejected, guardRejectionChargesOption, unreachableMove } from './policy.ts'
import type { GuardCode, GuardResult } from './policy.ts'
import { formatWaitExhausted, formatWaitStreak } from './replanThrottle.ts'
import type { WaitStreakEscalation } from './replanThrottle.ts'
import { commitmentInvalidation, formatSkillInvalidated, targetIdentityKey } from './skillCommitment.ts'
import { pickHigherPriority, PREEMPTIVE_TRIGGERS, shouldDeferTriggerDuringBreathEscapeLease, shouldDeferTriggerDuringRetreatLease, shouldPreemptActiveActionLease } from './scheduler.ts'
import type { DecisionTrigger, TriggerEvent } from './scheduler.ts'
import type { GoalState, Vec3Json, WorldState } from './state.ts'
import { MELEE_THREAT_REACH } from './threat.ts'
import type { MobIdentityContext } from './threat.ts'
import type { JevAgentOptions } from './controller-shared.ts'
import type { EscalationReason } from './escalation.ts'
import type { JevPolicy } from './jev.ts'
import {
  classifySemanticBoundary,
  dedupeSemanticCandidates,
  formatStaleResultDropped,
  projectionHash as semanticProjectionHash,
} from './jev/semantic-projection.ts'
import { stableStateHash } from './decisionlog.ts'
import { failureCount } from './failureMemory.ts'
import { questionNamesFor } from './jev.ts'
import { optionIdForGoal, planRevisionForGoal } from './causal.ts'
import { assertRecoveryModelAuthority, describeFailure, failLoud, FatalModelError } from './modelFailure.ts'
import type { AbandonVerdict } from './goal-queue-plane.ts'
import type { AgentSignals } from './state.ts'


/** Safety-critical events: an incompatible threat makes the Jev answer stale. */
export const CRITICAL_TRIGGERS: ReadonlySet<DecisionTrigger> = new Set<DecisionTrigger>([
  'damage_taken',
  'hp_changed',
  'mob_appeared',
  // Breath running out is the same class of safety event as an injury: a
  // semantic WHAT decision taken before the body started drowning must not
  // still authorize building/placing. It shares the `injury` family below
  // because drowning IS injury damage in progress - the air gauge is simply an
  // earlier, cheaper signal than the first drowning hit.
  'low_air',
  // A confirmed head-underwater reading with unavailable breath metadata is a
  // separate sensor safety event, not synthetic damage.
  'air_unknown_head_submerged',
])

type CriticalThreatFamily = 'injury' | 'breath' | 'mob'

function criticalThreatFamily(trigger: DecisionTrigger): CriticalThreatFamily {
  if (trigger === 'mob_appeared') return 'mob'
  if (trigger === 'low_air' || trigger === 'air_unknown_head_submerged') return 'breath'
  return 'injury'
}

export interface PendingDecision {
  record: DecisionRecord
  healthAtDecision: number
}

export interface DecisionEpochsHost {
  readonly actionEpochByLease: Map<number, { epoch: number; commitmentId: string; identity: string }>
  actionCommitmentState: ActionCommitmentState | null
  activeRetrieval: { id: string; resource: string; knownName: string; target: Vec3Json } | null
  readonly bot: Bot
  commitmentProgressEpoch: number
  chargeGuardRejection(record: DecisionRecord, code: GuardCode): void
  commitmentState: CandidateFlapState | null
  compressedSkillSteps: number
  conflictDeferrals: number
  currentGoalKey(): string
  currentOptionContext(): CurrentOptionContext | null
  readonly decisionEpochs: JevDecisionEpochs
  decisionWriter: JsonlWriter
  deferredTrigger: TriggerEvent | null
  emitSkillOutcomePacket(input: {
    actionId: string
    kind: CandidateKind
    /** the executor action lease epoch, or null when no lease was ever claimed */
    leaseEpoch: number | null
    status: string
    failure: string | null
    verified: boolean
    progressed: boolean
    itemsGained: number
    blockRemoved: boolean
    entityDefeated: boolean
    targetName: string | null
    candidate: Candidate | null
    verification: string
  }): SkillOutcomePacket
  escalate(reason: EscalationReason, detail: string): void
  executor: Executor
  goal: GoalState
  guardRejections: number
  lastSemanticProjection: JevSemanticProjection | null
  lastSkillOutcome: SkillOutcomePacket | null
  lastStateFingerprint: string
  logger: EventLogger
  logSmeltStationRetry(candidate: Candidate): void
  noteCandidateFailure(candidateId: string): void
  readonly optionAttempts: OptionAttemptTracker
  options: JevAgentOptions
  pendingTrigger: TriggerEvent | null
  readonly placementRetries: PlaceRetryLedger
  progressEpoch: number
  queue: GoalQueue
  recentEvents: string[]
  recentSkillOutcomes: SkillOutcomePacket[]
  recordFailure(code: FailureCode | GuardCode | string | null, detail: string): void
  recordMoveFailure(candidate: Candidate, reason: MoveFailureReason): void
  retrievalTrack: { id: string; best: number; ticks: number; bestGap?: number } | null
  skillOutcomeBoundary: boolean
  readonly tickCounter: number
  readonly waitStreakEscalation: WaitStreakEscalation
  waitSuppressed: boolean
  withheldCandidateIds: ReadonlySet<string>
  actionCommitmentPlanKey(state: WorldState): string
  candidateCommitCost(candidate: Candidate, index: number): number
  deterministicInvalid(candidates: readonly Candidate[], state: WorldState): ReadonlySet<string>
  jev: JevPolicy
  jevCalls: number
  lastJevAt: number
  lastDecision: JevResult | null
  lastDecisionId: string | null
  lastProjectionHash: string | null
  staleDecisionDropped: boolean
  lastAbandonAdopted: boolean
  policyEpoch: number
  issuedPolicyEpoch: number
  issuedCandidateHash: string
  readonly policyProvider: string
  signals: AgentSignals
  abandonVerdict(decision: JevResult, optionId: string | null, planId: string | null): AbandonVerdict
  applyAbandon(result: JevResult, verdict: AbandonVerdict): boolean
  logHeads(result: JevResult, verdict: AbandonVerdict, chainId: string | null): void
  logShadowMetrics(state: WorldState): void
  logBoundary(
    epoch: DecisionEpoch,
    reason: string,
    projection: JevSemanticProjection,
    hash: string,
    views: readonly SemanticCandidateView[],
    trigger: DecisionTrigger,
    sinceLastCallMs: number | null,
  ): void
  logEpochSuperseded(previous: DecisionEpoch | null): void
  buildSemanticProjection(state: WorldState, candidates: readonly Candidate[], mergedCandidates: number): JevSemanticProjection
  repointReplay(result: JevResult, views: readonly SemanticCandidateView[]): JevResult | null
  running: boolean
  modelRecoveryStopping: boolean
  ticking: boolean
  decisionTimer: NodeJS.Timeout | null
  lastTickAt: number
  liveAir(): number | null
  tick(trigger: DecisionTrigger, detail: Record<string, unknown>): Promise<void>
  requestDecision(trigger: DecisionTrigger, detail: Record<string, unknown>): void
  scheduleTick(event: TriggerEvent): void
}


/** A guard-level NO_PATH is a real movement failure, not merely a policy rejection. */
export function guardMoveFailureReason(
  candidate: Pick<Candidate, 'kind'> | undefined,
  code: GuardCode,
): MoveFailureReason | null {
  if (candidate === undefined || !isTrackedMoveKind(candidate.kind)) return null
  return code === 'NO_PATH' ? 'no_path' : null
}

export function jevLog(host: DecisionEpochsHost, decision: JevResult, dangerGate: GatedScore, trigger: DecisionTrigger): DecisionJevLog {
  return {
    policy: decision.policy,
    source: decision.source,
    model: decision.model,
    callId: decision.callId,
    latencyMs: decision.latencyMs,
    usage: decision.usage,
    answers: decision.answers,
    dangerGate,
    trigger,
  }
}

/**
 * #11 v2 §7: one candidate until a fact changes. While a flap window is
 * active the policy's raw choice is replaced by the cheap-feasible commitment;
 * a deterministic rejection releases it to the next cheapest feasible.
 */
export function applyCandidateCommitment(
  host: DecisionEpochsHost,
  chosenId: string,
  candidates: readonly Candidate[],
  state: WorldState,
): string {
  const progressed = host.progressEpoch !== host.commitmentProgressEpoch
  host.commitmentProgressEpoch = host.progressEpoch
  const offered: readonly FlapCandidate[] = candidates.map((candidate, index) => ({
    id: candidate.id,
    cost: host.candidateCommitCost(candidate, index),
  }))
  const decision = evaluateCandidateFlap({
    previous: host.commitmentState,
    chosenId,
    fingerprint: host.lastStateFingerprint,
    progressed,
    candidates: offered,
    invalid: host.deterministicInvalid(candidates, state),
  })
  host.commitmentState = decision.state
  if (decision.line !== null) {
    host.logger.warn(
      'policy',
      decision.line,
      { chosenId, committedId: decision.state.committedId, fingerprint: host.lastStateFingerprint },
      host.tickCounter,
    )
  }
  if (decision.releaseLine !== null) {
    host.logger.warn(
      'policy',
      decision.releaseLine,
      { chosenId, committedId: decision.state.committedId },
      host.tickCounter,
    )
  }
  return decision.chosenId
}

/** The caller's existing cost policy: a declared cost, else the generator order. */
export function candidateCommitCost(host: DecisionEpochsHost, candidate: Candidate, index: number): number {
  const cost = candidate.meta.cost
  if (typeof cost === 'number') return cost
  const prereqCost = candidate.meta.prereqCost
  if (typeof prereqCost === 'number') return prereqCost
  return index
}

/** Candidate ids deterministic feasibility has already rejected. */
export function deterministicInvalid(host: DecisionEpochsHost, candidates: readonly Candidate[], state: WorldState): ReadonlySet<string> {
  const invalid = new Set<string>(host.withheldCandidateIds)
  for (const candidate of candidates) {
    if (unreachableMove(candidate, state) !== null) invalid.add(candidate.id)
  }
  return invalid
}

/**
 * Action-lifecycle commitment: hold the action the executor is ALREADY running
 * for a bounded window instead of letting this decision cancel it via
 * `Executor.claim` (which cancels any different in-flight action first).
 *
 * This is the same authority invariant as the flap commitment: it can only
 * keep the action Jev already chose, or release to the raw choice - code never
 * substitutes a different candidate. `ACTION_COMMIT` is logged when a switch is
 * suppressed; `ACTION_PREEMPT` when the held action is released and replaced.
 */
export function applyActionCommitment(
  host: DecisionEpochsHost,
  chosenId: string,
  candidates: readonly Candidate[],
  state: WorldState,
): string {
  const running = host.executor.current
  const invalid = running === null ? null : host.deterministicInvalid(candidates, state)
  // SAFE: in melee contact a threat response must execute now. Code owns only
  // the contact fact and the kind test; the choice is still Jev's (the newer
  // one). Without this, the measured fight held the in-flight RETREAT while
  // Jev selected ATTACK three decisions in a row and the body never swung.
  const chosen = candidates.find((candidate) => candidate.id === chosenId) ?? null
  const contactThreatResponse =
    chosen !== null &&
    CONTACT_THREAT_KINDS.has(chosen.kind) &&
    state.entities.some((entity) => entity.hostile && entity.distance <= MELEE_THREAT_REACH)
  const decision = evaluateActionCommitment({
    previous: host.actionCommitmentState,
    inFlight:
      running === null
        ? null
        : { id: running.id, epoch: running.epoch, startedAtMs: running.startedAt },
    chosenId,
    planKey: host.actionCommitmentPlanKey(state),
    nowMs: Date.now(),
    inFlightInvalid: running !== null && invalid !== null && invalid.has(running.id),
    inFlightOffered: running !== null && candidates.some((candidate) => candidate.id === running.id),
    contactThreatResponse,
  })
  host.actionCommitmentState = decision.state
  if (decision.line !== null) {
    host.logger.warn(
      'policy',
      decision.line,
      { chosenId, heldId: decision.chosenId, planKey: host.actionCommitmentPlanKey(state) },
      host.tickCounter,
    )
  }
  if (decision.releaseLine !== null) {
    host.logger.warn(
      'policy',
      decision.releaseLine,
      { chosenId, heldId: null, planKey: host.actionCommitmentPlanKey(state) },
      host.tickCounter,
    )
  }
  return decision.chosenId
}

/** Plan/goal identity for the action commitment; a change resets it. */
export function actionCommitmentPlanKey(host: DecisionEpochsHost, state: WorldState): string {
  const current = state.goalQueue?.current
  return `${host.currentGoalKey()}|plan=${current?.id ?? 'none'}|rev=${state.goalQueue?.revision ?? host.queue.revision}`
}

/**
 * #327 follow-up: bound the chosen no-op WAIT while real actionable candidates
 * are offered. The policy model itself can keep choosing WAIT with several real
 * actions on the table; no existing counter sees that (`LOCAL_RECOVERY_*` only
 * advance on suppressed replans, `ACTION_FAILURE_*` only on typed action
 * failures, and the #43 WAIT wedge is suppressed when the junk-inventory
 * fingerprint churns every tick).
 *
 * On the Nth consecutive actionable WAIT the local recovery is exhausted:
 * `WAIT_EXHAUSTED` is logged, `progress_stall` wakes System2 through the same
 * `escalate()` path #326/#337 use, and WAIT is removed for exactly one decision
 * so the policy must choose a real candidate. The streak clears on any non-WAIT
 * choice, on `actionable === 0`, on a goal/plan change (inside the counter), on
 * progress (in `onActionComplete`), and on the Nth decision - so the next
 * escalation needs N fresh WAITs and no hot wake loop is possible. Its
 * fingerprint is exposed through `replanInputs()` so the #44 throttle cannot
 * swallow this one wake as `no_new_info`.
 */
export function noteWaitStreak(host: DecisionEpochsHost, chosenId: string, actionable: number): void {
  const goalKey = host.currentGoalKey()
  const decision = host.waitStreakEscalation.noteChoice(chosenId, actionable, goalKey)
  if (decision.count === 0) return
  const detail = {
    goal: goalKey,
    actionable,
    count: decision.count,
    limit: decision.limit,
  }
  if (!decision.escalate) {
    host.logger.warn('policy', formatWaitStreak(decision), detail, host.tickCounter)
    return
  }
  host.logger.warn('policy', formatWaitExhausted(decision), { ...detail, boundary: 'semantic_boundary' }, host.tickCounter)
  // Force the next decision to choose a real candidate, then reset so the
  // bound cannot hot-loop: N fresh WAITs are required before the next wake.
  host.waitSuppressed = true
  host.escalate(
    'progress_stall',
    `WAIT_EXHAUSTED count=${decision.count}/${decision.limit} goal=${goalKey} actionable=${actionable}`,
  )
  host.waitStreakEscalation.reset()
}

/**
 * #46 requirement 2: a placement failure at one spot is NOT an abandon. Log
 * PLACE_RETRY while the bounded attempts remain, then RETIRE the candidate
 * family with one typed `PLACE_RETRIES_EXHAUSTED` so it cannot be re-offered
 * forever. The ledger clamps the ordinal at limit+1 and the retired item set
 * is threaded into the candidate generator, which is what makes the limit
 * authoritative instead of advisory (measured live: count=18 against limit=5).
 */
export function schedulePlaceRetry(host: DecisionEpochsHost, result: ExecutionResult, candidate: Candidate): boolean {
  const at =
    candidate.target ??
    ({
      x: Math.floor(host.bot.entity.position.x),
      y: Math.floor(host.bot.entity.position.y),
      z: Math.floor(host.bot.entity.position.z),
    } satisfies Vec3Json)
  const item = candidate.itemName
  const decision = host.placementRetries.noteFailure({
    item,
    actionId: result.actionId,
    at,
    reason: result.failure ?? 'place_failed',
  })
  if (!decision.retry) {
    // The retire line is emitted exactly once by the ledger. If the ledger
    // already announced this family, keep the existing `retry_exhausted` audit
    // line for the repeated failure but never report the bound as still live.
    const line =
      decision.exhaustedLine ??
      `${PLACE_RETRIES_EXHAUSTED} at=${at.x},${at.y},${at.z} item=${item ?? 'unknown'} count=${decision.count}/${decision.limit} actionId=${result.actionId} reason=${result.failure} (already retired)`
    host.logger.warn(
      'agent',
      line,
      {
        actionId: result.actionId,
        item,
        count: decision.count,
        limit: decision.limit,
        reason: result.failure,
        retired: host.placementRetries.isItemRetired(item),
      },
      host.tickCounter,
    )
    return false
  }
  host.logger.warn(
    'agent',
    decision.line,
    { actionId: result.actionId, count: decision.count, limit: decision.limit, reason: result.failure },
    host.tickCounter,
  )
  return true
}

export function criticalArrivedDuringFlight(host: DecisionEpochsHost, trigger: DecisionTrigger): boolean {
  const pending = host.pendingTrigger
  const deferred = host.deferredTrigger
  const critical = [pending, deferred].find((event) => event !== null && CRITICAL_TRIGGERS.has(event.trigger))
  if (critical === undefined || critical === null) return false
  if (!CRITICAL_TRIGGERS.has(trigger)) return true
  return criticalThreatFamily(trigger) !== criticalThreatFamily(critical.trigger)
}

export function hasCriticalTriggerDuringFlight(host: DecisionEpochsHost): boolean {
  const pending = host.pendingTrigger
  const deferred = host.deferredTrigger
  return (
    (pending !== null && CRITICAL_TRIGGERS.has(pending.trigger)) ||
    (deferred !== null && CRITICAL_TRIGGERS.has(deferred.trigger))
  )
}

/**
 * §12: emit the three Jev-plane records for one decision - the epoch that owns
 * it, the projection hash/version Jev saw, and the stable candidate identities
 * offered. One line each, so the boundary is reconstructible from the log.
 */
export function logBoundary(
  host: DecisionEpochsHost,
  epoch: ReturnType<JevDecisionEpochs['begin']>,
  reason: string,
  projection: JevSemanticProjection,
  hash: string,
  views: readonly SemanticCandidateView[],
  trigger: DecisionTrigger,
  sinceLastCallMs: number | null,
): void {
  const change =
    reason === 'semantic_state_changed' && host.lastSemanticProjection !== null
      ? classifyProjectionChange(host.lastSemanticProjection, projection)
      : null
  // §6: `flap=true` means the semantic plane changed faster than
  // `minJevIntervalMs` - the gate is working as designed (a real semantic change
  // always re-queries) but the projection is quantized too finely for this
  // situation if it stays true. Evidence only; it never suppresses a query,
  // because replaying a genuinely changed semantic state would be exactly the
  // hidden-staleness §6 forbids. This is what keeps `minJevIntervalMs` a live
  // diagnostic instead of the dead rate-limit key it was before #437.
  const flap = sinceLastCallMs !== null && sinceLastCallMs < host.options.minJevIntervalMs
  host.logger.info(
    'policy',
    formatEpochStart(epoch, reason),
    {
      trigger,
      projectionHash: hash,
      ...(sinceLastCallMs === null ? {} : { sinceLastCallMs, flap }),
      ...(change ?? {}),
    },
    host.tickCounter,
  )
  host.logger.info('policy', formatJevStateProjection(projection, hash), { trigger }, host.tickCounter)
  host.logger.info('policy', formatJevCandidateSet(views), { trigger, offered: views.length }, host.tickCounter)
}

/**
 * §12: exactly one `JEV_DECISION_EPOCH_END` per epoch. An epoch that is
 * superseded by the next decision (rather than closed by an outcome packet)
 * still gets its end record, so `START`/`END` balance in the run log.
 */
export function logEpochSuperseded(host: DecisionEpochsHost, previous: DecisionEpoch | null): void {
  if (previous === null || !previous.closed) return
  host.logger.info('policy', formatEpochEnd(previous), {}, host.tickCounter)
}

/**
 * §4/§10: re-point a replayed decision at the current representative of the
 * SAME semantic identity (see `repointReplayedChoice`). Returns null when the
 * chosen identity is no longer offered, which means the semantic state really
 * did change and the caller must re-query rather than replay. Never changes the
 * choice: only its mechanical realization id.
 */
export function repointReplay(host: DecisionEpochsHost, result: JevResult, views: readonly SemanticCandidateView[]): JevResult | null {
  const choice = repointReplayedChoice(
    decisionIdFrom(result),
    host.lastSemanticProjection?.candidates ?? [],
    views,
  )
  if (choice.lost) return null
  if (!choice.repointed || choice.chosenId === null) return result
  const answer = result.answers.action
  if (answer === undefined) return result
  host.logger.info(
    'policy',
    `JEV_REPLAY_REPOINTED identity=${host.lastSemanticProjection?.candidates.find((view) => view.id === decisionIdFrom(result))?.identity ?? 'unknown'} from=${decisionIdFrom(result) ?? 'none'} to=${choice.chosenId}`,
    { trigger: 'semantic_boundary' },
    host.tickCounter,
  )
  return { ...result, answers: { ...result.answers, action: { ...answer, value: choice.chosenId } } }
}

/**
 * §2/§12: compress a settled Skill into ONE typed SkillOutcomePacket, store it
 * as the bounded previous-outcome context, and close the decision epoch it
 * belongs to. Pure evidence: it never chooses anything.
 */
export function emitSkillOutcomePacket(host: DecisionEpochsHost, input: {
  actionId: string
  kind: CandidateKind
  /** the executor action lease epoch, or null when no lease was ever claimed */
  leaseEpoch: number | null
  status: string
  failure: string | null
  verified: boolean
  progressed: boolean
  itemsGained: number
  blockRemoved: boolean
  entityDefeated: boolean
  targetName: string | null
  candidate: Candidate | null
  verification: string
}): SkillOutcomePacket {
  const binding = input.leaseEpoch === null ? null : host.actionEpochByLease.get(input.leaseEpoch) ?? null
  if (input.leaseEpoch !== null) host.actionEpochByLease.delete(input.leaseEpoch)
  const option = host.currentOptionContext()
  const target =
    input.candidate === null
      ? { kind: 'none' as const, key: input.targetName ?? 'unknown', label: input.actionId }
      : semanticTargetRef(input.candidate)
  const deltas: SemanticDelta[] = []
  if (input.blockRemoved) {
    deltas.push({ fact: 'block.removed', from: null, to: input.targetName ?? input.actionId })
  }
  if (input.itemsGained > 0) deltas.push({ fact: 'inventory.gained', from: 0, to: input.itemsGained })
  if (input.entityDefeated) {
    deltas.push({ fact: 'target.entity', from: `e${input.candidate?.targetEntityId ?? -1}`, to: 'dead' })
  }
  const facts: GroundedFact[] = []
  if (input.failure === 'target_gone') {
    facts.push({
      kind: 'target',
      key: target.key,
      detail: 'the selected target is no longer present (TARGET_LOST, not killed)',
    })
  }
  if (input.failure === 'drop_not_acquired' && input.entityDefeated) {
    facts.push({
      kind: 'target',
      key: target.key,
      detail: 'the selected entity was verified dead, but its declared HUNT_DROP item was not acquired',
    })
    const goalDrop = input.candidate?.meta.goalDrop
    if (typeof goalDrop === 'string') {
      facts.push({
        kind: 'resource',
        key: `inventory:${goalDrop}`,
        detail: `this hunt lease gained no ${goalDrop} in the body inventory`,
      })
    }
  }
  const packet = buildSkillOutcomePacket({
    decisionEpoch: binding?.epoch ?? host.decisionEpochs.active?.epoch ?? 0,
    commitmentId:
      binding?.commitmentId ??
      (input.leaseEpoch === null
        ? `g:${input.actionId}`
        : commitmentRefFor({ candidateId: input.actionId, epoch: input.leaseEpoch })),
    optionInstanceId: option?.instanceId ?? null,
    selectedCandidateId: input.actionId,
    skillKind: input.kind,
    targetIdentity: target,
    status: input.status,
    failure: input.failure,
    verified: input.verified,
    postcondition: input.verification,
    verificationDetail: input.verification,
    progressDelta: input.verified ? Math.max(0, input.itemsGained + (input.blockRemoved ? 1 : 0)) : 0,
    progressed: input.progressed,
    searchProgress: input.failure === 'drop_not_acquired' && input.entityDefeated,
    meaningfulWorldDelta: deltas,
    newFacts: facts,
    optionComplete: host.goal.complete === true,
    compressedSteps: host.compressedSkillSteps,
  })
  host.recentSkillOutcomes.push(packet)
  if (host.recentSkillOutcomes.length > 3) host.recentSkillOutcomes.shift()
  host.lastSkillOutcome = packet
  // §6: target/capability/safety/world/lease outcomes destroy the premise of the
  // previous decision, so policy must be re-asked. A repeated mechanical blocker
  // is carried by the projection instead (no per-retry Jev call).
  host.skillOutcomeBoundary = mandatoryPolicyBoundary(packet.terminalReason)
  host.compressedSkillSteps = 0
  host.logger.info(
    'agent',
    formatSkillOutcomePacket(packet),
    {
      actionId: input.actionId,
      terminalReason: packet.terminalReason,
      progress: packet.semanticProgress.kind,
      delta: packet.meaningfulWorldDelta.length,
      nextDecisionRequired: packet.nextDecisionRequired,
    },
    host.tickCounter,
  )
  const closed = host.decisionEpochs.close({ epoch: packet.decisionEpoch, reason: packet.terminalReason })
  if (closed !== null) {
    host.logger.info('policy', formatEpochEnd(closed), { actionId: input.actionId }, host.tickCounter)
  }
  return packet
}

export function onGuardReject(
  host: DecisionEpochsHost,
  guarded: Extract<GuardResult, { ok: false }>,
  decision: JevResult,
  record: DecisionRecord,
  candidate: Candidate | undefined,
): void {
  attachResult(record, {
    actionId: guarded.candidateId,
    success: false,
    durationMs: 0,
    damageTaken: 0,
    progress: host.goal.progress,
    status: 'guard-rejected',
    failureCode: guarded.code,
    verified: false,
    blockRemoved: false,
    dropObserved: false,
  })
  host.decisionWriter.write(record)
  if (guarded.code === 'CONFLICT_IN_FLIGHT') {
    // expected: the in-flight action keeps ownership, the new mine waits
    host.conflictDeferrals += 1
    host.logger.info(
      'guard',
      `deferred ${guarded.candidateId} -> ${guarded.reason}`,
      { code: guarded.code, decisionCallId: decision.callId, chainId: record.chainId },
      host.tickCounter,
    )
    return
  }
  host.guardRejections += 1
  host.logger.warn(
    'guard',
    `REJECTED ${guarded.candidateId} code=${guarded.code} :: ${guarded.reason}`,
    { code: guarded.code, policy: decision.policy, callId: decision.callId, chainId: record.chainId },
    host.tickCounter,
  )
  // The `guard` category is not part of the mirrored agent stream, so without
  // this line a selected candidate that the guard drops leaves no diagnosable
  // trace at all (see ACTION_REJECTED in policy.ts). Emit the typed cause on
  // the mirrored path with the same candidate id, code and reason.
  host.logger.warn(
    'agent',
    formatActionRejected(guarded.candidateId, guarded.code, guarded.reason),
    {
      actionId: guarded.candidateId,
      code: guarded.code,
      reason: guarded.reason,
      policy: decision.policy,
      callId: decision.callId,
      chainId: record.chainId,
    },
    host.tickCounter,
  )
  host.recentEvents.push(`guard ${guarded.code} on ${guarded.candidateId}`)
  host.noteCandidateFailure(guarded.candidateId)
  const movementFailure = guardMoveFailureReason(candidate, guarded.code)
  if (candidate !== undefined && movementFailure !== null) host.recordMoveFailure(candidate, movementFailure)
  if (candidate !== undefined) host.logSmeltStationRetry(candidate)
  host.chargeGuardRejection(record, guarded.code)
  host.recordFailure(guarded.code, guarded.reason)
  // §2: a deterministic guard refusal is a settled typed outcome of THIS
  // selection, so it crosses the boundary as a packet (never as a silent drop).
  host.emitSkillOutcomePacket({
    actionId: guarded.candidateId,
    kind: candidate?.kind ?? 'WAIT',
    leaseEpoch: null,
    status: 'guard-rejected',
    failure: guarded.code,
    verified: false,
    progressed: false,
    itemsGained: 0,
    blockRemoved: false,
    entityDefeated: false,
    targetName: candidate?.targetName ?? null,
    candidate: candidate ?? null,
    verification: 'rejected_before_execution',
  })
}

/**
 * #79: a mechanical guard rejection is a settled zero-progress outcome for the
 * option that was just chosen. A rejected candidate never reaches
 * `onActionComplete`, which is the only other place the unproductive counter
 * is fed, so without this a permanently rejected option stays at `attempts=0`
 * and its abandon request is suppressed as "speculative" forever
 * (`abandonEnforced=false`). Charging it here lets the bounded attempt limit
 * retire the option with `reason=unproductive`.
 */
export function chargeGuardRejection(host: DecisionEpochsHost, record: DecisionRecord, code: GuardCode): void {
  if (!guardRejectionChargesOption(code)) return
  const optionId = record.optionId
  if (optionId === null || optionId.length === 0) return
  host.optionAttempts.noteOutcome(
    {
      optionId,
      planId: record.goalQueueState.current?.id ?? null,
      verified: false,
      progressDelta: 0,
    },
    Date.now(),
  )
}

/**
 * issue #436 section 4: stamp the selection provenance onto the candidate the
 * executor will claim. `selectedBy` is honest about which policy chose it, the
 * epoch ties the commitment to the decision that authorized it, and the world
 * epoch is what a later lifecycle revalidation compares against.
 */
export function stampSelectionProvenance(host: DecisionEpochsHost, candidate: Candidate, decision: JevResult, record: DecisionRecord): Candidate {
  const optionInstanceId = record.semanticOptionInstanceId ?? record.optionId ?? null
  return {
    ...candidate,
    meta: {
      ...candidate.meta,
      decisionEpoch: host.decisionEpochs.active?.epoch ?? 0,
      decisionId: decision.callId,
      selectedBy: decision.policy === 'typesafe' ? 'jev' : 'deterministic',
      stateFingerprint: record.stateHash,
      worldEpoch: host.options.worldEpoch,
      ...(optionInstanceId === null ? {} : { optionInstanceId }),
    },
  }
}

/**
 * issue #436 section 14/23: the running commitment's contract can be broken by
 * the world it was grounded in, independently of any target-claim
 * contradiction: the dimension changed, or the host's world epoch moved.
 *
 * This is deterministic cancellation, never a recovery: the commitment's
 * `CausalTargetIdentity` is meaningless in another world, so the action is
 * CANCELLED with the typed `WORLD_CHANGED` outcome (`SKILL_INVALIDATED`, then
 * the ordinary `SKILL_OUTCOME_PACKET`/`SKILL_END` close it). Code does not pick
 * a replacement target; the tick continues to Jev, which owns WHICH is next.
 */
export function cancelInvalidCommitment(host: DecisionEpochsHost, state: WorldState): void {
  const running = host.executor.current
  const commitment = running?.commitment ?? null
  if (running === null || commitment === null) return
  const observedDimension = typeof state.self.dimension === 'string' ? state.self.dimension : 'unknown'
  const reason = commitmentInvalidation({
    commitment,
    observedDimension,
    observedWorldEpoch: host.options.worldEpoch,
    // The actuation lease is the HOST's: a revoked lease already aborts this
    // action through `ensureOwned` and settles it LEASE_REVOKED.
    leaseHeld: true,
  })
  if (reason === null) return
  host.executor.cancelCurrent(`commitment ${commitment.commitmentId} invalidated (${reason})`)
  host.logger.warn(
    'agent',
    formatSkillInvalidated({
      commitmentId: commitment.commitmentId,
      decisionEpoch: commitment.decisionEpoch,
      skillKind: commitment.skillKind,
      candidateId: commitment.candidateId,
      reason,
      targetKey: targetIdentityKey(commitment.target),
      observedDimension,
      observedWorldEpoch: host.options.worldEpoch,
      detail: 'live commitment revalidation at the tick boundary',
    }),
    {
      actionId: commitment.candidateId,
      commitmentId: commitment.commitmentId,
      reason,
      observedDimension,
      observedWorldEpoch: host.options.worldEpoch,
    },
    host.tickCounter,
  )
}

export function mobIdentityContext(
  host: DecisionEpochsHost,
  chosen: Candidate | null,
  decisionState: WorldState,
  freshState: WorldState,
): MobIdentityContext {
  const entityId = chosen?.targetEntityId ?? null
  let previousEntityTracked: boolean | null = null
  if (entityId !== null) {
    const live = host.bot.entities[entityId]
    previousEntityTracked = live !== undefined && live.isValid !== false
  }
  return {
    previousEntityTracked,
    knownEntityIds: new Set(decisionState.entities.map((entity) => entity.id)),
    chosenAtMs: decisionState.timestampMs,
    nowMs: freshState.timestampMs,
  }
}

export function reflexDecision(host: DecisionEpochsHost, candidate: Candidate): JevResult {
  return {
    callId: `reflex:${randomUUID()}`,
    policy: 'reflex',
    source: 'reflex',
    model: 'hard_safety_reflex',
    latencyMs: 0,
    usage: null,
    answers: {
      action: {
        name: 'action',
        type: 'choice',
        value: candidate.id,
        probability: 1,
        confidence: 1,
        probabilities: null,
        legend: null,
        note: 'uniquely-determined hard-safety reflex (issue #436 section B)',
      },
    },
  }
}

/**
 * #436 section E (deterministic cancellation / failure):
 *
 *   "observed world state contradicts the claimed postcondition -> never report
 *    success"; "selected block changed into another block -> stop + re-observe";
 *    "selected entity despawned / identity invalidated -> stop + typed
 *    target-gone outcome"; "No deterministic failure branch may silently choose
 *    a different semantic objective."
 *
 * The RUNNING known-resource skill is grounded on the remembered cell's claim
 * (the block is there / a producer is there / the drop is there). When the state
 * this tick PROVED that claim false, the skill is CANCELLED with a typed
 * outcome - it is never silently re-pointed at another cell or another item.
 * The tick then continues to Jev, which owns WHICH action comes next.
 *
 * The boundaries that keep this a truth rule and not a retry policy:
 *   - only `falsified` (a real contradiction) cancels. `unknown` (unloaded
 *     chunk / outside the entity envelope) is not a verdict and a merely
 *     UNREACHABLE target keeps the existing bounded `decideKnownRetrieve`
 *     retry/retire - a side-effect-free transient failure may be retried inside
 *     its explicit bound;
 *   - a cancelled skill is never restarted by code: the falsified cell is
 *     withheld from `signals.knownResources`, so only a real re-sighting can
 *     put it back in front of Jev;
 *   - when the side-effect state is unknown, nothing here retries blindly.
 */
export function cancelContradictedSkillTarget(host: DecisionEpochsHost, state: WorldState): void {
  const active = host.activeRetrieval
  if (active === null) return
  const running = host.executor.current
  if (running === null || running.id !== active.id) return
  const contradiction = (state.knownResourceEvidence ?? []).find(
    (evidence) =>
      evidence.status === 'falsified' &&
      evidence.position.x === active.target.x &&
      evidence.position.y === active.target.y &&
      evidence.position.z === active.target.z,
  )
  if (contradiction === undefined) return
  const reason: 'contradicted' | 'target_gone' =
    contradiction.reason === 'mob_gone' ? 'contradicted' : 'target_gone'
  const failure = contradiction.reason ?? 'falsified'
  const cancelled = host.executor.cancelCurrent(`contradicted target ${active.id} (${failure})`)
  host.logger.warn(
    'agent',
    // The canonical #436 vocabulary (netherPortalPlan.ts): a Skill that ended
    // because the world contradicted the state its postcondition was grounded
    // on, with the typed failure code.
    formatSkillEnd(KNOWN_RETRIEVE_SKILL, 'cancelled', 'failed', `${contradiction.claim}_present`, failure),
    {
      actionId: active.id,
      item: active.resource,
      name: active.knownName,
      cell: active.target,
      claim: contradiction.claim,
      observed: contradiction.observed,
      cancelled,
    },
    host.tickCounter,
  )
  host.logger.warn(
    'agent',
    formatSkillInterrupt(KNOWN_RETRIEVE_SKILL, reason),
    { actionId: active.id, item: active.resource, cell: active.target, reason: failure },
    host.tickCounter,
  )
  host.activeRetrieval = null
  host.retrievalTrack = null
}


/** Pick the CORE + trigger-specific question set (P1-7). */
export function questionSetForTrigger(trigger: DecisionTrigger): QuestionSetKind {
  if (CRITICAL_TRIGGERS.has(trigger)) return 'threat'
  if (STALL_TRIGGERS.has(trigger)) return 'stall'
  return 'core'
}

const STALL_TRIGGERS: ReadonlySet<DecisionTrigger> = new Set<DecisionTrigger>([
  'path_stuck',
  'path_no_path',
  'action_timeout',
])

// ---------------------------------------------------------------------------
// The decision epoch's own orchestration (moved from controller.ts):
// semantic-boundary classification, replay-vs-requery, the Jev policy call,
// stale-epoch drop, verdict application and the low-confidence escalation.
// The policy call itself (host.jev.decide) and every boundary verdict remain
// unchanged.
// ---------------------------------------------------------------------------

export async function decide(
  host: DecisionEpochsHost,
  state: WorldState,
  candidates: readonly Candidate[],
  trigger: DecisionTrigger,
  chainId: string,
): Promise<JevResult> {
  host.lastAbandonAdopted = false
  const now = Date.now()
  const stateHash = stableStateHash(state)
  // §6 rate evidence. The raw-state reuse key (`stateHash ===
  // host.lastDecisionStateHash`) is GONE: `stableStateHash` covers `tick`, the
  // float body position and the per-tick `recentEvents`, so it changed every
  // tick and the old gate effectively never fired. The semantic projection hash
  // below is the reuse key now; `sinceLastCallMs` only reports how fast the
  // semantic plane is moving.
  const sinceLastCallMs = host.lastJevAt === 0 ? null : now - host.lastJevAt
  const identityContext = {
    optionInstanceId: optionIdForGoal(state.goalQueue.current) ?? state.currentOption?.instanceId ?? null,
    dimension: state.self.dimension,
    worldEpoch: host.options.worldEpoch,
  }
  // §4/§8: the semantic offer - stable identities, mechanically-equivalent
  // realizations collapsed. The controller keeps the FULL grounded set for
  // guard/commitment/execution; only the model's choice set is deduped, and
  // every representative id below is a real member of that full set.
  const dedupe = dedupeSemanticCandidates(candidates, identityContext, (candidateId) =>
    failureCount(state.signals.failedCandidates, candidateId),
  )
  const projection = host.buildSemanticProjection(state, candidates, dedupe.merged)
  // The projection's own candidate views are the single source of truth for the
  // hash, the log and the offer: one identity function, no drift.
  const views = projection.candidates
  const hash = semanticProjectionHash(projection)
  const candidateIdentities = views.map((view) => view.identity)

  // §3: a world/epoch change invalidates the ACTIVE epoch, so a result
  // attributed to it can no longer authorize a commitment.
  if (!host.decisionEpochs.matchesWorld({ dimension: state.self.dimension, worldEpoch: host.options.worldEpoch })) {
    const invalidated = host.decisionEpochs.invalidate('world_changed')
    if (invalidated !== null) {
      host.logger.warn(
        'policy',
        formatStaleResultDropped(invalidated.epoch, null, 'world_or_epoch_changed'),
        { projectionHash: invalidated.projectionHash, dimension: state.self.dimension },
        host.tickCounter,
      )
    }
  }

  // §6/§9: re-query only at a semantic boundary. A settled mechanical step with
  // an unchanged semantic projection is NOT a policy event, so the previous
  // decision is replayed inside a NEW epoch: causal isolation is preserved (the
  // replay is attributed to the current epoch, never to the stale one), and no
  // model call is spent on an identical semantic state.
  const boundary = classifySemanticBoundary({
    active: host.decisionEpochs.active,
    projectionHash: hash,
    candidateIdentities,
    worldKey: { dimension: state.self.dimension, worldEpoch: host.options.worldEpoch, leaseHeld: true },
    optionKey: projection.option.instanceId,
    safetyKey: JSON.stringify(projection.safety),
    goalKey: projection.goal.key,
    lastOutcomeRequiredDecision: host.skillOutcomeBoundary,
  })
  // §4/§10: the cached decision names the realization that was representative
  // when the model chose. Identity is stable, the realization id is mechanical,
  // so the SAME semantic choice is re-pointed at the current representative. If
  // the chosen identity is gone the state genuinely changed -> re-query below
  // instead of replaying an unusable decision.
  const replayed = host.lastDecision === null ? null : host.repointReplay(host.lastDecision, views)
  if (!boundary.requery && replayed !== null) {
    const previousActive = host.decisionEpochs.active
    const reusedFrom = previousActive?.epoch ?? null
    const epoch = host.decisionEpochs.begin({
      projectionHash: hash,
      candidateIdentities,
      dimension: state.self.dimension,
      worldEpoch: host.options.worldEpoch,
      nowMs: now,
      cacheHit: true,
      reusedFrom,
    })
    host.logEpochSuperseded(previousActive)
    host.logBoundary(epoch, boundary.reason, projection, hash, views, trigger, sinceLastCallMs)
    host.lastSemanticProjection = projection
    host.lastProjectionHash = hash
    host.skillOutcomeBoundary = false
    host.lastDecision = replayed
    return replayed
  }

  try {
    host.policyEpoch += 1
    host.issuedPolicyEpoch = host.policyEpoch
    host.issuedCandidateHash = candidateIdentities.join('|')
    const previousActive = host.decisionEpochs.active
    const epoch = host.decisionEpochs.begin({
      projectionHash: hash,
      candidateIdentities,
      dimension: state.self.dimension,
      worldEpoch: host.options.worldEpoch,
      nowMs: now,
    })
    host.logEpochSuperseded(previousActive)
    host.logBoundary(epoch, boundary.reason, projection, hash, views, trigger, sinceLastCallMs)
    host.lastSemanticProjection = projection
    host.lastProjectionHash = hash
    host.skillOutcomeBoundary = false
    // issue #436 section 3: `candidates.length === 1` is deliberately NOT a
    // Jev bypass here. A superficially single remaining candidate does not prove
    // there is no semantic choice (generation may be incomplete, the active
    // Option may be stale, and beta still owns semantic termination), so policy
    // is consulted on every decision regardless of the candidate count. The only
    // deterministic authority classes are a selected Skill's mechanical
    // continuation / DONE / hard safety / the U1..U6 prerequisite contract, and
    // each of those is recorded by the executor's `SKILL_STEP authority=`.
    const result = await host.jev.decide({
      stage: `policy-tick-${host.tickCounter}-${trigger}`,
      state,
      // §8: Jev sees one representative per semantic identity. The controller's
      // own `candidates` stays complete, so guard/commitment resolution and the
      // executor are unchanged.
      candidates: dedupe.offered,
      semanticProjection: projection,
      projectionHash: hash,
      questionNames: questionNamesFor(questionSetForTrigger(trigger)),
    })
    if (host.options.recoveryPolicyAuthority !== undefined && host.options.recoveryPolicyAuthority !== null) {
      assertRecoveryModelAuthority(
        host.options.recoveryPolicyAuthority,
        { provider: host.policyProvider, model: result.model },
        result.source,
      )
    }
    host.jevCalls += 1
    host.lastJevAt = Date.now()
    host.lastDecision = result
    host.lastDecisionId = decisionIdFrom(result)
    host.signals.lastPolicyConfidence = result.answers.action?.confidence ?? null

    // §3: only the ACTIVE epoch may authorize. A result whose epoch was
    // invalidated while the model call was in flight is DROPPED here, before
    // any commitment is claimed.
    const acceptance = host.decisionEpochs.accept(epoch.epoch)
    if (!acceptance.accepted) {
      host.staleDecisionDropped = true
      host.logger.warn(
        'policy',
        formatStaleResultDropped(epoch.epoch, host.decisionEpochs.active?.epoch ?? null, acceptance.reason),
        { trigger, callId: result.callId, chosen: host.lastDecisionId },
        host.tickCounter,
      )
      return result
    }

    const chosen = dedupe.offered.find((candidate) => candidate.id === host.lastDecisionId)
    host.logger.info(
      'policy',
      `trigger=${trigger} -> action=${host.lastDecisionId ?? 'none'} kind=${chosen?.kind ?? 'unknown'} | ${chosen?.label ?? 'no matching candidate'}`,
      {
        trigger,
        source: result.source,
        policy: result.policy,
        model: result.model,
        callId: result.callId,
        chainId,
        projectionHash: hash,
        decisionEpoch: epoch.epoch,
        latencyMs: result.latencyMs,
        inputTokens: result.usage?.inputTokens ?? null,
        actionConfidence: result.answers.action?.confidence ?? null,
        dangerScore: result.answers.danger?.value ?? null,
        dangerConfidence: result.answers.danger?.confidence ?? null,
        shouldRetreat: result.answers.should_retreat?.probability ?? null,
        abandonOption: result.answers.abandon_option?.probability ?? null,
      },
      host.tickCounter,
    )
    const planGoal = state.goalQueue.current
    const optionId = optionIdForGoal(planGoal)
    const planId = planRevisionForGoal(planGoal)
    const verdict = host.abandonVerdict(result, optionId, planId)
    host.logHeads(result, verdict, chainId)
    host.logShadowMetrics(state)
    host.lastAbandonAdopted = host.applyAbandon(result, verdict)

    const confidence = result.answers.action?.confidence
    if (typeof confidence === 'number' && confidence < host.options.lowConfidenceThreshold) {
      host.escalate(
        'low_confidence',
        `action confidence ${confidence} < ${host.options.lowConfidenceThreshold} for ${host.lastDecisionId ?? 'none'}`,
      )
    }
    return result
  } catch (error) {
    const fatal = error instanceof FatalModelError ? error : new FatalModelError('jev-policy', 1, describeFailure(error))
    return failLoud(fatal, (event, detail) => host.logger.error('policy', event, { trigger, ...(detail ?? {}) }, host.tickCounter), host.options.terminateOnModelFailure)
  }
}

// ---------------------------------------------------------------------------
// Trigger scheduling (moved from controller.ts): priority coalescing,
// RETREAT/ATTACK lease defer/preempt, macrotask-spaced tick dispatch.
// ---------------------------------------------------------------------------

/**
 * Per-lease absorbed-hit count for the RETREAT damage deferral, keyed on the
 * in-flight action object itself: a lease that keeps running keeps its count,
 * a revoked/re-committed lease (new object) starts fresh, and the entry is
 * collected when the action is. See `RETREAT_DEFER_HIT_BUDGET` in scheduler.ts.
 */
const retreatLeaseAbsorbedHits = new WeakMap<object, number>()

export function requestDecision(host: DecisionEpochsHost, trigger: DecisionTrigger, detail: Record<string, unknown>): void {
  if (!host.running || host.modelRecoveryStopping) return
  const event: TriggerEvent = { trigger, detail, ts: Date.now() }
  if (host.ticking) {
    if (trigger !== 'heartbeat') host.pendingTrigger = pickHigherPriority(host.pendingTrigger, event)
    return
  }
  const inFlight = host.executor.current
  if (inFlight !== null) {
    // A RETREAT is already the selected safety response. Controller-only
    // reground requests and real hit/health events wait for its bounded Skill
    // to finish; action completion will either supersede stale repair or
    // replay real damage with its normal preemptive priority. The deferral is
    // hit-budgeted per lease (`RETREAT_DEFER_HIT_BUDGET`): every absorbed hit
    // is proof the retreat is not separating, so the budget exhausts and the
    // next hit preempts while hp is still survivable. Keyed on the action
    // object itself, so a revoked/re-committed lease gets a fresh budget and
    // a lease that keeps running keeps its count.
    const absorbedHits = retreatLeaseAbsorbedHits.get(inFlight) ?? 0
    if (shouldDeferTriggerDuringRetreatLease(trigger, inFlight.kind, host.bot.health, CRITICAL_COMBAT_HEALTH, absorbedHits)) {
      if (trigger === 'damage_taken' || trigger === 'hp_changed') {
        retreatLeaseAbsorbedHits.set(inFlight, absorbedHits + 1)
      }
      host.deferredTrigger = pickHigherPriority(host.deferredTrigger, event)
      host.logger.info(
        'scheduler',
        `trigger=${trigger} deferred during RETREAT lease#${inFlight.epoch} ${inFlight.id}`,
        detail,
        host.tickCounter,
      )
      return
    }
    // A breath-escape swim is the drowning response: the air/damage signals it
    // exists to resolve must not cancel each leg before it can gain altitude.
    // Everything else (new mobs, action timeout) keeps its preemptive path.
    if (shouldDeferTriggerDuringBreathEscapeLease(trigger, inFlight.id)) {
      host.deferredTrigger = pickHigherPriority(host.deferredTrigger, event)
      host.logger.info(
        'scheduler',
        `trigger=${trigger} deferred during breath-escape lease#${inFlight.epoch} ${inFlight.id}`,
        detail,
        host.tickCounter,
      )
      return
    }
    if (PREEMPTIVE_TRIGGERS.has(trigger)) {
      // ATTACK is a Jev-selected combat lease.  Damage/entity events are
      // expected while the selected attack is being aimed and delivered;
      // asking Jev again on every hit cancels the attack before its next
      // cooldown and lets a nearby zombie turn the agent into a MOVE/WAIT
      // loop.  Keep the selected attack mechanics together and replay the
      // highest-priority threat trigger immediately after the short lease.
      if (inFlight.kind === 'ATTACK') {
        const air = host.liveAir()
        if (shouldPreemptActiveActionLease(trigger, inFlight.kind, host.bot.health, CRITICAL_COMBAT_HEALTH, air)) {
          host.logger.warn(
            'scheduler',
            `trigger=${trigger} interrupts ATTACK lease#${inFlight.epoch} ${inFlight.id} at critical health=${host.bot.health} air=${air}`,
            detail,
            host.tickCounter,
          )
          host.scheduleTick(event)
          return
        }
        host.deferredTrigger = pickHigherPriority(host.deferredTrigger, event)
        host.logger.info(
          'scheduler',
          `trigger=${trigger} deferred during ATTACK lease#${inFlight.epoch} ${inFlight.id}`,
          detail,
        )
        return
      }
      host.logger.info(
        'scheduler',
        `trigger=${trigger} preempts action#${inFlight.epoch} ${inFlight.id}`,
        detail,
        host.tickCounter,
      )
      host.scheduleTick(event)
      return
    }
    host.deferredTrigger = pickHigherPriority(host.deferredTrigger, event)
    host.logger.info(
      'scheduler',
      `trigger=${trigger} deferred while action#${inFlight.epoch} ${inFlight.id} is in flight`,
      detail,
      host.tickCounter,
    )
    return
  }
  host.scheduleTick(event)
}

export function scheduleTick(host: DecisionEpochsHost, event: TriggerEvent): void {
  if (host.decisionTimer !== null) {
    host.pendingTrigger = pickHigherPriority(host.pendingTrigger, event)
    return
  }
  const elapsed = Date.now() - host.lastTickAt
  const delay = Math.max(0, host.options.minDecisionIntervalMs - elapsed)
  host.decisionTimer = setTimeout(() => {
    host.decisionTimer = null
    const queued = host.pendingTrigger
    host.pendingTrigger = null
    const next = queued === null ? event : pickHigherPriority(event, queued)
    void host.tick(next.trigger, next.detail)
  }, delay)
}

export function clearDecisionTimer(host: DecisionEpochsHost): void {
  if (host.decisionTimer !== null) {
    clearTimeout(host.decisionTimer)
    host.decisionTimer = null
  }
}

export function drainPending(host: DecisionEpochsHost): void {
  if (!host.running) return
  const pending = host.pendingTrigger
  host.pendingTrigger = null
  if (pending !== null) {
    host.requestDecision(pending.trigger, pending.detail)
    return
  }
  const deferred = host.deferredTrigger
  host.deferredTrigger = null
  if (deferred !== null) host.requestDecision(deferred.trigger, deferred.detail)
}
