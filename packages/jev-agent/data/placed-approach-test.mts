// placed-approach-test.mts - AGENT-LEVEL proof of the placed-block approach fix.
//
// The bot digs a 2-deep pit under itself, so the surrounding surface is a
// 2-block vertical face (unclimbable: jump apex 1.2522). It then drives the real
// Executor.approachPlacedBlock toward a station block 3 blocks beyond the rim:
// the stock pathfinder and the direct-bearing nudge both stall at the face, the
// approach cuts the upper rim block into a 1-block step, and the actuator climbs
// out and arrives within the horizontal interaction tolerance.
//
// Run: bun data/placed-approach-test.mts --username AI_PA1
import mineflayer from 'mineflayer'
import pathfinderModule from 'mineflayer-pathfinder'
import { Executor, EventLogger, defaultExecutorOptions } from '../src/index.ts'
import type { Vec3Json } from '../src/index.ts'

function opt(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`)
  const value = index === -1 ? undefined : process.argv[index + 1]
  return value ?? fallback
}

const username = opt('username', 'AI_PA1')
const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username, auth: 'offline' })
bot.loadPlugin(pathfinderModule.pathfinder)

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const column = () => bot.entity.position.clone()
const solidAt = (x: number, y: number, z: number): boolean => {
  const block = bot.blockAt(column().set(x, y, z))
  return block !== null && block.boundingBox === 'block'
}
const highestSolid = (x: number, z: number, from: number, to: number): number | null => {
  for (let y = to; y >= from; y -= 1) if (solidAt(x, y, z)) return y
  return null
}

async function digSupport(): Promise<string | null> {
  const p = bot.entity.position
  const below = bot.blockAt(p.clone().offset(0, -0.5, 0).floor())
  if (below === null || below.boundingBox === 'empty' || !below.diggable) return null
  const name = below.name
  await bot.dig(below, 'ignore')
  return name
}

type ApproachFn = (block: Vec3Json, label: string, epoch: number, signal: AbortSignal) => Promise<void>

async function main(): Promise<void> {
  await sleep(8000)
  const surfaceTop = Math.round(bot.entity.position.y) - 1
  process.stdout.write(`[pa] spawn feet=${JSON.stringify(column())} surfaceTop=${surfaceTop}\n`)

  let dug = 0
  for (let pass = 0; pass < 2; pass += 1) {
    const name = await digSupport()
    if (name === null) break
    dug += 1
    process.stdout.write(`[pa] dug support #${dug}: ${name}, feet=${JSON.stringify(column())}\n`)
    await sleep(900)
  }
  await sleep(800)
  const pit = column()
  process.stdout.write(`[pa] pit feet=${JSON.stringify(pit)} depth=${(surfaceTop + 1 - pit.y).toFixed(2)}\n`)

  const executor = new Executor(bot, new EventLogger(null, true), {
    ...defaultExecutorOptions,
    reach: 4.5,
    actuation: 'pathfinder',
  })
  executor.ensureMovements()

  const fx = Math.floor(pit.x)
  const fy = Math.floor(pit.y)
  const fz = Math.floor(pit.z)
  const dirs: Array<[number, number]> = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ]
  const stationDistance = 4
  let station: Vec3Json | null = null
  for (const [ux, uz] of dirs) {
    const rimTop = highestSolid(fx + ux, fz + uz, fy, fy + 4)
    if (rimTop !== surfaceTop) continue
    const tx = fx + ux * stationDistance
    const tz = fz + uz * stationDistance
    const top = highestSolid(tx, tz, fy, fy + 5)
    if (top === null) continue
    station = { x: tx, y: top, z: tz }
    process.stdout.write(`[pa] station block at (${station.x},${station.y},${station.z}) dir=(${ux},${uz})\n`)
    break
  }
  if (station === null) {
    process.stdout.write('[pa] FAIL: no rim wall in any direction\n')
    finish(1)
    return
  }

  const controller = new AbortController()
  const approach = (executor as unknown as { approachPlacedBlock: ApproachFn }).approachPlacedBlock.bind(executor)
  let error: string | null = null
  try {
    await approach(station, 'test_station', executor.epoch, controller.signal)
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught)
  }

  const end = column()
  const horizontal = Math.hypot(station.x - end.x, station.z - end.z)
  const climbed = end.y - pit.y
  const surfaceOk = end.y >= surfaceTop
  const arrivalOk = horizontal <= 2.8 && error === null
  process.stdout.write(
    `[pa] end feet=${JSON.stringify(end)} climbed=${climbed.toFixed(2)} horizontalToStation=${horizontal.toFixed(2)} ` +
      `error=${error ?? '-'}\n`,
  )
  process.stdout.write(`[pa] SUMMARY approachOk=${arrivalOk} climbedOut=${surfaceOk} depthDug=${dug}\n`)
  process.stdout.write('[pa] DONE\n')
  finish(arrivalOk && surfaceOk ? 0 : 1)
}

function finish(code: number): void {
  bot.quit('placed-approach-test done')
  setTimeout(() => process.exit(code), 800)
}

bot.on('error', (error: Error) => { process.stdout.write(`[pa] error ${error.message}\n`) })
bot.on('kicked', (reason: unknown) => { process.stdout.write(`[pa] kicked ${JSON.stringify(reason)}\n`) })
bot.once('spawn', () => {
  main().catch((error: unknown) => {
    process.stdout.write(`[pa] failed: ${error instanceof Error ? error.stack : String(error)}\n`)
    finish(1)
  })
})
