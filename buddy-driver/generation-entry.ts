// generation-entry.ts - the RELOADABLE layer.
//
// esbuild bundles this file (and everything it imports from ../jev-agent/src/**)
// into ONE hash-stamped ESM file. The host then `import()`s that single file: one
// file == one URL == the whole generation swaps atomically, so a new controller
// can never be wired to stale sibling modules.
//
// The generation wraps the battle-tested `JevController` (System One remains the
// sole action authority). The long-horizon planner is a deterministic, inventory-
// aware "resident ladder" supplied once via the canonical single-shot contract,
// so the goal-queue ledger restore path is preserved across reloads/reconnects.
import type { Bot } from 'mineflayer'
import { existsSync, readFileSync, renameSync } from 'node:fs'
import { Vec3 } from 'vec3'
import { JevController } from '../jev-agent/src/controller.ts'
import type { JevAgentOptions, RunSummary } from '../jev-agent/src/controller.ts'
import { FixedPlanSystem2 } from '../jev-agent/src/system2.ts'
import type { PlannedGoal } from '../jev-agent/src/goalQueue.ts'
import { matchesResourceClass } from '../jev-agent/src/resourceClass.ts'
import type { ResourceClass } from '../jev-agent/src/resourceClass.ts'
import type {
  GenerationContext,
  GenerationStatus,
  ResidentGeneration,
  ResidentWorldMemory,
  Vec3Json,
} from './resident-types.ts'

export const CONTRACT_VERSION = 1

type Counts = Record<string, number>

function inventoryCounts(bot: Bot): Counts {
  const counts: Counts = {}
  for (const item of bot.inventory.items()) counts[item.name] = (counts[item.name] ?? 0) + item.count
  return counts
}

function countClass(counts: Counts, cls: ResourceClass): number {
  let total = 0
  for (const [name, n] of Object.entries(counts)) {
    if (matchesResourceClass(name, cls)) total += n
  }
  return total
}

function has(counts: Counts, name: string): boolean {
  return (counts[name] ?? 0) > 0
}

function bestPickaxeRank(counts: Counts): number {
  // 0 none, 1 wooden, 2 stone, 3 iron, 4 diamond+
  const order = ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe']
  let rank = 0
  for (let i = 0; i < order.length; i += 1) {
    if (has(counts, order[i]!)) rank = Math.max(rank, i + 1)
  }
  return rank
}

function woodUnits(counts: Counts): number {
  return countClass(counts, 'log') + Math.floor(countClass(counts, 'planks') / 4)
}

interface Rung {
  id: string
  satisfied: (c: Counts, w: ResidentWorldMemory) => boolean
  goals: (c: Counts, w: ResidentWorldMemory) => PlannedGoal[]
}

function climb(rungId: string, c: Counts, ingots: number, have: number, crafts: Array<[string, number]>): PlannedGoal[] {
  const out: PlannedGoal[] = []
  const missing = Math.max(0, ingots - have)
  if (missing > 0) {
    out.push({ kind: 'collect', description: `collect ${missing} x raw_iron`, targetItem: 'raw_iron', requiredCount: missing })
    out.push({ kind: 'smelt', description: `smelt ${missing} x iron_ingot`, targetItem: 'iron_ingot', requiredCount: missing })
  }
  for (const [item, n] of crafts) {
    if ((c[item] ?? 0) < n) out.push({ kind: 'craft', description: `craft ${n} x ${item}`, targetItem: item, requiredCount: n })
  }
  if (out.length === 0) {
    out.push({ kind: 'craft', description: `${rungId}: craft iron_chestplate`, targetItem: 'iron_chestplate', requiredCount: 1 })
  }
  return out
}

/** The ordered capability ladder. Each rung states its own completion in inventory/world terms. */
const RUNGS: readonly Rung[] = [
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
      { kind: 'collect', description: 'collect 3 x raw_iron', targetItem: 'raw_iron', requiredCount: Math.max(1, 3 - ((c['raw_iron'] ?? 0) + (c['iron_ingot'] ?? 0))) },
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
    id: 'diamond',
    satisfied: (c) => has(c, 'diamond'),
    goals: () => [{ kind: 'collect', description: 'collect 1 x diamond', targetItem: 'diamond', requiredCount: 1 }],
  },
  {
    id: 'diamond_pickaxe',
    satisfied: (c) => has(c, 'diamond_pickaxe'),
    goals: () => [{ kind: 'craft', description: 'craft 1 x diamond_pickaxe', targetItem: 'diamond_pickaxe', requiredCount: 1 }],
  },
  {
    id: 'iron_gear',
    satisfied: (c) =>
      has(c, 'iron_chestplate') && has(c, 'iron_leggings') && has(c, 'iron_helmet') && has(c, 'iron_boots') && has(c, 'iron_sword'),
    goals: (c) =>
      climb(
        'iron_gear',
        c,
        26,
        (c['raw_iron'] ?? 0) + (c['iron_ingot'] ?? 0),
        [
          ['iron_chestplate', 1],
          ['iron_leggings', 1],
          ['iron_helmet', 1],
          ['iron_boots', 1],
          ['iron_sword', 1],
        ],
      ),
  },
]

