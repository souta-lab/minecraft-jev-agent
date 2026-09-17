// probe-m2.mts - READ-ONLY pre-flight for M2: what resources exist around the
// spawn and which of them are reachable under movements.canDig=false?
//
// Run: npx tsx data/probe-m2.mts [username]
import mineflayer from 'mineflayer'
import pathfinderModule from 'mineflayer-pathfinder'
import { defaultExecutorOptions, Executor, EventLogger } from '../src/index.ts'

const bot = mineflayer.createBot({
  host: '127.0.0.1',
  port: 25565,
  username: process.argv[2] ?? 'AI_M2Probe',
  auth: 'offline',
})
bot.loadPlugin(pathfinderModule.pathfinder)

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const ORE_NAMES = [
  'coal_ore', 'deepslate_coal_ore',
  'iron_ore', 'deepslate_iron_ore',
  'copper_ore', 'deepslate_copper_ore',
  'gold_ore', 'deepslate_gold_ore',
  'diamond_ore', 'deepslate_diamond_ore',
  'lapis_ore', 'deepslate_lapis_ore',
  'redstone_ore', 'deepslate_redstone_ore',
  'emerald_ore', 'deepslate_emerald_ore',
]

function passableAt(x: number, y: number, z: number): boolean {
  const b = bot.blockAt(bot.entity.position.clone().set(x, y, z))
  return b === null || b.boundingBox === 'empty'
}
function solidAt(x: number, y: number, z: number): boolean {
  const b = bot.blockAt(bot.entity.position.clone().set(x, y, z))
  return b !== null && b.boundingBox === 'block'
}
function standableSpot(x: number, y: number, z: number): boolean {
  return passableAt(x, y, z) && passableAt(x, y + 1, z) && solidAt(x, y - 1, z)
}
function findAdjacentStandable(x: number, y: number, z: number): string | null {
  const offsets: Array<[number, number, number]> = [
    [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1],
    [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
    [1, -1, 0], [-1, -1, 0], [0, -1, 1], [0, -1, -1],
  ]
  for (const [dx, dy, dz] of offsets) {
    if (standableSpot(x + dx, y + dy, z + dz)) return `${x + dx},${y + dy},${z + dz}`
  }
  return null
}

bot.once('spawn', async () => {
  await sleep(8000)
  const p = bot.entity.position
  console.log(`[probe] spawn feet=(${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}) dimension=${bot.game.dimension} time=${bot.time.timeOfDay} day=${bot.time.isDay}`)

  const executor = new Executor(bot, new EventLogger(null, false), {
    ...defaultExecutorOptions,
    actuation: 'packet',
  })
  executor.ensureMovements()
  console.log('[probe] movements pinned canDig=' + bot.pathfinder.movements.canDig)

  for (const name of ['oak_log', ...ORE_NAMES]) {
    const positions = bot.findBlocks({ matching: (b) => b.name === name, maxDistance: 96, count: 64 })
    if (positions.length === 0) continue
    const rows = positions.map((pos) => {
      const d = Math.hypot(pos.x - p.x, pos.y - p.y, pos.z - p.z)
      return { pos, d }
    }).sort((a, b) => a.d - b.d)
    const nearest = rows[0]!
    const adj = findAdjacentStandable(nearest.pos.x, nearest.pos.y, nearest.pos.z)
    let path = 'n/a'
    if (adj !== null) {
      const [ax, ay, az] = adj.split(',').map(Number)
      try {
        const goal = new pathfinderModule.goals.GoalBlock(ax!, ay!, az!)
        const plan = bot.pathfinder.getPathTo(bot.pathfinder.movements, goal, 1500)
        path = plan.status
      } catch (e) {
        path = 'err'
      }
    }
    console.log(
      `[probe] ${name.padEnd(24)} n=${String(positions.length).padStart(3)} nearest=(${nearest.pos.x},${nearest.pos.y},${nearest.pos.z}) d=${nearest.d.toFixed(1)} adj=${adj ?? 'none'} path=${path}`,
    )
  }

  // Surface profile / cave check around the nearest iron ore.
  const iron = bot.findBlocks({ matching: (b) => b.name === 'iron_ore' || b.name === 'deepslate_iron_ore', maxDistance: 96, count: 16 })
  for (const pos of iron.slice(0, 4)) {
    // Which y has the top solid block in this column?
    let top = pos.y
    for (let y = pos.y + 8; y >= pos.y - 8; y -= 1) {
      if (solidAt(pos.x, y, pos.z)) { top = y; break }
    }
    console.log(`[probe] iron@(${pos.x},${pos.y},${pos.z}) columnTopSolid=${top}`)
  }

  // Diamond depth probe.
  const dia = bot.findBlocks({ matching: (b) => b.name === 'diamond_ore' || b.name === 'deepslate_diamond_ore', maxDistance: 200, count: 8 })
  console.log(`[probe] diamond_ore within 200m: ${dia.length}`)
  for (const pos of dia.slice(0, 4)) console.log(`  diamond@(${pos.x},${pos.y},${pos.z})`)

  // Lava / water hazards near spawn.
  for (const name of ['lava', 'water']) {
    const positions = bot.findBlocks({ matching: (b) => b.name === name, maxDistance: 48, count: 16 })
    console.log(`[probe] ${name}: n=${positions.length}${positions[0] ? ` nearest=(${positions[0].x},${positions[0].y},${positions[0].z})` : ''}`)
  }

  bot.quit('probe done')
  setTimeout(() => process.exit(0), 700)
})

bot.on('error', (e) => console.log('[probe] error', e.message))
bot.on('kicked', (r) => console.log('[probe] kicked', JSON.stringify(r)))
setTimeout(() => { console.log('[probe] hard timeout'); process.exit(1) }, 90000)
