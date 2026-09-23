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
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parsePortalMarker } from './m2-gate.mjs'
import {
  GATE_REQUIRED_MARKER_ORDER,
  M2_FRESH_INVENTORY,
  M2_FRESH_TOOL_RANK,
  M2_READY_INVENTORY,
  M2_READY_TOOL_RANK,
  MARKER_EMITTER_PROBES,
  PLAN_STEP_GATE_STAGES,
  diffMarkerOrder,
  materializeSyntheticRun,
  probeMarkerEmitters,
  rehearseFreshRunChain,
  rehearsePlanChain,
  runRehearsal,
  runRealGate,
} from './m2-chain-rehearsal.mjs'

const REPO_ROOT = resolve(import.meta.dir, '..')

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

// ---------------------------------------------------------------------------
// 8. the emitter provenance is PROBED in the source, not remembered
// ---------------------------------------------------------------------------
// The previous revision carried hardcoded `executor.ts:825`-style references that
// had drifted (placedFrameCellLine is at executor.ts:1396). These assertions pin
// the derived form: every claim is a live search, the reported line really holds
// the claimed text, and a wrong root makes the probe fail instead of passing.
{
  assert.equal(report.probes.length, Object.values(MARKER_EMITTER_PROBES).flat().length)
  for (const probe of report.probes) {
    assert.equal(probe.ok, true, `emitter probe not found: ${probe.marker} ${probe.id} ${probe.file}`)
    assert.equal(probe.matches, 1, `emitter probe must match exactly once: ${probe.id} in ${probe.file}`)
    assert.ok(probe.line > 0, `emitter probe has no line: ${probe.id}`)
    const lines = readFileSync(join(REPO_ROOT, probe.file), 'utf8').split('\n')
    assert.ok(
      lines[probe.line - 1].includes(probe.text),
      `probe ${probe.id} claims ${probe.file}:${probe.line} but that line does not contain the emitter call`,
    )
  }
  // A root without the sources cannot produce a passing probe.
  const emptyRoot = mkdtempSync(join(tmpdir(), 'm2-rehearsal-empty-'))
  try {
    const blind = probeMarkerEmitters({ root: emptyRoot })
    assert.equal(blind.length, report.probes.length)
    assert.ok(blind.every((probe) => probe.ok === false && probe.line === -1))
  } finally {
    rmSync(emptyRoot, { recursive: true, force: true })
  }
  // Every gate stage the plan feeds is one of the gate's own stage names.
  assert.deepEqual(Object.values(PLAN_STEP_GATE_STAGES), ['portal_built', 'portal_lit', 'portal_lit'])
  ok('every marker emitter claim is a live source probe, verified line by line')
}

// ---------------------------------------------------------------------------
// 9. fresh-run capability: what the chain needs, and what it refuses
// ---------------------------------------------------------------------------
{
  assert.deepEqual(M2_FRESH_INVENTORY, { stone_pickaxe: 1, cobblestone: 16 })
  assert.equal(M2_FRESH_TOOL_RANK, 2)
  const fresh = report.fresh
  assert.deepEqual(fresh, rehearseFreshRunChain())
  // The obsidian mine is REFUSED without the diamond pickaxe, never attempted.
  assert.equal(fresh.mining.refused, true)
  assert.equal(fresh.mining.refusedLine, 'PRECONDITION_MISSING tool=diamond_pickaxe')
  assert.equal(fresh.mining.allowedWithDiamond, true)
  assert.match(fresh.mining.allowedLine, /^MINE_OBSIDIAN target=obsidian count=10 tool=diamond_pickaxe$/)
  // The material chain is emitted in dependency order: diamond -> diamond_pickaxe
  // -> obsidian, with the obsidian step carrying the rank-4 tool requirement.
  assert.equal(fresh.plan.ready, false, 'a fresh inventory is not M2-ready')
  assert.equal(fresh.plan.prerequisitesOrdered, true)
  assert.ok(fresh.plan.diamondIndex < fresh.plan.pickaxeIndex)
  assert.ok(fresh.plan.pickaxeIndex < fresh.plan.obsidianIndex)
  assert.equal(fresh.plan.diamondCount, 3)
  assert.equal(fresh.plan.obsidianCount, 10)
  assert.equal(fresh.plan.obsidianRequiredPickaxeRank, 4)
  assert.equal(fresh.plan.pickaxePostcondition, 'toolRankAtLeast')
  // The frame leg is placeable as-is (10 edge cells, corners optional).
  assert.equal(fresh.frame.cells, 10)
  assert.equal(fresh.frame.shape, 'ok')
  assert.equal(fresh.frame.allCellsPlaceable, true)
  assert.equal(fresh.frame.frameLine, 'PORTAL_FRAME_READY blocks=10 shape=ok')
  // The ignition leg is refused without flint_and_steel.
  assert.equal(fresh.ignition.refusedWithoutSteel, true)
  assert.equal(fresh.ignition.refusalLine, 'PRECONDITION_MISSING tool=flint_and_steel')
  assert.equal(fresh.ignition.offeredWithSteel, true)
  assert.match(fresh.ignition.litLine, /^PORTAL_LIT pos=\d+,\d+,\d+ dimension=minecraft:overworld$/)
  ok('a fresh run must gather diamond x3 -> diamond_pickaxe -> obsidian x10 + flint_and_steel to build/light the frame')
}

