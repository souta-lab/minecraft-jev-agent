// system2-harness/epochs.ts - semantic epoch + stale-result fencing
// (#439 sections 10/16/21).
//
// SHARED SHAPE (#438/#439): field-priority currency checking mirrors
// `jev-harness/identity.ts`. The fence lives in the harness, not in the call
// site, so no caller can implement its own (weaker) staleness rule.
//
// A response whose causal identities changed is `SYSTEM2_RESULT_STALE` and is
// DISCARDED. It is never rebased onto the newer world (#439 section 10): that is
// exactly how a stale WHAT gets injected after death, dimension transition,
// human override, hot reload or a newer System2 decision.

import type { HumanIntentRevision, OptionGraphRevision, System2Epoch, System2RequestIdentity } from './contract.ts'

/** The marker a dropped late result must produce (#439 section 10). */
export const SYSTEM2_RESULT_STALE = 'SYSTEM2_RESULT_STALE'

/** Causal identity a request is bound to, without the derived projection hash. */
export interface CausalIdentity {
  readonly system2Epoch: System2Epoch
  readonly missionId: string
  readonly optionGraphRevision: OptionGraphRevision
  readonly activeOptionInstanceId: string | null
  readonly worldKey: string
  readonly worldEpoch: number
  readonly generationId: string
  readonly humanIntentRevision: HumanIntentRevision
}

export type StaleReason =
  | 'system2_epoch_advanced'
  | 'generation_changed'
  | 'world_key_changed'
  | 'world_epoch_changed'
  | 'human_intent_changed'
  | 'mission_changed'
  | 'option_graph_revision_changed'
  | 'active_option_changed'

export interface IdentityMismatch {
  readonly field: StaleReason
  readonly expected: string | number | null
  readonly observed: string | number | null
}

export type CurrencyCheck =
  | { readonly current: true }
  | { readonly current: false; readonly reason: StaleReason; readonly mismatches: readonly IdentityMismatch[] }

export function toCausalIdentity(identity: System2RequestIdentity): CausalIdentity {
  return {
    system2Epoch: identity.system2Epoch,
    missionId: identity.missionId,
    optionGraphRevision: identity.optionGraphRevision,
    activeOptionInstanceId: identity.activeOptionInstanceId,
    worldKey: identity.worldKey,
    worldEpoch: identity.worldEpoch,
    generationId: identity.generationId,
    humanIntentRevision: identity.humanIntentRevision,
  }
}

export function sameCausalIdentity(a: CausalIdentity, b: CausalIdentity): boolean {
  return checkSystem2Currency(a, b).current
}

/**
 * Field order IS the causal priority order: a new System2 epoch subsumes
 * everything below it, a new world/generation invalidates world-dependent WHAT,
 * and human intent ranks above any model epoch (#439 section 21).
 */
export function checkSystem2Currency(bound: CausalIdentity, live: CausalIdentity): CurrencyCheck {
  const mismatches: IdentityMismatch[] = []
  const compare = (field: StaleReason, expected: string | number | null, observed: string | number | null): void => {
    if (expected !== observed) mismatches.push({ field, expected, observed })
  }
  compare('system2_epoch_advanced', bound.system2Epoch, live.system2Epoch)
  compare('generation_changed', bound.generationId, live.generationId)
  compare('world_key_changed', bound.worldKey, live.worldKey)
  compare('world_epoch_changed', bound.worldEpoch, live.worldEpoch)
  compare('human_intent_changed', bound.humanIntentRevision, live.humanIntentRevision)
  compare('mission_changed', bound.missionId, live.missionId)
  compare('option_graph_revision_changed', bound.optionGraphRevision, live.optionGraphRevision)
  compare('active_option_changed', bound.activeOptionInstanceId, live.activeOptionInstanceId)
  const first = mismatches[0]
  if (first === undefined) return { current: true }
  return { current: false, reason: first.field, mismatches }
}

/** Live identity the harness reads through this seam (so replay can move it). */
export interface System2LiveIdentity extends CausalIdentity {
  readonly projectionHash: string | null
}

export interface LiveSystem2IdentitySource {
  current(): System2LiveIdentity
}

export class StaticSystem2IdentitySource implements LiveSystem2IdentitySource {
  private value: System2LiveIdentity

  constructor(initial: System2LiveIdentity) {
    this.value = initial
  }

  current(): System2LiveIdentity {
    return this.value
  }

  set(next: System2LiveIdentity): void {
    this.value = next
  }

  advanceEpoch(by = 1): void {
    this.value = { ...this.value, system2Epoch: this.value.system2Epoch + by }
  }

  setOptionGraphRevision(revision: OptionGraphRevision): void {
    this.value = { ...this.value, optionGraphRevision: revision }
  }

  setActiveOption(optionInstanceId: string | null): void {
    this.value = { ...this.value, activeOptionInstanceId: optionInstanceId }
  }

  setWorld(worldKey: string, worldEpoch: number): void {
    this.value = { ...this.value, worldKey, worldEpoch }
  }

  setGeneration(generationId: string): void {
    this.value = { ...this.value, generationId }
  }

  setHumanIntentRevision(revision: HumanIntentRevision): void {
    this.value = { ...this.value, humanIntentRevision: revision }
  }

  setProjectionHash(hash: string | null): void {
    this.value = { ...this.value, projectionHash: hash }
  }
}

export function staticSystem2IdentitySource(initial: System2LiveIdentity): StaticSystem2IdentitySource {
  return new StaticSystem2IdentitySource(initial)
}

// ---------------------------------------------------------------------------
// transport retry eligibility (#439 section 16)
// ---------------------------------------------------------------------------

export type RetryEligibility =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly reason: string; readonly staleReason: StaleReason | 'projection_changed' }

/**
 * A transport retry repeats the SAME request only while it is still current.
 * "Ask again because we disliked the plan" is structurally inexpressible: the
 * only reasons this function can return are identity/projection drift.
 */
export function retryEligibility(
  bound: CausalIdentity,
  boundProjectionHash: string,
  live: System2LiveIdentity,
): RetryEligibility {
  const currency = checkSystem2Currency(bound, live)
  if (!currency.current) {
    return { eligible: false, reason: describeStale(currency), staleReason: currency.reason }
  }
  if (live.projectionHash !== null && live.projectionHash !== boundProjectionHash) {
    return { eligible: false, reason: `projection hash changed (${boundProjectionHash} -> ${live.projectionHash})`, staleReason: 'projection_changed' }
  }
  return { eligible: true }
}

/** Human-readable stale detail for logs/artifacts. */
export function describeStale(check: Extract<CurrencyCheck, { current: false }>): string {
  return check.mismatches
    .map((mismatch) => `${mismatch.field}: expected=${String(mismatch.expected)} observed=${String(mismatch.observed)}`)
    .join('; ')
}

export interface StaleCheckRecord {
  readonly marker: typeof SYSTEM2_RESULT_STALE
  readonly current: boolean
  readonly reason: StaleReason | null
  readonly mismatches: readonly IdentityMismatch[]
}

export function staleCheckRecord(check: CurrencyCheck): StaleCheckRecord {
  return check.current
    ? { marker: SYSTEM2_RESULT_STALE, current: true, reason: null, mismatches: [] }
    : { marker: SYSTEM2_RESULT_STALE, current: false, reason: check.reason, mismatches: check.mismatches }
}
