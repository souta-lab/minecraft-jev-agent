// planner.ts - the HIGH-LEVEL PLANNER (System 2) for the resident AI_Buddy.
//
// Contract: this module returns BOUNDED PLANNING DATA ONLY (a list of high-level
// goals plus a plan operation). It NEVER issues actions. System One (the Jev
// controller + executor) stays the sole action authority; the controller turns
// whatever goal the queue exposes into one guarded macro-action per tick.
//
// Two sources, one interface (`System2Brain`):
//
//   * llm       - one batched `experimental_evaluate()` call on the proven Jev
//                 path (choice | score | boolean questions). The model chooses
//                 exactly one deterministically grounded horizon plan. It cannot
//                 invent a goal: the candidate plan ids ARE the only options.
//
//   * fallback  - the deterministic capability ladder (no network, never stalls).
//
// Safety / rate-limit behaviour:
//   - plans are cached by a world-state hash and identical states are deduped;
//   - LLM calls are spaced by a minimum interval (the gateway allows few calls);
//   - any failure (missing key, timeout, HTTP 429, malformed answer) falls back
//     to the deterministic ladder immediately and is logged.
//
// The planner is woken by the controller's exception paths via `summonLlm`
// (`queue_empty` / `action_impossible` / `no_progress` / `need_llm`), so it only
// runs on replan boundaries and never on the hot path.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Bot } from 'mineflayer'
import { experimental_evaluate as evaluate } from 'ai'
import type { Experimental_EvaluationQuestion } from 'ai'
import type { PlanOp, PlannedGoal } from '../jev-agent/src/goalQueue.ts'
import type { System2Brain, System2Plan, System2PlanRequest } from '../jev-agent/src/system2.ts'
import { DEFAULT_JEV_MODEL, resolveJevApiKey } from '../jev-agent/src/jev.ts'
import { matchesResourceClass } from '../jev-agent/src/resourceClass.ts'
import type { ResourceClass } from '../jev-agent/src/resourceClass.ts'
import type { ResidentWorldMemory } from './resident-types.ts'

export type Counts = Record<string, number>

// ---------------------------------------------------------------------------
// mode switch (env)
// ---------------------------------------------------------------------------

export type PlannerMode = 'llm' | 'deterministic'

/** `BUDDY_PLANNER=llm|deterministic|auto` (auto = llm when a gateway key exists). */
export function resolvePlannerMode(): PlannerMode {
  const raw = (process.env.BUDDY_PLANNER ?? 'auto').trim().toLowerCase()
  if (raw === 'deterministic' || raw === 'off' || raw === 'fallback' || raw === 'none') return 'deterministic'
  if (raw === 'llm' || raw === 'on') return 'llm'
  return resolveJevApiKey() !== null ? 'llm' : 'deterministic'
}

// ---------------------------------------------------------------------------
// inventory helpers
// ---------------------------------------------------------------------------

export function inventoryCounts(bot: Bot): Counts {
  const counts: Counts = {}
  for (const item of bot.inventory.items()) counts[item.name] = (counts[item.name] ?? 0) + item.count
  return counts
}

export function countClass(counts: Counts, cls: ResourceClass): number {
  let total = 0
  for (const [name, n] of Object.entries(counts)) {
    if (matchesResourceClass(name, cls)) total += n
  }
  return total
}

export function has(counts: Counts, name: string): boolean {
  return (counts[name] ?? 0) > 0
}

/** 0 none, 1 wooden, 2 stone, 3 iron, 4 diamond+ */
export function bestPickaxeRank(counts: Counts): number {
  const order = ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe']
  let rank = 0
  for (let i = 0; i < order.length; i += 1) {
    const name = order[i]
    if (name !== undefined && has(counts, name)) rank = Math.max(rank, i + 1)
  }
  return rank
}

function woodUnits(counts: Counts): number {
  return countClass(counts, 'log') + Math.floor(countClass(counts, 'planks') / 4)
}

// ---------------------------------------------------------------------------
// rung templates: the deterministic road from spawn to the Ender Dragon
// ---------------------------------------------------------------------------

export interface Rung {
  id: string
  /**
   * `future` rungs are part of the documented road to M4 but the current
   * executor cannot attempt them yet. They are shown to the planner as horizon
   * context but are never selected by the deterministic fallback ladder.
   */
  future?: boolean
  satisfied: (c: Counts, w: ResidentWorldMemory) => boolean
  goals: (c: Counts, w: ResidentWorldMemory) => PlannedGoal[]
}

