#!/usr/bin/env bun
// test-m2-gate: RED-FIRST evidence for the run-scoped current-M2 gate.
//
// MILESTONE-CONTRACT.json M2 ("Diamond-to-Nether-gate closed loop") has four
// stages, and tools/m2-gate.mjs must judge all four from ONE runId:
//   diamond_ready          <- diamond>=3 + diamond_pickaxe
//   portal_materials_ready <- flint_and_steel + obsidian>=10
//   portal_built           <- PORTAL_BLOCK_PLACED -> PORTAL_FRAME_READY shape=ok
//   portal_lit             <- PORTAL_LIT(overworld) -> PORTAL_VERIFIED=true
//
// The negative direction is the point of this suite: evidence combined across
// two runs, or any missing stage, must be UNKNOWN and can NEVER be PASS. A run
// that only INHERITS an already-verified portal (PORTAL_TRUTH verified=true from
// the live world / durable memory, or a chainless PORTAL_VERIFIED=true) is a
// named UNKNOWN (`inherited_portal`), not a PASS and not an anonymous gap.
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  INHERITED_PORTAL_REASON,
  M2_REQUIRED_STAGES,
  M2_RUN_RESULT,
  detectInheritedPortal,
  evaluateM2Gate,
  parseInventoryMarker,
  readM2Snapshot,
  requestedRunId,
  runM2Gate,
  scanRunLines,
} from './m2-gate.mjs'

let checks = 0
function ok(label) {
  checks += 1
  console.log(`  ok ${checks} - ${label}`)
}

function capture() {
  const lines = []
  return { lines, write: (line) => lines.push(line), text: () => lines.join('\n') }
}

const RUN = 'run-m2-a'
const OTHER_RUN = 'run-m2-b'

const VERIFIED_POLICY = {
  decisions: { runId: RUN, source: 'fixture:decisions', jevCount: 3, fallbackCount: 0, otherCount: 0 },
  generation: { runId: RUN, source: 'fixture:generation', policyKind: 'typesafe', policyModel: 'typesafe-ai/jev', plannerMode: 'llm', deterministicFallbackEnabled: false },
  system2: { runId: RUN, source: 'fixture:runner', count: 1, modelCount: 1, portalPlanCount: 1 },
}
const FALLBACK_POLICY = {
  decisions: { runId: RUN, source: 'fixture:decisions', jevCount: 0, fallbackCount: 3, otherCount: 0 },
  generation: { runId: RUN, source: 'fixture:generation', policyKind: 'fallback', policyModel: 'deterministic-local-fallback', plannerMode: 'deterministic', deterministicFallbackEnabled: true },
}

const boot = (runId) => `[2026-09-20T10:00:00.000Z] BOOT pid=1 runId=${runId} bundle=none source=abc123 worldEpoch=1`
const inv = (counts, pos = '10,64,20') => `[2026-09-20T10:00:01.000Z] INVENTORY items=${JSON.stringify(counts)} pos=${pos}`

const DIAMOND_READY = inv({ diamond: 3, diamond_pickaxe: 1 })
const MATERIALS_READY = inv({ flint_and_steel: 1, obsidian: 10 })

const PORTAL_CHAIN = [
  '[2026-09-20T10:00:02.000Z] PORTAL_BLOCK_PLACED pos=10,64,20',
  '[2026-09-20T10:00:03.000Z] PORTAL_BLOCK_PLACED pos=11,64,20',
  '[2026-09-20T10:00:04.000Z] PORTAL_FRAME_READY blocks=10 shape=ok',
  '[2026-09-20T10:00:05.000Z] PORTAL_LIT pos=11,65,20 dimension=minecraft:overworld',
  '[2026-09-20T10:00:06.000Z] PORTAL_VERIFIED=true',
]

/** The resident's live-world / durable-memory verdict: a portal already existed. */
const PORTAL_TRUTH_LIVE = '[2026-09-20T10:00:07.000Z] PORTAL_TRUTH verified=true reason=status source=live-world'
/** System2 grounding sees the inherited frame but that is not a run-scoped build. */
const PORTAL_FRAME_PROGRESS_10 = '[2026-09-20T10:00:07.500Z] PORTAL_FRAME_PROGRESS blocks=10 source=system2-grounding'

const FULL_RUN = [boot(RUN), DIAMOND_READY, MATERIALS_READY, ...PORTAL_CHAIN]

