// jev-harness/artifacts.ts - one immutable, run-scoped decision artifact per invocation (#438 section 18).
//
// "Do not require digging through unrelated logs to know what Jev actually saw
// and returned." The artifact is the replay-corpus unit: it records the exact
// projection, the exact candidate serialization and order, the provider/model,
// transport attempts, the RAW typed response and RAW distribution before any
// transform, the decoded repo-level result, the calibration version, the final
// proposal, and the stale check.
//
// Later causal links (Guard disposition, #436 SkillCommitment, #437
// SkillOutcomePacket) are separate immutable records joined by `artifactId` /
// `decisionId`, so the decision artifact itself never mutates.

import type {
  AbstentionReason,
  ArtifactId,
  CandidateProbability,
  ConfidenceMetadata,
  DecisionEpoch,
  DecisionEvidenceRef,
  DecisionId,
  GroundedSemanticCandidate,
  HeadId,
  HeadStatus,
  HeadVersion,
  JevFailureKind,
  JevPrimitive,
  RawDistribution,
  RunId,
  TerminationProposal,
} from './contract.ts'
import type { AppliedCalibration } from './calibration.ts'
import type { CandidateOrderingKind } from './candidates.ts'
import type { CausalIdentity, StaleReason } from './identity.ts'
import { deepFreeze, hashId } from './canonical.ts'

export const DECISION_ARTIFACT_SCHEMA_VERSION = 1

export class ArtifactIntegrityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArtifactIntegrityError'
  }
}

export interface RunIdentity {
  readonly runId: RunId
  readonly sourceSha: string
  readonly dirtyTree: boolean
}

export interface TransportFailureRecord {
  readonly attempt: number
  readonly kind: JevFailureKind
  readonly detail: string | null
  readonly retryable: boolean
  readonly retryReason: string | null
}

export interface TransportRecord {
  readonly attempts: number
  readonly failures: readonly TransportFailureRecord[]
  readonly retryReason: string | null
  readonly finalAttemptCount: number
  readonly latencyMs: number
  readonly timeoutMs: number
  readonly aborted: boolean
  /** Heads batched into this provider request (one shared transport record). */
  readonly questionIds: readonly string[]
}

export interface DecodedRecord {
  readonly primitive: JevPrimitive
  readonly candidateId: string | null
  readonly probability: number | null
  readonly score: number | null
  readonly level: string | null
  readonly levelIndex: number | null
  readonly abstentionReason: AbstentionReason | null
}

export type FinalProposal =
  | { readonly kind: 'selected'; readonly candidateId: string; readonly probability: number | null }
  | { readonly kind: 'abstain'; readonly reason: AbstentionReason }
  | { readonly kind: 'terminate'; readonly probability: number; readonly threshold: number }
  | { readonly kind: 'continue'; readonly probability: number; readonly threshold: number }
  | { readonly kind: 'score'; readonly score: number; readonly level: string; readonly levelIndex: number }
  | { readonly kind: 'none'; readonly reason: JevFailureKind }

export interface StaleCheckRecord {
  readonly checked: boolean
  readonly current: boolean
  readonly reason: StaleReason | null
  readonly mismatches: readonly { readonly field: StaleReason; readonly expected: string | number | null; readonly observed: string | number | null }[]
  readonly bound: CausalIdentity
  readonly observed: CausalIdentity | null
}

/**
 * Hook for the deterministic Guard verdict that follows a decision (#436 section
 * 5). Usually null at decision time; `linkGuardDisposition` records it later.
 */
export interface GuardDisposition {
  readonly admitted: boolean
  readonly candidateId: string
  readonly reason: string | null
  readonly guardVersion: string
  readonly decidedAt: string
}

/** Hook for the #437 SkillOutcomePacket that eventually closes this decision. */
export interface SkillOutcomeLink {
  readonly commitmentId: string
  readonly decisionId: DecisionId
  readonly selectedCandidateId: string
  readonly terminalReason: string
  readonly verification: 'verified' | 'not_verified' | 'unknown'
  readonly semanticProgress: 'none' | 'partial' | 'achieved' | 'unknown'
  readonly failure: string | null
}

