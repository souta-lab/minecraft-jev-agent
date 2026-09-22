// system2-harness/stateProjection.ts - ONE versioned System2 semantic-state
// projection (#439 sections 8/18/19/20/26).
//
// Properties enforced here:
//   * compact and bounded by SEMANTICS, not run duration (caps + explicit
//     truncation records, never silent elision);
//   * deterministic/canonicalized (stable ordering + canonical hash);
//   * explicit about UNKNOWN (epistemic facts survive serialization);
//   * causal to the wake reason;
//   * free of irrelevant body/path churn (no positions, no path nodes, no ticks);
//   * benchmark-order independent: rung/milestone labels are NOT part of the
//     payload, and an evaluator-supplied order is explicitly ignored.

import { canonicalJson, deepFreeze, projectionHash, projectionVersionKey } from './canonical.ts'
import type { OptionGraph, PredicateSpec, SemanticProjection } from './contract.ts'
import type { Epistemic } from './epistemic.ts'
import { epistemicEntry } from './canonical.ts'
import { STATE_PROJECTION_VERSION } from './versions.ts'
import type { System2Wake } from './wakeReasons.ts'

export const SYSTEM2_PROJECTION_ID = 'system2.state'
export const SYSTEM2_PROJECTION_VERSION = STATE_PROJECTION_VERSION

/**
 * Hard caps (#439 section 26). Bounds, not targets: a small semantic horizon is
 * the point. Exceeding a cap truncates deterministically and records the
 * truncation; it never silently drops facts.
 */
export const PROJECTION_LIMITS = Object.freeze({
  maxOptionSummaries: 12,
  maxPredicateSummaries: 48,
  maxCapabilitySummaries: 32,
  maxFacts: 48,
  maxResources: 48,
  maxOutcomes: 8,
  maxFailures: 8,
  maxSerializedBytes: 24_000,
})

export interface MissionProjection {
  readonly missionId: string
  readonly missionText: string
  readonly humanIntentRevision: number
  readonly protectedIntent: string | null
}

export interface OptionProjectionSummary {
  readonly optionId: string
  readonly optionInstanceId: string
  readonly intentText: string
  readonly status: 'active' | 'suspended' | 'completed'
  readonly desiredPredicates: readonly string[]
  readonly dependencies: readonly string[]
  readonly completionSemantics: 'all' | 'any'
  readonly origin: string
}

export interface OptionGraphProjection {
  readonly revision: number
  readonly currentOptionInstanceId: string | null
  readonly options: readonly OptionProjectionSummary[]
}

export type PredicateState = 'verified' | 'unmet' | 'unknown' | 'not_observed'

export interface PredicateSummary {
  readonly key: string
  readonly state: PredicateState
  readonly evidence: string
}

export interface CapabilitySummary {
  readonly capabilityId: string
  readonly state: 'available' | 'unavailable' | 'unknown'
  readonly evidence: string
}

/** A grounded world fact with its epistemic status preserved (#439 section 18). */
export interface GroundedFact {
  readonly id: string
  readonly subject: string
  readonly value: Epistemic<string>
  readonly evidence: string
}

/** An explicit unknown. `no known fortress` is NOT `no fortress exists`. */
export interface UnknownFact {
  readonly id: string
  readonly subject: string
  readonly state: 'unknown' | 'not_observed' | 'sensor_error'
  readonly detail: string
}

export interface ResourceSummary {
  readonly item: string
  readonly count: number
}

export interface SemanticOutcomeSummary {
  readonly optionInstanceId: string
  readonly terminalReason: string
  readonly verified: 'verified' | 'not_verified' | 'unknown'
  readonly semanticProgress: 'none' | 'partial' | 'achieved' | 'unknown'
  readonly summary: string
}

export interface TypedFailureSummary {
  readonly failureClass: string
  readonly optionInstanceId: string | null
  readonly count: number
  readonly lastDetail: string
}

export interface ProgressSummary {
  readonly missionProgress: string
  readonly currentOptionProgress: string
  readonly verifiedPredicateCount: number
  readonly unmetDependencyCount: number
}

export interface TruncationRecord {
  readonly section: string
  readonly dropped: number
}

