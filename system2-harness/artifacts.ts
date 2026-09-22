// system2-harness/artifacts.ts - immutable System2 decision artifacts
// (#439 section 24).
//
// SHARED SHAPE (#438/#439): artifacts are one JSONL record stream with a
// `record` discriminator, deterministic ids, deep-frozen plain data, and sibling
// records for stale drops / links / code fallbacks. The artifact itself never
// mutates; later Option/Skill/Jev outcomes append LINK records instead.
//
// Traceability this buys (#439 section 24):
//   System2 proposed enter existing portal
//   -> compiler grounded portal site P17
//   -> OptionInstance O44 created
//   -> Jev selected WALK_TO(P17)
//   -> Skill entered portal
//   -> dimension transition verified
// without reconstructing causality from unrelated log lines.

import { appendFileSync } from 'node:fs'
import { canonicalJson, deepFreeze, hashId } from './canonical.ts'
import type {
  CacheSource,
  CompilerDiagnostics,
  OptionGraphPatch,
  System2ArtifactId,
  System2DecisionId,
  System2FailureKind,
  System2Proposal,
} from './contract.ts'
import type { IdentityMismatch, StaleReason } from './epochs.ts'
import type { ProviderIdentity, SemanticVersions } from './versions.ts'
import type { RawProviderResponse } from './schema.ts'

export const SYSTEM2_DECISION_RECORD = 'SYSTEM2_DECISION'
export const STALE_SYSTEM2_RESULT_DROPPED = 'STALE_SYSTEM2_RESULT_DROPPED'
export const SYSTEM2_DECISION_LINK = 'SYSTEM2_DECISION_LINK'
export const CODE_FALLBACK_RECORD = 'CODE_FALLBACK'

export interface StaleCheckArtifact {
  readonly marker: typeof STALE_SYSTEM2_RESULT_DROPPED
  readonly current: boolean
  readonly reason: StaleReason | null
  readonly mismatches: readonly IdentityMismatch[]
}

export interface System2DecisionArtifactInput {
  readonly runId: string
  readonly sourceSha: string
  readonly dirtyTree?: boolean | null
  readonly system2Epoch: number
  readonly missionId: string
  readonly worldKey: string
  readonly worldEpoch: number
  readonly generationId: string
  readonly baseRevision: number
  readonly activeOptionInstanceId: string | null
  readonly wakeReason: string
  readonly wakeDetail: Readonly<Record<string, unknown>>
  /** `projectionId@version` recording string (#439 section 24). */
  readonly projectionKey: string
  readonly projectionVersion: number
  readonly projectionHash: string
  readonly versions: SemanticVersions
  readonly provider: ProviderIdentity
  readonly attempts: number
  readonly cacheSource: CacheSource
  readonly cacheKey: string
  readonly cacheHit: boolean
  readonly cachedArtifactId: System2ArtifactId | null
  readonly rawResponse: RawProviderResponse | null
  readonly rationaleText: string | null
  readonly rationaleExecutionDirectives: readonly string[]
  readonly normalizedProposal: System2Proposal | null
  readonly compilerDiagnostics: CompilerDiagnostics | null
  readonly acceptedIntentIndexes: readonly number[]
  readonly rejectedIntentIndexes: readonly number[]
  readonly finalPatch: OptionGraphPatch | null
  readonly newRevision: number | null
  readonly staleCheck: StaleCheckArtifact
  readonly resultKind: 'ok' | System2FailureKind
  readonly detail: string | null
  readonly createdAt: string
}

export interface System2DecisionArtifact extends System2DecisionArtifactInput {
  readonly record: typeof SYSTEM2_DECISION_RECORD
  readonly schemaVersion: 1
  readonly artifactId: System2ArtifactId
  readonly decisionId: System2DecisionId
  /** Structurally false on every System2 artifact: the harness never falls back. */
  readonly modelAnswerPresent: boolean
  readonly fallbackAuthority: 'none'
}

export function system2DecisionId(input: {
  readonly runId: string
  readonly system2Epoch: number
  readonly missionId: string
  readonly baseRevision: number
  readonly projectionHash: string
  readonly wakeReason: string
}): System2DecisionId {
  return `dec_${hashId(
    [input.runId, String(input.system2Epoch), input.missionId, String(input.baseRevision), input.projectionHash, input.wakeReason].join('|'),
    20,
  )}`
}

export function system2ArtifactId(input: { readonly runId: string; readonly decisionId: string; readonly sequence: number }): System2ArtifactId {
  return `art_${hashId([input.runId, input.decisionId, String(input.sequence)].join('|'), 20)}`
}

export function buildSystem2DecisionArtifact(
  input: System2DecisionArtifactInput,
  sequence: number,
): System2DecisionArtifact {
  const decisionId = system2DecisionId({
    runId: input.runId,
    system2Epoch: input.system2Epoch,
    missionId: input.missionId,
    baseRevision: input.baseRevision,
    projectionHash: input.projectionHash,
    wakeReason: input.wakeReason,
  })
  const artifactId = system2ArtifactId({ runId: input.runId, decisionId, sequence })
  return deepFreeze({
    ...input,
    record: SYSTEM2_DECISION_RECORD,
    schemaVersion: 1,
    artifactId,
    decisionId,
    modelAnswerPresent: input.resultKind === 'ok',
    fallbackAuthority: 'none',
  })
}

