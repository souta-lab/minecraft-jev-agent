// system2-harness/contract.ts - the repo-owned System2 semantic contract
// (#439 sections 1/2/3/4/10/11/12/14/15/26).
//
// This module is the ONLY vocabulary production code is allowed to use when it
// asks the long-horizon question "what should hold next?". It deliberately
// contains no provider concept (no Mercury, no Muse, no generateText, no gateway
// response shape) and no benchmark strategy enum (no descend_to_y16, no
// branch_mine, no rung order).
//
// Authority reminder (#11 / #221 / buddy-driver/AGENTS.md section 2):
//   Code     = CAN / TRUE / SAFE / DONE
//   Jev pi   = WHICH grounded local Skill/target
//   Jev beta = WHETHER the active Option should end
//   System2  = WHAT semantic intent/Option comes next
//   Skill    = HOW
//   HOST     = lifecycle / durable semantic authority / evidence
//
// Nothing in this file authorizes execution. A model answer is a *proposal*
// that must cross the compiler, grounding, scope, epoch and commit fences below.

import type { Epistemic } from './epistemic.ts'

// ---------------------------------------------------------------------------
// identity vocabulary (#439 section 10)
// ---------------------------------------------------------------------------

/** Monotonic semantic epoch. A newer epoch subsumes every older decision. */
export type System2Epoch = number
export type MissionId = string
export type OptionGraphRevision = number
export type OptionInstanceId = string
export type System2ArtifactId = string
export type System2DecisionId = string
export type RunId = string
export type ProjectionId = string
export type ProjectionVersion = number
/** Revision of the human-owned WHAT. Higher authority than any System2 epoch. */
export type HumanIntentRevision = number

// ---------------------------------------------------------------------------
// generic predicate / intent vocabulary (#439 section 4)
// ---------------------------------------------------------------------------

/**
 * Generic semantic primitives, NOT benchmark strategy names. New Minecraft
 * capabilities extend the *registry*; new benchmark milestones must not require
 * new System2 strategy names.
 */
export const PREDICATE_KINDS = [
  'acquire',
  'ensure',
  'reach',
  'find',
  'establish',
  'interact',
  'preserve',
  'recover',
] as const

export type PredicateKind = (typeof PREDICATE_KINDS)[number]

/** Code-owned, stable reference to a deterministic world-memory fact (#439 section 5). */
export const GROUNDED_REF_KINDS = [
  'portal_site',
  'station',
  'ore_cluster',
  'entity',
  'position',
  'region',
  'option',
] as const

export type GroundedRefKind = (typeof GROUNDED_REF_KINDS)[number]

/**
 * A reference the model may use authoritatively ONLY because deterministic code
 * already exposed it (#439 section 5/27). The id is opaque here; grounding.ts
 * resolves it against the live index and fails closed otherwise.
 */
export interface GroundedRef {
  readonly kind: 'grounded'
  readonly refKind: GroundedRefKind
  readonly refId: string
}

/**
 * A goal whose target is not currently grounded. It never carries a coordinate:
 * code owns the search, and the target stays symbolic until search grounds it.
 */
export interface SymbolicRef {
  readonly kind: 'symbolic'
  readonly description: string
}

export type PredicateArgScalar = string | number | boolean | null
export type PredicateArgValue = PredicateArgScalar | GroundedRef | SymbolicRef
export type PredicateArgs = Readonly<Record<string, PredicateArgValue>>

/**
 * Draft layer: `kind` is a plain string so a strict decoder can report an
 * unsupported kind as a typed diagnostic instead of a thrown type error
 * (#439 section 13). Only `PredicateSpec` (compiled) is narrowed to
 * `PredicateKind`.
 */
export interface PredicateDraft {
  readonly kind: string
  readonly args: PredicateArgs
}

export type CompletionSemantics = 'all' | 'any'

/** #439 section 3 verbatim. `rationale` is diagnostic only; never authority. */
export interface IntentDraft {
  readonly intentText: string
  readonly desiredPredicates: readonly PredicateDraft[]
  readonly dependencies?: readonly PredicateDraft[]
  readonly targetRef?: GroundedRef | SymbolicRef
  readonly completionSemantics: CompletionSemantics
}

