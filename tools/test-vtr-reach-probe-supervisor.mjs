#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HOST_LIFECYCLE_TRANSCRIPT_SCHEMA,
  ISOLATED_PROBE_SERVER_PORT,
  PROTECTED_SERVER_PORTS,
  REQUIRED_ATTEMPT_SINKS,
  REQUIRED_PROVIDER_JOURNALS,
  prepareZeroByteAttemptSinks,
  runVtrReachProbeSupervisor,
  runtimeAttemptSinkPaths,
  validateIsolatedLeafAttestation,
} from './vtr-reach-probe-supervisor.mjs'
import { parseHostLog } from './collect-vtr-reach-live.mjs'

const SOURCE = 'a'.repeat(40)
const RUN = 'run-supervisor-01'
const GENERATION = 'gen-supervisor-01'
const TRANSITION = 'reach-transition-01'
const CONTRACT = 'contract-supervisor-01'
const RESIDENT_PID = 9444
const SERVER_ID = `127.0.0.1:${ISOLATED_PROBE_SERVER_PORT}`
const WORLD_KEY = `${SERVER_ID}|overworld|7`
assert.ok(PROTECTED_SERVER_PORTS.includes(25576), 'the reserved diagnostic Leaf listener is protected from probe reuse')
assert.equal(ISOLATED_PROBE_SERVER_PORT, 25577, 'generic isolated probes default to the separate listener')
const EMPTY_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
const t = (second) => new Date(Date.parse('2026-09-25T07:00:00.000Z') + second * 1000).toISOString()

function setup(root, port = ISOLATED_PROBE_SERVER_PORT) {
  mkdirSync(root, { recursive: true })
  const runtimeDir = join(root, 'runtime')
  const paths = runtimeAttemptSinkPaths(runtimeDir)
  const worldRoot = join(root, 'leaf', 'world')
  mkdirSync(worldRoot, { recursive: true })
  const serverAttestation = {
    schema: 'vtr-reach-isolated-leaf/v1',
    sourceSha: SOURCE,
    host: '127.0.0.1',
    port,
    pid: 9123,
    startedAt: t(0),
    worldRoot,
    worldKey: `${serverId(port)}|overworld|7`,
    levelName: 'reach-probe-world',
    minecraftVersion: '1.21.11',
    serverPropertiesSha256: 'b'.repeat(64),
    serverPropertiesEffectiveSha256: 'c'.repeat(64),
    attestationPath: join(root, 'leaf', 'server-start.json'),
  }
  return { runtimeDir, paths, worldRoot, serverAttestation }
}

function serverId(port = ISOLATED_PROBE_SERVER_PORT) {
  return `127.0.0.1:${port}`
}

function captureFixture({ schema = 'vtr-provider-activity-capture/v2', status = 'OBSERVED', localDecision = false, worldKey = WORLD_KEY } = {}) {
  const startedAt = t(0)
  const endedAt = t(100)
  const jevRecord = localDecision
    ? Buffer.from(`${JSON.stringify({ record: 'jev-call', callId: 'local-fallback-1', policy: 'fallback', model: 'deterministic-reach-probe', providerAttempts: 0 })}\n`)
    : Buffer.alloc(0)
  const empty = Buffer.alloc(0)
  const journalData = {
    'jev-calls': { bytes: jevRecord, rows: localDecision ? 1 : 0 },
    'jev-decisions': { bytes: empty, rows: 0 },
    'system2-journal': { bytes: empty, rows: 0 },
    'mercury-calls': { bytes: empty, rows: 0 },
  }
  return {
    schema,
    status,
    identity: { sourceSha: SOURCE, runId: RUN, generationId: GENERATION, worldKey },
    window: { startedAt, generationReadyAt: t(2), terminalAt: t(3), endedAt, coverageComplete: true },
    activity: {
      jevDecisionFrames: localDecision ? 1 : 0,
      jevDecisionRecords: 0,
      system2DecisionInvocations: 0,
      jevEvaluateAttempts: 0,
      system2EvaluateAttempts: 0,
      networkModelCalls: 0,
    },
    activityClassification: {
      decisions: { jevDecisionFrames: localDecision ? 1 : 0, jevDecisionRecords: 0, system2DecisionInvocations: 0 },
      providers: { jevEvaluateAttempts: 0, system2EvaluateAttempts: 0, networkModelCalls: 0 },
      positiveProviderActivityObserved: false,
      unknown: [],
    },
    journals: Object.fromEntries(REQUIRED_PROVIDER_JOURNALS.map((name) => [name, {
      bytes: journalData[name].bytes.length,
      sha256: createHash('sha256').update(journalData[name].bytes).digest('hex'),
      rows: journalData[name].rows,
      malformedRows: 0,
      initializedAt: startedAt,
      firstObservedAt: startedAt,
      closedAt: endedAt,
    }])),
    capture: {
      problems: [],
      observedNonEmptyJournal: localDecision,
      observedProviderActivity: false,
      finishedAt: endedAt,
    },
  }
}

