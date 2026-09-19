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
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Vec3 } from 'vec3'
import { JevController } from '../jev-agent/src/controller.ts'
import type { JevAgentOptions, RunSummary } from '../jev-agent/src/controller.ts'
import type { GoalQueueSnapshot, PlannedGoal, QueuedGoal } from '../jev-agent/src/goalQueue.ts'
import type { System2Brain, System2PlanRequest } from '../jev-agent/src/system2.ts'
import { resolveOptionCompilerEnabled } from '../jev-agent/src/optionSpec.ts'
import { Advisor, resolveAdvisorMode } from './advisor.ts'
import { OptionCompilingSystem2, optionSnapshotFromBot } from './option-brain.ts'
import {
  MERCURY_ALLOWED_GOALS,
  MERCURY_MODEL_DEFAULT,
  MercurySystem2,
  mercuryCallsPath,
  resolveMercuryEnablement,
} from './mercury-system2.ts'
import type { MercuryStateSummary, MercuryTriggerReason } from './mercury-system2.ts'
import { installDescendAwarePolicy } from './system-one-policy.ts'
import { assertActuationSurfaceCovered, createActuationPort, withActuationLease } from './resident-safety.ts'
import { ACTUATION_PORT_OPERATIONS } from '../jev-agent/src/actuationPort.ts'
import {
  PlannerBrain,
  RUNGS,
  bestPickaxeRank,
  buildLadder,
  buildPlanOptions,
  computeFrontier,
  countResource,
  debugFrontier,
  deriveResumeRung,
  goalAlreadyMet,
  goalsForStrategy,
  has,
  inventoryCounts,
  resolvePlannerMode,
} from './planner.ts'
import type { Counts, Rung } from './planner.ts'
import type {
  GenerationContext,
  GenerationResources,
  GenerationStatus,
  KnownResourceJson,
  KnownStation,
  MissionPreflightResult,
  ResidentGeneration,
  ResidentWorldMemory,
  ServerTruth,
  StationKind,
  StructuralSmokeResult,
  Vec3Json,
  WorldMemoryDelta,
} from './resident-types.ts'
import { worldCacheNamespace } from './world-epoch.ts'
import {
  applyStationFailure,
  isStationSelectable,
  normalizeStation,
  registerStation,
  stationAgeTicks,
  stationBlockMatches,
  stationInvalidatedDetail,
  stationKey,
  stationRegisteredDetail,
  stationVerifiedDetail,
  validateStationProbe,
} from './station-memory.ts'

export const CONTRACT_VERSION = 3

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

const STATION_VALIDATION_RADIUS = 48

type StationLog = (event: string, detail?: Record<string, unknown>) => void

function liveBlockNameAt(bot: Bot, position: Vec3Json): string | null {
  try {
    return bot.blockAt(new Vec3(position.x, position.y, position.z))?.name ?? null
  } catch {
    return null
  }
}

function asVec3Json(value: unknown): Vec3Json | null {
  if (value === null || typeof value !== 'object') return null
  const candidate = value as { x?: unknown; y?: unknown; z?: unknown }
  if (typeof candidate.x !== 'number' || typeof candidate.y !== 'number' || typeof candidate.z !== 'number') return null
  return { x: candidate.x, y: candidate.y, z: candidate.z }
}

function removeStation(stations: KnownStation[], station: KnownStation): void {
  const key = stationKey(station)
  for (let index = stations.length - 1; index >= 0; index -= 1) {
    const current = stations[index]
    if (current !== undefined && stationKey(current) === key) stations.splice(index, 1)
  }
}

/**
 * Issue #31: validate every remembered station against live world truth. A
 * loaded cell with the wrong block (or air) fails `missing`; an unloaded cell
 * older than the staleness budget fails `stale`; a loaded matching block is
 * re-verified. Failures accumulate on the durable record and invalidate it at
 * STATION_MAX_FAILURES, at which point it is returned in `removed`.
 */
function validateRememberedStations(
  bot: Bot,
  kind: StationKind,
  stations: KnownStation[],
  liveFound: readonly Vec3Json[],
  now: number,
  log: StationLog,
): { kept: KnownStation[]; removed: KnownStation[] } {
  const liveNames = new Map<string, string>()
  for (const position of liveFound) {
    const name = liveBlockNameAt(bot, position)
    if (name !== null) liveNames.set(stationKey(position), name)
  }
  const entity = bot.entity
  const kept: KnownStation[] = []
  const removed: KnownStation[] = []
  for (const station of stations) {
    const key = stationKey(station)
    let liveBlockName = liveNames.get(key) ?? null
    if (liveBlockName === null && entity !== undefined) {
      const distance = Math.hypot(entity.position.x - station.x, entity.position.y - station.y, entity.position.z - station.z)
      if (distance <= STATION_VALIDATION_RADIUS) liveBlockName = liveBlockNameAt(bot, station)
    }
    const result = validateStationProbe({ station, kind, liveBlockName, reachable: null, now })
    if (result.outcome === 'verified') {
      log('STATION_VERIFIED', stationVerifiedDetail(kind, station))
      kept.push(station)
      continue
    }
    if (result.outcome === 'stale') {
      log('STATION_INVALIDATED', stationInvalidatedDetail(kind, station, 'stale', stationAgeTicks(station, now)))
      removed.push(station)
      continue
    }
    if (result.outcome === 'missing' || result.outcome === 'unreachable') {
      log('STATION_INVALIDATED', stationInvalidatedDetail(kind, station, result.outcome))
      if (result.invalidated) removed.push(station)
      else kept.push(station)
      continue
    }
    kept.push(station)
  }
  return { kept, removed }
}

