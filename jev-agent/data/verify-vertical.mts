// verify-vertical.mts - agent-level proof of the ported vertical-movement
// recipe. Digs a deterministic 1-deep pit directly under the bot, has the
// executor's OWN MOVE action climb out of it (a 1-block step), and - when the
// dug drop is available - places a 1-block step two cells away and climbs that
// too. It quotes the executor's `control locomotion arrival` y-progression,
// jump/recovery counts and forcedRepositions.
//
// Run: npx tsx data/verify-vertical.mts [username] [logDir]
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import mineflayer from 'mineflayer'
import pathfinderModule from 'mineflayer-pathfinder'
import { jevAgent } from '../src/index.ts'
import type { Candidate, Vec3Json } from '../src/index.ts'

const username = process.argv[2] ?? 'AI_V1'
const logDir = process.argv[3] ?? 'logs/vertical-port'
const PLACEABLE = /^(dirt|grass_block|coarse_dirt|podzol|cobblestone|stone|andesite|diorite|granite|sand|gravel)$/

const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username, auth: 'offline' })
bot.loadPlugin(pathfinderModule.pathfinder)
bot.loadPlugin(jevAgent)

let forced = 0
bot.on('forcedMove', () => {
  forced += 1
})

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function vec(p: Vec3Json): ReturnType<typeof bot.entity.position.clone> {
  return bot.entity.position.clone().set(p.x, p.y, p.z)
}

function pos(): Vec3Json {
  const p = bot.entity.position
  return { x: p.x, y: p.y, z: p.z }
}

function solid(p: Vec3Json): boolean {
  const block = bot.blockAt(vec(p))
  return block !== null && block.boundingBox === 'block'
}

function passable(p: Vec3Json): boolean {
  const block = bot.blockAt(vec(p))
  return block !== null && block.boundingBox === 'empty'
}

async function digBlockAt(blockPos: Vec3Json): Promise<boolean> {
  const block = bot.blockAt(vec(blockPos))
  if (block === null || block.boundingBox !== 'block' || !bot.canDigBlock(block)) return false
  await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true)
  await bot.dig(block).catch(() => undefined)
  await sleep(1000)
  return !solid(blockPos)
}

function findFlatPit(bx: number, by: number, bz: number): { support: Vec3Json; feet: Vec3Json } | null {
  for (const [dx, dz] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ]) {
    const mx = bx + (dx ?? 0)
    const mz = bz + (dz ?? 0)
    const cx = bx + 2 * (dx ?? 0)
    const cz = bz + 2 * (dz ?? 0)
    if (!solid({ x: mx, y: by - 1, z: mz })) continue
    if (!passable({ x: mx, y: by, z: mz }) || !passable({ x: mx, y: by + 1, z: mz })) continue
    if (!solid({ x: cx, y: by - 1, z: cz }) || !solid({ x: cx, y: by - 2, z: cz })) continue
    if (!passable({ x: cx, y: by, z: cz }) || !passable({ x: cx, y: by + 1, z: cz })) continue
    return { support: { x: cx, y: by - 1, z: cz }, feet: { x: cx, y: by - 1, z: cz } }
  }
  return null
}

function pathClear(bx: number, by: number, bz: number, cx: number, cz: number): boolean {
  const steps = Math.max(Math.abs(cx - bx), Math.abs(cz - bz))
  for (let i = 1; i < steps; i += 1) {
    const x = Math.round(bx + ((cx - bx) * i) / steps)
    const z = Math.round(bz + ((cz - bz) * i) / steps)
    if (!solid({ x, y: by - 1, z })) return false
    if (!passable({ x, y: by, z })) return false
    if (!passable({ x, y: by + 1, z })) return false
  }
  return true
}

async function placeStep(by: number): Promise<Vec3Json | null> {
  const item = bot.inventory.items().find((entry) => PLACEABLE.test(entry.name))
  if (item === undefined) return null
  const p = pos()
  const bx = Math.floor(p.x)
  const bz = Math.floor(p.z)
  for (const [dx, dz] of [
    [2, 0],
    [-2, 0],
    [0, 2],
    [0, -2],
    [3, 0],
    [-3, 0],
    [0, 3],
    [0, -3],
  ]) {
    const cx = bx + (dx ?? 0)
    const cz = bz + (dz ?? 0)
    if (!pathClear(bx, by, bz, cx, cz)) continue
    if (!solid({ x: cx, y: by - 1, z: cz })) continue
    if (!passable({ x: cx, y: by, z: cz }) || !passable({ x: cx, y: by + 1, z: cz })) continue
    const reference = bot.blockAt(vec({ x: cx, y: by - 1, z: cz }))
    if (reference === null) continue
    try {
      await bot.equip(item, 'hand')
      await bot.lookAt(vec({ x: cx, y: by, z: cz }).offset(0.5, 0.5, 0.5), true)
      await bot.placeBlock(reference, bot.entity.position.clone().set(0, 1, 0))
      await sleep(800)
      if (solid({ x: cx, y: by, z: cz })) return { x: cx, y: by + 1, z: cz }
    } catch {
      continue
    }
  }
  return null
}

