// outcome-ledgers.ts — the settled-outcome ledgers extracted from
// controller-legacy.ts: deterministic records of what already happened.
// Owns the cross-action repeated-outcome ledger (one typed outcome repeating
// at one cell), the coordinate move-failure memory and its blacklist filters,
// the per-candidate failure counters, the typed action-failure streak, and
// the zero-observable-change route records. These are evidence and pruning
// ledgers, never semantic authority: withheld candidates are simply removed
// from the offer and every wake still crosses host.escalate.
//
// Seam: filterMoveCandidates, breakFailureDeadlock and noteCandidateFailure
// are patched through controller.ts internals, and escalate is too, so
// in-module calls to those names go through the host and the class keeps
// one-line delegates everywhere.

import { isZeroProgressOutcome } from '../actionPostcondition.ts'
import type { TruthfulOutcome } from '../actionPostcondition.ts'
import type { Candidate } from '../candidates.ts'
import type { JevAgentOptions } from '../controller-shared.ts'
import type { EscalationReason } from './escalation.ts'
import type { PendingDecision } from './decision-epochs.ts'
import type { ExecutionResult } from '../executor.ts'
import { decayedFailureCount, failureCount, spatialFailureKey } from '../failureMemory.ts'
import type { GoalQueue } from '../goalQueue.ts'
import type { EventLogger } from '../jev.ts'
import { formatLocomotionObservation, isEfficientLocomotionProgress } from '../locomotion.ts'
import type { LocomotionObservation } from '../locomotion.ts'
import { filterBlacklistedMoves, formatMoveFailMem, formatMoveFailMemReset, formatMoveTargetSkipped, isTrackedMoveKind, MoveFailMemory, moveFailureKey } from '../moveFailMemory.ts'
import type { MoveFailurePathScope, MoveFailureReason } from '../moveFailMemory.ts'
import { formatMoveUnreachable, MOVE_VERTICAL_GAP_LIMIT, unreachableMove } from '../policy.ts'
import { actionShapeOf, filterRetiredRepeats, formatActionRepeat, formatActionTargetRetired, isRepeatTrackedKind, RepeatedOutcomeEscalation, repeatedOutcomeCell, repeatedOutcomeFactSignature, repeatedOutcomeSemanticProgress, repeatedOutcomeToken } from '../repeatedOutcomeEscalation.ts'
import { formatActionFailureExhausted, formatActionFailureRepeat } from '../replanThrottle.ts'
import type { ActionFailureEscalation } from '../replanThrottle.ts'
import { KNOWN_RETRIEVE_RETIRE_LIMIT } from './retrieval-progress.ts'
import type { DecisionScheduler } from '../scheduler.ts'
import type { AgentSignals, Vec3Json, WorldState } from '../state.ts'
import { DIG_PATH_CAP } from '../worldMemory.ts'
import type { DigMemory } from '../worldMemory.ts'
import {
  cellKey,
  clearZeroProgressStand,
  clearZeroProgressTarget,
  formatActionZeroProgress,
  formatDescendRetired,
  formatRetrieveRetired,
  formatRetrieveRouteBlocked,
  formatRouteSpent,
  formatRouteStageFailed,
  isZeroProgressRouteKind,
  observeZeroProgressRoute,
  routeFailureStage,
  routeSignature,
  ZERO_PROGRESS_STAND_ROUTE_LIMIT,
} from '../zeroProgressRoute.ts'
import type { ZeroProgressRoutes } from '../zeroProgressRoute.ts'
import type { Bot } from 'mineflayer'

