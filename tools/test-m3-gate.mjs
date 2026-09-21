#!/usr/bin/env bun
// test-m3-gate: offline evidence for the run-scoped current-M3 gate.
//
// MILESTONE-CONTRACT.json M3 ("12 Eyes of Ender") has ONE terminal predicate,
// `ender_eye >= 12`, plus the model-authority proof the current-M2 gate already
// enforces. tools/m3-gate.mjs must judge it from ONE runId:
//   PASS    <- ender_eye>=12 AND model authority verified, all R-bound
//   FAIL    <- every crafting input present in one R sample but eyes short
//   UNKNOWN <- anything else, including no runId and cross-run evidence
//
// The negative direction is the point: evidence combined across two runs, or any
// missing fact, must be UNKNOWN and can NEVER be PASS.
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanRunLines } from './m2-gate.mjs'
import {
  M3_REQUIRED_CONDITIONS,
  M3_RUN_RESULT,
  evaluateEnderEyes,
  evaluateM3AuthorityEvidence,
  requestedM3RunId,
  runM3Gate,
} from './m3-gate.mjs'
import { CURRENT_M3, exactRunId, hasRunScope, runGate as runLiveGate } from './m3-live-gate.mjs'

let checks = 0
function ok(label) {
  checks += 1
  console.log(`  ok ${checks} - ${label}`)
}

function capture() {
  const lines = []
  return { lines, write: (line) => lines.push(line), text: () => lines.join('\n') }
}

const RUN = 'run-m3-a'
const OTHER_RUN = 'run-m3-b'

const VERIFIED_POLICY = {
  decisions: { runId: RUN, source: 'fixture:decisions', jevCount: 3, fallbackCount: 0, otherCount: 0 },
  generation: {
    runId: RUN,
    source: 'fixture:generation',
    policyKind: 'typesafe',
    policyModel: 'typesafe-ai/jev',
    plannerMode: 'llm',
    deterministicFallbackEnabled: false,
  },
}
const FALLBACK_POLICY = {
  decisions: { runId: RUN, source: 'fixture:decisions', jevCount: 0, fallbackCount: 3, otherCount: 0 },
  generation: {
    runId: RUN,
    source: 'fixture:generation',
    policyKind: 'fallback',
    policyModel: 'deterministic-local-fallback',
    plannerMode: 'deterministic',
    deterministicFallbackEnabled: true,
  },
}

const boot = (runId) => `[2026-09-20T10:00:00.000Z] BOOT pid=1 runId=${runId} bundle=none source=abc123 worldEpoch=1`
const inv = (counts, pos = '10,64,20') => `[2026-09-20T10:00:01.000Z] INVENTORY items=${JSON.stringify(counts)} pos=${pos}`
const heartbeat = (dimension) => `[2026-09-20T10:00:01.500Z] HEARTBEAT pos=10,64,20 health=20 dimension=${dimension}`

const PORTAL_CHAIN = [
  '[2026-09-20T10:00:02.000Z] PORTAL_BLOCK_PLACED pos=10,64,20',
  '[2026-09-20T10:00:03.000Z] PORTAL_FRAME_READY blocks=10 shape=ok',
  '[2026-09-20T10:00:04.000Z] PORTAL_LIT pos=11,65,20 dimension=minecraft:overworld',
  '[2026-09-20T10:00:05.000Z] PORTAL_VERIFIED=true',
]

const EYES_READY = inv({ ender_pearl: 12, blaze_rod: 7, blaze_powder: 14, ender_eye: 12 })
const MATERIALS_ONLY = inv({ ender_pearl: 12, blaze_rod: 7, blaze_powder: 14, ender_eye: 4 })
const FULL_RUN = [boot(RUN), heartbeat('minecraft:the_nether'), EYES_READY]

/** Build injected run-scoped evidence through the real M2 scanner (shared schema). */
function evidenceFrom(lines, runId = RUN) {
  const scanned = scanRunLines(runId, lines)
  if (scanned.status !== 'valid') {
    return { status: 'unknown', runId, sources: [], mismatches: [scanned.reason], reason: scanned.reason }
  }
  return {
    status: 'valid',
    runId,
    sources: [
      {
        name: 'fixture:log',
        path: 'fixture',
        portalEvents: scanned.portalEvents,
        inventorySamples: scanned.inventorySamples,
        dimensionObservations: scanned.dimensionObservations ?? [],
      },
    ],
    mismatches: [],
  }
}

