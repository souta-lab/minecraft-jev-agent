#!/usr/bin/env node
// Offline fixtures for exact-run historical M2 evidence.
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
    const stdout = execFileSync(process.execPath, [helper, '--log', logPath, ...extra], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { status: 0, stdout, stderr: '' }
  } catch (error) {
    return { status: error.status, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
  }
}

const OLD = '2026-09-18T08:00:00.000Z'
const T0 = '2026-09-18T09:00:00.000Z'
const T1 = '2026-09-18T09:00:01.000Z'
const T2 = '2026-09-18T09:00:02.000Z'
const T3 = '2026-09-18T09:00:03.000Z'
const line = (ts, body) => `[${ts}] ${body}`
const FULL = [
  line(T0, 'BOOT pid=11 runId=run-full bundle=new'),
  line(T0, 'PREREQ_OPTION chosen=craft_and_place'),
  line(T1, 'FURNACE_READY pos=1,2,3'),
  line(T2, 'SMELT_DONE item=charcoal gained=1 input=oak_log fuel=oak_planks output=1'),
  line(T3, 'SMELT_DONE item=iron_ingot gained=3 input=raw_iron fuel=charcoal output=3'),
  line(T3, 'HEARTBEAT pos=1,2,3 health=20 running=true rung=diamond'),
].join('\n') + '\n'

