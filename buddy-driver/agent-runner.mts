// agent-runner.mts - the HOST. It owns the one long-lived Mineflayer connection
// and swaps the reloadable intelligence (a hash-stamped esbuild bundle) without
// ever reconnecting.
//
//   HOST (never reloaded): createBot + plugins, reconnect backoff, logger,
//          durable state mirror (buddy-state.json), control socket, reload arbiter
//   GENERATION (swapped): the jev-agent controller + planner, bundled to ONE file
//
// Launch (detached, survives the shell):
//   cd /home/s0u7a/mc-ai/buddy-driver && setsid nohup node agent-runner.mts \
//     </dev/null > runner.out 2>&1 &
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { execSync } from 'node:child_process'
import { createServer } from 'node:net'
import type { Socket } from 'node:net'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import mineflayer from 'mineflayer'
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import pathfinderModule from 'mineflayer-pathfinder'
import { plugin as collectBlockPlugin } from 'mineflayer-collectblock'
import { buildGeneration } from './build.mts'
import type {
  AcceptanceRecord,
  ActuationLease,
  DeathHazard,
  GenerationContext,
  GenerationModule,
  GenerationStatus,
  KnownResourceJson,
  ResidentGeneration,
  ResidentState,
  ResidentWorldMemory,
  StructuralSmokeResult,
  Vec3Json,
  WorldKey,
  WorldMemoryDelta,
} from './resident-types.ts'
import { emptyWorldMemory, normalizeWorldMemory, worldKeyString } from './resident-types.ts'

const CONTRACT_VERSION = 2
const STATE_SCHEMA_VERSION = 2
const LISTENER_EVENTS = [
  'physicsTick',
  'goal_reached',
  'goal_updated',
  'path_update',
  'blockUpdate',
  'entitySpawn',
  'health',
  'playerCollect',
  'death',
  'end',
  'kicked',
] as const

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA = join(HERE, 'data', 'resident')
const LOGS = join(HERE, 'logs')
const JEV_LOGS = join(LOGS, 'jev')
const FREEZE_DIR = join(LOGS, 'resident')
const LEDGER = join(HERE, 'buddy-ledger.json')
const STATE_PATH = join(HERE, 'buddy-state.json')
const LOG_PATH = join(HERE, 'buddy.log')
const SOCK = join(DATA, 'control.sock')
const MC_AI = dirname(HERE)
const JEV_SRC = join(MC_AI, 'jev-agent', 'src')

const HOST = '127.0.0.1'
const PORT = 25565
const USERNAME = 'AI_Buddy'
const VERSION = '1.21.11'
const RECONNECT_MS = 5000
const HEARTBEAT_MS = 15000
const OBSERVE_MS = 1500
const RELOAD_DEBOUNCE_MS = 1200
const GEN_RESTART_MS = 3000
const GOAL_ITEM = 'iron_ingot'
const GOAL_COUNT = 3

for (const dir of [DATA, LOGS, JEV_LOGS, FREEZE_DIR]) mkdirSync(dir, { recursive: true })

// ---------------------------------------------------------------------------
// logging (structured, append-only, also to stdout for runner.out)
// ---------------------------------------------------------------------------
function fmtValue(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function log(event: string, detail?: Record<string, unknown>): void {
  const parts: string[] = []
  for (const [key, value] of Object.entries(detail ?? {})) parts.push(`${key}=${fmtValue(value)}`)
  const line = `[${new Date().toISOString()}] ${event}${parts.length > 0 ? ` ${parts.join(' ')}` : ''}`
  try {
    appendFileSync(LOG_PATH, `${line}\n`)
  } catch {
    // never let logging kill the resident
  }
  process.stdout.write(`${line}\n`)
}

function fmtPos(pos: Vec3Json | null): string {
  if (pos === null) return '?'
  return `${pos.x.toFixed(1)},${pos.y.toFixed(1)},${pos.z.toFixed(1)}`
}

function shortInv(inv: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [name, n] of Object.entries(inv)) {
    if (n > 0) out[name] = n
  }
  return out
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// durable state mirror (in-memory is the truth; tmp -> rename is the mirror)
// ---------------------------------------------------------------------------
const SERVER_ID = `${HOST}:${PORT}`

function normalizeDimension(dimension: string | undefined): string {
  if (dimension === undefined || dimension.length === 0) return 'minecraft:overworld'
  if (dimension.includes(':')) return dimension
  return `minecraft:${dimension}`
}

function currentWorldKey(): WorldKey {
  return { serverId: state.serverId, dimension: state.dimension, worldEpoch: state.worldEpoch }
}

function keyedMemory(): ResidentWorldMemory {
  const key = worldKeyString(currentWorldKey())
  const existing = state.worldMemoryByKey[key]
  if (existing !== undefined) return normalizeWorldMemory(existing)
  const created = emptyWorldMemory()
  state.worldMemoryByKey[key] = created
  return created
}

function cloneMemory(memory: ResidentWorldMemory): ResidentWorldMemory {
  const normal = normalizeWorldMemory(memory)
  return {
    craftingTables: normal.craftingTables.map((p) => ({ ...p })),
    furnaces: normal.furnaces.map((p) => ({ ...p })),
    mined: { ...normal.mined },
    discoveredOres: [...normal.discoveredOres],
    knownResources: normal.knownResources.map((resource) => ({ ...resource })),
    traversalFailures: normal.traversalFailures.map((t) => ({ ...t, from: { ...t.from }, toward: { ...t.toward } })),
    hazards: normal.hazards.map((h) => ({ ...h })),
  }
}

function defaultState(): ResidentState {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    revision: 0,
    worldEpoch: 1,
    generationId: null,
    bot: USERNAME,
    serverId: SERVER_ID,
    dimension: 'minecraft:overworld',
    levelName: null,
    firstSeenAt: Date.now(),
    updatedAt: Date.now(),
    milestoneIndex: -1,
    milestone: null,
    ledger: null,
    worldMemoryByKey: {},
    generations: 0,
    reloads: 0,
    recoveries: 0,
    lastGenerationId: null,
    actions: 0,
  }
}

