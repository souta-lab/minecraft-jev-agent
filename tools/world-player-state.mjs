#!/usr/bin/env node
// world-player-state.mjs - read-only live world/player observation.
//
// This is deliberately a sensor, not a planner.  It joins Mineflayer's live
// world view with an optional resident report and (only when explicitly asked)
// read-only operator queries for a target player's NBT.  It never sends a
// gameplay action and never uses screenshots as state.
//
// The output is suitable for a closed loop:
//   observation -> explicit known/unknown facts -> Jev/Mercury decision
// The tool does not choose the next semantic action.

import { createRequire } from 'node:module'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { socketReport } from './agent-report.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const require = createRequire(import.meta.url)

function dependency(name) {
  return require(path.join(ROOT, 'buddy-driver', 'node_modules', name))
}

const mineflayerModule = dependency('mineflayer')
const mineflayer = mineflayerModule.default ?? mineflayerModule
const vec3Module = dependency('vec3')
const Vec3 = vec3Module.Vec3 ?? vec3Module

export const STATE_SCHEMA_VERSION = 1
export const DEFAULT_HOST = process.env.MC_AI_HOST ?? '127.0.0.1'
export const DEFAULT_PORT = Number(process.env.MC_AI_PORT ?? 25565)
export const DEFAULT_TARGET = process.env.MC_AI_TARGET ?? 'AI_Buddy'
export const DEFAULT_CONTROL_SOCKET = process.env.BUDDY_CONTROL_SOCKET ?? null

const HOSTILE_NAMES = new Set([
  'blaze', 'cave_spider', 'creeper', 'drowned', 'elder_guardian', 'ender_dragon',
  'endermite', 'evoker', 'ghast', 'guardian', 'hoglin', 'husk', 'magma_cube',
  'phantom', 'piglin_brute', 'pillager', 'ravager', 'shulker', 'silverfish',
  'skeleton', 'slime', 'spider', 'stray', 'vex', 'vindicator', 'warden',
  'witch', 'wither', 'wither_skeleton', 'zoglin', 'zombie', 'zombie_villager',
])

const HAZARD_NAMES = new Set([
  'cactus', 'campfire', 'fire', 'lava', 'magma_block', 'powder_snow',
  'pointed_dripstone', 'soul_campfire', 'soul_fire', 'sweet_berry_bush',
])

const EMPTY_NAMES = new Set(['air', 'cave_air', 'void_air'])

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function numberOrNull(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function clampInteger(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.floor(n)))
}

