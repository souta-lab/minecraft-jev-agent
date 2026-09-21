// mercury-intent.ts - the SEMANTIC WHAT layer's natural-language contract.
//
// ARCHITECTURE (operator directive, 2026-09-22):
//
//   Mercury / LLM : WHAT, in NATURAL LANGUAGE (intent, plan in prose, reasoning).
//                   It is NOT asked to satisfy a JSON plan schema.
//   code          : grounding + CAN/TRUE/SAFE/DONE. It reads the language and
//                   grounds it onto the code-owned capability matrix
//                   (allowed goal kinds x targets) - never inventing a goal.
//   Jev           : the STRUCTURED layer - typed questions over grounded options.
//
// Consequence: this module NEVER rejects a model answer for being the wrong
// shape. It classifies the answer and returns either grounded goal records (from
// an OPTIONAL structured enrichment, or from the prose itself) or a typed
// UNGROUNDED outcome that leaves WHAT to the next layer.
//
// Two deliberate non-goals:
//   * It does not rank between multiple *valid semantic* options. A grounded goal
//     is emitted only when the intent names a target that the capability matrix
//     already exposes; ordering follows the model's own mention order.
//   * It does not decide the lifecycle op from prose. A prose-grounded plan is
//     always `patch` (keep the active Option, replace only its pending tail),
//     which is non-destructive; an explicit op in the enrichment is honoured when
//     it is one the queue understands.
//
// `buddy-driver` scoped AGENTS.md forbids deterministic code choosing WHAT NEXT
// after System2 is unavailable. Grounding is not that choice: it maps the
// model's own words onto the code-owned menu, and anything it cannot map becomes
// a visible UNGROUNDED outcome handled by the planner's typed option question.
import {
  MERCURY_ALLOWED_GOALS,
  MERCURY_TYPED_GOAL_KINDS,
} from './mercury-capabilities.ts'
import type { MercuryAllowedGoals } from './mercury-capabilities.ts'

/** The lifecycle operations the goal queue understands. */
export const PLAN_OPS = ['continue', 'patch', 'replace', 'abandon', 'complete', 'abort'] as const
export type PlanOpName = (typeof PLAN_OPS)[number]

/**
 * Structural goal shape the capability matrix can express. Deliberately defined
 * here (dependency-free) rather than derived from the Zod schema: this module is
 * the layer that must not depend on the schema.
 */
export interface MercuryIntentGoal {
  kind: string
  item?: string
  count?: number
  y?: number
  dimension?: string
  mode?: string
}

/** Envelope shape of a JSON object found in a model answer. */
export type MercuryJsonTextShape = 'exact' | 'fenced' | 'embedded' | 'multi-final' | 'none'

export interface MercuryJsonTextParse {
  readonly value: unknown | null
  readonly shape: MercuryJsonTextShape
  /** number of balanced top-level `{...}` objects seen in the text */
  readonly objects: number
}

/** All balanced top-level `{...}` substrings, string-literal aware. */
export function balancedJsonObjects(text: string): string[] {
  const found: string[] = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (depth > 0 && inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"' && depth > 0) {
      inString = true
      continue
    }
    if (char === '{') {
      if (depth === 0) start = index
      depth += 1
      continue
    }
    if (char === '}') {
      if (depth === 0) continue
      depth -= 1
      if (depth === 0 && start >= 0) {
        found.push(text.slice(start, index + 1))
        start = -1
      }
    }
  }
  return found
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseJsonObject(candidate: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(candidate)
    return isPlainObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function fencedBlocks(text: string): string[] {
  const blocks: string[] = []
  const pattern = /```(?:json)?\s*([\s\S]*?)\s*```/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const body = match[1]
    if (body !== undefined && body.trim().length > 0) blocks.push(body.trim())
  }
  return blocks
}

/**
 * Extract one candidate plan/enrichment object from a model's text response.
 * Envelope selection only: it never edits the object. Truth/authority validation
 * happens later and separately (see `stripUnknownPlanKeys` + the capability
 * validator), so a shape slip can never be a silent acceptance.
 */
