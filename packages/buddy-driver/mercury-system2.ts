// mercury-system2.ts - a REAL System2Brain (the semantic WHAT layer).
//
// The live model is `meta/muse-spark-1.3-contributor` (see MUSE_SPARK_MODEL /
// SYSTEM2_MODEL_DEFAULT). The module keeps the historical `Mercury*` names for the
// transport/marker surface because run artifacts and logs reference them; the MODEL it
// talks to is muse-spark. Earlier revisions used `inception/mercury-2.5` (and
// `inception/mercury-2`), which are retained in the price table for old call records.
//
// This adapter supplies production System2's high-level WHAT. The controller
// summons it when the queue is empty or a semantic option needs repair; no
// deterministic progression ladder selects the production goal.
//
// HARD RULES (mirrors AGENTS.md):
//   * The LLM returns the WHAT in NATURAL LANGUAGE. Structured plan facts
//     (`op`/`goals`/`reason`) are OPTIONAL enrichment: they are coerced and used
//     when present, never required as a precondition. A prose answer that grounds
//     onto the code-owned capability matrix is equally valid; an answer that
//     grounds onto nothing becomes a typed `ungrounded` outcome for the next
//     layer, not a fatal model failure. Structured/typed questions over grounded
//     options are Jev's job, not a schema imposed on this model.
//     System One remains the sole action authority - no action ids, no coordinates.
//   * Enabling System2 is EXPLICIT config (BUDDY_SYSTEM2=on/system2; legacy mercury spelling or
//     system2.config.json { "mercury": true }). The mere presence of a Gateway key
//     never enables it (issue #4). The planner-mode `deterministic` always wins.
//   * Every call is written to logs/jev/mercury-calls.jsonl with the SAME schema
//     family as jev-calls.jsonl so responses can be audited.
//   * Cost is bounded: state-hash cache + a hard N-calls/hour guard.
//   * Any error / rate limit / budget exhausted / disabled -> bounded retries, then
//     a FATAL line and process exit; never a deterministic ladder. The
//     deterministic ladder is reachable only through explicit planner mode `off`.
//
// TRANSPORT (verified 2026-09-18): the AI Gateway does NOT advertise
// `response_format` for inception/mercury-2.5 (supported_parameters has no
// response_format), so `generateObject` schema enforcement is unavailable and
// `Output.object` only validates locally. The gateway DOES advertise `tools` and
// `tool_choice`, so we get provider-enforced structured output by forcing a single
// tool call whose `inputSchema` is the strict Zod plan schema. Model id:
// `inception/mercury-2.5`.
//
// LOCAL ENDPOINT: when BUDDY_MERCURY_BASE_URL is set (e.g.
// http://127.0.0.1:8080/v1 for llama.cpp), Mercury posts to that
// OpenAI-compatible chat-completions endpoint directly, using
// BUDDY_MERCURY_MODEL as the served model name. The Vercel AI Gateway key is
// never required in this mode. Small local models cannot be trusted with a
// named tool choice, so the response is parsed as strict JSON text and the
// exact same local schema/capability validation (and corrective retry loop)
// stays authoritative. Reasoning models (Qwen3/Bonsai family) need
// BUDDY_MERCURY_LOCAL_NO_THINK=1 so hidden thinking cannot eat the output
// budget, and a longer BUDDY_SYSTEM2_TIMEOUT_MS (local inference is slower
// than the gateway default of 25s).
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { generateText, tool } from 'ai'
import type { Tool } from 'ai'
import { z } from 'zod'
import type { GoalKind, PlanOp, PlannedGoal } from '../jev-agent/src/goalQueue.ts'
import { goalKeyOf } from '../jev-agent/src/goalQueue.ts'
import { compilePlannedGoal, stableOptionInstanceId } from '../jev-agent/src/optionSpec.ts'
import type {
  System2Brain,
  System2Outcome,
  System2Plan,
  System2PlanRequest,
  System2SemanticOutcome,
  System2WithheldCandidate,
} from '../jev-agent/src/system2/service.ts'
import { System2RequestCancelledError } from '../jev-agent/src/system2/service.ts'
import type { System2PayloadShape } from '../jev-agent/src/system2/payload.ts'
import { resolveJevApiKey } from '../jev-agent/src/jev.ts'
import type { KeyResolution } from '../jev-agent/src/jev.ts'
import { FatalModelError, failLoud } from '../jev-agent/src/modelFailure.ts'
import {
  evaluateMercuryWaitLimitBackoff,
  mercuryWaitLimitBackoffDelayMs,
  resolveMercuryWaitLimitBackoffBaseMs,
  resolveMercuryWaitLimitBackoffMaxMs,
} from '../jev-agent/src/system2/escalation.ts'
import type {
  MercuryWaitLimitBackoffDecision,
  MercuryWaitLimitBackoffState,
} from '../jev-agent/src/system2/escalation.ts'
import { ORE_SOURCES } from '../jev-agent/src/state.ts'
import {
  NETHER,
  NETHER_PORTAL,
  OBSIDIAN,
  OVERWORLD,
  PORTAL_ENTERED_PREDICATE,
  PORTAL_LIT_PREDICATE,
  PORTAL_OBSIDIAN_REQUIRED,
  netherPortalEntryGoal,
} from '../jev-agent/src/netherPortalPlan.ts'
import {
  MERCURY_ALLOWED_GOALS,
  MERCURY_EXPLORE_MODES,
  MERCURY_MODEL_DEFAULT,
  SYSTEM2_MODEL_DEFAULT,
  MERCURY_TYPED_GOAL_KINDS,
} from './mercury-capabilities.ts'
import type { MercuryAllowedGoals } from './mercury-capabilities.ts'
import {
  extractMercuryIntent,
  groundMercuryIntent,
  parseMercuryJsonTextDetailed,
  proseWithoutJsonObjects,
  stripUnknownPlanKeys,
} from './mercury-intent.ts'
import type { MercuryIntentExtraction, MercuryJsonTextShape } from './mercury-intent.ts'

export { MERCURY_ALLOWED_GOALS, MERCURY_MODEL_DEFAULT, MERCURY_TYPED_GOAL_KINDS, SYSTEM2_MODEL_DEFAULT }
export {
  parseMercuryJsonText,
  parseMercuryJsonTextDetailed,
  proseWithoutJsonObjects,
  stripUnknownPlanKeys,
  groundMercuryIntent,
  extractMercuryIntent,
} from './mercury-intent.ts'
export type {
  MercuryIntentExtraction,
  MercuryIntentGoal,
  MercuryJsonTextParse,
  MercuryJsonTextShape,
  MercuryStrippedPlan,
} from './mercury-intent.ts'

/** Why Mercury was consulted. Exception-driven, never per-tick. */
export type MercuryTriggerReason =
  | 'wait_limit'
  | 'no_candidate'
  | 'no_progress'
  | 'action_impossible'
  | 'post_death'

export const MERCURY_TRIGGER_REASONS: readonly MercuryTriggerReason[] = [
  'wait_limit',
  'no_candidate',
  'no_progress',
  'action_impossible',
  'post_death',
]

/** Greppable marker: a no-plan `wait_limit` consultation raised the next-ask bar. */
export const MERCURY_TRIGGER_BACKOFF_MARKER = 'MERCURY_TRIGGER_BACKOFF'
/** Greppable marker: a `wait_limit` trigger was suppressed by an active backoff. */
export const MERCURY_TRIGGER_SUPPRESSED_MARKER = 'MERCURY_TRIGGER_SUPPRESSED'

/**
 * Input to the durable `wait_limit` trigger gate. `stallKey` identifies the
 * stalled semantic Option/objective (never the WAIT counter itself);
 * `authorityEpoch` is the request's monotonic progress counter, used only to
 * re-arm the gate after real progress.
 */
export interface MercuryWaitLimitTriggerInput {
  request: System2PlanRequest
  stallKey: string
  authorityEpoch?: number | null
  now?: number
}

/**
 * The strict plan schema (issue #19). A goal is EITHER a legacy item goal
 * `{ item, count }` (kind inferred locally, backward compatible) OR an explicit
 * typed goal `{ kind, ... }`. Free-form coordinates are NOT part of the schema:
 * `goto`/`goto_resource` reference a known resource, never an x/z position
 * (docs/decision/PLANNERS.md forbids model-generated coordinates). The kind is code-owned and
 * capability-grounded in `validateMercuryPlan`, so the model cannot smuggle in
 * motor semantics or an unsupported verb x target pair.
 */
export const MERCURY_PLAN_SCHEMA = z
  .object({
    op: z.enum(['continue', 'patch', 'replace', 'abandon', 'complete', 'abort']),
    goals: z
      .array(
        z
          .object({
            kind: z.enum(MERCURY_TYPED_GOAL_KINDS).optional(),
            item: z.string().min(1).max(64).optional(),
            count: z.number().int().min(1).max(64).optional(),
            /** descend_to predicate target level */
            y: z.number().int().min(-128).max(512).optional(),
            /** descend_to dimension (defaults to the overworld) */
            dimension: z.string().min(1).max(64).optional(),
            /** explore mode */
            mode: z.enum(MERCURY_EXPLORE_MODES).optional(),
          })
          .strict(),
      )
      .max(8),
    reason: z.string().min(1).max(400),
  })
  .strict()

export type MercuryPlanGoalJson = z.infer<typeof MERCURY_PLAN_SCHEMA>['goals'][number]
export type MercuryPlanJson = z.infer<typeof MERCURY_PLAN_SCHEMA>

/**
 * A mechanically-filled optional field (MERCURY_DEFAULT_COUNT today). Reported
 * instead of silently rewritten so `MERCURY_FIELD_DEFAULT` can show exactly what
 * code supplied and on whose authority.
 */
export interface MercuryFieldDefault {
  readonly path: string
  readonly value: string
  readonly why: string
}

/**
 * Structured form of the FIRST rejection. The corrective retry and the
 * `MERCURY_SCHEMA_REJECT` marker both read this, so the model is told the exact
 * field path and expectation instead of a bare Zod message.
 */
export interface MercuryPlanReject {
  /** schema field path, `<root>` when the whole plan object was absent, or `goals.N` for grounding. */
  readonly path: string
  /** what the schema/grounding expected at that path. */
  readonly expected: string
  readonly stage: 'schema' | 'capability' | 'plan'
}

export type MercuryValidation =
  | { ok: true; plan: MercuryPlanJson; repairs: readonly MercuryFieldDefault[] }
  | { ok: false; error: string; reject: MercuryPlanReject; repairs: readonly MercuryFieldDefault[] }

/**
 * Turn the first Zod issue into a path + expectation. A missing plan object is
 * reported by Zod as an empty-path `invalid_type` on `object` with the message
 * `Required`; that is exactly the live `schema:  Required` rejection (the model's
 * text response contained no parseable plan object at all), so it is reported as
 * `<root>` with an explicit "no plan object was produced" expectation instead of
 * an empty field path the model cannot act on.
 */
export function describeMercurySchemaIssue(
  issue:
    | { path: readonly (string | number)[]; code: string; expected?: unknown; received?: unknown; message: string }
    | undefined,
): MercuryPlanReject {
  const path = (issue?.path ?? []).map((segment) => String(segment)).join('.')
  if (path.length > 0) {
    const expected = issue?.expected === undefined ? (issue?.code ?? 'a valid value') : String(issue.expected)
    return { path, expected, stage: 'schema' }
  }
  if (issue?.code === 'invalid_type' && issue.received === 'undefined') {
    return {
      path: '<root>',
      expected: 'a JSON plan object { op, goals, reason } (no plan object was produced)',
      stage: 'schema',
    }
  }
  const expected = issue?.expected === undefined ? (issue?.code ?? 'a valid plan') : String(issue.expected)
  return { path: '<root>', expected, stage: 'schema' }
}

/** Render the exact corrective text fed back to the model for a rejection. */
export function describeMercuryReject(reject: MercuryPlanReject, issueMessage: string | undefined): string {
  if (reject.path === '<root>' && reject.expected.includes('no plan object was produced')) {
    return `schema: ${reject.path} expected ${reject.expected}`
  }
  const detail = issueMessage === undefined || issueMessage.length === 0 ? '' : ` (${issueMessage})`
  return `schema: ${reject.path} expected ${reject.expected}${detail}`
}

function collectableItems(): ReadonlySet<string> {
  return new Set(MERCURY_ALLOWED_GOALS.collect)
}

function craftableItems(): ReadonlySet<string> {
  return new Set(MERCURY_ALLOWED_GOALS.craft)
}

function smeltableItems(): ReadonlySet<string> {
  return new Set(MERCURY_ALLOWED_GOALS.smelt)
}

function placeableItems(): ReadonlySet<string> {
  return new Set(MERCURY_ALLOWED_GOALS.place)
}

function gotoResourceItems(): ReadonlySet<string> {
  return new Set(MERCURY_ALLOWED_GOALS.goto_resources)
}

/** Infer the queue kind from a grounded item. Unknown items return null. */
export function mercuryGoalKind(item: string): GoalKind | null {
  if (smeltableItems().has(item)) return 'smelt'
  if (craftableItems().has(item)) return 'craft'
  if (collectableItems().has(item)) return 'collect'
  return null
}

/**
 * Normalize an ore BLOCK name to its drop item so `goto_resource iron_ore`
 * grounds on the same resource the retrieval candidates already track
 * (`raw_iron`). Unknown names pass through unchanged (and then fail grounding).
 */
export function normalizeResourceItem(item: string): string {
  if (Object.prototype.hasOwnProperty.call(ORE_SOURCES, item)) return item
  for (const [drop, blocks] of Object.entries(ORE_SOURCES)) {
    if (blocks.includes(item)) return drop
  }
  return item
}

function itemList(set: ReadonlySet<string>): string {
  return [...set].join(',')
}

/**
 * Mechanical default count when the model omits one on an item goal. Code owns
 * mechanical validity; Mercury/Jev own WHAT NEXT. A missing count must never
 * discard an otherwise-valid plan, so it is filled with this safe minimum.
 */
export const MERCURY_DEFAULT_COUNT = 1

function goalNeedsCount(kind: string | null): boolean {
  return kind === 'collect' || kind === 'craft' || kind === 'smelt'
}

/**
 * Fill a missing count on an item goal with MERCURY_DEFAULT_COUNT. Purely
 * mechanical: it never reorders, invents, or drops goals, and an explicit count
 * (valid or not) passes through untouched so the validator still rejects it.
 */
export function normalizeMercuryGoal(goal: MercuryPlanGoalJson): MercuryPlanGoalJson {
  if (goal.count !== undefined) return goal
  const kind = goal.kind ?? mercuryGoalKind(goal.item ?? '')
  if (!goalNeedsCount(kind)) return goal
  return { ...goal, count: MERCURY_DEFAULT_COUNT }
}

/** Normalize every goal in a parsed plan; returns the same object when nothing changed. */
export function normalizeMercuryPlan(plan: MercuryPlanJson): MercuryPlanJson {
  return normalizeMercuryPlanDetailed(plan).plan
}

/**
 * Normalize and REPORT every mechanically-filled field. The plan is never
 * reordered, invented or dropped; only a missing optional count is supplied.
 */
export function normalizeMercuryPlanDetailed(plan: MercuryPlanJson): {
  plan: MercuryPlanJson
  repairs: readonly MercuryFieldDefault[]
} {
  const repairs: MercuryFieldDefault[] = []
  let changed = false
  const goals = plan.goals.map((goal, index) => {
    const normalized = normalizeMercuryGoal(goal)
    if (normalized !== goal) {
      changed = true
      repairs.push({
        path: `goals.${index}.count`,
        value: String(normalized.count),
        why: 'mechanical-minimum (MERCURY_DEFAULT_COUNT); omission is already schema-valid',
      })
    }
    return normalized
  })
  return { plan: changed ? { ...plan, goals } : plan, repairs }
}

function validateItemGoal(
  index: number,
  kind: string,
  goal: MercuryPlanGoalJson,
  allowed: ReadonlySet<string>,
): string | null {
  const item = typeof goal.item === 'string' ? goal.item : ''
  if (item.length === 0 || !allowed.has(item)) {
    return `goal[${index}] impossible ${kind}: ${item.length > 0 ? item : 'missing'} (allowed: ${itemList(allowed)})`
  }
  if (goal.count !== undefined && (!Number.isInteger(goal.count) || goal.count < 1 || goal.count > 64)) {
    return `goal[${index}] ${kind} count must be an integer in [1,64]`
  }
  return null
}

/**
 * Ground ONE goal: strict shape + code-owned kind x target capability matrix.
 * Returns a rejection reason string, or null when the goal is executable.
 */
export function validateMercuryGoal(index: number, goal: MercuryPlanGoalJson): string | null {
  // Legacy item goal: kind is inferred locally (backward compatible).
  if (goal.kind === undefined) {
    if (typeof goal.item !== 'string' || goal.item.length === 0) return `goal[${index}] legacy goal needs an item`
    if (mercuryGoalKind(goal.item) === null) return `goal[${index}] ungrounded item: ${goal.item}`
    if (goal.count === undefined || !Number.isInteger(goal.count) || goal.count < 1 || goal.count > 64) {
      return `goal[${index}] legacy goal needs count in [1,64]`
    }
    return null
  }
  switch (goal.kind) {
    case 'collect':
      return validateItemGoal(index, 'collect', goal, collectableItems())
    case 'craft':
      return validateItemGoal(index, 'craft', goal, craftableItems())
    case 'smelt':
      return validateItemGoal(index, 'smelt', goal, smeltableItems())
    case 'place':
      // count is optional for place; a station is singular.
      return validateItemGoal(index, 'place', goal, placeableItems())
    case 'goto':
    case 'goto_resource': {
      const raw = typeof goal.item === 'string' ? goal.item : ''
      const item = normalizeResourceItem(raw)
      if (item.length === 0 || !gotoResourceItems().has(item)) {
        return `goal[${index}] impossible ${goal.kind}: ${item.length > 0 ? item : 'missing'} (allowed resources: ${itemList(gotoResourceItems())})`
      }
      return null
    }
    case 'recover_death_site':
      return validatePortalParameterlessGoal(index, 'recover_death_site', goal, { allowDimension: false })
    case 'descend_to': {
      if (typeof goal.y !== 'number' || !Number.isInteger(goal.y) || goal.y < -59 || goal.y > 320) {
        return `goal[${index}] descend_to needs an integer y in [-59,320]`
      }
      if (goal.dimension !== undefined && (typeof goal.dimension !== 'string' || goal.dimension.length === 0)) {
        return `goal[${index}] descend_to dimension must be a non-empty string`
      }
      return null
    }
    case 'explore': {
      if (goal.mode === undefined || !MERCURY_ALLOWED_GOALS.explore_modes.includes(goal.mode)) {
        return `goal[${index}] explore needs mode ${MERCURY_ALLOWED_GOALS.explore_modes.join('|')}`
      }
      return null
    }
    case 'build_portal_frame':
      return validatePortalParameterlessGoal(index, 'build_portal_frame', goal, { allowDimension: false })
    case 'light':
    case 'light_portal':
    case 'verify':
    case 'verify_portal':
    case 'enter_portal':
      return validatePortalParameterlessGoal(index, goal.kind, goal, { allowDimension: true })
    default:
      return `goal[${index}] unsupported kind: ${String(goal.kind)}`
  }
}

