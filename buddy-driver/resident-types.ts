// resident-types.ts - the HOST <-> RELOADABLE-GENERATION contract.
//
// The host owns the Mineflayer connection, the reconnect loop, the log and the
// durable state mirror. The generation owns one version of the jev-agent
// intelligence (controller + planner), bundled as ONE hash-stamped ESM file and
// swapped atomically on hot reload.
//
// This file is imported with `import type` only, so the host's native TypeScript
// stripping removes it completely (no runtime import, no cycle).
import type { Bot } from 'mineflayer'
import type { GoalQueueState } from '../jev-agent/src/goalQueue.ts'

/** Bump when the host/generation interface changes incompatibly. */
export const CONTRACT_VERSION = 1

export interface Vec3Json {
  x: number
  y: number
  z: number
}

/**
 * Durable world model that must survive reloads/reconnects. Inventory and
 * position are NOT mirrored here - they stay live on the bot (the single truth);
 * this holds only knowledge the bot cannot re-derive cheaply.
 */
export interface ResidentWorldMemory {
  /** placed crafting_table stations discovered by scanning the loaded world */
  craftingTables: Vec3Json[]
  /** placed furnace stations discovered by scanning the loaded world */
  furnaces: Vec3Json[]
  /** "x,y,z:block" -> times mined (depletion model, best-effort) */
  mined: Record<string, number>
  /** ore block names seen at least once in the world state */
  discoveredOres: string[]
}

export function emptyWorldMemory(): ResidentWorldMemory {
  return { craftingTables: [], furnaces: [], mined: {}, discoveredOres: [] }
}

/** The atomic mirror written to buddy-state.json (tmp -> rename). */
export interface ResidentState {
  version: number
  bot: string
  firstSeenAt: number
  updatedAt: number
  /** highest ladder rung index the bot has satisfied */
  milestoneIndex: number
  /** id of that rung (e.g. "iron_pickaxe") */
  milestone: string | null
  /** last seen goal-queue snapshot (ledger mirror) */
  ledger: unknown | null
  worldMemory: ResidentWorldMemory
  /** how many generations have been attached in this process lifetime */
  generations: number
  /** how many hot reloads were performed */
  reloads: number
  /** how many times the host recovered after the controller stopped */
  recoveries: number
  lastGenerationId: string | null
  /** monotonic action counter for ACTION log lines */
  actions: number
}

/** A read-only projection of the running generation, used by host logging/control. */
export interface GenerationStatus {
  running: boolean
  policyKind: string
  policyModel: string
  system2Model: string
  queue: GoalQueueState
  currentAction: { id: string; kind: string; phase: string; startedAt: number } | null
  position: Vec3Json | null
  health: number | null
  inventory: Record<string, number>
  /** number of goals this generation's planner will seed on start() */
  plannedGoals: number
  /** index of the first unsatisfied ladder rung (progress frontier) */
  rungIndex: number
  /** id of that rung */
  rungId: string
}

/**
 * One generation of the reloadable intelligence. `quiesce()` must cancel every
 * in-flight action, stop the scheduler and persist the goal-queue ledger, while
 * leaving the Mineflayer connection untouched.
 */
export interface ResidentGeneration {
  readonly id: string
  readonly startedAt: number
  readonly rungIndex: number
  readonly rungId: string
  /** register listeners only (no timers). Called before start(). */
  attach(): void
  /** begin scheduling. */
  start(): void
  /** stop timers/actions and persist; resolves after the in-flight action settles (bounded). */
  quiesce(): Promise<void>
  /** best-effort synchronous teardown. */
  dispose(): void
  status(): GenerationStatus
  /** controller stop reason, once it has stopped; null while running. */
  stopReason(): string | null
  /** true after the controller stopped for any reason */
  hasStopped(): boolean
}

export interface GenerationContext {
  bot: Bot
  /** structured log line: host prefixes the ISO timestamp; detail is JSON. */
  log: (event: string, detail?: Record<string, unknown>) => void
  /** the live durable state (mutate in place; the host mirrors it). */
  state: ResidentState
  /** goal-queue ledger path handed to the controller. */
  ledgerPath: string
  /** jsonl log dir handed to the controller. */
  logDir: string
  /** configured objective seed. */
  goalItem: string
  goalCount: number
}

export interface GenerationModule {
  CONTRACT_VERSION: number
  createGeneration(ctx: GenerationContext): ResidentGeneration
}