let passed = 0
try {
  const fullPath = join(dir, 'full.log')
  writeFileSync(fullPath, FULL)
  const complete = run(fullPath, ['--run', 'run-full'])
  assert.equal(complete.status, 0, complete.stdout + complete.stderr)
  assert.match(complete.stdout, /SMELT_DONE_CHARCOAL count=1/)
  assert.match(complete.stdout, /SMELT_DONE_IRON_INGOT count=1/)
  assert.match(complete.stdout, /M2_FRONTIER stage=SMELT_DONE_IRON_INGOT next=terminal_inventory/)
  assert.match(complete.stdout, /M2_SEQUENCE status=VALID/)
  passed++

  const charcoalOnlyPath = join(dir, 'charcoal-only.log')
  writeFileSync(charcoalOnlyPath, FULL.replace(line(T3, 'SMELT_DONE item=iron_ingot gained=3 input=raw_iron fuel=charcoal output=3'), line(T3, 'SMELT_DONE item=charcoal gained=1 input=oak_log fuel=planks output=2')))
  const charcoalOnly = run(charcoalOnlyPath, ['--run', 'run-full'])
  assert.equal(charcoalOnly.status, 1)
  assert.match(charcoalOnly.stdout, /SMELT_DONE count=2/)
  assert.match(charcoalOnly.stdout, /SMELT_DONE_IRON_INGOT MISSING/)
  assert.match(charcoalOnly.stdout, /next=SMELT_DONE_IRON_INGOT/)
  passed++

  const noCharcoalPath = join(dir, 'no-charcoal.log')
  writeFileSync(noCharcoalPath, FULL.replace(`${line(T2, 'SMELT_DONE item=charcoal gained=1 input=oak_log fuel=oak_planks output=1')}\n`, ''))
  const noCharcoal = run(noCharcoalPath, ['--run', 'run-full'])
  assert.equal(noCharcoal.status, 1)
  assert.match(noCharcoal.stdout, /SMELT_DONE_CHARCOAL MISSING/)
  assert.match(noCharcoal.stdout, /next=SMELT_DONE_CHARCOAL/)
  passed++

  const wrongOrderPath = join(dir, 'wrong-order.log')
  writeFileSync(wrongOrderPath, [
    line(T0, 'BOOT pid=12 runId=run-order bundle=x'),
    line(T0, 'PREREQ_OPTION chosen=craft_and_place'),
    line(T1, 'FURNACE_READY pos=1,2,3'),
    line(T2, 'SMELT_DONE item=iron_ingot gained=3 input=raw_iron fuel=coal output=3'),
    line(T3, 'SMELT_DONE item=charcoal gained=1 input=oak_log fuel=oak_planks output=1'),
  ].join('\n') + '\n')
  const wrongOrder = run(wrongOrderPath, ['--run', 'run-order'])
  assert.equal(wrongOrder.status, 1)
  assert.match(wrongOrder.stdout, /M2_SEQUENCE status=INVALID/)
  passed++

  // A single host run containing two successful generation hashes is not one
  // exact-source experiment even if its marker chain looks complete.
  const mixedSourcePath = join(dir, 'mixed-source.log')
  writeFileSync(mixedSourcePath, [
    line(T0, 'BOOT pid=30 runId=run-source bundle=none'),
    line(T0, 'BUILD hash=aaaaaaaaaaaa bytes=1'),
    line(T0, 'PREREQ_OPTION chosen=craft_and_place'),
    line(T1, 'FURNACE_READY pos=1,2,3'),
    line(T1, 'RELOAD ok=true trigger=source hash=bbbbbbbbbbbb id=gen-b'),
    line(T2, 'SMELT_DONE item=charcoal gained=1'),
    line(T3, 'SMELT_DONE item=iron_ingot gained=3'),
  ].join('\n') + '\n')
  const mixedSource = run(mixedSourcePath, ['--run', 'run-source'])
  assert.equal(mixedSource.status, 2)
  assert.match(mixedSource.stdout, /M2_SOURCE generationHashes=aaaaaaaaaaaa,bbbbbbbbbbbb/)
  assert.match(mixedSource.stderr, /reason=mixed_generation_hashes/)
  passed++

  const scopedPath = join(dir, 'scoped.log')
  writeFileSync(scopedPath, [
    line(OLD, 'BOOT pid=10 runId=run-old bundle=old'),
    line(OLD, 'PREREQ_OPTION chosen=craft_and_place'), line(OLD, 'FURNACE_READY pos=9,9,9'),
    line(OLD, 'SMELT_DONE item=charcoal gained=1'), line(OLD, 'SMELT_DONE item=iron_ingot gained=3'),
    line(T0, 'BOOT pid=11 runId=run-new bundle=new'),
    line(T0, 'PREREQ_OPTION chosen=craft_and_place'), line(T1, 'FURNACE_READY pos=1,2,3'),
    line(T2, 'SMELT_DONE item=charcoal gained=1'),
  ].join('\n') + '\n')
  const scoped = run(scopedPath, ['--run', 'run-new'])
  assert.equal(scoped.status, 1)
  assert.match(scoped.stdout, /SMELT_DONE_IRON_INGOT MISSING/)
  passed++

  const mixedPath = join(dir, 'mixed-runs.log')
  writeFileSync(mixedPath, [
    line(T0, 'BOOT pid=20 runId=run-a bundle=a'), line(T0, 'PREREQ_OPTION'), line(T1, 'FURNACE_READY'),
    line(T2, 'SMELT_DONE item=charcoal gained=1'), line(T3, 'BOOT pid=21 runId=run-b bundle=b'),
    line(T3, 'SMELT_DONE item=iron_ingot gained=3'),
  ].join('\n') + '\n')
  const mixed = run(mixedPath, ['--since', OLD])
  assert.equal(mixed.status, 2)
  assert.match(mixed.stdout, /^UNKNOWN$/m)
  assert.match(mixed.stderr, /multiple_run_boundaries_after_since/)
  passed++

  const pinned = run(mixedPath, ['--run', 'run-b'])
  assert.equal(pinned.status, 1)
  assert.match(pinned.stdout, /PREREQ_OPTION MISSING/)
  passed++

  const missingRun = run(mixedPath, ['--run', 'run-does-not-exist'])
  assert.equal(missingRun.status, 2)
  assert.match(missingRun.stderr, /explicit_run_boundary_missing/)
  passed++

  const badSince = run(fullPath, ['--since', 'definitely-not-a-time'])
  assert.equal(badSince.status, 2)
  assert.match(badSince.stdout, /^UNKNOWN$/m)
  passed++

  const unreadable = run(join(dir, 'does-not-exist.log'))
  assert.equal(unreadable.status, 2)
  assert.match(unreadable.stdout, /^UNKNOWN$/m)
  passed++

  console.log(`m2-watch: ${passed}/11 checks passed`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