function climb(ingotsNeeded: number, counts: Counts, crafts: Array<[string, number]>): PlannedGoal[] {
  const out: PlannedGoal[] = []
  const have = (counts['raw_iron'] ?? 0) + (counts['iron_ingot'] ?? 0)
  const missing = Math.max(0, ingotsNeeded - have)
  if (missing > 0) {
    out.push({ kind: 'collect', description: `collect ${missing} x raw_iron`, targetItem: 'raw_iron', requiredCount: missing })
    out.push({ kind: 'smelt', description: `smelt ${missing} x iron_ingot`, targetItem: 'iron_ingot', requiredCount: missing })
  }
  for (const [item, n] of crafts) {
    if ((counts[item] ?? 0) < n) out.push({ kind: 'craft', description: `craft ${n} x ${item}`, targetItem: item, requiredCount: n })
  }
  if (out.length === 0) {
    out.push({ kind: 'craft', description: 'craft 1 x iron_chestplate', targetItem: 'iron_chestplate', requiredCount: 1 })
  }
  return out
}

/** The ordered capability ladder. Each rung states its own completion in inventory/world terms. */
export const RUNGS: readonly Rung[] = [
  {
    id: 'wood',
    // A pickaxe already implies the wood stage is done; the charcoal rung asks
    // for its own 2 logs, so do not re-collect 3 logs just to satisfy this rung.
    satisfied: (c) => woodUnits(c) >= 3 || bestPickaxeRank(c) >= 1,
    goals: () => [{ kind: 'collect', description: 'collect 3 x log', targetItem: 'log', requiredCount: 3 }],
  },
  {
    id: 'crafting_table',
    satisfied: (c, w) => has(c, 'crafting_table') || w.craftingTables.length > 0,
    goals: () => [{ kind: 'craft', description: 'craft 1 x crafting_table', targetItem: 'crafting_table', requiredCount: 1 }],
  },
  {
    id: 'wooden_pickaxe',
    satisfied: (c) => bestPickaxeRank(c) >= 1,
    goals: () => [{ kind: 'craft', description: 'craft 1 x wooden_pickaxe', targetItem: 'wooden_pickaxe', requiredCount: 1 }],
  },
  {
    id: 'cobblestone',
    // Stone is legitimately spent on the furnace and stone_pickaxe; a stone
    // pickaxe proves enough cobblestone was mined even when the count is low.
    satisfied: (c) => countClass(c, 'stone') >= 12 || bestPickaxeRank(c) >= 2,
    goals: () => [{ kind: 'collect', description: 'collect 12 x stone', targetItem: 'stone', requiredCount: 12 }],
  },
  {
    id: 'furnace',
    satisfied: (c, w) => has(c, 'furnace') || w.furnaces.length > 0,
    goals: () => [
      { kind: 'craft', description: 'craft 1 x furnace', targetItem: 'furnace', requiredCount: 1 },
      { kind: 'place', description: 'place 1 x furnace', targetItem: 'furnace', requiredCount: 1 },
    ],
  },
  {
    id: 'stone_pickaxe',
    satisfied: (c) => bestPickaxeRank(c) >= 2,
    goals: () => [{ kind: 'craft', description: 'craft 1 x stone_pickaxe', targetItem: 'stone_pickaxe', requiredCount: 1 }],
  },
  {
    id: 'charcoal',
    satisfied: (c) => has(c, 'charcoal') || has(c, 'coal'),
    goals: () => [
      { kind: 'collect', description: 'collect 2 x log (fuel)', targetItem: 'log', requiredCount: 2 },
      { kind: 'smelt', description: 'smelt 1 x charcoal', targetItem: 'charcoal', requiredCount: 1 },
    ],
  },
  {
    id: 'raw_iron',
    satisfied: (c) => (c['raw_iron'] ?? 0) + (c['iron_ingot'] ?? 0) >= 3,
    goals: (c) => [
      {
        kind: 'collect',
        description: 'collect 3 x raw_iron',
        targetItem: 'raw_iron',
        requiredCount: Math.max(1, 3 - ((c['raw_iron'] ?? 0) + (c['iron_ingot'] ?? 0))),
      },
    ],
  },
  {
    id: 'iron_ingot',
    satisfied: (c) => (c['iron_ingot'] ?? 0) >= 3,
    goals: (c) => [{ kind: 'smelt', description: 'smelt 3 x iron_ingot', targetItem: 'iron_ingot', requiredCount: Math.max(1, 3 - (c['iron_ingot'] ?? 0)) }],
  },
  {
    id: 'iron_pickaxe',
    satisfied: (c) => bestPickaxeRank(c) >= 3,
    goals: () => [{ kind: 'craft', description: 'craft 1 x iron_pickaxe', targetItem: 'iron_pickaxe', requiredCount: 1 }],
  },
  {
    id: 'iron_gear',
    satisfied: (c) =>
      has(c, 'iron_chestplate') && has(c, 'iron_leggings') && has(c, 'iron_helmet') && has(c, 'iron_boots') && has(c, 'iron_sword'),
    goals: (c) =>
      climb(26, c, [
        ['iron_chestplate', 1],
        ['iron_leggings', 1],
        ['iron_helmet', 1],
        ['iron_boots', 1],
        ['iron_sword', 1],
      ]),
  },
  {
    id: 'diamond',
    satisfied: (c) => has(c, 'diamond'),
    goals: () => [{ kind: 'collect', description: 'collect 1 x diamond', targetItem: 'diamond', requiredCount: 1 }],
  },
  {
    id: 'diamond_pickaxe',
    satisfied: (c) => has(c, 'diamond_pickaxe'),
    goals: () => [{ kind: 'craft', description: 'craft 1 x diamond_pickaxe', targetItem: 'diamond_pickaxe', requiredCount: 1 }],
  },
  // --- M3: nether route (templates only; the current executor cannot run these) ---
  {
    id: 'nether_portal',
    future: true,
    satisfied: (c) => has(c, 'flint_and_steel') && countClass(c, 'stone') >= 0 && has(c, 'flint'),
    goals: () => [
      { kind: 'collect', description: 'collect 10 x obsidian', targetItem: 'obsidian', requiredCount: 10 },
      { kind: 'craft', description: 'craft 1 x flint_and_steel', targetItem: 'flint_and_steel', requiredCount: 1 },
      { kind: 'place', description: 'place 1 x nether_portal', targetItem: 'nether_portal', requiredCount: 1 },
    ],
  },
  {
    id: 'blaze_rods',
    future: true,
    satisfied: (c) => (c['blaze_rod'] ?? 0) >= 7,
    goals: () => [{ kind: 'collect', description: 'collect 7 x blaze_rod', targetItem: 'blaze_rod', requiredCount: 7 }],
  },
  {
    id: 'ender_pearls',
    future: true,
    satisfied: (c) => (c['ender_pearl'] ?? 0) >= 12,
    goals: () => [{ kind: 'collect', description: 'collect 12 x ender_pearl', targetItem: 'ender_pearl', requiredCount: 12 }],
  },
  {
    id: 'eyes_of_ender',
    future: true,
    satisfied: (c) => (c['eye_of_ender'] ?? 0) >= 12,
    goals: () => [{ kind: 'craft', description: 'craft 12 x eye_of_ender', targetItem: 'eye_of_ender', requiredCount: 12 }],
  },
  {
    id: 'stronghold',
    future: true,
    satisfied: () => false,
    goals: () => [{ kind: 'explore', description: 'locate the stronghold and its end portal room', targetItem: null, requiredCount: 1 }],
  },
  {
    id: 'the_end',
    future: true,
    satisfied: () => false,
    goals: () => [{ kind: 'place', description: 'activate the end portal with eyes of ender', targetItem: 'end_portal', requiredCount: 1 }],
  },
  {
    id: 'dragon',
    future: true,
    satisfied: () => false,
    goals: () => [{ kind: 'recover', description: 'defeat the ender dragon', targetItem: 'ender_dragon', requiredCount: 1 }],
  },
]

