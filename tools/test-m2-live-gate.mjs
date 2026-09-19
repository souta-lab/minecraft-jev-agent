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
  ok('PASS requires exact-run history and terminal state PASS')
}
{
  const result = combineEvidence(1, 0)
  assert.equal(result.code, 1)
  assert.equal(result.reason, 'causal_chain_incomplete')
  ok('incomplete history is FAIL even when terminal state passes')
}
{
  const result = combineEvidence(0, 1)
  assert.equal(result.code, 1)
  assert.equal(result.reason, 'terminal_state_incomplete')
  ok('missing terminal target is FAIL even when history passes')
}
{
  const result = combineEvidence(2, 0)
  assert.equal(result.code, 2)
  assert.equal(result.reason, 'causal_chain_unavailable')
  ok('unreadable historical evidence is UNKNOWN')
}
{
  const result = combineEvidence(2, 1)
  assert.equal(result.code, 1)
  assert.equal(result.reason, 'terminal_state_incomplete')
  ok('known terminal failure outranks unavailable history')
}
{
  const result = combineEvidence(99, 0)
  assert.equal(result.code, 2)
  assert.equal(result.reason, 'causal_chain_unavailable')
  ok('unexpected child exit is UNKNOWN, never fabricated PASS')
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
  ok('close/no-close gate requires exact runId, never timestamp-only scope')
}
{
  const calls = []
  const runner = async (script, args) => {
    calls.push({ script, args })
    return { code: 0, stdout: '', stderr: '' }
  }
  const code = await runGate({ argv: ['--run', 'run-abc'], env: {}, runner, write: () => undefined })
  assert.equal(code, 0)
  assert.deepEqual(calls[0], { script: WATCH, args: ['--run', 'run-abc'] })
  assert.deepEqual(calls[1], { script: ACCEPTANCE, args: ['--run', 'run-abc'] })
  ok('exact runId is forwarded to history and terminal children')
}
{
  let called = false
  const lines = []
  const code = await runGate({
    argv: ['--since', '2026-09-18T14:00:00Z', '--log', '/tmp/run.log'], env: {},
    runner: async () => { called = true; throw new Error('runner must not execute without exact runId') },
    write: (line) => lines.push(line),
  })
  assert.equal(code, 2)
  assert.equal(called, false)
  assert.match(lines.join('\n'), /status=UNKNOWN reason=exact_run_scope_required/)
  ok('timestamp-only scope cannot produce live acceptance')
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
    env: {}, runner, write: (line) => lines.push(line),
  })
  assert.equal(code, 0)
  assert.deepEqual(calls[0], { script: WATCH, args: ['--run', 'run-abc', '--since', '2026-09-18T14:00:00Z', '--log', '/tmp/run.log'] })
  assert.deepEqual(calls[1], { script: ACCEPTANCE, args: ['--run', 'run-abc'] })
  assert.match(lines.join('\n'), /M2_LIVE_RESULT status=PASS reason=closed_loop_m2_verified/)
  ok('exact run join may carry a diagnostic timestamp lower bound')
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
  ok('M2_RUN_ID env scope is inherited by both children')
}

console.log(`m2-live-gate: ${checks}/11 checks passed`)
