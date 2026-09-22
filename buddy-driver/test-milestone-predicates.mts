// test-milestone-predicates.mts — run-scoped milestone predicate evidence fixtures.
//
// The operator's M3 PASS definition requires first-class milestone predicate
// evidence in the run-scoped artifact. Two producers exist:
//
//   * `evaluateMilestonePredicates` (generation side) reuses the ladder's OWN
//     `RUNGS[].satisfied` predicates — it must never invent a new milestone
//     semantics, and a transition predicate that is merely ABSENT must be `null`
//     (UNKNOWN), never `false`;
//   * `MilestonePredicateRecorder` (HOST side) persists them to ONE run-scoped
//     file and MERGES monotonically, so a predicate proven by an earlier
//     generation survives a later generation/reload and cannot be downgraded.
//
// Pure: no bot, no socket, no network. fs writes go to a temp dir.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyWorldMemory } from './resident-types.ts'
import type { ResidentWorldMemory } from './resident-types.ts'
import { MilestonePredicateRecorder, milestonePredicateFileName } from './milestone-predicates.ts'
import { evaluateMilestonePredicates } from './milestone-predicate-eval.ts'

let checks = 0
function ok(label: string): void {
  checks += 1
  console.log(`  ok ${checks} - ${label}`)
}

const world = (over: Partial<ResidentWorldMemory> = {}): ResidentWorldMemory => ({ ...emptyWorldMemory(), ...over })
const AT = Date.parse('2026-09-22T00:00:00.000Z')

// ---------------------------------------------------------------------------
// 1. The evaluator reuses the ladder predicate: satisfied only when it holds
// ---------------------------------------------------------------------------
{
  const full = evaluateMilestonePredicates(
    { blaze_rod: 7, ender_pearl: 12, ender_eye: 12 },
    world({ dimension: 'minecraft:the_nether', portalVerified: true }),
    AT,
  )
  const byId = new Map(full.map((observation) => [observation.id, observation]))
  assert.equal(byId.get('portal_verified')?.satisfied, true)
  assert.equal(byId.get('nether_reached')?.satisfied, true)
  assert.equal(byId.get('blaze_rods')?.satisfied, true)
  assert.equal(byId.get('ender_pearls')?.satisfied, true)
  assert.equal(byId.get('ender_eyes')?.satisfied, true)
  assert.equal(byId.get('ender_eyes')?.observedAtMs, AT)
  assert.match(String(byId.get('ender_eyes')?.source), /^host-observe:rung:ender_eyes$/)
  ok('a complete inventory + Nether observation satisfies every predicate via its own rung')
}

// ---------------------------------------------------------------------------
// 2. Absence is UNKNOWN for transitions, honestly false for observed counts
// ---------------------------------------------------------------------------
{
  const empty = evaluateMilestonePredicates({}, world(), AT)
  const byId = new Map(empty.map((observation) => [observation.id, observation]))
  assert.equal(byId.get('portal_verified')?.satisfied, null, 'no portal observed => UNKNOWN, never false')
  assert.equal(byId.get('nether_reached')?.satisfied, null, 'not in the Nether => UNKNOWN, never false')
  assert.equal(byId.get('blaze_rods')?.satisfied, false, 'zero blaze rods is an observed false')
  assert.equal(byId.get('ender_pearls')?.satisfied, false)
  assert.equal(byId.get('ender_eyes')?.satisfied, false)
  assert.equal(byId.get('blaze_rods')?.observedAtMs, AT)
  assert.deepEqual((byId.get('blaze_rods')?.evidence as { items: Record<string, number> }).items, { blaze_rod: 0 })
  ok('absent transitions stay UNKNOWN while observed inventory counts are false with their counts')
}

