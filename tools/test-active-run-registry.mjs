#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  writeActiveRunRegistry,
  clearActiveRunRegistry,
  updateActiveRunMinor,
} from './capability-run.mjs'

const tempRoot = mkdtempSync(join(tmpdir(), 'active-run-registry-'))
const registryPath = join(tempRoot, 'active-run.json')

const record = (over = {}) => ({
  record: 'capability-active-run',
  schemaVersion: 1,
  status: 'active',
  runId: 'portal-t1',
  runDir: join(tempRoot, 'portal-t1'),
  claimToken: 'portal-t1#100#a',
  activeMinor: 'portal-t1',
  segmentId: 'portal-t1',
  hostBootSha: 'a'.repeat(40),
  generationSourceSha: 'a'.repeat(40),
  sha: 'a'.repeat(40),
  seed: '1',
  port: 29999,
  runnerPid: 100,
  residentPid: 101,
  ...over,
})

let pass = 0
const check = (name, fn) => {
  fn()
  pass += 1
  console.log(`ok ${pass} - ${name}`)
}

try {
  check('atomic write: roundtrip + no sibling tmp left visible', () => {
    writeActiveRunRegistry(record(), registryPath)
    const stored = JSON.parse(readFileSync(registryPath, 'utf8'))
    assert.equal(stored.runId, 'portal-t1')
    assert.equal(readdirSync(tempRoot).filter((f) => f.includes('.tmp')).length, 0)
  })

  check('stale owner cleanup cannot unlink a newer same-runId minor entry', () => {
    writeActiveRunRegistry(record(), registryPath)
    const swapped = updateActiveRunMinor({ activeMinor: 'portal-t1.1', segmentId: 'portal-t1.1' }, registryPath)
    assert.notEqual(swapped.claimToken, 'portal-t1#100#a')
    // Old owner cleans up with its own (rotated-away) token.
    clearActiveRunRegistry('portal-t1', 'portal-t1#100#a', registryPath)
    assert.equal(existsSync(registryPath), true, 'newer minor entry must survive stale cleanup')
  })

  check('current owner cleanup clears', () => {
    const cur = JSON.parse(readFileSync(registryPath, 'utf8'))
    clearActiveRunRegistry('portal-t1', cur.claimToken, registryPath)
    assert.equal(existsSync(registryPath), false)
  })

  check('different major runId cleanup never touches the entry', () => {
    writeActiveRunRegistry(record(), registryPath)
    clearActiveRunRegistry('portal-other', 'portal-t1#100#a', registryPath)
    assert.equal(existsSync(registryPath), true)
  })

  check('legacy record (no claimToken) still clears by runId', () => {
    const legacy = record()
    delete legacy.claimToken
    writeActiveRunRegistry(legacy, registryPath)
    clearActiveRunRegistry('portal-t1', null, registryPath)
    assert.equal(existsSync(registryPath), false)
  })

  check('minor update preserves major identity, stamps segment fields', () => {
    writeActiveRunRegistry(record(), registryPath)
    const next = updateActiveRunMinor({
      activeMinor: 'portal-t1.3',
      segmentId: 'portal-t1.3',
      sha: 'b'.repeat(40),
      generationSourceSha: 'b'.repeat(40),
      runtimeDir: '/x/src-t1.3/packages/buddy-driver',
      residentPid: 424199,
      residentStdout: '/x/resident-t1.3-stdout.log',
      boundary: 'generation-reload',
    }, registryPath)
    assert.equal(next.runId, 'portal-t1')
    assert.equal(next.runDir, join(tempRoot, 'portal-t1'))
    assert.equal(next.activeMinor, 'portal-t1.3')
    assert.equal(next.hostBootSha, 'a'.repeat(40), 'host boot sha unchanged by generation reload')
    assert.equal(next.generationSourceSha, 'b'.repeat(40))
    assert.equal(next.status, 'active')
    assert.equal(typeof next.swappedAt, 'string')
  })

  check('minor update refuses runId rename and missing registry', () => {
    assert.throws(() => updateActiveRunMinor({ runId: 'portal-t2' }, registryPath), /cannot rename/u)
    rmSync(registryPath)
    assert.throws(() => updateActiveRunMinor({ activeMinor: 'portal-t1.9' }, registryPath), /no active-run registry/u)
  })

  console.log(`\n${pass}/${pass} active-run registry cases pass`)
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}
