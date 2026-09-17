// generation-entry.ts - the RELOADABLE layer.
//
// esbuild bundles this file (and everything it imports from ../jev-agent/src/**)
// into ONE hash-stamped ESM file. The host then `import()`s that single file: one
// file == one URL == the whole generation swaps atomically, so a new controller
// can never be wired to stale sibling modules.
//
// The generation wraps the battle-tested `JevController` (System One remains the
// sole action authority). The long-horizon brain is `PlannerBrain` (planner.ts):
// it answers the controller's replan summons with a BOUNDED goal list, choosing
// between the deterministic capability ladder and a batched Jev evaluation. The
// controller consumes the goal queue exactly as before, so the ledger and the
// reload path are untouched.
import type { Bot } from 'mineflayer'
import { existsSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Vec3 } from 'vec3'
import { JevController } from '../jev-agent/src/controller.ts'
import type { JevAgentOptions, RunSummary } from '../jev-agent/src/controller.ts'
import type { GoalQueueSnapshot } from '../jev-agent/src/goalQueue.ts'
import type { System2PlanRequest } from '../jev-agent/src/system2.ts'
import { Advisor, resolveAdvisorMode } from './advisor.ts'
import {
  MERCURY_ALLOWED_GOALS,
  MERCURY_MODEL_DEFAULT,
  MercurySystem2,
  mercuryCallsPath,
  resolveMercuryEnablement,
} from './mercury-system2.ts'
import type { MercuryStateSummary, MercuryTriggerReason } from './mercury-system2.ts'
import { installDescendAwarePolicy } from './system-one-policy.ts'
import {
  PlannerBrain,
  bestPickaxeRank,
  buildLadder,
  buildPlanOptions,
  computeFrontier,
  debugFrontier,
  has,
  inventoryCounts,
  resolvePlannerMode,
} from './planner.ts'
import type {
  ActuationLease,
  GenerationContext,
  GenerationStatus,
  MissionPreflightResult,
  ResidentGeneration,
  ResidentWorldMemory,
  ServerTruth,
  StructuralSmokeResult,
  Vec3Json,
  WorldMemoryDelta,
} from './resident-types.ts'

export const CONTRACT_VERSION = 2

// jev-agent/ is imported read-only, so the lease is asserted at the generation
// boundary: the bot handed to the controller is a Proxy that refuses every
// side-effecting method while this generation is not the active lease owner.
// Before the host's commit point the new generation cannot cause irreversible
// actions; after it the old generation cannot.
const MUTATING_BOT_METHODS = new Set<string>([
  'dig',
  'placeBlock',
  'equip',
  'unequip',
  'activateItem',
  'deactivateItem',
  'activateBlock',
  'clickWindow',
  'putSelectedItemRange',
  'craft',
  'openBlock',
  'openContainer',
  'closeWindow',
  'setControlState',
  'clearControlStates',
  'look',
  'lookAt',
  'toss',
  'tossStack',
  'chat',
  'setQuickBarSlot',
  'consume',
  'updateSign',
  'useOn',
  'swingArm',
])

function withActuationLease(bot: Bot, lease: ActuationLease, id: string): Bot {
  const assert = (what: string): void => lease.assertActive(id, what)
  let pathfinderProxy: object | null = null
  return new Proxy(bot, {
    get(target, prop, receiver): unknown {
      const value = Reflect.get(target, prop, receiver) as unknown
      if (typeof prop === 'string' && typeof value === 'function' && MUTATING_BOT_METHODS.has(prop)) {
        return (...args: unknown[]): unknown => {
          assert(`bot.${prop}`)
          return (value as (...a: unknown[]) => unknown).apply(target, args)
        }
      }
      if (prop === 'pathfinder' && value !== null && typeof value === 'object') {
        if (pathfinderProxy === null) {
          pathfinderProxy = new Proxy(value, {
            get(pfTarget, pfProp, pfRecv): unknown {
              const pfValue = Reflect.get(pfTarget, pfProp, pfRecv) as unknown
              if (
                (pfProp === 'setGoal' || pfProp === 'setMovements' || pfProp === 'stop' || pfProp === 'goto') &&
                typeof pfValue === 'function'
              ) {
                return (...args: unknown[]): unknown => {
                  assert(`pathfinder.${String(pfProp)}`)
                  return (pfValue as (...a: unknown[]) => unknown).apply(pfTarget, args)
                }
              }
              return pfValue
            },
          })
        }
        return pathfinderProxy
      }
      return value
    },
  }) as Bot
}