export interface Ladder {
  goals: PlannedGoal[]
  rungIndex: number
  rungId: string
  futureRungIds: string[]
}

/** Executable rungs only: the deterministic road the current executor can run. */
export function executableRungs(): readonly Rung[] {
  return RUNGS.filter((rung) => rung.future !== true)
}

/** The full ladder (executable first, then the future M3/M4 road) as goal lists. */
export function buildLadder(counts: Counts, world: ResidentWorldMemory): Ladder {
  const goals: PlannedGoal[] = []
  let rungIndex = RUNGS.length
  let rungId = 'complete'
  for (let i = 0; i < RUNGS.length; i += 1) {
    const rung = RUNGS[i]
    if (rung === undefined || rung.future === true) continue
    if (rung.satisfied(counts, world)) continue
    if (rungIndex === RUNGS.length) {
      rungIndex = i
      rungId = rung.id
    }
    for (const goal of rung.goals(counts, world)) goals.push(goal)
  }
  if (goals.length === 0) {
    // Everything executable is satisfied: keep the resident meaningfully busy.
    goals.push({ kind: 'collect', description: 'collect 16 x raw_iron (resident upkeep)', targetItem: 'raw_iron', requiredCount: 16 })
  }
  return {
    goals,
    rungIndex,
    rungId,
    futureRungIds: RUNGS.filter((rung) => rung.future === true).map((rung) => rung.id),
  }
}