export function parseArgs(argv = []) {
  const options = {
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    observer: `AI_STATE_${process.pid}`,
    target: DEFAULT_TARGET,
    radius: 8,
    verticalRadius: 4,
    timeoutMs: 12000,
    settleMs: 900,
    intervalMs: 3000,
    samples: 1,
    json: false,
    adminUser: null,
    controlSocket: DEFAULT_CONTROL_SOCKET,
    help: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => argv[++i]
    if (arg === '--host') options.host = next() ?? options.host
    else if (arg.startsWith('--host=')) options.host = arg.slice(7)
    else if (arg === '--port') options.port = Number(next() ?? options.port)
    else if (arg.startsWith('--port=')) options.port = Number(arg.slice(7))
    else if (arg === '--observer') options.observer = next() ?? options.observer
    else if (arg.startsWith('--observer=')) options.observer = arg.slice(11)
    else if (arg === '--target' || arg === '--player') options.target = next() ?? options.target
    else if (arg.startsWith('--target=') || arg.startsWith('--player=')) options.target = arg.slice(arg.indexOf('=') + 1)
    else if (arg === '--radius') options.radius = clampInteger(next(), 1, 16, options.radius)
    else if (arg.startsWith('--radius=')) options.radius = clampInteger(arg.slice(9), 1, 16, options.radius)
    else if (arg === '--vertical-radius') options.verticalRadius = clampInteger(next(), 1, 8, options.verticalRadius)
    else if (arg.startsWith('--vertical-radius=')) options.verticalRadius = clampInteger(arg.slice(18), 1, 8, options.verticalRadius)
    else if (arg === '--timeout-ms') options.timeoutMs = clampInteger(next(), 1000, 60000, options.timeoutMs)
    else if (arg.startsWith('--timeout-ms=')) options.timeoutMs = clampInteger(arg.slice(13), 1000, 60000, options.timeoutMs)
    else if (arg === '--settle-ms') options.settleMs = clampInteger(next(), 0, 10000, options.settleMs)
    else if (arg.startsWith('--settle-ms=')) options.settleMs = clampInteger(arg.slice(12), 0, 10000, options.settleMs)
    else if (arg === '--interval-ms') options.intervalMs = clampInteger(next(), 250, 60000, options.intervalMs)
    else if (arg.startsWith('--interval-ms=')) options.intervalMs = clampInteger(arg.slice(13), 250, 60000, options.intervalMs)
    else if (arg === '--samples') options.samples = clampInteger(next(), 1, 10000, options.samples)
    else if (arg.startsWith('--samples=')) options.samples = clampInteger(arg.slice(10), 1, 10000, options.samples)
    else if (arg === '--watch') {
      const seconds = Number(argv[i + 1])
      if (argv[i + 1] && !String(argv[i + 1]).startsWith('--') && Number.isFinite(seconds)) {
        options.intervalMs = Math.max(250, Math.floor(seconds * 1000))
        i += 1
      }
      options.samples = Number.POSITIVE_INFINITY
    } else if (arg.startsWith('--watch=')) {
      options.intervalMs = Math.max(250, Math.floor(Number(arg.slice(8)) * 1000) || options.intervalMs)
      options.samples = Number.POSITIVE_INFINITY
    } else if (arg === '--admin-user') options.adminUser = next() ?? null
    else if (arg.startsWith('--admin-user=')) options.adminUser = arg.slice(13)
    else if (arg === '--control-socket') options.controlSocket = next() ?? options.controlSocket
    else if (arg.startsWith('--control-socket=')) options.controlSocket = arg.slice(17)
    else if (arg === '--json') options.json = true
    else if (arg === '--help' || arg === '-h') options.help = true
  }
  if (!Number.isFinite(options.port) || options.port < 1 || options.port > 65535) throw new Error('invalid --port')
  return options
}

export function normalizeItemName(name) {
  if (typeof name !== 'string') return null
  const trimmed = name.trim().replace(/^minecraft:/, '')
  return trimmed.length > 0 ? trimmed : null
}

export function normalizeInventory(items) {
  const counts = {}
  if (Array.isArray(items)) {
    for (const item of items) {
      if (item === null || typeof item !== 'object') continue
      const rawName = item.name ?? item.id
      const name = normalizeItemName(rawName)
      const count = numberOrNull(item.count)
      if (name !== null && count !== null && count > 0) counts[name] = (counts[name] ?? 0) + count
    }
  } else if (items !== null && typeof items === 'object') {
    for (const [rawName, rawCount] of Object.entries(items)) {
      const name = normalizeItemName(rawName)
      const count = numberOrNull(rawCount)
      if (name !== null && count !== null && count > 0) counts[name] = count
    }
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))
}

function positionOf(value) {
  if (value === null || typeof value !== 'object') return null
  const x = numberOrNull(value.x)
  const y = numberOrNull(value.y)
  const z = numberOrNull(value.z)
  return x === null || y === null || z === null ? null : { x, y, z }
}

