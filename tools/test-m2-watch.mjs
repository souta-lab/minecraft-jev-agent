#!/usr/bin/env node
// test-m2-watch: offline fixtures for tools/m2-watch.mjs.
// Pins run scoping and the ordered causal chain so old all-time markers cannot
// make a fresh M2 attempt look complete.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const helper = join(repoRoot, 'tools', 'm2-watch.mjs')
const dir = mkdtempSync(join(tmpdir(), 'm2-watch-'))

function run(logPath, extra = []) {
  try {
    const stdout = execFileSync(process.execPath, [helper, '--log', logPath, ...extra], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { status: 0, stdout, stderr: '' }
  } catch (error) {
    return { status: error.status, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
  }
}

const OLD = '2026-09-18T08:00:00.000Z'
const T = '2026-09-18T09:00:00.000Z'
const T2 = '2026-09-18T09:00:01.000Z'
const T3 = '2026-09-18T09:00:02.000Z'
const line = (ts, body) => `[${ts}] ${body}`

const ALL = [
  line(T, 'PREREQ_OPTION chosen=use_known_station'),
  line(T, 'PREREQ_SWITCH from=a to=b'),
  line(T, 'ABANDON_ENFORCED chain=x'),
  line(T, 'ABANDON_SUPPRESSED chain=x'),
  line(T, 'ACTION_UNVERIFIED action=DIG'),
  line(T, 'MOVE_TARGET_SKIPPED reason=blocked'),
  line(T, 'OSCILLATION_DETECTED count=3'),
  line(T, 'CAPABILITY_GAP reason=oscillation'),
  line(T, 'PILLAR_REFUSED reason=no_headroom'),
  line(T, 'PILLAR_RELOCATE from=1,2,3 to=1,2,4'),
  line(T, 'PILLAR_UP_STEP step=1 from_y=8 to_y=9 placed=cobblestone'),
  line(T, 'PILLAR_FAIL step=apex reason=falling'),
  line(T, 'ASCENT_PROGRESS from_y=8 to_y=9 target_y=64'),
  line(T2, 'FURNACE_READY pos=1,2,3'),
  line(T3, 'SMELT_DONE item=iron_ingot'),
  line(T3, 'RUNG_MISMATCH rung=furnace expected=iron'),
  line(T3, 'RELOAD_REJECTED reason=stale'),
  line(T3, 'HEARTBEAT pos=1,2,3 health=20 running=true rung=iron_ingot'),
].join('\n') + '\n'

let passed = 0
try {
  const allPath = join(dir, 'all.log')
  writeFileSync(allPath, ALL)
  const complete = run(allPath)
  assert.equal(complete.status, 0, `all-markers expected 0, got ${complete.status}\n${complete.stdout}${complete.stderr}`)
  assert.match(complete.stdout, /M2_REQUIRED status=COMPLETE/)
  assert.match(complete.stdout, /M2_SEQUENCE status=VALID/)
  assert.match(complete.stdout, /M2_FRONTIER stage=SMELT_DONE next=none/)
  assert.match(complete.stdout, /PREREQ_OPTION count=1 first=2026-09-18T09:00:00\.000Z last=2026-09-18T09:00:00\.000Z/)
  assert.match(complete.stdout, /HEARTBEAT \[2026-09-18T09:00:02\.000Z\]/)
  passed++

  const missingPath = join(dir, 'missing-smelt.log')
  writeFileSync(missingPath, ALL.replace(`${line(T3, 'SMELT_DONE item=iron_ingot')}\n`, ''))
  const missing = run(missingPath)
  assert.equal(missing.status, 1, `missing-smelt expected 1, got ${missing.status}\n${missing.stdout}`)
  assert.match(missing.stdout, /SMELT_DONE MISSING/)
  assert.match(missing.stdout, /M2_FRONTIER stage=FURNACE_READY next=SMELT_DONE/)
  assert.match(missing.stdout, /M2_REQUIRED status=INCOMPLETE missing=SMELT_DONE next=SMELT_DONE/)
  passed++

  // Critical regression: old successful markers before --since must not make a
  // fresh attempt complete. The scoped attempt reached FURNACE_READY only.
  const scopedPath = join(dir, 'scoped.log')
  writeFileSync(
    scopedPath,
    [
      line(OLD, 'PREREQ_OPTION chosen=craft_and_place'),
      line(OLD, 'FURNACE_READY pos=9,9,9'),
      line(OLD, 'SMELT_DONE item=iron_ingot'),
      line(T, 'PREREQ_OPTION chosen=craft_and_place'),
      line(T2, 'FURNACE_READY pos=1,2,3'),
      line(T3, 'HEARTBEAT pos=1,2,3 health=20 running=true rung=iron_ingot'),
    ].join('\n') + '\n',
  )
  const scoped = run(scopedPath, ['--since', T])
  assert.equal(scoped.status, 1, `scoped fresh run expected 1, got ${scoped.status}\n${scoped.stdout}`)
  assert.match(scoped.stdout, /M2_SCOPE since=2026-09-18T09:00:00\.000Z/)
  assert.match(scoped.stdout, /SMELT_DONE MISSING/)
  assert.match(scoped.stdout, /M2_FRONTIER stage=FURNACE_READY next=SMELT_DONE/)
  passed++

  // All three marker names exist, but the causal order is wrong. Counts alone
  // must not upgrade this log to complete.
  const unorderedPath = join(dir, 'unordered.log')
  writeFileSync(
    unorderedPath,
    [
      line(T, 'SMELT_DONE item=iron_ingot'),
      line(T2, 'PREREQ_OPTION chosen=craft_and_place'),
      line(T3, 'FURNACE_READY pos=1,2,3'),
    ].join('\n') + '\n',
  )
  const unordered = run(unorderedPath)
  assert.equal(unordered.status, 1, `unordered expected 1, got ${unordered.status}\n${unordered.stdout}`)
  assert.match(unordered.stdout, /M2_SEQUENCE status=INVALID/)
  assert.match(unordered.stdout, /M2_FRONTIER stage=FURNACE_READY next=SMELT_DONE/)
  passed++

  const badSince = run(allPath, ['--since', 'definitely-not-a-time'])
  assert.equal(badSince.status, 2, `invalid since expected 2, got ${badSince.status}`)
  assert.match(badSince.stdout, /^UNKNOWN$/m)
  passed++

  const unreadablePath = join(dir, 'does-not-exist.log')
  const unreadable = run(unreadablePath)
  assert.equal(unreadable.status, 2, `unreadable expected 2, got ${unreadable.status}`)
  assert.match(unreadable.stdout, /^UNKNOWN$/m)
  passed++

  console.log(`m2-watch: ${passed}/6 checks passed`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