async function judge({ lines = FULL_RUN, expectedRunId = RUN, readEvidence, json = false, policyEvidence = VERIFIED_POLICY } = {}) {
  const out = capture()
  const code = await runM3Gate({
    expectedRunId,
    readEvidence: readEvidence ?? (async () => evidenceFrom(lines, expectedRunId)),
    write: out.write,
    json,
    policyEvidence,
  })
  return { code, text: out.text(), lines: out.lines }
}

// ---------------------------------------------------------------------------
// 1. RED: the pure fact predicates
// ---------------------------------------------------------------------------
assert.equal(evaluateEnderEyes([{ ender_eye: 12 }]).ready, true)
assert.equal(evaluateEnderEyes([{ ender_eye: 11 }]).ready, false)
assert.equal(evaluateEnderEyes([{ ender_eye: 11 }]).materialInputsComplete, false)
assert.equal(evaluateEnderEyes([{ ender_pearl: 12, blaze_rod: 7 }]).materialInputsComplete, true)
assert.equal(evaluateEnderEyes([{ ender_pearl: 12, blaze_powder: 12 }]).materialInputsComplete, true)
ok('evaluateEnderEyes requires 12 eyes and detects complete crafting inputs')

{
  const verified = evaluateM3AuthorityEvidence({ expectedRunId: RUN, ...VERIFIED_POLICY })
  assert.equal(verified.code, 0)
  const badPlanner = evaluateM3AuthorityEvidence({
    expectedRunId: RUN,
    decisions: VERIFIED_POLICY.decisions,
    generation: { ...VERIFIED_POLICY.generation, plannerMode: 'deterministic' },
  })
  assert.match(badPlanner.reason, /^planner_not_llm/, badPlanner.reason)
  const badFallback = evaluateM3AuthorityEvidence({
    expectedRunId: RUN,
    decisions: VERIFIED_POLICY.decisions,
    generation: { ...VERIFIED_POLICY.generation, deterministicFallbackEnabled: true },
  })
  assert.match(badFallback.reason, /^deterministic_fallback_not_disabled/, badFallback.reason)
  ok('M3 authority requires typesafe + planner=llm + deterministic fallback disabled')
}

// ---------------------------------------------------------------------------
// 2. RED: the same-run terminal predicate is the ONLY PASS
// ---------------------------------------------------------------------------
{
  const { code, text } = await judge()
  assert.equal(code, 0, `full same-run M3 evidence must PASS but returned ${code}:\n${text}`)
  for (const condition of M3_REQUIRED_CONDITIONS) assert.match(text, new RegExp(`${condition}: PASS`), text)
  assert.match(
    text,
    new RegExp(`${M3_RUN_RESULT} status=PASS reason=twelve_eyes_of_ender_verified runId=${RUN} ender_eye=PASS authority=PASS`),
    text,
  )
  assert.match(
    text,
    /m3_facts: ender_pearl=12 blaze_rod=7 blaze_powder=14 ender_eye=12 dimension=minecraft:the_nether/,
    text,
  )
  ok('same-run ender_eye>=12 + authority -> PASS/exit 0 (counts + dimension reported)')
}

// ---------------------------------------------------------------------------
// 3. RED: a known capability failure (materials present, eyes short) is FAIL
// ---------------------------------------------------------------------------
{
  const { code, text } = await judge({ lines: [boot(RUN), ...PORTAL_CHAIN, MATERIALS_ONLY] })
  assert.equal(code, 1, `materials-complete but eyes short must FAIL:\n${text}`)
  assert.match(text, /ender_eye_ready: FAIL/, text)
  assert.match(text, /status=FAIL reason=ender_eyes_short_with_crafting_materials/, text)
  ok('portal+pearl chain present but eyes short -> FAIL/exit 1')
}

// ---------------------------------------------------------------------------
// 4. RED: missing evidence is UNKNOWN, never PASS and never FAIL
// ---------------------------------------------------------------------------
{
  const { code, text } = await judge({ lines: [boot(RUN), inv({ ender_pearl: 4, ender_eye: 4 })] })
  assert.equal(code, 2, `eyes short without inputs must be UNKNOWN:\n${text}`)
  assert.match(text, /ender_eye_ready: UNKNOWN/, text)
  assert.match(text, /status=UNKNOWN/, text)
  ok('eyes short without crafting inputs -> UNKNOWN (not FAIL)')
}