function distance(a, b) {
  if (a === null || b === null) return null
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

function entityName(entity) {
  return normalizeItemName(entity?.name ?? entity?.mobType ?? entity?.displayName) ?? null
}

export function classifyEntity(entity) {
  const name = entityName(entity)
  // The resident snapshot deliberately serializes `username: null` for mobs
  // and dropped items.  Presence of the property is therefore not enough to
  // identify a player; only a real username or the explicit player type is.
  if (entity?.type === 'player' || typeof entity?.username === 'string') return 'player'
  if ((name !== null && HOSTILE_NAMES.has(name)) || /hostile/i.test(String(entity?.kind ?? ''))) return 'hostile'
  if (/passive|animal/i.test(String(entity?.kind ?? ''))) return 'passive'
  if (entity?.type === 'mob') return 'mob'
  return 'unknown'
}

export function summarizeEntities(entities, center, radius) {
  const all = []
  for (const entity of Array.isArray(entities) ? entities : []) {
    const position = positionOf(entity?.position)
    if (position === null) continue
    const d = distance(position, center)
    if (d === null || d > radius) continue
    const name = entityName(entity)
    const kind = classifyEntity(entity)
    all.push({
      id: entity?.id ?? null,
      username: typeof entity?.username === 'string' ? entity.username : null,
      name,
      type: entity?.type ?? null,
      kind,
      distance: Number(d.toFixed(3)),
      position,
      health: numberOrNull(entity?.health),
    })
  }
  all.sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity))
  return {
    entities: all,
    hostiles: all.filter((entity) => entity.kind === 'hostile'),
    players: all.filter((entity) => entity.kind === 'player'),
  }
}

export function summarizeBlocks(observations) {
  const counts = {}
  const hazards = []
  const portals = []
  let unknown = 0
  for (const observation of Array.isArray(observations) ? observations : []) {
    const name = normalizeItemName(observation?.name)
    const position = positionOf(observation?.position)
    if (name === null) {
      unknown += 1
      continue
    }
    counts[name] = (counts[name] ?? 0) + 1
    if (position !== null && HAZARD_NAMES.has(name)) hazards.push({ name, position })
    if (position !== null && name === 'nether_portal') portals.push(position)
  }
  return {
    counts: Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))),
    unknown,
    hazards,
    portals,
    portalInteriorCount: portals.length,
    obsidianCount: counts.obsidian ?? 0,
  }
}

export function parseAdminMessages(messages) {
  const text = (Array.isArray(messages) ? messages : []).join('\n')
  const posMatch = /entity data:\s*\[\s*([-+\d.]+)d,\s*([-+\d.]+)d,\s*([-+\d.]+)d\s*\]/.exec(text)
  const healthMatch = /entity data:\s*([-+\d.]+)f/.exec(text)
  const difficultyMatch = /difficulty is\s+([A-Za-z]+)/i.exec(text)
  const inventory = []
  for (const match of text.matchAll(/id:\s*"minecraft:([^"]+)"\s*,\s*count:\s*(\d+)/g)) {
    inventory.push({ name: match[1], count: Number(match[2]) })
  }
  return {
    position: posMatch ? { x: Number(posMatch[1]), y: Number(posMatch[2]), z: Number(posMatch[3]) } : null,
    health: healthMatch ? Number(healthMatch[1]) : null,
    inventory: inventory.length > 0 ? normalizeInventory(inventory) : null,
    difficulty: difficultyMatch ? difficultyMatch[1].toLowerCase() : null,
    rawMessageCount: Array.isArray(messages) ? messages.length : 0,
  }
}

export function normalizeDimension(dimension) {
  if (typeof dimension !== 'string' || dimension.length === 0) return null
  if (dimension === 'overworld') return 'minecraft:overworld'
  if (dimension === 'the_nether' || dimension === 'nether') return 'minecraft:the_nether'
  if (dimension === 'the_end' || dimension === 'end') return 'minecraft:the_end'
  return dimension.includes(':') ? dimension : `minecraft:${dimension}`
}

