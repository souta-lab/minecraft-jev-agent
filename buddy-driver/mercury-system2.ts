// mercury-system2.ts - a REAL System2Brain backed by Inception Mercury 2.5.
//
// This is the EXCEPTION-DRIVEN high-level planner. It is only consulted when the
// resident is stuck (no productive candidate / 3 consecutive WAITs / no progress /
// an impossible goal / post-death recovery). The deterministic capability ladder
// (planner.ts) stays the normal-path planner; Mercury only repairs the goal queue
// when the ladder cannot make progress.
//
// HARD RULES (mirrors AGENTS.md):
//   * The LLM returns ONLY plan data: { op, goals: [{item,count}], reason }.
//     System One remains the sole action authority - no action ids, no coordinates.
//   * Enabling Mercury is EXPLICIT config (BUDDY_SYSTEM2=mercury or
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
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { generateText, tool } from 'ai'
import type { Tool } from 'ai'
import { z } from 'zod'
import type { GoalKind, PlanOp, PlannedGoal } from '../jev-agent/src/goalQueue.ts'
import { compilePlannedGoal, stableOptionInstanceId } from '../jev-agent/src/optionSpec.ts'
import type { System2Brain, System2Outcome, System2Plan, System2PlanRequest } from '../jev-agent/src/system2.ts'
import { resolveJevApiKey } from '../jev-agent/src/jev.ts'
import type { KeyResolution } from '../jev-agent/src/jev.ts'
import { FatalModelError, failLoud } from '../jev-agent/src/modelFailure.ts'
import { ORE_SOURCES } from '../jev-agent/src/state.ts'
import { ORE_CANONICAL_Y } from '../jev-agent/src/predicateGoal.ts'
import {
  NETHER_PORTAL,
  OBSIDIAN,
  OVERWORLD,
  PORTAL_LIT_PREDICATE,
  PORTAL_OBSIDIAN_REQUIRED,
} from '../jev-agent/src/netherPortalPlan.ts'
import {
  MERCURY_ALLOWED_GOALS,
  MERCURY_EXPLORE_MODES,
  MERCURY_MODEL_DEFAULT,
  MERCURY_TYPED_GOAL_KINDS,
} from './mercury-capabilities.ts'

export { MERCURY_ALLOWED_GOALS, MERCURY_MODEL_DEFAULT, MERCURY_TYPED_GOAL_KINDS }

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

/**
 * The strict plan schema (issue #19). A goal is EITHER a legacy item goal
 * `{ item, count }` (kind inferred locally, backward compatible) OR an explicit
 * typed goal `{ kind, ... }`. Free-form coordinates are NOT part of the schema:
 * `goto`/`goto_resource` reference a known resource, never an x/z position
 * (PLANNERS.md forbids model-generated coordinates). The kind is code-owned and
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

export type MercuryValidation =
  | { ok: true; plan: MercuryPlanJson }
  | { ok: false; error: string }

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
  let changed = false
  const goals = plan.goals.map((goal) => {
    const normalized = normalizeMercuryGoal(goal)
    if (normalized !== goal) changed = true
    return normalized
  })
  return changed ? { ...plan, goals } : plan
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
    return { ok: false, error: `schema: ${issue?.path.join('.') ?? '?'} ${issue?.message ?? 'invalid'}` }
  }
  const plan = normalizeMercuryPlan(parsed.data)
  if ((plan.op === 'abort' || plan.op === 'complete') && plan.goals.length !== 0) {
    return { ok: false, error: `${plan.op} plans must not contain goals` }
  }
  for (let index = 0; index < plan.goals.length; index += 1) {
    const goal = plan.goals[index]
    if (goal === undefined) continue
    const error = validateMercuryGoal(index, goal)
    if (error !== null) return { ok: false, error }
  }
  return { ok: true, plan }
}

/** A rejected plan that is retryable WHEN the exact rejection is fed back to the model. */
export class MercuryPlanValidationError extends Error {
  readonly validationError: string
  readonly rawPlan: unknown