export function parseMercuryJsonTextDetailed(text: string): MercuryJsonTextParse {
  const raw = typeof text === 'string' ? text : ''
  const trimmed = raw.trim()
  if (trimmed.length === 0) return { value: null, shape: 'none', objects: 0 }
  const objects = balancedJsonObjects(trimmed)
  const exact = parseJsonObject(trimmed)
  if (exact !== null) return { value: exact, shape: 'exact', objects: objects.length }
  for (const block of fencedBlocks(trimmed)) {
    const fenced = parseJsonObject(block)
    if (fenced !== null) return { value: fenced, shape: 'fenced', objects: objects.length }
  }
  const parsedObjects = objects
    .map(parseJsonObject)
    .filter((value): value is Record<string, unknown> => value !== null)
  if (parsedObjects.length === 0) return { value: null, shape: 'none', objects: objects.length }
  const withOp = parsedObjects.filter((value) => 'op' in value)
  if (withOp.length > 1) {
    // Several candidates look like a plan envelope: take the model's LAST
    // emission (reasoning models narrate drafts before the final answer).
    return { value: withOp[withOp.length - 1] ?? null, shape: 'multi-final', objects: objects.length }
  }
  if (withOp.length === 1) return { value: withOp[0] ?? null, shape: 'embedded', objects: objects.length }
  const fallback = parsedObjects[parsedObjects.length - 1] ?? null
  return { value: fallback, shape: objects.length > 1 ? 'multi-final' : 'embedded', objects: objects.length }
}

/** Backward-compatible value-only view of {@link parseMercuryJsonTextDetailed}. */
export function parseMercuryJsonText(text: string): unknown | null {
  return parseMercuryJsonTextDetailed(text).value
}

// ---------------------------------------------------------------------------
// optional structured enrichment: coerce, never reject
// ---------------------------------------------------------------------------

const PLAN_KEYS = new Set(['op', 'goals', 'reason'])
const GOAL_KEYS = new Set(['kind', 'item', 'count', 'y', 'dimension', 'mode'])

/**
 * Field-name aliases the live model actually emits. Measured live (source
 * 3c9243c, `meta/muse-spark-1.3-contributor`): the answer carried the internal
 * PlannedGoal field names (`targetItem`, `requiredCount`) instead of the plan
 * field names, so the strict schema rejected a semantically perfect plan with
 * `goals.2 expected unrecognized_keys` / `goals.0 Required`.
 */
const GOAL_KEY_ALIASES: Readonly<Record<string, string>> = {
  targetitem: 'item',
  target: 'item',
  itemname: 'item',
  requiredcount: 'count',
  quantity: 'count',
  amount: 'count',
  qty: 'count',
  targety: 'y',
  level: 'y',
  ylevel: 'y',
  action: 'kind',
  type: 'kind',
  verb: 'kind',
  goal: 'kind',
  goaltype: 'kind',
  dimensionid: 'dimension',
}

const KIND_ALIASES: Readonly<Record<string, string>> = {
  mine: 'collect',
  mining: 'collect',
  gather: 'collect',
  retrieve: 'collect',
  get: 'collect',
  obtain: 'collect',
  acquire: 'collect',
  collect_item: 'collect',
  make: 'craft',
  crafting: 'craft',
  smelting: 'smelt',
  place_item: 'place',
  station: 'place',
  go_to: 'goto',
  travel: 'goto',
  return_to: 'goto',
  descend: 'descend_to',
  dig_down: 'descend_to',
  exploring: 'explore',
  build_portal: 'build_portal_frame',
  portal_frame: 'build_portal_frame',
  ignite: 'light_portal',
  light_portal: 'light_portal',
  verify_portal: 'verify_portal',
}

const OP_ALIASES: Readonly<Record<string, string>> = {
  switch: 'replace',
  change: 'replace',
  'move on': 'replace',
  update: 'patch',
  modify: 'patch',
  keep: 'continue',
  carry_on: 'continue',
  done: 'complete',
  finish: 'complete',
  finished: 'complete',
  stop: 'abort',
  give_up: 'abort',
  discard: 'abandon',
  cancel: 'abandon',
}

