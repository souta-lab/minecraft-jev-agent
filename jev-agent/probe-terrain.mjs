// Read-only terrain probe. Connects, prints feet + nearby log positions and the
// column profile around the trunks, then disconnects. Never digs, never moves.
import mineflayer from 'mineflayer'
import pathfinderModule from 'mineflayer-pathfinder'

const username = process.argv[2] ?? 'AI_P1'
const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username, auth: 'offline' })
bot.loadPlugin(pathfinderModule.pathfinder)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function surface(x, z, aroundY) {
  for (let y = aroundY + 8; y >= aroundY - 16; y -= 1) {
    const b = bot.blockAt(new (bot.entity.position.constructor)(x, y, z))
    if (b && b.boundingBox !== 'empty') return { y, name: b.name }
  }
  return null
}

bot.once('spawn', async () => {
  await sleep(9000)
  const feet = bot.entity.position
  console.log(`[probe] user=${username} feet=(${feet.x.toFixed(2)},${feet.y.toFixed(2)},${feet.z.toFixed(2)}) onGround=${bot.entity.onGround}`)
  const Vec3 = feet.constructor
  // log positions
  const logs = []
  const r = 24
  const bx = Math.floor(feet.x), bz = Math.floor(feet.z)
  for (let x = bx - r; x <= bx + r; x += 1) {
    for (let z = bz - r; z <= bz + r; z += 1) {
      for (let y = Math.floor(feet.y) + 12; y >= Math.floor(feet.y) - 12; y -= 1) {
        const b = bot.blockAt(new Vec3(x, y, z))
        if (b && /_log$/.test(b.name)) {
          const d = Math.hypot(x + 0.5 - feet.x, y - feet.y, z + 0.5 - feet.z)
          logs.push({ x, y, z, name: b.name, d: +d.toFixed(2) })
        }
      }
    }
  }
  logs.sort((a, b) => a.d - b.d)
  console.log(`[probe] logs=${logs.length}`)
  for (const l of logs.slice(0, 25)) console.log(`  ${l.name} (${l.x},${l.y},${l.z}) d=${l.d}`)
  // column profiles around nearest trunk
  const near = logs[0]
  if (near) {
    console.log(`[probe] column profile around (${near.x},${near.z}):`)
    for (let x = near.x - 2; x <= near.x + 2; x += 1) {
      for (let z = near.z - 2; z <= near.z + 2; z += 1) {
        const s = surface(x, z, near.y)
        const here = bot.blockAt(new Vec3(x, near.y, z))
        console.log(`    (${x},${z}) topSolid=${s ? s.y + ':' + s.name : 'none'} atY=${here ? here.name : 'null'}`)
      }
    }
  }
  // pathfinder planning to the stand spots near the nearest trunk
  try {
    const p = bot.pathfinder.getPathTo(bot.pathfinder.movements, new pathfinderModule.goals.GoalNear(near.x, near.y, near.z, 1), 3000)
    console.log(`[probe] GoalNear(nearest,1) status=${p.status} nodes=${p.path?.length ?? 0}`)
    if (p.path) for (const n of p.path.slice(0, 12)) console.log(`    node (${n.x},${n.y},${n.z})`)
  } catch (e) {
    console.log(`[probe] plan error: ${e.message}`)
  }
  await sleep(300)
  bot.quit('probe done')
  setTimeout(() => process.exit(0), 500)
})

bot.on('error', (e) => console.log(`[probe] error ${e.message}`))
bot.on('kicked', (r) => console.log(`[probe] kicked ${JSON.stringify(r)}`))
setTimeout(() => { console.log('[probe] timeout'); process.exit(1) }, 60000)
