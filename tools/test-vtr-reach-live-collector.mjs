#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectLive, evaluateCapture, parseHostLog, parseJsonl } from './collect-vtr-reach-live.mjs'

const SOURCE = 'a'.repeat(40)
const RUN = 'run-mtest-abc123'
const GENERATION = 'gen-mtest-xyz789'
const WORLD = '127.0.0.1:25565|overworld|4'
const MISSION = { kind: 'inventory_at_least', item: 'oak_log', count: 1 }
const TRANSITION = 'transition-001'
const CONTRACT = 'c'.repeat(64)
const ENSURE = {
  id: 'reach.resource-source',
  proposition: { kind: 'within-interaction-reach-of-resource-source', item: 'oak_log', sourceNames: ['oak_log'], interactionReach: 5 },
  expected: true,
}
const ENSURE_REORDERED = {
  id: ENSURE.id,
  proposition: { interactionReach: 5, item: 'oak_log', kind: 'within-interaction-reach-of-resource-source', sourceNames: ['oak_log'] },
  expected: true,
}
const T0 = Date.parse('2026-09-25T04:00:00.000Z')
const iso = (offset) => new Date(T0 + offset).toISOString()

function hostLine(offset, event, fields) {
  const encoded = Object.entries(fields).map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : String(value)}`).join(' ')
  return `[${iso(offset)}] ${event} ${encoded}`
}

function row(offset, message, detail) {
  return { record: 'agent-event', ts: iso(offset), tick: offset, source: 'vtr', level: 'info', message, detail }
}

function fixture({ sourceSha = SOURCE, outcomeKind = 'SUCCESS', verified = true, modelCalls = 0, identityRun = RUN, boundary = 'verified-terminal' } = {}) {
  const expected = { ...MISSION }
  const hostLogText = [
    hostLine(0, 'BOOT', {
      runId: RUN,
      source: SOURCE,
      mission: { ...MISSION, source: 'test-config' },
      worldKey: { serverId: '127.0.0.1:25565', dimension: 'minecraft:overworld', worldEpoch: 4 },
    }),
    hostLine(1, 'VTR_REACH_PROBE_CONFIGURED', {
      mission: MISSION,
      compatibilityLadder: 'observer-only',
      ledgerRestore: 'disabled',
      plannerBootstrap: 'disabled',
      system2Mode: 'off',
      jevPolicyMode: 'fallback',
    }),
    hostLine(2, 'VTR_REACH_PROBE_QUEUE_EMPTY', { source: 'configured Mission', restoredLegacyRows: 0, authority: 'vtr-transition-scheduler' }),
    hostLine(3, 'GENERATION_READY', {
      runId: RUN,
      id: GENERATION,
      generationId: GENERATION,
      sourceSha: SOURCE,
      buildHash: 'fixture-build',
      productionPlanAuthority: 'vtr-reach-probe',
      policy: 'fallback',
      policyProvider: 'deterministic',
      system2Provider: 'none',
    }),
    hostLine(4, 'VTR_TRANSITION_COMMIT', { id: TRANSITION, runId: RUN, generationId: GENERATION, sourceSha: SOURCE }),
    hostLine(5, 'VTR_TRANSITION_ACTUATION', { transitionId: TRANSITION, contractHash: CONTRACT, runId: RUN, generationId: GENERATION, sourceSha: SOURCE, authority: 'vtr_transition' }),
    hostLine(6, 'VTR_MECHANICAL_STEP_RESERVED', { transitionId: TRANSITION, intentId: 'intent-1', stepId: 'MOVE:oak#1:walk-leg-1', usage: { mechanicalSteps: 1 }, runId: RUN, generationId: GENERATION, sourceSha: SOURCE }),
    hostLine(7, 'VTR_MECHANICAL_OUTCOME', { transitionId: TRANSITION, contractHash: CONTRACT, runId: RUN, generationId: GENERATION, sourceSha: SOURCE }),
    hostLine(8, 'VTR_TRANSITION_VERIFY', { id: TRANSITION, contractHash: CONTRACT, truth: verified ? 'TRUE' : 'FALSE', runId: RUN, generationId: GENERATION, sourceSha: SOURCE }),
    hostLine(9, 'VTR_TRANSITION_OUTCOME', { id: TRANSITION, contractHash: CONTRACT, outcome: outcomeKind, runId: RUN, generationId: GENERATION, sourceSha: SOURCE }),
  ].join('\n') + '\n'
  const commit = row(4, `VTR_TRANSITION_COMMIT id=${TRANSITION} contractHash=${CONTRACT}`, {
    transitionId: TRANSITION,
    mission: expected,
    desiredPredicate: ENSURE,
    ensures: [ENSURE_REORDERED],
    identity: { worldKey: WORLD, dimension: 'overworld', worldEpoch: 4, generationId: GENERATION, leaseId: GENERATION },
  })
  const actuation = row(5, `VTR_TRANSITION_ACTUATION transitionId=${TRANSITION} contractHash=${CONTRACT} authority=vtr_transition`, { transitionId: TRANSITION, intentId: 'intent-1', contractHash: CONTRACT, authority: 'vtr_transition' })
  const reserved = row(6, `VTR_MECHANICAL_STEP_RESERVED transitionId=${TRANSITION} intentId=intent-1 stepId=MOVE:oak#1:walk-leg-1`, { transitionId: TRANSITION, intentId: 'intent-1', stepId: 'MOVE:oak#1:walk-leg-1', usage: { mechanicalSteps: 1 } })
  const mechanical = row(7, `VTR_MECHANICAL_OUTCOME transitionId=${TRANSITION} contractHash=${CONTRACT} status=done verified=true`, { transitionId: TRANSITION, contractHash: CONTRACT, status: 'done', verified: true })
  const verify = row(8, `VTR_TRANSITION_VERIFY id=${TRANSITION} contractHash=${CONTRACT} truth=${verified ? 'TRUE' : 'FALSE'}`, {
    transitionId: TRANSITION,
    contractHash: CONTRACT,
    truth: verified ? 'TRUE' : 'FALSE',
    predicates: [{ id: ENSURE.id, expected: true, truth: verified ? 'true' : 'false', evidenceId: 'verify:8:oak_log@1,64,1' }],
    evidenceIds: ['verify:8:oak_log@1,64,1'],
    verifiedAtMs: T0 + 8,
    observedAtMs: T0 + 8,
    runId: identityRun,
    generationId: GENERATION,
    leaseId: GENERATION,
    sourceSha: SOURCE,
    worldKey: WORLD,
    worldEpoch: 4,
    dimension: 'overworld',
    identityMatches: true,
    predicatesVerified: verified,
  })
  const outcome = row(9, `VTR_TRANSITION_OUTCOME id=${TRANSITION} outcome=${outcomeKind} boundary=${boundary}`, {
    transitionId: TRANSITION,
    contractHash: CONTRACT,
    outcome: { kind: outcomeKind, contractHash: CONTRACT, evidenceIds: ['verify:8:oak_log@1,64,1'] },
    boundary,
    usage: { mechanicalSteps: 1, elapsedMs: 300, resources: {}, risk: {}, effects: { locomotion: 1 } },
    metrics: {
      verifiedTransitionCompletion: outcomeKind === 'SUCCESS' ? 1 : 0,
      mechanicalStepsPerTransition: 1,
      jevCallsPerTransition: modelCalls,
      system2CallsPerTransition: 0,
      modelCallsPerMechanicalStep: modelCalls,
      typedTerminalOutcome: outcomeKind,
      duplicateAuthority: false,
      duplicateAuthorityConflicts: 0,
    },
  })
  const runJournalText = [commit, actuation, reserved, mechanical, verify, outcome].map((entry) => JSON.stringify(entry)).join('\n') + '\n'
  const summary = {
    freshnessMs: 10,
    status: { available: true, connected: true, frozen: false },
    run: {
      id: RUN,
      sourceCommit: sourceSha,
      generationId: GENERATION,
      worldKey: { serverId: '127.0.0.1:25565', dimension: 'minecraft:overworld', worldEpoch: 4 },
    },
    mission: { predicate: expected },
    worldObservation: { position: { x: 1.5, y: 64, z: 1.5 }, dimension: 'overworld' },
  }
  return {
    input: {
      hostLogText,
      runJournalText,
      jevCallsText: '',
      jevDecisionsText: '',
      system2Text: '',
      mission: expected,
      expectedSourceSha: SOURCE,
      observerSamples: [{ capturedAt: iso(9), requestOk: true, summary }],
    },
    expected,
  }
}

