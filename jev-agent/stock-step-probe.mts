// stock-step-probe.mts - isolate WHY the stock pathfinder cannot climb a 1-block
// step on this Leaf server: is it pathfinder planning, Mineflayer physics, or the
// server rejecting the jump+forward contact?
//
// Run: npx tsx stock-step-probe.mts [--username AI_R2S2]
import mineflayer from 'mineflayer'
import pathfinderModule from 'mineflayer-pathfinder'

const { Movements, goals } = pathfinderModule
function opt(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback)
}
const username = opt('username', 'AI_R2S2')
const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username, auth: 'offline' })
bot.loadPlugin(pathfinderModule.pathfinder)

let forced = 0
bot.on('forcedMove', () => {
  forced += 1
})
const events: string[] = []
bot.on('path_update', (r: { status?: string }) => events.push(`path_update status=${r.status ?? '?'}`))
bot.on('path_reset', (reason: string) => events.push(`path_reset reason=${reason}`))
bot.on('goal_reached', () => events.push('goal_reached'))

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const pos = (): string => {
  const p = bot.entity.position
  return `(${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)})`
}
function cell(x: number, y: number, z: number): { boundingBox?: string; name?: string } | null {
  return bot.blockAt(bot.entity.position.clone().set(x, y, z)) as unknown as { boundingBox?: string; name?: string } | null
}
const passable = (x: number, y: number, z: number): boolean => {
  const b = cell(x, y, z)
  return b === null || b.boundingBox === 'empty'
}
const solid = (x: number, y: number, z: number): boolean => {
  const b = cell(x, y, z)
  return b !== null && b.boundingBox === 'block'
}
const standable = (x: number, y: number, z: number): boolean => passable(x, y, z) && passable(x, y + 1, z) && solid(x, y - 1, z)

interface Step {
  x: number
  y: number
  z: number
}
function findStep(fx: number, feetY: number, fz: number): Step | null {
  for (let r = 2; r <= 6; r += 1) {
    for (const d of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ]) {
      const x = fx + (d[0] ?? 0) * r
      const z = fz + (d[1] ?? 0) * r
      if (standable(x, feetY + 1, z)) return { x, y: feetY + 1, z }
    }
  }
  return null
}

function physicsTickForceGround(): void {
  const below = bot.blockAt(bot.entity.position.offset(0, -0.1, 0))
  if (below !== null && below.boundingBox === 'block') bot.entity.onGround = true
}

async function manualClimb(step: Step, forceGround: boolean): Promise<void> {
  forced = 0
  events.length = 0
  const start = bot.entity.position.clone()
  const handler = (): void => {
    if (forceGround) physicsTickForceGround()
  }
  if (forceGround) bot.on('physicsTick', handler)
  try {
    const target = bot.entity.position.clone().set(step.x + 0.5, step.y, step.z + 0.5)
    await bot.lookAt(target, true).catch(() => undefined)
    for (let i = 0; i < 30; i += 1) {
      bot.setControlState('forward', true)
      if (i < 14) bot.setControlState('jump', true)
      else bot.setControlState('jump', false)
      await sleep(50)
    }
  } finally {
    bot.setControlState('forward', false)
    bot.setControlState('jump', false)
    if (forceGround) bot.removeListener('physicsTick', handler)
  }
  const end = bot.entity.position
  console.log(
    `[probe] manualClimb forceGround=${forceGround} start=${fmt(start)} end=${fmt(end)} moved=${start.distanceTo(end).toFixed(3)} dy=${(end.y - start.y).toFixed(2)} forced=${forced}`,
  )
}

function fmt(p: { x: number; y: number; z: number }): string {
  return `(${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)})`
}

async function run(): Promise<void> {
  await sleep(8000)
  forced = 0
  const feet = bot.entity.position
  console.log(`[probe] user=${username} feet=${fmt(feet)} onGround=${bot.entity.onGround}`)
  const step = findStep(Math.floor(feet.x), Math.floor(feet.y), Math.floor(feet.z))
  if (step === null) {
    console.log('[probe] no step found')
    bot.quit('none')
    setTimeout(() => process.exit(1), 500)
    return
  }
  const below = cell(step.x, step.y - 1, step.z)
  console.log(`[probe] step goal=(${step.x},${step.y},${step.z}) stepBlock=${below?.name ?? '?'} headroom(y+1..2)=${passable(step.x, step.y, step.z)},${passable(step.x, step.y + 1, step.z)}`)

  const base = new Movements(bot)
  base.canDig = false
  base.scafoldingBlocks = []
  base.allowParkour = false
  base.allow1by1towers = false
  base.maxDropDown = 4
  bot.pathfinder.setMovements(base)

  const plan = bot.pathfinder.getPathTo(base, new goals.GoalBlock(step.x, step.y, step.z), 2500)
  console.log(`[probe] getPathTo status=${plan.status} nodes=${plan.path?.length ?? 0} ${(plan.path ?? []).map((n) => `(${n.x},${n.y},${n.z})`).join('->')}`)

  forced = 0
  events.length = 0
  const s0 = bot.entity.position.clone()
  const reached = await Promise.race([
    bot.pathfinder.goto(new goals.GoalBlock(step.x, step.y, step.z)).then(() => true),
    sleep(9000).then(() => {
      bot.pathfinder.setGoal(null)
      bot.pathfinder.stop()
      return false
    }),
  ])
  const e0 = bot.entity.position
  console.log(`[probe] STOCK goto reached=${reached} start=${fmt(s0)} end=${fmt(e0)} moved=${s0.distanceTo(e0).toFixed(3)} dy=${(e0.y - s0.y).toFixed(2)} forced=${forced}`)
  for (const event of events) console.log(`[probe]   ${event}`)

  await bot.pathfinder.goto(new goals.GoalNear(feet.x, feet.y, feet.z, 1)).catch(() => undefined)
  await sleep(400)
  await manualClimb(step, false)
  await bot.pathfinder.goto(new goals.GoalNear(feet.x, feet.y, feet.z, 1)).catch(() => undefined)
  await sleep(400)
  await manualClimb(step, true)

  bot.quit('probe done')
  setTimeout(() => process.exit(0), 500)
}

bot.once('spawn', () => {
  void run().catch((error: unknown) => {
    console.log(`[probe] failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
})
bot.on('error', (e) => console.log(`[probe] error ${e instanceof Error ? e.message : String(e)}`))
setTimeout(() => process.exit(1), 90000)