// Below this windowed locomotion efficiency a verified MOVE is mechanical success
// without progress, so it must not clear the failure memory (issue #360).
export const MOVE_PROGRESS_EFFICIENCY_FLOOR = resolveEnvPositiveInt('BUDDY_MOVE_PROGRESS_EFFICIENCY_FLOOR', 20)
/** Issue #8: failed attempts at one coordinate before it is blacklisted. */
export const MOVE_FAILMEM_LIMIT = resolveEnvPositiveInt('BUDDY_MOVE_FAILMEM_LIMIT', 3)
/** Issue #8: how long a blacklisted coordinate stays skipped. */
export const MOVE_FAILMEM_COOLDOWN_MS = resolveEnvPositiveInt('BUDDY_MOVE_FAILMEM_COOLDOWN_MS', 30_000)
/** Issue #8: bound on tracked coordinates (least-failed/oldest evicted first). */
export const MOVE_FAILMEM_MAX_ENTRIES = resolveEnvPositiveInt('BUDDY_MOVE_FAILMEM_MAX_ENTRIES', 256)
function resolveEnvPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export interface OutcomeLedgersHost {
  readonly actionFailureEscalation: ActionFailureEscalation
  actionStart: Vec3Json | null
  readonly bot: Bot
  candidateFailureAt: Map<string, number>
  candidateFailures: Map<string, number>
  currentGoalKey(): string
  digMemory: DigMemory
  escalate(reason: EscalationReason, detail: string): void
  groundingFingerprints: Map<string, string>
  lastLocomotionObservation: LocomotionObservation
  lastMoveTarget: { dimension: string; position: Vec3Json } | null
  readonly loggedRetiredRepeats: Set<string>
  readonly loggedUnreachableMoves: Set<string>
  logger: EventLogger
  moveFailMemory: MoveFailMemory
  readonly movePathFailureGenerationId: string
  noteCandidateFailure(candidateId: string): void
  options: JevAgentOptions
  previousMoveTarget: { dimension: string; position: Vec3Json } | null
  queue: GoalQueue
  recentEvents: string[]
  repeatedOutcomes: RepeatedOutcomeEscalation
  repeatedOutcomesPersisted: string
  scheduler: DecisionScheduler
  signals: AgentSignals
  readonly tickCounter: number
  zeroProgressRoutes: ZeroProgressRoutes
  candidateFailureCount(candidateId: string): number
  currentDimension(): string
  failureSnapshot(): Record<string, number>
  movePathFailureScope(state?: WorldState | null): MoveFailurePathScope | null
  notifyMoveFailureMemory(): void
  notifyRepeatedOutcomes(): void
  recordMoveFailure(candidate: Candidate, reason: MoveFailureReason): void
  resetDescendBudgetAfterWorldChange(actionId: string, reason: 'verified_mine' | 'verified_move'): void
}

export function createMoveFailMemory(host: OutcomeLedgersHost): MoveFailMemory {
  return new MoveFailMemory({
    failureLimit: MOVE_FAILMEM_LIMIT,
    cooldownMs: MOVE_FAILMEM_COOLDOWN_MS,
    maxEntries: MOVE_FAILMEM_MAX_ENTRIES,
    initialEntries: host.options.moveFailureEntries,
  })
}

/**
 * The durable cross-action repeat ledger. `limit` comes from the module's ONE
 * bound (`REPEATED_OUTCOME_LIMIT_DEFAULT`, overridable by
 * `BUDDY_REPEATED_OUTCOME_LIMIT`); it is never re-derived here.
 */
export function createRepeatedOutcomes(host: OutcomeLedgersHost): RepeatedOutcomeEscalation {
  return new RepeatedOutcomeEscalation({
    limit: host.options.repeatedOutcomeLimit,
    initialEntries: host.options.repeatedOutcomeEntries,
  })
}

/**
 * Persist the ledger through the HOST-owned class-A store, deduped on the
 * serialized form so an unchanged ledger proposes no delta at all. Mirrors
 * `notifyMoveFailureMemory`.
 */
export function notifyRepeatedOutcomes(host: OutcomeLedgersHost): void {
  const callback = host.options.onRepeatedOutcomeChange
  if (callback === undefined) return
  const snapshot = host.repeatedOutcomes.snapshot()
  const serialized = JSON.stringify(snapshot)
  if (serialized === host.repeatedOutcomesPersisted) return
  host.repeatedOutcomesPersisted = serialized
  try {
    callback(snapshot)
  } catch (error) {
    host.logger.warn(
      'agent',
      'REPEATED_OUTCOME_PERSIST_FAILED',
      { message: error instanceof Error ? error.message : String(error) },
      host.tickCounter,
    )
  }
}

export function notifyMoveFailureMemory(host: OutcomeLedgersHost): void {
  const callback = host.options.onMoveFailureMemoryChange
  if (callback === undefined) return
  try {
    callback(host.moveFailMemory.snapshot().map((entry) => ({ ...entry })))
  } catch (error) {
    host.logger.warn('agent', 'MOVE_FAILMEM_PERSIST_FAILED', { message: error instanceof Error ? error.message : String(error) }, host.tickCounter)
  }
}

export function failureSnapshot(host: OutcomeLedgersHost): Record<string, number> {
  const now = Date.now()
  const snapshot: Record<string, number> = {}
  for (const [id, count] of host.candidateFailures) {
    const age = now - (host.candidateFailureAt.get(id) ?? now)
    const decayed = decayedFailureCount(count, age)
    if (decayed > 0) snapshot[id] = decayed
  }
  return snapshot
}

