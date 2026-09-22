// system2-harness/compiler.ts - the deterministic, fail-closed compiler
// (#439 sections 5/6/7/11/13/26).
//
// Pipeline (each stage recorded in diagnostics):
//   raw response -> strict schema decode (schema.ts, harness-owned)
//   -> normalize proposal
//   -> compile IntentDraft -> OptionDraft/PredicateSpec
//   -> validate supported predicate/capability kinds
//   -> resolve grounded refs (unknown coordinates/entity/station ids FAIL CLOSED)
//   -> validate dependency graph
//   -> validate authority scope
//   -> validate semantic epoch (base revision binding)
//   -> construct immutable OptionGraphPatch
//
// The compiler may ADD TRUE/CAN facts (recipe needs a station, portal entry needs
// a verified portal, ender_eye needs powder + pearl). It may NOT rewrite strategy:
// "enter existing portal" can never become "mine diamonds and rebuild"
// (#439 section 13). That is enforced structurally by `assertAdditiveCompilation`
// below, which runs on every accepted patch and fails closed if a proposed
// predicate was dropped or replaced without a recorded truth fact.

import { canonicalJson, deepFreeze, hashId } from './canonical.ts'
import type {
  CompilableSystem2Proposal,
  CompileOutcome,
  CompiledOption,
  CompilerDiagnostics,
  CompileRejectKind,
  CompileStage,
  EnrichmentDiagnostic,
  GroundedRef,
  IntentDiagnostic,
  IntentDraft,
  OptionGraph,
  OptionGraphPatch,
  OptionGraphPatchEntry,
  OptionOrigin,
  PredicateArgs,
  PredicateArgValue,
  PredicateDraft,
  PredicateSpec,
  ProtectedIntent,
  System2ArtifactId,
  System2DecisionId,
  System2Proposal,
  System2RequestIdentity,
  TargetBinding,
} from './contract.ts'
import type { GroundedWorldIndex } from './grounding.ts'
import { exposeCandidates, resolveGroundedRef } from './grounding.ts'
import { MAX_PREDICATES_PER_INTENT, detectExecutionDirectives } from './schema.ts'
import type { TruthIndex } from './predicateRegistry.ts'
import { predicateSemanticKey, validatePredicateDraft } from './predicateRegistry.ts'
import { COMPILER_VERSION } from './versions.ts'

export const COMPILER_LIMITS = Object.freeze({
  maxIntents: 8,
  maxDependencyDepth: 2,
  maxSerializedBytes: 24_000,
})

export interface CompilerContext {
  readonly identity: System2RequestIdentity
  readonly graph: OptionGraph
  readonly index: GroundedWorldIndex
  readonly truth: TruthIndex
  /** Code-owned deficit vocabulary for `recover` (empty = shape check only). */
  readonly knownDeficits?: readonly string[]
  /** Code-owned capability vocabulary for `ensure` (empty = shape check only). */
  readonly knownCapabilities?: readonly string[]
  readonly protectedIntent?: ProtectedIntent | null
  readonly decisionId: System2DecisionId
  readonly artifactId: System2ArtifactId
  readonly limits?: Partial<typeof COMPILER_LIMITS>
}

interface IntentCompileSuccess {
  readonly ok: true
  readonly option: CompiledOption
  readonly diagnostics: readonly IntentDiagnostic[]
  readonly enrichments: readonly EnrichmentDiagnostic[]
}

interface IntentCompileFailure {
  readonly ok: false
  readonly diagnostic: IntentDiagnostic
  readonly diagnostics: readonly IntentDiagnostic[]
  readonly enrichments: readonly EnrichmentDiagnostic[]
}

type IntentCompileResult = IntentCompileSuccess | IntentCompileFailure

function isGroundedRef(value: PredicateArgValue | undefined): value is GroundedRef {
  return typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'grounded'
}

function specFromDraft(
  kind: PredicateSpec['kind'],
  args: PredicateArgs,
  draftIndex: number,
  grounded: boolean,
  enrichedBy: readonly string[] = [],
): PredicateSpec {
  return { kind, args, sourceDraftIndex: draftIndex, grounded, enrichedBy }
}

function optionIdFor(intent: IntentDraft, predicates: readonly PredicateSpec[]): string {
  const semantic = predicates.map((spec) => `${spec.kind}:${canonicalJson(spec.args as unknown as Record<string, unknown>)}`)
  return `opt_${hashId(canonicalJson({ text: intent.intentText.trim().toLowerCase(), semantic }).toLowerCase(), 16)}`
}

function instanceIdFor(optionId: string, artifactId: string, intentIndex: number): string {
  return `oi_${hashId(`${optionId}|${artifactId}|${intentIndex}`, 16)}`
}

