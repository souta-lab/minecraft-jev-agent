// movement-ab.mjs - throwaway A/B diagnostic: run the SAME stock-pathfinder
// step/pit/far scenario against any mineflayer package dir, with C2S packet
// counters, to decide whether stock or the full PR #4063 restores climbing.
//
// node movement-ab.mjs --mineflayer <dir> --username AI_MVG1
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
function opt(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback)
}
const dir = resolve(opt('mineflayer', 'node_modules/mineflayer'))
const username = opt('username', 'AI_MVG1')

const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
const mod = await import(pathToFileURL(join(dir, pkg.main || 'index.js')).href)
const mineflayer = mod.default || mod
const pathfinderModule = require('mineflayer-pathfinder')
const { Movements, goals } = pathfinderModule

console.log(`[ab] mineflayer=${dir} version=${pkg.version}`)

const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username, auth: 'offline' })
bot.loadPlugin(pathfinderModule.pathfinder)

let forced = 0
let c2s = { position: 0, position_look: 0, look: 0, flying: 0, player_input: 0, tick_end: 0 }
let s2cPos = 0
bot.on('forcedMove', () => {
  forced += 1
})
const origWrite = bot._client.write.bind(bot._client)
bot._client.write = (name, params) => {
  if (name in c2s) c2s[name] += 1
  return origWrite(name, params)
}
bot._client.on('position', () => {
  s2cPos += 1
})

const events = []
bot.on('path_update', (r) => events.push(`path_update status=${r.status}`))
bot.on('path_reset', (r) => events.push(`path_reset reason=${r}`))
bot.on('goal_reached', () => events.push('goal_reached'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const fmt = (p) => `(${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)})`
function cell(x, y, z) {
  return bot.blockAt(bot.entity.position.clone().set(x, y, z))
}
const passable = (x, y, z) => {
  const b = cell(x, y, z)
  return b === null || b.boundingBox === 'empty'
}
const solid = (x, y, z) => {
  const b = cell(x, y, z)
  return b !== null && b.boundingBox === 'block'
}
const standable = (x, y, z) => passable(x, y, z) && passable(x, y + 1, z) && solid(x, y - 1, z)
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]

/** nearest 1-block step that is pathfinder-reachable; wider search radius */
function findStep(fx, feetY, fz) {
  for (let r = 2; r <= 24; r += 1) {
    for (const [dx, dz] of DIRS) {
      const x = fx + dx * r
      const z = fz + dz * r
      if (!standable(x, feetY + 1, z)) continue
      const plan = bot.pathfinder.getPathTo(bot.pathfinder.movements, new goals.GoalBlock(x, feetY + 1, z), 1500)
      if (plan.status !== 'noPath') return { x, y: feetY + 1, z }
    }
  }
  return null
}

async function walk(label, goal, budget) {
  events.length = 0
  const before = { ...c2s }
  const forcedBefore = forced
  const s2cBefore = s2cPos
  const start = bot.entity.position.clone()
  const t0 = Date.now()
  let reached = false
  try {
    reached = await Promise.race([
      bot.pathfinder.goto(new goals.GoalBlock(goal.x, goal.y, goal.z)).then(() => true),
      sleep(budget).then(() => {
        bot.pathfinder.setGoal(null)
        bot.pathfinder.stop()
        return false
      }),
    ])
  } catch (e) {
    events.push(`error ${e.message}`)
  }
  const end = bot.entity.position
  const delta = (k) => c2s[k] - before[k]
  console.log(
    `[ab] ${label} reached=${reached} ms=${Date.now() - t0} start=${fmt(start)} end=${fmt(end)} ` +
      `moved=${start.distanceTo(end).toFixed(2)}m dy=${(end.y - start.y).toFixed(2)} forced=${forced - forcedBefore} ` +
      `s2cPosition=${s2cPos - s2cBefore} c2s[pos=${delta('position')},posLook=${delta('position_look')},look=${delta('look')},flying=${delta('flying')},input=${delta('player_input')},tickEnd=${delta('tick_end')}]`,
  )
  for (const e of events.slice(0, 8)) console.log(`[ab]   ${label} :: ${e}`)
  return reached
}

function findPit(fx, feetY, fz) {
  for (let r = 2; r <= 12; r += 1) {
    for (const [dx, dz] of DIRS) {
      const x = fx + dx * r
      const z = fz + dz * r
      if (!standable(x, feetY - 1, z)) continue
      const plan = bot.pathfinder.getPathTo(bot.pathfinder.movements, new goals.GoalBlock(x, feetY - 1, z), 1500)
      if (plan.status !== 'noPath') return { x, y: feetY - 1, z }
    }
  }
  return null
}

function findFar(fx, feetY, fz, min = 22, max = 30) {
  for (let r = max; r >= min; r -= 1) {
    for (const [dx, dz] of DIRS) {
      const x = fx + dx * r
      const z = fz + dz * r
      if (!standable(x, feetY, z)) continue
      const plan = bot.pathfinder.getPathTo(bot.pathfinder.movements, new goals.GoalBlock(x, feetY, z), 2500)
      if (plan.status === 'noPath') continue
      return { spot: { x, y: feetY, z }, dist: Math.hypot(x - fx, z - fz) }
    }
  }
  return null
}

async function run() {
  await sleep(7000)
  forced = 0
  const feet = bot.entity.position
  const fx = Math.floor(feet.x)
  const fy = Math.floor(feet.y)
  const fz = Math.floor(feet.z)
  console.log(`[ab] user=${username} feet=${fmt(feet)}`)
  const movements = new Movements(bot)
  movements.canDig = false
  movements.scafoldingBlocks = []
  movements.allowParkour = false
  movements.allow1by1towers = false
  movements.allowFreeMotion = false
  bot.pathfinder.setMovements(movements)
  const step = findStep(fx, fy, fz)
  const pit = findPit(fx, fy, fz)
  const far = findFar(fx, fy, fz)
  console.log(
    `[ab] features step=${step === null ? 'none' : fmt(step)} pit=${pit === null ? 'none' : fmt(pit)} ` +
      `far=${far === null ? 'none' : `${fmt(far.spot)} d=${far.dist.toFixed(1)}m`}`,
  )
  if (step !== null) await walk('step-1block', step, 18000)
  if (pit !== null) await walk('pit-1block', pit, 18000)
  if (far !== null) await walk('far', far.spot, 30000)
  bot.quit('done')
  setTimeout(() => process.exit(0), 600)
}

bot.once('spawn', () => {
  void run().catch((e) => {
    console.log(`[ab] failed: ${e.message}`)
    process.exit(1)
  })
})
bot.on('error', (e) => console.log(`[ab] error ${e.message}`))
setTimeout(() => process.exit(1), 70000)