export function candidateFailureCount(host: OutcomeLedgersHost, candidateId: string): number {
  return failureCount(host.failureSnapshot(), candidateId)
}

export function noteCandidateFailure(host: OutcomeLedgersHost, candidateId: string): void {
  const now = Date.now()
  host.candidateFailures.set(candidateId, (host.candidateFailures.get(candidateId) ?? 0) + 1)
  host.candidateFailureAt.set(candidateId, now)
  const spatial = spatialFailureKey(candidateId)
  if (spatial !== null) {
    host.candidateFailures.set(spatial, (host.candidateFailures.get(spatial) ?? 0) + 1)
    host.candidateFailureAt.set(spatial, now)
  }
  host.signals.failedCandidates = host.failureSnapshot()
}

export function noteCandidateSuccess(host: OutcomeLedgersHost, candidateId: string): void {
  host.candidateFailures.delete(candidateId)
  host.candidateFailureAt.delete(candidateId)
  const spatial = spatialFailureKey(candidateId)
  if (spatial !== null) {
    host.candidateFailures.delete(spatial)
    host.candidateFailureAt.delete(spatial)
  }
  host.signals.failedCandidates = host.failureSnapshot()
}

/**
 * Issue #78 follow-up: bounded escalation for a typed ACTION failure that
 * repeats identically. `recordFailure` charges every typed failure, but the
 * local-recovery route failures (`path_stuck`, `path_no_path`, ...) are
 * deliberately excluded from `same_failure_3x`, and the #44/#78 replan
 * throttle only advances on suppressed replans. Nothing therefore bounded the
 * loop where the SAME plan is re-offered and its action fails the SAME way.
 *
 * Counts consecutive identical `(plan, actionId, reason)` failures. On the Nth
 * the failure is reclassified as a semantic boundary: `ACTION_FAILURE_EXHAUSTED`
 * is logged and the existing `same_failure_3x -> action_impossible` escalation
 * vocabulary is used. The pending streak is exposed through `replanInputs()`
 * so the #44 throttle cannot suppress this one wake as `no_new_info`; that
 * keeps it "exactly like #326" rather than a parallel wake path.
 *
 * The counter resets on a different plan/action/reason (in the counter), on
 * any observed progress (in `onActionComplete`), and here after the escalation
 * is handed off, so it cannot hot-loop. Failures already owned by another
 * handler (a verified/done action, a scheduled PLACE retry, or an unverified
 * postcondition handled by `onUnverifiedAction`) never reach this method.
 */
export function noteTypedActionFailure(host: OutcomeLedgersHost, reason: string, actionId: string, pending: PendingDecision | undefined): void {
  const planKey = pending?.record.goalQueueState.current?.id ?? host.queue.current?.id ?? host.currentGoalKey()
  const decision = host.actionFailureEscalation.noteFailure(planKey, actionId, reason)
  host.logger.warn(
    'agent',
    formatActionFailureRepeat(decision),
    {
      planId: planKey,
      actionId,
      reason,
      count: decision.count,
      limit: decision.limit,
    },
    host.tickCounter,
  )
  if (!decision.escalate) return
  host.logger.warn(
    'agent',
    formatActionFailureExhausted(decision),
    {
      planId: planKey,
      actionId,
      reason,
      count: decision.count,
      limit: decision.limit,
      boundary: 'semantic_boundary',
    },
    host.tickCounter,
  )
  // Reuse the existing escalation vocabulary. `replanInputs()` carries the
  // exhausted streak, so the throttle releases this one wake; #78's own bound
  // remains the backstop if the throttle still refuses it.
  host.escalate(
    'same_failure_3x',
    `ACTION_FAILURE_EXHAUSTED plan=${planKey} action=${actionId} reason=${reason} count=${decision.count}/${decision.limit}`,
  )
  host.actionFailureEscalation.reset()
}

/**
 * If every actionable candidate has exhausted its retries, escalate so System 2
 * gets a chance to change the approach. Failure memory is NOT cleared: it decays
 * on its own, and wiping it would let a nearby coordinate evade the spatial
 * memory that #8a introduced.
 */