function validatePortalParameterlessGoal(
  index: number,
  kind: string,
  goal: MercuryPlanGoalJson,
  opts: { allowDimension: boolean },
): string | null {
  if (goal.item !== undefined) return `goal[${index}] ${kind} takes no item: geometry is code-owned`
  if (goal.count !== undefined) return `goal[${index}] ${kind} takes no count`
  if (goal.y !== undefined) return `goal[${index}] ${kind} takes no y: geometry is code-owned`
  if (goal.mode !== undefined) return `goal[${index}] ${kind} takes no mode`
  if (goal.dimension !== undefined) {
    if (!opts.allowDimension) return `goal[${index}] ${kind} takes no dimension`
    if (typeof goal.dimension !== 'string' || goal.dimension.length === 0) {
      return `goal[${index}] ${kind} dimension must be a non-empty string`
    }
  }
  return null
}

/**
 * Shape validation (Zod) + local capability grounding. Pure and exported so CI
 * can prove planner safety without any network call. A rejected pair always
 * carries the exact reason (logged by the caller at PLAN_REJECTED).
 */
export function validateMercuryPlan(value: unknown): MercuryValidation {
  const parsed = MERCURY_PLAN_SCHEMA.safeParse(value)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const reject = describeMercurySchemaIssue(issue)
    return { ok: false, error: describeMercuryReject(reject, issue?.message), reject, repairs: [] }
  }
  const normalized = normalizeMercuryPlanDetailed(parsed.data)
  const plan = normalized.plan
  if ((plan.op === 'abort' || plan.op === 'complete') && plan.goals.length !== 0) {
    return {
      ok: false,
      error: `${plan.op} plans must not contain goals`,
      reject: { path: 'goals', expected: `no goals for op=${plan.op}`, stage: 'plan' },
      repairs: normalized.repairs,
    }
  }
  for (let index = 0; index < plan.goals.length; index += 1) {
    const goal = plan.goals[index]
    if (goal === undefined) continue
    const error = validateMercuryGoal(index, goal)
    if (error !== null) {
      return {
        ok: false,
        error,
        reject: { path: `goals.${index}`, expected: 'a grounded kind x target pair from allowedGoals', stage: 'capability' },
        repairs: normalized.repairs,
      }
    }
  }
  return { ok: true, plan, repairs: normalized.repairs }
}

/** A rejected plan that is retryable WHEN the exact rejection is fed back to the model. */
export class MercuryPlanValidationError extends Error {
  readonly validationError: string
  readonly rawPlan: unknown
  readonly reject: MercuryPlanReject | null

  constructor(validationError: string, rawPlan: unknown, reject: MercuryPlanReject | null = null) {
    super(`invalid plan: ${validationError}`)
    this.name = 'MercuryPlanValidationError'
    this.validationError = validationError
    this.rawPlan = rawPlan
    this.reject = reject
  }
}

class StaleMercuryGenerationError extends Error {
  constructor() {
    super('generation is no longer current')
    this.name = 'StaleMercuryGenerationError'
  }
}

/** The exact corrective text for the next attempt, or null for non-validation errors. */
export function mercuryRetryFeedback(error: unknown): string | null {
  return error instanceof MercuryPlanValidationError ? error.validationError : null
}

/**
 * A validation error is retryable with feedback; transport errors keep their own
 * retryability. Budget/config failures never reach this predicate (reserveAttempt
 * throws them before the call), so a schema slip cannot become an infinite loop.
 */
export function isRetryableMercuryAttempt(error: unknown): boolean {
  return error instanceof MercuryPlanValidationError || isRetryableModelError(error)
}

export const MERCURY_SCHEMA_CORRECTIVE_HINT =
  "Every collect/craft/smelt goal MUST name a real allowed item AND include an integer count in [1,64]; a legacy item goal must be exactly { item, count }."

/**
 * Legacy corrective hint, retained for the generic retry-loop utility and its
 * fixture. The Mercury call path no longer uses it: under the natural-language
 * contract (2026-09-22) an ungroundable answer is a typed `ungrounded` outcome,
 * not a schema rejection, so no corrective retry is scheduled for it.
 */
export const MERCURY_NO_PLAN_OBJECT_HINT =
  'Your previous answer named no grounded step. Name ONE real item, resource, explore mode or portal step from allowedGoals in one short natural-language sentence.'

/** Select the corrective hint that matches the exact rejection. */
export function mercuryCorrectiveHint(validationError: string): string {
  return validationError.includes('no plan object was produced')
    ? MERCURY_NO_PLAN_OBJECT_HINT
    : MERCURY_SCHEMA_CORRECTIVE_HINT
}

/** Append the exact validation rejection + a repair instruction to the next attempt's prompt. */
export function buildCorrectivePrompt(basePrompt: string, validationError: string): string {
  return [
    basePrompt,
    '',
    'CORRECTION REQUIRED: your previous emitPlan call was rejected by local validation:',
    `  ${validationError}`,
    `Fix exactly that problem and re-emit the emitPlan tool call. ${mercuryCorrectiveHint(validationError)}`,
    'Do not repeat the rejected goal unchanged.',
  ].join('\n')
}

/**
 * #system2-compile: the dimension a lowered goal is executable in when the model
 * named none - the LIVE one, prefixed like the rest of the plan vocabulary. Code
 * grounding to where the body is cannot fabricate a target; inventing the
 * overworld can (and did) declare a Nether row undeployable.
 */
function compileLiveDimension(state?: Pick<MercuryStateSummary, 'dimension'>): string {
  const live = state?.dimension
  if (typeof live !== 'string' || live.length === 0) return 'minecraft:overworld'
  return live.startsWith('minecraft:') ? live : `minecraft:${live}`
}

/**
 * Compile ONE validated goal onto the existing executable machinery:
 *   place/craft/collect/smelt -> matching PlannedGoal kind (PLACE / CRAFT / ...)
 *   goto / goto_resource      -> `collect` of the resource (known-resource RETRIEVE)
 *   descend_to                -> `descend` predicate goal (targetY)
 *   explore                  -> first-class bounded search Option; current-world grounding stays in code
 */
function compileMercuryGoalRaw(
  goal: MercuryPlanGoalJson,
  state?: Pick<MercuryStateSummary, 'dimension' | 'postDeath'>,
): PlannedGoal | null {
  if (goal.kind === undefined) {
    const item = goal.item ?? 'unknown'
    const count = goal.count ?? 1
    const kind = mercuryGoalKind(item) ?? 'collect'
    return {
      kind,
      description: `${kind} ${count} x ${item}`,
      targetItem: item,
      requiredCount: count,
      detail: 'mercury plan repair',
    }
  }
  const count = goal.count ?? 1
  switch (goal.kind) {
    case 'collect':
    case 'craft':
    case 'smelt':
    case 'place':
      return {
        kind: goal.kind,
        description: `${goal.kind} ${count} x ${goal.item ?? 'unknown'}`,
        targetItem: goal.item ?? null,
        requiredCount: count,
        detail: 'mercury plan repair',
      }
    case 'goto':
    case 'goto_resource': {
      const item = normalizeResourceItem(goal.item ?? '')
      return {
        kind: 'collect',
        description: `goto ${item} (known-resource retrieval)`,
        targetItem: item,
        requiredCount: 1,
        detail: `mercury ${goal.kind}:${item}`,
      }
    }
    case 'recover_death_site': {
      const postDeath = state?.postDeath ?? null
      const target = postDeath?.latestDeathPoint ?? null
      if (target === null) return null
      const deathDimension = postDeath?.dimension ?? ''
      const liveDimension = state?.dimension ?? ''
      if (deathDimension.replace(/^minecraft:/, '') !== liveDimension.replace(/^minecraft:/, '')) return null
      return {
        kind: 'goto',
        description: 'return to the latest death site to recover dropped inventory',
        targetItem: null,
        requiredCount: 1,
        targetPosition: { ...target },
        targetPredicate: 'death_site_recovery',
        dimension: deathDimension,
        detail: 'mercury recover_death_site',
      }
    }
    case 'descend_to':
      return {
        kind: 'descend',
        description: `descend_to:Y=${goal.y}`,
        targetItem: null,
        requiredCount: 1,
        targetY: goal.y,
        // #system2-compile: a `descend_to` that names no dimension can only be
        // grounded against the dimension the body is actually in. Defaulting to
        // the overworld FABRICATED a declared dimension, so the row was
        // structurally undeployable anywhere else (the measured Nether loop:
        // `declared=overworld live=the_nether` -> escalate). With no live state
        // (offline fixtures) the documented overworld default is kept.
        dimension: goal.dimension ?? compileLiveDimension(state),
        detail: 'mercury descend_to',
      }
    case 'explore':
      return {
        kind: 'explore',
        description: `explore ${goal.mode ?? 'unknown'} terrain`,
        targetItem: null,
        requiredCount: 1,
        detail: `mercury explore:${goal.mode ?? 'unknown'}`,
      }
    case 'build_portal_frame':
      return {
        kind: 'place',
        description: `build the ${PORTAL_OBSIDIAN_REQUIRED}-block obsidian nether portal frame`,
        targetItem: OBSIDIAN,
        requiredCount: PORTAL_OBSIDIAN_REQUIRED,
        detail: 'mercury build_portal_frame',
      }
    case 'light':
    case 'light_portal':
    case 'verify':
    case 'verify_portal': {
      const lighting = goal.kind === 'light' || goal.kind === 'light_portal'
      return {
        kind: 'place',
        description: lighting ? 'light the nether portal with flint_and_steel' : 'verify the lit nether portal',
        targetItem: NETHER_PORTAL,
        requiredCount: 1,
        targetPredicate: PORTAL_LIT_PREDICATE,
        dimension: goal.dimension ?? OVERWORLD,
        detail: `mercury ${goal.kind}`,
      }
    }
    case 'enter_portal':
      return {
        ...netherPortalEntryGoal(goal.dimension ?? NETHER),
        detail: 'mercury enter_portal',
      }
    default:
      return null
  }
}

/**
 * Attach the model-selected semantic identity to the executable queue row.
 * `goto`/`explore` still use existing grounded mechanics underneath, but their
 * canonical Option id and intent survive the lowering step instead of being
 * reconstructed later as `collect:*`/`descend:*`.
 */
function semanticizeMercuryGoal(source: MercuryPlanGoalJson, compiled: PlannedGoal): PlannedGoal {
  const item = typeof source.item === 'string' ? normalizeResourceItem(source.item) : null
  const templateId =
    source.kind === undefined
      ? `${compiled.kind}:${item ?? source.item ?? 'unknown'}`
      : source.kind === 'goto' || source.kind === 'goto_resource'
        ? `goto:${item ?? 'unknown'}`
        : source.kind === 'recover_death_site'
          ? // #system2-compile: the Option id contract is `<kind>:<target>` (see
            // `validateOptionSpec`), so the bare word `recover_death_site` made
            // every valid death-site recovery unreachable - the compiled row was
            // dropped by the Option compiler (`OPTION_COMPILE_REJECTED`, measured
            // 8x live after the predicate validator fix). The verb is preserved,
            // the host still owns the coordinate.
            'goto:death_site'
        : source.kind === 'explore'
          ? `explore:${source.mode ?? 'unknown'}`
          : source.kind === 'descend_to'
            ? `descend_to:y${source.y ?? 'unknown'}`
            : `${source.kind}:${item ?? source.mode ?? (source.y === undefined ? 'goal' : `y${source.y}`)}`
  const semanticSpec = {
    ...compilePlannedGoal(compiled),
    id: templateId,
    // Explore's mode is part of the selected WHAT, not an item. Preserve it
    // when the Option is later lowered back to the executable queue row.
    intent: source.kind === undefined || source.kind === 'explore'
      ? compiled.description
      : `${source.kind}${item === null ? '' : ` ${item}`}`,
  }
  const semanticInstanceId = stableOptionInstanceId(semanticSpec)
  semanticSpec.semanticOptionTemplateId = semanticSpec.id
  semanticSpec.semanticOptionInstanceId = semanticInstanceId
  semanticSpec.semanticOptionIntent = semanticSpec.intent
  return {
    ...compiled,
    optionTemplateId: semanticSpec.id,
    optionInstanceId: semanticInstanceId,
    semanticOptionTemplateId: semanticSpec.id,
    semanticOptionInstanceId: semanticInstanceId,
    semanticOptionIntent: semanticSpec.intent,
    optionSpec: semanticSpec,
  }
}

export function compileMercuryGoal(
  goal: MercuryPlanGoalJson,
  state?: Pick<MercuryStateSummary, 'dimension' | 'postDeath'>,
): PlannedGoal | null {
  const compiled = compileMercuryGoalRaw(goal, state)
  return compiled === null ? null : semanticizeMercuryGoal(goal, compiled)
}

/** Map the validated plan onto the queue's PlannedGoal records. */
export function plannedGoalsFromMercury(
  plan: MercuryPlanJson,
  state?: Pick<MercuryStateSummary, 'dimension' | 'postDeath'>,
): PlannedGoal[] {
  if (plan.op === 'abort' || plan.op === 'complete') return []
  const goals: PlannedGoal[] = []
  for (const goal of plan.goals) {
    const compiled = compileMercuryGoal(goal, state)
    if (compiled !== null) goals.push(compiled)
  }
  return goals
}

/**
 * #system2-compile: the model goals the executable lowering could NOT compile.
 *
 * `plannedGoalsFromMercury` skips an uncompilable goal, which is right - code
 * must not invent the missing WHAT - but a skip that leaves no trace makes a
 * partial compile look like an answer that named fewer goals. This names every
 * dropped goal by index and identifying field, so the hand-off is auditable and
 * a plan that compiles to nothing carries a typed reason all the way to the
 * queue instead of applying zero rows silently.
 */
export function uncompiledMercuryGoals(
  plan: MercuryPlanJson,
  state?: Pick<MercuryStateSummary, 'dimension' | 'postDeath'>,
): { index: number; kind: string; detail: string }[] {
  if (plan.op === 'abort' || plan.op === 'complete') return []
  const uncompiled: { index: number; kind: string; detail: string }[] = []
  plan.goals.forEach((goal, index) => {
    if (compileMercuryGoal(goal, state) !== null) return
    const detail =
      goal.kind === 'recover_death_site'
        ? 'no live death point in the live dimension'
        : goal.kind === undefined
          ? `legacy item goal ${goal.item ?? 'unknown'} is not an executable capability`
          : `kind ${goal.kind} is not an executable capability`
    uncompiled.push({ index, kind: goal.kind ?? goal.item ?? 'item', detail })
  })
  return uncompiled
}

const MERCURY_SMELT_INPUTS: Readonly<Record<string, string>> = {
  charcoal: 'log',
  iron_ingot: 'raw_iron',
  gold_ingot: 'raw_gold',
  copper_ingot: 'raw_copper',
}

/**
 * Refuse a plan whose FIRST goal is a `smelt` with no held input (issue #29
 * analogue for Mercury): the queue would wedge on a smelt candidate that cannot
 * exist. The goal is replaced with collecting its input, which the executor can
 * ground. Pure and exported so the refusal rule is testable without a bot.
 */
export function groundMercuryPlan(
  plan: MercuryPlanJson,
  state: Pick<MercuryStateSummary, 'inventory'>,
): { plan: MercuryPlanJson; refused: { goal: string; replacement: string; reason: string } | null } {
  const first = plan.goals[0]
  if (first === undefined) return { plan, refused: null }
  const firstKind = first.kind ?? mercuryGoalKind(first.item ?? '')
  if (firstKind !== 'smelt') return { plan, refused: null }
  const item = first.item
  if (typeof item !== 'string') return { plan, refused: null }
  const input = MERCURY_SMELT_INPUTS[item]
  if (input === undefined) return { plan, refused: null }
  if ((state.inventory[input] ?? 0) > 0) return { plan, refused: null }
  if (!(MERCURY_ALLOWED_GOALS.collect as readonly string[]).includes(input)) return { plan, refused: null }
  const count = first.count ?? 1
  return {
    // Keep the selected smelt Option. The Option compiler / grounded skills
    // materialise the missing input as a prerequisite underneath it; replacing
    // the semantic parent here was the source of item-centric identity loss.
    plan,
    refused: {
      goal: `smelt ${item}`,
      replacement: `collect ${input}`,
      reason: `no ${input} held to smelt ${item}`,
    },
  }
}

/** State-dependent grounding that keeps model-selected recovery semantic while
 * requiring the resident host to own the actual death coordinate. */
