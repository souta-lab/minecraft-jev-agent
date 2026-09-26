// ---------------------------------------------------------------------------
// Model-recovery drain (moved from controller-legacy.ts).
//
// When the provider fails the controller must not abandon a bounded in-flight
// escape Skill mid-step: stop accepting decisions, drain through the active
// Reach contract when one owns the body, otherwise let a bounded escape Skill
// (RETREAT/MOVE env/ASCEND breath) reach its terminal boundary inside its
// committed budget + grace, then finish stopped-by-caller. No semantic
// authority is exercised here: this is lifecycle/quiesce bookkeeping only.
// ---------------------------------------------------------------------------

import type { EventLogger } from '../jev.ts'
import type { CurrentAction, Executor } from '../executor.ts'
import { MODEL_RECOVERY_DRAIN_GRACE_MS } from '../controller-shared.ts'
import type { DecisionScheduler } from '../scheduler.ts'
import type { TriggerEvent } from '../scheduler.ts'
import type { System2Brain } from '../system2/service.ts'
import type { ReachTerminalOutcome, ReachTransitionState } from '../reach/transition.ts'
import type { ActiveReachTransition } from '../reach/controller-plane.ts'
import type { RunSummary } from '../controller-legacy.ts'

export interface ModelRecoveryHost {
  running: boolean
  modelRecoveryStopping: boolean
  readonly system2: System2Brain | null
  readonly scheduler: DecisionScheduler
  clearDecisionTimer(): void
  pendingTrigger: TriggerEvent | null
  deferredTrigger: TriggerEvent | null
  readonly reachTransition: ActiveReachTransition | null
  beginModelRecoveryReachDrain(runtime: ActiveReachTransition): void
  closeReachTransition(outcome: ReachTerminalOutcome, state: ReachTransitionState, boundary: string): boolean
  finish(stopped: RunSummary['stopped'], success: boolean): void
  modelRecoveryReachDrainTransitionId: string | null
  readonly executor: Executor
  logger: EventLogger
  readonly tickCounter: number
  modelRecoveryDrainTimer: NodeJS.Timeout | null
}

