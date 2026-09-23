#!/usr/bin/env bun
// test-milestone-predicates: fixtures for tools/milestone-predicates.mjs.
//
// The M3 artifact must carry first-class milestone predicate evidence:
//   { id, satisfied, observedAtMs, source, evidence } per M2/M3 predicate.
//
// This fixture pins the two directions that matter:
//   * a run with a KNOWN transition / inventory proves the predicate (`true`) and
//     names the exact evidence source and observation time;
//   * a run with NO such observation stays `null` (UNKNOWN), never a fabricated
//     PASS, and a resident observation is rejected on runId / record / sourceSha
//     mismatch instead of being merged.
//
// Usage: bun tools/test-milestone-predicates.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MILESTONE_PREDICATE_IDS,
  deriveMilestonePredicates,
  predicateConditionMap,
  readMilestonePredicateEvidence,
} from './milestone-predicates.mjs'

let checks = 0
function ok(label) {
  checks += 1
  console.log(`  ok ${checks} - ${label}`)
}

const RUN = 'run-pred-fixture'
const SHA = 'a'.repeat(40)
const T = (sec) => Date.parse(`2026-09-22T00:00:${String(sec).padStart(2, '0')}.000Z`)

const PORTAL = [
  { name: 'PORTAL_BLOCK_PLACED', atMs: T(1), source: 'log' },
  { name: 'PORTAL_FRAME_READY', shape: 'ok', blocks: 10, atMs: T(2), source: 'log' },
  { name: 'PORTAL_LIT', dimension: 'minecraft:overworld', atMs: T(3), source: 'log' },
  { name: 'PORTAL_VERIFIED', verified: true, atMs: T(4), source: 'log' },
]
const NETHER = [{ dimension: 'minecraft:overworld', atMs: T(1), source: 'log' }, { dimension: 'minecraft:the_nether', atMs: T(30), source: 'log' }]
const INVENTORY = [{ counts: { ender_pearl: 12, blaze_rod: 7, blaze_powder: 14, ender_eye: 12 }, atMs: T(40), source: 'log' }]

const byId = (section, id) => section.predicates.find((predicate) => predicate.id === id)

// ---------------------------------------------------------------------------
// 1. A known transition proves every predicate with its own source
// ---------------------------------------------------------------------------
{
  const section = deriveMilestonePredicates({
    runId: RUN,
    runSourceSha: SHA,
    inventorySamples: INVENTORY,
    dimensionObservations: NETHER,
    portalEvents: PORTAL,
  })
  assert.equal(section.runId, RUN)
  assert.equal(section.sourceSha, SHA)
  assert.deepEqual(
    section.predicates.map((predicate) => predicate.id),
    [...MILESTONE_PREDICATE_IDS],
  )
  assert.deepEqual(section.missing, [])
  assert.deepEqual(section.mismatches, [])
  assert.equal(byId(section, 'portal_built').satisfied, true)
  assert.equal(byId(section, 'portal_built').source, 'log:PORTAL_FRAME_READY')
  assert.equal(byId(section, 'portal_lit').satisfied, true)
  assert.equal(byId(section, 'portal_lit').source, 'log:PORTAL_LIT')
  assert.equal(byId(section, 'portal_verified').satisfied, true)
  assert.equal(byId(section, 'portal_verified').observedAtMs, T(4))
  assert.equal(byId(section, 'nether_reached').satisfied, true)
  assert.equal(byId(section, 'nether_reached').observedAtMs, T(30))
  assert.equal(byId(section, 'blaze_rods').satisfied, true)
  assert.equal(byId(section, 'ender_pearls').satisfied, true)
  assert.equal(byId(section, 'ender_eyes').satisfied, true)
  assert.equal(byId(section, 'ender_eyes').source, 'log:INVENTORY')
  assert.deepEqual(predicateConditionMap(section), {
    portal_built: 'PASS',
    portal_lit: 'PASS',
    portal_verified: 'PASS',
    nether_reached: 'PASS',
    blaze_rods: 'PASS',
    ender_pearls: 'PASS',
    ender_eyes: 'PASS',
  })
  ok('a run with a real transition + inventory proves all seven predicates with their sources')
}

// ---------------------------------------------------------------------------
// 2. A run with no transition / no items stays UNKNOWN or honestly false
// ---------------------------------------------------------------------------
{
  const section = deriveMilestonePredicates({
    runId: RUN,
    runSourceSha: SHA,
    inventorySamples: [{ counts: { ender_eye: 0 }, atMs: T(5), source: 'log' }],
    dimensionObservations: [{ dimension: 'minecraft:overworld', atMs: T(1), source: 'log' }],
    portalEvents: [],
  })
  assert.equal(byId(section, 'nether_reached').satisfied, null, 'no transition observation => UNKNOWN')
  assert.equal(byId(section, 'nether_reached').source, null)
  assert.equal(byId(section, 'nether_reached').evidence.lastDimension, 'minecraft:overworld')
  assert.equal(byId(section, 'portal_verified').satisfied, null)
  assert.equal(byId(section, 'ender_eyes').satisfied, false, 'an observed zero is false, not a PASS')
  assert.deepEqual(section.missing.sort(), ['nether_reached', 'portal_built', 'portal_lit', 'portal_verified'].sort())
  assert.equal(predicateConditionMap(section).nether_reached, 'UNKNOWN')
  assert.equal(predicateConditionMap(section).ender_eyes, 'FAIL')
  ok('an unobserved transition is UNKNOWN with its last observation; an observed zero is false')
}