export interface StaleDropRecord {
  readonly record: typeof STALE_SYSTEM2_RESULT_DROPPED
  readonly createdAt: string
  readonly runId: string
  readonly artifactId: System2ArtifactId | null
  readonly system2Epoch: number
  readonly wakeReason: string
  readonly reason: StaleReason
  readonly detail: string
  readonly mismatches: readonly IdentityMismatch[]
}

/** Downstream causal link (#439 sections 14/24). Appended, never mutating. */
export interface System2DecisionLinkRecord {
  readonly record: typeof SYSTEM2_DECISION_LINK
  readonly createdAt: string
  readonly runId: string
  readonly artifactId: System2ArtifactId
  readonly decisionId: System2DecisionId
  readonly optionInstanceId: string
  readonly kind: 'option_committed' | 'jev_selection' | 'skill_outcome' | 'predicate_verified'
  readonly detail: Readonly<Record<string, unknown>>
}

/**
 * #439 section 15: if production still contains a legacy deterministic fallback,
 * it must be recorded explicitly as an architecture exception. Same shape as the
 * Jev harness fallback record so one reader handles both corpora.
 */
export interface CodeFallbackRecord {
  readonly record: typeof CODE_FALLBACK_RECORD
  readonly createdAt: string
  readonly runId: string
  readonly artifactId: System2ArtifactId | null
  readonly system2AnswerPresent: false
  readonly fallbackAuthority: 'legacy_code'
  readonly architectureException: string
  readonly detail: string
  readonly proposal: Readonly<Record<string, unknown>> | null
}

export type System2HarnessRecord =
  | System2DecisionArtifact
  | StaleDropRecord
  | System2DecisionLinkRecord
  | CodeFallbackRecord

export interface System2ArtifactSink {
  append(record: System2HarnessRecord): void
}

export class MemorySystem2ArtifactSink implements System2ArtifactSink {
  private readonly records: System2HarnessRecord[] = []

  append(record: System2HarnessRecord): void {
    this.records.push(deepFreeze(record))
  }

  all(): readonly System2HarnessRecord[] {
    return this.records
  }

  decisions(): readonly System2DecisionArtifact[] {
    return this.records.filter((record): record is System2DecisionArtifact => record.record === SYSTEM2_DECISION_RECORD)
  }

  staleDrops(): readonly StaleDropRecord[] {
    return this.records.filter((record): record is StaleDropRecord => record.record === STALE_SYSTEM2_RESULT_DROPPED)
  }

  links(): readonly System2DecisionLinkRecord[] {
    return this.records.filter((record): record is System2DecisionLinkRecord => record.record === SYSTEM2_DECISION_LINK)
  }

  fallbacks(): readonly CodeFallbackRecord[] {
    return this.records.filter((record): record is CodeFallbackRecord => record.record === CODE_FALLBACK_RECORD)
  }

  byArtifactId(artifactId: string): System2DecisionArtifact | null {
    return this.decisions().find((artifact) => artifact.artifactId === artifactId) ?? null
  }

  byDecisionId(decisionId: string): System2DecisionArtifact | null {
    return this.decisions().find((artifact) => artifact.decisionId === decisionId) ?? null
  }

  toJsonl(): string {
    return this.records.map((record) => canonicalJson(record as unknown as Record<string, unknown>)).join('\n')
  }

  static fromJsonl(text: string): MemorySystem2ArtifactSink {
    const sink = new MemorySystem2ArtifactSink()
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      sink.append(JSON.parse(trimmed) as System2HarnessRecord)
    }
    return sink
  }
}

export class BunFileSystem2ArtifactSink implements System2ArtifactSink {
  constructor(private readonly path: string) {}

  append(record: System2HarnessRecord): void {
    appendFileSync(this.path, `${JSON.stringify(record)}\n`, { encoding: 'utf8' })
  }
}

/**
 * Consistency rules enforced when an artifact is built (#439 sections 15/24).
 * A failed result may never claim a model answer, and a stale artifact may never
 * be recorded as an authoritative success.
 */
export function assertSystem2ArtifactConsistency(artifact: System2DecisionArtifact): void {
  if (artifact.resultKind !== 'ok' && artifact.modelAnswerPresent) {
    throw new Error(`artifact ${artifact.artifactId}: a failed result cannot claim a model answer`)
  }
  if (!artifact.staleCheck.current && artifact.resultKind === 'ok') {
    throw new Error(`artifact ${artifact.artifactId}: a stale result cannot be recorded as ok`)
  }
  if (artifact.resultKind === 'ok' && artifact.finalPatch === null) {
    throw new Error(`artifact ${artifact.artifactId}: an ok result must carry the committed patch`)
  }
  if (artifact.fallbackAuthority !== 'none') {
    throw new Error(`artifact ${artifact.artifactId}: System2 harness fallback authority must be "none"`)
  }
}