function moveCandidate(id: string, target: Vec3Json): Candidate {
  return {
    id,
    kind: 'MOVE',
    label: `verify ${id} -> (${target.x},${target.y},${target.z})`,
    targetName: null,
    target,
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: false,
    hasStandableAdjacent: true,
    meta: { tick: 1 },
  }
}

interface MoveEvidence {
  status: string
  failure: string | null
  verified: boolean
  start: Vec3Json
  end: Vec3Json
  climbed: number
  forcedRepositions: number
  stalled: boolean
  detail: string
}

async function runMove(label: string, candidate: Candidate): Promise<MoveEvidence> {
  const start = pos()
  const forcedBefore = forced
  const claim = bot.jev.agent.claim(candidate)
  const result = await claim.completion
  await sleep(1200)
  const end = pos()
  const evidence: MoveEvidence = {
    status: result.status,
    failure: result.failure,
    verified: result.verified,
    start,
    end,
    climbed: Number((end.y - start.y).toFixed(2)),
    forcedRepositions: forced - forcedBefore,
    stalled: result.failure === 'path_stuck' || result.detail.includes('packet locomotion blocked'),
    detail: result.detail,
  }
  process.stdout.write(
    `[verify] ${label} status=${evidence.status} failure=${evidence.failure ?? 'none'} verified=${evidence.verified} ` +
      `start=(${start.x.toFixed(2)},${start.y.toFixed(2)},${start.z.toFixed(2)}) ` +
      `end=(${end.x.toFixed(2)},${end.y.toFixed(2)},${end.z.toFixed(2)}) climbed=${evidence.climbed}m ` +
      `forcedRepositions=${evidence.forcedRepositions} path_stuck=${evidence.stalled}\n`,
  )
  process.stdout.write(`[verify] ${label} detail=${evidence.detail}\n`)
  return evidence
}

function printExecutorLines(): void {
  try {
    const lines = readFileSync(join(logDir, 'run.jsonl'), 'utf8').trim().split('\n')
    for (const line of lines) {
      if (line.includes('control locomotion arrival') || line.includes('control locomotion budget')) {
        process.stdout.write(`[verify] ${line}\n`)
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stdout.write(`[verify] could not read ${logDir}/run.jsonl: ${message}\n`)
  }
}

bot.once('spawn', async () => {
  try {
    bot.jev.setOptions({
      goalItem: 'oak_log',
      goalCount: 1,
      logDir,
      reach: 5,
      actuation: 'packet',
      verbose: true,
      heartbeatMs: 3000,
    })
    await sleep(9000)

    const spawn = pos()
    const bx = Math.floor(spawn.x)
    const by = Math.round(spawn.y)
    const bz = Math.floor(spawn.z)
    process.stdout.write(`[verify] spawn=(${bx},${by},${bz})\n`)

    const pit = findFlatPit(bx, by, bz)
    process.stdout.write(`[verify] flat pit=${pit === null ? 'none' : JSON.stringify(pit)}\n`)
    if (pit !== null) {
      const dug = await digBlockAt(pit.support)
      process.stdout.write(`[verify] dug pit=${dug} now=${JSON.stringify(pos())}\n`)
      if (dug) {
        const entered = await runMove('pit-enter', moveCandidate('MOVE:verify_pit_in', pit.feet))
        const rim: Vec3Json = { x: bx, y: by, z: bz }
        let escaped = await runMove('pit-escape', moveCandidate('MOVE:verify_pit_out', rim))
        if (Math.round(escaped.end.y) !== by) {
          escaped = await runMove('pit-escape-retry', moveCandidate('MOVE:verify_pit_out2', rim))
        }
        process.stdout.write(
          `[verify] pit-escape RESULT in=${entered.end.y.toFixed(2)} out=${escaped.end.y.toFixed(2)} ` +
            `climbed=${escaped.climbed} expected=1 stalled=${escaped.stalled}\n`,
        )
      }
    }

    await sleep(1500)
    const inventory = bot.inventory.items().map((entry) => `${entry.name}x${entry.count}`)
    process.stdout.write(`[verify] inventory=${JSON.stringify(inventory)}\n`)
    const step = await placeStep(Math.round(pos().y))
    process.stdout.write(`[verify] placed step=${step === null ? 'none' : JSON.stringify(step)}\n`)
    if (step !== null) {
      const climbed = await runMove('step-climb', moveCandidate('MOVE:verify_step', step))
      process.stdout.write(`[verify] step-climb RESULT climbed=${climbed.climbed} expected=1 stalled=${climbed.stalled}\n`)
    }

    printExecutorLines()
    process.stdout.write(`[verify] done forcedRepositionsTotal=${forced}\n`)
    bot.quit('verify done')
    setTimeout(() => process.exit(0), 700)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stdout.write(`[verify] failed: ${message}\n`)
    bot.quit('verify failed')
    setTimeout(() => process.exit(1), 700)
  }
})

bot.on('error', (error) => {
  process.stdout.write(`[verify] error: ${error.message}\n`)
})
bot.on('kicked', (reason) => {
  process.stdout.write(`[verify] kicked: ${JSON.stringify(reason)}\n`)
})

setTimeout(() => {
  process.stdout.write('[verify] hard timeout\n')
  process.exit(2)
}, 150000)
