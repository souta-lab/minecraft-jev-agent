#!/usr/bin/env node
// m2-gate: one authoritative M2 exit check.
//
// PASS requires BOTH:
//   1. a run-scoped ordered causal chain in buddy.log:
//      PREREQ_OPTION -> FURNACE_READY -> SMELT_DONE
//   2. the live resident inventory acceptance from m2-acceptance:
//      charcoal >= 1, iron_ingot >= 3, iron_pickaxe >= 1
//
// This intentionally refuses to run without an explicit run scope. Long-lived
// buddy.log files contain evidence from old attempts; all-time markers must never
// be enough to close a live acceptance issue.
//
// Usage:
//   RUN_START=$(date -Iseconds)
//   # start/reload the clean attempt
//   npm run m2-gate -- --since "$RUN_START"
//
// Environment:
//   M2_SINCE         same as --since
//   BUDDY_LOG        consumed by m2-watch (or use --log)
//   M2_CONTROL_SOCK  consumed by m2-acceptance
//
// Exit: 0 PASS, 1 FAIL/incomplete, 2 unavailable/invalid scope.
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const WATCH = join(HERE, 'm2-watch.mjs')
const ACCEPTANCE = join(HERE, 'm2-acceptance.mjs')

export function parseGateArgs(argv, env = process.env) {
  let since = env.M2_SINCE ?? null
  let log = null
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--since') {
      const value = argv[i + 1]
      if (!value) throw new Error('--since requires a value')
      since = value
      i += 1
      continue
    }
    if (arg === '--log') {
      const value = argv[i + 1]
      if (!value) throw new Error('--log requires a value')
      log = value
      i += 1
      continue
    }
    throw new Error(`unknown argument: ${arg}`)
  }
  if (since === null || String(since).trim() === '') throw new Error('run scope required: pass --since <ISO|epoch-ms> or set M2_SINCE')
  return { since: String(since), log }
}

export function buildWatchArgs({ since, log }) {
  const args = [WATCH, '--since', since]
  if (log !== null) args.push('--log', log)
  return args
}

export function classifyGate(watchCode, acceptanceCode) {
  if (watchCode === 2 || acceptanceCode === 2) return { code: 2, status: 'UNAVAILABLE' }
  if (watchCode === 0 && acceptanceCode === 0) return { code: 0, status: 'PASS' }
  return { code: 1, status: 'FAIL' }
}

function normalizeExit(status, signal) {
  if (typeof status === 'number') return status
  return signal === null ? 2 : 2
}

export function runTool(scriptArgs, { env = process.env, spawn = spawnSync } = {}) {
  const result = spawn(process.execPath, scriptArgs, {
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return {
    code: normalizeExit(result.status, result.signal ?? null),
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

export function emitToolResult(label, result, write = (text) => process.stdout.write(text)) {
  write(`\n=== ${label} ===\n`)
  if (result.stdout) write(result.stdout.endsWith('\n') ? result.stdout : `${result.stdout}\n`)
  if (result.stderr) write(result.stderr.endsWith('\n') ? result.stderr : `${result.stderr}\n`)
  write(`${label}_EXIT code=${result.code}\n`)
}

export function runGate(args, options = {}) {
  const env = options.env ?? process.env
  const spawn = options.spawn ?? spawnSync
  const write = options.write ?? ((text) => process.stdout.write(text))
  const watch = runTool(buildWatchArgs(args), { env, spawn })
  emitToolResult('M2_WATCH', watch, write)
  const acceptance = runTool([ACCEPTANCE], { env, spawn })
  emitToolResult('M2_ACCEPTANCE', acceptance, write)
  const result = classifyGate(watch.code, acceptance.code)
  write(`\nM2_EXIT_GATE status=${result.status} watch=${watch.code} acceptance=${acceptance.code} scope=${args.since}\n`)
  return result.code
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  let args
  try {
    args = parseGateArgs(process.argv.slice(2))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stdout.write(`M2_EXIT_GATE status=UNAVAILABLE reason=${JSON.stringify(message)}\n`)
    process.exit(2)
  }
  process.exit(runGate(args))
}
