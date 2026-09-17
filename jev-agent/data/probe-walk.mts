// One-off probe: does REAL pathfinder walking (canDig=false, setGoal + physics)
// reach an out-of-reach oak_log's adjacent standable spot on this server?
import mineflayer from 'mineflayer'
import pathfinderModule from 'mineflayer-pathfinder'
import { buildWorldState, defaultSensorOptions, makeGoal } from '../src/state.ts'
import { emptyGoalQueueState } from '../src/goalQueue.ts'
import type { AgentSignals } from '../src/state.ts'

const { Movements, goals } = pathfinderModule
const username = process.argv[2] ?? 'AI_Bot'
const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username, auth: 'offline' })
bot.loadPlugin(pathfinderModule.pathfinder)

bot.once('spawn', async () => {
  await sleep(7000)
  const signals: AgentSignals = {
    consecutiveFailures: 0, lastFailureCode: null, lastPathStatus: 'idle', stalledMs: 0,
    lastPolicyConfidence: null, maxConcurrentActions: 0, escalationRecommended: false, failedCandidates: {},
  }
  const state = buildWorldState(bot, {
    tick: 1, goal: makeGoal('oak_log', 1), goalQueue: emptyGoalQueueState(), recentEvents: [], signals,
  }, { ...defaultSensorOptions, scanRadius: 48, reach: 4.5 })

  const movements = new Movements(bot)
  movements.canDig = false
  movements.allow1by1towers = false
  movements.scafoldingBlocks = []
  movements.allowParkour = false
  movements.allowFreeMotion = false
  movements.dontMineUnderFallingBlock = true
  movements.maxDropDown = 8
  movements.infiniteLiquidDropdownDistance = false
  bot.pathfinder.setMovements(movements)

  const log = state.blocks.find((b) => b.kind === 'log' && !b.inReach && b.adjacentStandable !== null)
  if (log === undefined || log.adjacentStandable === null) {
    console.log('[walk] no out-of-reach log with adjacent standable found')
    bot.quit('done')
    return
  }
  const spot = log.adjacentStandable
  console.log(`[walk] start=${JSON.stringify(state.self.position)} log=(${log.position.x},${log.position.y},${log.position.z}) d=${log.distance} spot=${JSON.stringify(spot)}`)
  const plan = bot.pathfinder.getPathTo(movements, new goals.GoalBlock(spot.x, spot.y, spot.z), 5000)
  console.log(`[walk] plan status=${plan.status} nodes=${plan.path.length}`)
  console.log(`[walk] plan path: ${plan.path.map((n) => `(${n.x},${n.y},${n.z})`).join(' ')}`)

  let ticker = 0
  const iv = setInterval(() => {
    ticker += 1
    const p = bot.entity.position
    console.log(`  [walk] t=${ticker * 500}ms ${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)} onGround=${bot.entity.onGround}`)
  }, 500)
  const done = new Promise<string>((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 25000)
    bot.once('goal_reached', () => { clearTimeout(timer); resolve('reached') })
    bot.on('path_reset', (r: string) => { console.log(`[walk] path_reset ${r} at ${JSON.stringify(bot.entity.position)}`) })
  })
  bot.pathfinder.setGoal(new goals.GoalBlock(spot.x, spot.y, spot.z))
  clearInterval(iv)
  const outcome = await done
  console.log(`[walk] outcome=${outcome} end=${JSON.stringify(bot.entity.position)} distToSpot=${bot.entity.position.distanceTo(bot.entity.position.clone().set(spot.x + 0.5, spot.y, spot.z + 0.5)).toFixed(2)}`)
  bot.quit('probe done')
  setTimeout(() => process.exit(0), 500)
})
bot.on('error', (e) => console.log('[walk] error', e.message))
bot.on('kicked', (r) => console.log('[walk] kicked', JSON.stringify(r)))
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)) }
