#!/usr/bin/env bun
// movement-test/vertical.mjs
//
// Focused vertical-movement harness (jump / step-up / pit-escape) built on the
// same bare-Mineflayer setup as probe.mjs. It exists because probe.mjs has no
// jump logic: walking forward into a 1-2 block step can never leave it.
//
// Modes:
//   recon   dump the terrain columns around spawn, find step-up and pit sites
//   jump    press jump while standing; verify the client rises and the server accepts it
//   step    walk toward a 1-2 block step and jump when blocked; prove the climb
//   pit     try to leave a 2-block pit (optionally: walk to a discovered pit first)
//
// Usage:
//   bun vertical.mjs --variant G --mode recon --username AI_R1
//   bun vertical.mjs --variant G --mode jump  --username AI_J1
//   bun vertical.mjs --variant G --mode step  --username AI_S1 --direction N
//   bun vertical.mjs --variant G --mode pit   --username AI_P1 --pit x,y,z
//
// All packet-level evidence is written to logs/<variant>-<tag>-<ts>.jsonl and a
// summary JSON next to it.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = __dirname

const argv = process.argv.slice(2)
const has = (n) => argv.includes(`--${n}`)
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`)
  return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1] : d
}

if (has('help')) {
  console.log(`Usage: bun vertical.mjs [options]
  --variant <A|...|L|STOCK>   mineflayer variant (default G)
  --mineflayer <dir>          explicit mineflayer package dir
  --host/--port               server (default 127.0.0.1:25565)
  --username <name>           bot username (default AI_V)
  --mode <recon|jump|step|pit|nav>
  --direction <N|S|E|W|NE|NW|SE|SW>   walk direction for step/pit
  --target <x,y,z>            destination for --mode nav (feet position)
  --pit <x,y,z>               pit floor coordinates for --mode pit
  --step-at <x,y,z>           step base coordinates for --mode step
  --jump-ms <n>               how long to hold jump each press (default 250)
  --walk-seconds <n>          max walk time (default 8)
  --stand-seconds <n>         stand before acting (default 2)
  --log-dir <dir>             JSONL output dir (default ./logs)
  --tag <str>                 log suffix
  --help`)
  process.exit(0)
}

const variant = String(opt('variant', 'G')).toUpperCase()
const host = opt('host', '127.0.0.1')
const port = Number(opt('port', 25565))
const username = opt('username', 'AI_V')
const mode = String(opt('mode', 'recon')).toLowerCase()
const directionArg = String(opt('direction', '')).toUpperCase()
const pitArg = opt('pit', null)
const stepAtArg = opt('step-at', null)
const targetArg = opt('target', null)
const jumpMs = Number(opt('jump-ms', 250))
const walkSeconds = Number(opt('walk-seconds', 8))
const standSeconds = Number(opt('stand-seconds', 2))
const logDir = opt('log-dir', path.join(ROOT, 'logs'))
const tag = opt('tag', mode)
const totalTimeoutMs = Number(opt('total-timeout-seconds', 90)) * 1000

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
const mineflayerDir = path.resolve(opt('mineflayer', VARIANT_PATHS[variant] || VARIANT_PATHS.G))

function loadMineflayer (dir) {
  const pkgPath = path.join(dir, 'package.json')
  if (!fs.existsSync(pkgPath)) throw new Error(`mineflayer not found at ${dir}`)
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  return { entry: path.join(dir, pkg.main || 'index.js'), pkg }
}
function gitSha (dir) {
  try {
    const gitFile = path.join(dir, '.git')
    if (!fs.existsSync(gitFile)) return null
    const head = fs.readFileSync(path.join(gitFile, 'HEAD'), 'utf8').trim()
    if (head.startsWith('ref: ')) {
      const ref = head.slice(5)
      const p = path.join(gitFile, ref)
      if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim()
      return null
    }
    return head
  } catch { return null }
}

const { entry, pkg } = loadMineflayer(mineflayerDir)
const mineflayerMod = await import(pathToFileURL(entry).href)
const mineflayer = mineflayerMod.default || mineflayerMod
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

const WATCH_S2C = new Set(['position', 'position_look', 'ping', 'kick_disconnect', 'disconnect', 'login', 'respawn', 'update_health', 'player_rotation'])
const WATCH_C2S = new Set(['teleport_confirm', 'position', 'look', 'position_look', 'flying', 'player_input', 'tick_end', 'keep_alive', 'entity_action'])

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------
const st = {
  phase: 'boot',
  lastSentPos: null,
  tickEndCount: 0,
  playerInputLog: [],
  serverPositions: [],
  jumpSamples: [],
  notes: [],
}

logLine({
  ev: 'meta', kind: 'start', variant, mode, mineflayer: mineflayerInfo,
  args: { host, port, username, directionArg, pitArg, stepAtArg, jumpMs, walkSeconds, standSeconds },
})

const bot = mineflayer.createBot({ host, port, username, auth: 'offline' })
if (!bot._client) { console.error('FATAL: no bot._client'); process.exit(2) }

// Optional diagnostic: force the client's terrain-contact flag to false in every
// outgoing movement packet, to isolate whether the server rejects packets that
// report hasHorizontalCollision=true.
const forceCollFalse = has('force-coll-false')
if (forceCollFalse) {
  const ow = bot._client.write.bind(bot._client)
  bot._client.write = function (name, params) {
    if (params && params.flags && (name === 'position' || name === 'position_look' || name === 'look' || name === 'flying')) {
      params = { ...params, flags: { ...params.flags, hasHorizontalCollision: false } }
    }
    return ow(name, params)
  }
}

const origWrite = bot._client.write.bind(bot._client)
bot._client.write = function patchedWrite (name, params) {
  try {
    if (WATCH_C2S.has(name)) {
      logLine({ ev: 'pkt', dir: 'C2S', name, data: clean(params), clientState: bot._client.state })
      if (name === 'tick_end') st.tickEndCount++
      if (name === 'player_input') st.playerInputLog.push({ t: nowRel(), inputs: clean(params.inputs) })
      if (name === 'position' || name === 'position_look') {
        st.lastSentPos = { x: params.x, y: params.y, z: params.z }
      }
    }
  } catch {}
  return origWrite(name, params)
}

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
const hyp3 = (a, b) => (a && b ? Number(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z).toFixed(3)) : null)

bot._client.on('packet', (data, meta) => {
  const name = meta?.name
  if (!name || !WATCH_S2C.has(name)) return
  logLine({ ev: 'pkt', dir: 'S2C', name, s2c: true, data: clean(data) })
  if (name === 'position' || name === 'position_look') {
    const clientNow = bot.entity?.position
    const target = absTarget(data, clientNow)
    const rec = {
      t: nowRel(), name, target, teleportId: data.teleportId ?? null, phase: st.phase,
      dLastSent: hyp3(target, st.lastSentPos), dClient: hyp3(target, clientNow),
    }
    st.serverPositions.push(rec)
    logLine({ ev: 'server_position', ...rec })
  }
})
bot.on('error', (err) => logLine({ ev: 'bot_error', message: err.message }))
bot.on('kicked', (reason) => logLine({ ev: 'kicked', reason: clean(reason) }))
bot.on('end', (reason) => logLine({ ev: 'end', reason: String(reason) }))
bot.on('death', () => logLine({ ev: 'death' }))

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const clientPos = () => { const p = bot.entity?.position; return p ? { x: p.x, y: p.y, z: p.z } : null }
const setPhase = (p) => { st.phase = p; logLine({ ev: 'phase', phase: p, client: clientPos() }) }

function blockAt (x, y, z) {
  try { return bot.blockAt(new (bot.entity.position.constructor)(x, y, z)) } catch { return null }
}
const solid = (x, y, z) => { const b = blockAt(x, y, z); return !!(b && b.boundingBox !== 'empty') }
const solidName = (x, y, z) => { const b = blockAt(x, y, z); return b ? `${b.name}[${b.boundingBox}]` : 'null' }

// highest non-empty block in the column, searched around the bot's y
function surfaceInfo (x, z) {
  const cy = Math.round(bot.entity.position.y)
  for (let y = cy + 8; y >= cy - 14; y--) {
    const b = blockAt(x, y, z)
    if (b && b.boundingBox !== 'empty') return { y, name: b.name }
  }
  return null
}
function surfaceInfoFrom (x, z, cy) {
  for (let y = cy + 8; y >= cy - 14; y--) {
    const b = blockAt(x, y, z)
    if (b && b.boundingBox !== 'empty') return { y, name: b.name }
  }
  return null
}

const DIRS8 = [
  ['N', 0, -1], ['S', 0, 1], ['W', -1, 0], ['E', 1, 0],
  ['NE', 1, -1], ['NW', -1, -1], ['SE', 1, 1], ['SW', -1, 1],
]

// nearest sharp 1-3 block step-up: the surface rises directly at the next column
function findSteps (maxDist = 10) {
  const p = bot.entity.position
  const cx = Math.floor(p.x); const cz = Math.floor(p.z)
  const s0 = surfaceInfo(cx, cz)
  const base = s0?.y ?? Math.round(p.y)
  const out = []
  for (const [name, dx, dz] of DIRS8) {
    let prev = base
    for (let i = 1; i <= maxDist; i++) {
      const x = cx + dx * i; const z = cz + dz * i
      const s = surfaceInfoFrom(x, z, base)
      if (!s) break
      if (s.y - prev >= 1 && s.y - prev <= 3) {
        // the rise must be a wall at the destination column, and headroom above the origin
        const wall = solid(x, prev + 1, z)
        const head = !solid(x, prev + 2, z) && !solid(x, prev + 3, z)
        out.push({ dir: name, dx, dz, dist: i, from: prev, to: s.y, rise: s.y - prev, at: { x, y: s.y, z }, block: s.name, wall, head })
        break
      }
      prev = s.y
    }
  }
  out.sort((a, b) => a.dist - b.dist)
  return out
}

// nearest depression whose floor is 1-3 below all four horizontal neighbours
function findPits (maxDist = 12) {
  const p = bot.entity.position
  const cx = Math.floor(p.x); const cz = Math.floor(p.z)
  const base = Math.round(p.y)
  const out = []
  for (let dx = -maxDist; dx <= maxDist; dx++) {
    for (let dz = -maxDist; dz <= maxDist; dz++) {
      const d = Math.hypot(dx, dz)
      if (d > maxDist) continue
      const x = cx + dx; const z = cz + dz
      const s = surfaceInfoFrom(x, z, base)
      if (!s) continue
      const nb = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([ox, oz]) => surfaceInfoFrom(x + ox, z + oz, base))
      if (nb.some((n) => !n)) continue
      const minN = Math.min(...nb.map((n) => n.y))
      const depth = minN - s.y
      if (depth >= 1 && depth <= 3) {
        const a1 = blockAt(x, s.y + 1, z); const a2 = blockAt(x, s.y + 2, z)
        const air = (b) => b && (b.name === 'air' || b.name === 'cave_air')
        if (!air(a1) || !air(a2)) continue // dry pit only (skip water/lava/overhang)
        out.push({ x, y: s.y, z, depth, floor: s.name, neighbors: nb.map((n) => n.y), above: a1.name })
      }
    }
  }
  out.sort((a, b) => Math.hypot(a.x - cx, a.z - cz) - Math.hypot(b.x - cx, b.z - cz))
  // dedupe near-identical cells
  const seen = new Set()
  const dedup = []
  for (const o of out) { const k = `${o.x},${o.z}`; if (seen.has(k)) continue; seen.add(k); dedup.push(o) }
  return dedup.slice(0, 20)
}

async function faceDir (dx, dz) {
  const p = bot.entity.position.clone()
  await bot.lookAt(p.offset(dx * 10, 0, dz * 10), true)
}
function sample (label) {
  const c = clientPos()
  const feet = c ? `${solidName(Math.floor(c.x), Math.round(c.y), Math.floor(c.z))}` : null
  const head = c ? `${solidName(Math.floor(c.x), Math.round(c.y) + 1, Math.floor(c.z))}` : null
  const rec = {
    t: nowRel(), label, phase: st.phase, client: c,
    onGround: bot.entity?.onGround, velY: bot.entity?.velocity?.y,
    collH: bot.entity?.isCollidedHorizontally, collV: bot.entity?.isCollidedVertically,
    inWater: bot.entity?.isInWater, inLava: bot.entity?.isInLava, inWeb: bot.entity?.isInWeb,
    feetBlock: feet, headBlock: head,
  }
  st.jumpSamples.push(rec)
  logLine({ ev: 'sample', ...rec })
  return rec
}

// ---------------------------------------------------------------------------
// modes
// ---------------------------------------------------------------------------
async function modeRecon () {
  setPhase('recon')
  // wait for the chunks around us to actually be loaded before scanning
  let loaded = false
  for (let i = 0; i < 60 && !loaded; i++) {
    const p = bot.entity.position
    loaded = solid(Math.floor(p.x) + 8, Math.round(p.y), Math.floor(p.z) + 8) && solid(Math.floor(p.x) - 8, Math.round(p.y), Math.floor(p.z) - 8)
    if (!loaded) await sleep(100)
  }
  const p = clientPos()
  const cx = Math.floor(p.x); const cy = Math.round(p.y); const cz = Math.floor(p.z)
  const columns = []
  for (let dz = -6; dz <= 6; dz++) {
    let row = ''
    for (let dx = -6; dx <= 6; dx++) {
      const s = surfaceInfoFrom(cx + dx, cz + dz, cy)
      row += s == null ? ' ? ' : (s.y === cy ? ' . ' : String(s.y - cy).padStart(2, ' ').slice(-2) + ' ')
    }
    columns.push(row)
  }
  const steps = findSteps(10)
  const pits = findPits(12)
  logLine({ ev: 'recon', spawn: p, steps, pits, columns, chunksLoaded: loaded })
  console.log('SPAWN', JSON.stringify(p), 'chunksLoaded=' + loaded)
  console.log('STEPS', JSON.stringify(steps))
  console.log('PITS', JSON.stringify(pits))
  console.log('height map (rows dz=-6..6, cols dx=-6..6; number = height above spawn y, . = same, ? = unknown):')
  columns.forEach((r, i) => console.log(String(i - 6).padStart(3), r))
  st.recon = { spawn: p, steps, pits, chunksLoaded: loaded }
}

async function modeJump () {
  setPhase('stand')
  await sleep(standSeconds * 1000)
  sample('before')
  setPhase('jump')
  const y0 = bot.entity.position.y
  let maxY = y0
  for (let i = 0; i < 4; i++) {
    bot.setControlState('jump', true)
    for (let k = 0; k < 6; k++) { await sleep(50); maxY = Math.max(maxY, bot.entity.position.y); sample(`jump${i}`) }
    bot.setControlState('jump', false)
    for (let k = 0; k < 6; k++) { await sleep(50); sample(`fall${i}`) }
  }
  setPhase('settle')
  await sleep(800)
  sample('after')
  const rose = maxY - y0
  const result = { mode: 'jump', startY: y0, maxY, rose, expectedRose: 1.2522, ok: rose > 1.0, playerInputs: st.playerInputLog.length, tickEnd: st.tickEndCount, serverPositions: st.serverPositions.length }
  logLine({ ev: 'result', ...result })
  console.log('RESULT ' + JSON.stringify(result))
  st.result = result
}

// Look ahead along the travel direction and return the first column whose floor
// rose by >= 1 relative to the bot's current feet level (i.e. a step/wall).
function scanAhead (c, ux, uz) {
  const floorY = Math.round(c.y) - 1
  for (const dist of [0.8, 1.2, 1.6, 2.0, 2.4, 2.8]) {
    const x = Math.floor(c.x + ux * dist)
    const z = Math.floor(c.z + uz * dist)
    const s = surfaceInfoFrom(x, z, floorY)
    if (!s) continue
    const rise = s.y - floorY
    if (rise >= 1) return { dist, rise, x, z, top: s.y, name: s.name }
  }
  return null
}

// General vertical-locomotion actuator: walk toward (tx,ty,tz), and climb 1-2
// block rises by jumping BEFORE contact (a packet that pushes into a block while
// jumping is rejected by the Leaf server with a position teleport).
async function navigateTo (tx, ty, tz, timeoutMs, label, opts = {}) {
  const hTol = opts.hTol ?? 0.75
  const yTol = opts.yTol ?? 1.2
  const start = clientPos()
  let maxY = start.y
  let jumps = 0
  let recoveries = 0
  let stuckTicks = 0
  let backUntil = 0
  const t0 = performance.now()
  while (performance.now() - t0 < timeoutMs) {
    const c = clientPos()
    maxY = Math.max(maxY, c.y)
    const dx = tx - c.x; const dz = tz - c.z
    const d = Math.hypot(dx, dz)
    sample(label)
    if (d < hTol && Math.abs(c.y - ty) < yTol) {
      bot.setControlState('forward', false); bot.setControlState('jump', false); bot.setControlState('back', false)
      return { ok: true, start, end: clientPos(), maxY, rose: maxY - start.y, jumps, recoveries, ms: Math.round(performance.now() - t0) }
    }
    const ux = dx / (d || 1); const uz = dz / (d || 1)
    await bot.lookAt(bot.entity.position.offset(dx, 0, dz), true).catch(() => {})

    // recovery: if we are already pressed into terrain, back off for a moment so
    // the next approach can jump before contact again
    if (performance.now() < backUntil) {
      bot.setControlState('forward', false); bot.setControlState('jump', false); bot.setControlState('back', true)
      await sleep(50)
      continue
    }
    const pinned = bot.entity.isCollidedHorizontally
    if (pinned) {
      recoveries++
      stuckTicks++
      // Vertical hop first (forward released): a pure jump is always accepted.
      // Then push forward while airborne, when the body has cleared the obstacle.
      bot.setControlState('forward', false)
      bot.setControlState('jump', true)
      await sleep(180)
      bot.setControlState('jump', false)
      bot.setControlState('forward', true)
      await sleep(260)
      bot.setControlState('forward', false)
      if (bot.entity.isCollidedHorizontally) {
        // still pinned: back off so the next approach can jump before contact
        bot.setControlState('back', true)
        backUntil = performance.now() + 300
      }
      if (stuckTicks > 80) break
      await sleep(30)
      continue
    }
    bot.setControlState('back', false)

    const ob = scanAhead(c, ux, uz)
    const climbable = ob && ob.rise >= 1 && ob.rise <= 2 && ob.dist <= 2.2
    if (climbable && bot.entity.onGround) {
      // pre-emptive jump while horizontal movement is still free
      bot.setControlState('forward', true)
      bot.setControlState('jump', true)
      jumps++
      await sleep(110)
      bot.setControlState('jump', false)
      await sleep(220)
    } else {
      bot.setControlState('forward', true)
      bot.setControlState('jump', false)
      await sleep(50)
    }
    if (bot.entity.onGround && !bot.entity.isCollidedHorizontally && !climbable) stuckTicks = 0
  }
  bot.setControlState('forward', false); bot.setControlState('jump', false); bot.setControlState('back', false)
  return { ok: false, start, end: clientPos(), maxY, rose: maxY - start.y, jumps, recoveries, ms: Math.round(performance.now() - t0) }
}

async function modeNav () {
  if (!targetArg) throw new Error('nav mode needs --target x,y,z')
  const [tx, ty, tz] = targetArg.split(',').map(Number)
  setPhase('stand')
  await sleep(standSeconds * 1000)
  setPhase('nav')
  const r = await navigateTo(tx, ty, tz, walkSeconds * 1000, 'nav')
  bot.setControlState('forward', false)
  bot.setControlState('jump', false)
  setPhase('settle')
  await sleep(600)
  const result = {
    mode: 'nav', target: { x: tx, y: ty, z: tz }, ...r,
    startY: r.start.y, endY: r.end.y, climbed: r.end.y >= r.start.y + 1,
    forcedRepositions: st.serverPositions.length, tickEnd: st.tickEndCount, playerInputs: st.playerInputLog.length,
  }
  logLine({ ev: 'result', ...result })
  console.log('RESULT ' + JSON.stringify(result))
  st.result = result
}

async function resolveStep () {
  if (stepAtArg) {
    const [x, y, z] = stepAtArg.split(',').map(Number)
    return { x, y, z }
  }
  const steps = findSteps(8)
  if (!steps.length) return null
  if (directionArg) {
    const s = steps.find((s) => s.dir === directionArg) ?? steps[0]
    return s
  }
  // nearest
  steps.sort((a, b) => a.dist - b.dist)
  return steps[0]
}

async function modeStep () {
  setPhase('stand')
  await sleep(standSeconds * 1000)
  const step = await resolveStep()
  if (!step) { console.log('RESULT {"ok":false,"reason":"no step found"}'); st.result = { ok: false, reason: 'no step found' }; return }
  const dirs = { N: [0, -1], S: [0, 1], W: [-1, 0], E: [1, 0], NE: [1, -1], NW: [-1, -1], SE: [1, 1], SW: [-1, 1] }
  const [dx, dz] = dirs[step.dir]
  await faceDir(dx, dz)
  await sleep(300)
  const start = clientPos()
  setPhase('walk')
  logLine({ ev: 'step_target', step, start })
  bot.setControlState('forward', true)
  const t0 = performance.now()
  let maxY = start.y
  while ((performance.now() - t0) / 1000 < walkSeconds) {
    await sleep(60)
    const c = clientPos()
    const disp = Math.hypot(c.x - start.x, c.z - start.z)
    maxY = Math.max(maxY, c.y)
    sample('step')
    const isBlocked = bot.entity?.isCollidedHorizontally
    if (isBlocked) {
      logLine({ ev: 'blocked', client: c, targetRise: step.to - start.y })
      // hold jump while continuing to walk forward -- the general step-climb recipe
      bot.setControlState('jump', true)
      await sleep(jumpMs)
      bot.setControlState('jump', false)
    }
    if (c.y >= start.y + 1 && disp > 0.5) break
    if (disp > 4) break
  }
  bot.setControlState('forward', false)
  bot.setControlState('jump', false)
  setPhase('settle')
  await sleep(800)
  const end = sample('after')
  const climbed = end.client.y >= start.y + 1
  const result = { mode: 'step', dir: step.dir, target: step, start, end: end.client, maxY, climbed, horizontalDisp: Math.hypot(end.client.x - start.x, end.client.z - start.z), blockCollisions: st.jumpSamples.filter((s) => s.collH).length, playerInputs: st.playerInputLog.length, tickEnd: st.tickEndCount }
  logLine({ ev: 'result', ...result })
  console.log('RESULT ' + JSON.stringify(result))
  st.result = result
}

function parseVec (s) { const [x, y, z] = s.split(',').map(Number); return { x, y, z } }

// Deterministic controlled experiment: dig a 1x1 hole `depth` blocks deep under
// the bot, then try to climb out. `depth 1` is the escapable case; `depth 2` is
// the "2-block pit". Restores the hole afterwards with the dug drops when possible.
async function modeDigpit () {
  setPhase('stand')
  await sleep(standSeconds * 1000)
  const depth = Number(opt('depth', 2))
  const start = clientPos()
  const bx = Math.floor(start.x); const bz = Math.floor(start.z)
  // center the bot inside the 1x1 column so its AABB is fully supported by it
  setPhase('center')
  await navigateTo(bx + 0.5, start.y, bz + 0.5, 4000, 'center', { hTol: 0.06, yTol: 0.35 })
  await sleep(500)
  const centered = clientPos()
  const surfaceTop = Math.round(centered.y) - 1
  // refuse to dig where water is within one block: the hole would flood and the
  // test would measure swimming, not jumping
  let waterNear = false
  for (let ox = -1; ox <= 1; ox++) {
    for (let oz = -1; oz <= 1; oz++) {
      for (let oy = -1; oy <= 1; oy++) {
        const b = blockAt(bx + ox, surfaceTop + oy, bz + oz)
        if (b && /water|lava/.test(b.name)) waterNear = true
      }
    }
  }
  if (waterNear) {
    const r = { mode: 'digpit', aborted: 'water near dig site', site: { x: bx, y: surfaceTop, z: bz } }
    logLine({ ev: 'result', ...r })
    console.log('RESULT ' + JSON.stringify(r))
    st.result = r
    return
  }
  const dug = []
  setPhase('dig')
  for (let i = 0; i < depth; i++) {
    const yy = Math.round(bot.entity.position.y) - 1
    const b = blockAt(bx, yy, bz)
    if (!b || b.boundingBox === 'empty') { logLine({ ev: 'dig_skip', y: yy }); break }
    const water = /water|lava/.test(b.name)
    logLine({ ev: 'dig_begin', pos: { x: bx, y: yy, z: bz }, name: b.name, water })
    try { await bot.dig(b, 'ignore') } catch (e) { logLine({ ev: 'dig_err', message: e.message }) }
    await sleep(800)
    dug.push({ x: bx, y: yy, z: bz, name: b.name, water })
  }
  await sleep(1200)
  // Optional mid-level bench: dig the surface block of one neighbour so the pit
  // has a 1-block step. Escape then needs two 1-block hops = "2-block terrain".
  let bench = null
  if (has('bench')) {
    for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const b = blockAt(bx + ox, surfaceTop, bz + oz)
      if (b && b.boundingBox !== 'empty' && !/water|lava/.test(b.name)) {
        await bot.lookAt(new (bot.entity.position.constructor)(bx + ox + 0.5, surfaceTop + 0.5, bz + oz + 0.5), true).catch(() => {})
        try { await bot.dig(b, 'ignore') } catch (e) { logLine({ ev: 'bench_dig_err', message: e.message }) }
        await sleep(800)
        bench = { x: bx + ox, y: surfaceTop, z: bz + oz, name: b.name, dir: [ox, oz] }
        break
      }
    }
  }
  const pitFloorTop = surfaceTop - dug.length
  const inPit = clientPos()
  const inWater = bot.entity.isInWater
  logLine({ ev: 'pit_built', depth: dug.length, floorTop: pitFloorTop, inPit, inWater, dug, bench })

  // escape targets: horizontal neighbours; try the hardest (tallest) lip first
  const targets = []
  if (bench) {
    // preferred: the rim two columns away in the bench direction, reached by
    // hopping onto the bench and then onto the rim (two 1-block hops)
    const [ox, oz] = bench.dir
    const s = surfaceInfoFrom(bx + 2 * ox, bz + 2 * oz, surfaceTop + 1)
    if (s) targets.push({ x: bx + 2 * ox, z: bz + 2 * oz, top: s.y, rise: s.y - pitFloorTop, viaBench: true })
  }
  for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
    const s = surfaceInfoFrom(bx + ox, bz + oz, surfaceTop + 1)
    if (s && s.y > pitFloorTop) targets.push({ x: bx + ox, z: bz + oz, top: s.y, rise: s.y - pitFloorTop })
  }
  targets.sort((a, b) => b.rise - a.rise)
  const orderedTargets = bench ? [targets.find((t) => t.viaBench), ...targets.filter((t) => !t.viaBench)].filter(Boolean) : targets

  setPhase('escape')
  const escapeAttempts = []
  let escaped = false
  for (const t of orderedTargets.slice(0, 6)) {
    const r = await navigateTo(t.x + 0.5, t.top + 1, t.z + 0.5, 10000, 'escape', { hTol: 0.5, yTol: 0.5 })
    bot.setControlState('forward', false); bot.setControlState('jump', false); bot.setControlState('back', false)
    await sleep(400)
    const c = clientPos()
    const onLip = c.y >= t.top + 0.5 && Math.hypot(c.x - (t.x + 0.5), c.z - (t.z + 0.5)) < 1.7
    const attempt = { lip: t, ok: r.ok, onLip, final: c, jumps: r.jumps, recoveries: r.recoveries, ms: r.ms }
    escapeAttempts.push(attempt)
    logLine({ ev: 'escape_attempt', ...attempt })
    if (onLip) { escaped = true; break }
  }

  setPhase('settle')
  await sleep(500)
  const end = sample('after')
  const result = {
    mode: 'digpit', depth: dug.length, floorTop: pitFloorTop, dug, inPit, inWater, escaped, escapeAttempts,
    end: end.client, rose: end.client.y - (pitFloorTop + 1), forcedRepositions: st.serverPositions.length,
    tickEnd: st.tickEndCount, playerInputs: st.playerInputLog.length,
  }
  logLine({ ev: 'result', ...result })
  console.log('RESULT ' + JSON.stringify(result))
  st.result = result
}

async function modePit () {
  setPhase('stand')
  await sleep(standSeconds * 1000)
  let pit = null
  if (pitArg) pit = parseVec(pitArg)
  else {
    const pits = findPits(12)
    if (pits.length) pit = { x: pits[0].x, y: pits[0].y, z: pits[0].z }
  }
  if (!pit) { console.log('RESULT {"ok":false,"reason":"no pit found"}'); st.result = { ok: false, reason: 'no pit found' }; return }

  setPhase('enter-pit')
  logLine({ ev: 'pit_target', pit, start: clientPos() })
  const enter = await navigateTo(pit.x + 0.5, pit.y + 1, pit.z + 0.5, 12000, 'pit-enter', { hTol: 0.15, yTol: 0.4 })
  bot.setControlState('forward', false); bot.setControlState('jump', false); bot.setControlState('back', false)
  await sleep(900)
  const inPit = clientPos()
  const inside = Math.abs(inPit.y - (pit.y + 1)) < 0.8
  logLine({ ev: 'pit_arrived', position: inPit, target: pit, inside })

  // Candidate escape lips: adjacent columns whose floor is at/above the pit floor.
  const targets = []
  for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const s = surfaceInfoFrom(pit.x + ox, pit.z + oz, pit.y + 1)
    if (s && s.y >= pit.y + 1) targets.push({ x: pit.x + ox, z: pit.z + oz, top: s.y, rise: s.y - (pit.y + 1) })
  }
  targets.sort((a, b) => a.rise - b.rise)
  logLine({ ev: 'escape_targets', targets })

  setPhase('escape')
  let escaped = false
  let escapeAttempt = null
  for (const t of targets.slice(0, 5)) {
    const r = await navigateTo(t.x + 0.5, t.top + 1, t.z + 0.5, 9000, 'escape')
    bot.setControlState('forward', false); bot.setControlState('jump', false); bot.setControlState('back', false)
    await sleep(400)
    const c = clientPos()
    const onLip = c.y >= t.top + 0.5 && Math.hypot(c.x - (t.x + 0.5), c.z - (t.z + 0.5)) < 1.6
    escapeAttempt = { lip: t, result: r, final: c, onLip }
    logLine({ ev: 'escape_attempt', ...escapeAttempt })
    if (onLip) { escaped = true; break }
  }
  setPhase('settle')
  await sleep(500)
  const end = sample('after')
  const result = {
    mode: 'pit', pit, inside, enter, escapeAttempts: st.jumpSamples.length,
    escaped, escapeAttempt, start: enter.start, end: end.client,
    rose: end.client.y - (pit.y + 1),
    forcedRepositions: st.serverPositions.length, tickEnd: st.tickEndCount, playerInputs: st.playerInputLog.length,
  }
  logLine({ ev: 'result', ...result })
  console.log('RESULT ' + JSON.stringify(result))
  st.result = result
}

// Restore test holes: place a block at each listed removed-block position,
// lowest positions first. Uses whatever placeable block is in the inventory.
const PLACEABLE = /^(dirt|grass_block|coarse_dirt|podzol|mycelium|clay|cobblestone|stone|andesite|diorite|granite|sand|gravel|deepslate|tuff)$/
const PLACE_PREF = ['dirt', 'grass_block', 'coarse_dirt', 'podzol', 'clay', 'cobblestone', 'stone', 'andesite', 'diorite', 'granite', 'deepslate', 'tuff', 'sand', 'gravel']
async function modeFill () {
  setPhase('fill')
  const spec = opt('fill', '')
  const positions = spec.split(';').filter(Boolean).map((s) => s.split(',').map(Number))
  positions.sort((a, b) => a[1] - b[1])
  await sleep(standSeconds * 1000)
  const results = []
  // cover holes top-down; standing on a solid neighbour and placing against it
  const ordered = positions.sort((a, b) => (b[1] - a[1]))
  for (const [x, y, z] of ordered) {
    if (solid(x, y, z)) { results.push({ x, y, z, status: 'already_solid' }); continue }
    let ref = null; let face = null; let stand = null
    for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nb = blockAt(x + ox, y, z + oz)
      if (nb && nb.boundingBox !== 'empty') { ref = nb; face = [-ox, 0, -oz]; stand = [x + ox, y + 1, z + oz]; break }
    }
    if (!ref) {
      const nb = blockAt(x, y - 1, z)
      if (nb && nb.boundingBox !== 'empty') { ref = nb; face = [0, 1, 0]; stand = [x, y + 1, z] }
    }
    const item = bot.inventory.items()
      .filter((i) => PLACEABLE.test(i.name))
      .sort((a, b) => PLACE_PREF.indexOf(a.name) - PLACE_PREF.indexOf(b.name))[0]
    if (!ref || !item) { results.push({ x, y, z, status: 'no_ref_or_block', item: item?.name ?? null }); continue }
    try {
      await navigateTo(stand[0] + 0.5, stand[1], stand[2] + 0.5, 6000, 'fill', { hTol: 0.65, yTol: 0.9 })
      await sleep(350)
      await bot.lookAt(new (bot.entity.position.constructor)(x + 0.5, y + 0.5, z + 0.5), true)
      await bot.equip(item, 'hand')
      await bot.placeBlock(ref, new (bot.entity.position.constructor)(...face))
      await sleep(500)
      results.push({ x, y, z, status: solid(x, y, z) ? 'filled' : 'place_failed', item: item.name })
    } catch (e) { results.push({ x, y, z, status: 'error', message: e.message }) }
  }
  const filled = results.filter((r) => r.status === 'filled' || r.status === 'already_solid').length
  const result = { mode: 'fill', requested: positions.length, filled, results }
  logLine({ ev: 'result', ...result })
  console.log('RESULT ' + JSON.stringify(result))
  st.result = result
}


let exited = false
function hardExit (code) { if (exited) return; exited = true; try { stream.end() } catch {}; try { process.exit(code) } catch {} }
async function finish (reason) {
  if (st.quit) { setTimeout(() => hardExit(0), 1200); return }
  st.quit = true
  setPhase('done')
  const finalClient = clientPos()
  const summary = {
    ev: 'summary', kind: 'vertical', variant, mode, reason, mineflayer: mineflayerInfo,
    server: { host, port }, botVersion: bot.version ?? null, protocolVersion: bot.protocolVersion ?? null,
    username, spawn: st.startPosition, result: st.result ?? null, recon: st.recon ?? null,
    tickEndSent: st.tickEndCount, playerInputCount: st.playerInputLog.length,
    playerInputs: st.playerInputLog.map((p) => p.inputs),
    forcedRepositions: st.serverPositions.length,
    serverPositions: st.serverPositions,
    finalClient: finalClient, samples: st.jumpSamples.slice(-40),
    jsonl: jsonlPath,
  }
  logLine(summary)
  try { fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n') } catch {}
  console.log('SUMMARY ' + JSON.stringify({ mode, result: st.result, forcedRepositions: st.serverPositions.length, tickEnd: st.tickEndCount, playerInputs: st.playerInputLog.length, jsonl: jsonlPath, summary: summaryPath }))
  try { bot.quit('vertical done') } catch {}
  setTimeout(() => hardExit(0), 1200)
}

async function run () {
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('spawn timeout')), 30000)
    bot.once('spawn', () => { clearTimeout(to); resolve() })
    bot.once('error', (e) => { clearTimeout(to); reject(e) })
  })
  st.startPosition = clientPos()
  logLine({ ev: 'spawn', version: bot.version, protocolVersion: bot.protocolVersion, username: bot.username, position: st.startPosition, game: { dimension: bot.game?.dimension, mode: bot.game?.gameMode } })
  await bot.waitForTicks(20).catch(() => {})
  if (mode === 'recon') await modeRecon()
  else if (mode === 'jump') await modeJump()
  else if (mode === 'step') await modeStep()
  else if (mode === 'nav') await modeNav()
  else if (mode === 'pit') await modePit()
  else if (mode === 'digpit') await modeDigpit()
  else if (mode === 'fill') await modeFill()
  else throw new Error(`unknown mode ${mode}`)
  await finish('completed')
}

setTimeout(() => { logLine({ ev: 'safety_timeout' }); finish('safety_timeout') }, totalTimeoutMs)
setTimeout(() => hardExit(0), totalTimeoutMs + 5000)
process.on('SIGINT', () => finish('SIGINT'))
process.on('SIGTERM', () => finish('SIGTERM'))

run().catch((err) => { logLine({ ev: 'fatal', message: err.message, stack: err.stack }); console.error('FATAL: ' + err.message); finish('error') })
