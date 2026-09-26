// digTruth.ts - the authoritative break-time truth for a dig, and the bounded
// mechanism race around it.
//
// MEASURED DEFECT (live M3, source f13aac2 / cb3e4ed, run-mubbsnde-1jzm5):
// every `MINE:*_9` on the verified obsidian column (25..28, 66..70, 9) died as
// `dig_timeout` after exactly 15000ms with `progressDelta=0`, holding a
// diamond pickaxe (`TOOL_CHOICE block=obsidian tool=pickaxe tier=4`). The
// candidate was `reachable`, the block real (read-only scan), so the boundary
// is the dig mechanism itself, not the approach.
//
// Root cause: `bot.dig()` schedules its own client-side STOP from
// `bot.digTime(block)` (mineflayer 4.39.0 `lib/plugins/digging.js`), and
// prismarine-block prices the block from `registry.materials[block.material]`.
// On 1.21 the hard blocks (obsidian / iron_ore / diamond_ore / ancient_debris)
// carry the tag-material `incorrect_for_wooden_tool`, whose minecraft-data
// 3.116.0 entry lists ONLY the wooden tool ids (912..915 -> speed 2). A diamond
// pickaxe (938) therefore has no multiplier, `isBestTool` is false, the speed
// falls back to 1, and obsidian is priced at 75000ms instead of the real
// 9375ms - while the executor cancels at a flat 15000ms. Grounding the body
// (cb3e4ed) removes the separate airborne /5, taking 375000ms to 75000ms, but
// 75000ms is still far past the budget, so the failure persists.
//
// Two code-owned truths follow, both deterministic:
//   1. the break-speed data the mechanism reads must describe the tools that
//      actually harvest the block (`correctDigSpeedMaterials`);
//   2. the cancel budget must cover whatever the mechanism itself schedules,
//      never a hard-coded number shorter than it (`planDigTime`).
import type { Vec3Json } from './state.ts'

/** Vanilla tool-material break-speed multipliers (`TieredItem`/`ToolMaterial`). */
const TOOL_MATERIAL_SPEEDS: ReadonlyArray<readonly [string, number]> = [
  ['wooden', 2],
  ['golden', 12],
  ['stone', 4],
  ['iron', 6],
  ['diamond', 8],
  ['netherite', 9],
]

/** The multiplier for `itemName` (`diamond_pickaxe` -> 8); 1 for hand/unknown. */
export function toolMaterialSpeed(itemName: string | null | undefined): number {
  if (itemName === null || itemName === undefined || itemName.length === 0) return 1
  const separator = itemName.indexOf('_')
  if (separator <= 0) return 1
  const material = itemName.slice(0, separator)
  const entry = TOOL_MATERIAL_SPEEDS.find(([name]) => name === material)
  return entry === undefined ? 1 : entry[1]
}

/** The minimum facts of the target block the truth model needs. */
export interface DigBlockFacts {
  /** registry hardness (`obsidian` 50) */
  hardness: number
  /** true when the held tool can harvest the block (`Block#canHarvest`) */
  canHarvest: boolean
  /** material speed multiplier of the held tool, 1 when hand/wrong tool */
  toolSpeed: number
  /** physically grounded - the block-grid truth, not the stale physics flag */
  onGround: boolean
  /** eyes submerged in water */
  inWater: boolean
}

/**
 * The vanilla break time (`AbstractBlock#calcBlockBreakingDelta`) in ms. This
 * mirrors prismarine-block's `digTime` arithmetic exactly, with the tool speed
 * supplied by the caller instead of the (broken) material lookup, so it can be
 * used to check the mechanism's own answer.
 */
