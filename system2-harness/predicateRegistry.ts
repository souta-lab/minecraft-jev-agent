// system2-harness/predicateRegistry.ts - the GENERIC predicate/capability
// vocabulary (#439 sections 4/13) + the code-owned TRUE/CAN truth facts the
// compiler may enrich with.
//
// The invariant this file enforces (#439 section 4):
//   the vocabulary describes generic semantic predicates/capabilities,
//   NOT a pre-authored M2/M3 route.
// There is deliberately no `descend_to_y16`, no `branch_mine`, no `diamond_road`,
// no `surface_for_log`, no `next_rung`. New Minecraft capabilities extend this
// registry; new benchmark milestones must NOT require new strategy names.
//
// Truth checking is not strategy substitution (#439 section 13). Enrichment
// below is additive-only and every addition is recorded with a truth-fact id.

import { canonicalJson } from './canonical.ts'
import type { GroundedRef, PredicateArgs, PredicateDraft, PredicateKind, SymbolicRef } from './contract.ts'
import { GROUNDED_REF_KINDS, PREDICATE_KINDS } from './contract.ts'

/** Bound on any count argument. Also enforces `count must be positive`. */
export const MAX_PREDICATE_COUNT = 4096

export const STATION_KINDS = [
  'crafting_table',
  'furnace',
  'chest',
  'anvil',
  'brewing_stand',
  'enchanting_table',
] as const
export type StationKind = (typeof STATION_KINDS)[number]

export const INTERACT_OPERATIONS = [
  'enter',
  'use',
  'mine',
  'collect',
  'place',
  'smelt',
  'craft',
  'trade',
  'attack',
  'open',
  'activate',
] as const
export type InteractOperation = (typeof INTERACT_OPERATIONS)[number]

export const FIND_DOMAINS = ['structure', 'resource', 'entity'] as const
export type FindDomain = (typeof FIND_DOMAINS)[number]

type ArgType = 'token' | 'positive_int' | 'ref' | 'enum'

interface ArgSpec {
  readonly type: ArgType
  readonly required: boolean
  readonly values?: readonly string[]
  /** When true the token is checked against the code-owned item vocabulary. */
  readonly item?: boolean
}

export interface PredicateDefinition {
  readonly kind: PredicateKind
  readonly description: string
  readonly args: Readonly<Record<string, ArgSpec>>
}

const TOKEN = /^[a-z][a-z0-9_]{0,63}$/

/**
 * The registry. Argument names are generic roles, never coordinates:
 * there is no `x`/`y`/`z`/`at` argument anywhere, so a hallucinated coordinate
 * cannot be expressed as an authoritative predicate (S8).
 */
export const PREDICATE_REGISTRY: Readonly<Record<PredicateKind, PredicateDefinition>> = Object.freeze({
  acquire: {
    kind: 'acquire',
    description: 'the mission-held inventory must contain item>=count (verified by code)',
    args: { item: { type: 'token', required: true, item: true }, count: { type: 'positive_int', required: true } },
  },
  ensure: {
    kind: 'ensure',
    description: 'a code-owned capability must become available',
    args: { capability: { type: 'token', required: true } },
  },
  reach: {
    kind: 'reach',
    description: 'the body must reach a grounded ref or a symbolic region',
    args: { target: { type: 'ref', required: true } },
  },
  find: {
    kind: 'find',
    description: 'a search objective must ground a structure/resource/entity',
    args: {
      domain: { type: 'enum', required: true, values: FIND_DOMAINS },
      key: { type: 'token', required: true },
    },
  },
  establish: {
    kind: 'establish',
    description: 'a usable station of the given kind must exist and be verified',
    args: { station: { type: 'enum', required: true, values: STATION_KINDS } },
  },
  interact: {
    kind: 'interact',
    description: 'a grounded ref must accept a semantic operation',
    args: {
      // `target` is optional ONLY because some operations have a code-owned
      // candidate source: `enter` resolves the verified portal site(s) itself and
      // fails closed when none is verified (compileIntent enforces the rule for
      // every other operation). Nothing here lets a coordinate in: `ref` accepts a
      // grounded id or a symbolic description, never `{x,y,z}`.
      target: { type: 'ref', required: false },
      operation: { type: 'enum', required: true, values: INTERACT_OPERATIONS },
    },
  },
  preserve: {
    kind: 'preserve',
    description: 'a held resource must not drop below count',
    args: { item: { type: 'token', required: true, item: true }, count: { type: 'positive_int', required: true } },
  },
  recover: {
    kind: 'recover',
    description: 'a verified deficit predicate must be restored',
    args: { deficit: { type: 'token', required: true } },
  },
})

