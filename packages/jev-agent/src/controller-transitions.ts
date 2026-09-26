// controller-transitions.ts - kernel transition ownership for controller dispatch.
//
// Every mechanical dispatch the controller claims runs under exactly one
// kernel-admitted transition. This module owns that lifecycle so its
// invariants are testable against the real kernel session:
//
//   - admission: compile the dispatch's family envelope, admit, activate;
//   - supersession: a different running action is cancelled AND its kernel
//     transition closed BEFORE the replacement is admitted (the replacement
//     acquires its resource bundle only after the incumbent's is released);
//   - closure: a typed non-SUCCESS terminal never mints truth;
//   - SUCCESS: requested only from the deterministic truthful outcome
//     (`truthfulActionOutcome` over live observation), never from the
//     executor's lenient `verified` flag; the kernel's VERIFY is final.
import type { Candidate } from './candidates.ts'
import type { ExecutionClaimContext, ExecutionResult } from './executor.ts'
import type { TruthfulOutcome } from './actionPostcondition.ts'
import { controllerTransitionToKernelSpec } from './reach/kernel-authority-map.ts'
import type { KernelTransitionAuthority } from './reach/kernel-authority-map.ts'
import { committedSkillKind, declaredPostconditions, postconditionHash } from './skillCommitment.ts'

/** Kernel EffectKind for each candidate-declared internal effect type. */
const INTERNAL_EFFECT_KERNEL_KIND = {
  dig: 'DIG',
  place: 'PLACE',
  equip: 'EQUIP',
} as const

/** Per-dispatch budget envelope for a controller transition. */
const CONTROLLER_MAX_MECHANICAL_STEPS = 512
const CONTROLLER_MAX_ACTIVE_MS = 15 * 60_000

/** The kernel transition a controller dispatch runs under. */
export interface ControllerAdmission {
  readonly transitionId: string
  readonly contractHash: string
  readonly family: string
  readonly predicateId: string
  /** true when the dispatch re-attached to the running action's transition */
  readonly reused: boolean
}

/** The slice of the executor this owner needs (consumer-owned interface). */
export interface ControllerTransitionExecutor {
  readonly current: {
    readonly id: string
    readonly status: string
    readonly authorityLabel?: string
    readonly transitionId?: string
    readonly transitionContractHash?: string
  } | null
  cancelCurrent(reason: string): void
}

export type ControllerTransitionLog = (level: 'info' | 'warn' | 'error', message: string, detail?: Record<string, unknown>) => void

export interface ControllerTransitionsDeps {
  readonly authority: KernelTransitionAuthority
  readonly executor: ControllerTransitionExecutor
  /** Server and epoch of the generation's world; the dimension comes from the dispatch observation. */
  readonly world: () => { readonly serverId: string; readonly worldEpoch: number }
  readonly log: ControllerTransitionLog
}

type ClaimProvenance = Pick<
  ExecutionClaimContext,
  'transitionId' | 'transitionContractHash' | 'authorityLabel' | 'beforeMechanicalStep' | 'afterMechanicalStep' | 'internalEffectCallbacks'
>

export class ControllerTransitions {
  /** Per-dispatch sequence keeping kernel transition ids unique across retries of one candidate. */
  private sequence = 0

  constructor(private readonly deps: ControllerTransitionsDeps) {}

  /**
   * Cancel a different running action and close its kernel transition now.
   * The incumbent's own completion handler later re-terminalizes idempotently.
   * A Reach-owned action is never superseded from here.
   */
  supersedeRunning(nextCandidateId: string, reason: string): void {
    const running = this.deps.executor.current
    if (running === null || running.status !== 'running' || running.id === nextCandidateId) return
    if (running.authorityLabel === 'vtr-reach') return
    this.deps.executor.cancelCurrent(reason)
    if (running.transitionId === undefined || running.transitionContractHash === undefined) return
    this.close({ transitionId: running.transitionId, contractHash: running.transitionContractHash }, 'ACTION_CANCELLED', reason)
  }

