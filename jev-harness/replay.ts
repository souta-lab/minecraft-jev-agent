// jev-harness/replay.ts - provider-free replay through the SAME harness interface (#438 section 17).
//
// The replay adapter consumes captured decision artifacts and implements the
// exact same `JevHarness` as production. It does this by implementing the
// provider *transport* seam and running the identical pipeline, so a replayed
// request exercises the same candidate canonicalization, cache rules, strict
// decoding, calibration layer, epoch fence and artifact writer. "Synthetic replay
// timeout/stale/provider-error follows the same result algebra as the live
// provider" (#25.18) is therefore structural, not re-implemented.
//
// Supported modes (#438 section 17):
//   exact                  replay the historical answer
//   synthetic_distribution inject a distribution and observe the proposal
//   permute                permute candidate order (first-item bias, #14)
//   timeout                simulate a provider timeout
//   provider_error         simulate provider unavailability
//   stale_completion       the answer arrives after the epoch/world moved
//   model                  compare captured decisions of a given provider/model

import type { JevHarness, JevHeadRequest, PiRequest, RawDistribution } from './contract.ts'
import type { ArtifactSink, DecisionArtifact, RunIdentity } from './artifacts.ts'
import { MemoryArtifactSink } from './artifacts.ts'
import { StaticIdentitySource, toCausalIdentity } from './identity.ts'
import type { CandidateOrdering } from './candidates.ts'
import { candidateSetHash } from './candidates.ts'
import type { HarnessCache } from './cache.ts'
import type { ThresholdParameter } from './calibration.ts'
import type { JevHead } from './heads.ts'
import type {
  JevProviderAdapter,
  ProviderDispatchRequest,
  ProviderDispatchResponse,
  ProviderQuestion,
} from './provider.ts'
import { ProviderFailure, providerTimeout, providerUnavailable } from './provider.ts'
import type { JevHarnessOptions, TransportPolicy } from './harness.ts'
import { createJevHarness } from './harness.ts'
import { projectionHash } from './canonical.ts'

export interface ReplayCorpus {
  readonly artifacts: readonly DecisionArtifact[]
}

export function corpusFrom(records: readonly { record: string }[]): ReplayCorpus {
  return { artifacts: records.filter((record): record is DecisionArtifact => record.record === 'JEV_DECISION') }
}

export type ReplayMode =
  | { readonly kind: 'exact' }
  | {
      readonly kind: 'synthetic_distribution'
      /** headId -> candidateId -> probability. Heads absent here fall back to `exact`. */
      readonly distributions: Readonly<Record<string, Readonly<Record<string, number>>>>
      readonly probabilityForBoolean?: Readonly<Record<string, number>>
      readonly scoreFor?: Readonly<Record<string, number>>
    }
  | { readonly kind: 'permute'; readonly salt: string }
  | { readonly kind: 'timeout'; readonly times?: number }
  | { readonly kind: 'provider_error'; readonly times?: number }
  | { readonly kind: 'stale_completion'; readonly advance?: (identity: StaticIdentitySource) => void }
  | { readonly kind: 'model'; readonly provider?: string; readonly model?: string }

export interface ReplayHarnessOptions {
  readonly corpus: ReplayCorpus
  readonly mode?: ReplayMode
  readonly run: RunIdentity
  readonly identity: StaticIdentitySource
  readonly artifacts?: ArtifactSink
  readonly cache?: HarnessCache | null
  readonly heads?: readonly JevHead[]
  readonly parameters?: Readonly<Record<string, ThresholdParameter>>
  readonly ordering?: CandidateOrdering
  readonly transport?: TransportPolicy
  readonly timeoutMs?: number
  readonly promptSource?: JevHarnessOptions['promptSource']
}

export interface ReplayHarness {
  readonly harness: JevHarness
  readonly provider: ReplayProviderAdapter
  /** Artifacts served from the corpus, in dispatch order. */
  servedArtifactIds(): readonly string[]
  /** Decision problems the corpus has no captured answer for. */
  misses(): readonly string[]
}