/** Build injected run-scoped evidence through the real scanner. */
function evidenceFrom(lines, runId = RUN) {
  const scanned = scanRunLines(runId, lines)
  if (scanned.status !== 'valid') {
    return { status: 'unknown', runId, sources: [], mismatches: [scanned.reason], reason: scanned.reason }
  }
  return {
    status: 'valid',
    runId,
    sources: [{ name: 'fixture:log', path: 'fixture', portalEvents: scanned.portalEvents, inventorySamples: scanned.inventorySamples }],
    mismatches: [],
  }
}

async function judge({ lines = FULL_RUN, expectedRunId = RUN, readEvidence, json = false, policyEvidence = VERIFIED_POLICY } = {}) {
  const out = capture()
  const code = await runM2Gate({
    expectedRunId,
    readEvidence: readEvidence ?? (async () => evidenceFrom(lines, expectedRunId)),
    write: out.write,
    json,
    policyEvidence,
  })
  return { code, text: out.text(), lines: out.lines }
}

// ---------------------------------------------------------------------------
// 1. RED: parser + scanner basics
// ---------------------------------------------------------------------------
assert.deepEqual(parseInventoryMarker(inv({ diamond: 3 })), { diamond: 3 })
assert.equal(parseInventoryMarker('plain prose with no counts'), null)
ok('parseInventoryMarker reads the flat counts map and rejects prose')

{
  const lines = [boot(RUN), inv({ diamond: 3 }), '[2026-09-20T10:00:02.000Z] PORTAL_LIT pos=1,2,3 dimension=minecraft:overworld']
  const scanned = scanRunLines(RUN, lines)
  assert.equal(scanned.status, 'valid')
  assert.equal(scanned.inventorySamples.length, 1)
  assert.deepEqual(scanned.portalEvents.map((event) => event.name), ['PORTAL_LIT'])
  ok('scanRunLines attributes untimed markers to the active BOOT run')
}

{
  // A second BOOT closes run A: lines after it belong to B, never to A.
  const lines = [boot(RUN), inv({ diamond: 3 }), boot(OTHER_RUN), inv({ diamond: 0 }), ...PORTAL_CHAIN]
  const scannedA = scanRunLines(RUN, lines)
  assert.equal(scannedA.status, 'valid')
  assert.equal(scannedA.inventorySamples.length, 1)
  assert.equal(scannedA.portalEvents.length, 0)
  const scannedB = scanRunLines(OTHER_RUN, lines)
  assert.equal(scannedB.portalEvents.length, PORTAL_CHAIN.length)
  assert.equal(scannedB.inventorySamples.length, 1)
  ok('a foreign BOOT boundary prevents cross-run attribution')
}

{
  const scanned = scanRunLines(RUN, ['[2026-09-20T10:00:00.000Z] INVENTORY items={"diamond":3} pos=0,0,0'])
  assert.equal(scanned.status, 'unknown')
  ok('an unscoped line with no BOOT is unknown, never attributed')
}

{
  const scanned = scanRunLines(RUN, [
    `[2026-09-20T10:00:00.000Z] INVENTORY runId=${RUN} items={"diamond":3} pos=0,0,0`,
    `[2026-09-20T10:00:01.000Z] PORTAL_VERIFIED=true runId=${RUN}`,
  ])
  assert.equal(scanned.status, 'unknown')
  assert.equal(scanned.inventorySamples.length, 0)
  assert.equal(scanned.portalEvents.length, 0)
  ok('a marker carrying runId without a real BOOT boundary is unknown')
}

// ---------------------------------------------------------------------------
// 2. RED: the same-run full chain is the ONLY PASS
// ---------------------------------------------------------------------------
{
  const { code, text } = await judge()
  assert.equal(code, 0, `full same-run M2 evidence must PASS but returned ${code}:\n${text}`)
  for (const stage of M2_REQUIRED_STAGES) assert.match(text, new RegExp(`${stage}: PASS`), text)
  assert.match(text, new RegExp(`${M2_RUN_RESULT} status=PASS reason=diamond_to_nether_gate_verified runId=${RUN}`), text)
  ok('full same-run diamond+materials+frame+ignition -> PASS/exit 0')
}


// ---------------------------------------------------------------------------
// 2b. RED: deterministic fallback can never satisfy milestone acceptance
// ---------------------------------------------------------------------------
{
  const { code, text } = await judge({ policyEvidence: FALLBACK_POLICY })
  assert.equal(code, 2, `fallback policy must be UNKNOWN, never PASS:
${text}`)
  assert.match(text, /policy: UNKNOWN reason=decisions_fallback_only/, text)
  assert.match(text, /status=UNKNOWN/, text)
  ok('full gameplay markers under deterministic fallback -> UNKNOWN/exit 2')
}

