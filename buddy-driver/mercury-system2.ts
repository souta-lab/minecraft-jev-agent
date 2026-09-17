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
//   * Any error / rate limit / budget exhausted / disabled -> deterministic ladder,
//     logged as `ADVISOR source=fallback`.
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
import { z } from 'zod'
import type { GoalKind, PlanOp, PlannedGoal } from '../jev-agent/src/goalQueue.ts'
import type { System2Brain, System2Outcome, System2Plan, System2PlanRequest } from '../jev-agent/src/system2.ts'
import { resolveJevApiKey } from '../jev-agent/src/jev.ts'
import { MERCURY_ALLOWED_GOALS, MERCURY_MODEL_DEFAULT } from './mercury-capabilities.ts'

export { MERCURY_ALLOWED_GOALS, MERCURY_MODEL_DEFAULT }

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
 * The strict plan schema. `item` is a grounded Minecraft item; Mercury never
 * returns an action, a kind, or a coordinate. The kind (collect/craft/smelt) is
 * inferred locally from the item so the LLM cannot smuggle in motor semantics.
 */
export const MERCURY_PLAN_SCHEMA = z.object({
  op: z.enum(['continue', 'patch', 'replace', 'abort']),
  goals: z
    .array(
      z.object({
        item: z.string().min(1).max(64),
        count: z.number().int().min(1).max(64),
      }),
    )
    .max(8),
  reason: z.string().min(1).max(400),
})

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

/** Infer the queue kind from a grounded item. Unknown items return null. */
export function mercuryGoalKind(item: string): GoalKind | null {
  if (smeltableItems().has(item)) return 'smelt'
  if (craftableItems().has(item)) return 'craft'
  if (collectableItems().has(item)) return 'collect'
  return null
}

/**
 * Shape validation (Zod) + local grounding. Pure and exported so CI can prove
 * planner safety without any network call.
 */
export function validateMercuryPlan(value: unknown): MercuryValidation {
  const parsed = MERCURY_PLAN_SCHEMA.safeParse(value)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return { ok: false, error: `schema: ${issue?.path.join('.') ?? '?'} ${issue?.message ?? 'invalid'}` }
  }
  const plan = parsed.data
  if (plan.op === 'abort' && plan.goals.length !== 0) {
    return { ok: false, error: 'abort plans must not contain goals' }
  }
  for (let index = 0; index < plan.goals.length; index += 1) {
    const goal = plan.goals[index]
    if (goal === undefined) continue
    if (mercuryGoalKind(goal.item) === null) {
      return { ok: false, error: `goal[${index}] ungrounded item: ${goal.item}` }
    }
  }
  return { ok: true, plan }
}

