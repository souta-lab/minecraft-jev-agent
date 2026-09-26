#!/usr/bin/env bun
// test-m3-chain-rehearsal: offline, RED-FIRST evidence for tools/m3-chain-rehearsal.mjs.
//
// The rehearsal exists so a threshold, item-id or reachability bug in the 12-eye
// endgame is found OFFLINE, before the end of a long live run (Nether trip, 7
// blaze rods, 12 ender pearls). This suite pins:
//   * the REAL terminal craft path (generateGroundedCandidates + planNextCraftStep)
//     for the exact endgame inventory `ender_pearl:12 / blaze_rod:7` emits
//     `CRAFT:blaze_powder` first, then `CRAFT:ender_eye` until 12 eyes are held,
//     then STOPS -- with the exact sequence recorded;
//   * the multi-count `want` threading fixed in 30dec38 (want=12 keeps a partial
//     count offered; want=1 stalls at one eye);
//   * the real ladder rung, the real planner and the real gate agree on
//     12 eyes / 7 rods / 12 powder (a disagreement is a GAP with file:line);
//   * the REAL tools/m3-gate.mjs subprocess PASSes a synthetic single-run fixture
//     built from the path's own trace, and returns FAIL/UNKNOWN -- never PASS --
//     for 11 eyes, no runId, inputs with no eyes, `eye_of_ender`, a foreign run,
//     mixed-run evidence and missing model authority;
//   * a run with the foreign run's OWN runId still PASSes, so the negatives prove
//     attribution rather than a blanket failure.
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import {
  BLAZE_POWDER,
  BLAZE_ROD,
  BLAZE_ROD_REQUIRED,
  ENDER_EYE,
  ENDER_EYE_REQUIRED,
  ENDER_PEARL,
} from './m3-gate.mjs'
import {
  M3_CHAIN_SOURCES,
  M3_ENDGAME_INVENTORY,
  M3_POST_POWDER_INVENTORY,
  M3_TERMINAL_GOAL,
  checkThresholdsAndRungs,
  craftEffect,
  materializeSyntheticRun,
  rehearseTerminalCraft,
  runRealGate,
  runRehearsal,
} from './m3-chain-rehearsal.mjs'
import { createRecipeIndex, planNextCraftStep } from '../packages/jev-agent/src/crafting.ts'
import { loadGameData } from '../packages/jev-agent/src/gameData.ts'

let checks = 0
function ok(label) {
  checks += 1
  console.log(`  ok ${checks} - ${label}`)
}

const RECIPES = createRecipeIndex(loadGameData())

/** The exact sequence the real path emits from the endgame inventory. */
const ENDGAME_SEQUENCE = [
  'blaze_powderx2',
  'ender_eyex1',
  'ender_eyex1',
  'blaze_powderx2',
  'ender_eyex1',
  'ender_eyex1',
  'blaze_powderx2',
  'ender_eyex1',
  'ender_eyex1',
  'blaze_powderx2',
  'ender_eyex1',
  'ender_eyex1',
  'blaze_powderx2',
  'ender_eyex1',
  'ender_eyex1',
  'blaze_powderx2',
  'ender_eyex1',
  'ender_eyex1',
].join(' ')

const EXPECTED_EYES_TRACE =
  '0->craft 1->craft 2->craft 3->craft 4->craft 5->craft 6->craft 7->craft 8->craft 9->craft 10->craft 11->craft 12->stop'

// ---------------------------------------------------------------------------
// 1. the exact endgame inventory and the real terminal goal
// ---------------------------------------------------------------------------
assert.deepEqual(M3_ENDGAME_INVENTORY, { [ENDER_PEARL]: 12, [BLAZE_ROD]: 7 })
assert.deepEqual(M3_POST_POWDER_INVENTORY, { [ENDER_PEARL]: 12, [BLAZE_POWDER]: 14 })
assert.deepEqual(M3_TERMINAL_GOAL, { kind: 'craft', targetItem: ENDER_EYE, requiredCount: 12 })
assert.equal(ENDER_EYE, 'ender_eye')
assert.equal(ENDER_EYE_REQUIRED, 12)
assert.equal(BLAZE_ROD_REQUIRED, 7)
ok('endgame inventory is ender_pearl:12 + blaze_rod:7 and the terminal goal is craft 12 x ender_eye')