function socketCommand(sockPath, command, args = {}, timeoutMs = 6000) {
  return new Promise((resolve) => {
    if (!sockPath) return resolve({ ok: false, error: 'resident-socket-disabled' })
    let socket
    try {
      socket = net.createConnection(sockPath)
    } catch (error) {
      return resolve({ ok: false, error: String(error?.message ?? error) })
    }
    let buffer = ''
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      try { socket.destroy() } catch {}
      resolve(value)
    }
    socket.setTimeout(timeoutMs, () => finish({ ok: false, error: 'timeout' }))
    socket.on('error', (error) => finish({ ok: false, error: String(error?.message ?? error) }))
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      try {
        const result = JSON.parse(buffer.slice(0, newline))
        finish({ ok: result.ok !== false, data: result.data ?? result, error: result.ok === false ? result.error ?? 'not-ok' : null })
      } catch (error) {
        finish({ ok: false, error: `bad-json:${String(error?.message ?? error)}` })
      }
    })
    socket.on('connect', () => socket.write(JSON.stringify({ id: Date.now() % 100000, cmd: command, args }) + '\n'))
  })
}

function residentStateProjection(result) {
  return {
    available: result?.ok === true && result.data !== null,
    error: result?.ok === true ? null : result?.error ?? 'resident-state-unavailable',
    data: result?.ok === true ? result.data : null,
  }
}

export function evaluateClosedLoop({ connected, targetPosition, inventory, dimension, difficulty, blockSummary, entitySummary, resident }) {
  const unknown = []
  if (!connected) unknown.push('observer_disconnected')
  if (targetPosition === null) unknown.push('target_position_unknown')
  if (inventory === null) unknown.push('target_inventory_unknown')
  if (normalizeDimension(dimension) === null) unknown.push('dimension_unknown')
  if (difficulty === null) unknown.push('difficulty_unknown')
  if ((blockSummary?.unknown ?? 0) > 0) unknown.push('unloaded_or_unknown_blocks')
  const hostiles = entitySummary?.hostiles?.length ?? 0
  const hazards = blockSummary?.hazards?.length ?? 0
  const supportName = normalizeItemName(blockSummary?.support?.name)
  const ground = supportName === null
    ? 'UNKNOWN'
    : EMPTY_NAMES.has(supportName)
      ? 'UNSUPPORTED'
      : HAZARD_NAMES.has(supportName)
        ? 'HAZARDOUS'
        : 'OBSERVED_SAFE'
  return {
    status: unknown.length === 0 ? 'KNOWN' : 'PARTIAL',
    unknown,
    targetVisible: targetPosition !== null,
    inventoryKnown: inventory !== null,
    worldKnown: normalizeDimension(dimension) !== null && difficulty !== null,
    hostileCount: hostiles,
    hostilePresent: hostiles > 0,
    hazardCount: hazards,
    hazardsPresent: hazards > 0,
    safeGround: targetPosition === null ? 'UNKNOWN' : ground,
    combatAssessment: hostiles > 0
      ? inventory === null ? 'HOSTILE_PRESENT_PLAYER_STATE_INCOMPLETE' : 'HOSTILE_PRESENT_CAPABILITY_UNPROVEN'
      : 'NO_HOSTILE_OBSERVED',
    residentRunId: resident?.runId ?? null,
  }
}

function entityHealth(entity) {
  const direct = numberOrNull(entity?.health)
  if (direct !== null) return direct
  const metadata = Array.isArray(entity?.metadata) ? entity.metadata : []
  for (const index of [10, 11, 12]) {
    const value = numberOrNull(metadata[index])
    if (value !== null && value >= 0 && value <= 2048) return value
  }
  return null
}

function sameInventory(left, right) {
  if (left === null || right === null) return null
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every((key) => left[key] === right[key]) && rightKeys.every((key) => right[key] === left[key])
}

