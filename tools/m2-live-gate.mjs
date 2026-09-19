#!/usr/bin/env node
// m2-live-gate: join exact-run historical M2 evidence with the terminal resident
// inventory predicate for the SAME run.
//
// PASS requires BOTH:
//   1. m2-watch proves, in order and under the explicit resident runId:
//      PREREQ_OPTION -> FURNACE_READY -> SMELT_DONE(charcoal)
//      -> SMELT_DONE(iron_ingot); and
//   2. m2-acceptance observes iron_pickaxe >= 1 while the resident still reports
//      that same runId.
//
// Charcoal and iron ingots are consumable history, not terminal inventory facts.
// Requiring them to coexist with the crafted pickaxe makes correct progression
// erase its own evidence.
//
// `--since` is diagnostic only. Exact --run (or M2_RUN_ID) is required for this
// close/no-close join.
// Exit: 0 PASS, 1 FAIL, 2 UNKNOWN.
import { execFile } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const WATCH = join(HERE, 'm2-watch.mjs')
export const ACCEPTANCE = join(HERE, 'm2-acceptance.mjs')
const RUN_ID_RE = /^run-[A-Za-z0-9-]+$/

export function combineEvidence(watchCode, acceptanceCode) {
  const known = new Set([0, 1, 2])
  const watch = known.has(watchCode) ? watchCode : 2
  const acceptance = known.has(acceptanceCode) ? acceptanceCode : 2

  if (watch === 1 || acceptance === 1) {
    return {
      code: 1,
      status: 'FAIL',
      reason:
        watch === 1 && acceptance === 1
          ? 'causal_chain_and_inventory_incomplete'
          : watch === 1
            ? 'causal_chain_incomplete'
            : 'inventory_incomplete',
    }
  }
  if (watch === 2 || acceptance === 2) {
    return {
      code: 2,
      status: 'UNKNOWN',
      reason:
        watch === 2 && acceptance === 2
          ? 'causal_chain_and_inventory_unavailable'
          : watch === 2
            ? 'causal_chain_unavailable'
            : 'inventory_unavailable',
    }
  }
  return { code: 0, status: 'PASS', reason: 'closed_loop_m2_verified' }
}

export function runNode(script, args = [], { env = process.env } = {}) {
  return new Promise((resolveResult) => {
    execFile(
      process.execPath,
      [script, ...args],
      { encoding: 'utf8', env, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 2
        resolveResult({ code, stdout: stdout ?? '', stderr: stderr ?? '' })
      },
    )
  })
}

function forwardedWatchArgs(argv) {
  const out = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if ((arg === '--log' || arg === '--since' || arg === '--run') && argv[i + 1]) {
      out.push(arg, argv[i + 1])
      i += 1
    }
  }
  return out
}

export function exactRunId(argv, env = process.env) {
  const args = forwardedWatchArgs(argv)
  const runIndex = args.indexOf('--run')
  const raw =
    runIndex !== -1 && typeof args[runIndex + 1] === 'string'
      ? args[runIndex + 1]
      : typeof env.M2_RUN_ID === 'string'
        ? env.M2_RUN_ID
        : null
  if (raw === null || raw.trim() === '') return null
  const runId = raw.trim()
  return RUN_ID_RE.test(runId) ? runId : null
}

export function hasRunScope(argv, env = process.env) {
  return exactRunId(argv, env) !== null
}

function acceptanceArgs(argv, env = process.env) {
  const runId = exactRunId(argv, env)
  if (runId === null) return []
  const args = forwardedWatchArgs(argv)
  return args.includes('--run') ? ['--run', runId] : []
}

export async function runGate({
  argv = process.argv.slice(2),
  runner = runNode,
  write = console.log,
  env = process.env,
} = {}) {
  const runId = exactRunId(argv, env)
  if (runId === null) {
    write('M2_LIVE_GATE')
    write('M2_LIVE_RESULT status=UNKNOWN reason=exact_run_scope_required watch=2 acceptance=2')
    return 2
  }

  const [watch, acceptance] = await Promise.all([
    runner(WATCH, forwardedWatchArgs(argv), { env }),
    runner(ACCEPTANCE, acceptanceArgs(argv, env), { env }),
  ])

  write(`M2_LIVE_GATE runId=${runId}`)
  write('--- historical causal evidence (m2-watch) ---')
  if (watch.stdout.trim()) write(watch.stdout.trimEnd())
  if (watch.stderr.trim()) write(watch.stderr.trimEnd())
  write('--- terminal live inventory (m2-acceptance) ---')
  if (acceptance.stdout.trim()) write(acceptance.stdout.trimEnd())
  if (acceptance.stderr.trim()) write(acceptance.stderr.trimEnd())

  const result = combineEvidence(watch.code, acceptance.code)
  write(`M2_LIVE_RESULT status=${result.status} reason=${result.reason} runId=${runId} watch=${watch.code} acceptance=${acceptance.code}`)
  return result.code
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invokedDirectly) process.exitCode = await runGate()