/**
 * Derive the target binding for an intent.
 *
 * - explicit grounded ref: resolved, or the compile fails closed;
 * - explicit symbolic ref / no ref for an operation with a code-owned candidate
 *   source (portal entry): candidates are exposed. One verified candidate binds;
 *   several become an explicit `choice` (selectionAuthority `jev_pi`); none
 *   verified but some present-but-unverified is a truth rejection; nothing at all
 *   stays symbolic and becomes a search objective.
 */
function bindTarget(
  intent: IntentDraft,
  index: GroundedWorldIndex,
  intentIndex: number,
): { readonly ok: true; readonly binding: TargetBinding | null } | { readonly ok: false; readonly diagnostic: IntentDiagnostic } {
  const ref = intent.targetRef
  if (ref !== undefined && ref.kind === 'grounded') {
    const resolution = resolveGroundedRef(ref, index)
    if (resolution.status === 'not_found') {
      return {
        ok: false,
        diagnostic: {
          intentIndex,
          stage: 'grounding',
          kind: 'unknown_grounded_ref',
          detail: `targetRef ${ref.refKind}:${ref.refId} is not a grounded reference in the current world memory`,
          evidence: { refKind: ref.refKind, refId: ref.refId, knownRefs: exposeCandidates(ref.refKind, index).verified.map((candidate) => candidate.refId) },
        },
      }
    }
    if (resolution.status === 'known_absent') {
      return {
        ok: false,
        diagnostic: {
          intentIndex,
          stage: 'grounding',
          kind: ref.refKind === 'portal_site' ? 'portal_not_verified' : 'grounded_ref_known_absent',
          detail: resolution.reason,
          evidence: { refKind: ref.refKind, refId: ref.refId },
        },
      }
    }
    return { ok: true, binding: { kind: 'grounded', ref: resolution.ref, facts: resolution.facts } }
  }
  if (ref !== undefined && ref.kind === 'symbolic') {
    const resolved = resolveSymbolicTarget(ref.description, index, intentIndex)
    if (!resolved.ok) return { ok: false, diagnostic: resolved.rejection as IntentDiagnostic }
    return { ok: true, binding: resolved.binding }
  }
  // No explicit target: only meaningful for operations with a code-owned
  // candidate source. Otherwise the intent stays target-less and the predicates
  // carry the semantics.
  const wantsPortalEntry = intent.desiredPredicates.some(
    (draft) => draft.kind === 'interact' && draft.args.operation === 'enter',
  )
  if (wantsPortalEntry) {
    const resolved = resolveSymbolicTarget('portal', index, intentIndex)
    if (!resolved.ok) return { ok: false, diagnostic: resolved.rejection as IntentDiagnostic }
    return { ok: true, binding: resolved.binding }
  }
  return { ok: true, binding: null }
}

export interface SymbolicTargetResolution {
  readonly ok: boolean
  readonly binding: TargetBinding | null
  readonly rejection: IntentDiagnostic | null
}

/**
 * Resolve a target that the model expressed symbolically (or left implicit for an
 * operation with a code-owned candidate source).
 *
 * Ambiguity is EXPOSED: several verified candidates become a `choice` whose
 * selectionAuthority is `jev_pi`, because picking the nearest site here would be
 * hidden semantic ranking (#439 section 27). Zero verified candidates while
 * unverified sites exist is a TRUTH rejection, not a downgrade into "search for a
 * portal": silently turning "enter the existing portal" into "go find a portal"
 * would be code substituting a different semantic strategy (#439 section 13/14).
 */
function resolveSymbolicTarget(description: string, index: GroundedWorldIndex, intentIndex: number): SymbolicTargetResolution {
  const mentionsPortal = /portal/i.test(description)
  if (!mentionsPortal) {
    return { ok: true, binding: { kind: 'symbolic', ref: { kind: 'symbolic', description }, searchPredicate: null }, rejection: null }
  }
  const exposure = exposeCandidates('portal_site', index)
  if (exposure.verified.length === 1) {
    const only = exposure.verified[0]
    if (only !== undefined) {
      const resolution = resolveGroundedRef(only, index)
      if (resolution.status === 'resolved') {
        return { ok: true, binding: { kind: 'grounded', ref: resolution.ref, facts: resolution.facts }, rejection: null }
      }
    }
  }
  if (exposure.verified.length > 1) {
    return { ok: true, binding: { kind: 'choice', candidates: exposure.verified, selectionAuthority: 'jev_pi' }, rejection: null }
  }
  if (exposure.presentButUnverified.length > 0) {
    return {
      ok: false,
      binding: null,
      rejection: {
        intentIndex,
        stage: 'grounding',
        kind: 'portal_not_verified',
        detail: `the intent requires entering a portal, but every known portal site (${exposure.presentButUnverified
          .map((candidate) => candidate.refId)
          .join(', ')}) is unverified`,
        evidence: {
          truthFact: 'truth.portal.entry_requires_verified_portal',
          unverified: exposure.presentButUnverified.map((candidate) => candidate.refId),
        },
      },
    }
  }
  // No portal site is known at all: this stays a symbolic search objective rather
  // than becoming an invented target.
  return { ok: true, binding: { kind: 'symbolic', ref: { kind: 'symbolic', description }, searchPredicate: null }, rejection: null }
}