export function createReplayHarness(options: ReplayHarnessOptions): ReplayHarness {
  const provider = new ReplayProviderAdapter(options.corpus, options.mode ?? { kind: 'exact' }, options.identity)
  const artifacts = options.artifacts ?? new MemoryArtifactSink()
  const harness = createJevHarness({
    provider,
    identity: options.identity,
    run: options.run,
    artifacts,
    cache: options.cache ?? null,
    heads: options.heads,
    parameters: options.parameters,
    ordering:
      options.ordering ??
      (options.mode?.kind === 'permute' ? { kind: 'permuted', salt: options.mode.salt } : { kind: 'canonical' }),
    transport: options.transport ?? { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, sleep: async () => undefined },
    timeoutMs: options.timeoutMs,
    promptSource: options.promptSource,
    // Replay is the ONLY place allowed to A/B an experimental transform (#423).
    allowExperimentalCalibration: true,
  })
  return {
    harness,
    provider,
    servedArtifactIds: () => provider.served(),
    misses: () => provider.missed(),
  }
}

/**
 * A transport that answers from captured artifacts. It performs NO decoding and
 * NO calibration: it returns the historical RAW answer, exactly as a live
 * provider would, so the rest of the pipeline is genuinely shared.
 *
 * A corpus entry is matched by (headId, projectionHash) and then VERIFIED against
 * the exact candidate set the harness serialized, so a nearby decision problem
 * can never be served by accident.
 */
export class ReplayProviderAdapter implements JevProviderAdapter {
  readonly providerId: string
  readonly modelId: string
  private readonly byHeadAndProjection = new Map<string, DecisionArtifact[]>()
  private readonly servedIds: string[] = []
  private readonly missedKeys: string[] = []
  private calls = 0

  constructor(
    corpus: ReplayCorpus,
    private readonly mode: ReplayMode,
    private readonly identity: StaticIdentitySource,
  ) {
    for (const artifact of corpus.artifacts) {
      const key = `${artifact.headId}|${artifact.projectionHash}`
      const bucket = this.byHeadAndProjection.get(key)
      if (bucket === undefined) this.byHeadAndProjection.set(key, [artifact])
      else bucket.push(artifact)
    }
    const filter = mode.kind === 'model' ? mode : null
    this.providerId = filter?.provider ?? corpus.artifacts[0]?.provider ?? 'replay'
    this.modelId = filter?.model ?? corpus.artifacts[0]?.model ?? 'replay'
  }

  served(): readonly string[] {
    return [...this.servedIds]
  }

  missed(): readonly string[] {
    return [...this.missedKeys]
  }

  dispatch(request: ProviderDispatchRequest): Promise<ProviderDispatchResponse> {
    this.calls += 1
    switch (this.mode.kind) {
      case 'timeout':
        if (this.calls <= (this.mode.times ?? Number.POSITIVE_INFINITY)) throw providerTimeout('replay: simulated provider timeout')
        break
      case 'provider_error':
        if (this.calls <= (this.mode.times ?? Number.POSITIVE_INFINITY)) {
          throw providerUnavailable('replay: simulated provider unavailable', true)
        }
        break
      default:
        break
    }
    const answers: Record<string, { questionId: string; raw: unknown }> = {}
    let confidence: Record<string, number> = {}
    for (const question of request.questions) {
      const artifact = this.match(question, request)
      if (artifact !== null) {
        this.servedIds.push(artifact.artifactId)
        const synthetic = this.mode.kind === 'synthetic_distribution' ? syntheticRaw(question, this.mode) : null
        answers[question.id] = { questionId: question.id, raw: synthetic ?? artifact.rawTypedResponse }
        if (artifact.confidence !== null && artifact.confidence.value !== null) {
          confidence = { ...confidence, [question.id]: artifact.confidence.value }
        }
        continue
      }
      if (this.mode.kind === 'synthetic_distribution') {
        const synthetic = syntheticRaw(question, this.mode)
        if (synthetic !== null) {
          answers[question.id] = { questionId: question.id, raw: synthetic }
          continue
        }
      }
      this.missedKeys.push(`${question.id}|${request.projectionHash ?? '<none>'}`)
      throw providerUnavailable(
        `replay: no captured decision for ${question.id} at this projection/candidate set - the corpus does not cover this decision problem`,
        false,
      )
    }
    if (this.mode.kind === 'stale_completion') {
      // The answer exists, but it lands AFTER the causal identity moved.
      if (this.mode.advance !== undefined) this.mode.advance(this.identity)
      else this.identity.advanceEpoch()
    }
    return Promise.resolve({
      provider: this.providerId,
      model: this.modelId,
      answers,
      // Reconstructed from recorded evidence so replay keeps the provider's
      // calibrated confidence metadata; never invented when it was absent.
      providerMetadata: Object.keys(confidence).length === 0 ? null : { typesafe: { confidence } },
      usage: null,
    })
  }

