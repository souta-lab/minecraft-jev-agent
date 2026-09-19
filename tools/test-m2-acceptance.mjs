#!/usr/bin/env node
import assert from 'node:assert/strict'
import { M2_CONTROL_TIMEOUT_MS, M2_CRITERIA, M2_TERMINAL_ITEM, runAcceptance } from './m2-acceptance.mjs'

let checks = 0
const ok = (label) => {
  checks += 1
  console.log(`  ok ${checks} - ${label}`)
}

function capture() {
  const lines = []
  return { lines, write: (line) => lines.push(line), text: () => lines.join('\n') }
}

const ironTierOnly = {
  runId: 'run-fixture',
  status: { truth: { inventory: { charcoal: 2, iron_ingot: 3, iron_pickaxe: 1 } } },
  stats: { wedge: false, goalComplete: false },
  milestone: 'iron_pickaxe',
}

// Correct terminal semantics: the consumable earlier rungs need NOT still be in
// inventory. Their same-run history is m2-watch evidence. A diamond pickaxe is
// the durable M2 endpoint.
const diamondAfterConsumption = {
  runId: 'run-fixture',
  status: { truth: { inventory: { diamond_pickaxe: 1, oak_planks: 2 } } },
  stats: { wedge: false, goalComplete: true },
  milestone: 'diamond_pickaxe',
}

const rawDiamondOnly = {
  runId: 'run-fixture',
  status: { truth: { inventory: { diamond: 3, iron_pickaxe: 1 } } },
  stats: { wedge: false, goalComplete: false },
  milestone: 'diamond',
}

{
  const out = capture()
  const code = await runAcceptance({ request: async () => ironTierOnly, write: out.write, sockPath: '/tmp/fixture.sock' })
  assert.equal(code, 1)
  assert.match(out.text(), /FAIL diamond_pickaxe >= 1 \(observed 0\)/)
  assert.doesNotMatch(out.text(), /PASS charcoal|FAIL charcoal|PASS iron_ingot|FAIL iron_ingot/)
  assert.match(out.text(), /RESULT: FAIL/)
  ok('iron tier alone does not close M2')
}

{
  const out = capture()
  const code = await runAcceptance({
    request: async () => diamondAfterConsumption,
    now: () => new Date('2026-09-18T00:00:00.000Z'),
    write: out.write,
    sockPath: '/tmp/fixture.sock',
  })
  assert.equal(code, 0, `terminal diamond must pass after intermediates are consumed:\n${out.text()}`)
  assert.match(out.text(), /history: delegated to exact-run m2-watch/)
  assert.match(out.text(), /PASS diamond_pickaxe >= 1 \(observed 1\)/)
  assert.doesNotMatch(out.text(), /FAIL charcoal|FAIL iron_ingot|FAIL iron_pickaxe/)
  assert.match(out.text(), /RESULT: PASS/)
  ok('consumed charcoal/ingots do not create a false negative after diamond pickaxe exists')
}

{
  const out = capture()
  const code = await runAcceptance({ request: async () => rawDiamondOnly, write: out.write, sockPath: '/tmp/fixture.sock' })
  assert.equal(code, 1)
  assert.match(out.text(), /FAIL diamond_pickaxe >= 1 \(observed 0\)/)
  ok('raw diamonds are not the M2 terminal target')
}

{
  const out = capture()
  const enveloped = { id: 'm2', ok: true, data: diamondAfterConsumption }
  const code = await runAcceptance({
    request: async () => enveloped,
    expectedRunId: 'run-fixture',
    write: out.write,
    sockPath: '/tmp/fixture.sock',
  })
  assert.equal(code, 0)
  assert.match(out.text(), /expectedRunId: run-fixture/)
  assert.match(out.text(), /runId: run-fixture/)
  assert.match(out.text(), /PASS diamond_pickaxe >= 1 \(observed 1\)/)
  ok('matching exact run is accepted')
}

{
  const out = capture()
  const code = await runAcceptance({
    request: async () => diamondAfterConsumption,
    expectedRunId: 'run-other',
    write: out.write,
    sockPath: '/tmp/fixture.sock',
  })
  assert.equal(code, 2)
  assert.match(out.text(), /RESULT: UNKNOWN \(run scope mismatch expected=run-other observed=run-fixture\)/)
  assert.doesNotMatch(out.text(), /PASS diamond_pickaxe|FAIL diamond_pickaxe/)
  ok('mismatched run is UNKNOWN before terminal inventory is evaluated')
}

{
  const out = capture()
  const code = await runAcceptance({
    request: async () => null,
    expectedRunId: 'run-fixture',
    write: out.write,
    sockPath: '/tmp/does-not-exist.sock',
  })
  assert.equal(code, 2)
  assert.match(out.text(), /live: unavailable/)
  assert.doesNotMatch(out.text(), /RESULT: (PASS|FAIL)/)
  ok('unreachable socket is UNKNOWN and fabricates no terminal result')
}

assert.deepEqual(M2_CRITERIA, [{ item: 'diamond_pickaxe', need: 1 }])
assert.equal(M2_TERMINAL_ITEM, 'diamond_pickaxe')
ok('snapshot criteria contain only the durable M2 terminal target')

assert.equal(M2_CONTROL_TIMEOUT_MS, 10_000)
ok('resident report timeout remains 10s')

console.log(`m2-acceptance: ${checks}/${checks} checks passed`)