function truthCheckPredicate(
  spec: PredicateSpec,
  index: GroundedWorldIndex,
  intentIndex: number,
  stage: CompileStage,
  isDependency: boolean,
): IntentDiagnostic | null {
  if (spec.kind === 'interact' && spec.args.operation === 'enter') {
    const target = spec.args.target
    if (isGroundedRef(target)) {
      const resolution = resolveGroundedRef(target, index)
      if (resolution.status === 'not_found') {
        return {
          intentIndex,
          stage,
          kind: 'unknown_grounded_ref',
          detail: `interact(enter) target ${target.refId} is not a grounded reference`,
          evidence: { refId: target.refId, truthFact: 'truth.portal.entry_requires_verified_portal' },
        }
      }
      if (resolution.status === 'known_absent') {
        return {
          intentIndex,
          stage,
          kind: isDependency ? 'dependency_unsatisfiable' : 'portal_not_verified',
          detail: isDependency
            ? `dependency interact(enter ${target.refId}) is impossible: ${resolution.reason}`
            : resolution.reason,
          evidence: { refId: target.refId, truthFact: 'truth.portal.entry_requires_verified_portal' },
        }
      }
    }
  }
  if (spec.kind === 'establish') {
    const station = spec.args.station
    if (typeof station === 'string') {
      const exists = index.stations.some((candidate) => candidate.kind === station && candidate.usable)
      if (!exists) {
        // Not a rejection: `establish` is the objective that makes it exist.
        return null
      }
    }
  }
  return null
}

const MAX_COMPONENT_DEPTH = 2

function enrichDependencies(
  desired: readonly PredicateSpec[],
  dependencies: readonly PredicateSpec[],
  truth: TruthIndex,
  index: GroundedWorldIndex,
  intentIndex: number,
): { readonly dependencies: readonly PredicateSpec[]; readonly enrichments: readonly EnrichmentDiagnostic[]; readonly depth: number } {
  const enrichments: EnrichmentDiagnostic[] = []
  const additions: PredicateSpec[] = []
  const seen = new Set(dependencies.map((spec) => predicateSemanticKey(spec.kind, spec.args)))
  let depth = 0
  const queue: { readonly item: string; readonly count: number; readonly depth: number }[] = []

  for (const spec of desired) {
    if (spec.kind !== 'acquire') continue
    const item = spec.args.item
    const count = spec.args.count
    if (typeof item !== 'string' || typeof count !== 'number') continue
    const itemTruth = truth.itemTruth[item]
    if (itemTruth === undefined) continue
    if (itemTruth.requiresStation !== undefined) {
      const stationKind = itemTruth.requiresStation
      const usable = index.stations.some((candidate) => candidate.kind === stationKind && candidate.usable)
      if (!usable) {
        const args: PredicateArgs = { station: stationKind }
        const key = predicateSemanticKey('establish', args)
        const predicate = specFromDraft('establish', args, -1, true, ['truth.recipe.requires_station'])
        enrichments.push({
          source: 'truth_fact:recipe_requires_station',
          factId: 'truth.recipe.requires_station',
          intentIndex,
          effect: 'added_dependency',
          addedPredicate: predicate,
          detail: `acquire(${item}) requires a usable ${stationKind}; no verified ${stationKind} is known`,
        })
        if (!seen.has(key)) {
          seen.add(key)
          additions.push(predicate)
        }
      } else {
        enrichments.push({
          source: 'truth_fact:recipe_requires_station',
          factId: 'truth.recipe.requires_station',
          intentIndex,
          effect: 'validated',
          addedPredicate: null,
          detail: `acquire(${item}) requires a usable ${stationKind}; already verified`,
        })
      }
    }
    for (const component of itemTruth.components ?? []) {
      queue.push({ item: component.item, count: component.count * count, depth: 1 })
    }
  }

  while (queue.length > 0) {
    const entry = queue.shift()
    if (entry === undefined) break
    const args: PredicateArgs = { item: entry.item, count: entry.count }
    const key = predicateSemanticKey('acquire', args)
    const predicate = specFromDraft('acquire', args, -1, true, ['truth.recipe.components'])
    depth = Math.max(depth, entry.depth)
    enrichments.push({
      source: 'truth_fact:recipe_components',
      factId: 'truth.recipe.components',
      intentIndex,
      effect: 'added_dependency',
      addedPredicate: predicate,
      detail: `component ${entry.item} x${entry.count} required by the proposed item`,
    })
    if (!seen.has(key)) {
      seen.add(key)
      additions.push(predicate)
    }
    if (entry.depth >= MAX_COMPONENT_DEPTH) continue
    const componentTruth = truth.itemTruth[entry.item]
    for (const component of componentTruth?.components ?? []) {
      queue.push({ item: component.item, count: component.count * entry.count, depth: entry.depth + 1 })
    }
  }

  return { dependencies: [...dependencies, ...additions], enrichments, depth }
}

