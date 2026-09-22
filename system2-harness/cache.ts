// system2-harness/cache.ts - cache identity is semantic identity
// (#439 sections 17/25 / issues #412 #413 #414).
//
// The key is a hash of EXACTLY the object handed to the provider (prompt text,
// projection, wake, identity, versions, provider/model identity, protected human
// intent, stage). There is no maintained field list that can drift: if a value
// is visible to the model it is in the hashed object, so
//   "if it is in the model request and can alter the plan, it must be represented
//    in cache identity"
// is a structural property, not a review convention (S11).
//
// Cache hits are evidence-visible (`CacheEvidence`) and a cached answer still
// passes the current stale/compile/grounding/commit validation before it can
// change anything (#439 section 17).

import { canonicalJson, sha256Hex } from './canonical.ts'
import type { CacheSource, System2CacheEvidence } from './contract.ts'
import type { SemanticProjection } from './contract.ts'
import type { ProviderIdentity, SemanticVersions } from './versions.ts'
import type { CausalIdentity } from './epochs.ts'
import type { RawProviderResponse } from './schema.ts'
import type { System2Proposal } from './contract.ts'

export const SYSTEM2_CACHE_NAMESPACE = 'system2.cache.v1'

/**
 * The exact model-visible request. `projection` is plain data; `prompt` is the
 * rendered prompt string; the rest is identity/versioning that can change WHAT.
 */
export interface System2ModelVisibleRequest {
  readonly stage: string | null
  readonly promptVersion: number
  readonly versions: SemanticVersions
  readonly provider: ProviderIdentity
  readonly identity: CausalIdentity
  readonly projection: SemanticProjection
  readonly projectionHash: string
  readonly wakeReason: string
  readonly wakeDetailHash: string
  readonly protectedIntentRevision: number | null
  readonly protectedIntentText: string | null
  readonly prompt: string
}

/** Cache key = sha256 over the canonical model-visible request (#439 section 17). */
export function cacheKeyFor(visible: System2ModelVisibleRequest): string {
  return sha256Hex(canonicalJson({ namespace: SYSTEM2_CACHE_NAMESPACE, visible: visible as unknown as Record<string, unknown> }))
}

export interface System2CacheEntry {
  readonly key: string
  readonly artifactId: string
  readonly provider: ProviderIdentity
  readonly raw: RawProviderResponse
  /** Decoded proposal retained so a replay can be compared, never applied raw. */
  readonly proposal: System2Proposal | null
}

export interface CacheLookup {
  readonly hit: boolean
  readonly entry: System2CacheEntry | null
  readonly evidence: System2CacheEvidence
}

export class System2ProposalCache {
  private readonly entries = new Map<string, System2CacheEntry>()

  constructor(private readonly maxEntries = 64) {}

  lookup(key: string, source: CacheSource = 'cache'): CacheLookup {
    const entry = this.entries.get(key) ?? null
    return {
      hit: entry !== null,
      entry,
      evidence: {
        hit: entry !== null,
        source: entry === null ? 'provider' : source,
        key,
        originalArtifactId: entry?.artifactId ?? null,
      },
    }
  }

  store(entry: System2CacheEntry): void {
    if (this.entries.size >= this.maxEntries && !this.entries.has(entry.key)) {
      const oldest = this.entries.keys().next()
      if (!oldest.done) this.entries.delete(oldest.value)
    }
    this.entries.set(entry.key, entry)
  }

  get size(): number {
    return this.entries.size
  }

  clear(): void {
    this.entries.clear()
  }
}

// ---------------------------------------------------------------------------
// coverage auditing (#439 S11)
// ---------------------------------------------------------------------------

/**
 * Enumerate every leaf path of the model-visible request. The S11 fixture flips
 * each leaf and asserts the cache key changes, which is how "the key covers all
 * model-visible WHAT-relevant state" stays true as the request grows.
 */
export function leafPaths(value: unknown, prefix = '$', out: string[] = []): string[] {
  if (value === null || typeof value !== 'object') {
    out.push(prefix)
    return out
  }
  if (Array.isArray(value)) {
    if (value.length === 0) out.push(prefix)
    for (let index = 0; index < value.length; index += 1) leafPaths(value[index], `${prefix}[${index}]`, out)
    return out
  }
  const keys = Object.keys(value as Record<string, unknown>)
  if (keys.length === 0) out.push(prefix)
  for (const key of keys) leafPaths((value as Record<string, unknown>)[key], `${prefix}.${key}`, out)
  return out
}

/** Structural copy with one leaf replaced. Used only by coverage fixtures. */
export function withLeafReplaced(value: unknown, path: string, replacement: unknown): unknown {
  const segments = path.replace(/^\$\.?/, '').split(/\.|\[|\]/).filter((segment) => segment.length > 0)
  const clone = structuredClone(value) as Record<string, unknown>
  let cursor: Record<string, unknown> | unknown[] = clone
  for (let index = 0; index < segments.length - 1; index += 1) {
    const key = segments[index]
    if (key === undefined) break
    const next = Array.isArray(cursor) ? cursor[Number(key)] : cursor[key]
    cursor = next as Record<string, unknown> | unknown[]
  }
  const last = segments[segments.length - 1]
  if (last !== undefined) {
    if (Array.isArray(cursor)) cursor[Number(last)] = replacement
    else (cursor as Record<string, unknown>)[last] = replacement
  }
  return clone
}
