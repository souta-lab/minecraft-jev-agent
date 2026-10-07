// Legacy GoalQueue lifecycle plane extracted from controller.ts.
// Owns queue synchronization, head/dimension/identity reconciliation,
// protected-goal retire reasons and queue diagnostics. In V4 the
// GoalQueue is a compatibility/debug projection, not semantic truth -
// this module is the legacy surface that keeps that projection fed.
// No authority moves: System2 summon still crosses host.summonLlm and
// world truth still crosses the narrow evaluator methods on the host.
import { formatJevHeads } from './betaAuthority.ts'
import type { JevAgentOptions } from './controller-shared.ts'
import type { BetaAuthorityDecision } from './betaAuthority.ts'
import type { AbandonClassification, OptionAttemptTracker } from './abandonPolicy.ts'
import { formatSurfaceAscentRefused, surfaceAscentRouteless } from './candidates.ts'
import type { NotExecutableHereBinding, SurfaceAscentRefusal } from './candidates.ts'
import { optionIdForGoal } from './causal.ts'
import type { SensorOptionSlice } from './controller-shared.ts'
import type { DecisionLlmResummonLog, DecisionSubgoalLog } from './decisionlog.ts'
import { smeltInputFor } from './gameData.ts'
import { formatNonProgressEscalated, formatNonProgressYield, formatPlanIdentity, formatPlanIdentityChanged, formatRowDeferredNotExecutableHere, formatRowNotExecutableHere, notExecutableReplanRequest, planReplanRequest } from './goalQueue.ts'
import type { GoalQueue, PlannedGoal, PlanIdentity, QueuedGoal } from './goalQueue.ts'
import { evaluateGoalSuccess } from './goalSuccess.ts'
import { evaluateSpatialPredicate, predicateForGoal } from './predicateGoal.ts'
import { goalResourceMatches, resourceMatches } from './resourceClass.ts'
import type { GoalSuccessWorldProbe, RecordedPortalSite } from './goalSuccess.ts'
import { ACTION_DECLINE_LABEL, abandonRequested, actionDeclined, decisionIdFrom } from './jev.ts'
import type { EventLogger, JevResult } from './jev.ts'
import type { JevSemanticProjection, PreviousDecisionFacts, SkillOutcomePacket } from './jev/semantic-projection.ts'
import { FLINT_AND_STEEL, IRON_INGOT, PORTAL_ENTERED_PREDICATE, PORTAL_LIT_PREDICATE } from './netherPortalPlan.ts'
import type { PortalFrameSite } from './netherPortalPlan.ts'
import { compilePlannedGoal, currentOptionContextForQueuedGoal, evaluatePredicates, queuedToPlanned } from './optionSpec.ts'
import type { CurrentOptionContext, OptionWorldSnapshot } from './optionSpec.ts'
import { formatAbandonReason } from './placementGuard.ts'
import type { AbandonReason } from './placementGuard.ts'
import type { PredicateEvaluation } from './predicateGoal.ts'
import type { ActionFailureEscalation, ReplanInputs, WaitStreakEscalation } from './replanThrottle.ts'
import type { DecisionTrigger } from './scheduler.ts'
import { bodyStarving, distance } from './state.ts'
import type { AgentSignals, GoalState, Vec3Json, WorldState } from './state.ts'
import type { LlmSummonReason, System2Outcome } from './system2/service.ts'
import type { DigMemory } from './worldMemory.ts'
import type { Bot } from 'mineflayer'
import { join } from 'node:path'

export interface GoalQueuePlaneHost {
  abandonReason(actionId: string, beta: number | null): AbandonReason
  readonly actionFailureEscalation: ActionFailureEscalation
  readonly bot: Bot
  capabilityGapActive: boolean
  capabilityGapSignature: string | null
  countItem(name: string): number
  currentDimension(): string
  currentGoalKey(): string
  descendHaveBaseline: number
  readonly digMemory: DigMemory
  effectiveHave(): number
  evaluateDescendGoal(goal: QueuedGoal): PredicateEvaluation | null
  goal: GoalState
  goalWorldProbe(): GoalSuccessWorldProbe
  harvestedGoalCount: number
  inventorySnapshot(): Record<string, number>
  lastDecisionId: string | null
  lastProgress: number
  lastProgressAt: number
  lastSemanticProjection: JevSemanticProjection | null
  lastSkillOutcome: SkillOutcomePacket | null
  lastSurfaceAscentRefusal: SurfaceAscentRefusal | null
  lastSurfaceAscentRefusalKey: string | null
  lastSurfaceAscentRouteless: boolean
  lastSurfaceGoalId: string | null
  logSubgoalStart(goal: QueuedGoal, inventory: Record<string, number>, cause: string): void
  logger: EventLogger
  notExecutableHereBinding: NotExecutableHereBinding | null
  notExecutableKey: string | null
  notExecutableRepeats: number
  readonly optionAttempts: OptionAttemptTracker
  options: Pick<JevAgentOptions, 'dominatedGoalReason' | 'knownResources' | 'planIdentity' | 'supersededGoalReason'> & SensorOptionSlice
  pendingTransition: DecisionSubgoalLog | null
  readonly policyProvider: string
  portalEnteredTruth(goal: QueuedGoal): boolean
  portalLitTruth(goal: QueuedGoal): boolean
  predicateSnapshot(): { position: Vec3Json | null; dimension: string | null }
  queue: GoalQueue
  queuePreconditionSnapshot(): OptionWorldSnapshot
  recentEvents: string[]
  recentOutcomes: System2Outcome[]
  resetNotExecutableDedupe(): void
  signals: AgentSignals
  summonLlm(reason: LlmSummonReason, detail: string): DecisionLlmResummonLog | null
  surfaceAscentRefusalStreak: number
  surfaceAscentRefusalStreakKey: string | null
  readonly tickCounter: number
  readonly waitStreakEscalation: WaitStreakEscalation
  readonly executor: import('./executor.ts').Executor
  semanticStateGeneration: number
  requestDecision(trigger: import('./scheduler.ts').DecisionTrigger, detail: Record<string, unknown>): void
}

