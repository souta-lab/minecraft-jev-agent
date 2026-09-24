#!/usr/bin/env bun
// Start the staged Leaf server and record the exact startup config/argv before
// handing the child off. This wrapper is the only M3 command emitted by prepare.
import { createHash } from 'node:crypto'
import { chmodSync, closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, writeFileSync, writeSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { expectedConsoleQueries } from './clean-run-console-capture.mjs'
import {
  assertExactLeafArgv,
  compareRuntimeServerProperties,
  EXPECTED_JAVA_EXECUTABLE,
  expectedLeafLaunchIdentity,
  expectedLeafServerArgs,
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
  procExecutablePath,
  procExecutableSha256,
}) {
  const resolvedDescriptor = resolve(descriptorPath)
  const resolvedProperties = resolve(propertiesPath)
  const resolvedConsoleInput = resolve(consoleInputPath)
  const resolvedStdoutLog = resolve(stdoutLogPath)
  const relayJournalPath = resolve(dirname(resolvedConsoleInput), 'leaf-console-relay.jsonl')
  const resolvedCwd = resolve(cwd)
  const expectedPropertiesPath = resolve(dirname(resolvedDescriptor), 'server.properties.clean')
  const consoleDir = resolve(dirname(resolvedDescriptor), 'server-console')
  if (resolvedConsoleInput !== resolve(consoleDir, 'server-console.fifo')) throw new Error('Leaf console input must use this run directory FIFO')
  if (resolvedStdoutLog !== resolve(consoleDir, 'leaf-server.log')) throw new Error('Leaf output must use this run directory log')
  if (resolvedProperties !== expectedPropertiesPath) throw new Error('Leaf config must be the staged sibling server.properties.clean')
  if (resolvedCwd !== resolve(descriptor.cleanRun?.worldContainer ?? '')) throw new Error('Leaf working directory must be the descriptor worldContainer')
  if (!Number.isInteger(pid) || pid < 1) throw new Error('Leaf process pid is missing')
  const expectedArgs = expectedLeafServerArgs(descriptor, resolvedProperties, resolvedCwd)
  assertExactLeafArgv(args, expectedArgs, 'requested Leaf')
  const launchIdentity = expectedLeafLaunchIdentity(descriptor, resolvedCwd)
  const manifest = JSON.parse(manifestText)
  if (JSON.stringify(manifest.serverLaunch ?? null) !== JSON.stringify(launchIdentity)) {
    throw new Error('prepared manifest does not bind expected Java and Leaf JAR identity')
  }
  if (resolve(executable) !== resolve(EXPECTED_JAVA_EXECUTABLE) || realpathSync(executable) !== launchIdentity.java.realpath) {
    throw new Error('Leaf executable is not the expected Java runtime')
  }
  if (procExecutablePath !== launchIdentity.java.realpath || procExecutableSha256 !== launchIdentity.java.sha256) {
    throw new Error('observed process executable is not the expected Java runtime identity')
  }
  const configArg = commandOption(args, '--config')
  const universeArg = commandOption(args, '--universe')
  const levelNameArg = commandOption(args, '--level-name')
  const jarIndex = args.indexOf('-jar')
  const serverJarArg = jarIndex < 0 ? null : args[jarIndex + 1] ?? null
  if (args.includes('--bonusChest')) throw new Error('Leaf argv must omit --bonusChest for a clean world')
  if (resolve(resolvedCwd, configArg ?? '') !== resolvedProperties) throw new Error('Leaf argv --config does not select the staged server.properties.clean')
  if (resolve(resolvedCwd, universeArg ?? '') !== resolve(descriptor.cleanRun?.worldContainer ?? '')) throw new Error('Leaf argv --universe differs from descriptor worldContainer')
  if (levelNameArg !== descriptor.values?.levelName) throw new Error('Leaf argv --level-name differs from descriptor levelName')
  if (serverJarArg !== descriptor.values?.serverImplementation || resolve(resolvedCwd, serverJarArg ?? '') !== launchIdentity.serverJar.path) {
    throw new Error('Leaf argv server jar path differs from expected descriptor jar')
  }
  const parsed = parseServerProperties(propertiesText)
  const comparison = compareRuntimeServerProperties(descriptor, parsed)
  if (!comparison.agrees) throw new Error(`staged server.properties differs from descriptor: ${[...comparison.missing, ...comparison.mismatches].join('; ')}`)
  const actualArgs = Array.isArray(procCmdline) ? procCmdline : []
  if (actualArgs[0] !== executable) throw new Error('spawned Leaf process argv[0] differs from the requested Java executable')
  assertExactLeafArgv(actualArgs.slice(1), expectedArgs, 'observed Leaf')
  const paperIgnoreJavaVersion = actualArgs.includes('-DPaper.IgnoreJavaVersion=true')
  if (paperIgnoreJavaVersion !== launchIdentity.paperIgnoreJavaVersion) {
    throw new Error('observed Paper.IgnoreJavaVersion runtime flag differs from descriptor policy')
  }
  const actualConfig = commandOption(actualArgs.slice(1), '--config')
  const actualUniverse = commandOption(actualArgs.slice(1), '--universe')
  const actualLevelName = commandOption(actualArgs.slice(1), '--level-name')
  const actualJarIndex = actualArgs.indexOf('-jar')
  const actualJar = actualJarIndex < 0 ? null : actualArgs[actualJarIndex + 1] ?? null
  if (
    actualConfig === null || resolve(resolvedCwd, actualConfig) !== resolvedProperties ||
    actualUniverse === null || resolve(resolvedCwd, actualUniverse) !== resolve(descriptor.cleanRun?.worldContainer ?? '') ||
    actualLevelName !== descriptor.values?.levelName || actualArgs.includes('--bonusChest') ||
    actualJar !== descriptor.values?.serverImplementation || resolve(resolvedCwd, actualJar ?? '') !== launchIdentity.serverJar.path
  ) throw new Error('spawned Leaf process argv does not match requested clean-run target')

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
    schemaVersion: 2,
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
    runtime: {
      java: launchIdentity.java,
      paperIgnoreJavaVersion,
    },
    process: {
      pid,
      startedAt,
      cwd: resolvedCwd,
      executable: resolve(executable),
      executableRealpath: launchIdentity.java.realpath,
      executableSha256: procExecutableSha256,
      argv: actualArgs,
      serverJar: serverJarArg,
      serverJarPath: launchIdentity.serverJar.path,
      serverJarRealpath: launchIdentity.serverJar.realpath,
      serverJarSha256: launchIdentity.serverJar.sha256,
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
      relayJournalPath,
      mode: 'run-private-fifo-and-log',
    },
  }
}