/** Index/id of the first unsatisfied EXECUTABLE rung (the real progress frontier). */
export function computeFrontier(counts: Counts, world: ResidentWorldMemory): { rungIndex: number; rungId: string } {
  for (let i = 0; i < RUNGS.length; i += 1) {
    const rung = RUNGS[i]
    if (rung === undefined || rung.future === true) continue
    if (!rung.satisfied(counts, world)) return { rungIndex: i, rungId: rung.id }
  }
  return { rungIndex: RUNGS.length, rungId: 'complete' }
}

export function debugFrontier(counts: Counts, world: ResidentWorldMemory): { rungIndex: number; rungId: string } {
  return computeFrontier(counts, world)
}

// ---------------------------------------------------------------------------
// candidate horizon plans (the bounded options the LLM chooses between)
// ---------------------------------------------------------------------------

export interface PlanOption {
  id: string
  title: string
  goals: PlannedGoal[]
}

function goalSignature(goals: readonly PlannedGoal[]): string {
  return goals.map((goal) => `${goal.kind}:${goal.targetItem ?? goal.description}:${goal.requiredCount ?? 1}`).join('|')
}

function dedupeOptions(options: PlanOption[]): PlanOption[] {
  const seen = new Set<string>()
  const out: PlanOption[] = []
  for (const option of options) {
    if (option.goals.length === 0) continue
    const signature = goalSignature(option.goals)
    if (seen.has(signature)) continue
    seen.add(signature)
    out.push(option)
    if (out.length >= 4) break
  }
  return out
}

/** Deterministic, grounded options. Option 0 is always the ladder front (fallback). */
export function buildPlanOptions(counts: Counts, world: ResidentWorldMemory): PlanOption[] {
  const unsat = executableRungs().filter((rung) => !rung.satisfied(counts, world))
  if (unsat.length === 0) {
    return [
      {
        id: 'upkeep',
        title: 'resident upkeep',
        goals: [{ kind: 'collect', description: 'collect 16 x raw_iron (resident upkeep)', targetItem: 'raw_iron', requiredCount: 16 }],
      },
    ]
  }
  const options: PlanOption[] = []
  const first = unsat[0]
  if (first !== undefined) {
    options.push({ id: `front_${first.id}`, title: `next milestone: ${first.id}`, goals: first.goals(counts, world) })
  }
  const two = unsat.slice(0, 2).flatMap((rung) => rung.goals(counts, world))
  if (two.length > 0) options.push({ id: 'two_rungs', title: `next two milestones (${unsat.slice(0, 2).map((r) => r.id).join(' + ')})`, goals: two })
  const ironIndex = unsat.findIndex((rung) => rung.id === 'iron_pickaxe')
  if (ironIndex >= 0) {
    const iron = unsat.slice(0, ironIndex + 1).flatMap((rung) => rung.goals(counts, world))
    if (iron.length > 0) options.push({ id: 'finish_iron_age', title: 'finish the iron age (raw_iron -> iron_ingot -> iron_pickaxe)', goals: iron })
  }
  const gearIndex = unsat.findIndex((rung) => rung.id === 'iron_gear')
  if (gearIndex >= 0) {
    const gear = unsat.slice(0, gearIndex + 1).flatMap((rung) => rung.goals(counts, world))
    if (gear.length > 0) options.push({ id: 'iron_gear', title: 'full iron gear then diamond', goals: gear })
  }
  const diamondIndex = unsat.findIndex((rung) => rung.id === 'diamond_pickaxe')
  if (diamondIndex >= 0) {
    const diamond = unsat.slice(0, diamondIndex + 1).flatMap((rung) => rung.goals(counts, world))
    if (diamond.length > 0) options.push({ id: 'diamond_road', title: 'push to diamond + diamond_pickaxe', goals: diamond })
  }
  const whole = unsat.flatMap((rung) => rung.goals(counts, world))
  if (whole.length > 0) options.push({ id: 'full_ladder', title: 'the whole remaining ladder', goals: whole })
  const deduped = dedupeOptions(options)
  if (deduped.length === 0) {
    const front = first ?? unsat[0]
    if (front !== undefined) deduped.push({ id: `front_${front.id}`, title: `next milestone: ${front.id}`, goals: front.goals(counts, world) })
  }
  return deduped
}

