// movement-patch-test.mts - harness-level verification of the LOCAL mineflayer
// locomotion patch (patches/mineflayer-4.39.0-locomotion.patch), bare mineflayer
// only, no agent loop:
//
//   1. a natural 1-block STEP (the M1 blocker),
//   2. a natural 1-block PIT,
//   3. a ~26 m flat target (the M1 cobblestone leg that used to wedge).
//
// For each it quotes reached, dy, moved, pathfinder events and the
// `forcedRepositions` counter, plus the server's authoritative view of the
// walker read by a second observer bot.
//
// Run: npx tsx movement-patch-test.mts [--username AI_MVX] [--seconds 90]
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import mineflayer from 'mineflayer'
import pathfinderModule from 'mineflayer-pathfinder'

const { Movements, goals } = pathfinderModule

function opt(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback)
}

const username = opt('username', 'AI_MVX')
const observerName = opt('observer', 'AIMVobs')
const host = opt('host', '127.0.0.1')
const port = Number(opt('port', '25565'))
const seconds = Number(opt('seconds', '110'))

const walker = mineflayer.createBot({ host, port, username, auth: 'offline' })
walker.loadPlugin(pathfinderModule.pathfinder)
const observer = mineflayer.createBot({ host, port, username: observerName, auth: 'offline' })

let forced = 0
walker.on('forcedMove', () => {
  forced += 1
})
const events: string[] = []
walker.on('path_update', (r: { status?: string; path?: unknown[] }) =>
  events.push(`path_update status=${r.status ?? '?'} nodes=${Array.isArray(r.path) ? r.path.length : 0}`),
)
walker.on('path_reset', (reason: string) => events.push(`path_reset reason=${reason}`))
walker.on('goal_reached', () => events.push('goal_reached'))

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const fmt = (p: { x: number; y: number; z: number }): string =>
  `(${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)})`

function serverPos(): string {
  const entity = observer.players[username]?.entity as { position?: { x: number; y: number; z: number } } | undefined
  const p = entity?.position
  return p === undefined ? 'n/a' : fmt(p)
}

function cell(x: number, y: number, z: number): { boundingBox?: string; name?: string } | null {
  return walker.blockAt(walker.entity.position.clone().set(x, y, z)) as unknown as
    | { boundingBox?: string; name?: string }
    | null
}
const passable = (x: number, y: number, z: number): boolean => {
  const b = cell(x, y, z)
  return b === null || b.boundingBox === 'empty'
}
const solid = (x: number, y: number, z: number): boolean => {
  const b = cell(x, y, z)
  return b !== null && b.boundingBox === 'block'
}
const standable = (x: number, y: number, z: number): boolean =>
  passable(x, y, z) && passable(x, y + 1, z) && solid(x, y - 1, z)

const DIRS: Array<[number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
]

interface Spot {
  x: number
  y: number
  z: number
}

function findStep(fx: number, feetY: number, fz: number): Spot | null {
  for (let r = 2; r <= 8; r += 1) {
    for (const [dx, dz] of DIRS) {
      const x = fx + dx * r
      const z = fz + dz * r
      if (standable(x, feetY + 1, z)) return { x, y: feetY + 1, z }
    }
  }
  return null
}

function findPit(fx: number, feetY: number, fz: number): Spot | null {
  for (let r = 2; r <= 8; r += 1) {
    for (const [dx, dz] of DIRS) {
      const x = fx + dx * r
      const z = fz + dz * r
      if (standable(x, feetY - 1, z)) return { x, y: feetY - 1, z }
    }
  }
  return null
}

/** A flat, standable, same-level target 24-30 m away with a planner path. */
function findFar(fx: number, feetY: number, fz: number): { spot: Spot; dist: number } | null {
  for (let r = 30; r >= 24; r -= 1) {
    for (const [dx, dz] of DIRS) {
      const x = fx + dx * r
      const z = fz + dz * r
      if (!standable(x, feetY, z)) continue
      const plan = walker.pathfinder.getPathTo(
        walker.pathfinder.movements,
        new goals.GoalBlock(x, feetY, z),
        2500,
      )
      if (plan.status === 'noPath') continue
      return { spot: { x, y: feetY, z }, dist: Math.hypot(x - fx, z - fz) }
    }
  }
  return null
}

interface Outcome {
  reached: boolean
  dy: number
  moved: number
  forced: number
  events: string[]
  start: string
  end: string
  serverEnd: string
  ms: number
}

