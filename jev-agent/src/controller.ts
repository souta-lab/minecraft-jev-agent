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
  optionId: string
  planId: string | null
}

type LegacyInternals = {
  jev?: { kind?: string }
  options?: { betaAuthority?: boolean }
  applyFurnacePrereq?: ApplyFurnacePrereq
  advancePrereqAfterUnverified?: () => boolean
  retireFailedKnownRetrieve?: (candidate: Candidate, result: ExecutionResult) => void
  abandonRetrieveOption?: (line: string, candidate: Candidate, unverified: number) => void
  onUnverifiedAction?: (result: ExecutionResult, postcondition: string, pending: PendingLike | undefined) => void
  abandonVerdict?: (decision: JevResult, optionId: string, planId: string | null) => AbandonVerdictLike
  protectedReplanSuppressed?: (reason: string) => boolean

  queue?: { current?: { id?: string } | null }
  actionUnverified?: Map<string, number>
  recentEvents?: string[]
  retrieveUnverified?: unknown

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

function realJev(internals: LegacyInternals): boolean {
  return internals.jev?.kind !== 'fallback'
}

function betaIsAuthoritative(internals: LegacyInternals): boolean {
  return realJev(internals) && internals.options?.betaAuthority === true
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
        // staleness, reachability rejection and move-failure fingerprints still
        // live in their deterministic subsystems; this count-based selector does
        // not run on the real model path.
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
        internals.recentEvents?.push(
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
        internals.recentEvents?.push(
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

    const legacyAbandonVerdict = internals.abandonVerdict?.bind(this)
    if (legacyAbandonVerdict !== undefined) {
      internals.abandonVerdict = (decision, optionId, planId) => {
        const baseline = legacyAbandonVerdict(decision, optionId, planId)
        if (!betaIsAuthoritative(internals)) return baseline

        // #11 beta v2: semantic termination has one owner. The legacy verdict is
        // retained only to preserve typed logging metadata; its attempt counts,
        // protection ladder and enforced/suppressed classification cannot alter
        // the live decision. Deterministic completion/hard invalidity still live
        // outside beta in the ordinary queue/guard/VERIFY path.
        const adopt = abandonRequested(decision)
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