const UPKEEP_GOAL: PlannedGoal = {
  kind: 'collect',
  description: 'collect 16 x raw_iron (resident upkeep)',
  targetItem: 'raw_iron',
  requiredCount: 16,
}

const FRONT_FALLBACK: PlanOption = { id: 'front_fallback', title: 'deterministic ladder front', goals: [UPKEEP_GOAL] }

// ---------------------------------------------------------------------------
// compact state + question set for the bounded Jev call
// ---------------------------------------------------------------------------

const HORIZON_INSTRUCTIONS =
  'You are the high-level planner for a Minecraft bot (player AI_Buddy) that must progress ' +
  'from spawn all the way to defeating the Ender Dragon, with no human instructions. Choose ' +
  'exactly ONE plan id from the horizon list: the best next horizon of high-level goals. ' +
  'Every plan id is already grounded in what the bot actually has and in recipes that exist. ' +
  'Answer with the id verbatim; never invent an id. Prefer the shortest plan that removes the ' +
  "bot's current blocker, and only choose a long plan when the prerequisites are already held."

const PLAN_FIT_INSTRUCTIONS =
  'How well does the chosen horizon plan fit the current world state and inventory? Use the ' +
  'ordered levels from poor to excellent.'

const STRATEGY_INSTRUCTIONS =
  'Does the bot need to change strategy (a different plan than the one it has been pursuing) ' +
  'because the current approach is failing or blocked?'

const PLAN_FIT_LEVELS = ['poor fit', 'weak fit', 'reasonable fit', 'good fit', 'excellent fit'] as const

type EvaluateArgs = Parameters<typeof evaluate>[0]
type EvaluationState = EvaluateArgs['state']
type EvaluationQuestion = Experimental_EvaluationQuestion

const COST_PER_TOKEN_USD = 0.04 / 1_000_000 // gateway input rate documented for typesafe-ai/jev

interface LlmChoice {
  optionId: string
  latencyMs: number
  costUsd: number
  planFit: number | null
  strategyChange: boolean | null
  unknownChoice: string | null
}

function member(source: unknown, key: string): unknown {
  if (typeof source !== 'object' || source === null) return undefined
  return (source as Record<string, unknown>)[key]
}

function readChoice(answer: unknown): string | null {
  const value = member(answer, 'choice')
  return typeof value === 'string' ? value : null
}

function readScore(answer: unknown): number | null {
  const value = member(answer, 'score')
  return typeof value === 'number' ? value : null
}

function readBoolean(answer: unknown): boolean | null {
  const value = member(answer, 'probability')
  return typeof value === 'number' ? value >= 0.5 : null
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

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  try {
    return JSON.stringify(error)
  } catch {
    return '<unserialisable>'
  }
}

// ---------------------------------------------------------------------------
// the planner brain
// ---------------------------------------------------------------------------

export interface PlannerCacheEntry {
  optionId: string
  costUsd: number
  ts: number
}

interface PlannerCacheFile {
  version: 1
  lastCallAt: number
  entries: Record<string, PlannerCacheEntry>
}

const MAX_CACHE_ENTRIES = 80

function emptyCache(): PlannerCacheFile {
  return { version: 1, lastCallAt: 0, entries: {} }
}