export function comparePlayerSources({ residentTruth = null, admin = null, entityPosition = null } = {}) {
  const residentPosition = positionOf(residentTruth?.position)
  const adminPosition = positionOf(admin?.position)
  const positionDistance = distance(residentPosition, adminPosition)
  const entityDistance = distance(residentPosition, entityPosition)
  const residentInventory = residentTruth?.inventory === undefined ? null : normalizeInventory(residentTruth.inventory)
  const adminInventory = admin?.inventory ?? null
  const inventoryEqual = sameInventory(residentInventory, adminInventory)
  const mismatches = []
  // The operator query is slower than the resident snapshot while the bot is
  // moving. Preserve both values and expose the drift instead of silently
  // rewriting resident truth with a later query.
  if (positionDistance !== null && positionDistance > 1.5) mismatches.push('resident_admin_position')
  if (entityDistance !== null && entityDistance > 1.5) mismatches.push('resident_entity_position')
  if (inventoryEqual === false) mismatches.push('resident_admin_inventory')
  return {
    status: mismatches.length === 0 ? 'AGREE_OR_WITHIN_SAMPLE_DRIFT' : 'MISMATCH',
    mismatches,
    residentPosition,
    adminPosition,
    entityPosition,
    positionDistance: positionDistance === null ? null : Number(positionDistance.toFixed(3)),
    entityDistance: entityDistance === null ? null : Number(entityDistance.toFixed(3)),
    inventoryEqual,
  }
}

function liveEntities(bot) {
  return Object.values(bot?.entities ?? {})
}

function liveBlockObservations(bot, center, radius, verticalRadius) {
  if (center === null) return []
  const base = new Vec3(Math.floor(center.x), Math.floor(center.y), Math.floor(center.z))
  const observations = []
  for (let dx = -radius; dx <= radius; dx += 1) {
    for (let dy = -verticalRadius; dy <= verticalRadius; dy += 1) {
      for (let dz = -radius; dz <= radius; dz += 1) {
        const position = { x: base.x + dx, y: base.y + dy, z: base.z + dz }
        let block = null
        try {
          block = bot.blockAt(new Vec3(position.x, position.y, position.z))
        } catch {
          block = null
        }
        observations.push({ position, name: block?.name ?? null })
      }
    }
  }
  return observations
}

function liveGround(bot, center) {
  if (center === null) return { support: null, feet: null, head: null }
  const base = { x: Math.floor(center.x), y: Math.floor(center.y), z: Math.floor(center.z) }
  const read = (y) => {
    try {
      const block = bot.blockAt(new Vec3(base.x, y, base.z))
      return { name: block?.name ?? null, position: { x: base.x, y, z: base.z } }
    } catch {
      return { name: null, position: { x: base.x, y, z: base.z } }
    }
  }
  return { support: read(base.y - 1), feet: read(base.y), head: read(base.y + 1) }
}

async function connectBot(options) {
  return new Promise((resolve, reject) => {
    let settled = false
    const bot = mineflayer.createBot({ host: options.host, port: options.port, username: options.username })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { bot.quit() } catch {}
      reject(new Error(`connection timeout for ${options.username}`))
    }, options.timeoutMs)
    const finish = (error = null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error !== null) reject(error)
      else resolve(bot)
    }
    bot.once('spawn', () => finish())
    bot.once('error', (error) => finish(error instanceof Error ? error : new Error(String(error))))
  })
}

async function readAdminState(options) {
  if (!options.adminUser) return null
  const bot = await connectBot({ ...options, username: options.adminUser })
  const messages = []
  const onMessage = (message) => messages.push(String(message?.toString?.() ?? message))
  bot.on('message', onMessage)
  try {
    await sleep(options.settleMs)
    const commands = [
      `/data get entity ${options.target} Pos`,
      `/data get entity ${options.target} Inventory`,
      `/data get entity ${options.target} Health`,
      '/difficulty',
    ]
    for (const command of commands) {
      bot.chat(command)
      await sleep(120)
    }
    await sleep(Math.max(300, options.settleMs))
    return parseAdminMessages(messages)
  } finally {
    bot.removeListener('message', onMessage)
    try { bot.quit() } catch {}
  }
}

