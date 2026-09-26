#!/usr/bin/env bun
// Refresh and verify the HOST acceptance artifact through its read-only control
// query. The request does not issue Minecraft commands or change the active goal.
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import net from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..')
const RUN_ID_RE = /^run-[A-Za-z0-9-]+$/
const SHA_RE = /^[a-f0-9]{40}$/i
const DEFAULT_TIMEOUT_MS = 10_000

export function parseArgs(argv) {
  const options = { root: REPO_ROOT, socket: null, runId: null, sourceSha: null, timeoutMs: DEFAULT_TIMEOUT_MS }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--root') options.root = argv[++index] ?? null
    else if (arg === '--socket') options.socket = argv[++index] ?? null
    else if (arg === '--run') options.runId = argv[++index] ?? null
    else if (arg === '--source-sha') options.sourceSha = argv[++index] ?? null
    else if (arg === '--timeout-ms') options.timeoutMs = Number(argv[++index])
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (options.help === true) return options
  if (typeof options.root !== 'string' || options.root.length === 0) throw new Error('--root requires a path')
  if (typeof options.runId !== 'string' || !RUN_ID_RE.test(options.runId)) throw new Error('--run must be an exact run-[A-Za-z0-9-]+ id')
  if (typeof options.sourceSha !== 'string' || !SHA_RE.test(options.sourceSha)) throw new Error('--source-sha must be a 40-hex source SHA')
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > 60_000) {
    throw new Error('--timeout-ms must be an integer from 100 to 60000')
  }
  const root = resolve(options.root)
  return {
    ...options,
    root,
    socket: resolve(options.socket ?? join(root, 'packages/buddy-driver', 'data', 'resident', 'control.sock')),
    sourceSha: options.sourceSha.toLowerCase(),
  }
}

export function requestAcceptance({ socketPath, requestId = `clean-run-${randomUUID()}`, timeoutMs = DEFAULT_TIMEOUT_MS, connect = net.createConnection } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    if (typeof socketPath !== 'string' || socketPath.length === 0) return rejectPromise(new Error('control socket path is required'))
    let socket
    let settled = false
    let buffer = ''
    const finish = (error, value = null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { socket?.destroy() } catch {}
      if (error !== null) rejectPromise(error)
      else resolvePromise(value)
    }
    const timer = setTimeout(() => finish(new Error(`acceptance query timed out after ${timeoutMs}ms`)), timeoutMs)
    try {
      socket = connect(socketPath)
    } catch (error) {
      finish(new Error(`cannot open control socket: ${String(error)}`))
      return
    }
    socket.on('error', (error) => finish(new Error(`control socket error: ${error.message}`)))
    socket.on('end', () => {
      if (!settled) finish(new Error('control socket closed before a complete response line'))
    })
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      if (buffer.length > 1_000_000) return finish(new Error('control socket response exceeded 1 MB'))
      const lineEnd = buffer.indexOf('\n')
      if (lineEnd < 0) return
      let response
      try {
        response = JSON.parse(buffer.slice(0, lineEnd))
      } catch (error) {
        return finish(new Error(`control socket returned invalid JSON: ${String(error)}`))
      }
      if (response?.id !== requestId) return finish(new Error(`control response id mismatch expected=${requestId} observed=${String(response?.id ?? null)}`))
      if (response?.ok !== true) return finish(new Error(`acceptance query was rejected: ${String(response?.data?.error ?? response?.error ?? 'not-ok')}`))
      finish(null, response)
    })
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ id: requestId, cmd: 'acceptance', args: {} })}\n`)
    })
  })
}

export async function refreshAcceptance({ root = REPO_ROOT, socketPath = null, runId, sourceSha, timeoutMs = DEFAULT_TIMEOUT_MS, connect = net.createConnection } = {}) {
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) throw new Error('an exact runId is required')
  if (typeof sourceSha !== 'string' || !SHA_RE.test(sourceSha)) throw new Error('the expected source SHA must be 40 hexadecimal characters')
  const resolvedRoot = resolve(root)
  const resolvedSocket = resolve(socketPath ?? join(resolvedRoot, 'packages/buddy-driver', 'data', 'resident', 'control.sock'))
  const expectedArtifactPath = resolve(join(resolvedRoot, 'packages/buddy-driver', 'data', 'resident', `acceptance-${runId}.json`))
  const requestId = `clean-run-${randomUUID()}`
  const response = await requestAcceptance({ socketPath: resolvedSocket, requestId, timeoutMs, connect })
  const reportedPath = response?.data?.path
  if (typeof reportedPath !== 'string' || resolve(reportedPath) !== expectedArtifactPath) {
    throw new Error(`HOST acceptance path mismatch expected=${expectedArtifactPath} observed=${String(reportedPath ?? null)}`)
  }
  if (!existsSync(expectedArtifactPath)) throw new Error(`HOST acceptance artifact was not written: ${expectedArtifactPath}`)
  let artifact
  try {
    artifact = JSON.parse(readFileSync(expectedArtifactPath, 'utf8'))
  } catch (error) {
    throw new Error(`HOST acceptance artifact is unreadable: ${String(error)}`)
  }
  if (artifact?.record !== 'acceptance' || artifact.runId !== runId) {
    throw new Error(`HOST acceptance run binding mismatch expected=${runId} observed=${String(artifact?.runId ?? null)}`)
  }
  if (typeof artifact.gitCommit !== 'string' || artifact.gitCommit.toLowerCase() !== sourceSha.toLowerCase()) {
    throw new Error(`HOST acceptance source mismatch expected=${sourceSha} observed=${String(artifact.gitCommit ?? null)}`)
  }
  return { status: 'VERIFIED', runId, sourceSha: sourceSha.toLowerCase(), path: expectedArtifactPath, requestId }
}

export async function runCli({ argv = process.argv.slice(2), write = (value) => process.stdout.write(value), writeError = (value) => process.stderr.write(value) } = {}) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    writeError(`CLEAN_RUN_ACCEPTANCE_REFRESH_ERROR ${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }
  if (options.help === true) {
    write('Usage: bun tools/clean-run-acceptance-refresh.mjs --run <runId> --source-sha <40-hex> [--root <repo>] [--socket <path>] [--timeout-ms <100..60000>]\n')
    return 0
  }
  try {
    const result = await refreshAcceptance({
      root: options.root,
      socketPath: options.socket,
      runId: options.runId,
      sourceSha: options.sourceSha,
      timeoutMs: options.timeoutMs,
    })
    write(`CLEAN_RUN_ACCEPTANCE_REFRESH status=${result.status} runId=${result.runId} sourceSha=${result.sourceSha} path=${result.path}\n`)
    return 0
  } catch (error) {
    writeError(`CLEAN_RUN_ACCEPTANCE_REFRESH_ERROR ${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }
}

if (import.meta.main || process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCli()
}
