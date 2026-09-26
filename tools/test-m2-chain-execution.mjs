#!/usr/bin/env bun
// test-m2-chain-execution: RED-FIRST evidence for tools/m2-chain-execution.mjs.
//
// The rehearsal exists so a fresh, no-assist M2 run cannot discover, at the end
// of a long live run, that a link between the portal half of the chain and the
// material half was never executable. This suite pins the MEASURED chain:
//
//   * eight links, driven through the REAL sensor (`buildWorldState`), the REAL
//     candidate layer (`generateGroundedCandidates`) and the REAL Executor
//     (`Executor.claim`) over a fake body, in order;
//   * the inventory DELTA of every link;
//   * the run-scoped marker(s) every link emits, read back from the one JSONL
//     sink the Executor wrote;
//   * the typed craft evidence (`CRAFT_DONE`/`CRAFT_FAILED`) - the only chain
//     link that had no typed, mirrored line before this lane;
//   * the measured FRONTIER: the world shapes in which a source yields no route,
//     including the legal damaged-ruin source that must stay mineable.
//
// Run: bun tools/test-m2-chain-execution.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  CHAIN_LINKS,
  CHAIN_START_INVENTORY,
  runExecutionChain,
} from './m2-chain-execution.mjs'

const REPO_ROOT = resolve(import.meta.dir, '..')
let checks = 0
function ok(label) {
  checks += 1
  console.log(`  ok ${checks} - ${label}`)
}
const read = (relative) => readFileSync(resolve(REPO_ROOT, relative), 'utf8')

const report = await runExecutionChain({ write: () => {} })
const linkById = new Map(report.links.map((entry) => [entry.id, entry]))
const markersFor = (id) => (linkById.get(id)?.attempts ?? []).flatMap((attempt) => attempt.markers ?? [])
const mergeDeltas = (id) => {
  const out = {}
  for (const attempt of linkById.get(id)?.attempts ?? []) {
    for (const [name, change] of Object.entries(attempt.delta ?? {})) out[name] = (out[name] ?? 0) + change
  }
  return out
}

// ---------------------------------------------------------------------------
// 1. the whole chain drives, in ONE run, through the real layers
// ---------------------------------------------------------------------------
{
  assert.equal(report.result, 'DRIVEN', `chain must drive: ${report.missing.join(',')}`)
  assert.deepEqual(report.missing, [])
  assert.equal(report.firstUndrivable, null)
  assert.equal(report.links.length, 8)
  assert.deepEqual(
    report.links.map((entry) => entry.id),
    [
      'L1_mine_iron_ore',
      'L2_smelt_three_iron_ingot',
      'L3_craft_iron_pickaxe',
      'L4_mine_three_diamond',
      'L5_craft_diamond_pickaxe',
      'L6_mine_ten_obsidian',
      'L7_place_portal_frame',
      'L8_light_and_verify_portal',
    ],
  )
  for (const link of report.links) {
    assert.equal(link.driven, true, `${link.id} not driven`)
    for (const attempt of link.attempts) {
      assert.equal(attempt.result.status, 'done', `${link.id} status`)
      assert.equal(attempt.result.verified, true, `${link.id} verified`)
    }
  }
  // The chain starts from the post-bootstrap body: a pickaxe is held, and the
  // tool-bootstrap link (logs -> planks -> table -> pickaxe) is NOT rehearsed.
  assert.equal(CHAIN_START_INVENTORY.stone_pickaxe, 1)
  assert.equal(CHAIN_LINKS[0].id, 'L1_mine_iron_ore')
  ok('all eight material links are driven by the real sensor + candidate layer + Executor in one run')
}