{
  const { code, text } = await judge({ expectedRunId: null })
  assert.equal(code, 2)
  assert.match(text, /status=UNKNOWN reason=exact_run_scope_required runId=none/, text)
  assert.doesNotMatch(text, /status=PASS/)
  ok('no --run scope is UNKNOWN, never PASS')
}

{
  assert.throws(() => requestedM3RunId(['--run', 'not-a-run'], {}), /invalid --run/)
  assert.equal(requestedM3RunId(['--run', 'run-ok'], {}), 'run-ok')
  assert.equal(requestedM3RunId([], { M3_RUN_ID: 'run-env' }), 'run-env')
  assert.equal(requestedM3RunId([], { M2_RUN_ID: 'run-wrong-env' }), null)
  ok('requestedM3RunId reads M3_RUN_ID only and validates the run id shape')
}

// ---------------------------------------------------------------------------
// 5. RED: deterministic fallback authority can never satisfy M3
// ---------------------------------------------------------------------------
{
  const { code, text } = await judge({ policyEvidence: FALLBACK_POLICY })
  assert.equal(code, 2, `fallback policy must be UNKNOWN, never PASS:\n${text}`)
  assert.match(text, /policy: UNKNOWN reason=decisions_fallback_only/, text)
  assert.match(text, /status=UNKNOWN/, text)
  assert.doesNotMatch(text, /status=PASS/)
  ok('full eyes under deterministic fallback -> UNKNOWN/exit 2')
}

{
  const { code, text } = await judge({
    policyEvidence: { ...VERIFIED_POLICY, generation: { ...VERIFIED_POLICY.generation, plannerMode: 'deterministic' } },
  })
  assert.equal(code, 2, text)
  assert.match(text, /policy: UNKNOWN reason=planner_not_llm/, text)
  ok('planner != llm cannot satisfy M3')
}

// ---------------------------------------------------------------------------
// 6. RED: mixed-run evidence can never be joined into a PASS
// ---------------------------------------------------------------------------
{
  // Run A has only 4 pearls; run B proves the full 12 eyes.
  // M3 also requires live proof of Nether arrival, so each run in this fixture records the dimension
  // it observed; the cross-run negative below is about run binding, not about the Nether.
  const mixed = [boot(RUN), inv({ ender_pearl: 4 }), boot(OTHER_RUN), heartbeat('minecraft:the_nether'), EYES_READY]
  const asA = await judge({ lines: mixed, expectedRunId: RUN })
  assert.equal(asA.code, 2, asA.text)
  assert.match(asA.text, /ender_eye_ready: UNKNOWN/, asA.text)
  assert.doesNotMatch(asA.text, /status=PASS/)

  const asB = await judge({
    lines: mixed,
    expectedRunId: OTHER_RUN,
    policyEvidence: {
      ...VERIFIED_POLICY,
      decisions: { ...VERIFIED_POLICY.decisions, runId: OTHER_RUN },
      generation: { ...VERIFIED_POLICY.generation, runId: OTHER_RUN },
    },
  })
  assert.equal(asB.code, 0, asB.text)
  assert.match(asB.text, new RegExp(`runId=${OTHER_RUN}`), asB.text)
  ok('run B eyes are never attributed to run A (no cross-run join)')
}

{
  const out = capture()
  const code = await runM3Gate({
    expectedRunId: RUN,
    readEvidence: async () => ({
      status: 'valid',
      runId: OTHER_RUN,
      sources: [{ name: 'fixture:foreign', inventorySamples: [{ ender_eye: 12 }] }],
    }),
    policyEvidence: VERIFIED_POLICY,
    write: out.write,
  })
  assert.equal(code, 2, out.text())
  assert.match(out.text(), /status=UNKNOWN reason=evidence_run_mismatch/, out.text())
  assert.doesNotMatch(out.text(), /status=PASS/)
  ok('an injected evidence bundle naming another run cannot PASS')
}