function loadState(): ResidentState {
  const base = defaultState()
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, 'utf8')) as Partial<ResidentState> & { worldMemory?: ResidentWorldMemory }
    const merged: ResidentState = {
      ...base,
      ...parsed,
      schemaVersion: STATE_SCHEMA_VERSION,
      worldMemoryByKey: { ...(parsed.worldMemoryByKey ?? {}) },
    }
    delete (merged as unknown as Record<string, unknown>).worldMemory
    if (parsed.worldMemory !== undefined && Object.keys(merged.worldMemoryByKey).length === 0) {
      merged.worldMemoryByKey[worldKeyString({ serverId: merged.serverId, dimension: merged.dimension, worldEpoch: merged.worldEpoch })] = {
        ...emptyWorldMemory(),
        ...parsed.worldMemory,
        traversalFailures: parsed.worldMemory.traversalFailures ?? [],
      }
    }
    for (const memory of Object.values(merged.worldMemoryByKey)) normalizeWorldMemory(memory)
    merged.dimension = normalizeDimension(merged.dimension)
    const remapped: Record<string, ResidentWorldMemory> = {}
    for (const [key, memory] of Object.entries(merged.worldMemoryByKey)) {
      const parts = key.split('|')
      const canonical = parts.length === 3 ? `${parts[0]}|${normalizeDimension(parts[1])}|${parts[2]}` : key
      const existing = remapped[canonical]
      const score = (m: ResidentWorldMemory): number => m.craftingTables.length + m.furnaces.length + m.discoveredOres.length
      if (existing === undefined || score(memory) > score(existing)) remapped[canonical] = memory
    }
    merged.worldMemoryByKey = remapped
    return merged
  } catch {
    return base
  }
}

let state = loadState()

function saveState(event = 'save'): void {
  state.updatedAt = Date.now()
  state.revision += 1
  try {
    const tmp = `${STATE_PATH}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`)
    renameSync(tmp, STATE_PATH)
  } catch (error) {
    log('ERROR', { where: 'saveState', event, message: error instanceof Error ? error.message : String(error) })
  }
}

function applyWorldMemoryDelta(delta: WorldMemoryDelta): void {
  const memory = keyedMemory()
  if (delta.craftingTables !== undefined) mergeStationDtos(memory.craftingTables, delta.craftingTables)
  if (delta.furnaces !== undefined) mergeStationDtos(memory.furnaces, delta.furnaces)
  if (delta.discoveredOres !== undefined) {
    for (const ore of delta.discoveredOres) {
      if (!memory.discoveredOres.includes(ore)) memory.discoveredOres.push(ore)
    }
  }
  if (delta.knownResources !== undefined) mergeKnownResourceDtos(memory.knownResources, delta.knownResources)
  if (delta.mined !== undefined) {
    for (const [key, count] of Object.entries(delta.mined)) {
      memory.mined[key] = (memory.mined[key] ?? 0) + count
    }
  }
  if (delta.traversalFailures !== undefined) {
    memory.traversalFailures = delta.traversalFailures.map((t) => ({ ...t, from: { ...t.from }, toward: { ...t.toward } }))
  }
  if (delta.hazards !== undefined) {
    for (const hazard of delta.hazards) mergeHazard(memory.hazards, hazard)
  }
  saveState('world-memory')
}

function hazardKey(h: { x: number; y: number; z: number }): string {
  return `${Math.round(h.x)},${Math.round(h.y)},${Math.round(h.z)}`
}

/** Merge a death coordinate. The HOST is the only writer; two deaths at the same
 * rounded coordinate make the hazard permanent (`count >= 2`). */
function mergeHazard(target: DeathHazard[], found: DeathHazard): DeathHazard {
  const key = hazardKey(found)
  const existing = target.find((h) => hazardKey(h) === key)
  if (existing === undefined) {
    const created: DeathHazard = {
      x: Math.round(found.x),
      y: Math.round(found.y),
      z: Math.round(found.z),
      reason: found.reason,
      count: Math.max(1, found.count),
      firstSeenAt: found.firstSeenAt || Date.now(),
      lastSeenAt: found.lastSeenAt || Date.now(),
    }
    target.push(created)
    if (target.length > 128) target.splice(0, target.length - 128)
    return created
  }
  existing.count += Math.max(1, found.count)
  existing.reason = found.reason
  existing.lastSeenAt = found.lastSeenAt || Date.now()
  return existing
}

function mergeStationDtos(target: Vec3Json[], found: Vec3Json[]): number {
  const seen = new Set(target.map((p) => `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`))
  let added = 0
  for (const pos of found) {
    const key = `${Math.round(pos.x)},${Math.round(pos.y)},${Math.round(pos.z)}`
    if (seen.has(key)) continue
    seen.add(key)
    target.push({ x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) })
    added += 1
  }
  return added
}

