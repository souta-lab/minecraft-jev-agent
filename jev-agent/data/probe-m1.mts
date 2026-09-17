// One-off pre-flight (read-only): validate the M1 sensor + goal-directed
// candidate generation against the live world before the long run.
import mineflayer from 'mineflayer'
import pathfinderModule from 'mineflayer-pathfinder'
import { defaultCandidateOptions, generateCandidates } from '../src/candidates.ts'
import { createRecipeIndex } from '../src/crafting.ts'
import { GoalQueue } from '../src/goalQueue.ts'
import { buildWorldState, defaultSensorOptions, makeGoal } from '../src/state.ts'
import type { AgentSignals } from '../src/state.ts'
import { M1_PLAN_JSON, planFromJson } from '../src/system2.ts'

const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username: process.argv[2] ?? 'AI_M1Probe', auth: 'offline' })
bot.loadPlugin(pathfinderModule.pathfinder)

const signals: AgentSignals = {
  consecutiveFailures: 0, lastFailureCode: null, lastPathStatus: 'idle', stalledMs: 0,
  lastPolicyConfidence: null, maxConcurrentActions: 0, escalationRecommended: false, failedCandidates: {},
}

bot.once('spawn', async () => {
  await sleep(7000)
  const recipes = createRecipeIndex(bot.registry)
  const queue = new GoalQueue()
  queue.applyPlan(planFromJson(M1_PLAN_JSON), 'llm')

  const buildState = () => {
    const focus = queue.state.current?.targetItem ?? null
    const t0 = Date.now()
    const state = buildWorldState(bot, {
      tick: 1,
      goal: makeGoal('oak_log', 3),
      goalQueue: queue.state,
      focusItem: focus,
      recentEvents: [],
      signals,
    }, { ...defaultSensorOptions, scanRadius: 48, reach: 4.5 })
    return { state, ms: Date.now() - t0, focus }
  }

  const show = (label: string, inject: Record<string, number> = {}): void => {
    const { state, ms, focus } = buildState()
    for (const [name, count] of Object.entries(inject)) state.inventory.counts[name] = count
    const stones = state.blocks.filter((b) => b.kind === 'stone')
    const logs = state.blocks.filter((b) => b.kind === 'log')
    const candidates = generateCandidates(state, { ...defaultCandidateOptions, reach: 4.5, recipes })
    console.log(`\n[probe] === ${label} === focus=${focus} stateMs=${ms} logs=${logs.length} stones=${stones.length} tables=${state.craftingTables.length} spots=${state.placementSpots.length}`)
    for (const s of stones.slice(0, 6)) {
      console.log(`  stone ${s.name} (${s.position.x},${s.position.y},${s.position.z}) d=${s.distance} inReach=${s.inReach} adj=${s.adjacentStandable === null ? 'none' : JSON.stringify(s.adjacentStandable)} harvest=${s.harvestTool} yield=${s.yield}`)
    }
    for (const c of candidates) console.log(`  cand ${c.id} [${c.kind}] :: ${c.label}`)
  }

  show('subgoal 1: collect oak_log')
  queue.markProgress(3)
  show('subgoal 2: craft crafting_table (oak_log=3)', { oak_log: 3 })
  queue.markProgress(1)
  show('subgoal 3a: craft wooden_pickaxe (logs+table item, no placed table)', { oak_log: 2, oak_planks: 8, crafting_table: 1 })
  show('subgoal 3b: craft wooden_pickaxe (planks+sticks, no placed table)', { oak_log: 1, oak_planks: 6, crafting_table: 1, stick: 4 })
  queue.markProgress(1)
  // The probe bot has no pickaxe; fake one so stone candidates are visible.
  const finalState = (() => {
    const { state } = buildState()
    state.inventory.counts['wooden_pickaxe'] = 1
    return state
  })()
  const finalCandidates = generateCandidates(finalState, { ...defaultCandidateOptions, reach: 4.5, recipes })
  console.log(`\n[probe] === subgoal 4: collect cobblestone (pickaxe faked) === focus=${finalState.goalQueue.current?.targetItem}`)
  for (const b of finalState.blocks.filter((x) => x.kind === 'stone').slice(0, 6)) {
    console.log(`  stone ${b.name} (${b.position.x},${b.position.y},${b.position.z}) d=${b.distance} inReach=${b.inReach} adj=${b.adjacentStandable === null ? 'none' : JSON.stringify(b.adjacentStandable)}`)
  }
  for (const c of finalCandidates) console.log(`  cand ${c.id} [${c.kind}] :: ${c.label}`)

  bot.quit('probe done')
  setTimeout(() => process.exit(0), 500)
})
bot.on('error', (e) => console.log('[probe] error', e.message))
bot.on('kicked', (r) => console.log('[probe] kicked', JSON.stringify(r)))
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)) }