// ---------------------------------------------------------------------------
// 7. RED: the run-scoped snapshot is a first-class source, bound to its runId
// ---------------------------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'm3-gate-'))
  const snapshot = {
    schemaVersion: 1,
    record: 'm2-snapshot',
    runId: RUN,
    atMs: 1,
    at: '2026-09-20T10:00:07.000Z',
    markers: [
      {
        name: 'PORTAL_VERIFIED',
        atMs: 5,
        at: 'x',
        inventory: { ender_pearl: 12, blaze_rod: 7, blaze_powder: 14, ender_eye: 12 },
        verified: true,
        dimension: 'minecraft:the_nether',
      },
    ],
    sequence: [],
    chain: { status: 'INCOMPLETE', required: [], observed: [] },
    inventory: { ender_eye: 12 },
    initialInventory: { ender_pearl: 12, blaze_rod: 7, blaze_powder: 14 },
    terminal: null,
  }
  writeFileSync(join(dir, `m2-snapshot-${RUN}.json`), JSON.stringify(snapshot))
  const out = capture()
  const code = await runM3Gate({
    expectedRunId: RUN,
    readEvidence: null,
    logPath: join(dir, 'absent.log'),
    snapshotDir: dir,
    policyEvidence: VERIFIED_POLICY,
    write: out.write,
  })
  assert.equal(code, 0, out.text())
  assert.match(out.text(), /m3_evidence: valid sources=snapshot/, out.text())
  assert.match(out.text(), /status=PASS/, out.text())

  // A file named for another run but carrying RUN's body is never attributed.
  writeFileSync(join(dir, `m2-snapshot-${OTHER_RUN}.json`), JSON.stringify({ ...snapshot, runId: RUN }))
  const out2 = capture()
  const code2 = await runM3Gate({
    expectedRunId: OTHER_RUN,
    readEvidence: null,
    logPath: join(dir, 'absent.log'),
    snapshotDir: dir,
    policyEvidence: {
      ...VERIFIED_POLICY,
      decisions: { ...VERIFIED_POLICY.decisions, runId: OTHER_RUN },
      generation: { ...VERIFIED_POLICY.generation, runId: OTHER_RUN },
    },
    write: out2.write,
  })
  assert.equal(code2, 2, out2.text())
  assert.doesNotMatch(out2.text(), /status=PASS/)
  ok('a run-scoped snapshot passes for its own run and is never borrowed by another')
}

// ---------------------------------------------------------------------------
// 8. json output carries the machine status
// ---------------------------------------------------------------------------
{
  const { code, text } = await judge({ json: true })
  const parsed = JSON.parse(text)
  assert.equal(code, 0)
  assert.equal(parsed.status, 'PASS')
  assert.equal(parsed.conditions.ender_eye_ready, 'PASS')
  assert.equal(parsed.conditions.model_authority, 'PASS')
  ok('--json emits the structured verdict')
}

// ---------------------------------------------------------------------------
// 9. RED: the live gate cannot PASS without an exact runId
// ---------------------------------------------------------------------------
{
  assert.equal(exactRunId(['--run', RUN], {}), RUN)
  assert.equal(exactRunId([], { M3_RUN_ID: RUN }), RUN)
  assert.equal(exactRunId(['--run', 'bad'], {}), null)
  assert.equal(hasRunScope(['--since', '2026-09-20T10:00:00Z'], {}), false)
  assert.equal(hasRunScope([], { M3_RUN_ID: RUN }), true)

  const out = capture()
  const code = await runLiveGate({
    argv: ['--since', '2026-09-20T10:00:00Z'],
    env: {},
    readEvidence: async () => {
      throw new Error('evidence reader must not run without exact scope')
    },
    write: out.write,
  })
  assert.equal(code, 2)
  assert.match(out.text(), /M3_LIVE_RESULT status=UNKNOWN reason=exact_run_scope_required/, out.text())
  ok('live gate: timestamp-only invocation cannot PASS and does not read evidence')
}

{
  const out = capture()
  const code = await runLiveGate({
    argv: ['--run', RUN],
    env: {},
    readEvidence: async (runId) => {
      assert.equal(runId, RUN)
      return evidenceFrom(FULL_RUN)
    },
    policyEvidence: VERIFIED_POLICY,
    write: out.write,
  })
  assert.equal(code, 0, out.text())
  assert.match(out.text(), new RegExp(`M3_LIVE_GATE current=${CURRENT_M3} runId=${RUN}`), out.text())
  assert.match(out.text(), new RegExp(`M3_LIVE_RESULT status=PASS reason=twelve_eyes_of_ender_verified runId=${RUN}`), out.text())
  ok('live gate delegates the run-scoped M3 verdict')
}

console.log(`m3-gate-test ${checks}/${checks} PASS`)
