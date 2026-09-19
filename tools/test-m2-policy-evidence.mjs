#!/usr/bin/env node
// test-m2-policy-evidence: offline fixtures for tools/m2-policy-evidence.mjs.
//
// Pins the run binding of the real-policy requirement: decisions/generation
// evidence from one resident lifetime must never satisfy another, an unbounded
// window is UNKNOWN, and only runId=typesafe + policyModel=typesafe-ai/jev with
// >=1 source=jev decision verifies.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  REQUIRED_POLICY_KIND,
  REQUIRED_POLICY_MODEL,
  countDecisionSources,
  evaluatePolicyEvidence,
  loadPolicyEvidence,
  parseGenerationLine,
  resolveRunWindow,
  scanRunnerOut,
} from './m2-policy-evidence.mjs'

let checks = 0
const ok = (label) => {
  checks += 1
  console.log(`  ok ${checks} - ${label}`)
}
const line = (ts, body) => `[${ts}] ${body}`
const decision = (ts, source) => JSON.stringify({ record: 'decision', ts, source })

const dir = mkdtempSync(join(tmpdir(), 'm2-policy-evidence-'))
const runnerOut = join(dir, 'runner.out')
const decisions = join(dir, 'decisions.jsonl')
const missing = join(dir, 'nope.jsonl')

