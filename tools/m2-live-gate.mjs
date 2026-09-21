#!/usr/bin/env bun
// m2-live-gate: the executable close/no-close gate for the CURRENT M2
// contract (diamond -> Nether-gate). The historical iron-age tools remain
// available for replay, but this command must never evaluate that old chain.
//
// An exact resident runId is mandatory. `--since` is accepted as a diagnostic
// annotation only; without `--run R` (or M2_RUN_ID=R) this command cannot PASS.
// The delegated gate reads only R-bound evidence, so inventory, the ordered
// portal chain, and model-authority facts cannot be borrowed from different
// resident lifetimes. Deterministic/fallback authority is UNKNOWN, never PASS.
//
// Exit: 0 = PASS, 1 = known current-M2 failure, 2 = UNKNOWN.
import { pathToFileURL } from 'node:url'
import {
  M2_GATE_LOG,
  M2_GATE_SNAPSHOT_DIR,
  M2_GATE_DECISIONS,
  M2_GATE_RUNNER_OUT,
  M2_GATE_CONTROL_SOCK,
  M2_RUN_RESULT,
  RUN_ID_RE,
  runM2Gate,
  requestedRunId,
} from './m2-gate.mjs'

export const CURRENT_M2 = 'diamond_to_nether_gate'

/** Compatibility helper for callers that used the former wrapper API. */
export function exactRunId(argv = process.argv.slice(2), env = process.env) {
  try {
    return requestedRunId(argv, env)
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
    logPath: optionValue(argv, '--log') ?? M2_GATE_LOG,
    snapshotDir: optionValue(argv, '--snapshot-dir') ?? M2_GATE_SNAPSHOT_DIR,
    decisionsPath: optionValue(argv, '--decisions') ?? M2_GATE_DECISIONS,
    runnerOutPath: optionValue(argv, '--runner-out') ?? M2_GATE_RUNNER_OUT,
    controlSocketPath: optionValue(argv, '--control-socket') ?? M2_GATE_CONTROL_SOCK,
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
      write(JSON.stringify({ id: 'M2', status: 'UNKNOWN', reason: 'exact_run_scope_required', runId: null }))
    } else {
      write(`M2_LIVE_GATE current=${CURRENT_M2}`)
      write('M2_LIVE_RESULT status=UNKNOWN reason=exact_run_scope_required runId=none')
    }
    return 2
  }

  if (!options.json) write(`M2_LIVE_GATE current=${CURRENT_M2} runId=${runId}`)
  let delegateResult = ''
  const code = await runM2Gate({
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
    const match = new RegExp(`${M2_RUN_RESULT} status=(PASS|FAIL|UNKNOWN) reason=([^ ]+) runId=${runId}`).exec(delegateResult)
    const status = match?.[1] ?? statusForCode(code)
    const reason = match?.[2] ?? 'delegated_current_m2_gate'
    write(`M2_LIVE_RESULT status=${status} reason=${reason} runId=${runId}`)
  }
  return code
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  try {
    process.exitCode = await runGate()
  } catch (error) {
    process.stderr.write(`M2_LIVE_GATE_ERROR ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 2
  }
}