export function logHeads(host: GoalQueuePlaneHost,
result: JevResult, verdict: AbandonVerdict, chainId: string | null = null): void {
  const action = actionDeclined(result) ? ACTION_DECLINE_LABEL : decisionIdFrom(result) ?? 'WAIT'
  const abandon = result.answers.abandon_option?.probability ?? null
  const vote = verdict.vote
  host.logger.info(
    'heads',
    formatJevHeads(action, abandon, verdict.adopt),
    {
      action,
      abandon,
      decision: verdict.adopt ? 'replan' : 'continue',
      abandonRequested: abandonRequested(result),
      abandonEnforced: verdict.enforced,
      abandonSuppressed: verdict.suppressed,
      attempts: verdict.classification.attempts,
      chainId,
      provider: host.policyProvider,
      policy: result.policy,
      source: result.source,
      model: result.model,
    },
    host.tickCounter,
  )
  if (verdict.adopt) {
    const reason = host.abandonReason(action, abandon)
    if (verdict.optionId !== null) {
      const option = verdict.optionId
      host.logger.warn('heads', formatAbandonReason(option, reason), { option, reason, beta: abandon, action }, host.tickCounter)
    }
  }
}

export function reconcilePlanIdentity(host: GoalQueuePlaneHost): void {
  const provider = host.options.planIdentity
  if (provider === undefined) return
  let live: PlanIdentity | null = null
  try {
    live = provider()
  } catch (error) {
    host.logger.warn(
      'agent',
      `PLAN_IDENTITY_UNAVAILABLE error=${error instanceof Error ? error.message : String(error)}`,
      {},
      host.tickCounter,
    )
    return
  }
  if (live === null) return
  const proof = host.options.supersededGoalReason
  const result = host.queue.reconcilePlanIdentity({
    current: live,
    isObsolete: proof === undefined ? undefined : (goal) => proof(goal, live as PlanIdentity),
    onSuperseded: (line, detail) => host.logger.warn('queue', line, detail, host.tickCounter),
  })
  if (result.adoptedLegacy > 0 && result.previous === null) {
    // First reconciliation of a legacy/queued ledger: rows adopt the live
    // identity, so nothing is misread as superseded. Evidence only.
    host.logger.info(
      'queue',
      `PLAN_IDENTITY_ADOPTED identity=${formatPlanIdentity(result.current)} rows=${result.adoptedLegacy}`,
      { identity: formatPlanIdentity(result.current), rows: result.adoptedLegacy },
      host.tickCounter,
    )
  }
  if (result.superseded > 0) {
    host.logger.warn(
      'agent',
      formatPlanIdentityChanged(result),
      {
        from: formatPlanIdentity(result.previous),
        to: formatPlanIdentity(result.current),
        superseded: result.superseded,
        retired: result.retired.map((entry) => entry.id),
        kept: result.kept.map((entry) => entry.id),
        headSuperseded: result.headSuperseded,
      },
      host.tickCounter,
    )
  }
  if (result.superseded === 0) return
  // The preferred arm: ask System2 (the WHAT owner) to re-plan, carrying the
  // compact state the request already builds (objective, queue head, recent
  // outcomes/events, grounded alternatives, world facts, blocker detail). The
  // replan throttle and the model cooldown bound it; `planIdentityKey` in
  // `replanInputs()` makes a genuinely new objective new information while a
  // repeated identical supersession is held.
  const request = planReplanRequest(result)
  if (request === null) return
  host.summonLlm(request.reason, request.detail)
}

