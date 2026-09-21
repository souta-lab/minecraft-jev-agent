// verify-retrieve-vertical.mts - live proof for issue #45: a RETRIEVE whose
// remembered resource is below the bot must include a vertical leg (REUSE_TUNNEL
// or STAIRCASE) and change the bot's Y toward the target instead of WAITing.
//
// Run: bun data/verify-retrieve-vertical.mts [username]
import mineflayer from 'mineflayer'
import pathfinderModule from 'mineflayer-pathfinder'
import { jevAgent } from '../src/index.ts'
import { defaultCandidateOptions, generateCandidates } from '../src/candidates.ts'
import type { Candidate } from '../src/candidates.ts'
import { emptyGoalQueueState } from '../src/goalQueue.ts'
import { planVerticalApproach } from '../src/verticalPlan.ts'
import { buildWorldState, defaultSensorOptions, makeGoal } from '../src/state.ts'
import type { AgentSignals, KnownResource, Vec3Json, WorldState } from '../src/state.ts'

const username = process.argv[2] ?? 'AI_M2V45'
const host = process.argv[3] ?? '127.0.0.1'
const port = Number(process.argv[4] ?? '25565')
const MAX_STEPS = 5

const bot = mineflayer.createBot({ host, port, username, auth: 'offline' })
bot.loadPlugin(pathfinderModule.pathfinder)
bot.loadPlugin(jevAgent)

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function feet(): Vec3Json {
  const p = bot.entity.position
  return { x: p.x, y: p.y, z: p.z }
}

function emptySignals(known: KnownResource[]): AgentSignals {
  return {
    consecutiveFailures: 0,
    lastFailureCode: null,
    lastPathStatus: 'idle',
    stalledMs: 0,
    lastPolicyConfidence: null,
    maxConcurrentActions: 0,
    escalationRecommended: false,
    failedCandidates: {},
    knownResources: known,
  }
}

function liveState(target: Vec3Json): WorldState {
  const known: KnownResource[] = [{ name: 'iron_ore', kind: 'ore', position: target }]
  return buildWorldState(
    bot,
    {
      tick: 1,
      goal: makeGoal('raw_iron', 3),
      goalQueue: emptyGoalQueueState(),
      focusItem: 'raw_iron',
      recentEvents: [],
      signals: emptySignals(known),
    },
    defaultSensorOptions,
  )
}

let shuttingDown = false
function shutdown(reason: string, code: number): void {
  if (shuttingDown) return
  shuttingDown = true
  process.stdout.write(`[verify45] shutting down (${reason})\n`)
  bot.quit(reason)
  setTimeout(() => process.exit(code), 750)
}

bot.on('error', (error) => {
  process.stdout.write(`[verify45] error: ${error.message}\n`)
})
bot.on('kicked', (reason) => {
  process.stdout.write(`[verify45] kicked: ${JSON.stringify(reason)}\n`)
})

