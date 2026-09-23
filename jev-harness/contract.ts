// jev-harness/contract.ts - the repo-owned Jev semantic contract (#438 section 1/2/9/13).
//
// This module is the ONLY vocabulary production code is allowed to use when it
// asks Jev a question. It contains no provider concept: there is no `Noul`, no
// `boolean probability`, no `experimental_evaluate`, no gateway response shape.
// The repo speaks pi (choose), beta (terminate?), score (ordered quantity).
//
// Authority reminder (#11 / #221 / #436):
//   Code     = CAN / TRUE / SAFE / DONE
//   Jev pi   = WHICH grounded candidate
//   Jev beta = WHETHER the active Option should end
//   Jev score= a grounded ordered estimate consumed by deterministic gates
//
// Nothing in this file authorizes execution. A model answer is a *proposal*
// with metadata; Guard/VERIFY keep CAN/TRUE/SAFE/DONE.

// ---------------------------------------------------------------------------
// identity vocabulary
// ---------------------------------------------------------------------------

/** A candidate id minted by deterministic code. The model may only pick one. */
export type CandidateId = string
/** #437 section 2 spells this `decisionEpoch: number`; keep the repo-side name. */
export type DecisionEpoch = number
export type HeadId = string
export type HeadVersion = number
export type ProjectionId = string
export type ArtifactId = string
/** #436 section 4: the id minted for one Jev pi selection (`SkillCommitment.decisionId`). */
export type DecisionId = string
export type RunId = string

export type JevPrimitive = 'choice' | 'boolean' | 'score'

/**
 * Which architectural layer owns the semantic question. This is NOT the module
 * that happens to call the model today; it is the authority the head belongs to.
 * `risk` heads are safety estimates (never a plan choice), `system2` heads are
 * WHAT-intent heads, `advisor` is the strategy advisor.
 */
export type JevAuthorityOwner = 'jev_pi' | 'jev_beta' | 'risk' | 'system2' | 'advisor' | 'diagnostic'

/** #4: production-authoritative, shadow-only, or diagnostic. */
export type HeadStatus = 'production' | 'shadow' | 'diagnostic'

// ---------------------------------------------------------------------------
// section 9 result algebra
// ---------------------------------------------------------------------------

/**
 * The harness result algebra (#438 section 9). A failure is a first-class,
 * typed causal fact. It is never collapsed into `first candidate`, `WAIT`,
 * `false`, `0.25`, or `continue`.
 *
 * `unregistered_head` and `invalid_request` are additions beyond the issue's
 * minimum list: section 22 I2 requires that an unregistered head cannot execute,
 * and the only way to express that without throwing is a typed failure. Both are
 * *request-side* failures (a code bug or a stale call site), not model failures.
 */
export type JevFailureKind =
  | 'provider_unavailable'
  | 'timeout'
  | 'invalid_response'
  | 'stale'
  | 'empty_candidate_set'
  | 'unregistered_head'
  | 'invalid_request'
  | 'aborted'

/** Present on every failure. A failure never carries a model answer. */
export interface JevFailure {
  readonly ok: false
  readonly kind: JevFailureKind
  readonly detail: string | null
  /** Structurally false: this is what `fallback_authority=code` means (#438 section 9). */
  readonly modelAnswerPresent: false
  readonly fallbackAuthority: 'code'
  /** Artifact for this invocation, when one was emitted. */
  readonly artifactId: ArtifactId | null
}

export interface JevOk<T> {
  readonly ok: true
  readonly value: T
  readonly artifactId: ArtifactId | null
}

/** `PiHarnessResult` / `BetaHarnessResult` / `ScoreHarnessResult` in #438 section 9. */
export type JevResult<T> = JevOk<T> | JevFailure

export function jevOk<T>(value: T, artifactId: ArtifactId | null): JevOk<T> {
  return { ok: true, value, artifactId }
}

export function jevFailure(
  kind: JevFailureKind,
  detail: string | null,
  artifactId: ArtifactId | null,
): JevFailure {
  return {
    ok: false,
    kind,
    detail,
    modelAnswerPresent: false,
    fallbackAuthority: 'code',
    artifactId,
  }
}