export function validateMercuryPlanAgainstState(
  plan: MercuryPlanJson,
  state: Pick<MercuryStateSummary, 'dimension' | 'postDeath' | 'portal'>,
): string | null {
  for (let index = 0; index < plan.goals.length; index += 1) {
    const goal = plan.goals[index]
    if (goal?.kind === 'enter_portal') {
      if (state.portal?.verified !== true) {
        return `goal[${index}] enter_portal unavailable: no live verified portal`
      }
      continue
    }
    if (goal?.kind !== 'recover_death_site') continue
    const postDeath = state.postDeath ?? null
    if (postDeath?.latestDeathPoint === null || postDeath?.latestDeathPoint === undefined) {
      return `goal[${index}] recover_death_site unavailable: no latest death point`
    }
    const liveDimension = state.dimension ?? ''
    if (postDeath.dimension.replace(/^minecraft:/, '') !== liveDimension.replace(/^minecraft:/, '')) {
      return `goal[${index}] recover_death_site unavailable: death dimension ${postDeath.dimension} != live ${liveDimension}`
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// #468 install-time executability: is the installed WHAT EXECUTABLE in this state?
// ---------------------------------------------------------------------------
//
// `validateMercuryPlanAgainstState` above answers ADMISSIBILITY - may this goal
// exist at all (is the gate live, is there a death point). It never asks whether
// the BODY can execute it here, now. Measured live: the body stood 12 blocks
// ABOVE the portal interior and the affordance gate had already typed the
// refusal -
//   CANDIDATE_WITHHELD reason=needs_descend candidate=ENTER:26,79,-4
//     missing=["descend_plan:no_support@27,78,-4:air"]
// - so ENTER was not executable, yet the cached answer
// `mercury_patch_enter_portal_goal` ("gate verified, so enter instead of a
// blocked descent") passed admissibility, was re-installed, and the very next
// tick refused it as `action_impossible`.
//
// The executable-here fact is ALREADY in hand and is not re-derived here:
// `MercuryStateSummary.blockers` (== `System2PlanRequest.blockers`,
// `System2BlockerFacts`) is the tick's typed refusal projection - one entry per
// withheld candidate with `{candidate, kind, reason, missing, suppressed}` - it
// is already part of the cache KEY (`hashMercuryState`), and it needs no live bot
// and no geometry. `reconcileNotExecutableHead`/`ROW_NOT_EXECUTABLE_HERE` cannot
// serve here: that verdict is dimension-only, and the transfer-row exemption
// (`isDimensionTransferGoal`) deliberately excludes exactly the portal-entry row
// this defect is about.
//
// Three outcomes, in the existing tri-state shape (`PredicateTruth` in
// `optionSpec.ts`); `unknown` is first-class and never collapsed:
//
//   executable          the state measured refusals and none refuses this goal's
//                       executor -> install exactly as today, byte-identical
//   not_executable_now  the state's typed withheld fact refuses that executor ->
//                       typed + mirrored refusal naming goal/blocker/provenance,
//                       no install, ordinary replan path takes over
//   unknown             no grounded verdict (this tick measured no refusal, or
//                       code owns no exclusive executor mapping for the goal) ->
//                       neither "install as verified" nor "refuse"
//
// UNKNOWN must not refuse: an ordinary summon carries no `blockers` field at all
// (`system2Payload.ts` returns null when nothing was withheld), so reading "no
// evidence" as "not executable" would empty the cache. It equally must not be
// reported as executable-verified: that would be the silent apply this closes.

/** The three outcomes. A verdict, never a boolean: `unknown` is first-class. */
export type MercuryPlanExecutability = 'executable' | 'not_executable_now' | 'unknown'

/** Mirrored marker for the verdict itself; emitted for all three outcomes. */
export const MERCURY_PLAN_EXECUTABILITY_MARKER = 'MERCURY_PLAN_EXECUTABILITY'
/** Mirrored marker for one refused goal; names the goal, its blocker and the provenance. */
export const MERCURY_PLAN_NOT_EXECUTABLE_MARKER = 'MERCURY_PLAN_NOT_EXECUTABLE'
/**
 * `System2PlanProvenance.noGoalsReason` of the typed zero-goal hand-off a refusal
 * returns, so the queue-side line already in place (`SYSTEM2_PLAN_NO_GOALS
 * reason=...`) names the same fact instead of reporting a generic empty answer.
 */
export const MERCURY_PLAN_NOT_EXECUTABLE_NO_GOALS_REASON = 'plan_not_executable_now'

/** One goal whose executor the state's typed withheld facts refuse, verbatim. */
export interface MercuryPlanGoalRefusal {
  index: number
  /** compact `kind:target:count` goal key (`goalKeyOf`) - the named goal */
  goal: string
  /** the withheld candidate id, verbatim (`ENTER:26,79,-4`) */
  candidate: string
  /** the withheld candidate's class, verbatim (`ENTER_PORTAL`) */
  candidateKind: string
  /** the withheld typed reason, verbatim (`needs_descend`) */
  reason: string
  /** the withheld typed missing capability keys, verbatim (`descend_plan:no_support@...`) */
  missing: string[]
}

export interface MercuryPlanExecutabilityVerdict {
  verdict: MercuryPlanExecutability
  /** Plan-ordered; empty unless `verdict === 'not_executable_now'`. */
  refusals: MercuryPlanGoalRefusal[]
  /** Typed reason the verdict is `unknown`; `null` for a grounded verdict. */
  unknownReason: string | null
}

/**
 * The only part of a typed blocker projection an executability verdict reads: one
 * entry per WITHHELD candidate. Both projections that carry it satisfy this -
 * `System2PlanRequest.blockers` (`System2BlockerFacts`) and
 * `MercuryStateSummary.blockers` - so neither call site has to reshape the fact.
 */
export interface MercuryExecutabilityBlockerFacts {
  withheld: readonly Pick<System2WithheldCandidate, 'candidate' | 'kind' | 'reason' | 'missing'>[]
}

/**
 * The candidate classes that can EXECUTE a compiled plan goal, derived from the
 * SAME gate the grounded candidate generators use. `null` = code owns no
 * exclusive executor mapping for this goal, which makes its executability
 * UNKNOWN - never "not executable".
 *
 * ONLY exclusive mappings belong here. A goal several candidate classes can serve
 * (a `collect` count can rise through RETRIEVE, MINE, PICKUP, CRAFT, SMELT,
 * CONTAINER or ATTACK) must return `null`: one withheld candidate does not prove
 * that goal cannot run, and refusing on it would make the cache unusable.
 */
export function goalExecutorCandidateKinds(goal: PlannedGoal): readonly string[] | null {
  // `entryCandidates` generates nothing whose `targetPredicate` is not
  // PORTAL_ENTERED_PREDICATE (jev-agent/src/candidates.ts), so a portal-entered
  // `place nether_portal` goal - the lowering of the model's `enter_portal` - has
  // exactly one executor class.
  if (goal.targetPredicate === PORTAL_ENTERED_PREDICATE) return ['ENTER_PORTAL']
  // `ignitionCandidates` accepts only the lit predicate on a `nether_portal` row
  // and is the only IGNITE generator.
  if (goal.targetPredicate === PORTAL_LIT_PREDICATE && goal.targetItem === NETHER_PORTAL) return ['IGNITE']
  return null
}

/**
 * Classify a plan's EXECUTABILITY in the state it is about to be installed into.
 * Pure: same facts in, same verdict out.
 *
 * `blockers` is the tick's typed refusal projection. Its ABSENCE is not evidence
 * of anything - no refusal was measured - so the verdict is `unknown` and nothing
 * is refused.
 */
export function classifyMercuryPlanExecutability(
  goals: readonly PlannedGoal[],
  blockers: MercuryExecutabilityBlockerFacts | null | undefined,
): MercuryPlanExecutabilityVerdict {
  // Nothing has to execute, so nothing can be not-executable here: an
  // `abort`/`complete` answer and a plan that compiled to no row keep their
  // existing outcome.
  if (goals.length === 0) return { verdict: 'executable', refusals: [], unknownReason: null }
  if (blockers === undefined || blockers === null) {
    return { verdict: 'unknown', refusals: [], unknownReason: 'no_blocker_facts_in_state' }
  }
  const withheld = blockers.withheld ?? []
  const refusals: MercuryPlanGoalRefusal[] = []
  let unmapped: string | null = null
  goals.forEach((goal, index) => {
    const kinds = goalExecutorCandidateKinds(goal)
    if (kinds === null) {
      unmapped ??= goalKeyOf(goal)
      return
    }
    for (const entry of withheld) {
      if (!kinds.includes(entry.kind)) continue
      refusals.push({
        index,
        goal: goalKeyOf(goal),
        candidate: entry.candidate,
        candidateKind: entry.kind,
        reason: entry.reason,
        missing: [...entry.missing],
      })
    }
  })
  if (refusals.length > 0) return { verdict: 'not_executable_now', refusals, unknownReason: null }
  if (unmapped !== null) {
    return { verdict: 'unknown', refusals: [], unknownReason: `no_executor_mapping_for_goal:${unmapped}` }
  }
  return { verdict: 'executable', refusals: [], unknownReason: null }
}

/** The mirrored verdict line. Emitted for all three outcomes so `unknown` is visible. */
export function formatMercuryPlanExecutability(
  result: MercuryPlanExecutabilityVerdict,
  context: { intentSource: string; trigger: string; goals: number; strategy?: string },
): string {
  return (
    `${MERCURY_PLAN_EXECUTABILITY_MARKER} verdict=${result.verdict} intentSource=${context.intentSource}` +
    ` trigger=${context.trigger} goals=${context.goals}` +
    (context.strategy === undefined ? '' : ` strategy=${context.strategy}`) +
    ` refusals=${result.refusals.length}` +
    (result.unknownReason === null ? '' : ` unknownReason=${result.unknownReason}`)
  )
}

/**
 * The mirrored refusal line: the goal, the fact that blocks it (verbatim reason,
 * missing capability keys, and the exact withheld candidate), and where the plan
 * came from (`cached` for a replay, `continued` for the planner's memo).
 */
export function formatMercuryPlanNotExecutable(refusal: MercuryPlanGoalRefusal, intentSource: string): string {
  return (
    `${MERCURY_PLAN_NOT_EXECUTABLE_MARKER} intentSource=${intentSource} index=${refusal.index}` +
    ` goal=${refusal.goal} candidate=${refusal.candidate} candidateKind=${refusal.candidateKind}` +
    ` reason=${refusal.reason} missing=[${refusal.missing.join(',')}] action=refused`
  )
}

interface MercuryExecutabilityLogContext {
  intentSource: string
  trigger: string
  strategy: string
  stateHash: string
  callId?: string
}

/** The shared install-time boundary for newly generated plans and cache replays. */
function evaluateAndLogMercuryPlanExecutability(
  log: MercurySystem2Options['log'],
  goals: readonly PlannedGoal[],
  blockers: MercuryExecutabilityBlockerFacts | null | undefined,
  context: MercuryExecutabilityLogContext,
): MercuryPlanExecutabilityVerdict {
  const verdict = classifyMercuryPlanExecutability(goals, blockers)
  log(formatMercuryPlanExecutability(verdict, {
    intentSource: context.intentSource,
    trigger: context.trigger,
    goals: goals.length,
    strategy: context.strategy,
  }), {
    ...verdict,
    strategy: context.strategy,
    stateHash: context.stateHash,
    ...(context.callId === undefined ? {} : { callId: context.callId }),
  })
  if (verdict.verdict === 'not_executable_now') {
    for (const refusal of verdict.refusals) {
      log(formatMercuryPlanNotExecutable(refusal, context.intentSource), {
        ...refusal,
        strategy: context.strategy,
        stateHash: context.stateHash,
        trigger: context.trigger,
        withheld: blockers?.withheld ?? [],
        ...(context.callId === undefined ? {} : { callId: context.callId }),
      })
    }
  }
  return verdict
}

/** Stable cache key for a Mercury state summary. Exported so tests can seed the cache. */
export function hashMercuryState(state: MercuryStateSummary, identity: MercuryCacheIdentity = mercuryCacheIdentity()): string {
  const allowedGoals = {
    collect: [...state.allowedGoals.collect].sort(),
    craft: [...state.allowedGoals.craft].sort(),
    smelt: [...state.allowedGoals.smelt].sort(),
    place: [...(state.allowedGoals.place ?? [])].sort(),
    goto_resources: [...(state.allowedGoals.goto_resources ?? [])].sort(),
    explore_modes: [...(state.allowedGoals.explore_modes ?? [])].sort(),
  }
  const payload = {
    worldKey: identity.worldKey,
    worldEpoch: identity.worldEpoch,
    schemaVersion: identity.schemaVersion,
    humanMission: state.humanMission,
    trigger: state.trigger,
    wakeReason: state.wakeReason,
    wakeDetail: state.wakeDetail,
    position: state.position,
    dimension: state.dimension,
    health: state.health,
    food: state.food ?? null,
    starvation: state.starvation ?? null,
    inventory: state.inventory,
    toolRank: state.toolRank,
    stations: state.stations,
    portal: state.portal ?? null,
    ores: [...state.knownOres].sort(),
    queue: state.queue,
    objective: state.objective,
    frontierOpportunity: state.frontierOpportunity ?? null,
    wait: Math.min(state.consecutiveWait, 3),
    failures: state.recentFailures,
    semanticOutcomes: state.recentSemanticOutcomes ?? [],
    deathHistory: state.deathHistory,
    deathHistoryTotal: state.deathHistoryTotal ?? state.deathHistory.length,
    postDeath: state.postDeath ?? null,
    allowedGoals,
    // The typed blocker + grounded-alternative facts are part of the KEY, not
    // decoration: two summons whose blockers differ must not replay one
    // another's answer (#33 - a cache hit must replay an attributable decision,
    // and a decision made for "the route is refused with `headroom@x,y,z`
    // missing" is not attributable to "the plan is wrong"). `withheldTotal`/
    // `presentedTotal` are included so a clamped list cannot collide with a
    // complete one at the same kept length.
    blockers: state.blockers ?? null,
    alternatives: state.alternatives ?? null,
  }
  return createHash('sha1').update(JSON.stringify(payload)).digest('hex').slice(0, 16)
}

/**
 * The MODEL-CALL plane mirror of the summon payload's shape.
 *
 * Derived from the very object serialised into the prompt, so a call record
 * attests to what the model was given instead of to what the builder intended.
 * Defensive by construction: an old/replayed/fixture state carries no typed
 * blocker fields, and then every count is zero and `attached` is false.
 */
export function mercuryPayloadShape(state: unknown): System2PayloadShape {
  const record = (state ?? {}) as { blockers?: unknown; alternatives?: unknown }
  const blockers = (record.blockers ?? null) as MercuryStateSummary['blockers'] | null
  const alternatives = (record.alternatives ?? null) as MercuryStateSummary['alternatives'] | null
  return {
    attached: blockers !== null || alternatives !== null,
    withheld: blockers?.withheld.length ?? 0,
    withheldTotal: blockers?.withheldTotal ?? 0,
    presented: alternatives?.presented.length ?? 0,
    presentedTotal: alternatives?.presentedTotal ?? 0,
    unmetTools: blockers?.tools.unmet.length ?? 0,
    missing: blockers?.missing.length ?? 0,
    acquisitionRoutes: (blockers?.withheld ?? []).reduce(
      (total, entry) => total + (entry.acquisition ?? []).reduce((n, fact) => n + fact.routes.length, 0),
      0,
    ),
    acquisitionRefused: (blockers?.withheld ?? []).reduce(
      (total, entry) => total + (entry.acquisition ?? []).filter((fact) => fact.routes.length === 0).length,
      0,
    ),
    blockedBy: blockers?.blockedBy !== undefined,
    routes: alternatives?.routes !== undefined,
    chars: JSON.stringify({ blockers, alternatives }).length,
    refused: [],
    absent: blockers === null ? ['blockers'] : [],
  }
}

/**
 * Bound on the death-hazard facts carried in one summon payload. The operator's
 * rule is that the state is not a giant log; a durable hazard memory grows for
 * the life of the world, so only the most recent facts are carried and the
 * pre-clamp count is reported beside them.
 */
export const MERCURY_DEATH_HISTORY_LIMIT = 8

/** A compact, human-readable strategy label for the ADVISOR log. */
export function mercuryStrategyLabel(plan: MercuryPlanJson): string {
  const primary = plan.goals[0]
  if (primary === undefined) return `mercury_${plan.op}`
  if (primary.kind !== undefined) {
    const target = primary.item ?? primary.mode ?? (primary.y !== undefined ? `y${primary.y}` : 'goal')
    return `mercury_${plan.op}_${primary.kind}_${target}`
  }
  const kind = mercuryGoalKind(primary.item ?? '') ?? 'goal'
  return `mercury_${plan.op}_${kind}_${primary.item ?? 'goal'}`
}

// ---------------------------------------------------------------------------
// explicit opt-in (never triggered by key presence)
// ---------------------------------------------------------------------------

export interface MercuryConfigFile {
  system2?: boolean
  /** Legacy compatibility key from the old Mercury-only adapter. */
  mercury?: boolean
  /** Explicit System2 transport/backend profile. */
  provider?: string
  /** Concrete System2 model id for the selected backend. */
  model?: string
}

export function readMercuryConfig(configPath: string): MercuryConfigFile | null {
  try {
    if (!existsSync(configPath)) return null
    return JSON.parse(readFileSync(configPath, 'utf8')) as MercuryConfigFile
  } catch {
    return null
  }
}

export interface MercuryEnablement {
  enabled: boolean
  source: string
}

/**
 * Resolve whether the sparse System2 gateway is enabled. Precedence:
 *   1. BUDDY_SYSTEM2=off|none|fallback|deterministic -> disabled
 *   2. BUDDY_SYSTEM2=on|llm|system2|muse             -> enabled
 *   3. config file { "system2": true }              -> enabled
 *   4. legacy `mercury` env/config spellings remain accepted for compatibility
 * The Gateway key is NEVER consulted here.
 */
export function resolveMercuryEnablement(
  plannerMode: 'llm' | 'deterministic' | 'local-mercury',
  configPath: string,
): MercuryEnablement {
  const raw = (process.env.BUDDY_SYSTEM2 ?? '').trim().toLowerCase()
  if (raw === 'off' || raw === 'none' || raw === 'fallback' || raw === 'deterministic') {
    return { enabled: false, source: 'env:BUDDY_SYSTEM2=off' }
  }
  const explicitOn = raw === 'on' || raw === 'llm' || raw === 'system2' || raw === 'muse' || raw === 'mercury'
  let configured = explicitOn
  if (!configured) {
    try {
      const parsed = readMercuryConfig(configPath)
      if (parsed !== null) configured = parsed.system2 === true || parsed.mercury === true
    } catch {
      configured = false
    }
  }
  if (!configured) return { enabled: false, source: 'default-off' }
  if (plannerMode === 'deterministic') return { enabled: false, source: 'deterministic-planner-override' }
  return { enabled: true, source: explicitOn ? `env:BUDDY_SYSTEM2=${raw}` : `config:${configPath}` }
}

// ---------------------------------------------------------------------------
// compressed state summary
// ---------------------------------------------------------------------------

export const SYSTEM2_HUMAN_MISSION = 'Defeat the Ender Dragon' as const

/** A code-computed, live recipe opportunity. It informs System2 without selecting WHAT. */
export interface MercuryFrontierOpportunity {
  targetItem: string
  targetCount: number
  description: string
  firstStep: { type: 'craft'; item: string; count: number } | { type: 'place'; item: 'crafting_table' }
}

export interface MercuryStateSummary {
  /** Human-provided long-horizon objective; benchmark gates are not planner inputs. */
  humanMission: typeof SYSTEM2_HUMAN_MISSION
  trigger: MercuryTriggerReason
  wakeReason: string
  wakeDetail: string
  position: { x: number; y: number; z: number } | null
  dimension: string | null
  health: number | null
  /** Live food level and code-owned starvation truth; absent only in old fixtures. */
  food?: number | null
  starvation?: string | null
  toolRank: number
  inventory: Record<string, number>
  stations: { craftingTables: number; furnaces: number }
  /** Live portal truth projected for System2; never durable as a verdict. */
  portal?: { verified: boolean; knownSites: number }
  knownOres: string[]
  recentFailures: string[]
  /** Bounded causal history linking earlier System2 WHAT choices to outcomes. */
  recentSemanticOutcomes?: System2SemanticOutcome[]
  consecutiveWait: number
  queue: { depth: number; done: number; current: string | null; hasImpossible: boolean }
  /**
   * Current item-counted queue objective. Null means there is no active local
   * item goal; the legacy request objective is deliberately not projected here
   * because it may only be a compatibility seed after the queue is empty.
   */
  objective: { targetItem: string; requiredCount: number; haveCount: number; complete: boolean } | null
  /** Current unsatisfied capability's first directly executable craft step, when one exists. */
  frontierOpportunity?: MercuryFrontierOpportunity
  /**
   * The most recent durable death-hazard facts, NEWEST FIRST, bounded by
   * `MERCURY_DEATH_HISTORY_LIMIT`. This is world memory, not a log: it is the
   * largest field in the live payload when unbounded (measured 1098 chars /
   * 57 entries of a 3549-char payload), and it grows for the life of the world,
   * so it is clamped like every other list the model is given.
   */
  deathHistory: string[]
  /**
   * Pre-clamp hazard count, so a truncated history is never read as complete.
   * Optional for the same reason `portal`/`postDeath` are: fixtures and replayed
   * records written before the bound exist, and their `deathHistory` is already
   * complete, so the length IS the total.
   */
  deathHistoryTotal?: number
  postDeath?: {
    latestDeathPoint: { x: number; y: number; z: number } | null
    dimension: string
    cause: string
    lostInventory: Record<string, number>
    itemsLost: number
    nearbyHostiles: Array<{ name: string; distance: number }>
    recentDeathCount: number
    recentDeathWindowSec: number
    recoveryChoices: readonly ['recover_death_site', 'rebuild_equipment', 'leave_danger_area']
  } | null
  allowedGoals: {
    collect: string[]
    craft: string[]
    smelt: string[]
    place?: string[]
    goto_resources?: string[]
    explore_modes?: string[]
  }
  /**
   * Typed BLOCKERS: which grounded actions the body cannot take, the typed
   * reason for each refusal, the capability keys that are missing, and the tool
   * truth behind a named tool requirement. Bounded by `SYSTEM2_PAYLOAD_LIMITS`;
   * `withheldTotal`/`presentedTotal` report the pre-clamp counts so a truncated
   * list is never mistaken for a complete one.
   *
   * Present only when the summoning tick established a refusal. An ordinary
   * summon carries no `blockers` field at all, so its payload is unchanged.
   */
  blockers?: {
    blockedBy?: string
    missing: string[]
    repeats?: { count: number; bound: number }
    withheld: Array<{
      candidate: string
      kind: string
      reason: string
      missing: string[]
      suppressed: boolean
      /** grounded acquisition routes per missing fact, or its typed refusal */
      acquisition?: Array<{
        missing: string
        routes: string[]
        reason: string | null
        item: string | null
        count: number | null
        held: number | null
        tools: string
      }>
    }>
    withheldTotal: number
    tools: {
      held: Array<{ tool: string; tier: number }>
      unmet: Array<{ tool: string; requiredTier: number; heldTier: number; candidate: string }>
    }
  }
  /**
   * Typed GROUNDED ALTERNATIVES: the candidates the body DID present this tick,
   * plus the durable world-memory route counts. This is the other half of the
   * blocker fact - "X is refused" is only actionable next to "Y was offered".
   */
  alternatives?: {
    presented: Array<{ candidate: string; kind: string }>
    presentedTotal: number
    routes?: { knownResources: number; traversalsOk: number; traversalsBlocked: number }
  }
}

// ---------------------------------------------------------------------------
// pricing (gateway rates, USD per token; fallback = unknown -> 0)
// ---------------------------------------------------------------------------

interface ModelPrice {
  input: number
  output: number
}

export const MERCURY_PRICES: Readonly<Record<string, ModelPrice>> = {
  // The live semantic layer model. Without this entry `mercuryCostUsd` returned 0 for
  // every live call, so run artifacts recorded no cost at all for the model that is
  // actually in use. Prices are the gateway catalog values (USD per token).
  'meta/muse-spark-1.3-contributor': { input: 0.0000001, output: 0.0000002 },
  'meta/muse-spark-1.2': { input: 0.00000125, output: 0.00000425 },
  'meta/muse-spark-1.1': { input: 0.00000125, output: 0.00000425 },
  // Historical ids kept so old call records still price correctly.
  'inception/mercury-2.5': { input: 0.00000004, output: 0.00000015 },
  'inception/mercury-2': { input: 0.00000025, output: 0.00000075 },
}

export interface MercuryUsageLike {
  inputTokens?: number | null
  outputTokens?: number | null
}

export function mercuryCostUsd(model: string, usage: MercuryUsageLike | null | undefined): number {
  const price = MERCURY_PRICES[model]
  if (price === undefined || usage == null) return 0
  const input = usage.inputTokens ?? 0
  const output = usage.outputTokens ?? 0
  return input * price.input + output * price.output
}

// ---------------------------------------------------------------------------
// durable cache + hourly budget
// ---------------------------------------------------------------------------

/** #33: Mercury cache schema/contract version. Bump when the summary contract changes. */
export const MERCURY_CACHE_SCHEMA_VERSION = 9
export const MERCURY_CACHE_FILE_VERSION = 9

export interface MercuryWorldKey {
  serverId: string
  dimension: string
  worldEpoch: number
}

export function mercuryWorldKeyString(key: MercuryWorldKey): string {
  return `${key.serverId}|${key.dimension}|${key.worldEpoch}`
}

export interface MercuryCacheIdentity {
  worldKey: string
  worldEpoch: number
  schemaVersion: number
}

export const DEFAULT_MERCURY_WORLD_KEY: MercuryWorldKey = { serverId: 'local', dimension: 'unknown', worldEpoch: 0 }

export function mercuryCacheIdentity(worldKey: MercuryWorldKey = DEFAULT_MERCURY_WORLD_KEY): MercuryCacheIdentity {
  return {
    worldKey: mercuryWorldKeyString(worldKey),
    worldEpoch: worldKey.worldEpoch,
    schemaVersion: MERCURY_CACHE_SCHEMA_VERSION,
  }
}

interface MercuryCacheEntry {
  op: PlanOp
  goals: MercuryPlanGoalJson[]
  reason: string
  strategy: string
  costUsd: number
  ts: number
  worldKey: string
  schemaVersion: number
  /** How many times this cached plan has been replayed without body progress. */
  replays?: number
}

interface MercuryCacheFile {
  version: typeof MERCURY_CACHE_FILE_VERSION
  /** #33 semantic namespace identity; any mismatch invalidates the whole file. */
  worldKey: string
  worldEpoch: number
  schemaVersion: number
  entries: Record<string, MercuryCacheEntry>
  callTimes: number[]
  consecutiveStrategy?: string | null
  consecutiveCount?: number
  /**
   * Durable `wait_limit` trigger backoff. Persisted in the same file as the
   * call-time budget ON PURPOSE: the measured burn happened across repeated
   * generation restarts, so an in-memory-only guard would reset with the
   * process and re-burn the window. Optional so a pre-existing version-3 cache
   * still loads (the budget `callTimes` must never be silently refilled).
   */
  triggerBackoff?: MercuryWaitLimitBackoffState | null
}

const MAX_CACHE_ENTRIES = 60
const HOUR_MS = 60 * 60 * 1000
const REMOTE_MERCURY_MAX_PER_HOUR_DEFAULT = 20
export const LOCAL_MERCURY_MAX_PER_HOUR_DEFAULT = 1_000_000
/** A cached plan may be replayed at most this many times before it is bypassed. */
export const MAX_CACHE_REPLAYS = 2
/** Consecutive cached plans with the same strategy before the cache is bypassed. */
export const MAX_CONSECUTIVE_CACHED = 2

function emptyCache(identity: MercuryCacheIdentity): MercuryCacheFile {
  return {
    version: MERCURY_CACHE_FILE_VERSION,
    worldKey: identity.worldKey,
    worldEpoch: identity.worldEpoch,
    schemaVersion: identity.schemaVersion,
    entries: {},
    callTimes: [],
    consecutiveStrategy: null,
    consecutiveCount: 0,
    triggerBackoff: null,
  }
}

/** Validate the durable wait_limit backoff record; anything malformed is dropped. */
function parseTriggerBackoff(value: unknown): MercuryWaitLimitBackoffState | null {
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (typeof record.stallKey !== 'string' || record.stallKey.length === 0) return null
  if (typeof record.consultations !== 'number' || !Number.isFinite(record.consultations) || record.consultations < 0) {
    return null
  }
  if (typeof record.lastAt !== 'number' || !Number.isFinite(record.lastAt)) return null
  if (typeof record.lastWaitStreak !== 'number' || !Number.isFinite(record.lastWaitStreak)) return null
  const lastAuthorityEpoch =
    typeof record.lastAuthorityEpoch === 'number' && Number.isFinite(record.lastAuthorityEpoch)
      ? record.lastAuthorityEpoch
      : null
  return {
    stallKey: record.stallKey,
    consultations: Math.floor(record.consultations),
    lastAt: record.lastAt,
    lastWaitStreak: record.lastWaitStreak,
    lastAuthorityEpoch,
  }
}

// ---------------------------------------------------------------------------
// call log (auditable, same schema family as jev-calls.jsonl)
// ---------------------------------------------------------------------------

export interface MercuryCallRecord {
  record: 'mercury-call'
  callId: string
  ts: string
  provider?: string
  model: string
  generationId?: string | null
  sourceSha?: string | null
  buildHash?: string | null
  stage: MercuryTriggerReason
  latencyMs: number
  attempts: number
  failures: number
  retries: number
  /** 1-based index of the attempt this record describes (retry audit trail). */
  attempt?: number
  // NOTE: our main added the typed `ungrounded` outcome (an NL answer that grounds
  // onto nothing is a valid model answer, not an error); the fork added
  // `stale_discarded` for a result from a generation that is no longer current.
  // Both are real outcomes, so the union keeps both contracts.
  outcome: 'success' | 'plan_rejected' | 'fallback' | 'budget_exhausted' | 'ungrounded' | 'stale_discarded'
  state: unknown
  prompt: { system: string; user: string }
  response: unknown
  usage: unknown
  cost: number
  error: string | null
  /** Full structured error (name, message, statusCode, responseBody, cause chain). */
  errorDetail?: unknown
  /**
   * The model's natural-language WHAT, verbatim. Always recorded when a call
   * reached the model, whether or not it grounded - the language is the plan's
   * intent, so it must survive even when no goal could be grounded.
   */
  intent?: string
  /** raw assistant text (identical to `intent` for json-text; kept explicit for audit). */
  rawText?: string
  /** how the goals were obtained: structured enrichment, grounded prose, or none. */
  intentSource?: 'enrichment' | 'intent' | 'ungrounded' | 'cached'
  /** Install-time executability evidence for a fresh provider proposal. */
  executability?: MercuryPlanExecutabilityVerdict
  /**
   * The MODEL-CALL plane mirror of the summon payload's shape: what the compact
   * state actually carried, derived from the very object that was serialised
   * into the prompt. Written by `writeCall`, so every call record - success,
   * rejection, budget exhaustion - attests to the state the model was given.
   */
  payloadShape?: System2PayloadShape
}

// ---------------------------------------------------------------------------
// the brain
// ---------------------------------------------------------------------------

export interface MercuryRepairResult {
  plan: System2Plan
  strategy: string
  op: PlanOp
  goals: PlannedGoal[]
  costUsd: number
  ms: number
  cached: boolean
  /**
   * Set when the model answered (in language) but the answer could not be
   * grounded onto the capability matrix. `plan.goals` is empty. The caller must
   * leave WHAT to the next layer (the typed option question) rather than treating
   * this as model unavailability and terminating the resident.
   */
  ungrounded?: { intent: string; reason: string }
}

/**
 * One attempt's result. A natural-language answer that grounds nothing is a
 * SUCCESSFUL attempt carrying `ungrounded`: it is not a schema rejection and
 * must not consume a corrective retry.
 */
interface MercuryAttemptSuccess {
  plan: MercuryPlanJson
  usage: unknown
  prompt: string
  intent: string
  rawText: string
  intentSource: 'enrichment' | 'intent' | 'ungrounded'
  droppedKeys: readonly string[]
  renamedKeys: readonly string[]
  matched: readonly string[]
  /**
   * #system2-compile: the typed reason a STRUCTURED block inside this answer was
   * unusable (`null` when the answer carried no block, or when its block was
   * used). Present so the queue-side hand-off can name the rejection instead of
   * reporting a generic "no goals".
   */
  rejectedBlock?: { stage: string; path: string; expected: string } | null
}

export interface MercurySystem2Options {
  /** compressed-summary builder; injected so this module never imports planner.ts. */
  summarize: (request: System2PlanRequest, trigger: MercuryTriggerReason) => MercuryStateSummary
  log: (event: string, detail?: Record<string, unknown>) => void
  /** absolute path to logs/jev/mercury-calls.jsonl */
  callsPath: string
  /** absolute path to the durable state-hash cache / hourly budget file. */
  cachePath: string
  /** #33: world identity (serverId|dimension|worldEpoch) namespacing the cache. */
  worldKey?: MercuryWorldKey
  model?: string
  maxPerHour?: number
  timeoutMs?: number
  /**
   * Bounded backoff for the counter-shaped `wait_limit` trigger: base wait
   * before the 2nd consecutive consultation on one unchanged stall, doubling
   * up to `waitLimitBackoffMaxMs`. Keeps per-provider-call budget accounting
   * intact while stopping a single stall from spending the window linearly.
   */
  waitLimitBackoffBaseMs?: number
  waitLimitBackoffMaxMs?: number
  /** Extra attempts after a timeout/abort (1 = one retry). */
  retries?: number
  maxOutputTokens?: number
  /** resident process terminator; absent in tests (the fatal error is thrown) */
  terminate?: () => never
  /** exact git source/build identity for the generation owning these calls. */
  sourceSha?: string | null
  buildHash?: string | null
  /** key resolver seam for tests; defaults to `resolveJevApiKey` */
  resolveKey?: () => KeyResolution | null
  /** true when this generation was created fresh because the bot died. */
  postDeathRecovery?: boolean
  /** generation-lifecycle guard; false means the answer is stale and must never be applied. */
  isCurrent?: () => boolean
  /** optional generation id for stale-discard audit lines. */
  generationId?: string
  /** bypass durable cached plans during same-authority provider recovery. */
  requireFreshProviderDecision?: boolean
  /** transport seam for tests; defaults to the selected provider transport. */
  transport?: MercuryTransport
  /** System2 config path; lets the generation use the same config used for enablement. */
  configPath?: string
  /**
   * OpenAI-compatible endpoint seam. `undefined` resolves the configured provider
   * profile (OpenCode Go first, then BUDDY_MERCURY_BASE_URL); explicit null forces
   * the historical AI Gateway path.
   */
  localEndpoint?: MercuryLocalEndpoint | null
}

export interface MercuryTransportRequest {
  readonly system: string
  readonly prompt: string
  readonly maxOutputTokens: number
  readonly timeoutMs: number
  /** Generation-scoped signal; transports combine it with the per-attempt timeout. */
  readonly signal?: AbortSignal
}

export interface MercuryTransportToolCall {
  readonly input: unknown
}

export interface MercuryTransportResult {
  readonly toolCalls: readonly MercuryTransportToolCall[]
  readonly usage: unknown
  /**
   * The model's raw assistant text, verbatim. This is the natural-language WHAT
   * and is what the plan record carries as `MERCURY_INTENT`; it is evidence, not
   * a contract, so an empty string is a legitimate (typed) outcome.
   */
  readonly text?: string
  /**
   * Transport-level shape repairs applied while obtaining the tool call
   * (json-text path only). Reported so `MERCURY_JSON_TEXT_REPAIRED` /
   * `MERCURY_JSON_TEXT_UNPARSED` make the recovery observable instead of silent.
   */
  readonly repairs?: readonly MercuryTransportRepair[]
}

export interface MercuryTransportRepair {
  readonly kind: 'json-text'
  readonly shape: MercuryJsonTextShape
  readonly objects: number
  readonly chars: number
}

export type MercuryTransport = (request: MercuryTransportRequest) => Promise<MercuryTransportResult>

/**
 * Some gateway models accept the AI SDK tool schema but reject a named
 * `tool_choice`.  Keep their compatibility path explicit: the model still
 * emits only a high-level plan, and the exact same local schema/capability
 * validation remains authoritative after transport parsing.
 */
export const MUSE_SPARK_MODEL = SYSTEM2_MODEL_DEFAULT
/** Generic sparse-System2 provider timeout; not model-specific. */
export const SYSTEM2_TIMEOUT_DEFAULT_MS = 60_000

/**
 * Model ids arrive either bare (`muse-spark-1.3-contributor`) or with the
 * gateway provider prefix (`meta/muse-spark-1.3-contributor`). The live config
 * uses the prefixed form, so an exact-string comparison silently sent muse down
 * the forced tool-choice path — which it rejects
 * (`GatewayInternalServerError: only "auto" is supported for tool_choice`), so
 * every Mercury consultation failed 3/3 and the resident terminated fail-loud.
 */
export function isMuseSparkModel(model: string): boolean {
  const id = model.trim().toLowerCase()
  const leaf = 'muse-spark-1.3-contributor'
  return id === MUSE_SPARK_MODEL || id === leaf || id.endsWith(`/${leaf}`)
}

export type MercuryTransportMode = 'tool-call' | 'json-text'

export function mercuryTransportMode(model: string): MercuryTransportMode {
  return isMuseSparkModel(model) ? 'json-text' : 'tool-call'
}

// ---------------------------------------------------------------------------
// local OpenAI-compatible endpoint (llama.cpp / Ollama / vLLM)
// ---------------------------------------------------------------------------

export const MERCURY_LOCAL_BASE_URL_ENV = 'BUDDY_MERCURY_BASE_URL'
export const MERCURY_LOCAL_API_KEY_ENV = 'BUDDY_MERCURY_API_KEY'
export const MERCURY_LOCAL_NO_THINK_ENV = 'BUDDY_MERCURY_LOCAL_NO_THINK'
export const SYSTEM2_PROVIDER_ENV = 'BUDDY_SYSTEM2_PROVIDER'
export const OPENCODE_GO_PROVIDER = 'opencode-go'
export const OPENCODE_GO_MODEL = 'muse-spark-1.3-contributor'
export const OPENCODE_GO_BASE_URL = 'https://opencode.ai/zen/go/v1'
export const OPENCODE_GO_API_KEY_FILE_ENV = 'BUDDY_OPENCODE_GO_API_KEY_FILE'
export const OPENCODE_GO_SESSION_FILE_ENV = 'BUDDY_OPENCODE_GO_SESSION_FILE'
export const OPENCODE_GO_USER_AGENT_ENV = 'BUDDY_OPENCODE_GO_USER_AGENT'
export const OPENCODE_GO_DEFAULT_USER_AGENT = 'minecraft-jev-agent/0.1 system2'

export interface MercuryLocalEndpoint {
  /** OpenAI-compatible base URL without a trailing slash, e.g. http://127.0.0.1:8080/v1 */
  readonly baseUrl: string
  /** Bearer token; llama.cpp accepts any non-empty value, so it defaults to 'local'. */
  readonly apiKey: string
  /** Optional chat-template controls understood by local reasoning servers. */
  readonly chatTemplateKwargs?: Record<string, unknown>
  /** Extra transport headers. Secrets are never logged. */
  readonly headers?: Readonly<Record<string, string>>
  /** Provenance label for non-local OpenAI-compatible transports. */
  readonly providerLabel?: string
  /** Transport label emitted in ADVISOR_TRANSPORT. */
  readonly transportLabel?: string
  /** Human-readable endpoint name for bounded error messages. */
  readonly errorLabel?: string
  /** Wire protocol used by this OpenAI-family endpoint. */
  readonly protocol?: 'chat-completions' | 'responses'
}

/** BUDDY_MERCURY_BASE_URL is the explicit opt-in for local System2 transport. */
export function resolveMercuryLocalEndpoint(
  env: Readonly<Record<string, string | undefined>> = process.env,
): MercuryLocalEndpoint | null {
  const raw = (env[MERCURY_LOCAL_BASE_URL_ENV] ?? '').trim()
  if (raw === '') return null
  const noThink = ['1', 'true', 'on', 'yes'].includes((env[MERCURY_LOCAL_NO_THINK_ENV] ?? '').trim().toLowerCase())
  return {
    baseUrl: raw.replace(/\/+$/, ''),
    apiKey: (env[MERCURY_LOCAL_API_KEY_ENV] ?? '').trim() || 'local',
    ...(noThink ? { chatTemplateKwargs: { enable_thinking: false } } : {}),
  }
}

/**
 * OpenCode Go direct System2 profile. The API key and stable session id are read
 * from 0600 files so neither appears in argv, environment dumps, or run logs.
 * The client identifies itself honestly rather than impersonating OpenCode/Codex.
 */
export function resolveMercuryOpenCodeGoEndpoint(
  env: Readonly<Record<string, string | undefined>> = process.env,
  providerOverride?: string | null,
): MercuryLocalEndpoint | null {
  const provider = (providerOverride ?? env[SYSTEM2_PROVIDER_ENV] ?? '').trim().toLowerCase()
  if (provider !== OPENCODE_GO_PROVIDER) return null
  const home = (env.HOME ?? '').trim()
  const keyFile =
    (env[OPENCODE_GO_API_KEY_FILE_ENV] ?? '').trim() ||
    (home !== '' ? `${home}/.config/mc-ai-secrets/opencode-go-api.key` : '')
  const sessionFile =
    (env[OPENCODE_GO_SESSION_FILE_ENV] ?? '').trim() ||
    (home !== '' ? `${home}/.config/mc-ai-secrets/opencode-go-system2-session.id` : '')
  if (keyFile === '' || sessionFile === '') throw new Error('OpenCode Go System2 requires HOME or explicit key/session file paths')
  const apiKey = readFileSync(keyFile, 'utf8').trim()
  const sessionId = readFileSync(sessionFile, 'utf8').trim()
  if (apiKey === '') throw new Error('OpenCode Go System2 API key file is empty')
  if (sessionId === '') throw new Error('OpenCode Go System2 session file is empty')
  return {
    baseUrl: OPENCODE_GO_BASE_URL,
    apiKey,
    headers: {
      'user-agent': (env[OPENCODE_GO_USER_AGENT_ENV] ?? '').trim() || OPENCODE_GO_DEFAULT_USER_AGENT,
      'x-opencode-session': sessionId,
    },
    providerLabel: OPENCODE_GO_PROVIDER,
    transportLabel: 'opencode-go-responses',
    errorLabel: 'OpenCode Go System2',
    protocol: 'responses',
  }
}

// AI SDK 7.0.107 exposes a deeply recursive FlexibleSchema type. Keeping the
// already-validated Zod schema behind the concrete transport input type avoids
// TS2589 during inference without weakening runtime validation: the same
// MERCURY_PLAN_SCHEMA is still passed to the SDK and to validateMercuryPlan.
type MercuryPlanTool = Tool<MercuryPlanJson, never, never>
const MERCURY_PLAN_TOOL_SCHEMA = MERCURY_PLAN_SCHEMA as unknown as MercuryPlanTool['inputSchema']

export const JSON_TEXT_TRANSPORT_INSTRUCTIONS =
  // NATURAL-LANGUAGE CONTRACT (operator directive, 2026-09-22). Earlier revisions
  // demanded a bare JSON object and rejected everything else; live measurement then
  // showed a reasoning model returning prose or nothing and every repair being
  // thrown away. Prose is now the expected answer: the local grounding step maps it
  // onto the code-owned capability list, and the JSON object is optional enrichment.
  'State the next step of the high-level plan in ONE OR TWO SHORT SENTENCES OF NATURAL LANGUAGE. ' +
  'Say WHAT should happen next and why, naming the real Minecraft item, resource or portal step involved. ' +
  'Prose is the expected answer and a partial or approximate sentence is fine; nothing outside the allowed capability list will be grounded. ' +
  'You MAY append a single JSON object describing the same intent, with keys op, goals and reason, as a convenience: it is OPTIONAL enrichment, used only when it agrees with the sentence. ' +
  'If you include it, "op" must be one of continue, patch, replace, abandon, complete or abort (default patch), and each collect/craft/smelt goal needs an integer count in [1,64]. ' +
  'Never invent items or actions outside allowedGoals. Do not emit coordinates, block ids, entity ids, paths, action names or motor instructions.'

interface LocalChatCompletion {
  choices?: Array<{ message?: { content?: string | null } | null } | null>
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null
}

/** Direct OpenAI-compatible chat-completions transport for local servers. */
export function localMercuryTransport(model: string, endpoint: MercuryLocalEndpoint): MercuryTransport {
  return async ({ system, prompt, maxOutputTokens, timeoutMs, signal }) => {
    const response = await fetch(`${endpoint.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${endpoint.apiKey}`,
        ...(endpoint.headers ?? {}),
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: `${system}\n\n${JSON_TEXT_TRANSPORT_INSTRUCTIONS}` },
          { role: 'user', content: prompt },
        ],
        max_tokens: maxOutputTokens,
        temperature: 0,
        stream: false,
        ...(endpoint.chatTemplateKwargs !== undefined ? { chat_template_kwargs: endpoint.chatTemplateKwargs } : {}),
      }),
      signal: signal ?? AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`${endpoint.errorLabel ?? 'local mercury endpoint'} HTTP ${response.status}: ${detail.slice(0, 200)}`)
    }
    const payload = (await response.json()) as LocalChatCompletion
    const content = payload.choices?.[0]?.message?.content
    const parsed = typeof content === 'string' ? parseMercuryJsonTextDetailed(content) : { value: null, shape: 'none' as const, objects: 0 }
    const usage =
      payload.usage == null
        ? null
        : {
            inputTokens: payload.usage.prompt_tokens ?? null,
            outputTokens: payload.usage.completion_tokens ?? null,
          }
    const repair: MercuryTransportRepair = {
      kind: 'json-text',
      shape: parsed.shape,
      objects: parsed.objects,
      chars: typeof content === 'string' ? content.length : 0,
    }
    if (parsed.value === null) return { toolCalls: [], usage, text: content ?? '', repairs: [repair] }
    return {
      toolCalls: [{ input: parsed.value }],
      usage,
      text: content ?? '',
      repairs: parsed.shape === 'exact' ? [] : [repair],
    }
  }
}

