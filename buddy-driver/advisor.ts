// advisor.ts - the P1.5 "next move" advisor.
//
// On a stall (no productive candidate / WAIT limit / no progress / impossible
// goal) the upper LLM is asked to choose ONE strategy for the next move via the
// proven evaluation path (`experimental_evaluate` with a single `choice`
// question named `next_strategy`). The LLM NEVER returns an action: System One
// stays the sole action authority. The strategy only selects which bounded,
// already-grounded goal list the planner seeds; the controller turns it into
// guarded macro-actions exactly as before.
//
// Failure (missing key, timeout, 429, malformed answer) is retried a bounded
// number of times and then fatals: the resident logs a FATAL line and exits,
// never a deterministic ladder. In deterministic planner mode the LLM is never
// called, so `llm.called==false` stays provable; that mode is explicit opt-in.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { experimental_evaluate as evaluate } from 'ai'
import type { Experimental_EvaluationQuestion } from 'ai'
import type { PlannedGoal } from '../jev-agent/src/goalQueue.ts'
import { DEFAULT_JEV_MODEL, resolveJevApiKey } from '../jev-agent/src/jev.ts'
import type { KeyResolution } from '../jev-agent/src/jev.ts'
import { FatalModelError, failLoud, withModelRetries } from '../jev-agent/src/modelFailure.ts'

export const ADVISOR_STRATEGIES = [
  'descend_to_y16',
  'explore_cave',
  'branch_mine',
  'return_to_known_ore',
  'smelt_and_craft',
] as const

export type AdvisorStrategy = (typeof ADVISOR_STRATEGIES)[number]

export type AdvisorReason = 'wait_limit' | 'no_candidate' | 'no_progress' | 'action_impossible'

const STRATEGY_INSTRUCTIONS =
  'You are the strategy advisor for a Minecraft survival bot (player AI_Buddy) that is stalled. ' +
  'Choose exactly ONE next strategy from the criteria. You choose a STRATEGY ONLY - never an action. ' +
  'Prefer the strategy that directly removes the current blocker given the live inventory and tool rank. ' +
  'If the bot lacks a stone pickaxe, prefer gathering the materials the ladder needs before mining iron.'

const STRATEGY_CRITERIA: Record<AdvisorStrategy, string> = {
  descend_to_y16: 'dig a staircase straight down toward y=16 where stone and ores are exposed',
  explore_cave: 'walk to unexplored terrain / cave openings to find exposed ores',
  branch_mine: 'dig a horizontal branch tunnel at the current depth to find buried ores',
  return_to_known_ore: 'navigate back to an ore location already discovered and mine it',
  smelt_and_craft: 'smelt held raw materials and craft the next tool from the ladder',
}

const COST_PER_TOKEN_USD = 0.04 / 1_000_000

/** `BUDDY_ADVISOR=llm|deterministic|auto` (auto follows the planner mode). */
export function resolveAdvisorMode(plannerMode: 'llm' | 'deterministic'): 'llm' | 'deterministic' {
  const raw = (process.env.BUDDY_ADVISOR ?? 'auto').trim().toLowerCase()
  if (raw === 'off' || raw === 'fallback' || raw === 'deterministic' || raw === 'none') return 'deterministic'
  if (raw === 'on' || raw === 'llm') return 'llm'
  return plannerMode
}

export interface AdvisorState {
  rung: string
  rungIndex: number
  position: { x: number; y: number; z: number } | null
  dimension: string | null
  inventory: Record<string, number>
  toolRank: number
  stations: { craftingTables: number; furnaces: number }
  discoveredOres: string[]
  queueCurrent: string | null
  queueDepth: number
  queueDone: number
  waitStreak: number
  failedCandidates: Record<string, number>
  recentFailures: string[]
}

