import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const script = resolve('tools/compare-vtr-reach.mjs')
const sourceSha = 'a'.repeat(40)
const vtrSourceSha = 'b'.repeat(40)
const target = { x: 6, y: 63, z: 489 }
const legacyStart = { x: 0.5, y: 63, z: 492.5 }
const spawnPosition = { x: 5.5, y: 63, z: 490.5 }

function legacyArtifact() {
  return {
    schema: 'legacy-reach-comparator/v1',
    runId: 'legacy-run',
    sourceSha,
    buildHash: 'legacy-build',
    generationId: 'legacy-generation',
    sameMissionInput: false,
    missionInput: { kind: 'human_intent_collect', item: 'log', count: 1 },
    fixture: {
      block: 'oak_log',
      position: target,
      initialPlayerPosition: legacyStart,
      sourceOffsetFromInitialPlayer: { x: 6, y: 0, z: -3 },
      flatSolidGround: true,
    },
    legacyPlan: { goal: 'collect 1 x log' },
    run: {
      worldKey: '127.0.0.1:25565|minecraft:overworld|1',
      worldEpoch: 1,
      levelName: 'legacy-world',
      seed: '-7130898457577035486',
      minecraftVersion: '1.21.11',
      gameMode: 'survival',
      difficulty: 'peaceful',
    },
    sliceMetrics: {
      mechanicalMovementSteps: 1,
      legacyMoveActionsToInRangeEvidence: 1,
      jevDecisionFramesThroughInRangeDecision: 2,
      jevQuestionCallsThroughInRangeDecision: 4,
      system2LlmCalls: 0,
      jevProviderModelCalls: 0,
      networkModelCalls: 0,
      modelCallsPerMechanicalStep: 0,
      verifiedVtrTransitions: 0,
      legacyReachSpecificTerminal: 0,
      oldSkillOutcome: 'MOVE action SUCCESS/verified; next decision selected MINE',
      typedVtrTerminalOutcome: 'not-applicable/no VTR contract',
    },
    events: {
      moveActionEnd: { movementStepCount: 1 },
      firstDecision: { candidate: { label: 'oak_log' } },
      nextDecisionInRange: { candidateInReach: true },
    },
  }
}

function vtrArtifact({ includeTransitionStart = true } = {}) {
  const desiredProposition = {
    kind: 'within-interaction-reach-of-resource-source',
    item: 'oak_log',
    sourceNames: ['oak_log'],
    interactionReach: 5,
  }
  const fixture = {
    relativeResourceSource: { block: 'oak_log', position: target },
    sourceOffsetFromInitialPlayer: { x: 6, y: 0, z: -3 },
    flatSolidGround: true,
    witnessChosenByProductionSensor: true,
  }
  if (includeTransitionStart) fixture.transitionStartPosition = legacyStart

  return {
    schema: 'vtr-reach-live-probe/v1',
    source: { commit: vtrSourceSha, buildHash: 'vtr-build' },
    run: {
      runId: 'vtr-run',
      generationId: 'vtr-generation',
      worldKey: '127.0.0.1:25571|overworld|1',
      serverId: '127.0.0.1:25571',
      worldEpoch: 1,
      dimension: 'minecraft:overworld',
      levelName: 'vtr-world',
      seed: '2254908784405056',
      minecraftVersion: '1.21.11',
      gameMode: 'creative',
      difficulty: 'peaceful',
    },
    mission: {
      id: 'run-mission:oak_log:1',
      kind: 'inventory_at_least',
      item: 'oak_log',
      count: 1,
      initialInventory: {},
      finalInventory: {},
      initialPosition: spawnPosition,
      missionCompletion: false,
    },
    fixture,
    transition: {
      transitionId: 'transition-1',
      contractHash: 'contract-hash',
      desiredPredicate: { id: 'reach.resource-source', proposition: desiredProposition, expected: true },
      ensures: [{ id: 'reach.resource-source', proposition: desiredProposition, expected: true }],
      worldIdentity: {
        worldKey: '127.0.0.1:25571|overworld|1',
        dimension: 'overworld',
        worldEpoch: 1,
        generationId: 'vtr-generation',
        leaseId: 'vtr-generation',
      },
      metrics: {
        verifiedTransitionCompletion: 1,
        mechanicalStepsPerTransition: 1,
        jevCallsPerTransition: 0,
        system2CallsPerTransition: 0,
        modelCallsPerMechanicalStep: 0,
        typedTerminalOutcome: 'SUCCESS',
        duplicateAuthority: false,
        duplicateAuthorityConflicts: 0,
        concurrentLegacyActuations: 0,
      },
      outcome: { kind: 'SUCCESS', boundary: 'verified-terminal', evidenceIds: ['verify:1:reach'] },
      precommitUnknownSourceHolds: 0,
      actionSkillReportedSuccessWasNotUsedAsTransitionTerminal: true,
    },
    configuredNoLlmProbe: {
      networkModelCalls: 0,
      effectiveJev: { provider: 'deterministic', model: 'offline', configuredPolicy: 'fallback', decisionCalls: 0 },
      effectiveSystem2: { provider: 'none', model: 'none', configuredMode: 'off', decisionCalls: 0 },
    },
  }
}

