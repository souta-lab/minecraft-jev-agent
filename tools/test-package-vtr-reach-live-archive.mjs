#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { packageVtrReachArchive } from './package-vtr-reach-live-archive.mjs'
import { classifyProviderActivity } from './capture-vtr-provider-activity.mjs'
import { validateEvidenceArchive } from './validate-vtr-reach-evidence.mjs'

const SOURCE = 'a'.repeat(40)
const RUN = 'run-vtrabc123-archive'
const GENERATION = 'gen-vtr-archive-xyz789'
const WORLD = '127.0.0.1:25565|overworld|4'
const TRANSITION = 'transition-vtr-archive-1'
// The committed contract hash must be the real v2 fingerprint so the
// validator's contract-content re-hash binds honest fixture archives too.
const reachCanonicalJson = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(reachCanonicalJson).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${reachCanonicalJson(value[key])}`).join(',')}}`
}
const reachFingerprint = (value) => createHash('sha256').update(reachCanonicalJson(value)).digest('hex')
const MISSION = { kind: 'inventory_at_least', item: 'oak_log', count: 1 }
const START = Date.parse('2026-09-25T04:00:00.000Z')
const iso = (offset) => new Date(START + offset).toISOString()
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')

function event(offset, name, detail, message = `${name} transitionId=${TRANSITION}`) {
  return { record: 'agent-event', ts: iso(offset), source: 'vtr', message, detail }
}

function regionPathForWitness(position) {
  const chunkX = Math.floor(position.x / 16)
  const chunkZ = Math.floor(position.z / 16)
  const regionX = Math.floor(chunkX / 32)
  const regionZ = Math.floor(chunkZ / 32)
  return `server/world/region/r.${regionX}.${regionZ}.mca`
}

