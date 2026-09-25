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
const TRANSITION = 'transition-test-001'
const CONTRACT = 'contract-test-001'
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
  fs.mkdirSync(path.dirname(paths.lifecycleLog), { recursive: true })
  fs.writeFileSync(paths.lifecycleLog, '')
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
  const commitAt = start + 300
  const terminalAt = start + 500
  const consumedAt = start + 600
  const shutdownAt = start + 650
  const residentStoppedAt = start + 700
  const serverStoppedAt = start + 800
  fs.appendFileSync(paths.hostLog, event(bootAt, 'BOOT', `runId=${RUN} source=${SOURCE} worldKey=${worldKey}`))
  fs.appendFileSync(paths.hostLog, event(readyAt, 'GENERATION_READY', `runId=${RUN} id=${GENERATION} generationId=${GENERATION} sourceSha=${SOURCE}`))
  fs.appendFileSync(paths.hostLog, event(commitAt, 'VTR_TRANSITION_COMMIT', `runId=${RUN} generationId=${GENERATION} sourceSha=${SOURCE} id=${TRANSITION} contractHash=${CONTRACT}`))
  fs.appendFileSync(paths.hostLog, event(terminalAt, 'VTR_TRANSITION_OUTCOME', `runId=${RUN} generationId=${GENERATION} sourceSha=${SOURCE} id=${TRANSITION} outcome={"kind":"SUCCESS"}`))
  fs.appendFileSync(paths.hostLog, event(shutdownAt, 'SHUTDOWN', 'reason=control-quit'))
  const lifecycleRows = [
    { schema: 'vtr-reach-probe-lifecycle/v1', event: 'terminal-consumed', ts: new Date(consumedAt).toISOString(), actor: 'probe-harness', sourceSha: SOURCE, runId: RUN, generationId: GENERATION, worldKey: `${SERVER}|${DIMENSION}|${EPOCH}`, transitionId: TRANSITION, contractHash: CONTRACT, outcomeKind: 'SUCCESS', evidenceIds: ['verify:test'] },
    { schema: 'vtr-reach-probe-lifecycle/v1', event: 'resident-stopped', ts: new Date(residentStoppedAt).toISOString(), stoppedAt: new Date(residentStoppedAt).toISOString(), actor: 'probe-harness', sourceSha: SOURCE, runId: RUN, generationId: GENERATION, worldKey: `${SERVER}|${DIMENSION}|${EPOCH}`, pid: 101, status: 'stopped', exitCode: 0,
      processExitObservation: { schema: 'vtr-process-exit-observation/v1', source: 'child-close-event', state: 'exited', pid: 101, exitCode: 0, observedAt: new Date(residentStoppedAt).toISOString() } },
    { schema: 'vtr-reach-probe-lifecycle/v1', event: 'server-stopped', ts: new Date(serverStoppedAt).toISOString(), stoppedAt: new Date(serverStoppedAt).toISOString(), actor: 'probe-harness', sourceSha: SOURCE, runId: RUN, generationId: GENERATION, worldKey: `${SERVER}|${DIMENSION}|${EPOCH}`, pid: 202, status: 'stopped', exitCode: 0,
      processExitObservation: { schema: 'vtr-process-exit-observation/v1', source: 'child-close-event', state: 'exited', pid: 202, exitCode: 0, observedAt: new Date(serverStoppedAt - 1).toISOString() },
      listenerClosureObservation: { schema: 'vtr-listener-closure-observation/v1', source: 'tcp-connect-probe', state: 'closed', host: '127.0.0.1', port: 25576, result: 'connection-refused', observedAt: new Date(serverStoppedAt).toISOString() } },
  ]
  fs.appendFileSync(paths.lifecycleLog, `${lifecycleRows.map((row) => JSON.stringify(row)).join('\n')}\n`)
}