const host = parseHostLog('[2026-09-25T04:00:00.000Z] BOOT runId=run-test source=' + SOURCE + ' mission={"kind":"inventory_at_least","item":"oak_log","count":1} worldKey={"serverId":"127.0.0.1:25565","dimension":"minecraft:overworld","worldEpoch":4}\n')
assert.equal(host[0].fields.mission.item, 'oak_log')
assert.equal(host[0].fields.worldKey.worldEpoch, 4)
assert.deepEqual(parseJsonl('{"ts":"2026-09-25T04:00:00Z"}\n', 'fixture').errors, [])

const success = fixture()
const successReport = evaluateCapture(success.input)
assert.equal(successReport.status, 'PASS', JSON.stringify(successReport.checks, null, 2))
assert.equal(successReport.acceptanceEligible, false)
assert.equal(successReport.observed.transition.metrics.verifiedTransitionCompletion, 1)
assert.equal(successReport.observed.transition.metrics.mechanicalStepsPerTransition, 1)
assert.equal(successReport.observed.transition.metrics.mechanicalStepReservations, 1)
assert.equal(successReport.observed.transition.metrics.jevCallsPerTransition, 0)
assert.equal(successReport.observed.transition.outcome.detail.outcome.kind, 'SUCCESS')

const actionOnly = fixture()
actionOnly.input.runJournalText = actionOnly.input.runJournalText.split('\n').filter((line) => !line.includes('VTR_TRANSITION_VERIFY')).join('\n') + '\n'
const actionOnlyReport = evaluateCapture(actionOnly.input)
assert.equal(actionOnlyReport.status, 'FAIL')
assert.equal(actionOnlyReport.checks.find((entry) => entry.id === 'transition:deterministic-verify-and-success').status, 'FAIL')

