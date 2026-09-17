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
import { createServer } from 'node:net'
import type { Socket } from 'node:net'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import mineflayer from 'mineflayer'
import type { Bot } from 'mineflayer'
import pathfinderModule from 'mineflayer-pathfinder'
import { plugin as collectBlockPlugin } from 'mineflayer-collectblock'
import { buildGeneration } from './build.mts'
import type { GenerationModule, GenerationStatus, ResidentGeneration, ResidentState, Vec3Json } from './resident-types.ts'

const CONTRACT_VERSION = 1

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
function defaultState(): ResidentState {
  return {
    version: 1,
    bot: USERNAME,
    firstSeenAt: Date.now(),
    updatedAt: Date.now(),
    milestoneIndex: -1,
    milestone: null,
    ledger: null,
    worldMemory: { craftingTables: [], furnaces: [], mined: {}, discoveredOres: [] },
    generations: 0,
    reloads: 0,
    recoveries: 0,
    lastGenerationId: null,
    actions: 0,
  }
}

function loadState(): ResidentState {
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, 'utf8')) as Partial<ResidentState>
    const base = defaultState()
    return {
      ...base,
      ...parsed,
      worldMemory: { ...base.worldMemory, ...(parsed.worldMemory ?? {}) },
    }
  } catch {
    return defaultState()
  }
}

let state = loadState()

function saveState(): void {
  state.updatedAt = Date.now()
  try {
    const tmp = `${STATE_PATH}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`)
    renameSync(tmp, STATE_PATH)
  } catch (error) {
    log('ERROR', { where: 'saveState', message: error instanceof Error ? error.message : String(error) })
  }
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

function smokeTest(gen: ResidentGeneration): void {
  const status = gen.status()
  if (typeof status.policyKind !== 'string' || status.policyKind.length === 0) {
    throw new Error('smoke test failed: no policy kind')
  }
  if (typeof status.queue.done !== 'number') {
    throw new Error('smoke test failed: no goal queue projection')
  }
  if (status.plannedGoals < 1) {
    throw new Error('smoke test failed: planner produced an empty plan')
  }
}

function makeGenerationContext(b: Bot) {
  return {
    bot: b,
    log,
    state,
    ledgerPath: LEDGER,
    logDir: JEV_LOGS,
    goalItem: GOAL_ITEM,
    goalCount: GOAL_COUNT,
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
    if (shuttingDown || frozen) return
    log('RECOVERY', { reason: 'generation-stopped', stopped })
    state.recoveries += 1
    if (stopped === 'goal-complete') archiveLedger('goal-complete')
    saveState()
    scheduleGenerationRestart('generation-stopped')
  }, 2000)
}

async function startGeneration(trigger: string): Promise<boolean> {
  if (bot === null || bot.entity === undefined) {
    log('ERROR', { where: 'startGeneration', message: 'no spawned bot', trigger })
    return false
  }
  const mod = await loadGenerationModule(false)
  if (mod === null) {
    scheduleGenerationRestart('module-unavailable')
    return false
  }
  const gen = mod.createGeneration(makeGenerationContext(bot))
  gen.attach()
  gen.start()
  generation = gen
  lastActionId = null
  state.generations += 1
  state.lastGenerationId = gen.id
  saveState()
  log('GENERATION_START', { id: gen.id, trigger, rung: gen.rungId, rungIndex: gen.rungIndex, generations: state.generations })
  watchGenerationStop(gen)
  return true
}

