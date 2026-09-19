#!/usr/bin/env node
import assert from 'node:assert/strict'
import * as acceptance from './m2-acceptance.mjs'

const { M2_CAUSAL_CHAIN, M2_CONTROL_TIMEOUT_MS, M2_CRITERIA, runAcceptance } = acceptance

let checks = 0
const ok = (label) => {
  checks += 1
  console.log(`  ok ${checks} - ${label}`)
}

function capture() {
  const lines = []
  return { lines, write: (line) => lines.push(line), text: () => lines.join('\n') }
}

const CHAIN_LINE = 'chain: charcoal -> iron_ingot -> iron_pickaxe -> diamond_pickaxe'

// Iron tier complete. Every criterion of the old iron-only gate passes here,
// while the M2 terminal target (MILESTONES.md:16, diamond pickaxe) is unmet.
const ironTierOnly = {
  runId: 'run-fixture',
  status: { truth: { inventory: { charcoal: 2, iron_ingot: 3, iron_pickaxe: 1, oak_log: 7 } } },
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

// Raw diamonds without the crafted pickaxe are not the M2 target.
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

{
  const out = capture()
  const code = await runAcceptance({
    request: async () => ironTierOnly,
    now: () => new Date('2026-09-18T00:00:00.000Z'),
    write: out.write,
    sockPath: '/tmp/fixture.sock',
  })
  assert.equal(
    code,
    1,
    `iron-tier-only inventory must FAIL the diamond target but the gate returned ${code}:\n${out.text()}`,
  )
  assert.match(out.text(), new RegExp(CHAIN_LINE))
  assert.match(out.text(), /PASS charcoal >= 1 \(observed 2\)/)
  assert.match(out.text(), /PASS iron_ingot >= 3 \(observed 3\)/)
  assert.match(out.text(), /PASS iron_pickaxe >= 1 \(observed 1\)/)
  assert.match(
    out.text(),
    /FAIL diamond_pickaxe >= 1 \(observed 0\)/,
    `terminal diamond rung missing from:\n${out.text()}`,
  )
  assert.match(out.text(), /RESULT: FAIL/)
  ok('iron-tier inventory passes the old rungs but fails the diamond terminal -> FAIL/exit 1')
}

{
  const out = capture()
  const code = await runAcceptance({
    request: async () => diamondComplete,
    now: () => new Date('2026-09-18T00:00:00.000Z'),
    write: out.write,
    sockPath: '/tmp/fixture.sock',
  })
  assert.equal(code, 0, `diamond-complete inventory must PASS but the gate returned ${code}:\n${out.text()}`)
  assert.match(out.text(), new RegExp(CHAIN_LINE))
  assert.match(out.text(), /PASS charcoal >= 1 \(observed 2\)/)
  assert.match(out.text(), /PASS iron_ingot >= 3 \(observed 3\)/)
  assert.match(out.text(), /PASS iron_pickaxe >= 1 \(observed 1\)/)
  assert.match(out.text(), /PASS diamond_pickaxe >= 1 \(observed 1\)/)
  assert.match(out.text(), /milestone: diamond_pickaxe/)
  assert.match(out.text(), /goalComplete: true/)
  assert.match(out.text(), /RESULT: PASS/)
  assert.match(out.text(), /2026-09-18T00:00:00.000Z/)
  assert.match(out.text(), /"cmd":"report"/)
  ok('full diamond M2 inventory -> PASS/exit 0 with observed numbers')
}

{
  const out = capture()
  const code = await runAcceptance({
    request: async () => rawDiamondOnly,
    now: () => new Date('2026-09-18T00:00:00.000Z'),
    write: out.write,
    sockPath: '/tmp/fixture.sock',
  })
  assert.equal(code, 1, `raw diamonds must not satisfy the terminal rung but returned ${code}:\n${out.text()}`)
  assert.match(out.text(), /FAIL diamond_pickaxe >= 1 \(observed 0\)/)
  assert.match(out.text(), /RESULT: FAIL/)
  ok('raw diamonds without the crafted pickaxe do not satisfy the terminal rung')
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
  assert.equal(code, 0, `matching explicit runId must PASS with diamond inventory but returned ${code}:\n${out.text()}`)
  assert.match(out.text(), /expectedRunId: run-fixture/)
  assert.match(out.text(), /runId: run-fixture/)
  assert.match(out.text(), /PASS diamond_pickaxe >= 1 \(observed 1\)/)
  assert.match(out.text(), /RESULT: PASS/)
  ok('matching explicit runId is accepted and envelope is unwrapped')
}

{
  const out = capture()
  const code = await runAcceptance({
    request: async () => ironTierOnly,
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
  assert.match(out.text(), /FAIL diamond_pickaxe >= 1 \(observed 0\)/)
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

{
  assert.deepEqual(M2_CAUSAL_CHAIN, ['charcoal', 'iron_ingot', 'iron_pickaxe', 'diamond_pickaxe'])
  assert.deepEqual(
    M2_CRITERIA.map(({ item }) => item),
    [...M2_CAUSAL_CHAIN],
  )
  assert.equal(M2_CRITERIA[0].requires, null)
  for (let i = 1; i < M2_CRITERIA.length; i += 1) {
    assert.equal(M2_CRITERIA[i].requires, M2_CRITERIA[i - 1].item)
  }
  assert.equal(M2_CRITERIA.at(-1).item, 'diamond_pickaxe')
  assert.equal(M2_CRITERIA.at(-1).need, 1)
  ok('criteria are the ordered causal chain ending at the diamond-pickaxe target')
}

assert.equal(M2_CONTROL_TIMEOUT_MS, 10_000)
ok('resident report timeout is 10s so a queued report is not mislabeled UNKNOWN')

console.log(`m2-acceptance: ${checks}/${checks} checks passed`)