  /**
   * Admit and activate the dispatch as a kernel transition. A denial is
   * terminal for this dispatch - there is no fallback path. Re-attaching to
   * the already-running action reuses its admitted transition.
   */
  admit(candidate: Candidate, dimension: string | null): ControllerAdmission | null {
    const authority = this.deps.authority
    const family = committedSkillKind(candidate)
    const predicateId = `controller:${family}:${postconditionHash(declaredPostconditions(candidate))}`
    const running = this.deps.executor.current
    if (
      running !== null && running.id === candidate.id &&
      running.transitionId !== undefined && running.transitionContractHash !== undefined
    ) {
      return { transitionId: running.transitionId, contractHash: running.transitionContractHash, family, predicateId, reused: true }
    }
    const transitionId = `controller:${candidate.id}:${++this.sequence}`
    const world = this.deps.world()
    const compiled = controllerTransitionToKernelSpec({
      transitionId,
      family,
      desiredPredicate: predicateId,
      world: { serverId: world.serverId, dimension: dimension ?? 'minecraft:overworld', worldEpoch: world.worldEpoch },
      maxMechanicalSteps: CONTROLLER_MAX_MECHANICAL_STEPS,
      maxActiveMs: CONTROLLER_MAX_ACTIVE_MS,
    })
    if (!compiled.ok) {
      this.deps.log('warn', `KERNEL_TRANSITION_DENIED stage=compile transition=${transitionId} family=${family} reason=${compiled.reason}`, { candidateId: candidate.id })
      return null
    }
    const admitted = authority.admitContract(compiled.spec)
    if (!admitted.ok) {
      this.deps.log('warn', `KERNEL_TRANSITION_DENIED stage=admit transition=${transitionId} family=${family} reason=${admitted.reason}`, { candidateId: candidate.id })
      return null
    }
    const activated = authority.activateTransition(transitionId, null)
    if (!activated.ok) {
      authority.terminalize({
        transitionId,
        contractHash: admitted.contractHash,
        outcome: {
          kind: 'CONTRACT_SUPERSEDED',
          contractHash: admitted.contractHash,
          reason: `kernel-activation-denied:${activated.reason}`,
          evidenceId: `kernel-activation-denied:${transitionId}`,
        },
      })
      this.deps.log('warn', `KERNEL_TRANSITION_DENIED stage=activate transition=${transitionId} family=${family} reason=${activated.reason}`, { candidateId: candidate.id })
      return null
    }
    this.deps.log('info', `KERNEL_TRANSITION_ADMITTED transition=${transitionId} family=${family} contract=${admitted.contractHash} predicate=${predicateId}`, { candidateId: candidate.id })
    return { transitionId, contractHash: admitted.contractHash, family, predicateId, reused: false }
  }

  /**
   * The executor claim fields binding one dispatch to its admission: every
   * locomotion leg and declared internal effect is issued by the kernel before
   * the actuator runs and settled after. Settles report UNKNOWN (the actuator
   * returned; the world change is not verified here).
   */
  claimProvenance(admission: ControllerAdmission): ClaimProvenance {
    const authority = this.deps.authority
    const transitionId = admission.transitionId
    return {
      transitionId,
      transitionContractHash: admission.contractHash,
      authorityLabel: `controller:${admission.family}`,
      beforeMechanicalStep: (step) =>
        authority.issueStepEffect({ transitionId, intentId: transitionId, stepId: step.stepId, effectKind: 'locomotion' }).ok,
      afterMechanicalStep: (step) => {
        authority.settleStepEffect({ transitionId, intentId: transitionId, stepId: step.stepId, status: 'leg-returned', verified: false, progressed: false })
        return true
      },
      internalEffectCallbacks: {
        before: (reservation) =>
          authority.issueStepEffect({
            transitionId,
            intentId: transitionId,
            stepId: reservation.effectId,
            effectKind: INTERNAL_EFFECT_KERNEL_KIND[reservation.effect.type],
          }).ok,
        after: (settlement) => {
          authority.settleStepEffect({
            transitionId,
            intentId: transitionId,
            stepId: settlement.effectId,
            status: settlement.outcome.status,
            verified: false,
            progressed: false,
          })
        },
      },
    }
  }

  /** Typed non-SUCCESS closure; never mints truth. */
  close(
    admission: { readonly transitionId: string; readonly contractHash: string },
    kind: 'ACTION_CANCELLED' | 'ACTION_FAILED',
    reason: string,
  ): void {
    const verdict = this.deps.authority.terminalize({
      transitionId: admission.transitionId,
      contractHash: admission.contractHash,
      outcome: { kind, contractHash: admission.contractHash, reason, evidenceId: `controller-transition:${admission.transitionId}` },
    })
    if (!verdict.ok) {
      this.deps.log('error', `KERNEL_TRANSITION_TERMINAL_DENIED transition=${admission.transitionId} outcome=${kind} reason=${verdict.reason}`)
    }
  }

  /**
   * Close the transition from the settled action. SUCCESS is requested only
   * when the deterministic truth layer verified a completed outcome; the fed
   * fact names that observed evidence and the kernel's VERIFY is final.
   */
  terminalize(
    admission: ControllerAdmission,
    result: Pick<ExecutionResult, 'status' | 'kind' | 'epoch' | 'itemsGained' | 'blockRemoved' | 'failure'>,
    truth: Pick<TruthfulOutcome, 'verified' | 'status'>,
  ): void {
    const authority = this.deps.authority
    if (result.status === 'done' && truth.verified) {
      authority.feedObservation({
        observedAtMs: Date.now(),
        predicates: {
          [admission.predicateId]: {
            truth: 'true',
            evidenceId: `observed-outcome:${result.kind}:epoch=${result.epoch}:items=${result.itemsGained}:block=${result.blockRemoved}:status=${truth.status}`,
          },
        },
      })
      const verdict = authority.terminalize({ transitionId: admission.transitionId, contractHash: admission.contractHash, outcome: { kind: 'SUCCESS' } })
      if (!verdict.ok) {
        this.deps.log('error', `KERNEL_TRANSITION_TERMINAL_DENIED transition=${admission.transitionId} outcome=SUCCESS reason=${verdict.reason}`)
      }
      return
    }
    this.close(admission, result.status === 'cancelled' ? 'ACTION_CANCELLED' : 'ACTION_FAILED', result.failure ?? truth.status)
  }
}