interface OpenAIResponsesPayload {
  output_text?: string | null
  output?: Array<{
    type?: string
    content?: Array<{ type?: string; text?: string | null } | null> | null
  } | null>
  usage?: { input_tokens?: number; output_tokens?: number } | null
}

function responsesOutputText(payload: OpenAIResponsesPayload): string {
  if (typeof payload.output_text === 'string') return payload.output_text
  const parts: string[] = []
  for (const item of payload.output ?? []) {
    for (const content of item?.content ?? []) {
      if (content?.type === 'output_text' && typeof content.text === 'string') parts.push(content.text)
    }
  }
  return parts.join('')
}

/** OpenAI Responses API transport used by OpenCode Go Muse Spark. */
export function responsesMercuryTransport(model: string, endpoint: MercuryLocalEndpoint): MercuryTransport {
  return async ({ system, prompt, maxOutputTokens, timeoutMs, signal }) => {
    const response = await fetch(`${endpoint.baseUrl}/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${endpoint.apiKey}`,
        ...(endpoint.headers ?? {}),
      },
      body: JSON.stringify({
        model,
        instructions: `${system}\n\n${JSON_TEXT_TRANSPORT_INSTRUCTIONS}`,
        input: prompt,
        max_output_tokens: maxOutputTokens,
        stream: false,
      }),
      signal: signal ?? AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`${endpoint.errorLabel ?? 'responses endpoint'} HTTP ${response.status}: ${detail.slice(0, 200)}`)
    }
    const payload = (await response.json()) as OpenAIResponsesPayload
    const content = responsesOutputText(payload)
    const parsed = parseMercuryJsonTextDetailed(content)
    const usage = payload.usage == null
      ? null
      : { inputTokens: payload.usage.input_tokens ?? null, outputTokens: payload.usage.output_tokens ?? null }
    const repair: MercuryTransportRepair = {
      kind: 'json-text',
      shape: parsed.shape,
      objects: parsed.objects,
      chars: content.length,
    }
    if (parsed.value === null) return { toolCalls: [], usage, text: content, repairs: [repair] }
    return {
      toolCalls: [{ input: parsed.value }],
      usage,
      text: content,
      repairs: parsed.shape === 'exact' ? [] : [repair],
    }
  }
}

