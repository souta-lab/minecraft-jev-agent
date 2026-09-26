// system2-harness/index.ts - the ONLY import surface production code may use.
//
// #439 section 1: exactly one production abstraction can invoke the long-horizon
// LLM, and it is `System2Harness.propose`. #439 S1/S2 forbid a call site from
// importing the provider SDK, building its own prompt, parsing model output,
// caching an answer, or reaching into the compiler. Those modules are not
// re-exported here on purpose: the barrel below is the sealed surface.
//
// Production imports repo-owned TYPES and the harness factory only:
//
//   import { createSystem2Harness } from 'system2-harness'
//   import type { System2Request, System2HarnessResult } from 'system2-harness'
//
// Provider wiring is a configuration concern: `createAiGatewayProvider` /
// `ReplayProviderAdapter` are exported for the composition root (the resident
// host / generation entry), never for a planner, controller or executor.

// --- contract: repo-owned request/result/proposal/patch types ---------------
export type {
  CacheSource,
  CompilableSystem2Proposal,
  CompiledOption,
  CompileOutcome,
  CompilerDiagnostics,
  CompileRejectKind,
  CompileStage,
  CompletionSemantics,
  EnrichmentDiagnostic,
  GroundedRef,
  GroundedRefKind,
  HumanIntentRevision,
  IntentDiagnostic,
  IntentDraft,
  MissionId,
  OptionGraph,
  OptionGraphOption,
  OptionGraphPatch,
  OptionOrigin,
  OptionStatus,
  PredicateArgs,
  PredicateArgValue,
  PredicateDraft,
  PredicateKind,
  PredicateSpec,
  ProjectionId,
  ProjectionVersion,
  ProtectedIntent,
  SemanticProjection,
  SymbolicRef,
  System2ArtifactId,
  System2CacheEvidence,
  System2CommitResult,
  System2DecisionId,
  System2Epoch,
  System2Failure,
  System2FailureKind,
  System2Harness,
  System2HarnessResult,
  System2Ok,
  System2Operation,
  System2Proposal,
  System2Request,
  System2RequestIdentity,
  TargetBinding,
} from './contract.ts'
export {
  GROUNDED_REF_KINDS,
  PREDICATE_KINDS,
  system2Failure,
  system2Ok,
  unwrapProposalOrNull,
} from './contract.ts'

// --- epistemic facts: unknown != false, absence != proof --------------------
export type { Epistemic } from './epistemic.ts'
export {
  NOT_OBSERVED,
  UNKNOWN,
  UnknownFactError,
  describeEpistemic,
  epistemicToJson,
  isKnown,
  known,
  notObserved,
  requireKnown,
  sensorError,
} from './epistemic.ts'

// --- deterministic serialization + hashing (shared shape with #438) ---------
export {
  NonCanonicalValueError,
  assertPlainData,
  canonicalJson,
  deepFreeze,
  epistemicEntry,
  hashId,
  projectionHash,
  projectionVersionKey,
  sha256Hex,
  stableSeed,
} from './canonical.ts'

// --- independent versioning + explicit invalidation ------------------------
export type { ProviderIdentity, SemanticVersions } from './versions.ts'
export {
  COMPILER_VERSION,
  HARNESS_VERSION,
  PREDICATE_REGISTRY_VERSION,
  PROMPT_VERSION,
  PROPOSAL_SCHEMA_VERSION,
  SEMANTIC_VERSIONS,
  STATE_PROJECTION_VERSION,
  providerIdentityKey,
  replayInvalidationReason,
  semanticContractKey,
  semanticContractMismatches,
} from './versions.ts'

// --- typed wake taxonomy + wake gating ------------------------------------
export type {
  LocalEventState,
  SemanticWakeEvent,
  System2Wake,
  System2WakeReason,
  TypedWakeDetail,
  WakeDecision,
} from './wakeReasons.ts'
export { SYSTEM2_WAKE_REASONS, WAKE_POLICY, evaluateWakePolicy, isSystem2WakeReason, wakeFromEvent, wakeHash } from './wakeReasons.ts'