// ---------------------------------------------------------------------------
// 3. RED: missing stages are UNKNOWN, never PASS
// ---------------------------------------------------------------------------
for (const [label, lines, missing] of [
  ['no diamond evidence', [boot(RUN), MATERIALS_READY, ...PORTAL_CHAIN], 'diamond_ready'],
  ['diamond without the pickaxe', [boot(RUN), inv({ diamond: 3 }), MATERIALS_READY, ...PORTAL_CHAIN], 'diamond_ready'],
  // Unsatisfied only while the gate is NOT built: once the frame exists its ten edges ARE
  // the obsidian, so a run that continued a partially built frame must not be failed.
  ['obsidian short of 10 and no frame', [boot(RUN), DIAMOND_READY, inv({ flint_and_steel: 1, obsidian: 9 })], 'portal_materials_ready'],
  ['portal lit but never verified', [boot(RUN), DIAMOND_READY, MATERIALS_READY, ...PORTAL_CHAIN.slice(0, -1)], 'portal_lit'],
  ['portal verified in the nether dimension', [boot(RUN), DIAMOND_READY, MATERIALS_READY, ...PORTAL_CHAIN.slice(0, 3), '[2026-09-20T10:00:05.000Z] PORTAL_LIT pos=11,65,20 dimension=minecraft:the_nether', '[2026-09-20T10:00:06.000Z] PORTAL_VERIFIED=true'], 'portal_lit'],
  ['frame never validated', [boot(RUN), DIAMOND_READY, MATERIALS_READY, '[2026-09-20T10:00:02.000Z] PORTAL_BLOCK_PLACED pos=10,64,20'], 'portal_built'],
]) {
  const { code, text } = await judge({ lines })
  assert.notEqual(code, 0, `${label} must not PASS:\n${text}`)
  assert.match(text, new RegExp(`${missing}: (UNKNOWN|FAIL)`), text)
  assert.match(text, /status=UNKNOWN/, text)
  ok(`${label} -> UNKNOWN (no fabricated PASS)`)
}

{
  // Positive counterpart: nine obsidian observed but the run BUILT and lit the frame, so the
  // material precondition is proven by the outcome.
  const { code, text } = await judge({
    lines: [boot('run-m2-a'), DIAMOND_READY, inv({ flint_and_steel: 1, obsidian: 9 }), ...PORTAL_CHAIN],
    expectedRunId: 'run-m2-a',
  })
  assert.equal(code, 0, `a built frame proves its own materials:\n${text}`)
  assert.match(text, /status=PASS/, text)
  ok('obsidian short of 10 but the frame is built and lit -> PASS (materials proven by outcome)')
}

// ---------------------------------------------------------------------------
// 4. RED: mixed-run evidence can never be joined into a PASS
// ---------------------------------------------------------------------------
{
  // Run A proves the two inventory stages; run B proves the portal chain.
  const mixed = [boot(RUN), DIAMOND_READY, MATERIALS_READY, boot(OTHER_RUN), ...PORTAL_CHAIN]
  const asA = await judge({ lines: mixed, expectedRunId: RUN })
  assert.equal(asA.code, 2, asA.text)
  assert.match(asA.text, /portal_built: UNKNOWN/, asA.text)
  assert.match(asA.text, /status=UNKNOWN/, asA.text)

  const asB = await judge({ lines: mixed, expectedRunId: OTHER_RUN })
  assert.equal(asB.code, 2, asB.text)
  assert.match(asB.text, /diamond_ready: UNKNOWN/, asB.text)
  // Run B's own chain proves B's materials too; the isolation property is that B cannot
  // borrow A's diamond.
  assert.match(asB.text, /diamond_ready: UNKNOWN/, asB.text)
  assert.match(asB.text, /materials=PASS frame=PASS lit=PASS/, asB.text)
  ok('inventory in run A + portal in run B is UNKNOWN for both ids (no cross-run join)')
}

{
  const { code, text } = await judge({ expectedRunId: null })
  assert.equal(code, 2)
  assert.equal(evaluateM2Gate({ expectedRunId: null, evidence: evidenceFrom(FULL_RUN) }).reason, 'exact_run_scope_required')
  assert.match(text, /status=UNKNOWN reason=exact_run_scope_required/, text)
  ok('no --run scope is UNKNOWN')
}

{
  assert.throws(() => requestedRunId(['--run', 'not-a-run'], {}), /invalid --run/)
  assert.equal(requestedRunId(['--run', 'run-ok'], {}), 'run-ok')
  assert.equal(requestedRunId([], { M2_RUN_ID: 'run-env' }), 'run-env')
  ok('requestedRunId validates the run id shape')
}

