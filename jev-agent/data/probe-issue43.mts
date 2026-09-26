// probe-issue43.mts - live evidence for issue #43 on AI_M1W43.
//
//   --wait      an impossible surface goal must not WAIT forever: after 3
//               consecutive WAITs the controller logs WAIT_LIMIT -> replan.
//   --retrieve  a remembered ore coordinate must produce a retrieval ACTION
//               (RETURN_TO_KNOWN_RESOURCE) instead of WAIT.
//
// Run from jev-agent/:
//   bun data/probe-issue43.mts --wait
//   bun data/probe-issue43.mts --retrieve
import mineflayer from 'mineflayer'
import pathfinderModule from 'mineflayer-pathfinder'
import { plugin as collectBlockPlugin } from 'mineflayer-collectblock'
import { jevAgent } from '../src/index.ts'
import type { RunSummary } from '../src/index.ts'
import { createStandaloneKernelAuthority } from '../standalone-kernel-authority.mts'
import type { System2Brain } from '../src/system2.ts'

const phase = process.argv.includes('--retrieve') ? 'retrieve' : 'wait'
const username = 'AI_M1W43'
const seconds = Number(process.argv[process.argv.indexOf('--seconds') + 1] ?? '14')
const runtimeMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 14000

const noPlannerBrain: System2Brain = {
  model: 'probe-throwing-planner',
  async plan() {
    throw new Error('probe: no planner in this run')
  },
}

const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username, auth: 'offline' })
bot.loadPlugin(pathfinderModule.pathfinder)
bot.loadPlugin(collectBlockPlugin)
jevAgent(bot, createStandaloneKernelAuthority('standalone-probe-issue43'))

bot.on('error', (error) => {
  process.stdout.write(`[probe] error: ${error.message}\n`)
})
bot.on('kicked', (reason) => {
  process.stdout.write(`[probe] kicked: ${JSON.stringify(reason)}\n`)
})

bot.once('spawn', async () => {
  const position = bot.entity.position
  const knownResources =
    phase === 'retrieve'
      ? [
          {
            name: 'diamond_ore',
            kind: 'ore' as const,
            position: { x: Math.round(position.x) + 40, y: -50, z: Math.round(position.z) + 40 },
          },
        ]
      : []
  bot.jev.setOptions({
    goalItem: 'diamond',
    goalCount: 1,
    heartbeatMs: 500,
    maxRuntimeMs: runtimeMs,
    logDir: `logs/issue43-${phase}`,
    scanRadius: phase === 'retrieve' ? 32 : 0,
    reach: 5,
    actuation: 'pathfinder',
    forceFallbackPolicy: true,
    singleShotPlanner: false,
    wedgeRepeatLimit: 8,
    llmCooldownMs: 0,
    knownResources,
    verbose: true,
  })
  bot.jev.setSystem2(noPlannerBrain)
  process.stdout.write(
    `[probe] phase=${phase} pos=${position.x.toFixed(1)},${position.y.toFixed(1)},${position.z.toFixed(1)} ` +
      `knownResources=${knownResources.length} policy=${bot.jev.policyKind}\n`,
  )
  await new Promise((resolve) => setTimeout(resolve, 2500))
  bot.jev.start()
  const summary: RunSummary = await bot.jev.wait()
  process.stdout.write(
    `[probe] stopped=${summary.stopped} success=${summary.success} ticks=${summary.ticks} ` +
      `queueCurrent=${summary.goalQueueCurrent ?? 'none'}\n`,
  )
  bot.quit('probe complete')
  setTimeout(() => process.exit(summary.success ? 0 : 0), 500)
})