export type System2Operation = 'replace' | 'append' | 'suspend' | 'resume' | 'repair'

/** #439 section 3 verbatim. */
export interface System2Proposal {
  readonly operation: System2Operation
  /** Free-form natural language. Evidence/diagnostic only; see S6. */
  readonly rationale?: string
  readonly intents: readonly IntentDraft[]
}

// ---------------------------------------------------------------------------
// grounding output: how a target was bound (#439 sections 5/27/28)
// ---------------------------------------------------------------------------

/**
 * Target binding. `choice` is the ONLY representation of "several grounded
 * candidates match and the model did not choose": selection authority is named
 * (`jev_pi`) and the full candidate list is exposed. Hidden nearest-site
 * preference is inexpressible here.
 */
export type TargetBinding =
  | {
      readonly kind: 'grounded'
      readonly ref: GroundedRef
      readonly facts: Readonly<Record<string, PredicateArgScalar>>
    }
  | { readonly kind: 'symbolic'; readonly ref: SymbolicRef; readonly searchPredicate: PredicateSpec | null }
  | {
      readonly kind: 'choice'
      readonly candidates: readonly GroundedRef[]
      readonly selectionAuthority: 'jev_pi'
    }

// ---------------------------------------------------------------------------
// compiler output (#439 sections 6/11/13)
// ---------------------------------------------------------------------------

export type EnrichmentSource =
  | 'truth_fact:recipe_requires_station'
  | 'truth_fact:recipe_components'
  | 'truth_fact:portal_entry_requires_verified_portal'

export interface EnrichmentDiagnostic {
  readonly source: EnrichmentSource
  readonly factId: string
  readonly intentIndex: number
  /** `validated` = the truth fact was checked but no predicate was added. */
  readonly effect: 'added_dependency' | 'validated'
  /** The predicate that was ADDED. Enrichment may never remove or replace. */
  readonly addedPredicate: PredicateSpec | null
  readonly detail: string
}

export interface PredicateSpec {
  readonly kind: PredicateKind
  /** Validated against the registry. Contains no raw coordinates (S8). */
  readonly args: PredicateArgs
  /** Draft index this predicate came from (`-1` for compiler-added truth facts). */
  readonly sourceDraftIndex: number
  /** True when every ref/argument is grounded in deterministic facts. */
  readonly grounded: boolean
  /** Truth facts added by the compiler while compiling this predicate. */
  readonly enrichedBy: readonly string[]
}

/** #439 section 14: one committed Option links to exactly one authority origin. */
export type OptionOrigin =
  | {
      readonly kind: 'system2'
      readonly artifactId: System2ArtifactId
      readonly decisionId: System2DecisionId
      readonly system2Epoch: System2Epoch
      readonly baseRevision: OptionGraphRevision
      readonly intentIndex: number
    }
  | { readonly kind: 'human'; readonly intentRevision: HumanIntentRevision; readonly intentText: string }
  | {
      readonly kind: 'deterministic'
      /** #439 section 15 exception marker: never silent. */
      readonly architectureException: string
      readonly reason: string
    }

export interface CompiledOption {
  /** Stable semantic id, derived from intent semantics (not from run order). */
  readonly optionId: string
  readonly optionInstanceId: OptionInstanceId
  readonly intentText: string
  readonly desiredPredicates: readonly PredicateSpec[]
  readonly dependencies: readonly PredicateSpec[]
  readonly target: TargetBinding | null
  readonly completionSemantics: CompletionSemantics
  readonly origin: OptionOrigin
  /** Bounded horizon accounting (#439 section 26). */
  readonly horizon: { readonly intentIndex: number; readonly dependencyDepth: number }
}

export interface OptionGraphPatchEntryBase {
  readonly targetOptionId: string
}
export type OptionGraphPatchEntry =
  | { readonly op: 'add'; readonly option: CompiledOption }
  | { readonly op: 'replace'; readonly targetOptionId: string; readonly option: CompiledOption }
  | { readonly op: 'suspend'; readonly targetOptionId: string }
  | { readonly op: 'resume'; readonly targetOptionId: string; readonly option?: CompiledOption }