const TOOL_CALL_TRANSPORT_INSTRUCTIONS =
  'Return ONLY via the emitPlan tool. Do not answer in response text.'


function defaultMercuryTransport(model: string): MercuryTransport {
  const local = resolveMercuryLocalEndpoint()
  if (local !== null) return localMercuryTransport(model, local)
  if (mercuryTransportMode(model) === 'json-text') {
    return async ({ system, prompt, maxOutputTokens, timeoutMs, signal }) => {
      // Muse Spark is the default System2 model. Do not route it through the
      // old Mercury-specific named-tool contract: the gateway rejects named
      // tool_choice for this model. Ask for natural language and keep the raw
      // text as the intent; the local grounding validator is the authority.
      const result = await generateText({
        model,
        system: `${system}\n\n${JSON_TEXT_TRANSPORT_INSTRUCTIONS}`,
        prompt,
        maxOutputTokens,
        maxRetries: 0,
        abortSignal: signal ?? AbortSignal.timeout(timeoutMs),
      })
      const parsed = parseMercuryJsonTextDetailed(result.text)
      const repair: MercuryTransportRepair = {
        kind: 'json-text',
        shape: parsed.shape,
        objects: parsed.objects,
        chars: result.text.length,
      }
      if (parsed.value === null) {
        return { toolCalls: [], usage: result.usage, text: result.text, repairs: [repair] }
      }
      return {
        toolCalls: [{ input: parsed.value }],
        usage: result.usage,
        text: result.text,
        repairs: parsed.shape === 'exact' ? [] : [repair],
      }
    }
  }
  return async ({ system, prompt, maxOutputTokens, timeoutMs, signal }) => {
    const result = await generateText({
      model,
      system: `${system}\n\n${TOOL_CALL_TRANSPORT_INSTRUCTIONS}`,
      prompt,
      tools: {
        emitPlan: tool({
          description: 'Emit the bounded high-level Minecraft goal-queue repair plan',
          inputSchema: MERCURY_PLAN_TOOL_SCHEMA,
        }),
      },
      toolChoice: { type: 'tool', toolName: 'emitPlan' },
      maxOutputTokens,
      maxRetries: 0,
      abortSignal: signal ?? AbortSignal.timeout(timeoutMs),
    })
    return { toolCalls: result.toolCalls, usage: result.usage, text: result.text }
  }
}

export const SYSTEM_PROMPT = `You are System 2, the long-horizon intent planner for an embodied Minecraft Java bot.
You do NOT control the body. Mineflayer owns mechanics and System One owns the next grounded action. You may only repair the HIGH-LEVEL goal queue.

Human mission: ${SYSTEM2_HUMAN_MISSION}. Choose the next WHAT from current world facts and grounded executable alternatives that can advance it. The mission does not prescribe a fixed subgoal order. The objective is the active item-counted queue goal, or null when there is none; it is local work, not a mandatory stage. When objective is null, choose useful work from the mission and current evidence instead of assuming a compatibility objective.
Health, food, and any typed starvation fact are live body truth. Use them as safety context while choosing among grounded alternatives; they do not prescribe a fixed semantic subgoal.

When frontierOpportunity is present, it names the current mandatory frontier
and a first craft or station-placement step executable from live inventory.
It is not a scripted route: you still choose the WHAT, and the grounded
alternatives still bound what is possible. When the queue objective is empty, keep this mandatory
frontier ahead of replaceable optional food or surface recovery unless those
alternatives contain a grounded food route or an immediate grounded threat
requires survival work first. Hunger by itself does not ground a food source;
do not propose collect:food when no food route is offered. Express the frontier
as a high-level goal from allowedGoals (for example, craft the frontier item),
never as a craft operation or motor command.

Answer in NATURAL LANGUAGE: one or two short sentences saying WHAT should happen
next and why, naming the real Minecraft item, resource or portal step involved.
A typed layer (System One / Jev) owns the structured choice among grounded
options, so you do NOT have to produce perfect structure - prose that names a
grounded capability is enough. If it is convenient you MAY append one JSON object
with keys op, goals and reason describing the same intent; it is optional
enrichment, never a requirement. Avoid the mistake of spending your whole answer
on analysis and naming no grounded step at all.

The grounded capability vocabulary (use these names in your sentence). A goal is
EITHER a legacy item goal { item, count } (the verb is inferred locally) OR an
explicit typed goal. Use an explicit kind when the same noun needs different
operations (e.g. craft furnace vs place furnace):
- { kind: 'collect', item, count }   allowed items: allowedGoals.collect
- { kind: 'craft', item, count }     allowed items: allowedGoals.craft
- { kind: 'smelt', item, count }     allowed items: allowedGoals.smelt
- { kind: 'place', item }            allowed stations: allowedGoals.place (count optional, default 1)
- { kind: 'goto_resource', item }    known-resource retrieval; allowed: allowedGoals.goto_resources
- { kind: 'recover_death_site' }     return to the host-grounded latest death point; post_death only, takes NO coordinates
- { kind: 'descend_to', y }          integer y in [-59, 320]; optional dimension, defaults to overworld
- { kind: 'explore', mode }          mode is 'cave' or 'surface'
- { kind: 'build_portal_frame' }     build the standard 4x5 obsidian Nether portal frame; takes NO item, count, y, dimension or coordinates (the site and cell geometry are code-owned)
- { kind: 'light_portal', dimension }   light the validated frame with flint_and_steel; optional dimension defaults to minecraft:overworld. The ignition post-condition verifies the nether_portal block. 'light' is an accepted synonym.
- { kind: 'verify_portal', dimension }  re-verify the lit nether_portal block in the dimension. 'verify' is an accepted synonym.
- { kind: 'enter_portal', dimension }   enter an already-live verified portal and transfer dimensions; optional dimension defaults to minecraft:the_nether. The entry cells and route are code-owned.
{ kind: 'build_portal_frame' }, { kind: 'light' }, { kind: 'verify' } and { kind: 'enter_portal' } are distinct WHAT choices. Choose among them using the current dimension, live portal facts and mission. Code grounds the frame geometry and owns ignition, portal and dimension verification. Never emit coordinates, a frame cell list, or { kind: 'place', item: 'nether_portal' }.
Every collect/craft/smelt goal MUST include an explicit integer count in [1,64]; when the quantity is not otherwise constrained, emit count: 1. Local normalization fills a missing count with 1, but an explicit count is required to express your intent, and a count outside [1,64] is rejected.
Never return coordinates, block ids, entity ids, yaw/pitch, paths, action names, or motor instructions; goto references a resource name, never an x/z position.
Do not invent a kind or a target outside the capability matrix; an impossible pair is rejected locally. Do not re-add work that is already done.
If a furnace is held but the world has no placed furnace, emit { kind: 'place', item: 'furnace' } so the placement is a first-class planned step.
Choose the smallest plan change that can unblock progress.

When trigger=post_death, inspect postDeath before choosing WHAT NEXT. Treat its
recoveryChoices as candidate intents: recover_death_site, rebuild_equipment, or
leave_danger_area. Use lostInventory, nearbyHostiles, and recentDeathCount to
decide among them. Repeated deaths or nearby hostiles are strong evidence that
the previous area is unsafe; valuable losses with low observed danger support a
recovery attempt; missing basic tools may justify rebuilding first. Express the
chosen intent through the grounded goals available below. Use
{ kind: 'recover_death_site' } only when postDeath.latestDeathPoint exists in the
current dimension. Never invent a death-site coordinate or motor command.

When wakeDetail includes a grounded blocker or missing capabilities such as
no_path, no_standable_approach, or open_path, treat that as evidence that the
current route is not executable. Do not return the same current collect/goto
goal unchanged or duplicate it. Choose a different valid high-level strategy
that can expose a new route (for example explore cave/surface or descend_to)
while preserving already completed work. The route and action remain code-owned.

Plan operations:
- continue: keep the active semantic Option and append returned goals. Use only
  when the current Option remains the intended WHAT.
- patch: keep the active semantic Option and replace only its pending tail. A
  local route failure is not a reason to invent a new semantic mission.
- replace: replace all unfinished goals because the current semantic plan is no
  longer the intended WHAT. The returned first goal becomes active.
- abandon: explicitly terminate the active semantic Option as abandoned, then
  install the returned goals. Use only when the Option is semantically invalid
  or exhausted; code may reject this for a protected prerequisite.
- complete: request completion of the active Option. Code verifies its success
  predicate and rejects the operation if DONE is not proven. goals MUST be empty;
  any existing pending tail remains intact and becomes active after completion.
- abort: terminate the remaining plan as impossible; goals MUST be empty.
The operation is typed lifecycle intent. The reason/note never overrides it;
"switch" or "move on" must use replace or abandon, never patch.

If recentSemanticOutcomes is present, use it as bounded causal evidence about
earlier WHAT proposals: intent and accepted goals show what was installed;
progress distinguishes body movement from search/goal progress; blocker and
world fingerprints show whether the relevant state changed. A pending or
unknown result is not proof of success or failure. Reassess the current state
and blockers before deciding whether to continue, revise or replace that plan;
history is context, not a fixed route or a ranking of future goals.

Be concise. In the reason field write at most one short sentence.`

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  try {
    return JSON.stringify(error)
  } catch {
    return '<unserialisable>'
  }
}

const ERROR_DETAIL_KEYS = ['statusCode', 'status', 'url', 'responseBody', 'responseHeaders', 'requestBodyValues'] as const

function safeSerialize(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value)) as unknown
  } catch {
    return String(value)
  }
}

/**
 * Capture the FULL provider error so mercury-calls.jsonl is auditable: HTTP status,
 * response body, request URL, plus the cause/lastError chain (the AI SDK nests the
 * real gateway failure several levels deep).
 */