function writeAtomic(path, text) {
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  renameSync(tmp, path)
}

function appendJournal(fd, row) {
  writeSync(fd, Buffer.from(`${JSON.stringify(row)}\n`, 'utf8'))
  fsyncSync(fd)
}

async function relayConsoleInput({ fifoPath, relayJournalPath, child, descriptor, leafPid }) {
  const allowed = ['seed', ...expectedConsoleQueries(descriptor).queries.map((query) => query.command)]
  const relayFd = openSync(fifoPath, constants.O_RDWR | constants.O_NONBLOCK)
  const journalFd = openSync(relayJournalPath, constants.O_APPEND | constants.O_WRONLY)
  chmodSync(relayJournalPath, 0o600)
  const at = () => new Date().toISOString()
  let nextAllowedIndex = 0
  let buffer = Buffer.alloc(0)
  let childExit = null
  const waitForExit = new Promise((resolvePromise) => child.once('exit', (code, signal) => {
    childExit = { code, signal }
    resolvePromise(childExit)
  }))
  const onTerminate = () => { try { child.kill('SIGTERM') } catch { /* process already exited */ } }
  process.on('SIGTERM', onTerminate)
  appendJournal(journalFd, { event: 'console-relay-start', leafPid, launcherPid: process.pid, expectedCommandCount: allowed.length, at: at() })
  try {
    while (childExit === null) {
      const chunk = Buffer.alloc(4096)
      let bytesRead = 0
      try {
        bytesRead = readSync(relayFd, chunk, 0, chunk.length, null)
      } catch (error) {
        if (!['EAGAIN', 'EWOULDBLOCK'].includes(error?.code)) throw error
      }
      if (bytesRead > 0) {
        const incoming = chunk.subarray(0, bytesRead)
        appendJournal(journalFd, { event: 'console-relay-input', leafPid, byteLength: bytesRead, sha256: createHash('sha256').update(incoming).digest('hex'), at: at() })
        buffer = Buffer.concat([buffer, incoming])
        let newline
        while ((newline = buffer.indexOf(0x0a)) >= 0) {
          const raw = buffer.subarray(0, newline)
          buffer = buffer.subarray(newline + 1)
          const command = raw.toString('utf8').replace(/\r$/, '')
          if (raw.includes(0x00) || command !== allowed[nextAllowedIndex]) {
            appendJournal(journalFd, { event: 'console-relay-rejected', leafPid, sequence: nextAllowedIndex, commandSha256: createHash('sha256').update(raw).digest('hex'), byteLength: raw.length, at: at() })
            continue
          }
          try {
            await new Promise((resolvePromise, rejectPromise) => {
              child.stdin.write(`${command}\n`, (error) => error ? rejectPromise(error) : resolvePromise(null))
            })
          } catch (error) {
            appendJournal(journalFd, { event: 'console-relay-forward-failed', leafPid, sequence: nextAllowedIndex, command, reason: String(error?.code ?? error?.message ?? error), at: at() })
            continue
          }
          appendJournal(journalFd, { event: 'console-relay-forwarded', leafPid, sequence: nextAllowedIndex, command, at: at() })
          nextAllowedIndex += 1
        }
        appendJournal(journalFd, {
          event: 'console-relay-buffer-state', leafPid, byteLength: buffer.length,
          sha256: createHash('sha256').update(buffer).digest('hex'), at: at(),
        })
        if (buffer.length > 4096) {
          appendJournal(journalFd, { event: 'console-relay-partial-rejected', leafPid, byteLength: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex'), at: at() })
          buffer = Buffer.alloc(0)
        }
      }
      await Promise.race([waitForExit, new Promise((resolvePromise) => setTimeout(resolvePromise, 20))])
    }
    if (buffer.length > 0) appendJournal(journalFd, { event: 'console-relay-partial-rejected', leafPid, byteLength: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex'), at: at() })
    appendJournal(journalFd, { event: 'console-relay-server-exit', leafPid, ...childExit, forwardedCount: nextAllowedIndex, rejected: buffer.length > 0 || nextAllowedIndex !== allowed.length, at: at() })
  } finally {
    process.off('SIGTERM', onTerminate)
    closeSync(relayFd)
    closeSync(journalFd)
  }
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
  const relayJournalPath = resolve(consoleDir, 'leaf-console-relay.jsonl')
  if (consoleInputPath !== resolve(consoleDir, 'server-console.fifo') || stdoutLogPath !== resolve(consoleDir, 'leaf-server.log')) {
    throw new Error('console FIFO and server log must be the fixed paths inside this run directory')
  }
  const descriptorText = readFileSync(options.environment, 'utf8')
  const descriptor = JSON.parse(descriptorText)
  const propertiesText = readFileSync(options.properties, 'utf8')
  const manifestText = readFileSync(options.manifest, 'utf8')
  const args = options.commandArgs
  const expectedLaunchIdentity = expectedLeafLaunchIdentity(descriptor, options.cwd)
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
    procExecutablePath: expectedLaunchIdentity.java.realpath,
    procExecutableSha256: expectedLaunchIdentity.java.sha256,
  })
  mkdirSync(consoleDir, { recursive: false, mode: 0o700 })
  chmodSync(consoleDir, 0o700)
  const dirStats = lstatSync(consoleDir)
  if (!dirStats.isDirectory() || dirStats.uid !== process.getuid?.() || (dirStats.mode & 0o777) !== 0o700) {
    throw new Error('Leaf console directory must be an owner-only real directory')
  }
  for (const path of [consoleInputPath, stdoutLogPath, relayJournalPath]) {
    if (existsSync(path)) throw new Error(`run-private Leaf console path already exists: ${path}`)
  }
  // The server needs an operator console after startup. Give it an owner-only
  // FIFO and an owner-only run log, rather than /dev/null or a shared server.log.
  execFileSync('mkfifo', ['-m', '600', '--', consoleInputPath], { stdio: 'ignore' })
  const fifoStats = lstatSync(consoleInputPath)
  if (!fifoStats.isFIFO() || fifoStats.uid !== process.getuid?.() || (fifoStats.mode & 0o777) !== 0o600) throw new Error('could not create a private run-scoped Leaf console FIFO')
  const relayInitFd = openSync(relayJournalPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
  closeSync(relayInitFd)
  chmodSync(relayJournalPath, 0o600)
  const relayStat = lstatSync(relayJournalPath)
  if (!relayStat.isFile() || relayStat.isSymbolicLink() || relayStat.uid !== process.getuid?.() || (relayStat.mode & 0o777) !== 0o600) throw new Error('Leaf console relay journal must be owner-only')
  const logFd = openSync(stdoutLogPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_APPEND, 0o600)
  chmodSync(stdoutLogPath, 0o600)
  const logStats = lstatSync(stdoutLogPath)
  if (!logStats.isFile() || logStats.uid !== process.getuid?.() || (logStats.mode & 0o777) !== 0o600) throw new Error('Leaf stdout log must be an owner-only regular file')
  const child = spawn(options.command, args, { cwd: options.cwd, detached: true, stdio: ['pipe', logFd, logFd] })
  try {
    await new Promise((resolvePromise, rejectPromise) => {
      child.once('error', rejectPromise)
      child.once('spawn', () => resolvePromise(null))
    })
  } finally {
    closeSync(logFd)
  }
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
    const procExecutablePath = realpathSync(`/proc/${child.pid}/exe`)
    const procExecutableSha256 = createHash('sha256').update(readFileSync(`/proc/${child.pid}/exe`)).digest('hex')
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
      procExecutablePath,
      procExecutableSha256,
    })
    writeAtomic(options.attestation, `${JSON.stringify(attestation, null, 2)}\n`)
  } catch (error) {
    try { process.kill(child.pid, 'SIGTERM') } catch { /* process already exited */ }
    throw error
  }
  process.stdout.write(`LEAF_STARTUP_ATTESTATION pid=${child.pid} config=${attestation.config.path} sha256=${attestation.config.sha256} console=${attestation.console.inputPath} log=${attestation.console.stdoutLogPath}\n`)
  await relayConsoleInput({ fifoPath: consoleInputPath, relayJournalPath: attestation.console.relayJournalPath, child, descriptor, leafPid: child.pid })
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
