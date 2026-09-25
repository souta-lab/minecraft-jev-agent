import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { classifyProviderActivity } from './capture-vtr-provider-activity.mjs'
import { inspectLiveSkillOwnership, inspectReachComparisonProof, inspectNoDoubleAuthorityFixtureProof, inspectLifecycleCapture, summarizeValidationStatuses, validationExitCode } from './validate-vtr-reach-evidence.mjs'

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
const actionId = 'MOVE:b6_63_489'
const intentId = 'intent-reach-1'
const evidenceIds = ['verify:reach:oak_log@6,63,489']
const predicateIdentity = 'reach-oak-log-witness'
const t = (second) => `2026-09-25T04:00:${String(second).padStart(2, '0')}.000Z`
const tOffset = (seconds) => new Date(Date.parse(t(0)) + seconds * 1000).toISOString()
const commitmentId = 'commitment-reach-1'

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

function fileMap(side) {
  return new Map(side.files.map((file) => {
    const bytes = Buffer.from(file.contentBase64, 'base64')
    return [file.path, { text: bytes.toString('utf8'), contentBase64: file.contentBase64 }]
  }))
}

function legacySide() {
  const first = { decisionId: 'decision-first', callId: 'call-first', ts: t(2), chosenAction: actionId,
    runId: LEGACY.runId, generationId: LEGACY.generationId, sourceSha: LEGACY.sourceSha,
    jev: { callId: 'call-first', answers: { action: { value: actionId } } },
    candidates: [{ id: actionId, kind: 'MOVE', targetName: 'oak_log', inReach: false }] }
  const next = { decisionId: 'decision-next', callId: 'call-next', ts: t(7), chosenAction: 'MINE:b6_63_489',
    runId: LEGACY.runId, generationId: LEGACY.generationId, sourceSha: LEGACY.sourceSha,
    jev: { callId: 'call-next', answers: { action: { value: 'MINE:b6_63_489' } } },
    candidates: [{ id: 'MINE:b6_63_489', kind: 'MINE', targetName: 'oak_log', inReach: true }] }
  const summary = {
    ...LEGACY,
    missionInput: mission,
    fixture: { block: 'oak_log', position: targetPosition, initialPlayerPosition: startPosition,
      sourceOffsetFromInitialPlayer: { x: 6, y: 0, z: -3 }, flatSolidGround: true },
    run: { worldKey: legacyWorldKey, worldEpoch: 1, minecraftVersion: '1.21.11', gameMode: 'survival', difficulty: 'peaceful', seed: '42' },
    sliceMetrics: { system2LlmCalls: 0, networkModelCalls: 0 },
    events: {
      firstDecision: { decisionId: first.decisionId },
      nextDecisionInRange: { decisionId: next.decisionId, selected: 'MINE:b6_63_489' },
      moveActionEnd: { actionId, timestamp: t(6), movementStepCount: 2, pathLegs: 2, pathCallback: 'completed',
        skillEnd: 'SUCCESS', verification: 'verified' },
    },
  }
  const skillRows = [
    event('jev-agent started policy=fallback provider=deterministic model=deterministic-local-fallback system2Provider=deterministic system2=unavailable',
      { policy: 'fallback', system2Provider: 'deterministic', system2Model: 'unavailable' }, 1),
    event(`SKILL_START actionId=${actionId}`, { actionId }, 3),
    event(`SKILL_STEP skill=walk_to step=move evidence=move worldDelta=pos=${startPosition.x},${startPosition.y},${startPosition.z}`, { actionId, stepKind: 'move', count: 1 }, 3.5),
    event(`SKILL_STEP actionId=${actionId} leg=1`, { actionId, leg: 1 }, 4),
    event(`SKILL_STEP actionId=${actionId} leg=2`, { actionId, leg: 2 }, 5),
    event(`MOVE ${actionId} arrival start=(${startPosition.x},${startPosition.y},${startPosition.z}) end=(5.5,63,490.5)`,
      { actionId, start: startPosition, end: { x: 5.5, y: 63, z: 490.5 } }, 5.5),
    event(`SKILL_END actionId=${actionId} execution=success verification=verified outcome=SUCCESS failureCode=none`, { actionId }, 6),
  ]
  skillRows[0].source = 'agent'
  for (const row of skillRows.slice(1, 6)) row.source = 'executor'
  const host = [
    `[${t(3)}] SKILL_START actionId=${actionId} runId=${LEGACY.runId} generationId=${LEGACY.generationId} sourceSha=${LEGACY.sourceSha} buildHash=${LEGACY.buildHash}`,
    `[${t(6)}] SKILL_END actionId=${actionId} runId=${LEGACY.runId} generationId=${LEGACY.generationId} sourceSha=${LEGACY.sourceSha} buildHash=${LEGACY.buildHash} outcome=SUCCESS failure=null`,
    `[${t(6)}] PATH_CALLBACK phase=completed actionId=${actionId} runId=${LEGACY.runId} generationId=${LEGACY.generationId} sourceSha=${LEGACY.sourceSha} buildHash=${LEGACY.buildHash}`,
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
    configuredNoLlmProbe: {
      BUDDY_POLICY: 'fallback', BUDDY_SYSTEM2: 'off', networkModelCalls: 0, providerEvaluateAttemptsPerMechanicalStep: 0,
      effectiveJev: { provider: 'deterministic', model: 'offline', decisionCalls: 1, providerEvaluateAttempts: 0 },
      effectiveSystem2: { provider: 'none', model: 'none', decisionCalls: 0, providerEvaluateAttempts: 0 },
    },
    transition: {
      commit: contract,
      verify,
      metrics: { mechanicalStepsPerTransition: 4 },
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
    mechanicalStepsPerTransition: 4,
    typedTerminalOutcome: 'SUCCESS',
    duplicateAuthority: false,
    duplicateAuthorityConflicts: 0,
    jevCallsPerTransition: 1,
    system2CallsPerTransition: 0,
    decisionFrameInvocations: 1,
    providerEvaluateAttempts: 0,
    modelCallsPerMechanicalStep: 1,
  }
  const rows = [
    event(`VTR_TRANSITION_COMMIT id=${VTR.transitionId} contractHash=${VTR.contractHash}`, { ...commit, transitionId: VTR.transitionId, contractHash: VTR.contractHash }, 2),
    event(`VTR_TRANSITION_ACTUATION id=${VTR.transitionId} intent=${intentId} action=${actionId} selectedBy=vtr_transition_controller`, {
      transitionId: VTR.transitionId, contractHash: VTR.contractHash, intentId, actionId, authority: 'vtr-transition-controller',
    }, 3),
    event(`SKILL_START actionId=${actionId} commitmentId=${commitmentId} decisionEpoch=17 selectedBy=vtr-transition`, {
      actionId, commitmentId, decisionEpoch: 17,
    }, 4),
  ]
  for (let leg = 1; leg <= 4; leg += 1) {
    const stepId = `${actionId}#17:walk-leg-${leg}`
    const reserveAt = 4 + (leg - 1) * 2
    const outcomeAt = reserveAt + 1
    rows.push(event(`VTR_MECHANICAL_STEP_RESERVED stepId=${stepId}`, {
      transitionId: VTR.transitionId, contractHash: VTR.contractHash, stepId, intentId, actionId,
      commitmentId, leg, effectKind: 'locomotion',
    }, reserveAt))
    rows.push(event(`VTR_MECHANICAL_STEP_OUTCOME stepId=${stepId}`, {
      transitionId: VTR.transitionId, contractHash: VTR.contractHash, stepId, intentId, actionId,
      commitmentId, leg,
      status: leg === 4 ? 'terminal' : 'active',
      outcome: leg === 4 ? 'SUCCESS' : 'CONTINUING',
      verified: leg === 4,
    }, outcomeAt))
    // The current runWalkSkill terminal callback returns before formatWalkLeg is
    // emitted. The first three settled continuation legs are therefore the raw
    // SKILL_STEP evidence; the fourth terminal leg is counted only via settlement.
    if (leg < 4) rows.push({
      record: 'agent-event',
      message: `SKILL_STEP skill=walk step=walk_leg authority=MECHANICAL_CONTINUATION evidence=path worldDelta=closing commitmentId=${commitmentId} decisionEpoch=17 count=${leg}`,
      detail: { actionId, commitmentId, leg, failure: null, remaining: 5 - leg },
      ts: tOffset(outcomeAt + 0.25),
    })
  }
  rows.push(event(`SKILL_END actionId=${actionId} execution=success verification=verified outcome=SUCCESS`, { actionId }, 12))
  rows.push(event(`VTR_TRANSITION_VERIFY id=${VTR.transitionId} truth=TRUE`, verify, 13))
  rows.push(event(`VTR_TRANSITION_OUTCOME id=${VTR.transitionId} outcome=SUCCESS`, {
    transitionId: VTR.transitionId,
    contractHash: VTR.contractHash,
    outcome: terminalOutcome.outcome,
    boundary: terminalOutcome.boundary,
    usage: { mechanicalSteps: 4 },
    metrics,
  }, 14))
  const providerJournals = {
    'jev-calls': eventFile([{ record: 'jev-call', callId: 'local-route-frame', policy: 'fallback', model: 'deterministic-local-fallback', providerAttempts: 0 }]),
    'jev-decisions': eventFile([{ record: 'jev-decision', decisionId: 'local-route-decision', callId: 'local-route-frame' }]),
    'system2-journal': '',
    'mercury-calls': '',
  }
  const providerRows = Object.fromEntries(Object.entries(providerJournals).map(([name, text]) => [
    name,
    text.trim() === '' ? [] : text.trim().split('\n').map((line) => JSON.parse(line)),
  ]))
  const classified = classifyProviderActivity(providerRows)
  const capture = {
    schema: 'vtr-provider-activity-capture/v2',
    status: 'OBSERVED',
    identity: { sourceSha: VTR.sourceSha, runId: VTR.runId, generationId: VTR.generationId, worldKey },
    window: { coverageComplete: true, startedAt: t(0), bootAt: t(0), generationReadyAt: t(1), terminalAt: t(14),
      terminalConsumedAt: tOffset(14.1), shutdownAt: tOffset(14.2), residentStoppedAt: tOffset(14.3), serverStoppedAt: tOffset(14.4),
      lifecycleComplete: true, endedAt: tOffset(14.5),
      maxPollGapMs: 5000, maxObservedPollGapMs: 250 },
    capture: { observedNonEmptyJournal: true, observedProviderActivity: false, problems: [] },
    activityClassification: classified,
    activity: { ...classified.decisions, ...classified.providers },
    journals: Object.fromEntries(Object.entries(providerJournals).map(([name, text]) => [name, {
      bytes: Buffer.byteLength(text), sha256: sha256(text), rows: providerRows[name].length, malformedRows: 0,
      initializedAt: t(0), firstObservedAt: t(0), closedAt: t(14),
    }])),
    lifecycle: null,
  }
  const acceptance = { record: 'acceptance', runId: VTR.runId, gitCommit: VTR.sourceSha, checkoutHead: VTR.sourceSha,
    generationHash: VTR.buildHash, serverId: '127.0.0.1:25576', worldEpoch: 1, dimension: 'minecraft:overworld' }
  const host = [
    `[${t(0)}] BOOT runId=${VTR.runId} source=${VTR.sourceSha} worldKey=${JSON.stringify({ serverId: '127.0.0.1:25576', dimension: 'minecraft:overworld', worldEpoch: 1 })}`,
    `[${t(1)}] GENERATION_READY runId=${VTR.runId} generationId=${VTR.generationId} sourceSha=${VTR.sourceSha} buildHash=${VTR.buildHash}`,
    `[${t(2)}] VTR_TRANSITION_COMMIT transitionId=${VTR.transitionId} runId=${VTR.runId} generationId=${VTR.generationId} sourceSha=${VTR.sourceSha} buildHash=${VTR.buildHash} contractHash=${VTR.contractHash}`,
    `[${t(13)}] VTR_TRANSITION_VERIFY transitionId=${VTR.transitionId} runId=${VTR.runId} generationId=${VTR.generationId} sourceSha=${VTR.sourceSha} buildHash=${VTR.buildHash} contractHash=${VTR.contractHash} truth=TRUE`,
    `[${t(14)}] VTR_TRANSITION_OUTCOME transitionId=${VTR.transitionId} runId=${VTR.runId} generationId=${VTR.generationId} sourceSha=${VTR.sourceSha} buildHash=${VTR.buildHash} contractHash=${VTR.contractHash} outcome={"kind":"SUCCESS"}`,
    `[${tOffset(14.2)}] SHUTDOWN runId=${VTR.runId} generationId=${VTR.generationId} sourceSha=${VTR.sourceSha}`,
  ].join('\n') + '\n'
  const lifecycleRows = [
    { schema: 'vtr-reach-probe-lifecycle/v1', event: 'terminal-consumed', ts: tOffset(14.1), actor: 'probe-harness',
      sourceSha: VTR.sourceSha, runId: VTR.runId, generationId: VTR.generationId, worldKey,
      transitionId: VTR.transitionId, contractHash: VTR.contractHash, outcomeKind: 'SUCCESS', evidenceIds },
    { schema: 'vtr-reach-probe-lifecycle/v1', event: 'resident-stopped', ts: tOffset(14.3), stoppedAt: tOffset(14.3), actor: 'probe-harness',
      sourceSha: VTR.sourceSha, runId: VTR.runId, generationId: VTR.generationId, worldKey,
      pid: 43101, status: 'stopped', exitCode: 0,
      processExitObservation: { schema: 'vtr-process-exit-observation/v1', source: 'child-close-event', state: 'exited', pid: 43101, exitCode: 0, observedAt: tOffset(14.3) } },
    { schema: 'vtr-reach-probe-lifecycle/v1', event: 'server-stopped', ts: tOffset(14.4), stoppedAt: tOffset(14.4), actor: 'probe-harness',
      sourceSha: VTR.sourceSha, runId: VTR.runId, generationId: VTR.generationId, worldKey,
      pid: 43102, status: 'stopped', exitCode: 0,
      processExitObservation: { schema: 'vtr-process-exit-observation/v1', source: 'child-close-event', state: 'exited', pid: 43102, exitCode: 0, observedAt: tOffset(14.35) },
      listenerClosureObservation: { schema: 'vtr-listener-closure-observation/v1', source: 'tcp-connect-probe', state: 'closed', host: '127.0.0.1', port: 25576, result: 'connection-refused', observedAt: tOffset(14.4) } },
  ]
  const lifecycleText = eventFile(lifecycleRows)
  capture.lifecycle = {
    status: 'OBSERVED', bytes: Buffer.byteLength(lifecycleText), sha256: sha256(lifecycleText), rows: lifecycleRows.length,
    malformedRows: 0, problems: [], firstObservedAt: t(0), closedAt: tOffset(14.5),
    events: { terminalConsumed: lifecycleRows[0], residentStopped: lifecycleRows[1], serverStopped: lifecycleRows[2] },
  }
  for (const entry of Object.values(capture.journals)) entry.closedAt = tOffset(14.5)
  const egressHashes = {
    toolSha256: '1'.repeat(64),
    sourceSha256: '2'.repeat(64),
    librarySha256: '3'.repeat(64),
    policySha256: '4'.repeat(64),
  }
  const egressRows = [
    { schema: 'vtr-no-llm-egress-audit/v1', event: 'guard_loaded', utc: tOffset(0.5), monotonicClock: 'CLOCK_MONOTONIC',
      monotonicNs: '1000', pid: 43101, processStartTicks: 10001, processGroupId: 43101, reason: 'preload-active', ...egressHashes },
    { schema: 'vtr-no-llm-egress-audit/v1', event: 'guard_loaded', utc: tOffset(2), monotonicClock: 'CLOCK_MONOTONIC',
      monotonicNs: '2000000000', pid: 43103, processStartTicks: 10003, processGroupId: 43101, reason: 'preload-active', ...egressHashes },
    { schema: 'vtr-no-llm-egress-audit/v1', event: 'guard_wrapper_closed', utc: tOffset(14.35), monotonicClock: 'process.hrtime.relative',
      monotonicNs: '14350000000', pid: 43100, childPid: 43101, commandName: 'bun', childExitCode: 0, childSignal: null,
      processGroupId: 43101, auditPathIdentityVerified: true, auditDevice: '1', auditInode: '9876',
      preloadVerified: true, processGroupGone: true, coverageClass: 'user-space-libc-interposition', coverageStatus: 'USERSPACE_ONLY_CLOSED',
      externalDeniedAttempts: 0, guardLoadedRows: 2, ...egressHashes,
      coverage: 'root-process-load-verified; observed-exec-descendants-reopened-same-audit-inode; process-group-signaled-at-close; syscall-bypass-not-covered' },
  ]
  const egressText = eventFile(egressRows)
  probe.egressAudit = {
    schema: 'vtr-no-llm-egress-binding/v1', status: 'OBSERVED_ZERO', sourceSha: VTR.sourceSha, runId: VTR.runId,
    generationId: VTR.generationId, worldKey,
    coverageClass: 'user-space-libc-interposition', coverageStatus: 'USERSPACE_ONLY_CLOSED', externalDeniedAttempts: 0,
    guardLoadedRows: 2, rawArtifact: { path: 'runner/no-llm-egress-audit.json', bytes: Buffer.byteLength(egressText), sha256: sha256(egressText) },
    window: { startedAt: t(0), generationReadyAt: t(1), shutdownAt: tOffset(14.2), residentStoppedAt: tOffset(14.3),
      serverStoppedAt: tOffset(14.4), endedAt: tOffset(14.5) },
    limitations: ['USERSPACE_ONLY: LD_PRELOAD libc interception only; raw syscall bypass is not covered; no kernel isolation claim.'],
  }
  const files = encodedFiles({
    'runner/probe.json': JSON.stringify(probe),
    'runner/buddy.log': host,
    'runner/jev-run.jsonl': eventFile(rows),
    'runner/jev-calls.jsonl': providerJournals['jev-calls'],
    'runner/jev-decisions.jsonl': providerJournals['jev-decisions'],
    'runner/system2.jsonl': providerJournals['system2-journal'],
    'runner/mercury-calls.jsonl': providerJournals['mercury-calls'],
    'runner/acceptance.json': JSON.stringify(acceptance),
    'runner/provider-activity-capture.json': JSON.stringify(capture),
    'runner/host-lifecycle.jsonl': lifecycleText,
    'runner/no-llm-egress-audit.json': egressText,
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
    mechanicalStepsPerTransition: 4,
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
    legacyJevCallsPerTransition: 1,
    system2CallsPerTransition: 0,
    deprecatedModelCallsPerMechanicalStep: 1,
    modelMetricsStatus: 'PASS',
    decisionFrameInvocationsPerTransition: 1,
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

test('accepts a fully source-bound raw proof with one deterministic Jev frame and zero provider attempts', () => {
  const proof = rawProof()
  assert.deepEqual(inspectReachComparisonProof(proof, VTR.sourceSha, LEGACY.sourceSha), {
    status: 'PASS',
    reason: 'source-bound raw comparison evidence independently validates both aligned run artifacts',
  })
})

test('requires a source/run/window-bound USERSPACE_ONLY egress guard audit', () => {
  const missing = rawProof()
  missing.rawComparisonEvidence.vtr.files = missing.rawComparisonEvidence.vtr.files.filter((entry) => entry.path !== 'runner/no-llm-egress-audit.json')
  const missingResult = inspectReachComparisonProof(missing, VTR.sourceSha, LEGACY.sourceSha)
  assert.equal(missingResult.status, 'INCOMPLETE')
  assert.match(missingResult.reason, /egress audit is missing/u)

  const tampered = rawProof()
  const tamperedSide = tampered.rawComparisonEvidence.vtr
  const audit = JSON.parse(readText(tamperedSide, 'runner/no-llm-egress-audit.json').trim().split('\n')[0])
  audit.pid += 1
  replaceText(tamperedSide, 'runner/no-llm-egress-audit.json', `${JSON.stringify(audit)}\n`)
  const tamperedResult = inspectReachComparisonProof(tampered, VTR.sourceSha, LEGACY.sourceSha)
  assert.equal(tamperedResult.status, 'FAIL')
  assert.match(tamperedResult.reason, /raw audit\/source\/run identity/u)

  const wrongWindow = rawProof()
  const wrongWindowProbe = JSON.parse(readText(wrongWindow.rawComparisonEvidence.vtr, 'runner/probe.json'))
  wrongWindowProbe.egressAudit.window.serverStoppedAt = tOffset(14.3)
  replaceText(wrongWindow.rawComparisonEvidence.vtr, 'runner/probe.json', JSON.stringify(wrongWindowProbe))
  const wrongWindowResult = inspectReachComparisonProof(wrongWindow, VTR.sourceSha, LEGACY.sourceSha)
  assert.equal(wrongWindowResult.status, 'INCOMPLETE')
  assert.match(wrongWindowResult.reason, /timestamps are not bound to the continuous provider capture window/u)

  const duplicateGuard = rawProof()
  const duplicateSide = duplicateGuard.rawComparisonEvidence.vtr
  const duplicateRows = readText(duplicateSide, 'runner/no-llm-egress-audit.json').trim().split('\n').map((line) => JSON.parse(line))
  duplicateRows[1].pid = duplicateRows[0].pid
  duplicateRows[1].processStartTicks = duplicateRows[0].processStartTicks
  const duplicateText = eventFile(duplicateRows)
  replaceText(duplicateSide, 'runner/no-llm-egress-audit.json', duplicateText)
  const duplicateProbe = JSON.parse(readText(duplicateSide, 'runner/probe.json'))
  duplicateProbe.egressAudit.rawArtifact.bytes = Buffer.byteLength(duplicateText)
  duplicateProbe.egressAudit.rawArtifact.sha256 = sha256(duplicateText)
  replaceText(duplicateSide, 'runner/probe.json', JSON.stringify(duplicateProbe))
  const duplicateResult = inspectReachComparisonProof(duplicateGuard, VTR.sourceSha, LEGACY.sourceSha)
  assert.equal(duplicateResult.status, 'FAIL')
  assert.match(duplicateResult.reason, /guard activation/u)

  const externalAttempt = rawProof()
  const externalSide = externalAttempt.rawComparisonEvidence.vtr
  const auditRows = readText(externalSide, 'runner/no-llm-egress-audit.json').trim().split('\n').map((line) => JSON.parse(line))
  const auditHashes = Object.fromEntries(['toolSha256', 'sourceSha256', 'librarySha256', 'policySha256'].map((key) => [key, auditRows[0][key]]))
  auditRows.splice(2, 0, {
    schema: 'vtr-no-llm-egress-audit/v1', event: 'blocked_egress', utc: t(3), monotonicClock: 'CLOCK_MONOTONIC',
    monotonicNs: '3000000000', pid: 43103, processStartTicks: 10003, processGroupId: 43101, tid: 43103, operation: 'connect', family: 'AF_INET',
    address: '203.0.113.5', port: 443, errno: 'EACCES', ...auditHashes,
  })
  auditRows.at(-1).externalDeniedAttempts = 1
  const externalText = eventFile(auditRows)
  replaceText(externalSide, 'runner/no-llm-egress-audit.json', externalText)
  const probe = JSON.parse(readText(externalSide, 'runner/probe.json'))
  probe.egressAudit.externalDeniedAttempts = 1
  probe.egressAudit.rawArtifact.bytes = Buffer.byteLength(externalText)
  probe.egressAudit.rawArtifact.sha256 = sha256(externalText)
  replaceText(externalSide, 'runner/probe.json', JSON.stringify(probe))
  const externalResult = inspectReachComparisonProof(externalAttempt, VTR.sourceSha, LEGACY.sourceSha)
  assert.equal(externalResult.status, 'FAIL', externalResult.reason)
  assert.match(externalResult.reason, /denied external network attempt/u)
})

test('rejects provider journal bytes changed after capture without matching raw hashes', () => {
  const proof = rawProof()
  const side = proof.rawComparisonEvidence.vtr
  replaceText(side, 'runner/jev-calls.jsonl', `${JSON.stringify({ record: 'jev-call', callId: 'unexpected' })}\n`)
  const result = inspectReachComparisonProof(proof, VTR.sourceSha, LEGACY.sourceSha)
  assert.equal(result.status, 'FAIL')
  assert.match(result.reason, /provider journal jev-calls bytes\/hash differ/)
})

test('fails positive Jev provider attempts even when decision and provider metrics are distinct', () => {
  const proof = rawProof()
  const side = proof.rawComparisonEvidence.vtr
  replaceText(side, 'runner/jev-calls.jsonl', eventFile([{
    record: 'jev-call', callId: 'actual-provider-call', policy: 'typesafe', providerAttempts: 1,
  }]))
  const result = inspectReachComparisonProof(proof, VTR.sourceSha, LEGACY.sourceSha)
  assert.equal(result.status, 'FAIL')
  assert.match(result.reason, /provider journals show one or more provider evaluation attempts/)
})

test('marks a missing provider journal INCOMPLETE instead of inferring zero', () => {
  const proof = rawProof()
  const side = proof.rawComparisonEvidence.vtr
  side.files = side.files.filter((entry) => entry.path !== 'runner/mercury-calls.jsonl')
  const result = inspectReachComparisonProof(proof, VTR.sourceSha, LEGACY.sourceSha)
  assert.equal(result.status, 'INCOMPLETE')
  assert.match(result.reason, /unclassified|missing-or-malformed:mercury-calls/)
})

test('marks malformed provider journal rows INCOMPLETE when exact bytes were captured', () => {
  const proof = rawProof()
  const side = proof.rawComparisonEvidence.vtr
  const malformed = '{not-json}\n'
  replaceText(side, 'runner/jev-calls.jsonl', malformed)
  const capture = JSON.parse(readText(side, 'runner/provider-activity-capture.json'))
  const decisionRows = readText(side, 'runner/jev-decisions.jsonl').trim().split('\n').map((line) => JSON.parse(line))
  const classified = classifyProviderActivity({
    'jev-calls': null,
    'jev-decisions': decisionRows,
    'system2-journal': [],
    'mercury-calls': [],
  })
  capture.status = 'INCOMPLETE'
  capture.activityClassification = classified
  capture.activity = { ...classified.decisions, ...classified.providers }
  capture.journals['jev-calls'] = {
    ...capture.journals['jev-calls'],
    bytes: Buffer.byteLength(malformed),
    sha256: sha256(malformed),
    rows: 0,
    malformedRows: 1,
  }
  replaceText(side, 'runner/provider-activity-capture.json', JSON.stringify(capture))
  const result = inspectReachComparisonProof(proof, VTR.sourceSha, LEGACY.sourceSha)
  assert.equal(result.status, 'INCOMPLETE')
  assert.match(result.reason, /malformed|unclassified/)
})

test('requires every provider journal capture to remain open through observed server stop', () => {
  const proof = rawProof()
  const side = proof.rawComparisonEvidence.vtr
  const capture = JSON.parse(readText(side, 'runner/provider-activity-capture.json'))
  for (const journal of Object.values(capture.journals)) journal.closedAt = tOffset(14.2)
  replaceText(side, 'runner/provider-activity-capture.json', JSON.stringify(capture))
  const result = inspectReachComparisonProof(proof, VTR.sourceSha, LEGACY.sourceSha)
  assert.equal(result.status, 'INCOMPLETE')
  assert.match(result.reason, /server stop/u)
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

test('rejects a legacy inReach decision that predates the completed MOVE', () => {
  const proof = rawProof()
  const side = proof.rawComparisonEvidence.legacy
  const rows = readText(side, 'runner/runtime/logs/jev/decisions.jsonl').trim().split('\n').map((line) => JSON.parse(line))
  rows.find((row) => row.decisionId === 'decision-next').ts = t(5)
  replaceText(side, 'runner/runtime/logs/jev/decisions.jsonl', eventFile(rows))
  const result = inspectReachComparisonProof(proof, VTR.sourceSha, LEGACY.sourceSha)
  assert.equal(result.status, 'FAIL')
  assert.match(result.reason, /legacy witness, MOVE execution, and next inReach decision are not in causal order/)
})

test('requires the legacy fixture start to match raw first-step and MOVE-arrival positions', () => {
  const proof = rawProof()
  const side = proof.rawComparisonEvidence.legacy
  const rows = readText(side, 'runner/runtime/logs/jev/run.jsonl').trim().split('\n').map((line) => JSON.parse(line))
  const arrival = rows.find((row) => row.message.startsWith(`MOVE ${actionId} arrival`))
  arrival.detail.start = { ...startPosition, z: startPosition.z + 1 }
  replaceText(side, 'runner/runtime/logs/jev/run.jsonl', eventFile(rows))
  const result = inspectReachComparisonProof(proof, VTR.sourceSha, LEGACY.sourceSha)
  assert.equal(result.status, 'FAIL')
  assert.match(result.reason, /MOVE start position is not corroborated/)

  const missing = rawProof()
  const missingSide = missing.rawComparisonEvidence.legacy
  const withoutArrival = readText(missingSide, 'runner/runtime/logs/jev/run.jsonl').trim().split('\n')
    .map((line) => JSON.parse(line)).filter((row) => !row.message.startsWith(`MOVE ${actionId} arrival`))
  replaceText(missingSide, 'runner/runtime/logs/jev/run.jsonl', eventFile(withoutArrival))
  const missingResult = inspectReachComparisonProof(missing, VTR.sourceSha, LEGACY.sourceSha)
  assert.equal(missingResult.status, 'FAIL')
  assert.match(missingResult.reason, /raw MOVE start-position evidence/)
})

test('requires the Reach ownership proof to contain at least three legs under one Skill', () => {
  const start = { message: 'selectedBy=vtr-transition', detail: { actionId } }
  const incomplete = inspectLiveSkillOwnership({
    skillStartRows: [start], selectedSkillCount: 1, actionId, mechanicalSteps: 2,
  })
  assert.equal(incomplete.status, 'INCOMPLETE')
  assert.match(incomplete.reason, /at least three mechanical legs/)

  const reservations = [1, 2, 3].map((leg) => ({ detail: { actionId, stepId: `step-${leg}` } }))
  const outcomes = [1, 2, 3].map((leg) => ({ detail: { actionId, stepId: `step-${leg}` } }))
  const actuations = [{ detail: { actionId } }]
  const events = [{}, start, reservations[0], outcomes[2], {}]
  const complete = inspectLiveSkillOwnership({
    skillStartRows: [start], selectedSkillCount: 1, actionId, reservations, stepOutcomes: outcomes, actuations,
    mechanicalSteps: 3, commitIndex: 0, skillStartIndex: 1, firstReservationIndex: 2, outcomeIndex: 3, events,
  })
  assert.equal(complete.status, 'PASS')
  assert.equal(complete.mechanicalSteps, 3)
})

test('keeps a passing Reach probe independent from missing full-migration comparison evidence', () => {
  const summary = summarizeValidationStatuses([
    { id: 'transition:verified-success', status: 'PASS' },
    { id: 'authority:single-skill-owner', status: 'PASS' },
    { id: 'proof:no-double-authority-fixture', status: 'PASS' },
    { id: 'milestone:comparison/legacy-baseline.json', status: 'INCOMPLETE' },
  ])
  assert.equal(summary.probeStatus, 'PASS')
  assert.equal(summary.status, 'PASS', 'Reach validator CLI status reflects the Reach slice')
  assert.equal(summary.migrationMilestoneStatus, 'INCOMPLETE')
  assert.equal(summary.overallStatus, 'INCOMPLETE', 'full P0 acceptance remains incomplete without the comparison')
  assert.equal(validationExitCode(summary), 0, 'Reach validator CLI exits successfully when probe checks pass')
})

test('keeps the exact-source legacy-claim fixture inside Reach probe acceptance', () => {
  const missingFixture = summarizeValidationStatuses([
    { id: 'transition:verified-success', status: 'PASS' },
    { id: 'proof:no-double-authority-fixture', status: 'INCOMPLETE' },
    { id: 'milestone:comparison/legacy-baseline.json', status: 'INCOMPLETE' },
  ])
  assert.equal(missingFixture.probeStatus, 'INCOMPLETE', 'missing/invalid legacy-claim fixture cannot be hidden in the migration-only bucket')
  assert.equal(validationExitCode(missingFixture), 2)

  const fixtureValidButComparisonMissing = summarizeValidationStatuses([
    { id: 'transition:verified-success', status: 'PASS' },
    { id: 'proof:no-double-authority-fixture', status: 'PASS' },
    { id: 'milestone:comparison/legacy-baseline.json', status: 'INCOMPLETE' },
  ])
  assert.equal(fixtureValidButComparisonMissing.probeStatus, 'PASS')
  assert.equal(fixtureValidButComparisonMissing.migrationMilestoneStatus, 'INCOMPLETE')
  assert.equal(validationExitCode(fixtureValidButComparisonMissing), 0)
})

test('requires observed process exit and exact TCP listener closure in the Reach validator', () => {
  const side = vtrSide()
  const files = fileMap(side)
  const probe = JSON.parse(files.get('runner/probe.json').text)
  const capture = JSON.parse(files.get('runner/provider-activity-capture.json').text)
  const events = files.get('runner/jev-run.jsonl').text.trim().split('\n').map((line) => JSON.parse(line))
  const expectedIdentity = { ...VTR, worldKey }
  assert.doesNotThrow(() => inspectLifecycleCapture(files, capture, expectedIdentity, probe, events))

  for (const [name, mutate] of [
    ['process exit', (rows) => { rows[1].processExitObservation.state = 'running' }],
    ['listener host', (rows) => { rows[2].listenerClosureObservation.host = '0.0.0.0' }],
    ['listener port', (rows) => { rows[2].listenerClosureObservation.port = 25577 }],
  ]) {
    const changedFiles = fileMap(side)
    const changedProbe = JSON.parse(changedFiles.get('runner/probe.json').text)
    const changedCapture = JSON.parse(changedFiles.get('runner/provider-activity-capture.json').text)
    const lifecycleRows = changedFiles.get('runner/host-lifecycle.jsonl').text.trim().split('\n').map((line) => JSON.parse(line))
    mutate(lifecycleRows)
    const changedText = eventFile(lifecycleRows)
    const changedBytes = Buffer.from(changedText)
    changedFiles.set('runner/host-lifecycle.jsonl', { text: changedText, contentBase64: changedBytes.toString('base64') })
    changedCapture.lifecycle.bytes = changedBytes.length
    changedCapture.lifecycle.sha256 = sha256(changedBytes)
    changedCapture.lifecycle.rows = lifecycleRows.length
    assert.throws(() => inspectLifecycleCapture(changedFiles, changedCapture, expectedIdentity, changedProbe, events), /process-exit|listener-closure/u, name)
  }
})

test('re-hashes the exact-source legacy-claim refusal fixture separately from live zero counters', () => {
  const testSourceBytes = Buffer.from('exact source fixture bytes\n')
  const report = {
    schema: 'vtr-reach-no-double-authority-fixture/v1',
    result: 'PASS',
    sourceSha: VTR.sourceSha,
    test: {
      path: 'jev-agent/test-vtr-reach-executor-dispatch-authority.mts',
      name: 'production Reach dispatch and legacy Executor claim cannot overlap body authority',
      sourceSha256: sha256(testSourceBytes),
    },
    fixture: {
      legacyClaimRejected: true,
      legacyClaimError: 'ExecutionAuthorityConflict',
      vtrOwnerRetained: true,
      transitionId: VTR.transitionId,
      contractHash: 'c'.repeat(64),
      pathfinderStartsBeforeLegacyClaim: 1,
      pathfinderStartsAfterLegacyClaim: 1,
      pathfinderStartDelta: 0,
      authorityConflictCount: 1,
      maxConcurrentActions: 1,
    },
  }
  const reportBytes = Buffer.from(`${JSON.stringify(report)}\n`)
  const binding = {
    schema: 'vtr-reach-no-double-authority-fixture/v1',
    status: 'PASS',
    sourceSha: VTR.sourceSha,
    rawReport: { path: 'proofs/no-double-authority-fixture.json', bytes: reportBytes.length, sha256: sha256(reportBytes) },
    testSource: { path: 'runner/fixtures/test-vtr-reach-executor-dispatch-authority.mts', bytes: testSourceBytes.length, sha256: sha256(testSourceBytes) },
  }
  assert.equal(inspectNoDoubleAuthorityFixtureProof({ report, reportBytes, testSourceBytes, expectedSourceSha: VTR.sourceSha, binding }).status, 'PASS')

  const tamperedHash = structuredClone(report)
  tamperedHash.test.sourceSha256 = 'f'.repeat(64)
  const tamperedHashBytes = Buffer.from(`${JSON.stringify(tamperedHash)}\n`)
  const tamperedResult = inspectNoDoubleAuthorityFixtureProof({
    report: tamperedHash, reportBytes: tamperedHashBytes, testSourceBytes, expectedSourceSha: VTR.sourceSha,
    binding: { ...binding, rawReport: { ...binding.rawReport, bytes: tamperedHashBytes.length, sha256: sha256(tamperedHashBytes) } },
  })
  assert.equal(tamperedResult.status, 'FAIL')

  const pathfinderStarted = structuredClone(report)
  pathfinderStarted.fixture.pathfinderStartsAfterLegacyClaim = 2
  pathfinderStarted.fixture.pathfinderStartDelta = 1
  const pathfinderStartedBytes = Buffer.from(`${JSON.stringify(pathfinderStarted)}\n`)
  const startResult = inspectNoDoubleAuthorityFixtureProof({
    report: pathfinderStarted, reportBytes: pathfinderStartedBytes, testSourceBytes, expectedSourceSha: VTR.sourceSha,
    binding: { ...binding, rawReport: { ...binding.rawReport, bytes: pathfinderStartedBytes.length, sha256: sha256(pathfinderStartedBytes) } },
  })
  assert.equal(startResult.status, 'FAIL')
})

test('requires three unique raw walk_leg rows correlated to settled VTR steps', () => {
  const mutateRows = (mutate) => {
    const proof = rawProof()
    const side = proof.rawComparisonEvidence.vtr
    const rows = readText(side, 'runner/jev-run.jsonl').trim().split('\n').map((line) => JSON.parse(line))
    mutate(rows)
    replaceText(side, 'runner/jev-run.jsonl', eventFile(rows))
    return inspectReachComparisonProof(proof, VTR.sourceSha, LEGACY.sourceSha)
  }

  const deleted = mutateRows((rows) => {
    const index = rows.findIndex((row) => row.message.startsWith('SKILL_STEP ') && /count=3(?:\s|$)/u.test(row.message))
    rows.splice(index, 1)
  })
  assert.equal(deleted.status, 'FAIL')
  assert.match(deleted.reason, /walk_leg rows|successful settled correlated/u)

  const duplicated = mutateRows((rows) => {
    const row = rows.find((candidate) => candidate.message.startsWith('SKILL_STEP ') && /count=2(?:\s|$)/u.test(candidate.message))
    rows.push(structuredClone(row))
  })
  assert.equal(duplicated.status, 'FAIL')
  assert.match(duplicated.reason, /duplicate raw walk_leg ordinal/u)

  const wrongStep = mutateRows((rows) => {
    const row = rows.find((candidate) => candidate.message.startsWith('SKILL_STEP ') && /count=1(?:\s|$)/u.test(candidate.message))
    row.detail.stepId = 'MOVE:b6_63_489#17:walk-leg-2'
  })
  assert.equal(wrongStep.status, 'FAIL')
  assert.match(wrongStep.reason, /identity fields disagree/u)

  const wrongHash = mutateRows((rows) => {
    const row = rows.find((candidate) => candidate.message.startsWith('SKILL_STEP ') && /count=1(?:\s|$)/u.test(candidate.message))
    row.detail.contractHash = 'd'.repeat(64)
  })
  assert.equal(wrongHash.status, 'FAIL')
  assert.match(wrongHash.reason, /identity fields disagree/u)

  const refused = mutateRows((rows) => {
    const outcome = rows.find((candidate) => candidate.message.startsWith('VTR_MECHANICAL_STEP_OUTCOME ') && candidate.detail.leg === 1)
    outcome.detail.status = 'refused'
    outcome.detail.outcome = 'REFUSED'
    outcome.detail.verified = false
  })
  assert.equal(refused.status, 'FAIL')
  assert.match(refused.reason, /fewer than three successful settled raw walk_leg rows/u)
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
  const firstOutcome = rows.find((row) => row.message.startsWith('VTR_MECHANICAL_STEP_OUTCOME ') && row.detail.stepId === `${actionId}#17:walk-leg-1`)
  firstOutcome.ts = t(3)
  replaceText(side, 'runner/jev-run.jsonl', eventFile(rows))
  const orderResult = inspectReachComparisonProof(reversed, VTR.sourceSha, LEGACY.sourceSha)
  assert.equal(orderResult.status, 'FAIL')
  assert.match(orderResult.reason, /reserve\/settlement timestamps are not causally ordered/)

  const changedOwner = rawProof()
  const ownerSide = changedOwner.rawComparisonEvidence.vtr
  const ownerRows = readText(ownerSide, 'runner/jev-run.jsonl').trim().split('\n').map((line) => JSON.parse(line))
  const reservation = ownerRows.find((row) => row.message.startsWith('VTR_MECHANICAL_STEP_RESERVED ') && row.detail.stepId === `${actionId}#17:walk-leg-2`)
  reservation.detail.actionId = 'MOVE:other-owner'
  replaceText(ownerSide, 'runner/jev-run.jsonl', eventFile(ownerRows))
  const ownerResult = inspectReachComparisonProof(changedOwner, VTR.sourceSha, LEGACY.sourceSha)
  assert.equal(ownerResult.status, 'FAIL')
  assert.match(ownerResult.reason, /mechanical settlement changed transition\/intent\/action ownership/)
})
