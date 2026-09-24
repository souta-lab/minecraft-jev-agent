#!/usr/bin/env bun
// Gracefully stop a legacy directly launched resident through its native
// Unix-domain control socket, then wait until its socket and HOST lock release.
// Managed systemd residents should be stopped with `systemctl --user stop`.
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync } from 'node:fs'
import net from 'node:net'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = resolve(fileURLToPath(new URL('.', import.meta.url)))
const REPO_ROOT = resolve(HERE, '..')
const DEFAULT_TIMEOUT_MS = 30_000

export function parseArgs(argv) {
  const options = { root: REPO_ROOT, timeoutMs: DEFAULT_TIMEOUT_MS }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--root') options.root = argv[++index] ?? null
    else if (arg === '--timeout-ms') options.timeoutMs = Number(argv[++index])
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (options.help === true) return options
  if (typeof options.root !== 'string' || options.root.length === 0) throw new Error('--root requires a path')
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > 60_000) {
    throw new Error('--timeout-ms must be an integer from 100 to 60000')
  }
  const root = resolve(options.root)
  const residentDir = join(root, 'buddy-driver', 'data', 'resident')
  return {
    ...options,
    root,
    residentDir,
    socketPath: join(residentDir, 'control.sock'),
    lockPath: join(residentDir, 'host.lock'),
  }
}

export function requestQuit({ socketPath, timeoutMs = DEFAULT_TIMEOUT_MS, connect = net.createConnection } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    if (typeof socketPath !== 'string' || socketPath.length === 0) return rejectPromise(new Error('resident control socket path is required'))
    let socket
    let settled = false
    let buffer = ''
    const requestId = `clean-run-quit-${randomUUID()}`
    const finish = (error, value = null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { socket?.destroy() } catch {}
      if (error !== null) rejectPromise(error)
      else resolvePromise(value)
    }
    const timer = setTimeout(() => finish(new Error(`resident quit request timed out after ${timeoutMs}ms`)), timeoutMs)
    try {
      socket = connect(socketPath)
    } catch (error) {
      finish(new Error(`cannot open resident control socket: ${String(error)}`))
      return
    }
    socket.on('error', (error) => finish(new Error(`resident control socket error: ${error.message}`)))
    socket.on('end', () => {
      if (!settled) finish(new Error('resident control socket closed before a complete quit response'))
    })
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      if (buffer.length > 64 * 1024) return finish(new Error('resident control response exceeded 64 KB'))
      const lineEnd = buffer.indexOf('\n')
      if (lineEnd < 0) return
      let response
      try {
        response = JSON.parse(buffer.slice(0, lineEnd))
      } catch (error) {
        return finish(new Error(`resident control socket returned invalid JSON: ${String(error)}`))
      }
      if (response?.id !== requestId) return finish(new Error(`resident control response id mismatch expected=${requestId} observed=${String(response?.id ?? null)}`))
      if (response?.ok !== true || response?.data?.quitting !== true) {
        return finish(new Error(`resident refused graceful quit: ${String(response?.data?.error ?? 'unexpected response')}`))
      }
      finish(null, { requestId, response })
    })
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ id: requestId, cmd: 'quit', args: {} })}\n`, (error) => {
        if (error) finish(new Error(`failed to send resident quit request: ${error.message}`))
      })
    })
  })
}

async function waitForRelease({ socketPath, lockPath, timeoutMs, now = Date.now, sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)) }) {
  const deadline = now() + timeoutMs
  while (now() < deadline) {
    let socketPresent = existsSync(socketPath)
    if (socketPresent) {
      try { socketPresent = lstatSync(socketPath).isSocket() } catch { socketPresent = false }
    }
    if (!socketPresent && !existsSync(lockPath)) return
    await sleep(25)
  }
  throw new Error(`resident did not release its control socket and HOST lock within ${timeoutMs}ms`)
}

export async function stopLegacyResident({ socketPath, lockPath, timeoutMs = DEFAULT_TIMEOUT_MS, connect = net.createConnection, wait = waitForRelease } = {}) {
  let socketStat
  try {
    socketStat = lstatSync(socketPath)
  } catch (error) {
    throw new Error(`legacy resident control socket is unavailable: ${String(error?.code ?? error?.message ?? error)}`)
  }
  if (!socketStat.isSocket()) throw new Error('legacy resident control path is not a Unix socket')
  const { requestId } = await requestQuit({ socketPath, timeoutMs, connect })
  await wait({ socketPath, lockPath, timeoutMs })
  return { status: 'STOPPED', requestId, socketPath, lockPath }
}

export async function runCli({ argv = process.argv.slice(2), write = (value) => process.stdout.write(value), writeError = (value) => process.stderr.write(value) } = {}) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    writeError(`CLEAN_RUN_RESIDENT_CONTROL_ERROR ${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }
  if (options.help === true) {
    write('Usage: bun tools/clean-run-resident-control.mjs --root <frozen-checkout> [--timeout-ms <100..60000>]\nSends only cmd=quit to a legacy direct resident, then waits for control.sock and host.lock removal.\n')
    return 0
  }
  try {
    const result = await stopLegacyResident(options)
    write(`CLEAN_RUN_RESIDENT_CONTROL status=${result.status} requestId=${result.requestId} socket=${result.socketPath}\n`)
    return 0
  } catch (error) {
    writeError(`CLEAN_RUN_RESIDENT_CONTROL_ERROR ${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }
}

if (import.meta.main || process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCli()
}