// ---------------------------------------------------------------------------
// 2. the REAL terminal craft path: powder descent, 12 eyes, then stop
// ---------------------------------------------------------------------------
const endgame = rehearseTerminalCraft({ inventory: M3_ENDGAME_INVENTORY })
{
  assert.deepEqual(endgame.errors, [])
  assert.equal(endgame.stopped, true, 'the path must stop emitting CRAFT once 12 eyes are held')
  assert.deepEqual(endgame.stageSet, [BLAZE_POWDER, ENDER_EYE], 'rods are milled to powder first, then eyes are crafted')
  assert.equal(endgame.craftSequence.join(' '), ENDGAME_SEQUENCE)
  assert.equal(endgame.eyesTrace, EXPECTED_EYES_TRACE)
  assert.equal(endgame.enderEyeCrafts, ENDER_EYE_REQUIRED, 'exactly 12 CRAFT:ender_eye emissions')
  assert.equal(endgame.powderCrafts, 6, '6 rods -> 12 powder is exactly what 12 eyes consume')
  assert.equal(endgame.rodsConsumed, 6)
  assert.equal(endgame.finalInventory[ENDER_EYE], ENDER_EYE_REQUIRED)
  assert.equal(endgame.finalInventory[BLAZE_ROD], 1, 'the 7th rod is a genuine surplus and is never milled')
  // Every pre-terminal step must carry a real planner op (no WAIT before 12).
  for (const step of endgame.steps) {
    if (step.have >= ENDER_EYE_REQUIRED) continue
    assert.notEqual(step.rootPlanOp, null, `step ${step.index} (eyes=${step.have}) lost its planner op`)
    assert.equal(step.rootPlanOp.type, 'craft')
  }
  const last = endgame.steps.at(-1)
  assert.equal(last.craftId, null, 'the final step is the stop: no CRAFT candidate')
  assert.deepEqual(last.candidateIds, ['WAIT'], 'only WAIT remains at 12 eyes')
  ok(`real path: ${endgame.craftSequence.length} steps -> CRAFT:blaze_powder first, 12 x CRAFT:ender_eye, then stop`)
}

// The emitted CRAFT candidate and the planner op are the same single step.
{
  const enderEyeCraft = endgame.steps.find((step) => step.craftItem === ENDER_EYE)
  assert.equal(enderEyeCraft.craftId, `CRAFT:${ENDER_EYE}`)
  assert.equal(enderEyeCraft.craftCount, 1)
  assert.equal(enderEyeCraft.rootPlanOp.item, ENDER_EYE)
  ok('the emitted CRAFT:ender_eye candidate IS planNextCraftStep\'s own op (one implementation)')
}

// ---------------------------------------------------------------------------
// 3. the isolated eye stage: 14 powder pre-supplied -> twelve eyes, then stop
// ---------------------------------------------------------------------------
const postPowder = rehearseTerminalCraft({ inventory: M3_POST_POWDER_INVENTORY })
{
  assert.deepEqual(postPowder.errors, [])
  assert.equal(postPowder.stopped, true)
  assert.deepEqual(postPowder.stageSet, [ENDER_EYE])
  assert.equal(postPowder.craftCount, ENDER_EYE_REQUIRED)
  assert.equal(postPowder.eyesTrace, EXPECTED_EYES_TRACE)
  assert.equal(postPowder.craftSequence.every((entry) => entry === `${ENDER_EYE}x1`), true)
  assert.equal(postPowder.finalInventory[ENDER_EYE], ENDER_EYE_REQUIRED)
  assert.equal(postPowder.finalInventory[BLAZE_POWDER], 2, '14 - 12 = 2 powder left over')
  ok('post-powder path: exactly 12 x CRAFT:ender_eye then stop (2 surplus powder)')
}