export function breakFailureDeadlock(host: OutcomeLedgersHost, candidates: readonly Candidate[]): void {
  const actionable = candidates.filter(
    (candidate) => candidate.kind !== 'WAIT' && candidate.kind !== 'ESCALATE',
  )
  if (actionable.length === 0) return
  const allExhausted = actionable.every(
    (candidate) => host.candidateFailureCount(candidate.id) >= host.options.candidateFailureLimit,
  )
  if (!allExhausted) return
  const localRouteOnly = actionable.every(
    (candidate) => candidate.kind === 'MOVE' || candidate.kind === 'RETRIEVE' || candidate.kind === 'DESCEND' || candidate.kind === 'STEP',
  )
  if (localRouteOnly) {
    host.logger.warn(
      'agent',
      `LOCAL_CANDIDATES_EXHAUSTED count=${actionable.length} system2=false grounded_recovery=true`,
      { candidates: actionable.map((candidate) => candidate.id), limit: host.options.candidateFailureLimit },
      host.tickCounter,
    )
    return
  }
  host.escalate(
    'all_candidates_invalid',
    `all ${actionable.length} actionable candidate(s) exceeded ${host.options.candidateFailureLimit} failures; letting decay/suppression reroute instead of clearing memory`,
  )
  host.recentEvents.push('all local candidates exhausted; waiting for decay/spatial suppression to reroute')
}

/**
 * The postcondition layer owns the verdict (`isZeroProgressOutcome` is a
 * FAILURE). This owns what happens NEXT for the route families whose
 * postcondition is a world change (RETRIEVE/DESCEND/STEP/ENTER_PORTAL):
 *
 *   - a completed action clears the zero-progress memory at its stand cell
 *     (and for its target), so a transient blockage is never permanent;
 *   - a route candidate that settled FAILED at any executor stage - the path
 *     stage (`PATH_CALLBACK phase=failed outcome=noPath|stuck`) included - is
 *     recorded as the exact route (kind, target, stand cell, route signature)
 *     that just proved it cannot complete, even when the lease also produced
 *     lenient body progress. The candidate layer withholds that exact repeat,
 *     so the next attempt for the target must differ in a grounded way (a
 *     different vertical plan, a different stand cell, or a travel/approach
 *     leg);
 *   - `ZERO_PROGRESS_STAND_ROUTE_LIMIT` distinct zero-progress routes at one
 *     stand cell exhaust that family there (`DESCEND_RETIRED`), which forces a
 *     route change instead of sampling new cells from the same blocked body
 *     position;
 *   - every route fact is mirrored as the typed `ROUTE_STAGE_FAILED` /
 *     `ROUTE_SPENT` marker, and a route arm that can ground no alternative at
 *     all reports `ROUTE_ESCALATE ... reason=all_routes_spent` (see
 *     `noteRouteExhaustion`), so the resident log can never again show an
 *     unchanged failing route being re-offered with no typed cause.
 *
 * Live evidence (run-muc3qbug-18vg3): 82 zero-observable chains in ten minutes,
 * 75 of them `DESCEND:down:<dir>:b...` steps whose dig removed nothing
 * (`outcome=noPath|stuck`), each with a fresh candidate id but the SAME body
 * cell - a per-id failure memory can never see that as one failure.
 *
 * Live evidence (run-muc620xb-1d312): the route memory DID record
 * `ACTION_ZERO_PROGRESS ... kind=ENTER_PORTAL retry=1..20 stand=10,54,25` with
 * an UNCHANGED signature, but nothing consumed it for the entry arm, so
 * `ENTER:26,67,9` was re-offered 669 times. The typed markers above make the
 * next measurement of this shape unambiguous.
 */
/**
 * True when a MOVE candidate is a ROUTE (its own meta declares the mechanical
 * work it does), as opposed to an ordinary walk. The route keys are the ones the
 * candidate layer and the executor already use.
 */
const ROUTE_MOVE_META_KEYS = [
  'vertical',
  'digRoute',
  'digStep',
  'bridgeBlock',
  'bridge',
  'levelScan',
  'contactAscent',
  'pillarPlaceName',
  'submersionEscape',
] as const

export function isRouteDeclaredMove(candidate: Candidate): boolean {
  return ROUTE_MOVE_META_KEYS.some((key) => candidate.meta[key] !== undefined)
}