export function isJevOk<T>(result: JevResult<T>): result is JevOk<T> {
  return result.ok
}

/** Explicit accessor: `unwrapOrNull` returns null on failure, never a default answer. */
export function unwrapOrNull<T>(result: JevResult<T>): T | null {
  return result.ok ? result.value : null
}

// ---------------------------------------------------------------------------
// section 11/12: raw distribution + confidence metadata
// ---------------------------------------------------------------------------

/**
 * The provider's raw probabilistic result, retained BEFORE any calibration
 * transform (#438 section 11 / I7). Nothing in the harness may drop it.
 */
export type RawDistribution =
  | { readonly kind: 'choice'; readonly probabilities: Readonly<Record<string, number>> }
  | { readonly kind: 'boolean'; readonly probabilityTrue: number }
  | {
      readonly kind: 'score'
      readonly rawScore: number
      readonly probabilities: Readonly<Record<string, number>> | null
    }

export interface CandidateProbability {
  readonly candidateId: CandidateId
  readonly probability: number
}

/**
 * Confidence is METADATA (#438 section 12). It never means the candidate is
 * safe/reachable/doable, and no harness transform may bypass Guard because of it.
 * `meansAbstention` is true only when the *head* declares provider abstention
 * (#438 section 13) - a low confidence is not an abstention.
 */
export interface ConfidenceMetadata {
  readonly value: number | null
  readonly source: 'provider_calibrated_confidence' | 'none'
  /** Structurally false. There is no configuration that turns this true. */
  readonly guardBypass: false
  readonly meansAbstention: boolean
}

export function confidenceMetadata(
  value: number | null,
  source: 'provider_calibrated_confidence' | 'none',
  headDeclaresProviderAbstention: boolean,
): ConfidenceMetadata {
  return {
    value,
    source,
    guardBypass: false,
    meansAbstention: headDeclaresProviderAbstention && value === null,
  }
}

// ---------------------------------------------------------------------------
// section 13: explicit abstention
// ---------------------------------------------------------------------------

/**
 * Abstention is an explicit algebra member, never a confidence threshold hack.
 * `provider_abstained` may only be produced by a head whose registry entry
 * declares `abstention: 'provider'`; otherwise a missing choice is
 * `invalid_response` (#438 section 10).
 */
export type AbstentionReason = 'provider_abstained' | 'provider_no_decision'

// ---------------------------------------------------------------------------
// evidence reference carried into Guard / SkillCommitment (#436 section 4/19)
// ---------------------------------------------------------------------------

export interface CommitmentContext {
  readonly commitmentId: string | null
  readonly optionInstanceId: string | null
  readonly optionTemplateId: string | null
}

export type CacheSource = 'provider' | 'cache' | 'replay'

export interface DecisionCacheEvidence {
  readonly hit: boolean
  readonly source: CacheSource
  readonly key: string
  readonly originalArtifactId: ArtifactId | null
  readonly bypassed: 'replay_limit' | null
}

export interface DecisionEvidenceRef {
  readonly artifactId: ArtifactId
  /** #436 `SkillCommitment.decisionId`: minted here so the causal chain starts at the decision. */
  readonly decisionId: DecisionId
  readonly runId: RunId
  readonly headId: HeadId
  readonly headVersion: HeadVersion
  readonly decisionEpoch: DecisionEpoch
  readonly optionInstanceId: string | null
  readonly projectionId: ProjectionId
  readonly projectionVersion: number
  readonly projectionHash: string
  readonly candidateSetHash: string
  readonly cache: DecisionCacheEvidence
  readonly commitmentContext: CommitmentContext | null
}

// ---------------------------------------------------------------------------
// success values (section 1/2)
// ---------------------------------------------------------------------------

export interface PiChoiceValue {
  readonly kind: 'choice'
  readonly decisionEpoch: DecisionEpoch
  readonly headId: HeadId
  readonly headVersion: HeadVersion
  readonly selectedCandidateId: CandidateId
  /** Full repo-level distribution over the exact request candidate set. */
  readonly distribution: readonly CandidateProbability[]
  readonly raw: RawDistribution
  readonly calibrated: {
    readonly transformId: string
    readonly transformVersion: number
    /** Ranking after the transform, before any deterministic threshold. */
    readonly ranking: readonly CandidateProbability[]
    readonly threshold: number | null
  }
  readonly confidence: ConfidenceMetadata
  readonly evidence: DecisionEvidenceRef
}

