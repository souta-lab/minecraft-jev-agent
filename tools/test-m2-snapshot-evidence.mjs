#!/usr/bin/env node
// test-m2-snapshot-evidence: RED-FIRST evidence for the run-scoped M2 snapshot.
//
// The M2 gap this locks down (run-mu8ps36q-xegj): the required marker chain and the
// live 3-condition inventory were observed in the SAME run, but m2-acceptance ran
// AFTER the resident exited, so the live control-socket query returned UNKNOWN and
// the run could never PASS. A snapshot the RESIDENT writes from live state at marker
// time must be consumable after the process is gone.
//
// Contract exercised here (never weakened):
//   runId == --run R AND the recorded build/source matches R's BOOT/BUILD evidence;
//   ordered chain PREREQ_OPTION -> FURNACE_READY -> SMELT_DONE;
//   inventory charcoal>=1 / iron_ingot>=3 / iron_pickaxe>=1.
// Any mismatch is UNKNOWN, never PASS.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAcceptance } from './m2-acceptance.mjs'

let checks = 0
function ok(label) {
  checks += 1
  console.log(`  ok ${checks} - ${label}`)
}

function capture() {
  const lines = []
  return { lines, write: (line) => lines.push(line), text: () => lines.join('\n') }
}

const RUN = 'run-snapshot-a'
const BOOT_SHA = '4e7202c0000000000000000000000000000000'
const BUILD_HASH = 'aa4a6c36ce01'

const SATISFIED_INVENTORY = {
  charcoal: 1,
  iron_ingot: 3,
  iron_pickaxe: 1,
  cobblestone: 58,
  stick: 2,
  raw_iron: 0,
}

function markers(atBase = Date.parse('2026-09-19T18:21:53.724Z')) {
  return [
    { name: 'PREREQ_OPTION', atMs: atBase, at: new Date(atBase).toISOString(), inventory: { ...SATISFIED_INVENTORY } },
    { name: 'FURNACE_READY', atMs: atBase + 1000, at: new Date(atBase + 1000).toISOString(), inventory: { ...SATISFIED_INVENTORY, iron_ingot: 2 } },
    { name: 'SMELT_DONE', atMs: atBase + 10_777, at: new Date(atBase + 10_777).toISOString(), inventory: { ...SATISFIED_INVENTORY } },
  ]
}

function snapshot(overrides = {}) {
  return {
    schemaVersion: 1,
    record: 'm2-snapshot',
    runId: RUN,
    generationId: 'gen-mu8ps3ut-70uwkb',
    bootSourceSha: BOOT_SHA,
    buildHash: BUILD_HASH,
    worldEpoch: 3,
    worldKey: '127.0.0.1:25565|minecraft:overworld|3',
    atMs: Date.parse('2026-09-19T18:22:04.501Z'),
    at: '2026-09-19T18:22:04.501Z',
    markers: markers(),
    sequence: ['PREREQ_OPTION', 'FURNACE_READY', 'SMELT_DONE'],
    chain: { status: 'VALID', required: ['PREREQ_OPTION', 'FURNACE_READY', 'SMELT_DONE'], observed: ['PREREQ_OPTION', 'FURNACE_READY', 'SMELT_DONE'] },
    inventory: { ...SATISFIED_INVENTORY },
    ...overrides,
  }
}

const BOOT_IDENTITY = { runId: RUN, bootSourceSha: BOOT_SHA, buildHash: BUILD_HASH }

async function judge({ snap, identity = BOOT_IDENTITY, live = null } = {}) {
  const out = capture()
  const code = await runAcceptance({
    request: async () => live,
    expectedRunId: RUN,
    readSnapshot: async () => snap ?? null,
    readRunIdentity: async () => identity,
    now: () => new Date('2026-09-19T18:32:00.000Z'),
    write: out.write,
    sockPath: '/tmp/no-resident.sock',
  })
  return { code, text: out.text() }
}

// 1. RED: the run-scoped snapshot satisfies acceptance after the resident exited.
{
  const { code, text } = await judge({ snap: snapshot() })
  assert.equal(code, 0, `same-run snapshot with satisfied inventory must PASS but returned ${code}:\n${text}`)
  assert.match(text, /evidence: run-scoped-snapshot/, text)
  assert.match(text, /PASS charcoal >= 1 \(observed 1\)/, text)
  assert.match(text, /PASS iron_ingot >= 3 \(observed 3\)/, text)
  assert.match(text, /PASS iron_pickaxe >= 1 \(observed 1\)/, text)
  assert.match(text, /RESULT: PASS/, text)
  ok('resident exited + same-run snapshot with satisfied inventory -> PASS/exit 0')
}

// 2. A run-scoped snapshot for another run must never satisfy --run R.
{
  const foreign = snapshot({ runId: 'run-snapshot-b' })
  const { code, text } = await judge({ snap: foreign })
  assert.equal(code, 2, `cross-run snapshot must be UNKNOWN but returned ${code}:\n${text}`)
  assert.doesNotMatch(text, /RESULT: (PASS|FAIL)/, text)
  assert.doesNotMatch(text, /PASS charcoal|FAIL charcoal/, text)
  ok('snapshot runId mismatch -> UNKNOWN/exit 2 (never cross-run)')
}

