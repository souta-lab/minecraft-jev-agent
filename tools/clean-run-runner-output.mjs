#!/usr/bin/env bun
// Create an empty owner-only runner.out for a fresh clean-run checkout.
// Exclusive creation prevents accidentally joining another run's authority log.
import { constants, fchmodSync, fstatSync, lstatSync, openSync, closeSync, chmodSync, mkdirSync, linkSync, unlinkSync, realpathSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = resolve(fileURLToPath(new URL('.', import.meta.url)))
const REPO_ROOT = resolve(HERE, '..')

export function parseArgs(argv) {
  const options = { root: REPO_ROOT }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--root') options.root = argv[++index] ?? null
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (options.help === true) return options
  if (typeof options.root !== 'string' || options.root.length === 0) throw new Error('--root requires a path')
  const root = resolve(options.root)
  const driverDir = join(root, 'packages/buddy-driver')
  return { ...options, root, driverDir, outputPath: join(driverDir, 'runner.out'), hostLockPath: join(driverDir, 'data', 'resident', 'host.lock'), controlSocketPath: join(driverDir, 'data', 'resident', 'control.sock') }
}

function assertRealDirectory(path, label) {
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || realpathSync(path) !== path) {
    throw new Error(`${label} must be a real owner-owned directory: ${path}`)
  }
}

function defaultResidentServiceActive() {
  const result = spawnSync('systemctl', ['--user', 'is-active', '--quiet', 'ai-buddy-resident.service'], { stdio: 'ignore' })
  if (result.error !== undefined) throw new Error(`cannot verify ai-buddy-resident.service is stopped: ${result.error.message}`)
  if (result.status === 0) return true
  if (result.status === 3 || result.status === 4) return false
  throw new Error(`cannot verify ai-buddy-resident.service state (systemctl exit=${String(result.status)})`)
}

