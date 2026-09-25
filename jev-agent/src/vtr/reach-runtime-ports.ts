import type { ContainerObservation } from '../containerAccess.ts'
import type { FailureCode } from '../executor.ts'
import type { StateFingerprintMemory } from '../moveFailMemory.ts'
import type { Candidate, ReachabilityGateOptions } from '../candidates.ts'
import type { GuardResult } from '../policy.ts'
import type { SkillCommitment } from '../skillCommitment.ts'
import type { SensorInput, SensorOptions, WorldState } from '../state.ts'
import type { ReachMechanicalIntent } from './reach-controller.ts'

export interface ReachRuntimeActionSnapshot {
  readonly id: string
  readonly kind: Candidate['kind']
  readonly epoch: number
  readonly status: 'running' | 'done' | 'failed' | 'cancelled'
  readonly authority?: 'legacy' | 'vtr-reach'
  readonly transitionId?: string
  readonly transitionContractHash?: string
  readonly commitment?: SkillCommitment
}

/**
 * Backend-neutral completion facts needed by the Reach scheduler bridge.
 * Adapters pass the original completion object through unchanged: this is the
 * controller's typed view, while richer mechanical evidence remains on that
 * same object for diagnostic journaling.
 */
export interface ReachMechanicalActionOutcome {
  readonly actionId: string
  readonly status: 'done' | 'failed' | 'cancelled'
  readonly failure: FailureCode | null
  readonly verified: boolean
  readonly progressed: boolean
}

export interface ReachActuationClaim {
  readonly kept: boolean
  readonly epoch: number
  readonly completion: Promise<ReachMechanicalActionOutcome>
}

export interface ReachRuntimePorts {
  observeWorldState(input: SensorInput, options: SensorOptions): WorldState
  inventoryCounts(): Record<string, number>
  containerContents(): readonly ContainerObservation[]
  bodyAvailable(): boolean
  currentHealth(): number
  currentDimension(): string
  reachabilityGateOptions(tick: number, memory: StateFingerprintMemory): ReachabilityGateOptions
  dispatch(request: ReachActuationRequest): ReachActuationResult
  currentAction(): ReachRuntimeActionSnapshot | null
  cancelCurrent(reason: string): boolean
  authorityConflictCount(): number
}

export interface ReachMechanicalStep {
  readonly stepId: string
  readonly leg: number
  readonly effectKind: 'locomotion'
}

export interface ReachActuationRequest {
  readonly intent: ReachMechanicalIntent
  readonly candidate: Candidate
  readonly observation: WorldState
  readonly reach: number
  readonly maxCandidateAgeTicks: number
  readonly reachability: ReachabilityGateOptions
  readonly liveStructureMembers: NonNullable<WorldState['liveStructureMembers']>
  readonly beforeMechanicalStep: (step: ReachMechanicalStep) => boolean
  readonly afterMechanicalStep: (step: ReachMechanicalStep) => boolean | 'verified-terminal'
}

export type ReachActuationResult =
  | { readonly status: 'route-refused'; readonly reason: 'candidate-missing' | 'target-mismatch' }
  | { readonly status: 'guard-refused'; readonly rejection: Extract<GuardResult, { ok: false }> }
  | {
      readonly status: 'claim-refused'
      readonly message: string
      readonly activeAction: ReachRuntimeActionSnapshot | null
    }
  | {
      readonly status: 'claimed'
      readonly candidate: Candidate
      readonly claim: ReachActuationClaim
      readonly actionId: string | null
    }
