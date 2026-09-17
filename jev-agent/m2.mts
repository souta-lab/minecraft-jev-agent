// m2.mts - the M2 (iron age) runner: execute the 14-subgoal plan with Jev (or the
// marked deterministic Jev fallback) as the ONLY decision maker, while the
// long-horizon planner is a single-shot stub. Proves `llm.called === false` on
// every decision and reports per-subgoal inventory, Jev cost, escalations and
// wedge-abort count. Objective = the R3 acceptance (iron_ingot >= 3).
//
// Run: npx tsx m2.mts [--seconds 200] [--log-dir logs/m2-run] [--username AI_R2] [--fallback]
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import mineflayer from 'mineflayer'
import pathfinderModule from 'mineflayer-pathfinder'
import { plugin as collectBlockPlugin } from 'mineflayer-collectblock'
import { jevAgent } from './src/index.ts'
import type { RunSummary } from './src/index.ts'
import { JsonlWriter } from './src/jev.ts'
import { FixedPlanSystem2, M2_PLAN_JSON, planFromJson } from './src/system2.ts'

function opt(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`)
  const value = index === -1 ? undefined : process.argv[index + 1]
  return value ?? fallback
}

const host = opt('host', '127.0.0.1')
const port = Number(opt('port', '25565'))
const username = opt('username', 'AI_R2')
const seconds = Number(opt('seconds', '200'))
const logDir = opt('log-dir', 'logs/m2-run')
const settleMs = Number(opt('settle', '8000'))
const heartbeatMs = Number(opt('heartbeat', '3000'))
const fallback = process.argv.includes('--fallback')
const clean = !process.argv.includes('--no-clean')
const wedgeStallMs = Number(opt('wedge-stall', '60000'))
const ledger = opt('ledger', '')
const stopAfter = Number(opt('stop-after', '0'))

const bot = mineflayer.createBot({ host, port, username, auth: 'offline' })
bot.loadPlugin(pathfinderModule.pathfinder)
bot.loadPlugin(collectBlockPlugin)
bot.loadPlugin(jevAgent)

let shuttingDown = false

function shutdown(reason: string, code: number): void {
  if (shuttingDown) return
  shuttingDown = true
  process.stdout.write(`[m2] shutting down (${reason})\n`)
  bot.quit(reason)
  setTimeout(() => process.exit(code), 750)
}

bot.on('error', (error) => {
  process.stdout.write(`[m2] error: ${error.message}\n`)
  process.exitCode = 1
})
bot.on('kicked', (reason) => {
  process.stdout.write(`[m2] kicked: ${JSON.stringify(reason)}\n`)
})

bot.once('spawn', async () => {
  try {
    bot.jev.setOptions({
      goalItem: 'iron_ingot',
      goalCount: 3,
      heartbeatMs,
      maxRuntimeMs: seconds * 1000,
      wedgeStallMs,
      logDir,
      scanRadius: 48,
      reach: 5,
      actuation: 'pathfinder',
      forceFallbackPolicy: fallback,
      singleShotPlanner: true,
      ledgerPath: ledger.length > 0 ? ledger : null,
      stopAfterSubgoals: stopAfter,
      verbose: true,
    })
    bot.jev.setSystem2(
      new FixedPlanSystem2(
        new JsonlWriter(join(logDir, 'system2.jsonl')),
        planFromJson(M2_PLAN_JSON),
        `M2 plan (${M2_PLAN_JSON.goal})`,
      ),
    )
    process.stdout.write(
      `[m2] policy=${bot.jev.policyKind} model=${bot.jev.policyModel} system2=${bot.jev.system2Model} ` +
        `singleShotPlanner=true logDir=${logDir}` +
        `${ledger.length > 0 ? ` ledger=${ledger} stopAfter=${stopAfter}` : ''}\n`,
    )
    if (clean) {
      const emptied = await cleanInventory()
      process.stdout.write(
        `[m2] inventory clean=${emptied} residue=${JSON.stringify(inventorySnapshot())}\n`,
      )
    }
    await waitForStableSpawn(settleMs)
    bot.jev.start()
    const summary = await bot.jev.wait()
    report(summary)
    shutdown('m2 complete', summary.success ? 0 : 1)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stdout.write(`[m2] run failed: ${message}\n`)
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
  const triggered = completed.length > 0 && completed.every((line) => line.includes('trigger='))
  const monotonic = queueEvents.filter((line) => line.includes('subgoal COMPLETE')).length === summary.subgoalsDone

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

  const inputCostUsd = (inputTokens / 1_000_000) * 0.04
  const meanTokens = jevCalls.length === 0 ? 0 : Math.round(inputTokens / jevCalls.length)
  const wedgeAborts = runEvents.filter((line) => String(line.message).includes('ABORT: wedge')).length

  process.stdout.write('\n[m2] ===== M2 EVIDENCE =====\n')
  process.stdout.write(
    `[m2] stopped=${summary.stopped} success=${summary.success} durationMs=${summary.durationMs} ticks=${summary.ticks}\n`,
  )
  process.stdout.write(
    `[m2] subgoals: planned=${summary.subgoalCount} done=${summary.subgoalsDone} ` +
      `queueDepth=${summary.goalQueueDepth} queueCurrent=${summary.goalQueueCurrent ?? 'none'}\n`,
  )
  process.stdout.write(
    `[m2] LLM gate: decisions=${decisions.length} with_llm_called_true=${llmCalled.length} ` +
      `runtimeCalls=${lastLlm?.runtimeCalls ?? summary.llmRuntimeCalls} planCalls=${lastLlm?.planCalls ?? summary.llmPlanCalls}\n`,
  )
  process.stdout.write(`[m2] Jev calls=${summary.jevCalls} (records=${jevCalls.length}) latency p50=${p50}ms p95=${p95}ms\n`)
  process.stdout.write(`[m2] Jev tokens input=${inputTokens} output=${outputTokens} mean=${meanTokens}/call\n`)
  process.stdout.write(
    `[m2] Jev cost input=$0.04/1M output=free total=$${inputCostUsd.toFixed(6)} meanPerCall=$${(jevCalls.length === 0 ? 0 : inputCostUsd / jevCalls.length).toFixed(6)}\n`,
  )
  process.stdout.write(`[m2] guardRejections=${summary.guardRejections} conflictDeferrals=${summary.conflictDeferrals}\n`)
  process.stdout.write(`[m2] verifiedDigs=${summary.verifiedDigs} itemsCollected=${summary.itemsCollected}\n`)
  process.stdout.write(`[m2] escalations=${JSON.stringify(summary.escalations)} wedgeAborts=${wedgeAborts} stopped=${summary.stopped}\n`)
  process.stdout.write(`[m2] FINAL INVENTORY=${JSON.stringify(inventory)}\n`)

  process.stdout.write('[m2] subgoal timeline (run.jsonl source=queue):\n')
  for (const line of queueEvents) process.stdout.write(`  ${line}\n`)
  process.stdout.write('[m2] subgoal transitions (decisions.jsonl with trigger + inventory):\n')
  for (const line of transitions) process.stdout.write(`  ${line}\n`)

  const acceptance: Array<{ label: string; ok: boolean; detail: string }> = [
    {
      label: 'R3 smelting E2E: charcoal>=1 and iron_ingot>=3 in the final inventory',
      ok: (inventory.charcoal ?? 0) >= 1 && (inventory.iron_ingot ?? 0) >= 3,
      detail: JSON.stringify({
        charcoal: inventory.charcoal ?? 0,
        iron_ingot: inventory.iron_ingot ?? 0,
        raw_iron: inventory.raw_iron ?? 0,
        furnace: inventory.furnace ?? 0,
      }),
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
      label: 'every subgoal completion carries a trigger and the ledger stays monotonic',
      ok: triggered && monotonic,
      detail: `${completed.length} completion(s), subgoalsDone=${summary.subgoalsDone}`,
    },
    {
      label: 'no wedge abort (stopped !== wedge)',
      ok: summary.stopped !== 'wedge',
      detail: `stopped=${summary.stopped} wedgeAborts=${wedgeAborts}`,
    },
  ]

  process.stdout.write('[m2] ===== ACCEPTANCE =====\n')
  let failures = 0
  for (const item of acceptance) {
    if (!item.ok) failures += 1
    process.stdout.write(`${item.ok ? 'PASS' : 'FAIL'}  ${item.label}\n      ${item.detail}\n`)
  }
  process.stdout.write(`[m2] ${acceptance.length - failures}/${acceptance.length} acceptance criteria passed\n`)
  if (failures > 0) process.exitCode = 1
}

process.on('SIGINT', () => shutdown('SIGINT', 130))
process.on('SIGTERM', () => shutdown('SIGTERM', 143))

setTimeout(() => {
  if (!shuttingDown) {
    process.stdout.write('[m2] hard time limit reached\n')
    shutdown('hard time limit', 1)
  }
}, (seconds + 20) * 1000)
