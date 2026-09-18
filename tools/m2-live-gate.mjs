#!/usr/bin/env node
// m2-live-gate: combine run-scoped causal evidence with the resident's current
// inventory acceptance. This is the close/no-close gate for the M2 live path.
//
// PASS requires BOTH:
//   1. an ordered run-scoped PREREQ_OPTION -> FURNACE_READY -> SMELT_DONE chain
//      from tools/m2-watch.mjs; and
//   2. the live resident inventory criteria from tools/m2-acceptance.mjs.
//
// The combined close/no-close gate MUST have an explicit run scope. Without
// --since (or M2_SINCE), m2-watch falls back to all-time buddy.log evidence and
// an old successful attempt could falsely green a fresh run.
//
// Exit: 0 = PASS, 1 = FAIL (at least one known criterion failed),
//       2 = UNKNOWN (no known failure, but evidence is unavailable/unreadable).
import { execFile } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const WATCH = join(HERE, 'm2-watch.mjs')
export const ACCEPTANCE = join(HERE, 'm2-acceptance.mjs')

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

function watchArgs(argv) {
  const out = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if ((arg === '--log' || arg === '--since') && argv[i + 1]) {
      out.push(arg, argv[i + 1])
      i += 1
    }
  }
  return out
}

/** True only when the causal proof is explicitly scoped to this live attempt. */
export function hasRunScope(argv, env = process.env) {
  const args = watchArgs(argv)
  const sinceIndex = args.indexOf('--since')
  if (sinceIndex !== -1 && typeof args[sinceIndex + 1] === 'string' && args[sinceIndex + 1].trim() !== '') return true
  return typeof env.M2_SINCE === 'string' && env.M2_SINCE.trim() !== ''
}

export async function runGate({
  argv = process.argv.slice(2),
  runner = runNode,
  write = console.log,
  env = process.env,
} = {}) {
  if (!hasRunScope(argv, env)) {
    write('M2_LIVE_GATE')
    write('M2_LIVE_RESULT status=UNKNOWN reason=run_scope_required watch=2 acceptance=2')
    return 2
  }

  const [watch, acceptance] = await Promise.all([
    runner(WATCH, watchArgs(argv), { env }),
    runner(ACCEPTANCE, [], { env }),
  ])

  write('M2_LIVE_GATE')
  write('--- causal evidence (m2-watch) ---')
  if (watch.stdout.trim()) write(watch.stdout.trimEnd())
  if (watch.stderr.trim()) write(watch.stderr.trimEnd())
  write('--- live inventory (m2-acceptance) ---')
  if (acceptance.stdout.trim()) write(acceptance.stdout.trimEnd())
  if (acceptance.stderr.trim()) write(acceptance.stderr.trimEnd())

  const result = combineEvidence(watch.code, acceptance.code)
  write(
    `M2_LIVE_RESULT status=${result.status} reason=${result.reason} watch=${watch.code} acceptance=${acceptance.code}`,
  )
  return result.code
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invokedDirectly) process.exitCode = await runGate()
