// controller.ts - #11 authority facade around the legacy mechanical loop.
//
// The historical controller remains in controller-legacy.ts so the mechanical
// sensor/grounding/guard/executor/VERIFY implementation is preserved. This file
// is deliberately small: it removes only semantic authority that #11 assigns to
// Jev pi/beta, while leaving deterministic truth/safety/mechanics untouched.
//
// REAL Jev path:
//   code       = TRUE / CAN / SAFE / DONE
//   Jev pi     = WHICH grounded local candidate
//   Jev beta   = WHETHER current Option ends
//   System 2   = WHAT Option/intent comes next
//
// Explicit fallback/offline policy keeps the historical controller semantics as
// an A/B baseline. The strangler hooks below MUST NOT introduce a replacement
// ranking: they only stop legacy rank/retry/escalation branches from seizing
// semantic authority before Jev sees the grounded alternatives.

export * from './controller-legacy.ts'

import { JevController as LegacyJevController } from './controller-legacy.ts'
import type { Candidate } from './candidates.ts'
import type { ExecutionResult } from './executor.ts'
import { formatActionUnverified } from './actionPostcondition.ts'
import { abandonRequested } from './jev.ts'
import type { JevResult } from './jev.ts'
import type { WorldState } from './state.ts'
import type { BetaTerminationBoundaryDecision } from './system2/escalation.ts'

type ApplyFurnacePrereq = (
  state: WorldState,
  candidates: readonly Candidate[],
  unreachableStations: ReadonlySet<string>,
) => Candidate[]

type PendingLike = {
  record?: {
    goalQueueState?: { current?: { id?: string } | null }
    strategy?: string | null
  }
}

type AbandonVerdictLike = {
  adopt: boolean
  enforced: boolean
  suppressed: boolean
  classification: { attempts: number } & Record<string, unknown>
  vote: {
    adopt: boolean
    shadowed: boolean
    protection: unknown
  }
  optionId: string | null
  planId: string | null
}

type SemanticEscalation = { escalate: boolean; reason: string }

type LegacyInternals = {
  jev?: { kind?: string }
  options?: { betaAuthority?: boolean }

  // semantic selector seams we strangle on the real Jev path
  applyFurnacePrereq?: ApplyFurnacePrereq
  advancePrereqAfterUnverified?: () => boolean
  retireFailedKnownRetrieve?: (candidate: Candidate, result: ExecutionResult) => void
  abandonRetrieveOption?: (line: string, candidate: Candidate, unverified: number) => void
  onUnverifiedAction?: (result: ExecutionResult, postcondition: string, pending: PendingLike | undefined) => void
  abandonVerdict?: (decision: JevResult, optionId: string | null, planId: string | null) => AbandonVerdictLike
  betaTerminationBoundary?: (decision: JevResult, optionId: string | null) => BetaTerminationBoundaryDecision
  protectedReplanSuppressed?: (reason: string) => boolean
  filterMoveCandidates?: (candidates: readonly Candidate[], state: WorldState, log?: boolean) => Candidate[]
  blacklistedMoveTargets?: (state: WorldState) => ReadonlySet<string>
  unreachableStationKeys?: (state: WorldState) => ReadonlySet<string>
  breakFailureDeadlock?: (candidates: readonly Candidate[]) => void
  checkWedge?: (actionId: string) => void
  semanticEscalation?: (decision: JevResult) => SemanticEscalation
  escapeOscillation?: (state: unknown) => void
  abortWedge?: (reason: string) => void
  escalate?: (reason: string, detail: string) => void

  queue?: { current?: { id?: string } | null }
  actionUnverified?: Map<string, number>
  recentEvents?: string[]
  /**
   * #360: code-owned state-recurrence evidence. When it proves exhaustion, the
   * semantic layer is asked again even though beta's own vote stayed below its
   * abandon threshold; the evidence is still the only proof used.
   */
  signals?: { strategicNonProgress?: { exhausted: boolean } | null }
  retrieveUnverified?: unknown
  oscillationState?: unknown
  lastDecisionId?: string | null

  prereqPlan?: unknown
  prereqForcedPath?: unknown
  prereqChosenPath?: unknown
  prereqProgress?: unknown
  prereqLoggedKey?: unknown

  noteCandidateFailure?: (candidateId: string) => void
  logger?: {
    warn: (
      channel: string,
      message: string,
      detail?: Record<string, unknown>,
      tick?: number,
    ) => void
  }
  tickCounter?: number
}

