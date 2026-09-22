// jev-harness/identity.ts - decision-epoch + stale-result fencing (#438 section 7, #437 section 3).
//
// The fence belongs in the harness, not in the call sites: "No call site should
// implement its own stale-response logic" (#438 section 7).
//
// A request binds to:
//   decisionEpoch, optionInstanceId, worldKey, worldEpoch, generationId,
//   candidateSetHash, projectionHash
// Before accepting a model response the harness verifies the request is still
// current. If any causal identity changed materially the result is dropped with
// `STALE_JEV_RESULT_DROPPED` and returned as a typed stale failure; it is never
// reinterpreted against the newer state.

import type { DecisionEpoch, RequestIdentity } from './contract.ts'

/** The marker #437 section 12 requires for a dropped late result. */
export const STALE_JEV_RESULT_DROPPED = 'STALE_JEV_RESULT_DROPPED'

/** The causal identity a request is bound to, without the derived hashes. */
export interface CausalIdentity {
  readonly decisionEpoch: DecisionEpoch
  readonly optionInstanceId: string | null
  readonly worldKey: string
  readonly worldEpoch: number
  readonly generationId: string
}

export type StaleReason =
  | 'decision_epoch_advanced'
  | 'option_instance_changed'
  | 'world_key_changed'
  | 'world_epoch_changed'
  | 'generation_changed'

export interface IdentityMismatch {
  readonly field: StaleReason
  readonly expected: string | number | null
  readonly observed: string | number | null
}

export type CurrencyCheck =
  | { readonly current: true }
  | { readonly current: false; readonly reason: StaleReason; readonly mismatches: readonly IdentityMismatch[] }

export function toCausalIdentity(identity: RequestIdentity): CausalIdentity {
  return {
    decisionEpoch: identity.decisionEpoch,
    optionInstanceId: identity.optionInstanceId,
    worldKey: identity.worldKey,
    worldEpoch: identity.worldEpoch,
    generationId: identity.generationId,
  }
}

export function sameCausalIdentity(a: CausalIdentity, b: CausalIdentity): boolean {
  return checkCurrency(a, b).current
}

/**
 * Currency check. Field order is the causal priority order: a new decision epoch
 * subsumes everything else (the epoch is what authorizes a SkillCommitment).
 */
export function checkCurrency(bound: CausalIdentity, live: CausalIdentity): CurrencyCheck {
  const mismatches: IdentityMismatch[] = []
  if (bound.decisionEpoch !== live.decisionEpoch) {
    mismatches.push({ field: 'decision_epoch_advanced', expected: bound.decisionEpoch, observed: live.decisionEpoch })
  }
  if (bound.generationId !== live.generationId) {
    mismatches.push({ field: 'generation_changed', expected: bound.generationId, observed: live.generationId })
  }
  if (bound.worldKey !== live.worldKey) {
    mismatches.push({ field: 'world_key_changed', expected: bound.worldKey, observed: live.worldKey })
  }
  if (bound.worldEpoch !== live.worldEpoch) {
    mismatches.push({ field: 'world_epoch_changed', expected: bound.worldEpoch, observed: live.worldEpoch })
  }
  if (bound.optionInstanceId !== live.optionInstanceId) {
    mismatches.push({
      field: 'option_instance_changed',
      expected: bound.optionInstanceId,
      observed: live.optionInstanceId,
    })
  }
  const first = mismatches[0]
  if (first === undefined) return { current: true }
  return { current: false, reason: first.field, mismatches }
}

/**
 * The harness reads the live causal identity through this seam. It is injected so
 * the replay adapter can simulate a completion that lands after the epoch moved,
 * without touching a call site.
 */
export interface LiveIdentitySource {
  current(): CausalIdentity
}

export class StaticIdentitySource implements LiveIdentitySource {
  private value: CausalIdentity

  constructor(initial: CausalIdentity) {
    this.value = initial
  }

  current(): CausalIdentity {
    return this.value
  }

  set(next: CausalIdentity): void {
    this.value = next
  }

  advanceEpoch(by = 1): void {
    this.value = { ...this.value, decisionEpoch: this.value.decisionEpoch + by }
  }

  setOptionInstance(optionInstanceId: string | null): void {
    this.value = { ...this.value, optionInstanceId }
  }

  setWorld(worldKey: string, worldEpoch: number): void {
    this.value = { ...this.value, worldKey, worldEpoch }
  }

  setGeneration(generationId: string): void {
    this.value = { ...this.value, generationId }
  }
}

export function staticIdentitySource(initial: CausalIdentity): StaticIdentitySource {
  return new StaticIdentitySource(initial)
}

/** Human-readable stale detail for logs/artifacts. */
export function describeStale(check: Extract<CurrencyCheck, { current: false }>): string {
  return check.mismatches
    .map((mismatch) => `${mismatch.field}: expected=${String(mismatch.expected)} observed=${String(mismatch.observed)}`)
    .join('; ')
}
