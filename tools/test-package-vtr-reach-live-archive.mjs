#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { packageVtrReachArchive } from './package-vtr-reach-live-archive.mjs'

const SOURCE = 'a'.repeat(40)
const RUN = 'run-vtrabc123-archive'
const GENERATION = 'gen-vtr-archive-xyz789'
const WORLD = '127.0.0.1:25565|overworld|4'
const CONTRACT = 'c'.repeat(64)
const TRANSITION = 'transition-vtr-archive-1'
const MISSION = { kind: 'inventory_at_least', item: 'oak_log', count: 1 }
const START = Date.parse('2026-09-25T04:00:00.000Z')
const iso = (offset) => new Date(START + offset).toISOString()
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')

function event(offset, name, detail) {
  return { record: 'agent-event', ts: iso(offset), source: 'vtr', message: `${name} transitionId=${TRANSITION}`, detail }
}

function regionPathForWitness(position) {
  const chunkX = Math.floor(position.x / 16)
  const chunkZ = Math.floor(position.z / 16)
  const regionX = Math.floor(chunkX / 32)
  const regionZ = Math.floor(chunkZ / 32)
  return `server/world/r.${regionX}.${regionZ}.mca`
}

function makeFixture(root, { omitProvider = null, addCapture = true, wrongServerIdentity = false, captureStartsLate = false, nonzeroActivity = false, witnessPosition = { x: 4, y: 64, z: 4 } } = {}) {
  const inputDir = join(root, 'captured')
  const extraDir = join(root, 'extra')
  const archive = join(root, 'archive')
  const emptySha = digest(Buffer.alloc(0))
  const bundle = Buffer.from('generation-bundle fixture bytes\n')
  const buildHash = digest(bundle).slice(0, 12)
  const worldObject = { serverId: '127.0.0.1:25565', dimension: 'minecraft:overworld', worldEpoch: 4 }
  const desiredPredicate = {
    id: 'reach.oak-log',
    proposition: { kind: 'within-interaction-reach-of-resource-source', item: 'oak_log', sourceNames: ['oak_log'], interactionReach: 5 },
    expected: true,
  }
  const identity = { worldKey: WORLD, dimension: 'overworld', worldEpoch: 4, generationId: GENERATION, leaseId: GENERATION }
  const commit = event(10, 'VTR_TRANSITION_COMMIT', {
    transitionId: TRANSITION,
    contractHash: CONTRACT,
    identity,
    mission: MISSION,
    desiredPredicate,
    requires: [],
    ensures: [desiredPredicate],
    invariants: [],
    admissibleEffects: [],
    budget: { maxMechanicalSteps: 4, maxElapsedMs: 10000, resources: {}, risk: {} },
    controller: { allowedTactics: ['walk', 'replan'] },
    progressDefinition: { kind: 'verified-distance-reduction' },
    witness: { target: witnessPosition, witnessId: 'oak-log-witness' },
  })
  const verify = event(30, 'VTR_TRANSITION_VERIFY', {
    transitionId: TRANSITION,
    contractHash: CONTRACT,
    verification: {
      truth: 'TRUE', evidenceIds: ['verify:30:oak-log'], verifiedAtMs: START + 30,
      observedAtMs: START + 30, runId: RUN, generationId: GENERATION, leaseId: GENERATION,
      sourceSha: SOURCE, worldKey: WORLD, worldEpoch: 4, dimension: 'overworld',
    },
  })
  const terminal = event(31, 'VTR_TRANSITION_OUTCOME', {
    transitionId: TRANSITION,
    outcome: { kind: 'SUCCESS', contractHash: CONTRACT, evidenceIds: ['verify:30:oak-log'], desiredPredicateIdentity: 'predicate:reach.oak-log', verifiedAtMs: START + 30 },
    boundary: 'verified-terminal',
    usage: { mechanicalSteps: 1, elapsedMs: 200, resources: {}, risk: {}, effects: {} },
    jevCalls: 0,
    system2Calls: 0,
    metrics: { typedTerminalOutcome: 'SUCCESS', mechanicalStepsPerTransition: 1, duplicateAuthority: false, duplicateAuthorityConflicts: 0, concurrentLegacyActuations: 0 },
  })
  const events = [commit, event(15, 'VTR_TRANSITION_ACTUATION', { transitionId: TRANSITION, authority: 'vtr_transition', contractHash: CONTRACT }),
    event(16, 'VTR_MECHANICAL_STEP_RESERVED', { transitionId: TRANSITION, contractHash: CONTRACT }),
    event(20, 'VTR_MECHANICAL_STEP_OUTCOME', { transitionId: TRANSITION, contractHash: CONTRACT }), verify, terminal]
  const journalSources = {
    'host-log': '[2026-09-25T04:00:00.000Z] BOOT runId=run-vtrabc123-archive source=' + SOURCE + '\n',
    'run-journal': events.map((row) => JSON.stringify(row)).join('\n') + '\n',
    'jev-calls': '',
    'jev-decisions': '',
    'system2-journal': '',
  }
  writeFixtureFile(inputDir, 'host.log', journalSources['host-log'])
  writeFixtureFile(inputDir, 'run.jsonl', journalSources['run-journal'])
  writeFixtureFile(inputDir, 'jev-calls.jsonl', journalSources['jev-calls'])
  writeFixtureFile(inputDir, 'jev-decisions.jsonl', journalSources['jev-decisions'])
  writeFixtureFile(inputDir, 'system2.jsonl', journalSources['system2-journal'])

  const inputNames = {
    'host-log': 'host.log',
    'run-journal': 'run.jsonl',
    'jev-calls': 'jev-calls.jsonl',
    'jev-decisions': 'jev-decisions.jsonl',
    'system2-journal': 'system2.jsonl',
  }
  const inputs = Object.entries(inputNames).map(([name, file]) => {
    const path = join(inputDir, file)
    if (omitProvider === name) return { name, path, status: 'missing' }
    const bytes = readFileSync(path)
    return { name, path, status: 'captured', bytes: bytes.length, sha256: digest(bytes) }
  })
  const collectorReport = {
    schema: 'vtr-reach-live-collector/v1',
    status: 'PASS',
    capturedAt: iso(40),
    expected: { sourceSha: SOURCE, mission: MISSION },
    observed: {
      sourceSha: SOURCE,
      runId: RUN,
      generationId: GENERATION,
      worldKey: WORLD,
      worldIdentity: worldObject,
      generationReady: { timestamp: iso(5), buildHash },
      mission: MISSION,
      configuredNoLlmProbe: { BUDDY_POLICY: 'fallback', BUDDY_SYSTEM2: 'off', effectiveJevProvider: 'deterministic', effectiveSystem2Provider: 'none' },
      transition: {
        transitionId: TRANSITION,
        contractHash: CONTRACT,
        sourceEventRows: events,
        metrics: { jevCallsPerTransition: 0, system2CallsPerTransition: 0, modelCallsPerMechanicalStep: 0, duplicateAuthority: false, duplicateAuthorityConflicts: 0 },
      },
    },
    captureWindow: { startedAt: iso(5), endedAt: iso(35), sampleCount: 2 },
    inputs,
    checks: [
      { id: 'policy:no-model-activity-during-probe', status: 'PASS' },
      { id: 'policy:provider-journals', status: 'PASS' },
    ],
  }
  const collectorPath = join(root, 'collector-report.json')
  writeJson(collectorPath, collectorReport)

  const runMetadata = {
    schema: 'vtr-reach-run-metadata/v1',
    source: { repository: 'souta-lab/minecraft-jev-agent', commit: SOURCE, branch: 'feat/vtr-reach-live-probe-collector-20260925' },
    run: {
      runId: RUN, generationId: GENERATION, serverId: '127.0.0.1:25565', worldEpoch: 4, worldKey: WORLD,
      dimension: 'overworld', levelName: 'vtr-reach-live', seed: '4312', minecraftVersion: '1.21.4', dataVersion: 4189,
      difficulty: 'normal', gameMode: 'survival', botUsername: 'AI_Buddy', botUuid: '00000000-0000-0000-0000-000000000001',
      startedAt: iso(0), generationReadyAt: iso(5), shutdownAt: iso(50),
      finalPosition: { x: 1.5, y: 64, z: 1.5 },
    },
    mission: { ...MISSION, initialInventory: {}, finalInventory: {}, initialPosition: { x: 0.5, y: 64, z: 0.5 }, finalPosition: { x: 1.5, y: 64, z: 1.5 } },
    fixture: { block: 'oak_log', position: witnessPosition, transitionStartPosition: { x: 0.5, y: 64, z: 0.5 } },
    configuredNoLlmProbe: {
      fallback: { fallbackPolicyWasExplicitlyConfigured: true, silentFallbackOnProviderFailure: false, JevDecisionInvoked: false },
    },
  }
  const launchProperties = 'server-ip=127.0.0.1\nserver-port=25565\nlevel-name=vtr-reach-live\ngamemode=survival\ndifficulty=normal\nlevel-seed=\n'
  const effectiveProperties = launchProperties
  const serverStart = {
    runId: RUN, generationId: GENERATION, sourceSha: SOURCE, worldKey: wrongServerIdentity ? '127.0.0.1:25566|overworld|4' : WORLD,
    levelName: 'vtr-reach-live', minecraftVersion: '1.21.4', dataVersion: 4189, difficulty: 'normal', worldEpoch: 4,
    freshWorld: true, bootLog: 'No existing world data, creating new world', serverPropertiesSha256: digest(Buffer.from(launchProperties)),
    serverPropertiesEffectiveSha256: digest(Buffer.from(effectiveProperties)), serverJar: '/nonexistent/server.jar', serverJarSha256: 'd'.repeat(64),
  }
  const files = {
    'runner/run-metadata.json': writeJson(join(extraDir, 'run-metadata.json'), runMetadata),
    'runner/acceptance.json': writeJson(join(extraDir, 'acceptance.json'), { gitCommit: SOURCE, checkoutHead: SOURCE, runId: RUN, generationId: GENERATION, worldEpoch: 4, levelName: 'vtr-reach-live', seed: '4312' }),
    'runner/generation-bundle.mjs': writeFixtureFile(extraDir, 'bundle.mjs', bundle),
    'runner/initial-snapshot.json': writeJson(join(extraDir, 'initial-snapshot.json'), { runId: RUN, generationId: GENERATION, bootSourceSha: SOURCE, buildHash, worldEpoch: 4, initialInventory: {} }),
    'runner/final-snapshot.json': writeJson(join(extraDir, 'final-snapshot.json'), { runId: RUN, generationId: GENERATION, sourceSha: SOURCE, worldEpoch: 4, finalInventory: {} }),
    'runner/milestone-predicates.json': writeJson(join(extraDir, 'milestone-predicates.json'), { runId: RUN, generationId: GENERATION, sourceSha: SOURCE, worldEpoch: 4 }),
    'server/fixture-commands.jsonl': writeFixtureFile(extraDir, 'fixture-commands.jsonl', JSON.stringify({ runId: RUN, generationId: GENERATION, sourceSha: SOURCE, worldEpoch: 4, command: 'setblock' }) + '\n'),
    'server/leaf-latest.log': writeFixtureFile(extraDir, 'leaf.log', 'Starting minecraft server version 1.21.4\nNo existing world data, creating new world\nPreparing level "vtr-reach-live"\nUUID of player AI_Buddy is 00000000-0000-0000-0000-000000000001\n'),
    'server/server-start.json': writeJson(join(extraDir, 'server-start.json'), serverStart),
    'server/server.properties.launch': writeFixtureFile(extraDir, 'server.properties.launch', launchProperties),
    'server/server.properties.effective-after-boot': writeFixtureFile(extraDir, 'server.properties.effective-after-boot', effectiveProperties),
    'server/world/level.dat': writeFixtureFile(extraDir, 'level.dat', Buffer.from('level fixture bytes')),
    'server/world/playerdata.dat': writeFixtureFile(extraDir, 'playerdata.dat', Buffer.from('player fixture bytes')),
    [regionPathForWitness(witnessPosition)]: writeFixtureFile(extraDir, 'witness-region.mca', Buffer.from('region fixture bytes')),
  }

  if (addCapture) {
    const capture = {
      schema: 'vtr-provider-activity-capture/v1', status: 'OBSERVED',
      identity: { sourceSha: SOURCE, runId: RUN, generationId: GENERATION, worldKey: worldObject },
      window: { startedAt: iso(captureStartsLate ? 6 : 4), endedAt: iso(35), coverageComplete: true },
      activity: { networkModelCalls: nonzeroActivity ? 1 : 0, jevDecisionCalls: 0, system2DecisionCalls: 0 },
      journals: Object.fromEntries(PROVIDER_JOURNALS.map((name) => [name, { bytes: 0, sha256: emptySha, initializedAt: iso(4), closedAt: iso(35) }])),
    }
    files['runner/provider-activity-capture.json'] = writeJson(join(extraDir, 'provider-activity-capture.json'), capture)
  }
  for (const [archivePath, sourcePath] of Object.entries(files)) files[archivePath] = sourcePath
  const manifestPath = join(root, 'manifest.json')
  writeJson(manifestPath, { schema: 'vtr-reach-live-archive-input/v1', files })
  return { collectorPath, manifestPath, archive, collectorReport, files, witnessRegionPath: regionPathForWitness(witnessPosition) }
}