export function recordZeroProgressOutcome(
  host: OutcomeLedgersHost,
  result: ExecutionResult,
  candidate: Candidate,
  truthful: TruthfulOutcome,
): void {
  if (!isZeroProgressRouteKind(result.kind)) return
  // A plain WALK is not tracked here (its memory is `moveFailMemory` and the
  // distance it closed is its progress). A MOVE that DECLARES a route is: its
  // postcondition is a mechanical change (a pillar/dig/place/bridge/scan leg),
  // and one that settles SUCCESS with nothing observable changed is spent -
  // otherwise it re-offers forever from the same stand cell.
  if (result.kind === 'MOVE' && !isRouteDeclaredMove(candidate)) return
  const stand = host.actionStart
  if (stand === null) return
  const standKey = cellKey(stand)
  const targetKey = candidate.target === null ? null : cellKey(candidate.target)
  if (truthful.verified) {
    const clearedStand = clearZeroProgressStand(host.zeroProgressRoutes, result.kind, standKey)
    const clearedTarget =
      targetKey === null ? clearedStand : clearZeroProgressTarget(clearedStand, result.kind, targetKey)
    if (clearedTarget !== host.zeroProgressRoutes) {
      host.zeroProgressRoutes = clearedTarget
      host.signals.zeroProgressRoutes = clearedTarget
    }
    return
  }
  if (candidate.target === null) return
  // A route candidate that settled FAILED at an executor stage is a spent
  // route for its exact identity even when the lenient body-progress signal
  // rode along with it: `PATH_CALLBACK phase=failed outcome=noPath|stuck`
  // settles `failed`, but a lease that also nudged the body carries
  // `progressed=true`, and that must not make the same route re-offerable from
  // the same stand cell. A body that really moved stands in a different cell,
  // which is a different identity and a fresh attempt.
  const stage = result.status === 'failed' ? routeFailureStage(result.failure) : null
  if (stage === null) {
    if (!isZeroProgressOutcome(result)) return
  }
  const decision = observeZeroProgressRoute(host.zeroProgressRoutes, {
    kind: result.kind,
    targetKey: cellKey(candidate.target),
    standKey,
    routeSig: routeSignature({ kind: candidate.kind, id: candidate.id, meta: candidate.meta }),
    reason: result.failure ?? result.status,
    nowMs: Date.now(),
  })
  host.zeroProgressRoutes = decision.routes
  host.signals.zeroProgressRoutes = decision.routes
  if (stage !== null) {
    // The typed stage fact: WHERE the route broke, so a path-stage failure is
    // never again only a `PATH_CALLBACK` line with an unchanged offer.
    host.logger.warn(
      'agent',
      formatRouteStageFailed({
        kind: result.kind,
        target: candidate.target,
        stand,
        stage,
        failure: result.failure,
      }),
      { actionId: result.actionId, kind: result.kind, target: candidate.target, stand, stage, failure: result.failure },
      host.tickCounter,
    )
  }
  if (decision.routeSpentNow) {
    host.logger.warn(
      'agent',
      formatRouteSpent(result.kind, candidate.target, decision.attempts),
      {
        actionId: result.actionId,
        kind: result.kind,
        target: candidate.target,
        attempts: decision.attempts,
        routeSig: decision.entry.routeSig,
      },
      host.tickCounter,
    )
  }
  host.logger.warn(
    'agent',
    formatActionZeroProgress({
      action: result.actionId,
      target: candidate.target,
      kind: result.kind,
      retry: decision.attempts,
      routeChanged: decision.routeChanged,
      stand,
    }),
    {
      actionId: result.actionId,
      kind: result.kind,
      target: candidate.target,
      stand,
      retry: decision.attempts,
      routeChanged: decision.routeChanged,
      routeSig: decision.entry.routeSig,
    },
    host.tickCounter,
  )
  if (result.kind === 'DESCEND' && decision.familyExhausted) {
    host.logger.warn(
      'agent',
      formatDescendRetired('zero_progress_exhausted', stand, decision.familyAttempts),
      { stand, routes: decision.familyAttempts, limit: ZERO_PROGRESS_STAND_ROUTE_LIMIT },
      host.tickCounter,
    )
  }
  if (result.kind === 'RETRIEVE') {
    if (decision.attempts >= KNOWN_RETRIEVE_RETIRE_LIMIT) {
      host.logger.warn(
        'agent',
        formatRetrieveRetired('zero_progress_budget', candidate.target, decision.attempts),
        { target: candidate.target, attempts: decision.attempts, limit: KNOWN_RETRIEVE_RETIRE_LIMIT },
        host.tickCounter,
      )
    }
    if (candidate.meta.retrieval === 'known') {
      // This exact route is now withheld from this stand cell: re-offering it
      // would be the same action with unchanged preconditions.
      host.logger.warn(
        'agent',
        formatRetrieveRouteBlocked('zero_progress_route_unchanged', candidate.target, stand),
        { target: candidate.target, stand, retry: decision.attempts },
        host.tickCounter,
      )
    }
  }
}