function makeFixture(root, { omitProvider = null, addCapture = true, omitLifecycle = false, omitEgress = false, omitFixtureSource = false, omitFreshAttestation = false, staleFreshAttestation = false, oldFreshPhraseOnly = false, tamperFreshArtifactHash = false, externalAttempt = false, tamperEgress = false, duplicateGuardProcess = false, egressCloseOffset = 49, tamperFixtureSourceHash = false, badFixtureObservation = false, badLifecycleObservation = false, omitStopObservations = false, wrongServerIdentity = false, captureStartsLate = false, nonzeroActivity = false, localFallbackDecision = false, deprecatedModelCallsPerMechanicalStep = 0, witnessPosition = { x: 4, y: 64, z: 4 } } = {}) {
  // The runner derives the committed witness as floor(anchorPosition + {16,0,2}),
  // so synthesize the frozen spawn that produces the requested witness block.
  const spawn = { x: witnessPosition.x - 15.5, y: witnessPosition.y, z: witnessPosition.z - 1.5 }
  const derivedBlock = (offset) => ({ x: Math.floor(spawn.x + offset.x), y: Math.floor(spawn.y + offset.y), z: Math.floor(spawn.z + offset.z) })
  const fillFrom = derivedBlock({ x: 1, y: -1, z: -3 })
  const fillTo = derivedBlock({ x: 24, y: -1, z: 3 })
  const fillBlockCount = (fillTo.x - fillFrom.x + 1) * (fillTo.y - fillFrom.y + 1) * (fillTo.z - fillFrom.z + 1)
  const anchorSnapshot = {
    schema: 'vtr-reach-initial-snapshot/v1', sourceSha: SOURCE, bootSourceSha: SOURCE,
    runId: RUN, generationId: null, worldKey: WORLD, worldEpoch: 4,
    capturedAt: iso(3), initialInventory: {}, initialPosition: spawn,
  }
  const anchorBytes = Buffer.from(`${JSON.stringify(anchorSnapshot, null, 2)}\n`)
  const fixtureAnchor = {
    schema: 'vtr-reach-fixture-anchor/v1', sourceSha: SOURCE, runId: RUN,
    generationId: null, leaseId: null, worldKey: WORLD, worldEpoch: 4,
    snapshotPath: 'runner/fixture-anchor-snapshot.json', snapshotSha256: digest(anchorBytes),
    positionSource: 'runner/fixture-anchor-snapshot.json.initialPosition', initialPosition: spawn,
    coordinateRule: 'floor(position + integer offset)',
    offsets: { fillFrom: { x: 1, y: -1, z: -3 }, fillTo: { x: 24, y: -1, z: 3 }, witness: { x: 16, y: 0, z: 2 } },
  }
  const fillCommand = `fill ${fillFrom.x} ${fillFrom.y} ${fillFrom.z} ${fillTo.x} ${fillTo.y} ${fillTo.z} minecraft:stone`
  const setblockCommand = `setblock ${witnessPosition.x} ${witnessPosition.y} ${witnessPosition.z} minecraft:oak_log`
  const fillOutput = `[03:00:03 INFO]: Successfully filled ${fillBlockCount} block(s)`
  const setblockOutput = `[03:00:04 INFO]: Changed the block at ${witnessPosition.x}, ${witnessPosition.y}, ${witnessPosition.z}`
  const fixtureCommandRow = (kind, command, serverOutput, issuedAt, acknowledgedAt, observedAt, responseSequence) => ({
    schema: 'vtr-reach-fixture-command/v2', kind, sourceSha: SOURCE, runId: RUN,
    generationId: null, leaseId: null, worldKey: WORLD, serverId: '127.0.0.1:25565',
    serverPid: 502, phase: 'resident-frozen-before-generation-ready', fixtureAnchor,
    issuedAt, stdinAcknowledgedAt: acknowledgedAt, command,
    commandSha256: digest(Buffer.from(command)), serverOutput, observedAt,
    responsePid: 502, responseSequence,
  })
  const fixtureCommandRows = [
    fixtureCommandRow('fill', fillCommand, fillOutput, iso(3), iso(3.1), iso(3.2), 3),
    fixtureCommandRow('setblock', setblockCommand, setblockOutput, iso(3.5), iso(3.6), iso(3.7), 4),
  ]
  const inputDir = join(root, 'captured')
  const extraDir = join(root, 'extra')
  const archive = join(root, 'archive')
  const bundle = Buffer.from('generation-bundle fixture bytes\n')
  const buildHash = digest(bundle).slice(0, 12)
  const worldObject = { serverId: '127.0.0.1:25565', dimension: 'minecraft:overworld', worldEpoch: 4 }
  const desiredPredicate = {
    id: 'reach.oak-log',
    proposition: { kind: 'within-interaction-reach-of-resource-source', item: 'oak_log', sourceNames: ['oak_log'], interactionReach: 5 },
    expected: true,
  }
  const identity = { worldKey: WORLD, dimension: 'overworld', worldEpoch: 4, generationId: GENERATION, leaseId: GENERATION }
  const contractBudget = { maxMechanicalSteps: 4, maxElapsedMs: 10000, resources: {}, risk: {} }
  const contractController = { allowedTactics: ['walk', 'replan'] }
  const contractProgress = { kind: 'verified-distance-reduction' }
  const contractSemantic = {
    schema: 'vtr.reach.contract.v2',
    transitionId: TRANSITION, desiredPredicate, requires: [], ensures: [desiredPredicate], invariants: [],
    admissibleEffects: [], budget: contractBudget, controller: contractController,
    progressDefinition: contractProgress, identity,
  }
  const CONTRACT = reachFingerprint(contractSemantic)
  const DESIRED_PREDICATE_IDENTITY = reachFingerprint(desiredPredicate)
  const ENSURES_IDENTITY = reachFingerprint([desiredPredicate])
  const commit = event(10, 'VTR_TRANSITION_COMMIT', {
    transitionId: TRANSITION,
    contractHash: CONTRACT,
    desiredPredicateIdentity: DESIRED_PREDICATE_IDENTITY,
    ensuresIdentity: ENSURES_IDENTITY,
    identity,
    mission: MISSION,
    desiredPredicate,
    requires: [],
    ensures: [desiredPredicate],
    invariants: [],
    admissibleEffects: [],
    budget: contractBudget,
    controller: contractController,
    progressDefinition: contractProgress,
    witness: { target: witnessPosition, witnessId: 'oak-log-witness' },
  })
  const actionId = 'MOVE:b4_64_4'
  const commitmentId = 'commitment-archive-reach'
  const verify = event(40, 'VTR_TRANSITION_VERIFY', {
    transitionId: TRANSITION,
    contractHash: CONTRACT,
    verification: {
      truth: 'TRUE', evidenceIds: ['verify:40:oak_log'], verifiedAtMs: START + 40,
      observedAtMs: START + 40, runId: RUN, generationId: GENERATION, leaseId: GENERATION,
      sourceSha: SOURCE, worldKey: WORLD, worldEpoch: 4, dimension: 'overworld',
    },
  })
  const terminal = event(41, 'VTR_TRANSITION_OUTCOME', {
    transitionId: TRANSITION, contractHash: CONTRACT,
    outcome: { kind: 'SUCCESS', contractHash: CONTRACT, evidenceIds: ['verify:40:oak_log'], desiredPredicateIdentity: 'predicate:reach.oak-log', verifiedAtMs: START + 40 },
    boundary: 'verified-terminal',
    usage: { mechanicalSteps: 4, elapsedMs: 400, resources: {}, risk: {}, effects: {} },
    jevCalls: localFallbackDecision ? 1 : 0,
    system2Calls: 0,
    metrics: { typedTerminalOutcome: 'SUCCESS', mechanicalStepsPerTransition: 4, jevCallsPerTransition: localFallbackDecision ? 1 : 0,
      system2CallsPerTransition: 0, modelCallsPerMechanicalStep: deprecatedModelCallsPerMechanicalStep,
      duplicateAuthority: false, duplicateAuthorityConflicts: 0, concurrentLegacyActuations: 0 },
  })
  const events = [commit,
    event(11, 'VTR_TRANSITION_ACTUATION', { transitionId: TRANSITION, authority: 'vtr_transition', contractHash: CONTRACT, actionId }),
    event(12, 'SKILL_START', { actionId, commitmentId, selectedBy: 'vtr-transition' }, `SKILL_START actionId=${actionId} commitmentId=${commitmentId} selectedBy=vtr-transition`)]
  for (let leg = 1; leg <= 4; leg += 1) {
    const stepId = `${actionId}#17:walk-leg-${leg}`
    const reserveAt = 12 + (leg - 1) * 5
    const outcomeAt = reserveAt + 2
    events.push(event(reserveAt, 'VTR_MECHANICAL_STEP_RESERVED', {
      transitionId: TRANSITION, contractHash: CONTRACT, stepId, actionId, commitmentId, leg,
      intentId: 'intent-archive-reach', effectKind: 'locomotion',
    }))
    events.push(event(outcomeAt, 'VTR_MECHANICAL_STEP_OUTCOME', {
      transitionId: TRANSITION, contractHash: CONTRACT, stepId, actionId, commitmentId, leg,
      intentId: 'intent-archive-reach', status: leg === 4 ? 'terminal' : 'active',
      outcome: leg === 4 ? 'SUCCESS' : 'CONTINUING', verified: leg === 4,
    }))
    if (leg < 4) events.push(event(outcomeAt + 1, 'SKILL_STEP', {
      actionId, commitmentId, leg, failure: null,
    }, `SKILL_STEP skill=walk step=walk_leg authority=MECHANICAL_CONTINUATION evidence=path worldDelta=closing commitmentId=${commitmentId} decisionEpoch=17 count=${leg}`))
  }
  events.push(event(39, 'SKILL_END', { actionId }, `SKILL_END actionId=${actionId} execution=success verification=verified outcome=SUCCESS`), verify, terminal)
  const journalSources = {
    'host-log': `[${iso(0)}] BOOT runId=${RUN} source=${SOURCE} worldKey=${JSON.stringify(worldObject)}\n[${iso(5)}] GENERATION_READY runId=${RUN} generationId=${GENERATION} sourceSha=${SOURCE} buildHash=${buildHash}\n[${iso(48)}] SHUTDOWN runId=${RUN} generationId=${GENERATION} sourceSha=${SOURCE}\n`,
    'run-journal': events.map((row) => JSON.stringify(row)).join('\n') + '\n',
    'jev-calls': nonzeroActivity
      ? `${JSON.stringify({ record: 'jev-call', callId: 'call-live', policy: 'typesafe', providerAttempts: 1 })}\n`
      : localFallbackDecision
        ? `${JSON.stringify({ record: 'jev-call', callId: 'call-local', policy: 'fallback', model: 'deterministic-local-fallback', providerAttempts: 0 })}\n`
        : '',
    'jev-decisions': localFallbackDecision ? `${JSON.stringify({ decisionId: 'decision-local', callId: 'call-local' })}\n` : '',
    'system2-journal': '',
    'mercury-calls': '',
  }
  writeFixtureFile(inputDir, 'host.log', journalSources['host-log'])
  writeFixtureFile(inputDir, 'run.jsonl', journalSources['run-journal'])
  writeFixtureFile(inputDir, 'jev-calls.jsonl', journalSources['jev-calls'])
  writeFixtureFile(inputDir, 'jev-decisions.jsonl', journalSources['jev-decisions'])
  writeFixtureFile(inputDir, 'system2.jsonl', journalSources['system2-journal'])
  writeFixtureFile(inputDir, 'mercury-calls.jsonl', journalSources['mercury-calls'])

  const inputNames = {
    'host-log': 'host.log',
    'run-journal': 'run.jsonl',
    'jev-calls': 'jev-calls.jsonl',
    'jev-decisions': 'jev-decisions.jsonl',
    'system2-journal': 'system2.jsonl',
    'mercury-calls': 'mercury-calls.jsonl',
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
    capturedAt: iso(42),
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
        metrics: { jevCallsPerTransition: localFallbackDecision ? 1 : 0, system2CallsPerTransition: 0,
          providerEvaluateAttemptsIncludingRetries: nonzeroActivity ? 1 : 0,
          mechanicalStepsPerTransition: 4, modelCallsPerMechanicalStep: deprecatedModelCallsPerMechanicalStep,
          duplicateAuthority: false, duplicateAuthorityConflicts: 0 },
      },
    },
    captureWindow: { startedAt: iso(-5), endedAt: iso(55), sampleCount: 12 },
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
      startedAt: iso(0), generationReadyAt: iso(5), shutdownAt: iso(48),
      finalPosition: { x: spawn.x + 1, y: spawn.y, z: spawn.z + 1 },
    },
    mission: { ...MISSION, initialInventory: {}, finalInventory: {}, initialPosition: spawn, finalPosition: { x: spawn.x + 1, y: spawn.y, z: spawn.z + 1 } },
    fixture: { block: 'oak_log', position: witnessPosition, transitionStartPosition: spawn },
    configuredNoLlmProbe: {
      fallback: { fallbackPolicyWasExplicitlyConfigured: true, silentFallbackOnProviderFailure: false, JevDecisionInvoked: false },
    },
  }
  const launchProperties = 'server-ip=127.0.0.1\nserver-port=25565\nlevel-name=vtr-reach-live\ngamemode=survival\ndifficulty=normal\nlevel-seed=\n'
  const effectiveProperties = launchProperties
  const serverSpawnedAt = iso(-1)
  const attemptRootAbsolute = join(extraDir, 'attempt', RUN)
  const worldRootAbsolute = join(attemptRootAbsolute, 'vtr-reach-live')
  const serverConfigPath = join(extraDir, 'server.properties.launch')
  const serverConfigArg = 'server.properties.launch'
  const serverJarBytes = Buffer.from('Leaf jar fixture bytes')
  const serverJarPath = join(extraDir, 'server.jar')
  writeFixtureFile(extraDir, 'server.jar', serverJarBytes)
  const actualServerArgv = ['java', '-jar', serverJarPath, '--nogui', '--config', serverConfigArg,
    '--universe', attemptRootAbsolute, '--level-name', 'vtr-reach-live']
  const serverStart = {
    runId: RUN, generationId: GENERATION, sourceSha: SOURCE, worldKey: wrongServerIdentity ? '127.0.0.1:25566|overworld|4' : WORLD,
    levelName: 'vtr-reach-live', minecraftVersion: '1.21.4', dataVersion: 4189, difficulty: 'normal', worldEpoch: 4,
    pid: 502, serverId: '127.0.0.1:25565', port: 25565, spawnedAt: serverSpawnedAt,
    process: { pid: 502, startedAt: serverSpawnedAt, cwd: extraDir, universeArg: attemptRootAbsolute,
      levelNameArg: 'vtr-reach-live', configArg: serverConfigArg, jarArg: serverJarPath,
      argv: actualServerArgv, commandLineSha256: digest(Buffer.from(actualServerArgv.join('\0'))) },
    serverPropertiesPath: serverConfigPath,
    serverPropertiesSha256: digest(Buffer.from(launchProperties)),
    serverPropertiesEffectiveSha256: digest(Buffer.from(effectiveProperties)), serverJar: serverJarPath, serverJarSha256: digest(serverJarBytes),
    spawnObservation: {
      schema: 'vtr-server-spawn-observation/v1', sourceSha: SOURCE, runId: RUN, generationId: GENERATION,
      worldKey: WORLD, serverId: '127.0.0.1:25565', port: 25565, levelName: 'vtr-reach-live',
      pid: 502, spawnedAt: serverSpawnedAt, cwd: extraDir, argv: [...actualServerArgv],
      commandLineSha256: digest(Buffer.from(actualServerArgv.join('\0'))), configPath: serverConfigPath,
      configSha256: digest(Buffer.from(launchProperties)), jarPath: serverJarPath, jarSha256: digest(serverJarBytes),
    },
  }
  const lifecycleRows = [
    { schema: 'vtr-reach-probe-lifecycle/v1', event: 'terminal-consumed', ts: iso(42), actor: 'probe-harness',
      sourceSha: SOURCE, runId: RUN, generationId: GENERATION, worldKey: WORLD,
      transitionId: TRANSITION, contractHash: CONTRACT, outcomeKind: 'SUCCESS', evidenceIds: ['verify:40:oak_log'] },
    { schema: 'vtr-reach-probe-lifecycle/v1', event: 'resident-stopped', ts: iso(49), stoppedAt: iso(49), actor: 'probe-harness',
      sourceSha: SOURCE, runId: RUN, generationId: GENERATION, worldKey: WORLD, pid: 501, status: 'stopped', exitCode: 0,
      ...(!omitStopObservations ? { processExitObservation: { schema: 'vtr-process-exit-observation/v1', source: 'child-close-event', state: 'exited', pid: 501, exitCode: 0, observedAt: iso(49) } } : {}) },
    { schema: 'vtr-reach-probe-lifecycle/v1', event: 'server-stopped', ts: iso(50), stoppedAt: iso(50), actor: 'probe-harness',
      sourceSha: SOURCE, runId: RUN, generationId: GENERATION, worldKey: WORLD, pid: 502, status: 'stopped', exitCode: 0,
      ...(!omitStopObservations ? {
        processExitObservation: { schema: 'vtr-process-exit-observation/v1', source: 'child-close-event', state: 'exited', pid: 502, exitCode: 0, observedAt: iso(49.5) },
        listenerClosureObservation: { schema: 'vtr-listener-closure-observation/v1', source: 'tcp-connect-probe', state: 'closed', host: badLifecycleObservation ? '0.0.0.0' : '127.0.0.1', port: 25565, result: 'connection-refused', observedAt: iso(50) },
      } : {}) },
  ]
  const lifecycleText = lifecycleRows.map((row) => JSON.stringify(row)).join('\n') + '\n'
  const playerDataArchivePath = `server/world/playerdata/${runMetadata.run.botUuid}.dat`
  const worldArtifactBytes = {
    'server/world/level.dat': Buffer.from('level fixture bytes'),
    [playerDataArchivePath]: Buffer.from('player fixture bytes'),
    [regionPathForWitness(witnessPosition)]: Buffer.from('region fixture bytes'),
  }
  const worldPathChain = (sourcePath) => {
    const chain = [{ path: attemptRootAbsolute, realPath: attemptRootAbsolute, kind: 'directory', symlink: false }]
    let current = attemptRootAbsolute
    const parts = relative(attemptRootAbsolute, sourcePath).split('/').filter(Boolean)
    for (const [index, part] of parts.entries()) {
      current = join(current, part)
      const final = index === parts.length - 1
      chain.push({ path: current, realPath: current, kind: final ? 'file' : 'directory', symlink: false })
    }
    return chain
  }
  const preparingLine = '[21:50:53 INFO]: Preparing level "vtr-reach-live"'
  const doneLine = '[21:51:02 INFO]: Done (5.0s)! For help, type "help"'
  const stdoutReceipt = (sequence, receivedAt, line) => ({ schema: 'vtr-server-stdout-observation/v1', sourceSha: SOURCE,
    runId: RUN, generationId: null, worldKey: WORLD, serverId: '127.0.0.1:25565', serverPid: 502, port: 25565, levelName: 'vtr-reach-live', sequence,
    receivedAt, monotonicNs: String(BigInt(sequence) * 1000000n), lineSha256: digest(Buffer.from(line)),
    rawLineSha256: digest(Buffer.from(line)),
    streamSource: 'spawned-server-stdout', line })
  const stdoutRows = oldFreshPhraseOnly ? [
    stdoutReceipt(1, iso(1), 'No existing world data, creating new world'),
  ] : [
    stdoutReceipt(1, iso(1), preparingLine),
    stdoutReceipt(2, iso(2), doneLine),
    stdoutReceipt(3, iso(3.2), fillOutput),
    stdoutReceipt(4, iso(3.7), setblockOutput),
  ]
  const freshWorldAttestation = {
    schema: 'vtr-fresh-world-attestation/v1',
    sourceSha: SOURCE, runId: RUN, serverId: '127.0.0.1:25565', port: 25565, levelName: 'vtr-reach-live',
    server: { pid: 502, spawnedAt: serverSpawnedAt, serverId: '127.0.0.1:25565', port: 25565,
      levelName: 'vtr-reach-live', minecraftVersion: '1.21.4', dataVersion: 4189,
      jarPath: serverJarPath, jarSha256: digest(serverJarBytes) },
    worldRoot: { absolute: worldRootAbsolute, attemptRoot: attemptRootAbsolute, archivePath: 'server/world', uniqueForRun: RUN },
    preStartObservation: { sourceSha: SOURCE, runId: RUN, serverPid: 502, serverId: '127.0.0.1:25565', port: 25565,
      levelName: 'vtr-reach-live', observedAt: iso(-2), state: 'absent', entries: [], path: worldRootAbsolute,
      levelDat: { state: 'absent', path: join(worldRootAbsolute, 'level.dat') },
      levelDatOld: { state: 'absent', path: join(worldRootAbsolute, 'level.dat_old') } },
    configuration: { launchPropertiesSha256: digest(Buffer.from(launchProperties)), effectivePropertiesSha256: digest(Buffer.from(effectiveProperties)) },
    startupLog: { pid: 502, streamSource: 'spawned-server-stdout',
      preparing: { line: preparingLine, sequence: 1, ts: iso(1), lineSha256: digest(Buffer.from(preparingLine)) },
      done: { line: doneLine, sequence: 2, ts: iso(2), lineSha256: digest(Buffer.from(doneLine)) } },
    postRunObservation: { observedAt: iso(51), files: Object.entries(worldArtifactBytes).map(([archivePath, bytes]) => {
      const sourcePath = join(worldRootAbsolute, archivePath.slice('server/world/'.length))
      return {
      archivePath, sourcePath, realPath: sourcePath, capturedAt: iso(51),
      sourceSha: SOURCE, runId: RUN, generationId: GENERATION, worldKey: WORLD,
      serverId: '127.0.0.1:25565', serverPid: 502, port: 25565, levelName: 'vtr-reach-live',
      pathChain: worldPathChain(sourcePath), bytes: bytes.length,
      sha256: tamperFreshArtifactHash && archivePath.endsWith('level.dat') ? 'f'.repeat(64) : digest(bytes),
      }
    }) },
  }
  if (staleFreshAttestation) freshWorldAttestation.preStartObservation.levelDat.state = 'present'
  if (oldFreshPhraseOnly) freshWorldAttestation.startupLog.done.line = 'No existing world data, creating new world'
  const egressHashes = { toolSha256: '1'.repeat(64), sourceSha256: '2'.repeat(64), librarySha256: '3'.repeat(64), policySha256: '4'.repeat(64) }
  const egressRows = [
    { schema: 'vtr-no-llm-egress-audit/v1', event: 'guard_loaded', utc: iso(1), monotonicClock: 'CLOCK_MONOTONIC',
      monotonicNs: '1000000', pid: tamperEgress ? 599 : 501, processStartTicks: 1001, processGroupId: 501, reason: 'preload-active', ...egressHashes },
    { schema: 'vtr-no-llm-egress-audit/v1', event: 'guard_loaded', utc: iso(6), monotonicClock: 'CLOCK_MONOTONIC',
      monotonicNs: '6000000', pid: duplicateGuardProcess ? 501 : 503,
      processStartTicks: duplicateGuardProcess ? 1001 : 1003, processGroupId: 501, reason: 'preload-active', ...egressHashes },
  ]
  if (externalAttempt) egressRows.push({ schema: 'vtr-no-llm-egress-audit/v1', event: 'blocked_egress', utc: iso(20),
    monotonicClock: 'CLOCK_MONOTONIC', monotonicNs: '20000000', pid: 503, processStartTicks: 1003, processGroupId: 501, tid: 501,
    operation: 'connect', family: 'AF_INET', address: '203.0.113.7', port: 443, errno: 'EACCES' })
  egressRows.push({ schema: 'vtr-no-llm-egress-audit/v1', event: 'guard_wrapper_closed', utc: iso(egressCloseOffset),
    monotonicClock: 'process.hrtime.relative', monotonicNs: `${Math.trunc(egressCloseOffset * 1000000)}`, pid: 500, childPid: 501, processGroupId: 501, commandName: 'bun',
    childExitCode: 0, childSignal: null, preloadVerified: true, processGroupGone: true,
    coverageClass: 'user-space-libc-interposition', coverageStatus: 'USERSPACE_ONLY_CLOSED',
    externalDeniedAttempts: externalAttempt ? 1 : 0, guardLoadedRows: 2, ...egressHashes,
    auditPathIdentityVerified: true, auditDevice: '1', auditInode: '99',
    coverage: 'root-process-load-verified; observed-exec-descendants-reopened-same-audit-inode; process-group-signaled-at-close; syscall-bypass-not-covered' })
  const egressText = egressRows.map((row) => JSON.stringify(row)).join('\n') + '\n'
  const authorityFixtureSourceBytes = Buffer.from('actual exact-source authority fixture test bytes\n')
  const authorityFixtureReport = {
    schema: 'vtr-reach-no-double-authority-fixture/v1',
    result: 'PASS',
    sourceSha: SOURCE,
    test: {
      path: 'packages/jev-agent/test-vtr-reach-executor-dispatch-authority.mts',
      name: 'production Reach dispatch and legacy Executor claim cannot overlap body authority',
      sourceSha256: tamperFixtureSourceHash ? 'f'.repeat(64) : digest(authorityFixtureSourceBytes),
    },
    fixture: {
      legacyClaimRejected: true,
      legacyClaimError: 'ExecutionAuthorityConflict',
      vtrOwnerRetained: !badFixtureObservation,
      transitionId: 'fixture-transition-1',
      contractHash: 'e'.repeat(64),
      pathfinderStartsBeforeLegacyClaim: 1,
      pathfinderStartsAfterLegacyClaim: badFixtureObservation ? 2 : 1,
      pathfinderStartDelta: badFixtureObservation ? 1 : 0,
      authorityConflictCount: 1,
      maxConcurrentActions: 1,
    },
  }
  const files = {
    'runner/run-metadata.json': writeJson(join(extraDir, 'run-metadata.json'), runMetadata),
    'runner/acceptance.json': writeJson(join(extraDir, 'acceptance.json'), { gitCommit: SOURCE, checkoutHead: SOURCE, runId: RUN, generationId: GENERATION, worldEpoch: 4, levelName: 'vtr-reach-live', seed: '4312' }),
    'runner/generation-bundle.mjs': writeFixtureFile(extraDir, 'bundle.mjs', bundle),
    'runner/initial-snapshot.json': writeJson(join(extraDir, 'initial-snapshot.json'), { ...anchorSnapshot, generationId: GENERATION, buildHash }),
    'runner/fixture-anchor-snapshot.json': writeFixtureFile(extraDir, 'fixture-anchor-snapshot.json', anchorBytes),
    'runner/final-snapshot.json': writeJson(join(extraDir, 'final-snapshot.json'), { runId: RUN, generationId: GENERATION, sourceSha: SOURCE, worldEpoch: 4, finalInventory: {} }),
    'runner/milestone-predicates.json': writeJson(join(extraDir, 'milestone-predicates.json'), { runId: RUN, generationId: GENERATION, sourceSha: SOURCE, worldEpoch: 4 }),
    'runner/mercury-calls.jsonl': writeFixtureFile(extraDir, 'mercury-calls.jsonl', journalSources['mercury-calls']),
    'runner/host-lifecycle.jsonl': writeFixtureFile(extraDir, 'host-lifecycle.jsonl', lifecycleText),
    'runner/no-llm-egress-audit.json': writeFixtureFile(extraDir, 'no-llm-egress-audit.json', egressText),
    'proofs/no-double-authority-fixture.json': writeJson(join(extraDir, 'no-double-authority-fixture.json'), authorityFixtureReport),
    'runner/fixtures/test-vtr-reach-executor-dispatch-authority.mts': writeFixtureFile(extraDir, 'test-vtr-reach-executor-dispatch-authority.mts', authorityFixtureSourceBytes),
    'server/fixture-commands.jsonl': writeFixtureFile(extraDir, 'fixture-commands.jsonl', `${fixtureCommandRows.map((row) => JSON.stringify(row)).join('\n')}\n`),
    'server/leaf-latest.log': writeFixtureFile(extraDir, 'leaf.log', oldFreshPhraseOnly
      ? 'Starting minecraft server version 1.21.4\nNo existing world data, creating new world\nUUID of player AI_Buddy is 00000000-0000-0000-0000-000000000001\n'
      : `Starting minecraft server version 1.21.4\n${preparingLine}\n${doneLine}\nUUID of player AI_Buddy is 00000000-0000-0000-0000-000000000001\n`),
    'server/leaf-stdout-events.jsonl': writeFixtureFile(extraDir, 'leaf-stdout-events.jsonl', `${stdoutRows.map((row) => JSON.stringify(row)).join('\n')}\n`),
    'server/server-start.json': writeJson(join(extraDir, 'server-start.json'), serverStart),
    'server/server.properties.launch': writeFixtureFile(extraDir, 'server.properties.launch', launchProperties),
    'server/server.properties.effective-after-boot': writeFixtureFile(extraDir, 'server.properties.effective-after-boot', effectiveProperties),
    'server/fresh-world-attestation.json': writeJson(join(extraDir, 'fresh-world-attestation.json'), freshWorldAttestation),
    'server/world/level.dat': writeFixtureFile(worldRootAbsolute, 'level.dat', worldArtifactBytes['server/world/level.dat']),
    [playerDataArchivePath]: writeFixtureFile(join(worldRootAbsolute, 'playerdata'), `${runMetadata.run.botUuid}.dat`, worldArtifactBytes[playerDataArchivePath]),
    [regionPathForWitness(witnessPosition)]: writeFixtureFile(join(worldRootAbsolute, 'region'), regionPathForWitness(witnessPosition).split('/').at(-1), worldArtifactBytes[regionPathForWitness(witnessPosition)]),
  }

  if (addCapture) {
    const providerJournalRows = {
      'jev-calls': journalSources['jev-calls'].trim() === '' ? [] : [JSON.parse(journalSources['jev-calls'].trim())],
      'jev-decisions': journalSources['jev-decisions'].trim() === '' ? [] : [JSON.parse(journalSources['jev-decisions'].trim())],
      'system2-journal': [],
      'mercury-calls': [],
    }
    const activityClassification = classifyProviderActivity(providerJournalRows)
    const capture = {
      schema: 'vtr-provider-activity-capture/v2', status: nonzeroActivity ? 'FAIL' : 'OBSERVED',
      identity: { sourceSha: SOURCE, runId: RUN, generationId: GENERATION, worldKey: worldObject },
      window: { startedAt: iso(captureStartsLate ? 6 : -5), bootAt: iso(0), generationReadyAt: iso(5), terminalAt: iso(41),
        terminalConsumedAt: iso(42), shutdownAt: iso(48), residentStoppedAt: iso(49), serverStoppedAt: iso(50),
        endedAt: iso(55), coverageComplete: true, lifecycleComplete: true },
      activity: {
        ...activityClassification.decisions,
        ...activityClassification.providers,
      },
      activityClassification,
      capture: { observedNonEmptyJournal: Object.values(journalSources).some((value) => value.length > 0), observedProviderActivity: nonzeroActivity, problems: [] },
      journals: Object.fromEntries(PROVIDER_JOURNALS.map((name) => {
        const source = journalSources[name]
        return [name, {
          bytes: Buffer.byteLength(source), sha256: digest(Buffer.from(source)),
          rows: providerJournalRows[name].length, malformedRows: 0,
          initializedAt: iso(-5), firstObservedAt: iso(captureStartsLate ? 6 : -5), closedAt: iso(55),
        }]
      })),
      lifecycle: { status: 'OBSERVED', bytes: Buffer.byteLength(lifecycleText), sha256: digest(Buffer.from(lifecycleText)),
        rows: lifecycleRows.length, malformedRows: 0, problems: [], firstObservedAt: iso(captureStartsLate ? 6 : -5), closedAt: iso(55),
        events: { terminalConsumed: lifecycleRows[0], residentStopped: lifecycleRows[1], serverStopped: lifecycleRows[2] } },
    }
    files['runner/provider-activity-capture.json'] = writeJson(join(extraDir, 'provider-activity-capture.json'), capture)
  }
  if (omitLifecycle) delete files['runner/host-lifecycle.jsonl']
  if (omitEgress) delete files['runner/no-llm-egress-audit.json']
  if (omitFixtureSource) delete files['runner/fixtures/test-vtr-reach-executor-dispatch-authority.mts']
  if (omitFreshAttestation) delete files['server/fresh-world-attestation.json']
  for (const [archivePath, sourcePath] of Object.entries(files)) files[archivePath] = sourcePath
  const manifestPath = join(root, 'manifest.json')
  writeJson(manifestPath, { schema: 'vtr-reach-live-archive-input/v1', files })
  return { collectorPath, manifestPath, archive, collectorReport, files, witnessRegionPath: regionPathForWitness(witnessPosition) }
}