  constructor(validationError: string, rawPlan: unknown) {
    super(`invalid plan: ${validationError}`)
    this.name = 'MercuryPlanValidationError'
    this.validationError = validationError
    this.rawPlan = rawPlan
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

/** Append the exact validation rejection + a repair instruction to the next attempt's prompt. */
export function buildCorrectivePrompt(basePrompt: string, validationError: string): string {
  return [
    basePrompt,
    '',
    'CORRECTION REQUIRED: your previous emitPlan call was rejected by local validation:',
    `  ${validationError}`,
    `Fix exactly that problem and re-emit the emitPlan tool call. ${MERCURY_SCHEMA_CORRECTIVE_HINT}`,
    'Do not repeat the rejected goal unchanged.',
  ].join('\n')
}

/**
 * Compile ONE validated goal onto the existing executable machinery:
 *   place/craft/collect/smelt -> matching PlannedGoal kind (PLACE / CRAFT / ...)
 *   goto / goto_resource      -> `collect` of the resource (known-resource RETRIEVE)
 *   descend_to                -> `descend` predicate goal (targetY)
 *   explore cave             -> `descend` predicate (existing cave/ore descent)
 *   explore surface          -> `collect log` (existing surface body-change plan)
 */
function compileMercuryGoalRaw(goal: MercuryPlanGoalJson): PlannedGoal | null {
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
    case 'descend_to':
      return {
        kind: 'descend',
        description: `descend_to:Y=${goal.y}`,
        targetItem: null,
        requiredCount: 1,
        targetY: goal.y,
        dimension: goal.dimension ?? 'minecraft:overworld',
        detail: 'mercury descend_to',
      }
    case 'explore':
      if (goal.mode === 'surface') {
        return {
          kind: 'collect',
          description: 'explore surface for wood',
          targetItem: 'log',
          requiredCount: 1,
          detail: 'mercury explore:surface',
        }
      }
      return {
        kind: 'descend',
        description: `explore cave (descend_to:Y=${ORE_CANONICAL_Y['raw_iron'] ?? 32})`,
        targetItem: 'raw_iron',
        requiredCount: 1,
        targetY: ORE_CANONICAL_Y['raw_iron'] ?? 32,
        dimension: 'minecraft:overworld',
        detail: 'mercury explore:cave',
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
        : source.kind === 'explore'
          ? `explore:${source.mode ?? 'unknown'}`
          : source.kind === 'descend_to'
            ? `descend_to:y${source.y ?? 'unknown'}`
            : `${source.kind}:${item ?? source.mode ?? (source.y === undefined ? 'goal' : `y${source.y}`)}`
  const semanticSpec = {
    ...compilePlannedGoal(compiled),
    id: templateId,
    intent: source.kind === undefined ? compiled.description : `${source.kind}${item === null ? '' : ` ${item}`}`,
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

export function compileMercuryGoal(goal: MercuryPlanGoalJson): PlannedGoal | null {
  const compiled = compileMercuryGoalRaw(goal)
  return compiled === null ? null : semanticizeMercuryGoal(goal, compiled)
}

/** Map the validated plan onto the queue's PlannedGoal records. */
export function plannedGoalsFromMercury(plan: MercuryPlanJson): PlannedGoal[] {
  if (plan.op === 'abort' || plan.op === 'complete') return []
  const goals: PlannedGoal[] = []
  for (const goal of plan.goals) {
    const compiled = compileMercuryGoal(goal)
    if (compiled !== null) goals.push(compiled)
  }
  return goals
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

/** Stable cache key for a Mercury state summary. Exported so tests can seed the cache. */
export function hashMercuryState(state: MercuryStateSummary, identity: MercuryCacheIdentity = mercuryCacheIdentity()): string {
  const payload = {
    worldKey: identity.worldKey,
    worldEpoch: identity.worldEpoch,
    schemaVersion: identity.schemaVersion,
    dimension: state.dimension,
    trigger: state.trigger,
    rung: state.rung,
    inventory: state.inventory,
    toolRank: state.toolRank,
    stations: state.stations,
    ores: [...state.knownOres].sort(),
    current: state.queue.current,
    depth: state.queue.depth,
    hasImpossible: state.queue.hasImpossible,
    wait: Math.min(state.consecutiveWait, 3),
    failures: state.recentFailures,
  }
  return createHash('sha1').update(JSON.stringify(payload)).digest('hex').slice(0, 16)
}

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
  mercury?: boolean
}

export interface MercuryEnablement {
  enabled: boolean
  source: string
}

/**
 * Resolve whether Mercury is enabled. Precedence:
 *   1. BUDDY_SYSTEM2=off|none|fallback|deterministic  -> disabled
 *   2. BUDDY_SYSTEM2=mercury|on|llm                    -> enabled (unless planner=deterministic)
 *   3. config file { "mercury": true }                 -> enabled (unless planner=deterministic)
 *   4. otherwise                                       -> disabled
 * The Gateway key is NEVER consulted here.
 */
export function resolveMercuryEnablement(
  plannerMode: 'llm' | 'deterministic',
  configPath: string,
): MercuryEnablement {
  const raw = (process.env.BUDDY_SYSTEM2 ?? '').trim().toLowerCase()
  if (raw === 'off' || raw === 'none' || raw === 'fallback' || raw === 'deterministic') {
    return { enabled: false, source: 'env:BUDDY_SYSTEM2=off' }
  }
  const explicitOn = raw === 'mercury' || raw === 'on' || raw === 'llm'
  let configured = explicitOn
  if (!configured) {
    try {
      if (existsSync(configPath)) {
        const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as MercuryConfigFile
        configured = parsed.mercury === true
      }
    } catch {
      configured = false
    }
  }
  if (!configured) return { enabled: false, source: 'default-off' }
  if (plannerMode === 'deterministic') return { enabled: false, source: 'deterministic-planner-override' }
  return { enabled: true, source: explicitOn ? 'env:BUDDY_SYSTEM2=mercury' : `config:${configPath}` }
}

// ---------------------------------------------------------------------------
// compressed state summary
// ---------------------------------------------------------------------------

export interface MercuryStateSummary {
  trigger: MercuryTriggerReason
  wakeReason: string
  wakeDetail: string
  rung: string
  rungIndex: number
  position: { x: number; y: number; z: number } | null
  dimension: string | null
  health: number | null
  toolRank: number
  inventory: Record<string, number>
  stations: { craftingTables: number; furnaces: number }
  knownOres: string[]
  recentFailures: string[]
  consecutiveWait: number
  queue: { depth: number; done: number; current: string | null; hasImpossible: boolean }
  objective: { targetItem: string; requiredCount: number; haveCount: number; complete: boolean }
  deathHistory: string[]
  allowedGoals: {
    collect: string[]
    craft: string[]
    smelt: string[]
    place?: string[]
    goto_resources?: string[]
    explore_modes?: string[]
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
export const MERCURY_CACHE_SCHEMA_VERSION = 3
const MERCURY_CACHE_FILE_VERSION = 3

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
}

const MAX_CACHE_ENTRIES = 60
const HOUR_MS = 60 * 60 * 1000
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
  }
}

// ---------------------------------------------------------------------------
// call log (auditable, same schema family as jev-calls.jsonl)
// ---------------------------------------------------------------------------

export interface MercuryCallRecord {
  record: 'mercury-call'
  callId: string
  ts: string
  model: string
  stage: MercuryTriggerReason
  latencyMs: number
  attempts: number
  failures: number
  retries: number
  /** 1-based index of the attempt this record describes (retry audit trail). */
  attempt?: number
  outcome: 'success' | 'plan_rejected' | 'fallback' | 'budget_exhausted'
  state: unknown
  prompt: { system: string; user: string }
  response: unknown
  usage: unknown
  cost: number
  error: string | null
  /** Full structured error (name, message, statusCode, responseBody, cause chain). */
  errorDetail?: unknown
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
}

interface MercuryRejectedAttempt {
  attempt: number
  prompt: string
  response: unknown
  usage: unknown
  error: string
}

interface MercuryAttemptSuccess {
  plan: MercuryPlanJson
  usage: unknown
  prompt: string
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
  /** Extra attempts after a timeout/abort (1 = one retry). */
  retries?: number
  maxOutputTokens?: number
  /** resident process terminator; absent in tests (the fatal error is thrown) */
  terminate?: () => never
  /** key resolver seam for tests; defaults to `resolveJevApiKey` */
  resolveKey?: () => KeyResolution | null
  /** true when this generation was created fresh because the bot died. */
  postDeathRecovery?: boolean
  /** transport seam for tests; defaults to the AI SDK `generateText` tool call. */
  transport?: MercuryTransport
}

export interface MercuryTransportRequest {
  readonly system: string
  readonly prompt: string
  readonly maxOutputTokens: number
  readonly timeoutMs: number
}

export interface MercuryTransportToolCall {
  readonly input: unknown
}

export interface MercuryTransportResult {
  readonly toolCalls: readonly MercuryTransportToolCall[]
  readonly usage: unknown
}

export type MercuryTransport = (request: MercuryTransportRequest) => Promise<MercuryTransportResult>

/**
 * Some gateway models accept the AI SDK tool schema but reject a named
 * `tool_choice`.  Keep their compatibility path explicit: the model still
 * emits only a high-level plan, and the exact same local schema/capability
 * validation remains authoritative after transport parsing.
 */
export const MUSE_SPARK_MODEL = 'muse-spark-1.3-contributor'

export type MercuryTransportMode = 'tool-call' | 'json-text'

export function mercuryTransportMode(model: string): MercuryTransportMode {
  return model === MUSE_SPARK_MODEL ? 'json-text' : 'tool-call'
}

/** Extract one JSON object from a model's text response without repairing it. */
export function parseMercuryJsonText(text: string): unknown | null {
  const trimmed = text.trim()
  if (trimmed.length === 0) return null
  const candidates: string[] = [trimmed]
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1]
  if (fenced !== undefined) candidates.push(fenced.trim())
  const first = trimmed.indexOf('{')
  const last = trimmed.lastIndexOf('}')
  if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1))
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {
      // The caller turns null into the normal schema rejection/corrective retry.
    }
  }
  return null
}