function mergeKnownResourceDtos(target: KnownResourceJson[], found: KnownResourceJson[]): number {
  const seen = new Set(target.map((resource) => `${resource.name}@${Math.round(resource.x)},${Math.round(resource.y)},${Math.round(resource.z)}`))
  let added = 0
  for (const resource of found) {
    const key = `${resource.name}@${Math.round(resource.x)},${Math.round(resource.y)},${Math.round(resource.z)}`
    if (seen.has(key)) continue
    if (target.length >= 256) break
    seen.add(key)
    target.push({
      name: resource.name,
      kind: resource.kind,
      x: Math.round(resource.x),
      y: Math.round(resource.y),
      z: Math.round(resource.z),
    })
    added += 1
  }
  return added
}

function archiveLedger(reason: string): void {
  if (!existsSync(LEDGER)) return
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    renameSync(LEDGER, join(DATA, `ledger-complete-${stamp}.json`))
    log('RECOVERY', { reason: 'ledger archived', detail: reason })
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// bot + generation lifecycle
// ---------------------------------------------------------------------------
let bot: Bot | null = null
let generation: ResidentGeneration | null = null
let generationModule: GenerationModule | null = null
let currentBundle: string | null = null
let reconnecting = false
let shuttingDown = false
let frozen = false
let generationRestartTimer: NodeJS.Timeout | null = null
let reloadTimer: NodeJS.Timeout | null = null
let lastSrcSignature = ''
let lastInventoryHash = ''
let lastActionId: string | null = null
let lastHeartbeatAt = 0
let activeGenerationId: string | null = null
let generationHash: string | null = null
let listenerBaseline: Record<string, number> = {}
let baselineCaptured = false
let startPosition: Vec3Json | null = null
let lastStatus: GenerationStatus | null = null
let hasConnected = false
let deathResetPending = false
let pendingResetReason: string | null = null
let lastDeathAt = 0
let lastHealth: number | null = null
let lastSeenDeathPosition: Vec3Json | null = null

const runId = `run-${Date.now().toString(36)}-${process.pid.toString(36)}`
const stats = {
  reconnects: 0,
  reloadsChangedHash: 0,
  reloadsSkippedUnchanged: 0,
  reloadsFailed: 0,
  freezeCycles: 0,
  wedge: false,
  goalComplete: false,
}

// The HOST owns the lease. A generation may only act while its id is active;
// the reload commit point is exactly this switch. Rollback switches it back.
const lease: ActuationLease = {
  get activeId(): string {
    return activeGenerationId ?? ''
  },
  isActive: (id: string): boolean => activeGenerationId === id,
  assertActive: (id: string, what: string): void => {
    if (activeGenerationId !== id) {
      throw new Error(
        `ACTUATION_LEASE_DENIED what=${what} owner=${activeGenerationId ?? 'none'} caller=${id} - refusing a side-effecting call`,
      )
    }
  },
}

function listenerCounts(): Record<string, number> {
  const counts: Record<string, number> = {}
  if (bot === null) return counts
  const countable = bot as unknown as { listenerCount(event: string): number }
  for (const event of LISTENER_EVENTS) counts[event] = countable.listenerCount(event)
  return counts
}

function listenerLeak(): boolean {
  return Object.keys(listenerBaseline).some((event) => (listenerCounts()[event] ?? 0) > (listenerBaseline[event] ?? 0))
}

async function loadGenerationModule(force: boolean): Promise<GenerationModule | null> {
  if (!force && generationModule !== null) return generationModule
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const built = await buildGeneration()
      const mod = (await import(`${pathToFileURL(built.outfile).href}?v=${built.hash}`)) as GenerationModule
      if (mod.CONTRACT_VERSION !== CONTRACT_VERSION) {
        throw new Error(`CONTRACT_VERSION mismatch: generation=${mod.CONTRACT_VERSION} host=${CONTRACT_VERSION}`)
      }
      generationModule = mod
      currentBundle = built.outfile
      log('BUILD', { hash: built.hash, bytes: built.bytes, ms: built.ms, outfile: built.outfile })
      return mod
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log('ERROR', { where: 'loadGenerationModule', attempt, message })
      if (attempt < 3) await delay(5000)
    }
  }
  return null
}

/**
 * STRUCTURAL smoke: contract version, import surface, required methods, snapshot
 * schema, sensor readability, listener sanity. It must PASS with an EMPTY plan
 * and NO completed goals - hot reload never depends on a goal existing.
 */
function runStructuralSmoke(gen: ResidentGeneration): StructuralSmokeResult {
  let result: StructuralSmokeResult
  try {
    result = gen.structuralSmoke()
  } catch (error) {
    throw new Error(`structural smoke threw: ${error instanceof Error ? error.message : String(error)}`)
  }
  const surface = ['attach', 'start', 'quiesce', 'dispose', 'status', 'stopReason', 'hasStopped', 'structuralSmoke', 'missionPreflight'] as const
  for (const name of surface) {
    if (typeof (gen as unknown as Record<string, unknown>)[name] !== 'function') result.failures.push(`missing method ${name}`)
  }
  if (typeof gen.id !== 'string' || gen.id.length === 0) result.failures.push('missing generation id')
  if (typeof gen.rungId !== 'string') result.failures.push('missing rung id')
  if (result.failures.length > 0) {
    result.ok = false
    throw new Error(`structural smoke failed: ${result.failures.join('; ')}`)
  }
  return result
}

/** MISSION preflight: goal exists / candidates generatable. Never gates reload. */
function runMissionPreflight(gen: ResidentGeneration): { ok: boolean; reason: string | null; goalCount: number } {
  try {
    return gen.missionPreflight()
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error), goalCount: 0 }
  }
}