// ---------------------------------------------------------------------------
// 4. RED: the 30dec38 want threading is what keeps a partial count offered
// ---------------------------------------------------------------------------
{
  const atOneEye = { [ENDER_EYE]: 1, [ENDER_PEARL]: 11, [BLAZE_POWDER]: 11 }
  const wantRequired = planNextCraftStep(RECIPES, ENDER_EYE, atOneEye, false, ENDER_EYE_REQUIRED)
  const wantOne = planNextCraftStep(RECIPES, ENDER_EYE, atOneEye, false, 1)
  assert.equal(wantRequired.op?.item, ENDER_EYE, 'want=12 must keep the terminal craft offered at 1 eye')
  assert.equal(wantRequired.op?.count, 1)
  assert.equal(wantOne.op, null, 'want=1 is the pre-30dec38 bug and must stall at one held copy')
  // Ambiguity is refused, never guessed: the recipe has exactly one variant.
  const effect = craftEffect(ENDER_EYE, 1)
  assert.equal(effect.ok, true)
  assert.deepEqual(effect.consumes, [{ item: ENDER_PEARL, count: 1 }, { item: BLAZE_POWDER, count: 1 }])
  const powderEffect = craftEffect(BLAZE_POWDER, 2)
  assert.equal(powderEffect.ok, true)
  assert.deepEqual(powderEffect.consumes, [{ item: BLAZE_ROD, count: 1 }])
  ok('want=requiredCount keeps CRAFT:ender_eye offered at 1 eye; want=1 stalls (30dec38 guard)')
}

// ---------------------------------------------------------------------------
// 5. ladder rung vs planner vs gate on the same thresholds
// ---------------------------------------------------------------------------
const thresholds = checkThresholdsAndRungs()
{
  assert.deepEqual(thresholds.errors, [])
  assert.equal(thresholds.facts.ladderEnderEyesGoal.kind, 'craft')
  assert.equal(thresholds.facts.ladderEnderEyesGoal.targetItem, ENDER_EYE)
  assert.equal(thresholds.facts.ladderEnderEyesGoal.requiredCount, ENDER_EYE_REQUIRED)
  assert.equal(thresholds.facts.ladderBlazeRodsGoal.requiredCount, BLAZE_ROD_REQUIRED)
  assert.equal(thresholds.facts.rodsExact, 6)
  assert.equal(thresholds.facts.rodSurplus, 1, 'the 7-rod rung is a deliberate 1-rod surplus over the 6 exact')
  assert.equal(thresholds.facts.powderYield, 14)
  assert.equal(thresholds.facts.powderYield >= thresholds.facts.powderNeeded, true)
  ok('ladder rung (planner-ladder.ts) == planner == gate on 12 eyes / 7 rods / 12 powder')
}

// ---------------------------------------------------------------------------
// 6. the REAL tools/m3-gate.mjs subprocess on the synthetic single-run fixture
// ---------------------------------------------------------------------------
const report = runRehearsal()
{
  assert.equal(report.result, 'READY', `rehearsal must be READY: ${report.missing.join(',')}`)
  assert.deepEqual(report.missing, [])

  assert.equal(report.positive.exitCode, 0)
  assert.equal(report.positive.status, 'PASS')
  assert.match(
    report.positive.resultLine,
    /M3_RUN_RESULT status=PASS reason=twelve_eyes_of_ender_verified runId=run-m3-rehearsal ender_eye=PASS authority=PASS/,
  )
  assert.match(report.positive.stdout, /ender_eye_ready: PASS/)
  assert.match(report.positive.stdout, /model_authority: PASS/)
  assert.match(report.positive.stdout, /m3_dimension_transition from=minecraft:overworld to=minecraft:the_nether/)
  assert.match(report.positive.stdout, /m3_predicate nether_reached: PASS .*source=log:DIMENSION_TRANSITION/)
  assert.match(report.positive.stdout, /m3_evidence: valid sources=log/)
  assert.match(report.positive.stdout, /m3_facts: ender_pearl=12 blaze_rod=7 blaze_powder=14 ender_eye=12/)
  ok('real m3-gate.mjs subprocess PASSes the plan-derived single-run endgame')
}