function archiveRunnerOutput({ root, driverDir, outputPath }, isResidentServiceActive) {
  let existing
  try {
    existing = lstatSync(outputPath)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
  if (!existing.isFile() || existing.isSymbolicLink()) throw new Error(`refusing to archive non-regular runner.out: ${outputPath}`)
  if (existing.uid !== process.getuid?.()) throw new Error(`refusing to archive runner.out not owned by this user: ${outputPath}`)
  if (existing.nlink !== 1) throw new Error(`refusing to archive hard-linked runner.out (nlink=${existing.nlink}): ${outputPath}`)

  assertRealDirectory(root, 'checkout root')
  const runsDir = join(root, 'runs')
  try {
    lstatSync(runsDir)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    mkdirSync(runsDir, { mode: 0o700 })
  }
  assertRealDirectory(runsDir, 'runs directory')
  const archiveDir = join(runsDir, 'clean-run-runner-archives')
  try {
    lstatSync(archiveDir)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    mkdirSync(archiveDir, { mode: 0o700 })
  }
  const archiveDirStat = lstatSync(archiveDir)
  if (!archiveDirStat.isDirectory() || archiveDirStat.isSymbolicLink() || archiveDirStat.uid !== process.getuid?.() || realpathSync(archiveDir) !== archiveDir) {
    throw new Error(`runner.out archive directory is not a real owner-owned directory: ${archiveDir}`)
  }
  chmodSync(archiveDir, 0o700)

  let archivePath = null
  // A no-clobber move: a hard link claims an unoccupied unique archive name,
  // then unlink removes the active name. If interrupted between them, both
  // names still preserve the original bytes; no existing archive is replaced.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const nonce = randomBytes(8).toString('hex')
    const candidate = join(archiveDir, `runner.out.${Date.now()}.${process.pid}.${nonce}.archive`)
    try {
      linkSync(outputPath, candidate)
      archivePath = candidate
      break
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
  }
  if (archivePath === null) throw new Error('could not reserve a unique immutable runner.out archive name')

  const linked = lstatSync(archivePath)
  const stillCurrent = lstatSync(outputPath)
  if (!linked.isFile() || linked.isSymbolicLink() || linked.dev !== existing.dev || linked.ino !== existing.ino ||
      stillCurrent.dev !== existing.dev || stillCurrent.ino !== existing.ino || linked.nlink !== 2) {
    unlinkSync(archivePath)
    throw new Error('runner.out changed during archival; the original path was left untouched')
  }
  // Recheck immediately before moving in case a service came up during the
  // archive reservation. host.lock/control.sock are conservative live signals.
  if (lstatMaybe({ path: join(driverDir, 'data', 'resident', 'host.lock') }) ||
      lstatMaybe({ path: join(driverDir, 'data', 'resident', 'control.sock') })) {
    unlinkSync(archivePath)
    throw new Error('refusing runner.out rotation because a resident host lock/control socket appeared')
  }
  if (isResidentServiceActive()) {
    unlinkSync(archivePath)
    throw new Error('refusing runner.out rotation because ai-buddy-resident.service became active')
  }
  unlinkSync(outputPath)
  chmodSync(archivePath, 0o400)
  return archivePath
}

function lstatMaybe({ path }) {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

export function createRunnerOutput({ root, driverDir, outputPath, hostLockPath, controlSocketPath }, { isResidentServiceActive = defaultResidentServiceActive } = {}) {
  assertRealDirectory(root, 'checkout root')
  const driverStat = lstatSync(driverDir)
  if (!driverStat.isDirectory() || driverStat.isSymbolicLink() || realpathSync(driverDir) !== driverDir) throw new Error('buddy-driver must be an existing real directory')
  if (lstatMaybe({ path: hostLockPath ?? join(driverDir, 'data', 'resident', 'host.lock') }) ||
      lstatMaybe({ path: controlSocketPath ?? join(driverDir, 'data', 'resident', 'control.sock') })) {
    throw new Error('refusing runner.out rotation/creation while a resident host.lock or control.sock exists')
  }
  if (isResidentServiceActive()) throw new Error('refusing runner.out rotation/creation while ai-buddy-resident.service is active')
  const archivedPath = archiveRunnerOutput({ root, driverDir, outputPath }, isResidentServiceActive)
  if (lstatMaybe({ path: hostLockPath ?? join(driverDir, 'data', 'resident', 'host.lock') }) ||
      lstatMaybe({ path: controlSocketPath ?? join(driverDir, 'data', 'resident', 'control.sock') }) ||
      isResidentServiceActive()) {
    throw new Error(`refusing to create runner.out because resident activity started after rotation${archivedPath === null ? '' : `; old content preserved at ${archivedPath}`}`)
  }
  let fd
  try {
    fd = openSync(outputPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600)
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error(`refusing to overwrite or reuse existing runner.out: ${outputPath}${archivedPath === null ? '' : `; old content preserved at ${archivedPath}`}`)
    throw error
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.uid !== process.getuid?.()) throw new Error('new runner.out is not an owner-owned regular file')
    fchmodSync(fd, 0o600)
  } finally {
    closeSync(fd)
  }
  const finalStat = lstatSync(outputPath)
  if (!finalStat.isFile() || finalStat.isSymbolicLink() || finalStat.uid !== process.getuid?.() || (finalStat.mode & 0o777) !== 0o600 || finalStat.size !== 0) {
    throw new Error('runner.out was changed during exclusive creation')
  }
  return { status: archivedPath === null ? 'CREATED' : 'ARCHIVED_AND_CREATED', path: outputPath, mode: '0600', archivedPath }
}

export function runCli({ argv = process.argv.slice(2), write = (value) => process.stdout.write(value), writeError = (value) => process.stderr.write(value), isResidentServiceActive = defaultResidentServiceActive } = {}) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    writeError(`CLEAN_RUN_RUNNER_OUTPUT_ERROR ${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }
  if (options.help === true) {
    write('Usage: bun tools/clean-run-runner-output.mjs --root <checkout>\nWhen no resident is active, preserves any existing regular single-link runner.out under runs/clean-run-runner-archives and creates a fresh 0600 output.\n')
    return 0
  }
  try {
    const result = createRunnerOutput(options, { isResidentServiceActive })
    write(`CLEAN_RUN_RUNNER_OUTPUT status=${result.status} path=${result.path} mode=${result.mode} archived=${result.archivedPath ?? 'none'}\n`)
    return 0
  } catch (error) {
    writeError(`CLEAN_RUN_RUNNER_OUTPUT_ERROR ${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }
}

if (import.meta.main || process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = runCli()