export interface PlannerOptions {
  bot: Bot
  world: ResidentWorldMemory
  log: (event: string, detail?: Record<string, unknown>) => void
  /** where the durable plan cache is mirrored (JSON, tmp -> rename). */
  cachePath: string
  /** override the env switch (tests / explicit wiring). */
  mode?: PlannerMode
  /** minimum spacing between real LLM calls. */
  minIntervalMs?: number
  /** per-call timeout. */
  timeoutMs?: number
  model?: string
  /** hard cap on LLM calls in this generation's lifetime. */
  maxCalls?: number
}

type PlannerReason = 'start' | 'queue_empty' | 'impossible' | 'stuck'

function mapReason(request: System2PlanRequest, firstCall: boolean): PlannerReason {
  if (firstCall && request.goalQueueState.depth === 0 && request.goalQueueState.done === 0) return 'start'
  if (request.reason === 'action_impossible') return 'impossible'
  if (request.reason === 'no_progress' || request.reason === 'need_llm' || request.reason === 'unknown_situation') return 'stuck'
  return 'queue_empty'
}

/**
 * The resident high-level planner. It is constructed per generation and handed to
 * `JevController.setSystem2()`. The controller calls `plan()` only on replan
 * boundaries (queue empty / goal impossible / stall), never on the hot path.
 */
export class PlannerBrain implements System2Brain {
  readonly model: string
  private readonly bot: Bot
  private readonly world: ResidentWorldMemory
  private readonly log: (event: string, detail?: Record<string, unknown>) => void
  private readonly cachePath: string
  readonly mode: PlannerMode
  private readonly minIntervalMs: number
  private readonly timeoutMs: number
  private readonly maxCalls: number
  private cache: PlannerCacheFile
  private calls = 0
  private firstCall = true
  private lastMilestoneId: string | null = null

  constructor(options: PlannerOptions) {
    this.bot = options.bot
    this.world = options.world
    this.log = options.log
    this.cachePath = options.cachePath
    this.mode = options.mode ?? resolvePlannerMode()
    this.minIntervalMs = options.minIntervalMs ?? Number(process.env.BUDDY_PLANNER_MIN_INTERVAL_MS ?? 45000)
    this.timeoutMs = options.timeoutMs ?? Number(process.env.BUDDY_PLANNER_TIMEOUT_MS ?? 9000)
    this.maxCalls = options.maxCalls ?? Number(process.env.BUDDY_PLANNER_MAX_CALLS ?? 200)
    this.model = options.model ?? process.env.BUDDY_PLANNER_MODEL ?? process.env.AI_GATEWAY_MODEL ?? DEFAULT_JEV_MODEL
    this.cache = this.loadCache()
  }

  async plan(request: System2PlanRequest): Promise<System2Plan> {
    const started = Date.now()
    const counts = inventoryCounts(this.bot)
    const options = buildPlanOptions(counts, this.world)
    const reason = mapReason(request, this.firstCall)
    this.firstCall = false
    this.emitMilestones(counts)
    const fallbackOption = options[0] ?? FRONT_FALLBACK

    if (this.mode === 'deterministic') {
      this.logPlan('fallback', fallbackOption, reason, started, 0, 'planner disabled (deterministic mode)')
      return { goals: fallbackOption.goals, note: 'deterministic ladder (planner disabled)', op: 'replace' }
    }

    const stateHash = this.hashState(counts, request)
    const bypassCache = reason === 'stuck' || reason === 'impossible'
    const cached = bypassCache ? undefined : this.cache.entries[stateHash]
    if (cached !== undefined) {
      const option = options.find((entry) => entry.id === cached.optionId) ?? fallbackOption
      this.logPlan('llm', option, reason, started, 0, `cached plan (${option.id})`, true)
      return this.finishPlan(option, request, `cached plan ${option.id}`)
    }

    const now = Date.now()
    if (this.calls > 0 && now - this.cache.lastCallAt < this.minIntervalMs) {
      this.logPlan('fallback', fallbackOption, reason, started, 0, `throttled ${now - this.cache.lastCallAt}ms < ${this.minIntervalMs}ms`)
      return this.finishPlan(fallbackOption, request, 'throttled: deterministic ladder')
    }
    if (this.calls >= this.maxCalls) {
      this.logPlan('fallback', fallbackOption, reason, started, 0, `call budget exhausted (${this.maxCalls})`)
      return this.finishPlan(fallbackOption, request, 'llm call budget exhausted')
    }

    try {
      const chosen = await this.askLlm(options, request)
      this.calls += 1
      this.cache.lastCallAt = Date.now()
      this.cache.entries[stateHash] = { optionId: chosen.optionId, costUsd: chosen.costUsd, ts: Date.now() }
      this.trimCache()
      this.saveCache()
      const option = options.find((entry) => entry.id === chosen.optionId) ?? fallbackOption
      const note = chosen.unknownChoice !== null ? `unknown choice ${chosen.unknownChoice} -> ${option.id}` : `llm chose ${option.id}`
      this.logPlan('llm', option, reason, started, chosen.costUsd, note, false, chosen.latencyMs, chosen)
      return this.finishPlan(option, request, note)
    } catch (error) {
      const message = describeError(error)
      const kind = isRateLimitError(error) ? 'rate_limited' : 'llm_error'
      this.logPlan('fallback', fallbackOption, reason, started, 0, `${kind}: ${message}`)
      return this.finishPlan(fallbackOption, request, `${kind}: ${message}`)
    }
  }