  private match(question: ProviderQuestion, request: ProviderDispatchRequest): DecisionArtifact | null {
    const projectionId = request.projectionId ?? ''
    const projectionVersion = request.projectionVersion ?? 0
    const digest =
      request.projectionHash ??
      projectionHash({ projectionId, version: projectionVersion, payload: request.projection as Record<string, unknown> })
    const bucket = this.byHeadAndProjection.get(`${question.id}|${digest}`)
    if (bucket === undefined) return null
    const expected = expectedCandidateIds(question)
    const filter = this.mode.kind === 'model' ? this.mode : null
    for (const artifact of bucket) {
      if (filter !== null) {
        if (filter.provider !== undefined && artifact.provider !== filter.provider) continue
        if (filter.model !== undefined && artifact.model !== filter.model) continue
      }
      const recorded = [...artifact.serializedCandidateIds].sort()
      if (recorded.length !== expected.length) continue
      if (recorded.every((id, index) => id === expected[index])) return artifact
    }
    return null
  }
}

function expectedCandidateIds(question: ProviderQuestion): readonly string[] {
  if (question.primitive !== 'choice') return []
  return Object.keys(question.criteria as Record<string, string>).sort()
}

export function emptyCandidateSetHash(): string {
  return candidateSetHash([])
}

function syntheticRaw(
  question: ProviderQuestion,
  mode: Extract<ReplayMode, { kind: 'synthetic_distribution' }>,
): unknown | null {
  if (question.primitive === 'choice') {
    const distribution = mode.distributions[question.id]
    if (distribution === undefined) return null
    const ranked = Object.entries(distribution).sort((a, b) => (b[1] === a[1] ? (a[0] < b[0] ? -1 : 1) : b[1] - a[1]))
    const winner = ranked[0]
    if (winner === undefined) return null
    return { type: 'choice', choice: winner[0], probabilities: { ...distribution } }
  }
  if (question.primitive === 'boolean') {
    const probability = mode.probabilityForBoolean?.[question.id]
    if (probability === undefined) return null
    return { type: 'boolean', probability }
  }
  const score = mode.scoreFor?.[question.id]
  if (score === undefined) return null
  return { type: 'score', score }
}

// ---------------------------------------------------------------------------
// offline comparison helpers
// ---------------------------------------------------------------------------

export interface ReplayProposalSummary {
  readonly artifactId: string
  readonly kind: string
  readonly candidateId: string | null
  readonly probability: number | null
  readonly proposal: string | null
  readonly rawDistribution: RawDistribution | null
}

export interface ReplayComparisonRow {
  readonly headId: string
  readonly decisionEpoch: number
  readonly a: ReplayProposalSummary | null
  readonly b: ReplayProposalSummary | null
  readonly changed: boolean
}

/**
 * Offline model comparison (#438 section 17 "compare model versions offline"):
 * run the same request set against two corpora and report where the proposal
 * differs. No provider call, no gameplay object.
 */