function residentProjection(result) {
  const data = result?.ok ? result.data : null
  const status = data?.status ?? null
  const truth = status?.truth ?? null
  return {
    available: data !== null,
    error: result?.ok ? null : result?.error ?? 'resident-report-unavailable',
    runId: data?.runId ?? null,
    frozen: data?.frozen ?? null,
    connected: data?.connected ?? null,
    generationHash: data?.generationHash ?? null,
    generationId: data?.generationId ?? null,
    worldKey: data?.worldKey ?? null,
    listenerLeak: data?.listenerLeak ?? null,
    wedge: data?.stats?.wedge ?? null,
    milestone: data?.milestone ?? null,
    status: status === null ? null : {
      running: status.running ?? null,
      policyKind: status.policyKind ?? null,
      policyModel: status.policyModel ?? null,
      system2Model: status.system2Model ?? null,
      rungId: status.rungId ?? null,
      queue: status.queue ?? null,
      currentAction: status.currentAction ?? null,
      truth: truth === null ? null : {
        position: positionOf(truth.position),
        health: numberOrNull(truth.health),
        food: numberOrNull(truth.food),
        dimension: truth.dimension ?? null,
        onGround: truth.onGround ?? null,
        inventory: normalizeInventory(truth.inventory),
      },
    },
  }
}

export function makeSnapshot({ bot, options, residentResult = null, residentStateResult = null, admin = null }) {
  const resident = residentProjection(residentResult)
  const residentState = residentStateProjection(residentStateResult)
  resident.liveStateAvailable = residentState.available
  const targetPlayer = bot.players?.[options.target]
  const targetEntity = targetPlayer?.entity ?? liveEntities(bot).find((entity) => entity?.username === options.target) ?? null
  const targetEntityPosition = positionOf(targetEntity?.position)
  const residentTruth = residentState.data?.truth ?? resident.status?.truth ?? null
  const sourceConsistency = comparePlayerSources({ residentTruth, admin, entityPosition: targetEntityPosition })
  // Resident truth is the timestamped execution snapshot. An operator query is
  // a read-only cross-check, not a replacement that can make area observations
  // appear to come from a different position.
  const targetPosition = residentTruth?.position ?? admin?.position ?? targetEntityPosition
  const targetHealth = residentTruth?.health ?? admin?.health ?? entityHealth(targetEntity)
  const targetInventory = residentTruth === null ? admin?.inventory ?? null : normalizeInventory(residentTruth.inventory)
  const dimension = residentTruth?.dimension ?? bot.game?.dimension ?? null
  const difficulty = admin?.difficulty ?? null
  const stateArea = residentState.data?.area ?? null
  const blockSummary = stateArea?.blocks?.counts !== undefined
    ? stateArea.blocks
    : summarizeBlocks(liveBlockObservations(bot, targetPosition, options.radius, options.verticalRadius))
  if (blockSummary.support === undefined) blockSummary.support = liveGround(bot, targetPosition).support
  const ground = stateArea?.blocks?.support !== undefined
    ? { support: stateArea.blocks.support, feet: null, head: null }
    : liveGround(bot, targetPosition)
  const entitySummary = Array.isArray(stateArea?.entities)
    ? summarizeEntities(stateArea.entities, targetPosition, options.radius)
    : summarizeEntities(liveEntities(bot), targetPosition, options.radius)
  const connected = bot.entity !== undefined
  const closedLoop = evaluateClosedLoop({
    connected,
    targetPosition,
    inventory: targetInventory,
    dimension,
    difficulty,
    blockSummary,
    entitySummary,
    resident,
  })
  closedLoop.sourceConsistency = sourceConsistency
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    observedAt: new Date().toISOString(),
    observer: { username: options.observer, host: options.host, port: options.port },
    resident,
    world: {
      dimension: normalizeDimension(dimension),
      rawDimension: dimension,
      difficulty,
      version: bot.version ?? null,
      serverBrand: bot.game?.serverBrand ?? null,
      levelType: bot.game?.levelType ?? null,
      timeOfDay: numberOrNull(bot.time?.timeOfDay),
      day: numberOrNull(bot.time?.day),
      raining: typeof bot.isRaining === 'boolean' ? bot.isRaining : null,
      thunderState: numberOrNull(bot.thunderState),
      worldKey: resident.worldKey,
    },
    player: {
      target: options.target,
      visible: targetPosition !== null,
      position: targetPosition,
      health: targetHealth,
      food: residentTruth?.food ?? null,
      onGround: residentTruth?.onGround ?? null,
      inventory: targetInventory,
      sources: {
        resident: residentTruth,
        admin,
        entity: targetEntityPosition === null ? null : { position: targetEntityPosition, health: entityHealth(targetEntity) },
        consistency: sourceConsistency,
      },
      stateSource: residentTruth !== null
        ? admin !== null ? 'resident-live-state+operator-read-only-nbt' : 'resident-live-state'
        : admin !== null ? 'operator-read-only-nbt' : targetEntityPosition !== null ? 'entity-observation' : 'unknown',
    },
    area: {
      radius: options.radius,
      verticalRadius: options.verticalRadius,
      blocks: blockSummary,
      entities: entitySummary,
    },
    closedLoop,
    ground,
    residentState: {
      available: residentState.available,
      error: residentState.error,
      capturedAt: residentState.data?.capturedAt ?? null,
    },
  }
}