const PROVIDER_JOURNALS = ['jev-calls', 'jev-decisions', 'system2-journal', 'mercury-calls']

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

function makeOriginMainRepo(root) {
  const repo = join(root, 'origin-main-repo')
  mkdirSync(repo, { recursive: true })
  execFileSync('git', ['init', '-q', repo])
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid'])
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test'])
  writeFileSync(join(repo, 'source.txt'), 'baseline pin\n')
  execFileSync('git', ['-C', repo, 'add', 'source.txt'])
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'baseline pin'])
  const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  execFileSync('git', ['-C', repo, 'update-ref', 'refs/remotes/origin/main', head])
  return { repo, head }
}

function rehashArchiveFile(archive, relativePath) {
  const sumsPath = join(archive, 'SHA256SUMS')
  const rows = readFileSync(sumsPath, 'utf8').trim().split('\n')
  const nextHash = digest(readFileSync(join(archive, relativePath)))
  let found = false
  const next = rows.map((row) => {
    const suffix = `  ${relativePath}`
    if (!row.endsWith(suffix)) return row
    found = true
    return `${nextHash}${suffix}`
  })
  assert.equal(found, true, `SHA256SUMS binds ${relativePath}`)
  writeFileSync(sumsPath, `${next.join('\n')}\n`)
}

