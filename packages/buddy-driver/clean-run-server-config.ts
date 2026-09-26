import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { assertExactLeafArgv, compareRuntimeServerProperties, expectedLeafLaunchIdentity, expectedLeafServerArgs, parseServerProperties } from '../../tools/clean-run-server-config.mjs'

type Plain = Record<string, unknown>

const asObject = (value: unknown): Plain | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Plain) : null

const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')

/**
 * Bind a launcher-produced Leaf startup record to this HOST BOOT. The host
 * rechecks the descriptor, staged bytes, manifest, and live process argv; a
 * copied/prepared descriptor or BUDDY_SERVER_PROPERTIES_PATH alone is not proof.
 */
export function cleanRunServerConfigAtBoot({
  runId,
  bootSourceSha,
  attestationPath = process.env.BUDDY_SERVER_START_ATTESTATION_PATH ?? null,
  descriptorPath = process.env.BUDDY_CLEAN_RUN_DESCRIPTOR_PATH ?? null,
  expectedPropertiesPath = null,
  readProcessCommandLine = (pid: number) => readFileSync(`/proc/${pid}/cmdline`),
  readProcessExecutablePath = (pid: number) => realpathSync(`/proc/${pid}/exe`),
  readProcessExecutableBytes = (pid: number) => readFileSync(`/proc/${pid}/exe`),
}: {
  runId: string
  bootSourceSha: string | null
  attestationPath?: string | null
  descriptorPath?: string | null
  expectedPropertiesPath?: string | null
  readProcessCommandLine?: (pid: number) => Buffer
  readProcessExecutablePath?: (pid: number) => string
  readProcessExecutableBytes?: (pid: number) => Buffer
}): Plain {
  const unavailable = (reason: string): Plain => ({ status: 'unavailable', runId, bootSourceSha, reason })
  const rejected = (reason: string): Plain => ({ status: 'rejected', runId, bootSourceSha, reason })
  if (process.platform !== 'linux') return unavailable('leaf_process_cmdline_unavailable_on_this_platform')
  if (attestationPath === null || descriptorPath === null) {
    return unavailable('clean_run_startup_paths_not_configured')
  }

  try {
    const resolvedAttestation = resolve(attestationPath)
    const resolvedDescriptor = resolve(descriptorPath)
    const stagedProperties = resolve(dirname(resolvedDescriptor), 'server.properties.clean')
    const resolvedProperties = resolve(expectedPropertiesPath ?? stagedProperties)
    const manifestPath = resolve(dirname(resolvedDescriptor), 'manifest.json')
    if (resolvedProperties !== stagedProperties) return rejected('host_config_path_is_not_staged_server_properties_clean')

    const attestationText = readFileSync(resolvedAttestation, 'utf8')
    const raw = JSON.parse(attestationText) as unknown
    const attestation = asObject(raw)
    if (attestation?.record !== 'clean-run-leaf-startup-attestation' || attestation.schemaVersion !== 2) {
      return unavailable('leaf_startup_attestation_record_invalid')
    }
    const descriptorText = readFileSync(resolvedDescriptor, 'utf8')
    const descriptor = asObject(JSON.parse(descriptorText) as unknown)
    const values = asObject(descriptor?.values)
    const cleanRun = asObject(descriptor?.cleanRun)
    if (descriptor?.record !== 'clean-run-environment' || values === null || cleanRun === null) {
      return unavailable('clean_run_descriptor_invalid')
    }
    const descriptorSha256 = sha256(descriptorText)
    const attestedDescriptor = asObject(attestation.descriptor)
    if (
      resolve(String(attestedDescriptor?.path ?? '')) !== resolvedDescriptor ||
      attestedDescriptor?.sha256 !== descriptorSha256 ||
      attestedDescriptor?.sourceSha !== values.sourceSha ||
      attestedDescriptor?.sourceSha !== bootSourceSha ||
      attestedDescriptor?.levelName !== values.levelName ||
      String(attestedDescriptor?.levelSeed ?? '') !== String(values.levelSeed ?? '')
    ) return rejected('descriptor_or_boot_source_does_not_match_leaf_startup_attestation')

    const manifestText = readFileSync(manifestPath, 'utf8')
    const manifest = asObject(JSON.parse(manifestText) as unknown)
    const expectedLaunchIdentity = expectedLeafLaunchIdentity(descriptor, resolve(String(cleanRun.worldContainer ?? '')))
    const serverLaunch = asObject(manifest?.serverLaunch)
    if (JSON.stringify(serverLaunch ?? null) !== JSON.stringify(expectedLaunchIdentity)) {
      return rejected('prepared_manifest_does_not_bind_expected_java_and_leaf_jar')
    }
    const runtime = asObject(attestation.runtime)
    if (runtime === null) return rejected('leaf_runtime_identity_is_missing')
    if (
      JSON.stringify(runtime?.java ?? null) !== JSON.stringify(expectedLaunchIdentity.java) ||
      runtime?.paperIgnoreJavaVersion !== expectedLaunchIdentity.paperIgnoreJavaVersion ||
      expectedLaunchIdentity.paperIgnoreJavaVersion !== true
    ) return rejected('leaf_java_version_or_ignored_version_flag_differs_from_descriptor_policy')
    const manifestFiles = Array.isArray(manifest?.files) ? manifest.files.map(asObject).filter((entry): entry is Plain => entry !== null) : []
    const stagedFile = manifestFiles.find((entry) => typeof entry.path === 'string' && resolve(entry.path) === stagedProperties)
    const attestedManifest = asObject(attestation.manifest)
    const target = asObject(manifest?.target)
    const resolvedManifest = asObject(manifest?.resolved)
    const config = asObject(attestation.config)
    if (
      manifest?.record !== 'clean-run-prepare' ||
      resolve(String(resolvedManifest?.path ?? '')) !== resolvedDescriptor ||
      target?.levelName !== values.levelName ||
      String(target?.levelSeed ?? '') !== String(values.levelSeed ?? '') ||
      target?.sourceSha !== bootSourceSha ||
      attestedManifest?.path !== manifestPath ||
      attestedManifest?.sha256 !== sha256(manifestText) ||
      attestedManifest?.stagedPropertiesSha256 !== stagedFile?.sha256
    ) return rejected('prepared_manifest_does_not_bind_descriptor_and_staged_config')

    if (config === null || resolve(String(config.path ?? '')) !== stagedProperties || config.sha256 !== stagedFile?.sha256) {
      return rejected('staged_server_properties_hash_does_not_match_prepared_manifest')
    }
    const propertiesText = readFileSync(stagedProperties, 'utf8')
    const properties = parseServerProperties(propertiesText)

    const processInfo = asObject(attestation.process)
    const consoleInfo = asObject(attestation.console)
    const consoleDir = resolve(dirname(resolvedAttestation), 'server-console')
    const consoleInputPath = resolve(String(consoleInfo?.inputPath ?? ''))
    const stdoutLogPath = resolve(String(consoleInfo?.stdoutLogPath ?? ''))
    const commandTranscriptPath = resolve(String(consoleInfo?.commandTranscriptPath ?? ''))
    const consoleCapturePath = resolve(String(consoleInfo?.capturePath ?? ''))
    const relayJournalPath = resolve(String(consoleInfo?.relayJournalPath ?? ''))
    if (
      consoleInfo?.mode !== 'run-private-fifo-and-log' ||
      consoleInputPath !== resolve(consoleDir, 'server-console.fifo') ||
      stdoutLogPath !== resolve(consoleDir, 'leaf-server.log') ||
      commandTranscriptPath !== resolve(consoleDir, 'commands.jsonl') ||
      consoleCapturePath !== resolve(consoleDir, 'capture.json') ||
      relayJournalPath !== resolve(consoleDir, 'leaf-console-relay.jsonl')
    ) return rejected('leaf_console_paths_are_not_run_private')
    const directoryStat = lstatSync(consoleDir)
    const fifoStat = lstatSync(consoleInputPath)
    const logStat = lstatSync(stdoutLogPath)
    const relayStat = lstatSync(relayJournalPath)
    if (
      !directoryStat.isDirectory() || directoryStat.uid !== process.getuid?.() || (directoryStat.mode & 0o777) !== 0o700 ||
      !fifoStat.isFIFO() || fifoStat.uid !== process.getuid?.() || (fifoStat.mode & 0o777) !== 0o600 ||
      !logStat.isFile() || logStat.isSymbolicLink() || logStat.uid !== process.getuid?.() || (logStat.mode & 0o777) !== 0o600 ||
      !relayStat.isFile() || relayStat.isSymbolicLink() || relayStat.uid !== process.getuid?.() || (relayStat.mode & 0o777) !== 0o600
    ) return rejected('leaf_console_paths_are_not_private_owner_objects')
    const pid = processInfo?.pid
    if (!Number.isInteger(pid) || (pid as number) < 1) return unavailable('leaf_startup_attestation_has_no_process_id')
    if (typeof processInfo?.startedAt !== 'string' || !Number.isFinite(Date.parse(processInfo.startedAt))) {
      return unavailable('leaf_startup_attestation_has_no_process_start_time')
    }
    if (typeof processInfo.commandLineSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(processInfo.commandLineSha256)) {
      return unavailable('leaf_startup_attestation_has_no_process_argv_digest')
    }
    const procCommandLine = readProcessCommandLine(pid as number)
    const actualArgs = procCommandLine.toString('utf8').split('\0').filter(Boolean)
    if (actualArgs.length < 2 || sha256(Buffer.from(actualArgs.join('\0'))) !== processInfo.commandLineSha256) {
      return rejected('live_leaf_process_argv_differs_from_startup_attestation')
    }
    try {
      assertExactLeafArgv(actualArgs.slice(1), expectedLeafServerArgs(descriptor, stagedProperties, resolve(String(cleanRun.worldContainer ?? ''))), 'live Leaf')
    } catch {
      return rejected('live_leaf_argv_has_duplicate_or_unsupported_runtime_arguments')
    }
    const expectedExecutable = expectedLaunchIdentity.java
    const actualExecutablePath = readProcessExecutablePath(pid as number)
    const actualExecutableSha256 = sha256(readProcessExecutableBytes(pid as number))
    if (
      actualArgs[0] !== expectedExecutable.path ||
      processInfo.executable !== expectedExecutable.path ||
      processInfo.executableRealpath !== expectedExecutable.realpath ||
      processInfo.executableSha256 !== expectedExecutable.sha256 ||
      actualExecutablePath !== expectedExecutable.realpath ||
      actualExecutableSha256 !== expectedExecutable.sha256
    ) return rejected('live_leaf_process_executable_is_not_expected_java_identity')
    if (JSON.stringify(processInfo.argv ?? null) !== JSON.stringify(actualArgs)) return rejected('startup_attestation_argv_does_not_match_live_leaf_argv')
    const actualConfigArg = actualArgs[actualArgs.indexOf('--config') + 1] ?? null
    const actualUniverseArg = actualArgs[actualArgs.indexOf('--universe') + 1] ?? null
    const actualLevelNameArg = actualArgs[actualArgs.indexOf('--level-name') + 1] ?? null
    const jarIndex = actualArgs.indexOf('-jar')
    const actualJar = jarIndex < 0 ? null : actualArgs[jarIndex + 1] ?? null
    const actualJarPath = actualJar === null ? null : resolve(String(cleanRun.worldContainer ?? ''), actualJar)
    if (actualJar === null) return rejected('live_leaf_jar_argument_is_missing')
    if (
      actualConfigArg === null || resolve(dirname(resolvedDescriptor), actualConfigArg) !== stagedProperties ||
      actualUniverseArg === null || resolve(dirname(resolvedDescriptor), actualUniverseArg) !== resolve(String(cleanRun.worldContainer ?? '')) ||
      actualLevelNameArg !== values.levelName ||
      actualArgs.includes('--bonusChest') ||
      actualJar !== values.serverImplementation || actualJarPath !== expectedLaunchIdentity.serverJar.path ||
      processInfo.serverJarPath !== expectedLaunchIdentity.serverJar.path ||
      processInfo.serverJarRealpath !== expectedLaunchIdentity.serverJar.realpath ||
      processInfo.serverJarSha256 !== expectedLaunchIdentity.serverJar.sha256
    ) return rejected('live_leaf_argv_does_not_match_descriptor_and_staged_config')

    const launchProperties = asObject(config.properties)
    if (launchProperties === null) return rejected('startup_attested_properties_are_missing')
    const attestedComparison = compareRuntimeServerProperties(descriptor, launchProperties)
    const currentComparison = compareRuntimeServerProperties(descriptor, properties)
    if (!attestedComparison.agrees || !currentComparison.agrees) {
      return rejected('runtime_server_properties_do_not_match_descriptor')
    }
    const attestedPropertyKeys = Object.keys(launchProperties)
    const expectedPropertyKeys = Object.keys(attestedComparison.expected)
    if (
      attestedPropertyKeys.length !== expectedPropertyKeys.length ||
      expectedPropertyKeys.some((key) => !Object.hasOwn(launchProperties, key))
    ) return rejected('startup_attested_properties_outside_safe_acceptance_projection')
    if (JSON.stringify(attestedComparison.observed) !== JSON.stringify(currentComparison.observed)) {
      return rejected('runtime_server_property_projection_changed_after_leaf_startup')
    }

    return {
      status: 'verified',
      runId,
      bootSourceSha,
      world: {
        levelName: values.levelName,
        levelSeed: String(values.levelSeed ?? ''),
      },
      descriptorPath: resolvedDescriptor,
      descriptorSha256,
      attestationPath: resolvedAttestation,
      attestationSha256: sha256(attestationText),
      manifestPath,
      manifestSha256: sha256(manifestText),
      process: {
        pid,
        startedAt: processInfo.startedAt,
        commandLineSha256: processInfo.commandLineSha256,
        argv: actualArgs,
        executable: processInfo.executable,
        executableRealpath: actualExecutablePath,
        executableSha256: actualExecutableSha256,
        serverJar: basename(actualJar),
        serverJarPath: actualJarPath,
        serverJarRealpath: expectedLaunchIdentity.serverJar.realpath,
        serverJarSha256: expectedLaunchIdentity.serverJar.sha256,
        configArg: stagedProperties,
        universeArg: resolve(String(cleanRun.worldContainer ?? '')),
        levelNameArg: actualLevelNameArg,
      },
      runtime: {
        java: expectedLaunchIdentity.java,
        paperIgnoreJavaVersion: runtime.paperIgnoreJavaVersion,
      },
      // Leaf rewrites `--config` with a timestamp/comment during normal startup.
      // Keep the immutable pre-spawn hash bound to the prepare manifest; the
      // current file is checked by its descriptor-relevant property projection.
      config: { path: stagedProperties, sha256: config.sha256, properties: launchProperties },
      console: {
        mode: 'run-private-fifo-and-log',
        directory: consoleDir,
        inputPath: consoleInputPath,
        stdoutLogPath,
        commandTranscriptPath,
        capturePath: consoleCapturePath,
        relayJournalPath,
      },
      preparedManifest: { stagedPropertiesSha256: stagedFile?.sha256 ?? null },
    }
  } catch {
    return unavailable('leaf_startup_attestation_unreadable_or_invalid')
  }
}

