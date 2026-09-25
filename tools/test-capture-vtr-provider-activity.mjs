#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PROVIDER_JOURNALS, VtrProviderActivityWatch, parseArgs, runtimePaths } from './capture-vtr-provider-activity.mjs'

const SOURCE = 'a'.repeat(40)
const RUN = 'run-test-001'
const GENERATION = 'gen-test-001'
const SERVER = '127.0.0.1:25576'
const DIMENSION = 'minecraft:overworld'
const EPOCH = 4
const EMPTY_SHA = createHash('sha256').update(Buffer.alloc(0)).digest('hex')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vtr-provider-capture-'))

function prepare(name, { missing = null } = {}) {
  const runtimeDir = path.join(root, name, 'buddy-driver')
  const paths = runtimePaths(runtimeDir)
  fs.mkdirSync(path.dirname(paths.hostLog), { recursive: true })
  fs.mkdirSync(path.dirname(paths.journals['jev-calls']), { recursive: true })
  for (const journalName of PROVIDER_JOURNALS) {
    if (journalName === missing) continue
    fs.writeFileSync(paths.journals[journalName], '')
  }
  return { runtimeDir, paths }
}

function event(at, name, fields) {
  return `[${new Date(at).toISOString()}] ${name} ${fields}\n`
}

function identityEvents(paths, start) {
  const worldKey = JSON.stringify({ serverId: SERVER, dimension: DIMENSION, worldEpoch: EPOCH })
  const bootAt = start + 100
  const readyAt = start + 200
  const terminalAt = start + 500
  fs.appendFileSync(paths.hostLog, event(bootAt, 'BOOT', `runId=${RUN} source=${SOURCE} worldKey=${worldKey}`))
  fs.appendFileSync(paths.hostLog, event(readyAt, 'GENERATION_READY', `runId=${RUN} id=${GENERATION} generationId=${GENERATION} sourceSha=${SOURCE}`))
  fs.appendFileSync(paths.hostLog, event(terminalAt, 'VTR_TRANSITION_OUTCOME', `runId=${RUN} generationId=${GENERATION} sourceSha=${SOURCE} outcome={"kind":"SUCCESS"}`))
}