/** Local failure signals that #11 says belong to pi/beta, not System2 WHAT. */
const LOCAL_POLICY_ESCALATIONS = new Set([
  'low_confidence',
  'same_failure_3x',
  'pathfinder_no_path',
  'pathfinder_stuck',
  'progress_stall',
])

function realJev(internals: LegacyInternals): boolean {
  return internals.jev?.kind !== 'fallback'
}

function betaIsAuthoritative(internals: LegacyInternals): boolean {
  return realJev(internals) && internals.options?.betaAuthority === true
}

function pushPolicyEvidence(internals: LegacyInternals, event: string): void {
  internals.recentEvents?.push(event)
  // Keep the in-memory history bounded even if the legacy loop has not reached
  // its own compaction point yet. Jev itself only receives the newest slice.
  if (internals.recentEvents !== undefined && internals.recentEvents.length > 128) {
    internals.recentEvents.splice(0, internals.recentEvents.length - 128)
  }
}

function clearLegacyPrereqSelection(internals: LegacyInternals): void {
  // These are selector state, not world truth. Keeping them populated would let
  // a later legacy branch silently restore one hand-picked prerequisite route.
  internals.prereqPlan = null
  internals.prereqForcedPath = null
  internals.prereqChosenPath = null
  internals.prereqProgress = null
  internals.prereqLoggedKey = null
}

/**
 * Public controller used by every normal generation.
 *
 * This subclass is a temporary strangler around the monolithic historical
 * controller. It intentionally patches only semantic selector seams. Once the
 * controller is decomposed (#120/#39), these become explicit injected policy
 * interfaces and controller-legacy.ts can be deleted.
 */
