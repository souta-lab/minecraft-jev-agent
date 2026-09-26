#!/usr/bin/env bun
// movement-test/probe.mjs
//
// Minimal, bare-Mineflayer movement probe for the local Leaf 26.1.2 server.
// NO pathfinder. NO plugins. Only mineflayer + its own built-in plugins.
//
// Procedure:
//   1. join and stand still N s (default 10)
//   2. scan 8 compass directions for the longest flat, clear, step-free run and
//      face the best one (deterministic tie-break N,S,W,E,NE,NW,SE,SW)
//   3. bot.setControlState('forward', true)
//   4. walk until ~5 blocks horizontal displacement or 6 s (or stall)
//   5. stop, settle, compare server-side (observer bot's view of us) vs
//      client-side position
//
// Logs raw, timestamped JSONL for both directions (S2C + C2S), classifies every
// server position packet as a correction (>0.5 from the bot's last sent
// position), a self-pin (server re-syncs to where the client already is), or the
// initial placement, and prints:
//   VERDICT: rubberband=yes|no corrections=N maxDelta=X.X
//   DETAIL: forcedRepositions=F selfPins=P maxDisplacement=D expected=E stall=yes|no tickEnd=T
//
// Usage:
//   bun probe.mjs --variant A
//   bun probe.mjs --variant B --direction E --stand-seconds 2
//
// Variant dirs are isolated under variants/<A|B|C>/ ; this file never imports
// the shared mcbot/node_modules stack unless explicitly pointed at it.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = __dirname

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2)
const has = (n) => argv.includes(`--${n}`)
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`)
  return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1] : d
}

if (has('help')) {
  console.log(`Usage: bun probe.mjs [options]

  --variant <A|B|C>     mineflayer variant to load (default A)
  --mineflayer <dir>    explicit path to a mineflayer package dir (overrides --variant)
  --host <addr>         server address         (default 127.0.0.1)
  --port <n>            server port            (default 25565)
  --username <name>     walker username        (default AI_Bot)
  --observer-username <name>  observer username (default AI_Observer)
  --no-observer         do not spawn the second, stand-still observer bot
  --direction <auto|N|S|E|W|NE|NW|SE|SW>  walk direction (default auto = clearance scan)
  --terrain <auto|flat|drop>   auto/flat = longest clear run; drop = aim at a ledge (default auto)
  --stand-seconds <n>   stand still before walking (default 10)
  --walk-seconds <n>    max walk time (default 6)
  --walk-blocks <n>     stop after this horizontal displacement (default 5)
  --settle-seconds <n>  wait after stopping before final compare (default 1.5)
  --log-dir <dir>       JSONL output dir (default ./logs)
  --tag <str>           suffix for the log file name
  --log-entities        also log sync_entity_position/entity_teleport (noisy)
  --help                this text`)
  process.exit(0)
}

const variant = String(opt('variant', 'A')).toUpperCase()
const host = opt('host', '127.0.0.1')
const port = Number(opt('port', 25565))
const username = opt('username', 'AI_Bot')
const observerUsername = opt('observer-username', 'AI_Observer')
const useObserver = !has('no-observer')
const directionArg = String(opt('direction', 'auto')).toUpperCase()
const terrain = String(opt('terrain', 'auto')).toLowerCase() // auto|flat|drop
const standSeconds = Number(opt('stand-seconds', 10))
const walkSeconds = Number(opt('walk-seconds', 6))
const walkBlocks = Number(opt('walk-blocks', 5))
const settleSeconds = Number(opt('settle-seconds', 1.5))
const logDir = opt('log-dir', path.join(ROOT, 'logs'))
const tag = opt('tag', '')
const logEntities = has('log-entities')
const totalTimeoutMs = Number(opt('total-timeout-seconds', 75)) * 1000

const VARIANT_PATHS = {
  A: path.join(ROOT, 'variants/A/node_modules/mineflayer'),
  B: path.join(ROOT, 'variants/B/mineflayer-src'),
  C: path.join(ROOT, 'variants/C/mineflayer-src'),
  E: path.join(ROOT, 'variants/E/mineflayer-src'),
  F: path.join(ROOT, 'variants/F/mineflayer-src'),
  G: path.join(ROOT, 'variants/G/mineflayer-src'),
  H: path.join(ROOT, 'variants/H/mineflayer-src'),
  I: path.join(ROOT, 'variants/I/mineflayer-src'),
  J: path.join(ROOT, 'variants/J/mineflayer-src'),
  K: path.join(ROOT, 'variants/K/mineflayer-src'),
  L: path.join(ROOT, 'variants/L/mineflayer-src'),
  STOCK: path.join(ROOT, '../../node_modules/mineflayer'),
}
const mineflayerDir = path.resolve(opt('mineflayer', VARIANT_PATHS[variant] || VARIANT_PATHS.A))

// ---------------------------------------------------------------------------
// load the isolated mineflayer
// ---------------------------------------------------------------------------
function loadMineflayer (dir) {
  const pkgPath = path.join(dir, 'package.json')
  if (!fs.existsSync(pkgPath)) {
    throw new Error(`mineflayer package not found at ${dir} (missing package.json)`)
  }
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  return { entry: path.join(dir, pkg.main || 'index.js'), pkg }
}

const { entry, pkg } = loadMineflayer(mineflayerDir)
let mineflayerMod
try {
  mineflayerMod = await import(pathToFileURL(entry).href)
} catch (err) {
  console.error(`FATAL: cannot import mineflayer from ${entry}\n${err.stack}`)
  process.exit(2)
}
const mineflayer = mineflayerMod.default || mineflayerMod

function gitSha (dir) {
  try {
    const gitFile = path.join(dir, '.git')
    if (!fs.existsSync(gitFile)) return null
    const head = fs.readFileSync(path.join(gitFile, 'HEAD'), 'utf8').trim()
    if (head.startsWith('ref: ')) {
      const ref = head.slice(5)
      const refPath = path.join(gitFile, ref)
      if (fs.existsSync(refPath)) return fs.readFileSync(refPath, 'utf8').trim()
      const packed = path.join(gitFile, 'packed-refs')
      if (fs.existsSync(packed)) {
        for (const line of fs.readFileSync(packed, 'utf8').split('\n')) {
          if (line.endsWith(' ' + ref)) return line.split(' ')[0]
        }
      }
      return null
    }
    return head
  } catch { return null }
}

const mineflayerInfo = { dir: mineflayerDir, version: pkg.version, gitSha: gitSha(mineflayerDir), resolvedMain: entry }

// ---------------------------------------------------------------------------
// logging
// ---------------------------------------------------------------------------
fs.mkdirSync(logDir, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const baseName = `${variant}-${tag ? tag + '-' : ''}${stamp}`
const jsonlPath = path.join(logDir, `${baseName}.jsonl`)
const summaryPath = path.join(logDir, `${baseName}.summary.json`)
const stream = fs.createWriteStream(jsonlPath, { flags: 'a' })

const T0 = performance.now()
const nowRel = () => Number((performance.now() - T0).toFixed(1))

function clean (v, depth = 0) {
  if (v === null || v === undefined) return v
  const t = typeof v
  if (t === 'number' || t === 'string' || t === 'boolean') return v
  if (t === 'bigint') return v.toString()
  if (Buffer.isBuffer(v)) return `buf:${v.length}`
  if (Array.isArray(v)) return v.map((x) => clean(x, depth + 1))
  if (t === 'object') {
    if (depth > 4) return '[deep]'
    const o = {}
    for (const k of Object.keys(v)) o[k] = clean(v[k], depth + 1)
    return o
  }
  return String(v)
}

function logLine (obj) {
  const rec = { wall: new Date().toISOString(), t: nowRel(), ...obj }
  try { stream.write(JSON.stringify(rec) + '\n') } catch {}
  return rec
}

// ---------------------------------------------------------------------------
// watch lists
// ---------------------------------------------------------------------------
const WATCH_S2C = new Set([
  'position', 'position_look', 'player_auth_input', 'move_player',
  'ping', 'ping_response', 'kick_disconnect', 'disconnect',
  'login', 'respawn', 'update_health',
  ...(logEntities ? ['sync_entity_position', 'entity_teleport'] : []),
])
const WATCH_C2S = new Set([
  'teleport_confirm', 'position', 'look', 'position_look', 'flying',
  'player_input', 'player_auth_input', 'tick_end',
  'pong', 'ping_request', 'keep_alive', 'entity_action',
])

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------
const WALK_PHASES = new Set(['walk', 'stop', 'settle'])
const st = {
  phase: 'boot',
  lastSentPos: null, // last C2S position/look we wrote
  lastSentAt: null,
  lastTeleportConfirmAt: null,
  tickPos: null, // client sim position before the next move packet is sent
  tickPosAt: null,
  lastTeleportId: 0,
  corrections: [], // target vs last-sent > 0.5 blocks
  forcedRepositions: [], // every S2C position after the initial placement
  selfPins: 0, // forced reposition whose target ~= client sim position
  snapBacks: 0, // forced reposition whose target differs from client sim by > 0.5
  samples: [],
  tickEndCount: 0,
  sawTickEndCapability: null,
  quit: false,
}

// ---------------------------------------------------------------------------
// create the walker bot (bare: host/port/username/auth offline only)
// ---------------------------------------------------------------------------
logLine({
  ev: 'meta', kind: 'start', variant, mineflayer: mineflayerInfo,
  args: { host, port, username, observerUsername, useObserver, directionArg, terrain, standSeconds, walkSeconds, walkBlocks, settleSeconds },
})

const bot = mineflayer.createBot({ host, port, username, auth: 'offline' })

if (!bot._client) {
  console.error('FATAL: bot._client missing right after createBot')
  process.exit(2)
}

// record the pre-send client position on each physics tick (physics.js emits
// physicsTick before its updatePosition/sendPacket* for that tick)
bot.on('physicsTick', () => {
  const p = bot.entity?.position
  if (p) { st.tickPos = { x: p.x, y: p.y, z: p.z }; st.tickPosAt = nowRel() }
})

// --- outgoing (C2S) logging --------------------------------------------------
const origWrite = bot._client.write.bind(bot._client)
bot._client.write = function patchedWrite (name, params) {
  try {
    if (WATCH_C2S.has(name)) {
      logLine({ ev: 'pkt', dir: 'C2S', name, data: clean(params), clientState: bot._client.state })
      if (name === 'teleport_confirm') st.lastTeleportConfirmAt = nowRel()
      if (name === 'tick_end') st.tickEndCount++
      if (name === 'position' || name === 'position_look') {
        st.lastSentPos = { x: params.x, y: params.y, z: params.z }
        st.lastSentAt = nowRel()
      }
    }
  } catch {}
  return origWrite(name, params)
}

// --- incoming (S2C) logging --------------------------------------------------
function absTarget (data, clientPos) {
  const f = data.flags
  let x = data.x; let y = data.y; let z = data.z
  if (f !== null && typeof f === 'object') {
    if (f.x) x = (clientPos?.x ?? 0) + data.x
    if (f.y) y = (clientPos?.y ?? 0) + data.y
    if (f.z) z = (clientPos?.z ?? 0) + data.z
  } else if (typeof f === 'number') {
    if (f & 1) x = (clientPos?.x ?? 0) + data.x
    if (f & 2) y = (clientPos?.y ?? 0) + data.y
    if (f & 4) z = (clientPos?.z ?? 0) + data.z
  }
  return { x, y, z }
}
const hyp = (a, b) => (a && b ? Number(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z).toFixed(3)) : null)
const hypH = (a, b) => (a && b ? Number(Math.hypot(a.x - b.x, a.z - b.z).toFixed(3)) : null)

function handleServerPosition (name, data) {
  const clientNow = bot.entity?.position // already updated by physics.js handler
  const target = absTarget(data, clientNow)
  const id = data.teleportId ?? null
  const initial = st.lastSentPos == null || id === 1
  const rec = {
    t: nowRel(), name, target, teleportId: id,
    sinceLastSentMs: st.lastSentAt == null ? null : Number((nowRel() - st.lastSentAt).toFixed(1)),
    sinceLastConfirmMs: st.lastTeleportConfirmAt == null ? null : Number((nowRel() - st.lastTeleportConfirmAt).toFixed(1)),
    phase: st.phase,
    dLastSent: hyp(target, st.lastSentPos),
    dClientAtReceive: hyp(target, clientNow),
  }

  if (initial) {
    rec.klass = 'initial_placement'
    logLine({ ev: 'server_position', ...rec })
    return
  }
  if (!WALK_PHASES.has(st.phase)) {
    rec.klass = 'outside_measurement_window'
    logLine({ ev: 'server_position', ...rec })
    return
  }

  st.forcedRepositions.push(rec)
  const isPin = (rec.dClientAtReceive ?? 9) < 0.5
  if (isPin) st.selfPins++

  // spec correction: server disagrees with the bot's LAST SENT position by >0.5
  if (rec.dLastSent != null && rec.dLastSent > 0.5) {
    st.corrections.push(rec)
    rec.klass = 'correction'
    logLine({ ev: 'CORRECTION', ...rec, lastSent: { ...st.lastSentPos } })
  } else {
    rec.klass = isPin ? 'self_pin' : 'small_shift'
    logLine({ ev: 'server_reposition', ...rec })
  }
}

bot._client.on('packet', (data, meta) => {
  const name = meta?.name
  if (!name || !WATCH_S2C.has(name)) return
  logLine({ ev: 'pkt', dir: 'S2C', name, s2c: true, data: clean(data) })
  if (name === 'position' || name === 'position_look') handleServerPosition(name, data)
  if (name === 'kick_disconnect' || name === 'disconnect') logLine({ ev: 'DISCONNECT', name, reason: clean(data) })
})

bot.on('error', (err) => logLine({ ev: 'bot_error', message: err.message }))
bot.on('kicked', (reason) => logLine({ ev: 'kicked', reason: clean(reason) }))
bot.on('end', (reason) => logLine({ ev: 'end', reason: String(reason) }))
bot.on('death', () => logLine({ ev: 'death' }))

// ---------------------------------------------------------------------------
// observer bot: stand-still second bot whose view of AI_Bot is the
// server-authoritative position (what the server tells other players).
// ---------------------------------------------------------------------------
let obs = null
function spawnObserver () {
  if (!useObserver) return
  try { obs = mineflayer.createBot({ host, port, username: observerUsername, auth: 'offline' }) } catch { obs = null; return }
  obs.on('error', (err) => logLine({ ev: 'observer_error', message: err.message }))
  obs.on('kicked', (reason) => logLine({ ev: 'observer_kicked', reason: clean(reason) }))
  obs.on('end', () => {})
  obs.on('spawn', () => logLine({ ev: 'observer_spawn', position: clean(obs.entity?.position) }))
}
function observerViewOfWalker () {
  if (!obs) return null
  const p = obs.players?.[username]?.entity?.position
  return p ? { x: p.x, y: p.y, z: p.z } : null
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const clientPos = () => {
  const p = bot.entity?.position
  return p ? { x: p.x, y: p.y, z: p.z } : null
}

function setPhase (p) {
  st.phase = p
  logLine({ ev: 'phase', phase: p, client: clientPos(), server: observerViewOfWalker() })
}

let sampler = null
let walkStartPos = null
function startSampler () {
  sampler = setInterval(() => {
    const c = clientPos()
    if (!c) return
    const s = observerViewOfWalker()
    const disp = walkStartPos ? hypH(c, walkStartPos) : null
    st.samples.push({ t: nowRel(), phase: st.phase, client: c, server: s, disp })
    logLine({ ev: 'sample', phase: st.phase, client: c, server: s, disp })
  }, 100)
  sampler.unref?.()
}

function scanDirection () {
  const p = bot.entity.position.clone()
  const V = (x, y, z) => { const v = p.clone(); v.set(x, y, z); return v }
  const solid = (x, y, z) => {
    try { const b = bot.blockAt(V(x, y, z)); return !!(b && b.boundingBox !== 'empty') } catch { return true }
  }
  const cx = Math.floor(p.x); const cy = Math.round(p.y); const cz = Math.floor(p.z)
  const dirs = [
    ['N', 0, -1], ['S', 0, 1], ['W', -1, 0], ['E', 1, 0],
    ['NE', 1, -1], ['NW', -1, -1], ['SE', 1, 1], ['SW', -1, 1],
  ]
  const results = []
  for (const [name, dx, dz] of dirs) {
    let run = 0; let dropAt = null
    for (let i = 1; i <= 12; i++) {
      const x = cx + dx * i; const z = cz + dz * i
      if (solid(x, cy, z) || solid(x, cy + 1, z)) break // wall
      if (!solid(x, cy - 1, z)) { dropAt = i; break } // ledge / step down
      run++
    }
    results.push({ name, dx, dz, run, dropAt })
  }
  let best
  if (terrain === 'drop') {
    const withDrop = results.filter((r) => r.dropAt != null && r.dropAt <= 5)
    withDrop.sort((a, b) => (b.run - a.run) || (a.dropAt - b.dropAt))
    best = withDrop[0] ?? results.slice().sort((a, b) => b.run - a.run)[0]
  } else {
    best = results.slice().sort((a, b) => b.run - a.run)[0]
  }
  return { best, results }
}

function faceDirection (dx, dz) {
  const p = bot.entity.position.clone()
  const target = p.offset(dx * 10, 0, dz * 10)
  return bot.lookAt(target, true)
}

// ---------------------------------------------------------------------------
// finish + verdict
// ---------------------------------------------------------------------------
let exited = false
function hardExit (code) {
  if (exited) return
  exited = true
  try { stream.end() } catch {}
  try { process.exit(code) } catch {}
}
function ensureExit (code) { setTimeout(() => hardExit(code), 1500) }

async function finish (reason) {
  if (st.quit) { ensureExit(0); return } // already finished; never leave the loop alive
  st.quit = true
  if (sampler) clearInterval(sampler)
  setPhase('done')

  const finalClient = clientPos()
  const finalServer = observerViewOfWalker()
  const corr = st.corrections
  const maxDelta = corr.length ? Number(Math.max(...corr.map((c) => c.dLastSent)).toFixed(2)) : 0
  const meanDelta = corr.length ? Number((corr.reduce((a, c) => a + c.dLastSent, 0) / corr.length).toFixed(2)) : 0
  const clustered = corr.filter((c) => c.sinceLastConfirmMs != null && c.sinceLastConfirmMs <= 100).length

  const maxDisp = st.samples.reduce((m, s) => Math.max(m, s.disp ?? 0), 0)
  const lastDisp = st.samples.length ? (st.samples[st.samples.length - 1].disp ?? 0) : 0
  const elapsedWalk = st.samples.length ? st.samples[st.samples.length - 1].t - (st.samples[0]?.t ?? 0) : 0
  const expectedDisp = Math.min(walkBlocks + 1.5, 4.317 * ((st.walkMs ?? 0) / 1000))
  const stalled = st.walkStopReason === 'timeout' && maxDisp < Math.min(1, walkBlocks * 0.4)
  const finalClientVsServer = hypH(finalClient, finalServer)

  const rubberband = corr.length > 0 || st.forcedRepositions.length >= 2 || stalled
  const verdict = `VERDICT: rubberband=${rubberband ? 'yes' : 'no'} corrections=${corr.length} maxDelta=${Number(maxDelta).toFixed(1)}`
  const detail = `DETAIL: forcedRepositions=${st.forcedRepositions.length} selfPins=${st.selfPins} ` +
    `snapBacks=${corr.length} maxDisplacement=${maxDisp.toFixed(3)} expected~${Number(expectedDisp).toFixed(2)} ` +
    `stall=${stalled ? 'yes' : 'no'} tickEnd=${st.tickEndCount} finalClientVsServer=${finalClientVsServer ?? 'n/a'}`

  const summary = {
    ev: 'summary', kind: 'verdict', variant, mineflayer: mineflayerInfo, reason,
    server: { host, port }, botVersion: bot.version ?? null, protocolVersion: bot.protocolVersion ?? null,
    direction: st.direction, startPosition: st.startPosition, walkStartPosition: walkStartPos,
    walkStopReason: st.walkStopReason,
    rubberband, corrections: corr.length, maxDelta, meanDelta,
    correctionsClusteredAfterTeleportConfirm: clustered,
    forcedRepositions: st.forcedRepositions.length, selfPins: st.selfPins,
    tickEndSent: st.tickEndCount, tickEndEverSent: st.tickEndCount > 0,
    teleportConfirmsSent: st.lastTeleportConfirmAt != null ? 'yes' : 'no',
    finalClientPosition: finalClient, finalServerPositionObserver: finalServer,
    finalClientVsServerDelta: finalClientVsServer,
    maxClientDisplacement: maxDisp, lastSampleDisplacement: lastDisp,
    displacements: st.samples.filter((s) => s.disp != null).map((s) => s.disp),
    verdictLine: verdict, detailLine: detail,
  }

  logLine(summary)
  try { fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n') } catch {}
  console.log(verdict)
  console.log(detail)
  console.log(JSON.stringify({ variant, mineflayerVersion: mineflayerInfo.version, gitSha: mineflayerInfo.gitSha, corrections: corr.length, maxDelta, forcedRepositions: st.forcedRepositions.length, selfPins: st.selfPins, tickEndSent: st.tickEndCount, finalClientVsServer, jsonl: jsonlPath, summary: summaryPath }))

  try { bot.quit('probe done') } catch {}
  try { obs?.quit('probe done') } catch {}
  ensureExit(0)
}

// ---------------------------------------------------------------------------
// procedure
// ---------------------------------------------------------------------------
async function run () {
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('spawn timeout')), 30000)
    bot.once('spawn', () => { clearTimeout(to); resolve() })
    bot.once('error', (e) => { clearTimeout(to); reject(e) })
  })

  const spawnPos = clientPos()
  st.startPosition = spawnPos
  logLine({
    ev: 'walker_spawn', version: bot.version, protocolVersion: bot.protocolVersion,
    username: bot.username, position: spawnPos,
    game: { dimension: bot.game?.dimension, mode: bot.game?.gameMode },
  })

  await bot.waitForTicks(20).catch(() => {})

  setPhase('stand')
  logLine({ ev: 'stand_start', position: clientPos() })
  await sleep(standSeconds * 1000)

  // choose a clear direction so a random spawn inside the spawn region does not
  // confound the walk with terrain collisions
  const { best, results } = scanDirection()
  st.direction = directionArg === 'AUTO' ? best.name : directionArg
  const chosen = directionArg === 'AUTO' ? best : (results.find((r) => r.name === directionArg) ?? best)
  logLine({ ev: 'direction_scan', chosen: st.direction, chosenRun: chosen.run, results })

  await faceDirection(chosen.dx, chosen.dz).catch(() => {})
  await sleep(300)

  setPhase('walk')
  walkStartPos = clientPos()
  logLine({ ev: 'walk_start', position: walkStartPos, direction: st.direction })
  startSampler()
  bot.setControlState('forward', true)

  const walkBegin = performance.now()
  let lastMoveT = performance.now()
  let lastDisp = 0
  while (true) {
    await sleep(50)
    const c = clientPos()
    if (!c || !walkStartPos) continue
    const disp = hypH(c, walkStartPos)
    if (disp > lastDisp + 0.05) { lastDisp = disp; lastMoveT = performance.now() }
    if (disp >= walkBlocks) { st.walkStopReason = 'displacement'; break }
    if ((performance.now() - walkBegin) / 1000 >= walkSeconds) { st.walkStopReason = 'timeout'; break }
    if (performance.now() - lastMoveT > 1000 && disp < walkBlocks) { st.walkStopReason = 'stall'; break }
  }
  st.walkMs = performance.now() - walkBegin

  bot.setControlState('forward', false)
  setPhase('stop')
  logLine({ ev: 'walk_stop_reason', reason: st.walkStopReason, displacement: lastDisp, position: clientPos() })
  await sleep(settleSeconds * 1000)
  setPhase('settle')
  logLine({ ev: 'settle_end', client: clientPos(), server: observerViewOfWalker() })

  await finish('completed')
}

// hard safety timeout so we never leave an orphan bot around
setTimeout(() => { logLine({ ev: 'safety_timeout' }); finish('safety_timeout') }, totalTimeoutMs)
setTimeout(() => hardExit(0), totalTimeoutMs + 5000)

process.on('SIGINT', () => finish('SIGINT'))
process.on('SIGTERM', () => finish('SIGTERM'))

spawnObserver()

run().catch((err) => {
  logLine({ ev: 'fatal', message: err.message, stack: err.stack })
  console.error(`FATAL: ${err.message}`)
  finish('error')
})