let now = Date.parse('2026-09-25T04:00:00.000Z')
try {
  {
    const { paths } = prepare('complete')
    const watch = new VtrProviderActivityWatch({ hostLog: paths.hostLog, journals: paths.journals, now: () => now, maxPollGapMs: 1000 })
    identityEvents(paths, now)
    now += 600
    watch.poll(now)
    now += 200
    const capture = watch.finish(now)
    assert.equal(capture.schema, 'vtr-provider-activity-capture/v1')
    assert.equal(capture.status, 'OBSERVED')
    assert.equal(capture.window.coverageComplete, true)
    assert.deepEqual(capture.identity, {
      sourceSha: SOURCE,
      runId: RUN,
      generationId: GENERATION,
      worldKey: `${SERVER}|${DIMENSION}|${EPOCH}`,
    })
    assert.deepEqual(capture.activity, { networkModelCalls: 0, jevDecisionCalls: 0, system2DecisionCalls: 0 })
    assert.equal(capture.window.generationReadyAt, new Date(Date.parse(capture.window.startedAt) + 200).toISOString())
    assert.equal(capture.window.terminalAt, new Date(Date.parse(capture.window.startedAt) + 500).toISOString())
    for (const name of PROVIDER_JOURNALS) {
      assert.deepEqual(capture.journals[name], {
        bytes: 0,
        sha256: EMPTY_SHA,
        initializedAt: capture.window.startedAt,
        closedAt: capture.window.endedAt,
        firstObservedAt: capture.window.startedAt,
        lastObservedAt: capture.window.endedAt,
        fileCreatedAt: capture.journals[name].fileCreatedAt,
        fileModifiedAt: capture.journals[name].fileModifiedAt,
      })
      assert.ok(Date.parse(capture.journals[name].initializedAt) <= Date.parse(capture.window.generationReadyAt))
      assert.ok(Date.parse(capture.journals[name].closedAt) >= Date.parse(capture.window.terminalAt))
    }
    assert.equal(capture.capture.problems.length, 0)
  }

  {
    const { paths } = prepare('activity')
    const watch = new VtrProviderActivityWatch({ hostLog: paths.hostLog, journals: paths.journals, now: () => now, maxPollGapMs: 1000 })
    fs.appendFileSync(paths.journals['jev-calls'], '{"record":"jev-call"}\n')
    fs.appendFileSync(paths.journals['jev-decisions'], '{"record":"decision-frame"}\n')
    identityEvents(paths, now)
    now += 600
    watch.poll(now)
    now += 100
    const capture = watch.finish(now)
    assert.equal(capture.status, 'FAIL', 'non-empty provider journals must never produce a zero-activity observation')
    assert.equal(capture.window.coverageComplete, true)
    assert.equal(capture.journals['jev-calls'].bytes, Buffer.byteLength('{"record":"jev-call"}\n'))
    assert.equal(capture.journals['jev-calls'].sha256, createHash('sha256').update('{"record":"jev-call"}\n').digest('hex'))
    assert.equal(capture.activity.networkModelCalls, 1)
    assert.equal(capture.activity.jevDecisionCalls, 1)
    assert.equal(capture.capture.observedNonEmptyJournal, true)
  }

  {
    const { paths } = prepare('missing', { missing: 'jev-decisions' })
    const watch = new VtrProviderActivityWatch({ hostLog: paths.hostLog, journals: paths.journals, now: () => now, maxPollGapMs: 1000 })
    identityEvents(paths, now)
    now += 600
    watch.poll(now)
    now += 100
    const capture = watch.finish(now)
    assert.equal(capture.status, 'INCOMPLETE')
    assert.equal(capture.window.coverageComplete, false)
    assert.equal(capture.journals['jev-decisions'].bytes, null)
    assert.equal(fs.existsSync(paths.journals['jev-decisions']), false, 'watcher must never create a missing provider journal')
  }

  {
    const { paths } = prepare('gap')
    const watch = new VtrProviderActivityWatch({ hostLog: paths.hostLog, journals: paths.journals, now: () => now, maxPollGapMs: 50 })
    identityEvents(paths, now)
    now += 600
    watch.poll(now)
    now += 100
    const capture = watch.finish(now)
    assert.equal(capture.status, 'INCOMPLETE')
    assert.equal(capture.window.coverageComplete, false)
    assert.ok(capture.capture.problems.includes('polling-coverage-gap'))
  }

  {
    const { paths } = prepare('identity-mismatch')
    const watch = new VtrProviderActivityWatch({ hostLog: paths.hostLog, journals: paths.journals, now: () => now, maxPollGapMs: 1000 })
    const worldKey = JSON.stringify({ serverId: SERVER, dimension: DIMENSION, worldEpoch: EPOCH })
    fs.appendFileSync(paths.hostLog, event(now + 100, 'BOOT', `runId=${RUN} source=${SOURCE} worldKey=${worldKey}`))
    fs.appendFileSync(paths.hostLog, event(now + 200, 'GENERATION_READY', `runId=${RUN} id=${GENERATION} generationId=${GENERATION} sourceSha=${'b'.repeat(40)}`))
    fs.appendFileSync(paths.hostLog, event(now + 500, 'VTR_TRANSITION_OUTCOME', `runId=${RUN} generationId=${GENERATION} sourceSha=${SOURCE} outcome={"kind":"SUCCESS"}`))
    now += 600
    watch.poll(now)
    now += 100
    const capture = watch.finish(now)
    assert.equal(capture.status, 'FAIL')
    assert.equal(capture.window.coverageComplete, false)
    assert.ok(capture.capture.problems.includes('generation-source-mismatch'))
  }

  {
    const { paths } = prepare('late-arm')
    identityEvents(paths, now)
    const watch = new VtrProviderActivityWatch({ hostLog: paths.hostLog, journals: paths.journals, now: () => now, maxPollGapMs: 1000 })
    now += 100
    const capture = watch.finish(now)
    assert.equal(capture.status, 'INCOMPLETE')
    assert.equal(capture.identity, null, 'a BOOT that predates arming must not be treated as covered')
    assert.equal(capture.window.coverageComplete, false)
  }

  {
    const parsed = parseArgs(['--runtime-dir', '/tmp/run/buddy-driver', '--output', '/tmp/run/provider.json'])
    assert.equal(parsed.hostLog, '/tmp/run/buddy-driver/buddy.log')
    assert.equal(parsed.journals['system2-journal'], '/tmp/run/buddy-driver/logs/jev/system2.jsonl')
    assert.throws(() => parseArgs(['--host-log', '/tmp/host', '--output', '/tmp/out']), /all three provider journal paths/u)
    assert.throws(() => parseArgs(['--runtime-dir', '/tmp/run/buddy-driver', '--output', '/tmp/run/buddy-driver/logs/jev/system2.jsonl']), /must not overwrite/u)
  }

  process.stdout.write('ok - provider activity capture: zero window, nonempty activity, missing source, poll gap, late arm, CLI paths\n')
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
