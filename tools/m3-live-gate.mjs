#!/usr/bin/env bun
// m3-live-gate: the executable close/no-close gate for the CURRENT M3 contract
// (12 Eyes of Ender). It delegates every fact to tools/m3-gate.mjs; it exists so
// the milestone-status command surface mirrors the M2 split.
//
// An exact resident runId is mandatory. `--since` is accepted as a diagnostic
// annotation only; without `--run R` (or M3_RUN_ID=R) this command cannot PASS.
// The delegated gate reads only R-bound evidence, so inventory (ender_pearl,
// blaze_rod, ender_eye) and model-authority facts cannot be borrowed from
// different resident lifetimes. Deterministic/fallback authority is UNKNOWN,
// never PASS.
//
// Exit: 0 = PASS, 1 = known current-M3 failure, 2 = UNKNOWN.
import { pathToFileURL } from 'node:url'
import {
  M3_GATE_CONTROL_SOCK,
  M3_GATE_DECISIONS,
  M3_GATE_LOG,
  M3_GATE_RUNNER_OUT,
  M3_GATE_SNAPSHOT_DIR,
  M3_RUN_RESULT,
  RUN_ID_RE,
  requestedM3RunId,
  runM3Gate,
} from './m3-gate.mjs'

export const CURRENT_M3 = 'twelve_eyes_of_ender'

/** Compatibility helper for callers that expect an exact-run resolver. */
export function exactRunId(argv = process.argv.slice(2), env = process.env) {
  try {
    return requestedM3RunId(argv, env)
  } catch {
    return null
  }
}

export function hasRunScope(argv = process.argv.slice(2), env = process.env) {
  const runId = exactRunId(argv, env)
  return runId !== null && RUN_ID_RE.test(runId)
}

function optionValue(argv, name) {
  const index = argv.indexOf(name)
  return index === -1 ? null : argv[index + 1] ?? null
}

/** Forward only evidence-reader options. `--since` is deliberately not used for acceptance. */
export function gateOptions(argv = []) {
  return {
    logPath: optionValue(argv, '--log') ?? M3_GATE_LOG,
    snapshotDir: optionValue(argv, '--snapshot-dir') ?? M3_GATE_SNAPSHOT_DIR,
    decisionsPath: optionValue(argv, '--decisions') ?? M3_GATE_DECISIONS,
    runnerOutPath: optionValue(argv, '--runner-out') ?? M3_GATE_RUNNER_OUT,
    controlSocketPath: optionValue(argv, '--control-socket') ?? M3_GATE_CONTROL_SOCK,
    json: argv.includes('--json'),
  }
}

function statusForCode(code) {
  return code === 0 ? 'PASS' : code === 1 ? 'FAIL' : 'UNKNOWN'
}

export async function runGate({
  argv = process.argv.slice(2),
  env = process.env,
  readEvidence = null,
  policyEvidence = null,
  policySocket = undefined,
  write = (line) => process.stdout.write(`${line}\n`),
} = {}) {
  const runId = exactRunId(argv, env)
  const options = gateOptions(argv)
  if (runId === null) {
    if (options.json) {
      write(JSON.stringify({ id: 'M3', status: 'UNKNOWN', reason: 'exact_run_scope_required', runId: null }))
    } else {
      write(`M3_LIVE_GATE current=${CURRENT_M3}`)
      write('M3_LIVE_RESULT status=UNKNOWN reason=exact_run_scope_required runId=none')
    }
    return 2
  }

  if (!options.json) write(`M3_LIVE_GATE current=${CURRENT_M3} runId=${runId}`)
  let delegateResult = ''
  const code = await runM3Gate({
    expectedRunId: runId,
    readEvidence,
    policyEvidence,
    policySocket,
    logPath: options.logPath,
    snapshotDir: options.snapshotDir,
    decisionsPath: options.decisionsPath,
    runnerOutPath: options.runnerOutPath,
    controlSocketPath: options.controlSocketPath,
    json: options.json,
    write: (line) => {
      delegateResult = String(line)
      write(line)
    },
  })
  if (!options.json) {
    const match = new RegExp(`${M3_RUN_RESULT} status=(PASS|FAIL|UNKNOWN) reason=([^ ]+) runId=${runId}`).exec(delegateResult)
    const status = match?.[1] ?? statusForCode(code)
    const reason = match?.[2] ?? 'delegated_current_m3_gate'
    write(`M3_LIVE_RESULT status=${status} reason=${reason} runId=${runId}`)
  }
  return code
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  try {
    process.exitCode = await runGate()
  } catch (error) {
    process.stderr.write(`M3_LIVE_GATE_ERROR ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 2
  }
}