try {
  writeFileSync(
    runnerOut,
    [
      line('2026-09-18T09:00:00.000Z', 'BOOT pid=1 runId=run-a bundle=a'),
      line('2026-09-18T09:00:01.000Z', 'GENERATION_READY id=g-a policy=fallback model=deterministic-local-fallback+descend-aware'),
      line('2026-09-18T09:00:05.000Z', 'HOST_LOCK released pid=1'),
      line('2026-09-18T09:10:00.000Z', 'BOOT pid=2 runId=run-b bundle=b'),
      line('2026-09-18T09:10:01.000Z', 'GENERATION_READY id=g-b policy=typesafe model=typesafe-ai/jev'),
      line('2026-09-18T09:10:05.000Z', 'HOST_LOCK released pid=2'),
      line('2026-09-18T09:20:00.000Z', 'BOOT pid=3 runId=run-c bundle=c'),
      // Alternate structured spelling must be accepted as well.
      line('2026-09-18T09:20:01.000Z', 'GENERATION_READY id=g-c policyKind=typesafe policyModel=typesafe-ai/jev'),
    ].join('\n') + '\n',
  )
  writeFileSync(
    decisions,
    [
      decision('2026-09-18T09:00:01.000Z', 'fallback'),
      decision('2026-09-18T09:00:03.000Z', 'fallback'),
      decision('2026-09-18T09:10:01.000Z', 'jev'),
      decision('2026-09-18T09:10:03.000Z', 'jev'),
      decision('2026-09-18T09:20:02.000Z', 'jev'),
      // A non-decision record inside a window must not be counted.
      JSON.stringify({ record: 'other', ts: '2026-09-18T09:10:02.000Z', source: 'jev' }),
    ].join('\n') + '\n',
  )

  {
    const parsed = parseGenerationLine('GENERATION_READY id=g policyKind=typesafe policyModel=typesafe-ai/jev')
    assert.deepEqual(parsed, { policyKind: 'typesafe', policyModel: 'typesafe-ai/jev' })
    const fallback = parseGenerationLine('GENERATION_READY id=g policy=fallback model=deterministic-local-fallback')
    assert.deepEqual(fallback, { policyKind: 'fallback', policyModel: 'deterministic-local-fallback' })
    ok('parseGenerationLine accepts both policy=/model= and policyKind=/policyModel= spellings')
  }

  {
    const evidence = await loadPolicyEvidence({ runId: 'run-a', decisionsPath: decisions, runnerOutPath: runnerOut })
    assert.equal(evidence.decisions.runId, 'run-a')
    assert.equal(evidence.decisions.jevCount, 0)
    assert.equal(evidence.decisions.fallbackCount, 2)
    assert.equal(evidence.generation.runId, 'run-a')
    assert.equal(evidence.generation.policyKind, 'fallback')
    const verdict = evaluatePolicyEvidence({ expectedRunId: 'run-a', ...evidence })
    assert.equal(verdict.code, 2)
    assert.equal(verdict.reason, 'decisions_fallback_only')
    ok('run-a (fallback) is UNKNOWN: fallback decisions and fallback generation')
  }

  {
    const evidence = await loadPolicyEvidence({ runId: 'run-b', decisionsPath: decisions, runnerOutPath: runnerOut })
    assert.equal(evidence.decisions.runId, 'run-b')
    assert.equal(evidence.decisions.jevCount, 2)
    assert.equal(evidence.decisions.fallbackCount, 0, 'run-a fallback decisions must not leak into run-b')
    assert.equal(evidence.generation.runId, 'run-b')
    assert.equal(evidence.generation.policyKind, 'typesafe')
    assert.equal(evidence.generation.source, runnerOut)
    const verdict = evaluatePolicyEvidence({ expectedRunId: 'run-b', ...evidence })
    assert.equal(verdict.code, 0)
    assert.equal(verdict.status, 'VERIFIED')
    assert.equal(verdict.reason, 'real_policy_evidence_verified')
    ok('run-b (typesafe, source=jev) is VERIFIED and never borrows run-a evidence')
  }

  {
    const evidence = await loadPolicyEvidence({ runId: 'run-c', decisionsPath: decisions, runnerOutPath: runnerOut })
    assert.equal(evidence.reason, 'run_window_unbounded')
    assert.equal(evidence.decisions, null)
    ok('an unbracketed (not live) run window is refused as UNKNOWN')
  }

  {
    const nowMs = Date.parse('2026-09-18T09:20:03.000Z')
    const evidence = await loadPolicyEvidence({
      runId: 'run-c',
      socket: { runId: 'run-c', policyKind: 'typesafe', policyModel: 'typesafe-ai/jev' },
      decisionsPath: decisions,
      runnerOutPath: runnerOut,
      now: () => nowMs,
    })
    assert.equal(evidence.generation.source, 'socket_report')
    assert.equal(evidence.generation.policyKind, 'typesafe')
    assert.equal(evidence.decisions.jevCount, 1)
    const verdict = evaluatePolicyEvidence({ expectedRunId: 'run-c', ...evidence })
    assert.equal(verdict.code, 0)
    ok('a live run is bracketed by now and its socket generation status verifies')
  }

  {
    const evidence = await loadPolicyEvidence({ runId: 'run-nope', decisionsPath: decisions, runnerOutPath: runnerOut })
    assert.equal(evidence.reason, 'run_boot_boundary_missing')
    assert.equal(evidence.decisions, null)
    assert.equal(evidence.generation, null)
    const verdict = evaluatePolicyEvidence({ expectedRunId: 'run-nope', ...evidence })
    assert.equal(verdict.code, 2)
    assert.equal(verdict.reason, 'decisions_evidence_unavailable')
    ok('an unknown run has no bound evidence -> UNKNOWN')
  }

  {
    const evidence = await loadPolicyEvidence({ runId: 'run-b', decisionsPath: missing, runnerOutPath: runnerOut })
    assert.equal(evidence.decisions, null)
    assert.notEqual(evidence.generation, null)
    const verdict = evaluatePolicyEvidence({ expectedRunId: 'run-b', ...evidence })
    assert.equal(verdict.reason, 'decisions_evidence_unavailable')
    ok('a missing decisions file is UNKNOWN, never a fabricated pass')
  }

  {
    const evidence = await loadPolicyEvidence({ runId: 'run-b', decisionsPath: decisions, runnerOutPath: missing })
    assert.equal(evidence.reason, 'runner_out_unreadable')
    ok('a missing runner.out is UNKNOWN')
  }

  {
    const scanned = await scanRunnerOut(runnerOut)
    assert.equal(scanned.boots.length, 3)
    assert.equal(scanned.releases.length, 2)
    assert.equal(scanned.generations.length, 3)
    const windowB = resolveRunWindow(scanned.boots, scanned.releases, 'run-b')
    assert.equal(windowB.startMs, Date.parse('2026-09-18T09:10:00.000Z'))
    assert.equal(windowB.endMs, Date.parse('2026-09-18T09:10:05.000Z'))
    ok('scanRunnerOut/resolveRunWindow bracket each BOOT with the next release')
  }

  {
    const counts = await countDecisionSources(decisions, Date.parse('2026-09-18T09:10:00.000Z'), Date.parse('2026-09-18T09:10:05.000Z'))
    assert.deepEqual(
      { jev: counts.jevCount, fallback: counts.fallbackCount, other: counts.otherCount },
      { jev: 2, fallback: 0, other: 0 },
    )
    ok('countDecisionSources counts only decision records inside the window')
  }

  // Pure evaluator edges.
  {
    assert.equal(evaluatePolicyEvidence({}).reason, 'exact_run_scope_required')
    assert.equal(
      evaluatePolicyEvidence({ expectedRunId: 'run-x', decisions: { runId: 'run-x', jevCount: 1, fallbackCount: 0 }, generation: null }).reason,
      'generation_status_unavailable',
    )
    assert.equal(
      evaluatePolicyEvidence({
        expectedRunId: 'run-x',
        decisions: { runId: 'run-x', jevCount: 1, fallbackCount: 0 },
        generation: { runId: 'run-x', policyKind: 'typesafe', policyModel: 'other-model' },
      }).reason,
      'policy_model_not_typesafe',
    )
    assert.equal(
      evaluatePolicyEvidence({
        expectedRunId: 'run-x',
        decisions: { runId: 'run-x', jevCount: 0, fallbackCount: 0 },
        generation: { runId: 'run-x', policyKind: 'typesafe', policyModel: 'typesafe-ai/jev' },
      }).reason,
      'no_jev_decisions',
    )
    assert.equal(
      evaluatePolicyEvidence({
        expectedRunId: 'run-x',
        decisions: { runId: 'run-y', jevCount: 5, fallbackCount: 0 },
        generation: { runId: 'run-y', policyKind: 'typesafe', policyModel: 'typesafe-ai/jev' },
      }).reason,
      'decisions_evidence_run_mismatch',
    )
    assert.equal(
      evaluatePolicyEvidence({
        expectedRunId: 'run-x',
        decisions: { runId: 'run-x', jevCount: 5, fallbackCount: 0 },
        generation: { runId: 'run-y', policyKind: 'typesafe', policyModel: 'typesafe-ai/jev' },
      }).reason,
      'generation_run_mismatch',
    )
    assert.equal(REQUIRED_POLICY_KIND, 'typesafe')
    assert.equal(REQUIRED_POLICY_MODEL, 'typesafe-ai/jev')
    ok('pure evaluator refuses missing, mismatched, and non-typesafe evidence')
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(`m2-policy-evidence: ${checks}/${checks} checks passed`)
