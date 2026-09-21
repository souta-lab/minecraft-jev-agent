#!/usr/bin/env bun
// test-m2-chain-rehearsal: offline, RED-FIRST evidence for tools/m2-chain-rehearsal.mjs.
//
// The rehearsal exists so a marker-order or reachability bug in the resident's
// own Nether-portal plan is found OFFLINE, before the end of a long live run.
// This suite pins:
//   * the REAL plan (netherPortalPlan.ts) emits exactly build -> light -> verify
//     for the exact post-prerequisite inventory, with no prerequisites left;
//   * every typed plan step projects onto the marker names the REAL executor
//     emits (netherPortalPlan.ts formatters + executor.ts emission sites);
//   * the projected order equals tools/m2-gate.mjs's required chain and the real
//     gate PASSes a synthetic single-run fixture built from those lines;
//   * the negatives: inherited portal -> UNKNOWN reason=inherited_portal, a
//     PORTAL_LIT without a dimension never PASSes, and a reordered/chainless
//     chain never PASSes;
//   * a missing / out-of-order / renamed stage produces a precise diff.
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { parsePortalMarker } from './m2-gate.mjs'
import {
  GATE_REQUIRED_MARKER_ORDER,
  M2_READY_INVENTORY,
  M2_READY_TOOL_RANK,
  diffMarkerOrder,
  materializeSyntheticRun,
  rehearsePlanChain,
  runRehearsal,
  runRealGate,
} from './m2-chain-rehearsal.mjs'

let checks = 0
function ok(label) {
  checks += 1
  console.log(`  ok ${checks} - ${label}`)
}

// ---------------------------------------------------------------------------
// 1. the REAL plan for the exact post-prerequisite inventory
// ---------------------------------------------------------------------------
assert.deepEqual(M2_READY_INVENTORY, { diamond: 3, diamond_pickaxe: 1, flint_and_steel: 1, obsidian: 10 })
assert.equal(M2_READY_TOOL_RANK, 4)
const rehearsal = rehearsePlanChain()
{
  assert.equal(rehearsal.plan.ready, true, 'a resident holding every M2 prerequisite needs no prerequisite step')
  assert.deepEqual(rehearsal.prerequisiteKinds, [])
  assert.deepEqual(rehearsal.stepKinds, ['build_portal_frame', 'light_portal', 'verify_portal'])
  assert.deepEqual(rehearsal.operationKinds, ['build_portal_frame', 'light_portal', 'verify_portal'])
  // The four public projection functions agree on the same ordered goals.
  assert.deepEqual(rehearsal.goalsFromSteps, rehearsal.plan.goals)
  assert.deepEqual(rehearsal.rungGoals, rehearsal.plan.goals)
  assert.deepEqual(rehearsal.perStepGoals.map((entry) => entry.goal), rehearsal.plan.goals)
  assert.equal(rehearsal.groundedBuildPlacementCells, 10, 'a grounded frame goal carries all 10 obsidian cells')
  assert.equal(rehearsal.frame.shape, 'ok')
  assert.equal(rehearsal.frame.blocks, 10)
  assert.deepEqual(rehearsal.unmappedStepKinds, [])
  // Sensitivity: an inventory short of the prerequisites is not silently ready.
  const deficient = rehearsePlanChain({ inventory: { diamond: 3, diamond_pickaxe: 1 } })
  assert.equal(deficient.plan.ready, false)
  assert.ok(deficient.prerequisiteKinds.length > 0, 'a missing obsidian/flint inventory has prerequisite steps')
  assert.ok(deficient.unmappedStepKinds.length > 0)
  ok('real plan for the M2-ready inventory: ready, no prerequisites, build>light>verify, 10-cell frame')
}

// ---------------------------------------------------------------------------
// 2. the plan projects onto the gate's required marker order
// ---------------------------------------------------------------------------
{
  assert.deepEqual(rehearsal.emittedStages, GATE_REQUIRED_MARKER_ORDER)
  assert.equal(rehearsal.order.ok, true)
  assert.deepEqual(rehearsal.gateChainErrors, [])
  assert.equal(rehearsal.chain.frameVerified, true)
  assert.equal(rehearsal.chain.litVerified, true)
  assert.equal(rehearsal.emittedMarkers.filter((name) => name === 'PORTAL_BLOCK_PLACED').length, 10)
  // The plan never invents the inherited-portal marker; that one belongs to the
  // resident's world-truth reader, not to the portal operation chain.
  assert.equal(rehearsal.emittedMarkers.includes('PORTAL_TRUTH'), false)
  for (const line of rehearsal.emittedLines) {
    assert.notEqual(parsePortalMarker(line), null, `real gate parser rejects derived line: ${line}`)
  }
  assert.match(rehearsal.frame.frameLine, /^PORTAL_FRAME_READY blocks=10 shape=ok$/)
  assert.match(rehearsal.frame.litLine, /^PORTAL_LIT pos=\d+,\d+,\d+ dimension=minecraft:overworld$/)
  assert.equal(rehearsal.frame.verifiedLine, 'PORTAL_VERIFIED=true')
  ok('projected chain PORTAL_BLOCK_PLACED>PORTAL_FRAME_READY>PORTAL_LIT>PORTAL_VERIFIED with 10 placed cells')
}