function compileIntent(
  intent: IntentDraft,
  intentIndex: number,
  context: CompilerContext,
  operation: System2Proposal['operation'],
): IntentCompileResult {
  const diagnostics: IntentDiagnostic[] = []
  const enrichments: EnrichmentDiagnostic[] = []
  const limits = { ...COMPILER_LIMITS, ...(context.limits ?? {}) }

  // --- stage: authority_scope (prose-only + protected intent) ---------------
  if (intent.desiredPredicates.length === 0 && operation !== 'suspend' && operation !== 'resume') {
    return {
      ok: false,
      diagnostic: {
        intentIndex,
        stage: 'authority_scope',
        kind: 'prose_only_intent',
        detail: 'intent has no typed desired predicate; natural-language text alone is never authority (#439 section 7/28)',
        evidence: { intentTextDirectives: detectExecutionDirectives(intent.intentText), operation },
      },
      diagnostics,
      enrichments,
    }
  }

  // --- stage: predicate_kinds ----------------------------------------------
  const desired: PredicateSpec[] = []
  for (let draftIndex = 0; draftIndex < intent.desiredPredicates.length; draftIndex += 1) {
    const draft = intent.desiredPredicates[draftIndex]
    if (draft === undefined) continue
    const validation = validatePredicateDraft(draft, {
      knownItems: context.truth.knownItems,
      knownDeficits: context.knownDeficits,
    })
    if (!validation.ok) {
      return {
        ok: false,
        diagnostic: {
          intentIndex,
          stage: validation.kind === 'unsupported_predicate_kind' ? 'predicate_kinds' : 'predicate_kinds',
          kind: validation.kind,
          detail: validation.detail,
          evidence: { draftIndex, kind: draft.kind },
        },
        diagnostics,
        enrichments,
      }
    }
    if (draft.kind === 'ensure') {
      const capability = validation.args.capability
      if (
        typeof capability === 'string' &&
        context.knownCapabilities !== undefined &&
        context.knownCapabilities.length > 0 &&
        !context.knownCapabilities.includes(capability)
      ) {
        return {
          ok: false,
          diagnostic: {
            intentIndex,
            stage: 'predicate_kinds',
            kind: 'unsupported_predicate_kind',
            detail: `ensure(capability=${capability}) is not in the code-owned capability vocabulary`,
            evidence: { capability, knownCapabilities: context.knownCapabilities },
          },
          diagnostics,
          enrichments,
        }
      }
    }
    desired.push(specFromDraft(validation.kind, validation.args, draftIndex, true))
  }

  // --- stage: predicate_kinds (conditional required args) ------------------
  // `interact.target` is optional in the registry only because `enter` has a
  // code-owned candidate source (verified portal sites). Any other operation
  // without a target would compile into a predicate that names nothing, so it is
  // rejected here rather than silently reinterpreted.
  for (let draftIndex = 0; draftIndex < desired.length; draftIndex += 1) {
    const spec = desired[draftIndex]
    if (spec === undefined) continue
    if (spec.kind !== 'interact') continue
    const target = spec.args.target
    if (target !== undefined && target !== null) continue
    if (spec.args.operation === 'enter') continue
    return {
      ok: false,
      diagnostic: {
        intentIndex,
        stage: 'predicate_kinds',
        kind: 'invalid_predicate_arguments',
        detail: `interact(operation=${String(spec.args.operation)}) requires an explicit target ref; only "enter" has a code-owned candidate source`,
        evidence: { draftIndex, operation: String(spec.args.operation) },
      },
      diagnostics,
      enrichments,
    }
  }

  // --- stage: grounding (desired predicates) -------------------------------
  for (const spec of desired) {
    const refArgs = Object.values(spec.args).filter(isGroundedRef)
    for (const ref of refArgs) {
      const resolution = resolveGroundedRef(ref, context.index)
      if (resolution.status === 'not_found') {
        return {
          ok: false,
          diagnostic: {
            intentIndex,
            stage: 'grounding',
            kind: 'unknown_grounded_ref',
            detail: `${spec.kind} references ${ref.refKind}:${ref.refId} which is not a grounded reference in the current world memory`,
            evidence: {
              refKind: ref.refKind,
              refId: ref.refId,
              knownRefs: exposeCandidates(ref.refKind, context.index).verified.map((candidate) => candidate.refId),
            },
          },
          diagnostics,
          enrichments,
        }
      }
      if (resolution.status === 'known_absent' && !(spec.kind === 'interact' && spec.args.operation === 'enter')) {
        return {
          ok: false,
          diagnostic: {
            intentIndex,
            stage: 'grounding',
            kind: 'grounded_ref_known_absent',
            detail: resolution.reason,
            evidence: { refKind: ref.refKind, refId: ref.refId },
          },
          diagnostics,
          enrichments,
        }
      }
    }
    const truthDiagnostic = truthCheckPredicate(spec, context.index, intentIndex, 'grounding', false)
    if (truthDiagnostic !== null) return { ok: false, diagnostic: truthDiagnostic, diagnostics, enrichments }
    if (spec.kind === 'interact' && spec.args.operation === 'enter') {
      enrichments.push({
        source: 'truth_fact:portal_entry_requires_verified_portal',
        factId: 'truth.portal.entry_requires_verified_portal',
        intentIndex,
        effect: 'validated',
        addedPredicate: null,
        detail: 'portal entry was checked against a code-verified portal ref',
      })
    }
  }

  // --- target binding ------------------------------------------------------
  const bound = bindTarget(intent, context.index, intentIndex)
  if (!bound.ok) return { ok: false, diagnostic: bound.diagnostic, diagnostics, enrichments }

  // When several grounded portal candidates exist and the intent proposes
  // entering a portal, the reference-bearing predicate must not silently bind to
  // one of them: the choice binding is the authority and Jev selects.
  if (bound.binding !== null && bound.binding.kind === 'choice') {
    for (const spec of desired) {
      if (spec.kind === 'interact' && spec.args.operation === 'enter' && isGroundedRef(spec.args.target)) {
        return {
          ok: false,
          diagnostic: {
            intentIndex,
            stage: 'grounding',
            kind: 'target_ambiguous',
            detail: 'several verified portal refs are known and the proposal named none of them explicitly',
            evidence: { candidates: bound.binding.candidates.map((candidate) => candidate.refId) },
          },
          diagnostics,
          enrichments,
        }
      }
    }
  }

  // --- stage: dependency_graph --------------------------------------------
  const dependencyDrafts: PredicateSpec[] = []
  for (let draftIndex = 0; draftIndex < (intent.dependencies ?? []).length; draftIndex += 1) {
    const draft = intent.dependencies?.[draftIndex]
    if (draft === undefined) continue
    const validation = validatePredicateDraft(draft, {
      knownItems: context.truth.knownItems,
      knownDeficits: context.knownDeficits,
    })
    if (!validation.ok) {
      return {
        ok: false,
        diagnostic: {
          intentIndex,
          stage: 'dependency_graph',
          kind: validation.kind == 'unsupported_predicate_kind' ? 'unsupported_predicate_kind' : 'invalid_predicate_arguments',
          detail: `dependency[${draftIndex}]: ${validation.detail}`,
          evidence: { draftIndex, kind: draft.kind },
        },
        diagnostics,
        enrichments,
      }
    }
    const spec = specFromDraft(validation.kind, validation.args, draftIndex, true)
    const truthDiagnostic = truthCheckPredicate(spec, context.index, intentIndex, 'dependency_graph', true)
    if (truthDiagnostic !== null) return { ok: false, diagnostic: truthDiagnostic, diagnostics, enrichments }
    dependencyDrafts.push(spec)
  }

  const desiredKeys = new Set(desired.map((spec) => predicateSemanticKey(spec.kind, spec.args)))
  for (const dependency of dependencyDrafts) {
    const key = predicateSemanticKey(dependency.kind, dependency.args)
    if (desiredKeys.has(key)) {
      return {
        ok: false,
        diagnostic: {
          intentIndex,
          stage: 'dependency_graph',
          kind: 'contradictory_dependency',
          detail: `predicate ${key} is both a desired predicate and a dependency of the same intent`,
          evidence: { key },
        },
        diagnostics,
        enrichments,
      }
    }
  }

  const enriched = enrichDependencies(desired, dependencyDrafts, context.truth, context.index, intentIndex)
  enrichments.push(...enriched.enrichments)
  if (enriched.depth > limits.maxDependencyDepth) {
    return {
      ok: false,
      diagnostic: {
        intentIndex,
        stage: 'dependency_graph',
        kind: 'dependency_depth_exceeded',
        detail: `dependency depth ${enriched.depth} exceeds cap ${limits.maxDependencyDepth}`,
        evidence: { depth: enriched.depth, cap: limits.maxDependencyDepth },
      },
      diagnostics,
      enrichments,
    }
  }
  const allDependencyKeys = new Set<string>()
  for (const dependency of enriched.dependencies) {
    const key = predicateSemanticKey(dependency.kind, dependency.args)
    if (allDependencyKeys.has(key)) {
      return {
        ok: false,
        diagnostic: {
          intentIndex,
          stage: 'dependency_graph',
          kind: 'dependency_cycle',
          detail: `dependency ${key} appears more than once for one intent`,
          evidence: { key },
        },
        diagnostics,
        enrichments,
      }
    }
    allDependencyKeys.add(key)
    if (desiredKeys.has(key)) {
      return {
        ok: false,
        diagnostic: {
          intentIndex,
          stage: 'dependency_graph',
          kind: 'dependency_cycle',
          detail: `truth enrichment produced a self-referential dependency ${key}`,
          evidence: { key },
        },
        diagnostics,
        enrichments,
      }
    }
  }
  if (desired.length + enriched.dependencies.length > MAX_PREDICATES_PER_INTENT * 2) {
    return {
      ok: false,
      diagnostic: {
        intentIndex,
        stage: 'authority_scope',
        kind: 'horizon_exceeded',
        detail: `intent compiles to ${desired.length + enriched.dependencies.length} predicates which exceeds the bounded horizon`,
        evidence: { predicates: desired.length + enriched.dependencies.length },
      },
      diagnostics,
      enrichments,
    }
  }

  // --- additive-only structural invariant (S9) -----------------------------
  const substitution = findStrategySubstitution(intent.desiredPredicates, desired)
  if (substitution !== null) {
    return {
      ok: false,
      diagnostic: {
        intentIndex,
        stage: 'compile_intent',
        kind: 'compiler_internal_invariant',
        detail: substitution,
        evidence: { intentIndex },
      },
      diagnostics,
      enrichments,
    }
  }

  const predicatesForId = [...desired, ...enriched.dependencies]
  const optionId = optionIdFor(intent, predicatesForId)
  const origin: OptionOrigin = {
    kind: 'system2',
    artifactId: context.artifactId,
    decisionId: context.decisionId,
    system2Epoch: context.identity.system2Epoch,
    baseRevision: context.graph.revision,
    intentIndex,
  }
  const option: CompiledOption = {
    optionId,
    optionInstanceId: instanceIdFor(optionId, context.artifactId, intentIndex),
    intentText: intent.intentText,
    desiredPredicates: desired,
    dependencies: enriched.dependencies,
    target: bound.binding,
    completionSemantics: intent.completionSemantics,
    origin,
    horizon: { intentIndex, dependencyDepth: enriched.depth },
  }
  return { ok: true, option, diagnostics, enrichments }
}

