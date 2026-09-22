// system2-harness/harness.ts - the ONE production System2 entrypoint
// (#439 sections 1/6/10/11/15/16/17/24/25).
//
// propose() is the only way production code may ask the long-horizon WHAT
// question. It owns: projection hashing, prompt construction, cache identity,
// transport retry eligibility, strict decode, deterministic compilation,
// grounding, authority scope, epoch fencing, atomic commit, artifact emission.
// A call site never sees a provider SDK, a prompt, or a raw model response.

import { canonicalJson, hashId, projectionHash } from './canonical.ts'
import type {
  CompilerDiagnostics,
  OptionGraphPatch,
  System2FailureKind,
  System2Harness,
  System2HarnessResult,
  System2Proposal,
  System2Request,
} from './contract.ts'
import { system2Failure, system2Ok } from './contract.ts'
import { compilableProposal, compileSystem2Proposal } from './compiler.ts'
import type { CompilerContext } from './compiler.ts'
import type { System2DecisionArtifact, StaleCheckArtifact } from './artifacts.ts'
import {
  STALE_SYSTEM2_RESULT_DROPPED,
  SYSTEM2_DECISION_LINK,
  assertSystem2ArtifactConsistency,
  buildSystem2DecisionArtifact,
  system2ArtifactId,
  system2DecisionId,
} from './artifacts.ts'
import type { System2ArtifactSink } from './artifacts.ts'
import type { CacheLookup, System2ModelVisibleRequest } from './cache.ts'
import { cacheKeyFor, System2ProposalCache } from './cache.ts'
import type { CausalIdentity, LiveSystem2IdentitySource, StaleReason } from './epochs.ts'
import { checkSystem2Currency, describeStale, retryEligibility, toCausalIdentity } from './epochs.ts'
import { buildSystem2Prompt } from './prompt.ts'
import type { System2ProviderAdapter } from './provider.ts'
import { System2ProviderFailure } from './provider.ts'
import type { RawProviderResponse } from './schema.ts'
import { decodeRawProviderResponse, detectExecutionDirectives } from './schema.ts'
import type { System2ProjectionPayload } from './stateProjection.ts'
import type { GroundedWorldIndex } from './grounding.ts'
import type { TruthIndex } from './predicateRegistry.ts'
import { EMPTY_TRUTH_INDEX } from './predicateRegistry.ts'
import type { OptionGraphAuthority, CommitResult } from './optionGraph.ts'
import type { SemanticVersions } from './versions.ts'
import { SEMANTIC_VERSIONS } from './versions.ts'
import { isSystem2WakeReason, wakeHashFromPayload } from './wakeReasons.ts'

export interface System2HarnessOptions {
  readonly provider: System2ProviderAdapter
  readonly authority: OptionGraphAuthority
  readonly identity: LiveSystem2IdentitySource
  readonly artifacts: System2ArtifactSink
  readonly runId: string
  readonly sourceSha: string
  readonly dirtyTree?: boolean | null
  /** Grounded refs the model may reference. Defaults to an empty world index. */
  readonly index: GroundedWorldIndex
  /** Code-owned recipe/item truth used for additive enrichment only. */
  readonly truth?: TruthIndex
  readonly knownDeficits?: readonly string[]
  readonly knownCapabilities?: readonly string[]
  readonly cache?: System2ProposalCache | null
  readonly versions?: SemanticVersions
  readonly timeoutMs?: number
  readonly maxTransportAttempts?: number
  readonly now?: () => string
}

export interface System2HarnessInternal extends System2Harness {
  readonly options: System2HarnessOptions
}

function liveOrThrow(source: LiveSystem2IdentitySource): ReturnType<LiveSystem2IdentitySource['current']> {
  return source.current()
}

/**
 * Re-narrow a projection payload to the System2 schema. `SemanticProjection.payload`
 * is deliberately a generic record so a caller cannot smuggle a class instance
 * across the boundary; the harness owns the projection schema, so this is the one
 * place the narrowing is sanctioned (`buildSystem2Projection` is the only producer).
 */
function payloadOf(request: System2Request): System2ProjectionPayload {
  return request.projection.payload as unknown as System2ProjectionPayload
}

function staleArtifactCheck(reason: StaleReason, mismatches: StaleCheckArtifact['mismatches']): StaleCheckArtifact {
  return { marker: STALE_SYSTEM2_RESULT_DROPPED, current: false, reason, mismatches }
}

