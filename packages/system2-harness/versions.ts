// system2-harness/versions.ts - independent versioning + explicit invalidation
// (#439 sections 17/23/25).
//
// A semantic contract change must invalidate incompatible cache/replay artifacts
// EXPLICITLY. An old cached proposal must never silently flow through a new
// compiler with changed meaning (#439 section 25).

import { canonicalJson, sha256Hex } from './canonical.ts'

export const HARNESS_VERSION = 1
export const STATE_PROJECTION_VERSION = 1
export const PROPOSAL_SCHEMA_VERSION = 1
export const PREDICATE_REGISTRY_VERSION = 1
export const COMPILER_VERSION = 1
export const PROMPT_VERSION = 1

/**
 * Independently versioned semantic contract. `provider`/`model` are NOT part of
 * the semantic contract (they are configuration), but they ARE part of cache
 * identity whenever they can change WHAT (#439 section 17), so they live in
 * `providerIdentity` and are recorded separately.
 */
export interface SemanticVersions {
  readonly harness: number
  readonly stateProjection: number
  readonly proposalSchema: number
  readonly predicateRegistry: number
  readonly compiler: number
  readonly prompt: number
}

export const SEMANTIC_VERSIONS: SemanticVersions = Object.freeze({
  harness: HARNESS_VERSION,
  stateProjection: STATE_PROJECTION_VERSION,
  proposalSchema: PROPOSAL_SCHEMA_VERSION,
  predicateRegistry: PREDICATE_REGISTRY_VERSION,
  compiler: COMPILER_VERSION,
  prompt: PROMPT_VERSION,
})

/** Stable key for the whole semantic contract; changes whenever meaning can change. */
export function semanticContractKey(versions: SemanticVersions = SEMANTIC_VERSIONS): string {
  return sha256Hex(canonicalJson(versions as unknown as Record<string, unknown>))
}

/** Per-field comparison so a mismatch can name exactly what changed. */
export function semanticContractMismatches(
  recorded: SemanticVersions,
  current: SemanticVersions = SEMANTIC_VERSIONS,
): readonly string[] {
  const fields = ['harness', 'stateProjection', 'proposalSchema', 'predicateRegistry', 'compiler', 'prompt'] as const
  const mismatches: string[] = []
  for (const field of fields) {
    if (recorded[field] !== current[field]) {
      mismatches.push(`${field}: recorded=${recorded[field]} current=${current[field]}`)
    }
  }
  return mismatches
}

/**
 * Replay/cache eligibility gate. Returns a reason string when an artifact
 * recorded under `recorded` must NOT be replayed under `current`.
 */
export function replayInvalidationReason(
  recorded: SemanticVersions,
  current: SemanticVersions = SEMANTIC_VERSIONS,
): string | null {
  const mismatches = semanticContractMismatches(recorded, current)
  if (mismatches.length === 0) return null
  return `SEMANTIC_CONTRACT_CHANGED ${mismatches.join('; ')}`
}

export interface ProviderIdentity {
  /** Role-level provider id, e.g. `ai-gateway`, `local-openai-compatible`, `replay`. */
  readonly providerId: string
  /** Concrete model id as configuration, e.g. `meta/muse-spark-1.3-contributor`. */
  readonly modelId: string
  /** Transport shape when it can change WHAT: `tool-call` | `json-text` | `scripted`. */
  readonly transport: string
}

export function providerIdentityKey(identity: ProviderIdentity): string {
  return `${identity.providerId}|${identity.modelId}|${identity.transport}`
}