export interface AdvisorDecision {
  strategy: AdvisorStrategy
  source: 'llm' | 'fallback'
  reason: AdvisorReason
  costUsd: number
  ms: number
  cached: boolean
  note: string
  /**
   * The grounded plan (issue #15/#29): the goal list that was compiled for this
   * strategy. On a cache hit this is the exact plan stored at decision time, so a
   * cache hit replays the PLAN and not merely the strategy label.
   */
  goals?: PlannedGoal[]
}

interface AdvisorCacheEntry {
  strategy: AdvisorStrategy
  costUsd: number
  ts: number
  goals?: PlannedGoal[]
  replays?: number
}

interface AdvisorCacheFile {
  version: 2
  lastCallAt: number
  entries: Record<string, AdvisorCacheEntry>
  consecutiveStrategy?: AdvisorStrategy | null
  consecutiveCount?: number
}

const MAX_CACHE_ENTRIES = 120
/**
 * A cache hit may replay the SAME (state, strategy) plan at most this many times.
 * The 3rd identical request is a no-progress loop and bypasses the cache (#15).
 */
export const MAX_CACHE_REPLAYS = 2
/** Consecutive cached decisions with the same strategy, across states, before bypass. */
export const MAX_CONSECUTIVE_CACHED = 2

function emptyCache(): AdvisorCacheFile {
  return { version: 2, lastCallAt: 0, entries: {}, consecutiveStrategy: null, consecutiveCount: 0 }
}

/**
 * Grounding result for a strategy (issue #29): a label the lower layer cannot
 * apply must be refused and replaced with an executable one. Pure so the refusal
 * rule is unit-testable with no bot and no network.
 */
export interface StrategyGrounding {
  /** Strategy actually handed to the planner (equals `requested` when not refused). */
  strategy: AdvisorStrategy
  /** Strategy the model/cache originally proposed. */
  requested: AdvisorStrategy
  refused: boolean
  reason: string
}

/** The executable strategy to use when `smelt_and_craft` cannot be grounded. */
function replacementStrategy(state: AdvisorState): AdvisorStrategy {
  if (state.discoveredOres.some((ore) => ore.includes('iron'))) return 'return_to_known_ore'
  if (state.toolRank >= 2) return 'branch_mine'
  if (state.toolRank >= 1) return 'explore_cave'
  return 'descend_to_y16'
}

/**
 * Reject strategies that cannot change the body because their inputs do not
 * exist yet. `smelt_and_craft` is only applicable when there is something to
 * smelt AND a furnace to smelt it in; otherwise it is replaced with a strategy
 * the current world can actually ground (`return_to_known_ore` when iron_ore is
 * known, else `branch_mine` / `explore_cave` / `descend_to_y16`).
 */
export function groundStrategy(strategy: AdvisorStrategy, state: AdvisorState): StrategyGrounding {
  if (strategy !== 'smelt_and_craft') {
    return { strategy, requested: strategy, refused: false, reason: 'applicable' }
  }
  const rawMaterial = (state.inventory['raw_iron'] ?? 0) + (state.inventory['iron_ingot'] ?? 0)
  const hasFurnace = (state.stations.furnaces ?? 0) > 0 || (state.inventory['furnace'] ?? 0) > 0
  if (rawMaterial > 0 && hasFurnace) {
    return { strategy, requested: strategy, refused: false, reason: 'furnace + raw material held' }
  }
  const replacement = replacementStrategy(state)
  const reason =
    rawMaterial === 0
      ? 'no raw_iron/iron_ingot to smelt'
      : 'no furnace or placed furnace'
  return { strategy: replacement, requested: strategy, refused: true, reason }
}

/** Stable cache key for an advisor state. Exported so tests can seed the cache. */
export function hashAdvisorState(state: AdvisorState): string {
  const payload = {
    rung: state.rung,
    inventory: state.inventory,
    toolRank: state.toolRank,
    stations: state.stations,
    ores: [...state.discoveredOres].sort(),
    queueCurrent: state.queueCurrent,
    failed: state.failedCandidates,
  }
  return createHash('sha1').update(JSON.stringify(payload)).digest('hex').slice(0, 16)
}