export type CompileStage =
  | 'schema_decode'
  | 'normalize'
  | 'compile_intent'
  | 'predicate_kinds'
  | 'grounding'
  | 'dependency_graph'
  | 'authority_scope'
  | 'semantic_epoch'
  | 'patch'

export type CompileRejectKind =
  | 'unknown_operation'
  | 'empty_intents'
  | 'too_many_intents'
  | 'prose_only_intent'
  | 'unsupported_predicate_kind'
  | 'invalid_predicate_arguments'
  | 'unsupported_item'
  | 'unknown_grounded_ref'
  | 'grounded_ref_known_absent'
  | 'target_ambiguous'
  | 'portal_not_verified'
  | 'contradictory_dependency'
  | 'dependency_cycle'
  | 'dependency_depth_exceeded'
  | 'dependency_unsatisfiable'
  | 'horizon_exceeded'
  | 'protected_intent_violation'
  | 'operation_target_missing'
  | 'partial_acceptance_unsupported'
  | 'semantic_epoch_mismatch'
  | 'compiler_internal_invariant'
  | 'serialized_size_exceeded'

export interface IntentDiagnostic {
  readonly intentIndex: number
  readonly stage: CompileStage
  readonly kind: CompileRejectKind
  readonly detail: string
  /** Typed evidence returned toward System2 / the replay artifact. Never a plan. */
  readonly evidence: Readonly<Record<string, PredicateArgScalar | readonly string[]>>
}

export interface CompilerDiagnostics {
  readonly stages: readonly CompileStage[]
  readonly intentDiagnostics: readonly IntentDiagnostic[]
  readonly enrichments: readonly EnrichmentDiagnostic[]
  /** Explicit: silent partial acceptance is not a supported mode (#439 section 11). */
  readonly partialAcceptance: 'unsupported'
  readonly horizon: {
    readonly intentCount: number
    readonly maxDependencyDepth: number
    readonly serializedBytes: number
  }
}

export interface OptionGraphPatch {
  readonly baseRevision: OptionGraphRevision
  readonly operation: System2Operation
  readonly entries: readonly OptionGraphPatchEntry[]
  readonly artifactId: System2ArtifactId
  readonly decisionId: System2DecisionId
  readonly diagnostics: CompilerDiagnostics
}

export type CompileOutcome =
  | {
      readonly status: 'accepted'
      readonly patch: OptionGraphPatch
      readonly acceptedIntentIndexes: readonly number[]
      readonly rejectedIntentIndexes: readonly number[]
      readonly diagnostics: CompilerDiagnostics
    }
  | {
      readonly status: 'rejected'
      readonly kind: CompileRejectKind
      readonly rejectedIntentIndexes: readonly number[]
      readonly diagnostics: CompilerDiagnostics
    }

// ---------------------------------------------------------------------------
// authoritative OptionGraph (#439 sections 11/12/14)
// ---------------------------------------------------------------------------

export type OptionStatus = 'active' | 'suspended' | 'completed'

export interface OptionGraphOption {
  readonly option: CompiledOption
  readonly status: OptionStatus
}

/**
 * The authoritative semantic graph. The execution/compatibility queue is
 * DERIVED from this (`deriveExecutionQueue`) and is never the authority
 * (#439 section 12).
 */
export interface OptionGraph {
  readonly revision: OptionGraphRevision
  readonly options: readonly OptionGraphOption[]
  /** Artifact that produced this revision, or null for the seeded graph. */
  readonly committedArtifactId: System2ArtifactId | null
}

// ---------------------------------------------------------------------------
// semantic projection (#439 section 8)
// ---------------------------------------------------------------------------

/**
 * A versioned projection envelope. The payload parameter defaults to `unknown`
 * (not `Record<string, unknown>`) so the projection `buildSystem2Projection`
 * returns is actually assignable to a request; "plain data" is a RUNTIME fence
 * (`canonicalJson`/`assertPlainData` reject class instances, functions, NaN and
 * the rest), not a type-level one.
 */
export interface SemanticProjection<P = unknown> {
  readonly projectionId: ProjectionId
  readonly version: ProjectionVersion
  readonly payload: P
}

// ---------------------------------------------------------------------------
// request identity + request (#439 sections 10/16)
// ---------------------------------------------------------------------------

