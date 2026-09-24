#!/usr/bin/env bun
// Start the staged Leaf server and record the exact startup config/argv before
// handing the child off. This wrapper is the only M3 command emitted by prepare.
import { createHash } from 'node:crypto'
import { chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import {
  compareRuntimeServerProperties,
  parseServerProperties,
  projectRuntimeServerProperties,
  sha256Text,
} from './clean-run-server-config.mjs'

function parseArgs(argv) {
  const options = { environment: null, properties: null, attestation: null, manifest: null, cwd: null, consoleInput: null, stdoutLog: null, command: null, commandArgs: [] }
  const split = argv.indexOf('--')
  if (split < 0) throw new Error('missing -- before the Leaf command')
  for (let i = 0; i < split; i += 1) {
    const arg = argv[i]
    if (arg === '--environment') options.environment = argv[++i] ?? null
    else if (arg === '--properties') options.properties = argv[++i] ?? null
    else if (arg === '--attestation') options.attestation = argv[++i] ?? null
    else if (arg === '--manifest') options.manifest = argv[++i] ?? null
    else if (arg === '--cwd') options.cwd = argv[++i] ?? null
    else if (arg === '--console-input') options.consoleInput = argv[++i] ?? null
    else if (arg === '--stdout-log') options.stdoutLog = argv[++i] ?? null
    else throw new Error(`unknown argument: ${arg}`)
  }
  options.command = argv[split + 1] ?? null
  options.commandArgs = argv.slice(split + 2)
  if ([options.environment, options.properties, options.attestation, options.manifest, options.cwd, options.consoleInput, options.stdoutLog, options.command].some((value) => value === null)) {
    throw new Error('environment, properties, attestation, manifest, cwd, console paths, and Leaf command are required')
  }
  return options
}

function commandOption(args, name) {
  const index = args.indexOf(name)
  return index < 0 ? null : args[index + 1] ?? null
}

export function buildLeafStartupAttestation({
  descriptorPath,
  descriptorText,
  descriptor,
  propertiesPath,
  propertiesText,
  manifestPath,
  manifestText,
  consoleInputPath,
  stdoutLogPath,
  cwd,
  executable,
  args,
  pid,
  startedAt,
  procCmdline,
}) {
  const resolvedDescriptor = resolve(descriptorPath)
  const resolvedProperties = resolve(propertiesPath)
  const resolvedConsoleInput = resolve(consoleInputPath)
  const resolvedStdoutLog = resolve(stdoutLogPath)
  const resolvedCwd = resolve(cwd)
  const expectedPropertiesPath = resolve(dirname(resolvedDescriptor), 'server.properties.clean')
  const consoleDir = resolve(dirname(resolvedDescriptor), 'server-console')
  if (resolvedConsoleInput !== resolve(consoleDir, 'server-console.fifo')) throw new Error('Leaf console input must use this run directory FIFO')
  if (resolvedStdoutLog !== resolve(consoleDir, 'leaf-server.log')) throw new Error('Leaf output must use this run directory log')
  if (resolvedProperties !== expectedPropertiesPath) throw new Error('Leaf config must be the staged sibling server.properties.clean')
  if (!Number.isInteger(pid) || pid < 1) throw new Error('Leaf process pid is missing')
  if (!Array.isArray(args) || args.length === 0) throw new Error('Leaf process argv is empty')
  const configArg = commandOption(args, '--config')
  const universeArg = commandOption(args, '--universe')
  const levelNameArg = commandOption(args, '--level-name')
  const jarIndex = args.indexOf('-jar')
  const serverJarArg = jarIndex < 0 ? null : args[jarIndex + 1] ?? null
  if (args.includes('--bonusChest')) throw new Error('Leaf argv must omit --bonusChest for a clean world')
  if (resolve(resolvedCwd, configArg ?? '') !== resolvedProperties) throw new Error('Leaf argv --config does not select the staged server.properties.clean')
  if (resolve(resolvedCwd, universeArg ?? '') !== resolve(descriptor.cleanRun?.worldContainer ?? '')) throw new Error('Leaf argv --universe differs from descriptor worldContainer')
  if (levelNameArg !== descriptor.values?.levelName) throw new Error('Leaf argv --level-name differs from descriptor levelName')
  if (serverJarArg === null || serverJarArg.split(/[\\/]/).at(-1) !== descriptor.values?.serverImplementation) {
    throw new Error('Leaf argv server jar differs from descriptor serverImplementation')
  }
  const parsed = parseServerProperties(propertiesText)
  const comparison = compareRuntimeServerProperties(descriptor, parsed)
  if (!comparison.agrees) throw new Error(`staged server.properties differs from descriptor: ${[...comparison.missing, ...comparison.mismatches].join('; ')}`)
  const actualArgs = Array.isArray(procCmdline) ? procCmdline : []
  const actualConfig = commandOption(actualArgs.slice(1), '--config')
  const actualUniverse = commandOption(actualArgs.slice(1), '--universe')
  const actualLevelName = commandOption(actualArgs.slice(1), '--level-name')
  const actualJarIndex = actualArgs.indexOf('-jar')
  const actualJar = actualJarIndex < 0 ? null : actualArgs[actualJarIndex + 1] ?? null
  if (
    actualConfig === null || resolve(resolvedCwd, actualConfig) !== resolvedProperties ||
    actualUniverse === null || resolve(resolvedCwd, actualUniverse) !== resolve(descriptor.cleanRun?.worldContainer ?? '') ||
    actualLevelName !== descriptor.values?.levelName || actualArgs.includes('--bonusChest') ||
    actualJar?.split(/[\\/]/).at(-1) !== descriptor.values?.serverImplementation
  ) throw new Error('spawned Leaf process argv does not match requested clean-run target')

  const manifest = JSON.parse(manifestText)
  const manifestFile = Array.isArray(manifest.files) ? manifest.files.find((entry) => resolve(entry.path) === resolvedProperties) : null
  if (manifest.resolved?.path !== resolvedDescriptor || manifestFile?.sha256 !== sha256Text(propertiesText)) {
    throw new Error('prepared manifest does not bind the staged descriptor and server.properties.clean hash')
  }
  if (
    manifest.target?.levelName !== descriptor.values?.levelName ||
    String(manifest.target?.levelSeed) !== String(descriptor.values?.levelSeed) ||
    manifest.target?.sourceSha !== descriptor.values?.sourceSha
  ) throw new Error('prepared manifest target differs from clean-run descriptor')

  const commandLine = [executable, ...args].join('\0')
  return {
    record: 'clean-run-leaf-startup-attestation',
    schemaVersion: 1,
    capturedAt: startedAt,
    descriptor: {
      path: resolvedDescriptor,
      sha256: sha256Text(descriptorText),
      sourceSha: descriptor.values?.sourceSha ?? null,
      levelName: descriptor.values?.levelName ?? null,
      levelSeed: String(descriptor.values?.levelSeed ?? ''),
      serverId: descriptor.values?.serverId ?? null,
    },
    manifest: {
      path: resolve(manifestPath),
      sha256: sha256Text(manifestText),
      stagedPropertiesSha256: manifestFile.sha256,
    },
    process: {
      pid,
      startedAt,
      cwd: resolvedCwd,
      executable: resolve(executable),
      serverJar: serverJarArg,
      configArg: resolve(resolvedCwd, configArg),
      universeArg: resolve(resolvedCwd, universeArg),
      levelNameArg,
      commandLineSha256: createHash('sha256').update(Buffer.from(procCmdline.join('\0'))).digest('hex'),
      requestedArgvSha256: sha256Text(commandLine),
    },
    config: {
      path: resolvedProperties,
      sha256: sha256Text(propertiesText),
      properties: projectRuntimeServerProperties(parsed),
    },
    console: {
      directory: consoleDir,
      inputPath: resolvedConsoleInput,
      stdoutLogPath: resolvedStdoutLog,
      commandTranscriptPath: resolve(consoleDir, 'commands.jsonl'),
      capturePath: resolve(consoleDir, 'capture.json'),
      mode: 'run-private-fifo-and-log',
    },
  }
}

function writeAtomic(path, text) {
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  renameSync(tmp, path)
}

export async function runLauncher(options) {
  for (const path of [options.environment, options.properties, options.manifest]) {
    if (!existsSync(path)) throw new Error(`required startup input is missing: ${path}`)
  }
  if (existsSync(options.attestation)) throw new Error(`startup attestation already exists: ${options.attestation}`)
  const runDir = dirname(resolve(options.attestation))
  const consoleDir = resolve(runDir, 'server-console')
  const consoleInputPath = resolve(options.consoleInput)
  const stdoutLogPath = resolve(options.stdoutLog)
  if (consoleInputPath !== resolve(consoleDir, 'server-console.fifo') || stdoutLogPath !== resolve(consoleDir, 'leaf-server.log')) {
    throw new Error('console FIFO and server log must be the fixed paths inside this run directory')
  }
  const descriptorText = readFileSync(options.environment, 'utf8')
  const descriptor = JSON.parse(descriptorText)
  const propertiesText = readFileSync(options.properties, 'utf8')
  const manifestText = readFileSync(options.manifest, 'utf8')
  const args = options.commandArgs
  const actualConfigArg = commandOption(args, '--config')
  if (actualConfigArg === null || resolve(options.cwd, actualConfigArg) !== resolve(options.properties)) {
    throw new Error('Leaf command must pass the staged server.properties.clean through --config')
  }
  if (args.includes('--bonusChest')) throw new Error('Leaf command must omit --bonusChest for a clean world')
  // Check every descriptor/manifest/config invariant before launching Leaf.
  // The second build after spawn compares these requested arguments with /proc.
  buildLeafStartupAttestation({
    descriptorPath: options.environment,
    descriptorText,
    descriptor,
    propertiesPath: options.properties,
    propertiesText,
    manifestPath: options.manifest,
    manifestText,
    consoleInputPath,
    stdoutLogPath,
    cwd: options.cwd,
    executable: options.command,
    args,
    pid: 1,
    startedAt: new Date().toISOString(),
    procCmdline: [options.command, ...args],
  })
  mkdirSync(consoleDir, { recursive: false, mode: 0o700 })
  chmodSync(consoleDir, 0o700)
  const dirStats = lstatSync(consoleDir)
  if (!dirStats.isDirectory() || dirStats.uid !== process.getuid?.() || (dirStats.mode & 0o777) !== 0o700) {
    throw new Error('Leaf console directory must be an owner-only real directory')
  }
  for (const path of [consoleInputPath, stdoutLogPath]) {
    if (existsSync(path)) throw new Error(`run-private Leaf console path already exists: ${path}`)
  }
  // The server needs an operator console after startup. Give it an owner-only
  // FIFO and an owner-only run log, rather than /dev/null or a shared server.log.
  execFileSync('mkfifo', ['-m', '600', '--', consoleInputPath], { stdio: 'ignore' })
  const fifoStats = lstatSync(consoleInputPath)
  if (!fifoStats.isFIFO() || fifoStats.uid !== process.getuid?.() || (fifoStats.mode & 0o777) !== 0o600) throw new Error('could not create a private run-scoped Leaf console FIFO')
  const logFd = openSync(stdoutLogPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_APPEND, 0o600)
  chmodSync(stdoutLogPath, 0o600)
  const logStats = lstatSync(stdoutLogPath)
  if (!logStats.isFile() || logStats.uid !== process.getuid?.() || (logStats.mode & 0o777) !== 0o600) throw new Error('Leaf stdout log must be an owner-only regular file')
  const consoleFd = openSync(consoleInputPath, constants.O_RDWR)

  const child = spawn(options.command, args, { cwd: options.cwd, detached: true, stdio: [consoleFd, logFd, logFd] })
  try {
    await new Promise((resolvePromise, rejectPromise) => {
      child.once('error', rejectPromise)
      child.once('spawn', () => resolvePromise(null))
    })
  } finally {
    closeSync(consoleFd)
    closeSync(logFd)
  }
  child.unref()
  if (child.pid === undefined) throw new Error('Leaf did not expose a process id after spawn')
  const procPath = `/proc/${child.pid}/cmdline`
  let procArgs
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      procArgs = readFileSync(procPath).toString('utf8').split('\0').filter(Boolean)
      if (procArgs.length > 1) break
    } catch {
      // The process may need a short time to publish its procfs entry.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25))
  }
  if (procArgs === undefined || procArgs.length < 2) throw new Error('could not observe the spawned Leaf process argv')
  let attestation
  try {
    attestation = buildLeafStartupAttestation({
      descriptorPath: options.environment,
      descriptorText,
      descriptor,
      propertiesPath: options.properties,
      propertiesText,
      manifestPath: options.manifest,
      manifestText,
      consoleInputPath,
      stdoutLogPath,
      cwd: options.cwd,
      executable: options.command,
      args,
      pid: child.pid,
      startedAt: new Date().toISOString(),
      procCmdline: procArgs,
    })
    writeAtomic(options.attestation, `${JSON.stringify(attestation, null, 2)}\n`)
  } catch (error) {
    try { process.kill(child.pid, 'SIGTERM') } catch { /* process already exited */ }
    throw error
  }
  process.stdout.write(`LEAF_STARTUP_ATTESTATION pid=${child.pid} config=${attestation.config.path} sha256=${attestation.config.sha256} console=${attestation.console.inputPath} log=${attestation.console.stdoutLogPath}\n`)
  return attestation
}

if (import.meta.main) {
  try {
    await runLauncher(parseArgs(process.argv.slice(2)))
  } catch (error) {
    process.stderr.write(`LEAF_STARTUP_REFUSED reason=${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 2
  }
}