// AI SDK 7.0.107 exposes a deeply recursive FlexibleSchema type. Keeping the
// already-validated Zod schema behind the concrete transport input type avoids
// TS2589 during inference without weakening runtime validation: the same
// MERCURY_PLAN_SCHEMA is still passed to the SDK and to validateMercuryPlan.
type MercuryPlanTool = Tool<MercuryPlanJson, never, never>
const MERCURY_PLAN_TOOL_SCHEMA = MERCURY_PLAN_SCHEMA as unknown as MercuryPlanTool['inputSchema']

const JSON_TEXT_TRANSPORT_INSTRUCTIONS =
  'This model cannot use a named tool choice. Prefer one emitPlan tool call when supported; otherwise return exactly one JSON object in the response text, with no prose or markdown. ' +
  'The top-level op must be exactly one of continue, patch, replace, abandon, complete, or abort. ' +
  'Use goals for the typed goal objects; never use a goal kind as op. For complete and abort, goals MUST be empty; abandon may carry the replacement plan. ' +
  'For collect, craft, and smelt goals always include an integer count from 1 to 64.'

function defaultMercuryTransport(model: string): MercuryTransport {
  if (mercuryTransportMode(model) === 'json-text') {
    return async ({ system, prompt, maxOutputTokens, timeoutMs }) => {
      const result = await generateText({
        model,
        system: `${system}\n\n${JSON_TEXT_TRANSPORT_INSTRUCTIONS}`,
        prompt,
        tools: {
          emitPlan: tool({
            description: 'Emit the bounded high-level Minecraft goal-queue repair plan',
            inputSchema: MERCURY_PLAN_TOOL_SCHEMA,
          }),
        },
        // muse rejects a named tool choice but accepts the provider-neutral
        // auto mode. If it spends its output budget reasoning without a tool
        // call, the strict JSON-text parser below is the non-semantic fallback.
        toolChoice: 'auto',
        maxOutputTokens,
        maxRetries: 0,
        abortSignal: AbortSignal.timeout(timeoutMs),
      })
      if (result.toolCalls.length > 0) return { toolCalls: result.toolCalls, usage: result.usage }
      const parsed = parseMercuryJsonText(result.text)
      return { toolCalls: parsed === null ? [] : [{ input: parsed }], usage: result.usage }
    }
  }
  return async ({ system, prompt, maxOutputTokens, timeoutMs }) => {
    const result = await generateText({
      model,
      system,
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
      abortSignal: AbortSignal.timeout(timeoutMs),
    })
    return { toolCalls: result.toolCalls, usage: result.usage }
  }
}