export type PredicateValidation =
  | { readonly ok: true; readonly kind: PredicateKind; readonly args: PredicateArgs }
  | {
      readonly ok: false
      readonly kind: 'unsupported_predicate_kind' | 'invalid_predicate_arguments' | 'unsupported_item'
      readonly detail: string
    }

export function isPredicateKind(value: unknown): value is PredicateKind {
  return typeof value === 'string' && (PREDICATE_KINDS as readonly string[]).includes(value)
}

export interface PredicateValidationContext {
  /** Code-owned item vocabulary (production: minecraft-data). Empty = shape check only. */
  readonly knownItems?: readonly string[]
  /** Code-owned deficit vocabulary for `recover`. Empty = shape check only. */
  readonly knownDeficits?: readonly string[]
}

/**
 * Validate one draft predicate against the registry. Fail closed: an unknown
 * kind, an unknown argument, a bad type, a non-positive count or an item outside
 * the code-owned vocabulary is a typed rejection, never a repaired predicate.
 */
export function validatePredicateDraft(
  draft: PredicateDraft,
  context: PredicateValidationContext = {},
): PredicateValidation {
  if (!isPredicateKind(draft.kind)) {
    return {
      ok: false,
      kind: 'unsupported_predicate_kind',
      detail: `predicate kind "${draft.kind}" is not in the registry (registered: ${PREDICATE_KINDS.join(', ')})`,
    }
  }
  const definition = PREDICATE_REGISTRY[draft.kind]
  const specKeys = Object.keys(definition.args)
  const args = draft.args as Readonly<Record<string, unknown>>
  for (const key of Object.keys(args)) {
    if (!specKeys.includes(key)) {
      return {
        ok: false,
        kind: 'invalid_predicate_arguments',
        detail: `predicate ${draft.kind} has unknown argument "${key}" (allowed: ${specKeys.join(', ')})`,
      }
    }
  }
  const normalized: Record<string, unknown> = {}
  for (const key of specKeys) {
    const spec = definition.args[key]
    if (spec === undefined) continue
    const value = args[key]
    if (value === undefined || value === null) {
      if (spec.required) {
        return { ok: false, kind: 'invalid_predicate_arguments', detail: `predicate ${draft.kind} is missing required argument "${key}"` }
      }
      continue
    }
    if (spec.type === 'positive_int') {
      if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > MAX_PREDICATE_COUNT) {
        return {
          ok: false,
          kind: 'invalid_predicate_arguments',
          detail: `predicate ${draft.kind}.${key} must be a positive integer <= ${MAX_PREDICATE_COUNT} (got ${JSON.stringify(value)})`,
        }
      }
      normalized[key] = value
      continue
    }
    if (spec.type === 'enum') {
      if (typeof value !== 'string' || spec.values === undefined || !spec.values.includes(value)) {
        return {
          ok: false,
          kind: 'invalid_predicate_arguments',
          detail: `predicate ${draft.kind}.${key} must be one of ${(spec.values ?? []).join(', ')} (got ${JSON.stringify(value)})`,
        }
      }
      normalized[key] = value
      continue
    }
    if (spec.type === 'ref') {
      if (!isRefValue(value)) {
        return {
          ok: false,
          kind: 'invalid_predicate_arguments',
          detail: `predicate ${draft.kind}.${key} must be a grounded ref {kind:"grounded",refKind,refId} or a symbolic ref {kind:"symbolic",description}`,
        }
      }
      normalized[key] = value
      continue
    }
    if (typeof value !== 'string' || !TOKEN.test(value)) {
      return {
        ok: false,
        kind: 'invalid_predicate_arguments',
        detail: `predicate ${draft.kind}.${key} must be a lowercase token matching ${TOKEN.source} (got ${JSON.stringify(value)})`,
      }
    }
    if (spec.item === true) {
      const known = context.knownItems
      if (known !== undefined && known.length > 0 && !known.includes(value)) {
        return {
          ok: false,
          kind: 'unsupported_item',
          detail: `predicate ${draft.kind}.${key} references item "${value}" which is not in the code-owned item vocabulary`,
        }
      }
    }
    if (draft.kind === 'recover' && key === 'deficit') {
      const known = context.knownDeficits
      if (known !== undefined && known.length > 0 && !known.includes(value)) {
        return {
          ok: false,
          kind: 'unsupported_item',
          detail: `predicate recover.deficit references "${value}" which is not in the code-owned deficit vocabulary`,
        }
      }
    }
    normalized[key] = value
  }
  return { ok: true, kind: draft.kind, args: normalized as PredicateArgs }
}