export interface PiAbstentionValue {
  readonly kind: 'abstain'
  readonly decisionEpoch: DecisionEpoch
  readonly headId: HeadId
  readonly headVersion: HeadVersion
  readonly reason: AbstentionReason
  readonly raw: RawDistribution
  readonly confidence: ConfidenceMetadata
  readonly evidence: DecisionEvidenceRef
}

/** #438 section 9 `PiHarnessResult`. */
export type PiResult = JevResult<PiChoiceValue | PiAbstentionValue>
/** #438 section 1 spelling. */
export type PiHarnessResult = PiResult

export type TerminationProposal = 'terminate' | 'continue'

export interface BetaValue {
  readonly kind: 'termination'
  readonly decisionEpoch: DecisionEpoch
  readonly headId: HeadId
  readonly headVersion: HeadVersion
  /** Raw P(terminate=true) exactly as produced by the provider, never transformed. */
  readonly rawProbabilityTrue: number
  readonly raw: RawDistribution
  readonly calibratedProbability: number
  readonly threshold: number
  readonly thresholdSource: 'option_contract' | 'registry_default'
  readonly proposal: TerminationProposal
  readonly confidence: ConfidenceMetadata
  readonly evidence: DecisionEvidenceRef
}

export type BetaResult = JevResult<BetaValue>
export type BetaHarnessResult = BetaResult

export interface ScoreScale {
  readonly id: string
  readonly version: number
  readonly min: number
  readonly max: number
  readonly levels: readonly string[]
}

export interface ScoreValue {
  readonly kind: 'score'
  readonly decisionEpoch: DecisionEpoch
  readonly headId: HeadId
  readonly headVersion: HeadVersion
  /** Raw provider score, before calibration/level derivation. */
  readonly rawScore: number
  readonly raw: RawDistribution
  readonly scale: ScoreScale
  readonly levelIndex: number
  readonly level: string
  readonly calibratedScore: number
  readonly confidence: ConfidenceMetadata
  readonly evidence: DecisionEvidenceRef
}

export type ScoreResult = JevResult<ScoreValue>
export type ScoreHarnessResult = ScoreResult

// ---------------------------------------------------------------------------
// section 6: unknown is not false
// ---------------------------------------------------------------------------

/**
 * Epistemic state that survives serialization. `unknown`, `not_observed` and
 * `sensor_error` must never be collapsed into `false` / `0` / `[]` (#438 section
 * 6, #22 I12). There is deliberately NO `valueOf()` / `toBoolean()` / `unwrap()
 * with a default` on this type: the only way to get the value is `requireKnown`,
 * which throws. That makes silent defaulting inexpressible.
 */
export type Epistemic<T> =
  | { readonly state: 'known'; readonly value: T }
  | { readonly state: 'unknown' }
  | { readonly state: 'not_observed' }
  | { readonly state: 'sensor_error'; readonly detail: string }

export class UnknownFactError extends Error {
  constructor(context: string, state: string) {
    super(`epistemic fact is not known (${state}) where a value is required: ${context}`)
    this.name = 'UnknownFactError'
  }
}

export const UNKNOWN: Epistemic<never> = Object.freeze({ state: 'unknown' })
export const NOT_OBSERVED: Epistemic<never> = Object.freeze({ state: 'not_observed' })

export function known<T>(value: T): Epistemic<T> {
  return { state: 'known', value }
}

export function notObserved<T = never>(): Epistemic<T> {
  return NOT_OBSERVED as Epistemic<T>
}

export function sensorError<T = never>(detail: string): Epistemic<T> {
  return { state: 'sensor_error', detail }
}

export function isKnown<T>(fact: Epistemic<T>): fact is { state: 'known'; value: T } {
  return fact.state === 'known'
}

/** The only sanctioned way to read an epistemic fact. Throws instead of defaulting. */
export function requireKnown<T>(fact: Epistemic<T>, context: string): T {
  if (fact.state !== 'known') throw new UnknownFactError(context, fact.state)
  return fact.value
}