export function reconcileHeadDimension(host: GoalQueuePlaneHost): void {
  if (host.queue.isEmpty) {
    host.notExecutableHereBinding = null
    return
  }
  const live = host.bot.game?.dimension ?? null
  const result = host.queue.reconcileNotExecutableHead({ liveDimension: live })
  // Only an ESCALATE leaves the not-executable row holding the plan (a `defer`
  // has already moved it behind a row that can run here), so only that state binds
  // the offer.
  host.notExecutableHereBinding =
    result.action === 'escalate' && result.goalId !== null
      ? {
          goalId: result.goalId,
          goalKey: result.goalKey,
          declaredDimension: result.declaredDimension,
          liveDimension: result.liveDimension,
          reason: result.reason,
        }
      : null
  if (result.action === 'hold') return
  if (result.action === 'defer') {
    host.resetNotExecutableDedupe()
    host.logger.warn(
      'agent',
      formatRowDeferredNotExecutableHere(result),
      {
        goalId: result.goalId,
        goalKey: result.goalKey,
        declaredDimension: result.declaredDimension,
        liveDimension: result.liveDimension,
        defers: result.defers,
        limit: result.limit,
        nextGoalId: result.nextGoalId,
      },
      host.tickCounter,
    )
    return
  }
  // The measured run emitted the same unchanged fact 227 times, which buries
  // the rest of buddy.log without adding information. The line is emitted when
  // the fact changes, and the suppressed repeats ride the next emitted line.
  const key = `${result.goalId ?? 'none'}|${result.reason}|${result.declaredDimension ?? 'none'}|${result.liveDimension ?? 'unknown'}`
  if (key === host.notExecutableKey) {
    host.notExecutableRepeats += 1
  } else {
    host.notExecutableKey = key
    host.notExecutableRepeats = 0
    host.logger.warn(
      'agent',
      `${formatRowNotExecutableHere(result)} -> wake System2`,
      {
        goalId: result.goalId,
        goalKey: result.goalKey,
        declaredDimension: result.declaredDimension,
        liveDimension: result.liveDimension,
        reason: result.reason,
        defers: result.defers,
        limit: result.limit,
      },
      host.tickCounter,
    )
  }
  const request = notExecutableReplanRequest(result)
  if (request === null) return
  // The request path has its own bounded throttling (the replan throttle and the
  // escalation cooldown); only the human-readable line is deduped here.
  host.summonLlm(request.reason, request.detail)
}

export function reconcileNonProgressingOptionalHead(host: GoalQueuePlaneHost): void {
  if (host.queue.isEmpty) return
  const critical = bodyStarving({
    food: typeof host.bot.food === 'number' ? host.bot.food : Number.NaN,
    health: host.bot.health,
  })
  const result = host.queue.reconcileNonProgressingHead({ critical })
  const detail = {
    goalId: result.goalId,
    goalKey: result.goalKey,
    decisions: result.decisions,
    limit: result.limit,
    yields: result.yields,
    maxYields: result.maxYields,
    nextGoalId: result.nextGoalId,
    reason: result.reason,
    critical,
  }
  if (result.action === 'yield') {
    host.logger.warn('agent', formatNonProgressYield(result), detail, host.tickCounter)
  } else if (result.action === 'escalate') {
    host.logger.warn('agent', formatNonProgressEscalated(result), detail, host.tickCounter)
  }
}

export function unfinishedGoals(host: GoalQueuePlaneHost): QueuedGoal[] {
  return host.queue.state.goals.filter((goal) => goal.status === 'pending' || goal.status === 'active')
}

export function previousDecisionFacts(host: GoalQueuePlaneHost): PreviousDecisionFacts | null {
  const outcome = host.lastSkillOutcome
  if (host.lastDecisionId === null && outcome === null) return null
  const view =
    host.lastDecisionId === null
      ? undefined
      : host.lastSemanticProjection?.candidates.find((candidate) => candidate.id === host.lastDecisionId)
  return {
    selectedCandidateId: host.lastDecisionId,
    selectedIdentity: view?.identity ?? null,
    skillKind: view?.kind ?? host.lastSkillOutcome?.skillKind ?? null,
    targetKey: outcome === null ? null : `${outcome.targetIdentity.kind}:${outcome.targetIdentity.key}`,
    commitmentId: outcome?.commitmentId ?? null,
    terminalReason: outcome?.terminalReason ?? null,
    failureCode: outcome?.failure?.code ?? null,
    progressKind: outcome?.semanticProgress.kind ?? null,
  }
}