function currentArtifactCheck(): StaleCheckArtifact {
  return { marker: STALE_SYSTEM2_RESULT_DROPPED, current: true, reason: null, mismatches: [] }
}

export function createSystem2Harness(options: System2HarnessOptions): System2HarnessInternal {
  const versions = options.versions ?? SEMANTIC_VERSIONS
  const cache = options.cache === null ? null : (options.cache ?? new System2ProposalCache())
  const timeoutMs = options.timeoutMs ?? 30_000
  const maxTransportAttempts = options.maxTransportAttempts ?? 2
  const now = options.now ?? (() => new Date().toISOString())
  let sequence = 0

  const buildVisible = (request: System2Request, projectionHashValue: string): System2ModelVisibleRequest => {
    const causal = toCausalIdentity(request.identity)
    const payload = payloadOf(request)
    const prompt = buildSystem2Prompt({
      projection: payload,
    })
    const protectedIntent = request.protectedIntent ?? null
    return {
      stage: request.stage ?? null,
      promptVersion: versions.prompt,
      versions,
      provider: options.provider.identity,
      identity: causal,
      projection: request.projection,
      projectionHash: projectionHashValue,
      wakeReason: payload.wake.reason,
      wakeDetailHash: wakeHashFromPayload(payload.wake.reason, payload.wake.detail),
      protectedIntentRevision: protectedIntent?.intentRevision ?? null,
      protectedIntentText: protectedIntent?.intentText ?? null,
      prompt,
    }
  }

  const emitDecisionArtifact = (input: {
    readonly request: System2Request
    readonly causal: CausalIdentity
    readonly projectionHashValue: string
    readonly wakeDetail: Readonly<Record<string, unknown>>
    readonly resultKind: 'ok' | System2FailureKind
    readonly detail: string | null
    readonly raw: RawProviderResponse | null
    readonly rationaleText: string | null
    readonly proposal: System2Proposal | null
    readonly diagnostics: CompilerDiagnostics | null
    readonly accepted: readonly number[]
    readonly rejected: readonly number[]
    readonly patch: OptionGraphPatch | null
    readonly newRevision: number | null
    readonly staleCheck: StaleCheckArtifact
    readonly attempts: number
    readonly cacheEvidence: CacheLookup['evidence']
    readonly rationaleDirectives: readonly string[]
  }): System2DecisionArtifact => {
    const artifact = buildSystem2DecisionArtifact(
      {
        runId: options.runId,
        sourceSha: options.sourceSha,
        dirtyTree: options.dirtyTree ?? null,
        system2Epoch: input.causal.system2Epoch,
        missionId: input.causal.missionId,
        worldKey: input.causal.worldKey,
        worldEpoch: input.causal.worldEpoch,
        generationId: input.causal.generationId,
        baseRevision: input.causal.optionGraphRevision,
        activeOptionInstanceId: input.causal.activeOptionInstanceId,
        wakeReason: payloadOf(input.request).wake.reason,
        wakeDetail: input.wakeDetail,
        projectionKey: `${input.request.projection.projectionId}@${input.request.projection.version}`,
        projectionVersion: input.request.projection.version,
        projectionHash: input.projectionHashValue,
        versions,
        provider: options.provider.identity,
        attempts: input.attempts,
        cacheSource: input.cacheEvidence.source,
        cacheKey: input.cacheEvidence.key,
        cacheHit: input.cacheEvidence.hit,
        cachedArtifactId: input.cacheEvidence.originalArtifactId,
        rawResponse: input.raw,
        rationaleText: input.rationaleText,
        rationaleExecutionDirectives: input.rationaleDirectives,
        normalizedProposal: input.proposal,
        compilerDiagnostics: input.diagnostics,
        acceptedIntentIndexes: input.accepted,
        rejectedIntentIndexes: input.rejected,
        finalPatch: input.patch,
        newRevision: input.newRevision,
        staleCheck: input.staleCheck,
        resultKind: input.resultKind,
        detail: input.detail,
        createdAt: now(),
      },
      sequence,
    )
    assertSystem2ArtifactConsistency(artifact)
    options.artifacts.append(artifact)
    return artifact
  }

  const propose = async (request: System2Request): Promise<System2HarnessResult> => {
    sequence += 1
    const causal = toCausalIdentity(request.identity)
    const payload = payloadOf(request)
    const wakeReason = payload.wake.reason
    const projectionHashValue = projectionHash(request.projection)
    const decisionId = system2DecisionId({
      runId: options.runId,
      system2Epoch: causal.system2Epoch,
      missionId: causal.missionId,
      baseRevision: causal.optionGraphRevision,
      projectionHash: projectionHashValue,
      wakeReason,
    })
    const artifactId = system2ArtifactId({ runId: options.runId, decisionId, sequence })
    const wakeDetail = (payload.wake.detail as unknown as { detail?: Readonly<Record<string, unknown>> }).detail ?? {}

    const fail = (
      kind: System2FailureKind,
      detail: string | null,
      diagnostics: CompilerDiagnostics | null,
      extra: {
        readonly raw?: RawProviderResponse | null
        readonly rationaleText?: string | null
        readonly proposal?: System2Proposal | null
        readonly staleCheck?: StaleCheckArtifact
        readonly attempts?: number
        readonly cacheEvidence?: CacheLookup['evidence']
        readonly patch?: OptionGraphPatch | null
        readonly newRevision?: number | null
        readonly accepted?: readonly number[]
        readonly rejected?: readonly number[]
        readonly directives?: readonly string[]
      } = {},
    ): System2HarnessResult => {
      const cacheEvidence = extra.cacheEvidence ?? { hit: false, source: 'provider' as const, key: '', originalArtifactId: null }
      emitDecisionArtifact({
        request,
        causal,
        projectionHashValue,
        wakeDetail,
        resultKind: kind,
        detail,
        raw: extra.raw ?? null,
        rationaleText: extra.rationaleText ?? null,
        proposal: extra.proposal ?? null,
        diagnostics,
        accepted: extra.accepted ?? [],
        rejected: extra.rejected ?? [],
        patch: extra.patch ?? null,
        newRevision: extra.newRevision ?? null,
        staleCheck: extra.staleCheck ?? currentArtifactCheck(),
        attempts: extra.attempts ?? 0,
        cacheEvidence,
        rationaleDirectives: extra.directives ?? [],
      })
      return system2Failure(kind, detail, diagnostics, artifactId)
    }

    // --- request validation (S3, S4) ---------------------------------------
    if (request.projection.version !== versions.stateProjection) {
      return fail(
        'invalid_request',
        `request projection version ${request.projection.version} does not match harness stateProjection version ${versions.stateProjection}`,
        null,
      )
    }
    if (!isSystem2WakeReason(wakeReason)) {
      return fail('invalid_request', `wake reason "${String(wakeReason)}" is not a registered System2 wake reason`, null)
    }
    if (request.identity.optionGraphRevision !== options.authority.snapshot().revision) {
      // The request itself is already stale: refuse before spending a model call.
      return fail(
        'stale',
        `request binds optionGraphRevision=${request.identity.optionGraphRevision} but the live graph revision is ${options.authority.snapshot().revision}`,
        null,
        {
          staleCheck: staleArtifactCheck('option_graph_revision_changed', [
            {
              field: 'option_graph_revision_changed',
              expected: request.identity.optionGraphRevision,
              observed: options.authority.snapshot().revision,
            },
          ]),
        },
      )
    }

    // --- model-visible request + cache identity ----------------------------
    const visible = buildVisible(request, projectionHashValue)
    const cacheKey = cacheKeyFor(visible)
    // A replayed answer must stay distinguishable from a live provider answer in
    // the artifact (#439 sections 23/24): the transport is evidence.
    const providerSource: 'provider' | 'replay' = options.provider.kind === 'replay' ? 'replay' : 'provider'
    const cacheEvidence: CacheLookup['evidence'] = {
      hit: false,
      source: providerSource,
      key: cacheKey,
      originalArtifactId: null,
    }
    let raw: RawProviderResponse | null = null
    let attempts = 0
    let cacheHitEvidence: CacheLookup['evidence'] = cacheEvidence
    let fetchedFromProvider = false

    /**
     * Cache population. The key covers the whole model-visible request, so an
     * entry can only ever be replayed for the identical semantic question, and a
     * cached answer still passes the current stale/compile/grounding/commit
     * validation before it can change anything (#439 section 17).
     */
    const remember = (proposal: System2Proposal | null): void => {
      if (cache === null || raw === null) return
      cache.store({ key: cacheKey, artifactId, provider: options.provider.identity, raw, proposal })
    }

    const lookup = cache === null ? null : cache.lookup(cacheKey)
    if (lookup !== null && lookup.hit && lookup.entry !== null) {
      raw = lookup.entry.raw
      cacheHitEvidence = lookup.evidence
    } else {
      let lastFailure: System2ProviderFailure | null = null
      while (attempts < maxTransportAttempts) {
        attempts += 1
        try {
          const response = await options.provider.dispatch({
            requestId: `${options.runId}:${decisionId}:${attempts}`,
            cacheKey,
            projectionHash: projectionHashValue,
            projectionVersion: request.projection.version,
            wakeReason,
            wakeDetailHash: visible.wakeDetailHash,
            system2Epoch: causal.system2Epoch,
            prompt: visible.prompt,
            modelVisible: visible,
            timeoutMs,
            attempt: attempts - 1,
          })
          raw = response.raw
          lastFailure = null
          fetchedFromProvider = true
          break
        } catch (error) {
          const failure = error instanceof System2ProviderFailure ? error : null
          if (failure === null) throw error
          lastFailure = failure
          if (!failure.retryable) break
          // A retry repeats the IDENTICAL request and only while it is current
          // (#439 section 16). Nothing here inspects the (absent) answer.
          const eligibility = retryEligibility(causal, projectionHashValue, liveOrThrow(options.identity))
          if (!eligibility.eligible) {
            return fail('stale', `transport retry refused: ${eligibility.reason}`, null, {
              attempts,
              cacheEvidence: cacheHitEvidence,
              staleCheck: staleArtifactCheck(eligibility.staleReason === 'projection_changed' ? 'world_epoch_changed' : eligibility.staleReason, []),
            })
          }
        }
      }
      if (raw === null) {
        const failure = lastFailure
        const kind: System2FailureKind =
          failure?.kind === 'timeout' ? 'timeout' : failure?.kind === 'aborted' ? 'aborted' : 'provider_unavailable'
        // No ladder, no RUNGS, no cached deterministic plan: a typed failure only.
        return fail(kind, failure?.message ?? 'provider produced no response', null, {
          attempts,
          cacheEvidence: cacheHitEvidence,
        })
      }
    }

    // Retain exactly what the model said for exactly this request, before any
    // post-answer fence can discard it: a later identical request must be able to
    // replay it (and will be re-validated from scratch).
    if (fetchedFromProvider) remember(null)

    // --- stale fence AFTER the model answered (#439 section 10) ------------
    const live = liveOrThrow(options.identity)
    const currency = checkSystem2Currency(causal, live)
    if (!currency.current) {
      options.artifacts.append({
        record: STALE_SYSTEM2_RESULT_DROPPED,
        createdAt: now(),
        runId: options.runId,
        artifactId,
        system2Epoch: causal.system2Epoch,
        wakeReason,
        reason: currency.reason,
        detail: describeStale(currency),
        mismatches: currency.mismatches,
      })
      return fail('stale', `SYSTEM2_RESULT_STALE ${describeStale(currency)}`, null, {
        attempts,
        raw,
        cacheEvidence: cacheHitEvidence,
        staleCheck: staleArtifactCheck(currency.reason, currency.mismatches),
      })
    }

    // --- strict decode (S7/S8 fail closed) --------------------------------
    const decoded = decodeRawProviderResponse(raw)
    if (!decoded.ok) {
      return fail('invalid_response', decoded.detail, null, {
        attempts,
        raw,
        cacheEvidence: cacheHitEvidence,
        directives: detectExecutionDirectives(raw.text ?? ''),
      })
    }
    const proposal = decoded.proposal
    const rationaleText = decoded.rationaleText
    // Record the decoded proposal alongside the raw answer, so a cache hit is
    // attributable to a specific model decision (#439 section 17).
    if (fetchedFromProvider) remember(proposal)
    const directives = rationaleText === null ? [] : detectExecutionDirectives(rationaleText)

    // --- deterministic compile (whole patch or nothing) -------------------
    const compilerContext: CompilerContext = {
      identity: request.identity,
      graph: options.authority.snapshot(),
      index: options.index,
      truth: options.truth ?? EMPTY_TRUTH_INDEX,
      knownDeficits: options.knownDeficits,
      knownCapabilities: options.knownCapabilities,
      protectedIntent: request.protectedIntent ?? null,
      decisionId,
      artifactId,
    }
    const outcome = compileSystem2Proposal(proposal, compilerContext)
    if (outcome.status === 'rejected') {
      const kind: System2FailureKind =
        outcome.kind === 'unknown_grounded_ref' || outcome.kind === 'target_ambiguous' || outcome.kind === 'portal_not_verified'
          ? 'ungroundable_intent'
          : 'compile_rejected'
      return fail(kind, `compile rejected: ${outcome.kind}`, outcome.diagnostics, {
        attempts,
        raw,
        rationaleText,
        proposal,
        cacheEvidence: cacheHitEvidence,
        rejected: outcome.rejectedIntentIndexes,
        directives,
      })
    }

    // --- atomic commit (S13/S14) ------------------------------------------
    const commit: CommitResult = options.authority.commit(outcome.patch)
    if (commit.status === 'stale') {
      options.artifacts.append({
        record: STALE_SYSTEM2_RESULT_DROPPED,
        createdAt: now(),
        runId: options.runId,
        artifactId,
        system2Epoch: causal.system2Epoch,
        wakeReason,
        reason: 'option_graph_revision_changed',
        detail: `commit refused: graph moved to revision ${commit.currentRevision}`,
        mismatches: [
          {
            field: 'option_graph_revision_changed',
            expected: outcome.patch.baseRevision,
            observed: commit.currentRevision,
          },
        ],
      })
      return fail('stale', `commit refused: graph moved to revision ${commit.currentRevision}`, outcome.diagnostics, {
        attempts,
        raw,
        rationaleText,
        proposal,
        cacheEvidence: cacheHitEvidence,
        accepted: outcome.acceptedIntentIndexes,
        rejected: [],
        patch: outcome.patch,
        staleCheck: staleArtifactCheck('option_graph_revision_changed', [
          { field: 'option_graph_revision_changed', expected: outcome.patch.baseRevision, observed: commit.currentRevision },
        ]),
        directives,
      })
    }
    if (commit.status === 'refused') {
      return fail('compile_rejected', `commit refused: ${commit.reason}`, outcome.diagnostics, {
        attempts,
        raw,
        rationaleText,
        proposal,
        cacheEvidence: cacheHitEvidence,
        patch: outcome.patch,
        directives,
      })
    }

    for (const entry of outcome.patch.entries) {
      if (entry.op !== 'add' && entry.op !== 'replace' && entry.op !== 'resume') continue
      const option = entry.option
      if (option === undefined) continue
      options.artifacts.append({
        record: SYSTEM2_DECISION_LINK,
        createdAt: now(),
        runId: options.runId,
        artifactId,
        decisionId,
        optionInstanceId: option.optionInstanceId,
        kind: 'option_committed',
        detail: { optionId: option.optionId, originKind: option.origin.kind, revision: commit.toRevision },
      })
    }

    emitDecisionArtifact({
      request,
      causal,
      projectionHashValue,
      wakeDetail,
      resultKind: 'ok',
      detail: null,
      raw,
      rationaleText,
      proposal,
      diagnostics: outcome.diagnostics,
      accepted: outcome.acceptedIntentIndexes,
      rejected: [],
      patch: outcome.patch,
      newRevision: commit.toRevision,
      staleCheck: currentArtifactCheck(),
      attempts,
      cacheEvidence: cacheHitEvidence,
      rationaleDirectives: directives,
    })
    return system2Ok(
      compilableProposal(proposal, outcome, projectionHashValue, cacheHitEvidence),
      { status: 'committed', fromRevision: commit.fromRevision, toRevision: commit.toRevision },
      artifactId,
    )
  }

  return { propose, options }
}

/** Deterministic id helper reused by call sites that need to reference a request. */
export function system2RequestId(runId: string, projectionHashValue: string, wakeReason: string): string {
  return `req_${hashId(`${runId}|${projectionHashValue}|${wakeReason}`, 16)}`
}

/** Canonical rendering of the model-visible request, for evidence/debugging. */
export function renderModelVisibleRequest(visible: System2ModelVisibleRequest): string {
  return canonicalJson(visible as unknown as Record<string, unknown>)
}
