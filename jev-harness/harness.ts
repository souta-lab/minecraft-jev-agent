// jev-harness/harness.ts - the sealed policy kernel boundary (#438 section 1).
//
// One production abstraction can invoke Jev. It owns, in this order:
//   request validation -> candidate canonicalization (closed world) -> projection
//   hashing -> cache lookup -> bounded transport retry (never policy retry) ->
//   currency re-verification -> strict decoding -> versioned calibration ->
//   immutable artifact -> typed semantic result.
//
// It never invents an answer. It never retries because an answer was
// inconvenient. It never lets a stale result be reinterpreted against newer
// state. It never thresholds a probability anywhere else.

import type {
  BetaRequest,
  BetaResult,
  BetaValue,
  ConfidenceMetadata,
  GroundedSemanticCandidate,
  JevFailure,
  JevFailureKind,
  JevHarness,
  JevHeadRequest,
  JevHeadResult,
  JevResult,
  PiAbstentionValue,
  PiChoiceValue,
  PiRequest,
  PiResult,
  RawDistribution,
  ScoreRequest,
  ScoreResult,
  ScoreValue,
  DecisionEvidenceRef,
} from './contract.ts'
import { confidenceMetadata, jevFailure, jevOk } from './contract.ts'
import type { AppliedCalibration, CalibrationContext, ThresholdParameter } from './calibration.ts'
import {
  DEFAULT_THRESHOLDS,
  rankDistribution,
  requireTransform,
  resolveBetaThreshold,
  resolveThreshold,
  thresholdProposal,
} from './calibration.ts'
import type {
  ArtifactSink,
  DecodedRecord,
  FinalProposal,
  HarnessRecord,
  RunIdentity,
  TransportFailureRecord,
  TransportRecord,
} from './artifacts.ts'
import { buildDecisionArtifact } from './artifacts.ts'
import type { CandidateOrdering, OrderedCandidates } from './candidates.ts'
import { applyOrdering, candidateSetHash, choiceCriteria, distributionOver } from './candidates.ts'
import type { HarnessCache, HarnessCacheEntry } from './cache.ts'
import { jevCacheKey } from './cache.ts'
import type { CurrencyCheck, LiveIdentitySource } from './identity.ts'
import { STALE_JEV_RESULT_DROPPED, checkCurrency, describeStale, toCausalIdentity } from './identity.ts'
import type { JevHead } from './heads.ts'
import { JEV_HEADS, validateHeadRegistry } from './heads.ts'
import { assertPlainData, hashId, projectionHash } from './canonical.ts'
import { lookupProjectionSchema } from './semanticProjection.ts'
import type { JevProviderAdapter, ProviderDispatchResponse, ProviderFailure, ProviderQuestion } from './provider.ts'
import { classifyProviderError } from './provider.ts'
import {
  decodeBooleanProbability,
  decodeCalibratedConfidence,
  decodeChoice,
  decodeChoiceDistribution,
  decodeOptionalProbabilityMap,
  decodeScore,
} from './decoding.ts'

export class HarnessConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HarnessConfigurationError'
  }
}

export interface TransportPolicy {
  /** Total attempts for a retryable transport failure. 1 disables retry. */
  readonly maxAttempts: number
  readonly baseDelayMs: number
  readonly maxDelayMs: number
  readonly sleep?: (ms: number) => Promise<void>
}

export const DEFAULT_TRANSPORT_POLICY: TransportPolicy = {
  maxAttempts: 1,
  baseDelayMs: 250,
  maxDelayMs: 4_000,
}

export interface JevHarnessOptions {
  readonly provider: JevProviderAdapter
  /** Live causal identity: the stale fence reads this before accepting an answer. */
  readonly identity: LiveIdentitySource
  readonly run: RunIdentity
  readonly artifacts: ArtifactSink
  readonly cache?: HarnessCache | null
  /** Registry override (tests / partial wiring). Defaults to the whole registry. */
  readonly heads?: readonly JevHead[]
  readonly parameters?: Readonly<Record<string, ThresholdParameter>>
  readonly ordering?: CandidateOrdering
  readonly timeoutMs?: number
  readonly transport?: TransportPolicy
  readonly now?: () => Date
  readonly idFactory?: () => string
  /** Head prompt resolver. Defaults to the registry's canonical text. */
  readonly promptSource?: (head: JevHead) => string
  /** Deterministic clock for latency accounting in tests. */
  readonly clock?: () => number
  /**
   * TEST/REPLAY ONLY. The shipped registry must never reference an experimental
   * calibration transform; only offline A/B replay may opt in, and it must say so
   * here so the choice is visible in the wiring diff.
   */
  readonly allowExperimentalCalibration?: boolean
}

type CacheRecord = {
  readonly hit: boolean
  readonly source: 'provider' | 'cache'
  readonly key: string
  readonly originalArtifactId: string | null
  readonly bypassed: 'replay_limit' | null
}

interface PreparedHead {
  readonly index: number
  readonly request: JevHeadRequest
  readonly head: JevHead | null
  readonly failure: JevFailure | null
  readonly ordered: OrderedCandidates | null
  readonly candidateSetHash: string
  readonly projectionHash: string
  readonly cacheKey: string | null
  readonly cacheEntry: HarnessCacheEntry | null
  readonly cacheBypassed: 'replay_limit' | null
  readonly decisionId: string
}