export function describeErrorFull(error: unknown, depth = 0): unknown {
  if (depth > 6) return '<depth-limit>'
  if (error instanceof Error) {
    const record: Record<string, unknown> = { name: error.name, message: error.message }
    const anyError = error as unknown as Record<string, unknown>
    for (const key of ERROR_DETAIL_KEYS) {
      if (anyError[key] !== undefined) record[key] = safeSerialize(anyError[key])
    }
    if (anyError.cause !== undefined) record.cause = describeErrorFull(anyError.cause, depth + 1)
    if (anyError.lastError !== undefined) record.lastError = describeErrorFull(anyError.lastError, depth + 1)
    if (Array.isArray(anyError.errors)) record.errors = anyError.errors.map((entry) => describeErrorFull(entry, depth + 1))
    return record
  }
  return safeSerialize(error)
}

/** Abort / timeout errors are worth exactly one retry; schema errors are not. */
export function isTimeoutError(error: unknown, depth = 0): boolean {
  if (depth > 6 || error === null || typeof error !== 'object') return false
  const record = error as Record<string, unknown>
  const name = record.name
  if (name === 'AbortError' || name === 'TimeoutError') return true
  const message = typeof record.message === 'string' ? record.message : ''
  if (/aborted due to timeout|timed out|ETIMEDOUT|ECONNRESET|socket hang up/i.test(message)) return true
  if (record.statusCode === 408 || record.statusCode === 504) return true
  if (isTimeoutError(record.cause, depth + 1)) return true
  if (isTimeoutError(record.lastError, depth + 1)) return true
  const errors = record.errors
  return Array.isArray(errors) && errors.some((entry) => isTimeoutError(entry, depth + 1))
}

/**
 * Narrow host-recovery classifier for exhausted System2 transport failures.
 * Provider retries are broader (they may include SDK-specific errors), but only
 * explicit HTTP transient statuses, timeout/abort types, known socket/DNS codes,
 * or an explicit gateway-unavailable type may ask HOST to recycle a generation.
 * In particular, a generic APICallError, schema rejection, bad credential, or
 * budget/configuration error is not sufficient evidence for recovery.
 */
export function isTransientSystem2ProviderFailure(error: unknown, depth = 0): boolean {
  if (depth > 6 || error === null || typeof error !== 'object') return false
  const record = error as Record<string, unknown>
  const status = typeof record.statusCode === 'number'
    ? record.statusCode
    : typeof record.status === 'number'
      ? record.status
      : undefined
  if (status === 408 || status === 429 || (status !== undefined && status >= 500 && status <= 599)) return true

  const name = typeof record.name === 'string' ? record.name : ''
  if (/^(AbortError|TimeoutError|GatewayInternalServerError|ServiceUnavailable|InternalServerError)$/.test(name)) return true
  const code = typeof record.code === 'string' ? record.code.toUpperCase() : ''
  if (/^(ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ECONNABORTED)$/.test(code)) return true
  const message = typeof record.message === 'string' ? record.message : ''
  if (/gateway.*service temporarily unavailable|service temporarily unavailable/i.test(message)) return true

  if (isTransientSystem2ProviderFailure(record.cause, depth + 1)) return true
  if (isTransientSystem2ProviderFailure(record.lastError, depth + 1)) return true
  const errors = record.errors
  return Array.isArray(errors) && errors.some((entry) => isTransientSystem2ProviderFailure(entry, depth + 1))
}

export function isRetryableModelError(error: unknown, depth = 0): boolean {
  if (isTimeoutError(error, depth) || isRateLimitError(error, depth)) return true
  if (depth > 4 || error === null || typeof error !== 'object') return false
  const record = error as Record<string, unknown>
  const status = typeof record.statusCode === 'number' ? record.statusCode : undefined
  if (status !== undefined && status >= 500) return true
  const name = typeof record.name === 'string' ? record.name : ''
  if (/InternalServerError|ServiceUnavailable|GatewayInternalServerError|APICallError/i.test(name)) return true
  const message = typeof record.message === 'string' ? record.message : ''
  if (/fetch failed|ECONNREFUSED|EAI_AGAIN|socket hang up|gateway/i.test(message)) return true
  if (isRetryableModelError(record.lastError, depth + 1)) return true
  if (isRetryableModelError(record.cause, depth + 1)) return true
  const errors = record.errors
  return Array.isArray(errors) && errors.some((entry) => isRetryableModelError(entry, depth + 1))
}

export function isBudgetExhaustedError(error: unknown): boolean {
  return error instanceof Error && /hourly budget exhausted/i.test(error.message)
}

export type MercuryAttemptRun<T> =
  | { readonly ok: true; readonly result: T; readonly attempts: number; readonly failures: number }
  | { readonly ok: false; readonly error: unknown; readonly attempts: number; readonly failures: number }

/**
 * Per-attempt context. `feedback` is the corrective text derived from the PREVIOUS
 * failed attempt (null on the first attempt and on retries with no corrective
 * content), so the caller can repair its own prompt instead of repeating a
 * deterministic schema slip until the bound is exhausted.
 */
export interface MercuryAttemptContext {
  readonly attempt: number
  readonly feedback: string | null
  readonly previousError: unknown | null
}

export interface MercuryRetryDetail {
  readonly attempt: number
  readonly nextAttempt: number
  readonly error: unknown
  /** Corrective text the next attempt will receive, or null when none applies. */
  readonly feedback: string | null
}

export interface MercuryAttemptOptions<T> {
  readonly maxAttempts: number
  readonly reserveAttempt: (attempt: number) => void
  readonly call: (context: MercuryAttemptContext) => Promise<T>
  readonly isRetryable: (error: unknown) => boolean
  readonly onRetry: (detail: MercuryRetryDetail) => void
  /**
   * Turn a failed attempt into corrective feedback for the next attempt. A
   * non-null result replaces the pending correction; null/undefined keeps the
   * previous one, so a transport/rate-limit failure cannot erase a schema
   * correction and leave the next attempt to guess.
   */
  readonly feedbackFor?: (error: unknown) => string | null
  /**
   * Backoff before a retryable failure is retried. Mirrors the planner-authority
   * backoff (ec5b92c): the gateway returns bursts of `Service temporarily
   * unavailable`, and immediate retries spent every attempt inside one burst and
   * then terminated the resident (`FATAL context=mercury:<trigger>`).
   */
  readonly retryDelayMs?: (attempt: number) => number
  /** Stop a retry delay immediately when its owning generation is cancelled. */
  readonly signal?: AbortSignal
}

/** Bounded backoff between Mercury retries (see retryDelayMs above). */
const MERCURY_RETRY_BASE_MS = Number(process.env.BUDDY_MERCURY_RETRY_BASE_MS ?? 1500)
const MERCURY_RETRY_MAX_MS = Number(process.env.BUDDY_MERCURY_RETRY_MAX_MS ?? 15000)

function mercurySleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    signal?.addEventListener('abort', finish, { once: true })
  })
}

/** Run attempts with accounting at the boundary immediately before each provider call. */
export async function runMercuryAttempts<T>(options: MercuryAttemptOptions<T>): Promise<MercuryAttemptRun<T>> {
  let attempts = 0
  let failures = 0
  let previousError: unknown = null
  let hasPreviousError = false
  let feedback: string | null = null
  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    try {
      options.reserveAttempt(attempt)
    } catch (error) {
      return { ok: false, error, attempts, failures }
    }
    attempts += 1
    if (hasPreviousError) {
      options.onRetry({ attempt: attempt - 1, nextAttempt: attempt, error: previousError, feedback })
    }
    try {
      const result = await options.call({ attempt, feedback, previousError: hasPreviousError ? previousError : null })
      return { ok: true, result, attempts, failures }
    } catch (error) {
      failures += 1
      if (attempt >= options.maxAttempts || !options.isRetryable(error)) {
        return { ok: false, error, attempts, failures }
      }
      previousError = error
      hasPreviousError = true
      // Only a NEW correction replaces the pending one. A transport/rate-limit
      // failure carries none, and erasing the last schema correction there would
      // make the next attempt repeat the shape mistake blind. That is the live
      // `mercury-1-mub33nuq` sequence: attempt 1 schema reject, attempt 2 gateway
      // 5xx (corrective=false), attempt 3 re-emitted an unparseable response and
      // the resident terminated fail-loud.
      const nextFeedback = options.feedbackFor?.(error)
      if (nextFeedback !== null && nextFeedback !== undefined) feedback = nextFeedback
      const delay = options.retryDelayMs?.(attempt) ?? 0
      if (delay > 0) await mercurySleep(delay, options.signal)
    }
  }
  return { ok: false, error: new Error('mercury: retry loop produced no result'), attempts, failures }
}

function isRateLimitError(error: unknown, depth = 0): boolean {
  if (depth > 4 || typeof error !== 'object' || error === null) return false
  const record = error as Record<string, unknown>
  if (record.statusCode === 429) return true
  const name = record.name
  if (typeof name === 'string' && name.includes('RateLimit')) return true
  if (isRateLimitError(record.lastError, depth + 1)) return true
  if (isRateLimitError(record.cause, depth + 1)) return true
  const errors = record.errors
  return Array.isArray(errors) && errors.some((entry) => isRateLimitError(entry, depth + 1))
}

function trailingWaitStreak(outcomes: readonly System2Outcome[]): number {
  let streak = 0
  for (let i = outcomes.length - 1; i >= 0; i -= 1) {
    const outcome = outcomes[i]
    if (outcome === undefined || outcome.actionId !== 'WAIT') break
    streak += 1
  }
  return streak
}

/**
 * A real sparse System2Brain over the AI Gateway. Muse Spark is the default model.
 * `plan()` fails loud when the model is unavailable; no deterministic semantic
 * fallback is introduced by this adapter.
 */
export class MercurySystem2 implements System2Brain {
  readonly model: string
  readonly authorityModel: string
  private readonly generationCancellation = new AbortController()
  private readonly summarize: MercurySystem2Options['summarize']
  private readonly log: MercurySystem2Options['log']
  private readonly callsPath: string
  private readonly cachePath: string
  private readonly cacheIdentity: MercuryCacheIdentity
  private readonly maxPerHour: number
  private readonly waitLimitBackoffBaseMs: number
  private readonly waitLimitBackoffMaxMs: number
  private readonly timeoutMs: number
  private readonly maxAttempts: number
  private readonly maxOutputTokens: number
  private readonly transport: MercuryTransport
  private readonly localEndpoint: MercuryLocalEndpoint | null
  private readonly terminate: (() => never) | undefined
  private readonly resolveKey: () => KeyResolution | null
  private readonly isCurrent: () => boolean
  private readonly generationId: string | null
  private readonly sourceSha: string | null
  private readonly buildHash: string | null
  private readonly requireFreshProviderDecision: boolean
  private cache: MercuryCacheFile
  private callCounter = 0
  private calls = 0
  private fallbacks = 0
  private postDeathPending: boolean

  constructor(options: MercurySystem2Options) {
    this.summarize = options.summarize
    this.callsPath = options.callsPath
    this.cachePath = options.cachePath
    const configPath = options.configPath ?? process.env.BUDDY_SYSTEM2_CONFIG
    const system2Config = configPath === undefined ? null : readMercuryConfig(configPath)
    const configuredProvider = (process.env[SYSTEM2_PROVIDER_ENV] ?? system2Config?.provider ?? '').trim().toLowerCase()
    const requestedModel =
      options.model ??
      process.env.BUDDY_SYSTEM2_MODEL ??
      process.env.BUDDY_MERCURY_MODEL ??
      system2Config?.model ??
      (configuredProvider === OPENCODE_GO_PROVIDER ? OPENCODE_GO_MODEL : SYSTEM2_MODEL_DEFAULT)
    this.model =
      configuredProvider === OPENCODE_GO_PROVIDER && isMuseSparkModel(requestedModel)
        ? OPENCODE_GO_MODEL
        : requestedModel
    this.authorityModel = this.model
    const openCodeGoEndpoint =
      options.localEndpoint === undefined
        ? resolveMercuryOpenCodeGoEndpoint(process.env, configuredProvider)
        : null
    this.localEndpoint =
      options.localEndpoint !== undefined
        ? options.localEndpoint
        : openCodeGoEndpoint ?? resolveMercuryLocalEndpoint()
    const configuredMaxPerHour = process.env.BUDDY_SYSTEM2_MAX_PER_HOUR
    this.maxPerHour =
      options.maxPerHour ??
      (configuredMaxPerHour !== undefined && configuredMaxPerHour.trim() !== ''
        ? Number(configuredMaxPerHour)
        : this.localEndpoint !== null
          ? LOCAL_MERCURY_MAX_PER_HOUR_DEFAULT
          : mercuryTransportMode(this.model) === 'json-text'
            ? Number.POSITIVE_INFINITY
            : REMOTE_MERCURY_MAX_PER_HOUR_DEFAULT)
    this.waitLimitBackoffBaseMs = options.waitLimitBackoffBaseMs ?? resolveMercuryWaitLimitBackoffBaseMs()
    this.waitLimitBackoffMaxMs = options.waitLimitBackoffMaxMs ?? resolveMercuryWaitLimitBackoffMaxMs()
    this.timeoutMs = options.timeoutMs ?? Number(process.env.BUDDY_SYSTEM2_TIMEOUT_MS ?? SYSTEM2_TIMEOUT_DEFAULT_MS)
    this.maxAttempts = 1 + Math.max(0, options.retries ?? Number(process.env.BUDDY_SYSTEM2_RETRIES ?? 2))
    this.maxOutputTokens = options.maxOutputTokens ?? Number(process.env.BUDDY_SYSTEM2_MAX_OUTPUT_TOKENS ?? 4096)
    this.transport =
      options.transport ??
      (this.localEndpoint === null
        ? defaultMercuryTransport(this.model)
        : this.localEndpoint.protocol === 'responses'
          ? responsesMercuryTransport(this.model, this.localEndpoint)
          : localMercuryTransport(this.model, this.localEndpoint))

    this.terminate = options.terminate
    this.resolveKey = options.resolveKey ?? resolveJevApiKey
    this.isCurrent = options.isCurrent ?? (() => true)
    this.generationId = options.generationId ?? null
    this.sourceSha = options.sourceSha ?? null
    this.buildHash = options.buildHash ?? null
    this.requireFreshProviderDecision = options.requireFreshProviderDecision === true
    this.log = (event, detail) => options.log(event, {
      ...detail,
      generationId: this.generationId,
      sourceSha: this.sourceSha,
      buildHash: this.buildHash,
    })
    this.postDeathPending = options.postDeathRecovery === true
    this.cacheIdentity = mercuryCacheIdentity(options.worldKey)
    this.cache = this.loadCache()
    if (this.localEndpoint !== null) {
      this.log('ADVISOR_TRANSPORT', {
        source: this.localEndpoint.providerLabel ?? 'mercury',
        transport: this.localEndpoint.transportLabel ?? 'local-openai-compatible',
        baseUrl: this.localEndpoint.baseUrl,
        model: this.model,
        maxPerHour: this.maxPerHour,
      })
    }
    this.log('ADVISOR_CACHE_GUARD', {
      active: true,
      version: MERCURY_CACHE_SCHEMA_VERSION,
      maxReplays: MAX_CACHE_REPLAYS,
      maxConsecutive: MAX_CONSECUTIVE_CACHED,
      source: this.provider,
      world: this.cacheIdentity.worldKey,
      epoch: this.cacheIdentity.worldEpoch,
    })
  }

  /** Runtime authority label reflects the selected model, not the legacy class name. */
  get provider(): string {
    if (this.localEndpoint?.providerLabel !== undefined) return this.localEndpoint.providerLabel
    if (mercuryTransportMode(this.model) === 'json-text') return 'muse-spark'
    if (this.model.toLowerCase().includes('mercury')) return 'mercury'
    return 'gateway-system2'
  }

  get callCount(): number {
    return this.calls
  }

  get fallbackCount(): number {
    return this.fallbacks
  }

  get postDeathRecoveryPending(): boolean {
    return this.postDeathPending
  }

  get generationCurrent(): boolean {
    return !this.generationCancellation.signal.aborted && this.isCurrent()
  }

  /** HOST withdraws this generation's semantic authority before it is replaced. */
  cancelPending(reason = 'generation-stopped'): void {
    if (this.generationCancellation.signal.aborted) return
    this.log('MERCURY_REQUEST_CANCELLED', { reason })
    this.generationCancellation.abort(reason)
  }

  /** Standalone System2Brain entry point. Fatals when the configured model cannot answer. */

  async plan(request: System2PlanRequest): Promise<System2Plan> {
    const trigger = this.deriveTrigger(request)
    const started = Date.now()
    const repair = await this.tryRepair(request, trigger)
    if (repair === null) {
      if (this.generationCancellation.signal.aborted || !this.isCurrent()) {
        const reason = this.generationCancellation.signal.aborted && typeof this.generationCancellation.signal.reason === 'string'
          ? this.generationCancellation.signal.reason
          : 'generation-no-longer-current'
        throw new System2RequestCancelledError(reason)
      }
      return this.modelFailure(trigger, started, this.summarize(request, trigger), 'mercury returned no repair')
    }
    return repair.plan
  }

  private deriveTrigger(request: System2PlanRequest): MercuryTriggerReason {
    if (this.postDeathPending) {
      this.postDeathPending = false
      return 'post_death'
    }
    const waitStreak = trailingWaitStreak(request.recentOutcomes)
    if (waitStreak >= 3) return 'wait_limit'
    if (request.reason === 'action_impossible') return 'action_impossible'
    if (request.reason === 'no_progress' || request.reason === 'need_llm' || request.reason === 'unknown_situation') {
      return 'no_progress'
    }
    return 'no_progress'
  }

  /**
   * Gate the counter-shaped `wait_limit` trigger with a durable per-stall
   * backoff. Called by the planner BEFORE `tryRepair`; when `allow` is false the
   * caller must not consult Mercury at all (no provider call, no budget slot).
   *
   * Budget accounting is unchanged: this only stops TRIGGERING so many calls
   * (the documented "accounting at the boundary immediately before each provider
   * call" rule still owns every attempt). `baseMs = 0` disables the time gate.
   */
  evaluateWaitLimitTrigger(input: MercuryWaitLimitTriggerInput): MercuryWaitLimitBackoffDecision {
    const state = this.summarize(input.request, 'wait_limit')
    const waitStreak = trailingWaitStreak(input.request.recentOutcomes)
    const decision = evaluateMercuryWaitLimitBackoff(this.cache.triggerBackoff ?? null, {
      stallKey: input.stallKey,
      waitStreak,
      authorityEpoch: input.authorityEpoch ?? input.request.requestContext?.authorityEpoch ?? null,
      now: input.now ?? Date.now(),
      baseMs: this.waitLimitBackoffBaseMs,
      maxMs: this.waitLimitBackoffMaxMs,
    })
    this.cache.triggerBackoff = decision.state
    this.saveCache()
    const nextWaitMs = mercuryWaitLimitBackoffDelayMs(
      decision.state.consultations,
      this.waitLimitBackoffBaseMs,
      this.waitLimitBackoffMaxMs,
    )
    if (decision.allow) {
      // Announce the raised bar as soon as a consultation is recorded, so the
      // next identical ask is observably suppressed rather than equally likely.
      if (nextWaitMs > 0) {
        this.log(MERCURY_TRIGGER_BACKOFF_MARKER, {
          trigger: 'wait_limit',
          reason: decision.reason,
          consecutiveNoPlan: decision.state.consultations,
          waitMs: nextWaitMs,
          stallKey: input.stallKey,
          stateHash: this.hashState(state),
          waitStreak,
        })
      }
    } else {
      this.log(MERCURY_TRIGGER_SUPPRESSED_MARKER, {
        trigger: 'wait_limit',
        reason: decision.reason,
        consecutiveNoPlan: decision.consecutiveNoPlan,
        waitMs: decision.waitMs,
        stallKey: input.stallKey,
        stateHash: this.hashState(state),
        waitStreak,
      })
    }
    return decision
  }