// ---------------------------------------------------------------------------
// 10. the real gate's ordered chain trace is parsed back and pinned
// ---------------------------------------------------------------------------
{
  const positiveLink = report.positive.chainLinks.find((entry) => entry.source !== 'none')
  assert.ok(positiveLink !== null, 'the PASS fixture must carry a chain trace')
  assert.equal(positiveLink.built, 'PASS')
  assert.equal(positiveLink.lit, 'PASS')
  assert.equal(positiveLink.verified, 'PASS')
  assert.equal(positiveLink.ordered, true)
  assert.equal(positiveLink.overworld, true)
  assert.equal(positiveLink.blocks, 10)
  assert.equal(positiveLink.shape, 'ok')
  assert.equal(positiveLink.dimension, 'minecraft:overworld')
  const { placed, frame, lit, verified } = positiveLink.indices
  assert.ok(placed >= 0 && placed < frame && frame < lit && lit < verified)

  const inheritedLink = report.inherited.chainLinks.find((entry) => entry.source !== 'none')
  assert.ok(inheritedLink !== null)
  assert.equal(inheritedLink.ordered, false)
  for (const name of ['built', 'lit', 'verified']) assert.equal(inheritedLink[name], 'UNKNOWN')

  const freshLink = report.freshGate.chainLinks.find((entry) => entry.source !== 'none')
  assert.ok(freshLink !== null)
  assert.equal(freshLink.ordered, false)
  for (const name of ['built', 'lit', 'verified']) assert.equal(freshLink[name], 'UNKNOWN')
  ok('the gate chain trace is PASS for the chain, and link-less for inherited and fresh runs')
}

// ---------------------------------------------------------------------------
// 10b. the same chain through the operator's declared-root surface (--root)
// ---------------------------------------------------------------------------
{
  // The rehearsal's explicit-path case proves the chain EXISTS in the run. This
  // case proves the OPERATOR can reach it: `--root <resident-tree>` with no
  // explicit evidence paths must find the same chain, the same ordered links and
  // a VERIFIED authority verdict. Without this, a live run's evidence is provable
  // only by someone who already knows every private path.
  const declared = report.declaredRoot
  assert.ok(declared !== undefined, 'the rehearsal must exercise the declared-root surface')
  assert.equal(declared.exitCode, 0, declared.stdout)
  assert.equal(declared.status, 'PASS')
  assert.match(declared.evidenceRootsLine ?? '', /discover=false/)
  assert.match(declared.evidenceRootsLine ?? '', /log_from=.*buddy-driver\/buddy\.log/)
  assert.match(declared.policyLine ?? '', /^policy: VERIFIED/)
  const link = declared.chainLinks.find((entry) => entry.source !== 'none')
  assert.ok(link !== null, 'the declared-root fixture must carry a chain trace')
  assert.equal(link.built, 'PASS')
  assert.equal(link.lit, 'PASS')
  assert.equal(link.verified, 'PASS')
  assert.equal(link.ordered, true)
  assert.equal(link.overworld, true)
  const { placed, frame, lit, verified } = link.indices
  assert.ok(placed >= 0 && placed < frame && frame < lit && lit < verified)
  assert.deepEqual(declared.stdout.split('\n').filter((line) => line.startsWith('m2_chain:')).length >= 1, true)
  ok('--root <resident-tree> alone reaches the same ordered chain and VERIFIED policy as the explicit paths')
}

// ---------------------------------------------------------------------------
// 11. a FRESH run's own evidence is UNKNOWN, never PASS
// ---------------------------------------------------------------------------
{
  assert.equal(report.freshGate.exitCode, 2)
  assert.equal(report.freshGate.status, 'UNKNOWN')
  assert.match(report.freshGate.resultLine, /diamond=UNKNOWN materials=UNKNOWN frame=UNKNOWN lit=UNKNOWN/)
  assert.match(report.freshGate.reason, /^m2_stages_incomplete:/)
  assert.doesNotMatch(report.freshGate.stdout, /status=PASS/)
  ok('a fresh inventory with no chain -> UNKNOWN (the capability is proven, the outcome is not)')
}

console.log(`m2-chain-rehearsal-test ${checks}/${checks} PASS`)