interface DispatchOutcome {
  readonly response: ProviderDispatchResponse | null
  readonly failure: ProviderFailure | null
  readonly transport: TransportRecord
}

export function createJevHarness(options: JevHarnessOptions): JevHarness {
  return new Harness(options)
}

class Harness implements JevHarness {
  private readonly heads: readonly JevHead[]
  /**
   * Harness-local head resolution. `options.heads` is a real registry override
   * (partial wiring, replay A/B calibration), so a request must resolve against
   * THIS map - resolving against the module-level registry would silently ignore
   * the override and make `withHeadCalibration()`/`withHeadVersion()` no-ops.
   */
  private readonly headById: ReadonlyMap<string, JevHead>
  private readonly parameters: Readonly<Record<string, ThresholdParameter>>
  private readonly ordering: CandidateOrdering
  private readonly timeoutMs: number
  private readonly transport: TransportPolicy
  private readonly now: () => Date
  private readonly idFactory: () => string
  private readonly promptSource: (head: JevHead) => string
  private readonly clock: () => number

  constructor(private readonly options: JevHarnessOptions) {
    this.heads = options.heads ?? JEV_HEADS
    validateHeadRegistry(this.heads)
    this.headById = new Map(this.heads.map((head) => [head.id, head]))
    for (const head of this.heads) {
      const transform = requireTransform(head.calibration.transformId, head.calibration.transformVersion)
      if (transform.experimental && options.allowExperimentalCalibration !== true) {
        throw new HarnessConfigurationError(
          `head ${head.id} references experimental calibration ${head.calibration.transformId}@${head.calibration.transformVersion}`,
        )
      }
    }
    this.parameters = options.parameters ?? DEFAULT_THRESHOLDS
    this.ordering = options.ordering ?? { kind: 'canonical' }
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.transport = options.transport ?? DEFAULT_TRANSPORT_POLICY
    this.now = options.now ?? (() => new Date())
    this.idFactory = options.idFactory ?? (() => `dec_${hashId(`${Date.now()}|${Math.random()}`, 20)}`)
    this.promptSource = options.promptSource ?? ((head) => head.instructions.text)
    this.clock = options.clock ?? (() => Date.now())
  }

  choose(request: PiRequest): Promise<PiResult> {
    return this.runSingle(request, 'choice') as Promise<PiResult>
  }

  shouldTerminate(request: BetaRequest): Promise<BetaResult> {
    return this.runSingle(request, 'boolean') as Promise<BetaResult>
  }

  score(request: ScoreRequest): Promise<ScoreResult> {
    return this.runSingle(request, 'score') as Promise<ScoreResult>
  }

  evaluateBatch(requests: readonly JevHeadRequest[]): Promise<readonly JevHeadResult[]> {
    return this.runBatch(requests)
  }

  // -------------------------------------------------------------------------
  // preparation (pure, fail-closed, no provider call)
  // -------------------------------------------------------------------------

  private prepare(index: number, request: JevHeadRequest): PreparedHead {
    const decisionId = this.idFactory()
    const head = this.headById.get(request.headId) ?? null
    const projection = request.projection
    const projectionDigest = projectionHash(projection)
    const base = {
      index,
      request,
      head,
      ordered: null,
      decisionId,
      projectionHash: projectionDigest,
      cacheKey: null,
      cacheEntry: null,
      cacheBypassed: null,
      candidateSetHash: '',
      failure: null as JevFailure | null,
    }

    if (head === null) {
      return {
        ...base,
        failure: jevFailure('unregistered_head', `head ${JSON.stringify(request.headId)} is not in the registry`, null),
      }
    }

    // The projection contract is per head (#438 section 5): a head may only see
    // the projection version it was registered against.
    if (projection.projectionId !== head.stateProjection) {
      return {
        ...base,
        failure: jevFailure(
          'invalid_request',
          `head ${head.id} requires projection ${head.stateProjection}, got ${projection.projectionId}`,
          null,
        ),
      }
    }
    // A declared projection has exactly ONE live version. Passing a different
    // version under the same id would present a different state contract to the
    // model while keeping the head's identity, so it fails closed.
    const schema = lookupProjectionSchema(projection.projectionId)
    if (schema !== null && projection.version !== schema.version) {
      return {
        ...base,
        failure: jevFailure(
          'invalid_request',
          `projection ${projection.projectionId} is declared at version ${schema.version}, got ${projection.version}`,
          null,
        ),
      }
    }

    // Plain-data check: a live planner/controller/entity object must never reach
    // the provider adapter (I10). Throws on a real code bug.
    assertPlainData(projection.payload, `projection for ${head.id}`)

    let candidates: readonly GroundedSemanticCandidate[]
    if (head.candidateSource === 'grounded') {
      const requested = 'candidates' in request ? (request as PiRequest).candidates : []
      if (requested.length === 0) {
        return {
          ...base,
          failure: jevFailure('empty_candidate_set', `head ${head.id} was given an empty grounded candidate set`, null),
        }
      }
      candidates = requested
    } else if (head.candidateSource === 'declared') {
      candidates = (head.declaredCandidates ?? []).map((entry) => ({
        id: entry.id,
        skillKind: head.id,
        target: null,
        postcondition: null,
        facts: {},
        description: entry.criteria,
      }))
    } else {
      candidates = []
    }

    // Throws DuplicateCandidateIdError / HiddenPreferenceFieldError: hidden
    // policy and ambiguous identity are code bugs, and stripping them silently
    // would hide the policy from review (#438 section 20).
    const ordered = applyOrdering(candidates, this.ordering)
    const setHash = candidateSetHash(candidates)
    const transform = requireTransform(head.calibration.transformId, head.calibration.transformVersion)
    const thresholdRef = this.thresholdFor(head, request, transform.id, transform.kind)

    const cache = this.options.cache ?? null
    const cacheKey =
      cache === null
        ? null
        : jevCacheKey({
            headId: head.id,
            headVersion: head.version,
            primitive: head.primitive,
            projectionId: projection.projectionId,
            projectionVersion: projection.version,
            projectionHash: projectionDigest,
            candidateSetHash: setHash,
            provider: this.options.provider.providerId,
            model: this.options.provider.modelId,
            calibrationTransformId: head.calibration.transformId,
            calibrationTransformVersion: head.calibration.transformVersion,
            thresholdParameterId: thresholdRef?.parameterId ?? null,
            thresholdParameterVersion: thresholdRef?.parameterVersion ?? null,
            worldKey: request.identity.worldKey,
            worldEpoch: request.identity.worldEpoch,
            optionInstanceId: request.identity.optionInstanceId,
          })

    let cacheEntry: HarnessCacheEntry | null = null
    let cacheBypassed: 'replay_limit' | null = null
    if (cacheKey !== null && cache !== null) {
      const entry = cache.get(cacheKey)
      if (entry !== null) {
        if (cache.isReplayExhausted(entry)) cacheBypassed = 'replay_limit'
        else cacheEntry = entry
      }
    }

    return { ...base, ordered, candidateSetHash: setHash, cacheKey, cacheEntry, cacheBypassed }
  }