function registerLiveStations(
  bot: Bot,
  kind: StationKind,
  stations: KnownStation[],
  liveFound: readonly Vec3Json[],
  now: number,
  log: StationLog,
): number {
  const known = new Set(stations.map((station) => stationKey(station)))
  let added = 0
  for (const position of liveFound) {
    const key = stationKey(position)
    if (known.has(key)) continue
    const liveBlockName = liveBlockNameAt(bot, position)
    if (liveBlockName === null || !stationBlockMatches(kind, liveBlockName)) continue
    registerStation(stations, kind, position, now)
    log('STATION_REGISTERED', stationRegisteredDetail(kind, position))
    known.add(key)
    added += 1
  }
  return added
}

/**
 * The STATION_REGISTERED detail for a placement-verified station: `source=placed`
 * marks the cell as placed-by-us, so the marker distinguishes deterministic
 * placement proof from a sensed/remembered coincidence. Exported so the marker
 * contract is unit-testable without a bot.
 */
export function stationRegisteredPlacedDetail(kind: StationKind, position: Vec3Json): Record<string, unknown> {
  return { kind, source: 'placed', at: stationKey(position) }
}

const LOG_BLOCK_NAMES = [
  'oak_log',
  'birch_log',
  'spruce_log',
  'jungle_log',
  'acacia_log',
  'dark_oak_log',
  'mangrove_log',
  'cherry_log',
  'pale_oak_log',
  'crimson_stem',
  'warped_stem',
] as const

const KNOWN_RESOURCE_CAP = 256

export function mergeKnownResources(
  target: KnownResourceJson[],
  found: KnownResourceJson[],
  log?: (event: string, detail?: Record<string, unknown>) => void,
  worldEpoch?: number,
): number {
  const seen = new Set(target.map((resource) => `${resource.name}@${resource.x},${resource.y},${resource.z}`))
  let added = 0
  for (const resource of found) {
    const key = `${resource.name}@${Math.round(resource.x)},${Math.round(resource.y)},${Math.round(resource.z)}`
    if (seen.has(key)) continue
    if (target.length >= KNOWN_RESOURCE_CAP) break
    seen.add(key)
    const stored = {
      name: resource.name,
      kind: resource.kind,
      x: Math.round(resource.x),
      y: Math.round(resource.y),
      z: Math.round(resource.z),
      ...(resource.dimension === undefined ? {} : { dimension: resource.dimension }),
      ...(resource.worldEpoch === undefined ? {} : { worldEpoch: resource.worldEpoch }),
      ...(resource.lastSeenAt === undefined ? {} : { lastSeenAt: resource.lastSeenAt }),
    }
    target.push(stored)
    log?.('KNOWN_RESOURCE', {
      item: stored.name,
      kind: stored.kind,
      at: `${stored.x},${stored.y},${stored.z}`,
      ...(worldEpoch === undefined ? {} : { worldEpoch }),
    })
    added += 1
  }
  return added
}

export const KNOWN_RESOURCE_STALENESS_RADIUS = 24

export function resourceStillPresent(
  remembered: string,
  live: string | null | undefined,
): 'unknown' | 'present' | 'replaced' | 'stale' {
  if (typeof live !== 'string' || live.length === 0) return 'unknown'
  if (live === remembered) return 'present'
  const sameFamily =
    (remembered.endsWith('_ore') && live.endsWith('_ore')) || (remembered.endsWith('_log') && live.endsWith('_log'))
  return sameFamily ? 'replaced' : 'stale'
}

function resourceKey(resource: { name: string; x: number; y: number; z: number }): string {
  return `${resource.name}@${Math.round(resource.x)},${Math.round(resource.y)},${Math.round(resource.z)}`
}

function resourceAt(resource: { x: number; y: number; z: number }): string {
  return `${Math.round(resource.x)},${Math.round(resource.y)},${Math.round(resource.z)}`
}

/**
 * Issue #14 staleness: a remembered cell close enough that the loaded chunk
 * still contains it is proof. If the block is gone (air/stone/replaced by a
 * non-resource) the durable entry is evicted and logged; if it is a different
 * ore/log variant the entry is refreshed. Out-of-range cells are left alone
 * (absence there is not proof). Mutates `known` and returns the evicted set.
 */