export class JevController extends LegacyJevController {
  constructor(...args: ConstructorParameters<typeof LegacyJevController>) {
    super(...args)

    const internals = this as unknown as LegacyInternals

    const legacyApplyPrereq = internals.applyFurnacePrereq?.bind(this)
    if (legacyApplyPrereq !== undefined) {
      internals.applyFurnacePrereq = (state, candidates, unreachableStations) => {
        if (!realJev(internals)) return legacyApplyPrereq(state, candidates, unreachableStations)

        // #11 canonical example: place-held vs known-station vs craft-and-place
        // are co-equal local alternatives for the SAME furnace prerequisite.
        // generateGroundedCandidates() already established their mechanical
        // feasibility; do not collapse them to one cost/rank winner here.
        clearLegacyPrereqSelection(internals)
        return [...candidates]
      }
    }

    const legacyAdvancePrereq = internals.advancePrereqAfterUnverified?.bind(this)
    if (legacyAdvancePrereq !== undefined) {
      internals.advancePrereqAfterUnverified = () => {
        if (!realJev(internals)) return legacyAdvancePrereq()
        // A zero-progress/unverified action is evidence for pi, not permission
        // for code to select the next semantic prerequisite path.
        clearLegacyPrereqSelection(internals)
        return false
      }
    }

    const legacyRetireRetrieve = internals.retireFailedKnownRetrieve?.bind(this)
    if (legacyRetireRetrieve !== undefined) {
      internals.retireFailedKnownRetrieve = (candidate, result) => {
        if (!realJev(internals)) {
          legacyRetireRetrieve(candidate, result)
          return
        }
        // #11 rejects fixed-attempt semantic retirement. Hard world-truth
        // staleness and current deterministic reachability still live in their
        // own subsystems; count/cooldown history stays evidence only.
        pushPolicyEvidence(
          internals,
          `known retrieve outcome: ${candidate.id} status=${result.status} verified=${result.verified} progress=${result.itemsGained}`,
        )
      }
    }

    const legacyAbandonRetrieve = internals.abandonRetrieveOption?.bind(this)
    if (legacyAbandonRetrieve !== undefined) {
      internals.abandonRetrieveOption = (line, candidate, unverified) => {
        if (!realJev(internals)) {
          legacyAbandonRetrieve(line, candidate, unverified)
          return
        }
        // Preserve the observation but do not convert N failures into a local
        // route switch or a System2 escalation. The next settled decision gives
        // pi the same grounded alternatives plus failure history.
        internals.retrieveUnverified = null
        internals.noteCandidateFailure?.(candidate.id)
        pushPolicyEvidence(
          internals,
          `local retrieve unverified: ${candidate.id} attempts=${unverified}; semantic authority=jev_pi`,
        )
        internals.logger?.warn(
          'agent',
          `JEV_LOCAL_FAILURE action=${candidate.id} source=retrieve_unverified attempts=${unverified} authority=pi`,
          { actionId: candidate.id, attempts: unverified, legacyLine: line },
          internals.tickCounter,
        )
      }
    }

    const legacyUnverified = internals.onUnverifiedAction?.bind(this)
    if (legacyUnverified !== undefined) {
      internals.onUnverifiedAction = (result, postcondition, pending) => {
        if (!realJev(internals)) {
          legacyUnverified(result, postcondition, pending)
          return
        }

        const planId = pending?.record?.goalQueueState?.current?.id ?? internals.queue?.current?.id ?? null
        const strategy = pending?.record?.strategy ?? null
        const key = planId ?? result.actionId
        const attempts = (internals.actionUnverified?.get(key) ?? 0) + 1
        internals.actionUnverified?.set(key, attempts)
        internals.noteCandidateFailure?.(result.actionId)

        // Keep the full postcondition failure as bounded policy evidence. Do NOT
        // call the legacy retry-budget semantic controller, abandon by count,
        // pick another prerequisite path, or summon System2 solely because a
        // magic number was reached. beta sees this evidence and owns termination.
        const marker = formatActionUnverified({
          planId,
          actionId: result.actionId,
          strategy,
          postcondition,
        })
        pushPolicyEvidence(
          internals,
          `action unverified: ${result.actionId}; postcondition=${postcondition}; attempts=${attempts}`,
        )
        internals.logger?.warn(
          'agent',
          `${marker} authority=jev_pi_beta`,
          {
            planId,
            actionId: result.actionId,
            strategy,
            attempts,
            postcondition,
            progressDelta: result.itemsGained,
            detail: result.detail,
          },
          internals.tickCounter,
        )
      }
    }

    // Move failure count/cooldown memory remains useful evidence and a baseline,
    // but it cannot hide otherwise-grounded alternatives from real pi. Current
    // hard reachability is still enforced by generateGroundedCandidates + Guard.
    const legacyFilterMoves = internals.filterMoveCandidates?.bind(this)
    if (legacyFilterMoves !== undefined) {
      internals.filterMoveCandidates = (candidates, state, log) =>
        realJev(internals) ? [...candidates] : legacyFilterMoves(candidates, state, log)
    }

    const legacyBlacklistedTargets = internals.blacklistedMoveTargets?.bind(this)
    if (legacyBlacklistedTargets !== undefined) {
      internals.blacklistedMoveTargets = (state) =>
        realJev(internals) ? new Set<string>() : legacyBlacklistedTargets(state)
    }

    const legacyUnreachableStations = internals.unreachableStationKeys?.bind(this)
    if (legacyUnreachableStations !== undefined) {
      internals.unreachableStationKeys = (state) =>
        realJev(internals) ? new Set<string>() : legacyUnreachableStations(state)
    }

    const legacyDeadlock = internals.breakFailureDeadlock?.bind(this)
    if (legacyDeadlock !== undefined) {
      internals.breakFailureDeadlock = (candidates) => {
        if (!realJev(internals)) {
          legacyDeadlock(candidates)
          return
        }
        // "all candidates exceeded N failures" is not proof that the Option or
        // candidate set is structurally invalid. failedCandidates is already in
        // Jev's state; pi/beta decide from that evidence.
      }
    }

    const legacySemanticEscalation = internals.semanticEscalation?.bind(this)
    if (legacySemanticEscalation !== undefined) {
      internals.semanticEscalation = (decision) => {
        if (!realJev(internals)) return legacySemanticEscalation(decision)
        // should_retreat is local safety/recovery evidence. Guard/pi can retreat;
        // it is not itself a request for a different long-horizon WHAT.
        return { escalate: false, reason: 'local safety/recovery remains Jev pi + deterministic guard' }
      }
    }

    const legacyEscapeOscillation = internals.escapeOscillation?.bind(this)
    if (legacyEscapeOscillation !== undefined) {
      internals.escapeOscillation = (state) => {
        if (!realJev(internals)) {
          legacyEscapeOscillation(state)
          return
        }
        // Oscillation is an observation. Do not auto-abandon a retrieval, pick a
        // different prerequisite route, or wake System2. Expose it to pi/beta.
        internals.oscillationState = null
        if (internals.lastDecisionId !== null && internals.lastDecisionId !== undefined) {
          internals.noteCandidateFailure?.(internals.lastDecisionId)
        }
        pushPolicyEvidence(internals, `oscillation detected; semantic authority=jev_pi_beta`)
      }
    }

    const legacyCheckWedge = internals.checkWedge?.bind(this)
    if (legacyCheckWedge !== undefined) {
      internals.checkWedge = (actionId) => {
        if (!realJev(internals)) {
          legacyCheckWedge(actionId)
          return
        }
        // Repeated WAIT is history for pi/beta, not "N waits -> System2/abort".
        if (actionId === 'WAIT') pushPolicyEvidence(internals, 'Jev pi selected WAIT with no verified progress yet')
      }
    }

    const legacyAbortWedge = internals.abortWedge?.bind(this)
    if (legacyAbortWedge !== undefined) {
      internals.abortWedge = (reason) => {
        if (!realJev(internals)) {
          legacyAbortWedge(reason)
          return
        }
        // Wall-clock/count based no-progress is not a deterministic proof that
        // the process should abort. Preserve the evidence; beta owns whether the
        // Option ends and hard safety/lifecycle failures remain elsewhere.
        pushPolicyEvidence(internals, `wedge observation: ${reason}; termination authority=jev_beta`)
      }
    }

    const legacyEscalate = internals.escalate?.bind(this)
    if (legacyEscalate !== undefined) {
      internals.escalate = (reason, detail) => {
        if (!realJev(internals) || !LOCAL_POLICY_ESCALATIONS.has(reason)) {
          legacyEscalate(reason, detail)
          return
        }
        // Local path/stall/confidence/failure signals are compact policy memory.
        // They do not change WHAT. Structural reasons (goal complete, genuinely
        // empty frontier, death/world corruption, policy error) still reach the
        // legacy System2 handoff.
        pushPolicyEvidence(internals, `${reason}: ${detail}; semantic authority=jev_pi_beta`)
      }
    }

    const legacyAbandonVerdict = internals.abandonVerdict?.bind(this)
    if (legacyAbandonVerdict !== undefined) {
      internals.abandonVerdict = (decision, optionId, planId) => {
        const baseline = legacyAbandonVerdict(decision, optionId, planId)
        if (!betaIsAuthoritative(internals)) return baseline
        // With no current semantic Option there is nothing beta can end. Preserve
        // the non-authoritative baseline so telemetry and mutation stay aligned.
        if (optionId === null) return baseline

        const boundary = internals.betaTerminationBoundary?.(decision, optionId)
        if (abandonRequested(decision) && boundary !== undefined && !boundary.adopt) {
          const probability = decision.answers.abandon_option?.probability ?? null
          internals.logger?.warn(
            'heads',
            `BETA_DEFERRED option=${optionId} reason=${boundary.reason} beta=${probability}`,
            { optionId, planId, beta: probability, reason: boundary.reason, action: decision.answers.action?.value ?? null },
            internals.tickCounter,
          )
          return {
            ...baseline,
            adopt: false,
            enforced: false,
            suppressed: true,
            vote: {
              ...baseline.vote,
              adopt: false,
              shadowed: false,
            },
          }
        }

        // #11 beta v2: semantic termination has one owner. The legacy verdict is
        // retained only to preserve typed logging metadata; its attempt counts,
        // protection ladder and enforced/suppressed classification cannot alter
        // the live decision. Deterministic completion/hard invalidity still live
        // outside beta in the ordinary queue/guard/VERIFY path.
        //
        // #360 §11: `semanticExhausted` is code-owned proof (a full recurrence
        // window of verified body-only decisions with zero goal/search progress),
        // so it may cross the boundary even when beta's own probability stayed
        // below threshold. It still only ENDS the Option and hands off to System2
        // for WHAT; this layer never selects the replacement.
        const semanticExhausted = internals.signals?.strategicNonProgress?.exhausted === true
        const adopt = (abandonRequested(decision) || semanticExhausted) && (boundary?.adopt ?? true)
        return {
          ...baseline,
          adopt,
          enforced: false,
          suppressed: false,
          vote: {
            ...baseline.vote,
            adopt,
            shadowed: false,
          },
        }
      }
    }

    const legacyProtectedReplanSuppressed = internals.protectedReplanSuppressed?.bind(this)
    if (legacyProtectedReplanSuppressed !== undefined) {
      internals.protectedReplanSuppressed = (reason) => {
        if (!betaIsAuthoritative(internals)) return legacyProtectedReplanSuppressed(reason)
        // Once beta explicitly ended the Option, a queue-level prerequisite
        // protection heuristic must not veto the System2 handoff. System2 still
        // receives only grounded Option/plan ids and code still verifies truth.
        return false
      }
    }
  }
}