  private thresholdFor(
    head: JevHead,
    request: JevHeadRequest,
    transformId: string,
    transformKind: string,
  ): { value: number; parameterId: string; parameterVersion: number; source: 'option_contract' | 'registry_default' } | null {
    if (transformId === 'beta_threshold_v1') {
      return resolveBetaThreshold(optionAbortThreshold(request), this.parameters)
    }
    if (transformKind !== 'threshold') return null
    return resolveThreshold(transformId === 'strategy_change_threshold_v1' ? 'strategy_change_default' : 'boolean_default', this.parameters)
  }

  // -------------------------------------------------------------------------
  // execution
  // -------------------------------------------------------------------------

  private async runSingle(request: JevHeadRequest, expected: 'choice' | 'boolean' | 'score'): Promise<JevHeadResult> {
    const head = this.headById.get(request.headId) ?? null
    if (head !== null && head.primitive !== expected) {
      const prepared = this.prepare(0, request)
      return this.emitPreDispatchFailure({
        ...prepared,
        failure: jevFailure(
          'invalid_request',
          `head ${head.id} has primitive ${head.primitive} but the ${expected} entry point was used`,
          null,
        ),
      })
    }
    const results = await this.runBatch([request])
    const first = results[0]
    if (first === undefined) throw new HarnessConfigurationError('evaluateBatch returned no result for a single request')
    return first
  }

  private async runBatch(requests: readonly JevHeadRequest[]): Promise<readonly JevHeadResult[]> {
    if (requests.length === 0) return []
    const prepared = requests.map((request, index) => this.prepare(index, request))
    const results = new Map<number, JevHeadResult>()
    const toDispatch: PreparedHead[] = []

    for (const head of prepared) {
      if (head.failure !== null) results.set(head.index, this.emitPreDispatchFailure(head))
      else if (head.cacheEntry !== null) results.set(head.index, this.completeFromCache(head, head.cacheEntry))
      else toDispatch.push(head)
    }

    for (const group of this.groupForDispatch(toDispatch)) {
      const outcome = await this.dispatch(group)
      for (const head of group) results.set(head.index, this.completeFromProvider(head, outcome))
    }

    return prepared.map((head) => {
      const result = results.get(head.index)
      if (result === undefined) throw new HarnessConfigurationError(`head ${head.request.headId} produced no result`)
      return result
    })
  }

  /**
   * A provider request may carry several heads ONLY when they share the exact
   * causal identity, projection and registry batch group (#438 section 4). This
   * keeps the batched jev-authority call possible while every head still decodes,
   * calibrates and records independently.
   */
  private groupForDispatch(heads: readonly PreparedHead[]): readonly (readonly PreparedHead[])[] {
    const groups = new Map<string, PreparedHead[]>()
    for (const head of heads) {
      const registryHead = head.head
      if (registryHead === null) continue
      const key = [
        registryHead.batchGroup ?? `single:${registryHead.id}`,
        head.request.identity.decisionEpoch,
        head.request.identity.optionInstanceId ?? '<none>',
        head.request.identity.worldKey,
        String(head.request.identity.worldEpoch),
        head.request.identity.generationId,
        head.projectionHash,
      ].join('|')
      const bucket = groups.get(key)
      if (bucket === undefined) groups.set(key, [head])
      else bucket.push(head)
    }
    return [...groups.values()]
  }