function mutateMappedJson(fixture, archivePath, mutate) {
  const sourcePath = fixture.files[archivePath]
  assert.equal(typeof sourcePath, 'string', `mapped source exists for ${archivePath}`)
  const document = JSON.parse(readFileSync(sourcePath, 'utf8'))
  mutate(document)
  writeJson(sourcePath, document)
}

function mutateMappedJsonl(fixture, archivePath, mutate) {
  const sourcePath = fixture.files[archivePath]
  assert.equal(typeof sourcePath, 'string', `mapped source exists for ${archivePath}`)
  const rows = readFileSync(sourcePath, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  mutate(rows)
  writeFileSync(sourcePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
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
  assert.equal(complete.witnessRegionPath, 'server/world/region/r.0.0.mca')
  assert.equal(existsSync(join(complete.archive, 'server/world/region/r.-1.0.mca')), false, 'a positive witness does not require the former fixed negative-region path')
  assert.equal(packagedProbe.configuredNoLlmProbe.networkModelCalls, 0)
  assert.equal(packagedProbe.egressAudit.status, 'OBSERVED_ZERO')
  assert.equal(packagedProbe.egressAudit.coverageStatus, 'USERSPACE_ONLY_CLOSED')
  assert.equal(packagedProbe.egressAudit.guardLoadedRows, 2, 'descendant guard activity remains bound after GENERATION_READY')
  assert.ok(packagedProbe.egressAudit.limitations.some((limitation) => limitation.includes('no kernel isolation claim')))
  assert.equal(completeResult.report.freshWorld.status, 'PASS')
  assert.equal(packagedProbe.noDoubleAuthorityFixture.status, 'PASS')
  assert.equal(packagedProbe.noDoubleAuthorityFixture.fixture.pathfinderStartDelta, 0)
  assert.equal(packagedProbe.noDoubleAuthorityFixture.fixture.authorityConflictCount, 1,
    'fixture refusal conflict remains separate from the live run duplicate-authority zero')
  const noDoubleAuthority = JSON.parse(readFileSync(join(complete.archive, 'proofs/no-double-authority.json'), 'utf8'))
  assert.equal(noDoubleAuthority.result, 'PASS')
  assert.equal(noDoubleAuthority.vtrActuationCount, 1)
  assert.equal(noDoubleAuthority.legacyActuationCount, 0)
  assert.equal(noDoubleAuthority.duplicateAuthority, false)
  for (const [name, filename] of [['jev-calls', 'jev-calls.jsonl'], ['jev-decisions', 'jev-decisions.jsonl'], ['system2-journal', 'system2.jsonl'], ['mercury-calls', 'mercury-calls.jsonl']]) {
    assert.equal(readFileSync(join(complete.archive, `runner/${filename}`), 'utf8'), '', `empty captured journal ${name} is preserved`)
  }

  const crossRun = makeFixture(join(tempRoot, 'cross-run-comparison'))
  const origin = makeOriginMainRepo(join(tempRoot, 'cross-run-comparison'))
  const foreignComparison = {
    schema: 'vtr-reach-fixture-comparison/v3',
    comparisonStatus: 'INCOMPLETE', acceptanceEligible: false, acceptanceStatus: 'RAW_EVIDENCE_INCOMPLETE',
    evidenceClass: 'summary-only',
    alignment: { missionInput: 'INCOMPLETE', fixture: 'INCOMPLETE', environment: 'INCOMPLETE' },
    lineage: {
      legacy: { sourceSha: origin.head, recordedOriginMainSha: origin.head, runId: 'run-old-a1', generationId: 'gen-old-a1', buildHash: 'old-build' },
      vtr: { sourceSha: SOURCE, runId: RUN, generationId: GENERATION, buildHash: crossRun.collectorReport.observed.generationReady.buildHash, worldKey: WORLD },
    },
    rawComparisonEvidence: { status: 'INCOMPLETE' },
  }
  const comparisonSource = writeJson(join(tempRoot, 'cross-run-comparison', 'comparison.json'), foreignComparison)
  const crossRunManifest = JSON.parse(readFileSync(crossRun.manifestPath, 'utf8'))
  crossRunManifest.files['comparison/legacy-baseline.json'] = comparisonSource
  writeJson(crossRun.manifestPath, crossRunManifest)
  const crossRunResult = packageVtrReachArchive({ collectorReportPath: crossRun.collectorPath, manifestPath: crossRun.manifestPath,
    archivePath: crossRun.archive, repoPath: origin.repo })
  assert.equal(crossRunResult.report.packageStatus, 'INCOMPLETE')
  assert.equal(crossRunResult.report.legacyBaselineComparison.status, 'INCOMPLETE')
  assert.ok(crossRunResult.report.checks.some((entry) => entry.id === 'comparison:legacy-baseline' && entry.status === 'INCOMPLETE'))
  assert.equal(crossRunResult.report.checks.some((entry) => entry.id === 'identity:comparison/legacy-baseline.json'), false,
    'only the validated cross-run comparison path bypasses single-run identity matching')

  const arbitraryCrossRun = makeFixture(join(tempRoot, 'arbitrary-cross-run'))
  const arbitraryManifest = JSON.parse(readFileSync(arbitraryCrossRun.manifestPath, 'utf8'))
  arbitraryManifest.files['comparison/other.json'] = comparisonSource
  writeJson(arbitraryCrossRun.manifestPath, arbitraryManifest)
  const arbitraryResult = packageVtrReachArchive({ collectorReportPath: arbitraryCrossRun.collectorPath, manifestPath: arbitraryCrossRun.manifestPath, archivePath: arbitraryCrossRun.archive })
  assert.equal(arbitraryResult.report.packageStatus, 'FAIL')
  assert.ok(arbitraryResult.report.checks.some((entry) => entry.id === 'identity:comparison/other.json' && entry.status === 'FAIL'),
    'foreign run identities remain forbidden everywhere else')
  const hashLines = readFileSync(join(complete.archive, 'SHA256SUMS'), 'utf8').trim().split('\n')
  assert.ok(hashLines.some((line) => line.endsWith('  probe.json')))
  assert.ok(hashLines.some((line) => line.endsWith('  packaging-report.json')))
  assert.ok(hashLines.some((line) => line.endsWith('  runner/mercury-calls.jsonl')))

  const localFallback = makeFixture(join(tempRoot, 'local-fallback'), { localFallbackDecision: true, deprecatedModelCallsPerMechanicalStep: 1 })
  const localFallbackResult = packageVtrReachArchive({ collectorReportPath: localFallback.collectorPath, manifestPath: localFallback.manifestPath, archivePath: localFallback.archive })
  assert.equal(localFallbackResult.report.packageStatus, 'READY_FOR_VALIDATION', JSON.stringify(localFallbackResult.report.checks, null, 2))
  assert.equal(localFallbackResult.report.providerActivity.status, 'OBSERVED_ZERO')
  const localFallbackProbe = JSON.parse(readFileSync(join(localFallback.archive, 'probe.json'), 'utf8'))
  assert.equal(localFallbackProbe.configuredNoLlmProbe.networkModelCalls, 0)
  assert.equal(localFallbackProbe.configuredNoLlmProbe.effectiveJev.decisionCalls, 1)
  assert.equal(localFallbackProbe.configuredNoLlmProbe.effectiveJev.providerEvaluateAttempts, 0)
  assert.equal(localFallbackProbe.configuredNoLlmProbe.providerEvaluateAttemptsPerMechanicalStep, 0)
  assert.equal(localFallbackProbe.configuredNoLlmProbe.deprecatedModelCallsPerMechanicalStep, 1,
    'deprecated movement metric is preserved and not treated as provider evidence')
  assert.equal(localFallbackProbe.configuredNoLlmProbe.policyActivity.jevDecisionFrames, 1)
  assert.equal(localFallbackProbe.configuredNoLlmProbe.policyActivity.jevEvaluateAttempts, 0)
  const archivedFallbackCall = readFileSync(join(localFallback.archive, 'runner/jev-calls.jsonl'), 'utf8')
  assert.match(archivedFallbackCall, /"providerAttempts":0/u, 'classified local decision raw bytes remain archived')

  const noAttestation = makeFixture(join(tempRoot, 'no-attestation'), { addCapture: false })
  const noAttestationResult = packageVtrReachArchive({ collectorReportPath: noAttestation.collectorPath, manifestPath: noAttestation.manifestPath, archivePath: noAttestation.archive })
  assert.equal(noAttestationResult.report.packageStatus, 'INCOMPLETE')

  const staleFreshMessage = makeFixture(join(tempRoot, 'stale-fresh-message'), { oldFreshPhraseOnly: true })
  const staleFreshMessageResult = packageVtrReachArchive({ collectorReportPath: staleFreshMessage.collectorPath, manifestPath: staleFreshMessage.manifestPath, archivePath: staleFreshMessage.archive })
  assert.equal(staleFreshMessageResult.report.checks.find((entry) => entry.id === 'server:fresh-world-attestation')?.status, 'FAIL',
    'the old Leaf phrase cannot stand in for pre-start absence and same-PID Preparing/Done proof')

  const staleWorld = makeFixture(join(tempRoot, 'stale-world'), { staleFreshAttestation: true })
  const staleWorldResult = packageVtrReachArchive({ collectorReportPath: staleWorld.collectorPath, manifestPath: staleWorld.manifestPath, archivePath: staleWorld.archive })
  assert.equal(staleWorldResult.report.checks.find((entry) => entry.id === 'server:fresh-world-attestation')?.status, 'FAIL')

  const changedFreshArtifact = makeFixture(join(tempRoot, 'changed-fresh-artifact'), { tamperFreshArtifactHash: true })
  const changedFreshArtifactResult = packageVtrReachArchive({ collectorReportPath: changedFreshArtifact.collectorPath, manifestPath: changedFreshArtifact.manifestPath, archivePath: changedFreshArtifact.archive })
  assert.equal(changedFreshArtifactResult.report.checks.find((entry) => entry.id === 'server:fresh-world-attestation')?.status, 'FAIL')

  const oldWorldSource = makeFixture(join(tempRoot, 'old-world-source'))
  const oldWorldPath = writeFixtureFile(join(dirname(oldWorldSource.collectorPath), 'extra', 'old-world'), 'level.dat',
    readFileSync(oldWorldSource.files['server/world/level.dat']))
  const oldWorldManifest = JSON.parse(readFileSync(oldWorldSource.manifestPath, 'utf8'))
  oldWorldManifest.files['server/world/level.dat'] = oldWorldPath
  writeJson(oldWorldSource.manifestPath, oldWorldManifest)
  const oldWorldSourceResult = packageVtrReachArchive({ collectorReportPath: oldWorldSource.collectorPath, manifestPath: oldWorldSource.manifestPath, archivePath: oldWorldSource.archive })
  assert.equal(oldWorldSourceResult.report.checks.find((entry) => entry.id === 'server:fresh-world-attestation')?.status, 'FAIL',
    'an old-world manifest source cannot be legitimized by the attestation claiming the fresh world path')

  const symlinkedWorldRoot = makeFixture(join(tempRoot, 'symlinked-world-root'))
  const worldRootPath = dirname(symlinkedWorldRoot.files['server/world/level.dat'])
  const realWorldRootPath = `${worldRootPath}-real`
  renameSync(worldRootPath, realWorldRootPath)
  symlinkSync(realWorldRootPath, worldRootPath, 'dir')
  const symlinkedWorldRootResult = packageVtrReachArchive({ collectorReportPath: symlinkedWorldRoot.collectorPath, manifestPath: symlinkedWorldRoot.manifestPath, archivePath: symlinkedWorldRoot.archive })
  assert.equal(symlinkedWorldRootResult.report.checks.find((entry) => entry.id === 'server:world-source-filesystem')?.status, 'FAIL',
    'a symlinked world root is rejected even when source and attested lexical paths match')

  for (const component of ['playerdata', 'region']) {
    const symlinkedWorldChild = makeFixture(join(tempRoot, `symlinked-world-${component}`))
    const childPath = join(dirname(symlinkedWorldChild.files['server/world/level.dat']), component)
    const realChildPath = `${childPath}-real`
    renameSync(childPath, realChildPath)
    symlinkSync(realChildPath, childPath, 'dir')
    const symlinkedWorldChildResult = packageVtrReachArchive({ collectorReportPath: symlinkedWorldChild.collectorPath, manifestPath: symlinkedWorldChild.manifestPath, archivePath: symlinkedWorldChild.archive })
    assert.equal(symlinkedWorldChildResult.report.checks.find((entry) => entry.id === 'server:world-source-filesystem')?.status, 'FAIL',
      `a symlinked ${component} parent is rejected even when the final file itself is regular`)
  }

  for (const [name, mutate] of [
    ['pid', (document) => { document.server.pid = 777; document.preStartObservation.serverPid = 777 }],
    ['port', (document) => { document.server.port = 25566 }],
    ['level', (document) => { document.server.levelName = 'stale-world' }],
    ['source-path', (document) => { document.postRunObservation.files[0].sourcePath = join(dirname(document.worldRoot.absolute), 'old-world', 'level.dat') }],
    ['per-file-pre-stop', (document) => { document.postRunObservation.files[0].capturedAt = iso(49) }],
    ['per-file-symlink-claim', (document) => { document.postRunObservation.files[0].pathChain[1].symlink = true }],
    ['stdout-time', (document) => { document.startupLog.preparing.ts = iso(4) }],
    ['before-server-stop', (document) => { document.postRunObservation.observedAt = iso(49) }],
  ]) {
    const tampered = makeFixture(join(tempRoot, `fresh-${name}-tamper`))
    mutateMappedJson(tampered, 'server/fresh-world-attestation.json', mutate)
    const tamperedResult = packageVtrReachArchive({ collectorReportPath: tampered.collectorPath, manifestPath: tampered.manifestPath, archivePath: tampered.archive })
    assert.equal(tamperedResult.report.checks.find((entry) => entry.id === 'server:fresh-world-attestation')?.status, 'FAIL', `${name} tamper is rejected`)
  }

  const wrongUniverse = makeFixture(join(tempRoot, 'fresh-wrong-universe'))
  mutateMappedJson(wrongUniverse, 'server/server-start.json', (document) => {
    document.process.universeArg = join(dirname(document.process.universeArg), 'other-run-world')
    const index = document.process.argv.indexOf('--universe')
    document.process.argv[index + 1] = document.process.universeArg
    document.process.commandLineSha256 = digest(Buffer.from(document.process.argv.join('\0')))
    document.spawnObservation.argv = [...document.process.argv]
    document.spawnObservation.commandLineSha256 = document.process.commandLineSha256
  })
  const wrongUniverseResult = packageVtrReachArchive({ collectorReportPath: wrongUniverse.collectorPath, manifestPath: wrongUniverse.manifestPath, archivePath: wrongUniverse.archive })
  assert.equal(wrongUniverseResult.report.checks.find((entry) => entry.id === 'server:fresh-world-attestation')?.status, 'FAIL',
    'worldRoot must resolve from the actual server --universe and --level-name argv')

  for (const [name, mutate] of [
    ['sourceSha', (document) => { document.sourceSha = 'f'.repeat(40) }],
    ['runId', (document) => { document.runId = 'run-stale-identity' }],
    ['generationId', (document) => { document.generationId = 'gen-stale-identity' }],
    ['worldKey', (document) => { document.worldKey = '127.0.0.1:25566|overworld|4' }],
    ['spawn-pid', (document) => { document.spawnObservation.pid = 999 }],
    ['spawn-world', (document) => { document.spawnObservation.worldKey = '127.0.0.1:25566|overworld|4' }],
  ]) {
    const wrongServerStartIdentity = makeFixture(join(tempRoot, `server-start-${name}-tamper`))
    mutateMappedJson(wrongServerStartIdentity, 'server/server-start.json', mutate)
    const wrongIdentityResult = packageVtrReachArchive({ collectorReportPath: wrongServerStartIdentity.collectorPath, manifestPath: wrongServerStartIdentity.manifestPath, archivePath: wrongServerStartIdentity.archive })
    assert.equal(wrongIdentityResult.report.checks.find((entry) => entry.id === 'server:fresh-world-attestation')?.status, 'FAIL', `server-start ${name} mismatch is rejected`)
  }

  for (const [name, option] of [['universe', '--universe'], ['level-name', '--level-name'], ['config', '--config'], ['jar', '-jar']]) {
    const duplicateArg = makeFixture(join(tempRoot, `server-start-duplicate-${name}`))
    mutateMappedJson(duplicateArg, 'server/server-start.json', (document) => {
      const index = document.process.argv.indexOf(option)
      document.process.argv.splice(index + 2, 0, option, document.process.argv[index + 1])
      document.process.commandLineSha256 = digest(Buffer.from(document.process.argv.join('\0')))
      document.spawnObservation.argv = [...document.process.argv]
      document.spawnObservation.commandLineSha256 = document.process.commandLineSha256
    })
    const duplicateArgResult = packageVtrReachArchive({ collectorReportPath: duplicateArg.collectorPath, manifestPath: duplicateArg.manifestPath, archivePath: duplicateArg.archive })
    assert.equal(duplicateArgResult.report.checks.find((entry) => entry.id === 'server:fresh-world-attestation')?.status, 'FAIL',
      `duplicate actual ${option} argv is rejected`)
  }

  const alternateConfig = makeFixture(join(tempRoot, 'server-start-alternate-config'))
  mutateMappedJson(alternateConfig, 'server/server-start.json', (document) => {
    document.process.configArg = 'other.properties'
    document.process.argv[document.process.argv.indexOf('--config') + 1] = document.process.configArg
    document.process.commandLineSha256 = digest(Buffer.from(document.process.argv.join('\0')))
    document.spawnObservation.argv = [...document.process.argv]
    document.spawnObservation.commandLineSha256 = document.process.commandLineSha256
    document.spawnObservation.configPath = join(document.process.cwd, document.process.configArg)
  })
  const alternateConfigResult = packageVtrReachArchive({ collectorReportPath: alternateConfig.collectorPath, manifestPath: alternateConfig.manifestPath, archivePath: alternateConfig.archive })
  assert.equal(alternateConfigResult.report.checks.find((entry) => entry.id === 'server:fresh-world-attestation')?.status, 'FAIL',
    'alternate --config path with a recomputed argv hash is rejected')

  const alternateJar = makeFixture(join(tempRoot, 'server-start-alternate-jar'))
  mutateMappedJson(alternateJar, 'server/server-start.json', (document) => {
    document.process.jarArg = '/other/server.jar'
    document.process.argv[document.process.argv.indexOf('-jar') + 1] = document.process.jarArg
    document.process.commandLineSha256 = digest(Buffer.from(document.process.argv.join('\0')))
    document.spawnObservation.argv = [...document.process.argv]
    document.spawnObservation.commandLineSha256 = document.process.commandLineSha256
    document.spawnObservation.jarPath = document.process.jarArg
  })
  const alternateJarResult = packageVtrReachArchive({ collectorReportPath: alternateJar.collectorPath, manifestPath: alternateJar.manifestPath, archivePath: alternateJar.archive })
  assert.equal(alternateJarResult.report.checks.find((entry) => entry.id === 'server:fresh-world-attestation')?.status, 'FAIL',
    'alternate -jar path with a recomputed argv hash is rejected')

  const changedJarBytes = makeFixture(join(tempRoot, 'changed-jar-bytes'))
  const changedJarServerStart = JSON.parse(readFileSync(changedJarBytes.files['server/server-start.json'], 'utf8'))
  writeFileSync(changedJarServerStart.serverJar, Buffer.from('different Leaf jar bytes'))
  const changedJarResult = packageVtrReachArchive({ collectorReportPath: changedJarBytes.collectorPath, manifestPath: changedJarBytes.manifestPath, archivePath: changedJarBytes.archive })
  assert.equal(changedJarResult.report.checks.find((entry) => entry.id === 'server:spawned-artifacts')?.status, 'FAIL',
    'server JAR bytes are rehashed at package time instead of trusting the startup SHA claim')

  const tamperedStdoutReceipt = makeFixture(join(tempRoot, 'tampered-stdout-receipt'))
  mutateMappedJsonl(tamperedStdoutReceipt, 'server/leaf-stdout-events.jsonl', (rows) => { rows[1].lineSha256 = 'f'.repeat(64) })
  const tamperedStdoutResult = packageVtrReachArchive({ collectorReportPath: tamperedStdoutReceipt.collectorPath, manifestPath: tamperedStdoutReceipt.manifestPath, archivePath: tamperedStdoutReceipt.archive })
  assert.equal(tamperedStdoutResult.report.checks.find((entry) => entry.id === 'server:fresh-world-attestation')?.status, 'FAIL',
    'stdout receipt line hashes are rechecked rather than trusted')

  const rehashedTamper = makeFixture(join(tempRoot, 'rehashed-fresh-tamper'))
  packageVtrReachArchive({ collectorReportPath: rehashedTamper.collectorPath, manifestPath: rehashedTamper.manifestPath, archivePath: rehashedTamper.archive })
  const attestationPath = join(rehashedTamper.archive, 'server/fresh-world-attestation.json')
  const tamperedAttestation = JSON.parse(readFileSync(attestationPath, 'utf8'))
  tamperedAttestation.preStartObservation.levelDat.state = 'present'
  writeJson(attestationPath, tamperedAttestation)
  rehashArchiveFile(rehashedTamper.archive, 'server/fresh-world-attestation.json')
  const rehashedValidation = await validateEvidenceArchive(rehashedTamper.archive)
  assert.equal(rehashedValidation.checks.find((entry) => entry.id === 'server:fresh-world-attestation')?.status, 'FAIL',
    'rehashing SHA256SUMS cannot make a stale-world attestation pass semantic validation')

  const rehashedOldOrigin = makeFixture(join(tempRoot, 'rehashed-old-origin'))
  packageVtrReachArchive({ collectorReportPath: rehashedOldOrigin.collectorPath, manifestPath: rehashedOldOrigin.manifestPath, archivePath: rehashedOldOrigin.archive })
  const packageReportPath = join(rehashedOldOrigin.archive, 'packaging-report.json')
  const tamperedPackageReport = JSON.parse(readFileSync(packageReportPath, 'utf8'))
  const levelOrigin = tamperedPackageReport.sourceOrigins.entries.find((entry) => entry.archivePath === 'server/world/level.dat')
  assert.ok(levelOrigin, 'packager preserves actual world source origin in the archived report')
  levelOrigin.sourcePath = join(dirname(rehashedOldOrigin.collectorPath), 'extra', 'old-world', 'level.dat')
  levelOrigin.realPath = levelOrigin.sourcePath
  writeJson(packageReportPath, tamperedPackageReport)
  rehashArchiveFile(rehashedOldOrigin.archive, 'packaging-report.json')
  const rehashedOldOriginValidation = await validateEvidenceArchive(rehashedOldOrigin.archive)
  assert.equal(rehashedOldOriginValidation.checks.find((entry) => entry.id === 'server:fresh-world-attestation')?.status, 'FAIL',
    'rehashing the archive manifest cannot make an old-world source origin match the fresh worldRoot claim')
  assert.ok(rehashedOldOriginValidation.checks.some((entry) => entry.id === 'sha256:packaging-report.json' && entry.status === 'PASS'),
    'tampered package provenance is tested with a fully rehashed archive, so rejection is semantic')

  const rehashedJarOrigin = makeFixture(join(tempRoot, 'rehashed-jar-origin'))
  packageVtrReachArchive({ collectorReportPath: rehashedJarOrigin.collectorPath, manifestPath: rehashedJarOrigin.manifestPath, archivePath: rehashedJarOrigin.archive })
  const rehashedJarReportPath = join(rehashedJarOrigin.archive, 'packaging-report.json')
  const rehashedJarReport = JSON.parse(readFileSync(rehashedJarReportPath, 'utf8'))
  rehashedJarReport.serverJarSource.sha256 = 'f'.repeat(64)
  writeJson(rehashedJarReportPath, rehashedJarReport)
  rehashArchiveFile(rehashedJarOrigin.archive, 'packaging-report.json')
  const rehashedJarValidation = await validateEvidenceArchive(rehashedJarOrigin.archive)
  assert.equal(rehashedJarValidation.checks.find((entry) => entry.id === 'server:spawned-artifacts')?.status, 'FAIL',
    'offline validation binds the actual JAR source hash back to the exact spawned argv record')

  const rehashedPreStopRead = makeFixture(join(tempRoot, 'rehashed-pre-stop-read'))
  packageVtrReachArchive({ collectorReportPath: rehashedPreStopRead.collectorPath, manifestPath: rehashedPreStopRead.manifestPath, archivePath: rehashedPreStopRead.archive })
  const preStopAttestationPath = join(rehashedPreStopRead.archive, 'server/fresh-world-attestation.json')
  const preStopAttestation = JSON.parse(readFileSync(preStopAttestationPath, 'utf8'))
  preStopAttestation.postRunObservation.files[0].capturedAt = iso(49)
  writeJson(preStopAttestationPath, preStopAttestation)
  const preStopPackageReportPath = join(rehashedPreStopRead.archive, 'packaging-report.json')
  const preStopPackageReport = JSON.parse(readFileSync(preStopPackageReportPath, 'utf8'))
  const preStopOrigin = preStopPackageReport.sourceOrigins.entries.find((entry) => entry.archivePath === 'server/world/level.dat')
  preStopOrigin.capturedAt = iso(49)
  writeJson(preStopPackageReportPath, preStopPackageReport)
  rehashArchiveFile(rehashedPreStopRead.archive, 'server/fresh-world-attestation.json')
  rehashArchiveFile(rehashedPreStopRead.archive, 'packaging-report.json')
  const rehashedPreStopValidation = await validateEvidenceArchive(rehashedPreStopRead.archive)
  assert.equal(rehashedPreStopValidation.checks.find((entry) => entry.id === 'server:fresh-world-attestation')?.status, 'FAIL',
    'same-path bytes relabeled as post-run cannot pass with a pre-stop per-file read receipt, even after archive rehash')

  const rehashedSymlinkClaim = makeFixture(join(tempRoot, 'rehashed-symlink-claim'))
  packageVtrReachArchive({ collectorReportPath: rehashedSymlinkClaim.collectorPath, manifestPath: rehashedSymlinkClaim.manifestPath, archivePath: rehashedSymlinkClaim.archive })
  const symlinkAttestationPath = join(rehashedSymlinkClaim.archive, 'server/fresh-world-attestation.json')
  const symlinkAttestation = JSON.parse(readFileSync(symlinkAttestationPath, 'utf8'))
  symlinkAttestation.postRunObservation.files[0].pathChain[1].symlink = true
  writeJson(symlinkAttestationPath, symlinkAttestation)
  const symlinkPackageReportPath = join(rehashedSymlinkClaim.archive, 'packaging-report.json')
  const symlinkPackageReport = JSON.parse(readFileSync(symlinkPackageReportPath, 'utf8'))
  const symlinkOrigin = symlinkPackageReport.sourceOrigins.entries.find((entry) => entry.archivePath === 'server/world/level.dat')
  symlinkOrigin.pathChain[1].symlink = true
  writeJson(symlinkPackageReportPath, symlinkPackageReport)
  rehashArchiveFile(rehashedSymlinkClaim.archive, 'server/fresh-world-attestation.json')
  rehashArchiveFile(rehashedSymlinkClaim.archive, 'packaging-report.json')
  const rehashedSymlinkValidation = await validateEvidenceArchive(rehashedSymlinkClaim.archive)
  assert.equal(rehashedSymlinkValidation.checks.find((entry) => entry.id === 'server:fresh-world-attestation')?.status, 'FAIL',
    'a rehashed path-chain receipt cannot claim symlink-free world provenance when it records a symlink')
  assert.equal(noAttestationResult.report.providerActivity.status, 'INCOMPLETE')
  const noAttestationProbe = JSON.parse(readFileSync(join(noAttestation.archive, 'probe.json'), 'utf8'))
  assert.equal(noAttestationProbe.configuredNoLlmProbe.networkModelCalls, null)
  assert.ok(existsSync(join(noAttestation.archive, 'runner/jev-calls.jsonl')), 'a genuinely captured source file may be copied')

  const missingJournal = makeFixture(join(tempRoot, 'missing-journal'), { omitProvider: 'jev-calls' })
  const missingJournalResult = packageVtrReachArchive({ collectorReportPath: missingJournal.collectorPath, manifestPath: missingJournal.manifestPath, archivePath: missingJournal.archive })
  assert.equal(missingJournalResult.report.packageStatus, 'INCOMPLETE')
  assert.equal(existsSync(join(missingJournal.archive, 'runner/jev-calls.jsonl')), false, 'adapter must not fabricate an empty journal')
  assert.equal(missingJournalResult.report.providerActivity.status, 'INCOMPLETE')

  const missingMercury = makeFixture(join(tempRoot, 'missing-mercury'), { omitProvider: 'mercury-calls' })
  const missingMercuryManifest = JSON.parse(readFileSync(missingMercury.manifestPath, 'utf8'))
  delete missingMercuryManifest.files['runner/mercury-calls.jsonl']
  writeJson(missingMercury.manifestPath, missingMercuryManifest)
  const missingMercuryResult = packageVtrReachArchive({ collectorReportPath: missingMercury.collectorPath, manifestPath: missingMercury.manifestPath, archivePath: missingMercury.archive })
  assert.equal(missingMercuryResult.report.packageStatus, 'INCOMPLETE')
  assert.equal(missingMercuryResult.report.providerActivity.status, 'INCOMPLETE', 'missing System2 provider attempt evidence cannot be inferred as zero')

  const lateCapture = makeFixture(join(tempRoot, 'late-capture'), { captureStartsLate: true })
  const lateCaptureResult = packageVtrReachArchive({ collectorReportPath: lateCapture.collectorPath, manifestPath: lateCapture.manifestPath, archivePath: lateCapture.archive })
  assert.equal(lateCaptureResult.report.packageStatus, 'INCOMPLETE')
  assert.equal(lateCaptureResult.report.providerActivity.status, 'INCOMPLETE', 'existing empty post-run journals do not prove zero activity over the live window')

  const missingLifecycle = makeFixture(join(tempRoot, 'missing-lifecycle'), { omitLifecycle: true })
  const missingLifecycleResult = packageVtrReachArchive({ collectorReportPath: missingLifecycle.collectorPath, manifestPath: missingLifecycle.manifestPath, archivePath: missingLifecycle.archive })
  assert.equal(missingLifecycleResult.report.packageStatus, 'INCOMPLETE')
  assert.equal(missingLifecycleResult.report.providerActivity.status, 'INCOMPLETE')
  assert.equal(missingLifecycleResult.report.checks.find((entry) => entry.id === 'policy:no-llm-egress-audit')?.status, 'INCOMPLETE')

  const missingStopObservation = makeFixture(join(tempRoot, 'missing-stop-observation'), { omitStopObservations: true })
  const missingStopObservationResult = packageVtrReachArchive({ collectorReportPath: missingStopObservation.collectorPath, manifestPath: missingStopObservation.manifestPath, archivePath: missingStopObservation.archive })
  assert.equal(missingStopObservationResult.report.packageStatus, 'INCOMPLETE')
  assert.equal(missingStopObservationResult.report.checks.find((entry) => entry.id === 'provider-activity-zero')?.status, 'INCOMPLETE', 'pid/status rows without observed process/listener closure do not prove shutdown')

  const wrongListenerClosure = makeFixture(join(tempRoot, 'wrong-listener-closure'), { badLifecycleObservation: true })
  const wrongListenerClosureResult = packageVtrReachArchive({ collectorReportPath: wrongListenerClosure.collectorPath, manifestPath: wrongListenerClosure.manifestPath, archivePath: wrongListenerClosure.archive })
  assert.equal(wrongListenerClosureResult.report.packageStatus, 'INCOMPLETE')
  assert.equal(wrongListenerClosureResult.report.checks.find((entry) => entry.id === 'provider-activity-zero')?.status, 'INCOMPLETE', 'server stop needs connection-refused from exact loopback host/port')

  const missingEgress = makeFixture(join(tempRoot, 'missing-egress'), { omitEgress: true })
  const missingEgressResult = packageVtrReachArchive({ collectorReportPath: missingEgress.collectorPath, manifestPath: missingEgress.manifestPath, archivePath: missingEgress.archive })
  assert.equal(missingEgressResult.report.packageStatus, 'INCOMPLETE')
  assert.equal(missingEgressResult.report.checks.find((entry) => entry.id === 'policy:no-llm-egress-audit')?.status, 'INCOMPLETE')

  const tamperedEgress = makeFixture(join(tempRoot, 'tampered-egress'), { tamperEgress: true })
  const tamperedEgressResult = packageVtrReachArchive({ collectorReportPath: tamperedEgress.collectorPath, manifestPath: tamperedEgress.manifestPath, archivePath: tamperedEgress.archive })
  assert.equal(tamperedEgressResult.report.packageStatus, 'FAIL')
  assert.equal(tamperedEgressResult.report.checks.find((entry) => entry.id === 'policy:no-llm-egress-audit')?.status, 'FAIL')

  const duplicateGuardProcess = makeFixture(join(tempRoot, 'duplicate-egress-process'), { duplicateGuardProcess: true })
  const duplicateGuardProcessResult = packageVtrReachArchive({ collectorReportPath: duplicateGuardProcess.collectorPath, manifestPath: duplicateGuardProcess.manifestPath, archivePath: duplicateGuardProcess.archive })
  assert.equal(duplicateGuardProcessResult.report.packageStatus, 'FAIL')
  assert.equal(duplicateGuardProcessResult.report.checks.find((entry) => entry.id === 'policy:no-llm-egress-audit')?.status, 'FAIL',
    'duplicate guard_loaded rows for one process start must not impersonate descendant coverage')

  const externalAttempt = makeFixture(join(tempRoot, 'external-egress'), { externalAttempt: true })
  const externalAttemptResult = packageVtrReachArchive({ collectorReportPath: externalAttempt.collectorPath, manifestPath: externalAttempt.manifestPath, archivePath: externalAttempt.archive })
  assert.equal(externalAttemptResult.report.packageStatus, 'FAIL')
  assert.equal(externalAttemptResult.report.checks.find((entry) => entry.id === 'policy:no-llm-egress-audit')?.status, 'FAIL')

  const egressBeforeResidentExit = makeFixture(join(tempRoot, 'egress-before-resident-exit'), { egressCloseOffset: 48 })
  const egressBeforeResidentExitResult = packageVtrReachArchive({ collectorReportPath: egressBeforeResidentExit.collectorPath, manifestPath: egressBeforeResidentExit.manifestPath, archivePath: egressBeforeResidentExit.archive })
  assert.equal(egressBeforeResidentExitResult.report.packageStatus, 'INCOMPLETE')
  assert.equal(egressBeforeResidentExitResult.report.checks.find((entry) => entry.id === 'policy:no-llm-egress-audit')?.status, 'INCOMPLETE', 'the preload guard must close after the resident child exit is observed')

  const egressAfterServerStop = makeFixture(join(tempRoot, 'egress-after-server-stop'), { egressCloseOffset: 51 })
  const egressAfterServerStopResult = packageVtrReachArchive({ collectorReportPath: egressAfterServerStop.collectorPath, manifestPath: egressAfterServerStop.manifestPath, archivePath: egressAfterServerStop.archive })
  assert.equal(egressAfterServerStopResult.report.packageStatus, 'INCOMPLETE')
  assert.equal(egressAfterServerStopResult.report.checks.find((entry) => entry.id === 'policy:no-llm-egress-audit')?.status, 'INCOMPLETE', 'the wrapper capture must close before isolated server stop')

  const missingFixtureSource = makeFixture(join(tempRoot, 'missing-fixture-source'), { omitFixtureSource: true })
  const missingFixtureSourceResult = packageVtrReachArchive({ collectorReportPath: missingFixtureSource.collectorPath, manifestPath: missingFixtureSource.manifestPath, archivePath: missingFixtureSource.archive })
  assert.equal(missingFixtureSourceResult.report.packageStatus, 'INCOMPLETE')
  assert.equal(missingFixtureSourceResult.report.checks.find((entry) => entry.id === 'proof:no-double-authority-fixture')?.status, 'INCOMPLETE')

  const tamperedFixtureHash = makeFixture(join(tempRoot, 'tampered-fixture-hash'), { tamperFixtureSourceHash: true })
  const tamperedFixtureHashResult = packageVtrReachArchive({ collectorReportPath: tamperedFixtureHash.collectorPath, manifestPath: tamperedFixtureHash.manifestPath, archivePath: tamperedFixtureHash.archive })
  assert.equal(tamperedFixtureHashResult.report.packageStatus, 'FAIL')
  assert.equal(tamperedFixtureHashResult.report.checks.find((entry) => entry.id === 'proof:no-double-authority-fixture')?.status, 'FAIL')

  const badFixtureObservation = makeFixture(join(tempRoot, 'bad-fixture-observation'), { badFixtureObservation: true })
  const badFixtureObservationResult = packageVtrReachArchive({ collectorReportPath: badFixtureObservation.collectorPath, manifestPath: badFixtureObservation.manifestPath, archivePath: badFixtureObservation.archive })
  assert.equal(badFixtureObservationResult.report.packageStatus, 'FAIL')
  assert.equal(badFixtureObservationResult.report.checks.find((entry) => entry.id === 'proof:no-double-authority-fixture')?.status, 'FAIL')

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
  assert.equal(positiveRegion.witnessRegionPath, 'server/world/region/r.1.1.mca')
  assert.equal(positiveRegionResult.report.requiredWitnessRegionPath, positiveRegion.witnessRegionPath)
  assert.ok(positiveRegionResult.report.requiredValidatorPaths.includes(positiveRegion.witnessRegionPath))
  assert.equal(positiveRegionResult.report.checks.find((entry) => entry.id === 'required:world-witness-region')?.status, 'PASS')
  assert.equal(positiveRegionResult.report.packageStatus, 'READY_FOR_VALIDATION')

  const negativeRegion = makeFixture(join(tempRoot, 'negative-region'), { witnessPosition: { x: -513, y: 64, z: -515 } })
  const negativeRegionResult = packageVtrReachArchive({ collectorReportPath: negativeRegion.collectorPath, manifestPath: negativeRegion.manifestPath, archivePath: negativeRegion.archive })
  assert.equal(negativeRegion.witnessRegionPath, 'server/world/region/r.-2.-2.mca')
  assert.equal(negativeRegionResult.report.requiredWitnessRegionPath, negativeRegion.witnessRegionPath)
  assert.ok(negativeRegionResult.report.requiredValidatorPaths.includes(negativeRegion.witnessRegionPath))
  assert.equal(negativeRegionResult.report.checks.find((entry) => entry.id === 'required:world-witness-region')?.status, 'PASS')
  assert.equal(negativeRegionResult.report.packageStatus, 'READY_FOR_VALIDATION')

  const missingWitnessRegion = makeFixture(join(tempRoot, 'missing-witness-region'), { witnessPosition: { x: 35, y: 64, z: 0 } })
  const manifestWithoutWitness = JSON.parse(readFileSync(missingWitnessRegion.manifestPath, 'utf8'))
  delete manifestWithoutWitness.files[missingWitnessRegion.witnessRegionPath]
  writeJson(missingWitnessRegion.manifestPath, manifestWithoutWitness)
  const missingWitnessResult = packageVtrReachArchive({ collectorReportPath: missingWitnessRegion.collectorPath, manifestPath: missingWitnessRegion.manifestPath, archivePath: missingWitnessRegion.archive })
  assert.equal(missingWitnessRegion.witnessRegionPath, 'server/world/region/r.0.0.mca')
  assert.equal(missingWitnessResult.report.requiredWitnessRegionPath, missingWitnessRegion.witnessRegionPath)
  assert.ok(missingWitnessResult.report.requiredValidatorPaths.includes(missingWitnessRegion.witnessRegionPath))
  assert.equal(missingWitnessResult.report.checks.find((entry) => entry.id === 'required:world-witness-region')?.status, 'INCOMPLETE')
  assert.equal(missingWitnessResult.report.packageStatus, 'INCOMPLETE', 'omitting the committed witness region must still fail closed')

  // --- Validator hardening: fail-closed negative coverage --------------------
  // Every check family added for the hardened validator must demonstrably
  // reject tampered evidence rather than silently passing or going incomplete.
  const addArchiveFile = (archive, relativePath, contents) => {
    const full = join(archive, relativePath)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, contents)
    const sumsPath = join(archive, 'SHA256SUMS')
    writeFileSync(sumsPath, `${readFileSync(sumsPath, 'utf8')}${digest(contents)}  ${relativePath}\n`)
  }
  const rewriteArchiveJsonl = (archive, relativePath, mutate) => {
    const full = join(archive, relativePath)
    const rows = readFileSync(full, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    mutate(rows)
    writeFileSync(full, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
    rehashArchiveFile(archive, relativePath)
    return rows
  }
  const kernelJournalRows = () => {
    const rows = []
    const command = (via, name) => rows.push({ type: 'kernel-command', transitionId: TRANSITION, generationId: GENERATION, via, command: name, ok: true })
    command('gate-admit', 'REGISTER_TRANSITION'); command('gate-admit', 'UPDATE_MISSION'); command('gate-admit', 'ADMIT_TRANSITION')
    command('gate-activate', 'ACQUIRE_DECLARED_RESOURCES')
    for (let leg = 1; leg <= 4; leg += 1) {
      command('mechanical-step-issued', 'ISSUE_EFFECT'); command('mechanical-step-issued', 'BEGIN_EFFECT_DISPATCH')
      rows.push({ type: 'effect-dispatch', transitionId: TRANSITION, generationId: GENERATION, stepId: `MOVE:b4_64_4#17:walk-leg-${leg}`, commitId: `commit:${leg}`, authority: true })
      command('mechanical-step-settled', 'DEBIT_USAGE'); command('mechanical-step-settled', 'RECONCILE_EFFECT')
    }
    command('transition-terminal', 'ACCEPT_VERIFIED_SNAPSHOT'); command('transition-terminal', 'VERIFY_SUCCESS')
    rows.push({ type: 'verify-attempt', transitionId: TRANSITION, generationId: GENERATION, missingObservedProof: [] })
    rows.push({ type: 'verify-provenance', transitionId: TRANSITION, generationId: GENERATION, factIds: ['verify:40:oak_log'] })
    rows.forEach((row, index) => { row.seq = index + 1 })
    return rows
  }
  const injectKernelEvidence = (archive) => {
    const buddyPath = join(archive, 'runner/buddy.log')
    writeFileSync(buddyPath, `${readFileSync(buddyPath, 'utf8')}` +
      `[${iso(6)}] KERNEL_AUTHORITY_MODE mode=authority generationId=${GENERATION}\n` +
      `[${iso(6)}] KERNEL_AUTHORITY_READY id=${GENERATION} kernelAuthority=on legacyReachAuthority=off\n` +
      `[${iso(47)}] KERNEL_AUTHORITY_SUMMARY id=${GENERATION} authorityMode=authority mutationsObserved=5 mutationsAttributedToTransition=5 coverageComplete=true gateDenials=0 mutationsDeniedByLease=0 kernelDenied=0\n`)
    rehashArchiveFile(archive, 'runner/buddy.log')
    addArchiveFile(archive, 'runner/kernel-authority.jsonl', `${kernelJournalRows().map((row) => JSON.stringify(row)).join('\n')}\n`)
  }
  const kernelTamper = async (name, tamper) => {
    const fixture = makeFixture(join(tempRoot, name))
    packageVtrReachArchive({ collectorReportPath: fixture.collectorPath, manifestPath: fixture.manifestPath, archivePath: fixture.archive })
    injectKernelEvidence(fixture.archive)
    tamper(fixture.archive)
    return validateEvidenceArchive(fixture.archive)
  }
  const statusOf = (report, id) => report.checks.find((entry) => entry.id === id)?.status

  const kernelBase = makeFixture(join(tempRoot, 'kernel-evidence-base'))
  packageVtrReachArchive({ collectorReportPath: kernelBase.collectorPath, manifestPath: kernelBase.manifestPath, archivePath: kernelBase.archive })
  injectKernelEvidence(kernelBase.archive)
  const kernelBaseValidation = await validateEvidenceArchive(kernelBase.archive)
  for (const id of ['authority:kernel-mode-on', 'authority:kernel-summary', 'authority:kernel-gates-live', 'transition:contract-content-binding', 'transition:row-run-binding']) {
    assert.equal(statusOf(kernelBaseValidation, id), 'PASS', `honest kernel evidence passes ${id}`)
  }
  assert.ok(kernelBaseValidation.checks.every((entry) => ['PASS', 'FAIL', 'INCOMPLETE'].includes(entry.status)),
    'every emitted check carries a concrete status (no detail-key collision can hide a verdict)')
  assert.equal(kernelBaseValidation.checkCount, kernelBaseValidation.checks.length)
  assert.equal(kernelBaseValidation.counts.pass + kernelBaseValidation.counts.fail + kernelBaseValidation.counts.incomplete, kernelBaseValidation.checkCount)
  assert.deepEqual(kernelBaseValidation.duplicateCheckIds, [])

  const kernelForeignGeneration = await kernelTamper('kernel-foreign-generation', (archive) => rewriteArchiveJsonl(archive, 'runner/kernel-authority.jsonl', (rows) => {
    rows.push({ type: 'note', transitionId: TRANSITION, generationId: 'gen-foreign-9', seq: rows.length + 1 })
  }))
  assert.equal(statusOf(kernelForeignGeneration, 'authority:kernel-gates-live'), 'FAIL', 'journal rows bound to a foreign generation are rejected')

  const kernelSeqReorder = await kernelTamper('kernel-seq-reorder', (archive) => rewriteArchiveJsonl(archive, 'runner/kernel-authority.jsonl', (rows) => {
    rows[5].seq = 99
  }))
  assert.equal(statusOf(kernelSeqReorder, 'authority:kernel-gates-live'), 'FAIL', 'non-monotonic journal sequence is rejected')

  const kernelNoVerifyAttempt = await kernelTamper('kernel-no-verify-attempt', (archive) => rewriteArchiveJsonl(archive, 'runner/kernel-authority.jsonl', (rows) => {
    const kept = rows.filter((row) => row.type !== 'verify-attempt')
    rows.length = 0
    rows.push(...kept.map((row, index) => ({ ...row, seq: index + 1 })))
  }))
  assert.equal(statusOf(kernelNoVerifyAttempt, 'authority:kernel-gates-live'), 'FAIL', 'an empty verify-attempt set cannot pass vacuously')

  const kernelForeignStep = await kernelTamper('kernel-foreign-step', (archive) => rewriteArchiveJsonl(archive, 'runner/kernel-authority.jsonl', (rows) => {
    rows.find((row) => row.type === 'effect-dispatch').stepId = 'MOVE:b4_64_4#17:walk-leg-99'
  }))
  assert.equal(statusOf(kernelForeignStep, 'authority:kernel-gates-live'), 'FAIL', 'a dispatch stepId outside the reserved mechanical steps is rejected')

  const kernelUnbracketed = await kernelTamper('kernel-unbracketed-dispatch', (archive) => rewriteArchiveJsonl(archive, 'runner/kernel-authority.jsonl', (rows) => {
    const index = rows.findIndex((row) => row.type === 'effect-dispatch')
    const [dispatch] = rows.splice(index, 1)
    rows.push(dispatch)
    rows.forEach((row, position) => { row.seq = position + 1 })
  }))
  assert.equal(statusOf(kernelUnbracketed, 'authority:kernel-gates-live'), 'FAIL', 'a dispatch unbracketed by gated BEGIN/RECONCILE commands is rejected')

  const kernelModeOff = await kernelTamper('kernel-mode-off', (archive) => {
    const buddyPath = join(archive, 'runner/buddy.log')
    writeFileSync(buddyPath, `${readFileSync(buddyPath, 'utf8')}[${iso(6)}] KERNEL_AUTHORITY_MODE mode=shadow generationId=${GENERATION}\n`)
    rehashArchiveFile(archive, 'runner/buddy.log')
  })
  assert.equal(statusOf(kernelModeOff, 'authority:kernel-mode-on'), 'FAIL', 'a shadow-mode row anywhere in the run is rejected')

  const kernelDeniedSummary = await kernelTamper('kernel-denied-summary', (archive) => {
    const buddyPath = join(archive, 'runner/buddy.log')
    writeFileSync(buddyPath, `${readFileSync(buddyPath, 'utf8')}[${iso(47)}] KERNEL_AUTHORITY_SUMMARY id=${GENERATION} authorityMode=authority mutationsObserved=5 mutationsAttributedToTransition=5 coverageComplete=true gateDenials=0 mutationsDeniedByLease=0 kernelDenied=3\n`)
    rehashArchiveFile(archive, 'runner/buddy.log')
  })
  assert.equal(statusOf(kernelDeniedSummary, 'authority:kernel-summary'), 'FAIL', 'a second summary row carrying nonzero kernel denials is rejected')

  const kernelForeignSummaryGeneration = await kernelTamper('kernel-foreign-summary-generation', (archive) => {
    const buddyPath = join(archive, 'runner/buddy.log')
    writeFileSync(buddyPath, `${readFileSync(buddyPath, 'utf8')}[${iso(47)}] KERNEL_AUTHORITY_SUMMARY id=gen-foreign-9 authorityMode=authority mutationsObserved=0 mutationsAttributedToTransition=0 coverageComplete=true gateDenials=0 mutationsDeniedByLease=0 kernelDenied=0\n`)
    rehashArchiveFile(archive, 'runner/buddy.log')
  })
  assert.equal(statusOf(kernelForeignSummaryGeneration, 'authority:kernel-summary'), 'FAIL', 'a summary row bound to a foreign generation is rejected')

  const foreignRowRunId = await kernelTamper('row-foreign-runid', (archive) => rewriteArchiveJsonl(archive, 'runner/jev-run.jsonl', (rows) => {
    rows.find((row) => String(row?.message ?? '').includes('VTR_TRANSITION_OUTCOME')).detail.runId = 'run-foreign-9'
  }))
  assert.equal(statusOf(foreignRowRunId, 'transition:row-run-binding'), 'FAIL', 'a Transition row carrying a foreign runId is rejected')

  const mutatedContractContent = await kernelTamper('contract-content-mutated', (archive) => rewriteArchiveJsonl(archive, 'runner/jev-run.jsonl', (rows) => {
    rows.find((row) => String(row?.message ?? '').includes('VTR_TRANSITION_COMMIT')).detail.budget.maxMechanicalSteps = 40
  }))
  assert.equal(statusOf(mutatedContractContent, 'transition:contract-content-binding'), 'FAIL', 'committed contract fields that do not re-hash to the claimed hash are rejected')

  const fabricatedMilestone = await kernelTamper('milestone-fabricated-counts', (archive) => {
    const proofPath = join(archive, 'proofs/no-double-authority.json')
    const proof = JSON.parse(readFileSync(proofPath, 'utf8'))
    proof.vtrActuationCount = 5
    writeJson(proofPath, proof)
    rehashArchiveFile(archive, 'proofs/no-double-authority.json')
  })
  assert.equal(statusOf(fabricatedMilestone, 'milestone:proofs/no-double-authority.json'), 'FAIL', 'self-reported actuation counts disagreeing with recomputation are rejected')
  assert.equal(fabricatedMilestone.status, 'FAIL', 'milestone failures propagate to the aggregate status')

  const secondJournalTamper = async (name, mutate) => {
    const fixture = makeFixture(join(tempRoot, name))
    packageVtrReachArchive({ collectorReportPath: fixture.collectorPath, manifestPath: fixture.manifestPath, archivePath: fixture.archive })
    const archive = fixture.archive
    const journalBytes = readFileSync(join(archive, 'runner/jev-run.jsonl'))
    renameSync(join(archive, 'runner/jev-run.jsonl'), join(archive, 'runner/run.jsonl'))
    const sumsPath = join(archive, 'SHA256SUMS')
    writeFileSync(sumsPath, readFileSync(sumsPath, 'utf8').split('\n').map((row) => row.endsWith('  runner/jev-run.jsonl') ? `${digest(journalBytes)}  runner/run.jsonl` : row).join('\n'))
    mutate(archive)
    return validateEvidenceArchive(archive)
  }
  const secondJournalForeignRun = await secondJournalTamper('second-journal-foreign-run', (archive) => rewriteArchiveJsonl(archive, 'runner/run.jsonl', (rows) => {
    rows.find((row) => String(row?.message ?? '').includes('VTR_TRANSITION_OUTCOME')).detail.runId = 'run-foreign-9'
  }))
  assert.equal(statusOf(secondJournalForeignRun, 'archive:second-journal-binding'), 'FAIL', 'VTR evidence in the run.jsonl journal bound to a foreign runId is rejected')

  const duplicateJournals = makeFixture(join(tempRoot, 'duplicate-journals'))
  packageVtrReachArchive({ collectorReportPath: duplicateJournals.collectorPath, manifestPath: duplicateJournals.manifestPath, archivePath: duplicateJournals.archive })
  const duplicateJournalRows = readFileSync(join(duplicateJournals.archive, 'runner/jev-run.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  duplicateJournalRows.find((row) => String(row?.message ?? '').includes('VTR_TRANSITION_OUTCOME')).detail.runId = 'run-foreign-9'
  addArchiveFile(duplicateJournals.archive, 'runner/run.jsonl', `${duplicateJournalRows.map((row) => JSON.stringify(row)).join('\n')}\n`)
  const duplicateJournalValidation = await validateEvidenceArchive(duplicateJournals.archive)
  assert.equal(statusOf(duplicateJournalValidation, 'archive:second-journal-binding'), 'FAIL', 'a second journal cannot smuggle foreign-bound Transition evidence beside a clean primary')

  const consistentJournals = makeFixture(join(tempRoot, 'consistent-journals'))
  packageVtrReachArchive({ collectorReportPath: consistentJournals.collectorPath, manifestPath: consistentJournals.manifestPath, archivePath: consistentJournals.archive })
  addArchiveFile(consistentJournals.archive, 'runner/run.jsonl', readFileSync(join(consistentJournals.archive, 'runner/jev-run.jsonl')))
  const consistentJournalsValidation = await validateEvidenceArchive(consistentJournals.archive)
  assert.equal(statusOf(consistentJournalsValidation, 'archive:second-journal-binding'), 'PASS', 'a byte-identical second journal does not false-positive')

  const kernelModeUnbound = await kernelTamper('kernel-mode-unbound', (archive) => {
    const buddyPath = join(archive, 'runner/buddy.log')
    const text = readFileSync(buddyPath, 'utf8').replaceAll(`generationId=${GENERATION}`, 'generationId=gen-foreign-9').replaceAll(`id=${GENERATION}`, 'id=gen-foreign-9')
    writeFileSync(buddyPath, text)
    rehashArchiveFile(archive, 'runner/buddy.log')
  })
  assert.equal(statusOf(kernelModeUnbound, 'authority:kernel-mode-on'), 'INCOMPLETE', 'mode markers bound to a foreign generation cannot grant kernel authority')

  const malformedKernelJournal = await kernelTamper('kernel-journal-malformed', (archive) => {
    writeFileSync(join(archive, 'runner/kernel-authority.jsonl'), '{"type":"kernel-command",\n')
    rehashArchiveFile(archive, 'runner/kernel-authority.jsonl')
  }).catch((error) => ({ parseError: error }))
  assert.ok(malformedKernelJournal.parseError, 'a malformed kernel journal aborts validation rather than being trusted')

  const bareArchive = makeFixture(join(tempRoot, 'bare-archive'))
  packageVtrReachArchive({ collectorReportPath: bareArchive.collectorPath, manifestPath: bareArchive.manifestPath, archivePath: bareArchive.archive })
  const bareValidation = await validateEvidenceArchive(bareArchive.archive)
  for (const id of ['authority:kernel-mode-on', 'authority:kernel-summary', 'authority:kernel-gates-live']) {
    assert.equal(statusOf(bareValidation, id), 'INCOMPLETE', `absent kernel evidence leaves ${id} INCOMPLETE, never PASS`)
  }

  const duplicateBoot = await kernelTamper('duplicate-boot', (archive) => {
    const buddyPath = join(archive, 'runner/buddy.log')
    writeFileSync(buddyPath, `${readFileSync(buddyPath, 'utf8')}[${iso(0)}] BOOT runId=${RUN} source=${SOURCE} worldKey=${JSON.stringify({ host: '127.0.0.1', port: 25565 })}\n`)
    rehashArchiveFile(archive, 'runner/buddy.log')
  })
  assert.equal(statusOf(duplicateBoot, 'run:boot-line'), 'FAIL', 'a second BOOT line for the probe runId is rejected')

  const syntheticBaseline = makeFixture(join(tempRoot, 'synthetic-baseline'))
  const syntheticOrigin = makeOriginMainRepo(join(tempRoot, 'synthetic-baseline'))
  const syntheticComparison = {
    schema: 'vtr-reach-fixture-comparison/v3',
    comparisonStatus: 'INCOMPLETE', acceptanceEligible: false, acceptanceStatus: 'RAW_EVIDENCE_INCOMPLETE',
    evidenceClass: 'summary-only',
    alignment: { missionInput: 'INCOMPLETE', fixture: 'INCOMPLETE', environment: 'INCOMPLETE' },
    lineage: {
      legacy: { sourceSha: 'f'.repeat(40), recordedOriginMainSha: 'f'.repeat(40), runId: 'run-old-f1', generationId: 'gen-old-f1', buildHash: 'old-build' },
      vtr: { sourceSha: SOURCE, runId: RUN, generationId: GENERATION, buildHash: syntheticBaseline.collectorReport.observed.generationReady.buildHash, worldKey: WORLD },
    },
    rawComparisonEvidence: { status: 'INCOMPLETE' },
  }
  const syntheticComparisonSource = writeJson(join(tempRoot, 'synthetic-baseline', 'comparison.json'), syntheticComparison)
  const syntheticManifest = JSON.parse(readFileSync(syntheticBaseline.manifestPath, 'utf8'))
  syntheticManifest.files['comparison/legacy-baseline.json'] = syntheticComparisonSource
  writeJson(syntheticBaseline.manifestPath, syntheticManifest)
  const syntheticBaselineResult = packageVtrReachArchive({ collectorReportPath: syntheticBaseline.collectorPath, manifestPath: syntheticBaseline.manifestPath,
    archivePath: syntheticBaseline.archive, repoPath: syntheticOrigin.repo })
  assert.equal(syntheticBaselineResult.report.checks.find((entry) => entry.id === 'comparison:legacy-baseline')?.status, 'INCOMPLETE',
    'an incomplete comparison remains INCOMPLETE at package time')
  const syntheticBaselineValidation = await validateEvidenceArchive(syntheticBaseline.archive, syntheticOrigin.repo)
  assert.equal(statusOf(syntheticBaselineValidation, 'milestone:comparison/legacy-baseline.json'), 'INCOMPLETE',
    'an incomplete comparison stays INCOMPLETE at archive validation')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

process.stdout.write('VTR Reach archive packaging tests passed\n')