function scheduleGenerationRestart(reason: string): void {
  if (generationRestartTimer !== null || shuttingDown || frozen) return
  generationRestartTimer = setTimeout(() => {
    generationRestartTimer = null
    if (shuttingDown || frozen) return
    if (generation !== null) return
    void startGeneration(`recovery:${reason}`)
  }, GEN_RESTART_MS)
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

  created.once('spawn', () => {
    reconnecting = false
    const entity = created.entity
    log('SPAWN', {
      pos: entity === undefined ? '?' : fmtPos({ x: entity.position.x, y: entity.position.y, z: entity.position.z }),
      version: created.version,
      health: created.health,
      username: created.username,
    })
    lastHeartbeatAt = Date.now()
    void startGeneration('spawn')
  })

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
  log('RECONNECT', { inMs: RECONNECT_MS })
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

  const action = status.currentAction
  if (action !== null && action.id !== lastActionId) {
    lastActionId = action.id
    state.actions += 1
    log('ACTION', {
      n: state.actions,
      id: action.id,
      kind: action.kind,
      phase: action.phase,
      pos: fmtPos(status.position),
      rung: status.rungId,
    })
  } else if (action === null) {
    lastActionId = null
  }

  const stableInv = Object.keys(status.inventory)
    .sort()
    .map((name) => `${name}:${status.inventory[name] ?? 0}`)
    .join(',')
  const invHash = createHash('sha1').update(stableInv).digest('hex').slice(0, 12)
  if (invHash !== lastInventoryHash) {
    lastInventoryHash = invHash
    log('INVENTORY', { items: shortInv(status.inventory), pos: fmtPos(status.position) })
  }

  if (status.rungIndex > state.milestoneIndex) {
    state.milestoneIndex = status.rungIndex
    state.milestone = status.rungId
    log('MILESTONE', { rung: status.rungId, index: status.rungIndex, inventory: shortInv(status.inventory) })
    saveState()
  }

  if (Date.now() - lastHeartbeatAt >= HEARTBEAT_MS) {
    lastHeartbeatAt = Date.now()
    log('HEARTBEAT', {
      pos: fmtPos(status.position),
      health: status.health,
      running: status.running,
      rung: status.rungId,
      queue: status.queue.current?.description ?? 'none',
      depth: status.queue.depth,
      done: status.queue.done,
      action: status.currentAction?.kind ?? 'idle',
      inv: shortInv(status.inventory),
    })
    state.ledger = status.queue
    saveState()
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

async function performReload(trigger: string): Promise<void> {
  const started = Date.now()
  if (bot === null || bot.entity === undefined) {
    log('RELOAD', { ok: false, trigger, reason: 'no live bot' })
    return
  }
  try {
    const built = await buildGeneration()
    if (built.outfile === currentBundle && generationModule !== null) {
      log('RELOAD', { ok: true, trigger, skipped: 'unchanged', ms: Date.now() - started })
      return
    }
    const mod = (await import(`${pathToFileURL(built.outfile).href}?v=${built.hash}`)) as GenerationModule
    if (mod.CONTRACT_VERSION !== CONTRACT_VERSION) {
      throw new Error(`CONTRACT_VERSION mismatch: generation=${mod.CONTRACT_VERSION} host=${CONTRACT_VERSION}`)
    }
    const next = mod.createGeneration(makeGenerationContext(bot))
    smokeTest(next)
    const previous = generation
    if (previous !== null) {
      await previous.quiesce()
      previous.dispose()
      generation = null
    }
    generationModule = mod
    currentBundle = built.outfile
    next.attach()
    next.start()
    generation = next
    lastActionId = null
    state.reloads += 1
    state.generations += 1
    state.lastGenerationId = next.id
    saveState()
    log('RELOAD', { ok: true, trigger, ms: Date.now() - started, hash: built.hash, id: next.id, generations: state.generations })
    watchGenerationStop(next)
  } catch (error) {
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
    state,
    status,
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
    controlReply(socket, request, true, {
      frozen,
      connected: bot !== null && bot.entity !== undefined,
      generations: state.generations,
      reloads: state.reloads,
      recoveries: state.recoveries,
      milestone: state.milestone,
      worldMemory: {
        craftingTables: state.worldMemory.craftingTables.length,
        furnaces: state.worldMemory.furnaces.length,
        discoveredOres: state.worldMemory.discoveredOres,
      },
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
    let path: string | null = null
    if (generation !== null) {
      const status = generation.status()
      path = freezeReport('control', status)
      await generation.quiesce()
    }
    log('FREEZE', { reason: 'control', report: path })
    controlReply(socket, request, true, { frozen: true, report: path })
    return
  }
  if (cmd === 'resume') {
    frozen = false
    const ok = await startGeneration('control:resume')
    log('RESUME', { ok })
    controlReply(socket, request, true, { frozen: false, started: ok })
    return
  }
  if (cmd === 'leakcheck') {
    const counts: Record<string, number> = {}
    if (bot !== null) {
      for (const event of ['physicsTick', 'goal_reached', 'goal_updated', 'path_update', 'blockUpdate', 'entitySpawn', 'health', 'playerCollect', 'death', 'end', 'kicked']) {
        counts[event] = bot.listenerCount(event)
      }
    }
    controlReply(socket, request, true, { listeners: counts, heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1048576) })
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
  saveState()
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
saveState()
log('BOOT', {
  pid: process.pid,
  runtime: process.release.name,
  node: process.version,
  bundle: currentBundle ?? 'none',
  milestone: state.milestone,
  generations: state.generations,
  reloads: state.reloads,
})
startControlServer()
void loadGenerationModule(false).then(() => {
  connect()
})
