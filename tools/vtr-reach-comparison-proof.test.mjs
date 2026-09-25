import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { inspectReachComparisonProof } from './validate-vtr-reach-evidence.mjs'

const sha256 = (value) => createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex')
const encode = (value) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  const bytes = Buffer.from(text, 'utf8')
  return { sizeBytes: bytes.length, sha256: sha256(bytes), contentBase64: bytes.toString('base64') }
}

const LEGACY = Object.freeze({
  sourceSha: 'a'.repeat(40),
  buildHash: 'legacy-build',
  runId: 'run-legacy-a1',
  generationId: 'gen-legacy-a1',
})
const VTR = Object.freeze({
  sourceSha: 'b'.repeat(40),
  buildHash: 'vtr-build',
  runId: 'run-vtr-b1',
  generationId: 'gen-vtr-b1',
  transitionId: 'transition-reach-1',
  contractHash: 'contract-reach-1',
})
const mission = { kind: 'inventory_at_least', item: 'oak_log', count: 1 }
const worldKey = '127.0.0.1:25576|minecraft:overworld|1'
const legacyWorldKey = '127.0.0.1:25572|minecraft:overworld|1'
const targetPosition = { x: 6, y: 63, z: 489 }
const startPosition = { x: 0.5, y: 63, z: 492.5 }
const actionId = 'MOVE:reach-witness-1'
const intentId = 'intent-reach-1'
const evidenceIds = ['verify:reach:oak_log@6,63,489']
const predicateIdentity = 'reach-oak-log-witness'
const t = (second) => `2026-09-25T04:00:${String(second).padStart(2, '0')}.000Z`

function event(message, detail, second) {
  return { record: 'agent-event', message, detail, ts: t(second) }
}

function eventFile(rows) {
  return `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`
}

function encodedFiles(entries) {
  return Object.entries(entries).map(([path, value]) => ({ path, ...encode(value) }))
}

function replaceText(side, path, nextText) {
  const index = side.files.findIndex((entry) => entry.path === path)
  assert.notEqual(index, -1, `fixture file exists: ${path}`)
  const label = side.files[index].label
  side.files[index] = { path, ...encode(nextText), ...(label === undefined ? {} : { label }) }
}

function readText(side, path) {
  const entry = side.files.find((file) => file.path === path)
  assert.ok(entry, `fixture file exists: ${path}`)
  return Buffer.from(entry.contentBase64, 'base64').toString('utf8')
}

