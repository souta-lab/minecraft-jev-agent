// One-off probe (read-only): find ANY naturally exposed / reachable stone-like
// block within a wide radius, using the same canDig=false adjacency rule.
import mineflayer from 'mineflayer'

const STONE_LIKE = new Set([
  'stone', 'cobblestone', 'deepslate', 'cobbled_deepslate',
  'andesite', 'diorite', 'granite', 'tuff', 'gravel',
])

const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username: process.argv[2] ?? 'AI_Stone', auth: 'offline' })

function isPassable(block: { boundingBox: string } | null): boolean {
  return block !== null && block.boundingBox === 'empty'
}
function isSolid(block: { boundingBox: string } | null): boolean {
  return block !== null && block.boundingBox === 'block'
}
function standable(f: { x: number; y: number; z: number }): boolean {
  const a = bot.blockAt(bot.entity.position.clone().set(f.x, f.y, f.z))
  const b = bot.blockAt(bot.entity.position.clone().set(f.x, f.y + 1, f.z))
  const c = bot.blockAt(bot.entity.position.clone().set(f.x, f.y - 1, f.z))
  return isPassable(a) && isPassable(b) && isSolid(c)
}
const OFFSETS: Array<[number, number, number]> = [
  [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1],
  [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
  [1, -1, 0], [-1, -1, 0], [0, -1, 1], [0, -1, -1],
]

bot.once('spawn', async () => {
  await sleep(7000)
  const p = bot.entity.position
  const feet = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }
  console.log(`[stone] bot at (${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}) feet=(${feet.x},${feet.y},${feet.z})`)

  const positions = bot.findBlocks({
    matching: (b) => STONE_LIKE.has(b.name),
    maxDistance: 96,
    count: 40000,
  })
  console.log(`[stone] ${positions.length} stone-like block(s) within 96m`)

  let exposed = 0
  let reachable = 0
  let aboveGround = 0
  const best: string[] = []
  for (const pos of positions) {
    const block = bot.blockAt(pos)
    if (block === null) continue
    const surfaces: Array<[number, number, number]> = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
    let airFaces = 0
    for (const [dx, dy, dz] of surfaces) {
      const n = bot.blockAt(bot.entity.position.clone().set(pos.x + dx, pos.y + dy, pos.z + dz))
      if (n !== null && n.boundingBox === 'empty') airFaces += 1
    }
    const isExposed = airFaces > 0
    if (isExposed) exposed += 1
    if (pos.y >= feet.y - 1) aboveGround += 1
    let spot: { x: number; y: number; z: number } | null = null
    for (const [dx, dy, dz] of OFFSETS) {
      const f = { x: pos.x + dx, y: pos.y + dy, z: pos.z + dz }
      if (standable(f)) { spot = f; break }
    }
    if (isExposed && spot !== null) {
      reachable += 1
      if (best.length < 25) {
        const d = bot.entity.position.distanceTo(bot.entity.position.clone().set(pos.x + 0.5, pos.y + 0.5, pos.z + 0.5))
        best.push(`  - ${block.name} (${pos.x},${pos.y},${pos.z}) d=${d.toFixed(1)} airFaces=${airFaces} stand=(${spot.x},${spot.y},${spot.z})`)
      }
    }
  }
  console.log(`[stone] exposed=${exposed} aboveGround(y>=${feet.y - 1})=${aboveGround} exposed+standable=${reachable}`)
  for (const r of best) console.log(r)

  bot.quit('probe done')
  setTimeout(() => process.exit(0), 500)
})
bot.on('error', (e) => console.log('[stone] error', e.message))
bot.on('kicked', (r) => console.log('[stone] kicked', JSON.stringify(r)))
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)) }