/**
 * Causal identity a request binds to. The harness re-verifies every field
 * against the live identity source before it accepts a model answer, and again
 * (compare-and-swap) at commit time.
 */
export interface System2RequestIdentity {
  readonly system2Epoch: System2Epoch
  readonly missionId: MissionId
  readonly optionGraphRevision: OptionGraphRevision
  readonly activeOptionInstanceId: OptionInstanceId | null
  readonly worldKey: string
  readonly worldEpoch: number
  readonly generationId: string
  readonly humanIntentRevision: HumanIntentRevision
}

export interface ProtectedIntent {
  readonly intentRevision: HumanIntentRevision
  readonly intentText: string
  /** When true, System2 may expand/repair underneath it but never replace it. */
  readonly expandable: boolean
}

export interface System2Request {
  readonly identity: System2RequestIdentity
  readonly projection: SemanticProjection
  readonly protectedIntent?: ProtectedIntent | null
  readonly stage?: string
}

// ---------------------------------------------------------------------------
// result algebra (#439 section 15)
// ---------------------------------------------------------------------------

export type System2FailureKind =
  | 'provider_unavailable'
  | 'timeout'
  | 'invalid_response'
  | 'ungroundable_intent'
  | 'compile_rejected'
  | 'stale'
  | 'invalid_request'
  | 'aborted'

export type CacheSource = 'provider' | 'cache' | 'replay'

export interface System2CacheEvidence {
  readonly hit: boolean
  readonly source: CacheSource
  readonly key: string
  readonly originalArtifactId: System2ArtifactId | null
}

export interface CompilableSystem2Proposal {
  readonly proposal: System2Proposal
  readonly projectionHash: string
  readonly patch: OptionGraphPatch | null
  readonly acceptedIntentIndexes: readonly number[]
  readonly rejectedIntentIndexes: readonly number[]
  readonly diagnostics: CompilerDiagnostics
  readonly cache: System2CacheEvidence
}

/**
 * Typed failure. Structurally carries `modelAnswerPresent: false` and
 * `fallbackAuthority: 'none'`: the harness has no code path that invents WHAT
 * after a model failure (#439 section 15). A legacy production fallback, when it
 * still exists elsewhere, must be recorded as a separate `CODE_FALLBACK`
 * artifact record with `architectureException` (#439 section 15 / Phase F).
 */
export interface System2Failure {
  readonly ok: false
  readonly kind: System2FailureKind
  readonly detail: string | null
  readonly modelAnswerPresent: false
  readonly fallbackAuthority: 'none'
  /** Present when the failure was a compile/grounding rejection. */
  readonly diagnostics: CompilerDiagnostics | null
  readonly artifactId: System2ArtifactId | null
}

export interface System2Ok {
  readonly ok: true
  readonly proposal: CompilableSystem2Proposal
  readonly commit: System2CommitResult
  readonly artifactId: System2ArtifactId
}

export type System2HarnessResult = System2Ok | System2Failure

export type System2CommitResult =
  | { readonly status: 'committed'; readonly fromRevision: OptionGraphRevision; readonly toRevision: OptionGraphRevision }
  | { readonly status: 'not_committed'; readonly reason: 'stale' | 'rejected' | 'no_patch' }

export function system2Ok(
  proposal: CompilableSystem2Proposal,
  commit: System2CommitResult,
  artifactId: System2ArtifactId,
): System2Ok {
  return { ok: true, proposal, commit, artifactId }
}

export function system2Failure(
  kind: System2FailureKind,
  detail: string | null,
  diagnostics: CompilerDiagnostics | null,
  artifactId: System2ArtifactId | null,
): System2Failure {
  return {
    ok: false,
    kind,
    detail,
    modelAnswerPresent: false,
    fallbackAuthority: 'none',
    diagnostics,
    artifactId,
  }
}

/** Explicit accessor: returns null on failure, never a default answer. */
export function unwrapProposalOrNull(result: System2HarnessResult): CompilableSystem2Proposal | null {
  return result.ok ? result.proposal : null
}

// ---------------------------------------------------------------------------
// harness interface (#439 section 1)
// ---------------------------------------------------------------------------

export interface System2Harness {
  propose(request: System2Request): Promise<System2HarnessResult>
}
