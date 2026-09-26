// seed-scan.mts - READ-ONLY spawn resource scan for seed selection.
//
// Connects an offline bot, lets the server finish generating spawn chunks, then
// scans blocks only (bot.blockAt / bot.findBlocks) plus client-side pathfinder
// planning (no movement, no digging, no block changes). Reports:
//   (a) oak_log trees whose adjacent standable spot exists and is walk-up
//       reachable within ~3 blocks (pathfinder status for the nearest few),
//   (b) exposed stone with a standable spot within ~30 blocks,
//   (c) the nearest iron_ore and its depth (info only).
//
// Run: bun data/seed-scan.mts [username]
import mineflayer from 'mineflayer'
import pathfinderModule from 'mineflayer-pathfinder'

const { pathfinder, Movements, goals } = pathfinderModule
const username = process.argv[2] ?? 'AI_SeedScan'

const STONE_LIKE = new Set([
  'stone', 'andesite', 'diorite', 'granite', 'tuff', 'deepslate', 'cobblestone',
  'cobbled_deepslate', 'gravel',
])
const OFFSETS: Array<[number, number, number]> = [
  [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1],
  [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
  [1, -1, 0], [-1, -1, 0], [0, -1, 1], [0, -1, -1],
]

const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username, auth: 'offline' })
bot.loadPlugin(pathfinder)
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function passable(p: { x: number; y: number; z: number }): boolean {
  const b = bot.blockAt(bot.entity.position.clone().set(p.x, p.y, p.z))
  return b === null || b.boundingBox === 'empty'
}
function solid(p: { x: number; y: number; z: number }): boolean {
  const b = bot.blockAt(bot.entity.position.clone().set(p.x, p.y, p.z))
  return b !== null && b.boundingBox === 'block'
}
function standable(p: { x: number; y: number; z: number }): boolean {
  return passable(p) && passable({ x: p.x, y: p.y + 1, z: p.z }) && solid({ x: p.x, y: p.y - 1, z: p.z })
}
function adjacentStand(x: number, y: number, z: number): { x: number; y: number; z: number } | null {
  for (const [dx, dy, dz] of OFFSETS) {
    const f = { x: x + dx, y: y + dy, z: z + dz }
    if (standable(f)) return f
  }
  return null
}
const FACE_OFFSETS: Array<[number, number, number]> = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
]
function exposedFaces(pos: { x: number; y: number; z: number }): number {
  let air = 0
  for (const [dx, dy, dz] of FACE_OFFSETS) {
    const n = bot.blockAt(bot.entity.position.clone().set(pos.x + dx, pos.y + dy, pos.z + dz))
    if (n !== null && n.boundingBox === 'empty') air += 1
  }
  return air
}
// Client-side plan only (read-only): can the stock pathfinder reach this stand spot?
function planStatus(spot: { x: number; y: number; z: number }, movements: InstanceType<typeof Movements>): string {
  try {
    const result = bot.pathfinder.getPathTo(movements, new goals.GoalNear(spot.x, spot.y, spot.z, 1), 1500)
    return `${result.status}(cost=${Math.round(result.cost)})`
  } catch (error) {
    return `error:${error instanceof Error ? error.message : String(error)}`
  }
}