export interface AdvisorOptions {
  log: (event: string, detail?: Record<string, unknown>) => void
  cachePath: string
  mode: 'llm' | 'deterministic'
  model?: string
  minIntervalMs?: number
  timeoutMs?: number
  /** bound on model attempts (default `BUDDY_ADVISOR_MAX_ATTEMPTS` or 3) */
  maxAttempts?: number
  /** resident process terminator; absent in tests (the fatal error is thrown) */
  terminate?: () => never
  /** key resolver seam for tests; defaults to `resolveJevApiKey` */
  resolveKey?: () => KeyResolution | null
  /**
   * Compile a grounded strategy into executable goals. Injected by the planner so
   * the cache stores the PLAN (not just the label) and replays it verbatim.
   */
  compile?: (strategy: AdvisorStrategy, state: AdvisorState) => PlannedGoal[]
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  try {
    return JSON.stringify(error)
  } catch {
    return '<unserialisable>'
  }
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

function isStrategy(value: unknown): value is AdvisorStrategy {
  return typeof value === 'string' && (ADVISOR_STRATEGIES as readonly string[]).includes(value)
}

/** Deterministic strategy choice; always available and never stalls. */
export function fallbackStrategy(state: AdvisorState): AdvisorStrategy {
  const rung = state.rung
  if (rung === 'raw_iron') {
    return state.discoveredOres.includes('iron_ore') ? 'return_to_known_ore' : 'branch_mine'
  }
  if (rung === 'iron_ingot' || rung === 'iron_pickaxe' || rung === 'iron_gear' || rung === 'diamond' || rung === 'diamond_pickaxe') {
    return 'smelt_and_craft'
  }
  if (rung === 'stone_pickaxe' || rung === 'charcoal') return 'branch_mine'
  if (state.toolRank >= 2) return 'branch_mine'
  return 'descend_to_y16'
}

/**
 * Ask the upper LLM for the next strategy. Never throws; every failure is a
 * deterministic fallback. The answer is cached by a live-state hash so repeat
 * stalls on the same state cost $0.
 */
export class Advisor {
  private readonly log: (event: string, detail?: Record<string, unknown>) => void
  private readonly cachePath: string
  private readonly mode: 'llm' | 'deterministic'
  readonly model: string
  private readonly minIntervalMs: number
  private readonly timeoutMs: number
  private readonly maxAttempts: number
  private readonly terminate: (() => never) | undefined
  private readonly resolveKey: () => KeyResolution | null
  private readonly compile: AdvisorOptions['compile']
  private cache: AdvisorCacheFile
  private calls = 0

  constructor(options: AdvisorOptions) {
    this.log = options.log
    this.cachePath = options.cachePath
    this.mode = options.mode
    this.model = options.model ?? process.env.BUDDY_ADVISOR_MODEL ?? DEFAULT_JEV_MODEL
    this.minIntervalMs = options.minIntervalMs ?? Number(process.env.BUDDY_ADVISOR_MIN_INTERVAL_MS ?? 30000)
    this.timeoutMs = options.timeoutMs ?? Number(process.env.BUDDY_ADVISOR_TIMEOUT_MS ?? 8000)
    this.maxAttempts = options.maxAttempts ?? Number(process.env.BUDDY_ADVISOR_MAX_ATTEMPTS ?? 3)
    this.terminate = options.terminate
    this.resolveKey = options.resolveKey ?? resolveJevApiKey
    this.compile = options.compile
    this.cache = this.loadCache()
    this.log('ADVISOR_CACHE_GUARD', {
      active: true,
      version: 2,
      maxReplays: MAX_CACHE_REPLAYS,
      maxConsecutive: MAX_CONSECUTIVE_CACHED,
    })
  }

