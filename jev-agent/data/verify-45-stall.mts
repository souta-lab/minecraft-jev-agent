// verify-45-stall.mts - live proof for issue #45: an active RETRIEVE that stops
// closing distance emits RETRIEVE_STALLED, drops the unreachable known resource
// (KNOWN_RESOURCE_UNREACHABLE), and the next decision is NOT WAIT.
//
// Run: BUDDY_RETRIEVAL_STALL_TICKS=8 npx tsx data/verify-45-stall.mts AI_M2S45
import mineflayer from 'mineflayer'
import pathfinderModule from 'mineflayer-pathfinder'
import { jevAgent } from '../src/index.ts'
import type { KnownResource } from '../src/state.ts'

const username = process.argv[2] ?? 'AI_M2S45'
const host = process.argv[3] ?? '127.0.0.1'
const port = Number(process.argv[4] ?? '25565')

const bot = mineflayer.createBot({ host, port, username, auth: 'offline' })
bot.loadPlugin(pathfinderModule.pathfinder)
bot.loadPlugin(jevAgent)

let shuttingDown = false
function shutdown(reason: string, code: number): void {
  if (shuttingDown) return
  shuttingDown = true
  process.stdout.write(`[verify45b] shutting down (${reason})\n`)
  bot.quit(reason)
  setTimeout(() => process.exit(code), 750)
}

bot.on('error', (error: Error) => {
  process.stdout.write(`[verify45b] error: ${error.message}\n`)
})
bot.on('kicked', (reason: unknown) => {
  process.stdout.write(`[verify45b] kicked: ${JSON.stringify(reason)}\n`)
})

bot.once('spawn', () => {
  const p = bot.entity.position
  const x = Math.floor(p.x)
  const y = Math.floor(p.y)
  const z = Math.floor(p.z)
  process.stdout.write(`[verify45b] spawn=${x},${y},${z} user=${username}\n`)
  const known: KnownResource[] = [
    { name: 'iron_ore', kind: 'ore', position: { x, y: y + 10, z } },
    { name: 'iron_ore', kind: 'ore', position: { x: x + 20, y, z } },
  ]
  const start = Date.now()
  bot.jev.setOptions({
    goalItem: 'raw_iron',
    goalCount: 3,
    heartbeatMs: 500,
    maxRuntimeMs: 180000,
    wedgeStallMs: 600000,
    wedgeRepeatLimit: 200,
    pathTimeoutMs: 4000,
    logDir: 'logs/verify45b',
    scanRadius: 48,
    reach: 4.5,
    actuation: 'pathfinder',
    forceFallbackPolicy: true,
    verbose: true,
    knownResources: known,
    eventSink: (event, detail) => {
      process.stdout.write(`[sink ${Date.now() - start}ms] ${event} ${JSON.stringify(detail)}\n`)
    },
  })
  let lastAction: string | null = null
  setInterval(() => {
    const id = bot.jev.lastDecisionCandidateId
    if (id !== null && id !== lastAction) {
      lastAction = id
      process.stdout.write(`[action ${Date.now() - start}ms] ${id}\n`)
    }
  }, 500)
  bot.jev.start()
})

process.on('SIGINT', () => shutdown('SIGINT', 130))
process.on('SIGTERM', () => shutdown('SIGTERM', 143))
setTimeout(() => shutdown('hard limit', 0), 150000)
