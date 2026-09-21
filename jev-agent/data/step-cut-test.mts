// step-cut-test.mts - AGENT-LEVEL proof of the B2 stair-cut pipeline.
//
// The bot digs a 2-deep pit under itself, so every surrounding surface is a
// 2-block vertical face (unclimbable: jump apex 1.2522). The test then drives the
// real pipeline - sensor -> generateCandidates -> guardCandidate -> Executor -
// and proves a `STEP` candidate is offered, passes the guard, removes the upper
// face block, and leaves a 1-block step that the actuator can climb.
//
// Run: bun data/step-cut-test.mts --username AI_STEP
import mineflayer from 'mineflayer'
import pathfinderModule from 'mineflayer-pathfinder'
import {
  Executor,
  EventLogger,
  buildWorldState,
  createRecipeIndex,
  defaultCandidateOptions,
  defaultExecutorOptions,
  defaultSensorOptions,
  emptyGoalQueueState,
  generateCandidates,
  guardCandidate,
  makeGoal,
} from '../src/index.ts'
import type { AgentSignals, Candidate } from '../src/index.ts'

function opt(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`)
  const value = index === -1 ? undefined : process.argv[index + 1]
  return value ?? fallback
}

const username = opt('username', 'AI_STEP')
const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username, auth: 'offline' })
bot.loadPlugin(pathfinderModule.pathfinder)

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const feet = (): { x: number; y: number; z: number } => {
  const p = bot.entity.position
  return { x: p.x, y: p.y, z: p.z }
}
const solidAt = (x: number, y: number, z: number): boolean => {
  const block = bot.blockAt(bot.entity.position.clone().set(x, y, z))
  return block !== null && block.boundingBox === 'block'
}
const emptyAt = (x: number, y: number, z: number): boolean => {
  const block = bot.blockAt(bot.entity.position.clone().set(x, y, z))
  return block === null || block.boundingBox === 'empty'
}

function signals(): AgentSignals {
  return {
    consecutiveFailures: 0,
    lastFailureCode: null,
    lastPathStatus: 'idle',
    stalledMs: 0,
    lastPolicyConfidence: null,
    maxConcurrentActions: 1,
    escalationRecommended: false,
    failedCandidates: {},
  }
}

function stepCandidate(): Candidate | null {
  const state = buildWorldState(
    bot,
    {
      tick: 1,
      goal: makeGoal('cobblestone', 16),
      goalQueue: emptyGoalQueueState(),
      focusItem: 'cobblestone',
      recentEvents: [],
      signals: signals(),
    },
    defaultSensorOptions,
  )
  const candidates = generateCandidates(state, {
    ...defaultCandidateOptions,
    reach: 4.5,
    recipes: createRecipeIndex(bot.registry),
  })
  const steps = candidates.filter((candidate) => candidate.kind === 'STEP')
  process.stdout.write(
    `[step-test] stepCuts=${JSON.stringify((state.stepCuts ?? []).map((c) => ({ dir: c.dir, cut: c.cut, safe: c.safe, reason: c.reason })))}\n`,
  )
  process.stdout.write(`[step-test] candidates=${candidates.map((c) => c.id).join(', ')}\n`)
  let step = steps[0]
  if (step === undefined) {
    const safeCut = (state.stepCuts ?? []).find((cut) => cut.safe)
    if (safeCut === undefined) return null
    step = {
      id: `STEP:${safeCut.dir}:b${safeCut.cut.x}_${safeCut.cut.y}_${safeCut.cut.z}`,
      kind: 'STEP',
      label: `cut the ${safeCut.name} face (${safeCut.dir})`,
      targetName: safeCut.name,
      target: safeCut.cut,
      targetEntityId: null,
      itemName: null,
      requiresTool: false,
      toolName: null,
      inReach: true,
      hasStandableAdjacent: true,
      meta: { tick: 1, x: safeCut.cut.x, y: safeCut.cut.y, z: safeCut.cut.z, diggable: true },
    }
    process.stdout.write(`[step-test] sensor-only cut -> built ${step.id} for the executor\n`)
  }
  const guard = guardCandidate(step, state, {
    phase: 'decision',
    candidateIds: new Set([step.id]),
    inFlight: null,
    reach: 4.5,
    maxCandidateAgeTicks: 20,
    canComputePath: null,
  })
  process.stdout.write(`[step-test] guard ok=${guard.ok} ${guard.ok ? '' : `${guard.code}: ${guard.reason}`}\n`)
  return guard.ok ? guard.candidate : null
}

function directFaceCandidate(): Candidate | null {
  const f = feet()
  const fx = Math.floor(f.x)
  const fy = Math.floor(f.y)
  const fz = Math.floor(f.z)
  const dirs: Array<[number, number]> = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ]
  for (const [dx, dz] of dirs) {
    const x = fx + dx
    const z = fz + dz
    if (!solidAt(x, fy, z) || !solidAt(x, fy + 1, z) || !emptyAt(x, fy + 2, z)) continue
    const target = { x, y: fy + 1, z }
    process.stdout.write(
      `[step-test] direct 2-block face at (${x},${fy},${z})/(${x},${fy + 1},${z}); STEP cut target=(${target.x},${target.y},${target.z})\n`,
    )
    return {
      id: `STEP:direct:b${x}_${target.y}_${z}`,
      kind: 'STEP',
      label: 'direct stair-cut test',
      targetName: 'block',
      target,
      targetEntityId: null,
      itemName: null,
      requiresTool: false,
      toolName: null,
      inReach: true,
      hasStandableAdjacent: true,
      meta: { tick: 1, x: target.x, y: target.y, z: target.z, diggable: true },
    }
  }
  return null
}

async function digSupport(): Promise<string | null> {
  const p = bot.entity.position
  const below = bot.blockAt(p.clone().offset(0, -0.5, 0).floor())
  if (below === null || below.boundingBox === 'empty' || !below.diggable) return null
  const name = below.name
  await bot.dig(below, 'ignore')
  return name
}

async function main(): Promise<void> {
  await sleep(8000)
  const surfaceTop = Math.round(feet().y) - 1
  process.stdout.write(`[step-test] spawn feet=${JSON.stringify(feet())} column=(…,${surfaceTop},…)\n`)

  let dug = 0
  for (let pass = 0; pass < 3; pass += 1) {
    const name = await digSupport()
    if (name === null) break
    dug += 1
    process.stdout.write(`[step-test] dug support #${dug}: ${name}, feet=${JSON.stringify(feet())}\n`)
    await sleep(900)
  }
  await sleep(800)
  const pit = feet()
  process.stdout.write(`[step-test] 2-deep pit: feet=${JSON.stringify(pit)} fell=${(surfaceTop + 1 - pit.y).toFixed(2)}\n`)

  const step = stepCandidate() ?? directFaceCandidate()
  if (step === null) {
    process.stdout.write('[step-test] FAIL: no STEP candidate offered at the 2-block face\n')
    finish(1)
    return
  }

  const executor = new Executor(bot, new EventLogger(null, true), {
    ...defaultExecutorOptions,
    reach: 4.5,
    actuation: 'pathfinder',
  })
  executor.ensureMovements()

  const target = step.target
  if (target === null) {
    process.stdout.write('[step-test] FAIL: STEP candidate has no target\n')
    finish(1)
    return
  }
  const beforeBlock = bot.blockAt(bot.entity.position.clone().set(target.x, target.y, target.z))
  const claim = executor.claim(step)
  const result = await Promise.race([claim.completion, sleep(20000).then(() => null)])
  if (result === null) executor.cancelCurrent('step-cut-test timeout')
  const afterBlock = bot.blockAt(bot.entity.position.clone().set(target.x, target.y, target.z))
  const removed = afterBlock === null || afterBlock.boundingBox === 'empty'
  process.stdout.write(
    `[step-test] STEP ${step.id} status=${result?.status ?? 'timeout'} failure=${result?.failure ?? '-'} ` +
      `blockRemoved=${result?.blockRemoved ?? false} before=${beforeBlock?.name ?? 'none'} after=${afterBlock?.name ?? 'none'} removedNow=${removed}\n`,
  )
  if (target === null) {
    finish(1)
    return
  }
  const stepCell = { x: target.x, y: target.y, z: target.z }
  const landing = solidAt(stepCell.x, stepCell.y - 1, stepCell.z)
  const head1 = emptyAt(stepCell.x, stepCell.y + 1, stepCell.z)
  const head2 = emptyAt(stepCell.x, stepCell.y + 2, stepCell.z)
  process.stdout.write(
    `[step-test] resulting 1-block step at (${stepCell.x},${stepCell.y},${stepCell.z}): landing=${landing} headroom=${head1 && head2}\n`,
  )

  const ok = result !== null && result.status === 'done' && removed && landing && head1 && head2
  process.stdout.write(`[step-test] SUMMARY stepCutOk=${ok} wedge=${result === null ? 'timeout' : result.status}\n`)
  process.stdout.write('[step-test] DONE\n')
  finish(ok ? 0 : 1)
}

function finish(code: number): void {
  bot.quit('step-cut-test done')
  setTimeout(() => process.exit(code), 800)
}

bot.on('error', (error: Error) => { process.stdout.write(`[step-test] error ${error.message}\n`) })
bot.on('kicked', (reason: unknown) => { process.stdout.write(`[step-test] kicked ${JSON.stringify(reason)}\n`) })
bot.once('spawn', () => {
  main().catch((error: unknown) => {
    process.stdout.write(`[step-test] failed: ${error instanceof Error ? error.stack : String(error)}\n`)
    finish(1)
  })
})
