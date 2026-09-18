#!/usr/bin/env node
import assert from 'node:assert/strict'
import { basename } from 'node:path'
import { buildWatchArgs, classifyGate, parseGateArgs, runGate } from './m2-gate.mjs'

let checks = 0
function ok(label, fn) {
  fn()
  checks += 1
  console.log(`ok ${checks} - ${label}`)
}

ok('gate refuses unscoped all-time evidence', () => {
  assert.throws(() => parseGateArgs([], {}), /run scope required/)
})

ok('--since overrides M2_SINCE and --log is forwarded', () => {
  const parsed = parseGateArgs(['--since', '2026-09-18T14:00:00Z', '--log', '/tmp/buddy.log'], {
    M2_SINCE: '2020-01-01T00:00:00Z',
  })
  assert.deepEqual(parsed, { since: '2026-09-18T14:00:00Z', log: '/tmp/buddy.log' })
  const watch = buildWatchArgs(parsed)
  assert.equal(basename(watch[0]), 'm2-watch.mjs')
  assert.deepEqual(watch.slice(1), ['--since', '2026-09-18T14:00:00Z', '--log', '/tmp/buddy.log'])
})

ok('unknown CLI arguments fail loudly', () => {
  assert.throws(() => parseGateArgs(['--sicne', 'x'], {}), /unknown argument/)
})

ok('both causal chain and live inventory are required for PASS', () => {
  assert.deepEqual(classifyGate(0, 0), { code: 0, status: 'PASS' })
  assert.deepEqual(classifyGate(1, 0), { code: 1, status: 'FAIL' })
  assert.deepEqual(classifyGate(0, 1), { code: 1, status: 'FAIL' })
})

ok('unavailable evidence dominates FAIL/PASS', () => {
  assert.deepEqual(classifyGate(2, 0), { code: 2, status: 'UNAVAILABLE' })
  assert.deepEqual(classifyGate(0, 2), { code: 2, status: 'UNAVAILABLE' })
})

function fakeSpawnFor(watchCode, acceptanceCode) {
  return (_node, args) => {
    const script = basename(args[0])
    if (script === 'm2-watch.mjs') return { status: watchCode, signal: null, stdout: 'watch-output\n', stderr: '' }
    if (script === 'm2-acceptance.mjs') return { status: acceptanceCode, signal: null, stdout: 'acceptance-output\n', stderr: '' }
    throw new Error(`unexpected script ${script}`)
  }
}

ok('combined runner prints one authoritative PASS line', () => {
  let output = ''
  const code = runGate(
    { since: '2026-09-18T14:00:00Z', log: '/tmp/buddy.log' },
    { spawn: fakeSpawnFor(0, 0), env: {}, write: (text) => { output += text } },
  )
  assert.equal(code, 0)
  assert.match(output, /M2_WATCH_EXIT code=0/)
  assert.match(output, /M2_ACCEPTANCE_EXIT code=0/)
  assert.match(output, /M2_EXIT_GATE status=PASS watch=0 acceptance=0/)
})

ok('combined runner stays FAIL when markers pass but inventory does not', () => {
  let output = ''
  const code = runGate(
    { since: '2026-09-18T14:00:00Z', log: null },
    { spawn: fakeSpawnFor(0, 1), env: {}, write: (text) => { output += text } },
  )
  assert.equal(code, 1)
  assert.match(output, /M2_EXIT_GATE status=FAIL watch=0 acceptance=1/)
})

ok('combined runner propagates unavailable evidence', () => {
  let output = ''
  const code = runGate(
    { since: '2026-09-18T14:00:00Z', log: null },
    { spawn: fakeSpawnFor(2, 0), env: {}, write: (text) => { output += text } },
  )
  assert.equal(code, 2)
  assert.match(output, /M2_EXIT_GATE status=UNAVAILABLE watch=2 acceptance=0/)
})

console.log(`m2-gate: ${checks}/8 checks passed`)