/**
 * The cross-action bound. One settled action, one typed outcome, one target.
 *
 * The measured class this closes (`m3-live`, read-only): `ASCEND:habitat:p3_68_22`
 * produced 184 typed failures (`PILLAR_FAIL step=apex reason=apex_missed` 160,
 * `step=place reason=refused` 23, one timeout) across 161 attempts in 24m38s at
 * ONE cell, interleaved with `PILLAR_UP_STEP` successes, with no
 * `PILLAR_RETIRE`/`PILLAR_RELOCATE` and zero escalations of any kind.
 *
 * It is deliberately NOT gated on `progressKinds` containing `body`: the
 * interleaved step reports `progress=body` while the same action keeps
 * concluding the same typed outcome at the same cell, and per
 * `buddy-driver/AGENTS.md` section 5 body motion is never completion. The
 * streak is advanced only while the typed outcome AND the target's affordance
 * fact signature are byte-identical, so a genuinely new fact still restarts it.
 */
export function noteRepeatedOutcome(
  host: OutcomeLedgersHost,
  result: ExecutionResult,
  candidate: Candidate,
  verified: boolean,
  progressKinds: readonly string[],
): void {
  if (!isRepeatTrackedKind(candidate.kind)) return
  const dimension = host.currentDimension()
  const actionShape = actionShapeOf(result.actionId)
  const cell = repeatedOutcomeCell(dimension, candidate.target, host.bot.entity.position)
  const outcome = repeatedOutcomeToken({ failure: result.failure, status: result.status, verified })
  // The affordance fingerprint is the gate's own "did any fact that could
  // re-open this target change?" digest; when the gate did not evaluate this
  // candidate this tick, a stable world-identity token stands in - never the
  // body position, which is what laundered the measured loop.
  const affordanceFingerprint =
    host.groundingFingerprints.get(candidate.id) ??
    host.groundingFingerprints.get(result.actionId) ??
    'no-affordance-evaluation'
  const factSignature = repeatedOutcomeFactSignature({
    affordanceFingerprint,
    planIdentity: host.queue.current?.id ?? null,
    worldKey: `${dimension}|epoch=${host.options.worldEpoch}`,
  })
  const decision = host.repeatedOutcomes.note({
    actionId: result.actionId,
    actionShape,
    cell,
    outcome,
    failureCode: result.failure,
    // `body` is mechanical motion, not semantic progress (`strategicStall.ts`
    // keeps its window open across it, and the taxonomy's semantic kinds are
    // `goal`/`search`). The measured runaway alternated a `progress=body`
    // success with an `apex_missed` failure at ONE cell for 24m38s with
    // `progressDelta=0` on both halves; reading the success half as new
    // information is what kept every existing counter at 1.
    semanticProgress: repeatedOutcomeSemanticProgress({
      progressKinds,
      itemsGained: result.itemsGained,
      blockRemoved: result.blockRemoved === true,
    }),
    factSignature,
    now: Date.now(),
  })
  if (decision.count > 1) {
    host.logger.warn(
      'agent',
      formatActionRepeat(decision),
      {
        actionId: result.actionId,
        kind: candidate.kind,
        cell,
        outcome,
        count: decision.count,
        limit: decision.limit,
        restarted: decision.restarted,
        escalated: decision.escalate,
      },
      host.tickCounter,
    )
  }
  if (decision.escalate) {
    host.logger.warn(
      'agent',
      // `decision.line` is the escalation form when `escalate` is true; it names
      // the action, the shape, the cell, the repeated outcome, the count, the
      // bound and the consequence. Mirrored, so it reaches the live record.
      decision.line,
      {
        actionId: result.actionId,
        kind: candidate.kind,
        cell,
        outcome,
        count: decision.count,
        limit: decision.limit,
        bound: decision.limit,
        consequence: 'retire_target',
        boundary: 'mechanical_invalidity',
      },
      host.tickCounter,
    )
  }
  if (decision.escalate || decision.restarted !== null) host.notifyRepeatedOutcomes()
}

/**
 * The consequence of the cross-action bound: an `(action shape, cell)` proven
 * unable to progress there leaves the offered set, which forces the offer onto
 * a different target - the bounded relocation. Same mechanical-invalidity shape
 * as `filterMoveCandidates`, and it never ranks or substitutes a semantic
 * alternative: what remains is still offered to Jev unchanged.
 */