/**
 * HOST acceptance fields for a clean run. `Bot.game.levelName` is absent on
 * some Mineflayer/Leaf versions, so the exact already-verified Leaf `--level-name`
 * argument is the source of truth. A BOOT-bound descriptor also supplies the
 * expected seed; the clean-run console evidence separately proves that the live
 * Leaf `seed` response equals it.
 */
export function cleanRunAcceptanceWorldIdentity({
  attestation,
  runId,
  bootSourceSha,
  observedLevelName = null,
  observedSeed = null,
}: {
  attestation: unknown
  runId: string
  bootSourceSha: string | null
  observedLevelName?: string | null
  observedSeed?: string | null
}): {
  levelName: string | null
  seed: string | null
  levelNameEvidence: Plain | null
  seedEvidence: Plain | null
} {
  const baseLevelName = typeof observedLevelName === 'string' && observedLevelName.length > 0 ? observedLevelName : null
  const baseSeed = typeof observedSeed === 'string' && observedSeed.length > 0 ? observedSeed : null
  const base = {
    levelName: baseLevelName,
    seed: baseSeed,
    levelNameEvidence: baseLevelName === null ? null : { source: 'mineflayer-game.levelName' },
    seedEvidence: baseSeed === null ? null : { source: 'server-properties' },
  }
  const proof = asObject(attestation)
  const world = asObject(proof?.world)
  const process = asObject(proof?.process)
  const attestedLevelName = typeof process?.levelNameArg === 'string' ? process.levelNameArg : null
  const descriptorLevelName = typeof world?.levelName === 'string' ? world.levelName : null
  const descriptorSeed = typeof world?.levelSeed === 'string' && world.levelSeed.length > 0 ? world.levelSeed : null
  if (
    proof?.status !== 'verified' ||
    proof.runId !== runId ||
    proof.bootSourceSha !== bootSourceSha ||
    typeof bootSourceSha !== 'string' ||
    !/^[a-f0-9]{40}$/i.test(bootSourceSha) ||
    attestedLevelName === null ||
    descriptorLevelName === null ||
    attestedLevelName !== descriptorLevelName ||
    descriptorSeed === null
  ) return base
  if (baseLevelName !== null && baseLevelName !== attestedLevelName) {
    return {
      levelName: null,
      seed: null,
      levelNameEvidence: {
        source: 'verified-leaf-argv-conflict',
        runId,
        bootSourceSha,
        descriptorLevelName,
        processLevelNameArg: attestedLevelName,
        observedGameLevelName: baseLevelName,
      },
      seedEvidence: null,
    }
  }
  return {
    levelName: attestedLevelName,
    seed: descriptorSeed,
    levelNameEvidence: {
      source: 'verified-leaf-argv',
      runId,
      bootSourceSha,
      descriptorPath: proof.descriptorPath ?? null,
      descriptorSha256: proof.descriptorSha256 ?? null,
      processPid: process?.pid ?? null,
      commandLineSha256: process?.commandLineSha256 ?? null,
      processLevelNameArg: attestedLevelName,
    },
    seedEvidence: {
      source: 'verified-leaf-startup-descriptor',
      runId,
      bootSourceSha,
      descriptorPath: proof.descriptorPath ?? null,
      descriptorSha256: proof.descriptorSha256 ?? null,
      seed: descriptorSeed,
      runtimeConfirmationRequired: 'clean-run-console-capture',
    },
  }
}