function legacySide() {
  const first = { decisionId: 'decision-first', callId: 'call-first', chosenAction: actionId,
    runId: LEGACY.runId, generationId: LEGACY.generationId, sourceSha: LEGACY.sourceSha,
    jev: { callId: 'call-first', answers: { action: { value: actionId } } } }
  const next = { decisionId: 'decision-next', callId: 'call-next', chosenAction: 'MINE:oak_log',
    runId: LEGACY.runId, generationId: LEGACY.generationId, sourceSha: LEGACY.sourceSha,
    jev: { callId: 'call-next', answers: { action: { value: 'MINE:oak_log' } } },
    candidates: [{ id: 'MINE:oak_log', inReach: true }] }
  const summary = {
    ...LEGACY,
    missionInput: mission,
    fixture: { block: 'oak_log', position: targetPosition, initialPlayerPosition: startPosition,
      sourceOffsetFromInitialPlayer: { x: 6, y: 0, z: -3 }, flatSolidGround: true },
    run: { worldKey: legacyWorldKey, worldEpoch: 1, minecraftVersion: '1.21.11', gameMode: 'survival', difficulty: 'peaceful', seed: '42' },
    sliceMetrics: { system2LlmCalls: 0, networkModelCalls: 0 },
    events: {
      firstDecision: { decisionId: first.decisionId },
      nextDecisionInRange: { decisionId: next.decisionId, selected: 'MINE:oak_log' },
      moveActionEnd: { actionId, movementStepCount: 2, pathLegs: 2, pathCallback: 'completed',
        skillEnd: 'SUCCESS', verification: 'verified' },
    },
  }
  const skillRows = [
    event('jev-agent started policy=fallback provider=deterministic model=deterministic-local-fallback system2Provider=deterministic system2=unavailable',
      { policy: 'fallback', system2Provider: 'deterministic', system2Model: 'unavailable' }, 1),
    event(`SKILL_START actionId=${actionId}`, { actionId }, 3),
    event(`SKILL_STEP actionId=${actionId} leg=1`, { actionId, leg: 1 }, 4),
    event(`SKILL_STEP actionId=${actionId} leg=2`, { actionId, leg: 2 }, 5),
    event(`SKILL_END actionId=${actionId} execution=success verification=verified outcome=SUCCESS failureCode=none`, { actionId }, 6),
  ]
  skillRows[0].source = 'agent'
  const host = [
    `[${t(3)}] SKILL_START actionId=${actionId} runId=${LEGACY.runId} generationId=${LEGACY.generationId} sourceSha=${LEGACY.sourceSha}`,
    `[${t(6)}] SKILL_END actionId=${actionId} runId=${LEGACY.runId} generationId=${LEGACY.generationId} sourceSha=${LEGACY.sourceSha} outcome=SUCCESS failure=null`,
    `[${t(6)}] PATH_CALLBACK phase=completed actionId=${actionId} runId=${LEGACY.runId} generationId=${LEGACY.generationId} sourceSha=${LEGACY.sourceSha}`,
  ].join('\n') + '\n'
  const call = (callId) => ({ record: 'jev-call', callId, policy: 'fallback', model: 'deterministic-local-fallback', latencyMs: 0, usage: { totalTokens: 0 } })
  return {
    status: 'PASS',
    identity: { ...LEGACY },
    events: { status: 'PASS', eventIds: { firstDecision: first.decisionId, nextDecision: next.decisionId } },
    mission,
    files: encodedFiles({
      'runner/reach-slice-evidence.json': JSON.stringify(summary),
      'runner/runtime/buddy.log': host,
      'runner/runtime/logs/jev/run.jsonl': eventFile(skillRows),
      'runner/runtime/logs/jev/decisions.jsonl': eventFile([first, next]),
      'runner/runtime/logs/jev/jev-calls.jsonl': eventFile([call('call-first'), call('call-next')]),
      'runner/human-task-input.jsonl': eventFile([{ event: 'chat_sent_after_intent_listener_ready', command: 'agent AI_Buddy collect oak_log 1' }]),
      'runner/block-read-run2.jsonl': eventFile([{ tag: 'target', name: 'oak_log', position: targetPosition, at: t(2) }]),
    }),
  }
}

function vtrProbe() {
  const contract = {
    transitionId: VTR.transitionId,
    mission: { id: 'mission:oak-log-1', ...mission },
    desiredPredicate: { id: predicateIdentity, proposition: { kind: 'within-interaction-reach-of-resource-source', item: 'oak_log' }, expected: true },
    requires: [{ predicate: 'resource-witness-known', truth: 'TRUE' }],
    ensures: [{ id: predicateIdentity, expected: true }],
    invariants: [{ id: 'same-world-epoch', expected: true }],
    admissibleEffects: ['locomotion'],
    budget: { maxMechanicalSteps: 8, maxElapsedMs: 30000 },
    identity: { worldKey, dimension: 'overworld', worldEpoch: 1, generationId: VTR.generationId, leaseId: VTR.generationId },
    witness: { evidenceId: 'sensor:block:oak_log@6,63,489' },
  }
  const verify = {
    transitionId: VTR.transitionId,
    runId: VTR.runId,
    generationId: VTR.generationId,
    sourceSha: VTR.sourceSha,
    worldKey,
    worldEpoch: 1,
    contractHash: VTR.contractHash,
    truth: 'TRUE',
    identityMatches: true,
    predicatesVerified: true,
    verifiedAtMs: Date.parse(t(12)),
    observedAtMs: Date.parse(t(12)),
    evidenceIds,
    desiredPredicateIdentity: predicateIdentity,
  }
  return {
    record: 'vtr-reach-live-probe',
    sourceSha: VTR.sourceSha,
    runId: VTR.runId,
    generationId: VTR.generationId,
    generationHash: VTR.buildHash,
    server: { worldEpoch: 1, serverId: '127.0.0.1:25576', dimension: 'minecraft:overworld', worldSeedFromLevelDat: '42',
      minecraftVersion: '1.21.11', gamemode: 'survival', difficulty: 'peaceful' },
    mission,
    fixture: { witness: { block: 'oak_log', position: targetPosition }, transitionStartPosition: startPosition,
      sourceOffsetFromInitialPlayer: { x: 6, y: 0, z: -3 }, flatSolidGround: true, witnessChosenByProductionSensor: true },
    configuration: { BUDDY_POLICY: 'fallback', BUDDY_SYSTEM2: 'off', effectiveJevProvider: 'deterministic', effectiveJevModel: 'offline',
      effectiveSystem2Provider: 'none', effectiveSystem2Model: 'none', networkModelCalls: 0 },
    transition: {
      commit: contract,
      verify,
      terminalOutcome: {
        transitionId: VTR.transitionId,
        contractHash: VTR.contractHash,
        outcome: { kind: 'SUCCESS', contractHash: VTR.contractHash, desiredPredicateIdentity: predicateIdentity,
          verifiedAtMs: verify.verifiedAtMs, evidenceIds },
        boundary: 'mechanical-step-outcome',
      },
    },
  }
}