const SYSTEM_PROMPT = `You are System 2, the exception-driven recovery planner for an embodied Minecraft Java bot.
You do NOT control the body. Mineflayer owns mechanics and System One owns the next grounded action. You may only repair the HIGH-LEVEL goal queue.

Return ONLY via the emitPlan tool, matching its schema exactly: op, goals, reason.
A goal is EITHER a legacy item goal { item, count } (the verb is inferred locally) OR an explicit typed goal. Use an explicit kind when the same noun needs different operations (e.g. craft furnace vs place furnace):
- { kind: 'collect', item, count }   allowed items: allowedGoals.collect
- { kind: 'craft', item, count }     allowed items: allowedGoals.craft
- { kind: 'smelt', item, count }     allowed items: allowedGoals.smelt
- { kind: 'place', item }            allowed stations: allowedGoals.place (count optional, default 1)
- { kind: 'goto_resource', item }    known-resource retrieval; allowed: allowedGoals.goto_resources
- { kind: 'descend_to', y }          integer y in [-59, 320]; optional dimension, defaults to overworld
- { kind: 'explore', mode }          mode is 'cave' or 'surface'
- { kind: 'build_portal_frame' }     build the standard 4x5 obsidian Nether portal frame; takes NO item, count, y, dimension or coordinates (the site and cell geometry are code-owned)
- { kind: 'light_portal', dimension }   light the validated frame with flint_and_steel; optional dimension defaults to minecraft:overworld. The ignition post-condition verifies the nether_portal block. 'light' is an accepted synonym.
- { kind: 'verify_portal', dimension }  re-verify the lit nether_portal block in the dimension. 'verify' is an accepted synonym.
When the portal materials are ready, { kind: 'build_portal_frame' }, { kind: 'light' } and { kind: 'verify' } are distinct WHAT goals you may emit in the order you choose: Code grounds the frame geometry and owns the ignition verification. Never emit coordinates, a frame cell list, or { kind: 'place', item: 'nether_portal' }.
Every collect/craft/smelt goal MUST include an explicit integer count in [1,64]; when the quantity is not otherwise constrained, emit count: 1. Local normalization fills a missing count with 1, but an explicit count is required to express your intent, and a count outside [1,64] is rejected.
Never return coordinates, block ids, entity ids, yaw/pitch, paths, action names, or motor instructions; goto references a resource name, never an x/z position.
Do not invent a kind or a target outside the capability matrix; an impossible pair is rejected locally. Do not re-add work that is already done.
If a furnace is held but the world has no placed furnace, emit { kind: 'place', item: 'furnace' } so the placement is a first-class planned step.
Choose the smallest plan change that can unblock progress.

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
  /** Turn a failed attempt into corrective feedback for the next attempt; null when none applies. */
  readonly feedbackFor?: (error: unknown) => string | null
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
      feedback = options.feedbackFor?.(error) ?? null
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
 * A real System2Brain over the AI Gateway (Mercury 2.5). `plan()` throws when the
 * model is unavailable; the integrated PlannerBrain uses `tryRepair()` instead,
 * which never throws and always falls back to the deterministic ladder.
 */
export class MercurySystem2 implements System2Brain {
  readonly model: string
  readonly provider = 'mercury'
  readonly authorityModel: string
  private readonly summarize: MercurySystem2Options['summarize']
  private readonly log: MercurySystem2Options['log']
  private readonly callsPath: string
  private readonly cachePath: string
  private readonly cacheIdentity: MercuryCacheIdentity
  private readonly maxPerHour: number
  private readonly timeoutMs: number
  private readonly maxAttempts: number
  private readonly maxOutputTokens: number
  private readonly transport: MercuryTransport
  private readonly terminate: (() => never) | undefined
  private readonly resolveKey: () => KeyResolution | null
  private cache: MercuryCacheFile
  private callCounter = 0
  private calls = 0
  private fallbacks = 0
  private postDeathPending: boolean

  constructor(options: MercurySystem2Options) {
    this.summarize = options.summarize
    this.log = options.log
    this.callsPath = options.callsPath
    this.cachePath = options.cachePath
    this.model = options.model ?? process.env.BUDDY_MERCURY_MODEL ?? MERCURY_MODEL_DEFAULT
    this.authorityModel = this.model
    this.maxPerHour = options.maxPerHour ?? Number(process.env.BUDDY_SYSTEM2_MAX_PER_HOUR ?? 20)
    // Mercury is a reasoning model: a correct plan routinely takes several seconds
    // of hidden reasoning, so the timeout must comfortably exceed that. The
    // observed failure mode was an abort at ~50ms, so we also retry once.
    this.timeoutMs = options.timeoutMs ?? Number(process.env.BUDDY_SYSTEM2_TIMEOUT_MS ?? 25000)
    this.maxAttempts = 1 + Math.max(0, options.retries ?? Number(process.env.BUDDY_SYSTEM2_RETRIES ?? 2))
    this.maxOutputTokens = options.maxOutputTokens ?? Number(process.env.BUDDY_SYSTEM2_MAX_OUTPUT_TOKENS ?? 3000)
    this.transport = options.transport ?? defaultMercuryTransport(this.model)
    this.terminate = options.terminate
    this.resolveKey = options.resolveKey ?? resolveJevApiKey
    this.postDeathPending = options.postDeathRecovery === true
    this.cacheIdentity = mercuryCacheIdentity(options.worldKey)
    this.cache = this.loadCache()
    this.log('ADVISOR_CACHE_GUARD', {
      active: true,
      version: MERCURY_CACHE_SCHEMA_VERSION,
      maxReplays: MAX_CACHE_REPLAYS,
      maxConsecutive: MAX_CONSECUTIVE_CACHED,
      source: 'mercury',
      world: this.cacheIdentity.worldKey,
      epoch: this.cacheIdentity.worldEpoch,
    })
  }

  get callCount(): number {
    return this.calls
  }

  get fallbackCount(): number {
    return this.fallbacks
  }

  /** Standalone System2Brain entry point. Fatals when Mercury cannot answer. */
  async plan(request: System2PlanRequest): Promise<System2Plan> {
    const trigger = this.deriveTrigger(request)
    const started = Date.now()
    const repair = await this.tryRepair(request, trigger)
    if (repair === null) return this.modelFailure(trigger, started, this.summarize(request, trigger), 'mercury returned no repair')
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
   * Consult Mercury. On any failure (invalid cache, hourly budget exhausted, key
   * missing, request failed, unvalidated response) it retries within the bounded
   * attempt budget, then fatals: FATAL + process exit for the resident, a thrown
   * FatalModelError for tests. It never degrades to the deterministic ladder.
   */
  async tryRepair(request: System2PlanRequest, trigger: MercuryTriggerReason): Promise<MercuryRepairResult | null> {
    const started = Date.now()
    if (trigger === 'post_death') this.postDeathPending = false
    const state = this.summarize(request, trigger)
    const stateHash = this.hashState(state)

    const cached = this.cache.entries[stateHash]
    this.log('PLANNER_CACHE', {
      source: 'mercury',
      key: stateHash,
      world: this.cacheIdentity.worldKey,
      epoch: this.cacheIdentity.worldEpoch,
      hit: cached !== undefined,
    })
    if (cached !== undefined) {
      const replays = cached.replays ?? 0
      const consecutive = this.cache.consecutiveStrategy === cached.strategy ? this.cache.consecutiveCount ?? 0 : 0
      const replayLimit = replays >= MAX_CACHE_REPLAYS
      const consecutiveLimit = consecutive >= MAX_CONSECUTIVE_CACHED
      // Issue #15: reconstruct and re-validate the cached plan; never replay a bare
      // label with empty goals. A stale schema or a repeated no-progress hit is
      // invalidated instead of replayed.
      const restored = validateMercuryPlan({ op: cached.op, goals: cached.goals, reason: cached.reason })
      if (restored.ok && !replayLimit && !consecutiveLimit) {
        cached.replays = replays + 1
        this.bumpConsecutive(cached.strategy)
        this.saveCache()
        const plan = restored.plan
        const goals = plannedGoalsFromMercury(plan)
        const ms = Date.now() - started
        this.log('ADVISOR', {
          source: 'mercury',
          reason: trigger,
          strategy: cached.strategy,
          cost: 0,
          ms,
          cached: true,
          note: `cached mercury plan replayed (${cached.strategy})`,
        })
        return {
          plan: { op: plan.op, goals, note: `cached mercury ${cached.strategy}` },
          strategy: cached.strategy,
          op: plan.op,
          goals,
          costUsd: 0,
          ms,
          cached: true,
        }
      }
      const bypass = replayLimit ? 'repeat_no_progress' : consecutiveLimit ? 'consecutive_same_strategy' : 'stale_schema'
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

    const key = this.resolveKey()
    if (key === null) return this.modelFailure(trigger, started, state, 'no gateway key resolved')
    // The gateway provider reads this at request time; the value is never logged.
    process.env.AI_GATEWAY_API_KEY = key.key

    const userPrompt = JSON.stringify(state)
    const callId = `mercury-${++this.callCounter}-${started.toString(36)}`
    const rejectedAttempts: MercuryRejectedAttempt[] = []

    // A generation swap / lease event does NOT own this promise and must not abort
    // it: the only abort signal is the per-attempt timeout below. On a timeout the
    // call is re-issued with a fresh signal instead of being abandoned.
    const callOnce = async (context: MercuryAttemptContext): Promise<MercuryAttemptSuccess> => {
      const prompt = context.feedback === null ? userPrompt : buildCorrectivePrompt(userPrompt, context.feedback)
      const result = await this.transport({
        system: SYSTEM_PROMPT,
        prompt,
        maxOutputTokens: this.maxOutputTokens,
        timeoutMs: this.timeoutMs,
      })
      const toolCall = result.toolCalls[0]
      const raw = toolCall === undefined ? undefined : toolCall.input
      const validated = validateMercuryPlan(raw)
      if (!validated.ok) {
        rejectedAttempts.push({
          attempt: context.attempt,
          prompt,
          response: raw ?? null,
          usage: result.usage,
          error: `invalid plan: ${validated.error}`,
        })
        this.log('PLAN_REJECTED', {
          source: 'mercury',
          reason: validated.error,
          stage: trigger,
          callId,
          attempt: context.attempt,
          corrective: context.feedback !== null,
        })
        throw new MercuryPlanValidationError(validated.error, raw ?? null)
      }
      return { plan: validated.plan, usage: result.usage, prompt }
    }

    let attempts = 0
    let failures = 0
    let retriesUsed = 0
    let rejectionsFlushed = false
    try {
      const attemptRun = await runMercuryAttempts({
        maxAttempts: this.maxAttempts,
        reserveAttempt: (attempt) => {
          const now = Date.now()
          this.cache.callTimes = this.cache.callTimes.filter((time) => now - time < HOUR_MS)
          if (this.cache.callTimes.length >= this.maxPerHour) {
            throw new Error(`hourly budget exhausted (${this.maxPerHour}/h)`)
          }
          this.cache.callTimes.push(now)
          this.saveCache()
          this.log('MERCURY_ATTEMPT', {
            callId,
            attempt,
            maxAttempts: this.maxAttempts,
            trigger,
            budgetUsed: this.cache.callTimes.length,
            budgetMax: this.maxPerHour,
          })
        },
        call: callOnce,
        isRetryable: isRetryableMercuryAttempt,
        feedbackFor: mercuryRetryFeedback,
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
      this.flushRejectedAttempts(callId, trigger, started, state, rejectedAttempts, attempts, failures, retriesUsed)
      rejectionsFlushed = true
      if (!attemptRun.ok) {
        const error = attemptRun.error
        const isValidation = error instanceof MercuryPlanValidationError
        const budgetExhausted = isBudgetExhaustedError(error)
        const message = isValidation
          ? error.message
          : budgetExhausted
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
        } else if (rejectedAttempts.length === 0) {
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
            outcome: isValidation ? 'plan_rejected' : 'fallback',
            state,
            prompt: { system: SYSTEM_PROMPT, user: userPrompt },
            response: null,
            usage: null,
            cost: 0,
            error: message,
            errorDetail: isValidation ? undefined : describeErrorFull(error),
          })
        }
        return this.modelFailure(trigger, started, state, message, Date.now() - started)
      }
      const success = attemptRun.result
      this.calls += 1
      const latencyMs = Date.now() - started
      const validatedPlan = success.plan
      const usage = success.usage as MercuryUsageLike
      const costUsd = mercuryCostUsd(this.model, usage)

      const grounded = groundMercuryPlan(validatedPlan, state)
      const plan = grounded.plan
      if (grounded.refused !== null) {
        this.log('STRATEGY_REFUSED', {
          reason: grounded.refused.reason,
          goal: grounded.refused.goal,
          replacement: grounded.refused.replacement,
          source: 'mercury',
        })
      }
      const strategy = mercuryStrategyLabel(plan)
      const goals = plannedGoalsFromMercury(plan)
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
      })

      this.log('ADVISOR', {
        source: 'mercury',
        reason: trigger,
        strategy,
        cost: Number(costUsd.toFixed(6)),
        ms: latencyMs,
        cached: false,
        note: `mercury ${plan.op}: ${plan.reason}`,
      })

      return {
        plan: { op: plan.op, goals, note: `mercury ${plan.op}: ${plan.reason}` },
        strategy,
        op: plan.op,
        goals,
        costUsd,
        ms: latencyMs,
        cached: false,
      }
    } catch (error) {
      // modelFailure() already wrote the authoritative record; do not fabricate a 'fallback'.
      if (error instanceof FatalModelError) throw error
      const latencyMs = Date.now() - started
      const kind = isRateLimitError(error) ? 'rate_limited' : 'llm_error'
      const message = `${kind}: ${describeError(error)}`
      if (!rejectionsFlushed) {
        this.flushRejectedAttempts(callId, trigger, started, state, rejectedAttempts, attempts, failures, retriesUsed)
      }
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

  private flushRejectedAttempts(
    callId: string,
    trigger: MercuryTriggerReason,
    started: number,
    state: MercuryStateSummary,
    rejected: readonly MercuryRejectedAttempt[],
    attempts: number,
    failures: number,
    retriesUsed: number,
  ): void {
    for (const entry of rejected) {
      const costUsd = mercuryCostUsd(this.model, entry.usage as MercuryUsageLike)
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
        attempt: entry.attempt,
        outcome: 'plan_rejected',
        state,
        prompt: { system: SYSTEM_PROMPT, user: entry.prompt },
        response: entry.response,
        usage: entry.usage,
        cost: Number(costUsd.toFixed(8)),
        error: entry.error,
      })
    }
  }

  private modelFailure(
    trigger: MercuryTriggerReason,
    started: number,
    state: MercuryStateSummary,
    note: string,
    latencyMs = Date.now() - started,
  ): never {
    this.fallbacks += 1
    this.log('MERCURY_FAILURE_STATE', {
      rung: state.rung,
      inventory: Object.keys(state.inventory).length,
      wait: state.consecutiveWait,
      queueDepth: state.queue.depth,
      ms: latencyMs,
    })
    const error = new FatalModelError(`mercury:${trigger}`, this.maxAttempts, note)
    return failLoud(error, this.log, this.terminate)
  }

  private hashState(state: MercuryStateSummary): string {
    return hashMercuryState(state, this.cacheIdentity)
  }

  private writeCall(record: MercuryCallRecord): void {
    try {
      mkdirSync(dirname(this.callsPath), { recursive: true })
      appendFileSync(this.callsPath, `${JSON.stringify(record)}\n`)
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
          source: 'mercury',
          reason: 'schema',
          cachedVersion: parsed.version ?? null,
          version: MERCURY_CACHE_FILE_VERSION,
        })
        return emptyCache(identity)
      }
      if (parsed.schemaVersion !== identity.schemaVersion) {
        this.log('PLANNER_CACHE_INVALIDATED', {
          source: 'mercury',
          reason: 'schema',
          cachedSchema: parsed.schemaVersion ?? null,
          schemaVersion: identity.schemaVersion,
        })
        return emptyCache(identity)
      }
      if (parsed.worldKey !== identity.worldKey || parsed.worldEpoch !== identity.worldEpoch) {
        this.log('PLANNER_CACHE_INVALIDATED', {
          source: 'mercury',
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