function compare(legacy, vtr) {
  const directory = mkdtempSync(join(tmpdir(), 'compare-vtr-reach-test-'))
  try {
    const legacyPath = join(directory, 'legacy.json')
    const vtrPath = join(directory, 'vtr.json')
    writeFileSync(legacyPath, JSON.stringify(legacy))
    writeFileSync(vtrPath, JSON.stringify(vtr))
    const result = spawnSync(process.execPath, [script, legacyPath, vtrPath], { encoding: 'utf8' })
    assert.ok(result.status === 0 || result.status === 1 || result.status === 2, result.stderr)
    return JSON.parse(result.stdout)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test('compares geometry from proven Transition start, not pre-fixture spawn position', () => {
  const report = compare(legacyArtifact(), vtrArtifact())
  assert.equal(report.comparisonStatus, 'NOT_COMPARABLE')
  assert.equal(report.alignment.missionInput, 'NOT_COMPARABLE')
  assert.equal(report.alignment.environment, 'NOT_COMPARABLE')
  assert.equal(report.fixtureAlignment.sameExactCartesianDelta, true)
  assert.equal(report.fixtureAlignment.sameRelativeBlockOffset, true)
  assert.equal(report.fixtureAlignment.vtrFixture.initialPlayerPositionSource, 'transitionStartPosition')
  assert.deepEqual(report.fixtureAlignment.vtrFixture.initialPlayerPosition, legacyStart)
})

test('falls back to mission initial position when no Transition start was recorded', () => {
  const report = compare(legacyArtifact(), vtrArtifact({ includeTransitionStart: false }))
  assert.equal(report.fixtureAlignment.vtrFixture.initialPlayerPositionSource, 'mission.initialPosition')
  assert.deepEqual(report.fixtureAlignment.vtrFixture.initialPlayerPosition, spawnPosition)
  assert.equal(report.fixtureAlignment.sameExactCartesianDelta, false)
  assert.equal(report.alignment.missionInput, 'NOT_COMPARABLE')
  assert.equal(report.alignment.environment, 'NOT_COMPARABLE')
})

test('reports a deterministic Jev Decision Frame separately from zero provider evaluations', () => {
  const vtr = vtrArtifact()
  vtr.transition.metrics.jevCallsPerTransition = 1
  vtr.configuredNoLlmProbe.effectiveJev.decisionCalls = 1
  vtr.transition.eventSequence = [
    'VTR_TRANSITION_MODEL_METRICS transitionId=transition-1 contractHash=contract-hash outcome=SUCCESS mechanicalSteps=1 decisionFrameInvocations=1 providerEvaluateAttempts=0',
  ]
  const report = compare(legacyArtifact(), vtr)
  const vtrPolicy = report.metrics.policyAndModels.vtr
  assert.equal(report.noNetworkProfile.status, 'PASS')
  assert.equal(vtrPolicy.decisionFrameInvocationsPerTransition, 1)
  assert.equal(vtrPolicy.jevProviderEvaluateAttemptsIncludingRetriesPerTransition, 0)
  assert.equal(vtrPolicy.jevProviderEvaluateAttemptsPerMechanicalStep, 0)
  assert.equal(vtrPolicy.legacyJevCallsPerTransition, 1)
})

test('allows measured legacy provider calls while requiring zero calls only from the VTR no-LLM probe', () => {
  const legacy = legacyArtifact()
  legacy.sliceMetrics.jevProviderModelCalls = 2
  legacy.sliceMetrics.networkModelCalls = 2
  legacy.sliceMetrics.modelCallsPerMechanicalStep = 2
  const vtr = vtrArtifact()
  vtr.transition.eventSequence = [
    'VTR_TRANSITION_MODEL_METRICS transitionId=transition-1 contractHash=contract-hash outcome=SUCCESS mechanicalSteps=1 decisionFrameInvocations=0 providerEvaluateAttempts=0',
  ]
  const report = compare(legacy, vtr)
  assert.equal(report.noNetworkProfile.status, 'PASS')
  assert.equal(report.noNetworkProfile.appliesTo, 'VTR no-LLM capability probe only; legacy provider calls are measured as a comparison metric')
  assert.equal(report.metrics.policyAndModels.legacy.jevProviderModelCalls, 2)
  assert.equal(report.metrics.policyAndModels.legacy.networkModelCalls, 2)
  assert.match(report.metrics.policyAndModels.legacy.providerActivity, /permitted for the legacy baseline/)
})

test('keeps absent Transition model metrics UNKNOWN instead of deriving provider calls from Jev calls', () => {
  const vtr = vtrArtifact()
  vtr.transition.metrics.jevCallsPerTransition = 2
  vtr.transition.metrics.modelCallsPerMechanicalStep = 2
  vtr.configuredNoLlmProbe.effectiveJev.decisionCalls = 2
  const report = compare(legacyArtifact(), vtr)
  const vtrPolicy = report.metrics.policyAndModels.vtr
  assert.equal(report.noNetworkProfile.status, 'UNKNOWN')
  assert.equal(report.noNetworkProfile.modelMetrics.status, 'UNKNOWN')
  assert.equal(vtrPolicy.legacyJevCallsPerTransition, 2)
  assert.equal(vtrPolicy.decisionFrameInvocationsPerTransition, null)
  assert.equal(vtrPolicy.jevProviderEvaluateAttemptsIncludingRetriesPerTransition, null)
  assert.equal(vtrPolicy.jevProviderEvaluateAttemptsPerMechanicalStep, null)
  assert.equal(report.comparisonStatus, 'NOT_COMPARABLE')
})

function archivedVtrProbe() {
  const runId = 'archive-vtr-run'
  const generationId = 'archive-vtr-generation'
  const transitionId = 'archive-transition-1'
  const worldKey = '127.0.0.1:25571|overworld|1'
  const desiredPredicateIdentity = 'reach-predicate-identity'
  const evidenceIds = ['verify:1:oak_log@6,63,489']
  const proposition = {
    kind: 'within-interaction-reach-of-resource-source',
    item: 'oak_log',
    sourceNames: ['oak_log'],
    interactionReach: 5,
  }
  return {
    record: 'vtr-reach-live-probe',
    runId,
    sourceSha: vtrSourceSha,
    generationId,
    generationHash: 'archive-build',
    server: {
      serverId: '127.0.0.1:25571',
      worldEpoch: 1,
      dimension: 'minecraft:overworld',
      worldName: 'vtr-world',
      worldSeedFromLevelDat: '-7130898457577035486',
      minecraftVersion: '1.21.11',
      gamemode: 'survival',
      difficulty: 'peaceful',
    },
    mission: {
      kind: 'inventory_at_least',
      item: 'oak_log',
      count: 1,
      initialInventory: {},
      finalInventory: {},
    },
    fixture: {
      witness: { block: 'oak_log', position: target },
      runnerBootPosition: spawnPosition,
      harnessTeleportCommand: 'tp AI_Buddy 0.5 64 492.5',
      transitionStartPosition: legacyStart,
    },
    transition: {
      commit: {
        transitionId,
        mission: { id: 'run-mission:oak_log:1', kind: 'inventory_at_least', item: 'oak_log', count: 1 },
        desiredPredicate: { id: 'reach.resource-source', proposition, expected: true },
        ensures: [{ id: 'reach.resource-source', proposition, expected: true }],
        identity: { worldKey, dimension: 'overworld', worldEpoch: 1, generationId, leaseId: generationId },
        witness: {
          evidenceId: 'sensor:block:1:oak_log@6,63,489',
          observedIdentity: { generationId },
        },
      },
      verify: {
        transitionId,
        runId,
        generationId,
        sourceSha: vtrSourceSha,
        worldKey,
        worldEpoch: 1,
        contractHash: 'archive-contract-hash',
        truth: 'TRUE',
        identityMatches: true,
        predicatesVerified: true,
        evidenceIds,
        desiredPredicateIdentity,
      },
      terminalOutcome: {
        transitionId,
        contractHash: 'archive-contract-hash',
        outcome: { kind: 'SUCCESS', desiredPredicateIdentity, evidenceIds },
        boundary: 'mechanical-step-outcome',
      },
      eventSequence: [
        'VTR_REACH_PROBE_HOLD reason=no-grounded-reach-candidate',
        `VTR_TRANSITION_COMMIT id=${transitionId}`,
        `VTR_TRANSITION_VERIFY id=${transitionId} truth=TRUE`,
        `VTR_TRANSITION_OUTCOME id=${transitionId} outcome=SUCCESS`,
      ],
    },
    metrics: {
      verifiedTransitionCompletion: 1,
      mechanicalStepsPerTransition: 1,
      jevCallsPerTransition: 0,
      system2CallsPerTransition: 0,
      modelCallsPerMechanicalStep: 0,
      typedTerminalOutcome: 'SUCCESS',
      duplicateAuthority: false,
      duplicateAuthorityConflicts: 0,
    },
    configuration: {
      BUDDY_POLICY: 'fallback',
      BUDDY_SYSTEM2: 'off',
      effectiveJevProvider: 'deterministic',
      effectiveJevModel: 'offline',
      effectiveSystem2Provider: 'none',
      effectiveSystem2Model: 'none',
      networkModelCalls: 0,
    },
    identity: { seedAssessment: 'acceptance seed disagrees with saved level.dat and server /seed' },
  }
}

function compareWithVtrArchive(legacy, probe, {
  teleportAt = '2026-09-24T21:01:41.883Z',
  commitAt = '2026-09-24T21:01:46.059Z',
  modelMetricsEvent = `VTR_TRANSITION_MODEL_METRICS transitionId=${probe.transition.commit.transitionId} contractHash=archive-contract-hash outcome=SUCCESS mechanicalSteps=1 decisionFrameInvocations=0 providerEvaluateAttempts=0`,
  runJsonlModelMetricsEvent = null,
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'compare-vtr-reach-archive-test-'))
  try {
    const archiveRoot = join(directory, 'archive')
    const serverDir = join(archiveRoot, 'server')
    const runnerDir = join(archiveRoot, 'runner')
    const proofsDir = join(archiveRoot, 'proofs')
    const legacyPath = join(directory, 'legacy.json')
    const vtrPath = join(archiveRoot, 'probe.json')
    for (const path of [archiveRoot, serverDir, runnerDir, proofsDir]) {
      mkdirSync(path, { recursive: true })
    }
    writeFileSync(legacyPath, JSON.stringify(legacy))
    writeFileSync(vtrPath, JSON.stringify(probe))
    writeFileSync(join(serverDir, 'fixture-commands.jsonl'), JSON.stringify({
      record: 'console-command',
      recordedAt: teleportAt,
      command: probe.fixture.harnessTeleportCommand,
      username: 'AI_Buddy',
    }) + '\n')
    const runnerLines = [`[${commitAt}] VTR_TRANSITION_COMMIT transitionId=${probe.transition.commit.transitionId} mission=run-mission`]
    if (modelMetricsEvent !== null) runnerLines.push(`[${commitAt}] [vtr] ${modelMetricsEvent}`)
    writeFileSync(join(runnerDir, 'buddy.log'), `${runnerLines.join('\n')}\n`)
    if (runJsonlModelMetricsEvent !== null) {
      writeFileSync(join(runnerDir, 'run.jsonl'), `${JSON.stringify({ record: 'agent-event', message: runJsonlModelMetricsEvent })}\n`)
    }
    writeFileSync(join(proofsDir, 'no-double-authority.json'), JSON.stringify({
      result: 'PASS',
      runId: probe.runId,
      sourceSha: probe.sourceSha,
      generationId: probe.generationId,
      legacyActuationCount: 0,
      vtrActuationCount: 1,
      duplicateAuthority: false,
      duplicateAuthorityConflicts: 0,
    }))
    const result = spawnSync(process.execPath, [script, legacyPath, vtrPath], { encoding: 'utf8' })
    return { result, cleanup: () => rmSync(directory, { recursive: true, force: true }) }
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
}


test('archive adapter uses a pre-commit harness transition start and keeps mission/environment mismatches', () => {
  const { result, cleanup } = compareWithVtrArchive(legacyArtifact(), archivedVtrProbe())
  try {
    assert.equal(result.status, 2, result.stderr)
    const report = JSON.parse(result.stdout)
    assert.equal(report.alignment.missionInput, 'NOT_COMPARABLE')
    assert.equal(report.alignment.environment, 'NOT_COMPARABLE')
    assert.equal(report.fixtureAlignment.sameExactCartesianDelta, true)
    assert.equal(report.fixtureAlignment.sameRelativeBlockOffset, true)
    assert.equal(report.fixtureAlignment.vtrFixture.initialPlayerPositionSource, 'transitionStartPosition')
    assert.equal(report.fixtureAlignment.vtrFixture.initialPlayerPositionEvidence, 'fixture.transitionStartPosition (console tp precedes commit)')
    assert.equal(report.fixtureAlignment.vtrFixture.initialPlayerPosition.x, legacyStart.x)
    assert.equal(report.fixtureAlignment.vtrFixture.initialPlayerPosition.z, legacyStart.z)
    assert.equal(report.fixtureAlignment.environmentMatch.seedProvenance, false)
    assert.equal(report.fixtureAlignment.vtrFixture.flatSolidGround, null)
    assert.equal(report.fixtureAlignment.sameRelativeFixture, true)
    assert.equal(report.noNetworkProfile.status, 'PASS')
    assert.equal(report.noNetworkProfile.modelMetrics.decisionFrameInvocations, 0)
    assert.equal(report.noNetworkProfile.modelMetrics.providerEvaluateAttemptsIncludingRetries, 0)
    assert.equal(report.metrics.policyAndModels.vtr.modelMetricsSource, 'runner/buddy.log')
  } finally {
    cleanup()
  }
})

test('prefers structured run.jsonl model metrics and cross-checks duplicated log evidence', () => {
  const probe = archivedVtrProbe()
  const event = `VTR_TRANSITION_MODEL_METRICS transitionId=${probe.transition.commit.transitionId} contractHash=${probe.transition.terminalOutcome.contractHash} outcome=SUCCESS mechanicalSteps=1 decisionFrameInvocations=0 providerEvaluateAttempts=0`
  const { result, cleanup } = compareWithVtrArchive(legacyArtifact(), probe, {
    modelMetricsEvent: event,
    runJsonlModelMetricsEvent: event,
  })
  try {
    assert.equal(result.status, 2, result.stderr)
    const report = JSON.parse(result.stdout)
    assert.equal(report.noNetworkProfile.status, 'PASS')
    assert.equal(report.noNetworkProfile.modelMetrics.source, 'runner/run.jsonl')
  } finally {
    cleanup()
  }
})

test('surfaces retry-inclusive provider attempts and fails a claimed no-network profile', () => {
  const probe = archivedVtrProbe()
  probe.metrics.jevCallsPerTransition = 1
  probe.configuration.networkModelCalls = 0
  const modelMetricsEvent = `VTR_TRANSITION_MODEL_METRICS transitionId=${probe.transition.commit.transitionId} contractHash=${probe.transition.terminalOutcome.contractHash} outcome=SUCCESS mechanicalSteps=1 decisionFrameInvocations=1 providerEvaluateAttempts=3`
  const { result, cleanup } = compareWithVtrArchive(legacyArtifact(), probe, { modelMetricsEvent })
  try {
    assert.equal(result.status, 1, result.stderr)
    const report = JSON.parse(result.stdout)
    const vtrPolicy = report.metrics.policyAndModels.vtr
    assert.equal(report.comparisonStatus, 'INVALID_NO_LLM_PROFILE')
    assert.equal(report.acceptanceEligible, false)
    assert.equal(report.noNetworkProfile.status, 'FAIL')
    assert.ok(report.noNetworkProfile.issues.includes('VTR_TRANSITION_MODEL_METRICS.providerEvaluateAttempts=3'))
    assert.equal(vtrPolicy.legacyJevCallsPerTransition, 1)
    assert.equal(vtrPolicy.decisionFrameInvocationsPerTransition, 1)
    assert.equal(vtrPolicy.jevProviderEvaluateAttemptsIncludingRetriesPerTransition, 3)
    assert.equal(vtrPolicy.jevProviderEvaluateAttemptsPerMechanicalStep, 3)
    assert.equal(vtrPolicy.deprecatedModelCallsPerMechanicalStep, 0)
  } finally {
    cleanup()
  }
})

test('archived run without VTR_TRANSITION_MODEL_METRICS leaves provider metrics UNKNOWN', () => {
  const { result, cleanup } = compareWithVtrArchive(legacyArtifact(), archivedVtrProbe(), { modelMetricsEvent: null })
  try {
    assert.equal(result.status, 2, result.stderr)
    const report = JSON.parse(result.stdout)
    assert.equal(report.noNetworkProfile.status, 'UNKNOWN')
    assert.equal(report.noNetworkProfile.modelMetrics.status, 'UNKNOWN')
    assert.equal(report.noNetworkProfile.modelMetrics.decisionFrameInvocations, null)
    assert.equal(report.noNetworkProfile.modelMetrics.providerEvaluateAttemptsIncludingRetries, null)
  } finally {
    cleanup()
  }
})

test('archive adapter refuses to treat a teleport after commit as Transition start evidence', () => {
  const { result, cleanup } = compareWithVtrArchive(legacyArtifact(), archivedVtrProbe(), {
    teleportAt: '2026-09-24T21:01:46.500Z',
  })
  try {
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /teleport occurred before Transition commit/)
  } finally {
    cleanup()
  }
})

test('prefers run-bound legacy archive fixture over a stale embedded baseline position', () => {
  const directory = mkdtempSync(join(tmpdir(), 'compare-vtr-legacy-archive-test-'))
  try {
    const archiveRoot = join(directory, 'archive')
    const comparisonDir = join(archiveRoot, 'comparison')
    const runnerDir = join(archiveRoot, 'runner')
    mkdirSync(comparisonDir, { recursive: true })
    mkdirSync(runnerDir, { recursive: true })
    const legacyPath = join(comparisonDir, 'legacy-input.json')
    const vtrPath = join(directory, 'vtr.json')
    const legacy = legacyArtifact()
    const vtr = vtrArtifact()
    const legacyFixture = {
      block: 'oak_log',
      position: target,
      initialPlayerPosition: spawnPosition,
      sourceOffsetFromInitialPlayer: { x: 1, y: 0, z: -1 },
      flatSolidGround: null,
    }
    const legacyInput = {
      schema: 'reach-old-vtr-comparison/v1',
      missionInput: legacy.missionInput,
      baseline: {
        commit: sourceSha,
        originMainAtCheckout: sourceSha,
        buildHash: 'legacy-build',
        runId: 'legacy-run',
        generationId: 'legacy-generation',
        worldKey: '127.0.0.1:25565|minecraft:overworld|1',
        worldEpoch: 1,
        levelName: 'legacy-world',
        seed: '-7130898457577035486',
        minecraftVersion: '1.21.11',
        gameMode: 'survival',
        difficulty: 'peaceful',
        missionInput: legacy.missionInput,
        fixture: legacyFixture,
        effectiveJev: { provider: 'deterministic', model: 'offline', networkCalls: 0 },
        effectiveSystem2: { provider: 'none', model: 'none', actualSystem2LlmCalls: 0 },
        metrics: legacy.sliceMetrics,
      },
      comparison: {
        sameMissionInput: false,
        sameGeometryFixtureClass: true,
        target: 'natural oak_log at shared fixture location',
        reason: 'different Mission inputs',
      },
    }
    const legacySliceEvidence = {
      runId: 'legacy-run',
      generationId: 'legacy-generation',
      sourceSha,
      buildHash: 'legacy-build',
      fixture: {
        block: 'oak_log',
        position: target,
        initialPlayerPosition: legacyStart,
        sourceOffsetFromInitialPlayer: { x: 6, y: 0, z: -3 },
        flatSolidGround: null,
      },
    }
    writeFileSync(legacyPath, JSON.stringify(legacyInput))
    writeFileSync(join(runnerDir, 'reach-slice-evidence.json'), JSON.stringify(legacySliceEvidence))
    writeFileSync(vtrPath, JSON.stringify(vtr))
    const result = spawnSync(process.execPath, [script, legacyPath, vtrPath], { encoding: 'utf8' })
    assert.equal(result.status, 2, result.stderr)
    const report = JSON.parse(result.stdout)
    assert.equal(report.fixtureAlignment.legacyFixtureEvidencePath, 'runner/reach-slice-evidence.json')
    assert.deepEqual(report.fixtureAlignment.legacyFixtureStructured.initialPlayerPosition, legacyStart)
    assert.equal(report.fixtureAlignment.sameExactCartesianDelta, true)
    assert.equal(report.fixtureAlignment.sameRelativeBlockOffset, true)
    assert.equal(report.alignment.missionInput, 'NOT_COMPARABLE')
    assert.equal(report.alignment.environment, 'NOT_COMPARABLE')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
