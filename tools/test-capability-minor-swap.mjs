#!/usr/bin/env bun
// Focused provenance regression for same-world generation reloads.

import assert from 'node:assert/strict'
import { verifyLiveGenerationForSwap } from './capability-minor-swap.mjs'

const bootSha = '1'.repeat(40)
const sourceSha = '2'.repeat(40)
const at = new Date().toISOString()
const current = {
  status: 'active', runId: 'portal-test', internalRunId: 'run-test',
  residentPid: 100, port: 26615, sha: sourceSha, generationSourceSha: sourceSha,
  hostBootSha: bootSha, runtimeDir: '/runtime',
}
const ready = { runId: 'run-test', generationId: 'gen-live', sourceSha, buildHash: 'build' }
const activeReport = {
  data: {
    runId: 'run-test', generationId: 'gen-live', frozen: false, connected: true,
    worldKey: { serverId: '127.0.0.1:26615', dimension: 'minecraft:overworld', worldEpoch: 1 },
    currentInventoryObservation: { sourceSha: bootSha, observedAt: at, worldKey: { serverId: '127.0.0.1:26615' } },
    status: { running: true, sourceSha, buildHash: 'build' },
  },
}
const common = { current, ready, report: activeReport, now: Date.now(), isAlive: () => true }

const reload = verifyLiveGenerationForSwap({ ...common, boundary: 'generation-reload', residentPid: 100 })
assert.equal(reload.hostBootSha, bootSha, 'generation reload keeps native HOST boot SHA')
assert.equal(reload.live.generationId, 'gen-live')
const forwardReload = verifyLiveGenerationForSwap({
  ...common,
  current: { ...current, sha: '0'.repeat(40), generationSourceSha: '0'.repeat(40) },
  boundary: 'generation-reload', residentPid: 100,
})
assert.equal(forwardReload.live.status.sourceSha, sourceSha, 'verified same-resident source advancement remains admissible')

assert.throws(
  () => verifyLiveGenerationForSwap({ ...common, boundary: 'resident-restart', residentPid: 100 }),
  /new resident PID and internal run ID/,
  'same resident PID/run cannot be labeled a resident restart',
)
assert.throws(
  () => verifyLiveGenerationForSwap({
    ...common,
    report: { data: { ...activeReport.data, frozen: true, generationId: null, status: null } },
    boundary: 'generation-reload', residentPid: 100,
  }),
  /frozen or has no active generation/,
  'frozen native truth cannot bind a disposed GENERATION_READY',
)
assert.throws(
  () => verifyLiveGenerationForSwap({
    ...common,
    report: { data: { ...activeReport.data, generationId: 'gen-other' } },
    boundary: 'generation-reload', residentPid: 100,
  }),
  /does not match/,
  'native active generation must match exact READY id and source',
)
assert.throws(
  () => verifyLiveGenerationForSwap({
    ...common,
    report: { data: { ...activeReport.data, worldKey: { serverId: '127.0.0.1:26614' } } },
    boundary: 'generation-reload', residentPid: 100,
  }),
  /different server/,
  'same-world provenance must match the registry port',
)
assert.throws(
  () => verifyLiveGenerationForSwap({
    ...common,
    report: { data: { ...activeReport.data, currentInventoryObservation: { sourceSha: bootSha, observedAt: '2026-10-01T00:00:00.000Z' } } },
    boundary: 'generation-reload', residentPid: 100,
  }),
  /stale or missing/,
  'stale resident report cannot reconcile provenance',
)

const restarted = verifyLiveGenerationForSwap({
  ...common,
  current: { ...current, internalRunId: 'run-old', residentPid: 99 },
  ready: { ...ready, runId: 'run-new' },
  residentPid: 100,
  boundary: 'resident-restart',
  report: { data: { ...activeReport.data, runId: 'run-new', currentInventoryObservation: { sourceSha, observedAt: at, worldKey: { serverId: '127.0.0.1:26615' } } } },
})
assert.equal(restarted.hostBootSha, sourceSha, 'a genuine new resident binds its own native boot SHA')

console.log('capability-minor-swap: live generation identity, reload/restart distinction, frozen rejection and HOST boot provenance PASS')
