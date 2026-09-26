// descend-live-test.mts - live probe for the #4/#9 staircase + descending tool
// path: a stone goal with no tool drives the candidate generator straight into
// DESCEND, so the run logs TOOL_CHOICE/DIG_PATH/STAIRCASE/DESCEND_LIMIT.
//
// Run: bun data/descend-live-test.mts --username AI_M1MV --seconds 150
import { join } from 'node:path'
import mineflayer from 'mineflayer'
import pathfinderModule from 'mineflayer-pathfinder'
import { plugin as collectBlockPlugin } from 'mineflayer-collectblock'
import { jevAgent } from '../src/index.ts'
import { createStandaloneKernelAuthority } from '../standalone-kernel-authority.mts'
import { JsonlWriter } from '../src/jev.ts'
import { FixedPlanSystem2, planFromJson } from '../src/system2.ts'
import type { PlanJson } from '../src/system2.ts'

function opt(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`)
  const value = index === -1 ? undefined : process.argv[index + 1]
  return value ?? fallback
}

const username = opt('username', 'AI_M1MV')
const seconds = Number(opt('seconds', '150'))
const logDir = opt('log-dir', 'logs/descend-mvfix')
const host = opt('host', '127.0.0.1')
const port = Number(opt('port', '25565'))

const plan: PlanJson = {
  goal: 'stone_search_probe',
  subgoals: [{ type: 'collect', resource: 'cobblestone', count: 64 }],
}

const bot = mineflayer.createBot({ host, port, username, auth: 'offline' })
bot.loadPlugin(pathfinderModule.pathfinder)
bot.loadPlugin(collectBlockPlugin)
jevAgent(bot, createStandaloneKernelAuthority('standalone-descend-live'))

let shuttingDown = false
function shutdown(reason: string, code: number): void {
  if (shuttingDown) return
  shuttingDown = true
  process.stdout.write(`[descend] shutting down (${reason})\n`)
  bot.quit(reason)
  setTimeout(() => process.exit(code), 750)
}

bot.on('error', (error) => {
  process.stdout.write(`[descend] error: ${error.message}\n`)
})
bot.on('kicked', (reason) => {
  process.stdout.write(`[descend] kicked: ${JSON.stringify(reason)}\n`)
})

bot.once('spawn', async () => {
  process.stdout.write(`[descend] spawn=${JSON.stringify(bot.entity.position)} user=${username}\n`)
  bot.jev.setOptions({
    goalItem: 'cobblestone',
    goalCount: 64,
    heartbeatMs: 3000,
    maxRuntimeMs: seconds * 1000,
    wedgeStallMs: 600000,
    logDir,
    scanRadius: 48,
    reach: 5,
    actuation: 'pathfinder',
    forceFallbackPolicy: true,
    singleShotPlanner: true,
    verbose: true,
  })
  bot.jev.setSystem2(new FixedPlanSystem2(new JsonlWriter(join(logDir, 'system2.jsonl')), planFromJson(plan), 'stone probe'))
  await new Promise((resolve) => setTimeout(resolve, 8000))
  bot.jev.start()
  const summary = await bot.jev.wait()
  process.stdout.write(
    `[descend] stopped=${summary.stopped} success=${summary.success} ticks=${summary.ticks} verifiedDigs=${summary.verifiedDigs} inventory=${JSON.stringify(counts())}.\n`,
  )
  shutdown('probe complete', 0)
})

function counts(): Record<string, number> {
  const out: Record<string, number> = {}
  for (const item of bot.inventory.items()) out[item.name] = (out[item.name] ?? 0) + item.count
  return out
}

process.on('SIGINT', () => shutdown('SIGINT', 130))
process.on('SIGTERM', () => shutdown('SIGTERM', 143))
setTimeout(() => shutdown('hard limit', 0), (seconds + 30) * 1000)