// ---------------------------------------------------------------------------
// 5. RED: a known portal failure is FAIL, not UNKNOWN
// ---------------------------------------------------------------------------
for (const [label, marker] of [
  ['a bad frame shape', ['[2026-09-20T10:00:03.000Z] PORTAL_BLOCK_PLACED pos=10,64,20', '[2026-09-20T10:00:04.000Z] PORTAL_FRAME_READY blocks=9 shape=bad']],
  ['a refused light', ['[2026-09-20T10:00:03.000Z] PORTAL_BLOCK_PLACED pos=10,64,20', '[2026-09-20T10:00:04.000Z] PORTAL_FRAME_READY blocks=10 shape=ok', '[2026-09-20T10:00:05.000Z] PORTAL_LIGHT_REFUSED reason=frame_shape_bad shape=bad']],
  ['a false verification', [...PORTAL_CHAIN.slice(0, -1), '[2026-09-20T10:00:06.000Z] PORTAL_VERIFIED=false']],
]) {
  const { code, text } = await judge({ lines: [boot(RUN), DIAMOND_READY, MATERIALS_READY, ...marker] })
  assert.equal(code, 1, `${label} must FAIL:\n${text}`)
  assert.match(text, /status=FAIL/, text)
  ok(`${label} -> FAIL/exit 1`)
}

// ---------------------------------------------------------------------------
// 6. RED: the run-scoped snapshot is a first-class source, bound to its runId
// ---------------------------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'm2-gate-'))
  const snapshot = {
    schemaVersion: 1,
    record: 'm2-snapshot',
    runId: RUN,
    atMs: 1,
    at: '2026-09-20T10:00:07.000Z',
    markers: [
      { name: 'PORTAL_BLOCK_PLACED', atMs: 3, at: 'x', inventory: {}, pos: [1, 64, 0] },
      { name: 'PORTAL_FRAME_READY', atMs: 3, at: 'x', inventory: {}, blocks: 10, shape: 'ok', pos: [1, 68, 0] },
      { name: 'PORTAL_LIT', atMs: 4, at: 'x', inventory: {}, pos: [1, 65, 0], dimension: 'minecraft:overworld' },
      { name: 'PORTAL_VERIFIED', atMs: 5, at: 'x', inventory: {}, verified: true, dimension: 'minecraft:overworld' },
    ],
    sequence: [],
    chain: { status: 'INCOMPLETE', required: [], observed: [] },
    inventory: {},
    initialInventory: { diamond: 3, diamond_pickaxe: 1, flint_and_steel: 1, obsidian: 10 },
    terminal: null,
  }
  writeFileSync(join(dir, `m2-snapshot-${RUN}.json`), JSON.stringify(snapshot))
  const out = capture()
  const code = await runM2Gate({
    expectedRunId: RUN,
    readEvidence: null,
    logPath: join(dir, 'absent.log'),
    snapshotDir: dir,
    policyEvidence: VERIFIED_POLICY,
    write: out.write,
  })
  assert.equal(code, 0, out.text())
  assert.match(out.text(), /m2_evidence: valid sources=snapshot/, out.text())
  assert.match(out.text(), /status=PASS/, out.text())
  ok('a run-scoped snapshot with markers + inventory samples passes')

  // Same file, requested as another run: the snapshot is not attributable.
  const foreign = readM2Snapshot(OTHER_RUN, { snapshotDir: dir })
  assert.equal(foreign.status, 'unavailable')
  writeFileSync(join(dir, `m2-snapshot-${OTHER_RUN}.json`), JSON.stringify({ ...snapshot, runId: RUN }))
  const mismatched = readM2Snapshot(OTHER_RUN, { snapshotDir: dir })
  assert.equal(mismatched.status, 'unknown')
  assert.match(mismatched.reason, /snapshot_run_mismatch/)
  ok('a snapshot whose body runId differs is never attributed to the requested run')
}

// ---------------------------------------------------------------------------
// 7. RED: shape-only marker cannot claim the frame
// ---------------------------------------------------------------------------
{
  const lines = [
    boot(RUN),
    DIAMOND_READY,
    MATERIALS_READY,
    '[2026-09-20T10:00:04.000Z] PORTAL_FRAME_READY blocks=10 shape=ok',
    ...PORTAL_CHAIN.slice(3),
  ]
  const { code, text } = await judge({ lines })
  assert.equal(code, 2, text)
  assert.match(text, /portal_built: UNKNOWN/, text)
  ok('PORTAL_FRAME_READY without a placed block is not a built frame (UNKNOWN)')
}