export interface DecisionArtifact {
  readonly record: 'JEV_DECISION'
  readonly schemaVersion: number
  readonly artifactId: ArtifactId
  /** #436 `SkillCommitment.decisionId`: the causal id of this selection. */
  readonly decisionId: DecisionId
  readonly createdAt: string

  // run scope (#63 run-scoped evidence)
  readonly runId: RunId
  readonly sourceSha: string
  readonly dirtyTree: boolean

  // causal identity (#438 section 7 / #437 section 3)
  readonly worldKey: string
  readonly worldEpoch: number
  readonly generationId: string
  readonly decisionEpoch: DecisionEpoch
  readonly optionInstanceId: string | null

  // head identity (#438 section 4)
  readonly headId: HeadId
  readonly headVersion: HeadVersion
  readonly headStatus: HeadStatus | null
  readonly primitive: JevPrimitive | null
  readonly resultSchema: string | null

  // projection identity (#438 section 5)
  readonly projectionId: string
  readonly projectionVersion: number
  readonly projectionVersionKey: string
  readonly projectionHash: string
  readonly projection: unknown

  // candidate world (#438 section 3/14/18)
  readonly candidateIds: readonly string[]
  readonly serializedCandidateIds: readonly string[]
  readonly candidateOrdering: CandidateOrderingKind
  readonly candidateOrderSalt: string | null
  readonly candidateSetHash: string
  readonly candidates: readonly GroundedSemanticCandidate[]

  // provider/transport (#438 section 8/16)
  readonly provider: string | null
  readonly model: string | null
  readonly transport: TransportRecord

  // cache (#438 section 15)
  readonly cache: {
    readonly hit: boolean
    readonly source: 'provider' | 'cache' | 'replay'
    readonly key: string
    readonly originalArtifactId: ArtifactId | null
    readonly bypassed: 'replay_limit' | null
  }

  // what the provider actually returned, before decoding
  readonly rawTypedResponse: unknown
  /** RAW distribution BEFORE any calibration transform (I7). */
  readonly rawDistribution: RawDistribution | null
  readonly decoded: DecodedRecord | null
  readonly calibration: AppliedCalibration | null
  readonly finalProposal: FinalProposal

  // outcome + fence
  readonly staleCheck: StaleCheckRecord
  readonly result: { readonly ok: true } | { readonly ok: false; readonly kind: JevFailureKind; readonly detail: string | null }
  readonly confidence: ConfidenceMetadata | null

  // #438 section 9: a synthetic fallback must never look like model output
  readonly fallbackAuthority: 'model' | 'code'
  readonly modelAnswerPresent: boolean

  readonly commitmentContext: DecisionEvidenceRef['commitmentContext']
  readonly stage: string | null

  // hooks filled by later immutable link records (#436 section 19)
  readonly guardDisposition: GuardDisposition | null
  readonly skillOutcome: SkillOutcomeLink | null
}

/** §437 section 12 marker for a late/again-invalid result. */
export interface StaleDropRecord {
  readonly record: 'STALE_JEV_RESULT_DROPPED'
  readonly ts: string
  readonly runId: RunId
  readonly artifactId: ArtifactId
  readonly headId: HeadId
  readonly decisionEpoch: DecisionEpoch
  readonly reason: StaleReason
  readonly detail: string
  readonly mismatches: StaleCheckRecord['mismatches']
}

export interface DecisionLinkRecord {
  readonly record: 'JEV_DECISION_LINK'
  readonly ts: string
  readonly runId: RunId
  readonly artifactId: ArtifactId
  readonly decisionId: DecisionId
  readonly kind: 'guard_disposition' | 'skill_outcome'
  readonly guardDisposition: GuardDisposition | null
  readonly skillOutcome: SkillOutcomeLink | null
}

/** A labelled code-authority fallback. Never presented as a model answer (I6). */
export interface CodeFallbackRecord {
  readonly record: 'JEV_CODE_FALLBACK'
  readonly ts: string
  readonly runId: RunId
  readonly headId: HeadId
  readonly decisionEpoch: DecisionEpoch
  readonly reason: string
  readonly fallbackAuthority: 'code'
  readonly modelAnswerPresent: false
  readonly proposal: FinalProposal
}