// Loud-fail craft capability check: a future Mineflayer bump that removes the
// private `_syncWindow` API must fail loudly here instead of silently degrading
// to the stock `bot.craft` silent-3x3-failure path (#3906).
const TESTED_MINEFLAYER = '4.39.0'
function assertCraftCapability(bot: Bot, log: (event: string, detail?: Record<string, unknown>) => void): void {
  const syncable = bot as unknown as { _syncWindow?: unknown }
  if (typeof syncable._syncWindow !== 'function') {
    const version = (bot as unknown as { version?: string }).version ?? 'unknown'
    log('CRAFT_COMPAT', { ok: false, mineflayerTested: TESTED_MINEFLAYER, serverVersion: version, api: '_syncWindow' })
    throw new Error(
      `craftWindow unsupported: bot._syncWindow is not a function (tested with mineflayer ${TESTED_MINEFLAYER}, connected to ${version}). ` +
        'Refusing to run: stock bot.craft silently ignores 3x3 crafting clicks (PrismarineJS/mineflayer#3906).',
    )
  }
  log('CRAFT_COMPAT', { ok: true, mineflayerTested: TESTED_MINEFLAYER, api: '_syncWindow' })
}

export { debugFrontier }

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
function ledgerIsConsistent(ledger: LedgerSnapshot, counts: Record<string, number>, world: ResidentWorldMemory): boolean {
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

function resolveLedgerPath(ctx: GenerationContext, counts: Record<string, number>, world: ResidentWorldMemory): string | null {
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

/**
 * In llm-planner mode the controller's own ledger restore is gated behind the
 * single-shot planner, so the durable `done` count is restored here instead.
 * jev-agent is imported read-only, so the queue is reached through a narrow cast;
 * the HOST has already validated/archived the ledger against the live inventory.
 */
function restoreLedgerIntoController(
  controller: JevController,
  ledgerPath: string | null,
  log: (event: string, detail?: Record<string, unknown>) => void,
): void {
  if (ledgerPath === null || !existsSync(ledgerPath)) return
  try {
    const snapshot = JSON.parse(readFileSync(ledgerPath, 'utf8')) as GoalQueueSnapshot
    if (!Array.isArray(snapshot.goals) || typeof snapshot.counter !== 'number') return
    const holder = controller as unknown as { queue: { restore(snapshot: GoalQueueSnapshot): void } }
    holder.queue.restore(snapshot)
    const done = snapshot.goals.filter((goal) => goal.status === 'done').length
    const current = snapshot.goals.find((goal) => goal.status === 'active' || goal.status === 'pending')
    log('LEDGER_RESTORED', { done, total: snapshot.goals.length, current: current?.description ?? null })
  } catch (error) {
    log('ERROR', { where: 'restoreLedgerIntoController', message: error instanceof Error ? error.message : String(error) })
  }
}

function buildMercurySummary(
  bot: Bot,
  world: ResidentWorldMemory,
  request: System2PlanRequest,
  trigger: MercuryTriggerReason,
): MercuryStateSummary {
  const counts = inventoryCounts(bot)
  const entity = bot.entity
  const frontier = computeFrontier(counts, world)
  const inventory: Record<string, number> = {}
  for (const [name, n] of Object.entries(counts)) if (n > 0) inventory[name] = n
  let wait = 0
  for (let i = request.recentOutcomes.length - 1; i >= 0; i -= 1) {
    const outcome = request.recentOutcomes[i]
    if (outcome === undefined || outcome.actionId !== 'WAIT') break
    wait += 1
  }
  const recentFailures = request.recentOutcomes
    .slice(-6)
    .map((outcome) => `${outcome.actionId}:${outcome.status}${outcome.failure === null ? '' : `:${outcome.failure}`}`)
  return {
    trigger,
    wakeReason: request.reason,
    wakeDetail: request.detail.slice(0, 200),
    rung: frontier.rungId,
    rungIndex: frontier.rungIndex,
    position:
      entity === undefined
        ? null
        : { x: Math.round(entity.position.x), y: Math.round(entity.position.y), z: Math.round(entity.position.z) },
    dimension: bot.game?.dimension ?? null,
    health: entity === undefined ? null : bot.health,
    toolRank: bestPickaxeRank(counts),
    inventory,
    stations: { craftingTables: world.craftingTables.length, furnaces: world.furnaces.length },
    knownOres: [...world.discoveredOres],
    recentFailures,
    consecutiveWait: wait,
    queue: {
      depth: request.goalQueueState.depth,
      done: request.goalQueueState.done,
      current: request.goalQueueState.current?.description ?? null,
      hasImpossible: request.goalQueueState.hasImpossible,
    },
    objective: request.objective,
    deathHistory: world.hazards.map(
      (hazard) => `${hazard.reason}@${Math.round(hazard.x)},${Math.round(hazard.y)},${Math.round(hazard.z)}x${hazard.count}`,
    ),
    allowedGoals: MERCURY_ALLOWED_GOALS,
  }
}

export function createGeneration(ctx: GenerationContext): ResidentGeneration {
  const startedAt = Date.now()
  assertCraftCapability(ctx.bot, ctx.log)
  const world: ResidentWorldMemory = {
    craftingTables: ctx.worldMemory.craftingTables.map((p) => ({ ...p })),
    furnaces: ctx.worldMemory.furnaces.map((p) => ({ ...p })),
    mined: { ...ctx.worldMemory.mined },
    discoveredOres: [...ctx.worldMemory.discoveredOres],
    traversalFailures: (ctx.worldMemory.traversalFailures ?? []).map((t) => ({ ...t, from: { ...t.from }, toward: { ...t.toward } })),
    hazards: (ctx.worldMemory.hazards ?? []).map((h) => ({ ...h })),
  }
  const id = `gen-${startedAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const bot = withActuationLease(ctx.bot, ctx.lease, id)

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
  const discoveredOres: string[] = []
  for (const ore of ores) {
    const name = bot.blockAt(new Vec3(ore.x, ore.y, ore.z))?.name ?? 'unknown_ore'
    if (!world.discoveredOres.includes(name)) world.discoveredOres.push(name)
    if (!discoveredOres.includes(name)) discoveredOres.push(name)
  }
  const proposal: WorldMemoryDelta = {
    craftingTables: tables,
    furnaces,
    discoveredOres,
    traversalFailures: world.traversalFailures,
  }
  // The generation proposes; the HOST is the only writer that commits.
  ctx.proposeWorldMemory(proposal)
  ctx.log('WORLDMEMORY', {
    worldKey: `${ctx.worldKey.serverId}|${ctx.worldKey.dimension}|${ctx.worldKey.worldEpoch}`,
    craftingTables: world.craftingTables.length,
    newCraftingTables: newTables,
    furnaces: world.furnaces.length,
    newFurnaces,
    discoveredOres: world.discoveredOres,
  })

  const counts = inventoryCounts(ctx.bot)
  const ledgerPath = resolveLedgerPath(ctx, counts, world)
  const ladder = buildLadder(counts, world, (event, detail) => ctx.log(event, detail), {
    dimension: ctx.bot.game?.dimension ?? null,
    placedFurnacesNear: furnaces.length,
  })
  if (ladder.unsatisfiable !== null) {
    ctx.log('LADDER_UNSATISFIABLE', { reason: ladder.unsatisfiable, rungId: ladder.rungId })
  }

  // Death (or any explicit reset) recomputes the ladder from the LIVE inventory.
  // An empty inventory means restart at wood; the queue is never given a goal
  // whose prerequisite is missing.
  if (ctx.resetReason !== null) {
    ctx.log('LADDER_RESET', {
      reason: ctx.resetReason,
      invEmpty: Object.keys(counts).length === 0,
      rungIndex: ladder.rungIndex,
      rungId: ladder.rungId,
      goals: ladder.goals.map((goal) => goal.description),
    })
  }

  // The planner IS the env switch: deterministic keeps the original single-shot
  // contract, so every decision record truthfully reports `llm.called == false`.
  // `llm` turns the controller's exception paths into bounded replans.
  const plannerMode = resolvePlannerMode()

  // Durable caches (survive hot reloads; keyed by world-state hash).
  const cachePath = fileURLToPath(new URL('./planner-cache.json', import.meta.url))
  const advisorCachePath = fileURLToPath(new URL('./advisor-cache.json', import.meta.url))
  const advisor = new Advisor({
    log: (event, detail) => ctx.log(event, detail),
    cachePath: advisorCachePath,
    mode: resolveAdvisorMode(plannerMode),
  })

  const postDeathRecovery = ctx.resetReason === 'death'
  const mercuryConfigPath = process.env.BUDDY_SYSTEM2_CONFIG ?? join(process.cwd(), 'system2.config.json')
  const mercuryEnablement = resolveMercuryEnablement(plannerMode, mercuryConfigPath)
  const mercuryCachePath = fileURLToPath(new URL('./mercury-cache.json', import.meta.url))
  const mercury = mercuryEnablement.enabled
    ? new MercurySystem2({
        summarize: (request, trigger) => buildMercurySummary(bot, world, request, trigger),
        log: (event, detail) => ctx.log(event, detail),
        callsPath: mercuryCallsPath(ctx.logDir),
        cachePath: mercuryCachePath,
        postDeathRecovery,
      })
    : undefined

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
    // Dynamic planner: the controller wakes System 2 on queue_empty /
    // action_impossible / no_progress / need_llm and consumes whatever bounded
    // goal list it returns. System One (forceFallbackPolicy) stays the sole
    // action authority, so `llm.called === false` for the Jev action policy.
    // deterministic keeps the single-shot contract (bootstrap once) so the
    // `llm.called == false` gate stays provable.
    singleShotPlanner: plannerMode === 'deterministic',
    // Bounded replan frequency: the planner also throttles LLM calls itself, but
    // keep the controller from re-summoning every tick while a goal is blocked.
    llmCooldownMs: 15000,
    ledgerPath,
    stopAfterSubgoals: 0,
    logDir: ctx.logDir,
    // Deterministic local policy: no LLM on the hot path, `llm.called === false`
    // by construction. The LLM is used ONLY by the high-level planner and only
    // returns bounded planning data, never actions.
    forceFallbackPolicy: true,
    actuation: 'pathfinder',
    reach: 5,
    scanRadius: 48,
    verbose: true,
    eventSink: (event, detail) => ctx.log(event, detail),
  }

  const controller = new JevController(bot, options)
  // The stock fallback has no DESCEND branch; without this wrapper a stalled
  // stone/iron goal whose only productive candidate is a descent step WAITs
  // forever and wedges. Hazards from death are excluded here.
  installDescendAwarePolicy(controller, world.hazards, (event, detail) => ctx.log(event, detail))
  restoreLedgerIntoController(controller, ledgerPath, ctx.log)
  const brain = new PlannerBrain({
    bot,
    world,
    log: (event, detail) => ctx.log(event, detail),
    cachePath,
    mode: plannerMode,
    advisor,
    mercury,
    postDeathRecovery,
  })
  controller.setSystem2(brain)

  ctx.log('GENERATION_READY', {
    id,
    rungIndex: ladder.rungIndex,
    rungId: ladder.rungId,
    goals: ladder.goals.map((goal) => goal.description),
    policy: controller.policyKind,
    model: controller.policyModel,
    planner: brain.mode,
    plannerModel: brain.model,
    plannerCache: cachePath,
    advisor: mercuryEnablement.enabled ? `mercury:${MERCURY_MODEL_DEFAULT}` : resolveAdvisorMode(plannerMode),
    advisorSource: mercuryEnablement.source,
    futureRungs: ladder.futureRungIds,
    prereqReplaced: ladder.prereqReplaced,
    craftingTables: world.craftingTables.length,
    furnaces: world.furnaces.length,
  })

  let stopped: string | null = null
  let runPromise: Promise<void> | null = null
  let ready = false

  function attach(): void {
    // The controller registers its own bot listeners in start(); nothing to do.
  }

  function start(): void {
    if (runPromise !== null) return
    ctx.lease.assertActive(id, 'generation.start')
    controller.start()
    ready = true
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

  function readTruth(): ServerTruth {
    const entity = bot.entity
    const raw = entity === undefined ? null : entity.position
    return {
      position: raw === null || raw === undefined ? null : { x: raw.x, y: raw.y, z: raw.z },
      health: entity === undefined ? null : bot.health,
      food: entity === undefined ? null : bot.food,
      dimension: bot.game?.dimension ?? null,
      onGround: entity === undefined ? null : (entity.onGround ?? null),
      inventory: inventoryCounts(bot),
    }
  }

  function status(): GenerationStatus {
    const truth = readTruth()
    const frontier = computeFrontier(truth.inventory, world)
    const current = controller.agent.current
    return {
      running: controller.isRunning,
      policyKind: controller.policyKind,
      policyModel: controller.policyModel,
      system2Model: controller.system2Model,
      queue: controller.goalQueueState,
      currentAction:
        current === null ? null : { id: current.id, kind: current.kind, phase: current.phase, startedAt: current.startedAt },
      truth,
      plannedGoals: ladder.goals.length,
      rungIndex: frontier.rungIndex,
      rungId: frontier.rungId,
      ready,
      contractVersion: CONTRACT_VERSION,
    }
  }

  function structuralSmoke(): StructuralSmokeResult {
    const checks: string[] = []
    const failures: string[] = []
    const check = (name: string, fn: () => boolean): void => {
      try {
        if (fn()) checks.push(name)
        else failures.push(name)
      } catch (error) {
        failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    check('id', () => typeof id === 'string' && id.length > 0)
    check('startedAt', () => Number.isFinite(startedAt))
    check('rungId', () => typeof ladder.rungId === 'string' && ladder.rungId.length > 0)
    check('contract-version', () => CONTRACT_VERSION === 2)
    check('status-readable', () => {
      const s = status()
      return typeof s.running === 'boolean' && typeof s.policyKind === 'string' && s.policyKind.length > 0
    })
    check('snapshot-schema', () => {
      const s = status()
      return (
        typeof s.queue === 'object' &&
        s.queue !== null &&
        typeof s.queue.done === 'number' &&
        typeof s.queue.depth === 'number' &&
        typeof s.plannedGoals === 'number' &&
        typeof s.rungIndex === 'number'
      )
    })
    check('sensor-truth-dto', () => {
      const t = status().truth
      if (t.position === null) return t.health === null || typeof t.health === 'number'
      return (
        Number.isFinite(t.position.x) &&
        Number.isFinite(t.position.y) &&
        Number.isFinite(t.position.z) &&
        Object.getPrototypeOf(t.position) === Object.prototype
      )
    })
    check('pure-buildLadder', () => buildLadder({}, world).goals.length > 0)
    check('pure-buildPlanOptions', () => Array.isArray(buildPlanOptions({}, world)))
    check('pure-computeFrontier', () => typeof computeFrontier({}, world).rungIndex === 'number')
    return { ok: failures.length === 0, checks, failures }
  }

  function missionPreflight(): MissionPreflightResult {
    const goalCount = ladder.goals.length
    return { ok: goalCount >= 1, reason: goalCount >= 1 ? null : 'planner produced an empty plan', goalCount }
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
    structuralSmoke,
    missionPreflight,
    stopReason: () => stopped,
    hasStopped: () => stopped !== null,
  }
}

export default createGeneration