function vtrSide() {
  const probe = vtrProbe()
  const commit = probe.transition.commit
  const verify = probe.transition.verify
  const terminalOutcome = probe.transition.terminalOutcome
  const metrics = {
    verifiedTransitionCompletion: 1,
    mechanicalStepsPerTransition: 3,
    typedTerminalOutcome: 'SUCCESS',
    duplicateAuthority: false,
    duplicateAuthorityConflicts: 0,
    jevCallsPerTransition: 0,
    system2CallsPerTransition: 0,
    modelCallsPerMechanicalStep: 0,
  }
  const rows = [
    event(`VTR_TRANSITION_COMMIT id=${VTR.transitionId} contractHash=${VTR.contractHash}`, { ...commit, transitionId: VTR.transitionId, contractHash: VTR.contractHash }, 2),
    event(`SKILL_START actionId=${actionId} selectedBy=vtr-transition`, { actionId }, 3),
  ]
  for (let leg = 1; leg <= 3; leg += 1) {
    const stepId = `step-${leg}`
    rows.push(event(`VTR_MECHANICAL_STEP_RESERVED stepId=${stepId}`, {
      transitionId: VTR.transitionId, contractHash: VTR.contractHash, stepId, intentId, actionId, effectKind: 'locomotion',
    }, leg * 2 + 2))
    rows.push(event(`VTR_MECHANICAL_STEP_OUTCOME stepId=${stepId}`, {
      transitionId: VTR.transitionId, contractHash: VTR.contractHash, stepId, intentId, actionId,
      status: leg === 3 ? 'terminal' : 'settled',
      outcome: leg === 3 ? 'SUCCESS' : 'PROGRESS',
      verified: leg === 3,
    }, leg * 2 + 3))
  }
  rows.push(event('SKILL_END actionId=MOVE:reach-witness-1 execution=success verification=verified outcome=SUCCESS', { actionId }, 10))
  rows.push(event(`VTR_TRANSITION_VERIFY id=${VTR.transitionId} truth=TRUE`, verify, 12))
  rows.push(event(`VTR_TRANSITION_OUTCOME id=${VTR.transitionId} outcome=SUCCESS`, {
    transitionId: VTR.transitionId,
    contractHash: VTR.contractHash,
    outcome: terminalOutcome.outcome,
    boundary: terminalOutcome.boundary,
    usage: { mechanicalSteps: 3 },
    metrics,
  }, 13))
  const capture = {
    schema: 'vtr-provider-activity-capture/v1',
    status: 'OBSERVED',
    identity: { sourceSha: VTR.sourceSha, runId: VTR.runId, generationId: VTR.generationId, worldKey },
    window: { coverageComplete: true, startedAt: t(0), generationReadyAt: t(1), terminalAt: t(13), endedAt: t(14),
      maxPollGapMs: 5000, maxObservedPollGapMs: 250 },
    capture: { observedNonEmptyJournal: false, problems: [] },
    activity: { networkModelCalls: 0, jevDecisionCalls: 0, system2DecisionCalls: 0 },
    journals: Object.fromEntries(['jev-calls', 'jev-decisions', 'system2-journal'].map((key) => [key, {
      bytes: 0, sha256: sha256(''), initializedAt: t(0), firstObservedAt: t(0), closedAt: t(14),
    }])),
  }
  const acceptance = { record: 'acceptance', runId: VTR.runId, gitCommit: VTR.sourceSha, checkoutHead: VTR.sourceSha,
    generationHash: VTR.buildHash, serverId: '127.0.0.1:25576', worldEpoch: 1, dimension: 'minecraft:overworld' }
  const host = [
    `[${t(0)}] BOOT runId=${VTR.runId} source=${VTR.sourceSha}`,
    `[${t(1)}] GENERATION_READY runId=${VTR.runId} generationId=${VTR.generationId} sourceSha=${VTR.sourceSha} buildHash=${VTR.buildHash}`,
    `[${t(2)}] VTR_TRANSITION_COMMIT transitionId=${VTR.transitionId} runId=${VTR.runId} generationId=${VTR.generationId} sourceSha=${VTR.sourceSha} contractHash=${VTR.contractHash}`,
    `[${t(12)}] VTR_TRANSITION_VERIFY transitionId=${VTR.transitionId} runId=${VTR.runId} generationId=${VTR.generationId} sourceSha=${VTR.sourceSha} contractHash=${VTR.contractHash} truth=TRUE`,
    `[${t(13)}] VTR_TRANSITION_OUTCOME transitionId=${VTR.transitionId} runId=${VTR.runId} generationId=${VTR.generationId} sourceSha=${VTR.sourceSha} contractHash=${VTR.contractHash} outcome={"kind":"SUCCESS"}`,
  ].join('\n') + '\n'
  const files = encodedFiles({
    'runner/probe.json': JSON.stringify(probe),
    'runner/buddy.log': host,
    'runner/jev-run.jsonl': eventFile(rows),
    'runner/jev-calls.jsonl': '',
    'runner/jev-decisions.jsonl': '',
    'runner/system2.jsonl': '',
    'runner/acceptance.json': JSON.stringify(acceptance),
    'runner/provider-activity-capture.json': JSON.stringify(capture),
    'server/fixture-commands.jsonl': '',
    'proofs/no-double-authority.json': JSON.stringify({ result: 'PASS', runId: VTR.runId, sourceSha: VTR.sourceSha,
      generationId: VTR.generationId, legacyActuationCount: 0, vtrActuationCount: 1, duplicateAuthority: false,
      duplicateAuthorityConflicts: 0 }),
  })
  files.find((file) => file.path === 'runner/probe.json').label = 'probe input'
  return {
    status: 'PASS',
    identity: { ...VTR },
    events: { status: 'PASS', transitionId: VTR.transitionId, outcome: 'SUCCESS' },
    mission,
    files,
  }
}