export type HarnessRecord = DecisionArtifact | DecisionLinkRecord | StaleDropRecord | CodeFallbackRecord

// ---------------------------------------------------------------------------
// sinks
// ---------------------------------------------------------------------------

/** Append-only sink. Artifacts are never rewritten in place. */
export interface ArtifactSink {
  append(record: HarnessRecord): void
}

export class MemoryArtifactSink implements ArtifactSink {
  private readonly records: HarnessRecord[] = []

  append(record: HarnessRecord): void {
    this.records.push(record)
  }

  all(): readonly HarnessRecord[] {
    return this.records
  }

  artifacts(): readonly DecisionArtifact[] {
    return this.records.filter((record): record is DecisionArtifact => record.record === 'JEV_DECISION')
  }

  staleDrops(): readonly StaleDropRecord[] {
    return this.records.filter((record): record is StaleDropRecord => record.record === 'STALE_JEV_RESULT_DROPPED')
  }

  fallbacks(): readonly CodeFallbackRecord[] {
    return this.records.filter((record): record is CodeFallbackRecord => record.record === 'JEV_CODE_FALLBACK')
  }

  byArtifactId(artifactId: ArtifactId): DecisionArtifact | null {
    return this.records.find((record): record is DecisionArtifact => record.record === 'JEV_DECISION' && record.artifactId === artifactId) ?? null
  }

  /** Replay-corpus serialization: one JSON record per line, in emission order. */
  toJsonl(): string {
    return this.records.map((record) => JSON.stringify(record)).join('\n') + (this.records.length === 0 ? '' : '\n')
  }

  static fromJsonl(text: string): MemoryArtifactSink {
    const sink = new MemoryArtifactSink()
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      sink.append(JSON.parse(trimmed) as HarnessRecord)
    }
    return sink
  }
}

/**
 * File-backed JSONL sink. This is the only platform-coupled module in the
 * harness; it declares the single Bun global it needs so the core stays
 * dependency-free and typecheckable without a runtime import.
 */
declare const Bun: {
  write(path: string, data: string): Promise<number>
  file(path: string): { exists(): Promise<boolean>; text(): Promise<string> }
}

export class BunFileArtifactSink implements ArtifactSink {
  private queue: Promise<void> = Promise.resolve()

  constructor(readonly path: string) {}

  append(record: HarnessRecord): void {
    const line = `${JSON.stringify(record)}\n`
    this.queue = this.queue.then(async () => {
      const existing = (await Bun.file(this.path).exists()) ? await Bun.file(this.path).text() : ''
      await Bun.write(this.path, existing + line)
    })
  }

  async flush(): Promise<void> {
    await this.queue
  }
}

// ---------------------------------------------------------------------------
// construction
// ---------------------------------------------------------------------------

export interface DecisionArtifactInput {
  readonly run: RunIdentity
  readonly createdAt: string
  readonly decisionId?: DecisionId
  readonly identity: CausalIdentity
  readonly headId: HeadId
  readonly headVersion: HeadVersion
  readonly headStatus: HeadStatus | null
  readonly primitive: JevPrimitive | null
  readonly resultSchema: string | null
  readonly projectionId: string
  readonly projectionVersion: number
  readonly projectionHash: string
  readonly projection: unknown
  readonly candidateIds: readonly string[]
  readonly serializedCandidateIds: readonly string[]
  readonly candidateOrdering: CandidateOrderingKind
  readonly candidateOrderSalt: string | null
  readonly candidateSetHash: string
  readonly candidates: readonly GroundedSemanticCandidate[]
  readonly provider: string | null
  readonly model: string | null
  readonly transport: TransportRecord
  readonly cache: DecisionArtifact['cache']
  readonly rawTypedResponse: unknown
  readonly rawDistribution: RawDistribution | null
  readonly decoded: DecodedRecord | null
  readonly calibration: AppliedCalibration | null
  readonly finalProposal: FinalProposal
  readonly staleCheck: StaleCheckRecord
  readonly result: DecisionArtifact['result']
  readonly confidence: ConfidenceMetadata | null
  readonly fallbackAuthority: 'model' | 'code'
  readonly modelAnswerPresent: boolean
  readonly commitmentContext: DecisionEvidenceRef['commitmentContext']
  readonly stage: string | null
  readonly guardDisposition?: GuardDisposition | null
  readonly skillOutcome?: SkillOutcomeLink | null
}

