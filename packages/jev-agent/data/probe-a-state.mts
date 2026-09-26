import mineflayer from 'mineflayer'
import { buildWorldState, defaultSensorOptions, makeGoal } from '../src/state.ts'
import { emptyGoalQueueState } from '../src/goalQueue.ts'
import type { AgentSignals } from '../src/state.ts'
const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username: process.argv[2] ?? 'AI_M2Probe', auth: 'offline' })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const signals: AgentSignals = { consecutiveFailures: 0, lastFailureCode: null, lastPathStatus: 'idle', stalledMs: 0, lastPolicyConfidence: null, maxConcurrentActions: 0, escalationRecommended: false, failedCandidates: {} }
bot.once('spawn', async () => {
  await sleep(9000)
  const p = bot.entity.position
  const state = buildWorldState(bot, { tick: 1, goal: makeGoal('oak_log', 3), goalQueue: emptyGoalQueueState(), focusItem: 'oak_log', recentEvents: [], signals }, { ...defaultSensorOptions, reach: 5 })
  console.log(`[astate] feet=(${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}) blocks=${state.blocks.length} standable=${state.terrain.standable.length} descent=${(state.descent??[]).length} furnaces=${(state.furnaces??[]).length}`)
  const logs = state.blocks.filter((b) => b.kind === 'log')
  console.log(`[astate] log blocks=${logs.length}`)
  for (const b of logs.slice(0, 18)) console.log(`  ${b.name}(${b.position.x},${b.position.y},${b.position.z}) d=${b.distance} inReach=${b.inReach} vis=${b.visible} adj=${b.adjacentStandable ? `${b.adjacentStandable.x},${b.adjacentStandable.y},${b.adjacentStandable.z}` : 'none'} yield=${b.yield}`)
  bot.quit('done'); setTimeout(() => process.exit(0), 500)
})
bot.on('error', (e) => console.log('[astate] error', e.message))
setTimeout(() => process.exit(1), 45000)