const changedSource = fixture({ sourceSha: 'b'.repeat(40) })
const changedSourceReport = evaluateCapture(changedSource.input)
assert.equal(changedSourceReport.status, 'FAIL')
assert.equal(changedSourceReport.checks.find((entry) => entry.id === 'observer:exact-live-identity').status, 'FAIL')

const modelCall = fixture({ modelCalls: 1 })
const modelCallReport = evaluateCapture(modelCall.input)
assert.equal(modelCallReport.status, 'FAIL')
assert.equal(modelCallReport.checks.find((entry) => entry.id === 'policy:no-model-activity-during-probe').status, 'FAIL')

const wrongRun = fixture({ identityRun: 'run-other-xyz' })
const wrongRunReport = evaluateCapture(wrongRun.input)
assert.equal(wrongRunReport.status, 'FAIL')
assert.equal(wrongRunReport.checks.find((entry) => entry.id === 'transition:deterministic-verify-and-success').status, 'FAIL')

const mechanicalBoundary = fixture({ boundary: 'mechanical-step-outcome' })
const mechanicalBoundaryReport = evaluateCapture(mechanicalBoundary.input)
assert.equal(mechanicalBoundaryReport.status, 'INCOMPLETE')
assert.equal(mechanicalBoundaryReport.observed.transition.typedOutcomeOk, true)
assert.equal(mechanicalBoundaryReport.observed.transition.mechanicalReservationsMatchActuation, true)
assert.equal(mechanicalBoundaryReport.checks.find((entry) => entry.id === 'schema:validator-boundary-compatibility').status, 'INCOMPLETE')

const pinnedPostRun = fixture()
pinnedPostRun.input.observerSamples = []
pinnedPostRun.input.expectedRunId = RUN
pinnedPostRun.input.expectedGenerationId = GENERATION
const pinnedPostRunReport = evaluateCapture(pinnedPostRun.input)
assert.equal(pinnedPostRunReport.status, 'PASS', JSON.stringify(pinnedPostRunReport.checks, null, 2))
assert.equal(pinnedPostRunReport.checks.find((entry) => entry.id === 'observer:stable-identity').status, 'NOT_CAPTURED')

const tempDir = mkdtempSync(join(tmpdir(), 'vtr-reach-collector-test-'))
try {
  const liveFixture = fixture()
  const files = {
    host: join(tempDir, 'buddy.log'),
    run: join(tempDir, 'run.jsonl'),
    calls: join(tempDir, 'jev-calls.jsonl'),
    decisions: join(tempDir, 'decisions.jsonl'),
    system2: join(tempDir, 'system2.jsonl'),
    mission: join(tempDir, 'mission.json'),
    output: join(tempDir, 'capture.json'),
  }
  writeFileSync(files.host, liveFixture.input.hostLogText)
  writeFileSync(files.run, liveFixture.input.runJournalText)
  for (const path of [files.calls, files.decisions, files.system2]) writeFileSync(path, '')
  writeFileSync(files.mission, JSON.stringify(MISSION))
  let requests = 0
  const liveResult = await collectLive([
    '--host-log', files.host,
    '--run-journal', files.run,
    '--jev-calls', files.calls,
    '--jev-decisions', files.decisions,
    '--system2-journal', files.system2,
    '--mission-file', files.mission,
    '--source-sha', SOURCE,
    '--run-id', RUN,
    '--generation-id', GENERATION,
    '--timeout-ms', '1000',
    '--output', files.output,
  ], {
    fetchImpl: async (url, options) => {
      requests += 1
      assert.equal(url, 'http://127.0.0.1:4173/api/ai-summary')
      assert.equal(options.method, 'GET')
      return { ok: true, json: async () => ({ status: { available: false, connected: false } }) }
    },
  })
  assert.equal(requests, 1)
  assert.equal(liveResult.report.status, 'PASS', JSON.stringify(liveResult.report.checks, null, 2))
  assert.equal(JSON.parse(readFileSync(files.output, 'utf8')).observed.transition.outcome.detail.outcome.kind, 'SUCCESS')
} finally {
  rmSync(tempDir, { recursive: true, force: true })
}

process.stdout.write('VTR Reach live collector tests passed (8 cases)\n')
