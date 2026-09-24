#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { refreshAcceptance, runCli } from './clean-run-acceptance-refresh.mjs'

const ROOTS = []
const SOURCE_SHA = 'c4698e51a98d2a484e43b94112ded3433bdea3f7'
const RUN = 'run-refresh-fixture'
function root() {
  const path = mkdtempSync(join(tmpdir(), 'clean-run-acceptance-refresh-'))
  ROOTS.push(path)
  mkdirSync(join(path, 'buddy-driver', 'data', 'resident'), { recursive: true })
  return path
}
function listen(path, handler) {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = net.createServer(handler)
    server.once('error', rejectPromise)
    server.listen(path, () => resolvePromise(server))
  })
}
function close(server) {
  return new Promise((resolvePromise) => server.close(resolvePromise))
}
function makeReplyServer(rootDir, { runId = RUN, sourceSha = SOURCE_SHA, ok = true, reportedPath = null } = {}) {
  const socketPath = join(rootDir, 'control.sock')
  const expectedPath = join(rootDir, 'buddy-driver', 'data', 'resident', `acceptance-${RUN}.json`)
  return listen(socketPath, (socket) => {
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      const end = buffer.indexOf('\n')
      if (end < 0) return
      const request = JSON.parse(buffer.slice(0, end))
      assert.equal(request.cmd, 'acceptance')
      assert.deepEqual(request.args, {})
      if (ok) {
        writeFileSync(expectedPath, `${JSON.stringify({ record: 'acceptance', runId, gitCommit: sourceSha })}\n`)
      }
      socket.end(`${JSON.stringify({ id: request.id, ok, data: ok ? { path: reportedPath ?? expectedPath } : { error: 'no live bot' } })}\n`)
    })
  })
}

{
  const rootDir = root()
  const socketPath = join(rootDir, 'control.sock')
  const server = await makeReplyServer(rootDir)
  const result = await refreshAcceptance({ root: rootDir, socketPath, runId: RUN, sourceSha: SOURCE_SHA, timeoutMs: 500 })
  assert.equal(result.status, 'VERIFIED')
  assert.equal(result.runId, RUN)
  assert.equal(result.sourceSha, SOURCE_SHA)
  assert.equal(result.path, resolve(rootDir, 'buddy-driver', 'data', 'resident', `acceptance-${RUN}.json`))
  await close(server)
  console.log('  ok - query sends only cmd=acceptance and verifies same-run/source HOST artifact')
}

for (const failure of [
  { label: 'wrong run', runId: 'run-other', sourceSha: SOURCE_SHA, message: /run binding mismatch/ },
  { label: 'wrong source', runId: RUN, sourceSha: 'f'.repeat(40), message: /source mismatch/ },
]) {
  const rootDir = root()
  const socketPath = join(rootDir, 'control.sock')
  const server = await makeReplyServer(rootDir, { runId: failure.runId, sourceSha: failure.sourceSha })
  await assert.rejects(
    refreshAcceptance({ root: rootDir, socketPath, runId: RUN, sourceSha: SOURCE_SHA, timeoutMs: 500 }),
    failure.message,
    failure.label,
  )
  await close(server)
  console.log(`  ok - rejects ${failure.label} acceptance artifact`)
}

{
  const rootDir = root()
  let stdout = ''
  let stderr = ''
  const code = await runCli({ argv: ['--help'], write: (value) => { stdout += value }, writeError: (value) => { stderr += value } })
  assert.equal(code, 0)
  assert.match(stdout, /--source-sha/)
  assert.equal(stderr, '')
  console.log('  ok - CLI help documents the exact source binding')
}

for (const dir of ROOTS) rmSync(dir, { recursive: true, force: true })
console.log('test-clean-run-acceptance-refresh: 4 checks passed')
