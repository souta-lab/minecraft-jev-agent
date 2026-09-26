// test-vtr-kernel-authority-stub.mts - shared permissive KernelReachAuthority
// for fixtures that are not testing the gate itself.
//
// KernelReachAuthority is REQUIRED on every Reach runtime/controller
// construction; this stub lets scheduler/controller fixtures exercise
// happy-path semantics without re-implementing the recording boilerplate.
// Gate-ordering and denial semantics themselves are proven in
// test-vtr-reach-kernel-authority.mts and buddy-driver/test-kernel-authority.mts.
import type {
  KernelGateVerdict,
  KernelReachAuthority,
  KernelWorldObservation,
} from './src/reach/kernel-shadow-map.ts'
import type { ReachTransitionContract, ReachWitness } from './src/reach/transition.ts'

export interface KernelGateCall {
  readonly gate: string
  readonly transitionId: string
}

export class RecordingKernelAuthority implements KernelReachAuthority {
  readonly mode = 'authority' as const
  readonly calls: KernelGateCall[] = []
  admitVerdict: KernelGateVerdict = { ok: true }
  activateVerdict: KernelGateVerdict = { ok: true }
  issueVerdict: KernelGateVerdict = { ok: true }
  terminalizeVerdict: KernelGateVerdict = { ok: true }
  lastSettled: { stepId: string; status: string; progressed: boolean } | null = null
  lastObservation: KernelWorldObservation | null = null

  feedObservation(input: KernelWorldObservation): void {
    this.lastObservation = input
  }
  admitTransition(contract: ReachTransitionContract): KernelGateVerdict {
    this.calls.push({ gate: 'admitTransition', transitionId: contract.transitionId })
    return this.admitVerdict
  }
  activateTransition(transitionId: string, _witness: ReachWitness | null): KernelGateVerdict {
    this.calls.push({ gate: 'activateTransition', transitionId })
    return this.activateVerdict
  }
  issueStepEffect(input: { transitionId: string; intentId: string; stepId: string; effectKind: string }): KernelGateVerdict {
    this.calls.push({ gate: 'issueStepEffect', transitionId: input.transitionId })
    return this.issueVerdict
  }
  settleStepEffect(input: { transitionId: string; intentId: string; stepId: string; status: string; verified: boolean; progressed: boolean }): void {
    this.calls.push({ gate: 'settleStepEffect', transitionId: input.transitionId })
    this.lastSettled = { stepId: input.stepId, status: input.status, progressed: input.progressed }
  }
  terminalize(input: { transitionId: string; contractHash: string; outcome: { kind: string } }): KernelGateVerdict {
    this.calls.push({ gate: 'terminalize', transitionId: input.transitionId })
    return this.terminalizeVerdict
  }
}

export function createTestKernelAuthority(): RecordingKernelAuthority {
  return new RecordingKernelAuthority()
}
