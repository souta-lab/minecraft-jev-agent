#!/usr/bin/env bun
// tools/test-skill-closure-metrics.mjs — fixture for the #436 §20 / #437 metrics tool.
//
// WHY THIS EXISTS: `skill-closure-metrics.mjs` is the instrument the #437 before/after
// comparison is read from. If its windowing or its `jevBoundary` parsing regresses, the
// "after" number is silently wrong (a fabricated 0, or a count of the wrong lines) and the
// acceptance argument collapses. This fixture pins the two answers the tool must give:
//
//   * a PRE-#437 window (no epoch markers) -> `UNKNOWN`, never a fabricated 0;
//   * a POST-#437 window -> model calls vs cached replays separated, projection hashes
//     counted, and the boundary/outcome reasons tallied.
//
// It runs the real tool over a synthetic tree, so it is read-only with respect to any
// live run and never touches the control socket.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'skill-closure-metrics-'))

/** A log line in the mirrored/timestamped form the markers regex expects. */
const line = (text) => `[2026-09-22T00:00:00.000Z] ${text}`

function writeTree(logBody) {
  mkdirSync(join(root, 'buddy-driver', 'logs', 'jev'), { recursive: true })
  writeFileSync(join(root, 'buddy-driver', 'buddy.log'), logBody)
  // The tool refuses to run without a decisions file; its contents are not read here.
  writeFileSync(join(root, 'buddy-driver', 'logs', 'jev', 'decisions.jsonl'), '')
}

