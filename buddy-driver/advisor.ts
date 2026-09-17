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
// Failure (missing key, timeout, 429, malformed answer) falls back to the
// deterministic ladder immediately and logs `ADVISOR source=fallback`. In
// deterministic planner mode the LLM is never called, so `llm.called==false`
// stays provable.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { experimental_evaluate as evaluate } from 'ai'
import type { Experimental_EvaluationQuestion } from 'ai'
import { DEFAULT_JEV_MODEL, resolveJevApiKey } from '../jev-agent/src/jev.ts'

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
}

interface AdvisorCacheEntry {
  strategy: AdvisorStrategy
  costUsd: number
  ts: number
}

interface AdvisorCacheFile {
  version: 1
  lastCallAt: number
  entries: Record<string, AdvisorCacheEntry>
}

const MAX_CACHE_ENTRIES = 120

function emptyCache(): AdvisorCacheFile {
  return { version: 1, lastCallAt: 0, entries: {} }
}

export interface AdvisorOptions {
  log: (event: string, detail?: Record<string, unknown>) => void
  cachePath: string
  mode: 'llm' | 'deterministic'
  model?: string
  minIntervalMs?: number
  timeoutMs?: number
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
  private cache: AdvisorCacheFile
  private calls = 0

  constructor(options: AdvisorOptions) {
    this.log = options.log
    this.cachePath = options.cachePath
    this.mode = options.mode
    this.model = options.model ?? process.env.BUDDY_ADVISOR_MODEL ?? DEFAULT_JEV_MODEL
    this.minIntervalMs = options.minIntervalMs ?? Number(process.env.BUDDY_ADVISOR_MIN_INTERVAL_MS ?? 30000)
    this.timeoutMs = options.timeoutMs ?? Number(process.env.BUDDY_ADVISOR_TIMEOUT_MS ?? 8000)
    this.cache = this.loadCache()
  }

  async decide(state: AdvisorState, reason: AdvisorReason): Promise<AdvisorDecision> {
    const started = Date.now()
    const fallback = fallbackStrategy(state)

    if (this.mode === 'deterministic') {
      const decision: AdvisorDecision = {
        strategy: fallback,
        source: 'fallback',
        reason,
        costUsd: 0,
        ms: Date.now() - started,
        cached: false,
        note: 'advisor disabled (deterministic mode)',
      }
      this.logDecision(decision)
      return decision
    }

    const key = resolveJevApiKey()
    if (key === null) {
      const decision: AdvisorDecision = {
        strategy: fallback,
        source: 'fallback',
        reason,
        costUsd: 0,
        ms: Date.now() - started,
        cached: false,
        note: 'no gateway key',
      }
      this.logDecision(decision)
      return decision
    }

    const stateHash = this.hashState(state)
    const cached = this.cache.entries[stateHash]
    if (cached !== undefined) {
      const decision: AdvisorDecision = {
        strategy: cached.strategy,
        source: 'llm',
        reason,
        costUsd: 0,
        ms: Date.now() - started,
        cached: true,
        note: `cached advisor strategy (${cached.strategy})`,
      }
      this.logDecision(decision)
      return decision
    }

    const now = Date.now()
    if (this.calls > 0 && now - this.cache.lastCallAt < this.minIntervalMs) {
      const decision: AdvisorDecision = {
        strategy: fallback,
        source: 'fallback',
        reason,
        costUsd: 0,
        ms: Date.now() - started,
        cached: false,
        note: `throttled ${now - this.cache.lastCallAt}ms < ${this.minIntervalMs}ms`,
      }
      this.logDecision(decision)
      return decision
    }

    try {
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
      this.calls += 1
      const answers = response.answers as Record<string, unknown>
      const raw = answers.next_strategy
      const choice = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>).choice : undefined
      const inputTokens = response.usage.inputTokens ?? 0
      const outputTokens = response.usage.outputTokens ?? 0
      const costUsd = (inputTokens + outputTokens) * COST_PER_TOKEN_USD
      this.cache.lastCallAt = Date.now()
      if (isStrategy(choice)) {
        this.cache.entries[stateHash] = { strategy: choice, costUsd, ts: Date.now() }
        this.trimCache()
        this.saveCache()
        const decision: AdvisorDecision = {
          strategy: choice,
          source: 'llm',
          reason,
          costUsd,
          ms: Date.now() - started,
          cached: false,
          note: `llm chose ${choice}`,
        }
        this.logDecision(decision)
        return decision
      }
      const decision: AdvisorDecision = {
        strategy: fallback,
        source: 'fallback',
        reason,
        costUsd,
        ms: Date.now() - started,
        cached: false,
        note: `unknown strategy ${String(choice)} -> ${fallback}`,
      }
      this.logDecision(decision)
      return decision
    } catch (error) {
      const kind = isRateLimitError(error) ? 'rate_limited' : 'llm_error'
      const decision: AdvisorDecision = {
        strategy: fallback,
        source: 'fallback',
        reason,
        costUsd: 0,
        ms: Date.now() - started,
        cached: false,
        note: `${kind}: ${describeError(error)}`,
      }
      this.logDecision(decision)
      return decision
    }
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

  private loadCache(): AdvisorCacheFile {
    try {
      if (!existsSync(this.cachePath)) return emptyCache()
      const parsed = JSON.parse(readFileSync(this.cachePath, 'utf8')) as Partial<AdvisorCacheFile>
      if (typeof parsed.lastCallAt !== 'number' || typeof parsed.entries !== 'object' || parsed.entries === null) {
        return emptyCache()
      }
      const entries: Record<string, AdvisorCacheEntry> = {}
      for (const [hash, entry] of Object.entries(parsed.entries)) {
        if (entry !== null && typeof entry === 'object' && isStrategy((entry as AdvisorCacheEntry).strategy)) {
          entries[hash] = entry as AdvisorCacheEntry
        }
      }
      return { version: 1, lastCallAt: parsed.lastCallAt, entries }
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