// ---------------------------------------------------------------------------
// 2. every link's inventory delta is the one the chain requires
// ---------------------------------------------------------------------------
{
  const expected = new Map(CHAIN_LINKS.map((link) => [link.id, link.delta]))
  for (const link of report.links) {
    assert.deepEqual(mergeDeltas(link.id), expected.get(link.id), `${link.id} inventory delta`)
  }
  assert.deepEqual(mergeDeltas('L1_mine_iron_ore'), { raw_iron: 3 })
  assert.deepEqual(mergeDeltas('L2_smelt_three_iron_ingot'), { iron_ingot: 3, raw_iron: -3, coal: -1 })
  assert.deepEqual(mergeDeltas('L3_craft_iron_pickaxe'), { iron_pickaxe: 1, iron_ingot: -3, stick: -2 })
  assert.deepEqual(mergeDeltas('L4_mine_three_diamond'), { diamond: 3 })
  assert.deepEqual(mergeDeltas('L5_craft_diamond_pickaxe'), { diamond_pickaxe: 1, diamond: -3, stick: -2 })
  assert.deepEqual(mergeDeltas('L6_mine_ten_obsidian'), { obsidian: 10 })
  assert.deepEqual(mergeDeltas('L7_place_portal_frame'), { obsidian: -10 })
  // The final body carries exactly what a gate-building run must carry.
  assert.equal(report.inventory.iron_pickaxe, 1)
  assert.equal(report.inventory.diamond_pickaxe, 1)
  assert.equal(report.inventory.obsidian, 0)
  assert.equal(report.world.lit, true)
  ok('every link moves exactly the inventory the chain requires, and the final body carries the tools')
}

// ---------------------------------------------------------------------------
// 3. "mine a block whose harvest truth is known" emits the typed dig evidence
// ---------------------------------------------------------------------------
{
  for (const id of ['L1_mine_iron_ore', 'L4_mine_three_diamond', 'L6_mine_ten_obsidian']) {
    const markers = markersFor(id)
    assert.ok(
      markers.some((marker) => marker.startsWith('info:TOOL_CHOICE block=')),
      `${id} must name the tool the harvest truth requires`,
    )
    assert.ok(
      markers.some((marker) => /gained \d+/.test(marker) && marker.includes('blockRemoved=true')),
      `${id} must verify the block was removed and the drop was gained`,
    )
  }
  assert.equal(report.world.digCalls.length, 16, 'three iron + three diamond + ten obsidian digs')
  ok('the three MINE links emit TOOL_CHOICE + the verified blockRemoved/gained line')
}

// ---------------------------------------------------------------------------
// 4. "smelt an input" emits the typed smelt evidence
// ---------------------------------------------------------------------------
{
  const markers = markersFor('L2_smelt_three_iron_ingot')
  assert.ok(markers.some((marker) => marker.startsWith('info:FURNACE_READY ')), 'FURNACE_READY')
  assert.ok(
    markers.includes('info:SMELT_DONE item=iron_ingot gained=3 input=raw_iron fuel=coal output=3 delta=3'),
    `SMELT_DONE line: ${markers.find((marker) => marker.startsWith('info:SMELT_DONE')) ?? 'missing'}`,
  )
  ok('the smelt link emits FURNACE_READY and a SMELT_DONE line whose gained count is the real delta')
}

// ---------------------------------------------------------------------------
// 5. "obtain a tool" emits the TYPED craft evidence (the gap this lane closed)
// ---------------------------------------------------------------------------
{
  const expected = { L3_craft_iron_pickaxe: 'iron_pickaxe', L5_craft_diamond_pickaxe: 'diamond_pickaxe' }
  for (const [id, item] of Object.entries(expected)) {
    const done = markersFor(id).filter((marker) => marker.startsWith('info:CRAFT_DONE '))
    assert.equal(done.length, 1, `${id} must emit exactly one CRAFT_DONE: ${markersFor(id).join(' | ')}`)
    assert.match(done[0], new RegExp(`^info:CRAFT_DONE item=${item} gained=1 `))
    assert.match(done[0], /table=crafting_table@-8,64,0/)
  }
  // The formatter + its call site are PROBED in the source, so a rename or a
  // removed call is a GAP rather than a stale claim in a comment.
  const executor = read('packages/jev-agent/src/executor.ts')
  assert.match(
    executor,
    /export function formatCraftLog\(event: 'CRAFT_DONE' \| 'CRAFT_FAILED', detail: Record<string, unknown>\): string \{/,
    'formatCraftLog must exist',
  )
  assert.equal(
    executor.split("formatCraftLog('CRAFT_DONE'").length - 1,
    1,
    'exactly one CRAFT_DONE call site',
  )
  assert.equal(
    executor.split("formatCraftLog('CRAFT_FAILED'").length - 1,
    1,
    'exactly one CRAFT_FAILED call site',
  )
  // …and both must be on the MIRRORED path, or a run-scoped artifact still
  // cannot see them. The marker registry lives in the diagnostics plane since
  // the legacy controller was split.
  const controller = read('packages/jev-agent/src/candidate-diagnostics.ts')
  const mirror = /const MIRRORED_MARKERS[\s\S]*?\n\]\)/.exec(controller)
  assert.notEqual(mirror, null, 'MIRRORED_MARKERS block found')
  assert.match(mirror[0], /'CRAFT_DONE'/)
  assert.match(mirror[0], /'CRAFT_FAILED'/)
  ok('both craft links emit a typed CRAFT_DONE, and CRAFT_DONE/CRAFT_FAILED are on the mirrored path')
}

