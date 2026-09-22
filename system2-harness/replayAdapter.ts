// system2-harness/replayAdapter.ts - provider-free replay of historical System2
// decisions (#439 section 23).
//
// The replay adapter implements the SAME transport seam as a live provider, so a
// replayed request runs the identical schema/compile/grounding/epoch/commit
// pipeline. That is what makes long-horizon authority testable without running
// Minecraft for hours.
//
// Supported experiments (#439 section 23):
//   exact replay of a historical proposal
//   inject malformed schema
//   simulate timeout / provider failure
//   simulate a stale completion (identity moves while the model is "thinking")
//   change wake detail while holding every other state fixed
//   A/B model/provider versions
//   A/B projection versions
//   benchmark-order independence (covered by the projection fixtures)

import type { System2DecisionArtifact } from './artifacts.ts'
import type { System2ModelVisibleRequest } from './cache.ts'
import type { ScriptedOutcome, System2ProviderAdapter, System2ProviderDispatchRequest, System2ProviderDispatchResponse } from './provider.ts'
import { providerUnavailable, providerTimeout } from './provider.ts'
import type { RawProviderResponse } from './schema.ts'
import type { ProviderIdentity, SemanticVersions } from './versions.ts'
import { SEMANTIC_VERSIONS, replayInvalidationReason } from './versions.ts'

export type ReplayMode =
  | 'exact'
  | 'malformed'
  | 'timeout'
  | 'provider_error'
  | 'stale_completion'

export interface ReplayMatch {
  readonly cacheKey?: string
  readonly projectionHash?: string
  readonly wakeReason?: string
  readonly wakeDetailHash?: string
  readonly projectionVersion?: number
  readonly system2Epoch?: number
  readonly modelId?: string
}

export interface ReplayEntry {
  readonly match: ReplayMatch
  readonly raw: RawProviderResponse | null
  readonly sourceArtifactId: string | null
  readonly recordedVersions: SemanticVersions | null
}

export interface ReplayProviderOptions {
  readonly identity: ProviderIdentity
  readonly entries: readonly ReplayEntry[]
  readonly mode?: ReplayMode
  /** A/B projection-version experiment: recorded vs current contract. */
  readonly currentVersions?: SemanticVersions
  /** Refuse to replay when the recorded semantic contract is incompatible. */
  readonly requireCurrentSemanticContract?: boolean
  readonly onBeforeDispatch?: (request: System2ProviderDispatchRequest) => void | Promise<void>
}

export class ReplayContractError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReplayContractError'
  }
}

export class ReplayProviderAdapter implements System2ProviderAdapter {
  /** Declared to the harness so artifacts record a provider-free replay. */
  readonly kind = 'replay' as const
  private readonly entries: ReplayEntry[]
  private readonly mode: ReplayMode
  private readonly currentVersions: SemanticVersions
  private dispatches = 0
  private readonly matched: string[] = []
  private lastMissReason: string | null = null

  constructor(private readonly options: ReplayProviderOptions) {
    this.entries = [...options.entries]
    this.mode = options.mode ?? 'exact'
    this.currentVersions = options.currentVersions ?? SEMANTIC_VERSIONS
    if (options.requireCurrentSemanticContract === true) {
      for (const entry of this.entries) {
        if (entry.recordedVersions === null) continue
        const reason = replayInvalidationReason(entry.recordedVersions, this.currentVersions)
        if (reason !== null) {
          throw new ReplayContractError(`${reason} (artifact ${String(entry.sourceArtifactId)})`)
        }
      }
    }
  }

  get identity(): ProviderIdentity {
    return this.options.identity
  }

  get dispatchCount(): number {
    return this.dispatches
  }

  get matchedArtifactIds(): readonly string[] {
    return this.matched
  }

  get missReason(): string | null {
    return this.lastMissReason
  }

