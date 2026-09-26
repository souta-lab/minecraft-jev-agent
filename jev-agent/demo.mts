// demo.mts - the runnable end-to-end PoC.
//
// Connects offline to the local Leaf 26.1.2 server as AI_Bot, then runs the ONE
// loop: find tree -> build candidates -> Jev picks oak_log -> pathfinder ->
// guard -> dig -> verify.
//
// Run: bun demo.mts        (or: bun run demo)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import mineflayer from 'mineflayer'
import pathfinderModule from 'mineflayer-pathfinder'
import { plugin as collectBlockPlugin } from 'mineflayer-collectblock'
import { DECISION_TRIGGERS, jevAgent } from './src/index.ts'
import type { ActuationMode, Candidate, DecisionTrigger, RunSummary } from './src/index.ts'
import { createStandaloneKernelAuthority } from './standalone-kernel-authority.mts'

interface Args {
  host: string
  port: number
  username: string
  seconds: number
  count: number
  min: number
  heartbeatMs: number
  triggers: readonly DecisionTrigger[]
  settleMs: number
  logDir: string
  scanRadius: number
  reach: number
  actuation: ActuationMode
  probe: boolean
  fallback: boolean
}

const ALL_TRIGGERS: readonly DecisionTrigger[] = DECISION_TRIGGERS

function parseTriggers(raw: string | undefined): readonly DecisionTrigger[] {
  if (raw === undefined || raw.trim() === '') return ALL_TRIGGERS
  const wanted = new Set(raw.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0))
  const selected = ALL_TRIGGERS.filter((trigger) => wanted.has(trigger))
  return selected.length > 0 ? selected : ALL_TRIGGERS
}

function parseArgs(argv: string[]): Args {
  const has = (name: string): boolean => argv.includes(`--${name}`)
  if (has('help')) {
    process.stdout.write(`Usage: bun demo.mts [options]

  --host <addr>      server address          (default 127.0.0.1)
  --port <n>         server port             (default 25565)
  --username <name>  offline player name     (default AI_Bot)
  --seconds <n>      hard time limit         (default 150)
  --count <n>        oak_log goal target     (default 1)
  --min <n>          verified digs to succeed(default 1)
  --heartbeat <ms>   max idle heartbeat      (default 3000)
  --settle <ms>      max settle after spawn before the first decision (default 8000)
  --triggers <list>  comma-separated decision triggers (default all:
                     ${ALL_TRIGGERS.join(',')})
  --scan-radius <n>  block scan radius       (default 48)
  --reach <n>        block interaction reach (default 4.5)
  --actuation <mode> pathfinder | packet     (default pathfinder)
  --log-dir <dir>    JSONL log directory     (default logs)
  --fallback         force the deterministic fallback policy (no gateway)
  --no-probe         skip the cancel probe
  --help             show this help
`)
    process.exit(0)
  }
  const opt = (name: string, fallback: string): string => {
    const index = argv.indexOf(`--${name}`)
    const value = index === -1 ? undefined : argv[index + 1]
    return value ?? fallback
  }
  return {
    host: opt('host', '127.0.0.1'),
    port: Number(opt('port', '25565')),
    username: opt('username', 'AI_Bot'),
    seconds: Number(opt('seconds', '150')),
    count: Number(opt('count', '1')),
    min: Number(opt('min', '1')),
    heartbeatMs: Number(opt('heartbeat', '3000')),
    triggers: parseTriggers(opt('triggers', '')),
    settleMs: Number(opt('settle', '8000')),
    logDir: opt('log-dir', 'logs'),
    scanRadius: Number(opt('scan-radius', '48')),
    reach: Number(opt('reach', '4.5')),
    actuation: opt('actuation', 'pathfinder') === 'packet' ? 'packet' : 'pathfinder',
    probe: !has('no-probe'),
    fallback: has('fallback'),
  }
}

const args = parseArgs(process.argv.slice(2))

const bot = mineflayer.createBot({
  host: args.host,
  port: args.port,
  username: args.username,
  auth: 'offline',
})

bot.loadPlugin(pathfinderModule.pathfinder)
bot.loadPlugin(collectBlockPlugin)
jevAgent(bot, createStandaloneKernelAuthority('standalone-demo'))

/** Server `position` packets = rubber-band repositioning (mineflayer `forcedMove`). */
let forcedRepositions = 0
bot.on('forcedMove', () => {
  forcedRepositions += 1
})

bot.once('login', () => {
  process.stdout.write(`[demo] logged in as ${bot.username} -> MC ${bot.version} (protocol ${bot.protocolVersion})\n`)
})

bot.on('error', (error) => {
  process.stdout.write(`[demo] error: ${error.message}\n`)
  process.exitCode = 1
})