  // -- internals ------------------------------------------------------------

  private finishPlan(option: PlanOption, request: System2PlanRequest, note: string): System2Plan {
    const queue = request.goalQueueState
    const first = option.goals[0]
    const current = queue.current
    const alreadyActive =
      queue.depth > 0 &&
      current !== null &&
      first !== undefined &&
      current.kind === first.kind &&
      (current.targetItem ?? null) === (first.targetItem ?? null)
    if (alreadyActive) {
      return { goals: [], note: `keep current plan (${note})`, op: 'continue' as PlanOp }
    }
    return { goals: option.goals, note, op: 'replace' }
  }

  private logPlan(
    source: 'llm' | 'fallback',
    option: PlanOption,
    reason: PlannerReason,
    started: number,
    costUsd: number,
    note: string,
    cached = false,
    llmMs = 0,
    detail?: LlmChoice,
  ): void {
    this.log('PLAN', {
      source,
      goals: option.goals.map((goal) => goal.description),
      cost: Number(costUsd.toFixed(6)),
      ms: Date.now() - started,
      reason,
      rung: option.id,
      cached,
      ...(llmMs > 0 ? { llmMs } : {}),
      ...(detail !== undefined && detail.planFit !== null ? { fit: detail.planFit } : {}),
      ...(detail !== undefined && detail.strategyChange !== null ? { strategyChange: detail.strategyChange } : {}),
      note,
    })
  }

  private emitMilestones(counts: Counts): void {
    const frontier = computeFrontier(counts, this.world)
    if (frontier.rungId === this.lastMilestoneId) return
    if (this.lastMilestoneId !== null) this.log('MILESTONE', { name: this.lastMilestoneId, done: true })
    this.log('MILESTONE', { name: frontier.rungId, done: false })
    this.lastMilestoneId = frontier.rungId
  }

  private hashState(counts: Counts, request: System2PlanRequest): string {
    const stable: Record<string, number> = {}
    for (const [name, n] of Object.entries(counts)) if (n > 0) stable[name] = n
    const payload = {
      inventory: stable,
      frontier: computeFrontier(counts, this.world).rungId,
      stations: { tables: this.world.craftingTables.length, furnaces: this.world.furnaces.length },
      ores: [...this.world.discoveredOres].sort(),
      objective: request.objective.targetItem,
      objectiveHave: request.objective.haveCount,
    }
    return createHash('sha1').update(JSON.stringify(payload)).digest('hex').slice(0, 16)
  }