export function evictStaleKnownResources(
  bot: Bot,
  known: KnownResourceJson[],
  worldKey: { dimension: string; worldEpoch: number },
  log?: (event: string, detail?: Record<string, unknown>) => void,
): KnownResourceJson[] {
  const entity = bot.entity
  if (entity === undefined) return []
  const position = entity.position
  const stale: KnownResourceJson[] = []
  const staleKeys = new Set<string>()
  for (const resource of known) {
    if (resource.worldEpoch !== undefined && resource.worldEpoch !== worldKey.worldEpoch) {
      stale.push(resource)
      staleKeys.add(resourceKey(resource))
      log?.('KNOWN_RESOURCE_STALE', { item: resource.name, at: resourceAt(resource), reason: 'worldEpoch' })
      continue
    }
    const distance = Math.hypot(resource.x - position.x, resource.y - position.y, resource.z - position.z)
    if (distance > KNOWN_RESOURCE_STALENESS_RADIUS) continue
    let live: string | null = null
    try {
      live = bot.blockAt(new Vec3(resource.x, resource.y, resource.z))?.name ?? null
    } catch {
      live = null
    }
    const verdict = resourceStillPresent(resource.name, live)
    if (verdict === 'stale') {
      stale.push(resource)
      staleKeys.add(resourceKey(resource))
      log?.('KNOWN_RESOURCE_STALE', { item: resource.name, at: resourceAt(resource) })
    } else if (verdict === 'present' || verdict === 'replaced') {
      resource.lastSeenAt = Date.now()
      if (verdict === 'replaced' && typeof live === 'string') resource.name = live
    }
  }
  if (staleKeys.size === 0) return stale
  for (let index = known.length - 1; index >= 0; index -= 1) {
    const resource = known[index]
    if (resource !== undefined && staleKeys.has(resourceKey(resource))) known.splice(index, 1)
  }
  return stale
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

function delay(ms: number, resources?: GenerationResources): Promise<void> {
  return new Promise((resolve) => {
    const handle = setTimeout(() => {
      resources?.untrackTimer(handle)
      resolve()
    }, ms)
    resources?.trackTimer(handle)
  })
}

interface LedgerGoal {
  kind?: string
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
export function ledgerIsConsistent(ledger: LedgerSnapshot, counts: Record<string, number>, world: ResidentWorldMemory): boolean {
  const done = new Set<string>()
  for (const goal of ledger.goals ?? []) {
    if (goal.status === 'done' && typeof goal.targetItem === 'string') done.add(goal.targetItem)
  }
  for (const [item, rank] of Object.entries(PICKAXE_RANK)) {
    if (done.has(item) && bestPickaxeRank(counts) < rank) return false
  }
  if (done.has('crafting_table') && !(has(counts, 'crafting_table') || world.craftingTables.length > 0)) return false
  if (done.has('furnace') && !(has(counts, 'furnace') || world.furnaces.length > 0)) return false
  const hasUsableFurnace = has(counts, 'furnace') || world.furnaces.length > 0
  const hasUnfinishedFurnaceAcquisition = (ledger.goals ?? []).some(
    (goal) =>
      (goal.status === 'active' || goal.status === 'pending') &&
      (goal.kind === 'craft' || goal.kind === 'place') &&
      goal.targetItem === 'furnace',
  )
  if (hasUsableFurnace && hasUnfinishedFurnaceAcquisition) return false
  return true
}

export interface LedgerGoalReopening {
  id: string
  description: string
  rungIds: string[]
  liveHave: number
  requiredCount: number
}

export interface LedgerGoalReconciliation {
  snapshot: GoalQueueSnapshot
  reopened: LedgerGoalReopening[]
}

function rungOwnsGoal(rung: Rung, goal: QueuedGoal, counts: Counts, world: ResidentWorldMemory): boolean {
  const target = goal.targetItem ?? null
  return rung.goals(counts, world).some((planned) => planned.kind === goal.kind && (planned.targetItem ?? null) === target)
}

/**
 * Reconcile a restored ledger against the LIVE bot. A `done` goal is trusted
 * only when either its own item requirement is already held, or a capability
 * rung that contains it is satisfied by the live inventory/world (a consumable
 * that was legitimately spent, e.g. raw_iron smelted into iron_ingot). A `done`
 * goal no live rung predicate covers is reopened as `pending`, so it is
 * re-activated ahead of any later-milestone goal. Pure: never mutates the input.
 */
export function reconcileLedgerGoals(
  snapshot: GoalQueueSnapshot,
  counts: Record<string, number>,
  world: ResidentWorldMemory,
): LedgerGoalReconciliation {
  const reopened: LedgerGoalReopening[] = []
  const goals = (snapshot.goals ?? []).map((goal) => {
    if (goal.status !== 'done') return { ...goal }
    const target = goal.targetItem
    if (typeof target !== 'string' || target.length === 0) return { ...goal }
    const rungs = RUNGS.filter((rung) => rung.future !== true && rungOwnsGoal(rung, goal, counts, world))
    if (rungs.length === 0) return { ...goal }
    const planned: PlannedGoal = {
      kind: goal.kind,
      description: goal.description,
      targetItem: goal.targetItem,
      requiredCount: goal.requiredCount,
    }
    if (goalAlreadyMet(planned, counts)) return { ...goal }
    if (rungs.some((rung) => rung.satisfied(counts, world))) return { ...goal }
    const liveHave = Math.max(0, countResource(counts, target))
    reopened.push({
      id: goal.id,
      description: goal.description,
      rungIds: rungs.map((rung) => rung.id),
      liveHave,
      requiredCount: goal.requiredCount,
    })
    return { ...goal, status: 'pending' as const, haveCount: Math.min(goal.haveCount, liveHave) }
  })
  return { snapshot: { ...snapshot, goals }, reopened }
}

export function selectLedgerSnapshot(
  hostSnapshot: GoalQueueSnapshot | null,
  derivedSnapshot: GoalQueueSnapshot | null,
  counts: Record<string, number>,
  world: ResidentWorldMemory,
): { source: 'host-snapshot' | 'derived-file'; snapshot: GoalQueueSnapshot; reopened: LedgerGoalReopening[] } | null {
  if (hostSnapshot !== null) {
    if (!ledgerIsConsistent(hostSnapshot, counts, world)) return null
    return { source: 'host-snapshot', ...reconcileLedgerGoals(hostSnapshot, counts, world) }
  }
  if (derivedSnapshot !== null && ledgerIsConsistent(derivedSnapshot, counts, world)) {
    return { source: 'derived-file', ...reconcileLedgerGoals(derivedSnapshot, counts, world) }
  }
  return null
}

interface LedgerReconciliationDecision {
  usablePath: string | null
  reason: string | null
}

/**
 * Issue #5: the generation only READS the host-owned ledger mirror. When the
 * recorded progress is inconsistent with live inventory it reports a proposal and
 * returns null; the HOST archives the file at the commit point. It never renames.
 */
function resolveLedgerPath(
  ctx: GenerationContext,
  counts: Record<string, number>,
  world: ResidentWorldMemory,
  generationId: string,
): LedgerReconciliationDecision {
  const path = ctx.ledgerPath
  if (!existsSync(path)) return { usablePath: path, reason: null }
  try {
    const ledger = JSON.parse(readFileSync(path, 'utf8')) as LedgerSnapshot
    if (ledgerIsConsistent(ledger, counts, world)) return { usablePath: path, reason: null }
    const reason = 'live inventory regressed below recorded goals'
    ctx.proposeLedgerReconciliation({ generationId, reason })
    ctx.log('LEDGER_STALE_PROPOSED', { reason, action: 'host-archive-at-commit' })
    return { usablePath: null, reason }
  } catch (error) {
    ctx.log('ERROR', { where: 'resolveLedgerPath', message: error instanceof Error ? error.message : String(error) })
    return { usablePath: path, reason: null }
  }
}

/**
 * A snapshot/plan is only usable when it is an object carrying a `goals` array.
 * The inventory-aware resume path reads `snapshot.goals`; a missing or malformed
 * snapshot (e.g. a legacy `buddy-state.json` whose `ledger` is a GoalQueueState
 * with `depth`/`current` instead of `counter`/`goals`) must degrade to an empty
 * goal list, never throw `Cannot read properties of undefined (reading 'goals')`.
 */
export function snapshotGoals(snapshot: GoalQueueSnapshot | null | undefined): GoalQueueSnapshot['goals'] {
  return Array.isArray(snapshot?.goals) ? snapshot.goals : []
}

/**
 * Restore the durable ledger into the controller. Class A says the HOST snapshot
 * is the authority (#40): the generation reads `ctx.ledgerSnapshot` first and only
 * falls back to the derived `buddy-ledger.json` compatibility mirror. A ledger
 * whose recorded tools/stations are gone from the live bot is refused.
 */
function restoreLedgerIntoController(
  controller: JevController,
  hostSnapshot: GoalQueueSnapshot | null,
  ledgerPath: string | null,
  counts: Record<string, number>,
  world: ResidentWorldMemory,
  log: (event: string, detail?: Record<string, unknown>) => void,
): void {
  let derivedSnapshot: GoalQueueSnapshot | null = null
  if (ledgerPath !== null && existsSync(ledgerPath)) {
    try {
      const parsed = JSON.parse(readFileSync(ledgerPath, 'utf8')) as GoalQueueSnapshot
      if (Array.isArray(parsed.goals) && typeof parsed.counter === 'number') derivedSnapshot = parsed
    } catch (error) {
      log('ERROR', { where: 'restoreLedgerIntoController.read', message: error instanceof Error ? error.message : String(error) })
    }
  }
  const chosen = selectLedgerSnapshot(hostSnapshot, derivedSnapshot, counts, world)
  if (chosen === null) {
    if (hostSnapshot !== null || derivedSnapshot !== null) {
      log('LEDGER_STALE', { reason: 'live inventory regressed below recorded goals', source: hostSnapshot !== null ? 'host-snapshot' : 'derived-file' })
    }
    return
  }
  try {
    const holder = controller as unknown as { queue: { restore(snapshot: GoalQueueSnapshot): void } }
    holder.queue.restore(chosen.snapshot)
    const goals = snapshotGoals(chosen.snapshot)
    const done = goals.filter((goal) => goal.status === 'done').length
    const current = goals.find((goal) => goal.status === 'active' || goal.status === 'pending')
    log('LEDGER_RESTORED', { source: chosen.source, done, total: goals.length, current: current?.description ?? null, reopened: chosen.reopened.length })
    if (chosen.reopened.length > 0) {
      log('LEDGER_GOAL_REOPENED', { reason: 'live predicate unmet', goals: chosen.reopened })
    }
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
  const frontier = deriveResumeRung(counts, world)
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
  const now = startedAt
  const counts = inventoryCounts(ctx.bot)
  assertCraftCapability(ctx.bot, ctx.log)
  const world: ResidentWorldMemory = {
    craftingTables: ctx.worldMemory.craftingTables.map((station) => normalizeStation(station, 'crafting_table', now)),
    furnaces: ctx.worldMemory.furnaces.map((station) => normalizeStation(station, 'furnace', now)),
    mined: { ...ctx.worldMemory.mined },
    discoveredOres: [...ctx.worldMemory.discoveredOres],
    knownResources: (ctx.worldMemory.knownResources ?? []).map((resource) => ({ ...resource })),
    traversalFailures: (ctx.worldMemory.traversalFailures ?? []).map((t) => ({ ...t, from: { ...t.from }, toward: { ...t.toward } })),
    moveFailures: (ctx.worldMemory.moveFailures ?? []).map((entry) => ({ ...entry })),
    hazards: (ctx.worldMemory.hazards ?? []).map((h) => ({ ...h })),
  }
  const id = `gen-${startedAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const bot = withActuationLease(ctx.bot, ctx.lease, id, ctx.resources, ctx.log)
  // #38: the generation actuates through this allowlist capability. Every method
  // asserts the lease; the raw Bot is not the actuation contract. The dev-only
  // surface check proves the nested capabilities are guarded, not raw.
  const actuationPort = createActuationPort(bot, ctx.lease, id, ctx.log)
  const surface = assertActuationSurfaceCovered(bot, ctx.log)
  ctx.log('ACTUATION_PORT_READY', {
    id,
    operations: ACTUATION_PORT_OPERATIONS,
    surfaceOk: surface.ok,
    surfaceUncovered: surface.uncovered,
  })
  if (world.moveFailures.length > 0) {
    ctx.log('MOVE_FAILMEM_RESTORED', {
      entries: world.moveFailures.length,
      blacklisted: world.moveFailures.filter((entry) => entry.blacklistedUntil > Date.now()).length,
    })
  }

  const tables = scanBlockPositions(bot, ['crafting_table'], 48, 64)
  const furnaces = scanBlockPositions(bot, ['furnace', 'blast_furnace', 'smoker'], 48, 32)
  const ores = scanBlockPositions(
    bot,
    ['iron_ore', 'deepslate_iron_ore', 'diamond_ore', 'deepslate_diamond_ore', 'coal_ore', 'deepslate_coal_ore', 'copper_ore', 'gold_ore'],
    64,
    64,
  )
  const logs = scanBlockPositions(bot, LOG_BLOCK_NAMES, 64, 64)
  const stationRuntimeLog = (event: string, detail?: Record<string, unknown>): void => ctx.log(event, detail)
  const tableValidation = validateRememberedStations(bot, 'crafting_table', world.craftingTables, tables, now, stationRuntimeLog)
  const furnaceValidation = validateRememberedStations(bot, 'furnace', world.furnaces, furnaces, now, stationRuntimeLog)
  const newTables = registerLiveStations(bot, 'crafting_table', tableValidation.kept, tables, now, stationRuntimeLog)
  const newFurnaces = registerLiveStations(bot, 'furnace', furnaceValidation.kept, furnaces, now, stationRuntimeLog)
  const durableTables = tableValidation.kept
  const durableFurnaces = furnaceValidation.kept
  const removedStations: KnownStation[] = [...tableValidation.removed, ...furnaceValidation.removed]
  world.craftingTables = durableTables.filter((station) => isStationSelectable(station, now))
  world.furnaces = durableFurnaces.filter((station) => isStationSelectable(station, now))

  const runtimeFailedStations = new Set<string>()

  function durableStations(kind: StationKind): KnownStation[] {
    return kind === 'furnace' ? durableFurnaces : durableTables
  }

  function stationRuntimeFailure(kind: StationKind, position: Vec3Json): void {
    const dedupeKey = `${kind}:${stationKey(position)}`
    if (runtimeFailedStations.has(dedupeKey)) return
    runtimeFailedStations.add(dedupeKey)
    const durable = durableStations(kind)
    let station = durable.find((current) => (current.kind ?? kind) === kind && stationKey(current) === stationKey(position))
    if (station === undefined) {
      station = normalizeStation(position, kind, now)
      durable.push(station)
    }
    const result = applyStationFailure(station, 'unreachable', Date.now())
    stationRuntimeLog('STATION_INVALIDATED', stationInvalidatedDetail(kind, station, 'unreachable'))
    if (result.invalidated) removeStation(durable, station)
    removeStation(kind === 'furnace' ? world.furnaces : world.craftingTables, station)
    ctx.proposeWorldMemory({
      ...(kind === 'furnace' ? { furnaces: [...durable] } : { craftingTables: [...durable] }),
      ...(result.invalidated ? { removeStations: [station] } : {}),
    })
  }

  function stationRuntimeUse(kind: StationKind, position: Vec3Json, source: 'placed' | null = null): void {
    const durable = durableStations(kind)
    const alreadyKnown = durable.some(
      (station) => (station.kind ?? kind) === kind && stationKey(station) === stationKey(position),
    )
    const registered = registerStation(durable, kind, position, Date.now())
    const selectable = kind === 'furnace' ? world.furnaces : world.craftingTables
    if (!selectable.some((current) => stationKey(current) === stationKey(registered))) selectable.push(registered)
    if (source === 'placed') {
      if (!alreadyKnown) stationRuntimeLog('STATION_REGISTERED', stationRegisteredPlacedDetail(kind, position))
    } else {
      stationRuntimeLog('STATION_REGISTERED', stationRegisteredDetail(kind, position))
    }
    ctx.proposeWorldMemory(kind === 'furnace' ? { furnaces: [...durable] } : { craftingTables: [...durable] })
  }

  function handleStationEvent(event: string, detail: Record<string, unknown> | undefined): void {
    if (event === 'KNOWN_RESOURCE_UNREACHABLE') {
      const item = typeof detail?.item === 'string' ? detail.item : null
      const at = asVec3Json(detail?.at)
      if (at !== null && (item === 'furnace' || item === 'crafting_table')) stationRuntimeFailure(item, at)
      return
    }
    if (event === 'RETRIEVE_STALLED') {
      const at = asVec3Json(detail?.target)
      if (at === null) return
      for (const kind of ['furnace', 'crafting_table'] as const) {
        if (durableStations(kind).some((current) => stationKey(current) === stationKey(at))) stationRuntimeFailure(kind, at)
      }
      return
    }
    if (event === 'FURNACE_READY') {
      const at = asVec3Json(detail?.target)
      if (at !== null) stationRuntimeUse('furnace', at, detail?.source === 'placed' ? 'placed' : null)
    }
  }

  const heldStationItems = new Set(['furnace', 'crafting_table'].filter((item) => (counts[item] ?? 0) > 0))
  const unusableStationKeys = new Set<string>()
  for (const station of [...durableFurnaces, ...durableTables]) {
    if (isStationSelectable(station, now)) continue
    unusableStationKeys.add(`${station.kind ?? 'furnace'}:${stationKey(station)}`)
  }
  const discoveredOres: string[] = []
  const foundResources: KnownResourceJson[] = []
  const seenAt = Date.now()
  for (const ore of ores) {
    const name = bot.blockAt(new Vec3(ore.x, ore.y, ore.z))?.name ?? 'unknown_ore'
    if (!world.discoveredOres.includes(name)) world.discoveredOres.push(name)
    if (!discoveredOres.includes(name)) discoveredOres.push(name)
    foundResources.push({
      name,
      kind: 'ore',
      x: ore.x,
      y: ore.y,
      z: ore.z,
      dimension: ctx.worldKey.dimension,
      worldEpoch: ctx.worldKey.worldEpoch,
      lastSeenAt: seenAt,
    })
  }
  for (const log of logs) {
    const name = bot.blockAt(new Vec3(log.x, log.y, log.z))?.name ?? 'unknown_log'
    foundResources.push({
      name,
      kind: 'log',
      x: log.x,
      y: log.y,
      z: log.z,
      dimension: ctx.worldKey.dimension,
      worldEpoch: ctx.worldKey.worldEpoch,
      lastSeenAt: seenAt,
    })
  }
  const staleRemovals = evictStaleKnownResources(bot, world.knownResources, ctx.worldKey, (event, detail) => ctx.log(event, detail))
  const newKnownResources = mergeKnownResources(
    world.knownResources,
    foundResources,
    (event, detail) => ctx.log(event, detail),
    ctx.worldKey.worldEpoch,
  )
  const proposal: WorldMemoryDelta = {
    craftingTables: durableTables,
    furnaces: durableFurnaces,
    removeStations: removedStations,
    discoveredOres,
    knownResources: foundResources,
    removeKnownResources: staleRemovals,
    traversalFailures: world.traversalFailures,
    moveFailures: world.moveFailures,
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
    knownResources: world.knownResources.length,
    newKnownResources,
    moveFailures: world.moveFailures.length,
    removedStations: removedStations.length,
  })

  const resume = deriveResumeRung(counts, world, (event, detail) => ctx.log(event, detail))
  const ledger = resolveLedgerPath(ctx, counts, world, id)
  const ledgerPath = ledger.usablePath
  const ladder = buildLadder(counts, world, (event, detail) => ctx.log(event, detail), {
    dimension: ctx.bot.game?.dimension ?? null,
    placedFurnacesNear: furnaces.length,
    knownFurnaces: world.furnaces.length,
    resumeRungIndex: resume.rungIndex,
  })
  if (ladder.unsatisfiable !== null) {
    ctx.log('LADDER_UNSATISFIABLE', { reason: ladder.unsatisfiable, rungId: ladder.rungId })
  }

  // A reset resumes from the LIVE inventory; `invEmpty` is computed, not assumed.
  if (ctx.resetReason !== null || resume.rungIndex > 0) {
    const resumeReason = ctx.resetReason ?? 'inventory-resume'
    const resumeGoals = snapshotGoals(ctx.ledgerSnapshot)
    if (ctx.ledgerSnapshot === null || !Array.isArray(ctx.ledgerSnapshot.goals)) {
      ctx.log('LADDER_RESUME_NO_SNAPSHOT', { reason: resumeReason, goals: resumeGoals.length })
    }
    ctx.log('LADDER_RESUME', {
      rung: resume.rungId,
      rungIndex: resume.rungIndex,
      reason: resumeReason,
      invEmpty: resume.invEmpty,
      ...(resume.fallbackFrom === null ? {} : { fallbackFrom: resume.fallbackFrom, fallbackNeed: resume.fallbackNeed }),
      inventory: counts,
    })
  }
  if (ctx.resetReason !== null) {
    ctx.log('LADDER_RESET', {
      reason: ctx.resetReason,
      invEmpty: resume.invEmpty,
      rungIndex: ladder.rungIndex,
      rungId: ladder.rungId,
      goals: ladder.goals.map((goal) => goal.description),
    })
  }

  // The planner IS the env switch: deterministic keeps the original single-shot
  // contract, so every decision record truthfully reports `llm.called == false`.
  // `llm` turns the controller's exception paths into bounded replans.
  const plannerMode = resolvePlannerMode()

  // OWNER DIRECTIVE: a model failure is never hidden. The host terminator logs a
  // FATAL line (through each component's log) and exits non-zero, so the resident
  // process stops instead of silently degrading to the deterministic ladder.
  const terminateResident = (): never => {
    ctx.log('ERROR', { code: 'MODEL_UNAVAILABLE', action: 'terminate-resident', pid: process.pid, exitCode: 1 })
    process.exit(1)
  }

  // Durable caches (survive hot reloads; keyed by world-state hash).
  const cacheNamespace = worldCacheNamespace(ctx.worldKey)
  const cachePath = fileURLToPath(new URL(`./planner-cache-${cacheNamespace}.json`, import.meta.url))
  const advisorCachePath = fileURLToPath(new URL(`./advisor-cache-${cacheNamespace}.json`, import.meta.url))
  const advisor = new Advisor({
    log: (event, detail) => ctx.log(event, detail),
    cachePath: advisorCachePath,
    mode: resolveAdvisorMode(plannerMode),
    terminate: terminateResident,
    compile: (strategy, state) =>
      goalsForStrategy(strategy, state.inventory, world, {
        placedFurnacesNear: furnaces.length,
        knownFurnaces: world.furnaces.length,
      }),
  })

  const postDeathRecovery = ctx.resetReason === 'death'
  const mercuryConfigPath = process.env.BUDDY_SYSTEM2_CONFIG ?? join(process.cwd(), 'system2.config.json')
  const mercuryEnablement = resolveMercuryEnablement(plannerMode, mercuryConfigPath)
  const mercuryCachePath = fileURLToPath(new URL(`./mercury-cache-${cacheNamespace}.json`, import.meta.url))
  const mercury = mercuryEnablement.enabled
    ? new MercurySystem2({
        summarize: (request, trigger) => buildMercurySummary(bot, world, request, trigger),
        log: (event, detail) => ctx.log(event, detail),
        callsPath: mercuryCallsPath(ctx.logDir),
        cachePath: mercuryCachePath,
        worldKey: { serverId: ctx.worldKey.serverId, dimension: ctx.worldKey.dimension, worldEpoch: ctx.worldKey.worldEpoch },
        terminate: terminateResident,
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
    // goal list it returns.
    // OWNER DIRECTIVE (#11): LLM and Jev invocation are MANDATORY. The Jev action
    // policy uses the real TypeSafeJevPolicy whenever a gateway key resolves;
    // deterministic is opt-in only via BUDDY_POLICY=fallback (offline/CI).
    singleShotPlanner: plannerMode === 'deterministic',
    // Bounded replan frequency: the planner also throttles LLM calls itself, but
    // keep the controller from re-summoning every tick while a goal is blocked.
    llmCooldownMs: 15000,
    ledgerPath: null,
    stopAfterSubgoals: 0,
    logDir: ctx.logDir,
    // Real Jev policy by default (key from the gateway key file or
    // AI_GATEWAY_API_KEY); deterministic fallback only when explicitly requested.
    forceFallbackPolicy: (process.env.BUDDY_POLICY ?? '').trim().toLowerCase() === 'fallback',
    terminateOnModelFailure: terminateResident,
    actuation: 'pathfinder',
    actuationPort,
    reach: 5,
    scanRadius: 48,
    verbose: true,
    eventSink: (event, detail) => {
      ctx.log(event, { ...detail, generationId: id })
      handleStationEvent(event, detail)
    },
    moveFailureEntries: world.moveFailures,
    onMoveFailureMemoryChange: (entries) => {
      world.moveFailures = entries.map((entry) => ({ ...entry }))
      ctx.proposeWorldMemory({ moveFailures: world.moveFailures })
    },
    knownResources: [
      ...world.knownResources
        .filter((resource) => {
          if (resource.kind !== 'station') return true
          if (heldStationItems.has(resource.name)) return false
          return !unusableStationKeys.has(`${resource.name}:${stationKey(resource)}`)
        })
        .map((resource) => ({
          name: resource.name,
          kind: resource.kind,
          position: { x: resource.x, y: resource.y, z: resource.z },
          ...(resource.dimension === undefined ? {} : { dimension: resource.dimension }),
          ...(resource.worldEpoch === undefined ? {} : { worldEpoch: resource.worldEpoch }),
        })),
      ...(heldStationItems.has('furnace')
        ? []
        : world.furnaces.map((furnace) => ({
            name: 'furnace',
            kind: 'station' as const,
            position: { x: furnace.x, y: furnace.y, z: furnace.z },
          }))),
      ...(heldStationItems.has('crafting_table')
        ? []
        : world.craftingTables.map((table) => ({
            name: 'crafting_table',
            kind: 'station' as const,
            position: { x: table.x, y: table.y, z: table.z },
          }))),
    ],
  }

  const controller = new JevController(bot, options)
  // The stock fallback has no DESCEND branch; without this wrapper a stalled
  // stone/iron goal whose only productive candidate is a descent step WAITs
  // forever and wedges. Hazards from death are excluded here.
  installDescendAwarePolicy(controller, world.hazards, (event, detail) => ctx.log(event, detail))
  restoreLedgerIntoController(controller, ctx.ledgerSnapshot, ledgerPath, counts, world, ctx.log)
  const brain = new PlannerBrain({
    bot,
    world,
    log: (event, detail) => ctx.log(event, detail),
    cachePath,
    worldKey: { serverId: ctx.worldKey.serverId, dimension: ctx.worldKey.dimension, worldEpoch: ctx.worldKey.worldEpoch },
    mode: plannerMode,
    advisor,
    mercury,
    terminate: terminateResident,
    postDeathRecovery,
  })

  // #21: opt-in Option compiler. OFF by default, so the planner output continues
  // to enter the GoalQueue verbatim (the ledger and deterministic guarantees are
  // untouched). When BUDDY_OPTION_COMPILER is enabled, every planned goal is
  // compiled into a grounded OptionSpec and unmet preconditions are expanded into
  // their prerequisite chain before the queue is seeded.
  const optionCompilerEnabled = resolveOptionCompilerEnabled()
  const system2: System2Brain = optionCompilerEnabled
    ? new OptionCompilingSystem2(brain, {
        log: (event, detail) => ctx.log(event, detail),
        snapshot: () => optionSnapshotFromBot(ctx.bot, world, ctx.bot.game?.dimension ?? null),
      })
    : brain
  controller.setSystem2(system2)

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
    optionCompiler: optionCompilerEnabled,
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
        proposeLedger()
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
    proposeLedger()
    // Bounded settle: the executor cancels the in-flight action on stop.
    await Promise.race([runPromise ?? Promise.resolve(), delay(3000, ctx.resources)])
  }

  function proposeLedger(): void {
    try {
      const holder = controller as unknown as { queue: { snapshot(): GoalQueueSnapshot } }
      ctx.proposeLedger({ generationId: id, baseRevision: ctx.snapshotRevision, ledger: holder.queue.snapshot() })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.log('ERROR', { id, where: 'proposeLedger', message })
    }
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
    const frontier = deriveResumeRung(truth.inventory, world)
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
      worldKey: ctx.worldKey,
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
    check('contract-version', () => CONTRACT_VERSION === 3)
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