export function syncQueue(host: GoalQueuePlaneHost,
trigger: DecisionTrigger): void {
  // Inventory substitutions can obsolete an inserted prerequisite even when
  // its own product count is unchanged. Preserve audited retirement, not DONE.
  host.queue.retireOrphanedPrerequisites()
  // Live diagnosis (M2 hand-off): the queue's light row re-ignited thousands of
  // times without ever completing, and `portalLitTruth` (the row's completion
  // predicate) never ran. Record what the controller believes the current row is
  // so the gap is decided by evidence.
  {
    const row = host.queue.current
    host.logger.info(
      'queue',
      `SYNC_QUEUE trigger=${trigger} current=${row === null ? 'none' : `${row.id}|kind=${row.kind}|pred=${row.targetPredicate ?? 'none'}|status=${row.status ?? 'n/a'}`} depth=${host.queue.size}`,
      { current: row?.id ?? null, kind: row?.kind ?? null, predicate: row?.targetPredicate ?? null },
      host.tickCounter,
    )
  }
  const current = host.queue.current
  if (current === null) return
  if (current.kind === 'explore') {
    // Search Options are intentionally open-ended: code owns grounded frontier
    // enumeration and search progress, while beta/System2 own semantic termination.
    return
  }
  if (current.kind === 'goto') {
    const target = current.targetPosition ?? null
    if (target === null) {
      const impossible = host.queue.markImpossible(`goto goal '${current.id}' has no code-grounded target position`)
      if (impossible !== null) {
        host.recentEvents.push(`goal impossible: ${impossible.description}`)
        host.summonLlm('action_impossible', `current goal is not executable: ${impossible.description}`)
      }
      return
    }
    const goalDimension = (current.dimension ?? '').replace(/^minecraft:/, '')
    const liveDimension = host.currentDimension().replace(/^minecraft:/, '')
    if (goalDimension.length > 0 && goalDimension !== liveDimension) {
      const impossible = host.queue.markImpossible(
        `goto goal '${current.id}' belongs to dimension ${current.dimension ?? 'unknown'} but live dimension is ${host.currentDimension()}`,
      )
      if (impossible !== null) {
        host.recentEvents.push(`goal impossible: ${impossible.description}`)
        host.summonLlm('action_impossible', `current goal is not executable: ${impossible.description}`)
      }
      return
    }
    const position = host.bot.entity.position
    const distanceToTarget = Math.hypot(position.x - target.x, position.y - target.y, position.z - target.z)
    if (distanceToTarget > 2.5) return
    const beforeId = current.id
    const beforeDescription = current.description
    host.queue.markDone()
    const after = host.queue.current
    host.pendingTransition = {
      fromId: beforeId,
      fromDescription: beforeDescription,
      toId: after?.id ?? null,
      toDescription: after?.description ?? null,
      trigger,
      inventory: host.inventorySnapshot(),
    }
    host.lastProgressAt = Date.now()
    host.lastProgress = 0
    host.logger.warn(
      'queue',
      `subgoal COMPLETE [${beforeDescription}] -> [${after?.description ?? 'plan complete'}] trigger=${trigger} distance=${Math.round(distanceToTarget * 100) / 100}`,
      { from: beforeId, to: after?.id ?? null, trigger, distance: distanceToTarget, target },
      host.tickCounter,
    )
    if (after !== null) host.logSubgoalStart(after, host.pendingTransition.inventory, `advance:${trigger}`)
    return
  }
  if (current.kind === 'descend') {
    // The plan was supplied before the smelt inputs were held, so the ore
    // descent that preceded the smelt is now a stale prerequisite. Retire it
    // so the queue advances to the smelt / its furnace path instead of
    // descending forever (see `staleOreDescend`).
    const staleSmelt = staleOreDescend(current, host.queue.state.goals, host.queuePreconditionSnapshot())
    if (staleSmelt !== null) {
      const beforeId = current.id
      const beforeDescription = current.description
      host.queue.markDone()
      const after = host.queue.current
      host.pendingTransition = {
        fromId: beforeId,
        fromDescription: beforeDescription,
        toId: after?.id ?? null,
        toDescription: after?.description ?? null,
        trigger,
        inventory: host.inventorySnapshot(),
      }
      host.lastProgressAt = Date.now()
      host.lastProgress = 0
      host.descendHaveBaseline = 0
      host.digMemory.markResourceProgress()
      host.logger.warn(
        'queue',
        `subgoal COMPLETE [${beforeDescription}] -> [${after?.description ?? 'plan complete'}] trigger=${trigger} stale_ore_descend_for=${staleSmelt.description} inventory=${JSON.stringify(host.pendingTransition.inventory)}`,
        { from: beforeId, to: after?.id ?? null, trigger, staleFor: staleSmelt.id, staleForDescription: staleSmelt.description },
        host.tickCounter,
      )
      if (after !== null) host.logSubgoalStart(after, host.pendingTransition.inventory, `advance:${trigger}:stale-ore-descend`)
      return
    }
    const evaluation = host.evaluateDescendGoal(current)
    if (evaluation === null) {
      const impossible = host.queue.markImpossible(`descend goal '${current.id}' has no targetY predicate`)
      if (impossible !== null) {
        host.recentEvents.push(`goal impossible: ${impossible.description}`)
        host.summonLlm('action_impossible', `current goal is not executable: ${impossible.description}`)
      }
      return
    }
    host.logger.info(
      'queue',
      `PREDICATE_EVAL [${current.id}] ${evaluation.detail}`,
      {
        id: current.id,
        predicate: 'descend_to',
        targetY: current.targetY,
        y: evaluation.y,
        dimensionOk: evaluation.dimensionOk,
        satisfied: evaluation.satisfied,
      },
      host.tickCounter,
    )
    if (!evaluation.satisfied) return
    const beforeId = current.id
    const beforeDescription = current.description
    host.queue.markDone()
    const after = host.queue.current
    host.pendingTransition = {
      fromId: beforeId,
      fromDescription: beforeDescription,
      toId: after?.id ?? null,
      toDescription: after?.description ?? null,
      trigger,
      inventory: host.inventorySnapshot(),
    }
    host.harvestedGoalCount = 0
    host.lastProgressAt = Date.now()
    host.lastProgress = 0
    host.descendHaveBaseline = 0
    host.digMemory.markResourceProgress()
    host.logger.warn(
      'queue',
      `subgoal COMPLETE [${beforeDescription}] -> [${after?.description ?? 'plan complete'}] trigger=${trigger} reached=${evaluation.y} targetY=${current.targetY} inventory=${JSON.stringify(host.pendingTransition.inventory)}`,
      { from: beforeId, to: after?.id ?? null, trigger, y: evaluation.y, targetY: current.targetY },
      host.tickCounter,
    )
    if (after !== null) host.logSubgoalStart(after, host.pendingTransition.inventory, `advance:${trigger}`)
    return
  }
  if (current.targetItem !== null && (current.kind === 'collect' || current.kind === 'craft' || current.kind === 'smelt')) {
    const have = host.effectiveHave()
    const beforeId = current.id
    const beforeDescription = current.description
    host.queue.markProgress(have)
    const after = host.queue.current
    if (after === null || after.id !== beforeId) {
      host.pendingTransition = {
        fromId: beforeId,
        fromDescription: beforeDescription,
        toId: after?.id ?? null,
        toDescription: after?.description ?? null,
        trigger,
        inventory: host.inventorySnapshot(),
      }
      host.harvestedGoalCount = 0
      host.lastProgressAt = Date.now()
      host.lastProgress = 0
      host.descendHaveBaseline = have
      host.digMemory.markResourceProgress()
      host.logger.warn(
        'queue',
        `subgoal COMPLETE [${beforeDescription}] -> [${after?.description ?? 'plan complete'}] trigger=${trigger} have=${have} inventory=${JSON.stringify(host.pendingTransition.inventory)}`,
        { from: beforeId, to: after?.id ?? null, trigger, have },
        host.tickCounter,
      )
      if (after !== null) host.logSubgoalStart(after, host.pendingTransition.inventory, `advance:${trigger}`)
    }
    return
  }
  if (current.kind === 'place') {
    // Being in the Nether proves the overworld light row has served its purpose.
    // `portalLitTruth` is dimension-bound to the row's own dimension (overworld),
    // so without this the row can never complete after the transfer and the
    // queue never drains to the M3 goals - live: the body stood in the Nether
    // with a plan already containing `collect 7 x blaze_rod` / `collect 12 x
    // ender_pearl` while it WAITed on the light row forever.
    const inNether = String(host.bot.game?.dimension ?? '') === 'minecraft:the_nether'
    const complete =
      current.targetPredicate === PORTAL_LIT_PREDICATE
        ? host.portalLitTruth(current) || inNether
        : current.targetPredicate === PORTAL_ENTERED_PREDICATE
          ? host.portalEnteredTruth(current)
          : current.targetItem !== null && host.countItem(current.targetItem) <= 0
    if (complete) {
      const beforeId = current.id
      const beforeDescription = current.description
      host.queue.markDone()
      const after = host.queue.current
      host.pendingTransition = {
        fromId: beforeId,
        fromDescription: beforeDescription,
        toId: after?.id ?? null,
        toDescription: after?.description ?? null,
        trigger,
        inventory: host.inventorySnapshot(),
      }
      host.lastProgressAt = Date.now()
      host.lastProgress = 0
      host.logger.warn(
        'queue',
        `subgoal COMPLETE [${beforeDescription}] -> [${after?.description ?? 'plan complete'}] trigger=${trigger} inventory=${JSON.stringify(host.pendingTransition.inventory)}`,
        { from: beforeId, to: after?.id ?? null, trigger },
        host.tickCounter,
      )
      if (after !== null) host.logSubgoalStart(after, host.pendingTransition.inventory, `advance:${trigger}`)
    }
    return
  }
  if (current.kind === 'surface') {
    if (typeof current.targetY !== 'number' || !Number.isFinite(current.targetY)) {
      const badPredicate = host.queue.markImpossible(`surface goal '${current.id}' has no targetY predicate`)
      if (badPredicate !== null) {
        host.recentEvents.push(`goal impossible: ${badPredicate.description}`)
        host.summonLlm('action_impossible', `current goal is not executable: ${badPredicate.description}`)
      }
      return
    }
    if (host.lastSurfaceGoalId !== current.id) {
      host.lastSurfaceGoalId = current.id
      host.logger.warn(
        'agent',
        `RETURN_TO_SURFACE goal=${current.id} target_y=${current.targetY} reason=capability_gap`,
        { id: current.id, targetY: current.targetY },
        host.tickCounter,
      )
    }
    const evaluation = evaluateSurfaceRecovery(current, {
      ...host.predicateSnapshot(),
      inventory: host.inventorySnapshot(),
    })
    if (evaluation === null || !evaluation.satisfied) {
      // Deterministic feasibility (CAN/TRUE, not a preference): the candidate
      // layer proved there is no grounded ascent route for this `targetY`, the
      // tick offered NO body-changing route at all (`surfaceAscentRouteless`),
      // and that same refusal has held for several consecutive candidate
      // generations under this goal. The Option provably cannot progress from
      // this state, so mark it impossible and let System2 replace it instead of
      // the body pacing in the level-move set (the measured 48-minute loop).
      // The stale CAPABILITY_GAP marker is dropped here so the planner's
      // forced-surface path (planner-deterministic `forcedSurface`) cannot immediately
      // re-issue the same impossible row; the durable log lines remain.
      const refusal = host.lastSurfaceAscentRefusal
      if (
        refusal !== null &&
        host.lastSurfaceAscentRouteless &&
        host.surfaceAscentRefusalStreak >= SURFACE_ASCENT_IMPOSSIBLE_STREAK &&
        refusal.goalId === current.id
      ) {
        const impossible = host.queue.markImpossible(
          `surface goal '${current.id}' has no grounded ascent route (${formatSurfaceAscentRefused(refusal)})`,
        )
        if (impossible !== null) {
          host.capabilityGapActive = false
          host.capabilityGapSignature = null
          host.lastSurfaceAscentRefusal = null
          host.lastSurfaceAscentRefusalKey = null
          host.surfaceAscentRefusalStreak = 0
          host.surfaceAscentRefusalStreakKey = null
          host.recentEvents = host.recentEvents.filter((line) => !line.startsWith('CAPABILITY_GAP '))
          host.recentEvents.push(`goal impossible: ${impossible.description}`)
          host.summonLlm('action_impossible', `current goal is not executable: ${impossible.description}`)
        }
      }
      return
    }
    const beforeId = current.id
    const beforeDescription = current.description
    host.queue.markDone()
    const after = host.queue.current
    host.pendingTransition = {
      fromId: beforeId,
      fromDescription: beforeDescription,
      toId: after?.id ?? null,
      toDescription: after?.description ?? null,
      trigger,
      inventory: host.inventorySnapshot(),
    }
    host.harvestedGoalCount = 0
    host.lastProgressAt = Date.now()
    host.lastProgress = 0
    host.capabilityGapActive = false
    host.capabilityGapSignature = null
    host.digMemory.markResourceProgress()
    host.logger.warn(
      'agent',
      `RETURN_TO_SURFACE goal=${beforeId} reached=true predicate=levelAtLeast+inventory y=${Math.round(evaluation.vertical.y ?? 0)} target_y=${current.targetY} log=${evaluation.have}/${evaluation.required}`,
      {
        from: beforeId,
        to: after?.id ?? null,
        trigger,
        y: evaluation.vertical.y,
        targetY: current.targetY,
        resourceHave: evaluation.have,
        resourceRequired: evaluation.required,
      },
      host.tickCounter,
    )
    if (after !== null) host.logSubgoalStart(after, host.pendingTransition.inventory, `advance:${trigger}`)
    return
  }
  const impossible = host.queue.markImpossible(
    `goal kind '${current.kind}' is not executable by this PoC`,
  )
  if (impossible !== null) {
    host.recentEvents.push(`goal impossible: ${impossible.description}`)
    host.summonLlm('action_impossible', `current goal is not executable: ${impossible.description}`)
  }
}

