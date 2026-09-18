#!/usr/bin/env node
import assert from 'node:assert/strict'
import { combineEvidence, hasRunScope, runGate, WATCH, ACCEPTANCE } from './m2-live-gate.mjs'

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
  assert.equal(hasRunScope(['--since', '2026-09-18T14:00:00Z'], {}), true)
  assert.equal(hasRunScope([], { M2_SINCE: '2026-09-18T14:00:00Z' }), true)
  assert.equal(hasRunScope([], {}), false)
  assert.equal(hasRunScope(['--log', '/tmp/run.log'], {}), false)
  ok('run scope must come from --since or M2_SINCE')
}

{
  let called = false
  const lines = []
  const code = await runGate({
    argv: ['--log', '/tmp/run.log'],
    env: {},
    runner: async () => {
      called = true
      throw new Error('runner must not execute without a run scope')
    },
    write: (line) => lines.push(line),
  })
  assert.equal(code, 2)
  assert.equal(called, false)
  assert.match(lines.join('\n'), /M2_LIVE_RESULT status=UNKNOWN reason=run_scope_required watch=2 acceptance=2/)
  ok('gate refuses all-time evidence before reading either child')
}

{
  const calls = []
  const lines = []
  const runner = async (script, args) => {
    calls.push({ script, args })
    if (script === WATCH) {
      return { code: 0, stdout: 'M2_REQUIRED status=COMPLETE\n', stderr: '' }
    }
    if (script === ACCEPTANCE) {
      return { code: 0, stdout: 'RESULT: PASS\n', stderr: '' }
    }
    throw new Error(`unexpected script ${script}`)
  }
  const code = await runGate({
    argv: ['--since', '2026-09-18T14:00:00Z', '--log', '/tmp/run.log', '--ignored', 'x'],
    env: {},
    runner,
    write: (line) => lines.push(line),
  })
  assert.equal(code, 0)
  assert.deepEqual(calls[0], {
    script: WATCH,
    args: ['--since', '2026-09-18T14:00:00Z', '--log', '/tmp/run.log'],
  })
  assert.deepEqual(calls[1], { script: ACCEPTANCE, args: [] })
  assert.match(lines.join('\n'), /M2_LIVE_RESULT status=PASS reason=closed_loop_m2_verified watch=0 acceptance=0/)
  ok('CLI forwards only run-scope watch args and combines both child results')
}

{
  const calls = []
  const runner = async (script, args, options) => {
    calls.push({ script, args, env: options?.env })
    return { code: 0, stdout: '', stderr: '' }
  }
  const env = { M2_SINCE: '2026-09-18T14:00:00Z' }
  const code = await runGate({ argv: [], env, runner, write: () => undefined })
  assert.equal(code, 0)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0].env, env)
  assert.deepEqual(calls[1].env, env)
  ok('M2_SINCE scope is inherited by both child processes')
}

console.log(`m2-live-gate: ${checks}/10 checks passed`)
