#!/usr/bin/env node
// test-m2-acceptance: offline fixtures for the M2 acceptance contract and the
// separate M3 diamond-pickaxe acceptance.
//
// M2 contract (authoritative): charcoal >= 1 / iron_ingot >= 3 / iron_pickaxe >= 1,
// joined within one resident run. The diamond-pickaxe terminal is NOT part of M2;
// it is owned by the independent M3 acceptance (M3_CRITERIA / runM3Acceptance).
import assert from 'node:assert/strict'
import * as acceptance from './m2-acceptance.mjs'

const {
  M2_CAUSAL_CHAIN,
  M2_CONTROL_TIMEOUT_MS,
  M2_CRITERIA,
  M3_CAUSAL_CHAIN,
  M3_CRITERIA,
  runAcceptance,
  runM3Acceptance,
} = acceptance

let checks = 0
const ok = (label) => {
  checks += 1
  console.log(`  ok ${checks} - ${label}`)
}

function capture() {
  const lines = []
  return { lines, write: (line) => lines.push(line), text: () => lines.join('\n') }
}

const M2_CHAIN_LINE = 'chain: charcoal -> iron_ingot -> iron_pickaxe'

// The three contracted M2 conditions are met and the diamond pickaxe was never
// crafted (diamond_pickaxe = 0). Under the fixed contract this is a PASS; it
// FAILed while the drifted diamond terminal still gated M2.
const contractedThree = {
  runId: 'run-fixture',
  status: {
    truth: {
      inventory: { charcoal: 2, iron_ingot: 3, iron_pickaxe: 1, diamond_pickaxe: 0, oak_log: 7 },
    },
  },
  stats: { wedge: false, goalComplete: true },
  milestone: 'iron_pickaxe',
}

const diamondComplete = {
  runId: 'run-fixture',
  status: {
    truth: {
      inventory: {
        charcoal: 2,
        iron_ingot: 3,
        iron_pickaxe: 1,
        diamond_pickaxe: 1,
        // Crafting consumed the mined diamonds; the pickaxe is the durable rung.
        diamond: 0,
        oak_log: 7,
      },
    },
  },
  stats: { wedge: false, goalComplete: true },
  milestone: 'diamond_pickaxe',
}

// Raw diamonds without the crafted pickaxe. M2 is already satisfied by the iron
// tier; the uncrafted pickaxe is only an M3 failure.
const rawDiamondOnly = {
  runId: 'run-fixture',
  status: { truth: { inventory: { charcoal: 1, iron_ingot: 3, iron_pickaxe: 1, diamond: 3 } } },
  stats: { wedge: false, goalComplete: false },
  milestone: 'diamond',
}

const missingIngot = {
  runId: 'run-fixture',
  status: { truth: { inventory: { charcoal: 1, iron_pickaxe: 1 } } },
  stats: { wedge: false, goalComplete: false },
  milestone: 'iron_ingot',
}

// RED: inventory satisfying the three contracted conditions with
// diamond_pickaxe = 0 must PASS M2 acceptance (it FAILed before the fix).
{
  const out = capture()
  const code = await runAcceptance({
    request: async () => contractedThree,
    now: () => new Date('2026-09-18T00:00:00.000Z'),
    write: out.write,
    sockPath: '/tmp/fixture.sock',
  })
  assert.equal(
    code,
    0,
    `three contracted M2 conditions with diamond_pickaxe=0 must PASS but the gate returned ${code}:\n${out.text()}`,
  )
  assert.match(out.text(), new RegExp(M2_CHAIN_LINE))
  assert.match(out.text(), /PASS charcoal >= 1 \(observed 2\)/)
  assert.match(out.text(), /PASS iron_ingot >= 3 \(observed 3\)/)
  assert.match(out.text(), /PASS iron_pickaxe >= 1 \(observed 1\)/)
  assert.doesNotMatch(out.text(), /diamond_pickaxe/, `diamond must not appear in M2 output:\n${out.text()}`)
  assert.match(out.text(), /RESULT: PASS/)
  ok('three contracted conditions with diamond_pickaxe=0 -> PASS/exit 0 (diamond absent from M2)')
}