export function isGroundedRefValue(value: unknown): value is GroundedRef {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    record.kind === 'grounded' &&
    typeof record.refKind === 'string' &&
    (GROUNDED_REF_KINDS as readonly string[]).includes(record.refKind) &&
    typeof record.refId === 'string' &&
    record.refId.length > 0
  )
}

export function isSymbolicRefValue(value: unknown): value is SymbolicRef {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return record.kind === 'symbolic' && typeof record.description === 'string' && record.description.length > 0
}

function isRefValue(value: unknown): value is GroundedRef | SymbolicRef {
  return isGroundedRefValue(value) || isSymbolicRefValue(value)
}

/** Semantic identity of a predicate: kind + canonical args. Used for dedupe/equality. */
export function predicateSemanticKey(kind: string, args: PredicateArgs): string {
  return `${kind}(${canonicalJson(args as unknown as Record<string, unknown>)})`
}

// ---------------------------------------------------------------------------
// code-owned TRUE/CAN truth facts (#439 section 13)
// ---------------------------------------------------------------------------

export interface TruthFact {
  readonly id: string
  readonly kind: 'true' | 'can'
  readonly description: string
}

export const TRUTH_FACTS: Readonly<Record<string, TruthFact>> = Object.freeze({
  'truth.recipe.requires_station': {
    id: 'truth.recipe.requires_station',
    kind: 'can',
    description: 'producing this item requires a usable station of the given kind',
  },
  'truth.recipe.components': {
    id: 'truth.recipe.components',
    kind: 'true',
    description: 'this item is produced from these component items',
  },
  'truth.portal.entry_requires_verified_portal': {
    id: 'truth.portal.entry_requires_verified_portal',
    kind: 'true',
    description: 'entering a portal requires a code-verified portal ref in the live dimension',
  },
  'truth.count.must_be_positive': {
    id: 'truth.count.must_be_positive',
    kind: 'true',
    description: 'a predicate count must be a positive integer',
  },
})

/**
 * Code-owned item truth. Production fills this from minecraft-data + recipe
 * truth (CAN/TRUE facts only). An empty index means the compiler enriches
 * nothing rather than inventing prerequisites.
 */
export interface ItemTruth {
  readonly item: string
  readonly requiresStation?: StationKind
  readonly components?: readonly { readonly item: string; readonly count: number }[]
}

export interface TruthIndex {
  readonly knownItems: readonly string[]
  readonly itemTruth: Readonly<Record<string, ItemTruth>>
}

export function createTruthIndex(input: {
  readonly knownItems?: readonly string[]
  readonly itemTruth?: readonly ItemTruth[]
}): TruthIndex {
  const itemTruth: Record<string, ItemTruth> = {}
  for (const truth of input.itemTruth ?? []) itemTruth[truth.item] = truth
  return {
    knownItems: [...(input.knownItems ?? [])],
    itemTruth,
  }
}

export const EMPTY_TRUTH_INDEX: TruthIndex = createTruthIndex({})

/** The predicate a `recover` deficit token names when code owns the mapping. */
export interface DeficitVocabulary {
  readonly [deficit: string]: PredicateDraft
}
