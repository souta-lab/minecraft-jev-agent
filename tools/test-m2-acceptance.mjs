#!/usr/bin/env node
import assert from 'node:assert/strict'
import { runAcceptance } from './m2-acceptance.mjs'

let checks = 0
const ok = (label) => {
  checks += 1
  console.log(`  ok ${checks} - ${label}`)
}

function capture() {
  const lines = []
  return { lines, write: (line) => lines.push(line), text: () => lines.join('\n') }
}

const fullM2 = {
  status: { truth: { inventory: { charcoal: 2, iron_ingot: 3, iron_pickaxe: 1, oak_log: 7 } } },
  stats: { wedge: false, goalComplete: true },
  milestone: 'iron_pickaxe',
}

const missingIngot = {
  status: { truth: { inventory: { charcoal: 1, iron_pickaxe: 1 } } },
  stats: { wedge: false, goalComplete: false },
  milestone: 'iron_ingot',
}

{
  const out = capture()
  const code = await runAcceptance({
    request: async () => fullM2,
    now: () => new Date('2026-09-18T00:00:00.000Z'),
    write: out.write,
    sockPath: '/tmp/fixture.sock',
  })
  assert.equal(code, 0)
  assert.match(out.text(), /PASS charcoal >= 1 \(observed 2\)/)
  assert.match(out.text(), /PASS iron_ingot >= 3 \(observed 3\)/)
  assert.match(out.text(), /PASS iron_pickaxe >= 1 \(observed 1\)/)
  assert.match(out.text(), /milestone: iron_pickaxe/)
  assert.match(out.text(), /goalComplete: true/)
  assert.match(out.text(), /RESULT: PASS/)
  assert.match(out.text(), /2026-09-18T00:00:00.000Z/)
  assert.match(out.text(), /"cmd":"report"/)
  ok('full M2 inventory -> PASS/exit 0 with observed numbers')
}

{
  const out = capture()
  const enveloped = { id: 'm2', ok: true, data: fullM2 }
  const code = await runAcceptance({
    request: async () => enveloped,
    write: out.write,
    sockPath: '/tmp/fixture.sock',
  })
  assert.equal(code, 0)
  assert.match(out.text(), /PASS iron_pickaxe >= 1 \(observed 1\)/)
  assert.match(out.text(), /RESULT: PASS/)
  ok('socket envelope {id,ok,data} is unwrapped')
}

{
  const out = capture()
  const code = await runAcceptance({
    request: async () => missingIngot,
    write: out.write,
    sockPath: '/tmp/fixture.sock',
  })
  assert.equal(code, 1)
  assert.match(out.text(), /PASS charcoal >= 1 \(observed 1\)/)
  assert.match(out.text(), /FAIL iron_ingot >= 3 \(observed 0\)/)
  assert.match(out.text(), /PASS iron_pickaxe >= 1 \(observed 1\)/)
  assert.match(out.text(), /RESULT: FAIL/)
  ok('missing iron_ingot -> FAIL/exit 1')
}

{
  const out = capture()
  const code = await runAcceptance({
    request: async () => null,
    write: out.write,
    sockPath: '/tmp/does-not-exist.sock',
  })
  assert.equal(code, 2)
  assert.match(out.text(), /live: unavailable/)
  assert.doesNotMatch(out.text(), /PASS|FAIL/)
  assert.doesNotMatch(out.text(), /observed \d/)
  assert.doesNotMatch(out.text(), /RESULT: (PASS|FAIL)/)
  ok('unreachable socket -> exit 2 with no fabricated numbers')
}

console.log(`m2-acceptance: ${checks}/${checks} checks passed`)