  private async dispatch(heads: readonly PreparedHead[]): Promise<DispatchOutcome> {
    const failureRecords: TransportFailureRecord[] = []
    const started = this.clock()
    const maxAttempts = Math.max(1, this.transport.maxAttempts)
    const first = heads[0]
    const questionIds = heads.map((head) => head.request.headId)
    if (first === undefined) {
      return {
        response: null,
        failure: null,
        transport: this.transportRecord({ attempts: 0, failures: [], retryReason: null, questionIds }),
      }
    }
    const questions = this.buildQuestions(heads)
    let attempt = 0
    let retryReason: string | null = null

    for (;;) {
      attempt += 1
      try {
        const response = await this.options.provider.dispatch({
          questionIds,
          projection: first.request.projection.payload,
          projectionId: first.request.projection.projectionId,
          projectionVersion: first.request.projection.version,
          projectionHash: first.projectionHash,
          questions,
          timeoutMs: this.timeoutMs,
        })
        return {
          response,
          failure: null,
          transport: this.transportRecord({ attempts: attempt, failures: failureRecords, retryReason, questionIds, latencyMs: this.clock() - started }),
        }
      } catch (error) {
        const failure = classifyProviderError(error)
        const willRetry = failure.retryable && attempt < maxAttempts
        failureRecords.push({
          attempt,
          kind: failure.kind,
          detail: failure.message,
          retryable: failure.retryable,
          retryReason: willRetry ? 'transport_retry' : null,
        })
        if (!willRetry) {
          return {
            response: null,
            failure,
            transport: this.transportRecord({
              attempts: attempt,
              failures: failureRecords,
              retryReason,
              questionIds,
              latencyMs: this.clock() - started,
              aborted: failure.kind === 'aborted',
            }),
          }
        }
        // #438 section 8: a retry is only valid while the EXACT semantic request
        // is still current. A moved epoch/world/generation ends the retry and the
        // result is dropped as stale instead of being reused.
        if (!this.currency(first).current) {
          return {
            response: null,
            failure,
            transport: this.transportRecord({
              attempts: attempt,
              failures: failureRecords,
              retryReason: 'stale_before_retry',
              questionIds,
              latencyMs: this.clock() - started,
            }),
          }
        }
        retryReason = `${failure.kind}: retry ${attempt}/${maxAttempts}`
        await this.sleepBackoff(attempt)
      }
    }
  }

  private transportRecord(input: {
    readonly attempts: number
    readonly failures: readonly TransportFailureRecord[]
    readonly retryReason: string | null
    readonly questionIds: readonly string[]
    readonly latencyMs?: number
    readonly aborted?: boolean
  }): TransportRecord {
    return {
      attempts: input.attempts,
      failures: input.failures,
      retryReason: input.retryReason,
      finalAttemptCount: input.attempts,
      latencyMs: input.latencyMs ?? 0,
      timeoutMs: this.timeoutMs,
      aborted: input.aborted ?? false,
      questionIds: input.questionIds,
    }
  }

  private buildQuestions(heads: readonly PreparedHead[]): readonly ProviderQuestion[] {
    return heads.map((head) => {
      const registryHead = head.head
      if (registryHead === null) throw new HarnessConfigurationError('buildQuestions called without a registered head')
      switch (registryHead.primitive) {
        case 'choice':
          return {
            id: registryHead.id,
            primitive: 'choice' as const,
            instructions: this.promptSource(registryHead),
            criteria: choiceCriteria(head.ordered?.candidates ?? []),
          }
        case 'score':
          return {
            id: registryHead.id,
            primitive: 'score' as const,
            instructions: this.promptSource(registryHead),
            criteria: registryHead.scale?.levels ?? [],
          }
        case 'boolean':
          return {
            id: registryHead.id,
            primitive: 'boolean' as const,
            instructions: this.promptSource(registryHead),
            criteria: { true: 'yes, the answer is true', false: 'no, the answer is false' },
          }
      }
    })
  }

  private async sleepBackoff(attempt: number): Promise<void> {
    const delay = Math.min(this.transport.baseDelayMs * 2 ** (attempt - 1), this.transport.maxDelayMs)
    const sleep = this.transport.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    await sleep(delay)
  }

  // -------------------------------------------------------------------------
  // completion paths
  // -------------------------------------------------------------------------

  private completeFromCache(head: PreparedHead, entry: HarnessCacheEntry): JevHeadResult {
    const currency = this.currency(head)
    if (!currency.current) {
      return this.emitStale(head, currency, null, this.transportRecord({ attempts: 0, failures: [], retryReason: null, questionIds: [head.request.headId] }))
    }
    // #15/#438 section 15: a cache hit is evidence-visible and replays the SAME
    // decision; the raw answer is re-decoded against the CURRENT request, so a
    // candidate id that no longer exists fails closed instead of being replayed.
    entry.replays += 1
    return this.complete({
      head,
      raw: entry.rawTypedResponse,
      providerMetadata: null,
      provider: entry.provider,
      model: entry.model,
      transport: this.transportRecord({ attempts: 0, failures: [], retryReason: null, questionIds: [head.request.headId] }),
      cache: { hit: true, source: 'cache', key: entry.key, originalArtifactId: entry.artifactId, bypassed: null },
    })
  }

