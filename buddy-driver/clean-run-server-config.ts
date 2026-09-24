import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'

type Plain = Record<string, unknown>

const asObject = (value: unknown): Plain | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Plain) : null

const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')

function parseProperties(text: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#') || line.startsWith('!')) continue
    const index = line.indexOf('=')
    if (index < 0) continue
    values[line.slice(0, index).trim()] = line.slice(index + 1).trim()
  }
  return values
}

function option(args: string[], key: string): string | null {
  const index = args.indexOf(key)
  return index < 0 ? null : args[index + 1] ?? null
}

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
}: {
  runId: string
  bootSourceSha: string | null
  attestationPath?: string | null
  descriptorPath?: string | null
  expectedPropertiesPath?: string | null
  readProcessCommandLine?: (pid: number) => Buffer
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
    if (attestation?.record !== 'clean-run-leaf-startup-attestation' || attestation.schemaVersion !== 1) {
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
    const propertiesSha256 = sha256(propertiesText)
    if (propertiesSha256 !== config.sha256) return rejected('staged_server_properties_changed_after_leaf_startup')
    const properties = parseProperties(propertiesText)

    const processInfo = asObject(attestation.process)
    const consoleInfo = asObject(attestation.console)
    const consoleDir = resolve(dirname(resolvedAttestation), 'server-console')
    const consoleInputPath = resolve(String(consoleInfo?.inputPath ?? ''))
    const stdoutLogPath = resolve(String(consoleInfo?.stdoutLogPath ?? ''))
    const commandTranscriptPath = resolve(String(consoleInfo?.commandTranscriptPath ?? ''))
    const consoleCapturePath = resolve(String(consoleInfo?.capturePath ?? ''))
    if (
      consoleInfo?.mode !== 'run-private-fifo-and-log' ||
      consoleInputPath !== resolve(consoleDir, 'server-console.fifo') ||
      stdoutLogPath !== resolve(consoleDir, 'leaf-server.log') ||
      commandTranscriptPath !== resolve(consoleDir, 'commands.jsonl') ||
      consoleCapturePath !== resolve(consoleDir, 'capture.json')
    ) return rejected('leaf_console_paths_are_not_run_private')
    const directoryStat = lstatSync(consoleDir)
    const fifoStat = lstatSync(consoleInputPath)
    const logStat = lstatSync(stdoutLogPath)
    if (
      !directoryStat.isDirectory() || directoryStat.uid !== process.getuid?.() || (directoryStat.mode & 0o777) !== 0o700 ||
      !fifoStat.isFIFO() || fifoStat.uid !== process.getuid?.() || (fifoStat.mode & 0o777) !== 0o600 ||
      !logStat.isFile() || logStat.isSymbolicLink() || logStat.uid !== process.getuid?.() || (logStat.mode & 0o777) !== 0o600
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
    const actualConfigArg = option(actualArgs.slice(1), '--config')
    const actualUniverseArg = option(actualArgs.slice(1), '--universe')
    const actualLevelNameArg = option(actualArgs.slice(1), '--level-name')
    const jarIndex = actualArgs.indexOf('-jar')
    const actualJar = jarIndex < 0 ? null : actualArgs[jarIndex + 1] ?? null
    if (
      actualConfigArg === null || resolve(dirname(resolvedDescriptor), actualConfigArg) !== stagedProperties ||
      actualUniverseArg === null || resolve(dirname(resolvedDescriptor), actualUniverseArg) !== resolve(String(cleanRun.worldContainer ?? '')) ||
      actualLevelNameArg !== values.levelName ||
      actualArgs.includes('--bonusChest') ||
      actualJar === null || basename(actualJar) !== values.serverImplementation
    ) return rejected('live_leaf_argv_does_not_match_descriptor_and_staged_config')

    const expectedServerId = String(values.serverId ?? '')
    const expectedPort = /:(\d+)$/.exec(expectedServerId)?.[1] ?? null
    const launchProperties = asObject(config.properties)
    if (
      launchProperties === null ||
      properties.difficulty !== String(values.difficulty ?? '') ||
      properties['level-seed'] !== String(values.levelSeed ?? '') ||
      properties['spawn-monsters'] !== String(values.mobSpawning ?? '') ||
      properties['server-port'] !== expectedPort
    ) return rejected('runtime_server_properties_do_not_match_descriptor')

    return {
      status: 'verified',
      runId,
      bootSourceSha,
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
        serverJar: basename(actualJar),
        configArg: stagedProperties,
        universeArg: resolve(String(cleanRun.worldContainer ?? '')),
        levelNameArg: actualLevelNameArg,
      },
      config: { path: stagedProperties, sha256: propertiesSha256, properties: launchProperties },
      console: {
        mode: 'run-private-fifo-and-log',
        directory: consoleDir,
        inputPath: consoleInputPath,
        stdoutLogPath,
        commandTranscriptPath,
        capturePath: consoleCapturePath,
      },
      preparedManifest: { stagedPropertiesSha256: stagedFile?.sha256 ?? null },
    }
  } catch {
    return unavailable('leaf_startup_attestation_unreadable_or_invalid')
  }
}
