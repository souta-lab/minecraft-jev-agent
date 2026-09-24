#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanRunServerConfigAtBoot } from '../buddy-driver/clean-run-server-config.ts'
import { checkRunEvidence } from './clean-run-environment.mjs'
import { buildLeafStartupAttestation } from './clean-run-server-launch.mjs'
import { expectedLeafLaunchIdentity, expectedRuntimeServerProperties, inspectJavaRuntime, parseServerProperties, sha256Text } from './clean-run-server-config.mjs'

const TEMPLATE = new URL('./fixtures/m3-clean-environment.json', import.meta.url)
const SOURCE_SHA = 'aa11bb22cc33dd44ee55ff6677889900aabbccdd'
const RUN_ID = 'run-startup-config-fixture'
const temporaryRoot = mkdtempSync(join(tmpdir(), 'clean-run-server-config-'))

function asProperties(values) {
  return `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n')}\n`
}

try {
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

  const staleProperties = `${propertiesText}# changed after Leaf startup\n`
  writeFileSync(propertiesPath, staleProperties)
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
  assert.match(String(changed.reason), /changed_after_leaf_startup/)

  console.log('PASS clean-run Leaf startup config provenance (launcher argv/hash, BOOT binding, gate fail-closed)')
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true })
}