bot.on('kicked', (reason) => {
  process.stdout.write(`[demo] kicked: ${JSON.stringify(reason)}\n`)
  process.exitCode = 1
})

let shuttingDown = false
function shutdown(reason: string, code: number): void {
  if (shuttingDown) return
  shuttingDown = true
  process.stdout.write(`[demo] shutting down (${reason})\n`)
  bot.quit(reason)
  setTimeout(() => process.exit(code), 750)
}

bot.once('spawn', async () => {
  const position = bot.entity.position
  process.stdout.write(
    `[demo] spawned at ${position.x.toFixed(2)}, ${position.y.toFixed(2)}, ${position.z.toFixed(2)} ` +
      `dimension=${bot.game.dimension} mode=${bot.game.gameMode} difficulty=${bot.game.difficulty}\n`,
  )

  if (bot.jev === undefined) {
    process.stdout.write('[demo] FATAL: jev-agent plugin was not injected (bot.jev is undefined)\n')
    shutdown('plugin missing', 1)
    return
  }

  try {
    bot.jev.setOptions({
      goalItem: 'oak_log',
      goalCount: args.count,
      heartbeatMs: args.heartbeatMs,
      enabledTriggers: args.triggers,
      maxRuntimeMs: args.seconds * 1000,
      logDir: args.logDir,
      scanRadius: args.scanRadius,
      reach: args.reach,
      actuation: args.actuation,
      forceFallbackPolicy: args.fallback,
      verbose: true,
    })

    process.stdout.write(
      `[demo] policy=${bot.jev.policyKind} model=${bot.jev.policyModel} ` +
        `heartbeat=${args.heartbeatMs}ms triggers=${args.triggers.join(',')}\n`,
    )

    if (args.probe) {
      await runCancelProbe()
    }

    // Let chunks load and the server finish placing the bot (it restores the
    // player's saved position a moment after spawn). Waiting for a stable
    // position means the first decision sees the in-reach blocks.
    await waitForStableSpawn(args.settleMs)

    bot.jev.start()
    const summary = await bot.jev.wait()
    report(summary, args)
    shutdown('demo complete', summary.success ? 0 : 1)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stdout.write(`[demo] run failed: ${message}\n`)
    shutdown('run failed', 1)
  }
})

/**
 * Forced scenario that proves single-action ownership with the production
 * Executor: claim a long WAIT, then claim a different candidate while it runs.
 */
async function runCancelProbe(): Promise<void> {
  const probeA = probeCandidate('WAIT#probeA', 5000)
  const probeB = probeCandidate('WAIT#probeB', 200)
  const first = bot.jev.agent.claim(probeA)
  const second = bot.jev.agent.claim(probeB)
  const firstResult = await first.completion
  const maxConcurrent = bot.jev.agent.maxConcurrentActions
  process.stdout.write(
    `[probe] claim ${probeA.id} -> action#${first.epoch} RUNNING; claim ${probeB.id} -> action#${second.epoch}; ` +
      `previous status=${firstResult.status} failure=${firstResult.failure ?? 'none'} maxConcurrentActions=${maxConcurrent}\n`,
  )
  if (firstResult.status !== 'cancelled' || maxConcurrent !== 1 || second.epoch !== first.epoch + 1) {
    throw new Error(
      `single-action ownership probe failed: status=${firstResult.status} maxConcurrent=${maxConcurrent} epochs=${first.epoch}->${second.epoch}`,
    )
  }
  await second.completion
  process.stdout.write('[probe] OK: exactly one action owned at a time (epoch incremented, previous aborted)\n')
}

/**
 * Wait until the server stops moving the bot (it restores the saved position a
 * moment after spawn), so the first decision is made from the real position.
 */
async function waitForStableSpawn(maxMs: number): Promise<void> {
  const started = Date.now()
  let last = bot.entity?.position.clone()
  let stableSince = Date.now()
  while (Date.now() - started < maxMs) {
    await new Promise<void>((resolve) => setTimeout(resolve, 250))
    const current = bot.entity?.position
    if (current === undefined) continue
    if (last !== undefined && current.distanceTo(last) < 0.05) {
      if (Date.now() - stableSince >= 750) return
    } else {
      stableSince = Date.now()
    }
    last = current.clone()
  }
}

function probeCandidate(id: string, waitMs: number): Candidate {
  return {
    id,
    kind: 'WAIT',
    label: `forced ${waitMs}ms wait`,
    targetName: null,
    target: null,
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: true,
    hasStandableAdjacent: true,
    meta: { tick: 0, waitMs },
  }
}