export function syncGoalToQueue(host: GoalQueuePlaneHost): void {
  const current = host.queue.current
  if (current === null) return
  if (current.kind === 'descend') {
    const evaluation = host.evaluateDescendGoal(current)
    const satisfied = evaluation?.satisfied ?? false
    host.goal = {
      id: current.id,
      description: current.description,
      targetItem: current.targetItem ?? '',
      requiredCount: 1,
      startCount: 0,
      haveCount: satisfied ? 1 : 0,
      progress: satisfied ? 1 : 0,
      complete: satisfied,
      startedAtMs: current.createdAt,
    }
    return
  }
  if (current.kind === 'surface') {
    const evaluation = evaluateSurfaceRecovery(current, {
      ...host.predicateSnapshot(),
      inventory: host.inventorySnapshot(),
    })
    const have = evaluation?.have ?? 0
    host.goal = {
      id: current.id,
      description: current.description,
      targetItem: current.targetItem ?? '',
      requiredCount: current.requiredCount,
      startCount: 0,
      haveCount: have,
      progress: evaluation?.satisfied === true ? 1 : Math.min(1, have / Math.max(1, current.requiredCount)),
      complete: evaluation?.satisfied === true,
      startedAtMs: current.createdAt,
    }
    return
  }
  if (current.targetItem === null) return
  const have = host.effectiveHave()
  if (current.kind === 'place') {
    // Ordinary PLACE goals are inverse inventory goals. A portal ignition or
    // dimension transfer is different: `nether_portal` is a world block, never
    // an inventory item, so zero inventory must not masquerade as a completed
    // predicate. Each portal predicate owns its own live-world truth.
    const placed =
      current.targetPredicate === PORTAL_LIT_PREDICATE
        ? host.portalLitTruth(current)
        : current.targetPredicate === PORTAL_ENTERED_PREDICATE
          ? host.portalEnteredTruth(current)
          : have <= 0
    host.goal = { ...subgoalState(current, placed ? current.requiredCount : 0), haveCount: placed ? current.requiredCount : have }
    return
  }
  host.goal = subgoalState(current, have)
}