export function expectedDigTimeMs(facts: DigBlockFacts): number {
  if (!Number.isFinite(facts.hardness) || facts.hardness < 0) return Number.POSITIVE_INFINITY
  let speed = facts.toolSpeed
  if (!facts.onGround) speed /= 5
  if (facts.inWater) speed /= 5
  const multiplier = facts.canHarvest ? 30 : 100
  const delta = speed / facts.hardness / multiplier
  if (delta <= 0) return Number.POSITIVE_INFINITY
  if (delta >= 1) return 0
  return Math.ceil(1 / delta) * 50
}

/** Fixed slack (ms) added after the mechanism's schedule for packet/tick jitter. */
export const DIG_BUDGET_SLACK_MS = 2000
/** Hard ceiling so a genuinely impossible dig still fails typed and bounded. */
export const DIG_BUDGET_MAX_MS = 60_000

export interface DigTimePlan {
  /** the mechanism's own scheduled client-side break time (`bot.digTime`) */
  libraryMs: number
  /** the cancel budget: the configured floor, or the mechanism's schedule + slack */
  budgetMs: number
  /** the configured floor (`ExecutorOptions.digTimeoutMs`) */
  configuredMs: number
  /** true when the budget had to grow past the configured floor */
  extended: boolean
}

/**
 * Size the dig cancel budget from the mechanism's own schedule instead of a
 * fixed number. The configured `digTimeoutMs` is a FLOOR (so cheap digs keep
 * their tight bound); a dig the mechanism itself schedules past
 * `floor - slack` gets its schedule + slack, up to `maxMs`. A non-finite
 * schedule (mineflayer throws `dig time ... is Infinity` before digging) leaves
 * the floor in place so the typed `dig_error` still surfaces.
 */
export function planDigTime(
  libraryMs: number,
  configuredMs: number,
  maxMs: number = DIG_BUDGET_MAX_MS,
): DigTimePlan {
  const finite = Number.isFinite(libraryMs)
  const safeLibrary = finite ? Math.max(0, libraryMs) : 0
  const derived = safeLibrary + DIG_BUDGET_SLACK_MS
  const budgetMs = Math.min(Math.max(configuredMs, derived), Math.max(configuredMs, maxMs))
  return {
    libraryMs: finite ? safeLibrary : Number.POSITIVE_INFINITY,
    budgetMs,
    configuredMs,
    extended: budgetMs > configuredMs,
  }
}

export function formatDigBudget(plan: DigTimePlan): string {
  return `DIG_BUDGET clientMs=${plan.libraryMs} budgetMs=${plan.budgetMs} configuredMs=${plan.configuredMs} extended=${plan.extended}`
}

/**
 * The typed, mirrored dig failure. Before this marker the only trace was
 * `CAUSAL ... verified=false status=failed resource=obsidian progressDelta=0`,
 * which names the symptom but not which layer gave up or with which tool.
 */
export interface DigFailureFacts {
  /** `dig_timeout` | `dig_error` | `dig_no_tool` | `out_of_reach` | ... */
  reason: string
  tool: string | null
  tier: number | null
  block: Vec3Json
  expectedMs: number | null
  elapsedMs: number
}

export function formatDigFailed(facts: DigFailureFacts): string {
  const expected = facts.expectedMs === null ? 'unknown' : String(Math.round(facts.expectedMs))
  return (
    `DIG_FAILED reason=${facts.reason} tool=${facts.tool ?? 'hand'} tier=${facts.tier ?? 0} ` +
    `block=${facts.block.x},${facts.block.y},${facts.block.z} expectedMs=${expected} elapsedMs=${Math.round(facts.elapsedMs)}`
  )
}

// ---------------------------------------------------------------------------
// mechanism data repair
// ---------------------------------------------------------------------------

interface RegistryBlock {
  material?: unknown
  harvestTools?: Record<string, boolean> | null
}

/** The slice of `bot.registry` the repair needs (prismarine-registry shape). */
export interface DigSpeedRegistry {
  materials?: Record<string, Record<string | number, number>> | undefined
  blocksArray?: ReadonlyArray<RegistryBlock> | undefined
  items?: Record<string, { name?: string } | undefined> | undefined
}