  dispatch(request: System2ProviderDispatchRequest): Promise<System2ProviderDispatchResponse> {
    this.dispatches += 1
    return (async () => {
      await this.options.onBeforeDispatch?.(request)
      switch (this.mode) {
        case 'timeout':
          throw providerTimeout('replay: injected timeout')
        case 'provider_error':
          throw providerUnavailable('replay: injected provider failure')
        case 'malformed':
          return this.respond({ object: null, text: 'probably dig down and look for diamonds', finishReason: 'stop' })
        case 'stale_completion':
        case 'exact': {
          const entry = this.findEntry(request)
          if (entry === null) {
            throw providerUnavailable(`replay miss: ${this.lastMissReason ?? 'no recorded decision for this request'}`)
          }
          if (entry.sourceArtifactId !== null) this.matched.push(entry.sourceArtifactId)
          if (entry.raw === null) {
            throw providerUnavailable(`replay entry ${String(entry.sourceArtifactId)} recorded no raw response`)
          }
          if (entry.recordedVersions !== null) {
            const reason = replayInvalidationReason(entry.recordedVersions, this.currentVersions)
            if (reason !== null && this.options.requireCurrentSemanticContract !== false) {
              throw new ReplayContractError(`${reason} (artifact ${String(entry.sourceArtifactId)})`)
            }
          }
          return this.respond(entry.raw)
        }
      }
    })()
  }

  private respond(raw: RawProviderResponse): System2ProviderDispatchResponse {
    return {
      provider: this.options.identity,
      raw,
      providerMetadata: { replay: true, mode: this.mode },
      usage: { inputTokens: null, outputTokens: null, totalTokens: null },
    }
  }

  /**
   * Exact cache key first (identical model-visible state). The weaker identity
   * match exists so the wake-detail and A/B experiments can hold everything else
   * fixed; a miss is always reported, never silently substituted.
   */
  private findEntry(request: System2ProviderDispatchRequest): ReplayEntry | null {
    const byKey = this.entries.find((entry) => entry.match.cacheKey !== undefined && entry.match.cacheKey === request.cacheKey)
    if (byKey !== undefined) return byKey
    const candidates = this.entries.filter((entry) => matches(entry.match, request))
    if (candidates.length === 0) {
      this.lastMissReason = `no entry matched projectionHash=${request.projectionHash} wakeReason=${request.wakeReason}`
      return null
    }
    if (candidates.length > 1) {
      this.lastMissReason = `${candidates.length} entries matched; replay requires a unique decision`
      return null
    }
    const only = candidates[0]
    if (only === undefined) return null
    this.lastMissReason = 'matched by identity, not by exact cache key (wake detail or version differed)'
    return only
  }
}

function matches(match: ReplayMatch, request: System2ProviderDispatchRequest): boolean {
  if (match.cacheKey !== undefined) return false
  if (match.projectionHash !== undefined && match.projectionHash !== request.projectionHash) return false
  if (match.wakeReason !== undefined && match.wakeReason !== request.wakeReason) return false
  if (match.wakeDetailHash !== undefined && match.wakeDetailHash !== request.wakeDetailHash) return false
  if (match.projectionVersion !== undefined && match.projectionVersion !== request.projectionVersion) return false
  if (match.system2Epoch !== undefined && match.system2Epoch !== request.system2Epoch) return false
  if (match.modelId !== undefined && match.modelId !== request.modelVisible.provider.modelId) return false
  return true
}

/** Build replay entries from recorded decision artifacts (exact replay corpus). */
export function replayEntriesFromArtifacts(artifacts: readonly System2DecisionArtifact[]): readonly ReplayEntry[] {
  return artifacts.map((artifact) => ({
    match: {
      projectionHash: artifact.projectionHash,
      wakeReason: artifact.wakeReason,
      system2Epoch: artifact.system2Epoch,
      projectionVersion: artifact.projectionVersion,
      modelId: artifact.provider.modelId,
    },
    raw: artifact.rawResponse,
    sourceArtifactId: artifact.artifactId,
    recordedVersions: artifact.versions,
  }))
}

export interface ReplayHarnessProviderOptions extends Omit<ReplayProviderOptions, 'entries'> {
  readonly artifacts: readonly System2DecisionArtifact[]
  /** Optional explicit experiment outcome overriding one request. */
  readonly override?: ScriptedOutcome
}

/** Convenience: a replay provider seeded from a recorded artifact corpus. */
export function createReplayProvider(options: ReplayHarnessProviderOptions): ReplayProviderAdapter {
  return new ReplayProviderAdapter({
    identity: options.identity,
    entries: replayEntriesFromArtifacts(options.artifacts),
    mode: options.mode,
    currentVersions: options.currentVersions,
    requireCurrentSemanticContract: options.requireCurrentSemanticContract,
    onBeforeDispatch: options.onBeforeDispatch,
  })
}