/**
 * Serialize an epistemic fact without fabricating certainty. JSON keeps the
 * discriminator; a consumer that wants `false` must say so explicitly and is
 * then visibly wrong in review/diff.
 */
export function epistemicToJson(fact: Epistemic<unknown>): Record<string, unknown> {
  switch (fact.state) {
    case 'known':
      return { state: 'known', value: fact.value }
    case 'sensor_error':
      return { state: 'sensor_error', detail: fact.detail }
    case 'unknown':
      return { state: 'unknown' }
    case 'not_observed':
      return { state: 'not_observed' }
  }
}

// ---------------------------------------------------------------------------
// semantic projection contract (#438 section 5; #437 owns the concrete payload)
// ---------------------------------------------------------------------------

/**
 * A versioned, deterministic, bounded, plain-data projection of the semantic
 * state. The harness owns this *contract*; #437 owns the concrete payload that
 * fills it. Projections must be free of live object references and of
 * irrelevant high-frequency body churn.
 */
export interface SemanticProjection<P = Readonly<Record<string, unknown>>> {
  readonly projectionId: ProjectionId
  readonly version: number
  readonly payload: P
}

// ---------------------------------------------------------------------------
// request identity + typed requests (#438 section 2/7)
// ---------------------------------------------------------------------------

/**
 * The causal identity a request binds to (#438 section 7). The harness
 * re-verifies every one of these against the live identity source before it
 * accepts a model answer.
 *
 * `projectionHash` / `candidateSetHash` are derived by the harness from the
 * exact request payload, so they cannot disagree with what the model saw; they
 * are recorded on the request record and the artifact.
 */
export interface RequestIdentity {
  readonly decisionEpoch: DecisionEpoch
  readonly optionInstanceId: string | null
  readonly worldKey: string
  readonly worldEpoch: number
  readonly generationId: string
  /** Optional stable id for the Skill commitment context (#436) when one exists. */
  readonly commitmentId?: string | null
}

export interface OptionProjection {
  readonly optionInstanceId: string | null
  readonly templateId: string | null
  readonly intent: string | null
  /** Symbolic, code-owned precondition facts (already projected; not raw sensors). */
  readonly preconditions: readonly string[]
  /** Symbolic, code-owned success facts. */
  readonly successFacts: readonly string[]
  /** Option-contract beta threshold when the Option owns one (#11). */
  readonly abortThreshold: number | null
  readonly allowedSkills: readonly string[]
}

/** #437 section 2 `SkillOutcomePacket`, projected down to what Jev reasons about. */
export interface SkillOutcomeProjection {
  readonly decisionEpoch: DecisionEpoch
  readonly commitmentId: string
  readonly optionInstanceId: string
  readonly selectedCandidateId: string
  readonly skillKind: string
  readonly targetIdentity: string
  readonly terminalReason:
    | 'done'
    | 'blocked'
    | 'drop_not_acquired'
    | 'target_lost'
    | 'safety_interrupted'
    | 'capability_lost'
    | 'budget_exhausted'
    | 'world_changed'
    | 'lease_revoked'
  readonly verification: 'verified' | 'not_verified' | 'unknown'
  readonly semanticProgress: 'none' | 'partial' | 'achieved' | 'unknown'
  readonly failure: string | null
  readonly meaningfulWorldDelta: readonly string[]
  readonly nextDecisionRequired: boolean
}

interface RequestCommon {
  readonly headId: HeadId
  readonly identity: RequestIdentity
  readonly projection: SemanticProjection
  readonly stage?: string
  readonly commitmentContext?: CommitmentContext | null
}

export interface PiRequest extends RequestCommon {
  readonly candidates: readonly GroundedSemanticCandidate[]
  readonly option?: OptionProjection | null
  readonly previousOutcome?: SkillOutcomeProjection | null
}

export interface BetaRequest extends RequestCommon {
  readonly option?: OptionProjection | null
  readonly previousOutcome?: SkillOutcomeProjection | null
}

export interface ScoreRequest extends RequestCommon {}

export type JevHeadRequest = PiRequest | BetaRequest | ScoreRequest
export type JevHeadResult = PiResult | BetaResult | ScoreResult

