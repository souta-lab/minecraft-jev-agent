// Wedge/wait-repeat detection extracted from controller-legacy.ts.
// Pure evaluators plus the small observer methods that latch repeat
// counters and escalate to the existing abort/summon paths. No new
// authority: abort still goes through host.finish and system2 wake
// through host.summonLlm.
import type { DecisionLlmResummonLog } from '../decisionlog.ts'
import type { GoalQueue } from '../goalQueue.ts'
import type { EventLogger } from '../jev.ts'
import { isFurnacePrerequisiteOption } from '../placementGuard.ts'
import type { InFlightAction } from '../policy.ts'
import type { PrereqDecision } from '../prereqOption.ts'
import type { LlmSummonReason } from '../system2/service.ts'
import { shouldWakeSystem2AfterLocalFailure } from '../system2/escalation.ts'

const WAIT_REPLAN_LIMIT = 4

export interface WaitWedgeInput {
  actionId: string
  goalKey: string
  previousGoalKey: string | null
  streak: number
  waitLimit: number
  replans: number
  replanLimit: number
}

export interface WaitWedgeDecision {
  outcome: 'not-wait' | 'below-limit' | 'replan' | 'wedge'
  streak: number
  goalKey: string
  n: number
}

export function evaluateWaitWedge(input: WaitWedgeInput): WaitWedgeDecision {
  if (input.actionId !== 'WAIT') return { outcome: 'not-wait', streak: 0, goalKey: input.goalKey, n: 0 }
  const streak = input.goalKey === input.previousGoalKey ? input.streak + 1 : 1
  if (streak < input.waitLimit) return { outcome: 'below-limit', streak, goalKey: input.goalKey, n: streak }
  if (input.replans < input.replanLimit) return { outcome: 'replan', streak: 0, goalKey: input.goalKey, n: streak }
  return { outcome: 'wedge', streak: 0, goalKey: input.goalKey, n: streak }
}

export type WedgeSuppressReason = 'progressing' | 'in_flight' | 'fingerprint_changed'

export interface WedgeRepeatInput {
  actionId: string
  previousActionId: string | null
  fingerprint: string
  previousFingerprint: string | null
  inFlight: boolean
  progressed: boolean
  repeats: number
}

export interface WedgeRepeatDecision {
  outcome: 'count' | 'suppress'
  reason: WedgeSuppressReason | null
  /** next consecutive count; 0 after a suppression, 1 on a window restart. */
  repeats: number
  restarted: boolean
}

export function evaluateWedgeRepeat(input: WedgeRepeatInput): WedgeRepeatDecision {
  if (input.progressed) return { outcome: 'suppress', reason: 'progressing', repeats: 0, restarted: false }
  if (input.inFlight) return { outcome: 'suppress', reason: 'in_flight', repeats: 0, restarted: false }
  if (input.previousActionId !== input.actionId) {
    return { outcome: 'count', reason: null, repeats: 1, restarted: true }
  }
  if (input.previousFingerprint !== null && input.previousFingerprint !== input.fingerprint) {
    return { outcome: 'suppress', reason: 'fingerprint_changed', repeats: 0, restarted: false }
  }
  return { outcome: 'count', reason: null, repeats: input.repeats + 1, restarted: false }
}

export function formatWedgeSuppressed(reason: WedgeSuppressReason, candidate: string, repeats: number): string {
  return `WEDGE_SUPPRESSED reason=${reason} candidate=${candidate} repeats=${repeats}`
}

export function formatWedgeAbort(actionId: string, repeats: number, limit: number): string {
  return `action id ${actionId} chosen ${repeats}x with no verified progress (limit ${limit})`
}

export interface WedgeHost {
  abortWedge(reason: string): void
  checkWaitWedge(): void
  chosenCountsAtProgress: number
  currentGoalKey(): string
  finish(stopped: unknown, success: boolean): void
  inFlight(): InFlightAction | null
  lastProgress: number
  lastStateFingerprint: string
  logWedgeSuppressed(reason: WedgeSuppressReason, candidate: string, repeats: number): void
  logger: EventLogger
  noProductiveThisTick: boolean
  options: {
    readonly singleShotPlanner: boolean
    readonly waitLimit: number
    readonly wedgeRepeatLimit: number
  }
  prereqPlan: PrereqDecision | null
  queue: GoalQueue
  summonLlm(reason: LlmSummonReason, detail: string): DecisionLlmResummonLog | null
  readonly tickCounter: number
  waitGoalKey: string | null
  waitReplans: number
  waitStreak: number
  wedgeAborted: boolean
  wedgeReason: string | null
  wedgeRepeats: number
  wedgeWindowFingerprint: string | null
  wedgeWindowId: string | null
}