  /** Clear the durable `wait_limit` backoff (world/epoch change, tests). */
  resetWaitLimitTriggerBackoff(): void {
    this.cache.triggerBackoff = null
    this.saveCache()
  }

  /**
   * Consult Mercury. On any failure (invalid cache, hourly budget exhausted, key
   * missing, request failed, unvalidated response) it retries within the bounded
   * attempt budget, then fatals: FATAL + process exit for the resident, a thrown
   * FatalModelError for tests. It never degrades to the deterministic ladder.
   */
  async tryRepair(request: System2PlanRequest, trigger: MercuryTriggerReason): Promise<MercuryRepairResult | null> {
    const started = Date.now()
    if (trigger === 'post_death') this.postDeathPending = false
    if (!this.generationCurrent) {
      this.log('MERCURY_STALE_DISCARD', {
        trigger,
        stage: 'before_summary',
        generationId: this.generationId,
      })
      return null
    }
    const state = this.summarize(request, trigger)
    const stateHash = this.hashState(state)

    const cached = this.cache.entries[stateHash]
    this.log('PLANNER_CACHE', {
      source: this.provider,
      key: stateHash,
      world: this.cacheIdentity.worldKey,
      epoch: this.cacheIdentity.worldEpoch,
      hit: cached !== undefined,
      bypassed: cached !== undefined && this.requireFreshProviderDecision,
      bypassReason: cached !== undefined && this.requireFreshProviderDecision ? 'same-authority-provider-recovery-requires-fresh-response' : null,
    })
    if (cached !== undefined && this.requireFreshProviderDecision) {
      this.log('MERCURY_CACHE_BYPASSED', {
        source: this.provider,
        model: this.model,
        stateHash,
        reason: 'same-authority-provider-recovery-requires-fresh-response',
      })
    }
    if (cached !== undefined && !this.requireFreshProviderDecision) {
      const replays = cached.replays ?? 0
      const consecutive = this.cache.consecutiveStrategy === cached.strategy ? this.cache.consecutiveCount ?? 0 : 0
      const replayLimit = replays >= MAX_CACHE_REPLAYS
      const consecutiveLimit = consecutive >= MAX_CONSECUTIVE_CACHED
      // Issue #15: reconstruct and re-validate the cached plan; never replay a bare
      // label with empty goals. A stale schema or a repeated no-progress hit is
      // invalidated instead of replayed.
      const restored = validateMercuryPlan({ op: cached.op, goals: cached.goals, reason: cached.reason })
      const restoredGroundingError = restored.ok ? validateMercuryPlanAgainstState(restored.plan, state) : null
      if (restored.ok && restoredGroundingError === null && !replayLimit && !consecutiveLimit) {
        const plan = restored.plan
        const goals = plannedGoalsFromMercury(plan, state)
        // #468 install-time executability: admissibility is not executability. The
        // cached answer passed `validateMercuryPlanAgainstState` (the gate is
        // verified) but the state may already have typed that the BODY cannot run
        // it here (the measured shape: `needs_descend` +
        // `descend_plan:no_support@27,78,-4:air` on the ENTER candidate). A hit
        // is legitimate for the state it was GIVEN, so this is not a cache-key
        // bug: it is the missing install-time check. Refusing here is what stops
        // the apply-then-`action_impossible` cycle at its source.
        const executability = evaluateAndLogMercuryPlanExecutability(this.log, goals, state.blockers, {
          intentSource: 'cached',
          trigger,
          strategy: cached.strategy,
          stateHash,
        })
        if (executability.verdict === 'not_executable_now') {
          // Typed AND mirrored, and NOTHING is applied. The refusal is NOT charged
          // as a replay (nothing was replayed) and the entry is kept: the same
          // state must keep getting the honest answer, and the ordinary
          // escalation path re-asks the WHAT owner once the state changes.
          const ms = Date.now() - started
          return {
            plan: {
              op: 'patch',
              goals: [],
              note: `cached mercury ${cached.strategy} refused: not executable here`,
              // The same typed shape as the `ungrounded` terminal outcome: a
              // zero-goal hand-off the queue can name, never a silent no-op and
              // never a fatal.
              provenance: {
                intentSource: 'cached',
                intent: cached.reason.slice(0, 400),
                noGoalsReason: MERCURY_PLAN_NOT_EXECUTABLE_NO_GOALS_REASON,
              },
            },
            strategy: cached.strategy,
            op: 'patch',
            goals: [],
            costUsd: 0,
            ms,
            cached: true,
          }
        }
        cached.replays = replays + 1
        this.bumpConsecutive(cached.strategy)
        this.saveCache()
        // A replayed plan compiles through the SAME lowering, so it can also drop
        // goals; the replay carries the same typed provenance as a fresh answer.
        const uncompiledCached = uncompiledMercuryGoals(plan, state)
        if (uncompiledCached.length > 0) {
          this.log('MERCURY_GOAL_UNCOMPILED', {
            trigger,
            intentSource: 'cached',
            count: uncompiledCached.length,
            goals: uncompiledCached,
            compiled: goals.map((goal) => goal.description),
          })
        }
        const ms = Date.now() - started
        this.log('ADVISOR', {
          source: this.provider,
          reason: trigger,
          strategy: cached.strategy,
          cost: 0,
          ms,
          cached: true,
          note: `cached mercury plan replayed (${cached.strategy})`,
        })
        return {
          plan: {
            op: plan.op,
            goals,
            note: `cached mercury ${cached.strategy}`,
            provenance: {
              intentSource: 'cached',
              intent: cached.reason.slice(0, 400),
              ...(goals.length === 0
                ? {
                    noGoalsReason:
                      plan.op === 'abort' || plan.op === 'complete' || plan.op === 'continue'
                        ? 'lifecycle_op'
                        : uncompiledCached.length > 0
                          ? 'goals_not_compilable'
                          : 'plan_carried_no_goals',
                  }
                : {}),
              ...(uncompiledCached.length > 0 ? { uncompiled: uncompiledCached } : {}),
            },
          },
          strategy: cached.strategy,
          op: plan.op,
          goals,
          costUsd: 0,
          ms,
          cached: true,
        }
      }
      const bypass = replayLimit
        ? 'repeat_no_progress'
        : consecutiveLimit
          ? 'consecutive_same_strategy'
          : restoredGroundingError !== null
            ? 'stale_grounding'
            : 'stale_schema'
      this.log('ADVISOR_CACHE bypass', {
        reason: bypass,
        strategy: cached.strategy,
        trigger,
        stateHash,
        replays,
        consecutive,
      })
      delete this.cache.entries[stateHash]
      this.resetConsecutive()
      this.saveCache()
    }

    if (this.localEndpoint === null) {
      const key = this.resolveKey()
      if (key === null) return this.modelFailure(trigger, started, state, 'no gateway key resolved')
      // The gateway provider reads this at request time; the value is never logged.
      process.env.AI_GATEWAY_API_KEY = key.key
    }

    const userPrompt = JSON.stringify(state)
    const callId = `mercury-${++this.callCounter}-${started.toString(36)}`

    // HOST owns this promise through the generation cancellation signal below.
    // Authority withdrawal aborts it; an ordinary per-attempt timeout remains a
    // retryable transport failure and each retry receives a fresh timeout signal.
    const callOnce = async (context: MercuryAttemptContext): Promise<MercuryAttemptSuccess> => {
      const prompt = context.feedback === null ? userPrompt : buildCorrectivePrompt(userPrompt, context.feedback)
      const signal = AbortSignal.any([
        this.generationCancellation.signal,
        AbortSignal.timeout(this.timeoutMs),
      ])
      let result: MercuryTransportResult
      try {
        result = await this.transport({
          system: SYSTEM_PROMPT,
          prompt,
          maxOutputTokens: this.maxOutputTokens,
          timeoutMs: this.timeoutMs,
          signal,
        })
      } catch (error) {
        // Host cancellation is a typed stale request, never an outage. In
        // particular, do not feed its AbortError into the transport retry loop.
        if (!this.generationCurrent) throw new StaleMercuryGenerationError()
        throw error
      }
      if (!this.generationCurrent) throw new StaleMercuryGenerationError()
      for (const repair of result.repairs ?? []) {
        if (repair.shape === 'none') {
          this.log('MERCURY_JSON_TEXT_UNPARSED', {
            callId,
            attempt: context.attempt,
            trigger,
            shape: repair.shape,
            objects: repair.objects,
            chars: repair.chars,
            model: this.model,
          })
        } else {
          this.log('MERCURY_JSON_TEXT_REPAIRED', {
            callId,
            attempt: context.attempt,
            trigger,
            shape: repair.shape,
            objects: repair.objects,
          })
        }
      }

      // The natural-language answer is the plan's WHAT. Record it verbatim before
      // any interpretation, so an answer that grounds nothing still survives as
      // evidence instead of becoming an opaque "no plan object" rejection.
      const rawText = result.text ?? ''
      const toolInput = result.toolCalls[0]?.input
      const fromText = parseMercuryJsonTextDetailed(rawText)
      const extraction: MercuryIntentExtraction = extractMercuryIntent(rawText, fromText.value, toolInput)
      this.log('MERCURY_INTENT', {
        callId,
        attempt: context.attempt,
        trigger,
        model: this.model,
        shape: extraction.shape,
        chars: extraction.chars,
        empty: extraction.empty,
        text: extraction.intent.slice(0, 400),
      })

      // 1) OPTIONAL structured enrichment. `stripUnknownPlanKeys` removes fields
      //    the plan contract does not define and renames the provider aliases the
      //    live model emits (`targetItem`->`item`, `requiredCount`->`count`) BEFORE
      //    validation, so a semantically valid plan is not discarded over harmless
      //    extras. Plan SEMANTICS are still validated by validateMercuryPlan.
      const stripped = extraction.enrichment === null ? null : stripUnknownPlanKeys(extraction.enrichment)
      if (stripped !== null && (stripped.notes.droppedKeys.length > 0 || stripped.notes.renamedKeys.length > 0 || stripped.notes.kindAliases.length > 0)) {
        this.log('MERCURY_ENRICHMENT_COERCED', {
          callId,
          attempt: context.attempt,
          trigger,
          droppedKeys: stripped.notes.droppedKeys.slice(0, 12),
          renamedKeys: stripped.notes.renamedKeys.slice(0, 12),
          kindAliases: stripped.notes.kindAliases.slice(0, 12),
        })
      }
      // Mechanically complete the two fields that are pure envelope, never WHAT:
      //   * `op` defaults to `patch` (keep the active Option, replace only its
      //     pending tail) - the non-destructive lifecycle choice.
      //   * `reason` is explanatory prose; when the enrichment omits it, the
      //     model's own natural-language answer IS the reason.
      // Both are reported at MERCURY_FIELD_DEFAULT, so code-supplied values are
      // visible rather than silent. No goal is ever invented or reordered here.
      if (stripped !== null) {
        if (stripped.value.op === undefined) {
          stripped.value.op = 'patch'
          this.log('MERCURY_FIELD_DEFAULT', {
            callId,
            attempt: context.attempt,
            trigger,
            path: 'op',
            value: 'patch',
            why: 'mechanical lifecycle default; the answer named no op',
          })
        }
        const reason = stripped.value.reason
        if (typeof reason !== 'string' || reason.trim().length === 0) {
          stripped.value.reason = (extraction.intent.trim().length > 0 ? extraction.intent : 'mercury natural-language intent').slice(0, 400)
          this.log('MERCURY_FIELD_DEFAULT', {
            callId,
            attempt: context.attempt,
            trigger,
            path: 'reason',
            value: 'from-intent',
            why: 'reason is explanatory; the natural-language answer is the reason',
          })
        }
      }
      const validated = stripped === null ? null : validateMercuryPlan(stripped.value)
      // nekomario28 death-recovery hardening: `recover_death_site` is admissible only
      // when the HOST owns a latest death point in the live dimension. State-dependent
      // grounding is applied to the OPTIONAL enrichment here and to the NL grounding
      // below, so neither route can smuggle in an ungrounded death-site goal.
      const enrichmentStateError =
        validated !== null && validated.ok ? validateMercuryPlanAgainstState(validated.plan, state) : null
      if (enrichmentStateError !== null) {
        this.log('MERCURY_ENRICHMENT_UNUSABLE', {
          callId,
          attempt: context.attempt,
          trigger,
          stage: 'state',
          path: 'goals',
          expected: enrichmentStateError,
        })
      }
      // #system2-compile: the typed reason a STRUCTURED block was unusable. It is
      // carried on the attempt's result so the queue-side line can name it; a
      // rejected block must never look like an answer that simply said less.
      const enrichmentNotAPlan = extraction.enrichment !== null && stripped === null
      if (enrichmentNotAPlan) {
        this.log('MERCURY_ENRICHMENT_NOT_A_PLAN', {
          callId,
          attempt: context.attempt,
          trigger,
          keys: Object.keys(extraction.enrichment ?? {}).slice(0, 12),
          expected: 'a plan object carries op/goals/reason',
        })
      }
      const enrichmentReject =
        enrichmentStateError !== null
          ? { stage: 'state', path: 'goals', expected: enrichmentStateError }
          : validated !== null && !validated.ok
            ? { stage: validated.reject.stage, path: validated.reject.path, expected: validated.reject.expected }
            : enrichmentNotAPlan
              ? { stage: 'envelope', path: '<root>', expected: 'a plan object carries op/goals/reason' }
              : null
      if (validated !== null && validated.ok && enrichmentStateError === null) {
        for (const repair of validated.repairs) {
          this.log('MERCURY_FIELD_DEFAULT', {
            callId,
            attempt: context.attempt,
            trigger,
            path: repair.path,
            value: repair.value,
            why: repair.why,
          })
        }
        return {
          plan: validated.plan,
          usage: result.usage,
          prompt,
          intent: extraction.intent,
          rawText,
          intentSource: 'enrichment',
          droppedKeys: stripped?.notes.droppedKeys ?? [],
          renamedKeys: stripped?.notes.renamedKeys ?? [],
          matched: [],
        }
      }
      if (validated !== null && !validated.ok) {
        // A semantically unusable enrichment is NOT a rejection: the prose is
        // grounded below instead, and the reason is logged for observability.
        this.log('MERCURY_ENRICHMENT_UNUSABLE', {
          callId,
          attempt: context.attempt,
          trigger,
          stage: validated.reject.stage,
          path: validated.reject.path,
          expected: validated.reject.expected,
        })
      }

      // 2) Ground the natural-language intent onto the code-owned capability
      //    matrix. This is grounding, not selection: every goal names a capability
      //    the matrix already exposes, in the model's own mention order.
      //    #system2-compile: when the answer carried a structured block, only its
      //    PROSE half is groundable. Feeding the block's own JSON back in let a
      //    REJECTED plan's surviving goals be applied one by one (the measured
      //    `count: 0` sibling case), which is a partial application of a rejected
      //    plan; the rejection must be total.
      const groundableText =
        extraction.enrichment === null ? extraction.intent : proseWithoutJsonObjects(extraction.intent)
      const groundedTextKind = extraction.enrichment === null ? 'answer' : 'prose_only'
      const grounding = groundMercuryIntent(groundableText, this.allowedGoalsFor(state))
      if (grounding.ok) {
        const constructed: MercuryPlanJson = {
          op: grounding.op,
          goals: grounding.goals as MercuryPlanJson['goals'],
          reason: (extraction.intent.length > 0 ? extraction.intent : 'mercury natural-language intent').slice(0, 400),
        }
        // Defence in depth: the constructed plan goes through the SAME capability
        // validator, so grounding can never bypass a CAN/TRUE/SAFE gate.
        const safe = validateMercuryPlan(constructed)
        if (safe.ok) {
          const stateError = validateMercuryPlanAgainstState(safe.plan, state)
          if (stateError === null) {
            this.log('MERCURY_INTENT_GROUNDED', {
              callId,
              attempt: context.attempt,
              trigger,
              source: 'intent',
              text: groundedTextKind,
              rejectedBlock: enrichmentReject,
              matched: grounding.matched.slice(0, 8),
              goals: safe.plan.goals.map((goal) => goal.kind ?? 'item'),
            })
            return {
              plan: safe.plan,
              usage: result.usage,
              prompt,
              intent: extraction.intent,
              rawText,
              intentSource: 'intent',
              droppedKeys: [],
              renamedKeys: [],
              matched: grounding.matched,
              rejectedBlock: enrichmentReject,
            }
          }
          this.log('MERCURY_INTENT_UNGROUNDED', {
            callId,
            attempt: context.attempt,
            trigger,
            text: groundedTextKind,
            reason: stateError,
          })
        } else {
          this.log('MERCURY_INTENT_UNGROUNDED', {
            callId,
            attempt: context.attempt,
            trigger,
            text: groundedTextKind,
            reason: `grounded goal rejected by capability validation: ${safe.error}`,
          })
        }
      } else {
        this.log('MERCURY_INTENT_UNGROUNDED', {
          callId,
          attempt: context.attempt,
          trigger,
          text: groundedTextKind,
          rejectedBlock: enrichmentReject,
          reason: grounding.reason,
          matched: grounding.matched.slice(0, 8),
        })
      }

      // 3) The model answered but nothing could be grounded. This is a typed,
      //    visible outcome - NOT a schema rejection and NOT model unavailability -
      //    so it does not consume a corrective retry and must not terminate the
      //    resident. The caller leaves WHAT to the next layer.
      return {
        plan: {
          op: 'patch',
          goals: [],
          reason: (extraction.intent.length > 0 ? extraction.intent : 'mercury answered with no grounded goal').slice(0, 400),
        },
        usage: result.usage,
        prompt,
        intent: extraction.intent,
        rawText,
        intentSource: 'ungrounded',
        droppedKeys: stripped?.notes.droppedKeys ?? [],
        renamedKeys: stripped?.notes.renamedKeys ?? [],
        matched: [],
        rejectedBlock: enrichmentReject,
      }
    }

    let attempts = 0
    let failures = 0
    let retriesUsed = 0
    try {
      const attemptRun = await runMercuryAttempts({
        maxAttempts: this.maxAttempts,
        reserveAttempt: (attempt) => {
          if (!this.generationCurrent) throw new StaleMercuryGenerationError()
          const now = Date.now()
          const budgeted = Number.isFinite(this.maxPerHour)
          if (budgeted) {
            this.cache.callTimes = this.cache.callTimes.filter((time) => now - time < HOUR_MS)
            if (this.cache.callTimes.length >= this.maxPerHour) {
              throw new Error(`hourly budget exhausted (${this.maxPerHour}/h)`)
            }
            this.cache.callTimes.push(now)
            this.saveCache()
          }
          this.log('MERCURY_ATTEMPT', {
            callId,
            attempt,
            maxAttempts: this.maxAttempts,
            trigger,
            budgetUsed: budgeted ? this.cache.callTimes.length : null,
            budgetMax: budgeted ? this.maxPerHour : 'unbounded',
          })
        },
        call: callOnce,
        isRetryable: isRetryableMercuryAttempt,
        feedbackFor: mercuryRetryFeedback,
        retryDelayMs: (attempt) => Math.min(MERCURY_RETRY_BASE_MS * 2 ** (attempt - 1), MERCURY_RETRY_MAX_MS),
        signal: this.generationCancellation.signal,
        onRetry: ({ attempt, nextAttempt, error, feedback }) => {
          this.log('MERCURY_RETRY', {
            callId,
            attempt,
            nextAttempt,
            maxAttempts: this.maxAttempts,
            trigger,
            error: describeError(error),
            corrective: feedback !== null,
          })
        },
      })
      attempts = attemptRun.attempts
      failures = attemptRun.failures
      retriesUsed = Math.max(0, attempts - 1)
      if (!this.generationCurrent || (!attemptRun.ok && attemptRun.error instanceof StaleMercuryGenerationError)) {
        return this.staleDiscard(
          trigger,
          started,
          state,
          callId,
          attempts,
          failures,
          retriesUsed,
          userPrompt,
          attemptRun.ok ? attemptRun.result.plan : null,
          attemptRun.ok ? attemptRun.result.usage : null,
        )
      }
      if (!attemptRun.ok) {
        const error = attemptRun.error
        const budgetExhausted = isBudgetExhaustedError(error)
        const message = budgetExhausted
          ? `budget_exhausted: ${describeError(error)}`
          : `llm_error: ${describeError(error)}`
        if (budgetExhausted) {
          this.log('MERCURY_BUDGET_EXHAUSTED', {
            callId,
            trigger,
            stage: trigger,
            maxPerHour: this.maxPerHour,
            budgetUsed: this.cache.callTimes.length,
            attempts,
          })
          this.writeCall({
            record: 'mercury-call',
            callId,
            ts: new Date().toISOString(),
            model: this.model,
            stage: trigger,
            latencyMs: Date.now() - started,
            attempts,
            failures,
            retries: retriesUsed,
            attempt: attempts,
            outcome: 'budget_exhausted',
            state,
            prompt: { system: SYSTEM_PROMPT, user: userPrompt },
            response: null,
            usage: null,
            cost: 0,
            error: message,
            errorDetail: describeErrorFull(error),
          })
        } else {
          // Transport/provider unavailability (5xx, timeout, rate limit, bad key):
          // this stays FAIL LOUD. It is not a schema shape problem, so the new
          // natural-language contract does not soften it.
          this.writeCall({
            record: 'mercury-call',
            callId,
            ts: new Date().toISOString(),
            model: this.model,
            stage: trigger,
            latencyMs: Date.now() - started,
            attempts,
            failures,
            retries: retriesUsed,
            attempt: attempts,
            outcome: 'fallback',
            state,
            prompt: { system: SYSTEM_PROMPT, user: userPrompt },
            response: null,
            usage: null,
            cost: 0,
            error: message,
            errorDetail: describeErrorFull(error),
          })
        }
        return this.modelFailure(
          trigger,
          started,
          state,
          message,
          Date.now() - started,
          isTransientSystem2ProviderFailure(error),
          attempts,
        )
      }
      const success = attemptRun.result
      this.calls += 1
      const latencyMs = Date.now() - started
      const usage = success.usage as MercuryUsageLike
      const costUsd = mercuryCostUsd(this.model, usage)

      // A natural-language answer that grounded onto nothing is a TYPED outcome,
      // not a schema rejection and not model unavailability. Record it truthfully
      // and hand the WHAT to the next layer instead of terminating the resident.
      if (success.intentSource === 'ungrounded') {
        this.saveCache()
        this.writeCall({
          record: 'mercury-call',
          callId,
          ts: new Date().toISOString(),
          model: this.model,
          stage: trigger,
          latencyMs,
          attempts,
          failures,
          retries: retriesUsed,
          attempt: attempts,
          outcome: 'ungrounded',
          state,
          prompt: { system: SYSTEM_PROMPT, user: success.prompt },
          response: null,
          usage: success.usage,
          cost: Number(costUsd.toFixed(8)),
          error: null,
          intent: success.intent,
          rawText: success.rawText,
          intentSource: 'ungrounded',
        })
        return {
          plan: {
            op: 'patch',
            goals: [],
            note: `mercury ungrounded: ${success.plan.reason}`,
            // A typed, mirrored reason for the empty hand-off: the answer named no
            // goal the capability matrix exposes. The queue must be able to say
            // WHY it applied nothing instead of silently no-opping.
            provenance: {
              intentSource: 'ungrounded',
              intent: success.intent.slice(0, 400),
              noGoalsReason:
                success.rejectedBlock == null ? 'answer_ungrounded' : 'rejected_block_no_grounded_prose',
              ...(success.rejectedBlock == null ? {} : { rejectedBlock: success.rejectedBlock }),
            },
          },
          strategy: 'mercury_ungrounded',
          op: 'patch',
          goals: [],
          costUsd,
          ms: latencyMs,
          cached: false,
          ungrounded: { intent: success.intent, reason: 'no grounded goal in the natural-language answer' },
        }
      }

      const validatedPlan = success.plan
      const grounded = groundMercuryPlan(validatedPlan, state)
      const plan = grounded.plan
      if (grounded.refused !== null) {
        this.log('STRATEGY_REFUSED', {
          reason: grounded.refused.reason,
          goal: grounded.refused.goal,
          replacement: grounded.refused.replacement,
          source: this.provider,
        })
      }
      const strategy = mercuryStrategyLabel(plan)
      const goals = plannedGoalsFromMercury(plan, state)
      // #system2-compile: a model goal whose lowering fails is typed here rather
      // than disappearing inside `plannedGoalsFromMercury`. Both the host log and
      // the plan provenance carry it, so "the model asked for X but no X row
      // exists" is answerable from the records alone.
      const uncompiled = uncompiledMercuryGoals(plan, state)
      if (uncompiled.length > 0) {
        this.log('MERCURY_GOAL_UNCOMPILED', {
          callId,
          trigger,
          intentSource: success.intentSource,
          count: uncompiled.length,
          goals: uncompiled,
          compiled: goals.map((goal) => goal.description),
        })
      }
      const executability = evaluateAndLogMercuryPlanExecutability(this.log, goals, state.blockers, {
        intentSource: 'fresh',
        trigger,
        strategy,
        stateHash,
        callId,
      })
      if (executability.verdict === 'not_executable_now') {
        // A valid fresh WHAT can still be unexecutable in the measured state.
        // Preserve the model proposal and the typed refusal in evidence, but do
        // not cache or install it: a later call must be able to reconsider the
        // causal result instead of silently turning this refused answer into a
        // replay authority.
        this.writeCall({
          record: 'mercury-call',
          callId,
          ts: new Date().toISOString(),
          model: this.model,
          stage: trigger,
          latencyMs,
          attempts,
          failures,
          retries: retriesUsed,
          attempt: attempts,
          outcome: 'plan_rejected',
          state,
          prompt: { system: SYSTEM_PROMPT, user: success.prompt },
          response: plan,
          usage: success.usage,
          cost: Number(costUsd.toFixed(8)),
          error: null,
          intent: success.intent,
          rawText: success.rawText,
          intentSource: success.intentSource,
          executability,
        })
        const note = `mercury ${strategy} refused: not executable here`
        this.log('ADVISOR', {
          source: this.provider,
          reason: trigger,
          strategy,
          cost: Number(costUsd.toFixed(6)),
          ms: latencyMs,
          cached: false,
          note,
          intentSource: 'fresh',
        })
        return {
          plan: {
            op: 'patch',
            goals: [],
            note,
            provenance: {
              intentSource: success.intentSource,
              intent: success.intent.slice(0, 400),
              noGoalsReason: MERCURY_PLAN_NOT_EXECUTABLE_NO_GOALS_REASON,
              ...(success.rejectedBlock == null ? {} : { rejectedBlock: success.rejectedBlock }),
            },
          },
          strategy,
          op: 'patch',
          goals: [],
          costUsd,
          ms: latencyMs,
          cached: false,
        }
      }
      this.cache.entries[stateHash] = {
        op: plan.op,
        goals: plan.goals.map((goal) => ({ ...goal })),
        reason: plan.reason,
        strategy,
        costUsd,
        ts: Date.now(),
        worldKey: this.cacheIdentity.worldKey,
        schemaVersion: this.cacheIdentity.schemaVersion,
        replays: 0,
      }
      this.resetConsecutive()
      this.trimCache()
      this.saveCache()

      this.writeCall({
        record: 'mercury-call',
        callId,
        ts: new Date().toISOString(),
        model: this.model,
        stage: trigger,
        latencyMs,
        attempts,
        failures,
        retries: retriesUsed,
        attempt: attempts,
        outcome: 'success',
        state,
        prompt: { system: SYSTEM_PROMPT, user: success.prompt },
        response: plan,
        usage: success.usage,
        cost: Number(costUsd.toFixed(8)),
        error: null,
        intent: success.intent,
        rawText: success.rawText,
        intentSource: success.intentSource,
      })

      this.log('ADVISOR', {
        source: this.provider,
        reason: trigger,
        strategy,
        cost: Number(costUsd.toFixed(6)),
        ms: latencyMs,
        cached: false,
        note: `mercury ${plan.op}: ${plan.reason}`,
        intentSource: success.intentSource,
      })

      // A typed refusal returned above, before cache insertion. Here only an
      // executable or unknown verdict remains; unknown is preserved rather
      // than guessed into either side.
      const installedPlan: System2Plan = {
        op: plan.op,
        goals,
        note: `mercury ${plan.op}: ${plan.reason}`,
        provenance: {
          intentSource: success.intentSource,
          intent: success.intent.slice(0, 400),
          ...(goals.length === 0
            ? {
                noGoalsReason:
                  plan.op === 'abort' || plan.op === 'complete' || plan.op === 'continue'
                    ? 'lifecycle_op'
                    : uncompiled.length > 0
                      ? 'goals_not_compilable'
                      : 'plan_carried_no_goals',
              }
            : {}),
          ...(uncompiled.length > 0 ? { uncompiled } : {}),
          // A rejected structured block is evidence even when the prose grounded a
          // plan: it names WHICH half of the answer the applied rows came from.
          ...(success.rejectedBlock == null ? {} : { rejectedBlock: success.rejectedBlock }),
        },
      }

      return {
        plan: installedPlan,
        strategy,
        op: installedPlan.op ?? 'patch',
        goals: installedPlan.goals,
        costUsd,
        ms: latencyMs,
        cached: false,
      }
    } catch (error) {
      if (error instanceof StaleMercuryGenerationError || !this.generationCurrent) {
        return this.staleDiscard(trigger, started, state, callId, attempts, failures, retriesUsed, userPrompt, null, null)
      }
      // modelFailure() already wrote the authoritative record; do not fabricate a 'fallback'.
      if (error instanceof FatalModelError) throw error
      const latencyMs = Date.now() - started
      const kind = isRateLimitError(error) ? 'rate_limited' : 'llm_error'
      const message = `${kind}: ${describeError(error)}`
      this.writeCall({
        record: 'mercury-call',
        callId,
        ts: new Date().toISOString(),
        model: this.model,
        stage: trigger,
        latencyMs,
        attempts,
        failures,
        retries: retriesUsed,
        attempt: attempts,
        outcome: 'fallback',
        state,
        prompt: { system: SYSTEM_PROMPT, user: userPrompt },
        response: null,
        usage: null,
        cost: 0,
        error: message,
        errorDetail: describeErrorFull(error),
      })
      return this.modelFailure(trigger, started, state, message, latencyMs)
    }
  }