{
  const out = capture()
  const code = await runAcceptance({
    request: async () => diamondComplete,
    now: () => new Date('2026-09-18T00:00:00.000Z'),
    write: out.write,
    sockPath: '/tmp/fixture.sock',
  })
  assert.equal(code, 0, `diamond-complete inventory must also PASS M2 but returned ${code}:\n${out.text()}`)
  assert.match(out.text(), new RegExp(M2_CHAIN_LINE))
  assert.match(out.text(), /PASS charcoal >= 1 \(observed 2\)/)
  assert.match(out.text(), /PASS iron_ingot >= 3 \(observed 3\)/)
  assert.match(out.text(), /PASS iron_pickaxe >= 1 \(observed 1\)/)
  assert.match(out.text(), /milestone: diamond_pickaxe/)
  assert.match(out.text(), /goalComplete: true/)
  assert.match(out.text(), /RESULT: PASS/)
  assert.match(out.text(), /2026-09-18T00:00:00.000Z/)
  assert.match(out.text(), /"cmd":"report"/)
  ok('diamond-complete inventory still PASSes M2 with observed numbers')
}

{
  const out = capture()
  const code = await runAcceptance({
    request: async () => rawDiamondOnly,
    now: () => new Date('2026-09-18T00:00:00.000Z'),
    write: out.write,
    sockPath: '/tmp/fixture.sock',
  })
  assert.equal(code, 0, `raw diamonds must not gate M2; iron tier already passes but got ${code}:\n${out.text()}`)
  assert.doesNotMatch(out.text(), /diamond_pickaxe/)
  assert.match(out.text(), /RESULT: PASS/)
  ok('raw diamonds without the crafted pickaxe do not affect the M2 gate')
}

{
  const out = capture()
  const enveloped = { id: 'm2', ok: true, data: diamondComplete }
  const code = await runAcceptance({
    request: async () => enveloped,
    expectedRunId: 'run-fixture',
    write: out.write,
    sockPath: '/tmp/fixture.sock',
  })
  assert.equal(code, 0, `matching explicit runId must PASS but returned ${code}:\n${out.text()}`)
  assert.match(out.text(), /expectedRunId: run-fixture/)
  assert.match(out.text(), /runId: run-fixture/)
  assert.match(out.text(), /RESULT: PASS/)
  ok('matching explicit runId is accepted and envelope is unwrapped')
}

{
  const out = capture()
  const code = await runAcceptance({
    request: async () => contractedThree,
    expectedRunId: 'run-other',
    write: out.write,
    sockPath: '/tmp/fixture.sock',
  })
  assert.equal(code, 2)
  assert.match(out.text(), /RESULT: UNKNOWN \(run scope mismatch expected=run-other observed=run-fixture\)/)
  assert.doesNotMatch(out.text(), /PASS charcoal|FAIL charcoal/)
  assert.doesNotMatch(out.text(), /chain:/)
  ok('mismatched resident runId -> UNKNOWN/exit 2 before inventory can pass')
}

{
  const out = capture()
  const code = await runAcceptance({
    request: async () => missingIngot,
    expectedRunId: 'run-fixture',
    write: out.write,
    sockPath: '/tmp/fixture.sock',
  })
  assert.equal(code, 1)
  assert.match(out.text(), /PASS charcoal >= 1 \(observed 1\)/)
  assert.match(out.text(), /FAIL iron_ingot >= 3 \(observed 0\)/)
  assert.match(out.text(), /PASS iron_pickaxe >= 1 \(observed 1\)/)
  assert.doesNotMatch(out.text(), /diamond_pickaxe/)
  assert.match(out.text(), /RESULT: FAIL/)
  ok('matching run with missing iron_ingot -> FAIL/exit 1')
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
  assert.doesNotMatch(out.text(), /PASS|FAIL/)
  assert.doesNotMatch(out.text(), /observed \d/)
  assert.doesNotMatch(out.text(), /RESULT: (PASS|FAIL)/)
  assert.doesNotMatch(out.text(), /chain:/)
  ok('unreachable socket -> exit 2 with no fabricated numbers')
}