export interface MercuryStripNotes {
  /** top-level / goal keys that carried no plan meaning and were removed */
  readonly droppedKeys: readonly string[]
  /** keys renamed onto the canonical plan field names */
  readonly renamedKeys: readonly string[]
  /** goal indices whose `kind` was mapped from a synonym */
  readonly kindAliases: readonly string[]
  readonly goals: number
}

export interface MercuryStrippedPlan {
  /** a plain object containing only canonical plan keys, ready for validation */
  readonly value: Record<string, unknown>
  readonly notes: MercuryStripNotes
}

function stripGoal(goal: Record<string, unknown>, notes: { dropped: string[]; renamed: string[]; kinds: string[] }): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(goal)) {
    const lower = key.toLowerCase()
    if (GOAL_KEYS.has(lower)) {
      out[lower] = raw
      continue
    }
    const alias = GOAL_KEY_ALIASES[lower]
    if (alias !== undefined) {
      out[alias] = raw
      notes.renamed.push(`goals[].${key}->${alias}`)
      continue
    }
    notes.dropped.push(`goals[].${key}`)
  }
  const kind = out.kind
  if (typeof kind === 'string') {
    const canonical = KIND_ALIASES[kind.toLowerCase()] ?? kind
    if (canonical !== kind) {
      notes.kinds.push(`${kind}->${canonical}`)
      out.kind = canonical
    }
  }
  return out
}

/**
 * Strip keys the plan contract does not define and rename the aliases the live
 * model emits, BEFORE validation. The capability validator still runs on the
 * stripped object, so plan SEMANTICS are validated exactly as before - only
 * harmless extras / provider field-name drift are tolerated instead of throwing
 * away a semantically valid plan.
 */
export function stripUnknownPlanKeys(value: unknown): MercuryStrippedPlan | null {
  if (!isPlainObject(value)) return null
  const notes = { dropped: [] as string[], renamed: [] as string[], kinds: [] as string[] }
  const out: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(value)) {
    const lower = key.toLowerCase()
    if (PLAN_KEYS.has(lower)) {
      out[lower] = lower === 'op' && typeof raw === 'string' ? (OP_ALIASES[raw.toLowerCase()] ?? raw) : raw
      continue
    }
    if (lower === 'plan' && isPlainObject(raw)) {
      // A nested `plan` envelope: flatten it rather than dropping the plan.
      const nested = stripUnknownPlanKeys(raw)
      if (nested !== null) {
        Object.assign(out, nested.value)
        notes.dropped.push(`plan->flattened`)
        notes.renamed.push(...nested.notes.renamedKeys)
        notes.kinds.push(...nested.notes.kindAliases)
        continue
      }
    }
    notes.dropped.push(key)
  }
  const goals = out.goals
  if (Array.isArray(goals)) {
    out.goals = goals.map((goal) => (isPlainObject(goal) ? stripGoal(goal, notes) : goal))
  }
  return {
    value: out,
    notes: {
      droppedKeys: notes.dropped,
      renamedKeys: notes.renamed,
      kindAliases: notes.kinds,
      goals: Array.isArray(out.goals) ? out.goals.length : 0,
    },
  }
}

// ---------------------------------------------------------------------------
// intent extraction
// ---------------------------------------------------------------------------

export interface MercuryIntentExtraction {
  /** The model's own words. Always carried so the WHAT survives as language. */
  readonly intent: string
  /** Optional structured enrichment found in the answer (uncoerced). */
  readonly enrichment: unknown | null
  /** transport-level shape of the enrichment object */
  readonly shape: 'tool-call' | MercuryJsonTextShape
  /** the answer carried no content at all */
  readonly empty: boolean
  /** characters in the raw answer text */
  readonly chars: number
}

/**
 * Classify a model answer into { natural-language intent, optional enrichment }.
 * Never throws and never rejects: an empty answer is a first-class typed state,
 * not a schema failure.
 */
