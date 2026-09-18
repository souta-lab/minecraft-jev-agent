#!/usr/bin/env node
// test-m2-watch: offline fixtures for tools/m2-watch.mjs exit-code contract.
// all markers present -> 0; missing SMELT_DONE -> 1; unreadable -> 2.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const helper = join(repoRoot, 'tools', 'm2-watch.mjs')
const dir = mkdtempSync(join(tmpdir(), 'm2-watch-'))

function run(logPath) {
  try {
    const stdout = execFileSync(process.execPath, [helper, '--log', logPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { status: 0, stdout }
  } catch (error) {
    return { status: error.status, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
  }
}

const T = '2026-09-18T09:00:00.000Z'
const ALL = [
  'PREREQ_OPTION chosen=use_known_station',
  'PREREQ_SWITCH from=a to=b',
  'ABANDON_ENFORCED chain=x',
  'ABANDON_SUPPRESSED chain=x',
  'ACTION_UNVERIFIED action=DIG',
  'MOVE_TARGET_SKIPPED reason=blocked',
  'OSCILLATION_DETECTED count=3',
  'FURNACE_READY pos=1,2,3',
  'SMELT_DONE item=iron_ingot',
  'RUNG_MISMATCH rung=furnace expected=iron',
  'RELOAD_REJECTED reason=stale',
  `HEARTBEAT pos=1,2,3 health=20 running=true rung=furnace`,
].map((l) => `[${T}] ${l}`).join('\n') + '\n'

let passed = 0
try {
  const allPath = join(dir, 'all.log')
  writeFileSync(allPath, ALL)
  const a = run(allPath)
  assert.equal(a.status, 0, `all-markers expected 0, got ${a.status}\n${a.stdout}${a.stderr ?? ''}`)
  assert.match(a.stdout, /M2_REQUIRED status=COMPLETE/)
  assert.match(a.stdout, /PREREQ_OPTION count=1 first=2026-09-18T09:00:00\.000Z last=2026-09-18T09:00:00\.000Z/)
  assert.match(a.stdout, /HEARTBEAT \[2026-09-18T09:00:00\.000Z\]/)
  passed++

  const missingPath = join(dir, 'missing-smelt.log')
  writeFileSync(missingPath, ALL.replace(/SMELT_DONE item=iron_ingot\n/, ''))
  const b = run(missingPath)
  assert.equal(b.status, 1, `missing-smelt expected 1, got ${b.status}\n${b.stdout}`)
  assert.match(b.stdout, /SMELT_DONE MISSING/)
  assert.match(b.stdout, /M2_REQUIRED status=INCOMPLETE missing=SMELT_DONE/)
  passed++

  const unreadablePath = join(dir, 'does-not-exist.log')
  const c = run(unreadablePath)
  assert.equal(c.status, 2, `unreadable expected 2, got ${c.status}`)
  assert.match(c.stdout, /^UNKNOWN$/m)
  passed++

  console.log(`m2-watch: ${passed}/3 checks passed`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
