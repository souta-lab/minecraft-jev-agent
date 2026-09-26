// verify-41-predicate-descend.mts - live proof for issue #41: the ore descent is
// a predicate goal (`descend_to:Y=<n>`, success = bot position.y <= n) and the
// controller reaches that Y instead of collecting a cobblestone quota.
//
// Run: bun data/verify-41-predicate-descend.mts [username] [seconds]
import { join } from 'node:path'
import mineflayer from 'mineflayer'
import pathfinderModule from 'mineflayer-pathfinder'
import { plugin as collectBlockPlugin } from 'mineflayer-collectblock'
import { jevAgent } from '../src/index.ts'
import { createStandaloneKernelAuthority } from '../standalone-kernel-authority.mts'
import { JsonlWriter } from '../src/jev.ts'
import { FixedPlanSystem2 } from '../src/system2/service.ts'
import type { PlannedGoal } from '../src/goalQueue.ts'
import type { KnownResource } from '../src/state.ts'
import { installDescendAwarePolicy } from '../../buddy-driver/system-one-policy.ts'

const username = process.argv[2] ?? 'AI_M2PD'
const seconds = Number(process.argv[3] ?? '110')
const host = process.argv[4] ?? '127.0.0.1'
const port = Number(process.argv[5] ?? '25565')
const logDir = 'logs/verify41'

// Measured known iron_ore coordinates from the resident freeze report (2026-09-18).
const KNOWN_IRON: KnownResource[] = [
  { name: 'iron_ore', kind: 'ore', position: { x: 25, y: 49, z: 36 }, dimension: 'minecraft:overworld', worldEpoch: 1 },
  { name: 'iron_ore', kind: 'ore', position: { x: 36, y: 56, z: 41 }, dimension: 'minecraft:overworld', worldEpoch: 1 },
]

const bot = mineflayer.createBot({ host, port, username, auth: 'offline' })
bot.loadPlugin(pathfinderModule.pathfinder)
bot.loadPlugin(collectBlockPlugin)
jevAgent(bot, createStandaloneKernelAuthority('standalone-verify-41'))

let shuttingDown = false
function shutdown(reason: string, code: number): void {
  if (shuttingDown) return
  shuttingDown = true
  process.stdout.write(`[41] shutting down (${reason})\n`)
  bot.quit(reason)
  setTimeout(() => process.exit(code), 900)
}

function feet(): { x: number; y: number; z: number } {
  const p = bot.entity.position
  return { x: p.x, y: p.y, z: p.z }
}

function counts(): Record<string, number> {
  const out: Record<string, number> = {}
  for (const item of bot.inventory.items()) out[item.name] = (out[item.name] ?? 0) + item.count
  return out
}

bot.on('error', (error) => {
  process.stdout.write(`[41] error: ${error.message}\n`)
})
bot.on('kicked', (reason) => {
  process.stdout.write(`[41] kicked: ${JSON.stringify(reason)}\n`)
})

bot.once('spawn', async () => {
  const spawn = feet()
  const knownBelow = KNOWN_IRON.map((r) => r.position.y).filter((y) => y < Math.floor(spawn.y))
  const oreLevel = knownBelow.length > 0 ? Math.min(...knownBelow) : Math.floor(spawn.y) - 6
  const override = process.env.PRED41_TARGET_Y
  const targetY = override === undefined ? oreLevel - 2 : Number(override)
  process.stdout.write(`[41] spawn=${JSON.stringify(spawn)} user=${username} oreLevel=${oreLevel} targetY=${targetY}\n`)

  const plan: PlannedGoal[] = [
    {
      kind: 'descend',
      description: `descend_to:Y=${targetY} (reach the raw_iron ore level)`,
      targetItem: 'raw_iron',
      requiredCount: 1,
      targetY,
      dimension: 'minecraft:overworld',
    },
    { kind: 'collect', description: 'collect 3 x raw_iron', targetItem: 'raw_iron', requiredCount: 3 },
  ]

  bot.jev.setOptions({
    goalItem: 'raw_iron',
    goalCount: 3,
    heartbeatMs: 3000,
    maxRuntimeMs: seconds * 1000,
    wedgeStallMs: 600000,
    pathTimeoutMs: 5000,
    logDir,
    scanRadius: 48,
    reach: 5,
    actuation: 'pathfinder',
    forceFallbackPolicy: true,
    singleShotPlanner: true,
    verbose: true,
    knownResources: KNOWN_IRON,
  })
  bot.jev.setSystem2(
    new FixedPlanSystem2(new JsonlWriter(join(logDir, 'system2.jsonl')), plan, 'issue41 predicate descend'),
  )
  installDescendAwarePolicy(bot.jev, [], (event, detail) => {
    if (event === 'EXPLORE') process.stdout.write(`[41] EXPLORE ${JSON.stringify(detail)}\n`)
  })

  const minY = { value: spawn.y }
  const tracker = setInterval(() => {
    minY.value = Math.min(minY.value, bot.entity.position.y)
  }, 50)

  await new Promise((resolve) => setTimeout(resolve, 8000))
  bot.jev.start()
  const summary = await bot.jev.wait()
  clearInterval(tracker)
  const inventory = counts()
  process.stdout.write(
    `[41] stopped=${summary.stopped} success=${summary.success} ticks=${summary.ticks} ` +
      `ySpawn=${spawn.y.toFixed(2)} yMin=${minY.value.toFixed(2)} yEnd=${feet().y.toFixed(2)} ` +
      `targetY=${targetY} reached=${minY.value <= targetY} ` +
      `raw_iron=${inventory['raw_iron'] ?? 0} inventory=${JSON.stringify(inventory)}\n`,
  )
  shutdown('probe complete', 0)
})

process.on('SIGINT', () => shutdown('SIGINT', 130))
process.on('SIGTERM', () => shutdown('SIGTERM', 143))
setTimeout(() => shutdown('hard limit', 0), (seconds + 40) * 1000)
