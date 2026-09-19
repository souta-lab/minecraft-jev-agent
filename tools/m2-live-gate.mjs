#!/usr/bin/env node
// m2-live-gate: combine exact-run causal evidence with the resident inventory
// acceptance for the SAME run. This is the close/no-close gate for the M2 path.
//
// PASS requires BOTH:
//   1. an ordered PREREQ_OPTION -> FURNACE_READY -> SMELT_DONE chain scoped to
//      the explicit resident runId; and
//   2. the live resident M2 inventory contract observed while the resident still
//      reports that same runId: charcoal >= 1 / iron_ingot >= 3 / iron_pickaxe >= 1.
//
// The diamond-pickaxe terminal in MILESTONES.md is historical spec drift and is
// deliberately NOT part of M2. It is owned by the SEPARATE M3 acceptance
// (tools/m2-acceptance.mjs `M3_CRITERIA` / `runM3Acceptance`, CLI `--m3`),
// which this gate never consults, so M2 and M3 cannot drift back into each
// other.
//
// `--since` remains useful for diagnosis in m2-watch, but is not a sufficient
// join key for this close/no-close gate. An explicit --run (or M2_RUN_ID) is
// required so causal and inventory evidence can never come from two lifetimes.
//
// Exit: 0 = PASS, 1 = FAIL (at least one known criterion failed),
//       2 = UNKNOWN (no known failure, but evidence is unavailable/unreadable).
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

/** Close/no-close acceptance requires an exact resident lifetime, not timestamp only. */
export function hasRunScope(argv, env = process.env) {
  return exactRunId(argv, env) !== null
}

function acceptanceArgs(argv, env = process.env) {
  const runId = exactRunId(argv, env)
  if (runId === null) return []
  const args = forwardedWatchArgs(argv)
  const out = []
  if (args.includes('--run')) out.push('--run', runId)
  const logIndex = args.indexOf('--log')
  if (logIndex !== -1 && typeof args[logIndex + 1] === 'string') out.push('--log', args[logIndex + 1])
  return out
}

/** The inventory evidence source m2-acceptance reported (live socket vs resident snapshot). */
export function inventoryEvidenceSource(stdout) {
  const match = /^evidence: (live-socket|run-scoped-snapshot)$/m.exec(typeof stdout === 'string' ? stdout : '')
  return match?.[1] ?? 'unknown'
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
  write('--- causal evidence (m2-watch) ---')
  if (watch.stdout.trim()) write(watch.stdout.trimEnd())
  if (watch.stderr.trim()) write(watch.stderr.trimEnd())
  write('--- live inventory (m2-acceptance) ---')
  if (acceptance.stdout.trim()) write(acceptance.stdout.trimEnd())
  if (acceptance.stderr.trim()) write(acceptance.stderr.trimEnd())

  const result = combineEvidence(watch.code, acceptance.code)
  const inventorySource = inventoryEvidenceSource(acceptance.stdout)
  write(
    `M2_LIVE_RESULT status=${result.status} reason=${result.reason} runId=${runId} watch=${watch.code} acceptance=${acceptance.code} inventorySource=${inventorySource}`,
  )
  return result.code
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invokedDirectly) process.exitCode = await runGate()