function makeGenerationContext(b: Bot): GenerationContext {
  return {
    bot: b,
    log,
    lease,
    worldMemory: cloneMemory(keyedMemory()),
    worldKey: currentWorldKey(),
    proposeWorldMemory: (delta) => applyWorldMemoryDelta(delta),
    ledgerPath: LEDGER,
    logDir: JEV_LOGS,
    goalItem: GOAL_ITEM,
    goalCount: GOAL_COUNT,
    resetReason: pendingResetReason,
  }
}

function watchGenerationStop(gen: ResidentGeneration): void {
  const guard = setInterval(() => {
    if (generation !== gen) {
      clearInterval(guard)
      return
    }
    if (!gen.hasStopped()) return
    clearInterval(guard)
    const stopped = gen.stopReason()
    generation = null
    if (activeGenerationId === gen.id) activeGenerationId = null
    if (stopped === 'wedge') stats.wedge = true
    if (stopped === 'goal-complete') stats.goalComplete = true
    if (shuttingDown || frozen || deathResetPending) return
    log('RECOVERY', { reason: 'generation-stopped', stopped })
    state.recoveries += 1
    if (stopped === 'goal-complete') archiveLedger('goal-complete')
    saveState('generation-stop')
    scheduleGenerationRestart('generation-stopped')
  }, 2000)
}

async function startGeneration(trigger: string): Promise<boolean> {
  if (bot === null || bot.entity === undefined) {
    log('ERROR', { where: 'startGeneration', message: 'no spawned bot', trigger })
    return false
  }
  if (generation !== null) {
    // Never run two generations on one bot: a respawn/hot path that starts a
    // generation while one is alive would double the bot listeners and race the
    // actuation lease. Dispose the old one first.
    const old = generation
    generation = null
    if (activeGenerationId === old.id) activeGenerationId = null
    try {
      await old.quiesce()
    } catch {
      // best effort
    }
    old.dispose()
  }
  const mod = await loadGenerationModule(false)
  if (mod === null) {
    scheduleGenerationRestart('module-unavailable')
    return false
  }
  const gen = mod.createGeneration(makeGenerationContext(bot))
  pendingResetReason = null
  gen.attach()
  runStructuralSmoke(gen)
  const preflight = runMissionPreflight(gen)
  log('MISSION_PREFLIGHT', { id: gen.id, ok: preflight.ok, goals: preflight.goalCount, reason: preflight.reason })
  activeGenerationId = gen.id
  try {
    gen.start()
  } catch (error) {
    activeGenerationId = null
    throw error
  }
  generation = gen
  lastActionId = null
  if (!baselineCaptured) {
    baselineCaptured = true
    listenerBaseline = listenerCounts()
    log('LISTENER_BASELINE', { listeners: listenerBaseline, generationId: gen.id })
  }
  state.generations += 1
  state.lastGenerationId = gen.id
  state.generationId = gen.id
  saveState('generation-start')
  log('GENERATION_START', { id: gen.id, trigger, rung: gen.rungId, rungIndex: gen.rungIndex, generations: state.generations })
  watchGenerationStop(gen)
  return true
}

function scheduleGenerationRestart(reason: string): void {
  if (generationRestartTimer !== null || shuttingDown || frozen || deathResetPending) return
  generationRestartTimer = setTimeout(() => {
    generationRestartTimer = null
    if (shuttingDown || frozen) return
    if (generation !== null) return
    void startGeneration(`recovery:${reason}`)
  }, GEN_RESTART_MS)
}

function inventorySummary(b: Bot): Record<string, number> {
  const out: Record<string, number> = {}
  try {
    for (const item of b.inventory.items()) out[item.name] = (out[item.name] ?? 0) + item.count
  } catch {
    // entity/inventory not readable at the death moment
  }
  return out
}

