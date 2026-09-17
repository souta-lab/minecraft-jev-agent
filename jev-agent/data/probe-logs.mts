import mineflayer from 'mineflayer'
const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username: process.argv[2] ?? 'AI_M2Probe', auth: 'offline' })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
function passable(p: any) { const b = bot.blockAt(p); return b === null || b.boundingBox === 'empty' }
function solid(p: any) { const b = bot.blockAt(p); return b !== null && b.boundingBox === 'block' }
function standable(x: number, y: number, z: number) {
  const base = bot.entity.position.clone()
  return passable(base.set(x, y, z)) && passable(base.set(x, y + 1, z)) && solid(base.set(x, y - 1, z))
}
function adj(x: number, y: number, z: number): string | null {
  for (const [dx, dy, dz] of [[1,0,0],[-1,0,0],[0,0,1],[0,0,-1],[1,0,1],[-1,0,1],[1,0,-1],[-1,0,-1],[1,-1,0],[-1,-1,0],[0,-1,1],[0,-1,-1]] as Array<[number,number,number]>)
    if (standable(x+dx, y+dy, z+dz)) return `${x+dx},${y+dy},${z+dz}`
  return null
}
bot.once('spawn', async () => {
  await sleep(7000)
  const p = bot.entity.position
  console.log(`[logs] feet=(${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)})`)
  const positions = bot.findBlocks({ matching: (b) => /_log$/.test(b.name), maxDistance: 48, count: 512 })
  const rows = positions.map((pos) => ({ pos, d: Math.hypot(pos.x-p.x,pos.y-p.y,pos.z-p.z) })).sort((a,b)=>a.d-b.d)
  let reachable = 0
  for (const r of rows) {
    const a = adj(r.pos.x, r.pos.y, r.pos.z)
    if (a !== null) reachable += 1
    if (rows.indexOf(r) < 25) console.log(`[logs] (${r.pos.x},${r.pos.y},${r.pos.z}) d=${r.d.toFixed(1)} dy=${(r.pos.y-p.y).toFixed(0)} adj=${a ?? 'none'}`)
  }
  console.log(`[logs] total=${rows.length} withAdj=${reachable}`)
  bot.quit('done'); setTimeout(() => process.exit(0), 500)
})
setTimeout(() => process.exit(1), 60000)
