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

// Snapshot tests focus on run-scoped inventory/chain provenance. The M2 gate
// also requires independent proof that the real Jev policy ran, so provide a
// run-bound policy fixture rather than allowing the snapshot to bypass D2.
const POLICY_EVIDENCE = {
  decisions: { runId: RUN, source: 'fixture:decisions', jevCount: 1, fallbackCount: 0 },
  generation: { runId: RUN, source: 'fixture:generation', policyKind: 'typesafe', policyModel: 'typesafe-ai/jev' },
}

async function judge({ snap, identity = BOOT_IDENTITY, live = null, policy = POLICY_EVIDENCE } = {}) {
  const out = capture()
  const code = await runAcceptance({
    request: async () => live,
    expectedRunId: RUN,
    readSnapshot: async () => snap ?? null,
    readRunIdentity: async () => identity,
    now: () => new Date('2026-09-19T18:32:00.000Z'),
    write: out.write,
    sockPath: '/tmp/no-resident.sock',
    policyEvidence: policy,
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

// 5b. THE MISSING PIECE. The run truly reached every M2 rung, but the LATEST
// inventory has already consumed the rungs: the fuel charcoal was burnt by the
// smelt (charcoal=0) and all three ingots were consumed by the pickaxe craft
// (iron_ingot=0). Only the per-marker samples retain charcoal>=1 at
// FURNACE_READY time and iron_ingot>=3 at SMELT_DONE time, so acceptance must
// read the conditions from those samples. This uses the REAL runAcceptance entry
// point (not a helper): if acceptance still only read snapshot.inventory it would
// return FAIL here.
function perMarkerCraftSnapshot(overrides = {}) {
  const at = Date.parse('2026-09-19T18:21:53.724Z')
  return snapshot({
    markers: [
      {
        name: 'PREREQ_OPTION',
        atMs: at,
        at: new Date(at).toISOString(),
        inventory: { ...SATISFIED_INVENTORY, charcoal: 1, iron_ingot: 0, iron_pickaxe: 0, raw_iron: 3 },
      },
      {
        name: 'FURNACE_READY',
        atMs: at + 1000,
        at: new Date(at + 1000).toISOString(),
        inventory: { ...SATISFIED_INVENTORY, charcoal: 1, iron_ingot: 0, iron_pickaxe: 0, raw_iron: 3 },
      },
      {
        name: 'SMELT_DONE',
        atMs: at + 10_777,
        at: new Date(at + 10_777).toISOString(),
        inventory: { ...SATISFIED_INVENTORY, charcoal: 0, iron_ingot: 3, iron_pickaxe: 0, raw_iron: 0 },
      },
    ],
    // Latest instant: CRAFT:iron_pickaxe consumed the fuel and all three ingots.
    inventory: { ...SATISFIED_INVENTORY, charcoal: 0, iron_ingot: 0, iron_pickaxe: 1, raw_iron: 0 },
    ...overrides,
  })
}

{
  const { code, text } = await judge({ snap: perMarkerCraftSnapshot() })
  assert.equal(code, 0, `per-marker samples must let the run PASS but returned ${code}:\n${text}`)
  assert.match(text, /PASS charcoal >= 1 \(observed 1\)/, text)
  assert.match(text, /PASS iron_ingot >= 3 \(observed 3\)/, text)
  assert.match(text, /PASS iron_pickaxe >= 1 \(observed 1\)/, text)
  // The condition-to-sample mapping is explicit in the output.
  assert.match(text, /observation: charcoal<-FURNACE_READY iron_ingot<-SMELT_DONE iron_pickaxe<-latest/, text)
  assert.match(text, /RESULT: PASS/, text)
  ok('runAcceptance PASSes from per-marker samples (charcoal<-FURNACE_READY, iron_ingot<-SMELT_DONE, iron_pickaxe<-latest)')
}

// 5c. A foreign runId is still rejected even though the per-marker samples look
// complete: enriched observation never crosses run scope.
{
  const { code, text } = await judge({ snap: perMarkerCraftSnapshot({ runId: 'run-snapshot-b' }) })
  assert.equal(code, 2, `cross-run per-marker snapshot must be UNKNOWN but returned ${code}:\n${text}`)
  assert.doesNotMatch(text, /RESULT: (PASS|FAIL)/, text)
  assert.doesNotMatch(text, /PASS charcoal|FAIL charcoal/, text)
  ok('per-marker snapshot runId mismatch -> UNKNOWN/exit 2 (binding not loosened)')
}

// 5d. A mismatched BUILD hash is still rejected with the richer per-marker samples.
{
  const { code, text } = await judge({ snap: perMarkerCraftSnapshot(), identity: { ...BOOT_IDENTITY, buildHash: 'ffffffffffff' } })
  assert.equal(code, 2, `build mismatch must be UNKNOWN but returned ${code}:\n${text}`)
  assert.match(text, /UNKNOWN/, text)
  assert.doesNotMatch(text, /RESULT: (PASS|FAIL)/, text)
  ok('per-marker snapshot buildHash mismatch -> UNKNOWN/exit 2 (binding not loosened)')
}

// 5e. A mismatched BOOT source is still rejected with the richer per-marker samples.
{
  const { code, text } = await judge({ snap: perMarkerCraftSnapshot(), identity: { ...BOOT_IDENTITY, bootSourceSha: 'deadbeefdeadbeef' } })
  assert.equal(code, 2, `source mismatch must be UNKNOWN but returned ${code}:\n${text}`)
  assert.match(text, /UNKNOWN/, text)
  assert.doesNotMatch(text, /RESULT: (PASS|FAIL)/, text)
  ok('per-marker snapshot bootSourceSha mismatch -> UNKNOWN/exit 2 (binding not loosened)')
}

// 5f. Even with complete per-marker samples, a run whose decisions were only the
// deterministic fallback (and whose generation reports the fallback policy) is
// UNKNOWN, never PASS: per-marker evidence does not substitute for D2 real Jev.
{
  const fallbackPolicy = {
    decisions: { runId: RUN, source: 'fixture:decisions', jevCount: 0, fallbackCount: 4 },
    generation: { runId: RUN, source: 'fixture:generation', policyKind: 'fallback', policyModel: 'deterministic-local-fallback' },
  }
  const { code, text } = await judge({ snap: perMarkerCraftSnapshot(), policy: fallbackPolicy })
  assert.equal(code, 2, `fallback-only run must be UNKNOWN but returned ${code}:\n${text}`)
  assert.match(text, /RESULT: UNKNOWN/, text)
  assert.doesNotMatch(text, /RESULT: PASS/, text)
  assert.match(text, /POLICY: UNKNOWN/, text)
  ok('fallback-only run with complete per-marker samples -> UNKNOWN/exit 2 (never PASS)')
}

// 5g. An incomplete per-marker chain is still UNKNOWN: the exact ordered chain
// PREREQ_OPTION -> FURNACE_READY -> SMELT_DONE is unchanged.
{
  const partial = perMarkerCraftSnapshot({
    markers: perMarkerCraftSnapshot().markers.slice(0, 2),
    sequence: ['PREREQ_OPTION', 'FURNACE_READY'],
    chain: { status: 'INCOMPLETE', required: ['PREREQ_OPTION', 'FURNACE_READY', 'SMELT_DONE'], observed: ['PREREQ_OPTION', 'FURNACE_READY'] },
  })
  const { code, text } = await judge({ snap: partial })
  assert.equal(code, 2, `incomplete per-marker chain must be UNKNOWN but returned ${code}:\n${text}`)
  assert.doesNotMatch(text, /RESULT: (PASS|FAIL)/, text)
  assert.doesNotMatch(text, /PASS charcoal|FAIL charcoal/, text)
  ok('per-marker snapshot without the ordered chain -> UNKNOWN/exit 2')
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
    policyEvidence: POLICY_EVIDENCE,
  })
  assert.equal(code, 0, `file-backed snapshot must PASS but returned ${code}:\n${out.text()}`)
  assert.match(out.text(), /evidence: run-scoped-snapshot/, out.text())
  assert.match(out.text(), /snapshot: .*m2-snapshot-run-snapshot-a\.json/, out.text())
  assert.match(out.text(), /RESULT: PASS/, out.text())
  ok('snapshot read from disk + run BOOT/BUILD identity -> PASS')
}

console.log(`m2-snapshot-evidence: ${checks}/${checks} checks passed`)