export function decisionArtifactId(input: {
  readonly runId: RunId
  readonly decisionId: DecisionId
  readonly headId: HeadId
  readonly headVersion: HeadVersion
  readonly decisionEpoch: DecisionEpoch
  readonly optionInstanceId: string | null
  readonly projectionHash: string
  readonly candidateSetHash: string
}): ArtifactId {
  return `art_${hashId(
    [
      input.runId,
      input.decisionId,
      input.headId,
      String(input.headVersion),
      String(input.decisionEpoch),
      input.optionInstanceId ?? '<none>',
      input.projectionHash,
      input.candidateSetHash,
    ].join('|'),
    20,
  )}`
}

export function buildDecisionArtifact(input: DecisionArtifactInput): DecisionArtifact {
  assertArtifactConsistency(input)
  const decisionId = input.decisionId ?? `dec_${hashId(`${input.run.runId}|${input.headId}|${input.createdAt}|${Math.random()}`, 20)}`
  const artifactId = decisionArtifactId({
    runId: input.run.runId,
    decisionId,
    headId: input.headId,
    headVersion: input.headVersion,
    decisionEpoch: input.identity.decisionEpoch,
    optionInstanceId: input.identity.optionInstanceId,
    projectionHash: input.projectionHash,
    candidateSetHash: input.candidateSetHash,
  })
  const artifact: DecisionArtifact = {
    record: 'JEV_DECISION',
    schemaVersion: DECISION_ARTIFACT_SCHEMA_VERSION,
    artifactId,
    decisionId,
    createdAt: input.createdAt,
    runId: input.run.runId,
    sourceSha: input.run.sourceSha,
    dirtyTree: input.run.dirtyTree,
    worldKey: input.identity.worldKey,
    worldEpoch: input.identity.worldEpoch,
    generationId: input.identity.generationId,
    decisionEpoch: input.identity.decisionEpoch,
    optionInstanceId: input.identity.optionInstanceId,
    headId: input.headId,
    headVersion: input.headVersion,
    headStatus: input.headStatus,
    primitive: input.primitive,
    resultSchema: input.resultSchema,
    projectionId: input.projectionId,
    projectionVersion: input.projectionVersion,
    projectionVersionKey: `${input.projectionId}@${input.projectionVersion}`,
    projectionHash: input.projectionHash,
    projection: input.projection,
    candidateIds: [...input.candidateIds],
    serializedCandidateIds: [...input.serializedCandidateIds],
    candidateOrdering: input.candidateOrdering,
    candidateOrderSalt: input.candidateOrderSalt,
    candidateSetHash: input.candidateSetHash,
    candidates: [...input.candidates],
    provider: input.provider,
    model: input.model,
    transport: input.transport,
    cache: input.cache,
    rawTypedResponse: input.rawTypedResponse,
    rawDistribution: input.rawDistribution,
    decoded: input.decoded,
    calibration: input.calibration,
    finalProposal: input.finalProposal,
    staleCheck: input.staleCheck,
    result: input.result,
    confidence: input.confidence,
    fallbackAuthority: input.fallbackAuthority,
    modelAnswerPresent: input.modelAnswerPresent,
    commitmentContext: input.commitmentContext,
    stage: input.stage,
    guardDisposition: input.guardDisposition ?? null,
    skillOutcome: input.skillOutcome ?? null,
  }
  return deepFreeze(artifact)
}

/**
 * Executable I6: a synthetic fallback may never be labelled as model output, and
 * a failure may never carry a model answer. This throws instead of degrading.
 */