// 3. Recorded build must match the run's BUILD record.
{
  const { code, text } = await judge({ snap: snapshot(), identity: { ...BOOT_IDENTITY, buildHash: 'ffffffffffff' } })
  assert.equal(code, 2, `build mismatch must be UNKNOWN but returned ${code}:\n${text}`)
  assert.match(text, /UNKNOWN/, text)
  assert.doesNotMatch(text, /RESULT: (PASS|FAIL)/, text)
  assert.doesNotMatch(text, /PASS charcoal|FAIL charcoal/, text)
  ok('snapshot buildHash mismatch vs BUILD -> UNKNOWN/exit 2')
}

// 4. Recorded boot source must match the run's BOOT source.
{
  const { code, text } = await judge({ snap: snapshot(), identity: { ...BOOT_IDENTITY, bootSourceSha: 'deadbeefdeadbeef' } })
  assert.equal(code, 2, `source mismatch must be UNKNOWN but returned ${code}:\n${text}`)
  assert.match(text, /UNKNOWN/, text)
  assert.doesNotMatch(text, /RESULT: (PASS|FAIL)/, text)
  ok('snapshot bootSourceSha mismatch vs BOOT -> UNKNOWN/exit 2')
}

// 5. An incomplete marker chain in the snapshot is not same-run M2 proof.
{
  const broken = snapshot({
    markers: markers().slice(0, 2),
    sequence: ['PREREQ_OPTION', 'FURNACE_READY'],
    chain: { status: 'INCOMPLETE', required: ['PREREQ_OPTION', 'FURNACE_READY', 'SMELT_DONE'], observed: ['PREREQ_OPTION', 'FURNACE_READY'] },
  })
  const { code, text } = await judge({ snap: broken })
  assert.equal(code, 2, `incomplete snapshot chain must be UNKNOWN but returned ${code}:\n${text}`)
  assert.doesNotMatch(text, /RESULT: (PASS|FAIL)/, text)
  assert.doesNotMatch(text, /PASS charcoal|FAIL charcoal/, text)
  ok('snapshot without the ordered chain -> UNKNOWN/exit 2')
}

// 6. A live same-run socket still wins and is reported as such.
{
  const live = { runId: RUN, status: { truth: { inventory: { ...SATISFIED_INVENTORY } } }, stats: {}, milestone: 'iron_pickaxe' }
  const { code, text } = await judge({ snap: snapshot(), live })
  assert.equal(code, 0, `live same-run inventory must PASS but returned ${code}:\n${text}`)
  assert.match(text, /evidence: live-socket/, text)
  assert.doesNotMatch(text, /evidence: run-scoped-snapshot/, text)
  assert.match(text, /RESULT: PASS/, text)
  ok('live same-run socket is preferred and reported as live-socket')
}

// 7. Live unavailable and no snapshot must stay UNKNOWN (no fabrication).
{
  const { code, text } = await judge({ snap: null })
  assert.equal(code, 2, `missing evidence must be UNKNOWN but returned ${code}:\n${text}`)
  assert.match(text, /live: unavailable/, text)
  assert.match(text, /snapshot: unavailable/, text)
  assert.doesNotMatch(text, /PASS cand|FAIL cand|observed \d/, text)
  assert.doesNotMatch(text, /chain:/, text)
  ok('live unavailable + snapshot missing -> UNKNOWN/exit 2, no fabricated numbers')
}

// 8. File integration: the snapshot is read from disk, not injected.
{
  const dir = mkdtempSync(join(tmpdir(), 'm2-snap-'))
  const snapPath = join(dir, `m2-snapshot-${RUN}.json`)
  writeFileSync(snapPath, `${JSON.stringify(snapshot(), null, 2)}\n`)
  const logPath = join(dir, 'buddy.log')
  writeFileSync(
    logPath,
    [
      `[2026-09-19T18:21:50.500Z] BOOT pid=1 runId=${RUN} bundle=none source=${BOOT_SHA} worldEpoch=3`,
      `[2026-09-19T18:21:50.814Z] BUILD hash=${BUILD_HASH} bytes=1 outfile=/tmp/gen.mjs`,
      '[2026-09-19T18:21:53.724Z] PREREQ_OPTION chosen=x',
      '[2026-09-19T18:21:53.724Z] FURNACE_READY source=known at=16,64,11',
      `[2026-09-19T18:22:04.501Z] SMELT_DONE item=iron_ingot gained=1 generationId=gen-mu8ps3ut-70uwkb`,
      '',
    ].join('\n'),
  )
  const out = capture()
  const code = await runAcceptance({
    request: async () => null,
    expectedRunId: RUN,
    snapshotDir: dir,
    logPath,
    now: () => new Date('2026-09-19T18:32:00.000Z'),
    write: out.write,
    sockPath: '/tmp/no-resident.sock',
  })
  assert.equal(code, 0, `file-backed snapshot must PASS but returned ${code}:\n${out.text()}`)
  assert.match(out.text(), /evidence: run-scoped-snapshot/, out.text())
  assert.match(out.text(), /snapshot: .*m2-snapshot-run-snapshot-a\.json/, out.text())
  assert.match(out.text(), /RESULT: PASS/, out.text())
  ok('snapshot read from disk + run BOOT/BUILD identity -> PASS')
}

console.log(`m2-snapshot-evidence: ${checks}/${checks} checks passed`)