// ---------------------------------------------------------------------------
// 3. Resident observation file: run-scoped read, mismatches rejected
// ---------------------------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'milestone-pred-read-'))
  try {
    const path = join(dir, `milestone-predicates-${RUN}.json`)
    writeFileSync(
      path,
      JSON.stringify({
        record: 'milestone-predicates',
        schemaVersion: 1,
        runId: RUN,
        sourceSha: SHA,
        generationId: 'gen-1',
        observationCount: 4,
        updatedAt: '2026-09-22T00:01:00.000Z',
        predicates: [{ id: 'ender_eyes', satisfied: true, observedAtMs: T(41), source: 'host-observe:rung:ender_eyes', evidence: {} }],
      }),
    )
    const present = readMilestonePredicateEvidence(RUN, { dir })
    assert.equal(present.present, true)
    assert.equal(present.sourceSha, SHA)
    assert.equal(present.observationCount, 4)
    assert.equal(readMilestonePredicateEvidence('run-other', { dir }).present, false)
    assert.match(readMilestonePredicateEvidence('run-other', { dir }).reason, /missing/)

    // record tag mismatch
    writeFileSync(path, JSON.stringify({ record: 'other', runId: RUN }))
    assert.equal(readMilestonePredicateEvidence(RUN, { dir }).present, false)
    // body runId mismatch
    writeFileSync(path, JSON.stringify({ record: 'milestone-predicates', runId: 'run-different' }))
    const mismatch = readMilestonePredicateEvidence(RUN, { dir })
    assert.equal(mismatch.present, false)
    assert.match(mismatch.reason, /run_mismatch/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  ok('the resident observation file is accepted only for its own runId and record tag')
}

// ---------------------------------------------------------------------------
// 4. Merge: host evidence wins for the same predicate; sourceSha mismatch rejects
// ---------------------------------------------------------------------------
{
  const host = {
    present: true,
    path: '/tmp/milestone-predicates-run-pred-fixture.json',
    sourceSha: SHA,
    generationId: 'gen-2',
    observationCount: 9,
    predicates: [{ id: 'ender_eyes', satisfied: true, observedAtMs: T(20), source: 'host-observe:rung:ender_eyes', evidence: { rungPredicate: true } }],
  }
  const section = deriveMilestonePredicates({
    runId: RUN,
    runSourceSha: SHA,
    inventorySamples: [{ counts: { ender_eye: 0 }, atMs: T(40), source: 'log' }],
    dimensionObservations: [],
    portalEvents: [],
    hostObservation: host,
  })
  const eyes = byId(section, 'ender_eyes')
  assert.equal(eyes.satisfied, true, 'a live host observation of 12 eyes is not erased by a later log zero')
  assert.equal(eyes.observedAtMs, T(20), 'the FIRST proven observation is kept')
  assert.equal(eyes.source, 'host-observe:rung:ender_eyes')
  assert.ok(section.observationSources.includes('host-observe'))

  // A host observation from a different build (sourceSha) is REJECTED, not merged.
  const rejected = deriveMilestonePredicates({
    runId: RUN,
    runSourceSha: SHA,
    inventorySamples: [{ counts: { ender_eye: 0 }, atMs: T(40), source: 'log' }],
    dimensionObservations: [],
    portalEvents: [],
    hostObservation: { ...host, sourceSha: 'b'.repeat(40) },
  })
  assert.equal(byId(rejected, 'ender_eyes').satisfied, false, 'a mismatched sourceSha must not prove the predicate')
  assert.equal(rejected.mismatches.length, 1)
  assert.match(rejected.mismatches[0], /source_sha_mismatch/)

  const missingSource = deriveMilestonePredicates({
    runId: RUN,
    runSourceSha: SHA,
    inventorySamples: [{ counts: { ender_eye: 0 }, atMs: T(40), source: 'log' }],
    dimensionObservations: [],
    portalEvents: [],
    hostObservation: { ...host, sourceSha: null },
  })
  assert.equal(byId(missingSource, 'ender_eyes').satisfied, false, 'a missing sourceSha must not prove the predicate')
  assert.match(missingSource.mismatches[0], /source_sha_missing/)

  const runSourceUnknown = deriveMilestonePredicates({
    runId: RUN,
    runSourceSha: null,
    inventorySamples: [],
    dimensionObservations: [],
    portalEvents: [],
    hostObservation: host,
  })
  assert.equal(byId(runSourceUnknown, 'ender_eyes').satisfied, null, 'without a BOOT SHA host claims are not usable')
  assert.match(runSourceUnknown.mismatches[0], /source_sha_unavailable/)
  ok('host evidence is merged only when its sourceSha matches a known BOOT SHA')
}

// ---------------------------------------------------------------------------
// 5. Snapshot markers are first-class portal evidence (the inherited-portal case)
// ---------------------------------------------------------------------------
{
  const section = deriveMilestonePredicates({
    runId: RUN,
    runSourceSha: SHA,
    inventorySamples: [],
    dimensionObservations: [],
    portalEvents: [{ name: 'PORTAL_VERIFIED', verified: true, atMs: T(9), source: 'snapshot' }],
  })
  assert.equal(byId(section, 'portal_verified').satisfied, true)
  assert.equal(byId(section, 'portal_verified').source, 'snapshot:PORTAL_VERIFIED')
  assert.equal(byId(section, 'portal_built').satisfied, null, 'a verified marker alone does not prove the build chain')
  ok('a snapshot PORTAL_VERIFIED marker proves portal_verified without inventing the build chain')
}

console.log(`\ntest-milestone-predicates: ${checks} checks passed`)