export async function compareReplay(
  a: { readonly corpus: ReplayCorpus; readonly run: RunIdentity; readonly identity: StaticIdentitySource; readonly heads?: readonly JevHead[] },
  b: { readonly corpus: ReplayCorpus; readonly run: RunIdentity; readonly identity: StaticIdentitySource; readonly heads?: readonly JevHead[] },
  requests: readonly JevHeadRequest[],
): Promise<readonly ReplayComparisonRow[]> {
  const sinkA = new MemoryArtifactSink()
  const sinkB = new MemoryArtifactSink()
  const replayA = createReplayHarness({ ...a, artifacts: sinkA })
  const replayB = createReplayHarness({ ...b, artifacts: sinkB })
  await replayA.harness.evaluateBatch(requests)
  await replayB.harness.evaluateBatch(requests)
  const artifactsA = sinkA.artifacts()
  const artifactsB = sinkB.artifacts()
  return requests.map((request, index) => {
    const left = summarize(artifactsA[index] ?? null)
    const right = summarize(artifactsB[index] ?? null)
    return {
      headId: request.headId,
      decisionEpoch: request.identity.decisionEpoch,
      a: left,
      b: right,
      // Change detection is about the PROPOSAL, never the per-run artifact id:
      // two identical corpora must compare equal, or the comparison is useless
      // as a model/calibration A-B signal.
      changed: proposalKey(left) !== proposalKey(right),
    }
  })
}

/** Proposal-only identity for A/B change detection (excludes artifactId/decisionId). */
export function proposalKey(row: ReplayProposalSummary | null): string {
  if (row === null) return '<no-decision>'
  return JSON.stringify({
    kind: row.kind,
    candidateId: row.candidateId,
    probability: row.probability,
    proposal: row.proposal,
    rawDistribution: row.rawDistribution,
  })
}

export function summarize(artifact: DecisionArtifact | null): ReplayProposalSummary | null {
  if (artifact === null) return null
  const proposal = artifact.finalProposal
  const candidateId = proposal.kind === 'selected' ? proposal.candidateId : null
  const probability =
    proposal.kind === 'selected'
      ? proposal.probability
      : proposal.kind === 'terminate' || proposal.kind === 'continue'
        ? proposal.probability
        : null
  return {
    artifactId: artifact.artifactId,
    kind: proposal.kind,
    candidateId,
    probability,
    proposal: proposal.kind === 'none' ? null : proposal.kind,
    rawDistribution: artifact.rawDistribution,
  }
}

/**
 * Offline calibration A/B (#438 section 17): re-run the same captured requests
 * under two calibration versions and report where the PROPOSAL changes. The raw
 * distribution is identical in both runs, which is exactly the I7 property that
 * makes this possible.
 */
export async function abCalibration(options: {
  readonly corpus: ReplayCorpus
  readonly run: RunIdentity
  readonly requests: readonly JevHeadRequest[]
  readonly headsA: readonly JevHead[]
  readonly headsB: readonly JevHead[]
}): Promise<readonly ReplayComparisonRow[]> {
  const anchor = options.requests[0]?.identity ?? emptyIdentity()
  return compareReplay(
    { corpus: options.corpus, run: options.run, identity: new StaticIdentitySource(toCausalIdentity(anchor)), heads: options.headsA },
    { corpus: options.corpus, run: options.run, identity: new StaticIdentitySource(toCausalIdentity(anchor)), heads: options.headsB },
    options.requests,
  )
}

function emptyIdentity(): PiRequest['identity'] {
  return { decisionEpoch: 0, optionInstanceId: null, worldKey: 'replay', worldEpoch: 0, generationId: 'replay' }
}

/** Patch one head's calibration reference, for A/B. Returns a new registry array. */
export function withHeadCalibration(
  heads: readonly JevHead[],
  headId: string,
  calibration: { transformId: string; transformVersion: number },
): readonly JevHead[] {
  return heads.map((head) => (head.id === headId ? { ...head, calibration } : head))
}

/** Patch one head's version, for "old artifact vs new head" comparison. */
export function withHeadVersion(heads: readonly JevHead[], headId: string, version: number): readonly JevHead[] {
  return heads.map((head) => (head.id === headId ? { ...head, version } : head))
}

export { ProviderFailure }
