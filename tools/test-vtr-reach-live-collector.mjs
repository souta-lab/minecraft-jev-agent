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

function fixture({
  sourceSha = SOURCE,
  outcomeKind = 'SUCCESS',
  verified = true,
  decisionFrames = 0,
  providerAttempts = 0,
  includeModelMetrics = true,
  conflictingModelMetrics = false,
  suffixOnlyModelMetrics = false,
  legs = 1,
  separateActuationPerLeg = false,
  decisionFrameMarker = false,
  identityRun = RUN,
  boundary = 'verified-terminal',
} = {}) {
  const expected = { ...MISSION }
  const actionId = 'MOVE:oak#1'
  const intentId = 'intent-1'
  const stepIds = Array.from({ length: legs }, (_, index) => `${actionId}:walk-leg-${index + 1}`)
  const actuationSpecs = separateActuationPerLeg
    ? stepIds.map((stepId, index) => ({ intentId: `intent-${index + 1}`, actionId: `${actionId}:leg-${index + 1}`, stepId }))
    : [{ intentId, actionId, stepId: stepIds[0] }]
  const terminalOffset = 9 + 2 * (legs - 1)
  const verifyOffset = terminalOffset - 1
  const evidenceId = `verify:${verifyOffset}:oak_log@1,64,1`
  const hostActuations = actuationSpecs.map((owner) => hostLine(5, 'VTR_TRANSITION_ACTUATION', {
    transitionId: TRANSITION, contractHash: CONTRACT, runId: RUN, generationId: GENERATION, sourceSha: SOURCE,
    intentId: owner.intentId, actionId: owner.actionId, authority: 'vtr_transition',
  }))
  const hostReservations = stepIds.map((stepId, index) => {
    const owner = actuationSpecs[index % actuationSpecs.length]
    return hostLine(6 + index, 'VTR_MECHANICAL_STEP_RESERVED', {
      transitionId: TRANSITION, contractHash: CONTRACT, intentId: owner.intentId, actionId: owner.actionId, stepId, leg: index + 1,
      usage: { mechanicalSteps: index + 1 }, runId: RUN, generationId: GENERATION, sourceSha: SOURCE,
    })
  })
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
    hostLine(4, 'VTR_TRANSITION_COMMIT', { id: TRANSITION, contractHash: CONTRACT, runId: RUN, generationId: GENERATION, sourceSha: SOURCE }),
    ...hostActuations,
    ...hostReservations,
    hostLine(6 + legs * 2, 'VTR_MECHANICAL_OUTCOME', { transitionId: TRANSITION, contractHash: CONTRACT, runId: RUN, generationId: GENERATION, sourceSha: SOURCE }),
    hostLine(verifyOffset, 'VTR_TRANSITION_VERIFY', { id: TRANSITION, contractHash: CONTRACT, truth: verified ? 'TRUE' : 'FALSE', runId: RUN, generationId: GENERATION, sourceSha: SOURCE }),
    hostLine(terminalOffset, 'VTR_TRANSITION_OUTCOME', { id: TRANSITION, contractHash: CONTRACT, outcome: outcomeKind, runId: RUN, generationId: GENERATION, sourceSha: SOURCE }),
  ].join('\n') + '\n'
  const commit = row(4, `VTR_TRANSITION_COMMIT id=${TRANSITION} contractHash=${CONTRACT}`, {
    transitionId: TRANSITION,
    contractHash: CONTRACT,
    mission: expected,
    desiredPredicate: ENSURE,
    ensures: [ENSURE_REORDERED],
    identity: { worldKey: WORLD, dimension: 'overworld', worldEpoch: 4, generationId: GENERATION, leaseId: GENERATION },
  })
  const actuations = actuationSpecs.map((owner, index) => row(5 + index, `VTR_TRANSITION_ACTUATION transitionId=${TRANSITION} intent=${owner.intentId} action=${owner.actionId} contractHash=${CONTRACT} authority=vtr_transition`, {
    transitionId: TRANSITION, intentId: owner.intentId, actionId: owner.actionId, candidate: actionId, contractHash: CONTRACT, authority: 'vtr-transition-controller',
  }))
  const reservations = stepIds.map((stepId, index) => {
    const owner = actuationSpecs[index % actuationSpecs.length]
    return row(6 + index, `VTR_MECHANICAL_STEP_RESERVED transition=${TRANSITION} intent=${owner.intentId} action=${owner.actionId} step=${stepId} leg=${index + 1}`, {
      transitionId: TRANSITION, contractHash: CONTRACT, intentId: owner.intentId, actionId: owner.actionId, stepId, leg: index + 1,
      usage: { mechanicalSteps: index + 1 },
    })
  })
  const skillSteps = stepIds.map((_, index) => row(6 + index, 'SKILL_STEP skill=walk_to step=move', {
    actionId: actuationSpecs[index % actuationSpecs.length].actionId, stepKind: 'move', count: 1,
  }))
  const stepOutcomes = stepIds.map((stepId, index) => {
    const owner = actuationSpecs[index % actuationSpecs.length]
    const isTerminalSuccess = index === legs - 1 && outcomeKind === 'SUCCESS'
    const status = isTerminalSuccess ? 'terminal' : 'active'
    const stepOutcome = isTerminalSuccess ? 'SUCCESS' : 'CONTINUING'
    return row(6 + legs + index, `VTR_MECHANICAL_STEP_OUTCOME transition=${TRANSITION} intent=${owner.intentId} action=${owner.actionId} step=${stepId} leg=${index + 1} status=${status} outcome=${stepOutcome} verified=${isTerminalSuccess}`, {
      transitionId: TRANSITION, contractHash: CONTRACT, intentId: owner.intentId, actionId: owner.actionId, stepId, leg: index + 1,
      status, outcome: stepOutcome, verified: isTerminalSuccess,
    })
  })
  const mechanical = row(6 + legs * 2, `VTR_MECHANICAL_OUTCOME transitionId=${TRANSITION} contractHash=${CONTRACT} status=done verified=true`, {
    transitionId: TRANSITION, contractHash: CONTRACT, status: 'done', verified: true,
  })
  const movement = row(6 + legs * 2, `MOVE ${actionId} arrival start=(1,64,1) end=(2,65,2)`, {
    actionId, start: { x: 1, y: 64, z: 1 }, end: { x: 2, y: 65, z: 2 },
  })
  const verify = row(verifyOffset, `VTR_TRANSITION_VERIFY id=${TRANSITION} contractHash=${CONTRACT} truth=${verified ? 'TRUE' : 'FALSE'}`, {
    transitionId: TRANSITION,
    contractHash: CONTRACT,
    truth: verified ? 'TRUE' : 'FALSE',
    predicates: [{ id: ENSURE.id, expected: true, truth: verified ? 'true' : 'false', evidenceId }],
    evidenceIds: [evidenceId],
    verifiedAtMs: T0 + verifyOffset,
    observedAtMs: T0 + verifyOffset,
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
  const metricsEventText = `VTR_TRANSITION_MODEL_METRICS transitionId=${TRANSITION} contractHash=${CONTRACT} outcome=${outcomeKind} mechanicalSteps=${legs} decisionFrameInvocations=${decisionFrames} providerEvaluateAttempts=${providerAttempts}`
  const metricsEvent = row(verifyOffset, metricsEventText, {
    transitionId: TRANSITION,
    contractHash: CONTRACT,
    typedTerminalOutcome: outcomeKind,
    mechanicalSteps: legs,
    jevDecisionFrameInvocations: decisionFrames,
    jevModelProviderEvaluateAttempts: providerAttempts,
  })
  const conflictingMetricsEvent = row(verifyOffset, metricsEventText.replace(`providerEvaluateAttempts=${providerAttempts}`, `providerEvaluateAttempts=${providerAttempts + 1}`), {
    transitionId: TRANSITION,
    contractHash: CONTRACT,
    typedTerminalOutcome: outcomeKind,
    mechanicalSteps: legs,
    jevDecisionFrameInvocations: decisionFrames,
    jevModelProviderEvaluateAttempts: providerAttempts + 1,
  })
  const decisionFrame = row(5, 'JEV_DECISION_EPOCH_START epoch=1 reason=grounded_route_choice', { epoch: 1 })
  const outcome = row(terminalOffset, `VTR_TRANSITION_OUTCOME id=${TRANSITION} outcome=${outcomeKind} boundary=${boundary}`, {
    transitionId: TRANSITION,
    contractHash: CONTRACT,
    outcome: { kind: outcomeKind, contractHash: CONTRACT, evidenceIds: [evidenceId] },
    boundary,
    usage: { mechanicalSteps: legs, elapsedMs: 300, resources: {}, risk: {}, effects: { locomotion: 1 } },
    metrics: {
      verifiedTransitionCompletion: outcomeKind === 'SUCCESS' ? 1 : 0,
      mechanicalStepsPerTransition: legs,
      jevCallsPerTransition: decisionFrames,
      system2CallsPerTransition: 0,
      modelCallsPerMechanicalStep: legs === 0 ? null : decisionFrames / legs,
      typedTerminalOutcome: outcomeKind,
      duplicateAuthority: false,
      duplicateAuthorityConflicts: 0,
    },
  })
  const runRows = [commit, ...actuations, ...reservations, ...skillSteps, ...stepOutcomes, mechanical, movement]
  if (decisionFrameMarker) runRows.push(decisionFrame)
  runRows.push(verify)
  if (includeModelMetrics) runRows.push(metricsEvent)
  if (conflictingModelMetrics) runRows.push(conflictingMetricsEvent)
  if (suffixOnlyModelMetrics) runRows.push(row(verifyOffset, `X_${metricsEventText}`, { transitionId: TRANSITION, contractHash: CONTRACT }))
  runRows.push(outcome)
  const runJournalText = runRows.map((entry) => JSON.stringify(entry)).join('\n') + '\n'
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
assert.equal(successReport.observed.transition.metrics.mechanicalStepOutcomeRows, 1)
assert.equal(successReport.observed.transition.metrics.skillStepEventRows, 1)
assert.deepEqual(successReport.observed.transition.metrics.skillStepKindEventRows, { move: 1 })
assert.equal(successReport.observed.transition.metrics.observedCommitToTerminalMs, 5)
assert.deepEqual(successReport.observed.transition.executionTrace.movementCompletion, {
  start: { x: 1, y: 64, z: 1 },
  end: { x: 2, y: 65, z: 2 },
})
assert.equal(successReport.observed.transition.metrics.jevCallsPerTransition, 0)
assert.equal(successReport.observed.transition.metrics.modelMetricsStatus, 'OBSERVED')
assert.equal(successReport.observed.transition.metrics.decisionFrameInvocations, 0)
assert.equal(successReport.observed.transition.metrics.providerEvaluateAttempts, 0)
assert.equal(successReport.observed.transition.metrics.providerEvaluateAttemptsIncludingRetries, 0)
assert.equal(successReport.observed.transition.outcome.detail.outcome.kind, 'SUCCESS')
assert.equal(successReport.checks.find((entry) => entry.id === 'transition:persistent-reach-actuation').status, 'PASS')
assert.equal(successReport.checks.find((entry) => entry.id === 'metrics:vtr-transition-model-metrics').status, 'PASS')

const actionOnly = fixture()
actionOnly.input.runJournalText = actionOnly.input.runJournalText.split('\n').filter((line) => !line.includes('VTR_TRANSITION_VERIFY')).join('\n') + '\n'
const actionOnlyReport = evaluateCapture(actionOnly.input)
assert.equal(actionOnlyReport.status, 'FAIL')
assert.equal(actionOnlyReport.checks.find((entry) => entry.id === 'transition:deterministic-verify-and-success').status, 'FAIL')

const changedSource = fixture({ sourceSha: 'b'.repeat(40) })
const changedSourceReport = evaluateCapture(changedSource.input)
assert.equal(changedSourceReport.status, 'FAIL')
assert.equal(changedSourceReport.checks.find((entry) => entry.id === 'observer:exact-live-identity').status, 'FAIL')

const localDecisionFrame = fixture({ decisionFrames: 1, decisionFrameMarker: true })
localDecisionFrame.input.jevCallsText = `${JSON.stringify({ record: 'jev-call', ts: iso(5), policy: 'fallback', providerAttempts: 0 })}\n`
localDecisionFrame.input.jevDecisionsText = `${JSON.stringify({ record: 'decision', ts: iso(5), jev: { policy: 'fallback', source: 'fallback' } })}\n`
const localDecisionFrameReport = evaluateCapture(localDecisionFrame.input)
assert.equal(localDecisionFrameReport.status, 'PASS', JSON.stringify(localDecisionFrameReport.checks, null, 2))
assert.equal(localDecisionFrameReport.observed.transition.metrics.decisionFrameInvocations, 1)
assert.equal(localDecisionFrameReport.observed.transition.metrics.providerEvaluateAttempts, 0)
assert.equal(localDecisionFrameReport.observed.transition.metrics.providerEvaluateAttemptsIncludingRetries, 0)
assert.equal(localDecisionFrameReport.checks.find((entry) => entry.id === 'policy:no-model-activity-during-probe').status, 'PASS')
assert.equal(localDecisionFrameReport.checks.find((entry) => entry.id === 'policy:no-model-activity-during-probe').observed.decisionFrameMarkers, 1)

const providerAttempt = fixture({ decisionFrames: 1, providerAttempts: 1, decisionFrameMarker: true })
const providerAttemptReport = evaluateCapture(providerAttempt.input)
assert.equal(providerAttemptReport.status, 'FAIL')
assert.equal(providerAttemptReport.observed.transition.metrics.decisionFrameInvocations, 1)
assert.equal(providerAttemptReport.observed.transition.metrics.providerEvaluateAttemptsIncludingRetries, 1)
assert.equal(providerAttemptReport.checks.find((entry) => entry.id === 'policy:no-model-activity-during-probe').status, 'FAIL')

const system2JournalActivity = fixture()
system2JournalActivity.input.system2Text = `${JSON.stringify({ record: 'system2-plan', ts: iso(5), providerAttempts: 0 })}\n`
const system2JournalActivityReport = evaluateCapture(system2JournalActivity.input)
assert.equal(system2JournalActivityReport.status, 'FAIL')
assert.equal(system2JournalActivityReport.checks.find((entry) => entry.id === 'policy:no-model-activity-during-probe').status, 'FAIL')

const missingMetrics = fixture({ includeModelMetrics: false })
const missingMetricsReport = evaluateCapture(missingMetrics.input)
assert.equal(missingMetricsReport.status, 'INCOMPLETE')
assert.equal(missingMetricsReport.observed.transition.metrics.modelMetricsStatus, 'UNKNOWN')
assert.equal(missingMetricsReport.observed.transition.metrics.decisionFrameInvocations, null)
assert.equal(missingMetricsReport.observed.transition.metrics.providerEvaluateAttemptsIncludingRetries, null)
assert.equal(missingMetricsReport.checks.find((entry) => entry.id === 'policy:no-model-activity-during-probe').status, 'INCOMPLETE')

const conflictingMetrics = fixture({ conflictingModelMetrics: true })
const conflictingMetricsReport = evaluateCapture(conflictingMetrics.input)
assert.equal(conflictingMetricsReport.status, 'FAIL')
assert.equal(conflictingMetricsReport.observed.transition.metrics.modelMetricsStatus, 'CONFLICT')
assert.equal(conflictingMetricsReport.checks.find((entry) => entry.id === 'metrics:vtr-transition-model-metrics').status, 'FAIL')

const suffixMetricMarker = fixture({ includeModelMetrics: false, suffixOnlyModelMetrics: true })
const suffixMetricMarkerReport = evaluateCapture(suffixMetricMarker.input)
assert.equal(suffixMetricMarkerReport.status, 'INCOMPLETE')
assert.equal(suffixMetricMarkerReport.observed.transition.metrics.modelMetricsStatus, 'UNKNOWN')

const threeLegReach = fixture({ legs: 3, decisionFrames: 2 })
const threeLegReachReport = evaluateCapture(threeLegReach.input)
assert.equal(threeLegReachReport.status, 'PASS', JSON.stringify(threeLegReachReport.checks, null, 2))
assert.equal(threeLegReachReport.observed.transition.metrics.mechanicalStepReservations, 3)
assert.equal(threeLegReachReport.observed.transition.metrics.mechanicalStepOutcomeRows, 3)
assert.equal(threeLegReachReport.observed.transition.executionTrace.actionIds.length, 1)
assert.equal(threeLegReachReport.observed.transition.persistentActuationOwner.intentId, 'intent-1')
assert.equal(threeLegReachReport.checks.find((entry) => entry.id === 'transition:persistent-reach-actuation').observed.actuationCount, 1)

const perLegActuations = fixture({ legs: 3, separateActuationPerLeg: true })
const perLegActuationsReport = evaluateCapture(perLegActuations.input)
assert.equal(perLegActuationsReport.status, 'FAIL')
assert.equal(perLegActuationsReport.checks.find((entry) => entry.id === 'transition:persistent-reach-actuation').status, 'FAIL')
assert.ok(perLegActuationsReport.observed.transition.persistentReachOwnershipProblems.some((entry) => entry.startsWith('persistent-transition-requires-one-actuation:')))

const mismatchedStepEvidence = fixture({ legs: 3 })
mismatchedStepEvidence.input.runJournalText = mismatchedStepEvidence.input.runJournalText.split('\n').filter(Boolean).map((line) => {
  const entry = JSON.parse(line)
  if (entry.message?.startsWith('VTR_MECHANICAL_STEP_OUTCOME ') && entry.detail?.leg === 2) entry.detail.actionId = `${entry.detail.actionId}:wrong-owner`
  if (entry.message?.startsWith('VTR_MECHANICAL_STEP_OUTCOME ') && entry.detail?.leg === 3) entry.detail.contractHash = 'd'.repeat(64)
  return JSON.stringify(entry)
}).join('\n') + '\n'
const mismatchedStepEvidenceReport = evaluateCapture(mismatchedStepEvidence.input)
assert.equal(mismatchedStepEvidenceReport.status, 'FAIL')
assert.equal(mismatchedStepEvidenceReport.checks.find((entry) => entry.id === 'transition:persistent-reach-actuation').status, 'FAIL')
assert.ok(mismatchedStepEvidenceReport.observed.transition.persistentReachOwnershipProblems.some((entry) => entry.includes('reservation-step-outcome-actionId-mismatch')))
assert.ok(mismatchedStepEvidenceReport.observed.transition.persistentReachOwnershipProblems.some((entry) => entry === 'contract-mismatch:VTR_MECHANICAL_STEP_OUTCOME'))

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

process.stdout.write('VTR Reach live collector tests passed (16 cases)\n')