// ---------------------------------------------------------------------------
// 6. "place a structure from a plan" emits the per-cell + frame-ready evidence
// ---------------------------------------------------------------------------
{
  const markers = markersFor('L7_place_portal_frame')
  const placed = markers.filter((marker) => marker.startsWith('info:PORTAL_BLOCK_PLACED '))
  const ready = markers.filter((marker) => marker === 'info:PORTAL_FRAME_READY blocks=10 shape=ok')
  assert.equal(placed.length, 10, `one PORTAL_BLOCK_PLACED per verified cell: ${placed.length}`)
  assert.equal(ready.length, 1, 'exactly one PORTAL_FRAME_READY')
  assert.equal(report.world.placeCalls, 10, 'the executor placed ten cells')
  ok('the frame link emits 10 PORTAL_BLOCK_PLACED then exactly one PORTAL_FRAME_READY blocks=10 shape=ok')
}

// ---------------------------------------------------------------------------
// 7. "light and verify a structure" emits PORTAL_LIT then PORTAL_VERIFIED
// ---------------------------------------------------------------------------
{
  const markers = markersFor('L8_light_and_verify_portal')
  const lit = markers.findIndex((marker) => marker.startsWith('info:PORTAL_LIT pos='))
  const verified = markers.findIndex((marker) => marker === 'info:PORTAL_VERIFIED=true')
  assert.notEqual(lit, -1, 'PORTAL_LIT emitted')
  assert.notEqual(verified, -1, 'PORTAL_VERIFIED=true emitted')
  assert.ok(lit < verified, 'PORTAL_LIT precedes PORTAL_VERIFIED')
  assert.match(markers[lit], /dimension=minecraft:overworld$/)
  assert.deepEqual(report.world.activateCalls, ['11,65,0'])
  ok('the ignite link activates the light position and emits PORTAL_LIT then PORTAL_VERIFIED=true')
}

// ---------------------------------------------------------------------------
// 8. the links are grounded by the REAL candidate layer, never hand-built
// ---------------------------------------------------------------------------
{
  const source = read('tools/m2-chain-execution.mjs')
  assert.match(source, /generateGroundedCandidates\(state, candidateOptionsFor\(ctx\)\)/)
  // No hand-built candidate literal: a fixture that constructs its own Candidate
  // would prove nothing about the generator.
  for (const literal of ["kind: 'MINE'", "kind: 'SMELT'", "kind: 'CRAFT'", "kind: 'PLACE'", "kind: 'IGNITE'"]) {
    assert.equal(source.includes(literal), false, `the rehearsal must not hand-build a ${literal} candidate`)
  }
  // Every candidate id the run used is one the real generator names by kind.
  for (const link of report.links) {
    const kind = link.attempts[0].candidateKind
    assert.ok(
      ['MINE', 'SMELT', 'CRAFT', 'PLACE', 'IGNITE'].includes(kind),
      `${link.id} candidate kind`,
    )
    assert.equal(link.attempts[0].candidateId.startsWith(`${kind}:`), true, `${link.id} candidate id prefix`)
  }
  ok('every link is grounded by generateGroundedCandidates; the fixture hand-builds no candidate')
}