/**
 * S9 executable: every draft predicate must appear in the compiled desired
 * predicates, in order, with its draft index. The compiler may append
 * truth-fact predicates but may never drop, reorder or replace a proposal.
 */
export function findStrategySubstitution(
  drafts: readonly PredicateDraft[],
  compiled: readonly PredicateSpec[],
): string | null {
  const fromDrafts = compiled.filter((spec) => spec.sourceDraftIndex >= 0)
  if (fromDrafts.length !== drafts.length) {
    return `compiler kept ${fromDrafts.length} of ${drafts.length} proposed predicates`
  }
  for (let index = 0; index < drafts.length; index += 1) {
    const draft = drafts[index]
    const spec = fromDrafts[index]
    if (draft === undefined || spec === undefined) return 'compiler reordered proposed predicates'
    if (spec.sourceDraftIndex !== index) return `compiled predicate ${index} came from draft ${spec.sourceDraftIndex}`
    if (spec.kind !== draft.kind) return `compiled predicate ${index} changed kind ${draft.kind} -> ${spec.kind}`
  }
  return null
}

function entriesForOperation(
  operation: System2Proposal['operation'],
  compiled: readonly CompiledOption[],
  intents: readonly IntentDraft[],
  graph: OptionGraph,
): { readonly ok: true; readonly entries: readonly OptionGraphPatchEntry[] } | { readonly ok: false; readonly diagnostic: IntentDiagnostic } {
  const entries: OptionGraphPatchEntry[] = []
  const active = graph.options.filter((option) => option.status === 'active')
  const targetForIntent = (intentIndex: number): { readonly optionId: string; readonly instanceId: string } | null => {
    const ref = intents[intentIndex]?.targetRef
    if (ref === undefined || ref.kind !== 'grounded' || ref.refKind !== 'option') return null
    const existing = graph.options.find((option) => option.option.optionInstanceId === ref.refId || option.option.optionId === ref.refId)
    if (existing === undefined) return null
    return { optionId: existing.option.optionId, instanceId: existing.option.optionInstanceId }
  }

  switch (operation) {
    case 'append':
      for (const option of compiled) entries.push({ op: 'add', option })
      return { ok: true, entries }
    case 'replace':
      for (const option of active) entries.push({ op: 'suspend', targetOptionId: option.option.optionId })
      for (const option of compiled) entries.push({ op: 'add', option })
      return { ok: true, entries }
    case 'repair': {
      const target = active[active.length - 1]
      if (target === undefined) {
        return {
          ok: false,
          diagnostic: {
            intentIndex: 0,
            stage: 'authority_scope',
            kind: 'operation_target_missing',
            detail: 'operation "repair" requires an active option to repair',
            evidence: { operation },
          },
        }
      }
      entries.push({ op: 'replace', targetOptionId: target.option.optionId, option: compiled[0] as CompiledOption })
      for (const option of compiled.slice(1)) entries.push({ op: 'add', option })
      return { ok: true, entries }
    }
    case 'suspend': {
      for (let index = 0; index < intents.length; index += 1) {
        const target = targetForIntent(index)
        if (target === null) {
          return {
            ok: false,
            diagnostic: {
              intentIndex: index,
              stage: 'authority_scope',
              kind: 'operation_target_missing',
              detail: 'operation "suspend" requires each intent to reference an existing option via targetRef',
              evidence: { operation },
            },
          }
        }
        entries.push({ op: 'suspend', targetOptionId: target.optionId })
      }
      return { ok: true, entries }
    }
    case 'resume': {
      for (let index = 0; index < intents.length; index += 1) {
        const target = targetForIntent(index)
        if (target === null) {
          return {
            ok: false,
            diagnostic: {
              intentIndex: index,
              stage: 'authority_scope',
              kind: 'operation_target_missing',
              detail: 'operation "resume" requires each intent to reference an existing option via targetRef',
              evidence: { operation },
            },
          }
        }
        const compiledOption = compiled[index]
        entries.push(
          compiledOption === undefined
            ? { op: 'resume', targetOptionId: target.optionId }
            : { op: 'resume', targetOptionId: target.optionId, option: compiledOption },
        )
      }
      return { ok: true, entries }
    }
  }
}