const PROVIDER_JOURNALS = ['jev-calls', 'jev-decisions', 'system2-journal']

function writeFixtureFile(root, name, contents) {
  const path = join(root, name)
  const bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(contents)
  mkdirSync(root, { recursive: true })
  writeFileSync(path, bytes)
  return path
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
  return path
}

const tempRoot = mkdtempSync(join(tmpdir(), 'vtr-reach-archive-test-'))
try {
  const complete = makeFixture(join(tempRoot, 'complete'))
  const completeResult = packageVtrReachArchive({ collectorReportPath: complete.collectorPath, manifestPath: complete.manifestPath, archivePath: complete.archive })
  assert.equal(completeResult.report.packageStatus, 'READY_FOR_VALIDATION', JSON.stringify(completeResult.report.checks, null, 2))
  assert.equal(completeResult.report.providerActivity.status, 'OBSERVED_ZERO')
  const packagedProbe = JSON.parse(readFileSync(join(complete.archive, 'probe.json'), 'utf8'))
  assert.equal(packagedProbe.source.commit, SOURCE)
  assert.equal(packagedProbe.run.runId, RUN)
  assert.equal(packagedProbe.run.generationId, GENERATION)
  assert.equal(packagedProbe.run.worldKey, WORLD)
  assert.equal(packagedProbe.transition.requires.length, 0)
  assert.equal(packagedProbe.transition.transitionId, TRANSITION)
  assert.equal(completeResult.report.requiredWitnessRegionPath, complete.witnessRegionPath)
  assert.ok(completeResult.report.requiredValidatorPaths.includes(complete.witnessRegionPath))
  assert.equal(completeResult.report.checks.find((entry) => entry.id === 'required:world-witness-region')?.status, 'PASS')
  assert.equal(complete.witnessRegionPath, 'server/world/r.0.0.mca')
  assert.equal(existsSync(join(complete.archive, 'server/world/r.-1.0.mca')), false, 'a positive witness does not require the former fixed negative-region path')
  assert.equal(packagedProbe.configuredNoLlmProbe.networkModelCalls, 0)
  for (const [name, filename] of [['jev-calls', 'jev-calls.jsonl'], ['jev-decisions', 'jev-decisions.jsonl'], ['system2-journal', 'system2.jsonl']]) {
    assert.equal(readFileSync(join(complete.archive, `runner/${filename}`), 'utf8'), '', `empty captured journal ${name} is preserved`)
  }
  const hashLines = readFileSync(join(complete.archive, 'SHA256SUMS'), 'utf8').trim().split('\n')
  assert.ok(hashLines.some((line) => line.endsWith('  probe.json')))
  assert.ok(hashLines.some((line) => line.endsWith('  packaging-report.json')))

  const noAttestation = makeFixture(join(tempRoot, 'no-attestation'), { addCapture: false })
  const noAttestationResult = packageVtrReachArchive({ collectorReportPath: noAttestation.collectorPath, manifestPath: noAttestation.manifestPath, archivePath: noAttestation.archive })
  assert.equal(noAttestationResult.report.packageStatus, 'INCOMPLETE')
  assert.equal(noAttestationResult.report.providerActivity.status, 'INCOMPLETE')
  const noAttestationProbe = JSON.parse(readFileSync(join(noAttestation.archive, 'probe.json'), 'utf8'))
  assert.equal(noAttestationProbe.configuredNoLlmProbe.networkModelCalls, null)
  assert.ok(existsSync(join(noAttestation.archive, 'runner/jev-calls.jsonl')), 'a genuinely captured source file may be copied')

  const missingJournal = makeFixture(join(tempRoot, 'missing-journal'), { omitProvider: 'jev-calls' })
  const missingJournalResult = packageVtrReachArchive({ collectorReportPath: missingJournal.collectorPath, manifestPath: missingJournal.manifestPath, archivePath: missingJournal.archive })
  assert.equal(missingJournalResult.report.packageStatus, 'INCOMPLETE')
  assert.equal(existsSync(join(missingJournal.archive, 'runner/jev-calls.jsonl')), false, 'adapter must not fabricate an empty journal')
  assert.equal(missingJournalResult.report.providerActivity.status, 'INCOMPLETE')

  const lateCapture = makeFixture(join(tempRoot, 'late-capture'), { captureStartsLate: true })
  const lateCaptureResult = packageVtrReachArchive({ collectorReportPath: lateCapture.collectorPath, manifestPath: lateCapture.manifestPath, archivePath: lateCapture.archive })
  assert.equal(lateCaptureResult.report.packageStatus, 'INCOMPLETE')
  assert.equal(lateCaptureResult.report.providerActivity.status, 'INCOMPLETE', 'existing empty post-run journals do not prove zero activity over the live window')

  const observedModelCall = makeFixture(join(tempRoot, 'observed-model-call'), { nonzeroActivity: true })
  const observedModelCallResult = packageVtrReachArchive({ collectorReportPath: observedModelCall.collectorPath, manifestPath: observedModelCall.manifestPath, archivePath: observedModelCall.archive })
  assert.equal(observedModelCallResult.report.packageStatus, 'FAIL')
  assert.equal(observedModelCallResult.report.providerActivity.status, 'FAIL')

  const conflicting = makeFixture(join(tempRoot, 'conflicting'), { wrongServerIdentity: true })
  const conflictingResult = packageVtrReachArchive({ collectorReportPath: conflicting.collectorPath, manifestPath: conflicting.manifestPath, archivePath: conflicting.archive })
  assert.equal(conflictingResult.report.packageStatus, 'FAIL')
  assert.ok(conflictingResult.report.checks.some((entry) => entry.id === 'identity:server/server-start.json' && entry.status === 'FAIL'))

  const positiveRegion = makeFixture(join(tempRoot, 'positive-region'), { witnessPosition: { x: 513, y: 64, z: 515 } })
  const positiveRegionResult = packageVtrReachArchive({ collectorReportPath: positiveRegion.collectorPath, manifestPath: positiveRegion.manifestPath, archivePath: positiveRegion.archive })
  assert.equal(positiveRegion.witnessRegionPath, 'server/world/r.1.1.mca')
  assert.equal(positiveRegionResult.report.requiredWitnessRegionPath, positiveRegion.witnessRegionPath)
  assert.ok(positiveRegionResult.report.requiredValidatorPaths.includes(positiveRegion.witnessRegionPath))
  assert.equal(positiveRegionResult.report.checks.find((entry) => entry.id === 'required:world-witness-region')?.status, 'PASS')
  assert.equal(positiveRegionResult.report.packageStatus, 'READY_FOR_VALIDATION')

  const negativeRegion = makeFixture(join(tempRoot, 'negative-region'), { witnessPosition: { x: -513, y: 64, z: -515 } })
  const negativeRegionResult = packageVtrReachArchive({ collectorReportPath: negativeRegion.collectorPath, manifestPath: negativeRegion.manifestPath, archivePath: negativeRegion.archive })
  assert.equal(negativeRegion.witnessRegionPath, 'server/world/r.-2.-2.mca')
  assert.equal(negativeRegionResult.report.requiredWitnessRegionPath, negativeRegion.witnessRegionPath)
  assert.ok(negativeRegionResult.report.requiredValidatorPaths.includes(negativeRegion.witnessRegionPath))
  assert.equal(negativeRegionResult.report.checks.find((entry) => entry.id === 'required:world-witness-region')?.status, 'PASS')
  assert.equal(negativeRegionResult.report.packageStatus, 'READY_FOR_VALIDATION')

  const missingWitnessRegion = makeFixture(join(tempRoot, 'missing-witness-region'), { witnessPosition: { x: 35, y: 64, z: 0 } })
  const manifestWithoutWitness = JSON.parse(readFileSync(missingWitnessRegion.manifestPath, 'utf8'))
  delete manifestWithoutWitness.files[missingWitnessRegion.witnessRegionPath]
  writeJson(missingWitnessRegion.manifestPath, manifestWithoutWitness)
  const missingWitnessResult = packageVtrReachArchive({ collectorReportPath: missingWitnessRegion.collectorPath, manifestPath: missingWitnessRegion.manifestPath, archivePath: missingWitnessRegion.archive })
  assert.equal(missingWitnessRegion.witnessRegionPath, 'server/world/r.0.0.mca')
  assert.equal(missingWitnessResult.report.requiredWitnessRegionPath, missingWitnessRegion.witnessRegionPath)
  assert.ok(missingWitnessResult.report.requiredValidatorPaths.includes(missingWitnessRegion.witnessRegionPath))
  assert.equal(missingWitnessResult.report.checks.find((entry) => entry.id === 'required:world-witness-region')?.status, 'INCOMPLETE')
  assert.equal(missingWitnessResult.report.packageStatus, 'INCOMPLETE', 'omitting the committed witness region must still fail closed')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

process.stdout.write('VTR Reach archive packaging tests passed (9 cases)\n')