export function checkWedge(host: WedgeHost,
actionId: string): void {
  const waitPath = actionId === 'WAIT' && !host.options.singleShotPlanner
  const limit = waitPath ? host.options.waitLimit : host.options.wedgeRepeatLimit
  const progressed = host.lastProgress > host.chosenCountsAtProgress
  if (progressed) host.chosenCountsAtProgress = host.lastProgress
  const previousRepeats = host.wedgeRepeats
  const verdict = evaluateWedgeRepeat({
    actionId,
    previousActionId: host.wedgeWindowId,
    fingerprint: host.lastStateFingerprint,
    previousFingerprint: host.wedgeWindowFingerprint,
    inFlight: host.inFlight() !== null,
    progressed,
    repeats: previousRepeats,
  })
  host.wedgeWindowId = actionId
  host.wedgeWindowFingerprint = host.lastStateFingerprint
  host.wedgeRepeats = verdict.repeats
  if (verdict.outcome === 'suppress') {
    if (previousRepeats >= limit) host.logWedgeSuppressed(verdict.reason ?? 'progressing', actionId, previousRepeats)
    if (waitPath) {
      host.waitStreak = 0
      host.waitGoalKey = host.currentGoalKey()
    }
    return
  }
  if (waitPath) {
    host.checkWaitWedge()
    return
  }
  const count = host.wedgeRepeats
  if (count <= host.options.wedgeRepeatLimit) return
  // Issue #58: a protected furnace prerequisite is owned by the prereq path
  // controller (which switches path after PREREQ_STALL_TICKS). Aborting here
  // would abandon the parent smelt goal, so never wedge-abort it.
  if (host.prereqPlan !== null && isFurnacePrerequisiteOption(actionId)) return
  host.abortWedge(formatWedgeAbort(actionId, count, host.options.wedgeRepeatLimit))
}


export function logWedgeSuppressed(host: WedgeHost,
reason: WedgeSuppressReason, candidate: string, repeats: number): void {
  host.logger.warn(
    'agent',
    formatWedgeSuppressed(reason, candidate, repeats),
    { reason, candidate, repeats },
    host.tickCounter,
  )
}


export function checkWaitWedge(host: WedgeHost): void {
  const actionId = 'WAIT'
  const goalKey = host.currentGoalKey()
  const wait = evaluateWaitWedge({
    actionId,
    goalKey,
    previousGoalKey: host.waitGoalKey,
    streak: host.waitStreak,
    waitLimit: host.options.waitLimit,
    replans: host.waitReplans,
    replanLimit: WAIT_REPLAN_LIMIT,
  })
  host.waitStreak = wait.streak
  host.waitGoalKey = wait.goalKey
  if (wait.outcome === 'below-limit') return
  if (wait.outcome === 'replan') {
    const boundary = shouldWakeSystem2AfterLocalFailure({
      failureCode: 'path_stuck',
      activeOption: host.queue.current !== null,
      semanticExhausted: false,
      semanticInvalid: false,
      semanticAbandoned: false,
    })
    // WAIT is a control outcome, not evidence that the current semantic
    // Option should be replaced. Keep the local recovery loop bounded by
    // candidate/state changes; a repeated WAIT cannot itself summon WHAT.
    const summon = boundary.wake
      ? host.summonLlm(
          'no_progress',
          `WAIT chosen ${wait.n}x on goal "${goalKey}" with no verified progress; semantic boundary=${boundary.reason}`,
        )
      : null
    const counted = summon?.triggered === true
    if (counted) host.waitReplans += 1
    host.waitStreak = 0
    host.wedgeRepeats = 0
    host.logger.warn(
      'agent',
      `${boundary.wake ? 'WAIT_LIMIT' : 'LOCAL_WAIT_RECOVERY'} n=${wait.n} -> replan (${host.waitReplans}/${WAIT_REPLAN_LIMIT}) goal="${goalKey}"${host.noProductiveThisTick ? ' NO_PRODUCTIVE_CANDIDATE' : ''}${counted ? '' : ' SYSTEM2=false'}`,
      {
        actionId,
        count: wait.n,
        goal: goalKey,
        waitReplans: host.waitReplans,
        llmSummoned: counted,
        throttled: !counted,
        boundary: boundary.reason,
      },
      host.tickCounter,
    )
    return
  }
  if (wait.outcome === 'wedge') {
    host.abortWedge(
      `WAIT chosen ${wait.n}x on goal "${goalKey}" with no verified progress after ${host.waitReplans} replan(s)`,
    )
  }
}


export function abortWedge(host: WedgeHost,
reason: string): void {
  if (host.wedgeAborted) return
  host.wedgeAborted = true
  host.wedgeReason = reason
  host.logger.error('agent', `ABORT: wedge detected (${reason})`, { reason }, host.tickCounter)
  process.stdout.write(`\n[agent] ABORT: wedge detected (${reason})\n`)
  host.finish('wedge', false)
}
