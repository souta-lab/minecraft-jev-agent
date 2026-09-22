// jev-harness/cache.ts - caching is INSIDE the semantic contract (#438 section 15, #437 section 10).
//
// Rules:
//   * the key covers every model-visible semantic input: head id+version,
//     projection version+hash, candidate set hash, provider+model identity,
//     calibration transform+version, threshold parameter identity, and the
//     world/dimension epoch and Option instance the request belongs to;
//   * the key deliberately does NOT contain `decisionEpoch` - a per-epoch key
//     would make every hit a miss. On a hit, the cached RAW response is
//     re-decoded and re-calibrated for the CURRENT epoch, so the result and the
//     artifact carry the current epoch, the cache source, and the original
//     artifact id;
//   * a cache must never return an answer whose candidate id is missing from the
//     current request's candidate set - guaranteed structurally here because the
//     cached payload is the raw response and decoding is closed-world (I3/#15);
//   * replaying the same (projection, candidate set) forever is a no-progress
//     loop, so a bounded replay count forces a fresh provider call and the
//     bypass is recorded (`cache.bypassed=replay_limit`).

import { canonicalJson, sha256Hex } from './canonical.ts'
import type { HeadId, HeadVersion, ProjectionId } from './contract.ts'

export interface JevCacheKeyMaterial {
  readonly headId: HeadId
  readonly headVersion: HeadVersion
  readonly primitive: string
  readonly projectionId: ProjectionId
  readonly projectionVersion: number
  readonly projectionHash: string
  readonly candidateSetHash: string
  readonly provider: string
  readonly model: string
  readonly calibrationTransformId: string
  readonly calibrationTransformVersion: number
  readonly thresholdParameterId: string | null
  readonly thresholdParameterVersion: number | null
  readonly worldKey: string
  readonly worldEpoch: number
  readonly optionInstanceId: string | null
}

export const CACHE_KEY_VERSION = 1

/**
 * Deterministic cache key. `CACHE_KEY_VERSION` is part of the material so a
 * future key-schema change invalidates old entries loudly instead of silently
 * serving a differently-keyed answer.
 */
export function jevCacheKey(material: JevCacheKeyMaterial): string {
  return `jev:${CACHE_KEY_VERSION}:${sha256Hex(canonicalJson(material as unknown))}`
}

export interface HarnessCacheEntry {
  readonly key: string
  readonly headId: HeadId
  readonly headVersion: HeadVersion
  readonly artifactId: string
  readonly decisionId: string
  readonly candidateSetHash: string
  /** The RAW provider answer, so decoding/calibration re-run on every hit. */
  readonly rawTypedResponse: unknown
  readonly rawDistribution: unknown
  readonly selectedCandidateId: string | null
  readonly provider: string
  readonly model: string
  readonly createdAtMs: number
  replays: number
}

export interface HarnessCache {
  get(key: string): HarnessCacheEntry | null
  put(entry: HarnessCacheEntry): void
  /** True when the entry has been replayed too often and must be bypassed. */
  isReplayExhausted(entry: HarnessCacheEntry): boolean
}

export const DEFAULT_MAX_CACHE_REPLAYS = 2

export class MemoryHarnessCache implements HarnessCache {
  private readonly entries = new Map<string, HarnessCacheEntry>()

  constructor(readonly maxReplays: number = DEFAULT_MAX_CACHE_REPLAYS) {}

  get(key: string): HarnessCacheEntry | null {
    return this.entries.get(key) ?? null
  }

  put(entry: HarnessCacheEntry): void {
    this.entries.set(entry.key, entry)
  }

  isReplayExhausted(entry: HarnessCacheEntry): boolean {
    return entry.replays >= this.maxReplays
  }

  /** Test/introspection helpers. */
  size(): number {
    return this.entries.size
  }

  keys(): readonly string[] {
    return [...this.entries.keys()].sort()
  }

  entry(key: string): HarnessCacheEntry | null {
    return this.entries.get(key) ?? null
  }
}