export function extractMercuryIntent(
  text: string,
  jsonFromText: unknown | null,
  toolInput?: unknown,
): MercuryIntentExtraction {
  const trimmed = typeof text === 'string' ? text.trim() : ''
  const toolObject = isPlainObject(toolInput) ? toolInput : null
  const enrichment = toolObject ?? jsonFromText ?? null
  const shape: MercuryIntentExtraction['shape'] = toolObject !== null ? 'tool-call' : parseMercuryJsonTextDetailed(trimmed).shape
  const intent = trimmed.length > 0 ? trimmed : enrichment === null ? '' : JSON.stringify(enrichment)
  return { intent, enrichment, shape, empty: intent.length === 0, chars: trimmed.length }
}

// ---------------------------------------------------------------------------
// prose grounding onto the code-owned capability matrix
// ---------------------------------------------------------------------------

export interface MercuryIntentGrounding {
  readonly op: PlanOpName
  readonly goals: MercuryIntentGoal[]
  /** the exact substrings of the intent that grounded each goal, in order */
  readonly matched: string[]
  /** always 'intent': the enrichment path is validated, not grounded, elsewhere */
  readonly source: 'intent'
}

export interface MercuryIntentUngrounded {
  readonly reason: string
  readonly matched: readonly string[]
}

export type MercuryGroundingResult = ({ ok: true } & MercuryIntentGrounding) | ({ ok: false } & MercuryIntentUngrounded)

