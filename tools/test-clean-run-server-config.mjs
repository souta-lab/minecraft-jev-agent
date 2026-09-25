#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanRunAcceptanceWorldIdentity, cleanRunServerConfigAtBoot } from '../buddy-driver/clean-run-server-config.ts'
import { checkRunEvidence } from './clean-run-environment.mjs'
import { buildLeafStartupAttestation } from './clean-run-server-launch.mjs'
import { expectedLeafLaunchIdentity, expectedRuntimeServerProperties, inspectJavaRuntime, parseServerProperties, sha256Text } from './clean-run-server-config.mjs'

const TEMPLATE = new URL('./fixtures/m3-clean-environment.json', import.meta.url)
const SOURCE_SHA = 'aa11bb22cc33dd44ee55ff6677889900aabbccdd'
const RUN_ID = 'run-startup-config-fixture'
const temporaryRoot = mkdtempSync(join(tmpdir(), 'clean-run-server-config-'))
const agentRunnerSource = readFileSync(new URL('../buddy-driver/agent-runner.mts', import.meta.url), 'utf8')

function asProperties(values) {
  return `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n')}\n`
}

try {
  // Acceptance must not read the repository's shared server.properties as a
  // live-world seed. Only the run-bound startup descriptor can supply one.
  assert.doesNotMatch(agentRunnerSource, /function serverSeed\(/)
  assert.doesNotMatch(agentRunnerSource, /observedSeed\s*:/)
  const acceptanceIdentityCall = /cleanRunAcceptanceWorldIdentity\(\{([\s\S]*?)\}\)/.exec(agentRunnerSource)
  assert.ok(acceptanceIdentityCall, 'HOST acceptance must derive its world identity')
  assert.match(acceptanceIdentityCall[1], /attestation:\s*bootCleanRunServerConfig/)
  assert.doesNotMatch(acceptanceIdentityCall[1], /serverSeed|BUDDY_SERVER_PROPERTIES_PATH/)

  const container = join(temporaryRoot, 'server')
  const runDir = join(container, 'runs', 'm3-live', 'm3clean-fixture')
  mkdirSync(runDir, { recursive: true })
  const descriptor = JSON.parse(readFileSync(TEMPLATE, 'utf8'))
  descriptor.cleanRun.worldContainer = container
  descriptor.values.levelName = 'm3clean-fixture'
  descriptor.values.levelSeed = '-4187923615481'
  descriptor.values.sourceSha = SOURCE_SHA
  descriptor.cleanRun.sourceSha.state = 'FROZEN'
  writeFileSync(join(container, descriptor.values.serverImplementation), 'fixture Leaf jar bytes')
  const descriptorPath = join(runDir, 'environment-resolved.json')
  const descriptorText = `${JSON.stringify(descriptor, null, 2)}\n`
  writeFileSync(descriptorPath, descriptorText)
  const descriptorSha256 = sha256Text(descriptorText)

  const propertiesPath = join(runDir, 'server.properties.clean')
  const rawPropertiesText = asProperties(expectedRuntimeServerProperties(descriptor))
  const propertiesText = rawPropertiesText.replace('level-type=minecraft:normal', 'level-type=minecraft\\:normal')
  assert.equal(parseServerProperties(propertiesText)['level-type'], 'minecraft:normal')
  assert.equal(Object.hasOwn(parseServerProperties(propertiesText), 'bonus-chest'), false)
  writeFileSync(propertiesPath, propertiesText)
  const propertiesSha256 = sha256Text(propertiesText)
  const manifestPath = join(runDir, 'manifest.json')
  const manifest = {
    record: 'clean-run-prepare',
    schemaVersion: 2,
    descriptor: { path: descriptorPath, sha256: descriptorSha256 },
    resolved: { path: descriptorPath, overrides: [] },
    target: { levelName: descriptor.values.levelName, levelSeed: descriptor.values.levelSeed, sourceSha: SOURCE_SHA },
    files: [{ path: propertiesPath, sha256: propertiesSha256, bytes: Buffer.byteLength(propertiesText), note: 'staged properties fixture' }],
    serverLaunch: expectedLeafLaunchIdentity(descriptor, container),
  }
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`
  writeFileSync(manifestPath, manifestText)
  const manifestSha256 = sha256Text(manifestText)

  const consoleDir = join(runDir, 'server-console')
  mkdirSync(consoleDir, { mode: 0o700 })
  chmodSync(consoleDir, 0o700)
  const consoleInputPath = join(consoleDir, 'server-console.fifo')
  execFileSync('mkfifo', ['-m', '600', '--', consoleInputPath])
  writeFileSync(join(consoleDir, 'leaf-server.log'), '', { mode: 0o600 })
  writeFileSync(join(consoleDir, 'leaf-console-relay.jsonl'), '', { mode: 0o600 })

  const java = '/usr/lib/jvm/java-21-openjdk-amd64/bin/java'
  const args = [
    '-Xmx1G', '-Xms1G', '-DPaper.IgnoreJavaVersion=true', '-jar', 'leaf-1.21.11-178.jar',
    '--nogui', '--config', propertiesPath, '--universe', container, '--level-name', descriptor.values.levelName,
  ]
  const procArgs = [java, ...args]
  const javaIdentity = manifest.serverLaunch.java
  const startup = (overrides = {}) => buildLeafStartupAttestation({
    descriptorPath, descriptorText, descriptor,
    propertiesPath, propertiesText, manifestPath, manifestText,
    consoleInputPath,
    stdoutLogPath: join(consoleDir, 'leaf-server.log'),
    cwd: container, executable: java, args, pid: 4242,
    startedAt: '2026-09-23T09:59:00.000Z', procCmdline: procArgs,
    procExecutablePath: javaIdentity.realpath,
    procExecutableSha256: javaIdentity.sha256,
    ...overrides,
  })
  const attestation = startup()
  assert.equal(attestation.record, 'clean-run-leaf-startup-attestation')
  assert.equal(attestation.config.sha256, propertiesSha256)
  assert.equal(attestation.process.configArg, propertiesPath)
  assert.equal(attestation.config.properties.difficulty, 'normal')
  assert.equal(Object.hasOwn(attestation.config.properties, 'bonus-chest'), false)
  assert.equal(attestation.console.directory, consoleDir)
  assert.equal(attestation.runtime.java.version, descriptor.cleanRun.runtimePolicy.javaVersion)
  assert.equal(attestation.runtime.java.versionOutputSha256, manifest.serverLaunch.java.versionOutputSha256)
  assert.equal(attestation.runtime.paperIgnoreJavaVersion, true)
  assert.equal(JSON.stringify(attestation).includes('rcon.password'), false)

  assert.throws(
    () => startup({ args: args.map((entry, index) => index === args.indexOf(propertiesPath) ? join(runDir, 'wrong.properties') : entry) }),
    /unsupported runtime arguments/,
  )

  assert.throws(
    () => startup({ args: [...args, '--bonusChest'], procCmdline: [...procArgs, '--bonusChest'] }),
    /unsupported runtime arguments/,
  )

  assert.throws(() => startup({ procExecutablePath: '/usr/bin/echo' }), /observed process executable is not the expected Java runtime identity/)
  assert.throws(() => startup({ args: [...args, '--port', '25566'], procCmdline: [...procArgs, '--port', '25566'] }), /unsupported runtime arguments/)
  assert.throws(() => startup({ args: [...args, '--config', propertiesPath], procCmdline: [...procArgs, '--config', propertiesPath] }), /unsupported runtime arguments/)
  assert.throws(
    () => inspectJavaRuntime(java, descriptor.cleanRun.runtimePolicy, () => ({ status: 0, stdout: '', stderr: 'openjdk version "22.0.1"\n' })),
    /differs from descriptor policy/,
  )
  assert.throws(
    () => inspectJavaRuntime(java, descriptor.cleanRun.runtimePolicy, () => ({ status: 1, stdout: '', stderr: '', error: new Error('not executable') })),
    /could not be obtained/,
  )

  const altJarPath = join(temporaryRoot, descriptor.values.serverImplementation)
  writeFileSync(altJarPath, 'same basename, different jar')
  const alteredManifest = structuredClone(manifest)
  alteredManifest.serverLaunch.serverJar = expectedLeafLaunchIdentity(descriptor, temporaryRoot).serverJar
  const alteredManifestText = `${JSON.stringify(alteredManifest, null, 2)}\n`
  assert.throws(
    () => startup({ manifestText: alteredManifestText }),
    /prepared manifest does not bind expected Java and Leaf JAR identity/,
  )

  const attestationPath = join(runDir, 'server-start-attestation.json')
  writeFileSync(attestationPath, `${JSON.stringify(attestation, null, 2)}\n`)
  // Leaf's Java properties store adds a timestamp comment on first startup.
  // That changes the on-disk digest while preserving every runtime property.
  const normalizedPropertiesText = `#Thu Sep 24 19:42:01 JST 2026\n${propertiesText}`
  assert.notEqual(sha256Text(normalizedPropertiesText), propertiesSha256)
  writeFileSync(propertiesPath, normalizedPropertiesText)
  const previousSeedReadPath = process.env.BUDDY_SERVER_PROPERTIES_PATH
  process.env.BUDDY_SERVER_PROPERTIES_PATH = join(temporaryRoot, 'shared-server.properties')
  const bound = cleanRunServerConfigAtBoot({
    runId: RUN_ID,
    bootSourceSha: SOURCE_SHA,
    attestationPath,
    descriptorPath,
    readProcessCommandLine: () => Buffer.from(`${procArgs.join('\0')}\0`),
    readProcessExecutablePath: () => javaIdentity.realpath,
    readProcessExecutableBytes: () => readFileSync(javaIdentity.path),
  })
  if (previousSeedReadPath === undefined) delete process.env.BUDDY_SERVER_PROPERTIES_PATH
  else process.env.BUDDY_SERVER_PROPERTIES_PATH = previousSeedReadPath
  assert.equal(bound.status, 'verified', JSON.stringify(bound))
  assert.equal(bound.runId, RUN_ID)
  assert.equal(bound.bootSourceSha, SOURCE_SHA)
  assert.equal(bound.descriptorSha256, descriptorSha256)
  assert.equal(bound.config.sha256, propertiesSha256)
  assert.equal(bound.preparedManifest.stagedPropertiesSha256, propertiesSha256)
  const acceptanceWorld = cleanRunAcceptanceWorldIdentity({
    attestation: bound,
    runId: RUN_ID,
    bootSourceSha: SOURCE_SHA,
    observedLevelName: null,
  })
  assert.equal(acceptanceWorld.levelName, descriptor.values.levelName, 'verified Leaf --level-name binds a missing Mineflayer game levelName')
  assert.equal(acceptanceWorld.seed, String(descriptor.values.levelSeed), 'same-run verified descriptor binds the exact seed')
  assert.equal(acceptanceWorld.levelNameEvidence?.source, 'verified-leaf-argv')
  assert.equal(acceptanceWorld.seedEvidence?.source, 'verified-leaf-startup-descriptor')
  assert.equal(acceptanceWorld.seedEvidence?.runtimeConfirmationRequired, 'clean-run-console-capture')
  const wrongRunWorld = cleanRunAcceptanceWorldIdentity({
    attestation: bound,
    runId: 'run-other',
    bootSourceSha: SOURCE_SHA,
    observedLevelName: null,
  })
  assert.equal(wrongRunWorld.levelName, null, 'a verified startup proof from another run cannot be reused')
  const wrongSourceWorld = cleanRunAcceptanceWorldIdentity({
    attestation: bound,
    runId: RUN_ID,
    bootSourceSha: 'f'.repeat(40),
    observedLevelName: null,
  })
  assert.equal(wrongSourceWorld.seed, null, 'a verified startup proof from another source cannot be reused')
  const conflictWorld = cleanRunAcceptanceWorldIdentity({
    attestation: bound,
    runId: RUN_ID,
    bootSourceSha: SOURCE_SHA,
    observedLevelName: 'wrong-world',
  })
  assert.equal(conflictWorld.levelName, null, 'conflicting observed game world name invalidates the acceptance identity')
  assert.equal(conflictWorld.seed, null)

  const seedWithoutStartupProof = cleanRunAcceptanceWorldIdentity({
    attestation: null,
    runId: RUN_ID,
    bootSourceSha: SOURCE_SHA,
    observedLevelName: 'unattested-world',
  })
  assert.equal(seedWithoutStartupProof.seed, null, 'without run-bound Leaf startup proof the live world seed is unknown')
  assert.equal(seedWithoutStartupProof.seedEvidence, null)

  const artifact = {
    record: 'milestone-run-artifact',
    runId: RUN_ID,
    environment: {
      difficulty: { value: 'normal', source: descriptorPath, runScoped: false },
      mobSpawning: { value: true, source: descriptorPath, runScoped: false },
      environmentFile: { path: descriptorPath, sha256: descriptorSha256, values: descriptor.values },
      worldChanges: null,
    },
    run: {
      runId: RUN_ID,
      boot: { sourceSha: SOURCE_SHA, ts: '2026-09-23T10:00:00.000Z', cleanRunServerConfig: bound },
    },
    inventory: {},
  }
  const conditions = checkRunEvidence({
    descriptor,
    artifact,
    runId: RUN_ID,
    descriptorPath,
    descriptorSha256,
  })
  const row = (id) => conditions.find((entry) => entry.id === id)
  assert.equal(row('run.serverConfigAttestation')?.verdict, 'PASS', row('run.serverConfigAttestation')?.reason)
  assert.equal(row('run.difficultyNotContradicted')?.verdict, 'PASS')
  assert.equal(row('run.mobSpawningNotContradicted')?.verdict, 'PASS')

  const acceptanceWorldArtifact = structuredClone(artifact)
  acceptanceWorldArtifact.acceptance = {
    present: true,
    path: join(runDir, `acceptance-${RUN_ID}.json`),
    record: {
      runId: RUN_ID,
      gitCommit: SOURCE_SHA,
      serverId: '127.0.0.1:25565',
      levelName: acceptanceWorld.levelName,
      seed: acceptanceWorld.seed,
      worldIdentityEvidence: {
        levelName: acceptanceWorld.levelNameEvidence,
        seed: acceptanceWorld.seedEvidence,
      },
    },
  }
  const acceptanceWorldConditions = checkRunEvidence({
    descriptor,
    artifact: acceptanceWorldArtifact,
    runId: RUN_ID,
    descriptorPath,
    descriptorSha256,
  })
  assert.equal(acceptanceWorldConditions.find((entry) => entry.id === 'run.levelNameAttested')?.verdict, 'PASS', 'verified Leaf argv supplies missing Mineflayer levelName')
  assert.equal(acceptanceWorldConditions.find((entry) => entry.id === 'run.seedAttested')?.verdict, 'UNKNOWN', 'descriptor seed alone cannot claim the live Leaf seed response')
  const foreignAcceptanceEvidence = structuredClone(acceptanceWorldArtifact)
  foreignAcceptanceEvidence.acceptance.record.worldIdentityEvidence.levelName.runId = 'run-foreign'
  const foreignEvidenceConditions = checkRunEvidence({
    descriptor,
    artifact: foreignAcceptanceEvidence,
    runId: RUN_ID,
    descriptorPath,
    descriptorSha256,
  })
  assert.equal(foreignEvidenceConditions.find((entry) => entry.id === 'run.levelNameAttested')?.verdict, 'UNKNOWN', 'same text without exact provenance cannot attest the world')

  const alteredRuntime = structuredClone(artifact)
  alteredRuntime.run.boot.cleanRunServerConfig.runtime.java.version = '21.99.0'
  const rejectedRuntime = checkRunEvidence({
    descriptor,
    artifact: alteredRuntime,
    runId: RUN_ID,
    descriptorPath,
    descriptorSha256,
  })
  assert.equal(rejectedRuntime.find((entry) => entry.id === 'run.serverConfigAttestation')?.verdict, 'FAIL')

  const alteredJvmFlag = structuredClone(artifact)
  alteredJvmFlag.run.boot.cleanRunServerConfig.runtime.paperIgnoreJavaVersion = false
  const rejectedJvmFlag = checkRunEvidence({
    descriptor,
    artifact: alteredJvmFlag,
    runId: RUN_ID,
    descriptorPath,
    descriptorSha256,
  })
  assert.equal(rejectedJvmFlag.find((entry) => entry.id === 'run.serverConfigAttestation')?.verdict, 'FAIL')

  const noStartupEvidence = structuredClone(artifact)
  delete noStartupEvidence.run.boot.cleanRunServerConfig
  const unproven = checkRunEvidence({
    descriptor,
    artifact: noStartupEvidence,
    runId: RUN_ID,
    descriptorPath,
    descriptorSha256,
  })
  const noAttestationRow = (id) => unproven.find((entry) => entry.id === id)
  assert.equal(noAttestationRow('run.serverConfigAttestation')?.verdict, 'UNKNOWN')
  assert.equal(noAttestationRow('run.difficultyNotContradicted')?.verdict, 'UNKNOWN', 'descriptor-sourced values cannot prove runtime difficulty')
  assert.equal(noAttestationRow('run.difficultyNotContradicted')?.required, true)

  const wrongBinding = structuredClone(artifact)
  wrongBinding.run.boot.cleanRunServerConfig.descriptorSha256 = 'f'.repeat(64)
  const rejected = checkRunEvidence({
    descriptor,
    artifact: wrongBinding,
    runId: RUN_ID,
    descriptorPath,
    descriptorSha256,
  })
  assert.equal(rejected.find((entry) => entry.id === 'run.serverConfigAttestation')?.verdict, 'FAIL')

  const driftedProperties = normalizedPropertiesText.replace('difficulty=normal', 'difficulty=hard')
  writeFileSync(propertiesPath, driftedProperties)
  const changed = cleanRunServerConfigAtBoot({
    runId: RUN_ID,
    bootSourceSha: SOURCE_SHA,
    attestationPath,
    descriptorPath,
    readProcessCommandLine: () => Buffer.from(`${procArgs.join('\0')}\0`),
    readProcessExecutablePath: () => javaIdentity.realpath,
    readProcessExecutableBytes: () => readFileSync(javaIdentity.path),
  })
  assert.equal(changed.status, 'rejected')
  assert.match(String(changed.reason), /runtime_server_properties_do_not_match_descriptor/)
  const driftedGate = checkRunEvidence({
    descriptor,
    artifact,
    runId: RUN_ID,
    descriptorPath,
    descriptorSha256,
  })
  assert.equal(driftedGate.find((entry) => entry.id === 'run.serverConfigAttestation')?.verdict, 'FAIL')

  console.log('PASS clean-run Leaf startup config provenance (immutable prepare hash, server-normalized disk projection, semantic drift refusal)')
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true })
}
