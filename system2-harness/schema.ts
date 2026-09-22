// system2-harness/schema.ts - strict decode of a raw provider response into the
// repo-owned System2Proposal (#439 sections 6/7).
//
// Fail closed. There is NO regex/fuzzy salvage, no "find the word diamond in the
// prose" path, no markdown-fence stripping: a malformed response is a typed
// `invalid_response` and it mutates nothing (#439 section 7). The live
// production transport currently parses JSON out of natural-language text with a
// "repair" path; this module is the boundary that replaces that behaviour.

import type {
  CompletionSemantics,
  GroundedRef,
  IntentDraft,
  PredicateArgs,
  PredicateArgValue,
  PredicateDraft,
  SymbolicRef,
  System2Operation,
  System2Proposal,
} from './contract.ts'
import { GROUNDED_REF_KINDS } from './contract.ts'
import { isGroundedRefValue, isSymbolicRefValue } from './predicateRegistry.ts'

/** Bounded horizon (#439 section 26). */
export const MAX_PROPOSAL_INTENTS = 8
export const MAX_PREDICATES_PER_INTENT = 6
export const MAX_INTENT_TEXT_CHARS = 600
export const MAX_RATIONALE_CHARS = 4000
export const MAX_ARGS_PER_PREDICATE = 6

const OPERATIONS: readonly System2Operation[] = ['replace', 'append', 'suspend', 'resume', 'repair']
const COMPLETION: readonly CompletionSemantics[] = ['all', 'any']

export interface DecodeDiagnostic {
  readonly path: string
  readonly code:
    | 'not_an_object'
    | 'unknown_key'
    | 'missing_key'
    | 'wrong_type'
    | 'empty_string'
    | 'too_long'
    | 'too_many'
    | 'unknown_operation'
    | 'unknown_completion_semantics'
    | 'invalid_ref'
    | 'invalid_arg_value'
    | 'json_parse_failed'
  readonly detail: string
}

export type DecodeResult =
  | { readonly ok: true; readonly proposal: System2Proposal }
  | { readonly ok: false; readonly diagnostics: readonly DecodeDiagnostic[] }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function decodeRef(value: unknown, path: string, diagnostics: DecodeDiagnostic[]): GroundedRef | SymbolicRef | null {
  if (isGroundedRefValue(value)) return value
  if (isSymbolicRefValue(value)) return value
  diagnostics.push({
    path,
    code: 'invalid_ref',
    detail: `expected {kind:"grounded",refKind:<${GROUNDED_REF_KINDS.join('|')}>,refId} or {kind:"symbolic",description} (got ${JSON.stringify(value)})`,
  })
  return null
}

function decodeArgs(value: unknown, path: string, diagnostics: DecodeDiagnostic[]): PredicateArgs | null {
  if (!isPlainObject(value)) {
    diagnostics.push({ path, code: 'wrong_type', detail: `predicate args must be an object (got ${JSON.stringify(value)})` })
    return null
  }
  const keys = Object.keys(value)
  if (keys.length > MAX_ARGS_PER_PREDICATE) {
    diagnostics.push({ path, code: 'too_many', detail: `predicate has ${keys.length} args, cap is ${MAX_ARGS_PER_PREDICATE}` })
    return null
  }
  const args: Record<string, PredicateArgValue> = {}
  for (const key of keys) {
    const entry = value[key]
    if (isGroundedRefValue(entry) || isSymbolicRefValue(entry)) {
      args[key] = entry
      continue
    }
    if (entry === null || typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean') {
      if (typeof entry === 'number' && !Number.isFinite(entry)) {
        diagnostics.push({ path: `${path}.${key}`, code: 'invalid_arg_value', detail: 'number must be finite' })
        return null
      }
      args[key] = entry
      continue
    }
    // Arrays/objects (including anything coordinate-shaped) are not an arg type.
    diagnostics.push({
      path: `${path}.${key}`,
      code: 'invalid_arg_value',
      detail: `arg values must be string|number|boolean|null|ref (got ${JSON.stringify(entry)})`,
    })
    return null
  }
  return args
}

function decodePredicate(value: unknown, path: string, diagnostics: DecodeDiagnostic[]): PredicateDraft | null {
  if (!isPlainObject(value)) {
    diagnostics.push({ path, code: 'wrong_type', detail: `predicate must be an object (got ${JSON.stringify(value)})` })
    return null
  }
  for (const key of Object.keys(value)) {
    if (key !== 'kind' && key !== 'args') {
      diagnostics.push({ path: `${path}.${key}`, code: 'unknown_key', detail: `unknown predicate key "${key}"` })
      return null
    }
  }
  const kind = value.kind
  if (typeof kind !== 'string' || kind.length === 0) {
    diagnostics.push({ path: `${path}.kind`, code: 'missing_key', detail: 'predicate.kind must be a non-empty string' })
    return null
  }
  const args = decodeArgs(value.args ?? {}, `${path}.args`, diagnostics)
  if (args === null) return null
  return { kind, args }
}