export function filterRepeatedOutcomeCandidates(
  host: OutcomeLedgersHost,
  candidates: readonly Candidate[],
  state: WorldState,
  log = true,
): Candidate[] {
  const { kept, withheld } = filterRetiredRepeats(
    candidates,
    host.repeatedOutcomes,
    state.self.dimension,
    host.bot.entity.position,
  )
  if (!log) return kept
  for (const entry of withheld) {
    // Deduped per retirement so a retired target is ONE typed line, not a
    // per-tick flood. A re-retirement after a fact change carries a new count,
    // so it logs again.
    const dedupKey = `${entry.key}|${entry.outcome}|${entry.count}`
    if (host.loggedRetiredRepeats.has(dedupKey)) continue
    host.loggedRetiredRepeats.add(dedupKey)
    host.logger.warn(
      'agent',
      formatActionTargetRetired({
        actionId: entry.candidate.id,
        actionShape: entry.actionShape,
        cell: entry.cell,
        outcome: entry.outcome,
        count: entry.count,
        limit: entry.limit,
      }),
      {
        actionId: entry.candidate.id,
        kind: entry.candidate.kind,
        key: entry.key,
        actionShape: entry.actionShape,
        cell: entry.cell,
        outcome: entry.outcome,
        count: entry.count,
        limit: entry.limit,
        consequence: 'withheld_from_offer',
      },
      host.tickCounter,
    )
  }
  return kept
}

/**
 * Keep controller failure-memory charging on the same mechanical predicate
 * as the affordance/policy gate. In particular, a generated vertical plan
 * is executable even when its target is more than the horizontal pathfinder
 * gap above the bot.
 */
export function controllerUnreachableMoveReason(candidate: Candidate, state: WorldState): ReturnType<typeof unreachableMove> {
  return unreachableMove(candidate, state)
}

/**
 * Issue #43: a MOVE/RETRIEVE target above the climb limit is unreachable with
 * `canDig=false`. Log it and charge the failure memory so repeated selection
 * exhausts MOVE_FAILURE_LIMIT and the generator stops re-issuing it, letting
 * another candidate (descend/explore/reachable target) win instead.
 */
export function checkUnreachableMove(host: OutcomeLedgersHost, candidate: Candidate, state: WorldState): void {
  const reason = controllerUnreachableMoveReason(candidate, state)
  if (reason === null) return
  const { target, dy } = reason
  const key = `${candidate.id}:${dy}`
  if (!host.loggedUnreachableMoves.has(key)) {
    host.loggedUnreachableMoves.add(key)
    host.logger.warn(
      'agent',
      formatMoveUnreachable(target, dy),
      { actionId: candidate.id, dy, kind: candidate.kind, limit: MOVE_VERTICAL_GAP_LIMIT },
      host.tickCounter,
    )
  }
  host.noteCandidateFailure(candidate.id)
  host.recordMoveFailure(candidate, 'unreachable')
}

/** #8: drop movement targets still inside their blacklist cooldown. */
export function filterMoveCandidates(host: OutcomeLedgersHost, candidates: readonly Candidate[], state: WorldState, log = true): Candidate[] {
  const dimension = state.self.dimension
  const { kept, skipped } = filterBlacklistedMoves(
    candidates,
    host.moveFailMemory,
    dimension,
    host.movePathFailureScope(state),
  )
  if (!log) return kept
  for (const entry of skipped) {
    host.logger.warn(
      'agent',
      formatMoveTargetSkipped(entry.key, entry.attempts, entry.cooldownSeconds),
      {
        actionId: entry.candidate.id,
        key: entry.key,
        attempts: entry.attempts,
        cooldown: entry.cooldownSeconds,
        reason: entry.reason,
      },
      host.tickCounter,
    )
  }
  return kept
}

export function rememberMoveTarget(host: OutcomeLedgersHost, candidate: Candidate): void {
  if (candidate.target === null || !isTrackedMoveKind(candidate.kind)) return
  const previous = host.lastMoveTarget
  if (previous !== null) host.previousMoveTarget = previous
  host.lastMoveTarget = { dimension: host.currentDimension(), position: { ...candidate.target } }
}