// ---------------------------------------------------------------------------
// 7. negatives, all against the real gate subprocess (never PASS)
// ---------------------------------------------------------------------------
{
  assert.equal(report.eyes11.exitCode, 1)
  assert.equal(report.eyes11.status, 'FAIL')
  assert.equal(report.eyes11.reason, 'ender_eyes_short_with_crafting_materials')
  assert.match(report.eyes11.stdout, /ender_eye_ready: FAIL/)
  assert.doesNotMatch(report.eyes11.stdout, /status=PASS/)
  ok('11 eyes with every crafting input -> FAIL/exit 1, never PASS')

  assert.equal(report.noRunId.exitCode, 2)
  assert.equal(report.noRunId.status, 'UNKNOWN')
  assert.equal(report.noRunId.reason, 'exact_run_scope_required')
  assert.match(report.noRunId.stdout, /status=UNKNOWN reason=exact_run_scope_required runId=none/)
  assert.doesNotMatch(report.noRunId.stdout, /status=PASS/)
  ok('no --run scope -> UNKNOWN/exit 2, never PASS')

  assert.notEqual(report.noEyes.status, 'PASS')
  assert.notEqual(report.noEyes.exitCode, 0)
  assert.ok(report.noEyes.status === 'FAIL' || report.noEyes.status === 'UNKNOWN', report.noEyes.status)
  assert.doesNotMatch(report.noEyes.stdout, /status=PASS/)
  ok(`inputs (ender_pearl/blaze_rod) with no eyes -> ${report.noEyes.status}/exit ${report.noEyes.exitCode}, never PASS`)

  assert.notEqual(report.wrongItemName.status, 'PASS')
  assert.notEqual(report.wrongItemName.exitCode, 0)
  assert.doesNotMatch(report.wrongItemName.stdout, /status=PASS/)
  ok('eye_of_ender (projectile entity, not an item) can never satisfy the M3 predicate')

  assert.notEqual(report.foreign.status, 'PASS')
  assert.equal(report.foreign.exitCode, 2)
  assert.match(report.foreign.resultLine, /status=UNKNOWN reason=run_boundary_missing/)
  ok('a foreign run\'s 12 eyes are never attributable to the requested runId')

  assert.notEqual(report.mixedAsRun.status, 'PASS')
  assert.notEqual(report.mixedAsRun.exitCode, 0)
  assert.doesNotMatch(report.mixedAsRun.stdout, /status=PASS/)
  // The same evidence IS a PASS for its own run, so the negative proves attribution.
  assert.equal(report.mixedAsForeign.status, 'PASS')
  assert.equal(report.mixedAsForeign.exitCode, 0)
  ok('mixed-run evidence cannot be joined into a PASS, but still PASSes for its own runId')

  assert.notEqual(report.noAuthority.status, 'PASS')
  assert.equal(report.noAuthority.exitCode, 2)
  assert.match(report.noAuthority.stdout, /model_authority: UNKNOWN/)
  assert.doesNotMatch(report.noAuthority.stdout, /status=PASS/)
  ok('12 eyes without model authority -> UNKNOWN/exit 2, never PASS')
}

// ---------------------------------------------------------------------------
// 8. mutation: the SAME fixture truncated one eye short is not a PASS
// ---------------------------------------------------------------------------
{
  const truncated = endgame.inventoryTrace.map((sample) => {
    const eyes = sample[ENDER_EYE] ?? 0
    return eyes > ENDER_EYE_REQUIRED - 1 ? { ...sample, [ENDER_EYE]: ENDER_EYE_REQUIRED - 1 } : sample
  })
  const fixture = materializeSyntheticRun({ caseName: 'truncated', runs: [{ runId: 'run-m3-rehearsal', samples: truncated }] })
  let result
  try {
    result = runRealGate({ fixture, expectedRunId: 'run-m3-rehearsal' })
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true })
  }
  assert.equal(result.exitCode, 1)
  assert.equal(result.status, 'FAIL')
  assert.doesNotMatch(result.stdout, /status=PASS/)
  ok('the real trajectory truncated to 11 eyes is FAIL, never PASS (threshold boundary pinned)')
}

// ---------------------------------------------------------------------------
// 9. the source table names both sides of every threshold (auditability)
// ---------------------------------------------------------------------------
{
  for (const [key, value] of Object.entries(M3_CHAIN_SOURCES)) {
    assert.equal(typeof value, 'string')
    assert.match(value, /^(packages\/)?(buddy-driver|jev-agent|tools)\/[\w./-]+:\d+/, `${key} must name file:line`)
  }
  assert.match(M3_CHAIN_SOURCES.gate_eye_threshold, /tools\/milestone-predicates\.mjs:43/)
  assert.match(M3_CHAIN_SOURCES.ladder_ender_eyes, /buddy-driver\/planner-ladder\.ts:652/)
  ok('every threshold source names file:line on the ladder, planner and gate side')
}

console.log(`m3-chain-rehearsal-test ${checks}/${checks} PASS`)