function decodePredicateList(value: unknown, path: string, diagnostics: DecodeDiagnostic[]): readonly PredicateDraft[] | null {
  if (!Array.isArray(value)) {
    diagnostics.push({ path, code: 'wrong_type', detail: `must be an array of predicates (got ${JSON.stringify(value)})` })
    return null
  }
  if (value.length > MAX_PREDICATES_PER_INTENT) {
    diagnostics.push({ path, code: 'too_many', detail: `${value.length} predicates exceeds cap ${MAX_PREDICATES_PER_INTENT}` })
    return null
  }
  const drafts: PredicateDraft[] = []
  for (let index = 0; index < value.length; index += 1) {
    const draft = decodePredicate(value[index], `${path}[${index}]`, diagnostics)
    if (draft === null) return null
    drafts.push(draft)
  }
  return drafts
}

function decodeIntent(value: unknown, path: string, diagnostics: DecodeDiagnostic[]): IntentDraft | null {
  if (!isPlainObject(value)) {
    diagnostics.push({ path, code: 'wrong_type', detail: `intent must be an object (got ${JSON.stringify(value)})` })
    return null
  }
  const allowed = new Set(['intentText', 'desiredPredicates', 'dependencies', 'targetRef', 'completionSemantics'])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      diagnostics.push({ path: `${path}.${key}`, code: 'unknown_key', detail: `unknown intent key "${key}"` })
      return null
    }
  }
  const intentText = value.intentText
  if (typeof intentText !== 'string' || intentText.trim().length === 0) {
    diagnostics.push({ path: `${path}.intentText`, code: 'empty_string', detail: 'intentText must be a non-empty string' })
    return null
  }
  if (intentText.length > MAX_INTENT_TEXT_CHARS) {
    diagnostics.push({ path: `${path}.intentText`, code: 'too_long', detail: `intentText exceeds ${MAX_INTENT_TEXT_CHARS} chars` })
    return null
  }
  // A natural-language field is descriptive unless accompanied by valid typed
  // predicates (#439 section 7). The compiler enforces "typed predicates are
  // required unless this is a suspend/resume of a grounded option"; the decoder
  // only enforces structure.
  const desired = decodePredicateList(value.desiredPredicates, `${path}.desiredPredicates`, diagnostics)
  if (desired === null) return null
  let dependencies: readonly PredicateDraft[] = []
  if (value.dependencies !== undefined) {
    const decoded = decodePredicateList(value.dependencies, `${path}.dependencies`, diagnostics)
    if (decoded === null) return null
    dependencies = decoded
  }
  let targetRef: GroundedRef | SymbolicRef | undefined
  if (value.targetRef !== undefined && value.targetRef !== null) {
    const ref = decodeRef(value.targetRef, `${path}.targetRef`, diagnostics)
    if (ref === null) return null
    targetRef = ref
  }
  const completion = value.completionSemantics ?? 'all'
  if (typeof completion !== 'string' || !COMPLETION.includes(completion as CompletionSemantics)) {
    diagnostics.push({
      path: `${path}.completionSemantics`,
      code: 'unknown_completion_semantics',
      detail: `completionSemantics must be one of ${COMPLETION.join('|')}`,
    })
    return null
  }
  const intent: IntentDraft = {
    intentText,
    desiredPredicates: desired,
    completionSemantics: completion as CompletionSemantics,
  }
  return dependencies.length > 0 || targetRef !== undefined
    ? { ...intent, dependencies, targetRef }
    : intent
}

/**
 * Strict decode of an already-parsed JSON value into a System2Proposal.
 * Unknown keys anywhere in the authoritative part are rejected: a field this
 * harness does not understand must never be silently ignored (#439 section 6/7).
 */
export function decodeSystem2Proposal(raw: unknown): DecodeResult {
  const diagnostics: DecodeDiagnostic[] = []
  if (!isPlainObject(raw)) {
    return { ok: false, diagnostics: [{ path: '$', code: 'not_an_object', detail: `proposal must be a JSON object (got ${JSON.stringify(raw)})` }] }
  }
  for (const key of Object.keys(raw)) {
    if (key !== 'operation' && key !== 'rationale' && key !== 'intents') {
      diagnostics.push({ path: `$.${key}`, code: 'unknown_key', detail: `unknown proposal key "${key}"` })
    }
  }
  const operation = raw.operation
  if (typeof operation !== 'string' || !OPERATIONS.includes(operation as System2Operation)) {
    diagnostics.push({
      path: '$.operation',
      code: 'unknown_operation',
      detail: `operation must be one of ${OPERATIONS.join('|')} (got ${JSON.stringify(operation)})`,
    })
  }
  if (raw.rationale !== undefined && raw.rationale !== null) {
    if (typeof raw.rationale !== 'string') {
      diagnostics.push({ path: '$.rationale', code: 'wrong_type', detail: 'rationale must be a string when present' })
    } else if (raw.rationale.length > MAX_RATIONALE_CHARS) {
      diagnostics.push({ path: '$.rationale', code: 'too_long', detail: `rationale exceeds ${MAX_RATIONALE_CHARS} chars` })
    }
  }
  const intentsValue = raw.intents
  if (!Array.isArray(intentsValue)) {
    diagnostics.push({ path: '$.intents', code: 'wrong_type', detail: 'intents must be an array' })
  } else if (intentsValue.length === 0) {
    diagnostics.push({ path: '$.intents', code: 'missing_key', detail: 'intents must not be empty' })
  } else if (intentsValue.length > MAX_PROPOSAL_INTENTS) {
    diagnostics.push({ path: '$.intents', code: 'too_many', detail: `${intentsValue.length} intents exceeds cap ${MAX_PROPOSAL_INTENTS}` })
  } else {
    const intents: IntentDraft[] = []
    for (let index = 0; index < intentsValue.length; index += 1) {
      const intent = decodeIntent(intentsValue[index], `$.intents[${index}]`, diagnostics)
      if (intent === null) break
      intents.push(intent)
    }
    if (diagnostics.length === 0) {
      const proposal: System2Proposal =
        typeof raw.rationale === 'string'
          ? { operation: operation as System2Operation, rationale: raw.rationale, intents }
          : { operation: operation as System2Operation, intents }
      return { ok: true, proposal }
    }
  }
  return { ok: false, diagnostics }
}