function report(summary: RunSummary, options: Args): void {
  process.stdout.write('\n[demo] ===== RUN SUMMARY =====\n')
  process.stdout.write(`[demo] policy=${summary.policyKind} model=${summary.policyModel} system2=${bot.jev.system2Model}\n`)
  process.stdout.write(`[demo] ticks=${summary.ticks} jevCalls=${summary.jevCalls} duration=${summary.durationMs}ms\n`)
  process.stdout.write(`[demo] triggerCounts=${JSON.stringify(summary.triggerCounts)}\n`)
  process.stdout.write(
    `[demo] llmSummons=${summary.llmSummons} llmSummonReasons=${JSON.stringify(summary.llmSummonReasons)} ` +
      `needLlmDecisions=${summary.needLlmDecisions}\n`,
  )
  process.stdout.write(
    `[demo] goalQueueDepth=${summary.goalQueueDepth} goalQueueCurrent=${summary.goalQueueCurrent ?? 'none'}\n`,
  )
  process.stdout.write(`[demo] verifiedDigs=${summary.verifiedDigs} blocksRemoved=${summary.blocksRemoved}\n`)
  process.stdout.write(
    `[demo] dropObservations=${summary.dropObservations} itemsCollected=${summary.itemsCollected} (inventory pickup needs a walk onto the drop)\n`,
  )
  process.stdout.write(`[demo] goalComplete=${summary.goalComplete} goalItemCount=${summary.goalItemCount}\n`)
  process.stdout.write(`[demo] oak_log in bot.inventory at shutdown = ${summary.goalItemInInventory}\n`)
  process.stdout.write(
    `[demo] guardRejections=${summary.guardRejections} conflictDeferrals=${summary.conflictDeferrals} ` +
      `maxConcurrentActions=${summary.maxConcurrentActions}\n`,
  )
  process.stdout.write(`[demo] forcedRepositions=${forcedRepositions} (server position packets / rubber-bands)\n`)
  process.stdout.write(`[demo] escalations=${JSON.stringify(summary.escalations)}\n`)
  process.stdout.write(`[demo] stopped=${summary.stopped} success=${summary.success}\n`)

  const candidates = bot.jev.lastCandidateList
  process.stdout.write(`[demo] last candidate list (${candidates.length}):\n`)
  for (const candidate of candidates) {
    process.stdout.write(`[demo]   - ${candidate.id} :: ${candidate.label}\n`)
  }
  process.stdout.write(`[demo] last policy decision: ${bot.jev.lastDecisionCandidateId ?? 'none'}\n`)
  process.stdout.write(`[demo] goal: ${bot.jev.goalState.haveCount}/${bot.jev.goalState.requiredCount} ${bot.jev.goalState.targetItem}\n`)

  const logFile = join(options.logDir, 'jev-calls.jsonl')
  process.stdout.write(`[demo] jev JSONL: ${logFile}\n`)
  try {
    const lines = readFileSync(logFile, 'utf8').trim().split('\n')
    const calls = lines.filter((line) => line.includes('"record":"jev-call"'))
    const realCalls = calls.filter((line) => line.includes('"policy":"typesafe"'))
    const sample = realCalls.length > 0 ? realCalls[realCalls.length - 1] : calls[calls.length - 1]
    if (sample !== undefined) {
      process.stdout.write('[demo] last Jev JSONL record (raw):\n')
      process.stdout.write(`${sample}\n`)
      process.stdout.write('[demo] last Jev JSONL record (pretty, state/questions omitted):\n')
      const parsed = JSON.parse(sample) as Record<string, unknown>
      const questions = parsed.questions as Record<string, { type?: string }> | undefined
      delete parsed.state
      delete parsed.questions
      process.stdout.write(`${JSON.stringify(parsed, null, 2)}\n`)
      if (questions !== undefined) {
        const names = Object.keys(questions)
        process.stdout.write(
          `[demo] BATCHED QUESTIONS (${names.length}): ` +
            `${names.map((name) => `${name}:${questions[name]?.type ?? '?'}`).join(', ')}\n`,
        )
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stdout.write(`[demo] could not read JSONL log: ${message}\n`)
  }

  const required = options.min
  process.stdout.write(
    `[demo] RESULT: ${summary.verifiedDigs >= required ? 'SUCCESS' : 'FAILURE'} ` +
      `(${summary.verifiedDigs} verified dig(s), required ${required})\n`,
  )
}

process.on('SIGINT', () => shutdown('SIGINT', 130))
process.on('SIGTERM', () => shutdown('SIGTERM', 143))

setTimeout(() => {
  if (!shuttingDown) {
    process.stdout.write('[demo] hard time limit reached\n')
    shutdown('hard time limit', bot.jev?.isRunning === true ? 1 : 0)
  }
}, (args.seconds + 20) * 1000)