// --- versioned semantic projection ----------------------------------------
export type {
  CapabilitySummary,
  GroundedFact,
  MissionProjection,
  OptionProjectionSummary,
  PredicateSummary,
  ProgressSummary,
  ResourceSummary,
  SemanticOutcomeSummary,
  System2ProjectionInput,
  System2ProjectionPayload,
  TypedFailureSummary,
  UnknownFact,
} from './stateProjection.ts'
export {
  PROJECTION_LIMITS,
  SYSTEM2_PROJECTION_ID,
  SYSTEM2_PROJECTION_VERSION,
  assertProjectionHasNoBenchmarkOrder,
  buildSystem2Projection,
} from './stateProjection.ts'

// --- grounding: code owns truth; the model may only reference exposed ids ---
export type { CandidateExposure, GroundedWorldIndex, RefResolution } from './grounding.ts'
export { emptyWorldIndex, exposeCandidates, refsOfKind, resolveGroundedRef, verifiedRefsOfKind } from './grounding.ts'

// --- generic predicate/capability vocabulary + code-owned truth ------------
export type { ItemTruth, PredicateDefinition, TruthIndex } from './predicateRegistry.ts'
export {
  EMPTY_TRUTH_INDEX,
  FIND_DOMAINS,
  INTERACT_OPERATIONS,
  PREDICATE_REGISTRY,
  STATION_KINDS,
  createTruthIndex,
  predicateSemanticKey,
  validatePredicateDraft,
} from './predicateRegistry.ts'

// --- semantic epoch / stale fence -----------------------------------------
export type {
  CausalIdentity,
  CurrencyCheck,
  IdentityMismatch,
  LiveSystem2IdentitySource,
  StaleReason,
  System2LiveIdentity,
} from './epochs.ts'
export {
  SYSTEM2_RESULT_STALE,
  StaticSystem2IdentitySource,
  checkSystem2Currency,
  sameCausalIdentity,
  staticSystem2IdentitySource,
  toCausalIdentity,
} from './epochs.ts'

// --- authoritative OptionGraph + atomic HOST commit -----------------------
export type { CommitResult, ExecutionQueueRow, OptionGraphAuthority } from './optionGraph.ts'
export {
  InMemoryOptionGraphAuthority,
  applyOptionGraphPatch,
  deriveExecutionQueue,
  emptyOptionGraph,
  originsOf,
  restoreOptionGraph,
  serializeOptionGraph,
} from './optionGraph.ts'

// --- immutable decision artifacts (+ sibling records) ---------------------
export type {
  CodeFallbackRecord,
  StaleDropRecord,
  System2ArtifactSink,
  System2DecisionArtifact,
  System2DecisionLinkRecord,
  System2HarnessRecord,
} from './artifacts.ts'
export {
  CODE_FALLBACK_RECORD,
  MemorySystem2ArtifactSink,
  STALE_SYSTEM2_RESULT_DROPPED,
  SYSTEM2_DECISION_LINK,
  SYSTEM2_DECISION_RECORD,
} from './artifacts.ts'

// --- transport seam + the harness factory ---------------------------------
export type {
  ProviderUsage,
  ScriptedOutcome,
  System2ProviderAdapter,
  System2ProviderDispatchRequest,
  System2ProviderDispatchResponse,
} from './provider.ts'
export { ScriptedSystem2Provider, System2ProviderFailure, classifyProviderError } from './provider.ts'
export type { System2HarnessOptions } from './harness.ts'
export { createSystem2Harness, system2RequestId } from './harness.ts'

// --- provider-free replay (#439 section 23) -------------------------------
export type { ReplayEntry, ReplayMatch, ReplayMode } from './replayAdapter.ts'
export { ReplayProviderAdapter, replayEntriesFromArtifacts } from './replayAdapter.ts'

// --- the ONE registered prompt path --------------------------------------
export { REGISTERED_SYSTEM2_PROMPTS, SYSTEM2_PROMPT_ID, SYSTEM2_PROMPT_VERSION } from './prompt.ts'

// --- provider adapters (composition root only) ---------------------------
export type { AiGatewayProviderOptions, AiGatewayTransportMode } from './providers/aiGateway.ts'
export { aiGatewayProviderIdentity, createAiGatewayProvider } from './providers/aiGateway.ts'
