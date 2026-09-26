// movement-agent-test.mts - AGENT-LEVEL vertical-movement proof.
//
// Unlike mcbot/movement-test/vertical.mjs (a bare-Mineflayer harness), this
// drives the jev-agent Executor's own MOVE action (runMove -> walkByControls)
// and records the y-coordinate progression while it escapes a 1-deep pit and
// climbs a 1-block step. It is the evidence that the ported recipe works inside
// the agent, not just in the harness.
//
// Run: bun movement-agent-test.mts --username AI_V1b
import mineflayer from 'mineflayer'
import pathfinderModule from 'mineflayer-pathfinder'
import { Executor, EventLogger, defaultExecutorOptions } from './src/index.ts'
import type { Candidate, Vec3Json } from './src/index.ts'
import { forcedMoveTracker } from './src/executor.ts'
import { fixtureClaim } from './test-claim-context.mts'

function opt(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`)
  const value = index === -1 ? undefined : process.argv[index + 1]
  return value ?? fallback
}

const username = opt('username', 'AI_V1b')
const host = opt('host', '127.0.0.1')
const port = Number(opt('port', '25565'))

const bot = mineflayer.createBot({ host, port, username, auth: 'offline' })
bot.loadPlugin(pathfinderModule.pathfinder)

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const vec = (x: number, y: number, z: number): Vec3Json => ({ x, y, z })

function feet(): { x: number; y: number; z: number } {
  const p = bot.entity.position
  return { x: p.x, y: p.y, z: p.z }
}

function collidedHorizontally(): boolean {
  const entity = bot.entity as unknown as { isCollidedHorizontally?: boolean }
  return entity.isCollidedHorizontally === true
}

function passableAt(x: number, y: number, z: number): boolean {
  const block = bot.blockAt(bot.entity.position.clone().set(x, y, z))
  return block === null || block.boundingBox === 'empty'
}

function solidSupportAt(x: number, y: number, z: number): boolean {
  const block = bot.blockAt(bot.entity.position.clone().set(x, y, z))
  return block !== null && block.boundingBox === 'block'
}

function makeMoveCandidate(id: string, spot: Vec3Json, anchor: Vec3Json | null): Candidate {
  const meta: Record<string, string | number | boolean> = { tick: 1, x: spot.x, y: spot.y, z: spot.z }
  if (anchor !== null) {
    meta.targetBlockX = anchor.x
    meta.targetBlockY = anchor.y
    meta.targetBlockZ = anchor.z
  }
  return {
    id,
    kind: 'MOVE',
    label: `test walk to (${spot.x},${spot.y},${spot.z})`,
    targetName: anchor === null ? null : 'oak_log',
    target: spot,
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: false,
    hasStandableAdjacent: true,
    meta,
  }
}

interface MoveTrace {
  actionId: string
  startY: number
  endY: number
  maxY: number
  startPos: { x: number; y: number; z: number }
  endPos: { x: number; y: number; z: number }
  moved: number
  samples: Array<{ t: number; x: number; y: number; z: number; onGround: boolean; collH: boolean }>
  status: string
  failure: string | null
  forcedRepositions: number
}

async function runMove(
  executor: Executor,
  candidate: Candidate,
  budgetMs: number,
  label: string,
): Promise<MoveTrace> {
  const tracker = forcedMoveTracker(bot)
  const forcedBefore = tracker.value
  const start = feet()
  const t0 = Date.now()
  const samples: MoveTrace['samples'] = []
  const timer = setInterval(() => {
    const p = feet()
    samples.push({
      t: Date.now() - t0,
      x: Math.round(p.x * 100) / 100,
      y: Math.round(p.y * 100) / 100,
      z: Math.round(p.z * 100) / 100,
      onGround: bot.entity.onGround === true,
      collH: collidedHorizontally(),
    })
  }, 100)
  const claim = fixtureClaim(executor, candidate)
  const result = await Promise.race([
    claim.completion,
    sleep(budgetMs + 4000).then(() => null),
  ])
  clearInterval(timer)
  if (result === null) {
    executor.cancelCurrent('movement-agent-test timeout')
  }
  const end = feet()
  const maxY = samples.reduce((acc, s) => Math.max(acc, s.y), start.y)
  const trace: MoveTrace = {
    actionId: candidate.id,
    startY: start.y,
    endY: end.y,
    maxY,
    startPos: start,
    endPos: end,
    moved: Math.round(Math.hypot(end.x - start.x, end.z - start.z) * 100) / 100,
    samples,
    status: result === null ? 'timeout' : result.status,
    failure: result === null ? 'harness_timeout' : result.failure,
    forcedRepositions: tracker.value - forcedBefore,
  }
  process.stdout.write(
    `[agent-test] ${label} actionId=${trace.actionId} status=${trace.status} failure=${trace.failure} ` +
      `startY=${trace.startY.toFixed(2)} endY=${trace.endY.toFixed(2)} maxY=${trace.maxY.toFixed(2)} ` +
      `rose=${(trace.maxY - trace.startY).toFixed(2)} moved=${trace.moved} forcedRepositions=${trace.forcedRepositions} ` +
      `samples=${samples.length}\n`,
  )
  const stride = samples.filter((_, i) => i % 5 === 0)
  process.stdout.write(
    `[agent-test] ${label} y-progression: ${stride.map((s) => `t=${s.t}ms y=${s.y}`).join(' | ')}\n`,
  )
  return trace
}

async function main(): Promise<void> {
  // settle so the server finishes placing the bot and chunks load
  await sleep(8000)

  const executor = new Executor(bot, new EventLogger(null, true), {
    ...defaultExecutorOptions,
    reach: 4.5,
    actuation: 'pathfinder',
    pathTimeoutMs: 15000,
  })
  executor.ensureMovements()

  const bx = Math.floor(bot.entity.position.x)
  const bz = Math.floor(bot.entity.position.z)
  const surfaceTop = Math.round(bot.entity.position.y) - 1
  process.stdout.write(
    `[agent-test] start feet=${JSON.stringify(feet())} column=(${bx},${surfaceTop},${bz})\n`,
  )

  // Dig every cell that overlaps the bot's AABB at the support level -> a
  // 1-deep pit the bot actually falls into. Escaping it is a 1-block step-up:
  // the exact vertical case the ported recipe must handle. If the saved spawn
  // already sits in a depression, use it instead of digging a deeper one.
  const dugCells: Array<{ x: number; y: number; z: number; name: string }> = []
  const half = 0.3
  const cellsX = Array.from(new Set([Math.floor(feet().x - half), Math.floor(feet().x + half)]))
  const cellsZ = Array.from(new Set([Math.floor(feet().z - half), Math.floor(feet().z + half)]))
  for (const x of cellsX) {
    for (const z of cellsZ) {
      const under = bot.blockAt(bot.entity.position.clone().set(x, surfaceTop, z))
      if (under === null || under.boundingBox === 'empty') continue
      process.stdout.write(`[agent-test] digging 1-deep pit cell: ${under.name} at (${x},${surfaceTop},${z})\n`)
      try {
        await bot.dig(under, 'ignore')
      } catch (error) {
        process.stdout.write(`[agent-test] dig failed: ${error instanceof Error ? error.message : String(error)}\n`)
      }
      dugCells.push({ x, y: surfaceTop, z, name: under.name })
      await sleep(500)
    }
  }
  await sleep(1500)
  process.stdout.write(`[agent-test] dugCells=${JSON.stringify(dugCells)}\n`)
  const pitFeet = feet()
  process.stdout.write(`[agent-test] after dig feet=${JSON.stringify(pitFeet)} inPit=${pitFeet.y < surfaceTop + 1}\n`)

  // Escape target: the column TWO cells out along the lowest-rise lip, so the
  // arrival test cannot be satisfied from the pit floor (tolerance 1.2) and the
  // bot must actually climb the 1-block step to get there.
  const lip = pickEscapeLip(bx, bz, surfaceTop)
  const dirX = Math.sign(lip.x - bx)
  const dirZ = Math.sign(lip.z - bz)
  const beyond =
    surfaceTopAt(lip.x + dirX, lip.z + dirZ, lip.y) !== null
      ? findStandableNear(vec(lip.x + dirX, lip.y, lip.z + dirZ))
      : lip
  const escapedTarget = beyond
  process.stdout.write(
    `[agent-test] escape lip=${JSON.stringify(lip)} target=${JSON.stringify(escapedTarget)} (surfaceTop=${surfaceTop}, pitFeetY=${pitFeet.y})\n`,
  )

  const beforeTracker = forcedMoveTracker(bot).value
  const pitEscape = await runMove(
    executor,
    makeMoveCandidate('MOVE:agent-pit-escape', escapedTarget, null),
    12000,
    'pit-escape',
  )
  const climbedOut = pitEscape.maxY >= pitEscape.startY + 1
  process.stdout.write(
    `[agent-test] pit-escape CLIMB_CHECK rose=${(pitEscape.maxY - pitEscape.startY).toFixed(2)} climbedOut=${climbedOut}\n`,
  )

  // Once out, walk a real horizontal distance to a spot >=2 blocks away with an
  // ANCHOR set to an in-reach block (the exact MOVE:b45_66_-74 shape). Before
  // the fix this "arrived" with moved=0 because the anchor was already within
  // eye-reach; now it must actually travel.
  const clearSpot = pickClearWalkSpot() ?? findStandableNear(vec(bx + 3, surfaceTop + 1, bz + 1))
  const anchorBlockPos = vec(bx, surfaceTop, bz)
  const stepClimb = await runMove(
    executor,
    makeMoveCandidate('MOVE:agent-anchored-walk', clearSpot, anchorBlockPos),
    10000,
    'anchored-walk',
  )

  const totalForced = forcedMoveTracker(bot).value - beforeTracker
  process.stdout.write(
    `[agent-test] SUMMARY climbedOut=${climbedOut} pitEscapeRose=${(pitEscape.maxY - pitEscape.startY).toFixed(2)} ` +
      `pitMoved=${pitEscape.moved} pitForced=${pitEscape.forcedRepositions} ` +
      `walkMoved=${stepClimb.moved} walkRose=${(stepClimb.maxY - stepClimb.startY).toFixed(2)} ` +
      `walkForced=${stepClimb.forcedRepositions} totalForced=${totalForced}\n`,
  )
  process.stdout.write('[agent-test] DONE\n')
}

/** Highest solid surface in a neighbour column, searched around `surfaceTop`. */
function surfaceTopAt(x: number, z: number, surfaceTop: number): number | null {
  for (let y = surfaceTop + 2; y >= surfaceTop - 2; y -= 1) {
    if (solidSupportAt(x, y, z)) return y
  }
  return null
}

/** The lowest-rise adjacent lip that is actually standable (pit escape). */
function pickEscapeLip(bx: number, bz: number, surfaceTop: number): Vec3Json {
  let best: Vec3Json | null = null
  let bestRise = Number.POSITIVE_INFINITY
  for (const [ox, oz] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [-1, 1],
    [1, -1],
    [-1, -1],
  ] as Array<[number, number]>) {
    const top = surfaceTopAt(bx + ox, bz + oz, surfaceTop)
    if (top === null) continue
    const feetY = top + 1
    const rise = feetY - surfaceTop
    if (rise < 1 || rise > 2) continue
    if (!passableAt(bx + ox, feetY, bz + oz) || !passableAt(bx + ox, feetY + 1, bz + oz)) continue
    if (rise < bestRise) {
      bestRise = rise
      best = vec(bx + ox, feetY, bz + oz)
    }
  }
  return best ?? vec(bx + 1, surfaceTop + 1, bz)
}

/** Nearest standable column (feet + head passable, solid below) to `around`, same level first. */
function findStandableNear(around: Vec3Json): Vec3Json {
  for (let radius = 0; radius <= 5; radius += 1) {
    for (const dy of [0, 1, -1, 2, -2, 3, -3]) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        for (let dz = -radius; dz <= radius; dz += 1) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue
          const feetPos = { x: around.x + dx, y: around.y + dy, z: around.z + dz }
          if (!passableAt(feetPos.x, feetPos.y, feetPos.z)) continue
          if (!passableAt(feetPos.x, feetPos.y + 1, feetPos.z)) continue
          if (!solidSupportAt(feetPos.x, feetPos.y - 1, feetPos.z)) continue
          return feetPos
        }
      }
    }
  }
  return around
}

/** A same-level spot 3 blocks away with a clear straight standable run. */
function pickClearWalkSpot(): Vec3Json | null {
  const p = feet()
  const y = Math.round(p.y)
  for (const [dx, dz] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as Array<[number, number]>) {
    let clear = true
    for (let step = 1; step <= 3; step += 1) {
      const x = Math.floor(p.x) + dx * step
      const z = Math.floor(p.z) + dz * step
      if (!passableAt(x, y, z) || !passableAt(x, y + 1, z) || !solidSupportAt(x, y - 1, z)) {
        clear = false
        break
      }
    }
    if (clear) return { x: Math.floor(p.x) + dx * 3, y, z: Math.floor(p.z) + dz * 3 }
  }
  return null
}

bot.on('error', (error) => {
  process.stdout.write(`[agent-test] error: ${error.message}\n`)
})
bot.on('kicked', (reason) => {
  process.stdout.write(`[agent-test] kicked: ${JSON.stringify(reason)}\n`)
})

bot.once('spawn', () => {
  main()
    .then(() => {
      bot.quit('agent-test done')
      setTimeout(() => process.exit(0), 1000)
    })
    .catch((error: unknown) => {
      process.stdout.write(`[agent-test] FATAL: ${error instanceof Error ? error.message : String(error)}\n`)
      bot.quit('agent-test failed')
      setTimeout(() => process.exit(1), 1000)
    })
})

setTimeout(() => {
  process.stdout.write('[agent-test] hard timeout\n')
  process.exit(1)
}, 120000)