bot.once('spawn', async () => {
  await sleep(7000)
  const p = bot.entity.position
  const feet = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }
  console.log(`[seeds] bot=${username} feet=(${feet.x},${feet.y},${feet.z}) pos=(${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)})`)

  const movements = new Movements(bot)
  movements.canDig = false
  movements.allowParkour = false
  movements.allow1by1towers = false
  movements.scafoldingBlocks = []

  // (a) oak_log trees
  const oaks = bot.findBlocks({ matching: (b) => b.name === 'oak_log', maxDistance: 48, count: 512 })
  const oakRows = oaks
    .map((pos) => ({ pos, d: Math.hypot(pos.x - p.x, pos.y - p.y, pos.z - p.z), stand: adjacentStand(pos.x, pos.y, pos.z) }))
    .sort((a, b) => a.d - b.d)
  const oakWithStand = oakRows.filter((r) => r.stand !== null)
  const oakWalkUp3 = oakWithStand.filter((r) => r.stand !== null && Math.abs(r.stand.y - feet.y) <= 3)
  console.log(`[seeds] oak_log total=${oakRows.length} withAdjStand=${oakWithStand.length} walkUp<=3=${oakWalkUp3.length}`)
  for (const r of oakRows.slice(0, 6)) {
    const dy = r.stand === null ? null : r.stand.y - feet.y
    const plan = r.stand === null ? '-' : planStatus(r.stand, movements)
    console.log(
      `[seeds] oak (${r.pos.x},${r.pos.y},${r.pos.z}) d=${r.d.toFixed(1)} dy=${r.pos.y - feet.y} ` +
        `stand=${r.stand === null ? 'none' : `(${r.stand.x},${r.stand.y},${r.stand.z}) dy=${dy}`} plan=${plan}`,
    )
  }

  // (b) exposed, standable stone within ~48 blocks
  const stonePositions = bot.findBlocks({ matching: (b) => STONE_LIKE.has(b.name), maxDistance: 64, count: 20000 })
  const stoneRows = stonePositions
    .map((pos) => ({
      pos,
      name: bot.blockAt(pos)?.name ?? '?',
      d: bot.entity.position.distanceTo(bot.entity.position.clone().set(pos.x + 0.5, pos.y + 0.5, pos.z + 0.5)),
      stand: adjacentStand(pos.x, pos.y, pos.z),
      faces: exposedFaces(pos),
    }))
    .sort((a, b) => a.d - b.d)
  const stoneReachable = stoneRows.filter((r) => r.faces > 0 && r.stand !== null)
  const stoneExposed = stoneRows.filter((r) => r.faces > 0)
  console.log(
    `[seeds] stone-like within 64m total=${stoneRows.length} exposed=${stoneExposed.length} exposed+standable=${stoneReachable.length}`,
  )
  for (const r of (stoneReachable.length > 0 ? stoneReachable : stoneRows).slice(0, 6)) {
    const plan = r.stand === null ? '-' : planStatus(r.stand, movements)
    console.log(
      `[seeds] stone ${r.name} (${r.pos.x},${r.pos.y},${r.pos.z}) d=${r.d.toFixed(1)} dy=${r.pos.y - feet.y} ` +
        `airFaces=${r.faces} stand=${r.stand === null ? 'none' : `(${r.stand.x},${r.stand.y},${r.stand.z})`} plan=${plan}`,
    )
  }

  // (c) iron_ore info
  const iron = bot.findBlocks({ matching: (b) => /iron_ore$/.test(b.name), maxDistance: 96, count: 64 })
  const ironRows = iron
    .map((pos) => ({ pos, name: bot.blockAt(pos)?.name ?? '?', d: bot.entity.position.distanceTo(bot.entity.position.clone().set(pos.x + 0.5, pos.y + 0.5, pos.z + 0.5)) }))
    .sort((a, b) => a.d - b.d)
  console.log(`[seeds] iron_ore within 96m = ${ironRows.length}`)
  for (const r of ironRows.slice(0, 3)) console.log(`[seeds] iron ${r.name} (${r.pos.x},${r.pos.y},${r.pos.z}) d=${r.d.toFixed(1)} dy=${r.pos.y - feet.y}`)

  console.log(`[seeds] VERDICT trees(a)=${oakWalkUp3.length >= 3 ? 'ok' : 'weak'} stone(b)=${stoneReachable.length > 0 ? 'ok' : 'weak'}`)
  bot.quit('seed-scan done')
  setTimeout(() => process.exit(0), 500)
})

bot.on('error', (error) => console.log('[seeds] error', error.message))
bot.on('kicked', (reason) => console.log('[seeds] kicked', JSON.stringify(reason)))
setTimeout(() => {
  console.log('[seeds] hard timeout')
  process.exit(1)
}, 90000)