// ---------------------------------------------------------------------------
// 3. The recorder is run-scoped, monotonic and survives a reload
// ---------------------------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'milestone-predicates-'))
  try {
    const runId = 'run-fixture-predicates'
    const first = new MilestonePredicateRecorder({ runId, sourceSha: 'sha-first', dir, now: () => AT, refreshMs: 0 })
    const before = evaluateMilestonePredicates({}, world(), AT)
    assert.equal(first.observe(before, { generationId: 'gen-1' }), true, 'first observation writes the file')

    // A later generation observes 12 eyes: the file must now carry the proven fact.
    const recorder2 = new MilestonePredicateRecorder({ runId, sourceSha: 'sha-first', dir, now: () => AT + 1000, refreshMs: 0 })
    const withEyes = evaluateMilestonePredicates({ ender_eye: 12 }, world(), AT + 1000)
    assert.equal(recorder2.observe(withEyes, { generationId: 'gen-2' }), true)

    // A THIRD generation observes zero eyes again (e.g. items consumed/lost): the
    // proven `true` must survive — the file must never downgrade it.
    const recorder3 = new MilestonePredicateRecorder({ runId, sourceSha: 'sha-first', dir, now: () => AT + 2000, refreshMs: 0 })
    const lostEyes = evaluateMilestonePredicates({ ender_eye: 0 }, world(), AT + 2000)
    recorder3.observe(lostEyes, { generationId: 'gen-3' })

    const persisted = JSON.parse(readFileSync(join(dir, milestonePredicateFileName(runId)), 'utf8'))
    assert.equal(persisted.record, 'milestone-predicates')
    assert.equal(persisted.runId, runId)
    assert.equal(persisted.sourceSha, 'sha-first')
    const eyes = persisted.predicates.find((predicate: { id: string }) => predicate.id === 'ender_eyes')
    assert.equal(eyes.satisfied, true, 'proven true is sticky across reloads')
    assert.equal(eyes.observedAtMs, AT + 1000, 'the FIRST true observation is preserved')
    assert.equal(persisted.observationCount, 3)

    // A different run NEVER reads this run's file.
    const other = new MilestonePredicateRecorder({ runId: 'run-other', sourceSha: 'sha-other', dir, now: () => AT, refreshMs: 0 })
    assert.equal(other.current().predicates.length, 0, 'another run cannot read this run file')
    other.observe(evaluateMilestonePredicates({ blaze_rod: 7 }, world(), AT), { generationId: 'gen-other' })
    const otherFile = JSON.parse(readFileSync(join(dir, milestonePredicateFileName('run-other')), 'utf8'))
    assert.equal(otherFile.runId, 'run-other')
    assert.equal(otherFile.sourceSha, 'sha-other')
    const otherEyes = otherFile.predicates.find((predicate: { id: string }) => predicate.id === 'ender_eyes')
    assert.equal(otherEyes?.satisfied, false, 'the other run sees its OWN false, never this run proven true')
    ok('recorder is run-scoped, merges monotonically across reloads, and never downgrades a proven true')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// 4. A malformed / foreign-run file is ignored, not merged
// ---------------------------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'milestone-predicates-bad-'))
  try {
    const runId = 'run-fixture-bad'
    writeFileSync(join(dir, milestonePredicateFileName(runId)), JSON.stringify({ record: 'other', runId }))
    const recorder = new MilestonePredicateRecorder({ runId, sourceSha: null, dir, now: () => AT, refreshMs: 0 })
    assert.equal(recorder.current().predicates.length, 0, 'a record mismatch is ignored')
    writeFileSync(join(dir, milestonePredicateFileName(runId)), JSON.stringify({ record: 'milestone-predicates', runId: 'run-different', predicates: [] }))
    const recorder2 = new MilestonePredicateRecorder({ runId, sourceSha: null, dir, now: () => AT, refreshMs: 0 })
    assert.equal(recorder2.current().predicates.length, 0, 'a body runId mismatch is ignored')
    ok('a wrong record tag or foreign runId is ignored rather than merged')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log(`\ntest-milestone-predicates: ${checks} checks passed`)