function emptyDiagnostics(
  stages: readonly CompileStage[],
  intentDiagnostics: readonly IntentDiagnostic[],
  enrichments: readonly EnrichmentDiagnostic[],
  horizon: CompilerDiagnostics['horizon'],
): CompilerDiagnostics {
  return {
    stages,
    intentDiagnostics,
    enrichments,
    partialAcceptance: 'unsupported',
    horizon,
  }
}

/**
 * Compile a whole proposal. All-or-nothing: if ANY authoritative intent is
 * invalid the patch is rejected and the old graph stays authoritative
 * (#439 section 11). Silent partial acceptance is not a supported mode.
 */
export function compileSystem2Proposal(proposal: System2Proposal, context: CompilerContext): CompileOutcome {
  const limits = { ...COMPILER_LIMITS, ...(context.limits ?? {}) }
  const stages: CompileStage[] = ['schema_decode', 'normalize']
  const intentDiagnostics: IntentDiagnostic[] = []
  const enrichments: EnrichmentDiagnostic[] = []
  // Mutable accumulator; the frozen `CompilerDiagnostics` shape is applied when
  // the diagnostics object is built.
  const horizon = { intentCount: proposal.intents.length, maxDependencyDepth: 0, serializedBytes: 0 }

  const reject = (kind: CompileRejectKind, stage: CompileStage, detail: string, intentIndex = -1, evidence: IntentDiagnostic['evidence'] = {}): CompileOutcome => {
    const diagnostic: IntentDiagnostic = { intentIndex, stage, kind, detail, evidence }
    const diagnostics = emptyDiagnostics([...stages, stage], [...intentDiagnostics, diagnostic], enrichments, horizon)
    return {
      status: 'rejected',
      kind,
      rejectedIntentIndexes: proposal.intents.map((_, index) => index),
      diagnostics,
    }
  }

  // --- stage: semantic_epoch (base revision binding, S4) -------------------
  stages.push('semantic_epoch')
  if (context.identity.optionGraphRevision !== context.graph.revision) {
    return reject(
      'semantic_epoch_mismatch',
      'semantic_epoch',
      `request binds optionGraphRevision=${context.identity.optionGraphRevision} but the live graph revision is ${context.graph.revision}`,
      -1,
      { bound: context.identity.optionGraphRevision, live: context.graph.revision },
    )
  }

  // --- stage: authority_scope (operation, protected intent, horizon) -------
  stages.push('authority_scope')
  if (proposal.intents.length === 0) {
    return reject('empty_intents', 'authority_scope', 'proposal contains no intents')
  }
  if (proposal.intents.length > limits.maxIntents) {
    return reject('too_many_intents', 'authority_scope', `${proposal.intents.length} intents exceeds cap ${limits.maxIntents}`)
  }
  const protectedIntent = context.protectedIntent ?? null
  if (
    protectedIntent !== null &&
    (proposal.operation === 'replace' || proposal.operation === 'suspend') &&
    !protectedIntent.expandable
  ) {
    return reject(
      'protected_intent_violation',
      'authority_scope',
      `operation "${proposal.operation}" would replace protected human intent revision ${protectedIntent.intentRevision}`,
      -1,
      { intentRevision: protectedIntent.intentRevision, operation: proposal.operation },
    )
  }

  // --- stage: compile_intent (per intent, whole-patch failure) -------------
  stages.push('compile_intent')
  stages.push('predicate_kinds')
  stages.push('grounding')
  stages.push('dependency_graph')
  const compiled: CompiledOption[] = []
  for (let index = 0; index < proposal.intents.length; index += 1) {
    const intent = proposal.intents[index]
    if (intent === undefined) continue
    const result = compileIntent(intent, index, context, proposal.operation)
    enrichments.push(...result.enrichments)
    if (!result.ok) {
      intentDiagnostics.push(result.diagnostic)
      const diagnostics = emptyDiagnostics([...stages], intentDiagnostics, enrichments, horizon)
      return {
        status: 'rejected',
        kind: result.diagnostic.kind,
        rejectedIntentIndexes: proposal.intents.map((_, intentIndex) => intentIndex),
        diagnostics,
      }
    }
    horizon.maxDependencyDepth = Math.max(horizon.maxDependencyDepth, result.option.horizon.dependencyDepth)
    compiled.push(result.option)
  }

  // --- stage: patch --------------------------------------------------------
  stages.push('patch')
  const entriesResult = entriesForOperation(proposal.operation, compiled, proposal.intents, context.graph)
  if (!entriesResult.ok) {
    return reject(entriesResult.diagnostic.kind, entriesResult.diagnostic.stage, entriesResult.diagnostic.detail, entriesResult.diagnostic.intentIndex, entriesResult.diagnostic.evidence)
  }
  const patch: OptionGraphPatch = {
    baseRevision: context.graph.revision,
    operation: proposal.operation,
    entries: entriesResult.entries,
    artifactId: context.artifactId,
    decisionId: context.decisionId,
    diagnostics: emptyDiagnostics(stages, intentDiagnostics, enrichments, horizon),
  }
  const serializedBytes = canonicalJson(patch as unknown as Record<string, unknown>).length
  if (serializedBytes > limits.maxSerializedBytes) {
    return reject('serialized_size_exceeded', 'patch', `compiled patch is ${serializedBytes} bytes, cap ${limits.maxSerializedBytes}`, -1, {
      serializedBytes,
    })
  }
  horizon.serializedBytes = serializedBytes
  const diagnostics = emptyDiagnostics(stages, intentDiagnostics, enrichments, horizon)
  return deepFreeze({
    status: 'accepted',
    patch: { ...patch, diagnostics },
    acceptedIntentIndexes: proposal.intents.map((_, index) => index),
    rejectedIntentIndexes: [],
    diagnostics,
  })
}

/** Build the `CompilableSystem2Proposal` view recorded on the artifact/result. */
export function compilableProposal(
  proposal: System2Proposal,
  outcome: CompileOutcome,
  projectionHash: string,
  cache: CompilableSystem2Proposal['cache'],
): CompilableSystem2Proposal {
  if (outcome.status === 'accepted') {
    return {
      proposal,
      projectionHash,
      patch: outcome.patch,
      acceptedIntentIndexes: outcome.acceptedIntentIndexes,
      rejectedIntentIndexes: outcome.rejectedIntentIndexes,
      diagnostics: outcome.diagnostics,
      cache,
    }
  }
  return {
    proposal,
    projectionHash,
    patch: null,
    acceptedIntentIndexes: [],
    rejectedIntentIndexes: outcome.rejectedIntentIndexes,
    diagnostics: outcome.diagnostics,
    cache,
  }
}

export const COMPILER_VERSION_TAG = COMPILER_VERSION
