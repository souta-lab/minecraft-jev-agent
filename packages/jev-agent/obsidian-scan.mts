// Read-only verification bot: where does obsidian actually exist right now?
//
// The resident's collect plan is pinned to remembered obsidian coordinates that an
// operator action may have removed. This instrument joins as a separate, non-acting bot
// (AI_M3SCAN by default), scans the loaded world for obsidian, and prints the positions
// plus the resident's current position so the two can be compared. It never moves, digs,
// places or talks.
//
//   bun jev-agent/obsidian-scan.mts [--user AI_M3SCAN] [--radius 64] [--seconds 45]

import mineflayer from 'mineflayer'
import { Vec3 } from 'vec3'

const argv = process.argv.slice(2)
const arg = (name: string, fallback: string): string => {
  const i = argv.indexOf(name)
  const next = i >= 0 ? argv[i + 1] : undefined
  return next !== undefined && next !== '' ? next : fallback
}

const user = arg('--user', 'AI_M3SCAN')
const radius = Number(arg('--radius', '64'))
const seconds = Number(arg('--seconds', '45'))

const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username: user, auth: 'offline', version: '1.21.11' })

bot.on('kicked', (reason) => console.log(JSON.stringify({ event: 'kicked', reason: String(reason).slice(0, 120) })))
bot.on('error', (error) => console.log(JSON.stringify({ event: 'error', message: String(error).slice(0, 160) })))

bot.once('spawn', () => {
  // Give chunk loading a moment, then scan once.
  setTimeout(() => {
    const self = bot.entity?.position
    const resident = Object.values(bot.players).find((p) => p.username === 'AI_Buddy')?.entity?.position ?? null
    const positions = bot.findBlocks({ matching: (block) => block.name === 'obsidian', maxDistance: radius, count: 64 })
    const blocks = positions.map((p) => ({ x: p.x, y: p.y, z: p.z, distance: self === undefined ? null : Math.round(Math.hypot(p.x - self.x, p.y - self.y, p.z - self.z) * 10) / 10 }))
    blocks.sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0))
    console.log(JSON.stringify({
      event: 'obsidian_scan',
      self: self === undefined ? null : { x: Math.round(self.x * 10) / 10, y: Math.round(self.y * 10) / 10, z: Math.round(self.z * 10) / 10 },
      resident: resident === null ? null : { x: Math.round(resident.x * 10) / 10, y: Math.round(resident.y * 10) / 10, z: Math.round(resident.z * 10) / 10 },
      radius,
      found: blocks.length,
      nearest: blocks.slice(0, 12),
      // The cells the resident's collect plan has been retrying (from the live logs).
      rememberedCheck: [
        { x: 25, y: 69, z: 9 }, { x: 27, y: 70, z: 9 }, { x: 26, y: 68, z: 9 }, { x: 28, y: 68, z: 9 },
      ].map((cell) => {
        const block = bot.blockAt(new Vec3(cell.x, cell.y, cell.z))
        return { ...cell, name: block?.name ?? 'unloaded', present: block?.name === 'obsidian' }
      }),
    }))
    bot.quit()
  }, 4000)
})

setTimeout(() => { try { bot.quit() } catch { /* ignore */ } }, seconds * 1000)