  private staleDiscard(
    trigger: MercuryTriggerReason,
    started: number,
    state: MercuryStateSummary,
    callId: string,
    attempts: number,
    failures: number,
    retriesUsed: number,
    prompt: string,
    response: unknown,
    usage: unknown,
  ): null {
    const latencyMs = Date.now() - started
    this.log('MERCURY_STALE_DISCARD', {
      callId,
      trigger,
      generationId: this.generationId,
      attempts,
      ms: latencyMs,
    })
    this.writeCall({
      record: 'mercury-call',
      callId,
      ts: new Date().toISOString(),
      model: this.model,
      stage: trigger,
      latencyMs,
      attempts,
      failures,
      retries: retriesUsed,
      attempt: attempts,
      outcome: 'stale_discarded',
      state,
      prompt: { system: SYSTEM_PROMPT, user: prompt },
      response,
      usage,
      cost: 0,
      error: 'generation is no longer current',
    })
    return null
  }

  private modelFailure(
    trigger: MercuryTriggerReason,
    started: number,
    state: MercuryStateSummary,
    note: string,
    latencyMs = Date.now() - started,
    retryableTransport = false,
    attempts = this.maxAttempts,
  ): never {
    this.fallbacks += 1
    this.log('MERCURY_FAILURE_STATE', {
      humanMission: state.humanMission,
      inventory: Object.keys(state.inventory).length,
      wait: state.consecutiveWait,
      queueDepth: state.queue.depth,
      ms: latencyMs,
    })
    const error = new FatalModelError(
      retryableTransport ? 'system2-authority' : `mercury:${trigger}`,
      attempts,
      note,
      retryableTransport,
    )
    return failLoud(error, this.log, this.terminate)
  }

  private hashState(state: MercuryStateSummary): string {
    return hashMercuryState(state, this.cacheIdentity)
  }

  /**
   * The capability menu this state was asked to plan against. Grounding a
   * natural-language intent must use the SAME menu the request advertised, so the
   * summary is authoritative and the static matrix is only the fallback.
   */
  private allowedGoalsFor(state: MercuryStateSummary): MercuryAllowedGoals {
    const allowed = state.allowedGoals
    if (allowed === undefined) return MERCURY_ALLOWED_GOALS
    return {
      collect: allowed.collect ?? [],
      craft: allowed.craft ?? [],
      smelt: allowed.smelt ?? [],
      place: allowed.place ?? [],
      goto_resources: allowed.goto_resources ?? [],
      explore_modes: allowed.explore_modes ?? [],
    }
  }

  private writeCall(record: MercuryCallRecord): void {
    try {
      mkdirSync(dirname(this.callsPath), { recursive: true })
      appendFileSync(this.callsPath, `${JSON.stringify({
        ...record,
        provider: this.provider,
        generationId: this.generationId,
        sourceSha: this.sourceSha,
        buildHash: this.buildHash,
        payloadShape: mercuryPayloadShape(record.state),
      })}\n`)
    } catch (error) {
      this.log('ERROR', { where: 'mercury.writeCall', message: describeError(error) })
    }
  }

  private loadCache(): MercuryCacheFile {
    const identity = this.cacheIdentity
    try {
      if (!existsSync(this.cachePath)) return emptyCache(identity)
      const parsed = JSON.parse(readFileSync(this.cachePath, 'utf8')) as Partial<MercuryCacheFile>
      if (parsed.version !== MERCURY_CACHE_FILE_VERSION) {
        this.log('PLANNER_CACHE_INVALIDATED', {
          source: this.provider,
          reason: 'schema',
          cachedVersion: parsed.version ?? null,
          version: MERCURY_CACHE_FILE_VERSION,
        })
        return emptyCache(identity)
      }
      if (parsed.schemaVersion !== identity.schemaVersion) {
        this.log('PLANNER_CACHE_INVALIDATED', {
          source: this.provider,
          reason: 'schema',
          cachedSchema: parsed.schemaVersion ?? null,
          schemaVersion: identity.schemaVersion,
        })
        return emptyCache(identity)
      }
      if (parsed.worldKey !== identity.worldKey || parsed.worldEpoch !== identity.worldEpoch) {
        this.log('PLANNER_CACHE_INVALIDATED', {
          source: this.provider,
          reason: 'world',
          cachedWorld: parsed.worldKey ?? null,
          world: identity.worldKey,
          cachedEpoch: parsed.worldEpoch ?? null,
          epoch: identity.worldEpoch,
        })
        return emptyCache(identity)
      }
      if (typeof parsed.entries !== 'object' || parsed.entries === null) return emptyCache(identity)
      return {
        version: MERCURY_CACHE_FILE_VERSION,
        worldKey: identity.worldKey,
        worldEpoch: identity.worldEpoch,
        schemaVersion: identity.schemaVersion,
        entries: parsed.entries,
        callTimes: Array.isArray(parsed.callTimes) ? parsed.callTimes.filter((time) => typeof time === 'number') : [],
        consecutiveStrategy: typeof parsed.consecutiveStrategy === 'string' ? parsed.consecutiveStrategy : null,
        consecutiveCount: typeof parsed.consecutiveCount === 'number' ? parsed.consecutiveCount : 0,
        triggerBackoff: parseTriggerBackoff(parsed.triggerBackoff),
      }
    } catch {
      return emptyCache(identity)
    }
  }

  private bumpConsecutive(strategy: string): void {
    if (this.cache.consecutiveStrategy === strategy) {
      this.cache.consecutiveCount = (this.cache.consecutiveCount ?? 0) + 1
    } else {
      this.cache.consecutiveStrategy = strategy
      this.cache.consecutiveCount = 1
    }
  }

  private resetConsecutive(): void {
    this.cache.consecutiveStrategy = null
    this.cache.consecutiveCount = 0
  }

  private saveCache(): void {
    try {
      mkdirSync(dirname(this.cachePath), { recursive: true })
      const tmp = `${this.cachePath}.${process.pid}.tmp`
      writeFileSync(tmp, `${JSON.stringify(this.cache)}\n`)
      renameSync(tmp, this.cachePath)
    } catch (error) {
      this.log('ERROR', { where: 'mercury.saveCache', message: describeError(error) })
    }
  }

  private trimCache(): void {
    const entries = Object.entries(this.cache.entries)
    if (entries.length <= MAX_CACHE_ENTRIES) return
    entries.sort((a, b) => b[1].ts - a[1].ts)
    this.cache.entries = Object.fromEntries(entries.slice(0, MAX_CACHE_ENTRIES))
  }
}

/** Directory-independent helper used by generation-entry for the calls path. */
export function mercuryCallsPath(logDir: string): string {
  return join(logDir, 'mercury-calls.jsonl')
}
