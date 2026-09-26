// Position a fresh offline bot at a chosen spot and log out there, so a later
// run (e.g. m1.mts) resumes from that terrain. Test utility only.
//
// Run: bun data/position-bot.mts <username> <x,y,z>
import mineflayer from 'mineflayer'
import pathfinderModule from 'mineflayer-pathfinder'
import { Executor, EventLogger, defaultExecutorOptions } from '../src/index.ts'
import type { Candidate, Vec3Json } from '../src/index.ts'

const username = process.argv[2] ?? 'AI_Pos'
const targetArg = process.argv[3] ?? '0,0,0'
const targetParts = targetArg.split(',').map(Number)
const tx = targetParts[0] ?? 0
const ty = targetParts[1] ?? 0
const tz = targetParts[2] ?? 0

const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username, auth: 'offline' })
bot.loadPlugin(pathfinderModule.pathfinder)

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function standableAt(x: number, y: number, z: number): boolean {
  const at = bot.blockAt(bot.entity.position.clone().set(x, y, z))
  const above = bot.blockAt(bot.entity.position.clone().set(x, y + 1, z))
  const below = bot.blockAt(bot.entity.position.clone().set(x, y - 1, z))
  return (
    (at === null || at.boundingBox === 'empty') &&
    (above === null || above.boundingBox === 'empty') &&
    below !== null &&
    below.boundingBox === 'block'
  )
}

function nearestStandable(around: Vec3Json): Vec3Json {
  for (let radius = 0; radius <= 4; radius += 1) {
    for (const dy of [0, 1, -1, 2, -2]) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        for (let dz = -radius; dz <= radius; dz += 1) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue
          const spot = { x: around.x + dx, y: around.y + dy, z: around.z + dz }
          if (standableAt(spot.x, spot.y, spot.z)) return spot
        }
      }
    }
  }
  return around
}

bot.once('spawn', async () => {
  await sleep(8000)
  const executor = new Executor(bot, new EventLogger(null, true), {
    ...defaultExecutorOptions,
    reach: 4.5,
    actuation: 'packet',
    pathTimeoutMs: 20000,
  })
  executor.ensureMovements()
  const spot = nearestStandable({ x: tx, y: ty, z: tz })
  const candidate: Candidate = {
    id: `MOVE:pos-${spot.x}_${spot.y}_${spot.z}`,
    kind: 'MOVE',
    label: `position at (${spot.x},${spot.y},${spot.z})`,
    targetName: null,
    target: spot,
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: false,
    hasStandableAdjacent: true,
    meta: { tick: 1, x: spot.x, y: spot.y, z: spot.z },
  }
  process.stdout.write(`[pos] start=${JSON.stringify(bot.entity.position)} goal=${JSON.stringify(spot)}\n`)
  const result = await executor.claim(candidate).completion
  const end = bot.entity.position
  process.stdout.write(
    `[pos] status=${result.status} failure=${result.failure} end=(${end.x.toFixed(2)},${end.y.toFixed(2)},${end.z.toFixed(2)}) ` +
      `distToSpot=${bot.entity.position.distanceTo(bot.entity.position.clone().set(spot.x + 0.5, spot.y, spot.z + 0.5)).toFixed(2)}\n`,
  )
  bot.quit('positioned')
  setTimeout(() => process.exit(0), 800)
})

bot.on('error', (error) => {
  process.stdout.write(`[pos] error: ${error.message}\n`)
})
bot.on('kicked', (reason) => {
  process.stdout.write(`[pos] kicked: ${JSON.stringify(reason)}\n`)
})

setTimeout(() => {
  process.stdout.write('[pos] hard timeout\n')
  process.exit(1)
}, 90000)