export interface System2ProjectionPayload {
  readonly projectionId: string
  readonly version: number
  readonly mission: MissionProjection
  readonly optionGraph: OptionGraphProjection
  readonly currentOption: OptionProjectionSummary | null
  readonly verifiedPredicates: readonly PredicateSummary[]
  readonly unmetDependencies: readonly PredicateSummary[]
  readonly knownCapabilities: readonly CapabilitySummary[]
  readonly world: {
    readonly worldKey: string
    readonly dimension: string
    readonly epoch: number
    readonly groundedRelevantFacts: readonly GroundedFact[]
    readonly unknowns: readonly UnknownFact[]
  }
  readonly resources: readonly ResourceSummary[]
  readonly recentSemanticOutcomes: readonly SemanticOutcomeSummary[]
  readonly failureEvidence: readonly TypedFailureSummary[]
  readonly progress: ProgressSummary
  readonly wake: {
    readonly reason: string
    readonly detail: Readonly<Record<string, unknown>>
  }
  readonly truncations: readonly TruncationRecord[]
  readonly notes: readonly string[]
}

/** Caller-supplied projection input. Contains no benchmark ordering by design. */
export interface System2ProjectionInput {
  readonly mission: MissionProjection
  readonly optionGraph: OptionGraph
  readonly currentOptionInstanceId: string | null
  readonly verifiedPredicates: readonly PredicateSummary[]
  readonly unmetDependencies: readonly PredicateSummary[]
  readonly knownCapabilities: readonly CapabilitySummary[]
  readonly world: {
    readonly worldKey: string
    readonly dimension: string
    readonly epoch: number
    readonly facts: readonly GroundedFact[]
  }
  readonly resources: readonly ResourceSummary[]
  readonly recentSemanticOutcomes: readonly SemanticOutcomeSummary[]
  readonly failureEvidence: readonly TypedFailureSummary[]
  readonly progress: ProgressSummary
  readonly wake: System2Wake
  /**
   * IGNORED (#439 section 20). Evaluator/benchmark data is allowed to flow past
   * the caller for logging, but the projection builder never reads it: changing
   * benchmark milestone order must not change the projection or its hash.
   */
  readonly benchmarkOrder?: readonly string[]
  readonly notes?: readonly string[]
}

function predicateKey(spec: PredicateSpec): string {
  return `${spec.kind}(${canonicalJson(spec.args as unknown as Record<string, unknown>)})`
}

function summarizeOption(option: OptionGraph['options'][number]): OptionProjectionSummary {
  return {
    optionId: option.option.optionId,
    optionInstanceId: option.option.optionInstanceId,
    intentText: option.option.intentText,
    status: option.status,
    desiredPredicates: option.option.desiredPredicates.map(predicateKey),
    dependencies: option.option.dependencies.map(predicateKey),
    completionSemantics: option.option.completionSemantics,
    origin: option.option.origin.kind,
  }
}

function takeCapped<T>(
  entries: readonly T[],
  cap: number,
  section: string,
  truncations: TruncationRecord[],
): readonly T[] {
  if (entries.length <= cap) return entries
  truncations.push({ section, dropped: entries.length - cap })
  return entries.slice(0, cap)
}

function unknownFactsFrom(facts: readonly GroundedFact[]): readonly UnknownFact[] {
  const unknowns: UnknownFact[] = []
  for (const fact of facts) {
    if (fact.value.state === 'known') continue
    unknowns.push({
      id: fact.id,
      subject: fact.subject,
      state: fact.value.state,
      detail: fact.value.state === 'sensor_error' ? fact.value.detail : fact.evidence,
    })
  }
  return unknowns
}

/**
 * Strings that may never appear in an authoritative projection. They are
 * benchmark/evaluator vocabulary, not world facts (#439 section 20).
 */
export const FORBIDDEN_PROJECTION_TOKENS = Object.freeze([
  'next_rung',
  'preferred_action',
  'recommended_strategy',
  'rung_index',
  'milestone_order',
  'descend_to_y16',
  'branch_mine',
  'diamond_road',
  'surface_for_log',
  'finish_iron_age',
])

export class ProjectionContractError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProjectionContractError'
  }
}