interface Ladder {
  goals: PlannedGoal[]
  rungIndex: number
  rungId: string
}

function buildLadder(counts: Counts, world: ResidentWorldMemory): Ladder {
  const goals: PlannedGoal[] = []
  let rungIndex = RUNGS.length
  let rungId = 'complete'
  for (let i = 0; i < RUNGS.length; i += 1) {
    const rung = RUNGS[i]!
    if (rung.satisfied(counts, world)) continue
    if (rungIndex === RUNGS.length) {
      rungIndex = i
      rungId = rung.id
    }
    for (const goal of rung.goals(counts, world)) goals.push(goal)
  }
  if (goals.length === 0) {
    // Everything on the ladder is satisfied: keep the resident meaningfully busy
    // with a repeatable resource goal instead of idling.
    goals.push({ kind: 'collect', description: 'collect 16 x raw_iron (resident upkeep)', targetItem: 'raw_iron', requiredCount: 16 })
  }
  return { goals, rungIndex, rungId }
}

function computeFrontier(counts: Counts, world: ResidentWorldMemory): { rungIndex: number; rungId: string } {
  for (let i = 0; i < RUNGS.length; i += 1) {
    const rung = RUNGS[i]!
    if (!rung.satisfied(counts, world)) return { rungIndex: i, rungId: rung.id }
  }
  return { rungIndex: RUNGS.length, rungId: 'complete' }
}

function roundPos(p: Vec3Json): string {
  return `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`
}

function mergeStations(target: Vec3Json[], found: Vec3Json[]): number {
  const seen = new Set(target.map(roundPos))
  let added = 0
  for (const pos of found) {
    const key = roundPos(pos)
    if (seen.has(key)) continue
    seen.add(key)
    target.push({ x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) })
    added += 1
  }
  return added
}