export function consumeTransition(host: GoalQueuePlaneHost): DecisionSubgoalLog | null {
  const transition = host.pendingTransition
  host.pendingTransition = null
  return transition
}

export function installGoalSuccessProbe(host: GoalQueuePlaneHost): void {
  host.queue.setGoalSuccessProbe(
    (goal) => evaluateGoalSuccess(goal, host.goalWorldProbe()),
    (line, detail) => host.logger?.warn('queue', line, detail, host.tickCounter),
  )
}

export function currentOptionContext(host: GoalQueuePlaneHost): CurrentOptionContext | null {
  const current = host.queue.state.current
  if (current === null || typeof current.optionInstanceId !== 'string' || current.optionInstanceId.length === 0) return null
  const optionId = current.semanticOptionTemplateId ?? current.optionTemplateId ?? optionIdForGoal(current) ?? host.currentGoalKey()
  const attempts = host.optionAttempts.stateFor(optionId, current.id)
  return currentOptionContextForQueuedGoal(current, {
    failures: attempts.attempts,
    verifiedProgress: current.haveCount,
    lastProgressAt: current.updatedAt,
  })
}

export function verifyQueuedGoalComplete(host: GoalQueuePlaneHost,
goal: QueuedGoal): boolean {
  const snapshot = host.queuePreconditionSnapshot()
  const spec = goal.optionSpec ?? compilePlannedGoal(queuedToPlanned(goal), snapshot)
  const predicate = evaluatePredicates(spec.success, snapshot)
  if (predicate.ok) return true
  if ((goal.kind === 'collect' || goal.kind === 'craft' || goal.kind === 'smelt') && goal.targetItem !== null) {
    return (snapshot.inventory[goal.targetItem] ?? 0) >= goal.requiredCount
  }
  return false
}