bot.once('spawn', async () => {
  process.stdout.write(`[verify45] spawn=${JSON.stringify(feet())} user=${username}\n`)
  await sleep(8000)
  bot.jev.setOptions({
    goalItem: 'raw_iron',
    goalCount: 3,
    heartbeatMs: 3000,
    maxRuntimeMs: 120000,
    wedgeStallMs: 600000,
    pathTimeoutMs: 4000,
    logDir: 'logs/verify45',
    scanRadius: 48,
    reach: 4.5,
    actuation: 'pathfinder',
    forceFallbackPolicy: true,
    verbose: true,
  })

  let moved = 0
  for (let step = 0; step < MAX_STEPS; step += 1) {
    const before = feet()
    const target: Vec3Json = {
      x: Math.floor(before.x),
      y: Math.floor(before.y) - 6,
      z: Math.floor(before.z),
    }
    const state = liveState(target)
    const generated = generateCandidates(state, defaultCandidateOptions).find(
      (candidate: Candidate) => candidate.kind === 'RETRIEVE',
    )
    const plan = planVerticalApproach({
      selfFeetY: before.y,
      selfPosition: before,
      target,
      tunnel: state.signals.lastTunnel,
      descent: state.descent,
    })
    const meta: Record<string, string | number | boolean> = {
      tick: 1,
      retrieval: 'known',
      resource: 'raw_iron',
      resourceKind: 'ore',
      x: target.x,
      y: target.y,
      z: target.z,
      vertical: plan?.kind ?? 'none',
    }
    if (plan?.kind === 'reuse') {
      meta.tunnelX = plan.tunnel.x
      meta.tunnelY = plan.tunnel.y
      meta.tunnelZ = plan.tunnel.z
    }
    if (plan?.kind === 'staircase') {
      meta.stairDir = plan.dir
      meta.stairFromY = plan.fromY
      meta.stairToY = plan.toY
      meta.stairDigX = plan.dig.x
      meta.stairDigY = plan.dig.y
      meta.stairDigZ = plan.dig.z
      meta.stairStepX = plan.step.x
      meta.stairStepY = plan.step.y
      meta.stairStepZ = plan.step.z
      meta.stairBlockName = plan.digName ?? 'unknown'
    }
    const retrieve: Candidate = {
      id: `RETRIEVE:known:raw_iron:b${target.x}_${target.y}_${target.z}`,
      kind: 'RETRIEVE',
      label: `return to remembered iron_ore at (${target.x},${target.y},${target.z}) for raw_iron`,
      targetName: 'iron_ore',
      target,
      targetEntityId: null,
      itemName: null,
      requiresTool: false,
      toolName: null,
      inReach: false,
      hasStandableAdjacent: true,
      meta,
    }
    process.stdout.write(
      `[verify45] step=${step + 1} pos=(${before.x.toFixed(2)},${before.y.toFixed(2)},${before.z.toFixed(2)}) ` +
        `target=(${target.x},${target.y},${target.z}) descentOptions=${(state.descent ?? []).filter((s) => s.safe).length} ` +
        `generated=${generated === undefined ? 'none' : String(generated.meta.vertical)} vertical=${meta.vertical} ` +
        `stair=${meta.vertical === 'staircase' ? `${String(meta.stairDigX)},${String(meta.stairDigY)},${String(meta.stairDigZ)}` : 'n/a'}\n`,
    )
    if (plan === null) {
      process.stdout.write('[verify45] BLOCKER: no vertical plan was produced for the below-level target\n')
      break
    }
    const claim = bot.jev.agent.claim(retrieve)
    let minY = before.y
    const tracker = setInterval(() => {
      minY = Math.min(minY, bot.entity.position.y)
    }, 40)
    const result = await claim.completion
    clearInterval(tracker)
    await sleep(1000)
    const after = feet()
    const dy = minY - before.y
    if (dy < -0.5) moved += 1
    process.stdout.write(
      `[verify45] step=${step + 1} status=${result.status} failure=${result.failure ?? 'none'} ` +
        `blockRemoved=${result.blockRemoved} y=${before.y.toFixed(2)}->min${minY.toFixed(2)}->end${after.y.toFixed(2)} dy=${dy.toFixed(2)} ` +
        `detail=${result.detail}\n`,
    )
    if (!Number.isFinite(dy) || Math.abs(dy) < 0.01) {
      process.stdout.write('[verify45] BLOCKER: no vertical body change from the retrieval step\n')
      break
    }
  }
  process.stdout.write(`[verify45] verticalSteps=${moved}/${MAX_STEPS}\n`)
  shutdown('probe complete', moved > 0 ? 0 : 2)
})

process.on('SIGINT', () => shutdown('SIGINT', 130))
process.on('SIGTERM', () => shutdown('SIGTERM', 143))
setTimeout(() => shutdown('hard limit', 0), 150000)
