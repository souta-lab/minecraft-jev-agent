#!/usr/bin/env node
import assert from 'node:assert/strict'
import { combineEvidence, exactRunId, hasRunScope, runGate, WATCH, ACCEPTANCE } from './m2-live-gate.mjs'

let checks = 0
function ok(label) {
  checks += 1
  console.log(`  ok ${checks} - ${label}`)
}

{
  const result = combineEvidence(0, 0)
  assert.deepEqual(result, { code: 0, status: 'PASS', reason: 'closed_loop_m2_verified' })
  ok('PASS requires causal and inventory PASS')
}

{
  const result = combineEvidence(1, 0)
  assert.equal(result.code, 1)
  assert.equal(result.reason, 'causal_chain_incomplete')
  ok('incomplete causal chain is FAIL even when inventory passes')
}

{
  const result = combineEvidence(0, 1)
  assert.equal(result.code, 1)
  assert.equal(result.reason, 'inventory_incomplete')
  ok('incomplete inventory is FAIL even when causal chain passes')
}

{
  const result = combineEvidence(2, 0)
  assert.equal(result.code, 2)
  assert.equal(result.reason, 'causal_chain_unavailable')
  ok('unreadable causal evidence is UNKNOWN when nothing is known to fail')
}

{
  const result = combineEvidence(2, 1)
  assert.equal(result.code, 1)
  assert.equal(result.reason, 'inventory_incomplete')
  ok('a known failure outranks unavailable evidence')
}

{
  const result = combineEvidence(99, 0)
  assert.equal(result.code, 2)
  assert.equal(result.reason, 'causal_chain_unavailable')
  ok('unexpected child exit codes are UNKNOWN, never fabricated PASS')
}

{
  assert.equal(hasRunScope(['--since', '2026-09-18T14:00:00Z'], {}), false)
  assert.equal(hasRunScope(['--run', 'run-abc'], {}), true)
  assert.equal(hasRunScope([], { M2_RUN_ID: 'run-abc' }), true)
  assert.equal(hasRunScope([], { M2_SINCE: '2026-09-18T14:00:00Z' }), false)
  assert.equal(hasRunScope([], {}), false)
  assert.equal(exactRunId(['--run', 'run-abc'], {}), 'run-abc')
  assert.equal(exactRunId([], { M2_RUN_ID: 'run-env' }), 'run-env')
  assert.equal(exactRunId(['--run', 'bad'], {}), null)
  ok('close/no-close gate requires an exact runId, not timestamp-only scope')
}

{
  const calls = []
  const runner = async (script, args) => {
    calls.push({ script, args })
    return { code: 0, stdout: '', stderr: '' }
  }
  const code = await runGate({
    argv: ['--run', 'run-abc'],
    env: {},
    runner,
    write: () => undefined,
  })
  assert.equal(code, 0)
  assert.deepEqual(calls[0], { script: WATCH, args: ['--run', 'run-abc'] })
  assert.deepEqual(calls[1], { script: ACCEPTANCE, args: ['--run', 'run-abc'] })
  ok('exact runId is forwarded to both causal and inventory children')
}

{
  let called = false
  const lines = []
  const code = await runGate({
    argv: ['--since', '2026-09-18T14:00:00Z', '--log', '/tmp/run.log'],
    env: {},
    runner: async () => {
      called = true
      throw new Error('runner must not execute without an exact runId')
    },
    write: (line) => lines.push(line),
  })
  assert.equal(code, 2)
  assert.equal(called, false)
  assert.match(lines.join('\n'), /M2_LIVE_RESULT status=UNKNOWN reason=exact_run_scope_required watch=2 acceptance=2/)
  ok('timestamp-only scope is diagnostic, not sufficient for live acceptance')
}

{
  const calls = []
  const lines = []
  const runner = async (script, args) => {
    calls.push({ script, args })
    if (script === WATCH) return { code: 0, stdout: 'M2_REQUIRED status=COMPLETE\n', stderr: '' }
    if (script === ACCEPTANCE) return { code: 0, stdout: 'runId: run-abc\nRESULT: PASS\n', stderr: '' }
    throw new Error(`unexpected script ${script}`)
  }
  const code = await runGate({
    argv: ['--run', 'run-abc', '--since', '2026-09-18T14:00:00Z', '--log', '/tmp/run.log', '--ignored', 'x'],
    env: {},
    runner,
    write: (line) => lines.push(line),
  })
  assert.equal(code, 0)
  assert.deepEqual(calls[0], {
    script: WATCH,
    args: ['--run', 'run-abc', '--since', '2026-09-18T14:00:00Z', '--log', '/tmp/run.log'],
  })
  assert.deepEqual(calls[1], { script: ACCEPTANCE, args: ['--run', 'run-abc'] })
  assert.match(lines.join('\n'), /M2_LIVE_GATE runId=run-abc/)
  assert.match(lines.join('\n'), /M2_LIVE_RESULT status=PASS reason=closed_loop_m2_verified runId=run-abc watch=0 acceptance=0/)
  ok('exact run join may carry an additional timestamp lower bound without mixing children')
}

{
  const calls = []
  const runner = async (script, args, options) => {
    calls.push({ script, args, env: options?.env })
    return { code: 0, stdout: '', stderr: '' }
  }
  const env = { M2_RUN_ID: 'run-env' }
  const code = await runGate({ argv: [], env, runner, write: () => undefined })
  assert.equal(code, 0)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0].env, env)
  assert.deepEqual(calls[1].env, env)
  assert.deepEqual(calls[0].args, [])
  assert.deepEqual(calls[1].args, [])
  ok('M2_RUN_ID env scope is inherited by both child processes')
}

console.log(`m2-live-gate: ${checks}/11 checks passed`)