  private completeFromProvider(head: PreparedHead, outcome: DispatchOutcome): JevHeadResult {
    if (outcome.response === null) {
      const failure = outcome.failure
      const kind: JevFailureKind = failure === null ? 'provider_unavailable' : failure.kind
      const currency = this.currency(head)
      if (!currency.current) return this.emitStale(head, currency, null, outcome.transport)
      const detail = failure?.message ?? 'provider call failed without a classified error'
      return this.emitFailure({
        head,
        kind,
        detail,
        raw: null,
        rawDistribution: null,
        transport: outcome.transport,
        cache: { hit: false, source: 'provider', key: head.cacheKey ?? '', originalArtifactId: null, bypassed: head.cacheBypassed },
      })
    }
    // #438 section 7: verify the request is still current BEFORE accepting.
    const currency = this.currency(head)
    if (!currency.current) return this.emitStale(head, currency, outcome.response, outcome.transport)
    const answer = outcome.response.answers[head.request.headId]
    return this.complete({
      head,
      raw: answer?.raw,
      providerMetadata: outcome.response.providerMetadata,
      provider: outcome.response.provider,
      model: outcome.response.model,
      transport: outcome.transport,
      cache: { hit: false, source: 'provider', key: head.cacheKey ?? '', originalArtifactId: null, bypassed: head.cacheBypassed },
    })
  }

  private complete(input: CompletionInput): JevHeadResult {
    const registryHead = input.head.head
    if (registryHead === null) throw new HarnessConfigurationError('complete() without a registered head')
    switch (registryHead.primitive) {
      case 'choice':
        return this.completeChoice(input, registryHead)
      case 'boolean':
        return this.completeBoolean(input, registryHead)
      case 'score':
        return this.completeScore(input, registryHead)
    }
  }

  private completeChoice(input: CompletionInput, registryHead: JevHead): PiResult {
    const ordered = input.head.ordered
    if (ordered === null) throw new HarnessConfigurationError('choice head without an ordered candidate set')
    const allowed = new Set(ordered.candidates.map((candidate) => candidate.id))
    const decoded = decodeChoice(input.raw, allowed, { allowAbstention: registryHead.abstention === 'provider' })
    if (!decoded.ok) {
      return this.emitFailure({ head: input.head, kind: 'invalid_response', detail: decoded.detail, raw: input.raw, rawDistribution: null, transport: input.transport, cache: input.cache }) as PiResult
    }
    const distribution = decodeChoiceDistribution(input.raw, allowed)
    if (!distribution.ok) {
      return this.emitFailure({ head: input.head, kind: 'invalid_response', detail: distribution.detail, raw: input.raw, rawDistribution: null, transport: input.transport, cache: input.cache }) as PiResult
    }
    const probabilities = distribution.value
    const rawDistribution: RawDistribution = { kind: 'choice', probabilities }
    const transform = requireTransform(registryHead.calibration.transformId, registryHead.calibration.transformVersion)
    const confidence = this.confidence(input.providerMetadata, registryHead)
    const canonicalIds = ordered.candidates.map((candidate) => candidate.id)

    if (decoded.value.kind === 'abstain') {
      const value: PiAbstentionValue = {
        kind: 'abstain',
        decisionEpoch: input.head.request.identity.decisionEpoch,
        headId: registryHead.id,
        headVersion: registryHead.version,
        reason: decoded.value.reason,
        raw: rawDistribution,
        confidence,
        evidence: this.evidenceRef(input.head, input),
      }
      return this.emitOk(input, value, {
        rawDistribution,
        decoded: { primitive: 'choice', candidateId: null, probability: null, score: null, level: null, levelIndex: null, abstentionReason: decoded.value.reason },
        calibration: { transformId: transform.id, transformVersion: transform.version, input: null, output: null, threshold: null, thresholdParameterId: null, thresholdParameterVersion: null, thresholdSource: null },
        finalProposal: { kind: 'abstain', reason: decoded.value.reason },
        confidence,
      }) as PiResult
    }

    const selectedCandidateId = decoded.value.candidateId
    const selectedProbability = probabilities[selectedCandidateId] ?? null
    const calibrated = transform.apply(selectedProbability ?? 0, { probabilities, candidateOrder: canonicalIds })
    const value: PiChoiceValue = {
      kind: 'choice',
      decisionEpoch: input.head.request.identity.decisionEpoch,
      headId: registryHead.id,
      headVersion: registryHead.version,
      selectedCandidateId,
      distribution: distributionOver(ordered.candidates, probabilities),
      raw: rawDistribution,
      calibrated: { transformId: transform.id, transformVersion: transform.version, ranking: rankDistribution(probabilities, canonicalIds), threshold: null },
      confidence,
      evidence: this.evidenceRef(input.head, input),
    }
    return this.emitOk(input, value, {
      rawDistribution,
      decoded: { primitive: 'choice', candidateId: selectedCandidateId, probability: selectedProbability, score: null, level: null, levelIndex: null, abstentionReason: null },
      calibration: { transformId: transform.id, transformVersion: transform.version, input: selectedProbability, output: calibrated, threshold: null, thresholdParameterId: null, thresholdParameterVersion: null, thresholdSource: null },
      finalProposal: { kind: 'selected', candidateId: selectedCandidateId, probability: selectedProbability },
      confidence,
    }) as PiResult
  }