// ---------------------------------------------------------------------------
// candidate vocabulary (section 3/20)
// ---------------------------------------------------------------------------

/**
 * Typed causal target identity (#436 section 4). Kept structural so the harness
 * never imports planner/runtime types.
 */
export interface CandidateTargetIdentity {
  readonly kind:
    | 'entity'
    | 'block'
    | 'station'
    | 'item'
    | 'position'
    | 'region'
    | 'portal_site'
    | 'option'
  /** Entity id / UUID-equivalent causal identity, block position, station key, item name... */
  readonly identity: string
  /** Extra plain-data identity facts (expected block name, worldEpoch, dimension...). */
  readonly facts?: Readonly<Record<string, string | number | boolean>>
}

/**
 * A grounded semantic candidate: the closed world Jev pi may choose from
 * (#438 section 3). Identity is typed and stable (#437 section 4); the
 * human-readable description is generated from typed facts (#438 section 21).
 */
export interface GroundedSemanticCandidate {
  readonly id: CandidateId
  readonly skillKind: string
  readonly target: CandidateTargetIdentity | null
  readonly postcondition: string | null
  /** Deterministic factual metadata only (#438 section 20). */
  readonly facts: Readonly<Record<string, CandidateFactValue>>
  /** Human-readable text generated from the typed facts; never the authority. */
  readonly description?: string
}

/** Fact values are plain data, and `unknown` stays explicit (#438 section 6). */
export type CandidateFactValue =
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'not_observed' }

// ---------------------------------------------------------------------------
// harness interface (#438 section 1)
// ---------------------------------------------------------------------------

/**
 * Exactly one production abstraction can invoke Jev (#438 section 1).
 *
 * `evaluateBatch` is the one addition to the issue's three-method sketch. Phase A
 * measured that jev-authority.ts today batches several heads (pi action, beta
 * abandon, danger score, retreat boolean) into ONE provider request. Exposing
 * only per-head methods would multiply model calls during migration, so the
 * interface exposes per-head typed requests *and* a coalescing entry point. The
 * batching is an adapter-level optimisation: each head still decodes, calibrates,
 * fences, and records its own typed result and artifact.
 */
export interface JevHarness {
  choose(request: PiRequest): Promise<PiResult>
  shouldTerminate(request: BetaRequest): Promise<BetaResult>
  score(request: ScoreRequest): Promise<ScoreResult>
  /** One provider request for several heads; per-head typed results in request order. */
  evaluateBatch(requests: readonly JevHeadRequest[]): Promise<readonly JevHeadResult[]>
}

// ---------------------------------------------------------------------------
// hooks for the rest of the causal chain (#436 section 4/17, #437 section 2)
// ---------------------------------------------------------------------------

/**
 * #436 section 4: what a caller needs to build a `SkillCommitment` from this
 * decision. `decisionId` is the harness-minted id; it must not be reissued.
 */
export interface SkillCommitmentHandoff {
  readonly decisionId: DecisionId
  readonly artifactId: ArtifactId
  readonly decisionEpoch: DecisionEpoch
  readonly optionInstanceId: string | null
  readonly candidateId: CandidateId
  /** The projection hash is the #436 `selectedAtStateFingerprint` basis. */
  readonly selectedAtStateFingerprint: string
}

/**
 * Build the handoff that threads a decision into #436/#437. Fails closed when the
 * result is not an authoritative (non-stale, ok) selection: a stale or failed
 * result must never create a SkillCommitment (#25.8).
 */
export function skillCommitmentHandoff(
  result: PiResult,
  live: { decisionEpoch: DecisionEpoch; optionInstanceId: string | null },
): SkillCommitmentHandoff | null {
  if (!result.ok) return null
  const value = result.value
  if (value.kind !== 'choice') return null
  if (value.decisionEpoch !== live.decisionEpoch) return null
  if (value.evidence.optionInstanceId !== live.optionInstanceId) return null
  return {
    decisionId: value.evidence.decisionId,
    artifactId: value.evidence.artifactId,
    decisionEpoch: value.decisionEpoch,
    optionInstanceId: value.evidence.optionInstanceId,
    candidateId: value.selectedCandidateId,
    selectedAtStateFingerprint: value.evidence.projectionHash,
  }
}
