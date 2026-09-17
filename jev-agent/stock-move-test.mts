// stock-move-test.mts - live proof that the STOCK mineflayer-pathfinder can drive
// MOVE on this Leaf 26.1 server (collision shapes exist in minecraft-data 26.1).
//
// It connects offline, configures Movements with canDig=false, locates a natural
// 1-block step and a natural 1-block pit near spawn, and walks each with
// `bot.pathfinder.setGoal(new goals.GoalBlock(...))` ONLY - no control-state
// actuator, no position_look packets. It quotes the pathfinder events, the
// position deltas and the server forcedMove (rubber-band) count.
//
// Run: npx tsx stock-move-test.mts [--username AI_R2] [--seconds 60]
import mineflayer from 'mineflayer'
import pathfinderModule from 'mineflayer-pathfinder'

const { Movements, goals } = pathfinderModule

function opt(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`)
  const value = index === -1 ? undefined : process.argv[index + 1]
  return value ?? fallback
}

const username = opt('username', 'AI_R2')
const seconds = Number(opt('seconds', '75'))
const host = opt('host', '127.0.0.1')
const port = Number(opt('port', '25565'))

const bot = mineflayer.createBot({ host, port, username, auth: 'offline' })
bot.loadPlugin(pathfinderModule.pathfinder)

let forcedMoves = 0
bot.on('forcedMove', () => {
  forcedMoves += 1
})

const pathEvents: string[] = []
bot.on('goal_reached', () => pathEvents.push(`goal_reached forcedMoves=${forcedMoves}`))
bot.on('path_update', (r: { status?: string; path?: unknown[] }) => {
  pathEvents.push(`path_update status=${r.status ?? '?'} nodes=${Array.isArray(r.path) ? r.path.length : 0}`)
})
bot.on('path_reset', (reason: string) => pathEvents.push(`path_reset reason=${reason}`))

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

let movementsMode = 'base'

function applyMovements(mode: string): void {
  movementsMode = mode
  const movements = new Movements(bot)
  movements.canDig = false
  movements.scafoldingBlocks = []
  movements.allowParkour = mode === 'parkour'
  movements.allow1by1towers = mode === 'tower'
  movements.allowFreeMotion = false
  movements.maxDropDown = 4
  movements.infiniteLiquidDropdownDistance = false
  bot.pathfinder.setMovements(movements)
}

function blockAtCell(x: number, y: number, z: number): { boundingBox?: string; name?: string } | null {
  return bot.blockAt(bot.entity.position.clone().set(x, y, z)) as unknown as { boundingBox?: string; name?: string } | null
}

function passable(x: number, y: number, z: number): boolean {
  const b = blockAtCell(x, y, z)
  return b === null || b.boundingBox === 'empty'
}
function solid(x: number, y: number, z: number): boolean {
  const b = blockAtCell(x, y, z)
  return b !== null && b.boundingBox === 'block'
}
function standable(x: number, y: number, z: number): boolean {
  return passable(x, y, z) && passable(x, y + 1, z) && solid(x, y - 1, z)
}

interface Feature {
  kind: 'step' | 'pit'
  goal: { x: number; y: number; z: number }
  approach: { x: number; y: number; z: number }
  detail: string
}

const DIRS: Array<{ dx: number; dz: number }> = [
  { dx: 1, dz: 0 },
  { dx: -1, dz: 0 },
  { dx: 0, dz: 1 },
  { dx: 0, dz: -1 },
  { dx: 1, dz: 1 },
  { dx: 1, dz: -1 },
  { dx: -1, dz: 1 },
  { dx: -1, dz: -1 },
]

/**
 * Find a 1-block step up: a standable cell exactly one level above the feet,
 * with a same-level continuation beyond when one exists. The raised cell itself
 * is the minimum valid step (the stock pathfinder must jump/climb onto it).
 */
function findStep(fx: number, feetY: number, fz: number): Feature | null {
  for (let r = 2; r <= 8; r += 1) {
    for (const dir of DIRS) {
      const ax = fx + dir.dx * r
      const az = fz + dir.dz * r
      const y = feetY + 1
      if (!standable(ax, y, az)) continue
      const bx = ax + dir.dx
      const bz = az + dir.dz
      const goal = standable(bx, y, bz) ? { x: bx, y, z: bz } : { x: ax, y, z: az }
      return {
        kind: 'step',
        goal,
        approach: { x: fx, y: feetY, z: fz },
        detail: `rise=${y - feetY} at (${ax},${y},${az}) goal=(${goal.x},${goal.y},${goal.z})`,
      }
    }
  }
  return null
}

/** Find a 1-block pit: two consecutive standable cells one level below the feet. */
function findPit(fx: number, feetY: number, fz: number): Feature | null {
  for (let r = 2; r <= 8; r += 1) {
    for (const dir of DIRS) {
      const ax = fx + dir.dx * r
      const az = fz + dir.dz * r
      const y = feetY - 1
      if (!standable(ax, y, az)) continue
      const bx = ax + dir.dx
      const bz = az + dir.dz
      if (!standable(bx, y, bz)) continue
      return {
        kind: 'pit',
        goal: { x: bx, y, z: bz },
        approach: { x: ax, y, z: az },
        detail: `drop=${feetY - y} at (${ax},${y},${az})`,
      }
    }
  }
  return null
}

interface WalkOutcome {
  reached: boolean
  events: string[]
  moved: number
  start: string
  end: string
  forced: number
  ms: number
}

async function walkTo(feature: Feature, budgetMs: number): Promise<WalkOutcome> {
  const start = bot.entity.position.clone()
  const forcedBefore = forcedMoves
  const eventsBefore = pathEvents.length
  const t0 = Date.now()
  let reached = false
  try {
    reached = await Promise.race([
      bot.pathfinder.goto(new goals.GoalBlock(feature.goal.x, feature.goal.y, feature.goal.z)).then(() => true),
      sleep(budgetMs).then(() => {
        bot.pathfinder.setGoal(null)
        bot.pathfinder.stop()
        return false
      }),
    ])
    if (!reached) events.push(`goto timeout after ${budgetMs}ms`)
  } catch (error) {
    events.push(`goto error: ${error instanceof Error ? error.message : String(error)}`)
  }
  const end = bot.entity.position.clone()
  return {
    reached,
    events: pathEvents.slice(eventsBefore),
    moved: +start.distanceTo(end).toFixed(3),
    start: `(${start.x.toFixed(2)},${start.y.toFixed(2)},${start.z.toFixed(2)})`,
    end: `(${end.x.toFixed(2)},${end.y.toFixed(2)},${end.z.toFixed(2)})`,
    forced: forcedMoves - forcedBefore,
    ms: Date.now() - t0,
  }
}

const events: string[] = []
let failures = 0

async function run(): Promise<void> {
  await sleep(8000)
  const connectForced = forcedMoves
  forcedMoves = 0
  console.log(`[stock] connect forcedRepositions=${connectForced} (baseline reset; spawn placement is not locomotion)`)
  const feet = bot.entity.position
  console.log(
    `[stock] user=${username} feet=(${feet.x.toFixed(2)},${feet.y.toFixed(2)},${feet.z.toFixed(2)}) onGround=${bot.entity.onGround}`,
  )

  const fx = Math.floor(feet.x)
  const feetY = Math.floor(feet.y)
  const fz = Math.floor(feet.z)

  const step = findStep(fx, feetY, fz)
  const pit = findPit(fx, feetY, fz)
  console.log(`[stock] natural step=${step === null ? 'none' : step.detail} pit=${pit === null ? 'none' : pit.detail}`)
  console.log(`[stock] stepGoal=${step === null ? '-' : JSON.stringify(step.goal)} pitGoal=${pit === null ? '-' : JSON.stringify(pit.goal)}`)

  for (const feature of [step, pit]) {
    if (feature === null) {
      failures += 1
      console.log(`[stock] FAIL no natural ${feature === step ? 'step' : 'pit'} feature found near spawn`)
      continue
    }
    for (const mode of ['base', 'parkour', 'tower']) {
      applyMovements(mode)
      // walk back to a known stance then attempt
      const outcome = await walkTo(feature, 6000)
      const label = `${feature.kind}/${mode}`
      console.log(
        `[stock] ${label} reached=${outcome.reached} ms=${outcome.ms} start=${outcome.start} end=${outcome.end} moved=${outcome.moved}m forcedRepositions=${outcome.forced}`,
      )
      for (const event of outcome.events) console.log(`[stock]   ${label} :: ${event}`)
      if (!outcome.reached) failures += 1
      // separate the attempts so each starts from the same side of the feature
      await Promise.race([
        bot.pathfinder
          .goto(new goals.GoalBlock(feature.approach.x, feature.approach.y, feature.approach.z))
          .catch(() => undefined),
        sleep(8000).then(() => {
          bot.pathfinder.setGoal(null)
          bot.pathfinder.stop()
        }),
      ])
      await sleep(300)
    }
  }

  console.log(`[stock] total forcedRepositions=${forcedMoves}`)
  console.log(`[stock] RESULT ${failures === 0 ? 'PASS' : 'FAIL'} failures=${failures}`)
  bot.quit('stock move test done')
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 500)
}

bot.once('spawn', () => {
  void run().catch((error: unknown) => {
    console.log(`[stock] run failed: ${error instanceof Error ? error.message : String(error)}`)
    bot.quit('failed')
    setTimeout(() => process.exit(1), 500)
  })
})

bot.on('error', (error) => console.log(`[stock] error ${error instanceof Error ? error.message : String(error)}`))
bot.on('kicked', (reason) => console.log(`[stock] kicked ${JSON.stringify(reason)}`))

setTimeout(() => {
  console.log('[stock] hard timeout')
  process.exit(1)
}, (seconds + 10) * 1000)