function hostLine(at, event, fields) {
  const encoded = Object.entries(fields).map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : String(value)}`).join(' ')
  return `[${at}] ${event} ${encoded}\n`
}

function event(at, name, detail, extra = {}) {
  return {
    record: 'agent-event',
    ts: at,
    source: 'vtr',
    level: 'info',
    message: `${name} id=${detail.transitionId} contractHash=${detail.contractHash}`,
    detail,
    ...extra,
  }
}

function createAdapters({ calls, paths, leaf, outcomeKind = 'SUCCESS', wrongOutcome = false, wrongOutcomeIdentity = false, localDecision = false, now = () => Date.parse(t(10)), targetServerId = SERVER_ID }) {
  const stopTimestamp = () => new Date(now()).toISOString()
  const targetWorldKey = `${targetServerId}|overworld|7`
  const terminalRows = [
    event(t(2.5), 'VTR_TRANSITION_COMMIT', {
      transitionId: TRANSITION,
      contractHash: CONTRACT,
      mission: { kind: 'inventory_at_least', item: 'amethyst_block', count: 1 },
      desiredPredicate: {
        id: 'reach.resource-source',
        proposition: { kind: 'within-interaction-reach-of-resource-source', item: 'amethyst_block' },
        expected: true,
      },
      identity: { worldKey: targetWorldKey, generationId: GENERATION },
    }),
    event(t(3), 'VTR_TRANSITION_OUTCOME', {
      transitionId: wrongOutcome ? 'other-transition' : TRANSITION,
      contractHash: CONTRACT,
      runId: RUN,
      sourceSha: SOURCE,
      identity: {
        worldKey: wrongOutcomeIdentity ? `${targetServerId}|nether|8` : targetWorldKey,
        generationId: wrongOutcomeIdentity ? 'stale-generation' : GENERATION,
      },
      outcome: { kind: outcomeKind, contractHash: CONTRACT, evidenceIds: ['verify:reach-probe'] },
    }),
  ]
  return {
    startResidentFrozen: async () => {
      calls.push('start')
      appendFileSync(paths['host-log'], hostLine(t(1), 'BOOT', {
        runId: RUN,
        source: SOURCE,
        mission: { kind: 'inventory_at_least', item: 'amethyst_block', count: 1, source: 'BUDDY_MISSION_* or default' },
        worldKey: { serverId: targetServerId, dimension: 'minecraft:overworld', worldEpoch: 7 },
      }))
      assert.equal(parseHostLog(readFileSync(paths['host-log'], 'utf8')).length, 1, 'fixture writes a parseable BOOT')
      return { frozen: true, pid: RESIDENT_PID, handle: { resident: 'test' } }
    },
    prepareFixture: async ({ attemptRoot }) => {
      calls.push('prepare-fixture')
      const path = join(attemptRoot, 'runner', 'fixture-commands.jsonl')
      mkdirSync(join(attemptRoot, 'runner'), { recursive: true })
      const bytes = Buffer.from(`${JSON.stringify({ command: 'setblock', status: 'recorded' })}\n`)
      writeFileSync(path, bytes, { flag: 'wx' })
      return { status: 'READY', path, sha256: createHash('sha256').update(bytes).digest('hex') }
    },
    resumeResident: async () => {
      calls.push('resume')
      if (localDecision) {
        appendFileSync(paths['jev-calls'], `${JSON.stringify({ record: 'jev-call', callId: 'local-fallback-1', policy: 'fallback', model: 'deterministic-reach-probe', providerAttempts: 0 })}\n`)
      }
      appendFileSync(paths['host-log'], hostLine(t(1.5), 'VTR_REACH_PROBE_CONFIGURED', {
        mission: { kind: 'inventory_at_least', item: 'amethyst_block', count: 1 },
        compatibilityLadder: 'observer-only',
        ledgerRestore: 'disabled',
        plannerBootstrap: 'disabled',
        system2Mode: 'off',
        jevPolicyMode: 'fallback',
      }))
      appendFileSync(paths['host-log'], hostLine(t(1.7), 'VTR_REACH_PROBE_QUEUE_EMPTY', {
        authority: 'vtr-transition-scheduler',
        restoredLegacyRows: 0,
      }))
      appendFileSync(paths['host-log'], hostLine(t(2), 'GENERATION_READY', {
        runId: RUN,
        id: GENERATION,
        generationId: GENERATION,
        sourceSha: SOURCE,
        productionPlanAuthority: 'vtr-reach-probe',
        policy: 'fallback',
        policyProvider: 'deterministic',
        system2Provider: 'none',
      }))
      appendFileSync(paths['run-journal'], `${terminalRows.map((row) => JSON.stringify(row)).join('\n')}\n`)
      return { started: true }
    },
    stopResident: async () => {
      calls.push('stop-resident')
      const stoppedAt = stopTimestamp()
      appendFileSync(paths['host-log'], hostLine(stoppedAt, 'SHUTDOWN', { reason: 'control-quit' }))
      return {
        status: 'STOPPED', pid: RESIDENT_PID, serverId: targetServerId, exitCode: 0, stoppedAt,
        controlSocketReleased: true, hostLockReleased: true,
        processExitObservation: {
          schema: 'vtr-process-exit-observation/v1', source: 'child-close-event', state: 'exited',
          pid: RESIDENT_PID, exitCode: 0, observedAt: stoppedAt,
        },
      }
    },
    stopIsolatedLeaf: async ({ attestation }) => {
      calls.push('stop-leaf')
      const processExitedAt = stopTimestamp()
      const listenerClosedAt = stopTimestamp()
      return {
        status: 'STOPPED', port: attestation.port, serverId: targetServerId, pid: attestation.pid, exitCode: 0, stoppedAt: listenerClosedAt,
        processExitObservation: {
          schema: 'vtr-process-exit-observation/v1', source: 'child-close-event', state: 'exited',
          pid: attestation.pid, exitCode: 0, observedAt: processExitedAt,
        },
        listenerClosureObservation: {
          schema: 'vtr-listener-closure-observation/v1', source: 'tcp-connect-probe', state: 'closed',
          host: '127.0.0.1', port: attestation.port, result: 'connection-refused', observedAt: listenerClosedAt,
        },
      }
    },
    collect: async ({ identity, terminal }) => {
      calls.push('collect')
      assert.equal(identity.runId, RUN)
      assert.equal(terminal.transitionId, TRANSITION)
      return { status: 'PASS', path: join(leaf, 'collector-report.json'), sha256: 'b'.repeat(64) }
    },
    sealArchive: async ({ identity, terminal, capture, collector, lifecycle, hostLifecycleTranscript, fixtureTranscript }) => {
      calls.push('seal')
      assert.equal(identity.sourceSha, SOURCE)
      assert.equal(terminal.outcomeKind, outcomeKind)
      assert.equal(capture.status, 'OBSERVED')
      assert.equal(collector.status, 'PASS')
      assert.equal(existsSync(lifecycle.path), true)
      assert.equal(readFileSync(hostLifecycleTranscript, 'utf8').trim().split('\n').length, 3, 'archive is sealed only after all lifecycle stages were recorded')
      assert.equal(fixtureTranscript.status, 'READY')
      assert.equal(fixtureTranscript.sha256.length, 64)
      return { status: 'READY_FOR_VALIDATION', path: join(leaf, 'archive') }
    },
    validateArchive: async ({ archive, hostLifecycleTranscript, fixtureTranscript }) => {
      calls.push('validate')
      assert.equal(archive.status, 'READY_FOR_VALIDATION')
      assert.equal(readFileSync(hostLifecycleTranscript, 'utf8').trim().split('\n').length, 3)
      assert.equal(fixtureTranscript.status, 'READY')
      return { status: 'PASS', path: join(leaf, 'validation.json') }
    },
  }
}

function createObserverAdapter(calls, runtimeDir) {
  return {
    async bind({ runtimeDir: requestedRuntime, sourceSha }) {
      calls.push('observer-bind')
      assert.equal(requestedRuntime, runtimeDir)
      return {
        status: 'BOUND',
        runtimeDir,
        sourceSha,
        observerUrl: 'http://127.0.0.1:4173/api/ai-summary',
        previousBindingAvailable: true,
      }
    },
    async readSummary({ identity, phase }) {
      calls.push(`observer-read:${phase}`)
      return {
        freshnessMs: 25,
        status: { available: true, connected: true },
        run: {
          id: identity.runId,
          sourceCommit: identity.sourceSha,
          generationId: identity.generationId,
          worldKey: identity.worldKey,
        },
      }
    },
    async restore({ policy }) {
      calls.push('observer-restore')
      assert.equal(policy, 'restore')
      return { status: 'RESTORED', restoredRuntimeDir: '/home/s0u7a/mc-ai' }
    },
  }
}

function watchFactory(calls, capture) {
  return {
    async arm(args) {
      calls.push('arm')
      assert.equal(args.expectedSchema, 'vtr-provider-activity-capture/v2')
      assert.deepEqual(Object.keys(args.journals).sort(), REQUIRED_PROVIDER_JOURNALS.slice().sort())
      const lifecyclePath = args.lifecycleLog ?? args.lifecycleTranscript
      assert.equal(lifecyclePath.endsWith('/runner/host-lifecycle.jsonl'), true)
      assert.equal(statSync(lifecyclePath).size, 0, 'lifecycle transcript is a real empty file before capture arm')
      return {
        poll() { calls.push('poll') },
        async finish(reason) {
          calls.push('finish')
          assert.match(reason, /orderly-teardown|incomplete/u)
          const rawLifecycle = readFileSync(lifecyclePath)
          const rows = rawLifecycle.toString('utf8').trim().split('\n').map((line) => JSON.parse(line))
          const lifecycleComplete = rows.length === 3
          const lifecycleEvents = {
            terminalConsumed: rows.find((row) => row.event === 'terminal-consumed'),
            residentStopped: rows.find((row) => row.event === 'resident-stopped'),
            serverStopped: rows.find((row) => row.event === 'server-stopped'),
          }
          const hostLog = readFileSync(args.hostLog, 'utf8')
          const shutdownLine = hostLog.split(/\r?\n/u).find((line) => /\] SHUTDOWN\b/u.test(line))
          const shutdownAt = /^\[([^\]]+)\]/u.exec(shutdownLine ?? '')?.[1] ?? null
          const endedAt = t(100)
          const lifecycle = {
            path: lifecyclePath,
            bytes: rawLifecycle.length,
            sha256: createHash('sha256').update(rawLifecycle).digest('hex'),
            rows: rows.length,
            malformedRows: 0,
            initializedAt: capture.window.startedAt,
            firstObservedAt: capture.window.startedAt,
            lastObservedAt: endedAt,
            closedAt: endedAt,
            status: lifecycleComplete ? 'OBSERVED' : 'INCOMPLETE',
            problems: lifecycleComplete ? [] : ['lifecycle-row-count-incomplete'],
            events: lifecycleEvents,
          }
          return {
            ...capture,
            status: lifecycleComplete ? capture.status : 'INCOMPLETE',
            window: {
              ...capture.window,
              shutdownAt,
              terminalConsumedAt: lifecycleEvents.terminalConsumed?.ts ?? null,
              residentStoppedAt: lifecycleEvents.residentStopped?.stoppedAt ?? null,
              serverStoppedAt: lifecycleEvents.serverStopped?.stoppedAt ?? null,
              lifecycleComplete,
              coverageComplete: capture.window.coverageComplete && lifecycleComplete,
            },
            lifecycle,
            capture: { ...capture.capture, finishedAt: endedAt },
          }
        },
      }
    },
  }
}

const temporary = mkdtempSync(join(tmpdir(), 'vtr-reach-supervisor-test-'))
try {
  {
    const root = join(temporary, 'sink-prep')
    const { paths } = setup(root)
    const prepared = prepareZeroByteAttemptSinks({ attemptRoot: root, paths })
    assert.deepEqual(Object.keys(prepared).sort(), REQUIRED_ATTEMPT_SINKS.slice().sort())
    for (const name of REQUIRED_ATTEMPT_SINKS) {
      assert.equal(statSync(paths[name]).size, 0, `${name} exists as a zero-byte sink`)
      assert.equal(prepared[name].bytes, 0)
      assert.equal(prepared[name].sha256, EMPTY_SHA)
      assert.equal(readFileSync(paths[name]).byteLength, 0)
    }
    appendFileSync(paths['jev-calls'], `${JSON.stringify({ record: 'jev-call' })}\n`)
    assert.throws(() => prepareZeroByteAttemptSinks({ attemptRoot: root, paths }), /already exists/u)
    assert.equal(readFileSync(paths['jev-calls'], 'utf8'), `${JSON.stringify({ record: 'jev-call' })}\n`, 'stale bytes are preserved')
  }

  {
    const root = join(temporary, 'successful-lifecycle')
    const calls = []
    let clock = Date.parse(t(10))
    const now = () => { clock += 100; return clock }
    const port = ISOLATED_PROBE_SERVER_PORT + 1
    const { paths, serverAttestation } = setup(root, port)
    const result = await runVtrReachProbeSupervisor({
      attemptRoot: root,
      runtimeDir: join(root, 'runtime'),
      sourceSha: SOURCE,
      paths,
      expectedCaptureSchema: 'vtr-provider-activity-capture/v2',
      expectedCaptureStatus: 'OBSERVED',
      serverAttestation,
      isolatedPort: port,
      watchFactory: watchFactory(calls, captureFixture({ localDecision: true, worldKey: `${serverId(port)}|overworld|7` })),
      observerAdapter: createObserverAdapter(calls, join(root, 'runtime')),
      adapters: createAdapters({ calls, paths, leaf: root, localDecision: true, now, targetServerId: serverId(port) }),
      outputPaths: {
        capture: join(root, 'evidence', 'provider-capture.json'),
        lifecycle: join(root, 'evidence', 'lifecycle.json'),
        result: join(root, 'evidence', 'result.json'),
      },
      now,
      timeoutMs: 3000,
      sleep: async () => {},
    })
    assert.equal(result.status, 'PASS', `${JSON.stringify(result, null, 2)}\n${JSON.stringify(calls)}`)
    assert.equal(result.captureGate.status, 'PASS')
    assert.equal(result.terminal.outcomeKind, 'SUCCESS')
    assert.equal(result.captureGate.checks.find((check) => check.id === 'capture:zero-networkModelCalls')?.status, 'PASS')
    assert.equal(result.captureGate.checks.find((check) => check.id === 'capture:journal-byte-observation')?.status, 'PASS')
    assert.deepEqual(calls.filter((name) => ['observer-bind', 'arm', 'start', 'prepare-fixture', 'resume', 'observer-read:generation-ready', 'observer-read:terminal', 'collect', 'stop-resident', 'stop-leaf', 'finish', 'seal', 'validate', 'observer-restore'].includes(name)), [
      'observer-bind', 'arm', 'start', 'prepare-fixture', 'resume', 'observer-read:generation-ready', 'observer-read:terminal', 'collect', 'stop-resident', 'stop-leaf', 'finish', 'seal', 'validate', 'observer-restore',
    ])
    assert.ok(calls.indexOf('observer-bind') < calls.indexOf('arm'), 'observer is bound to exact runtime before capture')
    assert.ok(calls.indexOf('arm') < calls.indexOf('start'), 'capture arms before resident process start')
    assert.ok(calls.indexOf('start') < calls.indexOf('prepare-fixture') && calls.indexOf('prepare-fixture') < calls.indexOf('resume'), 'generic fixture is prepared while resident is frozen after exact BOOT')
    assert.ok(calls.indexOf('stop-resident') < calls.indexOf('stop-leaf'), 'resident stops before isolated Leaf')
    assert.ok(calls.indexOf('stop-leaf') < calls.indexOf('finish'), 'capture closes after both processes stop')
    assert.equal(readFileSync(join(root, 'evidence', 'provider-capture.json'), 'utf8').includes('mercury-calls'), true)
    const providerCapture = JSON.parse(readFileSync(join(root, 'evidence', 'provider-capture.json'), 'utf8'))
    assert.equal(providerCapture.activity.jevDecisionFrames, 1, 'deterministic local policy decisions are distinct from provider calls')
    assert.equal(providerCapture.activity.networkModelCalls, 0)
    assert.equal(providerCapture.capture.observedNonEmptyJournal, true, 'real decision journal bytes are retained and observed')
    const lifecycle = JSON.parse(readFileSync(join(root, 'evidence', 'lifecycle.json'), 'utf8'))
    assert.equal(lifecycle.sourceSha, SOURCE)
    assert.equal(lifecycle.identity.runId, RUN)
    assert.equal(lifecycle.terminal.outcomeKind, 'SUCCESS')
    assert.equal(lifecycle.fixtureTranscript.sha256, result.fixtureTranscript.sha256, 'fixture digest is bound in the lifecycle artifact')
    assert.equal(lifecycle.isolatedLeaf.port, port, 'caller-selected loopback port is retained in the run evidence')
    assert.equal(lifecycle.observerSnapshots.length, 2)
    assert.equal(lifecycle.isolatedLeaf.configuration.serverPropertiesSha256, 'b'.repeat(64))
    const finalResult = JSON.parse(readFileSync(join(root, 'evidence', 'result.json'), 'utf8'))
    assert.equal(finalResult.validation.status, 'PASS')
    assert.equal(finalResult.hostLifecycleTranscript.gate.status, 'PASS')
    const lifecycleRows = readFileSync(join(root, 'runner/host-lifecycle.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    assert.deepEqual(lifecycleRows.map((row) => row.event), ['terminal-consumed', 'resident-stopped', 'server-stopped'])
    assert.ok(lifecycleRows.every((row) => row.schema === HOST_LIFECYCLE_TRANSCRIPT_SCHEMA && row.actor === 'probe-harness'))
    assert.ok(lifecycleRows.every((row) => row.sourceSha === SOURCE && row.runId === RUN && row.generationId === GENERATION && row.worldKey === `${serverId(port)}|overworld|7`))
    assert.deepEqual(lifecycleRows[0].evidenceIds, ['verify:reach-probe'])
    assert.equal(lifecycleRows[1].pid, RESIDENT_PID)
    assert.equal(lifecycleRows[2].pid, serverAttestation.pid)
    assert.equal(lifecycleRows[2].serverId, serverId(port))
    assert.equal(lifecycleRows[1].processExitObservation.state, 'exited')
    assert.equal(lifecycleRows[2].processExitObservation.state, 'exited')
    assert.equal(lifecycleRows[2].listenerClosureObservation.result, 'connection-refused')
  }

  {
    const root = join(temporary, 'invalid-fixture-path')
    const { paths, serverAttestation } = setup(root)
    const calls = []
    const outsidePath = join(temporary, 'fixture-outside-attempt.jsonl')
    const outsideBytes = Buffer.from('{"command":"setblock"}\n')
    writeFileSync(outsidePath, outsideBytes)
    const adapters = createAdapters({ calls, paths, leaf: root, now: () => Date.parse(t(10)) })
    adapters.prepareFixture = async () => {
      calls.push('prepare-fixture')
      return { status: 'READY', path: outsidePath, sha256: createHash('sha256').update(outsideBytes).digest('hex') }
    }
    const result = await runVtrReachProbeSupervisor({
      attemptRoot: root,
      runtimeDir: join(root, 'runtime'),
      sourceSha: SOURCE,
      paths,
      expectedCaptureSchema: 'vtr-provider-activity-capture/v2',
      expectedCaptureStatus: 'OBSERVED',
      serverAttestation,
      watchFactory: watchFactory(calls, captureFixture()),
      observerAdapter: createObserverAdapter(calls, join(root, 'runtime')),
      adapters,
      outputPaths: { capture: join(root, 'evidence/capture.json'), lifecycle: join(root, 'evidence/lifecycle.json'), result: join(root, 'evidence/result.json') },
      now: () => Date.parse(t(10)),
      sleep: async () => {},
    })
    assert.equal(result.status, 'FAIL')
    assert.match(result.failure ?? '', /inside the run-scoped attempt root/u)
    assert.equal(calls.includes('resume'), false, 'fixture path validation fails closed before the resident resumes')
    assert.equal(calls.includes('collect'), false)
    assert.ok(calls.indexOf('stop-resident') < calls.indexOf('stop-leaf'), 'fixture failure still shuts the resident down before Leaf')
  }

  {
    const root = join(temporary, 'typed-fixture-adapter-failure')
    const { paths, serverAttestation } = setup(root)
    const calls = []
    const adapters = createAdapters({ calls, paths, leaf: root, now: () => Date.parse(t(10)) })
    adapters.prepareFixture = async () => {
      calls.push('prepare-fixture')
      const error = new Error('console failure secret=must-not-be-persisted')
      error.name = 'LeafFixtureProbeError'
      error.code = 'LEAF_FIXTURE_FILL_RESPONSE_TIMEOUT'
      error.phase = 'fixture.fill'
      throw error
    }
    const result = await runVtrReachProbeSupervisor({
      attemptRoot: root,
      runtimeDir: join(root, 'runtime'),
      sourceSha: SOURCE,
      paths,
      expectedCaptureSchema: 'vtr-provider-activity-capture/v2',
      expectedCaptureStatus: 'OBSERVED',
      serverAttestation,
      watchFactory: watchFactory(calls, captureFixture()),
      observerAdapter: createObserverAdapter(calls, join(root, 'runtime')),
      adapters,
      outputPaths: { capture: join(root, 'evidence/capture.json'), lifecycle: join(root, 'evidence/lifecycle.json'), result: join(root, 'evidence/result.json') },
      now: () => Date.parse(t(10)),
      sleep: async () => {},
    })
    assert.equal(result.status, 'FAIL')
    assert.equal(result.failure, 'adapter failure (LeafFixtureProbeError, LEAF_FIXTURE_FILL_RESPONSE_TIMEOUT, fixture.fill)')
    assert.deepEqual(result.failureDetails, { name: 'LeafFixtureProbeError', code: 'LEAF_FIXTURE_FILL_RESPONSE_TIMEOUT', phase: 'fixture.fill' })
    assert.equal(JSON.stringify(result).includes('must-not-be-persisted'), false)
    assert.equal(calls.includes('resume'), false, 'fixture failure remains fail-closed before generation resume')
    assert.equal(calls.includes('collect'), false, 'fixture failure cannot reach gameplay collection')
    assert.ok(calls.indexOf('stop-resident') < calls.indexOf('stop-leaf'), 'fixture failure still shuts down resident before Leaf')
    const lifecycle = JSON.parse(readFileSync(result.lifecycleArtifact.path, 'utf8'))
    assert.deepEqual(lifecycle.events.find((row) => row.event === 'supervisor-error'), {
      event: 'supervisor-error', at: lifecycle.events.find((row) => row.event === 'supervisor-error').at,
      reason: result.failure, name: 'LeafFixtureProbeError', code: 'LEAF_FIXTURE_FILL_RESPONSE_TIMEOUT', phase: 'fixture.fill',
    })
  }

  {
    const root = join(temporary, 'bad-capture-status')
    const { paths, serverAttestation } = setup(root)
    const calls = []
    const result = await runVtrReachProbeSupervisor({
      attemptRoot: root,
      runtimeDir: join(root, 'runtime'),
      sourceSha: SOURCE,
      paths,
      expectedCaptureSchema: 'vtr-provider-activity-capture/v2',
      expectedCaptureStatus: 'OBSERVED',
      serverAttestation,
      watchFactory: watchFactory(calls, captureFixture({ status: 'INCOMPLETE' })),
      observerAdapter: createObserverAdapter(calls, join(root, 'runtime')),
      adapters: createAdapters({ calls, paths, leaf: root, now: () => Date.parse(t(10)) }),
      outputPaths: {
        capture: join(root, 'evidence', 'provider-capture.json'),
        lifecycle: join(root, 'evidence', 'lifecycle.json'),
        result: join(root, 'evidence', 'result.json'),
      },
      now: () => Date.parse(t(6)),
      sleep: async () => {},
    })
    assert.equal(result.status, 'INCOMPLETE', JSON.stringify(result, null, 2))
    assert.equal(result.captureGate.status, 'INCOMPLETE')
    assert.equal(calls.includes('seal'), false, 'non-OBSERVED capture cannot be packaged as proof')
  }

  {
    const root = join(temporary, 'protected-port')
    const { paths, serverAttestation } = setup(root)
    let started = false
    const calls = []
    const protectedPort = { ...serverAttestation, port: PROTECTED_SERVER_PORTS[0] }
    await assert.rejects(runVtrReachProbeSupervisor({
      isolatedPort: PROTECTED_SERVER_PORTS[0],
      attemptRoot: root,
      runtimeDir: join(root, 'runtime'),
      sourceSha: SOURCE,
      paths,
      expectedCaptureSchema: 'vtr-provider-activity-capture/v2',
      expectedCaptureStatus: 'OBSERVED',
      serverAttestation: protectedPort,
      watchFactory: watchFactory(calls, captureFixture()),
      observerAdapter: createObserverAdapter(calls, join(root, 'runtime')),
      adapters: { ...createAdapters({ calls, paths, leaf: root }), startResidentFrozen: async () => { started = true; return { frozen: true, pid: RESIDENT_PID, handle: {} } } },
      outputPaths: { capture: join(root, 'evidence/capture.json'), lifecycle: join(root, 'evidence/lifecycle.json'), result: join(root, 'evidence/result.json') },
    }), /protected server port/u)
    assert.equal(started, false, 'protected target rejection occurs before resident start')
    assert.equal(calls.includes('arm'), false, 'protected target rejection occurs before capture arm')
  }

  {
    const root = join(temporary, 'wrong-isolated-port')
    const { paths, serverAttestation } = setup(root)
    let started = false
    const calls = []
    await assert.rejects(runVtrReachProbeSupervisor({
      isolatedPort: ISOLATED_PROBE_SERVER_PORT,
      attemptRoot: root,
      runtimeDir: join(root, 'runtime'),
      sourceSha: SOURCE,
      paths,
      expectedCaptureSchema: 'vtr-provider-activity-capture/v2',
      expectedCaptureStatus: 'OBSERVED',
      serverAttestation: { ...serverAttestation, port: ISOLATED_PROBE_SERVER_PORT + 1 },
      watchFactory: watchFactory(calls, captureFixture()),
      observerAdapter: createObserverAdapter(calls, join(root, 'runtime')),
      adapters: { ...createAdapters({ calls, paths, leaf: root }), startResidentFrozen: async () => { started = true; return { frozen: true, pid: RESIDENT_PID, handle: {} } } },
      outputPaths: { capture: join(root, 'evidence/capture.json'), lifecycle: join(root, 'evidence/lifecycle.json'), result: join(root, 'evidence/result.json') },
    }), new RegExp(`must match requested isolated port ${ISOLATED_PROBE_SERVER_PORT}`, 'u'))
    assert.equal(started, false, 'noncanonical isolated port is rejected before resident start')
    assert.equal(calls.includes('arm'), false, 'noncanonical isolated port is rejected before capture arm')
  }

  {
    const root = join(temporary, 'wrong-terminal')
    const { paths, serverAttestation } = setup(root)
    const calls = []
    let clock = Date.parse(t(0))
    const result = await runVtrReachProbeSupervisor({
      attemptRoot: root,
      runtimeDir: join(root, 'runtime'),
      sourceSha: SOURCE,
      paths,
      expectedCaptureSchema: 'vtr-provider-activity-capture/v2',
      expectedCaptureStatus: 'OBSERVED',
      serverAttestation,
      watchFactory: watchFactory(calls, captureFixture()),
      observerAdapter: createObserverAdapter(calls, join(root, 'runtime')),
      adapters: createAdapters({ calls, paths, leaf: root, wrongOutcome: true, now: () => Date.parse(t(10)) }),
      outputPaths: { capture: join(root, 'evidence/capture.json'), lifecycle: join(root, 'evidence/lifecycle.json'), result: join(root, 'evidence/result.json') },
      now: () => { clock += 10; return clock },
      timeoutMs: 1000,
      pollMs: 25,
      sleep: async () => {},
    })
    assert.equal(result.status, 'INCOMPLETE', JSON.stringify(result, null, 2))
    assert.match(result.failure, /typed Reach Transition terminal outcome/u)
    assert.equal(calls.includes('collect'), false, 'mismatched Transition id never reaches collector')
    assert.equal(calls.indexOf('stop-resident') < calls.indexOf('stop-leaf'), true)
  }

  {
    const root = join(temporary, 'resident-stop-lies-alive')
    const { paths, serverAttestation } = setup(root)
    const calls = []
    let clock = Date.parse(t(10))
    const now = () => { clock += 100; return clock }
    const adapters = createAdapters({ calls, paths, leaf: root, now })
    const stopResident = adapters.stopResident
    adapters.stopResident = async (args) => {
      const stopped = await stopResident(args)
      return {
        ...stopped,
        // The adapter claims STOPPED but its explicit child observation says
        // that the resident process is still alive.
        processExitObservation: { ...stopped.processExitObservation, state: 'running' },
      }
    }
    const result = await runVtrReachProbeSupervisor({
      attemptRoot: root,
      runtimeDir: join(root, 'runtime'),
      sourceSha: SOURCE,
      paths,
      expectedCaptureSchema: 'vtr-provider-activity-capture/v2',
      expectedCaptureStatus: 'OBSERVED',
      serverAttestation,
      watchFactory: watchFactory(calls, captureFixture()),
      observerAdapter: createObserverAdapter(calls, join(root, 'runtime')),
      adapters,
      outputPaths: { capture: join(root, 'evidence/capture.json'), lifecycle: join(root, 'evidence/lifecycle.json'), result: join(root, 'evidence/result.json') },
      now,
      timeoutMs: 3000,
      sleep: async () => {},
    })
    assert.equal(result.status, 'FAIL', JSON.stringify(result, null, 2))
    assert.equal(calls.includes('stop-leaf'), true, 'Leaf is still stopped after resident stop attestation fails')
    assert.equal(calls.includes('finish'), true, 'capture closes after best-effort teardown')
    assert.equal(calls.includes('seal'), false, 'archive cannot seal while the resident exit was not observed')
  }

  {
    const root = join(temporary, 'leaf-listener-lies-open')
    const { paths, serverAttestation } = setup(root)
    const calls = []
    let clock = Date.parse(t(10))
    const now = () => { clock += 100; return clock }
    const adapters = createAdapters({ calls, paths, leaf: root, now })
    const stopLeaf = adapters.stopIsolatedLeaf
    adapters.stopIsolatedLeaf = async (args) => {
      const stopped = await stopLeaf(args)
      return {
        ...stopped,
        // The adapter claims STOPPED while a TCP probe still sees a listener.
        listenerClosureObservation: { ...stopped.listenerClosureObservation, state: 'open', result: 'connection-accepted' },
      }
    }
    const result = await runVtrReachProbeSupervisor({
      attemptRoot: root,
      runtimeDir: join(root, 'runtime'),
      sourceSha: SOURCE,
      paths,
      expectedCaptureSchema: 'vtr-provider-activity-capture/v2',
      expectedCaptureStatus: 'OBSERVED',
      serverAttestation,
      watchFactory: watchFactory(calls, captureFixture()),
      observerAdapter: createObserverAdapter(calls, join(root, 'runtime')),
      adapters,
      outputPaths: { capture: join(root, 'evidence/capture.json'), lifecycle: join(root, 'evidence/lifecycle.json'), result: join(root, 'evidence/result.json') },
      now,
      timeoutMs: 3000,
      sleep: async () => {},
    })
    assert.equal(result.status, 'FAIL', JSON.stringify(result, null, 2))
    assert.equal(calls.includes('stop-resident'), true)
    assert.equal(calls.includes('finish'), true, 'capture closes after best-effort teardown')
    assert.equal(calls.includes('seal'), false, 'archive cannot seal while the Leaf listener remains open')
  }

  {
    const root = join(temporary, 'outcome-identity-mismatch')
    const { paths, serverAttestation } = setup(root)
    const calls = []
    let clock = Date.parse(t(0))
    const result = await runVtrReachProbeSupervisor({
      attemptRoot: root,
      runtimeDir: join(root, 'runtime'),
      sourceSha: SOURCE,
      paths,
      expectedCaptureSchema: 'vtr-provider-activity-capture/v2',
      expectedCaptureStatus: 'OBSERVED',
      serverAttestation,
      watchFactory: watchFactory(calls, captureFixture()),
      observerAdapter: createObserverAdapter(calls, join(root, 'runtime')),
      adapters: createAdapters({ calls, paths, leaf: root, wrongOutcomeIdentity: true, now: () => Date.parse(t(10)) }),
      outputPaths: { capture: join(root, 'evidence/capture.json'), lifecycle: join(root, 'evidence/lifecycle.json'), result: join(root, 'evidence/result.json') },
      now: () => { clock += 10; return clock },
      timeoutMs: 1000,
      pollMs: 25,
      sleep: async () => {},
    })
    assert.equal(result.status, 'FAIL', JSON.stringify(result, null, 2))
    assert.match(result.failure ?? '', /outcome is not bound/u)
    assert.equal(calls.includes('collect'), false, 'outcome from another generation/world never reaches collector')
    assert.equal(calls.includes('seal'), false)
  }
} finally {
  rmSync(temporary, { recursive: true, force: true })
}

process.stdout.write('vtr-reach-probe-supervisor: focused lifecycle tests passed\n')