function run(runId) {
  const result = Bun.spawnSync([process.execPath, 'tools/skill-closure-metrics.mjs', '--run', runId, '--root', root], {
    cwd: join(import.meta.dir, '..'),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = new TextDecoder().decode(result.stdout)
  const stderr = new TextDecoder().decode(result.stderr)
  assert.equal(result.exitCode, 0, `tool exited ${result.exitCode}: ${stdout}\n${stderr}`)
  return JSON.parse(stdout)
}

// One tree holding all three runs, so run scoping is testable: a run's window ends
// at the next BOOT, and no later run's markers may be attributed to it (AGENTS #63).
writeTree(
  [
    // --- run-old: the pre-#437 shape. No epoch markers exist yet, so the boundary
    // plane must read UNKNOWN - the tool must not invent 0 model calls and claim a win.
    line('BOOT pid=1 runId=run-old'),
    line('HEARTBEAT pos=26.4,67.0,10.2'),
    line('ACTION n=1 id=MOVE:p26_67_10 kind=MOVE'),
    line('SKILL_STEP action=step_up cell=26,67,10'),
    line('HEARTBEAT pos=26.6,67.0,10.4'),
    line('ACTION n=2 id=MOVE:p26_67_10 kind=MOVE'),
    line('SKILL_END skill=enter_portal reason=done'),

    // --- run-new: the post-#437 shape. Three decisions over two distinct semantic
    // states, one of them a cached replay that must NOT be charged as a model call,
    // one stale result dropped, and one commitment authorized.
    line('BOOT pid=3 runId=run-new'),
    line('ACTION n=1 id=MOVE:p26_67_10 kind=MOVE'),
    line(
      'JEV_DECISION_EPOCH_START epoch=1 projectionHash=jp1:aaaa1111 candidates=2 dimension=minecraft:overworld worldEpoch=7 reason=first_decision',
    ),
    line('JEV_STATE_PROJECTION hash=jp1:aaaa1111 version=1 schema=jev-semantic-projection/v1 bytes=1300 candidates=2/4 merged=2 rawSkillSteps=0 rawEvents=1 facts=1'),
    line('JEV_CANDIDATE_SET offered=2 identities=[opt=x|skill=MOVE]'),
    line('SKILL_COMMIT epoch=1 commitmentId=c:1:12 lease=12 skill=MOVE candidate=MOVE:p26_67_10 identity=opt=x|skill=MOVE projectionHash=jp1:aaaa1111'),
    line('ACTION n=2 id=ENTER:26,67,9 kind=ENTER_PORTAL'),
    line(
      'JEV_DECISION_EPOCH_START epoch=2 projectionHash=jp1:bbbb2222 candidates=3 dimension=minecraft:overworld worldEpoch=7 reason=semantic_state_changed',
    ),
    line('JEV_STATE_PROJECTION hash=jp1:bbbb2222 version=1 schema=jev-semantic-projection/v1 bytes=1310 candidates=3/6 merged=3 rawSkillSteps=412 rawEvents=812 facts=2'),
    // A cache-hit epoch is a semantic-state replay, NOT a paid model call.
    line(
      'JEV_DECISION_EPOCH_START epoch=3 projectionHash=jp1:bbbb2222 candidates=3 dimension=minecraft:overworld worldEpoch=7 reason=same_semantic_state cacheHit=true reusedFrom=2',
    ),
    line('STALE_JEV_RESULT_DROPPED epoch=1 activeEpoch=2 reason=stale_epoch'),
    line('SKILL_OUTCOME_PACKET epoch=2 commitmentId=c:2:14 terminalReason=target_lost skill=ATTACK progress=none nextDecisionRequired=true'),

    // --- run-after: must never leak into run-new's window.
    line('BOOT pid=4 runId=run-after'),
    line(
      'JEV_DECISION_EPOCH_START epoch=9 projectionHash=jp1:cccc3333 candidates=1 dimension=minecraft:overworld worldEpoch=7 reason=first_decision',
    ),
    line('JEV_STATE_PROJECTION hash=jp1:cccc3333 version=1 schema=jev-semantic-projection/v1 bytes=1200 candidates=1/1 merged=0 rawSkillSteps=0 rawEvents=0 facts=0'),
  ].join('\n') + '\n',
)

// ---------------------------------------------------------------------------
// Case 1: pre-#437 window -> UNKNOWN, and the later runs' markers must not leak in.
// ---------------------------------------------------------------------------
{
  const out = run('run-old')
  assert.equal(out.runId, 'run-old')
  assert.equal(out.skills.step, 1)
  assert.equal(out.skills.end, 1)
  assert.equal(
    out.jevBoundary,
    'UNKNOWN (JEV_DECISION_EPOCH_START not in this window)',
    'a pre-#437 window must report UNKNOWN, never a fabricated 0',
  )
  assert.equal(out.projectionStability.distinct, 'UNKNOWN')
  assert.equal(out.epoch.starts, 0, 'a later run\'s epochs must not leak into this window')
  // The MUST-be-zero counter stays UNKNOWN while no lane emits its marker.
  assert.equal(out.effectEnvelopeViolations, 'UNKNOWN')
}

// ---------------------------------------------------------------------------
// Case 2: post-#437 window -> calls vs replays separated, hashes counted.
// ---------------------------------------------------------------------------
{
  const out = run('run-new')
  assert.notEqual(typeof out.jevBoundary, 'string', 'the boundary plane must be a report once the markers exist')
  assert.equal(out.jevBoundary.epochStarts, 3)
  assert.equal(out.jevBoundary.modelCalls, 2, 'the cacheHit=true epoch must not be charged as a model call')
  assert.equal(out.jevBoundary.reusedDecisions, 1)
  assert.equal(out.jevBoundary.distinctProjectionHashes, 2, 'only the two distinct hashes count')
  assert.deepEqual(out.jevBoundary.requeryReasons, { first_decision: 1, semantic_state_changed: 1, same_semantic_state: 1 })
  assert.deepEqual(out.jevBoundary.outcomeReasons, { target_lost: 1 })
  assert.equal(out.jevBoundary.staleResultsDropped, 1)
  assert.equal(out.jevBoundary.actionsPerModelCall, 1)
  assert.equal(out.jevBoundary.modelCallsPerDistinctProjection, 1)
  // The epoch plane and the Skill plane are separate views of the same window.
  assert.deepEqual(out.epoch, {
    starts: 3,
    ends: 0,
    projections: 2,
    candidateSets: 1,
    outcomePackets: 1,
    staleResultsDropped: 1,
  })
  assert.equal(out.skills.commit, 1, 'SKILL_COMMIT is now live, so the envelope counter stops being UNKNOWN')
  assert.equal(out.effectEnvelopeViolations, 0)
  // Projection stability: two states, one of them observed twice.
  assert.equal(out.projectionStability.observations, 2)
  assert.equal(out.projectionStability.distinct, 2)
  assert.equal(out.projectionStability.dominantShare, 0.5)
}

// ---------------------------------------------------------------------------
// Case 3: run scoping. run-new's window ends at run-after's BOOT, so run-after's
// epoch/projection markers can never be attributed to run-new.
// ---------------------------------------------------------------------------
{
  const out = run('run-new')
  assert.equal(out.epoch.starts, 3, 'run-after\'s epoch must not leak into run-new\'s window')
  assert.equal(out.epoch.projections, 2, 'run-after\'s projection must not leak into run-new\'s window')
  assert.equal(out.jevBoundary.distinctProjectionHashes, 2)
}

rmSync(root, { recursive: true, force: true })
process.stdout.write('skill-closure-metrics tests: 3/3\n')
