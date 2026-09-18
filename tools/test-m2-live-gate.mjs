#!/usr/bin/env node
import assert from 'node:assert/strict'
import { combineEvidence, runGate, WATCH, ACCEPTANCE } from './m2-live-gate.mjs'

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

console.log(`m2-live-gate: ${checks}/7 checks passed`)