/** Map the validated plan onto the queue's PlannedGoal records (kind inferred). */
export function plannedGoalsFromMercury(plan: MercuryPlanJson): PlannedGoal[] {
  if (plan.op === 'abort') return []
  const goals: PlannedGoal[] = []
  for (const goal of plan.goals) {
    const kind = mercuryGoalKind(goal.item) ?? 'collect'
    goals.push({
      kind,
      description: `${kind} ${goal.count} x ${goal.item}`,
      targetItem: goal.item,
      requiredCount: goal.count,
      detail: 'mercury plan repair',
    })
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
  if (first === undefined || mercuryGoalKind(first.item) !== 'smelt') return { plan, refused: null }
  const input = MERCURY_SMELT_INPUTS[first.item]
  if (input === undefined) return { plan, refused: null }
  if ((state.inventory[input] ?? 0) > 0) return { plan, refused: null }
  if (!(MERCURY_ALLOWED_GOALS.collect as readonly string[]).includes(input)) return { plan, refused: null }
  return {
    plan: { ...plan, goals: [{ item: input, count: first.count }, ...plan.goals.slice(1)] },
    refused: {
      goal: `smelt ${first.item}`,
      replacement: `collect ${input}`,
      reason: `no ${input} held to smelt ${first.item}`,
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
  const kind = mercuryGoalKind(primary.item) ?? 'goal'
  return `mercury_${plan.op}_${kind}_${primary.item}`
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
  allowedGoals: { collect: string[]; craft: string[]; smelt: string[] }
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
  goals: Array<{ item: string; count: number }>
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
  retries: number
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
  /** true when this generation was created fresh because the bot died. */
  postDeathRecovery?: boolean
}

const SYSTEM_PROMPT = `You are System 2, the exception-driven recovery planner for an embodied Minecraft Java bot.
You do NOT control the body. Mineflayer owns mechanics and System One owns the next grounded action. You may only repair the HIGH-LEVEL goal queue.

Return ONLY via the emitPlan tool, matching its schema exactly: op, goals (item + count), reason.
Allowed goal items are exactly the ones in allowedGoals.collect / .craft / .smelt.
Never return coordinates, block ids, entity ids, yaw/pitch, paths, action names, or motor instructions.
Do not invent an item outside allowedGoals. Do not re-add work that is already done.
Choose the smallest plan change that can unblock progress.

Plan operations:
- continue: keep the current queue and append the returned goals.
- patch: keep completed history and the active goal; replace the pending tail.
- replace: replace all unfinished goals.
- abort: the remaining goal is impossible; goals MUST be empty.

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
  private readonly summarize: MercurySystem2Options['summarize']
  private readonly log: MercurySystem2Options['log']
  private readonly callsPath: string
  private readonly cachePath: string
  private readonly cacheIdentity: MercuryCacheIdentity
  private readonly maxPerHour: number
  private readonly timeoutMs: number
  private readonly maxAttempts: number
  private readonly maxOutputTokens: number
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
    this.maxPerHour = options.maxPerHour ?? Number(process.env.BUDDY_SYSTEM2_MAX_PER_HOUR ?? 20)
    // Mercury is a reasoning model: a correct plan routinely takes several seconds
    // of hidden reasoning, so the timeout must comfortably exceed that. The
    // observed failure mode was an abort at ~50ms, so we also retry once.
    this.timeoutMs = options.timeoutMs ?? Number(process.env.BUDDY_SYSTEM2_TIMEOUT_MS ?? 25000)
    this.maxAttempts = 1 + Math.max(0, options.retries ?? Number(process.env.BUDDY_SYSTEM2_RETRIES ?? 1))
    this.maxOutputTokens = options.maxOutputTokens ?? Number(process.env.BUDDY_SYSTEM2_MAX_OUTPUT_TOKENS ?? 3000)
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

  /** Standalone System2Brain entry point. Throws when Mercury cannot answer. */
  async plan(request: System2PlanRequest): Promise<System2Plan> {
    const trigger = this.deriveTrigger(request)
    const repair = await this.tryRepair(request, trigger)
    if (repair === null) throw new Error('mercury unavailable: deterministic fallback required')
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
   * Consult Mercury. Never throws. Returns null when Mercury must be skipped
   * (cache is not valid, hourly budget exhausted, key missing, request failed, or
   * the response could not be validated) - the caller then uses the deterministic
   * ladder immediately.
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

    const now = Date.now()
    this.cache.callTimes = this.cache.callTimes.filter((time) => now - time < HOUR_MS)
    if (this.cache.callTimes.length >= this.maxPerHour) {
      return this.fallback(trigger, started, state, `hourly budget exhausted (${this.maxPerHour}/h)`)
    }

    const key = resolveJevApiKey()
    if (key === null) return this.fallback(trigger, started, state, 'no gateway key resolved')
    // The gateway provider reads this at request time; the value is never logged.
    process.env.AI_GATEWAY_API_KEY = key.key

    const userPrompt = JSON.stringify(state)
    const callId = `mercury-${++this.callCounter}-${started.toString(36)}`
    // Budget counts ATTEMPTS, so a failing model cannot be retried for free.
    this.cache.callTimes.push(now)
    this.saveCache()

    // A generation swap / lease event does NOT own this promise and must not abort
    // it: the only abort signal is the per-attempt timeout below. On a timeout the
    // call is re-issued with a fresh signal instead of being abandoned.
    const callOnce = () =>
      generateText({
        model: this.model,
        system: SYSTEM_PROMPT,
        prompt: userPrompt,
        tools: {
          emitPlan: tool({
            description: 'Emit the bounded high-level Minecraft goal-queue repair plan',
            inputSchema: MERCURY_PLAN_SCHEMA,
          }),
        },
        toolChoice: { type: 'tool', toolName: 'emitPlan' },
        maxOutputTokens: this.maxOutputTokens,
        maxRetries: 0,
        abortSignal: AbortSignal.timeout(this.timeoutMs),
      })

    const callModel = async (): Promise<{ result: Awaited<ReturnType<typeof callOnce>>; attempts: number }> => {
      let lastError: unknown = null
      for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
        try {
          const result = await callOnce()
          return { result, attempts: attempt }
        } catch (attemptError) {
          lastError = attemptError
          if (attempt < this.maxAttempts && isTimeoutError(attemptError)) {
            this.log('MERCURY_RETRY', {
              attempt,
              maxAttempts: this.maxAttempts,
              trigger,
              error: describeError(attemptError),
            })
            continue
          }
          throw attemptError
        }
      }
      throw lastError ?? new Error('mercury: retry loop produced no result')
    }

    let retriesUsed = 0
    try {
      const { result, attempts } = await callModel()
      retriesUsed = attempts - 1
      this.calls += 1
      const latencyMs = Date.now() - started
      const toolCall = result.toolCalls[0]
      const raw = toolCall === undefined ? undefined : (toolCall.input as unknown)
      const validated = validateMercuryPlan(raw)
      const usage = result.usage as MercuryUsageLike
      const costUsd = mercuryCostUsd(this.model, usage)

      if (!validated.ok) {
        const error = `invalid plan: ${validated.error}`
        this.writeCall({
          record: 'mercury-call',
          callId,
          ts: new Date().toISOString(),
          model: this.model,
          stage: trigger,
          latencyMs,
          retries: retriesUsed,
          state,
          prompt: { system: SYSTEM_PROMPT, user: userPrompt },
          response: raw ?? null,
          usage: result.usage,
          cost: Number(costUsd.toFixed(8)),
          error,
        })
        return this.fallback(trigger, started, state, error, costUsd, latencyMs)
      }

      const grounded = groundMercuryPlan(validated.plan, state)
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
        goals: plan.goals.map((goal) => ({ item: goal.item, count: goal.count })),
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
        retries: 0,
        state,
        prompt: { system: SYSTEM_PROMPT, user: userPrompt },
        response: plan,
        usage: result.usage,
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
        retries: retriesUsed,
        state,
        prompt: { system: SYSTEM_PROMPT, user: userPrompt },
        response: null,
        usage: null,
        cost: 0,
        error: message,
        errorDetail: describeErrorFull(error),
      })
      return this.fallback(trigger, started, state, message, 0, latencyMs)
    }
  }

  private fallback(
    trigger: MercuryTriggerReason,
    started: number,
    state: MercuryStateSummary,
    note: string,
    costUsd = 0,
    latencyMs = Date.now() - started,
  ): null {
    this.fallbacks += 1
    this.log('ADVISOR', {
      source: 'fallback',
      reason: trigger,
      strategy: 'deterministic_ladder',
      cost: Number(costUsd.toFixed(6)),
      ms: latencyMs,
      cached: false,
      note: `mercury -> fallback: ${note}`,
    })
    this.log('ADVISOR_FALLBACK_STATE', {
      rung: state.rung,
      inventory: Object.keys(state.inventory).length,
      wait: state.consecutiveWait,
      queueDepth: state.queue.depth,
    })
    return null
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