async function walk(label: string, goal: Spot, budgetMs: number): Promise<Outcome> {
  const start = walker.entity.position.clone()
  const forcedBefore = forced
  const eventBefore = events.length
  const t0 = Date.now()
  const serverBefore = serverPos()
  let reached = false
  try {
    reached = await Promise.race([
      walker.pathfinder.goto(new goals.GoalBlock(goal.x, goal.y, goal.z)).then(() => true),
      sleep(budgetMs).then(() => {
        walker.pathfinder.setGoal(null)
        walker.pathfinder.stop()
        return false
      }),
    ])
  } catch (error) {
    events.push(`goto error: ${error instanceof Error ? error.message : String(error)}`)
  }
  const end = walker.entity.position.clone()
  const outcome: Outcome = {
    reached,
    dy: +(end.y - start.y).toFixed(2),
    moved: +start.distanceTo(end).toFixed(2),
    forced: forced - forcedBefore,
    events: events.slice(eventBefore),
    start: fmt(start),
    end: fmt(end),
    serverEnd: serverPos(),
    ms: Date.now() - t0,
  }
  console.log(
    `[mv] ${label} reached=${outcome.reached} ms=${outcome.ms} start=${outcome.start} end=${outcome.end} ` +
      `moved=${outcome.moved}m dy=${outcome.dy} forcedRepositions=${outcome.forced} ` +
      `serverBefore=${serverBefore} serverAfter=${outcome.serverEnd}`,
  )
  for (const event of outcome.events) console.log(`[mv]   ${label} :: ${event}`)
  return outcome
}

let failures = 0

async function run(): Promise<void> {
  await sleep(9000)
  forced = 0
  const feet = walker.entity.position
  const fx = Math.floor(feet.x)
  const feetY = Math.floor(feet.y)
  const fz = Math.floor(feet.z)
  console.log(
    `[mv] user=${username} feet=(${feet.x.toFixed(2)},${feet.y.toFixed(2)},${feet.z.toFixed(2)}) onGround=${walker.entity.onGround} patch=${patchMarker()}`,
  )
  console.log(`[mv] observer=${observerName} sees walker at ${serverPos()}`)

  const movements = new Movements(walker)
  movements.canDig = false
  movements.scafoldingBlocks = []
  movements.allowParkour = false
  movements.allow1by1towers = false
  movements.allowFreeMotion = false
  movements.maxDropDown = 4
  walker.pathfinder.setMovements(movements)

  const step = findStep(fx, feetY, fz)
  const pit = findPit(fx, feetY, fz)
  const far = findFar(fx, feetY, fz)
  console.log(
    `[mv] features step=${step === null ? 'none' : fmt(step)} pit=${pit === null ? 'none' : fmt(pit)} ` +
      `far=${far === null ? 'none' : `${fmt(far.spot)} d=${far.dist.toFixed(1)}m`}`,
  )

  const results: Array<{ label: string; outcome: Outcome }> = []
  if (step !== null) results.push({ label: 'step-1block', outcome: await walk('step-1block', step, 20000) })
  else {
    failures += 1
    console.log('[mv] FAIL no natural 1-block step found')
  }
  // return toward the start column between features so each attempt is isolated
  const home = { x: fx, y: feetY, z: fz }
  results.push({ label: 'pit-1block', outcome: await walk('pit-1block', pit ?? home, 20000) })
  if (far !== null) {
    await walk('return-home', home, 25000)
    results.push({ label: 'far-26m', outcome: await walk('far-26m', far.spot, 30000) })
  } else {
    failures += 1
    console.log('[mv] FAIL no reachable ~26 m flat target found')
  }

  for (const { label, outcome } of results) {
    const stuck = outcome.events.some((e) => e.includes('path_reset') && e.includes('stuck'))
    if (!outcome.reached || stuck || outcome.forced > 20) failures += 1
    console.log(
      `[mv] CHECK ${label} reached=${outcome.reached} path_reset_stuck=${stuck} forcedRepositions=${outcome.forced} ` +
        `-> ${!outcome.reached || stuck || outcome.forced > 20 ? 'FAIL' : 'PASS'}`,
    )
  }

  console.log(`[mv] final server-side walker position = ${serverPos()}`)
  console.log(`[mv] RESULT ${failures === 0 ? 'PASS' : 'FAIL'} failures=${failures}`)
  walker.quit('done')
  observer.quit('done')
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 700)
}

function patchMarker(): string {
  // Report the actual on-disk state of the patched file so the run is
  // self-describing (and a stock checkout is obvious in the log).
  try {
    const physics = readFileSync(join(process.cwd(), 'node_modules/mineflayer/lib/plugins/physics.js'), 'utf8')
    const reply = physics.includes('function sendTeleportReply (')
    const threshold = physics.includes('> 4e-8 || positionReminder >= 20')
    return `teleportReply=${reply} vanillaThreshold=${threshold}`
  } catch {
    return 'physics.js unreadable'
  }
}

walker.once('spawn', () => {
  void run().catch((error: unknown) => {
    console.log(`[mv] run failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
})
walker.on('error', (e) => console.log(`[mv] error ${e instanceof Error ? e.message : String(e)}`))
walker.on('kicked', (r) => console.log(`[mv] kicked ${JSON.stringify(r)}`))
observer.on('error', (e) => console.log(`[mv] observer error ${e instanceof Error ? e.message : String(e)}`))

setTimeout(() => {
  console.log('[mv] hard timeout')
  process.exit(1)
}, (seconds + 15) * 1000)