let now = Date.parse('2026-09-25T04:00:00.000Z')
try {
  {
    const { paths } = prepare('complete')
    const watch = new VtrProviderActivityWatch({ hostLog: paths.hostLog, journals: paths.journals, lifecycleLog: paths.lifecycleLog, now: () => now, maxPollGapMs: 1000 })
    identityEvents(paths, now)
    now += 850
    watch.poll(now)
    now += 50
    const capture = watch.finish('supervisor-host-stopped')
    assert.equal(capture.schema, 'vtr-provider-activity-capture/v2')
    assert.equal(capture.status, 'OBSERVED')
    assert.equal(capture.window.coverageComplete, true)
    assert.equal(capture.window.lifecycleComplete, true)
    assert.equal(capture.window.terminalConsumedAt, new Date(Date.parse(capture.window.startedAt) + 600).toISOString())
    assert.equal(capture.window.residentStoppedAt, new Date(Date.parse(capture.window.startedAt) + 700).toISOString())
    assert.equal(capture.window.serverStoppedAt, new Date(Date.parse(capture.window.startedAt) + 800).toISOString())
    assert.equal(capture.lifecycle.status, 'OBSERVED')
    assert.equal(capture.capture.reason, 'supervisor-host-stopped')
    assert.match(capture.lifecycle.sha256, /^[0-9a-f]{64}$/u)
    assert.deepEqual(capture.identity, {
      sourceSha: SOURCE,
      runId: RUN,
      generationId: GENERATION,
      worldKey: `${SERVER}|overworld|${EPOCH}`,
    })
    assert.deepEqual(capture.activity, {
      jevDecisionFrames: 0,
      jevDecisionRecords: 0,
      system2DecisionInvocations: 0,
      jevEvaluateAttempts: 0,
      system2EvaluateAttempts: 0,
      networkModelCalls: 0,
    })
    assert.equal(capture.window.generationReadyAt, new Date(Date.parse(capture.window.startedAt) + 200).toISOString())
    assert.equal(capture.window.terminalAt, new Date(Date.parse(capture.window.startedAt) + 500).toISOString())
    for (const name of PROVIDER_JOURNALS) {
      assert.equal(capture.journals[name].bytes, 0)
      assert.equal(capture.journals[name].sha256, EMPTY_SHA)
      assert.equal(capture.journals[name].rows, 0)
      assert.equal(capture.journals[name].malformedRows, 0)
      assert.equal(capture.journals[name].initializedAt, capture.window.startedAt)
      assert.equal(capture.journals[name].closedAt, capture.window.endedAt)
      assert.equal(capture.journals[name].firstObservedAt, capture.window.startedAt)
      assert.equal(capture.journals[name].lastObservedAt, capture.window.endedAt)
      assert.ok(Date.parse(capture.journals[name].initializedAt) <= Date.parse(capture.window.generationReadyAt))
      assert.ok(Date.parse(capture.journals[name].closedAt) >= Date.parse(capture.window.serverStoppedAt))
    }
    assert.equal(capture.capture.problems.length, 0)
  }

  {
    const { paths } = prepare('activity')
    const watch = new VtrProviderActivityWatch({ hostLog: paths.hostLog, journals: paths.journals, lifecycleLog: paths.lifecycleLog, now: () => now, maxPollGapMs: 1000 })
    const localFallback = [
      { record: 'jev-call', callId: 'local-route-1', policy: 'fallback', model: 'deterministic-local-fallback', providerAttempts: 0 },
      { record: 'jev-outcome', callId: 'local-route-1', executed: true, verified: true },
    ].map((row) => `${JSON.stringify(row)}\n`).join('')
    fs.appendFileSync(paths.journals['jev-calls'], localFallback)
    fs.appendFileSync(paths.journals['jev-decisions'], '{"decisionId":"decision-1","callId":"local-route-1"}\n')
    fs.appendFileSync(paths.journals['system2-journal'], '{"record":"system2-plan","stub":true,"provenance":"local","provider":"stub","model":"stub-system2"}\n')
    identityEvents(paths, now)
    now += 850
    watch.poll(now)
    now += 50
    const capture = watch.finish(now)
    assert.equal(capture.status, 'OBSERVED', 'classified local decisions with zero provider attempts are not network activity')
    assert.equal(capture.window.coverageComplete, true)
    assert.equal(capture.journals['jev-calls'].bytes, Buffer.byteLength(localFallback))
    assert.equal(capture.journals['jev-calls'].sha256, createHash('sha256').update(localFallback).digest('hex'))
    assert.equal(capture.activity.networkModelCalls, 0)
    assert.equal(capture.activity.jevDecisionFrames, 1)
    assert.equal(capture.activity.jevDecisionRecords, 1)
    assert.equal(capture.activity.system2DecisionInvocations, 1)
    assert.equal(capture.activity.jevEvaluateAttempts, 0)
    assert.equal(capture.activity.system2EvaluateAttempts, 0)
    assert.equal(capture.capture.observedNonEmptyJournal, true)
    assert.equal(capture.capture.observedProviderActivity, false)
  }

  {
    const { paths } = prepare('unclassified-remote-system2-plan')
    fs.appendFileSync(paths.journals['system2-journal'], '{"record":"system2-plan","stub":false,"provider":"remote","model":"jev-prod","providerAttempts":0}\n')
    const watch = new VtrProviderActivityWatch({ hostLog: paths.hostLog, journals: paths.journals, lifecycleLog: paths.lifecycleLog, now: () => now, maxPollGapMs: 1000 })
    identityEvents(paths, now)
    now += 850
    watch.poll(now)
    now += 50
    const capture = watch.finish(now)
    assert.equal(capture.status, 'INCOMPLETE', 'remote System2 plan without a correlated Mercury row cannot be classified as zero')
    assert.equal(capture.activity.system2EvaluateAttempts, null)
    assert.equal(capture.activity.networkModelCalls, null)
    assert.ok(capture.activityClassification.unknown.some((entry) => entry.startsWith('unclassified-system2-plan-authority:')))
  }

  {
    const { paths } = prepare('orphan-jev-outcome')
    fs.appendFileSync(paths.journals['jev-calls'], `${JSON.stringify({ record: 'jev-outcome', callId: 'missing-call-row', executed: false })}\n`)
    const watch = new VtrProviderActivityWatch({ hostLog: paths.hostLog, journals: paths.journals, lifecycleLog: paths.lifecycleLog, now: () => now, maxPollGapMs: 1000 })
    identityEvents(paths, now)
    now += 850
    watch.poll(now)
    now += 50
    const capture = watch.finish(now)
    assert.equal(capture.status, 'INCOMPLETE', 'an outcome without its unique classified jev-call cannot support provider zero')
    assert.equal(capture.activity.jevEvaluateAttempts, null)
    assert.equal(capture.activity.networkModelCalls, null)
    assert.ok(capture.activityClassification.unknown.includes('orphan-or-unclassified-jev-outcome:missing-call-row'))
  }

  {
    const { paths } = prepare('duplicate-jev-outcome')
    fs.appendFileSync(paths.journals['jev-calls'], `${JSON.stringify({ record: 'jev-call', callId: 'local-with-outcome', policy: 'fallback', model: 'deterministic-local-fallback', providerAttempts: 0 })}\n`)
    fs.appendFileSync(paths.journals['jev-calls'], `${JSON.stringify({ record: 'jev-outcome', callId: 'local-with-outcome' })}\n${JSON.stringify({ record: 'jev-outcome', callId: 'local-with-outcome' })}\n`)
    const watch = new VtrProviderActivityWatch({ hostLog: paths.hostLog, journals: paths.journals, lifecycleLog: paths.lifecycleLog, now: () => now, maxPollGapMs: 1000 })
    identityEvents(paths, now)
    now += 850
    watch.poll(now)
    now += 50
    const capture = watch.finish(now)
    assert.equal(capture.status, 'INCOMPLETE', 'duplicate outcomes cannot be uniquely correlated to one call')
    assert.equal(capture.activity.jevEvaluateAttempts, null)
    assert.ok(capture.activityClassification.unknown.includes('duplicate-jev-outcome-call-id:local-with-outcome'))
  }

  {
    const { paths } = prepare('positive-provider-activity')
    fs.appendFileSync(paths.journals['jev-calls'], '{"record":"jev-call","callId":"jev-1","policy":"typesafe","providerAttempts":2}\n')
    fs.appendFileSync(paths.journals['mercury-calls'], [
      { record: 'mercury-call', callId: 'system2-1', attempts: 1 },
      { record: 'mercury-call', callId: 'system2-1', attempts: 2 },
      { record: 'mercury-call', callId: 'system2-2', attempts: 1 },
    ].map((row) => `${JSON.stringify(row)}\n`).join(''))
    const watch = new VtrProviderActivityWatch({ hostLog: paths.hostLog, journals: paths.journals, lifecycleLog: paths.lifecycleLog, now: () => now, maxPollGapMs: 1000 })
    identityEvents(paths, now)
    now += 850
    watch.poll(now)
    now += 50
    const capture = watch.finish(now)
    assert.equal(capture.status, 'FAIL')
    assert.equal(capture.activity.jevEvaluateAttempts, 2)
    assert.equal(capture.activity.system2EvaluateAttempts, 3, 'Mercury cumulative attempt rows are grouped by callId/max')
    assert.equal(capture.activity.networkModelCalls, 5)
  }

  {
    const { paths } = prepare('unclassified-positive-provider-activity')
    fs.appendFileSync(paths.journals['jev-calls'], '{"record":"future-jev-record","callId":"future-call","providerAttempts":1}\n')
    const watch = new VtrProviderActivityWatch({ hostLog: paths.hostLog, journals: paths.journals, lifecycleLog: paths.lifecycleLog, now: () => now, maxPollGapMs: 1000 })
    identityEvents(paths, now)
    now += 850
    watch.poll(now)
    now += 50
    const capture = watch.finish(now)
    assert.equal(capture.status, 'FAIL', 'an unknown row with explicit positive provider attempts still proves network activity')
    assert.equal(capture.activityClassification.positiveProviderActivityObserved, true)
  }

  {
    const { paths } = prepare('unknown-attempt-count')
    fs.appendFileSync(paths.journals['jev-calls'], '{"record":"jev-call","callId":"jev-unknown","policy":"typesafe"}\n')
    const watch = new VtrProviderActivityWatch({ hostLog: paths.hostLog, journals: paths.journals, lifecycleLog: paths.lifecycleLog, now: () => now, maxPollGapMs: 1000 })
    identityEvents(paths, now)
    now += 850
    watch.poll(now)
    now += 50
    const capture = watch.finish(now)
    assert.equal(capture.status, 'INCOMPLETE')
    assert.equal(capture.activity.jevEvaluateAttempts, null)
    assert.equal(capture.activity.networkModelCalls, null)
    assert.ok(capture.activityClassification.unknown.some((value) => value.includes('jev-calls')))
  }

  {
    const { paths } = prepare('malformed-journal')
    fs.appendFileSync(paths.journals['jev-decisions'], '{not-json}\n')
    const watch = new VtrProviderActivityWatch({ hostLog: paths.hostLog, journals: paths.journals, lifecycleLog: paths.lifecycleLog, now: () => now, maxPollGapMs: 1000 })
    identityEvents(paths, now)
    now += 850
    watch.poll(now)
    now += 50
    const capture = watch.finish(now)
    assert.equal(capture.status, 'INCOMPLETE')
    assert.equal(capture.activity.jevDecisionRecords, null)
    assert.equal(capture.journals['jev-decisions'].malformedRows, 1)
  }

  {
    const { paths } = prepare('missing', { missing: 'jev-decisions' })
    const watch = new VtrProviderActivityWatch({ hostLog: paths.hostLog, journals: paths.journals, lifecycleLog: paths.lifecycleLog, now: () => now, maxPollGapMs: 1000 })
    identityEvents(paths, now)
    now += 850
    watch.poll(now)
    now += 50
    const capture = watch.finish(now)
    assert.equal(capture.status, 'INCOMPLETE')
    assert.equal(capture.window.coverageComplete, false)
    assert.equal(capture.journals['jev-decisions'].bytes, null)
    assert.equal(fs.existsSync(paths.journals['jev-decisions']), false, 'watcher must never create a missing provider journal')
  }

  {
    const { paths } = prepare('missing-mercury', { missing: 'mercury-calls' })
    const watch = new VtrProviderActivityWatch({ hostLog: paths.hostLog, journals: paths.journals, lifecycleLog: paths.lifecycleLog, now: () => now, maxPollGapMs: 1000 })
    identityEvents(paths, now)
    now += 850
    watch.poll(now)
    now += 50
    const capture = watch.finish(now)
    assert.equal(capture.status, 'INCOMPLETE', 'missing actual System2 provider-attempt journal cannot prove zero calls')
    assert.equal(capture.activity.system2EvaluateAttempts, null)
    assert.equal(fs.existsSync(paths.journals['mercury-calls']), false, 'watcher must not manufacture a missing provider journal')
  }

  {
    const { paths } = prepare('gap')
    const watch = new VtrProviderActivityWatch({ hostLog: paths.hostLog, journals: paths.journals, lifecycleLog: paths.lifecycleLog, now: () => now, maxPollGapMs: 50 })
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
    const { paths } = prepare('capture-before-server-stop')
    const watch = new VtrProviderActivityWatch({ hostLog: paths.hostLog, journals: paths.journals, lifecycleLog: paths.lifecycleLog, now: () => now, maxPollGapMs: 1000 })
    identityEvents(paths, now)
    now += 750
    const capture = watch.finish(now)
    assert.equal(capture.status, 'INCOMPLETE', 'capture that ends before server stop cannot claim full lifecycle coverage')
    assert.equal(capture.window.coverageComplete, false)
    assert.ok(capture.lifecycle.problems.includes('lifecycle-event-order-invalid'))
  }

  {
    const { paths } = prepare('terminal-consume-contract-mismatch')
    const watch = new VtrProviderActivityWatch({ hostLog: paths.hostLog, journals: paths.journals, lifecycleLog: paths.lifecycleLog, now: () => now, maxPollGapMs: 1000 })
    identityEvents(paths, now)
    const rows = fs.readFileSync(paths.lifecycleLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    rows[0].contractHash = 'another-contract'
    fs.writeFileSync(paths.lifecycleLog, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
    now += 850
    const capture = watch.finish(now)
    assert.equal(capture.status, 'FAIL', 'terminal lifecycle outcome bound to another contract is contradictory')
    assert.ok(capture.lifecycle.problems.includes('terminal-consumed-outcome-binding-mismatch'))
  }

  {
    const { paths } = prepare('identity-mismatch')
    const watch = new VtrProviderActivityWatch({ hostLog: paths.hostLog, journals: paths.journals, lifecycleLog: paths.lifecycleLog, now: () => now, maxPollGapMs: 1000 })
    const worldKey = JSON.stringify({ serverId: SERVER, dimension: DIMENSION, worldEpoch: EPOCH })
    fs.appendFileSync(paths.hostLog, event(now + 100, 'BOOT', `runId=${RUN} source=${SOURCE} worldKey=${worldKey}`))
    fs.appendFileSync(paths.hostLog, event(now + 200, 'GENERATION_READY', `runId=${RUN} id=${GENERATION} generationId=${GENERATION} sourceSha=${'b'.repeat(40)}`))
    fs.appendFileSync(paths.hostLog, event(now + 500, 'VTR_TRANSITION_OUTCOME', `runId=${RUN} generationId=${GENERATION} sourceSha=${SOURCE} outcome={"kind":"SUCCESS"}`))
    now += 850
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
    const watch = new VtrProviderActivityWatch({ hostLog: paths.hostLog, journals: paths.journals, lifecycleLog: paths.lifecycleLog, now: () => now, maxPollGapMs: 1000 })
    now += 100
    const capture = watch.finish(now)
    assert.equal(capture.status, 'INCOMPLETE')
    assert.equal(capture.identity, null, 'a BOOT that predates arming must not be treated as covered')
    assert.equal(capture.window.coverageComplete, false)
  }

  {
    const { paths } = prepare('journal-disappears-between-polls')
    const armedAt = now
    const watch = new VtrProviderActivityWatch({ hostLog: paths.hostLog, journals: paths.journals, lifecycleLog: paths.lifecycleLog, now: () => now, maxPollGapMs: 1000 })
    fs.unlinkSync(paths.journals['jev-calls'])
    watch.poll(armedAt + 10)
    fs.writeFileSync(paths.journals['jev-calls'], '')
    identityEvents(paths, armedAt)
    watch.poll(armedAt + 850)
    const capture = watch.finish(armedAt + 900)
    assert.equal(capture.status, 'INCOMPLETE')
    assert.ok(capture.capture.problems.includes('journal-disappeared:jev-calls'))
  }

  {
    const { paths } = prepare('journal-replaced')
    const armedAt = now
    const watch = new VtrProviderActivityWatch({ hostLog: paths.hostLog, journals: paths.journals, lifecycleLog: paths.lifecycleLog, now: () => now, maxPollGapMs: 1000 })
    fs.renameSync(paths.journals['jev-calls'], `${paths.journals['jev-calls']}.old`)
    fs.writeFileSync(paths.journals['jev-calls'], '')
    watch.poll(armedAt + 10)
    identityEvents(paths, armedAt)
    watch.poll(armedAt + 850)
    const capture = watch.finish(armedAt + 900)
    assert.equal(capture.status, 'INCOMPLETE')
    assert.ok(capture.capture.problems.includes('journal-replaced:jev-calls'))
  }

  {
    const { paths } = prepare('journal-truncated')
    const armedAt = now
    const watch = new VtrProviderActivityWatch({ hostLog: paths.hostLog, journals: paths.journals, lifecycleLog: paths.lifecycleLog, now: () => now, maxPollGapMs: 1000 })
    fs.appendFileSync(paths.journals['jev-calls'], '{"record":"jev-call","callId":"sample","policy":"fallback","model":"deterministic-local-fallback","providerAttempts":0}\n')
    watch.poll(armedAt + 10)
    fs.writeFileSync(paths.journals['jev-calls'], '')
    watch.poll(armedAt + 20)
    identityEvents(paths, armedAt)
    watch.poll(armedAt + 850)
    const capture = watch.finish(armedAt + 900)
    assert.equal(capture.status, 'INCOMPLETE')
    assert.ok(capture.capture.problems.includes('journal-truncated:jev-calls'))
  }

  {
    const parsed = parseArgs(['--runtime-dir', '/tmp/run/buddy-driver', '--output', '/tmp/run/provider.json'])
    assert.equal(parsed.hostLog, '/tmp/run/buddy-driver/buddy.log')
    assert.equal(parsed.lifecycleLog, '/tmp/run/buddy-driver/data/vtr-reach-lifecycle.jsonl')
    assert.equal(parsed.journals['jev-decisions'], '/tmp/run/buddy-driver/logs/jev/decisions.jsonl')
    assert.equal(parsed.journals['system2-journal'], '/tmp/run/buddy-driver/logs/jev/system2.jsonl')
    assert.equal(parsed.journals['mercury-calls'], '/tmp/run/buddy-driver/logs/jev/mercury-calls.jsonl')
    assert.throws(() => parseArgs(['--host-log', '/tmp/host', '--output', '/tmp/out']), /all four decision\/provider journal paths/u)
    assert.throws(() => parseArgs(['--runtime-dir', '/tmp/run/buddy-driver', '--output', '/tmp/run/buddy-driver/logs/jev/system2.jsonl']), /must not overwrite/u)
  }

  process.stdout.write('ok - provider activity capture: zero window, nonempty activity, missing source, poll gap, late arm, CLI paths\n')
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