function blockNameAt(b: Bot, x: number, y: number, z: number): string {
  try {
    return b.blockAt(new Vec3(x, y, z))?.name ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Best-effort death cause from the pre-death position and surroundings. */
function inferDeathCause(b: Bot, pos: Vec3Json | null, healthBefore: number | null): string {
  if (pos === null) return 'unknown'
  if (pos.y <= -64) return 'void'
  const x = Math.floor(pos.x)
  const feet = Math.floor(pos.y)
  const z = Math.floor(pos.z)
  for (const [dx, dy, dz] of [
    [0, 0, 0],
    [0, -1, 0],
    [0, 1, 0],
    [1, 0, 0],
    [-1, 0, 0],
    [0, 0, 1],
    [0, 0, -1],
  ] as const) {
    const name = blockNameAt(b, x + dx, feet + dy, z + dz)
    if (name.includes('lava')) return 'lava'
    if (name.includes('water')) return 'water'
  }
  if (healthBefore !== null && healthBefore > 0) return 'damage'
  return 'unknown'
}

function registerDeathHazard(pos: Vec3Json, reason: string): DeathHazard {
  const memory = keyedMemory()
  const hazard = mergeHazard(memory.hazards, {
    x: pos.x,
    y: pos.y,
    z: pos.z,
    reason,
    count: 1,
    firstSeenAt: Date.now(),
    lastSeenAt: Date.now(),
  })
  saveState('death-hazard')
  return hazard
}

/** Death handling: log DEATH + lost inventory, register the hazard, stop the
 * current generation, and archive the ledger so the next respawn recomputes the
 * ladder from the LIVE (empty) inventory instead of resuming an impossible goal. */
/** Shared death/recovery pipeline: log DEATH, register the hazard, drop the
 * generation, archive the ledger, and force a fresh ladder computation. `simulated`
 * marks the operator rehearsal (`simdeath`) so it is never mistaken for a real
 * death; it still exercises the exact same recovery path end to end. */
function beginDeathRecovery(b: Bot, cause: string, simulated: boolean): { pos: Vec3Json | null; lost: Record<string, number> } {
  const entity = b.entity
  const pos: Vec3Json | null = entity === undefined ? null : { x: entity.position.x, y: entity.position.y, z: entity.position.z }
  const lost = inventorySummary(b)
  log('DEATH', {
    pos: pos === null ? '?' : fmtPos(pos),
    dimension: state.dimension,
    lostInventory: lost,
    itemsLost: Object.values(lost).reduce((sum, n) => sum + n, 0),
    cause,
    healthBefore: lastHealth,
    simulated,
  })
  lastDeathAt = Date.now()
  lastSeenDeathPosition = pos
  if (pos !== null) registerDeathHazard(pos, cause)
  deathResetPending = true
  pendingResetReason = 'death'
  const oldGeneration = generation
  generation = null
  activeGenerationId = null
  if (oldGeneration !== null) {
    try {
      oldGeneration.dispose()
    } catch {
      // best effort
    }
  }
  archiveLedger(simulated ? 'death-simulated' : 'death')
  saveState('death')
  log('LADDER_RESET', { reason: 'death', invEmpty: Object.keys(lost).length === 0, cause, simulated })
  return { pos, lost }
}

function handleBotDeath(b: Bot): void {
  const entity = b.entity
  const pos: Vec3Json | null = entity === undefined ? null : { x: entity.position.x, y: entity.position.y, z: entity.position.z }
  const cause = inferDeathCause(b, pos, lastHealth)
  beginDeathRecovery(b, cause, false)
}

function connect(): void {
  if (shuttingDown) return
  log('CONNECT', { host: HOST, port: PORT, username: USERNAME, version: VERSION })
  let created: Bot
  try {
    created = mineflayer.createBot({ host: HOST, port: PORT, username: USERNAME, version: VERSION, auth: 'offline' })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log('ERROR', { where: 'createBot', message })
    scheduleReconnect()
    return
  }
  bot = created
  created.loadPlugin(pathfinderModule.pathfinder)
  created.loadPlugin(collectBlockPlugin)

  created.on('spawn', () => {
    reconnecting = false
    hasConnected = true
    const wasDeath = deathResetPending
    deathResetPending = false
    pendingResetReason = wasDeath ? 'death' : null
    const entity = created.entity
    const game = created.game as unknown as { dimension?: string; levelName?: string } | undefined
    if (entity !== undefined && startPosition === null) {
      startPosition = { x: entity.position.x, y: entity.position.y, z: entity.position.z }
    }
    const observedDimension = normalizeDimension(game?.dimension)
    if (observedDimension !== state.dimension) {
      log('WORLD_KEY_CHANGED', { from: state.dimension, to: observedDimension, worldEpoch: state.worldEpoch })
      state.dimension = observedDimension
    }
    if (game?.levelName !== undefined) state.levelName = game.levelName
    baselineCaptured = false
    log('SPAWN', {
      pos: entity === undefined ? '?' : fmtPos({ x: entity.position.x, y: entity.position.y, z: entity.position.z }),
      version: created.version,
      health: created.health,
      username: created.username,
      dimension: state.dimension,
      worldEpoch: state.worldEpoch,
      respawn: wasDeath,
      listeners: listenerBaseline,
    })
    saveState('spawn')
    lastHeartbeatAt = Date.now()
    void startGeneration(wasDeath ? 'respawn' : 'spawn')
  })

  created.on('health', () => {
    if (created.health > 0) lastHealth = created.health
  })

  created.on('death', () => handleBotDeath(created))

  created.on('kicked', (reason: string) => {
    log('ERROR', { where: 'bot.kicked', reason: typeof reason === 'string' ? reason : JSON.stringify(reason) })
  })
  created.on('error', (error: Error) => {
    log('ERROR', { where: 'bot.error', message: error instanceof Error ? error.message : String(error) })
  })
  created.on('end', (reason: string) => {
    log('RECOVERY', { reason: 'disconnected', detail: reason ?? 'unknown' })
    if (generation !== null) {
      generation.dispose()
      generation = null
    }
    scheduleReconnect()
  })
}

function scheduleReconnect(): void {
  if (shuttingDown || reconnecting) return
  reconnecting = true
  if (hasConnected) stats.reconnects += 1
  log('RECONNECT', { inMs: RECONNECT_MS, reconnects: stats.reconnects })
  setTimeout(() => {
    if (shuttingDown) return
    reconnecting = false
    connect()
  }, RECONNECT_MS)
}

// ---------------------------------------------------------------------------
// observation loop: ACTION / INVENTORY / MILESTONE / HEARTBEAT
// ---------------------------------------------------------------------------
setInterval(() => {
  if (generation === null || bot === null || bot.entity === undefined) return
  if (frozen) return
  let status: GenerationStatus
  try {
    status = generation.status()
  } catch (error) {
    log('ERROR', { where: 'observe.status', message: error instanceof Error ? error.message : String(error) })
    return
  }

  lastStatus = status
  const truth = status.truth
  const action = status.currentAction
  if (action !== null && action.id !== lastActionId) {
    lastActionId = action.id
    state.actions += 1
    log('ACTION', {
      n: state.actions,
      id: action.id,
      kind: action.kind,
      phase: action.phase,
      pos: fmtPos(truth.position),
      rung: status.rungId,
    })
  } else if (action === null) {
    lastActionId = null
  }

  const stableInv = Object.keys(truth.inventory)
    .sort()
    .map((name) => `${name}:${truth.inventory[name] ?? 0}`)
    .join(',')
  const invHash = createHash('sha1').update(stableInv).digest('hex').slice(0, 12)
  if (invHash !== lastInventoryHash) {
    lastInventoryHash = invHash
    log('INVENTORY', { items: shortInv(truth.inventory), pos: fmtPos(truth.position) })
  }

  if (status.rungIndex > state.milestoneIndex) {
    state.milestoneIndex = status.rungIndex
    state.milestone = status.rungId
    log('MILESTONE', { name: status.rungId, done: true, index: status.rungIndex, queueDone: status.queue.done, inventory: shortInv(truth.inventory) })
    saveState('milestone')
  }

  if (Date.now() - lastHeartbeatAt >= HEARTBEAT_MS) {
    lastHeartbeatAt = Date.now()
    log('HEARTBEAT', {
      pos: fmtPos(truth.position),
      health: truth.health,
      running: status.running,
      rung: status.rungId,
      queue: status.queue.current?.description ?? 'none',
      depth: status.queue.depth,
      done: status.queue.done,
      action: status.currentAction?.kind ?? 'idle',
      inv: shortInv(truth.inventory),
    })
    state.ledger = status.queue
    saveState('heartbeat')
  }
}, OBSERVE_MS)

// ---------------------------------------------------------------------------
// source watcher -> hot reload
// ---------------------------------------------------------------------------
function sourceFiles(root: string): string[] {
  const out: string[] = []
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    if (dir === undefined) break
    let entries: Dirent[] = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue
        stack.push(full)
      } else if (entry.name.endsWith('.ts')) {
        out.push(full)
      }
    }
  }
  return out
}