// ---------------------------------------------------------------------------
// 9. the unrehearsed link is named exactly once, and it is the bootstrap
// ---------------------------------------------------------------------------
{
  const source = read('tools/m2-chain-execution.mjs')
  assert.equal(source.split('M2_CHAIN_EXEC_UNREHEARSED').length - 1, 1, 'one unrehearsed link line')
  assert.match(source, /link=tool_bootstrap/)
  assert.match(source, /tool-bootstrap lane/)
  // The chain's own first link is NOT the bootstrap: the rehearsal starts from a
  // body that already holds a pickaxe.
  assert.equal(CHAIN_LINKS.some((link) => link.id.includes('bootstrap')), false)
  ok('the tool bootstrap is named exactly once as the first link this rehearsal does not drive')
}

// ---------------------------------------------------------------------------
// 10. the measured frontier: a damaged unlit ruin IS a legal source
// ---------------------------------------------------------------------------
{
  const byId = new Map(report.frontier.cases.map((entry) => [entry.id, entry]))
  const damaged = byId.get('F3_unlit_fragmented_ring')
  assert.ok(damaged.mineOffered > 0, 'a damaged, unlit obsidian ring must stay mineable')
  assert.equal(damaged.liveMembers, 0)
  assert.equal(damaged.frameShape, 'none')
  ok('a damaged, unlit obsidian ring (a ruined portal) grounds MINE candidates - the legal source works')
}

// ---------------------------------------------------------------------------
// 11. the frontier dead ends are measured and reported, not hidden
// ---------------------------------------------------------------------------
{
  const byId = new Map(report.frontier.cases.map((entry) => [entry.id, entry]))
  // The inherited LIT portal must never be a source.
  const lit = byId.get('F2_lit_ring')
  assert.equal(lit.mineOffered, 0, 'the lit inherited portal is protected')
  assert.ok(lit.liveMembers > 0)
  // An unlit complete ring is protected by the same live-structure rule (pinned
  // by test-live-structure-source.mts), so an intact frame-shaped ruin is NOT a
  // source: the report must name it rather than pretend the chain always drives.
  const unlit = byId.get('F1_unlit_complete_ring')
  assert.equal(unlit.mineOffered, 0)
  assert.equal(unlit.frameShape, 'ok')
  assert.ok(report.frontier.deadEnds.some((entry) => entry.id === 'F1_unlit_complete_ring'))
  // A sensed source the held pickaxe cannot harvest yields NO candidate and NO
  // withheld route: the tool need is measured as silence.
  const wrongTool = byId.get('F4_wrong_tool_at_source')
  assert.equal(wrongTool.sensedObsidian, 10)
  assert.equal(wrongTool.mineOffered, 0)
  assert.equal(wrongTool.withheld.length, 0)
  assert.equal(report.frontier.firstDeadEnd.id, 'F1_unlit_complete_ring')
  ok('the frontier names the protected intact ring and the silent wrong-tool source as measured dead ends')
}

// ---------------------------------------------------------------------------
// 12. every link carries at least one run-scoped marker, from one JSONL sink
// ---------------------------------------------------------------------------
{
  for (const link of report.links) {
    assert.ok(markersFor(link.id).length > 0, `${link.id} emitted no marker`)
  }
  assert.ok(report.markers.length > 200, `one run-scoped sink: ${report.markers.length} records`)
  assert.equal(report.logPath.endsWith('run.jsonl'), true)
  // The sink is the Executor's own EventLogger stream, so the markers are the
  // real emitters' output rather than a rehearsal paraphrase.
  assert.ok(report.markers.some((marker) => marker.includes('action#1 MINE:')))
  ok('every link carries run-scoped markers read back from the single Executor JSONL sink')
}

console.log(`m2-chain-execution-test ${checks}/${checks} PASS`)