export function assertArtifactConsistency(input: {
  readonly fallbackAuthority: 'model' | 'code'
  readonly modelAnswerPresent: boolean
  readonly result: DecisionArtifact['result']
  readonly staleCheck: StaleCheckRecord
  readonly rawDistribution: RawDistribution | null
}): void {
  if (input.fallbackAuthority === 'model' && !input.modelAnswerPresent) {
    throw new ArtifactIntegrityError(
      'fallback_authority=model requires model_answer_present=true (#438 section 9): a synthetic fallback must be labelled code',
    )
  }
  if (!input.result.ok && input.modelAnswerPresent) {
    throw new ArtifactIntegrityError(
      `a failed result (${input.result.kind}) cannot claim a model answer present (#438 section 9)`,
    )
  }
  if (input.staleCheck.reason !== null && input.result.ok) {
    throw new ArtifactIntegrityError('a stale decision cannot be recorded as ok (#438 section 7)')
  }
}

export function linkGuardDisposition(
  artifact: DecisionArtifact,
  disposition: GuardDisposition,
  ts: string,
): DecisionLinkRecord {
  if (typeof disposition.candidateId === 'string' && disposition.candidateId !== '' && artifact.finalProposal.kind === 'selected') {
    if (disposition.candidateId !== artifact.finalProposal.candidateId) {
      throw new ArtifactIntegrityError(
        `Guard disposition for ${disposition.candidateId} cannot be linked to a decision that selected ${artifact.finalProposal.candidateId} (#438 section 19)`,
      )
    }
  }
  return deepFreeze({
    record: 'JEV_DECISION_LINK',
    ts,
    runId: artifact.runId,
    artifactId: artifact.artifactId,
    decisionId: artifact.decisionId,
    kind: 'guard_disposition',
    guardDisposition: disposition,
    skillOutcome: null,
  })
}

export function linkSkillOutcome(
  artifact: DecisionArtifact,
  outcome: SkillOutcomeLink,
  ts: string,
): DecisionLinkRecord {
  if (outcome.decisionId !== artifact.decisionId) {
    throw new ArtifactIntegrityError(
      `SkillOutcome decisionId ${outcome.decisionId} does not match artifact decisionId ${artifact.decisionId} (#436 section 4)`,
    )
  }
  if (artifact.finalProposal.kind === 'selected' && outcome.selectedCandidateId !== artifact.finalProposal.candidateId) {
    throw new ArtifactIntegrityError(
      `SkillOutcome candidate ${outcome.selectedCandidateId} cannot close a decision that selected ${artifact.finalProposal.candidateId} (#436 section 16)`,
    )
  }
  return deepFreeze({
    record: 'JEV_DECISION_LINK',
    ts,
    runId: artifact.runId,
    artifactId: artifact.artifactId,
    decisionId: artifact.decisionId,
    kind: 'skill_outcome',
    guardDisposition: null,
    skillOutcome: outcome,
  })
}

export function codeFallbackRecord(input: {
  readonly run: RunIdentity
  readonly ts: string
  readonly headId: HeadId
  readonly decisionEpoch: DecisionEpoch
  readonly reason: string
  readonly proposal: FinalProposal
}): CodeFallbackRecord {
  return deepFreeze({
    record: 'JEV_CODE_FALLBACK',
    ts: input.ts,
    runId: input.run.runId,
    headId: input.headId,
    decisionEpoch: input.decisionEpoch,
    reason: input.reason,
    fallbackAuthority: 'code',
    modelAnswerPresent: false,
    proposal: input.proposal,
  })
}

/** Rebuild the replay corpus from a JSONL artifact stream. */
export function parseHarnessJsonl(text: string): readonly HarnessRecord[] {
  const records: HarnessRecord[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    records.push(JSON.parse(trimmed) as HarnessRecord)
  }
  return records
}

export function distributionOf(artifact: DecisionArtifact): readonly CandidateProbability[] {
  const distribution = artifact.rawDistribution
  if (distribution === null || distribution.kind !== 'choice') return []
  return Object.entries(distribution.probabilities)
    .map(([candidateId, probability]) => ({ candidateId, probability }))
    .sort((a, b) => (a.candidateId < b.candidateId ? -1 : 1))
}