/**
 * Repair the break-speed data the dig mechanism reads. minecraft-data's 1.21
 * `incorrect_for_<material>_tool` entries do not list the tools that actually
 * harvest the tagged blocks, so prismarine-block's `materialToolMultipliers`
 * lookup misses them and prices obsidian at speed 1 (75000ms vs 9375ms).
 *
 * The authoritative source is already present: each block's `harvestTools` names
 * exactly the tools that can harvest it, and the tool id's material names its
 * speed. Fill the missing entries in place. Idempotent; returns how many entries
 * were added (0 on a registry that is already correct).
 */
export function correctDigSpeedMaterials(registry: unknown): number {
  const r = registry as DigSpeedRegistry | null | undefined
  if (r === null || r === undefined) return 0
  const materials = r.materials
  const blocks = r.blocksArray
  const items = r.items
  if (materials === undefined || blocks === undefined || items === undefined) return 0

  let added = 0
  for (const block of blocks) {
    const material = typeof block.material === 'string' ? block.material : null
    if (material === null || !material.startsWith('incorrect_for_')) continue
    const table = materials[material]
    if (table === undefined) continue
    const harvestTools = block.harvestTools
    if (harvestTools === null || harvestTools === undefined) continue
    for (const toolId of Object.keys(harvestTools)) {
      if (harvestTools[toolId] !== true) continue
      if (table[toolId] !== undefined) continue
      const itemName = items[toolId]?.name
      if (typeof itemName !== 'string') continue
      const speed = toolMaterialSpeed(itemName)
      if (speed <= 1) continue
      table[toolId] = speed
      added += 1
    }
  }
  return added
}

export function formatDigSpeedRepaired(entries: number): string {
  return `DIG_SPEED_DATA_REPAIRED entries=${entries} reason=incorrect_for_wooden_tool_missing_harvest_tools`
}

// ---------------------------------------------------------------------------
// bounded mechanism race
// ---------------------------------------------------------------------------

/**
 * The minimal mineflayer dig surface the bounded race needs. `digTime()` is the
 * mechanism's own scheduled break time (what its internal `setTimeout` uses);
 * `dig()` resolves when the block breaks and rejects when it is aborted.
 */
export interface DigMechanism {
  digTime(): number
  dig(): Promise<void>
  stopDigging(): void
}

export type DigRaceOutcome = 'done' | 'timeout' | 'error'

export interface DigRaceResult {
  outcome: DigRaceOutcome
  error: string | null
  elapsedMs: number
  /** the mechanism's scheduled break time at dig start */
  scheduledMs: number
}

/**
 * Run one dig against the mechanism, cancelling it at `budgetMs`. `timeout`
 * means the cancellation fired; `error` is any other mechanism rejection. The
 * timer always fires *before* the mechanism's own schedule when the plan is
 * correct, so a `timeout` is a real stall, not a slow block.
 */
export async function runBoundedDig(
  mechanism: DigMechanism,
  budgetMs: number,
  now: () => number = Date.now,
): Promise<DigRaceResult> {
  // A malformed block (no `digTime`) must surface as a typed error, not escape
  // the race as an unhandled rejection.
  let scheduledMs: number
  try {
    scheduledMs = mechanism.digTime()
  } catch (error) {
    return {
      outcome: 'error',
      error: error instanceof Error ? error.message : String(error),
      elapsedMs: 0,
      scheduledMs: Number.NaN,
    }
  }
  const startedAt = now()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    mechanism.stopDigging()
  }, budgetMs)
  try {
    await mechanism.dig()
    return { outcome: 'done', error: null, elapsedMs: now() - startedAt, scheduledMs }
  } catch (error) {
    return {
      outcome: timedOut ? 'timeout' : 'error',
      error: error instanceof Error ? error.message : String(error),
      elapsedMs: now() - startedAt,
      scheduledMs,
    }
  } finally {
    clearTimeout(timer)
  }
}
