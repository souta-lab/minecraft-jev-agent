#!/usr/bin/env node
// Offline fixtures for the terminal M2 inventory predicate.
import assert from 'node:assert/strict'
import {
  M2_CAUSAL_CHAIN,
  M2_CONTROL_TIMEOUT_MS,
  M2_CRITERIA,
  M3_CRITERIA,
  runAcceptance,
  runM3Acceptance,
} from './m2-acceptance.mjs'

let checks = 0
const ok = (label) => {
  checks += 1
  console.log(`  ok ${checks} - ${label}`)
}
function capture() {
  const lines = []
  return { lines, write: (line) => lines.push(line), text: () => lines.join('\n') }
}

const consumedIntermediates = {
  runId: 'run-fixture',
  status: { truth: { inventory: { charcoal: 0, iron_ingot: 0, iron_pickaxe: 1 } } },
  stats: { wedge: false, goalComplete: true },
  milestone: 'iron_pickaxe',
}

{
  const out = capture()
  const code = await runAcceptance({
    request: async () => consumedIntermediates,
    expectedRunId: 'run-fixture',
    write: out.write,
    sockPath: '/tmp/fixture.sock',
  })
  assert.equal(code, 0, out.text())
  assert.match(out.text(), /PASS iron_pickaxe >= 1 \(observed 1\)/)
  assert.match(out.text(), /history: charcoal \+ iron_ingot delegated to exact-run m2-watch/)
  assert.doesNotMatch(out.text(), /FAIL charcoal|FAIL iron_ingot/)
  assert.match(out.text(), /RESULT: PASS/)
  ok('consumed charcoal/ingots do not false-FAIL a terminal iron pickaxe')
}

{
  const out = capture()
  const code = await runAcceptance({
    request: async () => ({ ...consumedIntermediates, status: { truth: { inventory: { iron_ingot: 7, charcoal: 2 } } } }),
    expectedRunId: 'run-fixture',
    write: out.write,
    sockPath: '/tmp/fixture.sock',
  })
  assert.equal(code, 1)
  assert.match(out.text(), /FAIL iron_pickaxe >= 1 \(observed 0\)/)
  assert.match(out.text(), /RESULT: FAIL/)
  ok('intermediate materials without the crafted pickaxe do not satisfy terminal M2')
}

{
  const out = capture()
  const code = await runAcceptance({
    request: async () => consumedIntermediates,
    expectedRunId: 'run-other',
    write: out.write,
    sockPath: '/tmp/fixture.sock',
  })
  assert.equal(code, 2)
  assert.match(out.text(), /RESULT: UNKNOWN \(run scope mismatch/)
  assert.doesNotMatch(out.text(), /PASS iron_pickaxe|FAIL iron_pickaxe/)
  ok('run mismatch is UNKNOWN before terminal inventory evaluation')
}

{
  const out = capture()
  const code = await runAcceptance({
    request: async () => null,
    expectedRunId: 'run-fixture',
    write: out.write,
    sockPath: '/tmp/missing.sock',
  })
  assert.equal(code, 2)
  assert.match(out.text(), /live: unavailable/)
  ok('unreadable resident never fabricates terminal evidence')
}

{
  assert.deepEqual(M2_CAUSAL_CHAIN, ['charcoal', 'iron_ingot', 'iron_pickaxe'])
  assert.deepEqual(M2_CRITERIA, [{ item: 'iron_pickaxe', need: 1, requires: 'iron_ingot' }])
  ok('M2 terminal criteria contain only the durable pickaxe fact')
}

{
  assert.deepEqual(M3_CRITERIA, [{ item: 'diamond_pickaxe', need: 1, requires: 'iron_pickaxe' }])
  const out = capture()
  const code = await runM3Acceptance({
    request: async () => ({ ...consumedIntermediates, status: { truth: { inventory: { diamond_pickaxe: 1 } } } }),
    expectedRunId: 'run-fixture',
    write: out.write,
    sockPath: '/tmp/fixture.sock',
  })
  assert.equal(code, 0, out.text())
  assert.match(out.text(), /PASS diamond_pickaxe >= 1/)
  ok('M3 remains an independent diamond-pickaxe terminal check')
}

assert.equal(M2_CONTROL_TIMEOUT_MS, 10_000)
ok('resident report timeout remains 10s')

console.log(`m2-acceptance: ${checks}/${checks} checks passed`)