function scanBlockPositions(bot: Bot, blockNames: readonly string[], maxDistance: number, cap: number): Vec3Json[] {
  const ids: number[] = []
  for (const name of blockNames) {
    const block = bot.registry.blocksByName[name]
    if (block !== undefined) ids.push(block.id)
  }
  if (ids.length === 0) return []
  try {
    const positions = bot.findBlocks({ matching: ids, maxDistance, count: cap })
    return positions.map((pos) => ({ x: pos.x, y: pos.y, z: pos.z }))
  } catch {
    return []
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

interface LedgerGoal {
  targetItem?: string | null
  status?: string
}

interface LedgerSnapshot {
  counter?: number
  goals?: LedgerGoal[]
}

const PICKAXE_RANK: Record<string, number> = {
  wooden_pickaxe: 1,
  stone_pickaxe: 2,
  iron_pickaxe: 3,
  diamond_pickaxe: 4,
}

/**
 * A dead bot drops its inventory; the goal-queue ledger then claims goals that
 * are no longer true. Restoring it makes the agent mine stone bare-handed. The
 * ledger is accepted only when every recorded tool/station still exists in the
 * live world or inventory (consumables like ingots/logs are excluded - those are
 * legitimately spent and their rungs express the current front, not history).
 */
function ledgerIsConsistent(ledger: LedgerSnapshot, counts: Counts, world: ResidentWorldMemory): boolean {
  const done = new Set<string>()
  for (const goal of ledger.goals ?? []) {
    if (goal.status === 'done' && typeof goal.targetItem === 'string') done.add(goal.targetItem)
  }
  for (const [item, rank] of Object.entries(PICKAXE_RANK)) {
    if (done.has(item) && bestPickaxeRank(counts) < rank) return false
  }
  if (done.has('crafting_table') && !(has(counts, 'crafting_table') || world.craftingTables.length > 0)) return false
  if (done.has('furnace') && !(has(counts, 'furnace') || world.furnaces.length > 0)) return false
  return true
}

function resolveLedgerPath(ctx: GenerationContext, counts: Counts, world: ResidentWorldMemory): string | null {
  const path = ctx.ledgerPath
  if (!existsSync(path)) return path
  try {
    const ledger = JSON.parse(readFileSync(path, 'utf8')) as LedgerSnapshot
    if (ledgerIsConsistent(ledger, counts, world)) return path
    const stale = path.replace(/\.json$/, `-stale-${Date.now()}.json`)
    renameSync(path, stale)
    ctx.log('LEDGER_STALE', { reason: 'live inventory regressed below recorded goals', movedTo: stale })
    return null
  } catch (error) {
    ctx.log('ERROR', { where: 'resolveLedgerPath', message: error instanceof Error ? error.message : String(error) })
    return path
  }
}

export function debugFrontier(counts: Record<string, number>, world: ResidentWorldMemory): { rungIndex: number; rungId: string } {
  return computeFrontier(counts, world)
}

export function createGeneration(ctx: GenerationContext): ResidentGeneration {
  const startedAt = Date.now()
  const { bot } = ctx
  const world = ctx.state.worldMemory

  // --- WorldMemory: register existing stations/ores instead of re-deriving them.
  const tables = scanBlockPositions(bot, ['crafting_table'], 48, 64)
  const furnaces = scanBlockPositions(bot, ['furnace', 'blast_furnace', 'smoker'], 48, 32)
  const ores = scanBlockPositions(
    bot,
    ['iron_ore', 'deepslate_iron_ore', 'diamond_ore', 'deepslate_diamond_ore', 'coal_ore', 'deepslate_coal_ore', 'copper_ore', 'gold_ore'],
    64,
    64,
  )
  const newTables = mergeStations(world.craftingTables, tables)
  const newFurnaces = mergeStations(world.furnaces, furnaces)
  for (const ore of ores) {
    const name = bot.blockAt(new Vec3(ore.x, ore.y, ore.z))?.name ?? 'unknown_ore'
    if (!world.discoveredOres.includes(name)) world.discoveredOres.push(name)
  }
  ctx.log('WORLDMEMORY', {
    craftingTables: world.craftingTables.length,
    newCraftingTables: newTables,
    furnaces: world.furnaces.length,
    newFurnaces,
    discoveredOres: world.discoveredOres,
  })

  const counts = inventoryCounts(bot)
  const ledgerPath = resolveLedgerPath(ctx, counts, world)
  const ladder = buildLadder(counts, world)
  const id = `gen-${startedAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`

  const options: Partial<JevAgentOptions> = {
    goalItem: ctx.goalItem,
    goalCount: ctx.goalCount,
    heartbeatMs: 3000,
    // A resident never stops on a timer and never aborts a wedge: the host would
    // have to restart the generation, so make the controller self-heal instead.
    maxRuntimeMs: 0,
    wedgeStallMs: 12 * 60 * 60 * 1000,
    wedgeRepeatLimit: 24,
    failureStreakLimit: 6,
    candidateFailureLimit: 3,
    finishOnObjectiveComplete: false,
    singleShotPlanner: true,
    ledgerPath,
    stopAfterSubgoals: 0,
    logDir: ctx.logDir,
    // Deterministic local policy: no LLM on the hot path, `llm.called === false`
    // by construction. This is the resident default (the user wants gameplay, not
    // gateway rate-limit stalls).
    forceFallbackPolicy: true,
    actuation: 'pathfinder',
    reach: 5,
    scanRadius: 48,
    verbose: true,
  }

  const controller = new JevController(bot, options)
  controller.setSystem2(new FixedPlanSystem2(null, ladder.goals, `resident ladder: ${ladder.rungId} (${ladder.goals.length} goal(s))`))

  ctx.log('GENERATION_READY', {
    id,
    rungIndex: ladder.rungIndex,
    rungId: ladder.rungId,
    goals: ladder.goals.map((goal) => goal.description),
    policy: controller.policyKind,
    model: controller.policyModel,
    craftingTables: world.craftingTables.length,
    furnaces: world.furnaces.length,
  })

  let stopped: string | null = null
  let runPromise: Promise<void> | null = null

  function attach(): void {
    // The controller registers its own bot listeners in start(); nothing to do.
  }

  function start(): void {
    if (runPromise !== null) return
    controller.start()
    runPromise = controller
      .wait()
      .then((result: RunSummary) => {
        stopped = result.stopped
        ctx.log('GENERATION_STOP', {
          id,
          stopped: result.stopped,
          success: result.success,
          ticks: result.ticks,
          verifiedDigs: result.verifiedDigs,
          subgoalsDone: result.subgoalsDone,
          subgoalCount: result.subgoalCount,
          jevCalls: result.jevCalls,
        })
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        stopped = 'generation-error'
        ctx.log('ERROR', { id, where: 'generation.wait', message })
      })
  }

  async function quiesce(): Promise<void> {
    try {
      controller.stop()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.log('ERROR', { id, where: 'quiesce.stop', message })
    }
    // Bounded settle: the executor cancels the in-flight action on stop.
    await Promise.race([runPromise ?? Promise.resolve(), delay(3000)])
  }

  function status(): GenerationStatus {
    const liveCounts = inventoryCounts(bot)
    const frontier = computeFrontier(liveCounts, world)
    const current = controller.agent.current
    const entity = bot.entity
    return {
      running: controller.isRunning,
      policyKind: controller.policyKind,
      policyModel: controller.policyModel,
      system2Model: controller.system2Model,
      queue: controller.goalQueueState,
      currentAction:
        current === null ? null : { id: current.id, kind: current.kind, phase: current.phase, startedAt: current.startedAt },
      position: entity === undefined ? null : { x: entity.position.x, y: entity.position.y, z: entity.position.z },
      health: entity === undefined ? null : bot.health,
      inventory: liveCounts,
      plannedGoals: ladder.goals.length,
      rungIndex: frontier.rungIndex,
      rungId: frontier.rungId,
    }
  }

  return {
    id,
    startedAt,
    rungIndex: ladder.rungIndex,
    rungId: ladder.rungId,
    attach,
    start,
    quiesce,
    dispose: () => {
      try {
        controller.stop()
      } catch {
        // best effort
      }
    },
    status,
    stopReason: () => stopped,
    hasStopped: () => stopped !== null,
  }
}

export default createGeneration