  private completeBoolean(input: CompletionInput, registryHead: JevHead): BetaResult {
    const decoded = decodeBooleanProbability(input.raw)
    if (!decoded.ok) {
      return this.emitFailure({ head: input.head, kind: 'invalid_response', detail: decoded.detail, raw: input.raw, rawDistribution: null, transport: input.transport, cache: input.cache }) as BetaResult
    }
    const rawProbabilityTrue = decoded.value
    const rawDistribution: RawDistribution = { kind: 'boolean', probabilityTrue: rawProbabilityTrue }
    const transform = requireTransform(registryHead.calibration.transformId, registryHead.calibration.transformVersion)
    const thresholdResolution =
      transform.id === 'beta_threshold_v1'
        ? resolveBetaThreshold(optionAbortThreshold(input.head.request), this.parameters)
        : resolveThreshold(transform.id === 'strategy_change_threshold_v1' ? 'strategy_change_default' : 'boolean_default', this.parameters)
    const calibrated = transform.apply(rawProbabilityTrue, { threshold: thresholdResolution.value })
    const proposal = thresholdProposal(calibrated, thresholdResolution.value)
    const confidence = this.confidence(input.providerMetadata, registryHead)
    const value: BetaValue = {
      kind: 'termination',
      decisionEpoch: input.head.request.identity.decisionEpoch,
      headId: registryHead.id,
      headVersion: registryHead.version,
      rawProbabilityTrue,
      raw: rawDistribution,
      calibratedProbability: calibrated,
      threshold: thresholdResolution.value,
      thresholdSource: thresholdResolution.source === 'option_contract' ? 'option_contract' : 'registry_default',
      proposal,
      confidence,
      evidence: this.evidenceRef(input.head, input),
    }
    return this.emitOk(input, value, {
      rawDistribution,
      decoded: { primitive: 'boolean', candidateId: null, probability: rawProbabilityTrue, score: null, level: null, levelIndex: null, abstentionReason: null },
      calibration: {
        transformId: transform.id,
        transformVersion: transform.version,
        input: rawProbabilityTrue,
        output: calibrated,
        threshold: thresholdResolution.value,
        thresholdParameterId: thresholdResolution.parameterId,
        thresholdParameterVersion: thresholdResolution.parameterVersion,
        thresholdSource: thresholdResolution.source,
      },
      finalProposal: { kind: proposal, probability: calibrated, threshold: thresholdResolution.value },
      confidence,
    }) as BetaResult
  }

  private completeScore(input: CompletionInput, registryHead: JevHead): ScoreResult {
    const scaleSpec = registryHead.scale
    if (scaleSpec === undefined) throw new HarnessConfigurationError(`score head ${registryHead.id} has no declared scale`)
    const scale = { id: scaleSpec.id, version: scaleSpec.version, min: scaleSpec.min, max: scaleSpec.max, levels: scaleSpec.levels }
    const decoded = decodeScore(input.raw, scale)
    if (!decoded.ok) {
      return this.emitFailure({ head: input.head, kind: 'invalid_response', detail: decoded.detail, raw: input.raw, rawDistribution: null, transport: input.transport, cache: input.cache }) as ScoreResult
    }
    const rawScore = decoded.value
    const optionalDistribution = decodeOptionalProbabilityMap(input.raw)
    const rawDistribution: RawDistribution = { kind: 'score', rawScore, probabilities: optionalDistribution }
    const transform = requireTransform(registryHead.calibration.transformId, registryHead.calibration.transformVersion)
    const context: CalibrationContext = { scale }
    const levelIndex = Math.trunc(transform.apply(rawScore, context))
    const level = scale.levels[levelIndex] ?? scale.levels[0] ?? ''
    const confidence = this.confidence(input.providerMetadata, registryHead)
    const value: ScoreValue = {
      kind: 'score',
      decisionEpoch: input.head.request.identity.decisionEpoch,
      headId: registryHead.id,
      headVersion: registryHead.version,
      rawScore,
      raw: rawDistribution,
      scale,
      levelIndex,
      level,
      calibratedScore: rawScore,
      confidence,
      evidence: this.evidenceRef(input.head, input),
    }
    return this.emitOk(input, value, {
      rawDistribution,
      decoded: { primitive: 'score', candidateId: null, probability: null, score: rawScore, level, levelIndex, abstentionReason: null },
      calibration: { transformId: transform.id, transformVersion: transform.version, input: rawScore, output: levelIndex, threshold: null, thresholdParameterId: null, thresholdParameterVersion: null, thresholdSource: null },
      finalProposal: { kind: 'score', score: rawScore, level, levelIndex },
      confidence,
    }) as ScoreResult
  }

  // -------------------------------------------------------------------------
  // artifact emission
  // -------------------------------------------------------------------------