export function stopForModelRecovery(host: ModelRecoveryHost): void {
  if (!host.running || host.modelRecoveryStopping) return
  host.modelRecoveryStopping = true
  host.system2?.cancelPending?.('model-recovery')
  host.scheduler.stop()
  host.clearDecisionTimer()
  host.pendingTrigger = null
  host.deferredTrigger = null

  const reach = host.reachTransition ?? null
  if (reach !== null) {
    if (reach.state.status === 'active') {
      host.beginModelRecoveryReachDrain(reach)
      return
    }
    if (reach.state.terminalOutcome !== null) {
      host.closeReachTransition(reach.state.terminalOutcome, reach.state, 'model-recovery-observed-terminal')
      host.finish('stopped-by-caller', false)
      return
    }
  }

  const current = modelRecoveryDrainAction(host)
  const commitment = current?.commitment ?? null
  if (current === null || commitment === null) {
    host.logger.warn(
      'agent',
      `MODEL_RECOVERY_DRAIN phase=cancel actionId=${current?.id ?? 'none'} kind=${current?.kind ?? 'none'} reason=no_bounded_escape_skill`,
      { actionId: current?.id ?? null, kind: current?.kind ?? null, commitmentId: current?.commitment?.commitmentId ?? null },
      host.tickCounter,
    )
    host.finish('stopped-by-caller', false)
    return
  }

  host.logger.warn(
    'agent',
    `MODEL_RECOVERY_DRAIN phase=begin actionId=${current.id} kind=${current.kind} commitmentId=${commitment?.commitmentId} decisionEpoch=${commitment?.decisionEpoch} budgetMs=${commitment?.budget.ms}`,
    {
      actionId: current.id,
      kind: current.kind,
      commitmentId: commitment?.commitmentId ?? null,
      decisionEpoch: commitment?.decisionEpoch ?? null,
      budgetMs: commitment?.budget.ms ?? null,
      selectedBy: commitment?.selectedBy ?? null,
    },
    host.tickCounter,
  )
  const budgetMs = commitment.budget.ms as number
  const drainDeadlineMs = Math.max(
    0,
    current.startedAt + budgetMs + MODEL_RECOVERY_DRAIN_GRACE_MS - Date.now(),
  )
  host.modelRecoveryDrainTimer = setTimeout(() => {
    host.modelRecoveryDrainTimer = null
    const stillRunning = host.executor.current
    if (stillRunning?.epoch !== current.epoch || stillRunning.status !== 'running') {
      host.finish('stopped-by-caller', false)
      return
    }
    host.logger.error(
      'agent',
      `MODEL_RECOVERY_DRAIN phase=deadline actionId=${current.id} kind=${current.kind} budgetMs=${budgetMs} graceMs=${MODEL_RECOVERY_DRAIN_GRACE_MS} -> cancel over-budget Skill`,
      {
        actionId: current.id,
        kind: current.kind,
        commitmentId: commitment.commitmentId,
        budgetMs,
        graceMs: MODEL_RECOVERY_DRAIN_GRACE_MS,
        elapsedMs: Date.now() - current.startedAt,
      },
      host.tickCounter,
    )
    try {
      host.executor.cancelCurrent('model recovery drain exceeded the committed Skill budget')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      host.logger.error('agent', `MODEL_RECOVERY_DRAIN phase=cancel_error actionId=${current.id} error=${message}`, {
        actionId: current.id,
        kind: current.kind,
        commitmentId: commitment.commitmentId,
        error: message,
      }, host.tickCounter)
    } finally {
      host.finish('stopped-by-caller', false)
    }
  }, drainDeadlineMs)
  void current.completion.then(
    (result) => {
      host.logger.warn(
        'agent',
        `MODEL_RECOVERY_DRAIN phase=terminal actionId=${current.id} kind=${current.kind} outcome=${result.status} failureCode=${result.failure ?? 'none'}`,
        {
          actionId: current.id,
          kind: current.kind,
          commitmentId: commitment?.commitmentId ?? null,
          outcome: result.status,
          failureCode: result.failure ?? null,
        },
        host.tickCounter,
      )
      host.finish('stopped-by-caller', false)
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      host.logger.error(
        'agent',
        `MODEL_RECOVERY_DRAIN phase=terminal actionId=${current.id} kind=${current.kind} outcome=completion_rejected`,
        { actionId: current.id, kind: current.kind, commitmentId: commitment?.commitmentId ?? null, error: message },
        host.tickCounter,
      )
      host.finish('stopped-by-caller', false)
    },
  )
}

export function modelRecoveryDrainAction(host: ModelRecoveryHost): CurrentAction | null {
  const current = host.executor.current
  const recoveryReachId = host.modelRecoveryReachDrainTransitionId ?? null
  if (
    current !== null && current.status === 'running' &&
    recoveryReachId !== null && current.authorityLabel === 'vtr-reach' && current.transitionId === recoveryReachId &&
    host.reachTransition?.contract.transitionId === recoveryReachId && host.reachTransition.state.status === 'active'
  ) {
    return current
  }
  const commitment = current?.commitment ?? null
  if (
    current === null ||
    current.status !== 'running' ||
    commitment === null ||
    commitment.candidateId !== current.id ||
    commitment.budget.ms === null ||
    !Number.isFinite(commitment.budget.ms) ||
    commitment.budget.ms <= 0
  ) {
    return null
  }
  const escapeSkill =
    (current.kind === 'RETREAT' && commitment.skillKind === 'retreat') ||
    (current.kind === 'MOVE' &&
      commitment.skillKind === 'walk_to' &&
      commitment.allowedEffects.mayMove &&
      (current.id.startsWith('MOVE:env:') || current.id.startsWith('ASCEND:breath:')))
  return escapeSkill ? current : null
}