/** Fail-closed guard: an authoritative projection must not carry benchmark order. */
export function assertProjectionHasNoBenchmarkOrder(payload: unknown): void {
  const text = canonicalJson(payload)
  for (const token of FORBIDDEN_PROJECTION_TOKENS) {
    if (text.includes(token)) {
      throw new ProjectionContractError(`projection payload contains benchmark/evaluator token "${token}" (#439 section 20)`)
    }
  }
}

/**
 * Build the ONE canonical System2 projection. Deterministic: identical semantic
 * input yields byte-identical payload and hash.
 */
export function buildSystem2Projection(
  input: System2ProjectionInput,
): SemanticProjection<System2ProjectionPayload> {
  const truncations: TruncationRecord[] = []
  const options = takeCapped(
    input.optionGraph.options.map(summarizeOption),
    PROJECTION_LIMITS.maxOptionSummaries,
    'optionGraph.options',
    truncations,
  )
  const current = options.find((option) => option.optionInstanceId === input.currentOptionInstanceId) ?? null
  const facts = takeCapped(
    [...input.world.facts].sort((left, right) => left.id.localeCompare(right.id)),
    PROJECTION_LIMITS.maxFacts,
    'world.facts',
    truncations,
  )
  const payload: System2ProjectionPayload = {
    projectionId: SYSTEM2_PROJECTION_ID,
    version: SYSTEM2_PROJECTION_VERSION,
    mission: {
      missionId: input.mission.missionId,
      missionText: input.mission.missionText,
      humanIntentRevision: input.mission.humanIntentRevision,
      protectedIntent: input.mission.protectedIntent,
    },
    optionGraph: {
      revision: input.optionGraph.revision,
      currentOptionInstanceId: input.currentOptionInstanceId,
      options,
    },
    currentOption: current,
    verifiedPredicates: takeCapped(
      [...input.verifiedPredicates].sort((left, right) => left.key.localeCompare(right.key)),
      PROJECTION_LIMITS.maxPredicateSummaries,
      'verifiedPredicates',
      truncations,
    ),
    unmetDependencies: takeCapped(
      [...input.unmetDependencies].sort((left, right) => left.key.localeCompare(right.key)),
      PROJECTION_LIMITS.maxPredicateSummaries,
      'unmetDependencies',
      truncations,
    ),
    knownCapabilities: takeCapped(
      [...input.knownCapabilities].sort((left, right) => left.capabilityId.localeCompare(right.capabilityId)),
      PROJECTION_LIMITS.maxCapabilitySummaries,
      'knownCapabilities',
      truncations,
    ),
    world: {
      worldKey: input.world.worldKey,
      dimension: input.world.dimension,
      epoch: input.world.epoch,
      groundedRelevantFacts: facts,
      unknowns: unknownFactsFrom(facts),
    },
    resources: takeCapped(
      [...input.resources].sort((left, right) => left.item.localeCompare(right.item)),
      PROJECTION_LIMITS.maxResources,
      'resources',
      truncations,
    ),
    recentSemanticOutcomes: takeCapped(
      input.recentSemanticOutcomes,
      PROJECTION_LIMITS.maxOutcomes,
      'recentSemanticOutcomes',
      truncations,
    ),
    failureEvidence: takeCapped(
      input.failureEvidence,
      PROJECTION_LIMITS.maxFailures,
      'failureEvidence',
      truncations,
    ),
    progress: input.progress,
    wake: {
      reason: input.wake.reason,
      detail: input.wake.detail as unknown as Readonly<Record<string, unknown>>,
    },
    truncations,
    notes: [...(input.notes ?? [])],
  }
  assertProjectionHasNoBenchmarkOrder(payload)
  const bytes = canonicalJson(payload as unknown as Record<string, unknown>).length
  if (bytes > PROJECTION_LIMITS.maxSerializedBytes) {
    throw new ProjectionContractError(
      `projection is ${bytes} bytes which exceeds the bounded horizon cap ${PROJECTION_LIMITS.maxSerializedBytes} (#439 section 26)`,
    )
  }
  return deepFreeze({ projectionId: SYSTEM2_PROJECTION_ID, version: SYSTEM2_PROJECTION_VERSION, payload })
}

export { projectionHash, projectionVersionKey, epistemicEntry }