// M2 criteria are exactly the three contracted conditions; diamond is excluded.
{
  assert.deepEqual(M2_CAUSAL_CHAIN, ['charcoal', 'iron_ingot', 'iron_pickaxe'])
  assert.deepEqual(
    M2_CRITERIA.map(({ item }) => item),
    [...M2_CAUSAL_CHAIN],
  )
  assert.equal(M2_CRITERIA[0].requires, null)
  for (let i = 1; i < M2_CRITERIA.length; i += 1) {
    assert.equal(M2_CRITERIA[i].requires, M2_CRITERIA[i - 1].item)
  }
  assert.equal(M2_CRITERIA.at(-1).item, 'iron_pickaxe')
  assert.equal(M2_CRITERIA.at(-1).need, 1)
  assert.ok(!M2_CRITERIA.some(({ item }) => item === 'diamond_pickaxe'), 'diamond must not be an M2 criterion')
  ok('M2 criteria are exactly charcoal, iron_ingot, iron_pickaxe (no diamond)')
}

// Separate M3 acceptance owns the diamond-pickaxe terminal and is not consulted
// by the M2 pass/fail path.
{
  assert.deepEqual(M3_CAUSAL_CHAIN, ['diamond_pickaxe'])
  assert.deepEqual(
    M3_CRITERIA.map(({ item }) => item),
    [...M3_CAUSAL_CHAIN],
  )
  assert.equal(M3_CRITERIA.at(-1).item, 'diamond_pickaxe')
  assert.equal(M3_CRITERIA.at(-1).need, 1)
  assert.equal(M3_CRITERIA.at(-1).requires, 'iron_pickaxe')
  ok('M3 acceptance independently requires the diamond pickaxe')
}

{
  const out = capture()
  const code = await runM3Acceptance({
    request: async () => diamondComplete,
    write: out.write,
    sockPath: '/tmp/fixture.sock',
  })
  assert.equal(code, 0, `crafted diamond pickaxe must PASS M3 but returned ${code}:\n${out.text()}`)
  assert.match(out.text(), /M3 acceptance check/)
  assert.match(out.text(), /chain: diamond_pickaxe/)
  assert.match(out.text(), /PASS diamond_pickaxe >= 1 \(observed 1\)/)
  assert.match(out.text(), /RESULT: PASS/)
  ok('M3 acceptance PASSes a crafted diamond pickaxe')
}

{
  const out = capture()
  const code = await runM3Acceptance({
    request: async () => contractedThree,
    write: out.write,
    sockPath: '/tmp/fixture.sock',
  })
  assert.equal(code, 1, `M2-only inventory must FAIL M3 but returned ${code}:\n${out.text()}`)
  assert.match(out.text(), /FAIL diamond_pickaxe >= 1 \(observed 0\)/)
  assert.match(out.text(), /RESULT: FAIL/)
  ok('M3 acceptance FAILs inventory with diamond_pickaxe=0 even when M2 passes')
}

{
  const out = capture()
  const code = await runM3Acceptance({
    request: async () => rawDiamondOnly,
    write: out.write,
    sockPath: '/tmp/fixture.sock',
  })
  assert.equal(code, 1, `raw diamonds must not satisfy M3 but returned ${code}:\n${out.text()}`)
  assert.match(out.text(), /FAIL diamond_pickaxe >= 1 \(observed 0\)/)
  assert.match(out.text(), /RESULT: FAIL/)
  ok('M3 acceptance requires the crafted pickaxe, not raw diamonds')
}

assert.equal(M2_CONTROL_TIMEOUT_MS, 10_000)
ok('resident report timeout is 10s so a queued report is not mislabeled UNKNOWN')

console.log(`m2-acceptance: ${checks}/${checks} checks passed`)
