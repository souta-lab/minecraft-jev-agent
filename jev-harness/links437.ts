// jev-harness/links437.ts - the landing seam for the #437 boundary that is now
// on main (`jev-agent/src/jevSemanticProjection.ts`).
//
// The harness deliberately does NOT import jev-agent (I10: the plain-data core
// must not reach gameplay/runtime modules). Instead this module declares the
// STRUCTURAL subset it reads, maps it onto the harness's repo-level link record,
// and is drift-tested against the landed source in
// `bun-tests/landed437-contract.test.ts`. If #437 changes a field, a reason code
// or a progress kind, that test fails and the mapping must be updated explicitly
// - the harness never silently accepts a shape it does not understand.

import type { DecisionId, RequestIdentity, SkillOutcomeProjection } from './contract.ts'
import type { SkillOutcomeLink } from './artifacts.ts'
import type { StaleReason } from './identity.ts'

/** The landed #437 schema string and version (`JEV_PROJECTION_SCHEMA`/`JEV_PROJECTION_VERSION`). */
export const LANDED_437_PROJECTION_ID = 'jev-semantic-projection/v2'
export const LANDED_437_PROJECTION_VERSION = 2

/**
 * The landed #437 `SkillTerminalReason` value space. The harness's
 * `SkillOutcomeProjection.terminalReason` uses the same nine values; the drift
 * test asserts this table against the landed union.
 */
export const LANDED_437_TERMINAL_REASONS: readonly SkillOutcomeProjection['terminalReason'][] = [
  'done',
  'blocked',
  'drop_not_acquired',
  'target_lost',
  'safety_interrupted',
  'capability_lost',
  'budget_exhausted',
  'world_changed',
  'lease_revoked',
]

/** The landed `ProgressSummary['kind']` value space. */
export const LANDED_437_PROGRESS_KINDS = ['verified', 'search', 'mechanical', 'none', 'regressed'] as const

/** The landed `EpochInvalidationReason` value space. */
export const LANDED_437_EPOCH_INVALIDATION_REASONS = [
  'world_changed',
  'generation_changed',
  'lease_revoked',
  'dimension_changed',
  'superseded',
] as const

export interface Jev437OutcomeLike {
  readonly decisionEpoch: number
  readonly commitmentId: string
  readonly selectedCandidateId: string
  readonly terminalReason: SkillOutcomeProjection['terminalReason']
  readonly verification: { readonly verified: boolean; readonly postcondition?: string; readonly detail?: string | null }
  readonly semanticProgress: { readonly kind: (typeof LANDED_437_PROGRESS_KINDS)[number]; readonly delta?: number }
  readonly failure?: { readonly code: string; readonly reason?: string }
}

function verificationState(packet: Jev437OutcomeLike): SkillOutcomeLink['verification'] {
  const verified = packet.verification?.verified
  if (verified === true) return 'verified'
  if (verified === false) return 'not_verified'
  // A packet without an explicit postcondition verdict is UNKNOWN, never
  // "not verified" by default (#438 section 6).
  return 'unknown'
}

/**
 * #437 deliberately separates "the body moved" (`mechanical`) from "the
 * postcondition was verified" (`verified`). The harness keeps that distinction:
 * mechanical movement is PARTIAL progress, never `achieved`, and never zero
 * (buddy-driver/AGENTS.md section 5).
 */
function progressState(packet: Jev437OutcomeLike): SkillOutcomeLink['semanticProgress'] {
  switch (packet.semanticProgress?.kind) {
    case 'verified':
      return 'achieved'
    case 'mechanical':
    case 'search':
      return 'partial'
    case 'none':
    case 'regressed':
      return 'none'
    default:
      return 'unknown'
  }
}

function failureState(packet: Jev437OutcomeLike): string | null {
  const failure = packet.failure
  if (failure === undefined || failure.code === '') return null
  return failure.reason === undefined || failure.reason === '' ? failure.code : `${failure.code}: ${failure.reason}`
}

/**
 * Build the harness link record payload for a landed #437 `SkillOutcomePacket`.
 *
 * `decisionId` is NOT part of the packet: it comes from the harness decision the
 * packet closes, which is exactly the causal thread section 19 requires. The
 * result is validated by `linkSkillOutcome()` (decisionId + candidateId must
 * match the artifact), so a packet can never be attached to another decision.
 */
export function skillOutcomeLinkFromPacket(input: {
  readonly decisionId: DecisionId
  readonly packet: Jev437OutcomeLike
}): SkillOutcomeLink {
  return {
    commitmentId: input.packet.commitmentId,
    decisionId: input.decisionId,
    selectedCandidateId: input.packet.selectedCandidateId,
    terminalReason: input.packet.terminalReason,
    verification: verificationState(input.packet),
    semanticProgress: progressState(input.packet),
    failure: failureState(input.packet),
  }
}

/**
 * Map the landed epoch invalidation reason onto the harness's stale reason. The
 * landed class tracks (dimension, worldEpoch); a dimension change is a world KEY
 * change and a same-dimension epoch bump is a world EPOCH change. `superseded`
 * means a newer decision epoch began.
 */
export function staleReasonFromEpochInvalidation(
  reason: (typeof LANDED_437_EPOCH_INVALIDATION_REASONS)[number],
): StaleReason {
  switch (reason) {
    case 'dimension_changed':
      return 'world_key_changed'
    case 'world_changed':
      return 'world_epoch_changed'
    case 'generation_changed':
    case 'lease_revoked':
      return 'generation_changed'
    case 'superseded':
      return 'decision_epoch_advanced'
  }
}

/** Bind a landed epoch (dimension + worldEpoch + generation) to the harness identity. */
export function identityFromLandedEpoch(input: {
  readonly decisionEpoch: number
  readonly dimension: string
  readonly worldEpoch: number
  readonly generationId: string
  readonly optionInstanceId?: string | null
  /** Explicit world key, when the caller has one that is richer than the dimension. */
  readonly worldKey?: string
}): RequestIdentity {
  return {
    decisionEpoch: input.decisionEpoch,
    optionInstanceId: input.optionInstanceId ?? null,
    worldKey: input.worldKey ?? `dimension:${input.dimension}`,
    worldEpoch: input.worldEpoch,
    generationId: input.generationId,
  }
}

/** The landed projection's model-visible top-level fields (everything except `counts`). */
export const LANDED_437_PROJECTION_MODEL_FIELDS: readonly string[] = [
  'schema',
  'version',
  'goal',
  'option',
  'world',
  'safety',
  'progress',
  'sense',
  'events',
  'inventory',
  'inventoryTruncated',
  'candidates',
  'previousDecision',
  'meaningfulDelta',
  'recentOutcomes',
  'facts',
]