function rawProof() {
  const reachLegacy = {
    movementOperationsToInRangeEvidence: 2,
    moveActionsToInRangeEvidence: 1,
    policyDecisionFramesToInRangeEvidence: 2,
    policyQuestionCallsToInRangeEvidence: 2,
  }
  const vtr = {
    transitionId: VTR.transitionId,
    contractHash: VTR.contractHash,
    verifiedTransitionCompletionCount: 1,
    mechanicalStepsPerTransition: 3,
    typedTerminalOutcome: 'SUCCESS',
  }
  const vtrPolicy = {
    jevProvider: 'deterministic',
    jevModel: 'offline',
    jevPolicy: 'fallback',
    system2Provider: 'none',
    system2Model: 'none',
    system2Mode: 'off',
    actualNetworkCalls: 0,
    legacyJevCallsPerTransition: 0,
    system2CallsPerTransition: 0,
    deprecatedModelCallsPerMechanicalStep: 0,
    modelMetricsStatus: 'PASS',
    decisionFrameInvocationsPerTransition: 0,
    jevProviderEvaluateAttemptsIncludingRetriesPerTransition: 0,
    jevProviderEvaluateAttemptsPerMechanicalStep: 0,
  }
  return {
    schema: 'vtr-reach-fixture-comparison/v3',
    comparisonStatus: 'PASS',
    evidenceClass: 'run-scoped-raw-events',
    acceptanceEligible: true,
    acceptanceStatus: 'ASSESSED_RAW_RUN_COMPARISON',
    alignment: { missionInput: 'PASS', fixture: 'PASS', environment: 'PASS' },
    lineage: {
      legacy: { ...LEGACY, recordedOriginMainSha: LEGACY.sourceSha, worldKey: legacyWorldKey, worldEpoch: 1, dimension: 'overworld',
        minecraftVersion: '1.21.11', gameMode: 'survival', difficulty: 'peaceful', seed: '42' },
      vtr: { ...VTR, worldKey, worldEpoch: 1, dimension: 'minecraft:overworld', minecraftVersion: '1.21.11', gameMode: 'survival',
        difficulty: 'peaceful', seed: '42' },
    },
    fixtureAlignment: {
      legacyMissionInput: mission,
      vtrMission: mission,
      sameMissionInput: true,
      sameTargetResourceKind: true,
      sameExactCartesianDelta: true,
      sameRelativeBlockOffset: true,
      sameRelativeFixture: true,
      sameFlatGround: true,
      vtrWitnessSensorBound: true,
      legacyFixtureStructured: { block: 'oak_log', position: targetPosition, initialPlayerPosition: startPosition,
        exactCartesianDelta: { x: 5.5, y: 0, z: -3.5 }, relativeBlockOffset: { x: 6, y: 0, z: -3 }, flatSolidGround: true },
      vtrFixture: { block: 'oak_log', sourcePosition: targetPosition, initialPlayerPosition: startPosition,
        exactCartesianDelta: { x: 5.5, y: 0, z: -3.5 }, relativeBlockOffset: { x: 6, y: 0, z: -3 }, flatSolidGround: true,
        witnessChosenByProductionSensor: true },
      environmentMatch: { minecraftVersion: true, gameMode: true, difficulty: true, dimension: true, seed: true },
    },
    metrics: {
      reachBoundary: { legacy: reachLegacy, vtr },
      policyAndModels: {
        legacy: { jevProviderModelCalls: 0, system2LlmCalls: 0, networkModelCalls: 0 },
        vtr: vtrPolicy,
      },
      authority: { vtr: { duplicateAuthority: true, duplicateAuthorityConflicts: 0, concurrentLegacyActuations: 0 } },
    },
    rawComparisonEvidence: {
      schema: 'vtr-reach-run-comparison-evidence/v1',
      status: 'PASS',
      evidenceClass: 'run-scoped-raw-events',
      legacy: legacySide(),
      vtr: vtrSide(),
    },
    noNetworkProfile: { status: 'PASS' },
  }
}