export function recordMoveFailure(host: OutcomeLedgersHost, candidate: Candidate, reason: MoveFailureReason): void {
  if (candidate.target === null || !isTrackedMoveKind(candidate.kind)) return
  const dimension = host.currentDimension()
  const pathFailureScope = reason === 'no_path' ? host.movePathFailureScope() : null
  const result =
    pathFailureScope === null
      ? host.moveFailMemory.record(dimension, candidate.target, reason)
      : host.moveFailMemory.recordPathFailure(dimension, candidate.target, pathFailureScope)
  const key = moveFailureKey(dimension, candidate.target)
  host.logger.warn(
    'agent',
    formatMoveFailMem(key, result.entry.attempts, reason),
    { actionId: candidate.id, key, attempts: result.entry.attempts, reason, kind: candidate.kind },
    host.tickCounter,
  )
  host.notifyMoveFailureMemory()
  if (!result.newlyBlacklisted) return
  host.logger.warn(
    'agent',
    formatMoveTargetSkipped(key, result.entry.attempts, remainingCooldownSeconds(result.entry.blacklistedUntil)),
    { actionId: candidate.id, key, attempts: result.entry.attempts, reason },
    host.tickCounter,
  )
}

/** Complete witness for reusing a path refusal; null disables state-scoped suppression. */
export function movePathFailureScope(host: OutcomeLedgersHost, state?: WorldState | null): MoveFailurePathScope | null {
  const worldRevision = host.scheduler.worldRevision
  if (worldRevision === null) return null
  const position = state?.self.position ?? host.bot.entity.position
  if (![position.x, position.y, position.z].every(Number.isFinite)) return null
  return {
    origin: { x: position.x, y: position.y, z: position.z },
    worldRevision,
    generationId: host.movePathFailureGenerationId,
  }
}

/**
 * Telemetry truth for a skip: the cooldown actually in force, including the
 * #360 oscillation escalation. Reporting the base cooldown would log
 * `cooldown=30` for a 60 s/10 min escalated suppression, which is exactly the
 * "skip logged, surface unchanged" shape this fix closes.
 */
export function remainingCooldownSeconds(blacklistedUntil: number, now = Date.now()): number {
  return Math.max(0, Math.ceil((blacklistedUntil - now) / 1000))
}

export function recordMoveSuccess(host: OutcomeLedgersHost, candidate: Candidate): void {
  if (candidate.target === null || !isTrackedMoveKind(candidate.kind)) return
  host.resetDescendBudgetAfterWorldChange(candidate.id, 'verified_move')
  const dimension = host.currentDimension()
  const key = moveFailureKey(dimension, candidate.target)
  // A verified MOVE inside an idle, unobserved or low-efficiency window is mechanical success, not
  // progress. Resetting the failure memory there is exactly what let the live
  // 48-minute A<->B loop undo every oscillation blacklist (issue #360: 401
  // OSCILLATION_DETECTED vs 49 blacklists, 1533 blocks travelled in a one-block
  // box). Keeping the memory means the loop's own cells stay suppressed and the body
  // must change neighbourhood instead of re-winning the same step.
  if (!isEfficientLocomotionProgress(host.lastLocomotionObservation, MOVE_PROGRESS_EFFICIENCY_FLOOR)) {
    host.logger.info(
      'agent',
      `MOVE_FAILMEM_RESET_SKIPPED ${formatLocomotionObservation(host.lastLocomotionObservation)} reason=strategic_non_progress`,
      { actionId: candidate.id, key, locomotion: host.lastLocomotionObservation },
      host.tickCounter,
    )
    return
  }
  if (!host.moveFailMemory.reset(dimension, candidate.target)) return
  if (host.lastMoveTarget !== null && host.lastMoveTarget.position.x === candidate.target.x && host.lastMoveTarget.position.z === candidate.target.z) {
    host.lastMoveTarget = null
  }
  host.logger.info('agent', formatMoveFailMemReset(key), { actionId: candidate.id, key, kind: candidate.kind }, host.tickCounter)
  host.notifyMoveFailureMemory()
}

export function resetDescendBudgetAfterWorldChange(host: OutcomeLedgersHost, actionId: string, reason: 'verified_mine' | 'verified_move'): void {
  const dig = host.digMemory.snapshot()
  if (reason === 'verified_move' && dig.digDirCount >= DIG_PATH_CAP) {
    host.digMemory.resetPath()
    host.logger.info(
      'agent',
      `DIG_PATH_RESET reason=cap_after_verified_move count=${dig.digDirCount}`,
      { actionId, previousCount: dig.digDirCount },
      host.tickCounter,
    )
  }
  if (!dig.descendLimitReached) return
  host.digMemory.resetDescendBudget()
  host.logger.info(
    'agent',
    `DESCEND_BUDGET_RESET actionId=${actionId} reason=${reason}`,
    { actionId, previousNoProgress: dig.descendNoProgress, reason },
    host.tickCounter,
  )
}

export function currentDimension(host: OutcomeLedgersHost): string {
  const game = host.bot.game
  return game === undefined ? 'overworld' : game.dimension
}