  async decide(state: AdvisorState, reason: AdvisorReason): Promise<AdvisorDecision> {
    const started = Date.now()
    const fallback = fallbackStrategy(state)

    if (this.mode === 'deterministic') {
      return this.deliver(groundStrategy(fallback, state), 'fallback', reason, 0, started, false, 'advisor disabled (deterministic mode)', state)
    }

    const stateHash = this.hashState(state)
    const cached = this.cache.entries[stateHash]
    let bypassed = false
    if (cached !== undefined) {
      const replays = cached.replays ?? 0
      const consecutive = this.cache.consecutiveStrategy === cached.strategy ? this.cache.consecutiveCount ?? 0 : 0
      const replayLimit = replays >= MAX_CACHE_REPLAYS
      const consecutiveLimit = consecutive >= MAX_CONSECUTIVE_CACHED
      if (replayLimit || consecutiveLimit) {
        const bypass = replayLimit ? 'repeat_no_progress' : 'consecutive_same_strategy'
        this.log('ADVISOR_CACHE bypass', {
          reason: bypass,
          strategy: cached.strategy,
          stateHash,
          replays,
          consecutive,
        })
        this.resetConsecutive()
        bypassed = true
      } else {
        cached.replays = replays + 1
        this.bumpConsecutive(cached.strategy)
        this.saveCache()
        const decision: AdvisorDecision = {
          strategy: cached.strategy,
          source: 'llm',
          reason,
          costUsd: 0,
          ms: Date.now() - started,
          cached: true,
          note: `cached advisor plan (${cached.strategy})`,
          ...(cached.goals !== undefined ? { goals: cached.goals } : {}),
        }
        this.logDecision(decision)
        return decision
      }
    }

    const key = this.resolveKey()
    if (key === null) {
      return this.failFatally(new FatalModelError('advisor-no-key', 1, 'no gateway key resolved'))
    }

    const now = Date.now()
    if (!bypassed && this.calls > 0 && now - this.cache.lastCallAt < this.minIntervalMs) {
      // Rate control, not a model failure: wait out the throttle, then ask the model.
      // Live mode must never degrade to a deterministic/fallback decision here.
      const waitMs = this.minIntervalMs - (now - this.cache.lastCallAt)
      if (Number.isFinite(waitMs) && waitMs > 0) {
        this.log('ADVISOR_THROTTLE_WAIT', { waitMs, minIntervalMs: this.minIntervalMs })
        await new Promise<void>((resolve) => setTimeout(resolve, waitMs))
      }
    }

    try {
      const result = await withModelRetries(
        'advisor',
        this.maxAttempts,
        async () => {
          process.env.AI_GATEWAY_API_KEY = key.key
          const questions = {
            next_strategy: {
              type: 'choice',
              instructions: STRATEGY_INSTRUCTIONS,
              criteria: STRATEGY_CRITERIA,
            },
          } satisfies Record<string, Experimental_EvaluationQuestion>
          const response = await evaluate({
            model: this.model,
            state: JSON.parse(JSON.stringify(state)) as Parameters<typeof evaluate>[0]['state'],
            questions,
            maxRetries: 0,
            abortSignal: AbortSignal.timeout(this.timeoutMs),
          })
          const answers = response.answers as Record<string, unknown>
          const raw = answers.next_strategy
          const choice = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>).choice : undefined
          if (!isStrategy(choice)) throw new Error(`unknown strategy ${String(choice)}`)
          return { choice, response }
        },
        {
          onRetry: ({ attempt, nextAttempt, error }) => {
            this.log('ADVISOR_RETRY', { attempt, nextAttempt, error: describeError(error) })
          },
        },
      )
      this.calls += 1
      const { choice, response } = result
      const inputTokens = response.usage.inputTokens ?? 0
      const outputTokens = response.usage.outputTokens ?? 0
      const costUsd = (inputTokens + outputTokens) * COST_PER_TOKEN_USD
      this.cache.lastCallAt = Date.now()
      const grounded = groundStrategy(choice, state)
      if (grounded.refused) this.logRefusal(grounded)
      const goals = this.compile?.(grounded.strategy, state)
      this.cache.entries[stateHash] = {
        strategy: grounded.strategy,
        costUsd,
        ts: Date.now(),
        ...(goals !== undefined ? { goals } : {}),
        replays: 0,
      }
      this.resetConsecutive()
      this.trimCache()
      this.saveCache()
      const decision: AdvisorDecision = {
        strategy: grounded.strategy,
        source: 'llm',
        reason,
        costUsd,
        ms: Date.now() - started,
        cached: false,
        note: `llm chose ${grounded.strategy}`,
        ...(goals !== undefined ? { goals } : {}),
      }
      this.logDecision(decision)
      return decision
    } catch (error) {
      const fatal = error instanceof FatalModelError ? error : new FatalModelError('advisor', this.maxAttempts, describeError(error))
      return this.failFatally(fatal)
    }
  }

