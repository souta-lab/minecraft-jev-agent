#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stopLegacyResident, runCli } from './clean-run-resident-control.mjs'

const ROOTS = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'clean-run-resident-control-'))
  ROOTS.push(root)
  const residentDir = join(root, 'buddy-driver', 'data', 'resident')
  mkdirSync(residentDir, { recursive: true })
  const socketPath = join(residentDir, 'control.sock')
  const lockPath = join(residentDir, 'host.lock')
  writeFileSync(lockPath, '1234\n')
  return { root, socketPath, lockPath }
}

function listen(socketPath, onRequest) {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = net.createServer((socket) => {
      let buffer = ''
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8')
        const end = buffer.indexOf('\n')
        if (end < 0) return
        onRequest(JSON.parse(buffer.slice(0, end)), socket, server)
      })
    })
    server.once('error', rejectPromise)
    server.listen(socketPath, () => resolvePromise(server))
  })
}

{
  const paths = fixture()
  let released
  const releasedPromise = new Promise((resolvePromise) => { released = resolvePromise })
  const server = await listen(paths.socketPath, (request, socket, activeServer) => {
    assert.match(request.id, /^clean-run-quit-/)
    assert.equal(request.cmd, 'quit')
    assert.deepEqual(request.args, {})
    socket.end(`${JSON.stringify({ id: request.id, ok: true, data: { quitting: true } })}\n`)
    socket.once('close', () => {
      rmSync(paths.lockPath, { force: true })
      activeServer.close(() => {
        rmSync(paths.socketPath, { force: true })
        released()
      })
    })
  })
  const result = await stopLegacyResident({ ...paths, timeoutMs: 2_000 })
  await releasedPromise
  assert.equal(result.status, 'STOPPED')
  assert.equal(result.socketPath, paths.socketPath)
  console.log('  ok - sends the resident native cmd=quit and waits for socket + HOST lock release')
}

{
  const paths = fixture()
  const server = await listen(paths.socketPath, (request, socket) => {
    socket.end(`${JSON.stringify({ id: request.id, ok: false, data: { error: 'already stopping' } })}\n`)
  })
  await assert.rejects(stopLegacyResident({ ...paths, timeoutMs: 500 }), /resident refused graceful quit/)
  await new Promise((resolvePromise) => server.close(resolvePromise))
  console.log('  ok - refuses a quit request rejected by the resident')
}

{
  const paths = fixture()
  let stdout = ''
  let stderr = ''
  const status = await runCli({
    argv: ['--help'],
    write: (value) => { stdout += value },
    writeError: (value) => { stderr += value },
  })
  assert.equal(status, 0)
  assert.match(stdout, /cmd=quit/)
  assert.equal(stderr, '')
  console.log('  ok - operator CLI documents the limited stop operation')
}

for (const root of ROOTS) rmSync(root, { recursive: true, force: true })
console.log('test-clean-run-resident-control: 3 checks passed')