  private emitOk<T extends { evidence: DecisionEvidenceRef }>(
    input: CompletionInput,
    value: T,
    record: {
      readonly rawDistribution: RawDistribution | null
      readonly decoded: DecodedRecord
      readonly calibration: AppliedCalibration
      readonly finalProposal: FinalProposal
      readonly confidence: ConfidenceMetadata | null
    },
  ): JevResult<T> {
    const head = input.head
    const registryHead = head.head
    if (registryHead === null) throw new HarnessConfigurationError('emitOk without a registered head')
    const artifact = buildDecisionArtifact({
      run: this.options.run,
      createdAt: this.now().toISOString(),
      decisionId: head.decisionId,
      identity: toCausalIdentity(head.request.identity),
      headId: registryHead.id,
      headVersion: registryHead.version,
      headStatus: registryHead.status,
      primitive: registryHead.primitive,
      resultSchema: registryHead.resultSchema,
      projectionId: head.request.projection.projectionId,
      projectionVersion: head.request.projection.version,
      projectionHash: head.projectionHash,
      projection: head.request.projection.payload,
      candidateIds: head.ordered?.candidates.map((candidate) => candidate.id) ?? [],
      serializedCandidateIds: head.ordered?.candidates.map((candidate) => candidate.id) ?? [],
      candidateOrdering: head.ordered?.ordering ?? 'canonical',
      candidateOrderSalt: head.ordered?.salt ?? null,
      candidateSetHash: head.candidateSetHash,
      candidates: head.ordered?.candidates ?? [],
      provider: input.provider,
      model: input.model,
      transport: input.transport,
      cache: input.cache,
      rawTypedResponse: input.raw,
      rawDistribution: record.rawDistribution,
      decoded: record.decoded,
      calibration: record.calibration,
      finalProposal: record.finalProposal,
      staleCheck: {
        checked: true,
        current: true,
        reason: null,
        mismatches: [],
        bound: toCausalIdentity(head.request.identity),
        observed: this.options.identity.current(),
      },
      result: { ok: true },
      confidence: record.confidence,
      fallbackAuthority: 'model',
      modelAnswerPresent: true,
      commitmentContext: head.request.commitmentContext ?? null,
      stage: head.request.stage ?? null,
    })
    this.options.artifacts.append(artifact)
    const cache = this.options.cache ?? null
    if (cache !== null && input.cache.key !== '' && !input.cache.hit) {
      cache.put({
        key: input.cache.key,
        headId: registryHead.id,
        headVersion: registryHead.version,
        artifactId: artifact.artifactId,
        decisionId: artifact.decisionId,
        candidateSetHash: head.candidateSetHash,
        rawTypedResponse: input.raw,
        rawDistribution: record.rawDistribution,
        selectedCandidateId: record.finalProposal.kind === 'selected' ? record.finalProposal.candidateId : null,
        provider: input.provider,
        model: input.model,
        createdAtMs: this.now().getTime(),
        replays: 0,
      })
    }
    const withArtifact = { ...value, evidence: { ...value.evidence, artifactId: artifact.artifactId } } as T
    return jevOk(withArtifact, artifact.artifactId)
  }

  private emitFailure(input: {
    readonly head: PreparedHead
    readonly kind: JevFailureKind
    readonly detail: string | null
    readonly raw: unknown
    readonly rawDistribution: RawDistribution | null
    readonly transport: TransportRecord
    readonly cache: CacheRecord
  }): JevResult<never> {
    const head = input.head
    const registryHead = head.head
    const dispatched = input.transport.questionIds.length > 0
    const artifact = buildDecisionArtifact({
      run: this.options.run,
      createdAt: this.now().toISOString(),
      decisionId: head.decisionId,
      identity: toCausalIdentity(head.request.identity),
      headId: registryHead?.id ?? head.request.headId,
      headVersion: registryHead?.version ?? 0,
      headStatus: registryHead?.status ?? null,
      primitive: registryHead?.primitive ?? null,
      resultSchema: registryHead?.resultSchema ?? null,
      projectionId: head.request.projection.projectionId,
      projectionVersion: head.request.projection.version,
      projectionHash: head.projectionHash,
      projection: head.request.projection.payload,
      candidateIds: head.ordered?.candidates.map((candidate) => candidate.id) ?? [],
      serializedCandidateIds: head.ordered?.candidates.map((candidate) => candidate.id) ?? [],
      candidateOrdering: head.ordered?.ordering ?? 'canonical',
      candidateOrderSalt: head.ordered?.salt ?? null,
      candidateSetHash: head.candidateSetHash,
      candidates: head.ordered?.candidates ?? [],
      provider: dispatched ? this.options.provider.providerId : null,
      model: dispatched ? this.options.provider.modelId : null,
      transport: input.transport,
      cache: input.cache,
      rawTypedResponse: input.raw,
      rawDistribution: input.rawDistribution,
      decoded: null,
      calibration: null,
      finalProposal: { kind: 'none', reason: input.kind },
      staleCheck: {
        checked: true,
        current: true,
        reason: null,
        mismatches: [],
        bound: toCausalIdentity(head.request.identity),
        observed: this.options.identity.current(),
      },
      result: { ok: false, kind: input.kind, detail: input.detail },
      confidence: null,
      fallbackAuthority: 'code',
      modelAnswerPresent: false,
      commitmentContext: head.request.commitmentContext ?? null,
      stage: head.request.stage ?? null,
    })
    this.options.artifacts.append(artifact)
    return jevFailure(input.kind, input.detail, artifact.artifactId)
  }