test('accepts a fully source-bound raw proof only when raw journals reproduce the reported comparison', () => {
  const proof = rawProof()
  assert.deepEqual(inspectReachComparisonProof(proof, VTR.sourceSha, LEGACY.sourceSha), {
    status: 'PASS',
    reason: 'source-bound raw comparison evidence independently validates both aligned run artifacts',
  })
})

test('rejects a provider journal changed after a zero-activity capture', () => {
  const proof = rawProof()
  const side = proof.rawComparisonEvidence.vtr
  replaceText(side, 'runner/jev-calls.jsonl', `${JSON.stringify({ record: 'jev-call', callId: 'unexpected' })}\n`)
  const result = inspectReachComparisonProof(proof, VTR.sourceSha, LEGACY.sourceSha)
  assert.equal(result.status, 'FAIL')
  assert.match(result.reason, /provider journal jev-calls .* observed empty file/)
})

test('rejects a legacy movement whose raw SKILL_END is not verified SUCCESS', () => {
  const proof = rawProof()
  const side = proof.rawComparisonEvidence.legacy
  const rows = readText(side, 'runner/runtime/logs/jev/run.jsonl').trim().split('\n').map((line) => JSON.parse(line))
  rows.at(-1).message = `SKILL_END actionId=${actionId} execution=failed verification=not-verified outcome=BLOCKED failureCode=PATH_FAILED`
  replaceText(side, 'runner/runtime/logs/jev/run.jsonl', eventFile(rows))
  const result = inspectReachComparisonProof(proof, VTR.sourceSha, LEGACY.sourceSha)
  assert.equal(result.status, 'FAIL')
  assert.match(result.reason, /legacy MOVE SKILL_END is not a verified SUCCESS/)
})

test('rejects source-contract and report-metric tampering even when the raw files rehash', () => {
  const changedContract = rawProof()
  const side = changedContract.rawComparisonEvidence.vtr
  const rows = readText(side, 'runner/jev-run.jsonl').trim().split('\n').map((line) => JSON.parse(line))
  const commit = rows.find((row) => row.message.startsWith('VTR_TRANSITION_COMMIT '))
  commit.detail.budget.maxMechanicalSteps = 99
  replaceText(side, 'runner/jev-run.jsonl', eventFile(rows))
  const contractResult = inspectReachComparisonProof(changedContract, VTR.sourceSha, LEGACY.sourceSha)
  assert.equal(contractResult.status, 'FAIL')
  assert.match(contractResult.reason, /raw commit budget differs/)

  const changedMetric = rawProof()
  changedMetric.metrics.reachBoundary.vtr.mechanicalStepsPerTransition = 99
  const metricResult = inspectReachComparisonProof(changedMetric, VTR.sourceSha, LEGACY.sourceSha)
  assert.equal(metricResult.status, 'FAIL')
  assert.match(metricResult.reason, /VTR mechanical steps per Transition report differs/)
})