  private failFatally(error: FatalModelError): never {
    return failLoud(error, this.log, this.terminate)
  }

  private deliver(
    grounded: StrategyGrounding,
    source: 'llm' | 'fallback',
    reason: AdvisorReason,
    costUsd: number,
    started: number,
    cached: boolean,
    note: string,
    state: AdvisorState,
  ): AdvisorDecision {
    if (grounded.refused) this.logRefusal(grounded)
    const goals = this.compile?.(grounded.strategy, state)
    this.resetConsecutive()
    const decision: AdvisorDecision = {
      strategy: grounded.strategy,
      source,
      reason,
      costUsd,
      ms: Date.now() - started,
      cached,
      note,
      ...(goals !== undefined ? { goals } : {}),
    }
    this.logDecision(decision)
    return decision
  }

  private logRefusal(grounded: StrategyGrounding): void {
    this.log('STRATEGY_REFUSED', {
      reason: grounded.reason,
      strategy: grounded.requested,
      replacement: grounded.strategy,
    })
  }

  private bumpConsecutive(strategy: AdvisorStrategy): void {
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

  private logDecision(decision: AdvisorDecision): void {
    this.log('ADVISOR', {
      source: decision.source,
      reason: decision.reason,
      strategy: decision.strategy,
      cost: Number(decision.costUsd.toFixed(6)),
      ms: decision.ms,
      cached: decision.cached,
      note: decision.note,
    })
  }

  private hashState(state: AdvisorState): string {
    return hashAdvisorState(state)
  }

  private loadCache(): AdvisorCacheFile {
    try {
      if (!existsSync(this.cachePath)) return emptyCache()
      const parsed = JSON.parse(readFileSync(this.cachePath, 'utf8')) as Partial<AdvisorCacheFile>
      if (parsed.version !== 2 || typeof parsed.lastCallAt !== 'number' || typeof parsed.entries !== 'object' || parsed.entries === null) {
        return emptyCache()
      }
      const entries: Record<string, AdvisorCacheEntry> = {}
      for (const [hash, entry] of Object.entries(parsed.entries)) {
        if (entry !== null && typeof entry === 'object' && isStrategy((entry as AdvisorCacheEntry).strategy)) {
          entries[hash] = entry as AdvisorCacheEntry
        }
      }
      const consecutiveStrategy = isStrategy(parsed.consecutiveStrategy) ? parsed.consecutiveStrategy : null
      return {
        version: 2,
        lastCallAt: parsed.lastCallAt,
        entries,
        consecutiveStrategy,
        consecutiveCount: typeof parsed.consecutiveCount === 'number' ? parsed.consecutiveCount : 0,
      }
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
      this.log('ERROR', { where: 'advisor.saveCache', message: describeError(error) })
    }
  }

  private trimCache(): void {
    const entries = Object.entries(this.cache.entries)
    if (entries.length <= MAX_CACHE_ENTRIES) return
    entries.sort((a, b) => b[1].ts - a[1].ts)
    this.cache.entries = Object.fromEntries(entries.slice(0, MAX_CACHE_ENTRIES))
  }
}