// ---------------------------------------------------------------------------
// 8. json output carries the machine status
// ---------------------------------------------------------------------------
{
  const { code, text } = await judge({ json: true })
  const parsed = JSON.parse(text)
  assert.equal(code, 0)
  assert.equal(parsed.status, 'PASS')
  assert.equal(parsed.conditions.portal_lit, 'PASS')
  ok('--json emits the structured verdict')
}

// ---------------------------------------------------------------------------
// 9. RED: case (a) full chain PASSes; case (b) inherited portal is a named UNKNOWN
// ---------------------------------------------------------------------------
{
  assert.deepEqual(detectInheritedPortal(scanRunLines(RUN, [boot(RUN), PORTAL_TRUTH_LIVE]).portalEvents), {
    kind: 'live_world_truth',
    source: 'live-world',
    reason: 'status',
  })
  assert.equal(detectInheritedPortal([], null), null)
  assert.equal(
    detectInheritedPortal(scanRunLines(RUN, [boot(RUN), ...PORTAL_CHAIN]).portalEvents, { frameVerified: true }),
    null,
  )
  ok('detectInheritedPortal reads the live-world truth claim and ignores a real build chain')
}

{
  // Case (b): the world/memory already held a verified portal; R only observed it.
  const lines = [boot(RUN), DIAMOND_READY, MATERIALS_READY, PORTAL_TRUTH_LIVE]
  const { code, text } = await judge({ lines })
  assert.equal(code, 2, text)
  assert.match(text, /portal_built: UNKNOWN/, text)
  assert.match(text, /portal_lit: UNKNOWN/, text)
  assert.match(text, new RegExp(`${M2_RUN_RESULT} status=UNKNOWN reason=${INHERITED_PORTAL_REASON} runId=${RUN}`), text)
  assert.match(text, /m2_inherited_portal: true observations=1 kinds=live_world_truth/, text)
  assert.doesNotMatch(text, /status=PASS/, text)
  ok('an inherited live-world verified portal -> UNKNOWN reason=inherited_portal (never PASS)')
}

{
  // The exact live-run shape: PORTAL_TRUTH plus the grounding's frame progress,
  // still with no PORTAL_BLOCK_PLACED -> PORTAL_FRAME_READY chain of its own.
  const lines = [boot(RUN), DIAMOND_READY, MATERIALS_READY, PORTAL_TRUTH_LIVE, PORTAL_FRAME_PROGRESS_10]
  const { code, text } = await judge({ lines })
  assert.equal(code, 2, text)
  assert.match(text, /reason=inherited_portal/, text)
  assert.match(text, /m2_missing: portal_built,portal_lit/, text)
  assert.doesNotMatch(text, /status=PASS/, text)
  ok('PORTAL_TRUTH + PORTAL_FRAME_PROGRESS without a placed block -> inherited_portal')
}

{
  // A chainless PORTAL_VERIFIED=true is the same "already exists" claim.
  const lines = [boot(RUN), DIAMOND_READY, MATERIALS_READY, '[2026-09-20T10:00:06.000Z] PORTAL_VERIFIED=true']
  const { code, text } = await judge({ lines })
  assert.equal(code, 2, text)
  assert.match(text, /reason=inherited_portal/, text)
  assert.match(text, /kinds=runtime_verified_without_build_chain/, text)
  ok('PORTAL_VERIFIED=true with no build chain -> inherited_portal')
}

{
  // Case (a): a run that builds/lights/verifies its OWN chain still PASSes even
  // when an inherited truth line is present. Inheritance never blocks a real chain.
  const { code, text } = await judge({ lines: [...FULL_RUN, PORTAL_TRUTH_LIVE] })
  assert.equal(code, 0, text)
  assert.match(text, /status=PASS reason=diamond_to_nether_gate_verified/, text)
  assert.doesNotMatch(text, /m2_inherited_portal: true/, text)
  ok('a real same-run chain PASSes even when an inherited truth line is present')
}

{
  // A negative truth check is not an inheritance claim.
  const lines = [
    boot(RUN),
    DIAMOND_READY,
    MATERIALS_READY,
    '[2026-09-20T10:00:07.000Z] PORTAL_TRUTH verified=false reason=status source=live-world',
  ]
  const { code, text } = await judge({ lines })
  assert.equal(code, 2, text)
  assert.match(text, /reason=m2_stages_incomplete:portal_built,portal_lit/, text)
  assert.doesNotMatch(text, /m2_inherited_portal/, text)
  ok('PORTAL_TRUTH verified=false is not an inherited-portal claim')
}

console.log(`m2-gate-test ${checks}/${checks} PASS`)