test('rejects a forged no-double-authority artifact and a non-origin legacy lineage', () => {
  const forged = rawProof()
  const side = forged.rawComparisonEvidence.vtr
  replaceText(side, 'proofs/no-double-authority.json', JSON.stringify({ result: 'PASS', runId: VTR.runId,
    sourceSha: VTR.sourceSha, generationId: VTR.generationId, legacyActuationCount: 0, vtrActuationCount: 2,
    duplicateAuthority: false, duplicateAuthorityConflicts: 0 }))
  const result = inspectReachComparisonProof(forged, VTR.sourceSha, LEGACY.sourceSha)
  assert.equal(result.status, 'FAIL')
  assert.match(result.reason, /no-double-authority artifact does not match/)

  const wrongBase = rawProof()
  wrongBase.lineage.legacy.recordedOriginMainSha = LEGACY.sourceSha
  const baseResult = inspectReachComparisonProof(wrongBase, VTR.sourceSha, 'c'.repeat(40))
  assert.equal(baseResult.status, 'FAIL')
  assert.match(baseResult.reason, /legacy source SHA differs from the current origin\/main/)
})

test('recomputes geometry and environment from both run-bound artifacts', () => {
  const wrongGeometry = rawProof()
  const side = wrongGeometry.rawComparisonEvidence.vtr
  const probe = JSON.parse(readText(side, 'runner/probe.json'))
  probe.fixture.witness.position.z += 20
  replaceText(side, 'runner/probe.json', JSON.stringify(probe))
  const geometryResult = inspectReachComparisonProof(wrongGeometry, VTR.sourceSha, LEGACY.sourceSha)
  assert.equal(geometryResult.status, 'FAIL')
  assert.match(geometryResult.reason, /sameExactCartesianDelta=true does not match raw evidence/)

  const wrongEnvironment = rawProof()
  const envSide = wrongEnvironment.rawComparisonEvidence.vtr
  const envProbe = JSON.parse(readText(envSide, 'runner/probe.json'))
  envProbe.server.difficulty = 'hard'
  replaceText(envSide, 'runner/probe.json', JSON.stringify(envProbe))
  const environmentResult = inspectReachComparisonProof(wrongEnvironment, VTR.sourceSha, LEGACY.sourceSha)
  assert.equal(environmentResult.status, 'FAIL')
  assert.match(environmentResult.reason, /reported environmentMatch does not match run-bound/)
})

test('rejects mechanical outcomes that precede their reservation or change persistent action ownership', () => {
  const reversed = rawProof()
  const side = reversed.rawComparisonEvidence.vtr
  const rows = readText(side, 'runner/jev-run.jsonl').trim().split('\n').map((line) => JSON.parse(line))
  const firstOutcome = rows.find((row) => row.message.startsWith('VTR_MECHANICAL_STEP_OUTCOME ') && row.detail.stepId === 'step-1')
  firstOutcome.ts = t(3)
  replaceText(side, 'runner/jev-run.jsonl', eventFile(rows))
  const orderResult = inspectReachComparisonProof(reversed, VTR.sourceSha, LEGACY.sourceSha)
  assert.equal(orderResult.status, 'FAIL')
  assert.match(orderResult.reason, /reserve\/settlement timestamps are not causally ordered/)

  const changedOwner = rawProof()
  const ownerSide = changedOwner.rawComparisonEvidence.vtr
  const ownerRows = readText(ownerSide, 'runner/jev-run.jsonl').trim().split('\n').map((line) => JSON.parse(line))
  const reservation = ownerRows.find((row) => row.message.startsWith('VTR_MECHANICAL_STEP_RESERVED ') && row.detail.stepId === 'step-2')
  reservation.detail.actionId = 'MOVE:other-owner'
  replaceText(ownerSide, 'runner/jev-run.jsonl', eventFile(ownerRows))
  const ownerResult = inspectReachComparisonProof(changedOwner, VTR.sourceSha, LEGACY.sourceSha)
  assert.equal(ownerResult.status, 'FAIL')
  assert.match(ownerResult.reason, /mechanical settlement changed transition\/intent\/action ownership/)
})