interface Mention {
  index: number
  goal: MercuryIntentGoal
  evidence: string
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Match an item name in prose, accepting `snake_case` or spaced spelling. */
function itemPattern(item: string): RegExp {
  return new RegExp(`\\b${escapeRegExp(item).replace(/_/g, '[ _]')}\\b`, 'i')
}

function readCountNear(text: string, index: number, end: number): number | null {
  const before = text.slice(Math.max(0, index - 24), index)
  const after = text.slice(end, Math.min(text.length, end + 24))
  const beforeMatch = before.match(/(\d{1,3})\s*(?:x|×)?\s*$/)
  if (beforeMatch?.[1] !== undefined) return Number(beforeMatch[1])
  const afterMatch = after.match(/^\s*(?:x|×)?\s*(\d{1,3})\b/)
  if (afterMatch?.[1] !== undefined) return Number(afterMatch[1])
  return null
}

function kindForItem(
  item: string,
  localText: string,
  allowed: MercuryAllowedGoals,
): string | null {
  const has = (list: readonly string[] | undefined): boolean => list !== undefined && list.includes(item)
  const wantsSmelt = /\bsmelt|smelting|furnace\b/i.test(localText)
  const wantsCraft = /\bcraft|crafting|make\b/i.test(localText)
  const wantsPlace = /\bplace|placing|put down\b/i.test(localText)
  const wantsGoto = /\bgoto|go to|travel to|return to|navigate to|retrieve\b/i.test(localText)
  if (wantsSmelt && has(allowed.smelt)) return 'smelt'
  if (wantsCraft && has(allowed.craft)) return 'craft'
  if (wantsPlace && has(allowed.place)) return 'place'
  if (wantsGoto && has(allowed.goto_resources)) return 'goto_resource'
  // Matrix order, matching the legacy `mercuryGoalKind` inference.
  if (has(allowed.smelt)) return 'smelt'
  if (has(allowed.craft)) return 'craft'
  if (has(allowed.collect)) return 'collect'
  if (has(allowed.goto_resources)) return 'goto_resource'
  if (has(allowed.place)) return 'place'
  return null
}

function capGoals(goals: Mention[], max = 8): Mention[] {
  const out: Mention[] = []
  const seen = new Set<string>()
  for (const mention of [...goals].sort((a, b) => a.index - b.index)) {
    const key = JSON.stringify(mention.goal)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(mention)
    if (out.length >= max) break
  }
  return out
}

/**
 * Ground a natural-language WHAT onto the code-owned capability matrix.
 *
 * This is grounding, not selection: every emitted goal names a target the matrix
 * already exposes, and the ORDER is the model's own mention order. When the
 * intent names nothing grounded, the caller gets a typed UNGROUNDED result and
 * the planner leaves the WHAT to its typed option question.
 */
export function groundMercuryIntent(
  intent: string,
  allowed: MercuryAllowedGoals = MERCURY_ALLOWED_GOALS,
): MercuryGroundingResult {
  const text = typeof intent === 'string' ? intent : ''
  const lower = text.toLowerCase()
  if (lower.trim().length === 0) return { ok: false, reason: 'empty_answer', matched: [] }

  const allowedItems = new Set<string>([
    ...(allowed.collect ?? []),
    ...(allowed.craft ?? []),
    ...(allowed.smelt ?? []),
    ...(allowed.place ?? []),
    ...(allowed.goto_resources ?? []),
  ])

  const mentions: Mention[] = []
  for (const item of allowedItems) {
    const pattern = itemPattern(item)
    const match = pattern.exec(lower)
    if (match === null) continue
    const index = match.index
    const local = lower.slice(Math.max(0, index - 40), Math.min(lower.length, index + item.length + 40))
    const kind = kindForItem(item, local, allowed)
    if (kind === null) continue
    const count = readCountNear(lower, index, index + match[0].length)
    mentions.push({
      index,
      goal: count === null ? { kind, item } : { kind, item, count },
      evidence: match[0],
    })
  }

  const kinds = new Set<string>(MERCURY_TYPED_GOAL_KINDS)
  const phase = (re: RegExp, kind: string): void => {
    if (!kinds.has(kind)) return
    const match = re.exec(lower)
    if (match === null) return
    mentions.push({ index: match.index, goal: { kind }, evidence: match[0] })
  }
  phase(/\b(?:build|construct|place|create|make)\b[^.]{0,40}\b(?:portal|frame)\b/, 'build_portal_frame')
  phase(/\b(?:light|ignite|activate)\b[^.]{0,30}\bportal\b/, 'light_portal')
  phase(/\b(?:verify|confirm|check)\b[^.]{0,30}\bportal\b/, 'verify_portal')

  const exploreModes = allowed.explore_modes ?? []
  if (kinds.has('explore') && /\bexplor|\bscout\b/i.test(lower)) {
    if (exploreModes.includes('cave') && /\bcave|caves|underground|cavern/i.test(lower)) {
      const at = lower.search(/\bcave|caves|underground|cavern/i)
      mentions.push({ index: at < 0 ? 0 : at, goal: { kind: 'explore', mode: 'cave' }, evidence: 'explore cave' })
    }
    if (exploreModes.includes('surface') && /\bsurface|above ground|overworld|treeline/i.test(lower)) {
      const at = lower.search(/\bsurface|above ground|overworld|treeline/i)
      mentions.push({ index: at < 0 ? 0 : at, goal: { kind: 'explore', mode: 'surface' }, evidence: 'explore surface' })
    }
  }
  if (kinds.has('descend_to')) {
    const explicit = /\b(?:descend|dig down|go down|drop down|mine down)\b[^.]{0,30}?\by\s*[=:]?\s*(-?\d{1,3})\b/.exec(lower)
    const bare = explicit ?? /\b(?:descend|dig down|go down|drop down|mine down)\b/.exec(lower)
    if (bare !== null) {
      const y = explicit?.[1] === undefined ? null : Number(explicit[1])
      mentions.push({ index: bare.index, goal: y === null ? { kind: 'descend_to' } : { kind: 'descend_to', y }, evidence: bare[0] })
    }
  }

  const grounded = capGoals(mentions)
  if (grounded.length === 0) {
    return { ok: false, reason: 'no_grounded_goal_in_intent', matched: [] }
  }
  return {
    ok: true,
    op: 'patch',
    goals: grounded.map((mention) => mention.goal),
    matched: grounded.map((mention) => mention.evidence),
    source: 'intent',
  }
}
