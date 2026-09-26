// m1.mts - the M1 runner: execute the 4-subgoal plan with Jev (or the marked
// deterministic Jev fallback) as the ONLY decision maker, while the long-horizon
// planner is a single-shot stub. Proves `llm.called === false` on every decision.
//
// Run: bun m1.mts [--seconds 900] [--log-dir logs/m1-run] [--fallback]
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import mineflayer from 'mineflayer'
import pathfinderModule from 'mineflayer-pathfinder'
import { plugin as collectBlockPlugin } from 'mineflayer-collectblock'
import { jevAgent } from './src/index.ts'
import type { RunSummary } from './src/index.ts'
import { createStandaloneKernelAuthority } from './standalone-kernel-authority.mts'
import { JsonlWriter } from './src/jev.ts'
import { FixedPlanSystem2, M1_PLAN_JSON, planFromJson } from './src/system2.ts'

function opt(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`)
  const value = index === -1 ? undefined : process.argv[index + 1]
  return value ?? fallback
}

const host = opt('host', '127.0.0.1')
const port = Number(opt('port', '25565'))
const username = opt('username', 'AI_Bot')
const seconds = Number(opt('seconds', '900'))
const logDir = opt('log-dir', 'logs/m1-run')
const settleMs = Number(opt('settle', '8000'))
const heartbeatMs = Number(opt('heartbeat', '3000'))
const fallback = process.argv.includes('--fallback')
const clean = !process.argv.includes('--no-clean')

const bot = mineflayer.createBot({ host, port, username, auth: 'offline' })
bot.loadPlugin(pathfinderModule.pathfinder)
bot.loadPlugin(collectBlockPlugin)
jevAgent(bot, createStandaloneKernelAuthority('standalone-m1'))

let shuttingDown = false

function shutdown(reason: string, code: number): void {
  if (shuttingDown) return
  shuttingDown = true
  process.stdout.write(`[m1] shutting down (${reason})\n`)
  bot.quit(reason)
  setTimeout(() => process.exit(code), 750)
}

bot.on('error', (error) => {
  process.stdout.write(`[m1] error: ${error.message}\n`)
  process.exitCode = 1
})
bot.on('kicked', (reason) => {
  process.stdout.write(`[m1] kicked: ${JSON.stringify(reason)}\n`)
})

bot.once('spawn', async () => {
  try {
    bot.jev.setOptions({
      goalItem: 'oak_log',
      goalCount: 3,
      heartbeatMs,
      maxRuntimeMs: seconds * 1000,
      logDir,
      scanRadius: 48,
      reach: 5,
      actuation: 'pathfinder',
      forceFallbackPolicy: fallback,
      singleShotPlanner: true,
      verbose: true,
    })
    bot.jev.setSystem2(
      new FixedPlanSystem2(
        new JsonlWriter(join(logDir, 'system2.jsonl')),
        planFromJson(M1_PLAN_JSON),
        `M1 plan (${M1_PLAN_JSON.goal})`,
      ),
    )
    process.stdout.write(
      `[m1] policy=${bot.jev.policyKind} model=${bot.jev.policyModel} system2=${bot.jev.system2Model} ` +
        `singleShotPlanner=true logDir=${logDir}\n`,
    )
    if (clean) {
      const emptied = await cleanInventory()
      process.stdout.write(
        `[m1] inventory clean=${emptied} residue=${JSON.stringify(inventorySnapshot())}\n`,
      )
    }
    await waitForStableSpawn(settleMs)
    bot.jev.start()
    const summary = await bot.jev.wait()
    report(summary)
    shutdown('m1 complete', summary.success ? 0 : 1)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stdout.write(`[m1] run failed: ${message}\n`)
    shutdown('run failed', 1)
  }
})

async function cleanInventory(): Promise<boolean> {
  bot.chat('/clear')
  await sleep(1200)
  for (let pass = 0; pass < 5 && bot.inventory.items().length > 0; pass += 1) {
    for (const item of [...bot.inventory.items()]) {
      try {
        await bot.tossStack(item)
      } catch {
        break
      }
    }
    await sleep(500)
  }
  return bot.inventory.items().length === 0
}

function inventorySnapshot(): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const item of bot.inventory.items()) counts[item.name] = (counts[item.name] ?? 0) + item.count
  return counts
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

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

interface JsonRecord {
  record?: string
  [key: string]: unknown
}

function readJsonl(path: string): JsonRecord[] {
  try {
    return readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as JsonRecord)
  } catch {
    return []
  }
}

function report(summary: RunSummary): void {
  const decisions = readJsonl(join(logDir, 'decisions.jsonl')).filter((r) => r.record === 'decision')
  const jevCalls = readJsonl(join(logDir, 'jev-calls.jsonl')).filter((r) => r.record === 'jev-call')
  const runEvents = readJsonl(join(logDir, 'run.jsonl')).filter((r) => r.record === 'agent-event')

  const llmCalled = decisions.filter((r) => {
    const llm = r.llm as { called?: boolean } | undefined
    return llm?.called === true
  })
  const lastLlm = decisions[decisions.length - 1]?.llm as
    | { called?: boolean; runtimeCalls?: number; planCalls?: number }
    | undefined

  const transitions = decisions
    .filter((r) => r.subgoal != null)
    .map((r) => {
      const s = r.subgoal as {
        fromDescription: string | null
        toDescription: string | null
        trigger: string
        inventory: Record<string, number>
      }
      return `tick ${String(r.tick)} trigger=${s.trigger} :: [${s.fromDescription ?? 'none'}] -> [${s.toDescription ?? 'plan complete'}] inventory=${JSON.stringify(s.inventory)}`
    })

  const queueEvents = runEvents
    .filter((r) => r.source === 'queue')
    .map((r) => `tick ${String(r.tick)} ${String(r.message)}`)
  // The final transition to "plan complete" finishes the run before a decision
  // record is written, so the ordered-transition proof reads the queue timeline.
  const completed = queueEvents.filter((line) => line.includes('subgoal COMPLETE'))
  const ordered =
    completed.length === 4 &&
    completed[0]?.includes('collect 3 x oak_log') === true &&
    completed[1]?.includes('craft 1 x crafting_table') === true &&
    completed[2]?.includes('craft 1 x wooden_pickaxe') === true &&
    completed[3]?.includes('collect 16 x cobblestone') === true
  const triggered = completed.length === 4 && completed.every((line) => line.includes('trigger='))

  const latencies = jevCalls
    .map((r) => r.latencyMs)
    .filter((v): v is number => typeof v === 'number')
    .sort((a, b) => a - b)
  const p50 = latencies.length === 0 ? null : latencies[Math.floor(latencies.length * 0.5)]
  const p95 = latencies.length === 0 ? null : latencies[Math.floor(latencies.length * 0.95)]
  let inputTokens = 0
  let outputTokens = 0
  for (const call of jevCalls) {
    const response = call.response as { usage?: { inputTokens?: number; outputTokens?: number } } | null
    inputTokens += response?.usage?.inputTokens ?? 0
    outputTokens += response?.usage?.outputTokens ?? 0
  }

  const inventory: Record<string, number> = {}
  for (const item of bot.inventory.items()) inventory[item.name] = (inventory[item.name] ?? 0) + item.count

  process.stdout.write('\n[m1] ===== M1 EVIDENCE =====\n')
  process.stdout.write(
    `[m1] stopped=${summary.stopped} success=${summary.success} durationMs=${summary.durationMs} ticks=${summary.ticks}\n`,
  )
  process.stdout.write(
    `[m1] subgoals: planned=${summary.subgoalCount} done=${summary.subgoalsDone} ` +
      `queueDepth=${summary.goalQueueDepth} queueCurrent=${summary.goalQueueCurrent ?? 'none'}\n`,
  )
  process.stdout.write(
    `[m1] LLM gate: decisions=${decisions.length} with_llm_called_true=${llmCalled.length} ` +
      `runtimeCalls=${lastLlm?.runtimeCalls ?? summary.llmRuntimeCalls} planCalls=${lastLlm?.planCalls ?? summary.llmPlanCalls}\n`,
  )
  process.stdout.write(`[m1] Jev calls=${summary.jevCalls} (records=${jevCalls.length}) latency p50=${p50}ms p95=${p95}ms\n`)
  process.stdout.write(`[m1] Jev tokens input=${inputTokens} output=${outputTokens}\n`)
  process.stdout.write(`[m1] guardRejections=${summary.guardRejections} conflictDeferrals=${summary.conflictDeferrals}\n`)
  process.stdout.write(`[m1] verifiedDigs=${summary.verifiedDigs} itemsCollected=${summary.itemsCollected}\n`)
  process.stdout.write(`[m1] escalations=${JSON.stringify(summary.escalations)}\n`)
  process.stdout.write(`[m1] FINAL INVENTORY=${JSON.stringify(inventory)}\n`)

  process.stdout.write('[m1] subgoal timeline (run.jsonl source=queue):\n')
  for (const line of queueEvents) process.stdout.write(`  ${line}\n`)
  process.stdout.write('[m1] subgoal transitions (decisions.jsonl with trigger + inventory):\n')
  for (const line of transitions) process.stdout.write(`  ${line}\n`)

  const acceptance: Array<{ label: string; ok: boolean; detail: string }> = [
    {
      label: 'oak_log>=3 then crafting_table>=1 then wooden_pickaxe>=1 then cobblestone>=16 (in order)',
      ok: ordered,
      detail: `${completed.length} ordered completion(s): ${completed.map((line) => line.split('subgoal COMPLETE')[1]?.trim().slice(0, 40)).join(' | ')}`,
    },
    {
      label: 'llm.called === false on every decision',
      ok: decisions.length > 0 && llmCalled.length === 0,
      detail: `${llmCalled.length}/${decisions.length} decisions had llm.called=true`,
    },
    {
      label: 'LLM runtime calls === 0 (except the one bootstrap plan call)',
      ok: (lastLlm?.runtimeCalls ?? summary.llmRuntimeCalls) === 0 && (lastLlm?.planCalls ?? summary.llmPlanCalls) === 1,
      detail: `runtimeCalls=${lastLlm?.runtimeCalls ?? summary.llmRuntimeCalls} planCalls=${lastLlm?.planCalls ?? summary.llmPlanCalls}`,
    },
    {
      label: 'final inventory satisfies all four subgoals',
      ok:
        (inventory.oak_log ?? 0) >= 3 &&
        (inventory.crafting_table ?? 0) >= 1 &&
        (inventory.wooden_pickaxe ?? 0) >= 1 &&
        (inventory.cobblestone ?? 0) >= 16,
      detail: JSON.stringify({
        oak_log: inventory.oak_log ?? 0,
        crafting_table: inventory.crafting_table ?? 0,
        wooden_pickaxe: inventory.wooden_pickaxe ?? 0,
        cobblestone: inventory.cobblestone ?? 0,
      }),
    },
    {
      label: 'every subgoal transition carries a trigger',
      ok: triggered,
      detail: `${completed.length} trigger(s)`,
    },
  ]

  process.stdout.write('[m1] ===== ACCEPTANCE =====\n')
  let failures = 0
  for (const item of acceptance) {
    if (!item.ok) failures += 1
    process.stdout.write(`${item.ok ? 'PASS' : 'FAIL'}  ${item.label}\n      ${item.detail}\n`)
  }
  process.stdout.write(`[m1] ${acceptance.length - failures}/${acceptance.length} acceptance criteria passed\n`)
  if (failures > 0) process.exitCode = 1
}

process.on('SIGINT', () => shutdown('SIGINT', 130))
process.on('SIGTERM', () => shutdown('SIGTERM', 143))

setTimeout(() => {
  if (!shuttingDown) {
    process.stdout.write('[m1] hard time limit reached\n')
    shutdown('hard time limit', 1)
  }
}, (seconds + 20) * 1000)