export async function observeOnce(options, bot) {
  const residentResult = options.controlSocket === null ? null : await socketReport(options.controlSocket, options.timeoutMs)
  const residentStateResult = options.controlSocket === null
    ? null
    : await socketCommand(options.controlSocket, 'state', { radius: options.radius, verticalRadius: options.verticalRadius }, options.timeoutMs)
  const admin = await readAdminState(options)
  return makeSnapshot({ bot, options, residentResult, residentStateResult, admin })
}

const HELP = `world-player-state.mjs - read-only live state observer

Usage:
  node tools/world-player-state.mjs --target AI_Buddy --admin-user s0u7a --json

Options:
  --target/--player NAME       player to observe (default AI_Buddy)
  --observer NAME              temporary Mineflayer observer name
  --admin-user NAME            optional operator account for read-only /data queries
  --control-socket PATH        resident control socket for run/source/truth context
  --radius N                   horizontal block/entity radius (1..16)
  --vertical-radius N          vertical scan radius (1..8)
  --samples N                  bounded number of observations
  --watch [seconds]            stream observations until interrupted
  --json                      emit one JSON object per sample

The tool has no gameplay mutation path. It does not choose a plan or infer a
combat win; it reports explicit facts and UNKNOWN fields for missing truth.`

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(`${HELP}\n`)
    return 0
  }
  const bot = await connectBot({ ...options, username: options.observer })
  let stopped = false
  process.on('SIGINT', () => { stopped = true })
  try {
    let index = 0
    while (!stopped && index < options.samples) {
      const snapshot = await observeOnce(options, bot)
      if (options.json) process.stdout.write(`${JSON.stringify(snapshot)}\n`)
      else {
        const hostile = snapshot.closedLoop.hostileCount
        process.stdout.write(
          `STATE ${snapshot.observedAt} runId=${snapshot.resident.runId ?? 'unknown'} ` +
          `dimension=${snapshot.world.dimension ?? 'unknown'} difficulty=${snapshot.world.difficulty ?? 'unknown'} ` +
          `player=${snapshot.player.position ? `${snapshot.player.position.x.toFixed(1)},${snapshot.player.position.y.toFixed(1)},${snapshot.player.position.z.toFixed(1)}` : 'unknown'} ` +
          `inventory=${snapshot.closedLoop.inventoryKnown ? 'known' : 'UNKNOWN'} hostiles=${hostile} ` +
          `closedLoop=${snapshot.closedLoop.status}\n`,
        )
      }
      index += 1
      if (index < options.samples && !stopped) await sleep(options.intervalMs)
    }
    return 0
  } finally {
    try { bot.quit() } catch {}
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`world-player-state: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 2
  })
}
