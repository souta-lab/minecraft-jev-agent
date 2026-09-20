#!/usr/bin/env node
// Tests for the current M2 executable gate. The historical iron-age
// m2-watch/m2-acceptance fixtures are intentionally not used as acceptance.
import assert from 'node:assert/strict'
import { exactRunId, gateOptions, hasRunScope, runGate, CURRENT_M2 } from './m2-live-gate.mjs'

let checks = 0
function ok(label) {
  checks += 1
  console.log(`  ok ${checks} - ${label}`)
}

const RUN = 'run-m2-live'
const OTHER = 'run-m2-other'
const boot = (runId) => `[2026-09-20T10:00:00.000Z] BOOT pid=1 runId=${runId}`
const inv = (counts) => `[2026-09-20T10:00:01.000Z] INVENTORY items=${JSON.stringify(counts)}`
const portal = [
  '[2026-09-20T10:00:02.000Z] PORTAL_BLOCK_PLACED pos=10,64,20',
  '[2026-09-20T10:00:03.000Z] PORTAL_FRAME_READY blocks=10 shape=ok',
  '[2026-09-20T10:00:04.000Z] PORTAL_LIT pos=11,65,20 dimension=minecraft:overworld',
  '[2026-09-20T10:00:05.000Z] PORTAL_VERIFIED=true',
]

function evidence(runId, lines) {
  return {
    status: 'valid',
    runId,
    sources: [{
      name: 'fixture:log',
      path: 'fixture',
      inventorySamples: lines
        .filter((line) => line.includes('INVENTORY'))
        .map((line) => JSON.parse(line.slice(line.indexOf('items=') + 6))),
      portalEvents: [
        { name: 'PORTAL_BLOCK_PLACED' },
        { name: 'PORTAL_FRAME_READY', blocks: 10, shape: 'ok' },
        { name: 'PORTAL_LIT', dimension: 'minecraft:overworld' },
        { name: 'PORTAL_VERIFIED', verified: true },
      ],
    }],
  }
}

{
  assert.equal(exactRunId(['--run', RUN], {}), RUN)
  assert.equal(exactRunId([], { M2_RUN_ID: RUN }), RUN)
  assert.equal(exactRunId(['--run', 'bad'], {}), null)
  assert.equal(hasRunScope(['--since', '2026-09-20T10:00:00Z'], {}), false)
  assert.equal(hasRunScope([], { M2_RUN_ID: RUN }), true)
  const defaults = gateOptions([])
  assert.deepEqual(gateOptions(['--run', RUN, '--since', '2026-09-20T10:00:00Z', '--log', '/tmp/a']), {
    logPath: '/tmp/a',
    snapshotDir: defaults.snapshotDir,
    json: false,
  })
  ok('exact run scope is required and --since is not an acceptance key')
}

{
  const lines = []
  let called = false
  const code = await runGate({
    argv: ['--since', '2026-09-20T10:00:00Z'],
    env: {},
    readEvidence: async () => {
      called = true
      throw new Error('evidence reader must not run without exact scope')
    },
    write: (line) => lines.push(line),
  })
  assert.equal(code, 2)
  assert.equal(called, false)
  assert.match(lines.join('\n'), /M2_LIVE_RESULT status=UNKNOWN reason=exact_run_scope_required/)
  ok('timestamp-only invocation cannot PASS and does not read evidence')
}

{
  const lines = [boot(RUN), inv({ diamond: 3, diamond_pickaxe: 1 }), inv({ flint_and_steel: 1, obsidian: 10 }), ...portal]
  const output = []
  const code = await runGate({
    argv: ['--run', RUN, '--since', '2026-09-20T10:00:00Z'],
    env: {},
    readEvidence: async (runId) => {
      assert.equal(runId, RUN)
      return evidence(RUN, lines)
    },
    write: (line) => output.push(line),
  })
  assert.equal(code, 0, output.join('\n'))
  assert.match(output.join('\n'), new RegExp(`M2_LIVE_GATE current=${CURRENT_M2} runId=${RUN}`))
  assert.match(output.join('\n'), new RegExp(`M2_RUN_RESULT status=PASS.*runId=${RUN}`))
  assert.match(output.join('\n'), new RegExp(`M2_LIVE_RESULT status=PASS.*runId=${RUN}`))
  ok('the exact current-M2 portal chain delegates to the run-scoped gate')
}

{
  const output = []
  const code = await runGate({
    argv: ['--run', RUN],
    env: {},
    readEvidence: async () => ({
      status: 'valid',
      runId: RUN,
      sources: [{
        name: 'fixture:other-run',
        path: 'fixture',
        inventorySamples: [{ diamond: 3, diamond_pickaxe: 1 }, { flint_and_steel: 1, obsidian: 10 }],
        portalEvents: [],
      }],
    }),
    write: (line) => output.push(line),
  })
  assert.equal(code, 2)
  assert.match(output.join('\n'), /M2_LIVE_RESULT status=UNKNOWN/)
  assert.doesNotMatch(output.join('\n'), /M2_LIVE_RESULT status=PASS/)
  ok('missing portal chain stays UNKNOWN even when inventory is complete')
}

{
  const output = []
  const code = await runGate({
    argv: ['--run', OTHER],
    env: {},
    readEvidence: async (runId) => ({
      status: 'valid',
      runId,
      sources: [{
        name: 'fixture:foreign',
        path: 'fixture',
        inventorySamples: [],
        portalEvents: portal.map(() => ({ name: 'PORTAL_BLOCK_PLACED' })),
      }],
    }),
    write: (line) => output.push(line),
  })
  assert.equal(code, 2)
  assert.doesNotMatch(output.join('\n'), /status=PASS/)
  ok('a foreign/incomplete run cannot be upgraded into current-M2 PASS')
}

console.log(`m2-live-gate: ${checks}/${checks} checks passed`)