// ---------------------------------------------------------------------------
// 3. RED: the precise order diff
// ---------------------------------------------------------------------------
{
  const exact = diffMarkerOrder(GATE_REQUIRED_MARKER_ORDER, GATE_REQUIRED_MARKER_ORDER)
  assert.deepEqual(exact, { ok: true, missing: [], problems: [] })

  const missingFrame = diffMarkerOrder(
    ['PORTAL_BLOCK_PLACED', 'PORTAL_LIT', 'PORTAL_VERIFIED'],
    GATE_REQUIRED_MARKER_ORDER,
  )
  assert.equal(missingFrame.ok, false)
  assert.deepEqual(missingFrame.missing, ['PORTAL_FRAME_READY'])

  const swapped = diffMarkerOrder(
    ['PORTAL_BLOCK_PLACED', 'PORTAL_FRAME_READY', 'PORTAL_VERIFIED', 'PORTAL_LIT'],
    GATE_REQUIRED_MARKER_ORDER,
  )
  assert.equal(swapped.ok, false)
  assert.equal(swapped.missing.length, 0)
  assert.match(swapped.problems.join(','), /out_of_order:/)

  const renamed = diffMarkerOrder(
    ['PORTAL_BLOCK_PLACED', 'PORTAL_FRAME_READY', 'PORTAL_IGNITED', 'PORTAL_VERIFIED'],
    GATE_REQUIRED_MARKER_ORDER,
  )
  assert.equal(renamed.ok, false)
  assert.deepEqual(renamed.missing, ['PORTAL_LIT'])
  assert.match(renamed.problems.join(','), /unexpected_marker:PORTAL_IGNITED/)
  ok('a missing, out-of-order, or renamed stage produces a precise diff')
}

// ---------------------------------------------------------------------------
// 4. the REAL tools/m2-gate.mjs subprocess on the synthetic single-run fixture
// ---------------------------------------------------------------------------
const report = runRehearsal()
{
  assert.equal(report.result, 'READY', `rehearsal must be READY: ${report.missing.join(',')}`)
  assert.deepEqual(report.missing, [])
  assert.equal(report.positive.exitCode, 0)
  assert.equal(report.positive.status, 'PASS')
  assert.match(report.positive.resultLine, /M2_RUN_RESULT status=PASS reason=diamond_to_nether_gate_verified runId=run-m2-rehearsal/)
  assert.match(report.positive.stdout, /diamond_ready: PASS/)
  assert.match(report.positive.stdout, /portal_materials_ready: PASS/)
  assert.match(report.positive.stdout, /portal_built: PASS/)
  assert.match(report.positive.stdout, /portal_lit: PASS/)
  assert.match(report.positive.stdout, /policy: VERIFIED/)
  ok('real m2-gate.mjs subprocess PASSes the plan-derived single-run chain')
}

// ---------------------------------------------------------------------------
// 5. negative: inherited portal (no build chain) is a named UNKNOWN
// ---------------------------------------------------------------------------
{
  assert.equal(report.inherited.exitCode, 2)
  assert.equal(report.inherited.status, 'UNKNOWN')
  assert.equal(report.inherited.reason, 'inherited_portal')
  assert.match(report.inherited.resultLine, /M2_RUN_RESULT status=UNKNOWN reason=inherited_portal/)
  assert.match(report.inherited.stdout, /m2_inherited_portal: true observations=1 kinds=live_world_truth/)
  assert.doesNotMatch(report.inherited.stdout, /status=PASS/)
  ok('inherited-portal run -> UNKNOWN reason=inherited_portal (never PASS)')
}

// ---------------------------------------------------------------------------
// 6. negative: PORTAL_LIT without a dimension must not PASS
// ---------------------------------------------------------------------------
{
  assert.notEqual(report.noDimension.exitCode, 0)
  assert.notEqual(report.noDimension.status, 'PASS')
  assert.match(report.noDimension.stdout, /portal_lit: UNKNOWN/)
  assert.match(report.noDimension.stdout, /reason=m2_stages_incomplete:portal_lit/)
  ok('PORTAL_LIT without dimension=minecraft:overworld -> UNKNOWN, never PASS')
}

// ---------------------------------------------------------------------------
// 7. mutation: a reordered or chainless synthetic chain is not a PASS
// ---------------------------------------------------------------------------
async function gateOnLines(caseName, lines) {
  const fixture = materializeSyntheticRun({ caseName, markerLines: lines })
  try {
    return runRealGate({ fixture })
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true })
  }
}
{
  const frameIndex = rehearsal.emittedLines.findIndex((line) => line.startsWith('PORTAL_FRAME_READY'))
  const litIndex = rehearsal.emittedLines.findIndex((line) => line.startsWith('PORTAL_LIT'))
  assert.notEqual(frameIndex, -1)
  assert.notEqual(litIndex, -1)
  const reordered = [...rehearsal.emittedLines]
  reordered[frameIndex] = rehearsal.emittedLines[litIndex]
  reordered[litIndex] = rehearsal.emittedLines[frameIndex]
  const reorderedResult = await gateOnLines('reordered', reordered)
  assert.notEqual(reorderedResult.exitCode, 0)
  assert.notEqual(reorderedResult.status, 'PASS')
  assert.match(reorderedResult.stdout, /portal_lit: UNKNOWN/)

  const chainless = rehearsal.emittedLines.filter((line) => !line.startsWith('PORTAL_BLOCK_PLACED'))
  const chainlessResult = await gateOnLines('chainless', chainless)
  assert.notEqual(chainlessResult.exitCode, 0)
  assert.notEqual(chainlessResult.status, 'PASS')
  assert.match(chainlessResult.stdout, /reason=inherited_portal/)
  ok('a reordered chain and a chainless PORTAL_VERIFIED=true never PASS the real gate')
}

console.log(`m2-chain-rehearsal-test ${checks}/${checks} PASS`)