// ---------------------------------------------------------------------------
// raw provider response -> JSON value (#439 section 7: no prose salvage)
// ---------------------------------------------------------------------------

export interface RawProviderResponse {
  /** Structured object straight from a tool call / JSON mode, when available. */
  readonly object: unknown
  /** Raw text, retained for the artifact even when it is not authoritative. */
  readonly text: string | null
  readonly finishReason: string | null
}

export type RawDecodeResult =
  | { readonly ok: true; readonly proposal: System2Proposal; readonly rationaleText: string | null }
  | { readonly ok: false; readonly detail: string; readonly diagnostics: readonly DecodeDiagnostic[] }

/**
 * Decode a provider response. When the transport returned no structured object,
 * the text must be a complete JSON object; anything else (prose, fenced JSON,
 * multiple objects, trailing commentary) is `invalid_response`. This is
 * deliberately stricter than the legacy transport, whose `repair` path salvaged
 * JSON out of prose and made the model's formatting a semantic hazard.
 */
export function decodeRawProviderResponse(raw: RawProviderResponse): RawDecodeResult {
  if (raw.object !== undefined && raw.object !== null) {
    const decoded = decodeSystem2Proposal(raw.object)
    if (!decoded.ok) {
      return { ok: false, detail: 'structured response failed strict schema decode', diagnostics: decoded.diagnostics }
    }
    return { ok: true, proposal: decoded.proposal, rationaleText: decoded.proposal.rationale ?? null }
  }
  const text = raw.text?.trim() ?? ''
  if (text.length === 0) {
    return {
      ok: false,
      detail: 'provider returned neither a structured object nor usable text',
      diagnostics: [{ path: '$', code: 'missing_key', detail: 'empty response' }],
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return {
      ok: false,
      detail: `response text is not a complete JSON object (${error instanceof Error ? error.message : String(error)})`,
      diagnostics: [{ path: '$', code: 'json_parse_failed', detail: 'text is not strict JSON; prose is never salvaged into goals' }],
    }
  }
  const decoded = decodeSystem2Proposal(parsed)
  if (!decoded.ok) {
    return { ok: false, detail: 'JSON response failed strict schema decode', diagnostics: decoded.diagnostics }
  }
  return { ok: true, proposal: decoded.proposal, rationaleText: decoded.proposal.rationale ?? null }
}

// ---------------------------------------------------------------------------
// prose diagnostics (never authority) (#439 section 28 / S8)
// ---------------------------------------------------------------------------

const EXECUTION_DIRECTIVE_PATTERNS: readonly { readonly id: string; readonly pattern: RegExp }[] = [
  { id: 'coordinate_pair', pattern: /-?\d{1,6}\s*[,/]\s*-?\d{1,6}/ },
  { id: 'coordinate_axis', pattern: /\b[xyz]\s*=\s*-?\d{1,6}\b/i },
  { id: 'absolute_y', pattern: /\by\s*=\s*-?\d{1,3}\b/i },
  { id: 'dig_straight_down', pattern: /dig\s+(?:straight\s+)?down/i },
  { id: 'walk_direction', pattern: /walk\s+(?:north|south|east|west)\b/i },
  { id: 'pillar_blocks', pattern: /pillar\s+\d+\s+blocks?/i },
  { id: 'move_blocks', pattern: /\b\d+\s+blocks?\s+(?:north|south|east|west|up|down)\b/i },
]

/**
 * Detect execution-level directives inside descriptive text. The result is a
 * diagnostic only: these strings are never compiled, and their presence never
 * changes the authoritative predicates (fixture 12).
 */
export function detectExecutionDirectives(text: string): readonly string[] {
  const found: string[] = []
  for (const entry of EXECUTION_DIRECTIVE_PATTERNS) {
    if (entry.pattern.test(text)) found.push(entry.id)
  }
  return found
}