  private emitPreDispatchFailure(head: PreparedHead): JevFailure {
    const failure = head.failure
    if (failure === null) throw new HarnessConfigurationError('emitPreDispatchFailure without a failure')
    const result = this.emitFailure({
      head,
      kind: failure.kind,
      detail: failure.detail,
      raw: null,
      rawDistribution: null,
      transport: this.transportRecord({ attempts: 0, failures: [], retryReason: null, questionIds: [] }),
      cache: { hit: false, source: 'provider', key: head.cacheKey ?? '', originalArtifactId: null, bypassed: head.cacheBypassed },
    })
    return { ...failure, artifactId: result.artifactId }
  }

  private emitStale(
    head: PreparedHead,
    currency: Extract<CurrencyCheck, { current: false }>,
    response: ProviderDispatchResponse | null,
    transport: TransportRecord,
  ): JevResult<never> {
    const detail = describeStale(currency)
    const registryHead = head.head
    const artifact = buildDecisionArtifact({
      run: this.options.run,
      createdAt: this.now().toISOString(),
      decisionId: head.decisionId,
      identity: toCausalIdentity(head.request.identity),
      headId: registryHead?.id ?? head.request.headId,
      headVersion: registryHead?.version ?? 0,
      headStatus: registryHead?.status ?? null,
      primitive: registryHead?.primitive ?? null,
      resultSchema: registryHead?.resultSchema ?? null,
      projectionId: head.request.projection.projectionId,
      projectionVersion: head.request.projection.version,
      projectionHash: head.projectionHash,
      projection: head.request.projection.payload,
      candidateIds: head.ordered?.candidates.map((candidate) => candidate.id) ?? [],
      serializedCandidateIds: head.ordered?.candidates.map((candidate) => candidate.id) ?? [],
      candidateOrdering: head.ordered?.ordering ?? 'canonical',
      candidateOrderSalt: head.ordered?.salt ?? null,
      candidateSetHash: head.candidateSetHash,
      candidates: head.ordered?.candidates ?? [],
      provider: response?.provider ?? null,
      model: response?.model ?? null,
      transport,
      cache: { hit: false, source: 'provider', key: head.cacheKey ?? '', originalArtifactId: null, bypassed: head.cacheBypassed },
      rawTypedResponse: response?.answers[head.request.headId]?.raw ?? null,
      rawDistribution: null,
      decoded: null,
      calibration: null,
      finalProposal: { kind: 'none', reason: 'stale' },
      staleCheck: {
        checked: true,
        current: false,
        reason: currency.reason,
        mismatches: currency.mismatches,
        bound: toCausalIdentity(head.request.identity),
        observed: this.options.identity.current(),
      },
      result: { ok: false, kind: 'stale', detail },
      confidence: null,
      fallbackAuthority: 'code',
      modelAnswerPresent: false,
      commitmentContext: head.request.commitmentContext ?? null,
      stage: head.request.stage ?? null,
    })
    this.options.artifacts.append(artifact)
    const staleRecord: HarnessRecord = {
      record: STALE_JEV_RESULT_DROPPED,
      ts: this.now().toISOString(),
      runId: this.options.run.runId,
      artifactId: artifact.artifactId,
      headId: registryHead?.id ?? head.request.headId,
      decisionEpoch: head.request.identity.decisionEpoch,
      reason: currency.reason,
      detail,
      mismatches: currency.mismatches,
    }
    this.options.artifacts.append(staleRecord)
    // #438 section 7 / I5: the dropped answer is never reinterpreted against the
    // newer state, and it can never authorize execution.
    return jevFailure('stale', detail, artifact.artifactId)
  }

  private evidenceRef(head: PreparedHead, input: CompletionInput): DecisionEvidenceRef {
    return {
      artifactId: '',
      decisionId: head.decisionId,
      runId: this.options.run.runId,
      headId: head.head?.id ?? head.request.headId,
      headVersion: head.head?.version ?? 0,
      decisionEpoch: head.request.identity.decisionEpoch,
      optionInstanceId: head.request.identity.optionInstanceId,
      projectionId: head.request.projection.projectionId,
      projectionVersion: head.request.projection.version,
      projectionHash: head.projectionHash,
      candidateSetHash: head.candidateSetHash,
      cache: {
        hit: input.cache.hit,
        source: input.cache.source,
        key: input.cache.key,
        originalArtifactId: input.cache.originalArtifactId,
        bypassed: input.cache.bypassed,
      },
      commitmentContext: head.request.commitmentContext ?? null,
    }
  }

  private currency(head: PreparedHead): CurrencyCheck {
    return checkCurrency(toCausalIdentity(head.request.identity), this.options.identity.current())
  }

  private confidence(providerMetadata: unknown, head: JevHead): ConfidenceMetadata {
    const value = decodeCalibratedConfidence(providerMetadata, head.id)
    return confidenceMetadata(value, value === null ? 'none' : 'provider_calibrated_confidence', head.abstention === 'provider')
  }
}

interface CompletionInput {
  readonly head: PreparedHead
  readonly raw: unknown
  readonly providerMetadata: unknown
  readonly provider: string
  readonly model: string
  readonly transport: TransportRecord
  readonly cache: CacheRecord
}

function optionAbortThreshold(request: JevHeadRequest): number | null {
  if ('option' in request) {
    const option = (request as PiRequest | BetaRequest).option
    if (option !== undefined && option !== null) return option.abortThreshold
  }
  return null
}