function signatureOfSource(): string {
  const hash = createHash('sha1')
  for (const root of [JEV_SRC, HERE]) {
    for (const full of sourceFiles(root).sort()) {
      try {
        const info = statSync(full)
        hash.update(`${full}:${info.mtimeMs}:${info.size}\n`)
      } catch {
        // file disappeared mid-edit; ignore
      }
    }
  }
  const config = process.env.BUDDY_SYSTEM2_CONFIG ?? join(HERE, 'system2.config.json')
  try {
    const info = statSync(config)
    hash.update(`${config}:${info.mtimeMs}:${info.size}\n`)
  } catch {
    // config absent; default-off is not a reload trigger
  }
  return hash.digest('hex')
}

setInterval(() => {
  const sig = signatureOfSource()
  if (sig !== lastSrcSignature) {
    const first = lastSrcSignature === ''
    lastSrcSignature = sig
    if (!first) scheduleReload('source-changed')
  }
}, OBSERVE_MS)

function scheduleReload(trigger: string): void {
  if (reloadTimer !== null) return
  reloadTimer = setTimeout(() => {
    reloadTimer = null
    void performReload(trigger)
  }, RELOAD_DEBOUNCE_MS)
}

function depVersion(pkg: string): string {
  try {
    const raw = readFileSync(join(MC_AI, 'jev-agent', 'node_modules', pkg, 'package.json'), 'utf8')
    return (JSON.parse(raw) as { version?: string }).version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

function serverSeed(): string | null {
  try {
    const match = /^level-seed=(.*)$/m.exec(readFileSync('/home/s0u7a/mc-server/server.properties', 'utf8'))
    return match?.[1]?.trim() ?? null
  } catch {
    return null
  }
}

function gitCommit(): string | null {
  try {
    return execSync('git rev-parse HEAD', { cwd: MC_AI, encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

function writeAcceptance(): string {
  const counts = listenerCounts()
  const record: AcceptanceRecord = {
    record: 'acceptance',
    runId,
    ts: new Date().toISOString(),
    gitCommit: gitCommit(),
    generationHash,
    generationId: activeGenerationId,
    contractVersion: CONTRACT_VERSION,
    stateSchemaVersion: state.schemaVersion,
    stateRevision: state.revision,
    dependencies: {
      mineflayer: depVersion('mineflayer'),
      'minecraft-protocol': depVersion('minecraft-protocol'),
      'minecraft-data': depVersion('minecraft-data'),
      'mineflayer-pathfinder': depVersion('mineflayer-pathfinder'),
      vec3: depVersion('vec3'),
    },
    serverId: state.serverId,
    dimension: state.dimension,
    levelName: state.levelName,
    worldEpoch: state.worldEpoch,
    seed: serverSeed(),
    botUsername: USERNAME,
    startPosition,
    mode: lastStatus?.policyKind === 'typesafe' ? 'llm' : 'deterministic',
    goalComplete: stats.goalComplete,
    wedge: stats.wedge,
    reconnects: stats.reconnects,
    reloads: state.reloads,
    reloadsChangedHash: stats.reloadsChangedHash,
    reloadsSkippedUnchanged: stats.reloadsSkippedUnchanged,
    reloadsFailed: stats.reloadsFailed,
    freezeCycles: stats.freezeCycles,
    listenerBaseline,
    listenerCurrent: counts,
    listenerLeak: listenerLeak(),
    worldMemoryKeys: Object.keys(state.worldMemoryByKey),
  }
  const path = join(DATA, `acceptance-${runId}.json`)
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`)
  renameSync(tmp, path)
  return path
}

/**
 * Swap order (atomic): build -> import -> structural smoke -> prepare(new) ->
 * old quiesce -> snapshot -> new healthcheck -> ACTION LEASE SWITCH (commit) ->
 * new start -> old dispose. Before the commit the new generation cannot act;
 * rollback switches the lease back to the old module and resumes it.
 */
async function performReload(trigger: string): Promise<void> {
  const started = Date.now()
  if (bot === null || bot.entity === undefined) {
    stats.reloadsFailed += 1
    log('RELOAD', { ok: false, trigger, reason: 'no live bot' })
    return
  }
  try {
    const built = await buildGeneration()
    if (built.outfile === currentBundle && generationModule !== null) {
      stats.reloadsSkippedUnchanged += 1
      log('RELOAD', { ok: true, trigger, skipped: 'unchanged', ms: Date.now() - started })
      return
    }
    const mod = (await import(`${pathToFileURL(built.outfile).href}?v=${built.hash}`)) as GenerationModule
    if (mod.CONTRACT_VERSION !== CONTRACT_VERSION) {
      throw new Error(`CONTRACT_VERSION mismatch: generation=${mod.CONTRACT_VERSION} host=${CONTRACT_VERSION}`)
    }
    const previous = generation
    const previousModule = generationModule
    const next = mod.createGeneration(makeGenerationContext(bot))
    next.attach()
    const smoke = runStructuralSmoke(next)
    log('SMOKE', { id: next.id, ok: smoke.ok, checks: smoke.checks.length, failures: smoke.failures })
    if (frozen) {
      // Frozen: validate and remember the new module, but do NOT swap/start it.
      // `resume` commits and starts exactly this module.
      generationModule = mod
      currentBundle = built.outfile
      generationHash = built.hash
      stats.reloadsChangedHash += 1
      log('RELOAD', { ok: true, trigger, deferred: 'frozen', ms: Date.now() - started, hash: built.hash, contractVersion: mod.CONTRACT_VERSION })
      return
    }
    if (previous !== null) await previous.quiesce()
    state.reloads += 1
    state.generations += 1
    state.lastGenerationId = next.id
    saveState('reload-snapshot')
    const preflight = runMissionPreflight(next)
    log('MISSION_PREFLIGHT', { id: next.id, ok: preflight.ok, goals: preflight.goalCount, reason: preflight.reason, trigger })
    activeGenerationId = next.id
    generation = next
    try {
      next.start()
    } catch (startError) {
      generation = null
      activeGenerationId = null
      if (previous !== null && previousModule !== null) {
        const resumed = previousModule.createGeneration(makeGenerationContext(bot))
        resumed.attach()
        activeGenerationId = resumed.id
        generation = resumed
        resumed.start()
        log('RELOAD_ROLLBACK', { from: next.id, resumed: resumed.id })
      }
      throw startError
    }
    generationModule = mod
    currentBundle = built.outfile
    generationHash = built.hash
    state.generationId = next.id
    lastActionId = null
    if (previous !== null) previous.dispose()
    stats.reloadsChangedHash += 1
    saveState('reload-commit')
    const counts = listenerCounts()
    log('RELOAD', {
      ok: true,
      trigger,
      ms: Date.now() - started,
      hash: built.hash,
      id: next.id,
      generations: state.generations,
      listeners: counts,
      listenerLeak: listenerLeak(),
    })
    log('ACCEPTANCE', { path: writeAcceptance(), runId })
    watchGenerationStop(next)
  } catch (error) {
    stats.reloadsFailed += 1
    const message = error instanceof Error ? error.message : String(error)
    log('ERROR', { where: 'performReload', trigger, message })
    log('RELOAD', { ok: false, trigger, ms: Date.now() - started, message })
  }
}

// ---------------------------------------------------------------------------
// control channel: unix socket, 0600
// ---------------------------------------------------------------------------
interface ControlRequest {
  id?: string
  cmd?: string
  args?: Record<string, unknown>
}

function controlReply(socket: Socket, request: ControlRequest, ok: boolean, data: unknown): void {
  socket.write(`${JSON.stringify({ id: request.id ?? null, ok, data })}\n`)
}

function freezeReport(reason: string, status: unknown): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const path = join(FREEZE_DIR, `freeze-${stamp}.json`)
  const payload = {
    record: 'freeze',
    ts: new Date().toISOString(),
    reason,
    bot: USERNAME,
    runId,
    generationId: activeGenerationId,
    worldKey: currentWorldKey(),
    reconcileKey: worldKeyString(currentWorldKey()),
    state,
    status,
    recentDecisions: state.ledger,
    listeners: listenerCounts(),
    heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1048576),
  }
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`)
  renameSync(tmp, path)
  return path
}

async function handleControl(request: ControlRequest, socket: Socket): Promise<void> {
  const cmd = request.cmd ?? ''
  if (cmd === 'report' || cmd === 'status') {
    const status = generation === null ? null : generation.status()
    const memory = keyedMemory()
    controlReply(socket, request, true, {
      runId,
      frozen,
      connected: bot !== null && bot.entity !== undefined,
      generations: state.generations,
      reloads: state.reloads,
      recoveries: state.recoveries,
      milestone: state.milestone,
      worldKey: currentWorldKey(),
      generationId: activeGenerationId,
      generationHash,
      contractVersion: CONTRACT_VERSION,
      stats,
      worldMemory: {
        craftingTables: memory.craftingTables.length,
        furnaces: memory.furnaces.length,
        discoveredOres: memory.discoveredOres,
        traversalFailures: memory.traversalFailures.length,
        hazards: memory.hazards.length,
        hardHazards: memory.hazards.filter((h) => h.count >= 2).length,
      },
      listeners: listenerCounts(),
      listenerBaseline,
      listenerLeak: listenerLeak(),
      acceptancePath: join(DATA, `acceptance-${runId}.json`),
      status,
    })
    return
  }
  if (cmd === 'reload') {
    void performReload('control')
    controlReply(socket, request, true, { scheduled: true })
    return
  }
  if (cmd === 'freeze') {
    frozen = true
    stats.freezeCycles += 1
    let path: string | null = null
    if (generation !== null) {
      const status = generation.status()
      path = freezeReport('control', status)
      await generation.quiesce()
      activeGenerationId = null
    }
    log('FREEZE', { reason: 'control', report: path, freezeCycles: stats.freezeCycles })
    writeAcceptance()
    controlReply(socket, request, true, { frozen: true, report: path, runId })
    return
  }
  if (cmd === 'resume') {
    frozen = false
    const ok = await startGeneration('control:resume')
    log('RESUME', { ok, reconnect: false })
    writeAcceptance()
    controlReply(socket, request, true, { frozen: false, started: ok })
    return
  }
  if (cmd === 'simdeath') {
    if (bot === null || bot.entity === undefined) {
      controlReply(socket, request, false, { error: 'no live bot' })
      return
    }
    const old = generation
    generation = null
    activeGenerationId = null
    if (old !== null) {
      try {
        await old.quiesce()
      } catch {
        // best effort
      }
      old.dispose()
    }
    for (const item of bot.inventory.items()) {
      try {
        await bot.toss(item.type, null, item.count)
      } catch {
        // best effort: keep dropping the rest
      }
    }
    await delay(600)
    const { lost } = beginDeathRecovery(bot, 'simulated', true)
    deathResetPending = false
    saveState('simdeath')
    setTimeout(() => {
      if (!shuttingDown) void startGeneration('simdeath')
    }, 800)
    controlReply(socket, request, true, { simulated: true, remaining: Object.keys(lost).length })
    return
  }
  if (cmd === 'worldreset') {
    state.worldEpoch += 1
    state.generationId = null
    keyedMemory()
    saveState('worldreset')
    log('WORLD_EPOCH', { worldEpoch: state.worldEpoch, worldKey: currentWorldKey() })
    controlReply(socket, request, true, { worldEpoch: state.worldEpoch, worldKey: currentWorldKey() })
    return
  }
  if (cmd === 'acceptance') {
    const path = writeAcceptance()
    controlReply(socket, request, true, { path })
    return
  }
  if (cmd === 'leakcheck') {
    controlReply(socket, request, true, { listeners: listenerCounts(), listenerBaseline, listenerLeak: listenerLeak(), heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1048576) })
    return
  }
  if (cmd === 'gc') {
    const maybeGc = (globalThis as { gc?: () => void }).gc
    if (typeof maybeGc === 'function') maybeGc()
    controlReply(socket, request, true, { gc: typeof maybeGc === 'function' })
    return
  }
  if (cmd === 'milestone' || cmd === 'goal') {
    controlReply(socket, request, true, {
      milestone: state.milestone,
      milestoneIndex: state.milestoneIndex,
      goalItem: GOAL_ITEM,
      goalCount: GOAL_COUNT,
      ledgerMirror: state.ledger,
    })
    return
  }
  if (cmd === 'quit') {
    controlReply(socket, request, true, { quitting: true })
    log('QUIT', { reason: 'control' })
    shutdown('control-quit')
    return
  }
  controlReply(socket, request, false, { error: `unknown command: ${cmd}` })
}

function startControlServer(): void {
  if (existsSync(SOCK)) {
    try {
      rmSync(SOCK)
    } catch {
      // ignore
    }
  }
  const server = createServer((socket: Socket) => {
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('data', (chunk: string) => {
      buffer += chunk
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line.length > 0) {
          try {
            const request = JSON.parse(line) as ControlRequest
            void handleControl(request, socket)
          } catch (error) {
            socket.write(`${JSON.stringify({ id: null, ok: false, data: { error: error instanceof Error ? error.message : String(error) } })}\n`)
          }
        }
        index = buffer.indexOf('\n')
      }
    })
    socket.on('error', () => undefined)
  })
  server.on('error', (error: Error) => log('ERROR', { where: 'control.server', message: error.message }))
  server.listen(SOCK, () => {
    try {
      chmodSync(SOCK, 0o600)
    } catch {
      // ignore
    }
    log('CONTROL', { socket: SOCK })
  })
}

// ---------------------------------------------------------------------------
// shutdown
// ---------------------------------------------------------------------------
function shutdown(reason: string): void {
  if (shuttingDown) return
  shuttingDown = true
  log('SHUTDOWN', { reason })
  let acceptance: string | null = null
  try {
    acceptance = writeAcceptance()
  } catch {
    // ignore
  }
  log('ACCEPTANCE', { path: acceptance, runId })
  saveState('shutdown')
  try {
    generation?.dispose()
  } catch {
    // ignore
  }
  generation = null
  try {
    bot?.quit(reason)
  } catch {
    // ignore
  }
  setTimeout(() => process.exit(0), 800)
}

process.on('uncaughtException', (error: Error) => {
  log('ERROR', { where: 'uncaughtException', message: error.message })
})
process.on('unhandledRejection', (reason: unknown) => {
  log('ERROR', { where: 'unhandledRejection', message: reason instanceof Error ? reason.message : String(reason) })
})
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
state.firstSeenAt = state.firstSeenAt || Date.now()
saveState('boot')
log('BOOT', {
  pid: process.pid,
  runId,
  runtime: process.release.name,
  node: process.version,
  bundle: currentBundle ?? 'none',
  milestone: state.milestone,
  generations: state.generations,
  reloads: state.reloads,
  contractVersion: CONTRACT_VERSION,
  schemaVersion: state.schemaVersion,
  revision: state.revision,
  worldEpoch: state.worldEpoch,
  worldKey: currentWorldKey(),
})
startControlServer()
void loadGenerationModule(false).then(() => {
  connect()
})