  private compactState(request: System2PlanRequest): EvaluationState {
    const counts = inventoryCounts(this.bot)
    const entity = this.bot.entity
    const frontier = computeFrontier(counts, this.world)
    const relevant: Record<string, number> = {}
    for (const [name, n] of Object.entries(counts)) {
      if (n > 0) relevant[name] = n
    }
    const compact = {
      bot: 'AI_Buddy',
      milestone: { rung: frontier.rungId, rungIndex: frontier.rungIndex },
      position:
        entity === undefined
          ? null
          : { x: Math.round(entity.position.x), y: Math.round(entity.position.y), z: Math.round(entity.position.z) },
      health: this.bot.health,
      food: this.bot.food,
      toolRank: bestPickaxeRank(counts),
      inventory: relevant,
      stations: { craftingTables: this.world.craftingTables.length, furnaces: this.world.furnaces.length },
      discoveredOres: this.world.discoveredOres,
      queue: {
        depth: request.goalQueueState.depth,
        done: request.goalQueueState.done,
        current: request.goalQueueState.current?.description ?? null,
        hasImpossible: request.goalQueueState.hasImpossible,
      },
      objective: request.objective,
      wakeReason: request.reason,
      wakeDetail: request.detail.slice(0, 200),
      recentEvents: request.recentEvents.slice(-5),
      recentOutcomes: request.recentOutcomes.slice(-5).map((outcome) => ({
        action: outcome.actionId,
        status: outcome.status,
        failure: outcome.failure,
        verified: outcome.verified,
      })),
      horizon: executableRungs()
        .filter((rung) => !rung.satisfied(counts, this.world))
        .map((rung) => rung.id),
    }
    return JSON.parse(JSON.stringify(compact)) as EvaluationState
  }

  private async askLlm(options: PlanOption[], request: System2PlanRequest): Promise<LlmChoice> {
    const key = resolveJevApiKey()
    if (key === null) throw new Error('no gateway key resolved')
    // The gateway provider reads this at request time; the value is never logged.
    process.env.AI_GATEWAY_API_KEY = key.key

    const criteria: Record<string, string> = {}
    for (const option of options) {
      criteria[option.id] = `${option.title} :: ${option.goals.map((goal) => goal.description).join(' -> ')}`
    }
    const questions = {
      horizon: { type: 'choice', instructions: HORIZON_INSTRUCTIONS, criteria },
      plan_fit: { type: 'score', instructions: PLAN_FIT_INSTRUCTIONS, criteria: [...PLAN_FIT_LEVELS] },
      strategy_change: {
        type: 'boolean',
        instructions: STRATEGY_INSTRUCTIONS,
        criteria: { true: 'change the plan now', false: 'the current plan is still right' },
      },
    } satisfies Record<string, EvaluationQuestion>

    const state = this.compactState(request)
    const started = Date.now()
    const response = await evaluate({
      model: this.model,
      state,
      questions,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(this.timeoutMs),
    })
    const latencyMs = Date.now() - started

    const answers = response.answers as Record<string, unknown>
    const chosenId = readChoice(answers.horizon)
    const planFit = readScore(answers.plan_fit)
    const strategyChange = readBoolean(answers.strategy_change)
    const match = chosenId === null ? undefined : options.find((option) => option.id === chosenId)
    const inputTokens = response.usage.inputTokens ?? 0
    const outputTokens = response.usage.outputTokens ?? 0
    const costUsd = (inputTokens + outputTokens) * COST_PER_TOKEN_USD
    return {
      optionId: (match ?? options[0] ?? FRONT_FALLBACK).id,
      latencyMs,
      costUsd,
      planFit,
      strategyChange,
      unknownChoice: chosenId !== null && match === undefined ? chosenId : null,
    }
  }

  private loadCache(): PlannerCacheFile {
    try {
      if (!existsSync(this.cachePath)) return emptyCache()
      const parsed = JSON.parse(readFileSync(this.cachePath, 'utf8')) as Partial<PlannerCacheFile>
      if (typeof parsed.lastCallAt !== 'number' || typeof parsed.entries !== 'object' || parsed.entries === null) return emptyCache()
      return { version: 1, lastCallAt: parsed.lastCallAt, entries: parsed.entries }
    } catch {
      return emptyCache()
    }
  }

  private saveCache(): void {
    try {
      mkdirSync(dirname(this.cachePath), { recursive: true })
      const tmp = `${this.cachePath}.${process.pid}.tmp`
      writeFileSync(tmp, `${JSON.stringify(this.cache)}\n`)
      renameSync(tmp, this.cachePath)
    } catch (error) {
      this.log('ERROR', { where: 'planner.saveCache', message: describeError(error) })
    }
  }

  private trimCache(): void {
    const entries = Object.entries(this.cache.entries)
    if (entries.length <= MAX_CACHE_ENTRIES) return
    entries.sort((a, b) => b[1].ts - a[1].ts)
    this.cache.entries = Object.fromEntries(entries.slice(0, MAX_CACHE_ENTRIES))
  }
}