export function currentGoalKey(host: GoalQueuePlaneHost): string {
  const current = host.queue.state.current
  if (current !== null) {
    return `${current.kind}:${current.targetItem ?? current.description}:${current.requiredCount}`
  }
  return `objective:${host.goal.targetItem}:${host.goal.requiredCount}`
}

export function logQueueDepthDelta(host: GoalQueuePlaneHost,
before: number, op: string, reason: string): void {
  const state = host.queue.state
  const delta = state.depth - before
  if (delta === 0) return
  const signed = delta > 0 ? `+${delta}` : `${delta}`
  host.logger.info(
    'queue',
    `QUEUE_DEPTH delta=${signed} depth=${state.depth} done=${state.done} op=${op} reason=${reason}`,
    { delta, depth: state.depth, done: state.done, op, reason },
    host.tickCounter,
  )
}

export function noProductiveSignature(host: GoalQueuePlaneHost,
state: WorldState): string {
  const inventory = Object.entries(state.inventory.counts)
    .filter(([, count]) => count > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, count]) => `${name}=${count}`)
    .join(',')
  const position = `${Math.round(state.self.position.x)},${Math.round(state.self.position.y)},${Math.round(state.self.position.z)}`
  return `${host.currentGoalKey()}|${position}|${inventory}`
}

export function replanInputs(host: GoalQueuePlaneHost): ReplanInputs {
  const inventory: Record<string, number> = {}
  try {
    for (const item of host.bot.inventory.items()) inventory[item.name] = (inventory[item.name] ?? 0) + item.count
  } catch {
    // inventory unreadable at a death/quit boundary; an empty snapshot is safe
  }
  const entity = host.bot.entity
  const position =
    entity === undefined
      ? null
      : { x: Math.round(entity.position.x), y: Math.round(entity.position.y), z: Math.round(entity.position.z) }
  const failureSignature = host.recentOutcomes
    .slice(-4)
    .map((outcome) => `${outcome.actionId}:${outcome.status}${outcome.failure === null ? '' : `:${outcome.failure}`}`)
    .join(',')
  return {
    inventory,
    position,
    knownResources: (host.signals.knownResources ?? []).length,
    failureSignature,
    capabilityGap: host.capabilityGapActive ? host.capabilityGapSignature : null,
    goalKey: host.currentGoalKey(),
    // #plan-reconciliation: a genuinely different plan/objective identity is new
    // information for the replan gate (so the supersession wake is not swallowed
    // as `no_new_info`), while the identical supersession repeated stays bounded
    // by the same throttle.
    planIdentityKey: (() => {
      try {
        const identity = host.options.planIdentity?.() ?? null
        return identity === null ? null : formatPlanIdentity(identity)
      } catch {
        return null
      }
    })(),
    // The Nth identical typed action failure is proof the local recovery is
    // exhausted, so it is genuine new information for the replan gate even
    // though the cheap world inputs are identical. Null at every count < N.
    actionFailureExhausted: host.actionFailureEscalation.pendingKey(),
    // The Nth actionable WAIT is proof the no-op selection itself is the loop,
    // so it is genuine new information for the replan gate.
    waitStreakExhausted: host.waitStreakEscalation.pendingKey(),
  }
}

export const SURFACE_ASCENT_IMPOSSIBLE_STREAK = 3
/** Issue #45: an active RETRIEVE that stops closing distance for this many ticks escalates. */
/** Issue #41: a descend goal with no vertical progress for this many ticks escalates. */
/** Issue #41: a descend goal with no executable descend candidate this long escalates. */
/** Distance decrease (m) that counts as real retrieval progress. */
/** Issue #8: failed attempts at one coordinate before it is blacklisted. */
// Below this windowed locomotion efficiency a verified MOVE is mechanical success
// without progress, so it must not clear the failure memory (issue #360).
const MOVE_PROGRESS_EFFICIENCY_FLOOR = resolveEnvPositiveInt('BUDDY_MOVE_PROGRESS_EFFICIENCY_FLOOR', 20)
/** #405: how many recently occupied cells the exploration fallback treats as visited. */
const EXPLORED_CELLS_LIMIT = 512
const MOVE_FAILMEM_LIMIT = resolveEnvPositiveInt('BUDDY_MOVE_FAILMEM_LIMIT', 3)
/** Issue #8: how long a blacklisted coordinate stays skipped. */
const MOVE_FAILMEM_COOLDOWN_MS = resolveEnvPositiveInt('BUDDY_MOVE_FAILMEM_COOLDOWN_MS', 30_000)
/** Issue #8: bound on tracked coordinates (least-failed/oldest evicted first). */
const MOVE_FAILMEM_MAX_ENTRIES = resolveEnvPositiveInt('BUDDY_MOVE_FAILMEM_MAX_ENTRIES', 256)
/** Issue #8: do not re-log the same oscillating pair more often than this. */
/**
 * #oscillation-boundary: the size of the body's cell envelope and the bounded
 * return count that proves the local recovery is exhausted. Reasoning lives on
 * the constants in `localOscillation.ts`; they are read once here like the
 * `MOVE_FAILMEM_*` pair above.
 */

function resolveEnvPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export interface AbandonVerdict {
  adopt: boolean
  enforced: boolean
  suppressed: boolean
  classification: AbandonClassification
  vote: BetaAuthorityDecision
  optionId: string | null
  planId: string | null
}

export function orphanedSmeltPrerequisiteReason(input: {
  kind: string
  item: string | null
  held: number
  stillWanted: boolean
}): string | null {
  if (input.kind !== 'smelt' || input.item !== IRON_INGOT) return null
  if (input.stillWanted || input.held < 1) return null
  return `orphaned smelt prerequisite: ${FLINT_AND_STEEL}=${input.held} and no live row or incoming goal requires ${IRON_INGOT}`
}

export interface SurfaceRecoveryEvaluation {
  /** The code-owned vertical predicate; Y alone is never sufficient. */
  vertical: PredicateEvaluation
  /** Inventory count for the explicit recovery resource, e.g. the log class. */
  have: number
  required: number
  resourceSatisfied: boolean
  satisfied: boolean
}

export function evaluateSurfaceRecovery(
  goal: Pick<QueuedGoal, 'kind' | 'targetY' | 'dimension' | 'targetItem' | 'requiredCount'>,
  snapshot: {
    position: Vec3Json | null
    dimension: string | null
    inventory: Readonly<Record<string, number>>
  },
): SurfaceRecoveryEvaluation | null {
  if (goal.kind !== 'surface') return null
  const predicate = predicateForGoal(goal)
  if (predicate === null || predicate.kind !== 'levelAtLeast') return null
  const vertical = evaluateSpatialPredicate(predicate, {
    position: snapshot.position,
    dimension: snapshot.dimension,
  })
  const required = Math.max(1, goal.requiredCount)
  const target = goal.targetItem
  let have = 0
  if (target !== null) {
    for (const [name, count] of Object.entries(snapshot.inventory)) {
      if (goalResourceMatches(name, target)) have += count
    }
  }
  const resourceSatisfied = target === null || have >= required
  return {
    vertical,
    have,
    required,
    resourceSatisfied,
    satisfied: vertical.satisfied && resourceSatisfied,
  }
}

export function staleOreDescend(
  current: Pick<QueuedGoal, 'kind' | 'targetItem'>,
  goals: readonly QueuedGoal[],
  snapshot: OptionWorldSnapshot,
): QueuedGoal | null {
  if (current.kind !== 'descend' || current.targetItem === null) return null
  for (const candidate of goals) {
    if (candidate.kind !== 'smelt' || candidate.targetItem === null) continue
    if (candidate.status === 'done' || candidate.status === 'impossible') continue
    const input = smeltInputFor(candidate.targetItem)
    if (input === null) continue
    if (!resourceMatches(current.targetItem, input)) continue
    const spec = compilePlannedGoal(queuedToPlanned(candidate), snapshot)
    const itemPreconditions = spec.preconditions.filter((predicate) => predicate.kind !== 'stationKnown')
    if (itemPreconditions.length === 0) continue
    if (!evaluatePredicates(itemPreconditions, snapshot).ok) continue
    return candidate
  }
  return null
}

export function subgoalState(goal: QueuedGoal, have: number): GoalState {
  const required = Math.max(1, goal.requiredCount)
  return {
    id: goal.id,
    description: goal.description,
    targetItem: goal.targetItem ?? '',
    requiredCount: required,
    startCount: 0,
    haveCount: have,
    progress: Math.min(1, have / required),
    complete: have >= required,
    startedAtMs: goal.createdAt,
  }
}

// ---------------------------------------------------------------------------
// Human-intent queue lifecycle (moved from controller.ts): apply/clear
// a human interrupt plan, bump the semantic generation, cancel the in-flight
// action when ownership actually changes, and wake the decision plane.
// ---------------------------------------------------------------------------

export function submitHumanPlan(host: GoalQueuePlaneHost, goals: readonly PlannedGoal[], requestedBy: string): QueuedGoal[] {
  const previous = host.queue.current
  const added = host.queue.interruptWithHumanPlan(goals, {
    onDuplicate: (line) => host.logger.info('human', line, { requestedBy }, host.tickCounter),
  })
  if (added.length === 0) return []
  host.semanticStateGeneration += 1
  if (previous !== null && previous.origin !== 'human') {
    host.executor.cancelCurrent(`human intent from ${requestedBy}`)
  }
  host.logger.warn(
    'human',
    `HUMAN_INTENT_APPLIED requestedBy=${requestedBy} goals=${added.length}`,
    { requestedBy, goals: added.map((goal) => goal.description), queueDepth: host.queue.state.depth },
    host.tickCounter,
  )
  host.requestDecision('human_intent', { requestedBy, goals: added.map((goal) => goal.id) })
  return added
}

export function clearHumanPlan(host: GoalQueuePlaneHost, requestedBy: string, reason = 'free'): QueuedGoal[] {
  const currentWasHuman = host.queue.current?.origin === 'human'
  const cleared = host.queue.clearHumanInterrupts(reason)
  if (cleared.length === 0) return []
  host.semanticStateGeneration += 1
  if (currentWasHuman) host.executor.cancelCurrent(`human ${reason} from ${requestedBy}`)
  host.logger.warn(
    'human',
    `HUMAN_INTENT_CLEARED requestedBy=${requestedBy} reason=${reason} goals=${cleared.length}`,
    { requestedBy, reason, goals: cleared.map((goal) => goal.id), queueDepth: host.queue.state.depth },
    host.tickCounter,
  )
  host.requestDecision('human_intent', { requestedBy, reason, cleared: cleared.map((goal) => goal.id) })
  return cleared
}
